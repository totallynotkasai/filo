/**
 * Backwards-compatibility shim — `markdownWriteRegistry` was the per-owner
 * flush + force-write registry; the canonical write path now lives in
 * `src/renderer/lib/vault/markdownFileWriter.ts`. The gateway owns:
 *  - per-caller debounced markdown writes (TextTile / DocumentEditor /
 *    PropertiesPopup go through scheduleMarkdownWrite/flushMarkdownWrite),
 *  - the per-file BOM-preserving hydrate gate (markHydrated / isHydrated),
 *  - the unified drain step that also pulls in the frontmatter scheduler.
 *
 * This file re-exports the deprecated public symbols so existing tests in
 * `src/tests/unit/*` and any not-yet-migrated production call site keep
 * compiling. New code MUST use the gateway directly.
 *
 * The `registerMarkdownFlusher` / `unregisterMarkdownFlusher` pair is
 * retained as a thin layer over a local Map so test fixtures (which exercise
 * the legacy contract) continue to pass. `flushAllMarkdownWriters` drains
 * BOTH the shim's registered flushers AND the gateway's pending writes so
 * neither path is invisible.
 */

import {
  flushAllMarkdownWrites,
  forceWriteForDocument as gatewayForceWriteForDocument,
  __resetMarkdownFileWriterForTests,
  type FlushAllResult as GatewayFlushAllResult,
  type ForceWriteResult,
} from '../vault/markdownFileWriter';
import { flushAllPendingFrontmatterWrites } from './frontmatterWriteScheduler';

export type { ForceWriteResult } from '../vault/markdownFileWriter';

/**
 * Shim flush result — structurally identical to the gateway's `FlushAllResult`
 * (imported above as `GatewayFlushAllResult`, re-exported below), so it's
 * aliased rather than re-declared to keep one source of truth. `failed` is
 * `{ ownerId, error }[]`; the gateway tracks failures by `callerId` string and
 * `flushAllMarkdownWriters` maps those onto `ownerId`. The genuinely-different
 * per-scheduler variant (`{ failed: string[]; vaultRoot }`) lives in
 * `writeScheduler.ts` and is intentionally NOT unified with this one.
 */
export type FlushAllResult = GatewayFlushAllResult;

type Flusher = () => Promise<void>;

export interface RegisterFlusherOptions {
  forceWrite?: Flusher;
  getDocId?: () => string | null | undefined;
}

interface ShimEntry {
  flush: Flusher;
  forceWrite?: Flusher;
  getDocId?: () => string | null | undefined;
}

const shimFlushers = new Map<string, ShimEntry>();

/**
 * Deprecated — register a per-owner flush callback. New code MUST use the
 * gateway's `scheduleMarkdownWrite` + `registerForceWriter` pair instead.
 * Retained as a back-compat shim for tests and not-yet-migrated producers.
 */
export function registerMarkdownFlusher(
  ownerId: string,
  flush: Flusher,
  options: RegisterFlusherOptions = {},
): void {
  shimFlushers.set(ownerId, {
    flush,
    forceWrite: options.forceWrite,
    getDocId: options.getDocId,
  });
}

export function unregisterMarkdownFlusher(ownerId: string): void {
  shimFlushers.delete(ownerId);
}

/**
 * Drains every shim flusher AND every gateway pending write. The two
 * pipelines are independent, so a global Ctrl+S has to touch both.
 *
 * Returns `{ ok, failed }` matching the original registry's shape so
 * existing consumers (vaultStore.save, tabsStore.close, etc.) keep
 * working unchanged.
 */
export async function flushAllMarkdownWriters(): Promise<FlushAllResult> {
  const snapshot = Array.from(shimFlushers.entries());
  // Three drains run in parallel:
  //  1. Shim flushers (legacy register/unregister consumers, e.g. tests).
  //  2. Gateway pending writes (TextTile / DocumentEditor / PropertiesPopup).
  //  3. Frontmatter scheduler pending writes (kanban field updates etc.).
  // The KanbanBoard / TaskListBoard registrations previously routed (3) via
  // (1); the gateway migration drops those registrations, so (3) is drained
  // here directly to preserve the legacy "single call drains everything"
  // contract that the renderer's save / tab-close / vault-folder-ops sites
  // depend on.
  const [shimSettled, gatewayResult, schedulerResult] = await Promise.all([
    Promise.allSettled(snapshot.map(([, entry]) => entry.flush())),
    flushAllMarkdownWrites(),
    flushAllPendingFrontmatterWrites(),
  ]);

  const failed: FlushAllResult['failed'] = [];
  let ok = 0;
  for (let i = 0; i < shimSettled.length; i++) {
    const result = shimSettled[i];
    const [ownerId] = snapshot[i];
    if (result.status === 'fulfilled') ok++;
    else failed.push({ ownerId, error: result.reason });
  }
  for (const callerId of gatewayResult.failed) {
    failed.push({
      ownerId: callerId,
      error: new Error(`Gateway flush rejected for ${callerId}`),
    });
  }
  for (const relPath of schedulerResult.failed) {
    failed.push({
      ownerId: `frontmatter-scheduler:${relPath}`,
      error: new Error(`Scheduler flush rejected for ${relPath}`),
    });
  }
  return { ok, failed };
}

/**
 * Forces every writer matching `docId` to commit its current in-memory body
 * to disk. Routes through both the shim's matching flushers and the
 * gateway's force-write pipeline.
 */
export async function forceWriteForDocument(docId: string): Promise<ForceWriteResult> {
  if (!docId) return { ok: 0, failed: [] };
  const matches: Array<[string, ShimEntry]> = [];
  for (const [ownerId, entry] of shimFlushers.entries()) {
    if (entry.getDocId?.() === docId) matches.push([ownerId, entry]);
  }

  const [shimSettled, gatewayResult] = await Promise.all([
    Promise.allSettled(matches.map(([, entry]) => (entry.forceWrite ?? entry.flush)())),
    gatewayForceWriteForDocument(docId),
  ]);

  const failed: ForceWriteResult['failed'] = [];
  let ok = 0;
  for (let i = 0; i < shimSettled.length; i++) {
    const result = shimSettled[i];
    const [ownerId] = matches[i];
    if (result.status === 'fulfilled') ok++;
    else failed.push({ ownerId, error: result.reason });
  }
  ok += gatewayResult.ok;
  for (const entry of gatewayResult.failed) failed.push(entry);
  return { ok, failed };
}

/**
 * Test-only — drops every registered shim flusher AND clears the gateway's
 * internal state so tests don't bleed between cases.
 */
export function __resetMarkdownFlushersForTests(): void {
  shimFlushers.clear();
  __resetMarkdownFileWriterForTests();
}

// Re-exports preserved for callers that imported from this module.
void gatewayForceWriteForDocument;
export type { GatewayFlushAllResult };

/**
 * externalChangeRegistry — single, exhaustive dispatcher for `vault:files-changed` events. Each
 * `FileChangeType` arm has a dedicated reconciler that owns the renderer-
 * side response (apply disk metadata to caches, surface a "modified
 * externally" toast, refresh a config store, etc.). Adding a new
 * `FileChangeType` to `fileWatcherTypes.ts` becomes a compile error here:
 * the `Record<FileChangeType, ExternalChangeReconciler>` constant won't
 * type-check until the new arm has a reconciler, so no kind (`.board.json`,
 * `.filo/tags.json`, themes, templates…) can be silently dropped.
 *
 * The registry is intentionally lightweight: the reconcilers themselves
 * live alongside the stores they need to coordinate (boardCache, theme,
 * templates, fileTags). The dispatcher just looks up the right one,
 * fires it, and surfaces errors through `reportError` so a misbehaving
 * reconciler can't poison the rest of a batch.
 */

import type { FileChangeType } from '../../../main/services/fileWatcherTypes';
import { reportError } from '../utils/errorBus';

export interface ExternalChangeEvent {
  /** The watcher classification — drives dispatch. */
  kind: FileChangeType;
  /** Vault-relative path of the changed file. */
  filename: string;
  /** Underlying `fs.watch` `eventType` — typically `'rename'` or `'change'`. */
  eventType: string;
}

export interface ExternalChangeReconciler {
  /**
   * Identifies the reconciler in logs and the matrix tests that assert
   * every `FileChangeType` arm is covered. Should match the union
   * literal it handles.
   */
  readonly kind: FileChangeType;
  /**
   * Per-event handler. Errors should be surfaced inside the reconciler
   * (via `reportError` or a user-visible toast) — the dispatcher catches
   * throws as a last-ditch safety net but cannot attribute them to a
   * specific store.
   */
  handle(event: ExternalChangeEvent): Promise<void> | void;
}

const PLACEHOLDER_MARKER = Symbol('externalChangeRegistry.placeholder');

interface PlaceholderReconciler extends ExternalChangeReconciler {
  readonly __placeholder: typeof PLACEHOLDER_MARKER;
}

function makePlaceholder(kind: FileChangeType): PlaceholderReconciler {
  return {
    kind,
    __placeholder: PLACEHOLDER_MARKER,
    handle: (event) => {
      // Untriggered placeholder — the store-owned reconciler hasn't
      // registered yet. In production this branch is only reachable if
      // module-load order put the dispatcher before the reconciler's
      // registration. Surface to `reportError` so the gap is visible
      // rather than silent.
      reportError(
        'externalChangeRegistry',
        new Error(`No reconciler registered for kind "${kind}" (event: ${event.filename})`),
        `External-edit reconciler missing for "${kind}" — file "${event.filename}" will not be re-synced.`,
      );
    },
  };
}

/**
 * The reconciler registry. Updated at module-load time by each store via
 * `registerReconciler`. The constant entries below cover the kinds whose
 * reconcilers are pure no-ops or live entirely inside this module; the
 * store-owned reconcilers register themselves and override the placeholder.
 *
 * Storing in a `Record` (vs. a Map) gives us exhaustiveness — TypeScript
 * fails the build if any `FileChangeType` arm is missing, so a new watcher
 * kind without a reconciler can't ship.
 */
const reconcilers: Record<FileChangeType, ExternalChangeReconciler> = {
  // The `tree` kind doesn't flow through `vault:files-changed` today
  // (it's a dedicated `vault:tree-updated` push). The placeholder keeps
  // the registry exhaustive should a future watcher emit it through the
  // generic channel; the no-op reflects that the tree refresh runs in
  // the dedicated handler.
  tree: { kind: 'tree', handle: () => {} },
  // Generic `.filo/` config files (anything without a granular subtype)
  // have no per-kind reconciler. We log the event at debug level so a
  // mystery `.filo/foo.json` external edit isn't completely invisible,
  // but skip any state mutation — the typical case is files Filo writes
  // itself but doesn't react to (e.g. `appearance.json`, `workspace.json`,
  // which are only re-read on next vault open).
  config: {
    kind: 'config',
    handle: () => {
      // No-op. See block comment above for rationale.
    },
  },
  // The remaining entries below are placeholder no-ops until the store-
  // owned reconcilers register themselves at module-load time. A future
  // sweep that adds a new watcher kind without a reconciler still
  // type-checks (because the record stays exhaustive) and surfaces a
  // `reportError` at dispatch time so the gap is visible.
  document: makePlaceholder('document'),
  attachment: makePlaceholder('attachment'),
  board: makePlaceholder('board'),
  'config-tags': makePlaceholder('config-tags'),
  'config-theme': makePlaceholder('config-theme'),
  'config-template': makePlaceholder('config-template'),
};

/**
 * Replaces the reconciler for a specific `FileChangeType`. Stores call
 * this at module-load time so the renderer dispatch table is fully
 * populated before the first `vault:files-changed` event fires.
 *
 * Calling twice for the same kind overwrites — last writer wins. This is
 * deliberate: a future refactor that moves a reconciler into a new home
 * doesn't need to thread a removal through the prior registration site.
 */
export function registerReconciler(reconciler: ExternalChangeReconciler): void {
  reconcilers[reconciler.kind] = reconciler;
}

/**
 * Dispatches a watcher event to its kind's reconciler. Catches throws so
 * a misbehaving reconciler can't break sibling reconcilers in the same
 * batch. The dispatcher itself never throws — callers can safely
 * `void dispatchExternalChange(event)` from a listener's hot path.
 */
export async function dispatchExternalChange(event: ExternalChangeEvent): Promise<void> {
  const reconciler = reconcilers[event.kind];
  if (!reconciler) {
    // Exhaustiveness should make this unreachable at the type level. The
    // runtime guard is defence-in-depth — TypeScript can be coerced past
    // the check via `as FileChangeType`, and a forced-coerce caller still
    // surfaces here instead of silently no-opping.
    reportError(
      'externalChangeRegistry',
      new Error(`Unknown external-change kind: ${(event as { kind: string }).kind}`),
    );
    return;
  }
  try {
    await reconciler.handle(event);
  } catch (err) {
    reportError(
      'externalChangeRegistry',
      err,
      `Reconciler for "${event.kind}" threw while processing "${event.filename}"`,
    );
  }
}

/**
 * Batches a flat `vault:files-changed` payload into per-kind groups and
 * dispatches each group through its reconciler. Preserves arrival order
 * inside each group so a tag-rewrite sweep echoing the same path twice
 * routes through the same baseline-restoration logic.
 *
 * Used by the renderer's listener so multi-file batches (the watcher's
 * 300ms debounce naturally groups events) stay coherent: one reconciler
 * call per kind per batch, not one per file. Batch-shaped reconcilers
 * (`document` / `attachment`) are passed an array on each invocation.
 */
export interface BatchedReconciler {
  readonly kind: FileChangeType;
  handleBatch(events: ExternalChangeEvent[]): Promise<void> | void;
}

const batchedReconcilers: Partial<Record<FileChangeType, BatchedReconciler>> = {};

/**
 * Registers a batched reconciler. Takes precedence over the single-event
 * reconciler for the same kind in `dispatchExternalChangeBatch`. Used by
 * the document / attachment reconcilers, which are batch-shaped
 * (`handleExternalMarkdownChanges` takes a `string[]`).
 */
export function registerBatchedReconciler(reconciler: BatchedReconciler): void {
  batchedReconcilers[reconciler.kind] = reconciler;
}

export async function dispatchExternalChangeBatch(
  events: ExternalChangeEvent[],
): Promise<void> {
  if (events.length === 0) return;
  const byKind = new Map<FileChangeType, ExternalChangeEvent[]>();
  for (const ev of events) {
    let bucket = byKind.get(ev.kind);
    if (!bucket) {
      bucket = [];
      byKind.set(ev.kind, bucket);
    }
    bucket.push(ev);
  }
  for (const [kind, bucket] of byKind) {
    const batched = batchedReconcilers[kind];
    if (batched) {
      try {
        await batched.handleBatch(bucket);
      } catch (err) {
        reportError(
          'externalChangeRegistry',
          err,
          `Batched reconciler for "${kind}" threw on a batch of ${bucket.length} event(s)`,
        );
      }
      continue;
    }
    // Fall back to per-event dispatch.
    for (const ev of bucket) {
      await dispatchExternalChange(ev);
    }
  }
}

/**
 * Test-only — clears every registered reconciler back to the placeholder.
 * Vitest's per-test module reset already creates fresh module bindings,
 * but tests that import this registry directly and want a clean slate
 * for assertion symmetry can call this to be explicit.
 */
export function _resetRegistryForTests(): void {
  for (const kind of Object.keys(reconcilers) as FileChangeType[]) {
    if (kind === 'tree' || kind === 'config') continue;
    reconcilers[kind] = makePlaceholder(kind);
  }
  for (const kind of Object.keys(batchedReconcilers) as FileChangeType[]) {
    delete batchedReconcilers[kind];
  }
}

/**
 * Test-only — returns the current reconciler kinds registered with
 * non-placeholder handlers. Used by the characterisation test in
 * `externalEditReconciliation.test.ts` to assert every kind is registered.
 */
export function _registeredKindsForTests(): FileChangeType[] {
  const out: FileChangeType[] = [];
  for (const [kind, rec] of Object.entries(reconcilers) as [
    FileChangeType,
    ExternalChangeReconciler,
  ][]) {
    if (isPlaceholder(rec)) continue;
    out.push(kind);
  }
  for (const kind of Object.keys(batchedReconcilers) as FileChangeType[]) {
    if (!out.includes(kind)) out.push(kind);
  }
  return out.sort();
}

function isPlaceholder(rec: ExternalChangeReconciler): rec is PlaceholderReconciler {
  return (rec as PlaceholderReconciler).__placeholder === PLACEHOLDER_MARKER;
}

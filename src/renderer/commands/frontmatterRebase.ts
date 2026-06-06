import { documentStore } from '../stores/document.svelte';
import { uiStore } from '../stores/ui.svelte';
import { boardCacheStore } from '../stores/boardCache.svelte';
import { scheduleFrontmatterWrite } from '../lib/boards/frontmatterWriteScheduler';
import { patchToFrontmatterDelta } from '../lib/vault/frontmatterDelta';

/**
 * Audit2 4.2 — apply a frontmatter-field patch on undo/redo, rebased onto the
 * live (disk-synced) frontmatter instead of blindly clobbering it.
 *
 * `UpdateTaskFieldCommand` / `UpdateCardFieldCommand` snapshot a before/after
 * patch at construction and replay it on each leg via `mergeFrontmatter`, which
 * spreads the patch over the live cache. Edits to OTHER frontmatter fields
 * already survive that spread; the gap this closes is the SAME field: after an
 * external edit changed the very field the command toggles, a blind undo/redo
 * silently overwrote the external value (`history.notePossiblyStale` only warns
 * — it never disarms the stack).
 *
 * We now detect the per-field conflict, KEEP the external value (the safe
 * default — no silent data loss), apply only the non-conflicting fields, and
 * surface a prompt offering "Apply anyway" so the user can still force the
 * undo/redo when that was the intent. With no awaitable confirm primitive in
 * the toast layer, the safe-default-plus-override toast is the non-blocking
 * realisation of "prompt instead of clobber".
 */

/** True while no editor seeded the cache — we then have no baseline to rebase on. */
function isEmptyish(v: unknown): boolean {
  return v === '' || v === null || v === undefined;
}

/**
 * Order-independent structural deep-equality for frontmatter values. Used ONLY to
 * decide whether an external edit changed a field out from under an undo/redo —
 * NOT a byte-level "did the source change" test (that is `valuesEqual` in
 * frontmatterEngine, which is intentionally order-SENSITIVE because reordered
 * bytes must be rewritten).
 *
 * L8 (Audit-7) — the old comparison was `JSON.stringify(a) === JSON.stringify(b)`,
 * which is order-sensitive. An external tool that merely REORDERED an object's
 * keys or an array's items (e.g. an alphabetiser) then read as a conflict, so the
 * rebase kept the external value and silently skipped the user's undo for that
 * field. This compares order-independently on both sides:
 *   • objects — same key set, values recursively equal (YAML/JSON object key order
 *     is never semantically meaningful);
 *   • arrays  — same MULTISET of items (DECISION: a pure reorder of a PKM list
 *     field like tags/aliases is not a conflict; duplicates still matter, so the
 *     lengths must match and each item is matched at most once). A genuinely
 *     ordered list that an external edit re-orders is the rare counter-case, and
 *     even then only its ordering — never an element — is lost on the undo.
 * The `depth` cap fails to `false` (the SAFE direction: treat as a conflict, keep
 * the external value) on pathological self-referential input.
 */
function fmDeepEqual(a: unknown, b: unknown, depth = 0): boolean {
  if (a === b) return true;
  if (depth > 50) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    const remaining = [...b];
    for (const item of a) {
      const idx = remaining.findIndex((candidate) => fmDeepEqual(item, candidate, depth + 1));
      if (idx === -1) return false;
      remaining.splice(idx, 1);
    }
    return true;
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const aKeys = Object.keys(ao);
    if (aKeys.length !== Object.keys(bo).length) return false;
    for (const key of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(bo, key)) return false;
      if (!fmDeepEqual(ao[key], bo[key], depth + 1)) return false;
    }
    return true;
  }
  return false;
}

/**
 * Canonical equality for frontmatter values, matching `mergeFrontmatter`'s
 * cleaning rule (absent === '' === null === undefined) and comparing
 * arrays/objects structurally — and order-independently (L8) — so a re-emitted or
 * externally-reordered `tags: [...]` doesn't read as a spurious conflict.
 *
 * 6.2.H8 — exported so the docId-less orphan-FM rebase variant
 * (`kanbanCommands.applyOrphanPatchRebased`) shares this exact equality
 * predicate. Without that, the open-editor and orphan paths could disagree
 * about whether two values represent the same frontmatter state.
 */
export function fmValueEqual(a: unknown, b: unknown): boolean {
  if (isEmptyish(a) && isEmptyish(b)) return true;
  if (isEmptyish(a) || isEmptyish(b)) return false;
  if (a === b) return true;
  if (typeof a === 'object' || typeof b === 'object') {
    return fmDeepEqual(a, b);
  }
  return false;
}

/**
 * Audit-7 H1 — recompute a patch's inverse from the CURRENT live frontmatter
 * cache. The Kanban/Task field writers compute a best-effort inverse at
 * construction time, but `UpdateCardFieldCommand`/`UpdateTaskFieldCommand` now
 * seed the cache from a FRESH disk read inside their own `execute()` (so the
 * read joins the history chain `vaultStore.save()`/quit awaits). Re-capturing
 * the inverse here — after that seed, before the merge — makes undo restore the
 * TRUE prior value of each patched key, including a value an external editor
 * changed since the last vault-index rebuild (the writer's pre-seed inverse
 * would otherwise be stale/empty). Mirrors the writers' `k in before ? … : ''`
 * rule so an absent key restores to absent under mergeFrontmatter's
 * empty-deletes cleaning. The caller wraps the result in `this.snapshot(...)`
 * so a later cache mutation can't alias the retained undo snapshot.
 */
export function captureInverseFromCache(
  docId: string,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const before = (documentStore.getFrontmatter(docId) ?? {}) as Record<string, unknown>;
  const inverse: Record<string, unknown> = {};
  for (const key of Object.keys(patch)) {
    inverse[key] = key in before ? before[key] : '';
  }
  return inverse;
}

export interface RebaseFrontmatterArgs {
  docId: string;
  relPath: string;
  /**
   * Phase 6.1.R3 — renamed from `boardId` to `targetBoardId` so callers
   * pass the command's `this.targetBoardId` verbatim. The helper is the
   * sanctioned chokepoint for "dirty the originating board after a
   * rebased frontmatter merge"; the inline escape on the `markDirty`
   * line below tells `check-command-targets-self.mjs` that this
   * laundered-through-parameter call is intentional, and the gate
   * verifies every caller passes `this.targetBoardId`.
   */
  targetBoardId: string;
  /** The patch applied this leg — the forward patch on execute/redo, the inverse on undo. */
  applying: Record<string, unknown>;
  /**
   * What each touched field should currently hold if no external edit occurred —
   * i.e. the value this command wrote on the opposite leg. For undo pass the
   * forward `patch`; for execute/redo pass the `inversePatch`.
   */
  expectedCurrent: Record<string, unknown>;
  /** Label for the conflict toast (the backing file path). */
  label: string;
}

/**
 * Merge `applying` into the doc's frontmatter, but skip (and prompt about) any
 * field an external edit changed out from under the command. Also schedules the
 * debounced write and marks the board dirty for whatever it actually applied —
 * matching the post-merge bookkeeping the callers used to do inline.
 */
export function applyFrontmatterPatchRebased(args: RebaseFrontmatterArgs): void {
  const { docId, relPath, targetBoardId, applying, expectedCurrent, label } = args;

  const commit = (patch: Record<string, unknown>): void => {
    // Phase 4 — mergeFrontmatter keeps the DISPLAY cache live (Kanban cards /
    // Task rows render from it); the write SOURCE is now the explicit delta,
    // applied to fresh disk in the gateway so an untouched external key can't be
    // dropped. The two are decoupled — the cache is never the write source.
    documentStore.mergeFrontmatter(docId, patch);
    scheduleFrontmatterWrite(relPath, docId, patchToFrontmatterDelta(patch));
    // allow-non-target-markdirty: shared helper, callers pass this.targetBoardId per the CI gate
    boardCacheStore.markDirty(targetBoardId);
  };

  const current = documentStore.getFrontmatter(docId);
  if (current === undefined) {
    // No editor seeded the cache — no baseline to compare against, so we can't
    // tell an external edit from a fresh field. Preserve the prior blind merge.
    commit(applying);
    return;
  }

  const conflicts = Object.keys(applying).filter(
    (key) => !fmValueEqual(current[key], expectedCurrent[key]),
  );

  if (conflicts.length === 0) {
    commit(applying);
    return;
  }

  // Keep the external value(s); apply only the fields nothing external touched.
  const safe: Record<string, unknown> = {};
  for (const key of Object.keys(applying)) {
    if (!conflicts.includes(key)) safe[key] = applying[key];
  }
  if (Object.keys(safe).length > 0) commit(safe);

  uiStore.pushToast({
    text: `External edit changed ${conflicts.join(', ')} in ${label}. Kept the external value — that field's undo/redo was skipped.`,
    type: 'warning',
    duration: 0,
    actions: [
      {
        label: 'Apply anyway',
        handler: () => {
          // The user insists — replay the patch over the conflicting fields too.
          const forced: Record<string, unknown> = {};
          for (const key of conflicts) forced[key] = applying[key];
          commit(forced);
        },
      },
    ],
  });
}

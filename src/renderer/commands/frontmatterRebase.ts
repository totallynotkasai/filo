import { documentStore } from '../stores/document.svelte';
import { uiStore } from '../stores/ui.svelte';
import { boardCacheStore } from '../stores/boardCache.svelte';
import { scheduleFrontmatterWrite } from '../lib/boards/frontmatterWriteScheduler';

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
 * Canonical equality for frontmatter values, matching `mergeFrontmatter`'s
 * cleaning rule (absent === '' === null === undefined) and comparing
 * arrays/objects structurally so a re-emitted `tags: [...]` doesn't read as a
 * spurious conflict.
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
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
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
    documentStore.mergeFrontmatter(docId, patch);
    scheduleFrontmatterWrite(relPath, docId);
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

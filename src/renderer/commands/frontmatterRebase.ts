import { uiStore } from '../stores/ui.svelte';
import { boardCacheStore } from '../stores/boardCache.svelte';
import { noteStore } from '../stores/notes.svelte';
import { patchToFrontmatterDelta } from '../lib/vault/frontmatterDelta';
import { captureVaultIdentity, isStillSameVault } from '../lib/vault/vaultIdentity';

/**
 * Apply a frontmatter-field patch on undo/redo, rebased onto the live
 * (disk-synced) frontmatter instead of blindly clobbering it.
 *
 * Edits to OTHER fields survive a plain `mergeFrontmatter` spread; the hazard
 * is the SAME field changed externally since the command ran. On such a
 * conflict we KEEP the external value (no silent data loss), apply only the
 * non-conflicting fields, and offer an "Apply anyway" toast so the user can
 * still force the undo/redo.
 */

/** Empty-equivalent under mergeFrontmatter's cleaning rule (absent === '' === null === undefined). */
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
 * An external tool that merely REORDERS keys or items (e.g. an alphabetiser)
 * must not read as a conflict and skip the user's undo:
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
 * arrays/objects structurally — and order-independently — so a re-emitted or
 * externally-reordered `tags: [...]` doesn't read as a spurious conflict.
 *
 * Exported so the orphan-FM rebase (`kanbanCommands.applyOrphanPatchRebased`)
 * shares this exact predicate with the open-editor path.
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
 * The inverse of `patch` against `before` (the note's frontmatter just before
 * the patch applies): each patched key's prior value, with an absent key as
 * '' so undo removes it. The field commands compute it on first execute from
 * the note as it stands, so undo restores the true prior value even when the
 * caller's construction-time inverse came from a stale index. The caller wraps
 * the result in `this.snapshot(...)`.
 */
export function inverseOfPatch(
  before: Readonly<Record<string, unknown>>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const inverse: Record<string, unknown> = {};
  for (const key of Object.keys(patch)) {
    inverse[key] = key in before ? before[key] : '';
  }
  return inverse;
}

export interface RebaseFrontmatterArgs {
  relPath: string;
  /**
   * Callers pass the command's `this.targetBoardId` verbatim (the
   * `scripts/gates:command-targets-self` gate verifies it); the helper dirties
   * that originating board after the merge.
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
  /**
   * Treat `applying` as a semantically-ATOMIC unit on a conflict. A
   * recurrence roll-forward writes `{ completed: false, dueDate: next }`
   * together; the default per-key rebase could apply one key and keep the other
   * external, producing a `completed: true` + advanced-`dueDate` state the
   * roll-forward invariant must never create. When true, ANY conflict skips the
   * WHOLE patch (applies nothing) and offers an all-or-nothing "Apply anyway".
   * Omitted/false ⇒ the per-key safe-merge below (correct for independent
   * multi-field edits like a Properties popup).
   */
  atomic?: boolean;
}

/**
 * Apply `applying` to the note's frontmatter, but skip (and prompt about) any
 * field an external edit changed out from under the command. The change goes
 * to the note writer as a delta and the board is marked dirty for whatever was
 * actually applied.
 *
 * The compare base is the note as it stands (its model, or a fresh read of the
 * file), never a cache that could lag the disk. Async since that read.
 */
export async function applyFrontmatterPatchRebased(args: RebaseFrontmatterArgs): Promise<void> {
  const { relPath, targetBoardId, applying, expectedCurrent, label, atomic } = args;

  // Captured ONCE and consulted by the "Apply anyway" toast handlers: a click
  // after a vault swap must not queue this patch onto the NEW vault's
  // same-named file (the writer resolves its vault root live). Also guards
  // the read below.
  const identity = captureVaultIdentity();

  const commit = (patch: Record<string, unknown>): void => {
    // A delta, applied by the writer to a fresh read, so an untouched external
    // key can't be dropped.
    noteStore.patchFrontmatter(relPath, patchToFrontmatterDelta(patch));
    // allow-non-target-markdirty: shared helper, callers pass this.targetBoardId per the CI gate
    boardCacheStore.markDirty(targetBoardId);
  };

  const current = await noteStore.currentFrontmatter(relPath);
  if (!isStillSameVault(identity)) return;
  if (current === null) {
    // Nothing readable (file gone or unreadable): no baseline to detect a
    // conflict against, and nothing visible to lose. The writer reports a
    // write it can't land.
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

  if (atomic) {
    // The patch is a coupled pair (recurrence roll-forward). Don't split
    // it: a partial apply could leave `completed: true` with an advanced
    // `dueDate`. Apply NOTHING and offer to force the whole patch.
    uiStore.pushToast({
      text: `External edit changed ${conflicts.join(', ')} in ${label}. Skipped this undo/redo to keep the recurring task consistent.`,
      type: 'warning',
      duration: 0,
      actions: [
        {
          label: 'Apply anyway',
          handler: () => {
            // The toast can be clicked after a vault swap; bail so
            // the outgoing vault's patch never lands on the new vault's file.
            if (!isStillSameVault(identity)) return;
            commit(applying);
          },
        },
      ],
    });
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
          // See the atomic handler above: bail after a vault swap.
          if (!isStillSameVault(identity)) return;
          // The user insists — replay the patch over the conflicting fields too.
          const forced: Record<string, unknown> = {};
          for (const key of conflicts) forced[key] = applying[key];
          commit(forced);
        },
      },
    ],
  });
}

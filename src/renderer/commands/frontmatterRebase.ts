import { documentStore } from '../stores/document.svelte';
import { uiStore } from '../stores/ui.svelte';
import { boardCacheStore } from '../stores/boardCache.svelte';
import { vaultStore } from '../stores/vault.svelte';
import { vaultIndexStore } from '../stores/vaultIndex.svelte';
import { scheduleFrontmatterWrite } from '../lib/boards/frontmatterWriteScheduler';
import { patchToFrontmatterDelta } from '../lib/vault/frontmatterDelta';
import { readMarkdownForHydrate } from '../lib/vault/markdownFileWriter';
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
 * Recompute a patch's inverse from the CURRENT live frontmatter cache. The
 * field commands call this after seeding the cache from a fresh disk read in
 * `execute()`, so undo restores the TRUE prior value of each patched key (the
 * construction-time inverse came from a possibly-stale index). An absent key
 * maps to '' so it restores to absent under mergeFrontmatter's cleaning. The
 * caller wraps the result in `this.snapshot(...)` to avoid aliasing the cache.
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
 * Merge `applying` into the doc's frontmatter, but skip (and prompt about) any
 * field an external edit changed out from under the command. Also schedules the
 * debounced write and marks the board dirty for whatever it actually applied.
 *
 * When no FM cache is seeded for `docId` (never-opened doc, or the seed was
 * dropped after an external FM edit), the compare base is a FRESH disk read
 * (index fallback), never a blind commit. Async since that read; callers await.
 */
export async function applyFrontmatterPatchRebased(args: RebaseFrontmatterArgs): Promise<void> {
  const { docId, relPath, targetBoardId, applying, expectedCurrent, label, atomic } = args;

  // Captured ONCE and consulted by the "Apply anyway" toast handlers: a click
  // after a vault swap must not schedule this patch onto the NEW vault's
  // same-named file (`scheduleFrontmatterWrite` resolves its vaultRoot live).
  // Also guards the disk read below.
  const identity = captureVaultIdentity();

  const commit = (patch: Record<string, unknown>): void => {
    // mergeFrontmatter keeps the DISPLAY cache live (cards / rows render from
    // it); the write SOURCE is the explicit delta, applied to fresh disk in the
    // gateway so an untouched external key can't be dropped.
    documentStore.mergeFrontmatter(docId, patch);
    scheduleFrontmatterWrite(relPath, docId, patchToFrontmatterDelta(patch));
    // allow-non-target-markdirty: shared helper, callers pass this.targetBoardId per the CI gate
    boardCacheStore.markDirty(targetBoardId);
  };

  let current = documentStore.getFrontmatter(docId);
  if (current === undefined) {
    // No cache seeded: a blind commit would clobber an external same-field
    // edit. Re-read disk fresh as the compare base; the vault index is the
    // degraded fallback when the read fails.
    const vaultRoot = vaultStore.path;
    if (!vaultRoot) return;
    let base: Record<string, unknown> | null = null;
    let rawFm: string | undefined;
    try {
      const hydrate = await readMarkdownForHydrate(vaultRoot, relPath);
      base = hydrate.frontmatter;
      rawFm = hydrate.rawFrontmatter;
    } catch {
      // ENOENT / transient — fall through to the index snapshot below.
    }
    // A swap landed during the read: don't seed the new vault's cache or
    // schedule a write onto its same-named file.
    if (!isStillSameVault(identity)) return;
    if (base === null) {
      const indexed = vaultIndexStore.getMetadata(relPath)?.frontmatter;
      if (indexed) base = indexed as Record<string, unknown>;
    }
    if (base === null) {
      // Nothing visible anywhere (file unreadable AND never indexed) — there is
      // no baseline to detect a conflict against, and nothing visible to lose,
      // so blind-merge.
      commit(applying);
      return;
    }
    // Seed the display cache from the base so the merge in `commit` lands on a
    // complete object (mirrors the execute legs' seedDocumentFrontmatterFromDisk).
    documentStore.setFrontmatter(docId, base, rawFm);
    current = base;
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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { documentStore } from '@renderer/stores/document.svelte';
import { applyFrontmatterPatchRebased } from '@renderer/commands/frontmatterRebase';
import { resetFrontmatterScheduler } from '@renderer/lib/boards/frontmatterWriteScheduler';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * REC-2 (Task List audit 2026-06-08, Phase 2) — a recurrence roll-forward writes
 * `{ completed: false, dueDate: next }` as a semantically-COUPLED pair. On
 * undo/redo, `applyFrontmatterPatchRebased`'s default per-key rebase could apply
 * one key and keep the other external — producing a `completed: true` +
 * advanced-`dueDate` state the roll-forward invariant must never create. The
 * `atomic` flag (set by `buildTaskFieldCommand` when a patch carries both keys)
 * makes ANY conflict skip the WHOLE patch.
 *
 * Scenario (redo leg): a weekly task due 2026-05-15 was completed → rolled to
 * 2026-05-22 (incomplete). Undo restored {completed:false, dueDate:2026-05-15}.
 * An external editor then marked it complete. Redo replays the roll-forward.
 */
describe('REC-2 — recurrence roll-forward rebase is atomic', () => {
  beforeEach(() => installFiloMock(() => null));
  afterEach(() => {
    resetFrontmatterScheduler(); // cancel any debounced write commit() armed
    restoreFiloDefault();
    documentStore.clear();
  });

  const PATCH = { completed: false, dueDate: '2026-05-22' }; // roll-forward (redo applies)
  const EXPECTED = { completed: false, dueDate: '2026-05-15' }; // inverse = pre-roll state

  it('atomic: an external completed-flip skips the WHOLE redo (no split)', () => {
    const notePath = 'T.md';
    // External editor marked it complete; dueDate still at the pre-roll value.
    documentStore.setFrontmatter(notePath, { completed: true, dueDate: '2026-05-15' });
    applyFrontmatterPatchRebased({
      notePath,
      relPath: 'T.md',
      targetBoardId: 'b',
      applying: PATCH,
      expectedCurrent: EXPECTED,
      label: 'T.md',
      atomic: true,
    });
    const fm = documentStore.getFrontmatter(notePath);
    expect(fm?.completed).toBe(true); // external value preserved
    expect(fm?.dueDate).toBe('2026-05-15'); // due NOT advanced — whole patch skipped
  });

  it('non-atomic (default) WOULD split into the invalid completed:true + advanced-due state', () => {
    const notePath = 'T.md';
    documentStore.setFrontmatter(notePath, { completed: true, dueDate: '2026-05-15' });
    applyFrontmatterPatchRebased({
      notePath,
      relPath: 'T.md',
      targetBoardId: 'b',
      applying: PATCH,
      expectedCurrent: EXPECTED,
      label: 'T.md',
      // atomic omitted → per-key (the pre-fix behaviour this test documents)
    });
    const fm = documentStore.getFrontmatter(notePath);
    expect(fm?.completed).toBe(true); // completed conflict kept external
    expect(fm?.dueDate).toBe('2026-05-22'); // dueDate split-applied — the bug atomic prevents
  });

  it('atomic with NO conflict applies the full patch normally', () => {
    const notePath = 'T.md';
    // Cache matches the expected pre-roll state — no external edit.
    documentStore.setFrontmatter(notePath, { completed: false, dueDate: '2026-05-15' });
    applyFrontmatterPatchRebased({
      notePath,
      relPath: 'T.md',
      targetBoardId: 'b',
      applying: PATCH,
      expectedCurrent: EXPECTED,
      label: 'T.md',
      atomic: true,
    });
    const fm = documentStore.getFrontmatter(notePath);
    expect(fm?.completed).toBe(false);
    expect(fm?.dueDate).toBe('2026-05-22');
  });
});

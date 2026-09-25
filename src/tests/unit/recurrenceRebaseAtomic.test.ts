import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { applyFrontmatterPatchRebased } from '@renderer/commands/frontmatterRebase';
import { noteStore } from '@renderer/stores/notes.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { setActiveVaultPath } from '@renderer/lib/vault/activeVaultPath';
import { beginVaultGeneration, __resetVaultIdentityForTests } from '@renderer/lib/vault/vaultIdentity';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

/**
 * A recurrence roll-forward writes `{ completed: false, dueDate: next }` as a
 * semantically COUPLED pair. On undo/redo, `applyFrontmatterPatchRebased`'s
 * default per-key rebase could apply one key and keep the other external,
 * producing a `completed: true` + advanced-`dueDate` state the roll-forward
 * invariant must never create. The `atomic` flag (set by
 * `buildTaskFieldCommand` when a patch carries both keys) makes ANY conflict
 * skip the WHOLE patch.
 *
 * Scenario (redo leg): a weekly task due 2026-05-15 was completed → rolled to
 * 2026-05-22 (incomplete). Undo restored {completed:false, dueDate:2026-05-15}.
 * An external editor then marked it complete. Redo replays the roll-forward.
 */
describe('recurrence roll-forward rebase is atomic', () => {
  let vault: MemoryVault;

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    __resetVaultIdentityForTests();
    beginVaultGeneration('/vault');
    setActiveVaultPath('/vault');
    noteStore.__resetForTests();
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
  });
  afterEach(() => {
    noteStore.__resetForTests();
    setActiveVaultPath('');
    restoreFiloDefault();
  });

  const PATCH = { completed: false, dueDate: '2026-05-22' }; // roll-forward (redo applies)
  const EXPECTED = { completed: false, dueDate: '2026-05-15' }; // inverse = pre-roll state

  async function redo(atomic?: boolean): Promise<void> {
    await applyFrontmatterPatchRebased({
      relPath: 'T.md',
      targetBoardId: 'b',
      applying: PATCH,
      expectedCurrent: EXPECTED,
      label: 'T.md',
      atomic,
    });
    await noteStore.flushAll();
  }

  it('atomic: an external completed-flip skips the WHOLE redo (no split)', async () => {
    // External editor marked it complete; dueDate still at the pre-roll value.
    vault = installMemoryVault({ 'T.md': '---\ncompleted: true\ndueDate: 2026-05-15\n---\n' });
    await redo(true);
    const text = vault.read('T.md');
    expect(text).toContain('completed: true'); // external value preserved
    expect(text).toContain('dueDate: 2026-05-15'); // due NOT advanced — whole patch skipped
    expect(uiStore.toasts.some((t) => t.actions?.some((a) => a.label === 'Apply anyway'))).toBe(true);
  });

  it('non-atomic (default) WOULD split into the invalid completed:true + advanced-due state', async () => {
    vault = installMemoryVault({ 'T.md': '---\ncompleted: true\ndueDate: 2026-05-15\n---\n' });
    await redo();
    const text = vault.read('T.md');
    expect(text).toContain('completed: true'); // completed conflict kept external
    expect(text).toContain('dueDate: 2026-05-22'); // dueDate split-applied — the state atomic prevents
  });

  it('atomic with NO conflict applies the full patch normally', async () => {
    // The note matches the expected pre-roll state — no external edit.
    vault = installMemoryVault({ 'T.md': '---\ncompleted: false\ndueDate: 2026-05-15\n---\n' });
    await redo(true);
    expect(vault.read('T.md')?.startsWith('---\ncompleted: false\ndueDate: 2026-05-22\n---\n')).toBe(true);
  });
});

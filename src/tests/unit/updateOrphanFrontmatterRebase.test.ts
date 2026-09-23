/**
 * 6.2.H8 — UpdateOrphanFrontmatterCommand bypasses the rebase guard.
 *
 * Pre-fix `applyOrphanPatch` read disk fresh (D.8) and unconditionally
 * spread the patch over the fresh frontmatter, then wrote through the
 * gateway. No per-field conflict detection. If an external editor
 * changed the same field between execute and undo, the inverse patch
 * blindly restored the pre-edit value — silently clobbering the
 * external change. `UpdateTaskFieldCommand` / `UpdateCardFieldCommand`
 * already route through `applyFrontmatterPatchRebased` (Audit2 4.2)
 * which has the right shape; this finding is the "make it docId-less"
 * variant.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { UpdateOrphanFrontmatterCommand } from '@renderer/commands/index';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

describe('UpdateOrphanFrontmatterCommand — 6.2.H8 rebase on undo', () => {
  let calls: Array<{ channel: string; args: unknown[] }>;
  let diskContent: string;

  beforeEach(() => {
    calls = [];
    diskContent = '---\npriority: low\n---\nbody content\n';
    installFiloMock((channel: unknown, ...args: unknown[]) => {
      calls.push({ channel: channel as string, args });
      if (channel === 'vault:read-file-text') {
        return { success: true, content: diskContent, mtimeMs: 1 };
      }
      if (channel === 'vault:stat') return { success: true, mtimeMs: 1, size: diskContent.length };
      if (channel === 'vault:write-existing-file-text') return { success: true };
      return undefined;
    });
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultIndexStore.clear();
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id);
  });
  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultIndexStore.clear();
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id);
  });

  it('undo preserves an external edit to the same field (skips the conflicting key)', async () => {
    const cmd = new UpdateOrphanFrontmatterCommand(
      'kb',
      'Card.md',
      { priority: 'high' },
      { priority: 'low' },
    );
    await cmd.execute();

    // Snapshot the writes-so-far. Any write that lands AFTER this point
    // belongs to the undo leg. Pre-fix, the undo's blind disk write would
    // emit `priority: low` here — clobbering the external editor's `critical`.
    // Post-fix, the all-conflict case suppresses the write entirely.
    const writesBeforeUndo = calls.filter(
      (c) =>
        (c.channel === 'vault:write-existing-file-text' ||
          c.channel === 'vault:write-file-text') &&
        c.args[1] === 'Card.md',
    ).length;

    // External editor changes `priority` to a third value between execute
    // and undo. The fresh disk read inside applyOrphanPatchRebased will see
    // `critical`, not the `high` we wrote on execute.
    diskContent = '---\npriority: critical\n---\nbody content\n';

    await cmd.undo();

    const writesAfterUndo = calls.filter(
      (c) =>
        (c.channel === 'vault:write-existing-file-text' ||
          c.channel === 'vault:write-file-text') &&
        c.args[1] === 'Card.md',
    );
    const undoWrites = writesAfterUndo.slice(writesBeforeUndo);
    // Post-fix: the undo's only key (priority) conflicts with disk, so
    // applyOrphanPatchRebased suppresses the write entirely and surfaces
    // a conflict toast instead. Pre-fix, a single `priority: low` write
    // would fire here, clobbering the external editor.
    for (const w of undoWrites) {
      const content = w.args[2] as string;
      expect(content).not.toContain('priority: low');
    }

    // A persistent warning toast names the conflicting field so the user
    // can choose to Apply anyway. Wording mirrors applyFrontmatterPatchRebased.
    const conflictToast = uiStore.toasts.find((t) =>
      /External edit changed/i.test(t.text),
    );
    expect(conflictToast).toBeDefined();
    expect(conflictToast?.text).toContain('priority');
  });

  it('A8-M5 — recomputes the inverse from disk so a stale index inverse cannot mis-restore', async () => {
    // The card has NO contentId; the writer built its inverse from the vault
    // index, which is STALE — an external editor added `priority: high` after the
    // last index rebuild, so the index (and thus the construction-time inverse)
    // has no priority. Simulate that with an empty-string inverse.
    diskContent = '---\npriority: high\n---\nbody content\n';
    const cmd = new UpdateOrphanFrontmatterCommand(
      'kb',
      'Card.md',
      { priority: 'low' }, // user sets low
      { priority: '' }, // STALE inverse from the index (priority was absent there)
    );

    const writeCountBefore = calls.filter(
      (c) => c.channel === 'vault:write-existing-file-text' && c.args[1] === 'Card.md',
    ).length;
    await cmd.execute();

    // Without M5: expectedCurrent ('') ≠ fresh disk ('high') → FALSE conflict →
    // the user's `low` is dropped (and a conflict toast fires). With M5: the
    // inverse is recomputed from disk to `high`, so execute matches disk and
    // applies `low` cleanly.
    const executeWrites = calls
      .filter((c) => c.channel === 'vault:write-existing-file-text' && c.args[1] === 'Card.md')
      .slice(writeCountBefore);
    expect(executeWrites.length).toBeGreaterThan(0);
    expect(executeWrites[executeWrites.length - 1].args[2] as string).toContain('priority: low');
    expect(uiStore.toasts.find((t) => /External edit changed/i.test(t.text))).toBeUndefined();

    // The execute write landed; reflect it on disk for the undo's fresh read.
    diskContent = '---\npriority: low\n---\nbody content\n';
    const writeCountAfterExecute = calls.filter(
      (c) => c.channel === 'vault:write-existing-file-text' && c.args[1] === 'Card.md',
    ).length;

    await cmd.undo();

    // Undo restores the TRUE prior on-disk value (`high`), NOT the stale ''
    // (which would have written a file with no priority key at all).
    const undoWrites = calls
      .filter((c) => c.channel === 'vault:write-existing-file-text' && c.args[1] === 'Card.md')
      .slice(writeCountAfterExecute);
    expect(undoWrites.length).toBeGreaterThan(0);
    const undoContent = undoWrites[undoWrites.length - 1].args[2] as string;
    expect(undoContent).toContain('priority: high');
  });

  it('L7 (Audit-13) — all-fields-conflict undo writes nothing and does NOT markDirty', async () => {
    const cmd = new UpdateOrphanFrontmatterCommand(
      'kb',
      'Card.md',
      { priority: 'high' },
      { priority: 'low' },
    );
    await cmd.execute(); // applies 'high' cleanly (disk was 'low')

    // Only watch the undo leg. The board cache holds no 'kb' board here, so a
    // markDirty would be a no-op write-schedule anyway — but it must not even be
    // CALLED when zero fields are applied (it was, pre-fix).
    const markDirtySpy = vi.spyOn(boardCacheStore, 'markDirty');

    // External editor changes the only key between execute and undo → the undo's
    // single key fully conflicts, so the write is suppressed entirely.
    diskContent = '---\npriority: critical\n---\nbody content\n';
    await cmd.undo();

    const undoWrites = calls.filter(
      (c) => c.channel === 'vault:write-existing-file-text' && c.args[1] === 'Card.md',
    );
    // (the execute write may be present; assert the undo added no priority:low write)
    for (const w of undoWrites) {
      expect(w.args[2] as string).not.toContain('priority: low');
    }
    expect(markDirtySpy).not.toHaveBeenCalled();
    markDirtySpy.mockRestore();
  });

  it('undo without a conflict still applies the inverse cleanly', async () => {
    const cmd = new UpdateOrphanFrontmatterCommand(
      'kb',
      'Card.md',
      { priority: 'high' },
      { priority: 'low' },
    );
    await cmd.execute();
    // No external change — diskContent still reflects post-execute state
    // (`priority: high`).
    diskContent = '---\npriority: high\n---\nbody content\n';

    await cmd.undo();
    const writes = calls.filter(
      (c) =>
        (c.channel === 'vault:write-existing-file-text' ||
          c.channel === 'vault:write-file-text') &&
        c.args[1] === 'Card.md',
    );
    const lastWrite = writes[writes.length - 1].args[2] as string;
    // Clean rebase: inverse applied, disk now carries `low`.
    expect(lastWrite).toContain('priority: low');
  });
});

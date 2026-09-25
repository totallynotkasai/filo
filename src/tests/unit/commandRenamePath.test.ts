/**
 * Commands follow renames: after a file (or a folder above it) is renamed,
 * every path a command holds names the file where it is now, so undo and redo
 * act on it there. The history store runs the sweep on every stack.
 *
 * Paths a command holds in Filo's trash stay as they are (undo restores the
 * item to its original path), and the user's own frontmatter values are never
 * rewritten.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Command } from '@renderer/commands/Command';
import { UpdateCardFieldCommand } from '@renderer/commands/index';
import { RenameFileCommand } from '@renderer/commands/renameFileCommand';
import { NoteGoneError } from '@renderer/commands/noteGoneError';
import { historyStore } from '@renderer/stores/history.svelte';
import { rebasePath, renameAllPathKeys } from '@renderer/lib/vault/renamePathKeys';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

/** A command holding paths in the shapes real commands use. */
class Holder extends Command {
  description = 'holder';
  readonly targetBoardId = '';
  relPath = 'Card.md';
  filePaths = ['Card.md', 'Work/Other.md', 'Elsewhere.md'];
  tiles = [{ id: 't1', filePath: 'Work/Other.md', style: { backgroundImage: 'Work/bg.png' } }];
  trashed: Array<{ rel: string; trashId: string }> = [];
  fm = { path: 'Card.md', src: 'Work/Other.md' };
  child: Holder | null = null;
  execute(): void {}
  undo(): void {}
}

describe('rebasePath', () => {
  it('matches the path itself and anything under a folder, case-folded, keeping the new spelling', () => {
    expect(rebasePath('Card.md', 'card.md', 'Renamed.md')).toBe('Renamed.md');
    expect(rebasePath('Work/Sub/Card.md', 'work', 'Projects')).toBe('Projects/Sub/Card.md');
    expect(rebasePath('Workshop/Card.md', 'Work', 'Projects')).toBeNull();
    expect(rebasePath('Other.md', 'Card.md', 'Renamed.md')).toBeNull();
  });
});

describe('Command.renamePath', () => {
  it('rewrites every path field, in snapshots too, and leaves others alone', () => {
    const cmd = new Holder();
    cmd.renamePath('Work', 'Projects');
    expect(cmd.filePaths).toEqual(['Card.md', 'Projects/Other.md', 'Elsewhere.md']);
    expect(cmd.tiles[0].filePath).toBe('Projects/Other.md');
    expect(cmd.tiles[0].style.backgroundImage).toBe('Projects/bg.png');
    expect(cmd.relPath).toBe('Card.md');
  });

  it("never rewrites the user's frontmatter values", () => {
    const cmd = new Holder();
    cmd.renamePath('Card.md', 'Renamed.md');
    expect(cmd.relPath).toBe('Renamed.md');
    expect(cmd.fm).toEqual({ path: 'Card.md', src: 'Work/Other.md' });
  });

  it('keeps paths it holds in the trash, and passes them to child commands', () => {
    const cmd = new Holder();
    cmd.trashed = [{ rel: 'Work/Other.md', trashId: 'abc' }];
    cmd.child = new Holder();
    cmd.renamePath('Work', 'Projects');
    expect(cmd.tiles[0].filePath).toBe('Work/Other.md');
    expect(cmd.child.tiles[0].filePath).toBe('Work/Other.md');
    expect(cmd.child.tiles[0].style.backgroundImage).toBe('Projects/bg.png');
  });

  it('RenameFileCommand ignores its own rename but follows a later one', () => {
    const cmd = new RenameFileCommand('Old.md', 'New.md');
    const ends = (): unknown => ({ fromPath: Reflect.get(cmd, 'fromPath'), toPath: Reflect.get(cmd, 'toPath') });
    cmd.renamePath('Old.md', 'New.md');
    cmd.renamePath('new.md', 'old.md');
    expect(ends()).toMatchObject({ fromPath: 'Old.md', toPath: 'New.md' });
    cmd.renamePath('New.md', 'Later.md');
    expect(ends()).toMatchObject({ fromPath: 'Old.md', toPath: 'Later.md' });
  });
});

describe('history follows renames', () => {
  let vault: MemoryVault;

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    noteStore.__resetForTests();
    historyStore.clear();
    vault = installMemoryVault({ 'Renamed.md': '---\ntitle: Card\ndueDate: 2026-11-05\n---\nBody\n' });
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
  });
  afterEach(() => {
    historyStore.clear();
    historyStore.setActiveBoard(null);
    noteStore.__resetForTests();
    restoreFiloDefault();
    vaultStore.setPath('');
  });

  it('a rename sweep re-points commands on every stack, undone and redoable alike', async () => {
    historyStore.setActiveBoard('kb');
    const undoable = new UpdateCardFieldCommand('kb', 'Card.md', { dueDate: '2026-11-05' }, { dueDate: '' });
    historyStore.pushWithoutExecute(undoable);
    historyStore.setActiveBoard('doc-tab');
    const other = new Holder();
    historyStore.pushWithoutExecute(other);

    renameAllPathKeys('Card.md', 'Renamed.md');

    expect(other.relPath).toBe('Renamed.md');
    historyStore.setActiveBoard('kb');
    await historyStore.undo();
    await noteStore.flushAll();
    expect(vault.read('Renamed.md')).toBe('---\ntitle: Card\n---\nBody\n');
    expect(vault.read('Card.md')).toBeUndefined();
  });

  it('an undo whose note is gone queues nothing, says so, and stays on the stack', async () => {
    historyStore.setActiveBoard('kb');
    const cmd = new UpdateCardFieldCommand('kb', 'Gone.md', { dueDate: '2026-11-05' }, { dueDate: '' });
    historyStore.pushWithoutExecute(cmd);

    await historyStore.undo();

    expect(noteStore.hasPendingWrites('Gone.md')).toBe(false);
    expect(historyStore.canUndo).toBe(true);
    const toast = uiStore.toasts.find((t) => t.text === `Couldn't undo: "Gone.md" no longer exists.`);
    expect(toast?.actions?.map((a) => a.label)).toEqual(['Skip this step']);
    toast!.actions![0].handler();
    expect(historyStore.canUndo).toBe(false);
  });

  it('NoteGoneError names the path', () => {
    expect(new NoteGoneError('a/b.md').message).toBe('"a/b.md" no longer exists.');
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { noteStore } from '@renderer/stores/notes.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import {
  UpdateCardFieldCommand,
  UpdateTaskFieldCommand,
  UpdatePropertiesCommand,
} from '@renderer/commands/index';
import { applyFrontmatterPatchRebased } from '@renderer/commands/frontmatterRebase';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { __resetVaultIdentityForTests } from '@renderer/lib/vault/vaultIdentity';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { TaskListBoard, KanbanBoard } from '@renderer/schema/index';

/**
 * Undo/redo and "Apply anyway" behaviour of field and Properties edits:
 *
 *   - Undo/redo of a field edit on a never-opened note rebases against the
 *     note as it stands on disk: an external same-field edit is kept (with a
 *     conflict toast), never blindly clobbered. Both legs (undo + redo) are
 *     covered, plus the no-conflict counter-case and the nothing-readable
 *     corner.
 *   - The rebase conflict-toast handlers bail via `isStillSameVault` when the
 *     vault swapped between arming and click.
 *   - The Properties "Apply anyway" toast writes whatever the note's body is
 *     at CLICK time (an editor's later keystrokes, or disk once it closed),
 *     never a body frozen when the conflict appeared.
 */

let vault: MemoryVault;

function makeTaskListFixture(): V7BoardFileData {
  return {
    board: {
      id: 'tl',
      type: 'tasklist',
      name: 'Tasks',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: { groupBy: 'status', sortBy: 'manual' },
      tasks: [],
    } as unknown as TaskListBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

function makeKanbanFixture(): V7BoardFileData {
  return {
    board: {
      id: 'kb',
      type: 'kanban',
      name: 'Board',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      columns: [],
      cards: [],
    } as unknown as KanbanBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

function mdWritesAfter(from: number): string[] {
  return vault.writes
    .slice(from)
    .filter(([, rel]) => rel.endsWith('.md'))
    .map(([, , text]) => text);
}

function conflictToast() {
  return uiStore.toasts.find((t) => t.text.includes('External edit changed'));
}

function resetAll(): void {
  __resetVaultIdentityForTests();
  __resetDirtyTrackingForTests();
  noteStore.__resetForTests();
  boardCacheStore.clear();
  vaultIndexStore.clear();
  for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
}

// ── never-opened note: undo/redo rebases on disk ─────────────────────────────

describe('undo/redo on a never-opened note rebases against FRESH disk (no blind clobber)', () => {
  beforeEach(() => {
    resetAll();
    vault = installMemoryVault({
      'card.md': '---\npriority: normal\n---\nbody\n',
      'task.md': '---\npriority: normal\n---\nbody\n',
    });
    vaultStore.setPath('/vault');
    boardCacheStore.hydrate(
      { tl: makeTaskListFixture(), kb: makeKanbanFixture() },
      { tl: 'tasks.board.json', kb: 'board.board.json' },
    );
  });
  afterEach(() => {
    resetAll();
    restoreFiloDefault();
    vaultStore.setPath('');
  });

  it('undo keeps an external same-field edit (kanban)', async () => {
    const cmd = new UpdateCardFieldCommand('kb', 'card.md', { priority: 'high' }, { priority: 'normal' });
    await cmd.execute();
    await noteStore.flushAll(); // forward write lands → disk has 'high'
    expect(vault.read('card.md')).toContain('priority: high');

    // An external editor changes the SAME field on disk.
    vault.writeExternally('card.md', '---\npriority: urgent\n---\nbody\n');
    // The watcher re-indexes the file.
    await vaultIndexStore.applyChanges(['card.md']);

    const mark = vault.writes.length;
    await cmd.undo();
    await noteStore.flushAll();

    // The fresh disk read ('urgent' ≠ expected 'high') keeps the external
    // value and prompts.
    expect(noteStore.frontmatter('card.md').priority).toBe('urgent');
    expect(vault.read('card.md')).toContain('priority: urgent');
    for (const w of mdWritesAfter(mark)) {
      expect(w).not.toContain('priority: normal');
    }
    const toast = conflictToast();
    expect(toast).toBeTruthy();
    expect(toast?.actions?.[0]?.label).toBe('Apply anyway');
  });

  it('redo keeps an external same-field edit (task)', async () => {
    const cmd = new UpdateTaskFieldCommand('tl', 'task.md', { priority: 'high' }, { priority: 'normal' });
    await cmd.execute();
    await noteStore.flushAll();
    await cmd.undo(); // clean rebase back to 'normal'
    await noteStore.flushAll();
    expect(vault.read('task.md')).toContain('priority: normal');

    vault.writeExternally('task.md', '---\npriority: urgent\n---\nbody\n');
    await vaultIndexStore.applyChanges(['task.md']);

    const mark = vault.writes.length;
    await cmd.execute(); // redo leg
    await noteStore.flushAll();

    expect(noteStore.frontmatter('task.md').priority).toBe('urgent');
    expect(vault.read('task.md')).toContain('priority: urgent');
    for (const w of mdWritesAfter(mark)) {
      expect(w).not.toContain('priority: high');
    }
    expect(conflictToast()).toBeTruthy();
  });

  it('redo with NO external edit still applies normally (no false conflict)', async () => {
    const cmd = new UpdateCardFieldCommand('kb', 'card.md', { priority: 'high' }, { priority: 'normal' });
    await cmd.execute();
    await noteStore.flushAll();
    await cmd.undo();
    await noteStore.flushAll();
    expect(vault.read('card.md')).toContain('priority: normal');

    await cmd.execute();
    await noteStore.flushAll();
    expect(noteStore.frontmatter('card.md').priority).toBe('high');
    expect(vault.read('card.md')).toContain('priority: high');
    expect(conflictToast()).toBeFalsy();
  });

  it('nothing readable (file gone) applies the inverse without a conflict prompt', async () => {
    const cmd = new UpdateTaskFieldCommand('tl', 'task.md', { priority: 'high' }, { priority: 'normal' });
    await cmd.execute();
    await noteStore.flushAll();

    // The file becomes unreadable: there is no baseline to detect a conflict
    // against, and nothing visible to clobber.
    vault.remove('task.md');

    await cmd.undo();
    expect(noteStore.frontmatter('task.md').priority).toBe('normal');
    expect(conflictToast()).toBeFalsy();
  });
});

// ── conflict-toast "Apply anyway" bails after a vault swap ────────────────────

describe('"Apply anyway" clicked after a vault swap is a no-op', () => {
  beforeEach(() => {
    resetAll();
    vault = installMemoryVault({
      'task.md': '---\npriority: normal\n---\nbody\n',
      'recur.md': '---\ncompleted: true\ndueDate: 2026-01-08\n---\nbody\n',
    });
    vaultStore.setPath('/vault');
    boardCacheStore.hydrate({ tl: makeTaskListFixture() }, { tl: 'tasks.board.json' });
  });
  afterEach(() => {
    resetAll();
    restoreFiloDefault();
    vaultStore.setPath('');
  });

  it('per-key handler: no merge, no write after the swap', async () => {
    const cmd = new UpdateTaskFieldCommand('tl', 'task.md', { priority: 'high' }, { priority: 'normal' });
    await cmd.execute();
    await noteStore.flushAll();
    vault.writeExternally('task.md', '---\npriority: urgent\n---\nbody\n'); // external edit
    await cmd.undo(); // conflict → toast armed against THIS vault generation
    const toast = conflictToast();
    expect(toast).toBeTruthy();

    vaultStore.setPath('/other-vault'); // swap bumps the vault generation
    const mark = vault.writes.length;
    uiStore.invokeToastAction(toast!.id, 0);
    await noteStore.flushAll();

    // The handler bails outright: nothing queued for, or written to, the new
    // vault's same-named file.
    expect(noteStore.hasPendingWrites('task.md')).toBe(false);
    expect(mdWritesAfter(mark)).toEqual([]);
    expect(vault.read('task.md')).toContain('priority: urgent');
  });

  it('atomic handler: whole-patch force is also swallowed after the swap', async () => {
    await applyFrontmatterPatchRebased({
      relPath: 'recur.md',
      targetBoardId: 'tl',
      applying: { completed: false, dueDate: '2026-01-15' },
      expectedCurrent: { completed: false, dueDate: '2026-01-01' },
      label: 'recur.md',
      atomic: true,
    });
    const toast = uiStore.toasts.find((t) => t.text.includes('Skipped this undo/redo'));
    expect(toast).toBeTruthy();

    vaultStore.setPath('/other-vault');
    const mark = vault.writes.length;
    uiStore.invokeToastAction(toast!.id, 0);
    await noteStore.flushAll();

    expect(noteStore.hasPendingWrites('recur.md')).toBe(false);
    expect(mdWritesAfter(mark)).toEqual([]);
    expect(vault.read('recur.md')).toBe('---\ncompleted: true\ndueDate: 2026-01-08\n---\nbody\n');
  });
});

// ── Properties "Apply anyway" writes the click-time body ──────────────────────

describe('Properties conflict toast writes the click-time body, not a conflict-time freeze', () => {
  beforeEach(() => {
    resetAll();
    vaultStore.setPath('/vault');
  });
  afterEach(() => {
    resetAll();
    restoreFiloDefault();
    vaultStore.setPath('');
  });

  /** Arms the conflict toast: disk holds an external value for the owned key,
   * so applySnapshot skips it and offers "Apply anyway". */
  async function armConflict(relPath: string): Promise<{ id: string }> {
    const cmd = new UpdatePropertiesCommand(
      { kind: 'frontmatter', relPath, fm: { priority: 'low' } },
      { kind: 'frontmatter', relPath, fm: { priority: 'high' } },
      'mm',
    );
    await cmd.execute();
    const toast = conflictToast();
    expect(toast).toBeTruthy();
    return toast!;
  }

  it('an editor body edited between conflict and click is what gets written', async () => {
    vault = installMemoryVault({ 'P.md': '---\npriority: external\n---\noriginal body\n' });
    const m = noteStore.acquire('P.md', 'text-tile:p');
    await m.loaded;
    const toast = await armConflict('P.md');

    // The user keeps typing after the conflict toast appeared.
    noteStore.setBody('P.md', 'NEW EDITOR BODY', 'text-tile:p');

    const mark = vault.writes.length;
    uiStore.invokeToastAction(toast.id, 0);
    await noteStore.flushAll();

    const written = mdWritesAfter(mark).pop()!;
    expect(written).toContain('NEW EDITOR BODY');
    expect(written).not.toContain('original body');
    expect(written).toContain('priority: high');
    noteStore.release('P.md', 'text-tile:p');
  });

  it('an editor CLOSED between conflict and click leaves the body to fresh disk', async () => {
    vault = installMemoryVault({ 'Q.md': '---\npriority: external\n---\noriginal body\n' });
    const m = noteStore.acquire('Q.md', 'text-tile:q');
    await m.loaded;
    const toast = await armConflict('Q.md');

    // Editor closes; its (interim) saves landed on disk in the meantime.
    noteStore.release('Q.md', 'text-tile:q');
    vault.writeExternally('Q.md', '---\npriority: external\n---\nDISK BODY AT CLICK\n');

    const mark = vault.writes.length;
    uiStore.invokeToastAction(toast.id, 0);
    await noteStore.flushAll();

    const written = mdWritesAfter(mark).pop()!;
    expect(written).toContain('DISK BODY AT CLICK');
    expect(written).not.toContain('original body');
    expect(written).toContain('priority: high');
  });
});

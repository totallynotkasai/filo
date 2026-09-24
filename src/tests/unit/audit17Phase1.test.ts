import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { documentStore } from '@renderer/stores/document.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import {
  UpdateCardFieldCommand,
  UpdateTaskFieldCommand,
  UpdatePropertiesCommand,
} from '@renderer/commands/index';
import { applyFrontmatterPatchRebased } from '@renderer/commands/frontmatterRebase';
import {
  resetFrontmatterScheduler,
  flushAllPendingFrontmatterWrites,
} from '@renderer/lib/boards/frontmatterWriteScheduler';
import { cancelAllMarkdownWrites } from '@renderer/lib/vault/markdownFileWriter';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { __resetVaultIdentityForTests } from '@renderer/lib/vault/vaultIdentity';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { TaskListBoard, KanbanBoard } from '@renderer/schema/index';

/**
 * Audit-17 Phase 1 behavioral matrix. Each test reds when its fix is
 * temp-reverted (the A8 discipline):
 *
 *   - 1.1 (HIGH) — `applyFrontmatterPatchRebased`'s `current === undefined`
 *     branch re-reads FRESH disk as the compare base instead of the old blind
 *     `commit(applying)`: an undo/redo of a field edit on a never-opened doc
 *     (seeded cache dropped by `dropStaleSeededFrontmatterCache` after a
 *     classified external FM edit) must NOT silently clobber an external
 *     same-field edit. Both legs (undo + isRedo-execute) are covered, plus the
 *     no-conflict counter-case and the nothing-visible legacy corner.
 *   - 1.2 — `UpdatePropertiesCommand`'s "Apply anyway" toast re-resolves the
 *     body at CLICK time: the old conflict-time `body`/`bodyIsLive` freeze
 *     reverted every editor save made between conflict and click (and a doc
 *     CLOSED in the interim still claimed its frozen body was live).
 *   - 1.3 — the rebase conflict-toast handlers bail via `isStillSameVault`
 *     when the vault swapped between arming and click (the write scheduler
 *     resolves its vaultRoot live at fire time).
 *   - 1.4 — `applySnapshot` rethrows a failed gateway write so historyStore's
 *     rollback drops the never-applied command from the stack, and the display
 *     cache is stamped only AFTER a successful write.
 */

interface Captured {
  channel: string;
  args: unknown[];
}

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

function existingWritesAfter(captured: Captured[], from: number): string[] {
  return captured
    .slice(from)
    .filter((c) => c.channel === 'vault:write-existing-file-text')
    .map((c) => c.args[2] as string);
}

function conflictToast() {
  return uiStore.toasts.find((t) => t.text.includes('External edit changed'));
}

function resetAll(): void {
  __resetVaultIdentityForTests();
  __resetDirtyTrackingForTests();
  cancelAllMarkdownWrites();
  resetFrontmatterScheduler();
  documentStore.clear();
  boardCacheStore.clear();
  vaultIndexStore.clear();
  for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
}

// ── A17-1.1 — never-opened doc: rebase re-reads disk instead of blind-committing ──
describe('A17-1.1 — undo/redo on a never-opened doc rebases against FRESH disk (no blind clobber)', () => {
  let captured: Captured[];
  let disk: string;

  /** mtime/size deliberately CONSTANT so the drift gate never trips while the
   * test mutates `disk` content between command legs (the fixture simulates
   * external edits the watcher classified, not unobserved drift). */
  function installMutableDiskMock(): void {
    captured = [];
    installFiloMock((channel: string, ...args: unknown[]) => {
      captured.push({ channel, args });
      if (channel === 'vault:read-file-text') {
        return { success: true, content: disk, mtimeMs: 1, size: 50 };
      }
      if (channel === 'vault:stat') return { success: true, mtimeMs: 1, size: 50 };
      if (channel === 'vault:write-existing-file-text') {
        disk = args[2] as string; // writes land on the simulated disk
        return { success: true };
      }
      return { success: true };
    });
  }

  beforeEach(() => {
    resetAll();
    disk = '---\npriority: normal\n---\nbody\n';
    installMutableDiskMock();
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

  it('undo keeps an external same-field edit when the seeded cache was dropped (kanban)', async () => {
    const cmd = new UpdateCardFieldCommand(
      'kb',
      'card.md',
      'card.md',
      { priority: 'high' },
      { priority: 'normal' },
    );
    await cmd.execute();
    await flushAllPendingFrontmatterWrites(); // forward write lands → disk has 'high'
    expect(disk).toContain('priority: high');

    // External editor changes the SAME field on disk; the classifier's
    // dropStaleSeededFrontmatterCache clears the not-open seeded entry.
    disk = '---\npriority: urgent\n---\nbody\n';
    documentStore.clearFrontmatter('card.md');
    expect(documentStore.getFrontmatter('card.md')).toBeUndefined();

    const mark = captured.length;
    await cmd.undo();
    await flushAllPendingFrontmatterWrites();

    // Pre-fix: the blind commit scheduled 'normal' over 'urgent' with no
    // conflict detection. Now the fresh disk read ('urgent' ≠ expected 'high')
    // keeps the external value and prompts.
    expect(documentStore.getFrontmatter('card.md')?.priority).toBe('urgent');
    expect(disk).toContain('priority: urgent');
    for (const w of existingWritesAfter(captured, mark)) {
      expect(w).not.toContain('priority: normal');
    }
    const toast = conflictToast();
    expect(toast).toBeTruthy();
    expect(toast?.actions?.[0]?.label).toBe('Apply anyway');
  });

  it('redo keeps an external same-field edit when the seeded cache was dropped (task)', async () => {
    const cmd = new UpdateTaskFieldCommand(
      'tl',
      'task.md',
      'task.md',
      { priority: 'high' },
      { priority: 'normal' },
    );
    await cmd.execute();
    await flushAllPendingFrontmatterWrites();
    await cmd.undo(); // cache still seeded → clean rebase back to 'normal'
    await flushAllPendingFrontmatterWrites();
    expect(disk).toContain('priority: normal');

    disk = '---\npriority: urgent\n---\nbody\n';
    documentStore.clearFrontmatter('task.md');

    const mark = captured.length;
    await cmd.execute(); // isRedo leg
    await flushAllPendingFrontmatterWrites();

    expect(documentStore.getFrontmatter('task.md')?.priority).toBe('urgent');
    expect(disk).toContain('priority: urgent');
    for (const w of existingWritesAfter(captured, mark)) {
      expect(w).not.toContain('priority: high');
    }
    expect(conflictToast()).toBeTruthy();
  });

  it('redo with NO external edit still applies normally (no false conflict)', async () => {
    const cmd = new UpdateCardFieldCommand(
      'kb',
      'card.md',
      'card.md',
      { priority: 'high' },
      { priority: 'normal' },
    );
    await cmd.execute();
    await flushAllPendingFrontmatterWrites();
    await cmd.undo();
    await flushAllPendingFrontmatterWrites();
    expect(disk).toContain('priority: normal');

    // A reload dropped the seeded cache, but disk holds exactly what the undo
    // wrote — the redo must apply cleanly, not phantom-conflict.
    documentStore.clearFrontmatter('card.md');

    await cmd.execute();
    await flushAllPendingFrontmatterWrites();
    expect(documentStore.getFrontmatter('card.md')?.priority).toBe('high');
    expect(disk).toContain('priority: high');
    expect(conflictToast()).toBeFalsy();
  });

  it('nothing visible anywhere (unreadable file, empty index) preserves the legacy blind merge', async () => {
    documentStore.setFrontmatter('task.md', { priority: 'normal' });
    const cmd = new UpdateTaskFieldCommand(
      'tl',
      'task.md',
      'task.md',
      { priority: 'high' },
      { priority: 'normal' },
    );
    await cmd.execute();
    await flushAllPendingFrontmatterWrites();

    documentStore.clearFrontmatter('task.md');
    // File becomes unreadable AND it was never indexed — no baseline exists.
    installFiloMock((channel: string, ...args: unknown[]) => {
      captured.push({ channel, args });
      if (channel === 'vault:read-file-text') return { success: false, code: 'ENOENT' };
      return { success: true };
    });

    await cmd.undo();
    // The narrow legacy corner: with no baseline obtainable the inverse still
    // applies (there is nothing visible to clobber) and no conflict prompt fires.
    expect(documentStore.getFrontmatter('task.md')?.priority).toBe('normal');
    expect(conflictToast()).toBeFalsy();
  });
});

// ── A17-1.3 — conflict-toast "Apply anyway" bails after a vault swap ──────────
describe('A17-1.3 — "Apply anyway" clicked after a vault swap is a no-op', () => {
  let captured: Captured[];

  beforeEach(() => {
    resetAll();
    captured = [];
    installFiloMock((channel: string, ...args: unknown[]) => {
      captured.push({ channel, args });
      if (channel === 'vault:read-file-text') {
        return { success: true, content: '---\npriority: high\n---\nbody\n', mtimeMs: 1, size: 50 };
      }
      if (channel === 'vault:stat') return { success: true, mtimeMs: 1, size: 50 };
      return { success: true };
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
    documentStore.setFrontmatter('task.md', { priority: 'normal' });
    const cmd = new UpdateTaskFieldCommand(
      'tl',
      'task.md',
      'task.md',
      { priority: 'high' },
      { priority: 'normal' },
    );
    await cmd.execute();
    documentStore.setFrontmatter('task.md', { priority: 'urgent' }); // external edit
    await cmd.undo(); // conflict → toast armed against THIS vault generation
    const toast = conflictToast();
    expect(toast).toBeTruthy();

    vaultStore.setPath('/other-vault'); // swap bumps the vault generation
    const mark = captured.length;
    uiStore.invokeToastAction(toast!.id, 0);
    await flushAllPendingFrontmatterWrites();

    // Pre-fix the handler committed: cache merged 'normal' + a write scheduled
    // against the NEW vault's same-named file. Now it bails outright.
    expect(documentStore.getFrontmatter('task.md')?.priority).toBe('urgent');
    expect(existingWritesAfter(captured, mark)).toEqual([]);
  });

  it('atomic handler: whole-patch force is also swallowed after the swap', async () => {
    documentStore.setFrontmatter('recur.md', { completed: true, dueDate: '2026-01-08' });
    await applyFrontmatterPatchRebased({
      notePath: 'recur.md',
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
    const mark = captured.length;
    uiStore.invokeToastAction(toast!.id, 0);
    await flushAllPendingFrontmatterWrites();

    expect(documentStore.getFrontmatter('recur.md')).toMatchObject({
      completed: true,
      dueDate: '2026-01-08',
    });
    expect(existingWritesAfter(captured, mark)).toEqual([]);
  });
});

// ── A17-1.2 — Properties "Apply anyway" re-resolves the body at click time ────
describe('A17-1.2 — Properties conflict toast writes the click-time body, not the conflict-time freeze', () => {
  let captured: Captured[];
  let disk: string;

  beforeEach(() => {
    resetAll();
    captured = [];
    disk = '---\npriority: external\n---\noriginal body\n';
    installFiloMock((channel: string, ...args: unknown[]) => {
      captured.push({ channel, args });
      if (channel === 'vault:read-file-text') {
        return { success: true, content: disk, mtimeMs: 1, size: 50 };
      }
      if (channel === 'vault:stat') return { success: true, mtimeMs: 1, size: 50 };
      if (channel === 'vault:write-existing-file-text') {
        disk = args[2] as string;
        return { success: true };
      }
      return { success: true };
    });
    vaultStore.setPath('/vault');
  });
  afterEach(() => {
    resetAll();
    restoreFiloDefault();
    vaultStore.setPath('');
  });

  /** Arms the conflict toast: the live cache holds an external value for the
   * owned key, so applySnapshot skips it and offers "Apply anyway". */
  async function armConflict(relPath: string): Promise<{ id: string }> {
    documentStore.loadDocument({
      filename: relPath,
      title: 'P',
      body: 'original body',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter(relPath, { priority: 'external' });
    const cmd = new UpdatePropertiesCommand(
      { kind: 'frontmatter', relPath, notePath: relPath, fm: { priority: 'low' } },
      { kind: 'frontmatter', relPath, notePath: relPath, fm: { priority: 'high' } },
      'mm',
    );
    await cmd.execute();
    const toast = conflictToast();
    expect(toast).toBeTruthy();
    return toast!;
  }

  it('an editor body edited between conflict and click wins over the frozen body', async () => {
    const toast = await armConflict('P.md');

    // The user keeps typing after the conflict toast appeared.
    documentStore.updateContent('P.md', '<p>x</p>', 'NEW EDITOR BODY');

    const mark = captured.length;
    uiStore.invokeToastAction(toast.id, 0);
    await vi.waitFor(() => {
      expect(existingWritesAfter(captured, mark).length).toBeGreaterThan(0);
    });

    const written = existingWritesAfter(captured, mark).pop()!;
    // Pre-fix the frozen conflict-time body ('original body') reverted the
    // interim keystrokes; now the click-time live body travels with the delta.
    expect(written).toContain('NEW EDITOR BODY');
    expect(written).not.toContain('original body');
    expect(written).toContain('priority: high');
  });

  it('an editor CLOSED between conflict and click defers to fresh disk for the body', async () => {
    const toast = await armConflict('Q.md');

    // Editor closes; its (interim) saves landed on disk in the meantime.
    documentStore.unloadDocument('Q.md');
    disk = '---\npriority: external\n---\nDISK BODY AT CLICK\n';

    const mark = captured.length;
    uiStore.invokeToastAction(toast.id, 0);
    await vi.waitFor(() => {
      expect(existingWritesAfter(captured, mark).length).toBeGreaterThan(0);
    });

    const written = existingWritesAfter(captured, mark).pop()!;
    // Pre-fix the captured `docState != null` still claimed the frozen body was
    // live and wrote 'original body' back. Now bodyIsLive is recomputed at
    // click time (false) and the gateway's fresh in-chain read supplies the body.
    expect(written).toContain('DISK BODY AT CLICK');
    expect(written).not.toContain('original body');
    expect(written).toContain('priority: high');
  });
});

// ── A17-1.4 — failed Properties write rejects; history rolls back ─────────────
describe('A17-1.4 — UpdatePropertiesCommand surfaces a failed write to the history rollback', () => {
  let captured: Captured[];
  let failWrites: boolean;

  beforeEach(() => {
    resetAll();
    captured = [];
    failWrites = false;
    // Audit-19 MD-2 — the disk reflects successful writes (a static disk made
    // undo's "back to low" look like an identical-bytes no-op the gateway skips).
    let disk = '---\npriority: low\n---\nbody\n';
    let mtime = 1;
    installFiloMock((channel: string, ...args: unknown[]) => {
      captured.push({ channel, args });
      if (channel === 'vault:read-file-text') {
        return { success: true, content: disk, mtimeMs: mtime, size: disk.length };
      }
      if (channel === 'vault:stat') return { success: true, mtimeMs: mtime, size: disk.length };
      if (channel === 'vault:write-existing-file-text') {
        if (failWrites) return { success: false, code: 'ENOSPC' };
        disk = String(args[2]);
        mtime += 1;
        return { success: true };
      }
      return { success: true };
    });
    vaultStore.setPath('/vault');
    historyStore.clear();
    historyStore.setActiveBoard('mm');
    // reportError (command) + reportError (history rollback) both breadcrumb to
    // console.error; keep the strict runner's stderr clean.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetAll();
    restoreFiloDefault();
    historyStore.clear();
    historyStore.setActiveBoard(null);
    vaultStore.setPath('');
  });

  function makeCmd(): UpdatePropertiesCommand {
    return new UpdatePropertiesCommand(
      { kind: 'frontmatter', relPath: 'F.md', notePath: 'F.md', fm: { priority: 'low' } },
      { kind: 'frontmatter', relPath: 'F.md', notePath: 'F.md', fm: { priority: 'high' } },
      'mm',
    );
  }

  it('failed execute: command rolled off the stack, display cache stays at disk truth', async () => {
    failWrites = true;
    await expect(historyStore.execute(makeCmd())).rejects.toThrow();

    // Pre-fix the swallow resolved execute() as success: the command sat on the
    // stack as "applied" and the pre-write setFrontmatter stamp left the display
    // cache showing 'high' while disk still said 'low'.
    expect(historyStore.canUndo).toBe(false);
    expect(documentStore.getFrontmatter('F.md')?.priority).toBe('low');
  });

  it('failed undo: command restored to the undo stack, redo stack not corrupted', async () => {
    await historyStore.execute(makeCmd());
    expect(historyStore.canUndo).toBe(true);

    failWrites = true;
    await expect(historyStore.undo()).rejects.toThrow();

    // rollbackUndo put the command back on the undo stack and removed it from
    // the redo stack — a follow-up Ctrl+Z retries it, Ctrl+Y has nothing stale.
    expect(historyStore.canUndo).toBe(true);
    expect(historyStore.canRedo).toBe(false);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  makeFrontmatterWriter,
  type FrontmatterWriter,
} from '@renderer/lib/tasklist/frontmatterWriter';
import { historyStore } from '@renderer/stores/history.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import {
  __resetDirtyTrackingForTests,
  __clearRecentSelfWritesForTests,
} from '@renderer/lib/boards/writeStateTracking';
import { __resetBaselinesForTests } from '@renderer/lib/vault/fileBaselineRegistry';
import { cancelAllMarkdownWrites } from '@renderer/lib/vault/markdownFileWriter';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import type { TaskRow } from '@renderer/lib/tasks/taskListModel';
import type { Tile, TaskListBoard } from '@renderer/schema/index';

/**
 * P2.3 (Task List audit 2026-06-08) — the two note-less ("orphan") task write
 * gaps: a text tile with no `filePath`. Every Filo-created task carries one,
 * so these paths only fire on a hand-edited / legacy `.board.json`. Before the fix they SILENTLY dropped the
 * edit:
 *   WRITE-1 — markAllIncomplete skipped note-less rows (stayed completed) AND
 *             over-counted the success toast.
 *   NOTES-1 — setNotesBody scheduled scheduleFrontmatterWrite(path, null), which
 *             re-emits the OLD disk body, discarding the typed note.
 */

function mkRow(over: Partial<TaskRow> & { id: string }): TaskRow {
  const { id, ...rest } = over;
  return {
    placement: { tileId: id, position: 0 },
    tile: { id, type: 'text', title: id } as unknown as Tile,
    completed: false,
    priority: 'none',
    dueDate: '',
    dueTime: '',
    startDate: '',
    status: '',
    tags: [],
    parent: '',
    recurrence: '',
    recurrenceMode: 'schedule',
    category: '',
    ...rest,
  } as TaskRow;
}

function makeWriter(): FrontmatterWriter {
  return makeFrontmatterWriter({
    getBoard: () => ({ id: 'b' } as unknown as TaskListBoard),
    vaultPathForTile: (tile) => `${tile.title}.md`,
    readFrontmatter: () => ({ completed: true }),
    bumpCacheVersion: () => {},
  });
}

describe('WRITE-1 — markAllIncomplete routes note-less rows through an orphan command', () => {
  afterEach(() => vi.restoreAllMocks());

  it('builds a command for the note-less completed row AND counts it honestly', async () => {
    // Mock execute so the orphan command isn't actually run (no disk IO needed —
    // we only assert the routing decision + honest count).
    const executeSpy = vi.spyOn(historyStore, 'execute').mockResolvedValue(undefined);
    const toastSpy = vi.spyOn(uiStore, 'toast');
    const writer = makeWriter();

    const noteRow = mkRow({
      id: 'withDoc',
      completed: true,
      tile: { id: 'withDoc', type: 'text', title: 'WithDoc', filePath: 'WithDoc.md' } as unknown as Tile,
    });
    const orphanRow = mkRow({ id: 'orphan', completed: true }); // no filePath

    await writer.markAllIncomplete([noteRow, orphanRow]);

    // Both rows produce a command → one batch executed; count = 2 (was 1 pre-fix,
    // because the orphan row used to be skipped while the toast still claimed it).
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(toastSpy).toHaveBeenCalledWith('2 tasks marked incomplete', 'success', 2000);
  });

  it('toasts "no completed tasks" when none are completed', async () => {
    const toastSpy = vi.spyOn(uiStore, 'toast');
    const writer = makeWriter();
    await writer.markAllIncomplete([mkRow({ id: 'a', completed: false })]);
    expect(toastSpy).toHaveBeenCalledWith('No completed tasks to mark', 'info', 2000);
  });
});

describe('NOTES-1 — setNotesBody writes a note-less task body via the gateway', () => {
  let captured: Array<{ channel: string; args: unknown[] }>;

  beforeEach(() => {
    captured = [];
    vaultStore.setPath('/vault');
    installFiloMock((channel, ...args) => {
      if (channel === 'vault:read-file-text') {
        return {
          success: true,
          content: '---\ncompleted: false\n---\nOLD BODY\n',
          mtimeMs: 1,
          size: 30,
        };
      }
      if (
        channel === 'vault:write-existing-file-text' ||
        channel === 'vault:write-file-text'
      ) {
        captured.push({ channel, args });
        return { success: true };
      }
      return undefined;
    });
  });
  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
    __resetDirtyTrackingForTests();
    __clearRecentSelfWritesForTests();
    __resetBaselinesForTests();
    cancelAllMarkdownWrites();
  });

  it('writes the NEW note body (not the re-emitted old disk body), FM preserved', async () => {
    const writer = makeWriter();
    const orphanRow = mkRow({
      id: 'orphan',
      tile: { id: 'orphan', type: 'text', title: 'Orphan' } as unknown as Tile, // no filePath
    });

    await writer.setNotesBody(orphanRow, 'NEW NOTE BODY');

    const write = captured.find((c) => c.channel.startsWith('vault:write'));
    expect(write).toBeTruthy();
    const content = write!.args[2] as string;
    expect(content).toContain('NEW NOTE BODY'); // the typed note actually landed
    expect(content).not.toContain('OLD BODY'); // the old disk body was NOT re-emitted
    expect(content).toContain('completed: false'); // frontmatter preserved verbatim
  });
});

describe('DATE-3 — clearing a due date clears its time in ONE command', () => {
  afterEach(() => vi.restoreAllMocks());

  function dateWriter(): FrontmatterWriter {
    return makeFrontmatterWriter({
      getBoard: () => ({ id: 'b' } as unknown as TaskListBoard),
      vaultPathForTile: (tile) => `${tile.title}.md`,
      readFrontmatter: () => ({ dueDate: '2026-01-01', dueTime: '09:00' }),
      bumpCacheVersion: () => {},
    });
  }

  // The command's default description is `Update task <keys>` — a cheap, public
  // proxy for the patch shape (the patch field is private).
  function descOf(spy: ReturnType<typeof vi.spyOn>): string {
    const cmd = spy.mock.calls[0]?.[0] as { description: string } | undefined;
    return cmd?.description ?? '';
  }

  it('emits a single {dueDate, dueTime} patch when the row has a time', async () => {
    const executeSpy = vi.spyOn(historyStore, 'execute').mockResolvedValue(undefined);
    const row = mkRow({
      id: 'r',
      dueDate: '2026-01-01',
      dueTime: '09:00',
      tile: { id: 'r', type: 'text', title: 'R', filePath: 'R.md' } as unknown as Tile,
    });
    await dateWriter().setDueDate(row, '');
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(descOf(executeSpy)).toBe('Update task dueDate, dueTime');
  });

  it('emits a single {dueDate} patch when the row has no time', async () => {
    const executeSpy = vi.spyOn(historyStore, 'execute').mockResolvedValue(undefined);
    const row = mkRow({
      id: 'r',
      dueDate: '2026-01-01',
      dueTime: '',
      tile: { id: 'r', type: 'text', title: 'R', filePath: 'R.md' } as unknown as Tile,
    });
    await dateWriter().setDueDate(row, '');
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(descOf(executeSpy)).toBe('Update task dueDate');
  });

  it('a non-empty date leaves the time untouched (single-key patch)', async () => {
    const executeSpy = vi.spyOn(historyStore, 'execute').mockResolvedValue(undefined);
    const row = mkRow({
      id: 'r',
      dueDate: '',
      dueTime: '09:00',
      tile: { id: 'r', type: 'text', title: 'R', filePath: 'R.md' } as unknown as Tile,
    });
    await dateWriter().setDueDate(row, '2026-02-02');
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(descOf(executeSpy)).toBe('Update task dueDate');
  });
});

describe('REC-3 — recurring roll-forward announces the new date', () => {
  afterEach(() => vi.restoreAllMocks());

  function writer(): FrontmatterWriter {
    return makeFrontmatterWriter({
      getBoard: () => ({ id: 'b' } as unknown as TaskListBoard),
      vaultPathForTile: (tile) => `${tile.title}.md`,
      readFrontmatter: () => ({}),
      bumpCacheVersion: () => {},
    });
  }

  it('toasts "rescheduled" when completing a recurring task rolls it forward', async () => {
    vi.spyOn(historyStore, 'execute').mockResolvedValue(undefined);
    const toastSpy = vi.spyOn(uiStore, 'toast');
    const row = mkRow({
      id: 'r',
      recurrence: 'weekly',
      recurrenceMode: 'completion',
      dueDate: '2026-01-01',
      tile: { id: 'r', type: 'text', title: 'R', filePath: 'R.md' } as unknown as Tile,
    });
    await writer().toggleCompleted(row);
    expect(toastSpy).toHaveBeenCalledWith(expect.stringContaining('rescheduled'), 'info', 2500);
  });

  it('does NOT toast when completing a plain (non-recurring) task', async () => {
    vi.spyOn(historyStore, 'execute').mockResolvedValue(undefined);
    const toastSpy = vi.spyOn(uiStore, 'toast');
    const row = mkRow({
      id: 'r',
      tile: { id: 'r', type: 'text', title: 'R', filePath: 'R.md' } as unknown as Tile,
    });
    await writer().toggleCompleted(row);
    expect(toastSpy).not.toHaveBeenCalled();
  });
});

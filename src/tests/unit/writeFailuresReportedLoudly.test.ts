import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { atomicWriteFile } from '../../main/vault/filenameUtils';
import {
  writeBoardFile,
  setBoardExternalEditHandler,
} from '@renderer/lib/boards/boardWriteScheduler';
import {
  noteBaseline,
  __resetBaselinesForTests,
} from '@renderer/lib/vault/fileBaselineRegistry';
import {
  setWriteErrorListener,
  isPathPending,
  __resetDirtyTrackingForTests,
  type WriteErrorInfo,
} from '@renderer/lib/boards/writeStateTracking';
import { noteStore, setNotePromptHandlers } from '@renderer/stores/notes.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { releaseBoardDrift } from '@renderer/lib/boards/boardDriftHold';
import { uiStore } from '@renderer/stores/ui.svelte';
import { onError, __resetErrorBusForTests, type ReportedError } from '@renderer/lib/utils/errorBus';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Audit-17 Phase 2 — the "failure reported as success" error-honesty cluster.
 *
 *  2.1 A note flush must report a failed write as a failure (the edit stays
 *      unsaved and queued), never resolve it as success.
 *  2.2 `atomicWriteFile` deleted the fully-written + fsynced tmp when the
 *      rename retry budget exhausted on EPERM/EBUSY — on a quit-time flush
 *      those are the user's last bytes. Fix: EPERM/EBUSY join the
 *      ENOSPC/EIO/ENOMEM/EACCES preserve list.
 *  2.3 The board scheduler's pre-write `vault:stat` ENOENT (baseline
 *      present) bare-returned → the armed write resolved as SUCCESS and the
 *      debounce window's mutations silently dropped on a sync-client
 *      unlink/recreate blip. Fix: re-stat once after a grace delay; a
 *      reappeared file falls through to the existing drift check (prompt),
 *      a still-missing file keeps the genuine-delete no-op semantics.
 *  2.4 `writeBoardFile`'s drift fallback with NO registered handler silently
 *      resolved 'keep-local' (overwriting the external edit), contradicting
 *      the module docstring. Fix: default to 'defer' → abort +
 *      notifyWriteError.
 *  2.5 `uiStore.invokeToastAction` swallowed async action failures into the
 *      console. Fix: failures route through reportError (errorBus). A
 *      conflict's Reload re-reads FIRST, so a failing re-read leaves the
 *      user's unsaved edit in place.
 */

// ── 2.1 — note flush failure honesty ──

describe('Audit-17 2.1 — a note flush reports failure instead of resolving as success', () => {
  let vault: MemoryVault;
  const VIEW = 'text-tile:a17';

  async function edited(relPath: string): Promise<void> {
    const m = noteStore.acquire(relPath, VIEW);
    await m.loaded;
    noteStore.setBody(relPath, 'edited', VIEW);
  }

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
    vaultStore.setPath('/vault');
    noteStore.__resetForTests();
    vault = installMemoryVault({
      'Notes/A17ok.md': '---\ntitle: T\n---\norig',
      'Notes/A17fail.md': '---\ntitle: T\n---\norig',
      'Notes/A17gone.md': '---\ntitle: T\n---\norig',
      'Notes/A17heal.md': '---\ntitle: T\n---\norig',
    });
    // The writer's reportError breadcrumbs to console.error.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    noteStore.__resetForTests();
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
    restoreFiloDefault();
    vi.restoreAllMocks();
  });

  it('a successful flush returns true and the note goes clean', async () => {
    const relPath = 'Notes/A17ok.md';
    await edited(relPath);

    expect(await noteStore.flush(relPath)).toBe(true);
    expect(noteStore.get(relPath)?.hasUnsavedBody).toBe(false);
    expect(noteStore.hasPendingWrites(relPath)).toBe(false);
    expect(vault.read(relPath)).toContain('edited');
  });

  it('a flush with nothing pending is true (no-op contract preserved)', async () => {
    expect(await noteStore.flush('Notes/never-scheduled.md')).toBe(true);
  });

  it('a failed write IPC returns false; the note STAYS unsaved and queued', async () => {
    const relPath = 'Notes/A17fail.md';
    await edited(relPath);
    vault.failNextWrite(relPath, 'EACCES');

    expect(await noteStore.flush(relPath)).toBe(false);
    expect(noteStore.get(relPath)?.hasUnsavedBody).toBe(true);
    expect(noteStore.hasPendingWrites(relPath)).toBe(true);
    expect(isPathPending(relPath)).toBe(true);
    expect(vault.read(relPath)).toBe('---\ntitle: T\n---\norig');
  });

  it('a note deleted under the edit fails, and is never recreated from memory', async () => {
    const relPath = 'Notes/A17gone.md';
    await edited(relPath);
    vault.remove(relPath);

    expect(await noteStore.flush(relPath)).toBe(false);
    expect(vault.read(relPath)).toBeUndefined();
    expect(noteStore.get(relPath)?.hasUnsavedBody).toBe(true);
    expect(isPathPending(relPath)).toBe(true);
  });

  it('a failure followed by a successful flush returns to true (no sticky error)', async () => {
    const relPath = 'Notes/A17heal.md';
    await edited(relPath);

    vault.failNextWrite(relPath, 'EACCES');
    expect(await noteStore.flush(relPath)).toBe(false);

    noteStore.setBody(relPath, 'edited again', VIEW);
    expect(await noteStore.flush(relPath)).toBe(true);
    expect(noteStore.get(relPath)?.hasUnsavedBody).toBe(false);
    expect(isPathPending(relPath)).toBe(false);
    expect(vault.read(relPath)).toContain('edited again');
  });
});

// ── 2.2 — atomicWriteFile preserves the tmp on EPERM/EBUSY exhaustion ──

describe('Audit-17 2.2 — atomicWriteFile preserves the fsynced tmp on EPERM/EBUSY exhaustion', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'filo-a17-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  for (const code of ['EPERM', 'EBUSY'] as const) {
    it(`preserves the .tmp sibling and names it in the error message on ${code}`, async () => {
      const target = join(dir, 'note.md');
      await fs.writeFile(target, 'existing', 'utf-8');

      vi.spyOn(fs, 'rename').mockImplementation(async () => {
        const err: NodeJS.ErrnoException = new Error(`${code}: operation not permitted`);
        err.code = code;
        throw err;
      });

      let captured: unknown;
      try {
        await atomicWriteFile(target, 'staged content');
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeDefined();

      // Pre-fix the post-exhaustion cleanup unlinked the tmp under a comment
      // claiming it held "nothing valuable" — false: it is fully written and
      // fsynced; on a quit-time flush these are the user's last bytes.
      const preserved = (captured as { preservedTmpPath?: string }).preservedTmpPath;
      expect(typeof preserved).toBe('string');
      const entries = await fs.readdir(dir);
      const tmpEntries = entries.filter((n) => n.endsWith('.tmp'));
      expect(tmpEntries.length).toBe(1);
      await expect(fs.readFile(join(dir, tmpEntries[0]), 'utf-8')).resolves.toBe('staged content');

      // The M5 toast path regex-parses `(data preserved at <path>.tmp)` from
      // the MESSAGE (the custom property doesn't survive IPC marshalling) —
      // assert the annotation rides for these codes too.
      const message = (captured as { message?: string }).message ?? '';
      expect(message).toMatch(/data preserved at .+\.tmp\)/);

      // The original destination is unchanged.
      await expect(fs.readFile(target, 'utf-8')).resolves.toBe('existing');
    });
  }
});

// ── 2.3 / 2.4 — board scheduler pre-write ENOENT re-stat + no-handler drift abort ──

type InvokeRecord = { channel: string; args: unknown[] };

function makeCachedBoard(): BoardFileData {
  return {
    board: {
      id: 'b',
      type: 'mindmap',
      name: 'B',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      placements: {},
      inlineTiles: {},
      waypoints: [],
    },
    tileDefs: {},
    connections: {},
    frames: [],
  } as unknown as BoardFileData;
}

/**
 * Installs a window.filo stub whose `vault:stat` answers are dequeued from
 * `statQueue` (one per call; the last entry repeats once exhausted).
 */
function installBoardDiskStub(
  calls: InvokeRecord[],
  statQueue: Array<{ success: boolean; code?: string; mtimeMs?: number; size?: number }>,
): void {
  installFiloMock((channel: string, ...args: unknown[]) => {
    calls.push({ channel, args });
    if (channel === 'vault:stat') {
      return statQueue.length > 1 ? statQueue.shift() : statQueue[0];
    }
    if (channel === 'board:save') return { success: true };
    return { success: true };
  });
}

describe('Audit-17 2.3 — board pre-write ENOENT re-stats once instead of silent success', () => {
  let calls: InvokeRecord[];

  beforeEach(() => {
    calls = [];
    __resetBaselinesForTests();
    __resetDirtyTrackingForTests();
  });

  afterEach(() => {
    setBoardExternalEditHandler(null);
    setWriteErrorListener(null);
    __resetBaselinesForTests();
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
  });

  it('unlink→recreate blip with foreign bytes → drift prompt (the write is held), NOT silent success', async () => {
    // The board was known on disk (baseline) …
    noteBaseline('b.board.json', 1000, 200);
    // … then the pre-write stat sees ENOENT (blip), and the re-stat sees a
    // recreated file whose mtime/size differ from the baseline.
    installBoardDiskStub(calls, [
      { success: false, code: 'ENOENT' },
      { success: true, mtimeMs: 2000, size: 50 },
    ]);

    let promptedPath: string | null = null;
    setBoardExternalEditHandler(async (path) => {
      promptedPath = path;
      return 'defer';
    });

    // Pre-fix: bare `return` → resolved as SUCCESS, debounce window's board
    // mutations silently dropped. Post-fix: the reappeared file falls through
    // to the drift check → handler prompts, and the write is held for the answer.
    await expect(writeBoardFile('/v', 'b.board.json', makeCachedBoard())).rejects.toMatchObject({
      code: 'BOARD_DRIFT_HELD',
    });
    releaseBoardDrift('b.board.json');
    expect(promptedPath).toBe('b.board.json');
    expect(calls.filter((c) => c.channel === 'board:save').length).toBe(0);
  });

  it('unlink→recreate blip with matching stat → write proceeds normally', async () => {
    noteBaseline('b.board.json', 1000, 200);
    installBoardDiskStub(calls, [
      { success: false, code: 'ENOENT' },
      { success: true, mtimeMs: 1000, size: 200 }, // re-stat matches the baseline → no drift
      { success: true, mtimeMs: 1001, size: 200 }, // post-write baseline stat
    ]);
    setBoardExternalEditHandler(async () => {
      throw new Error('drift handler must not fire when the reappeared stat matches the baseline');
    });

    await expect(writeBoardFile('/v', 'b.board.json', makeCachedBoard())).resolves.toBeUndefined();
    expect(calls.filter((c) => c.channel === 'board:save').length).toBe(1);
  });

  it('still missing on the re-stat → genuine-delete semantics preserved (clean no-op, no save)', async () => {
    noteBaseline('b.board.json', 1000, 200);
    installBoardDiskStub(calls, [{ success: false, code: 'ENOENT' }]);

    await expect(writeBoardFile('/v', 'b.board.json', makeCachedBoard())).resolves.toBeUndefined();
    // Exactly two stats — the original + the single re-stat — and no save.
    expect(calls.filter((c) => c.channel === 'vault:stat').length).toBe(2);
    expect(calls.filter((c) => c.channel === 'board:save').length).toBe(0);
  });
});

describe('Audit-17 2.4 — drift with NO registered handler aborts loudly instead of keep-local', () => {
  let calls: InvokeRecord[];

  beforeEach(() => {
    calls = [];
    __resetBaselinesForTests();
    __resetDirtyTrackingForTests();
    setBoardExternalEditHandler(null);
  });

  afterEach(() => {
    setBoardExternalEditHandler(null);
    setWriteErrorListener(null);
    __resetBaselinesForTests();
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
  });

  it('no handler + drifted baseline → abort + notifyWriteError, external edit NOT overwritten', async () => {
    noteBaseline('b.board.json', 1000, 200);
    // Stat reports a drifted file (external edit landed since the baseline).
    installBoardDiskStub(calls, [{ success: true, mtimeMs: 5000, size: 999 }]);

    const errors: WriteErrorInfo[] = [];
    setWriteErrorListener((info) => {
      errors.push(info);
    });

    // Pre-fix: `handler ? … : 'keep-local'` fell through and board:save
    // overwrote the external edit silently.
    await expect(writeBoardFile('/v', 'b.board.json', makeCachedBoard())).rejects.toMatchObject({
      code: 'EXTERNAL_EDIT',
    });
    expect(calls.filter((c) => c.channel === 'board:save').length).toBe(0);
    expect(errors.length).toBe(1);
    expect(errors[0].kind).toBe('board');
    expect(errors[0].path).toBe('b.board.json');
  });
});

// ── 2.5 — toast-action failures reach the errorBus; 6.3 handlers re-read FIRST ──

describe('Audit-17 2.5 — invokeToastAction routes action failures through the errorBus', () => {
  let reported: ReportedError[];
  let unsubscribe: (() => void) | null = null;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(() => {
    reported = [];
    // reportError keeps its console.error breadcrumb — silence it so the
    // strict runner's stderr stays clean for the deliberate failures below.
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    unsubscribe = onError((e) => {
      reported.push(e);
    });
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id);
  });

  afterEach(() => {
    unsubscribe?.();
    __resetErrorBusForTests();
    consoleErrorSpy?.mockRestore();
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id);
  });

  it('an async action rejection becomes an errorBus event (was console-only)', async () => {
    const id = uiStore.pushToast({
      text: 'conflict',
      type: 'warning',
      duration: 0,
      actions: [
        {
          label: 'Apply anyway',
          handler: async () => {
            throw new Error('write blew up');
          },
        },
      ],
    });

    uiStore.invokeToastAction(id, 0);
    // The rejection is caught asynchronously — let the microtask settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(reported.length).toBe(1);
    expect(reported[0].context).toBe('toast.action');
    expect(reported[0].message).toContain('Apply anyway');
  });

  it('a synchronous action throw becomes an errorBus event', () => {
    const id = uiStore.pushToast({
      text: 'conflict',
      type: 'warning',
      duration: 0,
      actions: [
        {
          label: 'Reload',
          handler: () => {
            throw new Error('sync boom');
          },
        },
      ],
    });

    uiStore.invokeToastAction(id, 0);

    expect(reported.length).toBe(1);
    expect(reported[0].context).toBe('toast.action');
  });
});

describe('Audit-17 2.5 — a conflict Reload re-reads FIRST (no destructive prefix on failure)', () => {
  let vault: MemoryVault;

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    noteStore.__resetForTests();
    const noop = (): void => undefined;
    setNotePromptHandlers({ conflict: noop, deletedWithUnsavedBody: noop, writeTargetMissing: noop, reloadShrank: noop, reloadedOverTyping: noop, confirmReloadWithoutCopy: async () => false, dismiss: noop });
    vault = installMemoryVault({ 'Card.md': '---\ncompleted: false\n---\nBody\n' });
  });

  afterEach(() => {
    noteStore.__resetForTests();
    __resetDirtyTrackingForTests();
    vaultStore.setPath('');
    restoreFiloDefault();
  });

  it('a failing click-time re-read leaves the unsaved edit and its queued write intact', async () => {
    const m = noteStore.acquire('Card.md', 'text-tile:card');
    await m.loaded;
    noteStore.setBody('Card.md', 'Mine', 'text-tile:card');
    vault.writeExternally('Card.md', '---\ncompleted: false\n---\nTheirs\n');
    await noteStore.onDiskChanged('Card.md');
    expect(m.status).toBe('conflict');

    // The click-time disk re-read fails (transient IO).
    const invoke = window.filo.invoke;
    window.filo.invoke = (async (channel: string, ...args: unknown[]) => {
      if (channel === 'vault:read-file-text') return { success: false, code: 'EIO', error: 'EIO' };
      return (invoke as (c: string, ...a: unknown[]) => Promise<unknown>)(channel, ...args);
    }) as typeof window.filo.invoke;

    await expect(noteStore.resolveConflict('Card.md', 'reload')).rejects.toThrow();
    // Nothing destructive ran: the edit is still there and still queued.
    expect(m.body).toBe('Mine');
    expect(m.hasUnsavedBody).toBe(true);
    expect(noteStore.hasPendingWrites('Card.md')).toBe(true);
    noteStore.release('Card.md', 'text-tile:card');
  });
});

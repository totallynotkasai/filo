import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { atomicWriteFile } from '../../main/vault/filenameUtils';
import {
  scheduleMarkdownWrite,
  flushMarkdownWrite,
  markHydrated,
  __resetMarkdownFileWriterForTests,
  type WriteArgs,
} from '@renderer/lib/vault/markdownFileWriter';
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
  hasPendingWrite,
  __resetDirtyTrackingForTests,
  type WriteErrorInfo,
} from '@renderer/lib/boards/writeStateTracking';
import { scheduleFrontmatterWrite } from '@renderer/lib/boards/frontmatterWriteScheduler';
import {
  markPropertiesPopupDirty,
  getDirtyInstancesForPath,
} from '@renderer/lib/vault/propertiesPopupTracker';
import { documentStore } from '@renderer/stores/document.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import {
  promptMarkdownPendingWriteConflict,
  promptPropertiesPopupModified,
} from '@renderer/stores/vaultExternalPrompts';
import type { FileMetadata } from '@renderer/lib/vault/vaultIndex';
import { onError, __resetErrorBusForTests, type ReportedError } from '@renderer/lib/utils/errorBus';
import { IpcEnvelopeError } from '@shared/ipcEnvelope';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Audit-17 Phase 2 — the "failure reported as success" error-honesty cluster.
 *
 *  2.1 `flushMarkdownWrite` could never reject (the scheduler primitive's
 *      `fireWrite` resolves failures as failure-id lists), so the component
 *      callers' catch blocks were dead code: DocumentEditor markClean'd a
 *      dirty doc on a FAILED flush and its ENOENT → backingFileMissing
 *      degraded mode was unreachable; PropertiesPopup cleared its dirty flag
 *      on a failed flush. Fix: `flushMarkdownWrite` returns `{ ok, error }`
 *      and the components branch on it.
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
 *      console; the 6.3 Reload handlers ran destructive synchronous prefixes
 *      (write cancels) BEFORE their awaited re-read, so a failing re-read
 *      left the user's pending edit cancelled with nothing applied. Fix:
 *      failures route through reportError (errorBus), and the handlers
 *      re-read FIRST with the destructive work in the synchronous tail.
 */

// ── 2.1 — flushMarkdownWrite failure honesty (gateway contract) ──

describe('Audit-17 2.1 — flushMarkdownWrite reports failure instead of resolving as success', () => {
  /** Per-channel override for the next write IPC: null = succeed. */
  let writeFailureCode: string | null;

  function bodyWriteArgs(relPath: string, body: string): WriteArgs {
    return {
      vaultRoot: '/vault',
      relPath,
      frontmatter: documentStore.getFrontmatter(relPath) ?? {},
      body,
      callerId: `text-tile:${relPath}`,
      notePath: relPath,
    };
  }

  function loadDoc(relPath: string): void {
    documentStore.loadDocument({
      filename: relPath,
      title: 'T',
      body: 'orig',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter(relPath, { title: 'T' }, 'title: T');
    markHydrated(relPath, false);
  }

  beforeEach(() => {
    writeFailureCode = null;
    __resetDirtyTrackingForTests();
    __resetMarkdownFileWriterForTests();
    __resetBaselinesForTests();
    documentStore.clear();
    installFiloMock((channel: string) => {
      // Only the gateway's body write (no-create channel) fails; the dirty
      // sentinel's `vault:write-file-text` keeps succeeding so the deliberate
      // failures below don't spray sentinel-write stderr noise.
      if (channel === 'vault:write-existing-file-text') {
        if (writeFailureCode) return { success: false, code: writeFailureCode };
        return { success: true };
      }
      if (channel === 'vault:read-file-text') {
        return { success: true, content: '---\ntitle: T\n---\norig', mtimeMs: 1, size: 10 };
      }
      if (channel === 'vault:stat') return { success: true, mtimeMs: 1, size: 10 };
      return { success: true };
    });
  });

  afterEach(() => {
    __resetMarkdownFileWriterForTests();
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
    documentStore.clear();
    restoreFiloDefault();
  });

  it('a successful flush returns ok:true and the writer goes clean', async () => {
    const relPath = 'Notes/A17ok.md';
    const callerId = `text-tile:${relPath}`;
    loadDoc(relPath);
    documentStore.updateContent(relPath, '<p>x</p>', 'edited', callerId);

    scheduleMarkdownWrite(bodyWriteArgs(relPath, 'edited'));
    const result = await flushMarkdownWrite(callerId);

    expect(result.ok).toBe(true);
    expect(documentStore.isWriterDirty(relPath, callerId)).toBe(false);
    expect(documentStore.getDocument(relPath)?.isDirty).toBe(false);
  });

  it('a flush with nothing pending is ok:true (no-op contract preserved)', async () => {
    const result = await flushMarkdownWrite('text-tile:never-scheduled');
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('a failed write IPC returns ok:false with the concrete error; the doc STAYS dirty', async () => {
    const relPath = 'Notes/A17fail.md';
    const callerId = `text-tile:${relPath}`;
    loadDoc(relPath);
    documentStore.updateContent(relPath, '<p>x</p>', 'edited', callerId);
    writeFailureCode = 'EACCES';

    scheduleMarkdownWrite(bodyWriteArgs(relPath, 'edited'));
    const result = await flushMarkdownWrite(callerId);

    // Pre-fix this resolved as plain success and DocumentEditor markClean'd
    // unconditionally — "saved" reported for bytes that never landed.
    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(IpcEnvelopeError);
    expect((result.error as IpcEnvelopeError).code).toBe('EACCES');
    // The gateway's success-path markClean never ran.
    expect(documentStore.isWriterDirty(relPath, callerId)).toBe(true);
    expect(documentStore.getDocument(relPath)?.isDirty).toBe(true);
  });

  it('an ENOENT failure surfaces code ENOENT — the components’ degraded-mode trigger', async () => {
    const relPath = 'Notes/A17gone.md';
    const callerId = `text-tile:${relPath}`;
    loadDoc(relPath);
    documentStore.updateContent(relPath, '<p>x</p>', 'edited', callerId);
    writeFailureCode = 'ENOENT';

    scheduleMarkdownWrite(bodyWriteArgs(relPath, 'edited'));
    const result = await flushMarkdownWrite(callerId);

    // This is the exact branch DocumentEditor / PropertiesPopup use to flip
    // `backingFileMissing` (degraded mode). Pre-fix it was unreachable: the
    // flush resolved as success and the editor kept issuing failing rewrites.
    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(IpcEnvelopeError);
    expect((result.error as IpcEnvelopeError).code).toBe('ENOENT');
    expect(documentStore.getDocument(relPath)?.isDirty).toBe(true);
  });

  it('a failure followed by a successful flush returns to ok:true (no sticky error)', async () => {
    const relPath = 'Notes/A17heal.md';
    const callerId = `text-tile:${relPath}`;
    loadDoc(relPath);
    documentStore.updateContent(relPath, '<p>x</p>', 'edited', callerId);

    writeFailureCode = 'EACCES';
    scheduleMarkdownWrite(bodyWriteArgs(relPath, 'edited'));
    expect((await flushMarkdownWrite(callerId)).ok).toBe(false);

    writeFailureCode = null;
    scheduleMarkdownWrite(bodyWriteArgs(relPath, 'edited again'));
    const result = await flushMarkdownWrite(callerId);
    expect(result.ok).toBe(true);
    expect(documentStore.isWriterDirty(relPath, callerId)).toBe(false);
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

function makeCachedBoard(): V7BoardFileData {
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
  } as unknown as V7BoardFileData;
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

  it('unlink→recreate blip with foreign bytes → drift prompt (defer aborts), NOT silent success', async () => {
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
    // to the drift check → handler prompts → 'defer' aborts loudly.
    await expect(writeBoardFile('/v', 'b.board.json', makeCachedBoard())).rejects.toMatchObject({
      code: 'EXTERNAL_EDIT',
    });
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

describe('Audit-17 2.5 — 6.3 Reload handlers re-read FIRST (no destructive prefix on failure)', () => {
  const nextMeta = {
    path: 'Card.md',
    title: 'Card',
    headings: [],
    tags: [],
    frontmatter: { completed: false },
    links: [],
    content: 'Body',
    lastModified: 2000,
    rawFrontmatter: 'completed: false',
    rawByteSize: 40,
  } as unknown as FileMetadata;

  beforeEach(() => {
    __resetDirtyTrackingForTests(); // also resets the frontmatter scheduler
    documentStore.clear();
    vaultIndexStore.clear();
    vaultStore.setPath('/vault');
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id);
    installFiloMock(() => ({ success: true }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __resetDirtyTrackingForTests();
    vaultStore.setPath('');
    documentStore.clear();
    vaultIndexStore.clear();
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id);
    restoreFiloDefault();
  });

  it('pending-write-conflict Reload: failing re-read leaves the armed FM write intact', async () => {
    // A path-keyed field edit armed a frontmatter write (no open editor).
    documentStore.setFrontmatter('Card.md', { completed: true });
    scheduleFrontmatterWrite('Card.md', 'Card.md');
    expect(hasPendingWrite('Card.md')).toBe(true);

    promptMarkdownPendingWriteConflict('Card.md', nextMeta, null);
    const toast = uiStore.toasts.find((t) => t.text.includes('modified externally'));
    expect(toast).toBeDefined();

    // The click-time disk re-read fails (transient IO).
    vi.spyOn(vaultIndexStore, 'applyChanges').mockRejectedValue(new Error('re-read failed'));

    // Pre-fix the handler ran `cancelFrontmatterWrite(rel)` BEFORE the await:
    // the rejection left the user's pending edit cancelled AND the reload
    // never applied — both sides lost. Post-fix nothing destructive ran.
    await expect(toast!.actions![0].handler()).rejects.toThrow('re-read failed');
    expect(hasPendingWrite('Card.md')).toBe(true);
  });

  it('properties-popup Reload: failing re-read keeps the popup dirty tracking + armed write', async () => {
    documentStore.loadDocument({
      filename: 'Card.md',
      title: 'Card',
      body: 'Body',
      htmlContent: '',
      richText: [],
    });
    const editorDoc = documentStore.getDocument('Card.md')!;
    const flusherId = 'properties-popup:tile-1';
    markPropertiesPopupDirty(flusherId, 'Card.md');
    expect(getDirtyInstancesForPath('Card.md')).toContain(flusherId);

    promptPropertiesPopupModified('Card.md', nextMeta, editorDoc);
    const toast = uiStore.toasts.find((t) => t.text.includes('Properties of'));
    expect(toast).toBeDefined();

    vi.spyOn(vaultIndexStore, 'applyChanges').mockRejectedValue(new Error('re-read failed'));

    // Pre-fix the handler cancelled the popup's gateway writes and CLEARED the
    // dirty tracker before the await — a failing re-read silently dropped the
    // popup's conflict routing. Post-fix the tracker entry survives.
    await expect(toast!.actions![0].handler()).rejects.toThrow('re-read failed');
    expect(getDirtyInstancesForPath('Card.md')).toContain(flusherId);
  });
});

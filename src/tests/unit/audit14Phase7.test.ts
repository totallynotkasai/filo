import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DeleteTaskCommand } from '@renderer/commands/taskCommands';
import { documentStore } from '@renderer/stores/document.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { markHydrated, cancelAllMarkdownWrites } from '@renderer/lib/vault/markdownFileWriter';
import { __resetDirtyTrackingForTests, trackComponentWrite } from '@renderer/lib/boards/writeStateTracking';
import {
  checkRecovery,
  __resetDirtyRecoveryDedupeForTests,
} from '@renderer/lib/vault/dirtyFlagRecovery';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { TaskListBoard, TileDefinition } from '@renderer/schema/index';

/**
 * Audit-14 Phase 7 — test & CI safety-net.
 *
 * 7.1 — quit-with-pending-write + crash-recovery (the highest-consequence flow):
 *       an edit arms a write, the app is killed before it lands, and on relaunch
 *       the `.filo/.dirty` recovery sentinel must still name the unsaved path.
 *       This is the cadence-independent integration counterpart to the
 *       (nightly-only) kill+relaunch E2E.
 *
 * 7.3 — DeleteTaskCommand.undo reconciles a Document still open on the restored
 *       task `.md` (the task twin of the 2.3 DeleteTilesCommand fix). The
 *       file-level RECONCILE_EXEMPT for `taskCommands.ts` was removed in 7.3, so
 *       the snapshot-restore write must route through `writeMarkdownAndReconcile`
 *       — otherwise a Document open on a second pane keeps its stale frontmatter
 *       cache and its next debounced body save silently inverts the restore (#4).
 */

function makeTaskListWithTask(boardId: string, tileId: string, filePath: string): V7BoardFileData {
  return {
    board: {
      id: boardId,
      type: 'tasklist',
      name: boardId,
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      tasks: [{ tileId, position: 0 }],
      sections: [],
    } as unknown as TaskListBoard,
    tileDefs: {
      [tileId]: {
        id: tileId,
        type: 'text',
        title: 'Buy milk',
        contentId: `doc_${tileId}`,
        style: { headerColor: '', bodyColor: '', borderColor: '' } as never,
        boardId,
        position: { x: 0, y: 0 },
        size: { width: 200, height: 100 },
        tags: [],
        createdAt: 0,
        updatedAt: 0,
        locked: false,
        faded: false,
        filePath,
      } as unknown as TileDefinition,
    },
    connections: {},
    frames: [],
  };
}

describe('Audit-14 7.3 — DeleteTaskCommand.undo reconciles open editors', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultStore.setPath('/vault');
  });
  afterEach(() => {
    cancelAllMarkdownWrites();
    __resetDirtyTrackingForTests();
    documentStore.clear();
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultStore.setPath('');
    restoreFiloDefault();
  });

  it('reloads a Document open on the restored task .md so its next save cannot invert the restore', async () => {
    const relPath = 'Tasks/Buy milk.md';
    const restoredBytes = '---\ncompleted: false\npriority: high\n---\nbuy milk\n';
    const writtenPaths = new Set<string>();
    installFiloMock((channel: string, ...args: unknown[]) => {
      if (channel === 'vault:delete') return { success: true };
      if (channel === 'vault:write-file-text') {
        writtenPaths.add(args[1] as string);
        return { success: true, path: `${args[0]}/${args[1]}` };
      }
      if (channel === 'vault:file-exists') return writtenPaths.has(args[1] as string);
      if (channel === 'vault:stat') return { ok: true, mtimeMs: 1, size: 1 };
      return { ok: true, success: true };
    });

    // The task lives on a Task List board…
    const fixture = makeTaskListWithTask('board-tl', 't_1', relPath);
    boardCacheStore.hydrate({ 'board-tl': fixture }, { 'board-tl': 'board-tl.board.json' });

    // …and the SAME file is open as a Document on a second pane, holding a stale
    // pre-delete in-memory body + frontmatter.
    const docId = 'doc-7-3';
    documentStore.loadDocument({
      docId,
      filename: relPath,
      title: 'Buy milk',
      body: 'stale pre-delete body',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter(docId, { completed: true }, '---\ncompleted: true\n---');
    markHydrated(relPath, false);

    const cmd = new DeleteTaskCommand('board-tl', 't_1', {
      vaultRoot: '/vault',
      fileSnapshot: { rel: relPath, content: restoredBytes },
    });
    await cmd.execute();
    await cmd.lastExecuteCompletion;

    await cmd.undo();
    await cmd.lastUndoCompletion;

    // 7.3 — the open editor reflects the restored bytes. Under a raw write it
    // would stay pinned to the stale body, and its next debounced save would
    // invert the restore (#4).
    expect(documentStore.getDocument(docId)?.body).toBe('buy milk\n');
    expect(documentStore.getFrontmatter(docId)).toEqual({ completed: false, priority: 'high' });

    // The task placement was also restored (full undo round-trip).
    const tasks = (boardCacheStore.cache['board-tl']?.board as TaskListBoard).tasks ?? [];
    expect(tasks.some((t) => t.tileId === 't_1')).toBe(true);
  });
});

// ── 7.1 — quit-with-pending-write keeps the recovery breadcrumb ──────────────

/**
 * Ties the REAL write lifecycle (`trackComponentWrite` → `beginWrite` →
 * `markDirty`) to the REAL recovery read (`checkRecovery`) through a `.filo/.dirty`
 * sentinel persisted on a mock "disk", so a hard quit mid-write leaves a
 * breadcrumb naming the unsaved path rather than losing the edit silently. This
 * is the unit/integration version the plan asks for explicitly because the full
 * kill+relaunch E2E runs only on the nightly cadence.
 */
describe('Audit-14 7.1 — quit-with-pending-write recovery breadcrumb', () => {
  function installSentinelDisk(): { sentinel: string | null } {
    // A mock disk that persists ONLY the `.filo/.dirty` sentinel across the
    // "relaunch" (write captures it, read serves it, delete clears it).
    const disk: { sentinel: string | null } = { sentinel: null };
    installFiloMock((channel: string, ...args: unknown[]) => {
      const rel = String(args[1] ?? '');
      if (channel === 'vault:write-file-text' && rel === '.filo/.dirty') {
        disk.sentinel = args[2] as string;
        return { success: true };
      }
      if (channel === 'vault:read-file-text' && rel.endsWith('.filo/.dirty')) {
        return disk.sentinel === null
          ? { success: false, code: 'ENOENT' }
          : { success: true, content: disk.sentinel };
      }
      if (channel === 'vault:delete' && rel.endsWith('.filo/.dirty')) {
        disk.sentinel = null;
        return { success: true };
      }
      return { success: true };
    });
    return disk;
  }

  function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
    const started = Date.now();
    return new Promise<void>((resolve, reject) => {
      const tick = (): void => {
        if (cond()) return resolve();
        if (Date.now() - started > timeoutMs) return reject(new Error('waitFor: condition never became true'));
        setTimeout(tick, 2);
      };
      tick();
    });
  }

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    __resetDirtyRecoveryDedupeForTests();
  });
  afterEach(() => {
    __resetDirtyTrackingForTests();
    __resetDirtyRecoveryDedupeForTests();
    restoreFiloDefault();
  });

  it('a write that never completes arms the sentinel with its path BEFORE it lands', async () => {
    const disk = installSentinelDisk();
    // The app is killed mid-write: the write op never resolves, so endWrite
    // (and markClean) never fire. `beginWrite` already wrote the sentinel.
    void trackComponentWrite('/vault', 'Notes.md', () => new Promise<void>(() => {}), { notifyOnError: false });

    await waitFor(() => disk.sentinel !== null);
    const body = JSON.parse(disk.sentinel as string);
    // write-tracking canonicalises the path (case-folded on a case-insensitive
    // FS), so match the unsaved file case-insensitively.
    expect((body.pendingPaths as string[]).some((p) => p.toLowerCase() === 'notes.md')).toBe(true);
  });

  it('on relaunch, checkRecovery surfaces the unsaved path from the prior session', async () => {
    const disk = installSentinelDisk();
    void trackComponentWrite('/vault', 'Notes.md', () => new Promise<void>(() => {}), { notifyOnError: false });
    await waitFor(() => disk.sentinel !== null);

    // Relaunch = a NEW process: the surviving sentinel was written by the
    // (now-crashed) PRIOR launch, so stamp it with a prior launchId —
    // checkRecovery deliberately SUPPRESSES a sentinel from the CURRENT launch
    // (the 1.3 false-positive guard), which a same-process read would otherwise hit.
    const payload = JSON.parse(disk.sentinel as string);
    payload.launchId = 'prior-crashed-session';
    disk.sentinel = JSON.stringify(payload);

    const status = await checkRecovery('/vault');
    expect(status.needsRecovery).toBe(true);
    expect((status.pendingPaths ?? []).some((p) => p.toLowerCase() === 'notes.md')).toBe(true);
  });

  it('a write that COMPLETES clears the sentinel — no false recovery prompt next launch', async () => {
    const disk = installSentinelDisk();
    let resolveWrite!: () => void;
    void trackComponentWrite(
      '/vault',
      'Notes.md',
      () => new Promise<void>((res) => { resolveWrite = res; }),
      { notifyOnError: false },
    );
    await waitFor(() => disk.sentinel !== null); // dirty while the write is pending

    resolveWrite();
    await waitFor(() => disk.sentinel === null); // endWrite (success + idle) → markClean

    const status = await checkRecovery('/vault');
    expect(status.needsRecovery).toBe(false);
  });
});

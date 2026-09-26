import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { __runRecoverySequencerForTests, vaultStore } from '@renderer/stores/vault.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { fileTagsStore } from '@renderer/stores/fileTags.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/boardSaver';
import { __resetRenameCascadeSentinelForTests } from '@renderer/lib/vault/renameCascadeSentinel';
import { ownSentinelPath } from '@renderer/lib/vault/machineIdentity';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard } from '@renderer/schema/index';

/**
 * Phase 4.4 / 4.5 (2026-05-30) — rename-cascade recovery sentinel handlers.
 *
 * 4.4: the Retry handler must repair board JSON + tags.json AND move an open
 *      note to the new path, like the normal rename path; a note already open
 *      when an in-session retry fires would otherwise keep writing to the
 *      OLD path.
 * 4.5: the Discard handler just cleared the breadcrumb — leaving any board
 *      whose flush had failed pointing at the old path with no repair.
 *
 * The sequencer is private; `__runRecoverySequencerForTests` drives it past
 * recovery steps 1 (.dirty) and 2 (tag-rewrite), which no-op here (their
 * sentinel reads return ENOENT), straight to step 3 (rename-cascade).
 */

// This machine's own sentinel (the test setup pins the machine id).
const sentinel = (): string => ownSentinelPath('rename-cascade');

function sentinelJson(oldPath: string, newPath: string): string {
  return JSON.stringify({
    entries: [
      { id: 'r1', timestamp: 1, oldPath, newPath, affectedBoardIds: [] },
    ],
  });
}

async function fireDialog(which: 'confirm' | 'cancel'): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (uiStore.confirmDialog) {
      const cfg = uiStore.confirmDialog;
      uiStore.closeConfirm();
      if (which === 'confirm') cfg.onConfirm(false);
      else cfg.onCancel?.();
      return;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('recovery confirm dialog never appeared');
}

async function waitFor(pred: () => boolean): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return pred();
}

/** A board carrying a single file-ref tile def that propagateRename rewrites. */
function boardWithFileRef(boardId: string, filePath: string): BoardFileData {
  return {
    board: {
      id: boardId,
      type: 'mindmap',
      name: boardId,
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      placements: {},
      inlineTiles: {},
      waypoints: [],
    } as unknown as MindMapBoard,
    tileDefs: {
      t1: {
        id: 't1',
        type: 'file',
        title: 'F',
        filePath,
        style: {},
        createdAt: 0,
        updatedAt: 0,
      } as never,
    },
    connections: {},
    frames: [],
  };
}

function resetAll(): void {
  __resetDirtyTrackingForTests();
  __resetRenameCascadeSentinelForTests();
  noteStore.__resetForTests();
  vaultIndexStore.clear();
  boardCacheStore.clear();
  boardStore.clearBoard();
  fileTagsStore.reset();
  uiStore.closeConfirm();
  for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id);
}

describe('rename-cascade recovery — Retry repoints open notes', () => {
  /** Where the note's file is on disk; the rename already happened before the crash. */
  let notePathOnDisk: string;
  let noteWrites: string[];
  let deletes: string[];

  beforeEach(() => {
    resetAll();
    vaultStore.setPath('/vault');
    notePathOnDisk = 'Notes/old.md';
    noteWrites = [];
    deletes = [];
    installFiloMock((channel: string, ...args: unknown[]) => {
      if (channel === 'vault:read-file-text') {
        const p = String(args[1]);
        if (p === sentinel()) {
          return { success: true, content: sentinelJson('Notes/old.md', 'Notes/new.md') };
        }
        if (p === notePathOnDisk) {
          return { success: true, content: '---\ntitle: old\n---\nbody\n', mtimeMs: 1, size: 25 };
        }
        return { success: false, code: 'ENOENT' };
      }
      if (channel === 'vault:stat') {
        return String(args[1]) === notePathOnDisk ? { success: true, mtimeMs: 1, size: 25 } : { success: false, code: 'ENOENT' };
      }
      if (channel === 'vault:file-exists') return String(args[1]) === notePathOnDisk;
      if (channel === 'vault:delete') deletes.push(String(args[1]));
      if (channel === 'vault:write-existing-file-text') noteWrites.push(String(args[1]));
      if (channel === 'tags:load') return null;
      if (channel === 'vault:read-tree') return { ok: true, tree: [] };
      return { success: true };
    });
  });

  afterEach(() => {
    restoreFiloDefault();
    resetAll();
    vaultStore.setPath('');
  });

  /** A note open (and loaded) at the old path, whose file has since moved. */
  async function openNoteThenMoveFile(): Promise<void> {
    const m = noteStore.acquire('Notes/old.md', 'doc');
    await m.loaded;
    notePathOnDisk = 'Notes/new.md';
  }

  it('moves an open note from old to new on Retry, and its next write lands on the new file', async () => {
    await openNoteThenMoveFile();

    const seq = __runRecoverySequencerForTests('/vault');
    await fireDialog('confirm');
    await seq;
    await waitFor(() => noteStore.get('Notes/new.md') !== undefined);

    expect(noteStore.get('Notes/new.md')?.relPath).toBe('Notes/new.md');
    expect(noteStore.get('Notes/old.md')).toBeUndefined();

    noteStore.setBody('Notes/new.md', 'edited after the repair', 'doc');
    await noteStore.flush('Notes/new.md');
    expect(noteWrites).toEqual(['Notes/new.md']);
  });

  // Discard means "leave things as they are": it only drops the breadcrumb.
  it('Discard clears the sentinel and changes nothing else', async () => {
    boardCacheStore.hydrate({ b1: boardWithFileRef('b1', 'Notes/old.md') }, { b1: 'b1.board.json' });
    await openNoteThenMoveFile();
    const saves: string[] = [];
    const flushSpy = vi.spyOn(boardCacheStore, 'flushAllDirty').mockImplementation(async () => {
      saves.push('flush');
      return { failed: [] };
    });

    const seq = __runRecoverySequencerForTests('/vault');
    await fireDialog('cancel');
    await seq;
    expect(await waitFor(() => deletes.some((p) => p.includes('rename-cascade-pending.')))).toBe(true);

    const def = boardCacheStore.cache.b1.tileDefs.t1 as unknown as { filePath: string };
    expect(def.filePath).toBe('Notes/old.md');
    expect(noteStore.get('Notes/old.md')).toBeDefined();
    expect(noteStore.get('Notes/new.md')).toBeUndefined();
    expect(saves).toEqual([]);
    flushSpy.mockRestore();
  });

  // Replaying old → new when the disk doesn't show that rename would point
  // boards and open notes at a file that isn't there.
  it('Retry leaves an entry alone when the old path is still on disk', async () => {
    boardCacheStore.hydrate({ b1: boardWithFileRef('b1', 'Notes/old.md') }, { b1: 'b1.board.json' });
    const m = noteStore.acquire('Notes/old.md', 'doc');
    await m.loaded;

    const seq = __runRecoverySequencerForTests('/vault');
    await fireDialog('confirm');
    await seq;

    const def = boardCacheStore.cache.b1.tileDefs.t1 as unknown as { filePath: string };
    expect(def.filePath).toBe('Notes/old.md');
    expect(noteStore.get('Notes/old.md')).toBe(m);
    expect(noteStore.get('Notes/new.md')).toBeUndefined();
  });
});

/**
 * 6.2.H2 — `awaitConfirm` must await the `onConfirm` handler's async work
 * before resolving its outer promise. Pre-fix: `onConfirm: () => void` ran
 * synchronously and resolved immediately, so a `void convergeForward()`
 * inside it fired-and-forgot. The sequencer's next `await awaitConfirm(...)`
 * stage could then race against the still-pumping `renameTagEverywhere` —
 * two recoveries mutating `boardCacheStore.cache` / `flushAllDirty` at once.
 */
describe('recovery sequencer — 6.2.H2: awaitConfirm awaits onConfirm', () => {
  const tagSentinel = (): string => ownSentinelPath('tag-rewrite');

  beforeEach(() => {
    resetAll();
    vaultStore.setPath('/vault');
    installFiloMock((channel: string, ...args: unknown[]) => {
      if (channel === 'vault:read-file-text') {
        const p = String(args[1]);
        if (p === tagSentinel()) {
          return {
            success: true,
            content: JSON.stringify({
              timestamp: 1,
              oldName: 'oldTag',
              newName: 'newTag',
              plan: ['Notes/A.md'],
              preexistingNewNamePaths: [],
              committedPaths: [],
            }),
          };
        }
        return { success: false, code: 'ENOENT' };
      }
      if (channel === 'tags:load') return null;
      if (channel === 'vault:read-tree') return { ok: true, tree: [] };
      return { success: true };
    });
  });

  afterEach(() => {
    restoreFiloDefault();
    resetAll();
    vaultStore.setPath('');
    vi.restoreAllMocks();
  });

  it('Resume awaits convergeForward before the sequencer returns', async () => {
    // Stub `renameTagEverywhere` to return a deferred promise we control.
    // Pre-fix: the sequencer would resolve immediately after firing the
    // dialog because `void convergeForward()` fires-and-forgets; the
    // deferred staying pending would NOT block `await seq`.
    let resolveDeferred!: () => void;
    const deferred = new Promise<{ committed: boolean; writtenPaths: string[] }>((r) => {
      resolveDeferred = () => r({ committed: true, writtenPaths: [] });
    });
    vi.spyOn(fileTagsStore, 'renameTagEverywhere').mockReturnValue(deferred);

    const seq = __runRecoverySequencerForTests('/vault');
    await fireDialog('confirm');

    // Race the sequencer against a short timeout. If H2 is fixed, the
    // sequencer is still awaiting `convergeForward`, so the timeout wins.
    const TIMEOUT = Symbol('timeout');
    const raced = await Promise.race([
      seq.then(() => 'resolved' as const),
      new Promise((r) => setTimeout(() => r(TIMEOUT), 50)),
    ]);
    expect(raced).toBe(TIMEOUT);

    resolveDeferred();
    await seq;
    expect(fileTagsStore.renameTagEverywhere).toHaveBeenCalledWith('oldTag', 'newTag');
  });
});

/**
 * 6.2.H3 — the tag-rewrite step's partial-state detection reads
 * `vaultIndexStore.allMetadata()` — which would return a mid-chunk empty/
 * partial sample if `vaultIndexStore.rebuild()` is still running. Without
 * the `whenBuildComplete()` await, the sequencer could see "no newName
 * carrier" mid-rebuild, decide "not partial", and show the Discard label —
 * users then discarding what was actually a half-committed rename.
 */
describe('recovery sequencer — 6.2.H3: awaits vaultIndex rebuild before metadata sample', () => {
  const tagSentinel = (): string => ownSentinelPath('tag-rewrite');

  beforeEach(() => {
    resetAll();
    vaultStore.setPath('/vault');
    installFiloMock((channel: string, ...args: unknown[]) => {
      if (channel === 'vault:read-file-text') {
        const p = String(args[1]);
        if (p === tagSentinel()) {
          return {
            success: true,
            content: JSON.stringify({
              timestamp: 1,
              oldName: 'oldTag',
              newName: 'newTag',
              plan: ['Notes/A.md'],
              preexistingNewNamePaths: [],
              committedPaths: [],
            }),
          };
        }
        return { success: false, code: 'ENOENT' };
      }
      if (channel === 'tags:load') return null;
      if (channel === 'vault:read-tree') return { ok: true, tree: [] };
      return { success: true };
    });
  });

  afterEach(() => {
    restoreFiloDefault();
    resetAll();
    vaultStore.setPath('');
    vi.restoreAllMocks();
  });

  it('does not sample allMetadata until whenBuildComplete resolves', async () => {
    // Track whether `allMetadata` was called and when.
    const callOrder: string[] = [];
    const realAllMetadata = vaultIndexStore.allMetadata.bind(vaultIndexStore);
    vi.spyOn(vaultIndexStore, 'allMetadata').mockImplementation(() => {
      callOrder.push('allMetadata');
      return realAllMetadata();
    });

    // Stub `whenBuildComplete` to return a deferred so we can observe ordering.
    let resolveBuild!: () => void;
    const buildDone = new Promise<void>((r) => {
      resolveBuild = r;
    });
    vi.spyOn(vaultIndexStore, 'whenBuildComplete').mockImplementation(() => {
      callOrder.push('whenBuildComplete-await');
      return buildDone.then(() => {
        callOrder.push('whenBuildComplete-resolved');
      });
    });

    const seq = __runRecoverySequencerForTests('/vault');

    // Give the sequencer time to reach the build-complete await.
    await new Promise((r) => setTimeout(r, 30));

    // Pre-fix: `allMetadata` would have run already (before the build).
    // Post-fix: only the await is logged, no metadata sample yet.
    expect(callOrder).toEqual(['whenBuildComplete-await']);

    // Resolve the build; the sequencer proceeds to sample metadata, then
    // surfaces the confirm dialog.
    resolveBuild();
    await fireDialog('cancel'); // close the dialog so the sequencer can finish
    await seq;

    expect(callOrder.indexOf('whenBuildComplete-resolved')).toBeGreaterThanOrEqual(0);
    expect(callOrder.indexOf('allMetadata')).toBeGreaterThan(
      callOrder.indexOf('whenBuildComplete-resolved'),
    );
  });
});

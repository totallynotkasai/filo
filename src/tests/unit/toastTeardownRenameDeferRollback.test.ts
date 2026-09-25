import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { uiStore } from '@renderer/stores/ui.svelte';
import { fireVaultSwap } from '@renderer/core/vaultLifecycle';
import { historyStore, type Command } from '@renderer/stores/history.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import {
  beginRenameInFlight,
  endRenameInFlight,
  isRenameInFlight,
  __resetRenameInFlightForTests,
} from '@renderer/lib/vault/renameInFlight';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Audit-18 Phase 2 — the three remaining MEDIUMs (lifecycle / undo / race).
 * None fires on a local SSD vault not edited by other tools; each describe
 * block locks one fix's load-bearing behaviour.
 */

// ── M1 — acknowledge-only recovery toasts survive automatic teardown ─────────
//
// Two crash-recovery breadcrumb toasts (`clearQuitFailureBreadcrumb`,
// `markClean`) carry an onDismiss meaning "the user acknowledged → destroy the
// breadcrumb". The 6.1.R2 pre-swap "fire every onDismiss" change (and the
// TOAST_CAP eviction) used to fire those automatically, deleting the recoverable
// file unread BEFORE the user saw it. `acknowledgeOnly` makes both automatic
// paths skip the onDismiss while genuine user dismissal still clears it.
describe('Audit-18 M1 — acknowledgeOnly toasts are spared by swap/cap teardown', () => {
  beforeEach(() => {
    installFiloMock(() => ({ ok: true, success: true }));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
  });
  afterEach(() => {
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
    restoreFiloDefault();
    vi.restoreAllMocks();
  });

  it('a pre-swap teardown skips an acknowledgeOnly onDismiss but still fires a normal one', async () => {
    const breadcrumb = vi.fn();
    const driftPrompt = vi.fn();
    uiStore.pushToast({
      text: 'unsaved bytes preserved',
      type: 'error',
      duration: 0,
      acknowledgeOnly: true,
      onDismiss: breadcrumb,
    });
    // A promise-backed drift prompt — the 6.1.R2 case that MUST still resolve so
    // its awaiting write isn't stranded across the swap.
    uiStore.pushToast({ text: 'external edit', type: 'warning', duration: 0, onDismiss: driftPrompt });

    await fireVaultSwap({ phase: 'pre-swap', previousVault: '/A', nextVault: '/B', saveOutgoing: false });

    expect(breadcrumb).not.toHaveBeenCalled(); // the on-disk breadcrumb survives the swap
    expect(driftPrompt).toHaveBeenCalledTimes(1); // normal promise-backed toasts still resolve
    expect(uiStore.toasts).toHaveLength(0); // both cleared from the screen
  });

  it('TOAST_CAP eviction evicts an acknowledgeOnly toast SILENTLY (no onDismiss)', () => {
    const spies: Array<ReturnType<typeof vi.fn>> = [];
    // Fill the cap (8) with non-disposable acknowledgeOnly error toasts so the
    // oldest is forced to be the eviction victim when the 9th lands.
    for (let i = 0; i < 8; i++) {
      const spy = vi.fn();
      spies.push(spy);
      uiStore.pushToast({ text: `b${i}`, type: 'error', duration: 0, acknowledgeOnly: true, onDismiss: spy });
    }
    uiStore.pushToast({ text: 'b8', type: 'error', duration: 0, acknowledgeOnly: true, onDismiss: vi.fn() });

    expect(spies[0]).not.toHaveBeenCalled(); // b0 evicted silently — breadcrumb preserved
  });

  it('counter-case: a NORMAL promise-backed toast still fires onDismiss on cap eviction', () => {
    const spies: Array<ReturnType<typeof vi.fn>> = [];
    for (let i = 0; i < 8; i++) {
      const spy = vi.fn();
      spies.push(spy);
      uiStore.pushToast({ text: `e${i}`, type: 'error', duration: 0, onDismiss: spy });
    }
    uiStore.pushToast({ text: 'e8', type: 'error', duration: 0, onDismiss: vi.fn() });

    // Audit5 R3: when every queued toast is promise-backed, the cap evicts the
    // oldest AND fires its onDismiss so its awaiter resolves. Only acknowledgeOnly
    // toasts are exempt.
    expect(spies[0]).toHaveBeenCalledTimes(1);
  });
});

// ── M2 — refreshTreeAndCleanup defers eviction while a rename is in flight ────
//
// `runRename` rebinds boardStore.paths[boardId] to the NEW (not-yet-on-disk)
// path before the rename IPC lands. A concurrent watcher reconcile would see
// that path missing on disk and evict the LIVE board. The fix defers eviction
// while `isRenameInFlight()` (or the cached path was rebound since we sampled).
describe('Audit-18 M2 — rename-in-flight defers board eviction', () => {
  function makeBoard(boardId: string): Record<string, unknown> {
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
      },
      tileDefs: {},
      connections: {},
      frames: [],
    };
  }

  beforeEach(() => {
    __resetRenameInFlightForTests();
    boardCacheStore.clear();
    vaultStore.setPath('/vault');
    vaultStore.setTree([]);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    __resetRenameInFlightForTests();
    restoreFiloDefault();
    boardCacheStore.clear();
    vaultStore.setPath('');
    vaultStore.setTree([]);
    vi.restoreAllMocks();
  });

  it('does NOT evict a board missing on disk while a rename is in flight', async () => {
    // The board's cache path was just rebound to the new name; the rename IPC
    // hasn't landed, so the file does not yet exist on disk.
    boardCacheStore.hydrate({ a: makeBoard('a') as never }, { a: 'NewName.board.json' });
    installFiloMock({
      'vault:read-tree': () => ({ ok: true, tree: [] }),
      'vault:file-exists': () => false, // not on disk yet (rename IPC pending)
      'vault:write-file-text': () => ({ success: true }),
      'vault:delete': () => ({ success: true }),
    });

    beginRenameInFlight();
    try {
      await vaultStore.refreshTreeAndCleanup();
    } finally {
      endRenameInFlight();
    }

    expect('a' in boardCacheStore.cache).toBe(true); // the live board was spared
    expect(boardCacheStore.paths.a).toBe('NewName.board.json');
  });

  it('positive control: with NO rename in flight, a genuinely missing board is still evicted', async () => {
    boardCacheStore.hydrate({ a: makeBoard('a') as never }, { a: 'a.board.json' });
    installFiloMock({
      'vault:read-tree': () => ({ ok: true, tree: [] }),
      'vault:file-exists': () => false, // really gone
      'vault:write-file-text': () => ({ success: true }),
      'vault:delete': () => ({ success: true }),
    });

    expect(isRenameInFlight()).toBe(false);
    await vaultStore.refreshTreeAndCleanup();

    // Audit-19 EXT-1 — eviction now follows the provisional-missing re-check
    // (a reconcile walk + a ~2 s grace), not the tree refresh itself.
    expect('a' in boardCacheStore.cache).toBe(true);
    await vi.waitFor(() => expect('a' in boardCacheStore.cache).toBe(false), { timeout: 5000, interval: 50 });
  }, 10_000);

  it('does NOT evict when the cached path is rebound DURING the existence probe', async () => {
    boardCacheStore.hydrate({ a: makeBoard('a') as never }, { a: 'Old.board.json' });
    installFiloMock({
      'vault:read-tree': () => ({ ok: true, tree: [] }),
      'vault:file-exists': () => {
        // A rename lands its cache rebind while we await the probe: the path we
        // sampled (`Old.board.json`) is no longer current → our miss is stale.
        boardCacheStore.replacePaths({ a: 'Renamed.board.json' });
        return false;
      },
      'vault:write-file-text': () => ({ success: true }),
      'vault:delete': () => ({ success: true }),
    });

    await vaultStore.refreshTreeAndCleanup();

    expect('a' in boardCacheStore.cache).toBe(true); // the re-read guard spared it
  });

  it('renameInFlight is a counter (balanced begin/end, clamped at zero)', () => {
    expect(isRenameInFlight()).toBe(false);
    beginRenameInFlight();
    beginRenameInFlight();
    expect(isRenameInFlight()).toBe(true);
    endRenameInFlight();
    expect(isRenameInFlight()).toBe(true); // still one outstanding
    endRenameInFlight();
    expect(isRenameInFlight()).toBe(false);
    endRenameInFlight(); // unbalanced extra — must not go negative
    expect(isRenameInFlight()).toBe(false);
  });
});

// ── M4 — rollbackUndo/rollbackRedo identity guard ────────────────────────────
//
// Stack MOVES are synchronous; command BODIES queue (and can park). An action
// that interleaves while a parked undo/redo body is in flight reassigns the
// stack array. The old blind `= preUndoStack` / `= preRedoStack` restore ERASED
// that interleaved command. The fix mirrors rollbackExecute's #18 identity guard
// — blind-restore only when the array is untouched, else surgically re-insert.
describe('Audit-18 M4 — rollback restores via identity guard, not a blind snapshot', () => {
  beforeEach(() => {
    historyStore.clear();
    historyStore.setActiveBoard('b-m4');
  });
  afterEach(() => {
    historyStore.clear();
    historyStore.setActiveBoard(null);
  });

  const flush = () => new Promise((r) => setTimeout(r, 30));

  it('a rejected undo preserves an interleaved execute (command on exactly one stack)', async () => {
    let rejectA: (e: Error) => void = () => {};
    let aUndoCount = 0;
    const cmdA: Command = {
      description: 'A',
      targetBoardId: '',
      execute() {},
      undo() {
        aUndoCount += 1;
        if (aUndoCount === 1) return new Promise<void>((_r, rej) => { rejectA = rej; });
        // second undo (during the drain) succeeds
      },
    };
    const cmdB: Command = { description: 'B', targetBoardId: '', execute() {}, undo() {} };

    historyStore.execute(cmdA); // undo=[A]
    const pUndo = historyStore.undo(); // A.undo parks; undo=[], redo=[A]
    historyStore.execute(cmdB); // sync commit: undo=[B], redo=[] (cleared)

    rejectA(new Error('A undo boom'));
    await expect(pUndo).rejects.toThrow('A undo boom');
    await flush();

    // New behaviour: undo=[B, A] — B was NOT erased, A is back and NOT on redo.
    expect(historyStore.canRedo).toBe(false); // A is not lingering on the redo stack
    expect(historyStore.canUndo).toBe(true);
    await historyStore.undo(); // undo A (top)
    expect(historyStore.canUndo).toBe(true); // B survived the interleave
    await historyStore.undo(); // undo B
    expect(historyStore.canUndo).toBe(false);
  });

  it('a rejected redo preserves an interleaved undo (command on exactly one stack)', async () => {
    let rejectA: (e: Error) => void = () => {};
    let aExecCount = 0;
    const cmdA: Command = {
      description: 'A',
      targetBoardId: '',
      execute() {
        aExecCount += 1;
        if (aExecCount === 2) return new Promise<void>((_r, rej) => { rejectA = rej; });
        // call 1 (seed) + call 3 (drain redo) succeed
      },
      undo() {},
    };
    const cmdC: Command = { description: 'C', targetBoardId: '', execute() {}, undo() {} };

    historyStore.execute(cmdA); // call1; undo=[A]
    await historyStore.undo(); // undo=[], redo=[A]
    const pRedo = historyStore.redo(); // call2 parks; undo=[A], redo=[]
    historyStore.execute(cmdC); // sync commit: undo=[A,C], redo=[]
    historyStore.undo(); // sync move: undo=[A], redo=[C]

    rejectA(new Error('A redo boom'));
    await expect(pRedo).rejects.toThrow('A redo boom');
    await flush();

    // New behaviour: redo=[C, A] — C was NOT erased, A is back and NOT on undo.
    expect(historyStore.canUndo).toBe(false); // A is not lingering on the undo stack
    expect(historyStore.canRedo).toBe(true);
    await historyStore.redo(); // re-do A (top)
    expect(historyStore.canRedo).toBe(true); // C survived the interleave
    await historyStore.redo(); // re-do C
    expect(historyStore.canRedo).toBe(false);
  });

  it('fast path: with no interleave, a rejected undo restores the stack exactly', async () => {
    let reject: (e: Error) => void = () => {};
    const cmd: Command = {
      description: 'solo',
      targetBoardId: '',
      execute() {},
      undo() { return new Promise<void>((_r, rej) => { reject = rej; }); },
    };
    historyStore.execute(cmd); // undo=[cmd]
    const p = historyStore.undo(); // parks; undo=[], redo=[cmd]
    reject(new Error('boom'));
    await expect(p).rejects.toThrow('boom');

    expect(historyStore.canUndo).toBe(true); // restored via the identity fast path
    expect(historyStore.canRedo).toBe(false);
  });
});

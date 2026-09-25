import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createScheduler } from '@renderer/lib/boards/writeScheduler';
import {
  hasFailedWrites,
  __resetDirtyTrackingForTests,
} from '@renderer/lib/boards/writeStateTracking';
import { onError, __resetErrorBusForTests, type ReportedError } from '@renderer/lib/utils/errorBus';
import { __runRecoverySequencerForTests, vaultStore } from '@renderer/stores/vault.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { fileTagsStore, type TagSweepOutcome } from '@renderer/stores/fileTags.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/boardSaver';
import { __resetRenameCascadeSentinelForTests } from '@renderer/lib/vault/renameCascadeSentinel';
import { __resetTagRewriteSentinelForTests } from '@renderer/lib/vault/tagRewriteSentinel';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import { testSentinelPath } from '../helpers/testMachine';

/**
 * Audit-16 Phase 3 — cross-vault contamination & lifecycle races
 * (renderer-side items; 3.1 lives in fileWatcherLateNotify.test.ts).
 *
 * 3.2 — the recovery sequencer's step-2 (tag-rewrite Resume/Discard) confirm
 * handlers ran with NO vault-identity guard. The pre-swap handler in
 * ui.svelte.ts AUTO-CANCELS a parked confirm when the user opens another
 * vault instead of answering, so onCancel can straddle the swap commit:
 * `fileTree` is then vault B's tree while `newVaultPath` is vault A's root,
 * `flattenTreePaths` returns the EMPTY set, and `pruneOrphanFileTags` drops
 * EVERY fileTags entry — scheduled into vault B's `.filo/tags.json`.
 * Attachment tags are vault-local, so the loss is unrecoverable.
 */

const TAG_SENTINEL = testSentinelPath('tag-rewrite');

/** Removal-shaped sentinel with committed progress → partialDetected=true →
 *  onCancel runs convergeForward (removeTagEverywhere) before the prune. */
function partialRemovalSentinel(): string {
  return JSON.stringify({
    timestamp: 1,
    oldName: 'oldTag',
    newName: null,
    plan: ['Notes/A.md', 'Notes/B.md'],
    preexistingNewNamePaths: [],
    committedPaths: ['Notes/A.md'],
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

function resetAll(): void {
  __resetDirtyTrackingForTests();
  __resetRenameCascadeSentinelForTests();
  __resetTagRewriteSentinelForTests();
  noteStore.__resetForTests();
  vaultIndexStore.clear();
  boardCacheStore.clear();
  boardStore.clearBoard();
  fileTagsStore.reset();
  uiStore.closeConfirm();
  for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id);
}

describe('Audit-16 3.2 — recovery sequencer step-2 handlers are vault-identity-guarded', () => {
  beforeEach(() => {
    resetAll();
    vaultStore.setPath('/vault');
    installFiloMock((channel: string, ...args: unknown[]) => {
      if (channel === 'vault:read-file-text') {
        const p = String(args[1]);
        if (p === TAG_SENTINEL) {
          return { success: true, content: partialRemovalSentinel() };
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

  it('a swap landing mid-convergeForward suppresses the prune (no fileTags wipe)', async () => {
    // convergeForward (removal) → removeTagEverywhere; park it on a deferred
    // so the vault can swap while the cancel handler is mid-await.
    let resolveConverge!: () => void;
    const converge = new Promise<TagSweepOutcome>((r) => {
      resolveConverge = () => r({ committed: true, writtenPaths: [] });
    });
    const remove = vi.spyOn(fileTagsStore, 'removeTagEverywhere').mockReturnValue(converge);
    const prune = vi.spyOn(fileTagsStore, 'pruneOrphanFileTags').mockImplementation(() => []);

    const seq = __runRecoverySequencerForTests('/vault');
    // The pre-swap handler fires a parked confirm's onCancel — same shape as
    // clicking Discard right before the swap commits.
    await fireDialog('cancel');
    await waitFor(() => remove.mock.calls.length > 0);

    // The swap commits while convergeForward is still pumping (new path ⇒
    // new generation, exactly what commitVaultCandidate produces).
    vaultStore.setPath('/other-vault');
    resolveConverge();
    await seq;

    expect(prune).not.toHaveBeenCalled();
  });

  it('a swap that lands before the auto-cancel makes the whole handler a no-op', async () => {
    const remove = vi.spyOn(fileTagsStore, 'removeTagEverywhere').mockResolvedValue({ committed: true, writtenPaths: [] });
    const prune = vi.spyOn(fileTagsStore, 'pruneOrphanFileTags').mockImplementation(() => []);

    const seq = __runRecoverySequencerForTests('/vault');
    await waitFor(() => uiStore.confirmDialog !== null);

    // Swap first; THEN the pre-swap handler's auto-cancel fires (the
    // fire-and-forget onCancel can be scheduled after the commit).
    vaultStore.setPath('/other-vault');
    await fireDialog('cancel');
    await seq;

    expect(remove).not.toHaveBeenCalled();
    expect(prune).not.toHaveBeenCalled();
  });

  it('positive control: without a swap, Discard converges and prunes as before', async () => {
    const remove = vi.spyOn(fileTagsStore, 'removeTagEverywhere').mockResolvedValue({ committed: true, writtenPaths: [] });
    const prune = vi.spyOn(fileTagsStore, 'pruneOrphanFileTags').mockImplementation(() => []);

    const seq = __runRecoverySequencerForTests('/vault');
    await fireDialog('cancel');
    await seq;

    expect(remove).toHaveBeenCalledWith('oldTag');
    expect(prune).toHaveBeenCalledTimes(1);
  });
});

/**
 * 3.4 — a PARKED fire (debounce fire deferred behind an in-flight write)
 * survives `reset()`: the timer already fired, so cancelAll's clearTimeout
 * can't reach it, and reset() only drops the parked-promise REFERENCES. When
 * the old write settled, the dangling closure resumed and called
 * `fireFromTimer()` against the NEW vault's fresh tracking state: a non-null
 * `getArgs()` re-FIRED the stale write into the fresh `inFlight` map, and a
 * null one took the missing-source branch — a false "couldn't save" error +
 * `safeEndWrite(false)` planting the OUTGOING vault's path in the new
 * session's failed set (sticky `.filo/.dirty`, phantom recovery prompt).
 * The parked closure now captures a scheduler generation bumped by reset().
 */
describe('Audit-16 3.4 — a parked fire neutralised by reset() neither fires nor pollutes', () => {
  interface TArgs {
    vaultRoot: string;
    path: string;
  }

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    __resetErrorBusForTests();
    installFiloMock(() => ({ success: true }));
  });

  afterEach(() => {
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
    __resetErrorBusForTests();
    vi.useRealTimers();
  });

  /** Parks a second fire for `key` behind a controllable in-flight write A. */
  function buildParkedScheduler(getArgs: () => TArgs | null): {
    scheduler: ReturnType<typeof createScheduler<TArgs>>;
    writes: TArgs[];
    resolveA: () => void;
  } {
    vi.useFakeTimers();
    let resolveA!: () => void;
    const writes: TArgs[] = [];
    const scheduler = createScheduler<TArgs>({
      name: 'test-3.4',
      debounceMs: 100,
      performWrite: (a) => {
        writes.push(a);
        if (writes.length === 1) {
          return new Promise<void>((res) => { resolveA = res; });
        }
        return Promise.resolve();
      },
      getSentinelInfo: (a) => ({ vaultRoot: a.vaultRoot, path: a.path }),
      missingSourceMessage: () => 'Filo could not save this board.',
    });

    scheduler.schedule('k', getArgs);
    vi.advanceTimersByTime(150); // write A fires and stays in flight
    scheduler.schedule('k', getArgs);
    vi.advanceTimersByTime(150); // timer fires, sees A in flight → PARKS
    vi.useRealTimers();
    return { scheduler, writes, resolveA };
  }

  it('does not re-fire the stale write into the new session (non-null args shape)', async () => {
    const args: TArgs = { vaultRoot: '/old-vault', path: 'a.md' };
    const { writes, scheduler, resolveA } = buildParkedScheduler(() => args);

    scheduler.reset(); // the vault swap
    __resetDirtyTrackingForTests(); // resetWriteTracking's fresh state

    resolveA(); // the slow volume finally answers — after the swap
    await new Promise((r) => setTimeout(r, 20));

    expect(writes).toHaveLength(1); // the parked fire stayed dead
  });

  it('does not surface missing-source or pollute the failed set (null args shape)', async () => {
    let swapHappened = false;
    const args: TArgs = { vaultRoot: '/old-vault', path: 'a.md' };
    const { scheduler, resolveA } = buildParkedScheduler(() => (swapHappened ? null : args));

    const errors: ReportedError[] = [];
    onError((e) => errors.push(e));

    scheduler.reset();
    __resetDirtyTrackingForTests();
    swapHappened = true; // the swap cleared the cache → getArgs now misses

    resolveA();
    await new Promise((r) => setTimeout(r, 20));

    expect(errors).toHaveLength(0); // no false "couldn't save"
    expect(hasFailedWrites()).toBe(false); // no foreign path in the new session
  });

  it('positive control: without reset() the parked fire lands after the drain', async () => {
    const args: TArgs = { vaultRoot: '/vault', path: 'a.md' };
    const { writes, resolveA } = buildParkedScheduler(() => args);

    resolveA();
    await new Promise((r) => setTimeout(r, 20));

    expect(writes).toHaveLength(2); // A + the parked fire
  });
});

/**
 * 3.5 — `swapInProgress` is a single module slot, and openVault's finally
 * cleared it unconditionally. With two concurrent openVault calls the first
 * swap's finally nulled the SECOND swap's window mid-swap, so a quit's
 * `save()` saw `swapInProgress === null` and drained inside the second
 * swap's registry-null window — the exact fail-closed hole Audit-14 1.8
 * closed, reintroduced under concurrency. The clear is now owner-checked.
 */
describe('Audit-16 3.5 — a concurrent swap window survives the first swap\'s finally', () => {
  const VALID_TAGS_JSON = JSON.stringify({ version: 1, tags: {}, fileTags: {} });

  /** Per-path gate on the candidate load's `vault:read-tree`. */
  let blockers: Map<string, Promise<void>>;
  let releases: Map<string, () => void>;
  let entered: Map<string, Promise<void>>;
  let enteredSignals: Map<string, () => void>;

  function gatePath(path: string): void {
    let release!: () => void;
    blockers.set(path, new Promise<void>((r) => { release = r; }));
    releases.set(path, release);
    let signal!: () => void;
    entered.set(path, new Promise<void>((r) => { signal = r; }));
    enteredSignals.set(path, signal);
  }

  beforeEach(() => {
    resetAll();
    blockers = new Map();
    releases = new Map();
    entered = new Map();
    enteredSignals = new Map();
    installFiloMock((channel: string, ...args: unknown[]) => {
      if (channel === 'dialog:choice') return 1; // "Cancel": nothing is unsaved, so no leave dialog should appear
      if (channel === 'vault:close') return { success: true };
      if (channel === 'vault:init-config') return { ok: true };
      if (channel === 'config:load-all') return {};
      if (channel === 'board:list') return [];
      if (channel === 'vault:read-tree') {
        const p = String(args[0]);
        const blocker = blockers.get(p);
        if (blocker) {
          enteredSignals.get(p)?.();
          return blocker.then(() => ({ ok: true, tree: [] }));
        }
        return { ok: true, tree: [] };
      }
      if (channel === 'theme:list') return [];
      if (channel === 'theme:load') return null;
      if (channel === 'tags:load') return VALID_TAGS_JSON;
      if (channel === 'vault:read-file-text') return { ok: false, code: 'ENOENT', error: 'ENOENT' };
      return { success: true };
    });
  });

  afterEach(async () => {
    // Release any still-armed gates so dangling candidate loads settle.
    for (const r of releases.values()) r();
    await new Promise((res) => setTimeout(res, 20));
    restoreFiloDefault();
    resetAll();
    vaultStore.setPath('');
  });

  it("save() keeps deferring to the second swap's window after the first swap settles", async () => {
    await vaultStore.openVault('/vault/A'); // fast first open (no window)

    gatePath('/vault/B');
    gatePath('/vault/C');

    const p1 = vaultStore.openVault('/vault/B');
    await entered.get('/vault/B'); // p1 parked inside loadVaultCandidate(B)
    // p2 saves before leaving, and that save waits out p1's window, so p2's
    // own window opens only once p1 has settled.
    let cEntered = false;
    void entered.get('/vault/C')!.then(() => { cEntered = true; });
    const p2 = vaultStore.openVault('/vault/C');
    await new Promise((r) => setTimeout(r, 30));
    expect(cEntered).toBe(false);

    releases.get('/vault/B')!();
    await p1; // first swap settles; its finally must NOT null p2's window
    await entered.get('/vault/C'); // p2 parked inside loadVaultCandidate(C): its window owns the slot

    let saveSettled = false;
    const savePromise = vaultStore.save().then(() => { saveSettled = true; });
    await new Promise((r) => setTimeout(r, 30));
    // Pre-fix: p1's finally nulled the slot, save() never deferred → true.
    expect(saveSettled).toBe(false);

    releases.get('/vault/C')!();
    await p2;
    await savePromise;
    expect(saveSettled).toBe(true);
  });
});

/**
 * 3.6 — `refreshTreeAndCleanup` evicted boards using a possibly-stale
 * `fileTree`: (a) a FAILED `vault:read-tree` left the old tree in place and
 * returned void, so the missing-board walk ran against it anyway; (b) the
 * tree enumeration can race a concurrent `board:create` (read started
 * before the create landed). Eviction is destructive — it cancels the
 * board's pending debounced writes and closes its tabs — so recent edits
 * were silently lost while the file on disk kept the older state.
 */
describe('Audit-16 3.6 — refreshTreeAndCleanup does not evict on stale-tree evidence', () => {
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
    resetAll();
    vaultStore.setPath('/vault');
    vaultStore.setTree([]);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    restoreFiloDefault();
    resetAll();
    vaultStore.setPath('');
    vaultStore.setTree([]);
    vi.restoreAllMocks();
  });

  it('a failed read-tree skips the eviction walk entirely', async () => {
    boardCacheStore.hydrate(
      { a: makeBoard('a') as never },
      { a: 'a.board.json' },
    );
    installFiloMock({
      'vault:read-tree': () => ({ ok: false, code: 'EACCES', error: 'locked' }),
      'vault:file-exists': () => false, // even a confirming probe must not run
      'vault:write-file-text': () => ({ success: true }),
      'vault:delete': () => ({ success: true }),
    });

    await vaultStore.refreshTreeAndCleanup();

    expect('a' in boardCacheStore.cache).toBe(true);
    expect(boardCacheStore.paths.a).toBe('a.board.json');
  });

  it('a board missing from the enumeration but present on disk survives (create-vs-read race)', async () => {
    boardCacheStore.hydrate(
      { a: makeBoard('a') as never },
      { a: 'a.board.json' },
    );
    installFiloMock({
      // The read succeeds but enumerated BEFORE the board's create landed.
      'vault:read-tree': () => ({ ok: true, tree: [] }),
      'vault:file-exists': () => true, // the direct stat proves it exists
      'vault:write-file-text': () => ({ success: true }),
      'vault:delete': () => ({ success: true }),
    });

    await vaultStore.refreshTreeAndCleanup();

    expect('a' in boardCacheStore.cache).toBe(true);
  });

  it('positive control: a genuinely deleted board is still evicted', async () => {
    boardCacheStore.hydrate(
      { a: makeBoard('a') as never },
      { a: 'a.board.json' },
    );
    installFiloMock({
      'vault:read-tree': () => ({ ok: true, tree: [] }),
      'vault:file-exists': () => false, // really gone
      'vault:write-file-text': () => ({ success: true }),
      'vault:delete': () => ({ success: true }),
    });

    await vaultStore.refreshTreeAndCleanup();

    // Audit-19 EXT-1 — eviction now follows the provisional-missing re-check
    // (a reconcile walk + a ~2 s grace), not the tree refresh itself.
    expect('a' in boardCacheStore.cache).toBe(true);
    await vi.waitFor(() => expect('a' in boardCacheStore.cache).toBe(false), { timeout: 5000, interval: 50 });
  }, 10_000);
});

/**
 * 3.7 — the external-change renderer bridge (`vaultStore.listenForChanges`)
 * must be owned by an app-lifetime component, NOT VaultSidebar's mount
 * lifecycle: the docked and floating sidebars are mutually exclusive
 * `{#if}` branches in AppShell, so a float/dock toggle destroyed one
 * instance (unsubscribing every watcher listener, discarding a mid-debounce
 * tree reconcile) and mounted the other — events in the gap were dropped. A
 * dropped `vault:file-renamed` is worst: the rename cascade never runs and
 * the later reconcile can evict the board as missing.
 *
 * The unit suite has no component-mount harness, so this is a source-shape
 * pin (the style the scripts/check-*.mjs gates use): the subscription CALL
 * lives in App.svelte (mounted once for the app's lifetime) and nowhere in
 * the sidebar tree.
 */
describe('Audit-16 3.7 — the watcher bridge is app-lifetime, not sidebar-lifecycle', () => {
  const read = (rel: string): string =>
    readFileSync(join(process.cwd(), rel), 'utf-8');

  it('App.svelte owns the listenForChanges subscription', () => {
    expect(read('src/renderer/App.svelte')).toMatch(/\.listenForChanges\(\)/);
  });

  it('no sidebar component subscribes the bridge', () => {
    expect(read('src/renderer/components/sidebar/VaultSidebar.svelte'))
      .not.toMatch(/\.listenForChanges\(\)/);
    expect(read('src/renderer/components/sidebar/FloatingVaultPanel.svelte'))
      .not.toMatch(/\.listenForChanges\(\)/);
  });
});

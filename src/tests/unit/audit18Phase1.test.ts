import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createScheduler } from '@renderer/lib/boards/writeScheduler';
import { loadTagsFile, emptyTagsFile } from '@renderer/lib/vault/tagsStorage';
import { fileTagsStore } from '@renderer/stores/fileTags.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import { KanbanMultiSelect } from '@renderer/lib/kanban/kanbanMultiSelect.svelte';
import { writeConfigs } from '@renderer/lib/boards/configWriteScheduler';
import { ENOENT_RESTAT_DELAY_MS } from '@renderer/lib/boards/boardWriteDebounce';
import { BOARD_ENOENT_RESTAT_DELAY_MS } from '@renderer/lib/boards/boardWriteScheduler';
import { noteBaseline, __resetBaselinesForTests } from '@renderer/lib/vault/fileBaselineRegistry';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { IpcEnvelopeError } from '@shared/ipcEnvelope';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import type { Tile } from '@renderer/schema/index';
import type { KanbanBoard as KanbanBoardType } from '@renderer/schema/index';
import type { SelectionScope } from '@renderer/stores/selection.svelte';
import type { ProjectSettings, WorkspaceState } from '@renderer/schema/index';

/**
 * Audit-18 Phase 1 — the dogfood-unblock fix set (3 HIGH + 3 small MEDIUMs).
 * Each describe block locks one fix's load-bearing behaviour. The component-
 * internal guards (H3 TextTile) are additionally pinned by
 * `scripts/gates:no-silent-write-abort`; these tests lock the gateway /
 * primitive facts those guards depend on.
 */

// ── H1 — PropertiesPopup parked-write cancel (pendingOnly) ───────────────────
//
// onDestroy fires a fire-and-forget flush THEN a synchronous cancel. The plain
// cancel marks a PARKED fire cancelled (Audit-16 4.4), so its closure bails and
// the freshest rows never write while the flush still resolves ok. `pendingOnly`
// keeps the teardown cancel to an armed timer, so the flush-owned parked fire
// still lands. Driven through the `createScheduler` primitive with a controllable
// in-flight write so a real parked fire is constructed deterministically.
describe('Audit-18 H1 — pendingOnly cancel preserves a flush-owned parked fire', () => {
  interface Args { id: string }

  function makeScheduler(performed: string[], gate: Promise<void>) {
    let callCount = 0;
    return createScheduler<Args>({
      name: 'test-h1',
      debounceMs: 10,
      sentinelMode: 'none',
      performWrite: async (args) => {
        callCount += 1;
        performed.push(args.id);
        // Block ONLY the first write so the second debounce fire parks behind it.
        if (callCount === 1) await gate;
      },
      getSentinelInfo: (args) => ({ vaultRoot: '/v', path: args.id }),
    });
  }

  /** Arms w1 (fires + blocks in flight), then w2 (fires → parks behind w1). */
  async function armParkedFire(scheduler: ReturnType<typeof makeScheduler>) {
    scheduler.schedule('k', () => ({ id: 'w1' }));
    await new Promise((r) => setTimeout(r, 30)); // debounce → w1 in flight (blocked)
    scheduler.schedule('k', () => ({ id: 'w2' }));
    await new Promise((r) => setTimeout(r, 30)); // debounce → w2 parks behind w1
  }

  it('pendingOnly cancel lets the parked (newest) write land', async () => {
    const performed: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const scheduler = makeScheduler(performed, gate);

    await armParkedFire(scheduler);
    expect(performed).toEqual(['w1']); // w2 is parked, not yet performed

    // Teardown sequence: flush (fire-and-forget) then pendingOnly cancel, same tick.
    const flushP = scheduler.flush('k');
    scheduler.cancel('k', undefined, /* pendingOnly */ true);

    release(); // w1 completes → drain resolves → parked w2 fires
    await flushP;

    expect(performed).toContain('w2'); // the freshest rows were NOT dropped
  });

  it('counter-case: a NON-pendingOnly cancel drops the parked write (the H1 bug)', async () => {
    const performed: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const scheduler = makeScheduler(performed, gate);

    await armParkedFire(scheduler);

    const flushP = scheduler.flush('k');
    scheduler.cancel('k'); // default: also cancels the parked fire

    release();
    await flushP;

    expect(performed).toEqual(['w1']); // w2 was cancelled → silently dropped
  });
});

// ── H2 — corrupt tags.json load is read-only (never written back) ────────────
describe('Audit-18 H2 — corrupt tags.json loads read-only', () => {
  beforeEach(() => {
    restoreFiloDefault();
    fileTagsStore.reset();
  });
  afterEach(async () => {
    await fileTagsStore.flush();
    restoreFiloDefault();
    fileTagsStore.reset();
  });

  it('flags invalid JSON as corrupt (and only corrupt)', () => {
    const r = loadTagsFile('{ not json');
    expect(r.corrupt).toBe(true);
    expect(r.fromFuture).toBe(false);
    expect(r.noMigrationPath).toBe(false);
  });

  it('flags schema-invalid JSON as corrupt', () => {
    const r = loadTagsFile('{"version":1,"tags":"oops","fileTags":{}}');
    expect(r.corrupt).toBe(true);
  });

  it('does NOT flag a valid tags file as corrupt', () => {
    const r = loadTagsFile(JSON.stringify({ version: 1, tags: {}, fileTags: {} }));
    expect(r.corrupt).toBe(false);
  });

  it('a corrupt load (readOnly verdict) never writes tags:save — the file is preserved', async () => {
    const saveCalls: unknown[][] = [];
    installFiloMock((channel: string, ...args: unknown[]) => {
      if (channel === 'tags:save') saveCalls.push(args);
      return { ok: true };
    });
    // Mirror what vaultCandidate does for a corrupt tags.json: the read-only
    // verdict (loaded.corrupt) is carried into commitFromCandidate.
    fileTagsStore.commitFromCandidate('/vault', emptyTagsFile(), /* readOnly */ true);
    // Post-commit FM tag-seeding would call setAll(seed) → scheduleSave.
    fileTagsStore.setAll({ version: 1, tags: { proj: { color: '#fff' } }, fileTags: {} });
    await fileTagsStore.flush();

    expect(saveCalls).toHaveLength(0); // the recoverable disk bytes are NOT overwritten
  });

  it('a healthy load DOES persist (the gate only fires on corrupt)', async () => {
    const saveCalls: unknown[][] = [];
    installFiloMock((channel: string, ...args: unknown[]) => {
      if (channel === 'tags:save') saveCalls.push(args);
      return { ok: true };
    });
    fileTagsStore.commitFromCandidate('/vault', emptyTagsFile(), /* readOnly */ false);
    fileTagsStore.setAll({ version: 1, tags: { proj: { color: '#fff' } }, fileTags: {} });
    await fileTagsStore.flush();

    expect(saveCalls.length).toBeGreaterThan(0);
  });
});

// ── H3 — a note whose read failed is never written from an editor ────────────
//
// The component side (TextTile / DocumentEditor frozen with a Retry banner) is
// pinned by the component suite. These lock the note-store facts it rests on: a
// NON-ENOENT read failure leaves the note `unreadable` and refuses editor
// bodies, so an empty editor can't overwrite the unread file; a missing file
// is `missing`, and a body typed there never recreates it.
describe('Audit-18 H3 — a failed note read blocks editor writes', () => {
  let vault: MemoryVault;

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    noteStore.__resetForTests();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    noteStore.__resetForTests();
    restoreFiloDefault();
    vi.restoreAllMocks();
  });

  it('a NON-ENOENT read failure leaves the note unreadable and refuses editor bodies', async () => {
    const rel = 'Notes/TooBig.md';
    vault = installMemoryVault({ [rel]: '---\ntitle: Big\n---\nreal content\n' });
    const invoke = window.filo.invoke;
    window.filo.invoke = (async (channel: string, ...args: unknown[]) => {
      if (channel === 'vault:read-file-text' && args[1] === rel) {
        return { success: false, code: 'FILE_TOO_LARGE', error: 'FILE_TOO_LARGE' };
      }
      return (invoke as (c: string, ...a: unknown[]) => Promise<unknown>)(channel, ...args);
    }) as typeof window.filo.invoke;

    const m = noteStore.acquire(rel, 'text-tile:big');
    await m.loaded;
    expect(m.status).toBe('unreadable');
    expect(m.readError).toBeInstanceOf(IpcEnvelopeError);
    expect((m.readError as IpcEnvelopeError).code).toBe('FILE_TOO_LARGE');

    noteStore.setBody(rel, '', 'text-tile:big');
    expect(m.hasUnsavedBody).toBe(false);
    await noteStore.flushAll();
    // The unread bytes are untouched.
    expect(vault.writes.filter(([, r]) => r === rel)).toEqual([]);
    expect(vault.read(rel)).toBe('---\ntitle: Big\n---\nreal content\n');
    noteStore.release(rel, 'text-tile:big');
  });

  it('an ENOENT read leaves the note missing, and a body typed there never recreates it', async () => {
    const rel = 'Notes/Gone.md';
    vault = installMemoryVault({});
    const m = noteStore.acquire(rel, 'text-tile:gone');
    await m.loaded;
    expect(m.status).toBe('missing');

    noteStore.setBody(rel, 'typed into a missing note', 'text-tile:gone');
    await noteStore.flushAll();
    expect(vault.read(rel)).toBeUndefined();
    noteStore.release(rel, 'text-tile:gone');
  });
});

// ── M5 — config ENOENT re-stat is gated behind the grace delay ───────────────
describe('Audit-18 M5 — config ENOENT re-stat grace delay', () => {
  const VAULT_ROOT = '/vault';

  function settings(mindmap: Record<string, unknown>): ProjectSettings {
    return { general: { globalFont: 'fixed' }, mindmap, kanban: {}, tasklist: {}, document: {} } as ProjectSettings;
  }
  function workspace(): WorkspaceState {
    return { openTabs: [], activeTabId: '' };
  }

  beforeEach(() => {
    restoreFiloDefault();
    __resetBaselinesForTests();
    __resetDirtyTrackingForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
    restoreFiloDefault();
    __resetBaselinesForTests();
    __resetDirtyTrackingForTests();
  });

  it('shares one grace-delay constant with the board scheduler (parity)', () => {
    expect(ENOENT_RESTAT_DELAY_MS).toBeGreaterThan(0);
    expect(BOARD_ENOENT_RESTAT_DELAY_MS).toBe(ENOENT_RESTAT_DELAY_MS);
  });

  it('does NOT re-stat until the grace delay elapses, then runs the drift path (not a silent no-op)', async () => {
    vi.useFakeTimers();
    noteBaseline('.filo/defaults.json', 1000, 50);
    let defaultsStatCount = 0;
    installFiloMock((channel: string, ...args: unknown[]) => {
      if (channel === 'vault:stat') {
        const rel = args[1] as string;
        if (rel === '.filo/defaults.json') {
          defaultsStatCount += 1;
          // 1st stat: transient ENOENT. Re-stat: reappeared but DRIFTED (foreign).
          if (defaultsStatCount === 1) return Promise.resolve({ ok: false, code: 'ENOENT', error: 'blip' });
          return Promise.resolve({ ok: true, mtimeMs: 2000, size: 60 });
        }
        return Promise.resolve({ ok: true, mtimeMs: 1000, size: 50 });
      }
      if (channel === 'config:save' || channel === 'config:save-workspace') return Promise.resolve({ ok: true });
      return Promise.resolve(undefined);
    });

    const p = writeConfigs(VAULT_ROOT, settings({ x: 2 }), 'light', workspace());
    // Let writeConfigs progress through the 1st stat into the grace `await`
    // WITHOUT advancing the timer. Microtasks resolve under fake timers.
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(defaultsStatCount).toBe(1); // re-stat is GATED behind the delay

    // Advance the grace window → the re-stat fires and the drift path engages.
    await vi.advanceTimersByTimeAsync(ENOENT_RESTAT_DELAY_MS);
    const result = await p;

    expect(defaultsStatCount).toBeGreaterThanOrEqual(2); // re-stat happened after the delay
    // The reappeared file drifted (foreign mtime+size) → abort, surfaced as a
    // failure — NOT silently resolved as a clean success (the M5 bug).
    expect(result.failed).toContain('defaults.json');
  });
});

// ── M7 — bulk Add tag routes through the injected popup, not window.prompt ────
describe('Audit-18 M7 — bulk Add tag uses the injected popup resolver', () => {
  function makeMultiSelect(promptValue: string | null) {
    const tiles: Record<string, Tile> = {
      a: { id: 'a', type: 'text', filePath: 'A.md', title: 'A', tags: [] } as unknown as Tile,
    };
    return new KanbanMultiSelect({
      selection: { selectedIds: new Set(['a']) } as unknown as SelectionScope,
      getBoardId: () => 'kb',
      getColumns: () => [] as unknown as KanbanBoardType['columns'],
      getAllTilesById: () => tiles,
      getFlatVisibleTileIds: () => ['a'],
      bumpCacheVersion: () => {},
      tickAndPersist: () => {},
      ensureSeededFm: () => null,
      vaultPathForTile: (t: Tile) => `${t.id}.md`,
      promptForTag: () => Promise.resolve(promptValue),
    });
  }

  beforeEach(() => {
    noteStore.__resetForTests();
    historyStore.clear();
    historyStore.setActiveBoard('kb');
  });
  afterEach(() => {
    historyStore.setActiveBoard(null);
    historyStore.clear();
    noteStore.__resetForTests();
  });

  it('builds a BatchCommand from the popup value (no window.prompt)', async () => {
    const promptSpy = vi.spyOn(window, 'prompt');
    const dispatched: unknown[] = [];
    const execSpy = vi.spyOn(historyStore, 'execute').mockImplementation(async (cmd) => {
      dispatched.push(cmd);
    });

    await makeMultiSelect('urgent').tagSelectedTiles();

    execSpy.mockRestore();
    expect(promptSpy).not.toHaveBeenCalled(); // window.prompt is never reached
    promptSpy.mockRestore();
    expect(dispatched).toHaveLength(1);
    const batch = dispatched[0] as { constructor: { name: string }; description: string };
    expect(batch.constructor.name).toBe('BatchCommand');
    expect(batch.description).toContain('urgent');
  });

  it('cancelling the popup (null) dispatches nothing', async () => {
    const execSpy = vi.spyOn(historyStore, 'execute').mockImplementation(async () => {});

    await makeMultiSelect(null).tagSelectedTiles();

    expect(execSpy).not.toHaveBeenCalled();
    execSpy.mockRestore();
  });
});

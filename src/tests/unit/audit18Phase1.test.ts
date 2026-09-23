import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createScheduler } from '@renderer/lib/boards/writeScheduler';
import { loadTagsFile, emptyTagsFile } from '@renderer/lib/vault/tagsStorage';
import { fileTagsStore } from '@renderer/stores/fileTags.svelte';
import {
  isHydrated,
  readMarkdownForHydrate,
  writeMarkdownFile,
  cancelAllMarkdownWrites,
  __clearFileStateForTests,
} from '@renderer/lib/vault/markdownFileWriter';
import { documentStore } from '@renderer/stores/document.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import { KanbanMultiSelect } from '@renderer/lib/kanban/kanbanMultiSelect.svelte';
import { writeConfigs } from '@renderer/lib/boards/configWriteScheduler';
import { ENOENT_RESTAT_DELAY_MS } from '@renderer/lib/boards/boardWriteDebounce';
import { BOARD_ENOENT_RESTAT_DELAY_MS } from '@renderer/lib/boards/boardWriteScheduler';
import { noteBaseline, __resetBaselinesForTests } from '@renderer/lib/vault/fileBaselineRegistry';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { IpcEnvelopeError } from '@shared/ipcEnvelope';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import type { Tile } from '@renderer/schema/index';
import type { KanbanBoard as KanbanBoardType } from '@renderer/schema/index';
import type { SelectionScope } from '@renderer/stores/selection.svelte';
import type { ProjectSettings, WorkspaceState } from '@renderer/schema/index';

/**
 * Audit-18 Phase 1 — the dogfood-unblock fix set (3 HIGH + 3 small MEDIUMs).
 * Each describe block locks one fix's load-bearing behaviour. The component-
 * internal guards (H3 TextTile) are additionally pinned by
 * `scripts/check-no-silent-write-abort.mjs`; these tests lock the gateway /
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

// ── H3 — TextTile hydrate-failure gateway contract (twin of M1) ──────────────
//
// The component guard lives in TextTile.svelte (pinned by ci:no-silent-write-
// abort's TEXT_TILE_FILE arm). jsdom can't mount TipTap, so these lock the
// gateway facts: a NON-ENOENT read failure rejects (the trigger that flips
// hydrateReadFailed), an ENOENT failure rejects with a distinguishable code (the
// branch that KEEPS the embedded fallback writable), and an empty-body write
// truncates real content (why the guard is load-bearing).
describe('Audit-18 H3 — TextTile failed-hydrate write guard (gateway contract)', () => {
  let diskFiles: Map<string, string>;

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    __clearFileStateForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
    diskFiles = new Map();
    installFiloMock((channel: string, ...args: unknown[]) => {
      if (channel === 'vault:read-file-text') {
        const rel = args[1] as string;
        const content = diskFiles.get(rel);
        if (content === undefined) {
          // The test seeds a specific failure code per path below via a marker.
          const code = failureCodeByPath.get(rel) ?? 'ENOENT';
          return { success: false, code };
        }
        return { success: true, content, mtimeMs: 100, size: content.length };
      }
      if (channel === 'vault:write-existing-file-text' || channel === 'vault:write-file-text') {
        const rel = args[1] as string;
        diskFiles.set(rel, args[2] as string);
        return { success: true };
      }
      if (channel === 'vault:stat') return { ok: true, mtimeMs: 100, size: 100 };
      return { ok: true, success: true };
    });
  });

  afterEach(() => {
    cancelAllMarkdownWrites();
    __clearFileStateForTests();
    failureCodeByPath.clear();
    restoreFiloDefault();
  });

  const failureCodeByPath = new Map<string, string>();

  it('a NON-ENOENT read failure rejects with its code (the hydrateReadFailed trigger)', async () => {
    const rel = 'Notes/TooBig.md';
    failureCodeByPath.set(rel, 'FILE_TOO_LARGE');
    expect(isHydrated(rel)).toBe(false);
    let caught: unknown;
    try { await readMarkdownForHydrate('/vault', rel); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(IpcEnvelopeError);
    expect((caught as IpcEnvelopeError).code).toBe('FILE_TOO_LARGE');
    // The failed read mutated nothing — the unread bytes are untouched.
    expect(diskFiles.has(rel)).toBe(false);
  });

  it('an ENOENT read failure rejects with ENOENT (the keep-embedded-fallback branch)', async () => {
    const rel = 'Notes/Gone.md';
    failureCodeByPath.set(rel, 'ENOENT');
    let caught: unknown;
    try { await readMarkdownForHydrate('/vault', rel); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(IpcEnvelopeError);
    expect((caught as IpcEnvelopeError).code).toBe('ENOENT');
  });

  it('an empty-body write over real content TRUNCATES it (why the guard is load-bearing)', async () => {
    const rel = 'Notes/Real.md';
    const real = '---\ntitle: Real\n---\n\n# Heading\n\nMust survive.\n';
    diskFiles.set(rel, real);

    // Control: a normal hydrate reads the real bytes (and marks the file
    // hydrated so the gateway permits the subsequent write).
    const hydrated = await readMarkdownForHydrate('/vault', rel);
    expect(hydrated.body).toContain('Heading');

    // Un-guarded shape: the tile wrote an empty body. The gateway faithfully
    // persists it, destroying the real content — exactly what H3's guard prevents
    // by refusing the write while hydrateReadFailed && !lastLoadedBody.
    await writeMarkdownFile({
      vaultRoot: '/vault',
      relPath: rel,
      frontmatter: {},
      body: '',
      callerId: `text-tile:${rel}`,
      docId: null,
    });
    expect(diskFiles.get(rel) ?? '').not.toContain('Heading');
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
      a: { id: 'a', type: 'text', contentId: 'docA', title: 'A', tags: [] } as unknown as Tile,
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
    documentStore.clear();
    historyStore.clear();
    historyStore.setActiveBoard('kb');
  });
  afterEach(() => {
    historyStore.setActiveBoard(null);
    historyStore.clear();
    documentStore.clear();
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

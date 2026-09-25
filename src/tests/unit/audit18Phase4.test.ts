import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SvelteSet } from 'svelte/reactivity';

import { makeRecoverySlice } from '@renderer/stores/vaultRecovery';
import type { VaultContext } from '@renderer/stores/vaultStoreTypes';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import {
  writeConfigs,
  markCorruptConfigTarget,
} from '@renderer/lib/boards/configWriteScheduler';
import {
  setWriteErrorListener,
  __resetDirtyTrackingForTests,
  type WriteErrorInfo,
} from '@renderer/lib/boards/writeStateTracking';
import type {
  ProjectSettings,
  WorkspaceState,
  Tile,
  KanbanBoard as KanbanBoardType,
  TaskListBoard,
} from '@renderer/schema/index';

import { MultiSelectController } from '@renderer/lib/tasklist/multiSelectController.svelte';
import { KanbanMultiSelect } from '@renderer/lib/kanban/kanbanMultiSelect.svelte';
import type { SelectionScope } from '@renderer/stores/selection.svelte';
import type { TaskRow } from '@renderer/lib/tasks/taskListModel';
import { historyStore } from '@renderer/stores/history.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { Command } from '@renderer/commands/Command';

/** Flush queued microtasks (settle the gated `.then` toast chains). */
async function flushMicrotasks(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

/**
 * Audit-18 Phase 4 — recovery / error-honesty fixes. Each describe block locks
 * one fix's load-bearing behaviour (a failure that previously reported success,
 * or a recovery breadcrumb destroyed without acknowledgement).
 */

// ── 4.1 — bypassed Recovery-modal close preserves the sentinel ──────────────
describe('Audit-18 4.1 — bypassed Recovery-modal close preserves the sentinel', () => {
  let writes: Array<{ channel: string; args: unknown[] }>;
  let recoveryPaths: string[];
  let resolveCount: number;
  let ctx: VaultContext;
  let slice: ReturnType<typeof makeRecoverySlice>;

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    writes = [];
    recoveryPaths = ['Notes.md', 'plans/q3.md'];
    resolveCount = 0;
    installFiloMock((channel: string, ...args: unknown[]) => {
      writes.push({ channel, args });
      return { success: true };
    });
    ctx = {
      getVaultPath: () => '/vault',
      setVaultPath: () => {},
      getFileTree: () => [],
      setFileTree: () => {},
      getSearchQuery: () => '',
      setSearchQuery: () => {},
      getIsLoading: () => false,
      setIsLoading: () => {},
      getExpandedFolders: () => new Set(),
      setExpandedFolders: () => {},
      getSelectedPaths: () => new Set(),
      setSelectedPaths: () => {},
      getProject: () => null,
      setProject: () => {},
      getRecoveryPendingPaths: () => recoveryPaths,
      setRecoveryPendingPaths: (next) => { recoveryPaths = next; },
      resolveRecoveryDismissed: () => { resolveCount++; },
      markMetaDirty: () => {},
      refreshTree: async () => {},
      clearSelection: () => {},
      clearActiveRootFolderIfMatches: () => {},
    } as unknown as VaultContext;
    slice = makeRecoverySlice(ctx);
  });

  afterEach(() => {
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
  });

  it('bypassRecoveryModalClose un-parks the sequencer WITHOUT clearing the sentinel or pending paths', async () => {
    slice.bypassRecoveryModalClose();
    await flushMicrotasks();

    // Sequencer un-parked (so steps 2–4 still run this session).
    expect(resolveCount).toBe(1);
    // Pending paths preserved — the breadcrumb survives.
    expect(recoveryPaths).toEqual(['Notes.md', 'plans/q3.md']);
    // No on-disk sentinel destruction.
    const sentinelDelete = writes.find(
      (w) => w.channel === 'vault:delete' && String(w.args[1]).endsWith('.filo/.dirty.a1b2c3d4e5f6'),
    );
    expect(sentinelDelete).toBeUndefined();
  });

  it('the explicit Dismiss path (acknowledgeRecovery) DOES clear the sentinel (counter-case)', async () => {
    await slice.acknowledgeRecovery();
    expect(resolveCount).toBe(1);
    expect(recoveryPaths).toEqual([]);
    const sentinelDelete = writes.find(
      (w) => w.channel === 'vault:delete' && String(w.args[1]).endsWith('.filo/.dirty.a1b2c3d4e5f6'),
    );
    expect(sentinelDelete).toBeDefined();
  });
});

// ── 4.2 — corrupt-config suppression reports failure honestly ───────────────
describe('Audit-18 4.2 — corrupt-config suppression is reported, not a silent clean no-op', () => {
  const BUNDLE_TARGETS = ['config:save-workspace', 'defaults.json', 'app.json', 'appearance.json'] as const;
  let captured: WriteErrorInfo[];

  const minimalSettings = (): ProjectSettings =>
    ({ general: {}, mindmap: {}, kanban: {}, tasklist: {}, document: {} } as unknown as ProjectSettings);
  const minimalWorkspace = (): WorkspaceState =>
    ({ openTabs: [], activeTabId: null } as unknown as WorkspaceState);

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    captured = [];
    setWriteErrorListener((info) => captured.push(info));
  });

  afterEach(() => {
    __resetDirtyTrackingForTests();
  });

  it('a changed-but-corrupt target is pushed onto `failed` and toasted ONCE', async () => {
    for (const t of BUNDLE_TARGETS) markCorruptConfigTarget(t);

    const first = await writeConfigs('/vault', minimalSettings(), 'light', minimalWorkspace());
    // Every corrupt target reports a failure (Ctrl+S aggregate / saveState 'error').
    for (const t of BUNDLE_TARGETS) expect(first.failed).toContain(t);
    // One honest toast per target, carrying the CONFIG_CORRUPT code.
    expect(captured).toHaveLength(BUNDLE_TARGETS.length);
    for (const info of captured) {
      expect(info.kind).toBe('config');
      expect((info.error as { code?: string }).code).toBe('CONFIG_CORRUPT');
    }

    // A second flush still reports the failure but does NOT re-toast.
    const second = await writeConfigs('/vault', minimalSettings(), 'light', minimalWorkspace());
    for (const t of BUNDLE_TARGETS) expect(second.failed).toContain(t);
    expect(captured).toHaveLength(BUNDLE_TARGETS.length); // unchanged — once-per-target
  });
});

// ── 4.6 — bulk-op success toasts are gated on the awaited outcome ───────────
/** Minimal real Command so cmds.length > 0; historyStore.execute is mocked. */
class NoopCommand extends Command {
  description = 'noop';
  readonly targetBoardId = 'b';
  execute(): void {}
  undo(): void {}
}

function taskRow(id: string): TaskRow {
  return {
    placement: { tileId: id, position: 0 },
    tile: { id, type: 'text', title: id } as unknown as Tile, // no filePath → no dedup
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
  } as TaskRow;
}

describe('Audit-18 4.6 — Task List bulk ops gate the success toast on the chain', () => {
  let toastSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    (window as unknown as Record<string, unknown>).filo = {
      invoke: async () => null,
      on: () => () => {},
      send: () => {},
    };
    toastSpy = vi.spyOn(uiStore, 'toast').mockImplementation(() => '' as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeController(rows: TaskRow[]): MultiSelectController {
    return new MultiSelectController({
      getBoard: () => ({ id: 'b' } as unknown as TaskListBoard),
      getRows: () => rows,
      getFilteredRows: () => rows,
      getPlacements: () => [],
      getSections: () => [],
      buildTaskFieldCommand: () => new NoopCommand() as never,
      bumpCacheVersion: () => {},
      tickAndPersist: () => {},
      announce: () => {},
    });
  }

  it('shows the success toast when the command chain RESOLVES', async () => {
    vi.spyOn(historyStore, 'execute').mockResolvedValue(undefined);
    const rows = [taskRow('a'), taskRow('b')];
    const c = makeController(rows);
    c.selectedTaskIds = new SvelteSet(['a', 'b']);
    c.bulkSetPriority('high');
    // clearSelection is synchronous; the toast is gated behind the settle.
    expect(c.selectedTaskIds.size).toBe(0);
    await flushMicrotasks();
    const successCalls = toastSpy.mock.calls.filter((args) => args[1] === 'success');
    expect(successCalls.length).toBeGreaterThan(0);
    expect(String(successCalls[0][0])).toContain('Priority set');
  });

  it('does NOT show the success toast when the chain REJECTS (write failed)', async () => {
    vi.spyOn(historyStore, 'execute').mockRejectedValue(new Error('disk full'));
    const rows = [taskRow('a'), taskRow('b')];
    const c = makeController(rows);
    c.selectedTaskIds = new SvelteSet(['a', 'b']);
    c.bulkSetPriority('high');
    // The selection still clears synchronously (UI bookkeeping), but...
    expect(c.selectedTaskIds.size).toBe(0);
    await flushMicrotasks();
    // ...no success toast: the chain's own reportError already surfaced the error.
    const successCalls = toastSpy.mock.calls.filter((args) => args[1] === 'success');
    expect(successCalls).toHaveLength(0);
  });
});

describe('Audit-18 4.6 — Kanban bulk Add tag gates the success toast on the chain', () => {
  let toastSpy: ReturnType<typeof vi.spyOn>;

  function makeMultiSelect() {
    const tiles: Record<string, Tile> = {
      a: { id: 'a', type: 'text', title: 'A', tags: [] } as unknown as Tile, // orphan (no filePath)
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
      promptForTag: () => Promise.resolve('urgent'),
    });
  }

  beforeEach(() => {
    noteStore.__resetForTests();
    historyStore.clear();
    historyStore.setActiveBoard('kb');
    toastSpy = vi.spyOn(uiStore, 'toast').mockImplementation(() => '' as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    historyStore.setActiveBoard(null);
    historyStore.clear();
    noteStore.__resetForTests();
  });

  it('toasts success only when the batch RESOLVES', async () => {
    vi.spyOn(historyStore, 'execute').mockResolvedValue(undefined);
    await makeMultiSelect().tagSelectedTiles();
    await flushMicrotasks();
    const successCalls = toastSpy.mock.calls.filter((args) => args[1] === 'success');
    expect(successCalls.length).toBeGreaterThan(0);
    expect(String(successCalls[0][0])).toContain('urgent');
  });

  it('does NOT toast success when the batch REJECTS', async () => {
    vi.spyOn(historyStore, 'execute').mockRejectedValue(new Error('disk full'));
    await makeMultiSelect().tagSelectedTiles();
    await flushMicrotasks();
    const successCalls = toastSpy.mock.calls.filter((args) => args[1] === 'success');
    expect(successCalls).toHaveLength(0);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeExternalChangesSlice } from '@renderer/stores/vaultExternalChanges';
import { documentStore } from '@renderer/stores/document.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import { fileTagsStore } from '@renderer/stores/fileTags.svelte';
import type { TagsFile } from '@renderer/schema/tagsFile';
import type { VaultContext } from '@renderer/stores/vaultStoreTypes';
import type { TaskListBoard as TaskListBoardType, Tile } from '@renderer/schema/index';
import type { TaskRow } from '@renderer/lib/tasks/taskListModel';
import {
  getBaseline,
  __resetBaselinesForTests,
} from '@renderer/lib/vault/fileBaselineRegistry';
import {
  __clearRecentSelfWritesForTests,
  __resetDirtyTrackingForTests,
  isPathPending,
} from '@renderer/lib/boards/writeStateTracking';
import { makeFrontmatterWriter } from '@renderer/lib/tasklist/frontmatterWriter';
import { makeTaskCreator } from '@renderer/lib/tasklist/taskCreation';
import { flushAllPendingFrontmatterWrites } from '@renderer/lib/boards/frontmatterWriteScheduler';
import { cancelAllMarkdownWrites } from '@renderer/lib/vault/markdownFileWriter';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Audit-8 Phase 3 — MEDIUM data-integrity fixes.
 */

interface Captured {
  channel: string;
  args: unknown[];
}

function lastMarkdownWrite(captured: Captured[]): string | undefined {
  for (let i = captured.length - 1; i >= 0; i--) {
    if (captured[i].channel === 'vault:write-existing-file-text') {
      return captured[i].args[2] as string;
    }
  }
  return undefined;
}

function ctxFor(): VaultContext {
  return {
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
    getRecoveryPendingPaths: () => [],
    setRecoveryPendingPaths: () => {},
    markMetaDirty: () => {},
    refreshTree: async () => {},
    clearSelection: () => {},
    clearActiveRootFolderIfMatches: () => {},
  };
}

function byteLen(text: string): number {
  return new TextEncoder().encode(text).length;
}

function clearToasts(): void {
  for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id);
}

// ── A8-M2 — sync-frontmatter re-stamps the drift baseline ────────────────

describe('A8-M2 — sync-frontmatter reconcile re-stamps the drift baseline', () => {
  // Same body, different frontmatter → classifyExternalChange returns
  // sync-frontmatter (frontmatter-only). The body never reloads, so this branch
  // is the ONLY place the per-file (mtime,size) baseline can re-anchor; without
  // the fix the stale baseline makes the next in-app save's pre-write drift
  // check fire a false "modified externally" prompt.
  const BODY = '# Heading\n\nA paragraph that does not change.\n';
  const v1 = `---\ntitle: Note\nstatus: draft\n---\n${BODY}`;
  const v2 = `---\ntitle: Note\nstatus: published\n---\n${BODY}`;

  beforeEach(() => {
    documentStore.clear();
    vaultIndexStore.clear();
    __resetBaselinesForTests();
    __clearRecentSelfWritesForTests();
    clearToasts();
    vaultStore.setPath('/vault');
  });

  afterEach(() => {
    restoreFiloDefault();
    documentStore.clear();
    vaultIndexStore.clear();
    __resetBaselinesForTests();
    clearToasts();
    vaultStore.setPath('');
  });

  it('stamps the post-sync (mtime,size) when no editor is open (Kanban card / un-opened file)', async () => {
    const slice = makeExternalChangesSlice(ctxFor());

    // Index the original version (becomes `previous`).
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') return { success: true, content: v1, mtimeMs: 1 };
      return { success: true };
    });
    await vaultIndexStore.applyChanges(['Card.md']);
    // No baseline yet (no hydrate read seeded one in this unit context).
    expect(getBaseline('Card.md')).toBeUndefined();

    // External FM-only edit lands with a fresh mtime.
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') return { success: true, content: v2, mtimeMs: 2 };
      return { success: true };
    });
    await slice.handleExternalMarkdownChanges(['Card.md']);

    // The baseline now equals the just-read disk identity, so the next field
    // edit's pre-write stat (mtime 2, that size) won't re-detect drift.
    expect(getBaseline('Card.md')).toEqual({ mtimeMs: 2, size: byteLen(v2) });
  });

  it('stamps the post-sync identity even with a clean editor open', async () => {
    const slice = makeExternalChangesSlice(ctxFor());

    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') return { success: true, content: v1, mtimeMs: 10 };
      return { success: true };
    });
    await vaultIndexStore.applyChanges(['Open.md']);
    documentStore.loadDocument({
      filename: 'Open.md',
      title: 'Open',
      body: BODY,
      htmlContent: '',
      richText: [],
    });

    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') return { success: true, content: v2, mtimeMs: 20 };
      return { success: true };
    });
    await slice.handleExternalMarkdownChanges(['Open.md']);

    // Editor body untouched (FM-only change), and the baseline re-anchored.
    expect(documentStore.getDocument('Open.md')?.body).toBe(BODY);
    expect(getBaseline('Open.md')).toEqual({ mtimeMs: 20, size: byteLen(v2) });
  });
});

// ── A8-M3(a) — Task notes body: arm the write before the seed await ──────

describe('A8-M3(a) — setNotesBody arms the write BEFORE the disk-FM seed await', () => {
  let captured: Captured[];
  let order: string[];
  let releaseRead: () => void;
  let readGate: Promise<void>;
  const DISK = '---\ntitle: T\npriority: high\n---\nold body';

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
    vaultIndexStore.clear();
    __resetBaselinesForTests();
    vaultStore.setPath('/vault');
    captured = [];
    order = [];
    releaseRead = () => {};
    readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    installFiloMock(async (channel: string, ...args: unknown[]) => {
      captured.push({ channel, args });
      if (channel === 'vault:read-file-text') {
        order.push('read');
        // Gate the seed read so setNotesBody is suspended mid-seed when we
        // observe the pending state below.
        await readGate;
        return { success: true, content: DISK, mtimeMs: 5, size: byteLen(DISK) };
      }
      if (channel === 'vault:stat') return { success: true, mtimeMs: 5, size: byteLen(DISK) };
      if (channel === 'vault:write-existing-file-text') return { success: true };
      return { success: true };
    });
  });

  afterEach(() => {
    releaseRead();
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
    vaultIndexStore.clear();
    __resetBaselinesForTests();
    vaultStore.setPath('');
  });

  function makeWriter() {
    return makeFrontmatterWriter({
      getBoard: () =>
        ({ id: 'tl', type: 'tasklist', settings: {} }) as unknown as TaskListBoardType,
      vaultPathForTile: () => 'Task.md',
      readFrontmatter: () => ({ completed: false }),
      bumpCacheVersion: () => {},
    });
  }

  function makeRow(): TaskRow {
    return {
      placement: { tileId: 'tn', position: 0 },
      tile: { id: 'tn', type: 'text', filePath: 'Task.md', title: 'Task', tags: [] } as unknown as Tile,
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
    };
  }

  it('the write is pending while the seed read is still in flight', async () => {
    const writer = makeWriter();
    // Fire the notes edit WITHOUT awaiting (mirrors a keystroke). The FM cache
    // is empty (first touch), so the seed read fires and gates the function.
    const p = writer.setNotesBody(makeRow(), 'My typed notes');
    await new Promise((r) => setTimeout(r, 0));

    // The seed read is in flight…
    expect(order).toContain('read');
    // …and yet the frontmatter write is ALREADY armed (A8-M3(a)): a quit-drain
    // here would find + flush it. Pre-fix the schedule ran only AFTER the seed
    // await, so this was false and a quit dropped the notes with a clean sentinel.
    expect(isPathPending('Task.md')).toBe(true);
    // The new body is already live in the cache, so the armed write captures it.
    expect(documentStore.getDocument('Task.md')?.body).toBe('My typed notes');

    releaseRead();
    await p;

    // End-to-end: the body reaches disk and the externally-added FM key survives
    // (the seed refreshed FM from disk before the write assembled).
    await vi.waitFor(
      async () => {
        await flushAllPendingFrontmatterWrites();
        expect(lastMarkdownWrite(captured), 'no markdown write captured').toBeDefined();
      },
      { timeout: 1000, interval: 20 },
    );
    const written = lastMarkdownWrite(captured);
    expect(written).toContain('My typed notes');
    expect(written).toContain('priority: high');
  });
});

// ── A8-M3(b) — quick-add task: dispatch the placement before the seed ────

describe('A8-M3(b) — task creation dispatches the placement BEFORE the seed await', () => {
  let order: string[];

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
    boardCacheStore.clear();
    vaultIndexStore.clear();
    vaultStore.setPath('/vault');
    order = [];
    installFiloMock((channel: string) => {
      if (channel === 'vault:write-file-text') {
        order.push('seed-write');
        return { success: true };
      }
      if (channel === 'vault:read-file-text') {
        return { success: true, content: '---\ncompleted: false\n---\n', mtimeMs: 1, size: 24 };
      }
      if (channel === 'vault:stat') return { success: true, mtimeMs: 1, size: 24 };
      return { success: true };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
    boardCacheStore.clear();
    vaultIndexStore.clear();
    vaultStore.setPath('');
  });

  function makeCreator() {
    return makeTaskCreator({
      getBoard: () =>
        ({ id: 'tl', type: 'tasklist', settings: {} }) as unknown as TaskListBoardType,
      getSections: () => [],
      getPlacements: () => [],
      getRows: () => [],
      getCollapsedSubtasks: () => new Set<string>(),
      getLastTargetedSectionId: () => null,
      setLastTargetedSectionId: () => {},
      ensureDefaultSectionMaterialized: () => null,
      persistCollapsedSubtasks: () => {},
      tickAndPersist: () => {},
      announce: () => {},
      defaultSectionId: 'default',
    });
  }

  it('AddTaskCommand persists the placement before the (now on-chain) seed .md write fires', async () => {
    // A9-M3 (Audit-9) SUPERSEDES A8-M3(b)'s "dispatch then a separate seed await"
    // shape: the `.md` seed is now folded INTO AddTaskCommand.execute() (its last
    // constructor arg) so it rides the SAME history chain the placement does.
    // execute() persists the placement SYNCHRONOUSLY (before its first await) and
    // only then awaits the seed — so the dispatch still precedes the seed write,
    // now BY CONSTRUCTION inside one chained command (quit drains both). Run the
    // real command body so the folded seed actually fires.
    boardCacheStore.hydrate(
      {
        tl: {
          board: {
            id: 'tl',
            type: 'tasklist',
            name: 'T',
            emoji: '',
            createdAt: 0,
            updatedAt: 0,
            settings: { groupBy: 'status', sortBy: 'manual' },
            sections: [],
            tasks: [],
          } as unknown as TaskListBoardType,
          tileDefs: {},
          connections: {},
          frames: [],
        },
      },
      { tl: 'tl.board.json' },
    );
    vi.spyOn(historyStore, 'execute').mockImplementation((async (cmd: {
      execute: () => Promise<void>;
    }): Promise<void> => {
      order.push('dispatch');
      // Run the real command so its folded-in seed thunk fires.
      await cmd.execute();
    }) as never);

    const creator = makeCreator();
    await creator.addTaskFromQuickAdd({
      title: 'Buy milk',
      tags: [],
      priority: '',
      dueDate: '',
      dueTime: '',
      startDate: '',
      status: '',
    } as never);

    // Both ran, and the placement (recorded as 'dispatch' at the chained-command
    // entry, persisted before the command's first await) preceded the seed write
    // — so a quit inside the seed await leaves the placement on the chain, not an
    // orphan .md.
    expect(order).toContain('dispatch');
    expect(order).toContain('seed-write');
    expect(order.indexOf('dispatch')).toBeLessThan(order.indexOf('seed-write'));
  });
});

// ── A8-M6 — external tags.json reload merges instead of replacing ─────────

describe('A8-M6 — applyExternalReload merges un-flushed tag mutations', () => {
  let savedSnapshots: string[];

  beforeEach(() => {
    savedSnapshots = [];
    installFiloMock((channel: string, ...args: unknown[]) => {
      if (channel === 'tags:save') {
        savedSnapshots.push(String(args[1]));
        return undefined;
      }
      return { success: true };
    });
  });

  afterEach(() => {
    restoreFiloDefault();
    fileTagsStore.reset();
  });

  function reloadResult(file: TagsFile) {
    return { file, fromFuture: false, noMigrationPath: false, corrupt: false };
  }

  it('a pending attachment-tag add survives an external reload that lacks it', async () => {
    // Disk baseline: one registry tag, no file tags.
    const base: TagsFile = { version: 1, tags: { project: { color: '#f00' } }, fileTags: {} };
    fileTagsStore.commitFromCandidate('/vault', base);

    // User tags an attachment (image.png) — attachment tags have NO other home.
    // This arms the ~300 ms save debounce; nothing has flushed to disk yet.
    fileTagsStore.setFileTags('image.png', ['urgent']);
    expect(fileTagsStore.file.fileTags['image.png']).toEqual(['urgent']);

    // Meanwhile an external process rewrites tags.json: it added a registry tag
    // and (not knowing about our in-flight edit) carries NO file tags.
    fileTagsStore.applyExternalReload(
      reloadResult({
        version: 1,
        tags: { project: { color: '#f00' }, external: { color: '#0f0' } },
        fileTags: {},
      }),
    );

    // The pending attachment tag SURVIVED (pre-fix `file = loaded.file` dropped
    // it), AND the external registry addition was absorbed.
    expect(fileTagsStore.file.fileTags['image.png']).toEqual(['urgent']);
    expect(fileTagsStore.file.tags).toHaveProperty('external');
    expect(fileTagsStore.file.tags).toHaveProperty('project');

    // …and the next save persists the merged state (not the external copy).
    await fileTagsStore.flush();
    const lastSave = savedSnapshots[savedSnapshots.length - 1];
    expect(lastSave).toBeDefined();
    const persisted = JSON.parse(lastSave) as TagsFile;
    expect(persisted.fileTags['image.png']).toEqual(['urgent']);
    expect(persisted.tags).toHaveProperty('external');
  });

  it('takes the external value for entries our pending delta did not touch', async () => {
    const base: TagsFile = {
      version: 1,
      tags: {},
      fileTags: { 'a.png': ['old'], 'b.png': ['keep'] },
    };
    fileTagsStore.commitFromCandidate('/vault', base);

    // We only re-tag a.png; b.png is untouched in memory.
    fileTagsStore.setFileTags('a.png', ['mine']);

    // External edit changes b.png (untouched by us) and leaves a.png at base.
    fileTagsStore.applyExternalReload(
      reloadResult({
        version: 1,
        tags: {},
        fileTags: { 'a.png': ['old'], 'b.png': ['external'] },
      }),
    );

    // Our pending change to a.png wins; the external change to the untouched
    // b.png is taken.
    expect(fileTagsStore.file.fileTags['a.png']).toEqual(['mine']);
    expect(fileTagsStore.file.fileTags['b.png']).toEqual(['external']);
  });
});

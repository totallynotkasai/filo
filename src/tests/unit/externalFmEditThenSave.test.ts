import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeExternalChangesSlice } from '@renderer/stores/vaultExternalChanges';
import { noteStore } from '@renderer/stores/notes.svelte';
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
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { patchToFrontmatterDelta } from '@renderer/lib/vault/frontmatterDelta';
import { makeFrontmatterWriter } from '@renderer/lib/tasklist/frontmatterWriter';
import { makeTaskCreator } from '@renderer/lib/tasklist/taskCreation';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';

/**
 * Data-integrity fixes around external edits and task creation.
 */

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
    resolveRecoveryDismissed: () => {},
    markMetaDirty: () => {},
    refreshTree: async () => {},
    clearSelection: () => {},
    clearActiveRootFolderIfMatches: () => {},
  };
}

function clearToasts(): void {
  for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

// ── an external frontmatter-only edit never makes the next save prompt ──────────

describe('after an external frontmatter-only edit, the next in-app save lands without a prompt', () => {
  // Same body, different frontmatter: the body never reloads, and the next
  // in-app save must neither re-detect that edit as a conflict nor drop it.
  const BODY = '# Heading\n\nA paragraph that does not change.\n';
  const v1 = `---\ntitle: Note\nstatus: draft\n---\n${BODY}`;
  const v2 = `---\ntitle: Note\nstatus: published\n---\n${BODY}`;
  let vault: MemoryVault;

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    noteStore.__resetForTests();
    vaultIndexStore.clear();
    clearToasts();
    vaultStore.setPath('/vault');
    vault = installMemoryVault({ 'Card.md': v1, 'Open.md': v1 });
  });

  afterEach(() => {
    noteStore.__resetForTests();
    vaultIndexStore.clear();
    clearToasts();
    vaultStore.setPath('');
    restoreFiloDefault();
  });

  it('no editor open (Kanban card / un-opened file): the next field edit keeps the external key', async () => {
    const slice = makeExternalChangesSlice(ctxFor());
    await vaultIndexStore.applyChanges(['Card.md']);

    vault.writeExternally('Card.md', v2);
    await slice.handleExternalMarkdownChanges(['Card.md']);
    expect(noteStore.frontmatter('Card.md').status).toBe('published');

    noteStore.patchFrontmatter('Card.md', patchToFrontmatterDelta({ priority: 'high' }));
    expect(await noteStore.flush('Card.md')).toBe(true);
    expect(vault.read('Card.md')).toBe(`---\ntitle: Note\nstatus: published\npriority: high\n---\n${BODY}`);
    expect(uiStore.toasts).toHaveLength(0);
  });

  it('a clean editor open: the body stays, the frontmatter follows, and the next keystroke saves', async () => {
    const slice = makeExternalChangesSlice(ctxFor());
    await vaultIndexStore.applyChanges(['Open.md']);
    const m = noteStore.acquire('Open.md', 'doc');
    await m.loaded;
    const rev = m.bodyRevision;

    vault.writeExternally('Open.md', v2);
    await slice.handleExternalMarkdownChanges(['Open.md']);
    await settle();

    expect(m.body).toBe(BODY);
    expect(m.bodyRevision).toBe(rev);
    expect(m.frontmatter.status).toBe('published');

    noteStore.setBody('Open.md', `${BODY}\nMore.`, 'doc');
    expect(await noteStore.flush('Open.md')).toBe(true);
    expect(m.status).toBe('ready');
    expect(uiStore.toasts).toHaveLength(0);
    expect(vault.read('Open.md')).toBe(`---\ntitle: Note\nstatus: published\n---\n${BODY}\nMore.\n`);
  });
});

// ── Task notes body reaches disk and keeps the disk frontmatter ─────────────

describe('setNotesBody writes the notes onto the note as it is on disk', () => {
  let vault: MemoryVault;
  const DISK = '---\ntitle: T\npriority: high\n---\nold body\n';

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    noteStore.__resetForTests();
    vaultIndexStore.clear();
    vaultStore.setPath('/vault');
    vault = installMemoryVault({ 'Task.md': DISK });
  });

  afterEach(() => {
    noteStore.__resetForTests();
    vaultIndexStore.clear();
    vaultStore.setPath('');
    restoreFiloDefault();
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

  it('the notes reach disk and the frontmatter key already on disk survives', async () => {
    const writer = makeWriter();
    await writer.setNotesBody(makeRow(), 'My typed notes');
    await noteStore.flushAll();

    const written = vault.read('Task.md') ?? '';
    expect(written).toContain('My typed notes');
    expect(written).toContain('priority: high');
    expect(written).toBe('---\ntitle: T\npriority: high\n---\nMy typed notes\n');
  });
});

// ── quick-add task: dispatch the placement before the seed ───────────────

describe('task creation dispatches the placement BEFORE the seed await', () => {
  let order: string[];

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    noteStore.__resetForTests();
    boardCacheStore.clear();
    vaultIndexStore.clear();
    vaultStore.setPath('/vault');
    order = [];
    installFiloMock((channel: string) => {
      if (channel === 'vault:create-file-text') {
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
    noteStore.__resetForTests();
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
    // This SUPERSEDES the "dispatch then a separate seed await" shape above:
    // the `.md` seed is now folded INTO AddTaskCommand.execute() (its last
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

// ── external tags.json reload merges instead of replacing ─────────────────

describe('applyExternalReload merges un-flushed tag mutations', () => {
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

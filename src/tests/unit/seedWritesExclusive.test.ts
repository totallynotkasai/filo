/**
 * Audit-19 BL-1 — new Kanban cards, new tasks and Task-List OS drops must never
 * overwrite an existing vault file. Every seed goes through the create-exclusive
 * `vault:create-file-text` channel; the fake below implements it with a
 * CASE-INSENSITIVE EEXIST (NTFS semantics) over an in-memory file map and fails
 * the test if the overwrite-capable `vault:write-file-text` is ever used for a
 * seed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { documentStore } from '@renderer/stores/document.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import { makeTaskCreator } from '@renderer/lib/tasklist/taskCreation';
import { makeKanbanTileCreator } from '@renderer/lib/kanban/kanbanTileCreation';
import { makeFileDropHandler } from '@renderer/lib/tasklist/fileDropHandler';
import { cancelAllMarkdownWrites } from '@renderer/lib/vault/markdownFileWriter';
import {
  __resetDirtyTrackingForTests,
  hasFailedWrites,
  isRecentSelfWrite,
  markPathFailed,
  __clearRecentSelfWritesForTests,
} from '@renderer/lib/boards/writeStateTracking';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import type {
  KanbanBoard as KanbanBoardType,
  TaskListBoard as TaskListBoardType,
  TileDefinition,
} from '@renderer/schema/index';
import type { FileTreeNode } from '@shared/types';

const VAULT = '/vault';

let files: Map<string, string>;
let seedOverwrites: string[];
let createFailure: string | null;

function key(p: string): string {
  return p.toLowerCase();
}

function installVault(initial: Record<string, string>, opts: { tree?: string[] } = {}): void {
  files = new Map(Object.entries(initial));
  seedOverwrites = [];
  createFailure = null;
  const treePaths = opts.tree ?? Object.keys(initial);
  const tree: FileTreeNode[] = treePaths.map((p) => ({
    name: p.split('/').pop() ?? p,
    path: `${VAULT}/${p}`,
    isDirectory: false,
  }));
  vaultStore.setTree(tree);
  installFiloMock((channel: unknown, ...args: unknown[]) => {
    const ch = String(channel);
    const rel = String(args[1] ?? '');
    if (ch === 'vault:create-file-text') {
      if (createFailure) return { success: false, code: createFailure, error: createFailure };
      const existing = [...files.keys()].find((k) => key(k) === key(rel));
      if (existing) return { success: false, code: 'EEXIST', error: 'file already exists' };
      files.set(rel, String(args[2] ?? ''));
      return { success: true, path: `${VAULT}/${rel}` };
    }
    if (ch === 'vault:write-file-text') {
      if (!rel.startsWith('.filo/')) seedOverwrites.push(rel);
      return { success: true };
    }
    if (ch === 'vault:read-file-text') {
      const content = files.get(rel);
      if (content === undefined) return { success: false, code: 'ENOENT', error: 'ENOENT' };
      return { success: true, content, mtimeMs: 1, size: content.length };
    }
    if (ch === 'vault:stat') return { success: true, mtimeMs: 1, size: 1 };
    if (ch === 'vault:read-tree') return { ok: true, tree };
    return { success: true, ok: true };
  });
}

function taskBoard(): TaskListBoardType {
  return {
    id: 'tl',
    type: 'tasklist',
    name: 'T',
    emoji: '',
    createdAt: 0,
    updatedAt: 0,
    settings: { groupBy: 'status', sortBy: 'manual' },
    sections: [],
    tasks: [],
  } as unknown as TaskListBoardType;
}

function kanbanBoard(): KanbanBoardType {
  return {
    id: 'kb',
    type: 'kanban',
    name: 'K',
    emoji: '',
    createdAt: 0,
    updatedAt: 0,
    settings: {},
    columns: [{ id: 'c1', title: 'Todo', position: 0, collapsed: false, tilePlacements: [] }],
  } as unknown as KanbanBoardType;
}

function hydrateBoards(): { tl: TaskListBoardType; kb: KanbanBoardType } {
  const tl = taskBoard();
  const kb = kanbanBoard();
  boardCacheStore.hydrate(
    {
      tl: { board: tl, tileDefs: {}, connections: {}, frames: [] },
      kb: { board: kb, tileDefs: {}, connections: {}, frames: [] },
    },
    { tl: 'tl.board.json', kb: 'kb.board.json' },
  );
  return { tl, kb };
}

function taskCreator(board: TaskListBoardType) {
  return makeTaskCreator({
    getBoard: () => board,
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

function kanbanCreator(board: KanbanBoardType) {
  let col: string | null = 'c1';
  return makeKanbanTileCreator({
    getBoard: () => boardCacheStore.cache.kb?.board as KanbanBoardType ?? board,
    getNewTileColumnId: () => col,
    setNewTileColumnId: (n) => { col = n; },
    setTemplatePickerColumnId: () => {},
    getTemplatePickerColumnId: () => 'c1',
    tickAndPersist: () => {},
    announce: () => {},
  });
}

function textDefs(boardId: string): Array<TileDefinition & { filePath?: string }> {
  return Object.values(boardCacheStore.cache[boardId]?.tileDefs ?? {}).filter(
    (d) => (d as { type?: string }).type === 'text',
  ) as Array<TileDefinition & { filePath?: string }>;
}

function quickAdd(title: string) {
  return { title, tags: [], priority: undefined, dueDate: undefined } as unknown as Parameters<
    ReturnType<typeof taskCreator>['addTaskFromQuickAdd']
  >[0];
}

describe('Audit-19 BL-1 — seed writes are create-exclusive', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    __clearRecentSelfWritesForTests();
    restoreFiloDefault();
    documentStore.clear();
    boardCacheStore.clear();
    vaultIndexStore.clear();
    vaultStore.setPath(VAULT);
    vi.spyOn(historyStore, 'execute').mockImplementation((async (cmd: {
      execute: () => Promise<void> | void;
    }): Promise<void> => {
      await cmd.execute();
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
    boardCacheStore.clear();
    vaultIndexStore.clear();
    vaultStore.setTree([]);
    vaultStore.setPath('');
  });

  it('(1) Kanban createTile with an off-board New Card.md → New Card (2).md, original intact', async () => {
    installVault({ 'New Card.md': 'mine\n' });
    const { kb } = hydrateBoards();
    await kanbanCreator(kb).createTile('text');
    expect(files.get('New Card.md')).toBe('mine\n');
    expect(textDefs('kb').map((d) => d.filePath)).toEqual(['New Card (2).md']);
    expect(seedOverwrites).toEqual([]);
  });

  it('(2) a name missing from the tree snapshot still bumps on EEXIST (Kanban)', async () => {
    installVault({ 'New Card.md': 'mine\n' }, { tree: [] });
    const { kb } = hydrateBoards();
    await kanbanCreator(kb).createTile('text');
    expect(files.get('New Card.md')).toBe('mine\n');
    const [def] = textDefs('kb');
    expect(def.filePath).toBe('New Card (2).md');
    expect(def.title).toBe('New Card (2)');
  });

  it('(3) a template card re-interpolates {{title}} with the bumped name', async () => {
    installVault({ 'Meeting.md': 'old\n' }, { tree: [] });
    const { kb } = hydrateBoards();
    await kanbanCreator(kb).createTileFromTemplate(
      { name: 'Meeting' } as never,
      { frontmatter: {}, bodyWithoutBoardBlock: '# {{title}}\n', body: '# {{title}}\n' } as never,
      '',
    );
    expect(files.get('Meeting.md')).toBe('old\n');
    expect(files.get('Meeting (2).md')).toContain('# Meeting (2)');
  });

  it('(4) quick-add "Groceries" with Groceries.md in the vault → Groceries (2).md', async () => {
    installVault({ 'Groceries.md': 'milk\n' });
    const { tl } = hydrateBoards();
    await taskCreator(tl).addTaskFromQuickAdd(quickAdd('Groceries'));
    expect(files.get('Groceries.md')).toBe('milk\n');
    expect(textDefs('tl').map((d) => d.filePath)).toEqual(['Groceries (2).md']);
    expect(seedOverwrites).toEqual([]);
  });

  it('(5) case-only clash missing from the stale tree: EEXIST bump re-stamps the cached task def', async () => {
    installVault({ 'Groceries.md': 'milk\n' }, { tree: [] });
    const { tl } = hydrateBoards();
    await taskCreator(tl).addTaskFromQuickAdd(quickAdd('groceries'));
    expect(files.get('Groceries.md')).toBe('milk\n');
    const [def] = textDefs('tl');
    expect(def.filePath).toBe('groceries (2).md');
    expect(def.title).toBe('groceries (2)');
    expect(files.has('groceries (2).md')).toBe(true);
  });

  it('(5b) quick-add "Email the landlord." creates a legal name (Audit-19 ERR-2)', async () => {
    installVault({});
    const { tl } = hydrateBoards();
    await taskCreator(tl).addTaskFromQuickAdd(quickAdd('Email the landlord.'));
    expect(textDefs('tl').map((d) => d.filePath)).toEqual(['Email the landlord.md']);
  });

  it('(6) OS drop of README.md onto a Task List with README.md in the vault → README (2).md', async () => {
    installVault({ 'README.md': 'original\n' });
    const { tl } = hydrateBoards();
    const handler = makeFileDropHandler({
      getBoard: () => tl,
      getSections: () => [],
      getPlacements: () => [],
      getTilesById: () => ({}),
      ensureDefaultSectionMaterialized: () => null,
      tickAndPersist: () => {},
      defaultSectionId: 'default',
    });
    const file = new File(['dropped\n'], 'README.md', { type: 'text/markdown' });
    const dt = { types: ['Files'], files: [file], getData: () => '' } as unknown as DataTransfer;
    const e = { dataTransfer: dt, preventDefault: () => {}, stopPropagation: () => {}, clientY: null } as unknown as DragEvent;
    await handler.onSectionBodyDrop(e, null);
    await new Promise((r) => setTimeout(r, 0));
    expect(files.get('README.md')).toBe('original\n');
    expect(files.get('README (2).md')).toBe('dropped\n');
    expect(seedOverwrites).toEqual([]);
  });

  it('(7) a losing EEXIST attempt leaves the existing path failed + not a self-write', async () => {
    installVault({ 'Groceries.md': 'milk\n' }, { tree: [] });
    markPathFailed(VAULT, 'Groceries.md');
    const { tl } = hydrateBoards();
    await taskCreator(tl).addTaskFromQuickAdd(quickAdd('Groceries'));
    expect(hasFailedWrites()).toBe(true);
    expect(isRecentSelfWrite('Groceries.md')).toBe(false);
    expect(isRecentSelfWrite('Groceries (2).md')).toBe(true);
  });

  it('(MD-3) a new task seeds the store with a body-only "" body, not the full FM file', async () => {
    installVault({});
    const { tl } = hydrateBoards();
    await taskCreator(tl).addTaskFromQuickAdd(quickAdd('Buy milk'));
    const [def] = textDefs('tl');
    const docId = (def as { contentId?: string }).contentId ?? '';
    expect(files.get('Buy milk.md')).toContain('completed: false');
    expect(documentStore.getDocument(docId)?.body).toBe('');
  });

  it('(8) a non-EEXIST failure rolls the task back and does not add a Kanban card', async () => {
    installVault({});
    createFailure = 'EACCES';
    const { tl, kb } = hydrateBoards();
    await taskCreator(tl).addTaskFromQuickAdd(quickAdd('Blocked'));
    expect(boardCacheStore.cache.tl?.board && (boardCacheStore.cache.tl.board as TaskListBoardType).tasks).toEqual([]);
    await kanbanCreator(kb).createTile('text');
    expect(textDefs('kb')).toEqual([]);
  });
});

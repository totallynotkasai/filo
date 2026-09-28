/**
 * A connection label being edited is saved by the save before leaving or
 * quitting (and Ctrl+S), and by the view closing, instead of being dropped
 * because it was never committed with Enter or a click away.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount } from 'svelte';
import ConnectionLabel from '@renderer/components/connections/ConnectionLabel.svelte';
import { BOARD_SCOPE_KEY, getActiveScope } from '@renderer/lib/boards/boardScope.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import { flushAllComponents, __resetComponentFlushesForTests } from '@renderer/lib/boards/componentFlush';
import { tiptapToolbar } from '@renderer/lib/editor/toolbarConfig';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { Connection, MindMapBoard } from '@renderer/schema/index';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import { settle } from './helpers/mountEditor';
import { seedBoard } from '../helpers/seedBoard';

const CONN: Connection = {
  id: 'c1', boardId: 'mm', fromTileId: 'a', toTileId: 'b', fromBubble: 3, toBubble: 7,
  pathColor: '', arrowColor: '', visibility: 'visible', labelVisibility: 'visible',
  label: { text: 'Old', content: '<p>Old</p>', textColor: '', backgroundColor: '', position: 0.5, locked: false },
  createdAt: 0, updatedAt: 0,
} as Connection;

function fixture(): BoardFileData {
  return {
    version: 8,
    board: {
      id: 'mm', type: 'mindmap', name: 'Map', emoji: '', createdAt: 0, updatedAt: 0, settings: {},
      placements: {}, inlineTiles: {}, waypoints: [], groups: [],
    } as unknown as MindMapBoard,
    tileDefs: {},
    connections: { c1: structuredClone(CONN) },
    frames: [],
  } as BoardFileData;
}

let instance: ReturnType<typeof mount> | null = null;

/** A path the label can sit on (jsdom has no SVG geometry). */
function pathElement(): SVGPathElement {
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  Object.assign(path, { getTotalLength: () => 100, getPointAtLength: () => ({ x: 50, y: 50 }) });
  return path;
}

async function editLabel(text: string): Promise<void> {
  const target = document.createElement('div');
  document.body.appendChild(target);
  instance = mount(ConnectionLabel, {
    target,
    props: { connection: boardCacheStore.cache.mm!.connections.c1!, pathElement: pathElement(), editing: true },
    context: new Map<unknown, unknown>([[BOARD_SCOPE_KEY, getActiveScope()]]),
  });
  await settle();
  const editor = tiptapToolbar.activeEditor;
  if (!editor) throw new Error('the label editor did not open');
  editor.commands.setContent(`<p>${text}</p>`);
  await settle();
}

function savedLabel(): string {
  return boardCacheStore.cache.mm!.connections.c1!.label.text;
}

beforeEach(() => {
  installFiloMock(() => null);
  __resetComponentFlushesForTests();
  vaultStore.setPath('/vault');
  boardCacheStore.clear();
  boardStore.clearBoard();
  const f = fixture();
  boardCacheStore.hydrate({ mm: f }, { mm: 'map.board.json' });
  seedBoard(boardStore, f.board, {}, {}, []);
  historyStore.clear();
  historyStore.setActiveBoard('mm');
});

afterEach(() => {
  if (instance) unmount(instance);
  instance = null;
  historyStore.clear();
  historyStore.setActiveBoard(null);
  boardCacheStore.clear();
  boardStore.clearBoard();
  vaultStore.setPath('');
  restoreFiloDefault();
  document.body.innerHTML = '';
});

describe('a connection label being edited', () => {
  it('is saved by the save (leave, quit, Ctrl+S) as one undo step', async () => {
    await editLabel('New label');
    await flushAllComponents();
    await historyStore.whenChainSettled();
    expect(savedLabel()).toBe('New label');
    await historyStore.undo();
    expect(savedLabel()).toBe('Old');
  });

  it('is saved when the view closes while it is open', async () => {
    await editLabel('Closed mid-edit');
    unmount(instance!);
    instance = null;
    expect(savedLabel()).toBe('Closed mid-edit');
  });

  it('an unchanged label writes nothing', async () => {
    await editLabel('Old');
    const before = boardCacheStore.cache.mm!.connections.c1;
    await flushAllComponents();
    unmount(instance!);
    instance = null;
    expect(boardCacheStore.cache.mm!.connections.c1).toBe(before);
    expect(historyStore.canUndo).toBe(false);
  });
});

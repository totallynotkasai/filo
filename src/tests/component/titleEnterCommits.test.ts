/**
 * Enter in a tile, frame or connection title commits it as one line. The
 * title editor's own Enter ran first and split the title where the caret was
 * ("Chap" and "ter One"), so clicking into a title to fix a typo and pressing
 * Enter saved it on two lines. An IME's Enter confirms its composition and
 * leaves the edit open.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { Editor } from '@tiptap/core';
import TileHeader from '@renderer/components/tiles/TileHeader.svelte';
import FrameComponent from '@renderer/components/frames/Frame.svelte';
import ConnectionLabel from '@renderer/components/connections/ConnectionLabel.svelte';
import { BOARD_SCOPE_KEY, getActiveScope } from '@renderer/lib/boards/boardScope.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import { __resetComponentFlushesForTests } from '@renderer/lib/boards/componentFlush';
import type { Connection, Frame, MindMapBoard, Tile } from '@renderer/schema/index';
import { installFiloMock } from '../helpers/filoBridge';
import { seedBoard } from '../helpers/seedBoard';
import { settle, resetEditorHarness, teardownEditorHarness } from './helpers/mountEditor';

const BOARD = {
  id: 'mm', type: 'mindmap', name: 'Map', emoji: '', createdAt: 0, updatedAt: 0, settings: {},
  placements: {}, inlineTiles: {}, waypoints: [], groups: [],
} as unknown as MindMapBoard;

// A link tile owns its title on the board, so a commit shows there at once.
const TILE = {
  id: 't1', boardId: 'mm', type: 'link', title: 'Chapter One', url: 'https://example.com',
  position: { x: 0, y: 0 }, size: { width: 200, height: 120 },
  style: { headerColor: '', bodyColor: '', borderColor: '' },
  locked: false, tags: [], createdAt: 0, updatedAt: 0,
} as unknown as Tile;

const FRAME = {
  id: 'f1', boardId: 'mm', title: 'Act Two', position: { x: 0, y: 0 }, size: { width: 300, height: 300 },
  style: { backgroundImage: '', borderColor: '' }, collapsed: false, tileIds: [], createdAt: 0, updatedAt: 0,
} as unknown as Frame;

const CONN = {
  id: 'c1', boardId: 'mm', fromTileId: 'a', toTileId: 'b', fromBubble: 3, toBubble: 7,
  pathColor: '', arrowColor: '', visibility: 'visible', labelVisibility: 'visible',
  label: { text: 'Leads to', content: '<p>Leads to</p>', textColor: '', backgroundColor: '', position: 0.5, locked: false },
  createdAt: 0, updatedAt: 0,
} as unknown as Connection;

const mounted: Array<Record<string, unknown>> = [];

function context(): Map<unknown, unknown> {
  return new Map<unknown, unknown>([[BOARD_SCOPE_KEY, getActiveScope()]]);
}

function host(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

function editorIn(root: ParentNode, sel: string): { editor: Editor; dom: HTMLElement } | null {
  const dom = root.querySelector(`${sel} .ProseMirror`) as (HTMLElement & { editor?: Editor }) | null;
  return dom?.editor ? { editor: dom.editor, dom } : null;
}

/** Double-clicks the title open and puts the caret at `caret`, as a click into the word does. */
async function openAt(root: HTMLElement, titleSel: string, editorSel: string, caret: number): Promise<{ editor: Editor; dom: HTMLElement }> {
  (root.querySelector(titleSel) as HTMLElement).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  flushSync();
  await settle();
  const ed = editorIn(root, editorSel);
  if (!ed) throw new Error('the title editor did not open');
  ed.editor.commands.setTextSelection(caret);
  return ed;
}

async function press(dom: HTMLElement, init: KeyboardEventInit): Promise<void> {
  dom.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  flushSync();
  await settle();
}

async function mountTileHeader(): Promise<HTMLElement> {
  const target = host();
  mounted.push(mount(TileHeader, {
    target,
    props: { get tile() { return boardStore.getTile('t1')!; } },
    context: context(),
  }) as Record<string, unknown>);
  await settle();
  return target;
}

async function mountFrame(): Promise<HTMLElement> {
  const target = host();
  mounted.push(mount(FrameComponent, {
    target,
    props: { get frame() { return boardStore.frames.find((f) => f.id === 'f1')!; } },
    context: context(),
  }) as Record<string, unknown>);
  await settle();
  return target;
}

beforeEach(() => {
  resetEditorHarness();
  installFiloMock(() => null);
  __resetComponentFlushesForTests();
  vaultStore.setPath('/vault');
  boardCacheStore.clear();
  boardStore.clearBoard();
  boardCacheStore.hydrate({ mm: { version: 8, board: BOARD, tileDefs: {}, connections: {}, frames: [] } as never }, { mm: 'Map.board.json' });
  seedBoard(boardStore, structuredClone(BOARD), { t1: structuredClone(TILE) }, { c1: structuredClone(CONN) }, [structuredClone(FRAME)]);
  historyStore.clear();
  historyStore.setActiveBoard('mm');
});

afterEach(async () => {
  while (mounted.length) unmount(mounted.pop()!);
  await settle();
  historyStore.clear();
  historyStore.setActiveBoard(null);
  boardCacheStore.clear();
  boardStore.clearBoard();
  vaultStore.setPath('');
  teardownEditorHarness();
});

describe('Enter with the caret inside a title', () => {
  it('a tile title is committed whole, and the edit ends', async () => {
    const root = await mountTileHeader();
    const ed = await openAt(root, '.tile-title', '.tile-title-editor', 5); // "Chap|ter One"
    await press(ed.dom, { key: 'Enter' });
    expect(boardStore.getTile('t1')?.title).toBe('Chapter One');
    expect(boardStore.getTile('t1')?.titleHtml ?? '').not.toMatch(/<\/p>\s*<p|<br/);
    expect(editorIn(root, '.tile-title-editor')).toBeNull();
  });

  it('a tile title typed into commits on Shift+Enter without a line break', async () => {
    const root = await mountTileHeader();
    const ed = await openAt(root, '.tile-title', '.tile-title-editor', 8); // "Chapter| One"
    ed.editor.commands.insertContent(' Big');
    await press(ed.dom, { key: 'Enter', shiftKey: true });
    expect(boardStore.getTile('t1')?.title).toBe('Chapter Big One');
    expect(boardStore.getTile('t1')?.titleHtml ?? '').not.toMatch(/<br/);
  });

  it('a frame title is committed whole', async () => {
    const root = await mountFrame();
    const ed = await openAt(root, '.frame-title', '.frame-title-editor', 4); // "Act| Two"
    await press(ed.dom, { key: 'Enter' });
    expect(boardStore.frames.find((f) => f.id === 'f1')?.title).toBe('Act Two');
    expect(editorIn(root, '.frame-title-editor')).toBeNull();
  });

  it('a connection label is committed whole', async () => {
    const target = host();
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    Object.assign(path, { getTotalLength: () => 100, getPointAtLength: () => ({ x: 50, y: 50 }) });
    mounted.push(mount(ConnectionLabel, {
      target,
      props: { connection: boardCacheStore.cache.mm!.connections.c1!, pathElement: path, editing: true },
      context: context(),
    }) as Record<string, unknown>);
    await settle();
    const ed = editorIn(target, '.label-editor-host');
    if (!ed) throw new Error('the label editor did not open');
    ed.editor.commands.setTextSelection(4); // "Lea|ds to"
    await press(ed.dom, { key: 'Enter' });
    const label = boardCacheStore.cache.mm!.connections.c1!.label;
    expect(label.text).toBe('Leads to');
    expect(label.content).toBe('<p>Leads to</p>');
  });

  it('an IME confirming its composition with Enter leaves the title open and unchanged', async () => {
    const root = await mountTileHeader();
    const ed = await openAt(root, '.tile-title', '.tile-title-editor', 5);
    await press(ed.dom, { key: 'Enter', isComposing: true });
    expect(editorIn(root, '.tile-title-editor')).not.toBeNull();
    expect(ed.editor.state.doc.childCount).toBe(1);
    expect(ed.editor.getText()).toBe('Chapter One');
    // Enter after the composition ends commits it.
    await press(ed.dom, { key: 'Enter' });
    expect(boardStore.getTile('t1')?.title).toBe('Chapter One');
    expect(editorIn(root, '.tile-title-editor')).toBeNull();
  });
});

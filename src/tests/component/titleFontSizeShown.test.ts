/**
 * A title given a font size in its editor keeps it once the edit ends. The
 * size showed while typing and vanished after: the sanitiser that shows a
 * committed title dropped `font-size`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { Editor } from '@tiptap/core';
import TileHeader from '@renderer/components/tiles/TileHeader.svelte';
import FrameComponent from '@renderer/components/frames/Frame.svelte';
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

describe('a title with a font size', () => {
  it('a tile title sized in its editor shows the size after Enter', async () => {
    const root = await mountTileHeader();
    const ed = await openAt(root, '.tile-title', '.tile-title-editor', 1);
    ed.editor.chain().selectAll().setMark('textStyle', { fontSize: '20px' }).run();
    await press(ed.dom, { key: 'Enter' });
    expect(boardStore.getTile('t1')?.titleHtml).toContain('font-size: 20px');
    const shown = root.querySelector('.tile-title span[style]');
    expect(shown?.getAttribute('style')).toContain('font-size: 20px');
    expect(shown?.textContent).toBe('Chapter One');
  });

  it('a frame title sized in its editor shows the size after Enter', async () => {
    const root = await mountFrame();
    const ed = await openAt(root, '.frame-title', '.frame-title-editor', 1);
    ed.editor.chain().selectAll().setMark('textStyle', { fontSize: '24px' }).run();
    await press(ed.dom, { key: 'Enter' });
    const shown = root.querySelector('.frame-title span[style]');
    expect(shown?.getAttribute('style')).toContain('font-size: 24px');
  });
});

/**
 * A tile, frame or connection title being typed is saved when the user
 * leaves it: a click on the canvas (whether or not it moves focus), Tab,
 * focus that went into the formatting toolbar and on from there. The
 * formatting toolbar itself keeps the edit open (so a title can be made bold
 * mid-edit), and so does Filo losing focus to another app, which leaves the
 * editor focused.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { Editor } from '@tiptap/core';
import TileHeader from '@renderer/components/tiles/TileHeader.svelte';
import FrameComponent from '@renderer/components/frames/Frame.svelte';
import ConnectionLabel from '@renderer/components/connections/ConnectionLabel.svelte';
import TextFormattingToolbar from '@renderer/components/layout/TextFormattingToolbar.svelte';
import { BOARD_SCOPE_KEY, getActiveScope } from '@renderer/lib/boards/boardScope.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import { __resetComponentFlushesForTests } from '@renderer/lib/boards/componentFlush';
import { TITLE_FOCUS_LEAVE_MS } from '@renderer/lib/editor/titleEditFocus';
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
  id: 't1', boardId: 'mm', type: 'link', title: 'Old title', url: 'https://example.com',
  position: { x: 0, y: 0 }, size: { width: 200, height: 120 },
  style: { headerColor: '', bodyColor: '', borderColor: '' },
  locked: false, tags: [], createdAt: 0, updatedAt: 0,
} as unknown as Tile;

const FRAME = {
  id: 'f1', boardId: 'mm', title: 'Old frame', position: { x: 0, y: 0 }, size: { width: 300, height: 300 },
  style: { backgroundImage: '', borderColor: '' }, collapsed: false, tileIds: [], createdAt: 0, updatedAt: 0,
} as unknown as Frame;

const CONN = {
  id: 'c1', boardId: 'mm', fromTileId: 'a', toTileId: 'b', fromBubble: 3, toBubble: 7,
  pathColor: '', arrowColor: '', visibility: 'visible', labelVisibility: 'visible',
  label: { text: 'Old label', content: '<p>Old label</p>', textColor: '', backgroundColor: '', position: 0.5, locked: false },
  createdAt: 0, updatedAt: 0,
} as unknown as Connection;

const mounted: Array<Record<string, unknown>> = [];
let canvas: HTMLElement;

function context(): Map<unknown, unknown> {
  return new Map<unknown, unknown>([[BOARD_SCOPE_KEY, getActiveScope()]]);
}

function host(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

/** The formatting toolbar, inside the app toolbar as in the app. */
function mountToolbar(): HTMLElement {
  const header = document.createElement('header');
  header.className = 'global-toolbar';
  document.body.appendChild(header);
  mounted.push(mount(TextFormattingToolbar, { target: header }) as Record<string, unknown>);
  return header;
}

function editorIn(root: ParentNode, sel: string): { editor: Editor; dom: HTMLElement } | null {
  const dom = root.querySelector(`${sel} .ProseMirror`) as (HTMLElement & { editor?: Editor }) | null;
  return dom?.editor ? { editor: dom.editor, dom } : null;
}

/** Double-click the title, then replace its text as typing would. */
async function typeTitle(root: HTMLElement, titleSel: string, editorSel: string, text: string): Promise<{ editor: Editor; dom: HTMLElement }> {
  (root.querySelector(titleSel) as HTMLElement).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  flushSync();
  await settle();
  const ed = editorIn(root, editorSel);
  if (!ed) throw new Error('the title editor did not open');
  expect(document.activeElement).toBe(ed.dom);
  ed.editor.commands.selectAll();
  ed.editor.commands.insertContent(text);
  await settle();
  return ed;
}

/** Long enough for the check that runs after focus leaves. */
async function afterFocusCheck(): Promise<void> {
  await new Promise((r) => setTimeout(r, TITLE_FOCUS_LEAVE_MS + 150));
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

function tileTitle(): { title: string; titleHtml?: string } {
  const t = boardStore.getTile('t1')!;
  return { title: t.title, titleHtml: t.titleHtml };
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
  // The canvas: focusable, as the Mind Map's is, so a click on it takes focus.
  canvas = host();
  canvas.tabIndex = 0;
});

afterEach(async () => {
  while (mounted.length) unmount(mounted.pop()!);
  // A title still open commits on unmount, one microtask later: let it land
  // while its tile is still on the board.
  await settle();
  historyStore.clear();
  historyStore.setActiveBoard(null);
  boardCacheStore.clear();
  boardStore.clearBoard();
  vaultStore.setPath('');
  teardownEditorHarness();
});

describe('a tile title being typed', () => {
  it('is saved when the canvas is clicked', async () => {
    const root = await mountTileHeader();
    await typeTitle(root, '.tile-title', '.tile-title-editor', 'New title');

    canvas.focus();
    await afterFocusCheck();
    expect(tileTitle().title).toBe('New title');
    expect(editorIn(root, '.tile-title-editor')).toBeNull();
    expect(historyStore.canUndo).toBe(true);
  });

  it('stays open while the formatting toolbar is used, and is saved with the formatting', async () => {
    const toolbar = mountToolbar();
    const root = await mountTileHeader();
    const ed = await typeTitle(root, '.tile-title', '.tile-title-editor', 'New title');

    // A press on the toolbar's Bold, and focus going there (a Tab does that).
    const bold = toolbar.querySelector('button[title^="Bold"]') as HTMLButtonElement;
    bold.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    bold.focus();
    await afterFocusCheck();
    expect(editorIn(root, '.tile-title-editor')).not.toBeNull();
    expect(tileTitle().title).toBe('Old title');

    ed.editor.commands.selectAll();
    bold.click();
    await settle();
    expect(document.activeElement).toBe(ed.dom);

    canvas.focus();
    await afterFocusCheck();
    expect(tileTitle().title).toBe('New title');
    expect(tileTitle().titleHtml).toContain('<strong>');
  });

  it('is saved when focus goes into the toolbar and from there to the canvas', async () => {
    const toolbar = mountToolbar();
    const root = await mountTileHeader();
    await typeTitle(root, '.tile-title', '.tile-title-editor', 'New title');

    // The font box takes focus; the user then clicks the canvas instead of picking a font.
    (toolbar.querySelector('select[aria-label="Font family"]') as HTMLSelectElement).focus();
    await afterFocusCheck();
    expect(tileTitle().title).toBe('Old title');

    canvas.focus();
    await afterFocusCheck();
    expect(tileTitle().title).toBe('New title');
  });

  it('is saved by a press on the canvas even when the press moves no focus', async () => {
    const toolbar = mountToolbar();
    const root = await mountTileHeader();
    await typeTitle(root, '.tile-title', '.tile-title-editor', 'New title');
    (toolbar.querySelector('select[aria-label="Font family"]') as HTMLSelectElement).focus();
    await afterFocusCheck();

    // The Mind Map canvas cancels a press's default to pan: focus stays put.
    const surface = host();
    surface.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    await settle();
    expect(document.activeElement?.tagName).toBe('SELECT');
    expect(tileTitle().title).toBe('New title');
    expect(editorIn(root, '.tile-title-editor')).toBeNull();
  });

  it('stays open when Filo loses focus to another app', async () => {
    const root = await mountTileHeader();
    const ed = await typeTitle(root, '.tile-title', '.tile-title-editor', 'New title');

    // A window switch blurs the editor but leaves it the focused element.
    ed.dom.dispatchEvent(new FocusEvent('blur'));
    ed.dom.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    await afterFocusCheck();
    expect(document.activeElement).toBe(ed.dom);
    expect(editorIn(root, '.tile-title-editor')).not.toBeNull();
    expect(tileTitle().title).toBe('Old title');
  });

  it('Escape still drops the typed title', async () => {
    const root = await mountTileHeader();
    const ed = await typeTitle(root, '.tile-title', '.tile-title-editor', 'New title');
    ed.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    flushSync();
    canvas.focus();
    await afterFocusCheck();
    expect(tileTitle().title).toBe('Old title');
    expect(historyStore.canUndo).toBe(false);
  });
});

describe('a frame title being typed', () => {
  it('is saved when the canvas is clicked', async () => {
    const target = host();
    mounted.push(mount(FrameComponent, {
      target,
      props: { get frame() { return boardStore.frames.find((f) => f.id === 'f1')!; } },
      context: context(),
    }) as Record<string, unknown>);
    await settle();
    await typeTitle(target, '.frame-title', '.frame-title-editor', 'New frame');

    canvas.focus();
    await afterFocusCheck();
    expect(boardStore.frames.find((f) => f.id === 'f1')?.title).toBe('New frame');
    expect(editorIn(target, '.frame-title-editor')).toBeNull();
  });
});

describe('a connection label being typed', () => {
  it('is saved when focus moves away without a click (Tab)', async () => {
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
    ed.editor.commands.setContent('<p>New label</p>');
    await settle();

    canvas.focus();
    await afterFocusCheck();
    expect(boardCacheStore.cache.mm!.connections.c1!.label.text).toBe('New label');
  });
});

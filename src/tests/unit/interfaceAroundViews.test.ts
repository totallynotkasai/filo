/**
 * The interface around the views: the pure rules behind Escape and the Search
 * panel, the docked sidebar at laptop widths, nested frames, a Mind Map's
 * remembered panels, copied links and a task row's styles.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { escapeClosesSearchPanel } from '@renderer/lib/search/searchEscape';
import { sidebarPushesWorkspace } from '@renderer/lib/utils/sidebarLayout';
import { framesInPaintOrder, framesInside } from '@renderer/lib/frames/nestedFrames';
import { revertFrameDragOnTeardown } from '@renderer/lib/frames/frameDragCancel';
import { workspaceStore } from '@renderer/stores/workspace.svelte';
import { createCanvasScope } from '@renderer/stores/canvas.svelte';
import { decodeFiloLink, linkToBoard, linkToNote, linkToTile } from '@renderer/schema/link';
import { copyFiloLink } from '@renderer/lib/utils/copyLink';
import { uiStore } from '@renderer/stores/ui.svelte';
import { taskRowStyles } from '@renderer/lib/tasklist/taskRowStyle';
import { clipboardPayload } from '../../main/utils/clipboardPayload';
import { buildTileContextMenu } from '@renderer/lib/mindmap/mindMapContextMenus';
import { buildCardContextMenu } from '@renderer/lib/kanban/kanbanContextMenus';
import { buildTaskContextMenu } from '@renderer/lib/tasklist/taskContextMenus';
import { buildSidebarFileMenu } from '@renderer/lib/vault/sidebarFileMenu';
import type { Frame, Tile } from '@renderer/schema/index';
import type { ResolvedTaskStyle } from '@renderer/lib/styles/effectiveStyle';

function escape(target: EventTarget, prevented = false): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  Object.defineProperty(e, 'target', { value: target });
  if (prevented) e.preventDefault();
  return e;
}

describe('escapeClosesSearchPanel', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('closes on an Escape nothing else took, with focus on the board or nowhere', () => {
    const panel = document.createElement('section');
    const canvas = document.createElement('div');
    canvas.tabIndex = 0;
    document.body.append(panel, canvas);
    expect(escapeClosesSearchPanel(escape(canvas), panel)).toBe(true);
    expect(escapeClosesSearchPanel(escape(document.body), panel)).toBe(true);
    expect(escapeClosesSearchPanel(escape(window), panel)).toBe(true);
  });

  it('leaves an Escape something above it used: preventDefault, a popup, a field, the panel itself', () => {
    const panel = document.createElement('section');
    const box = document.createElement('input');
    panel.append(box);
    const field = document.createElement('input');
    const editor = document.createElement('div');
    editor.setAttribute('contenteditable', 'true');
    const popup = document.createElement('div');
    popup.setAttribute('role', 'dialog');
    const inPopup = document.createElement('button');
    popup.append(inPopup);
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    const item = document.createElement('button');
    menu.append(item);
    document.body.append(panel, field, editor, popup, menu);

    expect(escapeClosesSearchPanel(escape(document.body, true), panel)).toBe(false);
    expect(escapeClosesSearchPanel(escape(box), panel)).toBe(false);
    expect(escapeClosesSearchPanel(escape(field), panel)).toBe(false);
    expect(escapeClosesSearchPanel(escape(editor), panel)).toBe(false);
    expect(escapeClosesSearchPanel(escape(inPopup), panel)).toBe(false);
    expect(escapeClosesSearchPanel(escape(item), panel)).toBe(false);
  });

  it('ignores every other key', () => {
    const e = new KeyboardEvent('keydown', { key: 'Enter' });
    expect(escapeClosesSearchPanel(e, null)).toBe(false);
  });
});

describe('the docked sidebar at laptop widths', () => {
  it('pushes the workspace aside where the page would start under the sidebar', () => {
    // Laptop widths 1,100, 1,280 and 1,366 px, with the default 240 px sidebar:
    // at 1,366 the 860 px page already clears it.
    for (const width of [1100, 1280, 1339]) expect(sidebarPushesWorkspace(width, 240), String(width)).toBe(true);
    for (const width of [1340, 1366, 1920]) expect(sidebarPushesWorkspace(width, 240), String(width)).toBe(false);
    // A wider sidebar needs a wider window to lie over the page.
    expect(sidebarPushesWorkspace(1600, 400)).toBe(true);
    expect(sidebarPushesWorkspace(1660, 400)).toBe(false);
  });

  it('allows for a zoomed Document page, which is wider; zoomed out, it keeps the 100% rule', () => {
    // At 150% the 860 px page is 1,290 px wide: on a 1,366 px laptop the
    // first ~58 px of every line sat under the sidebar.
    expect(sidebarPushesWorkspace(1366, 240, 1.5)).toBe(true);
    expect(sidebarPushesWorkspace(1366, 240, 1)).toBe(false);
    expect(sidebarPushesWorkspace(1769, 240, 1.5)).toBe(true);
    expect(sidebarPushesWorkspace(1770, 240, 1.5)).toBe(false);
    expect(sidebarPushesWorkspace(1366, 240, 0.5)).toBe(false);
    expect(sidebarPushesWorkspace(1100, 240, 0.5)).toBe(true);
  });

  it("takes the Document zoom only while a Document tab is on screen", () => {
    const width = window.innerWidth;
    const stop = uiStore.trackWindowWidth();
    try {
      uiStore.setSidebarFloating(false);
      uiStore.setSidebarOpen(true);
      workspaceStore.setDocumentZoom(1.5);
      Object.defineProperty(window, 'innerWidth', { value: 1366, configurable: true });
      window.dispatchEvent(new Event('resize'));
      expect(uiStore.sidebarPushesWorkspace, 'no Document tab shown').toBe(false);
      const gone = uiStore.showDocumentPage();
      expect(uiStore.sidebarPushesWorkspace, 'a Document tab at 150%').toBe(true);
      workspaceStore.setDocumentZoom(1);
      expect(uiStore.sidebarPushesWorkspace, 'the same tab at 100%').toBe(false);
      workspaceStore.setDocumentZoom(1.5);
      gone();
      gone();
      expect(uiStore.sidebarPushesWorkspace, 'the tab gone (said twice)').toBe(false);
    } finally {
      stop();
      workspaceStore.reset();
      Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
    }
  });

  it('pushes only while it is docked and open, following the window', () => {
    const width = window.innerWidth;
    const stop = uiStore.trackWindowWidth();
    try {
      uiStore.setSidebarFloating(false);
      uiStore.setSidebarOpen(true);
      Object.defineProperty(window, 'innerWidth', { value: 1100, configurable: true });
      window.dispatchEvent(new Event('resize'));
      expect(uiStore.sidebarPushesWorkspace).toBe(true);
      uiStore.setSidebarOpen(false);
      expect(uiStore.sidebarPushesWorkspace).toBe(false);
      uiStore.setSidebarOpen(true);
      uiStore.setSidebarFloating(true);
      expect(uiStore.sidebarPushesWorkspace).toBe(false);
      uiStore.setSidebarFloating(false);
      Object.defineProperty(window, 'innerWidth', { value: 1920, configurable: true });
      window.dispatchEvent(new Event('resize'));
      expect(uiStore.sidebarPushesWorkspace).toBe(false);
    } finally {
      stop();
      Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
    }
  });
});

function frame(id: string, x: number, y: number, width: number, height: number): Frame {
  return { id, position: { x, y }, size: { width, height }, tileIds: [] } as unknown as Frame;
}

describe('nested frames', () => {
  const region = frame('region', 0, 0, 1000, 800);
  const city = frame('city', 100, 100, 400, 300);
  const street = frame('street', 150, 150, 100, 100);
  const overlap = frame('overlap', 900, 700, 300, 300);
  const twin = frame('twin', 0, 0, 1000, 800);

  it('finds the frames wholly inside one, at any depth, and not one that only overlaps or is the same size', () => {
    const all = [region, city, street, overlap, twin];
    expect(framesInside(region, all).map((f) => f.id)).toEqual(['city', 'street']);
    expect(framesInside(city, all).map((f) => f.id)).toEqual(['street']);
    expect(framesInside(street, all)).toEqual([]);
  });

  it('draws larger frames first, so a frame inside another is above it whichever was made first', () => {
    expect(framesInPaintOrder([street, city, region]).map((f) => f.id)).toEqual(['region', 'city', 'street']);
    expect(framesInPaintOrder([region, twin]).map((f) => f.id)).toEqual(['region', 'twin']);
  });

  it('leaves out the frames inside a folded one, at any depth, and keeps the folded one and its neighbours', () => {
    const folded = { ...region, collapsed: true };
    expect(framesInPaintOrder([street, city, folded, overlap]).map((f) => f.id)).toEqual(['region', 'overlap']);
    expect(framesInPaintOrder([street, { ...city, collapsed: true }, region]).map((f) => f.id)).toEqual(['region', 'city']);
    // A folded frame of the same size holds nothing, so its twin stays drawn.
    expect(framesInPaintOrder([folded, twin]).map((f) => f.id)).toEqual(['region', 'twin']);
  });

  it('a drag torn down mid-gesture puts the nested frames back too', () => {
    const moved = new Map<string, { x: number; y: number }>();
    const tiles: Record<string, Tile> = { t1: { id: 't1', position: { x: 300, y: 300 }, locked: false } as unknown as Tile };
    revertFrameDragOnTeardown(
      {
        frameId: 'region', startX: 0, startY: 0, lastX: 50, lastY: 20, containedTileIds: ['t1'],
        nestedFrames: [{ id: 'city', startX: 100, startY: 100 }],
      },
      {
        updateFramePosition: (id, p) => moved.set(id, p),
        getTile: (id) => tiles[id],
        moveTile: (id, p) => moved.set(id, p),
      },
    );
    expect(Object.fromEntries(moved)).toEqual({ region: { x: 0, y: 0 }, city: { x: 100, y: 100 }, t1: { x: 250, y: 280 } });
  });
});

describe("a Mind Map's minimap and waypoints", () => {
  beforeEach(() => workspaceStore.reset());
  afterEach(() => workspaceStore.reset());

  it('are remembered per board, and a board showing both keeps no entry', () => {
    const canvas = createCanvasScope();
    canvas.setBoard('a');
    canvas.toggleMinimap();
    canvas.toggleWaypointsVisible();
    expect(canvas.minimapVisible).toBe(false);
    expect(canvas.waypointsVisible).toBe(false);
    canvas.setBoard('b');
    expect(canvas.minimapVisible).toBe(true);
    expect(canvas.waypointsVisible).toBe(true);
    canvas.setBoard('a');
    expect(canvas.minimapVisible).toBe(false);
    expect(workspaceStore.mindMapPanels).toEqual({ a: { minimap: false, waypoints: false } });
    canvas.toggleMinimap();
    canvas.setWaypointsVisible(true);
    expect(workspaceStore.mindMapPanels).toEqual({});
    canvas.destroy();
  });

  it('come back from .filo/workspace.json, a bad entry dropped, and go with a deleted board', () => {
    workspaceStore.hydrate({
      paneTree: null,
      activePaneId: null,
      mindMapPanels: { a: { minimap: false, waypoints: true }, b: 'odd', c: { minimap: true, waypoints: true } } as never,
    });
    expect(workspaceStore.mindMapPanels).toEqual({ a: { minimap: false, waypoints: true } });
    expect(workspaceStore.serialize().mindMapPanels).toEqual({ a: { minimap: false, waypoints: true } });
    workspaceStore.removeMindMapPanels('a');
    expect(workspaceStore.mindMapPanelsOf('a')).toEqual({ minimap: true, waypoints: true });
  });
});

describe('copied links', () => {
  it('name a board, a tile, or a note by its path, and read back', () => {
    expect(decodeFiloLink(linkToBoard('b1'))).toEqual({ type: 'board-nav', targetBoardId: 'b1' });
    expect(decodeFiloLink(linkToTile('b1', 't1'))).toEqual({ type: 'tile-nav', targetBoardId: 'b1', targetTileId: 't1' });
    const href = linkToNote('Book/Part 1/Chapter #4.md');
    expect(href).toBe('filo://note/Book%2FPart%201%2FChapter%20%234.md');
    expect(decodeFiloLink(href)).toEqual({ type: 'note-nav', targetPath: 'Book/Part 1/Chapter #4.md' });
  });

  it('open only a plain Markdown note in the vault from a link', () => {
    for (const bad of [
      'filo://note/..%2Fsecret.md', 'filo://note/%2Fetc%2Fnotes.md', 'filo://note/C%3A%5CUsers%5Cx.md',
      'filo://note/.filo%2Fapp.md', 'filo://note/Book%2F..%2F..%2Fx.md', 'filo://note/photo.png',
      'filo://note/%E0%A4%A', 'filo://note/',
    ]) {
      expect(decodeFiloLink(bad), bad).toBeNull();
    }
  });

  it('go to main to be put on the clipboard, which says when it could not', async () => {
    const asked: unknown[][] = [];
    let answer = true;
    const filo = { invoke: async (...args: unknown[]) => { asked.push(args); return answer; }, on: () => () => {}, send: () => {} };
    (window as unknown as Record<string, unknown>).filo = filo;
    const toast = vi.spyOn(uiStore, 'toast');
    try {
      await copyFiloLink(linkToNote('Chapter 4.md'), '  The Siege ');
      expect(asked).toEqual([['shell:copy-text', 'filo://note/Chapter%204.md', 'The Siege']]);
      expect(toast.mock.calls[0]?.[0]).toContain('Link to "The Siege" copied');
      answer = false;
      await copyFiloLink(linkToBoard('b1'), 'Plan');
      expect(toast.mock.calls[1]?.[0]).toBe('Couldn\'t copy the link to "Plan".');
    } finally {
      toast.mockRestore();
      delete (window as unknown as Record<string, unknown>).filo;
    }
  });

  it("are written by main as the address and as a link reading the name, and nothing else is", () => {
    expect(clipboardPayload('filo://note/Chapter%204.md', 'The <Siege> & "Co"')).toEqual({
      text: 'filo://note/Chapter%204.md',
      html: '<a href="filo://note/Chapter%204.md">The &lt;Siege&gt; &amp; &quot;Co&quot;</a>',
    });
    expect(clipboardPayload('Some problems\nand more')).toEqual({ text: 'Some problems\nand more' });
    // A name goes only on one of Filo's own links.
    expect(clipboardPayload('https://example.com', 'Example')).toBeNull();
    expect(clipboardPayload('filo://note/a.md" onclick="x', 'A')).toBeNull();
    expect(clipboardPayload('', undefined)).toBeNull();
    expect(clipboardPayload(42)).toBeNull();
    expect(clipboardPayload('x'.repeat(100_001))).toBeNull();
  });

  it('are offered on one tile, card, task, note or board, and not on a selection', () => {
    const noop = (): void => {};
    const ids = (items: Array<{ id: string; label: string }>): string[] => items.filter((i) => i.id === 'copy-link').map((i) => i.label);
    const tileMenu = { selectedCount: 1, anyUnlocked: true, onStyle: noop, onTags: noop, onSaveTemplate: noop, onToggleLock: noop, onRemove: noop };
    expect(ids(buildTileContextMenu({ ...tileMenu, onCopyLink: noop }))).toEqual(['Copy link to tile']);
    expect(ids(buildTileContextMenu({ ...tileMenu, selectedCount: 3, onCopyLink: noop }))).toEqual([]);
    expect(ids(buildCardContextMenu({ onStyle: noop, onRemove: noop, onCopyLink: noop }))).toEqual(['Copy link to card']);
    expect(ids(buildTaskContextMenu({
      completed: false, onOpenAsDocument: noop, onRename: noop, onToggleComplete: noop, onCyclePriority: noop,
      moveTargets: [], moveCount: 1, onMoveTo: noop, onRemove: noop, onCopyLink: noop,
    }))).toEqual(['Copy link to task']);
    const fileMenu = { isDirectory: false, isNote: true, onTags: noop, onRename: noop, onRenameToTitle: noop, onReveal: noop, onDelete: noop };
    expect(ids(buildSidebarFileMenu({ ...fileMenu, copyLink: { what: 'note', action: noop } }))).toEqual(['Copy link to note']);
    expect(ids(buildSidebarFileMenu({ ...fileMenu, isNote: false, copyLink: { what: 'board', action: noop } }))).toEqual(['Copy link to board']);
  });

  it("a sidebar item's path is offered for one file or folder, after its link", () => {
    const noop = (): void => {};
    const fileMenu = { isDirectory: false, isNote: true, onTags: noop, onRename: noop, onRenameToTitle: noop, onReveal: noop, onDelete: noop };
    const ids = (items: Array<{ id: string }>): string[] => items.map((i) => i.id);
    const note = buildSidebarFileMenu({ ...fileMenu, copyLink: { what: 'note', action: noop }, onCopyPath: noop });
    expect(ids(note).slice(0, 2)).toEqual(['copy-link', 'copy-path']);
    expect(note.find((i) => i.id === 'copy-path')?.label).toBe('Copy file path');
    const folder = buildSidebarFileMenu({ ...fileMenu, isDirectory: true, isNote: false, onCopyPath: noop });
    expect(folder.find((i) => i.id === 'copy-path')?.label).toBe('Copy folder path');
    // A selection of several rows passes no copy action.
    expect(ids(buildSidebarFileMenu(fileMenu))).not.toContain('copy-path');
  });
});

describe("a task row's styles", () => {
  it('paints the outline, the title strip and the notes apart, and nothing without a style', () => {
    expect(taskRowStyles(undefined)).toEqual({ wrap: '', strip: '', notes: '' });
    const style = {
      borderColor: '#111', borderStyle: 'dashed', borderWidth: 2, shadowIntensity: 0.5,
      headerColor: '#222', headerTextColor: '#fff', bodyColor: '#333', bodyTextColor: '#eee',
    } as unknown as ResolvedTaskStyle;
    expect(taskRowStyles(style)).toEqual({
      wrap: 'border-color: #111; border-style: dashed; border-width: 2px; box-shadow: 0 1px 3px rgba(0,0,0,0.125)',
      strip: 'background-color: #222; color: #fff',
      notes: 'background-color: #333; color: #eee',
    });
  });
});

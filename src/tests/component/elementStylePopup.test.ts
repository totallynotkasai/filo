/**
 * The shared style popup for Kanban cards and columns and Task List tasks
 * and sections: each kind shows its own rows, writes its own style block,
 * and closing pushes one undo step for the whole session.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount } from 'svelte';
import ElementStylePopup from '@renderer/components/boards/ElementStylePopup.svelte';
import { BOARD_SCOPE_KEY, getActiveScope } from '@renderer/lib/boards/boardScope.svelte';
import type { ElementStyleKind } from '@renderer/lib/styles/elementStyleTargets';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import { settle } from './helpers/mountEditor';

type Style = Record<string, unknown>;

function textDef(): BoardFileData['tileDefs'] {
  const t1: Style = { id: 't1', type: 'text', filePath: 'A.md', style: {}, createdAt: 0, updatedAt: 0 };
  return { t1: t1 as BoardFileData['tileDefs'][string] };
}

function kanban(): BoardFileData {
  const board: Style = {
    id: 'kb', type: 'kanban', name: 'K', emoji: '', createdAt: 0, updatedAt: 0, settings: {},
    columns: [{
      id: 'col-1', title: 'A', position: 0, collapsed: false, style: { headerColor: '#aaa' },
      tilePlacements: [{ tileId: 't1', position: 0, style: { headerColor: '#fff' } }],
    }],
  };
  return { board: board as BoardFileData['board'], tileDefs: textDef(), connections: {}, frames: [] };
}

function taskList(): BoardFileData {
  const board: Style = {
    id: 'tl', type: 'tasklist', name: 'TL', emoji: '', createdAt: 0, updatedAt: 0, settings: {},
    sections: [{ id: 'sec-1', title: 'Today', position: 0, collapsed: false, style: { borderWidth: 3 } }],
    tasks: [{ tileId: 't1', position: 0 }],
  };
  return { board: board as BoardFileData['board'], tileDefs: textDef(), connections: {}, frames: [] };
}

function liveBoard(boardId: string): Style {
  const cached = boardCacheStore.cache[boardId];
  if (!cached) throw new Error(`no board ${boardId}`);
  return cached.board as Style;
}

function styleOf(kind: ElementStyleKind): Style | undefined {
  if (kind === 'kanbanColumn' || kind === 'kanbanCard') {
    const col = (liveBoard('kb').columns as Array<Style>)[0] as Style;
    if (kind === 'kanbanColumn') return col.style as Style | undefined;
    return ((col.tilePlacements as Array<Style>)[0] as Style).style as Style | undefined;
  }
  const tl = liveBoard('tl');
  if (kind === 'taskSection') return ((tl.sections as Array<Style>)[0] as Style).style as Style | undefined;
  return ((tl.tasks as Array<Style>)[0] as Style).style as Style | undefined;
}

const ELEMENT: Record<ElementStyleKind, { boardId: string; elementId: string }> = {
  kanbanCard: { boardId: 'kb', elementId: 't1' },
  kanbanColumn: { boardId: 'kb', elementId: 'col-1' },
  task: { boardId: 'tl', elementId: 't1' },
  taskSection: { boardId: 'tl', elementId: 'sec-1' },
};

async function open(kind: ElementStyleKind): Promise<{ close(): Promise<void> }> {
  const { boardId, elementId } = ELEMENT[kind];
  historyStore.setActiveBoard(boardId);
  const target = document.createElement('div');
  document.body.appendChild(target);
  const style = styleOf(kind);
  const component = mount(ElementStylePopup, {
    target,
    props: { kind, boardId, elementId, style, x: 10, y: 10, onclose: () => {} },
    context: new Map<unknown, unknown>([[BOARD_SCOPE_KEY, getActiveScope()]]),
  });
  await settle();
  return {
    close: async () => {
      // A user's picks and the close are separate events. Unmounting in the
      // same flush as a pick would let the teardown read the style from
      // before that flush, so let the picks settle first.
      await settle();
      await unmount(component);
      await settle();
    },
  };
}

function rows(): string[] {
  const popup = document.querySelector('.element-style-popup');
  if (!popup) throw new Error('popup not mounted');
  return [...popup.querySelectorAll('.style-row > span, .style-row > label')].map((el) => el.textContent ?? '');
}

function field<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`no #${id}`);
  return el as T;
}

function change(id: string, value: string): void {
  const el = field<HTMLInputElement | HTMLSelectElement>(id);
  el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

beforeEach(() => {
  installFiloMock(() => null);
  vaultStore.setPath('/vault');
  boardCacheStore.clear();
  boardStore.clearBoard();
  boardCacheStore.hydrate({ kb: kanban(), tl: taskList() }, { kb: 'k.board.json', tl: 't.board.json' });
  historyStore.clear();
});

afterEach(() => {
  historyStore.clear();
  historyStore.setActiveBoard(null);
  boardCacheStore.clear();
  boardStore.clearBoard();
  vaultStore.setPath('');
  restoreFiloDefault();
  document.body.innerHTML = '';
});

const COMMON_TAIL = ['Border Colour', 'Border Style', 'Border Width', 'Shadow', 'Dynamic Contrast Text'];

describe('ElementStylePopup rows per kind', () => {
  it.each<[ElementStyleKind, string, string[]]>([
    ['kanbanCard', 'Card Style', ['Header Colour', 'Body Colour', 'Background', 'Shape', ...COMMON_TAIL, 'Title Font Size', 'Body Font Size']],
    ['kanbanColumn', 'Column Style', ['Header Colour', 'Body Colour', 'Accent', ...COMMON_TAIL, 'Column Width (px)', 'Title Font Size']],
    ['task', 'Task Style', ['Header Colour', 'Body Colour', ...COMMON_TAIL, 'Title Font Size', 'Body Font Size']],
    ['taskSection', 'Section Style', ['Header Colour', 'Body Colour', ...COMMON_TAIL, 'Title Font Size']],
  ])('%s shows "%s" with its own rows', async (kind, title, expected) => {
    const popup = await open(kind);
    expect(document.querySelector('.popup-title')?.textContent).toBe(title);
    expect(rows()).toEqual(expected);
    await popup.close();
  });

  it('keeps each kind\'s control ids and Shadow default', async () => {
    let popup = await open('kanbanColumn');
    expect(field<HTMLInputElement>('kc-shadow').value).toBe('0.3');
    expect(document.getElementById('kc-font-size')).not.toBeNull();
    await popup.close();

    popup = await open('kanbanCard');
    expect(field<HTMLInputElement>('kcc-shadow').value).toBe('0.2');
    expect(document.getElementById('kcc-font-title')).not.toBeNull();
    await popup.close();

    popup = await open('taskSection');
    expect(field<HTMLInputElement>('ts-border-width').value).toBe('3');
    expect(document.getElementById('ts-font-size')).not.toBeNull();
    await popup.close();

    popup = await open('task');
    expect(document.getElementById('ti-font-body')).not.toBeNull();
    await popup.close();
  });
});

describe('ElementStylePopup writes and undo', () => {
  it('a card session writes the placement style and undoes in one step', async () => {
    const popup = await open('kanbanCard');
    change('kcc-shape', 'rectangle');
    change('kcc-border-style', 'dashed');
    change('kcc-font-body', '18');
    expect(styleOf('kanbanCard')).toEqual({ headerColor: '#fff', shape: 'rectangle', borderStyle: 'dashed', fontSizeBody: 18 });
    expect(styleOf('kanbanColumn')).toEqual({ headerColor: '#aaa' });
    await popup.close();

    await historyStore.undo();
    expect(styleOf('kanbanCard')).toEqual({ headerColor: '#fff' });
    expect(historyStore.canUndo).toBe(false);
  });

  it('a column session writes the column style and undoes in one step', async () => {
    const popup = await open('kanbanColumn');
    change('kc-width', '300');
    expect(styleOf('kanbanColumn')).toEqual({ headerColor: '#aaa', width: 300 });
    await popup.close();

    await historyStore.undo();
    expect(styleOf('kanbanColumn')).toEqual({ headerColor: '#aaa' });
  });

  it('a task session writes the task placement style and undoes in one step', async () => {
    const popup = await open('task');
    change('ti-font-title', '20');
    expect(styleOf('task')).toEqual({ fontSizeTitle: 20 });
    await popup.close();

    await historyStore.undo();
    expect(styleOf('task')).toBeUndefined();
  });

  it('Restore to Theme Defaults clears a section style, and undo puts it back', async () => {
    const popup = await open('taskSection');
    const restore = document.querySelector<HTMLButtonElement>('.restore-defaults-btn');
    restore?.click();
    await settle();
    expect(styleOf('taskSection')).toBeUndefined();
    expect(field<HTMLInputElement>('ts-border-width').value).toBe('1');
    await popup.close();

    await historyStore.undo();
    expect(styleOf('taskSection')).toEqual({ borderWidth: 3 });
  });

  it('closing without a pick pushes nothing', async () => {
    const popup = await open('kanbanCard');
    await popup.close();
    expect(historyStore.canUndo).toBe(false);
  });
});

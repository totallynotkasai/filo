/**
 * Dragging a frame carries the frames drawn inside it (E-09). The inner frame
 * stayed behind while its tiles went with the outer one, and kept claiming
 * them, so folding it later hid tiles far away. Now the inner frame goes with
 * its tiles, each moved tile is filed under the frames it landed in, and one
 * undo puts everything back.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import FrameComponent from '@renderer/components/frames/Frame.svelte';
import { BOARD_SCOPE_KEY, getActiveScope } from '@renderer/lib/boards/boardScope.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import { __resetComponentFlushesForTests } from '@renderer/lib/boards/componentFlush';
import type { Frame, MindMapBoard, Tile } from '@renderer/schema/index';
import { installFiloMock } from '../helpers/filoBridge';
import { seedBoard } from '../helpers/seedBoard';
import { settle, resetEditorHarness, teardownEditorHarness } from './helpers/mountEditor';

const BOARD = {
  id: 'mm', type: 'mindmap', name: 'Map', emoji: '', createdAt: 0, updatedAt: 0, settings: {},
  placements: {}, inlineTiles: {}, waypoints: [], groups: [],
} as unknown as MindMapBoard;

function tile(id: string, x: number, y: number): Tile {
  return {
    id, boardId: 'mm', type: 'link', title: id, url: 'https://example.com',
    position: { x, y }, size: { width: 100, height: 60 },
    style: { headerColor: '', bodyColor: '', borderColor: '' },
    locked: false, tags: [], createdAt: 0, updatedAt: 0,
  } as unknown as Tile;
}

function frame(id: string, x: number, y: number, width: number, height: number, tileIds: string[]): Frame {
  return {
    id, boardId: 'mm', title: id, position: { x, y }, size: { width, height },
    style: { backgroundImage: '', borderColor: '' }, collapsed: false, tileIds, createdAt: 0, updatedAt: 0,
  } as unknown as Frame;
}

const mounted: Array<Record<string, unknown>> = [];

async function mountFrame(id: string): Promise<HTMLElement> {
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(mount(FrameComponent, {
    target,
    props: { get frame() { return boardStore.frames.find((f) => f.id === id)!; } },
    context: new Map<unknown, unknown>([[BOARD_SCOPE_KEY, getActiveScope()]]),
  }) as Record<string, unknown>);
  await settle();
  return target;
}

function pointer(el: Element, type: string, x: number, y: number): void {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(e, 'pointerId', { value: 1 });
  el.dispatchEvent(e);
}

async function dragHeader(root: HTMLElement, dx: number, dy: number): Promise<void> {
  const header = root.querySelector('.frame-header') as HTMLElement;
  pointer(header, 'pointerdown', 10, 10);
  pointer(header, 'pointermove', 10 + dx, 10 + dy);
  await new Promise((r) => setTimeout(r, 40)); // the drag moves once per animation frame
  pointer(header, 'pointerup', 10 + dx, 10 + dy);
  flushSync();
  await settle();
}

const at = (id: string): { x: number; y: number } | undefined => boardStore.frames.find((f) => f.id === id)?.position;
const members = (id: string): string[] => [...(boardStore.frames.find((f) => f.id === id)?.tileIds ?? [])].sort();

beforeAll(() => {
  if (typeof Element.prototype.setPointerCapture !== 'function') Element.prototype.setPointerCapture = () => {};
  if (typeof Element.prototype.releasePointerCapture !== 'function') Element.prototype.releasePointerCapture = () => {};
});

beforeEach(() => {
  resetEditorHarness();
  installFiloMock(() => null);
  __resetComponentFlushesForTests();
  vaultStore.setPath('/vault');
  boardCacheStore.clear();
  boardStore.clearBoard();
  boardCacheStore.hydrate({ mm: { version: 8, board: BOARD, tileDefs: {}, connections: {}, frames: [] } as never }, { mm: 'Map.board.json' });
  // Region holds City, which holds t1; t2 is in Region only. Far right, Coast
  // is where Region is dragged to; t3 sits in Coast already.
  seedBoard(boardStore, structuredClone(BOARD), {
    t1: tile('t1', 200, 200),
    t2: tile('t2', 900, 900),
    t3: tile('t3', 3000, 1000),
  }, {}, [
    frame('region', 0, 0, 1400, 1200, ['t1', 't2']),
    frame('city', 100, 100, 500, 400, ['t1']),
    frame('coast', 2400, 600, 1400, 1200, ['t3']),
  ]);
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

describe('dragging a frame with a frame inside it', () => {
  it('carries the inner frame and its tiles, and each frame lists the tiles inside it', async () => {
    const region = await mountFrame('region');
    await mountFrame('city');
    await dragHeader(region, 1500, 0);

    expect(at('region')).toEqual({ x: 1500, y: 0 });
    expect(at('city')).toEqual({ x: 1600, y: 100 });
    expect(boardStore.getTile('t1')?.position).toEqual({ x: 1700, y: 200 });
    expect(boardStore.getTile('t2')?.position).toEqual({ x: 2400, y: 900 });
    expect(members('city')).toEqual(['t1']);
    expect(members('region')).toEqual(['t1', 't2']);
    // t2 now lies in Coast too (its centre is inside both).
    expect(members('coast')).toEqual(['t2', 't3']);
  });

  it('is one undo step: the inner frame, the tiles and every frame list go back', async () => {
    const region = await mountFrame('region');
    await mountFrame('city');
    await dragHeader(region, 1500, 0);
    await historyStore.undo();
    await settle();

    expect(at('region')).toEqual({ x: 0, y: 0 });
    expect(at('city')).toEqual({ x: 100, y: 100 });
    expect(boardStore.getTile('t1')?.position).toEqual({ x: 200, y: 200 });
    expect(members('city')).toEqual(['t1']);
    expect(members('region')).toEqual(['t1', 't2']);
    expect(members('coast')).toEqual(['t3']);

    await historyStore.redo();
    await settle();
    expect(at('city')).toEqual({ x: 1600, y: 100 });
    expect(members('coast')).toEqual(['t2', 't3']);
  });

  it('leaves a frame that only overlaps the dragged one where it is', async () => {
    boardStore.addFrame(frame('overlap', 1300, 1100, 400, 300, []));
    const region = await mountFrame('region');
    await dragHeader(region, 0, 500);
    expect(at('overlap')).toEqual({ x: 1300, y: 1100 });
    expect(at('city')).toEqual({ x: 100, y: 600 });
  });
});

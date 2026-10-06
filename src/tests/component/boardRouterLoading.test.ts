/**
 * While a board's code chunk loads, BoardRouter shows "Loading board…" (CSS
 * holds it invisible for the first 150ms, so a fast load never flashes it),
 * and swaps it for the board once the chunk resolves. A board whose chunk has
 * already loaded (by an earlier open or the idle preload) renders at once,
 * with no placeholder at all.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount, type Component } from 'svelte';
import { settle } from './helpers/mountEditor';

interface BoardModule { default: Component<Record<string, unknown>> }
const pending: { resolve?: (mod: BoardModule) => void; loads: number } = { loads: 0 };
const loader = (): Promise<BoardModule> => {
  pending.loads++;
  return new Promise<BoardModule>((resolve) => { pending.resolve = resolve; });
};

vi.mock('@renderer/core/boardRegistry', () => ({
  boardRegistry: {
    kanban: {
      type: 'kanban',
      name: 'Kanban',
      usesCanvas: false,
      component: loader,
      createDefault: () => { throw new Error('not used'); },
    },
  },
}));

const { default: BoardRouter } = await import('@renderer/components/boards/BoardRouter.svelte');
const { tabStore } = await import('@renderer/stores/tabs.svelte');
const { BOARD_SCOPE_KEY } = await import('@renderer/lib/boards/boardScope.svelte');
const { boardCacheStore } = await import('@renderer/stores/boardCache.svelte');

let component: ReturnType<typeof mount> | null = null;

function mountRouter(): HTMLElement {
  // The board is loaded (in the cache), as any board with a tab is.
  boardCacheStore.hydrate(
    { b1: { board: { id: 'b1', type: 'kanban', name: 'Board', emoji: '', createdAt: 0, updatedAt: 0, settings: {}, columns: [] }, tileDefs: {}, connections: {}, frames: [] } as never },
    { b1: 'Board.board.json' },
  );
  const tab = tabStore.open('b1', 'Board', 'kanban');
  const target = document.createElement('div');
  document.body.appendChild(target);
  // With no vault open the router never touches the scope for a Kanban tab.
  component = mount(BoardRouter, {
    target,
    props: { tabId: tab.id },
    context: new Map([[BOARD_SCOPE_KEY, {}]]),
  });
  return target;
}

afterEach(() => {
  if (component) unmount(component);
  component = null;
  tabStore.closeAll();
  boardCacheStore.clear();
  document.body.innerHTML = '';
});

// The two cases share the loaded-module cache, so they run in order.
describe('BoardRouter while a board chunk loads', () => {
  it('shows "Loading board…" until the chunk resolves, then the board', async () => {
    const target = mountRouter();
    await settle();

    const status = target.querySelector('.board-loading [role="status"]');
    expect(status?.textContent).toBe('Loading board…');

    // A component that renders nothing stands in for the board.
    const EmptyBoard: Component<Record<string, unknown>> = () => ({});
    pending.resolve?.({ default: EmptyBoard });
    await settle();

    expect(target.querySelector('.board-loading')).toBeNull();
  });

  it('renders an already-loaded board in the first flush, with no second load', () => {
    expect(pending.loads).toBe(1);
    const target = mountRouter();
    // One flush runs the router's effect, which pins the scope; the board
    // then renders from the cached module without awaiting anything.
    flushSync();

    expect(target.querySelector('.board-transition')).not.toBeNull();
    expect(target.querySelector('.board-loading')).toBeNull();
    expect(pending.loads).toBe(1);
  });
});

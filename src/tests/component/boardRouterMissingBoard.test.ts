/**
 * A tab can outlive its board for a moment: the board is deleted while its tab
 * shows in another pane, and the delete closes the tab only once it has saved.
 * A pane switched to that tab meanwhile shows that the board is gone, with a
 * Close tab button. It never makes a default board under the deleted board's
 * id, which a save would write as a second board file with that id.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount, type Component } from 'svelte';
import { settle } from './helpers/mountEditor';

const made = vi.fn();
const saved = vi.fn(async () => true);
const Stub = (() => ({})) as unknown as Component<Record<string, unknown>>;

vi.mock('@renderer/core/boardRegistry', () => ({
  boardRegistry: {
    kanban: {
      type: 'kanban',
      name: 'Kanban',
      usesCanvas: false,
      component: () => Promise.resolve({ default: Stub }),
      createDefault: (id: string, name: string) => {
        made(id, name);
        return { id, type: 'kanban', name, emoji: '', createdAt: 0, updatedAt: 0, settings: {}, columns: [] };
      },
    },
  },
}));

// A vault is open (its project lists no board with the tab's id).
vi.mock('@renderer/stores/vault.svelte', async (importOriginal) => {
  const real = await importOriginal<typeof import('@renderer/stores/vault.svelte')>();
  const project = { boards: [], settings: {} };
  return {
    ...real,
    vaultStore: new Proxy(real.vaultStore, {
      get(target, prop, receiver) {
        if (prop === 'getData') return () => project;
        if (prop === 'project') return project;
        return Reflect.get(target, prop, receiver) as unknown;
      },
    }),
  };
});

const { default: BoardRouter } = await import('@renderer/components/boards/BoardRouter.svelte');
const { tabStore } = await import('@renderer/stores/tabs.svelte');
const { BOARD_SCOPE_KEY } = await import('@renderer/lib/boards/boardScope.svelte');

let component: ReturnType<typeof mount> | null = null;

afterEach(() => {
  if (component) unmount(component);
  component = null;
  tabStore.closeAll();
  document.body.innerHTML = '';
  made.mockReset();
  saved.mockClear();
});

describe('BoardRouter for a tab whose board is gone', () => {
  it('makes and saves no board, says the board is gone, and offers to close the tab', async () => {
    const tab = tabStore.open('kb_deleted', 'Plans', 'kanban');
    const scope = {
      board: { clearBoard: vi.fn(), setBoard: vi.fn(), persistNewBoard: saved },
      selection: { clear: vi.fn() },
      canvas: { setBoard: vi.fn() },
    };
    const target = document.createElement('div');
    document.body.appendChild(target);
    component = mount(BoardRouter, { target, props: { tabId: tab.id }, context: new Map([[BOARD_SCOPE_KEY, scope]]) });
    flushSync();
    await settle();

    expect(made).not.toHaveBeenCalled();
    expect(saved).not.toHaveBeenCalled();
    expect(scope.board.setBoard).not.toHaveBeenCalled();
    expect(target.textContent).toContain('"Plans" isn\'t open any more');

    const close = [...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Close tab');
    expect(close).toBeTruthy();
    close?.click();
    await vi.waitFor(() => expect(tabStore.tabs.some((t) => t.id === tab.id)).toBe(false));
  });
});

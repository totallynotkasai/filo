import { test, expect, _electron as electron } from '@playwright/test';
import path from 'path';

/**
 * Phase C / C.9 — empty Kanban board shows an empty-state card.
 *
 * Verifies the empty-state card mounts when a Kanban board has no
 * columns and disappears after the user adds one. The card's CTA
 * fires the same handler as the dashed "Add Column" button.
 */
let electronApp: Awaited<ReturnType<typeof electron.launch>>;
let window: Awaited<ReturnType<typeof electronApp.firstWindow>>;

test.beforeAll(async () => {
  electronApp = await electron.launch({
    args: [path.join(__dirname, '..', '..', '..', 'dist', 'main', 'main.js')],
    env: {
      ...process.env,
      NODE_ENV: 'test',
    },
  });
  window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await electronApp?.close();
});

test.describe('Empty Kanban board (Phase C / C.9)', () => {
  test('empty-state card renders with no columns and CTA adds a column', async () => {
    // Create a vault + a fresh Kanban board with zero columns.
    await window.evaluate(async () => {
      const { vaultStore } = await import('/src/renderer/stores/vault.svelte.ts');
      const { boardStore } = await import('/src/renderer/stores/board.svelte.ts');
      const { boardCacheStore } = await import('/src/renderer/stores/boardCache.svelte.ts');
      const { tabStore } = await import('/src/renderer/stores/tabs.svelte.ts');

      vaultStore.setPath('/__test_vault');
      const board = {
        id: 'kb-empty',
        type: 'kanban',
        name: 'Empty Kanban',
        emoji: '',
        createdAt: 0,
        updatedAt: 0,
        settings: {},
        columns: [],
      };
      boardCacheStore.hydrate(
        { 'kb-empty': { board, tileDefs: {}, connections: {}, frames: [] } },
        { 'kb-empty': 'Boards/EmptyKanban.board.json' },
      );
      boardStore.setBoard(board, {}, {}, []);
      tabStore.open('kb-empty', 'Empty Kanban', 'kanban', '');
    });

    const card = window.locator('.kanban-empty-state');
    await expect(card).toBeVisible({ timeout: 3_000 });
    await expect(card.locator('.empty-state-headline')).toContainText('No columns yet');

    // The CTA fires `addColumn`, which appends a column to board.columns.
    // The empty-state card should disappear once columns.length > 0.
    await card.locator('.empty-state-cta').click();
    await expect(card).toBeHidden({ timeout: 3_000 });

    const columnCount = await window.evaluate(async () => {
      const { boardStore } = await import('/src/renderer/stores/board.svelte.ts');
      const b = boardStore.current as { columns?: unknown[] } | null;
      return (b?.columns ?? []).length;
    });
    expect(columnCount).toBe(1);
  });
});

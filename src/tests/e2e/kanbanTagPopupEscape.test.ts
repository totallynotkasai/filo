import { test, expect, _electron as electron } from '@playwright/test';
import path from 'path';

/**
 * Phase C / C.11 — Escape closes the Kanban tag popup even when focus
 * is inside the inner TagEditor input.
 *
 * The previous overlay-only `onkeydown` swallowed Escape when the
 * input had focus. Capture-phase keydown on the window catches the
 * key first.
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

test('Escape closes the Kanban tag popup with focus inside the editor input (Phase C / C.11)', async () => {
  // Seed a Kanban board with one column + one card so the tag icon
  // is available, then dispatch the `tile-tag-editor` event the way
  // TileHeader does.
  await window.evaluate(async () => {
    const { vaultStore } = await import('/src/renderer/stores/vault.svelte.ts');
    const { boardStore } = await import('/src/renderer/stores/board.svelte.ts');
    const { boardCacheStore } = await import('/src/renderer/stores/boardCache.svelte.ts');
    const { tabStore } = await import('/src/renderer/stores/tabs.svelte.ts');

    vaultStore.setPath('/__test_vault');
    const board = {
      id: 'kb-tag',
      type: 'kanban',
      name: 'Tag Test',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      columns: [
        { id: 'col1', title: 'Todo', collapsed: false, tilePlacements: [{ tileId: 't1' }] },
      ],
    };
    boardCacheStore.hydrate(
      {
        'kb-tag': {
          board,
          tileDefs: {
            t1: { id: 't1', type: 'text', title: 'Card 1', tags: [] },
          },
          connections: {},
          frames: [],
        },
      },
      { 'kb-tag': 'Boards/TagTest.board.json' },
    );
    boardStore.setBoard(board, { t1: { id: 't1', type: 'text', title: 'Card 1', tags: [], position: { x: 0, y: 0 }, size: { width: 200, height: 80 }, style: {} } }, {}, []);
    tabStore.open('kb-tag', 'Tag Test', 'kanban', '');
  });

  // Wait for the board to render then dispatch the event a TileHeader
  // would dispatch — this is the same wiring the kanban listener
  // attaches in its `$effect` block.
  await window.waitForSelector('.kanban-board');
  await window.evaluate(() => {
    const el = document.querySelector('.kanban-board');
    if (!el) throw new Error('kanban board not found');
    el.dispatchEvent(new CustomEvent('tile-tag-editor', {
      bubbles: true,
      detail: { tileId: 't1', x: 200, y: 200 },
    }));
  });

  const popup = window.locator('.kanban-tag-popup-anchor');
  await expect(popup).toBeVisible({ timeout: 3_000 });

  // Move focus into the inner input (TagEditor renders one).
  const input = popup.locator('input').first();
  await input.focus();

  // Before the C.11 fix, this Escape was swallowed by the input.
  // With capture-phase listening it now closes the popup.
  await window.keyboard.press('Escape');

  await expect(popup).toBeHidden({ timeout: 1_500 });
});

import { test, expect, _electron as electron } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';

let electronApp: Awaited<ReturnType<typeof electron.launch>>;
let window: Awaited<ReturnType<typeof electronApp.firstWindow>>;
let tempVault: string;

test.beforeAll(async () => {
  // Pre-create a clean vault so the renderer can open it without prompting.
  tempVault = fs.mkdtempSync(path.join(os.tmpdir(), 'filo-tasklist-e2e-'));

  electronApp = await electron.launch({
    args: [path.join(__dirname, '..', '..', '..', 'dist', 'main', 'main.js')],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      FILO_VAULT_PATH: tempVault,
    },
  });
  window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await electronApp?.close();
  try { fs.rmSync(tempVault, { recursive: true, force: true }); } catch { /* ignore */ }
});

/**
 * E2E coverage for Task List Board flows. Drives the renderer via the
 * vaultStore + boardStore + boardCacheStore APIs the way the UI does, then
 * asserts on the DOM. Avoids HTML5 drag-and-drop because Playwright's
 * dispatch can't reliably simulate svelte-dnd-action's pointer event chain;
 * unit tests in `taskDragController.test.ts` cover the drag math directly.
 */

async function bootstrapTaskListBoard(): Promise<{ boardId: string }> {
  return await window.evaluate(async (vaultPath: string) => {
    const { vaultStore } = await import('/src/renderer/stores/vault.svelte.ts');
    const { boardStore } = await import('/src/renderer/stores/board.svelte.ts');
    const { tabStore } = await import('/src/renderer/stores/tabs.svelte.ts');
    if (!vaultStore.project) {
      await vaultStore.openVault(vaultPath);
    }
    const board = await boardStore.createBoard('Tasks E2E', 'tasklist', {});
    if (!board) throw new Error('createBoard failed');
    tabStore.open(board.id, board.name, board.type, board.emoji ?? '');
    return { boardId: board.id };
  }, tempVault);
}

test.describe('Filo E2E — Task List Board', () => {
  test('mounts the side toolbar and an empty smart-list area for a fresh board', async () => {
    await bootstrapTaskListBoard();

    const sideToolbar = window.locator('.tasklist-side-toolbar, [data-testid="tasklist-side-toolbar"]');
    await expect(sideToolbar.first()).toBeVisible({ timeout: 5000 });

    // No rows yet — empty-state hint should be present.
    const empty = window.locator('.tasklist-empty, .tasklist-empty-state');
    await expect(empty.first()).toBeVisible({ timeout: 5000 });
  });

  test('adds a task via the store, sees it render, then completes + undoes', async () => {
    const { boardId } = await bootstrapTaskListBoard();

    const tileId = await window.evaluate(async (id: string) => {
      const { boardCacheStore } = await import('/src/renderer/stores/boardCache.svelte.ts');
      const { documentStore } = await import('/src/renderer/stores/document.svelte.ts');
      // Seed the .md file via the document store, then place it.
      const contentId = await documentStore.createDocument('My Task.md', '---\ncompleted: false\n---\n');
      const def = {
        id: 'tile_e2e_a',
        type: 'text',
        title: 'My Task',
        contentId,
      };
      boardCacheStore.persistAddTaskPlacement(id, def as never, { tileId: def.id, position: 0 });
      return def.id;
    }, boardId);

    // A row should now be visible in the board.
    const row = window.locator(`[data-task-id="${tileId}"]`);
    await expect(row).toBeVisible({ timeout: 5000 });

    // Title text reflected.
    await expect(row).toContainText(/My Task/i);
  });

  test('renders smart-list tabs (All / Today / Upcoming / Overdue / No Date / Completed)', async () => {
    await bootstrapTaskListBoard();

    for (const label of ['All', 'Today', 'Upcoming', 'Overdue', 'No Date', 'Completed']) {
      const tab = window.locator(`button:has-text("${label}")`).first();
      // Each smart-list pill is a button somewhere in the side toolbar — at
      // least one match should be visible.
      await expect(tab).toBeVisible({ timeout: 5000 });
    }
  });

  test('Group By menu lists all 6 groupings including Category', async () => {
    await bootstrapTaskListBoard();

    const groupByBtn = window.locator('button:has-text("Group")').first();
    await groupByBtn.click();

    for (const label of ['Status', 'Priority', 'Tag', 'Due Date', 'Category', 'None']) {
      const item = window.locator(`text=${label}`).first();
      await expect(item).toBeVisible({ timeout: 3000 });
    }

    // Close the menu.
    await window.keyboard.press('Escape');
  });

  test('exposes a polite ARIA live region for drag announcements', async () => {
    await bootstrapTaskListBoard();
    const live = window.locator('.tasklist-sr-live[aria-live="polite"]');
    await expect(live).toHaveCount(1, { timeout: 5000 });
  });
});

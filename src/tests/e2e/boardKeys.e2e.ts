import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { freshVault, launchBuilt, makeTemp, newBoard, quitLikeUser, removeTemp, type LaunchedApp } from './helpers/app';

/**
 * The Kanban and Task List keyboard in the built app, where Chromium itself
 * turns the menu key and Shift+F10 into a menu at the focused element:
 * the arrows move focus to a Kanban card and either key opens its menu, whose
 * Move to column moves it; on a Task List under the priority sort, Alt+Up
 * moves a task one place on screen and keeps focus on it, and Tab indents one
 * level or, refused, moves focus on; at a laptop's width the Table of
 * Contents opens folded to its header, and its button unfolds it.
 */

let root: string;
let vault: string;

test.beforeAll(() => {
  root = makeTemp('boardkeys');
  vault = freshVault(root, 'KeysVault');
});

test.afterAll(() => removeTemp(root));

async function setWidth(launched: LaunchedApp, w: number): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }, width) => {
    const b = BrowserWindow.getAllWindows()[0];
    if (b.isMaximized()) b.unmaximize();
    b.setContentSize(width, 800);
  }, w);
  await launched.win.waitForTimeout(500);
}

async function quickAdd(win: Page, text: string): Promise<void> {
  const input = win.locator('.quick-add-input').first();
  await input.fill(text);
  await input.press('Enter');
  await win.waitForTimeout(400);
}

const rowTitles = (win: Page): Promise<string[]> =>
  win.locator('.tasklist-row-wrap .task-title').allTextContents().then((t) => t.map((s) => s.trim()));

const focusedTask = (win: Page): Promise<string | null> =>
  win.evaluate(() => {
    const el = document.activeElement;
    return el?.classList.contains('task-item') ? el.closest('.tasklist-row-wrap')?.querySelector('.task-title')?.textContent?.trim() ?? null : null;
  });

const focusedCard = (win: Page): Promise<string | null> =>
  win.evaluate(() => document.activeElement?.closest('.tile-drop-zone')?.querySelector('.tile-title')?.textContent?.trim() ?? null);

const columnCards = (win: Page, index: number): Promise<string[]> =>
  win.locator('.kanban-column').nth(index).locator('.tile-drop-zone .tile-title').allTextContents().then((t) => t.map((s) => s.trim()));

async function addCard(win: Page, column: number, title: string): Promise<void> {
  await win.locator('.kanban-column').nth(column).locator('.add-tile-btn').click();
  await win.locator('.kn-option').first().click();
  await expect(win.locator('.tile-title-editor .ProseMirror')).toBeFocused({ timeout: 10_000 });
  await win.keyboard.type(title);
  await win.keyboard.press('Enter');
  await win.waitForTimeout(800);
}

test('Kanban: the arrows focus a card, and the menu key or Shift+F10 opens its menu', async ({}, info) => {
  const launched = await launchBuilt(vault);
  const { win } = launched;
  try {
    await newBoard(win, 'Kanban');
    await expect(win.locator('.kanban-board').first()).toBeVisible({ timeout: 20_000 });
    while ((await win.locator('.kanban-column').count()) < 3) {
      await win.locator('.add-column-btn').first().click();
      await win.waitForTimeout(300);
    }
    const titleOf = async (i: number): Promise<string> => (await win.locator('.kanban-column').nth(i).locator('.column-title').textContent())?.trim() ?? '';
    const target = await titleOf(2);
    await addCard(win, 0, 'Siege');
    await addCard(win, 1, 'Hidden');
    await addCard(win, 2, 'Harvest');

    // A collapsed column's card is out of a Shift-click range and the arrows.
    await win.locator('.kanban-column').nth(1).locator('button[aria-label="Collapse column"]').click();
    await win.locator('.tile-drop-zone', { hasText: 'Siege' }).click({ position: { x: 40, y: 14 } });
    await win.locator('.tile-drop-zone', { hasText: 'Harvest' }).click({ position: { x: 40, y: 14 }, modifiers: ['Shift'] });
    await expect(win.locator('.tile-drop-zone.selected')).toHaveCount(2);
    await win.keyboard.press('Escape');

    await win.locator('.kanban-board').first().focus();
    await win.keyboard.press('ArrowDown');
    await expect.poll(() => focusedCard(win)).toBe('Siege');
    await win.keyboard.press('ArrowRight');
    await expect.poll(() => focusedCard(win)).toBe('Harvest');
    await win.keyboard.press('ArrowLeft');
    await expect.poll(() => focusedCard(win)).toBe('Siege');
    // The card is brought clear of the docked sidebar lying over the board.
    const sidebarRight = await win.evaluate(() => document.querySelector('.vault-sidebar .sidebar-inner')?.getBoundingClientRect().right ?? 0);
    const siegeLeft = (await win.locator('.tile-drop-zone', { hasText: 'Siege' }).boundingBox())?.x ?? 0;
    expect(siegeLeft).toBeGreaterThanOrEqual(sidebarRight);
    await win.screenshot({ path: info.outputPath('kanban-card-focused.png') });

    await win.keyboard.press('ContextMenu');
    await expect(win.locator('.context-menu')).toContainText('Move to column');
    await win.screenshot({ path: info.outputPath('kanban-menu-key.png') });
    await win.keyboard.press('Escape');
    await expect(win.locator('.context-menu')).toHaveCount(0);
    await expect.poll(() => focusedCard(win)).toBe('Siege');

    await win.keyboard.press('Shift+F10');
    await expect(win.locator('.context-menu')).toContainText('Move to column');
    // The menu opens on the card, not in a corner of the window.
    const card = await win.locator('.tile-drop-zone', { hasText: 'Siege' }).boundingBox();
    const menu = await win.locator('.context-menu').boundingBox();
    expect(Math.abs((menu?.x ?? 0) - (card?.x ?? 0))).toBeLessThan(card?.width ?? 0);
    expect(Math.abs((menu?.y ?? 0) - (card?.y ?? 0))).toBeLessThan((card?.height ?? 0) + 40);
    // The move items list the other columns in order: the last is the third column.
    await win.locator('.context-menu [role="menuitem"]', { hasText: target }).last().click();
    await expect.poll(() => columnCards(win, 2)).toEqual(['Harvest', 'Siege']);
    expect(await columnCards(win, 0)).toEqual([]);
  } finally {
    expect((await quitLikeUser(launched)).outcome).toBe('exited');
  }
});

test('Task List: Alt+Up follows the screen, and Tab indents one level or moves focus on', async () => {
  const launched = await launchBuilt(vault);
  const { win } = launched;
  try {
    await newBoard(win, 'Task List');
    await expect(win.locator('.tasklist-board').first()).toBeVisible({ timeout: 20_000 });
    for (const t of ['Alpha !low', 'Bravo !high', 'Charlie !medium']) await quickAdd(win, t);
    await expect.poll(() => rowTitles(win)).toEqual(['Bravo', 'Charlie', 'Alpha']);

    await win.locator('.task-item', { hasText: 'Charlie' }).focus();
    await win.keyboard.press('Alt+ArrowUp');
    await expect.poll(() => rowTitles(win)).toEqual(['Charlie', 'Bravo', 'Alpha']);
    await expect.poll(() => focusedTask(win)).toBe('Charlie');

    // Bravo goes one level in, under Charlie.
    await win.locator('.task-item', { hasText: 'Bravo' }).focus();
    await win.keyboard.press('Tab');
    await expect(win.locator('.task-item.is-subtask', { hasText: 'Bravo' })).toHaveCount(1);

    // Charlie has no row above it: Tab moves focus on.
    await win.locator('.task-item', { hasText: 'Charlie' }).focus();
    await win.keyboard.press('Tab');
    await expect.poll(() => focusedTask(win)).not.toBe('Charlie');
    expect(await win.locator('.task-item.is-subtask', { hasText: 'Charlie' }).count()).toBe(0);
  } finally {
    expect((await quitLikeUser(launched)).outcome).toBe('exited');
  }
});

test('at 1,280 px the Table of Contents opens folded, and its button unfolds it', async ({}, info) => {
  const launched = await launchBuilt(vault);
  const { win } = launched;
  try {
    await setWidth(launched, 1280);
    await newBoard(win, 'Task List');
    await expect(win.locator('.tasklist-board').first()).toBeVisible({ timeout: 20_000 });
    const panel = win.locator('.floating-toc-panel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.floating-toc-body')).toHaveCount(0);
    await win.screenshot({ path: info.outputPath('toc-folded-1280.png') });

    // Folded, it covers no more than its own header, and not the quick-add box.
    const box = await panel.boundingBox();
    expect(box?.height ?? 0).toBeLessThan(48);
    const quickAdd = await win.locator('.tasklist-quick-add-wrap').boundingBox();
    expect(box?.y ?? 0).toBeGreaterThanOrEqual((quickAdd?.y ?? 0) + (quickAdd?.height ?? 0));

    await panel.locator('.floating-toc-fold').click();
    await expect(panel.locator('.floating-toc-body')).toBeVisible();
    await panel.locator('.floating-toc-fold').click();
    await expect(panel.locator('.floating-toc-body')).toHaveCount(0);
  } finally {
    expect((await quitLikeUser(launched)).outcome).toBe('exited');
  }
});

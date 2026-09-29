import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { freshVault, generateVault, launchBuilt, listFiles, makeTemp, newBoard, openBoardByName, quitLikeUser, removeTemp } from './helpers/app';

/**
 * A plain click on a Kanban card must not leave the board in a drag state:
 * cards added after it have to show, and the column counts must match the
 * board file. A long column scrolls, with Add Card after its last card.
 */

let root: string;

test.beforeAll(() => {
  root = makeTemp('kanban');
});

test.afterAll(() => removeTemp(root));

async function addCard(win: Page): Promise<void> {
  await win.locator('.add-tile-btn').first().click();
  await win.locator('.kn-option').first().click();
  // The new card's title field takes focus; Escape leaves it as made.
  await win.waitForTimeout(800);
  await win.keyboard.press('Escape');
}

function placementsOnDisk(vault: string): number[] {
  const file = listFiles(vault, (p) => p.endsWith('.board.json'))[0];
  const board = JSON.parse(fs.readFileSync(path.join(vault, file), 'utf8')) as {
    board: { columns: Array<{ tilePlacements: unknown[] }> };
  };
  return board.board.columns.map((c) => c.tilePlacements.length);
}

test('cards added after a click on a card still show', async () => {
  const vault = freshVault(root, 'KanbanVault');
  const launched = await launchBuilt(vault);
  const { win } = launched;
  const cards = win.locator('.kanban-card-shell');
  try {
    await newBoard(win, 'Kanban');
    await expect(win.locator('.kanban-board, .add-column-btn').first()).toBeVisible({ timeout: 20_000 });
    if ((await win.locator('.add-tile-btn').count()) === 0) {
      await win.locator('.add-column-btn').first().click();
      await win.keyboard.press('Escape');
    }
    await addCard(win);
    await addCard(win);
    await expect(cards).toHaveCount(2);

    await cards.first().click({ position: { x: 40, y: 14 } });
    await win.waitForTimeout(800);
    await expect(win.locator('.drag-active')).toHaveCount(0);

    await addCard(win);
    await expect(cards).toHaveCount(3);
    await expect.poll(() => placementsOnDisk(vault).reduce((a, b) => a + b, 0), { timeout: 10_000 }).toBe(3);
    const badges = await win.locator('.kanban-board .column-count').allTextContents();
    expect(badges.map((b) => Number(b.trim())).reduce((a, b) => a + b, 0)).toBe(3);
  } finally {
    expect((await quitLikeUser(launched)).outcome).toBe('exited');
  }
});

test("a column taller than the window keeps Add Card after its last card, and it works", async () => {
  const vault = freshVault(root, 'LongColumnVault');
  const { boards } = generateVault(vault, 60);
  const launched = await launchBuilt(vault);
  const { win } = launched;
  try {
    await openBoardByName(win, boards.kanban.replace(/\.board\.json$/, ''));
    const column = win.locator('.kanban-column').first();
    await expect(column.locator('.kanban-card-shell')).toHaveCount(10, { timeout: 20_000 });
    const geo = await column.evaluate((col) => {
      const body = col.querySelector('.column-body') as HTMLElement;
      const cards = col.querySelectorAll('.kanban-card-shell');
      return {
        overflows: body.scrollHeight > body.clientHeight,
        lastCardBottom: cards[cards.length - 1].getBoundingClientRect().bottom,
        buttonTop: col.querySelector('.add-tile-btn')!.getBoundingClientRect().top,
      };
    });
    expect(geo.overflows, 'the column must be taller than the window for this check').toBe(true);
    expect(geo.buttonTop).toBeGreaterThanOrEqual(geo.lastCardBottom);

    await column.locator('.add-tile-btn').click();
    await win.locator('.kn-option').first().click();
    await win.waitForTimeout(800);
    await win.keyboard.press('Escape');
    await expect(column.locator('.kanban-card-shell')).toHaveCount(11);
  } finally {
    expect((await quitLikeUser(launched)).outcome).toBe('exited');
  }
});

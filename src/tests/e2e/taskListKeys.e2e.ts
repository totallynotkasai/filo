import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { freshVault, launchBuilt, listFiles, makeTemp, newBoard, quitLikeUser, removeTemp } from './helpers/app';

/**
 * The Task List and Kanban from the keyboard and the mouse, in the built app
 * (Audit-28 Phase 4): on a list sorted by priority, the arrow keys and a
 * Shift-click range follow the rows on screen and a bulk Delete removes only
 * the highlighted rows; D opens the date picker on the task's day, the arrows
 * and Enter pick a day, and focus comes back to the row; a Kanban card's date
 * is picked in the same picker.
 */

let root: string;
let vault: string;

test.beforeAll(() => {
  root = makeTemp('tasklistkeys');
  vault = freshVault(root, 'KeysVault');
});

test.afterAll(() => removeTemp(root));

function isoInDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function quickAdd(win: Page, text: string): Promise<void> {
  const input = win.locator('.quick-add-input').first();
  await input.fill(text);
  await input.press('Enter');
  await win.waitForTimeout(400);
}

const rowTitles = (win: Page): Promise<string[]> =>
  win.locator('.tasklist-row-wrap .task-title').allTextContents().then((t) => t.map((s) => s.trim()));

const focusedTitle = (win: Page): Promise<string | null> =>
  win.evaluate(() => document.activeElement?.closest('.tasklist-row-wrap')?.querySelector('.task-title')?.textContent?.trim() ?? null);

test('keys, ranges and the date picker follow the screen', async () => {
  const launched = await launchBuilt(vault);
  const { win } = launched;
  try {
    await newBoard(win, 'Task List');
    await expect(win.locator('.tasklist-board').first()).toBeVisible({ timeout: 20_000 });
    for (const t of ['Alpha !low', 'Bravo !high', 'Charlie', 'Delta !urgent', 'Echo tomorrow']) await quickAdd(win, t);
    await expect.poll(() => rowTitles(win)).toEqual(['Delta', 'Bravo', 'Alpha', 'Charlie', 'Echo']);

    // ArrowDown goes to the row below on screen (in the file, Alpha comes first).
    await win.locator('.task-item', { hasText: 'Delta' }).focus();
    await win.keyboard.press('ArrowDown');
    expect(await focusedTitle(win)).toBe('Bravo');
    await win.keyboard.press('ArrowDown');
    expect(await focusedTitle(win)).toBe('Alpha');

    // D: the picker opens on the task's day; Right and Enter pick the next day.
    await win.locator('.task-item', { hasText: 'Echo' }).focus();
    await win.keyboard.press('d');
    await expect(win.locator('.date-popover')).toBeVisible();
    await expect.poll(() => win.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.iso ?? null)).toBe(isoInDays(1));
    await win.keyboard.press('ArrowRight');
    await win.keyboard.press('Enter');
    await expect(win.locator('.date-popover')).toHaveCount(0);
    await expect.poll(() => focusedTitle(win)).toBe('Echo');
    const echo = listFiles(vault, (p) => p.endsWith('Echo.md'))[0]!;
    await expect.poll(() => fs.readFileSync(path.join(vault, echo), 'utf8')).toMatch(new RegExp(`^dueDate: ${isoInDays(2)}$`, 'm'));
    // Escape closes it with nothing picked.
    await win.keyboard.press('d');
    await expect(win.locator('.date-popover')).toBeVisible();
    await win.keyboard.press('Escape');
    await expect(win.locator('.date-popover')).toHaveCount(0);

    // A Shift-click range is the rows between the clicks on screen; Delete removes only those.
    // A click on the row itself, off its title and buttons (which keep their own clicks).
    await win.locator('.task-item', { hasText: 'Delta' }).dispatchEvent('click');
    await win.locator('.task-item', { hasText: 'Alpha' }).dispatchEvent('click', { shiftKey: true });
    await expect(win.locator('.task-item-wrap.selected')).toHaveCount(3);
    await win.locator('.bulk-bar .bar-btn.danger').click();
    await win.locator('.confirm-dialog .confirm-btn:not(.cancel):not(.secondary)').click();
    await expect.poll(() => rowTitles(win)).toEqual(['Charlie', 'Echo']);
  } finally {
    expect((await quitLikeUser(launched)).outcome).toBe('exited');
  }
});

test('a Kanban card\'s date is picked in the date picker', async () => {
  const launched = await launchBuilt(vault);
  const { win } = launched;
  try {
    await newBoard(win, 'Kanban');
    await expect(win.locator('.kanban-board').first()).toBeVisible({ timeout: 20_000 });
    if ((await win.locator('.add-tile-btn').count()) === 0) {
      await win.locator('.add-column-btn').first().click();
      await win.keyboard.press('Escape');
    }
    await win.locator('.add-tile-btn').first().click();
    await win.locator('.kn-option').first().click();
    await expect(win.locator('.tile-title-editor .ProseMirror')).toBeFocused({ timeout: 10_000 });
    await win.keyboard.type('Siege');
    await win.keyboard.press('Enter');
    await win.waitForTimeout(800);
    await win.locator('.kanban-card-shell').first().hover();
    await win.locator('.kanban-card-shell .card-due-btn').first().click();
    await expect(win.locator('.date-popover')).toBeVisible();
    // Typing digits no longer saves a wrong date: the day is chosen whole.
    await win.keyboard.press('ArrowDown');
    await win.keyboard.press('Enter');
    await expect(win.locator('.date-popover')).toHaveCount(0);
    await expect(win.locator('.kanban-card-shell .tile-title')).toHaveText('Siege');
    // The card's note, as the board names it.
    const cardNote = (): string => {
      const rel = listFiles(vault, (p) => p.endsWith('.board.json'))
        .map((p) => JSON.parse(fs.readFileSync(path.join(vault, p), 'utf8')) as { board: { type: string }; tileDefs: Record<string, { filePath?: string }> })
        .find((b) => b.board.type === 'kanban');
      const file = Object.values(rel?.tileDefs ?? {})[0]?.filePath;
      return file ? fs.readFileSync(path.join(vault, file), 'utf8') : '';
    };
    await expect.poll(cardNote).toMatch(new RegExp(`^dueDate: ${isoInDays(7)}$`, 'm'));
  } finally {
    expect((await quitLikeUser(launched)).outcome).toBe('exited');
  }
});

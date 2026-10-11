import { test, expect } from '@playwright/test';
import { freshVault, launchBuilt, makeTemp, quitLikeUser, removeTemp } from './helpers/app';
import type { LaunchedApp } from './helpers/app';

/**
 * The Search panel floats over the sidebar and is moved by its header, which
 * also holds its close button. In the real window a press that starts a drag
 * captures the pointer, and the click then goes to the header: the button
 * must still close the panel, and the header must still move it.
 */

let root: string;
let launched: LaunchedApp;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  root = makeTemp('search');
  launched = await launchBuilt(freshVault(root, 'Search Vault', { 'Note.md': '---\ntitle: Note\n---\nA quiet harbour\n' }));
});

test.afterAll(async () => {
  if (launched) await quitLikeUser(launched);
  removeTemp(root);
});

test('the close button closes the Search panel', async () => {
  const { win } = launched;
  const panel = win.locator('.search-panel');
  await win.keyboard.press('Control+Shift+F');
  await expect(panel).toBeVisible();
  await win.locator('#search-find-input').fill('harbour');
  await expect(panel.locator('.result-count')).toHaveText('1 / 1');
  await panel.locator('button[aria-label="Close search"]').click();
  await expect(panel).toHaveCount(0);
});

test('the header still moves the panel', async () => {
  const { win } = launched;
  const panel = win.locator('.search-panel');
  await win.keyboard.press('Control+Shift+F');
  await expect(panel).toBeVisible();
  const before = (await panel.boundingBox())!;
  const title = (await panel.locator('.drag-handle .title').boundingBox())!;
  await win.mouse.move(title.x + title.width / 2, title.y + title.height / 2);
  await win.mouse.down();
  await win.mouse.move(title.x + title.width / 2 + 120, title.y + title.height / 2 + 60, { steps: 6 });
  await win.mouse.up();
  const after = (await panel.boundingBox())!;
  expect(Math.round(after.x - before.x)).toBe(120);
  expect(Math.round(after.y - before.y)).toBe(60);
  await expect(panel).toBeVisible();
  await panel.locator('button[aria-label="Close search"]').click();
  await expect(panel).toHaveCount(0);
});

// A click outside the panel took the focus with it, and Escape then did nothing.
test('Escape closes the panel after a click outside it', async () => {
  const { win } = launched;
  const panel = win.locator('.search-panel');
  await win.keyboard.press('Control+Shift+F');
  await expect(panel).toBeVisible();
  await win.locator('main.workspace').click({ position: { x: 520, y: 40 } });
  await expect(win.locator('#search-find-input')).not.toBeFocused();
  await win.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
});

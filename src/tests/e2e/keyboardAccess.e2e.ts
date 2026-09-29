import { test, expect } from '@playwright/test';
import { freshVault, launchBuilt, makeTemp, quitLikeUser, removeTemp, sidebarRow } from './helpers/app';
import type { LaunchedApp } from './helpers/app';

/**
 * Keyboard use the component tests can't show in a real window: a context
 * menu driven by keys, and a sidebar row's actions revealed by focus (they
 * are invisible until hover or focus, so a keyboard user must not Tab blind).
 */

let root: string;
let launched: LaunchedApp;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  root = makeTemp('keys');
  launched = await launchBuilt(freshVault(root, 'Keys Vault', { 'Note.md': '---\ntitle: Note\n---\nBody\n', 'Other.md': 'Untouched\n' }));
});

test.afterAll(async () => {
  if (launched) await quitLikeUser(launched);
  removeTemp(root);
});

test('a sidebar context menu: arrows move, Home / End jump, Escape closes', async () => {
  const { win } = launched;
  await sidebarRow(win, 'Note.md').click({ button: 'right' });
  const menu = win.locator('.context-menu[role="menu"]');
  await expect(menu).toBeVisible();
  const focused = win.locator('.context-menu .menu-item.focused');
  const items = await win.locator('.context-menu [role="menuitem"]').allTextContents();
  expect(items.length).toBeGreaterThan(2);
  const label = (i: number): RegExp => new RegExp(items[i].trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

  await expect(focused).toHaveText(label(0));
  await win.keyboard.press('ArrowDown');
  await expect(focused).toHaveText(label(1));
  await win.keyboard.press('ArrowUp');
  await expect(focused).toHaveText(label(0));
  await win.keyboard.press('ArrowUp'); // wraps to the last item
  await expect(focused).toHaveText(label(items.length - 1));
  await win.keyboard.press('Home');
  await expect(focused).toHaveText(label(0));
  await win.keyboard.press('End');
  await expect(focused).toHaveText(label(items.length - 1));
  await win.keyboard.press('Escape');
  await expect(win.locator('.context-menu')).toHaveCount(0);
});

test("focusing a sidebar row's Delete button (a row not selected or hovered) reveals the row's actions", async () => {
  const { win } = launched;
  await win.mouse.move(5, 5); // off the sidebar: no hover
  const deleteBtn = win.locator('button[aria-label="Delete Other.md"]');
  const actions = win.locator('.file-actions', { has: deleteBtn });
  await expect(actions).toHaveCSS('opacity', '0');
  await deleteBtn.focus();
  await expect(deleteBtn).toBeFocused();
  await expect(actions).toHaveCSS('opacity', '1');
});

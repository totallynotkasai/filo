import { test, expect, _electron as electron } from '@playwright/test';
import path from 'path';

let electronApp: Awaited<ReturnType<typeof electron.launch>>;
let window: Awaited<ReturnType<typeof electronApp.firstWindow>>;

test.beforeAll(async () => {
  electronApp = await electron.launch({
    args: [path.join(__dirname, '..', '..', '..', 'dist-electron', 'main', 'main.js')],
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

/**
 * Phase 6.2 — Context menu is navigable by keyboard.
 *
 * The menu is driven by uiStore.showContextMenu — we open it programmatically
 * so the test focuses on keyboard behaviour (ARIA roles, focus, Arrow/Home/End,
 * Enter, Escape) rather than on the specific call site that would have opened it.
 */
test.describe('ContextMenu — keyboard navigation', () => {
  test('opens with role=menu and menuitem children', async () => {
    await window.evaluate(async () => {
      const { uiStore } = await import('/src/renderer/stores/ui.svelte.ts');
      uiStore.showContextMenu(100, 100, [
        { label: 'First', action: () => {} },
        { label: 'Second', action: () => {} },
        { divider: true },
        { label: 'Third', action: () => {} },
      ]);
    });

    const menu = window.locator('.context-menu[role="menu"]');
    await expect(menu).toBeVisible({ timeout: 2000 });

    const items = window.locator('.context-menu [role="menuitem"]');
    await expect(items).toHaveCount(3);

    const firstFocused = window.locator('.context-menu .menu-item.focused').first();
    await expect(firstFocused).toHaveText(/First/);
  });

  test('ArrowDown advances focus, ArrowUp wraps to last', async () => {
    await window.keyboard.press('ArrowDown');
    const second = window.locator('.context-menu .menu-item.focused');
    await expect(second).toHaveText(/Second/);

    await window.keyboard.press('ArrowUp');
    const first = window.locator('.context-menu .menu-item.focused');
    await expect(first).toHaveText(/First/);

    // Wrap-around: up from first goes to last
    await window.keyboard.press('ArrowUp');
    const last = window.locator('.context-menu .menu-item.focused');
    await expect(last).toHaveText(/Third/);
  });

  test('Home/End jump to first/last menuitem', async () => {
    await window.keyboard.press('Home');
    await expect(window.locator('.context-menu .menu-item.focused')).toHaveText(/First/);

    await window.keyboard.press('End');
    await expect(window.locator('.context-menu .menu-item.focused')).toHaveText(/Third/);
  });

  test('Escape closes the menu', async () => {
    await window.keyboard.press('Escape');
    await expect(window.locator('.context-menu')).toHaveCount(0);
  });

  test('Enter activates the focused item and closes the menu', async () => {
    const invoked = await window.evaluate(async () => {
      const { uiStore } = await import('/src/renderer/stores/ui.svelte.ts');
      let flag = false;
      uiStore.showContextMenu(120, 120, [
        { label: 'Alpha', action: () => {} },
        { label: 'Beta', action: () => { flag = true; } },
      ]);
      (window as unknown as { __ctxFlag: () => boolean }).__ctxFlag = () => flag;
      return true;
    });
    expect(invoked).toBe(true);

    await window.locator('.context-menu[role="menu"]').waitFor();
    await window.keyboard.press('ArrowDown');
    await window.keyboard.press('Enter');

    await expect(window.locator('.context-menu')).toHaveCount(0);

    const flagResult = await window.evaluate(() =>
      (window as unknown as { __ctxFlag: () => boolean }).__ctxFlag(),
    );
    expect(flagResult).toBe(true);
  });
});

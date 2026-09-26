import { test, expect, _electron as electron } from '@playwright/test';
import path from 'path';

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

test.describe('Filo E2E — App Shell', () => {
  test('window opens and renders the home screen', async () => {
    // Should show the Filo title
    const title = await window.locator('.home-title, .welcome-title').first();
    await expect(title).toBeVisible({ timeout: 10000 });
    const text = await title.textContent();
    expect(text).toContain('Filo');
  });

  test('has a global toolbar', async () => {
    const toolbar = window.locator('.global-toolbar');
    await expect(toolbar).toBeVisible();
  });

  test('has a home button', async () => {
    const homeBtn = window.locator('button[aria-label="Home screen"]');
    await expect(homeBtn).toBeVisible();
  });

  test('has new project and open project buttons', async () => {
    const newBtn = window.locator('text=New Project').first();
    const openBtn = window.locator('text=Open Project').first();
    await expect(newBtn).toBeVisible();
    await expect(openBtn).toBeVisible();
  });

  test('can create a new project', async () => {
    const newBtn = window.locator('.action-card >> text=New Project').first();
    if (await newBtn.isVisible()) {
      await newBtn.click();
    } else {
      // Try via toolbar dropdown
      const welcomeBtn = window.locator('.welcome-btn.primary, .action-card').first();
      await welcomeBtn.click();
    }

    // After creating a project, should show empty workspace or tab bar
    await window.waitForTimeout(500);
    const workspace = window.locator('.workspace');
    await expect(workspace).toBeVisible();
  });

  test('can open settings', async () => {
    // Click the vault menu
    const dropdown = window.locator('.dropdown-trigger').first();
    await dropdown.click();

    // Audit-14 7.6 — the Settings entry must be reachable. The prior
    // `if (await settingsBtn.isVisible())` guard made the whole test vacuous: it
    // silently passed when the dropdown never rendered the entry. Assert it
    // exists, then drive the open/close flow with real assertions.
    const settingsBtn = window.locator('.dropdown-item', { hasText: /^\s*Settings\s*$/ }).first();
    await expect(settingsBtn).toBeVisible({ timeout: 3000 });
    await settingsBtn.click();

    // Settings modal should appear…
    const modal = window.locator('.modal-dialog');
    await expect(modal).toBeVisible({ timeout: 3000 });

    // …and Escape should close it.
    await window.keyboard.press('Escape');
    await expect(modal).toBeHidden({ timeout: 3000 });
  });

  test('keyboard shortcuts work', async () => {
    // Audit-14 7.6 — assert a real effect instead of pressing a key and checking
    // nothing. Ctrl+Shift+F is the vault-wide Search shortcut (AppShell registers
    // `vault:search` on { key:'f', ctrl:true, shift:true } → searchStore.openPanel).
    // The prior test pressed the wrong combo (Control+f) and asserted nothing.
    await window.keyboard.press('Control+Shift+F');
    const searchPanel = window.locator('.search-panel');
    await expect(searchPanel).toBeVisible({ timeout: 3000 });

    // Escape closes it (the role="search" landmark captures the bubbled Escape).
    await window.keyboard.press('Escape');
    await expect(searchPanel).toBeHidden({ timeout: 3000 });
  });
});

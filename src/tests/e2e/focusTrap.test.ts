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

/**
 * Verifies the `focus-trap` integration in Modal.svelte. Filo relies on
 * the trap for WCAG 2.1.2 (no keyboard trap) compliance — the actual
 * library is well-tested, but this asserts our integration points are
 * still wired so a future refactor cannot silently remove the trap.
 *
 * The Project Settings modal is the test subject because it is the
 * widest modal with the most tabbable controls, and it is already used
 * by a11y.test.ts so the open path is known-good.
 */
test.describe('Modal focus trap', () => {
  test.beforeEach(async () => {
    await window.evaluate(() => {
      // Reset so each test sees the modal closed.
      return import('/src/renderer/stores/ui.svelte.ts').then(({ uiStore }) => {
        uiStore.closeModal();
      });
    });
  });

  test('Tab cycles within an open modal — never escapes to body chrome', async () => {
    await window.evaluate(async () => {
      const { uiStore } = await import('/src/renderer/stores/ui.svelte.ts');
      uiStore.openModal('project-settings');
    });

    const dialog = window.locator('dialog[aria-modal="true"]').first();
    await expect(dialog).toBeVisible({ timeout: 3_000 });

    // Press Tab several times and confirm activeElement stays inside the
    // dialog. 10 cycles is enough to wrap through any reasonable trap.
    for (let i = 0; i < 10; i++) {
      await window.keyboard.press('Tab');
      const insideDialog = await window.evaluate(() => {
        const active = document.activeElement;
        const dlg = document.querySelector('dialog[aria-modal="true"]');
        return !!(active && dlg && dlg.contains(active));
      });
      expect(insideDialog, `Tab #${i + 1} escaped the dialog`).toBe(true);
    }
  });

  test('Shift+Tab also stays trapped inside the modal', async () => {
    await window.evaluate(async () => {
      const { uiStore } = await import('/src/renderer/stores/ui.svelte.ts');
      uiStore.openModal('project-settings');
    });

    const dialog = window.locator('dialog[aria-modal="true"]').first();
    await expect(dialog).toBeVisible({ timeout: 3_000 });

    for (let i = 0; i < 10; i++) {
      await window.keyboard.press('Shift+Tab');
      const insideDialog = await window.evaluate(() => {
        const active = document.activeElement;
        const dlg = document.querySelector('dialog[aria-modal="true"]');
        return !!(active && dlg && dlg.contains(active));
      });
      expect(insideDialog, `Shift+Tab #${i + 1} escaped the dialog`).toBe(true);
    }
  });

  test('Escape closes the modal', async () => {
    await window.evaluate(async () => {
      const { uiStore } = await import('/src/renderer/stores/ui.svelte.ts');
      uiStore.openModal('project-settings');
    });

    const dialog = window.locator('dialog[aria-modal="true"]').first();
    await expect(dialog).toBeVisible({ timeout: 3_000 });

    await window.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
});

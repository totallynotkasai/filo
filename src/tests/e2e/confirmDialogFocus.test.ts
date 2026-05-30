import { test, expect, _electron as electron } from '@playwright/test';
import path from 'path';

/**
 * Phase C / C.6 — ConfirmDialog focus management.
 *
 * Verifies (i) Cancel is the initially-focused button for destructive
 * confirms, (ii) Confirm is focused for non-destructive confirms, and
 * (iii) Tab cycling stays inside the dialog (focus trap active).
 *
 * Lives in E2E because the codebase has no Svelte component mounting
 * infrastructure in vitest (vitePreprocess fails on `<style>` blocks
 * in the test env). Mirrors the existing focusTrap.test.ts pattern.
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

test.describe('ConfirmDialog focus management (Phase C / C.6)', () => {
  test.beforeEach(async () => {
    await window.evaluate(() => {
      return import('/src/renderer/stores/ui.svelte.ts').then(({ uiStore }) => {
        uiStore.closeConfirm();
      });
    });
  });

  test('danger=true focuses the Cancel button', async () => {
    await window.evaluate(async () => {
      const { uiStore } = await import('/src/renderer/stores/ui.svelte.ts');
      uiStore.openConfirm({
        title: 'Delete file?',
        body: 'Permanent.',
        confirmLabel: 'Delete',
        danger: true,
        onConfirm: () => {},
      });
    });

    const dialog = window.locator('dialog.confirm-dialog');
    await expect(dialog).toBeVisible({ timeout: 3_000 });

    // Wait for the post-tick focus call.
    await window.waitForFunction(() => {
      const dlg = document.querySelector('dialog.confirm-dialog');
      const active = document.activeElement;
      return !!(dlg && active && dlg.contains(active));
    });

    const focusedIsCancel = await window.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      return !!(active && active.classList.contains('cancel'));
    });
    expect(focusedIsCancel).toBe(true);
  });

  test('non-danger focuses the Confirm button', async () => {
    await window.evaluate(async () => {
      const { uiStore } = await import('/src/renderer/stores/ui.svelte.ts');
      uiStore.openConfirm({
        title: 'Save changes?',
        body: 'Continue.',
        confirmLabel: 'Save',
        onConfirm: () => {},
      });
    });

    const dialog = window.locator('dialog.confirm-dialog');
    await expect(dialog).toBeVisible({ timeout: 3_000 });

    await window.waitForFunction(() => {
      const dlg = document.querySelector('dialog.confirm-dialog');
      const active = document.activeElement;
      return !!(dlg && active && dlg.contains(active) && !active.classList.contains('cancel'));
    });

    const focusedIsConfirm = await window.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      return !!(active
        && active.classList.contains('confirm-btn')
        && !active.classList.contains('cancel'));
    });
    expect(focusedIsConfirm).toBe(true);
  });

  test('Tab cycles within the dialog (focus trap)', async () => {
    await window.evaluate(async () => {
      const { uiStore } = await import('/src/renderer/stores/ui.svelte.ts');
      uiStore.openConfirm({
        title: 'Discard?',
        body: 'Throws away your edits.',
        confirmLabel: 'Discard',
        danger: true,
        onConfirm: () => {},
      });
    });

    const dialog = window.locator('dialog.confirm-dialog');
    await expect(dialog).toBeVisible({ timeout: 3_000 });

    for (let i = 0; i < 6; i++) {
      await window.keyboard.press('Tab');
      const insideDialog = await window.evaluate(() => {
        const active = document.activeElement;
        const dlg = document.querySelector('dialog.confirm-dialog');
        return !!(active && dlg && dlg.contains(active));
      });
      expect(insideDialog, `Tab #${i + 1} escaped the confirm dialog`).toBe(true);
    }
  });
});

import { test, expect, _electron as electron } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';

/**
 * 3.2 (Audit2 2026-05-31) — keyboard focus must REVEAL the sidebar row's
 * action buttons.
 *
 * `.file-actions` is `opacity: 0; pointer-events: none`, raised to opacity 1
 * only by `.vault-file-item:hover` (and the `.has-pinned-active` pin). The
 * buttons are real `<button>`s with no `tabindex="-1"`, so a keyboard user
 * Tabs straight onto a fully transparent **Delete file** control — an
 * irreversible action that cascades placement removal across boards (WCAG
 * 2.4.7). The fix adds `:focus-within` (mirroring TileHeader / TaskItem) so
 * focusing any action reveals the group and the global `:focus-visible`
 * ring becomes visible.
 *
 * This drives the real built sidebar: it focuses the Delete button and
 * asserts the wrapper transitions from opacity 0 → 1. Before the fix the
 * wrapper stays at 0 (invisible focus target).
 */

let electronApp: Awaited<ReturnType<typeof electron.launch>>;
let window: Awaited<ReturnType<typeof electronApp.firstWindow>>;
let tempVault: string;

const NOTE = 'Note.md';

test.beforeAll(async () => {
  tempVault = fs.mkdtempSync(path.join(os.tmpdir(), 'filo-delete-focus-e2e-'));
  fs.writeFileSync(path.join(tempVault, NOTE), '# Note\n', 'utf8');

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
  try {
    fs.rmSync(tempVault, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test('keyboard focus reveals the sidebar Delete button (not an invisible target)', async () => {
  test.setTimeout(30_000);

  // Open the seeded vault so the Note.md row renders in the sidebar.
  const opened = await window.evaluate(async (vaultPath: string) => {
    const { vaultStore } = await import('/src/renderer/stores/vault.svelte.ts');
    if (!vaultStore.project) {
      await vaultStore.openVault(vaultPath);
    }
    return !!vaultStore.tree.find((n) => !n.isDirectory && n.name === 'Note.md');
  }, tempVault);

  expect(opened, 'Note.md should appear in the vault tree').toBe(true);

  // The Delete control for the Note.md row, plus its containing action group.
  const deleteBtn = window.locator('button[aria-label="Delete Note.md"]');
  await expect(deleteBtn).toBeAttached({ timeout: 5_000 });

  const fileActions = window.locator('.file-actions', {
    has: window.locator('button[aria-label="Delete Note.md"]'),
  });

  // Without hover / focus the group is fully transparent — this is the state
  // a keyboard user would otherwise Tab into blind.
  await expect(fileActions).toHaveCSS('opacity', '0');

  // Focusing the Delete button must reveal the group via `:focus-within`.
  await deleteBtn.focus();
  await expect(deleteBtn).toBeFocused();
  await expect(fileActions).toHaveCSS('opacity', '1');
});

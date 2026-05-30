import { test, expect, _electron as electron } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';

/**
 * F5 (Audit 2026-05-28) — Escape during a sidebar rename must CANCEL, not
 * commit.
 *
 * The rename `<input>` commits on blur (`onblur={commitRename}`). Pressing
 * Escape sets `isRenaming = false`, which unmounts the input and fires that
 * blur — so without a cancel guard the blur committed the very rename the
 * user just aborted. This spec drives the real sidebar input and asserts the
 * file on disk keeps its original name.
 *
 * Drives the rename via `uiStore.setPendingSidebarRenameId` (the same signal
 * the "New file/folder" flow uses to auto-enter rename mode) so the test does
 * not depend on hover-reveal action buttons.
 */

let electronApp: Awaited<ReturnType<typeof electron.launch>>;
let window: Awaited<ReturnType<typeof electronApp.firstWindow>>;
let tempVault: string;

const ORIGINAL = 'Note.md';

test.beforeAll(async () => {
  tempVault = fs.mkdtempSync(path.join(os.tmpdir(), 'filo-rename-escape-e2e-'));
  fs.writeFileSync(path.join(tempVault, ORIGINAL), '# Note\n', 'utf8');

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

test('Escape cancels a sidebar rename — the file keeps its original name', async () => {
  test.setTimeout(30_000);

  // Open the seeded vault and put the Note.md row into rename mode.
  const nodePath = await window.evaluate(async (vaultPath: string) => {
    const { vaultStore } = await import('/src/renderer/stores/vault.svelte.ts');
    const { uiStore } = await import('/src/renderer/stores/ui.svelte.ts');
    if (!vaultStore.project) {
      await vaultStore.openVault(vaultPath);
    }
    const node = vaultStore.tree.find((n) => !n.isDirectory && n.name === 'Note.md');
    if (!node) return null;
    uiStore.setPendingSidebarRenameId(node.path);
    return node.path;
  }, tempVault);

  expect(nodePath, 'Note.md should appear in the vault tree').toBeTruthy();

  // The row auto-enters rename mode; the input mounts focused + selected.
  const input = window.locator('.rename-input');
  await expect(input).toBeVisible({ timeout: 5_000 });

  // Type a new name, then abort with Escape.
  await input.fill('Renamed');
  await window.keyboard.press('Escape');

  // The input is dismissed...
  await expect(input).toHaveCount(0, { timeout: 2_000 });

  // ...and — the regression — no rename was committed. Give a would-be rename
  // IPC ample time to land on disk before asserting it did NOT happen.
  await window.waitForTimeout(800);

  expect(
    fs.existsSync(path.join(tempVault, ORIGINAL)),
    'original file must still exist after Escape',
  ).toBe(true);
  expect(
    fs.existsSync(path.join(tempVault, 'Renamed.md')),
    'aborted rename must not have created a renamed file',
  ).toBe(false);
});

import { test, expect, _electron as electron } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';

/**
 * Dependency-upgrade regression guard (DEPENDENCY_UPGRADE_REPORT_2026-09-23 §0.2).
 *
 * Svelte 5.57.1 turned a pre-existing `effect_update_depth_exceeded` loop in the
 * Document editor's open path into a PHANTOM WRITE: merely opening a CRLF note
 * rewrote it on disk with its body flipped to LF. `ci:verify` cannot see this —
 * only the built renderer running in a real Electron window reproduces it — so
 * this spec opens a CRLF (and an LF) note in a Document tab and asserts:
 *   1. the file's bytes are unchanged, and
 *   2. the renderer logged zero `effect_update_depth_exceeded` errors.
 *
 * Drives the app the same way as `recoveryRelaunch.test.ts`: stub the main
 * process `dialog.showOpenDialog` so the home-screen "Open Vault" button
 * resolves to a temp vault (test scaffolding, not an app-code change).
 * Requires a prior `npm run build`. Run serially (`--workers=1`).
 */

const MAIN = path.join(__dirname, '..', '..', '..', 'dist', 'main', 'main.js');

const FIXTURES: Record<string, string> = {
  'Crlf Note.md':
    '---\r\ntitle: Crlf Note\r\ntags: [alpha]\r\n---\r\n# Hello\r\n\r\nSome **bold** text.\r\n\r\n- one\r\n- two\r\n',
  'Lf Note.md': '---\ntitle: Lf Note\n---\n# Heading\n\nA paragraph with *emphasis*.\n',
};

for (const [fileName, content] of Object.entries(FIXTURES)) {
  test(`opening "${fileName}" in a Document tab leaves its bytes unchanged`, async () => {
    test.setTimeout(90_000);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'filo-docopen-e2e-'));
    const vault = path.join(root, 'vault');
    fs.mkdirSync(vault);
    const filePath = path.join(vault, fileName);
    fs.writeFileSync(filePath, content);
    const before = fs.readFileSync(filePath);

    const app = await electron.launch({
      args: [MAIN, `--user-data-dir=${path.join(root, 'udd')}`],
      env: { ...process.env, NODE_ENV: 'test' },
    });
    try {
      await app.evaluate(({ dialog }, picked) => {
        dialog.showOpenDialog = (async () => ({
          canceled: false,
          filePaths: [picked],
        })) as typeof dialog.showOpenDialog;
      }, vault);

      const win = await app.firstWindow();
      const errors: string[] = [];
      win.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      win.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
      await win.waitForLoadState('domcontentloaded');

      const openVault = win.locator('button.action-card', { hasText: 'Open Vault' });
      await openVault.click();
      await expect(openVault).toBeHidden({ timeout: 15_000 });

      const stem = fileName.replace(/\.md$/, '');
      const row = win.locator('.vault-file-item', { hasText: stem }).first();
      await expect(row).toBeVisible({ timeout: 10_000 });
      await row.dblclick();
      await expect(win.locator('.document-board .ProseMirror').first()).toContainText(
        /Hello|Heading/,
        { timeout: 10_000 },
      );

      // Outlast the 300 ms write debounce with margin: a phantom write would land here.
      await win.waitForTimeout(2_000);

      const after = fs.readFileSync(filePath);
      expect(JSON.stringify(after.toString('utf8'))).toBe(JSON.stringify(before.toString('utf8')));
      const loops = errors.filter((e) => e.includes('effect_update_depth_exceeded'));
      expect(loops, loops.join('\n')).toEqual([]);
    } finally {
      await app.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

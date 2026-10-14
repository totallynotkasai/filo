import { test, expect, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { freshVault, launchBuilt, makeTemp, quitLikeUser, removeTemp, toasts, withClipboardKept } from './helpers/app';
import type { LaunchedApp } from './helpers/app';

/**
 * Finding out what went wrong, in the built app:
 *
 * - Ctrl+Shift+I and F12 open Chromium's developer tools only once
 *   General → Developer tools is on (kept per machine in
 *   `recent-vaults.json`), and turning it off closes them;
 * - Chromium's ResizeObserver notice, which arrives as a window error, shows
 *   no toast;
 * - any other error's toast copies its own text with Copy details, and stays.
 */

let root: string;
let launched: LaunchedApp;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  root = makeTemp('devtools');
  const vault = freshVault(root, 'Devtools Vault', { 'River Road.md': '---\ntitle: River Road\n---\nAria rode north.\n' });
  launched = await launchBuilt(vault);
});

test.afterAll(async () => {
  if (launched) await quitLikeUser(launched);
  removeTemp(root);
});

const devToolsOpen = (app: ElectronApplication): Promise<boolean> =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.webContents.isDevToolsOpened()));

/**
 * Presses a key the way the keyboard does. Playwright's own keys reach the page
 * over the debugging protocol, past Electron's `before-input-event`, where main
 * decides about the developer tools; `sendInputEvent` takes a real key's way in.
 */
async function pressKey(app: ElectronApplication, keyCode: 'F12' | 'I', modifiers: Array<'control' | 'shift'> = []): Promise<void> {
  await app.evaluate(({ BrowserWindow }, key) => {
    const contents = BrowserWindow.getAllWindows()[0]?.webContents;
    contents?.sendInputEvent({ type: 'keyDown', keyCode: key.keyCode, modifiers: key.modifiers });
    contents?.sendInputEvent({ type: 'keyUp', keyCode: key.keyCode, modifiers: key.modifiers });
  }, { keyCode, modifiers });
}

function savedSwitch(userDataDir: string): unknown {
  const file = path.join(userDataDir, 'recent-vaults.json');
  if (!fs.existsSync(file)) return undefined;
  return (JSON.parse(fs.readFileSync(file, 'utf8')) as { preferences?: { devToolsEnabled?: unknown } }).preferences?.devToolsEnabled;
}

test('the developer tools open only while General → Developer tools is on', async () => {
  const { app, win, userDataDir } = launched;
  await pressKey(app, 'F12');
  await pressKey(app, 'I', ['control', 'shift']);
  await win.waitForTimeout(1_000);
  expect(await devToolsOpen(app), 'the keys do nothing while the switch is off').toBe(false);

  await win.keyboard.press('Control+,');
  await win.locator('#settings-tab-general').click();
  const toggle = win.locator('button[role="switch"][aria-label="Developer tools"]');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => savedSwitch(userDataDir)).toBe(true);

  await pressKey(app, 'F12');
  await expect.poll(() => devToolsOpen(app)).toBe(true);
  await pressKey(app, 'I', ['control', 'shift']);
  await expect.poll(() => devToolsOpen(app)).toBe(false);

  await win.getByRole('button', { name: 'Open developer tools' }).click();
  await expect.poll(() => devToolsOpen(app)).toBe(true);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect.poll(() => devToolsOpen(app), { message: 'turning the switch off closes them' }).toBe(false);
  await expect.poll(() => savedSwitch(userDataDir)).toBe(false);
  await pressKey(app, 'F12');
  await win.waitForTimeout(1_000);
  expect(await devToolsOpen(app)).toBe(false);

  await win.keyboard.press('Escape');
  await expect(win.locator('#settings-tab-general')).toHaveCount(0);
});

test("Chromium's ResizeObserver notice shows no toast", async () => {
  const { win } = launched;
  // An observer that resizes what it observes: Chromium reports the notice
  // for each frame that does it.
  const notices = await win.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let count = 0;
        const onError = (e: ErrorEvent): void => {
          if (e.message.startsWith('ResizeObserver loop')) count++;
        };
        window.addEventListener('error', onError);
        const el = document.createElement('div');
        el.style.cssText = 'position:fixed;left:0;top:0;width:10px;height:10px;';
        document.body.appendChild(el);
        let n = 0;
        const ro = new ResizeObserver(() => {
          if (n < 5) el.style.width = `${20 + ++n * 10}px`;
        });
        ro.observe(el);
        setTimeout(() => {
          ro.disconnect();
          el.remove();
          window.removeEventListener('error', onError);
          resolve(count);
        }, 1_000);
      }),
  );
  expect(notices, 'the notice really fired').toBeGreaterThan(0);
  expect((await toasts(win)).filter((t) => /unexpected/i.test(t))).toEqual([]);
});

// This case uses the machine's real clipboard: what it held is put back after.
test("another error's toast copies the error's own text with Copy details, and stays", async () => {
  const { app, win } = launched;
  await win.evaluate(() => {
    setTimeout(() => {
      throw new Error('thrown on purpose by the E2E spec');
    }, 0);
  });
  const toast = win.locator('.toast', { hasText: 'An unexpected error occurred.' });
  await expect(toast).toBeVisible();

  await withClipboardKept(app, async () => {
    await toast.locator('.toast-action', { hasText: 'Copy details' }).click();
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toContain('thrown on purpose by the E2E spec');
    const text = await app.evaluate(({ clipboard }) => clipboard.readText());
    expect(text).toMatch(/^Filo \d+\.\d+\.\d+ \(/);
    expect(text).toContain('Where: window.onerror');
    expect(text).toContain('Message: An unexpected error occurred.');
  });
  await expect(win.locator('.toast', { hasText: 'Error details copied.' })).toBeVisible();
  await expect(toast).toBeVisible();
});

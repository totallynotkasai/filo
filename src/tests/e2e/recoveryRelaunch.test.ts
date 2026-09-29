import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';

/**
 * Audit-15 Phase 0 / P0.2 — crash-recovery kill-relaunch E2E.
 *
 * The `.filo/.dirty.<machineId>` sentinel is the backstop the Phase-1 write races rely on:
 * if the process dies inside a debounced-write window, the next vault open must
 * surface the Recovery modal listing the files that were mid-write. This spec
 * proves that wiring fires end-to-end against a real Electron binary — the one
 * thing the static audit + `ci:verify` could not cover.
 *
 * How it drives the app
 * ---------------------
 * The other E2E specs open a vault by calling `vaultStore.openVault()` via
 * `window.evaluate(() => import('/src/renderer/...'))`. Those `/src/...` paths
 * only resolve against a Vite dev server; the packaged / `loadFile` renderer
 * (what `electron.launch(dist/main/main.js)` runs) can't serve them, so that
 * pattern needs a dev-server harness the repo doesn't have yet. Instead, this
 * spec stubs the MAIN-process folder picker (`dialog.showOpenDialog`, which
 * `vault:select` calls) so the real home-screen "Open Vault" button resolves to
 * a temp vault. Stubbing main-process `dialog` from test code is a standard
 * Playwright-Electron technique — it is test scaffolding, NOT an app-code
 * change — and it exercises the genuine production `openVault` → recovery path
 * against the built renderer.
 *
 * Faithfulness of the "kill mid-write"
 * ------------------------------------
 * A real mid-write kill leaves a `.filo/.dirty.<machineId>` sentinel carrying the
 * crashed session's pending paths and (since Audit-14 1.3) that session's
 * `launchId`. We reproduce that exact on-disk artifact: open the vault in a
 * first instance (so `.filo/` config exists, matching a normal prior session),
 * write the sentinel bytes an armed-but-unflushed write leaves, then SIGKILL
 * the process so no graceful `app:flush-and-quit` / `markClean` can clear it.
 * The relaunch, the recovery read, the modal, and the acknowledge-clears-the-
 * sentinel path are all the real production code.
 */

const MAIN = path.join(__dirname, '..', '..', '..', 'dist', 'main', 'main.js');

let tempRoot: string;

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'filo-recovery-e2e-'));
});

test.afterAll(() => {
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/**
 * Launches the built app and stubs the native vault-folder picker so the
 * home-screen "Open Vault" button resolves to `vaultPath` without a real OS
 * dialog (which Playwright cannot drive). The stub replaces only
 * `dialog.showOpenDialog`; everything downstream (`vault:select` → `openVault`
 * → recovery sequencer) is the real app.
 */
async function launchApp(
  vaultPath: string,
  sameMachineAs?: string,
): Promise<{ app: ElectronApplication; window: Page; userDataDir: string }> {
  // Fresh per-launch `userData` so recent-vaults / launch-preference state can't
  // leak across launches. Otherwise a prior open lands in `recent-vaults.json`
  // (a per-machine file outside the vault) and `maybeAutoOpenLastVault` reopens
  // it on the next launch — detaching the home screen before we can drive the
  // stubbed "Open Vault" flow.
  const userDataDir = fs.mkdtempSync(path.join(tempRoot, 'udd-'));
  // Crash sentinels are per machine, and the machine id lives in userData: a
  // relaunch on "the same machine" carries the earlier launch's id over.
  if (sameMachineAs) {
    fs.copyFileSync(path.join(sameMachineAs, 'machine-id.json'), path.join(userDataDir, 'machine-id.json'));
  }
  const app = await electron.launch({
    args: [MAIN, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, NODE_ENV: 'test' },
  });
  await app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [picked],
    })) as typeof dialog.showOpenDialog;
  }, vaultPath);
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  return { app, window, userDataDir };
}

/** A launch's machine id (created in its userData on first launch). */
function machineIdOf(userDataDir: string): string {
  const { id } = JSON.parse(fs.readFileSync(path.join(userDataDir, 'machine-id.json'), 'utf8')) as { id: string };
  return id;
}

/** Clicks the home-screen "Open Vault" action card. */
async function clickOpenVault(window: Page): Promise<void> {
  const openBtn = window.locator('button.action-card', { hasText: 'Open Vault' });
  await expect(openBtn).toBeVisible({ timeout: 15_000 });
  await openBtn.click();
}

/** Waits until the vault has opened (the home action cards are gone). */
async function expectVaultOpened(window: Page): Promise<void> {
  await expect(window.locator('button.action-card', { hasText: 'Open Vault' })).toBeHidden({
    timeout: 15_000,
  });
}

test.describe('Filo E2E — crash recovery (kill mid-write → relaunch)', () => {
  test('clean vault opens without surfacing the Recovery modal', async () => {
    test.setTimeout(60_000);

    const vault = path.join(tempRoot, 'clean');
    fs.mkdirSync(vault, { recursive: true });
    fs.writeFileSync(path.join(vault, 'Notes.md'), '---\ntitle: Notes\n---\nclean body\n', 'utf8');

    const { app, window } = await launchApp(vault);
    try {
      await clickOpenVault(window);
      await expectVaultOpened(window);
      // A session that shut down cleanly leaves no sentinel — the modal must
      // not fire. Settle past the async recovery sequencer before asserting.
      await window.waitForTimeout(1500);
      await expect(window.locator('.recovery-item')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test('kill mid-write → relaunch surfaces the Recovery modal listing the pending path', async () => {
    test.setTimeout(90_000);

    const vault = path.join(tempRoot, 'crash');
    fs.mkdirSync(vault, { recursive: true });
    fs.writeFileSync(path.join(vault, 'Notes.md'), '---\ntitle: Notes\n---\noriginal body\n', 'utf8');

    // ── Phase A — open the vault once (seeds `.filo/` config like a normal
    //    prior session), reproduce an armed-but-unflushed write, then kill
    //    the process abnormally so no graceful markClean runs. ──
    const a = await launchApp(vault);
    await clickOpenVault(a.window);
    await expectVaultOpened(a.window);
    // Let the first-open writes flush and clear their own (self-stamped)
    // sentinel, so the only one left on disk is the one we write.
    await a.window.waitForTimeout(1500);
    const sentinelPath = path.join(vault, '.filo', `.dirty.${machineIdOf(a.userDataDir)}`);

    // The exact shape the dirty-flag tracker persists for an in-flight write:
    // a vault-relative pending path. No `launchId` → the next launch treats it
    // as a prior (crashed) session rather than its own in-flight write.
    fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
    fs.writeFileSync(
      sentinelPath,
      JSON.stringify({ dirtyAt: Date.now(), pendingPaths: ['Notes.md'] }),
      'utf8',
    );

    // Abnormal termination — SIGKILL is uncatchable on POSIX and force-kills on
    // Windows, so the renderer can never run `app:flush-and-quit` / `markClean`.
    a.app.process().kill('SIGKILL');
    expect(fs.existsSync(sentinelPath), 'crash breadcrumb must survive the kill').toBe(true);
    // Give the OS a beat to release the file handles from the killed process.
    await new Promise((resolve) => setTimeout(resolve, 750));

    // ── Phase B — relaunch, reopen the same vault, and assert recovery. ──
    const b = await launchApp(vault, a.userDataDir);
    try {
      await clickOpenVault(b.window);

      const item = b.window.locator('.recovery-item', { hasText: 'Notes.md' });
      await expect(item).toBeVisible({ timeout: 15_000 });
      await expect(b.window.getByText('Changes that may not have been saved')).toBeVisible();

      // Dismiss acknowledges recovery → clears the on-disk sentinel.
      await b.window.locator('.recovery-dismiss').click();
      await expect(item).toBeHidden({ timeout: 10_000 });
      await expect
        .poll(() => fs.existsSync(sentinelPath), {
          timeout: 10_000,
          message: 'Dismiss must clear this machine\'s `.filo/.dirty.<machineId>` sentinel',
        })
        .toBe(false);
    } finally {
      await b.app.close();
    }
  });
});

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { freshVault, killApp, launchBuilt, machineIdOf, makeTemp, quitLikeUser, removeTemp, sleep } from './helpers/app';

/**
 * The crash sentinel end to end: a process killed with a write still pending
 * leaves `.filo/.dirty.<machineId>`, and the next launch on the same machine
 * lists the file in the Recovery modal; dismissing it clears the sentinel.
 *
 * The "kill mid-write" is reproduced by its on-disk result: the sentinel a
 * pending write leaves (with no launch id, so the next launch reads it as a
 * crashed session's), then a kill no quit handler can catch.
 */

let root: string;

test.beforeAll(() => {
  root = makeTemp('recovery');
});

test.afterAll(() => removeTemp(root));

test('a vault closed cleanly opens without the Recovery modal', async () => {
  const vault = freshVault(root, 'Clean', { 'Notes.md': '---\ntitle: Notes\n---\nclean body\n' });
  const launched = await launchBuilt(vault);
  try {
    // Past the recovery sequencer, which runs after the open.
    await launched.win.waitForTimeout(1500);
    await expect(launched.win.locator('.recovery-item')).toHaveCount(0);
  } finally {
    await quitLikeUser(launched);
  }
});

test('a kill with a write pending → the relaunch lists the file, and Dismiss clears the sentinel', async () => {
  const vault = freshVault(root, 'Crash', { 'Notes.md': '---\ntitle: Notes\n---\noriginal body\n' });
  const a = await launchBuilt(vault);
  // The first open's own writes settle and clear their own sentinel.
  await a.win.waitForTimeout(1500);
  const sentinel = path.join(vault, '.filo', `.dirty.${machineIdOf(a.userDataDir)}`);
  fs.writeFileSync(sentinel, JSON.stringify({ dirtyAt: Date.now(), pendingPaths: ['Notes.md'] }), 'utf8');
  killApp(a.app);
  expect(fs.existsSync(sentinel), 'the sentinel survives the kill').toBe(true);
  await sleep(750); // the killed process lets go of its file handles

  const b = await launchBuilt(vault, { sameMachineAs: a.userDataDir });
  try {
    const item = b.win.locator('.recovery-item', { hasText: 'Notes.md' });
    await expect(item).toBeVisible({ timeout: 15_000 });
    await expect(b.win.getByText('Changes that may not have been saved')).toBeVisible();
    await b.win.locator('.recovery-dismiss').click();
    await expect(item).toBeHidden({ timeout: 10_000 });
    await expect.poll(() => fs.existsSync(sentinel), { timeout: 10_000 }).toBe(false);
  } finally {
    await quitLikeUser(b);
  }
});

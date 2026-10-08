import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, launchBuilt, listFiles, makeTemp, newBoard, quitLikeUser, removeTemp } from './helpers/app';

/**
 * Before day one: Settings names the build that is running, so builds can be
 * told apart; and a folder Filo has never opened (no `.filo/`) becomes a
 * vault whose boards each keep their notes in a folder of their own, so
 * nothing a board makes lands beside the user's own notes.
 */

const VERSION = (JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as { version: string }).version;

let root: string;

test.beforeAll(() => {
  root = makeTemp('setup');
});

test.afterAll(() => removeTemp(root));

test("a folder Filo never opened: Settings names this build, and the first board's cards go in its own folder", async () => {
  // Not `freshVault`: that makes `.filo/`, which reads as a vault opened before.
  const vault = path.join(root, 'Book');
  fs.mkdirSync(vault, { recursive: true });
  fs.writeFileSync(path.join(vault, 'Chapter 1.md'), 'It begins.\n');

  const launched = await launchBuilt(vault);
  const { win } = launched;
  try {
    await win.keyboard.press('Control+,');
    // The version, then the commit the build was made from (`+`: with
    // uncommitted changes). Built from a git checkout, so never "dev".
    const shape = new RegExp(`^Filo ${VERSION.replace(/\./g, '\\.')} \\([0-9a-f]{7,}\\+?\\)$`);
    await expect(win.locator('.settings-version')).toHaveText(shape, { timeout: 5_000 });
    await expect(win.locator('.settings-version')).toHaveAttribute('title', /^Built from commit [0-9a-f]{7,}/);
    await win.keyboard.press('Escape');
    await expect(win.locator('.settings-version')).toHaveCount(0);

    await newBoard(win, 'Kanban');
    await expect(win.locator('.kanban-board').first()).toBeVisible({ timeout: 20_000 });
    if ((await win.locator('.add-tile-btn').count()) === 0) {
      await win.locator('.add-column-btn').first().click();
      await win.keyboard.press('Escape');
    }
    await win.locator('.add-tile-btn').first().click();
    await win.locator('.kn-option').first().click();
    await expect(win.locator('.kanban-card-shell')).toHaveCount(1);
    await win.waitForTimeout(800);
    await win.keyboard.press('Escape');
  } finally {
    expect((await quitLikeUser(launched)).outcome).toBe('exited');
  }

  const files = listFiles(vault, (p) => !p.startsWith('.filo/'));
  expect(files.filter((p) => !p.includes('/')), 'the top of the vault').toEqual(['Chapter 1.md']);
  const board = files.find((p) => p.endsWith('.board.json'));
  expect(board).toMatch(/^Kanban 1\/Kanban 1\.board\.json$/);
  const card = files.filter((p) => p.endsWith('.md') && p !== 'Chapter 1.md');
  expect(card).toHaveLength(1);
  expect(card[0].startsWith('Kanban 1/')).toBe(true);
  expect((JSON.parse(fs.readFileSync(path.join(vault, '.filo', 'app.json'), 'utf8')) as { boardFolders?: unknown }).boardFolders).toBe(true);
});

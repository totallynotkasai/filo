import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
  freshVault,
  launchBuilt,
  listFiles,
  makeTemp,
  newBoard,
  openBoardByName,
  quitLikeUser,
  removeTemp,
  sidebarRow,
} from './helpers/app';

/**
 * A day's first use, across launches: make one board of each type and put
 * notes on them, quit, relaunch and find them all; rename a note from the
 * sidebar, quit, and find every board pointing at the new name.
 */

let root: string;
let vault: string;

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  root = makeTemp('daily');
  vault = freshVault(root, 'DailyVault');
});

test.afterAll(() => removeTemp(root));

interface BoardFile {
  board: { type: string; name: string };
  tileDefs: Record<string, { filePath?: string }>;
}

function boards(): Map<string, BoardFile> {
  const m = new Map<string, BoardFile>();
  for (const rel of listFiles(vault, (p) => p.endsWith('.board.json'))) {
    const data = JSON.parse(fs.readFileSync(path.join(vault, rel), 'utf8')) as BoardFile;
    m.set(data.board.type, data);
  }
  return m;
}

const notePaths = (b: BoardFile | undefined): string[] =>
  Object.values(b?.tileDefs ?? {}).flatMap((d) => (d.filePath ? [d.filePath] : []));

async function addKanbanCard(win: Page): Promise<void> {
  await win.locator('.add-tile-btn').first().click();
  await win.locator('.kn-option').first().click();
  await win.waitForTimeout(800);
  await win.keyboard.press('Escape');
}

async function addMindMapTextTile(win: Page): Promise<void> {
  await win.locator('button.side-btn[title^="New Tile"]').click();
  await win.locator('.side-dropdown .dropdown-item', { hasText: 'Text' }).first().click();
  await win.waitForTimeout(800);
  await win.keyboard.press('Escape');
}

test('make a board of each type with two notes on it, and quit', async () => {
  const launched = await launchBuilt(vault);
  const { win } = launched;
  try {
    await newBoard(win, 'Kanban');
    await expect(win.locator('.kanban-board').first()).toBeVisible({ timeout: 20_000 });
    if ((await win.locator('.add-tile-btn').count()) === 0) {
      await win.locator('.add-column-btn').first().click();
      await win.keyboard.press('Escape');
    }
    await addKanbanCard(win);
    await addKanbanCard(win);
    await expect(win.locator('.kanban-card-shell')).toHaveCount(2);

    await newBoard(win, 'Task List');
    await expect(win.locator('.tasklist-board').first()).toBeVisible({ timeout: 20_000 });
    const quickAdd = win.locator('.quick-add-input').first();
    for (const task of ['Buy milk', 'Call the plumber']) {
      await quickAdd.fill(task);
      await quickAdd.press('Enter');
      await win.waitForTimeout(500);
    }
    await expect(win.locator('.task-item-wrap')).toHaveCount(2);

    await newBoard(win, 'Mind Map');
    await expect(win.locator('.mindmap-board').first()).toBeVisible({ timeout: 20_000 });
    await addMindMapTextTile(win);
    await addMindMapTextTile(win);
    await expect(win.locator('.tile-container')).toHaveCount(2);
  } finally {
    expect((await quitLikeUser(launched)).outcome).toBe('exited');
  }
  const b = boards();
  for (const type of ['kanban', 'tasklist', 'mindmap']) {
    const paths = notePaths(b.get(type));
    expect(paths, `${type} board notes`).toHaveLength(2);
    for (const p of paths) expect(fs.existsSync(path.join(vault, p)), `${p} on disk`).toBe(true);
  }
  const taskTexts = notePaths(b.get('tasklist')).map((p) => fs.readFileSync(path.join(vault, p), 'utf8'));
  expect(taskTexts.join('\n')).toContain('Buy milk');
});

test('after a relaunch every board shows its notes', async () => {
  const launched = await launchBuilt(vault);
  const { win } = launched;
  try {
    const b = boards();
    for (const [type, selector] of [
      ['kanban', '.kanban-card-shell'],
      ['tasklist', '.task-item-wrap'],
      ['mindmap', '.tile-container'],
    ] as const) {
      await openBoardByName(win, b.get(type)!.board.name);
      await expect(win.locator(selector)).toHaveCount(2, { timeout: 20_000 });
      if (type === 'tasklist') await expect(win.locator('.task-item-wrap', { hasText: 'Buy milk' })).toHaveCount(1);
    }
  } finally {
    expect((await quitLikeUser(launched)).outcome).toBe('exited');
  }
});

test('renaming a note in the sidebar re-points the board that shows it', async () => {
  const oldRel = notePaths(boards().get('tasklist')).find((p) => fs.readFileSync(path.join(vault, p), 'utf8').includes('Buy milk'));
  expect(oldRel).toBeDefined();
  const dir = path.posix.dirname(oldRel!);
  const newRel = `${dir === '.' ? '' : `${dir}/`}Groceries.md`;

  const launched = await launchBuilt(vault);
  const { win } = launched;
  try {
    // Open each folder above the note.
    const parts = oldRel!.split('/').slice(0, -1);
    for (let i = 0; i < parts.length; i++) {
      const folder = sidebarRow(win, parts[i]);
      if ((await folder.getAttribute('aria-expanded')) !== 'true') await folder.locator('.file-name').click();
    }
    const name = path.posix.basename(oldRel!);
    await win.locator(`button[aria-label="Rename ${name}"]`).evaluate((b: HTMLElement) => b.click());
    await expect(win.locator('.rename-input')).toBeFocused();
    await win.keyboard.press('Control+A');
    await win.keyboard.type('Groceries');
    await win.keyboard.press('Enter');
    await expect.poll(() => fs.existsSync(path.join(vault, newRel)), { timeout: 10_000 }).toBe(true);
  } finally {
    expect((await quitLikeUser(launched)).outcome).toBe('exited');
  }
  expect(fs.existsSync(path.join(vault, oldRel!))).toBe(false);
  const paths = notePaths(boards().get('tasklist'));
  expect(paths).toContain(newRel);
  expect(paths).not.toContain(oldRel);
});

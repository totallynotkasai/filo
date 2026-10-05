import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { freshVault, launchBuilt, listFiles, makeTemp, newBoard, quitLikeUser, removeTemp, sidebarRow } from './helpers/app';

/**
 * Making and finding notes in the built app, with no board involved: a
 * folder, a folder inside it and a note in that, all from the vault sidebar.
 * And a card titled "The Siege" is "The Siege.md" (not "New Card.md"), which
 * the sidebar's search finds; a note found by its title shows it.
 */

let root: string;

test.beforeAll(() => {
  root = makeTemp('making-notes');
});

test.afterAll(() => removeTemp(root));

const read = (vault: string, rel: string): string => fs.readFileSync(path.join(vault, rel), 'utf8');

async function menuItem(win: Page, label: string): Promise<void> {
  await win.locator('.context-menu [role="menuitem"], .context-menu .menu-item', { hasText: label }).first().click();
}

/** Types `name` into the sidebar's rename box (a new folder's name) and presses Enter. */
async function nameNewFolder(win: Page, name: string): Promise<void> {
  const input = win.locator('.vault-file-item .rename-input');
  await expect(input).toBeFocused({ timeout: 10_000 });
  await win.keyboard.press('Control+A');
  await win.keyboard.type(name);
  await win.keyboard.press('Enter');
  await expect(sidebarRow(win, name)).toBeVisible({ timeout: 10_000 });
}

test('a folder, a folder inside it and a note in that, from the sidebar, with no board', async () => {
  const vault = freshVault(root, 'Book vault', { 'Manuscript.md': '# Draft\n' });
  const launched = await launchBuilt(vault);
  const { win } = launched;
  try {
    await expect(sidebarRow(win, 'Manuscript.md')).toBeVisible({ timeout: 20_000 });
    // The sidebar header's New: a folder at the top.
    await win.locator('.sidebar-actions button[aria-label="New note or folder"]').click();
    await menuItem(win, 'New folder');
    await nameNewFolder(win, 'Book');
    // The empty space below the files offers the same.
    const tree = win.locator('.vault-sidebar .file-tree');
    const box = await tree.boundingBox();
    await tree.click({ button: 'right', position: { x: 60, y: (box?.height ?? 40) - 8 } });
    await expect(win.locator('.context-menu [role="menuitem"]')).toHaveText(['New note', 'New folder']);
    await win.keyboard.press('Escape');
    // A folder's own menu: a folder inside it, then a note in that.
    await sidebarRow(win, 'Book').click({ button: 'right' });
    await menuItem(win, 'New folder');
    await nameNewFolder(win, 'Part 1');
    await sidebarRow(win, 'Part 1').click({ button: 'right' });
    await menuItem(win, 'New note');

    // The new note opens with its title (the tab's name) ready to type; Enter
    // hands the caret to its text.
    const tabName = win.locator('.tab input');
    await expect(tabName).toBeFocused({ timeout: 10_000 });
    await win.keyboard.type('Chapter 4');
    await win.keyboard.press('Enter');
    await expect(win.locator('.tab[aria-selected="true"] .tab-name').first()).toHaveText('Chapter 4', { timeout: 10_000 });
    await expect(win.locator('.document-board .ProseMirror').first()).toBeFocused({ timeout: 10_000 });
    await win.keyboard.type('It began at dusk.');
    await expect(sidebarRow(win, 'Chapter 4.md')).toBeVisible({ timeout: 10_000 });
  } finally {
    expect((await quitLikeUser(launched)).outcome).toBe('exited');
  }
  expect(listFiles(vault, (p) => !p.startsWith('.filo/')).sort()).toEqual(['Book/Part 1/Chapter 4.md', 'Manuscript.md']);
  const note = read(vault, 'Book/Part 1/Chapter 4.md');
  expect(note).toMatch(/^title: Chapter 4$/m);
  expect(note).toContain('It began at dusk.');
  expect(launched.errors).toEqual([]);
});

test('a card titled "The Siege" is "The Siege.md", and the sidebar search finds notes by title', async () => {
  const vault = freshVault(root, 'Cards vault', {
    'Drafts/ch-07.md': '---\ntitle: The Fall of the City\n---\nThe gates broke.\n',
  });
  const launched = await launchBuilt(vault);
  const { win } = launched;
  try {
    await newBoard(win, 'Kanban');
    await expect(win.locator('.kanban-board').first()).toBeVisible({ timeout: 20_000 });
    if ((await win.locator('.add-tile-btn').count()) === 0) {
      await win.locator('.add-column-btn').first().click();
      await win.keyboard.press('Escape');
    }
    await win.locator('.add-tile-btn').first().click();
    await win.locator('.kn-option').first().click();
    await expect(win.locator('.tile-title-editor .ProseMirror')).toBeFocused({ timeout: 10_000 });
    await win.keyboard.type('The Siege');
    await win.keyboard.press('Enter');
    await expect(sidebarRow(win, 'The Siege.md')).toBeVisible({ timeout: 10_000 });

    const search = win.locator('.search-bar input.search-input');
    await search.fill('siege');
    await expect(sidebarRow(win, 'The Siege.md')).toBeVisible();
    await search.fill('fall of');
    const found = sidebarRow(win, 'ch-07.md');
    await expect(found).toBeVisible({ timeout: 10_000 });
    await expect(found.locator('.file-title-match')).toHaveText('The Fall of the City');
  } finally {
    expect((await quitLikeUser(launched)).outcome).toBe('exited');
  }
  const notes = listFiles(vault, (p) => p.endsWith('.md') && !p.startsWith('.filo/'));
  expect(notes.sort()).toEqual(['Drafts/ch-07.md', 'The Siege.md']);
  expect(read(vault, 'The Siege.md')).toMatch(/^title: The Siege$/m);
  expect(launched.errors).toEqual([]);
});

test("the Mind Map's keys act on the canvas, not from a sidebar row; new tiles land clear of each other", async () => {
  const vault = freshVault(root, 'Keys vault', { 'Chapter 1.md': 'One\n' });
  const launched = await launchBuilt(vault);
  const { win } = launched;
  try {
    await newBoard(win, 'Mind Map');
    const canvas = win.locator('.mindmap-board').first();
    await expect(canvas).toBeVisible({ timeout: 20_000 });
    await win.locator('button.side-btn[title^="New Tile"]').click();
    await win.locator('.side-dropdown .dropdown-item', { hasText: 'Text' }).first().click();
    await expect(win.locator('.tile-title-editor .ProseMirror')).toBeFocused({ timeout: 10_000 });
    await win.keyboard.type('Hero');
    await win.keyboard.press('Enter');
    const tiles = win.locator('.mindmap-board .tile-container');
    await expect(tiles).toHaveCount(1);

    // A sidebar row has focus: N, Delete, Backspace and the arrows are its.
    await sidebarRow(win, 'Chapter 1.md').locator('.file-name').click();
    for (const key of ['n', 'Delete', 'Backspace', 'ArrowDown', 'c']) await win.keyboard.press(key);
    await expect(tiles).toHaveCount(1);
    await expect(win.locator('.confirm-dialog')).toHaveCount(0);

    // A click on the empty canvas gives it the keys.
    const box = await canvas.boundingBox();
    await canvas.click({ position: { x: 20, y: (box?.height ?? 400) - 20 } });
    await expect(canvas).toBeFocused();
    await win.keyboard.press('n');
    await expect(win.locator('.tile-title-editor .ProseMirror')).toBeFocused({ timeout: 10_000 });
    await win.keyboard.type('Villain');
    await win.keyboard.press('Enter');
    await expect(tiles).toHaveCount(2);
    const [a, b] = await Promise.all([tiles.nth(0).boundingBox(), tiles.nth(1).boundingBox()]);
    expect(a && b && (a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y)).toBe(true);
  } finally {
    expect((await quitLikeUser(launched)).outcome).toBe('exited');
  }
  expect(launched.errors).toEqual([]);
});

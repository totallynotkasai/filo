import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { freshVault, launchBuilt, listFiles, makeTemp, newBoard, quitLikeUser, removeTemp } from './helpers/app';

/**
 * Typing straight after making a card or a tile names it. Focus used to stay
 * on Kanban's Add Card button (the space bar pressed it again) or fall to the
 * page, where the Mind Map's N made a new tile, with an empty note, for every
 * N in the name being typed.
 */

let root: string;

test.beforeAll(() => {
  root = makeTemp('new-cards');
});

test.afterAll(() => removeTemp(root));

const notesIn = (vault: string): string[] => listFiles(vault, (p) => p.endsWith('.md') && !p.startsWith('.filo/'));
const read = (vault: string, rel: string): string => fs.readFileSync(path.join(vault, rel), 'utf8');

test('a new Kanban card takes its title from the keyboard at once', async () => {
  const vault = freshVault(root, 'Cards');
  const launched = await launchBuilt(vault);
  const { win } = launched;
  try {
    await newBoard(win, 'Kanban');
    await expect(win.locator('.kanban-board').first()).toBeVisible({ timeout: 20_000 });
    if ((await win.locator('.add-tile-btn').count()) === 0) {
      await win.locator('.add-column-btn').first().click();
      await win.keyboard.press('Escape');
    }
    for (const title of ['Outline chapter 3', 'Name the river city']) {
      await win.locator('.add-tile-btn').first().click();
      await win.locator('.kn-option').first().click();
      await expect(win.locator('.tile-title-editor .ProseMirror')).toBeFocused({ timeout: 10_000 });
      await win.keyboard.type(title);
      await win.keyboard.press('Enter');
      await expect(win.locator('.kanban-card-shell .tile-title', { hasText: title })).toHaveCount(1);
    }
    // No extra cards, and no picker left open by a typed N.
    await expect(win.locator('.kanban-card-shell')).toHaveCount(2);
    await expect(win.locator('.kn-option')).toHaveCount(0);
  } finally {
    expect((await quitLikeUser(launched)).outcome).toBe('exited');
  }
  const notes = notesIn(vault);
  expect(notes).toHaveLength(2);
  const titles = notes.map((rel) => /title: (.*)/.exec(read(vault, rel))?.[1]).sort();
  expect(titles).toEqual(['Name the river city', 'Outline chapter 3']);
  expect(launched.errors).toEqual([]);
});

test('typing "Antagonist" into a new Mind Map tile makes no extra tiles', async () => {
  const vault = freshVault(root, 'Tiles');
  const launched = await launchBuilt(vault);
  const { win } = launched;
  try {
    await newBoard(win, 'Mind Map');
    await expect(win.locator('.mindmap-board').first()).toBeVisible({ timeout: 20_000 });
    for (const title of ['Magic system', 'Antagonist']) {
      await win.locator('button.side-btn[title^="New Tile"]').click();
      await win.locator('.side-dropdown .dropdown-item', { hasText: 'Text' }).first().click();
      await expect(win.locator('.tile-title-editor .ProseMirror')).toBeFocused({ timeout: 10_000 });
      await win.keyboard.type(title);
      await win.keyboard.press('Escape');
      await expect(win.locator('.mindmap-board .tile-title', { hasText: title })).toHaveCount(1);
    }
    await expect(win.locator('.mindmap-board .tile-container')).toHaveCount(2);
    // An empty tile says where its text goes.
    await expect(win.locator('.mindmap-board .tiptap p.is-editor-empty[data-placeholder="Start typing..."]')).toHaveCount(2);
  } finally {
    expect((await quitLikeUser(launched)).outcome).toBe('exited');
  }
  const notes = notesIn(vault);
  expect(notes).toHaveLength(2);
  const titles = notes.map((rel) => /title: (.*)/.exec(read(vault, rel))?.[1]).sort();
  expect(titles).toEqual(['Antagonist', 'Magic system']);
  expect(launched.errors).toEqual([]);
});

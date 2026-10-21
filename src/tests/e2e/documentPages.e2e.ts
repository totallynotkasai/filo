import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { freshVault, launchBuilt, makeTemp, openNoteByName, quitLikeUser, removeTemp } from './helpers/app';

/**
 * A long note in a Document tab is laid out on page cards, and the tab zooms.
 * Both are drawn only: the note's file is left as it was, and the zoom is
 * kept with the vault's layout. Checked as a reader sees it: no line of text
 * in the gap between two cards, at 100% and zoomed in.
 */

const SENTENCES = [
  'Aria rode north along the river road until the light failed.',
  'The ferryman asked for two coins and took three.',
  'Nobody in Vel remembered the winter the bridge came down, but everyone told the story as if they had stood on the bank and watched the ice take it, plank by plank.',
  'She kept the letter folded inside her glove.',
];
const NOTE = `---\ntitle: River Road\n---\n${Array.from({ length: 60 }, (_, i) =>
  Array.from({ length: 1 + (i % 4) }, (_, j) => SENTENCES[(i + j) % SENTENCES.length]).join(' ')).join('\n\n')}\n`;

let root: string;

test.beforeAll(() => {
  root = makeTemp('pages');
});

test.afterAll(() => removeTemp(root));

/** A file's text, or '' until it is written. */
function readIfThere(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

/** The page cards, and every line of the note's text that lies outside all of them. */
async function linesOutsidePages(win: Page): Promise<{ pages: number; outside: string[] }> {
  return win.evaluate(() => {
    const cards = [...document.querySelectorAll('.document-board .document-page')].map((c) => c.getBoundingClientRect());
    const outside: string[] = [];
    for (const block of document.querySelectorAll('.document-board .ProseMirror > p')) {
      const range = document.createRange();
      range.selectNodeContents(block);
      for (const line of range.getClientRects()) {
        const inside = cards.some((c) => line.top >= c.top - 1 && line.bottom <= c.bottom + 1);
        if (!inside) outside.push(`${(block.textContent ?? '').slice(0, 30)}… at ${Math.round(line.top)}`);
      }
    }
    return { pages: cards.length, outside };
  });
}

test('a long note sits on page cards, zoomed in or not, and its file is left as it was', async ({}, testInfo) => {
  const vault = freshVault(root, 'Book', { 'River Road.md': NOTE });
  const launched = await launchBuilt(vault);
  const { win } = launched;
  try {
    const editor = await openNoteByName(win, 'River Road');
    await expect.poll(async () => (await linesOutsidePages(win)).pages, { timeout: 10_000 }).toBeGreaterThan(2);
    await expect.poll(() => linesOutsidePages(win).then((r) => r.outside)).toEqual([]);
    await testInfo.attach('pages', { body: await win.screenshot(), contentType: 'image/png' });

    // The keys zoom, with the caret in the note.
    await editor.click();
    await win.keyboard.press('Control+=');
    await win.keyboard.press('Control+=');
    await expect(win.locator('.document-board .zoom-level')).toHaveText('125%');
    await expect.poll(() => linesOutsidePages(win).then((r) => r.outside)).toEqual([]);
    await testInfo.attach('zoomed', { body: await win.screenshot(), contentType: 'image/png' });
    await expect.poll(() => readIfThere(path.join(vault, '.filo', 'workspace.json'))).toMatch(/"documentZoom": 1.25/);

    // So does Ctrl+wheel over the page.
    const box = (await win.locator('.document-board').boundingBox())!;
    await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await win.keyboard.down('Control');
    await win.mouse.wheel(0, 120);
    await win.keyboard.up('Control');
    await expect(win.locator('.document-board .zoom-level')).toHaveText('110%');

    await win.keyboard.press('Control+0');
    await expect(win.locator('.document-board .zoom-level')).toHaveText('100%');
  } finally {
    expect((await quitLikeUser(launched)).outcome).toBe('exited');
  }
  expect(fs.readFileSync(path.join(vault, 'River Road.md'), 'utf8')).toBe(NOTE);
});

test('a Document tab switched away from and back comes back where it was scrolled to', async () => {
  const vault = freshVault(root, 'Switch', { 'River Road.md': NOTE, 'Ferry.md': '---\ntitle: Ferry\n---\nTwo coins.\n' });
  const launched = await launchBuilt(vault);
  const { win } = launched;
  const scrollTop = (): Promise<number> => win.evaluate(() => document.querySelector('.document-board')?.scrollTop ?? -1);
  try {
    await openNoteByName(win, 'River Road');
    await expect.poll(async () => (await linesOutsidePages(win)).pages, { timeout: 10_000 }).toBeGreaterThan(2);
    const box = (await win.locator('.document-board').boundingBox())!;
    await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await win.mouse.wheel(0, 2400);
    await expect.poll(scrollTop).toBeGreaterThan(1500);
    const left = await scrollTop();

    await openNoteByName(win, 'Ferry');
    await expect(win.locator('.document-board .ProseMirror')).toContainText('Two coins.');
    await win.getByRole('tab', { name: /River Road/ }).click();
    await expect(win.locator('.document-board .ProseMirror')).toContainText('Aria rode north');
    await expect.poll(async () => Math.abs((await scrollTop()) - left)).toBeLessThan(2);
    // Still there once the pages have been laid out again.
    await win.waitForTimeout(2_000);
    expect(Math.abs((await scrollTop()) - left)).toBeLessThan(2);
  } finally {
    expect((await quitLikeUser(launched)).outcome).toBe('exited');
  }
});

test('with Global Defaults → Document set to one continuous sheet, the note has no page cards', async () => {
  const defaults = JSON.stringify({ mindmap: {}, kanban: {}, tasklist: {}, document: { pageLayout: 'continuous' } }, null, 2);
  const vault = freshVault(root, 'Sheet', { 'River Road.md': NOTE, '.filo/defaults.json': defaults });
  const launched = await launchBuilt(vault);
  const { win } = launched;
  try {
    await openNoteByName(win, 'River Road');
    // Long enough to have broken into pages by now, had pages been on.
    await win.waitForTimeout(1_000);
    await expect(win.locator('.document-board .document-page')).toHaveCount(0);
    await expect(win.locator('.document-board .filo-page-break')).toHaveCount(0);
    await expect(win.locator('.document-board .document-paper')).not.toHaveClass(/paged/);
  } finally {
    expect((await quitLikeUser(launched)).outcome).toBe('exited');
  }
  expect(fs.readFileSync(path.join(vault, 'River Road.md'), 'utf8')).toBe(NOTE);
});

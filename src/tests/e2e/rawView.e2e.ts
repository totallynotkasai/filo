import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { freshVault, launchBuilt, makeTemp, openNoteByName, quitLikeUser, removeTemp } from './helpers/app';

/**
 * The Raw view in the built app. Its editor (CodeMirror) is fetched only
 * when a Raw view first opens. "Edit in Raw view" on a note that opens
 * read-only lands on the line a save would change; text typed there reaches
 * the disk when the field is left, and when the app quits with the text still
 * in the field.
 */

const paragraphs = (from: number, count: number): string =>
  Array.from({ length: count }, (_, i) => `Paragraph ${from + i}.\n`).join('\n');
// Filo would drop the HTML comment on save, so the note opens read-only and
// names this line. Text on both sides, so the box has to scroll to it.
const LOSSY_LINE = 'A paragraph with a <!-- a comment --> comment.';
const FIXED_LINE = 'A paragraph with a comment.';
const WRAPPED = `---\ntitle: Wrapped\n---\n${paragraphs(1, 80)}\n${LOSSY_LINE}\n\n${paragraphs(81, 80)}`;
const PLAIN = '---\ntitle: Plain\n---\nBody\n';

/** Whether the page has fetched the CodeMirror chunk. */
const codemirrorFetched = (win: Page): Promise<boolean> =>
  win.evaluate(
    () =>
      performance.getEntriesByType('resource').some((r) => r.name.includes('codemirror')) ||
      [...document.querySelectorAll('link[rel="modulepreload"]')].some((l) => (l.getAttribute('href') ?? '').includes('codemirror')),
  );

const read = (vault: string, rel: string): string => fs.readFileSync(path.join(vault, rel), 'utf8');

let root: string;

test.beforeAll(() => {
  root = makeTemp('raw-view');
});

test.afterAll(() => removeTemp(root));

test('Edit in Raw view lands on the named line, and typed text reaches the disk', async () => {
  const vault = freshVault(root, 'Raw Vault', { 'Wrapped.md': WRAPPED, 'Plain.md': PLAIN });
  const launched = await launchBuilt(vault);
  const { win } = launched;
  const field = win.locator('.document-board:visible .raw-text[aria-busy="false"] .cm-content');
  let quit: Awaited<ReturnType<typeof quitLikeUser>> | null = null;
  try {
    await test.step('the read-only note names its line; the Raw view editor is not fetched yet', async () => {
      await openNoteByName(win, 'Wrapped');
      await expect(win.locator('.readonly-banner .readonly-text')).toContainText('would change');
      expect(await codemirrorFetched(win)).toBe(false);
    });

    await test.step('Edit in Raw view: the line is selected, marked, and in view inside the box', async () => {
      await win.locator('.readonly-banner .readonly-action', { hasText: 'Edit in Raw view' }).click();
      await expect(field).toBeFocused({ timeout: 10_000 });
      expect(await codemirrorFetched(win)).toBe(true);
      await expect.poll(() => win.evaluate(() => getSelection()?.toString() ?? '')).toBe(LOSSY_LINE);
      const marked = win.locator('.note-raw-view .cm-filo-named-line');
      await expect(marked).toHaveText(LOSSY_LINE);
      await expect(marked).toBeInViewport();
      const line = await marked.boundingBox();
      const box = await win.locator('.note-raw-view .cm-scroller').boundingBox();
      expect(line && box).toBeTruthy();
      expect(line!.y).toBeGreaterThanOrEqual(box!.y);
      expect(line!.y + line!.height).toBeLessThanOrEqual(box!.y + box!.height);
    });

    await test.step('typing over the line and leaving the field writes exactly that change', async () => {
      await win.keyboard.type(FIXED_LINE);
      await expect(win.locator('.note-raw-view .cm-filo-named-line')).toHaveCount(0);
      await win.keyboard.press('Tab');
      await expect(field).not.toBeFocused();
      await expect.poll(() => read(vault, 'Wrapped.md')).toBe(WRAPPED.replace(LOSSY_LINE, FIXED_LINE));
    });

    await test.step('back in the formatted view the note is editable again', async () => {
      await win.locator('.document-board:visible .raw-toggle').click();
      await expect(win.locator('.document-board:visible .readonly-banner')).toHaveCount(0, { timeout: 10_000 });
      await expect(win.locator('.document-board:visible .ProseMirror')).toContainText(FIXED_LINE);
    });

    await test.step('text still in the field when the app quits is saved', async () => {
      await openNoteByName(win, 'Plain');
      await win.locator('.document-board:visible .raw-toggle').click();
      await field.click();
      await win.keyboard.press('Control+End');
      await win.keyboard.type('Typed just before quitting.');
      await expect(field).toBeFocused();
      quit = await quitLikeUser(launched);
    });
  } finally {
    quit ??= await quitLikeUser(launched);
  }
  expect(quit.outcome).toBe('exited');
  expect(read(vault, 'Plain.md')).toBe(`${PLAIN}Typed just before quitting.`);
  expect(launched.errors).toEqual([]);
});

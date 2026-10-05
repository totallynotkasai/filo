import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { freshVault, launchBuilt, makeTemp, openNoteByName, quitLikeUser, removeTemp } from './helpers/app';

/**
 * An image a note embeds shows in the built app, loaded from the vault
 * through the media protocol, and opening the note writes nothing. Its
 * address (`![map](art/map.png)`) is relative to the note; the page resolved
 * it against the app's own address, which the app's security policy loads no
 * media from, so the image never showed.
 */

/** A 1×1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const NOTE = 'The realm:\n\n![map](art/map.png)\n';

let root: string;

test.beforeAll(() => {
  root = makeTemp('images');
});

test.afterAll(() => removeTemp(root));

test('an image embedded in a note loads from the vault, and the note is left as it was', async () => {
  const vault = freshVault(root, 'Book', { 'Chapter.md': NOTE, 'art/map.png': PNG });
  const launched = await launchBuilt(vault);
  const { win } = launched;
  try {
    const editor = await openNoteByName(win, 'Chapter');
    const img = editor.locator('img[alt="map"]');
    await expect(img).toHaveAttribute('src', 'filo://media/art/map.png');
    await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 10_000 }).toBe(1);
    expect(launched.errors.filter((e) => /filo:\/\/media|Content Security Policy/i.test(e))).toEqual([]);
  } finally {
    expect((await quitLikeUser(launched)).outcome).toBe('exited');
  }
  expect(fs.readFileSync(path.join(vault, 'Chapter.md'), 'utf8')).toBe(NOTE);
});

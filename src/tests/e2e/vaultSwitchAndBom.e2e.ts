import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
  freshVault,
  launchBuilt,
  makeTemp,
  openNoteByName,
  quitLikeUser,
  removeTemp,
  setPickedVault,
} from './helpers/app';

/**
 * Two paths that once lost or bent a note:
 *  - opening another vault right after typing saves the edit to the vault it
 *    was made in, and nothing lands in the other vault's note of the same name;
 *  - a Notepad note's BOM survives an edit.
 */

let root: string;

test.beforeAll(() => {
  root = makeTemp('switch');
});

test.afterAll(() => removeTemp(root));

test('opening another vault right after typing saves the edit to its own vault only', async () => {
  const a = freshVault(root, 'Vault A', { 'Notes.md': '---\ntitle: A\n---\nA initial body\n' });
  const bText = '---\ntitle: B\n---\nB initial body\n';
  const b = freshVault(root, 'Vault B', { 'Notes.md': bText });

  const launched = await launchBuilt(a);
  const { win, app } = launched;
  try {
    const editor = await openNoteByName(win, 'Notes', 'A');
    await editor.click();
    await win.keyboard.press('Control+End');
    await win.keyboard.type(' typed in A');
    // Straight to the other vault, inside the editor's serialise and the writer's debounce.
    await setPickedVault(app, b);
    await win.keyboard.press('Control+O');
    await expect(win.locator('button', { hasText: 'Vault B' }).first()).toBeVisible({ timeout: 20_000 });
    const bEditor = await openNoteByName(win, 'Notes', 'B');
    await expect(bEditor).toHaveText('B initial body');
  } finally {
    expect((await quitLikeUser(launched)).outcome).toBe('exited');
  }
  expect(fs.readFileSync(path.join(a, 'Notes.md'), 'utf8')).toBe('---\ntitle: A\n---\nA initial body typed in A\n');
  expect(fs.readFileSync(path.join(b, 'Notes.md'), 'utf8')).toBe(bText);
});

test('a note saved by Notepad with a BOM keeps it after an edit', async () => {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const vault = freshVault(root, 'Bom Vault', {
    'BomNote.md': Buffer.concat([bom, Buffer.from('---\ntitle: BomNote\n---\noriginal body line\n', 'utf8')]),
  });
  const launched = await launchBuilt(vault);
  const { win } = launched;
  try {
    const editor = await openNoteByName(win, 'BomNote');
    await editor.click();
    await win.keyboard.press('Control+End');
    await win.keyboard.type(' edited');
    await win.waitForTimeout(1500);
  } finally {
    expect((await quitLikeUser(launched)).outcome).toBe('exited');
  }
  const after = fs.readFileSync(path.join(vault, 'BomNote.md'));
  expect([...after.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  expect(after.subarray(3).toString('utf8')).toBe('---\ntitle: BomNote\n---\noriginal body line edited\n');
});

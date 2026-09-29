import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
  freshVault,
  launchBuilt,
  listFiles,
  makeTemp,
  newBoard,
  openNoteByName,
  quitLikeUser,
  removeTemp,
  requestClose,
  toasts,
} from './helpers/app';
import type { LaunchedApp } from './helpers/app';

/**
 * What a sync client (Syncthing, the owner's setup) does to a vault while
 * Filo has it open. Syncthing writes `.syncthing.<name>.tmp`, gives it the
 * source file's (older) mtime, and renames it over the file; it keeps old
 * versions in `.stversions/` and names a conflict `<name>.sync-conflict-….md`.
 */

let root: string;
let vault: string;
let launched: LaunchedApp;

const past = new Date(Date.now() - 3_600_000);

/** Delivers `text` to `rel` the way Syncthing does. */
function syncDeliver(rel: string, text: string): void {
  const target = path.join(vault, rel);
  const tmp = path.join(path.dirname(target), `.syncthing.${path.basename(target)}.tmp`);
  fs.writeFileSync(tmp, text);
  fs.utimesSync(tmp, past, past);
  fs.renameSync(tmp, target);
}

const read = (rel: string): string => fs.readFileSync(path.join(vault, rel), 'utf8');
const sidebarNames = (): Promise<string[]> =>
  launched.win.evaluate(() =>
    [...document.querySelectorAll('.file-row')].map((e) => (e.getAttribute('title') ?? '').split(/[\\/]/).pop() ?? ''),
  );

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  root = makeTemp('sync');
  vault = freshVault(root, 'SyncVault', {
    'Open note.md': '---\ntitle: Open note\ntags: [a]\n---\nFirst version\n',
    'Closed note.md': '---\ntitle: Closed note\n---\nClosed v1\n',
  });
  launched = await launchBuilt(vault);
});

test.afterAll(async () => {
  if (launched) await quitLikeUser(launched, 10_000).catch(() => undefined);
  removeTemp(root);
});

test('a delivery with an older mtime replaces an open, unedited note on screen and is never written back', async () => {
  const editor = await openNoteByName(launched.win, 'Open note');
  await expect(editor).toHaveText('First version');
  const second = '---\ntitle: Open note\ntags: [a, synced]\n---\nSecond version from the other side\n';
  syncDeliver('Open note.md', second);
  await expect(editor).toHaveText('Second version from the other side', { timeout: 10_000 });
  await launched.win.waitForTimeout(1500);
  expect(read('Open note.md')).toBe(second);
});

test('a delivery landing while the note is being typed in asks Reload or Keep mine', async () => {
  const editor = launched.win.locator('.document-board .ProseMirror:visible').first();
  await editor.click();
  await launched.win.keyboard.press('Control+End');
  await launched.win.keyboard.type(' LOCAL-TYPING');
  const third = '---\ntitle: Open note\ntags: [a, synced]\n---\nThird version from the other side\n';
  syncDeliver('Open note.md', third);
  await expect.poll(() => toasts(launched.win), { timeout: 15_000 }).toContainEqual(expect.stringContaining('changed by another program while you were editing it'));
  // Neither version is lost while the question is open: the other one is on disk.
  expect(read('Open note.md')).toBe(third);
  await expect(editor).toContainText('LOCAL-TYPING');
});

test('quit waits for the decision, then keeps the typed text once it is answered', async () => {
  await requestClose(launched.app);
  const dialog = launched.win.locator('.confirm-dialog');
  await expect(dialog).toContainText('Waiting for your decision', { timeout: 20_000 });
  await dialog.locator('button', { hasText: 'Stay open' }).click();
  await expect(dialog).toHaveCount(0);

  const toast = launched.win.locator('.toast', { hasText: 'changed by another program while you were editing it' }).first();
  await toast.locator('button', { hasText: 'Keep mine' }).evaluate((b: HTMLElement) => b.click());
  await expect.poll(() => read('Open note.md'), { timeout: 15_000 }).toContain('LOCAL-TYPING');
  // "Keep mine" backs up the other version before writing over it.
  const kept = listFiles(path.join(vault, '.filo'), (p) => p.startsWith('recovery/'))
    .map((p) => fs.readFileSync(path.join(vault, '.filo', p), 'utf8'));
  expect(kept.some((t) => t.includes('Third version from the other side'))).toBe(true);
});

test('a conflict copy shows in the sidebar; `.stversions` and sync temp files do not, and search skips them', async () => {
  fs.writeFileSync(path.join(vault, 'Closed note.sync-conflict-20260929-101010-ABCDEFG.md'), '---\ntitle: Closed note\n---\nClosed CONFLICT\n');
  fs.mkdirSync(path.join(vault, '.stversions'), { recursive: true });
  fs.writeFileSync(path.join(vault, '.stversions', 'Closed note~20260929-090000.md'), '---\ntitle: Closed note\n---\nOld version zzqq\n');
  fs.writeFileSync(path.join(vault, '.syncthing.Stray.md.tmp'), 'partial');

  await expect.poll(sidebarNames, { timeout: 15_000 }).toContain('Closed note.sync-conflict-20260929-101010-ABCDEFG.md');
  const names = await sidebarNames();
  expect(names.filter((n) => n.includes('~20260929') || n.includes('.syncthing.') || n === '.stversions')).toEqual([]);

  await launched.win.keyboard.press('Control+Shift+F');
  const input = launched.win.locator('#search-find-input');
  // The conflict copy is searchable (so the search ran over the new files)…
  await input.fill('Closed CONFLICT');
  await expect(launched.win.locator('.search-panel .result-count')).toHaveText(/\d+ \/ \d+/, { timeout: 10_000 });
  // …and the old version kept in `.stversions` is not.
  await input.fill('zzqq');
  await expect(launched.win.locator('.search-panel .result-count')).toHaveText('No results', { timeout: 10_000 });
  await launched.win.keyboard.press('Escape');
});

test('an open board replaced by a delivery (no local changes) shows the delivered version', async () => {
  await newBoard(launched.win, 'Kanban');
  await expect(launched.win.locator('.kanban-board').first()).toBeVisible({ timeout: 20_000 });
  await launched.win.waitForTimeout(2000);
  const rel = listFiles(vault, (p) => p.endsWith('.board.json'))[0];
  const board = JSON.parse(read(rel)) as { board: { columns: unknown[] } };
  board.board.columns = [{ id: 'colsyncxxxx', title: 'From other side', position: 0, collapsed: false, tilePlacements: [] }];
  const delivered = JSON.stringify(board, null, 2);
  syncDeliver(rel, delivered);
  await expect(launched.win.locator('.kanban-board .column-title').first()).toHaveText('From other side', { timeout: 15_000 });
  await launched.win.waitForTimeout(1500);
  expect(read(rel)).toBe(delivered);
});

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { freshVault, launchBuilt, makeTemp, openNoteByName, quitLikeUser, removeTemp, sleep } from './helpers/app';

/**
 * Quitting from the taskbar while the window is minimized (Chromium throttles
 * its timers then) must still save the last edit, promptly, and leave no
 * crash sentinel behind.
 */

let root: string;

test.beforeAll(() => {
  root = makeTemp('minquit');
});

test.afterAll(() => removeTemp(root));

const VARIANTS = [
  { name: 'typed, minimized at once, quit', settleMs: 0, idleMs: 0 },
  { name: 'typed, saved, minimized for 20 s, quit', settleMs: 2000, idleMs: 20_000 },
];

for (const v of VARIANTS) {
  test(`${v.name}: the edit is on disk and the vault is clean`, async () => {
    const vault = freshVault(root, `Min ${v.settleMs}`, { 'Note.md': '---\ntitle: Note\n---\nOriginal line\n' });
    const launched = await launchBuilt(vault, { throttled: true });
    const editor = await openNoteByName(launched.win, 'Note');
    await editor.click();
    await launched.win.keyboard.press('Control+End');
    await launched.win.keyboard.type(' EDITED');
    if (v.settleMs) await launched.win.waitForTimeout(v.settleMs);
    await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
    if (v.idleMs) await sleep(v.idleMs);

    const quit = await quitLikeUser(launched);
    expect(quit.outcome, JSON.stringify(quit)).toBe('exited');
    expect(quit.ms).toBeLessThan(15_000);
    expect(fs.readFileSync(path.join(vault, 'Note.md'), 'utf8')).toBe('---\ntitle: Note\n---\nOriginal line EDITED\n');
    const leftovers = fs.readdirSync(path.join(vault, '.filo')).filter((f) => f.startsWith('.dirty') || f.includes('quit-failure'));
    expect(leftovers).toEqual([]);
  });
}

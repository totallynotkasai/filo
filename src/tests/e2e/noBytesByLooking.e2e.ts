import { test, expect } from '@playwright/test';
import {
  changedFiles,
  freshVault,
  generateVault,
  hashVault,
  launchBuilt,
  makeTemp,
  openBoardByName,
  openNoteByName,
  quitLikeUser,
  removeTemp,
} from './helpers/app';

/**
 * Opening a vault, every board type and a few notes in Document tabs, then
 * quitting, writes no byte of any file outside `.filo/`. The vault holds the
 * shapes a careless writer changes: CRLF, a BOM, a comment, `zip: 02134`
 * (a string a YAML re-dump turns into the number 2134), notes without
 * frontmatter, task fields, tables, code and checklists.
 */

let root: string;

test.beforeAll(() => {
  root = makeTemp('bytes');
});

test.afterAll(() => removeTemp(root));

const LOOKED_AT = {
  Crlf: '---\r\ntitle: Crlf\r\ntags: [alpha]\r\n---\r\n# Hello\r\n\r\nSome **bold** text.\r\n\r\n- one\r\n- two\r\n',
  Bom: `${String.fromCharCode(0xfeff)}---\ntitle: Bom\n---\nA Notepad note.\n`,
  Zip: '---\ntitle: Zip\n# a comment the user wrote\nzip: 02134\ncolour: 0xFF00FF\n---\nPostcode note.\n',
  Plain: 'No frontmatter here, just text.\n',
  Checklist: '---\ntitle: Checklist\n---\n- [ ] one\n- [x] two\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n',
};

test('opening every board type and several notes, then quitting, changes no file', async () => {
  test.setTimeout(240_000);
  const vault = freshVault(root, 'LookVault', Object.fromEntries(Object.entries(LOOKED_AT).map(([k, v]) => [`${k}.md`, v])));
  generateVault(vault, 1000);
  const before = hashVault(vault);

  const launched = await launchBuilt(vault);
  const { win } = launched;
  try {
    for (const [name, selector] of [
      ['Gen Mind Map', '.tile-container'],
      ['Gen Kanban', '.kanban-card-shell'],
      ['Gen Task List', '.task-item-wrap'],
    ] as const) {
      await openBoardByName(win, name);
      await expect(win.locator(selector).first()).toBeVisible({ timeout: 30_000 });
      await win.waitForTimeout(1500);
    }
    // A Kanban card's editor mounts in idle time: give every card on screen its turn.
    for (const name of Object.keys(LOOKED_AT)) {
      const editor = await openNoteByName(win, name);
      await expect(editor).not.toBeEmpty();
      await win.waitForTimeout(1000);
    }
    // Back to the boards once more, with the index settled.
    await win.locator('.tab', { hasText: 'Gen Kanban' }).first().click();
    await win.waitForTimeout(3000);
  } finally {
    expect((await quitLikeUser(launched)).outcome).toBe('exited');
  }
  expect(changedFiles(before, hashVault(vault))).toEqual([]);
  expect(launched.errors.filter((e) => e.includes('effect_update_depth_exceeded'))).toEqual([]);
});

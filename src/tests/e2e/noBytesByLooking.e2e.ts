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
 * frontmatter, task fields, tables, code and checklists. Two boards written by
 * hand carry no saved view (`lastView`): showing them writes none.
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

/** A Kanban board and a Task List as a person or another tool writes them: no `lastView`. */
function handWrittenBoards(): Record<string, string> {
  const at = 1790000000000;
  const def = (id: string, filePath: string): Record<string, unknown> => ({
    id, type: 'text', filePath, style: { headerColor: '', bodyColor: '' }, createdAt: at, updatedAt: at,
  });
  const head = (id: string, name: string, type: string, settings: Record<string, unknown>): Record<string, unknown> => ({
    id, name, emoji: '', createdAt: at, updatedAt: at, type,
    settings: { backgroundColor: '', defaultFolder: '', accentColor: '', ...settings, defaults: {} },
  });
  const board = (data: Record<string, unknown>): string => JSON.stringify({ version: 8, ...data, connections: {}, frames: [] }, null, 2);
  return {
    'Hand Kanban.board.json': board({
      board: {
        ...head('handkanban01', 'Hand Kanban', 'kanban', {}),
        columns: [{ id: 'handcolumn01', title: 'To do', position: 0, collapsed: false, tilePlacements: [{ tileId: 'handcard0001', position: 0 }] }],
      },
      tileDefs: { handcard0001: def('handcard0001', 'Plain.md') },
    }),
    'Hand List.board.json': board({
      board: {
        ...head('handlist0001', 'Hand List', 'tasklist', { groupBy: 'none', sortBy: 'manual' }),
        tasks: [{ tileId: 'handtask0001', position: 0 }],
        sections: [{ id: 'sec_handlist', title: 'Section 1', position: 0, collapsed: false }],
        collapsedSubtasks: [],
      },
      tileDefs: { handtask0001: def('handtask0001', 'Crlf.md') },
    }),
  };
}

test('opening every board type and several notes, then quitting, changes no file', async () => {
  test.setTimeout(240_000);
  const vault = freshVault(root, 'LookVault', {
    ...Object.fromEntries(Object.entries(LOOKED_AT).map(([k, v]) => [`${k}.md`, v])),
    ...handWrittenBoards(),
  });
  generateVault(vault, 1000);
  const before = hashVault(vault);

  const launched = await launchBuilt(vault);
  const { win } = launched;
  try {
    for (const [name, selector] of [
      ['Gen Mind Map', '.tile-container'],
      ['Gen Kanban', '.kanban-card-shell'],
      ['Gen Task List', '.task-item-wrap'],
      ['Hand Kanban', '.kanban-card-shell'],
      ['Hand List', '.task-item-wrap'],
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

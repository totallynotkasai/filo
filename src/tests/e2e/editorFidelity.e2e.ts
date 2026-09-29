import { test, expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { freshVault, launchBuilt, makeTemp, openNoteByName, quitLikeUser, removeTemp } from './helpers/app';

/**
 * Ordinary formatting typed in the built app must reopen editable. Each case
 * is one a note once came back from read-only: Filo wrote Markdown it then
 * couldn't read back to the same document. Session one types the edits and
 * quits; session two reopens every note and looks for the read-only banner.
 */

const seed = (name: string, body: string): [string, string] => [`${name}.md`, `---\ntitle: ${name}\n---\n${body}`];

interface Case {
  name: string;
  body: string;
  edit: (win: Page, editor: Locator) => Promise<void>;
  /** Text the reopened editor shows. */
  shows: RegExp;
}

const CASES: Case[] = [
  {
    // A checklist whose last item is still empty.
    name: 'Checklist',
    body: 'Intro\n',
    edit: async (win, ed) => {
      await ed.click();
      await win.keyboard.press('Control+End');
      await win.keyboard.press('Enter');
      await win.keyboard.type('[ ] first task');
      await win.keyboard.press('Enter');
      await ed.locator('p').first().click();
    },
    shows: /first task/,
  },
  {
    // One item of a bullet list turned into a checkbox (the list is split).
    name: 'Mixed',
    body: '- a\n- b\n- c\n',
    edit: async (win, ed) => {
      await ed.locator('li', { hasText: 'b' }).first().click();
      await win.keyboard.press('Control+Shift+9');
    },
    shows: /a[\s\S]*b[\s\S]*c/,
  },
  {
    // A paragraph typed with leading spaces.
    name: 'Indent',
    body: 'Intro\n',
    edit: async (win, ed) => {
      await ed.click();
      await win.keyboard.press('Control+End');
      await win.keyboard.press('Enter');
      await win.keyboard.type('    Indented with four spaces');
    },
    shows: /Indented with four spaces/,
  },
  {
    // A `|` typed inside a table cell.
    name: 'Table',
    body: 'Intro\n\n| A | B |\n| --- | --- |\n| one | two |\n',
    edit: async (win, ed) => {
      await ed.locator('td', { hasText: 'one' }).first().click();
      await win.keyboard.press('End');
      await win.keyboard.type(' yes|no');
    },
    shows: /one yes\|no/,
  },
  {
    // A fence typed inside a code block.
    name: 'Code',
    body: 'Intro\n\n```\nconst x = 1;\n```\n',
    edit: async (win, ed) => {
      await ed.locator('pre').first().click();
      await win.keyboard.press('Control+End');
      await win.keyboard.type('\n```');
    },
    shows: /const x = 1;\s*```/,
  },
];

let root: string;
let vault: string;

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  root = makeTemp('editor');
  vault = freshVault(root, 'EditVault', Object.fromEntries(CASES.map((c) => seed(c.name, c.body))));
});

test.afterAll(() => removeTemp(root));

test('typed formatting is saved', async () => {
  const launched = await launchBuilt(vault);
  try {
    for (const c of CASES) {
      const editor = await openNoteByName(launched.win, c.name);
      await c.edit(launched.win, editor);
      // Past the editor's 150 ms serialise and the writer's 300 ms debounce.
      await launched.win.waitForTimeout(1500);
    }
  } finally {
    expect((await quitLikeUser(launched)).outcome).toBe('exited');
  }
  for (const c of CASES) {
    const text = fs.readFileSync(path.join(vault, `${c.name}.md`), 'utf8');
    expect(text, `${c.name}.md was never written`).not.toBe(`---\ntitle: ${c.name}\n---\n${c.body}`);
  }
});

test('every edited note reopens editable, showing what was typed', async () => {
  const launched = await launchBuilt(vault);
  try {
    for (const c of CASES) {
      const editor = await openNoteByName(launched.win, c.name);
      await expect(editor, c.name).toHaveText(c.shows);
      await expect(editor, `${c.name} reopened read-only`).toHaveAttribute('contenteditable', 'true');
      await expect(launched.win.locator('.readonly-banner:visible'), `${c.name} shows the read-only banner`).toHaveCount(0);
    }
    expect(launched.errors.filter((e) => e.includes('effect_update_depth_exceeded'))).toEqual([]);
  } finally {
    await quitLikeUser(launched);
  }
});

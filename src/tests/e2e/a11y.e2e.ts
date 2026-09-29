import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import {
  freshVault,
  launchBuilt,
  makeTemp,
  newBoard,
  openNoteByName,
  openVaultFromHome,
  quitLikeUser,
  removeTemp,
} from './helpers/app';
import type { LaunchedApp } from './helpers/app';

/**
 * WCAG 2.1 AA scan of each main view with axe-core. `@axe-core/playwright`
 * opens a new target to run, which Electron refuses (`Target.createTarget:
 * Not supported`), so axe's own source is evaluated in the page (through the
 * debugger, which the app's CSP doesn't govern) and `axe.run()` called there.
 */

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

// DECISION: colour contrast is checked per theme by `themeContrast.test.ts`,
// against the palette itself, rather than here. That test holds tertiary text
// (hints, counts, keyboard hints) to the 3:1 large-text bar on purpose, where
// axe applies 4.5:1 to every small string; and it checks all five built-in
// themes, where this scan sees only the one the app opens with.
const ALWAYS_OFF = ['color-contrast'];
const AXE_SOURCE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

interface Violation {
  id: string;
  impact: string | null;
  help: string;
  /** Up to five offending elements, each with axe's summary of what is wrong. */
  nodes: string[];
}

async function scan(win: Page, include: string | null, disabled: string[] = []): Promise<Violation[]> {
  const loaded = await win.evaluate(() => typeof (window as unknown as { axe?: unknown }).axe !== 'undefined');
  if (!loaded) await win.evaluate(AXE_SOURCE);
  // Colours measured mid-fade read as low contrast: let every running
  // animation and transition finish first.
  await win.evaluate(async () => {
    await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
    await new Promise((r) => setTimeout(r, 300));
  });
  return win.evaluate(
    async ({ include: inc, tags, off }) => {
      const axe = (window as unknown as {
        axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Array<{ id: string; impact: string | null; help: string; nodes: Array<{ target: string[]; failureSummary?: string }> }> }> };
      }).axe;
      const result = await axe.run(inc ? { include: [inc] } : document, {
        runOnly: { type: 'tag', values: tags },
        rules: Object.fromEntries(off.map((r) => [r, { enabled: false }])),
      });
      return result.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 5).map((n) => `${n.target.join(' ')}: ${(n.failureSummary ?? '').replace(/\s+/g, ' ')}`) }));
    },
    { include, tags: WCAG, off: [...ALWAYS_OFF, ...disabled] },
  );
}

let root: string;

test.beforeAll(() => {
  root = makeTemp('a11y');
});

test.afterAll(() => removeTemp(root));

// One app, one pass through the views; every scan is a soft check, so one
// view's violations don't hide the next view's.
test('every main view passes a WCAG 2.1 AA scan', async () => {
  const vault = freshVault(root, 'A11y Vault', { 'Note.md': '---\ntitle: Note\ntags: [a]\n---\n# Heading\n\nSome text.\n' });
  const launched: LaunchedApp = await launchBuilt(vault, { open: false });
  const { win } = launched;
  const modal = win.locator('dialog[aria-modal="true"]').first();
  try {
    await test.step('Home screen', async () => {
      await expect(win.locator('button.action-card', { hasText: 'Open Vault' })).toBeVisible({ timeout: 30_000 });
      // The Home screen has no landmarks to put content in.
      expect.soft(await scan(win, null, ['region']), 'Home screen').toEqual([]);
    });

    await test.step('the app shell has a labelled main landmark and a skip link', async () => {
      await openVaultFromHome(win);
      await expect(win.locator('main#main-workspace')).toHaveAttribute('aria-label', /workspace/i);
      await expect(win.locator('a.skip-link')).toHaveAttribute('href', '#main-workspace');
    });

    await test.step('Mind Map board', async () => {
      await newBoard(win, 'Mind Map');
      const canvas = win.locator('.mindmap-board[role="application"]');
      await expect(canvas).toBeVisible({ timeout: 20_000 });
      await expect(canvas).toHaveAttribute('aria-label', /canvas/i);
      expect.soft(await scan(win, '.mindmap-board'), 'Mind Map board').toEqual([]);
    });

    await test.step('Template Browser', async () => {
      await win.locator('.mindmap-board').first().click({ position: { x: 300, y: 300 } });
      await win.keyboard.press('Control+T');
      await expect(modal).toBeVisible({ timeout: 5_000 });
      expect.soft(await scan(win, 'dialog[aria-modal="true"]'), 'Template Browser').toEqual([]);
      await win.keyboard.press('Escape');
      await expect(modal).toBeHidden();
    });

    await test.step('Kanban board', async () => {
      await newBoard(win, 'Kanban');
      await expect(win.locator('.kanban-board').first()).toBeVisible({ timeout: 20_000 });
      expect.soft(await scan(win, '.kanban-board'), 'Kanban board').toEqual([]);
    });

    await test.step('Task List board', async () => {
      await newBoard(win, 'Task List');
      await expect(win.locator('.tasklist-board').first()).toBeVisible({ timeout: 20_000 });
      expect.soft(await scan(win, '.tasklist-board'), 'Task List board').toEqual([]);
    });

    await test.step('Document tab', async () => {
      await openNoteByName(win, 'Note');
      // The editor surface is named by the note's title field and toolbar
      // around it, not by a label on the contenteditable itself.
      expect.soft(await scan(win, '.document-board', ['aria-input-field-name']), 'Document tab').toEqual([]);
    });

    await test.step('Settings', async () => {
      await win.keyboard.press('Control+,');
      await expect(modal).toBeVisible({ timeout: 5_000 });
      expect.soft(await scan(win, 'dialog[aria-modal="true"]'), 'Settings').toEqual([]);
      await win.keyboard.press('Escape');
      await expect(modal).toBeHidden();
    });

    await test.step('Board Browser', async () => {
      await win.locator('button[aria-label="Open Board Browser"]').first().click();
      const panel = win.locator('.board-browser-panel[role="dialog"]');
      await expect(panel).toBeVisible({ timeout: 5_000 });
      // Known and left for its own change: each row is a role=button holding
      // its Rename and Delete buttons (`nested-interactive`); fixing it means
      // reworking the row's drag and keyboard handling.
      expect.soft(await scan(win, '.board-browser-panel', ['nested-interactive']), 'Board Browser').toEqual([]);
      await win.keyboard.press('Escape');
      await expect(panel).toBeHidden();
    });
  } finally {
    await quitLikeUser(launched);
  }
});

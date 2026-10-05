import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { freshVault, launchBuilt, makeTemp, openNoteByName, quitLikeUser, removeTemp } from './helpers/app';
import type { LaunchedApp } from './helpers/app';

/**
 * The interface around the views, in the built app (Audit-28 Phase 5):
 *
 * - right-clicking a note's text builds main's text menu (Cut, Copy, Paste,
 *   Select All, Insert Link), and its Insert Link opens the link popup;
 * - at 1,100 px the docked sidebar no longer covers the note, and at 1,100,
 *   1,280 and 1,366 px every formatting control is on screen;
 * - a link copied from the sidebar pastes into a note as a link named after
 *   the note it opens.
 */

let root: string;
let vault: string;
let launched: LaunchedApp;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  root = makeTemp('chrome');
  vault = freshVault(root, 'Chrome Vault', {
    'Plot Overview.md': '---\ntitle: Plot Overview\n---\nShikara working in the fields at dawn.\n',
    'River City.md': '---\ntitle: River City\n---\nThe city on the river.\n',
  });
  launched = await launchBuilt(vault);
  // Main's menus are captured instead of shown: a native menu would hold the test.
  await launched.app.evaluate(({ Menu }) => {
    const g = globalThis as unknown as { __menus: Array<Array<{ label?: string; role?: string; type?: string; enabled?: boolean; click?: () => void }>> };
    g.__menus = [];
    Menu.buildFromTemplate = ((template: never[]) => {
      g.__menus.push(template);
      return { popup: () => undefined } as never;
    }) as typeof Menu.buildFromTemplate;
  });
});

test.afterAll(async () => {
  if (launched) await quitLikeUser(launched);
  removeTemp(root);
});

async function lastMenu(): Promise<string[]> {
  return launched.app.evaluate(() => {
    const g = globalThis as unknown as { __menus: Array<Array<{ label?: string; role?: string; type?: string; enabled?: boolean }>> };
    const menu = g.__menus.at(-1) ?? [];
    return menu.map((i) => i.type === 'separator' ? '---' : `${i.label ?? i.role}${i.enabled === false ? ' (off)' : ''}`);
  });
}

async function setWidth(w: number): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }, width) => {
    const b = BrowserWindow.getAllWindows()[0];
    if (b.isMaximized()) b.unmaximize();
    b.setContentSize(width, 760);
  }, w);
  await launched.win.waitForTimeout(500);
}

test('right-clicking a note builds the text menu, and its Insert Link opens the popup', async () => {
  const { win, app } = launched;
  const editor = await openNoteByName(win, 'Plot Overview');
  // A right-click inside a selected word keeps it selected, so Cut and Copy are on.
  await editor.locator('p').first().dblclick({ position: { x: 20, y: 8 } });
  const box = (await editor.locator('p').first().boundingBox())!;
  await win.mouse.click(box.x + 20, box.y + 8, { button: 'right' });
  await expect.poll(lastMenu).toEqual(['cut', 'copy', 'paste', '---', 'selectAll', '---', 'Insert Link…']);

  await app.evaluate(() => {
    const g = globalThis as unknown as { __menus: Array<Array<{ label?: string; click?: () => void }>> };
    g.__menus.at(-1)?.find((i) => i.label === 'Insert Link…')?.click?.();
  });
  await expect(win.locator('.link-popup')).toBeVisible();
  await win.keyboard.press('Escape');
  await expect(win.locator('.link-popup')).toHaveCount(0);
});

test('Filo keeps its own menu on a tab: no text menu is built there', async () => {
  const { win, app } = launched;
  const before = await app.evaluate(() => (globalThis as unknown as { __menus: unknown[] }).__menus.length);
  await win.locator('.tab[aria-selected="true"]').click({ button: 'right' });
  await expect(win.locator('.context-menu')).toBeVisible();
  await win.keyboard.press('Escape');
  expect(await app.evaluate(() => (globalThis as unknown as { __menus: unknown[] }).__menus.length)).toBe(before);
});

test('at laptop widths the note clears the sidebar and every formatting control is on screen', async ({}, info) => {
  const { win } = launched;
  const editor = await openNoteByName(win, 'Plot Overview');
  await editor.click();
  for (const width of [1100, 1280, 1366]) {
    await setWidth(width);
    const geo = await win.evaluate(() => {
      const side = document.querySelector('.vault-sidebar .sidebar-inner')?.getBoundingClientRect();
      const line = document.querySelector('.document-board .ProseMirror p')?.getBoundingClientRect();
      const bar = document.querySelector('.toolbar-section.formatting') as HTMLElement;
      const box = bar.getBoundingClientRect();
      const outside = [...bar.querySelectorAll<HTMLElement>('button, select')]
        .filter((c) => {
          const r = c.getBoundingClientRect();
          return r.width < 8 || r.left < box.left - 0.5 || r.right > box.right + 0.5;
        })
        .map((c) => c.getAttribute('aria-label') ?? c.getAttribute('title') ?? c.tagName);
      return { sideRight: side?.right ?? 0, lineLeft: line?.left ?? 0, outside, font: (bar.querySelector('select[aria-label="Font family"]') as HTMLSelectElement).value };
    });
    await win.screenshot({ path: info.outputPath(`note-${width}.png`) });
    expect(geo.lineLeft, `${width} px`).toBeGreaterThan(geo.sideRight);
    expect(geo.outside, `${width} px`).toEqual([]);
    expect(geo.font, `${width} px`).toBe('Arial Rounded MT');
  }
  // Compact, the note-layout controls are one click away.
  await setWidth(1100);
  await editor.click();
  await win.locator('button[aria-label="More formatting"]').click();
  await expect(win.locator('.toolbar-more-panel select[aria-label="Line spacing (whole note)"]')).toBeVisible();
  await win.keyboard.press('Escape');
  await expect(win.locator('.toolbar-more-panel')).toHaveCount(0);
  await setWidth(1440);
});

// This case uses the machine's real clipboard: what it held is put back after.
test('a link copied from the sidebar pastes into a note as a link to that note, which opens it', async () => {
  const { app } = launched;
  await app.evaluate(async ({ clipboard }) => {
    (globalThis as unknown as { __clip: unknown }).__clip = await clipboard.read();
  });
  try {
    await pasteCopiedLink();
  } finally {
    await app.evaluate(async ({ clipboard, ClipboardItem }) => {
      const saved = (globalThis as unknown as { __clip: Parameters<typeof clipboard.write>[0] }).__clip;
      // An item read can't be written back as it is: each is rebuilt from its parts.
      const items = await Promise.all(saved.map(async (item) => {
        const parts: Record<string, Blob> = {};
        for (const type of item.types) {
          const part = await item.getType(type);
          if (part instanceof Blob) parts[type] = part;
        }
        return new ClipboardItem(parts);
      }));
      if (items.length > 0) await clipboard.write(items);
      else clipboard.clear();
    });
  }
});

async function pasteCopiedLink(): Promise<void> {
  const { win, app } = launched;
  const row = win.locator('.file-row', { has: win.locator('.file-name', { hasText: 'River City' }) });
  await row.click({ button: 'right' });
  await win.locator('.context-menu').getByText('Copy link to note', { exact: true }).click();
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('filo://note/River%20City.md');

  const editor = await openNoteByName(win, 'Plot Overview');
  await editor.click();
  await win.keyboard.press('Control+End');
  await win.keyboard.press('Enter');
  await win.keyboard.type('See ');
  await win.keyboard.press('Control+V');
  const link = editor.locator('a', { hasText: 'River City' });
  await expect(link).toHaveAttribute('href', 'filo://note/River%20City.md');
  await expect.poll(() => fs.readFileSync(path.join(vault, 'Plot Overview.md'), 'utf8'), { timeout: 10_000 })
    .toContain('See [River City](filo://note/River%20City.md)');

  // In the note being edited, Ctrl+click follows it.
  await link.click({ modifiers: ['Control'] });
  await expect(win.locator('.tab[aria-selected="true"] .tab-name')).toHaveText('River City');
}

import { test, expect, type Page } from '@playwright/test';
import { freshVault, launchBuilt, makeTemp, newBoard, openNoteByName, quitLikeUser, removeTemp, sidebarRow, type LaunchedApp } from './helpers/app';

/**
 * The Mind Map and a Document tab on a 1,366 px laptop, in the built app:
 * N beside a tile off screen brings the new tile into view with its title
 * open, and an arrow key brings a tile out from under the docked sidebar; a
 * note zoomed to 150% (Ctrl and + on the number pad, Ctrl+Shift+=) starts
 * clear of the sidebar; a sidebar row's name uses the row's width while its
 * buttons are hidden.
 */

let root: string;

test.beforeAll(() => {
  root = makeTemp('viewspanels');
});

test.afterAll(() => removeTemp(root));

async function setWidth(launched: LaunchedApp, w: number): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }, width) => {
    const b = BrowserWindow.getAllWindows()[0];
    if (b.isMaximized()) b.unmaximize();
    b.setContentSize(width, 800);
  }, w);
  await launched.win.waitForTimeout(500);
}

/** Where the docked sidebar ends, and where the tile titled `title` starts and ends, in window pixels. */
async function tilePlace(win: Page, title: string): Promise<{ sidebarRight: number; left: number; right: number; viewRight: number }> {
  return win.evaluate((t) => {
    const side = document.querySelector('.vault-sidebar .sidebar-inner')?.getBoundingClientRect();
    const tile = [...document.querySelectorAll('.mindmap-board .tile-container')]
      .find((c) => (c.querySelector('.tile-title')?.textContent ?? '').trim() === t)?.getBoundingClientRect();
    const view = document.querySelector('.mindmap-board')!.getBoundingClientRect();
    return { sidebarRight: side?.right ?? 0, left: tile?.left ?? NaN, right: tile?.right ?? NaN, viewRight: view.right };
  }, title);
}

/** Shift and the wheel over the canvas: the view moves sideways by `dx` px. */
async function panSideways(win: Page, dx: number): Promise<void> {
  const box = (await win.locator('.mindmap-board').boundingBox())!;
  await win.mouse.move(box.x + box.width - 60, box.y + box.height - 60);
  await win.keyboard.down('Shift');
  await win.mouse.wheel(0, dx);
  await win.keyboard.up('Shift');
  await win.waitForTimeout(300);
}

async function newTextTile(win: Page, title: string): Promise<void> {
  await win.locator('button.side-btn[title^="New Tile"]').click();
  await win.locator('.side-dropdown .dropdown-item', { hasText: 'Text' }).first().click();
  await expect(win.locator('.tile-title-editor .ProseMirror')).toBeFocused({ timeout: 10_000 });
  await win.keyboard.type(title);
  await win.keyboard.press('Enter');
  await expect(win.locator('.mindmap-board .tile-title', { hasText: title })).toHaveCount(1);
}

test('Mind Map at 1,366 px: N beside a tile off screen shows the new tile, title open; an arrow brings a tile out from under the sidebar', async ({}, info) => {
  const launched = await launchBuilt(freshVault(root, 'MapVault'));
  const { win } = launched;
  try {
    await setWidth(launched, 1366);
    await newBoard(win, 'Mind Map');
    await expect(win.locator('.mindmap-board').first()).toBeVisible({ timeout: 20_000 });
    await newTextTile(win, 'Anchor');

    // Anchor selected from the keyboard (focus stays on the canvas), then the
    // view moved so far that no free spot near Anchor is in view: the new
    // tile goes beside it, off screen.
    const box = (await win.locator('.mindmap-board').boundingBox())!;
    await win.mouse.click(box.x + box.width - 80, box.y + 80);
    await win.keyboard.press('ArrowRight');
    await expect(win.locator('.mindmap-board .tile-container.selected .tile-title')).toHaveText('Anchor');
    for (let i = 0; i < 4; i++) await panSideways(win, 2000);
    // Off screen, a tile isn't drawn at all.
    const gone = (await tilePlace(win, 'Anchor')).right;
    expect(Number.isNaN(gone) || gone < 0).toBe(true);

    await win.keyboard.press('n');
    await expect(win.locator('.tile-title-editor .ProseMirror')).toBeFocused({ timeout: 10_000 });
    await win.keyboard.type('Beta');
    await win.keyboard.press('Enter');
    await expect(win.locator('.mindmap-board .tile-title', { hasText: 'Beta' })).toHaveCount(1);
    const beta = await tilePlace(win, 'Beta');
    expect(beta.left, 'the new tile clear of the sidebar').toBeGreaterThanOrEqual(beta.sidebarRight);
    expect(beta.right).toBeLessThanOrEqual(beta.viewRight);
    await win.screenshot({ path: info.outputPath('new-tile-revealed.png') });

    // The view came to Beta, so Anchor, beside it on the left, lies under the
    // docked sidebar: ArrowLeft from Beta brings it out.
    const under = await tilePlace(win, 'Anchor');
    expect(under.left).toBeLessThan(under.sidebarRight);
    await win.locator('.mindmap-board .tile-container', { hasText: 'Beta' }).locator('.tile-title').click();
    await win.keyboard.press('ArrowLeft');
    await expect(win.locator('.mindmap-board .tile-container.selected .tile-title')).toHaveText('Anchor');
    const revealed = await tilePlace(win, 'Anchor');
    expect(revealed.left, 'the tile the arrow selected, clear of the sidebar').toBeGreaterThanOrEqual(revealed.sidebarRight);
    await win.screenshot({ path: info.outputPath('arrow-revealed.png') });
  } finally {
    expect((await quitLikeUser(launched)).outcome).toBe('exited');
  }
});

test('a note zoomed to 150% with Ctrl and + starts clear of the docked sidebar at 1,366 px', async ({}, info) => {
  const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
  const launched = await launchBuilt(freshVault(root, 'ZoomVault', { 'Plot.md': `---\ntitle: Plot\n---\n${words}\n` }));
  const { win } = launched;
  try {
    await setWidth(launched, 1366);
    const editor = await openNoteByName(win, 'Plot');
    await editor.click();
    await win.keyboard.press('Control+NumpadAdd');
    await expect(win.locator('.document-board .zoom-level')).toHaveText('110%');
    await win.keyboard.press('Control+Shift+Equal');
    await expect(win.locator('.document-board .zoom-level')).toHaveText('125%');
    await win.keyboard.press('Control+=');
    await expect(win.locator('.document-board .zoom-level')).toHaveText('150%');
    await win.waitForTimeout(400);
    const geo = await win.evaluate(() => ({
      sideRight: document.querySelector('.vault-sidebar .sidebar-inner')?.getBoundingClientRect().right ?? 0,
      lineLeft: document.querySelector('.document-board .ProseMirror p')?.getBoundingClientRect().left ?? 0,
    }));
    await win.screenshot({ path: info.outputPath('zoomed-150.png') });
    expect(geo.lineLeft).toBeGreaterThan(geo.sideRight);
    await win.keyboard.press('Control+0');
    await expect(win.locator('.document-board .zoom-level')).toHaveText('100%');
  } finally {
    expect((await quitLikeUser(launched)).outcome).toBe('exited');
  }
});

test("a sidebar row's name uses the row's width while its buttons are hidden", async ({}, info) => {
  const launched = await launchBuilt(freshVault(root, 'NamesVault', { '03 Characters/Aria.md': 'Aria\n' }));
  const { win } = launched;
  try {
    const row = sidebarRow(win, '03 Characters');
    await expect(row).toBeVisible({ timeout: 20_000 });
    // The pointer away from the sidebar: no row's buttons show.
    await win.mouse.move(900, 400);
    await win.waitForTimeout(200);
    const cut = await row.locator('.file-name').evaluate((el) => el.scrollWidth > el.clientWidth);
    await win.screenshot({ path: info.outputPath('sidebar-names.png') });
    expect(cut, 'the folder name shown whole').toBe(false);
  } finally {
    expect((await quitLikeUser(launched)).outcome).toBe('exited');
  }
});

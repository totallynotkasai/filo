import { test, expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { freshVault, launchBuilt, makeTemp, newBoard, quitLikeUser, removeTemp, sidebarRow } from './helpers/app';

/**
 * Presses that land inside a Mind Map frame, and sidebar drags that end where
 * they began. A press in a frame's empty body pans the board as a press on the
 * canvas does (the header still moves the frame). A file or folder picked up
 * in the vault sidebar and put back down moves nothing and leaves no drop
 * highlight behind, and neither does a real move into a folder.
 */

let root: string;

test.beforeAll(() => {
  root = makeTemp('drags');
});

test.afterAll(() => removeTemp(root));

/** The canvas's pan, read off `.canvas-transform`'s `translate(…)`. */
async function pan(win: Page): Promise<{ x: number; y: number }> {
  const style = (await win.locator('.canvas-transform').first().getAttribute('style')) ?? '';
  const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(style);
  if (!m) throw new Error(`no translate in "${style}"`);
  return { x: Number(m[1]), y: Number(m[2]) };
}

/** The frame's canvas position, read off its `left` / `top`. */
async function framePosition(frame: Locator): Promise<{ x: number; y: number }> {
  const style = (await frame.getAttribute('style')) ?? '';
  const left = /left:\s*([-\d.]+)px/.exec(style);
  const top = /top:\s*([-\d.]+)px/.exec(style);
  if (!left || !top) throw new Error(`no position in "${style}"`);
  return { x: Number(left[1]), y: Number(top[1]) };
}

async function dragBy(win: Page, x: number, y: number, dx: number, dy: number): Promise<void> {
  await win.mouse.move(x, y);
  await win.mouse.down();
  await win.mouse.move(x + dx, y + dy, { steps: 10 });
  await win.mouse.up();
  await win.waitForTimeout(400);
}

/** Picks a sidebar row up by its name, wiggles it past the drag threshold and puts it back down where it was. */
async function pickUpAndPutBack(win: Page, row: Locator): Promise<void> {
  const box = await row.locator('.file-name').boundingBox();
  if (!box) throw new Error('row not on screen');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await win.mouse.move(x, y);
  await win.mouse.down();
  await win.mouse.move(x + 8, y + 3, { steps: 5 });
  await win.mouse.move(x, y, { steps: 5 });
  await win.mouse.up();
  await win.waitForTimeout(800);
}

async function expectNoDropHighlight(win: Page): Promise<void> {
  await expect(win.locator('.file-tree.root-drop-active')).toHaveCount(0);
  await expect(win.locator('.vault-file-item.drop-target')).toHaveCount(0);
}

test('a press in a frame body pans the board; the header still moves the frame', async () => {
  const vault = freshVault(root, 'FrameVault');
  const launched = await launchBuilt(vault);
  const { win } = launched;
  try {
    await newBoard(win, 'Mind Map');
    await expect(win.locator('.mindmap-board').first()).toBeVisible({ timeout: 20_000 });
    await win.locator('.side-btn[title="New Tile (Ctrl+N)"]').click();
    await win.locator('.side-dropdown .dropdown-item', { hasText: 'Frame' }).click();
    const frame = win.locator('.frame-container').first();
    await expect(frame).toBeVisible({ timeout: 10_000 });
    await win.waitForTimeout(400);

    const body = await frame.locator('.frame-body').boundingBox();
    if (!body) throw new Error('frame body not on screen');
    const panBefore = await pan(win);
    const frameBefore = await framePosition(frame);
    await dragBy(win, body.x + body.width / 2, body.y + body.height / 2, 150, 90);
    const panAfter = await pan(win);
    expect(panAfter.x - panBefore.x).toBeCloseTo(150, 0);
    expect(panAfter.y - panBefore.y).toBeCloseTo(90, 0);
    expect(await framePosition(frame)).toEqual(frameBefore);

    // The header's empty strip, clear of the title and the buttons.
    const header = await frame.locator('.frame-header').boundingBox();
    if (!header) throw new Error('frame header not on screen');
    await dragBy(win, header.x + header.width * 0.6, header.y + header.height / 2, 60, 40);
    expect(await pan(win)).toEqual(panAfter);
    const frameAfter = await framePosition(frame);
    expect(frameAfter.x).not.toBe(frameBefore.x);
    expect(frameAfter.y).not.toBe(frameBefore.y);
  } finally {
    await quitLikeUser(launched);
  }
});

test('a sidebar row put back where it was moves nothing and leaves no highlight', async () => {
  const vault = freshVault(root, 'SidebarVault', {
    'Chapters/Inner.md': '# Inner\n',
    'Top.md': '# Top\n',
  });
  const launched = await launchBuilt(vault);
  const { win } = launched;
  try {
    const folder = sidebarRow(win, 'Chapters');
    await expect(folder).toBeVisible({ timeout: 20_000 });

    await pickUpAndPutBack(win, folder);
    await expectNoDropHighlight(win);
    expect(fs.existsSync(path.join(vault, 'Chapters', 'Inner.md'))).toBe(true);

    // A note inside a folder, put back on its own row, stays in its folder.
    await folder.locator('.file-name').click();
    const inner = sidebarRow(win, 'Inner.md');
    await expect(inner).toBeVisible({ timeout: 10_000 });
    await pickUpAndPutBack(win, inner);
    await expectNoDropHighlight(win);
    expect(fs.existsSync(path.join(vault, 'Chapters', 'Inner.md'))).toBe(true);
    expect(fs.existsSync(path.join(vault, 'Inner.md'))).toBe(false);

    // A real move into a folder leaves no highlight either.
    const top = sidebarRow(win, 'Top.md');
    const from = await top.locator('.file-name').boundingBox();
    const to = await folder.locator('.file-name').boundingBox();
    if (!from || !to) throw new Error('rows not on screen');
    await win.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await win.mouse.down();
    await win.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
    await win.mouse.up();
    await expect.poll(() => fs.existsSync(path.join(vault, 'Chapters', 'Top.md')), { timeout: 10_000 }).toBe(true);
    await expectNoDropHighlight(win);
  } finally {
    await quitLikeUser(launched);
  }
});

/**
 * Drivers for changes a view still holds when the user leaves: a title typed
 * but not committed, a filter change or camera move inside its debounce,
 * keys typed while the save before leaving is out. None of them waits for
 * the debounce, so the spec can leave straight after.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CharApp } from './app';
import { settle, waitFor } from './app';
import { $, $$, BOARD_ROOT, click, editors, key } from './actions';

/** Open a tile's title editor (F2) and type `title` over it, without committing. */
export async function typeTileTitle(tileRoot: HTMLElement, title: string): Promise<void> {
  const titleEl = $(tileRoot, '.tile-title');
  titleEl.focus();
  key(titleEl, 'F2');
  await waitFor(() => document.querySelector('.tile-title-editor .ProseMirror') !== null, 'the title editor');
  const [ed] = editors(document.querySelector('.tile-title-editor') as HTMLElement);
  ed.commands.focus();
  ed.commands.selectAll();
  ed.commands.insertContent(title);
  await settle(20);
}

/** Type `title` over a tile's title, then click away: the commit waits out its blur window. */
export async function typeTileTitleAndClickAway(tileRoot: HTMLElement, title: string): Promise<void> {
  await typeTileTitle(tileRoot, title);
  const [ed] = editors(document.querySelector('.tile-title-editor') as HTMLElement);
  ed.commands.blur();
  (ed.view.dom as HTMLElement).dispatchEvent(new FocusEvent('blur'));
}

/** Pick a Task List smart list tab ("Today", "Upcoming"…), without waiting for its save. */
export async function chooseSmartList(app: CharApp, label: string): Promise<void> {
  const tab = $$(app.el, `${BOARD_ROOT.tasklist} .smart-tabs .tab`).find(
    (b) => (b.querySelector('.label')?.textContent ?? '').trim() === label,
  );
  if (!tab) throw new Error(`no smart list tab "${label}"`);
  click(tab);
  await settle(20);
}

/** Drag the empty mind-map canvas by (dx, dy), without waiting for the camera to be saved. */
export async function panMindMapNow(app: CharApp, dx = 150, dy = 90): Promise<void> {
  const board = $(app.el, BOARD_ROOT.mindmap);
  const opts = (x: number, y: number, buttons = 1): PointerEventInit => ({
    bubbles: true, cancelable: true, button: 0, buttons, pointerId: 1, clientX: x, clientY: y, pointerType: 'mouse', isPrimary: true,
  });
  board.dispatchEvent(new PointerEvent('pointerdown', opts(300, 300)));
  for (let i = 1; i <= 5; i++) {
    const at = opts(300 + (dx * i) / 5, 300 + (dy * i) / 5);
    board.dispatchEvent(new PointerEvent('pointermove', at));
    window.dispatchEvent(new PointerEvent('pointermove', at));
    await settle(10);
  }
  board.dispatchEvent(new PointerEvent('pointerup', opts(300 + dx, 300 + dy, 0)));
  window.dispatchEvent(new PointerEvent('pointerup', opts(300 + dx, 300 + dy, 0)));
  await settle(20);
}

/** Type `text` at the end of the open Document tab's editor, as keystrokes would. */
export async function typeInDocument(app: CharApp, text: string): Promise<void> {
  const root = app.el.querySelector('.document-board') ?? app.el;
  const [ed] = editors(root);
  ed.commands.focus('end');
  ed.commands.insertContent(text);
  await settle(10);
}

/** True while the open Document tab's editor takes keystrokes. */
export function documentEditable(app: CharApp): boolean {
  const [ed] = editors(app.el.querySelector('.document-board') ?? app.el);
  return ed.isEditable;
}

/** The board a `.board.json` holds, parsed. */
export function boardJson(app: CharApp, rel: string): Record<string, unknown> {
  return (JSON.parse(app.read(rel)) as { board: Record<string, unknown> }).board;
}

/** `.filo/viewports.json`, parsed ({} when there is none). */
export function savedViewports(app: CharApp): Record<string, unknown> {
  const p = join(app.root, '.filo', 'viewports.json');
  if (!existsSync(p)) return {};
  return JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>;
}

/** Mind map side toolbar → New Tile → Timer, set to five minutes, then Play. */
export async function addRunningTimer(app: CharApp): Promise<void> {
  const btn = $$(app.el, 'button.side-btn').find((b) => (b.getAttribute('title') ?? '').startsWith('New Tile'));
  if (!btn) throw new Error('no New Tile button');
  click(btn);
  await settle();
  const item = $$(app.el, '.side-dropdown .dropdown-item').find((el) => (el.textContent ?? '').trim() === 'Timer');
  if (!item) throw new Error('New Tile menu has no Timer');
  click(item);
  await waitFor(() => app.el.querySelector('.timer-tile') !== null, 'the timer tile');
  // A new timer is at 0; give it five minutes to count down from.
  (app.el.querySelector('.timer-tile .display') as HTMLElement).click();
  await waitFor(() => app.el.querySelector('.timer-tile .custom-input') !== null, 'the timer time input');
  const input = app.el.querySelector('.timer-tile .custom-input') as HTMLInputElement;
  input.value = '05:00';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  (app.el.querySelector('.timer-tile .apply-btn') as HTMLElement).click();
  await waitFor(() => app.el.querySelector('.timer-tile button[aria-label="Play"]') !== null, 'the timer controls');
  await settle(100);
  const play = app.el.querySelector('.timer-tile button[aria-label="Play"]') as HTMLElement | null;
  if (!play) throw new Error('no Play button on the timer');
  play.click();
  await settle(20);
}

/**
 * The timer tiles a `.board.json` holds, as saved. `left` is the time left
 * now: a running countdown is saved as its wall-clock end.
 */
export function savedTimers(app: CharApp, rel: string): Array<{ remaining: number; isRunning: boolean; left: number }> {
  const out: Array<{ remaining: number; isRunning: boolean; left: number }> = [];
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (o.type === 'timer' && typeof o.remaining === 'number') {
        const isRunning = o.isRunning === true;
        const left = isRunning && typeof o.endsAt === 'number' ? Math.max(0, o.endsAt - Date.now()) : o.remaining;
        out.push({ remaining: o.remaining, isRunning, left });
      } else Object.values(o).forEach(visit);
    }
  };
  visit(JSON.parse(app.read(rel)));
  return out;
}

/**
 * The Mind Map's single-key shortcuts as a user meets them: listed and
 * rebound in Help → Shortcuts (the Mind Map side toolbar's Help), and typed
 * where focus is (the canvas, a tile, a sidebar row).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { settle, waitFor, quiesce, type CharApp } from './app';
import { $, $$, click, closeModal, helpRowLabel, revealInSidebar } from './actions';

/** Help → Shortcuts → click the binding of the row described `description` → press `key`. */
export async function rebindInHelp(app: CharApp, description: string, key: string): Promise<void> {
  click($(app.el, '.side-btn[title="Help"]'));
  await waitFor(() => document.querySelector('.shortcut-row') !== null, 'the shortcuts list');
  const row = $$(document, '.shortcut-row').find((r) => helpRowLabel(r) === description);
  if (!row) throw new Error(`no shortcut row "${description}"`);
  click($(row, '.shortcut-key-btn'));
  await settle();
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  await settle(100);
  await closeModal();
  await quiesce(600);
}

/** The bindings `.filo/hotkeys.json` holds (empty when it doesn't exist). */
export function savedHotkeys(app: CharApp): Record<string, string> {
  const path = join(app.root, '.filo', 'hotkeys.json');
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf-8')) as Record<string, string>) : {};
}

/** Focus the sidebar row of `rel`, as a click or Tab would. */
export async function focusSidebarRow(app: CharApp, rel: string): Promise<void> {
  (await revealInSidebar(app, rel)).focus();
  await settle();
}

/** Click a Mind Map tile's body (selects it; focus goes to the tile). */
export async function selectTile(tileRoot: HTMLElement): Promise<void> {
  const container = tileRoot.closest('.tile-container') as HTMLElement | null ?? tileRoot;
  container.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 1 }));
  container.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, pointerId: 1 }));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, pointerId: 1 }));
  container.focus();
  await settle(50);
}

/** The ids-free view of which Mind Map tiles are selected, by title. */
export function selectedTileTitles(app: CharApp): string[] {
  return $$(app.el, '.mindmap-board .tile-container.selected').map((t) => (t.querySelector('.tile-title')?.textContent ?? '').trim());
}

/** Whether the Mind Map is waiting for a click to finish a connection. */
export function connectionModeOn(app: CharApp): boolean {
  return app.el.querySelector('.mindmap-board.connection-mode') !== null;
}

/** Whether a confirm dialog is open. */
export function confirmOpen(): boolean {
  return document.querySelector('.confirm-dialog') !== null;
}

/** Where each Mind Map tile sits on the canvas, read off its shell's style. */
export function tilePlaces(app: CharApp): Array<{ x: number; y: number; width: number; height: number }> {
  return $$(app.el, '.mindmap-board .tile-shell').map((shell) => {
    const style = shell.getAttribute('style') ?? '';
    const t = /translate\(\s*(-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(style);
    const w = /width:\s*([\d.]+)px/.exec(style);
    const h = /height:\s*([\d.]+)px/.exec(style);
    return { x: Number(t?.[1] ?? NaN), y: Number(t?.[2] ?? NaN), width: Number(w?.[1] ?? NaN), height: Number(h?.[1] ?? NaN) };
  });
}

/** Whether no two Mind Map tiles overlap. */
export function tilesApart(app: CharApp): boolean {
  const places = tilePlaces(app);
  return places.every((a, i) => places.every((b, j) => j <= i
    || a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y));
}

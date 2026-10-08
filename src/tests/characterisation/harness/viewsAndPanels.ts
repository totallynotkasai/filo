/**
 * The Mind Map, Documents and the interface around them as a user meets
 * them: frames folded inside frames, the Waypoints panel, the Document tab's
 * zoom keys, a read-only note's banner and Take ownership, spelling in a
 * task's own fields, a split pane closed over a Raw view, the sidebar's
 * selection and Escape, and a Kanban card's menu and due time. Specs call
 * only these.
 */
import { settle, waitFor, quiesce, type CharApp } from './app';
import { $, $$, chooseMenuItem, click, contextMenu, key } from './actions';

// ── Mind Map ─────────────────────────────────────────────────────────────────

export interface FrameSpec {
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Frames drawn on the open Mind Map, as a user draws them with the side
 * toolbar's Frame and then sizes them (the frame tool takes a drag the
 * harness doesn't make).
 */
export async function drawFrames(frames: readonly FrameSpec[]): Promise<void> {
  const { boardStore } = await import('@renderer/stores/board.svelte');
  const { createFrame } = await import('@renderer/stores/tiles.svelte');
  const boardId = boardStore.current?.id;
  if (!boardId) throw new Error('no board open');
  for (const f of frames) {
    boardStore.addFrame({ ...createFrame({ x: f.x, y: f.y }, boardId), title: f.title, size: { width: f.width, height: f.height } });
  }
  await quiesce(400);
}

function frameByTitle(app: CharApp, title: string): HTMLElement {
  const frame = $$(app.el, '.frame-container').find((f) => (f.querySelector('.frame-title')?.textContent ?? '').trim() === title);
  if (!frame) throw new Error(`no frame "${title}" drawn`);
  return frame;
}

/** The frame's fold button (Collapse / Expand). */
export async function toggleFrameFold(app: CharApp, title: string): Promise<void> {
  click($(frameByTitle(app, title), 'button[aria-label="Collapse frame"], button[aria-label="Expand frame"]'));
  await settle(300);
}

/** The titles of the frames drawn on the canvas. */
export function drawnFrameTitles(app: CharApp): string[] {
  return $$(app.el, '.frame-container').map((f) => (f.querySelector('.frame-title')?.textContent ?? '').trim());
}

/** Whether the minimap's Waypoints panel is shown. */
export function waypointsPanelShown(app: CharApp): boolean {
  return app.el.querySelector('.waypoint-panel') !== null;
}

/** Right-click the empty canvas → Save as waypoint. */
export async function saveWaypointHere(app: CharApp): Promise<void> {
  contextMenu($(app.el, '.mindmap-board'));
  await chooseMenuItem(app, 'Save as waypoint');
  await quiesce(400);
}

// ── Documents ────────────────────────────────────────────────────────────────

/**
 * A zoom key pressed in the open note: Ctrl and `key` on the element that
 * has the caret (the note's text, or the Raw view's).
 */
export async function pressZoomKey(target: Element, k: string, init: KeyboardEventInit = {}): Promise<void> {
  key(target, k, { ctrlKey: true, ...init });
  await settle(50);
}

/** The element the Raw view's text is typed into. */
export function rawViewField(app: CharApp): HTMLElement {
  return $(app.el, '.document-board [data-plain-text-field]');
}

/** The open note's read-only banner, as read (null when none). */
export function readOnlyBanner(app: CharApp): string | null {
  return app.el.querySelector('.document-board .readonly-text')?.textContent ?? null;
}

/** Take ownership → the confirm's text, then Cancel. */
export async function takeOwnershipQuestion(app: CharApp): Promise<string> {
  const button = $$(app.el, '.document-board .readonly-action').find((b) => (b.textContent ?? '').trim() === 'Take ownership');
  if (!button) throw new Error('no Take ownership button');
  click(button);
  await waitFor(() => document.querySelector('.confirm-dialog') !== null, 'the Take ownership question');
  const text = document.querySelector('.confirm-dialog')?.textContent ?? '';
  const cancel = $$(document, '.confirm-dialog button').find((b) => (b.textContent ?? '').trim() === 'Cancel');
  if (cancel) click(cancel);
  await settle();
  return text;
}

// ── Spelling ─────────────────────────────────────────────────────────────────

/**
 * Whether a text field is checked for spelling, as the browser decides: its
 * own `spellcheck`, else its nearest ancestor's, else on.
 */
export function spellCheckedField(el: Element): boolean {
  const holder = el.closest('[spellcheck]');
  return holder ? holder.getAttribute('spellcheck') !== 'false' : true;
}

// ── Panes ────────────────────────────────────────────────────────────────────

/** The close button of the pane at `index` (left to right). */
export async function closePaneAt(app: CharApp, index: number): Promise<void> {
  const pane = $$(app.el, '.pane-view')[index];
  if (!pane) throw new Error(`no pane ${index}`);
  click($(pane, '.pane-close'));
  await settle(200);
}

export function paneCount(app: CharApp): number {
  return $$(app.el, '.pane-view').length;
}

// ── Sidebar ──────────────────────────────────────────────────────────────────

/** Ctrl+click a sidebar row: it joins the sidebar's selection, and takes the focus. */
export async function ctrlClickSidebarRow(row: HTMLElement): Promise<void> {
  row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
  row.focus();
  await settle();
}

export function sidebarSelectionCount(app: CharApp): number {
  return $$(app.el, '.vault-sidebar .vault-file-item.selected').length;
}

// ── Kanban cards ─────────────────────────────────────────────────────────────

/** The card's due chip → the date picker → type `time` in its time box → Enter. */
export async function setCardDueTime(card: HTMLElement, time: string): Promise<void> {
  click($(card, '.card-due'));
  await waitFor(() => document.querySelector('.date-popover .time-input') !== null, 'the time box');
  const input = $(document, '.date-popover .time-input') as HTMLInputElement;
  input.focus();
  input.value = time;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  key(input, 'Enter');
  await quiesce(600);
  key(document.activeElement ?? document.body, 'Escape');
  await settle();
}

/** The card's due chip as shown. */
export function cardDueChip(card: HTMLElement): string {
  return (card.querySelector('.card-due')?.textContent ?? '').trim();
}

/**
 * The interface around the views as a user meets it: the toolbar's Settings
 * button and the saving rule each Settings tab states, the formatting
 * toolbar with nothing to format, the Search panel and Escape, split panes
 * reached with the keyboard, a Mind Map's minimap, links copied from a menu,
 * and the window's width. Specs call only these.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { settle, waitFor, quiesce, type CharApp } from './app';
import { $, $$, chooseMenuItem, click, contextMenu, key, pressShortcut } from './actions';
import { clipboardWrites } from './electronFake';

/** Ctrl+Shift+F where the focus is; waits for the panel. */
export async function openSearchPanel(): Promise<void> {
  pressShortcut('f', { ctrlKey: true, shiftKey: true });
  await waitFor(() => searchPanelOpen(), 'the Search panel');
  await settle();
}

export function searchPanelOpen(): boolean {
  return document.querySelector('.search-panel') !== null;
}

/** Escape on `el` (or wherever the focus is), and the moment after every listener has had it. */
export async function pressEscape(el?: Element): Promise<void> {
  key(el ?? (document.activeElement as HTMLElement | null) ?? document.body, 'Escape');
  await new Promise((r) => setTimeout(r, 20));
  await settle();
}

/** A press and click on the empty Mind Map canvas, which takes the focus. */
export async function clickMindMapCanvas(app: CharApp): Promise<HTMLElement> {
  const canvas = $(app.el, '.mindmap-board');
  canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 1 }));
  canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0, pointerId: 1 }));
  canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  canvas.focus();
  await settle();
  return canvas;
}

/** Right-click on the empty Mind Map canvas, which opens its menu. */
export async function openCanvasMenu(app: CharApp): Promise<void> {
  contextMenu($(app.el, '.mindmap-board'));
  await waitFor(() => document.querySelector('.context-menu') !== null, 'the canvas menu');
}

export function contextMenuOpen(): boolean {
  return document.querySelector('.context-menu') !== null;
}

/** The global toolbar's Settings button; waits for the dialog. */
export async function openSettingsFromToolbar(app: CharApp): Promise<void> {
  click($(app.el, 'header button[aria-label="Settings"]'));
  await waitFor(() => document.getElementById('settings-tabpanel') !== null, 'the Settings dialog');
  await settle();
}

/** Each Settings tab's saving rule, as the bar above its page states it. */
export async function settingsSavingRules(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const tab of $$(document, '[role="tab"].settings-tab')) {
    if ((tab as HTMLButtonElement).disabled) continue;
    click(tab);
    await settle();
    const panel = $(document, '#settings-tabpanel');
    const bar = panel.querySelector('.settings-save-rule, .settings-action-status');
    out[(tab.querySelector('.settings-tab-label')?.textContent ?? '').trim()] = (bar?.textContent ?? '').trim();
  }
  return out;
}

/** The Current Board tab: whether it can be opened, and what its tooltip says. */
export function currentBoardTab(): { enabled: boolean; hint: string } {
  const tab = $(document, '#settings-tab-current-board') as HTMLButtonElement;
  return { enabled: !tab.disabled, hint: tab.getAttribute('title') ?? '' };
}

/** Whether the formatting toolbar's Bold, font and list controls can be pressed. */
export function formattingControlsEnabled(app: CharApp): boolean {
  const controls = [
    'button[title="Bold (Ctrl+B)"]',
    'select[aria-label="Font family"]',
    'button[title="Bulleted List"]',
  ].map((sel) => $(app.el, sel) as HTMLButtonElement | HTMLSelectElement);
  const enabled = controls.filter((c) => !c.disabled).length;
  if (enabled !== 0 && enabled !== controls.length) throw new Error('the formatting controls disagree');
  return enabled === controls.length;
}

/** Whether the toolbar's Spelling button can be pressed. */
export function spellingButtonEnabled(app: CharApp): boolean {
  return !($(app.el, 'button[title="Spelling & Grammar"]') as HTMLButtonElement).disabled;
}

/** Puts the focus on the board in pane `index`, as Tab would (no pointer). */
export async function focusPane(app: CharApp, index: number): Promise<void> {
  const pane = $$(app.el, '.pane-view')[index];
  if (!pane) throw new Error(`no pane ${index}`);
  const target = pane.querySelector<HTMLElement>('.mindmap-board, .kanban-board, .tasklist-board, [tabindex="0"]');
  if (!target) throw new Error(`nothing to focus in pane ${index}`);
  target.focus();
  await settle(50);
}

/** The pane drawn as the active one (with two or more panes). */
export function activePaneIndex(app: CharApp): number {
  return $$(app.el, '.pane-view').findIndex((p) => p.classList.contains('active'));
}

/** The Mind Map side toolbar's minimap button. */
export async function toggleMinimap(app: CharApp): Promise<void> {
  click($(app.el, '.side-btn[title="Toggle Minimap"]'));
  await quiesce(600);
}

export function minimapShown(app: CharApp): boolean {
  return app.el.querySelector('.mindmap-board .minimap-container, .minimap-container') !== null;
}

/** `.filo/workspace.json` as saved (an empty object when there is none). */
export function savedWorkspace(app: CharApp): Record<string, unknown> {
  const path = join(app.root, '.filo', 'workspace.json');
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>) : {};
}

/**
 * The clipboard, as main wrote it for the app: the last copy's text and HTML.
 * Returns the reader and the reset.
 */
export function recordClipboard(): { text(): string | null; html(): string | null; restore(): void } {
  clipboardWrites.length = 0;
  return {
    text: () => clipboardWrites.at(-1)?.text ?? null,
    html: () => clipboardWrites.at(-1)?.html ?? null,
    restore: () => {
      clipboardWrites.length = 0;
    },
  };
}

/** Right-click `target` and pick a "Copy link to …" entry. */
export async function copyLinkFromMenu(app: CharApp, target: Element, label: string): Promise<void> {
  contextMenu(target);
  await settle();
  await chooseMenuItem(app, label);
  await settle(50);
}

/** A click on the link reading `text` in the open note (not being edited: a click follows it). */
export async function followLinkInNote(app: CharApp, text: string): Promise<void> {
  const link = $$(app.el, '.document-board .ProseMirror a').find((a) => (a.textContent ?? '').trim() === text);
  if (!link) throw new Error(`no link "${text}" in the note`);
  link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  await quiesce(600);
}

/** The window is `px` wide, as a resize leaves it. */
export async function setWindowWidth(px: number): Promise<void> {
  Object.defineProperty(window, 'innerWidth', { value: px, configurable: true });
  window.dispatchEvent(new Event('resize'));
  await settle();
}

/** How far the workspace starts from the window's left edge ('' when the sidebar lies over it). */
export function workspacePushedBy(app: CharApp): string {
  return ($(app.el, 'main.workspace') as HTMLElement).style.marginLeft;
}

/** Puts the caret in the open note's text, as a click into it does. */
export async function focusNoteText(app: CharApp): Promise<void> {
  ($(app.el, '.document-board .ProseMirror') as HTMLElement).focus();
  await settle();
}

/** Puts the focus in the Task List's quick-add box. */
export async function focusQuickAdd(app: CharApp): Promise<void> {
  ($(app.el, 'input.quick-add-input') as HTMLInputElement).focus();
  await settle();
}

/** Clicks the tab whose name is `name`. */
export async function showTab(app: CharApp, name: string): Promise<void> {
  const tab = $$(app.el, '.tab[role="tab"]').find((t) => (t.getAttribute('title') ?? '').startsWith(`${name} (`));
  if (!tab) throw new Error(`no tab "${name}"`);
  click(tab);
  await quiesce(400);
}

/** The global toolbar's sidebar button (Hide / Show Sidebar). */
export async function toggleSidebarFromToolbar(app: CharApp): Promise<void> {
  click($(app.el, 'header button[aria-label="Toggle sidebar"]'));
  await settle();
}

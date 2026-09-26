/**
 * What a user does, expressed once. Each action drives the UI the way a click
 * or keypress does (the DOM control where jsdom can drive it, otherwise the
 * handler that control calls). The specs call only these, so when the refactor
 * moves an internal API, only this adapter changes.
 */
import type { Editor } from '@tiptap/core';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { settle, waitFor, quiesce, type CharApp } from './app';

export type BoardKind = 'mindmap' | 'kanban' | 'tasklist';

const NEW_TAB_LABEL: Record<BoardKind, string> = {
  mindmap: 'Mind Map',
  kanban: 'Kanban',
  tasklist: 'Task List',
};

export const BOARD_ROOT: Record<BoardKind, string> = {
  mindmap: '.mindmap-board',
  kanban: '.kanban-board',
  tasklist: '.tasklist-board',
};

// ── DOM helpers ──────────────────────────────────────────────────────────────

export function $(root: ParentNode, sel: string): HTMLElement {
  const el = root.querySelector(sel) as HTMLElement | null;
  if (!el) throw new Error(`no element matches ${sel}`);
  return el;
}

export function $$(root: ParentNode, sel: string): HTMLElement[] {
  return Array.from(root.querySelectorAll(sel)) as HTMLElement[];
}

export function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
  el.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, button: 0 }));
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
}

export function dblclick(el: Element): void {
  click(el);
  el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, button: 0 }));
}

export function contextMenu(el: Element): void {
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 10, clientY: 10 }));
}

export function key(el: Element, k: string, init: KeyboardEventInit = {}): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
  el.dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true, cancelable: true, ...init }));
}

export function typeInto(input: HTMLInputElement, text: string): void {
  input.focus();
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

/** A key chord, delivered like the browser does: to the focused element (or body), bubbling to window. */
export function pressShortcut(k: string, init: KeyboardEventInit = {}): void {
  const target = (document.activeElement as HTMLElement | null) ?? document.body;
  key(target, k, init);
}

/** Pick a context-menu entry by its visible label. */
export async function chooseMenuItem(app: CharApp, label: string): Promise<void> {
  await waitFor(() => findByText(app.el, '.context-menu .menu-item, .context-menu [role="menuitem"]', label) !== null, `menu item "${label}"`);
  click(findByText(app.el, '.context-menu .menu-item, .context-menu [role="menuitem"]', label) as HTMLElement);
  await settle();
}

export function findByText(root: ParentNode, sel: string, text: string): HTMLElement | null {
  return ($$(root, sel).find((e) => (e.textContent ?? '').trim() === text) as HTMLElement | undefined) ?? null;
}

// ── Boards and tabs ──────────────────────────────────────────────────────────

/** New Tab menu → board type. Returns the new board's id. */
export async function createBoard(app: CharApp, kind: BoardKind): Promise<string> {
  const { tabStore } = await import('@renderer/stores/tabs.svelte');
  const before = new Set(tabStore.tabs.map((t) => t.boardId));
  click($(app.el, 'button.new-tab-btn'));
  await settle();
  const option = findByText(app.el, '.new-tab-menu button.new-tab-option', NEW_TAB_LABEL[kind]);
  if (!option) throw new Error(`New Tab menu has no "${NEW_TAB_LABEL[kind]}"`);
  click(option);
  await waitFor(() => tabStore.tabs.some((t) => !before.has(t.boardId) && t.boardType === kind), `new ${kind} tab`);
  const tab = tabStore.tabs.find((t) => !before.has(t.boardId) && t.boardType === kind);
  await waitFor(() => app.el.querySelector(BOARD_ROOT[kind]) !== null, `${kind} board to render`);
  await quiesce(400);
  return tab!.boardId;
}

/** Click the tab of the first open board of `kind`. */
export async function showBoard(app: CharApp, kind: BoardKind): Promise<void> {
  const tab = $$(app.el, '.tab[role="tab"]').find((t) => (t.getAttribute('title') ?? '').includes(`(${kind})`));
  if (!tab) throw new Error(`no ${kind} tab`);
  click(tab);
  await waitFor(() => app.el.querySelector(BOARD_ROOT[kind]) !== null, `${kind} board to show`);
  await settle(200);
}

/** The file row for `rel` in the sidebar (vault-root files are always listed). */
export function sidebarRow(app: CharApp, rel: string): HTMLElement {
  const abs = app.abs(rel);
  const row = $$(app.el, '.file-row').find((b) => b.getAttribute('title') === abs);
  if (!row) throw new Error(`sidebar has no row for ${rel}`);
  return row;
}

/**
 * Expand each collapsed folder above `rel` in the sidebar, then return its row.
 * `timeoutMs` bounds each wait for a row to appear.
 */
export async function revealInSidebar(app: CharApp, rel: string, timeoutMs?: number): Promise<HTMLElement> {
  const parts = rel.split('/');
  for (let i = 1; i < parts.length; i++) {
    const folder = parts.slice(0, i).join('/');
    await waitFor(() => { sidebarRow(app, folder); return true; }, `sidebar folder ${folder}`, timeoutMs);
    const row = sidebarRow(app, folder);
    if (row.getAttribute('aria-expanded') !== 'true') {
      click(row);
      await settle(100);
    }
  }
  await waitFor(() => { sidebarRow(app, rel); return true; }, `sidebar row ${rel}`, timeoutMs);
  return sidebarRow(app, rel);
}

/** Double-click a note in the sidebar → it opens as a Document tab. */
export async function openNoteFromSidebar(app: CharApp, rel: string): Promise<void> {
  dblclick(await revealInSidebar(app, rel));
  await waitFor(() => $$(app.el, '.document-board .ProseMirror').length > 0, `document editor for ${rel}`);
  await settle(200);
}

// ── The note's tag row and raw view (Document tab) ─────────────────────────

/** The tags the open Document tab's tag row shows. */
export function tagRowTags(app: CharApp): string[] {
  return $$(app.el, '.document-board .note-tag .tag-name').map((el) => (el.textContent ?? '').trim());
}

/** Type `text` (comma-separated tags) into the tag row and press Enter. */
export async function typeInTagRow(app: CharApp, text: string): Promise<void> {
  const input = $(app.el, '.document-board .note-tag-input') as HTMLInputElement;
  typeInto(input, text);
  key(input, 'Enter');
  await quiesce(800);
}

/** The x on a tag in the tag row. */
export async function removeFromTagRow(app: CharApp, tag: string): Promise<void> {
  click($(app.el, `.document-board button[aria-label="Remove tag ${tag}"]`));
  await quiesce(800);
}

/** The Raw / Formatted toggle of the open Document tab. */
export async function toggleRawView(app: CharApp): Promise<void> {
  click($(app.el, '.document-board .raw-toggle'));
  await quiesce(600);
}

/** The raw view's text area, once it has loaded. */
export async function rawTextArea(app: CharApp): Promise<HTMLTextAreaElement> {
  await waitFor(() => {
    const ta = app.el.querySelector('.document-board .raw-text') as HTMLTextAreaElement | null;
    return ta !== null && !ta.disabled;
  }, 'raw view text');
  return $(app.el, '.document-board .raw-text') as HTMLTextAreaElement;
}

/** Replace the raw view's text, then leave the field (which saves). */
export async function editRawText(app: CharApp, text: string): Promise<void> {
  const ta = await rawTextArea(app);
  ta.focus();
  ta.value = text;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
  ta.blur();
  await quiesce(800);
}

/** The title and body of the in-app confirm on screen, or '' when none is up. */
export function confirmText(): string {
  const title = document.querySelector('.confirm-dialog .confirm-title')?.textContent ?? '';
  const body = document.querySelector('.confirm-dialog .confirm-body')?.textContent ?? '';
  return `${title}\n${body}`.trim();
}

/** Type into the raw view without leaving the field (so nothing has saved it yet). */
export async function typeInRawView(app: CharApp, text: string): Promise<void> {
  const ta = await rawTextArea(app);
  ta.focus();
  ta.value = text;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
}

/**
 * Click the Raw / Formatted toggle straight from the raw text: the click blurs
 * the field first, which starts a save the toggle then races.
 */
export async function leaveRawFieldAndToggle(app: CharApp): Promise<void> {
  const ta = await rawTextArea(app);
  ta.blur();
  click($(app.el, '.document-board .raw-toggle'));
  await quiesce(800);
}

/** True while the open Document tab shows the raw view. */
export function rawViewShown(app: CharApp): boolean {
  return app.el.querySelector('.document-board .raw-text') !== null;
}

/** The raw view's "the note changed elsewhere" banner. */
export function rawConflictShown(app: CharApp): boolean {
  return app.el.querySelector('.document-board .raw-banner') !== null;
}

/** A button on the raw view's conflict banner. */
export async function chooseRawConflict(app: CharApp, label: 'Show the new version' | 'Keep mine'): Promise<void> {
  const btn = $$(app.el, '.document-board .raw-banner-action').find((b) => (b.textContent ?? '').trim() === label);
  if (!btn) throw new Error(`no raw conflict action "${label}"`);
  click(btn);
  await quiesce(1000);
}

/** Close the active tab from its close button. */
export async function closeActiveTab(app: CharApp): Promise<void> {
  const active = $(app.el, '.tab.active, .tab[aria-selected="true"]');
  const btn = active.querySelector('.tab-close, button[aria-label^="Close"]') as HTMLElement | null;
  if (!btn) throw new Error('active tab has no close button');
  click(btn);
  await quiesce(500);
}

/** The name the active tab shows. */
export function activeTabName(app: CharApp): string {
  const active = $(app.el, '.tab.active, .tab[aria-selected="true"]');
  return (active.getAttribute('title') ?? '').replace(/ \([a-z]+\) — .*$/, '');
}

/** Right-click the active tab → Split Right. */
export async function splitActiveTabRight(app: CharApp): Promise<void> {
  contextMenu($(app.el, '.tab.active, .tab[aria-selected="true"]'));
  await settle();
  await chooseMenuItem(app, 'Split Right');
  await waitFor(() => $$(app.el, '.pane-view').length === 2, 'two panes');
  await settle(200);
}

// ── Drag and drop ────────────────────────────────────────────────────────────

/** A DataTransfer that records what the drag source puts on it. */
class RecordingDataTransfer {
  private data = new Map<string, string>();
  dropEffect = 'none';
  effectAllowed = 'all';
  files: File[] = [];
  items: unknown[] = [];
  get types(): string[] {
    return Array.from(this.data.keys());
  }
  setData(type: string, value: string): void {
    this.data.set(type, value);
  }
  getData(type: string): string {
    return this.data.get(type) ?? '';
  }
  clearData(): void {
    this.data.clear();
  }
  setDragImage(): void {}
}

function dragEvent(type: string, dt: RecordingDataTransfer): Event {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 200, clientY: 200 });
  Object.defineProperty(e, 'dataTransfer', { value: dt });
  return e;
}

/**
 * Drag a note from the sidebar and drop it on `target`: the row's own
 * dragstart fills the payload, the target's own drop handler reads it.
 */
export async function dragFromSidebar(app: CharApp, rel: string, target: Element): Promise<void> {
  const dt = new RecordingDataTransfer();
  const row = await revealInSidebar(app, rel);
  row.dispatchEvent(dragEvent('dragstart', dt));
  target.dispatchEvent(dragEvent('dragenter', dt));
  target.dispatchEvent(dragEvent('dragover', dt));
  target.dispatchEvent(dragEvent('drop', dt));
  row.dispatchEvent(dragEvent('dragend', dt));
  await quiesce(600);
}

// ── Boards: adding notes ─────────────────────────────────────────────────────

/** Paths of `.md` files that appeared since `before`. */
function newNotes(app: CharApp, before: string[]): string[] {
  const had = new Set(before);
  return app.userFiles().filter((f) => f.endsWith('.md') && !had.has(f));
}

/** Mind map side toolbar → New Tile → Text. Returns the new note's path. */
export async function addMindMapTextTile(app: CharApp): Promise<string> {
  const before = app.userFiles();
  const btn = $$(app.el, 'button.side-btn').find((b) => (b.getAttribute('title') ?? '').startsWith('New Tile'));
  if (!btn) throw new Error('no New Tile button');
  click(btn);
  await settle();
  const text = findByText(app.el, '.side-dropdown .dropdown-item', 'Text');
  if (!text) throw new Error('New Tile menu has no Text');
  click(text);
  await waitFor(() => newNotes(app, before).length === 1, 'new tile note on disk');
  await quiesce(400);
  return newNotes(app, before)[0];
}

/** Kanban "Add Column". */
export async function addKanbanColumn(app: CharApp): Promise<void> {
  const n = $$(app.el, '.kanban-column').length;
  click($(app.el, 'button.add-column-btn'));
  await waitFor(() => $$(app.el, '.kanban-column').length === n + 1, 'new column');
  await quiesce(300);
}

/** Kanban column "Add Card" → Text. Returns the new card note's path. */
export async function addKanbanCard(app: CharApp, columnIndex = 0): Promise<string> {
  const before = app.userFiles();
  click($$(app.el, '.kanban-column button.add-tile-btn')[columnIndex]);
  await settle();
  const option = $$(app.el, 'button.kn-option').find((b) => (b.textContent ?? '').trim().startsWith('Text'));
  if (!option) throw new Error('new-card picker has no Text option');
  click(option);
  await waitFor(() => newNotes(app, before).length === 1, 'new card note on disk');
  await quiesce(400);
  return newNotes(app, before)[0];
}

/** Type into the Task List quick-add box and press Enter. Returns the task's note path. */
export async function quickAddTask(app: CharApp, text: string): Promise<string> {
  const before = app.userFiles();
  const input = $(app.el, 'input.quick-add-input') as HTMLInputElement;
  typeInto(input, text);
  key(input, 'Enter');
  await waitFor(() => newNotes(app, before).length === 1, 'new task note on disk');
  await quiesce(400);
  return newNotes(app, before)[0];
}

/** Drop a sidebar note onto the visible board of the given kind. */
export async function placeNoteOnBoard(app: CharApp, kind: BoardKind, rel: string): Promise<void> {
  const target =
    kind === 'kanban' ? $(app.el, '.kanban-column .column-cards-zone')
    : kind === 'tasklist' ? $(app.el, '.tasklist-section')
    : $(app.el, '.mindmap-board');
  await dragFromSidebar(app, rel, target);
}

// ── Reading what the boards show ─────────────────────────────────────────────

export interface CardView {
  el: HTMLElement;
  title: string;
  tags: string[];
  due: string;
  priority: string;
}

function tagNames(root: ParentNode): string[] {
  return $$(root, '.tag-badge .tag-name').map((t) => (t.textContent ?? '').trim().replace(/^#/, ''));
}

/** Every Kanban card on screen. */
export function kanbanCards(app: CharApp): CardView[] {
  return $$(app.el, '.kanban-card-shell').map((el) => ({
    el,
    title: (el.querySelector('.tile-title')?.textContent ?? '').trim(),
    tags: tagNames(el),
    due: (el.querySelector('.card-due')?.textContent ?? '').trim(),
    priority: (el.querySelector('.card-priority:not(.card-priority-empty)')?.textContent ?? '').trim(),
  }));
}

export interface TaskView extends CardView {
  completed: boolean;
}

/** Every Task List row on screen. */
export function taskRows(app: CharApp): TaskView[] {
  return $$(app.el, '.tasklist-row-wrap').map((el) => ({
    el,
    title: (el.querySelector('.task-title')?.textContent ?? '').trim(),
    tags: tagNames(el),
    due: (el.querySelector('.task-due')?.textContent ?? '').trim(),
    priority: (el.querySelector('.task-priority:not(.task-priority-empty)')?.textContent ?? '').trim(),
    completed: el.querySelector('.task-checkbox')?.getAttribute('aria-checked') === 'true',
  }));
}

export interface TileView {
  el: HTMLElement;
  title: string;
  tags: string[];
  text: string;
}

/** Every mind-map tile on screen. */
export function mindMapTiles(app: CharApp): TileView[] {
  return $$(app.el, '.mindmap-board .tile-container').map((el) => ({
    el,
    title: (el.querySelector('.tile-title')?.textContent ?? '').trim(),
    tags: tagNames(el),
    text: (el.querySelector('.ProseMirror')?.textContent ?? '').trim(),
  }));
}

// ── Editing metadata ─────────────────────────────────────────────────────────

/**
 * Focus a tile's title, press F2 (its own hint: "Press F2 or Enter to edit"),
 * replace the text in the inline editor, press Enter. (On a Kanban card a
 * double-click on the title opens the card as a document instead.)
 */
export async function renameTileTitle(tileRoot: HTMLElement, title: string): Promise<void> {
  const titleEl = $(tileRoot, '.tile-title');
  titleEl.focus();
  key(titleEl, 'F2');
  // Only one title is edited at a time; the card may re-render around it.
  await waitFor(() => document.querySelector('.tile-title-editor .ProseMirror') !== null, 'the title editor');
  const host = document.querySelector('.tile-title-editor') as HTMLElement;
  const [ed] = editors(host);
  ed.commands.focus();
  ed.commands.selectAll();
  ed.commands.insertContent(title);
  await settle();
  key(host, 'Enter');
  await quiesce(1200);
}

/** Card due-date button → date input. */
export async function setCardDueDate(card: HTMLElement, isoDate: string): Promise<void> {
  click($(card, '.card-due, .card-due-btn'));
  await settle();
  const input = $(card, '.due-popover input[type="date"]') as HTMLInputElement;
  typeInto(input, isoDate);
  await quiesce(600);
}

/** Card priority button → priority menu entry ("High", "Low", …). */
export async function setCardPriority(app: CharApp, card: HTMLElement, label: string): Promise<void> {
  click($(card, '.card-priority'));
  await settle();
  await chooseMenuItem(app, label);
  await quiesce(600);
}

/** A tile's Tags button → tag editor → type the tag, Enter. */
export async function addTag(app: CharApp, tileRoot: HTMLElement, tag: string): Promise<void> {
  click($(tileRoot, 'button[aria-label="Edit tags"]'));
  await waitFor(() => app.el.querySelector('.tag-editor-popup input') !== null || document.querySelector('.tag-editor-popup input') !== null, 'tag editor');
  const input = (app.el.querySelector('.tag-editor-popup input') ?? document.querySelector('.tag-editor-popup input')) as HTMLInputElement;
  typeInto(input, tag);
  key(input, 'Enter');
  await quiesce(600);
  key(input, 'Escape');
  await settle();
}

/** Click a task's completion checkbox. */
export async function toggleTask(row: HTMLElement): Promise<void> {
  click($(row, '.task-checkbox'));
  await quiesce(600);
}

/** The notes box of a Task List row, once its note button has opened it. */
function taskNotesBox(row: HTMLElement): HTMLTextAreaElement {
  const wrap = row.closest('.tasklist-row-wrap') ?? row;
  return $(wrap, 'textarea.task-notes-textarea') as HTMLTextAreaElement;
}

/** Open a task's notes box with its note button. */
export async function openTaskNotes(row: HTMLElement): Promise<void> {
  click($(row, 'button.task-note-btn'));
  await settle(50);
}

/** The text in a task's open notes box. */
export function taskNotesText(row: HTMLElement): string {
  return taskNotesBox(row).value;
}

/** Whether a task's open notes box refuses typing. */
export function taskNotesReadOnly(row: HTMLElement): boolean {
  return taskNotesBox(row).readOnly;
}

/** Type into a task's open notes box (replacing its text) without leaving it. */
export async function typeTaskNotes(row: HTMLElement, text: string): Promise<void> {
  const box = taskNotesBox(row);
  box.focus();
  box.value = text;
  box.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
}

/** Leave a task's notes box (focus moves elsewhere), which saves what was typed. */
export async function leaveTaskNotes(row: HTMLElement): Promise<void> {
  taskNotesBox(row).blur();
  await quiesce(800);
}

// ── Sidebar ──────────────────────────────────────────────────────────────────

/** Sidebar: right-click a file → Rename → type the new name → Enter. */
export async function renameInSidebar(app: CharApp, rel: string, newName: string): Promise<void> {
  contextMenu(await revealInSidebar(app, rel));
  await settle();
  await chooseMenuItem(app, 'Rename');
  await waitFor(() => app.el.querySelector('input.rename-input') !== null, 'rename input');
  const input = $(app.el, 'input.rename-input') as HTMLInputElement;
  typeInto(input, newName);
  key(input, 'Enter');
  await quiesce(1200);
}

/**
 * Sidebar: right-click a file → Rename → type `newName`, then press Enter.
 * Returns the inline message shown beside the input (`null` when none), and
 * leaves the rename abandoned (Escape) so the next step starts clean.
 */
export async function sidebarRenameMessage(app: CharApp, rel: string, newName: string): Promise<string | null> {
  contextMenu(await revealInSidebar(app, rel));
  await settle();
  await chooseMenuItem(app, 'Rename');
  await waitFor(() => app.el.querySelector('input.rename-input') !== null, 'rename input');
  const input = $(app.el, 'input.rename-input') as HTMLInputElement;
  typeInto(input, newName);
  await settle();
  key(input, 'Enter');
  await settle(100);
  const message = (app.el.querySelector('.rename-problem')?.textContent ?? '').trim() || null;
  const still = app.el.querySelector('input.rename-input');
  if (still) key(still, 'Escape');
  await quiesce(400);
  return message;
}

/** Sidebar: right-click a note → "Rename file to match title". */
export async function renameFileToMatchTitle(app: CharApp, rel: string): Promise<void> {
  contextMenu(await revealInSidebar(app, rel));
  await settle();
  await chooseMenuItem(app, 'Rename file to match title');
  await quiesce(1200);
}

// ── Deleting and undo ────────────────────────────────────────────────────────

/** Answer the open confirm dialog, optionally ticking its extra checkbox first. */
export async function answerConfirm(app: CharApp, opts: { tickExtra?: boolean; confirm: boolean }): Promise<void> {
  await waitFor(() => document.querySelector('.confirm-dialog') !== null, 'confirm dialog');
  const dialog = document.querySelector('.confirm-dialog') as HTMLElement;
  if (opts.tickExtra) {
    const box = $(dialog, '.confirm-extra-option input[type="checkbox"]') as HTMLInputElement;
    box.click();
    await settle();
  }
  click(opts.confirm ? $(dialog, '.confirm-actions .confirm-btn:not(.cancel):not(.secondary)') : $(dialog, '.confirm-btn.cancel'));
  await quiesce(800);
}

/** A tile's Delete button, with "delete the file too" ticked. */
export async function deleteTileAndFile(app: CharApp, tileRoot: HTMLElement): Promise<void> {
  click($(tileRoot, 'button[aria-label="Delete tile"]'));
  await answerConfirm(app, { tickExtra: true, confirm: true });
}

// ── Sidebar delete and Filo's trash ──────────────────────────────────────────

/** Sidebar: right-click a file or folder → Delete → confirm. */
export async function deleteInSidebar(app: CharApp, rel: string): Promise<void> {
  contextMenu(await revealInSidebar(app, rel));
  await settle();
  const folder = findByText(app.el, '.context-menu .menu-item, .context-menu [role="menuitem"]', 'Delete folder');
  await chooseMenuItem(app, folder ? 'Delete folder' : 'Delete file');
  await answerConfirm(app, { confirm: true });
  await quiesce(800);
}

/** The paths things in Filo's trash had, read from disk (`.filo/trash/<id>/manifest.json`). */
export function trashedPaths(app: CharApp): string[] {
  const dir = join(app.root, '.filo', 'trash');
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const id of readdirSync(dir)) {
    const manifest = join(dir, id, 'manifest.json');
    if (!existsSync(manifest)) continue;
    out.push((JSON.parse(readFileSync(manifest, 'utf-8')) as { originalPath: string }).originalPath);
  }
  return out.sort();
}

/** The text of every board file in the vault, read from disk. */
export function boardFilesText(app: CharApp): string[] {
  return app.userFiles().filter((rel) => rel.endsWith('.board.json')).map((rel) => app.read(rel));
}

/** Project menu → Project Settings → Trash. */
export async function openTrashSettings(app: CharApp): Promise<void> {
  const trigger = $$(app.el, 'button.dropdown-trigger').find((b) => b.closest('.global-toolbar, header, nav') !== null) ?? $(app.el, 'button.dropdown-trigger');
  click(trigger);
  await settle();
  const item = $$(document, 'button.dropdown-item').find((b) => (b.textContent ?? '').trim() === 'Project Settings');
  if (!item) throw new Error('no Project Settings item');
  click(item);
  await waitFor(() => $$(document, '.settings-tab').length > 0, 'settings modal');
  const tab = $$(document, '.settings-tab').find((b) => (b.textContent ?? '').includes('Trash'));
  if (!tab) throw new Error('no Trash tab');
  click(tab);
  await waitFor(() => document.querySelector('.trash-settings .trash-list, .trash-settings .empty-text') !== null, 'trash list');
  await quiesce(300);
}

/** Settings → Trash: Restore on the row of the item that was at `rel`. */
export async function restoreFromTrashSettings(rel: string): Promise<void> {
  await waitFor(() => document.querySelector(`button.restore-btn[aria-label="Restore ${rel}"]`) !== null, `trash row for ${rel}`);
  click(document.querySelector(`button.restore-btn[aria-label="Restore ${rel}"]`) as HTMLElement);
  await quiesce(1200);
}

/** Close whatever modal is open. */
export async function closeModal(): Promise<void> {
  const close = document.querySelector('button.modal-close') as HTMLElement | null;
  if (close) click(close);
  await quiesce(300);
}

/** Ctrl+Z with nothing focused (board undo). */
export async function undo(_app: CharApp): Promise<void> {
  (document.activeElement as HTMLElement | null)?.blur?.();
  pressShortcut('z', { ctrlKey: true });
  await quiesce(1000);
}

// ── Tags browser ─────────────────────────────────────────────────────────────

/** Ctrl+Shift+T → Tags browser → Rename on the tag's row → type → Enter. */
export async function renameTagEverywhere(app: CharApp, from: string, to: string): Promise<void> {
  pressShortcut('T', { ctrlKey: true, shiftKey: true });
  await waitFor(() => $$(document, '.tag-row').length > 0, 'tags browser rows');
  const row = $$(document, '.tag-row').find((r) => (r.querySelector('.tag-name')?.textContent ?? '').trim().replace(/^#/, '') === from);
  if (!row) throw new Error(`tags browser has no row for ${from}`);
  click($(row, 'button[aria-label="Rename"], button[title="Rename"]'));
  await waitFor(() => row.querySelector('.col-name input') !== null, 'tag rename input');
  const input = $(row, '.col-name input') as HTMLInputElement;
  typeInto(input, to);
  key(input, 'Enter');
  await quiesce(1500);
}

/** Ctrl+Shift+T → Tags browser → Delete on the tag's row → confirm, then close the browser. */
export async function deleteTagEverywhere(app: CharApp, tag: string): Promise<void> {
  if ($$(document, '.tag-row').length === 0) pressShortcut('T', { ctrlKey: true, shiftKey: true });
  await waitFor(() => $$(document, '.tag-row').length > 0, 'tags browser rows');
  const row = $$(document, '.tag-row').find((r) => (r.querySelector('.tag-name')?.textContent ?? '').trim().replace(/^#/, '') === tag);
  if (!row) throw new Error(`tags browser has no row for ${tag}`);
  click($(row, 'button[aria-label="Delete tag"], button[title="Delete tag"]'));
  await answerConfirm(app, { confirm: true });
  await quiesce(1500);
  await closeModal();
}

/** Ctrl+Shift+T → Tags browser; resolves once it is open. */
export async function openTagsBrowser(): Promise<void> {
  pressShortcut('T', { ctrlKey: true, shiftKey: true });
  await waitFor(() => document.querySelector('.tags-browser') !== null, 'tags browser');
  await settle(50);
}

export function tagsBrowserOpen(): boolean {
  return document.querySelector('.tags-browser') !== null;
}

/** The full tag name of every row the Tags browser shows, top to bottom. */
export function tagsBrowserRows(): string[] {
  return $$(document, '.tag-row .tag-name').map((b) => (b.textContent ?? '').trim());
}

/** The Tags browser's search box (the one that has focus when it opens). */
export function tagsBrowserSearch(): HTMLInputElement {
  return $(document, '.tags-browser input[aria-label="Search tags"]') as HTMLInputElement;
}

export async function searchTagsBrowser(text: string): Promise<void> {
  typeInto(tagsBrowserSearch(), text);
  await settle(50);
}

/** Esc in the Tags browser's search box. */
export async function escInTagsBrowserSearch(): Promise<void> {
  key(tagsBrowserSearch(), 'Escape');
  await settle(100);
}

export function tagsBrowserEmptyText(): string | null {
  return document.querySelector('.tags-browser .empty-state')?.textContent?.trim() ?? null;
}

// ── Sidebar tag filter ───────────────────────────────────────────────────────

/** Vault-relative paths of every row the sidebar shows, top to bottom. */
export function sidebarListing(app: CharApp): string[] {
  const prefix = app.abs('');
  return $$(app.el, '.file-row')
    .map((r) => r.getAttribute('title') ?? '')
    .map((abs) => abs.slice(prefix.length).replace(/^[\\/]+/, '').split(/[\\/]/).join('/'));
}

/** Click the tag chip `tag` on the sidebar row for `rel`. */
export async function clickSidebarTagChip(app: CharApp, rel: string, tag: string): Promise<void> {
  const row = await revealInSidebar(app, rel);
  click($(row, `button[aria-label="Filter by tag ${tag}"]`));
  await settle(50);
}

/** The tag the sidebar is filtered by, as its pill shows it (`#tag`), or null. */
export function sidebarTagFilterPill(app: CharApp): string | null {
  return app.el.querySelector('.tag-filter-pill .tag-filter-name')?.textContent?.trim() ?? null;
}

/** Click the × on the sidebar's tag-filter pill. */
export async function clearSidebarTagFilter(app: CharApp): Promise<void> {
  click($(app.el, '.tag-filter-pill button'));
  await settle(50);
}

function sidebarSearch(app: CharApp): HTMLInputElement {
  return $(app.el, '.search-bar input.search-input') as HTMLInputElement;
}

export async function typeSidebarSearch(app: CharApp, text: string): Promise<void> {
  typeInto(sidebarSearch(app), text);
  await settle(50);
}

/** Esc in the sidebar's search box. */
export async function escInSidebarSearch(app: CharApp): Promise<void> {
  key(sidebarSearch(app), 'Escape');
  await settle(50);
}

/** The message the sidebar shows in place of an empty tree, or null. */
export function sidebarMessage(app: CharApp): string | null {
  return app.el.querySelector('.file-tree .tree-message')?.textContent?.trim() ?? null;
}

// ── Canvas ───────────────────────────────────────────────────────────────────

/** Drag the empty canvas by (dx, dy), then wheel-zoom once. */
export async function panAndZoomMindMap(app: CharApp, dx = 120, dy = 80): Promise<void> {
  const board = $(app.el, '.mindmap-board');
  const opts = (x: number, y: number): PointerEventInit => ({ bubbles: true, cancelable: true, button: 0, buttons: 1, pointerId: 1, clientX: x, clientY: y, pointerType: 'mouse', isPrimary: true });
  board.dispatchEvent(new PointerEvent('pointerdown', opts(300, 300)));
  for (let i = 1; i <= 5; i++) {
    const e = new PointerEvent('pointermove', opts(300 + (dx * i) / 5, 300 + (dy * i) / 5));
    board.dispatchEvent(e);
    window.dispatchEvent(new PointerEvent('pointermove', opts(300 + (dx * i) / 5, 300 + (dy * i) / 5)));
    await settle(20);
  }
  board.dispatchEvent(new PointerEvent('pointerup', { ...opts(300 + dx, 300 + dy), buttons: 0 }));
  window.dispatchEvent(new PointerEvent('pointerup', { ...opts(300 + dx, 300 + dy), buttons: 0 }));
  board.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100, clientX: 300, clientY: 300 }));
  await quiesce(3500);
}

/** The mind map's current camera transform (what the user sees move). */
export function mindMapTransform(app: CharApp): string {
  return ($(app.el, '.mindmap-board .canvas-transform').getAttribute('style') ?? '').trim();
}

// ── Disk-change prompts ──────────────────────────────────────────────────────

/** Labels of the actions on every toast on screen. */
export function toastActions(): string[] {
  return $$(document, '.toast .toast-action').map((b) => (b.textContent ?? '').trim());
}

/** Text of every error toast on screen. */
export function errorToasts(): string[] {
  return $$(document, '.toast')
    .filter((t) => t.querySelector('.toast-icon[aria-label="Error"]') !== null)
    .map((t) => (t.querySelector('.toast-text')?.textContent ?? '').trim());
}

/** Text of every toast on screen. */
export function toastTexts(): string[] {
  return $$(document, '.toast .toast-text').map((t) => (t.textContent ?? '').trim());
}

/** Whether the "recovered from unflushed changes" prompt (shown after a crash) is up. */
export function recoveryPromptShown(): boolean {
  return document.querySelector('.recovery-body') !== null;
}

/** Whether a "the file changed on disk while you were editing" prompt is showing. */
export function diskConflictPrompt(): boolean {
  const labels = toastActions();
  return labels.includes('Reload') && labels.some((l) => /^Keep (local|mine)$/.test(l));
}

/** Answer the disk-conflict prompt with "keep my version". */
export async function keepMine(): Promise<void> {
  await chooseToastAction(toastActions().find((l) => /^Keep (local|mine)$/.test(l)) ?? 'Keep mine');
}

/** Answer the disk-conflict prompt with "reload from disk". */
export async function reloadFromDisk(): Promise<void> {
  await chooseToastAction('Reload');
}

/** Click the toast action labelled `label`. */
export async function chooseToastAction(label: string): Promise<void> {
  const btn = $$(document, '.toast .toast-action').find((b) => (b.textContent ?? '').trim() === label);
  if (!btn) throw new Error(`no toast action "${label}" (have: ${toastActions().join(', ')})`);
  click(btn);
  await quiesce(1000);
}

// ── Editors ──────────────────────────────────────────────────────────────────

export function editors(root: ParentNode): Editor[] {
  return $$(root, '.ProseMirror').map((pm) => {
    const ed = (pm as HTMLElement & { editor?: Editor }).editor;
    if (!ed) throw new Error('ProseMirror element without an editor');
    return ed;
  });
}

/** Type `text` at the end of the editor's document, as keystrokes would. */
export async function typeAtEnd(ed: Editor, text: string): Promise<void> {
  ed.commands.focus('end');
  ed.commands.insertContent(text);
  await settle();
}

/** Put the cursor in the editor's first block, then pick an alignment in the toolbar's Text Align menu. */
export async function alignFirstBlock(app: CharApp, ed: Editor, align: 'left' | 'center' | 'right' | 'justify'): Promise<void> {
  ed.commands.focus('start');
  await settle();
  const select = $(app.el, 'select.align-select') as unknown as HTMLSelectElement;
  select.dispatchEvent(new Event('focus'));
  select.value = align;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
}

/** Put the cursor in the editor's first block, then click the toolbar's Increase Indent button. */
export async function indentFirstBlock(app: CharApp, ed: Editor): Promise<void> {
  ed.commands.focus('start');
  await settle();
  click($(app.el, 'button[aria-label="Increase Indent"]'));
  await settle();
}

/**
 * With the cursor in `ed`, open the toolbar's Line Spacing menu and pick
 * `choice` ("Default", "1", "1.15", "1.5" or "2").
 */
export async function chooseLineSpacing(app: CharApp, ed: Editor, choice: string): Promise<void> {
  ed.commands.focus('start');
  await settle();
  const btn = $$(app.el, 'button.icon-btn').find((b) => (b.getAttribute('aria-label') ?? '').startsWith('Line Spacing'));
  if (!btn) throw new Error('no Line Spacing button');
  if ((btn as HTMLButtonElement).disabled) throw new Error('Line Spacing is disabled');
  click(btn);
  await settle();
  const option = findByText(app.el, '.line-spacing-panel button', choice);
  if (!option) throw new Error(`Line Spacing menu has no "${choice}"`);
  click(option);
  await quiesce(600);
}

/** The line height a view applies to its note, or null when it uses its default. */
export function viewLineSpacing(editorRoot: HTMLElement): string | null {
  const doc = editorRoot.querySelector('.document-editor') as HTMLElement | null;
  if (doc) return doc.style.getPropertyValue('--note-line-height') || null;
  const tile = editorRoot.querySelector('.editor-container') as HTMLElement | null;
  return tile?.style.lineHeight || null;
}

// ── Keyboard shortcuts ───────────────────────────────────────────────────────

/**
 * Key chords that more than one enabled command answers right now, as
 * `"Ctrl+N: tile:new, kanban:new-card"`. The first match wins, so any entry
 * here is a shortcut whose action depends on registration order.
 */
export async function clashingShortcuts(): Promise<string[]> {
  const { getAllShortcuts, formatShortcut } = await import('@renderer/core/hotkeys');
  const byChord = new Map<string, string[]>();
  for (const s of getAllShortcuts()) {
    if (s.enabled && !s.enabled()) continue;
    const chord = formatShortcut(s);
    byChord.set(chord, [...(byChord.get(chord) ?? []), s.commandId ?? s.description]);
  }
  return [...byChord].filter(([, names]) => names.length > 1).map(([chord, names]) => `${chord}: ${names.join(', ')}`);
}

/** Which new-card picker options are showing (Kanban "Add Card" / Ctrl+N). */
export function newCardPickerShown(app: CharApp): boolean {
  return $$(app.el, 'button.kn-option').length > 0;
}

/** Kanban cards grouped by column, by title. */
export function kanbanColumns(app: CharApp): string[][] {
  return $$(app.el, '.kanban-column').map((col) =>
    $$(col, '.kanban-card-shell').map((el) => (el.querySelector('.tile-title')?.textContent ?? '').trim()));
}

// ── Tab menu ─────────────────────────────────────────────────────────────────

/** The labels the active tab's context menu offers. */
export async function activeTabMenuLabels(app: CharApp): Promise<string[]> {
  contextMenu($(app.el, '.tab.active, .tab[aria-selected="true"]'));
  await settle();
  const labels = $$(app.el, '.context-menu .menu-item, .context-menu [role="menuitem"]')
    .map((e) => (e.textContent ?? '').trim())
    .filter(Boolean);
  pressShortcut('Escape');
  await settle();
  return labels;
}

/** Right-click the active tab → Rename Board, type `name`, press Enter. */
export async function renameActiveTab(app: CharApp, name: string): Promise<void> {
  contextMenu($(app.el, '.tab.active, .tab[aria-selected="true"]'));
  await settle();
  await chooseMenuItem(app, 'Rename Board');
  const input = $(app.el, '.tab input') as HTMLInputElement;
  typeInto(input, name);
  key(input, 'Enter');
  await quiesce(600);
}

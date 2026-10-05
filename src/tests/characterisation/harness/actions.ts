/**
 * What a user does, expressed once. Each action drives the UI the way a click
 * or keypress does (the DOM control where jsdom can drive it, otherwise the
 * handler that control calls). The specs call only these, so when the refactor
 * moves an internal API, only this adapter changes.
 */
import type { Editor } from '@tiptap/core';
import { EditorView } from '@codemirror/view';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { osFilePaths } from './mainBridge';
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

/**
 * A right-click as the browser sends it: the press (whose default would
 * focus editable text) and then the `contextmenu`. Returns the labels of
 * Filo's menu, or null when none opened (spell-check's is the app's own).
 */
export async function rightClick(el: Element): Promise<string[] | null> {
  const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 2 });
  el.dispatchEvent(down);
  // The browser's default for the press: focus the editable text under it.
  if (!down.defaultPrevented) (el.closest('[contenteditable="true"]') as HTMLElement | null)?.focus();
  contextMenu(el);
  await settle(50);
  const menu = document.querySelector('.context-menu');
  if (!menu) return null;
  return $$(menu, '[role="menuitem"], .menu-item').map((i) => (i.textContent ?? '').trim()).filter(Boolean);
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

/** Double-click a `.board.json` in the sidebar → its board opens in a tab. */
export async function openBoardFromSidebar(app: CharApp, rel: string, kind: BoardKind): Promise<void> {
  dblclick(await revealInSidebar(app, rel));
  await waitFor(() => app.el.querySelector(BOARD_ROOT[kind]) !== null, `${kind} board for ${rel}`);
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

/**
 * The raw view's text field (a CodeMirror view) once the note has loaded into
 * it, else null. The view's host says `aria-busy="false"` from then on.
 */
function loadedRawField(app: CharApp): EditorView | null {
  const host = app.el.querySelector('.document-board .raw-text');
  if (!host || host.getAttribute('aria-busy') !== 'false') return null;
  const dom = host.querySelector('.cm-editor');
  return dom instanceof HTMLElement ? EditorView.findFromDOM(dom) : null;
}

async function rawField(app: CharApp): Promise<EditorView> {
  await waitFor(() => loadedRawField(app) !== null, 'raw view text');
  return loadedRawField(app) as EditorView;
}

/** The raw view's text, once it has loaded. */
export async function rawText(app: CharApp): Promise<string> {
  return (await rawField(app)).state.doc.toString();
}

/** The raw view's text right now ('' while none is loaded), for a `waitFor`. */
export function rawTextNow(app: CharApp): string {
  return loadedRawField(app)?.state.doc.toString() ?? '';
}

/**
 * Focus the raw view and replace its text, as typing does (a user change, not
 * a reload), staying in the field: nothing saves it yet.
 */
export async function setRawText(app: CharApp, text: string): Promise<void> {
  const view = await rawField(app);
  view.focus();
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, userEvent: 'input.type' });
}

/** Leave the raw view's text field, which starts its save; returns without waiting for it. */
export function leaveRawField(app: CharApp): void {
  const view = loadedRawField(app);
  if (!view) throw new Error('no loaded raw view to leave');
  view.contentDOM.blur();
}

/** Replace the raw view's text, then leave the field (which saves). */
export async function editRawText(app: CharApp, text: string): Promise<void> {
  await setRawText(app, text);
  await settle();
  leaveRawField(app);
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
  await setRawText(app, text);
  await settle();
}

/**
 * Click the Raw / Formatted toggle straight from the raw text: the click blurs
 * the field first, which starts a save the toggle then races.
 */
export async function leaveRawFieldAndToggle(app: CharApp): Promise<void> {
  await rawField(app);
  leaveRawField(app);
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
export async function chooseRawConflict(app: CharApp, label: 'Use the new version (discard mine)' | 'Keep mine'): Promise<void> {
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

/** Every open tab as `Name (kind)`, left to right. */
export function openTabs(app: CharApp): string[] {
  return $$(app.el, '.tab[title]').map((t) => (t.getAttribute('title') ?? '').replace(/ — .*$/, ''));
}

/** The kept tab of a board that couldn't load: its heading, or null when none is shown. */
export function unloadedBoardShown(app: CharApp): string | null {
  return app.el.querySelector('.unloaded-board .unloaded-title')?.textContent?.trim() ?? null;
}

/** The kept tab's Retry, when it is still shown. */
export async function retryUnloadedBoardTab(app: CharApp): Promise<void> {
  const button = app.el.querySelector('.unloaded-board .unloaded-retry') as HTMLButtonElement | null;
  if (button) click(button);
  await quiesce(800);
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
    // A drag carrying files lists `Files`, as the browser's does.
    return [...this.data.keys(), ...(this.files.length > 0 ? ['Files'] : [])];
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
export async function addMindMapTextTile(app: CharApp, opts: NewTitle = {}): Promise<string> {
  const before = app.userFiles();
  const btn = $$(app.el, 'button.side-btn').find((b) => (b.getAttribute('title') ?? '').startsWith('New Tile'));
  if (!btn) throw new Error('no New Tile button');
  click(btn);
  await settle();
  const text = findByText(app.el, '.side-dropdown .dropdown-item', 'Text');
  if (!text) throw new Error('New Tile menu has no Text');
  click(text);
  await waitFor(() => newNotes(app, before).length === 1, 'new tile note on disk');
  await finishNewTitle(app, opts);
  await quiesce(400);
  return newNotes(app, before)[0];
}

/**
 * What to do with the title a new tile or card opens for typing:
 * `title` types it and presses Enter; `keepOpen` leaves the edit open;
 * neither leaves the title as Filo named it (Escape), as most specs aren't
 * about the title.
 */
export interface NewTitle {
  title?: string;
  keepOpen?: boolean;
}

/** The title editor open on a just-made tile or card, if any. */
export function openTitleEditor(app: CharApp): Editor | null {
  const pm = app.el.querySelector('.tile-title-editor .ProseMirror') as (HTMLElement & { editor?: Editor }) | null;
  return pm?.editor ?? null;
}

async function finishNewTitle(app: CharApp, opts: NewTitle): Promise<void> {
  await waitFor(() => openTitleEditor(app) !== null, 'the new title open for typing');
  if (opts.keepOpen) return;
  await settle();
  const ed = openTitleEditor(app);
  if (!ed) return;
  if (opts.title !== undefined) {
    // The whole title is selected: typing replaces it.
    ed.commands.insertContent(opts.title);
    await settle();
  }
  key(ed.view.dom, opts.title !== undefined ? 'Enter' : 'Escape');
  await waitFor(() => openTitleEditor(app) === null, 'the new title edit to end');
}

/** Kanban "Add Column". */
export async function addKanbanColumn(app: CharApp): Promise<void> {
  const n = $$(app.el, '.kanban-column').length;
  click($(app.el, 'button.add-column-btn'));
  await waitFor(() => $$(app.el, '.kanban-column').length === n + 1, 'new column');
  await quiesce(300);
}

/** Kanban column "Add Card" → Text. Returns the new card note's path. */
export async function addKanbanCard(app: CharApp, columnIndex = 0, opts: NewTitle = {}): Promise<string> {
  const before = app.userFiles();
  click($$(app.el, '.kanban-column button.add-tile-btn')[columnIndex]);
  await settle();
  const option = $$(app.el, 'button.kn-option').find((b) => (b.textContent ?? '').trim().startsWith('Text'));
  if (!option) throw new Error('new-card picker has no Text option');
  click(option);
  await waitFor(() => newNotes(app, before).length === 1, 'new card note on disk');
  await finishNewTitle(app, opts);
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

/**
 * Drag `absPath` from Explorer and drop it on the visible board of the given
 * kind: an OS file drop, with the file's bytes and its path on disk (as
 * Electron's `webUtils.getPathForFile` reports it).
 */
export async function dropFromExplorer(app: CharApp, kind: BoardKind, absPath: string): Promise<void> {
  const file = new File([readFileSync(absPath)], basename(absPath), { type: absPath.endsWith('.md') ? 'text/markdown' : '' });
  osFilePaths.set(file, absPath);
  const dt = new RecordingDataTransfer();
  dt.files = [file];
  const target =
    kind === 'kanban' ? $(app.el, '.kanban-column .column-cards-zone')
    : kind === 'tasklist' ? $(app.el, '.tasklist-section')
    : $(app.el, '.mindmap-board');
  target.dispatchEvent(dragEvent('dragenter', dt));
  target.dispatchEvent(dragEvent('dragover', dt));
  target.dispatchEvent(dragEvent('drop', dt));
  await quiesce(800);
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
  await typeTileTitle(tileRoot, title);
  key($(document, '.tile-title-editor'), 'Enter');
  await quiesce(1200);
}

/** As {@link renameTileTitle}, but the edit is left open: no Enter, no click away. */
export async function typeTileTitle(tileRoot: HTMLElement, title: string): Promise<void> {
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
}

/**
 * Card due-date button → the date picker → ‹ / › to the day's month → the
 * day. (The picker is the Task List's, portalled to the page.)
 */
export async function setCardDueDate(card: HTMLElement, isoDate: string): Promise<void> {
  click($(card, '.card-due, .card-due-btn'));
  await waitFor(() => document.querySelector('.date-popover .day-cell') !== null, 'the date picker');
  const day = `.date-popover .day-cell[data-iso="${isoDate}"]`;
  for (let step = 0; step < 240 && !document.querySelector(day); step++) {
    const shown = (document.querySelector('.date-popover .day-cell[tabindex="0"]') as HTMLElement | null)?.dataset.iso ?? '';
    click($(document, `.date-popover .nav-btn[aria-label="${shown.slice(0, 7) < isoDate.slice(0, 7) ? 'Next' : 'Previous'} month"]`));
    await settle();
  }
  click($(document, day));
  await quiesce(600);
}

/** The Task List's date picker is open (from a row's due chip, or D on a row). */
export function datePickerOpen(): boolean {
  return document.querySelector('.date-popover') !== null;
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

/** Focus a Task List row and press Tab (Shift+Tab to outdent). */
export async function indentTask(row: HTMLElement, outdent = false): Promise<void> {
  const item = $(row, '.task-item');
  item.focus();
  key(item, 'Tab', { shiftKey: outdent });
  await quiesce(600);
}

/** A task's context menu → Add subtask. */
export async function addSubtask(app: CharApp, row: HTMLElement): Promise<void> {
  await rightClick(row.querySelector('.task-title') ?? row);
  await chooseMenuItem(app, 'Add subtask');
  await quiesce(400);
}

/** True when the row is shown as a subtask of the row above it. */
export function taskIsSubtask(row: HTMLElement): boolean {
  return row.querySelector('.task-item.is-subtask') !== null;
}

/** Click a task's completion checkbox. */
export async function toggleTask(row: HTMLElement): Promise<void> {
  click($(row, '.task-checkbox'));
  await quiesce(600);
}

/**
 * Tick a task at the first moment its checkbox takes a click (it waits while
 * the task's note hasn't been read yet). Doesn't wait for the save.
 */
export async function tickTaskWhenReady(row: HTMLElement): Promise<void> {
  await waitFor(() => !($(row, '.task-checkbox') as HTMLButtonElement).disabled, 'the task checkbox to take a click', 10000);
  click($(row, '.task-checkbox'));
}

/** Whether a task row shows its fields as still loading (not as blanks). */
export function taskFieldsPending(row: HTMLElement): boolean {
  return row.querySelector('.task-item-wrap.fields-pending') !== null;
}

/** The fill colour a ticked task's checkbox is painted with ('' when none). */
export function taskCheckboxFill(row: HTMLElement): string {
  return $(row, '.task-checkbox').style.backgroundColor;
}

/** The fill colour of the Task List progress bar ('' when none). */
export function taskProgressFill(app: CharApp): string {
  return $(app.el, '.tasklist-progress-bar .progress-fill').style.backgroundColor;
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

/** Press Escape in a task's open notes box. */
export async function escapeTaskNotes(row: HTMLElement): Promise<void> {
  key(taskNotesBox(row), 'Escape');
  await settle();
}

/** Whether a task's notes box is open. */
export function taskNotesOpen(row: HTMLElement): boolean {
  const wrap = row.closest('.tasklist-row-wrap') ?? row;
  return wrap.querySelector('textarea.task-notes-textarea') !== null;
}

/** Double-click a task's title, which opens it for typing (the box takes focus, as `autofocus` gives it). */
export async function startTaskTitleEdit(row: HTMLElement): Promise<void> {
  dblclick($(row, '.task-title'));
  await waitFor(() => row.querySelector('input.task-title-input') !== null, 'the task title box');
  const input = row.querySelector('input.task-title-input') as HTMLInputElement;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  await settle();
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

/**
 * Board Browser → the board's Delete button → confirm. Adapter knowledge:
 * the browser opens through `uiStore.openModal('board-browser')`.
 */
export async function deleteBoardInBrowser(app: CharApp, name: string): Promise<void> {
  const { uiStore } = await import('@renderer/stores/ui.svelte');
  uiStore.openModal('board-browser');
  // Inside the browser: a board's own folder in the sidebar has a "Delete <name>" button too.
  const button = `.board-browser-panel button[aria-label="Delete ${name}"]`;
  await waitFor(() => document.querySelector(button) !== null, `Delete ${name} in the Board Browser`);
  click($(document, button));
  await answerConfirm(app, { confirm: true });
  if (document.querySelector('.modal')) uiStore.closeModal();
  await quiesce(800);
}

/**
 * Enter in the Board Browser on a board's row, or on its Rename / Delete
 * button (focused first). Opens the browser if it isn't open.
 */
export async function enterInBoardBrowser(boardId: string, on: 'row' | 'rename' | 'delete'): Promise<void> {
  const { uiStore } = await import('@renderer/stores/ui.svelte');
  if (!boardBrowserOpen()) uiStore.openModal('board-browser');
  await waitFor(() => document.querySelector(`.board-row[data-board-id="${boardId}"]`) !== null, 'the board in the Board Browser');
  const row = $(document, `.board-row[data-board-id="${boardId}"]`) as HTMLElement;
  const target = on === 'row' ? row : ($(row, on === 'rename' ? 'button.board-rename' : 'button.board-delete') as HTMLElement);
  target.focus();
  key(target, 'Enter');
  await quiesce(300);
}

export function boardBrowserOpen(): boolean {
  return document.querySelector('.board-browser-panel') !== null;
}

/** A tile's Delete button, with "delete the file too" ticked. */
export async function deleteTileAndFile(app: CharApp, tileRoot: HTMLElement): Promise<void> {
  click($(tileRoot, 'button[aria-label="Delete tile"]'));
  await answerConfirm(app, { tickExtra: true, confirm: true });
}

// ── Sidebar delete and Filo's trash ──────────────────────────────────────────

/** Sidebar: right-click a file or folder → Delete from vault… → confirm. */
export async function deleteInSidebar(app: CharApp, rel: string): Promise<void> {
  contextMenu(await revealInSidebar(app, rel));
  await settle();
  await chooseMenuItem(app, 'Delete from vault…');
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

/** Vault menu → Settings → Trash. */
export async function openTrashSettings(app: CharApp): Promise<void> {
  const trigger = $$(app.el, 'button.dropdown-trigger').find((b) => b.closest('.global-toolbar, header, nav') !== null) ?? $(app.el, 'button.dropdown-trigger');
  click(trigger);
  await settle();
  const item = $$(document, 'button.dropdown-item').find((b) => (b.textContent ?? '').trim() === 'Settings');
  if (!item) throw new Error('no Settings item');
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

/** True while the toolbar's Undo button is enabled (the active board or tab has a step to undo). */
export function undoAvailable(app: CharApp): boolean {
  const button = $$(app.el, 'button[aria-label="Undo"]')[0] as HTMLButtonElement | undefined;
  return button !== undefined && !button.disabled;
}

/** The toolbar's Undo button: its label, and a click on it (focus stays where it is). */
export function toolbarUndoLabel(app: CharApp): string {
  const button = $$(app.el, 'button[aria-label^="Undo"]')[0];
  return button?.getAttribute('aria-label') ?? '';
}

export async function clickToolbarUndo(app: CharApp): Promise<void> {
  const button = $$(app.el, 'button[aria-label^="Undo"]')[0] as HTMLButtonElement | undefined;
  if (!button) throw new Error('no toolbar Undo button');
  button.click();
  await settle();
}

/** Ctrl+Y with nothing focused (board redo). */
export async function redo(_app: CharApp): Promise<void> {
  (document.activeElement as HTMLElement | null)?.blur?.();
  pressShortcut('y', { ctrlKey: true });
  await quiesce(1000);
}

// ── Tags browser ─────────────────────────────────────────────────────────────

/** Ctrl+Shift+T → Tags browser → Rename on the tag's row → type → Enter. */
export async function renameTagEverywhere(app: CharApp, from: string, to: string): Promise<void> {
  pressShortcut('T', { ctrlKey: true, shiftKey: true });
  await waitFor(() => $$(document, '.tag-row').length > 0, 'tags browser rows');
  const row = $$(document, '.tag-row').find((r) => (r.querySelector('.tag-name')?.textContent ?? '').trim().replace(/^#/, '') === from);
  if (!row) throw new Error(`tags browser has no row for ${from}`);
  // Rename and Delete wait for the note index a vault open builds.
  await waitFor(() => !($(row, 'button[aria-label="Rename"]') as HTMLButtonElement).disabled, 'the Rename action (index built)');
  click($(row, 'button[aria-label="Rename"]'));
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
  await waitFor(() => !($(row, 'button[aria-label="Delete tag"]') as HTMLButtonElement).disabled, 'the Delete action (index built)');
  click($(row, 'button[aria-label="Delete tag"]'));
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

/** Click a tag's name in the Tags browser (opens its popup of tiles and files). */
export async function clickTagInTagsBrowser(tag: string): Promise<void> {
  const btn = $$(document, '.tags-browser .tag-row button.tag-name').find((b) => b.getAttribute('aria-label') === tag);
  if (!btn) throw new Error(`Tags browser has no tag ${tag}`);
  click(btn);
  await settle(100);
}

/** The open tag popup's items by section, or null when no popup is shown. */
export function tagPopupItems(): { tiles: string[]; files: string[] } | null {
  const popup = document.querySelector('.tags-popup');
  if (!popup) return null;
  const tiles: string[] = [];
  const files: string[] = [];
  let section: string[] | null = null;
  for (const el of Array.from(popup.querySelectorAll('.section-header, .tile-item'))) {
    if (el.classList.contains('section-header')) {
      section = (el.textContent ?? '').trim() === 'Tiles' ? tiles : files;
    } else {
      section?.push((el.querySelector('.tile-title')?.textContent ?? '').trim());
    }
  }
  return { tiles, files };
}

/** Click an item (tile or file) in the open tag popup by the title it shows. */
export async function clickTagPopupItem(title: string): Promise<void> {
  const item = $$(document, '.tags-popup .tile-item').find(
    (b) => (b.querySelector('.tile-title')?.textContent ?? '').trim() === title,
  );
  if (!item) throw new Error(`tag popup has no item "${title}"`);
  click(item);
  await settle(400);
}

/** The board type the active tab shows (`mindmap`, `kanban`, `tasklist`, `document`). */
export function activeTabKind(app: CharApp): string {
  const active = $(app.el, '.tab.active, .tab[aria-selected="true"]');
  return /\(([a-z]+)\)/.exec(active.getAttribute('title') ?? '')?.[1] ?? '';
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

/** The sidebar toolbar's New → New folder; resolves once a rename box shows (or after a wait). */
export async function clickSidebarNewFolder(app: CharApp): Promise<void> {
  click($(app.el, '.sidebar-actions button[aria-label="New note or folder"]'));
  await settle();
  await chooseMenuItem(app, 'New folder');
  await quiesce(300);
}

/** The text in the sidebar's rename box, or null when no row is being renamed. */
export function sidebarRenameValue(app: CharApp): string | null {
  const input = app.el.querySelector('.vault-file-item .rename-input') as HTMLInputElement | null;
  return input ? input.value : null;
}

/** The sidebar toolbar's Expand / Collapse All button's label ("Expand All" or "Collapse All"). */
export function sidebarExpandCollapseLabel(app: CharApp): string {
  return $(app.el, '.sidebar-actions button[aria-label$="all folders"]').getAttribute('title') ?? '';
}

/** Click the sidebar toolbar's Expand / Collapse All button. */
export async function clickSidebarExpandCollapse(app: CharApp): Promise<void> {
  click($(app.el, '.sidebar-actions button[aria-label$="all folders"]'));
  await settle(50);
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

/**
 * A click on empty mind map canvas. The press focuses the canvas (it is
 * focusable), as the browser does, so whatever had focus loses it.
 */
export async function clickEmptyCanvas(app: CharApp): Promise<void> {
  const board = $(app.el, '.mindmap-board');
  const opts = { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: 5, clientY: 5, pointerType: 'mouse', isPrimary: true };
  board.dispatchEvent(new PointerEvent('pointerdown', { ...opts, buttons: 1 }));
  const down = new MouseEvent('mousedown', opts);
  board.dispatchEvent(down);
  if (!down.defaultPrevented) board.focus();
  board.dispatchEvent(new PointerEvent('pointerup', opts));
  window.dispatchEvent(new PointerEvent('pointerup', opts));
  board.dispatchEvent(new MouseEvent('mouseup', opts));
  board.dispatchEvent(new MouseEvent('click', opts));
  await settle(50);
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

/** Clicks the formatting toolbar's Spelling button. */
export async function toggleSpellCheck(app: CharApp): Promise<void> {
  click($(app.el, 'button[aria-label="Spelling & Grammar"]'));
  await settle();
}

/** Whether the toolbar's Spelling button shows spell check on. */
export function spellCheckButtonOn(app: CharApp): boolean {
  return $(app.el, 'button[aria-label="Spelling & Grammar"]').getAttribute('aria-pressed') === 'true';
}

/** Whether the browser checks spelling in `ed`'s text. */
export function spellCheckedIn(ed: Editor): boolean {
  return ed.view.dom.getAttribute('spellcheck') === 'true';
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

/** Put the caret right after the first `text` in the editor. */
export async function caretAfter(ed: Editor, text: string): Promise<void> {
  let pos = -1;
  ed.state.doc.descendants((node, p) => {
    if (pos >= 0) return false;
    if (node.isText && node.text?.includes(text)) pos = p + node.text.indexOf(text) + text.length;
    return true;
  });
  if (pos < 0) throw new Error(`no "${text}" in the note`);
  ed.commands.focus();
  ed.commands.setTextSelection(pos);
  await settle();
}

/** A key press in the editor (Enter, or a shortcut such as Ctrl+Shift+9), as the keyboard sends it. */
export async function pressInEditor(ed: Editor, k: string, init: KeyboardEventInit = {}): Promise<void> {
  const event = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  ed.view.someProp('handleKeyDown', (f) => f(ed.view, event));
  await settle();
}

/** Type `text` at the caret one key at a time, so typing shortcuts (`[ ] `, `- `) fire. */
export async function typeKeys(ed: Editor, text: string): Promise<void> {
  for (const ch of text) {
    const { from, to } = ed.state.selection;
    const handled = ed.view.someProp('handleTextInput', (f) => f(ed.view, from, to, ch, () => ed.state.tr.insertText(ch, from, to)));
    if (!handled) ed.view.dispatch(ed.state.tr.insertText(ch, from, to));
  }
  await settle();
}

/** Click away from the editor (it loses focus, which saves what it holds). */
export async function leaveEditor(ed: Editor): Promise<void> {
  ed.commands.blur();
  (ed.view.dom as HTMLElement).dispatchEvent(new FocusEvent('blur'));
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
 * With the cursor in `ed`, pick `choice` in the toolbar's Line Spacing select
 * ("Default", or a spacing such as "1", "1.15" or "2").
 */
export async function chooseLineSpacing(app: CharApp, ed: Editor, choice: string): Promise<void> {
  ed.commands.focus('start');
  await settle();
  const select = $(app.el, 'select.line-spacing-select') as unknown as HTMLSelectElement;
  if (select.disabled) throw new Error('Line Spacing is disabled');
  // "Default" is the option labelled "Default (1.5)"; a number matches by value, so "2" picks "2.0".
  const option = [...select.options].find((o) =>
    choice === 'Default' ? (o.textContent ?? '').startsWith('Default') : Number(o.value) === Number(choice));
  if (!option) throw new Error(`Line Spacing has no "${choice}"`);
  select.dispatchEvent(new Event('focus'));
  select.value = option.value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await quiesce(600);
}

/** The label of the toolbar's Line Spacing select as shown ("Default (1.5)", "2.0"). */
export function toolbarLineSpacingLabel(app: CharApp): string {
  const select = $(app.el, 'select.line-spacing-select') as unknown as HTMLSelectElement;
  return (select.selectedOptions[0]?.textContent ?? '').trim();
}

/** Vault menu → Settings → General → Default line spacing, then close the dialog. */
export async function setDefaultLineSpacing(app: CharApp, value: string): Promise<void> {
  const trigger = $$(app.el, 'button.dropdown-trigger').find((b) => b.closest('.global-toolbar, header, nav') !== null) ?? $(app.el, 'button.dropdown-trigger');
  click(trigger);
  await settle();
  const item = $$(document, 'button.dropdown-item').find((b) => (b.textContent ?? '').trim() === 'Settings');
  if (!item) throw new Error('no Settings item');
  click(item);
  await waitFor(() => document.querySelector('#default-line-spacing') !== null, 'General settings');
  const select = document.querySelector('#default-line-spacing') as HTMLSelectElement;
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await quiesce(300);
  await closeModal();
}

/** The line height a view applies to its note (null only if it sets none). */
export function viewLineSpacing(editorRoot: HTMLElement): string | null {
  const doc = editorRoot.querySelector('.document-editor') as HTMLElement | null;
  if (doc) return doc.style.getPropertyValue('--note-line-height') || null;
  const tile = editorRoot.querySelector('.editor-container') as HTMLElement | null;
  return tile?.style.lineHeight || null;
}

// ── Keyboard shortcuts ───────────────────────────────────────────────────────

/** Click the toolbar's Home button (the vault stays open behind it). */
export async function goHome(app: CharApp): Promise<void> {
  click($(app.el, 'button[aria-label="Home screen"]'));
  await settle(100);
}

export function homeShown(app: CharApp): boolean {
  return app.el.querySelector('.home-screen') !== null;
}

/** The title of the open modal dialog, or null when none is open. */
export function openModalTitle(): string | null {
  return document.querySelector('.modal-title')?.textContent?.trim() ?? null;
}

/**
 * The Mind Map side toolbar's Help → Shortcuts list, as "label: keys" rows,
 * then close it again.
 */
export async function shortcutsListed(app: CharApp): Promise<string[]> {
  click($(app.el, '.side-btn[title="Help"]'));
  await waitFor(() => document.querySelector('.shortcut-row') !== null, 'the shortcuts list');
  const rows = $$(document, '.shortcut-row').map((r) =>
    `${(r.querySelector('.shortcut-desc')?.textContent ?? '').trim()}: ${(r.querySelector('.shortcut-key-btn, .shortcut-key')?.textContent ?? '').trim()}`);
  await closeModal();
  return rows;
}

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

/** A plain click (press and release, no movement) on a Kanban card, off its text. */
export async function clickKanbanCard(card: CardView): Promise<void> {
  click(card.el.closest('.tile-drop-zone') ?? card.el);
  await quiesce(100);
}

/** Each Kanban column's card-count badge. */
export function kanbanColumnCounts(app: CharApp): number[] {
  return $$(app.el, '.kanban-column .column-count').map((el) => parseInt(el.textContent ?? '', 10));
}

/** Kanban columns still styled as mid-drag. */
export function kanbanColumnsDragActive(app: CharApp): number {
  return $$(app.el, '.kanban-column.drag-active').length;
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

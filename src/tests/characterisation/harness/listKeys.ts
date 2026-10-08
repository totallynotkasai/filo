/**
 * The Kanban and Task List keyboard as a user meets it: cards and rows
 * focused and moved with keys, the menu key on a card, a column collapsed,
 * the find bar, the Table of Contents. Specs call only these.
 */
import { settle, waitFor, quiesce, type CharApp } from './app';
import { $, $$, click, key, typeInto } from './actions';

// ── Kanban ───────────────────────────────────────────────────────────────────

/** The card element (the one that takes focus) of the card titled `title`. */
export function cardByTitle(app: CharApp, title: string): HTMLElement {
  const zone = $$(app.el, '.tile-drop-zone').find((z) => (z.querySelector('.tile-title')?.textContent ?? '').trim() === title);
  if (!zone) throw new Error(`no card "${title}"`);
  return zone;
}

/** The titles of the cards drawn, column by column. */
export function drawnCardTitles(app: CharApp): string[] {
  return $$(app.el, '.tile-drop-zone').map((z) => (z.querySelector('.tile-title')?.textContent ?? '').trim());
}

/** The titles of the selected cards, as drawn (a hidden one has no title on screen: its id). */
export function selectedCardTitles(app: CharApp): string[] {
  return $$(app.el, '.tile-drop-zone.selected').map((z) => (z.querySelector('.tile-title')?.textContent ?? '').trim());
}

/** How many cards are selected, drawn or not, as the selection's menu counts them. */
export async function selectedCardCount(app: CharApp, anyCard: string): Promise<string> {
  cardByTitle(app, anyCard).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 10, clientY: 10 }));
  await settle(50);
  const heading = document.querySelector('.context-menu')?.textContent ?? '';
  key(document.activeElement ?? document.body, 'Escape');
  await settle();
  return heading;
}

/** Click a card (Shift held for a range). */
export async function clickCard(app: CharApp, title: string, opts: { shift?: boolean } = {}): Promise<void> {
  cardByTitle(app, title).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: opts.shift ?? false }));
  await settle();
}

/** A column's collapse button. */
export async function collapseKanbanColumn(app: CharApp, index: number): Promise<void> {
  const column = $$(app.el, '.kanban-column')[index];
  if (!column) throw new Error(`no column ${index}`);
  click($(column, 'button[aria-label="Collapse column"]'));
  await quiesce(300);
}

/** Focus on the board itself, as a click on its background gives. */
export async function focusKanbanBoard(app: CharApp): Promise<HTMLElement> {
  const board = $(app.el, '.kanban-board');
  board.focus();
  await settle();
  return board;
}

/** "/" on the board, then type `query` into the find bar. */
export async function findOnKanban(app: CharApp, query: string): Promise<void> {
  key(await focusKanbanBoard(app), '/');
  await waitFor(() => app.el.querySelector('.kanban-find-bar input') !== null, 'the find bar');
  typeInto(app.el.querySelector('.kanban-find-bar input') as HTMLInputElement, query);
  await settle(300);
}

/** New card on a column → Text, and leave its title open (it opens by itself). */
export async function startKanbanCard(app: CharApp, columnIndex = 0): Promise<void> {
  click($$(app.el, '.kanban-column button.add-tile-btn')[columnIndex] as HTMLElement);
  await settle();
  const option = $$(app.el, 'button.kn-option').find((b) => (b.textContent ?? '').trim().startsWith('Text'));
  if (!option) throw new Error('new-card picker has no Text option');
  click(option);
}

/** The menu key on the focused element: the browser sends `contextmenu` there. */
export async function pressMenuKey(): Promise<string[]> {
  const focused = (document.activeElement as HTMLElement | null) ?? document.body;
  focused.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await settle(50);
  const menu = document.querySelector('.context-menu');
  return menu ? $$(menu, '[role="menuitem"], .menu-item').map((i) => (i.textContent ?? '').trim()).filter(Boolean) : [];
}

/** The title of the card the keyboard focus is on, or null. */
export function focusedCardTitle(): string | null {
  const zone = (document.activeElement as HTMLElement | null)?.closest('.tile-drop-zone');
  return zone ? (zone.querySelector('.tile-title')?.textContent ?? '').trim() : null;
}

/** The titles of the cards in column `index`, top to bottom. */
export function columnCardTitles(app: CharApp, index: number): string[] {
  const column = $$(app.el, '.kanban-column')[index];
  if (!column) throw new Error(`no column ${index}`);
  return $$(column, '.tile-drop-zone').map((z) => (z.querySelector('.tile-title')?.textContent ?? '').trim());
}

/** The cards the Tab key stops on (every card is focusable; only these are in the Tab order). */
export function tabbableCards(app: CharApp): string[] {
  return $$(app.el, '.tile-drop-zone').filter((z) => z.tabIndex === 0).map((z) => (z.querySelector('.tile-title')?.textContent ?? '').trim());
}

/**
 * The drag zones and drag wrappers Tab would stop on (a Task List's section
 * list, sections, row zones and row wrappers; a Kanban board's column list
 * and column wrappers), by class. None of them does anything there.
 */
export function dragWrapperTabStops(app: CharApp): string[] {
  const zones = $$(app.el, '.tasklist-section-dnd, .row-dnd-zone, .kanban-columns');
  const wrappers = zones.flatMap((z) => Array.from(z.children) as HTMLElement[]);
  return [...zones, ...wrappers].filter((el) => el.tabIndex === 0).map((el) => el.className.split(' ')[0] ?? el.tagName);
}

/** Adds a section to the Task List from its Add section button. */
export async function addTaskListSection(app: CharApp): Promise<void> {
  const before = $$(app.el, '.tasklist-section').length;
  click($(app.el, '.add-section-btn'));
  await waitFor(() => $$(app.el, '.tasklist-section').length > before, 'a new section');
  await settle();
}

// ── Task List ────────────────────────────────────────────────────────────────

/** The `.task-item` (the row that takes focus) of the task titled `title`. */
export function taskItem(app: CharApp, title: string): HTMLElement {
  const wrap = $$(app.el, '.tasklist-row-wrap').find((w) => (w.querySelector('.task-title')?.textContent ?? '').trim() === title);
  if (!wrap) throw new Error(`no task "${title}"`);
  return $(wrap, '.task-item');
}

/** The task titles as drawn, a subtask indented by two spaces per level. */
export function drawnTasks(app: CharApp): string[] {
  return $$(app.el, '.tasklist-row-wrap').map((w) => {
    const title = (w.querySelector('.task-title')?.textContent ?? '').trim();
    const depth = Number((w.querySelector('.task-item-wrap') as HTMLElement | null)?.style.getPropertyValue('--task-depth') || 0);
    return `${'  '.repeat(depth)}${title}`;
  });
}

/** Focus a task row and press `k` there (with modifiers), as the keyboard does. Returns whether the key was taken. */
export async function pressOnTask(app: CharApp, title: string, k: string, init: KeyboardEventInit = {}): Promise<boolean> {
  const item = taskItem(app, title);
  item.focus();
  const down = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  item.dispatchEvent(down);
  item.dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true, cancelable: true, ...init }));
  await quiesce(500);
  return down.defaultPrevented;
}

/** The title of the task the keyboard focus is on, or null. */
export function focusedTaskTitle(): string | null {
  const wrap = (document.activeElement as HTMLElement | null)?.closest('.tasklist-row-wrap');
  return wrap ? (wrap.querySelector('.task-title')?.textContent ?? '').trim() : null;
}

/** The Table of Contents panel: folded to its header, or open. */
export function tocState(app: CharApp): 'folded' | 'open' | 'none' {
  const panel = app.el.querySelector('.floating-toc-panel');
  if (!panel) return 'none';
  return panel.querySelector('.floating-toc-body') ? 'open' : 'folded';
}

/** The Table of Contents' fold button. */
export async function toggleToc(app: CharApp): Promise<void> {
  click($(app.el, '.floating-toc-panel .floating-toc-fold'));
  await quiesce(500);
}

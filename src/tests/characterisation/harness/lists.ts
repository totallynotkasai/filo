/**
 * What a user does on a Task List or a Kanban board beyond adding and
 * editing: select rows by click, Shift and the keyboard, delete them in bulk,
 * group, filter, fold a section, use the date picker and the Repeat menu,
 * move a card. Specs call only these.
 */
import { $, $$, chooseMenuItem, click, key, taskRows } from './actions';
import { settle, waitFor, quiesce, type CharApp } from './app';

/** Clicks a Task List row's body, with Shift or Ctrl held as asked. */
export async function clickTaskRow(row: HTMLElement, mods: { shift?: boolean; ctrl?: boolean } = {}): Promise<void> {
  const item = $(row, '.task-item');
  item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: !!mods.shift, ctrlKey: !!mods.ctrl }));
  await settle();
}

/** The titles of the rows shown selected, top to bottom. */
export function selectedTaskTitles(app: CharApp): string[] {
  return taskRows(app).filter((r) => r.el.querySelector('.task-item-wrap.selected')).map((r) => r.title);
}

/** The bulk bar's Delete, then the confirm's Delete. */
export async function bulkDeleteTasks(): Promise<void> {
  const bar = $(document, '.bulk-bar');
  click([...bar.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Delete') as HTMLElement);
  await waitFor(() => document.querySelector('.confirm-dialog') !== null, 'the delete confirm');
  click($(document, '.confirm-dialog .confirm-actions .confirm-btn:not(.cancel):not(.secondary)'));
  await quiesce(800);
}

/** Focuses a row and presses a key there (its own keys: 1-4 priority, D the date picker, arrows). */
export async function keyOnTaskRow(row: HTMLElement, k: string, init: KeyboardEventInit = {}): Promise<void> {
  const item = $(row, '.task-item');
  item.focus();
  key(item, k, init);
  await settle();
}

/** The title of the row that has keyboard focus. */
export function focusedTaskTitle(): string | null {
  const row = (document.activeElement as HTMLElement | null)?.closest('.tasklist-row-wrap');
  return row ? (row.querySelector('.task-title')?.textContent ?? '').trim() : null;
}

/** The side toolbar's Group By → an entry ("Status", "Priority", "None" …). */
export async function chooseTaskGroupBy(app: CharApp, label: string): Promise<void> {
  click($(app.el, '.toolbar-btn[aria-label="Group by"]'));
  await settle();
  const item = [...document.querySelectorAll<HTMLElement>('.toolbar-menu .toolbar-menu-item')].find((b) => b.textContent?.trim() === label);
  if (!item) throw new Error(`no Group By entry "${label}"`);
  click(item);
  await quiesce(400);
}

/** The Group By button is pressable. */
export function taskGroupByEnabled(app: CharApp): boolean {
  return !($(app.el, '.toolbar-btn[aria-label="Group by"]') as HTMLButtonElement).disabled;
}

/** The side toolbar's Filter → a chip under "Filter by Status" (its label as shown). */
export async function filterTasksByStatus(app: CharApp, label: string): Promise<void> {
  click($(app.el, '.toolbar-btn[aria-label^="Filter"]'));
  await settle();
  const title = [...document.querySelectorAll('.toolbar-menu-section-title')].find((t) => t.textContent?.trim() === 'Filter by Status');
  const row = title?.nextElementSibling;
  const chip = row ? [...row.querySelectorAll<HTMLElement>('.filter-chip')].find((c) => c.textContent?.trim() === label) : undefined;
  if (!chip) throw new Error(`no status chip "${label}"`);
  click(chip);
  await quiesce(400);
}

/** The status chips Filter by Status offers. */
export function taskStatusChips(app: CharApp): string[] {
  void app;
  const title = [...document.querySelectorAll('.toolbar-menu-section-title')].find((t) => t.textContent?.trim() === 'Filter by Status');
  return [...(title?.nextElementSibling?.querySelectorAll('.filter-chip') ?? [])].map((c) => (c.textContent ?? '').trim());
}

/** Each drawn row as "[Heading n] Title" (a group's first row) or "Title". */
export function taskListDrawn(app: CharApp): string[] {
  return $$(app.el, '.tasklist-row-wrap').map((el) => {
    const head = el.querySelector('.task-group-heading');
    const title = (el.querySelector('.task-title')?.textContent ?? '').trim();
    if (!head) return title;
    const [label, count] = [...head.querySelectorAll('span')].map((s) => (s.textContent ?? '').trim());
    return `[${label} ${count}] ${title}`;
  });
}

/** The fold button on a section's header. */
export async function toggleTaskSection(app: CharApp, title: string): Promise<void> {
  const section = $$(app.el, '.tasklist-section').find((s) => s.querySelector('.section-title')?.textContent?.trim() === title);
  if (!section) throw new Error(`no section "${title}"`);
  click($(section, '.group-collapse-btn'));
  await quiesce(400);
}

/** Adds a section with the toolbar button and names it. */
export async function addTaskSection(app: CharApp, title: string): Promise<void> {
  click($(app.el, '.add-section-btn'));
  await quiesce(300);
  const sections = $$(app.el, '.tasklist-section');
  const last = sections[sections.length - 1];
  if (!last) throw new Error('no section');
  last.querySelector<HTMLElement>('.section-title')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await settle();
  const input = $(app.el, 'input.section-title-input') as HTMLInputElement;
  input.value = title;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  key(input, 'Enter');
  await quiesce(400);
}

/** The section headers, with their fold state: "To do", "(Done)" when folded. */
export function taskSections(app: CharApp): string[] {
  return $$(app.el, '.tasklist-section').map((s) => {
    const title = (s.querySelector('.section-title')?.textContent ?? '').trim();
    return s.querySelector('.group-rows') ? title : `(${title})`;
  });
}

/** The day the open date picker has keyboard focus on. */
export function datePickerFocusedDay(): string | null {
  return (document.activeElement as HTMLElement | null)?.closest('.date-popover') ? (document.activeElement as HTMLElement).dataset.iso ?? null : null;
}

/** A key pressed where focus is (inside the date picker). */
export async function keyInDatePicker(k: string): Promise<void> {
  key(document.activeElement as HTMLElement, k);
  await settle();
  await settle();
}

/** A row's repeat chip → the Repeat menu → an item, or "Every…" with a number and a unit. */
export async function setTaskRepeat(app: CharApp, row: HTMLElement, label: string): Promise<void> {
  const chip = row.querySelector<HTMLElement>('.task-recurrence');
  if (chip) {
    click(chip);
  } else {
    row.querySelector<HTMLElement>('.task-due, .task-due-btn')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await settle();
    await chooseMenuItem(app, 'Repeat…');
  }
  await settle();
  await chooseMenuItem(app, label);
  await quiesce(400);
}

/** Fills the open "Every…" popup and saves it. */
export async function saveRepeatEvery(count: number, unit: 'days' | 'weeks' | 'months' | 'years'): Promise<void> {
  await waitFor(() => document.querySelector('.repeat-popup') !== null, 'the Every… popup');
  const n = $(document, '.repeat-popup .repeat-count') as HTMLInputElement;
  n.value = String(count);
  n.dispatchEvent(new Event('input', { bubbles: true }));
  const select = $(document, '.repeat-popup .repeat-unit') as HTMLSelectElement;
  select.value = { days: 'd', weeks: 'w', months: 'm', years: 'y' }[unit];
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
  key(n, 'Enter');
  await quiesce(600);
}

/** A Kanban card's right-click menu → Move to column → the column. */
export async function moveCardByMenu(app: CharApp, card: HTMLElement, column: string): Promise<void> {
  card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await settle();
  await chooseMenuItem(app, column);
  await quiesce(600);
}

/** Each Kanban column's title, left to right. */
export function kanbanColumnTitles(app: CharApp): string[] {
  return $$(app.el, '.kanban-column').map((col) => (col.querySelector('.column-title')?.textContent ?? '').trim());
}

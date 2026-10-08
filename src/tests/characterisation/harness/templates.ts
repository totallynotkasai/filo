/**
 * Templates as a user picks them: Ctrl+T (the Template Browser) on any
 * board, the New Tab menu's "New board from template…", and a Kanban
 * column's New card → From Template….
 */
import { settle, waitFor, quiesce, type CharApp } from './app';
import { $, $$, click, findByText, pressShortcut } from './actions';

/** A template row's name in the browser (without its "Makes a board" mark). */
function rowName(row: Element): string {
  const name = row.querySelector('.md-name');
  if (!name) return '';
  const kind = name.querySelector('.md-kind')?.textContent ?? '';
  return (name.textContent ?? '').replace(kind, '').trim();
}

/** Ctrl+T, with nothing focused: the Template Browser opens. */
export async function openTemplateBrowser(): Promise<void> {
  (document.activeElement as HTMLElement | null)?.blur?.();
  pressShortcut('t', { ctrlKey: true });
  await waitFor(() => document.querySelector('.browser .search-input') !== null, 'the Template Browser');
  await quiesce(500);
}

/** New Tab menu → "New board from template…". */
export async function openNewBoardFromTemplate(app: CharApp): Promise<void> {
  click($(app.el, 'button.new-tab-btn'));
  await settle();
  const option = findByText(app.el, '.new-tab-menu button.new-tab-option', 'New board from template…');
  if (!option) throw new Error('New Tab menu has no "New board from template…"');
  click(option);
  await waitFor(() => document.querySelector('.browser .search-input') !== null, 'the Template Browser');
  await quiesce(500);
}

/** The open Template Browser: its section titles, its Markdown rows, and whether a row is marked as making a board. */
export function templateBrowserShows(): { sections: string[]; rows: string[]; boardRows: string[]; layouts: string[] } {
  return {
    sections: $$(document, '.browser .section-title').map((el) => (el.textContent ?? '').trim()),
    rows: $$(document, '.browser .md-row').map(rowName),
    boardRows: $$(document, '.browser .md-row').filter((r) => r.querySelector('.md-kind') !== null).map(rowName),
    layouts: $$(document, '.browser .layout-name').map((el) => (el.textContent ?? '').trim()),
  };
}

/**
 * In the open Template Browser, the Markdown or board template named `name`.
 * With `refused`, the pick is expected to say why it made nothing, and the
 * browser stays open.
 */
export async function pickTemplate(name: string, opts: { refused?: boolean } = {}): Promise<void> {
  await waitFor(() => $$(document, '.md-row').some((r) => rowName(r) === name), `template "${name}" in the browser`);
  click($$(document, '.md-row').find((r) => rowName(r) === name)!);
  if (opts.refused) {
    await quiesce(800);
    return;
  }
  await waitFor(() => document.querySelector('.browser .search-input') === null, 'the Template Browser to close', 8000);
  await quiesce(800);
}

/** Ctrl+T on the Mind Map → the Markdown template named `name`. */
export async function insertMarkdownTemplate(app: CharApp, name: string): Promise<void> {
  void app;
  pressShortcut('t', { ctrlKey: true });
  await pickTemplate(name);
}

/**
 * A layout template saved in the vault, as Save as Template writes one
 * (`.filo/templates/`): `tiles` are text tiles at the given places, and those
 * with the same `shared` key showed one note when it was saved.
 */
export function saveLayoutTemplate(
  app: CharApp,
  name: string,
  tiles: Array<{ x: number; y: number; shared?: string }>,
  connections: Array<[from: number, to: number]> = [],
): void {
  const id = `t${name.replace(/\W/g, '').toLowerCase()}`;
  const template = {
    id,
    name,
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    boundingBox: { width: Math.max(...tiles.map((t) => t.x)) + 250, height: Math.max(...tiles.map((t) => t.y)) + 150 },
    tiles: tiles.map((t) => ({
      type: 'text',
      relativePosition: { x: t.x, y: t.y },
      size: { width: 250, height: 150 },
      style: { headerColor: '', bodyColor: '' },
      ...(t.shared ? { contentGroup: t.shared } : {}),
    })),
    connections: connections.map(([from, to]) => ({ fromTileIndex: from, toTileIndex: to, fromBubble: 1, toBubble: 3 })),
  };
  app.writeExternally(`.filo/templates/${id}--${id}.template.json`, JSON.stringify(template, null, 2));
}

/** Ctrl+T on the Mind Map → the layout template named `name`. */
export async function insertLayoutTemplate(name: string): Promise<void> {
  await openTemplateBrowser();
  await waitFor(() => document.querySelector(`button.layout-preview[aria-label="Insert template ${name}"]`) !== null, `layout "${name}" in the browser`);
  click(document.querySelector(`button.layout-preview[aria-label="Insert template ${name}"]`) as HTMLElement);
  await waitFor(() => document.querySelector('.browser .search-input') === null, 'the Template Browser to close');
  await quiesce(1000);
}

/** The templates a Kanban column's New card → From Template… lists (then closes it). */
export async function kanbanCardTemplates(app: CharApp, columnIndex: number): Promise<string[]> {
  click($$(app.el, '.kanban-column button.add-tile-btn')[columnIndex]!);
  await settle();
  const option = $$(app.el, 'button.kn-option').find((b) => (b.textContent ?? '').includes('From Template'));
  if (!option) throw new Error('new-card picker has no From Template');
  click(option);
  await waitFor(() => document.querySelector('.ktp-backdrop') !== null, 'the card template picker');
  await quiesce(800);
  const names = $$(document, '.ktp-row .ktp-row-name').map((el) => (el.textContent ?? '').trim());
  const close = $$(document, '.ktp-backdrop button').find((b) => /close|cancel/i.test(b.getAttribute('aria-label') ?? b.textContent ?? ''));
  if (close) click(close);
  await quiesce(300);
  return names;
}

/** A Kanban column's New card → From Template… → the template named `name`. */
export async function addKanbanCardFromTemplate(app: CharApp, columnIndex: number, name: string): Promise<void> {
  click($$(app.el, '.kanban-column button.add-tile-btn')[columnIndex]!);
  await settle();
  const option = $$(app.el, 'button.kn-option').find((b) => (b.textContent ?? '').includes('From Template'));
  if (!option) throw new Error('new-card picker has no From Template');
  click(option);
  await waitFor(() => findByText(document, '.ktp-row .ktp-row-name', name) !== null, `template "${name}" in the picker`);
  click(findByText(document, '.ktp-row .ktp-row-name', name)!.closest('button')!);
  await quiesce(800);
}

/** Each Kanban column's title, left to right. */
export function kanbanColumnTitles(app: CharApp): string[] {
  return $$(app.el, '.kanban-column .column-title').map((el) => (el.textContent ?? '').trim());
}

/** Each Task List section's title, top to bottom. */
export function taskSectionTitles(app: CharApp): string[] {
  return $$(app.el, '.tasklist-board .section-title').map((el) => (el.textContent ?? '').trim());
}

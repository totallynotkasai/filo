/**
 * Markdown templates as a user picks them: Ctrl+T on a Mind Map (the
 * Template Browser), and a Kanban column's Add Card → From Template….
 */
import { settle, waitFor, quiesce, type CharApp } from './app';
import { $$, click, findByText, pressShortcut } from './actions';

/** Ctrl+T on the Mind Map → the Markdown template named `name`. */
export async function insertMarkdownTemplate(app: CharApp, name: string): Promise<void> {
  pressShortcut('t', { ctrlKey: true });
  await waitFor(() => $$(document, '.md-row').some((r) => (r.querySelector('.md-name')?.textContent ?? '').trim() === name), `template "${name}" in the browser`);
  const row = $$(document, '.md-row').find((r) => (r.querySelector('.md-name')?.textContent ?? '').trim() === name)!;
  click(row);
  await waitFor(() => document.querySelector('.md-row') === null, 'the Template Browser to close');
  await quiesce(800);
}

/** A Kanban column's Add Card → From Template… → the template named `name`. */
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

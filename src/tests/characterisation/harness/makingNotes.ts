/**
 * Making notes and folders without a board: the vault sidebar's New note and
 * New folder (on a folder's menu, or on the empty space below the files),
 * Ctrl+N in a Document tab, and New Tab → Document. A new note opens in a
 * Document tab with its title (the tab's name) ready to type.
 */
import { existsSync, statSync } from 'node:fs';
import { settle, waitFor, quiesce, type CharApp } from './app';
import { $, $$, chooseMenuItem, click, contextMenu, dblclick, findByText, key, pressShortcut, revealInSidebar, typeInto } from './actions';

/** Paths of `.md` files that appeared since `before`. */
function newNotes(app: CharApp, before: string[]): string[] {
  const had = new Set(before);
  return app.userFiles().filter((f) => f.endsWith('.md') && !had.has(f));
}

/** The tab name being typed (a new note's title), or null when no tab is being renamed. */
export function tabTitleBeingTyped(app: CharApp): string | null {
  const input = app.el.querySelector('.tab input') as HTMLInputElement | null;
  return input ? input.value : null;
}

/**
 * Types `title` into the new note's tab name and presses Enter (or Escape to
 * keep "Untitled"), then returns the note's path once its file settles.
 */
async function nameNewNote(app: CharApp, before: string[], title: string | null): Promise<string> {
  await waitFor(() => newNotes(app, before).length === 1, 'the new note on disk');
  await waitFor(() => tabTitleBeingTyped(app) !== null, 'the new note\'s title open for typing');
  const input = $(app.el, '.tab input') as HTMLInputElement;
  if (title === null) {
    key(input, 'Escape');
  } else {
    typeInto(input, title);
    key(input, 'Enter');
  }
  await quiesce(800);
  const made = newNotes(app, before);
  if (made.length !== 1) throw new Error(`expected one new note, found ${made.join(', ') || 'none'}`);
  return made[0]!;
}

/**
 * Right-click a folder in the sidebar (or, with `folderRel` null, the empty
 * space below the files) → New note → type `title` and Enter. Returns the
 * note's path. `title` null presses Escape instead.
 */
export async function newNoteFromSidebar(app: CharApp, folderRel: string | null, title: string | null): Promise<string> {
  const before = app.userFiles();
  contextMenu(folderRel === null ? $(app.el, '.vault-sidebar .file-tree') : await revealInSidebar(app, folderRel));
  await settle();
  await chooseMenuItem(app, 'New note');
  return nameNewNote(app, before, title);
}

/** Ctrl+N where focus is (a Document tab's text), then name the note. */
export async function newNoteWithCtrlN(app: CharApp, title: string | null): Promise<string> {
  const before = app.userFiles();
  pressShortcut('n', { ctrlKey: true });
  return nameNewNote(app, before, title);
}

/** The tab bar's New Tab → Document, then name the note. */
export async function newDocumentFromNewTab(app: CharApp, title: string | null): Promise<string> {
  const before = app.userFiles();
  click($(app.el, 'button.new-tab-btn'));
  await settle();
  const option = findByText(app.el, '.new-tab-menu button.new-tab-option', 'Document');
  if (!option) throw new Error('New Tab menu has no "Document"');
  click(option);
  return nameNewNote(app, before, title);
}

/** The New Tab menu's options. */
export async function newTabOptions(app: CharApp): Promise<string[]> {
  click($(app.el, 'button.new-tab-btn'));
  await settle();
  const labels = $$(app.el, '.new-tab-menu button.new-tab-option').map((b) => (b.textContent ?? '').trim());
  click($(app.el, 'button.new-tab-btn'));
  await settle();
  return labels;
}

/**
 * Right-click a folder (or the empty space) → New folder → type `name` and
 * Enter. Resolves once the folder is on disk.
 */
export async function newFolderFromSidebar(app: CharApp, parentRel: string | null, name: string): Promise<void> {
  contextMenu(parentRel === null ? $(app.el, '.vault-sidebar .file-tree') : await revealInSidebar(app, parentRel));
  await settle();
  await chooseMenuItem(app, 'New folder');
  await waitFor(() => app.el.querySelector('.vault-file-item .rename-input') !== null, 'the new folder\'s name open for typing');
  const input = $(app.el, '.vault-file-item .rename-input') as HTMLInputElement;
  typeInto(input, name);
  key(input, 'Enter');
  const rel = parentRel === null ? name : `${parentRel}/${name}`;
  await waitFor(() => existsSync(app.abs(rel)) && statSync(app.abs(rel)).isDirectory(), `folder ${rel} on disk`);
  await quiesce(400);
}

/** The labels of the sidebar menu on a folder (or, with null, on the empty space); the menu is closed again. */
export async function sidebarMenuLabels(app: CharApp, rel: string | null): Promise<string[]> {
  contextMenu(rel === null ? $(app.el, '.vault-sidebar .file-tree') : await revealInSidebar(app, rel));
  await settle();
  const labels = $$(app.el, '.context-menu .menu-item, .context-menu [role="menuitem"]').map((e) => (e.textContent ?? '').trim()).filter(Boolean);
  pressShortcut('Escape');
  await settle();
  return labels;
}

/** Double-click a task's title, type `title`, press Enter. */
export async function renameTaskTitle(row: HTMLElement, title: string): Promise<void> {
  dblclick($(row, '.task-title'));
  await waitFor(() => row.querySelector('input.task-title-input') !== null, 'the task title box');
  const input = row.querySelector('input.task-title-input') as HTMLInputElement;
  typeInto(input, title);
  key(input, 'Enter');
  await quiesce(1200);
}

/**
 * Vault name and folder-pin drivers for the characterisation suite: the vault
 * menu's Rename Vault, a folder row's Root Directory button in the sidebar,
 * the Board-specific folders switch, and renaming a board from its tab.
 */
import type { CharApp } from './app';
import { quiesce, settle, waitFor } from './app';
import { $, $$, click, dblclick, key, revealInSidebar, typeInto } from './actions';

function vaultMenuTrigger(app: CharApp): HTMLElement {
  return $$(app.el, 'button.dropdown-trigger').find((b) => b.closest('.global-toolbar, header, nav') !== null)
    ?? $(app.el, 'button.dropdown-trigger');
}

/** The vault name the global toolbar shows. */
export function vaultName(app: CharApp): string {
  return (vaultMenuTrigger(app).querySelector('.dropdown-label')?.textContent ?? '').trim();
}

/** Vault menu → Rename Vault, type `name`, press Enter. */
export async function renameVault(app: CharApp, name: string): Promise<void> {
  click(vaultMenuTrigger(app));
  await settle();
  const item = $$(document, 'button.dropdown-item').find((b) => (b.textContent ?? '').trim() === 'Rename Vault');
  if (!item) throw new Error('no Rename Vault item');
  click(item);
  await waitFor(() => document.querySelector('input#rename-project') !== null, 'vault name input');
  const input = document.querySelector('input#rename-project') as HTMLInputElement;
  typeInto(input, name);
  key(input, 'Enter');
  await quiesce(800);
}

/** A folder row's action button (`sel`), found beside the row. */
async function folderButton(app: CharApp, folderRel: string, sel: string): Promise<HTMLElement> {
  const row = await revealInSidebar(app, folderRel);
  const btn = (row.querySelector(sel) ?? row.parentElement?.querySelector(sel)) as HTMLElement | null;
  if (!btn) throw new Error(`folder row ${folderRel} has no ${sel}`);
  return btn;
}

/** Sidebar: a folder's "Use as Root Directory" button. */
export async function toggleRootDirectory(app: CharApp, folderRel: string): Promise<void> {
  click(await folderButton(app, folderRel, 'button.root-dir-btn'));
  await quiesce(600);
}

/**
 * Sidebar: with board-specific folders on, a folder's "Use as root directory"
 * button is the open board's folder.
 */
export async function toggleBoardFolder(app: CharApp, folderRel: string): Promise<void> {
  click(await folderButton(app, folderRel, 'button.root-dir-btn'));
  await quiesce(600);
}

/** Vault menu → Settings → General → Board-specific folders, set to `on`; then close Settings. */
export async function setBoardFolders(app: CharApp, on: boolean): Promise<void> {
  click(vaultMenuTrigger(app));
  await settle();
  const item = $$(document, 'button.dropdown-item').find((b) => (b.textContent ?? '').trim() === 'Settings');
  if (!item) throw new Error('no Settings item');
  click(item);
  await waitFor(() => document.querySelector('#board-folders-toggle') !== null, 'board folders switch');
  const toggle = document.querySelector('#board-folders-toggle') as HTMLElement;
  if ((toggle.getAttribute('aria-checked') === 'true') !== on) click(toggle);
  await settle();
  const close = document.querySelector('button.modal-close') as HTMLElement | null;
  if (close) click(close);
  await quiesce(600);
}

/** Double-click the active tab, type `name`, press Enter (a board's rename). */
export async function renameActiveBoard(app: CharApp, name: string): Promise<void> {
  const input = await openTabRename(app);
  typeInto(input, name);
  key(input, 'Enter');
  await quiesce(1500);
}

/**
 * Double-click the active tab and type `name`: the inline message shown for
 * it (`null` when none), with the rename then abandoned (Escape).
 */
export async function activeBoardRenameMessage(app: CharApp, name: string): Promise<string | null> {
  const input = await openTabRename(app);
  typeInto(input, name);
  await settle();
  key(input, 'Enter');
  await settle(100);
  const message = (document.querySelector('.tab-rename-problem')?.textContent ?? '').trim() || null;
  const still = app.el.querySelector('input.tab-rename');
  if (still) key(still, 'Escape');
  await quiesce(300);
  return message;
}

async function openTabRename(app: CharApp): Promise<HTMLInputElement> {
  dblclick($(app.el, '.tab.active, .tab[aria-selected="true"]'));
  await waitFor(() => app.el.querySelector('input.tab-rename') !== null, 'tab rename input');
  return $(app.el, 'input.tab-rename') as HTMLInputElement;
}

/** The folder rows whose button `sel` shows pressed, as vault-relative paths. */
function pressedFolders(app: CharApp, sel: string): string[] {
  const root = app.abs('').replace(/[\\/]+$/, '');
  const out: string[] = [];
  for (const btn of $$(app.el, `${sel}[aria-pressed="true"]`)) {
    // The buttons sit in `.file-actions`, a sibling of the row they act on.
    const row = btn.closest('.file-actions')?.parentElement?.querySelector('.file-row');
    const abs = row?.getAttribute('title') ?? '';
    out.push(abs.slice(root.length + 1).split(/[\\/]/).join('/'));
  }
  return out;
}

/** The folder the sidebar marks as the Root Directory, or null when none is. */
export function rootDirectoryFolder(app: CharApp): string | null {
  return pressedFolders(app, 'button.root-dir-btn')[0] ?? null;
}

/** With board-specific folders on: the folder the sidebar marks as the open board's, or null. */
export function boardFolder(app: CharApp): string | null {
  return pressedFolders(app, 'button.root-dir-btn')[0] ?? null;
}

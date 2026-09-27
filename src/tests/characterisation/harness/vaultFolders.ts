/**
 * Vault name and folder-pin drivers for the characterisation suite: the vault
 * menu's Rename Vault, and a folder row's Root Directory and board-folder
 * buttons in the sidebar.
 */
import type { CharApp } from './app';
import { quiesce, settle, waitFor } from './app';
import { $, $$, click, key, revealInSidebar, typeInto } from './actions';

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

/** Sidebar: a folder's "Default folder for board" button (the open board). */
export async function toggleBoardFolder(app: CharApp, folderRel: string): Promise<void> {
  click(await folderButton(app, folderRel, 'button.board-folder-btn'));
  await quiesce(600);
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

/** The folder the sidebar marks as the open board's folder, or null when none is. */
export function boardFolder(app: CharApp): string | null {
  return pressedFolders(app, 'button.board-folder-btn')[0] ?? null;
}

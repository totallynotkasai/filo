/**
 * Vault sidebar drivers for the characterisation suite: the sidebar's Hide
 * Vault and Float buttons, the global toolbar's sidebar toggle, the vault
 * menu's Close Vault, and what the per-machine `sidebar-state.json` holds.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import type { CharApp } from './app';
import { settle, waitFor } from './app';
import { $$, click } from './actions';

/** The sidebar as the user sees it: hidden, docked beside the boards, or floating. */
export type SidebarView = 'hidden' | 'docked' | 'floating';

export function sidebarView(app: CharApp): SidebarView {
  if (app.el.querySelector('.floating-vault-panel')) return 'floating';
  const docked = app.el.querySelector('.vault-sidebar:not(.embedded)');
  return docked?.classList.contains('open') ? 'docked' : 'hidden';
}

/** A button inside the sidebar the user can see (the docked one slides away when hidden, and is inert). */
function reachable(b: HTMLElement): boolean {
  if (b.closest('.floating-vault-panel')) return true;
  const docked = b.closest<HTMLElement>('.vault-sidebar');
  return docked !== null && docked.classList.contains('open') && docked.inert !== true;
}

function sidebarButton(app: CharApp, sel: string): HTMLElement {
  const btn = $$(app.el, sel).find(reachable);
  if (!btn) throw new Error(`no reachable ${sel} in the sidebar`);
  return btn;
}

/** The sidebar's Hide Vault button. */
export async function hideVault(app: CharApp): Promise<void> {
  click(sidebarButton(app, 'button[data-testid="hide-vault"]'));
  await settle(100);
}

/** Whether the Hide Vault button can be reached (not hidden away with the sidebar). */
export function hideVaultReachable(app: CharApp): boolean {
  return $$(app.el, 'button[data-testid="hide-vault"]').some(reachable);
}

/** The sidebar's "Float as panel" / "Dock back" button. */
export async function floatSidebar(app: CharApp, floating: boolean): Promise<void> {
  click(sidebarButton(app, floating ? 'button[title="Float as panel"]' : 'button[title="Dock back"]'));
  await settle(100);
}

function toolbarToggle(app: CharApp): HTMLElement | null {
  return app.el.querySelector<HTMLElement>('.global-toolbar button[aria-label="Toggle sidebar"]');
}

/** The global toolbar's sidebar toggle, and whether it is the toolbar's first button. */
export function toolbarToggleState(app: CharApp): { shown: boolean; first: boolean; pressed: boolean } {
  const btn = toolbarToggle(app);
  const first = app.el.querySelector('.global-toolbar button') === btn;
  return { shown: btn !== null, first, pressed: btn?.getAttribute('aria-pressed') === 'true' };
}

/** Click the global toolbar's sidebar toggle. */
export async function clickToolbarToggle(app: CharApp): Promise<void> {
  const btn = toolbarToggle(app);
  if (!btn) throw new Error('no sidebar toggle in the toolbar');
  click(btn);
  await settle(100);
}

/** Vault menu → Close Vault. Resolves once the vault is closed. */
export async function closeVaultFromMenu(app: CharApp): Promise<void> {
  const trigger = $$(app.el, 'button.dropdown-trigger').find((b) => b.closest('.global-toolbar') !== null);
  if (!trigger) throw new Error('no vault menu');
  click(trigger);
  await settle();
  const item = $$(document, 'button.dropdown-item').find((b) => (b.textContent ?? '').trim() === 'Close Vault');
  if (!item) throw new Error('no Close Vault item');
  click(item);
  const { vaultStore } = await import('@renderer/stores/vault.svelte');
  await waitFor(() => vaultStore.project === null, 'the vault closed', 10000);
  await settle(100);
}

/** What `sidebar-state.json` holds once its debounced save has landed. */
export async function savedSidebarState(): Promise<{ open?: boolean; floating?: boolean }> {
  const { flushSidebarStateNow } = await import('../../../main/services/sidebarState');
  const { app: electronApp } = await import('electron');
  await settle(50);
  await flushSidebarStateNow();
  return JSON.parse(readFileSync(join(electronApp.getPath('userData'), 'sidebar-state.json'), 'utf-8')) as {
    open?: boolean;
    floating?: boolean;
  };
}

/** Put the sidebar back docked and shown, so the next spec starts from the default. */
export async function resetSidebar(): Promise<void> {
  const { uiStore } = await import('@renderer/stores/ui.svelte');
  uiStore.setSidebarFloating(false);
  uiStore.setSidebarOpen(true);
  await settle(50);
}

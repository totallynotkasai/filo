/**
 * Characterisation harness — Settings → Themes, and the settings dialog's
 * tabs, driven through the real UI.
 */
import { $, $$, click, typeInto } from './actions';
import { quiesce, settle, waitFor, type CharApp } from './app';

/** Vault menu → Settings → the tab whose label contains `label`. */
export async function openSettingsTab(app: CharApp, label: string): Promise<void> {
  if (document.querySelector('.settings-tab') === null) {
    const trigger = $$(app.el, 'button.dropdown-trigger').find((b) => b.closest('.global-toolbar, header, nav') !== null)
      ?? $(app.el, 'button.dropdown-trigger');
    click(trigger);
    await settle();
    const item = $$(document, 'button.dropdown-item').find((b) => (b.textContent ?? '').trim() === 'Settings');
    if (!item) throw new Error('no Settings item');
    click(item);
    await waitFor(() => $$(document, '.settings-tab').length > 0, 'settings modal');
  }
  const tab = $$(document, '.settings-tab').find((b) => (b.textContent ?? '').includes(label));
  if (!tab) throw new Error(`no ${label} tab`);
  click(tab);
  await quiesce(300);
}

/** Whether the settings tab whose label contains `label` can be opened. */
export function settingsTabEnabled(label: string): boolean {
  const tab = $$(document, '.settings-tab').find((b) => (b.textContent ?? '').includes(label)) as HTMLButtonElement | undefined;
  if (!tab) throw new Error(`no ${label} tab`);
  return !tab.disabled;
}

/** Themes tab: click the theme whose name is `name`. Leaves any question it asks open. */
export async function pickTheme(name: string): Promise<void> {
  const btn = document.querySelector(`button[aria-label="Select ${name} theme"]`) as HTMLElement | null;
  if (!btn) throw new Error(`no theme called ${name}`);
  click(btn);
  await quiesce(600);
}

/** Themes tab: the name of the theme marked active. */
export function activeThemeName(): string {
  const btn = $$(document, 'button.theme-card.active, button.custom-theme-btn.active')[0];
  return (btn?.getAttribute('aria-label') ?? '').replace(/^Select /, '').replace(/ theme$/, '');
}

/** Themes tab: every custom theme listed, by name. */
export function customThemeNames(): string[] {
  return $$(document, 'button.custom-theme-btn').map((b) => (b.getAttribute('aria-label') ?? '').replace(/^Select /, '').replace(/ theme$/, ''));
}

/**
 * Themes tab → New Theme (unless the editor is still open after a refused
 * name) → name it → Save. Resolves with the editor's problem text ('' when it
 * saved).
 */
export async function createTheme(name: string): Promise<string> {
  if (document.querySelector('#theme-editor-name') === null) {
    const btn = $$(document, '.theme-actions button').find((b) => (b.textContent ?? '').trim() === 'New Theme');
    if (!btn) throw new Error('no New Theme button');
    click(btn);
    await waitFor(() => document.querySelector('#theme-editor-name') !== null, 'theme editor');
  }
  typeInto(document.querySelector('#theme-editor-name') as HTMLInputElement, name);
  await settle();
  const save = $$(document, '.editor-actions button').find((b) => (b.textContent ?? '').trim() === 'Save');
  if (!save) throw new Error('no Save button');
  click(save);
  await quiesce(1200);
  return document.querySelector('#theme-editor-problem')?.textContent?.trim() ?? '';
}

/** Themes tab: Delete on a custom theme. Leaves the confirm open. */
export async function clickDeleteTheme(name: string): Promise<void> {
  const btn = document.querySelector(`button[aria-label="Delete ${name}"]`) as HTMLElement | null;
  if (!btn) throw new Error(`no Delete for ${name}`);
  click(btn);
  await waitFor(() => document.querySelector('.confirm-dialog') !== null, 'delete confirm');
}

/** The confirm's secondary button (the one between Cancel and Confirm). */
export async function answerConfirmSecondary(): Promise<void> {
  await waitFor(() => document.querySelector('.confirm-dialog .confirm-btn.secondary') !== null, 'confirm secondary button');
  click(document.querySelector('.confirm-dialog .confirm-btn.secondary') as HTMLElement);
  await quiesce(800);
}

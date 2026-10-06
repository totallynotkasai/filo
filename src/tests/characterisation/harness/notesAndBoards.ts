/**
 * Tabs, board files and Kanban sorting as a user meets them, for the notes
 * and boards spec. Specs call only these.
 */
import { settle, quiesce, type CharApp } from './app';
import { $, $$, click } from './actions';

/** Clicks the tab whose name is `name` (as `openTabs` shows it, before the kind). */
export async function clickTab(app: CharApp, name: string): Promise<void> {
  const tab = $$(app.el, '.tab[title]').find((t) => (t.getAttribute('title') ?? '').startsWith(`${name} (`));
  if (!tab) throw new Error(`no tab named "${name}"`);
  click(tab);
  await settle(200);
}

/** The text of every board file in the vault, by path. */
export function boardFiles(app: CharApp): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of app.userFiles()) if (rel.endsWith('.board.json')) out[rel] = app.read(rel) ?? '';
  return out;
}

/** Picks a sort in the Kanban side toolbar's Sort menu. */
export async function sortKanbanBy(app: CharApp, label: string): Promise<void> {
  click($(app.el, '.side-toolbar button[aria-label^="Sort, current"]'));
  await settle();
  const item = $$(document, 'button.toolbar-menu-item').find((el) => (el.textContent ?? '').trim() === label);
  if (!item) throw new Error(`no sort "${label}"`);
  click(item);
  await quiesce(800);
}

/** The Global Defaults as `.filo/defaults.json` holds them now. */
export function savedGlobalDefaults(app: CharApp): { mindmap?: { frame?: { backgroundImage?: string } } } {
  const text = app.read('.filo/defaults.json');
  return text ? (JSON.parse(text) as { mindmap?: { frame?: { backgroundImage?: string } } }) : {};
}

/** The board files Filo saved while `act` ran (even with the same bytes). */
export async function boardsSavedWhile(app: CharApp, act: () => Promise<void>): Promise<string[]> {
  const from = app.bridge.calls.length;
  await act();
  return app.bridge.calls.slice(from).filter((c) => c.channel === 'board:save').map((c) => String(c.args[1]));
}

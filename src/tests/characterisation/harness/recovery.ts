/**
 * Settings → Recovery and the watcher events a sync spec counts, as a user
 * meets them: the tab's copies by kind, Open, Delete and Delete all, and the
 * renames the watcher sends. Specs call only these.
 */
import { settle, waitFor, quiesce, type CharApp } from './app';
import { $, $$, click } from './actions';
import { openSettingsFromToolbar } from './interfaceChrome';
import { recycled } from './electronFake';

/** Opens Settings from the toolbar and picks its Recovery tab; waits for the list. */
export async function openRecoverySettings(app: CharApp): Promise<void> {
  await openSettingsFromToolbar(app);
  const tab = $$(document, '[role="tab"].settings-tab').find((b) => (b.textContent ?? '').includes('Recovery'));
  if (!tab) throw new Error('no Recovery tab');
  click(tab);
  await waitForRecoveryList();
}

/** Waits until the Recovery tab shows its list (or that it has none). */
export async function waitForRecoveryList(): Promise<void> {
  await waitFor(() => document.querySelector('.recovery-settings .kind, .recovery-settings .empty-text:not(:empty)') !== null
    && !(document.querySelector('.recovery-settings .empty-text')?.textContent ?? '').includes('Loading'), 'the Recovery list');
  await settle();
}

/** The Recovery tab's sections (title without its count) and the names of the copies under each. */
export function recoverySections(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const section of $$(document, '.recovery-settings .kind')) {
    const title = ($(section, '.kind-title').textContent ?? '').replace(/\s*\(\d+\)\s*$/, '').trim();
    out[title] = $$(section, '.item-name').map((n) => (n.textContent ?? '').trim());
  }
  return out;
}

/** The Recovery tab's Delete on the copy shown as `name`; waits for the list to drop it. */
export async function deleteRecoveryCopy(name: string): Promise<void> {
  const btn = document.querySelector(`.recovery-settings button[aria-label="Delete ${name}"]`) as HTMLElement | null;
  if (!btn) throw new Error(`no Delete for "${name}"`);
  click(btn);
  await waitFor(() => !Object.values(recoverySections()).some((names) => names.includes(name)), `"${name}" gone from the list`);
  await quiesce(300);
}

/** A section's Delete all, answering its confirm with Delete. */
export async function deleteAllInRecoverySection(title: string): Promise<void> {
  const btn = document.querySelector(`.recovery-settings button[aria-label="Delete all ${title.toLowerCase()}"]`) as HTMLElement | null;
  if (!btn) throw new Error(`no Delete all for "${title}"`);
  click(btn);
  await waitFor(() => document.querySelector('.confirm-dialog') !== null, 'the delete confirm');
  click($(document.querySelector('.confirm-dialog') as HTMLElement, '.confirm-actions .confirm-btn:not(.cancel):not(.secondary)'));
  await waitFor(() => !(title in recoverySections()), `"${title}" emptied`);
  await quiesce(300);
}

/** Every path the app sent to the (fake) Recycle Bin. */
export function recycledPaths(): string[] {
  return [...recycled];
}

/** Counts the renames the watcher sends from now on. */
export function countWatcherRenames(): { readonly count: number; stop(): void } {
  let count = 0;
  const off = window.filo.on('vault:file-renamed', () => {
    count++;
  });
  return {
    get count() {
      return count;
    },
    stop: off,
  };
}

/** A walk of the vault now, as the window regaining focus asks for (past main's 5 s throttle). */
export async function walkVaultNow(): Promise<void> {
  await new Promise((r) => setTimeout(r, 5200));
  await window.filo.invoke('vault:reconcile');
  await quiesce(2500);
}

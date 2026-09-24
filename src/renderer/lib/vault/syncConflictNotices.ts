/**
 * User-facing sync-conflict notices.
 *
 * A sync client (OneDrive, Dropbox, iCloud, Syncthing) that sees two edits of
 * one file keeps both: the other version lands under a conflict name
 * (`Plan.board-DESKTOP-1A2B3C4.json`, `Note (Andrew's conflicted copy …).md`).
 * Filo never adopts or deletes such a copy; it tells the user once, stickily,
 * where the other version is. Two sources feed the same toast:
 *   - at vault open, `board:list-conflicts` (board forks `board:list` can't see);
 *   - live, main's `vault:sync-conflict` event (a board fork appearing, or a
 *     rename the correlator refused because the new name is a conflict copy
 *     of the missing file).
 */
import { uiStore } from '../../stores/ui.svelte';
import { normalizePath } from '../utils/path';
import { noteExpectedReappearance } from './externalChangeWindows';

export interface SyncConflictNotice {
  copyPath: string;
  canonicalPath: string;
  client: string;
}

export interface SyncConflictToast {
  text: string;
  type: 'warning';
  duration: number;
  sticky: true;
  dedupeKey: string;
  actions: Array<{ label: string; handler: () => void }>;
}

const CLIENT_NAMES: Record<string, string> = {
  onedrive: 'OneDrive',
  dropbox: 'Dropbox',
  gdrive: 'Google Drive',
  icloud: 'iCloud',
  syncthing: 'Syncthing',
};

function baseName(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i >= 0 ? rel.slice(i + 1) : rel;
}

/** Grace (ms) during which a conflict's canonical file is expected to reappear. */
export const CONFLICT_REAPPEAR_GRACE_MS = 10_000;

export function syncConflictToast(vaultRoot: string, notices: readonly SyncConflictNotice[]): SyncConflictToast {
  const first = notices[0]!;
  const client = CLIENT_NAMES[first.client] ?? 'Your sync app';
  const copies = notices.map((n) => baseName(n.copyPath)).join(', ');
  const isBoard = first.canonicalPath.toLowerCase().endsWith('.board.json');
  const canonicalName = baseName(first.canonicalPath);
  const text = isBoard
    ? `${client} kept a conflicting copy of the board "${canonicalName.replace(/\.board\.json$/i, '')}": ${copies}. Filo is using ${canonicalName}; the copy is untouched.`
    : `Sync conflict: "${canonicalName}" and ${copies}. Your boards still point at ${canonicalName}; the copy is untouched.`;
  const firstAbs = `${normalizePath(vaultRoot)}/${first.copyPath}`;
  return {
    text,
    type: 'warning',
    duration: 0,
    sticky: true,
    dedupeKey: `sync-conflict:${first.canonicalPath.toLowerCase()}`,
    actions: [
      {
        label: 'Show in folder',
        handler: () => {
          void window.filo.invoke('shell:show-item-in-folder', firstAbs);
        },
      },
      { label: 'Dismiss', handler: () => {} },
    ],
  };
}

/** Groups notices per canonical file (one toast per original). */
export function groupByCanonical(notices: readonly SyncConflictNotice[]): SyncConflictNotice[][] {
  const groups = new Map<string, SyncConflictNotice[]>();
  for (const n of notices) {
    const key = n.canonicalPath.toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), n]);
  }
  return [...groups.values()];
}

/**
 * Subscribes to main's live `vault:sync-conflict` notices. `getVaultRoot`
 * reads the committed vault at delivery time (a notice for a closed vault is
 * dropped). Returns the unsubscribe.
 */
export function listenForSyncConflicts(getVaultRoot: () => string): () => void {
  return window.filo.on('vault:sync-conflict', (...args: unknown[]) => {
    const n = args[0] as SyncConflictNotice | null;
    const root = getVaultRoot();
    if (!root || !n || typeof n.copyPath !== 'string' || typeof n.canonicalPath !== 'string') return;
    // The original is usually about to be re-downloaded under its own
    // name; don't greet that gap with a "deleted externally" prompt.
    noteExpectedReappearance(n.canonicalPath, CONFLICT_REAPPEAR_GRACE_MS);
    uiStore.pushToast(syncConflictToast(root, [n]));
  });
}

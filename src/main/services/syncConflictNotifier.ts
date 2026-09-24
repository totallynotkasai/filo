/**
 * Live sync-conflict notices.
 *
 * Two watcher-level signals share this module (so `fileWatcher.ts` only
 * carries a one-line hook):
 *   - a board FORK appearing (`Plan.board-HOST.json`, a Dropbox conflicted
 *     copy …) — invisible to `board:list`;
 *   - a cross-basename rename the correlator REFUSED because the present file
 *     is a conflict copy of the missing one — reported by `correlateRenames`
 *     as `conflicts`.
 * Each is sent to the renderer as the main→renderer event `vault:sync-conflict`
 * (`{ copyPath, canonicalPath, client }`), once per copy path per session.
 *
 * Known hosts (for the OneDrive rule): `os.hostname()` plus every hostname in
 * the vault's `.filo/machines/*.json` registry (one file per machine).
 */
import { BrowserWindow } from 'electron';
import { promises as fs } from 'fs';
import { hostname } from 'os';
import { join } from 'path';
import { detectConflictCopyPath } from '../../shared/conflictCopy';
import type { FileChangeEvent } from './fileWatcherTypes';

export interface SyncConflictNotice {
  copyPath: string;
  canonicalPath: string;
  client: string;
}

let hostsVault: string | null = null;
let hosts: string[] = [hostname()];
const announced = new Set<string>();

/** Loads (and caches for the vault) the known device names. Best-effort. */
export async function loadKnownHosts(vaultRoot: string): Promise<string[]> {
  const found = new Set<string>([hostname()]);
  try {
    const dir = join(vaultRoot, '.filo', 'machines');
    for (const name of await fs.readdir(dir)) {
      if (!name.toLowerCase().endsWith('.json')) continue;
      try {
        const raw = JSON.parse(await fs.readFile(join(dir, name), 'utf-8')) as { hostname?: unknown };
        if (typeof raw.hostname === 'string' && raw.hostname.trim()) found.add(raw.hostname.trim());
      } catch {
        // half-synced / hand-edited registry entry — skip it
      }
    }
  } catch {
    // no registry yet
  }
  if (hostsVault !== vaultRoot) announced.clear();
  hostsVault = vaultRoot;
  hosts = [...found];
  return hosts;
}

/** The cached known hosts for `vaultRoot` (this machine's name until loaded). */
export function knownHostsFor(vaultRoot: string): string[] {
  return hostsVault === vaultRoot ? hosts : [hostname()];
}

/** Board forks among the batch's present files (their canonical board exists). */
export function boardForkNotices(
  vaultRoot: string,
  events: readonly FileChangeEvent[],
  exists: (rel: string) => boolean,
): SyncConflictNotice[] {
  const out: SyncConflictNotice[] = [];
  for (const e of events) {
    const lower = e.filename.toLowerCase();
    if (!/\.board.+\.json$/.test(lower) || lower.endsWith('.board.json')) continue;
    if (!exists(e.filename)) continue;
    const hit = detectConflictCopyPath(e.filename, { knownHosts: knownHostsFor(vaultRoot), exists });
    if (!hit || !hit.canonicalName.toLowerCase().endsWith('.board.json') || !exists(hit.canonicalName)) continue;
    out.push({ copyPath: e.filename, canonicalPath: hit.canonicalName, client: hit.client });
  }
  return out;
}

/**
 * The watcher hook: announce board forks in `events` plus the correlator's
 * refused conflict pairs. Each copy path is announced once per session.
 */
export function announceSyncConflicts(
  vaultRoot: string,
  events: readonly FileChangeEvent[],
  exists: (rel: string) => boolean,
  refused: readonly SyncConflictNotice[] = [],
): void {
  const notices = [...boardForkNotices(vaultRoot, events, exists), ...refused];
  for (const n of notices) {
    const key = n.copyPath.toLowerCase();
    if (announced.has(key)) continue;
    announced.add(key);
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('vault:sync-conflict', n);
  }
}

/** Test-only. */
export function __resetSyncConflictNotifierForTests(): void {
  announced.clear();
  hostsVault = null;
  hosts = [hostname()];
}

import { app } from 'electron';
import { join } from 'path';
import { promises as fs } from 'fs';
import { atomicWriteFile } from '../vault/filenameUtils';
import { logMainError } from '../utils/mainLogger';

export interface RecentVault {
  path: string;
  name: string;
  lastOpened: number; // Unix timestamp ms
  pinned?: boolean;
}

export interface RecentVaultsPreferences {
  openLastVaultOnLaunch: boolean;
}

interface RecentVaultsFile {
  vaults: RecentVault[];
  preferences: RecentVaultsPreferences;
}

const MAX_UNPINNED = 10;
/**
 * Phase 8 / 8.5 — absolute ceiling on the number of entries in
 * `recent-vaults.json`. Pinned entries previously had no cap, which meant
 * a runaway caller (or hand-edited file) could grow the list unboundedly
 * and slow every launch-time read. With 50, even a power user who pins
 * many workspaces lands well under the practical UI ceiling. If the file
 * on disk already has more, we prune the oldest pinned entries (by
 * `lastOpened`) on the next write — the trim never silently DROPS data
 * the user explicitly asked us to remember without surfacing a write.
 */
const MAX_TOTAL = 50;

const DEFAULT_PREFERENCES: RecentVaultsPreferences = {
  openLastVaultOnLaunch: true,
};

function getRecentVaultsPath(): string {
  return join(app.getPath('userData'), 'recent-vaults.json');
}

async function readFile(): Promise<RecentVaultsFile> {
  const filePath = getRecentVaultsPath();
  let data: string;
  try {
    data = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    // Phase 21 / M27 — ENOENT on first launch is normal; anything else
    // (parse error, EACCES) deserves a breadcrumb so the user can see
    // why their recents list reset.
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      logMainError('recentVaults.read', err);
    }
    return { vaults: [], preferences: { ...DEFAULT_PREFERENCES } };
  }
  try {
    const parsed = JSON.parse(data) as unknown;
    if (Array.isArray(parsed)) {
      return { vaults: parsed as RecentVault[], preferences: { ...DEFAULT_PREFERENCES } };
    }
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Partial<RecentVaultsFile>;
      const vaults = Array.isArray(obj.vaults) ? obj.vaults : [];
      const preferences: RecentVaultsPreferences = {
        ...DEFAULT_PREFERENCES,
        ...(obj.preferences ?? {}),
      };
      return { vaults, preferences };
    }
    return { vaults: [], preferences: { ...DEFAULT_PREFERENCES } };
  } catch (parseErr) {
    logMainError('recentVaults.parse', parseErr);
    return { vaults: [], preferences: { ...DEFAULT_PREFERENCES } };
  }
}

async function writeFile(data: RecentVaultsFile): Promise<void> {
  // Phase 21 / M27 — atomic write so a crash mid-save can't leave the
  // recent-vaults list as a half-written JSON blob that fails to parse
  // on next launch.
  await atomicWriteFile(getRecentVaultsPath(), JSON.stringify(data, null, 2));
}

// Phase 8 / 8.5 — two-stage cap:
//   1. unpinned entries are pruned to `MAX_UNPINNED` (most-recent first);
//   2. if the combined list still exceeds `MAX_TOTAL`, pinned entries are
//      pruned in lastOpened order so the user keeps the pins they touched
//      most recently. Pinned-pruning is rare in practice (it triggers
//      only when a user has more than 40 pinned vaults) but the ceiling
//      defends against an unbounded file growing without limit.
function trimVaults(vaults: RecentVault[]): RecentVault[] {
  const pinned = vaults
    .filter((v) => v.pinned)
    .sort((a, b) => b.lastOpened - a.lastOpened);
  const unpinned = vaults
    .filter((v) => !v.pinned)
    .sort((a, b) => b.lastOpened - a.lastOpened)
    .slice(0, MAX_UNPINNED);
  const combined = [...pinned, ...unpinned];
  if (combined.length <= MAX_TOTAL) return combined;
  // Pinned + unpinned still over the ceiling — drop the least-recently
  // opened pins so a pinned-bloat scenario can't grow the file unbounded.
  // Unpinned was already capped at MAX_UNPINNED above; the overflow can
  // only come from too-many-pinned.
  const allowedPinned = Math.max(0, MAX_TOTAL - unpinned.length);
  return [...pinned.slice(0, allowedPinned), ...unpinned];
}

export async function loadRecentVaults(): Promise<RecentVault[]> {
  const file = await readFile();
  return file.vaults;
}

export async function loadPreferences(): Promise<RecentVaultsPreferences> {
  const file = await readFile();
  return file.preferences;
}

export async function setOpenLastVaultOnLaunch(enabled: boolean): Promise<void> {
  const file = await readFile();
  file.preferences.openLastVaultOnLaunch = enabled;
  await writeFile(file);
}

/**
 * Adds or bumps a vault in the recent list. Preserves the existing `pinned`
 * flag if the path is already present.
 */
export async function addRecentVault(path: string, name: string): Promise<RecentVault[]> {
  const file = await readFile();
  const existing = file.vaults.find((r) => r.path === path);
  const filtered = file.vaults.filter((r) => r.path !== path);
  filtered.unshift({ path, name, lastOpened: Date.now(), pinned: existing?.pinned });
  file.vaults = trimVaults(filtered);
  await writeFile(file);
  return file.vaults;
}

export async function removeRecentVault(path: string): Promise<RecentVault[]> {
  const file = await readFile();
  file.vaults = file.vaults.filter((r) => r.path !== path);
  await writeFile(file);
  return file.vaults;
}

export async function pinRecentVault(path: string, pinned: boolean): Promise<RecentVault[]> {
  const file = await readFile();
  file.vaults = trimVaults(file.vaults.map((v) => (v.path === path ? { ...v, pinned } : v)));
  await writeFile(file);
  return file.vaults;
}

/**
 * Clears the recent list. Pinned entries survive — the user explicitly
 * asked to clear *recents*, not their deliberate pins.
 */
export async function clearRecentVaults(): Promise<RecentVault[]> {
  const file = await readFile();
  file.vaults = file.vaults.filter((v) => v.pinned);
  await writeFile(file);
  return file.vaults;
}

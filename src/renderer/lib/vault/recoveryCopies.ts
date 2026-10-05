/**
 * The copies Filo keeps in `.filo/recovery/`, as Settings → Recovery and the
 * vault-open notice show them.
 *
 * Every kind is announced when it is made: a kept version by the Reload,
 * Keep mine or conversion notice, a rescue copy by the leave dialog (or, after
 * a shutdown, the recovery list at the next open), a load-failure snapshot by
 * the board-load or duplicate-board notice. So the open notice names only the
 * load-failure snapshots this open made that no other notice named (a safety
 * net: today every one is named), never the copies already there, which
 * Settings → Recovery lists instead.
 */
import type { ChannelResult } from '@shared/ipcContracts';
import { vaultPath } from '@shared/vaultPath';
import { normalizePath, toVaultRelative } from '../utils/path';
import { reportError } from '../utils/errorBus';
import { uiStore } from '../../stores/ui.svelte';
import { openSettingsAt } from '../settings/settingsTabRequest.svelte';
import { isStillSameVault, type VaultIdentity } from './vaultIdentity';

export type RecoveryCopy = ChannelResult<'recovery:list'>[number];
export type RecoveryCopyKind = RecoveryCopy['kind'];

/** What each kind of copy is, in the order Settings → Recovery lists them. */
export const RECOVERY_KINDS: ReadonlyArray<{ kind: RecoveryCopyKind; title: string; about: string }> = [
  {
    kind: 'keep',
    title: 'Kept versions',
    about: 'The version of a note or board Filo replaced: on Reload or Keep mine, before Convert to UTF-8, or when a board was saved in the new format.',
  },
  {
    kind: 'unsaved',
    title: 'Rescue copies',
    about: "Changes that couldn't be saved when you closed the vault, opened another or quit anyway, or when Windows shut down.",
  },
  {
    kind: 'snapshot',
    title: 'Files that failed to load',
    about: "Copies of files Filo couldn't load, taken before anything could write over them. Filo keeps the newest 20 of each file, 100 in all.",
  },
  {
    kind: 'orphan-tmp',
    title: 'Partly written files',
    about: "What saves that didn't finish left behind, moved here when the vault opened.",
  },
];

/**
 * A copy folder's timestamp (`2026-10-01T10-00-00.000`, UTC, with `-keep` or
 * `-unsaved` after it) as epoch ms, or null when it isn't one.
 */
export function parseRecoveryTimestamp(timestamp: string): number | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(\.\d{1,3})?/.exec(timestamp);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}${m[5] ?? ''}Z`);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The name a copy was kept under, as the path it came from: the copy flattens
 * `Notes/Draft.md` to `Notes__Draft.md`, and Filo's own state `.filo/tags.json`
 * to `_filo__tags.json`.
 */
export function copyDisplayName(basename: string): string {
  const parts = basename.split('__');
  if (parts[0] === '_filo' && parts.length > 1) parts[0] = '.filo';
  return parts.join('/');
}

/** A copy's size as the Recovery tab shows it: bytes, KB or MB. */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return bytes === 1 ? '1 byte' : `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The load-failure snapshots this open made (folder timestamp at or after
 * `openedAt`) that no other notice of this open named (`announced`, absolute
 * or vault-relative paths).
 */
export function newLoadFailureSnapshots(
  copies: readonly RecoveryCopy[],
  vaultRoot: string,
  openedAt: number,
  announced: readonly string[],
): RecoveryCopy[] {
  const named = new Set(announced.map((p) => vaultPath(toVaultRelative(p, vaultRoot) ?? normalizePath(p))));
  return copies.filter((c) => {
    if (c.kind !== 'snapshot') return false;
    const at = parseRecoveryTimestamp(c.timestamp);
    return at !== null && at >= openedAt && !named.has(vaultPath(c.relPath));
  });
}

/** The vault-open notice for `snapshots` (all new; see {@link newLoadFailureSnapshots}). */
export function newSnapshotsNoticeText(snapshots: readonly RecoveryCopy[]): string {
  const shown = snapshots.slice(0, 8).map((s) => `• ${copyDisplayName(s.basename)}`).join('\n');
  const more = snapshots.length > 8 ? `\n…and ${snapshots.length - 8} more.` : '';
  const count = snapshots.length === 1 ? 'a file' : `${snapshots.length} files`;
  return `Filo couldn't load ${count}, so it kept ${snapshots.length === 1 ? 'a copy' : 'copies'} in .filo/recovery before anything could write over ${snapshots.length === 1 ? 'it' : 'them'}:\n${shown}${more}\nSettings → Recovery lists every copy Filo keeps.`;
}

/** What a vault open tells the open-time notice: when it began, and the snapshots its own notices already named. */
export interface OpenRecoveryContext {
  openedAt: number;
  announcedSnapshots: readonly string[];
}

/**
 * The vault-open notice for load-failure snapshots this open made that no
 * other notice named, with Show in folder and Open Recovery. Silent when
 * there are none, however many older copies `.filo/recovery` holds.
 */
export async function announceNewLoadFailureSnapshots(
  vaultRoot: string,
  identity: VaultIdentity,
  context: OpenRecoveryContext,
): Promise<void> {
  try {
    const copies = await window.filo.invoke('recovery:list', vaultRoot);
    if (!isStillSameVault(identity)) return;
    const fresh = newLoadFailureSnapshots(copies, vaultRoot, context.openedAt, context.announcedSnapshots);
    if (fresh.length === 0) return;
    const firstAbs = `${normalizePath(vaultRoot)}/${fresh[0]?.relPath ?? ''}`;
    uiStore.pushToast({
      text: newSnapshotsNoticeText(fresh),
      type: 'warning',
      duration: 0,
      actions: [
        { label: 'Show in folder', handler: () => void window.filo.invoke('shell:show-item-in-folder', firstAbs) },
        { label: 'Open Recovery', handler: () => openSettingsAt('recovery') },
      ],
    });
  } catch (err) {
    // `recovery:list` re-throws a real scan failure (EACCES/EBUSY on a locked
    // share) rather than returning an empty list.
    reportError(
      'vault.recovery-snapshots',
      err,
      "Couldn't read .filo/recovery, which may be locked. If recent edits are missing, look in it by hand.",
    );
  }
}

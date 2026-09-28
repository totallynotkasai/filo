/**
 * miscConfigDrift — the drift check for the `.filo/` files the misc writer
 * saves whole: `viewports.json`, `sidebar-order.json` and `hotkeys.json`.
 *
 * Each has a stat baseline from its load. Before a write, a file whose stat
 * moved since, that the open couldn't pin (unverified), or that loaded as
 * unreadable is read again, and its writer decides:
 *  - view state (camera positions, sidebar order) merges the other version
 *    into memory and writes the merge, without asking;
 *  - `hotkeys.json` asks Reload / Keep local, as the settings files do.
 * After a write the baseline moves to the bytes Filo wrote.
 */
import { IpcEnvelopeError } from '@shared/ipcEnvelope';
import { invokeOk } from '../utils/invokeOk';
import { writtenByteLength } from './boardWriteDebounce';
import { markRecentSelfWrite } from './writeStateTracking';
import { backupConfig, promptConfigDrift } from './configDrift';
import { clearCorruptConfigTarget, isConfigLoadFailed, isConfigPathCorrupt, markCorruptConfigTarget } from './configWriteScheduler';
import {
  baselineSeq,
  getBaseline,
  hasBaselineDrifted,
  isBaselineUnverified,
  noteBaseline,
  refreshBaselineAfterWrite,
} from '../vault/fileBaselineRegistry';

export type MiscConfigFile = 'viewports.json' | 'sidebar-order.json' | 'hotkeys.json';

/** What is on disk, when it isn't the version Filo last read or wrote. */
export type OutsideVersion =
  | { kind: 'none' }
  | {
      kind: 'changed';
      disk: Record<string, unknown>;
      /** Record the version read as the one Filo now knows (after a Reload). */
      adopt: () => void;
    };

function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * Reads `file` if it may hold a version Filo hasn't seen (`always`: the
 * watcher reported a change). Throws `EBUSY` (a retry can fix it) when it
 * can't be read, and `CONFIG_CORRUPT` when it isn't JSON (the file is left as
 * it is, and marked so).
 */
export async function readOutsideVersion(
  vaultRoot: string,
  file: MiscConfigFile,
  opts: { always?: boolean } = {},
): Promise<OutsideVersion> {
  const rel = `.filo/${file}`;
  const seq = baselineSeq(rel);
  const baseline = getBaseline(rel);
  const mustRead = opts.always === true || isBaselineUnverified(rel) || isConfigPathCorrupt(rel);
  if (!mustRead && baseline === undefined) return { kind: 'none' };
  let stat: { mtimeMs: number; size: number };
  try {
    stat = await invokeOk('vault:stat', vaultRoot, rel);
  } catch (err) {
    // Gone: nothing of anyone's to keep, so the write puts Filo's version back.
    if (err instanceof IpcEnvelopeError && err.code === 'ENOENT') {
      clearCorruptConfigTarget(file);
      return { kind: 'none' };
    }
    if (!mustRead) return { kind: 'none' };
    throw codedError(`Couldn't check ${rel} before saving.`, 'EBUSY');
  }
  if (!mustRead && baseline && !hasBaselineDrifted(baseline, stat)) return { kind: 'none' };
  const loaded: unknown = await window.filo.invoke('config:load', vaultRoot, file);
  if (!loaded || typeof loaded !== 'object' || isConfigLoadFailed(loaded)) {
    throw codedError(`Couldn't read ${rel} to check it before saving.`, 'EBUSY');
  }
  if ('__corrupt' in loaded) {
    markCorruptConfigTarget(file);
    throw codedError(`${rel} is unreadable on disk, so Filo isn't saving over it.`, 'CONFIG_CORRUPT');
  }
  clearCorruptConfigTarget(file);
  return {
    kind: 'changed',
    disk: loaded as Record<string, unknown>,
    adopt: () => noteBaseline(rel, stat.mtimeMs, stat.size, { ifUnchangedSince: seq }),
  };
}

/**
 * Settles another version of a file the user decides about (`hotkeys.json`).
 * Returns `write` when Filo's version goes on disk (Keep local, after a copy of
 * the other one), or `adopted` when the disk version is now Filo's (Reload,
 * or it already says what Filo would write). Throws `EXTERNAL_EDIT` while the
 * user hasn't decided, so nothing is written over the file.
 */
export async function settleOutsideVersion(args: {
  vaultRoot: string;
  file: MiscConfigFile;
  outside: Extract<OutsideVersion, { kind: 'changed' }>;
  json: string;
  reload: (disk: Record<string, unknown>) => void;
}): Promise<'write' | 'adopted'> {
  const { vaultRoot, file, outside, json, reload } = args;
  const rel = `.filo/${file}`;
  if (JSON.stringify(outside.disk, null, 2) === json) {
    outside.adopt();
    return 'adopted';
  }
  const choice = file === 'hotkeys.json' ? await promptConfigDrift(file) : 'defer';
  if (choice === 'keep-local') {
    if (!(await backupConfig(vaultRoot, rel))) {
      throw codedError(`${rel} was changed outside Filo, and Filo couldn't copy that version before overwriting it.`, 'EXTERNAL_EDIT');
    }
    outside.adopt();
    return 'write';
  }
  if (choice === 'reload') {
    reload(outside.disk);
    outside.adopt();
    return 'adopted';
  }
  throw codedError(`${rel} was changed outside Filo; your change wasn't saved over it.`, 'EXTERNAL_EDIT');
}

/**
 * Writes `json` to `file` and moves the baseline to it. The baseline moves
 * only when the size on disk is the size written, so a foreign write in the
 * gap is still found by the next check.
 */
export async function saveMiscConfig(vaultRoot: string, file: MiscConfigFile, json: string): Promise<void> {
  const rel = `.filo/${file}`;
  // Marked before the IPC too: the watcher's echo can arrive before it returns.
  markRecentSelfWrite(rel);
  await invokeOk('config:save', vaultRoot, file, json);
  markRecentSelfWrite(rel);
  try {
    const stat = await invokeOk('vault:stat', vaultRoot, rel);
    if (stat.size === writtenByteLength(json)) refreshBaselineAfterWrite(rel, stat.mtimeMs, stat.size);
    else refreshBaselineAfterWrite(rel, undefined, undefined);
  } catch {
    refreshBaselineAfterWrite(rel, undefined, undefined);
  }
}

/** A JSON object's own entries, keeping only those `keep` accepts. */
export function objectEntries<T>(value: unknown, keep: (v: unknown) => v is T): Array<[string, T]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value).filter((entry): entry is [string, T] => keep(entry[1]));
}

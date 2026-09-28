/**
 * configDrift — what a `.filo/` config write does when the file on disk is no
 * longer the one Filo last wrote or loaded.
 *
 * These files belong to Filo, so an outside change never blocks their saves
 * for the rest of the session:
 *  - the bytes are Filo's own (a sync client re-wrote them, a touch): the
 *    baseline moves on silently and the write goes ahead;
 *  - layout state (`workspace.json`): Filo's layout wins, after a copy of the
 *    other version goes to `.filo/recovery/`, with one info toast;
 *  - settings (`app.json`, `defaults.json`, `appearance.json`): the user
 *    chooses Reload (Filo takes the file's settings) or Keep local (a copy of
 *    the file first, then Filo's settings are written);
 *  - the file was deleted: it is created again (exclusively, so a copy put
 *    back meanwhile is never overwritten), with one info toast.
 */
import { invokeOk } from '../utils/invokeOk';
import { IpcEnvelopeError } from '@shared/ipcEnvelope';
import { baselineSeq, getBaseline, hasBaselineDrifted, isBaselineUnverified, noteBaseline } from '../vault/fileBaselineRegistry';
import { ENOENT_RESTAT_DELAY_MS } from './boardWriteDebounce';

/** The config files the bundle writes, by their name in `.filo/`. */
export type BundledConfigFile = 'workspace.json' | 'defaults.json' | 'app.json' | 'appearance.json';

/** The config files a change outside Filo asks about: the settings, and the shortcuts. */
export type PromptedConfigFile = BundledConfigFile | 'hotkeys.json';

export type ConfigDriftChoice = 'reload' | 'keep-local' | 'defer';

/** Store-side answers the lib layer can't give itself (toasts, settings). */
export interface ConfigExternalHandlers {
  /** Ask Reload / Keep local for a settings file changed outside Filo. */
  prompt(file: PromptedConfigFile): Promise<ConfigDriftChoice>;
  /** Take the file's settings into memory. False when they can't be applied. */
  reload(file: BundledConfigFile, disk: Record<string, unknown>): boolean;
  /** One info toast per `key` per vault session. */
  notice(key: string, text: string): void;
}

// allow-module-state: set once at startup by registerDriftPromptHandlers; stateless across vaults
let handlers: ConfigExternalHandlers | null = null;

export function setConfigExternalHandlers(next: ConfigExternalHandlers | null): void {
  handlers = next;
}

/** Ask Reload / Keep local for `file` (`defer` before the handlers are set). */
export function promptConfigDrift(file: PromptedConfigFile): Promise<ConfigDriftChoice> {
  return handlers ? handlers.prompt(file) : Promise.resolve('defer');
}

/** One info toast per `key` per vault session (none before the handlers are set). */
export function noticeConfig(key: string, text: string): void {
  handlers?.notice(key, text);
}

/** What the write should do for one config file. */
export type ConfigDiskVerdict =
  /** Write the payload (the disk holds nothing Filo would lose). */
  | { kind: 'write' }
  /** Don't write: the disk already holds `json`, which is now the last written copy. */
  | { kind: 'adopted'; json: string }
  /** The file was deleted outside Filo: create it again, exclusively. */
  | { kind: 'recreate' }
  /** Don't write, and report the failure. */
  | { kind: 'fail'; error: Error };

function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

type StatResult = { mtimeMs: number; size: number } | 'missing' | 'error';

async function statConfig(vaultRoot: string, rel: string): Promise<StatResult> {
  try {
    return await invokeOk('vault:stat', vaultRoot, rel);
  } catch (err) {
    return err instanceof IpcEnvelopeError && err.code === 'ENOENT' ? 'missing' : 'error';
  }
}

interface DiskConfig {
  /** Re-serialised in the canonical form the scheduler writes. */
  json?: string;
  object?: Record<string, unknown>;
  /** Couldn't be read right now (a lock, a sync client). */
  unreadable?: boolean;
}

async function readConfig(vaultRoot: string, file: BundledConfigFile): Promise<DiskConfig> {
  try {
    const loaded: unknown = await window.filo.invoke('config:load', vaultRoot, file);
    if (!loaded || typeof loaded !== 'object') return { unreadable: true };
    if ((loaded as { __loadFailed?: unknown }).__loadFailed === true) return { unreadable: true };
    // Not valid JSON: foreign bytes with no settings to take.
    if ('__corrupt' in loaded) return {};
    return { json: JSON.stringify(loaded, null, 2), object: loaded as Record<string, unknown> };
  } catch {
    return { unreadable: true };
  }
}

/** Copy the file's current bytes to `.filo/recovery/<ts>-keep/`. True when there is a copy (or nothing to copy). */
export async function backupConfig(vaultRoot: string, rel: string): Promise<boolean> {
  try {
    await invokeOk('recovery:snapshot', vaultRoot, rel, 'keep');
    return true;
  } catch (err) {
    return err instanceof IpcEnvelopeError && err.code === 'ENOENT';
  }
}

/**
 * Decides what the write of `file` does, given what is on disk now.
 * `lastWritten` is the payload Filo last wrote or loaded for it.
 */
export async function checkConfigDisk(args: {
  vaultRoot: string;
  file: BundledConfigFile;
  payload: string;
  lastWritten: string | undefined;
}): Promise<ConfigDiskVerdict> {
  const { vaultRoot, file, payload, lastWritten } = args;
  const rel = `.filo/${file}`;
  const baseline = getBaseline(rel);
  // A file the open couldn't pin (it changed while being read, or couldn't be
  // read) is checked as if it had drifted.
  const unverified = isBaselineUnverified(rel);
  // No baseline: the file was never seen on disk (a first write).
  if (baseline === undefined && !unverified) return { kind: 'write' };
  const seq = baselineSeq(rel);

  let stat = await statConfig(vaultRoot, rel);
  // A file deleted and put back can carry the old mtime and size, so its
  // bytes are checked even when the stat matches.
  let cameBack = false;
  if (stat === 'missing') {
    // A sync client or antivirus can unlink a file and put it straight back.
    await new Promise((resolve) => setTimeout(resolve, ENOENT_RESTAT_DELAY_MS));
    stat = await statConfig(vaultRoot, rel);
    if (stat === 'missing') return { kind: 'recreate' };
    cameBack = true;
  }
  if (stat === 'error') {
    // Kept for a retry: an unverified file may hold settings Filo never read.
    if (unverified) return { kind: 'fail', error: codedError(`Couldn't check ${rel} before saving.`, 'EBUSY') };
    // Another stat error: let the save report the real IO problem.
    return { kind: 'write' };
  }
  const drifted = baseline === undefined || unverified || hasBaselineDrifted(baseline, stat);
  if (!drifted && !cameBack) return { kind: 'write' };

  const disk = await readConfig(vaultRoot, file);
  if (disk.unreadable) {
    // Unchanged stamp: nothing says it isn't Filo's file.
    if (!drifted) return { kind: 'write' };
    // Kept for a retry: it may read fine once the lock is gone.
    return { kind: 'fail', error: codedError(`Couldn't read ${rel} to check it before saving.`, 'EBUSY') };
  }
  if (disk.json !== undefined && (disk.json === lastWritten || disk.json === payload)) {
    // Filo's own bytes with a new stamp: nothing of anyone else's to protect.
    noteBaseline(rel, stat.mtimeMs, stat.size, { ifUnchangedSince: seq });
    return disk.json === payload ? { kind: 'adopted', json: payload } : { kind: 'write' };
  }

  if (file === 'workspace.json') {
    // Layout state: Filo's layout wins; the other version is kept.
    const copied = await backupConfig(vaultRoot, rel);
    noteBaseline(rel, stat.mtimeMs, stat.size, { ifUnchangedSince: seq });
    handlers?.notice(
      `config-layout:${file}`,
      copied
        ? `${rel} was changed outside Filo. Filo kept its own tab and pane layout; the other version is saved in .filo/recovery/.`
        : `${rel} was changed outside Filo. Filo kept its own tab and pane layout.`,
    );
    return { kind: 'write' };
  }

  const choice = handlers ? await handlers.prompt(file) : 'defer';
  if (choice === 'keep-local') {
    if (!(await backupConfig(vaultRoot, rel))) {
      return {
        kind: 'fail',
        error: codedError(`${rel} was changed outside Filo, and Filo couldn't copy that version before overwriting it.`, 'EXTERNAL_EDIT'),
      };
    }
    noteBaseline(rel, stat.mtimeMs, stat.size, { ifUnchangedSince: seq });
    return { kind: 'write' };
  }
  if (choice === 'reload' && disk.object && disk.json !== undefined && handlers?.reload(file, disk.object)) {
    noteBaseline(rel, stat.mtimeMs, stat.size, { ifUnchangedSince: seq });
    return { kind: 'adopted', json: disk.json };
  }
  return { kind: 'fail', error: codedError(`${rel} was changed outside Filo; your change wasn't saved over it.`, 'EXTERNAL_EDIT') };
}

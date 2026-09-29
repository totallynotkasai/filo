/**
 * configDriftHold — `.filo/` settings and shortcut files whose write waits for
 * a Reload / Keep local answer.
 *
 * A settings file (`app.json`, `defaults.json`, `appearance.json`) or
 * `hotkeys.json` changed outside Filo while Filo has a change of its own for
 * it is a question only the user can answer. The writer never waits for it:
 * it holds the file, asks, and refuses at once with `ConfigDriftHeldError`,
 * which the scheduler keeps (retained, not re-fired) until the answer is in.
 * A quit, a Ctrl+S or a Retry then reaches "waiting for your decision" in
 * moments, instead of waiting out the prompt and reporting a failed save.
 *
 *  - Keep local: the other version is copied to `.filo/recovery/<ts>-keep/`,
 *    the baseline moves to it, and the held write is re-fired.
 *  - Reload: the file is read into memory, and the held write of it is dropped.
 *  - Dismissed: the file stays held; the save indicator lists it as a
 *    decision, and a new change to the same file asks again.
 *
 * The files are fixed names under `.filo/`, so a hold never follows a rename.
 */
import { vaultPath } from '@shared/vaultPath';
import { invokeOk } from '../utils/invokeOk';
import { reportError } from '../utils/errorBus';
import { backupConfig, promptConfigDrift, type ConfigDriftChoice, type PromptedConfigFile } from './configDrift';
import { baselineSeq, noteBaseline } from '../vault/fileBaselineRegistry';
import { holdDecision, releaseDecision } from '../../stores/heldDecisions';
import { registerResetCallback, registerTestResetCallback } from './writeStateTracking';

/** What a held file's writer does with an answer. Registered by each writer. */
export interface ConfigDriftTarget {
  /** The unsaved-work path its failed write is tracked under (the settings bundle: `.filo/`). */
  ledgerPath: string;
  /** Takes the file's content into memory (Reload); false when it can't be applied. */
  reload(disk: Record<string, unknown>, json: string): boolean;
  /** Carries on once the file is released: re-fire the held write, or drop it after a Reload. */
  resume(choice: 'reload' | 'keep-local', vaultRoot: string): void;
}

interface ConfigDriftHold {
  readonly id: number;
  readonly file: PromptedConfigFile;
  readonly vaultRoot: string;
  /** The change the question was last asked for; a different one asks again. */
  askedFor: string;
}

// allow-module-state: stateless across vaults (each writer registers its files once, at module load)
const targets = new Map<PromptedConfigFile, ConfigDriftTarget>();
// allow-module-state: reset via registerResetCallback (vault swap)
const holds = new Map<PromptedConfigFile, ConfigDriftHold>();
// allow-module-state: reset via registerResetCallback (vault swap)
const resolutions = new Map<PromptedConfigFile, Promise<ConfigDriftChoice>>();
// allow-module-state: a monotonic counter for decision keys
let nextId = 1;

export function registerConfigDriftTarget(file: PromptedConfigFile, target: ConfigDriftTarget): void {
  targets.set(file, target);
}

/** Refused because the file's write waits for a Reload / Keep local answer. */
export class ConfigDriftHeldError extends Error {
  readonly code = 'CONFIG_DRIFT_HELD';
  constructor(file: PromptedConfigFile) {
    super(`.filo/${file} was changed outside Filo; its write waits for Reload or Keep local.`);
    this.name = 'ConfigDriftHeldError';
  }
}

export function isConfigDriftHeld(file: PromptedConfigFile): boolean {
  return holds.has(file);
}

/** The held files whose failed write is tracked under `ledgerPath` (any spelling). */
export function configDriftHeldFiles(ledgerPath: string): PromptedConfigFile[] {
  const key = vaultPath(ledgerPath);
  return [...holds.keys()].filter((file) => {
    const target = targets.get(file);
    return target !== undefined && vaultPath(target.ledgerPath) === key;
  });
}

/**
 * Holds `file` for an answer and asks, without waiting: once for the change
 * `payload`, and again only for a different change. Throws the refusal the
 * writer passes on to its scheduler.
 */
export function refuseHeldConfigWrite(file: PromptedConfigFile, vaultRoot: string, payload: string): never {
  const hold = holds.get(file);
  if (!hold) {
    const next: ConfigDriftHold = { id: nextId++, file, vaultRoot, askedFor: payload };
    holds.set(file, next);
    holdConfigDecision(next);
    void resolveConfigDrift(file);
  } else if (hold.askedFor !== payload) {
    hold.askedFor = payload;
    void resolveConfigDrift(file);
  }
  throw new ConfigDriftHeldError(file);
}

function releaseConfigDrift(hold: ConfigDriftHold): void {
  if (holds.get(hold.file) !== hold) return;
  holds.delete(hold.file);
  releaseDecision(decisionKey(hold));
}

/**
 * Asks once for `file` and carries out the answer. Resolves to what happened:
 * 'reload' / 'keep-local' only when it was carried out, else 'defer' (the file
 * stays held).
 */
export function resolveConfigDrift(file: PromptedConfigFile): Promise<ConfigDriftChoice> {
  const existing = resolutions.get(file);
  if (existing) return existing;
  const resolution = (async (): Promise<ConfigDriftChoice> => {
    const hold = holds.get(file);
    if (!hold) return 'defer';
    const choice = await promptConfigDrift(file);
    // Released meanwhile, or the vault was let go.
    if (holds.get(file) !== hold || choice === 'defer') return 'defer';
    const target = targets.get(file);
    const done = choice === 'keep-local' ? await keepLocal(hold) : await reload(hold, target);
    if (!done || holds.get(file) !== hold) return 'defer';
    releaseConfigDrift(hold);
    try {
      target?.resume(choice, hold.vaultRoot);
    } catch (err) {
      console.error(`[configDriftHold] resuming the write of ${file} failed:`, err);
    }
    return choice;
  })();
  resolutions.set(file, resolution);
  void resolution.finally(() => {
    if (resolutions.get(file) === resolution) resolutions.delete(file);
  });
  return resolution;
}

async function statOrNull(vaultRoot: string, rel: string): Promise<{ mtimeMs: number; size: number } | null> {
  try {
    return await invokeOk('vault:stat', vaultRoot, rel);
  } catch {
    return null;
  }
}

/** Keep local: copy the other version, then move the baseline to it. */
async function keepLocal(hold: ConfigDriftHold): Promise<boolean> {
  const rel = `.filo/${hold.file}`;
  const seq = baselineSeq(rel);
  const stat = await statOrNull(hold.vaultRoot, rel);
  if (!(await backupConfig(hold.vaultRoot, rel))) {
    reportError('configDrift.keepLocal', null, `Filo couldn't copy ${rel} to .filo/recovery/, so it didn't save over it. Try again from the save indicator.`);
    return false;
  }
  if (stat) noteBaseline(rel, stat.mtimeMs, stat.size, { ifUnchangedSince: seq });
  return true;
}

/** Reload: read the file into memory; the baseline moves to the version read. */
async function reload(hold: ConfigDriftHold, target: ConfigDriftTarget | undefined): Promise<boolean> {
  const rel = `.filo/${hold.file}`;
  const seq = baselineSeq(rel);
  const stat = await statOrNull(hold.vaultRoot, rel);
  let loaded: unknown;
  try {
    loaded = await window.filo.invoke('config:load', hold.vaultRoot, hold.file);
  } catch {
    loaded = null;
  }
  const readable =
    !!loaded && typeof loaded === 'object' && !('__corrupt' in loaded) && (loaded as { __loadFailed?: unknown }).__loadFailed !== true;
  if (!readable || !target) {
    reportError('configDrift.reload', null, `Filo couldn't read ${rel}, so your version is kept for now. Try again from the save indicator.`);
    return false;
  }
  const disk = loaded as Record<string, unknown>;
  if (!target.reload(disk, JSON.stringify(disk, null, 2))) return false;
  if (stat) noteBaseline(rel, stat.mtimeMs, stat.size, { ifUnchangedSince: seq });
  return true;
}

const decisionKey = (hold: ConfigDriftHold): string => `config-drift:${hold.id}`;

/**
 * Lists the held file under the save indicator until it is answered, so a
 * dismissed question can be shown again, and quit says it is waiting for a
 * decision rather than that the save failed.
 */
function holdConfigDecision(hold: ConfigDriftHold): void {
  holdDecision({
    key: decisionKey(hold),
    relPath: () => `.filo/${hold.file}`,
    ledgerPath: () => targets.get(hold.file)?.ledgerPath ?? `.filo/${hold.file}`,
    text: 'Changed outside Filo: Reload or Keep local',
    stillHeld: () => holds.get(hold.file) === hold,
    reopen: () => void resolveConfigDrift(hold.file),
  });
}

/** Test-only: waits for every question being asked or carried out. */
export async function __configDriftSettledForTests(): Promise<void> {
  while (resolutions.size > 0) await Promise.all([...resolutions.values()]);
}

function clearHolds(): void {
  holds.clear();
  resolutions.clear();
}
registerResetCallback(clearHolds);
registerTestResetCallback(clearHolds);

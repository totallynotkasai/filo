/**
 * configBaselineSeed — drift baselines for `.filo/` configs read at open.
 *
 * A baseline says "this is the version Filo read". A stat taken seconds after
 * the read can't say that: a sync client may have written the file in
 * between, and the first save would then overwrite a version Filo never saw.
 * So each file is stat'ed before the read and again after it, and only a
 * file whose two stats match is stamped. Any other file that exists is marked
 * unverified, so its first write reads it before writing over it.
 */
import { IpcEnvelopeError } from '@shared/ipcEnvelope';
import { invokeOk } from '../utils/invokeOk';
import { reportError } from '../utils/errorBus';
import { baselineSeq, markBaselineUnverified, noteBaseline, type BaselineSeq } from './fileBaselineRegistry';

type ConfigStat = { mtimeMs: number; size: number } | 'missing' | 'error';

export interface ConfigStatTicket {
  seq: BaselineSeq;
  stat: ConfigStat;
}

async function statConfig(vaultRoot: string, rel: string): Promise<ConfigStat> {
  try {
    const stat = await invokeOk('vault:stat', vaultRoot, rel);
    // A bare-result IPC mock returns `undefined`: nothing to seed from, as
    // for a missing file (the writes go unguarded, as before any baseline).
    if (!stat || typeof stat.mtimeMs !== 'number' || typeof stat.size !== 'number') return 'missing';
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch (err) {
    if (err instanceof IpcEnvelopeError && err.code === 'ENOENT') return 'missing';
    reportError(
      'vault.config-baseline-seed',
      err,
      `Couldn't check ${rel} — Filo reads it again before its first save.`,
    );
    return 'error';
  }
}

/** Take each file's ticket and stat before the read that loads it. */
export async function statConfigsBeforeRead(
  vaultRoot: string,
  paths: readonly string[],
): Promise<Map<string, ConfigStatTicket>> {
  const out = new Map<string, ConfigStatTicket>();
  for (const rel of paths) {
    const seq = baselineSeq(rel);
    out.set(rel, { seq, stat: await statConfig(vaultRoot, rel) });
  }
  return out;
}

/**
 * After the read: stamp each file whose stat didn't move across it, and mark
 * any other file that exists unverified. Returns the stamped paths.
 */
export async function seedConfigBaselines(
  vaultRoot: string,
  before: Map<string, ConfigStatTicket>,
): Promise<string[]> {
  const seeded: string[] = [];
  for (const [rel, ticket] of before) {
    const after = await statConfig(vaultRoot, rel);
    if (after === 'missing') continue;
    const pinned =
      after !== 'error' &&
      typeof ticket.stat === 'object' &&
      ticket.stat.mtimeMs === after.mtimeMs &&
      ticket.stat.size === after.size;
    if (pinned) {
      noteBaseline(rel, after.mtimeMs, after.size, { ifUnchangedSince: ticket.seq });
      seeded.push(rel);
    } else {
      markBaselineUnverified(rel);
    }
  }
  return seeded;
}

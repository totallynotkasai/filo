/**
 * Writes `.filo/quit-failure.json` in the quit drain when the session
 * preserved one or more emergency files.
 *
 * A durable breadcrumb alongside the blocking "Save failed" quit confirm: if
 * any write preserved a partial file this session (see
 * {@link recordPreservedEmergencyFile}), persist the locations into the vault
 * so the NEXT launch can point the user
 * at the recoverable bytes (`readQuitFailureBreadcrumb` surfaces it on vault
 * open; `clearQuitFailureBreadcrumb` clears it once the user acknowledges).
 *
 * Best-effort by contract: the preserved partials are already on disk, so a
 * failed breadcrumb write (e.g. the disk is STILL full — the very condition
 * that created the emergency files) is logged, not fatal.
 */
import { promises as fs } from 'fs';
import { join, relative, isAbsolute } from 'path';
import { assertWithinVault } from '../utils/pathSecurity';
import { atomicWriteFile, ensureDir } from '../vault/filenameUtils';
import { logMainError } from '../utils/mainLogger';
import { listPreservedEmergencyFiles } from './emergencyFileRegistry';
import { getMachineIdentity } from './machineIdentity';
import { machineSentinelPath } from '../../shared/sentinelPaths';

/**
 * Vault-relative path of THIS machine's breadcrumb (per machine — the absolute `preservedPath`s only make sense on the machine
 * that wrote them, and another machine must never clear it).
 */
export function quitFailureRelPath(): string {
  return machineSentinelPath('quit-failure', getMachineIdentity().machineId);
}
export const QUIT_FAILURE_VERSION = 1;

/** True when `p` resolves inside `root` (pure path check, no fs access). */
function isWithin(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

interface BreadcrumbEntry {
  preservedPath: string;
  targetPath?: string;
  code?: string;
  at?: number;
}

/**
 * Entries of an earlier, still-unacknowledged breadcrumb whose preserved file
 * still exists. Absent or corrupt → `[]`. An entry whose file is gone was
 * already recovered or deleted by the user, so it isn't carried forward.
 */
async function readSurvivingPriorEntries(vaultRoot: string, destAbs: string): Promise<BreadcrumbEntry[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(destAbs, 'utf-8'));
  } catch {
    return [];
  }
  const files = (parsed as { files?: unknown } | null)?.files;
  if (!Array.isArray(files)) return [];
  const out: BreadcrumbEntry[] = [];
  for (const f of files) {
    const p = (f as { preservedPath?: unknown } | null)?.preservedPath;
    if (typeof p !== 'string' || !isWithin(vaultRoot, p)) continue;
    try {
      await fs.access(p);
    } catch {
      continue;
    }
    const e = f as Record<string, unknown>;
    out.push({
      preservedPath: p,
      ...(typeof e.targetPath === 'string' ? { targetPath: e.targetPath } : {}),
      ...(typeof e.code === 'string' ? { code: e.code } : {}),
      ...(typeof e.at === 'number' ? { at: e.at } : {}),
    });
  }
  return out;
}

/**
 * Writes `<vaultRoot>/.filo/quit-failure.json` if the session preserved any
 * emergency files that live inside `vaultRoot`. No-op when the registry is
 * empty, `vaultRoot` is null/empty, or no preserved file belongs to this
 * vault (e.g. the failure happened in a vault the user later swapped away
 * from — that vault's partials stay on disk but aren't recorded here).
 *
 * An earlier breadcrumb the user hasn't acknowledged yet is MERGED (union by
 * `preservedPath`), never overwritten: two failed quits in a row must still
 * point at both sets of partials.
 */
export async function writeQuitFailureBreadcrumb(vaultRoot: string | null): Promise<void> {
  if (!vaultRoot) return;
  // Only include partials that actually live in this vault — the registry is
  // process-wide and may carry entries from a vault the user swapped away from.
  const files = listPreservedEmergencyFiles().filter((f) => isWithin(vaultRoot, f.preservedPath));
  if (files.length === 0) return;
  try {
    const destAbs = join(vaultRoot, quitFailureRelPath());
    assertWithinVault(vaultRoot, destAbs);
    await ensureDir(join(vaultRoot, '.filo'));
    const merged = new Map<string, BreadcrumbEntry>();
    for (const e of await readSurvivingPriorEntries(vaultRoot, destAbs)) merged.set(e.preservedPath, e);
    for (const f of files) {
      merged.set(f.preservedPath, {
        preservedPath: f.preservedPath,
        targetPath: f.targetPath,
        code: f.code,
        at: f.at,
      });
    }
    const payload = {
      version: QUIT_FAILURE_VERSION,
      savedAt: new Date().toISOString(),
      machineId: getMachineIdentity().machineId,
      hostname: getMachineIdentity().hostname,
      files: [...merged.values()],
    };
    await atomicWriteFile(destAbs, JSON.stringify(payload, null, 2));
  } catch (err) {
    logMainError('emergencyFiles:writeQuitFailureBreadcrumb', err);
  }
}

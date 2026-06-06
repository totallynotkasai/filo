/**
 * 6.2.H4 (follow-up) — writes `.filo/quit-failure.json` in the quit drain
 * when the session preserved one or more emergency files.
 *
 * The earlier 6.2.H4 fix replaced the 200 ms-toast-then-quit with a blocking
 * "Save failed → Quit anyway / Stay" confirm — closing the silent-loss hole.
 * This adds the durable breadcrumb the plan also called for: if any write
 * preserved a partial file this session (see {@link recordPreservedEmergencyFile}),
 * persist the locations into the vault so the NEXT launch can point the user
 * at the recoverable bytes (`readQuitFailureBreadcrumb` surfaces it on vault
 * open; `clearQuitFailureBreadcrumb` clears it once the user acknowledges).
 *
 * Best-effort by contract: the preserved partials are already on disk, so a
 * failed breadcrumb write (e.g. the disk is STILL full — the very condition
 * that created the emergency files) is logged, not fatal.
 */
import { join, relative, isAbsolute } from 'path';
import { assertWithinVault } from '../utils/pathSecurity';
import { atomicWriteFile, ensureDir } from '../vault/filenameUtils';
import { logMainError } from '../utils/mainLogger';
import { listPreservedEmergencyFiles } from './emergencyFileRegistry';

/** Vault-relative path of the breadcrumb. Permitted in RENDERER_PERMITTED_FILO_PATHS. */
export const QUIT_FAILURE_REL_PATH = '.filo/quit-failure.json';
export const QUIT_FAILURE_VERSION = 1;

/** True when `p` resolves inside `root` (pure path check, no fs access). */
function isWithin(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Writes `<vaultRoot>/.filo/quit-failure.json` if the session preserved any
 * emergency files that live inside `vaultRoot`. No-op when the registry is
 * empty, `vaultRoot` is null/empty, or no preserved file belongs to this
 * vault (e.g. the failure happened in a vault the user later swapped away
 * from — that vault's partials stay on disk but aren't recorded here).
 */
export async function writeQuitFailureBreadcrumb(vaultRoot: string | null): Promise<void> {
  if (!vaultRoot) return;
  // Only include partials that actually live in this vault — the registry is
  // process-wide and may carry entries from a vault the user swapped away from.
  const files = listPreservedEmergencyFiles().filter((f) => isWithin(vaultRoot, f.preservedPath));
  if (files.length === 0) return;
  try {
    const destAbs = join(vaultRoot, QUIT_FAILURE_REL_PATH);
    assertWithinVault(vaultRoot, destAbs);
    await ensureDir(join(vaultRoot, '.filo'));
    const payload = {
      version: QUIT_FAILURE_VERSION,
      savedAt: new Date().toISOString(),
      files: files.map((f) => ({
        preservedPath: f.preservedPath,
        targetPath: f.targetPath,
        code: f.code,
        at: f.at,
      })),
    };
    await atomicWriteFile(destAbs, JSON.stringify(payload, null, 2));
  } catch (err) {
    logMainError('emergencyFiles:writeQuitFailureBreadcrumb', err);
  }
}

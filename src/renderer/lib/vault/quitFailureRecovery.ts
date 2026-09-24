/**
 * Reads / clears `.filo/quit-failure.json` on vault open.
 *
 * The main-side quit drain writes this breadcrumb when the session preserved
 * emergency partial files after a failed write (see
 * `main/services/quitFailureBreadcrumb`). On the next vault open we surface
 * the preserved locations so the user can recover the bytes.
 *
 * The READ and the CLEAR are deliberately SEPARATE. The recovery sequencer
 * reads the breadcrumb, surfaces the preserved locations, and clears it ONLY
 * when the user dismisses that toast, so a second crash before the user acts
 * re-surfaces the location next open. (The preserved `.tmp` partials remain
 * on disk regardless.)
 *
 * Same read/delete shape as the `.filo/.dirty` sentinel: a relative-path read
 * through `vault:read-file-text` (the handler resolves it against the active
 * vault) and an absolute-path delete through `vault:delete` (allowlisted for
 * `.filo/quit-failure.json` in `RENDERER_PERMITTED_FILO_PATHS`). This module
 * is exempt from the raw-disk-shape-IPC gate alongside the other sentinels —
 * the breadcrumb is internal recovery state, not user content.
 */
import { invokeOk } from '../utils/invokeOk';
import { IpcEnvelopeError } from '@shared/ipcEnvelope';
import { reportError } from '../utils/errorBus';
import { uiStore } from '../../stores/ui.svelte';
import { surveyForeignSentinels } from '../../stores/foreignSentinels.svelte';
import { isStillSameVault, type VaultIdentity } from './vaultIdentity';
import { readOwnSentinel, clearOwnSentinel } from './machineSentinels';


export interface QuitFailureFile {
  preservedPath: string;
  targetPath?: string;
  code?: string;
  at?: number;
}

export interface QuitFailureBreadcrumb {
  version: number;
  savedAt?: string;
  files: QuitFailureFile[];
}

/**
 * Reads + parses the breadcrumb (if any). Returns the parsed payload, or `null`
 * when there's nothing well-formed to surface (ENOENT / empty / malformed /
 * no usable file entries). Never throws — recovery is best-effort and must not
 * block vault open.
 *
 * Does NOT delete: the caller surfaces the locations and then calls
 * `clearQuitFailureBreadcrumb` once the user acknowledges, so the notice
 * survives a second crash before acknowledgement.
 */
export async function readQuitFailureBreadcrumb(
  vaultRoot: string,
): Promise<QuitFailureBreadcrumb | null> {
  if (!vaultRoot) return null;

  let content: string;
  try {
    // THIS machine's breadcrumb (its absolute paths only make sense here);
    // another machine's is listed only.
    const result = await readOwnSentinel(vaultRoot, 'quit-failure');
    content = result.content;
  } catch (err) {
    // ENOENT — the common case (no failed-write quit last session). Any other
    // read failure: stay silent (the partials are still on disk; nagging with
    // an unreadable-breadcrumb toast adds no recovery value).
    if (!(err instanceof IpcEnvelopeError && err.code === 'ENOENT')) {
      reportError(
        'quitFailure.read',
        err,
        "Couldn't read the quit-failure breadcrumb",
      );
    }
    return null;
  }

  if (!content) return null;
  try {
    const parsed = JSON.parse(content) as QuitFailureBreadcrumb;
    if (!parsed || !Array.isArray(parsed.files) || parsed.files.length === 0) return null;
    // Defensively keep only well-formed entries.
    const files = parsed.files.filter(
      (f): f is QuitFailureFile => !!f && typeof f.preservedPath === 'string',
    );
    if (files.length === 0) return null;
    return { version: parsed.version, savedAt: parsed.savedAt, files };
  } catch {
    return null;
  }
}

/**
 * Best-effort delete of the breadcrumb so the recovery notice surfaces once.
 * Called after the user dismisses/acknowledges the surfacing toast (NOT on
 * read). Never throws; ENOENT is the desired terminal state.
 */
export async function clearQuitFailureBreadcrumb(vaultRoot: string): Promise<void> {
  if (!vaultRoot) return;
  try {
    // This machine's breadcrumb only. Another machine's is never cleared
    // (main refuses it).
    await clearOwnSentinel(vaultRoot, 'quit-failure');
  } catch (err) {
    reportError(
      'quitFailure.clear',
      err,
      'Could not clear the quit-failure breadcrumb — the recovery notice may reappear next open',
    );
  }
}

/**
 * Asks main to MOVE orphaned atomic-write
 * temps (`*.<12hex>.tmp` / `*.case-rename-*`, older than 10 min, not listed by
 * any quit-failure breadcrumb) out of the synced vault into
 * `.filo/recovery/orphan-tmp/`. Called on vault open AFTER the breadcrumb has
 * been surfaced, so a listed partial is never moved from under the notice.
 * Best-effort: a failure is logged, never blocks the open.
 */
export async function sweepOrphanTempFiles(vaultRoot: string, captured: VaultIdentity): Promise<void> {
  if (!vaultRoot) return;
  try {
    const { moved } = await invokeOk('vault:sweep-orphan-tmp', vaultRoot);
    if (!isStillSameVault(captured) || moved.length === 0) return;
    uiStore.pushToast({
      text: `Filo moved ${moved.length} leftover temporary save file${moved.length === 1 ? '' : 's'} into .filo/recovery/orphan-tmp/. They may hold unsaved edits from an earlier failed save.`,
      type: 'info',
      duration: 10000,
    });
  } catch (err) {
    reportError('quitFailure.orphanSweep', err, "Couldn't tidy leftover temporary save files");
  }
}

/**
 * The vault-open checks that run right AFTER the quit-failure breadcrumb was
 * surfaced: move orphaned save temps out of the synced vault, then list other
 * machines' crash sentinels (informational).
 */
export async function runPostBreadcrumbChecks(vaultRoot: string, captured: VaultIdentity): Promise<void> {
  await sweepOrphanTempFiles(vaultRoot, captured);
  if (!isStillSameVault(captured)) return;
  await surveyForeignSentinels(vaultRoot, captured);
}

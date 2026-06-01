/**
 * 6.2.H4 (follow-up) — reads + clears `.filo/quit-failure.json` on vault open.
 *
 * The main-side quit drain writes this breadcrumb when the session preserved
 * emergency partial files after a failed write (see
 * `main/services/quitFailureBreadcrumb`). On the next vault open we surface
 * the preserved locations so the user can recover the bytes, then delete the
 * breadcrumb so the notice shows once.
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

const QUIT_FAILURE_PATH = '.filo/quit-failure.json';

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
 * Reads the breadcrumb (if any), deletes it, and returns the parsed payload —
 * or `null` when there's nothing to surface. Never throws: recovery is
 * best-effort and must not block vault open. The preserved partial files
 * remain on disk regardless of whether this read/clear succeeds.
 */
export async function consumeQuitFailureBreadcrumb(
  vaultRoot: string,
): Promise<QuitFailureBreadcrumb | null> {
  if (!vaultRoot) return null;

  let content: string;
  try {
    const result = await invokeOk('vault:read-file-text', vaultRoot, QUIT_FAILURE_PATH);
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

  // Best-effort clear so the notice surfaces once. Build the absolute path the
  // same way `dirtyFlagRecovery.markClean` does.
  const fullPath = `${vaultRoot}/${QUIT_FAILURE_PATH}`
    .replace(/\\/g, '/') // allow-inline-normalize: absolute breadcrumb path for vault:delete
    .replace(/\/+/g, '/');
  try {
    // allow-disk-shape-ipc: clearing the `.filo/quit-failure.json` recovery
    // breadcrumb — internal state, not user content (peer of the sentinels).
    await invokeOk('vault:delete', vaultRoot, fullPath);
  } catch (err) {
    if (!(err instanceof IpcEnvelopeError && err.code === 'ENOENT')) {
      reportError(
        'quitFailure.clear',
        err,
        'Could not clear the quit-failure breadcrumb — the recovery notice may reappear next open',
      );
    }
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

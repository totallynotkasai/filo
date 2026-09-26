import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  trackComponentWrite,
  setWriteErrorListener,
  setWriteStateListener,
  __resetDirtyTrackingForTests,
  type WriteErrorInfo,
  type WriteStateInfo,
} from '@renderer/lib/boards/boardSaver';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Phase 1 (P0-3) regression guard: the editor write sites (TextTile,
 * DocumentEditor) now route through the new
 * `vault:write-existing-file-text` IPC channel. When the channel reports
 * ENOENT the writers must:
 *
 *   1. Treat the ENOENT as a permanent terminal state — NOT a transient
 *      write failure — so trackComponentWrite does NOT mark the path
 *      as failed (would otherwise stay dirty in the sentinel forever).
 *   2. Surface a toast via errorBus (covered by the editor components).
 *   3. Disarm further writes for that doc (component-local flag).
 *
 * Other failure codes (IO_ERROR, EACCES) keep their previous behaviour:
 * trackComponentWrite catches the thrown error, records the failure, and
 * the write-error listener fires.
 *
 * The unit under test is the contract between the editor writers and
 * `trackComponentWrite` — we mimic the editor flow with a small local
 * helper rather than mounting the Svelte component, since the Svelte
 * write path is itself a thin wrapper around this contract.
 */

async function attemptExistingFileWrite(
  vaultRoot: string,
  relPath: string,
  content: string,
): Promise<{ ok: boolean; missing: boolean }> {
  let missing = false;
  let ok = false;
  await trackComponentWrite(vaultRoot, relPath, async () => {
    const result = (await window.filo.invoke(
      'vault:write-existing-file-text',
      vaultRoot,
      relPath,
      content,
    )) as { success?: boolean; code?: string; error?: string } | undefined;
    if (result && result.success === false) {
      if (result.code === 'ENOENT') {
        missing = true;
        return;
      }
      throw new Error(result.error ?? `Write failed: ${result.code ?? 'IO_ERROR'}`);
    }
    ok = true;
  });
  return { ok, missing };
}

describe('vault:write-existing-file-text — ENOENT contract', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
  });
  afterEach(() => {
    __resetDirtyTrackingForTests();
    restoreFiloDefault();
    setWriteErrorListener(null);
    setWriteStateListener(null);
  });

  it('does NOT mark the path as failed when the IPC reports ENOENT', async () => {
    installFiloMock({
      'vault:write-existing-file-text': () => ({
        success: false,
        code: 'ENOENT',
        error: 'file no longer exists',
      }),
    });

    const states: WriteStateInfo[] = [];
    setWriteStateListener((info) => states.push({ ...info }));
    const errors: WriteErrorInfo[] = [];
    setWriteErrorListener((info) => errors.push(info));

    const { ok, missing } = await attemptExistingFileWrite('/vault', 'Notes/foo.md', 'body');
    expect(ok).toBe(false);
    expect(missing).toBe(true);

    // No write-error listener fired — ENOENT is a permanent state, not a
    // transient failure that needs a user-visible "couldn't save" toast
    // from the boardSaver pipeline. The editor's own reportError handles
    // surfacing it once.
    expect(errors).toEqual([]);

    // The path leaves the inflight set without entering failedVaultPaths.
    // Phase C / C.10 — WriteStateInfo gained `failedPaths`; pin only the
    // counter shape via toMatchObject.
    expect(states[states.length - 1]).toMatchObject({ inflight: 0, failed: 0 });
  });

  it('treats non-ENOENT IPC failure as a tracked write error', async () => {
    installFiloMock({
      'vault:write-existing-file-text': () => ({
        success: false,
        code: 'EACCES',
        error: 'permission denied',
      }),
    });

    const errors: WriteErrorInfo[] = [];
    setWriteErrorListener((info) => errors.push(info));
    const states: WriteStateInfo[] = [];
    setWriteStateListener((info) => states.push({ ...info }));

    await expect(
      attemptExistingFileWrite('/vault', 'Notes/foo.md', 'body'),
    ).rejects.toThrow(/permission denied/);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ kind: 'component', path: 'Notes/foo.md' });
    // Path lands in failedVaultPaths so the sentinel stays dirty until retry.
    expect(states[states.length - 1]).toMatchObject({ inflight: 0, failed: 1 });
  });

  it('records a clean write on success', async () => {
    installFiloMock({
      'vault:write-existing-file-text': () => ({ success: true, path: '/vault/Notes/foo.md' }),
    });

    const errors: WriteErrorInfo[] = [];
    setWriteErrorListener((info) => errors.push(info));
    const states: WriteStateInfo[] = [];
    setWriteStateListener((info) => states.push({ ...info }));

    const { ok, missing } = await attemptExistingFileWrite('/vault', 'Notes/foo.md', 'body');
    expect(ok).toBe(true);
    expect(missing).toBe(false);
    expect(errors).toEqual([]);
    expect(states[states.length - 1]).toMatchObject({ inflight: 0, failed: 0 });
  });
});

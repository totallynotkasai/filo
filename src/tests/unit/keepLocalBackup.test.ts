/**
 * Audit-19 UX-6 (plan D7) — "Keep local" backs up the external version to
 * `.filo/recovery/` BEFORE the overwrite. Pre-fix the drift gate's keep-local
 * branch went straight to `vault:write-existing-file-text`, destroying the
 * other device's edit with no copy anywhere.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  writeMarkdownFile,
  markHydrated,
  setExternalEditPromptHandler,
  __resetMarkdownFileWriterForTests,
} from '@renderer/lib/vault/markdownFileWriter';
import { __resetDirtyTrackingForTests, isPathPending } from '@renderer/lib/boards/writeStateTracking';
import { __resetBaselinesForTests } from '@renderer/lib/vault/fileBaselineRegistry';
import {
  backupExternalVersion,
  __resetKeepLocalBackupForTests,
} from '@renderer/lib/vault/keepLocalBackup';
import { uiStore } from '@renderer/stores/ui.svelte';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

type Call = { channel: string; args: unknown[] };

function installDisk(opts: {
  snapshot?: (rel: string) => unknown;
  stat?: () => unknown;
} = {}): Call[] {
  const calls: Call[] = [];
  installFiloMock((channel: unknown, ...args: unknown[]) => {
    calls.push({ channel: channel as string, args });
    if (channel === 'vault:stat') return opts.stat ? opts.stat() : { success: true, mtimeMs: 200, size: 20 };
    if (channel === 'recovery:snapshot') {
      return opts.snapshot
        ? opts.snapshot(args[1] as string)
        : { ok: true, path: '/vault/.filo/recovery/2026-09-23T10-02-11.123/Note.md' };
    }
    if (channel === 'vault:write-existing-file-text') return { success: true };
    if (channel === 'vault:read-file-text') return { success: true, content: 'body', mtimeMs: 200, size: 20 };
    return undefined;
  });
  return calls;
}

function clearToasts(): void {
  for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
}

describe('Audit-19 UX-6 — Keep local backs up the external version first', () => {
  beforeEach(() => {
    __resetMarkdownFileWriterForTests();
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
    __resetKeepLocalBackupForTests();
    clearToasts();
  });
  afterEach(() => {
    setExternalEditPromptHandler(null);
    uiStore.closeConfirm();
    clearToasts();
    __resetMarkdownFileWriterForTests();
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
    restoreFiloDefault();
  });

  it('drift gate keep-local → recovery:snapshot runs BEFORE the overwrite (bite)', async () => {
    const calls = installDisk();
    markHydrated('Note.md', false, 100, 10); // baseline differs from stat → drift
    setExternalEditPromptHandler(() => Promise.resolve('keep-local'));

    await writeMarkdownFile({
      vaultRoot: '/vault', relPath: 'Note.md', frontmatter: {}, body: 'mine',
      callerId: 'text-tile:Note.md', docId: null,
    });

    const channels = calls.map((c) => c.channel);
    const snap = channels.indexOf('recovery:snapshot');
    const write = channels.indexOf('vault:write-existing-file-text');
    expect(snap).toBeGreaterThanOrEqual(0);
    expect(write).toBeGreaterThan(snap);
    expect(calls[snap].args).toEqual(['/vault', 'Note.md']);
    // The confirmation names the backup location, vault-relative.
    expect(uiStore.toasts.some((t) => t.text.includes('.filo/recovery/2026-09-23T10-02-11.123/Note.md'))).toBe(true);
  });

  it('ENOENT on the stat → proceeds without a snapshot', async () => {
    const calls = installDisk({ stat: () => ({ success: false, code: 'ENOENT' }) });
    await expect(backupExternalVersion('/vault', 'Gone.md')).resolves.toBe(true);
    expect(calls.some((c) => c.channel === 'recovery:snapshot')).toBe(false);
  });

  it('a locked snapshot → danger confirm; Cancel defers the gate write (markPathFailed + throw)', async () => {
    const calls = installDisk({ snapshot: () => ({ ok: false, code: 'EBUSY', error: 'locked' }) });
    markHydrated('Locked.md', false, 100, 10);
    setExternalEditPromptHandler(() => Promise.resolve('keep-local'));

    const pending = writeMarkdownFile({
      vaultRoot: '/vault', relPath: 'Locked.md', frontmatter: {}, body: 'mine',
      callerId: 'text-tile:Locked.md', docId: null,
    });
    await vi_waitFor(() => uiStore.confirmDialog !== null);
    expect(uiStore.confirmDialog?.body).toMatch(/locked by another program/);
    expect(uiStore.confirmDialog?.danger).toBe(true);
    const dialog = uiStore.confirmDialog!;
    uiStore.closeConfirm();
    dialog.onCancel?.();

    await expect(pending).rejects.toThrow(/could not be backed up/);
    expect(calls.some((c) => c.channel === 'vault:write-existing-file-text')).toBe(false);
    expect(isPathPending('Locked.md')).toBe(true);
  });

  it('a locked snapshot → Overwrite anyway proceeds', async () => {
    installDisk({ snapshot: () => ({ ok: false, code: 'RECOVERY_SNAPSHOT_TOO_LARGE', error: 'big' }) });
    const p = backupExternalVersion('/vault', 'Big.md');
    await vi_waitFor(() => uiStore.confirmDialog !== null);
    expect(uiStore.confirmDialog?.body).toMatch(/larger than 25 MB/);
    const dialog = uiStore.confirmDialog!;
    uiStore.closeConfirm();
    dialog.onConfirm(false);
    await expect(p).resolves.toBe(true);
  });

  it('dedupes: the handler call + the gate call for the same bytes snapshot once', async () => {
    const calls = installDisk();
    await backupExternalVersion('/vault', 'Twice.md');
    await backupExternalVersion('/vault', 'Twice.md');
    expect(calls.filter((c) => c.channel === 'recovery:snapshot')).toHaveLength(1);
  });

  it('a NEW external version (different stat) is backed up again', async () => {
    let mtime = 200;
    const calls = installDisk({ stat: () => ({ success: true, mtimeMs: mtime, size: 20 }) });
    await backupExternalVersion('/vault', 'Again.md');
    mtime = 300;
    await backupExternalVersion('/vault', 'Again.md');
    expect(calls.filter((c) => c.channel === 'recovery:snapshot')).toHaveLength(2);
  });
});

async function vi_waitFor(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error('condition not met');
}

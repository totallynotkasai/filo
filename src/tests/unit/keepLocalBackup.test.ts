/**
 * "Keep mine" backs up the other program's version to `.filo/recovery/`
 * BEFORE the overwrite. Without it, resolving a synced-vault conflict in
 * Filo's favour would destroy the other device's edit with no copy anywhere.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { __resetDirtyTrackingForTests, isPathPending } from '@renderer/lib/boards/writeStateTracking';
import {
  backupExternalVersion,
  __resetKeepLocalBackupForTests,
} from '@renderer/lib/vault/keepLocalBackup';
import { noteStore } from '@renderer/stores/notes.svelte';
import { registerNotePrompts } from '@renderer/stores/notePrompts';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

type Call = { channel: string; args: unknown[] };

/** A small disk behind `window.filo`, plus the recovery snapshot channel. */
function installDisk(opts: {
  files?: Record<string, string>;
  snapshot?: (rel: string) => unknown;
  stat?: () => unknown;
} = {}): { calls: Call[]; files: Map<string, string> } {
  const calls: Call[] = [];
  const files = new Map(Object.entries(opts.files ?? {}));
  const mtimes = new Map<string, number>();
  let clock = 100;
  for (const rel of files.keys()) mtimes.set(rel, (clock += 10));
  installFiloMock((channel: unknown, ...args: unknown[]) => {
    calls.push({ channel: channel as string, args });
    const rel = args[1] as string;
    if (channel === 'vault:stat') {
      if (opts.stat) return opts.stat();
      const text = files.get(rel);
      if (text === undefined) return { success: false, code: 'ENOENT', error: 'ENOENT' };
      return { success: true, mtimeMs: mtimes.get(rel), size: text.length };
    }
    if (channel === 'recovery:snapshot') {
      return opts.snapshot
        ? opts.snapshot(rel)
        : { ok: true, path: '/vault/.filo/recovery/2026-09-23T10-02-11.123/Note.md' };
    }
    if (channel === 'vault:read-file-text') {
      const text = files.get(rel);
      if (text === undefined) return { success: false, code: 'ENOENT', error: 'ENOENT' };
      return { success: true, content: text, mtimeMs: mtimes.get(rel), size: text.length };
    }
    if (channel === 'vault:write-existing-file-text') {
      files.set(rel, String(args[2]));
      mtimes.set(rel, (clock += 10));
      return { success: true };
    }
    if (channel === 'vault:write-file-text') return { success: true };
    return undefined;
  });
  return { calls, files };
}

function clearToasts(): void {
  for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
}

/** Opens `rel`, types into it, and lets another program change its body: a conflict. */
async function conflictOn(rel: string, files: Map<string, string>): Promise<void> {
  const m = noteStore.acquire(rel, 'view');
  await m.loaded;
  noteStore.setBody(rel, 'mine', 'view');
  files.set(rel, '---\ntitle: Note\n---\ntheirs\n');
  expect(await noteStore.flush(rel)).toBe(false);
  expect(m.status).toBe('conflict');
}

function clickKeepMine(): void {
  const toast = uiStore.toasts.find((t) => t.text.includes('changed by another program'));
  const idx = toast?.actions?.findIndex((a) => a.label === 'Keep mine') ?? -1;
  expect(idx).toBeGreaterThanOrEqual(0);
  uiStore.invokeToastAction(toast!.id, idx);
}

async function waitFor(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error('condition not met');
}

describe('Keep mine backs up the external version first', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    noteStore.__resetForTests();
    registerNotePrompts();
    __resetKeepLocalBackupForTests();
    clearToasts();
  });
  afterEach(() => {
    uiStore.closeConfirm();
    clearToasts();
    noteStore.__resetForTests();
    __resetDirtyTrackingForTests();
    vaultStore.setPath('');
    restoreFiloDefault();
  });

  it('the conflict prompt Keep mine runs recovery:snapshot BEFORE the overwrite (bite)', async () => {
    const { calls, files } = installDisk({ files: { 'Note.md': '---\ntitle: Note\n---\nbase\n' } });
    await conflictOn('Note.md', files);

    clickKeepMine();
    await waitFor(() => files.get('Note.md') === '---\ntitle: Note\n---\nmine\n');

    const channels = calls.map((c) => c.channel);
    const snap = channels.indexOf('recovery:snapshot');
    const write = channels.lastIndexOf('vault:write-existing-file-text');
    expect(snap).toBeGreaterThanOrEqual(0);
    expect(write).toBeGreaterThan(snap);
    // 'keep': the other version goes where the snapshot prunes never reach.
    expect(calls[snap].args).toEqual(['/vault', 'Note.md', 'keep']);
    // The confirmation names the backup location, vault-relative.
    expect(uiStore.toasts.some((t) => t.text.includes('.filo/recovery/2026-09-23T10-02-11.123/Note.md'))).toBe(true);
  });

  it('ENOENT on the stat → proceeds without a snapshot', async () => {
    const { calls } = installDisk({ stat: () => ({ success: false, code: 'ENOENT' }) });
    await expect(backupExternalVersion('/vault', 'Gone.md')).resolves.toBe(true);
    expect(calls.some((c) => c.channel === 'recovery:snapshot')).toBe(false);
  });

  it('a locked snapshot → danger confirm; Cancel leaves both versions and the edit unsaved', async () => {
    const { calls, files } = installDisk({
      files: { 'Locked.md': '---\ntitle: Note\n---\nbase\n' },
      snapshot: () => ({ ok: false, code: 'EBUSY', error: 'locked' }),
    });
    await conflictOn('Locked.md', files);
    const writesBefore = calls.filter((c) => c.channel === 'vault:write-existing-file-text').length;

    clickKeepMine();
    await waitFor(() => uiStore.confirmDialog !== null);
    expect(uiStore.confirmDialog?.body).toMatch(/locked by another program/);
    expect(uiStore.confirmDialog?.danger).toBe(true);
    const dialog = uiStore.confirmDialog!;
    uiStore.closeConfirm();
    dialog.onCancel?.();
    await new Promise((r) => setTimeout(r, 10));

    expect(calls.filter((c) => c.channel === 'vault:write-existing-file-text')).toHaveLength(writesBefore);
    expect(files.get('Locked.md')).toBe('---\ntitle: Note\n---\ntheirs\n');
    expect(noteStore.get('Locked.md')?.status).toBe('conflict');
    expect(noteStore.get('Locked.md')?.body).toBe('mine');
    expect(isPathPending('Locked.md')).toBe(true);
  });

  it('a locked snapshot → Overwrite anyway proceeds', async () => {
    installDisk({
      stat: () => ({ success: true, mtimeMs: 200, size: 20 }),
      snapshot: () => ({ ok: false, code: 'RECOVERY_SNAPSHOT_TOO_LARGE', error: 'big' }),
    });
    const p = backupExternalVersion('/vault', 'Big.md');
    await waitFor(() => uiStore.confirmDialog !== null);
    expect(uiStore.confirmDialog?.body).toMatch(/larger than 25 MB/);
    const dialog = uiStore.confirmDialog!;
    uiStore.closeConfirm();
    dialog.onConfirm(false);
    await expect(p).resolves.toBe(true);
  });

  it('dedupes: two calls for the same bytes snapshot once', async () => {
    const { calls } = installDisk({ stat: () => ({ success: true, mtimeMs: 200, size: 20 }) });
    await backupExternalVersion('/vault', 'Twice.md');
    await backupExternalVersion('/vault', 'Twice.md');
    expect(calls.filter((c) => c.channel === 'recovery:snapshot')).toHaveLength(1);
  });

  it('a NEW external version (different stat) is backed up again', async () => {
    let mtime = 200;
    const { calls } = installDisk({ stat: () => ({ success: true, mtimeMs: mtime, size: 20 }) });
    await backupExternalVersion('/vault', 'Again.md');
    mtime = 300;
    await backupExternalVersion('/vault', 'Again.md');
    expect(calls.filter((c) => c.channel === 'recovery:snapshot')).toHaveLength(2);
  });
});

/**
 * "Keep mine" on the conflict prompt must put the local body on disk even when
 * the debounce already fired: the writer found the conflict itself, so no
 * timer is armed any more and only the held body remains. The other program's
 * version is backed up to `.filo/recovery/` before it is overwritten.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { noteStore } from '@renderer/stores/notes.svelte';
import { registerNotePrompts } from '@renderer/stores/notePrompts';
import { uiStore } from '@renderer/stores/ui.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { setActiveVaultPath } from '@renderer/lib/vault/activeVaultPath';
import { beginVaultGeneration, __resetVaultIdentityForTests } from '@renderer/lib/vault/vaultIdentity';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { __resetKeepLocalBackupForTests } from '@renderer/lib/vault/keepLocalBackup';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

let vault: MemoryVault;

function clearToasts(): void {
  for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
}

function conflictToast() {
  return uiStore.toasts.find((t) => t.text.includes('changed by another program'));
}

beforeEach(() => {
  __resetDirtyTrackingForTests();
  __resetVaultIdentityForTests();
  __resetKeepLocalBackupForTests();
  beginVaultGeneration('/vault');
  setActiveVaultPath('/vault');
  vault = installMemoryVault({ 'Notes/A.md': '---\ntitle: A\n---\nOriginal\n' });
  vaultIndexStore.clear();
  noteStore.__resetForTests();
  clearToasts();
  registerNotePrompts();
});

afterEach(() => {
  noteStore.__resetForTests();
  clearToasts();
  restoreFiloDefault();
});

describe('Keep mine after the writer found the conflict', () => {
  it('writes the held body even though no debounce is armed any more', async () => {
    const m = noteStore.acquire('Notes/A.md', 'tile');
    await m.loaded;
    noteStore.setBody('Notes/A.md', 'Mine', 'tile');
    vault.writeExternally('Notes/A.md', '---\ntitle: A\n---\nTheirs\n');

    // The debounce fires (here: a flush) and the writer finds the body drift.
    expect(await noteStore.flush('Notes/A.md')).toBe(false);
    expect(m.status).toBe('conflict');
    expect(vault.read('Notes/A.md')).toBe('---\ntitle: A\n---\nTheirs\n');

    const toast = conflictToast();
    expect(toast).toBeDefined();
    await toast?.actions?.find((a) => a.label === 'Keep mine')?.handler();

    expect(vault.read('Notes/A.md')).toBe('---\ntitle: A\n---\nMine\n');
    expect(m.status).toBe('ready');
    expect(m.hasUnsavedBody).toBe(false);
    expect(noteStore.hasPendingWrites('Notes/A.md')).toBe(false);
  });

  it('backs up the other version before overwriting it', async () => {
    const m = noteStore.acquire('Notes/A.md', 'tile');
    await m.loaded;
    noteStore.setBody('Notes/A.md', 'Mine', 'tile');
    vault.writeExternally('Notes/A.md', '---\ntitle: A\n---\nTheirs\n');
    await noteStore.flush('Notes/A.md');

    await conflictToast()?.actions?.find((a) => a.label === 'Keep mine')?.handler();

    const calls = vi.mocked(window.filo.invoke).mock.calls.map((c) => [c[0], c[2]]);
    const backup = calls.findIndex(([ch, rel]) => ch === 'recovery:snapshot' && rel === 'Notes/A.md');
    const write = calls.findIndex(([ch, rel]) => ch === 'vault:write-existing-file-text' && rel === 'Notes/A.md');
    expect(backup).toBeGreaterThanOrEqual(0);
    expect(write).toBeGreaterThan(backup);
  });

  it('a path is matched in any spelling, and a sibling note is untouched', async () => {
    vault.writeExternally('Notes/B.md', '---\ntitle: B\n---\nB body\n');
    const a = noteStore.acquire('notes/a.md', 'tile');
    const b = noteStore.acquire('Notes/B.md', 'tile-b');
    await Promise.all([a.loaded, b.loaded]);
    noteStore.setBody('notes/a.md', 'Mine', 'tile');
    noteStore.setBody('Notes/B.md', 'B typed', 'tile-b');
    vault.writeExternally('Notes/A.md', '---\ntitle: A\n---\nTheirs\n');
    await noteStore.flush('NOTES/A.MD');

    await noteStore.resolveConflict('Notes/A.md', 'keep-mine');

    expect(vault.read('Notes/A.md')).toBe('---\ntitle: A\n---\nMine\n');
    // B's own edit is still queued, not written by A's decision.
    expect(vault.read('Notes/B.md')).toBe('---\ntitle: B\n---\nB body\n');
    expect(noteStore.hasPendingWrites('Notes/B.md')).toBe(true);
  });
});

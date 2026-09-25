/**
 * "Keep mine" overwrites only bytes it has backed up. Another program may
 * write the note again between the backup and the overwrite; that version is
 * backed up too (or, if the file never settles, nothing is overwritten and the
 * prompt comes back).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { noteStore } from '@renderer/stores/notes.svelte';
import { registerNotePrompts } from '@renderer/stores/notePrompts';
import { uiStore } from '@renderer/stores/ui.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { setActiveVaultPath } from '@renderer/lib/vault/activeVaultPath';
import { beginVaultGeneration, __resetVaultIdentityForTests } from '@renderer/lib/vault/vaultIdentity';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { __resetKeepLocalBackupForTests, backupThenRead } from '@renderer/lib/vault/keepLocalBackup';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

const REL = 'Notes/A.md';
const note = (body: string): string => `---\ntitle: A\n---\n${body}\n`;

let vault: MemoryVault;
/** What each backup copied, in order. */
let backups: string[];
/** Runs after each backup is taken (another program writing in the gap). */
let afterBackup: (() => void) | null;

function clearToasts(): void {
  for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
}

function conflictToast() {
  return uiStore.toasts.find((t) => t.text.includes('changed by another program'));
}

async function conflictedNote(): Promise<void> {
  const m = noteStore.acquire(REL, 'tile');
  await m.loaded;
  noteStore.setBody(REL, 'Mine', 'tile');
  vault.writeExternally(REL, note('Theirs'));
  expect(await noteStore.flush(REL)).toBe(false);
  expect(m.status).toBe('conflict');
}

beforeEach(() => {
  __resetDirtyTrackingForTests();
  __resetVaultIdentityForTests();
  __resetKeepLocalBackupForTests();
  beginVaultGeneration('/vault');
  setActiveVaultPath('/vault');
  vault = installMemoryVault({ [REL]: note('Original') });
  backups = [];
  afterBackup = null;
  const inner = vi.mocked(window.filo.invoke).getMockImplementation();
  if (!inner) throw new Error('memory vault has no invoke');
  vi.mocked(window.filo.invoke).mockImplementation(async (channel: string, ...args: unknown[]) => {
    if (channel === 'recovery:snapshot') {
      backups.push(vault.read(args[1] as string) ?? '');
      afterBackup?.();
      return { success: true, path: '/vault/.filo/recovery/backup.md' };
    }
    return Reflect.apply(inner, undefined, [channel, ...args]);
  });
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

describe('Keep mine and a write that lands during it', () => {
  it('a version written between the backup and the overwrite is backed up too', async () => {
    await conflictedNote();
    let once = true;
    afterBackup = () => {
      if (once) vault.writeExternally(REL, note('Third'));
      once = false;
    };

    await conflictToast()?.actions?.find((a) => a.label === 'Keep mine')?.handler();

    expect(vault.read(REL)).toBe(note('Mine'));
    expect(backups).toContain(note('Theirs'));
    // The bytes the overwrite replaced were backed up first.
    expect(backups).toContain(note('Third'));
  });

  it('a file that never settles is not overwritten, and the prompt comes back', async () => {
    await conflictedNote();
    let n = 0;
    afterBackup = () => vault.writeExternally(REL, note(`Churn ${++n}`));

    clearToasts();
    await noteStore.resolveConflict(REL, 'keep-mine');

    expect(vault.read(REL)).toBe(note(`Churn ${n}`));
    expect(conflictToast()).toBeDefined();
    expect(noteStore.hasPendingWrites(REL)).toBe(true);
  });
});

describe('backupThenRead', () => {
  it('hands back the read only when the file is unchanged across backup and read', async () => {
    let reads = 0;
    let once = true;
    afterBackup = () => {
      if (once) vault.writeExternally(REL, note('Moved on'));
      once = false;
    };
    const got = await backupThenRead('/vault', REL, async () => {
      reads++;
      return vault.read(REL);
    });
    expect(got).toEqual({ ok: true, value: note('Moved on') });
    expect(reads).toBe(2);
    expect(backups).toEqual([note('Original'), note('Moved on')]);
  });

  it('a missing file reads through (nothing to back up)', async () => {
    vault.remove(REL);
    const got = await backupThenRead('/vault', REL, async () => 'read');
    expect(got).toEqual({ ok: true, value: 'read' });
    expect(backups).toEqual([]);
  });
});

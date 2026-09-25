/**
 * A note with an unsaved edit deleted by another program asks "Keep mine" or
 * "Discard". Keep mine writes the note back from the model, its last
 * frontmatter over the local body, and only ever through the create-exclusive
 * channel: a sync client that replaces a file as delete-then-create may have
 * put the other machine's version back meanwhile, and that version must not be
 * overwritten (it becomes an ordinary conflict instead). Once written back,
 * nothing still queued can revert it. Discard lets the edit go without
 * writing anything.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { noteStore, type NoteModel } from '@renderer/stores/notes.svelte';
import { registerNotePrompts } from '@renderer/stores/notePrompts';
import { uiStore } from '@renderer/stores/ui.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { setActiveVaultPath } from '@renderer/lib/vault/activeVaultPath';
import { beginVaultGeneration, __resetVaultIdentityForTests } from '@renderer/lib/vault/vaultIdentity';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { __resetKeepLocalBackupForTests } from '@renderer/lib/vault/keepLocalBackup';
import { fireVaultSwap } from '@renderer/core/vaultLifecycle';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

const ORIGINAL = '---\ntitle: Notes\ntags: [local-tag]\n---\ndisk body\n';
let vault: MemoryVault;
let m: NoteModel;

function clearToasts(): void {
  for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
}

function deletedToast() {
  const t = uiStore.toasts.find((x) => x.text.includes('deleted by another program'));
  expect(t).toBeDefined();
  return t;
}

async function click(label: string): Promise<void> {
  await deletedToast()?.actions?.find((a) => a.label === label)?.handler();
}

/** Every call that could put bytes at `rel`: [channel, content]. */
function writesTo(rel: string): Array<[string, string]> {
  return vault.writes.filter(([, r]) => r === rel).map(([ch, , text]) => [ch, text]);
}

beforeEach(async () => {
  __resetDirtyTrackingForTests();
  __resetVaultIdentityForTests();
  __resetKeepLocalBackupForTests();
  beginVaultGeneration('/vault');
  setActiveVaultPath('/vault');
  vault = installMemoryVault({ 'Notes.md': ORIGINAL });
  vaultIndexStore.clear();
  noteStore.__resetForTests();
  clearToasts();
  registerNotePrompts();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);

  m = noteStore.acquire('Notes.md', 'tile');
  await m.loaded;
  noteStore.setBody('Notes.md', 'local body', 'tile');
  vault.remove('Notes.md');
  await noteStore.onDiskChanged('Notes.md');
});

afterEach(() => {
  noteStore.__resetForTests();
  setActiveVaultPath('');
  clearToasts();
  restoreFiloDefault();
  vi.restoreAllMocks();
});

describe('Keep mine on a note deleted by another program', () => {
  it('re-creates it exclusively with its frontmatter and the local body', async () => {
    await click('Keep mine');
    expect(writesTo('Notes.md')).toEqual([
      ['vault:create-file-text', '---\ntitle: Notes\ntags: [local-tag]\n---\nlocal body\n'],
    ]);
  });

  it('leaves nothing queued that could revert the re-created bytes', async () => {
    await click('Keep mine');
    const recreated = vault.read('Notes.md');
    expect(noteStore.hasPendingWrites('Notes.md')).toBe(false);
    expect(m.hasUnsavedBody).toBe(false);
    expect(await noteStore.flushAll()).toEqual({ failed: [] });
    expect(vault.read('Notes.md')).toBe(recreated);
  });

  it('keeps the note\'s frontmatter even when every view closed before the click', async () => {
    noteStore.release('Notes.md', 'tile');
    await click('Keep mine');
    expect(vault.read('Notes.md')).toBe('---\ntitle: Notes\ntags: [local-tag]\n---\nlocal body\n');
  });

  it('a frontmatter edit made after the prompt appeared lands too', async () => {
    noteStore.patchFrontmatter('Notes.md', { set: { tags: ['edited-tag'] }, unset: [] });
    await click('Keep mine');
    await noteStore.flushAll();
    expect(vault.read('Notes.md')).toBe('---\ntitle: Notes\ntags:\n  - edited-tag\n---\nlocal body\n');
  });

  it('the file came back with other bytes: NOT overwritten, the conflict prompt shows', async () => {
    const theirs = "---\ntitle: Notes\n---\nthe OTHER machine's version\n";
    vault.writeExternally('Notes.md', theirs);
    await click('Keep mine');
    await new Promise((r) => setTimeout(r, 10));

    expect(vault.read('Notes.md')).toBe(theirs);
    expect(writesTo('Notes.md').every(([ch]) => ch === 'vault:create-file-text')).toBe(true);
    expect(uiStore.toasts.some((t) => t.text.includes('changed by another program'))).toBe(true);
    // The local body is still there to keep, not lost.
    expect(m.body).toBe('local body');
    expect(m.hasUnsavedBody).toBe(true);
  });
});

describe('Discard on a note deleted by another program', () => {
  it('drops the edit and writes nothing', async () => {
    await click('Discard');
    expect(m.status).toBe('missing');
    expect(m.hasUnsavedBody).toBe(false);
    expect(noteStore.hasPendingWrites('Notes.md')).toBe(false);
    expect(await noteStore.flushAll()).toEqual({ failed: [] });
    expect(vault.read('Notes.md')).toBeUndefined();
    expect(writesTo('Notes.md')).toEqual([]);
  });
});

describe('a vault swap while Keep mine runs', () => {
  it('writes nothing into the new vault', async () => {
    // The swap lands while Keep mine is checking the disk for a version to back up.
    const memory = window.filo;
    installFiloMock(async (channel, ...args) => {
      if (channel === 'vault:stat' && args[1] === 'Notes.md') {
        await fireVaultSwap({ phase: 'pre-swap', previousVault: '/vault', nextVault: '/other', saveOutgoing: true });
        beginVaultGeneration('/other');
        setActiveVaultPath('/other');
      }
      return Reflect.apply(memory.invoke, memory, [channel, ...args]);
    });
    await click('Keep mine');
    expect(writesTo('Notes.md')).toEqual([]);
  });
});

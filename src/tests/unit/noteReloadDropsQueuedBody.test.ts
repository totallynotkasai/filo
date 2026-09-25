/**
 * Choosing Reload on a note conflict must drop the unsaved body that was
 * queued before it. Otherwise the armed write fires after the Reload and puts
 * the discarded typed body back over the version the user chose to keep,
 * silently inverting the Reload. Holds whether the change on disk also touched
 * the frontmatter or only the body.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { noteStore, setNotePromptHandlers } from '@renderer/stores/notes.svelte';
import { setActiveVaultPath } from '@renderer/lib/vault/activeVaultPath';
import { beginVaultGeneration, __resetVaultIdentityForTests } from '@renderer/lib/vault/vaultIdentity';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

let vault: MemoryVault;
const noop = (): void => undefined;

/** Waits past the note writer's 300 ms debounce. */
const pastDebounce = (): Promise<void> => new Promise((r) => setTimeout(r, 400));

beforeEach(() => {
  __resetDirtyTrackingForTests();
  __resetVaultIdentityForTests();
  beginVaultGeneration('/vault');
  setActiveVaultPath('/vault');
  vault = installMemoryVault({
    'Notes/C2.md': '---\ntitle: C2\nstatus: draft\n---\npre-reload body\n',
    'Notes/C3.md': '---\ntitle: C3\n---\npre-reload body\n',
  });
  noteStore.__resetForTests();
  setNotePromptHandlers({ conflict: noop, deletedWithUnsavedBody: noop, writeTargetMissing: noop, reloadShrank: noop, dismiss: noop });
});

afterEach(() => {
  noteStore.__resetForTests();
  __resetDirtyTrackingForTests();
  restoreFiloDefault();
});

describe('Reload drops the body queued before it', () => {
  it('frontmatter and body changed on disk', async () => {
    const rel = 'Notes/C2.md';
    const m = noteStore.acquire(rel, 'text-tile:c2');
    await m.loaded;
    noteStore.setBody(rel, 'pre-reload typed body', 'text-tile:c2');

    const theirs = '---\ntitle: C2\nstatus: published\n---\nPOST-RELOAD-DISK-BODY\n';
    vault.writeExternally(rel, theirs);
    await noteStore.onDiskChanged(rel);
    expect(m.status).toBe('conflict');
    await noteStore.resolveConflict(rel, 'reload');

    await pastDebounce();
    await noteStore.flushAll();
    expect(vault.writes.filter(([, r]) => r === rel)).toEqual([]);
    expect(vault.read(rel)).toBe(theirs);
    expect(m.body).toBe('POST-RELOAD-DISK-BODY\n');
    expect(m.frontmatter.status).toBe('published');
    expect(noteStore.hasPendingWrites(rel)).toBe(false);
  });

  it('only the body changed on disk', async () => {
    const rel = 'Notes/C3.md';
    const m = noteStore.acquire(rel, 'text-tile:c3');
    await m.loaded;
    noteStore.setBody(rel, 'pre-reload typed body c3', 'text-tile:c3');

    const theirs = '---\ntitle: C3\n---\nPOST-RELOAD-DISK-BODY-C3\n';
    vault.writeExternally(rel, theirs);
    await noteStore.onDiskChanged(rel);
    await noteStore.resolveConflict(rel, 'reload');

    await pastDebounce();
    await noteStore.flushAll();
    expect(vault.writes.filter(([, r]) => r === rel)).toEqual([]);
    expect(vault.read(rel)).toBe(theirs);
    expect(m.hasUnsavedBody).toBe(false);
  });
});

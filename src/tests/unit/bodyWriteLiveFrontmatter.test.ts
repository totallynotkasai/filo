/**
 * A body write queued before a frontmatter change must emit the frontmatter
 * as it stands when the write lands, not as it stood when the keystroke was
 * made: an external frontmatter-only edit, or a Properties / Task List change
 * made during the debounce, would otherwise be clobbered by a stale copy.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { noteStore } from '@renderer/stores/notes.svelte';
import { patchToFrontmatterDelta } from '@renderer/lib/vault/frontmatterDelta';
import { setActiveVaultPath } from '@renderer/lib/vault/activeVaultPath';
import { beginVaultGeneration, __resetVaultIdentityForTests } from '@renderer/lib/vault/vaultIdentity';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

let vault: MemoryVault;

beforeEach(() => {
  __resetDirtyTrackingForTests();
  __resetVaultIdentityForTests();
  beginVaultGeneration('/vault');
  setActiveVaultPath('/vault');
  vault = installMemoryVault({ 'Notes/A.md': '---\nstatus: draft\n---\nthe body\n' });
  noteStore.__resetForTests();
});

afterEach(() => {
  noteStore.__resetForTests();
  setActiveVaultPath('');
  restoreFiloDefault();
});

describe('a queued body write carries the live frontmatter', () => {
  it('an external frontmatter-only edit made after the keystroke survives the body write', async () => {
    const m = noteStore.acquire('Notes/A.md', 'text-tile');
    await m.loaded;
    noteStore.setBody('Notes/A.md', 'the body, edited', 'text-tile');

    vault.writeExternally('Notes/A.md', '---\nstatus: published\n---\nthe body\n');

    expect(await noteStore.flush('Notes/A.md')).toBe(true);
    const written = vault.read('Notes/A.md') ?? '';
    expect(written).toBe('---\nstatus: published\n---\nthe body, edited\n');
    expect(written).not.toContain('draft');
  });

  it('a frontmatter change made in the app during the debounce lands with the body', async () => {
    const m = noteStore.acquire('Notes/A.md', 'text-tile');
    await m.loaded;
    noteStore.setBody('Notes/A.md', 'the body, edited', 'text-tile');
    noteStore.patchFrontmatter('Notes/A.md', patchToFrontmatterDelta({ status: 'published' }));

    await noteStore.flush('Notes/A.md');
    expect(vault.read('Notes/A.md')).toBe('---\nstatus: published\n---\nthe body, edited\n');
  });
});

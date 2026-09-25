/**
 * A note with a UTF-8 BOM keeps it when it is open in two views (a text tile
 * and a Document tab) and either one saves. The shared body is body-only, so
 * nothing a view reads from it knows about the BOM; the writer takes the BOM
 * from the fresh read of the file each time.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { noteStore } from '@renderer/stores/notes.svelte';
import { patchToFrontmatterDelta } from '@renderer/lib/vault/frontmatterDelta';
import { setActiveVaultPath } from '@renderer/lib/vault/activeVaultPath';
import { beginVaultGeneration, __resetVaultIdentityForTests } from '@renderer/lib/vault/vaultIdentity';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

const BOM = String.fromCharCode(0xfeff);
let vault: MemoryVault;

beforeEach(() => {
  __resetDirtyTrackingForTests();
  __resetVaultIdentityForTests();
  beginVaultGeneration('/vault');
  setActiveVaultPath('/vault');
  vault = installMemoryVault({
    'SharedBom.md': `${BOM}---\ntitle: B\n---\nbody\n`,
  });
  noteStore.__resetForTests();
});

afterEach(() => {
  noteStore.__resetForTests();
  setActiveVaultPath('');
  restoreFiloDefault();
});

describe('a BOM survives saves from any view', () => {
  it('the second view\'s body save re-emits the BOM', async () => {
    const tile = noteStore.acquire('SharedBom.md', 'text-tile');
    await tile.loaded;
    const doc = noteStore.acquire('SharedBom.md', 'document-editor');
    expect(doc).toBe(tile);
    expect(doc.body.charCodeAt(0)).not.toBe(0xfeff);

    noteStore.setBody('SharedBom.md', 'body edited', 'document-editor');
    noteStore.patchFrontmatter('SharedBom.md', patchToFrontmatterDelta({ status: 'updated' }));
    await noteStore.flush('SharedBom.md');

    expect(vault.read('SharedBom.md')).toBe(`${BOM}---\ntitle: B\nstatus: updated\n---\nbody edited\n`);
  });

  it('a frontmatter-only change to a note no view holds keeps the BOM', async () => {
    noteStore.patchFrontmatter('SharedBom.md', patchToFrontmatterDelta({ status: 'updated' }));
    await noteStore.flushAll();
    expect(vault.read('SharedBom.md')).toBe(`${BOM}---\ntitle: B\nstatus: updated\n---\nbody\n`);
  });
});

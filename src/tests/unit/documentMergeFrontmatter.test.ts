/**
 * A field edit must not strip a present-but-empty key the user never touched
 * (`aliases:`, `subtitle: ""`): the change is a delta applied to a fresh read
 * of the file, so only the keys it names are rewritten. An empty value in the
 * patch still clears the key the user cleared.
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
  vault = installMemoryVault({
    'X.md': '---\naliases:\ntitle: x\n---\nBody\n',
    'Z.md': '---\nsubtitle: ""\ntitle: x\n---\nBody\n',
    'Y.md': '---\ntitle: x\nsubtitle: sub\n---\nBody\n',
  });
  noteStore.__resetForTests();
});

afterEach(() => {
  noteStore.__resetForTests();
  setActiveVaultPath('');
  restoreFiloDefault();
});

describe('a field edit keeps untouched empty keys', () => {
  it('keeps a present-but-empty key when an unrelated field is set', async () => {
    const m = noteStore.acquire('X.md', 'v');
    await m.loaded;
    noteStore.patchFrontmatter('X.md', patchToFrontmatterDelta({ priority: 'high' }));
    expect('aliases' in m.frontmatter).toBe(true);
    expect(m.frontmatter.aliases).toBeNull();
    expect(m.frontmatter.priority).toBe('high');
    await noteStore.flush('X.md');
    expect(vault.read('X.md')).toBe('---\naliases:\ntitle: x\npriority: high\n---\nBody\n');
  });

  it('keeps an empty-string key (subtitle: "") the user did not touch', async () => {
    noteStore.patchFrontmatter('Z.md', patchToFrontmatterDelta({ priority: 'low' }));
    await noteStore.flushAll();
    expect(vault.read('Z.md')).toBe('---\nsubtitle: ""\ntitle: x\npriority: low\n---\nBody\n');
  });

  it('still drops a key the user explicitly clears in the patch', async () => {
    noteStore.patchFrontmatter('Y.md', patchToFrontmatterDelta({ subtitle: '' }));
    await noteStore.flushAll();
    expect(vault.read('Y.md')).toBe('---\ntitle: x\n---\nBody\n');
  });
});

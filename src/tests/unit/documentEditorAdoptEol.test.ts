/**
 * A CRLF note keeps its line ending when an editor saves its body. The editor
 * serialises LF, and a single-line frontmatter (`title: x`) carries no
 * internal `\r\n` to sniff from the block alone, so the ending must come from
 * the file itself; otherwise the first save flips the whole file to LF.
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
    'Notes/Crlf.md': '---\r\ntitle: Note\r\n---\r\nBody line\r\n',
  });
  noteStore.__resetForTests();
});

afterEach(() => {
  noteStore.__resetForTests();
  setActiveVaultPath('');
  restoreFiloDefault();
});

describe('editor saves keep a CRLF note CRLF', () => {
  it('a body save from a Document view keeps every newline CRLF', async () => {
    const m = noteStore.acquire('Notes/Crlf.md', 'document-editor');
    await m.loaded;
    noteStore.setBody('Notes/Crlf.md', 'Edited body line\n\nSecond paragraph', 'document-editor');
    await noteStore.flush('Notes/Crlf.md');
    const out = vault.read('Notes/Crlf.md') ?? '';
    expect(out.startsWith('---\r\ntitle: Note\r\n---\r\n')).toBe(true);
    expect(out).toContain('Edited body line\r\n\r\nSecond paragraph');
    // No lone LF anywhere: every newline is CRLF.
    expect(/[^\r]\n/.test(out)).toBe(false);
  });

  it('a body and a frontmatter change landing together keep CRLF too', async () => {
    const m = noteStore.acquire('Notes/Crlf.md', 'document-editor');
    await m.loaded;
    noteStore.setBody('Notes/Crlf.md', 'Edited', 'document-editor');
    noteStore.patchFrontmatter('Notes/Crlf.md', patchToFrontmatterDelta({ status: 'done' }));
    await noteStore.flush('Notes/Crlf.md');
    const out = vault.read('Notes/Crlf.md') ?? '';
    expect(out).toContain('status: done\r\n');
    expect(/[^\r]\n/.test(out)).toBe(false);
  });
});

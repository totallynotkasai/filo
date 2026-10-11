import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { noteStore } from '@renderer/stores/notes.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { UpdateCardFieldCommand } from '@renderer/commands/index';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Source-preservation / silent formatting loss.
 *
 * A card field edit on a note no editor has open must patch only the changed
 * key in the frontmatter source: comments, key order and quoting survive,
 * exactly as for an open note. Undo restores the original bytes.
 */

describe('un-opened card FM edit preserves comments / key order / quoting', () => {
  let vault: MemoryVault;

  // Disk frontmatter with a leading comment, an explicitly-quoted scalar, and a
  // deliberate key order. The patch only changes `priority`; everything else
  // must survive byte-for-byte.
  const DISK = [
    '---',
    '# Card metadata — do not reorder',
    'title: "My Card"',
    'priority: low',
    'status: active',
    '---',
    'This is the card body.',
  ].join('\n');

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    noteStore.__resetForTests();
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    vaultIndexStore.clear();
    vault = installMemoryVault({ 'Card.md': DISK });
  });

  afterEach(() => {
    noteStore.__resetForTests();
    __resetDirtyTrackingForTests();
    vaultStore.setPath('');
    boardCacheStore.clear();
    vaultIndexStore.clear();
    restoreFiloDefault();
  });

  it('keeps the doc-comment, the quoted title, and the key order while applying the patch', async () => {
    const cmd = new UpdateCardFieldCommand('kb', 'Card.md', { priority: 'high' }, { priority: 'low' });
    await cmd.execute();
    await noteStore.flushAll();

    const written = vault.read('Card.md') ?? '';
    expect(written.startsWith(DISK.replace('priority: low', 'priority: high'))).toBe(true);
    // Spelled out: the edit applied, the comment, quoting and order survived.
    expect(written).not.toContain('priority: low');
    expect(written).toContain('# Card metadata — do not reorder');
    expect(written).toContain('title: "My Card"');
    const iTitle = written.indexOf('title:');
    const iPriority = written.indexOf('priority:');
    const iStatus = written.indexOf('status:');
    expect(iTitle).toBeLessThan(iPriority);
    expect(iPriority).toBeLessThan(iStatus);
    expect(written).toContain('This is the card body.');

    await cmd.undo();
    await noteStore.flushAll();
    expect(vault.read('Card.md')?.startsWith(DISK)).toBe(true);
  });
});

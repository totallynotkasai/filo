import { describe, it, expect, afterEach } from 'vitest';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { parseMarkdown } from '@renderer/lib/vault/vaultIndex';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * A vault-index read that started before Filo's own write stored the new
 * bytes (the write updates the index straight away, and its watcher echo is
 * hidden, so nothing else would correct it) must not put the older bytes
 * back: a Kanban card would jump back, a task look unchecked.
 */

const OLD = '---\ntitle: Task\ncompleted: false\n---\nBody\n';
const NEW = '---\ntitle: Task\ncompleted: true\n---\nBody\n';

describe('vault index: a read racing Filo\'s own write', () => {
  afterEach(() => {
    restoreFiloDefault();
    vaultIndexStore.clear();
    vaultStore.setPath('');
  });

  it('a read that started before the write stored its bytes doesn\'t overwrite them', async () => {
    vaultStore.setPath('/vault');
    let disk = OLD;
    const gates: Array<() => void> = [];
    let reads = 0;
    installFiloMock((channel: string) => {
      if (channel !== 'vault:read-file-text') return undefined;
      reads++;
      // The first read sees the bytes from before the write, and is slow.
      const content = disk;
      if (reads === 1) {
        return new Promise((resolve) => gates.push(() => resolve({ success: true, content, mtimeMs: 1, size: content.length })));
      }
      return { success: true, content, mtimeMs: 2, size: content.length };
    });

    const indexing = vaultIndexStore.applyChanges(['Task.md']);
    await new Promise((r) => setTimeout(r, 0));
    // Filo writes the note and stores the new bytes in the index.
    disk = NEW;
    vaultIndexStore.restoreMetadata('Task.md', parseMarkdown('Task.md', NEW));
    gates.shift()?.();
    await indexing;

    expect(vaultIndexStore.getMetadata('Task.md')?.frontmatter.completed).toBe(true);
  });

  it('a read with nothing racing it is stored as usual', async () => {
    vaultStore.setPath('/vault');
    installFiloMock((channel: string) =>
      channel === 'vault:read-file-text' ? { success: true, content: NEW, mtimeMs: 1, size: NEW.length } : undefined,
    );
    await vaultIndexStore.applyChanges(['Task.md']);
    expect(vaultIndexStore.getMetadata('Task.md')?.frontmatter.completed).toBe(true);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * `indexOnePath` stamped `parseMarkdown(..., Date.now())` and
 * discarded the `mtimeMs` the `vault:read-file-text` IPC already returns from
 * its pre-flight stat. So `FileMetadata.lastModified` was always "now", and the
 * partial-read stability window in conflictResolver (`now - lastModified < 1s`)
 * was effectively always true — every settled external truncation got forced
 * through the ~5s retry path instead of reloading immediately. The fix threads
 * the disk mtime through so `lastModified` reflects the file's real age.
 */
describe('index stamps the disk mtime, not Date.now()', () => {
  beforeEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('/vault');
  });
  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
  });

  it('FileMetadata.lastModified equals the IPC mtimeMs', async () => {
    const MTIME = 1_600_000_000_000; // fixed disk mtime well in the past (2020)
    installFiloMock(async (channel: string) => {
      if (channel === 'vault:read-file-text') {
        return { success: true, content: '# Note\n', mtimeMs: MTIME, size: 7 };
      }
      return null;
    });
    await vaultIndexStore.applyChanges(['note.md']);
    const meta = vaultIndexStore.getMetadata('note.md');
    expect(meta).not.toBeNull();
    expect(meta?.lastModified).toBe(MTIME);
  });

  it('falls back to a fresh stamp when the IPC omits mtimeMs', async () => {
    installFiloMock(async (channel: string) => {
      if (channel === 'vault:read-file-text') {
        return { success: true, content: '# Note\n' }; // legacy shape, no mtimeMs
      }
      return null;
    });
    const before = Date.now();
    await vaultIndexStore.applyChanges(['note2.md']);
    const meta = vaultIndexStore.getMetadata('note2.md');
    expect(meta).not.toBeNull();
    expect(meta?.lastModified).toBeGreaterThanOrEqual(before);
  });
});

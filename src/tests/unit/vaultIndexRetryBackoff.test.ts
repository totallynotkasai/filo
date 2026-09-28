import { describe, it, expect, afterEach, vi } from 'vitest';
import { vaultIndexStore, TRANSIENT_RETRY_DELAYS_MS } from '@renderer/stores/vaultIndex.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * A note the vault index can't read (locked, no access) is read again after
 * 2 s, 10 s and 60 s, then left alone until its next watcher event (D19).
 */
describe('vault index: an unreadable note', () => {
  afterEach(() => {
    vi.useRealTimers();
    restoreFiloDefault();
    vaultIndexStore.clear();
    vaultStore.setPath('');
  });

  async function advance(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
  }

  it('backs off, stops, and starts again on the next watcher event', async () => {
    vi.useFakeTimers();
    let reads = 0;
    let readable = false;
    installFiloMock((channel: string) => {
      if (channel !== 'vault:read-file-text') return undefined;
      reads++;
      return readable
        ? { success: true, content: '# Locked\n', mtimeMs: 1 }
        : { success: false, code: 'EBUSY' };
    });
    vaultStore.setPath('/V');

    await vaultIndexStore.applyChanges(['Locked.md']);
    expect(reads).toBe(1);

    expect(TRANSIENT_RETRY_DELAYS_MS).toEqual([2_000, 10_000, 60_000]);
    await advance(2_000);
    expect(reads).toBe(2);
    await advance(9_999);
    expect(reads).toBe(2);
    await advance(1);
    expect(reads).toBe(3);
    await advance(60_000);
    expect(reads).toBe(4);

    // Given up: an hour passes with no more reads.
    await advance(3_600_000);
    expect(reads).toBe(4);

    // The next watcher event reads it again, and a failure retries again.
    await vaultIndexStore.applyChanges(['Locked.md']);
    expect(reads).toBe(5);
    await advance(2_000);
    expect(reads).toBe(6);

    // Once readable, it is indexed and no retry stays armed.
    readable = true;
    await advance(10_000);
    expect(reads).toBe(7);
    expect(vaultIndexStore.getMetadata('Locked.md')).not.toBeNull();
    await advance(3_600_000);
    expect(reads).toBe(7);
  });
});

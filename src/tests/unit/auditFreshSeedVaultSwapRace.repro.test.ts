import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { documentStore } from '@renderer/stores/document.svelte';
import { seedDocumentFrontmatterFromDisk } from '@renderer/lib/boards/seedFrontmatterFromDisk';
import { cancelAllMarkdownWrites } from '@renderer/lib/vault/markdownFileWriter';
import {
  beginVaultGeneration,
  __resetVaultIdentityForTests,
} from '@renderer/lib/vault/vaultIdentity';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * A9-M1 REGRESSION GUARD (was the fresh-audit #1/#3 REPRO, 2026-06-04).
 *
 * `seedDocumentFrontmatterFromDisk` reads the OUTGOING vault's bytes and awaits
 * the disk IPC. Before A9-M1 the post-await `documentStore.setFrontmatter(...)`
 * was guarded ONLY by a cache-PRESENCE re-check — NOT a vault-identity re-check.
 * So a vault swap landing during the await (File > Open Vault + "Don't Save",
 * which skips save()/whenChainSettled and resets the history chain) let the
 * orphaned continuation re-inject vault A's frontmatter into the freshly-cleared,
 * now-vault-B-bound store; in the command path that stale entry then armed a
 * frontmatter write that fired against vault B (cross-vault corruption, A9-H1).
 *
 * A9-M1 captures the active vault identity BEFORE the await and bails after it
 * (`isStillSameVault`). This test pins that: a swap that COMMITS during the gated
 * read (modelled by `documentStore.clear()` + `beginVaultGeneration(B)`, exactly
 * what `commitVaultCandidate` does) leaves the doc UNSEEDED. Temp-reverting the
 * guard reds the first case (the injection returns).
 */
describe('A9-M1 — seed primitive bails on a vault swap mid-read', () => {
  beforeEach(() => {
    __resetVaultIdentityForTests();
    documentStore.clear();
    cancelAllMarkdownWrites();
  });
  afterEach(() => {
    restoreFiloDefault();
    __resetVaultIdentityForTests();
    documentStore.clear();
    cancelAllMarkdownWrites();
  });

  it('does NOT inject the outgoing vault A frontmatter when a swap commits during the seed read', async () => {
    beginVaultGeneration('/vaultA'); // vault A is the active vault

    // Gate the disk read so we can simulate a vault swap while the seed is suspended.
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });

    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') {
        // Vault A's bytes — captured against vaultStore.path at call time.
        return readGate.then(() => ({
          success: true,
          content: '---\npriority: high\ntitle: VaultA Card\n---\nbody A',
          mtimeMs: 5,
          size: 50,
        }));
      }
      return { success: true };
    });

    // First-touch field edit on an UN-OPENED card: docA has no FM cache entry,
    // so the seed actually performs the disk read and suspends at the await.
    const seedPromise = seedDocumentFrontmatterFromDisk('docA', '/vaultA', 'Note.md');

    // Let the seed reach its `await readMarkdownForHydrate(...)`.
    await Promise.resolve();

    // User picks File > Open Vault (vault B) + "Don't Save": the swap's pre-swap
    // document handler clears the FM cache, then commitVaultCandidate bumps the
    // vault generation to vault B — all before the read resolves.
    documentStore.clear('/vaultB');
    beginVaultGeneration('/vaultB');
    expect(documentStore.getFrontmatter('docA')).toBeUndefined();

    // The seed read (against vault A) resolves; the orphaned continuation runs.
    releaseRead();
    await seedPromise;

    // GUARDED: the seed detected the swap (generation bumped) and bailed — vault
    // A's frontmatter was NOT re-injected into the now-vault-B store.
    expect(documentStore.getFrontmatter('docA')).toBeUndefined();
    expect(documentStore.getOriginalFrontmatterSource('docA')).toBeUndefined();
  });

  it('still seeds normally when no swap lands during the read', async () => {
    beginVaultGeneration('/vaultA');

    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') {
        return readGate.then(() => ({
          success: true,
          content: '---\npriority: high\ntitle: VaultA Card\n---\nbody A',
          mtimeMs: 5,
          size: 50,
        }));
      }
      return { success: true };
    });

    const seedPromise = seedDocumentFrontmatterFromDisk('docA', '/vaultA', 'Note.md');
    await Promise.resolve();
    // No swap — the vault stays the same across the read.
    releaseRead();
    await seedPromise;

    expect(documentStore.getFrontmatter('docA')).toEqual({
      priority: 'high',
      title: 'VaultA Card',
    });
    expect(documentStore.getOriginalFrontmatterSource('docA')).toBe(
      'priority: high\ntitle: VaultA Card',
    );
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import type { FileTreeNode } from '../../shared/types';

/**
 * `vaultIndex.rebuild()` generation guard.
 *
 * A fast A→B vault swap can start a second `rebuild()` while the first is still
 * awaiting its chunked reads. Both share the module-level `index` /
 * `isBuilding` / `buildCompleteResolvers`. Pre-fix, the OUTGOING rebuild's
 * `finally` flipped `isBuilding=false` and drained the INCOMING rebuild's
 * resolvers against a half-built index, and its in-flight reads upserted
 * stale-vault files into the new vault's index.
 *
 * These tests drive two overlapping rebuilds with GATED reads so the
 * interleaving is deterministic, and assert the stale generation:
 *   - does NOT drain the newer rebuild's `whenBuildComplete()` awaiter,
 *   - does NOT leave `isBuilding` stuck,
 *   - does NOT graft its file onto the new vault's index (post-await recheck).
 */
function mdFile(name: string, root: string): FileTreeNode {
  return { name, path: `${root}/${name}`, isDirectory: false, extension: '.md' };
}

describe('vaultIndex.rebuild generation guard', () => {
  afterEach(() => {
    restoreFiloDefault();
    vaultIndexStore.clear();
    vaultStore.setPath('');
  });

  it('a superseded rebuild neither drains the live awaiter nor indexes its stale-vault file', async () => {
    // Each `vault:read-file-text` parks a resolver in `gates` so the test can
    // release reads one at a time and interleave the two rebuilds by hand.
    const gates: Array<() => void> = [];
    installFiloMock((channel: string, ...args: unknown[]) => {
      if (channel !== 'vault:read-file-text') return undefined;
      const [, rel] = args as [string, string];
      return new Promise((resolve) => {
        gates.push(() => resolve({ success: true, content: `# ${rel}\n`, mtimeMs: 1 }));
      });
    });

    // Rebuild A for vault /A — suspends on a.md's read.
    vaultStore.setPath('/A');
    const rebuildA = vaultIndexStore.rebuild([mdFile('a.md', '/A')]);
    await Promise.resolve(); // let A reach its first await

    // Swap to /B and start rebuild B while A is still gated.
    vaultStore.setPath('/B');
    const rebuildB = vaultIndexStore.rebuild([mdFile('b.md', '/B')]);
    await Promise.resolve(); // let B reach its first await

    // Awaiter taken DURING the overlap — must resolve only once the LIVE (B)
    // rebuild finishes, never when A's stale `finally` runs.
    let completed = false;
    const whenComplete = vaultIndexStore.whenBuildComplete().then(() => {
      completed = true;
    });

    expect(gates).toHaveLength(2);
    expect(vaultIndexStore.isBuilding).toBe(true);

    // Release A's read FIRST (it resolves after the swap). Its post-await
    // recheck sees path === '/B' !== '/A' and bails — no a.md upsert — and its
    // stale `finally` skips the drain.
    gates[0]();
    await rebuildA;
    expect(completed).toBe(false);
    expect(vaultIndexStore.isBuilding).toBe(true);
    expect(vaultIndexStore.getMetadata('a.md')).toBeNull();

    // Release B's read (current generation) → B's `finally` flips the flag and
    // drains the awaiter against a fully-built index for the live vault.
    gates[1]();
    await rebuildB;
    await whenComplete;

    expect(completed).toBe(true);
    expect(vaultIndexStore.isBuilding).toBe(false);
    expect(vaultIndexStore.getMetadata('b.md')).not.toBeNull();
    expect(vaultIndexStore.getMetadata('a.md')).toBeNull();
  });

  it('a stale read that resolves after the swap schedules no retry against the new vault', async () => {
    // A transient (non-ENOENT) read error is the path that would `setTimeout`
    // a retry. The post-await vault-identity recheck sits BEFORE that branch,
    // so a stale-vault read must bail without ever arming a retry timer that
    // would later re-read against the wrong vault.
    const gates: Array<(res: unknown) => void> = [];
    installFiloMock((channel: string) => {
      if (channel !== 'vault:read-file-text') return undefined;
      return new Promise((resolve) => {
        gates.push(resolve);
      });
    });

    vaultStore.setPath('/A');
    const rebuildA = vaultIndexStore.rebuild([mdFile('stale.md', '/A')]);
    await Promise.resolve();

    vaultStore.setPath('/B');
    const rebuildB = vaultIndexStore.rebuild([mdFile('fresh.md', '/B')]);
    await Promise.resolve();

    expect(gates).toHaveLength(2);

    // A's read returns a TRANSIENT failure (EBUSY) — the retry-scheduling
    // branch — but only after the swap. The recheck must bail first.
    gates[0]({ success: false, code: 'EBUSY' });
    // B's read succeeds.
    gates[1]({ success: true, content: '# fresh\n', mtimeMs: 1 });

    await Promise.all([rebuildA, rebuildB]);

    // No retry fired for the stale vault: stale.md is absent and a real retry
    // (2s) would have needed a fresh read gate, which never appeared.
    expect(gates).toHaveLength(2);
    expect(vaultIndexStore.getMetadata('stale.md')).toBeNull();
    expect(vaultIndexStore.getMetadata('fresh.md')).not.toBeNull();
    expect(vaultIndexStore.isBuilding).toBe(false);
  });
});

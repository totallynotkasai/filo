/**
 * A view left over from the outgoing vault must never put that vault's note
 * into the incoming one. The swap drops every note model, a body is accepted
 * only from a view that holds the note's model, and a read that finishes after
 * the active vault changed is not adopted. A same-named note in the new vault
 * therefore loads from the new vault's file and keeps its bytes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { noteStore } from '@renderer/stores/notes.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { setActiveVaultPath } from '@renderer/lib/vault/activeVaultPath';
import { beginVaultGeneration, __resetVaultIdentityForTests } from '@renderer/lib/vault/vaultIdentity';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { fireVaultSwap } from '@renderer/core/vaultLifecycle';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

let vault: MemoryVault;
const A_TEXT = '---\ntitle: From A\n---\nVault A body\n';
const B_TEXT = '---\ntitle: From B\n---\nVault B body\n';

async function swapTo(next: string): Promise<void> {
  await fireVaultSwap({ phase: 'pre-swap', previousVault: '/vault/A', nextVault: next, saveOutgoing: true });
}

function commit(next: string): void {
  beginVaultGeneration(next);
  setActiveVaultPath(next);
}

beforeEach(() => {
  __resetDirtyTrackingForTests();
  __resetVaultIdentityForTests();
  commit('/vault/A');
  vault = installMemoryVault({ 'a.md': A_TEXT }, '/vault/A');
  vaultIndexStore.clear();
  noteStore.__resetForTests();
});

afterEach(() => {
  noteStore.__resetForTests();
  setActiveVaultPath('');
  restoreFiloDefault();
});

describe('notes across a vault swap', () => {
  it('an edit from a view of the old vault never reaches the new vault\'s same-named note', async () => {
    const m = noteStore.acquire('a.md', 'old-tile');
    await m.loaded;
    await swapTo('/vault/B');
    commit('/vault/B');
    // The new vault's file at the same relative path.
    vault.writeExternally('a.md', B_TEXT);

    // The old tile hasn't unmounted yet and serialises its editor.
    noteStore.setBody('a.md', 'Typed in vault A', 'old-tile');
    await noteStore.flushAll();

    expect(vault.read('a.md')).toBe(B_TEXT);
    expect(vault.writes).toEqual([]);
  });

  it('a read that finishes after the active vault changed is not adopted', async () => {
    vault.afterRead = () => {
      // The swap commits while the old vault's read is in flight.
      vault.afterRead = null;
      commit('/vault/B');
    };
    const stale = noteStore.acquire('a.md', 'old-tile');
    await stale.loaded;
    expect(stale.status).toBe('loading');
    expect(stale.body).toBe('');

    // Nothing can be written through the unadopted model.
    noteStore.setBody('a.md', 'Typed in vault A', 'old-tile');
    await noteStore.flushAll();
    expect(vault.writes).toEqual([]);
  });

  it('once the old view unmounts, a new view loads the new vault\'s note', async () => {
    const old = noteStore.acquire('a.md', 'old-tile');
    await old.loaded;
    await swapTo('/vault/B');
    commit('/vault/B');
    vault.writeExternally('a.md', B_TEXT);
    noteStore.release('a.md', 'old-tile');

    const fresh = noteStore.acquire('a.md', 'new-tile');
    await fresh.loaded;
    expect(fresh).not.toBe(old);
    expect(fresh.body).toBe('Vault B body\n');
    expect(fresh.frontmatter).toEqual({ title: 'From B' });
  });

  it('reopening the same vault loads its notes normally', async () => {
    const m = noteStore.acquire('a.md', 'tile');
    await m.loaded;
    await swapTo('/vault/A');
    commit('/vault/A');
    expect(noteStore.get('a.md')).toBeUndefined();
    const again = noteStore.acquire('a.md', 'tile');
    await again.loaded;
    expect(again.status).toBe('ready');
    expect(again.body).toBe('Vault A body\n');
  });

  it('every spelling of a path acquires the same model (repeat acquire is idempotent)', async () => {
    const first = noteStore.acquire('a.md', 'tile');
    const second = noteStore.acquire('A.MD', 'tile');
    expect(second).toBe(first);
    await first.loaded;
    expect(first.status).toBe('ready');
  });

  it('a new-vault view acquiring while the stale view still holds the unadopted model gets the new vault note', async () => {
    // The vault changes while the first read is in flight; from then on the
    // path names vault B's file.
    vault.afterRead = () => { vault.afterRead = null; commit('/vault/B'); vault.writeExternally('a.md', B_TEXT); };
    const stale = noteStore.acquire('a.md', 'old-tile');
    await stale.loaded;
    const fresh = noteStore.acquire('a.md', 'new-tile');
    await fresh.loaded;
    await new Promise((r) => setTimeout(r, 20));
    expect(fresh.status).toBe('ready');
    expect(fresh.body).toBe('Vault B body\n');
  });
});

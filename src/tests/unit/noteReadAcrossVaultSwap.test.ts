/**
 * A read of the outgoing vault's note that is still in flight when a vault
 * swap commits (File > Open Vault with nothing unsaved) must not land in the new
 * vault: neither as a loaded model's frontmatter, nor as a field edit whose
 * "before" read spanned the swap and would then write into the new vault's
 * same-named file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { noteStore } from '@renderer/stores/notes.svelte';
import { UpdateCardFieldCommand } from '@renderer/commands/kanbanCommands';
import { fireVaultSwap } from '@renderer/core/vaultLifecycle';
import { setActiveVaultPath } from '@renderer/lib/vault/activeVaultPath';
import { beginVaultGeneration, __resetVaultIdentityForTests } from '@renderer/lib/vault/vaultIdentity';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

const VAULT_A_NOTE = '---\npriority: high\ntitle: VaultA Card\n---\nbody A\n';
const VAULT_B_NOTE = '---\ntitle: VaultB Card\n---\nbody B\n';

let releaseRead: () => void;
let writes: Array<{ root: string; rel: string }>;

/** Vault A's reads wait on a gate so a swap can land during them; vault B answers at once. */
function installVaults(): void {
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  installFiloMock((channel: string, ...args: unknown[]) => {
    const root = args[0] as string;
    const rel = args[1] as string;
    if (channel === 'vault:read-file-text') {
      if (root === '/vaultA') {
        return readGate.then(() => ({ success: true, content: VAULT_A_NOTE, mtimeMs: 5, size: VAULT_A_NOTE.length, encoding: 'utf-8' }));
      }
      return { success: true, content: VAULT_B_NOTE, mtimeMs: 7, size: VAULT_B_NOTE.length, encoding: 'utf-8' };
    }
    if (channel === 'vault:stat') {
      return root === '/vaultA'
        ? { success: true, mtimeMs: 5, size: VAULT_A_NOTE.length }
        : { success: true, mtimeMs: 7, size: VAULT_B_NOTE.length };
    }
    if (channel.startsWith('vault:write') || channel === 'vault:create-file-text') {
      writes.push({ root, rel });
      return { success: true };
    }
    return { success: true };
  });
}

async function swapToVaultB(): Promise<void> {
  await fireVaultSwap({ phase: 'pre-swap', previousVault: '/vaultA', nextVault: '/vaultB', saveOutgoing: false });
  beginVaultGeneration('/vaultB');
  setActiveVaultPath('/vaultB');
}

describe('a note read that spans a vault swap is dropped', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    __resetVaultIdentityForTests();
    beginVaultGeneration('/vaultA');
    setActiveVaultPath('/vaultA');
    noteStore.__resetForTests();
    writes = [];
    installVaults();
  });
  afterEach(() => {
    noteStore.__resetForTests();
    setActiveVaultPath('');
    restoreFiloDefault();
    __resetVaultIdentityForTests();
  });

  it('does NOT load vault A\'s frontmatter into the new vault when a swap commits during the read', async () => {
    const m = noteStore.acquire('Note.md', 'card');
    await Promise.resolve();

    await swapToVaultB();
    expect(noteStore.get('Note.md')).toBeUndefined();

    releaseRead();
    await m.loaded;

    // The orphaned model never adopted vault A's bytes, and nothing in vault
    // B's store shows them.
    expect(m.status).toBe('loading');
    expect(m.frontmatter).toEqual({});
    expect(noteStore.get('Note.md')).toBeUndefined();
    expect(noteStore.frontmatter('Note.md').priority).toBeUndefined();
  });

  it('a field edit whose first read spans the swap writes nothing to the new vault', async () => {
    const cmd = new UpdateCardFieldCommand('kb', 'Note.md', { priority: 'low' }, { priority: 'high' });
    const executing = cmd.execute();
    await Promise.resolve();

    await swapToVaultB();
    releaseRead();
    await executing;

    expect(noteStore.hasPendingWrites('Note.md')).toBe(false);
    await noteStore.flushAll();
    expect(writes.filter((w) => w.rel.endsWith('.md'))).toEqual([]);
  });

  it('still loads normally when no swap lands during the read', async () => {
    const m = noteStore.acquire('Note.md', 'card');
    await Promise.resolve();
    releaseRead();
    await m.loaded;
    expect(m.status).toBe('ready');
    expect(m.frontmatter).toEqual({ priority: 'high', title: 'VaultA Card' });
  });
});

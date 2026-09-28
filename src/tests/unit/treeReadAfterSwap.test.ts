/**
 * A sidebar tree read sent for the vault being left can come back refused
 * (NO_ACTIVE_VAULT) once main has released that vault. It says nothing about
 * the sidebar on screen, so it raises no error; the same refusal for the vault
 * still open does.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { onError, type ReportedError } from '@renderer/lib/utils/errorBus';
import { beginVaultGeneration, __resetVaultIdentityForTests } from '@renderer/lib/vault/vaultIdentity';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

let answerRead: (envelope: unknown) => void = () => {};
let reported: ReportedError[] = [];
let off: () => void = () => {};

beforeEach(() => {
  __resetVaultIdentityForTests();
  vaultStore.setPath('/old');
  beginVaultGeneration('/old');
  vaultStore.setTree([{ name: 'A.md', path: '/old/A.md', isDirectory: false }]);
  installFiloMock((channel: unknown) => {
    if (channel === 'vault:read-tree') return new Promise((resolve) => { answerRead = resolve; });
    return null;
  });
  reported = [];
  off = onError((e) => reported.push(e));
});

afterEach(() => {
  off();
  restoreFiloDefault();
  vaultStore.setTree([]);
  vaultStore.setPath('');
  __resetVaultIdentityForTests();
});

const REFUSED = { ok: false, code: 'NO_ACTIVE_VAULT', error: 'vaultRoot does not match the active vault' };

describe('a tree read refused after a vault swap', () => {
  it('raises no error when the vault changed while the read was out', async () => {
    const refresh = vaultStore.refreshTree();
    vaultStore.setPath('/new');
    beginVaultGeneration('/new');
    answerRead(REFUSED);
    expect(await refresh).toBe(false);
    expect(reported).toEqual([]);
  });

  it('still says so when the vault on screen is the one refused', async () => {
    const refresh = vaultStore.refreshTree();
    answerRead(REFUSED);
    expect(await refresh).toBe(false);
    expect(reported.map((r) => r.message)).toEqual([
      'Could not read vault tree (NO_ACTIVE_VAULT). The sidebar may be out of date.',
    ]);
  });
});

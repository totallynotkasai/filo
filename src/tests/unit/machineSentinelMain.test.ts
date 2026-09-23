import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Audit-19 EXT-6 / ERR-8 — main side: machine identity in userData, ownership
 * enforcement in `assertNotInFiloDir`, and no config seeding into a `.filo/`
 * another machine created.
 */

let userData = '';
vi.mock('electron', () => ({ app: { getPath: () => userData } }));

const { getMachineIdentity, __setMachineIdentityForTests, registerMachineInVault } = await import(
  '../../main/services/machineIdentity'
);
const { assertNotInFiloDir, FiloDirForbiddenError } = await import('../../main/utils/pathSecurity');
const { initVaultConfig } = await import('../../main/vault/configOps');

describe('machine identity (userData/machine-id.json)', () => {
  beforeEach(async () => {
    userData = await fs.mkdtemp(join(tmpdir(), 'filo-userdata-'));
    __setMachineIdentityForTests(null);
  });
  afterEach(async () => {
    __setMachineIdentityForTests(null);
    await fs.rm(userData, { recursive: true, force: true });
  });

  it('is stable across calls and persisted', async () => {
    const first = getMachineIdentity();
    expect(first.machineId).toMatch(/^[0-9a-f]{12}$/);
    expect(getMachineIdentity()).toBe(first);
    await vi.waitFor(async () => {
      const raw = JSON.parse(await fs.readFile(join(userData, 'machine-id.json'), 'utf-8'));
      expect(raw.id).toBe(first.machineId);
    });
    __setMachineIdentityForTests(null); // a "new process" reads the same file
    expect(getMachineIdentity().machineId).toBe(first.machineId);
  });

  it('a corrupt file is regenerated', async () => {
    await fs.writeFile(join(userData, 'machine-id.json'), '{ not json');
    expect(getMachineIdentity().machineId).toMatch(/^[0-9a-f]{12}$/);
  });

  it('registerMachineInVault writes .filo/machines/<id>.json once', async () => {
    const vault = await fs.mkdtemp(join(tmpdir(), 'filo-vault-'));
    try {
      const me = getMachineIdentity();
      await registerMachineInVault(vault);
      const raw = JSON.parse(await fs.readFile(join(vault, '.filo', 'machines', `${me.machineId}.json`), 'utf-8'));
      expect(raw.hostname).toBe(me.hostname);
    } finally {
      await fs.rm(vault, { recursive: true, force: true });
    }
  });
});

describe('assertNotInFiloDir — per-machine sentinel ownership', () => {
  beforeEach(() => __setMachineIdentityForTests({ machineId: 'aaaaaaaaaaaa', hostname: 'A' }));
  afterEach(() => __setMachineIdentityForTests(null));

  it('a write/delete of ANOTHER machine\'s sentinel is refused (bite: any sentinel name passed before)', () => {
    expect(() => assertNotInFiloDir('.filo/.dirty.bbbbbbbbbbbb')).toThrow(FiloDirForbiddenError);
    expect(() => assertNotInFiloDir('.filo/tag-rewrite-pending.bbbbbbbbbbbb.json')).toThrow(FiloDirForbiddenError);
  });

  it("this machine's own sentinels and the legacy names are allowed", () => {
    expect(() => assertNotInFiloDir('.filo/.dirty.aaaaaaaaaaaa')).not.toThrow();
    expect(() => assertNotInFiloDir('.filo/quit-failure.aaaaaaaaaaaa.json')).not.toThrow();
    expect(() => assertNotInFiloDir('.filo/.dirty')).not.toThrow();
  });

  it('read access may name any machine; other .filo files stay forbidden', () => {
    expect(() => assertNotInFiloDir('.filo/.dirty.bbbbbbbbbbbb', { access: 'read' })).not.toThrow();
    expect(() => assertNotInFiloDir('.filo/app.json')).toThrow(FiloDirForbiddenError);
    expect(() => assertNotInFiloDir('.filo/app.json', { access: 'read' })).toThrow(FiloDirForbiddenError);
  });
});

describe('initVaultConfig — ERR-8 seeding', () => {
  let vault: string;
  beforeEach(async () => {
    vault = await fs.mkdtemp(join(tmpdir(), 'filo-init-'));
  });
  afterEach(async () => {
    await fs.rm(vault, { recursive: true, force: true });
  });

  it('a brand-new vault is seeded with defaults', async () => {
    await initVaultConfig(vault);
    await expect(fs.access(join(vault, '.filo', 'app.json'))).resolves.toBeUndefined();
  });

  it('an existing .filo/ (synced from another machine) without app.json is NOT seeded (bite)', async () => {
    await fs.mkdir(join(vault, '.filo'));
    await initVaultConfig(vault);
    await expect(fs.access(join(vault, '.filo', 'app.json'))).rejects.toBeDefined();
  });
});

/**
 * appearance.json is fully Filo-owned: it carries `activeTheme` and `font`
 * only. The debounced writer emits exactly those two keys through a
 * whole-file (atomic tmp+rename) replace, so the freshly-initialised seed must
 * NOT declare a `snippets` array the next theme/font save would silently drop.
 *
 * Disk shape and code ownership agree: the seed carries no `snippets: []`,
 * because the write never preserved on-disk snippets (it is a whole-file
 * replace). A hand-added `snippets` is explicitly unmanaged.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initVaultConfig } from '../../main/vault/configOps';

describe('initVaultConfig seeds appearance.json without snippets', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await fs.mkdtemp(join(tmpdir(), 'filo-appearance-'));
  });
  afterEach(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  it('writes only activeTheme + font (no snippets key)', async () => {
    await initVaultConfig(vaultRoot);
    const raw = await fs.readFile(join(vaultRoot, '.filo', 'appearance.json'), 'utf-8');
    const appearance = JSON.parse(raw) as Record<string, unknown>;

    expect(appearance.activeTheme).toBe('light');
    expect(typeof appearance.font).toBe('string');
    // The writer never emits `snippets`; the seed must match so the first
    // theme/font change doesn't drop a key the seed itself put there.
    expect('snippets' in appearance).toBe(false);
  });
});

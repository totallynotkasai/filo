import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  loadConfig,
  loadTheme,
  isCorruptConfig,
} from '../../main/vault/configOps';
import { PAYLOAD_LIMITS } from '../../main/utils/payloadLimits';

/**
 * Read-path payload caps. Every JSON file we read from
 * `.filo/` is stat-checked before the read so a hand-edited (or simply
 * corrupted) multi-GB file aborts up front instead of being buffered into
 * main-process memory only to fail downstream.
 *
 * Each test plants an oversized file relative to the per-channel cap and
 * asserts the reader refuses it:
 *  - `loadConfig` returns the `__corrupt` sentinel (NOT the bootstrap
 *    fallback, otherwise the next save would silently rewrite the file).
 *  - `loadTheme` throws.
 *
 * The under-cap counterparts are spot-checked to keep the happy path
 * pinned alongside the size-rejection path.
 */
describe('read-path payload caps', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await fs.mkdtemp(join(tmpdir(), 'filo-read-caps-'));
    await fs.mkdir(join(vaultRoot, '.filo'), { recursive: true });
    await fs.mkdir(join(vaultRoot, '.filo', 'themes'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  describe('loadConfig', () => {
    it('returns __corrupt when the file exceeds PAYLOAD_LIMITS.CONFIG', async () => {
      // Allocate a single buffer one byte over the cap. Cheaper than
      // writing a CONFIG-sized JSON document character-by-character.
      const oversize = Buffer.alloc(PAYLOAD_LIMITS.CONFIG + 1, 0x7b /* '{' */);
      await fs.writeFile(join(vaultRoot, '.filo', 'app.json'), oversize);

      const result = await loadConfig(vaultRoot, 'app.json', { isBootstrap: true });
      expect(isCorruptConfig(result)).toBe(true);
      if (isCorruptConfig(result)) {
        expect(result.error).toMatch(/cap|too large|FILE_TOO_LARGE/i);
      }
    });

    it('still parses a normal-sized config file', async () => {
      await fs.writeFile(
        join(vaultRoot, '.filo', 'app.json'),
        JSON.stringify({ globalFont: 'Inter' }),
        'utf-8',
      );
      const result = await loadConfig(vaultRoot, 'app.json', {});
      expect(result).toEqual({ globalFont: 'Inter' });
    });
  });

  describe('loadTheme', () => {
    it('throws FILE_TOO_LARGE when the theme file exceeds PAYLOAD_LIMITS.THEME', async () => {
      const oversize = Buffer.alloc(PAYLOAD_LIMITS.THEME + 1, 0x20 /* space */);
      await fs.writeFile(
        join(vaultRoot, '.filo', 'themes', 'big.json'),
        oversize,
      );

      await expect(loadTheme(vaultRoot, 'big')).rejects.toThrow(
        /cap|too large|FILE_TOO_LARGE/i,
      );
    });

    it('loads a normal-sized theme file', async () => {
      await fs.writeFile(
        join(vaultRoot, '.filo', 'themes', 'small.json'),
        JSON.stringify({ name: 'Small', '--ui-accent': '#123' }),
        'utf-8',
      );
      const result = await loadTheme(vaultRoot, 'small');
      expect(result).toEqual({ name: 'Small', '--ui-accent': '#123' });
    });
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadConfig, isCorruptConfig } from '../../main/vault/configOps';

/**
 * Phase 5 (P0-13) regression guard: `loadConfig` distinguishes the three
 * load outcomes — file missing (ENOENT), file present + parses, file
 * present + fails to parse. The corrupt sentinel is what the renderer
 * relies on to gate the debounced writer; if it ever silently dropped to
 * the bootstrap fallback again, the next save would clobber the user's
 * hand-edited file.
 */
describe('loadConfig', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await fs.mkdtemp(join(tmpdir(), 'filo-config-'));
    await fs.mkdir(join(vaultRoot, '.filo'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  it('returns the fallback when the file does not exist (ENOENT)', async () => {
    const fallback = { isBootstrap: true };
    const result = await loadConfig(vaultRoot, 'app.json', fallback);
    expect(result).toBe(fallback);
  });

  it('returns the parsed JSON when the file is well-formed', async () => {
    await fs.writeFile(
      join(vaultRoot, '.filo', 'app.json'),
      JSON.stringify({ globalFont: 'Inter' }),
      'utf-8',
    );
    const result = await loadConfig(vaultRoot, 'app.json', {});
    expect(result).toEqual({ globalFont: 'Inter' });
    expect(isCorruptConfig(result)).toBe(false);
  });

  it('returns a __corrupt sentinel when the file exists but is malformed', async () => {
    await fs.writeFile(
      join(vaultRoot, '.filo', 'app.json'),
      '{ "globalFont": "Inter", // trailing comma + comment',
      'utf-8',
    );
    const result = await loadConfig(vaultRoot, 'app.json', { isBootstrap: true });
    expect(isCorruptConfig(result)).toBe(true);
    if (isCorruptConfig(result)) {
      expect(result.__corrupt).toBe(true);
      // The raw bytes are preserved so the user / a recovery flow can
      // recover the original content.
      expect(result.raw).toContain('trailing comma');
      expect(result.error).toMatch(/JSON/);
    }
  });

  it('returns the inner value for a legacy double-stringified payload', async () => {
    // Earlier shipped builds wrote configs double-stringified; loadConfig
    // detects a top-level string parse and parses again so existing vaults
    // keep loading without the user noticing.
    await fs.writeFile(
      join(vaultRoot, '.filo', 'app.json'),
      JSON.stringify(JSON.stringify({ globalFont: 'Legacy' })),
      'utf-8',
    );
    const result = await loadConfig(vaultRoot, 'app.json', {});
    expect(result).toEqual({ globalFont: 'Legacy' });
  });

  it('treats a legacy file whose inner string fails to parse as corrupt', async () => {
    await fs.writeFile(
      join(vaultRoot, '.filo', 'app.json'),
      JSON.stringify('not valid JSON content'),
      'utf-8',
    );
    const result = await loadConfig(vaultRoot, 'app.json', {});
    expect(isCorruptConfig(result)).toBe(true);
  });

  /**
   * Phase 23 M21 — transient lock windows (Windows Defender mid-scan,
   * Dropbox indexer, antivirus) used to fall through to the catch-all
   * corruption branch, permanently disabling the writer for that session
   * even after the lock released. The retry gives one extra attempt after
   * 500ms before classifying the failure.
   */
  it('retries the read once after EACCES before classifying as corrupt', async () => {
    // Simulate a transient EACCES via a monkey-patched fs.readFile.
    const { promises: realFs } = await import('fs');
    const original = realFs.readFile;
    let attempts = 0;
    const filePath = join(vaultRoot, '.filo', 'app.json');
    await fs.writeFile(filePath, JSON.stringify({ globalFont: 'Inter' }), 'utf-8');

    (realFs as { readFile: typeof realFs.readFile }).readFile = (async (
      ...args: Parameters<typeof realFs.readFile>
    ) => {
      attempts++;
      if (attempts === 1 && args[0] === filePath) {
        const err = new Error('EACCES: permission denied (simulated)') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      return original(...args);
    }) as typeof realFs.readFile;

    try {
      const result = await loadConfig(vaultRoot, 'app.json', {});
      expect(attempts).toBe(2);
      expect(result).toEqual({ globalFont: 'Inter' });
      expect(isCorruptConfig(result)).toBe(false);
    } finally {
      (realFs as { readFile: typeof realFs.readFile }).readFile = original;
    }
  });

  it('surfaces a corrupt sentinel when EACCES persists past the retry', async () => {
    const { promises: realFs } = await import('fs');
    const original = realFs.readFile;
    const filePath = join(vaultRoot, '.filo', 'app.json');
    // Plant a real file so the Phase 8 / 8.1 pre-stat succeeds; the test is
    // pinning EACCES on readFile specifically, not "file missing".
    await fs.writeFile(filePath, JSON.stringify({ globalFont: 'Inter' }), 'utf-8');

    (realFs as { readFile: typeof realFs.readFile }).readFile = (async (
      ...args: Parameters<typeof realFs.readFile>
    ) => {
      if (args[0] === filePath) {
        const err = new Error('EACCES: permission denied (simulated)') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      return original(...args);
    }) as typeof realFs.readFile;

    try {
      const result = await loadConfig(vaultRoot, 'app.json', {});
      expect(isCorruptConfig(result)).toBe(true);
    } finally {
      (realFs as { readFile: typeof realFs.readFile }).readFile = original;
    }
  });
});

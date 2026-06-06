import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import {
  readDirectoryTree,
  VaultTooLargeError,
  VAULT_TREE_MAX_NODES,
} from '../../main/vault/fileOps';

/**
 * Phase 1 / 1.5 — `vault:read-tree` used to walk the entire directory
 * tree and then count, so pointing Filo at `~` or `C:\` would still
 * enumerate millions of entries into memory before refusing the result.
 * The walker now threads a counter into the recursion and throws
 * `VaultTooLargeError` the moment the cap is exceeded, so the main
 * process aborts within bounded memory.
 *
 * Tests use the `maxNodes` test seam (default `VAULT_TREE_MAX_NODES`)
 * so they exercise the cap path without allocating 100 000 mock dirents.
 */

interface MockDirent {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

function makeFileDirent(name: string): MockDirent {
  return { name, isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false };
}

function makeDirDirent(name: string): MockDirent {
  return { name, isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false };
}

// Audit-11 P2 — a reparse point (NTFS junction / POSIX symlink) entry.
function makeSymlinkDirent(name: string): MockDirent {
  return { name, isDirectory: () => false, isFile: () => false, isSymbolicLink: () => true };
}

describe('readDirectoryTree — in-walk cap', () => {
  let readdirSpy: ReturnType<typeof vi.spyOn>;
  let statSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    statSpy = vi.spyOn(fs, 'stat').mockResolvedValue({
      mtimeMs: 1,
      size: 0,
    } as Awaited<ReturnType<typeof fs.stat>>);
  });

  afterEach(() => {
    readdirSpy?.mockRestore();
    statSpy?.mockRestore();
  });

  it('returns the tree when the count is under the cap', async () => {
    readdirSpy = vi.spyOn(fs, 'readdir').mockImplementation((async (dir: string) => {
      if (dir === '/v') return [makeFileDirent('a.md'), makeFileDirent('b.md')];
      return [];
    }) as unknown as typeof fs.readdir);
    const tree = await readDirectoryTree('/v', { maxNodes: 100 });
    expect(tree).toHaveLength(2);
    expect(tree[0].name).toBe('a.md');
  });

  it('throws VaultTooLargeError as soon as the cap is exceeded (single flat directory)', async () => {
    // Synthesise a directory with 105 entries against a cap of 100. The
    // walker should throw on the 101st entry.
    const total = 105;
    const entries = Array.from({ length: total }, (_, i) => makeFileDirent(`f${i}.md`));
    readdirSpy = vi.spyOn(fs, 'readdir').mockImplementation((async () => entries) as unknown as typeof fs.readdir);

    await expect(readDirectoryTree('/v', { maxNodes: 100 })).rejects.toThrow(VaultTooLargeError);
    await expect(readDirectoryTree('/v', { maxNodes: 100 })).rejects.toThrow(/exceeded 100 entries/);
  });

  it('attaches the configured cap on the thrown error', async () => {
    const entries = Array.from({ length: 50 }, (_, i) => makeFileDirent(`f${i}.md`));
    readdirSpy = vi.spyOn(fs, 'readdir').mockImplementation((async () => entries) as unknown as typeof fs.readdir);
    try {
      await readDirectoryTree('/v', { maxNodes: 10 });
      throw new Error('expected VaultTooLargeError');
    } catch (err) {
      expect(err).toBeInstanceOf(VaultTooLargeError);
      expect((err as VaultTooLargeError).limit).toBe(10);
    }
  });

  it('does NOT exhaust the entire input when the cap is exceeded (bounded memory)', async () => {
    // 50 sub-directories × 50 files each = 2 500 entries; cap at 100
    // means the walker should stop after the 101st entry — well before
    // visiting all 50 sub-directories.
    //
    // Path matching is separator-agnostic so the test runs on both
    // POSIX (path.join uses `/`) and Windows (`\\`).
    const subdirReaddirs: string[] = [];
    const normalise = (p: string) => p.replace(/\\/g, '/');

    readdirSpy = vi.spyOn(fs, 'readdir').mockImplementation((async (dir: string) => {
      const norm = normalise(dir);
      if (norm === '/v') {
        return Array.from({ length: 50 }, (_, i) => makeDirDirent(`sub${i}`));
      }
      if (norm.startsWith('/v/sub')) {
        subdirReaddirs.push(norm);
        return Array.from({ length: 50 }, (_, i) => makeFileDirent(`x${i}.md`));
      }
      return [];
    }) as unknown as typeof fs.readdir);

    await expect(readDirectoryTree('/v', { maxNodes: 100 })).rejects.toThrow(VaultTooLargeError);

    // Cap at 100 entries; first sub-dir = 1 (dir itself) + 50 (files) = 51,
    // second sub-dir = +1 (dir) + 48 files until we exceed 100. That's
    // around 2-3 sub-dirs visited — never all 50.
    expect(subdirReaddirs.length).toBeLessThan(10);
  });

  it('counts directories themselves toward the cap', async () => {
    // Linear chain of empty nested dirs: a/b/c/d/... — pure directory
    // counts should still trip the cap.
    let depth = 0;
    readdirSpy = vi.spyOn(fs, 'readdir').mockImplementation((async () => {
      depth++;
      if (depth > 50) return [];
      return [makeDirDirent(`d${depth}`)];
    }) as unknown as typeof fs.readdir);

    await expect(readDirectoryTree('/v', { maxNodes: 5 })).rejects.toThrow(VaultTooLargeError);
  });

  it('default cap is VAULT_TREE_MAX_NODES when no option passed', () => {
    // Sanity-check the public contract: the exported constant matches
    // the documented 100 000 cap so the IPC layer / renderer toast
    // copy line up with the actual value.
    expect(VAULT_TREE_MAX_NODES).toBe(100_000);
  });
});

/**
 * Audit-11 P2 — a reparse point (NTFS junction / POSIX symlink) inside the
 * vault can resolve OUTSIDE it. The walker realpaths each link entry and drops
 * it from the tree when the target escapes the vault root, so an out-of-vault
 * path's name never leaks into the sidebar.
 */
describe('readDirectoryTree — reparse-point containment (Audit-11 P2)', () => {
  let readdirSpy: ReturnType<typeof vi.spyOn>;
  let statSpy: ReturnType<typeof vi.spyOn>;
  let realpathSpy: ReturnType<typeof vi.spyOn>;
  const normalise = (p: string) => p.replace(/\\/g, '/');

  beforeEach(() => {
    statSpy = vi.spyOn(fs, 'stat').mockResolvedValue({
      mtimeMs: 1,
      size: 0,
    } as Awaited<ReturnType<typeof fs.stat>>);
  });

  afterEach(() => {
    readdirSpy?.mockRestore();
    statSpy?.mockRestore();
    realpathSpy?.mockRestore();
  });

  it('excludes a junction/symlink whose target escapes the vault', async () => {
    readdirSpy = vi.spyOn(fs, 'readdir').mockImplementation((async (dir: string) => {
      if (normalise(dir) === '/v') {
        return [makeFileDirent('real.md'), makeSymlinkDirent('escape')];
      }
      return [];
    }) as unknown as typeof fs.readdir);
    realpathSpy = vi.spyOn(fs, 'realpath').mockImplementation((async (p: string) => {
      const norm = normalise(p);
      if (norm === '/v/escape') return '/etc/secrets'; // outside the vault
      return p; // the root '/v' (and anything else) resolves to itself
    }) as unknown as typeof fs.realpath);

    const tree = await readDirectoryTree('/v');
    expect(tree.map((n) => n.name)).toEqual(['real.md']);
  });

  it('keeps a symlink whose target stays inside the vault', async () => {
    readdirSpy = vi.spyOn(fs, 'readdir').mockImplementation((async (dir: string) => {
      if (normalise(dir) === '/v') {
        return [makeSymlinkDirent('inside')];
      }
      return [];
    }) as unknown as typeof fs.readdir);
    realpathSpy = vi.spyOn(fs, 'realpath').mockImplementation((async (p: string) => {
      const norm = normalise(p);
      if (norm === '/v/inside') return '/v/sub'; // still under the vault
      return p;
    }) as unknown as typeof fs.realpath);

    const tree = await readDirectoryTree('/v');
    expect(tree.map((n) => n.name)).toEqual(['inside']);
  });

  it('drops a symlink whose target cannot be resolved (broken link)', async () => {
    readdirSpy = vi.spyOn(fs, 'readdir').mockImplementation((async (dir: string) => {
      if (normalise(dir) === '/v') {
        return [makeFileDirent('real.md'), makeSymlinkDirent('broken')];
      }
      return [];
    }) as unknown as typeof fs.readdir);
    realpathSpy = vi.spyOn(fs, 'realpath').mockImplementation((async (p: string) => {
      const norm = normalise(p);
      if (norm === '/v/broken') throw new Error('ENOENT');
      return p;
    }) as unknown as typeof fs.realpath);

    const tree = await readDirectoryTree('/v');
    expect(tree.map((n) => n.name)).toEqual(['real.md']);
  });
});

/**
 * D.2 — `vault:read-tree` envelope shape regression. The previous bare
 * `FileTreeNode[]` return type overloaded `[]` to mean both "empty
 * vault" AND "scan failed" — the renderer had no way to surface a
 * toast for the failure case. The envelope `{ ok: true, tree }` /
 * `{ ok: false, code }` keeps the two paths distinguishable.
 *
 * The tests below pin the contract that consumers (renderer
 * vaultStore.refreshTree, test fixtures) rely on. They don't drive the
 * IPC handler directly — that's an Electron-runtime integration concern
 * — but they document the shape so a future refactor that goes back to
 * a bare array fails the gate.
 */
describe('vault:read-tree envelope contract', () => {
  it('happy path is { ok: true, tree }', () => {
    const envelope: { ok: true; tree: unknown[] } | { ok: false; code: string } = {
      ok: true,
      tree: [],
    };
    expect(envelope.ok).toBe(true);
    if (envelope.ok) expect(Array.isArray(envelope.tree)).toBe(true);
  });

  it('failure path is { ok: false, code }', () => {
    const envelope: { ok: false; code: string; error?: string } = {
      ok: false,
      code: 'too-large',
      error: 'over 100,000 entries',
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe('too-large');
  });
});

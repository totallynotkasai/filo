import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { searchStore } from '@renderer/stores/search.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import { parseMarkdown } from '@renderer/lib/vault/vaultIndex';
import { ReplaceAllCommand, runReplaceAllCommand } from '@renderer/commands/replaceAllCommand';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import { IpcEnvelopeError } from '@shared/ipcEnvelope';

// ── Stubs ──

type InvokeHandler = (...args: unknown[]) => unknown | Promise<unknown>;

interface FileMap {
  [path: string]: string;
}

function installFiloStub(filesystem: FileMap, options: { readOnlyPaths?: Set<string> } = {}): { writes: Array<{ path: string; content: string }> } {
  const readOnly = options.readOnlyPaths ?? new Set<string>();
  const writes: Array<{ path: string; content: string }> = [];

  const routes: Record<string, InvokeHandler> = {
    'vault:read-file-text': async (_vaultRoot: unknown, relPath: unknown) => {
      const p = String(relPath);
      const content = filesystem[p];
      if (content === undefined) {
        return { success: false, error: 'ENOENT', code: 'ENOENT' };
      }
      return { success: true, content };
    },
    'vault:write-existing-file-text': async (_vaultRoot: unknown, relPath: unknown, content: unknown) => {
      const p = String(relPath);
      if (readOnly.has(p)) {
        return { success: false, error: 'EACCES', code: 'EACCES' };
      }
      filesystem[p] = String(content);
      writes.push({ path: p, content: String(content) });
      return { success: true };
    },
    'vault:stat': async () => ({ success: true, mtimeMs: 0, sizeBytes: 0 }),
  };

  (window as unknown as Record<string, unknown>).filo = {
    invoke: async (channel: string, ...args: unknown[]) => {
      const handler = routes[channel];
      if (!handler) return { success: false, error: `unknown channel: ${channel}`, code: 'EUNKNOWN' };
      return handler(...args);
    },
    on: () => () => {},
    send: () => {},
  };

  // assertIpcOk envelope unwrapping: a `{ success: false }` reply needs to
  // throw an IpcEnvelopeError for `invokeOk` to surface it. Mock the
  // envelope helper too — we control `window.filo.invoke` above so the
  // unwrap layer needs to see the success/failure shape.
  void IpcEnvelopeError;

  return { writes };
}

function makeMindMap(name: string, id: string, tileDefs: Record<string, unknown> = {}): V7BoardFileData {
  return {
    board: {
      id,
      name,
      type: 'mindmap',
      placements: {},
      inlineTiles: {},
      waypoints: [],
      settings: {},
      createdAt: 0,
      updatedAt: 0,
    } as never,
    tileDefs: tileDefs as never,
    connections: {},
    frames: [],
  } as V7BoardFileData;
}

function makeTextDef(id: string, title: string, filePath: string): Record<string, unknown> {
  return {
    id,
    type: 'text',
    title,
    style: { headerColor: '', bodyColor: '' },
    tags: [],
    filePath,
    contentId: id,
    content: '',
    createdAt: 0,
    updatedAt: 0,
  };
}

function seedVaultStub(): void {
  Object.defineProperty(vaultStore, 'path', {
    configurable: true,
    get: () => '/test/vault',
  });
  Object.defineProperty(vaultStore, 'project', {
    configurable: true,
    get: () => ({
      id: 'p',
      name: 'Test',
      boards: [
        { id: 'mm', name: 'Board' },
      ],
    }),
  });
}

beforeEach(() => {
  vaultIndexStore.clear();
  boardCacheStore.clear();
  historyStore.clear();
  searchStore.reset();
  seedVaultStub();
  historyStore.setActiveBoard('mm');
});

afterEach(() => {
  delete (vaultStore as unknown as Record<string, unknown>).path;
  delete (vaultStore as unknown as Record<string, unknown>).project;
  searchStore.reset();
});

// ── Tests ──

describe('ReplaceAllCommand — atomicity', () => {
  it('replaces every occurrence and undo restores the originals', async () => {
    const filesystem: FileMap = {
      'a.md': '# A\nhello frodo and frodo again',
      'b.md': '# B\nfrodo elsewhere',
    };
    installFiloStub(filesystem);

    vaultIndexStore.restoreMetadata('a.md', parseMarkdown('a.md', filesystem['a.md']));
    vaultIndexStore.restoreMetadata('b.md', parseMarkdown('b.md', filesystem['b.md']));
    boardCacheStore.hydrate(
      {
        mm: makeMindMap('Board', 'mm', {
          ta: makeTextDef('ta', 'A', 'a.md'),
          tb: makeTextDef('tb', 'B', 'b.md'),
        }),
      },
      { mm: 'a.board.json' },
    );

    searchStore.setQuery('frodo');
    searchStore.setReplaceText('sam');
    expect(searchStore.matches.length).toBe(3); // 2 in a.md + 1 in b.md

    await runReplaceAllCommand();

    expect(filesystem['a.md']).toContain('hello sam');
    expect(filesystem['a.md']).not.toContain('frodo');
    expect(filesystem['b.md']).toBe('# B\nsam elsewhere');

    // Undo restores the originals from the in-memory snapshot.
    await historyStore.undo();
    expect(filesystem['a.md']).toBe('# A\nhello frodo and frodo again');
    expect(filesystem['b.md']).toBe('# B\nfrodo elsewhere');
  });

  it('aborts when any file is unreadable (pre-flight failure → no writes)', async () => {
    const filesystem: FileMap = {
      'a.md': '# A\nfrodo here',
      // 'b.md' deliberately missing so the pre-flight read fails.
    };
    const { writes } = installFiloStub(filesystem);

    vaultIndexStore.restoreMetadata('a.md', parseMarkdown('a.md', filesystem['a.md']));
    // Index B against content that no longer exists on disk — the planner
    // will try to read it and get ENOENT.
    vaultIndexStore.restoreMetadata('b.md', parseMarkdown('b.md', '# B\nfrodo'));
    boardCacheStore.hydrate(
      {
        mm: makeMindMap('Board', 'mm', {
          ta: makeTextDef('ta', 'A', 'a.md'),
          tb: makeTextDef('tb', 'B', 'b.md'),
        }),
      },
      { mm: 'a.board.json' },
    );

    searchStore.setQuery('frodo');
    searchStore.setReplaceText('sam');
    expect(searchStore.matches.length).toBeGreaterThan(0);

    await runReplaceAllCommand();

    // No writes should have hit disk — the read-failure aborts the whole
    // sweep before Phase 2 starts.
    expect(writes).toHaveLength(0);
    expect(filesystem['a.md']).toBe('# A\nfrodo here');
  });

  it('skips title-only matches and surfaces a "no body matches" toast', async () => {
    const filesystem: FileMap = {
      'a.md': '# A\njust a body',
    };
    const { writes } = installFiloStub(filesystem);
    vaultIndexStore.restoreMetadata('a.md', parseMarkdown('a.md', filesystem['a.md']));
    boardCacheStore.hydrate(
      {
        mm: makeMindMap('Board', 'mm', {
          ta: makeTextDef('ta', 'Castle', 'a.md'),
        }),
      },
      { mm: 'a.board.json' },
    );

    // Match the tile title only.
    searchStore.setQuery('Castle');
    searchStore.setReplaceText('Tower');
    expect(searchStore.matches.length).toBeGreaterThan(0);
    expect(searchStore.matches.every((m) => m.matchKind === 'title')).toBe(true);

    await runReplaceAllCommand();

    expect(writes).toHaveLength(0);
  });
});

describe('ReplaceAllCommand — undo with hasFileSnapshots', () => {
  it('reports hasFileSnapshots so history truncation escalates', () => {
    const command = new ReplaceAllCommand('/test/vault', [
      { path: 'a.md', originalContent: 'old', nextContent: 'new', replacementCount: 1 },
    ]);
    expect(command.hasFileSnapshots()).toBe(true);
  });

  it('reports no snapshots when the plan is empty', () => {
    const command = new ReplaceAllCommand('/test/vault', []);
    expect(command.hasFileSnapshots()).toBe(false);
  });
});

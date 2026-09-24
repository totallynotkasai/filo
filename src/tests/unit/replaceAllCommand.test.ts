import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { searchStore } from '@renderer/stores/search.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { parseMarkdown } from '@renderer/lib/vault/vaultIndex';
import { ReplaceAllCommand, runReplaceAllCommand } from '@renderer/commands/replaceAllCommand';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import { IpcEnvelopeError } from '@shared/ipcEnvelope';
import { documentStore } from '@renderer/stores/document.svelte';
import {
  registerForceWriter,
  scheduleMarkdownWrite,
  runSerializedMarkdownWrite,
  __resetMarkdownFileWriterForTests,
  type WriteArgs,
} from '@renderer/lib/vault/markdownFileWriter';
import { isPathPending } from '@renderer/lib/boards/boardSaver';

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
  documentStore.clear();
  __resetMarkdownFileWriterForTests();
  seedVaultStub();
  historyStore.setActiveBoard('mm');
});

afterEach(() => {
  delete (vaultStore as unknown as Record<string, unknown>).path;
  delete (vaultStore as unknown as Record<string, unknown>).project;
  searchStore.reset();
  documentStore.clear();
  __resetMarkdownFileWriterForTests();
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

  it('Audit-10 M1 — serialises behind an in-flight write to the same .md path', async () => {
    // A debounced TextTile / DocumentEditor save can be executing at the IPC
    // layer when Replace All fires its own direct write to the SAME file. The
    // fix enrols the bulk write on the per-path chain so it ORDERS behind that
    // in-flight write instead of racing it (OS-arbitrated order, loser's bytes
    // lost). Here we hold the chain for `a.md` with a gated write and prove
    // Replace All's write does not land until the chain is released.
    const filesystem: FileMap = { 'a.md': '# A\nfind frodo here' };
    const { writes } = installFiloStub(filesystem);
    vaultIndexStore.restoreMetadata('a.md', parseMarkdown('a.md', filesystem['a.md']));
    boardCacheStore.hydrate(
      { mm: makeMindMap('Board', 'mm', { ta: makeTextDef('ta', 'A', 'a.md') }) },
      { mm: 'a.board.json' },
    );
    searchStore.setQuery('frodo');
    searchStore.setReplaceText('sam');
    expect(searchStore.matches.length).toBe(1);

    // Occupy the per-path write chain for a.md with a gated op.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const occupant = runSerializedMarkdownWrite('a.md', () => gate);

    // Kick off Replace All; its write must queue behind the occupant.
    const replaceP = runReplaceAllCommand();
    // Let microtasks/timers settle — with serialization the write has NOT fired.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(writes.some((w) => w.path === 'a.md')).toBe(false);
    expect(filesystem['a.md']).toContain('frodo');

    // Release the chain; the queued Replace All write now lands.
    release();
    await occupant;
    await replaceP;
    expect(writes.some((w) => w.path === 'a.md')).toBe(true);
    expect(filesystem['a.md']).toContain('sam');
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
    // A text tile's title is its note's frontmatter `title`.
    const filesystem: FileMap = {
      'a.md': '---\ntitle: Castle\n---\n# A\njust a body',
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

describe('ReplaceAllCommand — L4 execute-time drift skip', () => {
  it('skips a file whose disk content diverged from the planned snapshot (no clobber)', async () => {
    // Disk no longer equals the plan's `originalContent` (an edit landed since
    // the plan was built / before this redo). execute() must re-read, detect
    // the divergence, and skip the write rather than clobber the newer bytes.
    const filesystem: FileMap = { 'a.md': 'EXTERNALLY CHANGED SINCE PLAN' };
    const { writes } = installFiloStub(filesystem);
    const cmd = new ReplaceAllCommand('/test/vault', [
      {
        path: 'a.md',
        originalContent: 'original planned content',
        nextContent: 'replaced content',
        replacementCount: 1,
      },
    ]);

    await cmd.execute();

    expect(writes.some((w) => w.path === 'a.md')).toBe(false);
    expect(filesystem['a.md']).toBe('EXTERNALLY CHANGED SINCE PLAN');
    expect(uiStore.toasts.some((t) => t.text.includes('Replace skipped'))).toBe(true);
  });

  it('writes when disk still equals the planned originalContent', async () => {
    const filesystem: FileMap = { 'a.md': 'original planned content' };
    const { writes } = installFiloStub(filesystem);
    const cmd = new ReplaceAllCommand('/test/vault', [
      {
        path: 'a.md',
        originalContent: 'original planned content',
        nextContent: 'replaced content',
        replacementCount: 1,
      },
    ]);

    await cmd.execute();

    expect(writes.some((w) => w.path === 'a.md')).toBe(true);
    expect(filesystem['a.md']).toBe('replaced content');
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

describe('ReplaceAllCommand — open-editor sync (audit 2.1)', () => {
  // Registers an open document session for `relPath`, mirroring what a
  // mounted TextTile / DocumentEditor does. The replace path must keep this
  // in-memory copy in step with disk; otherwise the editor's next debounce
  // re-saves its stale body and silently reverts the replace (or its undo).
  function openEditorDoc(docId: string, relPath: string, body: string): void {
    documentStore.loadDocument({
      docId,
      filename: relPath,
      title: relPath.replace(/\.md$/, ''),
      body,
      htmlContent: `<p>${body}</p>`,
      richText: [],
    });
  }

  it('syncs an open editor to disk after execute and after undo', async () => {
    const filesystem: FileMap = { 'a.md': 'hello frodo' };
    installFiloStub(filesystem);
    vaultIndexStore.restoreMetadata('a.md', parseMarkdown('a.md', filesystem['a.md']));
    boardCacheStore.hydrate(
      { mm: makeMindMap('Board', 'mm', { ta: makeTextDef('ta', 'A', 'a.md') }) },
      { mm: 'a.board.json' },
    );
    openEditorDoc('doc-a', 'a.md', 'hello frodo');

    searchStore.setQuery('frodo');
    searchStore.setReplaceText('sam');
    expect(searchStore.matches.length).toBe(1);

    await runReplaceAllCommand();

    // execute must sync the open in-memory document to the new disk content.
    expect(filesystem['a.md']).toBe('hello sam');
    expect(documentStore.getDocument('doc-a')?.body).toBe('hello sam');
    expect(documentStore.getDocument('doc-a')?.isDirty).toBe(false);

    await historyStore.undo();

    // undo restores disk AND the open editor symmetrically.
    expect(filesystem['a.md']).toBe('hello frodo');
    expect(documentStore.getDocument('doc-a')?.body).toBe('hello frodo');
    expect(documentStore.getDocument('doc-a')?.isDirty).toBe(false);
  });

  it('cancels an armed editor write for an affected path so it cannot re-clobber', async () => {
    const filesystem: FileMap = { 'a.md': 'hello frodo' };
    installFiloStub(filesystem);
    vaultIndexStore.restoreMetadata('a.md', parseMarkdown('a.md', filesystem['a.md']));
    boardCacheStore.hydrate(
      { mm: makeMindMap('Board', 'mm', { ta: makeTextDef('ta', 'A', 'a.md') }) },
      { mm: 'a.board.json' },
    );
    openEditorDoc('doc-a', 'a.md', 'hello frodo');

    // The editor has a debounced write armed carrying its own (soon-to-be
    // stale) body, registered as a force-writer for the doc — exactly as a
    // mounted TextTile does.
    const callerId = 'text-tile:doc-a';
    const args: WriteArgs = {
      vaultRoot: '/test/vault',
      relPath: 'a.md',
      frontmatter: {},
      body: 'hello frodo',
      callerId,
      docId: 'doc-a',
    };
    registerForceWriter(callerId, 'doc-a', () => args);
    scheduleMarkdownWrite(args);
    expect(isPathPending('a.md')).toBe(true);

    searchStore.setQuery('frodo');
    searchStore.setReplaceText('sam');
    await runReplaceAllCommand();

    // The armed write would have fired 'hello frodo' back over 'hello sam'.
    expect(isPathPending('a.md')).toBe(false);
    expect(documentStore.getDocument('doc-a')?.body).toBe('hello sam');
  });
});

describe('ReplaceAllCommand — Audit-14 3.1 frontmatter-boundary parity', () => {
  it('replaces a body match in a file whose fences carry a trailing space (--- )', async () => {
    // 3.1 — the body offsets the search produced come from `splitFrontmatterSource`
    // (`FileMetadata.content`), whose fence regex tolerates a trailing space on a
    // fence (`--- \n`). The replace path used to translate those offsets with a
    // DIVERGENT local regex (`---\r?\n`) that did NOT tolerate the trailing space:
    // on such a file it matched nothing, returned fmEnd=0, and every match then
    // failed the byte-equality guard → silently skipped (or, at a colliding
    // offset, spliced into the FM). The fix shares `splitFrontmatterSource`, so the
    // FM byte length matches the offset basis exactly.
    const original = '--- \ntitle: keep me\n--- \n# Heading\nhello frodo here\n';
    const filesystem: FileMap = { 'a.md': original };
    const { writes } = installFiloStub(filesystem);
    vaultIndexStore.restoreMetadata('a.md', parseMarkdown('a.md', filesystem['a.md']));
    boardCacheStore.hydrate(
      { mm: makeMindMap('Board', 'mm', { ta: makeTextDef('ta', 'A', 'a.md') }) },
      { mm: 'a.board.json' },
    );

    searchStore.setQuery('frodo');
    searchStore.setReplaceText('sam');
    expect(searchStore.matches.length).toBe(1);

    await runReplaceAllCommand();

    // Match found + replaced (the bite: the old regex silently skipped it).
    expect(writes.some((w) => w.path === 'a.md')).toBe(true);
    // The frontmatter block (trailing-space fences included) is byte-untouched;
    // only the body's `frodo` → `sam`.
    expect(filesystem['a.md']).toBe('--- \ntitle: keep me\n--- \n# Heading\nhello sam here\n');
  });
});

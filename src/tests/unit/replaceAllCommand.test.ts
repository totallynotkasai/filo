import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { searchStore } from '@renderer/stores/search.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { parseMarkdown } from '@renderer/lib/vault/vaultIndex';
import {
  ReplaceAllCommand,
  applyPlan,
  planFor,
  runReplaceAllCommand,
  type Splice,
} from '@renderer/commands/replaceAllCommand';
import type { BoardFileData } from '@renderer/lib/boards/boardSaver';
import { IpcEnvelopeError } from '@shared/ipcEnvelope';
import { noteStore } from '@renderer/stores/notes.svelte';
import { setActiveVaultPath } from '@renderer/lib/vault/activeVaultPath';
import { beginVaultGeneration, __resetVaultIdentityForTests } from '@renderer/lib/vault/vaultIdentity';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';

// ── Stubs ──

/** One splice per occurrence of `needle` in `content`, in ascending order. */
function splicesFor(content: string, needle: string, after: string): Splice[] {
  const out: Splice[] = [];
  for (let at = content.indexOf(needle); at !== -1; at = content.indexOf(needle, at + needle.length)) {
    out.push({ start: at, before: needle, after });
  }
  return out;
}

type InvokeHandler = (...args: unknown[]) => unknown | Promise<unknown>;

interface FileMap {
  [path: string]: string;
}

function installFiloStub(
  filesystem: FileMap,
  options: { readOnlyPaths?: Set<string>; beforeWrite?: (path: string) => Promise<void> } = {},
): { writes: Array<{ path: string; content: string }> } {
  const readOnly = options.readOnlyPaths ?? new Set<string>();
  const writes: Array<{ path: string; content: string }> = [];
  // Every write bumps the file's mtime, as the OS does; reads and stats agree.
  const mtimes: Record<string, number> = {};
  const identity = (p: string): { mtimeMs: number; size: number } => ({
    mtimeMs: mtimes[p] ?? 1,
    size: new TextEncoder().encode(filesystem[p] ?? '').length,
  });

  const routes: Record<string, InvokeHandler> = {
    'vault:read-file-text': async (_vaultRoot: unknown, relPath: unknown) => {
      const p = String(relPath);
      const content = filesystem[p];
      if (content === undefined) {
        return { success: false, error: 'ENOENT', code: 'ENOENT' };
      }
      return { success: true, content, ...identity(p) };
    },
    'vault:write-existing-file-text': async (_vaultRoot: unknown, relPath: unknown, content: unknown) => {
      const p = String(relPath);
      if (readOnly.has(p)) {
        return { success: false, error: 'EACCES', code: 'EACCES' };
      }
      await options.beforeWrite?.(p);
      filesystem[p] = String(content);
      mtimes[p] = (mtimes[p] ?? 1) + 1;
      writes.push({ path: p, content: String(content) });
      return { success: true };
    },
    'vault:stat': async (_vaultRoot: unknown, relPath: unknown) => {
      const p = String(relPath);
      if (filesystem[p] === undefined) return { success: false, error: 'ENOENT', code: 'ENOENT' };
      return { success: true, ...identity(p) };
    },
    // The crash-recovery sentinel under .filo/ (not a note).
    'vault:write-file-text': async () => ({ success: true }),
    'vault:delete': async () => ({ success: true }),
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

function makeMindMap(name: string, id: string, tileDefs: Record<string, unknown> = {}): BoardFileData {
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
  } as BoardFileData;
}

function makeTextDef(id: string, title: string, filePath: string): Record<string, unknown> {
  return {
    id,
    type: 'text',
    title,
    style: { headerColor: '', bodyColor: '' },
    tags: [],
    filePath,
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
  __resetDirtyTrackingForTests();
  __resetVaultIdentityForTests();
  beginVaultGeneration('/test/vault');
  setActiveVaultPath('/test/vault');
  noteStore.__resetForTests();
  for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
  seedVaultStub();
  historyStore.setActiveBoard('mm');
});

afterEach(() => {
  delete (vaultStore as unknown as Record<string, unknown>).path;
  delete (vaultStore as unknown as Record<string, unknown>).project;
  searchStore.reset();
  noteStore.__resetForTests();
  setActiveVaultPath('');
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

    // Undo puts each replaced match back.
    await historyStore.undo();
    expect(filesystem['a.md']).toBe('# A\nhello frodo and frodo again');
    expect(filesystem['b.md']).toBe('# B\nfrodo elsewhere');
  });

  it('serialises behind an in-flight write to the same .md path, and never clobbers it', async () => {
    // A note write can be executing at the IPC layer when Replace All fires
    // for the SAME file. Replace All runs inside the note's write queue, so
    // it ORDERS behind that write instead of racing it (OS-arbitrated order,
    // loser's bytes lost); once it runs, the file no longer holds the bytes
    // the plan was built from, so it is skipped rather than overwriting them.
    const filesystem: FileMap = { 'a.md': '# A\nfind frodo here' };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = true;
    const { writes } = installFiloStub(filesystem, {
      beforeWrite: async () => {
        if (held) await gate;
      },
    });
    vaultIndexStore.restoreMetadata('a.md', parseMarkdown('a.md', filesystem['a.md']));
    boardCacheStore.hydrate(
      { mm: makeMindMap('Board', 'mm', { ta: makeTextDef('ta', 'A', 'a.md') }) },
      { mm: 'a.board.json' },
    );
    searchStore.setQuery('frodo');
    searchStore.setReplaceText('sam');
    expect(searchStore.matches.length).toBe(1);

    // A frontmatter write for a.md is in flight, held at the IPC layer.
    noteStore.patchFrontmatter('a.md', { set: { status: 'in-flight' }, unset: [] });
    const occupant = noteStore.flush('a.md');
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Kick off Replace All; its write must queue behind the occupant.
    const replaceP = runReplaceAllCommand();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(writes.some((w) => w.path === 'a.md')).toBe(false);
    expect(filesystem['a.md']).toBe('# A\nfind frodo here');

    // Release the in-flight write: it lands, and Replace All leaves it alone.
    held = false;
    release();
    await occupant;
    await replaceP;
    expect(writes.filter((w) => w.path === 'a.md')).toHaveLength(1);
    expect(filesystem['a.md']).toContain('status: in-flight');
    expect(filesystem['a.md']).toContain('find frodo here');
    expect(uiStore.toasts.some((t) => t.text.includes('Replace skipped'))).toBe(true);
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

describe('ReplaceAllCommand — execute-time drift skip', () => {
  it('skips a file whose disk content diverged from the plan (no clobber)', async () => {
    // Disk no longer holds the bytes the plan was built from (an edit landed
    // since the plan was built / before this redo). execute() must re-read,
    // detect the divergence, and skip the write rather than clobber the newer bytes.
    const filesystem: FileMap = { 'a.md': 'EXTERNALLY CHANGED SINCE PLAN' };
    const { writes } = installFiloStub(filesystem);
    const planned = 'original planned content';
    const cmd = new ReplaceAllCommand('/test/vault', [
      planFor('a.md', planned, splicesFor(planned, 'original planned', 'replaced')),
    ]);

    await cmd.execute();

    expect(writes.some((w) => w.path === 'a.md')).toBe(false);
    expect(filesystem['a.md']).toBe('EXTERNALLY CHANGED SINCE PLAN');
    expect(uiStore.toasts.some((t) => t.text.includes('Replace skipped'))).toBe(true);
  });

  it('skips a same-length edit that keeps the splice text but changes other bytes', async () => {
    // The hash, not just the length or the splice text, gates the write.
    const planned = 'frodo went east';
    const filesystem: FileMap = { 'a.md': 'frodo went west' };
    const { writes } = installFiloStub(filesystem);
    const cmd = new ReplaceAllCommand('/test/vault', [
      planFor('a.md', planned, splicesFor(planned, 'frodo', 'sam')),
    ]);

    await cmd.execute();

    expect(writes).toHaveLength(0);
    expect(filesystem['a.md']).toBe('frodo went west');
    expect(uiStore.toasts.some((t) => t.text.includes('Replace skipped'))).toBe(true);
  });

  it('writes when disk still equals the planned original', async () => {
    const planned = 'original planned content';
    const filesystem: FileMap = { 'a.md': planned };
    const { writes } = installFiloStub(filesystem);
    const cmd = new ReplaceAllCommand('/test/vault', [
      planFor('a.md', planned, splicesFor(planned, 'original planned', 'replaced')),
    ]);

    await cmd.execute();

    expect(writes.some((w) => w.path === 'a.md')).toBe(true);
    expect(filesystem['a.md']).toBe('replaced content');
  });
});

describe('ReplaceAllCommand — keeps no copy of the note', () => {
  it('plans hold only the replaced snippets and the before/after hashes', () => {
    const original = '# Private heading\nsecret-body-text frodo more-secret-text frodo tail\n';
    const plan = planFor('a.md', original, splicesFor(original, 'frodo', 'sam'));
    const cmd = new ReplaceAllCommand('/test/vault', [plan]);

    expect(Object.keys(plan).sort()).toEqual(
      ['afterHash', 'afterLength', 'beforeHash', 'beforeLength', 'path', 'splices'],
    );
    expect(plan.splices.map((s) => s.before)).toEqual(['frodo', 'frodo']);
    expect(plan.splices.every((s) => s.after === 'sam')).toBe(true);

    // Nothing but the matches themselves survives on the command.
    const held = JSON.stringify(cmd);
    expect(held).not.toContain('secret-body-text');
    expect(held).not.toContain('more-secret-text');
    expect(held).not.toContain('Private heading');
  });

  it('undo of a multi-match file restores the exact original bytes', async () => {
    // Replacements of a different length shift every later offset: undo must
    // map each splice back to where it now sits.
    const original = '---\r\ntitle: A\r\n---\r\nfrodo, frodo\r\nand frodo again\r\n';
    const filesystem: FileMap = { 'a.md': original };
    installFiloStub(filesystem);
    const plan = planFor('a.md', original, splicesFor(original, 'frodo', 'Samwise Gamgee'));
    expect(plan.splices).toHaveLength(3);
    const cmd = new ReplaceAllCommand('/test/vault', [plan]);

    await cmd.execute();
    expect(filesystem['a.md']).toBe(original.split('frodo').join('Samwise Gamgee'));

    await cmd.undo();
    expect(filesystem['a.md']).toBe(original);
  });

  it('applyPlan refuses text that is not what the plan starts from, in either direction', () => {
    const original = 'frodo and frodo';
    const plan = planFor('a.md', original, splicesFor(original, 'frodo', 'sam'));
    expect(applyPlan(original, plan, true)).toBe('sam and sam');
    expect(applyPlan('sam and sam', plan, false)).toBe(original);
    expect(applyPlan('sam and sam', plan, true)).toBeNull();
    expect(applyPlan(original, plan, false)).toBeNull();
  });
});

describe('ReplaceAllCommand — open views follow', () => {
  // A mounted TextTile / DocumentEditor holds the note's model. The replace
  // (and its undo) must reach that model; otherwise the editor would keep its
  // stale body and a later edit would write it back over the replace.
  async function openView(relPath: string) {
    const m = noteStore.acquire(relPath, `tile:${relPath}`);
    await m.loaded;
    return m;
  }

  it('an open view shows the replaced text after execute and the original after undo', async () => {
    const filesystem: FileMap = { 'a.md': 'hello frodo' };
    installFiloStub(filesystem);
    vaultIndexStore.restoreMetadata('a.md', parseMarkdown('a.md', filesystem['a.md']));
    boardCacheStore.hydrate(
      { mm: makeMindMap('Board', 'mm', { ta: makeTextDef('ta', 'A', 'a.md') }) },
      { mm: 'a.board.json' },
    );
    const m = await openView('a.md');

    searchStore.setQuery('frodo');
    searchStore.setReplaceText('sam');
    expect(searchStore.matches.length).toBe(1);

    await runReplaceAllCommand();

    expect(filesystem['a.md']).toBe('hello sam');
    expect(m.body).toBe('hello sam');
    expect(m.hasUnsavedBody).toBe(false);

    await historyStore.undo();

    // undo restores disk AND the open view symmetrically.
    expect(filesystem['a.md']).toBe('hello frodo');
    expect(m.body).toBe('hello frodo');
    expect(m.hasUnsavedBody).toBe(false);
    // Nothing queued that could write a stale body back later.
    expect(noteStore.hasPendingWrites('a.md')).toBe(false);
  });

  it('execute → undo round-trip on the command itself, with a view open', async () => {
    const filesystem: FileMap = { 'a.md': '---\ntitle: A\n---\nhello frodo\n' };
    const { writes } = installFiloStub(filesystem);
    const m = await openView('a.md');
    const original = '---\ntitle: A\n---\nhello frodo\n';
    const cmd = new ReplaceAllCommand('/test/vault', [
      planFor('a.md', original, splicesFor(original, 'frodo', 'sam')),
    ]);
    await cmd.execute();
    expect(filesystem['a.md']).toBe('---\ntitle: A\n---\nhello sam\n');
    expect(m.body).toBe('hello sam\n');
    await cmd.undo();
    expect(filesystem['a.md']).toBe('---\ntitle: A\n---\nhello frodo\n');
    expect(m.body).toBe('hello frodo\n');
    expect(writes.map((w) => w.path)).toEqual(['a.md', 'a.md']);
  });

  it('an unsaved editor body lands first; the replace then skips the file instead of overwriting it', async () => {
    const filesystem: FileMap = { 'a.md': 'hello frodo' };
    installFiloStub(filesystem);
    vaultIndexStore.restoreMetadata('a.md', parseMarkdown('a.md', filesystem['a.md']));
    boardCacheStore.hydrate(
      { mm: makeMindMap('Board', 'mm', { ta: makeTextDef('ta', 'A', 'a.md') }) },
      { mm: 'a.board.json' },
    );
    const m = await openView('a.md');
    // Typed in the editor, still waiting out the debounce.
    noteStore.setBody('a.md', 'hello frodo, typed', 'tile:a.md');
    expect(noteStore.hasPendingWrites('a.md')).toBe(true);

    searchStore.setQuery('frodo');
    searchStore.setReplaceText('sam');
    await runReplaceAllCommand();

    // The typing reached disk; the replace, planned on the older bytes, left it.
    expect(filesystem['a.md']).toBe('hello frodo, typed');
    expect(m.body).toBe('hello frodo, typed');
    expect(noteStore.hasPendingWrites('a.md')).toBe(false);
    expect(uiStore.toasts.some((t) => t.text.includes('Replace skipped'))).toBe(true);
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

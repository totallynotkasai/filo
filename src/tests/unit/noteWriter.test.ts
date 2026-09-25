/**
 * noteWriter — the one writer of `.md` notes. Built and tested before any
 * caller moves onto it: queue order per path, body + frontmatter coalescing,
 * the body-drift conflict (and its absence for a frontmatter-only change),
 * our own writes recognised by hash, the rename hold, a vault swap mid-flush,
 * refused writes for non-UTF-8 notes, and exclusive creates.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vaultPath, type VaultPath } from '@shared/vaultPath';
import { createNoteWriter, type NoteWriterHost, type NoteWriter } from '../../renderer/lib/notes/noteWriter';
import { noteTextHash, readNoteText, snapshotOf, type DiskSnapshot } from '../../renderer/lib/notes/noteFile';
import { beginVaultGeneration, __resetVaultIdentityForTests } from '../../renderer/lib/vault/vaultIdentity';
import { __resetDirtyTrackingForTests } from '../../renderer/lib/boards/writeStateTracking';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

let vault: MemoryVault;
let writer: NoteWriter;
let bases: Map<VaultPath, DiskSnapshot>;
let conflicts: string[];
let written: Array<{ rel: string; raw: string; bodyVersion?: number }>;
let bodyBlocked: Set<VaultPath>;

function makeWriter(): NoteWriter {
  const host: NoteWriterHost = {
    vaultRoot: () => vault.root,
    baseOf: (p) => bases.get(p),
    hadFrontmatter: (p) => {
      const b = bases.get(p);
      return b ? readNoteText(b.rawText).hasFrontmatter : false;
    },
    canWriteBody: (p) => !bodyBlocked.has(p),
    onBodyConflict: (_p, rel) => conflicts.push(rel),
    onTargetMissing: () => undefined,
    onWritten: (p, rel, text, snapshot, consumed) => {
      bases.set(p, snapshot);
      written.push({ rel, raw: text.raw, bodyVersion: consumed.bodyVersion });
    },
  };
  return createNoteWriter(host);
}

/** Records the file's current bytes as the base a local body is built on. */
function loadBase(rel: string): void {
  bases.set(vaultPath(rel), snapshotOf(readNoteText(vault.read(rel) ?? '')));
}

const mdWrites = (): Array<[string, string, string]> => vault.writes.filter(([, rel]) => rel.endsWith('.md'));

beforeEach(() => {
  __resetDirtyTrackingForTests();
  __resetVaultIdentityForTests();
  beginVaultGeneration('/vault');
  vault = installMemoryVault({
    'A.md': '---\ntitle: A # keep\n---\nOne\n',
    'B.md': '---\ntitle: B\n---\nTwo\n',
  });
  bases = new Map();
  conflicts = [];
  written = [];
  bodyBlocked = new Set();
  writer = makeWriter();
});

afterEach(() => {
  writer.reset();
  vi.useRealTimers();
  restoreFiloDefault();
});

describe('queue', () => {
  it('a body and a frontmatter change within the debounce land as one write', async () => {
    vi.useFakeTimers();
    loadBase('A.md');
    writer.queueBody('A.md', 'One more', 1);
    writer.queueDelta('A.md', { set: { priority: 'high' }, unset: [] });
    writer.queueBody('A.md', 'One more line', 2);
    await vi.advanceTimersByTimeAsync(350);
    vi.useRealTimers();
    await writer.flushAll();
    expect(mdWrites()).toHaveLength(1);
    expect(vault.read('A.md')).toBe('---\ntitle: A # keep\npriority: high\n---\nOne more line\n');
    expect(written.at(-1)?.bodyVersion).toBe(2);
  });

  it('frontmatter changes merge; the latest value of a key wins and an unset removes it', async () => {
    writer.queueDelta('B.md', { set: { a: 1, b: 2 }, unset: [] });
    writer.queueDelta('B.md', { set: { b: 3 }, unset: ['a'] });
    await writer.flush('B.md');
    expect(vault.read('B.md')).toBe('---\ntitle: B\nb: 3\n---\nTwo\n');
  });

  it('writes to one path land in the order they were made, each on the bytes the last one left', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    vault.beforeWrite = async (_rel, text) => {
      if (text.includes('first')) await held;
    };
    writer.queueDelta('A.md', { set: { step: 'first' }, unset: [] });
    const first = writer.flush('A.md');
    await new Promise((r) => setTimeout(r, 20));
    writer.queueDelta('A.md', { set: { other: 'second' }, unset: [] });
    const second = writer.flush('A.md');
    release();
    await Promise.all([first, second]);
    expect(vault.read('A.md')).toBe('---\ntitle: A # keep\nstep: first\nother: second\n---\nOne\n');
    expect(mdWrites().map(([, , t]) => t.includes('other'))).toEqual([false, true]);
  });

  it('writes nothing when the bytes would not change', async () => {
    writer.queueDelta('B.md', { set: { title: 'B' }, unset: [] });
    expect((await writer.flush('B.md')).ok).toBe(true);
    expect(mdWrites()).toHaveLength(0);
    expect(written).toHaveLength(1);
  });
});

describe('changes made on disk by another program', () => {
  it('a frontmatter-only change is not a conflict: the body lands, the new key stays', async () => {
    loadBase('A.md');
    vault.writeExternally('A.md', '---\ntitle: A # keep\nstatus: draft\n---\nOne\n');
    writer.queueBody('A.md', 'Mine', 1);
    expect((await writer.flush('A.md')).ok).toBe(true);
    expect(conflicts).toEqual([]);
    expect(vault.read('A.md')).toBe('---\ntitle: A # keep\nstatus: draft\n---\nMine\n');
  });

  it('a body change is a conflict: the body stays queued, nothing is overwritten', async () => {
    loadBase('A.md');
    vault.writeExternally('A.md', '---\ntitle: A # keep\n---\nTheirs\n');
    writer.queueBody('A.md', 'Mine', 1);
    expect((await writer.flush('A.md')).ok).toBe(false);
    expect(conflicts).toEqual(['A.md']);
    expect(vault.read('A.md')).toBe('---\ntitle: A # keep\n---\nTheirs\n');
    expect(writer.hasPendingBody('A.md')).toBe(true);
  });

  it('with a conflict, a queued frontmatter change still lands on their body', async () => {
    loadBase('A.md');
    vault.writeExternally('A.md', '---\ntitle: A # keep\n---\nTheirs\n');
    writer.queueBody('A.md', 'Mine', 1);
    writer.queueDelta('A.md', { set: { done: true }, unset: [] });
    await writer.flush('A.md');
    expect(vault.read('A.md')).toBe('---\ntitle: A # keep\ndone: true\n---\nTheirs\n');
    expect(writer.hasPendingBody('A.md')).toBe(true);
  });

  it('once the base moves to the disk version (Keep mine), the body is written', async () => {
    loadBase('A.md');
    vault.writeExternally('A.md', '---\ntitle: A # keep\n---\nTheirs\n');
    writer.queueBody('A.md', 'Mine', 1);
    await writer.flush('A.md');
    loadBase('A.md');
    expect((await writer.flush('A.md')).ok).toBe(true);
    expect(vault.read('A.md')).toBe('---\ntitle: A # keep\n---\nMine\n');
  });

  it('a file changed between the read and the write is read again, not overwritten', async () => {
    loadBase('A.md');
    let changed = false;
    vault.afterRead = (rel) => {
      if (rel === 'A.md' && !changed) {
        changed = true;
        // The read already happened; bump the file so the pre-write check sees it.
        queueMicrotask(() => vault.writeExternally('A.md', '---\ntitle: A # keep\nextra: 1\n---\nOne\n'));
      }
    };
    writer.queueDelta('A.md', { set: { mine: 1 }, unset: [] });
    await writer.flush('A.md');
    expect(vault.read('A.md')).toBe('---\ntitle: A # keep\nextra: 1\nmine: 1\n---\nOne\n');
  });

  it('recognises its own write by hash, and not somebody else\'s', async () => {
    writer.queueDelta('B.md', { set: { x: 1 }, unset: [] });
    await writer.flush('B.md');
    const bytes = vault.read('B.md') ?? '';
    expect(writer.isOwnWrite('B.md', noteTextHash(bytes))).toBe(true);
    expect(writer.isOwnWrite('b.md', noteTextHash(bytes))).toBe(true);
    expect(writer.isOwnWrite('B.md', noteTextHash(`${bytes}x`))).toBe(false);
  });
});

describe('refusals', () => {
  it('a lossy note\'s body is held (and reported), its frontmatter still lands', async () => {
    loadBase('A.md');
    bodyBlocked.add(vaultPath('A.md'));
    writer.queueBody('A.md', 'Would lose formatting', 1);
    writer.queueDelta('A.md', { set: { k: 'v' }, unset: [] });
    expect((await writer.flush('A.md')).ok).toBe(false);
    expect(vault.read('A.md')).toBe('---\ntitle: A # keep\nk: v\n---\nOne\n');
  });

  it('never writes a note whose bytes are not UTF-8', async () => {
    vault.nonUtf8.add('a.md');
    writer.queueDelta('A.md', { set: { k: 'v' }, unset: [] });
    expect((await writer.flush('A.md')).ok).toBe(false);
    expect(mdWrites()).toHaveLength(0);
  });

  it('never recreates a note deleted before its write', async () => {
    vault.remove('B.md');
    writer.queueDelta('B.md', { set: { k: 'v' }, unset: [] });
    expect((await writer.flush('B.md')).ok).toBe(false);
    expect(vault.read('B.md')).toBeUndefined();
  });

  it('a vault swap during a flush drops the write', async () => {
    vault.afterRead = () => beginVaultGeneration('/other');
    writer.queueDelta('A.md', { set: { k: 'v' }, unset: [] });
    await writer.flush('A.md');
    expect(mdWrites()).toHaveLength(0);
  });
});

describe('creating notes', () => {
  it('creates exclusively and bumps to " (n)" when a name is taken', async () => {
    const one = await writer.createUnique('A.md', (stem) => `---\ntitle: ${stem}\n---\n`);
    expect(one.relPath).toBe('A (2).md');
    expect(vault.read('A.md')).toBe('---\ntitle: A # keep\n---\nOne\n');
    const two = await writer.createUnique('A.md', () => 'x');
    expect(two.relPath).toBe('A (3).md');
    expect(await writer.createExclusive('B.md', 'nope')).toBe('exists');
    expect(vault.read('B.md')).toBe('---\ntitle: B\n---\nTwo\n');
  });
});

describe('transform, restore and hold', () => {
  it('transform writes queued changes first, then rewrites from the fresh bytes', async () => {
    writer.queueDelta('A.md', { set: { k: 1 }, unset: [] });
    const out = await writer.transform('A.md', (fresh) => fresh.raw.replace('One', 'Uno'));
    expect(out).toBe('---\ntitle: A # keep\nk: 1\n---\nUno\n');
    expect(vault.read('A.md')).toBe(out);
  });

  it('restore writes a deleted note back', async () => {
    vault.remove('B.md');
    await writer.restore('Sub/B.md', 'back\n');
    expect(vault.read('Sub/B.md')).toBe('back\n');
  });

  it('hold lands queued writes first and keeps new ones waiting until the rename is done', async () => {
    writer.queueDelta('A.md', { set: { before: 1 }, unset: [] });
    const order: string[] = [];
    await writer.hold(['A.md'], async () => {
      order.push('rename:start');
      expect(vault.read('A.md')).toContain('before: 1');
      writer.queueDelta('A.md', { set: { during: 1 }, unset: [] });
      const late = writer.flush('A.md').then(() => order.push('late-write'));
      await new Promise((r) => setTimeout(r, 30));
      order.push('rename:end');
      void late;
    });
    await writer.flush('A.md');
    expect(order.slice(0, 2)).toEqual(['rename:start', 'rename:end']);
  });

  it('renamePath moves a queued change to the new name', async () => {
    writer.queueDelta('A.md', { set: { k: 1 }, unset: [] });
    vault.writeExternally('Moved.md', vault.read('A.md') ?? '');
    vault.remove('A.md');
    writer.renamePath('A.md', 'Moved.md');
    await writer.flushAll();
    expect(vault.read('Moved.md')).toContain('k: 1');
  });
});

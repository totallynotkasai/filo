/**
 * noteWriter — writes that meet another writer (a sync client, an editor).
 *
 * - Each write names the stat its fresh read saw; the main process refuses it
 *   (STALE) if the file changed since, and the flush starts over from a new
 *   read. A body that keeps meeting a newer version is held for the user.
 * - A read that looks cut short (a truncate-then-write caught part way) is
 *   read again before a change is built on it; one that stays that way is
 *   taken as the file.
 * - A frontmatter change merged in while another was being written doesn't
 *   re-apply the keys that already landed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { vaultPath, type VaultPath } from '@shared/vaultPath';
import { createNoteWriter, looksCutShort, type NoteWriterHost, type NoteWriter } from '../../renderer/lib/notes/noteWriter';
import { readNoteText, snapshotOf, type DiskSnapshot } from '../../renderer/lib/notes/noteFile';
import { beginVaultGeneration, __resetVaultIdentityForTests } from '../../renderer/lib/vault/vaultIdentity';
import { __resetDirtyTrackingForTests } from '../../renderer/lib/boards/writeStateTracking';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

let vault: MemoryVault;
let writer: NoteWriter;
let bases: Map<VaultPath, DiskSnapshot>;
let conflicts: string[];

function makeWriter(): NoteWriter {
  const host: NoteWriterHost = {
    vaultRoot: () => vault.root,
    baseOf: (p) => bases.get(p),
    hadFrontmatter: (p) => {
      const b = bases.get(p);
      return b ? readNoteText(b.rawText).hasFrontmatter : false;
    },
    canWriteBody: () => true,
    onBodyConflict: (_p, rel) => conflicts.push(rel),
    onTargetMissing: () => undefined,
    onWritten: (p, _rel, _text, snapshot) => {
      bases.set(p, snapshot);
    },
  };
  return createNoteWriter(host);
}

function loadBase(rel: string): void {
  bases.set(vaultPath(rel), snapshotOf(readNoteText(vault.read(rel) ?? '')));
}

const mdWrites = (): string[] => vault.writes.filter(([, rel]) => rel.endsWith('.md')).map(([, , t]) => t);

/** Reads of `rel` while it holds `partial` report a modification time of "just now", as a save in progress would. */
function readsLookRecent(rel: string, partial: string): void {
  const invoke = window.filo.invoke as (c: string, ...a: unknown[]) => Promise<unknown>;
  window.filo.invoke = (async (channel: string, ...args: unknown[]) => {
    const result = await invoke(channel, ...args);
    const content = (result as { content?: string } | null)?.content;
    if (channel === 'vault:read-file-text' && args[1] === rel && content === partial) {
      return { ...(result as object), mtimeMs: Date.now() };
    }
    return result;
  }) as typeof window.filo.invoke;
}

beforeEach(() => {
  __resetDirtyTrackingForTests();
  __resetVaultIdentityForTests();
  beginVaultGeneration('/vault');
  vault = installMemoryVault({ 'A.md': '---\ntitle: A\n---\nOne\n' });
  bases = new Map();
  conflicts = [];
  writer = makeWriter();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  writer.reset();
  restoreFiloDefault();
  vi.restoreAllMocks();
});

describe('a write over a file that changed after the read (STALE)', () => {
  it('every note write names the stat of the read it builds on', async () => {
    writer.queueDelta('A.md', { set: { status: 'open' }, unset: [] });
    await writer.flush('A.md');
    const invoke = window.filo.invoke as unknown as { mock: { calls: unknown[][] } };
    const sends = invoke.mock.calls.filter((c) => c[0] === 'vault:write-existing-file-text');
    expect(sends).toHaveLength(1);
    expect(sends[0][4]).toEqual({ mtimeMs: expect.any(Number), size: expect.any(Number), hash: expect.stringMatching(/^[0-9a-f]{8}$/) });
  });

  it('is read again and the change applied to the new version', async () => {
    vault.beforeWrite = (rel) => {
      if (rel !== 'A.md') return;
      vault.beforeWrite = null;
      vault.writeExternally('A.md', '---\ntitle: A\nsynced: yes\n---\nOne, synced\n');
    };
    writer.queueDelta('A.md', { set: { status: 'open' }, unset: [] });
    expect((await writer.flush('A.md')).ok).toBe(true);
    expect(vault.read('A.md')).toBe('---\ntitle: A\nsynced: yes\nstatus: open\n---\nOne, synced\n');
    expect(mdWrites()).toHaveLength(1);
  });

  it('a body built on the old version becomes a conflict on the re-read, and nothing is overwritten', async () => {
    loadBase('A.md');
    vault.beforeWrite = (rel) => {
      if (rel !== 'A.md') return;
      vault.beforeWrite = null;
      vault.writeExternally('A.md', '---\ntitle: A\n---\nTheirs\n');
    };
    writer.queueBody('A.md', 'Mine', 1);
    expect((await writer.flush('A.md')).ok).toBe(false);
    expect(conflicts).toEqual(['A.md']);
    expect(vault.read('A.md')).toBe('---\ntitle: A\n---\nTheirs\n');
  });

  it('a file that changes before every write is never overwritten; a body is held for the user', async () => {
    loadBase('A.md');
    let n = 0;
    vault.beforeWrite = (rel) => {
      if (rel !== 'A.md') return;
      n++;
      // A frontmatter-only change each time: the body alone never conflicts.
      vault.writeExternally('A.md', `---\ntitle: A\nrev: ${n}\n---\nOne\n`);
    };
    writer.queueBody('A.md', 'Mine', 1);
    expect((await writer.flush('A.md')).ok).toBe(false);
    expect(mdWrites()).toEqual([]);
    expect(conflicts).toEqual(['A.md']);
    expect(writer.hasPendingBody('A.md')).toBe(true);
  });

  it('a read without a coherent stat is never written over', async () => {
    const invoke = window.filo.invoke as (c: string, ...a: unknown[]) => Promise<unknown>;
    window.filo.invoke = (async (channel: string, ...args: unknown[]) => {
      const result = await invoke(channel, ...args);
      if (channel === 'vault:read-file-text' && result && typeof result === 'object') {
        return { ...(result as object), mtimeMs: undefined, size: undefined };
      }
      return result;
    }) as typeof window.filo.invoke;
    writer.queueDelta('A.md', { set: { status: 'open' }, unset: [] });
    expect((await writer.flush('A.md')).ok).toBe(false);
    expect(mdWrites()).toEqual([]);
    expect(writer.isQueued('A.md')).toBe(true);
  });

  it('a rewrite is run again on the version that replaced its read', async () => {
    vault.beforeWrite = (rel) => {
      if (rel !== 'A.md') return;
      vault.beforeWrite = null;
      vault.writeExternally('A.md', '---\ntitle: A\n---\nOne and more\n');
    };
    const out = await writer.transform('A.md', (fresh) => fresh.raw.replace('One', 'Uno'));
    expect(out).toBe('---\ntitle: A\n---\nUno and more\n');
    expect(vault.read('A.md')).toBe('---\ntitle: A\n---\nUno and more\n');
  });
});

describe('a read that looks cut short', () => {
  it('an empty read of a note that had text is read again before a frontmatter change lands', async () => {
    loadBase('A.md');
    const full = vault.read('A.md')!;
    vault.writeExternally('A.md', '');
    let reads = 0;
    vault.afterRead = () => {
      reads++;
      // The other program finishes its save after the first read.
      if (reads === 1) setTimeout(() => vault.writeExternally('A.md', full.replace('One', 'One, saved')), 0);
    };
    writer.queueDelta('A.md', { set: { status: 'open' }, unset: [] });
    expect((await writer.flush('A.md')).ok).toBe(true);
    expect(vault.read('A.md')).toBe('---\ntitle: A\nstatus: open\n---\nOne, saved\n');
    expect(reads).toBeGreaterThan(1);
  });

  it('a recent read under half the known size is read again', async () => {
    vault.writeExternally('A.md', `---\ntitle: A\n---\n${'long line of text\n'.repeat(20)}`);
    loadBase('A.md');
    const full = vault.read('A.md')!;
    const partial = '---\ntitle: A\n---\nlong line';
    vault.writeExternally('A.md', partial);
    readsLookRecent('A.md', partial);
    let reads = 0;
    vault.afterRead = () => {
      reads++;
      if (reads === 1) setTimeout(() => vault.writeExternally('A.md', full), 0);
    };
    writer.queueDelta('A.md', { set: { status: 'open' }, unset: [] });
    expect((await writer.flush('A.md')).ok).toBe(true);
    expect(vault.read('A.md')).toBe(full.replace('title: A\n', 'title: A\nstatus: open\n'));
  });

  it('a file the user really emptied is taken as empty once the re-reads agree', async () => {
    loadBase('A.md');
    vault.writeExternally('A.md', '');
    writer.queueDelta('A.md', { set: { status: 'open' }, unset: [] });
    expect((await writer.flush('A.md')).ok).toBe(true);
    expect(vault.read('A.md')).toBe('---\nstatus: open\n---\n');
  });

  it('looksCutShort: empty after text, or recent and under half the size', () => {
    const read = (size: number, mtimeMs: number) => ({ text: readNoteText(''), size, mtimeMs, nonUtf8: false });
    const now = 1_000_000;
    expect(looksCutShort(read(0, 1), { size: 40, bodyEmpty: false }, now)).toBe(true);
    expect(looksCutShort(read(0, 1), { size: 0, bodyEmpty: true }, now)).toBe(false);
    expect(looksCutShort(read(10, now - 500), { size: 40, bodyEmpty: false }, now)).toBe(true);
    expect(looksCutShort(read(10, now - 5000), { size: 40, bodyEmpty: false }, now)).toBe(false);
    expect(looksCutShort(read(30, now - 500), { size: 40, bodyEmpty: false }, now)).toBe(false);
    expect(looksCutShort(read(10, now), undefined, now)).toBe(false);
  });
});

describe('a frontmatter change merged in while another is being written', () => {
  it('keys that already landed are not applied again over a newer value', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    vault.beforeWrite = async (rel) => {
      if (rel !== 'A.md') return;
      vault.beforeWrite = null;
      await held;
    };
    writer.queueDelta('A.md', { set: { status: 'open' }, unset: [] });
    const first = writer.flush('A.md');
    await new Promise((r) => setTimeout(r, 20));
    writer.queueDelta('A.md', { set: { priority: 'high' }, unset: [] });
    release();
    await first;
    expect(vault.read('A.md')).toBe('---\ntitle: A\nstatus: open\n---\nOne\n');

    // Another program changes the key that already landed.
    vault.writeExternally('A.md', '---\ntitle: A\nstatus: done\n---\nOne\n');
    expect(writer.pendingDelta('A.md')).toEqual({ set: { priority: 'high' }, unset: [] });
    expect((await writer.flush('A.md')).ok).toBe(true);
    expect(vault.read('A.md')).toBe('---\ntitle: A\nstatus: done\npriority: high\n---\nOne\n');
  });

  it('a key set again to a new value while the first was written still lands', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    vault.beforeWrite = async (rel) => {
      if (rel !== 'A.md') return;
      vault.beforeWrite = null;
      await held;
    };
    writer.queueDelta('A.md', { set: { status: 'open' }, unset: [] });
    const first = writer.flush('A.md');
    await new Promise((r) => setTimeout(r, 20));
    writer.queueDelta('A.md', { set: { status: 'closed' }, unset: [] });
    release();
    await first;
    expect((await writer.flush('A.md')).ok).toBe(true);
    expect(vault.read('A.md')).toBe('---\ntitle: A\nstatus: closed\n---\nOne\n');
  });
});

/**
 * A read that catches another program's write half way (an opening fence,
 * no closing one) of a note known to have frontmatter is never written over
 * or taken as the note — even when no view has loaded the note, so the only
 * record that it has frontmatter is the vault index.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { noteStore } from '@renderer/stores/notes.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { __resetDirtyTrackingForTests, isPathPending } from '@renderer/lib/boards/writeStateTracking';
import { parseMarkdown } from '@renderer/lib/vault/vaultIndex';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

let vault: MemoryVault;
const noteWrites = (rel: string): number => vault.writes.filter(([, r]) => r === rel).length;

beforeEach(() => {
  __resetDirtyTrackingForTests();
  vaultStore.setPath('/vault');
  noteStore.__resetForTests();
  vaultIndexStore.clear();
});

afterEach(() => {
  vi.useRealTimers();
  noteStore.__resetForTests();
  restoreFiloDefault();
});

describe('torn reads of a note no view has loaded', () => {
  it('a frontmatter change is not written over a truncated read', async () => {
    const rel = 'Big.md';
    vaultIndexStore.restoreMetadata(rel, parseMarkdown(rel, '---\ntitle: real\nstatus: open\n---\nbody\n'));
    vault = installMemoryVault({ [rel]: '---\ntitle: real\nstatus: o' });
    noteStore.patchFrontmatter(rel, { set: { status: 'closed' }, unset: [] });
    expect(await noteStore.flush(rel)).toBe(false);
    expect(noteWrites(rel)).toBe(0);
    expect(isPathPending(rel)).toBe(true);
  });

  it('a first read that stays torn holds the note unreadable, and nothing is written', async () => {
    vi.useFakeTimers();
    const rel = 'TornSeed.md';
    vaultIndexStore.restoreMetadata(rel, parseMarkdown(rel, '---\ntitle: real\nstatus: open\n---\nold body\n'));
    vault = installMemoryVault({ [rel]: '---\ntitle: rea' });
    const m = noteStore.acquire(rel, 'v');
    await vi.advanceTimersByTimeAsync(6000);
    await m.loaded;
    expect(m.status).toBe('unreadable');
    noteStore.setBody(rel, 'new body', 'v');
    vi.useRealTimers();
    await noteStore.flushAll();
    expect(noteWrites(rel)).toBe(0);
    expect(vault.read(rel)).toBe('---\ntitle: rea');
  });

  it('a first read caught mid-write is read again and the whole note is taken', async () => {
    vi.useFakeTimers();
    const rel = 'Settles.md';
    vaultIndexStore.restoreMetadata(rel, parseMarkdown(rel, '---\ntitle: real\n---\nbody\n'));
    vault = installMemoryVault({ [rel]: '---\ntitle: re' });
    const m = noteStore.acquire(rel, 'v');
    await vi.advanceTimersByTimeAsync(100);
    vault.writeExternally(rel, '---\ntitle: real\n---\nbody\n');
    await vi.advanceTimersByTimeAsync(6000);
    await m.loaded;
    expect(m.status).toBe('ready');
    expect(m.frontmatter).toEqual({ title: 'real' });
    expect(m.body).toBe('body\n');
  });
});

/**
 * Rewrites of a note's file from its bytes (Replace All, tag sweeps, the raw
 * view) go through `noteStore.transform`, and every open
 * view of that note follows the written bytes. The contract:
 *  - an open view shows the new body and frontmatter, with nothing unsaved;
 *  - a view's unsaved typing is written first, so the rewrite starts from it
 *    instead of reverting it, and nothing stays queued to revert the rewrite;
 *  - a failed write changes no view (no convergence on bytes that never
 *    landed);
 *  - only the rewritten note's views change; a path with no open view is fine.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { noteStore } from '@renderer/stores/notes.svelte';
import { setActiveVaultPath } from '@renderer/lib/vault/activeVaultPath';
import { beginVaultGeneration, __resetVaultIdentityForTests } from '@renderer/lib/vault/vaultIdentity';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

let vault: MemoryVault;

beforeEach(() => {
  __resetDirtyTrackingForTests();
  __resetVaultIdentityForTests();
  beginVaultGeneration('/vault');
  setActiveVaultPath('/vault');
  vault = installMemoryVault({
    'Notes.md': '---\ntitle: Notes\n---\nold body\n',
    'Other.md': '---\ntitle: Other\n---\nother body\n',
  });
  noteStore.__resetForTests();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  noteStore.__resetForTests();
  setActiveVaultPath('');
  restoreFiloDefault();
  vi.restoreAllMocks();
});

async function open(rel: string, view = 'tile') {
  const m = noteStore.acquire(rel, view);
  await m.loaded;
  return m;
}

describe('views follow a rewrite of their note', () => {
  it('an open view shows the rewritten body and frontmatter', async () => {
    const m = await open('Notes.md');
    const out = await noteStore.transform('Notes.md', () => '---\ntitle: Renamed\n---\nnew body\n');
    expect(out).toBe('---\ntitle: Renamed\n---\nnew body\n');
    expect(vault.read('Notes.md')).toBe(out);
    expect(m.body).toBe('new body\n');
    expect(m.bodySource).toBe('disk');
    expect(m.frontmatter).toEqual({ title: 'Renamed' });
    expect(m.hasUnsavedBody).toBe(false);
  });

  it('writes a view\'s unsaved typing first, so the rewrite never reverts it', async () => {
    const m = await open('Notes.md');
    noteStore.setBody('Notes.md', 'typed body', 'tile');
    await noteStore.transform('Notes.md', (fresh) => fresh.raw.replace('typed', 'TYPED'));
    expect(vault.read('Notes.md')).toBe('---\ntitle: Notes\n---\nTYPED body\n');
    expect(m.body).toBe('TYPED body\n');
    expect(m.hasUnsavedBody).toBe(false);
    expect(noteStore.hasPendingWrites('Notes.md')).toBe(false);
    await noteStore.flushAll();
    expect(vault.read('Notes.md')).toBe('---\ntitle: Notes\n---\nTYPED body\n');
  });

  it('a frontmatter-only rewrite keeps the view\'s body as it is', async () => {
    const m = await open('Notes.md');
    const revision = m.bodyRevision;
    await noteStore.transform('Notes.md', (fresh) => fresh.raw.replace('title: Notes', 'title: Notes\ntags: [x]'));
    expect(m.frontmatter).toEqual({ title: 'Notes', tags: ['x'] });
    expect(m.body).toBe('old body\n');
    expect(m.bodyRevision).toBe(revision);
  });

  it('a failed write changes no view', async () => {
    const m = await open('Notes.md');
    vault.failNextWrite('Notes.md', 'EACCES');
    await expect(noteStore.transform('Notes.md', () => '---\ntitle: X\n---\nnever landed\n')).rejects.toBeDefined();
    expect(vault.read('Notes.md')).toBe('---\ntitle: Notes\n---\nold body\n');
    expect(m.body).toBe('old body\n');
    expect(m.frontmatter).toEqual({ title: 'Notes' });
  });

  it('only the rewritten note\'s views change', async () => {
    const other = await open('Other.md', 'other-tile');
    await open('Notes.md');
    await noteStore.transform('Notes.md', () => '---\ntitle: Notes\n---\nnew body\n');
    expect(other.body).toBe('other body\n');
    expect(other.frontmatter).toEqual({ title: 'Other' });
  });

  it('a note with no open view is rewritten without a model appearing', async () => {
    await noteStore.transform('Other.md', (fresh) => fresh.raw.replace('other', 'another'));
    expect(vault.read('Other.md')).toBe('---\ntitle: Other\n---\nanother body\n');
    expect(noteStore.get('Other.md')).toBeUndefined();
  });

  it('a rewrite that returns null writes nothing', async () => {
    const m = await open('Notes.md');
    expect(await noteStore.transform('Notes.md', () => null)).toBeNull();
    expect(vault.writes.filter(([, rel]) => rel === 'Notes.md')).toEqual([]);
    expect(m.body).toBe('old body\n');
  });
});

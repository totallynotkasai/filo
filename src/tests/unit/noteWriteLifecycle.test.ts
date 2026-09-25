/**
 * The note write path around its edges:
 *  - flushing one note writes that note only;
 *  - a write queued in the outgoing vault never fires after a vault swap;
 *  - the vault index is refreshed from the bytes just written;
 *  - "Keep mine" re-checks the disk: a file that changes again while the
 *    decision runs is a new conflict, never overwritten;
 *  - the last view closing writes what it left right away, but not after the
 *    vault it belonged to was swapped out.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { noteStore, setNotePromptHandlers } from '@renderer/stores/notes.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { setActiveVaultPath } from '@renderer/lib/vault/activeVaultPath';
import { beginVaultGeneration, __resetVaultIdentityForTests } from '@renderer/lib/vault/vaultIdentity';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { fireVaultSwap } from '@renderer/core/vaultLifecycle';
import { NOTE_WRITE_DEBOUNCE_MS } from '@renderer/lib/notes/noteWriter';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

let vault: MemoryVault;
const prompts = { conflict: vi.fn(), deletedWithUnsavedBody: vi.fn(), reloadShrank: vi.fn(), dismiss: vi.fn() };

const mdWrites = (): Array<[string, string, string]> => vault.writes.filter(([, rel]) => rel.endsWith('.md'));

async function swapVault(): Promise<void> {
  await fireVaultSwap({ phase: 'pre-swap', previousVault: '/vault', nextVault: '/other', saveOutgoing: true });
  beginVaultGeneration('/other');
  setActiveVaultPath('/other');
}

beforeEach(() => {
  __resetDirtyTrackingForTests();
  __resetVaultIdentityForTests();
  beginVaultGeneration('/vault');
  setActiveVaultPath('/vault');
  vault = installMemoryVault({
    'a.md': '---\ntitle: A\n---\nA body\n',
    'b.md': '---\ntitle: B\n---\nB body\n',
  });
  vaultIndexStore.clear();
  noteStore.__resetForTests();
  for (const fn of Object.values(prompts)) fn.mockReset();
  setNotePromptHandlers(prompts);
});

afterEach(() => {
  vi.useRealTimers();
  noteStore.__resetForTests();
  setActiveVaultPath('');
  restoreFiloDefault();
});

describe('note write lifecycle', () => {
  it('flushing one note writes that note only', async () => {
    noteStore.patchFrontmatter('a.md', { set: { k: 1 }, unset: [] });
    noteStore.patchFrontmatter('b.md', { set: { k: 2 }, unset: [] });
    expect(await noteStore.flush('a.md')).toBe(true);
    expect(vault.read('a.md')).toContain('k: 1');
    expect(vault.read('b.md')).not.toContain('k: 2');
    expect(noteStore.hasPendingWrites('b.md')).toBe(true);
  });

  it('a write queued in the outgoing vault never fires after the swap', async () => {
    const m = noteStore.acquire('a.md', 'tile');
    await m.loaded;
    noteStore.setBody('a.md', 'typed in the old vault', 'tile');
    noteStore.patchFrontmatter('b.md', { set: { k: 1 }, unset: [] });
    await swapVault();
    await new Promise((r) => setTimeout(r, NOTE_WRITE_DEBOUNCE_MS + 100));
    await noteStore.flushAll();
    expect(mdWrites()).toEqual([]);
  });

  it('refreshes the vault index from the bytes just written', async () => {
    noteStore.patchFrontmatter('a.md', { set: { status: 'done' }, unset: [] });
    await noteStore.flushAll();
    expect(vaultIndexStore.getMetadata('a.md')?.frontmatter.status).toBe('done');
  });

  it('Keep mine meets a second change on disk as a new conflict, not an overwrite', async () => {
    const m = noteStore.acquire('a.md', 'tile');
    await m.loaded;
    noteStore.setBody('a.md', 'Mine', 'tile');
    vault.writeExternally('a.md', '---\ntitle: A\n---\nTheirs 1\n');
    await noteStore.flush('a.md');
    expect(prompts.conflict).toHaveBeenCalledTimes(1);

    // The other program writes again after Keep mine read the disk.
    let reads = 0;
    vault.afterRead = (rel) => {
      if (rel === 'a.md' && ++reads === 2) vault.writeExternally('a.md', '---\ntitle: A\n---\nTheirs 2\n');
    };
    await noteStore.resolveConflict('a.md', 'keep-mine');

    expect(vault.read('a.md')).toBe('---\ntitle: A\n---\nTheirs 2\n');
    expect(prompts.conflict).toHaveBeenCalledTimes(2);
    expect(m.status).toBe('conflict');
    expect(m.body).toBe('Mine');
  });

  it('Keep mine writes once when the disk holds still', async () => {
    const m = noteStore.acquire('a.md', 'tile');
    await m.loaded;
    noteStore.setBody('a.md', 'Mine', 'tile');
    vault.writeExternally('a.md', '---\ntitle: A\n---\nTheirs\n');
    await noteStore.flush('a.md');
    const before = mdWrites().length;
    await noteStore.resolveConflict('a.md', 'keep-mine');
    expect(mdWrites().length - before).toBe(1);
    expect(vault.read('a.md')).toBe('---\ntitle: A\n---\nMine\n');
  });

  it('the last view closing writes its unsaved body right away', async () => {
    const m = noteStore.acquire('a.md', 'tile');
    await m.loaded;
    noteStore.setBody('a.md', 'closed with this', 'tile');
    noteStore.release('a.md', 'tile');
    // Well inside the debounce: the close wrote it, not the timer.
    await new Promise((r) => setTimeout(r, 30));
    expect(vault.read('a.md')).toBe('---\ntitle: A\n---\nclosed with this\n');
  });

  it('a view closing after its vault was swapped out writes nothing', async () => {
    const m = noteStore.acquire('a.md', 'tile');
    await m.loaded;
    noteStore.setBody('a.md', 'from the old vault', 'tile');
    await swapVault();
    noteStore.release('a.md', 'tile');
    await new Promise((r) => setTimeout(r, NOTE_WRITE_DEBOUNCE_MS + 100));
    expect(mdWrites()).toEqual([]);
  });
});

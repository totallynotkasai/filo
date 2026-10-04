/**
 * After a write, the note's base (what the next drift check compares) is the
 * bytes we wrote, never a later look at the disk. Another program's write that
 * lands right after ours, even one of exactly the same byte count, is
 * therefore not mistaken for ours: a clean note follows it, and an unsaved
 * edit meets it as a conflict instead of silently overwriting it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { noteStore, setNotePromptHandlers } from '@renderer/stores/notes.svelte';
import { setActiveVaultPath } from '@renderer/lib/vault/activeVaultPath';
import { beginVaultGeneration, __resetVaultIdentityForTests } from '@renderer/lib/vault/vaultIdentity';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { noteTextHash } from '@renderer/lib/notes/noteFile';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

let vault: MemoryVault;
const prompts = { conflict: vi.fn(), deletedWithUnsavedBody: vi.fn(), writeTargetMissing: vi.fn(), reloadShrank: vi.fn(), reloadedOverTyping: vi.fn(), confirmReloadWithoutCopy: vi.fn(async () => false), dismiss: vi.fn() };

beforeEach(() => {
  __resetDirtyTrackingForTests();
  __resetVaultIdentityForTests();
  beginVaultGeneration('/vault');
  setActiveVaultPath('/vault');
  vault = installMemoryVault({ 'Notes/L5.md': '---\ntitle: T\n---\norig\n' });
  noteStore.__resetForTests();
  for (const fn of Object.values(prompts)) fn.mockReset();
  setNotePromptHandlers(prompts);
});

afterEach(() => {
  noteStore.__resetForTests();
  setActiveVaultPath('');
  restoreFiloDefault();
});

async function writeOurs(): Promise<string> {
  const m = noteStore.acquire('Notes/L5.md', 'tile');
  await m.loaded;
  noteStore.setBody('Notes/L5.md', 'edited body', 'tile');
  await noteStore.flush('Notes/L5.md');
  return vault.read('Notes/L5.md') ?? '';
}

/** Different bytes of exactly the same UTF-8 length. */
function sameSizeForeign(ours: string): string {
  return ours.replace('edited body', 'edited BODY');
}

describe('the base after our write', () => {
  it('is the bytes we wrote', async () => {
    const ours = await writeOurs();
    expect(ours).toBe('---\ntitle: T\n---\nedited body\n');
    expect(noteStore.get('Notes/L5.md')?.base?.hash).toBe(noteTextHash(ours));
  });

  it('a same-size foreign write landing right after ours is taken as theirs by a clean note', async () => {
    const ours = await writeOurs();
    const theirs = sameSizeForeign(ours);
    expect(theirs.length).toBe(ours.length);
    vault.writeExternally('Notes/L5.md', theirs);

    await noteStore.onDiskChanged('Notes/L5.md');
    const m = noteStore.get('Notes/L5.md');
    expect(m?.body).toBe('edited BODY\n');
    expect(m?.base?.hash).toBe(noteTextHash(theirs));
  });

  it('the next edit meets that foreign write as a conflict, never overwriting it', async () => {
    const ours = await writeOurs();
    const theirs = sameSizeForeign(ours);
    vault.writeExternally('Notes/L5.md', theirs);

    noteStore.setBody('Notes/L5.md', 'second edit', 'tile');
    expect(await noteStore.flush('Notes/L5.md')).toBe(false);
    expect(prompts.conflict).toHaveBeenCalledOnce();
    expect(vault.read('Notes/L5.md')).toBe(theirs);
  });
});

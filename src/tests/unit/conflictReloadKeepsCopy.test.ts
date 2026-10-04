/**
 * Answering a note conflict with Reload throws the typed body away, so a copy
 * of the note as typed goes to `.filo/recovery/<ts>-keep/` first, the prompt
 * offers to undo the reload, and with no copy the user is asked before the
 * text goes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { noteStore, setNotePromptHandlers, type NoteModel } from '../../renderer/stores/notes.svelte';
import { vaultIndexStore } from '../../renderer/stores/vaultIndex.svelte';
import { setActiveVaultPath } from '../../renderer/lib/vault/activeVaultPath';
import { beginVaultGeneration, __resetVaultIdentityForTests } from '../../renderer/lib/vault/vaultIdentity';
import { __resetDirtyTrackingForTests } from '../../renderer/lib/boards/writeStateTracking';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

const NOTE = '---\ntitle: Chapter\n---\nOpening line.\n';
const THEIRS = '---\ntitle: Chapter\n---\nOpening line, edited on the phone.\n';

let vault: MemoryVault;
const prompts = {
  conflict: vi.fn(),
  deletedWithUnsavedBody: vi.fn(),
  writeTargetMissing: vi.fn(),
  reloadShrank: vi.fn(),
  reloadedOverTyping: vi.fn(),
  confirmReloadWithoutCopy: vi.fn(async () => false),
  dismiss: vi.fn(),
};

beforeEach(() => {
  __resetDirtyTrackingForTests();
  __resetVaultIdentityForTests();
  beginVaultGeneration('/vault');
  setActiveVaultPath('/vault');
  vault = installMemoryVault({ 'Chapter.md': NOTE });
  vaultIndexStore.clear();
  noteStore.__resetForTests();
  for (const fn of Object.values(prompts)) fn.mockReset();
  prompts.confirmReloadWithoutCopy.mockImplementation(async () => false);
  setNotePromptHandlers(prompts);
});

afterEach(() => {
  noteStore.__resetForTests();
  restoreFiloDefault();
});

/** The note open in a view, with typing held in a conflict against the phone's version. */
async function inConflict(): Promise<NoteModel> {
  const m = noteStore.acquire('Chapter.md', 'doc');
  await m.loaded;
  noteStore.setBody('Chapter.md', 'Opening line.\n\nTwo long paragraphs typed on the PC.', 'doc');
  vault.writeExternally('Chapter.md', THEIRS);
  await noteStore.onDiskChanged('Chapter.md');
  expect(m.status).toBe('conflict');
  // The editor stays usable while the prompt waits: this typing is held too.
  noteStore.setBody('Chapter.md', 'Opening line.\n\nTwo long paragraphs typed on the PC.\n\nAnd a third, typed after the prompt appeared.', 'doc');
  return m;
}

describe('a conflict answered with Reload', () => {
  it('keeps a copy of the note as typed, then shows the other version', async () => {
    const m = await inConflict();
    await noteStore.resolveConflict('Chapter.md', 'reload');

    expect(vault.recovered).toHaveLength(1);
    const kept = vault.recovered[0]!;
    expect(kept.dir).toMatch(/-keep$/);
    expect(kept.relPath).toBe('Chapter.md');
    expect(kept.text).toContain('title: Chapter');
    expect(kept.text).toContain('And a third, typed after the prompt appeared.');

    expect(m.body).toBe('Opening line, edited on the phone.\n');
    expect(m.hasUnsavedBody).toBe(false);
    expect(vault.read('Chapter.md')).toBe(THEIRS);
    expect(prompts.reloadedOverTyping).toHaveBeenCalledOnce();
    const [, typedBody, keptIn] = prompts.reloadedOverTyping.mock.calls[0]!;
    expect(typedBody).toContain('And a third');
    expect(keptIn).toBe(`/vault/${kept.dir}`);
    expect(prompts.confirmReloadWithoutCopy).not.toHaveBeenCalled();
  });

  it('Undo reload puts the typed body back, and it is written over the other version', async () => {
    const m = await inConflict();
    await noteStore.resolveConflict('Chapter.md', 'reload');
    const typedBody = prompts.reloadedOverTyping.mock.calls[0]![1] as string;

    expect(await noteStore.restoreBody('Chapter.md', typedBody)).toBe('queued');
    expect(m.body).toBe(typedBody);
    await noteStore.flush('Chapter.md');
    expect(vault.read('Chapter.md')).toContain('And a third, typed after the prompt appeared.');
  });

  it('with no copy possible, asks first; Cancel keeps the conflict and the typing', async () => {
    const m = await inConflict();
    vault.failRecovery = 'ENOSPC';
    await noteStore.resolveConflict('Chapter.md', 'reload');

    expect(prompts.confirmReloadWithoutCopy).toHaveBeenCalledOnce();
    expect(m.status).toBe('conflict');
    expect(m.body).toContain('And a third');
    expect(m.hasUnsavedBody).toBe(true);
    // The question goes back up, to be answered again.
    expect(prompts.conflict).toHaveBeenCalledTimes(2);
    expect(prompts.reloadedOverTyping).not.toHaveBeenCalled();
    expect(vault.read('Chapter.md')).toBe(THEIRS);
  });

  it('with no copy possible, "Reload anyway" shows the other version and says nothing was kept', async () => {
    const m = await inConflict();
    vault.failRecovery = 'ENOSPC';
    prompts.confirmReloadWithoutCopy.mockImplementation(async () => true);
    await noteStore.resolveConflict('Chapter.md', 'reload');

    expect(m.body).toBe('Opening line, edited on the phone.\n');
    expect(prompts.reloadedOverTyping).toHaveBeenCalledOnce();
    expect(prompts.reloadedOverTyping.mock.calls[0]![2]).toBeNull();
  });

  it('Undo reload loads a note no view holds any more', async () => {
    await inConflict();
    await noteStore.resolveConflict('Chapter.md', 'reload');
    const typedBody = prompts.reloadedOverTyping.mock.calls[0]![1] as string;
    noteStore.release('Chapter.md', 'doc');
    await noteStore.flushAll();

    expect(await noteStore.restoreBody('Chapter.md', typedBody)).toBe('queued');
    await noteStore.flushAll();
    expect(vault.read('Chapter.md')).toContain('And a third, typed after the prompt appeared.');
  });
});

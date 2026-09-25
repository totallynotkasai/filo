/**
 * noteStore — one model per note, shared by every view, fed by the note
 * writer and by disk changes (the C.5 table).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { noteStore, setNotePromptHandlers, type NoteModel } from '../../renderer/stores/notes.svelte';
import { vaultIndexStore } from '../../renderer/stores/vaultIndex.svelte';
import { setActiveVaultPath } from '../../renderer/lib/vault/activeVaultPath';
import { beginVaultGeneration, __resetVaultIdentityForTests } from '../../renderer/lib/vault/vaultIdentity';
import { __resetDirtyTrackingForTests } from '../../renderer/lib/boards/writeStateTracking';
import { renameAllPathKeys } from '../../renderer/lib/vault/renamePathKeys';
import { fireVaultSwap } from '../../renderer/core/vaultLifecycle';
import { parseMarkdown } from '../../renderer/lib/vault/vaultIndex';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

let vault: MemoryVault;
const prompts = { conflict: vi.fn(), deletedWithUnsavedBody: vi.fn(), writeTargetMissing: vi.fn(), reloadShrank: vi.fn(), dismiss: vi.fn() };

async function loaded(rel: string, view = 'v1'): Promise<NoteModel> {
  const m = noteStore.acquire(rel, view);
  await m.loaded;
  return m;
}

beforeEach(() => {
  __resetDirtyTrackingForTests();
  __resetVaultIdentityForTests();
  beginVaultGeneration('/vault');
  setActiveVaultPath('/vault');
  vault = installMemoryVault({
    'Note.md': '---\ntitle: Note\n---\nBody\n',
    'Card.md': '---\ntitle: Card\npriority: low\n---\nCard body\n',
  });
  vaultIndexStore.clear();
  noteStore.__resetForTests();
  for (const fn of Object.values(prompts)) fn.mockReset();
  setNotePromptHandlers(prompts);
});

afterEach(() => {
  noteStore.__resetForTests();
  restoreFiloDefault();
});

describe('models', () => {
  it('every view of a note shares one model, in any spelling', async () => {
    const a = await loaded('Note.md', 'tile');
    const b = noteStore.acquire('note.MD', 'doc');
    expect(b).toBe(a);
    expect(a.body).toBe('Body\n');
    expect(a.frontmatter).toEqual({ title: 'Note' });
    expect(a.status).toBe('ready');
  });

  it('a body typed in one view is what every view reads, and it reaches disk', async () => {
    const m = await loaded('Note.md', 'tile');
    noteStore.acquire('Note.md', 'doc');
    noteStore.setBody('Note.md', 'Body typed', 'tile');
    expect(m.body).toBe('Body typed');
    expect(m.editorOwner).toBe('tile');
    expect(m.hasUnsavedBody).toBe(true);
    await noteStore.flush('Note.md');
    expect(vault.read('Note.md')).toBe('---\ntitle: Note\n---\nBody typed\n');
    expect(m.hasUnsavedBody).toBe(false);
  });

  it('ignores a body from a view that does not hold the note', async () => {
    const m = await loaded('Note.md', 'tile');
    noteStore.setBody('Note.md', 'Stray', 'old-vault-view');
    expect(m.body).toBe('Body\n');
  });

  it('a missing file loads as missing; its create fills the model', async () => {
    const m = await loaded('New.md');
    expect(m.status).toBe('missing');
    await noteStore.createExclusive('New.md', '---\ntitle: New\n---\n');
    expect(m.status).toBe('ready');
    expect(m.frontmatter).toEqual({ title: 'New' });
  });

  it('released and idle, the model goes; with a queued body it stays until written', async () => {
    const m = await loaded('Note.md');
    noteStore.setBody('Note.md', 'Edited', 'v1');
    noteStore.release('Note.md', 'v1');
    expect(noteStore.get('Note.md')).toBe(m);
    await noteStore.flush('Note.md');
    await new Promise((r) => setTimeout(r, 5));
    expect(noteStore.get('Note.md')).toBeUndefined();
    expect(vault.read('Note.md')).toContain('Edited');
  });

  it('a rename moves the model, and later edits land on the new file', async () => {
    const m = await loaded('Note.md');
    vault.writeExternally('Moved/Note.md', vault.read('Note.md') ?? '');
    vault.remove('Note.md');
    renameAllPathKeys('Note.md', 'Moved/Note.md');
    expect(noteStore.get('Moved/Note.md')).toBe(m);
    noteStore.setBody('Moved/Note.md', 'After move', 'v1');
    await noteStore.flush('Moved/Note.md');
    expect(vault.read('Moved/Note.md')).toContain('After move');
  });

  it('a vault swap drops every model', async () => {
    await loaded('Note.md');
    await fireVaultSwap({ phase: 'pre-swap', previousVault: '/vault', nextVault: '/other', saveOutgoing: true });
    expect(noteStore.get('Note.md')).toBeUndefined();
  });
});

describe('frontmatter', () => {
  it('a change shows at once on a loaded note and lands on disk', async () => {
    const m = await loaded('Card.md');
    noteStore.patchFrontmatter('Card.md', { set: { priority: 'high' }, unset: [] });
    expect(m.frontmatter.priority).toBe('high');
    await noteStore.flush('Card.md');
    expect(vault.read('Card.md')).toBe('---\ntitle: Card\npriority: high\n---\nCard body\n');
  });

  it('an unloaded note answers from the index, with a queued change laid over it', async () => {
    vaultIndexStore.restoreMetadata('Card.md', parseMarkdown('Card.md', vault.read('Card.md') ?? ''));
    expect(noteStore.frontmatter('Card.md').priority).toBe('low');
    noteStore.patchFrontmatter('Card.md', { set: { priority: 'high' }, unset: [] });
    expect(noteStore.frontmatter('Card.md').priority).toBe('high');
    expect(noteStore.get('Card.md')).toBeUndefined();
    await noteStore.flushAll();
    expect(vaultIndexStore.getMetadata('Card.md')?.frontmatter.priority).toBe('high');
    expect(noteStore.frontmatter('Card.md').priority).toBe('high');
  });
});

describe('disk changes', () => {
  it('our own write coming back changes nothing', async () => {
    const m = await loaded('Note.md');
    noteStore.setBody('Note.md', 'Mine', 'v1');
    await noteStore.flush('Note.md');
    const rev = m.bodyRevision;
    await noteStore.onDiskChanged('Note.md');
    expect(m.bodyRevision).toBe(rev);
    expect(prompts.conflict).not.toHaveBeenCalled();
  });

  it('a clean note follows the disk', async () => {
    const m = await loaded('Note.md');
    vault.writeExternally('Note.md', '---\ntitle: Note\n---\nTheirs\n');
    await noteStore.onDiskChanged('Note.md');
    expect(m.body).toBe('Theirs\n');
    expect(m.bodySource).toBe('disk');
    expect(prompts.conflict).not.toHaveBeenCalled();
  });

  it('a frontmatter-only change while a body edit is unsaved keeps the body and asks nothing', async () => {
    const m = await loaded('Note.md');
    noteStore.setBody('Note.md', 'Typing', 'v1');
    vault.writeExternally('Note.md', '---\ntitle: Note\nstatus: draft\n---\nBody\n');
    await noteStore.onDiskChanged('Note.md');
    expect(m.body).toBe('Typing');
    expect(m.frontmatter.status).toBe('draft');
    expect(prompts.conflict).not.toHaveBeenCalled();
    await noteStore.flush('Note.md');
    expect(vault.read('Note.md')).toBe('---\ntitle: Note\nstatus: draft\n---\nTyping\n');
  });

  it('a body change while a body edit is unsaved asks once; Keep mine writes ours', async () => {
    const m = await loaded('Note.md');
    noteStore.setBody('Note.md', 'Mine', 'v1');
    vault.writeExternally('Note.md', '---\ntitle: Note\n---\nTheirs\n');
    await noteStore.onDiskChanged('Note.md');
    expect(m.status).toBe('conflict');
    expect(prompts.conflict).toHaveBeenCalledOnce();
    await noteStore.resolveConflict('Note.md', 'keep-mine');
    expect(vault.read('Note.md')).toBe('---\ntitle: Note\n---\nMine\n');
    expect(m.status).toBe('ready');
  });

  it('Reload drops the unsaved body and shows theirs', async () => {
    const m = await loaded('Note.md');
    noteStore.setBody('Note.md', 'Mine', 'v1');
    vault.writeExternally('Note.md', '---\ntitle: Note\n---\nTheirs\n');
    await noteStore.onDiskChanged('Note.md');
    await noteStore.resolveConflict('Note.md', 'reload');
    expect(m.body).toBe('Theirs\n');
    expect(m.hasUnsavedBody).toBe(false);
    await noteStore.flushAll();
    expect(vault.read('Note.md')).toBe('---\ntitle: Note\n---\nTheirs\n');
  });

  it('the writer finds the conflict itself when the change arrives before the watcher', async () => {
    const m = await loaded('Note.md');
    noteStore.setBody('Note.md', 'Mine', 'v1');
    vault.writeExternally('Note.md', '---\ntitle: Note\n---\nTheirs\n');
    expect(await noteStore.flush('Note.md')).toBe(false);
    expect(m.status).toBe('conflict');
    expect(prompts.conflict).toHaveBeenCalledOnce();
    expect(vault.read('Note.md')).toBe('---\ntitle: Note\n---\nTheirs\n');
  });

  it('a deleted clean note goes missing; one with an unsaved edit asks', async () => {
    const m = await loaded('Note.md');
    vault.remove('Note.md');
    await noteStore.onDiskChanged('Note.md');
    expect(m.status).toBe('missing');
    expect(prompts.deletedWithUnsavedBody).not.toHaveBeenCalled();

    const c = await loaded('Card.md');
    noteStore.setBody('Card.md', 'Unsaved', 'v1');
    vault.remove('Card.md');
    await noteStore.onDiskChanged('Card.md');
    expect(prompts.deletedWithUnsavedBody).toHaveBeenCalledWith(c);
  });
});

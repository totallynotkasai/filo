/**
 * The raw view's write path: the whole file replaced as typed, only while the
 * file still holds the bytes the view started from, with the file's BOM and
 * line ending kept.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { noteStore, setNotePromptHandlers } from '../../renderer/stores/notes.svelte';
import { vaultIndexStore } from '../../renderer/stores/vaultIndex.svelte';
import { setActiveVaultPath } from '../../renderer/lib/vault/activeVaultPath';
import { beginVaultGeneration, __resetVaultIdentityForTests } from '../../renderer/lib/vault/vaultIdentity';
import { __resetDirtyTrackingForTests } from '../../renderer/lib/boards/writeStateTracking';
import { noteTextHash, rawTextForView, rawTextForDisk } from '../../renderer/lib/notes/noteFile';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

const BOM = String.fromCharCode(0xfeff);
let vault: MemoryVault;

beforeEach(() => {
  __resetDirtyTrackingForTests();
  __resetVaultIdentityForTests();
  beginVaultGeneration('/vault');
  setActiveVaultPath('/vault');
  vault = installMemoryVault({
    'Note.md': '---\ntitle: Note\n---\nBody\n',
    'Win.md': `${BOM}---\r\ntitle: Win\r\n---\r\nOne\r\n`,
  });
  vaultIndexStore.clear();
  noteStore.__resetForTests();
  setNotePromptHandlers({ conflict: vi.fn(), deletedWithUnsavedBody: vi.fn(), writeTargetMissing: vi.fn(), reloadShrank: vi.fn(), reloadedOverTyping: vi.fn(), confirmReloadWithoutCopy: vi.fn(async () => false), dismiss: vi.fn() });
});

afterEach(() => {
  noteStore.__resetForTests();
  restoreFiloDefault();
});

describe('raw text helpers', () => {
  it('shows the file without its BOM and with LF line endings', () => {
    expect(rawTextForView(`${BOM}a\r\nb\r\n`)).toBe('a\nb\n');
  });

  it('puts the file BOM and CRLF back on the typed text', () => {
    expect(rawTextForDisk('a\nb\n', { hadBom: true, eol: '\r\n' })).toBe(`${BOM}a\r\nb\r\n`);
    expect(rawTextForDisk('a\r\nb', { hadBom: false, eol: '\n' })).toBe('a\nb');
  });
});

describe('noteStore.readRaw / writeRaw', () => {
  it('reads the bytes on disk after queued changes land', async () => {
    const m = noteStore.acquire('Note.md', 'v');
    await m.loaded;
    noteStore.patchFrontmatter('Note.md', { set: { status: 'draft' }, unset: [] });
    const raw = await noteStore.readRaw('Note.md');
    expect(raw?.raw).toBe('---\ntitle: Note\nstatus: draft\n---\nBody\n');
    expect(raw?.hash).toBe(noteTextHash(raw!.raw));
    noteStore.release('Note.md', 'v');
  });

  it('replaces the whole file, and an open view follows', async () => {
    const m = noteStore.acquire('Note.md', 'v');
    await m.loaded;
    const { hash } = (await noteStore.readRaw('Note.md'))!;
    const written = '---\ntitle: Renamed\n---\nNew body\n';
    // The hash names the bytes this write left, for the view's next save.
    expect(await noteStore.writeRaw('Note.md', written, hash)).toEqual({ status: 'written', hash: noteTextHash(written) });
    expect(vault.read('Note.md')).toBe('---\ntitle: Renamed\n---\nNew body\n');
    expect(m.body).toBe('New body\n');
    expect(m.frontmatter).toEqual({ title: 'Renamed' });
    noteStore.release('Note.md', 'v');
  });

  it('writes nothing when the file changed since the raw view read it', async () => {
    const { hash } = (await noteStore.readRaw('Note.md'))!;
    vault.writeExternally('Note.md', '---\ntitle: Note\n---\nTheirs\n');
    expect(await noteStore.writeRaw('Note.md', '---\ntitle: Note\n---\nMine\n', hash)).toEqual({ status: 'conflict' });
    expect(vault.read('Note.md')).toBe('---\ntitle: Note\n---\nTheirs\n');
  });

  it('keeps the file BOM and CRLF line endings', async () => {
    const { hash } = (await noteStore.readRaw('Win.md'))!;
    const result = await noteStore.writeRaw('Win.md', '---\ntitle: Win\n---\nTwo\n', hash);
    expect(vault.read('Win.md')).toBe(`${BOM}---\r\ntitle: Win\r\n---\r\nTwo\r\n`);
    expect(result).toEqual({ status: 'written', hash: noteTextHash(vault.read('Win.md') ?? '') });
  });

  it('an unchanged text writes nothing', async () => {
    const { raw, hash } = (await noteStore.readRaw('Note.md'))!;
    const writes = vault.writes.length;
    expect(await noteStore.writeRaw('Note.md', raw, hash)).toEqual({ status: 'unchanged', hash });
    expect(vault.writes.length).toBe(writes);
  });

  // The writer leaves such a note alone without comparing it: that must not
  // read as "unchanged", or the view would take its text as saved.
  it.each([
    ['is no longer UTF-8', (v: MemoryVault) => v.nonUtf8.add('note.md')],
    ['has become a link', (v: MemoryVault) => v.links.add('note.md')],
  ])('a note that %s is skipped, not saved', async (_why, change) => {
    const { hash } = (await noteStore.readRaw('Note.md'))!;
    change(vault);
    const writes = vault.writes.length;
    expect(await noteStore.writeRaw('Note.md', '---\ntitle: Note\n---\nTyped raw\n', hash)).toEqual({ status: 'skipped' });
    expect(vault.writes.length).toBe(writes);
    expect(vault.read('Note.md')).toBe('---\ntitle: Note\n---\nBody\n');
  });
});

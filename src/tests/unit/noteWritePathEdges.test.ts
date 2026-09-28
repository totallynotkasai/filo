/**
 * Edges of the note write path:
 *  - one frontmatter object reader: an open note and the vault index read the
 *    same keys from a block with a recoverable YAML error, and a change to
 *    such a note is refused with the block kept;
 *  - a frontmatter change that removes the last key of a scene-break note
 *    doesn't hand its first section to the next read as frontmatter;
 *  - a body save keeps the frontmatter block's own bytes (an empty block, a
 *    fence with trailing spaces, a block in another line ending);
 *  - an older version of ours put back by someone else is taken, not ignored
 *    as our own echo;
 *  - a missing note takes no body, and a body built on no known version is
 *    never written over a file that appears;
 *  - a tag change a note can't take says so and leaves no undo step;
 *  - keystrokes an editor fails to hand over stay counted as unsaved.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Editor } from '@tiptap/core';
import { vaultPath } from '@shared/vaultPath';
import { parseMarkdownFile } from '@renderer/lib/editor/markdownSync';
import { parseFrontmatterObject, splitFrontmatterSource } from '@renderer/lib/vault/frontmatterRead';
import { assembleNoteText, readNoteText } from '@renderer/lib/notes/noteFile';
import { createNoteWriter, type NoteWriterHost } from '@renderer/lib/notes/noteWriter';
import { writeTagChangeToMarkdownPath } from '@renderer/lib/tags/noteTagWriter';
import { ChangeRefusedError } from '@renderer/commands/changeRefusedError';
import { AddPathTagCommand } from '@renderer/commands/tileTagCommands';
import { NoteEditorView } from '@renderer/lib/editor/noteEditorView';
import { noteStore, setNotePromptHandlers } from '@renderer/stores/notes.svelte';
import { historyStore } from '@renderer/stores/history.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { unsavedWork, __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { __resetErrorBusForTests } from '@renderer/lib/utils/errorBus';
import { beginVaultGeneration } from '@renderer/lib/vault/vaultIdentity';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

const DUPLICATE_KEY = '---\ntitle: First\ntags: [a]\ntitle: Second\n---\nBody\n';
const TAB_INDENT = '---\ntitle: Tabbed\ntags: [t]\n\textra: 1\n---\nBody\n';

describe('one frontmatter object reader', () => {
  it.each([['a duplicate key', DUPLICATE_KEY], ['a tab indent', TAB_INDENT]])(
    'an open note reads the same keys as the index from a block with %s',
    (_what, raw) => {
      const opened = parseMarkdownFile(raw).frontmatter;
      const indexed = parseFrontmatterObject(splitFrontmatterSource(raw).rawFrontmatter);
      expect(opened).toEqual(indexed);
      expect(opened.title).toBeTruthy();
      expect(opened.tags).toBeTruthy();
    },
  );

  it('a change to such a note is refused and the block kept, while a body save keeps it verbatim', () => {
    const refused = vi.fn();
    const withChange = assembleNoteText(readNoteText(DUPLICATE_KEY), { delta: { set: { status: 'done' }, unset: [] } }, refused);
    expect(refused).toHaveBeenCalledWith('unparseable');
    expect(withChange).toBe(DUPLICATE_KEY);
    const bodySave = assembleNoteText(readNoteText(DUPLICATE_KEY), { body: 'New body' });
    expect(bodySave).toBe('---\ntitle: First\ntags: [a]\ntitle: Second\n---\nNew body\n');
  });
});

describe('frontmatter-only change that removes the last key', () => {
  it('keeps a scene-break body from being read back as frontmatter', () => {
    const raw = '---\ntitle: Story\n---\n---\nScene one\n---\nScene two\n';
    const out = assembleNoteText(readNoteText(raw), { delta: { set: {}, unset: ['title'] } });
    const back = parseMarkdownFile(out);
    expect(back.hasFrontmatter).toBe(false);
    expect(back.body).toContain('Scene one');
    expect(out).toBe('***\nScene one\n---\nScene two\n');
  });
});

describe('a body save keeps the frontmatter block as written', () => {
  it.each([
    ['an empty block', '---\n---\nold\n', '---\n---\nnew\n'],
    ['fences with trailing spaces', '---  \ntitle: A\n--- \nold\n', '---  \ntitle: A\n--- \nnew\n'],
    ['CRLF frontmatter over an LF body', '---\r\ntitle: A\r\n---\r\nold\nline\nthree\nfour\n', '---\r\ntitle: A\r\n---\r\nnew\n'],
    ['a file that ends on its closing fence', '---\ntitle: A\n---', '---\ntitle: A\n---\nnew\n'],
    ['a BOM', '\uFEFF---\ntitle: A\n---\nold\n', '\uFEFF---\ntitle: A\n---\nnew\n'],
  ])('%s', (_what, raw, expected) => {
    expect(assembleNoteText(readNoteText(raw), { body: 'new' })).toBe(expected);
  });

  it('a CRLF note gets its body in CRLF under the untouched block', () => {
    const raw = '---\r\ntitle: A\r\n---\r\nold\r\n';
    expect(assembleNoteText(readNoteText(raw), { body: 'one\ntwo' })).toBe('---\r\ntitle: A\r\n---\r\none\r\ntwo\r\n');
  });
});

describe('the note store', () => {
  let vault: MemoryVault;
  const prompts = { conflict: vi.fn(), deletedWithUnsavedBody: vi.fn(), writeTargetMissing: vi.fn(), reloadShrank: vi.fn(), dismiss: vi.fn() };

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    beginVaultGeneration('/vault');
    noteStore.__resetForTests();
    __resetErrorBusForTests();
    vault = installMemoryVault({ 'Note.md': '---\ntitle: Note\n---\nV0\n' });
    for (const fn of Object.values(prompts)) fn.mockReset();
    setNotePromptHandlers(prompts);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    noteStore.__resetForTests();
    historyStore.clear();
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
    vi.restoreAllMocks();
  });

  it('an older version of ours put back by another program is taken, not ignored as an echo', async () => {
    const m = noteStore.acquire('Note.md', 'editor');
    await m.loaded;
    noteStore.setBody('Note.md', 'V1', 'editor');
    await noteStore.flush('Note.md');
    const v1 = vault.read('Note.md') ?? '';
    noteStore.setBody('Note.md', 'V2', 'editor');
    await noteStore.flush('Note.md');

    vault.writeExternally('Note.md', v1);
    await noteStore.onDiskChanged('Note.md');

    expect(m.body).toBe('V1\n');
    expect(vault.read('Note.md')).toBe(v1);
  });

  it('a missing note takes no body', async () => {
    const m = noteStore.acquire('Gone.md', 'editor');
    await m.loaded;
    expect(m.status).toBe('missing');
    expect(noteStore.setBody('Gone.md', 'typed', 'editor')).toBe('missing');
    expect(noteStore.hasPendingWrites('Gone.md')).toBe(false);
  });

  it('a body built on no known version meets a file that appeared as a conflict, never a write', async () => {
    const bodyVersions = { current: 1 };
    const conflicts: string[] = [];
    const host: NoteWriterHost = {
      vaultRoot: () => vault.root,
      baseOf: () => undefined,
      hadFrontmatter: () => false,
      canWriteBody: () => true,
      onBodyConflict: (_p, rel) => conflicts.push(rel),
      onTargetMissing: () => undefined,
      onWritten: () => undefined,
    };
    const writer = createNoteWriter(host);
    vault.writeExternally('Synced.md', 'Downloaded from the other machine\n');
    writer.queueBody('Synced.md', 'Local text', bodyVersions.current);
    const { ok } = await writer.flush('Synced.md');
    expect(ok).toBe(false);
    expect(conflicts).toEqual(['Synced.md']);
    expect(vault.read('Synced.md')).toBe('Downloaded from the other machine\n');
    writer.reset();
  });

  it('a tag change a malformed note can\'t take rejects, and its command leaves the undo stack with a toast', async () => {
    vault.writeExternally('Bad.md', DUPLICATE_KEY);
    await expect(writeTagChangeToMarkdownPath('Bad.md', 'new', 'add')).rejects.toBeInstanceOf(ChangeRefusedError);
    expect(vault.read('Bad.md')).toBe(DUPLICATE_KEY);

    const toast = vi.spyOn(uiStore, 'toast');
    historyStore.setActiveBoard('board-1');
    await historyStore.execute(new AddPathTagCommand('Bad.md', 'new', 'board-1'));
    expect(historyStore.canUndo).toBe(false);
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('frontmatter is malformed'), 'error', expect.any(Number));
  });

  it('a tag change on a note that already says so is no refusal', async () => {
    vault.writeExternally('Has.md', '---\ntags: [done]\n---\nx\n');
    await expect(writeTagChangeToMarkdownPath('Has.md', 'done', 'add')).resolves.toBeUndefined();
    await expect(writeTagChangeToMarkdownPath('Has.md', 'other', 'remove')).resolves.toBeUndefined();
  });

  it.each([['not UTF-8', 'nonUtf8', 'UTF-8'], ['a link', 'links', 'link']] as const)(
    'a tag change on a note that is %s rejects',
    async (_what, set, says) => {
      vault.writeExternally('Ro.md', '---\ntitle: R\n---\nx\n');
      vault[set].add('ro.md');
      const err = await writeTagChangeToMarkdownPath('Ro.md', 'new', 'add').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ChangeRefusedError);
      expect((err as Error).message).toContain(says);
    },
  );

  it('keystrokes an editor fails to hand over stay unsaved and are reported', async () => {
    const failing = {
      isDestroyed: false,
      storage: { markdown: { getMarkdown: () => { throw new Error('serialiser broke'); } } },
    } as unknown as Editor;
    const view = new NoteEditorView('editor', () => failing);
    view.show('Note.md');
    await noteStore.get('Note.md')?.loaded;
    view.edited();
    view.serialize();
    expect(view.hasUnserialised).toBe(true);
    const work = unsavedWork();
    expect([...work.pending, ...work.failed]).toContain(vaultPath('Note.md'));
    view.close();
  });
});

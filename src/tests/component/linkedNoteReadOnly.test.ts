import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { noteStore } from '@renderer/stores/notes.svelte';
import { editorMarkdown } from '@renderer/lib/editor/markdownSync';
import { tiptapToolbar } from '@renderer/lib/editor/toolbarConfig';
import { isLinkedNote, __resetNonUtf8PathsForTests } from '@renderer/lib/vault/nonUtf8Paths.svelte';
import {
  recordingFilo,
  mountTextTile,
  mountDocumentEditor,
  drainDebounce,
  resetEditorHarness,
  teardownEditorHarness,
  type Mounted,
} from './helpers/mountEditor';

/**
 * A note that is a symbolic link is shown but never written: the atomic
 * write would replace the link with a regular file, and the original it
 * points at would stop getting the edits. The main process reports the link
 * on read; every view of the note freezes and says so.
 */
const BODY = 'Shared text.\n';
const BANNER = 'This note is a link; edit the original.';

async function assertFrozen(m: Mounted, rel: string, fs: ReturnType<typeof recordingFilo>): Promise<void> {
  const ed = m.editor();
  expect(isLinkedNote(rel)).toBe(true);
  expect(noteStore.get(rel)?.readOnly).toBe(true);
  expect(ed.isEditable).toBe(false);
  expect(m.target.textContent).toContain(BANNER);

  const before = editorMarkdown(ed);
  ed.commands.selectAll();
  tiptapToolbar.setActiveEditor(ed);
  tiptapToolbar.toggleBold();
  expect(editorMarkdown(ed)).toBe(before);
  await drainDebounce();
  expect(fs.writesTo(rel)).toEqual([]);
  expect(fs.files.get(rel)).toBe(BODY);
}

describe('a note that is a symbolic link is read-only', () => {
  beforeEach(() => {
    resetEditorHarness();
    __resetNonUtf8PathsForTests();
  });
  afterEach(() => {
    teardownEditorHarness();
    __resetNonUtf8PathsForTests();
  });

  it('TextTile', async () => {
    const fs = recordingFilo({ 'Linked.md': BODY });
    fs.links.add('Linked.md');
    const m = await mountTextTile({ tile: { id: 't1', title: 'Linked' } });
    await assertFrozen(m, 'Linked.md', fs);
    await m.unmount();
  });

  it('DocumentEditor', async () => {
    const fs = recordingFilo({ 'Linked.md': BODY });
    fs.links.add('Linked.md');
    const m = await mountDocumentEditor({ docPath: 'Linked.md' });
    await assertFrozen(m, 'Linked.md', fs);
    await m.unmount();
  });

  it('a regular note stays editable (no banner)', async () => {
    recordingFilo({ 'Plain.md': BODY });
    const m = await mountDocumentEditor({ docPath: 'Plain.md' });
    expect(isLinkedNote('Plain.md')).toBe(false);
    expect(m.editor().isEditable).toBe(true);
    expect(m.target.textContent).not.toContain(BANNER);
    await m.unmount();
  });
});

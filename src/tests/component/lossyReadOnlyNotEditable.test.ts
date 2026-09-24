import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { documentStore } from '@renderer/stores/document.svelte';
import { editorMarkdown } from '@renderer/lib/editor/markdownSync';
import { tiptapToolbar } from '@renderer/lib/editor/toolbarConfig';
import {
  recordingFilo,
  mountTextTile,
  mountDocumentEditor,
  settle,
  drainDebounce,
  resetEditorHarness,
  teardownEditorHarness,
  type Mounted,
} from './helpers/mountEditor';

/**
 * Audit-19 UX-1 / MD-7 — a note flagged lossy was "read-only" only in that it
 * refused to SAVE; the editor stayed editable, so typed text was silently
 * discarded (and a tab close found nothing pending). A lossy note is now truly
 * non-editable, toolbar commands included, until Take ownership.
 */
const HARD_WRAPPED = 'A paragraph that is\nhard-wrapped across lines.\n';

async function assertFrozenThenOwned(m: Mounted, rel: string, fs: ReturnType<typeof recordingFilo>): Promise<void> {
  const ed = m.editor();
  expect(documentStore.isReadOnly(rel)).toBe(true);
  expect(ed.isEditable).toBe(false);
  expect(m.target.textContent).toContain('Take ownership');

  const before = editorMarkdown(ed);
  const bodyBefore = documentStore.getDocument(rel)?.body;
  ed.commands.selectAll();
  tiptapToolbar.setActiveEditor(ed);
  tiptapToolbar.toggleBold();
  tiptapToolbar.setHeading(1);
  expect(editorMarkdown(ed)).toBe(before);
  expect(documentStore.getDocument(rel)?.body).toBe(bodyBefore);

  documentStore.takeOwnership(rel);
  await settle();
  expect(ed.isEditable).toBe(true);
  ed.commands.focus('end');
  ed.commands.insertContent('!');
  await drainDebounce();
  expect(fs.writesTo(rel).length).toBe(1);
}

describe('a lossy note is truly non-editable (UX-1)', () => {
  beforeEach(() => resetEditorHarness());
  afterEach(() => teardownEditorHarness());

  it('TextTile', async () => {
    const fs = recordingFilo({ 'Wrapped.md': HARD_WRAPPED });
    const m = await mountTextTile({ tile: { id: 't1', title: 'Wrapped' } });
    await assertFrozenThenOwned(m, 'Wrapped.md', fs);
    await m.unmount();
  });

  it('DocumentEditor', async () => {
    const fs = recordingFilo({ 'Wrapped.md': HARD_WRAPPED });
    const m = await mountDocumentEditor({ docPath: 'Wrapped.md' });
    await assertFrozenThenOwned(m, 'Wrapped.md', fs);
    await m.unmount();
  });
});

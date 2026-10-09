import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount } from 'svelte';
import type { Editor } from '@tiptap/core';
import TextFormattingToolbar from '@renderer/components/layout/TextFormattingToolbar.svelte';
import { tiptapToolbar } from '@renderer/lib/editor/toolbarConfig';
import {
  drainUntilWritten,
  recordingFilo,
  mountTextTile,
  settle,
  resetEditorHarness,
  teardownEditorHarness,
} from './helpers/mountEditor';

/**
 * Alignment doesn't apply inside a list (an aligned list item was written as
 * an HTML line that swallowed its sub-items). The formatting toolbar's Align
 * control is disabled while the caret is in a list or checklist item and
 * says why; on ordinary text it works as before. Indent in a list nests the
 * item, checklists included.
 */
describe('the Align control and Indent in lists', () => {
  let toolbar: Record<string, unknown> | null = null;

  beforeEach(() => resetEditorHarness());
  afterEach(async () => {
    if (toolbar) await unmount(toolbar);
    toolbar = null;
    teardownEditorHarness();
  });

  async function mountWithToolbar(): Promise<{ editor: () => Editor; unmount: () => Promise<void> }> {
    const m = await mountTextTile({ tile: { id: 't1', title: 'Note' } });
    const bar = document.createElement('div');
    document.body.appendChild(bar);
    toolbar = mount(TextFormattingToolbar, { target: bar }) as Record<string, unknown>;
    m.editor().commands.focus('end');
    await settle();
    expect(tiptapToolbar.activeEditor).toBe(m.editor());
    return m;
  }

  /** Puts the caret right after `text` and lets the toolbar catch up. */
  async function caretAfter(ed: Editor, text: string): Promise<void> {
    let pos = -1;
    ed.state.doc.descendants((node, p) => {
      if (pos >= 0) return false;
      if (node.isText && node.text?.includes(text)) pos = p + node.text.indexOf(text) + text.length;
      return true;
    });
    ed.commands.setTextSelection(pos);
    await settle();
  }

  function alignSelect(): HTMLSelectElement {
    const select = document.querySelector<HTMLSelectElement>('select[aria-label="Text alignment"]');
    expect(select).toBeTruthy();
    return select!;
  }

  it('is disabled in a list item, saying why, and works on ordinary text', async () => {
    const fs = recordingFilo({ 'Note.md': 'Plain text\n\n- one\n  - nested\n- two\n' });
    const m = await mountWithToolbar();

    await caretAfter(m.editor(), 'one');
    expect(alignSelect().disabled).toBe(true);
    expect(alignSelect().title).toBe("Text in a list can't be aligned");

    await caretAfter(m.editor(), 'Plain');
    expect(alignSelect().disabled).toBe(false);
    expect(alignSelect().title).toBe('Text Align');
    alignSelect().value = 'center';
    alignSelect().dispatchEvent(new Event('change', { bubbles: true }));
    await drainUntilWritten(fs, 'Note.md');
    expect(fs.files.get('Note.md')).toBe('<p style="text-align: center;">Plain text</p>\n\n- one\n  - nested\n- two\n');
    await m.unmount();
  });

  it('is disabled in a checklist item', async () => {
    recordingFilo({ 'Note.md': '- [ ] buy milk\n- [ ] eggs\n' });
    const m = await mountWithToolbar();
    await caretAfter(m.editor(), 'eggs');
    expect(alignSelect().disabled).toBe(true);
    await m.unmount();
  });

  it('Indent nests a checklist item under the one above', async () => {
    const fs = recordingFilo({ 'Note.md': '- [ ] buy milk\n- [ ] eggs\n' });
    const m = await mountWithToolbar();
    await caretAfter(m.editor(), 'eggs');
    const indent = document.querySelector<HTMLButtonElement>('button[title="Increase Indent"]');
    expect(indent).toBeTruthy();
    indent!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    indent!.click();
    await drainUntilWritten(fs, 'Note.md');
    expect(fs.files.get('Note.md')).toBe('- [ ] buy milk\n  - [ ] eggs\n');
    await m.unmount();
  });
});

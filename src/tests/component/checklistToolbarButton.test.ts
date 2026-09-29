import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount } from 'svelte';
import TextFormattingToolbar from '@renderer/components/layout/TextFormattingToolbar.svelte';
import { tiptapToolbar } from '@renderer/lib/editor/toolbarConfig';
import {
  recordingFilo,
  mountTextTile,
  settle,
  drainDebounce,
  resetEditorHarness,
  teardownEditorHarness,
} from './helpers/mountEditor';

/**
 * The formatting toolbar's Checklist button turns the line into a checklist
 * item, as Ctrl+Shift+9 does, and the note is saved as one.
 */
describe('the Checklist toolbar button', () => {
  let toolbar: Record<string, unknown> | null = null;

  beforeEach(() => resetEditorHarness());
  afterEach(async () => {
    if (toolbar) await unmount(toolbar);
    toolbar = null;
    teardownEditorHarness();
  });

  it('makes the line a checklist item and saves it', async () => {
    const fs = recordingFilo({ 'Note.md': 'Buy milk\n' });
    const m = await mountTextTile({ tile: { id: 't1', title: 'Note' } });
    const bar = document.createElement('div');
    document.body.appendChild(bar);
    toolbar = mount(TextFormattingToolbar, { target: bar }) as Record<string, unknown>;
    m.editor().commands.focus('end');
    await settle();
    expect(tiptapToolbar.activeEditor).toBe(m.editor());

    const button = document.querySelector<HTMLButtonElement>('button[title^="Checklist"]');
    expect(button).toBeTruthy();
    button!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    button!.click();
    await settle();
    expect(m.editor().getJSON().content?.[0]?.type).toBe('taskList');

    await drainDebounce();
    expect(fs.files.get('Note.md')).toBe('- [ ] Buy milk\n');
    await m.unmount();
  });
});

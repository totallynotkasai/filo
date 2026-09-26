import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount } from 'svelte';
import TextFormattingToolbar from '@renderer/components/layout/TextFormattingToolbar.svelte';
import { tiptapToolbar } from '@renderer/lib/editor/toolbarConfig';
import { recordingFilo, mountTextTile, settle, resetEditorHarness, teardownEditorHarness } from './helpers/mountEditor';

/**
 * The formatting toolbar's Text style dropdown. It shows the block's level
 * from the toolbar store; a pick the editor refuses changes nothing in the
 * store, so the dropdown must not be left showing the level that was picked.
 */
describe('Text style dropdown', () => {
  let toolbar: Record<string, unknown> | null = null;

  beforeEach(() => resetEditorHarness());
  afterEach(async () => {
    if (toolbar) await unmount(toolbar);
    toolbar = null;
    teardownEditorHarness();
  });

  async function setUp(body: string): Promise<{ select: HTMLSelectElement; files: Map<string, string> }> {
    const fs = recordingFilo({ 'Note.md': body });
    const m = await mountTextTile({ tile: { id: 't1', title: 'Note' } });
    const bar = document.createElement('div');
    document.body.appendChild(bar);
    toolbar = mount(TextFormattingToolbar, { target: bar }) as Record<string, unknown>;
    m.editor().commands.focus();
    m.editor().commands.setTextSelection(2);
    await settle();
    expect(tiptapToolbar.activeEditor).toBe(m.editor());
    const select = document.querySelector<HTMLSelectElement>('select[aria-label="Text style"]');
    if (!select) throw new Error('no text style dropdown');
    return { select, files: fs.files };
  }

  function pick(select: HTMLSelectElement, value: string): void {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  it('shows the picked level once it is applied', async () => {
    const { select } = await setUp('Alpha beta\n');
    expect(select.value).toBe('normal');
    pick(select, 'h2');
    await settle();
    expect(select.value).toBe('h2');
    expect(tiptapToolbar.activeEditor?.isActive('heading', { level: 2 })).toBe(true);
  });

  it('goes back to the real level when the editor refuses the pick', async () => {
    const { select } = await setUp('Alpha beta\n');
    expect(select.value).toBe('normal');
    // A note that can't be edited right now (read-only, frozen for a close).
    tiptapToolbar.activeEditor?.setEditable(false, false);
    pick(select, 'h2');
    await settle();
    expect(tiptapToolbar.activeEditor?.isActive('heading')).toBe(false);
    expect(select.value).toBe('normal');
  });
});

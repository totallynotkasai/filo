import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount } from 'svelte';
import TextFormattingToolbar from '@renderer/components/layout/TextFormattingToolbar.svelte';
import { tiptapToolbar } from '@renderer/lib/editor/toolbarConfig';
import { recordingFilo, mountTextTile, settle, resetEditorHarness, teardownEditorHarness } from './helpers/mountEditor';

/**
 * The toolbar's font box shows the font the selected text is in: its own font
 * mark, or else the global font. It used to say "Inter" for any text without a
 * mark, a font Filo doesn't ship.
 */
describe('Toolbar font box', () => {
  let toolbar: Record<string, unknown> | null = null;

  beforeEach(() => resetEditorHarness());
  afterEach(async () => {
    if (toolbar) await unmount(toolbar);
    toolbar = null;
    teardownEditorHarness();
  });

  async function setUp(): Promise<{ select: HTMLSelectElement; editor: ReturnType<Awaited<ReturnType<typeof mountTextTile>>['editor']> }> {
    recordingFilo({ 'Note.md': 'Alpha beta\n' });
    const m = await mountTextTile({ tile: { id: 't1', title: 'Note' } });
    const bar = document.createElement('div');
    document.body.appendChild(bar);
    toolbar = mount(TextFormattingToolbar, { target: bar }) as Record<string, unknown>;
    m.editor().commands.focus();
    m.editor().commands.setTextSelection(2);
    await settle();
    expect(tiptapToolbar.activeEditor).toBe(m.editor());
    const select = document.querySelector<HTMLSelectElement>('select[aria-label="Font family"]');
    if (!select) throw new Error('no font box');
    return { select, editor: m.editor() };
  }

  it('shows the global font for text without a font of its own', async () => {
    const { select } = await setUp();
    expect(select.value).toBe('Arial Rounded MT');
    expect([...select.options].map((o) => o.value)).not.toContain('Inter');
  });

  it("shows the text's own font when it has one", async () => {
    const { select, editor } = await setUp();
    editor.chain().setTextSelection({ from: 1, to: 6 }).setFontFamily('Georgia').run();
    editor.commands.setTextSelection(3);
    await settle();
    expect(select.value).toBe('Georgia');
  });

  it('lists a font the lists do not name, so the box never goes blank', async () => {
    const { select, editor } = await setUp();
    editor.chain().setTextSelection({ from: 1, to: 6 }).setFontFamily('Some Pasted Font').run();
    editor.commands.setTextSelection(3);
    await settle();
    expect(select.value).toBe('Some Pasted Font');
  });
});

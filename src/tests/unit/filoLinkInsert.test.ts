/**
 * Audit-19 UX-2 — `filo://` internal links could not be inserted: TipTap's Link
 * URI allowlist refused them, `setLink` returned false and the toolbar ignored
 * the result, so nothing happened. A custom `isAllowedUri` now accepts filo://
 * while still refusing `javascript:`; a refused href shows a toast.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Editor } from '@tiptap/core';
import { createTiptapEditor } from '@renderer/lib/editor/createEditor';
import { editorMarkdown, loadMarkdownIntoEditor } from '@renderer/lib/editor/markdownSync';
import { tiptapToolbar, LINK_REFUSED_MESSAGE } from '@renderer/lib/editor/toolbarConfig';
import { uiStore } from '@renderer/stores/ui.svelte';

const editors: Editor[] = [];
function makeEditor(body: string): Editor {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const ed = createTiptapEditor({ element: el });
  editors.push(ed);
  loadMarkdownIntoEditor(ed, body);
  return ed;
}

afterEach(() => {
  vi.restoreAllMocks();
  tiptapToolbar.clearActiveEditor();
  while (editors.length) editors.pop()?.destroy();
});

describe('filo:// link insertion (Audit-19 UX-2)', () => {
  it('setLink accepts a filo://board link and it serialises', () => {
    const ed = makeEditor('hello world\n');
    ed.commands.setTextSelection({ from: 1, to: 6 });
    expect(ed.commands.setLink({ href: 'filo://board/abc123def456' })).toBe(true);
    expect(editorMarkdown(ed)).toContain('[hello](filo://board/abc123def456)');
  });

  it('still refuses javascript: hrefs', () => {
    const ed = makeEditor('hello world\n');
    ed.commands.setTextSelection({ from: 1, to: 6 });
    expect(ed.commands.setLink({ href: 'javascript:alert(1)' })).toBe(false);
    expect(editorMarkdown(ed)).not.toContain('javascript:');
  });

  it('toolbar setLink toasts when the href is refused', () => {
    const toast = vi.spyOn(uiStore, 'toast').mockImplementation(() => undefined as never);
    const ed = makeEditor('hello world\n');
    ed.commands.setTextSelection({ from: 1, to: 6 });
    tiptapToolbar.setActiveEditor(ed);
    tiptapToolbar.setLink('javascript:alert(1)');
    expect(toast).toHaveBeenCalledWith(LINK_REFUSED_MESSAGE, 'error');
  });
});

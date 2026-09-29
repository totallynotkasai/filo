/**
 * tiptap-markdown runs every extension's parse `setup` on every parse, and
 * its checklist setup calls `md.use(markdown-it-task-lists)` each time, which
 * adds another copy of the `github-task-lists` rule. A later copy reads a task
 * whose text starts with `[ ] ` as a second checkbox. The editor's parser keeps
 * one copy however many notes it loads.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { Editor } from '@tiptap/core';
import { createTiptapEditor } from '@renderer/lib/editor/createEditor';
import { editorMarkdown, loadMarkdownIntoEditor } from '@renderer/lib/editor/markdownSync';

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
  document.body.innerHTML = '';
});

interface RulerLike { __rules__: Array<{ name: string }> }

function coreRuleNames(ed: Editor): string[] {
  const parser = (ed as { storage?: { markdown?: { parser?: { md?: { core: { ruler: RulerLike } } } } } }).storage?.markdown?.parser;
  return parser?.md?.core.ruler.__rules__.map((r) => r.name) ?? [];
}

function mount(): Editor {
  const el = document.createElement('div');
  document.body.appendChild(el);
  editor = createTiptapEditor({ element: el });
  return editor;
}

describe('the checklist parse rule is registered once', () => {
  it('stays one rule over many loads', () => {
    const ed = mount();
    for (let i = 0; i < 5; i++) loadMarkdownIntoEditor(ed, `- [ ] task ${i}\n`);
    expect(coreRuleNames(ed).filter((n) => n === 'github-task-lists')).toHaveLength(1);
  });

  it('a task whose text starts with "[ ] " keeps that text after several loads', () => {
    const ed = mount();
    for (let i = 0; i < 3; i++) loadMarkdownIntoEditor(ed, 'intro\n');
    loadMarkdownIntoEditor(ed, '- [ ] [ ] boxes in the text\n');
    expect(ed.getJSON().content?.[0]?.type).toBe('taskList');
    expect(ed.getText()).toContain('[ ] boxes in the text');
    const saved = editorMarkdown(ed);
    loadMarkdownIntoEditor(ed, saved);
    expect(editorMarkdown(ed)).toBe(saved);
  });
});

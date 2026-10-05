import { describe, it, expect, afterEach } from 'vitest';
import { userEvent } from 'vitest/browser';
import type { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { createLabelEditor, createTiptapEditor } from '../../renderer/lib/editor/createEditor';
import { editorMarkdown, loadMarkdownIntoEditor } from '../../renderer/lib/editor/markdownSync';
import { tiptapToolbar } from '../../renderer/lib/editor/toolbarConfig';
import { toolbarStore } from '../../renderer/stores/toolbar.svelte';

/**
 * The list buttons change a list's kind in place, keeping every item at its
 * level. TipTap's toggle took a list apart to make it a checklist (or back),
 * which demoted and promoted the items of a nested list at random, and did
 * nothing with the caret in an item that had sub-items.
 */

const editors: Editor[] = [];
afterEach(() => {
  while (editors.length) {
    const ed = editors.pop()!;
    tiptapToolbar.releaseEditor(ed);
    ed.destroy();
  }
  document.body.innerHTML = '';
});

function editorWith(markdown: string): Editor {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const ed = createTiptapEditor({ element: el, content: '' });
  editors.push(ed);
  loadMarkdownIntoEditor(ed, markdown);
  return ed;
}

/** Each line of the note as `<level>:<kind> <text>`: `-` a bullet, `1.` a number, `[ ]` a checkbox, `p` a paragraph. */
function outline(ed: Editor): string[] {
  const out: string[] = [];
  const MARKER: Record<string, string> = { bulletList: '-', orderedList: '1.', taskList: '[ ]' };
  const visit = (node: ProseMirrorNode, level: number): void => {
    const marker = MARKER[node.type.name];
    if (marker) {
      node.forEach((item) => {
        out.push(`${level}:${item.type.name === 'taskItem' ? '[ ]' : marker} ${item.firstChild?.textContent ?? ''}`);
        item.forEach((child, _o, i) => {
          if (i > 0) visit(child, level + 1);
        });
      });
    } else if (node.isTextblock) {
      out.push(`${level}:p ${node.textContent}`);
    } else {
      node.forEach((child) => visit(child, level));
    }
  };
  ed.state.doc.forEach((node) => visit(node, 0));
  return out;
}

function caretIn(ed: Editor, text: string): void {
  let at = -1;
  ed.state.doc.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text?.includes(text)) at = pos + node.text.indexOf(text) + 1;
    return at < 0;
  });
  if (at < 0) throw new Error(`no "${text}" in the note`);
  ed.commands.setTextSelection(at);
}

function selectFromTo(ed: Editor, fromText: string, toText: string): void {
  let from = -1;
  let to = -1;
  ed.state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return true;
    if (from < 0 && node.text.includes(fromText)) from = pos + node.text.indexOf(fromText);
    if (node.text.includes(toText)) to = pos + node.text.indexOf(toText) + toText.length;
    return true;
  });
  ed.commands.setTextSelection({ from, to });
}

/** Saves, reopens, and saves again: the note reads back as written. */
function expectReadsBack(ed: Editor): string {
  const md = editorMarkdown(ed);
  const el = document.createElement('div');
  document.body.appendChild(el);
  const again = createTiptapEditor({ element: el, content: '' });
  editors.push(again);
  const { lossy } = loadMarkdownIntoEditor(again, md);
  expect(lossy).toBe(false);
  expect(editorMarkdown(again)).toBe(md);
  return md;
}

/** Runs a list button as the toolbar does. */
function press(ed: Editor, button: 'toggleBulletList' | 'toggleOrderedList' | 'toggleTaskList'): void {
  tiptapToolbar.setActiveEditor(ed);
  tiptapToolbar[button]();
}

const PROFILE = '- Hair: silver\n- Eyes: grey\n  - left eye scarred\n- Height: tall';

describe('a whole nested list changes kind with every item at its level', () => {
  it('bullets with a nested item → Checklist', () => {
    const ed = editorWith('- one\n- two\n  - nested');
    ed.commands.selectAll();
    press(ed, 'toggleTaskList');
    expect(outline(ed)).toEqual(['0:[ ] one', '0:[ ] two', '1:[ ] nested']);
    expect(expectReadsBack(ed)).toBe('- [ ] one\n- [ ] two\n  - [ ] nested');
  });

  it('bullets with a nested item → Numbered', () => {
    const ed = editorWith('- one\n- two\n  - nested');
    ed.commands.selectAll();
    press(ed, 'toggleOrderedList');
    expect(outline(ed)).toEqual(['0:1. one', '0:1. two', '1:1. nested']);
    expectReadsBack(ed);
  });

  it('a checklist with a sub-task → Bulleted (ticks dropped)', () => {
    const ed = editorWith('- [x] one\n- [ ] two\n  - [ ] nested');
    ed.commands.selectAll();
    press(ed, 'toggleBulletList');
    expect(outline(ed)).toEqual(['0:- one', '0:- two', '1:- nested']);
    expect(expectReadsBack(ed)).toBe('- one\n- two\n  - nested');
  });

  it('a character profile → Checklist', () => {
    const ed = editorWith(PROFILE);
    ed.commands.selectAll();
    press(ed, 'toggleTaskList');
    expect(outline(ed)).toEqual(['0:[ ] Hair: silver', '0:[ ] Eyes: grey', '1:[ ] left eye scarred', '0:[ ] Height: tall']);
    expectReadsBack(ed);
  });

  it('a numbered list keeps its numbers when made a checklist and back', () => {
    const ed = editorWith('1. one\n2. two\n   1. nested');
    ed.commands.selectAll();
    press(ed, 'toggleTaskList');
    ed.commands.selectAll();
    press(ed, 'toggleOrderedList');
    expect(outline(ed)).toEqual(['0:1. one', '0:1. two', '1:1. nested']);
    expectReadsBack(ed);
  });
});

describe('the caret in a list item', () => {
  it('in an item with sub-items, Checklist makes its list a checklist and leaves the sub-list as it is', () => {
    const ed = editorWith(PROFILE);
    caretIn(ed, 'Eyes');
    press(ed, 'toggleTaskList');
    expect(outline(ed)).toEqual(['0:[ ] Hair: silver', '0:[ ] Eyes: grey', '1:- left eye scarred', '0:[ ] Height: tall']);
    expectReadsBack(ed);
  });

  it('in a checklist item with a sub-task, Bulleted makes its list bullets', () => {
    const ed = editorWith('- [ ] one\n- [ ] two\n  - [ ] nested');
    caretIn(ed, 'two');
    press(ed, 'toggleBulletList');
    expect(outline(ed)).toEqual(['0:- one', '0:- two', '1:[ ] nested']);
    expectReadsBack(ed);
  });

  it('in a nested item, Numbered changes only the nested list', () => {
    const ed = editorWith(PROFILE);
    caretIn(ed, 'left eye');
    press(ed, 'toggleOrderedList');
    expect(outline(ed)).toEqual(['0:- Hair: silver', '0:- Eyes: grey', '1:1. left eye scarred', '0:- Height: tall']);
    expectReadsBack(ed);
  });

  it('Ctrl+Shift+9 does what the Checklist button does', async () => {
    const ed = editorWith(PROFILE);
    ed.view.focus();
    caretIn(ed, 'Eyes');
    await userEvent.keyboard('{Control>}{Shift>}9{/Shift}{/Control}');
    expect(outline(ed)).toEqual(['0:[ ] Hair: silver', '0:[ ] Eyes: grey', '1:- left eye scarred', '0:[ ] Height: tall']);
  });

  it('in a bulleted item, Bulleted takes the item out of the list, as before', () => {
    const ed = editorWith('- one\n- two');
    caretIn(ed, 'two');
    press(ed, 'toggleBulletList');
    expect(outline(ed)).toEqual(['0:- one', '0:p two']);
  });
});

describe('text outside a list', () => {
  it('a selected paragraph becomes a list item', () => {
    const ed = editorWith('First line\n\nSecond line');
    ed.commands.selectAll();
    press(ed, 'toggleTaskList');
    expect(outline(ed)).toEqual(['0:[ ] First line', '0:[ ] Second line']);
    expectReadsBack(ed);
  });

  it('a paragraph selected with a list joins it as an item of the new kind', () => {
    const ed = editorWith('Intro\n\n- one\n- two\n  - nested');
    selectFromTo(ed, 'Intro', 'nested');
    press(ed, 'toggleTaskList');
    expect(outline(ed)).toEqual(['0:[ ] Intro', '0:[ ] one', '0:[ ] two', '1:[ ] nested']);
    expectReadsBack(ed);
  });

  it('a heading selected with a list is left as it is', () => {
    const ed = editorWith('# Aria\n\n- one\n- two');
    ed.commands.selectAll();
    press(ed, 'toggleOrderedList');
    expect(outline(ed)).toEqual(['0:p Aria', '0:1. one', '0:1. two']);
    expect(ed.state.doc.firstChild?.type.name).toBe('heading');
  });
});

describe('where lists can\x27t go', () => {
  it('a title editor has the list buttons off', async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const label = createLabelEditor({ element: el, content: '<p>Title</p>' });
    editors.push(label);
    tiptapToolbar.setActiveEditor(label);
    await new Promise((r) => setTimeout(r, 0));
    expect(toolbarStore.listsAvailable).toBe(false);
    const note = editorWith('Body');
    tiptapToolbar.setActiveEditor(note);
    await new Promise((r) => setTimeout(r, 0));
    expect(toolbarStore.listsAvailable).toBe(true);
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import type { Editor } from '@tiptap/core';
import { startUnsavedStateReport, type UnsavedStateSources } from '@renderer/lib/vault/unsavedStateReport';
import { createLabelEditor, createTiptapEditor } from '@renderer/lib/editor/createEditor';

/**
 * What main is told about a Windows shutdown: hold it back only when leaving
 * now could lose work. A caret resting in a note editor is not work; a field
 * whose text changed since it took focus is.
 */

const clean: UnsavedStateSources = {
  nothingUnsaved: () => true,
  heldDecisionCount: () => 0,
  openSettingsEdits: () => false,
};

// jsdom has no layout: ProseMirror scrolls a focused selection into view by
// its client rects, so answer with empty geometry.
const emptyRects = (): DOMRectList => Object.assign([], { item: () => null }) as unknown as DOMRectList;
const zeroRect = (): DOMRect => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
for (const proto of [Element.prototype, Range.prototype] as Array<{ getClientRects?: unknown; getBoundingClientRect?: unknown }>) {
  if (typeof proto.getClientRects !== 'function') proto.getClientRects = emptyRects;
  if (typeof proto.getBoundingClientRect !== 'function') proto.getBoundingClientRect = zeroRect;
}

let stop: (() => void) | null = null;
const editors: Editor[] = [];

afterEach(() => {
  stop?.();
  stop = null;
  while (editors.length) editors.pop()!.destroy();
  document.body.innerHTML = '';
});

/** A real editor, as a tile title (label) or a note (note editor) is typed in. */
function makeEditor(kind: 'title' | 'note', html: string): { editor: Editor; dom: HTMLElement } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const editor = kind === 'title'
    ? createLabelEditor({ element: host, content: html })
    : createTiptapEditor({ element: host, content: html });
  editors.push(editor);
  return { editor, dom: editor.view.dom as HTMLElement };
}

function report(sources: UnsavedStateSources = clean): { flags: boolean[]; nudge: () => void } {
  const flags: boolean[] = [];
  const r = startUnsavedStateReport(sources, (flag) => flags.push(flag));
  stop = r.stop;
  return { flags, nudge: r.nudge };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

describe('unsaved-state report', () => {
  it('a focused note editor with nothing unsaved does not hold a shutdown back', async () => {
    document.body.innerHTML = '<div class="ProseMirror" data-note-editor="true" contenteditable="true"><p>text</p></div>';
    const editor = document.querySelector<HTMLElement>('.ProseMirror')!;
    const { flags } = report();
    editor.focus();
    await settle();
    expect(document.activeElement).toBe(editor);
    expect(flags.at(-1)).toBe(false);
  });

  it("a note editor's unserialised keystrokes do, as soon as they are typed", async () => {
    document.body.innerHTML = '<div class="ProseMirror" data-note-editor="true" contenteditable="true"><p>text</p></div>';
    const editor = document.querySelector<HTMLElement>('.ProseMirror')!;
    let unserialised = false;
    const { flags } = report({ ...clean, nothingUnsaved: () => !unserialised });
    editor.focus();
    await settle();
    unserialised = true;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect(flags.at(-1)).toBe(true);
  });

  it('a focused input counts only once its text changed', async () => {
    document.body.innerHTML = '<input type="text" value="Title">';
    const input = document.querySelector('input')!;
    const { flags } = report();
    input.focus();
    await settle();
    expect(flags.at(-1)).toBe(false);
    input.value = 'Title edited';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect(flags.at(-1)).toBe(true);
    input.blur();
    await settle();
    expect(flags.at(-1)).toBe(false);
  });

  it('a tile, frame or connection title being typed holds a shutdown back', async () => {
    const { editor, dom } = makeEditor('title', '<p>Old title</p>');
    const { flags } = report();
    dom.focus();
    await settle();
    expect(document.activeElement).toBe(dom);
    expect(flags.at(-1)).toBe(false);
    // Typed, not yet committed: the title is only in its editor.
    editor.commands.setContent('<p>New title</p>');
    dom.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect(flags.at(-1)).toBe(true);
  });

  it('a focused title that still says what it said does not', async () => {
    const { dom } = makeEditor('title', '<p>Old title</p>');
    const { flags, nudge } = report();
    dom.focus();
    await settle();
    nudge();
    expect(flags.at(-1)).toBe(false);
  });

  it("a note editor's text is left to the note store, which reports it", async () => {
    const { editor, dom } = makeEditor('note', '<p>Body</p>');
    let unserialised = false;
    const { flags, nudge } = report({ ...clean, nothingUnsaved: () => !unserialised });
    dom.focus();
    await settle();
    editor.commands.setContent('<p>Body edited</p>');
    dom.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    nudge();
    // Nothing unsaved: the changed text alone is not counted.
    expect(flags.at(-1)).toBe(false);
    unserialised = true;
    nudge();
    expect(flags.at(-1)).toBe(true);
  });

  it('anything unsaved still counts with no field focused', () => {
    const { flags } = report({ ...clean, nothingUnsaved: () => false });
    expect(flags).toEqual([true]);
  });
});

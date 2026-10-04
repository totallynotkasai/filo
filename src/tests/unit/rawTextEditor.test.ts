/**
 * The Raw view's text field (CodeMirror) on its own: it reports typing,
 * leaving and Ctrl+S, shows text read from disk with its undo history
 * cleared, and never changes the text by itself.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { undo } from '@codemirror/commands';
import { createRawTextEditor, type RawTextEditor, type RawTextEditorOptions } from '@renderer/lib/editor/rawTextEditor';

interface Field {
  editor: RawTextEditor;
  view: EditorView;
  host: HTMLElement;
  options: RawTextEditorOptions;
}

const made: RawTextEditor[] = [];

afterEach(() => {
  while (made.length) made.pop()!.destroy();
  document.body.innerHTML = '';
});

function field(text: string, overrides: Partial<RawTextEditorOptions> = {}): Field {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const options: RawTextEditorOptions = {
    text,
    label: 'Raw Markdown of Plan.md',
    editable: true,
    onChange: vi.fn(),
    onBlur: vi.fn(),
    onSave: vi.fn(),
    ...overrides,
  };
  const editor = createRawTextEditor(host, options);
  made.push(editor);
  const view = EditorView.findFromDOM(host.querySelector('.cm-editor') as HTMLElement);
  if (!view) throw new Error('no view');
  return { editor, view, host, options };
}

/** A user's change, as typing makes one. */
function type(view: EditorView, at: number, insert: string): void {
  view.dispatch({ changes: { from: at, insert }, selection: { anchor: at + insert.length }, userEvent: 'input.type' });
}

function press(view: EditorView, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  view.contentDOM.dispatchEvent(event);
  return event;
}

/** The classes of the spans showing `text` (spaces around it aside). */
function classesOf(host: HTMLElement, text: string): string[] {
  return [...host.querySelectorAll('.cm-content span')]
    .filter((s) => (s.textContent ?? '').trim() === text)
    .map((s) => s.className);
}

describe('rawTextEditor', () => {
  it('shows its text, and reports a user change with the whole text', () => {
    const f = field('One\nTwo\n');
    expect(f.editor.text()).toBe('One\nTwo\n');
    type(f.view, 3, '!');
    expect(f.options.onChange).toHaveBeenCalledWith('One!\nTwo\n');
    expect(f.editor.text()).toBe('One!\nTwo\n');
  });

  it('setText shows text from disk without reporting it as typing, and keeps the caret', () => {
    const f = field('Alpha\nBeta\nGamma\n');
    f.view.dispatch({ selection: { anchor: 'Alpha\nBeta\nGa'.length } });
    expect(f.editor.setText('Alpha (edited elsewhere)\nBeta\nGamma\n')).toBe(true);
    expect(f.editor.text()).toBe('Alpha (edited elsewhere)\nBeta\nGamma\n');
    expect(f.options.onChange).not.toHaveBeenCalled();
    // The caret moved with its text, not to the end or the start.
    expect(f.view.state.selection.main.head).toBe('Alpha (edited elsewhere)\nBeta\nGa'.length);
  });

  it('setText clears the undo history: Ctrl+Z after it does nothing', () => {
    const f = field('Mine\n');
    type(f.view, 4, ' typed');
    expect(f.editor.text()).toBe('Mine typed\n');
    f.editor.setText('Theirs\n');
    expect(undo(f.view)).toBe(false);
    expect(f.editor.text()).toBe('Theirs\n');
    // With nothing typed, there is nothing to undo at all.
    const g = field('First\n');
    g.editor.setText('Second\n');
    expect(undo(g.view)).toBe(false);
    expect(g.editor.text()).toBe('Second\n');
  });

  it('setText keeps no undo step that overlaps the text it replaced (no mix of two versions)', () => {
    // The user's typed paragraph is saved; another view then rewrites it.
    const saved = 'The first draft.\nA new scene typed here.\n';
    const f = field('The first draft.\n');
    type(f.view, f.view.state.doc.length, 'A new scene typed here.\n');
    expect(f.editor.text()).toBe(saved);
    const theirs = 'The first draft.\nA new scene, edited in the card.\n';
    f.editor.setText(theirs);
    expect(undo(f.view)).toBe(false);
    expect(f.editor.text()).toBe(theirs);
  });

  it('typing after setText starts a new history that undo walks back to the loaded text', () => {
    const f = field('One\n');
    type(f.view, 3, ' typed');
    f.editor.setText('Two\n');
    type(f.view, 3, '!');
    expect(f.editor.text()).toBe('Two!\n');
    expect(undo(f.view)).toBe(true);
    expect(f.editor.text()).toBe('Two\n');
    expect(undo(f.view)).toBe(false);
  });

  it('setText keeps the selection where its text is', () => {
    const f = field('Alpha\nBeta\n');
    type(f.view, 5, '!');
    f.view.dispatch({ selection: { anchor: 'Alpha!\nB'.length, head: 'Alpha!\nBet'.length } });
    f.editor.setText('Alpha!\nBeta\nGamma\n');
    const { from, to } = f.view.state.selection.main;
    expect(f.view.state.sliceDoc(from, to)).toBe('et');
  });

  it('setText with the text already shown leaves the undo history alone', () => {
    const f = field('One\n');
    type(f.view, 3, ' typed');
    expect(f.editor.setText('One typed\n')).toBe(true);
    expect(undo(f.view)).toBe(true);
    expect(f.editor.text()).toBe('One\n');
  });

  it('setText changes nothing while an IME composition is open', () => {
    const f = field('Plan\n');
    f.view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    expect(f.view.compositionStarted).toBe(true);
    expect(f.editor.composing()).toBe(true);
    expect(f.editor.setText('Changed\n')).toBe(false);
    expect(f.editor.text()).toBe('Plan\n');
    f.view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
  });

  it('revealLine selects the line, focuses the field and marks the line until it is edited', () => {
    const f = field('---\ntitle: Plan\n---\nIntro\n\nThe line\nAfter\n');
    f.editor.revealLine(6);
    const { from, to } = f.view.state.selection.main;
    expect(f.view.state.sliceDoc(from, to)).toBe('The line');
    expect(f.view.hasFocus).toBe(true);
    const marked = (): string[] => [...f.host.querySelectorAll('.cm-filo-named-line')].map((l) => l.textContent ?? '');
    expect(marked()).toEqual(['The line']);
    // Typing elsewhere keeps the mark; an edit of the line ends it.
    type(f.view, f.view.state.doc.line(4).to, ' more');
    expect(marked()).toEqual(['The line']);
    type(f.view, f.view.state.doc.line(6).to, '!');
    expect(marked()).toEqual([]);
  });

  it('revealLine clamps a line past the end to the last line', () => {
    const f = field('One\nTwo');
    f.editor.revealLine(40);
    const { from, to } = f.view.state.selection.main;
    expect(f.view.state.sliceDoc(from, to)).toBe('Two');
  });

  it('allowEditing toggles editing; a read-only field can still take focus', () => {
    const f = field('Plan\n', { editable: false });
    expect(f.view.state.readOnly).toBe(true);
    expect(f.view.contentDOM.getAttribute('contenteditable')).toBe('false');
    expect(f.view.contentDOM.getAttribute('tabindex')).toBe('0');
    f.editor.allowEditing(true);
    expect(f.view.state.readOnly).toBe(false);
    expect(f.view.contentDOM.getAttribute('contenteditable')).toBe('true');
    f.editor.allowEditing(false);
    expect(f.view.state.readOnly).toBe(true);
  });

  it('Ctrl+S calls onSave and keeps the key from the browser', () => {
    const f = field('Plan\n');
    const event = press(f.view, 's', { ctrlKey: true });
    expect(f.options.onSave).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaving the field calls onBlur; moving into its own find bar does not', () => {
    const f = field('Plan\n');
    f.view.focus();
    // Ctrl+F opens the find bar and moves the focus into it.
    expect(press(f.view, 'f', { ctrlKey: true }).defaultPrevented).toBe(true);
    const find = f.host.querySelector<HTMLInputElement>('.cm-search input[name="search"]');
    expect(find).not.toBeNull();
    // Chromium's input.select() moves the focus there; jsdom's doesn't.
    find!.focus();
    expect(document.activeElement).toBe(find);
    expect(f.options.onBlur).not.toHaveBeenCalled();
    // Ctrl+S in the find bar still saves.
    find!.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
    expect(f.options.onSave).toHaveBeenCalledTimes(1);
    find!.blur();
    expect(f.options.onBlur).toHaveBeenCalledTimes(1);
  });

  it('Tab is left to the browser (it leaves the field), as it was from the textarea', () => {
    const f = field('Plan\n');
    f.view.focus();
    expect(press(f.view, 'Tab').defaultPrevented).toBe(false);
    expect(f.editor.text()).toBe('Plan\n');
  });

  it('names itself, and is marked as the plain text field and a note editor', () => {
    const f = field('Plan\n');
    const content = f.view.contentDOM;
    expect(content.getAttribute('aria-label')).toBe('Raw Markdown of Plan.md');
    expect(content.getAttribute('spellcheck')).toBe('false');
    expect(content.hasAttribute('data-plain-text-field')).toBe(true);
    expect(content.getAttribute('data-note-editor')).toBe('true');
    f.editor.setLabel('Raw Markdown of Renamed.md');
    expect(content.getAttribute('aria-label')).toBe('Raw Markdown of Renamed.md');
  });

  it('shows invisible characters', () => {
    const f = field('a​b\n');
    expect(f.host.querySelectorAll('.cm-specialChar')).toHaveLength(1);
    expect(f.editor.text()).toBe('a​b\n');
  });

  it('colours Markdown: markup as markup, the words in their style', () => {
    const f = field('# Title\n\nSome **bold** and *it* and `code` and [a link](https://x.test) and ~~gone~~.\n\n> quoted\n');
    expect(classesOf(f.host, '#').join(' ')).toContain('tok-meta');
    expect(classesOf(f.host, 'Title').join(' ')).toContain('tok-heading');
    expect(classesOf(f.host, 'bold').join(' ')).toContain('tok-strong');
    expect(classesOf(f.host, 'it').join(' ')).toContain('tok-emphasis');
    expect(classesOf(f.host, 'code').join(' ')).toContain('tok-monospace');
    expect(classesOf(f.host, 'a link').join(' ')).toContain('tok-link');
    expect(classesOf(f.host, 'https://x.test').join(' ')).toContain('tok-url');
    expect(classesOf(f.host, 'gone').join(' ')).toContain('tok-strikethrough');
    expect(classesOf(f.host, 'quoted').join(' ')).toContain('tok-quote');
  });

  it('marks the frontmatter block the fence parser finds: fences, keys, and nothing past it', () => {
    const f = field('---\ntitle: Plan\ntags:\n  - work\n---\nBody\n\n---\n\nAfter a rule\n');
    const fences = [...f.host.querySelectorAll('.cm-filo-fm-fence')].map((s) => s.textContent);
    expect(fences).toEqual(['---', '---']);
    const keys = [...f.host.querySelectorAll('.cm-filo-fm-key')].map((s) => s.textContent);
    expect(keys).toEqual(['title', 'tags']);
    const block = [...f.host.querySelectorAll('.cm-filo-fm')].map((s) => s.textContent).join('');
    expect(block).not.toContain('Body');
  });

  it('a file with no closed block has no frontmatter marks, until one is closed', () => {
    const f = field('---\ntitle: Plan\nBody\n');
    expect(f.host.querySelectorAll('.cm-filo-fm')).toHaveLength(0);
    type(f.view, '---\ntitle: Plan\n'.length, '---\n');
    expect([...f.host.querySelectorAll('.cm-filo-fm-key')].map((s) => s.textContent)).toEqual(['title']);
    // Breaking the opening fence ends the block.
    type(f.view, 3, 'x');
    expect(f.host.querySelectorAll('.cm-filo-fm')).toHaveLength(0);
  });

  it('never changes the text by itself: Enter on a list item adds no marker', () => {
    const f = field('- one');
    f.view.focus();
    f.view.dispatch({ selection: { anchor: 5 } });
    press(f.view, 'Enter');
    expect(f.editor.text()).toBe('- one\n');
  });
});

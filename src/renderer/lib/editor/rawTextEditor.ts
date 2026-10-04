/**
 * rawTextEditor — the Raw view's text field: the note's whole file as text,
 * in CodeMirror 6.
 *
 * It stays a plain text field. It colours the Markdown, numbers the lines,
 * shows invisible characters (a zero-width space, a stray BOM, a control
 * character), finds inside the note (Ctrl+F) and keeps its own undo, but it
 * never changes the text by itself: no bracket pairing, no list continuation,
 * no completion, no link made from a pasted address, and a file dropped on it
 * isn't read in. Tab leaves the field, as it did from the textarea.
 *
 * Saving stays with NoteRawView (when to save, the base-hash check, the
 * conflict banner, the raw-view registry); this module only reports typing,
 * leaving the field and Ctrl+S.
 *
 * Styling is vanilla CSS in NoteRawView.svelte, over the classes set here
 * (`tok-*` for the Markdown, `cm-filo-*` for the frontmatter and the named
 * line). CodeMirror's own base stylesheet is the library's.
 */
import {
  Annotation,
  Compartment,
  EditorState,
  StateEffect,
  StateField,
  Transaction,
  type Extension,
  type Range,
  type Text,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  type DecorationSet,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { search, searchKeymap } from '@codemirror/search';
import { Language, defineLanguageFacet, languageDataProp, syntaxHighlighting } from '@codemirror/language';
import { parser as commonmark, Strikethrough, Table, TaskList } from '@lezer/markdown';
import { styleTags, tagHighlighter, tags } from '@lezer/highlight';
import { openingFenceEol, splitFrontmatterFence } from '../notes/frontmatterFence';
import { NOTE_EDITOR_ATTRIBUTE } from '../utils/editableTarget';

export interface RawTextEditorOptions {
  /** The text to start with. */
  text: string;
  /** The field's accessible name. */
  label: string;
  /** Whether the text can be edited from the start. */
  editable: boolean;
  /** The text after a change the user made (never after `setText`). */
  onChange(text: string): void;
  /** Focus left the field (its find bar counts as the field). */
  onBlur(): void;
  /** Ctrl+S (Cmd+S) in the field or its find bar. */
  onSave(): void;
}

export interface RawTextEditor {
  /** The whole text. */
  text(): string;
  /**
   * Shows `value`, read from disk, and clears the undo history. An undo step
   * typed before it would be mapped through the new text and, undone, land
   * on text that is no longer there: the field (and the next save) would then
   * hold a mix of both versions. Only the stretch that differs is replaced,
   * so the caret and the scroll stay put. Returns false, and changes nothing,
   * while an IME composition is open.
   */
  setText(value: string): boolean;
  /** True while an IME composition is open. */
  composing(): boolean;
  allowEditing(on: boolean): void;
  setLabel(label: string): void;
  /**
   * Selects line `line` (1-based), scrolls it to about a third of the way
   * down, focuses the field and marks the line until it is edited.
   */
  revealLine(line: number): void;
  /** Brings the field into view and focuses it. */
  focus(): void;
  destroy(): void;
}

/**
 * Markdown as Filo reads it: CommonMark with GFM tables, task lists and
 * strikethrough. No bare-URL links, as Filo's own parser makes none.
 */
const markdownData = defineLanguageFacet({ commentTokens: { block: { open: '<!--', close: '-->' } } });
const markdownLanguage = new Language(
  markdownData,
  commonmark.configure([
    Table,
    TaskList,
    Strikethrough,
    {
      props: [
        languageDataProp.add({ Document: markdownData }),
        // An inline HTML tag is markup, shown like the other markers.
        styleTags({ HTMLTag: tags.processingInstruction }),
      ],
    },
  ]),
  [],
  'markdown',
);

/** Markup reads as markup (`tok-meta`); the words keep the text colour. */
const markdownClasses = tagHighlighter([
  { tag: tags.heading, class: 'tok-heading' },
  { tag: tags.strong, class: 'tok-strong' },
  { tag: tags.emphasis, class: 'tok-emphasis' },
  { tag: tags.strikethrough, class: 'tok-strikethrough' },
  { tag: tags.link, class: 'tok-link' },
  { tag: tags.url, class: 'tok-url' },
  { tag: tags.monospace, class: 'tok-monospace' },
  { tag: tags.quote, class: 'tok-quote' },
  { tag: tags.comment, class: 'tok-comment' },
  {
    tag: [
      tags.processingInstruction,
      tags.contentSeparator,
      tags.atom,
      tags.labelName,
      tags.string,
      tags.escape,
      tags.character,
    ],
    class: 'tok-meta',
  },
]);

// ── The frontmatter block ───────────────────────────────────────────────────

/** How much of the text's start is read to find the block before reading it all. */
const FRONTMATTER_HEAD = 64 * 1024;

const fmBlock = Decoration.mark({ class: 'cm-filo-fm' });
const fmFence = Decoration.mark({ class: 'cm-filo-fm-fence' });
const fmKey = Decoration.mark({ class: 'cm-filo-fm-key' });
/** A mapping key at the start of a line (after any indent or list dash). */
const YAML_KEY = /^([ \t]*(?:-[ \t]+)?)([^\s#:][^:]*?):(?=[ \t]|$)/;

interface FrontmatterMarks {
  /** Where the block ends (0 when there is none). */
  end: number;
  decorations: DecorationSet;
}

/**
 * The block is found by the fence parser the note writer uses, so the Raw
 * view never shows as frontmatter what the writer treats as body.
 */
function frontmatterMarks(doc: Text): FrontmatterMarks {
  let text = doc.sliceString(0, Math.min(doc.length, FRONTMATTER_HEAD));
  let split = splitFrontmatterFence(text);
  // The head may end inside the block, or on a line that only looks like its fence.
  if (text.length < doc.length && (!split.block || split.body === '')) {
    text = doc.toString();
    split = splitFrontmatterFence(text);
  }
  const block = split.block;
  if (!block) return { end: 0, decorations: Decoration.none };
  const start = split.hadBom ? 1 : 0;
  const end = text.length - split.body.length - block.closeEol.length;
  const marks: Array<Range<Decoration>> = [
    fmBlock.range(start, end),
    fmFence.range(start, start + block.open.length),
    fmFence.range(end - block.close.length, end),
  ];
  let at = start + block.open.length + block.openEol.length;
  if (block.source !== '') {
    for (const line of block.source.split('\n')) {
      const key = YAML_KEY.exec(line);
      if (key && key[1] !== undefined && key[2] !== undefined) {
        const from = at + key[1].length;
        marks.push(fmKey.range(from, from + key[2].length));
      }
      at += line.length + 1;
    }
  }
  return { end, decorations: Decoration.set(marks, true) };
}

const frontmatter = StateField.define<FrontmatterMarks>({
  create: (state) => frontmatterMarks(state.doc),
  update(marks, tr) {
    if (!tr.docChanged) return marks;
    if (marks.end > 0) {
      // Text after the block can't move its end.
      let inBlock = false;
      tr.changes.iterChangedRanges((fromA) => {
        if (fromA <= marks.end) inBlock = true;
      });
      if (!inBlock) return { end: tr.changes.mapPos(marks.end), decorations: marks.decorations.map(tr.changes) };
    } else if (openingFenceEol(`${tr.state.doc.line(1).text}\n`) === null) {
      // No block can start without an opening fence on the first line.
      return marks;
    }
    return frontmatterMarks(tr.state.doc);
  },
  provide: (field) => EditorView.decorations.from(field, (marks) => marks.decorations),
});

// ── The named line ("Edit in Raw view") ─────────────────────────────────────

const markLine = StateEffect.define<number>();
const namedLineMark = Decoration.line({ class: 'cm-filo-named-line' });

/** The line "Edit in Raw view" named, marked until an edit touches it. */
const namedLine = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    for (const effect of tr.effects) {
      if (effect.is(markLine)) return Decoration.set([namedLineMark.range(tr.state.doc.lineAt(effect.value).from)]);
    }
    if (!tr.docChanged || marks.size === 0) return marks;
    let edited = false;
    marks.between(0, tr.startState.doc.length, (from) => {
      const line = tr.startState.doc.lineAt(from);
      tr.changes.iterChangedRanges((fromA, toA) => {
        if (fromA <= line.to && toA >= line.from) edited = true;
      });
    });
    return edited ? Decoration.none : marks.map(tr.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

// ── The editor ──────────────────────────────────────────────────────────────

/** Marks the transactions `setText` makes, so they aren't reported as typing. */
const fromDisk = Annotation.define<boolean>();

/** The find bar's words, in the Search panel's terms. */
const PHRASES: Record<string, string> = {
  next: 'Next',
  previous: 'Previous',
  all: 'All',
  'match case': 'Match case',
  regexp: 'Regular expression',
  'by word': 'Whole word',
  replace: 'Replace',
  'replace all': 'Replace all',
  close: 'Close',
};

function editability(on: boolean): Extension {
  return [EditorView.editable.of(on), EditorState.readOnly.of(!on)];
}

function labelled(label: string): Extension {
  return EditorView.contentAttributes.of({ 'aria-label': label });
}

/** The one change that turns `prev` into `next`: the stretch between what they share at each end. */
function changedStretch(prev: string, next: string): { from: number; to: number; insert: string } {
  let from = 0;
  const shorter = Math.min(prev.length, next.length);
  while (from < shorter && prev.charCodeAt(from) === next.charCodeAt(from)) from++;
  let endPrev = prev.length;
  let endNext = next.length;
  while (endPrev > from && endNext > from && prev.charCodeAt(endPrev - 1) === next.charCodeAt(endNext - 1)) {
    endPrev--;
    endNext--;
  }
  return { from, to: endPrev, insert: next.slice(from, endNext) };
}

export function createRawTextEditor(host: HTMLElement, options: RawTextEditorOptions): RawTextEditor {
  const editable = new Compartment();
  const label = new Compartment();
  /** Undo history; taken out and put back to start it empty (`setText`). */
  const undoHistory = new Compartment();

  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: options.text,
      extensions: [
        lineNumbers(),
        highlightSpecialChars(),
        undoHistory.of(history()),
        EditorView.lineWrapping,
        EditorState.tabSize.of(4),
        EditorState.phrases.of(PHRASES),
        search({ top: true }),
        keymap.of([
          {
            key: 'Mod-s',
            scope: 'editor search-panel',
            preventDefault: true,
            run: () => {
              options.onSave();
              return true;
            },
          },
          ...searchKeymap,
          ...historyKeymap,
          ...defaultKeymap,
        ]),
        markdownLanguage,
        syntaxHighlighting(markdownClasses),
        frontmatter,
        namedLine,
        editable.of(editability(options.editable)),
        label.of(labelled(options.label)),
        EditorView.contentAttributes.of({
          spellcheck: 'false',
          autocorrect: 'off',
          autocapitalize: 'off',
          // A read-only view can still be focused, to select, copy and find.
          tabindex: '0',
          // Global shortcuts treat the field as a form field (hotkeys.ts).
          'data-plain-text-field': '',
          // Its text counts as unsaved through the raw-view registry, not by
          // comparing what the field renders (which changes as it scrolls).
          [NOTE_EDITOR_ATTRIBUTE]: 'true',
        }),
        EditorView.domEventHandlers({
          // A dropped file would be read in as text: leave the drop to the app.
          drop: (event) => {
            if (!event.dataTransfer?.files.length) return false;
            event.preventDefault();
            return true;
          },
        }),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          if (update.transactions.every((tr) => !tr.docChanged || tr.annotation(fromDisk))) return;
          options.onChange(update.state.doc.toString());
        }),
      ],
    }),
  });

  // The save starts on the DOM event, as the textarea's did, once focus has
  // left both the text and the find bar.
  const onFocusOut = (event: FocusEvent): void => {
    const next = event.relatedTarget;
    if (next instanceof Node && view.dom.contains(next)) return;
    options.onBlur();
  };
  view.dom.addEventListener('focusout', onFocusOut);

  return {
    text: () => view.state.doc.toString(),
    setText(value) {
      if (view.compositionStarted) return false;
      const current = view.state.doc.toString();
      if (current === value) return true;
      // A field kept in both configurations keeps its value, so the history
      // goes in one transaction and comes back, empty, in the next.
      view.dispatch({
        changes: changedStretch(current, value),
        annotations: [Transaction.addToHistory.of(false), fromDisk.of(true)],
        effects: undoHistory.reconfigure([]),
      });
      view.dispatch({ effects: undoHistory.reconfigure(history()) });
      return true;
    },
    composing: () => view.compositionStarted,
    allowEditing(on) {
      view.dispatch({ effects: editable.reconfigure(editability(on)) });
    },
    setLabel(text) {
      view.dispatch({ effects: label.reconfigure(labelled(text)) });
    },
    revealLine(line) {
      const doc = view.state.doc;
      const target = doc.line(Math.min(Math.max(line, 1), doc.lines));
      view.focus();
      view.dispatch({
        selection: { anchor: target.from, head: target.to },
        effects: [
          markLine.of(target.from),
          EditorView.scrollIntoView(target.from, { y: 'start', yMargin: Math.round(view.scrollDOM.clientHeight / 3) }),
        ],
      });
    },
    focus() {
      view.dom.scrollIntoView({ block: 'nearest' });
      view.focus();
    },
    destroy() {
      view.dom.removeEventListener('focusout', onFocusOut);
      view.destroy();
    },
  };
}

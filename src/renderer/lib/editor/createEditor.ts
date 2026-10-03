import { Editor, Extension, type CommandProps } from '@tiptap/core';
import { StarterKit } from '@tiptap/starter-kit';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Heading } from '@tiptap/extension-heading';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

/**
 * Tiptap commands registered by this app's custom Indent extension. The
 * module augmentation lets `editor.chain().increaseIndent()` typecheck
 * without ad-hoc casts at every call site.
 */
declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    indent: {
      increaseIndent: () => ReturnType;
      decreaseIndent: () => ReturnType;
    };
  }
}
import { Color, FontFamily, TextStyle } from '@tiptap/extension-text-style';
import { Underline } from '@tiptap/extension-underline';
import { Highlight } from '@tiptap/extension-highlight';
import { Image } from '@tiptap/extension-image';
import { Placeholder } from '@tiptap/extensions';
import { TableRow } from '@tiptap/extension-table';
import { TaskItem } from '@tiptap/extension-list';
import { Markdown } from 'tiptap-markdown';
import { common, createLowlight } from 'lowlight';
import { FiloListTight, FiloTaskListTight } from './taskListTight';
import { IndentBackspace, TabKeys } from './tabKeys';
import { NoteText } from './textEscapes';
import { TabChar, withEdgeTabsOutsideRuns } from './tabNode';
import { KeepSpaces } from './keepSpaces';
import { LeadSpace, withLeadSpacesOutsideRuns } from './leadSpace';
import { FiloBulletList, FiloOrderedList } from './listMarkers';
import { FiloTaskList, FiloListParse } from './taskItems';
import { FiloTable, FiloTableCell, FiloTableHeader } from './tableMarkdown';
import { FiloCodeBlock } from './codeFence';
import { FiloHardBreak } from './hardBreak';
import { SoftBreak, SoftBreakEnter, withBreakMarksTrimmed } from './softBreak';
import { PastePlainText } from './pastePlainText';
import { FiloBlockquote } from './blockquote';
import { isFiloLink } from '../../schema/link';
import { blockLayoutHtml, hasBlockLayout } from './blockLayout';
import { FiloTextAlign, ListItemLayout, isListItem } from './listItemLayout';
import { installNoteSerializer } from './delimiterRuns';
import { FiloLink } from './autolinkMarkdown';
import { NOTE_EDITOR_ATTRIBUTE } from '../utils/editableTarget';

const lowlight = createLowlight(common);

/**
 * Custom FontSize extension — uses inline style `font-size` via TextStyle mark.
 *
 * TipTap 3 — `mergeNestedSpanStyles` defaults to `true`, which rewrites nested
 * `<span style>` runs on parse (with `html: true` that is inbound inline HTML
 * in a user's `.md`, so it would drift bytes vs TipTap 2). Kept `false` for
 * parity; pinned by the `inline-html-*` fixtures in markdownBodyRoundTrip.test.ts.
 */
const FontSize = TextStyle.configure({ mergeNestedSpanStyles: false }).extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      fontSize: {
        default: null,
        parseHTML: (el) => el.style.fontSize?.replace(/['"]+/g, '') || null,
        renderHTML: (attrs) => {
          if (!attrs.fontSize) return {};
          return { style: `font-size: ${attrs.fontSize}` };
        },
      },
    };
  },
});

/** Blocks whose lines nest by their own rules, never by the indent attribute. */
const NESTS_ITSELF = new Set(['listItem', 'taskItem', 'tableCell', 'tableHeader']);

/**
 * Indent extension — adds indent attribute (0–8 levels) to paragraph and heading nodes.
 * Renders as margin-left: N * 24px. Works independently of lists.
 */
const Indent = Extension.create({
  name: 'indent',

  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'heading'],
        attributes: {
          indent: {
            default: 0,
            parseHTML: (el) => Math.round(parseInt(el.style.marginLeft || '0') / 24),
            renderHTML: (attrs) =>
              attrs.indent ? { style: `margin-left: ${attrs.indent * 24}px` } : {},
          },
        },
      },
    ];
  },

  addCommands() {
    // Every paragraph and heading the selection touches moves together, so
    // Tab over several lines indents them all, as in a word processor.
    // Lines inside a list or table are left alone: they nest by their own
    // rules, and an indented list line would be saved as an HTML line,
    // turning the Markdown list into HTML.
    const indentDelta = (delta: 1 | -1) =>
      () =>
      ({ tr, state, dispatch }: CommandProps): boolean => {
        const { from, to } = state.selection;
        let found = false;
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (NESTS_ITSELF.has(node.type.name)) return false;
          if (node.type.name !== 'paragraph' && node.type.name !== 'heading') return true;
          found = true;
          const next = Math.max(0, Math.min(8, (node.attrs.indent || 0) + delta));
          if (next !== (node.attrs.indent || 0)) tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: next });
          return false;
        });
        if (found && dispatch) dispatch(tr);
        return found;
      };
    return {
      increaseIndent: indentDelta(1),
      decreaseIndent: indentDelta(-1),
    };
  },
});

/**
 * The slice of `prosemirror-markdown`'s serializer state the empty-paragraph
 * serialiser touches. Typed locally so we don't reach into tiptap-markdown's
 * untyped internals with a cast.
 */
interface MarkdownSerializeState {
  /** Block delimiter prefix — empty at the top level, `> `/indent when nested. */
  delim: string;
  out: string;
  write(content?: string): void;
  flushClose(size?: number): void;
  renderInline(node: ProseMirrorNode, fromBlockStart?: boolean): void;
  closeBlock(node: ProseMirrorNode): void;
}

/**
 * Paragraph with an empty-paragraph-aware Markdown serialiser.
 *
 * A blank paragraph (user pressed Enter on an empty line for vertical spacing)
 * has no Markdown representation, so tiptap-markdown drops it and the spacing
 * disappears on the next round-trip. Here a *top-level* empty paragraph instead
 * emits one extra blank line: we flush the previous block's separator, then add
 * a single newline and deliberately skip `closeBlock` so the following block
 * doesn't add a second separator. The result is clean open-format Markdown
 * (one extra blank line per empty paragraph); `encodeEmptyParagraphs` rebuilds
 * the paragraph on load. See `lib/editor/emptyParagraphs.ts`.
 *
 * Guarded on `!state.delim`: inside a blockquote or list a bare blank line
 * would terminate the container, so nested empty paragraphs fall back to the
 * default (drop) behaviour rather than corrupt the structure.
 */
/**
 * A paragraph opening like an ordered list item with a `)` delimiter. One
 * that opens with a space can't: its line starts with `&#32;` (`leadSpace.ts`).
 */
const ORDERED_PAREN_START = /^(\d{1,9})\)(?=[ \t]|$)/;

const ParagraphWithBlankLines = Paragraph.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state: MarkdownSerializeState, node: ProseMirrorNode, parent: ProseMirrorNode): void {
          if (node.content.size === 0 && !state.delim) {
            state.flushClose(2);
            state.out += '\n';
            return;
          }
          // Never in a list item, where the HTML line would swallow the
          // item's sub-list (`listItemLayout.ts` keeps the layout out).
          if (hasBlockLayout(node) && !isListItem(parent)) {
            state.write(blockLayoutHtml(node));
            state.closeBlock(node);
            return;
          }
          // prosemirror-markdown escapes a leading `1.` but not `1)`, which
          // Markdown also reads as a numbered list item: "1) Buy milk" typed
          // as text would reopen as a list. Write the delimiter as `1\)`.
          const first = node.firstChild;
          const listLike = first?.isText && first.marks.length === 0
            ? ORDERED_PAREN_START.exec(first.text ?? '')
            : null;
          // Start the line now (the blank line and `> ` before a paragraph in
          // a quote). Left to the first write, a bold, italic or strikethrough
          // run opening the paragraph records its start before them, and
          // tiptap-markdown's delimiter tidy then cut into the `>`. An empty
          // paragraph in a quote or list writes nothing, as before.
          if (node.content.size > 0) state.write();
          if (listLike) {
            state.write(`${listLike[1]}\\)`);
            let rest = node.cut(listLike[0].length);
            // The space after `1)` is mid-line, so it is written as a space.
            if (rest.firstChild?.text?.startsWith(' ')) {
              state.write(' ');
              rest = rest.cut(1);
            }
            state.renderInline(withBreakMarksTrimmed(withEdgeTabsOutsideRuns(rest)), false);
          } else {
            state.renderInline(withBreakMarksTrimmed(withLeadSpacesOutsideRuns(withEdgeTabsOutsideRuns(node))));
          }
          state.closeBlock(node);
        },
        parse: {},
      },
    };
  },
});

/**
 * Heading whose alignment and indent are saved: an aligned or indented heading
 * is written as an HTML line (see `blockLayout.ts`), any other as `## text`.
 */
const HeadingWithLayout = Heading.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state: MarkdownSerializeState, node: ProseMirrorNode, parent: ProseMirrorNode): void {
          if (hasBlockLayout(node) && !isListItem(parent)) {
            state.write(blockLayoutHtml(node));
          } else {
            state.write(`${'#'.repeat(Number(node.attrs.level) || 1)} `);
            state.renderInline(withBreakMarksTrimmed(withLeadSpacesOutsideRuns(withEdgeTabsOutsideRuns(node))), false);
          }
          state.closeBlock(node);
        },
        parse: {},
      },
    };
  },
});

export interface TiptapEditorOptions {
  element: HTMLElement;
  content?: string;
  placeholder?: string;
  editable?: boolean;
  onUpdate?: (html: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  onSelectionUpdate?: () => void;
  onTransaction?: () => void;
}

/**
 * Creates a fully configured Tiptap editor with all design-doc extensions.
 */
export function createTiptapEditor(options: TiptapEditorOptions): Editor {
  const editor = new Editor({
    element: options.element,
    content: options.content || '',
    editable: options.editable ?? true,

    editorProps: {
      attributes: {
        spellcheck: 'true',
        // Tells a note editor from a title or label editor (the shutdown
        // report counts a title being typed, and leaves a note to its store).
        [NOTE_EDITOR_ATTRIBUTE]: 'true',
      },
    },

    extensions: [
      StarterKit.configure({
        codeBlock: false, // replaced by FiloCodeBlock (highlighting; fence the code can't close)
        bulletList: false, // replaced by FiloBulletList (keeps adjacent lists apart in the file)
        orderedList: false, // replaced by FiloOrderedList (likewise)
        hardBreak: false, // replaced by FiloHardBreak (`<br>` in a heading)
        blockquote: false, // replaced by FiloBlockquote (no bare `>` line for an empty paragraph)
        paragraph: false, // replaced by ParagraphWithBlankLines (empty-para serialiser)
        heading: false, // replaced by HeadingWithLayout (saves alignment / indent)
        text: false, // replaced by NoteText (keeps a typed `&amp;` as typed)
        // TipTap 3 bundles these into StarterKit. Link + Underline are registered
        // below with Filo's own config (a duplicate registration would shadow it).
        // TrailingNode MUST stay off: it appends an empty paragraph after a doc
        // that ends in a heading / list / table / code block, which
        // ParagraphWithBlankLines serialises as an extra blank line — every such
        // file would silently gain bytes on its next save. Pinned by the
        // `ends-*` fixtures in markdownBodyRoundTrip.test.ts.
        link: false,
        underline: false,
        trailingNode: false,
      }),
      ParagraphWithBlankLines,
      FiloBulletList,
      FiloOrderedList,
      FiloHardBreak,
      SoftBreak,
      SoftBreakEnter,
      FiloBlockquote,
      HeadingWithLayout,
      NoteText,
      FiloTextAlign.configure({
        types: ['heading', 'paragraph'],
        alignments: ['left', 'center', 'right', 'justify'],
      }),
      ListItemLayout,
      FontSize, // custom extension (extends TextStyle)
      Indent,
      Underline,
      Color,
      Highlight.configure({
        multicolor: true,
      }),
      FontFamily,
      FiloLink.configure({
        openOnClick: false,
        HTMLAttributes: { class: 'tiptap-link' },
        // Only an explicit-scheme URL autolinks while typing. Link's default
        // accepts ANY dotted hostname, so typing ` Notes.md ` would save a bogus
        // `[Notes.md](http://Notes.md)`.
        shouldAutoLink: (url: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(url),
        // Allow `filo://` internal links (otherwise setLink silently returns
        // false and notes containing one open read-only). A custom
        // `isAllowedUri`, NOT `protocols: ['filo']`: `protocols` registers with
        // linkifyjs globally and Link's onDestroy `reset()`s linkifyjs, so every
        // TextTile unmount would wipe it for all other editors. `javascript:` etc.
        // are still refused by the default validator.
        isAllowedUri: (url, ctx) => isFiloLink(url) || ctx.defaultValidate(url),
      }),
      Image.configure({
        inline: true,
      }),
      Placeholder.configure({
        // `??` not `||` so an explicit empty string disables the placeholder
        // (the Document board passes '' — see DocumentEditor.svelte).
        placeholder: options.placeholder ?? 'Start typing...',
      }),
      FiloTable.configure({
        resizable: true,
      }),
      TableRow,
      FiloTableHeader,
      FiloTableCell,
      FiloTaskList,
      FiloTaskListTight,
      FiloListParse,
      TaskItem.configure({
        nested: true,
      }),
      FiloCodeBlock.configure({
        lowlight,
      }),
      Markdown.configure({
        // `html: true` lets tiptap-markdown round-trip the marks it has no
        // Markdown token for (underline, text colour, highlight, font family /
        // size) and non-GFM tables (merged or multi-paragraph cells) as inline
        // HTML, parsing that HTML back on load. With `html: false` those marks
        // serialise to empty strings and such a table to the literal `[table]`,
        // destroying every cell's contents on the next write.
        // ProseMirror's schema-constrained parse keeps the inbound HTML safe:
        // unknown nodes/attrs (scripts, event handlers) are dropped, and
        // TextStyle only re-reads colour / fontSize / fontFamily. Alignment and
        // indent are block attributes, saved by the paragraph and heading
        // serialisers as an HTML line (`blockLayout.ts`).
        html: true,
        tightLists: true,
        // `linkify: true` would turn filenames, bare domains and emails in
        // ordinary notes into links, so those notes would round-trip lossy and
        // open read-only. Bare text stays text (KNOWN_LIMITATIONS #17).
        linkify: false,
        breaks: false,
        // A plain-text paste is parsed by `PastePlainText` (HTML off, line
        // breaks kept), not by this parser.
        transformPastedText: false,
        // Copying out puts the text as shown on the clipboard's text/plain
        // (not its Markdown source, `C:\\Users`, `5 \*`); Filo-to-Filo copies
        // keep their formatting through the HTML flavour.
        transformCopiedText: false,
      }),
      PastePlainText,
      // After Markdown: replaces its list `tight` parse rule (see taskListTight.ts).
      FiloListTight,
      KeepSpaces,
      LeadSpace,
      TabChar,
      TabKeys,
      IndentBackspace,
    ],

    onUpdate: ({ editor: e }) => {
      options.onUpdate?.(e.getHTML());
    },

    onFocus: () => {
      options.onFocus?.();
    },

    onBlur: () => {
      options.onBlur?.();
    },

    onSelectionUpdate: () => {
      options.onSelectionUpdate?.();
    },

    onTransaction: () => {
      options.onTransaction?.();
    },
  });

  // Bold, italic and strikethrough that Markdown wouldn't read back are
  // written as HTML (`delimiterRuns.ts`).
  installNoteSerializer(editor);
  return editor;
}

/**
 * Creates a minimal Tiptap editor for connection labels.
 * Supports only inline formatting (bold, italic, underline, color, highlight, font).
 * No block-level formatting (headings, lists, code blocks etc.) to keep labels compact.
 */
export function createLabelEditor(
  options: Pick<
    TiptapEditorOptions,
    'element' | 'content' | 'onUpdate' | 'onFocus' | 'onBlur' | 'onSelectionUpdate' | 'onTransaction'
  >,
): Editor {
  return new Editor({
    element: options.element,
    content: options.content || '<p></p>',
    editorProps: {
      attributes: { spellcheck: 'true', class: 'label-tiptap' },
    },
    extensions: [
      StarterKit.configure({
        heading: false,
        blockquote: false,
        codeBlock: false,
        horizontalRule: false,
        bulletList: false,
        orderedList: false,
        // TipTap 3 StarterKit additions: labels must not auto-link URLs (the
        // label schema had no link mark on TipTap 2), Underline is registered
        // below, and there are no block nodes / lists for TrailingNode /
        // ListKeymap to act on.
        link: false,
        underline: false,
        trailingNode: false,
        listKeymap: false,
      }),
      // FontSize extends TextStyle, so registering FontSize transitively
      // brings the TextStyle mark in — Color / Highlight / FontFamily all
      // ride on top of it.
      FontSize,
      Underline,
      Color,
      Highlight.configure({ multicolor: true }),
      FontFamily,
    ],
    onUpdate: ({ editor: e }) => options.onUpdate?.(e.getHTML()),
    onFocus: () => options.onFocus?.(),
    onBlur: () => options.onBlur?.(),
    onSelectionUpdate: () => options.onSelectionUpdate?.(),
    onTransaction: () => options.onTransaction?.(),
  });
}

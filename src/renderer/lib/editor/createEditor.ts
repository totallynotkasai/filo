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
import { TextAlign } from '@tiptap/extension-text-align';
import { TextStyle } from '@tiptap/extension-text-style';
import { Underline } from '@tiptap/extension-underline';
import { Color } from '@tiptap/extension-color';
import { Highlight } from '@tiptap/extension-highlight';
import { FontFamily } from '@tiptap/extension-font-family';
import { Link } from '@tiptap/extension-link';
import { Image } from '@tiptap/extension-image';
import { Placeholder } from '@tiptap/extension-placeholder';
import { Table } from '@tiptap/extension-table';
import { TableCell } from '@tiptap/extension-table-cell';
import { TableHeader } from '@tiptap/extension-table-header';
import { TableRow } from '@tiptap/extension-table-row';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import { Markdown } from 'tiptap-markdown';
import { common, createLowlight } from 'lowlight';
import { Tag } from './tagExtension';
import { FiloListTight, FiloTaskListTight } from './taskListTight';
import { TabKeys } from './tabKeys';
import { TabChar } from './tabNode';
import { isFiloLink } from '../../schema/link';
import { blockLayoutHtml, hasBlockLayout } from './blockLayout';

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
    const indentDelta = (delta: 1 | -1) =>
      () =>
      ({ tr, state, dispatch }: CommandProps): boolean => {
        const { from, to } = state.selection;
        let found = false;
        state.doc.nodesBetween(from, to, (node, pos) => {
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
const ParagraphWithBlankLines = Paragraph.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state: MarkdownSerializeState, node: ProseMirrorNode): void {
          if (node.content.size === 0 && !state.delim) {
            state.flushClose(2);
            state.out += '\n';
            return;
          }
          if (hasBlockLayout(node)) {
            state.write(blockLayoutHtml(node));
            state.closeBlock(node);
            return;
          }
          state.renderInline(node);
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
        serialize(state: MarkdownSerializeState, node: ProseMirrorNode): void {
          if (hasBlockLayout(node)) {
            state.write(blockLayoutHtml(node));
          } else {
            state.write(`${'#'.repeat(Number(node.attrs.level) || 1)} `);
            state.renderInline(node, false);
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
      },
    },

    extensions: [
      StarterKit.configure({
        codeBlock: false, // replaced by CodeBlockLowlight
        paragraph: false, // replaced by ParagraphWithBlankLines (empty-para serialiser)
        heading: false, // replaced by HeadingWithLayout (saves alignment / indent)
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
      HeadingWithLayout,
      TextAlign.configure({
        types: ['heading', 'paragraph'],
        alignments: ['left', 'center', 'right', 'justify'],
      }),
      FontSize, // custom extension (extends TextStyle)
      Indent,
      Underline,
      Color,
      Highlight.configure({
        multicolor: true,
      }),
      FontFamily,
      Link.configure({
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
      Table.configure({
        resizable: true,
      }),
      TableRow,
      TableHeader,
      TableCell,
      TaskList,
      FiloTaskListTight,
      TaskItem.configure({
        nested: true,
      }),
      CodeBlockLowlight.configure({
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
        transformPastedText: true,
        transformCopiedText: true,
      }),
      // After Markdown: replaces its list `tight` parse rule (see taskListTight.ts).
      FiloListTight,
      Tag,
      TabChar,
      TabKeys,
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
      Tag,
    ],
    onUpdate: ({ editor: e }) => options.onUpdate?.(e.getHTML()),
    onFocus: () => options.onFocus?.(),
    onBlur: () => options.onBlur?.(),
    onSelectionUpdate: () => options.onSelectionUpdate?.(),
    onTransaction: () => options.onTransaction?.(),
  });
}

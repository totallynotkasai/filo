import { Editor, Extension, type CommandProps } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Paragraph from '@tiptap/extension-paragraph';
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
import TextAlign from '@tiptap/extension-text-align';
import TextStyle from '@tiptap/extension-text-style';
import Underline from '@tiptap/extension-underline';
import Color from '@tiptap/extension-color';
import Highlight from '@tiptap/extension-highlight';
import FontFamily from '@tiptap/extension-font-family';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import Table from '@tiptap/extension-table';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TableRow from '@tiptap/extension-table-row';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { Markdown } from 'tiptap-markdown';
import { common, createLowlight } from 'lowlight';
import { Tag } from './tagExtension';

const lowlight = createLowlight(common);

/**
 * Custom FontSize extension — uses inline style `font-size` via TextStyle mark.
 */
const FontSize = TextStyle.extend({
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
    const indentDelta = (delta: 1 | -1) =>
      () =>
      ({ tr, state, dispatch }: CommandProps): boolean => {
        const { $from } = state.selection;
        const node = $from.parent;
        if (node.type.name !== 'paragraph' && node.type.name !== 'heading') return false;
        const min = 0;
        const max = 8;
        const next = Math.max(min, Math.min(max, (node.attrs.indent || 0) + delta));
        if (dispatch)
          dispatch(tr.setNodeMarkup($from.before(), undefined, { ...node.attrs, indent: next }));
        return true;
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
  flushClose(size?: number): void;
  renderInline(node: ProseMirrorNode): void;
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
          state.renderInline(node);
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
      }),
      ParagraphWithBlankLines,
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
      TaskItem.configure({
        nested: true,
      }),
      CodeBlockLowlight.configure({
        lowlight,
      }),
      Markdown.configure({
        html: false,
        tightLists: true,
        linkify: true,
        breaks: false,
        transformPastedText: true,
        transformCopiedText: true,
      }),
      Tag,
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

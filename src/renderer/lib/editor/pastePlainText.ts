/**
 * Pasting plain text (a clipboard with no HTML) into a note.
 *
 * tiptap-markdown's own paste parses the text with the note parser, whose
 * `html: true` (needed to load the marks a note keeps as inline HTML) and
 * reads ordinary text as markup: `List<String>`, `<Enter>` and `<!-- -->`
 * vanish. Filo parses a paste with a second parser instead: the same Markdown
 * rules and extensions, but HTML off (anything tag-like stays text). A single
 * newline becomes a soft break, as it does when the same text is opened from
 * a file: shown as a line break and saved as a bare newline (a hard break
 * would save a backslash at the end of every line). Markdown copied from
 * another app still pastes with its formatting.
 *
 * The paste's own first and last newlines are handled before parsing, as
 * Ctrl+Shift+V handles them. Left in, tiptap-markdown puts them back around
 * the parsed text, where ProseMirror reads them as hard breaks (a stray `\`
 * when saved). Newlines opening the paste are dropped. A newline closing it
 * is a soft break, so typing goes on on the next line, and two or more close
 * the paragraph, as a blank line does.
 *
 * Ctrl+Shift+V pastes the text literally: a paragraph per blank-line-
 * separated block and a soft break per newline, with no Markdown read.
 *
 * Code blocks never reach this: ProseMirror pastes into one as plain text.
 */
import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { DOMParser as ProseMirrorDOMParser, Fragment, Slice, type Node as PMNode, type Schema } from '@tiptap/pm/model';

interface MarkdownParserLike {
  parse(content: string, options?: { inline?: boolean }): string;
}

type MarkdownParserClass = new (
  editor: Editor,
  options: { html: boolean; linkify: boolean; breaks: boolean },
) => MarkdownParserLike;

/**
 * A parser for pastes, built from the class of the note parser tiptap-markdown
 * installed (the package doesn't export it), so every extension's Markdown
 * setup applies to it as well. Null when the editor has none.
 */
function pasteParserFor(editor: Editor): MarkdownParserLike | null {
  const parser = (editor as { storage?: { markdown?: { parser?: object } } }).storage?.markdown?.parser;
  const Parser = parser?.constructor as MarkdownParserClass | undefined;
  return Parser ? new Parser(editor, { html: false, linkify: false, breaks: false }) : null;
}

/**
 * `text` as paragraphs (split on blank lines) holding its lines, joined by
 * soft breaks. Spaces and tabs before a newline are dropped: they show
 * nothing, and two spaces before a soft break read back as a hard break
 * (saved later as `\`). Spaces ending the whole paste stay, as typing goes on
 * after them.
 */
export function literalTextSlice(schema: Schema, text: string): Slice {
  const lineBreak = schema.nodes.softBreak ?? schema.nodes.hardBreak;
  const paragraph = schema.nodes.paragraph;
  if (!paragraph) return Slice.empty;
  const blocks = text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').split(/\n{2,}/);
  const nodes = blocks.map((block) => {
    const inline: PMNode[] = [];
    block.split('\n').forEach((line, i) => {
      // A break opening the paragraph (a stray newline at the start of the
      // paste) shows nothing and would be written as HTML.
      if (i > 0 && inline.length > 0) inline.push(lineBreak ? lineBreak.create() : schema.text(' '));
      if (line) inline.push(schema.text(line));
    });
    return paragraph.create(null, inline);
  });
  return new Slice(Fragment.from(nodes), 1, 1);
}

/** A paste without its opening and closing newlines, and how many closed it. */
export interface PasteEdges {
  body: string;
  newlinesAtEnd: number;
}

/**
 * Splits `text` (any line endings) into the text to parse and its closing
 * newlines. Spaces before a closing newline go with it: kept, they would sit
 * before the soft break, and two of them read back as a hard break.
 */
export function pasteEdges(text: string): PasteEdges {
  const lf = text.replace(/\r\n?/g, '\n');
  let start = 0;
  while (lf[start] === '\n') start++;
  let end = lf.length;
  let newlinesAtEnd = 0;
  while (end > start && /[ \t\n]/.test(lf[end - 1] ?? '')) {
    if (lf[end - 1] === '\n') newlinesAtEnd++;
    end--;
  }
  // Spaces closing the paste with no newline after them are part of the text.
  if (newlinesAtEnd === 0) end = lf.length;
  return { body: lf.slice(start, end), newlinesAtEnd };
}

/**
 * `slice` closed by `newlines` newlines: one is a soft break at the end of its
 * text, two or more close its paragraph (the text after the paste then starts
 * a new one). Only a paste that ends in paragraph text takes them; one that
 * ends in a list, quote, heading or code keeps them closing that block.
 */
function closeWithNewlines(schema: Schema, slice: Slice, newlines: number): Slice {
  const { paragraph, softBreak } = schema.nodes;
  const last = slice.content.lastChild;
  if (newlines === 0 || !paragraph || !softBreak || !last) return slice;
  if (newlines >= 2) {
    const endsInText = (slice.openEnd === 0 && last.isInline) || (slice.openEnd === 1 && last.type === paragraph);
    return endsInText ? new Slice(slice.content.addToEnd(paragraph.create()), slice.openStart, 1) : slice;
  }
  if (slice.openEnd === 0 && last.isInline) {
    return new Slice(slice.content.addToEnd(softBreak.create()), slice.openStart, 0);
  }
  if (slice.openEnd === 1 && last.type === paragraph) {
    const closed = last.copy(last.content.addToEnd(softBreak.create()));
    return new Slice(slice.content.replaceChild(slice.content.childCount - 1, closed), slice.openStart, 1);
  }
  return slice;
}

function htmlBody(html: string): HTMLElement {
  return new window.DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body;
}

export const PastePlainText = Extension.create({
  name: 'filoPastePlainText',

  addProseMirrorPlugins() {
    const editor = this.editor;
    let parser: MarkdownParserLike | null = null;
    return [
      new Plugin({
        key: new PluginKey('filoPastePlainText'),
        props: {
          clipboardTextParser: (text, $context, plainText) => {
            if (plainText) return literalTextSlice(editor.schema, text);
            parser ??= pasteParserFor(editor);
            const { body, newlinesAtEnd } = pasteEdges(text);
            if (!parser || !body) return literalTextSlice(editor.schema, text);
            const slice = ProseMirrorDOMParser.fromSchema(editor.schema).parseSlice(htmlBody(parser.parse(body, { inline: true })), {
              preserveWhitespace: true,
              context: $context,
            });
            return closeWithNewlines(editor.schema, slice, newlinesAtEnd);
          },
        },
      }),
    ];
  },
});

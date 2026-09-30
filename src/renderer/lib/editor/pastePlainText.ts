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

/** `text` as paragraphs (split on blank lines) holding its lines, joined by soft breaks. */
export function literalTextSlice(schema: Schema, text: string): Slice {
  const lineBreak = schema.nodes.softBreak ?? schema.nodes.hardBreak;
  const paragraph = schema.nodes.paragraph;
  if (!paragraph) return Slice.empty;
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n{2,}/);
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
            if (!parser) return literalTextSlice(editor.schema, text);
            return ProseMirrorDOMParser.fromSchema(editor.schema).parseSlice(htmlBody(parser.parse(text, { inline: true })), {
              preserveWhitespace: true,
              context: $context,
            });
          },
        },
      }),
    ];
  },
});

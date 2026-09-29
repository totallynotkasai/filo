import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

/**
 * How a code block is fenced in the file.
 *
 * tiptap-markdown always fenced with three backticks, so code holding a line
 * of three backticks (a Markdown example, say) closed the block early and
 * the rest of the note reopened changed. A line of backticks alone closes a
 * fence only when it is at least as long as the opening one, so the fence is
 * one longer than the longest such line in the code, and never shorter than
 * three. Code without one keeps the usual three.
 */

/** A line that could close a backtick fence: up to three spaces, backticks, then only whitespace. */
const CLOSING_LINE = /^ {0,3}(`{3,})[ \t]*$/gm;

/** The backtick fence that `code` can't close early. */
export function codeFenceFor(code: string): string {
  let longest = 0;
  for (const match of code.matchAll(CLOSING_LINE)) longest = Math.max(longest, match[1]?.length ?? 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

interface CodeSerializeState {
  write(content?: string): void;
  text(text: string, escape?: boolean): void;
  ensureNewLine(): void;
  closeBlock(node: ProseMirrorNode): void;
}

interface MarkdownItOptionsHost {
  set(options: { langPrefix: string }): void;
}

/**
 * Code block fenced by `codeFenceFor`. The parse half repeats
 * tiptap-markdown's own, which naming `markdown` here would otherwise drop.
 */
export const FiloCodeBlock = CodeBlockLowlight.extend({
  addStorage() {
    return {
      ...this.parent?.(),
      markdown: {
        serialize(state: CodeSerializeState, node: ProseMirrorNode): void {
          const fence = codeFenceFor(node.textContent);
          const language: unknown = node.attrs.language;
          state.write(`${fence}${typeof language === 'string' ? language : ''}\n`);
          state.text(node.textContent, false);
          state.ensureNewLine();
          state.write(fence);
          state.closeBlock(node);
        },
        parse: {
          setup(this: { options: { languageClassPrefix?: string } }, md: MarkdownItOptionsHost): void {
            md.set({ langPrefix: this.options.languageClassPrefix ?? 'language-' });
          },
          updateDOM(element: Element): void {
            element.innerHTML = element.innerHTML.replace(/\n<\/code><\/pre>/g, '</code></pre>');
          },
        },
      },
    };
  },
});

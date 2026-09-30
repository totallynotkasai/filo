import { InputRule, isNodeActive, type CommandProps } from '@tiptap/core';
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { softBreaksAsHardBreaks } from './softBreak';

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

/** Soft breaks in every block the selection touches kept as lines once the blocks become code. */
function keepLinesIn(tr: Transaction): void {
  for (const range of tr.selection.ranges) softBreaksAsHardBreaks(tr, range.$from.pos, range.$to.pos);
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

/** Typing ```` ``` ```` or `~~~` (and a language) then a space at the start of a line makes it code. */
const FENCE_TYPED = [/^```([a-z]+)?[\s\n]$/, /^~~~([a-z]+)?[\s\n]$/];

/**
 * Code block fenced by `codeFenceFor`. The parse half repeats
 * tiptap-markdown's own, which naming `markdown` here would otherwise drop.
 *
 * Making a paragraph into code keeps its soft breaks as new lines of code
 * (`softBreaksAsHardBreaks`), from the toolbar, Ctrl+Alt+C or a typed fence.
 */
export const FiloCodeBlock = CodeBlockLowlight.extend({
  addCommands() {
    return {
      ...this.parent?.(),
      setCodeBlock:
        (attributes?: { language: string }) =>
        ({ tr, dispatch, commands }: CommandProps): boolean => {
          if (dispatch) keepLinesIn(tr);
          return commands.setNode(this.name, attributes);
        },
      toggleCodeBlock:
        (attributes?: { language: string }) =>
        ({ state, tr, dispatch, commands }: CommandProps): boolean => {
          // Toggling code off leaves a paragraph, whose line breaks stay as they are.
          if (dispatch && !isNodeActive(state, this.type, attributes ?? {})) keepLinesIn(tr);
          return commands.toggleNode(this.name, 'paragraph', attributes);
        },
    };
  },

  addInputRules() {
    return FENCE_TYPED.map(
      (find) =>
        new InputRule({
          find,
          handler: ({ state, range, match }) => {
            // As TipTap's own rule: only where a code block may stand.
            const $start = state.doc.resolve(range.from);
            if (!$start.node(-1).canReplaceWith($start.index(-1), $start.indexAfter(-1), this.type)) return null;
            state.tr.delete(range.from, range.to);
            softBreaksAsHardBreaks(state.tr, range.from, range.from);
            state.tr.setBlockType(range.from, range.from, this.type, { language: match[1] });
          },
        }),
    );
  },

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

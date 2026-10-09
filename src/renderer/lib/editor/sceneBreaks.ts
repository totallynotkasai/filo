import { Extension, InputRule } from '@tiptap/core';
import { Fragment, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import { closeHistory } from '@tiptap/pm/history';
import { TextSelection, type EditorState } from '@tiptap/pm/state';
import { isolateSelectedLines, splitsAtLines } from './lineBlocks';

/**
 * Scene breaks and other lines typed as text, as Enter leaves them.
 *
 * TipTap runs every input rule on Enter too, as if a newline had been typed,
 * and the heading, list and quote rules end in `\s`, which a newline matches.
 * So a lone `#` (the manuscript scene break) and Enter made an empty heading
 * that took the next line, `>` and Enter made a quote, and `-` and Enter a
 * list. Those rules now fire only on the space typed after their marker, as
 * in a word processor.
 *
 * A scene break typed on a line of its own becomes a horizontal rule on
 * Enter: a lone `#`, and the spaced forms `* * *`, `- - -` and `_ _ _`. For
 * `* * *` and `- - -` the first `* ` or `- ` has already made a bullet list
 * holding `* *`, so a one-item bullet list holding only that is the same
 * break. (`***`, `---` and `___` already were: the horizontal rule's own
 * input rule.)
 */

/** A paragraph's text that is a scene break: a lone `#`, or a thematic break written with spaces. */
const SCENE_BREAK_LINE = /^[ \t]*(?:#|([-*_])(?:[ \t]*\1){2,})[ \t]*$/;

/** A bullet item's text after its own marker: the rest of `* * *` or `- - -`. */
const SCENE_BREAK_ITEM = /^[ \t]*([-*])(?:[ \t]*\1)+[ \t]*$/;

/**
 * A three-digit number or longer: a year opening a sentence ("1984. It was a
 * bright cold day"), not a list's start.
 */
// DECISION: typed numbers of one or two digits start a numbered list; a list
// starting at 100 or more is made with the toolbar's Numbered button.
const YEAR_LIKE = /\d{3}/;

/**
 * `rules` firing only on typed text, never on Enter: each pattern refuses text
 * ending in the newline Enter is run as, and text `refuse` matches at its
 * start. A pattern's groups are kept, which the rules read their level or
 * start number from. Each rule also fires at the start of a soft-broken line
 * (`atLineStart`).
 */
export function typedOnly(rules: readonly InputRule[], refuse?: RegExp): InputRule[] {
  return rules.flatMap((rule) => {
    const find = rule.find;
    if (!(find instanceof RegExp)) return [rule];
    const refused = refuse ? `(?!${refuse.source})` : '';
    const typed = new InputRule({
      find: new RegExp(`(?![\\s\\S]*\\n$)${refused}(?:${find.source})`, find.flags),
      handler: rule.handler,
      undoable: rule.undoable,
    });
    const lineStart = atLineStart(rule, find, refused);
    return lineStart ? [typed, lineStart] : [typed];
  });
}

/**
 * `rule` for its marker typed at the start of a line joined to the one above
 * by a soft break (a note from Keep, a plain-text paste, an agent).
 *
 * TipTap matches a rule against the block's text from its start to the caret,
 * where a soft break reads as a newline, so a rule anchored at the block's
 * start never fired there: `- ` stayed text, saved `\- `. This one matches
 * after the block's last newline instead and, on a soft break only, makes the
 * caret's line a block of its own first, as the toolbar does
 * (`isolateSelectedLines`); then the rule acts on that block. The split is in
 * the rule's own transaction, so Backspace straight after (TipTap's undo of an
 * input rule) or Ctrl+Z gives back the typed marker with the lines joined.
 *
 * A hard break (Shift+Enter, which also reads as a newline) and a list item or
 * table cell, where a split would change the list or the table, leave the
 * marker as text, as before.
 */
function atLineStart(rule: InputRule, find: RegExp, refused: string): InputRule | null {
  if (!find.source.startsWith('^')) return null;
  return new InputRule({
    // After a newline, with none from the match on: the caret's line only.
    find: new RegExp(`(?<=\\n)(?![\\s\\S]*\\n)${refused}(?:${find.source.slice(1)})`, find.flags),
    handler: (props) => {
      const { state, range } = props;
      const tr = state.tr;
      const $start = tr.doc.resolve(range.from);
      if ($start.nodeBefore?.type.name !== 'softBreak' || !splitsAtLines($start)) return null;
      const before = tr.steps.length;
      isolateSelectedLines(tr);
      const split = tr.mapping.slice(before);
      // The rule's state reads the split document once its `tr` is read again.
      void state.tr;
      const steps = tr.steps.length;
      const done = rule.handler({ ...props, range: { from: split.map(range.from), to: split.map(range.to) } });
      // A rule that changed nothing leaves no split behind: the marker stays text.
      return done === null || tr.steps.length === steps ? null : done;
    },
    undoable: rule.undoable,
  });
}

/** The numbered list's rules: typed only, and never from a year. */
export function typedOrderedListRules(rules: readonly InputRule[]): InputRule[] {
  return typedOnly(rules, YEAR_LIKE);
}

/**
 * Where a scene break typed at the caret sits: the block it replaces, or null
 * when the caret isn't at the end of one.
 */
function sceneBreakBlock(state: EditorState): { depth: number } | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const { $from } = selection;
  const block = $from.parent;
  if (block.type.name !== 'paragraph' || $from.parentOffset !== block.content.size) return null;
  const text = block.textContent;
  if (SCENE_BREAK_LINE.test(text)) return { depth: $from.depth };
  // The rest of `* * *` in the one item of a bullet list the first `* ` made.
  const item = $from.depth >= 2 ? $from.node($from.depth - 1) : null;
  const list = $from.depth >= 2 ? $from.node($from.depth - 2) : null;
  if (
    item?.type.name === 'listItem' && item.childCount === 1 &&
    list?.type.name === 'bulletList' && list.childCount === 1 &&
    SCENE_BREAK_ITEM.test(text)
  ) {
    return { depth: $from.depth - 2 };
  }
  return null;
}

export const SceneBreakEnter = Extension.create({
  name: 'filoSceneBreakEnter',
  // Ahead of the input rules, which also act on Enter.
  priority: 1000,

  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        const { state } = editor;
        const at = sceneBreakBlock(state);
        const { horizontalRule, paragraph } = state.schema.nodes;
        if (!at || !horizontalRule || !paragraph) return false;
        const $from = state.selection.$from;
        const container = $from.node(at.depth - 1);
        const index = $from.index(at.depth - 1);
        const replacement = Fragment.from([horizontalRule.create(), paragraph.create()]);
        if (!container.canReplace(index, index + 1, replacement)) return false;
        const from = $from.before(at.depth);
        const to = $from.after(at.depth);
        // Its own undo step, as an input rule's is: Ctrl+Z puts the typed line back.
        const tr = closeHistory(state.tr).replaceWith(from, to, replacement);
        const rule: ProseMirrorNode | null | undefined = tr.doc.nodeAt(from);
        tr.setSelection(TextSelection.create(tr.doc, from + (rule?.nodeSize ?? 1) + 1));
        editor.view.dispatch(tr.scrollIntoView());
        return true;
      },
    };
  },
});

import { CommandManager, type Command, type CommandProps } from '@tiptap/core';
import { Mark, type Node as ProseMirrorNode, type ResolvedPos } from '@tiptap/pm/model';
import { EditorState, Selection, TextSelection, type Transaction } from '@tiptap/pm/state';
import { canSplit } from '@tiptap/pm/transform';

/**
 * A block command acts on the lines it is given, not on the lines joined to
 * them by soft breaks.
 *
 * A note written one line per thought (Keep, Canvas, a plain-text paste, an
 * agent) loads as one paragraph whose lines are joined by soft breaks
 * (`softBreak.ts`), and paragraphs stand with no gap between them, so each
 * of those lines looks like a paragraph of its own. Heading 3 on what looked
 * like one line made all nineteen lines of such a block a heading. Before
 * Heading, Normal text, Align, Indent, Quote or a list button acts, the block
 * is split at the soft breaks just outside the selection: the selected lines
 * become a block of their own, of the same kind, and the lines around them
 * keep their form. It is one step with the command, so one undo puts the
 * block back.
 *
 * DECISION: only soft breaks split. A hard break (Shift+Enter) is a line
 * break the writer put inside one paragraph on purpose, and a paragraph
 * style takes the whole paragraph, as in a word processor. Soft breaks
 * between the selected lines stay too: they are one selection, so one block.
 */

/**
 * Containers whose paragraphs a command never splits: in a list item a split
 * would make the item two paragraphs (and the list loose), and a table cell
 * with two paragraphs turns its table into HTML.
 */
const KEEPS_BLOCKS_WHOLE: ReadonlySet<string> = new Set(['listItem', 'taskItem', 'tableCell', 'tableHeader']);

/** True for a block whose lines a command takes apart: a paragraph or heading outside those containers. */
function splitsAtLines($pos: ResolvedPos): boolean {
  const name = $pos.parent.type.name;
  if (name !== 'paragraph' && name !== 'heading') return false;
  for (let d = $pos.depth - 1; d > 0; d--) {
    if (KEEPS_BLOCKS_WHOLE.has($pos.node(d).type.name)) return false;
  }
  return true;
}

/** The last soft break in `$pos`'s block that ends at or before it (the start of its line). */
function breakBefore($pos: ResolvedPos): number | null {
  let found: number | null = null;
  $pos.parent.forEach((child, offset) => {
    const at = $pos.start() + offset;
    if (child.type.name === 'softBreak' && at < $pos.pos) found = at;
  });
  return found;
}

/** The first soft break in `$pos`'s block at or after it (the end of its line). */
function breakAfter($pos: ResolvedPos): number | null {
  let found: number | null = null;
  $pos.parent.forEach((child, offset) => {
    const at = $pos.start() + offset;
    if (found === null && child.type.name === 'softBreak' && at >= $pos.pos) found = at;
  });
  return found;
}

/** In `tr`, the soft break at `at` becomes a boundary between two blocks of its block's kind. */
function splitAt(tr: Transaction, at: number): boolean {
  if (!canSplit(tr.doc, at, 1)) return false;
  tr.delete(at, at + 1);
  tr.split(at, 1);
  return true;
}

/**
 * The selected lines, from the start of the first to the end of the last: a
 * line of a soft-broken paragraph or heading ends at a soft break, any other
 * block's lines at the block's ends.
 */
export function selectedLines(selection: Selection): { from: number; to: number } {
  const { $from, $to } = selection;
  const before = splitsAtLines($from) ? breakBefore($from) : null;
  const after = splitsAtLines($to) ? breakAfter($to) : null;
  return {
    from: before === null ? $from.start() : before + 1,
    to: after === null ? $to.end() : after,
  };
}

/**
 * In `tr`, makes the lines a text selection covers a block of their own: the
 * block is split at the soft break before the first line and after the last.
 * The selection keeps its text. Returns the boundaries made, as positions
 * between two blocks, last first.
 */
export function isolateSelectedLines(tr: Transaction): number[] {
  const { selection } = tr;
  if (!(selection instanceof TextSelection)) return [];
  const { $from, $to, anchor, head } = selection;
  const after = splitsAtLines($to) ? breakAfter($to) : null;
  const before = splitsAtLines($from) ? breakBefore($from) : null;
  const boundaries: number[] = [];
  // The later break first: a split there moves nothing before it.
  if (after !== null && splitAt(tr, after)) boundaries.push(after + 1);
  // A break (one position) becomes a boundary (two), so what follows it moves on by one.
  let shift = 0;
  if (before !== null && splitAt(tr, before)) {
    shift = 1;
    for (let i = 0; i < boundaries.length; i++) boundaries[i] = boundaries[i]! + 1;
    boundaries.push(before + 1);
  }
  if (boundaries.length > 0) tr.setSelection(TextSelection.create(tr.doc, anchor + shift, head + shift));
  return boundaries;
}

/** A block's attribute as it shows: alignment `left` is what no alignment shows (and is saved as). */
function shownAttr(name: string, value: unknown): unknown {
  return name === 'textAlign' && value === 'left' ? null : value;
}

/** True when two blocks show alike: the same kind, attributes and marks. */
function alike(a: ProseMirrorNode, b: ProseMirrorNode): boolean {
  if (a.type !== b.type || !Mark.sameSet(a.marks, b.marks)) return false;
  return Object.keys(a.attrs).every((name) => shownAttr(name, a.attrs[name]) === shownAttr(name, b.attrs[name]));
}

/**
 * In `tr`, joins back each boundary (last first) where the blocks either side
 * are still alike, with the soft break it was. A command that changed nothing
 * (Normal text on a paragraph, Align Left on a line already left, Shift+Tab on
 * a line with no indent) then leaves the lines as they were in the file.
 */
function rejoinAlike(tr: Transaction, boundaries: readonly number[]): void {
  const softBreak = tr.doc.type.schema.nodes.softBreak;
  if (!softBreak) return;
  for (const at of boundaries) {
    const $at = tr.doc.resolve(at);
    const { nodeBefore, nodeAfter } = $at;
    if (!nodeBefore?.isTextblock || !nodeAfter?.isTextblock || !alike(nodeBefore, nodeAfter)) continue;
    tr.join(at);
    tr.insert(at - 1, softBreak.create());
  }
}

/**
 * `command` acting on the selected lines alone (see above). Only a run that
 * changes the note splits: a `can()` check sees the block as it is. The
 * commands wrapped always apply to a paragraph or heading outside lists and
 * tables, the only blocks split, so a split never lands without them, and a
 * split the command leaves alike on both sides is joined again.
 */
export function onLinesAlone<Args extends unknown[]>(
  command: ((...args: Args) => Command) | undefined,
): (...args: Args) => Command {
  return (...args: Args) => (props: CommandProps): boolean => {
    if (!command) return false;
    if (!props.dispatch) return command(...args)(props);
    const { tr, editor } = props;
    const boundaries = isolateSelectedLines(tr);
    if (boundaries.length === 0) return command(...args)(props);
    // The command runs on a transaction of its own over the split document,
    // as it would on a note that held the line as its own block. In the
    // shared transaction TipTap's `clearNodes` (setNode's fallback, when the
    // line already has the kind asked for) maps positions it reads from the
    // split document through the split's steps a second time, and lands in
    // the wrong block.
    const ownState = EditorState.create({ doc: tr.doc, selection: tr.selection, storedMarks: tr.storedMarks });
    const own = ownState.tr;
    const done = command(...args)(new CommandManager({ editor, state: ownState }).buildProps(own));
    for (const step of own.steps) tr.step(step);
    if (own.selectionSet) tr.setSelection(Selection.fromJSON(tr.doc, own.selection.toJSON()));
    if (own.storedMarksSet) tr.setStoredMarks(own.storedMarks);
    if (own.scrolledIntoView) tr.scrollIntoView();
    // Mapped back to the side they stood on, so a block the command wrapped
    // (a list, a quote) isn't taken for its neighbour.
    rejoinAlike(tr, boundaries.map((b) => own.mapping.map(b, -1)));
    // TipTap's command state takes the transaction's doc and selection only
    // when its `tr` is read, and later commands in the chain read them.
    void props.state.tr;
    return done;
  };
}

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fc from 'fast-check';
import type { Editor, JSONContent } from '@tiptap/core';
import type { Mark, Node as ProseMirrorNode, Schema } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { createTiptapEditor } from '../../renderer/lib/editor/createEditor';
import { editorMarkdown, loadMarkdownIntoEditor } from '../../renderer/lib/editor/markdownSync';
import { withMinimalEscapes, type MarkdownRenderer } from '../../renderer/lib/editor/minimalEscapes';
import { isLineBreak } from '../../renderer/lib/editor/softBreak';

/**
 * Whatever the editor can hold, it writes in a form it reads back.
 *
 * A note Filo writes and then can't read back to the same document opens
 * read-only (the load's round-trip check flags it lossy), or, worse, reopens
 * editable as a different note (stray asterisks, a list merged into text)
 * with nothing to say so. The chosen-string suites
 * (`markdownBodyRoundTrip`, `toolbarFormattingRoundTrip`, `editorEditsReadBack`)
 * only reach the shapes someone thought of; this test generates documents
 * from the editor's own schema (paragraphs and headings, aligned and
 * indented; the three list kinds, numbered ones starting anywhere; tables,
 * code, quotes, rules; up to three marks on a run, bold, italic and
 * strikethrough over punctuation too; marks on line breaks; soft and hard
 * breaks; links and autolinks with awkward addresses; lines that look like
 * list items or headings; literal `*` / `_` runs, awkward characters) and
 * checks, for each:
 *
 *   serialise(doc) → load → not lossy, serialise(reloaded) === serialise(doc),
 *   and the reloaded document shows what the generated one did.
 *
 * "Shows the same" (`shownDocument`) sets aside only what the file can't
 * say and the editor doesn't show: a mark on a line break, the editor-only
 * link attributes, spellings of the same colour or default attribute, and a
 * list's tight / loose spacing (a list Markdown can't hold tight is written
 * loose on purpose, `listMarkers.ts`).
 *
 * A second part runs the editor's list, table and line-break commands inside
 * a paragraph, a list item, a table cell and a heading, then checks the same.
 *
 * Out of the generator on purpose: whitespace at the end of a line (Markdown
 * drops it, it shows nothing, and the lossy check ignores it); a line break
 * as the last thing in a block (it shows nothing either, and isn't written);
 * whitespace at the edge of a bold, italic or strikethrough run (written
 * outside it: a formatted space shows nothing); alignment or indent in a list
 * item (the editor clears it there, `listItemLayout.ts`). Two known gaps a
 * fix will add back: a bare URL as the last word of the note's first block
 * (the load turns it into a link) and a numbered list starting at 0 (saved as
 * starting at 1). Every counter-example found while
 * fixing is kept as a named case in `markdownBodyRoundTrip.test.ts` or
 * `editorEditsReadBack.test.ts`.
 *
 * Pinned by the `editor-round-trip-property` gate (exists, not skipped,
 * compares documents, at least 500 runs).
 */

const NUM_RUNS = 500;
const SEED = 20260930;

let writer: Editor;
let reader: Editor;
let schema: Schema;

function makeEditor(): Editor {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return createTiptapEditor({ element: el, content: '' });
}

beforeAll(() => {
  writer = makeEditor();
  reader = makeEditor();
  schema = writer.schema;
  // The first load registers every extension's Markdown setup on the parser.
  loadMarkdownIntoEditor(writer, 'x');
});

afterAll(() => {
  writer.destroy();
  reader.destroy();
});

/** `doc` as a save writes it (`editorMarkdown`: the serialiser, then only the escapes the parser needs). */
function serialise(doc: ProseMirrorNode): string {
  const storage = writer.storage as unknown as {
    markdown: { serializer: { serialize(n: ProseMirrorNode): string }; parser: { md: MarkdownRenderer } };
  };
  return withMinimalEscapes(storage.markdown.serializer.serialize(doc), storage.markdown.parser.md);
}

interface RoundTrip {
  md: string;
  lossy: boolean;
  again: string;
  doc: JSONContent;
}

/** Loads `md` the way a note opens: into an empty editor. */
function roundTrip(md: string): RoundTrip {
  reader.commands.clearContent();
  const { lossy } = loadMarkdownIntoEditor(reader, md);
  return { md, lossy, again: editorMarkdown(reader), doc: reader.getJSON() };
}

// ── What the note shows ──────────────────────────────────────────────────────

/** Attributes the file doesn't hold and the note doesn't show: a list's spacing, and the link's rendering attributes. */
const UNSHOWN_ATTRS: ReadonlySet<string> = new Set(['tight', 'target', 'rel', 'class']);

/** An attribute value in one spelling: a colour as `#rrggbb`, a default as absent. */
function shownAttr(key: string, value: unknown): unknown {
  if (value === null || value === undefined || value === '') return undefined;
  if (key === 'textAlign' && value === 'left') return undefined;
  if (key === 'indent' && value === 0) return undefined;
  if ((key === 'colspan' || key === 'rowspan') && value === 1) return undefined;
  if (typeof value === 'string') {
    const rgb = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(value);
    if (rgb) return `#${rgb.slice(1).map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
  }
  return value;
}

/** A node's or mark's attributes in one spelling, without those not shown; undefined when none are left. */
function shownAttrs(attrs: Record<string, unknown> | undefined, blank = false): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs ?? {})) {
    const shown = UNSHOWN_ATTRS.has(k) || (blank && (k === 'textAlign' || k === 'indent')) ? undefined : shownAttr(k, v);
    if (shown !== undefined) out[k] = shown;
  }
  return Object.keys(out).length ? out : undefined;
}

type MarkJson = NonNullable<JSONContent['marks']>[number];

/**
 * `node` (a document's JSON) as the note shows it: marks on line breaks
 * dropped, a lead space as the space it is, adjacent text with the same
 * marks joined, a paragraph of one space as empty, and attributes in one
 * spelling (see `UNSHOWN_ATTRS`).
 */
function shownDocument(node: JSONContent): JSONContent {
  const out: JSONContent = { type: node.type === 'leadSpace' ? 'text' : node.type };
  if (node.type === 'leadSpace') out.text = ' ';
  if (node.text !== undefined) out.text = node.text;
  if (node.type !== 'leadSpace') {
    // An empty paragraph is a blank line in the file; aligned or indented, it shows nothing.
    const attrs = shownAttrs(node.attrs, node.type === 'paragraph' && !node.content?.length);
    if (attrs) out.attrs = attrs;
  }
  if (node.marks?.length && node.type !== 'softBreak' && node.type !== 'hardBreak') {
    out.marks = node.marks
      .map((m): MarkJson => {
        const attrs = shownAttrs(m.attrs);
        return attrs ? { type: m.type, attrs } : { type: m.type };
      })
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (node.content) {
    const kids: JSONContent[] = [];
    for (const child of node.content.map(shownDocument)) {
      const prev = kids[kids.length - 1];
      if (prev?.type === 'text' && child.type === 'text' && JSON.stringify(prev.marks ?? []) === JSON.stringify(child.marks ?? [])) {
        prev.text = (prev.text ?? '') + (child.text ?? '');
      } else {
        kids.push(child);
      }
    }
    // An empty list item that starts a list under a line of text is written
    // with one space (`- &#32;`, `listMarkers.ts`), which reads back as a space.
    const onlySpace = out.type === 'paragraph' && kids.length === 1 && kids[0]?.type === 'text' && kids[0].text === ' ' && !kids[0].marks;
    // A quote or list item has no line for an empty paragraph after its first
    // block (a bare `>` would end the quote, a blank line the item), so it is
    // left out (`blockquote.ts`, `createEditor.ts`).
    const container = out.type === 'blockquote' || out.type === 'listItem' || out.type === 'taskItem';
    const shown = container
      ? kids.filter((k, i) => !(k.type === 'paragraph' && !k.content && (i > 0 || out.type === 'blockquote')))
      : kids;
    if (shown.length && !onlySpace) out.content = shown;
  }
  return out;
}

// ── Generators ───────────────────────────────────────────────────────────────

/** Characters that mean something in Markdown, plus plain letters and spaces. */
const CHARS = [
  'a', 'b', 'c', 'x', 'y', 'z', ' ', ' ', ' ',
  '|', '`', '*', '_', '[', ']', '\\', '<', '>', '&', '#', '1', '2', '.', ')', '-', '+', '!', '~', '(', ';', '=',
  ',', ':', '"', "'", '?', '—',
];

/** Literal delimiter runs other apps write in plain text (`2** - notes`, `the *** and`, `the ___ and`). */
const DELIMITER_TEXT = ['**', ' ** ', '***', ' *** ', '___', ' ___ ', '2** -', 'a * b', '*a', 'b_'];

/** Text that reads as a list item, heading or quote where it opens a line. */
const LINE_START_TEXT = ['01. Arrival', '001) x', '1. one', '1) one', '02. two', '3. three', '- dash', '+ plus', '# hash', '> quote'];

/** Link addresses Markdown has to escape or bracket with care. */
const HREFS = [
  'https://example.com/a',
  'https://en.wikipedia.org/wiki/A_(b)',
  'https://x.com/?q=a&b=c',
  'https://x.com/a*b_c',
  'filo://create-tile/My%20idea',
  'mailto:a@b.co',
];

const textArb = fc.oneof(
  { weight: 6, arbitrary: fc.array(fc.constantFrom(...CHARS), { minLength: 1, maxLength: 8 }).map((cs) => cs.join('')) },
  { weight: 1, arbitrary: fc.constantFrom(...DELIMITER_TEXT) },
  { weight: 1, arbitrary: fc.constantFrom(...LINE_START_TEXT) },
);

type MarkName = 'bold' | 'italic' | 'strike' | 'code' | 'link' | 'underline' | 'color' | 'highlight';
const MARK_NAMES: MarkName[] = ['bold', 'italic', 'strike', 'code', 'link', 'underline', 'color', 'highlight'];
const markNameArb = fc.subarray<MarkName>(MARK_NAMES, { maxLength: 3 });

type InlineItem =
  | { kind: 'text'; text: string; marks: MarkName[]; href: number; wordy: boolean }
  | { kind: 'break'; marks: MarkName[] }
  | { kind: 'soft'; marks: MarkName[] }
  | { kind: 'tab' }
  | { kind: 'autolink'; href: number }
  | { kind: 'bareUrl'; href: number };

const hrefArb = fc.nat(HREFS.length - 1);

const inlineItemArb: fc.Arbitrary<InlineItem> = fc.oneof(
  { weight: 8, arbitrary: fc.record({ kind: fc.constant('text' as const), text: textArb, marks: markNameArb, href: hrefArb, wordy: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('break' as const), marks: markNameArb }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('soft' as const), marks: markNameArb }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'tab' as const }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('autolink' as const), href: hrefArb }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('bareUrl' as const), href: hrefArb }) },
);

const inlineArb = fc.array(inlineItemArb, { minLength: 1, maxLength: 5 });

function markFor(name: MarkName, href: number): Mark {
  switch (name) {
    case 'link': return schema.marks.link.create({ href: HREFS[href] });
    case 'color': return schema.marks.textStyle.create({ color: '#ff0000' });
    case 'highlight': return schema.marks.highlight.create({ color: '#ffcc00' });
    default: return schema.marks[name].create();
  }
}

/** Marks for a run, as the schema allows them together (code excludes the rest). */
function markSet(names: MarkName[], href = 0): readonly Mark[] {
  let set: readonly Mark[] = [];
  for (const n of names) set = markFor(n, href).addToSet(set);
  return set;
}

/** Marks written as Markdown delimiter runs (`**`, `*`, `~~`). */
const DELIMITER_MARKS: ReadonlySet<MarkName> = new Set(['bold', 'italic', 'strike']);

/** `text` reduced to letters and inner spaces. */
function wordsOnly(text: string): string {
  const words = text.replace(/[^a-z ]/g, '').trim().replace(/ +/g, ' ');
  return words || 'w';
}

/** The inline content of a textblock, without the shapes excluded above. */
function buildInline(items: InlineItem[]): ProseMirrorNode[] {
  const out: ProseMirrorNode[] = [];
  for (const item of items) {
    if (item.kind === 'break') out.push(schema.nodes.hardBreak.create(null, null, markSet(item.marks)));
    else if (item.kind === 'soft') out.push(schema.nodes.softBreak.create(null, null, markSet(item.marks)));
    else if (item.kind === 'tab') out.push(schema.nodes.tab.create());
    else if (item.kind === 'autolink') out.push(schema.text(HREFS[item.href] ?? 'https://example.com', [markFor('link', item.href)]));
    else if (item.kind === 'bareUrl') {
      // Once per block: two identical lines holding a lone `*` can be escaped
      // differently, and a save keeps a line's escapes by its text
      // (`minimalEscapes.ts`), so such a note opens read-only (a known gap).
      const text = `see ${HREFS[item.href] ?? 'https://example.com'} now`;
      if (!out.some((n) => n.text === text)) out.push(schema.text(text));
    }
    else if (item.marks.some((m) => DELIMITER_MARKS.has(m)) && !item.marks.includes('code')) {
      if (item.wordy) {
        // A whole word with a space on each side.
        if (out.length && !isLineBreak(out[out.length - 1])) out.push(schema.text(' '));
        out.push(schema.text(wordsOnly(item.text), markSet(item.marks, item.href)));
        out.push(schema.text(' '));
      } else {
        // Straight against its neighbours, punctuation and all.
        out.push(schema.text(item.text.trim() || 'w', markSet(item.marks, item.href)));
      }
    } else if (item.marks.includes('code')) {
      // Inline code without a space at either end: Markdown strips one from
      // each side of a code span, and ignores a span of spaces.
      out.push(schema.text(item.text.trim() || 'c', markSet(item.marks, item.href)));
    } else {
      out.push(schema.text(item.text, markSet(item.marks, item.href)));
    }
  }
  // No line break as the last thing in the block, and no whitespace at the
  // end of a line. Trimming a run can bare another, so repeat until stable.
  for (let changed = true; changed; ) {
    changed = false;
    while (out.length && isLineBreak(out[out.length - 1])) {
      out.pop();
      changed = true;
    }
    for (let i = 0; i < out.length && !changed; i++) {
      const node = out[i];
      const lineEnds = i === out.length - 1 || isLineBreak(out[i + 1]);
      if (!node.isText || !lineEnds || !/\s$/.test(node.text ?? '')) continue;
      const trimmed = (node.text ?? '').replace(/\s+$/, '');
      if (trimmed) out[i] = node.cut(0, trimmed.length);
      else out.splice(i, 1);
      changed = true;
    }
  }
  return out;
}

/** A block's alignment and indent, where the editor keeps them (not in a list item). */
const layoutArb = fc.record({
  textAlign: fc.constantFrom<string | null>(null, null, null, 'center', 'right', 'justify'),
  indent: fc.constantFrom(0, 0, 0, 1, 2),
});

const paragraphArb = inlineArb.map((items) => schema.nodes.paragraph.create(null, buildInline(items)));

const laidOutParagraphArb = fc
  .record({ items: inlineArb, layout: layoutArb })
  .map(({ items, layout }) => schema.nodes.paragraph.create(layout, buildInline(items)));

const headingArb = fc
  .record({ level: fc.integer({ min: 1, max: 3 }), items: inlineArb, layout: layoutArb })
  .map(({ level, items, layout }) => schema.nodes.heading.create({ level, ...layout }, buildInline(items)));

const CODE_LINES = ['let x = 1', '```', '````', '~~~', '  ```', '`inline`', 'a | b', ''];
const codeBlockArb = fc
  .record({
    lines: fc.array(fc.constantFrom(...CODE_LINES), { minLength: 1, maxLength: 4 }),
    language: fc.constantFrom('', 'js', 'python'),
  })
  .map(({ lines, language }) => {
    const text = lines.join('\n').replace(/\n+$/, '');
    return schema.nodes.codeBlock.create({ language: language || null }, text ? schema.text(text) : null);
  });

const ruleArb = fc.constant(null).map(() => schema.nodes.horizontalRule.create());

type BlockArbs = {
  block: ProseMirrorNode;
  list: ProseMirrorNode;
};

/** Lists nest up to two levels below the top; a numbered list may start anywhere from 1. */
const { list: listArb } = fc.letrec<BlockArbs>((tie) => ({
  block: fc.oneof({ depthSize: 'small', withCrossShrink: true }, paragraphArb, tie('list')),
  list: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    fc.array(listItemArb(tie('list')), { minLength: 1, maxLength: 3 }).map((items) => schema.nodes.bulletList.create(null, items)),
    fc
      .record({ items: fc.array(listItemArb(tie('list')), { minLength: 1, maxLength: 3 }), start: fc.constantFrom(1, 1, 1, 2, 3, 10) })
      .map(({ items, start }) => schema.nodes.orderedList.create({ start }, items)),
    fc
      .array(taskItemArb(tie('list')), { minLength: 1, maxLength: 3 })
      .map((items) => schema.nodes.taskList.create(null, items)),
  ),
}));

function listItemArb(nested: fc.Arbitrary<ProseMirrorNode>): fc.Arbitrary<ProseMirrorNode> {
  return fc
    .record({ first: paragraphArb, child: fc.option(nested, { freq: 4 }) })
    .map(({ first, child }) => schema.nodes.listItem.create(null, child ? [first, child] : [first]));
}

function taskItemArb(nested: fc.Arbitrary<ProseMirrorNode>): fc.Arbitrary<ProseMirrorNode> {
  return fc
    .record({ first: paragraphArb, checked: fc.boolean(), child: fc.option(nested, { freq: 4 }), empty: fc.boolean() })
    .map(({ first, checked, child, empty }) => {
      const p = empty ? schema.nodes.paragraph.create() : first;
      return schema.nodes.taskItem.create({ checked }, child && child.type.name === 'taskList' ? [p, child] : [p]);
    });
}

/** A table cell: one paragraph (aligned or not), two paragraphs, or a list. */
const cellContentArb = fc.oneof(
  { weight: 6, arbitrary: laidOutParagraphArb.map((p) => [p]) },
  { weight: 1, arbitrary: fc.tuple(paragraphArb, paragraphArb).map(([a, b]) => [a, b]) },
  {
    weight: 1,
    arbitrary: fc
      .array(paragraphArb, { minLength: 1, maxLength: 2 })
      .map((ps) => [schema.nodes.bulletList.create(null, ps.map((p) => schema.nodes.listItem.create(null, p)))]),
  },
);

const tableArb = fc
  .record({
    cols: fc.integer({ min: 1, max: 3 }),
    rows: fc.integer({ min: 1, max: 3 }),
    align: fc.constantFrom<('left' | 'center' | 'right' | null)>(null, null, 'left', 'center', 'right'),
    cells: fc.array(cellContentArb, { minLength: 9, maxLength: 9 }),
  })
  .map(({ cols, rows, align, cells }) => {
    const out: ProseMirrorNode[] = [];
    for (let r = 0; r < rows; r++) {
      const row: ProseMirrorNode[] = [];
      for (let c = 0; c < cols; c++) {
        const type = r === 0 ? schema.nodes.tableHeader : schema.nodes.tableCell;
        row.push(type.create({ align: c === 0 ? align : null }, cells[r * 3 + c]));
      }
      out.push(schema.nodes.tableRow.create(null, row));
    }
    return schema.nodes.table.create(null, out);
  });

const quoteArb = fc
  .array(laidOutParagraphArb, { minLength: 1, maxLength: 2 })
  .map((ps) => schema.nodes.blockquote.create(null, ps));

const emptyParagraphArb = fc.constant(null).map(() => schema.nodes.paragraph.create());

const topBlockArb: fc.Arbitrary<ProseMirrorNode> = fc.oneof(
  { weight: 5, arbitrary: laidOutParagraphArb },
  { weight: 2, arbitrary: headingArb },
  { weight: 4, arbitrary: listArb },
  { weight: 2, arbitrary: tableArb },
  { weight: 2, arbitrary: codeBlockArb },
  { weight: 1, arbitrary: quoteArb },
  { weight: 1, arbitrary: ruleArb },
  { weight: 1, arbitrary: emptyParagraphArb },
);

/** True when `doc`'s first block ends with a bare URL, which the load turns into a link (a known gap). */
function firstBlockEndsWithBareUrl(doc: ProseMirrorNode): boolean {
  const first = doc.firstChild;
  return doc.childCount > 1 && !!first?.isTextblock && /\S+:\/\/\S*$|mailto:\S*$/.test(first.textContent);
}

const docArb = fc
  .array(topBlockArb, { minLength: 1, maxLength: 5 })
  .map((blocks) => {
    // The document never starts or ends with an empty paragraph: nothing in
    // the file says it is there.
    while (blocks.length > 1 && blocks[0].type.name === 'paragraph' && blocks[0].content.size === 0) blocks.shift();
    while (blocks.length > 1 && blocks[blocks.length - 1].type.name === 'paragraph' && blocks[blocks.length - 1].content.size === 0) blocks.pop();
    return schema.nodes.doc.create(null, blocks);
  })
  .filter((doc) => {
    try {
      doc.check();
    } catch {
      return false;
    }
    return !firstBlockEndsWithBareUrl(doc);
  });

// ── The property ─────────────────────────────────────────────────────────────

describe('editor round-trip property', () => {
  it(`every generated document is written in a form that reads back as the same note (${NUM_RUNS} runs)`, () => {
    fc.assert(
      fc.property(docArb, (doc) => {
        const md = serialise(doc);
        const rt = roundTrip(md);
        const before = JSON.stringify(shownDocument(doc.toJSON() as JSONContent));
        const after = JSON.stringify(shownDocument(rt.doc));
        if (rt.lossy || rt.again !== md || before !== after) {
          throw new Error(
            `does not read back\n--- written ---\n${md}\n--- read back and written again ---\n${rt.again}\n--- lossy: ${rt.lossy}` +
              `\n--- document ---\n${before}\n--- read back ---\n${after}`,
          );
        }
      }),
      { numRuns: NUM_RUNS, seed: SEED, endOnFailure: false },
    );
  }, 180_000);
});

// ── Commands in context ──────────────────────────────────────────────────────

interface Context {
  name: string;
  /** The note before the command; the caret goes at the end of `caretAfter`. */
  start: string;
  caretAfter: string;
}

const CONTEXTS: Context[] = [
  { name: 'a paragraph', start: 'Alpha beta\n\nGamma', caretAfter: 'Alpha beta' },
  { name: 'a line after a soft break', start: 'Alpha\nbeta\n\nGamma', caretAfter: 'beta' },
  { name: 'a line before a soft break', start: 'Alpha\nbeta\n\nGamma', caretAfter: 'Alpha' },
  { name: 'a list item', start: '- one\n- two\n- three', caretAfter: 'two' },
  { name: 'a checklist item', start: '- [ ] one\n- [ ] two\n- [ ] three', caretAfter: 'two' },
  { name: 'a numbered item', start: '1. one\n2. two\n3. three', caretAfter: 'two' },
  { name: 'a table cell', start: '| a | b |\n| --- | --- |\n| c | d |', caretAfter: 'c' },
  { name: 'a heading', start: '## Title\n\nBody', caretAfter: 'Title' },
];

/** Puts the caret right after the first occurrence of `text`. */
function caretAfter(ed: Editor, text: string): void {
  let pos = -1;
  ed.state.doc.descendants((node, p) => {
    if (pos >= 0) return false;
    if (node.isText && node.text?.includes(text)) pos = p + (node.text.indexOf(text) + text.length);
    return true;
  });
  if (pos < 0) throw new Error(`no "${text}" in the note`);
  ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, pos)));
}

/** Types `text` as keystrokes do, so input rules (`[ ] ` → checkbox) fire. */
function typeText(ed: Editor, text: string): void {
  for (const ch of text) {
    const { from, to } = ed.state.selection;
    const handled = ed.view.someProp('handleTextInput', (f) => f(ed.view, from, to, ch, () => ed.state.tr.insertText(ch, from, to)));
    if (!handled) ed.view.dispatch(ed.state.tr.insertText(ch, from, to));
  }
}

function pressKey(ed: Editor, key: string, shiftKey = false): void {
  const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
  ed.view.someProp('handleKeyDown', (f) => f(ed.view, event));
}

interface Command {
  name: string;
  run: (ed: Editor) => void;
}

const COMMANDS: Command[] = [
  { name: 'toggle checklist (Ctrl+Shift+9)', run: (e) => void e.chain().toggleTaskList().run() },
  { name: 'toggle bullet list', run: (e) => void e.chain().toggleBulletList().run() },
  { name: 'toggle numbered list', run: (e) => void e.chain().toggleOrderedList().run() },
  { name: 'indent the list item', run: (e) => void (e.chain().sinkListItem('listItem').run() || e.chain().sinkListItem('taskItem').run()) },
  { name: 'Enter, then click away', run: (e) => pressKey(e, 'Enter') },
  { name: 'Enter twice', run: (e) => { pressKey(e, 'Enter'); pressKey(e, 'Enter'); } },
  { name: 'Shift+Enter, then type after it', run: (e) => { e.chain().setHardBreak().run(); typeText(e, 'next'); } },
  { name: 'Shift+Enter, then spaces and text', run: (e) => { e.chain().setHardBreak().run(); typeText(e, '  next'); } },
  { name: 'insert a table', run: (e) => void e.chain().insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run() },
  { name: 'Enter, then type "[ ] " and a task', run: (e) => { pressKey(e, 'Enter'); typeText(e, '[ ] task'); } },
  { name: 'Enter, then type four spaces and text', run: (e) => { pressKey(e, 'Enter'); typeText(e, '    indented'); } },
  { name: 'type a pipe', run: (e) => typeText(e, ' yes|no') },
  { name: 'insert a horizontal rule', run: (e) => void e.chain().setHorizontalRule().run() },
  { name: 'type " ##"', run: (e) => typeText(e, ' ##') },
  { name: 'Enter, then type "1."', run: (e) => { pressKey(e, 'Enter'); typeText(e, '1.'); } },
];

describe('list, table and line-break commands in context survive save and reload', () => {
  for (const ctx of CONTEXTS) {
    for (const cmd of COMMANDS) {
      it(`${cmd.name} in ${ctx.name}`, () => {
        const ed = makeEditor();
        try {
          loadMarkdownIntoEditor(ed, ctx.start);
          caretAfter(ed, ctx.caretAfter);
          cmd.run(ed);
          const md = editorMarkdown(ed);
          const rt = roundTrip(md);
          expect({ md, lossy: rt.lossy, again: rt.again }).toEqual({ md, lossy: false, again: md });
        } finally {
          ed.destroy();
        }
      });
    }
  }
});

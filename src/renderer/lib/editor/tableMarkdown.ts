import { getHTMLFromFragment, mergeAttributes } from '@tiptap/core';
import { Table, TableCell, TableHeader } from '@tiptap/extension-table';
import { Fragment, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import { hasBlockLayout } from './blockLayout';
import { withLeadSpaceNodes, withLeadSpacesOutsideRuns } from './leadSpace';
import { withBreakMarksTrimmed } from './softBreak';
import { withSpaceRunsUnwrapped, type MarkFlagSpecs } from './spaceRuns';
import { withBlockEndSpacesTrimmed, withLineEndSpacesDropped } from './lineEndSpaces';

/**
 * How a table is written to the file.
 *
 * A Markdown (GFM) table holds one line of inline text per cell. tiptap-markdown
 * wrote one whenever no cell held more than one block, so a cell holding a
 * list or a heading was flattened, and a `|` typed in a cell ended the cell:
 * the table reopened as a paragraph of pipes (read-only, and broken in any
 * Markdown app). Here a table is written as Markdown only when every cell is
 * one plain paragraph, the first row is the header and no cell spans; any
 * other table is written as HTML, which reads back cell for cell. In a
 * Markdown table a `|` in the text is written `\|` (`textEscapes.ts`), and in
 * inline code too, since the cell split reads `\|` before the code span does.
 * Column alignment is kept in the delimiter row (`:---`, `:---:`, `---:`).
 * A Markdown table has no column widths, so a table with a column dragged to
 * a width is written as HTML, which keeps it (it was saved as Markdown and
 * the width was gone on reopen, with nothing to say so).
 */

type Align = 'left' | 'center' | 'right' | null;

const DELIMITER: Record<string, string> = { left: ':---', center: ':---:', right: '---:' };

interface TableSerializeState {
  inTable: boolean;
  write(content?: string): void;
  ensureNewLine(): void;
  closeBlock(node: ProseMirrorNode): void;
  renderInline(node: ProseMirrorNode, fromBlockStart?: boolean): void;
  /** The writer's mark specs, whose flags `spaceRuns.ts` follows. */
  marks?: MarkFlagSpecs;
  /** Notes that a line of text ends here (a cell's end, `lineEndSpaces.ts`). */
  markLineEnd?(): void;
}

function alignOf(cell: ProseMirrorNode): Align {
  const a: unknown = cell.attrs.align;
  return a === 'left' || a === 'center' || a === 'right' ? a : null;
}

/** A `|` in a link or image address can't be escaped in a Markdown cell. */
function hasPipeInAddress(paragraph: ProseMirrorNode): boolean {
  let found = false;
  paragraph.descendants((node) => {
    const attrs = [node.attrs.src, node.attrs.alt, node.attrs.title];
    for (const mark of node.marks) attrs.push(mark.attrs.href, mark.attrs.title);
    if (attrs.some((v) => typeof v === 'string' && v.includes('|'))) found = true;
    return !found;
  });
  return found;
}

/** True when the cell's column was dragged to a width. */
function hasColumnWidth(cell: ProseMirrorNode): boolean {
  const widths: unknown = cell.attrs.colwidth;
  return Array.isArray(widths) && widths.some((w) => typeof w === 'number' && w > 0);
}

/** The cell's one paragraph, when a Markdown cell can hold it. */
function markdownCellParagraph(cell: ProseMirrorNode): ProseMirrorNode | null {
  if (Number(cell.attrs.colspan) > 1 || Number(cell.attrs.rowspan) > 1 || hasColumnWidth(cell)) return null;
  const p = cell.childCount === 1 ? cell.firstChild : null;
  if (!p || p.type.name !== 'paragraph' || hasBlockLayout(p) || hasPipeInAddress(p)) return null;
  return p;
}

/** True when `table` can be written as a Markdown table without losing anything the editor shows. */
export function isMarkdownTable(table: ProseMirrorNode): boolean {
  const rows: ProseMirrorNode[] = [];
  table.forEach((row) => rows.push(row));
  const width = rows[0]?.childCount ?? 0;
  if (width === 0) return false;
  const aligns: Align[] = [];
  for (const [r, row] of rows.entries()) {
    if (row.childCount !== width) return false;
    for (let c = 0; c < width; c++) {
      const cell = row.child(c);
      if ((cell.type.name === 'tableHeader') !== (r === 0)) return false;
      if (!markdownCellParagraph(cell)) return false;
      if (r === 0) aligns.push(alignOf(cell));
      else if (alignOf(cell) !== aligns[c]) return false;
    }
  }
  return true;
}

/** `paragraph` with every `|` in its inline code written `\|`. */
function withCodePipesEscaped(paragraph: ProseMirrorNode): ProseMirrorNode {
  let changed = false;
  const children: ProseMirrorNode[] = [];
  paragraph.forEach((child) => {
    const text = child.text ?? '';
    if (child.isText && text.includes('|') && child.marks.some((m) => m.type.name === 'code')) {
      children.push(paragraph.type.schema.text(text.replace(/\|/g, '\\|'), child.marks));
      changed = true;
    } else {
      children.push(child);
    }
  });
  return changed ? paragraph.copy(Fragment.fromArray(children)) : paragraph;
}

/**
 * Whether a cell's paragraph writes anything (tiptap-markdown skipped blank
 * cells). Blank is Markdown's: only spaces and tabs (a no-break space is text).
 */
function writesSomething(paragraph: ProseMirrorNode): boolean {
  let some = false;
  paragraph.forEach((child) => {
    if (!child.isText || /[^ \t]/.test(child.text ?? '')) some = true;
  });
  return some;
}

function writeMarkdownTable(state: TableSerializeState, table: ProseMirrorNode): void {
  state.inTable = true;
  table.forEach((row, _offset, r) => {
    state.write('| ');
    row.forEach((cell, _o, c) => {
      if (c) state.write(' | ');
      // A cell holds one line: spaces ending it wouldn't read back (`lineEndSpaces.ts`).
      const p = cell.firstChild ? withLineEndSpacesDropped(cell.firstChild, false) : null;
      if (p && writesSomething(p)) {
        state.renderInline(withSpaceRunsUnwrapped(withBreakMarksTrimmed(withLeadSpacesOutsideRuns(withCodePipesEscaped(p))), state.marks));
        state.markLineEnd?.();
      }
    });
    state.write(' |');
    state.ensureNewLine();
    if (r === 0) {
      const delimiters: string[] = [];
      row.forEach((cell) => delimiters.push(DELIMITER[alignOf(cell) ?? ''] ?? '---'));
      state.write(`| ${delimiters.join(' | ')} |`);
      state.ensureNewLine();
    }
  });
  state.closeBlock(table);
  state.inTable = false;
}

/**
 * The table as an HTML block, written the way tiptap-markdown writes any node
 * it has no Markdown for: the element on its own lines at the top level.
 */
function writeHtmlTable(state: TableSerializeState, table: ProseMirrorNode, parent: ProseMirrorNode | Fragment): void {
  const schema = table.type.schema;
  let html = getHTMLFromFragment(Fragment.from(withLeadSpaceNodes(withBlockEndSpacesTrimmed(table))), schema);
  if (parent instanceof Fragment || parent.type.name === schema.topNodeType.name) {
    const body = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body;
    const el = body.firstElementChild;
    if (el) {
      el.innerHTML = el.innerHTML.trim() ? `\n${el.innerHTML}\n` : '\n';
      html = el.outerHTML;
    }
  }
  state.write(html);
  state.closeBlock(table);
}

/**
 * A cell written as HTML spells out every attribute, `colspan="1"` and
 * `rowspan="1"` included. TipTap's own cells leave those defaults out, but
 * every HTML table Filo has saved holds them, and a note that would save
 * differently from its file opens read-only (KNOWN_LIMITATIONS #17). Pinned by
 * the `html-tables` fixture in `markdownBodyRoundTrip.test.ts`.
 */
export const FiloTableCell = TableCell.extend({
  renderHTML({ HTMLAttributes }) {
    return ['td', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
  },
});

export const FiloTableHeader = TableHeader.extend({
  renderHTML({ HTMLAttributes }) {
    return ['th', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
  },
});

export const FiloTable = Table.extend({
  addStorage() {
    return {
      ...this.parent?.(),
      markdown: {
        serialize(state: TableSerializeState, node: ProseMirrorNode, parent: ProseMirrorNode | Fragment): void {
          if (isMarkdownTable(node)) writeMarkdownTable(state, node);
          else writeHtmlTable(state, node, parent);
        },
        parse: {},
      },
    };
  },
});

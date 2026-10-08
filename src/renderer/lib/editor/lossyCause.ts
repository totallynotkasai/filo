/**
 * Why a note opens read-only, in words: the first block of it a save would
 * show differently. The line-by-line list of changes (`roundTripChanges`)
 * can name a harmless blank line first, or describe the real change only as
 * one: a bullet list whose last item is a checkbox is saved as a list and a
 * checklist, a change the file shows as nothing but a blank line between
 * them. Both texts are read as blocks by the note's own markdown-it, and the
 * first block that renders differently is named, with what happens to it.
 */
import type MarkdownIt from 'markdown-it';

type Token = ReturnType<MarkdownIt['parse']>[number];

/** The parts of markdown-it the reading needs (the editor's own instance). */
export interface MarkdownBlockParser {
  parse: MarkdownIt['parse'];
  renderer: { render(tokens: Token[], options: MarkdownIt['options'], env: object): string };
  options: MarkdownIt['options'];
}

export function isBlockParser(md: unknown): md is MarkdownBlockParser {
  const m = md as Partial<MarkdownBlockParser> | null;
  return typeof m?.parse === 'function' && typeof m.renderer?.render === 'function' && m.options !== undefined;
}

interface Block {
  html: string;
  kind: string;
  /** Its lines in the text, 0-based, end exclusive (-1 when unknown). */
  start: number;
  end: number;
}

/** A block's kind, as the user would name it. */
function kindOf(first: Token, html: string): string {
  switch (first.type) {
    case 'bullet_list_open': {
      const items = html.match(/<li\b/g)?.length ?? 0;
      const tasks = html.match(/<li class="task-list-item/g)?.length ?? 0;
      return items > 0 && tasks === items ? 'checklist' : 'list';
    }
    case 'ordered_list_open': return 'numbered list';
    case 'heading_open': return 'heading';
    case 'paragraph_open': return 'paragraph';
    case 'blockquote_open': return 'quote';
    case 'table_open': return 'table';
    case 'fence':
    case 'code_block': return 'code block';
    case 'html_block': return 'HTML block';
    case 'hr': return 'rule';
    default: return 'block';
  }
}

function blocksOf(md: MarkdownBlockParser, text: string): Block[] {
  const env = {};
  const tokens = md.parse(text, env);
  const out: Block[] = [];
  for (let i = 0; i < tokens.length;) {
    const first = tokens[i]!;
    let j = i + 1;
    if (first.nesting === 1) {
      for (let depth = 1; j < tokens.length && depth > 0; j++) depth += tokens[j]!.nesting;
    }
    const html = md.renderer.render(tokens.slice(i, j), md.options, env);
    out.push({ html, kind: kindOf(first, html), start: first.map?.[0] ?? -1, end: first.map?.[1] ?? -1 });
    i = j;
  }
  return out;
}

function withArticle(kind: string): string {
  return `${/^[aeiouH]/.test(kind) ? 'an' : 'a'} ${kind}`;
}

function listed(kinds: readonly string[]): string {
  const words = kinds.map(withArticle);
  return words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}` : (words[0] ?? '');
}

export interface RenderedChange {
  /** The block's first and last line in the original text, 1-based. */
  line: number;
  lastLine: number;
  /** What happens to it, when its kind or count changes: "this list would be split into a list and a checklist". */
  becomes?: string;
}

/** How far ahead the two texts' blocks are searched for where they agree again. */
const RESYNC = 12;

/**
 * The first block of `original` that `roundTripped` renders differently, or
 * null when every block renders the same (what differs is then a reference
 * definition or an escape, which the line list names).
 */
export function firstRenderedChange(original: string, roundTripped: string, md: MarkdownBlockParser): RenderedChange | null {
  const a = blocksOf(md, original);
  const b = blocksOf(md, roundTripped);
  let i = 0;
  while (i < a.length && i < b.length && a[i]!.html === b[i]!.html) i++;
  if (i === a.length && i === b.length) return null;
  const first = a[i];
  if (!first || first.start < 0) return null;

  // Where the two agree again: the nearest pair of equal blocks after the change.
  let p = a.length;
  let q = b.length;
  search: for (let d = 1; d <= RESYNC; d++) {
    for (let k = 0; k <= d; k++) {
      const pa = i + k;
      const qb = i + d - k;
      if (pa < a.length && qb < b.length && a[pa]!.html === b[qb]!.html) {
        p = pa;
        q = qb;
        break search;
      }
    }
  }
  const was = a.slice(i, p);
  const now = b.slice(i, q);
  const line = first.start + 1;
  const lastLine = Math.max(line, (was[was.length - 1]?.end ?? first.end));
  const kind = first.kind;
  let becomes: string | undefined;
  if (was.length === 1 && now.length > 1) becomes = `this ${kind} would be split into ${listed(now.map((x) => x.kind))}`;
  else if (was.length > 1 && now.length === 1) becomes = `these ${was.length} blocks would be joined into ${withArticle(now[0]!.kind)}`;
  else if (was.length === 1 && now.length === 1 && now[0]!.kind !== kind) becomes = `this ${kind} would become ${withArticle(now[0]!.kind)}`;
  return { line, lastLine, becomes };
}

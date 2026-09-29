import type { Editor } from '@tiptap/core';

/**
 * Empty-paragraph preservation across the Markdown round-trip.
 *
 * THE PROBLEM. The text tile is a rich-text editor (ProseMirror) that persists
 * to Markdown. When the user presses Enter on a blank line to add vertical
 * spacing, ProseMirror holds a genuinely empty paragraph node — but Markdown
 * has no way to encode "an empty paragraph". Consecutive blank lines collapse
 * to a single paragraph separator on parse, and `tiptap-markdown` serialises an
 * empty paragraph to nothing. So the spacing the user sees while editing
 * vanishes the moment the tile re-hydrates from disk (e.g. on a tab switch).
 *
 * THE FIX (two halves; the serialiser half lives in `createEditor.ts`).
 *
 *  - SERIALISE (editor → disk): the custom Paragraph node emits one extra
 *    *blank line* per empty top-level paragraph. The file therefore stays clean
 *    open-format Markdown — N empty paragraphs become N extra blank lines, the
 *    same bytes Obsidian would write. No markers on disk.
 *
 *  - PARSE (disk → editor): `encodeEmptyParagraphs` reconstructs the empty
 *    paragraphs *before* the body reaches `setContent`. It walks the body's
 *    block structure via the editor's own markdown-it tokenizer (so code
 *    fences, lists, and blockquotes are treated as opaque single blocks and are
 *    never split), and for every run of blank lines *between top-level blocks*
 *    it injects one sentinel paragraph per "extra" blank line. markdown-it then
 *    produces a real paragraph for each sentinel; `stripEmptyParagraphSentinels`
 *    removes the sentinel character afterwards, leaving a truly empty paragraph.
 *
 * The sentinel (a Private-Use-Area code point) only ever exists transiently in
 * memory between parse and strip — it is never written to disk, and a body that
 * already contains the sentinel is left untouched (see `loadMarkdownIntoEditor`)
 * so a file legitimately containing the code point can't be corrupted.
 */
export const EMPTY_PARAGRAPH_SENTINEL = '';

/** Minimal shape of a markdown-it block token — `level` + source line `map`. */
interface BlockToken {
  level: number;
  map: [number, number] | null;
}

/** The slice of markdown-it we depend on: block tokenization with line maps. */
export interface BlockTokenizer {
  parse(src: string, env: Record<string, unknown>): BlockToken[];
}

/**
 * Rewrites `body` so each empty top-level paragraph the serialiser encoded as
 * an extra blank line is reconstructed as a sentinel-bearing paragraph that
 * markdown-it will parse into its own `<p>` node.
 *
 * Robustness comes from driving the gaps off markdown-it's top-level block line
 * maps rather than a naive blank-line scan: a fenced code block, list, or
 * blockquote is a single top-level block, so blank lines *inside* it are part
 * of that block's verbatim source and are never reinterpreted as empty
 * paragraphs.
 *
 * `gap = next.startLine - prev.endLine` is the count of blank lines between two
 * adjacent top-level blocks; one of those is the ordinary paragraph separator,
 * so `gap - 1` empty paragraphs are reconstructed.
 */
export function encodeEmptyParagraphs(body: string, tokenizer: BlockTokenizer): string {
  if (!body) return body;

  let tokens: BlockToken[];
  try {
    tokens = tokenizer.parse(body, {});
  } catch {
    return body;
  }

  const lines = body.split('\n');
  // A list's line map runs on over the blank lines after it, so a block ends
  // at its last line with text; the blank lines after it are the gap.
  const blocks = tokens
    .filter((t) => t.level === 0 && t.map)
    .map((t): [number, number] => {
      const [start, end] = t.map as [number, number];
      let last = end;
      while (last > start + 1 && !/\S/.test(lines[last - 1] ?? '')) last--;
      return [start, last];
    });
  if (blocks.length < 2) return body;

  const segments: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!; // i < blocks.length
    if (i > 0) {
      const gap = block[0] - blocks[i - 1]![1]; // i > 0 ⇒ i-1 in range
      for (let extra = 1; extra < gap; extra++) segments.push(EMPTY_PARAGRAPH_SENTINEL);
    }
    segments.push(lines.slice(block[0], block[1]).join('\n'));
  }
  return segments.join('\n\n');
}

/**
 * Removes every sentinel code point from the editor's document, turning the
 * sentinel-bearing paragraphs produced by {@link encodeEmptyParagraphs} into
 * genuinely empty paragraphs. Dispatched with `preventUpdate` so the load isn't
 * mistaken for a user edit, and `addToHistory: false` so it can't be undone
 * into existence.
 *
 * No-ops on editor stubs (unit-test scaffolding) that lack a live
 * `state.doc` / `view.dispatch`.
 */
export function stripEmptyParagraphSentinels(editor: Editor): void {
  const doc = editor?.state?.doc;
  const dispatch = editor?.view?.dispatch;
  if (!doc || typeof doc.descendants !== 'function' || typeof dispatch !== 'function') return;

  const positions: number[] = [];
  doc.descendants((node, pos) => {
    if (node.isText && node.text) {
      for (let i = 0; i < node.text.length; i++) {
        if (node.text[i] === EMPTY_PARAGRAPH_SENTINEL) positions.push(pos + i);
      }
    }
    return true;
  });
  if (positions.length === 0) return;

  const tr = editor.state.tr;
  // Delete right-to-left so earlier deletions don't shift later positions.
  positions.sort((a, b) => b - a).forEach((p) => tr.delete(p, p + 1));
  tr.setMeta('preventUpdate', true).setMeta('addToHistory', false);
  editor.view.dispatch(tr);
}

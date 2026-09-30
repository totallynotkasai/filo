/**
 * Where a note body holds Markdown syntax rather than words, so Replace All
 * can leave a match there alone. Replace works on the file text, and a
 * typographic clean-up (` - ` → ` – `, `--` → `—`) would otherwise turn a
 * nested list into a paragraph, a rule or a table into text, or change where
 * a link points.
 *
 * What counts as syntax:
 * - a list or number marker opening a line (inside a quote too), with a
 *   task box after it;
 * - a thematic break (`---`, `***`, `___`) or a table delimiter row;
 * - a link or image destination (`](here)`, `[id]: here`, `<https://here>`);
 * - an HTML tag, its attributes included.
 *
 * Deliberately simple and on the safe side: a list-looking line inside a code
 * block counts too, so a match there is left alone rather than risked.
 */

/** A half-open `[start, end)` range of the body. */
export interface SyntaxRange {
  start: number;
  end: number;
}

// A quote prefix, then a bullet or a number and `.` / `)`, then a space or
// the line end; an optional task box after it.
const LIST_MARKER = /^([ \t]*(?:>[ \t]?)*[ \t]*)([-*+]|\d{1,9}[.)])(?=[ \t]|$)([ \t]+\[[ xX]\](?=[ \t]|$))?/;
const THEMATIC_BREAK = /^ {0,3}(?:>[ \t]?)*[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const TABLE_DELIMITER = /^[ \t]*(?:>[ \t]?)*[ \t]*\|?(?:[ \t]*:?-+:?[ \t]*\|)+(?:[ \t]*:?-+:?[ \t]*)?\|?[ \t]*$/;
const INLINE_DESTINATION = /\]\(\s*(<[^<>\n]*>|(?:[^\s()]|\([^\s()]*\))+)/g;
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]\n]+\]:[ \t]*(<[^<>\n]*>|\S+)/;
const AUTOLINK = /<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*>|<[^\s<>@]+@[^\s<>@]+>/g;
const HTML_TAG = /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s+[^<>]*?)?\s*\/?>|<!--[\s\S]*?-->/g;

/** Every syntax range in `body`, in no particular order (they may overlap). */
export function markdownSyntaxRanges(body: string): SyntaxRange[] {
  const ranges: SyntaxRange[] = [];
  let lineStart = 0;
  for (const line of body.split('\n')) {
    const text = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (THEMATIC_BREAK.test(text) || (text.includes('|') && TABLE_DELIMITER.test(text))) {
      ranges.push({ start: lineStart, end: lineStart + text.length });
    } else {
      const list = LIST_MARKER.exec(text);
      if (list) {
        const markerStart = lineStart + list[1]!.length;
        ranges.push({ start: markerStart, end: markerStart + list[2]!.length + (list[3]?.length ?? 0) });
      }
      const ref = REFERENCE_DEFINITION.exec(text);
      if (ref) {
        const destStart = lineStart + ref[0].length - ref[1]!.length;
        ranges.push({ start: destStart, end: destStart + ref[1]!.length });
      }
    }
    lineStart += line.length + 1;
  }
  for (const m of body.matchAll(INLINE_DESTINATION)) {
    const destStart = m.index + m[0].length - m[1]!.length;
    ranges.push({ start: destStart, end: destStart + m[1]!.length });
  }
  for (const pattern of [AUTOLINK, HTML_TAG]) {
    for (const m of body.matchAll(pattern)) ranges.push({ start: m.index, end: m.index + m[0].length });
  }
  return ranges;
}

/** Whether `[start, end)` touches any of `ranges`. */
export function overlapsSyntax(ranges: readonly SyntaxRange[], start: number, end: number): boolean {
  return ranges.some((r) => start < r.end && end > r.start);
}

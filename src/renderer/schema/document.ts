/**
 * Types for .md document state held in the document store.
 *
 * `RichTextAnnotation` describes per-line / per-range text styling (colour,
 * highlight, font, alignment). It is currently a TYPE ONLY: the in-memory
 * `DocumentState.richText` field is always `[]` — no load path parses these
 * annotations, nothing persists them, and no renderer applies them yet. The
 * Zod schema that previously backed this type was never used to validate
 * anything (no `parse` / `safeParse` call site existed), so it was removed as
 * dead code. If a rich-text-annotation feature is built later, reintroduce a
 * schema at the load boundary that parses into this shape.
 */

// ── Rich Text Annotation ──

export interface RichTextAnnotation {
  /** 1-based line number the annotation applies to. */
  line: number;
  /**
   * `[start, end]` column range within `line`. `-1` is the end-of-line
   * sentinel; otherwise `start >= 0` and (when `end` is concrete) `end >= start`.
   */
  range: [number, number];
  color?: string;
  highlight?: string;
  fontSize?: string;
  fontFamily?: string;
  align?: 'left' | 'center' | 'right';
}

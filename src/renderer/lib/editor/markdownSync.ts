import { Document } from 'yaml';
import { parseFrontmatterObject } from '../vault/frontmatterRead';
import type { Editor } from '@tiptap/core';
import { resetEditorHistory } from './editorHistory';
import { bodyLines, withMinimalEscapes, type MarkdownRenderer } from './minimalEscapes';
import { rendersSame } from './renderedSame';
import {
  encodeEmptyParagraphs,
  stripEmptyParagraphSentinels,
  EMPTY_PARAGRAPH_SENTINEL,
  type BlockTokenizer,
} from './emptyParagraphs';
import {
  patchFrontmatterSourceCst,
  frontmatterSourceParses,
  frontmatterSourceKeys,
  frontmatterSourceHasNonScalarKey,
  frontmatterSourceRootIsMapping,
  dumpPreservesUntouched,
} from '../vault/frontmatterCstModel';
import { bodyWithoutFenceLookalike, splitFrontmatterFence } from '../notes/frontmatterFence';

/**
 * Markdown round-trip helpers for TipTap editors backed by `.md` files.
 *
 * Loading: `parseMarkdownFile` splits frontmatter from body and parses the YAML
 * with the `yaml` package (`parseDocument().toJS()`), then `loadMarkdownIntoEditor`
 * tells the editor to render the body. The `tiptap-markdown` extension installed
 * in `createEditor.ts` parses the markdown string and produces the prose-mirror
 * document.
 *
 * Saving: `editorMarkdown` calls `editor.storage.markdown.getMarkdown()` to
 * serialise the document back to markdown. `assembleMarkdownFile` combines
 * that body with the frontmatter (merging in any inline-tag union from the
 * body) and emits the full file contents that should be written to disk.
 *
 * NOTE: the `yaml` package is the single YAML library for the frontmatter read
 * AND the source-preserving write engine, so the read and the write diff come
 * from one parser (no cross-parser "looks changed but isn't"). Don't reintroduce
 * `gray-matter`: its `stringify` needs the Node `Buffer` global, undefined in
 * the renderer.
 */

/**
 * The lines of the body each editor last loaded, in order. A save writes a line
 * the file already holds as the file spells it (`withMinimalEscapes`).
 */
// allow-module-state: per-editor load record, dropped with the editor (WeakMap)
const loadedLines = new WeakMap<Editor, readonly string[]>();

export interface ParsedMarkdownDocument {
  /** Raw frontmatter object (parsed via the `yaml` package's `parseDocument().toJS()`). */
  frontmatter: Record<string, unknown>;
  /**
   * The verbatim YAML source between the `---` fences (no fences, no
   * leading/trailing newline), exactly as it sat on disk. The empty string when
   * the source had no frontmatter block.
   *
   * Threaded so the write path can (a) write an unparseable / non-object
   * block back untouched instead of silently dropping it, and (b) round-trip
   * comments / key order / line endings byte-for-byte on a body-only save. Pass it back via
   * `assembleMarkdownFile({ rawFrontmatter, frontmatterDirty })`.
   */
  rawFrontmatter: string;
  /** Body markdown with frontmatter stripped. */
  body: string;
  /** True iff the source had a frontmatter block. */
  hasFrontmatter: boolean;
  /**
   * True iff the source started with a UTF-8 BOM (`﻿`).
   *
   * The BOM is stripped before frontmatter detection so the fence is found
   * in files saved by Windows editors (Notepad, Office "Save As UTF-8")
   * that prefix the byte-order mark.
   * Callers that want to preserve the user's original encoding on
   * round-trip pass this flag back to `assembleMarkdownFile` via
   * `options.bom`.
   */
  hadBom: boolean;
}

/**
 * Splits a `.md` file's text into structured frontmatter + body. The object
 * comes from `parseFrontmatterObject`: a recoverable YAML error still reads,
 * and a block that can't be read at all gives `{}` (the raw block is still
 * threaded out via `rawFrontmatter` so an unparseable fence round-trips
 * without data loss).
 *
 * Where the block starts and ends is decided by `splitFrontmatterFence`
 * (`lib/notes/frontmatterFence.ts`), the one fence parser every reader and
 * writer shares. It skips a leading UTF-8 BOM so Notepad-saved files don't
 * lose their frontmatter; `hadBom` is returned so the caller can re-emit the
 * mark via `assembleMarkdownFile({ bom: true })`.
 */
export function parseMarkdownFile(raw: string): ParsedMarkdownDocument {
  const split = splitFrontmatterFence(raw);
  const { hadBom, block } = split;
  if (!block) {
    return { frontmatter: {}, rawFrontmatter: '', body: split.body, hasFrontmatter: false, hadBom };
  }

  // The one frontmatter object reader, shared with the vault index, so a note
  // shows the same title and tags open as closed. A block with a recoverable
  // error (a duplicate key, a tab indent) still reads; writing to it is
  // refused by the assembler, which keeps such a block verbatim.
  const frontmatter = parseFrontmatterObject(block.source);

  // Keep the raw YAML source even when it didn't parse into an object,
  // so the write path can preserve a fence it couldn't turn into keys.
  return { frontmatter, rawFrontmatter: block.source, body: split.body, hasFrontmatter: true, hadBom };
}

/**
 * Loads a parsed markdown document into a live TipTap editor. The body is
 * fed to `editor.commands.setContent`, which the `tiptap-markdown` extension
 * intercepts to parse via markdown-it. Pass `{ emitUpdate: false }` to
 * suppress the resulting `onUpdate` callback so the load does not get
 * mistaken for a user edit.
 *
 * Pass `{ preserveSelection: true }` to capture the editor's current selection
 * before the content swap and restore it afterwards (clamped to the new
 * document size). Used when an external edit replaces the body underneath an
 * open caret — without this, the cursor jumps to position 0 and the user
 * loses their place.
 *
 * Returns a `lossy` flag set when the body fails to round-trip
 * through tiptap-markdown losslessly. Callers should set the document
 * read-only when this is true so the next debounced write doesn't clobber
 * the syntax that tiptap can't preserve (Obsidian callouts, math blocks,
 * highlight `==…==`, etc.). With it come up to three `changes`: the lines
 * a save would change, for the read-only banner to name.
 *
 * Empty paragraphs the user added for vertical spacing are reconstructed from
 * the clean blank lines on disk before the body is loaded (see
 * `lib/editor/emptyParagraphs.ts`); the lossy comparison still runs against the
 * original on-disk body.
 */
export function loadMarkdownIntoEditor(
  editor: Editor,
  body: string,
  options: { emitUpdate?: boolean; preserveSelection?: boolean } = {},
): { lossy: boolean; changes: RoundTripChange[] } {
  if (!editor || editor.isDestroyed) return { lossy: false, changes: [] };
  const emit = options.emitUpdate ?? false;
  const preserveSelection = options.preserveSelection ?? false;

  let snapshot: { from: number; to: number; hadFocus: boolean } | null = null;
  if (preserveSelection) {
    const { from, to } = editor.state.selection;
    snapshot = { from, to, hadFocus: editor.isFocused };
  }

  const originalBody = body ?? '';
  loadedLines.set(editor, bodyLines(originalBody));

  // Reconstruct empty paragraphs (vertical spacing) that the serialiser encoded
  // as extra blank lines, before the body reaches setContent. Skipped when the
  // editor exposes no markdown-it tokenizer (test stubs) or when the body
  // already contains the sentinel code point — in the latter case the
  // post-load strip would delete a character the file legitimately holds.
  // See `lib/editor/emptyParagraphs.ts`.
  const tokenizer = (
    editor as { storage?: { markdown?: { parser?: { md?: BlockTokenizer } } } }
  ).storage?.markdown?.parser?.md;
  const reconstruct = !!tokenizer && !originalBody.includes(EMPTY_PARAGRAPH_SENTINEL);
  const contentToLoad = reconstruct
    ? encodeEmptyParagraphs(originalBody, tokenizer)
    : originalBody;

  // TipTap 3: the 2nd arg is an OPTIONS object whose `emitUpdate` defaults to
  // TRUE. The TipTap 2 boolean form (`setContent(x, false)`) would fire onUpdate
  // on every load → a phantom write of a file the user never edited.
  //
  // A load is NOT an undoable edit: without `addToHistory: false`, Ctrl+Z right
  // after opening a note would empty it (and autosave the empty body). The chain
  // shares ONE transaction, so the meta covers the replace step;
  // `resetEditorHistory` below then drops earlier history so undo can't cross a
  // hydrate or reload. This is the ONLY `setContent` in src/renderer (pinned by
  // gates:editor-body-discipline).
  editor
    .chain()
    .command(({ tr }) => {
      tr.setMeta('addToHistory', false);
      // A load isn't typing: a bare URL in the file stays text, as the file
      // has it. Link's autolink would otherwise link the first block's last
      // word, and a save would write it as `<…>`.
      tr.setMeta('preventAutolink', true);
      return true;
    })
    // Keeps runs of spaces the file has (`keepSpaces.ts` tidies the rest).
    .setContent(contentToLoad, { emitUpdate: emit, parseOptions: { preserveWhitespace: true } })
    .run();
  // Turn the reconstructed sentinel paragraphs into genuinely empty ones. Must
  // run before the selection restore below so positions are clamped against the
  // final (post-strip) document size.
  if (reconstruct) stripEmptyParagraphSentinels(editor);

  if (snapshot && !editor.isDestroyed) {
    const docSize = editor.state.doc.content.size;
    const clampedFrom = Math.max(0, Math.min(snapshot.from, docSize));
    const clampedTo = Math.max(clampedFrom, Math.min(snapshot.to, docSize));
    editor.commands.setTextSelection({ from: clampedFrom, to: clampedTo });
    if (snapshot.hadFocus) editor.commands.focus(undefined, { scrollIntoView: false });
  }

  // A full-document load is a history boundary (see editorHistory.ts).
  resetEditorHistory(editor);

  // Round-trip check — read the editor's serialised markdown back and
  // compare against a normalised input. If they diverge, tiptap-markdown
  // lost something on the parse — the file should be opened read-only so
  // a subsequent write can't strip the syntax it couldn't preserve.
  //
  // Skip the check entirely when:
  //  - the input is empty (nothing to compare)
  //  - the editor was set up without `tiptap-markdown`'s storage (e.g.
  //    a label editor or a unit-test stub) — without that storage we
  //    can't actually serialise back to markdown, so any comparison would
  //    be a false positive.
  let lossy = false;
  let changes: RoundTripChange[] = [];
  const hasMarkdownStorage =
    (editor as { storage?: { markdown?: unknown } }).storage?.markdown !== undefined;
  if (originalBody.length > 0 && hasMarkdownStorage) {
    try {
      const roundTripped = editorMarkdown(editor);
      lossy = isLossyMarkdownRoundTrip(originalBody, roundTripped, markdownRenderer(editor));
      // What the read-only banner names, and Take ownership's confirm lists.
      if (lossy) changes = roundTripChanges(originalBody, roundTripped);
    } catch {
      lossy = false;
    }
  }
  return { lossy, changes };
}

/**
 * Returns true iff `tiptap-markdown` could not round-trip `original` back
 * into the same body. Normalises both sides so cosmetic differences
 * (line-ending family, trailing whitespace per line, repeated blank lines,
 * leading/trailing whitespace, list-bullet style, hard-break encoding, and
 * thematic-break marker style) don't trigger false positives. Anything that
 * survives this normalisation and still differs is real syntax that the
 * parser dropped.
 *
 * With `md`, the note's markdown-it, texts that still differ are compared as
 * that parser reads them (`renderedSame.ts`): a difference that renders the
 * same, adds no escape another app would read differently and keeps every
 * reference definition is only spelling (a blank line between blocks, list
 * numbers), and the note stays editable.
 *
 * Exported for direct unit-testing in `markdownSync.test.ts`. Production
 * call site is `loadMarkdownIntoEditor` above.
 */
export function isLossyMarkdownRoundTrip(original: string, roundTripped: string, md?: MarkdownRenderer): boolean {
  if (normaliseForRoundTripCompare(original) === normaliseForRoundTripCompare(roundTripped)) return false;
  return !md || !rendersSame(original, roundTripped, md);
}

/** The editor's markdown-it, when it has tiptap-markdown's parser. */
function markdownRenderer(editor: Editor): MarkdownRenderer | undefined {
  return (editor as { storage?: { markdown?: { parser?: { md?: MarkdownRenderer } } } }).storage?.markdown?.parser?.md;
}

/** A line of the note that saving from the editor would change, as the round-trip check compares it. */
export interface RoundTripChange {
  /** The line as it is in the file ('' when saving would add a line). */
  original: string;
  /** The line as Filo would write it ('' when saving would drop it). */
  filo: string;
  /**
   * For a line saving would add (`original` ''): the file's line it would go
   * above, in normal form; '' when it would go at the end.
   */
  above?: string;
}

/** Past this many lines in the region that differs, lines are paired in order rather than diffed. */
const DIFF_LIMIT = 1500;

type LineOp = { kind: 'same' | 'drop'; a: string } | { kind: 'add'; b: string };

/** A shortest edit script from `a` to `b` (a longest common subsequence). */
function lineOps(a: readonly string[], b: readonly string[]): LineOp[] {
  const n = a.length;
  const m = b.length;
  if (n > DIFF_LIMIT || m > DIFF_LIMIT) {
    const ops: LineOp[] = [];
    for (let i = 0; i < Math.max(n, m); i++) {
      if (i < n && i < m && a[i] === b[i]) ops.push({ kind: 'same', a: a[i] ?? '' });
      else {
        if (i < n) ops.push({ kind: 'drop', a: a[i] ?? '' });
        if (i < m) ops.push({ kind: 'add', b: b[i] ?? '' });
      }
    }
    return ops;
  }
  // lcs[i][j]: the longest common subsequence of a[i..] and b[j..].
  const lcs: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = lcs[i] as Uint16Array;
    const below = lcs[i + 1] as Uint16Array;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? (below[j + 1] ?? 0) + 1 : Math.max(below[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const ops: LineOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ kind: 'same', a: a[i++] ?? '' });
      j++;
    } else if (j < m && (i >= n || (lcs[i]?.[j + 1] ?? 0) >= (lcs[i + 1]?.[j] ?? 0))) {
      ops.push({ kind: 'add', b: b[j++] ?? '' });
    } else {
      ops.push({ kind: 'drop', a: a[i++] ?? '' });
    }
  }
  return ops;
}

/**
 * Up to `max` lines that differ between `original` and what the editor would
 * write for it, in the round-trip check's normal form, in file order. Lines
 * dropped and added at one place are paired as changed lines; a line only
 * added names the file line it would go above. When anything else changes, a
 * blank line added or dropped between blocks isn't listed: it is the spelling,
 * not the reason. Empty when nothing differs.
 */
export function roundTripChanges(original: string, roundTripped: string, max = 3): RoundTripChange[] {
  const a = normaliseForRoundTripCompare(original).split('\n');
  const b = normaliseForRoundTripCompare(roundTripped).split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const ops = lineOps(a.slice(start, endA), b.slice(start, endB));
  // The first non-blank file line at or after each op, for an added line's place.
  const nextFileLine: string[] = new Array<string>(ops.length + 1);
  let next = a.slice(endA).find((line) => line !== '') ?? '';
  nextFileLine[ops.length] = next;
  for (let k = ops.length - 1; k >= 0; k--) {
    const op = ops[k];
    if (op && op.kind !== 'add' && op.a !== '') next = op.a;
    nextFileLine[k] = next;
  }
  const all: RoundTripChange[] = [];
  for (let k = 0; k < ops.length; ) {
    const dropped: string[] = [];
    const added: string[] = [];
    const at = k;
    while (k < ops.length && ops[k]?.kind !== 'same') {
      const op = ops[k++];
      if (op?.kind === 'drop') dropped.push(op.a);
      else if (op?.kind === 'add') added.push(op.b);
    }
    // Text lines pair with text lines; blank lines added or dropped between
    // them are listed on their own.
    const droppedText = dropped.filter((line) => line !== '');
    const addedText = added.filter((line) => line !== '');
    for (let p = 0; p < Math.max(droppedText.length, addedText.length); p++) {
      if (p < droppedText.length) all.push({ original: droppedText[p] ?? '', filo: addedText[p] ?? '' });
      else all.push({ original: '', filo: addedText[p] ?? '', above: nextFileLine[k] ?? '' });
    }
    for (let p = addedText.length; p < added.length; p++) all.push({ original: '', filo: '', above: nextFileLine[k] ?? '' });
    for (let p = droppedText.length; p < dropped.length; p++) all.push({ original: '', filo: '' });
    if (k === at) k++;
  }
  const blankOnly = (c: RoundTripChange): boolean => c.original === '' && c.filo === '';
  const telling = all.filter((c) => !blankOnly(c));
  return (telling.length > 0 ? telling : all).slice(0, max);
}

/**
 * The 1-based line of `text` (a whole file or a body) that the round-trip
 * check reads as `normalisedLine`, from `fromLine` on; 0 when none does.
 */
export function lineOfRoundTripChange(text: string, normalisedLine: string, fromLine = 1): number {
  if (!normalisedLine) return 0;
  const lines = text.split(/\r?\n/);
  for (let i = Math.max(0, fromLine - 1); i < lines.length; i++) {
    if (normaliseForRoundTripCompare(lines[i] ?? '') === normalisedLine) return i + 1;
  }
  return 0;
}

function normaliseForRoundTripCompare(s: string): string {
  return s
    // CRLF / CR → LF
    .replace(/\r\n?/g, '\n')
    // Strip trailing whitespace per line
    .replace(/[ \t]+\n/g, '\n')
    // Normalise hard line breaks — Markdown encodes a hard break as either two+
    // trailing spaces (`…  \n`) or a trailing backslash (`…\\\n`).
    // prosemirror-markdown always serialises the backslash form, so a disk file
    // written with the two-space form (common in verse / dialogue) would never
    // compare equal and the document would be forced read-only. The
    // trailing-whitespace strip above already collapses the two-space form;
    // collapse the backslash form to match. Same transform on both sides ⇒ it
    // can't turn a genuine difference into a false match.
    .replace(/\\\n/g, '\n')
    // Code fences: the fence's character and length are cosmetic (Filo
    // fences with backticks, one longer than any backtick line in the code,
    // `codeFence.ts`), so a `~~~` or a four-backtick fence compares as ```,
    // keeping its info string.
    .replace(/^ {0,3}(?:`{3,}|~{3,})[ \t]*([^\n]*)$/gm, '```$1')
    // Normalise Setext H1/H2 to ATX equivalents so `# Foo` and `Foo\n===`
    // compare as equal — `tiptap-markdown` serialises every heading as ATX
    // regardless of the input syntax, so the un-normalised compare would
    // otherwise flag every Setext-style file as lossy.
    .replace(/^([^\n]+)\n=+[ \t]*$/gm, '# $1')
    .replace(/^([^\n]+)\n-+[ \t]*$/gm, '## $1')
    // Normalise thematic breaks (horizontal rules) — Markdown allows `---`,
    // `***`, `___`, and spaced variants (`* * *`, `- - -`); prosemirror-markdown
    // serialises a horizontal rule to one canonical form, so a disk file using
    // another marker (e.g. `* * *` scene breaks in fiction) would be flagged
    // lossy and opened read-only. Collapse every valid
    // thematic-break line to one form. Runs AFTER the Setext passes (so a `---`
    // directly under a text line is still read as a Setext H2, not a rule) and
    // BEFORE the list-bullet pass (so `* * *` isn't first mangled into `- * *`).
    .replace(/^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, '---')
    // Collapse 3+ blank lines into 2 (paragraph-separator normal form)
    .replace(/\n{3,}/g, '\n\n')
    // Normalise list bullet style — tiptap-markdown emits `*` or `-`
    // inconsistently depending on configuration. Treat them as equivalent.
    .replace(/^(\s*)[*+]\s/gm, '$1- ')
    // Normalise emphasis delimiters — prosemirror-markdown always serialises
    // emphasis as `*italic*` / `**bold**`, so a disk file using the underscore
    // forms (`_italic_` / `__bold__`, common in Obsidian) would otherwise be
    // flagged as a lossy round-trip and opened read-only. The same
    // transform runs on BOTH sides of the comparison, so it can never turn a
    // genuine difference into a false match. `__` before `_` so bold collapses
    // before the italic pass; intraword underscores (snake_case) lack the word
    // boundary the italic pass requires and are left untouched.
    .replace(/__([^_\n]+)__/g, '**$1**')
    .replace(/\b_([^_\n]+)_\b/g, '*$1*')
    // The ordered-list delimiter `1)` is serialised as `1.`;
    // cosmetic (the start number survives), so compare them as equal.
    .replace(/^(\s*\d+)\)(?=\s)/gm, '$1.')
    // GFM table SPACING only: strip the padding around `|`
    // and collapse a delimiter cell's dash run to `---`, KEEPING its colons,
    // so `:--` and `:---` (the form Filo writes) compare equal but a dropped
    // alignment would not.
    .replace(/^[ \t]*\|.*$/gm, (line) =>
      line
        .trim()
        .split('|')
        .map((cell) => cell.trim())
        .map((cell) => (/^:?-+:?$/.test(cell) ? cell.replace(/-+/, '---') : cell))
        .join('|'),
    )
    // Strip leading/trailing whitespace on the whole file
    .trim();
}

/**
 * Returns the editor's current markdown serialisation. Falls back to plain
 * text when the markdown storage is unavailable (e.g. an editor instantiated
 * without the `Markdown` extension — unit-test scaffolding).
 */
export function editorMarkdown(editor: Editor): string {
  if (!editor || editor.isDestroyed) return '';
  // `editor.storage` is undefined on lightweight stubs / non-tiptap-markdown
  // editors; access defensively so the lossy-detection caller can swallow a
  // missing-storage scenario without crashing.
  const storage = (editor as { storage?: { markdown?: { getMarkdown: () => string; parser?: { md?: MarkdownRenderer } } } })
    .storage?.markdown;
  if (storage && typeof storage.getMarkdown === 'function') {
    const markdown = storage.getMarkdown();
    // Only the escapes the note's own parser needs (`minimalEscapes.ts`).
    const md = storage.parser?.md;
    return md ? withMinimalEscapes(markdown, md, loadedLines.get(editor)) : markdown;
  }
  if (typeof (editor as { getText?: () => string }).getText === 'function') {
    return (editor as { getText: () => string }).getText();
  }
  return '';
}

/**
 * Why the assembler kept a frontmatter block verbatim instead of applying an
 * edit. `lossy`: the block parses, but the only way to apply the edit (a full
 * rewrite) would change values the edit didn't touch.
 */
export type FrontmatterRefusal = 'unparseable' | 'not-properties' | 'lossy';

export interface AssembleMarkdownOptions {
  /**
   * Re-emit a leading UTF-8 BOM (`﻿`) before the frontmatter / body.
   * Callers that want to preserve the user's original file encoding pass
   * `bom: parsed.hadBom`. Defaults to `false` (clean UTF-8).
   */
  bom?: boolean;
  /**
   * The verbatim frontmatter source captured at parse time
   * (`ParsedMarkdownDocument.rawFrontmatter`). Used two ways:
   *
   *  - Clean passthrough: with `frontmatterDirty === false`, the FM bytes
   *    are emitted verbatim (comments / key order / line endings preserved)
   *    instead of re-dumping the parsed object.
   *  - Safety net: when the parsed object is empty but a non-empty raw
   *    block was supplied (unparseable / non-object YAML), the raw block is
   *    written back so a fence we couldn't parse is never silently dropped.
   *
   * Omitted by callers without disk-captured bytes (new-file creation), in
   * which case the parsed object is dumped.
   */
  rawFrontmatter?: string;
  /**
   * `false` asserts the frontmatter object has NOT changed
   * since `rawFrontmatter` was captured, so the raw bytes are emitted
   * verbatim. `true` (or omitted) means the object may have diverged, so it
   * is re-serialised. Only meaningful alongside `rawFrontmatter`.
   */
  frontmatterDirty?: boolean;
  /**
   * The disk-baseline frontmatter source (persists across mutations, unlike
   * `rawFrontmatter`). On a dirty re-serialise, the live object is diffed
   * against this and only the changed keys are rewritten, so comments / key
   * order / quoting on untouched keys survive. Omitted for new files (no
   * baseline) ⇒ a full dump.
   */
  originalFrontmatter?: string;
  /**
   * The file's REAL line ending, captured from the full raw file at hydrate time
   * (`NoteText.eol`, threaded by the note writer). Needed because a single-line FM
   * (`title: x`) carries no internal `\r\n`, so detection from the FM source
   * alone would flip a CRLF file's frontmatter to LF. When supplied it wins;
   * otherwise `detectFrontmatterEol` falls back to detection.
   *
   * `'\r\n'` also normalises the body to CRLF, so a deliberately mixed-EOL
   * file becomes uniformly CRLF on its first edit.
   */
  eol?: '\r\n' | '\n';
  /**
   * Invoked when the assembler REFUSES a frontmatter edit (the keep-raw branch
   * below): `'unparseable'` when the on-disk YAML doesn't parse or can't be
   * modelled, `'not-properties'` when it parses but isn't a mapping (text
   * between two leading `---` rules). The edit is dropped to protect the
   * block; this hook lets the note writer surface a toast instead of the edit
   * vanishing as a silent success. Pure-assemble callers omit it.
   */
  onFrontmatterRefused?: (reason: FrontmatterRefusal) => void;
}

/**
 * Reattaches the `---` fences around a verbatim frontmatter block, applying the
 * file's resolved line ending to the fences (so a CRLF file round-trips
 * faithfully) and appending a trailing newline after the body when it
 * lacks one. `eol` is resolved by `detectFrontmatterEol`.
 */
function emitWithRawFrontmatter(
  bomPrefix: string,
  rawFrontmatter: string,
  body: string,
  eol: '\r\n' | '\n',
): string {
  const trailing = body.length === 0 || body.endsWith('\n') ? '' : eol;
  return `${bomPrefix}---${eol}${rawFrontmatter}${eol}---${eol}${body}${trailing}`;
}

/**
 * The file's line ending for the frontmatter emit paths.
 * `patchFrontmatterSourceCst` normalises the FM source to LF, so the caller must
 * restore it or a CRLF file's metadata edit silently flips its frontmatter to LF.
 *
 * Prefers the file's real eol (`options.eol`). Otherwise the file is CRLF if ANY
 * captured source — baseline FM, verbatim FM, or body — carries `\r\n`; a
 * single-line FM alone has no internal `\r\n` and can't be trusted.
 */
function detectFrontmatterEol(options: AssembleMarkdownOptions, body: string): '\r\n' | '\n' {
  if (options.eol) return options.eol;
  if (
    options.originalFrontmatter?.includes('\r\n') ||
    options.rawFrontmatter?.includes('\r\n') ||
    body.includes('\r\n')
  ) {
    return '\r\n';
  }
  return '\n';
}

/**
 * Builds a `.md` file's full contents from a frontmatter object + a body.
 * Emits the file with a YAML frontmatter block iff the frontmatter is
 * non-empty. Tags are sourced exclusively from the frontmatter object — the
 * body is written verbatim, including any decorative inline `#foo` runs.
 */
export function assembleMarkdownFile(
  frontmatter: Record<string, unknown>,
  editorBody: string,
  options: AssembleMarkdownOptions = {},
): string {
  // The editor serialises LF. When the caller supplies the file's real eol as
  // CRLF, the body follows it too; otherwise a CRLF note comes back with CRLF
  // frontmatter over an LF body (or wholly LF when it has no frontmatter).
  // Only an explicit `eol` triggers this, never the detection fallback, so a
  // caller without a hydrate-sniffed eol writes its body verbatim.
  const body = options.eol === '\r\n' ? editorBody.replace(/\r?\n/g, '\r\n') : editorBody;
  const fm = { ...frontmatter };

  // The set of top-level keys present in the disk-baseline source. Gates BOTH
  // clean passes below: a key the user kept on disk must never be dropped from
  // the object by a cosmetic clean, or the CST engine sees it as DELETED and
  // splices the line out on an UNRELATED edit.
  const baselineKeys = options.originalFrontmatter
    ? frontmatterSourceKeys(options.originalFrontmatter)
    : null;

  // Drop an EMPTY tags array only when `tags` is NOT already on disk — otherwise
  // editing an unrelated field on a file carrying `tags: []` (a common
  // Obsidian/template shape) would delete the key. Without a baseline (new file
  // / cleared in-memory tags) the cosmetic drop stands.
  if (
    'tags' in fm &&
    Array.isArray(fm.tags) &&
    (fm.tags as unknown[]).length === 0 &&
    !baselineKeys?.has('tags')
  ) {
    delete fm.tags;
  }

  // Preserve a present-but-empty key that already exists on disk (`aliases:`,
  // `cssclasses:` parse to `null`); dropping it would make the CST engine splice
  // the line out whenever an UNRELATED field is edited. Only drop a null when its
  // key is NOT in the disk baseline (a cleared / never-persisted key we must not
  // write back as a bare `key:`). `undefined` is always dropped.
  for (const key of Object.keys(fm)) {
    const v = fm[key];
    if (v !== undefined && v !== null) continue;
    if (v === null && baselineKeys?.has(key)) continue;
    delete fm[key];
  }

  const bomPrefix = options.bom ? '﻿' : '';
  const rawFrontmatter = options.rawFrontmatter ?? '';
  const rawHasContent = rawFrontmatter.trim().length > 0;
  const objectHasKeys = Object.keys(fm).length > 0;

  // Clean body-only save: the frontmatter object is unchanged since it was
  // parsed, so emit the original bytes verbatim (comments, key order, and line
  // endings preserved) rather than re-dumping the object. The fences honour the
  // file's real eol.
  if (options.frontmatterDirty === false && rawHasContent) {
    return emitWithRawFrontmatter(bomPrefix, rawFrontmatter, body, detectFrontmatterEol(options, body));
  }

  if (objectHasKeys) {
    // With the disk-baseline source in hand, re-serialise source-preservingly:
    // rewrite only the changed keys, so comments / key order / quoting on
    // untouched keys survive. Falls back to a full dump for new files (no
    // baseline) or a block the engine can't parse as a mapping.
    const patched = options.originalFrontmatter
      ? patchFrontmatterSourceCst(options.originalFrontmatter, fm)
      : null;
    // The engine refused a PRESENT on-disk block. If the block is genuinely
    // UNPARSEABLE (tabs, duplicate keys, a stray `---`), a full dump would
    // discard it — total frontmatter loss. Refuse the metadata edit instead and
    // keep the raw bytes verbatim (the body still saves).
    //
    // A refusal on a valid MAPPING (flow-mapping root, anchor/alias on a touched
    // key) keeps the dump fallback: every key the block held is in `fm`.
    //
    // A root that parses but isn't a mapping (a paragraph between two leading
    // `---` rules reads as a scalar; a list; only comments) is the second
    // keep-raw case: `fm` holds none of its text, so a dump would delete it.
    //
    // A NON-SCALAR mapping key (`[a, b]: x`) is the third: it parses, but
    // `toJS()` stringifies the key, so a dump would change the key's meaning.
    // Without a baseline, the verbatim block is what a dump would replace.
    const original = options.originalFrontmatter ?? options.rawFrontmatter;
    if (
      patched === null &&
      original &&
      original.trim().length > 0 &&
      (!frontmatterSourceParses(original) ||
        !frontmatterSourceRootIsMapping(original) ||
        frontmatterSourceHasNonScalarKey(original))
    ) {
      console.warn(
        '[markdownSync] Refusing to overwrite unparseable/unmodelable frontmatter; metadata edit not applied. Fix the YAML on disk to re-enable property writes.',
      );
      // Surface the dropped edit to the user (the note writer wires a toast).
      options.onFrontmatterRefused?.(
        frontmatterSourceParses(original) && !frontmatterSourceRootIsMapping(original)
          ? 'not-properties'
          : 'unparseable',
      );
      return emitWithRawFrontmatter(bomPrefix, original, body, detectFrontmatterEol(options, body));
    }
    // The full-dump fallback also uses the `yaml` package (single parser).
    // `lineWidth: 0` disables folding.
    const yamlText = patched ?? new Document(fm).toString({ lineWidth: 0 }).trimEnd();
    // The dump writes `fm`, the core-schema JS value, so a key the change never
    // touched can come out saying something else (`02134` → `2134`, `1.10` →
    // `1.1`, an explicit tag dropped). Then the edit is refused and the block
    // kept verbatim, as for a block that doesn't parse.
    if (patched === null && original && original.trim().length > 0 && !dumpPreservesUntouched(original, yamlText, fm)) {
      console.warn('[markdownSync] Refusing a frontmatter rewrite that would change untouched values; metadata edit not applied.');
      options.onFrontmatterRefused?.('lossy');
      return emitWithRawFrontmatter(bomPrefix, original, body, detectFrontmatterEol(options, body));
    }
    // Re-apply the file's line ending to the FM block + fences. The CST engine
    // and the dump both emit LF; hard-coding `\n` would flip a CRLF file's
    // frontmatter to LF on every metadata edit. The body keeps its own endings;
    // we only re-apply eol to the parts THIS function emits.
    const eol = detectFrontmatterEol(options, body);
    const fmBlock = `---\n${yamlText}\n---\n`.replace(/\n/g, eol);
    const trailing = body.endsWith('\n') ? '' : eol;
    return `${bomPrefix}${fmBlock}${body}${trailing}`;
  }

  // The parsed object is empty but the source HAD a
  // frontmatter block. The raw bytes alone can't tell apart two cases that need
  // OPPOSITE handling, so we discriminate on whether the CST engine can model
  // the source as a BLOCK MAPPING to clear (`patchFrontmatterSourceCst(_, {})`):
  //   - Engine returns `null` — the source is UNPARSEABLE (malformed YAML) OR a
  //     NON-MAPPING root (a bare scalar / sequence / flow mapping / anchored
  //     key): there are no keys the app ever read to "empty", so never drop a
  //     fence we couldn't turn into a block mapping — re-emit it untouched.
  //   - Engine returns a string — the source IS a block mapping the user
  //     cleared every key from. Honour the deletion (the engine drops the keys
  //     and keeps any standalone comment-only remainder) instead of reverting
  //     to the raw bytes, which would silently undo the clear.
  if (rawHasContent) {
    const eol = detectFrontmatterEol(options, body);
    const emptied = patchFrontmatterSourceCst(rawFrontmatter, {});
    if (emptied === null) {
      return emitWithRawFrontmatter(bomPrefix, rawFrontmatter, body, eol);
    }
    const trailing = body.length === 0 || body.endsWith('\n') ? '' : eol;
    // A comment-only remainder is still meaningful (the user kept a note) →
    // re-wrap it in fences; an empty remainder → emit no FM block at all.
    if (emptied.trim().length > 0) {
      const fmBlock = `---\n${emptied}\n---\n`.replace(/\n/g, eol);
      return `${bomPrefix}${fmBlock}${body}${trailing}`;
    }
    return `${bomPrefix}${bodyWithoutFenceLookalike(body)}${trailing}`;
  }

  // Genuinely no frontmatter.
  return `${bomPrefix}${bodyWithoutFenceLookalike(body)}`;
}

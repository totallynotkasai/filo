import { parseDocument, Document } from 'yaml';
import type { Editor } from '@tiptap/core';
import { resetEditorHistory } from './editorHistory';
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
 * Splits a `.md` file's text into structured frontmatter + body. Fails safe to
 * an empty frontmatter object on any parse error (the raw block is still threaded
 * out via `rawFrontmatter` so an unparseable fence round-trips without data loss).
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

  let frontmatter: Record<string, unknown> = {};
  try {
    // Parse with the `yaml` package so the read produces the SAME object the
    // source-preserving write engine (`frontmatterCstModel`) diffs against — an
    // untouched key can never look "changed" through a cross-parser type
    // mismatch (e.g. `1_000`). The core schema resolves no timestamp or merge
    // tag, so `2026-06-01` stays a string and `<<: *a` a literal `<<`. On ANY
    // error (or a non-object root) fail safe to `{}`; the raw block is still
    // threaded out below so the fence is kept.
    // logLevel 'error': a collection key (`[a, b]: x`) is stringified by
    // toJS() on purpose; the package's warning about it is noise.
    const doc = parseDocument(block.source, { logLevel: 'error' });
    if (doc.errors.length === 0) {
      const loaded = doc.toJS();
      if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) {
        frontmatter = loaded as Record<string, unknown>;
      }
    }
  } catch {
    frontmatter = {};
  }

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
 * highlight `==…==`, etc.).
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
): { lossy: boolean } {
  if (!editor || editor.isDestroyed) return { lossy: false };
  const emit = options.emitUpdate ?? false;
  const preserveSelection = options.preserveSelection ?? false;

  let snapshot: { from: number; to: number; hadFocus: boolean } | null = null;
  if (preserveSelection) {
    const { from, to } = editor.state.selection;
    snapshot = { from, to, hadFocus: editor.isFocused };
  }

  const originalBody = body ?? '';

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
  const hasMarkdownStorage =
    (editor as { storage?: { markdown?: unknown } }).storage?.markdown !== undefined;
  if (originalBody.length > 0 && hasMarkdownStorage) {
    try {
      const roundTripped = editorMarkdown(editor);
      lossy = isLossyMarkdownRoundTrip(originalBody, roundTripped);
    } catch {
      lossy = false;
    }
  }
  return { lossy };
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
 * Exported for direct unit-testing in `markdownSync.test.ts`. Production
 * call site is `loadMarkdownIntoEditor` above.
 */
export function isLossyMarkdownRoundTrip(original: string, roundTripped: string): boolean {
  return normaliseForRoundTripCompare(original) !== normaliseForRoundTripCompare(roundTripped);
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
    // and collapse a delimiter cell's dash run to `---`, KEEPING its colons.
    // tiptap drops column alignment (`:--` → `---`), so an aligned table still
    // compares different (stays lossy) — only padding differences are masked.
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
  const storage = (editor as { storage?: { markdown?: { getMarkdown: () => string } } })
    .storage?.markdown;
  if (storage && typeof storage.getMarkdown === 'function') {
    return storage.getMarkdown();
  }
  if (typeof (editor as { getText?: () => string }).getText === 'function') {
    return (editor as { getText: () => string }).getText();
  }
  return '';
}

/** Why the assembler kept a frontmatter block verbatim instead of applying an edit. */
export type FrontmatterRefusal = 'unparseable' | 'not-properties';

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
    const original = options.originalFrontmatter;
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

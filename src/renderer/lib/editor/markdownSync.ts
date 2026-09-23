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
} from '../vault/frontmatterCstModel';

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
 * NOTE (Phase 6.3): the `yaml` package is the single YAML library for the
 * frontmatter read AND the source-preserving write engine, so the object the
 * read produces and the object the write diffs against come from one parser
 * (no cross-parser "looks changed but isn't" — the M2 class). js-yaml was
 * dropped from this module; `gray-matter` was removed earlier because its
 * `stringify` path references the Node `Buffer` global, undefined in the
 * Vite-bundled renderer (`yaml`'s serialiser needs no Buffer either).
 */

export interface ParsedMarkdownDocument {
  /** Raw frontmatter object (parsed via the `yaml` package's `parseDocument().toJS()`). */
  frontmatter: Record<string, unknown>;
  /**
   * Audit2 / 1.1 + 1.2 — the verbatim YAML source between the `---` fences
   * (no fences, no leading/trailing newline), exactly as it sat on disk. The
   * empty string when the source had no frontmatter block.
   *
   * Threaded so the write path can (a) write an unparseable / non-object
   * block back untouched instead of silently dropping a fence it couldn't
   * turn into keys [1.1], and (b) round-trip comments / key order / line
   * endings byte-for-byte on a body-only save [1.2]. Pass it back via
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
   * Phase 1 / 1.1 — the BOM is stripped before frontmatter detection so the
   * fenced regex matches files saved by Windows editors (Notepad, the
   * legacy Office "Save As UTF-8" path) that prefix the byte-order mark.
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
 * Phase 1 / 1.1 — strips a leading UTF-8 BOM (`﻿`) before the regex so
 * Notepad-saved files don't lose their frontmatter. `hadBom` is returned so
 * the caller can re-emit the mark via `assembleMarkdownFile({ bom: true })`.
 */
export function parseMarkdownFile(raw: string): ParsedMarkdownDocument {
  if (!raw) return { frontmatter: {}, rawFrontmatter: '', body: '', hasFrontmatter: false, hadBom: false };

  const hadBom = raw.charCodeAt(0) === 0xfeff;
  const text = hadBom ? raw.slice(1) : raw;

  if (!text) return { frontmatter: {}, rawFrontmatter: '', body: '', hasFrontmatter: false, hadBom };

  // 6.4.M9 — `[ \t]*` tolerates trailing horizontal whitespace on either fence
  // line (`--- `), which editors / linters routinely leave. Without it such a
  // file parsed as "no frontmatter", leaking the YAML into the body.
  //
  // 6.4.M10 (refuted — kept as a note): the non-greedy `([\s\S]*?)` stops at the
  // FIRST `---` line, which the audit feared could mis-segment a `---` embedded
  // in a multi-line scalar. It cannot: a `---` at column 0 is a YAML
  // document-boundary marker — BOTH js-yaml and the `yaml` package THROW rather
  // than parse across it — so it can never be valid mapping content; and a `---`
  // that IS valid scalar content is indented, so `\r?\n---` (column 0) never
  // matches it. The first-fence split is therefore consistent with YAML's own
  // document model. No failing test could be constructed.
  //
  // 3.1 (Audit-18) — the interior group is OPTIONAL (`(?:…\r?\n)?`) so a
  // zero-interior fence pair (`---\n---\n`, a common empty-frontmatter
  // placeholder) parses as an EMPTY frontmatter block (`hasFrontmatter: true`,
  // `rawFrontmatter: ''`) instead of "no frontmatter". Without it the
  // tag-rewriter saw no frontmatter and PREPENDED a second `---` block above the
  // orphaned fences (demoting them into the body). The group is still group 1
  // (undefined → `''` below) and the body is still group 2.
  const fenced = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*\r?\n?([\s\S]*)$/.exec(text);
  if (!fenced) {
    return { frontmatter: {}, rawFrontmatter: '', body: text, hasFrontmatter: false, hadBom };
  }

  let frontmatter: Record<string, unknown> = {};
  try {
    // Phase 6.3 — parse with the `yaml` package so the read produces the SAME
    // object the source-preserving write engine (`frontmatterCstModel`) diffs
    // against: one parser on both sides, so an untouched key can never look
    // "changed" through a cross-parser type mismatch (the M2 class — `1_000` /
    // `0b1010` are STRINGS to the `yaml` package but NUMBERS to js-yaml CORE).
    // Like the prior js-yaml CORE_SCHEMA read this keeps DI-01 / DI-05 intact:
    // the `yaml` core schema resolves no timestamp or merge tag, so `2026-06-01`
    // stays a `string` and `<<: *a` a literal `<<`. `doc.errors` catches
    // duplicate keys / bad indentation; on ANY error (or a non-object / array /
    // scalar root) we fail safe to `{}` — never corrupt — and the raw block is
    // still threaded out below so a fence we couldn't turn into keys is kept.
    const doc = parseDocument(fenced[1] ?? '');
    if (doc.errors.length === 0) {
      const loaded = doc.toJS();
      if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) {
        frontmatter = loaded as Record<string, unknown>;
      }
    }
  } catch {
    frontmatter = {};
  }

  // 1.1 — keep the raw YAML source even when it didn't parse into an object,
  // so the write path can preserve a fence it couldn't turn into keys.
  return { frontmatter, rawFrontmatter: fenced[1] ?? '', body: fenced[2] ?? '', hasFrontmatter: true, hadBom };
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
 * Phase 27 / A4 — returns a `lossy` flag set when the body fails to round-trip
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
  // TRUE. The TipTap 2 boolean form (`setContent(x, false)`) no longer means
  // "don't emit" — it would fire onUpdate on every load → a phantom write of a
  // file the user never edited. Pinned by markdownBodyRoundTrip.test.ts.
  //
  // Audit-19 MD-1 — a load is NOT an undoable edit. Core `setContent` never sets
  // `addToHistory`, so Ctrl+Z right after opening a note emptied it (and the
  // empty body was autosaved). The chain shares ONE transaction, so the meta
  // covers the replace step; `resetEditorHistory` below then drops any earlier
  // history so undo can't cross a hydrate or reload. This is the ONLY
  // `setContent` in src/renderer (pinned by ci:editor-body-discipline).
  editor
    .chain()
    .command(({ tr }) => {
      tr.setMeta('addToHistory', false);
      return true;
    })
    .setContent(contentToLoad, { emitUpdate: emit })
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

  // Audit-19 MD-1 — a full-document load is a history boundary (see editorHistory.ts).
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
    // compare equal and the document would be forced read-only (Audit-10 M5).
    // The trailing-whitespace strip above already collapses the two-space form to
    // a bare newline; collapse the backslash form to match, so both hard-break
    // encodings normalise to the same thing. Same transform on both sides ⇒ it
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
    // lossy and opened read-only (Audit-10 M5). Collapse every valid
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
    // flagged as a lossy round-trip and opened read-only (audit 2.4). The same
    // transform runs on BOTH sides of the comparison, so it can never turn a
    // genuine difference into a false match. `__` before `_` so bold collapses
    // before the italic pass; intraword underscores (snake_case) lack the word
    // boundary the italic pass requires and are left untouched.
    .replace(/__([^_\n]+)__/g, '**$1**')
    .replace(/\b_([^_\n]+)_\b/g, '*$1*')
    // Audit-19 UX-1 5e — the ordered-list delimiter `1)` is serialised as `1.`;
    // cosmetic (the start number survives), so compare them as equal.
    .replace(/^(\s*\d+)\)(?=\s)/gm, '$1.')
    // Audit-19 UX-1 5d — GFM table SPACING only: strip the padding around `|`
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

export interface AssembleMarkdownOptions {
  /**
   * Stable document id (Filo's `contentId`) to persist as `id` in the
   * frontmatter. Opt-in — autosave does NOT pass this so the user never
   * sees a `id: tile_xxxx` line surfaced at the top of their .md file.
   * Reserved for any future re-import flow that wants a durable identity
   * for the file across external moves.
   *
   * Non-destructive — if the frontmatter already has an `id` it is left
   * untouched (callers / external editors take priority).
   */
  contentId?: string;
  /**
   * Phase 1 / 1.1 — re-emit a leading UTF-8 BOM (`﻿`) before the
   * frontmatter / body. Callers that want to preserve the user's original
   * file encoding pass `bom: parsed.hadBom` when assembling. Defaults to
   * `false` so existing call sites continue to emit a clean UTF-8 file.
   */
  bom?: boolean;
  /**
   * Audit2 / 1.1 + 1.2 — the verbatim frontmatter source captured at parse
   * time (`ParsedMarkdownDocument.rawFrontmatter`). Used two ways:
   *
   *  - 1.2 clean passthrough: with `frontmatterDirty === false`, the FM bytes
   *    are emitted verbatim (comments / key order / line endings preserved)
   *    instead of re-dumping the parsed object.
   *  - 1.1 safety net: when the parsed object is empty but a non-empty raw
   *    block was supplied (unparseable / non-object YAML), the raw block is
   *    written back so a fence we couldn't parse is never silently dropped.
   *
   * Omitted by callers without disk-captured bytes (new-file creation), in
   * which case the parsed object is dumped exactly as before.
   */
  rawFrontmatter?: string;
  /**
   * Audit2 / 1.2 — `false` asserts the frontmatter object has NOT changed
   * since `rawFrontmatter` was captured, so the raw bytes are emitted
   * verbatim. `true` (or omitted) means the object may have diverged, so it
   * is re-serialised. Only meaningful alongside `rawFrontmatter`.
   */
  frontmatterDirty?: boolean;
  /**
   * Audit2 4.8 — the disk-baseline frontmatter source (persists across
   * mutations, unlike `rawFrontmatter`). On a dirty re-serialise, the live
   * object is diffed against this and only the changed keys are rewritten, so
   * comments / key order / quoting on untouched keys survive (the source-
   * preserving fix for the lossy round-trip). Omitted for new files (no
   * baseline) ⇒ a full dump as before.
   */
  originalFrontmatter?: string;
  /**
   * A8-M1 — the file's REAL line ending, captured once from the full raw file
   * content at hydrate time (`FileState.eol`, threaded by the gateway). The
   * source-preserving detection (`detectFrontmatterEol`) infers eol from the
   * frontmatter source, but a single-line FM (`title: x`) carries no internal
   * `\r\n`, so on a CRLF file it mis-detects LF and flips the frontmatter to LF
   * on the first metadata edit — the hole in the Audit-7 H2 fix. When supplied
   * this wins outright; callers without it (new-file creation) fall back to
   * detection (→ LF, unchanged).
   */
  eol?: '\r\n' | '\n';
  /**
   * Audit-11 N1 — invoked when the assembler REFUSES a frontmatter edit
   * because the on-disk YAML is genuinely unparseable (the data-loss-avoiding
   * keep-raw branch below). The metadata edit is intentionally dropped to
   * protect the existing broken-but-present YAML; this hook lets the write
   * gateway surface a user-facing toast ("couldn't update metadata — fix the
   * YAML") instead of the edit vanishing as a silent success. Pure-assemble
   * callers (unit tests, body-only saves) omit it — refusal then just keeps the
   * raw bytes exactly as before.
   */
  onFrontmatterRefused?: () => void;
}

/**
 * Reattaches the `---` fences around a verbatim frontmatter block, applying the
 * file's resolved line ending to the fences (so a CRLF file round-trips
 * faithfully — 1.2) and appending a trailing newline after the body when it
 * lacks one. `eol` is resolved by `detectFrontmatterEol` so the gateway-threaded
 * `options.eol` and the single-line-FM fallback (A8-M1) both apply here too.
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
 * H2 (Audit-7) — the file's line ending for the dirty-frontmatter emit path.
 * `patchFrontmatterSourceCst` normalises the FM source to LF (its docstring says
 * the caller re-applies the file's ending), so the dirty branch must restore it
 * or a CRLF file's metadata edit silently flips its frontmatter to LF.
 *
 * A8-M1 — prefer the file's REAL eol when the gateway threaded it from the
 * hydrate read (`options.eol`). The detection fallback below is for callers that
 * don't supply it (new-file creation → LF). The previous detection short-
 * circuited on a truthy `originalFrontmatter || rawFrontmatter`, but a SINGLE-
 * line frontmatter source (`title: x`) carries no internal `\r\n`, so a CRLF
 * file with one-line FM was mis-detected as LF — fences/FM emitted LF while the
 * body stayed CRLF (mixed), or the whole file flipped LF when an editor edit
 * dirtied the FM. Fix: treat the file as CRLF if ANY captured source — the
 * baseline FM, the verbatim FM, or the body — carries a `\r\n`, instead of
 * letting a one-line FM short-circuit the CRLF-bearing body.
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
  body: string,
  options: AssembleMarkdownOptions = {},
): string {
  const fm = { ...frontmatter };

  // 1.1 — the set of top-level keys present in the disk-baseline source. Gates
  // BOTH clean passes below: a key the user kept on disk must never be dropped
  // from the object by a cosmetic clean, or the CST engine sees it as DELETED
  // and splices the line out on an UNRELATED edit.
  const baselineKeys = options.originalFrontmatter
    ? frontmatterSourceKeys(options.originalFrontmatter)
    : null;

  // 5.1 (Audit-16) — drop an EMPTY tags array only when `tags` is NOT already on
  // disk. The unconditional drop predated the 1.1 baseline rescue (which covers
  // only `null` values — `tags: []` parses to an empty ARRAY) and ran even on the
  // Phase-4 delta path where `fm` is the FRESH disk read, so editing an
  // UNRELATED field on a file carrying `tags: []` (a common Obsidian/template
  // shape) silently deleted the key. A baseline `tags: []` is kept as-is so the
  // engine byte-preserves the original line; without a baseline (new file /
  // cleared in-memory tags) the cosmetic drop stands.
  if (
    'tags' in fm &&
    Array.isArray(fm.tags) &&
    (fm.tags as unknown[]).length === 0 &&
    !baselineKeys?.has('tags')
  ) {
    delete fm.tags;
  }

  if (options.contentId && !fm.id) {
    fm.id = options.contentId;
  }

  // 1.1 — preserve a present-but-empty key that already exists on disk. Such a
  // key (`aliases:`, `cssclasses:`, a bare `subtitle:`) parses to `null`;
  // dropping it here would make the CST engine below see it as DELETED and
  // splice the line out, silently erasing a key the user kept whenever an
  // UNRELATED field is edited (Finding #2). So only drop a null/undefined value
  // when its key is NOT in the disk baseline — a genuinely cleared / never-
  // persisted key we must not write back as a bare `key:`. `undefined` (never a
  // YAML value) is always dropped; a baseline `null` is kept as-is so the engine
  // byte-preserves the original empty-key line.
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

  // 1.2 — clean body-only save: the frontmatter object is unchanged since it
  // was parsed, so emit the original bytes verbatim (comments, key order, and
  // line endings preserved) rather than re-dumping the object. A8-M1 — the
  // fences honour the file's real eol (gateway-threaded or detected incl. the
  // body), closing the single-line-FM hole that flipped CRLF fences to LF.
  if (options.frontmatterDirty === false && rawHasContent) {
    return emitWithRawFrontmatter(bomPrefix, rawFrontmatter, body, detectFrontmatterEol(options, body));
  }

  if (objectHasKeys) {
    // Audit2 4.8 — with the disk-baseline source in hand, re-serialise
    // source-preservingly: diff the live object against it and rewrite only the
    // changed keys, so comments / key order / quoting on untouched keys survive
    // (fixes the lossy YAML round-trip). Falls back to a full dump for new files
    // (no baseline) or a block the engine can't parse as a mapping.
    const patched = options.originalFrontmatter
      ? patchFrontmatterSourceCst(options.originalFrontmatter, fm)
      : null;
    // 1.5 — the engine refused a PRESENT on-disk block (`patched === null` with a
    // baseline in hand). When that refusal is because the block is genuinely
    // UNPARSEABLE (malformed YAML: tabs, duplicate keys, a stray `---`), a full
    // dump of the live object would DISCARD the broken-but-present block — total
    // frontmatter loss (Finding #4). Refuse the metadata edit instead: keep the
    // raw bytes verbatim (the body still saves). The dropped edit is the safe
    // trade — the user's existing YAML is never destroyed.
    //
    // A refusal on VALID YAML (a flow-mapping root, an anchor/alias on a touched
    // key — L27, or a non-mapping root) keeps the long-standing dump fallback:
    // there the dump preserves the data (or replaces a block the app never read
    // as metadata). `frontmatterSourceParses` is false only for a true parse
    // failure, so the keep-raw path is scoped to exactly the data-loss case.
    //
    // 5.4 (Audit-16) — a NON-SCALAR mapping key (`[a, b]: x`) is the second
    // keep-raw case: it parses fine, but `toJS()` STRINGIFIED the key, so the
    // dump would rewrite it as its quoted string twin — a semantic key change,
    // not a data-preserving reformat. Refuse the edit and keep the bytes.
    const original = options.originalFrontmatter;
    if (
      patched === null &&
      original &&
      original.trim().length > 0 &&
      (!frontmatterSourceParses(original) || frontmatterSourceHasNonScalarKey(original))
    ) {
      console.warn(
        '[markdownSync] Refusing to overwrite unparseable/unmodelable frontmatter; metadata edit not applied. Fix the YAML on disk to re-enable property writes.',
      );
      // Audit-11 N1 — surface the dropped edit to the user (the gateway wires a
      // toast). Without this the metadata change vanished as a silent success.
      options.onFrontmatterRefused?.();
      return emitWithRawFrontmatter(bomPrefix, original, body, detectFrontmatterEol(options, body));
    }
    // Phase 6.3 / D3 — the full-dump fallback (new file with no baseline, or a
    // block the engine refused) serialises with the `yaml` package too, so the
    // whole module is single-parser. A new file has no source to preserve, so the
    // dump is lossless; `lineWidth: 0` disables folding (matching the prior
    // `js-yaml` `lineWidth: -1`).
    const yamlText = patched ?? new Document(fm).toString({ lineWidth: 0 }).trimEnd();
    // H2 (Audit-7) — re-apply the file's line ending to the FM block + fences.
    // The CST engine emits LF (and so does the dump fallback); hard-coding `\n`
    // here flipped a CRLF file's frontmatter to LF on every metadata edit —
    // a permanently mixed file (CRLF body + LF FM via the Properties popup, which
    // sources `body` from diskBody verbatim), or a whole-file CRLF→LF flip when
    // an editor edit also dirtied the FM (tiptap bodies are already LF). The body
    // keeps its own endings; we only re-apply eol to the parts THIS function emits.
    const eol = detectFrontmatterEol(options, body);
    const fmBlock = `---\n${yamlText}\n---\n`.replace(/\n/g, eol);
    const trailing = body.endsWith('\n') ? '' : eol;
    return `${bomPrefix}${fmBlock}${body}${trailing}`;
  }

  // 1.1 / L1 (Audit-12) — the parsed object is empty but the source HAD a
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
  //     to the raw bytes. The old safety net re-emitted the original block
  //     unconditionally, silently undoing the clear; masked in prod by the
  //     auto-`id` injection keeping tile/doc `fm` non-empty.
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
    return `${bomPrefix}${body}${trailing}`;
  }

  // Genuinely no frontmatter.
  return `${bomPrefix}${body}`;
}

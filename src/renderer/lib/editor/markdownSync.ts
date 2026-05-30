import yaml from 'js-yaml';
import type { Editor } from '@tiptap/core';
import {
  encodeEmptyParagraphs,
  stripEmptyParagraphSentinels,
  EMPTY_PARAGRAPH_SENTINEL,
  type BlockTokenizer,
} from './emptyParagraphs';

/**
 * Markdown round-trip helpers for TipTap editors backed by `.md` files.
 *
 * Loading: `parseMarkdownFile` splits frontmatter from body via js-yaml,
 * then `loadMarkdownIntoEditor` tells the editor to render the body. The
 * `tiptap-markdown` extension installed in `createEditor.ts` parses the
 * markdown string and produces the prose-mirror document.
 *
 * Saving: `editorMarkdown` calls `editor.storage.markdown.getMarkdown()` to
 * serialise the document back to markdown. `assembleMarkdownFile` combines
 * that body with the frontmatter (merging in any inline-tag union from the
 * body) and emits the full file contents that should be written to disk.
 *
 * NOTE: js-yaml is the only YAML library used here. `gray-matter` was
 * removed because its `stringify` path references the Node `Buffer` global,
 * which is undefined in the Vite-bundled renderer.
 */

export interface ParsedMarkdownDocument {
  /** Raw frontmatter object (parsed via js-yaml). */
  frontmatter: Record<string, unknown>;
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
 * Splits a `.md` file's text into structured frontmatter + body. Falls back
 * to gray-matter on any parse error so unusual frontmatter shapes still
 * round-trip without data loss.
 *
 * Phase 1 / 1.1 — strips a leading UTF-8 BOM (`﻿`) before the regex so
 * Notepad-saved files don't lose their frontmatter. `hadBom` is returned so
 * the caller can re-emit the mark via `assembleMarkdownFile({ bom: true })`.
 */
export function parseMarkdownFile(raw: string): ParsedMarkdownDocument {
  if (!raw) return { frontmatter: {}, body: '', hasFrontmatter: false, hadBom: false };

  const hadBom = raw.charCodeAt(0) === 0xfeff;
  const text = hadBom ? raw.slice(1) : raw;

  if (!text) return { frontmatter: {}, body: '', hasFrontmatter: false, hadBom };

  const fenced = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!fenced) {
    return { frontmatter: {}, body: text, hasFrontmatter: false, hadBom };
  }

  let frontmatter: Record<string, unknown> = {};
  try {
    const loaded = yaml.load(fenced[1]);
    if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) {
      frontmatter = loaded as Record<string, unknown>;
    }
  } catch {
    frontmatter = {};
  }

  return { frontmatter, body: fenced[2] ?? '', hasFrontmatter: true, hadBom };
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

  editor.commands.setContent(contentToLoad, emit);
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
 * leading/trailing whitespace, list-bullet style) don't trigger false
 * positives. Anything that survives this normalisation and still differs
 * is real syntax that the parser dropped.
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
    // Normalise Setext H1/H2 to ATX equivalents so `# Foo` and `Foo\n===`
    // compare as equal — `tiptap-markdown` serialises every heading as ATX
    // regardless of the input syntax, so the un-normalised compare would
    // otherwise flag every Setext-style file as lossy.
    .replace(/^([^\n]+)\n=+[ \t]*$/gm, '# $1')
    .replace(/^([^\n]+)\n-+[ \t]*$/gm, '## $1')
    // Collapse 3+ blank lines into 2 (paragraph-separator normal form)
    .replace(/\n{3,}/g, '\n\n')
    // Normalise list bullet style — tiptap-markdown emits `*` or `-`
    // inconsistently depending on configuration. Treat them as equivalent.
    .replace(/^(\s*)[*+]\s/gm, '$1- ')
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

  if (
    'tags' in fm &&
    Array.isArray(fm.tags) &&
    (fm.tags as unknown[]).length === 0
  ) {
    delete fm.tags;
  }

  if (options.contentId && !fm.id) {
    fm.id = options.contentId;
  }

  for (const key of Object.keys(fm)) {
    const v = fm[key];
    if (v === undefined || v === null) delete fm[key];
  }

  const bomPrefix = options.bom ? '﻿' : '';
  const hasFrontmatter = Object.keys(fm).length > 0;
  if (!hasFrontmatter) {
    return `${bomPrefix}${body}`;
  }

  const yamlText = yaml.dump(fm, { lineWidth: -1, noRefs: true }).trimEnd();
  const trailing = body.endsWith('\n') ? '' : '\n';
  return `${bomPrefix}---\n${yamlText}\n---\n${body}${trailing}`;
}

/**
 * One-shot helper: pulls the editor's current markdown, merges into the
 * supplied frontmatter, and returns a complete `.md` file string ready for
 * `vault:write-file-text`.
 */
export function buildMarkdownFileFromEditor(
  editor: Editor,
  frontmatter: Record<string, unknown>,
  options: AssembleMarkdownOptions = {},
): string {
  const body = editorMarkdown(editor);
  return assembleMarkdownFile(frontmatter, body, options);
}

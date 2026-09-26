/**
 * noteFile — pure read and assemble of one `.md` note file.
 *
 * `readNoteText` splits the raw bytes into frontmatter and body and records
 * the file's encoding traits (BOM, line ending). `assembleNoteText` applies
 * one change (a new body, a frontmatter delta, or both) to a FRESH read and
 * emits the bytes to write:
 *  - the frontmatter source is patched key by key (CST engine), so untouched
 *    keys, comments and quoting survive, including keys another program added;
 *  - without a new body the disk body is kept byte-exact;
 *  - the fresh read's BOM and line ending are re-applied, and a CRLF note's
 *    body is written as CRLF throughout;
 *  - a note without frontmatter keeps its final newline.
 *
 * No IPC, store or DOM access, so the writer and the disk-change handler share
 * one definition of "what the file says".
 */
import { assembleMarkdownFile, parseMarkdownFile, type FrontmatterRefusal } from '../editor/markdownSync';
import { frontmatterSourceParses } from '../vault/frontmatterCstModel';
import {
  applyFrontmatterDelta,
  isEmptyFrontmatterDelta,
  type FrontmatterDelta,
} from '../vault/frontmatterDelta';

export type Eol = '\n' | '\r\n';

/** One `.md` file as read from disk. */
export interface NoteText {
  /** The raw text, BOM included. */
  raw: string;
  frontmatter: Record<string, unknown>;
  /** The verbatim YAML between the fences ('' without a block). */
  rawFrontmatter: string;
  hasFrontmatter: boolean;
  /** Markdown after the frontmatter block, in the file's own line endings. */
  body: string;
  hadBom: boolean;
  eol: Eol;
}

/** What the local state of a note was built on: the bytes last known on disk. */
export interface DiskSnapshot {
  rawText: string;
  hash: string;
  /** Undefined when the read wasn't coherent or the bytes came from our own write. */
  mtimeMs?: number;
  size?: number;
  hadBom: boolean;
  eol: Eol;
}

/** Splits raw file text into frontmatter, body and encoding traits. */
export function readNoteText(raw: string): NoteText {
  const parsed = parseMarkdownFile(raw);
  return {
    raw,
    frontmatter: parsed.frontmatter,
    rawFrontmatter: parsed.rawFrontmatter,
    hasFrontmatter: parsed.hasFrontmatter,
    body: parsed.body,
    hadBom: parsed.hadBom,
    eol: raw.includes('\r\n') ? '\r\n' : '\n',
  };
}

const utf8 = new TextEncoder();

/**
 * The file's full text as the raw view shows it: without the BOM and with LF
 * line endings (a textarea reports LF whatever it was given).
 */
export function rawTextForView(raw: string): string {
  // allow-bom-sniff: `raw` is the file's bytes as read, BOM included
  return (raw.startsWith('\uFEFF') ? raw.slice(1) : raw).replace(/\r\n?/g, '\n');
}

/**
 * Text typed in the raw view, as the bytes to write over `fresh`: the file's
 * BOM and line ending are re-applied, so editing in the raw view never flips
 * either.
 */
export function rawTextForDisk(edited: string, fresh: Pick<NoteText, 'hadBom' | 'eol'>): string {
  // allow-bom-sniff: a pasted BOM is dropped; the file's own comes from the fresh read
  const lf = edited.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  // allow-bom-sniff: re-applies the BOM the fresh read found
  return (fresh.hadBom ? '\uFEFF' : '') + (fresh.eol === '\r\n' ? lf.replace(/\n/g, '\r\n') : lf);
}

/**
 * FNV-1a (32-bit) over the UTF-8 bytes, as 8 hex digits. It is the same digest
 * the main-process watcher computes over the file, so a UTF-8 note's hash can
 * be compared with a watcher event's. Used to recognise our own writes coming
 * back and to tell whether disk still holds the bytes a model was built on.
 */
export function noteTextHash(text: string): string {
  const bytes = utf8.encode(text);
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i] ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** A snapshot of `text` as the bytes on disk. */
export function snapshotOf(text: NoteText, mtimeMs?: number, size?: number): DiskSnapshot {
  return {
    rawText: text.raw,
    hash: noteTextHash(text.raw),
    mtimeMs,
    size,
    hadBom: text.hadBom,
    eol: text.eol,
  };
}

/** The body the snapshot's bytes hold (what a drift check compares). */
export function snapshotBody(snapshot: DiskSnapshot): string {
  return parseMarkdownFile(snapshot.rawText).body;
}

/**
 * True when two bodies hold the same text, ignoring line-ending style and
 * final newlines. The editor serialises LF without a final newline, and the
 * assembler adds one on write, so a note compared with its own editor body
 * must not look changed.
 */
export function sameBody(a: string, b: string): boolean {
  if (a === b) return true;
  const norm = (s: string): string => s.replace(/\r\n/g, '\n').replace(/\n+$/, '');
  return norm(a) === norm(b);
}

export interface NoteChange {
  /** The new body (editor markdown, LF). Omitted: keep the disk body. */
  body?: string;
  /** Frontmatter keys to set or remove. Omitted or empty: frontmatter unchanged. */
  delta?: FrontmatterDelta;
}

/**
 * The bytes to write for `change` applied to the fresh read `fresh`.
 * `onFrontmatterRefused` fires when the disk block can't be patched safely
 * (YAML that doesn't parse, or a block that isn't properties), so the
 * frontmatter part of the change is dropped (the block is kept verbatim).
 */
export function assembleNoteText(
  fresh: NoteText,
  change: NoteChange,
  onFrontmatterRefused?: (reason: FrontmatterRefusal) => void,
): string {
  const delta = change.delta;
  const fmChanged = delta !== undefined && !isEmptyFrontmatterDelta(delta);
  const nextFm = fmChanged ? applyFrontmatterDelta(fresh.frontmatter, delta) : fresh.frontmatter;
  const body = change.body ?? fresh.body;
  // An empty file carries no line-ending signal; the body then decides.
  const eol: Eol = fresh.raw.length === 0 ? (body.includes('\r\n') ? '\r\n' : '\n') : fresh.eol;
  let text = assembleMarkdownFile(nextFm, body, {
    bom: fresh.hadBom,
    rawFrontmatter: fresh.rawFrontmatter,
    frontmatterDirty: fmChanged,
    originalFrontmatter: fresh.rawFrontmatter,
    eol,
    onFrontmatterRefused,
  });
  // The editor drops a body's final newline. A note with frontmatter gets one
  // back from the assembler; one without would lose it on every edit.
  if (change.body !== undefined && endsWithNewline(fresh.raw) && !endsWithNewline(text) && text.length > 0) {
    text += eol;
  }
  // Without a new body the disk body is kept byte-exact: the assembler ends
  // a frontmatter note with a newline, which a body without one (or an empty
  // body) must not gain.
  if (change.body === undefined && !endsWithNewline(fresh.body) && text.endsWith(fresh.body + eol)) {
    text = text.slice(0, -eol.length);
  }
  return text;
}

/**
 * True when writing `next` over `fresh` would turn a frontmatter block that
 * parses into one that doesn't. Every reader would then lose the note's
 * title, tags and fields, and later metadata edits would be refused, so no
 * write path may do it. A block that was already broken is not this check's
 * concern (the assembler keeps it verbatim).
 */
export function breaksFrontmatter(fresh: NoteText, next: string): boolean {
  if (!fresh.hasFrontmatter || !frontmatterSourceParses(fresh.rawFrontmatter)) return false;
  const after = parseMarkdownFile(next);
  return after.hasFrontmatter && !frontmatterSourceParses(after.rawFrontmatter);
}

function endsWithNewline(text: string): boolean {
  return text.endsWith('\n');
}

/**
 * The text of a brand-new note: `title:` (and any other keys) as frontmatter
 * over `body`. LF, no BOM.
 */
export function newNoteText(frontmatter: Record<string, unknown>, body: string): string {
  return assembleMarkdownFile(frontmatter, body);
}

/**
 * The note as this session holds it, for a copy written somewhere other than
 * the note itself (the file is gone, or can't be written): the frontmatter it
 * last had on disk with any queued change applied, over the local body.
 * Without a known disk version, `frontmatter` is used as it is.
 */
export function localNoteText(
  base: DiskSnapshot | undefined,
  frontmatter: Record<string, unknown>,
  body: string | undefined,
  delta?: FrontmatterDelta,
): string {
  if (base) return assembleNoteText(readNoteText(base.rawText), { body, delta });
  return newNoteText({ ...frontmatter }, body ?? '');
}

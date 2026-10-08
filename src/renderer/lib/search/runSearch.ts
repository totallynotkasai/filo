/**
 * Vault-wide Search engine.
 *
 * Walks every loaded tile across every board in the active vault, plus
 * every note that sits on no board, and produces a flat list of
 * `SearchMatch` records ordered for deterministic cycling through Find and
 * for the panel's list.
 *
 * Sources of truth:
 *  - File-backed matches (Text Tile body, frontmatter, headings) come from
 *    `vaultIndexStore` — its `FileMetadata.content` is the parsed body and
 *    `FileMetadata.frontmatter`/`tags` are the canonical metadata for the
 *    `tag:` / `property:` operators.
 *  - Tile-level filters (`type:`, `has:connections`, `board:`) come from
 *    `boardCacheStore` — the file index alone can't see tile-shape data
 *    because a single `.md` may appear as multiple tiles across boards.
 *
 * Order: board name (alphabetical) → tile title → match offset. Matches in
 * tile titles sort before matches in tile bodies for the same tile. The
 * order is stable across runs so cycling with the Next/Previous buttons
 * never jumps unpredictably.
 *
 * Pure with respect to vault state — reads `vaultIndexStore` /
 * `boardCacheStore` directly, never writes. Read inside a `$derived`, it
 * re-runs when the board cache or the set of notes and their tags
 * (`listVersion`) changes. A note's own title, tags and body are read
 * untracked: every autosave changes them, and a whole-vault search on each
 * one made typing hitch with the panel open. The Search store refreshes
 * those on its own debounce instead.
 */

import { untrack } from 'svelte';
import type { ParsedQuery, OperatorFilter } from './queryParser';
import type { TileDefinition, Connection } from '../../schema/index';
import type { TileType } from '../../schema/tile';
import type { FileMetadata } from '../vault/vaultIndex';
import { vaultIndexStore } from '../../stores/vaultIndex.svelte';
import { boardCacheStore } from '../../stores/boardCache.svelte';
import { vaultStore } from '../../stores/vault.svelte';
import { defTitle, mediaTags, noteTags, noteTitle } from '../../stores/noteMeta';
import { vaultPath, type VaultPath } from '../../../shared/vaultPath';
import { markdownSyntaxRanges, overlapsSyntax, type SyntaxRange } from './markdownSyntax';
import { isStaleInlineCopy } from '../boards/tileDefBuilder';

/** Single match record surfaced to the Search panel + ReplaceAll command. */
export interface SearchMatch {
  /** Owning board ID; '' for a note on no board. */
  boardId: string;
  /** Owning board name (resolved at query time, for the panel's list); '' for a note on no board. */
  boardName: string;
  /**
   * Tile that exposes this match; '' for a note on no board, which Find
   * opens in a Document tab instead.
   */
  tileId: string;
  /** Tile title. */
  tileTitle: string;
  tileType: TileType;
  /** Vault-relative .md path when the match lives in file content; null for inline tiles. */
  filePath: string | null;
  /**
   * Match offset in the source string (UTF-16 code units). For `matchKind:
   * 'body'` this is an offset into the file body; for `matchKind: 'title'`
   * an offset into the tile title.
   */
  matchStart: number;
  matchEnd: number;
  /** The matched text (used by ReplaceAllCommand for length-mismatch checks). */
  matchText: string;
  /** Where the match was found. Drives how the match is highlighted. */
  matchKind: 'body' | 'title';
  /** ±40-char context window around the match, for the panel's list. */
  snippet: string;
  /**
   * A body match that falls in Markdown syntax (a list marker, a rule or
   * table delimiter row, a link address, an HTML tag): Find shows it,
   * Replace leaves it alone (see `markdownSyntax.ts`).
   */
  inSyntax?: boolean;
}

/** The Search panel's Match case / Whole word toggles (free text only). */
export interface SearchOptions {
  matchCase?: boolean;
  wholeWord?: boolean;
}

/**
 * Builds a global RegExp from a free-text needle: case-insensitive unless
 * `matchCase`. `wholeWord` matches only where no letter, digit or `_` (in any
 * script) touches either end, so `cat` skips `concatenate` and `café` is a
 * word of its own. An end where the needle itself is whitespace needs no
 * check, since the whitespace already ends a word there (` - ` finds the one
 * in `a - b`). Returns null when the input is empty.
 */
export function buildNeedleRegex(needle: string, options: SearchOptions = {}): RegExp | null {
  if (!needle) return null;
  // Escape every metacharacter so the needle is treated as a literal string,
  // even when the user types something like "foo(bar)".
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const flags = options.matchCase ? 'g' : 'gi';
  if (!options.wholeWord) return new RegExp(escaped, flags);
  const before = /^\s/.test(needle) ? '' : '(?<![\\p{L}\\p{N}_])';
  const after = /\s$/.test(needle) ? '' : '(?![\\p{L}\\p{N}_])';
  // `u` for the Unicode letter / number classes.
  return new RegExp(`${before}${escaped}${after}`, `${flags}u`);
}

/**
 * Walks every match of `regex` in `text` and yields the offset pairs. Resets
 * `regex.lastIndex` on entry so the same regex can be reused across files
 * without leaking state from a prior file. Bounds runaway matches with a
 * hard cap so a zero-width pattern (e.g. `/^/g`) cannot loop forever.
 */
function* matchOffsets(regex: RegExp, text: string): Generator<{ start: number; end: number; text: string }, void> {
  if (!text) return;
  regex.lastIndex = 0;
  let m: RegExpExecArray | null;
  let safety = 0;
  while ((m = regex.exec(text)) !== null) {
    if (m[0].length === 0) {
      // Zero-width match — advance manually to avoid an infinite loop.
      regex.lastIndex++;
      continue;
    }
    yield { start: m.index, end: m.index + m[0].length, text: m[0] };
    safety++;
    if (safety > 10_000) return;
  }
}

function snippetAround(body: string, start: number, end: number): string {
  const SNIPPET_PAD = 40;
  const s = Math.max(0, start - SNIPPET_PAD);
  const e = Math.min(body.length, end + SNIPPET_PAD);
  // Collapse newlines into spaces so the snippet renders in one line.
  const raw = body.slice(s, e).replace(/[\r\n]+/g, ' ');
  const prefix = s > 0 ? '…' : '';
  const suffix = e < body.length ? '…' : '';
  return `${prefix}${raw}${suffix}`;
}

/**
 * The file a tile def shows (its note, or its media file), or `null` for a
 * board-only tile or an external URL.
 */
function getDefFilePath(def: TileDefinition): string | null {
  if (def.type === 'text' || def.type === 'file') return def.filePath || null;
  if (def.type === 'image' || def.type === 'video' || def.type === 'audio') {
    const src = def.src;
    if (!src) return null;
    if (/^https?:\/\//i.test(src) || /^data:/i.test(src)) return null;
    return src;
  }
  return null;
}

/** A def's tags, read from where they live (note, tags.json, or the tile). */
function getDefTags(def: TileDefinition, filePath: string | null): string[] {
  if (def.type === 'text') return filePath ? noteTags(filePath) : [];
  if (def.type === 'image' || def.type === 'video' || def.type === 'audio' || def.type === 'file') {
    return filePath ? mediaTags(filePath) : [];
  }
  return def.tags ?? [];
}

/**
 * True when at least one connection in any loaded board references `tileId`
 * on either end. Used by the `has:connections` operator. Walks the cache
 * once per call — acceptable for typical boards but worth memoising if the
 * search becomes a hot loop on huge vaults.
 */
function tileHasConnection(tileId: string): boolean {
  for (const data of Object.values(boardCacheStore.cache)) {
    for (const conn of Object.values(data.connections ?? {})) {
      const c = conn as Connection;
      if (c.fromTileId === tileId || c.toTileId === tileId) return true;
    }
  }
  return false;
}

interface TileEnumeration {
  boardId: string;
  boardName: string;
  tileId: string;
  type: TileType;
  /** The tile's title and tags, read from where they live. */
  title: string;
  tags: string[];
  filePath: string | null;
  /** Pre-cached frontmatter for `property:` matching. */
  metadata: FileMetadata | null;
}

/**
 * Builds the working set of tiles to filter. Walks the board cache once
 * and joins each tile def to its file metadata so per-operator filters
 * read both shapes in O(1) per tile.
 */
function enumerateTiles(): TileEnumeration[] {
  const project = vaultStore.project;
  const boardNameById = new Map<string, string>();
  if (project) {
    for (const b of project.boards) boardNameById.set(b.id, b.name);
  }

  void vaultIndexStore.listVersion;
  const out: TileEnumeration[] = [];
  for (const [boardId, data] of Object.entries(boardCacheStore.cache)) {
    const boardName = boardNameById.get(boardId) ?? data.board?.name ?? boardId;
    // Regular tile defs (text / image / video / audio / file) — file-backed.
    for (const [tileId, def] of Object.entries(data.tileDefs ?? {})) {
      // A Mind Map's link, embed or timer tile is listed from its inline copy below.
      if (isStaleInlineCopy(data.board, tileId)) continue;
      const filePath = getDefFilePath(def);
      const metadata = filePath ? untrack(() => vaultIndexStore.getMetadata(filePath)) : null;
      const title = def.type === 'text' ? untrack(() => defTitle(def)) : defTitle(def);
      const tags = def.type === 'text' ? untrack(() => getDefTags(def, filePath)) : getDefTags(def, filePath);
      out.push({ boardId, boardName, tileId, type: def.type, title, tags, filePath, metadata });
    }
    // Inline tiles (link / iframe / timer) live on the mind-map board
    // itself, not in tileDefs. No backing file but they still need to be
    // searchable by title and by `type:`.
    if (data.board.type === 'mindmap') {
      const mm = data.board as { inlineTiles?: Record<string, TileDefinition> };
      for (const [tileId, def] of Object.entries(mm.inlineTiles ?? {})) {
        out.push({ boardId, boardName, tileId, type: def.type, title: defTitle(def), tags: getDefTags(def, null), filePath: null, metadata: null });
      }
    }
  }
  // Notes on no board: the search covers the whole vault, not only what is
  // placed on a board. Each counts once, as a text item with no board.
  const placed = new Set<VaultPath>();
  for (const t of out) if (t.type === 'text' && t.filePath) placed.add(vaultPath(t.filePath));
  untrack(() => {
    for (const metadata of vaultIndexStore.allMetadata()) { // allow-global-index-version: read untracked; the search store decides when to re-run
      if (placed.has(vaultPath(metadata.path))) continue;
      out.push({
        boardId: '',
        boardName: '',
        tileId: '',
        type: 'text',
        title: noteTitle(metadata.path),
        tags: noteTags(metadata.path),
        filePath: metadata.path,
        metadata,
      });
    }
  });
  return out;
}

/**
 * Tests a single operator against a tile enumeration entry. Returns false
 * to drop the tile from the working set. Unknown operators are accepted
 * (defensive) so a future grammar extension can't silently filter out
 * every tile.
 */
function tilePassesOperator(tile: TileEnumeration, op: OperatorFilter): boolean {
  switch (op.kind) {
    case 'tag': {
      const tags = tile.tags;
      const needle = op.value.toLowerCase();
      return tags.some((t) => t.toLowerCase() === needle);
    }
    case 'board': {
      return tile.boardName.toLowerCase() === op.value.toLowerCase();
    }
    case 'has-connections': {
      return tileHasConnection(tile.tileId);
    }
    case 'property': {
      const fm = tile.metadata?.frontmatter ?? {};
      const v = fm[op.key];
      if (v == null) return false;
      // Arrays match if any element equals the value (case-insensitive when
      // both sides are strings).
      if (Array.isArray(v)) {
        return v.some((e) => normaliseEq(e, op.value));
      }
      return normaliseEq(v, op.value);
    }
    case 'type': {
      return tile.type === op.value;
    }
  }
}

function normaliseEq(left: unknown, right: string): boolean {
  if (typeof left === 'string') return left.toLowerCase() === right.toLowerCase();
  return String(left).toLowerCase() === right.toLowerCase();
}

/**
 * Comparator used to sort matches into a stable order for cycling. Board
 * name (alphabetical, case-insensitive) → tile title → match offset →
 * matchKind (title before body so a Find that begins with title hits is
 * predictable).
 */
function compareMatches(a: SearchMatch, b: SearchMatch): number {
  // Notes on no board come after every board.
  if (!a.boardId !== !b.boardId) return a.boardId ? -1 : 1;
  const boardA = a.boardName.toLowerCase();
  const boardB = b.boardName.toLowerCase();
  if (boardA < boardB) return -1;
  if (boardA > boardB) return 1;
  const titleA = a.tileTitle.toLowerCase();
  const titleB = b.tileTitle.toLowerCase();
  if (titleA < titleB) return -1;
  if (titleA > titleB) return 1;
  if (a.matchKind !== b.matchKind) return a.matchKind === 'title' ? -1 : 1;
  return a.matchStart - b.matchStart;
}

/**
 * Hard ceiling on the number of matches surfaced in one query. Prevents the
 * panel from freezing on a one-character query against a 10 000-file vault
 * (which could produce millions of body hits). The panel says when the cap
 * is hit, and the user can refine the query.
 */
export const MAX_MATCHES = 5000;

/**
 * Runs a parsed query against the active vault's loaded boards + index and
 * returns the resulting matches. Empty queries return an empty array
 * (callers check this themselves but the engine is defensive). Returns at
 * most `MAX_MATCHES` results; the `truncated` flag tells the caller
 * whether more matches existed.
 */
export function runVaultSearch(
  query: ParsedQuery,
  options: SearchOptions = {},
): { matches: SearchMatch[]; truncated: boolean } {
  // Empty query: short-circuit (avoid an O(n) walk for a no-op).
  const hasOps = query.operators.length > 0;
  const hasText = query.freeText.length > 0;
  const hasRegex = query.regex !== null;
  if (!hasOps && !hasText && !hasRegex) {
    return { matches: [], truncated: false };
  }

  // Filter the tile working set by every structured operator (AND-joined).
  const allTiles = enumerateTiles();
  let candidates = allTiles;
  for (const op of query.operators) {
    candidates = candidates.filter((t) => tilePassesOperator(t, op));
    if (candidates.length === 0) {
      return { matches: [], truncated: false };
    }
  }

  // Pure-operator queries (no text needle) surface one match per surviving
  // tile so the user can still cycle and replace by metadata alone. The
  // match points at the tile title since there's no inner offset.
  if (!hasText && !hasRegex) {
    const matches: SearchMatch[] = [];
    let truncated = false;
    for (const t of candidates) {
      if (matches.length >= MAX_MATCHES) {
        truncated = true;
        break;
      }
      matches.push(toTitleMatch(t, 0, 0, ''));
    }
    matches.sort(compareMatches);
    return { matches, truncated };
  }

  // Build the body-scan regex. When the user typed a bare /regex/, use it
  // verbatim (already global; its own flags decide case). Otherwise the free
  // text is a literal, shaped by the Match case / Whole word options.
  const bodyRegex = query.regex ?? buildNeedleRegex(query.freeText, options);
  // Title scan uses the same regex so the matched substring stays in lock-
  // step with body matches. Clone the regex so resetting `lastIndex`
  // between scans doesn't bleed across iterations.
  const titleRegex = bodyRegex ? new RegExp(bodyRegex.source, bodyRegex.flags) : null;

  const matches: SearchMatch[] = [];
  let truncated = false;

  // Dedupe text-tile files so the same `.md` shown on multiple boards only
  // contributes one set of body matches. Title matches are tile-specific so
  // they don't dedupe — a tile renamed on one board doesn't carry over to
  // another board's copy of the same file.
  const scannedFiles = new Set<string>();

  for (const t of candidates) {
    if (truncated) break;

    // 1) Title matches — every tile's title is independently searchable.
    if (titleRegex && t.title) {
      for (const off of matchOffsets(titleRegex, t.title)) {
        if (matches.length >= MAX_MATCHES) { truncated = true; break; }
        matches.push({
          boardId: t.boardId,
          boardName: t.boardName,
          tileId: t.tileId,
          tileTitle: t.title,
          tileType: t.type,
          filePath: t.filePath,
          matchStart: off.start,
          matchEnd: off.end,
          matchText: off.text,
          matchKind: 'title',
          snippet: snippetAround(t.title, off.start, off.end),
        });
      }
    }
    if (truncated) break;

    // 2) Body matches — only for text tiles backed by an indexed file. Image /
    // video / audio / file / link / iframe / timer have no body content for
    // the engine to scan.
    if (!bodyRegex || !t.filePath || !t.metadata) continue;
    if (t.type !== 'text') continue;
    if (scannedFiles.has(t.filePath)) {
      // Already produced body matches via another tile on a different board.
      // The panel's list intentionally shows those matches under the FIRST
      // tile encountered — listing them again under each placement would
      // multiply the result count without adding information.
      continue;
    }
    scannedFiles.add(t.filePath);

    let syntax: SyntaxRange[] | null = null;
    for (const off of matchOffsets(bodyRegex, t.metadata.content)) {
      if (matches.length >= MAX_MATCHES) { truncated = true; break; }
      syntax ??= markdownSyntaxRanges(t.metadata.content);
      const inSyntax = overlapsSyntax(syntax, off.start, off.end);
      matches.push({
        boardId: t.boardId,
        boardName: t.boardName,
        tileId: t.tileId,
        tileTitle: t.title,
        tileType: t.type,
        filePath: t.filePath,
        matchStart: off.start,
        matchEnd: off.end,
        matchText: off.text,
        matchKind: 'body',
        snippet: snippetAround(t.metadata.content, off.start, off.end),
        ...(inSyntax ? { inSyntax } : {}),
      });
    }
  }

  matches.sort(compareMatches);
  return { matches, truncated };
}

function toTitleMatch(t: TileEnumeration, start: number, end: number, text: string): SearchMatch {
  return {
    boardId: t.boardId,
    boardName: t.boardName,
    tileId: t.tileId,
    tileTitle: t.title,
    tileType: t.type,
    filePath: t.filePath,
    matchStart: start,
    matchEnd: end,
    matchText: text,
    matchKind: 'title',
    snippet: t.title,
  };
}

/**
 * What Replace All would change: only body matches outside Markdown syntax
 * (it never renames a title), and the notes they are in, in match order;
 * `inSyntax` counts the body matches it leaves alone.
 */
export function replaceableMatches(matches: readonly SearchMatch[]): { count: number; files: string[]; inSyntax: number } {
  let count = 0;
  let inSyntax = 0;
  const files: string[] = [];
  const seen = new Set<VaultPath>();
  for (const m of matches) {
    if (m.matchKind !== 'body' || !m.filePath) continue;
    if (m.inSyntax) {
      inSyntax++;
      continue;
    }
    count++;
    const key = vaultPath(m.filePath);
    if (seen.has(key)) continue;
    seen.add(key);
    files.push(m.filePath);
  }
  return { count, files, inSyntax };
}

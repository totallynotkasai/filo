import type { BoardFileData } from '../boards/boardSaver';
import type { Board } from '../../schema/index';
import { normalizeVaultRelative } from '../utils/path';
import { rebasePath } from './renamePathKeys';

/**
 * Field names on a tile-like object that may hold a vault-relative file
 * reference. Different tile types use different field names; the integrity
 * layer is agnostic to which carrier object it scans (tile def, kanban
 * placement, frame style) and just checks whichever of these is present.
 *
 * `backgroundImage` is used by frame.style and by the per-board mindmap
 * frame-default override (`board.settings.defaults.frame.backgroundImage`).
 * Both go through `forEachTileLike` as synthetic tile-likes so the same
 * rename / broken-ref / cascade-delete scan covers them.
 */
const FILE_REF_FIELDS = ['src', 'filePath', 'coverImage', 'backgroundImage'] as const;

/** Synthetic-id prefix for a frame's style object in the file-ref scan. */
const FRAME_SYNTHETIC_PREFIX = 'frame:';
/** Synthetic id prefix for a kanban column visited via
 *  `forEachTileLike` so its own `coverImage` participates in rename
 *  propagation / broken-ref detection. The placement-level cover scan
 *  uses the placement's real tileId; the column is a different scope. */
const KANBAN_COLUMN_SYNTHETIC_PREFIX = 'column:';
/** Synthetic id for a board's `settings.defaults.frame` block in the scan. */
const BOARD_FRAME_DEFAULTS_ID = 'board-settings:defaults.frame';

export interface BrokenReference {
  /** Tile ID that holds the broken reference. */
  tileId: string;
  /** Field on the tile whose value is the broken path. */
  field: string;
  /** Vault-relative path that does not resolve to a file on disk. */
  missingPath: string;
}

export interface RenameResult {
  /** Number of tile field values that were updated. */
  updatedCount: number;
  /** Board IDs that had at least one update applied. */
  changedBoardIds: string[];
}

function pathStartsWith(candidate: string, prefix: string): boolean {
  const c = normalizeVaultRelative(candidate);
  const p = normalizeVaultRelative(prefix);
  return c === p || c.startsWith(p + '/');
}

function rewritePath(current: string, oldPath: string, newPath: string): string {
  return rebasePath(current, oldPath, newPath) ?? current;
}

/**
 * Iterates every object in a board file that can hold a file path (tile defs,
 * frame styles, the mind-map frame defaults, Kanban columns and placements,
 * a Document board) and invokes `visit` for each.
 * The visitor mutates the object in place; callers decide whether to write
 * the result back.
 *
 * Each branch of the board discriminated union surfaces the fields specific
 * to that board type, forcing the union to be re-narrowed in one place.
 */
function forEachTileLike(
  board: BoardFileData,
  visit: (tileId: string, tile: Record<string, unknown>) => void,
): void {
  // Text defs name their note by `filePath`; media and file defs carry
  // `src` / `filePath`.
  if (board.tileDefs) {
    for (const [id, def] of Object.entries(board.tileDefs)) {
      visit(id, def);
    }
  }

  // Frames carry `style.backgroundImage` — a vault-relative path uploaded
  // via the Frame Style popup. Visit each frame's `style` object as a
  // synthetic tile-like so the existing FILE_REF_FIELDS scan picks up
  // `backgroundImage` for rename / cascade-delete / broken-ref. The
  // synthetic tileId carries the `frame:` prefix so callers downstream
  // can distinguish a frame-bg match from a real tile field.
  for (const frame of board.frames ?? []) {
    if (!frame || typeof frame !== 'object') continue;
    const style = (frame as { style?: unknown }).style;
    if (style && typeof style === 'object' && !Array.isArray(style)) {
      visit(`${FRAME_SYNTHETIC_PREFIX}${frame.id}`, style as Record<string, unknown>);
    }
  }

  const b: Board = board.board;

  // Per-board mindmap frame-default override
  // (`board.settings.defaults.frame.backgroundImage`). Only mindmap boards
  // expose `defaults.frame` today; future board types that surface a
  // background image would slot into this same scan trivially.
  if (b.type === 'mindmap') {
    const settings = (b as { settings?: { defaults?: { frame?: unknown } } }).settings;
    const frameDefaults = settings?.defaults?.frame;
    if (frameDefaults && typeof frameDefaults === 'object' && !Array.isArray(frameDefaults)) {
      visit(BOARD_FRAME_DEFAULTS_ID, frameDefaults as Record<string, unknown>);
    }
  }

  switch (b.type) {
    case 'mindmap':
      // Inline tiles (link/iframe/timer) have no file; their schema has no
      // path field to scan.
      return;
    case 'kanban': {
      // Kanban placements carry a placement-level `coverImage` path that the
      // visitor needs to see for rename propagation and broken-ref detection.
      // Cascade-delete iterates tileDefs directly elsewhere, so adding
      // placements here doesn't change cascade-delete behavior — a broken
      // cover image clears the field; it does not remove the underlying tile.
      //
      // Also visit the column itself for its own
      // `coverImage` (column header band). The synthetic `column:`
      // prefix keeps the id distinct from any tile placement so callers
      // downstream don't confuse a column-bg match with a real tile.
      for (const col of b.columns ?? []) {
        if ('coverImage' in (col as object)) {
          visit(`${KANBAN_COLUMN_SYNTHETIC_PREFIX}${col.id}`, col as unknown as Record<string, unknown>); // allow-cast: visit() takes Record<string, unknown> and KanbanColumn carries discriminator fields the index signature can't express
        }
        for (const placement of col.tilePlacements ?? []) {
          if (typeof placement.tileId !== 'string') continue;
          visit(placement.tileId, placement);
        }
      }
      return;
    }
    case 'document':
      // A Document board names its note by `filePath` on the board itself.
      visit(b.id, b as unknown as Record<string, unknown>); // allow-cast: visit() takes Record<string, unknown>; DocumentBoard is a plain object whose file field the scan reads
      return;
    case 'tasklist':
      return;
  }
}

/**
 * Rewrites every file reference matching `oldPath` (exact match or folder
 * prefix) to use `newPath` instead. Mutates the passed board object in
 * place. Returns the number of fields updated on this board.
 */
export function rewriteRenameInBoard(
  board: BoardFileData,
  oldPath: string,
  newPath: string,
): number {
  let updates = 0;
  forEachTileLike(board, (_id, tile) => {
    for (const field of FILE_REF_FIELDS) {
      const current = tile[field];
      if (typeof current !== 'string' || !current) continue;
      if (!pathStartsWith(current, oldPath)) continue;
      const next = rewritePath(current, oldPath, newPath);
      if (next !== current) {
        tile[field] = next;
        updates++;
      }
    }
  });
  return updates;
}

/**
 * Whether any file reference in `board` is `path` or sits under it, i.e.
 * whether a rename of `path` would rewrite this board. Reads only.
 */
export function boardReferencesPath(board: BoardFileData, path: string): boolean {
  let found = false;
  forEachTileLike(board, (_id, tile) => {
    if (found) return;
    for (const field of FILE_REF_FIELDS) {
      const current = tile[field];
      if (typeof current === 'string' && current && pathStartsWith(current, path)) {
        found = true;
        return;
      }
    }
  });
  return found;
}

/**
 * Applies a rename across a caller-provided map of loaded boards. Returns
 * which boards were changed so the caller can persist only those. Does not
 * perform IPC — the consumer passes the in-memory cache and writes changed
 * boards via `boardSaver.scheduleBoardWrite()`.
 */
export function propagateRenameAcrossBoards(
  boards: Record<string, BoardFileData>,
  oldPath: string,
  newPath: string,
): RenameResult {
  const changedBoardIds: string[] = [];
  let total = 0;
  for (const [boardId, data] of Object.entries(boards)) {
    const n = rewriteRenameInBoard(data, oldPath, newPath);
    if (n > 0) {
      changedBoardIds.push(boardId);
      total += n;
    }
  }
  return { updatedCount: total, changedBoardIds };
}

export interface CoverImageClear {
  /** Owning Kanban column ID. */
  columnId: string;
  /** Placement's tileId — used by callers to look up the right placement. */
  tileId: string;
  /** The coverImage path that matched (so callers can verify before clearing). */
  matchedPath: string;
}

/**
 * Column-level cover image clear. Sibling to
 * `CoverImageClear` but applies to the column's own `coverImage` field
 * (column header band) rather than an individual card placement. No
 * `tileId` because the column carries the reference itself.
 */
export interface ColumnCoverImageClear {
  /** Owning Kanban column ID. */
  columnId: string;
  /** The coverImage path that matched (so callers can verify before clearing). */
  matchedPath: string;
}

export interface FrameBackgroundClear {
  /** Frame ID whose `style.backgroundImage` matched the deleted path. */
  frameId: string;
  /** The backgroundImage path that matched. */
  matchedPath: string;
}

export interface BoardSettingsBackgroundClear {
  /**
   * Dotted nested-path of the field on `board.settings` whose value
   * matched. Today the only carrier is mindmap's
   * `defaults.frame.backgroundImage`; the field is kept so future
   * additions (per-board background image on other board types, vault
   * theming overrides) slot in without an interface change.
   */
  path: 'defaults.frame.backgroundImage';
  /** The path on disk that matched. */
  matchedPath: string;
}

export interface DeleteCascadeResult {
  /** boardId → list of tileIds to remove from that board. */
  byBoard: Record<string, string[]>;
  /**
   * boardId → list of Kanban placements whose `coverImage` matched the
   * deleted path. The placement itself stays (the card text is still
   * meaningful) — the caller should clear the `coverImage` field.
   */
  coverImageClears: Record<string, CoverImageClear[]>;
  /**
   * boardId → list of Kanban *columns* whose own
   * `coverImage` (the column header band, distinct from placement
   * covers) matched the deleted path. Same clear-the-field semantics
   * as `coverImageClears`; just at a different scope.
   */
  columnCoverImageClears: Record<string, ColumnCoverImageClear[]>;
  /**
   * boardId → list of frames whose `style.backgroundImage` matched the
   * deleted path. The frame itself stays (it's still a useful canvas
   * grouping); the caller clears just the `backgroundImage` field.
   */
  frameBackgroundClears: Record<string, FrameBackgroundClear[]>;
  /**
   * boardId → list of `board.settings.*` background-image fields that
   * matched the deleted path. Today only mindmap's
   * `defaults.frame.backgroundImage` populates this; the caller clears
   * the matched field.
   */
  boardSettingsClears: Record<string, BoardSettingsBackgroundClear[]>;
  /** Total number of tile references queued for removal. */
  totalCount: number;
}

/**
 * Identifies every tile across every board that should be removed because the
 * file at `deletedPath` no longer exists. Pure function — does not mutate the
 * boards or perform IPC. The caller (boardStore) reads `byBoard` and removes
 * each tile via its own undo-aware path.
 *
 * Matches:
 *   - `src` / `filePath` exact-or-prefix match (handles folder deletes).
 *   - Kanban placement `coverImage`: returned as a separate `coverImageClears`
 *     entry rather than a tile removal so the card itself survives — only the
 *     dead cover image reference is cleared.
 */
export function findTilesToCascadeDelete(
  boards: Record<string, BoardFileData>,
  deletedPath: string,
): DeleteCascadeResult {
  const byBoard: Record<string, string[]> = {};
  const coverImageClears: Record<string, CoverImageClear[]> = {};
  const columnCoverImageClears: Record<string, ColumnCoverImageClear[]> = {};
  const frameBackgroundClears: Record<string, FrameBackgroundClear[]> = {};
  const boardSettingsClears: Record<string, BoardSettingsBackgroundClear[]> = {};
  let totalCount = 0;

  // Only the fields that ARE the tile's file remove the tile. A cover or
  // background image is decoration: its carrier stays and just the field is
  // cleared (the scans below).
  const REMOVE_TILE_ON_MATCH_FIELDS = ['src', 'filePath'] as const;

  for (const [boardId, data] of Object.entries(boards)) {
    const tilesToRemove: string[] = [];
    for (const [tileId, def] of Object.entries(data.tileDefs ?? {})) {
      const d = def as Record<string, unknown>;
      let matched = false;
      for (const field of REMOVE_TILE_ON_MATCH_FIELDS) {
        const v = d[field];
        if (typeof v !== 'string' || !v) continue;
        if (pathStartsWith(v, deletedPath)) { matched = true; break; }
      }
      if (matched) tilesToRemove.push(tileId);
    }
    if (tilesToRemove.length > 0) {
      byBoard[boardId] = tilesToRemove;
      totalCount += tilesToRemove.length;
    }

    // Kanban placement coverImage scan. The placement-level cover image is
    // independent of the tile's own file refs; deleting the image must clear
    // the cover but leave the card placement intact (the underlying tile
    // might point at a `.md` that's untouched, or at a different image).
    if (data.board.type === 'kanban') {
      const removedSet = new Set(tilesToRemove);
      const clears: CoverImageClear[] = [];
      const colClears: ColumnCoverImageClear[] = [];
      for (const col of data.board.columns ?? []) {
        for (const placement of col.tilePlacements ?? []) {
          if (typeof placement.coverImage !== 'string' || !placement.coverImage) continue;
          if (!pathStartsWith(placement.coverImage, deletedPath)) continue;
          // If the placement's tile is already queued for removal there's no
          // point clearing its cover image — the whole placement is going.
          if (removedSet.has(placement.tileId)) continue;
          clears.push({
            columnId: col.id,
            tileId: placement.tileId,
            matchedPath: placement.coverImage,
          });
        }
        // Column-level coverImage scan. The column's own
        // cover image is independent of any placement's cover; deleting
        // the underlying file should clear the column-header reference
        // without disturbing the columns of cards underneath.
        const colCover = (col as { coverImage?: unknown }).coverImage;
        if (typeof colCover === 'string' && colCover && pathStartsWith(colCover, deletedPath)) {
          colClears.push({ columnId: col.id, matchedPath: colCover });
        }
      }
      if (clears.length > 0) coverImageClears[boardId] = clears;
      if (colClears.length > 0) columnCoverImageClears[boardId] = colClears;
    }

    // Frame `style.backgroundImage` scan. Same shape as coverImage — the
    // frame itself stays; only the backgroundImage field clears.
    const frameClears: FrameBackgroundClear[] = [];
    for (const frame of data.frames ?? []) {
      const bg = (frame as { style?: { backgroundImage?: unknown } }).style?.backgroundImage;
      if (typeof bg !== 'string' || !bg) continue;
      if (!pathStartsWith(bg, deletedPath)) continue;
      frameClears.push({ frameId: frame.id, matchedPath: bg });
    }
    if (frameClears.length > 0) frameBackgroundClears[boardId] = frameClears;

    // Per-board frame-default override
    // (`board.settings.defaults.frame.backgroundImage`). Mindmap only.
    if (data.board.type === 'mindmap') {
      const settings = (data.board as { settings?: { defaults?: { frame?: { backgroundImage?: unknown } } } }).settings;
      const bg = settings?.defaults?.frame?.backgroundImage;
      if (typeof bg === 'string' && bg && pathStartsWith(bg, deletedPath)) {
        boardSettingsClears[boardId] = [{
          path: 'defaults.frame.backgroundImage',
          matchedPath: bg,
        }];
      }
    }
  }

  return {
    byBoard,
    coverImageClears,
    columnCoverImageClears,
    frameBackgroundClears,
    boardSettingsClears,
    totalCount,
  };
}

/**
 * Returns every file reference on a single board together with the field it
 * came from. Used by `detectBrokenRefs` and any UI that wants to audit a
 * board's external dependencies.
 */
export function collectFileRefs(
  board: BoardFileData,
): Array<{ tileId: string; field: string; path: string }> {
  const out: Array<{ tileId: string; field: string; path: string }> = [];
  forEachTileLike(board, (tileId, tile) => {
    for (const field of FILE_REF_FIELDS) {
      const v = tile[field];
      if (typeof v === 'string' && v.length > 0) out.push({ tileId, field, path: v });
    }
  });
  return out;
}

/**
 * Detects references on `board` that don't resolve to a known file.
 * `knownPaths` is typically the set of vault-relative paths tracked by the
 * VaultIndex plus any attachments enumerated from the tree; the caller
 * decides what "known" means so this stays a pure function.
 *
 * Every file field (`src` / `filePath` / covers / backgrounds) is checked via
 * `collectFileRefs`; a text tile's `filePath` is its note, so a note renamed
 * or deleted outside Filo is caught here too.
 */
export function detectBrokenRefs(
  board: BoardFileData,
  knownPaths: ReadonlySet<string> | Iterable<string>,
): BrokenReference[] {
  const known =
    knownPaths instanceof Set
      ? (knownPaths as ReadonlySet<string>)
      : new Set(Array.from(knownPaths));
  const knownNormalized = new Set<string>();
  for (const p of known) knownNormalized.add(normalizeVaultRelative(p));

  const broken: BrokenReference[] = [];
  for (const ref of collectFileRefs(board)) {
    // Skip anything that isn't a vault-relative path: URLs (including the
    // `://`-less `data:` and `blob:` schemes), `file:` URLs, and absolute
    // filesystem paths. Integrity only covers vault-relative refs — anything
    // else is either intentionally external (http/https), a runtime in-memory
    // resource (data/blob), or a leak from a buggy code path that shouldn't
    // produce a broken-ref badge on top of its other symptoms.
    if (/^([a-z]+:|[A-Za-z]:[/\\]|[/\\])/i.test(ref.path)) continue;

    if (!knownNormalized.has(normalizeVaultRelative(ref.path))) {
      broken.push({ tileId: ref.tileId, field: ref.field, missingPath: ref.path });
    }
  }

  return broken;
}

import type { V7BoardFileData } from '../boards/boardSaver';
import type { Board } from '../../schema/index';
import { normalizePath, normalizeVaultRelative, stripLeadingSlash, toPosix } from '../utils/path';

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
const FILE_REF_FIELDS = ['file', 'src', 'filePath', 'coverImage', 'backgroundImage'] as const;

/** Synthetic-id prefix for a frame's style object in the file-ref scan. */
const FRAME_SYNTHETIC_PREFIX = 'frame:';
/** Synthetic id prefix for a kanban column visited via
 *  `forEachTileLike` so its own `coverImage` participates in rename
 *  propagation / broken-ref detection. The placement-level cover scan
 *  uses the placement's real tileId; the column is a different scope. */
const KANBAN_COLUMN_SYNTHETIC_PREFIX = 'column:';
/** Synthetic id for a board's `settings.defaults.frame` block in the scan. */
const BOARD_FRAME_DEFAULTS_ID = 'board-settings:defaults.frame';

/**
 * Mirrors `fileNameSafe` in board components — same illegal-char regex,
 * same whitespace collapse. Used to derive the on-disk folder for a Kanban
 * board whose name contains filesystem-unsafe characters.
 */
function sanitizeForFilename(name: string): string {
  return (
    name
       
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      // Lockstep with `fileNameSafe`: strip trailing dots/spaces.
      .replace(/[. ]+$/, '') || 'Untitled'
  );
}

/**
 * Returns the vault-relative folder where a board's text-tile `.md` files
 * are placed, or `null` for board types that don't carry convention-backed
 * text tiles (e.g. document boards store content inline).
 *
 *   - mindmap  → '' (root, plus per-board / vault-wide pin via cascade)
 *   - kanban   → 'Kanban/<kanbanFolder>' (frozen at create-time) OR
 *                name-derived for legacy boards
 *   - tasklist → '' (root, plus per-board / vault-wide pin via cascade)
 *
 * MindMap and TaskList both defer to the runtime cascade
 * (`getActiveContentFolder`); the `''` return signals "no fixed convention,
 * resolve at the call site."
 */
export function getConventionFolder(boardData: V7BoardFileData): string | null {
  const b = boardData.board as
    | { type?: string; name?: string; kanbanFolder?: string }
    | undefined;
  if (!b || typeof b.type !== 'string') return null;
  return getConventionFolderForBoardType(b.type, b.name, b.kanbanFolder);
}

/**
 * Same as `getConventionFolder` but takes the raw type + name instead of a
 * loaded board file. Useful from contexts that only have the live Board
 * runtime (e.g. drag-drop on the active board).
 *
 * `kanbanFolder` is the frozen create-time folder name
 * stored on KanbanBoardSchema. Pass it through whenever you have it so a
 * renamed Kanban board still resolves its cards under the original folder.
 * When absent (legacy board, mind-map / tasklist call site), the function
 * falls back to the name-derived `Kanban/<sanitize(name)>` for kanban.
 *
 * When `kanbanFolder` contains a path separator (`/`) it is
 * treated as a full vault-relative folder path and the `Kanban/` prefix is
 * NOT applied. This branch is reached after a cross-folder move via
 * `propagateMarkdownRenameToTextTiles` (e.g. user moved `Kanban/Tasks/`
 * out to `Archive/Tasks/` — `kanbanFolder` is rewritten to `Archive/Tasks`).
 * Single-segment values keep the original semantics so existing board files
 * round-trip unchanged.
 */
export function getConventionFolderForBoardType(
  boardType: string,
  boardName: string | undefined,
  kanbanFolder?: string,
): string | null {
  switch (boardType) {
    case 'mindmap': return '';
    case 'kanban': {
      const folder = kanbanFolder?.trim() || sanitizeForFilename(boardName ?? '');
      if (folder.includes('/')) return folder;
      return `Kanban/${folder}`;
    }
    case 'tasklist': return '';
    default: return null;
  }
}

export function joinConventionPath(folder: string, title: string): string {
  return folder ? `${folder}/${title}.md` : `${title}.md`;
}

function splitPath(path: string): { folder: string; base: string } {
  const norm = stripLeadingSlash(toPosix(path));
  const idx = norm.lastIndexOf('/');
  if (idx === -1) return { folder: '', base: norm };
  return { folder: norm.slice(0, idx), base: norm.slice(idx + 1) };
}

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
  const cNorm = normalizeVaultRelative(current);
  const oNorm = normalizeVaultRelative(oldPath);
  const nNorm = stripLeadingSlash(toPosix(newPath));
  const cForward = toPosix(current);
  const oForward = toPosix(oldPath);

  if (cNorm === oNorm) return nNorm;
  if (cNorm.startsWith(oNorm + '/')) {
    return nNorm + cForward.slice(oForward.length);
  }
  return current;
}

/**
 * Iterates every "tile-like" object in a board file (placements, inlineTiles,
 * kanban cards, task data) and invokes `visit` for each.
 * The visitor mutates the object in place; callers decide whether to write
 * the result back.
 *
 * Each branch of the board discriminated union surfaces the fields specific
 * to that board type, forcing the union to be re-narrowed in one place.
 */
function forEachTileLike(
  board: V7BoardFileData,
  visit: (tileId: string, tile: Record<string, unknown>) => void,
): void {
  // Vault-backed tile definitions (image/video/audio/file) carry src/filePath.
  // TileDefinition is .passthrough(), so its inferred type already carries
  // an index signature compatible with Record<string, unknown>.
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
    case 'mindmap': {
      // Inline tiles (link/iframe/timer) rarely hold file refs but scan
      // anyway so future tile types extend here for free.
      for (const [id, tile] of Object.entries(b.inlineTiles ?? {})) {
        visit(id, tile);
      }
      return;
    }
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
    case 'tasklist':
    case 'document':
      return;
  }
}

/**
 * Rewrites every file reference matching `oldPath` (exact match or folder
 * prefix) to use `newPath` instead. Mutates the passed board object in
 * place. Returns the number of fields updated on this board.
 */
export function rewriteRenameInBoard(
  board: V7BoardFileData,
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
 * Applies a rename across a caller-provided map of loaded boards. Returns
 * which boards were changed so the caller can persist only those. Does not
 * perform IPC — the consumer passes the in-memory cache and writes changed
 * boards via `boardSaver.scheduleBoardWrite()`.
 */
export function propagateRenameAcrossBoards(
  boards: Record<string, V7BoardFileData>,
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

function basenameWithoutMd(relPath: string): string | null {
  const norm = toPosix(relPath);
  const base = norm.split('/').pop() ?? '';
  if (!/\.md$/i.test(base)) return null;
  return base.slice(0, -3);
}

/**
 * Text tiles back to a `${title}.md` file by convention rather than via an
 * explicit `file:` field. When that file is renamed, we keep the tile in
 * sync so the next write lands on the correct path.
 *
 * Folder-aware. The convention folder per board type comes from
 * `getConventionFolder` (mindmap & tasklist → vault root, plus the
 * per-board / vault-wide pin cascade; kanban → `Kanban/<name>/`).
 * Three cases:
 *   - **Rename inside the convention folder**: update the tile title so the
 *     convention path still resolves. No explicit `filePath` needed.
 *   - **Move out of the convention folder** (e.g. `Notes.md` → `Sub/Notes.md`
 *     on a mindmap board, convention = root): the convention no longer
 *     points at the file, so we stamp an explicit `filePath` on the tile
 *     definition with the new path. Without this stamp, the next save would
 *     fall back to `${title}.md` at the convention folder and recreate the
 *     file at the old location, producing a duplicate.
 *   - **Move into the convention folder from elsewhere**: rare — the source
 *     wasn't convention-backed for this board, so there's nothing to
 *     rewrite. (Explicit-field tiles are already handled by
 *     `propagateRenameAcrossBoards`.)
 *
 * Tiles that already carry an explicit `file` / `filePath` field are left
 * to `propagateRenameAcrossBoards`.
 */
/**
 * Handles the folder-move branch of
 * `propagateMarkdownRenameToTextTiles`. Updates `board.kanbanFolder` on
 * every kanban board whose convention folder matched the old folder
 * path, so the convention resolver (`getConventionFolderForBoardType`)
 * points at the new location for future card writes.
 *
 * Mutates `boards[boardId].board.kanbanFolder` in place, mirroring the
 * sibling-function mutation pattern. Returns the changed board IDs so
 * the caller can mark them dirty.
 */
function propagateFolderMoveToKanbanFolder(
  boards: Record<string, V7BoardFileData>,
  oldPath: string,
  newPath: string,
): RenameResult {
  // Preserve the user's casing on the stored kanbanFolder by stripping
  // only separators + leading slash here. The case-folded values below
  // (`*Lower`) are reserved for path-equality comparisons against
  // `getConventionFolder`, which returns case-preserved values too.
  const oldFolderPosix = stripLeadingSlash(toPosix(oldPath));
  const newFolderPosix = stripLeadingSlash(toPosix(newPath));
  if (!oldFolderPosix || !newFolderPosix || oldFolderPosix === newFolderPosix) {
    return { updatedCount: 0, changedBoardIds: [] };
  }
  const oldFolderLower = normalizeVaultRelative(oldPath);

  const changedBoardIds: string[] = [];
  for (const [boardId, data] of Object.entries(boards)) {
    if (data.board?.type !== 'kanban') continue;
    const conventionFolder = getConventionFolder(data);
    if (conventionFolder === null) continue;
    if (normalizeVaultRelative(conventionFolder) !== oldFolderLower) continue;
    // Stamp the new folder onto the board (legacy boards get freeze-then-
    // update collapsed into a single assignment — the old value, if any,
    // pointed at the OLD folder anyway).
    (data.board as { kanbanFolder?: string }).kanbanFolder = newFolderPosix;
    changedBoardIds.push(boardId);
  }
  return { updatedCount: changedBoardIds.length, changedBoardIds };
}

export function propagateMarkdownRenameToTextTiles(
  boards: Record<string, V7BoardFileData>,
  oldPath: string,
  newPath: string,
  options?: {
    activeRootFolder?: string;
    boardDefaultFolders?: Record<string, string | undefined>;
  },
): RenameResult {
  const oldSplit = splitPath(oldPath);
  const newSplit = splitPath(newPath);
  const oldTitle = basenameWithoutMd(oldSplit.base);
  const newTitle = basenameWithoutMd(newSplit.base);

  // When neither path ends in `.md`, treat the rename as
  // a FOLDER move and rewrite the convention abstraction. For each kanban
  // board whose convention folder matched the old path, update
  // `kanbanFolder` to the new full vault-relative path so subsequent card
  // writes (and the `getConventionFolderForBoardType` resolver) land at
  // the new location. Legacy boards (kanbanFolder absent) get frozen
  // straight to the new path — same outcome as freeze-then-update.
  //
  // Cards that previously had explicit `file` / `filePath` refs are
  // independently rewritten by `propagateRenameAcrossBoards` (folder
  // prefix-match). Convention-backed cards (no explicit field) now
  // resolve correctly under the new convention folder.
  if (!oldTitle || !newTitle) {
    return propagateFolderMoveToKanbanFolder(boards, oldPath, newPath);
  }
  const oldLower = oldTitle.toLowerCase();
  const oldFolderNorm = normalizeVaultRelative(oldSplit.folder);
  const newFolderNorm = normalizeVaultRelative(newSplit.folder);
  const newPathForward = stripLeadingSlash(toPosix(newPath));
  const rawVaultPin = options?.activeRootFolder?.trim() ?? '';
  const norm = (s: string): string => normalizePath(s);

  const changedBoardIds: string[] = [];
  let total = 0;

  for (const [boardId, data] of Object.entries(boards)) {
    const baseFolder = getConventionFolder(data);
    if (baseFolder === null) continue;
    const rawBoardPin = options?.boardDefaultFolders?.[boardId]?.trim() ?? '';
    const folder: string =
      baseFolder === ''
        ? rawVaultPin
          ? norm(rawVaultPin)
          : rawBoardPin
            ? norm(rawBoardPin)
            : ''
        : baseFolder;
    const folderNorm = normalizeVaultRelative(folder);
    // The OLD path must sit in this board's convention folder for the tile
    // to have been convention-backed in the first place. If not, the tile
    // either had an explicit file ref (handled elsewhere) or it never
    // pointed at the file being renamed.
    if (oldFolderNorm !== folderNorm) continue;

    const defs = data.tileDefs ?? {};
    const updates: Record<string, unknown> = {};
    const movesOutOfConvention = newFolderNorm !== folderNorm;

    for (const [tileId, def] of Object.entries(defs)) {
      const d = def as Record<string, unknown>;
      if (d.type !== 'text') continue;
      if (d.file || d.filePath) continue;
      const t = d.title;
      if (typeof t !== 'string') continue;
      if (t.trim().toLowerCase() !== oldLower) continue;

      if (movesOutOfConvention) {
        // Stamp the new path so subsequent writes go to the moved location
        // instead of recreating ${title}.md at the convention folder. Keep
        // the title as-is so the tile header still reads sensibly.
        updates[tileId] = { ...d, filePath: newPathForward, updatedAt: Date.now() };
      } else {
        // In-folder rename: just rename the convention key (the title).
        updates[tileId] = { ...d, title: newTitle, updatedAt: Date.now() };
      }
      total++;
    }
    if (Object.keys(updates).length > 0) {
      data.tileDefs = { ...defs, ...updates } as typeof data.tileDefs;
      changedBoardIds.push(boardId);
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
 *   - `file` / `src` / `filePath` exact-or-prefix match (handles folder deletes).
 *   - Convention-backed text tiles: the tile's expected `<folder>/<title>.md`
 *     (per its host board's V7 convention) is exact-or-prefix match against
 *     `deletedPath`. Naturally covers folder deletes (e.g. removing `Tasks/`
 *     cascades to every tile in any tasklist board).
 *   - Kanban placement `coverImage`: returned as a separate `coverImageClears`
 *     entry rather than a tile removal so the card itself survives — only the
 *     dead cover image reference is cleared.
 */
export function findTilesToCascadeDelete(
  boards: Record<string, V7BoardFileData>,
  deletedPath: string,
  options?: {
    activeRootFolder?: string;
    /** Map of boardId → that board's `settings.defaultFolder` (vault-relative). */
    boardDefaultFolders?: Record<string, string | undefined>;
  },
): DeleteCascadeResult {
  const byBoard: Record<string, string[]> = {};
  const coverImageClears: Record<string, CoverImageClear[]> = {};
  const columnCoverImageClears: Record<string, ColumnCoverImageClear[]> = {};
  const frameBackgroundClears: Record<string, FrameBackgroundClear[]> = {};
  const boardSettingsClears: Record<string, BoardSettingsBackgroundClear[]> = {};
  let totalCount = 0;
  const rawVaultPin = options?.activeRootFolder?.trim() ?? '';
  const norm = (s: string): string => normalizePath(s);

  // Track field names that should NOT trigger tile-removal when matched on a
  // tile def. backgroundImage lands on tile defs only via passthrough leak —
  // there's no tile type that legitimately stores it — but if a future
  // version does, we don't want to nuke the whole tile because of a missing
  // background. The frame-bg scan below handles the legitimate carriers.
  const REMOVE_TILE_ON_MATCH_FIELDS = ['file', 'src', 'filePath'] as const;

  for (const [boardId, data] of Object.entries(boards)) {
    const baseFolder = getConventionFolder(data);
    const rawBoardPin = options?.boardDefaultFolders?.[boardId]?.trim() ?? '';
    // Cascade matches detectBrokenRefs: only override the base when it's the
    // cascade-aware '' (mindmap, tasklist).
    const conventionFolder: string | null =
      baseFolder === ''
        ? rawVaultPin
          ? norm(rawVaultPin)
          : rawBoardPin
            ? norm(rawBoardPin)
            : ''
        : baseFolder;
    const tilesToRemove: string[] = [];
    for (const [tileId, def] of Object.entries(data.tileDefs ?? {})) {
      const d = def as Record<string, unknown>;
      let matched = false;
      for (const field of REMOVE_TILE_ON_MATCH_FIELDS) {
        const v = d[field];
        if (typeof v !== 'string' || !v) continue;
        if (pathStartsWith(v, deletedPath)) { matched = true; break; }
      }
      if (
        !matched
        && conventionFolder !== null
        && d.type === 'text'
        && !d.file
        && !d.filePath
        && typeof d.title === 'string'
      ) {
        const conventionPath = joinConventionPath(conventionFolder, d.title.trim());
        if (pathStartsWith(conventionPath, deletedPath)) matched = true;
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
  board: V7BoardFileData,
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
 * Two passes:
 *   1. Explicit field refs (`file` / `src` / `filePath`) via `collectFileRefs`.
 *   2. Convention-backed text tiles: each text tile's expected
 *      `<folder>/<title>.md` (where folder is derived from the host board's
 *      type) must exist on disk. Catches Kanban / TaskList / MindMap text
 *      tiles whose backing `.md` was renamed or deleted externally.
 */
export function detectBrokenRefs(
  board: V7BoardFileData,
  knownPaths: ReadonlySet<string> | Iterable<string>,
  options?: { activeRootFolder?: string; boardDefaultFolder?: string },
): BrokenReference[] {
  const known =
    knownPaths instanceof Set
      ? (knownPaths as ReadonlySet<string>)
      : new Set(Array.from(knownPaths));
  const knownNormalized = new Set<string>();
  for (const p of known) knownNormalized.add(normalizeVaultRelative(p));

  const broken: BrokenReference[] = [];
  const flaggedTileIds = new Set<string>();
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
      flaggedTileIds.add(ref.tileId);
    }
  }

  // Convention-backed text tiles: only flag tiles actually placed on the
  // host board. An orphaned tileDef with no placement is not user-visible
  // and doesn't warrant a broken-ref badge.
  //
  // Cascade priority for the convention folder:
  //   1. vault-wide pin (`activeRootFolder`)
  //   2. per-board pin (`boardDefaultFolder`)
  //   3. base convention folder (mindmap='', tasklist='', kanban='Kanban/...')
  // The cascade only applies when the base folder is the cascade-aware ''
  // (mindmap, tasklist). Kanban's name-derived folder ignores both pins.
  const baseFolder = getConventionFolder(board);
  const rawVaultPin = options?.activeRootFolder?.trim() ?? '';
  const rawBoardPin = options?.boardDefaultFolder?.trim() ?? '';
  const norm = (s: string): string => normalizePath(s);
  const conventionFolder =
    baseFolder === ''
      ? rawVaultPin
        ? norm(rawVaultPin)
        : rawBoardPin
          ? norm(rawBoardPin)
          : ''
      : baseFolder;
  if (conventionFolder !== null) {
    const placedTileIds = collectPlacedTileIds(board);
    for (const [tileId, def] of Object.entries(board.tileDefs ?? {})) {
      if (flaggedTileIds.has(tileId)) continue;
      if (!placedTileIds.has(tileId)) continue;
      const d = def as Record<string, unknown>;
      if (d.type !== 'text') continue;
      if (d.file || d.filePath) continue;
      if (typeof d.title !== 'string') continue;
      const conventionPath = joinConventionPath(conventionFolder, d.title.trim());
      if (!knownNormalized.has(normalizeVaultRelative(conventionPath))) {
        broken.push({ tileId, field: 'title', missingPath: conventionPath });
      }
    }
  }

  return broken;
}

/**
 * Returns the set of tileIds that appear in any of the host board's
 * placement collections. Used by broken-ref detection so that orphaned
 * `tileDefs` (an entry with no placement) don't produce phantom badges.
 */
function collectPlacedTileIds(board: V7BoardFileData): Set<string> {
  const ids = new Set<string>();
  const b: Board | undefined = board.board;
  if (!b) return ids;
  switch (b.type) {
    case 'mindmap':
      for (const id of Object.keys(b.placements ?? {})) ids.add(id);
      return ids;
    case 'kanban':
      for (const col of b.columns ?? []) {
        for (const p of col.tilePlacements ?? []) {
          if (typeof p.tileId === 'string') ids.add(p.tileId);
        }
      }
      return ids;
    case 'tasklist':
      for (const p of b.tasks ?? []) {
        if (typeof p.tileId === 'string') ids.add(p.tileId);
      }
      return ids;
    case 'document':
      return ids;
  }
}

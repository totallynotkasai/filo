/**
 * boardLoader — reads and validates .board.json files from disk via IPC.
 *
 * Provides a single entry point for loading board files. Handles schema
 * validation via Zod and returns typed BoardFileData. Broken file-reference
 * detection runs in `boardRefIntegrityStore.recompute(knownVaultPaths)` once
 * the vault file tree is known — keeping the load path stateless avoids
 * shipping a `fileExists` callback into every caller.
 */

import type { Board, Connection, Frame } from '../../schema/index';
import { BoardFileDataSchema, migrateBoardFile, CURRENT_BOARD_FILE_VERSION } from '../../schema/index';
import { TILE_TYPES } from '../../schema/tile';
import type { BoardFileData } from './boardSaver';
import { reportError } from '../utils/errorBus';
import { invokeOk } from '../utils/invokeOk';
import { IpcEnvelopeError } from '@shared/ipcEnvelope';
import { baselineSeq, type BaselineSeq } from '../vault/fileBaselineRegistry';
import { loadVersionedFile } from '../vault/loadVersionedFile';
import { detectConflictCopyPath } from '@shared/conflictCopy';
import { safeFileName } from '@shared/fileNames';
import { boardNameFromPath } from './boardNaming';

// allow-module-state: immutable lookup table derived from a build-time constant
const TILE_TYPE_SET: ReadonlySet<string> = new Set(TILE_TYPES);

/**
 * Strips tile-def entries whose `type` isn't in the live `TILE_TYPES` union
 * (a hand-edited or foreign def), so one unknown def doesn't fail the whole
 * board. Returns the
 * dropped types (deduplicated) so the caller can surface a single toast
 * per board.
 *
 * Mutates `raw.tileDefs` in place — the migration output is a freshly
 * shallow-cloned envelope, so this is safe.
 */
function preFilterUnknownTileTypes(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return [];
  const tileDefs = (raw as { tileDefs?: unknown }).tileDefs;
  if (!tileDefs || typeof tileDefs !== 'object' || Array.isArray(tileDefs)) return [];
  const defs = tileDefs as Record<string, unknown>;
  const dropped = new Set<string>();
  for (const [id, def] of Object.entries(defs)) {
    if (!def || typeof def !== 'object') continue;
    const type = (def as { type?: unknown }).type;
    if (typeof type !== 'string' || !TILE_TYPE_SET.has(type)) {
      dropped.add(typeof type === 'string' ? type : String(type));
      delete defs[id];
    }
  }
  return [...dropped];
}

/**
 * Summary of what `pruneOrphanRefsAndDuplicates` removed from
 * a raw envelope before schema validation. Empty totals mean "no prune
 * ran" — the loader uses this to decide whether to surface a toast and
 * write a recovery snapshot.
 */
interface OrphanPruneReport {
  /** Connection IDs dropped because either endpoint referenced a missing tileId. */
  orphanConnections: string[];
  /** Frame IDs whose `tileIds` array had at least one orphan stripped. */
  framesWithStrippedTileIds: string[];
  /**
   * Kanban duplicate placements removed (within or across columns). Each
   * entry is the tileId that was a duplicate — first occurrence is kept,
   * subsequent ones are dropped.
   */
  droppedKanbanDuplicates: string[];
  /** Task List duplicate placements dropped (first occurrence kept). */
  droppedTaskListDuplicates: string[];
  /**
   * Connection / frame / mindmap-group refs whose nested
   * `boardId` disagreed with `envelope.board.id` and was rewritten to match.
   * Each entry is a `kind:id` tag (e.g. `connection:c1`, `frame:f1`,
   * `group:g1`) for diagnostics. Deliberately NOT counted by
   * `orphanReportHasFindings`: a boardId rewrite is a benign, deterministic
   * self-heal (the correct value *is* `board.id`), so it must not trip the
   * orphan-prune recovery snapshot / refuse-to-load path. It is surfaced via
   * the separate `boardIdsNormalized` result flag, which marks the board
   * dirty so the repair reaches disk.
   */
  normalizedBoardIdRefs: string[];
}

function emptyOrphanReport(): OrphanPruneReport {
  return {
    orphanConnections: [],
    framesWithStrippedTileIds: [],
    droppedKanbanDuplicates: [],
    droppedTaskListDuplicates: [],
    normalizedBoardIdRefs: [],
  };
}

function orphanReportHasFindings(r: OrphanPruneReport): boolean {
  // NB: `normalizedBoardIdRefs` is intentionally excluded — see its docstring.
  // A boardId self-heal must not trigger the snapshot / refuse-to-load path.
  return (
    r.orphanConnections.length > 0 ||
    r.framesWithStrippedTileIds.length > 0 ||
    r.droppedKanbanDuplicates.length > 0 ||
    r.droppedTaskListDuplicates.length > 0
  );
}

/**
 * Set of tile IDs that are valid connection /
 * frame.tileIds targets on this envelope. Mirrors the validity set used by
 * `BoardFileDataSchema`'s superRefine so the loader's pre-parse prune and
 * the schema's cross-check stay in lockstep.
 *
 * - All board types: `tileDefs` keys are valid (vault-backed tiles).
 * - Mind Map only: `board.inlineTiles` keys are ALSO valid. Inline tiles
 *   (Link / Iframe / Timer) live on the board itself rather than tileDefs
 *   but are tiles on the canvas and can be connection / frame
 *   members.
 */
function collectValidTileIds(envelope: {
  tileDefs?: Record<string, unknown>;
  board?: { type?: string; inlineTiles?: Record<string, unknown> };
}): Set<string> {
  const ids = new Set<string>(Object.keys(envelope.tileDefs ?? {}));
  if (envelope.board?.type === 'mindmap') {
    for (const id of Object.keys(envelope.board.inlineTiles ?? {})) ids.add(id);
  }
  return ids;
}

/**
 * Strips orphan connection refs, orphan IDs from
 * `frame.tileIds`, and duplicate placements (Kanban / Task List) from a
 * raw envelope IN PLACE. Mirrors the `preFilterUnknownTileTypes` pattern:
 * any structural inconsistency that would otherwise route the entire
 * board to `failedBoards` is normalised here into a "load with a toast"
 * outcome instead.
 *
 * This is intentionally a forgiving prune, not a reject — a single bad
 * connection should not kill an otherwise-loadable board. The recovery
 * snapshot path (caller-owned, see `loadBoard`) preserves the original
 * bytes so the user can recover the dropped entities by hand if needed.
 */
function pruneOrphanRefsAndDuplicates(raw: unknown): OrphanPruneReport {
  const report = emptyOrphanReport();
  if (!raw || typeof raw !== 'object') return report;
  const envelope = raw as {
    tileDefs?: Record<string, unknown>;
    connections?: Record<string, unknown>;
    frames?: unknown[];
    board?: {
      id?: unknown;
      type?: string;
      columns?: unknown[];
      tasks?: unknown[];
      inlineTiles?: Record<string, unknown>;
      groups?: unknown[];
    };
  };
  const tileIds = collectValidTileIds(envelope);

  // Orphan connections — drop entries where either endpoint is missing.
  if (envelope.connections && typeof envelope.connections === 'object') {
    for (const [id, c] of Object.entries(envelope.connections)) {
      if (!c || typeof c !== 'object') continue;
      const { fromTileId, toTileId } = c as { fromTileId?: unknown; toTileId?: unknown };
      if (
        typeof fromTileId !== 'string' ||
        typeof toTileId !== 'string' ||
        !tileIds.has(fromTileId) ||
        !tileIds.has(toTileId)
      ) {
        report.orphanConnections.push(id);
        delete envelope.connections[id];
      }
    }
  }

  // Frame.tileIds — filter to only refs that exist in tileDefs.
  if (Array.isArray(envelope.frames)) {
    for (const f of envelope.frames) {
      if (!f || typeof f !== 'object') continue;
      const frame = f as { id?: string; tileIds?: unknown[] };
      if (!Array.isArray(frame.tileIds)) continue;
      const next: string[] = [];
      let stripped = false;
      for (const id of frame.tileIds) {
        if (typeof id === 'string' && tileIds.has(id)) {
          next.push(id);
        } else {
          stripped = true;
        }
      }
      if (stripped) {
        frame.tileIds = next;
        if (typeof frame.id === 'string') report.framesWithStrippedTileIds.push(frame.id);
      }
    }
  }

  // Kanban duplicate placements — keep first occurrence per tileId across
  // every column. The existing union-level `superRefine` rejects boards
  // with cross-column dupes, so without this prune the entire board would
  // fail to load on the first hit.
  if (envelope.board?.type === 'kanban') {
    const seen = new Set<string>();
    for (const col of envelope.board.columns ?? []) {
      const column = col as { tilePlacements?: unknown[] };
      if (!Array.isArray(column.tilePlacements)) continue;
      const next: unknown[] = [];
      for (const p of column.tilePlacements) {
        const tid = (p as { tileId?: unknown })?.tileId;
        if (typeof tid !== 'string') {
          next.push(p);
          continue;
        }
        if (seen.has(tid)) {
          report.droppedKanbanDuplicates.push(tid);
          continue;
        }
        seen.add(tid);
        next.push(p);
      }
      column.tilePlacements = next;
    }
  }

  // Task List duplicate placements — keep first occurrence. Mirrors the
  // Kanban path; the schema's `uniqueBy('tileId', 'tasks')` refine would
  // otherwise reject the entire board on any dupe.
  if (envelope.board?.type === 'tasklist' && Array.isArray(envelope.board.tasks)) {
    const seen = new Set<string>();
    const next: unknown[] = [];
    for (const p of envelope.board.tasks) {
      const tid = (p as { tileId?: unknown })?.tileId;
      if (typeof tid !== 'string') {
        next.push(p);
        continue;
      }
      if (seen.has(tid)) {
        report.droppedTaskListDuplicates.push(tid);
        continue;
      }
      seen.add(tid);
      next.push(p);
    }
    envelope.board.tasks = next;
  }

  // Normalize nested boardId refs to the envelope's `board.id`. The
  // superRefine in `schema/boardFile.ts` only warns on a mismatch and relies on
  // THIS pass to repair it. A stale / foreign boardId (copied connections, a
  // third-party tool, a restored file) would otherwise round-trip unrepaired and
  // could mask a cross-board mix-up. Repair is deterministic, so no recovery
  // snapshot is taken; `boardIdsNormalized` marks the board dirty so it persists.
  const canonicalBoardId = envelope.board?.id;
  if (typeof canonicalBoardId === 'string' && canonicalBoardId.length > 0) {
    if (envelope.connections && typeof envelope.connections === 'object') {
      for (const [id, c] of Object.entries(envelope.connections)) {
        if (!c || typeof c !== 'object') continue;
        const conn = c as { boardId?: unknown };
        if (typeof conn.boardId === 'string' && conn.boardId !== canonicalBoardId) {
          conn.boardId = canonicalBoardId;
          report.normalizedBoardIdRefs.push(`connection:${id}`);
        }
      }
    }
    if (Array.isArray(envelope.frames)) {
      for (const f of envelope.frames) {
        if (!f || typeof f !== 'object') continue;
        const frame = f as { id?: unknown; boardId?: unknown };
        if (typeof frame.boardId === 'string' && frame.boardId !== canonicalBoardId) {
          frame.boardId = canonicalBoardId;
          report.normalizedBoardIdRefs.push(
            `frame:${typeof frame.id === 'string' ? frame.id : '?'}`,
          );
        }
      }
    }
    if (envelope.board?.type === 'mindmap' && Array.isArray(envelope.board.groups)) {
      for (const g of envelope.board.groups) {
        if (!g || typeof g !== 'object') continue;
        const group = g as { id?: unknown; boardId?: unknown };
        if (typeof group.boardId === 'string' && group.boardId !== canonicalBoardId) {
          group.boardId = canonicalBoardId;
          report.normalizedBoardIdRefs.push(
            `group:${typeof group.id === 'string' ? group.id : '?'}`,
          );
        }
      }
    }
  }

  return report;
}

export interface LoadBoardResult {
  ok: true;
  data: BoardFileData;
  /**
   * The format version the file is in when migration steps carried it to the
   * current one, else `null`. The file itself is unchanged.
   */
  migratedFrom: number | null;
  /**
   * Unknown tile-def types stripped before schema validation (a hand-edited
   * or foreign def). Empty when every def passed the live `TILE_TYPES`
   * allowlist.
   */
  droppedTileTypes: string[];
  /**
   * True when `pruneOrphanRefsAndDuplicates` removed at least one orphan
   * connection / orphan frame ref / duplicate placement. The caller marks
   * the board dirty so the pruned shape lands on disk and the orphans
   * don't re-surface on every reopen. The original is preserved at
   * `.filo/recovery/` (see snapshot path emitted in the toast).
   */
  orphansPruned: boolean;
  /**
   * The name the file's JSON declares. `data.board.name` is the file stem;
   * this is kept only to rank two files that claim the same board id.
   */
  declaredName?: string;
  /**
   * True when `pruneOrphanRefsAndDuplicates` rewrote at least one
   * nested connection / frame / mindmap-group `boardId` to match
   * `board.id`. Benign self-heal: unlike `orphansPruned` it takes no recovery
   * snapshot and never refuses the load. The caller marks the board dirty so
   * the corrected values land on disk.
   */
  boardIdsNormalized: boolean;
  /**
   * The file's mtime from the bracketing pre-read stat, used
   * to rank two files that declare the same board id. Undefined when the stat
   * failed.
   */
  mtimeMs?: number;
  /**
   * The stat of the bytes loaded, when the stats bracketing the read agreed,
   * plus the baseline ticket taken before the read; otherwise the JSON read,
   * so the first save can tell whether the file still holds it. The loader
   * never stamps it: only a caller that adopts `data` into the cache may
   * (`adoptLoadedBoardBaseline`). A load that fails, or whose data is set
   * aside, must leave the old baseline in place, or the next save would take
   * the outside version as Filo's own and overwrite it without asking.
   */
  baseline?: LoadedBoardBaseline;
}

/** The stat a successful load read, and the ticket to stamp it with. */
export interface PinnedBoardBaseline {
  mtimeMs: number;
  size: number;
  seq: BaselineSeq;
}

/**
 * A load whose version on disk no stat pinned (the first stat failed, or a
 * write landed around the read): the JSON it read, re-serialised.
 */
export interface UnpinnedBoardLoad {
  readJson: string;
}

export type LoadedBoardBaseline = (PinnedBoardBaseline | UnpinnedBoardLoad) & {
  /**
   * The file is in this older board format and no copy of it was kept at
   * load: its first save keeps one before writing the current format over it.
   */
  olderFormat?: number;
};

export interface LoadBoardError {
  ok: false;
  error:
    | 'not-found'
    | 'parse-error'
    | 'schema-invalid'
    | 'io-error'
    | 'from-future'
    // Made by an older Filo (or no/fractional version). Refused, never
    // migrated or written. Surfaces a different toast than `from-future`.
    | 'no-migration-path'
    // Board needed orphan-ref / duplicate prune but the
    // `recovery:snapshot` IPC failed, so we have nowhere to preserve the
    // original bytes. We refuse to load (and therefore can't subsequently
    // overwrite the disk file with the pruned shape).
    | 'snapshot-failed'
    // Transient / size failures, reported explicitly rather than as "not-found".
    | 'locked'
    | 'offline'
    | 'too-large';
  message: string;
  /** Every validation problem (`schema-invalid`); `message` names the first few. */
  problems?: string[];
}

/** How many validation problems a message names before "and N more". */
const PROBLEMS_SHOWN = 3;

/**
 * The first few problems and how many more: a big board with one bad field
 * per tile has hundreds, which no notice can show.
 */
export function summariseProblems(problems: readonly string[]): string {
  const shown = problems.slice(0, PROBLEMS_SHOWN).join('; ');
  const more = problems.length - PROBLEMS_SHOWN;
  return more > 0 ? `${shown}; and ${more} more` : shown;
}

/**
 * Failure kinds worth a Retry (the file is there, just not
 * readable right now). They are NOT snapshotted to .filo/recovery/ (a snapshot
 * of a locked / online-only file fails or hydrates the placeholder).
 */
export function isTransientBoardLoadError(kind: string): boolean {
  return kind === 'locked' || kind === 'offline' || kind === 'io-error';
}

/** Maps a `board:load` failure code to the loader's error kind. */
function boardLoadErrorKind(code: string | undefined): LoadBoardError['error'] {
  switch (code) {
    case 'ENOENT': return 'not-found';
    case 'LOCKED': return 'locked';
    case 'OFFLINE': return 'offline';
    case 'TOO_LARGE': return 'too-large';
    case 'PARSE': return 'parse-error';
    default: return 'io-error';
  }
}

function boardLoadErrorMessage(kind: LoadBoardError['error'], relPath: string, detail: string): string {
  switch (kind) {
    case 'locked': return `"${relPath}" is locked by another program (OneDrive, antivirus).`;
    case 'offline': return `"${relPath}" is online-only and this PC can't download it right now.`;
    case 'too-large': return `"${relPath}" is larger than the 50 MB board limit.`;
    case 'not-found': return `No board at ${relPath}`;
    default: return `Filo couldn't read "${relPath}" (${detail}).`;
  }
}

/**
 * Single failed-board entry returned by `loadAllBoards`. Carries the
 * vault-relative path that failed to load, the classifier reason, and the
 * detail message. Callers route these through `recovery:snapshot` (so the
 * original file is preserved before any rewrite can clobber it) and
 * surface a toast via `errorBus.reportError`.
 */
export interface FailedBoardEntry {
  path: string;
  // `loadBoard` never returns `'duplicate-board-id'` — it's detected at the
  // aggregate level in `loadAllBoards` when two files declare the same
  // `board.id`. Widening here (rather than in `LoadBoardError`)
  // keeps `loadBoard`'s own return type honest.
  // 'sync-conflict-copy': a duplicate-id loser whose name is a
  // sync-client conflict copy of another board file.
  errorKind: LoadBoardError['error'] | 'duplicate-board-id' | 'sync-conflict-copy';
  message: string;
  problems?: string[];
}

/**
 * Loads a single .board.json file from the vault. Validates the board
 * shape with Zod. Broken file-reference detection is the responsibility of
 * `boardRefIntegrityStore` — it runs once after the vault file tree is
 * known, against every loaded board at once.
 */
export async function loadBoard(
  vaultRoot: string,
  relPath: string,
): Promise<LoadBoardResult | LoadBoardError> {
  // Stat the file BEFORE the content read so the post-read stat below can be
  // BRACKETED. The baseline must reflect the bytes we actually loaded; a foreign
  // write in the read→stat gap would otherwise become "our" baseline and the
  // next save would clobber it with no drift prompt. A failed
  // pre-stat offers no baseline (the path is then read before its first save).
  //
  // The ticket is taken before the first stat: a save of this board that lands
  // while the load is in flight refreshes the baseline, and this load's older
  // stat must not then roll it back (the next save would see its own previous
  // write as an external edit).
  const seq = baselineSeq(relPath);
  let preStat: { mtimeMs: number; size: number } | null = null;
  try {
    preStat = await invokeOk('vault:stat', vaultRoot, relPath);
  } catch {
    preStat = null;
  }

  // Main returns the parsed board inside an envelope with a typed failure code;
  // a bare payload (or `null`) is accepted, for test stubs.
  let raw: unknown;
  try {
    const res: unknown = await invokeOk('board:load', vaultRoot, relPath);
    raw = res !== null && typeof res === 'object' && 'success' in res ? (res as { data?: unknown }).data : res;
  } catch (err) {
    const kind = boardLoadErrorKind(err instanceof IpcEnvelopeError ? err.code : undefined);
    return { ok: false, error: kind, message: boardLoadErrorMessage(kind, relPath, `${err}`) };
  }
  if (raw == null) {
    return { ok: false, error: 'not-found', message: `No board at ${relPath}` };
  }

  // The file's stat, for the caller to stamp as the drift baseline once it
  // adopts the data (`writeBoardFile`'s pre-write check compares against it).
  //
  // Stat-read-stat: a stat is offered ONLY when the bracketing stats match
  // (mtime + size). A mismatch means a write landed around the content read, so
  // this stat reflects bytes we didn't load. Then (or when a stat failed) the
  // JSON read is offered instead: the adopter marks the path unverified
  // (`adoptLoadedBoardBaseline`), and the first save reads the file and asks
  // unless it still holds this JSON or already holds Filo's bytes. Taken here,
  // before the prune below edits `raw` in place.
  let baseline: LoadedBoardBaseline | undefined;
  try {
    const stat = await invokeOk('vault:stat', vaultRoot, relPath);
    if (preStat && preStat.mtimeMs === stat.mtimeMs && preStat.size === stat.size) {
      baseline = { mtimeMs: stat.mtimeMs, size: stat.size, seq };
    }
  } catch {
    // Non-fatal: the JSON read stands in for the stat below.
  }
  if (!baseline) baseline = { readJson: JSON.stringify(raw) };

  // Anything that isn't the current format (including a non-object) is
  // classified by the version gate in `migrateBoardFile` below.
  const rawJson: unknown = raw;

  // Route migrate → prune → validate through the shared versioned-load helper
  // (`loadVersionedFile`) so the migrate-before-parse ordering and the
  // from-future / no-migration-path short-circuits match every other versioned
  // config loader. The `transform` slot runs the board-specific prune:
  //
  //  - strip tile-def entries whose `type` isn't in the live `TILE_TYPES`
  //    union, which the schema's discriminated union would otherwise reject
  //    outright — routing the whole board to `failedBoards`;
  //  - prune orphan connection / frame refs + duplicate Kanban / Task
  //    placements so one bad ref doesn't fail the entire board.
  //
  // The transform mutates the migrated-but-unparsed envelope in place; the
  // on-disk file is untouched until a future save, so the recovery snapshot
  // below (which copies the disk file) preserves the original regardless of
  // when it runs relative to this in-memory prune.
  let droppedTileTypes: string[] = [];
  let orphanReport: OrphanPruneReport = emptyOrphanReport();
  const loaded = loadVersionedFile(
    BoardFileDataSchema,
    migrateBoardFile,
    rawJson,
    (data) => {
      droppedTileTypes = preFilterUnknownTileTypes(data);
      // Orphan / duplicate prune runs AFTER the unknown-type strip so
      // connection/frame refs are validated against the trimmed tileDefs (a
      // connection pointing at a stripped-away tile is ALSO an
      // orphan and should be pruned in the same pass).
      orphanReport = pruneOrphanRefsAndDuplicates(data);
      return data;
    },
  );

  // Short-circuit files declaring a `version` higher than
  // this build understands. The schema parse would otherwise return a
  // generic "Invalid literal value, expected 7" — accurate but useless to
  // the user, who really needs to know they're trying to load a file
  // saved by a newer Filo. We don't attempt any structural translation;
  // guessing at downgrade rules is worse than refusing.
  if (loaded.status === 'from-future') {
    return {
      ok: false,
      error: 'from-future',
      message:
        `This board was saved by a newer version of Filo (file version ${loaded.migratedFrom}, this build understands up to ${CURRENT_BOARD_FILE_VERSION}). ` +
        'Update Filo to load it.',
    };
  }

  // A board from an older Filo format that no step carries forward (or whose
  // step failed). Refused, and never written, so the file stays as it was.
  if (loaded.status === 'no-migration-path') {
    return {
      ok: false,
      error: 'no-migration-path',
      message: loaded.failure !== undefined
        ? `This board was made by an older Filo, and updating it to this version's format failed (${loaded.failure}). The file was left unchanged.`
        : 'This board was made by an older Filo and is not supported. The file was left unchanged.',
    };
  }

  // If the prune actually mutated the envelope, preserve the on-disk original
  // in `.filo/recovery/` BEFORE any future save can rewrite the file with the
  // pruned shape. `recovery:snapshot` copies the disk file (untouched by the
  // in-memory prune above). If the snapshot can't be written we refuse to load — building in-memory state from the
  // pruned shape would let the next save clobber the unrecoverable original.
  const prunedAny =
    droppedTileTypes.length > 0 || orphanReportHasFindings(orphanReport);
  let snapshotPath: string | null = null;
  if (prunedAny) {
    try {
      // `invokeOk` throws on the `{ ok: false }` envelope so a snapshot
      // failure keeps `snapshotPath` null and trips the abort below. The copy
      // is the only one of what the prune dropped, so it goes in a `-keep`
      // folder, which the recovery prunes never remove.
      const snap = await invokeOk('recovery:snapshot', vaultRoot, relPath, 'keep');
      snapshotPath = snap.path;
    } catch (err) {
      const detail = err instanceof IpcEnvelopeError ? `${err.code ?? '?'}: ${err.message}` : String(err);
      console.warn(`[boardLoader] recovery:snapshot failed for ${relPath}: ${detail}`);
    }
    if (snapshotPath === null) {
      return {
        ok: false,
        error: 'snapshot-failed',
        message:
          `Could not preserve ${relPath} before pruning orphan refs. ` +
          'Board not loaded. Restore write access to `.filo/recovery/` ' +
          'or back up the file manually.',
      };
    }
  }

  if (loaded.status === 'invalid') {
    // Prefix each issue with its path: Zod 4 messages are generic
    // ("Invalid input: expected number, received undefined"), so without
    // the path the recovery toast can't point at the broken field.
    const problems = loaded.error.issues
      .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message));
    if (problems.length > PROBLEMS_SHOWN) {
      console.warn(`[boardLoader] ${relPath}: ${problems.length} problems\n${problems.join('\n')}`);
    }
    return { ok: false, error: 'schema-invalid', message: summariseProblems(problems), problems };
  }

  const data = loaded.data;

  // A board carried forward from an older format is still in that format on
  // disk. Unless the repair above already kept a copy of the file, its first
  // save keeps one before writing over it.
  if (loaded.migratedFrom !== null && snapshotPath === null) {
    baseline = { ...baseline, olderFormat: loaded.migratedFrom };
  }

  if (droppedTileTypes.length > 0) {
    const boardName = data.board.name || relPath;
    const snapshotHint = snapshotPath
      ? ` Original preserved at ${snapshotPath}.`
      : '';
    reportError(
      'board-load-unknown-tile-types',
      `Dropped unknown tile types from "${boardName}": ${droppedTileTypes.join(', ')}`,
      `Filo dropped unknown tile types from "${boardName}" (${droppedTileTypes.join(', ')}). Reopen the board to confirm nothing important is missing.${snapshotHint}`,
    );
  }

  if (orphanReportHasFindings(orphanReport)) {
    const boardName = data.board.name || relPath;
    const parts: string[] = [];
    if (orphanReport.orphanConnections.length > 0) {
      parts.push(`${orphanReport.orphanConnections.length} orphan connection(s)`);
    }
    if (orphanReport.framesWithStrippedTileIds.length > 0) {
      parts.push(`orphan tile refs in ${orphanReport.framesWithStrippedTileIds.length} frame(s)`);
    }
    if (orphanReport.droppedKanbanDuplicates.length > 0) {
      parts.push(`${orphanReport.droppedKanbanDuplicates.length} duplicate card placement(s)`);
    }
    if (orphanReport.droppedTaskListDuplicates.length > 0) {
      parts.push(`${orphanReport.droppedTaskListDuplicates.length} duplicate task placement(s)`);
    }
    const summary = parts.join(', ');
    const snapshotHint = snapshotPath
      ? ` Original preserved at ${snapshotPath}.`
      : '';
    reportError(
      'board-load-pruned-orphans',
      `Pruned from "${boardName}": ${summary}`,
      `Filo pruned ${summary} from "${boardName}" while loading. The board still works; the dropped entries either pointed at tiles that don't exist on this board or duplicated an existing placement.${snapshotHint}`,
    );
  }

  // Frames are accepted down to 0px on disk so a hand-collapsed frame
  // doesn't reject the entire board, but the renderer can't usefully draw
  // anything below the design-recommended 200×150 floor. Surface one summary
  // toast per board listing the affected titles so the user can fix them by
  // hand without us silently snapping the values back up (which would
  // overwrite an intentional collapse).
  warnUndersizedFrames(data.frames, data.board.name || relPath);

  // Spread the parsed envelope FIRST so unknown top-level keys preserved by
  // `BoardFileDataSchema.passthrough()` survive the load → cache → save
  // round-trip (the cache stores this object and the writer serialises it), so
  // a forward-compat key a newer Filo wrote isn't dropped. The explicit fields
  // below still pin the validated shape.
  //
  // The file stem is the board's name; `board.name` is only its copy, so a
  // copy that differs (the file renamed while Filo was closed, a hand edit)
  // gives way. Nothing is written for it; the next save carries the name.
  const normalised: BoardFileData = {
    ...data,
    board: { ...data.board, name: boardNameFromPath(relPath) },
    tileDefs: data.tileDefs,
    connections: data.connections,
    frames: data.frames,
  };

  // Viewports aren't carried inside the board file — they live in
  // `.filo/viewports.json` keyed by boardId, hydrated separately by the
  // vault store on open.

  return {
    ok: true,
    data: normalised,
    migratedFrom: loaded.migratedFrom,
    droppedTileTypes,
    orphansPruned: orphanReportHasFindings(orphanReport),
    boardIdsNormalized: orphanReport.normalizedBoardIdRefs.length > 0,
    mtimeMs: preStat?.mtimeMs,
    declaredName: data.board.name,
    ...(baseline ? { baseline } : {}),
  };
}

/** One successful load, kept for the duplicate-id ranking. */
interface LoadedBoardEntry {
  relPath: string;
  /** Position in `board:list` (code-unit) order — the final tie-break. */
  index: number;
  result: LoadBoardResult;
}

/** The file stem, case-folded, of a board named `name` (the shared file-name rule). */
function boardFileStem(name: string): string {
  return safeFileName(name, '').toLowerCase();
}

function baseName(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i >= 0 ? rel.slice(i + 1) : rel;
}

/**
 * Ranks two files declaring the same board id (negative →
 * `a` wins): not a sync conflict copy, then named after the board, then the
 * newest mtime, then the `board:list` order.
 */
function compareDuplicateBoards(
  a: LoadedBoardEntry,
  b: LoadedBoardEntry,
  isConflictCopy: (rel: string) => boolean,
): number {
  const conflict = Number(isConflictCopy(a.relPath)) - Number(isConflictCopy(b.relPath));
  if (conflict !== 0) return conflict;
  const named = (e: LoadedBoardEntry): number =>
    baseName(e.relPath).toLowerCase() === `${boardFileStem(e.result.declaredName ?? e.result.data.board.name)}.board.json` ? 0 : 1;
  const byName = named(a) - named(b);
  if (byName !== 0) return byName;
  const byMtime = (b.result.mtimeMs ?? -Infinity) - (a.result.mtimeMs ?? -Infinity);
  if (byMtime !== 0 && Number.isFinite(byMtime)) return byMtime;
  return a.index - b.index;
}

function editedAt(mtimeMs: number | undefined): string {
  if (mtimeMs === undefined) return '';
  return `, edited ${new Date(mtimeMs).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
}

/**
 * Neutral copy: never "remove the copy", never calls either
 * file the duplicate. Both files are untouched; the loser is snapshotted.
 */
function duplicateBoardMessage(winner: LoadedBoardEntry, loser: LoadedBoardEntry): string {
  return (
    `Two board files use the same id: "${winner.relPath}" (loaded${editedAt(winner.result.mtimeMs)}) and ` +
    `"${loser.relPath}" (not loaded${editedAt(loser.result.mtimeMs)}). Both files are unchanged on disk; a copy of ` +
    'the unloaded one is in .filo/recovery/. To keep the other version, open it in a text editor, or rename it ' +
    'and give it a new "id".'
  );
}

/**
 * Emits a single board-scoped toast naming frames smaller than the design-
 * recommended 200×150 floor. The schema minimum is 0 so a hand-edited
 * collapse doesn't reject the whole board file; this warning
 * is the user-visible counterpart that surfaces *what* shrank. Kept here
 * rather than in the schema's `.refine` so the message can name the board.
 */
const RECOMMENDED_FRAME_WIDTH = 200;
const RECOMMENDED_FRAME_HEIGHT = 150;
function warnUndersizedFrames(frames: readonly Frame[], boardName: string): void {
  const undersized: string[] = [];
  for (const f of frames) {
    if (f.size.width < RECOMMENDED_FRAME_WIDTH || f.size.height < RECOMMENDED_FRAME_HEIGHT) {
      undersized.push(f.title || f.id);
    }
  }
  if (undersized.length === 0) return;
  reportError(
    'board-load-undersized-frames',
    `Undersized frames in "${boardName}": ${undersized.join(', ')}`,
    `"${boardName}" has ${undersized.length} frame${undersized.length === 1 ? '' : 's'} smaller than the recommended ${RECOMMENDED_FRAME_WIDTH}×${RECOMMENDED_FRAME_HEIGHT} (${undersized.join(', ')}). Resize on the canvas to make them usable again.`,
  );
}

/**
 * Loads every .board.json file under a vault. Returns a map of boardId →
 * file data plus a map of boardId → vault-relative path for persistence.
 *
 * Files that fail to load are NOT silently dropped — each failure is
 * surfaced through `errorBus.reportError` (so the user sees a toast) and
 * collected into the `failedBoards` array so the vault store can route
 * each path through `recovery:snapshot` before any subsequent write can
 * clobber it. The caller is responsible for snapshotting + UI placeholder
 * handling.
 */
export async function loadAllBoards(
  vaultRoot: string,
): Promise<{
  boards: Board[];
  cache: Record<string, BoardFileData>;
  paths: Record<string, string>;
  connections: Record<string, Connection>;
  frames: Frame[];
  failedBoards: FailedBoardEntry[];
  /**
   * Board IDs that had orphan refs / duplicate placements
   * pruned during load. The caller marks each dirty so the pruned shape
   * lands on disk and the orphans don't re-surface on every reopen. The
   * source `.board.json` is preserved under `.filo/recovery/` (snapshot
   * path emitted in the per-board toast).
   */
  prunedBoardIds: string[];
  /**
   * Board IDs whose nested connection / frame / mindmap-group
   * `boardId` was normalized to `board.id` on load. The caller marks each
   * dirty so the corrected values reach disk (no recovery snapshot is
   * involved).
   */
  normalizedBoardIds: string[];
  /**
   * Each loaded board's path and the stat its load read. The caller stamps
   * them once it adopts the cache (`adoptLoadedBoardBaseline`).
   */
  loadedBaselines: Array<{ path: string; baseline: LoadedBoardBaseline | undefined }>;
  /** The loaded boards whose files are in an older board format, for the open's notice. */
  migratedBoards: string[];
}> {
  const relList = (await window.filo.invoke('board:list', vaultRoot)) as string[];

  const boards: Board[] = [];
  const cache: Record<string, BoardFileData> = {};
  const paths: Record<string, string> = {};
  const connections: Record<string, Connection> = {};
  const frames: Frame[] = [];
  const failedBoards: FailedBoardEntry[] = [];
  const prunedBoardIds: string[] = [];
  const normalizedBoardIds: string[] = [];
  const loadedBaselines: Array<{ path: string; baseline: LoadedBoardBaseline | undefined }> = [];
  const migratedBoards: string[] = [];
  const loaded: LoadedBoardEntry[] = [];

  for (const relPath of relList) {
    const result = await loadBoard(vaultRoot, relPath);
    if (!result.ok) {
      // No toast here: vaultCandidate shows one per failed board after the
      // open, once it knows whether a recovery copy was kept (a Retry notice
      // for a transient failure, a what-to-do-next notice otherwise).
      failedBoards.push({
        path: relPath,
        errorKind: result.error,
        message: result.message,
        ...(result.problems ? { problems: result.problems } : {}),
      });
      console.warn(`[boardLoader] ${relPath} not loaded (${result.error}): ${result.message}`);
      continue;
    }
    loaded.push({ relPath, index: loaded.length, result });
  }

  // Two `.board.json` files declaring the same board.id must not collapse
  // (cache[id] / paths[id] would silently overwrite and the loser's
  // connections/frames would pollute the survivor). Code-unit order alone would
  // let `Plan (1).board.json` / `Plan - Copy.board.json` (' ' / '-' sort before
  // '.') hijack the canonical `Plan.board.json`, so rank each id group: a
  // non-conflict-copy name first, then the name matching the board's own name,
  // then the newest mtimeMs, then code-unit order. Only the winner's
  // connections/frames are merged.
  const relSet = new Set(relList.map((r) => r.toLowerCase()));
  const isConflictCopy = (rel: string): boolean =>
    detectConflictCopyPath(rel, { exists: (c) => relSet.has(c.toLowerCase()) }) !== null;
  const byId = new Map<string, LoadedBoardEntry[]>();
  for (const entry of loaded) {
    const id = entry.result.data.board.id;
    byId.set(id, [...(byId.get(id) ?? []), entry]);
  }
  const winners = new Set<LoadedBoardEntry>();
  for (const group of byId.values()) {
    const ranked = [...group].sort((a, b) => compareDuplicateBoards(a, b, isConflictCopy));
    const [winner, ...losers] = ranked;
    if (!winner) continue;
    winners.add(winner);
    for (const loser of losers) {
      const conflict = isConflictCopy(loser.relPath);
      const message = duplicateBoardMessage(winner, loser);
      failedBoards.push({
        path: loser.relPath,
        errorKind: conflict ? 'sync-conflict-copy' : 'duplicate-board-id',
        message,
      });
      reportError('board-load', `Duplicate board id "${winner.result.data.board.id}": ${loser.relPath} vs ${winner.relPath}`, message);
    }
  }

  for (const entry of loaded) {
    if (!winners.has(entry)) continue;
    const { relPath, result } = entry;
    const { data } = result;
    boards.push(data.board);
    cache[data.board.id] = data;
    paths[data.board.id] = relPath;
    Object.assign(connections, data.connections);
    frames.push(...data.frames);
    if (result.orphansPruned) prunedBoardIds.push(data.board.id);
    if (result.boardIdsNormalized) normalizedBoardIds.push(data.board.id);
    loadedBaselines.push({ path: relPath, baseline: result.baseline });
    if (result.migratedFrom !== null) migratedBoards.push(relPath);
  }

  return {
    boards,
    cache,
    paths,
    connections,
    frames,
    failedBoards,
    prunedBoardIds,
    normalizedBoardIds,
    loadedBaselines,
    migratedBoards,
  };
}

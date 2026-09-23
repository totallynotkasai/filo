/**
 * boardLoader — reads and validates .board.json files from disk via IPC.
 *
 * Provides a single entry point for loading board files. Handles schema
 * validation via Zod and returns typed V7BoardFileData. Broken file-reference
 * detection runs in `boardRefIntegrityStore.recompute(knownVaultPaths)` once
 * the vault file tree is known — keeping the load path stateless avoids
 * shipping a `fileExists` callback into every caller.
 */

import type { Board, Connection, Frame, MindMapBoard } from '../../schema/index';
import { V7BoardFileDataSchema, migrateBoardFile, CURRENT_BOARD_FILE_VERSION } from '../../schema/index';
import { TILE_TYPES } from '../../schema/tile';
import type { V7BoardFileData } from './boardSaver';
import { reportError } from '../utils/errorBus';
import { invokeOk } from '../utils/invokeOk';
import { IpcEnvelopeError } from '@shared/ipcEnvelope';
import { noteBaseline } from '../vault/fileBaselineRegistry';
import { loadVersionedFile } from '../vault/loadVersionedFile';

// allow-module-state: immutable lookup table derived from a build-time constant
const TILE_TYPE_SET: ReadonlySet<string> = new Set(TILE_TYPES);

/**
 * Strips tile-def entries whose `type` isn't in the live `TILE_TYPES` union.
 * The classic case is the calendar board removal which left behind
 * `{ type: 'calendar', ... }` entries with no migration. Returns the
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
 * Phase 2.4 — summary of what `pruneOrphanRefsAndDuplicates` removed from
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
   * Audit 2.1 — connection / frame / mindmap-group refs whose nested
   * `boardId` disagreed with `envelope.board.id` and was rewritten to match.
   * Each entry is a `kind:id` tag (e.g. `connection:c1`, `frame:f1`,
   * `group:g1`) for diagnostics. Deliberately NOT counted by
   * `orphanReportHasFindings`: a boardId rewrite is a benign, deterministic
   * self-heal (the correct value *is* `board.id`), so it must not trip the
   * orphan-prune recovery snapshot / refuse-to-load path. It is surfaced via
   * the separate `boardIdsNormalized` result flag, which marks the board
   * dirty so the repair reaches disk — the same way `groupsBackfilled` does.
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
 * IMPL_PLAN_2026-05-23_v2 P1.6 — set of tile IDs that are valid connection /
 * frame.tileIds targets on this envelope. Mirrors the validity set used by
 * `V7BoardFileDataSchema`'s superRefine so the loader's pre-parse prune and
 * the schema's cross-check stay in lockstep.
 *
 * - All board types: `tileDefs` keys are valid (vault-backed tiles).
 * - Mind Map only: `board.inlineTiles` keys are ALSO valid. Inline tiles
 *   (Link / Iframe / Timer) live on the board itself rather than tileDefs
 *   but participate in `mergeBoardTiles` and can be connection / frame
 *   members. Pre-fix the prune dropped legitimate connections to inline
 *   tiles because tileDefs was the only validity check.
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
 * Phase 2.4 — strips orphan connection refs, orphan IDs from
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

  // Audit 2.1 — normalize nested boardId refs to the envelope's `board.id`.
  // The superRefine in `schema/boardFile.ts` only warns on a mismatch and
  // relies on THIS pass to repair it (its comment now reflects reality). A
  // stale / foreign boardId — copied connections, a third-party tool, or a
  // board file restored under a renamed id — would otherwise round-trip to
  // disk unrepaired and could mask a cross-board mix-up (e.g. combined with a
  // duplicate-id collision). Repair is deterministic (the correct value IS
  // `board.id`), so no recovery snapshot is taken; the board is just marked
  // dirty via the `boardIdsNormalized` flag so the corrected values persist.
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
  data: V7BoardFileData;
  /**
   * When a legacy / mis-versioned file was migrated, the version number on
   * the raw input before translation. `null` for already-current files —
   * lets callers emit a one-shot telemetry / toast only when migration ran.
   */
  migratedFrom: number | null;
  /**
   * Unknown tile-def types stripped before schema validation (e.g. legacy
   * `calendar` entries left behind by the removed board type). Empty when
   * every def passed the live `TILE_TYPES` allowlist.
   */
  droppedTileTypes: string[];
  /**
   * True when `backfillGroupDisplayIndices` assigned indices to one or more
   * legacy groups (M26). The caller markDirty's the board so the freshly
   * assigned indices land on disk — otherwise the backfill re-runs on every
   * reopen and the indices can drift if the user reorders groups in between.
   */
  groupsBackfilled: boolean;
  /**
   * True when `pruneOrphanRefsAndDuplicates` removed at least one orphan
   * connection / orphan frame ref / duplicate placement. The caller marks
   * the board dirty so the pruned shape lands on disk and the orphans
   * don't re-surface on every reopen. The original is preserved at
   * `.filo/recovery/` (see snapshot path emitted in the toast).
   */
  orphansPruned: boolean;
  /**
   * Audit 2.1 — true when `pruneOrphanRefsAndDuplicates` rewrote at least one
   * nested connection / frame / mindmap-group `boardId` to match
   * `board.id`. Benign self-heal: unlike `orphansPruned` it takes no recovery
   * snapshot and never refuses the load. The caller marks the board dirty so
   * the corrected values land on disk (mirrors `groupsBackfilled`).
   */
  boardIdsNormalized: boolean;
}

export interface LoadBoardError {
  ok: false;
  error:
    | 'not-found'
    | 'parse-error'
    | 'schema-invalid'
    | 'io-error'
    | 'from-future'
    // Sprint C / C9 + C10 — input version is below
    // `CURRENT_BOARD_FILE_VERSION` but no `MIGRATION_STEPS` entry covers
    // the gap (or the version is fractional). Surfaces a different
    // toast than `from-future`.
    | 'no-migration-path'
    // Phase B / B.3 — board needed orphan-ref / duplicate prune but the
    // `recovery:snapshot` IPC failed, so we have nowhere to preserve the
    // original bytes. We refuse to load (and therefore can't subsequently
    // overwrite the disk file with the pruned shape).
    | 'snapshot-failed';
  message: string;
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
  // `board.id` (Audit 1.2). Widening here (rather than in `LoadBoardError`)
  // keeps `loadBoard`'s own return type honest.
  errorKind: LoadBoardError['error'] | 'duplicate-board-id';
  message: string;
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
  // 3.5 (Audit-18) — stat the file BEFORE the content read so the post-read
  // stat below can be BRACKETED. The baseline must reflect the bytes we actually
  // loaded; a foreign write landing in the read→stat gap would otherwise make a
  // lone post-read stat "our" baseline, and the next save would match-and-clobber
  // the external edit with no drift prompt. Best-effort — a failed pre-stat just
  // skips the baseline (the writer's drift check no-ops, legacy unguarded write).
  let preStat: { mtimeMs: number; size: number } | null = null;
  try {
    preStat = await invokeOk('vault:stat', vaultRoot, relPath);
  } catch {
    preStat = null;
  }

  // Audit-19 ERR-1 — main now returns the parsed board OBJECT (it unwraps a
  // legacy double-encoded file itself); a string still parses below, for older
  // mains / test stubs that return `JSON.stringify(board)`.
  let raw: unknown;
  try {
    raw = await window.filo.invoke('board:load', vaultRoot, relPath);
  } catch (err) {
    return { ok: false, error: 'io-error', message: `${err}` };
  }
  if (raw == null) {
    return { ok: false, error: 'not-found', message: `No board at ${relPath}` };
  }

  // Phase R6 — capture the file's mtime as the drift baseline. Used by
  // `writeBoardFile`'s pre-write stat check to detect external edits
  // that land between load and the next debounced write. Best-effort:
  // a failed stat just leaves the baseline empty (writer's drift check
  // no-ops, falling back to the legacy unguarded write).
  //
  // 3.5 (Audit-18) — stat-read-stat: stamp ONLY when the bracketing stats match
  // (mtime + size). A mismatch means a write landed around the content read, so
  // this stat reflects bytes we didn't load — leave the baseline unstamped so the
  // next save's drift check re-detects + prompts rather than adopting foreign bytes.
  try {
    const stat = await invokeOk('vault:stat', vaultRoot, relPath);
    if (preStat && preStat.mtimeMs === stat.mtimeMs && preStat.size === stat.size) {
      noteBaseline(relPath, stat.mtimeMs, stat.size);
    }
  } catch {
    // Non-fatal — no baseline, no pre-write drift check for this board.
  }

  let rawJson: unknown;
  try {
    rawJson = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (err) {
    return { ok: false, error: 'parse-error', message: `${err}` };
  }

  // Phase 4 E2 — route migrate → prune → validate through the shared
  // versioned-load helper (`loadVersionedFile`) so the migrate-before-parse
  // ordering and the from-future / no-migration-path short-circuits are
  // identical to every other versioned config loader. The `transform` slot
  // runs the board-specific prune the loader has always done:
  //
  //  - strip tile-def entries whose `type` isn't in the live `TILE_TYPES`
  //    union (e.g. `calendar` entries left over from the removed board
  //    type), which the schema's discriminated union would otherwise reject
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
    V7BoardFileDataSchema,
    migrateBoardFile,
    rawJson,
    (data) => {
      droppedTileTypes = preFilterUnknownTileTypes(data);
      // Orphan / duplicate prune runs AFTER the unknown-type strip so
      // connection/frame refs are validated against the trimmed tileDefs (a
      // connection pointing at a stripped-away calendar tile is ALSO an
      // orphan and should be pruned in the same pass).
      orphanReport = pruneOrphanRefsAndDuplicates(data);
      return data;
    },
  );

  // Phase 23 / M14 — short-circuit files declaring a `version` higher than
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

  // Sprint C / C9 + C10 — distinct surface for files we *understand the
  // age of* but can't migrate: either pre-v6 (no MIGRATION_STEPS entry)
  // or a fractional version (structurally suspect). The pre-Sprint-C
  // code routed these through the from-future toast, which lied about
  // the cause.
  if (loaded.status === 'no-migration-path') {
    return {
      ok: false,
      error: 'no-migration-path',
      message:
        `This board's file version (${loaded.migratedFrom}) is older than this build's earliest migration. ` +
        'Open an older Filo build to migrate it forward, or restore an earlier copy from your backup.',
    };
  }

  // Phase B / B.3 + Phase 2.4 — if the prune actually mutated the envelope,
  // preserve the on-disk original in `.filo/recovery/` BEFORE any future
  // save can rewrite the file with the pruned shape. `recovery:snapshot`
  // copies the disk file (untouched by the in-memory prune above), so it's
  // equivalent to the old peek-then-snapshot ordering. If the snapshot
  // can't be written we refuse to load — building in-memory state from the
  // pruned shape would let the next save clobber the unrecoverable original.
  const prunedAny =
    droppedTileTypes.length > 0 || orphanReportHasFindings(orphanReport);
  let snapshotPath: string | null = null;
  if (prunedAny) {
    try {
      // `invokeOk` throws on the `{ ok: false }` envelope so a snapshot
      // failure keeps `snapshotPath` null and trips the abort below.
      const snap = await invokeOk('recovery:snapshot', vaultRoot, relPath);
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
    return {
      ok: false,
      error: 'schema-invalid',
      // Prefix each issue with its path: Zod 4 messages are generic
      // ("Invalid input: expected number, received undefined"), so without
      // the path the recovery toast can't point at the broken field.
      message: loaded.error.issues
        .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
        .join('; '),
    };
  }

  const data = loaded.data;
  const groupsBackfilled = backfillGroupDisplayIndices(data.board);

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

  // M18 — frames are accepted down to 0px on disk so a hand-collapsed frame
  // doesn't reject the entire board, but the renderer can't usefully draw
  // anything below the design-recommended 200×150 floor. Surface one summary
  // toast per board listing the affected titles so the user can fix them by
  // hand without us silently snapping the values back up (which would
  // overwrite an intentional collapse).
  warnUndersizedFrames(data.frames, data.board.name || relPath);

  // Audit-4 DI-11 — spread the parsed envelope FIRST so unknown top-level keys
  // that `V7BoardFileDataSchema.passthrough()` preserved at parse time survive
  // the load → cache → save round-trip: the cache stores this object by
  // reference (`cache[id] = data`) and the board write scheduler mutates +
  // `JSON.stringify`s it in place, so a key present here is a key written back.
  // Without the spread this reconstruction silently dropped any forward-compat
  // envelope key a future Filo wrote, contradicting the schema's passthrough
  // contract. The explicit fields below still pin the validated shape.
  const normalised: V7BoardFileData = {
    ...data,
    board: data.board,
    tileDefs: data.tileDefs,
    connections: data.connections,
    frames: data.frames,
  };

  // Viewports are no longer carried inside the board file — they live in
  // `.filo/viewports.json` keyed by boardId, hydrated separately by the
  // vault store on open. Any inline `viewport` field on legacy board JSON
  // is silently ignored here and stripped on the next save.

  return {
    ok: true,
    data: normalised,
    migratedFrom: loaded.migratedFrom,
    droppedTileTypes,
    groupsBackfilled,
    orphansPruned: orphanReportHasFindings(orphanReport),
    boardIdsNormalized: orphanReport.normalizedBoardIdRefs.length > 0,
  };
}

/**
 * Emits a single board-scoped toast naming frames smaller than the design-
 * recommended 200×150 floor. M18 lowered the schema minimum to 0 so a
 * hand-edited collapse no longer rejects the whole board file; this warning
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
 * Backfills `displayIndex` on Mind Map tile groups loaded from older
 * `.board.json` files that predate the field. Indices are assigned in
 * array order starting at 1, skipping any positions already filled, so a
 * partially-migrated file keeps its existing numbers stable.
 *
 * Returns `true` when at least one index was assigned, so the caller can
 * mark the board dirty (M26) — otherwise the backfill re-runs on every
 * reopen and can drift if the user reorders groups between loads.
 */
function backfillGroupDisplayIndices(board: Board): boolean {
  if (board.type !== 'mindmap') return false;
  const mm = board as MindMapBoard;
  const groups = mm.groups ?? [];
  if (groups.length === 0) return false;
  const used = new Set<number>();
  for (const g of groups) {
    if (typeof g.displayIndex === 'number') used.add(g.displayIndex);
  }
  let next = 1;
  let mutated = false;
  for (const g of groups) {
    if (typeof g.displayIndex === 'number') continue;
    while (used.has(next)) next += 1;
    g.displayIndex = next;
    used.add(next);
    mutated = true;
  }
  return mutated;
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
  cache: Record<string, V7BoardFileData>;
  paths: Record<string, string>;
  connections: Record<string, Connection>;
  frames: Frame[];
  failedBoards: FailedBoardEntry[];
  /**
   * Board IDs whose tile-group `displayIndex` field was backfilled on load
   * (M26). The caller must `boardCacheStore.markDirty(id)` for each so the
   * freshly assigned indices reach disk on the next debounced save.
   */
  backfilledBoardIds: string[];
  /**
   * Phase 2.4 — board IDs that had orphan refs / duplicate placements
   * pruned during load. The caller marks each dirty so the pruned shape
   * lands on disk and the orphans don't re-surface on every reopen. The
   * source `.board.json` is preserved under `.filo/recovery/` (snapshot
   * path emitted in the per-board toast).
   */
  prunedBoardIds: string[];
  /**
   * Audit 2.1 — board IDs whose nested connection / frame / mindmap-group
   * `boardId` was normalized to `board.id` on load. The caller marks each
   * dirty so the corrected values reach disk (mirrors `backfilledBoardIds`;
   * no recovery snapshot is involved).
   */
  normalizedBoardIds: string[];
}> {
  const relList = (await window.filo.invoke('board:list', vaultRoot)) as string[];

  const boards: Board[] = [];
  const cache: Record<string, V7BoardFileData> = {};
  const paths: Record<string, string> = {};
  const connections: Record<string, Connection> = {};
  const frames: Frame[] = [];
  const failedBoards: FailedBoardEntry[] = [];
  const backfilledBoardIds: string[] = [];
  const prunedBoardIds: string[] = [];
  const normalizedBoardIds: string[] = [];

  for (const relPath of relList) {
    const result = await loadBoard(vaultRoot, relPath);
    if (!result.ok) {
      failedBoards.push({ path: relPath, errorKind: result.error, message: result.message });
      // Phase 23 / M14 — the from-future case has a user-facing message
      // already; route it through verbatim instead of wrapping it in a
      // generic prefix that obscures the cause. Phase B / B.3 — the
      // snapshot-failed case is treated the same way for the same
      // reason (its message names the specific remediation steps).
      // Sprint C / C9 — no-migration-path also carries a precise
      // user-facing message describing the version gap.
      const hasUserFacingMessage =
        result.error === 'from-future' ||
        result.error === 'snapshot-failed' ||
        result.error === 'no-migration-path';
      const userMessage = hasUserFacingMessage
        ? `${relPath}: ${result.message}`
        : `Filo couldn't load ${relPath}: ${result.error}`;
      reportError('board-load', result.message, userMessage);
      continue;
    }
    const { data } = result;
    // Audit 1.2 — two .board.json files declaring the same board.id must not
    // collapse. The first file loaded wins and stays reachable; route the
    // collider into failedBoards (vaultCandidate snapshots it to
    // .filo/recovery/) and skip merging its connections/frames so the
    // survivor isn't polluted. Without this guard cache[id] / paths[id]
    // silently overwrote — the first board became unreachable and its future
    // saves hijacked the survivor's file — and the loser's connections/frames
    // merged unconditionally under the survivor's id. Trivially produced by
    // copying a .board.json in the OS file manager or restoring one from
    // backup into the same vault.
    if (Object.prototype.hasOwnProperty.call(cache, data.board.id)) {
      const existingPath = paths[data.board.id];
      const message = `Duplicate board id "${data.board.id}": ${relPath} collides with ${existingPath}`;
      failedBoards.push({ path: relPath, errorKind: 'duplicate-board-id', message });
      reportError(
        'board-load',
        message,
        `Filo couldn't load ${relPath}: another board (${existingPath}) already uses id "${data.board.id}". The duplicate was left unloaded and snapshotted to .filo/recovery/ — give it a new id or remove the copy, then reopen the vault.`,
      );
      continue;
    }
    boards.push(data.board);
    cache[data.board.id] = data;
    paths[data.board.id] = relPath;
    Object.assign(connections, data.connections);
    frames.push(...data.frames);
    if (result.groupsBackfilled) backfilledBoardIds.push(data.board.id);
    if (result.orphansPruned) prunedBoardIds.push(data.board.id);
    if (result.boardIdsNormalized) normalizedBoardIds.push(data.board.id);
  }

  return {
    boards,
    cache,
    paths,
    connections,
    frames,
    failedBoards,
    backfilledBoardIds,
    prunedBoardIds,
    normalizedBoardIds,
  };
}

/**
 * Produces the merged-tile view for a mind-map board: applies placements
 * to tile definitions and overlays inline tiles. Pure helper, no side effects.
 */
export function mergeBoardTiles(
  data: V7BoardFileData,
): Record<string, Record<string, unknown>> {
  const board = data.board;
  if (board.type !== 'mindmap') return {};

  const mm = board as MindMapBoard;
  const defs = data.tileDefs ?? {};
  const result: Record<string, Record<string, unknown>> = {};

  for (const [tileId, placement] of Object.entries(mm.placements ?? {})) {
    const def = defs[tileId];
    if (!def) continue;
    result[tileId] = {
      ...def,
      position: { x: placement.x, y: placement.y },
      size: { width: placement.width, height: placement.height },
      locked: placement.locked,
      faded: placement.faded,
      frameless: placement.frameless,
      boardId: board.id,
    };
  }

  for (const [id, it] of Object.entries(mm.inlineTiles ?? {})) {
    const anyIt = it as Record<string, unknown>;
    result[id] = {
      ...anyIt,
      position: { x: anyIt.x as number, y: anyIt.y as number },
      size: { width: anyIt.width as number, height: anyIt.height as number },
      boardId: board.id,
    };
  }

  return result;
}

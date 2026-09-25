/**
 * boardFile — Zod envelope for a `.board.json` file on disk.
 *
 * Sits one level above `BoardSchema`: a board file contains the discriminated
 * `board` plus the side-bag records `tileDefs` / `connections` / `frames` that
 * the board format stores alongside the board (rather than nested inside it).
 * The `version` literal pins the on-disk shape: the loader accepts exactly
 * this version and refuses every other (`migrations.ts`).
 *
 * Kept in `schema/` (not inline in `boardLoader.ts`) so the same envelope can
 * be reused by tests, migrations, and any future tooling that wants to
 * validate a board file without going through the IPC loader.
 */

import { z } from 'zod';
import { BoardSchema } from './board';
import { ConnectionSchema } from './connection';
import { FrameSchema } from './frame';
import { TileDefinitionSchema } from './tile';
import { uniqueBy, idString } from './schemaUtils';

/**
 * Current envelope version. v8: a board file holds only visuals; notes are
 * referenced by `filePath` and their title, tags and body live in the note.
 */
export const CURRENT_BOARD_FILE_VERSION = 8;

/**
 * Whole-envelope schema for a `.board.json` file. The inner `board`
 * is validated against `BoardSchema`; `tileDefs` / `connections` /
 * `frames` are validated against their per-element schemas so a corrupt
 * envelope is rejected at load time rather than crashing the renderer
 * deep in the tile-render path.
 *
 * `version` is required and pinned to the current literal. `migrateBoardFile`
 * runs first and refuses any other version, so a file from an older or newer
 * Filo never reaches this parse and is never re-saved in this build's shape.
 *
 * The `.superRefine` cross-checks that every
 * `connection.fromTileId`/`toTileId` and every `frame.tileIds[]` entry
 * resolves to a real tile (`tileDefs` key, or — for mindmap boards — an
 * `inlineTiles` key, since inline tiles are valid connection / frame
 * targets). Pure schema-level defence in depth: the runtime path in
 * `boardLoader.pruneOrphanRefsAndDuplicates` already prunes orphans
 * before this parse runs, so this check fires only when a caller
 * constructs an envelope outside the loader (tests, migration tooling,
 * hand-built JSON) and asks Zod to validate it.
 */
export const BoardFileDataSchema = z.object({
  version: z.literal(CURRENT_BOARD_FILE_VERSION),
  board: BoardSchema,
  // Record keys are validated against the nanoid pattern
  // via `idString`. Empty / whitespace / special-character keys would
  // otherwise pass through `.passthrough()` and either shadow a real
  // entry on save or crash downstream `Object.keys(...).split(...)`
  // helpers that assume id-like strings.
  tileDefs: z.record(idString, TileDefinitionSchema).default(() => ({})),
  connections: z.record(idString, ConnectionSchema).default(() => ({})),
  frames: z.array(FrameSchema).default(() => []).refine(...uniqueBy('id', 'frames')),
// `.passthrough()` mirrors the nested `BoardSchema.passthrough()` contract:
// an unknown top-level key a user or tool added survives a load and save.
}).passthrough().superRefine((envelope, ctx) => {
  const validIds = new Set<string>(Object.keys(envelope.tileDefs));
  if (envelope.board.type === 'mindmap') {
    // Inline tiles (Link / Iframe / Timer) live on the board itself rather
    // than `tileDefs` but are still valid connection / frame targets — see
    // the board's derived tiles (`getFullTiles`). Include them in the validity
    // set so a legitimate connection to an inline tile isn't flagged.
    const mindMap = envelope.board as { inlineTiles?: Record<string, unknown> };
    for (const id of Object.keys(mindMap.inlineTiles ?? {})) {
      validIds.add(id);
    }
  }

  for (const [connId, conn] of Object.entries(envelope.connections)) {
    if (!validIds.has(conn.fromTileId)) {
      ctx.addIssue({
        code: 'custom',
        message: `Connection ${connId} references missing tile ${conn.fromTileId} (fromTileId)`,
        path: ['connections', connId, 'fromTileId'],
      });
    }
    if (!validIds.has(conn.toTileId)) {
      ctx.addIssue({
        code: 'custom',
        message: `Connection ${connId} references missing tile ${conn.toTileId} (toTileId)`,
        path: ['connections', connId, 'toTileId'],
      });
    }
  }

  for (const frame of envelope.frames) {
    for (let i = 0; i < frame.tileIds.length; i += 1) {
      const tileId = frame.tileIds[i];
      if (tileId !== undefined && !validIds.has(tileId)) {
        ctx.addIssue({
          code: 'custom',
          message: `Frame ${frame.id} references missing tile ${tileId}`,
          path: ['frames', frame.id, 'tileIds', i],
        });
      }
    }
  }

  // boardId cross-check. The envelope IS the board file, so every nested
  // record's `boardId` SHOULD match `envelope.board.id`. We log mismatches
  // but do not reject: doing so would route every loosely-tagged test
  // fixture through `failedBoards`.
  //
  // Production files are repaired before this parse runs
  // (`boardLoader.pruneOrphanRefsAndDuplicates` rewrites a divergent
  // `boardId` and marks the board dirty), so this warning fires only for
  // envelopes built OUTSIDE the loader (tests, tooling, hand-built JSON).
  const seenMismatch: string[] = [];
  for (const [connId, conn] of Object.entries(envelope.connections)) {
    if (conn.boardId !== envelope.board.id) {
      seenMismatch.push(`connection ${connId} boardId="${conn.boardId}"`);
    }
  }
  for (const frame of envelope.frames) {
    if (frame.boardId !== envelope.board.id) {
      seenMismatch.push(`frame ${frame.id} boardId="${frame.boardId}"`);
    }
  }
  if (envelope.board.type === 'mindmap') {
    const mindMap = envelope.board as { id: string; groups?: Array<{ id: string; boardId: string }> };
    for (const group of mindMap.groups ?? []) {
      if (group.boardId !== mindMap.id) {
        seenMismatch.push(`group ${group.id} boardId="${group.boardId}"`);
      }
    }
  }
  if (seenMismatch.length > 0) {
    // Diagnostic only — does NOT call `ctx.addIssue` so the parse
    // still succeeds. The loader normalises these on the way in.
    console.warn(
      `[BoardFileDataSchema] boardId mismatch in board ${envelope.board.id}: ${seenMismatch.join('; ')}`,
    );
  }
});

// Note: the runtime `BoardFileData` type lives in `lib/boards/tileDefBuilder.ts`
// and carries `version?: 8` as the literal type so the saver can stamp it
// before serialise. In-memory consumers never need to read `version`: every
// loaded envelope is current because the loader refuses every other version.

/**
 * migrations — board-file version gate.
 *
 * `migrateBoardFile(raw)` classifies an unvalidated JSON value pulled from
 * disk against `CURRENT_BOARD_FILE_VERSION`. Filo accepts exactly the current
 * board format: an older file (or one with no `version`) was made by an
 * earlier Filo and is refused rather than migrated, and a newer one was saved
 * by a later Filo and is refused rather than downgraded. Either way the file
 * lands in `failedBoards` and is never written.
 *
 * The result keeps the shape every versioned loader shares
 * (`VersionMigrationResult`) so `loadVersionedFile` stays the one
 * migrate-then-validate path. A future format change adds a step to
 * `MIGRATION_STEPS` keyed by the *source* version (a pure function from the
 * raw V(N) object to V(N+1)) and bumps the version; today there are none.
 */

import { CURRENT_BOARD_FILE_VERSION } from './boardFile';

export interface MigrateBoardFileResult {
  /** The input, ready for `BoardFileDataSchema` when the version is current. */
  data: unknown;
  /**
   * The version declared by a refused file (`null` when the file is current).
   * A missing or non-numeric `version` reads as `0`.
   */
  migratedFrom: number | null;
  /** The file declares a version newer than this build understands. */
  fromFuture: boolean;
  /** The file is older than this build's format (or declares a fractional version). */
  noMigrationPath: boolean;
}

/** Steps from V(N) to V(N+1), keyed by N. Empty: no older format is migrated. */
const MIGRATION_STEPS: Record<number, (raw: unknown) => unknown> = {};

function declaredVersion(raw: unknown): number {
  if (!raw || typeof raw !== 'object') return 0;
  const v = (raw as { version?: unknown }).version;
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function migrateBoardFile(raw: unknown): MigrateBoardFileResult {
  const version = declaredVersion(raw);
  if (version === CURRENT_BOARD_FILE_VERSION) {
    return { data: raw, migratedFrom: null, fromFuture: false, noMigrationPath: false };
  }
  if (Number.isInteger(version) && version > CURRENT_BOARD_FILE_VERSION) {
    return { data: raw, migratedFrom: version, fromFuture: true, noMigrationPath: false };
  }
  let current: unknown = raw;
  for (let v = version; v < CURRENT_BOARD_FILE_VERSION; v++) {
    const step = Number.isInteger(v) ? MIGRATION_STEPS[v] : undefined;
    if (!step) {
      return { data: raw, migratedFrom: version, fromFuture: false, noMigrationPath: true };
    }
    current = step(current);
  }
  return {
    data: { ...(current as Record<string, unknown>), version: CURRENT_BOARD_FILE_VERSION },
    migratedFrom: version,
    fromFuture: false,
    noMigrationPath: false,
  };
}

/**
 * migrations — carries a `.board.json` in an older board format forward to
 * the current one.
 *
 * `migrateBoardFile(raw)` reads the file's `version` and runs the steps from
 * there up to `CURRENT_BOARD_FILE_VERSION`, one version at a time, on a copy
 * of the raw JSON. The loader then validates the result with the current
 * schema (`loadVersionedFile`). A file Filo can't carry forward is refused
 * and never written:
 *  - from a newer Filo (`fromFuture`): guessing at a downgrade is worse than
 *    refusing;
 *  - older than the first step, or with a missing / fractional version
 *    (`noMigrationPath`);
 *  - a step that throws, or hands back something that isn't a board object
 *    (`noMigrationPath` with `failure`).
 *
 * Opening a migrated board writes nothing: the file keeps its old format
 * until the board changes, and its first save keeps a copy of the original
 * first (`lib/boards/migratedBoards.ts`).
 *
 * Adding a format change: bump `CURRENT_BOARD_FILE_VERSION`, append a step
 * `{ from: N, to: N + 1, migrate }` (number literals), and add its fixtures
 * under `src/tests/unit/fixtures/board-migrations/` (`vN.board.json`, an old
 * file, and `vN.expected.json`, what it loads as today). Gate
 * `board-migration-steps` checks the steps run unbroken to the current
 * version and that each has its fixtures.
 */

import { CURRENT_BOARD_FILE_VERSION } from './boardFile';

/** One format change: a pure function from a V(`from`) board object to V(`to`). */
export interface BoardMigrationStep {
  /** The version this step reads. */
  from: number;
  /** Always `from + 1`. */
  to: number;
  /**
   * Gets its own copy of the board, so it may change it in place. The
   * pipeline sets `version` afterwards. Throw to refuse a file the step can't
   * carry forward: the board is then listed as failed and left as it is.
   */
  migrate: (board: Record<string, unknown>) => Record<string, unknown>;
}

/** The format changes since the oldest format Filo still opens, oldest first. */
export const MIGRATION_STEPS: readonly BoardMigrationStep[] = [];

let stepsInUse: readonly BoardMigrationStep[] = MIGRATION_STEPS;

/**
 * Tests only: run `steps` in place of `MIGRATION_STEPS` (null restores
 * them), so the pipeline can be driven by a synthetic format change while the
 * real list is empty.
 */
export function __setBoardMigrationStepsForTests(steps: readonly BoardMigrationStep[] | null): void {
  stepsInUse = steps ?? MIGRATION_STEPS;
}

/**
 * What is wrong with a step list, or `null` when it runs unbroken, one
 * version at a time, up to `current` (an empty list is fine).
 */
export function migrationStepProblem(steps: readonly BoardMigrationStep[], current: number): string | null {
  let previous: BoardMigrationStep | undefined;
  for (const [i, step] of steps.entries()) {
    if (!Number.isInteger(step.from) || step.to !== step.from + 1) {
      return `step ${i + 1} goes from ${step.from} to ${step.to}, not to the next version`;
    }
    if (previous && step.from !== previous.to) return `step ${i + 1} starts at ${step.from}, not at ${previous.to}`;
    previous = step;
  }
  if (previous && previous.to !== current) return `the last step ends at ${previous.to}, not at the current version ${current}`;
  return null;
}

interface MigrateBoardFileResult {
  /**
   * The current-format board, ready for `BoardFileDataSchema`; the input
   * itself when it is current or refused.
   */
  data: unknown;
  /**
   * The version the file declares when it isn't the current one (`null` when
   * it is). A missing or non-numeric `version` reads as `0`.
   */
  migratedFrom: number | null;
  /** The file declares a version newer than this build understands. */
  fromFuture: boolean;
  /** No unbroken run of steps carries the file to the current format, or a step failed. */
  noMigrationPath: boolean;
  /** Set when a step threw or handed back something that isn't a board: what went wrong. */
  failure?: string;
}

function declaredVersion(raw: unknown): number {
  if (!isBoardObject(raw)) return 0;
  const v = raw.version;
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function isBoardObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The steps from `version` to `current`, or null when a version on the way has none. */
function stepsFrom(version: number, current: number): BoardMigrationStep[] | null {
  if (!Number.isInteger(version)) return null;
  const run: BoardMigrationStep[] = [];
  for (let v = version; v < current; ) {
    const step = stepsInUse.find((s) => s.from === v);
    // A step must move forward and stay within this build's format, or the
    // walk would loop or pass the version the schema validates.
    if (!step || step.to <= v || step.to > current) return null;
    run.push(step);
    v = step.to;
  }
  return run;
}

export function migrateBoardFile(raw: unknown): MigrateBoardFileResult {
  const version = declaredVersion(raw);
  if (version === CURRENT_BOARD_FILE_VERSION) {
    return { data: raw, migratedFrom: null, fromFuture: false, noMigrationPath: false };
  }
  if (Number.isInteger(version) && version > CURRENT_BOARD_FILE_VERSION) {
    return { data: raw, migratedFrom: version, fromFuture: true, noMigrationPath: false };
  }
  const run = isBoardObject(raw) ? stepsFrom(version, CURRENT_BOARD_FILE_VERSION) : null;
  if (!run) return { data: raw, migratedFrom: version, fromFuture: false, noMigrationPath: true };

  // Steps work on a copy: the raw object is what the loader read, and a step
  // that fails halfway must leave nothing changed behind it.
  let board = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
  for (const step of run) {
    let next: unknown;
    try {
      next = step.migrate(board);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      return { data: raw, migratedFrom: version, fromFuture: false, noMigrationPath: true, failure: `from version ${step.from}: ${why}` };
    }
    if (!isBoardObject(next)) {
      return {
        data: raw,
        migratedFrom: version,
        fromFuture: false,
        noMigrationPath: true,
        failure: `from version ${step.from}: the step gave back something that isn't a board`,
      };
    }
    board = { ...next, version: step.to };
  }
  return { data: board, migratedFrom: version, fromFuture: false, noMigrationPath: false };
}

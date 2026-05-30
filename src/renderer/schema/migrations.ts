/**
 * migrations — board-file version translation scaffold.
 *
 * `migrateBoardFile(raw)` accepts an unvalidated JSON value pulled from disk
 * and returns the object as it should look for the current `V7BoardFileData`
 * schema. The function is intentionally lenient: it never throws on missing
 * or off-shape `version` values — those are reported via `migratedFrom`
 * (null when the input was already current, a number for legacy inputs) so
 * the caller can surface telemetry or a one-time toast without failing the
 * load.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * Adding a new migration (Phase 23 / M15 worked example)
 * ──────────────────────────────────────────────────────────────────────────
 *
 * 1. Bump `CURRENT_BOARD_FILE_VERSION` in `boardFile.ts` AND update the
 *    `z.literal(...)` to the new number.
 * 2. Update the in-memory schemas so the new shape parses (add/rename
 *    fields, defaults, etc.).
 * 3. Append a step to `MIGRATION_STEPS` keyed by the *source* version. Each
 *    step receives the raw object and returns the shape one version higher.
 *    Keep the function pure: don't reach into stores or fire IPCs — the
 *    loader will run the chain and then `JSON.stringify(version: N)` it.
 * 4. If the migration drops a field, also strip it on write in
 *    `boardWriteScheduler.writeBoardFile` so a round-trip is idempotent.
 * 5. Cover the step in `src/tests/unit/boardMigrations.test.ts` with a
 *    handcrafted V(N-1) input and a snapshot of the V(N) output.
 *
 * The v6→v7 step is the canonical "no structural change, just stamp the
 * version" example. Future steps will look the same except their body
 * actually transforms the shape.
 */

import { CURRENT_BOARD_FILE_VERSION } from './boardFile';

export interface MigrateBoardFileResult {
  /**
   * Object ready to be validated against `V7BoardFileDataSchema`. Will have
   * `version: CURRENT_BOARD_FILE_VERSION` stamped on the output regardless
   * of input shape. Stays `unknown` here because the schema's `safeParse`
   * is the source of truth for shape validation — migration is structural
   * translation only.
   */
  data: unknown;
  /**
   * The version number on the input file before migration. `null` when the
   * input already matched the current version (no transformation applied).
   * A number when a legacy version was detected and migrated — callers can
   * use this to emit a telemetry event or one-shot toast.
   */
  migratedFrom: number | null;
  /**
   * `true` when the input declares a `version` higher than this build's
   * `CURRENT_BOARD_FILE_VERSION`. The loader uses this to short-circuit
   * with a friendlier "file from a newer Filo" message instead of leaning
   * on the generic Zod literal-mismatch text. Phase 23 / M14.
   */
  fromFuture: boolean;
  /**
   * Sprint C / C9 — `true` when the input declares a `version` BELOW
   * `CURRENT_BOARD_FILE_VERSION` but no `MIGRATION_STEPS` entry exists for
   * the gap (e.g. a `version: 3` file when this build has steps from v6
   * onward). Distinct from `fromFuture`: this is "we used to support that
   * format and dropped the migration" rather than "saved by a newer
   * Filo". The loader surfaces a different toast.
   *
   * Sprint C / C10 also routes fractional `version` inputs here, since
   * a fraction means the file shape is structurally suspect rather than
   * "from the future".
   */
  noMigrationPath: boolean;
}

/**
 * Reads `raw.version` defensively. Returns `null` when the field is
 * missing, not a finite number, or fractional — those inputs are
 * treated as either implicit V6 (missing field) or no-migration-path
 * (fractional). The two cases are disambiguated by the caller via the
 * `versionPresent` return flag.
 */
function readInputVersion(raw: unknown): { value: number | null; versionPresent: boolean; fractional: boolean } {
  if (!raw || typeof raw !== 'object') return { value: null, versionPresent: false, fractional: false };
  const v = (raw as { version?: unknown }).version;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    // No `version` field → implicit V6.
    return { value: null, versionPresent: false, fractional: false };
  }
  // Sprint C / C10 — fractional version numbers are structurally
  // suspect: every legitimate version Filo has shipped is an integer.
  // Treat them as no-migration-path rather than trying to pick the
  // floor/ceil and silently rewriting the file.
  if (!Number.isInteger(v)) {
    return { value: v, versionPresent: true, fractional: true };
  }
  return { value: v, versionPresent: true, fractional: false };
}

/**
 * Per-step migration table. Keyed by *source* version: `MIGRATION_STEPS[N]`
 * takes a board file declared as V(N) and returns the V(N+1) equivalent.
 *
 * The v6→v7 step is a no-op because V7 made no structural changes — the
 * `version` field itself was the only addition. The bump survives because
 * the caller stamps `version: CURRENT_BOARD_FILE_VERSION` after the chain
 * completes. Leaving the step explicit (rather than relying on the
 * "stamp-only" branch) keeps the table self-documenting: any future
 * developer can see at a glance which versions have ever existed.
 */
const MIGRATION_STEPS: Record<number, (raw: unknown) => unknown> = {
  // v6 → v7: no structural change. V7 only added the `version` envelope
  // field — the body shape is identical. The caller stamps the new version
  // after the chain runs.
  6: (raw: unknown): unknown => raw,
};

/**
 * Translates a raw board-file payload into the shape expected by
 * `V7BoardFileDataSchema`. Always stamps the current version on the output.
 *
 * Cases:
 *   - input.version === CURRENT_BOARD_FILE_VERSION → pass through unchanged,
 *     report `migratedFrom: null`.
 *   - input.version missing / not a number → treated as implicit V6 (no
 *     structural change in V7), stamp version, report `migratedFrom: 6`.
 *   - input.version < CURRENT → run each MIGRATION_STEPS entry from input
 *     up to current; stamp the final version, report what we migrated
 *     from. The chain is intentionally one-step-at-a-time so each
 *     intermediate shape gets the same treatment as a freshly written
 *     vault from that era — no skipping.
 *   - input.version > CURRENT → pass through with `fromFuture: true` so the
 *     loader can surface a friendly message. We intentionally do NOT
 *     attempt to load — the schema literal would reject anyway, and
 *     guessing at "what fields might still parse" is worse than refusing.
 */
export function migrateBoardFile(raw: unknown): MigrateBoardFileResult {
  const { value: inputVersion, fractional } = readInputVersion(raw);

  // Sprint C / C10 — fractional version is a distinct failure mode.
  if (fractional && inputVersion !== null) {
    return { data: raw, migratedFrom: inputVersion, fromFuture: false, noMigrationPath: true };
  }

  if (inputVersion === CURRENT_BOARD_FILE_VERSION) {
    return { data: raw, migratedFrom: null, fromFuture: false, noMigrationPath: false };
  }

  if (inputVersion !== null && inputVersion > CURRENT_BOARD_FILE_VERSION) {
    // Don't touch a file from a newer build — the loader will surface a
    // dedicated error rather than silently downgrading anything we don't
    // understand. Phase 23 / M14.
    return { data: raw, migratedFrom: inputVersion, fromFuture: true, noMigrationPath: false };
  }

  // Legacy / missing version → walk the migration chain. Files predating
  // the `version` field are treated as V6 (the implicit pre-V7 shape).
  const startVersion = inputVersion ?? 6;
  let current: unknown = raw;
  for (let v = startVersion; v < CURRENT_BOARD_FILE_VERSION; v++) {
    const step = MIGRATION_STEPS[v];
    if (!step) {
      // Sprint C / C9 — distinct error kind. Pre-Sprint-C this reused
      // `fromFuture: true` so the loader surfaced a "saved by a newer
      // Filo" toast. That was misleading when the real cause was an
      // older format Filo no longer carries a migration for (e.g.
      // `version: 3` when steps exist only for 6→7). The
      // `noMigrationPath` flag lets the loader emit a precise toast
      // naming the version gap.
      return { data: raw, migratedFrom: startVersion, fromFuture: false, noMigrationPath: true };
    }
    current = step(current);
  }

  if (current && typeof current === 'object') {
    const next = { ...(current as Record<string, unknown>), version: CURRENT_BOARD_FILE_VERSION };
    return { data: next, migratedFrom: startVersion, fromFuture: false, noMigrationPath: false };
  }
  // Non-object inputs (null, string, number) — leave untouched; the schema
  // parse will fail with a clear "expected object" error.
  return { data: current, migratedFrom: startVersion, fromFuture: false, noMigrationPath: false };
}

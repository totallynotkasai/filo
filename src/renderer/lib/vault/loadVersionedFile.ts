/**
 * loadVersionedFile — the single migrate-then-validate path for every
 * versioned `.filo/` config file (Phase 4 / E2, recurrence-proofs F6).
 *
 * F6 was: the board / tags / layout-template envelopes each grew a
 * `version` field and a `migrate*` scaffold, but two of the three loaders
 * (`tagsStorage`, `layoutTemplateStore`) called `Schema.safeParse(raw)`
 * directly and never ran their migrator. A `version: 99` file written by a
 * future Filo therefore parsed clean against the broadened
 * `z.number().int()` version field, and an older build re-saved it → silent
 * downgrade.
 *
 * This helper bundles the three steps that must always happen together:
 *
 *   1. run the migrator (translate legacy shapes forward, detect
 *      from-future / un-migratable),
 *   2. (optionally) transform the migrated-but-unparsed object — the board
 *      loader uses this slot for its orphan-ref / duplicate-placement prune,
 *   3. validate against the schema.
 *
 * Every versioned-config loader routes through here so the "forgot to
 * migrate" failure mode is structurally gone for the configs that share
 * the migrator shape. `scripts/check-versioned-config-loader.mjs` enforces
 * that any `.safeParse` / `.parse` against a versioned schema lives in a
 * file that also references this helper (or the matching migrator), so the
 * next versioned config type can't skip the migrate step either.
 *
 * Pure + synchronous: no IPC, no store access. Callers own the disk read,
 * the `JSON.parse`, and the user-facing `reportError` toasts — the helper
 * only classifies. `lib/`-pure so it's unit-testable with Vitest alone.
 */

import type { z } from 'zod';

/**
 * The shape every `migrate*` scaffold already returns (see
 * `schema/migrations.ts`, `schema/tagsFile.ts`, `schema/layoutTemplate.ts`).
 * Declared here so `loadVersionedFile` can accept any of them by structural
 * typing without importing each schema module.
 */
export interface VersionMigrationResult {
  /** The migrated object, ready for schema validation. */
  data: unknown;
  /** Input version before migration; `null` when already current. */
  migratedFrom: number | null;
  /** Input declares a version newer than this build understands. */
  fromFuture: boolean;
  /** Input is below current but no migration step covers the gap (or is fractional). */
  noMigrationPath: boolean;
}

export type VersionMigrator = (raw: unknown) => VersionMigrationResult;

/**
 * Discriminated result. `ok` carries the parsed, typed value; the other
 * three variants tell the caller why it can't be used and let it surface
 * the appropriate toast / read-only fallback without re-deriving the
 * classification.
 */
export type LoadVersionedResult<T> =
  | { status: 'ok'; data: T; migratedFrom: number | null }
  | { status: 'from-future'; migratedFrom: number | null }
  | { status: 'no-migration-path'; migratedFrom: number | null }
  | { status: 'invalid'; error: z.ZodError };

/**
 * Runs `migrate(raw)` then `schema.safeParse(...)`, short-circuiting on the
 * from-future / no-migration-path classifications so a file Filo must not
 * re-save never reaches the parse step (and therefore can't be silently
 * normalised + downgraded on the next write).
 *
 * `transform` is applied to the migrated-but-unparsed object before
 * validation — the board loader uses it to strip orphan refs / duplicate
 * placements (which would otherwise reject an entire board). It must be
 * synchronous and pure; async interstitial work (e.g. the board loader's
 * `recovery:snapshot`) stays in the caller, around this call.
 *
 * Generic over the schema (`S extends z.ZodTypeAny`) rather than the parsed
 * type so `data` is the schema's `z.output<S>` (post-default / post-coerce
 * shape). Typing the schema as `z.ZodType<T>` lets inference pick the looser
 * INPUT type — e.g. a field with `.default()` becomes `string | undefined`
 * instead of `string` — which then fails to assign to the caller's output
 * type.
 */
export function loadVersionedFile<S extends z.ZodTypeAny>(
  schema: S,
  migrate: VersionMigrator,
  raw: unknown,
  transform?: (migrated: unknown) => unknown,
): LoadVersionedResult<z.output<S>> {
  const migration = migrate(raw);
  if (migration.fromFuture) {
    return { status: 'from-future', migratedFrom: migration.migratedFrom };
  }
  if (migration.noMigrationPath) {
    return { status: 'no-migration-path', migratedFrom: migration.migratedFrom };
  }
  const candidate = transform ? transform(migration.data) : migration.data;
  const parsed = schema.safeParse(candidate);
  if (parsed.success) {
    return { status: 'ok', data: parsed.data, migratedFrom: migration.migratedFrom };
  }
  return { status: 'invalid', error: parsed.error };
}

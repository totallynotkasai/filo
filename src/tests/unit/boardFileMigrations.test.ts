import { describe, it, expect } from 'vitest';
import {
  CURRENT_BOARD_FILE_VERSION,
  V7BoardFileDataSchema,
  migrateBoardFile,
} from '@renderer/schema';

function validBoardEnvelope(version?: number): Record<string, unknown> {
  const now = Date.now();
  const board = {
    id: 'mm-1',
    name: 'Alpha',
    emoji: '',
    type: 'mindmap',
    settings: {},
    placements: {},
    inlineTiles: {},
    createdAt: now,
    updatedAt: now,
  } as Record<string, unknown>;
  const env: Record<string, unknown> = {
    board,
    tileDefs: {},
    connections: {},
    frames: [],
  };
  if (typeof version === 'number') env.version = version;
  return env;
}

describe('migrateBoardFile', () => {
  it('passes through a current-version file unchanged', () => {
    const input = validBoardEnvelope(CURRENT_BOARD_FILE_VERSION);
    const out = migrateBoardFile(input);
    expect(out.migratedFrom).toBeNull();
    expect(out.fromFuture).toBe(false);
    expect(out.noMigrationPath).toBe(false);
    expect(out.data).toBe(input); // same reference — no transformation applied
  });

  it('stamps the current version on a missing-version file (implicit V6)', () => {
    const input = validBoardEnvelope(undefined);
    const out = migrateBoardFile(input);
    expect(out.migratedFrom).toBe(6);
    expect(out.fromFuture).toBe(false);
    expect(out.noMigrationPath).toBe(false);
    const migrated = out.data as { version?: unknown };
    expect(migrated.version).toBe(CURRENT_BOARD_FILE_VERSION);
  });

  it('reports legacy numeric versions but still stamps the current value', () => {
    // V6 is the only legacy version with a registered step in the chain.
    // Versions below that surface as noMigrationPath — see the Sprint C
    // / C9 test below.
    const input = validBoardEnvelope(6);
    const out = migrateBoardFile(input);
    expect(out.migratedFrom).toBe(6);
    expect(out.fromFuture).toBe(false);
    expect(out.noMigrationPath).toBe(false);
    expect((out.data as { version?: unknown }).version).toBe(CURRENT_BOARD_FILE_VERSION);
  });

  it('flags future-version files via fromFuture without touching the data', () => {
    const input = validBoardEnvelope(99);
    const out = migrateBoardFile(input);
    expect(out.migratedFrom).toBe(99);
    expect(out.fromFuture).toBe(true);
    expect(out.noMigrationPath).toBe(false);
    // Data left at its input version so the loader can surface the
    // version number in its error message (Phase 23 / M14).
    expect((out.data as { version?: unknown }).version).toBe(99);
    // Schema parse on the future-version output still fails because the
    // schema is `z.literal(7)` — the loader's `fromFuture` short-circuit
    // runs first and surfaces a friendlier message.
    const parsed = V7BoardFileDataSchema.safeParse(out.data);
    expect(parsed.success).toBe(false);
  });

  it('round-trips a V7 envelope through migrate + parse without losing fields', () => {
    const input = validBoardEnvelope(CURRENT_BOARD_FILE_VERSION);
    const migration = migrateBoardFile(input);
    const parsed = V7BoardFileDataSchema.safeParse(migration.data);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.version).toBe(CURRENT_BOARD_FILE_VERSION);
      expect(parsed.data.board.id).toBe('mm-1');
    }
  });

  it('parses a versionless envelope after migration stamps the version', () => {
    const input = validBoardEnvelope(undefined);
    const migration = migrateBoardFile(input);
    const parsed = V7BoardFileDataSchema.safeParse(migration.data);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.version).toBe(CURRENT_BOARD_FILE_VERSION);
    }
  });

  it('Sprint C / C9 — returns noMigrationPath: true when the chain is missing a step', () => {
    // V5 is older than this build's earliest migration entry (6→7). The
    // pre-Sprint-C path reused `fromFuture: true` and lied about the
    // cause; now we emit `noMigrationPath: true` so the loader can
    // surface a precise toast.
    const input = validBoardEnvelope(5);
    const out = migrateBoardFile(input);
    expect(out.migratedFrom).toBe(5);
    expect(out.fromFuture).toBe(false);
    expect(out.noMigrationPath).toBe(true);
    expect((out.data as { version?: unknown }).version).toBe(5);
  });

  it('Sprint C / C10 — fractional version is routed to noMigrationPath', () => {
    const input = validBoardEnvelope(6.5);
    const out = migrateBoardFile(input);
    expect(out.migratedFrom).toBe(6.5);
    expect(out.fromFuture).toBe(false);
    expect(out.noMigrationPath).toBe(true);
  });

  it('leaves non-object inputs untouched (schema parse will reject)', () => {
    expect(migrateBoardFile(null)).toEqual({
      data: null,
      migratedFrom: 6,
      fromFuture: false,
      noMigrationPath: false,
    });
    expect(migrateBoardFile('not an envelope')).toEqual({
      data: 'not an envelope',
      migratedFrom: 6,
      fromFuture: false,
      noMigrationPath: false,
    });
  });
});

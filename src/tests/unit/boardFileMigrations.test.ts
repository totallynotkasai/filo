import { describe, it, expect } from 'vitest';
import {
  CURRENT_BOARD_FILE_VERSION,
  BoardFileDataSchema,
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

  it('refuses a missing-version file untouched (reported as version 0)', () => {
    const input = validBoardEnvelope(undefined);
    const out = migrateBoardFile(input);
    expect(out.migratedFrom).toBe(0);
    expect(out.fromFuture).toBe(false);
    expect(out.noMigrationPath).toBe(true);
    expect(out.data).toBe(input);
    expect('version' in input).toBe(false);
  });

  it.each([6, 7])('refuses an older-format V%i file untouched', (version) => {
    const input = validBoardEnvelope(version);
    const out = migrateBoardFile(input);
    expect(out.migratedFrom).toBe(version);
    expect(out.fromFuture).toBe(false);
    expect(out.noMigrationPath).toBe(true);
    expect(out.data).toBe(input);
    expect((out.data as { version?: unknown }).version).toBe(version);
  });

  it('flags future-version files via fromFuture without touching the data', () => {
    const input = validBoardEnvelope(99);
    const out = migrateBoardFile(input);
    expect(out.migratedFrom).toBe(99);
    expect(out.fromFuture).toBe(true);
    expect(out.noMigrationPath).toBe(false);
    // Data left at its input version so the loader can surface the
    // version number in its error message.
    expect((out.data as { version?: unknown }).version).toBe(99);
    // Schema parse on the future-version output still fails because the
    // schema pins the current version literal — the loader's `fromFuture`
    // short-circuit runs first and surfaces a friendlier message.
    const parsed = BoardFileDataSchema.safeParse(out.data);
    expect(parsed.success).toBe(false);
  });

  it('round-trips a current envelope through migrate + parse without losing fields', () => {
    const input = validBoardEnvelope(CURRENT_BOARD_FILE_VERSION);
    const migration = migrateBoardFile(input);
    const parsed = BoardFileDataSchema.safeParse(migration.data);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.version).toBe(CURRENT_BOARD_FILE_VERSION);
      expect(parsed.data.board.id).toBe('mm-1');
    }
  });

  it('the schema itself rejects a versionless envelope (version has no default)', () => {
    const input = validBoardEnvelope(undefined);
    const migration = migrateBoardFile(input);
    expect(BoardFileDataSchema.safeParse(migration.data).success).toBe(false);
  });

  it('returns noMigrationPath: true for an old version, not fromFuture', () => {
    // `fromFuture` would misstate the cause; `noMigrationPath` lets the
    // loader surface a precise toast.
    const input = validBoardEnvelope(5);
    const out = migrateBoardFile(input);
    expect(out.migratedFrom).toBe(5);
    expect(out.fromFuture).toBe(false);
    expect(out.noMigrationPath).toBe(true);
    expect((out.data as { version?: unknown }).version).toBe(5);
  });

  it('fractional version is routed to noMigrationPath', () => {
    const input = validBoardEnvelope(6.5);
    const out = migrateBoardFile(input);
    expect(out.migratedFrom).toBe(6.5);
    expect(out.fromFuture).toBe(false);
    expect(out.noMigrationPath).toBe(true);
  });

  it('refuses non-object inputs untouched', () => {
    expect(migrateBoardFile(null)).toEqual({
      data: null,
      migratedFrom: 0,
      fromFuture: false,
      noMigrationPath: true,
    });
    expect(migrateBoardFile('not an envelope')).toEqual({
      data: 'not an envelope',
      migratedFrom: 0,
      fromFuture: false,
      noMigrationPath: true,
    });
  });
});

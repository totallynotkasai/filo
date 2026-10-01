/**
 * Every board-format migration step carries a real file of its format to the
 * current one. Each entry of MIGRATION_STEPS has two fixtures in
 * fixtures/board-migrations/: an old file (`vN.board.json`) and what it loads
 * as today (`vN.expected.json`). The old file must load through the real
 * pipeline as exactly the expected board, valid under the current schema, and
 * loading what Filo then writes must change nothing. Gate
 * `board-migration-steps` requires the fixtures and this test.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BoardFileDataSchema, CURRENT_BOARD_FILE_VERSION, migrateBoardFile } from '@renderer/schema/index';
import {
  MIGRATION_STEPS,
  migrationStepProblem,
  __setBoardMigrationStepsForTests,
  type BoardMigrationStep,
} from '@renderer/schema/migrations';
import { loadVersionedFile } from '@renderer/lib/vault/loadVersionedFile';

const FIXTURE_DIR = join(process.cwd(), 'src/tests/unit/fixtures/board-migrations');
const FIXTURE_NAME = /^v(\d+)\.(board|expected)\.json$/;

/** The step's old file loads as its expected board, and loading that again changes nothing. */
function expectFixturesHold(dir: string, from: number): void {
  const oldText = readFileSync(join(dir, `v${from}.board.json`), 'utf8');
  const expected: unknown = JSON.parse(readFileSync(join(dir, `v${from}.expected.json`), 'utf8'));
  const raw = JSON.parse(oldText) as { version?: unknown };
  expect(raw.version, `v${from}.board.json declares its own version`).toBe(from);

  const loaded = loadVersionedFile(BoardFileDataSchema, migrateBoardFile, raw);
  if (loaded.status !== 'ok') throw new Error(`v${from}.board.json didn't load: ${JSON.stringify(loaded)}`);
  expect(loaded.migratedFrom).toBe(from);
  // What the board writer would put on disk for it.
  const written: unknown = JSON.parse(JSON.stringify(loaded.data));
  expect(written).toEqual(expected);
  expect((written as { version: unknown }).version).toBe(CURRENT_BOARD_FILE_VERSION);
  // The steps worked on a copy: the file as read is untouched.
  expect(JSON.stringify(raw)).toBe(JSON.stringify(JSON.parse(oldText)));

  const again = loadVersionedFile(BoardFileDataSchema, migrateBoardFile, JSON.parse(JSON.stringify(written)));
  if (again.status !== 'ok') throw new Error(`the migrated v${from} board didn't load again: ${JSON.stringify(again)}`);
  expect(again.migratedFrom).toBeNull();
  expect(JSON.parse(JSON.stringify(again.data))).toEqual(written);
}

describe('the board-format migration steps', () => {
  it('run one version at a time up to the current format', () => {
    expect(migrationStepProblem(MIGRATION_STEPS, CURRENT_BOARD_FILE_VERSION)).toBeNull();
  });

  it('each have both fixtures, and every fixture belongs to a step', () => {
    const names = existsSync(FIXTURE_DIR) ? readdirSync(FIXTURE_DIR) : [];
    for (const name of names) expect(name, 'a fixture is named vN.board.json or vN.expected.json').toMatch(FIXTURE_NAME);
    const fixtureVersions = new Set(names.map((n) => Number(FIXTURE_NAME.exec(n)?.[1])));
    expect([...fixtureVersions].sort((a, b) => a - b)).toEqual(MIGRATION_STEPS.map((s) => s.from));
    for (const step of MIGRATION_STEPS) {
      expect(names).toContain(`v${step.from}.board.json`);
      expect(names).toContain(`v${step.from}.expected.json`);
    }
  });

  for (const step of MIGRATION_STEPS) {
    it(`carry a version ${step.from} file to the current format, and the result loads unchanged`, () => {
      expectFixturesHold(FIXTURE_DIR, step.from);
    });
  }
});

describe('the step list check', () => {
  const step = (from: number, to: number): BoardMigrationStep => ({ from, to, migrate: (b) => b });

  it('accepts no steps, or steps one version apart that end at the current one', () => {
    expect(migrationStepProblem([], 8)).toBeNull();
    expect(migrationStepProblem([step(6, 7), step(7, 8)], 8)).toBeNull();
  });

  it('names a step that skips a version, a gap, and a list that stops short', () => {
    expect(migrationStepProblem([step(6, 8)], 8)).toMatch(/goes from 6 to 8/);
    expect(migrationStepProblem([step(5, 6), step(7, 8)], 8)).toMatch(/starts at 7, not at 6/);
    expect(migrationStepProblem([step(6, 7)], 8)).toMatch(/ends at 7, not at the current version 8/);
  });
});

describe('the fixture check itself', () => {
  // A synthetic format 7, in which a Kanban board called its columns `lanes`.
  const renameLanes: BoardMigrationStep = {
    from: 7,
    to: 8,
    migrate: (file) => {
      const { lanes, ...board } = file.board as Record<string, unknown>;
      return { ...file, board: { ...board, columns: lanes } };
    },
  };
  const columns = [{ id: 'c1', title: 'To do', position: 0 }];
  const board = { id: 'b1', type: 'kanban', name: 'Plan', emoji: '', createdAt: 1, updatedAt: 2, settings: {} };
  const current = { version: 8, board: { ...board, columns }, tileDefs: {}, connections: {}, frames: [] };
  const old = { ...current, version: 7, board: { ...board, lanes: columns } };
  let dir = '';

  afterEach(() => {
    __setBoardMigrationStepsForTests(null);
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  function writeFixtures(expected: unknown): void {
    dir = mkdtempSync(join(tmpdir(), 'filo-board-migrations-'));
    writeFileSync(join(dir, 'v7.board.json'), JSON.stringify(old, null, 2));
    writeFileSync(join(dir, 'v7.expected.json'), JSON.stringify(expected, null, 2));
  }

  it('passes a step whose old file loads as the expected board', () => {
    __setBoardMigrationStepsForTests([renameLanes]);
    writeFixtures(BoardFileDataSchema.parse(current));
    expectFixturesHold(dir, 7);
  });

  it('fails a step whose result differs from the expected board', () => {
    __setBoardMigrationStepsForTests([renameLanes]);
    writeFixtures({ ...BoardFileDataSchema.parse(current), frames: [{ id: 'f' }] });
    expect(() => expectFixturesHold(dir, 7)).toThrow();
  });

  it('fails when no step carries the old file forward', () => {
    __setBoardMigrationStepsForTests([]);
    writeFixtures(BoardFileDataSchema.parse(current));
    expect(() => expectFixturesHold(dir, 7)).toThrow(/didn't load/);
  });
});

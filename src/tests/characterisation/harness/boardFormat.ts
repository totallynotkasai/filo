/**
 * A board saved by an older Filo, in an older board format. Filo has no real
 * older format to carry forward yet, so the specs use a synthetic one: format
 * 7, in which a Kanban board called its columns `lanes`, carried to the
 * current format by a test-only migration step.
 */
import { writeFileSync } from 'node:fs';
import type { CharApp } from './app';

type StepSeam = typeof import('@renderer/schema/migrations');

async function seam(): Promise<StepSeam> {
  return import('@renderer/schema/migrations');
}

/** This build reads format 7 boards (columns named `lanes`). Returns the undo. */
export async function readOlderBoardFormat(): Promise<() => void> {
  const s = await seam();
  s.__setBoardMigrationStepsForTests([
    {
      from: 7,
      to: 8,
      migrate: (file) => {
        const { lanes, ...board } = file.board as Record<string, unknown>;
        return { ...file, board: { ...board, columns: lanes } };
      },
    },
  ]);
  return () => s.__setBoardMigrationStepsForTests(null);
}

/** This build's step for format 7 fails (`why`). Returns the undo. */
export async function failOlderBoardFormat(why: string): Promise<() => void> {
  const s = await seam();
  s.__setBoardMigrationStepsForTests([
    {
      from: 7,
      to: 8,
      migrate: () => {
        throw new Error(why);
      },
    },
  ]);
  return () => s.__setBoardMigrationStepsForTests(null);
}

/**
 * Rewrites the Kanban board file at `rel` the way format 7 held it, as an
 * older Filo would have saved it. Returns the text written.
 */
export function saveAsOlderFormat(app: CharApp, rel: string): string {
  const file = JSON.parse(app.read(rel)) as { board: Record<string, unknown> };
  const { columns, ...board } = file.board;
  const text = JSON.stringify({ ...file, version: 7, board: { ...board, lanes: columns } }, null, 2);
  writeFileSync(app.abs(rel), text);
  return text;
}

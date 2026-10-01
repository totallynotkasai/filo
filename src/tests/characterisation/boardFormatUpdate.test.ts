/**
 * Characterisation: a board saved by an older Filo, in an older board format.
 * It opens in the current format with one notice per open, and opening it
 * writes nothing. Its first change saves it in the current format, after a
 * copy of the file as it was is kept in .filo/recovery; the change is there
 * after a reopen. A board whose update fails is listed as failed, and its
 * file is left as it was.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, quiesce, waitFor, reopenVault, reopenVaultAfter, recoveryCopies, type CharApp } from './harness/app';
import { createBoard, addKanbanColumn, openBoardFromSidebar, kanbanColumns, toastTexts, errorToasts } from './harness/actions';
import { readOlderBoardFormat, failOlderBoardFormat, saveAsOlderFormat } from './harness/boardFormat';

let undoFormat: (() => void) | null = null;

afterEach(async () => {
  await stopApp();
  undoFormat?.();
  undoFormat = null;
});

const OLDER_FORMAT_NOTICE = 'was made by an older version of Filo and opens in this version\'s board format';

function boardFile(app: CharApp): string {
  const rel = app.userFiles().find((f) => f.endsWith('.board.json'));
  if (!rel) throw new Error('no board file');
  return rel;
}

/** A Kanban board with one added column, then saved by an older Filo while the vault was closed. */
async function vaultWithOlderBoard(): Promise<{ app: CharApp; rel: string; original: string }> {
  const app = await startApp({});
  await createBoard(app, 'kanban');
  await addKanbanColumn(app);
  await quiesce(1000);
  const rel = boardFile(app);
  let original = '';
  await reopenVaultAfter(app, () => {
    original = saveAsOlderFormat(app, rel);
  });
  return { app, rel, original };
}

/** Copies kept in `.filo/recovery/<ts>-keep/` (never pruned). */
function keptCopies(app: CharApp): string[] {
  return [...recoveryCopies(app)].filter(([path]) => /-keep\//.test(path)).map(([, text]) => text);
}

describe('a board in an older board format', () => {
  it('opens with a notice and writes nothing, until its first change saves it in the current format after a copy', async () => {
    undoFormat = await readOlderBoardFormat();
    const { app, rel, original } = await vaultWithOlderBoard();

    await waitFor(() => toastTexts().some((t) => t.includes(OLDER_FORMAT_NOTICE)), 'the older-format notice');
    await openBoardFromSidebar(app, rel, 'kanban');
    // The column the older format held as a lane shows as a column.
    const columns = kanbanColumns(app).length;
    expect(columns).toBe(1);
    await quiesce(1500);
    expect(app.read(rel)).toBe(original);
    expect(keptCopies(app)).toEqual([]);

    // Another open: the file is still in its old format, and it says so once.
    await reopenVault(app);
    await waitFor(() => toastTexts().some((t) => t.includes(OLDER_FORMAT_NOTICE)), 'the notice on the next open');
    expect(toastTexts().filter((t) => t.includes(OLDER_FORMAT_NOTICE))).toHaveLength(1);
    expect(app.read(rel)).toBe(original);

    await openBoardFromSidebar(app, rel, 'kanban');
    await addKanbanColumn(app);
    await quiesce(1500);
    const saved = JSON.parse(app.read(rel)) as { version: number; board: { columns?: unknown[]; lanes?: unknown } };
    expect(saved.version).toBe(8);
    expect(saved.board.lanes).toBeUndefined();
    expect(saved.board.columns).toHaveLength(columns + 1);
    expect(keptCopies(app)).toEqual([original]);
    expect(toastTexts().some((t) => t.includes('is now saved in this version\'s board format'))).toBe(true);

    await reopenVault(app);
    await openBoardFromSidebar(app, rel, 'kanban');
    expect(kanbanColumns(app)).toHaveLength(columns + 1);
    expect(toastTexts().some((t) => t.includes(OLDER_FORMAT_NOTICE))).toBe(false);
    expect(keptCopies(app)).toEqual([original]);
    expect(errorToasts()).toEqual([]);
  });

  it('a board whose update fails is listed as failed, and its file is left as it was', async () => {
    undoFormat = await failOlderBoardFormat('lanes is not a list');
    const { app, rel, original } = await vaultWithOlderBoard();

    await waitFor(
      () => errorToasts().some((t) => t.includes('updating it to this version\'s format failed (from version 7: lanes is not a list)')),
      'the failed-board notice',
    );
    await quiesce(1500);
    expect(app.read(rel)).toBe(original);
    expect(keptCopies(app)).toEqual([]);
  });
});

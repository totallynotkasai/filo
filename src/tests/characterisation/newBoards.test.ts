/**
 * Characterisation — a board can be edited straight after it is created.
 *
 * Creating a board and editing it at once (no pause) never shows a "modified
 * externally" prompt, and every edit reaches the board file. An edit made by
 * another program while the board has unsaved changes still asks.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, waitFor, quiesce, recoveryCopies, type CharApp } from './harness/app';
import { onLinux } from './harness/platform';
import {
  createBoard,
  addKanbanColumn,
  placeNoteOnBoard,
  boardFilesText,
  toastActions,
  toastTexts,
  errorToasts,
  chooseToastAction,
  type BoardKind,
} from './harness/actions';

afterEach(async () => {
  await stopApp();
});

const NOTES = { 'A.md': 'Alpha\n', 'B.md': 'Bravo\n', 'C.md': 'Charlie\n' };

function driftPromptShown(): boolean {
  return toastActions().includes('Reload') || toastTexts().some((t) => t.includes('modified externally'));
}

interface BoardOnDisk {
  board: { columns?: unknown[] };
  tileDefs: Record<string, { filePath?: string }>;
}

function theBoard(app: CharApp): BoardOnDisk {
  const files = boardFilesText(app);
  expect(files).toHaveLength(1);
  return JSON.parse(files[0]) as BoardOnDisk;
}

function placedNotes(app: CharApp): string[] {
  return Object.values(theBoard(app).tileDefs).map((d) => d.filePath ?? '').filter(Boolean).sort();
}

async function placeThreeNotesOnNewBoard(kind: BoardKind): Promise<void> {
  const app = await startApp(NOTES);
  await createBoard(app, kind);
  await placeNoteOnBoard(app, kind, 'A.md');
  await placeNoteOnBoard(app, kind, 'B.md');
  await placeNoteOnBoard(app, kind, 'C.md');

  await quiesce(2500);
  expect(driftPromptShown()).toBe(false);
  expect(errorToasts()).toEqual([]);
  expect(placedNotes(app)).toEqual(['A.md', 'B.md', 'C.md']);
}

describe('a new board edited at once', () => {
  it('Kanban: three columns added straight after creating it all reach the file, with no prompt', async () => {
    const app = await startApp();
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    await addKanbanColumn(app);
    await addKanbanColumn(app);

    await quiesce(2500);
    expect(driftPromptShown()).toBe(false);
    expect(errorToasts()).toEqual([]);
    expect(theBoard(app).board.columns).toHaveLength(3);
  });

  it('Mind map: three notes placed straight after creating it all reach the file, with no prompt', async () => {
    await placeThreeNotesOnNewBoard('mindmap');
  });

  it('Task List: three notes placed straight after creating it all reach the file, with no prompt', async () => {
    await placeThreeNotesOnNewBoard('tasklist');
  });
});

describe('an edit to the board file by another program', () => {
  it('while the board has an unsaved change: Filo asks before overwriting it', async () => {
    const app = await startApp();
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    // Past Filo's own-echo windows for that save, so the next change on disk
    // can only be the other program's.
    await quiesce(3000);

    const rel = app.userFiles().find((f) => f.endsWith('.board.json'));
    if (!rel) throw new Error('no board file');
    // Another program rewrites the board (same content, different layout),
    // and the user adds a column before Filo has seen it.
    const external = JSON.stringify(JSON.parse(app.read(rel)));
    app.writeExternally(rel, external);
    await addKanbanColumn(app);

    await waitFor(driftPromptShown, 'a "modified externally" prompt');
    // Keeping the local edits overwrites the external bytes only after
    // backing them up; nothing is lost silently.
    while (toastActions().some((l) => l === 'Keep local' || l === 'Keep your edits')) {
      await chooseToastAction(toastActions().find((l) => l === 'Keep local' || l === 'Keep your edits')!);
      await quiesce(800);
    }
    await waitFor(() => (theBoard(app).board.columns ?? []).length === 2, 'both columns in the board file');
  });

  it.skipIf(onLinux)('replaced by a board from a newer Filo: the next save asks, and Keep local backs that file up first', async () => {
    const app = await startApp();
    await createBoard(app, 'kanban');
    await addKanbanColumn(app);
    // Past Filo's own-echo windows for that save, so the next change on disk
    // can only be the other program's.
    await quiesce(8000);

    const rel = app.userFiles().find((f) => f.endsWith('.board.json'));
    if (!rel) throw new Error('no board file');
    // A newer Filo on another machine saved the board: this build can't load it.
    const newer = JSON.stringify({ ...JSON.parse(app.read(rel)), version: 9, fromNewer: true }, null, 2);
    app.writeExternally(rel, newer);
    await waitFor(() => errorToasts().some((t) => t.includes("couldn't be applied")), 'the failed-reload notice');

    // The user keeps working on Filo's copy: its save must not overwrite the newer file unasked.
    await addKanbanColumn(app);
    await waitFor(driftPromptShown, 'a "modified externally" prompt');
    expect(app.read(rel)).toBe(newer);

    await chooseToastAction('Keep local');
    await quiesce(1500);
    const copies = [...recoveryCopies(app).values()];
    expect(copies.some((text) => text.includes('"fromNewer": true'))).toBe(true);
  });
});

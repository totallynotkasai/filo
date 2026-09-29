/**
 * Characterisation — dragging a file from Explorer onto a board.
 *
 * A note already in the vault is placed by its path, as a drag from the
 * sidebar places it: no second copy (`Plan (1).md`) appears, and the card,
 * task or tile shows the note itself. A file from outside the vault is
 * copied in, as before.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp, stopApp, waitFor, quiesce } from './harness/app';
import {
  createBoard,
  addKanbanColumn,
  dropFromExplorer,
  kanbanCards,
  taskRows,
  mindMapTiles,
  placeNoteOnBoard,
  toastTexts,
  type BoardKind,
} from './harness/actions';

afterEach(async () => {
  await stopApp();
});

const PLAN = '---\ntitle: Plan\n---\nThe plan\n';

async function boardOf(app: Awaited<ReturnType<typeof startApp>>, kind: BoardKind): Promise<void> {
  await createBoard(app, kind);
  if (kind === 'kanban') await addKanbanColumn(app);
}

function shown(app: Awaited<ReturnType<typeof startApp>>, kind: BoardKind): number {
  return kind === 'kanban' ? kanbanCards(app).length : kind === 'tasklist' ? taskRows(app).length : mindMapTiles(app).length;
}

describe('a note from inside the vault, dropped from Explorer', () => {
  for (const kind of ['kanban', 'tasklist', 'mindmap'] as const) {
    it(`on a ${kind} board is placed by its path, with no copy`, async () => {
      const app = await startApp({ 'Notes/Plan.md': PLAN });
      await boardOf(app, kind);
      const before = app.userFiles().filter((f) => f.endsWith('.md'));

      await dropFromExplorer(app, kind, app.abs('Notes/Plan.md'));
      await waitFor(() => shown(app, kind) === 1, `the note on the ${kind} board`);
      await quiesce(500);

      expect(app.userFiles().filter((f) => f.endsWith('.md'))).toEqual(before);
      expect(app.read('Notes/Plan.md')).toBe(PLAN);
    });
  }
});

describe('a note dropped on a Task List it is already on', () => {
  it('is not added a second time', async () => {
    const app = await startApp({ 'Notes/Plan.md': PLAN });
    await createBoard(app, 'tasklist');
    await dropFromExplorer(app, 'tasklist', app.abs('Notes/Plan.md'));
    await waitFor(() => taskRows(app).length === 1, 'the task');

    await dropFromExplorer(app, 'tasklist', app.abs('Notes/Plan.md'));
    await placeNoteOnBoard(app, 'tasklist', 'Notes/Plan.md');
    await quiesce(500);
    expect(taskRows(app)).toHaveLength(1);
    expect(toastTexts().some((t) => t.includes('Already on this list'))).toBe(true);
  });
});

describe('a note from outside the vault, dropped from Explorer', () => {
  it('is copied into the vault', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'filo-outside-'));
    try {
      writeFileSync(join(outside, 'Imported.md'), '---\ntitle: Imported\n---\nFrom elsewhere\n');
      const app = await startApp({ 'Plan.md': PLAN });
      await boardOf(app, 'kanban');

      await dropFromExplorer(app, 'kanban', join(outside, 'Imported.md'));
      await waitFor(() => app.userFiles().some((f) => f.endsWith('Imported.md')), 'the copy in the vault');
      expect(kanbanCards(app)).toHaveLength(1);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

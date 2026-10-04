/**
 * Characterisation — undoing a board delete from its toast.
 *
 * The board comes back as it was shown: its camera (`.filo/viewports.json`)
 * and its side toolbar's place, not only its file. That holds whether the
 * board was deleted in the Board Browser or went with its folder in the
 * sidebar.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, waitFor, type CharApp } from './harness/app';
import {
  chooseToastAction,
  createBoard,
  deleteBoardInBrowser,
  deleteInSidebar,
  errorToasts,
  panAndZoomMindMap,
} from './harness/actions';

afterEach(async () => {
  await stopApp();
});

function viewportOf(app: CharApp, boardId: string): { x: number; y: number; scale: number } | undefined {
  if (!app.exists('.filo/viewports.json')) return undefined;
  return (JSON.parse(app.read('.filo/viewports.json')) as Record<string, { x: number; y: number; scale: number }>)[boardId];
}

describe('undoing a board delete', () => {
  it('brings the board back with its camera', async () => {
    const app = await startApp({ 'Keep.md': 'K\n' });
    const boardId = await createBoard(app, 'mindmap');
    await panAndZoomMindMap(app);
    await waitFor(() => viewportOf(app, boardId) !== undefined, 'the camera saved');
    const before = viewportOf(app, boardId);

    // A new vault gives each board a folder of its own.
    const rel = 'Mind Map 1/Mind Map 1.board.json';
    expect(app.exists(rel)).toBe(true);
    await deleteBoardInBrowser(app, 'Mind Map 1');
    await waitFor(() => !app.exists(rel), 'the board file in the trash');
    await waitFor(() => viewportOf(app, boardId) === undefined, 'the camera dropped');

    await chooseToastAction('Undo');
    await waitFor(() => app.exists(rel), 'the board file back');
    await waitFor(() => viewportOf(app, boardId) !== undefined, 'the camera back');
    const after = viewportOf(app, boardId);
    expect({ x: after?.x, y: after?.y, scale: after?.scale }).toEqual({ x: before?.x, y: before?.y, scale: before?.scale });
    expect(errorToasts()).toEqual([]);
  });

  it("its folder deleted in the sidebar: undo brings the board back with its camera", async () => {
    const app = await startApp({ 'Keep.md': 'K\n' });
    const boardId = await createBoard(app, 'mindmap');
    await panAndZoomMindMap(app);
    await waitFor(() => viewportOf(app, boardId) !== undefined, 'the camera saved');
    const before = viewportOf(app, boardId);
    const rel = 'Mind Map 1/Mind Map 1.board.json';

    await deleteInSidebar(app, 'Mind Map 1');
    await waitFor(() => !app.exists('Mind Map 1'), 'the folder in the trash');
    await waitFor(() => viewportOf(app, boardId) === undefined, 'the camera dropped');

    await chooseToastAction('Undo');
    await waitFor(() => app.exists(rel), 'the board file back');
    await waitFor(() => viewportOf(app, boardId) !== undefined, 'the camera back');
    const after = viewportOf(app, boardId);
    expect({ x: after?.x, y: after?.y, scale: after?.scale }).toEqual({ x: before?.x, y: before?.y, scale: before?.scale });
    expect(errorToasts()).toEqual([]);
  });
});

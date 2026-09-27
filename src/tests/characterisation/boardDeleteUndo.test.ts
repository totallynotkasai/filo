/**
 * Characterisation — undoing a board delete from its toast.
 *
 * The board comes back as it was shown: its camera (`.filo/viewports.json`)
 * and its side toolbar's place, not only its file.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startApp, stopApp, waitFor, type CharApp } from './harness/app';
import {
  chooseToastAction,
  createBoard,
  deleteBoardInBrowser,
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

    await deleteBoardInBrowser(app, 'Mind Map 1');
    await waitFor(() => !app.exists('Mind Map 1.board.json'), 'the board file in the trash');
    await waitFor(() => viewportOf(app, boardId) === undefined, 'the camera dropped');

    await chooseToastAction('Undo');
    await waitFor(() => app.exists('Mind Map 1.board.json'), 'the board file back');
    await waitFor(() => viewportOf(app, boardId) !== undefined, 'the camera back');
    const after = viewportOf(app, boardId);
    expect({ x: after?.x, y: after?.y, scale: after?.scale }).toEqual({ x: before?.x, y: before?.y, scale: before?.scale });
    expect(errorToasts()).toEqual([]);
  });
});

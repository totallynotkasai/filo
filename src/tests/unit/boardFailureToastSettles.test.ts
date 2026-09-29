import { describe, it, expect, beforeEach } from 'vitest';
import {
  __resetDirtyTrackingForTests,
  beginWrite,
  endWrite,
} from '@renderer/lib/boards/writeStateTracking';
import { settleBoardFailureToasts, trackBoardFailureToast } from '@renderer/lib/boards/writeFailureToasts';

/**
 * A "Board save failed" toast closes once its board has nothing owed: the
 * kept write landed, or the board was deleted and its write dropped. It used
 * to stay up, saying the save had failed, after both.
 */

const ROOT = 'C:/vault';

beforeEach(() => {
  __resetDirtyTrackingForTests();
});

function settle(): string[] {
  const closed: string[] = [];
  settleBoardFailureToasts((id) => closed.push(id));
  return closed;
}

describe('board save failure toasts', () => {
  it('stay while the board is failed, and close once it is saved', () => {
    beginWrite(ROOT, 'Plan.board.json');
    trackBoardFailureToast('t1', 'Plan.board.json');
    expect(settle()).toEqual([]); // in flight
    endWrite(ROOT, 'Plan.board.json', false);
    expect(settle()).toEqual([]); // failed, kept for Retry

    beginWrite(ROOT, 'Plan.board.json');
    endWrite(ROOT, 'Plan.board.json', true);
    expect(settle()).toEqual(['t1']);
    expect(settle()).toEqual([]);
  });

  it('a toast about two boards closes only when both are saved', () => {
    for (const p of ['A.board.json', 'B.board.json']) {
      beginWrite(ROOT, p);
      trackBoardFailureToast('t2', p);
      endWrite(ROOT, p, false);
    }
    beginWrite(ROOT, 'A.board.json');
    endWrite(ROOT, 'A.board.json', true);
    expect(settle()).toEqual([]);
    beginWrite(ROOT, 'B.board.json');
    endWrite(ROOT, 'B.board.json', true);
    expect(settle()).toEqual(['t2']);
  });
});

import { describe, it, expect } from 'vitest';
import { decideWindowClose } from '../../main/utils/windowCloseDecision';

/**
 * 1.3 (WRITE_PATH_REMEDIATION_PLAN_2026-06-04) — a second X-click while a
 * flush-and-quit drain is already running used to hit a bare
 * `if (isFlushingForQuit) return;` that did NOT call `event.preventDefault()`,
 * so Electron destroyed the window mid-write and aborted the drain. The guard
 * must keep blocking the close until the drain itself calls `mainWindow.destroy()`.
 */
describe('decideWindowClose — re-entrancy guard (1.3)', () => {
  it('first close on a live window → preventDefault + start the drain', () => {
    expect(decideWindowClose({ isFlushing: false, windowAlive: true })).toEqual({
      preventDefault: true,
      startDrain: true,
    });
  });

  it('second close while a drain is in flight → STILL preventDefault, no new drain', () => {
    // The regression: this is the branch that previously returned without
    // preventDefault, letting the destroy proceed mid-write.
    expect(decideWindowClose({ isFlushing: true, windowAlive: true })).toEqual({
      preventDefault: true,
      startDrain: false,
    });
    expect(decideWindowClose({ isFlushing: true, windowAlive: false })).toEqual({
      preventDefault: true,
      startDrain: false,
    });
  });

  it('close after the window is already gone → let it proceed (no preventDefault)', () => {
    expect(decideWindowClose({ isFlushing: false, windowAlive: false })).toEqual({
      preventDefault: false,
      startDrain: false,
    });
  });

  it('two clicks in a row both block while flushing (the full repro)', () => {
    // Click 1 starts the drain.
    const first = decideWindowClose({ isFlushing: false, windowAlive: true });
    expect(first.preventDefault).toBe(true);
    expect(first.startDrain).toBe(true);
    // The drain set isFlushingForQuit = true; click 2 must STILL block.
    const second = decideWindowClose({ isFlushing: true, windowAlive: true });
    expect(second.preventDefault).toBe(true);
    expect(second.startDrain).toBe(false);
  });
});

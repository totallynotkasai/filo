import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOARD_PRELOAD_DELAY_MS,
  BOARD_PRELOAD_IDLE_TIMEOUT_MS,
  scheduleBoardModulePreload,
} from '../../renderer/lib/boards/boardModulePreload';

type IdleCallback = (deadline: IdleDeadline) => void;

describe('scheduleBoardModulePreload', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('runs every loader after the delay, not before', () => {
    const loaders = [vi.fn(async () => 'a'), vi.fn(async () => 'b')];
    scheduleBoardModulePreload(loaders);

    vi.advanceTimersByTime(BOARD_PRELOAD_DELAY_MS - 1);
    expect(loaders[0]).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(loaders[0]).toHaveBeenCalledTimes(1);
    expect(loaders[1]).toHaveBeenCalledTimes(1);
  });

  it('waits for the browser to go idle when it can', () => {
    const idle: { cb?: IdleCallback } = {};
    const requestIdle = vi.fn((cb: IdleCallback) => {
      idle.cb = cb;
      return 7;
    });
    vi.stubGlobal('requestIdleCallback', requestIdle);
    vi.stubGlobal('cancelIdleCallback', vi.fn());
    const load = vi.fn(async () => undefined);

    scheduleBoardModulePreload([load]);
    vi.advanceTimersByTime(BOARD_PRELOAD_DELAY_MS);

    expect(requestIdle).toHaveBeenCalledWith(expect.any(Function), {
      timeout: BOARD_PRELOAD_IDLE_TIMEOUT_MS,
    });
    expect(load).not.toHaveBeenCalled();

    idle.cb!({ didTimeout: false, timeRemaining: () => 50 });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('loads nothing once cancelled before the delay ends', () => {
    const load = vi.fn(async () => undefined);
    const cancel = scheduleBoardModulePreload([load]);

    cancel();
    vi.advanceTimersByTime(BOARD_PRELOAD_DELAY_MS * 10);
    expect(load).not.toHaveBeenCalled();
  });

  it('cancels a pending idle callback', () => {
    const idle: { cb?: IdleCallback } = {};
    vi.stubGlobal('requestIdleCallback', (cb: IdleCallback) => {
      idle.cb = cb;
      return 3;
    });
    const cancelIdle = vi.fn();
    vi.stubGlobal('cancelIdleCallback', cancelIdle);
    const load = vi.fn(async () => undefined);

    const cancel = scheduleBoardModulePreload([load]);
    vi.advanceTimersByTime(BOARD_PRELOAD_DELAY_MS);
    cancel();

    expect(cancelIdle).toHaveBeenCalledWith(3);
    idle.cb!({ didTimeout: false, timeRemaining: () => 50 });
    expect(load).not.toHaveBeenCalled();
  });

  it('ignores a loader that fails, and still runs the others', async () => {
    const failing = vi.fn(() => Promise.reject(new Error('chunk failed')));
    const ok = vi.fn(async () => undefined);

    scheduleBoardModulePreload([failing, ok]);
    vi.advanceTimersByTime(BOARD_PRELOAD_DELAY_MS);
    await vi.runAllTimersAsync();

    expect(failing).toHaveBeenCalledTimes(1);
    expect(ok).toHaveBeenCalledTimes(1);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { decideSessionEnd } from '../../main/utils/sessionEndDecision';
import { createSessionEndHandlers, SESSION_RESCUE_BOUND_MS, type SessionEndDeps } from '../../main/services/sessionEnd';

/**
 * Windows ending the session (shutdown, restart, sign-out) runs neither the
 * window close drain nor `before-quit`. Main holds the session back only when
 * the renderer last said leaving could lose work, asks it to save and keep
 * rescue copies, and exits on its reply or when the bound runs out.
 */
describe('decideSessionEnd', () => {
  it('holds the session and starts the rescue when work could be lost', () => {
    expect(decideSessionEnd({ rendererAlive: true, mayLoseWork: true, rescue: 'idle' })).toEqual({ preventDefault: true, startRescue: true });
  });

  it('lets the session go when nothing could be lost', () => {
    expect(decideSessionEnd({ rendererAlive: true, mayLoseWork: false, rescue: 'idle' })).toEqual({ preventDefault: false, startRescue: false });
  });

  it('lets it go when no renderer can answer', () => {
    expect(decideSessionEnd({ rendererAlive: false, mayLoseWork: true, rescue: 'idle' })).toEqual({ preventDefault: false, startRescue: false });
  });

  it('keeps holding while the rescue runs, without starting another', () => {
    expect(decideSessionEnd({ rendererAlive: true, mayLoseWork: true, rescue: 'running' })).toEqual({ preventDefault: true, startRescue: false });
  });

  it('lets it go once the rescue is done', () => {
    expect(decideSessionEnd({ rendererAlive: true, mayLoseWork: true, rescue: 'done' })).toEqual({ preventDefault: false, startRescue: false });
  });
});

describe('createSessionEndHandlers', () => {
  let log: string[];
  let doneListener: (() => void) | null;
  let deps: SessionEndDeps;

  beforeEach(() => {
    vi.useFakeTimers();
    log = [];
    doneListener = null;
    deps = {
      rendererAlive: () => true,
      sendSessionEnding: () => log.push('send'),
      onceDone: (listener) => {
        doneListener = listener;
        return () => {
          doneListener = null;
        };
      },
      markQuitting: () => log.push('quitting'),
      teardown: async () => {
        log.push('teardown');
      },
      teardownBoundMs: 2000,
      exit: () => log.push('exit'),
      writeBreadcrumb: async () => {
        log.push('breadcrumb');
      },
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('with nothing to lose, lets Windows go and asks the renderer nothing', () => {
    const handlers = createSessionEndHandlers(deps);
    handlers.noteUnsavedState(false);
    expect(handlers.onQuerySessionEnd()).toBe(false);
    expect(log).toEqual([]);
  });

  it('with work that could be lost: holds, asks the renderer, and exits once it replies', async () => {
    const handlers = createSessionEndHandlers(deps);
    handlers.noteUnsavedState(true);
    expect(handlers.onQuerySessionEnd()).toBe(true);
    expect(log).toEqual(['quitting', 'send']);
    // A second query while it saves is held too, without asking again.
    expect(handlers.onQuerySessionEnd()).toBe(true);
    expect(log).toEqual(['quitting', 'send']);

    doneListener?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toEqual(['quitting', 'send', 'teardown', 'exit']);
    expect(handlers.state()).toBe('done');
    expect(handlers.onQuerySessionEnd()).toBe(false);
  });

  it('a renderer that never replies: exits when the bound runs out', async () => {
    const handlers = createSessionEndHandlers(deps);
    handlers.noteUnsavedState(true);
    handlers.onQuerySessionEnd();
    await vi.advanceTimersByTimeAsync(SESSION_RESCUE_BOUND_MS - 1);
    expect(log).not.toContain('exit');
    await vi.advanceTimersByTimeAsync(1);
    expect(log).toEqual(['quitting', 'send', 'teardown', 'exit']);
    expect(doneListener).toBeNull();
  });

  it('a teardown that hangs still exits, after its bound', async () => {
    deps.teardown = () => new Promise(() => {});
    const handlers = createSessionEndHandlers(deps);
    handlers.noteUnsavedState(true);
    handlers.onQuerySessionEnd();
    doneListener?.();
    await vi.advanceTimersByTimeAsync(1999);
    expect(log).not.toContain('exit');
    await vi.advanceTimersByTimeAsync(1);
    expect(log.at(-1)).toBe('exit');
  });

  it('session-end (no delay possible) asks the renderer anyway and writes the breadcrumb', () => {
    const handlers = createSessionEndHandlers(deps);
    handlers.onSessionEnd();
    expect(log).toEqual(['send', 'breadcrumb']);
  });
});

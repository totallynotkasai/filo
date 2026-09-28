/**
 * A running countdown is stored as a wall-clock end time (`endsAt`, epoch ms),
 * so it keeps counting while its board is closed, across a quit and on
 * another machine, and nothing has to rewrite the board while it runs.
 * `remaining` is the time left while stopped; while running it is only the
 * fallback for a board saved before `endsAt` existed.
 */

export interface TimerClock {
  remaining: number;
  isRunning: boolean;
  endsAt?: number | undefined;
}

/** Milliseconds left on the countdown at `nowMs`. */
export function timerRemainingAt(timer: TimerClock, nowMs: number): number {
  if (!timer.isRunning || timer.endsAt === undefined) return Math.max(0, timer.remaining);
  return Math.max(0, timer.endsAt - nowMs);
}

/** The update that starts (or resumes) a countdown with `remaining` left. */
export function startTimerPatch(remaining: number, nowMs: number): { isRunning: true; endsAt: number } {
  return { isRunning: true, endsAt: nowMs + Math.max(0, remaining) };
}

/** The update that stops a countdown, keeping the time it had left. */
export function stopTimerPatch(
  timer: TimerClock,
  nowMs: number,
): { remaining: number; isRunning: false; endsAt: undefined } {
  return { remaining: timerRemainingAt(timer, nowMs), isRunning: false, endsAt: undefined };
}

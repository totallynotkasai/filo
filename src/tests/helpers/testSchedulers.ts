/**
 * `createScheduler` for unit tests that make their own write scheduler. Each
 * one made is retired by `disposeTestSchedulers` (the file runs it in an
 * `afterEach`): its timers are cancelled and its armed-path check is
 * unregistered from `writeStateTracking`, so a write one test left armed
 * can't keep a path pending in the next.
 */
import { createScheduler as createAppScheduler } from '@renderer/lib/boards/writeScheduler';
import type { CreateSchedulerOptions, Scheduler } from '@renderer/lib/boards/writeSchedulerTypes';

const disposers: Array<() => void> = [];

export function createScheduler<TArgs>(opts: CreateSchedulerOptions<TArgs>): Scheduler<TArgs> {
  const scheduler = createAppScheduler(opts);
  disposers.push(() => scheduler.dispose());
  return scheduler;
}

/** Retires every scheduler made since the last call. */
export function disposeTestSchedulers(): void {
  for (const dispose of disposers.splice(0)) dispose();
}

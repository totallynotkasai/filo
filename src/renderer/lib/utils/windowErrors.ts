import { reportError } from './errorBus';

/**
 * The renderer-wide backstops for unknown-unknowns. Write paths already route
 * their failures through trackComponentWrite / markPathFailed, but a
 * programming error in a `void`-ed chain or an event handler otherwise dies as
 * a console-only unhandled rejection. Routing through reportError feeds
 * App.svelte's coalescing errorToastAggregator (rate-limited, count-badged),
 * so a rejection storm collapses into one toast per context instead of
 * spamming the stack.
 */

type ReportFn = typeof reportError;

/**
 * Chromium's notice that a ResizeObserver callback changed the size of
 * something observed, so the rest of that frame's size notifications wait for
 * the next frame. Nothing failed and nothing is lost, but it arrives as a
 * window `error` event (with no `error` object) and would otherwise show as
 * "An unexpected error occurred.". Older Chromium words it "loop limit exceeded".
 */
export function isResizeObserverNotice(event: Pick<ErrorEvent, 'error' | 'message'>): boolean {
  if (event.error !== null && event.error !== undefined) return false;
  return /^ResizeObserver loop (completed with undelivered notifications|limit exceeded)/.test(event.message ?? '');
}

/**
 * What a window error reports: the thrown value, else (a script error with no
 * value, as cross-origin and engine notices are) its message and where it was
 * raised, so Copy details has more than the message to go on.
 */
export function windowErrorValue(event: Pick<ErrorEvent, 'error' | 'message' | 'filename' | 'lineno' | 'colno'>): unknown {
  if (event.error !== null && event.error !== undefined) return event.error;
  return event.filename ? `${event.message} (at ${event.filename}:${event.lineno}:${event.colno})` : event.message;
}

/** Registers both backstops on `target`. Call once, before the app mounts. */
export function installErrorBackstops(target: Window, report: ReportFn = reportError): void {
  target.addEventListener('unhandledrejection', (event) => {
    report('unhandledrejection', event.reason, 'An unexpected background task failed.');
  });
  target.addEventListener('error', (event) => {
    if (isResizeObserverNotice(event)) return;
    report('window.onerror', windowErrorValue(event), 'An unexpected error occurred.');
  });
}

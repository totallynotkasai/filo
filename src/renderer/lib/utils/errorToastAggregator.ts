/**
 * Aggregates rapid-fire errorBus reports so a bulk failure (e.g. a tag-rename
 * sweep that fails 30 .md writes) coalesces into a single toast with a count
 * badge instead of N separate toasts.
 *
 * Keyed by `coalesceKey ?? context`. Within `windowMs` of the last error for
 * that key, subsequent reports update the existing toast text via
 * `updateToastText`. The window resets on every fresh report — so a steady
 * stream extends the same toast indefinitely. After `windowMs` of silence the
 * entry is dropped, and the next error opens a brand new toast.
 *
 * The optional per-report `coalesceKey` overrides the coalescing key WITHOUT
 * changing the displayed `context` prefix. The write-error wiring sets it to
 * `context + preservedTmpPath` so two same-kind failures that preserved bytes at
 * DIFFERENT recovery locations each keep their own toast (otherwise the second
 * would overwrite the first's path). Reports without a `coalesceKey` (the
 * common case) coalesce by `context`.
 *
 * A toast that comes to cover more than one file names them all ("3 files
 * couldn't be saved: A, B, C") rather than only the newest, and drops the
 * buttons that were about the first file alone: a per-file action on a toast
 * naming another file would act on the wrong one. `sharedActions` (Retry,
 * which re-fires every failed write) stay, and `details` adds a Details
 * button that opens the full list.
 *
 * The error bus's aggregator runs `readable` (see the option): one toast per
 * context and file, showing the message rather than the context id.
 *
 * With `copyDetails`, every toast also has a Copy details button that hands
 * over the reports the toast stands for (the newest `MAX_DETAILED_REPORTS`),
 * so the error's own text, which the toast leaves out, can be read. It keeps
 * the toast open: copying isn't an answer to the toast.
 *
 * Returns the id of the toast the report went to, so a caller can close it
 * once what it reports is resolved.
 *
 * Separated from the `App.svelte` wiring so the aggregation behaviour can be
 * unit-tested without mounting the component.
 */

import type { ReportedError } from './errorBus';
import type { TimedReport } from './errorDetails';

/** How many reports one toast keeps for Copy details (the newest ones). */
export const MAX_DETAILED_REPORTS = 20;

/**
 * A `ReportedError` plus an optional coalescing-key override. Kept a
 * superset of `ReportedError` so the generic `onError(aggregator)` path (which
 * never sets `coalesceKey`) still type-checks against the `Handler` signature.
 */
export interface AggregatedReport extends ReportedError {
  /**
   * Overrides the Map key the report coalesces under. Defaults to `context`.
   * The DISPLAY prefix always remains `context`.
   */
  coalesceKey?: string;
  /** The file the report is about. */
  path?: string;
  /** Buttons about this report's file only; kept while the toast covers one file. */
  actions?: ToastButton[];
  /** Buttons that act on every report the toast covers (e.g. Retry all). */
  sharedActions?: ToastButton[];
}

export interface ToastButton {
  label: string;
  handler: () => void | Promise<void>;
  /** The toast stays after the button is pressed. */
  keepOpen?: boolean;
}

export interface AggregatorToastApi {
  /**
   * Pushes a new persistent error toast. Returns the toast id. The `onDismiss`
   * callback fires when the user dismisses the toast manually so the
   * aggregator can drop its tracking entry.
   */
  pushToast(opts: {
    text: string;
    type: 'error';
    duration: 0;
    onDismiss: () => void;
    actions?: ToastButton[];
  }): string;
  /**
   * Updates the text of an existing toast. Returns true if the toast was
   * found, false otherwise (e.g. the user dismissed it). On false, the
   * aggregator falls through and pushes a fresh toast.
   */
  updateToastText(id: string, text: string): boolean;
  /** Replaces a toast's buttons. Optional: without it the buttons stay as pushed. */
  updateToastActions?(id: string, actions: ToastButton[]): boolean;
}

interface AggregatedToast {
  toastId: string;
  count: number;
  expiryTimer: ReturnType<typeof setTimeout>;
  /** Distinct files the toast covers, first report first. */
  paths: string[];
  /** What Copy details hands over; the toast's button holds the same array. */
  reports: TimedReport[];
}

export interface ErrorToastAggregatorOptions {
  /** Silence window after which the next same-context error opens a fresh toast. */
  windowMs?: number;
  /** Opens the full list; offered once a toast covers more than one file. */
  details?: () => void;
  /**
   * For the error bus, whose contexts are ids (`boardCache.persist`), not
   * labels: a report with a message shows just the message, one without
   * shows a readable label before the error, and reports coalesce by
   * context and file, so a second file's report never replaces the first's.
   */
  readable?: boolean;
  /** Puts a toast's reports on the clipboard; adds a Copy details button to every toast. */
  copyDetails?: (reports: readonly TimedReport[]) => void | Promise<void>;
}

/** `boardCache.create-text-md` → `Board cache`: the subsystem of an error-bus context id. */
export function readableContext(context: string): string {
  const head = context.split('.')[0] ?? context;
  const words = head.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : context;
}

/** How many file names a toast spells out before "…". */
const NAMED_PATHS = 3;

function fileList(paths: readonly string[]): string {
  const named = paths.slice(0, NAMED_PATHS).join(', ');
  return paths.length > NAMED_PATHS ? `${named}…` : named;
}

export function createErrorToastAggregator(
  api: AggregatorToastApi,
  options: ErrorToastAggregatorOptions = {},
): (err: AggregatedReport) => string {
  const windowMs = options.windowMs ?? 1000;
  const recent = new Map<string, AggregatedToast>();
  const { copyDetails } = options;
  // Bound to the toast's own array, so it still copies once the coalescing
  // window has closed and the entry is gone.
  const copyButton = (reports: readonly TimedReport[]): ToastButton[] =>
    copyDetails ? [{ label: 'Copy details', handler: () => copyDetails(reports), keepOpen: true }] : [];

  return ({ context, message, error, coalesceKey, path, actions, sharedActions }) => {
    const report: ReportedError = { context, error };
    if (message !== undefined) report.message = message;
    if (path !== undefined) report.path = path;
    const timed: TimedReport = { report, at: Date.now() };
    // Coalesce by `coalesceKey` when supplied, else by `context`. The
    // display prefix below always stays `context`, so the count badge reads per
    // write KIND while distinct recovery locations keep separate toasts.
    const key = coalesceKey ?? (options.readable ? `${context}::${path ?? ''}` : context);
    const detail = message ?? (error instanceof Error ? error.message : String(error));
    const readableText = message ?? `${readableContext(context)}: ${detail}`;
    const existing = recent.get(key);

    if (existing) {
      // A readable toast is about one file (its key names it), so it only counts.
      const newFile = !options.readable && path !== undefined && !existing.paths.includes(path);
      const paths = newFile ? [...existing.paths, path] : existing.paths;
      const text = options.readable
        ? `${readableText} (${existing.count + 1}×)`
        : paths.length > 1
          ? `${context}: ${paths.length} files couldn't be saved: ${fileList(paths)}`
          : `${context} (${existing.count + 1}×): ${detail}`;
      const updated = api.updateToastText(existing.toastId, text);
      if (updated) {
        existing.count++;
        existing.reports.push(timed);
        if (existing.reports.length > MAX_DETAILED_REPORTS) existing.reports.shift();
        if (newFile && paths.length === 2) {
          // The first file's own buttons no longer fit a toast about several.
          const buttons = [
            ...(sharedActions ?? []),
            ...(options.details ? [{ label: 'Details', handler: options.details }] : []),
            ...copyButton(existing.reports),
          ];
          api.updateToastActions?.(existing.toastId, buttons);
        }
        existing.paths = paths;
        clearTimeout(existing.expiryTimer);
        existing.expiryTimer = setTimeout(() => recent.delete(key), windowMs);
        return existing.toastId;
      }
      // Existing entry was dismissed by the user — fall through and push fresh.
      clearTimeout(existing.expiryTimer);
      recent.delete(key);
    }

    const reports = [timed];
    const buttons = [...(actions ?? []), ...(sharedActions ?? []), ...copyButton(reports)];
    const toastId = api.pushToast({
      text: options.readable ? readableText : `${context}: ${detail}`,
      type: 'error',
      duration: 0,
      ...(buttons.length > 0 ? { actions: buttons } : {}),
      onDismiss: () => {
        const entry = recent.get(key);
        if (entry?.toastId === toastId) {
          clearTimeout(entry.expiryTimer);
          recent.delete(key);
        }
      },
    });
    const expiryTimer = setTimeout(() => recent.delete(key), windowMs);
    recent.set(key, { toastId, count: 1, expiryTimer, paths: path !== undefined && !options.readable ? [path] : [], reports });
    return toastId;
  };
}

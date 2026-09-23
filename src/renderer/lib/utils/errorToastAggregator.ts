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
 * A9-L10 — the optional per-report `coalesceKey` overrides the coalescing key
 * WITHOUT changing the displayed `context` prefix. The write-error wiring sets
 * it to `context + preservedTmpPath` so two same-kind failures that preserved
 * bytes at DIFFERENT recovery locations each keep their own toast (otherwise
 * the second's `updateToastText` replaced the first's path, hiding a recovery
 * location the user needs). Reports without a `coalesceKey` (the common case)
 * still coalesce by `context` exactly as before.
 *
 * Separated from the `App.svelte` wiring so the aggregation behaviour can be
 * unit-tested without mounting the component.
 */

import type { ReportedError } from './errorBus';

/**
 * A9-L10 — a `ReportedError` plus an optional coalescing-key override. Kept a
 * superset of `ReportedError` so the generic `onError(aggregator)` path (which
 * never sets `coalesceKey`) still type-checks against the `Handler` signature.
 */
export interface AggregatedReport extends ReportedError {
  /**
   * Overrides the Map key the report coalesces under. Defaults to `context`.
   * The DISPLAY prefix always remains `context`.
   */
  coalesceKey?: string;
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
  }): string;
  /**
   * Updates the text of an existing toast. Returns true if the toast was
   * found, false otherwise (e.g. the user dismissed it). On false, the
   * aggregator falls through and pushes a fresh toast.
   */
  updateToastText(id: string, text: string): boolean;
}

interface AggregatedToast {
  toastId: string;
  count: number;
  expiryTimer: ReturnType<typeof setTimeout>;
}

export interface ErrorToastAggregatorOptions {
  /** Silence window after which the next same-context error opens a fresh toast. */
  windowMs?: number;
}

export function createErrorToastAggregator(
  api: AggregatorToastApi,
  options: ErrorToastAggregatorOptions = {},
): (err: AggregatedReport) => void {
  const windowMs = options.windowMs ?? 1000;
  const recent = new Map<string, AggregatedToast>();

  return ({ context, message, error, coalesceKey }) => {
    // A9-L10 — coalesce by `coalesceKey` when supplied, else by `context`. The
    // display prefix below always stays `context`, so the count badge reads per
    // write KIND while distinct recovery locations keep separate toasts.
    const key = coalesceKey ?? context;
    const detail = message ?? (error instanceof Error ? error.message : String(error));
    const existing = recent.get(key);

    if (existing) {
      const updated = api.updateToastText(
        existing.toastId,
        `${context} (${existing.count + 1}×): ${detail}`,
      );
      if (updated) {
        existing.count++;
        clearTimeout(existing.expiryTimer);
        existing.expiryTimer = setTimeout(() => recent.delete(key), windowMs);
        return;
      }
      // Existing entry was dismissed by the user — fall through and push fresh.
      clearTimeout(existing.expiryTimer);
      recent.delete(key);
    }

    const toastId = api.pushToast({
      text: `${context}: ${detail}`,
      type: 'error',
      duration: 0,
      onDismiss: () => {
        const entry = recent.get(key);
        if (entry?.toastId === toastId) {
          clearTimeout(entry.expiryTimer);
          recent.delete(key);
        }
      },
    });
    const expiryTimer = setTimeout(() => recent.delete(key), windowMs);
    recent.set(key, { toastId, count: 1, expiryTimer });
  };
}

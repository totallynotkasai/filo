/**
 * Aggregates rapid-fire errorBus reports so a bulk failure (e.g. a tag-rename
 * sweep that fails 30 .md writes) coalesces into a single toast with a count
 * badge instead of N separate toasts.
 *
 * Keyed by `context`. Within `windowMs` of the last error for that context,
 * subsequent reports update the existing toast text via `updateToastText`. The
 * window resets on every fresh report — so a steady stream extends the same
 * toast indefinitely. After `windowMs` of silence the entry is dropped, and
 * the next error opens a brand new toast.
 *
 * Separated from the `App.svelte` wiring so the aggregation behaviour can be
 * unit-tested without mounting the component.
 */

import type { ReportedError } from './errorBus';

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
): (err: ReportedError) => void {
  const windowMs = options.windowMs ?? 1000;
  const recent = new Map<string, AggregatedToast>();

  return ({ context, message, error }) => {
    const detail = message ?? (error instanceof Error ? error.message : String(error));
    const existing = recent.get(context);

    if (existing) {
      const updated = api.updateToastText(
        existing.toastId,
        `${context} (${existing.count + 1}×): ${detail}`,
      );
      if (updated) {
        existing.count++;
        clearTimeout(existing.expiryTimer);
        existing.expiryTimer = setTimeout(() => recent.delete(context), windowMs);
        return;
      }
      // Existing entry was dismissed by the user — fall through and push fresh.
      clearTimeout(existing.expiryTimer);
      recent.delete(context);
    }

    const toastId = api.pushToast({
      text: `${context}: ${detail}`,
      type: 'error',
      duration: 0,
      onDismiss: () => {
        const entry = recent.get(context);
        if (entry?.toastId === toastId) {
          clearTimeout(entry.expiryTimer);
          recent.delete(context);
        }
      },
    });
    const expiryTimer = setTimeout(() => recent.delete(context), windowMs);
    recent.set(context, { toastId, count: 1, expiryTimer });
  };
}

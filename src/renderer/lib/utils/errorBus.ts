/**
 * errorBus — tiny pub/sub for unrecoverable renderer-side failures so
 * call sites can report once and the UI layer (Toast.svelte) can surface
 * them to the user. Filo is local-first / no-network, so this never
 * leaves the device — it's a console.error replacement with a UI hook,
 * not telemetry.
 *
 * Use `reportError(err, context)` at the throw / catch site instead of
 * a bare `console.error`. The Toast subscriber is wired in
 * `App.svelte`'s mount path so handlers fire even before the first
 * board loads.
 */

export interface ReportedError {
  /** Short label identifying the originating subsystem (e.g. "boardSaver", "vault"). */
  context: string;
  /** The thrown value — usually an Error, but may be anything from a Promise rejection. */
  error: unknown;
  /** Optional human-readable detail. Toast subscribers prefer this to `error.message`. */
  message?: string;
  /**
   * The file the report is about, when it is about one. Reports about
   * different files keep separate toasts, so one never replaces another's name.
   */
  path?: string;
}

type Handler = (err: ReportedError) => void;

const handlers = new Set<Handler>();

export function onError(handler: Handler): () => void {
  handlers.add(handler);
  return () => { handlers.delete(handler); };
}

export function reportError(
  context: string,
  error: unknown,
  message?: string,
  path?: string,
): void {
  // Preserve the console.error breadcrumb so the devtools call-stack
  // remains intact for triaging — the UI surface is additive, not a
  // replacement for the log.
  console.error(`[${context}]`, message ?? '', error);
  const payload: ReportedError = path === undefined ? { context, error, message } : { context, error, message, path };
  for (const handler of handlers) {
    try {
      handler(payload);
    } catch (handlerErr) {
      // A misbehaving subscriber must not break peer subscribers. Log
      // directly — calling reportError recursively would loop.
      console.error('[errorBus] handler threw:', handlerErr);
    }
  }
}

/** Test-only helper to drop every subscribed handler. */
export function __resetErrorBusForTests(): void {
  handlers.clear();
}

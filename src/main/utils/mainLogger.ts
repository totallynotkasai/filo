/**
 * Single-call-site logger for main-process errors so the renderer-side
 * `errorBus` pattern has a symmetric main-side breadcrumb without each
 * IPC handler emitting its own bare `console.error`.
 *
 * The main process has no access to the renderer's Toast UI, so the user
 * surface for main-side failures is the IPC return value (handlers send
 * `{ success: false, code, error }` back to the renderer, which routes
 * through `reportError` → toast aggregator). This helper covers the dev
 * triage side: a single console line per failure, prefixed with the
 * subsystem so the Electron main-process stdout stays scannable.
 *
 * Keep the surviving `console.error` strictly inside this helper —
 * bare `console.error` elsewhere in `src/main/` is a regression of the
 * Phase 7 audit-driven cleanup.
 */

/**
 * Logs a main-process error with a `[subsystem]` prefix. The `subsystem`
 * is typically the IPC channel name (e.g. `'vault:write-file-text'`) or a
 * service name (e.g. `'fileWatcher'`).
 */
export function logMainError(subsystem: string, err: unknown): void {
  console.error(`[${subsystem}]`, err);
}

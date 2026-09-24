/**
 * Main passes the OS regional-format locale (`app.getSystemLocale()`) to the
 * renderer as a `--filo-system-locale=<tag>` process argument; the preload
 * reads it back with `systemLocaleFromArgv` and exposes it on `window.filo`.
 * No IPC round trip: it is fixed for the window's lifetime.
 */
export const SYSTEM_LOCALE_ARG = '--filo-system-locale=';

/** A BCP 47-shaped tag only (letters, digits, `-`, `_`); anything else reads as ''. */
const LOCALE_TAG = /^[A-Za-z0-9_-]{1,35}$/;

export function systemLocaleFromArgv(argv: readonly string[]): string {
  const arg = argv.find((a) => a.startsWith(SYSTEM_LOCALE_ARG));
  const tag = arg ? arg.slice(SYSTEM_LOCALE_ARG.length) : '';
  return LOCALE_TAG.test(tag) ? tag : '';
}

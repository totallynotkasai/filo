import { iframeSrcProblem } from '../../../shared/untrusted';

/**
 * URL safety for embedded content, with a reason the tile can show.
 *
 * Iframe tiles accept user-supplied URLs and render them inside a sandboxed
 * `<iframe>`. Even with sandbox attributes, allowing schemes like `javascript:`
 * or `data:` would let a paste turn into script execution against the renderer
 * origin (or a phishing surface). The rule itself is `iframeSrcProblem` in
 * `shared/untrusted.ts`, which `asSafeIframeSrc` (the value actually bound
 * to the iframe) also uses.
 */

export interface UrlSafetyResult {
  ok: boolean;
  reason?: string;
}

/**
 * Validates a URL string for use as an iframe `src`.
 *
 * Returns `{ ok: true }` for `http(s)` URLs that parse successfully.
 * Returns `{ ok: false, reason }` for empty, malformed, or unsafe URLs.
 */
export function isSafeIframeUrl(url: unknown): UrlSafetyResult {
  const reason = iframeSrcProblem(url);
  return reason === null ? { ok: true } : { ok: false, reason };
}

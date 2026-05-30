/**
 * URL safety helpers for embedded content.
 *
 * Iframe tiles accept user-supplied URLs and render them inside a sandboxed
 * `<iframe>`. Even with sandbox attributes, allowing schemes like `javascript:`
 * or `data:` would let a paste turn into script execution against the renderer
 * origin (or a phishing surface). This module is the single source of truth
 * for which URLs are allowed in such an iframe.
 */

export interface UrlSafetyResult {
  ok: boolean;
  reason?: string;
}

const BLOCKED_SCHEMES = new Set([
  'javascript:',
  'data:',
  'vbscript:',
  'file:',
  'blob:',
]);

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

/**
 * Validates a URL string for use as an iframe `src`.
 *
 * Returns `{ ok: true }` for `http(s)` URLs that parse successfully.
 * Returns `{ ok: false, reason }` for empty, malformed, or unsafe URLs.
 */
export function isSafeIframeUrl(url: unknown): UrlSafetyResult {
  if (typeof url !== 'string') {
    return { ok: false, reason: 'URL must be a string' };
  }
  const trimmed = url.trim();
  if (!trimmed) {
    return { ok: false, reason: 'URL is empty' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'Malformed URL' };
  }

  const scheme = parsed.protocol.toLowerCase();

  if (BLOCKED_SCHEMES.has(scheme)) {
    return { ok: false, reason: `Scheme "${scheme}" is not allowed` };
  }

  if (!ALLOWED_SCHEMES.has(scheme)) {
    return { ok: false, reason: `Only http(s) URLs are allowed (got "${scheme}")` };
  }

  return { ok: true };
}

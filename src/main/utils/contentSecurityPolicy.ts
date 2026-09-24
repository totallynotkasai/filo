/**
 * Single source for the app-origin Content-Security-Policy that
 * `installContentSecurityPolicy` (main.ts) emits as an HTTP response header.
 *
 * Kept as a pure, side-effect-free builder so it can be unit-tested — main.ts
 * itself runs app-lifecycle side effects at import and can't be loaded in a
 * test. The only runtime-varying directive is `connect-src`: the dev-only Vite
 * HMR websocket (`ws://localhost:*`) is included in dev and DROPPED in packaged
 * builds. That mirrors the `filo-strip-dev-csp` Vite plugin
 * (electron.vite.config.mts) which strips the same token from the index.html
 * `<meta>` at build time, so a packaged build's header and `<meta>` agree.
 *
 * Keep this in sync with the index.html `<meta>` CSP — they govern overlapping
 * but distinct surfaces (the header also covers web workers / non-document
 * responses; the `<meta>` covers the initial document parse).
 */
export function buildAppContentSecurityPolicy(isPackaged: boolean): string {
  const connectSrc = isPackaged
    ? "connect-src 'self'"
    : "connect-src 'self' ws://localhost:*";
  return (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob: filo:; media-src 'self' blob: filo:; " +
    `font-src 'self' data:; ${connectSrc}; ` +
    'frame-src https:; child-src https:;'
  );
}

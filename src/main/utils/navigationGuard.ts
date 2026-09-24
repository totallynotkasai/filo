/**
 * navigationGuard — decides whether a `will-navigate` target is an in-app
 * navigation that should be allowed, vs. an external URL that must be
 * blocked.
 *
 * Defense-in-depth beyond the CSP. The renderer is a SPA that never
 * legitimately performs a top-level navigation to a different origin:
 * external links open via the `media:open-external` IPC (which
 * validates the URL), `filo://` media loads through the custom protocol,
 * and in-app routing is component state, not URL changes. So any
 * `will-navigate` to a different origin is either an accident or an attack
 * (e.g. an injected `<meta http-equiv="refresh">` or a script setting
 * `location.href`), and we `preventDefault` it.
 *
 * Pure + side-effect-free so it can be unit-tested without booting Electron.
 */

/**
 * Returns true when navigating to `targetUrl` should be allowed — i.e. it
 * stays within the app's own document.
 *
 *  - Dev (`http(s)://localhost:port`): allow same-origin. This keeps Vite
 *    HMR full-reloads (`location.reload()` → same origin) working.
 *  - Prod (`file://…/index.html`): `file:` URLs have an opaque ("null")
 *    origin, so an origin compare is useless. Compare the document path
 *    instead — only a navigation that resolves to the exact same packaged
 *    `index.html` is allowed.
 *
 * Any malformed URL (or one we can't classify) is treated as NOT in-app, so
 * the caller blocks it — fail closed.
 */
export function isAppNavigation(targetUrl: string, appUrl: string): boolean {
  let target: URL;
  let base: URL;
  try {
    target = new URL(targetUrl);
    base = new URL(appUrl);
  } catch {
    return false;
  }

  if (base.protocol === 'file:') {
    return target.protocol === 'file:' && target.pathname === base.pathname;
  }

  // http(s) dev server — same-origin navigations (including reloads) are fine.
  return target.origin === base.origin;
}

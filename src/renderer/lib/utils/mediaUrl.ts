import { stripLeadingSlash, toPosix, toVaultRelative } from './path';

/**
 * Converts a tile's `src` field into a URL that the renderer can load.
 *
 * Inputs:
 *   - empty / nullish              → returns ''
 *   - http / https / data: / blob: / filo:   → returned as-is
 *   - `file://...` URL             → decoded to its filesystem path, then
 *                                    vault-relativised. Returns '' (with a
 *                                    `console.warn`) if no vault root is
 *                                    provided or the path lies outside it.
 *   - bare absolute Windows path (e.g. `C:\…`) → same vault-relativisation
 *                                    rescue as `file://`. POSIX leading
 *                                    slashes are NOT treated as absolute —
 *                                    they're normalised away to preserve
 *                                    the legacy behaviour of vault-relative
 *                                    paths that accidentally start with `/`.
 *   - everything else is treated as a vault-relative path and wrapped in
 *     a `filo://media/...` URL with each path segment URL-encoded so spaces,
 *     `#`, and other reserved characters survive the trip.
 *
 * The `filo` protocol is registered in the main process
 * (`src/main/protocol/filoMedia.ts`) and streams the file from the active
 * vault back to the renderer with the correct `Content-Type`. This avoids
 * Chromium's `Not allowed to load local resource` block on bare `file://`
 * URLs while keeping everything inside the vault sandbox enforced by
 * `pathSecurity.assertWithinVault`.
 *
 * @param src       The tile's `src` field (vault-relative path or URL).
 * @param vaultRoot Optional absolute vault root. When supplied, `file://`
 *                  URLs and Windows-drive absolute paths are converted to
 *                  vault-relative; without it those inputs return ''
 *                  with a warn.
 */
export function toMediaUrl(src: string | undefined | null, vaultRoot?: string): string {
  if (!src) return '';
  if (
    src.startsWith('http://') ||
    src.startsWith('https://') ||
    src.startsWith('data:') ||
    src.startsWith('blob:') ||
    src.startsWith('filo://')
  ) {
    return src;
  }

  // `file://` URLs and bare Windows-drive paths are absolute by definition
  // and only resolve sensibly when we can rewrite them to be inside the
  // active vault. Anything that gets here is either a leak from a buggy
  // code path (Windows-drive in tile.src) or pre-protocol legacy content.
  const isFileUrl = src.startsWith('file://');
  const isWindowsAbsolute = /^[A-Za-z]:[/\\]/.test(src);

  if (isFileUrl || isWindowsAbsolute) {
    let candidate = src;
    if (isFileUrl) {
      try {
        const u = new URL(candidate);
        let p = decodeURIComponent(u.pathname);
        // `new URL('file:///C:/a/b').pathname` → `/C:/a/b`. Strip the leading
        // slash on Windows drive paths so the result is a normal absolute
        // path the vault-relativiser understands.
        if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
        candidate = p;
      } catch {
        console.warn('[toMediaUrl] could not parse file:// URL:', src);
        return '';
      }
    }
    if (!vaultRoot) {
      console.warn('[toMediaUrl] absolute path with no vault root context:', src);
      return '';
    }
    const rel = toVaultRelative(candidate, vaultRoot);
    if (!rel) {
      console.warn('[toMediaUrl] absolute path is outside the vault:', src);
      return '';
    }
    const normalised = stripLeadingSlash(toPosix(rel));
    return `filo://media/${normalised.split('/').map(encodeURIComponent).join('/')}`;
  }

  const normalised = stripLeadingSlash(toPosix(src));
  const encoded = normalised.split('/').map(encodeURIComponent).join('/');
  return `filo://media/${encoded}`;
}

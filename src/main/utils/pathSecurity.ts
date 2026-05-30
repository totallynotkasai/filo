import * as path from 'path';
import * as fs from 'fs';
import { toPosix } from './pathHelpers';

/**
 * Throws if targetPath resolves to a location outside vaultRoot. Protects
 * against path-traversal attacks from untrusted renderer input.
 *
 * On Windows, `path.resolve` normalises `..` segments but does NOT follow
 * symlinks or directory junctions — so a symlink inside the vault pointing
 * out (e.g. to C:\Windows\System32) would pass the prefix check. We harden
 * this by realpath-ing the deepest existing ancestor of the target and
 * re-checking the prefix on the realpath result.
 */
export function assertWithinVault(vaultRoot: string, targetPath: string): void {
  const resolvedRoot = path.resolve(vaultRoot);
  const resolvedTarget = path.resolve(targetPath);

  const isWindows = process.platform === 'win32';
  const rootCompare = isWindows ? resolvedRoot.toLowerCase() : resolvedRoot;
  const targetCompare = isWindows ? resolvedTarget.toLowerCase() : resolvedTarget;
  const sep = isWindows ? '\\' : path.sep;

  if (targetCompare !== rootCompare && !targetCompare.startsWith(rootCompare + sep)) {
    throw new Error(`Path traversal denied: target is outside vault`);
  }
  // Resolve symlinks/junctions for the deepest existing ancestor. If any
  // ancestor canonicalises out of the vault, the operation is unsafe.
  let probe = resolvedTarget;
  while (probe && probe !== path.dirname(probe)) {
    try {
      const real = fs.realpathSync.native
        ? fs.realpathSync.native(probe)
        : fs.realpathSync(probe);
      const realRoot = fs.realpathSync.native
        ? fs.realpathSync.native(resolvedRoot)
        : fs.realpathSync(resolvedRoot);

      const realCompare = isWindows ? real.toLowerCase() : real;
      const realRootCompare = isWindows ? realRoot.toLowerCase() : realRoot;

      if (realCompare !== realRootCompare && !realCompare.startsWith(realRootCompare + sep)) {
        throw new Error(`Path traversal denied: target resolves through a symlink outside vault`);
      }
      return;
    } catch (err) {
      // ENOENT: probe doesn't exist yet (creating a new file/dir). Walk up
      // one level and try again — the parent must exist and must canonicalise
      // inside the vault before we permit the create.
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') {
        probe = path.dirname(probe);
        continue;
      }
      // EACCES / EPERM: a real directory exists but we lack permission to
      // stat or canonicalise it (NTFS ACL, AV scanner lock, sandboxed
      // userprofile dir on Windows).
      //
      // Phase 31 A5.2 — instead of bypassing the symlink check, walk each
      // component from `probe` UP to the vault root and `lstat` it.
      // `lstat` doesn't follow symlinks and reports the entry type
      // directly; if any segment on the path-to-vault is a symlink we
      // refuse, since a symlink between probe and vault root could
      // resolve outside the vault even though the lexical prefix
      // matches. Pure lstat is cheaper than realpath and isn't blocked
      // by EACCES on a sibling directory the way realpath can be.
      if (code === 'EACCES' || code === 'EPERM') {
        // If the failing component IS the vault root, we can't even
        // canonicalise our own anchor — refuse the operation rather
        // than fall through to a half-protected accept.
        const probeCompare = isWindows ? probe.toLowerCase() : probe;
        if (probeCompare === resolvedRoot.toLowerCase() || probeCompare === resolvedRoot) {
          throw new Error(`Path traversal denied: vault root itself is unstatable (${code})`);
        }
        // Walk from probe up to (but not including) the vault root,
        // calling lstat on each component to confirm none is a symlink.
        // Any lstat failure here we treat as "can't prove safety, refuse"
        // — this is the more paranoid behaviour the audit asked for.
        let walker = probe;
        while (walker && walker !== resolvedRoot) {
          try {
            const stat = fs.lstatSync(walker);
            if (stat.isSymbolicLink()) {
              throw new Error(`Path traversal denied: ${walker} is a symbolic link inside vault`);
            }
          } catch (lstatErr) {
            const lcode = (lstatErr as NodeJS.ErrnoException)?.code;
            // ENOENT on this walk-up step is expected for path components
            // that haven't been created yet — continue walking.
            if (lcode === 'ENOENT') {
              walker = path.dirname(walker);
              continue;
            }
            // Any other failure (including the EACCES that brought us
            // here, applied to a different segment): refuse.
            throw new Error(`Path traversal denied: cannot verify ${walker} (${lcode ?? 'unknown'})`);
          }
          const parent = path.dirname(walker);
          if (parent === walker) break;
          walker = parent;
        }
        return;
      }
      throw err;
    }
  }
}

/**
 * Windows reserves these legacy DOS device names regardless of extension.
 * Creating `CON.md` or `LPT1.txt` succeeds on POSIX but on Windows opens a
 * device handle instead of a real file — the write either silently no-ops
 * (CON.txt → console) or hangs the IPC handler waiting for hardware. We
 * reject them up-front for cross-platform parity.
 */
const RESERVED_WINDOWS_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/**
 * Throws if fileName is unsafe to use as a bare filename inside the vault.
 * Rejects:
 *   - empty / non-string input
 *   - path separators or `..` segments (use a path joiner for those)
 *   - length > 255 (Windows MAX_PATH segment + POSIX NAME_MAX)
 *   - trailing dot or trailing space (silently stripped by Win32 → name collision)
 *   - control characters (\x00..\x1F, \x7F) including embedded NUL
 *   - Windows DOS device names (CON, PRN, AUX, NUL, COM1..9, LPT1..9) regardless
 *     of extension — see `RESERVED_WINDOWS_NAMES`
 */
export function assertSafeFilename(fileName: string): void {
  if (typeof fileName !== 'string' || fileName.length === 0) {
    throw new Error('Unsafe filename rejected — empty');
  }
  if (path.basename(fileName) !== fileName || fileName.includes('..')) {
    throw new Error('Unsafe filename rejected — contains path separators');
  }
  if (fileName.length > 255) {
    throw new Error('Unsafe filename rejected — exceeds 255 chars');
  }
  if (fileName.endsWith('.') || fileName.endsWith(' ')) {
    throw new Error('Unsafe filename rejected — trailing dot or space');
  }
  for (let i = 0; i < fileName.length; i++) {
    const code = fileName.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      throw new Error('Unsafe filename rejected — control character');
    }
  }
  // DOS device names are matched on the stem (everything before the first dot)
  // so `CON.md`, `con.txt`, even `aux.tar.gz` all reject.
  const stem = fileName.split('.')[0].toUpperCase();
  if (RESERVED_WINDOWS_NAMES.has(stem)) {
    throw new Error(`Unsafe filename rejected — Windows reserved name: ${stem}`);
  }
}

/**
 * Maximum number of path segments allowed in a vault-relative path. A
 * defence-in-depth bound on the depth of nesting the renderer can request —
 * 10 segments is comfortably deeper than any real-world vault structure but
 * tight enough to short-circuit pathological payloads.
 */
export const MAX_VAULT_PATH_DEPTH = 10;

/**
 * Validates a vault-relative path the renderer asked us to write to / read
 * from. Splits on `/` and `\`, drops empty segments (from leading slashes
 * etc.), then enforces:
 *
 *   1. Depth ≤ `MAX_VAULT_PATH_DEPTH` — a path the renderer should never need
 *      legitimately at depth >10. Bounds the parse surface for any subsequent
 *      callers.
 *   2. Each segment passes `assertSafeFilename` — no separators, no `..`,
 *      no embedded directory components. Catches mixed-encoding bypass
 *      attempts like `foo/..\..\..\evil`.
 *
 * Throws on any violation. `assertWithinVault` is still the primary
 * containment check; this helper is the structural sanity gate that runs
 * before path joining so a malformed input can't even reach `path.join`.
 */
export function assertSafeRelativePath(relativePath: string): void {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new Error('Relative path must be a non-empty string');
  }
  // D.10 — reject empty segments anywhere in the path. The previous
  // `[\\/]+.filter(Boolean)` shape silently collapsed `notes//Plan.md`
  // and `notes\\\\Plan.md` into `[notes, Plan.md]`, hiding what is
  // almost certainly a buggy caller (path-join with an empty piece) or
  // an attempt to confuse a downstream tokeniser. `assertWithinVault`
  // catches the worst outcomes already, but this explicit gate makes
  // malformed input a first-class failure with a clearer error.
  // Splitting on a SINGLE separator keeps empty segments visible so
  // we can flag them.
  const segments = relativePath.split(/[\\/]/);
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new Error('Relative path contains an empty segment (consecutive separators)');
    }
  }
  if (segments.length === 0) {
    throw new Error('Relative path has no usable segments');
  }
  if (segments.length > MAX_VAULT_PATH_DEPTH) {
    throw new Error(
      `Relative path exceeds depth limit (${segments.length} > ${MAX_VAULT_PATH_DEPTH})`,
    );
  }
  for (const segment of segments) {
    assertSafeFilename(segment);
  }
}

/**
 * Phase 1 / 1.2 — error class for `assertNotInFiloDir` rejections so the
 * IPC layer can return a stable `code: 'FORBIDDEN'` envelope instead of a
 * generic `IO_ERROR`. The renderer toast distinguishes "the OS refused
 * the write" (IO_ERROR) from "the generic channel won't accept this
 * path" (FORBIDDEN — caller's bug, not the user's).
 */
export class FiloDirForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FiloDirForbiddenError';
  }
}

/**
 * Vault-relative paths the renderer is permitted to read/write through
 * the generic `vault:*` channels even though they live under `.filo/`.
 *
 * Strictly the crash-recovery sentinels — every other `.filo/` file
 * (themes, configs, tags, templates, snippets) is owned by a dedicated
 * IPC channel that bypasses `assertNotInFiloDir` entirely.
 *
 * If you're adding a new `.filo/` file, prefer a dedicated channel over
 * widening this list. The narrower the allowlist, the smaller the
 * blast-radius for a buggy renderer accidentally clobbering `.filo/`
 * state through a stale generic-channel call.
 */
const RENDERER_PERMITTED_FILO_PATHS = new Set<string>([
  '.filo/.dirty',
  '.filo/rename-cascade-pending.json',
  '.filo/tag-rewrite-pending.json',
]);

/**
 * Phase 1 / 1.2 — rejects any vault-relative path whose first segment
 * normalises to `.filo`. Applied at the entry of every generic
 * `vault:write-file-text` / `vault:write-existing-file-text` / `vault:delete`
 * / `vault:rename` / `vault:copy-file` / `vault:create-folder` handler so
 * a buggy renderer can't end-run the dedicated `config:save` / `tags:save` /
 * `templates:write` / `theme:save` channels and clobber `.filo/` state with
 * arbitrary text.
 *
 * Empty / non-string inputs are tolerated — upstream callers
 * (`assertSafeRelativePath`, `assertWithinVault`) already reject those with
 * a more specific error. This helper is strictly the `.filo/` guard.
 *
 * Recognised sentinel paths in `RENDERER_PERMITTED_FILO_PATHS` are
 * allowed through.
 */
export function assertNotInFiloDir(relativePath: string): void {
  if (typeof relativePath !== 'string' || relativePath.length === 0) return;
  const segments = toPosix(relativePath).split('/').filter(Boolean);
  if (segments.length === 0) return;
  if (segments[0].toLowerCase() !== '.filo') return;
  const normalised = segments.join('/');
  if (RENDERER_PERMITTED_FILO_PATHS.has(normalised)) return;
  throw new FiloDirForbiddenError(
    `FORBIDDEN: generic vault channel cannot touch ${normalised} — use the dedicated config/tags/templates/theme/font channels`,
  );
}

/**
 * Returns true if the URL targets a private/loopback address (SSRF risk).
 * Unparseable input is rejected (returns true) on the conservative
 * assumption that an unknown target may be private — and logged so the
 * caller has a chance to diagnose malformed-link bugs.
 *
 * IPv6 hostnames come back from the URL parser bracket-wrapped
 * (`[::1]`, `[fc00::1]`, etc.). Strip the brackets before prefix matching
 * so loopback / ULA / link-local detection actually fires.
 */
/**
 * Phase 31 A5.3 — normalises a hostname so numeric IP encodings can't bypass
 * the private-IP regex. Accepts hex (`0x7f000001`), octal (`0177.0.0.1`),
 * and decimal-integer (`2130706433`) forms and rewrites them to dotted-quad.
 * Returns the input unchanged if it's not a numeric form. Best-effort; if
 * parsing throws we return the original so the regex still has a chance.
 */
export function normalizeNumericIPv4(hostname: string): string {
  // Pure decimal integer like `2130706433` (127.0.0.1).
  if (/^\d+$/.test(hostname)) {
    try {
      const n = BigInt(hostname);
      if (n >= 0n && n <= 0xffffffffn) {
        const num = Number(n);
        return [
          (num >>> 24) & 0xff,
          (num >>> 16) & 0xff,
          (num >>> 8) & 0xff,
          num & 0xff,
        ].join('.');
      }
    } catch { /* fall through */ }
  }
  // Hex / octal-prefixed dotted form like `0x7f.0.0.1`, `0177.0.0.1`.
  if (/^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+)){3}$/i.test(hostname)) {
    const parts = hostname.split('.').map((part) => {
      try {
        if (/^0x/i.test(part)) return parseInt(part, 16);
        if (part.startsWith('0') && part.length > 1) return parseInt(part, 8);
        return parseInt(part, 10);
      } catch { return NaN; }
    });
    if (parts.every((n) => Number.isFinite(n) && n >= 0 && n <= 255)) {
      return parts.join('.');
    }
  }
  return hostname;
}

export function isPrivateUrl(urlString: string): boolean {
  try {
    // D.1 — IPv4-mapped (`::ffff:1.2.3.4`) and IPv4-compatible
    // (`::1.2.3.4`) IPv6 forms embed a dotted-quad in the hostname.
    // Node's URL parser canonicalises `::ffff:10.0.0.1` to its
    // compressed hex form (`::ffff:a00:1`), so by the time we have a
    // parsed `hostname` the dotted-quad is gone. Inspect the raw URL
    // string FIRST for the literal mapped form and route the embedded
    // v4 through the same `isPrivateUrl` so the RFC-1918 / loopback /
    // link-local / CGNAT checks apply. Without this the previous
    // broad `/^::ffff:/i.test(ip6)` over-blocked legitimate public
    // addresses (`::ffff:8.8.8.8`) once the hostname-side regex
    // started matching the hex form.
    const rawMapped = /\[(?:::ffff:|::)(\d{1,3}(?:\.\d{1,3}){3})\]/i.exec(urlString);
    if (rawMapped) {
      return isPrivateUrl(`http://${rawMapped[1]}`);
    }

    const { hostname } = new URL(urlString);
    const ip6 = hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname;
    // Phase 31 A5.3 — normalise numeric encodings before regex tests.
    const normalised = normalizeNumericIPv4(hostname);
    return (
      hostname === 'localhost' ||
      hostname === '0.0.0.0' ||
      normalised === '0.0.0.0' ||
      /^127\./.test(normalised) ||
      /^10\./.test(normalised) ||
      /^192\.168\./.test(normalised) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(normalised) ||
      /^169\.254\./.test(normalised) ||
      // Phase 31 A5.3 — CGNAT range 100.64.0.0/10 (RFC 6598) and 0.0.0.0/8.
      /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(normalised) ||
      /^0\./.test(normalised) ||
      ip6 === '::1' ||
      ip6 === '::' ||
      /^fc00:/i.test(ip6) ||
      /^fd[0-9a-f]{2}:/i.test(ip6) || // fd00::/8 — the rest of the IPv6 ULA range
      /^fe80:/i.test(ip6)
    );
  } catch (err) {
    console.warn('[pathSecurity] isPrivateUrl: unparseable URL, treating as private', { urlString, err });
    return true;
  }
}

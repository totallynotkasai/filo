/**
 * `Untrusted<T>` / `Sanitised*` — branded string types that distinguish
 * "value read from the vault" from "value safe to pass to a security sink".
 *
 * The renderer routes three classes of vault-shipped string into security sinks that, without
 * sanitisation, can execute attacker-controlled code or leak info to
 * attacker-controlled hosts:
 *
 *   1. `<iframe src={tile.url}>` — `IframeTile.svelte`. A `.board.json`
 *      containing `tile.url = 'javascript:alert(1)'` would render an
 *      iframe whose `src` is the JS-pseudo URL.
 *   2. `root.style.setProperty(prop, value)` — `themeManager.ts`. A
 *      malicious `.filo/themes/foo.json` containing
 *      `value = 'red; background-image: url(https://evil.example/p)'`
 *      would inject an external-resource fetch via CSS — info-leak.
 *   3. `media:open-external` IPC — `media.ipc.ts`. A vault attachment named
 *      `report.html` opened in the user's browser executes whatever JS it
 *      carries from a trusted-origin frame.
 *
 * The three `asSafe*` validators below are the ONLY constructors for the
 * matching `Sanitised*` brand. The CI gate
 * `scripts/gates:untrusted-sinks` enforces that every sink
 * callsite passes its value through one of these validators (or is
 * annotated `// allow-untrusted-sink: <reason>` with explicit human review).
 *
 * `Untrusted<T>` is provided for downstream schema layers that want to
 * stamp parser output, but the validators below currently accept raw
 * `string` for ergonomics — the brand is asymmetric (output-side only)
 * because every renderer-side string flowing into a sink is by definition
 * untrusted, and forcing the brand at every callsite would mean stamping
 * dozens of vault reads that are not security-relevant.
 */

declare const _u: unique symbol;
declare const _sUrl: unique symbol;
declare const _sColor: unique symbol;
declare const _sSrc: unique symbol;

/**
 * Marker brand for "this string was read from vault contents and has not
 * been sanitised yet". Optional to apply; provided so schema layers that
 * want a compile-time reminder can stamp their output (e.g. `tile.url:
 * Untrusted<string>`).
 */
export type Untrusted<T> = T & { readonly [_u]: 'Untrusted' };

/** Output of `asSafeOpenExternal`. */
export type SanitisedUrl = string & { readonly [_sUrl]: 'SanitisedUrl' };

/** Output of `asSafeThemeValue`. */
export type SanitisedColor = string & { readonly [_sColor]: 'SanitisedColor' };

/** Output of `asSafeIframeSrc`. */
export type SanitisedSrc = string & { readonly [_sSrc]: 'SanitisedSrc' };

// ── iframe src ─────────────────────────────────────────────────────────

/**
 * Schemes that must NEVER reach an iframe `src`. `javascript:` and
 * `vbscript:` execute code; `data:` can carry HTML+JS with a script
 * payload; `file:` and `blob:` open the renderer to file-system reads.
 */
const IFRAME_BLOCKED_SCHEMES = new Set([
  'javascript:',
  'data:',
  'vbscript:',
  'file:',
  'blob:',
]);

/** Iframes only render http(s) — every other valid scheme is irrelevant. */
const IFRAME_ALLOWED_SCHEMES = new Set(['http:', 'https:']);

/**
 * Why `raw` can't be an `<iframe src>`, or `null` when it can. The one
 * iframe URL rule: `asSafeIframeSrc` and the tile's user-facing reason
 * (`isSafeIframeUrl`) both read it, so they can never disagree.
 */
export function iframeSrcProblem(raw: unknown): string | null {
  if (typeof raw !== 'string') return 'URL must be a string';
  const trimmed = raw.trim();
  if (!trimmed) return 'URL is empty';
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return 'Malformed URL';
  }
  const scheme = parsed.protocol.toLowerCase();
  if (IFRAME_BLOCKED_SCHEMES.has(scheme)) return `Scheme "${scheme}" is not allowed`;
  if (!IFRAME_ALLOWED_SCHEMES.has(scheme)) return `Only http(s) URLs are allowed (got "${scheme}")`;
  return null;
}

/**
 * Wraps a vault-shipped URL for use as an `<iframe src>`. Returns `null`
 * for empty / malformed / unsafe input. The sandboxed iframe in
 * `IframeTile.svelte` still applies `sandbox="allow-scripts allow-popups"`
 * as defence-in-depth — this validator is the first line.
 */
export function asSafeIframeSrc(raw: string | null | undefined): SanitisedSrc | null {
  if (iframeSrcProblem(raw) !== null) return null;
  return (raw as string).trim() as SanitisedSrc;
}

// ── theme CSS variable value ──────────────────────────────────────────

/**
 * CSS-injection patterns we refuse. `url(…)` would fetch external
 * resources; `expression(` is legacy IE-CSS-script; `image(` /
 * `image-set(` smuggle URLs. `;` is refused outright: a single CSS
 * custom-property value never legitimately contains one, and it's the
 * delimiter that would let a tampered value append a follow-up declaration.
 * `setProperty` and the `CSS.supports` gate below already stop that in the
 * renderer, but blocklisting `;` keeps the contract where `CSS.supports` is
 * absent (jsdom, main), where the substring list is the only defence.
 */
const THEME_VALUE_BLOCKED_SUBSTRINGS = [
  'url(',
  'expression(',
  'image(',
  'image-set(',
  '@import',
  'javascript:',
  'vbscript:',
  ';',
];

/**
 * Wraps a vault-shipped theme variable value for use with
 * `root.style.setProperty(<--var>, value)`. Returns `null` for input that
 * contains any of the CSS-injection patterns above or fails a basic
 * parsability check (`CSS.supports` where available, falling back to a
 * permissive accept).
 *
 * The matcher is intentionally substring-based (not regex) to catch
 * obfuscation like `url\( …` — any literal occurrence of `url(` in a
 * theme variable value is invalid regardless of surrounding whitespace
 * or comments.
 */
export function asSafeThemeValue(raw: string | null | undefined): SanitisedColor | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > 256) return null;
  const lower = trimmed.toLowerCase();
  for (const bad of THEME_VALUE_BLOCKED_SUBSTRINGS) {
    if (lower.includes(bad)) return null;
  }
  // CSS.supports is available in the renderer (DOM) but not in the main
  // process or jsdom. Reach for it through `globalThis` (typed, not the bare
  // identifier) so this shared module type-checks under BOTH the DOM lib
  // (renderer) and the no-DOM lib (main). When unavailable, the substring
  // blocklist + length cap are the load-bearing defence.
  const cssApi = (globalThis as { CSS?: { supports?: (cond: string) => boolean } }).CSS;
  if (cssApi && typeof cssApi.supports === 'function') {
    // `--probe` is a synthetic property name; CSS.supports returns true
    // for any value the engine considers parsable for a custom property.
    // Failing the check rejects values containing control chars,
    // unterminated tokens, etc.
    if (!cssApi.supports(`--probe: ${trimmed}`)) return null;
  }
  return trimmed as SanitisedColor;
}

// ── shell.openExternal ─────────────────────────────────────────────────

/**
 * URL schemes the OS shell may launch. `http(s)` for browsers, `mailto`
 * for mail clients, `tel` for diallers / SIP. Anything else (file:,
 * javascript:, data:, custom schemes) is rejected — the main-side
 * handler in `media.ipc.ts` re-checks this allowlist, so a renderer
 * bypass would still fail closed.
 *
 * INTENTIONAL asymmetry with main: `media.ipc.ts` (the authority) refuses
 * `http://` (cleartext downgrade / SSRF surface). This list deliberately
 * KEEPS `http://` so a legacy `http://` link reaches main, which returns a
 * clean "use https" error — instead of being mangled by the local-path branch
 * (where `http://example.com` would read `.com` as an executable extension).
 * Main fails it closed either way. Keep this asymmetry, don't "reconcile" it.
 */
const OPEN_EXTERNAL_ALLOWED_PREFIXES = ['https://', 'http://', 'mailto:', 'tel:'];

/**
 * Patterns that are NEVER allowed even if they slip past the prefix
 * test. Belt-and-braces with the main-side allowlist.
 */
const OPEN_EXTERNAL_BLOCKED_PATTERNS: ReadonlyArray<RegExp> = [
  /^file:/i,
  /^javascript:/i,
  /^data:/i,
  /^vbscript:/i,
  /^blob:/i,
  /^\\\\/, // Windows UNC
];

/**
 * The only local file types `shell.openPath` may launch: documents, images,
 * audio and video. An allowlist, because a blocklist can never be complete —
 * Windows Script Host alone runs `.js` / `.jse` / `.wsf` on double-click, and
 * new launcher types keep appearing.
 *
 * Deliberately excluded:
 *   - macro-enabled Office files (`.docm` / `.xlsm` / `.pptm`);
 *   - archives and disk images (`.zip` / `.iso` / `.vhd` …), which Explorer
 *     mounts or opens as folders;
 *   - anything HTML-renderable (`.html` / `.svg` / `.xml` / `.mht` …): the OS
 *     browser would run its JS against the local filesystem, without the
 *     `Content-Disposition: attachment` defence of the `filo://` protocol.
 *
 * The one list for both the renderer pre-check (`asSafeOpenExternal`) and the
 * main `media:open-external` handler, so the two can't drift apart.
 */
export const OPEN_PATH_ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set([
  // documents
  '.pdf', '.txt', '.md', '.markdown', '.rtf', '.csv', '.tsv',
  '.doc', '.docx', '.odt', '.xls', '.xlsx', '.ods', '.ppt', '.pptx', '.odp', '.epub',
  // images
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.heic', '.avif',
  // audio
  '.mp3', '.wav', '.ogg', '.oga', '.opus', '.m4a', '.aac', '.flac',
  // video
  '.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi',
]);

/** True when the OS may open this local path (see OPEN_PATH_ALLOWED_EXTENSIONS). */
export function isOpenPathAllowed(rawPath: string): boolean {
  return OPEN_PATH_ALLOWED_EXTENSIONS.has(launcherExtension(rawPath));
}

/**
 * Extract a file's launcher-relevant extension robustly,
 * defeating the Win32 / NTFS filename-normalisation tricks that
 * `path.extname` (and a naive `lastIndexOf('.')`) miss because the OS
 * shell launches a DIFFERENT byte-name than the one we inspected:
 *
 *   - `evil.exe.`         → Win32 strips the trailing dot, launching
 *                           `evil.exe`; `path.extname` sees `'.'`.
 *   - `evil.exe ` (space) → Win32 strips the trailing space → `evil.exe`.
 *   - `evil.exe::$DATA`   → NTFS Alternate-Data-Stream suffix; the real
 *                           file is `evil.exe`; `path.extname` sees
 *                           `'.exe::$DATA'`.
 *
 * Reading the wrong extension would check a different type from the one the
 * shell opens. We mirror what the shell actually
 * opens: take the basename, strip trailing dots/spaces, drop any
 * `:`-introduced ADS suffix, THEN read the final `.ext`. Pure string math
 * (identical on every platform), so it is the single source of truth for
 * both the renderer slice (`asSafeOpenExternal`) and the main-side
 * `media:open-external` handler.
 *
 * Returns the lowercased extension WITH its leading dot (`.exe`), or `''`
 * when the normalised basename has no extension — including a leading-dot
 * dotfile like `.gitignore` (no separator after the dot).
 */
export function launcherExtension(rawPath: string): string {
  const lastSlash = Math.max(rawPath.lastIndexOf('/'), rawPath.lastIndexOf('\\'));
  let base = lastSlash >= 0 ? rawPath.slice(lastSlash + 1) : rawPath;
  base = base.replace(/[ .]+$/, ''); // Win32 strips trailing dots/spaces
  const ads = base.indexOf(':'); // NTFS ADS suffix → real ext precedes it
  if (ads >= 0) base = base.slice(0, ads);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

/**
 * Wraps a vault-shipped URL or vault-relative path for use with
 * `media:open-external`. Returns `null` for input that fails the prefix
 * allowlist OR carries an unsafe local-file extension.
 *
 * URLs: the four allowed prefixes pass through; everything else is
 * rejected. The main-side handler additionally runs `isPrivateUrl` /
 * DNS-resolution checks to close SSRF — those live there because they
 * need the OS resolver.
 *
 * Local paths: extension is checked case-insensitively against
 * `OPEN_PATH_ALLOWED_EXTENSIONS`. Containment within the vault is
 * enforced main-side via `assertWithinVault`; the renderer can't see
 * the vault root unambiguously from here.
 */
export function asSafeOpenExternal(raw: string | null | undefined): SanitisedUrl | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  for (const pattern of OPEN_EXTERNAL_BLOCKED_PATTERNS) {
    if (pattern.test(trimmed)) return null;
  }

  const isAllowedUrl = OPEN_EXTERNAL_ALLOWED_PREFIXES.some((prefix) =>
    trimmed.toLowerCase().startsWith(prefix),
  );

  if (isAllowedUrl) {
    return trimmed as SanitisedUrl;
  }

  // Local path branch — only allowlisted document/media types. The robust
  // extractor stops `report.pdf.` / `evil.js::$DATA` reading as a different
  // extension from the one the shell launches (see launcherExtension).
  if (!isOpenPathAllowed(trimmed)) return null;

  return trimmed as SanitisedUrl;
}

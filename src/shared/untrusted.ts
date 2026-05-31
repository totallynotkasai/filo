/**
 * `Untrusted<T>` / `Sanitised*` — branded string types that distinguish
 * "value read from the vault" from "value safe to pass to a security sink".
 *
 * Phase 5 (IMPLEMENTATION_PLAN_2026-05-27 §Phase 5): the renderer routes
 * three classes of vault-shipped string into security sinks that, without
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
 * `scripts/check-untrusted-sink-discipline.mjs` enforces that every sink
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
 * Wraps a vault-shipped URL for use as an `<iframe src>`. Returns `null`
 * for empty / malformed / unsafe input. The sandboxed iframe in
 * `IframeTile.svelte` still applies `sandbox="allow-scripts allow-popups"`
 * as defence-in-depth — this validator is the first line.
 */
export function asSafeIframeSrc(raw: string | null | undefined): SanitisedSrc | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  const scheme = parsed.protocol.toLowerCase();
  if (IFRAME_BLOCKED_SCHEMES.has(scheme)) return null;
  if (!IFRAME_ALLOWED_SCHEMES.has(scheme)) return null;
  return trimmed as SanitisedSrc;
}

// ── theme CSS variable value ──────────────────────────────────────────

/**
 * CSS-injection patterns we refuse. `url(…)` would fetch external
 * resources; `expression(` is legacy IE-CSS-script; `image(` /
 * `image-set(` smuggle URLs. `;` is refused outright (6.2): a single CSS
 * custom-property value never legitimately contains one, and a `;` is the
 * delimiter that would let a tampered value append a follow-up declaration.
 * `setProperty` only ever writes one declaration so a `;` can't actually
 * break out there, and in the renderer the `CSS.supports` gate below
 * rejects a multi-declaration value anyway — but blocklisting `;` keeps the
 * sanitiser matching its contract in EVERY environment, including jsdom and
 * any host where `CSS.supports` is absent (where the substring list is the
 * only line of defence).
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
  // CSS.supports is available in the renderer but not in jsdom; gate
  // the call so unit tests keep working. When unavailable, the
  // substring blocklist + length cap are the load-bearing defence.
  if (typeof CSS !== 'undefined' && typeof CSS.supports === 'function') {
    // `--probe` is a synthetic property name; CSS.supports returns true
    // for any value the engine considers parsable for a custom property.
    // Failing the check rejects values containing control chars,
    // unterminated tokens, etc.
    if (!CSS.supports(`--probe: ${trimmed}`)) return null;
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
 * File extensions whose default OS handler executes attacker-controlled
 * content. Includes the existing executable / scripting set PLUS the
 * HTML-renderable extensions added by Phase 5 (`.html` and friends): a
 * vault attachment named `report.html` opened in the user's browser runs
 * whatever JS it carries from a trusted-origin frame and can exfiltrate
 * other vault contents via the same-origin policy.
 *
 * `.svg` is HTML-renderable too — the renderer's `filo://` protocol
 * sandbox uses `Content-Disposition: attachment + nosniff` to neutralise
 * it inside the app, but `shell.openPath('foo.svg')` hands it to the
 * user's browser without that header chain.
 */
const UNSAFE_LOCAL_FILE_EXTENSIONS = new Set([
  // OS executables / scripting
  '.exe', '.bat', '.cmd', '.com', '.scr', '.ps1', '.vbs', '.hta',
  '.msi', '.jar', '.lnk', '.appref-ms', '.app', '.bin', '.sh', '.msc',
  // HTML-renderable — Phase 5 / P1-10 addition
  '.html', '.htm', '.xhtml', '.svg', '.shtml', '.xml',
]);

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
 * Local paths: extension is checked case-insensitively against the
 * `UNSAFE_LOCAL_FILE_EXTENSIONS` set. Containment within the vault is
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

  // Local path branch — must not carry an unsafe extension. Extract the
  // final extension after the last `.` in the basename; case-insensitive.
  const lastSlash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  const basename = lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed;
  const dotIdx = basename.lastIndexOf('.');
  const ext = dotIdx > 0 ? basename.slice(dotIdx).toLowerCase() : '';
  if (UNSAFE_LOCAL_FILE_EXTENSIONS.has(ext)) return null;

  return trimmed as SanitisedUrl;
}

/**
 * Test-only re-export — the unsafe extension set is consumed by the
 * Phase 5 unit test to assert the HTML-renderable additions stay in
 * sync with `media.ipc.ts`'s server-side blocklist.
 */
export const UNSAFE_LOCAL_FILE_EXTENSIONS_FOR_TESTS = UNSAFE_LOCAL_FILE_EXTENSIONS;

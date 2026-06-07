/**
 * Phase 5 contract — untrusted-to-sink security boundaries.
 *
 * The original Phase 0 characterisation PINNED the surface that Phase 5
 * would later close. Phase 5 has landed:
 *
 *   - `src/shared/untrusted.ts` exports `asSafeIframeSrc` /
 *     `asSafeThemeValue` / `asSafeOpenExternal` and the matching
 *     `SanitisedSrc` / `SanitisedColor` / `SanitisedUrl` brands.
 *   - `<iframe src={tile.url}>` in IframeTile.svelte is routed through
 *     `asSafeIframeSrc` (via `safeSrc` derived + explicit annotation).
 *   - `root.style.setProperty(--var, value)` in themeManager.ts is gated
 *     by `applySafeThemeVar` which calls `asSafeThemeValue`.
 *   - `media:open-external` IPC handler extension blocklist now
 *     includes the HTML-renderable set (.html, .htm, .xhtml, .svg,
 *     .shtml, .xml) in addition to OS executables.
 *   - Every renderer `media:open-external` / `invokeOk(...)` call site
 *     routes its URL through `asSafeOpenExternal`.
 *   - `link:fetch-metadata` rejects non-http(s) schemes at entry.
 *
 * The CI gate `scripts/check-untrusted-sink-discipline.mjs` enforces the
 * contract at error level. These tests assert it from the inside as a
 * regression-resistance net — a regression here trips a friendlier
 * developer signal than a CI failure.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  asSafeIframeSrc,
  asSafeThemeValue,
  asSafeOpenExternal,
  UNSAFE_LOCAL_FILE_EXTENSIONS_FOR_TESTS,
} from '@shared/untrusted';

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const IFRAME_TILE = path.join(
  ROOT,
  'src',
  'renderer',
  'components',
  'tiles',
  'IframeTile.svelte',
);
const THEME_MANAGER = path.join(
  ROOT,
  'src',
  'renderer',
  'lib',
  'themes',
  'themeManager.ts',
);
const MEDIA_IPC = path.join(ROOT, 'src', 'main', 'ipc', 'media.ipc.ts');
const UNTRUSTED_HELPER = path.join(ROOT, 'src', 'shared', 'untrusted.ts');

const IFRAME_TILE_TEXT = fs.readFileSync(IFRAME_TILE, 'utf-8');
const THEME_MANAGER_TEXT = fs.readFileSync(THEME_MANAGER, 'utf-8');
const MEDIA_IPC_TEXT = fs.readFileSync(MEDIA_IPC, 'utf-8');

// ── Tests ──────────────────────────────────────────────────────────────

describe('Phase 5 contract — `src/shared/untrusted.ts` module is the canonical sink gateway', () => {
  it('exports the three validators', () => {
    expect(typeof asSafeIframeSrc).toBe('function');
    expect(typeof asSafeThemeValue).toBe('function');
    expect(typeof asSafeOpenExternal).toBe('function');
  });

  it('source file exists at src/shared/untrusted.ts', () => {
    expect(fs.existsSync(UNTRUSTED_HELPER)).toBe(true);
  });

  it('validators reject the three canonical malicious payloads', () => {
    expect(asSafeIframeSrc('javascript:alert(1)')).toBeNull();
    expect(asSafeThemeValue('red; background-image: url(https://evil.example/p)')).toBeNull();
    expect(asSafeOpenExternal('/vault/report.html')).toBeNull();
  });
});

describe('Phase 5 contract — IframeTile.svelte routes tile.url through asSafeIframeSrc', () => {
  it('imports asSafeIframeSrc from shared/untrusted', () => {
    expect(IFRAME_TILE_TEXT).toMatch(/asSafeIframeSrc/);
    expect(IFRAME_TILE_TEXT).toMatch(/shared\/untrusted/);
  });

  it('binds the iframe `src` to a sanitised value (safeSrc derived + annotation)', () => {
    // The actual binding is `src={safeSrc}` where `safeSrc` is a
    // `$derived(asSafeIframeSrc(tile.url))` block in <script>. The CI
    // gate `check-untrusted-sink-discipline.mjs` recognises this via an
    // `allow-untrusted-sink:` annotation immediately before the iframe
    // tag — without the annotation the CI gate would fail because the
    // derived call is too far from the iframe tag for its nearby-window
    // scan.
    expect(IFRAME_TILE_TEXT).toMatch(/\$derived\(asSafeIframeSrc\(/);
    expect(IFRAME_TILE_TEXT).toMatch(/allow-untrusted-sink:/);
  });
});

describe('Phase 5 contract — themeManager.ts routes setProperty through asSafeThemeValue', () => {
  it('imports asSafeThemeValue from shared/untrusted', () => {
    expect(THEME_MANAGER_TEXT).toMatch(/asSafeThemeValue/);
    expect(THEME_MANAGER_TEXT).toMatch(/shared\/untrusted/);
  });

  it('every setProperty call routes through applySafeThemeVar (not directly)', () => {
    // Outside of the helper, `root.style.setProperty(prop, ...)` MUST
    // NOT appear directly — every callsite must go through
    // `applySafeThemeVar` (which calls the validator).
    const setPropertyMatches = (
      THEME_MANAGER_TEXT.match(/\.style\.setProperty\(/g) ?? []
    ).length;
    const applySafeMatches = (
      THEME_MANAGER_TEXT.match(/applySafeThemeVar\(/g) ?? []
    ).length;
    // Exactly one direct setProperty (inside the helper). Anything
    // higher means a callsite has been added without going through
    // the helper.
    expect(setPropertyMatches).toBe(1);
    // At least two callsites — `applyBuiltinTheme` (systemOnly path)
    // and `applyCustomTheme`.
    expect(applySafeMatches).toBeGreaterThanOrEqual(2);
  });
});

describe('Phase 5 contract — media:open-external blocklist extended with HTML-renderable extensions', () => {
  it('main-side blocklist contains every HTML-renderable extension', () => {
    const HTML_RENDERABLE_EXTS = ['.html', '.htm', '.xhtml', '.svg', '.shtml', '.xml'];
    for (const ext of HTML_RENDERABLE_EXTS) {
      expect(MEDIA_IPC_TEXT).toContain(`'${ext}'`);
    }
  });

  it('main-side blocklist still contains every OS-executable extension', () => {
    const EXEC_EXTS = [
      '.exe', '.bat', '.cmd', '.com', '.scr', '.ps1', '.vbs', '.hta',
      '.msi', '.jar', '.lnk',
    ];
    for (const ext of EXEC_EXTS) {
      expect(MEDIA_IPC_TEXT).toContain(`'${ext}'`);
    }
  });

  it('main-side blocklist contains every OS launcher / shell-shortcut extension (Audit-13 M12)', () => {
    const LAUNCHER_EXTS = ['.url', '.scf', '.website', '.pif', '.reg', '.inf', '.desktop'];
    for (const ext of LAUNCHER_EXTS) {
      expect(MEDIA_IPC_TEXT).toContain(`'${ext}'`);
    }
  });

  it('renderer-side validator set matches main-side blocklist', () => {
    // Parity check — the two blocklists must agree so a renderer-side
    // pre-filter and the main-side defence-in-depth check don't drift.
    const HTML_RENDERABLE_EXTS = ['.html', '.htm', '.xhtml', '.svg', '.shtml', '.xml'];
    const LAUNCHER_EXTS = ['.url', '.scf', '.website', '.pif', '.reg', '.inf', '.desktop'];
    for (const ext of [...HTML_RENDERABLE_EXTS, ...LAUNCHER_EXTS]) {
      expect(UNSAFE_LOCAL_FILE_EXTENSIONS_FOR_TESTS.has(ext)).toBe(true);
    }
  });
});

describe('Phase 5 contract — every renderer media:open-external callsite is sanitised', () => {
  it('every callsite is bracketed by an asSafeOpenExternal call (or annotation)', () => {
    const RENDERER = path.join(ROOT, 'src', 'renderer');
    const offenders: string[] = [];
    function walk(dir: string): void {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && /\.(svelte|ts)$/.test(entry.name)) {
          const text = fs.readFileSync(full, 'utf-8');
          if (!text.includes("'media:open-external'")) continue;
          // The file calls the channel — verify the validator is
          // imported (a proxy for the per-callsite CI-gate check).
          // The CI gate itself enforces the call-site-level discipline;
          // this assertion is the friendlier developer signal.
          if (!text.includes('asSafeOpenExternal')) {
            offenders.push(
              path.relative(ROOT, full).replace(/\\/g, '/'),
            );
          }
        }
      }
    }
    walk(RENDERER);
    expect(
      offenders,
      `These files call 'media:open-external' but do not import asSafeOpenExternal:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});

describe('Phase 5 contract — link:fetch-metadata rejects non-http(s) schemes at entry', () => {
  it("entry-point scheme check is present", () => {
    expect(MEDIA_IPC_TEXT).toMatch(/Only http\(s\) URLs are allowed for link metadata/);
  });
});

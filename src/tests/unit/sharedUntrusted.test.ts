import { describe, it, expect } from 'vitest';
import {
  asSafeIframeSrc,
  asSafeThemeValue,
  asSafeOpenExternal,
  UNSAFE_LOCAL_FILE_EXTENSIONS_FOR_TESTS,
} from '@shared/untrusted';

/**
 * Phase 5 — branded `SanitisedUrl` / `SanitisedColor` / `SanitisedSrc`
 * newtypes + `asSafe*` validator constructors.
 *
 * The brands stop a raw vault-shipped string from reaching three sinks:
 *   1. `<iframe src={...}>`        — `asSafeIframeSrc`
 *   2. `root.style.setProperty(--var, value)` — `asSafeThemeValue`
 *   3. `shell.openExternal(...)`   — `asSafeOpenExternal`
 *
 * These tests exercise the validators directly. The CI gate
 * `scripts/check-untrusted-sink-discipline.mjs` enforces that the sinks
 * route through these validators (`error` level after Phase 5).
 */

describe('asSafeIframeSrc — iframe src allowlist', () => {
  it('accepts https URLs', () => {
    expect(asSafeIframeSrc('https://example.com/embed')).toBe(
      'https://example.com/embed',
    );
  });

  it('accepts http URLs (legacy embeds)', () => {
    expect(asSafeIframeSrc('http://example.com/embed')).toBe(
      'http://example.com/embed',
    );
  });

  it('rejects javascript: scheme', () => {
    expect(asSafeIframeSrc('javascript:alert(1)')).toBeNull();
  });

  it('rejects data: scheme', () => {
    expect(asSafeIframeSrc('data:text/html,<script>alert(1)</script>')).toBeNull();
  });

  it('rejects vbscript: scheme', () => {
    expect(asSafeIframeSrc('vbscript:msgbox("xss")')).toBeNull();
  });

  it('rejects file: scheme', () => {
    expect(asSafeIframeSrc('file:///etc/passwd')).toBeNull();
  });

  it('rejects blob: scheme', () => {
    expect(asSafeIframeSrc('blob:https://example.com/abc-123')).toBeNull();
  });

  it('rejects empty / nullish input', () => {
    expect(asSafeIframeSrc('')).toBeNull();
    expect(asSafeIframeSrc('   ')).toBeNull();
    expect(asSafeIframeSrc(null)).toBeNull();
    expect(asSafeIframeSrc(undefined)).toBeNull();
  });

  it('rejects malformed input', () => {
    expect(asSafeIframeSrc('not a url')).toBeNull();
    expect(asSafeIframeSrc('://no-scheme')).toBeNull();
  });

  it('rejects non-string input', () => {
    expect(asSafeIframeSrc(123 as unknown as string)).toBeNull();
    expect(asSafeIframeSrc({} as unknown as string)).toBeNull();
  });
});

describe('asSafeThemeValue — theme CSS variable value sanitiser', () => {
  it('accepts hex colours', () => {
    expect(asSafeThemeValue('#1a2b3c')).toBe('#1a2b3c');
    expect(asSafeThemeValue('#fff')).toBe('#fff');
  });

  it('accepts named colours', () => {
    expect(asSafeThemeValue('red')).toBe('red');
    expect(asSafeThemeValue('transparent')).toBe('transparent');
  });

  it('accepts rgb() / hsl() colours', () => {
    expect(asSafeThemeValue('rgb(255, 0, 0)')).toBe('rgb(255, 0, 0)');
    expect(asSafeThemeValue('rgba(0,0,0,0.5)')).toBe('rgba(0,0,0,0.5)');
    expect(asSafeThemeValue('hsl(0, 100%, 50%)')).toBe('hsl(0, 100%, 50%)');
  });

  it('accepts var() references', () => {
    // `var(--something)` is a legitimate theme-variable composition.
    expect(asSafeThemeValue('var(--accent-primary)')).toBe(
      'var(--accent-primary)',
    );
  });

  it('rejects url(...) — CSS-injection / info-leak', () => {
    expect(asSafeThemeValue('url(https://evil.example/p)')).toBeNull();
    // Substring match, so even nested forms are rejected.
    expect(asSafeThemeValue('red; background-image: url(https://x)')).toBeNull();
  });

  it('rejects expression(...) — legacy IE CSS expressions', () => {
    expect(asSafeThemeValue('expression(alert(1))')).toBeNull();
  });

  it('rejects image() / image-set()', () => {
    expect(asSafeThemeValue('image(https://x.png)')).toBeNull();
    expect(asSafeThemeValue('image-set(url(https://x.png) 1x)')).toBeNull();
  });

  it('rejects @import', () => {
    expect(asSafeThemeValue('@import url(https://evil/x.css)')).toBeNull();
  });

  it('rejects javascript: / vbscript: substrings', () => {
    expect(asSafeThemeValue('javascript:alert(1)')).toBeNull();
    expect(asSafeThemeValue('vbscript:msgbox')).toBeNull();
  });

  it('rejects empty / nullish input', () => {
    expect(asSafeThemeValue('')).toBeNull();
    expect(asSafeThemeValue('   ')).toBeNull();
    expect(asSafeThemeValue(null)).toBeNull();
    expect(asSafeThemeValue(undefined)).toBeNull();
  });

  it('rejects over-long input (DoS / parser-pin)', () => {
    expect(asSafeThemeValue('a'.repeat(257))).toBeNull();
  });

  it('rejects non-string input', () => {
    expect(asSafeThemeValue(123 as unknown as string)).toBeNull();
    expect(asSafeThemeValue({} as unknown as string)).toBeNull();
  });
});

describe('asSafeOpenExternal — shell.openExternal allowlist + unsafe-extension blocklist', () => {
  it('accepts https URLs', () => {
    expect(asSafeOpenExternal('https://example.com')).toBe('https://example.com');
  });

  it('accepts http URLs', () => {
    expect(asSafeOpenExternal('http://example.com')).toBe('http://example.com');
  });

  it('accepts mailto: URLs', () => {
    expect(asSafeOpenExternal('mailto:foo@example.com')).toBe(
      'mailto:foo@example.com',
    );
  });

  it('accepts tel: URLs', () => {
    expect(asSafeOpenExternal('tel:+15551234')).toBe('tel:+15551234');
  });

  it('rejects javascript: / data: / vbscript: / blob: / file:', () => {
    expect(asSafeOpenExternal('javascript:alert(1)')).toBeNull();
    expect(asSafeOpenExternal('data:text/html,evil')).toBeNull();
    expect(asSafeOpenExternal('vbscript:x')).toBeNull();
    expect(asSafeOpenExternal('blob:https://x/y')).toBeNull();
    expect(asSafeOpenExternal('file:///etc/passwd')).toBeNull();
  });

  it('rejects Windows UNC paths', () => {
    expect(asSafeOpenExternal('\\\\evil.example\\share\\foo')).toBeNull();
  });

  it('rejects empty / nullish input', () => {
    expect(asSafeOpenExternal('')).toBeNull();
    expect(asSafeOpenExternal('   ')).toBeNull();
    expect(asSafeOpenExternal(null)).toBeNull();
    expect(asSafeOpenExternal(undefined)).toBeNull();
  });

  describe('local path branch — extension blocklist', () => {
    it('rejects OS executables (.exe / .bat / .cmd / ...)', () => {
      const exts = [
        '.exe', '.bat', '.cmd', '.com', '.scr', '.ps1', '.vbs', '.hta',
        '.msi', '.jar', '.lnk', '.sh', '.msc',
      ];
      for (const ext of exts) {
        expect(asSafeOpenExternal(`/vault/notes/file${ext}`)).toBeNull();
        expect(asSafeOpenExternal(`C:\\vault\\notes\\file${ext}`)).toBeNull();
      }
    });

    it('rejects HTML-renderable extensions added by Phase 5', () => {
      // P1-10 — `.html` / `.htm` / `.xhtml` / `.svg` / `.shtml` / `.xml`
      // executes attacker-controlled JS from a trusted-origin browser frame.
      const exts = ['.html', '.htm', '.xhtml', '.svg', '.shtml', '.xml'];
      for (const ext of exts) {
        expect(asSafeOpenExternal(`/vault/notes/file${ext}`)).toBeNull();
      }
    });

    it('case-insensitive extension matching', () => {
      expect(asSafeOpenExternal('/vault/notes/EVIL.EXE')).toBeNull();
      expect(asSafeOpenExternal('/vault/notes/REPORT.Html')).toBeNull();
    });

    it("disguised double-extensions still fail (.pdf.exe → .exe wins)", () => {
      expect(asSafeOpenExternal('/vault/notes/report.pdf.exe')).toBeNull();
    });

    it('accepts ordinary file extensions', () => {
      expect(asSafeOpenExternal('/vault/notes/report.pdf')).toBe(
        '/vault/notes/report.pdf',
      );
      expect(asSafeOpenExternal('/vault/notes/photo.jpg')).toBe(
        '/vault/notes/photo.jpg',
      );
      expect(asSafeOpenExternal('/vault/notes/note.md')).toBe(
        '/vault/notes/note.md',
      );
    });

    it('accepts files without an extension', () => {
      expect(asSafeOpenExternal('/vault/notes/README')).toBe('/vault/notes/README');
    });

    it('accepts dotfiles without extension treatment', () => {
      // `.gitignore` has no separator after `.`, so the extension extraction
      // should treat the whole basename as having no extension (dotIdx <= 0).
      expect(asSafeOpenExternal('/vault/.gitignore')).toBe('/vault/.gitignore');
    });
  });
});

describe('UNSAFE_LOCAL_FILE_EXTENSIONS_FOR_TESTS — parity with main-side blocklist', () => {
  it('contains every HTML-renderable extension added by Phase 5', () => {
    // If main-side `media.ipc.ts:UNSAFE_FILE_EXTENSIONS` drops any of
    // these, the renderer-side validator would still reject them,
    // making the lists diverge. This assertion fixes the renderer side
    // as the canonical set the unit test pins.
    const required = ['.html', '.htm', '.xhtml', '.svg', '.shtml', '.xml'];
    for (const ext of required) {
      expect(UNSAFE_LOCAL_FILE_EXTENSIONS_FOR_TESTS.has(ext)).toBe(true);
    }
  });

  it('contains every executable extension already in the legacy blocklist', () => {
    const legacy = [
      '.exe', '.bat', '.cmd', '.com', '.scr', '.ps1', '.vbs', '.hta',
      '.msi', '.jar', '.lnk', '.sh', '.msc',
    ];
    for (const ext of legacy) {
      expect(UNSAFE_LOCAL_FILE_EXTENSIONS_FOR_TESTS.has(ext)).toBe(true);
    }
  });
});

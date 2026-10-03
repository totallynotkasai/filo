import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  asSafeIframeSrc,
  asSafeThemeValue,
  asSafeOpenExternal,
  launcherExtension,
  isOpenPathAllowed,
  OPEN_PATH_ALLOWED_EXTENSIONS,
} from '@shared/untrusted';
import fs from 'node:fs';
import path from 'node:path';

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
 * `scripts/gates:untrusted-sinks` enforces that the sinks
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

/**
 * `asSafeThemeValue` asks `CSS.supports` where there is one (the renderer, and
 * jsdom) and relies on its own checks where there is none (the main process).
 * Every case runs both ways. With `CSS.supports`, each expected answer is also
 * what Electron's Chromium gives, so jsdom answering otherwise fails here.
 */
const CSS_SUPPORTS_MODES = [
  { name: 'with CSS.supports', removed: false },
  { name: 'without CSS.supports', removed: true },
];

const ctl = (code: number): string => String.fromCharCode(code);

describe.each(CSS_SUPPORTS_MODES)('asSafeThemeValue — theme CSS variable value sanitiser ($name)', ({ removed }) => {
  beforeEach(() => {
    if (removed) vi.stubGlobal('CSS', undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('runs where CSS.supports is there exactly when the mode says', () => {
    const cssApi = (globalThis as { CSS?: { supports?: unknown } }).CSS;
    expect(typeof cssApi?.supports === 'function').toBe(!removed);
  });

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

  it('accepts sizes, shadows, font lists and calc()', () => {
    for (const value of ['12px', '1rem', '0 1px 2px rgba(0,0,0,0.2)', '"Arial Rounded MT Bold", sans-serif', 'calc(100% - 2px)']) {
      expect(asSafeThemeValue(value)).toBe(value);
    }
  });

  it('trims the value, a newline or tab at either end included', () => {
    expect(asSafeThemeValue('  red  ')).toBe('red');
    expect(asSafeThemeValue(`${ctl(0x0a)}#fff${ctl(0x09)}`)).toBe('#fff');
  });

  it('refuses a control character inside the value: newline, tab, DEL and the rest', () => {
    // Chromium's CSS.supports accepts every one of these, so the check is
    // Filo's own.
    for (const code of [0x00, 0x01, 0x09, 0x0a, 0x0d, 0x1b, 0x1f, 0x7f, 0x85, 0x9f]) {
      expect(asSafeThemeValue(`red${ctl(code)}blue`)).toBeNull();
    }
  });

  it('refuses what no declaration can hold only where CSS.supports is there to say so', () => {
    for (const value of ['a)', '{x', '!']) {
      expect(asSafeThemeValue(value)).toBe(removed ? value : null);
    }
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

  it('rejects a bare `;` even without url()/@import (6.2 — defends the single-declaration contract)', () => {
    // No url()/@import/expression/image — the ONLY suspect token is the
    // `;`. In the renderer the `CSS.supports('--probe: …')` gate rejects
    // a multi-declaration value, but where `CSS.supports` is absent (the main
    // process) the substring blocklist is the sole line of defence — so `;`
    // must be on it. A single CSS custom-property value never legitimately
    // contains `;`.
    expect(asSafeThemeValue('red; color: blue')).toBeNull();
    expect(asSafeThemeValue('#fff;')).toBeNull();
    expect(asSafeThemeValue('1rem ;')).toBeNull();
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

  describe('local path branch — extension allowlist', () => {
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

    it('rejects OS launcher / shell-shortcut extensions added by Audit-13 M12', () => {
      // `.url` / `.scf` / `.website` can point at a UNC share and leak NetNTLM
      // creds; `.reg` / `.inf` import/run on activation; `.pif` executes;
      // `.desktop` runs its `Exec=` line on Linux.
      const exts = ['.url', '.scf', '.website', '.pif', '.reg', '.inf', '.desktop'];
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

    it('Audit-10 B3 — Win32 trailing-dot / trailing-space / NTFS-ADS bypasses are blocked', () => {
      // `path.extname` reads these as `.` / `.exe ` / `.exe::$DATA` — none in
      // the blocklist — but the OS shell strips the trailing dot/space and
      // resolves the ADS suffix, launching `evil.exe`. `launcherExtension`
      // sees the true `.exe`, so the validator now rejects them.
      expect(asSafeOpenExternal('/vault/notes/evil.exe.')).toBeNull();
      expect(asSafeOpenExternal('/vault/notes/evil.exe ')).toBeNull();
      expect(asSafeOpenExternal('/vault/notes/evil.exe::$DATA')).toBeNull();
      // HTML-renderable variants of the same trick.
      expect(asSafeOpenExternal('/vault/notes/page.html.')).toBeNull();
      expect(asSafeOpenExternal('/vault/notes/page.svg::$DATA')).toBeNull();
      // Backslash separators (Windows-style absolute path) take the same path.
      expect(asSafeOpenExternal('C:\\vault\\notes\\evil.exe.')).toBeNull();
      expect(asSafeOpenExternal('C:\\vault\\notes\\evil.exe::$DATA')).toBeNull();
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

    it('rejects files without an extension (not on the open-path allowlist)', () => {
      expect(asSafeOpenExternal('/vault/notes/README')).toBeNull();
    });

    it('rejects dotfiles: `.gitignore` has no extension, so it is not allowlisted', () => {
      expect(asSafeOpenExternal('/vault/.gitignore')).toBeNull();
    });
  });
});

describe('launcherExtension — robust Win32/NTFS extension extraction (Audit-10 B3)', () => {
  it('reads the plain final extension, lowercased', () => {
    expect(launcherExtension('/vault/notes/report.pdf')).toBe('.pdf');
    expect(launcherExtension('C:\\vault\\notes\\REPORT.PDF')).toBe('.pdf');
    expect(launcherExtension('photo.JPG')).toBe('.jpg');
  });

  it('strips Win32 trailing dots and spaces before reading the extension', () => {
    expect(launcherExtension('evil.exe.')).toBe('.exe');
    expect(launcherExtension('evil.exe ')).toBe('.exe');
    expect(launcherExtension('evil.exe...  ')).toBe('.exe');
  });

  it('drops an NTFS Alternate-Data-Stream suffix before reading the extension', () => {
    expect(launcherExtension('evil.exe::$DATA')).toBe('.exe');
    expect(launcherExtension('evil.exe:hidden')).toBe('.exe');
    // The ADS suffix can disguise a safe-looking extension — the real
    // launch extension is what precedes the `:`.
    expect(launcherExtension('report.pdf:evil')).toBe('.pdf');
  });

  it('takes the last extension of a double-extension name', () => {
    expect(launcherExtension('report.pdf.exe')).toBe('.exe');
    expect(launcherExtension('report.pdf.exe.')).toBe('.exe');
  });

  it('returns empty for no-extension names and leading-dot dotfiles', () => {
    expect(launcherExtension('/vault/README')).toBe('');
    expect(launcherExtension('.gitignore')).toBe('');
    expect(launcherExtension('/vault/.env')).toBe('');
  });

  it('isolates the basename (a dot in a parent directory is not an extension)', () => {
    expect(launcherExtension('/vault/v1.2/notes/README')).toBe('');
    expect(launcherExtension('C:\\my.files\\report')).toBe('');
  });
});

describe('OPEN_PATH_ALLOWED_EXTENSIONS — only documents and media reach shell.openPath', () => {
  it('every extension of the former blocklist is NOT allowed', () => {
    const FORMER_BLOCKLIST = [
      '.exe', '.bat', '.cmd', '.com', '.scr', '.ps1', '.vbs', '.hta',
      '.msi', '.jar', '.lnk', '.appref-ms', '.app', '.bin', '.sh', '.msc',
      '.html', '.htm', '.xhtml', '.svg', '.shtml', '.xml',
      '.url', '.scf', '.website', '.pif', '.reg', '.inf', '.desktop',
    ];
    expect(FORMER_BLOCKLIST).toHaveLength(29);
    for (const ext of FORMER_BLOCKLIST) {
      expect(isOpenPathAllowed(`C:\\vault\\file${ext}`)).toBe(false);
    }
  });

  it('script, macro, archive and disk-image types the blocklist missed are NOT allowed', () => {
    const MISSED = [
      'js', 'jse', 'wsf', 'wsh', 'vbe', 'cpl', 'msp', 'psm1', 'chm', 'mht', 'mhtml',
      'iso', 'img', 'vhd', 'vhdx', 'docm', 'xlsm', 'pptm', 'zip', '7z', 'rar',
      'appx', 'appxbundle', 'msix', 'settingcontent-ms', 'library-ms',
    ];
    for (const ext of MISSED) {
      expect(isOpenPathAllowed(`/vault/readme.${ext}`)).toBe(false);
      expect(asSafeOpenExternal(`/vault/readme.${ext}`)).toBeNull();
    }
  });

  it('common document and media types ARE allowed', () => {
    for (const name of [
      'report.pdf', 'notes.md', 'Budget.XLSX', 'deck.pptx', 'letter.docx', 'data.csv',
      'photo.JPG', 'scan.tiff', 'clip.mp4', 'song.mp3', 'memo.m4a', 'book.epub',
    ]) {
      expect(isOpenPathAllowed(`/vault/${name}`)).toBe(true);
      expect(asSafeOpenExternal(`/vault/${name}`)).not.toBeNull();
    }
    expect(OPEN_PATH_ALLOWED_EXTENSIONS.has('.pdf')).toBe(true);
  });

  it('trailing-dot / ADS forms resolve to the launched extension', () => {
    expect(isOpenPathAllowed('/vault/report.pdf.')).toBe(true);
    expect(isOpenPathAllowed('/vault/report.pdf:evil')).toBe(true);
    expect(isOpenPathAllowed('/vault/evil.js.')).toBe(false);
    expect(isOpenPathAllowed('/vault/evil.js::$DATA')).toBe(false);
    expect(isOpenPathAllowed('/vault/report.pdf.js')).toBe(false);
  });

  it('an unknown extension, no extension, or a dotfile is NOT allowed', () => {
    expect(isOpenPathAllowed('/vault/thing.xyz')).toBe(false);
    expect(isOpenPathAllowed('/vault/README')).toBe(false);
    expect(isOpenPathAllowed('/vault/.gitignore')).toBe(false);
  });

  it('media.ipc.ts uses the shared allowlist and keeps no extension set of its own', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'main', 'ipc', 'media.ipc.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/new Set\(\[\s*(?:\/\/[^\n]*\n\s*)*'\.[a-z0-9]+'/);
    const allowIdx = src.indexOf('isOpenPathAllowed(');
    const openIdx = src.indexOf('shell.openPath(');
    expect(allowIdx).toBeGreaterThan(-1);
    expect(openIdx).toBeGreaterThan(allowIdx);
  });
});

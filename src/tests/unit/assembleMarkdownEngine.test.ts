import { describe, it, expect, vi } from 'vitest';
import yaml from 'js-yaml';
import { assembleMarkdownFile } from '@renderer/lib/editor/markdownSync';

/**
 * A dirty frontmatter re-serialise (a metadata edit) now patches the
 * disk-baseline source via the `yaml` Document engine instead of dumping the
 * whole object, so comments / key order on untouched keys survive (the fix for
 * the lossy YAML round-trip, KNOWN_LIMITATION #1). New files with no baseline
 * still take the full dump.
 */
function fmOf(md: string): string {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(md);
  return m ? m[1] : '';
}

describe('assembleMarkdownFile — source-preserving dirty path', () => {
  it('preserves a comment + key order when a metadata value changes', () => {
    const original = ['# project notes', 'title: My Note', 'priority: low'].join('\n');
    const out = assembleMarkdownFile(
      { title: 'My Note', priority: 'high' },
      'Body text.\n',
      { originalFrontmatter: original, frontmatterDirty: true },
    );
    // comment survived, value updated, body untouched
    expect(out).toContain('# project notes');
    expect(out).toMatch(/priority: high/);
    expect(out.endsWith('Body text.\n')).toBe(true);
    expect(yaml.load(fmOf(out))).toEqual({ title: 'My Note', priority: 'high' });
    // key order preserved (title before priority)
    expect(fmOf(out).indexOf('title:')).toBeLessThan(fmOf(out).indexOf('priority:'));
  });

  it('adds and removes keys against the baseline, keeping the rest', () => {
    const original = ['# keep', 'title: T', 'draft: true'].join('\n');
    const out = assembleMarkdownFile(
      { title: 'T', tags: ['x', 'y'] },
      'Body\n',
      { originalFrontmatter: original, frontmatterDirty: true },
    );
    expect(out).toContain('# keep');
    const parsed = yaml.load(fmOf(out)) as Record<string, unknown>;
    expect(parsed.title).toBe('T');
    expect(parsed.tags).toEqual(['x', 'y']);
    expect('draft' in parsed).toBe(false);
  });

  it('falls back to a dump for a new file with no baseline source', () => {
    const out = assembleMarkdownFile({ title: 'New' }, 'Body\n', { frontmatterDirty: true });
    expect(fmOf(out)).toContain('title: New');
    expect(yaml.load(fmOf(out))).toEqual({ title: 'New' });
  });

  it('falls back to a dump when the baseline is a flow mapping', () => {
    // Not a block mapping → engine returns null → dump path, which keeps every
    // key because a mapping's keys are all in the object.
    const out = assembleMarkdownFile(
      { a: 1, title: 'X' },
      'Body\n',
      { originalFrontmatter: '{a: 1}', frontmatterDirty: true },
    );
    expect(yaml.load(fmOf(out))).toEqual({ a: 1, title: 'X' });
  });
});

/**
 * A present-but-empty key on disk (`aliases:`) parses to `null`. The
 * assembler's clean pass dropped it, so the CST engine then saw it as DELETED
 * and spliced the line out — silently erasing the key on any unrelated metadata
 * edit. The fix preserves a null/undefined value when its key is present in the
 * disk baseline.
 */
describe('assembleMarkdownFile — present-but-empty disk key survives', () => {
  it('keeps a baseline empty key (aliases:) when another field changes', () => {
    const original = 'aliases:\ntitle: My Note';
    const out = assembleMarkdownFile(
      { aliases: null, title: 'My Note', priority: 'high' },
      'Body\n',
      { originalFrontmatter: original, frontmatterDirty: true },
    );
    // The empty-key line is byte-preserved, the new field is added, body intact.
    expect(fmOf(out)).toMatch(/^aliases:\s*$/m);
    expect(out).toMatch(/title: My Note/);
    expect(out).toMatch(/priority: high/);
    expect(out.endsWith('Body\n')).toBe(true);
  });

  it('does NOT introduce a bare null key that was never on disk', () => {
    const out = assembleMarkdownFile(
      { title: 'T', ghost: null },
      'Body\n',
      { originalFrontmatter: 'title: T', frontmatterDirty: true },
    );
    expect(fmOf(out)).not.toMatch(/ghost/);
    expect(yaml.load(fmOf(out))).toEqual({ title: 'T' });
  });
});

/**
 * When the on-disk frontmatter is genuinely UNPARSEABLE (tabs, duplicate keys),
 * the engine returns null and the old code dumped just the new key over the
 * block, destroying it. The fix keeps the raw block verbatim (refusing the
 * metadata edit) for a true parse failure, while a valid-but-non-mapping
 * baseline keeps the long-standing dump fallback.
 */
describe('assembleMarkdownFile — unparseable frontmatter is preserved, not dumped over', () => {
  it('keeps a malformed (tab + duplicate-key) block instead of replacing it', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const original = '\tbad: yaml\n  dup: 1\n  dup: 2';
    const out = assembleMarkdownFile(
      { priority: 'high' },
      'Body\n',
      { originalFrontmatter: original, frontmatterDirty: true },
    );
    // The broken-but-present block survives verbatim; the edit is refused.
    expect(out).toContain('\tbad: yaml');
    expect(out).toContain('dup: 1');
    expect(out).toContain('dup: 2');
    expect(fmOf(out)).not.toMatch(/^priority: high$/m);
    expect(out.endsWith('Body\n')).toBe(true);
    // The refuse path (not the dump) was taken and surfaced a dev breadcrumb.
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  // A block that parses but isn't a mapping holds text no key carries: a dump
  // of the delta would delete it. Kept verbatim, edit refused, reason given.
  it.each([
    ['a paragraph between two leading --- rules (scalar root)', 'Just a paragraph of text'],
    ['a sequence root', '- a\n- b'],
  ])('keeps %s verbatim and refuses the edit', (_label, original) => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onFrontmatterRefused = vi.fn();
    const out = assembleMarkdownFile(
      { title: 'X' },
      'Body\n',
      { originalFrontmatter: original, rawFrontmatter: original, frontmatterDirty: true, onFrontmatterRefused },
    );
    expect(out).toBe(`---\n${original}\n---\nBody\n`);
    expect(onFrontmatterRefused).toHaveBeenCalledWith('not-properties');
    warnSpy.mockRestore();
  });

  it('an empty root with only a comment keeps the comment and takes the key', () => {
    const onFrontmatterRefused = vi.fn();
    const out = assembleMarkdownFile(
      { title: 'X' },
      'Body\n',
      { originalFrontmatter: '# a note to self', frontmatterDirty: true, onFrontmatterRefused },
    );
    expect(out).toBe('---\n# a note to self\ntitle: X\n---\nBody\n');
    expect(onFrontmatterRefused).not.toHaveBeenCalled();
  });

  it('a flow-mapping root still takes the dump (every key is in the object)', () => {
    const onFrontmatterRefused = vi.fn();
    const out = assembleMarkdownFile(
      { title: 'X', a: 1 },
      'Body\n',
      { originalFrontmatter: '{a: 1}', frontmatterDirty: true, onFrontmatterRefused },
    );
    expect(yaml.load(fmOf(out))).toEqual({ title: 'X', a: 1 });
    expect(onFrontmatterRefused).not.toHaveBeenCalled();
  });

  it('invokes onFrontmatterRefused when the edit is dropped over unparseable YAML', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onFrontmatterRefused = vi.fn();
    const original = '\tbad: yaml\n  dup: 1\n  dup: 2';
    const out = assembleMarkdownFile(
      { priority: 'high' },
      'Body\n',
      { originalFrontmatter: original, frontmatterDirty: true, onFrontmatterRefused },
    );
    // The refusal path fired (raw block kept, edit dropped) AND the caller hook
    // ran so the gateway can surface a "fix the YAML" toast instead of a silent
    // success.
    expect(onFrontmatterRefused).toHaveBeenCalledTimes(1);
    expect(out).toContain('\tbad: yaml');
    expect(fmOf(out)).not.toMatch(/^priority: high$/m);
    warnSpy.mockRestore();
  });

  it('does NOT invoke onFrontmatterRefused when the YAML is parseable', () => {
    const onFrontmatterRefused = vi.fn();
    const out = assembleMarkdownFile(
      { priority: 'high' },
      'Body\n',
      { originalFrontmatter: 'title: Note', frontmatterDirty: true, onFrontmatterRefused },
    );
    // A normal source-preserving edit applies the change; the hook stays quiet.
    expect(onFrontmatterRefused).not.toHaveBeenCalled();
    expect(fmOf(out)).toMatch(/priority: high/);
  });
});

/**
 * Frontmatter carrying an UNRESOLVED alias parses with `errors.length === 0`
 * (so the CST engine's refusal gate passes) but THROWS a ReferenceError in
 * `doc.toJS()` while resolving the dangling reference. Before the fix that
 * throw escaped `patchFrontmatterSourceCst` → `assembleMarkdownFile` → the
 * write, so the keep-raw safety net never engaged and the metadata write
 * crashed (or, with only a half-fix, a full dump erased the poison block the
 * read returned `{}` for). The fix makes BOTH the engine (`toJS()` wrapped →
 * `null`) and `frontmatterSourceParses` (`toJS()` forced → `false`) fail
 * closed, so a metadata edit over alias-poison FM keeps the user's exact bytes
 * verbatim, drops only the edit, and surfaces it loudly via
 * `onFrontmatterRefused` — never throws, never corrupts.
 */
describe('assembleMarkdownFile — unresolved-alias frontmatter keeps raw bytes', () => {
  const POISON: ReadonlyArray<{ label: string; original: string }> = [
    { label: 'forward-ref alias', original: 'title: X\ntags: *missing' },
    { label: 'missing-anchor << merge', original: 'widget:\n  <<: *gone\ntitle: X' },
    { label: 'alias-in-sequence', original: 'list:\n  - *nope\ntitle: X' },
  ];

  for (const { label, original } of POISON) {
    it(`keeps the raw block and drops the edit on: ${label}`, () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const onFrontmatterRefused = vi.fn();
      // The edit (priority: high) is what the user changed; it must be dropped,
      // and the poison block preserved byte-for-byte. The call must NOT throw.
      const out = assembleMarkdownFile(
        { title: 'X', priority: 'high' },
        'Body text.\n',
        { originalFrontmatter: original, frontmatterDirty: true, onFrontmatterRefused },
      );
      // Raw bytes survive verbatim, the metadata edit is refused, body intact.
      expect(fmOf(out)).toBe(original);
      expect(fmOf(out)).not.toMatch(/priority: high/);
      expect(out.endsWith('Body text.\n')).toBe(true);
      // Loud failure: the gateway wires this hook to a "fix the YAML" toast.
      expect(onFrontmatterRefused).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  }

  it('a RESOLVABLE alias baseline is NOT refused (no over-refusal — control)', () => {
    // `*x` resolves (anchor defined first), so toJS() does not throw and
    // `frontmatterSourceParses` stays true — a normal edit (adding `title`)
    // applies through the engine rather than tripping the keep-raw refusal.
    const onFrontmatterRefused = vi.fn();
    const out = assembleMarkdownFile(
      { common: ['a'], tags: ['a'], title: 'New' },
      'Body\n',
      { originalFrontmatter: 'common: &x\n  - a\ntags: *x', frontmatterDirty: true, onFrontmatterRefused },
    );
    expect(onFrontmatterRefused).not.toHaveBeenCalled();
    expect(yaml.load(fmOf(out))).toMatchObject({ title: 'New' });
  });
});

/**
 * When the live frontmatter object is empty (the user cleared every key) but
 * the source HAD a block, the old safety net re-emitted the original bytes
 * verbatim — silently reverting the deletion. It couldn't tell "couldn't parse"
 * (keep raw — data-loss avoidance) from "user emptied it" (honour the clear).
 * The fix splits the two on `frontmatterSourceParses`: an unparseable block is
 * still kept; a parseable-but-emptied one routes through the CST engine (drops
 * the keys, keeps any standalone comment).
 */
describe('assembleMarkdownFile — empty-FM split: clear vs unparseable', () => {
  it('honours a cleared single-key block (emits no FM block, not the original)', () => {
    const out = assembleMarkdownFile({}, 'Body\n', {
      rawFrontmatter: 'title: Foo',
      frontmatterDirty: true,
    });
    // The key is gone — NOT reverted to the original block.
    expect(out).not.toContain('title: Foo');
    expect(out).toBe('Body\n');
  });

  it('honours a cleared multi-key block', () => {
    const out = assembleMarkdownFile({}, 'Body\n', {
      rawFrontmatter: 'title: Foo\npriority: low',
      frontmatterDirty: true,
    });
    expect(out).toBe('Body\n');
  });

  it('keeps a standalone comment when the keys are cleared (comment-only block)', () => {
    const out = assembleMarkdownFile({}, 'Body\n', {
      rawFrontmatter: '# kept note\ntitle: Foo',
      frontmatterDirty: true,
    });
    // The documenting comment survives; the key does not.
    expect(out).toBe('---\n# kept note\n---\nBody\n');
    expect(out).not.toContain('title: Foo');
  });

  it('still preserves a genuinely UNPARSEABLE block verbatim when fm is empty', () => {
    // The data-loss-avoidance path: a fence we can't turn into keys is kept,
    // never dropped — even though the live object is empty.
    const original = '\tbad: yaml\n  dup: 1\n  dup: 2';
    const out = assembleMarkdownFile({}, 'Body\n', {
      rawFrontmatter: original,
      frontmatterDirty: true,
    });
    expect(out).toContain('\tbad: yaml');
    expect(out).toContain('dup: 1');
    expect(out).toContain('dup: 2');
    expect(out.endsWith('Body\n')).toBe(true);
  });

  it('re-applies CRLF when a cleared block keeps a comment', () => {
    const out = assembleMarkdownFile({}, 'Body.\r\n', {
      rawFrontmatter: '# note\r\ntitle: Foo',
      frontmatterDirty: true,
      eol: '\r\n',
    });
    expect(out).toBe('---\r\n# note\r\n---\r\nBody.\r\n');
  });
});

/**
 * `patchFrontmatterSourceCst` normalises the FM source to LF and its docstring
 * says the caller re-applies the file's line ending; the dirty `objectHasKeys`
 * branch used to hard-code `\n` for the FM block + fences, so a CRLF file's
 * first metadata edit (tag row / editor) silently flipped its frontmatter to
 * LF. The matrix below pins eol preservation across {LF, CRLF} ×
 * {frontmatter-only (diskBody), editor-dirty (LF body), clean passthrough, dump
 * fallback} × {BOM, no-BOM}. The LF-only suite above never exercised the single
 * most leak-prone formatting invariant.
 */
describe('assembleMarkdownFile — line-ending preservation on the dirty FM path', () => {
  // True iff `s` contains no lone LF (every `\n` is part of a `\r\n`).
  const isAllCrlf = (s: string): boolean => !s.replace(/\r\n/g, '').includes('\n');
  const CRLF_FM = 'priority: low\r\ntitle: Note';
  const LF_FM = 'priority: low\ntitle: Note';

  it('CRLF file + frontmatter-only dirty FM → whole output is CRLF, body byte-identical', () => {
    const body = 'First line.\r\nSecond line.\r\n'; // diskBody verbatim (CRLF)
    const out = assembleMarkdownFile(
      { priority: 'high', title: 'Note' },
      body,
      { originalFrontmatter: CRLF_FM, frontmatterDirty: true },
    );
    expect(out).toBe(
      '---\r\npriority: high\r\ntitle: Note\r\n---\r\nFirst line.\r\nSecond line.\r\n',
    );
    expect(isAllCrlf(out)).toBe(true); // no lone LF anywhere
    expect(out.endsWith(body)).toBe(true); // body untouched
  });

  it('CRLF file + editor (LF) body + dirty FM → FM block keeps CRLF, body stays LF', () => {
    // Policy: re-apply the original file's eol to the FM block + fences; leave the
    // body as the editor (tiptap, LF) produced it.
    const body = 'First line.\nSecond line.\n';
    const out = assembleMarkdownFile(
      { priority: 'high', title: 'Note' },
      body,
      { originalFrontmatter: CRLF_FM, frontmatterDirty: true },
    );
    expect(out).toBe(
      '---\r\npriority: high\r\ntitle: Note\r\n---\r\nFirst line.\nSecond line.\n',
    );
    const fmBlock = out.slice(0, out.indexOf('---\r\n', 4) + '---\r\n'.length);
    expect(isAllCrlf(fmBlock)).toBe(true); // frontmatter block + fences are CRLF
    expect(out.endsWith('First line.\nSecond line.\n')).toBe(true); // editor body untouched
  });

  it('CRLF file + multi-line list value → internal FM newlines convert to CRLF', () => {
    const out = assembleMarkdownFile(
      { tags: ['a', 'b'], title: 'New' }, // title changed; tags unchanged
      'Body.\r\n',
      { originalFrontmatter: 'tags:\r\n  - a\r\n  - b\r\ntitle: Note', frontmatterDirty: true },
    );
    expect(out).toBe('---\r\ntags:\r\n  - a\r\n  - b\r\ntitle: New\r\n---\r\nBody.\r\n');
    expect(isAllCrlf(out)).toBe(true);
  });

  it('CRLF file + BOM + dirty FM → BOM preserved, FM block CRLF', () => {
    const out = assembleMarkdownFile(
      { priority: 'high', title: 'Note' },
      'First line.\r\n',
      { originalFrontmatter: CRLF_FM, frontmatterDirty: true, bom: true },
    );
    expect(out).toBe('﻿---\r\npriority: high\r\ntitle: Note\r\n---\r\nFirst line.\r\n');
  });

  it('LF file + dirty FM → output stays all-LF (no regression)', () => {
    const out = assembleMarkdownFile(
      { priority: 'high', title: 'Note' },
      'Body.\n',
      { originalFrontmatter: LF_FM, frontmatterDirty: true },
    );
    expect(out).toBe('---\npriority: high\ntitle: Note\n---\nBody.\n');
    expect(out.includes('\r')).toBe(false);
  });

  it('CRLF file + clean body-only save → frontmatter bytes round-trip as CRLF', () => {
    // frontmatterDirty:false → verbatim passthrough (emitWithRawFrontmatter),
    // which already honoured the file eol; pinned here as part of the matrix.
    const out = assembleMarkdownFile(
      { priority: 'low', title: 'Note' },
      'First line.\r\nSecond line.\r\n',
      { rawFrontmatter: CRLF_FM, frontmatterDirty: false },
    );
    expect(out).toBe(
      '---\r\npriority: low\r\ntitle: Note\r\n---\r\nFirst line.\r\nSecond line.\r\n',
    );
  });

  it('new file with no baseline + LF body → dump emits LF (matches prior behaviour)', () => {
    const out = assembleMarkdownFile({ title: 'New' }, 'Body.\n', { frontmatterDirty: true });
    expect(out).toBe('---\ntitle: New\n---\nBody.\n');
    expect(out.includes('\r')).toBe(false);
  });

  it('CRLF baseline that the engine refuses (dump fallback) → fences still CRLF', () => {
    // A flow mapping isn't a block mapping → patchFrontmatterSourceCst
    // returns null → dump path; the eol re-apply still runs off the CRLF source.
    const out = assembleMarkdownFile(
      { a: 1, title: 'X' },
      'Body.\r\n',
      { originalFrontmatter: '{a: 1}', frontmatterDirty: true },
    );
    expect(out).toBe('---\r\na: 1\r\ntitle: X\r\n---\r\nBody.\r\n');
    expect(isAllCrlf(out)).toBe(true);
  });
});

/**
 * The line-ending matrix above only used ≥2-key frontmatter, whose source
 * carries an internal `\r\n` that `detectFrontmatterEol` could short-circuit on.
 * A SINGLE-line FM (`title:` / `created:` — the common shape) has no internal
 * `\r\n`, so the truthy FM source masked the CRLF-bearing body and the file
 * flipped to LF on the first metadata edit. These rows pin the fix: (a) the
 * detection fallback now also consults the body, and (b) the gateway-threaded
 * `options.eol` wins outright (the only signal that survives an LF editor body).
 */
describe('assembleMarkdownFile — single-line frontmatter eol', () => {
  const isAllCrlf = (s: string): boolean => !s.replace(/\r\n/g, '').includes('\n');

  it('CRLF file + single-line FM + frontmatter-only dirty (CRLF body) → whole output CRLF', () => {
    // The diskBody is verbatim CRLF; the one-line FM source has no internal eol.
    const out = assembleMarkdownFile(
      { title: 'Renamed' },
      'First line.\r\nSecond line.\r\n',
      { originalFrontmatter: 'title: Note', frontmatterDirty: true },
    );
    expect(out).toBe('---\r\ntitle: Renamed\r\n---\r\nFirst line.\r\nSecond line.\r\n');
    expect(isAllCrlf(out)).toBe(true);
  });

  it('CRLF file + single-line FM + clean body-only save (CRLF body) → frontmatter round-trips CRLF', () => {
    const out = assembleMarkdownFile(
      { title: 'Note' },
      'First line.\r\nSecond line.\r\n',
      { rawFrontmatter: 'title: Note', frontmatterDirty: false },
    );
    expect(out).toBe('---\r\ntitle: Note\r\n---\r\nFirst line.\r\nSecond line.\r\n');
    expect(isAllCrlf(out)).toBe(true);
  });

  it('CRLF file + single-line FM + editor (LF) body + threaded eol → whole file CRLF', () => {
    // The editor body is LF and the one-line FM has no internal eol, so NOTHING
    // in the assemble inputs carries `\r\n`. Only the gateway-threaded eol
    // (FileState.eol, sniffed from the raw file at hydrate) recovers it.
    const out = assembleMarkdownFile(
      { title: 'Renamed' },
      'First line.\nSecond line.\n',
      { originalFrontmatter: 'title: Note', frontmatterDirty: true, eol: '\r\n' },
    );
    expect(out).toBe('---\r\ntitle: Renamed\r\n---\r\nFirst line.\r\nSecond line.\r\n');
    expect(isAllCrlf(out)).toBe(true);
  });

  it('threaded eol wins over a body that disagrees (LF body, eol CRLF) on the clean path', () => {
    const out = assembleMarkdownFile(
      { title: 'Note' },
      'Body.\n',
      { rawFrontmatter: 'title: Note', frontmatterDirty: false, eol: '\r\n' },
    );
    expect(out).toBe('---\r\ntitle: Note\r\n---\r\nBody.\r\n');
  });

  it('single-line FM + LF body + NO eol → stays LF (no false CRLF signal to recover)', () => {
    // Documents why threading exists: with an all-LF input the detection
    // fallback can't manufacture a CRLF that isn't there. In production the
    // gateway always threads `options.eol`, so this all-LF input never occurs
    // for a real CRLF file — see the threaded-eol row above.
    const out = assembleMarkdownFile(
      { title: 'Renamed' },
      'Body.\n',
      { originalFrontmatter: 'title: Note', frontmatterDirty: true },
    );
    expect(out).toBe('---\ntitle: Renamed\n---\nBody.\n');
    expect(out.includes('\r')).toBe(false);
  });
});

describe('assembleMarkdownFile — CRLF body', () => {
  const hasBareLf = (s: string): boolean => /(^|[^\r])\n/.test(s);

  it('clean frontmatter + LF editor body + eol CRLF → no bare \\n anywhere', () => {
    const out = assembleMarkdownFile({ title: 'Note' }, 'a\n\nb\n', {
      rawFrontmatter: 'title: Note',
      frontmatterDirty: false,
      eol: '\r\n',
    });
    expect(out).toBe('---\r\ntitle: Note\r\n---\r\na\r\n\r\nb\r\n');
    expect(hasBareLf(out)).toBe(false);
  });

  it('dirty frontmatter branch → no bare \\n anywhere', () => {
    const out = assembleMarkdownFile({ title: 'Renamed', tags: ['x'] }, 'a\n\nb\n', {
      originalFrontmatter: 'title: Note\ntags:\n  - x',
      frontmatterDirty: true,
      eol: '\r\n',
    });
    expect(out).toContain('title: Renamed\r\n');
    expect(out.endsWith('a\r\n\r\nb\r\n')).toBe(true);
    expect(hasBareLf(out)).toBe(false);
  });

  it('no frontmatter + eol CRLF → whole file CRLF', () => {
    const out = assembleMarkdownFile({}, '# Heading\n\nText\n', { eol: '\r\n' });
    expect(out).toBe('# Heading\r\n\r\nText\r\n');
  });

  it('no eol supplied → body written verbatim (frontmatter-only diskBody path)', () => {
    const mixed = 'line one\r\nline two\nline three\n';
    const out = assembleMarkdownFile({}, mixed);
    expect(out).toBe(mixed);
  });

  it('an already-CRLF body is not doubled (never \\r\\r\\n)', () => {
    const out = assembleMarkdownFile({ title: 'Note' }, 'a\r\nb\r\n', {
      rawFrontmatter: 'title: Note',
      frontmatterDirty: false,
      eol: '\r\n',
    });
    expect(out.includes('\r\r\n')).toBe(false);
    expect(out).toBe('---\r\ntitle: Note\r\n---\r\na\r\nb\r\n');
  });

  it('eol LF leaves an LF body untouched', () => {
    const out = assembleMarkdownFile({ title: 'Note' }, 'a\nb\n', {
      rawFrontmatter: 'title: Note',
      frontmatterDirty: false,
      eol: '\n',
    });
    expect(out).toBe('---\ntitle: Note\n---\na\nb\n');
  });
});

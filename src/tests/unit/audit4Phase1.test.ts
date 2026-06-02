import { describe, it, expect } from 'vitest';
import { parseMarkdownFile, assembleMarkdownFile } from '@renderer/lib/editor/markdownSync';
import { addTagToMarkdown, removeTagFromMarkdown, rewriteTagInMarkdown } from '@renderer/lib/vault/tagRewriter';
import { patchFrontmatterSource, valuesEqual } from '@renderer/lib/vault/frontmatterEngine';

/**
 * Audit-4 Phase 1 — frontmatter write-integrity (the js-yaml ↔ `yaml`-package
 * seam). Regression guards for DI-01, DI-01b, DI-02, DI-05.
 *
 * Root cause: Filo READ frontmatter with js-yaml's DEFAULT_SCHEMA (YAML 1.1 —
 * resolves `2026-06-01` → a JS `Date` and `<<: *a` → a merged map) but
 * RE-SERIALISES the disk baseline with the `yaml` package (YAML 1.2 core —
 * keeps them a `string` / a literal `<<`). The two libraries disagreed, so the
 * source-preserving engine thought unchanged keys "changed" and rewrote them —
 * corrupting unquoted dates to ISO timestamps (DI-01) and destroying merge
 * references (DI-05). Reading with CORE_SCHEMA aligns the two sides.
 */

describe('DI-01 — unquoted YAML dates round-trip byte-identical', () => {
  it('parseMarkdownFile reads an unquoted date as a string, not a Date', () => {
    const md = '---\ncreated: 2025-01-15\ndue: 2025-03-20\ntitle: Note\n---\nbody\n';
    const parsed = parseMarkdownFile(md);
    expect(typeof parsed.frontmatter.created).toBe('string');
    expect(parsed.frontmatter.created).toBe('2025-01-15');
    expect(typeof parsed.frontmatter.due).toBe('string');
    expect(parsed.frontmatter.due).toBe('2025-03-20');
  });

  it('preserves a date-time string in full (no slice / no reformat)', () => {
    const md = '---\ncreated: 2025-01-15T10:30:00\n---\nbody\n';
    const parsed = parseMarkdownFile(md);
    expect(parsed.frontmatter.created).toBe('2025-01-15T10:30:00');
  });

  it('assembleMarkdownFile keeps unquoted dates verbatim when another key changes', () => {
    const md = '---\ncreated: 2025-01-15\ndue: 2025-03-20\ntitle: Note\n---\nbody\n';
    const parsed = parseMarkdownFile(md);
    // Simulate a metadata change on a DIFFERENT key (e.g. a property edit /
    // tag add) for a file open as a TextTile/DocumentEditor — the source-
    // preserving patch path.
    const nextFm = { ...parsed.frontmatter, title: 'Renamed' };
    const out = assembleMarkdownFile(nextFm, parsed.body, {
      rawFrontmatter: parsed.rawFrontmatter,
      frontmatterDirty: true,
      originalFrontmatter: parsed.rawFrontmatter,
    });
    expect(out).toContain('created: 2025-01-15\n');
    expect(out).toContain('due: 2025-03-20\n');
    // The corruption signature: a date promoted to an ISO timestamp.
    expect(out).not.toContain('T00:00:00');
    expect(out).toContain('title: Renamed');
  });

  it('addTagToMarkdown preserves an unquoted date when adding to an existing tags list', () => {
    // A file with BOTH an unquoted date AND an existing `tags:` field routes
    // addTag through patchFrontmatterSource (the seam where the date was
    // corrupted to ISO under the old DEFAULT_SCHEMA read).
    const md = '---\ncreated: 2025-01-15\ntags:\n  - foo\n---\nbody\n';
    const out = addTagToMarkdown(md, 'bar');
    expect(out).toContain('created: 2025-01-15');
    expect(out).not.toContain('T00:00:00');
    expect(out).toContain('- bar');
  });
});

describe('DI-05 — YAML merge keys (`<<`) survive a tag op', () => {
  it('keeps the literal `<<` merge reference when adding a tag', () => {
    const md = '---\ndefaults: &d\n  color: red\nwidget:\n  <<: *d\n  size: big\ntags:\n  - foo\n---\nbody\n';
    const out = addTagToMarkdown(md, 'bar');
    // The merge key must remain a literal `<<` reference, not be inlined into
    // the resolved map (which would destroy the anchor relationship).
    expect(out).toContain('<<: *d');
    expect(out).toContain('- bar');
  });
});

describe('DI-01b — valuesEqual / doc.set hardened against Date', () => {
  it('valuesEqual treats two different Dates as unequal (not both-empty-keys)', () => {
    // Object.keys(new Date()) === [] — the generic object branch would have
    // compared two different Dates as EQUAL (0 keys each). That would silently
    // drop a date edit the moment both sides are Dates.
    expect(valuesEqual(new Date('2025-01-01'), new Date('2030-01-01'))).toBe(false);
    expect(valuesEqual(new Date('2025-01-01'), new Date('2025-01-01'))).toBe(true);
    // A Date is never equal to a non-Date object.
    expect(valuesEqual(new Date('2025-01-01'), { x: 1 })).toBe(false);
  });

  it('patchFrontmatterSource coerces a residual Date value to a plain date string', () => {
    // Belt-and-suspenders: if a Date ever reaches doc.set, it must emit a plain
    // YYYY-MM-DD date, never the `yaml` package's `2025-01-15T00:00:00.000Z`.
    const out = patchFrontmatterSource('title: T', { title: 'T', when: new Date('2025-01-15T00:00:00Z') });
    expect(out).not.toBeNull();
    expect(out).toContain('when: 2025-01-15');
    expect(out).not.toContain('T00:00:00');
  });
});

describe('DI-02 — BOM `.md` does not get duplicate frontmatter on tag-add', () => {
  const BOM = '﻿';

  it('addTagToMarkdown edits the existing block (one block, BOM preserved)', () => {
    const md = `${BOM}---\ntitle: X\ntags:\n  - foo\n---\nbody\n`;
    const out = addTagToMarkdown(md, 'bar');
    // Exactly one frontmatter block — two fence lines, not four.
    // Strip the leading BOM first — it shares the opening fence's line, so a
    // bare `^---` would miss that fence and undercount.
    const fenceLines = out.replace(/^﻿/, '').match(/^---/gm) ?? [];
    expect(fenceLines).toHaveLength(2);
    // BOM survives at byte 0.
    expect(out.charCodeAt(0)).toBe(0xfeff);
    // The real frontmatter keys are NOT demoted into the body.
    const afterBom = out.slice(1);
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(afterBom)?.[1] ?? '';
    expect(fm).toContain('title: X');
    expect(fm).toContain('- bar');
    // body intact, nothing demoted
    expect(out).not.toMatch(/---[\s\S]*---[\s\S]*title: X/);
  });

  it('removeTagFromMarkdown actually removes the tag on a BOM file', () => {
    const md = `${BOM}---\ntitle: X\ntags:\n  - foo\n  - bar\n---\nbody\n`;
    const out = removeTagFromMarkdown(md, 'foo');
    expect(out).not.toBe(md);
    expect(out.charCodeAt(0)).toBe(0xfeff);
    const afterBom = out.slice(1);
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(afterBom)?.[1] ?? '';
    expect(fm).not.toContain('- foo');
    expect(fm).toContain('- bar');
  });

  it('rewriteTagInMarkdown actually renames the tag on a BOM file', () => {
    const md = `${BOM}---\ntitle: X\ntags:\n  - foo\n---\nbody\n`;
    const out = rewriteTagInMarkdown(md, 'foo', 'renamed');
    expect(out).not.toBe(md);
    expect(out.charCodeAt(0)).toBe(0xfeff);
    const afterBom = out.slice(1);
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(afterBom)?.[1] ?? '';
    expect(fm).not.toContain('- foo');
    expect(fm).toContain('- renamed');
  });

  it('preserves the BOM across a CRLF file tag-add', () => {
    const md = `${BOM}---\r\ntitle: X\r\ntags:\r\n  - foo\r\n---\r\nbody\r\n`;
    const out = addTagToMarkdown(md, 'bar');
    expect(out.charCodeAt(0)).toBe(0xfeff);
    // Strip the leading BOM first — it shares the opening fence's line, so a
    // bare `^---` would miss that fence and undercount.
    const fenceLines = out.replace(/^﻿/, '').match(/^---/gm) ?? [];
    expect(fenceLines).toHaveLength(2);
  });
});

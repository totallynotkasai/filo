import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import { assembleMarkdownFile } from '@renderer/lib/editor/markdownSync';

/**
 * Audit2 4.8 — a dirty frontmatter re-serialise (a metadata edit) now patches
 * the disk-baseline source via the `yaml` Document engine instead of dumping the
 * whole object, so comments / key order on untouched keys survive (the fix for
 * the lossy YAML round-trip, KNOWN_LIMITATION #1). New files with no baseline
 * still take the full dump.
 */
function fmOf(md: string): string {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(md);
  return m ? m[1] : '';
}

describe('assembleMarkdownFile — source-preserving dirty path (4.8)', () => {
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

  it('falls back to a dump when the baseline is not a parseable mapping', () => {
    // A top-level sequence baseline → engine returns null → dump path.
    const out = assembleMarkdownFile(
      { title: 'X' },
      'Body\n',
      { originalFrontmatter: '- a\n- b', frontmatterDirty: true },
    );
    expect(yaml.load(fmOf(out))).toEqual({ title: 'X' });
  });
});

import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import { patchFrontmatterSource } from '@renderer/lib/vault/frontmatterEngine';

/**
 * Audit2 4.8 — the source-preserving frontmatter engine. The defining property:
 * changing one key leaves every OTHER key's bytes (comments, order, quoting)
 * untouched, and an unparseable / non-mapping block is refused (null) rather
 * than corrupted.
 */
describe('patchFrontmatterSource', () => {
  it('preserves comments and key order on untouched keys when one value changes', () => {
    const src = [
      '# top comment',
      'title: Hello',
      'priority: low   # inline note',
      'author: ada',
    ].join('\n');
    const next = { title: 'Hello', priority: 'high', author: 'ada' };
    const out = patchFrontmatterSource(src, next);
    expect(out).not.toBeNull();
    // The comments + order survive; only priority's value changed.
    expect(out).toContain('# top comment');
    expect(out).toContain('# inline note');
    expect(out!.indexOf('title:')).toBeLessThan(out!.indexOf('priority:'));
    expect(out!.indexOf('priority:')).toBeLessThan(out!.indexOf('author:'));
    expect(yaml.load(out!)).toEqual({ title: 'Hello', priority: 'high', author: 'ada' });
  });

  it('appends a new key and deletes a removed key, keeping the rest verbatim', () => {
    const src = ['# keep me', 'title: T', 'draft: true'].join('\n');
    const out = patchFrontmatterSource(src, { title: 'T', tags: ['x'] });
    expect(out).not.toBeNull();
    expect(out).toContain('# keep me');
    const parsed = yaml.load(out!) as Record<string, unknown>;
    expect(parsed.title).toBe('T');
    expect(parsed.tags).toEqual(['x']);
    expect('draft' in parsed).toBe(false);
  });

  it('auto-quotes a YAML-special tag value so it re-parses as the intended string', () => {
    const src = 'title: T';
    const out = patchFrontmatterSource(src, { title: 'T', tags: ['@home', 'a: b', 'null'] });
    expect(out).not.toBeNull();
    const parsed = yaml.load(out!) as { tags: unknown };
    expect(parsed.tags).toEqual(['@home', 'a: b', 'null']);
  });

  it("keeps an untouched tags list's flow style + quoting when a sibling changes", () => {
    const src = ['tags: [draft, "@home"]', 'title: Old'].join('\n');
    const out = patchFrontmatterSource(src, { tags: ['draft', '@home'], title: 'New' });
    expect(out).not.toBeNull();
    // tags untouched → still flow (`[...]`), still quoting @home. (The `yaml`
    // package may normalise internal bracket spacing — that's cosmetic, not
    // data loss, and far better than the whole-object dump it replaces.)
    expect(out).toMatch(/tags:\s*\[.*"@home".*\]/);
    expect(yaml.load(out!)).toEqual({ tags: ['draft', '@home'], title: 'New' });
  });

  it('refuses (null) a top-level scalar or sequence', () => {
    expect(patchFrontmatterSource('just a string', { a: 1 })).toBeNull();
    expect(patchFrontmatterSource('- a\n- b', { a: 1 })).toBeNull();
  });

  it('refuses (null) an unparseable block (duplicate keys / bad indent)', () => {
    expect(patchFrontmatterSource('title: a\ntitle: b', { title: 'c' })).toBeNull();
    expect(patchFrontmatterSource('a:\n\tb: 1', { a: 1 })).toBeNull();
  });

  it('round-trips a block-style tags list when an unrelated key changes', () => {
    const src = ['tags:', '  - alpha', '  - beta', 'status: open'].join('\n');
    const out = patchFrontmatterSource(src, { tags: ['alpha', 'beta'], status: 'closed' });
    expect(out).not.toBeNull();
    expect(out).toContain('- alpha');
    expect(out).toContain('- beta');
    expect(yaml.load(out!)).toEqual({ tags: ['alpha', 'beta'], status: 'closed' });
  });
});

import { describe, it, expect } from 'vitest';
import { rewriteTagInMarkdown, removeTagFromMarkdown, addTagToMarkdown } from '@renderer/lib/vault/tagRewriter';

describe('rewriteTagInMarkdown', () => {
  it('rewrites the tag in the frontmatter tags array', () => {
    const input = ['---', 'tags:', '  - foo', '  - other', '---', '', 'body'].join('\n');
    const out = rewriteTagInMarkdown(input, 'foo', 'bar');
    expect(out).toMatch(/- bar/);
    expect(out).not.toMatch(/^\s*- foo$/m);
    expect(out).toMatch(/- other/);
  });

  it('rewrites a comma-separated string-form tags entry', () => {
    const input = ['---', 'tags: foo, baz', '---', 'body'].join('\n');
    const out = rewriteTagInMarkdown(input, 'foo', 'bar');
    expect(out).toContain('bar');
    expect(out).toContain('baz');
  });

  it('leaves inline body #tag runs untouched (decorative only)', () => {
    const input = ['---', 'tags:', '  - foo', '---', '', '#foo prose and #foo/sub'].join('\n');
    const out = rewriteTagInMarkdown(input, 'foo', 'bar');
    expect(out).toMatch(/- bar/);
    expect(out).toContain('#foo prose and #foo/sub');
  });

  it('returns the input unchanged when there is no frontmatter', () => {
    const input = 'no frontmatter, but #foo in body';
    expect(rewriteTagInMarkdown(input, 'foo', 'bar')).toBe(input);
  });

  it('returns the input unchanged when the tag is not in frontmatter', () => {
    const input = ['---', 'tags:', '  - baz', '---', 'body'].join('\n');
    expect(rewriteTagInMarkdown(input, 'foo', 'bar')).toBe(input);
  });

  it('no-ops when old === new', () => {
    const input = ['---', 'tags:', '  - foo', '---', 'body'].join('\n');
    expect(rewriteTagInMarkdown(input, 'foo', 'foo')).toBe(input);
  });
});

describe('removeTagFromMarkdown', () => {
  it('strips the tag from the frontmatter tags list', () => {
    const input = ['---', 'tags:', '  - foo', '  - bar', '---', 'body'].join('\n');
    const out = removeTagFromMarkdown(input, 'foo');
    expect(out).not.toMatch(/^\s*- foo$/m);
    expect(out).toMatch(/- bar/);
  });

  it('leaves inline body #tag runs intact', () => {
    const input = ['---', 'tags:', '  - foo', '---', 'inline #foo run'].join('\n');
    const out = removeTagFromMarkdown(input, 'foo');
    expect(out).not.toMatch(/^\s*- foo$/m);
    expect(out).toContain('inline #foo run');
  });

  it('returns the input unchanged when no frontmatter is present', () => {
    const input = 'body with #foo';
    expect(removeTagFromMarkdown(input, 'foo')).toBe(input);
  });
});

describe('addTagToMarkdown', () => {
  it('appends a tag to an existing frontmatter list', () => {
    const input = ['---', 'tags:', '  - foo', '---', 'body text'].join('\n');
    const out = addTagToMarkdown(input, 'bar');
    expect(out).toMatch(/tags:/);
    expect(out).toMatch(/- foo/);
    expect(out).toMatch(/- bar/);
    expect(out).toMatch(/body text/);
  });

  it('synthesises frontmatter when the file has none', () => {
    const input = 'just a body paragraph';
    const out = addTagToMarkdown(input, 'todo');
    expect(out.startsWith('---\n')).toBe(true);
    expect(out).toMatch(/tags:/);
    expect(out).toMatch(/- todo/);
    expect(out).toMatch(/just a body paragraph/);
  });

  it('is idempotent when the tag is already present (array form)', () => {
    const input = ['---', 'tags:', '  - foo', '---', 'body'].join('\n');
    const out = addTagToMarkdown(input, 'foo');
    expect(out).toBe(input);
  });

  it('handles legacy string-form tags by upgrading to array', () => {
    const input = ['---', 'tags: foo bar', '---', 'body'].join('\n');
    const out = addTagToMarkdown(input, 'baz');
    expect(out).toMatch(/- foo/);
    expect(out).toMatch(/- bar/);
    expect(out).toMatch(/- baz/);
  });

  it('strips a leading # from the input tag name', () => {
    const input = 'body';
    const out = addTagToMarkdown(input, '#todo');
    expect(out).toMatch(/- todo/);
    expect(out).not.toMatch(/- #todo/);
  });
});

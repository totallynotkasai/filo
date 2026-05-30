import { describe, it, expect } from 'vitest';
import { stripFrontmatter, getBodyPreview } from '@renderer/lib/tasks/taskBodyText';

describe('stripFrontmatter', () => {
  it('strips a complete frontmatter block', () => {
    const md = '---\ntitle: T\ncompleted: false\n---\nBody here';
    expect(stripFrontmatter(md)).toBe('Body here');
  });

  it('leaves non-frontmatter content untouched', () => {
    expect(stripFrontmatter('Just body\n')).toBe('Just body\n');
  });

  it('does not strip --- that appears mid-body', () => {
    const md = 'Intro\n---\nMore body';
    expect(stripFrontmatter(md)).toBe('Intro\n---\nMore body');
  });
});

describe('getBodyPreview', () => {
  it('returns empty for empty input', () => {
    expect(getBodyPreview('', 80)).toBe('');
  });

  it('returns empty when only frontmatter is present', () => {
    expect(getBodyPreview('---\ntitle: T\n---\n', 80)).toBe('');
  });

  it('returns the first non-empty line of body', () => {
    const md = '---\ntitle: T\n---\n# Heading\n\nThis is the body.';
    expect(getBodyPreview(md, 80)).toBe('This is the body.');
  });

  it('skips heading lines', () => {
    expect(getBodyPreview('# H1\n## H2\nReal content', 80)).toBe('Real content');
  });

  it('truncates with ellipsis when over the limit', () => {
    const long = 'a'.repeat(200);
    const out = getBodyPreview(long, 30);
    expect(out.length).toBe(30);
    expect(out.endsWith('…')).toBe(true);
  });

  it('strips bullet prefix', () => {
    expect(getBodyPreview('- bullet item', 80)).toBe('bullet item');
    expect(getBodyPreview('* another', 80)).toBe('another');
  });

  it('strips a task-list checkbox prefix', () => {
    expect(getBodyPreview('- [ ] do it', 80)).toBe('do it');
    expect(getBodyPreview('- [x] done', 80)).toBe('done');
  });

  it('strips blockquote prefix', () => {
    expect(getBodyPreview('> a quote', 80)).toBe('a quote');
  });

  it('unwraps bold / italic / code / link decoration', () => {
    expect(getBodyPreview('**bold** here', 80)).toBe('bold here');
    expect(getBodyPreview('*it* and __also__', 80)).toBe('it and also');
    expect(getBodyPreview('use `cmd` to run', 80)).toBe('use cmd to run');
    expect(getBodyPreview('see [docs](https://example.com)', 80)).toBe('see docs');
  });

  it('returns empty for maxChars <= 0', () => {
    expect(getBodyPreview('content', 0)).toBe('');
    expect(getBodyPreview('content', -5)).toBe('');
  });
});

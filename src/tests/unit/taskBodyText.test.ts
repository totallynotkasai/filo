import { describe, it, expect } from 'vitest';
import { getBodyPreview } from '@renderer/lib/tasks/taskBodyText';

describe('getBodyPreview', () => {
  it('returns empty for empty input', () => {
    expect(getBodyPreview('', 80)).toBe('');
  });

  it('returns empty when the body holds only rules and headings', () => {
    expect(getBodyPreview('---\n# Heading\n***\n', 80)).toBe('');
  });

  it('a body that opens with text between two rules shows that text', () => {
    expect(getBodyPreview('---\nBetween the rules\n---\nAfter', 80)).toBe('Between the rules');
  });

  it('returns the first non-empty line of body', () => {
    const md = '# Heading\n\nThis is the body.';
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

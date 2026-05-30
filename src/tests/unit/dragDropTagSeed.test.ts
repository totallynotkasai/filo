import { describe, it, expect } from 'vitest';
import { deriveTileSeedFromMarkdown } from '@renderer/lib/canvas/markdownTileSeed';

describe('deriveTileSeedFromMarkdown', () => {
  it('extracts id and tags from YAML frontmatter (array form)', () => {
    const raw = '---\nid: doc_123\ntags: [alpha, beta]\n---\nbody text';
    const seed = deriveTileSeedFromMarkdown(raw);
    expect(seed.contentId).toBe('doc_123');
    expect(seed.body).toBe('body text');
    expect(seed.tagNames).toEqual(['alpha', 'beta']);
  });

  it('handles string-form tags', () => {
    const raw = '---\ntags: alpha, beta\n---\nbody';
    const seed = deriveTileSeedFromMarkdown(raw);
    expect(seed.tagNames).toEqual(['alpha', 'beta']);
  });

  it('strips leading # from frontmatter tags', () => {
    const raw = '---\ntags: ["#hash", "plain"]\n---\nbody';
    const seed = deriveTileSeedFromMarkdown(raw);
    expect(seed.tagNames).toEqual(['hash', 'plain']);
  });

  it('returns null contentId and empty tags for files without frontmatter', () => {
    const raw = '# Just a heading\nand body text';
    const seed = deriveTileSeedFromMarkdown(raw);
    expect(seed.contentId).toBeNull();
    expect(seed.body).toBe(raw);
    expect(seed.tagNames).toEqual([]);
  });

  it('returns empty tags when frontmatter has no tags key', () => {
    const raw = '---\nid: doc_only\n---\nbody';
    const seed = deriveTileSeedFromMarkdown(raw);
    expect(seed.contentId).toBe('doc_only');
    expect(seed.tagNames).toEqual([]);
  });

  it('returns null contentId when frontmatter has no id', () => {
    const raw = '---\ntags: [x]\n---\nbody';
    const seed = deriveTileSeedFromMarkdown(raw);
    expect(seed.contentId).toBeNull();
    expect(seed.tagNames).toEqual(['x']);
  });

  it('handles CRLF line endings in frontmatter', () => {
    const raw = '---\r\nid: doc_crlf\r\ntags: [a, b]\r\n---\r\nbody';
    const seed = deriveTileSeedFromMarkdown(raw);
    expect(seed.contentId).toBe('doc_crlf');
    expect(seed.tagNames).toEqual(['a', 'b']);
  });

  it('preserves legacy JSON-comment header for id extraction', () => {
    const raw = '<!-- Filo document metadata -->\n{"id":"doc_legacy"}\nbody text';
    const seed = deriveTileSeedFromMarkdown(raw);
    expect(seed.contentId).toBe('doc_legacy');
    expect(seed.body).toBe('body text');
    expect(seed.tagNames).toEqual([]);
  });

  it('returns null id when legacy JSON-comment header is malformed', () => {
    const raw = '<!-- Filo document metadata -->\n{not-json}\nbody';
    const seed = deriveTileSeedFromMarkdown(raw);
    expect(seed.contentId).toBeNull();
    expect(seed.tagNames).toEqual([]);
  });

  it('handles empty input', () => {
    const seed = deriveTileSeedFromMarkdown('');
    expect(seed.contentId).toBeNull();
    expect(seed.body).toBe('');
    expect(seed.tagNames).toEqual([]);
  });

  it('trims the body when frontmatter is present', () => {
    const raw = '---\nid: doc_x\n---\n\n  body  \n';
    const seed = deriveTileSeedFromMarkdown(raw);
    expect(seed.body).toBe('body');
  });
});

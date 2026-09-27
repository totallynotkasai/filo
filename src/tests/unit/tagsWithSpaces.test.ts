import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseTagInput } from '@renderer/lib/tags/tagRowInput';
import {
  addTagToMarkdown,
  removeTagFromMarkdown,
  rewriteTagInMarkdown,
} from '@renderer/lib/vault/tagRewriter';
import { parseMarkdown } from '@renderer/lib/vault/vaultIndex';
import { filesMatchingTag } from '@renderer/lib/vault/sidebarTagFilter';
import { parseQuery } from '@renderer/lib/search/queryParser';
import { normalizeTagsField } from '@renderer/lib/utils/normalizeTagsField';
import { vaultPath } from '@shared/vaultPath';

/**
 * A tag may hold spaces (`Book 1`, `Planning Project`); tags are separated
 * by commas only. Each place that reads, writes or matches a tag keeps such
 * a name whole.
 */

function tagsOf(md: string): unknown {
  const m = /^---\n([\s\S]*?)\n---/.exec(md);
  return (parseYaml(m?.[1] ?? '') as { tags?: unknown }).tags;
}

describe('tags with spaces', () => {
  it('the tag row takes them, split on commas', () => {
    expect(parseTagInput('Book 1, Planning Project', []).tags).toEqual(['Book 1', 'Planning Project']);
  });

  it('adding one to a note writes it as one list item', () => {
    const out = addTagToMarkdown(['---', 'tags: [draft]', '---', 'body'].join('\n'), 'Book 1');
    expect(tagsOf(out)).toEqual(['draft', 'Book 1']);
    expect(out.endsWith('body')).toBe(true);
  });

  it('adding one to a note with no frontmatter', () => {
    expect(tagsOf(addTagToMarkdown('body', 'Planning Project'))).toEqual(['Planning Project']);
  });

  it.each([
    ['flow', ['---', 'tags: [Book 1, draft]', '---', 'body']],
    ['block', ['---', 'tags:', '  - Book 1', '  - draft', '---', 'body']],
    ['comma string', ['---', 'tags: Book 1, draft', '---', 'body']],
  ])('rename and remove work on a %s field', (_shape, lines) => {
    const md = lines.join('\n');
    expect(normalizeTagsField(tagsOf(md))).toEqual(['Book 1', 'draft']);
    const renamed = rewriteTagInMarkdown(md, 'Book 1', 'Book 2');
    expect(normalizeTagsField(tagsOf(renamed))).toEqual(['Book 2', 'draft']);
    const removed = removeTagFromMarkdown(md, 'Book 1');
    expect(normalizeTagsField(tagsOf(removed))).toEqual(['draft']);
    expect(removed.endsWith('body')).toBe(true);
  });

  it('rename matches ignoring case, like the rest of tag identity', () => {
    const md = ['---', 'tags: [book 1]', '---', 'x'].join('\n');
    expect(tagsOf(rewriteTagInMarkdown(md, 'Book 1', 'Planning Project'))).toEqual(['Planning Project']);
  });

  it('the vault index reads them whole', () => {
    const meta = parseMarkdown('A.md', ['---', 'tags: Book 1, Planning Project', '---', 'text'].join('\n'));
    expect(meta.tags).toEqual(['Book 1', 'Planning Project']);
  });

  it('the sidebar filter selects files by a spaced tag and its child tags', () => {
    const files = [
      { path: 'a.md', tags: ['Book 1'] },
      { path: 'b.md', tags: ['Book 1/Chapter 2'] },
      { path: 'c.md', tags: ['Book 10'] },
      { path: 'd.md', tags: ['Book'] },
    ];
    expect(filesMatchingTag('book 1', files)).toEqual(new Set([vaultPath('a.md'), vaultPath('b.md')]));
  });

  it('search takes a quoted spaced tag', () => {
    const q = parseQuery('tag:"Book 1" dragon');
    expect(q.operators).toEqual([{ kind: 'tag', value: 'Book 1' }]);
    expect(q.freeText).toBe('dragon');
  });
});

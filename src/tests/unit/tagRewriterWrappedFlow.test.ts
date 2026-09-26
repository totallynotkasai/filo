import { describe, it, expect } from 'vitest';
import { parseDocument } from 'yaml';
import {
  rewriteTagInMarkdown,
  removeTagFromMarkdown,
  addTagToMarkdown,
} from '@renderer/lib/vault/tagRewriter';

/**
 * Tag rewrites on `tags:` shapes the line tokenizer can't see whole: a flow
 * list wrapped onto further lines (Prettier does this), a flow mapping, a
 * plain scalar folded onto the next line. Each must leave YAML that parses,
 * holds every other tag and keeps every other key.
 */
function frontmatterOf(md: string): Record<string, unknown> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) throw new Error('no frontmatter fence found');
  const doc = parseDocument(m[1] ?? '', { uniqueKeys: true });
  if (doc.errors.length > 0) throw new Error(`frontmatter no longer parses: ${doc.errors[0]?.message}`);
  return doc.toJS() as Record<string, unknown>;
}

const WRAPPED = '---\ntitle: Plan\ntags: [project, draft,\n  review]\nstatus: open\n---\nBody text\n';
const WRAPPED_3 = '---\ntags: [alpha,\n  draft,\n  beta,\n  gamma]\ntitle: Three\n---\nBody\n';
const WRAPPED_THEN_COMMENT = '---\ntags: [project, draft,\n  review]\n# keep this note\ntitle: C\n---\nBody\n';

describe('tag rewriter — wrapped flow list', () => {
  it('rename keeps YAML valid and every other tag', () => {
    const out = rewriteTagInMarkdown(WRAPPED, 'draft', 'final');
    const fm = frontmatterOf(out);
    expect(fm.tags).toEqual(['project', 'final', 'review']);
    expect(fm.title).toBe('Plan');
    expect(fm.status).toBe('open');
    expect(out.endsWith('Body text\n')).toBe(true);
  });

  it('remove keeps YAML valid and every other tag', () => {
    const out = removeTagFromMarkdown(WRAPPED, 'draft');
    expect(frontmatterOf(out).tags).toEqual(['project', 'review']);
  });

  it('removing the tag on the continuation line works too', () => {
    const out = removeTagFromMarkdown(WRAPPED, 'review');
    expect(frontmatterOf(out).tags).toEqual(['project', 'draft']);
  });

  it('add keeps YAML valid', () => {
    const out = addTagToMarkdown(WRAPPED, 'extra');
    expect(frontmatterOf(out).tags).toEqual(['project', 'draft', 'review', 'extra']);
  });

  it('a list over 3+ lines: rename, remove, add', () => {
    expect(frontmatterOf(rewriteTagInMarkdown(WRAPPED_3, 'draft', 'done')).tags).toEqual(['alpha', 'done', 'beta', 'gamma']);
    expect(frontmatterOf(removeTagFromMarkdown(WRAPPED_3, 'beta')).tags).toEqual(['alpha', 'draft', 'gamma']);
    const added = frontmatterOf(addTagToMarkdown(WRAPPED_3, 'delta'));
    expect(added.tags).toEqual(['alpha', 'draft', 'beta', 'gamma', 'delta']);
    expect(added.title).toBe('Three');
  });

  it('a comment line after the wrapped list survives', () => {
    for (const out of [
      rewriteTagInMarkdown(WRAPPED_THEN_COMMENT, 'draft', 'x'),
      removeTagFromMarkdown(WRAPPED_THEN_COMMENT, 'draft'),
      addTagToMarkdown(WRAPPED_THEN_COMMENT, 'y'),
    ]) {
      const fm = frontmatterOf(out);
      expect(fm.title).toBe('C');
      expect(out).toContain('# keep this note');
    }
  });
});

describe('tag rewriter — flow mapping and folded scalars', () => {
  it('a flow mapping under tags is never line-edited into broken YAML', () => {
    const src = '---\ntags: {a: 1, draft: 2}\ntitle: M\n---\nB\n';
    for (const out of [
      rewriteTagInMarkdown(src, 'draft', 'x'),
      removeTagFromMarkdown(src, 'draft'),
      addTagToMarkdown(src, 'y'),
    ]) {
      expect(frontmatterOf(out).title).toBe('M');
    }
  });

  it('a comma string folded onto the next line keeps parsing', () => {
    const src = '---\ntags: project, draft,\n  review\ntitle: F\n---\nB\n';
    const out = removeTagFromMarkdown(src, 'draft');
    const fm = frontmatterOf(out);
    expect(fm.title).toBe('F');
    expect(String(fm.tags)).not.toMatch(/draft/);
    expect(String(fm.tags)).toMatch(/review/);
  });

  it('a non-string item on the fast path is kept', () => {
    const out = rewriteTagInMarkdown('---\ntags: [2024, draft]\n---\nB\n', 'draft', 'x');
    expect(frontmatterOf(out).tags).toEqual(['2024', 'x']);
  });
});

/**
 * When the source-preserving patch can't take a frontmatter block (a flow
 * mapping root, a changed key with a YAML tag or anchor), the only way to
 * apply an edit is a full rewrite from the parsed values. That rewrite must
 * not change what an untouched key says: `02134`, `1.10` and `0xFF00FF` read
 * as numbers and would come back as `2134`, `1.1` and `16711935`. Such an edit
 * is refused and the file keeps its block; a rewrite that loses nothing still
 * goes ahead.
 */
import { describe, it, expect } from 'vitest';
import { assembleNoteText, readNoteText } from '@renderer/lib/notes/noteFile';
import { addTagToMarkdown, removeTagFromMarkdown, rewriteTagInMarkdown } from '@renderer/lib/vault/tagRewriter';
import { dumpPreservesUntouched } from '@renderer/lib/vault/frontmatterCstModel';
import type { FrontmatterRefusal } from '@renderer/lib/editor/markdownSync';

function patch(raw: string, set: Record<string, unknown>): { text: string; refused: FrontmatterRefusal | null } {
  let refused: FrontmatterRefusal | null = null;
  const text = assembleNoteText(readNoteText(raw), { delta: { set, unset: [] } }, (r) => { refused = r; });
  return { text, refused };
}

describe('the frontmatter full-rewrite fallback', () => {
  const FLOW = '---\n{title: Draft, zip: 02134, version: 1.10, tags: [a]}\n---\nBody\n';

  it('a tag add to a flow mapping holding 02134 and 1.10 is refused; the file is unchanged', () => {
    expect(addTagToMarkdown(FLOW, 'b')).toBe(FLOW);
    expect(removeTagFromMarkdown(FLOW, 'a')).toBe(FLOW);
    expect(rewriteTagInMarkdown(FLOW, 'a', 'c')).toBe(FLOW);
  });

  it('a field edit on that note is refused as lossy and keeps the block', () => {
    const { text, refused } = patch(FLOW, { status: 'done' });
    expect(refused).toBe('lossy');
    expect(text).toBe(FLOW);
  });

  it('a status change on a tagged key, next to zip: 02134, is refused', () => {
    const raw = '---\nstatus: !custom todo\nzip: 02134\n---\nBody\n';
    const { text, refused } = patch(raw, { status: 'done' });
    expect(refused).toBe('lossy');
    expect(text).toBe(raw);
  });

  it('an untouched key with an explicit YAML tag is not rewritten without it', () => {
    const raw = '---\n{kind: !custom x, title: T}\n---\n';
    expect(patch(raw, { title: 'U' }).refused).toBe('lossy');
  });

  it('a rewrite of canonical values still goes ahead', () => {
    const raw = '---\n{title: Draft, count: 3, done: false, tags: [a]}\n---\nBody\n';
    const added = addTagToMarkdown(raw, 'b');
    expect(added).not.toBe(raw);
    expect(added).toContain('count: 3');
    expect(added).toMatch(/- b/);
    const { text, refused } = patch(raw, { status: 'done' });
    expect(refused).toBeNull();
    expect(text).toContain('status: done');
    expect(text).toContain('title: Draft');
  });

  it('quoting and null spellings may change; the values may not', () => {
    expect(dumpPreservesUntouched('{a: "x", n: ~}', 'a: x\nn: null', { a: 'x', n: null })).toBe(true);
    expect(dumpPreservesUntouched('{hex: 0xFF00FF}', 'hex: 16711935', { hex: 16711935 })).toBe(false);
    // A key the change set is the change itself.
    expect(dumpPreservesUntouched('{zip: 02134}', 'zip: 99', { zip: 99 })).toBe(true);
  });
});

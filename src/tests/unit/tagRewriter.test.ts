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

  // Phase 7.4 — adding the FIRST tag to a file that has frontmatter but no
  // `tags:` field used to fall to the lossy load→dump path, discarding YAML
  // comments / blank lines / key order. It now inserts via a line-level edit.
  it('inserts the first tag via a line edit, preserving comments and key order', () => {
    const input = [
      '---',
      '# pinned note — keep me',
      'title: My Note',
      'aliases:',
      '  - mn',
      '---',
      'body',
    ].join('\n');
    const out = addTagToMarkdown(input, 'todo');
    expect(out).toContain('# pinned note — keep me'); // comment survives
    expect(out).toContain('title: My Note');
    expect(out).toContain('aliases:');
    expect(out).toMatch(/tags:\n {2}- todo/);
    expect(out).toMatch(/\n---\nbody/);
  });

  it('inserts the tags block additively without reformatting other keys', () => {
    const input = ['---', 'title: X', '---', 'body'].join('\n');
    const out = addTagToMarkdown(input, 'a');
    expect(out).toBe(['---', 'title: X', 'tags:', '  - a', '---', 'body', ''].join('\n'));
  });

  it('inserts before a trailing blank line in the frontmatter', () => {
    const input = ['---', 'title: X', '', '---', 'body'].join('\n');
    const out = addTagToMarkdown(input, 'a');
    expect(out).toContain('title: X');
    expect(out).toMatch(/tags:\n {2}- a/);
    expect(out).toMatch(/\n---\nbody/);
  });

  it('still upgrades a legacy string-form field via the dump path (unchanged)', () => {
    const input = ['---', 'tags: foo bar', '---', 'body'].join('\n');
    const out = addTagToMarkdown(input, 'baz');
    expect(out).toMatch(/- foo/);
    expect(out).toMatch(/- bar/);
    expect(out).toMatch(/- baz/);
  });
});

// ── Audit 2.2 ─────────────────────────────────────────────────────────────
// Tag identity is case-INSENSITIVE everywhere else (registry
// `canonicaliseTagName`, `vaultIndex.filesByTag`, `frontmatterSync.valuesEqual`
// — all fold via `toLocaleLowerCase('en-US')`), but the frontmatter rewriter
// compared with strict `===`. So a file whose YAML spells the tag `Project`
// (authored in Obsidian, or a first-seen capital the registry preserved) was
// skipped when renaming/removing the registry's `project`, and adding `project`
// to a file holding `Project` appended a duplicate. Casing of the NEW name and
// the leading-`#` decision must still be taken from the file/registry as-is.
describe('tag rewriter — case-insensitive identity (Audit 2.2)', () => {
  it('rewrites a case-variant tag (block form)', () => {
    const input = ['---', 'tags:', '  - Project', '  - keep', '---', 'body'].join('\n');
    const out = rewriteTagInMarkdown(input, 'project', 'done');
    expect(out).toMatch(/^\s*- done$/m);
    expect(out).not.toMatch(/Project/);
    expect(out).toMatch(/- keep/);
  });

  it('rewrites a case-variant tag and preserves the new name casing + leading #', () => {
    const input = ['---', 'tags: [#Project, Other]', '---', 'body'].join('\n');
    const out = rewriteTagInMarkdown(input, 'project', 'Done');
    expect(out).toContain('#Done'); // # decision carried from the original token
    expect(out).toContain('Other');
    expect(out).not.toContain('Project');
  });

  it('removes a case-variant tag', () => {
    const input = ['---', 'tags:', '  - Project', '  - keep', '---', 'body'].join('\n');
    const out = removeTagFromMarkdown(input, 'project');
    expect(out).not.toMatch(/Project/);
    expect(out).toMatch(/- keep/);
  });

  it('is idempotent when adding a case-variant that already exists (no duplicate)', () => {
    const input = ['---', 'tags:', '  - Project', '---', 'body'].join('\n');
    const out = addTagToMarkdown(input, 'project');
    expect(out).toBe(input);
  });
});

// ── 7.5 ───────────────────────────────────────────────────────────────────
// The line-level rewriter declines a `tags:` field defined via a YAML anchor
// (`tags: &x [..]`) or alias (`tags: *x`). The historical fallback was the
// js-yaml load→dump path, but `dump({ noRefs: true })` EXPANDS the anchor and
// re-emits the whole block — a larger, more surprising mutation than the
// documented comment loss. So every rewriter now SKIPS an anchored/aliased
// tags field and returns the file byte-for-byte unchanged.
describe('tag rewriter — anchored/aliased tags field is left untouched (7.5)', () => {
  const aliased = [
    '---',
    'common: &shared',
    '  - alpha',
    '  - beta',
    'tags: *shared',
    '---',
    'body',
    '',
  ].join('\n');

  it('does not expand an aliased tags field on rename', () => {
    expect(rewriteTagInMarkdown(aliased, 'alpha', 'gamma')).toBe(aliased);
  });

  it('does not expand an aliased tags field on remove', () => {
    expect(removeTagFromMarkdown(aliased, 'alpha')).toBe(aliased);
  });

  it('does not expand an aliased tags field on add', () => {
    expect(addTagToMarkdown(aliased, 'delta')).toBe(aliased);
  });

  it('does not expand an anchor defined directly on the tags field', () => {
    const anchored = ['---', 'tags: &t [alpha, beta]', '---', 'body', ''].join('\n');
    expect(removeTagFromMarkdown(anchored, 'alpha')).toBe(anchored);
    expect(rewriteTagInMarkdown(anchored, 'alpha', 'gamma')).toBe(anchored);
    expect(addTagToMarkdown(anchored, 'delta')).toBe(anchored);
  });
});

// ── 1.3 ───────────────────────────────────────────────────────────────────
// `addTagToMarkdown` reaches the js-yaml load→dump fallback whenever the file
// already has a top-level `tags:` field (so the string→array upgrade semantics
// are preserved). On UNPARSEABLE YAML `loadYamlObject` returns null; the old
// code did `?? {}` and proceeded, so `yaml.dump` emitted ONLY a `tags:` block —
// every other key (title, aliases, …) was silently erased on the next save.
// Its siblings (`rewriteTagInMarkdown`, `removeTagFromMarkdown`) already guard
// with `if (!fm) return rawContent`; addTag must do the same — refuse the write
// rather than destroy the block.
describe('addTagToMarkdown — never erases an unparseable frontmatter block (1.3)', () => {
  it('returns the input unchanged when a duplicate key makes the YAML unparseable', () => {
    // js-yaml throws "duplicated mapping key" on `title` → the block can't be
    // round-tripped, so the safe behaviour is to leave the file untouched.
    const input = ['---', 'title: X', 'title: Y', 'tags:', '  - foo', '---', 'body'].join('\n');
    expect(addTagToMarkdown(input, 'bar')).toBe(input);
  });

  it('returns the input unchanged when a tab in indentation makes the YAML unparseable', () => {
    // A tab character in indentation is illegal YAML → js-yaml throws. The
    // `tags:` field is present so addTag takes the load→dump path; it must not
    // erase `title` / the existing `foo` tag.
    const input = ['---', 'title: X', 'tags:', '  - foo', '\tbad: tab', '---', 'body'].join('\n');
    expect(addTagToMarkdown(input, 'bar')).toBe(input);
  });
});

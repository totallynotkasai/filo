import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import { rewriteTagInMarkdown, removeTagFromMarkdown, addTagToMarkdown } from '@renderer/lib/vault/tagRewriter';

/**
 * Extracts a result file's frontmatter block and parses it. THROWS if the
 * rewrite produced invalid YAML (e.g. a duplicate `tags:` key), so a test can
 * assert the output round-trips cleanly.
 */
function frontmatterObjectOf(md: string): Record<string, unknown> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) throw new Error('no frontmatter fence found');
  const loaded = yaml.load(m[1]);
  if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) {
    throw new Error('frontmatter did not parse to an object');
  }
  return loaded as Record<string, unknown>;
}

/** Any `\n` NOT preceded by `\r` — i.e. a lone LF that broke CRLF fidelity. */
const LONE_LF = /[^\r]\n/;

// 6.4.M9 — the shared FRONTMATTER_FENCE regex required `---` immediately
// followed by a newline. A fence with trailing whitespace (`--- `) therefore
// parsed as "no frontmatter", so addTagToMarkdown fell through to the
// no-frontmatter branch and PREPENDED a second `---` block, duplicating
// frontmatter and orphaning the original keys in the body. The fence now
// tolerates trailing horizontal whitespace.
describe('tagRewriter — fence with trailing whitespace (6.4.M9)', () => {
  it('addTagToMarkdown edits the existing block, not a prepended duplicate', () => {
    const src = '--- \ntitle: Foo\n--- \nbody';
    const out = addTagToMarkdown(src, 'newtag');
    // Exactly one frontmatter block (two `---` fence lines), not four.
    const fenceLines = out.match(/^---/gm) ?? [];
    expect(fenceLines).toHaveLength(2);
    // frontmatterObjectOf throws on a duplicate/invalid block.
    const fm = frontmatterObjectOf(out);
    expect(fm.title).toBe('Foo');
    expect(fm.tags).toContain('newtag');
    expect(out).toContain('body');
  });

  it('rewriteTagInMarkdown sees the existing tags through a trailing-ws fence', () => {
    const src = '--- \ntags:\n  - foo\n--- \nbody';
    const out = rewriteTagInMarkdown(src, 'foo', 'bar');
    expect(out).toMatch(/- bar/);
    expect(out).not.toMatch(/^\s*- foo$/m);
  });
});

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

// ── 1.4 ───────────────────────────────────────────────────────────────────
// CRLF files (the Windows / Notepad / VS Code / Obsidian default) defeated the
// line-level rewriter: `TAGS_HEADER_RE` (+ the block-item / blank-line checks)
// ran against `yamlSource.split('\n')`, leaving a trailing `\r` on every FM
// line EXCEPT the last (the fence regex strips only that one). JS `.`/`$`
// (no /m) don't cross `\r`, so a `tags:` line that wasn't last never matched.
// Consequences: rename/remove silently fell to the lossy dump path (comment
// loss, reorder, FM→LF) and add saw "no tags field" → spliced a SECOND `tags:`
// block → duplicate key → unparseable → erasure (1.1). User decision: PRESERVE
// the original line endings (don't normalise to LF).
describe('tag rewriter — CRLF files preserve endings + never corrupt (1.4)', () => {
  // `tags:` is a NON-last key (followed by `aliases:`), so on CRLF its line
  // keeps a trailing `\r` and the pre-fix regex never matched it.
  const crlf = [
    '---',
    '# keep me',
    'title: My Note',
    'tags:',
    '  - foo',
    '  - bar',
    'aliases:',
    '  - mn',
    '---',
    'body',
    '',
  ].join('\r\n');

  it('renames a tag in place, preserving the comment, siblings and CRLF', () => {
    const out = rewriteTagInMarkdown(crlf, 'foo', 'baz');
    expect(out).toContain('# keep me'); // comment survives (dump path dropped it)
    expect(out).not.toMatch(LONE_LF); // every newline stays CRLF
    const fm = frontmatterObjectOf(out); // re-parses cleanly
    expect(fm.tags).toEqual(['baz', 'bar']);
    expect(fm.title).toBe('My Note');
    expect(fm.aliases).toEqual(['mn']);
  });

  it('removes a tag in place, preserving the comment, siblings and CRLF', () => {
    const out = removeTagFromMarkdown(crlf, 'foo');
    expect(out).toContain('# keep me');
    expect(out).not.toMatch(LONE_LF);
    const fm = frontmatterObjectOf(out);
    expect(fm.tags).toEqual(['bar']);
    expect(fm.title).toBe('My Note');
  });

  it('adds a tag without creating a duplicate tags: key or erasing data, preserving CRLF', () => {
    // The file already HAS a `tags:` field, so add takes the documented
    // load→dump path (which upgrades string→array and, per the accepted
    // KNOWN_LIMITATION, drops YAML comments — same on LF). 1.4's guarantee here
    // is narrower but critical: hasTagsHeader now sees the `\r`-terminated line,
    // so add appends to the existing block instead of splicing a SECOND `tags:`
    // key (which made the file unparseable → erased via 1.1). Endings stay CRLF
    // and every DATA key survives.
    const out = addTagToMarkdown(crlf, 'new');
    expect((out.match(/^tags\s*:/gm) ?? []).length).toBe(1); // no second block
    expect(out).not.toMatch(LONE_LF); // CRLF preserved
    const fm = frontmatterObjectOf(out); // throws on a duplicate-key block
    expect(fm.tags).toEqual(['foo', 'bar', 'new']);
    expect(fm.title).toBe('My Note'); // data survives the dump path
    expect(fm.aliases).toEqual(['mn']);
  });

  it('add is idempotent (byte-identical) on a CRLF file when the tag exists', () => {
    // Pre-fix this spliced a duplicate `tags:` block because hasTagsHeader was
    // blind to the `\r`-terminated line.
    expect(addTagToMarkdown(crlf, 'foo')).toBe(crlf);
  });

  it('rewrites a CRLF flow-form tags field in place without flipping to LF', () => {
    const flow = ['---', 'title: X', 'tags: [foo, bar]', 'aliases:', '  - mn', '---', 'body', ''].join('\r\n');
    const out = rewriteTagInMarkdown(flow, 'foo', 'baz');
    expect(out).not.toMatch(LONE_LF);
    const fm = frontmatterObjectOf(out);
    expect(fm.tags).toEqual(['baz', 'bar']);
    expect(fm.title).toBe('X');
  });

  it('still rewrites a CRLF note where tags: IS the last key (regression guard)', () => {
    // This case worked before the fix (the fence strips the last line's `\r`);
    // assert the fix didn't regress it and keeps CRLF.
    const lastKey = ['---', 'title: X', 'tags:', '  - foo', '  - bar', '---', 'body', ''].join('\r\n');
    const out = removeTagFromMarkdown(lastKey, 'foo');
    expect(out).not.toMatch(LONE_LF);
    const fm = frontmatterObjectOf(out);
    expect(fm.tags).toEqual(['bar']);
  });
});

// ── 1.5 + 1.6 ──────────────────────────────────────────────────────────────
// renderTagsField emitted every surviving tag BARE, so (1.5) renaming a tag to
// a YAML-special name (@home, 123, null) produced invalid or type-coerced YAML,
// and (1.6) removing/renaming an UNRELATED tag stripped the quotes off a quoted
// sibling — a file holding `[draft, "@home"]` lost the quotes on `@home` the
// instant `draft` was removed → bare `@home` → unparseable. The fix renders
// each scalar with exactly the quoting js-yaml needs (flow context, which is
// also block-safe). The UI rejects such names on create/rename (1.5a); this is
// the on-disk defence-in-depth for names authored externally (e.g. in Obsidian).
describe('tag rewriter — emitted scalars are quoted so YAML never corrupts (1.5/1.6)', () => {
  it('keeps a quoted flow-sibling quoted when an unrelated tag is removed (1.6)', () => {
    const input = ['---', 'tags: [draft, "@home"]', '---', 'body'].join('\n');
    const out = removeTagFromMarkdown(input, 'draft');
    const fm = frontmatterObjectOf(out); // pre-fix: bare @home → js-yaml throws
    expect(fm.tags).toEqual(['@home']);
  });

  it('keeps a quoted block-sibling quoted when an unrelated tag is removed (1.6)', () => {
    const input = ['---', 'tags:', '  - draft', "  - '@home'", '---', 'body'].join('\n');
    const out = removeTagFromMarkdown(input, 'draft');
    const fm = frontmatterObjectOf(out);
    expect(fm.tags).toEqual(['@home']);
  });

  it('quotes a renamed tag that needs it, round-tripping to the intended string (1.5)', () => {
    // The UI blocks renaming TO @home, but the rewriter must still emit valid
    // YAML if handed such a name (defence in depth).
    const input = ['---', 'tags:', '  - foo', '  - keep', '---', 'body'].join('\n');
    const out = rewriteTagInMarkdown(input, 'foo', '@home');
    const fm = frontmatterObjectOf(out);
    expect(fm.tags).toEqual(['@home', 'keep']);
  });

  it('quotes numeric / boolean / null names so they stay strings, not coerced (1.5)', () => {
    for (const special of ['123', 'true', 'null']) {
      const input = ['---', 'tags:', '  - foo', '---', 'body'].join('\n');
      const out = rewriteTagInMarkdown(input, 'foo', special);
      const fm = frontmatterObjectOf(out);
      expect(fm.tags).toEqual([special]); // a string, not a number/bool/null
    }
  });

  it('leaves an all-safe comma-string field in its original shape', () => {
    const input = ['---', 'tags: foo, bar', '---', 'body'].join('\n');
    const out = rewriteTagInMarkdown(input, 'foo', 'baz');
    expect(out).toContain('tags: baz, bar'); // not needlessly upgraded to flow
  });
});

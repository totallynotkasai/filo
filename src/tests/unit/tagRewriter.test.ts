import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import { parseDocument } from 'yaml';
import {
  rewriteTagInMarkdown,
  removeTagFromMarkdown,
  addTagToMarkdown,
  emitTagScalar,
} from '@renderer/lib/vault/tagRewriter';

/**
 * Extracts a result file's frontmatter block and parses it. THROWS if the
 * rewrite produced invalid YAML (e.g. a duplicate `tags:` key), so a test can
 * assert the output round-trips cleanly.
 */
function frontmatterObjectOf(md: string): Record<string, unknown> {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---/.exec(md);
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
    // The file's own fence lines are kept as they were.
    expect(out.startsWith('--- \n')).toBe(true);
    expect(out.endsWith('\n--- \nbody')).toBe(true);
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

  it('keeps a string-form tag with a space as one tag when adding another', () => {
    const input = ['---', 'tags: foo bar', '---', 'body'].join('\n');
    const out = addTagToMarkdown(input, 'baz');
    expect(out).toContain('tags:\n  - foo bar\n  - baz\n');
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
    expect(out).toBe(['---', 'title: X', 'tags:', '  - a', '---', 'body'].join('\n'));
  });

  // 3.2 (Audit-18) — the fresh tags block now APPENDS after every existing
  // line instead of splicing before a single trailing blank line, and
  // `reassemble` re-emits the one separator newline, so the FM's trailing
  // blank line survives instead of being collapsed.
  it('appends the tags block and preserves the FM trailing blank line (3.2)', () => {
    const input = ['---', 'title: X', '', '---', 'body'].join('\n');
    const out = addTagToMarkdown(input, 'a');
    // The blank line the file carried is preserved (no value/structure drift).
    expect(out).toBe(['---', 'title: X', '', 'tags:', '  - a', '---', 'body'].join('\n'));
  });

  // 3.2 (Audit-18) — leg (b): `splitFrontmatter`/`reassemble` used to collapse
  // the FM's trailing blank line on EVERY successful tag edit (the fast path
  // included). When that blank is SEMANTIC — the keep-chomped trailing newline a
  // `notes: |+` scalar owns as its LAST key — the collapse was a silent VALUE
  // change a parse-only validation passes. `reassemble` now re-emits the one
  // separator newline, so a line-path tag edit preserves the `|+` value verbatim.
  it('preserves a trailing |+ block scalar’s value on a line-path tag edit (3.2)', () => {
    const input = ['---', 'tags:', '  - x', '  - y', 'notes: |+', '  hello', '', '---', 'body'].join('\n');
    const out = removeTagFromMarkdown(input, 'y');
    // The blank line after `hello` is the keep-chomped trailing newline `|+`
    // owns; it survives byte-for-byte (the pre-fix reassemble collapsed it).
    expect(out).toBe(
      ['---', 'tags:', '  - x', 'notes: |+', '  hello', '', '---', 'body'].join('\n'),
    );
  });

  // 3.2 (Audit-18) — leg (b), the verifier superset: the trailing blank is
  // preserved on EVERY successful tag edit, not just the |+ case.
  it('preserves a cosmetic FM trailing blank line on a tag remove (3.2)', () => {
    const input = ['---', 'tags:', '  - x', '  - y', '', '---', 'body'].join('\n');
    const out = removeTagFromMarkdown(input, 'y');
    expect(out).toBe(['---', 'tags:', '  - x', '', '---', 'body'].join('\n'));
  });

  // 3.1 (Audit-18) — a zero-interior fence pair (`---\n---\n`, a common empty
  // frontmatter placeholder) is now recognised as an EMPTY frontmatter block, so
  // a tag-add edits that block instead of PREPENDING a second `---` block above
  // the orphaned fences (which used to demote them into the body).
  it('adds a tag into an EMPTY frontmatter block instead of prepending a duplicate (3.1)', () => {
    const input = ['---', '---', 'body'].join('\n');
    const out = addTagToMarkdown(input, 'a');
    expect(out).toBe(['---', 'tags:', '  - a', '---', 'body'].join('\n'));
    // Exactly one frontmatter fence pair — no orphaned second block.
    expect(out.match(/^---$/gm)?.length).toBe(2);
  });

  it('still upgrades a comma string-form field via the dump path (unchanged)', () => {
    const input = ['---', 'tags: foo, bar', '---', 'body'].join('\n');
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

  // 5.5 (Audit-16) — the original anchored check inspected only the START of
  // the header value, so an alias INSIDE the collection reported "not anchored"
  // and fell through to the load→dump fallback: the alias was resolved on the
  // load, the CST engine refused (alias on the changed tags key), and the dump
  // re-emitted the WHOLE frontmatter from the resolved object — anchors on
  // other keys dropped, aliases inlined, comments lost. The widened scan covers
  // the full value range (flow items + block items), so these skip instead.
  it('5.5 — an alias INSIDE a flow collection skips the rewrite (file untouched)', () => {
    const flowAlias = [
      '---',
      'keep: &s shared',
      '# a comment the dump would destroy',
      'tags: [*s]',
      '---',
      'body',
      '',
    ].join('\n');
    expect(rewriteTagInMarkdown(flowAlias, 'shared', 'work')).toBe(flowAlias);
    expect(removeTagFromMarkdown(flowAlias, 'shared')).toBe(flowAlias);
    expect(addTagToMarkdown(flowAlias, 'delta')).toBe(flowAlias);
  });

  it('5.5 — an alias as a BLOCK item skips the rewrite (file untouched)', () => {
    const blockAlias = [
      '---',
      'keep: &s shared',
      '# a comment the dump would destroy',
      'tags:',
      '  - literal',
      '  - *s',
      '---',
      'body',
      '',
    ].join('\n');
    expect(rewriteTagInMarkdown(blockAlias, 'shared', 'work')).toBe(blockAlias);
    expect(removeTagFromMarkdown(blockAlias, 'shared')).toBe(blockAlias);
    expect(addTagToMarkdown(blockAlias, 'delta')).toBe(blockAlias);
    // The literal sibling is ALSO protected: a remove of it would re-emit the
    // alias item as a quoted literal, so the whole field skips.
    expect(removeTagFromMarkdown(blockAlias, 'literal')).toBe(blockAlias);
  });

  it('5.5 — an ANCHOR defined on a flow/block item skips the rewrite', () => {
    const flowAnchor = ['---', 'tags: [&t alpha, beta]', '---', 'body', ''].join('\n');
    expect(rewriteTagInMarkdown(flowAnchor, 'alpha', 'gamma')).toBe(flowAnchor);
    const blockAnchor = ['---', 'tags:', '  - &t alpha', '  - beta', '---', 'body', ''].join('\n');
    expect(removeTagFromMarkdown(blockAnchor, 'beta')).toBe(blockAnchor);
  });

  it('5.5 — a QUOTED tag merely containing &/* still takes the established path', () => {
    const quoted = ['---', 'title: X', "tags: ['*not-an-alias', foo]", '---', 'body', ''].join('\n');
    const out = rewriteTagInMarkdown(quoted, 'foo', 'bar');
    expect(out).toContain('bar');
    expect(out).toContain('*not-an-alias'); // sibling intact, file rewritten
    expect(out).toContain('title: X');
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

// ── Phase 6.4 ───────────────────────────────────────────────────────────────
// The per-tag quoting oracle `emitTagScalar` was re-implemented on the `yaml`
// package (was js-yaml), removing the last js-yaml use from the tag write path.
// js-yaml's default `dump` was deliberately YAML-1.1-conservative — it quoted
// every name a 1.1 reader would otherwise coerce (`yes`/`no`, `1_000`,
// `2024-01-01`, `1:30`) so the tag stayed a STRING everywhere, including the
// vault-index CORE read under which an unquoted `1_000` resolves to the NUMBER
// 1000. The replacement reproduces that conservatism with `version: '1.1'` and
// matches the single-quote preference with `singleQuote: true`. This is the
// quoting-oracle PARITY test the refactor plan calls for: it runs both oracles
// over a YAML-hostile name table and asserts the new output (a) always
// round-trips to the exact string in flow AND block context under js-yaml
// DEFAULT, js-yaml CORE, and the `yaml` package, and (b) is byte-identical to
// the old oracle except a small allowlist of cosmetic, round-trip-safe diffs.
describe('emitTagScalar — quoting-oracle parity with the pre-6.4 js-yaml oracle (Phase 6.4)', () => {
  // The EXACT pre-6.4 implementation (js-yaml DEFAULT schema = YAML 1.1).
  function oldEmitTagScalar(tag: string): string {
    return yaml.dump([tag], { flowLevel: 0, lineWidth: -1 }).replace(/\n$/, '').slice(1, -1).trim();
  }

  // Recover the first list element from `[X]` (flow) or `tags:\n  - X` (block).
  function firstItem(parsed: unknown): unknown {
    if (Array.isArray(parsed)) return parsed[0];
    if (parsed && typeof parsed === 'object' && 'tags' in parsed) {
      const t = (parsed as { tags: unknown }).tags;
      return Array.isArray(t) ? t[0] : undefined;
    }
    return undefined;
  }

  // An emitted scalar must read back as the EXACT original string in both flow
  // and block context, under all three parsers that touch a tag on disk: js-yaml
  // DEFAULT (the strictest YAML-1.1 resolver + the tagRewriter test parser),
  // js-yaml CORE (the vault index, pre-6.5), and the `yaml` package (the read
  // path + the write engine's compare).
  function roundTripsEverywhere(scalar: string, tag: string): boolean {
    const readers: Array<(doc: string) => unknown> = [
      (d) => yaml.load(d),
      (d) => yaml.load(d, { schema: yaml.CORE_SCHEMA }),
      (d) => parseDocument(d, { logLevel: 'error' }).toJS(),
    ];
    const docs = [`[${scalar}]`, `tags:\n  - ${scalar}\n`];
    for (const read of readers) {
      for (const doc of docs) {
        let got: unknown;
        try {
          got = firstItem(read(doc));
        } catch {
          return false;
        }
        if (got !== tag) return false;
      }
    }
    return true;
  }

  const HOSTILE_TAGS = [
    'foo', 'project/sub', 'foo/bar/baz', '@home', '123', '0', '-7', '3.14', 'true', 'false',
    'null', 'yes', 'no', 'on', 'off', 'a, b', 'a,b', 'a: b', 'a:b', '? q', '#hash', '[bracket',
    ']bracket', '{brace', '}brace', '&anchor', '*alias', '!bang', '|pipe', '>fold', '%percent',
    '@at', '`tick', '"quote', "'apos", 'tab\tinside', ' leading', 'trailing ', 'multi word',
    'CamelCase', 'UPPER', '日本語', 'emoji😀', '1_000', '0xFF', '.inf', '.nan', '=', '~', 'a#b',
    'http://x.com', '2024-01-01', 'v1.2.3', 'a"b', "a'b", 'a\\b', '', ' ', 'a  b', 'null ',
    ' true', 'NaN', '.NaN', '+5', '007', '1:30',
  ];

  // Names whose `yaml`-package emission BYTE-differs from the old js-yaml oracle.
  // Each re-parses to the identical string under every reader/context (asserted
  // below), so the difference is cosmetic — never a round-trip regression:
  //  - "'apos":      double-quoted vs the old doubled-single-quote form
  //  - "=":          bare (a valid plain scalar) vs the old defensive single-quote
  //  - "tab\tinside": bare (a valid plain scalar) vs the old double-quoted escape
  //  - "1_000":     quoted (1.1-conservative) vs bare — js-yaml >=4.3 stopped
  //                 resolving `1_000` as an int, so the ORACLE now emits it bare
  const ALLOWED_DIVERGENCES = new Set(["'apos", '=', 'tab\tinside', '1_000']);

  it('every hostile tag round-trips, and byte-matches the old oracle except a known-safe allowlist', () => {
    const unexpected: string[] = [];
    for (const tag of HOSTILE_TAGS) {
      const next = emitTagScalar(tag);
      const old = oldEmitTagScalar(tag);
      expect(
        roundTripsEverywhere(next, tag),
        `new emit of ${JSON.stringify(tag)} (${JSON.stringify(next)}) must round-trip everywhere`,
      ).toBe(true);
      if (next !== old) {
        // A byte difference is acceptable ONLY if it still round-trips (so the
        // old form was equally just a style choice) AND it is allowlisted.
        expect(
          roundTripsEverywhere(old, tag),
          `old emit of ${JSON.stringify(tag)} should also round-trip`,
        ).toBe(true);
        if (!ALLOWED_DIVERGENCES.has(tag)) {
          unexpected.push(`${JSON.stringify(tag)}: old=${JSON.stringify(old)} new=${JSON.stringify(next)}`);
        }
      }
    }
    expect(unexpected, `unexpected byte divergences from the old oracle:\n${unexpected.join('\n')}`).toEqual([]);
  });

  it('quotes YAML-special and YAML-1.1-ambiguous names so they stay strings', () => {
    // The 1.1-ambiguous group (yes/no, 1_000, dates, sexagesimal) is the reason
    // `version: '1.1'` is load-bearing: a 1.2-core emit would leave these bare.
    for (const special of ['@home', '123', 'true', 'false', 'null', 'yes', 'no', '1_000', '2024-01-01', '1:30']) {
      const next = emitTagScalar(special);
      expect(next, `${JSON.stringify(special)} must be quoted, not emitted bare`).not.toBe(special);
      expect(roundTripsEverywhere(next, special), `${JSON.stringify(special)} must round-trip`).toBe(true);
    }
  });

  it('leaves a plain safe name bare (no needless quoting)', () => {
    for (const safe of ['foo', 'project/sub', 'CamelCase', 'a:b', 'a#b', 'v1.2.3']) {
      expect(emitTagScalar(safe)).toBe(safe);
    }
  });
});

// ── Phase 6.4 / M2 ──────────────────────────────────────────────────────────
// `loadYamlObject` now parses with the `yaml` package — the SAME parser the
// source-preserving engine (`patchFrontmatterSourceCst`) derives its
// value-compare object from. Under the old js-yaml CORE load, `1_000` / `0b1010`
// became the NUMBERS 1000 / 10, while the engine's `doc.toJS()` compare kept the
// STRINGS "1_000" / "0b1010". A tag op routed through the load → patch FALLBACK
// therefore saw an UNTOUCHED cross-parser-divergent sibling as "changed" and
// canonicalised it on disk. These inputs reach the fallback (a `*` inside the
// flow value makes `locateTagsField` decline the fast line rewrite) and assert
// the divergent sibling survives byte-for-byte.
describe('tag rewriter — fallback path preserves cross-parser scalars (Phase 6.4 / M2)', () => {
  it('keeps an untouched 1_000 sibling verbatim through the load→patch fallback', () => {
    const input = ['---', 'thousands: 1_000', 'tags: [foo, a*b]', '---', 'body'].join('\n');
    const out = rewriteTagInMarkdown(input, 'foo', 'x');
    expect(out, 'the fallback rewrite should have engaged').not.toBe(input);
    expect(out).toContain('thousands: 1_000'); // NOT canonicalised to 1000
    expect(out).not.toContain('thousands: 1000');
  });

  it('keeps an untouched 0b1010 sibling verbatim through the load→patch fallback', () => {
    const input = ['---', 'flags: 0b1010', 'tags: [foo, a*b]', '---', 'body'].join('\n');
    const out = removeTagFromMarkdown(input, 'foo');
    expect(out, 'the fallback rewrite should have engaged').not.toBe(input);
    expect(out).toContain('flags: 0b1010'); // NOT canonicalised to 10
  });
});

// ── Audit-10 H1 ──────────────────────────────────────────────────────────────
// The line-level fast path's hand-rolled tokenizer doesn't FAIL on shapes it
// can't represent — it SUCCEEDS with a WRONG value, so `renderTagsField` then
// re-emits the corruption and a SIBLING tag is silently mangled by an unrelated
// tag op:
//  - a block item with an inline `# comment` (`beta # note`) was swallowed whole
//    into the tag text;
//  - a flow / scalar list with a quoted comma (`[draft, "b,c"]`) was cut THROUGH
//    by the naive `split(',')`, splitting one tag into two malformed ones;
//  - a YAML-escaped quote (`'it''s'`) couldn't be unwrapped by `QUOTED_RE`.
// `locateTagsField` now declines these (returns null) so the edit takes the
// load → CST fallback, which tokenises them correctly. The data guarantee tested
// here is sibling-VALUE correctness; the inline comment on a CHANGED `tags:`
// field is dropped by the source-preserving engine (an accepted limitation, like
// L23/L28) — the point is the value is no longer corrupted. Cleanly single/
// double-quoted siblings (`'@home'`) still ride the fast path (covered above).
describe('tag rewriter — declines un-tokenizable shapes, sibling survives (Audit-10 H1)', () => {
  it('block + inline comment: removing a sibling leaves the commented tag clean', () => {
    const input = ['---', 'tags:', '  - alpha', '  - beta # note', '  - gamma', '---', 'body'].join('\n');
    const out = removeTagFromMarkdown(input, 'alpha');
    const fm = frontmatterObjectOf(out);
    expect(fm.tags).toEqual(['beta', 'gamma']); // 'beta', NOT 'beta # note'
    expect(out).not.toContain('beta # note');
  });

  it('block + inline comment: renaming a sibling leaves the commented tag clean', () => {
    const input = ['---', 'tags:', '  - alpha', '  - beta # note', '  - gamma', '---', 'body'].join('\n');
    const out = rewriteTagInMarkdown(input, 'alpha', 'delta');
    const fm = frontmatterObjectOf(out);
    expect(fm.tags).toEqual(['delta', 'beta', 'gamma']);
    expect(out).not.toContain('beta # note');
  });

  it('block + inline comment: adding a tag leaves the commented sibling clean', () => {
    // addTagToMarkdown already routes an existing tags field through the parser
    // fallback (never locateTagsField), so the sibling was always safe here —
    // this pins that it stays safe.
    const input = ['---', 'tags:', '  - alpha', '  - beta # note', '---', 'body'].join('\n');
    const out = addTagToMarkdown(input, 'zeta');
    const fm = frontmatterObjectOf(out);
    expect(fm.tags).toEqual(['alpha', 'beta', 'zeta']);
    expect(out).not.toContain('beta # note');
  });

  it('flow + quoted comma: renaming a sibling keeps the comma-bearing tag whole', () => {
    const input = ['---', 'tags: [draft, "b,c"]', '---', 'body'].join('\n');
    const out = rewriteTagInMarkdown(input, 'draft', 'pub');
    const fm = frontmatterObjectOf(out);
    expect(fm.tags).toEqual(['pub', 'b,c']); // one tag 'b,c', NOT 'b' + 'c'
  });

  it('flow + quoted comma: removing a sibling keeps the comma-bearing tag whole', () => {
    const input = ['---', 'tags: [draft, "b,c"]', '---', 'body'].join('\n');
    const out = removeTagFromMarkdown(input, 'draft');
    const fm = frontmatterObjectOf(out);
    expect(fm.tags).toEqual(['b,c']);
  });

  it('block + escaped quote: removing a sibling preserves the escaped value', () => {
    const input = ['---', 'tags:', '  - alpha', "  - 'it''s'", '---', 'body'].join('\n');
    const out = removeTagFromMarkdown(input, 'alpha');
    const fm = frontmatterObjectOf(out);
    expect(fm.tags).toEqual(["it's"]); // unwrapped to it's, NOT it''s / it
  });

  it('block + escaped quote: renaming a sibling preserves the escaped value', () => {
    const input = ['---', 'tags:', '  - alpha', "  - 'it''s'", '---', 'body'].join('\n');
    const out = rewriteTagInMarkdown(input, 'alpha', 'delta');
    const fm = frontmatterObjectOf(out);
    expect(fm.tags).toEqual(['delta', "it's"]);
  });

  it('scalar + inline comment: removing a sibling keeps the value clean (comment survives)', () => {
    const input = ['---', 'tags: foo, bar # note', '---', 'body'].join('\n');
    const out = removeTagFromMarkdown(input, 'foo');
    const fm = frontmatterObjectOf(out);
    // The bug emitted a tag literally NAMED 'bar # note' (comment swallowed into
    // the value). The fix yields the clean value 'bar'; the single-line-scalar
    // CST rewrite even PRESERVES the inline comment as a real YAML comment.
    expect(normaliseToArray(fm.tags)).toEqual(['bar']); // value is 'bar', not 'bar # note'
    expect(out).toContain('# note'); // comment preserved by the value-only rewrite
  });

  it('a non-comment `#` inside a plain scalar (a#b) still rides the fast path', () => {
    // `a#b` has no whitespace before `#`, so it is a legal plain scalar, not a
    // comment — the guard must NOT divert it (it would still be correct via the
    // fallback, but this pins the fast-path discrimination the comment relies on).
    const input = ['---', 'tags:', '  - a#b', '  - keep', '---', 'body'].join('\n');
    const out = removeTagFromMarkdown(input, 'keep');
    const fm = frontmatterObjectOf(out);
    expect(fm.tags).toEqual(['a#b']);
  });
});

/** Normalises a tags field that may be a string or array into an array. */
function normaliseToArray(tags: unknown): string[] {
  if (Array.isArray(tags)) return tags as string[];
  if (typeof tags === 'string') return tags.split(',').map((t) => t.trim()).filter(Boolean);
  return [];
}

describe('Audit-11 T1 — merge-rename dedups the tag list', () => {
  it('rename onto an existing tag yields ONE entry, not a duplicate (flow list)', () => {
    const md = '---\ntags: [draft, review]\n---\nBody\n';
    const out = rewriteTagInMarkdown(md, 'draft', 'review');
    // frontmatterObjectOf THROWS on a duplicate `tags:` / invalid YAML, so the
    // round-trip itself proves no `[review, review]` was emitted.
    const fm = frontmatterObjectOf(out);
    expect(normaliseToArray(fm.tags)).toEqual(['review']);
  });

  it('rename onto an existing tag yields ONE entry (block list)', () => {
    const md = '---\ntags:\n  - draft\n  - review\n---\nBody\n';
    const out = rewriteTagInMarkdown(md, 'draft', 'review');
    const fm = frontmatterObjectOf(out);
    expect(normaliseToArray(fm.tags)).toEqual(['review']);
  });

  it('case-insensitive collision dedups to one entry', () => {
    const md = '---\ntags: [Draft, review]\n---\nBody\n';
    const out = rewriteTagInMarkdown(md, 'draft', 'review');
    const fm = frontmatterObjectOf(out);
    expect(normaliseToArray(fm.tags).length).toBe(1);
  });

  it('a non-merge rename keeps every (now-distinct) tag — no spurious collapse', () => {
    const md = '---\ntags: [draft, urgent]\n---\nBody\n';
    const out = rewriteTagInMarkdown(md, 'draft', 'review');
    const fm = frontmatterObjectOf(out);
    expect(normaliseToArray(fm.tags)).toEqual(['review', 'urgent']);
  });
});

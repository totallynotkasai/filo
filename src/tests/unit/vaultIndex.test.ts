import { describe, it, expect } from 'vitest';
import { VaultIndex, parseMarkdown, countTagsInInlineTiles, collectMarkdownPaths } from '@renderer/lib/vault/vaultIndex';
import type { FileTreeNode } from '../../shared/types';

describe('parseMarkdown', () => {
  it('extracts frontmatter, title, tags and the body', () => {
    const md = `---
title: Meeting Notes
tags: [work, urgent, todo, project/subproject]
status: active
---

# Meeting Notes

Some intro text with an inline #todo tag and a #project/subproject tag.

## Attendees

- Alice
- Bob

See [[OtherDoc]] and [external link](https://example.com) and [local](./another.md).
`;
    const meta = parseMarkdown('notes/meeting.md', md, 1000);
    expect(meta.path).toBe('notes/meeting.md');
    expect(meta.title).toBe('Meeting Notes');
    expect(meta.frontmatter.status).toBe('active');
    // The body without its frontmatter: what search matches against.
    expect(meta.content.startsWith('\n# Meeting Notes')).toBe(true);
    expect(meta.content).toContain('[[OtherDoc]]');
    expect(meta.rawFrontmatter).toContain('status: active');

    expect(meta.tags).toContain('work');
    expect(meta.tags).toContain('urgent');
    expect(meta.tags).toContain('todo');
    expect(meta.tags).toContain('project/subproject');
  });

  it('falls back to the filename stem when there is no frontmatter title', () => {
    const meta = parseMarkdown('inbox/Quick Note.md', 'Just some body text.');
    expect(meta.title).toBe('Quick Note');
  });

  it('does NOT extract inline #tag runs from the body (decorative only)', () => {
    const md = `# Heading

inline #should-not-appear in body.
`;
    const meta = parseMarkdown('a.md', md);
    expect(meta.tags).toEqual([]);
  });

  it('handles files with no frontmatter (title is the filename stem, not the first heading)', () => {
    const meta = parseMarkdown('plain.md', '# Hello\n\nBody.');
    expect(meta.frontmatter).toEqual({});
    expect(meta.title).toBe('plain');
    expect(meta.tags).toEqual([]);
  });

  it('captures rawFrontmatter when the fence lines carry trailing whitespace (DI-17 M9 parity)', () => {
    // Editors / linters routinely leave a trailing space on a `---` fence. The
    // index fence regex must tolerate it (matching parseMarkdownFile's 6.4.M9
    // `[ \t]*`) so the index's verbatim-bytes view doesn't diverge from the
    // write gateway's. The pre-fix regex (`^---\r?\n`) didn't match `--- \n`,
    // so rawFrontmatter came back empty for such a file.
    const md = '--- \ntitle: Spaced\nstatus: active\n--- \n\n# Body\n';
    const meta = parseMarkdown('spaced.md', md);
    expect(meta.rawFrontmatter).toContain('title: Spaced');
    expect(meta.rawFrontmatter).toContain('status: active');
  });
});

/**
 * Phase 6.5 — the vault index frontmatter read is on the `yaml` package (was
 * js-yaml CORE_SCHEMA), so the index builds its frontmatter object with the SAME
 * parser as `markdownSync.parseMarkdownFile` and the source-preserving write
 * engine. The only two scalar forms where js-yaml CORE and the `yaml` package
 * ever disagreed — `1_000` / `0b1010` (NUMBERS under js-yaml CORE, STRINGS under
 * the `yaml` package) — now surface as strings in the index too, so an
 * exotic-numeric value can't diverge between the index metadata and the
 * documentStore frontmatter and read as a phantom external change (the M2 class).
 */
describe('parseMarkdown — frontmatter on the `yaml` package (Phase 6.5)', () => {
  it('reads 1_000 / 0b1010 as strings, matching parseMarkdownFile (M2 consistency)', () => {
    const md = '---\nthousands: 1_000\nflags: 0b1010\n---\n# Body\n';
    const meta = parseMarkdown('numerics.md', md);
    expect(meta.frontmatter.thousands).toBe('1_000');
    expect(meta.frontmatter.flags).toBe('0b1010');
  });

  it('keeps an unquoted date a string, not a Date (DI-01 preserved)', () => {
    const md = '---\ndue: 2026-06-01\n---\n# Body\n';
    const meta = parseMarkdown('dates.md', md);
    expect(typeof meta.frontmatter.due).toBe('string');
    expect(meta.frontmatter.due).toBe('2026-06-01');
  });

  it('still extracts tags alongside an exotic-numeric sibling (tag indexing unaffected)', () => {
    const md = '---\ntags: [alpha, beta]\nthousands: 1_000\n---\n# Body\n';
    const meta = parseMarkdown('tags.md', md);
    expect(meta.tags.sort()).toEqual(['alpha', 'beta']);
  });
});

/**
 * M2 (Audit-13) — `gray-matter` (its bundled `js-yaml@3` / YAML 1.1) was a
 * reachable SECOND frontmatter parser on the index's fallback paths: on
 * malformed-but-recoverable YAML it coerced an unquoted `date:` → Date and
 * `0b1010` → 10, diverging from the `yaml` package the read/write gateway uses
 * (the "looks changed but isn't" drift class). Both fallbacks now route through
 * the `yaml` package (`lib/vault/frontmatterRead.ts`), so a malformed-recoverable
 * block parses with the SAME string-typed scalars, never a js-yaml coercion.
 */
describe('parseMarkdown — single yaml parser, no gray-matter coercion (Audit-13 M2)', () => {
  it('a tab-indented FM keeps an unquoted date a STRING, not a Date', () => {
    // Tabs are illegal YAML indentation: the `yaml` package reports
    // TAB_AS_INDENT (the old code fell through to gray-matter here), but
    // `.toJS()` still recovers the scalars — as strings. gray-matter / js-yaml v3
    // would have parsed `date:` to a `Date` object.
    const md = '---\ndate: 2024-01-15\nmeta:\n\tnested: 0b1010\n---\n# Body\n';
    const meta = parseMarkdown('tabbed.md', md);
    expect(typeof meta.frontmatter.date).toBe('string');
    expect(meta.frontmatter.date).toBe('2024-01-15');
    // The tab-nested numeric also stays a string (js-yaml v3 → 10).
    expect(meta.frontmatter.nested).toBe('0b1010');
  });

  it('a malformed block still yields no spurious tags (recovers to {} cleanly)', () => {
    // A bare-scalar / non-object recovery must not throw or invent tags.
    const md = '---\n: : :\n---\n# Heading\n';
    const meta = parseMarkdown('weird.md', md);
    expect(meta.tags).toEqual([]);
    expect(meta.content).toContain('# Heading');
  });
});

describe('VaultIndex', () => {
  function makeIndex(): VaultIndex {
    const idx = new VaultIndex();
    idx.upsert(parseMarkdown('a.md', '---\ntags: [alpha]\n---\n# First\nalpha content'));
    idx.upsert(parseMarkdown('b.md', '---\ntags: [beta]\n---\n# Second\nsome words'));
    idx.upsert(parseMarkdown('nested/c.md', '---\nstatus: done\ntags: [alpha]\n---\n# Third'));
    return idx;
  }

  it('indexes files and reports size', () => {
    const idx = makeIndex();
    expect(idx.size()).toBe(3);
    expect(idx.allPaths().sort()).toEqual(['a.md', 'b.md', 'nested/c.md']);
  });

  it('returns files by tag (case-insensitive, strips leading #)', () => {
    const idx = makeIndex();
    expect(idx.filesByTag('alpha').sort()).toEqual(['a.md', 'nested/c.md']);
    expect(idx.filesByTag('#ALPHA').sort()).toEqual(['a.md', 'nested/c.md']);
    expect(idx.filesByTag('beta')).toEqual(['b.md']);
    expect(idx.filesByTag('missing')).toEqual([]);
  });

  it('aggregates all tags with counts', () => {
    const idx = makeIndex();
    const tags = idx.allTags();
    expect(tags.get('alpha')).toBe(2);
    expect(tags.get('beta')).toBe(1);
  });

  it('finds files via full-text search by title', () => {
    const idx = makeIndex();
    const results = idx.query('Second');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].path).toBe('b.md');
  });

  it('finds files via full-text search by content', () => {
    const idx = makeIndex();
    const results = idx.query('alpha content');
    expect(results.some((r) => r.path === 'a.md')).toBe(true);
  });

  it('incrementally updates on upsert of the same path', () => {
    const idx = makeIndex();
    idx.upsert(parseMarkdown('a.md', '---\ntitle: Renamed Title\ntags: [gamma]\n---\nBody'));
    expect(idx.size()).toBe(3);
    expect(idx.filesByTag('alpha')).toEqual(['nested/c.md']);
    expect(idx.filesByTag('gamma')).toEqual(['a.md']);
    expect(idx.get('a.md')?.title).toBe('Renamed Title');
  });

  it('removes a file cleanly', () => {
    const idx = makeIndex();
    idx.remove('a.md');
    expect(idx.size()).toBe(2);
    expect(idx.get('a.md')).toBeNull();
    expect(idx.filesByTag('alpha')).toEqual(['nested/c.md']);
    expect(idx.query('First')).toEqual([]);
  });

  it('clear() empties everything', () => {
    const idx = makeIndex();
    idx.clear();
    expect(idx.size()).toBe(0);
    expect(idx.allPaths()).toEqual([]);
    expect(idx.query('anything')).toEqual([]);
  });

  it('query with empty string returns no results', () => {
    const idx = makeIndex();
    expect(idx.query('')).toEqual([]);
    expect(idx.query('   ')).toEqual([]);
  });
});

/**
 * M1 (Audit-13) — VaultIndex keys its metadata Map + MiniSearch id by the
 * case-FOLDED vault-relative path, so a case-divergent external edit (case-only
 * rename, multi-device OneDrive, git) hits the SAME entry instead of missing it
 * (which bypassed the partial-read guard and upserted a duplicate). The stored
 * `metadata.path` keeps OS casing for display.
 */
describe('VaultIndex — case-folded keys (Audit-13 M1)', () => {
  it('get/has resolve a case-divergent lookup to the same entry', () => {
    const idx = new VaultIndex();
    idx.upsert(parseMarkdown('Notes/Meeting.md', '---\ntags: [x]\n---\n# Meeting'));
    // Looked up with divergent casing — must still resolve.
    expect(idx.get('notes/meeting.md')?.title).toBe('Meeting');
    expect(idx.get('NOTES/MEETING.MD')?.title).toBe('Meeting');
    expect(idx.has('notes/meeting.md')).toBe(true);
    // The stored value keeps the OS display casing.
    expect(idx.get('notes/meeting.md')?.path).toBe('Notes/Meeting.md');
  });

  it('a case-divergent re-upsert replaces (no duplicate entry)', () => {
    const idx = new VaultIndex();
    idx.upsert(parseMarkdown('Notes.md', '---\ntitle: Old\ntags: [old]\n---\nBody'));
    expect(idx.size()).toBe(1);
    // External tool reports the same file with different casing — must update
    // in place, not create a second entry.
    idx.upsert(parseMarkdown('notes.md', '---\ntitle: New\ntags: [new]\n---\nBody'));
    expect(idx.size()).toBe(1);
    expect(idx.get('Notes.md')?.title).toBe('New');
    expect(idx.filesByTag('old')).toEqual([]);
    expect(idx.filesByTag('new')).toEqual(['notes.md']);
  });

  it('remove() with divergent casing deletes the entry', () => {
    const idx = new VaultIndex();
    idx.upsert(parseMarkdown('Sub/File.md', '# F'));
    expect(idx.size()).toBe(1);
    idx.remove('sub/file.md');
    expect(idx.size()).toBe(0);
    expect(idx.get('Sub/File.md')).toBeNull();
  });

  it('renameKey case-only rename refreshes the stored display casing in place', () => {
    const idx = new VaultIndex();
    idx.upsert(parseMarkdown('Notes.md', '# N'));
    idx.renameKey('Notes.md', 'notes.md');
    // Same folded identity (still one entry), but display casing tracks disk.
    expect(idx.size()).toBe(1);
    expect(idx.get('notes.md')?.path).toBe('notes.md');
  });

  it('allPaths() and query() return OS display casing, not folded keys', () => {
    const idx = new VaultIndex();
    idx.upsert(parseMarkdown('Notes/Meeting.md', '---\ntags: [x]\n---\n# Meeting topic'));
    expect(idx.allPaths()).toEqual(['Notes/Meeting.md']);
    const hits = idx.query('Meeting');
    expect(hits[0]?.path).toBe('Notes/Meeting.md');
  });
});

describe('countTagsInInlineTiles', () => {
  it('returns an empty map for a null project', () => {
    expect(countTagsInInlineTiles(null).size).toBe(0);
    expect(countTagsInInlineTiles(undefined).size).toBe(0);
  });

  it('sums tag occurrences across inline tiles on every board', () => {
    const project = {
      boards: [
        {
          inlineTiles: {
            t1: { tags: ['bookmark', 'reading'] },
            t2: { tags: ['bookmark'] },
          },
        },
        {
          inlineTiles: {
            t3: { tags: ['reading', 'urgent'] },
          },
        },
      ],
    };
    const counts = countTagsInInlineTiles(project);
    expect(counts.get('bookmark')).toBe(2);
    expect(counts.get('reading')).toBe(2);
    expect(counts.get('urgent')).toBe(1);
  });

  it('ignores tiles without tags or with non-array tag fields', () => {
    const project = {
      boards: [
        {
          inlineTiles: {
            t1: { tags: ['ok'] },
            t2: {}, // no tags field
            t3: { tags: 'not-an-array' as unknown as string[] },
            t4: { tags: ['', 'real'] }, // empty strings skipped
          },
        },
      ],
    };
    const counts = countTagsInInlineTiles(project);
    expect(counts.get('ok')).toBe(1);
    expect(counts.get('real')).toBe(1);
    expect(counts.has('')).toBe(false);
  });

  it('handles boards without an inlineTiles bag', () => {
    const project = { boards: [{}, { inlineTiles: { t1: { tags: ['x'] } } }] };
    const counts = countTagsInInlineTiles(project);
    expect(counts.get('x')).toBe(1);
  });
});

describe('parseMarkdown — frontmatter and body', () => {
  it('preserves nested tags-with-slashes verbatim through frontmatter', () => {
    const md = [
      '---',
      'tags:',
      '  - project/alpha/detail',
      '  - project/alpha/done',
      '  - team/design',
      '---',
      '# Project tracker',
    ].join('\n');
    const meta = parseMarkdown('tracker.md', md);
    expect(meta.tags.sort()).toEqual([
      'project/alpha/detail',
      'project/alpha/done',
      'team/design',
    ]);
  });

  it('reads the frontmatter the note writer reads (BOM, CRLF, trailing space on the fence)', () => {
    const md = '\uFEFF---  \r\ntitle: Example\r\ntags: [a]\r\n---\r\n\r\n# First\r\n';
    const meta = parseMarkdown('pos.md', md);
    expect(meta.title).toBe('Example');
    expect(meta.tags).toEqual(['a']);
    expect(meta.content).toContain('# First');
    expect(meta.content).not.toContain('title:');
  });

  it('returns an empty tag list when frontmatter is malformed', () => {
    const md = [
      '---',
      'title: : broken :',
      '  - - not valid',
      '---',
      '',
      '# Body heading',
      '',
      'Has a #tag in body, which is decorative.',
    ].join('\n');
    const meta = parseMarkdown('broken.md', md);
    expect(meta.content).toContain('# Body heading');
    expect(meta.tags).toEqual([]);
  });
});

describe('VaultIndex — incremental updates', () => {
  it('simulates a file-change event: re-parsing an existing path replaces content, tags, and title in one step', () => {
    const idx = new VaultIndex();
    idx.upsert(parseMarkdown('journal.md', '---\ntitle: Journal\ntags: [draft]\n---\nFirst pass.'));
    expect(idx.filesByTag('draft')).toEqual(['journal.md']);
    expect(idx.get('journal.md')?.title).toBe('Journal');
    expect(idx.query('first')[0]?.path).toBe('journal.md');

    idx.upsert(parseMarkdown('journal.md', '---\ntitle: Journal v2\ntags: [published]\n---\nRevised body.'));

    expect(idx.filesByTag('draft')).toEqual([]);
    expect(idx.filesByTag('published')).toEqual(['journal.md']);
    expect(idx.get('journal.md')?.title).toBe('Journal v2');
    const firstHits = idx.query('first');
    expect(firstHits.some((r) => r.path === 'journal.md')).toBe(false);
    const revisedHits = idx.query('revised');
    expect(revisedHits.some((r) => r.path === 'journal.md')).toBe(true);
  });
});

/**
 * Phase 1 / 1.3 — `.markdown` is the IANA-registered alternative to `.md`
 * and Obsidian, VS Code, GitHub all treat it as equivalent. The cold-rebuild
 * walker (`collectMarkdownPaths`) and the watcher-driven applyChanges filter
 * (in `vaultIndex.svelte.ts`) used to filter on `.md` only, so `.markdown`
 * files were invisible to search, never had a baseline for external-edit
 * comparison, and produced spurious "deleted externally" prompts on save.
 */
describe('collectMarkdownPaths — .markdown extension acceptance', () => {
  function makeFile(name: string, parent: string): FileTreeNode {
    return {
      name,
      path: `${parent}/${name}`,
      isDirectory: false,
      extension: name.slice(name.lastIndexOf('.')).toLowerCase(),
    };
  }

  it('accepts both `.md` and `.markdown` extensions (case-insensitive)', () => {
    const tree: FileTreeNode[] = [
      makeFile('a.md', '/v'),
      makeFile('b.markdown', '/v'),
      makeFile('c.MD', '/v'),
      makeFile('d.MARKDOWN', '/v'),
      makeFile('e.txt', '/v'),
      makeFile('f.board.json', '/v'),
    ];
    const paths = collectMarkdownPaths(tree, '/v');
    expect(paths.sort()).toEqual(['a.md', 'b.markdown', 'c.MD', 'd.MARKDOWN']);
  });

  it('recurses into subfolders for both extensions', () => {
    const tree: FileTreeNode[] = [
      {
        name: 'sub',
        path: '/v/sub',
        isDirectory: true,
        children: [
          makeFile('inner.markdown', '/v/sub'),
          makeFile('also.md', '/v/sub'),
        ],
      },
      makeFile('root.markdown', '/v'),
    ];
    const paths = collectMarkdownPaths(tree, '/v');
    expect(paths.sort()).toEqual(['root.markdown', 'sub/also.md', 'sub/inner.markdown']);
  });

  it('ignores .filo/ and .board.json files, but indexes a note under attachments/', () => {
    const tree: FileTreeNode[] = [
      {
        name: '.filo',
        path: '/v/.filo',
        isDirectory: true,
        children: [makeFile('secret.markdown', '/v/.filo')],
      },
      {
        name: 'attachments',
        path: '/v/attachments',
        isDirectory: true,
        children: [makeFile('caption.md', '/v/attachments')],
      },
      makeFile('foo.board.json', '/v'),
      makeFile('keep.markdown', '/v'),
    ];
    const paths = collectMarkdownPaths(tree, '/v');
    expect(paths.sort()).toEqual(['attachments/caption.md', 'keep.markdown']);
  });
});

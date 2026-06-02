import { describe, it, expect } from 'vitest';
import { VaultIndex, parseMarkdown, countTagsInInlineTiles, collectMarkdownPaths } from '@renderer/lib/vault/vaultIndex';
import type { FileTreeNode } from '../../shared/types';

describe('parseMarkdown', () => {
  it('extracts frontmatter, headings, tags, and links', () => {
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
    expect(meta.headings).toHaveLength(2);
    expect(meta.headings[0]).toMatchObject({ level: 1, text: 'Meeting Notes' });
    expect(meta.headings[1]).toMatchObject({ level: 2, text: 'Attendees' });

    expect(meta.tags).toContain('work');
    expect(meta.tags).toContain('urgent');
    expect(meta.tags).toContain('todo');
    expect(meta.tags).toContain('project/subproject');

    expect(meta.links).toContain('OtherDoc');
    expect(meta.links).toContain('./another.md');
    expect(meta.links).not.toContain('https://example.com');
  });

  it('falls back to filename when no heading or frontmatter title', () => {
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

  it('handles files with no frontmatter', () => {
    const meta = parseMarkdown('plain.md', '# Hello\n\nBody.');
    expect(meta.frontmatter).toEqual({});
    expect(meta.title).toBe('Hello');
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
    idx.upsert(parseMarkdown('a.md', '---\ntags: [gamma]\n---\n# Renamed Title'));
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

describe('parseMarkdown — unified+remark pipeline', () => {
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

  it('records heading line numbers from the AST position', () => {
    const md = [
      '---',
      'title: Example',
      '---',
      '',
      '# First',
      '',
      'body',
      '',
      '## Second',
    ].join('\n');
    const meta = parseMarkdown('pos.md', md);
    expect(meta.headings).toHaveLength(2);
    expect(meta.headings[0].line).toBeGreaterThan(0);
    expect(meta.headings[1].line).toBeGreaterThan(meta.headings[0].line);
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
    expect(meta.headings[0]?.text).toBe('Body heading');
    expect(meta.tags).toEqual([]);
  });
});

describe('VaultIndex — incremental updates', () => {
  it('simulates a file-change event: re-parsing an existing path replaces content, tags, and title in one step', () => {
    const idx = new VaultIndex();
    idx.upsert(parseMarkdown('journal.md', '---\ntags: [draft]\n---\n# Journal\n\nFirst pass.'));
    expect(idx.filesByTag('draft')).toEqual(['journal.md']);
    expect(idx.get('journal.md')?.title).toBe('Journal');
    expect(idx.query('first')[0]?.path).toBe('journal.md');

    idx.upsert(parseMarkdown('journal.md', '---\ntags: [published]\n---\n# Journal v2\n\nRevised body.'));

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

  it('still ignores .filo/, attachments/, and .board.json files', () => {
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
    expect(paths).toEqual(['keep.markdown']);
  });
});

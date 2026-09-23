import { describe, it, expect } from 'vitest';
import {
  collectTemplateRefs,
  parseTemplate,
  interpolate,
  searchTemplates,
  instantiateTemplate,
  defaultTemplatesFolder,
  templateMatchesBoardType,
} from '@renderer/lib/templates/templateService';
import type { FileTreeNode } from '@shared/types';

function mkFile(name: string, path: string): FileTreeNode {
  return { name, path, isDirectory: false, extension: '.md' };
}
function mkDir(name: string, path: string, children: FileTreeNode[]): FileTreeNode {
  return { name, path, isDirectory: true, children };
}

describe('collectTemplateRefs', () => {
  const vaultRoot = '/vault';

  it('returns only .md files under the templates folder', () => {
    const tree: FileTreeNode[] = [
      mkDir('Templates', '/vault/Templates', [
        mkFile('Meeting Notes.md', '/vault/Templates/Meeting Notes.md'),
        mkFile('Daily.md', '/vault/Templates/Daily.md'),
        mkFile('not-markdown.txt', '/vault/Templates/not-markdown.txt'),
      ]),
      mkDir('Notes', '/vault/Notes', [
        mkFile('Project.md', '/vault/Notes/Project.md'),
      ]),
    ];
    const refs = collectTemplateRefs(tree, vaultRoot);
    expect(refs.map((r) => r.path)).toEqual([
      'Templates/Daily.md',
      'Templates/Meeting Notes.md',
    ]);
    expect(refs[0].name).toBe('Daily');
  });

  it('respects a custom templates folder', () => {
    const tree: FileTreeNode[] = [
      mkDir('Snippets', '/vault/Snippets', [
        mkFile('Hello.md', '/vault/Snippets/Hello.md'),
      ]),
      mkDir('Templates', '/vault/Templates', [
        mkFile('Ignored.md', '/vault/Templates/Ignored.md'),
      ]),
    ];
    const refs = collectTemplateRefs(tree, vaultRoot, 'Snippets');
    expect(refs.map((r) => r.path)).toEqual(['Snippets/Hello.md']);
  });

  it('returns [] when no templates folder is provided', () => {
    const tree: FileTreeNode[] = [mkFile('Loose.md', '/vault/Loose.md')];
    expect(collectTemplateRefs(tree, vaultRoot, '')).toEqual([]);
  });

  it('exposes the default folder name', () => {
    expect(defaultTemplatesFolder()).toBe('Templates');
  });
});

describe('parseTemplate', () => {
  it('strips frontmatter and extracts body', () => {
    const raw = '---\ntitle: My Template\n---\nHello world';
    const parsed = parseTemplate({ path: 'Templates/x.md', name: 'x', isBoard: false }, raw);
    expect(parsed.frontmatter.title).toBe('My Template');
    expect(parsed.body.trim()).toBe('Hello world');
    expect(parsed.ref.name).toBe('My Template'); // frontmatter title wins
    expect(parsed.boardJson).toBeNull();
    expect(parsed.ref.isBoard).toBe(false);
  });

  it('detects filo-board fenced blocks', () => {
    const raw = 'Intro text\n\n```filo-board\n{"type":"mindmap"}\n```\n\nOutro';
    const parsed = parseTemplate({ path: 't.md', name: 't', isBoard: false }, raw);
    expect(parsed.boardJson).toEqual({ type: 'mindmap' });
    expect(parsed.ref.isBoard).toBe(true);
    expect(parsed.bodyWithoutBoardBlock).toContain('Intro text');
    expect(parsed.bodyWithoutBoardBlock).toContain('Outro');
    expect(parsed.bodyWithoutBoardBlock).not.toContain('filo-board');
  });

  it('extracts boardType frontmatter and normalises case', () => {
    const raw = '---\ntitle: t\nboardType: Kanban\n---\nbody';
    const parsed = parseTemplate({ path: 't.md', name: 't', isBoard: false }, raw);
    expect(parsed.boardType).toBe('kanban');
  });

  it('returns null boardType when frontmatter omits the field', () => {
    const raw = '---\ntitle: t\n---\nbody';
    const parsed = parseTemplate({ path: 't.md', name: 't', isBoard: false }, raw);
    expect(parsed.boardType).toBeNull();
  });

  it('treats non-string boardType as absent', () => {
    const raw = '---\ntitle: t\nboardType: 42\n---\nbody';
    const parsed = parseTemplate({ path: 't.md', name: 't', isBoard: false }, raw);
    expect(parsed.boardType).toBeNull();
  });

  /**
   * M2 (Audit-13) — template frontmatter parses via the `yaml` package now (was
   * gray-matter, whose bundled js-yaml v3 coerced an unquoted `date:` → Date /
   * `0b1010` → 10). Keeping these as strings matches the index + read/write
   * gateway, so a template's metadata can't drift from the rest of the app.
   */
  it('parses frontmatter via the `yaml` package — date stays a string, body intact (M2)', () => {
    const raw = '---\ntitle: Daily\ndue: 2026-06-01\ncount: 0b1010\n---\nBody {{date}}';
    const parsed = parseTemplate({ path: 'Templates/Daily.md', name: 'Daily', isBoard: false }, raw);
    expect(typeof parsed.frontmatter.due).toBe('string');
    expect(parsed.frontmatter.due).toBe('2026-06-01');
    expect(parsed.frontmatter.count).toBe('0b1010');
    expect(parsed.body.trim()).toBe('Body {{date}}');
  });
});

describe('templateMatchesBoardType', () => {
  it('matches when the template has no boardType (universal)', () => {
    expect(templateMatchesBoardType({ boardType: null }, 'kanban')).toBe(true);
    expect(templateMatchesBoardType({ boardType: null }, 'mindmap')).toBe(true);
  });

  it('matches when boardType equals the active board (case-insensitive)', () => {
    expect(templateMatchesBoardType({ boardType: 'kanban' }, 'KANBAN')).toBe(true);
    expect(templateMatchesBoardType({ boardType: 'kanban' }, 'kanban')).toBe(true);
  });

  it('rejects templates scoped to a different board type', () => {
    expect(templateMatchesBoardType({ boardType: 'mindmap' }, 'kanban')).toBe(false);
    expect(templateMatchesBoardType({ boardType: 'tasklist' }, 'kanban')).toBe(false);
  });
});

describe('interpolate', () => {
  it('substitutes {{title}}, {{date}}, and {{time}}', () => {
    const out = interpolate('# {{title}}\n{{date}} {{time}}', {
      title: 'Hello',
      now: new Date(2026, 3, 24, 14, 30),
    });
    expect(out).toContain('# Hello');
    expect(out).toContain('2026-04-24');
    expect(out).toContain('14:30');
  });

  it('leaves unknown variables intact', () => {
    expect(interpolate('{{weather}} {{date}}', { now: new Date(2026, 0, 1) }))
      .toBe('{{weather}} 2026-01-01');
  });

  it('honours extras over nothing', () => {
    expect(interpolate('hi {{user}}', { extras: { user: 'Andrew' } })).toBe('hi Andrew');
  });
});

describe('searchTemplates', () => {
  const refs = [
    { path: 'Templates/Meeting Notes.md', name: 'Meeting Notes', isBoard: false },
    { path: 'Templates/Daily.md', name: 'Daily', isBoard: false },
    { path: 'Templates/Project Kickoff.md', name: 'Project Kickoff', isBoard: false },
  ];

  it('returns all refs for an empty query', () => {
    expect(searchTemplates(refs, '').length).toBe(3);
  });

  it('fuzzy-matches by name', () => {
    const hits = searchTemplates(refs, 'Meet');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].name).toBe('Meeting Notes');
  });
});

describe('instantiateTemplate', () => {
  it('parses and interpolates in one call', () => {
    const raw = '---\ntitle: Daily {{date}}\n---\nToday is {{date}}';
    const result = instantiateTemplate(
      { path: 'Templates/Daily.md', name: 'Daily', isBoard: false },
      raw,
      { now: new Date(2026, 3, 24) },
    );
    expect(result.interpolatedBody).toBe('Today is 2026-04-24');
  });
});

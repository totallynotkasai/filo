import { describe, it, expect } from 'vitest';
import {
  detectDivergence,
  reconcile,
  canonicalValues,
  applyCanonical,
  reconcileBoardCacheWithFrontmatter,
  tileBacksMarkdownPath,
  normalizeTags,
} from '@renderer/lib/vault/frontmatterSync';
import { parseMarkdown } from '@renderer/lib/vault/vaultIndex';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { TileDefinition } from '@renderer/schema/index';

function meta(path: string, body: string) {
  return parseMarkdown(path, body);
}

describe('frontmatterSync.normalizeTags', () => {
  it('returns array form as-is (deduped + sorted)', () => {
    expect(normalizeTags(['b', 'a'])).toEqual(['a', 'b']);
    expect(normalizeTags(['dup', 'dup', 'other'])).toEqual(['dup', 'other']);
  });

  it('parses comma-separated string form', () => {
    expect(normalizeTags('alpha, beta, gamma')).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('parses whitespace-separated string form', () => {
    expect(normalizeTags('alpha beta gamma')).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('strips leading # from tags', () => {
    expect(normalizeTags(['#hash', 'plain'])).toEqual(['hash', 'plain']);
    expect(normalizeTags('#a, #b')).toEqual(['a', 'b']);
  });

  it('returns empty for missing/null/junk input', () => {
    expect(normalizeTags(undefined)).toEqual([]);
    expect(normalizeTags(null)).toEqual([]);
    expect(normalizeTags(123)).toEqual([]);
    expect(normalizeTags({})).toEqual([]);
  });

  it('filters out empty strings inside an array', () => {
    expect(normalizeTags(['', 'real', ''])).toEqual(['real']);
  });

  it('returns empty for empty/whitespace-only string', () => {
    expect(normalizeTags('')).toEqual([]);
    expect(normalizeTags('   ')).toEqual([]);
  });
});

describe('frontmatterSync.canonicalValues', () => {
  it('uses frontmatter title when present', () => {
    const m = meta('a.md', '---\ntitle: From Frontmatter\n---\n# Heading');
    const c = canonicalValues(m);
    expect(c.title).toBe('From Frontmatter');
  });

  it('falls back to first heading, then filename', () => {
    const m1 = meta('a.md', '# Heading Title\nbody');
    expect(canonicalValues(m1).title).toBe('Heading Title');

    const m2 = meta('Inbox/Quick.md', 'body only');
    expect(canonicalValues(m2).title).toBe('Quick');
  });

  it('preserves the authored tag order (deduped, # stripped) — not sorted', () => {
    // 7.4 — canonical tags follow the .md's authored order so a reconciled
    // tile def matches the file on disk. Sorting is reserved for
    // normalizeTagsField (the comparison/index view). Here `b` precedes `a`,
    // the duplicate `a` is dropped, and the leading `#` on `c` is stripped.
    const m = meta('a.md', '---\ntags: [b, a, a, "#c"]\n---\n# T');
    const c = canonicalValues(m);
    expect(c.tags).toEqual(['b', 'a', 'c']);
  });

  it('only includes optional fields when present in frontmatter', () => {
    const plain = meta('a.md', '# T\nbody');
    const c1 = canonicalValues(plain);
    expect('completed' in c1).toBe(false);
    expect('status' in c1).toBe(false);

    const rich = meta(
      'a.md',
      '---\ncompleted: true\nstatus: active\npriority: high\ndueDate: 2026-05-01\n---\n# T',
    );
    const c2 = canonicalValues(rich);
    expect(c2.completed).toBe(true);
    expect(c2.status).toBe('active');
    expect(c2.priority).toBe('high');
    expect(c2.dueDate).toBe('2026-05-01');
  });

  it('round-trips new task fields (parent / startDate / dueTime / recurrence)', () => {
    const m = meta(
      'sub.md',
      '---\nparent: tile_abcd1234ef\nstartDate: 2026-05-20\ndueTime: "17:30"\nrecurrence: weekly\nrecurrenceMode: completion\n---\n# Sub',
    );
    const c = canonicalValues(m);
    expect(c.parent).toBe('tile_abcd1234ef');
    expect(c.startDate).toBe('2026-05-20');
    expect(c.dueTime).toBe('17:30');
    expect(c.recurrence).toBe('weekly');
    expect(c.recurrenceMode).toBe('completion');
  });
});

describe('frontmatterSync.detectDivergence', () => {
  it('returns empty when cache matches frontmatter', () => {
    const m = meta('a.md', '---\ntitle: T\ntags: [x, y]\ncompleted: false\n---\n# T');
    const cache = { title: 'T', tags: ['y', 'x'], completed: false };
    expect(detectDivergence(cache, m)).toEqual([]);
  });

  it('flags stale title', () => {
    const m = meta('a.md', '---\ntitle: New Title\n---\n# T');
    const cache = { title: 'Old Title' };
    const div = detectDivergence(cache, m);
    expect(div).toHaveLength(1);
    expect(div[0]).toMatchObject({ field: 'title', cached: 'Old Title', canonical: 'New Title' });
  });

  it('flags stale tags regardless of order', () => {
    const m = meta('a.md', '---\ntags: [work, urgent]\n---\n# T');
    const cache = { tags: ['urgent', 'work', 'extra'] };
    const div = detectDivergence(cache, m);
    expect(div.map((d) => d.field)).toEqual(['tags']);
  });

  it('flags stale completed flag', () => {
    const m = meta('a.md', '---\ncompleted: true\n---\n# T');
    const cache = { completed: false };
    const div = detectDivergence(cache, m);
    expect(div.map((d) => d.field)).toContain('completed');
  });

  it('treats missing cache value + matching empty canonical as equal', () => {
    const m = meta('a.md', '---\ntags: []\n---\n# T');
    const cache = {};
    const div = detectDivergence(cache, m);
    expect(div).toEqual([]);
  });
});

describe('frontmatterSync.reconcile', () => {
  it('returns the original cache by reference when in sync', () => {
    const m = meta('a.md', '---\ntitle: T\n---\n# T');
    const cache = { title: 'T' };
    const result = reconcile(cache, m);
    expect(result.next).toBe(cache);
    expect(result.changes).toEqual([]);
  });

  it('returns a patched copy when divergent', () => {
    const m = meta('a.md', '---\ntitle: Canon\ntags: [a]\n---\n# T');
    const cache = { title: 'Stale', tags: ['old'], extra: 'preserved' };
    const result = reconcile(cache as any, m);
    expect(result.next).not.toBe(cache);
    expect(result.next.title).toBe('Canon');
    expect(result.next.tags).toEqual(['a']);
    expect((result.next as any).extra).toBe('preserved');
    expect(result.changes.map((c) => c.field).sort()).toEqual(['tags', 'title']);
  });

  it('writes the authored tag order into the cache on a tags-set divergence (7.4)', () => {
    // The .md authored order is [banana, apple]; the cache is stale. After
    // reconcile the cache must carry the AUTHORED order (deduped), NOT the
    // sorted form [apple, banana] — otherwise the tile def's tag chips
    // disagree with the order in the file the user just edited.
    const m = meta('a.md', '---\ntags: [banana, apple, banana]\n---\n# T');
    const cache = { tags: ['old'] };
    const result = reconcile(cache, m);
    expect(result.next.tags).toEqual(['banana', 'apple']);
  });

  it('applyCanonical is a pure patch', () => {
    const m = meta('a.md', '---\ncompleted: true\n---\n# T');
    const cache = { completed: false, title: 'T' };
    const div = detectDivergence(cache, m);
    const patched = applyCanonical(cache, div);
    expect(cache.completed).toBe(false);
    expect(patched.completed).toBe(true);
    expect(patched.title).toBe('T');
  });
});

function textTileDef(overrides: Partial<TileDefinition> = {}): TileDefinition {
  return {
    id: 'tile-1',
    type: 'text',
    title: 'Notes',
    style: {
      headerColor: '#fff', bodyColor: '#fff', borderColor: '',
      shape: 'rounded', borderStyle: 'solid', borderWidth: 1, shadowIntensity: 0.3,
    },
    tags: [],
    createdAt: 1, updatedAt: 1,
    ...overrides,
  } as TileDefinition;
}

function emptyBoard(boardId: string, defs: Record<string, TileDefinition>): V7BoardFileData {
  return {
    board: { id: boardId, name: 'B', emoji: '', type: 'mindmap', settings: {} as never, createdAt: 1, updatedAt: 1 } as never,
    tileDefs: defs,
    connections: {},
    frames: [],
  };
}

describe('frontmatterSync.tileBacksMarkdownPath', () => {
  it('matches text tiles via title.md convention', () => {
    expect(tileBacksMarkdownPath(textTileDef({ title: 'Notes' }), 'Notes.md')).toBe(true);
    expect(tileBacksMarkdownPath(textTileDef({ title: 'Other' }), 'Notes.md')).toBe(false);
  });

  it('matches via explicit file/filePath fields', () => {
    const def = textTileDef();
    (def as Record<string, unknown>).filePath = 'sub/Note.md';
    expect(tileBacksMarkdownPath(def, 'sub/Note.md')).toBe(true);
    expect(tileBacksMarkdownPath(def, 'other/Note.md')).toBe(false);
  });

  it('is case-insensitive and normalises slashes', () => {
    const def = textTileDef({ title: 'Mixed' });
    expect(tileBacksMarkdownPath(def, 'MIXED.md')).toBe(true);
    expect(tileBacksMarkdownPath(def, '/Mixed.md')).toBe(true);
  });
});

describe('frontmatterSync.reconcileBoardCacheWithFrontmatter', () => {
  it('updates a backed text tile when frontmatter title diverges', () => {
    const def = textTileDef({ id: 't1', title: 'Notes', tags: ['old'] });
    const cache: Record<string, V7BoardFileData> = { b1: emptyBoard('b1', { t1: def }) };
    const m = meta('Notes.md', '---\ntitle: Renamed\ntags: [fresh]\n---\n# T');

    const res = reconcileBoardCacheWithFrontmatter(cache, 'Notes.md', m);

    expect(res.changedBoardIds).toEqual(['b1']);
    const patched = cache.b1.tileDefs['t1'] as Record<string, unknown>;
    expect(patched.title).toBe('Renamed');
    expect(patched.tags).toEqual(['fresh']);
  });

  it('returns no changes when the cache already matches the file', () => {
    const def = textTileDef({ id: 't1', title: 'Notes', tags: [] });
    const cache: Record<string, V7BoardFileData> = { b1: emptyBoard('b1', { t1: def }) };
    const m = meta('Notes.md', '---\ntitle: Notes\n---\n# T');

    const res = reconcileBoardCacheWithFrontmatter(cache, 'Notes.md', m);

    expect(res.changedBoardIds).toEqual([]);
  });

  it('skips tiles not backed by the changed file', () => {
    const def = textTileDef({ id: 't1', title: 'Other' });
    const cache: Record<string, V7BoardFileData> = { b1: emptyBoard('b1', { t1: def }) };
    const m = meta('Notes.md', '---\ntitle: New\n---\n# T');

    const res = reconcileBoardCacheWithFrontmatter(cache, 'Notes.md', m);

    expect(res.changedBoardIds).toEqual([]);
  });

  it('reports per-board changes across multiple boards', () => {
    const cache: Record<string, V7BoardFileData> = {
      b1: emptyBoard('b1', { ta: textTileDef({ id: 'ta', title: 'Shared', tags: ['old'] }) }),
      b2: emptyBoard('b2', { tb: textTileDef({ id: 'tb', title: 'Shared', tags: [] }) }),
    };
    const m = meta('Shared.md', '---\ntags: [fresh]\n---\n# Shared');

    const res = reconcileBoardCacheWithFrontmatter(cache, 'Shared.md', m);

    expect(res.changedBoardIds.sort()).toEqual(['b1', 'b2']);
    expect((cache.b1.tileDefs['ta'] as Record<string, unknown>).tags).toEqual(['fresh']);
    expect((cache.b2.tileDefs['tb'] as Record<string, unknown>).tags).toEqual(['fresh']);
  });

  // Phase 1.2: task-list cache must surrender to frontmatter on external edit.
  // Cache holds completed=false + status='todo'; user externally flips status
  // to 'done' and completed to true. After reconcile both fields reflect disk.
  it('Task List: external status/completed change overrides board JSON cache', () => {
    const taskTile: TileDefinition = {
      id: 'task-1',
      type: 'text',
      title: 'Ship the thing',
      style: {
        headerColor: '#fff', bodyColor: '#fff', borderColor: '',
        shape: 'rounded', borderStyle: 'solid', borderWidth: 1, shadowIntensity: 0.3,
      },
      tags: [],
      createdAt: 1, updatedAt: 1,
    } as TileDefinition;
    (taskTile as Record<string, unknown>).completed = false;
    (taskTile as Record<string, unknown>).status = 'todo';

    const cache: Record<string, V7BoardFileData> = {
      board1: emptyBoard('board1', { 'task-1': taskTile }),
    };

    const externalEdit = meta(
      'Ship the thing.md',
      '---\ncompleted: true\nstatus: done\n---\n# Ship the thing',
    );
    const result = reconcileBoardCacheWithFrontmatter(cache, 'Ship the thing.md', externalEdit);

    expect(result.changedBoardIds).toEqual(['board1']);
    const patched = cache.board1.tileDefs['task-1'] as Record<string, unknown>;
    expect(patched.completed).toBe(true);
    expect(patched.status).toBe('done');

    // Per-board record reports both fields as divergent so the audit trail
    // captures every cache override (not just the first one detected).
    const fields = result.perBoard.board1[0].changes.map((c) => c.field).sort();
    expect(fields).toEqual(['completed', 'status']);
  });

  // Audit 2.3 — a frontmatter field the tile def never carried (e.g. a dueDate
  // typed into the .md in an external editor) must reconcile onto the live
  // cache without waiting for a board reload. Pre-fix, cacheSubset was built
  // only from fields already on the def, so detectDivergence's "field in cache"
  // guard skipped the new field entirely and smart-list filters/sort silently
  // ignored it mid-session.
  it('reconciles a frontmatter field the tile def did not previously carry', () => {
    const def = textTileDef({ id: 't1', title: 'Task' }); // no dueDate / priority
    const cache: Record<string, V7BoardFileData> = { b1: emptyBoard('b1', { t1: def }) };
    const m = meta('Task.md', '---\ntitle: Task\ndueDate: 2026-06-01\npriority: high\n---\n# Task');

    const res = reconcileBoardCacheWithFrontmatter(cache, 'Task.md', m);

    expect(res.changedBoardIds).toEqual(['b1']);
    const patched = cache.b1.tileDefs['t1'] as Record<string, unknown>;
    expect(patched.dueDate).toBe('2026-06-01');
    expect(patched.priority).toBe('high');
  });

  // Guard against over-reach: a synced field absent from BOTH the def and the
  // frontmatter must NOT be invented on the def (no spurious writes / no
  // pollution of non-task tiles with task fields the file doesn't have).
  it('does not invent a synced field absent from both the def and the frontmatter', () => {
    const def = textTileDef({ id: 't1', title: 'Task' }); // no priority / dueDate
    const cache: Record<string, V7BoardFileData> = { b1: emptyBoard('b1', { t1: def }) };
    const m = meta('Task.md', '---\ntitle: Task\n---\n# Task'); // no priority / dueDate in fm

    const res = reconcileBoardCacheWithFrontmatter(cache, 'Task.md', m);

    expect(res.changedBoardIds).toEqual([]);
    const patched = cache.b1.tileDefs['t1'] as Record<string, unknown>;
    expect('priority' in patched).toBe(false);
    expect('dueDate' in patched).toBe(false);
  });
});

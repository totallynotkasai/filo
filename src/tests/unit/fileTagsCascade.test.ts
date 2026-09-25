import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { fileTagsStore } from '@renderer/stores/fileTags.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import {
  cancelAllPendingWrites,
  setWriteStateListener,
  __resetDirtyTrackingForTests,
  type WriteStateInfo,
  type BoardFileData,
} from '@renderer/lib/boards/boardSaver';
import { onError, __resetErrorBusForTests, type ReportedError } from '@renderer/lib/utils/errorBus';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';
import type { KanbanBoard, MindMapBoard } from '@renderer/schema/index';
import { parseMarkdown, type FileMetadata } from '@renderer/lib/vault/vaultIndex';

/**
 * Integration coverage for the three-sink tag cascade.
 *
 * The audit flagged that `renameTagEverywhere` / `removeTagEverywhere` did
 * not touch `settings.savedViews[*].filterTags` or `settings.lastView
 * .filterTags`. This test pins the cascade so a future regression is caught
 * before the next vault inconsistency is shipped.
 */

function emptyTagsFile(): string {
  return JSON.stringify({ version: 1, tags: {}, fileTags: {} });
}

const STYLE = { headerColor: '', bodyColor: '', borderColor: '' };

/**
 * `t1` is a board-only (link) tile, so its tags live on the board def. `n1` is
 * a card backed by `Tasks/A.md`, whose tags live only in that note's
 * frontmatter.
 */
function makeKanbanFixture(): BoardFileData {
  return {
    version: 8,
    board: {
      id: 'k1',
      type: 'kanban',
      name: 'Backlog',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {
        savedViews: [
          { id: 'v1', name: 'Urgent', sortBy: 'manual', filterTags: ['urgent', 'today'], filterProp: null },
          { id: 'v2', name: 'Quiet', sortBy: 'manual', filterTags: ['someday'], filterProp: null },
        ],
        lastView: { sortBy: 'manual', filterTags: ['urgent'], filterProp: null },
      },
      columns: [
        { id: 'c1', title: 'Todo', position: 0, tilePlacements: [{ tileId: 't1', position: 0 }, { tileId: 'n1', position: 1 }] },
      ],
    } as unknown as KanbanBoard,
    tileDefs: {
      t1: {
        id: 't1', type: 'link', title: 'A', url: 'https://a.example',
        style: STYLE, tags: ['urgent', 'work'],
        createdAt: 0, updatedAt: 0,
      },
      n1: { id: 'n1', type: 'text', filePath: 'Tasks/A.md', style: STYLE, createdAt: 0, updatedAt: 0 },
    },
    connections: {},
    frames: [],
  };
}

function makeMindMapWithInlineTile(): BoardFileData {
  return {
    version: 8,
    board: {
      id: 'mm',
      type: 'mindmap',
      name: 'Map',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      placements: {},
      inlineTiles: {
        l1: { id: 'l1', type: 'link', title: 'L', url: 'https://x', tags: ['urgent'], style: {}, createdAt: 0, updatedAt: 0 },
      },
      waypoints: [],
    } as unknown as MindMapBoard,
    tileDefs: {},
    connections: {},
    frames: [],
  };
}

describe('fileTagsStore — rename / delete cascade', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    boardCacheStore.clear();
    boardStore.clearBoard();
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    fileTagsStore.reset();

    installFiloMock({
      'tags:load': async () => emptyTagsFile(),
      'tags:save': async () => null,
      'board:save': async () => null,
      'board:load': async () => null,
      'vault:write-file-text': async () => ({ success: true }),
      // Phase 31 A4.5 — fileTags + tag-rewrite-sweep now call
      // vault:write-existing-file-text for edits to existing .md files.
      'vault:write-existing-file-text': async () => ({ success: true }),
      'vault:read-file-text': async () => ({ success: true, content: '' }),
    });

    await fileTagsStore.hydrate('/vault');
    // Seed two tag definitions on a media file (tags.json is where a media
    // file's tags live); the cascade should rewrite both occurrences.
    fileTagsStore.addTagToFile('Media/A.png', 'urgent');
    fileTagsStore.addTagToFile('Media/A.png', 'someday');
  });

  afterEach(() => {
    cancelAllPendingWrites();
    vi.useRealTimers();
    vi.restoreAllMocks();
    restoreFiloDefault();
    boardCacheStore.clear();
    boardStore.clearBoard();
    fileTagsStore.reset();
    vaultStore.setPath('');
    __resetDirtyTrackingForTests();
  });

  function hydrateCacheAndProject(): void {
    boardCacheStore.hydrate(
      { k1: makeKanbanFixture(), mm: makeMindMapWithInlineTile() },
      { k1: 'Backlog.board.json', mm: 'Map.board.json' },
    );
  }

  /** The card's board def never carries tags: they live in its note. */
  function expectNoBoardTagsOnCard(): void {
    expect((boardCacheStore.cache.k1.tileDefs.n1 as { tags?: unknown }).tags).toBeUndefined();
  }

  describe('renameTagEverywhere', () => {
    it('rewrites saved views, lastView, tile defs, and inline tiles', async () => {
      hydrateCacheAndProject();

      await fileTagsStore.renameTagEverywhere('urgent', 'important');

      const k1 = boardCacheStore.cache.k1.board.settings as {
        savedViews: Array<{ id: string; filterTags: string[] }>;
        lastView: { filterTags: string[] };
      };
      expect(k1.savedViews[0].filterTags.sort()).toEqual(['important', 'today']);
      expect(k1.savedViews[1].filterTags).toEqual(['someday']);
      expect(k1.lastView.filterTags).toEqual(['important']);

      const def = boardCacheStore.cache.k1.tileDefs.t1 as { tags: string[] };
      expect(def.tags.sort()).toEqual(['important', 'work']);

      const inline = (
        boardCacheStore.cache.mm.board as unknown as {
          inlineTiles: Record<string, { tags: string[] }>;
        }
      ).inlineTiles.l1;
      expect(inline.tags).toEqual(['important']);
      expectNoBoardTagsOnCard();

      // .filo/tags.json mirror: definition renamed, media file assignment
      // renamed. fileTags keys are stored in canonical lowercase form (via
      // `normalizeVaultRelative`), so `Media/A.png` is found under `media/a.png`.
      expect(fileTagsStore.file.tags.urgent).toBeUndefined();
      expect(fileTagsStore.file.tags.important).toBeDefined();
      expect(fileTagsStore.file.fileTags['media/a.png']).toContain('important');
      expect(fileTagsStore.file.fileTags['media/a.png']).not.toContain('urgent');
    });

    it('is a no-op when old === new', async () => {
      hydrateCacheAndProject();
      const before = JSON.stringify(boardCacheStore.cache);
      await fileTagsStore.renameTagEverywhere('urgent', 'urgent');
      expect(JSON.stringify(boardCacheStore.cache)).toBe(before);
    });

    it('dedupes when the target view already contains the new name', async () => {
      hydrateCacheAndProject();
      // Pre-seed v1 with both 'urgent' and 'important' so the rewrite would
      // otherwise produce a duplicate.
      const settings = boardCacheStore.cache.k1.board.settings as {
        savedViews: Array<{ filterTags: string[] }>;
      };
      settings.savedViews[0].filterTags = ['urgent', 'important', 'today'];

      await fileTagsStore.renameTagEverywhere('urgent', 'important');

      expect(settings.savedViews[0].filterTags.sort()).toEqual(['important', 'today']);
    });
  });

  describe('removeTagEverywhere', () => {
    it('strips the tag from saved views, lastView, tile defs, and inline tiles', async () => {
      hydrateCacheAndProject();

      await fileTagsStore.removeTagEverywhere('urgent');

      const k1 = boardCacheStore.cache.k1.board.settings as {
        savedViews: Array<{ id: string; filterTags: string[] }>;
        lastView: { filterTags: string[] };
      };
      expect(k1.savedViews[0].filterTags).toEqual(['today']);
      expect(k1.savedViews[1].filterTags).toEqual(['someday']);
      expect(k1.lastView.filterTags).toEqual([]);

      const def = boardCacheStore.cache.k1.tileDefs.t1 as { tags: string[] };
      expect(def.tags).toEqual(['work']);

      const inline = (
        boardCacheStore.cache.mm.board as unknown as {
          inlineTiles: Record<string, { tags: string[] }>;
        }
      ).inlineTiles.l1;
      expect(inline.tags).toEqual([]);
      expectNoBoardTagsOnCard();

      // Canonical lowercase key.
      expect(fileTagsStore.file.tags.urgent).toBeUndefined();
      expect(fileTagsStore.file.fileTags['media/a.png']).not.toContain('urgent');
    });

    it('leaves unrelated tags alone on boards that never carried the deleted tag', async () => {
      hydrateCacheAndProject();

      await fileTagsStore.removeTagEverywhere('someday');

      const k1 = boardCacheStore.cache.k1.board.settings as {
        savedViews: Array<{ id: string; filterTags: string[] }>;
        lastView: { filterTags: string[] };
      };
      expect(k1.savedViews[0].filterTags.sort()).toEqual(['today', 'urgent']);
      expect(k1.savedViews[1].filterTags).toEqual([]);
      expect(k1.lastView.filterTags).toEqual(['urgent']);
    });
  });

  // On Kanban / Task List surfaces the live `boardStore.tiles` map is empty,
  // so `boardStore.getTile(id)` returns undefined. A tag edit must still find
  // the tile on its board's cache and land where that tile's tags live;
  // silently dropping it shows as "field clears but tag never saves".
  describe('addTagToTile / removeTagFromTile — Kanban / Task fallback', () => {
    it('persists the tag onto a tile def that is not on the active board', () => {
      hydrateCacheAndProject();
      // No setBoard() call — `boardStore.tiles` stays empty, as on a Kanban
      // or Task List board.
      expect(boardStore.getTile('t1')).toBeUndefined();

      fileTagsStore.addTagToTile('t1', 'newtag');

      const def = boardCacheStore.cache.k1.tileDefs.t1 as { tags: string[] };
      expect(def.tags.sort()).toEqual(['newtag', 'urgent', 'work']);
      expect(fileTagsStore.file.tags.newtag).toBeDefined();
    });

    it('removes the tag from a tile def that is not on the active board', () => {
      hydrateCacheAndProject();
      expect(boardStore.getTile('t1')).toBeUndefined();

      fileTagsStore.removeTagFromTile('t1', 'urgent');

      const def = boardCacheStore.cache.k1.tileDefs.t1 as { tags: string[] };
      expect(def.tags).toEqual(['work']);
    });

    it('is idempotent — adding a tag the def already carries is a no-op', () => {
      hydrateCacheAndProject();
      const before = (boardCacheStore.cache.k1.tileDefs.t1 as { tags: string[] }).tags.slice();

      fileTagsStore.addTagToTile('t1', 'urgent');

      const after = (boardCacheStore.cache.k1.tileDefs.t1 as { tags: string[] }).tags;
      expect(after).toEqual(before);
    });

    it("routes a card's tag to its note's frontmatter, not the board def", async () => {
      vi.useRealTimers();
      hydrateCacheAndProject();
      const original = '---\ntags: [work]\n---\nbody\n';
      vaultIndexStore.restoreMetadata('Tasks/A.md', parseMarkdown('Tasks/A.md', original));
      const writes: Array<{ path: string; content: string }> = [];
      installFiloMock({
        'tags:save': async () => null,
        'board:save': async () => null,
        'vault:read-file-text': async () => ({ success: true, content: original, mtimeMs: 1, size: original.length }),
        'vault:write-existing-file-text': async (...args: unknown[]) => {
          const path = String(args[1]);
          if (!path.startsWith('.filo/')) writes.push({ path, content: String(args[2]) });
          return { success: true };
        },
        'vault:write-file-text': async () => ({ success: true }),
      });
      expect(boardStore.getTile('n1')).toBeUndefined();
      expect(fileTagsStore.findTile('n1')?.tags).toEqual(['work']);

      fileTagsStore.addTagToTile('n1', 'newtag');
      await vi.waitFor(() => expect(writes).toHaveLength(1));

      expect(writes[0].path).toBe('Tasks/A.md');
      expect(writes[0].content).toContain('newtag');
      expect(writes[0].content).toContain('work');
      expectNoBoardTagsOnCard();
      vaultIndexStore.clear();
    });
  });

  // Phase 9.1 (P1-5): tag-rename / tag-removal sweeps must rewrite every `.md`
  // file BEFORE committing the `.filo/tags.json` / tile-def cascade — so that
  // a partial disk failure leaves the registry pointing at the old name and a
  // retry naturally targets only the unwritten files. The old behaviour fired
  // the markdown writes as fire-and-forget AFTER mutating the registry, so a
  // partial failure left .md frontmatter + the registry permanently
  // divergent.
  describe('atomic rewrite — `.md` writes precede registry/tile-def commit', () => {
    function seedVaultIndexWithTaggedFile(path: string, tag: string, body: string): void {
      const metadata: FileMetadata = {
        path,
        title: path.replace(/\.md$/i, ''),
        headings: [],
        tags: [tag],
        frontmatter: { tags: [tag] },
        links: [],
        content: body,
        lastModified: 0,
        rawFrontmatter: `tags: [${tag}]`,
      };
      vi.spyOn(vaultIndexStore, 'allMetadata').mockReturnValue([metadata]);
      vi.spyOn(vaultIndexStore, 'applyChanges').mockResolvedValue(undefined);
    }

    function makeMarkdown(tag: string): string {
      return `---\ntags: [${tag}]\n---\nbody\n`;
    }

    it('commits the registry and tile-defs when every `.md` write succeeds', async () => {
      vi.useRealTimers();
      hydrateCacheAndProject();
      seedVaultIndexWithTaggedFile('Tasks/A.md', 'urgent', makeMarkdown('urgent'));

      const writtenPaths: string[] = [];
      const recordPath: (...args: unknown[]) => Promise<{ success: true }> = async (..._args) => {
        const relPath = String(_args[1]);
        // Ignore .filo/.dirty sentinel writes — they fire as a side effect
        // of the rewrite's trackComponentWrite lifecycle. Only count
        // writes to actual markdown files.
        if (!relPath.startsWith('.filo/')) writtenPaths.push(relPath);
        return { success: true };
      };
      installFiloMock({
        'tags:load': async () => emptyTagsFile(),
        'tags:save': async () => null,
        'board:save': async () => null,
        'vault:file-exists': async () => true,
        'vault:read-file-text': async () => ({
          success: true,
          content: makeMarkdown('urgent'),
        }),
        // Phase 31 A4.5 — tag-rewrite-sweep now uses write-existing for
        // edits to existing .md files. Sentinel writes still use the
        // create-channel.
        'vault:write-file-text': recordPath,
        'vault:write-existing-file-text': recordPath,
      });

      await fileTagsStore.renameTagEverywhere('urgent', 'important');

      // The .md write fired exactly once for the single tagged file.
      expect(writtenPaths).toEqual(['Tasks/A.md']);

      // Registry + tile defs committed.
      expect(fileTagsStore.file.tags.urgent).toBeUndefined();
      expect(fileTagsStore.file.tags.important).toBeDefined();
      const def = boardCacheStore.cache.k1.tileDefs.t1 as { tags: string[] };
      expect(def.tags.sort()).toEqual(['important', 'work']);
    });

    it('leaves the registry + tile-defs at the OLD name when a `.md` write fails', async () => {
      vi.useRealTimers();
      __resetDirtyTrackingForTests();
      // That reset also clears the active vault the note writer writes into.
      vaultStore.setPath('/vault');
      hydrateCacheAndProject();
      seedVaultIndexWithTaggedFile('Tasks/A.md', 'urgent', makeMarkdown('urgent'));

      const states: WriteStateInfo[] = [];
      setWriteStateListener((info) => states.push({ ...info }));

      const failOnMd: (...args: unknown[]) => Promise<{ success: true }> = async (...args) => {
        const relPath = String(args[1]);
        if (relPath.startsWith('.filo/')) return { success: true };
        throw new Error('EACCES');
      };
      installFiloMock({
        'tags:load': async () => emptyTagsFile(),
        'tags:save': async () => null,
        'board:save': async () => null,
        'vault:file-exists': async () => true,
        'vault:read-file-text': async () => ({
          success: true,
          content: makeMarkdown('urgent'),
        }),
        // Sprint B / B3 — allow `.filo/` writes (including the new
        // tag-rewrite recovery sentinel) but make .md writes fail. This
        // mirrors the real-world failure mode (sentinel works, .md doesn't)
        // and lets the test isolate the per-file failure path.
        //
        // Phase 31 A4.5 — tag-rewrite-sweep now calls write-existing for
        // existing .md files; sentinel writes still go through write-file-text.
        'vault:write-file-text': failOnMd,
        'vault:write-existing-file-text': failOnMd,
        'vault:delete': async () => ({ success: true }),
      });

      const toastsBefore = uiStore.toasts.length;
      await fileTagsStore.renameTagEverywhere('urgent', 'important');

      // Registry untouched — the rename did NOT commit.
      expect(fileTagsStore.file.tags.urgent).toBeDefined();
      expect(fileTagsStore.file.tags.important).toBeUndefined();
      // Tile def still carries the OLD tag.
      const def = boardCacheStore.cache.k1.tileDefs.t1 as { tags: string[] };
      expect(def.tags.sort()).toEqual(['urgent', 'work']);

      // A retry-capable toast was pushed.
      const newToasts = uiStore.toasts.slice(toastsBefore);
      expect(newToasts.length).toBe(1);
      expect(newToasts[0].text).toContain('Tag rename failed');
      expect(newToasts[0].actions).toBeDefined();
      expect(newToasts[0].actions?.[0].label).toContain('Retry');

      // Failed path is recorded in writeStateTracking so the sentinel stays dirty.
      expect(states[states.length - 1].failed).toBe(1);

      setWriteStateListener(null);
      // Clean up the persistent toast so afterEach doesn't carry it forward.
      for (const t of newToasts) uiStore.dismissToast(t.id);
    });

    it('removeTagEverywhere — same atomicity guarantee for the delete path', async () => {
      vi.useRealTimers();
      __resetDirtyTrackingForTests();
      vaultStore.setPath('/vault');
      hydrateCacheAndProject();
      seedVaultIndexWithTaggedFile('Tasks/A.md', 'urgent', makeMarkdown('urgent'));

      const failOnMd: (...args: unknown[]) => Promise<{ success: true }> = async (...args) => {
        const relPath = String(args[1]);
        if (relPath.startsWith('.filo/')) return { success: true };
        throw new Error('EACCES');
      };
      installFiloMock({
        'tags:load': async () => emptyTagsFile(),
        'tags:save': async () => null,
        'board:save': async () => null,
        'vault:file-exists': async () => true,
        'vault:read-file-text': async () => ({
          success: true,
          content: makeMarkdown('urgent'),
        }),
        // Sprint B / B3 — allow `.filo/` writes (sentinel) but fail .md
        // writes to isolate the per-file rewrite failure.
        //
        // Phase 31 A4.5 — same dual mock as the rename test above.
        'vault:write-file-text': failOnMd,
        'vault:write-existing-file-text': failOnMd,
        'vault:delete': async () => ({ success: true }),
      });

      const toastsBefore = uiStore.toasts.length;
      await fileTagsStore.removeTagEverywhere('urgent');

      // Registry untouched — the deletion did NOT commit.
      // Canonical lowercase key.
      expect(fileTagsStore.file.tags.urgent).toBeDefined();
      expect(fileTagsStore.file.fileTags['media/a.png']).toContain('urgent');
      // Tile def still carries the tag.
      const def = boardCacheStore.cache.k1.tileDefs.t1 as { tags: string[] };
      expect(def.tags).toContain('urgent');

      const newToasts = uiStore.toasts.slice(toastsBefore);
      expect(newToasts.length).toBe(1);
      expect(newToasts[0].text).toContain('Tag removal failed');

      for (const t of newToasts) uiStore.dismissToast(t.id);
    });

    it('silently skips files that no longer exist on disk (not counted as failure)', async () => {
      vi.useRealTimers();
      __resetDirtyTrackingForTests();
      vaultStore.setPath('/vault');
      hydrateCacheAndProject();
      seedVaultIndexWithTaggedFile('Tasks/Gone.md', 'urgent', '');

      installFiloMock({
        'tags:load': async () => emptyTagsFile(),
        'tags:save': async () => null,
        'board:save': async () => null,
        // Read returns null (file gone) but vault:file-exists confirms it.
        'vault:read-file-text': async () => ({ success: false, content: null }),
        'vault:file-exists': async () => false,
      });

      const toastsBefore = uiStore.toasts.length;
      await fileTagsStore.renameTagEverywhere('urgent', 'important');

      // No toast (file is gone, so the rename intent is moot).
      expect(uiStore.toasts.length).toBe(toastsBefore);
      // Registry committed because no actual failures.
      expect(fileTagsStore.file.tags.urgent).toBeUndefined();
      expect(fileTagsStore.file.tags.important).toBeDefined();
    });
  });

  // A tag change the note writer can't land (the file exists but can't be
  // read) isn't on disk; the user must be told rather than left thinking the
  // tag saved. A note deleted meanwhile has no tags to change: silence.
  describe('tag write read-failure surfacing', () => {
    it('surfaces an error when the note exists but cannot be read', async () => {
      vi.useRealTimers();
      __resetErrorBusForTests();
      __resetDirtyTrackingForTests();
      vaultStore.setPath('/vault');

      const states: WriteStateInfo[] = [];
      setWriteStateListener((info) => states.push({ ...info }));
      const errors: ReportedError[] = [];
      const unsubscribe = onError((e) => errors.push(e));

      installFiloMock({
        'tags:load': async () => emptyTagsFile(),
        'tags:save': async () => null,
        'board:save': async () => null,
        'vault:read-file-text': async () => ({ success: false, code: 'EACCES', error: 'EACCES' }),
        'vault:file-exists': async () => true,
      });

      await fileTagsStore.hydrate('/vault');

      fileTagsStore.addTagToPath('Notes/foo.md', 'urgent');

      await vi.waitFor(() => expect(errors.some((e) => e.context === 'fileTagsStore')).toBe(true));
      // The unsaved tag keeps the dirty sentinel: the path is marked failed.
      expect(states[states.length - 1]?.failed).toBe(1);

      unsubscribe();
      setWriteStateListener(null);
      __resetDirtyTrackingForTests();
    });

    it('stays silent when the file no longer exists on disk', async () => {
      vi.useRealTimers();
      __resetErrorBusForTests();
      __resetDirtyTrackingForTests();
      vaultStore.setPath('/vault');

      const states: WriteStateInfo[] = [];
      setWriteStateListener((info) => states.push({ ...info }));
      const errors: ReportedError[] = [];
      const unsubscribe = onError((e) => errors.push(e));
      const reads: string[] = [];

      installFiloMock({
        'tags:load': async () => emptyTagsFile(),
        'tags:save': async () => null,
        'board:save': async () => null,
        'vault:read-file-text': async (...args: unknown[]) => {
          reads.push(String(args[1]));
          return { success: false, code: 'ENOENT', error: 'ENOENT' };
        },
        'vault:file-exists': async () => false,
      });

      await fileTagsStore.hydrate('/vault');

      fileTagsStore.addTagToPath('Notes/gone.md', 'urgent');

      await vi.waitFor(() => expect(reads).toContain('Notes/gone.md'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      // No toast, no failed path: the file is gone (probably deleted
      // out-of-band), so the queued tag write is a benign no-op and the
      // sentinel must not be tainted with a path that doesn't exist.
      // Inflight may be >0 from the unrelated tags:save scheduled by
      // addTagToPath — we only assert `failed` stays at zero.
      expect(errors.some((e) => e.context === 'fileTagsStore')).toBe(false);
      expect((states[states.length - 1] ?? { failed: 0 }).failed).toBe(0);

      unsubscribe();
      setWriteStateListener(null);
      __resetDirtyTrackingForTests();
    });
  });
});

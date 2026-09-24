import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { documentStore } from '@renderer/stores/document.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { makeKanbanFrontmatterWriter } from '@renderer/lib/kanban/kanbanFrontmatterWriter';
import { flushAllPendingFrontmatterWrites } from '@renderer/lib/boards/frontmatterWriteScheduler';
import { cancelAllMarkdownWrites } from '@renderer/lib/vault/markdownFileWriter';
import {
  __resetDirtyTrackingForTests,
  __clearRecentSelfWritesForTests,
} from '@renderer/lib/boards/writeStateTracking';
import { __resetBaselinesForTests } from '@renderer/lib/vault/fileBaselineRegistry';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { KanbanBoard as KanbanBoardType, Tile } from '@renderer/schema/index';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * WRITE_PATH_REMEDIATION_PLAN_2026-06-04 Phase 4 — seam round-trip cover for the
 * STRUCTURAL delta-based write source.
 *
 * Unlike the Phase 2 interim fix (drop the stale cache so the next seed re-reads
 * disk), Phase 4 makes "never drop an untouched key" structural: the write
 * applies the field delta to a FRESH disk read REGARDLESS of cache state. So
 * these tests deliberately leave a STALE cache in place (no Phase-2 drop) and
 * assert the externally-added key still survives on disk — which can only happen
 * if the write reads disk, not the cache. Reverting the delta threading turns
 * every "external key survived" assertion red.
 */

interface Captured {
  channel: string;
  args: unknown[];
}

function lastWrite(captured: Captured[]): string | undefined {
  for (let i = captured.length - 1; i >= 0; i--) {
    if (captured[i].channel === 'vault:write-existing-file-text') {
      return captured[i].args[2] as string;
    }
  }
  return undefined;
}

function hydrateBoardWithTextTile(
  boardId: string,
  defs: Array<{ tileId: string; title: string }>,
): void {
  const tileDefs: Record<string, unknown> = {};
  for (const d of defs) {
    tileDefs[d.tileId] = {
      id: d.tileId,
      type: 'text',
      filePath: `${d.title}.md`,
      style: {},
      createdAt: 0,
      updatedAt: 0,
    };
  }
  const data = {
    version: 8,
    board: {
      id: boardId,
      type: 'kanban',
      name: 'K',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      columns: [],
    },
    tileDefs: tileDefs as V7BoardFileData['tileDefs'],
    connections: {},
    frames: [],
  } as unknown as V7BoardFileData;
  boardCacheStore.hydrate({ [boardId]: data }, { [boardId]: `${boardId}.board.json` });
}

/** Drives a Kanban field edit on a not-open card backed by `relPath`. */
function makeWriter(tile: Tile): ReturnType<typeof makeKanbanFrontmatterWriter> {
  return makeKanbanFrontmatterWriter({
    getBoard: () => ({ id: 'kb', type: 'kanban', columns: [] }) as unknown as KanbanBoardType,
    getAllTilesById: () => ({ [tile.id]: tile }),
    bumpCacheVersion: () => {},
    tickAndPersist: () => {},
  });
}

describe('Phase 4 — field edit applies a delta to FRESH disk (stale cache, no Phase-2 drop)', () => {
  let captured: Captured[];

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    __clearRecentSelfWritesForTests();
    __resetBaselinesForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
    boardCacheStore.clear();
    vaultIndexStore.clear();
    vaultStore.setPath('/vault');
    captured = [];
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
    boardCacheStore.clear();
    vaultIndexStore.clear();
    vaultStore.setPath('');
    vi.restoreAllMocks();
  });

  /** Installs a mock whose disk content is fixed (mtime stable → no drift prompt). */
  function installDisk(content: string): void {
    installFiloMock((channel: string, ...args: unknown[]) => {
      captured.push({ channel, args });
      if (channel === 'vault:read-file-text') {
        return { success: true, content, mtimeMs: 5, size: content.length };
      }
      if (channel === 'vault:stat') return { success: true, mtimeMs: 5, size: content.length };
      if (channel === 'vault:write-existing-file-text') return { success: true };
      return { success: true };
    });
  }

  async function fieldEditAndFlush(tile: Tile, patch: Record<string, unknown>): Promise<void> {
    const writer = makeWriter(tile);
    await writer.updateTileFrontmatter(tile.id, patch);
    await vi.waitFor(
      async () => {
        await flushAllPendingFrontmatterWrites();
        expect(lastWrite(captured), 'no markdown write captured').toBeDefined();
      },
      { timeout: 1000, interval: 20 },
    );
  }

  it('preserves an externally-added key the STALE cache never saw (the #1 repro, structural)', async () => {
    hydrateBoardWithTextTile('kb', [{ tileId: 't1', title: 'Card' }]);
    // STALE cache: seeded once with no `status`, and deliberately NOT dropped.
    documentStore.setFrontmatter('Card.md', { completed: false });
    // Disk has an external `status: blocked` the cache never learned.
    installDisk('---\ncompleted: false\nstatus: blocked\n---\ncard body\n');

    const tile = { id: 't1', type: 'text', filePath: 'Card.md', title: 'Card', tags: [] } as unknown as Tile;
    await fieldEditAndFlush(tile, { completed: true });

    const written = lastWrite(captured)!;
    expect(written).toContain('completed: true'); // the user's field edit landed
    expect(written).toContain('status: blocked'); // external key survived via the fresh disk read
    expect(written).toContain('card body');
  });

  it('preserves a present-but-empty disk key (aliases:) through an unrelated field edit', async () => {
    hydrateBoardWithTextTile('kb', [{ tileId: 't1', title: 'Note' }]);
    documentStore.setFrontmatter('Note.md', { completed: false });
    // `aliases:` parses to null; the cache never carried it.
    installDisk('---\naliases:\ncompleted: false\n---\nbody\n');

    const tile = { id: 't1', type: 'text', filePath: 'Note.md', title: 'Note', tags: [] } as unknown as Tile;
    await fieldEditAndFlush(tile, { priority: 'high' });

    const written = lastWrite(captured)!;
    expect(written).toContain('priority: high');
    expect(written).toContain('aliases:'); // the empty key was NOT stripped
    expect(written).toContain('completed: false');
  });

  it('preserves a full datetime on an untouched key', async () => {
    hydrateBoardWithTextTile('kb', [{ tileId: 't1', title: 'Event' }]);
    documentStore.setFrontmatter('Event.md', { completed: false });
    installDisk('---\ncreated: 2025-01-15T10:30:00Z\ncompleted: false\n---\nbody\n');

    const tile = { id: 't1', type: 'text', filePath: 'Event.md', title: 'Event', tags: [] } as unknown as Tile;
    await fieldEditAndFlush(tile, { completed: true });

    const written = lastWrite(captured)!;
    expect(written).toContain('created: 2025-01-15T10:30:00Z'); // full datetime, not truncated
    expect(written).toContain('completed: true');
  });

  it('preserves a comment + key order on untouched keys', async () => {
    hydrateBoardWithTextTile('kb', [{ tileId: 't1', title: 'Doc' }]);
    documentStore.setFrontmatter('Doc.md', { completed: false });
    installDisk('---\n# important note\nzeta: 1\ncompleted: false\nalpha: 2\n---\nbody\n');

    const tile = { id: 't1', type: 'text', filePath: 'Doc.md', title: 'Doc', tags: [] } as unknown as Tile;
    await fieldEditAndFlush(tile, { completed: true });

    const written = lastWrite(captured)!;
    expect(written).toContain('# important note'); // comment survived
    expect(written).toContain('zeta: 1');
    expect(written).toContain('alpha: 2');
    expect(written.indexOf('zeta')).toBeLessThan(written.indexOf('alpha')); // order preserved
    expect(written).toContain('completed: true');
  });

  it('does NOT destroy an unparseable (malformed) frontmatter block', async () => {
    hydrateBoardWithTextTile('kb', [{ tileId: 't1', title: 'Bad' }]);
    documentStore.setFrontmatter('Bad.md', {});
    // Tab indentation + duplicate keys → the YAML parser refuses it.
    installDisk('---\n\tbad: yaml\n  dup: 1\n  dup: 2\n---\nbody\n');

    const tile = { id: 't1', type: 'text', filePath: 'Bad.md', title: 'Bad', tags: [] } as unknown as Tile;
    // Not fieldEditAndFlush: that waits for a write IPC, which the refused edit
    // may legitimately never issue (Audit-19 MD-2 identical-bytes skip).
    await makeWriter(tile).updateTileFrontmatter(tile.id, { priority: 'high' });
    await flushAllPendingFrontmatterWrites();
    await new Promise((r) => setTimeout(r, 50));

    // Audit-19 MD-2 — the refused edit leaves the bytes identical to disk, so the
    // gateway may skip the write entirely; either way disk keeps the block.
    const written = lastWrite(captured) ?? '---\n\tbad: yaml\n  dup: 1\n  dup: 2\n---\nbody\n';
    // Data-safe: the broken-but-present block is kept verbatim rather than
    // replaced by a dump of just the new key (total-FM-loss class).
    expect(written).toContain('bad: yaml');
    expect(written).toContain('dup: 1');
    expect(written).toContain('body');
  });
});

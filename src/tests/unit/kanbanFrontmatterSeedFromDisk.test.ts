import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { documentStore } from '@renderer/stores/document.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { seedDocumentFrontmatterFromDisk } from '@renderer/lib/boards/seedFrontmatterFromDisk';
import { makeKanbanFrontmatterWriter } from '@renderer/lib/kanban/kanbanFrontmatterWriter';
import { makeFrontmatterWriter } from '@renderer/lib/tasklist/frontmatterWriter';
import { flushAllPendingFrontmatterWrites } from '@renderer/lib/boards/frontmatterWriteScheduler';
import { cancelAllMarkdownWrites } from '@renderer/lib/vault/markdownFileWriter';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { historyStore } from '@renderer/stores/history.svelte';
import type {
  KanbanBoard as KanbanBoardType,
  TaskListBoard as TaskListBoardType,
  Tile,
} from '@renderer/schema/index';
import type { TaskRow } from '@renderer/lib/tasks/taskListModel';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Audit-6 M4 — a Kanban card / Task row with NO open editor used to seed its
 * frontmatter cache from the (durably-stale) vault index. A key an external
 * editor added since the last index rebuild was therefore absent from the seed,
 * and the next source-preserving write DROPPED it. The fix seeds the cache from
 * a fresh disk read first (`seedDocumentFrontmatterFromDisk`).
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

describe('seedDocumentFrontmatterFromDisk (Audit-6 M4)', () => {
  beforeEach(() => {
    documentStore.clear();
    cancelAllMarkdownWrites();
  });
  afterEach(() => {
    restoreFiloDefault();
    documentStore.clear();
    cancelAllMarkdownWrites();
  });

  it('seeds FM object + raw source from a fresh disk read when the cache is empty', async () => {
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') {
        return {
          success: true,
          content: '---\npriority: high\ntitle: Card\n---\nbody',
          mtimeMs: 5,
          size: 40,
        };
      }
      return { success: true };
    });
    await seedDocumentFrontmatterFromDisk('Card.md', '/vault', 'Card.md');
    expect(documentStore.getFrontmatter('Card.md')).toEqual({ priority: 'high', title: 'Card' });
    // rawFrontmatter seeded → the gateway gets a source baseline for preservation.
    expect(documentStore.getOriginalFrontmatterSource('Card.md')).toBe('priority: high\ntitle: Card');
  });

  it('is a no-op when the cache already holds an entry (no clobber, no disk read)', async () => {
    documentStore.setFrontmatter('Card.md', { priority: 'low' }, 'priority: low');
    let readAttempted = false;
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') {
        readAttempted = true;
        return { success: true, content: '---\npriority: high\n---\n' };
      }
      return { success: true };
    });
    await seedDocumentFrontmatterFromDisk('Card.md', '/vault', 'Card.md');
    expect(readAttempted).toBe(false);
    expect(documentStore.getFrontmatter('Card.md')).toEqual({ priority: 'low' });
  });

  it('leaves the cache unseeded on a disk read failure (index-seed fallback runs)', async () => {
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') return { success: false, code: 'ENOENT' };
      return { success: true };
    });
    await seedDocumentFrontmatterFromDisk('Gone.md', '/vault', 'Gone.md');
    expect(documentStore.getFrontmatter('Gone.md')).toBeUndefined();
  });

  it('no-ops on a null note path or empty vault root', async () => {
    let readAttempted = false;
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') readAttempted = true;
      return { success: true };
    });
    await seedDocumentFrontmatterFromDisk(null, '/vault', 'Card.md');
    await seedDocumentFrontmatterFromDisk('Card.md', '', 'Card.md');
    expect(readAttempted).toBe(false);
    expect(documentStore.getFrontmatter('Card.md')).toBeUndefined();
  });
});

describe('Kanban field edit seeds FM from disk, not the stale index (Audit-6 M4)', () => {
  let captured: Captured[];

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
    boardCacheStore.clear();
    vaultIndexStore.clear();
    vaultStore.setPath('/vault');
    captured = [];
    installFiloMock((channel: string, ...args: unknown[]) => {
      captured.push({ channel, args });
      if (channel === 'vault:read-file-text') {
        // Fresh disk: an external editor added `priority: high` since the last
        // index rebuild. completed is still false on disk.
        return {
          success: true,
          content: '---\npriority: high\ncompleted: false\n---\ncard body',
          mtimeMs: 7,
          size: 48,
        };
      }
      if (channel === 'vault:stat') return { success: true, mtimeMs: 7, size: 48 };
      if (channel === 'vault:write-existing-file-text') return { success: true };
      return { success: true };
    });
    // The index is STALE: it never learned about the external `priority: high`.
    vaultIndexStore.restoreMetadata('Card.md', {
      path: 'Card.md',
      title: 'Card',
      headings: [],
      tags: [],
      frontmatter: { completed: false },
      links: [],
      content: 'card body',
      lastModified: 0,
    });
  });

  afterEach(() => {
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
    boardCacheStore.clear();
    vaultIndexStore.clear();
    vaultStore.setPath('');
  });

  function makeWriter() {
    const tile = { id: 't1', type: 'text', title: 'Card', tags: [], filePath: 'Card.md' } as unknown as Tile;
    return makeKanbanFrontmatterWriter({
      getBoard: () => ({ id: 'kb', type: 'kanban', columns: [] }) as unknown as KanbanBoardType,
      getAllTilesById: () => ({ t1: tile }),
      bumpCacheVersion: () => {},
      tickAndPersist: () => {},
    });
  }

  it('toggling completed pre-seeds the FM cache from disk, so priority is not dropped', async () => {
    const writer = makeWriter();
    await writer.updateTileFrontmatter('t1', { completed: true });

    // The fix: the documentStore cache was seeded from DISK (has priority),
    // not the stale index (which lacks it). Audit-7 H1 moved the disk seed INTO
    // UpdateCardFieldCommand.execute(); awaiting updateTileFrontmatter awaits
    // that chained command, so the cache reflects the disk seed once it resolves.
    const cached = documentStore.getFrontmatter('Card.md');
    expect(cached?.priority).toBe('high');

    // Contrast: the index this would otherwise have seeded from has NO priority,
    // proving the value came from the fresh disk read.
    expect(vaultIndexStore.getMetadata('Card.md')?.frontmatter).not.toHaveProperty('priority');
  });

  it('the resulting disk write preserves the external priority key end-to-end', async () => {
    // The card's document is loaded (a docState exists) but its FM cache is
    // still empty — the exact combination that previously seeded FM from the
    // stale index. Loading a docState exercises the LIVE-EDITOR body path
    // specifically; the no-docState disk-read path (a note with no open editor)
    // is covered by the dedicated B1 describe blocks below.
    documentStore.loadDocument({
      filename: 'Card.md',
      title: 'Card',
      body: 'card body',
      htmlContent: '',
      richText: [],
    });

    const writer = makeWriter();
    await writer.updateTileFrontmatter('t1', { completed: true });

    // The command merge + schedule runs fire-and-forget via the history chain;
    // retry draining until the debounced write fires.
    await vi.waitFor(
      async () => {
        await flushAllPendingFrontmatterWrites();
        expect(lastWrite(captured), 'no markdown write captured').toBeDefined();
      },
      { timeout: 1000, interval: 20 },
    );

    const written = lastWrite(captured);
    expect(written).toContain('priority: high'); // external key survived
    expect(written).toContain('completed: true'); // user's edit applied
    expect(written).toContain('card body'); // body intact
  });
});

/**
 * Audit-7 H1 — the disk pre-seed used to run in the writer BEFORE
 * historyStore.execute(), so a Ctrl+S / quit landing in the seed-await window
 * saw an empty command chain, reported a premature "Saved", and tore down the
 * renderer before the field write was scheduled — a silent loss with no
 * .filo/.dirty sentinel. The fix hoists the seed INTO the command's execute() so
 * it's part of the chained body that `vaultStore.save()` / the quit path await
 * via `historyStore.whenChainSettled()` before flushing. These tests gate the
 * seed's disk read and pin that the chain stays in-flight (so save() can't
 * report success early) and that the field write lands once it settles.
 */
describe('Kanban field edit — whenChainSettled covers the in-flight seed (Audit-7 H1)', () => {
  let captured: Captured[];
  let readGate: Promise<void>;
  let releaseRead: () => void;

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
    boardCacheStore.clear();
    vaultIndexStore.clear();
    vaultStore.setPath('/vault');
    captured = [];
    releaseRead = () => {};
    readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    installFiloMock(async (channel: string, ...args: unknown[]) => {
      captured.push({ channel, args });
      if (channel === 'vault:read-file-text') {
        // Gate the seed's hydrate read so the command's execute() is suspended
        // mid-seed when whenChainSettled() is observed below.
        await readGate;
        return {
          success: true,
          content: '---\npriority: high\ncompleted: false\n---\ncard body',
          mtimeMs: 7,
          size: 48,
        };
      }
      if (channel === 'vault:stat') return { success: true, mtimeMs: 7, size: 48 };
      if (channel === 'vault:write-existing-file-text') return { success: true };
      return { success: true };
    });
    // Stale index (no priority) + a loaded docState so the live-document write path runs.
    vaultIndexStore.restoreMetadata('Card.md', {
      path: 'Card.md',
      title: 'Card',
      headings: [],
      tags: [],
      frontmatter: { completed: false },
      links: [],
      content: 'card body',
      lastModified: 0,
    });
    documentStore.loadDocument({
      filename: 'Card.md',
      title: 'Card',
      body: 'card body',
      htmlContent: '',
      richText: [],
    });
  });

  afterEach(() => {
    releaseRead();
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
    boardCacheStore.clear();
    vaultIndexStore.clear();
    vaultStore.setPath('');
  });

  function makeWriter() {
    const tile = { id: 't1', type: 'text', title: 'Card', tags: [], filePath: 'Card.md' } as unknown as Tile;
    return makeKanbanFrontmatterWriter({
      getBoard: () => ({ id: 'kb', type: 'kanban', columns: [] }) as unknown as KanbanBoardType,
      getAllTilesById: () => ({ t1: tile }),
      bumpCacheVersion: () => {},
      tickAndPersist: () => {},
    });
  }

  it('whenChainSettled() stays pending while the seed read is in flight', async () => {
    const writer = makeWriter();
    // Fire the edit WITHOUT awaiting (mirrors a UI click). The command is now on
    // the history chain, suspended at its gated seed read.
    const editP = writer.updateTileFrontmatter('t1', { completed: true });

    let chainSettled = false;
    const chainP = historyStore.whenChainSettled().then(() => {
      chainSettled = true;
    });
    // Let microtasks drain; the gated read keeps the command's execute() — and
    // therefore the chain save() awaits — in flight.
    await new Promise((r) => setTimeout(r, 0));
    expect(chainSettled).toBe(false);

    // Release the read: the seed resolves, the merge + schedule run, the chain
    // settles, and (as save() does next) the FM write flushes to disk.
    releaseRead();
    await chainP;
    await editP;
    expect(chainSettled).toBe(true);

    await flushAllPendingFrontmatterWrites();
    const written = lastWrite(captured);
    expect(written, 'no markdown write captured after the chain settled').toBeDefined();
    expect(written).toContain('completed: true'); // user's edit landed
    expect(written).toContain('priority: high'); // externally-added key survived
  });
});

/**
 * Audit-8 B1 — a Kanban card / Task row whose note has an FM cache entry
 * (the field patch is merged into it) but was NEVER opened as a Document tab has no docState in
 * `openDocuments`. The frontmatter writer's `if (!docState) return` then
 * resolved the write as SUCCESS without touching disk: `endWrite(true)` cleared
 * `.filo/.dirty`, `.board.json` stripped the derived field on its own write, and
 * the edit silently reverted on next launch — no error, no recovery sentinel.
 *
 * Every prior test that asserted a DISK write pre-loaded a docState to dodge
 * that abort (see the "Loading a docState exercises the LIVE-EDITOR body path"
 * note above). These drive the REAL UI path — a field edit with NO loadDocument
 * — and assert the write actually lands (or fails loudly on a missing file,
 * never silently). Body resolution is unified: a note with no live
 * docState falls through to the SAME fresh-disk-read the orphan (no note
 * path) branch uses.
 */
describe('Audit-8 B1 — un-opened Kanban card field edit reaches disk (no docState)', () => {
  let captured: Captured[];

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
    boardCacheStore.clear();
    vaultIndexStore.clear();
    vaultStore.setPath('/vault');
    captured = [];
    installFiloMock((channel: string, ...args: unknown[]) => {
      captured.push({ channel, args });
      if (channel === 'vault:read-file-text') {
        // Disk carries an externally-added `priority: high` the stale index
        // never learned; completed is still false on disk.
        return {
          success: true,
          content: '---\npriority: high\ncompleted: false\n---\ncard body',
          mtimeMs: 7,
          size: 48,
        };
      }
      if (channel === 'vault:stat') return { success: true, mtimeMs: 7, size: 48 };
      if (channel === 'vault:write-existing-file-text') return { success: true };
      return { success: true };
    });
    vaultIndexStore.restoreMetadata('Card.md', {
      path: 'Card.md',
      title: 'Card',
      headings: [],
      tags: [],
      frontmatter: { completed: false },
      links: [],
      content: 'card body',
      lastModified: 0,
    });
  });

  afterEach(() => {
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
    boardCacheStore.clear();
    vaultIndexStore.clear();
    vaultStore.setPath('');
  });

  function makeWriter() {
    const tile = { id: 't1', type: 'text', title: 'Card', tags: [], filePath: 'Card.md' } as unknown as Tile;
    return makeKanbanFrontmatterWriter({
      getBoard: () => ({ id: 'kb', type: 'kanban', columns: [] }) as unknown as KanbanBoardType,
      getAllTilesById: () => ({ t1: tile }),
      bumpCacheVersion: () => {},
      tickAndPersist: () => {},
    });
  }

  it('toggling completed writes the merged FM to disk even with no Document tab open', async () => {
    // Crucially: NO documentStore.loadDocument — exactly the real UI state for a
    // card the user never opened as a Document. Pre-fix this aborted silently.
    expect(documentStore.getDocument('Card.md')).toBeUndefined();

    const writer = makeWriter();
    await writer.updateTileFrontmatter('t1', { completed: true });

    await vi.waitFor(
      async () => {
        await flushAllPendingFrontmatterWrites();
        expect(lastWrite(captured), 'no markdown write captured (B1 silent drop)').toBeDefined();
      },
      { timeout: 1000, interval: 20 },
    );

    const written = lastWrite(captured);
    expect(written).toContain('completed: true'); // the user's edit reached disk
    expect(written).toContain('priority: high'); // external key preserved (disk-read body path)
    expect(written).toContain('card body'); // body intact
  });

  it('a missing backing file surfaces the loss in flushAll().failed (no false "Saved")', async () => {
    // Override: every disk read now fails (the .md was deleted out-of-band). The
    // edit is still cached + scheduled, but the write must fail LOUDLY rather
    // than silently succeed and clear the recovery sentinel.
    installFiloMock((channel: string, ...args: unknown[]) => {
      captured.push({ channel, args });
      if (channel === 'vault:read-file-text') return { success: false, code: 'ENOENT' };
      if (channel === 'vault:write-existing-file-text') return { success: true };
      return { success: true };
    });

    const writer = makeWriter();
    await writer.updateTileFrontmatter('t1', { completed: true });

    // flushAll fires the synchronously-captured pending write in one call, so
    // the FIRST drain carries the attribution (a retry would find nothing
    // pending). The disk read throws ENOENT → markPathFailed + rethrow → the
    // path lands in `.failed`, so save()'s aggregate refuses a false "Saved".
    const result = await flushAllPendingFrontmatterWrites();
    expect(result.failed).toContain('Card.md');
    // No write was committed — the read failed before assembly.
    expect(lastWrite(captured)).toBeUndefined();
  });
});

describe('Audit-8 B1 — un-opened Task row field edit reaches disk (no docState)', () => {
  let captured: Captured[];

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
    boardCacheStore.clear();
    vaultIndexStore.clear();
    vaultStore.setPath('/vault');
    captured = [];
    installFiloMock((channel: string, ...args: unknown[]) => {
      captured.push({ channel, args });
      if (channel === 'vault:read-file-text') {
        return {
          success: true,
          content: '---\npriority: high\ncompleted: false\n---\ntask body',
          mtimeMs: 7,
          size: 48,
        };
      }
      if (channel === 'vault:stat') return { success: true, mtimeMs: 7, size: 48 };
      if (channel === 'vault:write-existing-file-text') return { success: true };
      return { success: true };
    });
    vaultIndexStore.restoreMetadata('Task.md', {
      path: 'Task.md',
      title: 'Task',
      headings: [],
      tags: [],
      frontmatter: { completed: false },
      links: [],
      content: 'task body',
      lastModified: 0,
    });
  });

  afterEach(() => {
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
    boardCacheStore.clear();
    vaultIndexStore.clear();
    vaultStore.setPath('');
  });

  function makeWriter() {
    return makeFrontmatterWriter({
      getBoard: () =>
        ({
          id: 'tl',
          type: 'tasklist',
          name: 'T',
          emoji: '',
          createdAt: 0,
          updatedAt: 0,
          settings: {},
          tasks: [],
          sections: [],
        }) as unknown as TaskListBoardType,
      vaultPathForTile: () => 'Task.md',
      readFrontmatter: () => ({ completed: false }),
      bumpCacheVersion: () => {},
    });
  }

  function makeRow(): TaskRow {
    return {
      placement: { tileId: 't2', position: 0 },
      tile: { id: 't2', type: 'text', filePath: 'Task.md', title: 'Task', tags: [] } as unknown as Tile,
      completed: false,
      priority: 'none',
      dueDate: '',
      dueTime: '',
      startDate: '',
      status: '',
      tags: [],
      parent: '',
      recurrence: '',
      recurrenceMode: 'schedule',
      category: '',
    };
  }

  it('toggling completed writes the merged FM to disk with no Document tab open', async () => {
    expect(documentStore.getDocument('Task.md')).toBeUndefined();

    const writer = makeWriter();
    await writer.toggleCompleted(makeRow());

    await vi.waitFor(
      async () => {
        await flushAllPendingFrontmatterWrites();
        expect(lastWrite(captured), 'no markdown write captured (B1 silent drop)').toBeDefined();
      },
      { timeout: 1000, interval: 20 },
    );

    const written = lastWrite(captured);
    expect(written).toContain('completed: true'); // user's edit reached disk
    expect(written).toContain('priority: high'); // external key preserved
    expect(written).toContain('task body'); // body intact
  });
});

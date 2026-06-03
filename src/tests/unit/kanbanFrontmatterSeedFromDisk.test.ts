import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { documentStore } from '@renderer/stores/document.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { seedDocumentFrontmatterFromDisk } from '@renderer/lib/boards/seedFrontmatterFromDisk';
import { makeKanbanFrontmatterWriter } from '@renderer/lib/kanban/kanbanFrontmatterWriter';
import { flushAllPendingFrontmatterWrites } from '@renderer/lib/boards/frontmatterWriteScheduler';
import { cancelAllMarkdownWrites } from '@renderer/lib/vault/markdownFileWriter';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import type { KanbanBoard as KanbanBoardType, Tile } from '@renderer/schema/index';
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
    await seedDocumentFrontmatterFromDisk('doc1', '/vault', 'Card.md');
    expect(documentStore.getFrontmatter('doc1')).toEqual({ priority: 'high', title: 'Card' });
    // rawFrontmatter seeded → the gateway gets a source baseline for preservation.
    expect(documentStore.getOriginalFrontmatterSource('doc1')).toBe('priority: high\ntitle: Card');
  });

  it('is a no-op when the cache already holds an entry (no clobber, no disk read)', async () => {
    documentStore.setFrontmatter('doc2', { priority: 'low' }, 'priority: low');
    let readAttempted = false;
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') {
        readAttempted = true;
        return { success: true, content: '---\npriority: high\n---\n' };
      }
      return { success: true };
    });
    await seedDocumentFrontmatterFromDisk('doc2', '/vault', 'Card.md');
    expect(readAttempted).toBe(false);
    expect(documentStore.getFrontmatter('doc2')).toEqual({ priority: 'low' });
  });

  it('leaves the cache unseeded on a disk read failure (index-seed fallback runs)', async () => {
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') return { success: false, code: 'ENOENT' };
      return { success: true };
    });
    await seedDocumentFrontmatterFromDisk('doc3', '/vault', 'Gone.md');
    expect(documentStore.getFrontmatter('doc3')).toBeUndefined();
  });

  it('no-ops on a null docId or empty vault root', async () => {
    let readAttempted = false;
    installFiloMock((channel: string) => {
      if (channel === 'vault:read-file-text') readAttempted = true;
      return { success: true };
    });
    await seedDocumentFrontmatterFromDisk(null, '/vault', 'Card.md');
    await seedDocumentFrontmatterFromDisk('doc4', '', 'Card.md');
    expect(readAttempted).toBe(false);
    expect(documentStore.getFrontmatter('doc4')).toBeUndefined();
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
    const tile = { id: 't1', type: 'text', contentId: 'doc1', title: 'Card', tags: [] } as unknown as Tile;
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
    // not the stale index (which lacks it). The pre-seed runs synchronously
    // within the awaited call, before the (fire-and-forget) command merge.
    const cached = documentStore.getFrontmatter('doc1');
    expect(cached?.priority).toBe('high');

    // Contrast: the index this would otherwise have seeded from has NO priority,
    // proving the value came from the fresh disk read.
    expect(vaultIndexStore.getMetadata('Card.md')?.frontmatter).not.toHaveProperty('priority');
  });

  it('the resulting disk write preserves the external priority key end-to-end', async () => {
    // The card's document is loaded (a docState exists) but its FM cache is
    // still empty — the exact combination that previously seeded FM from the
    // stale index. The docId-path scheduler writes only when a docState exists
    // (it aborts otherwise to avoid resurrecting a no-editor card from a stale
    // snapshot), so load one to exercise the write end-to-end.
    documentStore.loadDocument({
      docId: 'doc1',
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

/**
 * Phase 5 / 5.1 — UpdatePropertiesCommand regression guard.
 *
 * The PropertiesPopup writes frontmatter (text tiles) or `tile.metadata`
 * (non-text tiles) directly without history before this phase. The new
 * command snapshots before/after on popup close and lets Ctrl+Z restore
 * both the cache + the on-disk YAML.
 *
 * These tests assert:
 *   - execute() applies the "after" snapshot for both kinds (text → disk
 *     write via vault:write-existing-file-text; non-text → boardStore.updateTile).
 *   - undo() restores the "before" snapshot.
 *   - redo() re-applies "after" again.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { documentStore } from '@renderer/stores/document.svelte';
import { UpdatePropertiesCommand } from '@renderer/commands/index';
import type { V7BoardFileData } from '@renderer/lib/boards/boardSaver';
import type { MindMapBoard, Tile, TextTile, ImageTile } from '@renderer/schema/index';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

interface FiloRecorder {
  calls: Array<{ channel: string; args: unknown[] }>;
}

function installRecorder(): FiloRecorder {
  const calls: FiloRecorder['calls'] = [];
  installFiloMock((channel: unknown, ...args: unknown[]) => {
    calls.push({ channel: channel as string, args });
    if (channel === 'vault:write-existing-file-text') {
      return { success: true };
    }
    return undefined;
  });
  return { calls };
}

function makeMindMapWithTiles(tiles: Tile[]): V7BoardFileData {
  const placements: Record<string, unknown> = {};
  const tileDefs: Record<string, unknown> = {};
  for (const t of tiles) {
    placements[t.id] = { id: t.id, tileId: t.id, position: t.position, size: t.size };
    tileDefs[t.id] = {
      id: t.id,
      type: t.type,
      title: t.title,
      style: t.style ?? {},
      tags: t.tags ?? [],
      createdAt: 0,
      updatedAt: 0,
      ...(t.type === 'text' ? { contentId: (t as TextTile).contentId } : {}),
      metadata: (t as Tile & { metadata?: Record<string, unknown> }).metadata,
    };
  }
  return {
    board: {
      id: 'mm',
      type: 'mindmap',
      name: 'M',
      emoji: '',
      createdAt: 0,
      updatedAt: 0,
      settings: {},
      placements,
      inlineTiles: {},
      waypoints: [],
    } as unknown as MindMapBoard,
    tileDefs: tileDefs as V7BoardFileData['tileDefs'],
    connections: {},
    frames: [],
  };
}

function makeImageTile(metadata: Record<string, unknown>): ImageTile {
  return {
    id: 'img-1',
    boardId: 'mm',
    type: 'image',
    title: 'pic',
    position: { x: 0, y: 0 },
    size: { width: 200, height: 200 },
    style: { headerColor: '', bodyColor: '', borderColor: '' },
    tags: [],
    locked: false,
    faded: false,
    createdAt: 0,
    updatedAt: 0,
    src: '',
    metadata,
  } as unknown as ImageTile;
}

describe('UpdatePropertiesCommand — metadata (non-text tile)', () => {
  beforeEach(() => {
    installRecorder();
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardStore.clearBoard();
  });
  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
  });

  it('execute / undo / redo round-trips tile.metadata for non-text tiles', async () => {
    const tile = makeImageTile({ caption: 'old' });
    const fixture = makeMindMapWithTiles([tile]);
    boardCacheStore.hydrate({ mm: fixture }, { mm: 'm.board.json' });
    boardStore.setBoard(fixture.board, { [tile.id]: tile }, {}, []);

    const cmd = new UpdatePropertiesCommand(
      { kind: 'metadata', tileId: tile.id, metadata: { caption: 'old' } },
      { kind: 'metadata', tileId: tile.id, metadata: { caption: 'new', priority: 'high' } },
    );

    await cmd.execute();
    const after = boardStore.getTile(tile.id) as ImageTile;
    expect(after.metadata).toMatchObject({ caption: 'new', priority: 'high' });

    await cmd.undo();
    const restored = boardStore.getTile(tile.id) as ImageTile;
    expect(restored.metadata).toMatchObject({ caption: 'old' });
    expect((restored.metadata as Record<string, unknown>).priority).toBeUndefined();

    await cmd.execute();
    const reapplied = boardStore.getTile(tile.id) as ImageTile;
    expect(reapplied.metadata).toMatchObject({ caption: 'new', priority: 'high' });
  });
});

describe('UpdatePropertiesCommand — frontmatter (text tile)', () => {
  let recorder: FiloRecorder;

  beforeEach(() => {
    recorder = installRecorder();
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardStore.clearBoard();
  });
  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
    documentStore.clear();
  });

  it('execute writes the after snapshot via vault:write-existing-file-text', async () => {
    documentStore.loadDocument({
      docId: 'doc-1',
      filename: 'Notes.md',
      title: 'Notes',
      body: 'hello body',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter('doc-1', { tags: ['old'] });

    const cmd = new UpdatePropertiesCommand(
      { kind: 'frontmatter', relPath: 'Notes.md', docId: 'doc-1', fm: { tags: ['old'] } },
      { kind: 'frontmatter', relPath: 'Notes.md', docId: 'doc-1', fm: { tags: ['new'], priority: 'high' } },
    );

    await cmd.execute();
    const writeCall = recorder.calls.find((c) => c.channel === 'vault:write-existing-file-text');
    expect(writeCall).toBeDefined();
    expect(writeCall?.args[1]).toBe('Notes.md');
    expect(writeCall?.args[2]).toContain('priority: high');
    expect(writeCall?.args[2]).toContain('hello body');
    expect(documentStore.getFrontmatter('doc-1')).toMatchObject({
      tags: ['new'],
      priority: 'high',
    });
  });

  it('undo restores prior frontmatter via vault:write-existing-file-text', async () => {
    documentStore.loadDocument({
      docId: 'doc-2',
      filename: 'A.md',
      title: 'A',
      body: 'body',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter('doc-2', { priority: 'low' });

    const cmd = new UpdatePropertiesCommand(
      { kind: 'frontmatter', relPath: 'A.md', docId: 'doc-2', fm: { priority: 'low' } },
      { kind: 'frontmatter', relPath: 'A.md', docId: 'doc-2', fm: { priority: 'high' } },
    );

    await cmd.execute();
    expect(documentStore.getFrontmatter('doc-2')).toMatchObject({ priority: 'high' });

    await cmd.undo();
    const undoCall = recorder.calls
      .filter((c) => c.channel === 'vault:write-existing-file-text')
      .pop();
    expect(undoCall?.args[2]).toContain('priority: low');
    expect(documentStore.getFrontmatter('doc-2')).toMatchObject({ priority: 'low' });
  });

  it('snapshots deep-cloned so later mutations do not poison the command', async () => {
    const sharedFm = { tags: ['a'] };
    const cmd = new UpdatePropertiesCommand(
      { kind: 'frontmatter', relPath: 'X.md', docId: null, fm: sharedFm },
      { kind: 'frontmatter', relPath: 'X.md', docId: null, fm: { tags: ['b'] } },
    );

    // Mutate the caller-side object after construction.
    (sharedFm.tags as string[]).push('poison');

    await cmd.undo();
    // Snapshot survived intact — disk write reflects ['a'], not ['a','poison'].
    const writeCall = recorder.calls
      .filter((c) => c.channel === 'vault:write-existing-file-text')
      .pop();
    expect(writeCall?.args[2]).toContain('- a');
    expect(writeCall?.args[2]).not.toContain('poison');
  });

  it('no-op when no vault is open (defensive)', async () => {
    vaultStore.setPath('');
    const cmd = new UpdatePropertiesCommand(
      { kind: 'frontmatter', relPath: 'X.md', docId: null, fm: {} },
      { kind: 'frontmatter', relPath: 'X.md', docId: null, fm: { priority: 'high' } },
    );
    await cmd.execute();
    // No write attempted — only the missing-vault early-return fires.
    expect(recorder.calls.find((c) => c.channel === 'vault:write-existing-file-text')).toBeUndefined();
  });
});

describe('UpdatePropertiesCommand — H2 undo preserves externally-added keys', () => {
  let recorder: FiloRecorder;

  beforeEach(() => {
    recorder = installRecorder();
    vaultStore.setPath('/vault');
    boardCacheStore.clear();
    boardStore.clearBoard();
  });
  afterEach(() => {
    restoreFiloDefault();
    vaultStore.setPath('');
    boardCacheStore.clear();
    boardStore.clearBoard();
    documentStore.clear();
  });

  it('undo keeps a key added externally (via the live cache) between edit and Ctrl+Z', async () => {
    documentStore.loadDocument({
      docId: 'doc-h2',
      filename: 'H2.md',
      title: 'H2',
      body: 'h2 body',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter('doc-h2', { priority: 'low' });

    // User changes ONE property (priority low → high) via the popup.
    const cmd = new UpdatePropertiesCommand(
      { kind: 'frontmatter', relPath: 'H2.md', docId: 'doc-h2', fm: { priority: 'low' } },
      { kind: 'frontmatter', relPath: 'H2.md', docId: 'doc-h2', fm: { priority: 'high' } },
    );
    await cmd.execute();
    expect(documentStore.getFrontmatter('doc-h2')).toMatchObject({ priority: 'high' });

    // Another tool adds `reviewed: true` and the sync reconciler merges it into
    // the live cache (this is the state the next undo rebases against).
    documentStore.setFrontmatter('doc-h2', { priority: 'high', reviewed: true });

    await cmd.undo();
    // Pre-fix the whole-snapshot replace wrote `{ priority: low }` and erased
    // `reviewed`. The rebase keeps it: only the OWNED key (priority) reverts.
    expect(documentStore.getFrontmatter('doc-h2')).toMatchObject({
      priority: 'low',
      reviewed: true,
    });
    const undoWrite = recorder.calls
      .filter((c) => c.channel === 'vault:write-existing-file-text')
      .pop();
    expect(undoWrite?.args[2]).toContain('priority: low');
    expect(undoWrite?.args[2]).toContain('reviewed: true');
  });

  it('undo keeps a key added externally ON DISK when no editor cache is seeded', async () => {
    // No documentStore seed → the live base comes from a fresh disk read.
    const calls: FiloRecorder['calls'] = [];
    installFiloMock((channel: unknown, ...args: unknown[]) => {
      calls.push({ channel: channel as string, args });
      if (channel === 'vault:read-file-text') {
        return {
          success: true,
          content: '---\npriority: high\nreviewed: true\n---\nDisk body\n',
          mtimeMs: 1,
          size: 60,
        };
      }
      if (channel === 'vault:stat') return { success: true, mtimeMs: 1, size: 60 };
      if (channel === 'vault:write-existing-file-text') return { success: true };
      return undefined;
    });

    const cmd = new UpdatePropertiesCommand(
      { kind: 'frontmatter', relPath: 'Disk.md', docId: 'doc-disk', fm: { priority: 'low' } },
      { kind: 'frontmatter', relPath: 'Disk.md', docId: 'doc-disk', fm: { priority: 'high' } },
    );

    // Undo reverts priority high → low while preserving the on-disk reviewed key.
    await cmd.undo();
    const undoWrite = calls
      .filter((c) => c.channel === 'vault:write-existing-file-text')
      .pop();
    expect(undoWrite?.args[2]).toContain('priority: low');
    expect(undoWrite?.args[2]).toContain('reviewed: true');
  });
});

describe('UpdatePropertiesCommand — description', () => {
  beforeEach(() => {
    installRecorder();
  });
  afterEach(() => restoreFiloDefault());

  it('uses a stable human-readable label', () => {
    const cmd = new UpdatePropertiesCommand(
      { kind: 'metadata', tileId: 't1', metadata: {} },
      { kind: 'metadata', tileId: 't1', metadata: { a: 1 } },
    );
    expect(cmd.description).toBe('Update properties');
  });
});

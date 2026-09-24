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

/**
 * Phase 4 (WRITE_PATH_REMEDIATION_PLAN_2026-06-04) — the Properties write now
 * applies its field delta to a FRESH disk read. Tests that exercise a text-tile
 * FM write pass `diskContent` (the on-disk `.md` the gateway re-reads in-chain).
 * Omitting it leaves `vault:read-file-text` unhandled (returns undefined), which
 * the disk-read path treats as "unreadable" → the `base === null` blind-apply
 * legacy write — the corner the null-notePath / no-vault tests rely on.
 */
function installRecorder(diskContent?: string): FiloRecorder {
  const calls: FiloRecorder['calls'] = [];
  installFiloMock((channel: unknown, ...args: unknown[]) => {
    calls.push({ channel: channel as string, args });
    if (channel === 'vault:write-existing-file-text') {
      return { success: true };
    }
    if (diskContent !== undefined) {
      if (channel === 'vault:read-file-text') {
        return { success: true, content: diskContent, mtimeMs: 1, size: diskContent.length };
      }
      if (channel === 'vault:stat') {
        return { success: true, mtimeMs: 1, size: diskContent.length };
      }
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
      ...(t.type === 'text' ? { filePath: (t as TextTile).filePath } : { title: t.title }),
      ...(t.type === 'image' ? { src: (t as ImageTile).src } : {}),
      style: t.style ?? {},
      createdAt: 0,
      updatedAt: 0,
      metadata: (t as Tile & { metadata?: Record<string, unknown> }).metadata,
    };
  }
  return {
    version: 8,
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
    // Phase 4 — disk holds the seeded "before" state; the delta is applied to it.
    recorder = installRecorder('---\ntags:\n  - old\n---\nhello body\n');
    documentStore.loadDocument({
      filename: 'Notes.md',
      title: 'Notes',
      body: 'hello body',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter('Notes.md', { tags: ['old'] });

    const cmd = new UpdatePropertiesCommand(
      { kind: 'frontmatter', relPath: 'Notes.md', notePath: 'Notes.md', fm: { tags: ['old'] } },
      { kind: 'frontmatter', relPath: 'Notes.md', notePath: 'Notes.md', fm: { tags: ['new'], priority: 'high' } },
    );

    await cmd.execute();
    const writeCall = recorder.calls.find((c) => c.channel === 'vault:write-existing-file-text');
    expect(writeCall).toBeDefined();
    expect(writeCall?.args[1]).toBe('Notes.md');
    expect(writeCall?.args[2]).toContain('priority: high');
    expect(writeCall?.args[2]).toContain('hello body');
    expect(documentStore.getFrontmatter('Notes.md')).toMatchObject({
      tags: ['new'],
      priority: 'high',
    });
  });

  it('undo restores prior frontmatter via vault:write-existing-file-text', async () => {
    recorder = installRecorder('---\npriority: low\n---\nbody\n');
    documentStore.loadDocument({
      filename: 'A.md',
      title: 'A',
      body: 'body',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter('A.md', { priority: 'low' });

    const cmd = new UpdatePropertiesCommand(
      { kind: 'frontmatter', relPath: 'A.md', notePath: 'A.md', fm: { priority: 'low' } },
      { kind: 'frontmatter', relPath: 'A.md', notePath: 'A.md', fm: { priority: 'high' } },
    );

    await cmd.execute();
    expect(documentStore.getFrontmatter('A.md')).toMatchObject({ priority: 'high' });

    await cmd.undo();
    const undoCall = recorder.calls
      .filter((c) => c.channel === 'vault:write-existing-file-text')
      .pop();
    expect(undoCall?.args[2]).toContain('priority: low');
    expect(documentStore.getFrontmatter('A.md')).toMatchObject({ priority: 'low' });
  });

  it('snapshots deep-cloned so later mutations do not poison the command', async () => {
    // Disk holds the post-execute "after" state (tags: [b]); undo reverts it to
    // the "before" snapshot. Audit-18 6.3 — a successful read is REQUIRED now: a
    // null-notePath Properties undo against an UNREADABLE file refuses rather than
    // blind-writing a stale body, so this test mocks the (realistic) readable
    // disk and asserts the deep-cloned snapshot is what reaches the write.
    recorder = installRecorder('---\ntags:\n  - b\n---\nbody\n');
    const sharedFm = { tags: ['a'] };
    const cmd = new UpdatePropertiesCommand(
      { kind: 'frontmatter', relPath: 'X.md', notePath: null, fm: sharedFm },
      { kind: 'frontmatter', relPath: 'X.md', notePath: null, fm: { tags: ['b'] } },
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
      { kind: 'frontmatter', relPath: 'X.md', notePath: null, fm: {} },
      { kind: 'frontmatter', relPath: 'X.md', notePath: null, fm: { priority: 'high' } },
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

  it('undo keeps a key added externally between edit and Ctrl+Z', async () => {
    // Phase 4 — the external editor wrote `reviewed: true` to DISK; the gateway's
    // delta write re-reads disk, so the untouched key survives by construction
    // (the reconciler also merges it into the live cache, mirrored below).
    recorder = installRecorder('---\npriority: high\nreviewed: true\n---\nh2 body\n');
    documentStore.loadDocument({
      filename: 'H2.md',
      title: 'H2',
      body: 'h2 body',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter('H2.md', { priority: 'low' });

    // User changes ONE property (priority low → high) via the popup.
    const cmd = new UpdatePropertiesCommand(
      { kind: 'frontmatter', relPath: 'H2.md', notePath: 'H2.md', fm: { priority: 'low' } },
      { kind: 'frontmatter', relPath: 'H2.md', notePath: 'H2.md', fm: { priority: 'high' } },
    );
    await cmd.execute();
    expect(documentStore.getFrontmatter('H2.md')).toMatchObject({ priority: 'high' });

    // Another tool added `reviewed: true` (on disk above); the sync reconciler
    // merges it into the live cache — the state the next undo rebases against.
    documentStore.setFrontmatter('H2.md', { priority: 'high', reviewed: true });

    await cmd.undo();
    // Pre-fix the whole-snapshot replace wrote `{ priority: low }` and erased
    // `reviewed`. The rebase keeps it: only the OWNED key (priority) reverts.
    expect(documentStore.getFrontmatter('H2.md')).toMatchObject({
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
      { kind: 'frontmatter', relPath: 'Disk.md', notePath: 'Disk.md', fm: { priority: 'low' } },
      { kind: 'frontmatter', relPath: 'Disk.md', notePath: 'Disk.md', fm: { priority: 'high' } },
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

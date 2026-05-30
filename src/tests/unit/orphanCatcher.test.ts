import { describe, it, expect } from 'vitest';
import { findOrphans } from '@renderer/lib/canvas/orphanCatcher';
import type { Tile, Connection } from '@renderer/schema/index';

// Minimal fixture helpers. findOrphans only reads: type, content, tags,
// position, size, id — we cast to Tile to keep the fixtures tight.
function textTile(id: string, x: number, y: number, opts: { content?: string; tags?: string[] } = {}): Tile {
  return {
    id,
    type: 'text',
    title: id,
    position: { x, y },
    size: { width: 100, height: 80 },
    style: {
      headerColor: '#fff', bodyColor: '#fff', borderColor: '',
      shape: 'rounded', borderStyle: 'solid', borderWidth: 1, shadowIntensity: 0,
    },
    locked: false,
    faded: false,
    tags: opts.tags ?? [],
    boardId: 'board',
    createdAt: 0,
    updatedAt: 0,
    contentId: id,
    content: opts.content ?? 'hello',
  } as unknown as Tile;
}

function conn(id: string, from: string, to: string): Connection {
  return {
    id,
    fromTileId: from,
    toTileId: to,
  } as unknown as Connection;
}

function asMap<T extends { id: string }>(items: T[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const item of items) out[item.id] = item;
  return out;
}

describe('findOrphans', () => {
  it('returns empty array when there are no tiles', () => {
    expect(findOrphans({ tiles: {}, connections: {} })).toEqual([]);
  });

  it('flags an empty text tile as orphan (even if clustered)', () => {
    const tiles = asMap([
      textTile('a', 0, 0, { content: '' }),
      textTile('b', 120, 0),
    ]);
    const result = findOrphans({ tiles, connections: {} });
    expect(result).toEqual([{ tileId: 'a', reason: 'empty' }]);
  });

  it('strips HTML and whitespace when deciding emptiness', () => {
    const tiles = asMap([
      textTile('blank', 0, 0, { content: '<p>&nbsp;</p>' }),
      textTile('nonblank', 120, 0, { content: '<p>hi</p>' }),
    ]);
    const result = findOrphans({ tiles, connections: {} });
    expect(result.map((r) => r.tileId)).toEqual(['blank']);
  });

  it('flags isolated tiles that are far from any cluster', () => {
    const tiles = asMap([
      textTile('cluster1', 0, 0),
      textTile('cluster2', 120, 0),
      textTile('lonely', 5000, 5000),
    ]);
    const result = findOrphans({ tiles, connections: {}, clusterDistance: 600 });
    expect(result).toEqual([{ tileId: 'lonely', reason: 'isolated' }]);
  });

  it('does not flag tiles that have a connection', () => {
    const tiles = asMap([
      textTile('a', 0, 0),
      textTile('b', 5000, 5000),
    ]);
    const connections = asMap([conn('c1', 'a', 'b')]);
    const result = findOrphans({ tiles, connections, clusterDistance: 600 });
    expect(result).toEqual([]);
  });

  it('does not flag tiles that carry at least one tag', () => {
    // 'a' + 'b' are clustered (so neither is isolated); 'tagged' is far away
    // but exempted because it carries a tag.
    const tiles = asMap([
      textTile('a', 0, 0),
      textTile('b', 120, 0),
      textTile('tagged', 5000, 5000, { tags: ['tag1'] }),
    ]);
    const result = findOrphans({ tiles, connections: {}, clusterDistance: 600 });
    expect(result).toEqual([]);
  });

  it('uses edge-to-edge distance, not centre-to-centre', () => {
    // Tiles are 100 wide. 'a' at x=0..100, 'b' at x=500..600 — edge gap is 400.
    const tiles = asMap([
      textTile('a', 0, 0),
      textTile('b', 500, 0),
    ]);
    // Cluster distance 500 > edge gap 400 => neither is isolated.
    const near = findOrphans({ tiles, connections: {}, clusterDistance: 500 });
    expect(near).toEqual([]);
    // Cluster distance 200 < edge gap 400 => both are isolated.
    const far = findOrphans({ tiles, connections: {}, clusterDistance: 200 });
    expect(far.map((r) => r.tileId).sort()).toEqual(['a', 'b']);
  });
});

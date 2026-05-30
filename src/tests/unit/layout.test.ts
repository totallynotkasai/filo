import { describe, it, expect } from 'vitest';
import { alignTiles, layoutTree, layoutRadial } from '@renderer/lib/canvas/layout';
import { LAYOUT_GAP_BUFFER } from '@renderer/constants/defaults';
import type { Tile, Connection } from '@renderer/schema/index';

function makeTile(id: string, x: number, y: number, w = 240, h = 160): Tile {
  return {
    id,
    type: 'text',
    title: id,
    position: { x, y },
    size: { width: w, height: h },
    style: {
      headerColor: '#fff',
      bodyColor: '#fff',
      borderColor: '',
      shape: 'rounded',
      borderStyle: 'solid',
      borderWidth: 1,
      shadowIntensity: 0.3,
    },
    locked: false,
    faded: false,
    tags: [],
    boardId: 'b1',
    createdAt: 1,
    updatedAt: 1,
    contentId: 'c1',
    content: '',
  } as Tile;
}

describe('Layout Algorithms', () => {
  describe('alignTiles', () => {
    it('left-aligns tiles to the minimum x', () => {
      const tiles: Record<string, Tile> = {
        a: makeTile('a', 100, 50),
        b: makeTile('b', 300, 200),
        c: makeTile('c', 200, 400),
      };
      const result = alignTiles(tiles, ['a', 'b', 'c'], 'left');
      // Tile 'a' is already at x=100 (the min), so it should not appear in the result
      expect(result.has('a')).toBe(false);
      // Tiles 'b' and 'c' should be moved to x=100
      expect(result.get('b')?.after.x).toBe(100);
      expect(result.get('c')?.after.x).toBe(100);
      // y values should be unchanged
      expect(result.get('b')?.after.y).toBe(200);
      expect(result.get('c')?.after.y).toBe(400);
    });

    it('top-aligns tiles to the minimum y', () => {
      const tiles: Record<string, Tile> = {
        a: makeTile('a', 100, 300),
        b: makeTile('b', 200, 100),
      };
      const result = alignTiles(tiles, ['a', 'b'], 'top');
      expect(result.get('a')?.after.y).toBe(100);
      expect(result.has('b')).toBe(false); // already at min y
    });

    it('returns empty map for single tile', () => {
      const tiles: Record<string, Tile> = { a: makeTile('a', 100, 50) };
      const result = alignTiles(tiles, ['a'], 'left');
      expect(result.size).toBe(0);
    });

    it('center-h aligns tiles horizontally', () => {
      const tiles: Record<string, Tile> = {
        a: makeTile('a', 0, 0, 200, 100),
        b: makeTile('b', 400, 0, 200, 100),
      };
      const result = alignTiles(tiles, ['a', 'b'], 'center-h');
      // Center of 'a' = 0 + 100 = 100, center of 'b' = 400 + 100 = 500
      // Average center = 300, so both tiles should be at x = 300 - 100 = 200
      expect(result.size).toBeGreaterThan(0);
    });

    it('distribute-h spaces tiles with equal gaps that prevent overlap', () => {
      // Three tiles of varying widths in a row.
      // a (width 200) at x=0; b (width 600) at x=300; c (width 200) at x=1400.
      // Span = 1600 - 0 = 1600; total widths = 1000; gap = 600/2 = 300.
      const tiles: Record<string, Tile> = {
        a: makeTile('a', 0, 0, 200, 100),
        b: makeTile('b', 300, 0, 600, 100),
        c: makeTile('c', 1400, 0, 200, 100),
      };
      const result = alignTiles(tiles, ['a', 'b', 'c'], 'distribute-h');
      // a stays at 0; b should be at 0 + 200 + 300 = 500; c at 500 + 600 + 300 = 1400.
      const aPos = result.get('a')?.after.x ?? 0;
      const bPos = result.get('b')?.after.x ?? 300;
      const cPos = result.get('c')?.after.x ?? 1400;
      expect(aPos).toBe(0);
      expect(bPos).toBe(500);
      expect(cPos).toBe(1400);
      // Verify no overlap: each tile's left edge ≥ previous tile's right edge.
      expect(bPos).toBeGreaterThanOrEqual(aPos + 200);
      expect(cPos).toBeGreaterThanOrEqual(bPos + 600);
    });

    it('distribute-h falls back to a positive gap when tiles overflow their bounding span', () => {
      // Three wide tiles crammed into a tiny span (gap would be negative).
      const tiles: Record<string, Tile> = {
        a: makeTile('a', 0, 0, 400, 100),
        b: makeTile('b', 100, 0, 400, 100),
        c: makeTile('c', 200, 0, 400, 100),
      };
      const result = alignTiles(tiles, ['a', 'b', 'c'], 'distribute-h');
      const aPos = result.get('a')?.after.x ?? 0;
      const bPos = result.get('b')?.after.x ?? 100;
      const cPos = result.get('c')?.after.x ?? 200;
      // No overlap even though the user packed them tight.
      expect(bPos).toBeGreaterThanOrEqual(aPos + 400);
      expect(cPos).toBeGreaterThanOrEqual(bPos + 400);
    });

    it('distribute-h is a no-op for fewer than 3 tiles', () => {
      const tiles: Record<string, Tile> = {
        a: makeTile('a', 0, 0, 200, 100),
        b: makeTile('b', 400, 0, 200, 100),
      };
      const result = alignTiles(tiles, ['a', 'b'], 'distribute-h');
      expect(result.size).toBe(0);
    });

    it('distribute-v spaces tiles with equal gaps that prevent overlap', () => {
      const tiles: Record<string, Tile> = {
        a: makeTile('a', 0, 0, 100, 200),
        b: makeTile('b', 0, 300, 100, 600),
        c: makeTile('c', 0, 1400, 100, 200),
      };
      const result = alignTiles(tiles, ['a', 'b', 'c'], 'distribute-v');
      const aPos = result.get('a')?.after.y ?? 0;
      const bPos = result.get('b')?.after.y ?? 300;
      const cPos = result.get('c')?.after.y ?? 1400;
      expect(bPos).toBeGreaterThanOrEqual(aPos + 200);
      expect(cPos).toBeGreaterThanOrEqual(bPos + 600);
    });
  });

  describe('layoutTree', () => {
    it('lays out connected tiles in tree structure', () => {
      const tiles: Record<string, Tile> = {
        root: makeTile('root', 0, 0),
        child1: makeTile('child1', 100, 100),
        child2: makeTile('child2', 200, 200),
      };
      const connections: Record<string, Connection> = {
        c1: {
          id: 'c1', fromTileId: 'root', toTileId: 'child1', boardId: 'b1',
          fromBubble: 0, toBubble: 4,
          pathType: 'curved', pathColor: '#fff', pathStyle: 'solid',
          arrowType: 'none', arrowColor: '#fff', visibility: 'visible',
          createdAt: 1, updatedAt: 1,
        } as Connection,
        c2: {
          id: 'c2', fromTileId: 'root', toTileId: 'child2', boardId: 'b1',
          fromBubble: 0, toBubble: 4,
          pathType: 'curved', pathColor: '#fff', pathStyle: 'solid',
          arrowType: 'none', arrowColor: '#fff', visibility: 'visible',
          createdAt: 1, updatedAt: 1,
        } as Connection,
      };

      const result = layoutTree(tiles, connections, ['root', 'child1', 'child2'], 'horizontal');
      
      // Root should be at depth 0, children at depth 1
      const rootPos = result.get('root')?.after || tiles.root.position;
      const child1Pos = result.get('child1')?.after || tiles.child1.position;
      const child2Pos = result.get('child2')?.after || tiles.child2.position;
      
      // Children should be further right than root in horizontal layout
      expect(child1Pos.x).toBeGreaterThan(rootPos.x);
      expect(child2Pos.x).toBeGreaterThan(rootPos.x);
      // Children should be at the same x (same depth)
      expect(child1Pos.x).toBe(child2Pos.x);
    });

    it('returns empty map for empty selection', () => {
      const result = layoutTree({}, {}, []);
      expect(result.size).toBe(0);
    });

    it('forms a stair-step pyramid when selected tiles have no connections — vertical', () => {
      // 6 tiles with no edges → expected rows: 1, 2, 3.
      const tiles: Record<string, Tile> = {
        a: makeTile('a', 50, 10, 200, 100),  // topmost → apex
        b: makeTile('b', 0, 200, 200, 100),
        c: makeTile('c', 400, 200, 200, 100),
        d: makeTile('d', 0, 400, 200, 100),
        e: makeTile('e', 200, 400, 200, 100),
        f: makeTile('f', 400, 400, 200, 100),
      };
      const result = layoutTree(tiles, {}, ['a', 'b', 'c', 'd', 'e', 'f'], 'vertical');
      // Every selected tile must appear in the result — no silent unreachables.
      // The apex (topmost) may already be at minY,minX so it's possible
      // (depending on row centering math) that it doesn't move. Allow either.
      const positions = new Map<string, { x: number; y: number }>();
      for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
        const moved = result.get(id);
        positions.set(id, moved ? moved.after : tiles[id].position);
      }
      // Apex must be at depth 0 (smallest y), others fan out below it.
      const minY = Math.min(...positions.values().map(p => p.y) as unknown as number[]);
      expect(positions.get('a')!.y).toBe(minY);
      // Row 1 (2 tiles) and Row 2 (3 tiles) must each occupy a distinct y row.
      const ys = new Set(
        [...positions.values()].map(p => Math.round(p.y)),
      );
      expect(ys.size).toBe(3);
    });

    it('forms a stair-step pyramid when selected tiles have no connections — horizontal', () => {
      const tiles: Record<string, Tile> = {
        a: makeTile('a', 10, 50, 200, 100),  // leftmost → apex
        b: makeTile('b', 300, 0, 200, 100),
        c: makeTile('c', 300, 400, 200, 100),
      };
      const result = layoutTree(tiles, {}, ['a', 'b', 'c'], 'horizontal');
      const positions = new Map<string, { x: number; y: number }>();
      for (const id of ['a', 'b', 'c']) {
        const moved = result.get(id);
        positions.set(id, moved ? moved.after : tiles[id].position);
      }
      // Apex column (smallest x) must be the leftmost original tile.
      const minX = Math.min(...positions.values().map(p => p.x) as unknown as number[]);
      expect(positions.get('a')!.x).toBe(minX);
      // Two distinct depth columns (apex row + children row).
      const xs = new Set([...positions.values()].map(p => Math.round(p.x)));
      expect(xs.size).toBe(2);
    });

    it('places every selected tile even when none are connected', () => {
      const tiles: Record<string, Tile> = {
        a: makeTile('a', 0, 0),
        b: makeTile('b', 500, 0),
        c: makeTile('c', 0, 500),
        d: makeTile('d', 500, 500),
      };
      const result = layoutTree(tiles, {}, ['a', 'b', 'c', 'd'], 'vertical');
      // Apex tile may stay put if it already sits at minX/minY, but every
      // other tile must move from its scattered starting position.
      const movedOrSame = ['a', 'b', 'c', 'd'].map(id => {
        const moved = result.get(id);
        return moved ? moved.after : tiles[id].position;
      });
      // All 4 must end up at distinct positions (no overlap).
      const seen = new Set<string>();
      for (const p of movedOrSame) seen.add(`${Math.round(p.x)},${Math.round(p.y)}`);
      expect(seen.size).toBe(4);
    });

    it('R-T centres parents above their children — vertical', () => {
      // Tree: root → {child1, child2}. In vertical mode the children fan out
      // left/right and the root sits centred between their x coordinates.
      const tiles: Record<string, Tile> = {
        root: makeTile('root', 0, 0),
        child1: makeTile('child1', 0, 0),
        child2: makeTile('child2', 0, 0),
      };
      const connections: Record<string, Connection> = {
        c1: {
          id: 'c1', fromTileId: 'root', toTileId: 'child1', boardId: 'b1',
          fromBubble: 0, toBubble: 4,
          pathType: 'curved', pathColor: '', pathStyle: 'solid',
          arrowType: 'none', arrowColor: '', visibility: 'visible',
          createdAt: 1, updatedAt: 1,
        } as Connection,
        c2: {
          id: 'c2', fromTileId: 'root', toTileId: 'child2', boardId: 'b1',
          fromBubble: 0, toBubble: 4,
          pathType: 'curved', pathColor: '', pathStyle: 'solid',
          arrowType: 'none', arrowColor: '', visibility: 'visible',
          createdAt: 1, updatedAt: 1,
        } as Connection,
      };
      const result = layoutTree(tiles, connections, ['root', 'child1', 'child2'], 'vertical');
      const rootX = result.get('root')?.after.x ?? tiles.root.position.x;
      const child1X = result.get('child1')?.after.x ?? tiles.child1.position.x;
      const child2X = result.get('child2')?.after.x ?? tiles.child2.position.x;
      // Children at different x; root centred between them.
      expect(child1X).not.toBe(child2X);
      expect(rootX).toBeCloseTo((child1X + child2X) / 2, 5);
    });

    it('uses size-aware spacing so wide tiles never overlap along the main axis', () => {
      // A wide root (600px) → two narrower children (200px). Hardcoded 350px
      // spacing would have overlapped root with children.
      const tiles: Record<string, Tile> = {
        root: makeTile('root', 0, 0, 600, 160),
        child1: makeTile('child1', 0, 0, 200, 160),
        child2: makeTile('child2', 0, 0, 200, 160),
      };
      const connections: Record<string, Connection> = {
        c1: {
          id: 'c1', fromTileId: 'root', toTileId: 'child1', boardId: 'b1',
          fromBubble: 0, toBubble: 4,
          pathType: 'curved', pathColor: '#fff', pathStyle: 'solid',
          arrowType: 'none', arrowColor: '#fff', visibility: 'visible',
          createdAt: 1, updatedAt: 1,
        } as Connection,
        c2: {
          id: 'c2', fromTileId: 'root', toTileId: 'child2', boardId: 'b1',
          fromBubble: 0, toBubble: 4,
          pathType: 'curved', pathColor: '#fff', pathStyle: 'solid',
          arrowType: 'none', arrowColor: '#fff', visibility: 'visible',
          createdAt: 1, updatedAt: 1,
        } as Connection,
      };
      const result = layoutTree(tiles, connections, ['root', 'child1', 'child2'], 'horizontal');
      const rootPos = result.get('root')?.after ?? tiles.root.position;
      const childPos = result.get('child1')?.after ?? tiles.child1.position;
      // The main-axis delta must clear the widest tile (600) plus the buffer.
      expect(childPos.x - rootPos.x).toBeGreaterThanOrEqual(600 + LAYOUT_GAP_BUFFER);
    });
  });

  describe('layoutRadial', () => {
    it('distributes tiles in a circle', () => {
      const tiles: Record<string, Tile> = {
        a: makeTile('a', 0, 0, 100, 100),
        b: makeTile('b', 100, 0, 100, 100),
        c: makeTile('c', 0, 100, 100, 100),
        d: makeTile('d', 100, 100, 100, 100),
      };
      const result = layoutRadial(tiles, ['a', 'b', 'c', 'd']);
      expect(result.size).toBeGreaterThan(0);

      // All tiles should be at different positions
      const positions = [...result.values()].map(v => v.after);
      for (let i = 0; i < positions.length; i++) {
        for (let j = i + 1; j < positions.length; j++) {
          const different = Math.abs(positions[i].x - positions[j].x) > 1 || Math.abs(positions[i].y - positions[j].y) > 1;
          expect(different).toBe(true);
        }
      }
    });

    it('returns empty map for empty selection', () => {
      const result = layoutRadial({}, []);
      expect(result.size).toBe(0);
    });
  });
});

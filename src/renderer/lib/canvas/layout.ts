import type { Tile, Connection } from '../../schema/index';
import { LAYOUT_GAP_BUFFER } from '../../constants/defaults';

/**
 * Layout algorithms — pure functions that compute new tile positions.
 * These do NOT mutate state; they return a Map of id → new position.
 * Callers wrap the results in Commands for undo/redo integration.
 */

// ── Alignment ──

export type AlignMode =
  | 'left'
  | 'right'
  | 'top'
  | 'bottom'
  | 'center-h'
  | 'center-v'
  | 'distribute-h'
  | 'distribute-v';

export type PositionMap = Map<
  string,
  { before: { x: number; y: number }; after: { x: number; y: number } }
>;

/**
 * Aligns or distributes tiles along a given axis.
 * Returns a Map from tile ID to { before, after } positions.
 */
export function alignTiles(
  tiles: Record<string, Tile>,
  selectedIds: string[],
  mode: AlignMode,
): PositionMap {
  const result: PositionMap = new Map();
  if (selectedIds.length < 2) return result;

  const selected = selectedIds.map(id => tiles[id]).filter(Boolean);
  if (selected.length < 2) return result;

  let target: number;

  switch (mode) {
    case 'left':
      target = Math.min(...selected.map(t => t.position.x));
      for (const t of selected) {
        if (t.position.x !== target) {
          result.set(t.id, {
            before: { x: t.position.x, y: t.position.y },
            after: { x: target, y: t.position.y },
          });
        }
      }
      break;

    case 'right':
      target = Math.max(...selected.map(t => t.position.x + t.size.width));
      for (const t of selected) {
        const newX = target - t.size.width;
        if (t.position.x !== newX) {
          result.set(t.id, {
            before: { x: t.position.x, y: t.position.y },
            after: { x: newX, y: t.position.y },
          });
        }
      }
      break;

    case 'top':
      target = Math.min(...selected.map(t => t.position.y));
      for (const t of selected) {
        if (t.position.y !== target) {
          result.set(t.id, {
            before: { x: t.position.x, y: t.position.y },
            after: { x: t.position.x, y: target },
          });
        }
      }
      break;

    case 'bottom':
      target = Math.max(...selected.map(t => t.position.y + t.size.height));
      for (const t of selected) {
        const newY = target - t.size.height;
        if (t.position.y !== newY) {
          result.set(t.id, {
            before: { x: t.position.x, y: t.position.y },
            after: { x: t.position.x, y: newY },
          });
        }
      }
      break;

    case 'center-h': {
      const avgX = selected.reduce((sum, t) => sum + t.position.x + t.size.width / 2, 0) / selected.length;
      for (const t of selected) {
        const newX = avgX - t.size.width / 2;
        if (Math.abs(t.position.x - newX) > 0.5) {
          result.set(t.id, {
            before: { x: t.position.x, y: t.position.y },
            after: { x: newX, y: t.position.y },
          });
        }
      }
      break;
    }

    case 'center-v': {
      const avgY = selected.reduce((sum, t) => sum + t.position.y + t.size.height / 2, 0) / selected.length;
      for (const t of selected) {
        const newY = avgY - t.size.height / 2;
        if (Math.abs(t.position.y - newY) > 0.5) {
          result.set(t.id, {
            before: { x: t.position.x, y: t.position.y },
            after: { x: t.position.x, y: newY },
          });
        }
      }
      break;
    }

    case 'distribute-h': {
      // Need at least 3 tiles — with 2 the operation is a no-op (= alignment).
      if (selected.length < 3) break;
      const sorted = [...selected].sort((a, b) => a.position.x - b.position.x);
      const leftmost = sorted[0];
      const rightmost = sorted[sorted.length - 1];
      const span = (rightmost.position.x + rightmost.size.width) - leftmost.position.x;
      const totalWidth = sorted.reduce((sum, t) => sum + t.size.width, 0);
      let gap = (span - totalWidth) / (sorted.length - 1);
      // If the bounding span is too small to fit all tiles, expand it with a positive buffer
      // so no two tiles overlap.
      if (gap < 0) gap = LAYOUT_GAP_BUFFER;
      let cursor = leftmost.position.x;
      for (const t of sorted) {
        const newX = cursor;
        if (Math.abs(t.position.x - newX) > 0.5) {
          result.set(t.id, {
            before: { x: t.position.x, y: t.position.y },
            after: { x: newX, y: t.position.y },
          });
        }
        cursor += t.size.width + gap;
      }
      break;
    }

    case 'distribute-v': {
      if (selected.length < 3) break;
      const sorted = [...selected].sort((a, b) => a.position.y - b.position.y);
      const topmost = sorted[0];
      const bottommost = sorted[sorted.length - 1];
      const span = (bottommost.position.y + bottommost.size.height) - topmost.position.y;
      const totalHeight = sorted.reduce((sum, t) => sum + t.size.height, 0);
      let gap = (span - totalHeight) / (sorted.length - 1);
      if (gap < 0) gap = LAYOUT_GAP_BUFFER;
      let cursor = topmost.position.y;
      for (const t of sorted) {
        const newY = cursor;
        if (Math.abs(t.position.y - newY) > 0.5) {
          result.set(t.id, {
            before: { x: t.position.x, y: t.position.y },
            after: { x: t.position.x, y: newY },
          });
        }
        cursor += t.size.height + gap;
      }
      break;
    }
  }

  return result;
}

// ── Tree Layout ──

/**
 * Lays out tiles in a pyramid-shaped tree.
 *
 * Two modes:
 *   • Connection-driven (Reingold–Tilford). When at least one connection
 *     exists between selected tiles, the directional graph
 *     `from → to` is treated as a parent → child tree. Every parent is
 *     centred above (or to the left of, in horizontal mode) its children,
 *     and sibling subtrees never overlap.
 *   • Position-inferred stair-step pyramid. When no edges connect the
 *     selection, the topmost (or leftmost in horizontal mode) tile becomes
 *     the apex and the rest fan out across rows of increasing width
 *     (1, 2, 3, 4, …) so the result reads as a recognisable triangle for
 *     any tile count. Within each row, tiles are placed left-to-right by
 *     their original cross-axis position to preserve the user's spatial
 *     hint.
 *
 * Spacing is derived from the largest tile in the selection so no two
 * adjacent tiles overlap regardless of their dimensions. Every selected
 * tile is included in the result — there is no silent "unreachable"
 * fallback.
 */
export function layoutTree(
  tiles: Record<string, Tile>,
  connections: Record<string, Connection>,
  selectedIds: string[],
  direction: 'horizontal' | 'vertical' = 'horizontal',
): PositionMap {
  const result: PositionMap = new Map();
  if (selectedIds.length === 0) return result;

  const selectedSet = new Set(selectedIds);
  const selectedTiles = selectedIds.map(id => tiles[id]).filter(Boolean);
  if (selectedTiles.length === 0) return result;

  // Size-aware spacing: each step along the main axis must clear the widest
  // (or tallest) tile, and each step along the cross axis must clear the
  // tallest (or widest) tile.
  const maxMainSize = Math.max(
    ...selectedTiles.map(t => (direction === 'horizontal' ? t.size.width : t.size.height)),
  );
  const maxCrossSize = Math.max(
    ...selectedTiles.map(t => (direction === 'horizontal' ? t.size.height : t.size.width)),
  );
  const GAP_MAIN = maxMainSize + LAYOUT_GAP_BUFFER;
  const GAP_CROSS = maxCrossSize + LAYOUT_GAP_BUFFER;

  // Origin = top-left of all selected tiles. Apex of the tree sits here.
  let minX = Infinity, minY = Infinity;
  for (const id of selectedIds) {
    const t = tiles[id];
    if (t) {
      minX = Math.min(minX, t.position.x);
      minY = Math.min(minY, t.position.y);
    }
  }

  // Build adjacency lists from connections that stay within the selection.
  const children: Record<string, string[]> = {};
  const parents: Record<string, string[]> = {};
  let hasInternalEdge = false;
  for (const conn of Object.values(connections)) {
    const from = conn.fromTileId;
    const to = conn.toTileId;
    if (selectedSet.has(from) && selectedSet.has(to)) {
      hasInternalEdge = true;
      if (!children[from]) children[from] = [];
      children[from].push(to);
      if (!parents[to]) parents[to] = [];
      parents[to].push(from);
    }
  }

  /** Final assignments — depth (row index) and cross-axis pixel offset. */
  const positions: Record<string, { depth: number; cross: number }> = {};

  if (hasInternalEdge) {
    // ── Mode A: Reingold–Tilford on the connection graph. ──

    const roots = selectedIds.filter(id => {
      const p = parents[id] ?? [];
      return !p.some(pid => selectedSet.has(pid));
    });
    if (roots.length === 0) roots.push(selectedIds[0]);

    /**
     * Subtree width (in `GAP_CROSS` units): the cross-axis span the subtree
     * rooted at `nodeId` needs to lay out without overlap. A leaf is 1.
     * `visited` guards against cycles (connections form a DAG in practice
     * but defensive coding here keeps us out of an infinite loop).
     */
    const widthCache = new Map<string, number>();
    function subtreeWidth(nodeId: string, visited: Set<string>): number {
      if (widthCache.has(nodeId)) return widthCache.get(nodeId)!;
      if (visited.has(nodeId)) return 1;
      visited.add(nodeId);
      const kids = (children[nodeId] ?? []).filter(id => selectedSet.has(id) && !visited.has(id));
      let w = 0;
      for (const k of kids) w += subtreeWidth(k, visited);
      const total = Math.max(1, w);
      widthCache.set(nodeId, total);
      return total;
    }

    const visited = new Set<string>();
    let currentCross = 0;

    function layoutNode(nodeId: string, depth: number, sliceStart: number, sliceWidth: number) {
      if (visited.has(nodeId)) return;
      visited.add(nodeId);
      const kids = (children[nodeId] ?? []).filter(id => selectedSet.has(id) && !visited.has(id));
      if (kids.length === 0) {
        positions[nodeId] = { depth, cross: (sliceStart + sliceWidth / 2) * GAP_CROSS };
        return;
      }
      let childStart = sliceStart;
      const childCrosses: number[] = [];
      for (const k of kids) {
        const w = subtreeWidth(k, new Set());
        layoutNode(k, depth + 1, childStart, w);
        const placed = positions[k];
        if (placed) childCrosses.push(placed.cross);
        childStart += w;
      }
      // Parent centred over its children — the defining R-T property.
      const parentCross = childCrosses.length > 0
        ? childCrosses.reduce((s, c) => s + c, 0) / childCrosses.length
        : (sliceStart + sliceWidth / 2) * GAP_CROSS;
      positions[nodeId] = { depth, cross: parentCross };
    }

    for (const root of roots) {
      const w = subtreeWidth(root, new Set());
      layoutNode(root, 0, currentCross, w);
      currentCross += w;
    }

    // Any tile not reachable from a root (orphans that connect only to each
    // other but no root was identified, or selected isolates) falls back to
    // pyramid placement after the connected portion so the user still sees
    // every selected tile move.
    const unplaced = selectedIds.filter(id => !(id in positions));
    if (unplaced.length > 0) {
      const startCross = currentCross + 1;
      assignPyramidPositions(unplaced, tiles, direction, positions, startCross);
    }
  } else {
    // ── Mode B: position-inferred stair-step pyramid. ──
    assignPyramidPositions(selectedIds, tiles, direction, positions, 0);
  }

  // Convert computed (depth, cross) pairs into pixel coordinates.
  for (const [id, pos] of Object.entries(positions)) {
    const t = tiles[id];
    if (!t) continue;
    const newX = direction === 'horizontal'
      ? minX + pos.depth * GAP_MAIN
      : minX + pos.cross;
    const newY = direction === 'horizontal'
      ? minY + pos.cross
      : minY + pos.depth * GAP_MAIN;
    if (Math.abs(t.position.x - newX) > 0.5 || Math.abs(t.position.y - newY) > 0.5) {
      result.set(id, {
        before: { x: t.position.x, y: t.position.y },
        after: { x: newX, y: newY },
      });
    }
  }
  return result;

  /**
   * Stair-step pyramid layout for a set of tile ids with no inherent
   * hierarchy. Picks an apex by main-axis position, then fills rows of
   * width 1, 2, 3, 4, … from top to bottom. Within a row, tiles are
   * placed left-to-right by their original cross-axis position so the
   * result honours the user's spatial intent.
   *
   * Each row's cross-axis span is centred on `crossOrigin * GAP_CROSS`
   * (so multiple pyramids dropped side-by-side don't overlap).
   */
  function assignPyramidPositions(
    ids: string[],
    tilesMap: Record<string, Tile>,
    dir: 'horizontal' | 'vertical',
    out: Record<string, { depth: number; cross: number }>,
    crossOrigin: number,
  ): void {
    const present = ids.map(id => tilesMap[id]).filter(Boolean);
    if (present.length === 0) return;

    // Apex: topmost (vertical) or leftmost (horizontal). Ties broken by the
    // other axis so the choice is deterministic.
    const sortedForApex = [...present].sort((a, b) => {
      if (dir === 'vertical') {
        if (a.position.y !== b.position.y) return a.position.y - b.position.y;
        return a.position.x - b.position.x;
      }
      if (a.position.x !== b.position.x) return a.position.x - b.position.x;
      return a.position.y - b.position.y;
    });
    const apex = sortedForApex[0];
    const rest = sortedForApex.slice(1);

    // Distribute `rest` into rows of width 2, 3, 4, …. apex occupies row 0.
    const rows: Tile[][] = [[apex]];
    let rowIdx = 1;
    let cursor = 0;
    while (cursor < rest.length) {
      const capacity = rowIdx + 1;
      const slice = rest.slice(cursor, cursor + capacity);
      rows.push(slice);
      cursor += capacity;
      rowIdx += 1;
    }

    // Within each row, sort by cross-axis position so the user's left/right
    // ordering is preserved when possible.
    for (let r = 1; r < rows.length; r++) {
      rows[r].sort((a, b) => {
        if (dir === 'vertical') return a.position.x - b.position.x;
        return a.position.y - b.position.y;
      });
    }

    // crossOrigin is the *cross-axis cell* the apex sits in. Children rows
    // are centred symmetrically around it.
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      const m = row.length;
      // Cross-axis cells used by this row, centred on crossOrigin.
      const offsetStart = -(m - 1) / 2;
      for (let i = 0; i < m; i++) {
        const tile = row[i];
        out[tile.id] = {
          depth: r,
          cross: (crossOrigin + offsetStart + i) * GAP_CROSS,
        };
      }
    }
  }
}

// ── Radial Layout ──

/**
 * Lays out tiles in a circle around the centroid of the selection.
 * Radius scales with the largest tile and the number of tiles, so the arc
 * length between adjacent tiles always exceeds their diagonal plus a buffer.
 */
export function layoutRadial(
  tiles: Record<string, Tile>,
  selectedIds: string[],
): PositionMap {
  const result: PositionMap = new Map();
  if (selectedIds.length === 0) return result;

  const selected = selectedIds.map(id => tiles[id]).filter(Boolean);
  if (selected.length === 0) return result;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const t of selected) {
    minX = Math.min(minX, t.position.x);
    minY = Math.min(minY, t.position.y);
    maxX = Math.max(maxX, t.position.x + t.size.width);
    maxY = Math.max(maxY, t.position.y + t.size.height);
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  const maxTileDiag = Math.max(
    ...selected.map(t => Math.hypot(t.size.width, t.size.height)),
  );
  const circumferenceNeeded = selected.length * (maxTileDiag + LAYOUT_GAP_BUFFER);
  const radius = Math.max(maxTileDiag + LAYOUT_GAP_BUFFER, circumferenceNeeded / (2 * Math.PI));
  const step = (2 * Math.PI) / selected.length;

  for (let i = 0; i < selected.length; i++) {
    const t = selected[i];
    const angle = i * step - Math.PI / 2; // Start from top.
    const newX = cx + radius * Math.cos(angle) - t.size.width / 2;
    const newY = cy + radius * Math.sin(angle) - t.size.height / 2;

    if (Math.abs(t.position.x - newX) > 0.5 || Math.abs(t.position.y - newY) > 0.5) {
      result.set(t.id, {
        before: { x: t.position.x, y: t.position.y },
        after: { x: newX, y: newY },
      });
    }
  }

  return result;
}

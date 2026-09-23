/**
 * SVG path computation for 4 connection path types:
 * curved, straight, elbow, smart.
 */

import { getBubbleNormal } from './bubblePositions';
import type { SpatialIndex } from '../spatialIndex';

export interface PathPoint {
  x: number;
  y: number;
}

/**
 * Computes the SVG path `d` attribute for a connection.
 */
export function computePath(
  from: PathPoint,
  to: PathPoint,
  fromBubble: number,
  toBubble: number,
  pathType: 'curved' | 'straight' | 'elbow' | 'smart',
  spatialIndex?: SpatialIndex,
): string {
  switch (pathType) {
    case 'straight':
      return computeStraightPath(from, to);
    case 'curved':
      return computeCurvedPath(from, to, fromBubble, toBubble);
    case 'elbow':
      return computeElbowPath(from, to, fromBubble, toBubble);
    case 'smart':
      return computeSmartPath(from, to, fromBubble, toBubble, spatialIndex);
    default:
      return computeCurvedPath(from, to, fromBubble, toBubble);
  }
}

/**
 * Straight line between two points.
 */
function computeStraightPath(from: PathPoint, to: PathPoint): string {
  return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
}

/**
 * Cubic bezier curve using bubble normals for control points.
 */
function computeCurvedPath(
  from: PathPoint,
  to: PathPoint,
  fromBubble: number,
  toBubble: number,
): string {
  const dist = Math.sqrt((to.x - from.x) ** 2 + (to.y - from.y) ** 2);
  const tension = Math.min(dist * 0.4, 150);

  const fromNormal = getBubbleNormal(fromBubble);
  const toNormal = getBubbleNormal(toBubble);

  const cp1x = from.x + fromNormal.nx * tension;
  const cp1y = from.y + fromNormal.ny * tension;
  const cp2x = to.x + toNormal.nx * tension;
  const cp2y = to.y + toNormal.ny * tension;

  return `M ${from.x} ${from.y} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${to.x} ${to.y}`;
}

/**
 * Elbow path — right-angle segments from source to target.
 */
function computeElbowPath(
  from: PathPoint,
  to: PathPoint,
  fromBubble: number,
  toBubble: number,
): string {
  const fromNormal = getBubbleNormal(fromBubble);
  const toNormal = getBubbleNormal(toBubble);
  const offset = 30;

  // Exit point from source bubble
  const exitX = from.x + fromNormal.nx * offset;
  const exitY = from.y + fromNormal.ny * offset;

  // Entry point to target bubble
  const entryX = to.x + toNormal.nx * offset;
  const entryY = to.y + toNormal.ny * offset;

  // Determine if from/to normals are primarily horizontal or vertical
  const fromHorizontal = Math.abs(fromNormal.nx) > Math.abs(fromNormal.ny);
  const toHorizontal = Math.abs(toNormal.nx) > Math.abs(toNormal.ny);

  if (fromHorizontal && toHorizontal) {
    // Both horizontal: midpoint X
    const midX = (exitX + entryX) / 2;
    return `M ${from.x} ${from.y} L ${exitX} ${exitY} L ${midX} ${exitY} L ${midX} ${entryY} L ${entryX} ${entryY} L ${to.x} ${to.y}`;
  } else if (!fromHorizontal && !toHorizontal) {
    // Both vertical: midpoint Y
    const midY = (exitY + entryY) / 2;
    return `M ${from.x} ${from.y} L ${exitX} ${exitY} L ${exitX} ${midY} L ${entryX} ${midY} L ${entryX} ${entryY} L ${to.x} ${to.y}`;
  } else {
    // Mixed: L-shaped connection
    if (fromHorizontal) {
      return `M ${from.x} ${from.y} L ${exitX} ${exitY} L ${exitX} ${entryY} L ${entryX} ${entryY} L ${to.x} ${to.y}`;
    } else {
      return `M ${from.x} ${from.y} L ${exitX} ${exitY} L ${entryX} ${exitY} L ${entryX} ${entryY} L ${to.x} ${to.y}`;
    }
  }
}

/**
 * Smart path — routes around obstacles using A* on a Hanan grid.
 * The Hanan grid is built from obstacle bounding box edges + padding,
 * ensuring paths always travel along obstacle boundaries.
 * Falls back to curved if no spatial index or no nearby obstacles.
 */
function computeSmartPath(
  from: PathPoint,
  to: PathPoint,
  fromBubble: number,
  toBubble: number,
  spatialIndex?: SpatialIndex,
): string {
  if (!spatialIndex) {
    return computeCurvedPath(from, to, fromBubble, toBubble);
  }

  const PADDING = 25;
  const MARGIN = 150;
  const MAX_ITER = 500;

  // Obstacles near the path region. H4 (perf): an R-tree range query bounded
  // to the region instead of `all().filter(...)` over every tile on the board
  // — the smart route only ever recomputes when a connection endpoint moves
  // (see ConnectionLayer's path memo), and this keeps that recompute O(tiles
  // in region) rather than O(tiles in board).
  const regionMinX = Math.min(from.x, to.x) - MARGIN;
  const regionMinY = Math.min(from.y, to.y) - MARGIN;
  const regionMaxX = Math.max(from.x, to.x) + MARGIN;
  const regionMaxY = Math.max(from.y, to.y) + MARGIN;

  const obstacles = spatialIndex.searchRegion(regionMinX, regionMinY, regionMaxX, regionMaxY);

  if (obstacles.length === 0) {
    return computeCurvedPath(from, to, fromBubble, toBubble);
  }

  // Build Hanan grid: unique X and Y coordinates from obstacle edges + start/end
  const xSet = new Set<number>([from.x, to.x]);
  const ySet = new Set<number>([from.y, to.y]);

  for (const o of obstacles) {
    xSet.add(o.minX - PADDING);
    xSet.add(o.maxX + PADDING);
    ySet.add(o.minY - PADDING);
    ySet.add(o.maxY + PADDING);
  }

  const X = Array.from(xSet).sort((a, b) => a - b);
  const Y = Array.from(ySet).sort((a, b) => a - b);

  const startXi = X.indexOf(from.x);
  const startYi = Y.indexOf(from.y);
  const endXi = X.indexOf(to.x);
  const endYi = Y.indexOf(to.y);

  if (startXi === -1 || startYi === -1 || endXi === -1 || endYi === -1) {
    return computeCurvedPath(from, to, fromBubble, toBubble);
  }

  // Returns true if the axis-aligned segment (x1,y1)→(x2,y2) passes through an obstacle
  function segmentIntersects(x1: number, y1: number, x2: number, y2: number): boolean {
    const buf = 0.1;
    const sMinX = Math.min(x1, x2);
    const sMaxX = Math.max(x1, x2);
    const sMinY = Math.min(y1, y2);
    const sMaxY = Math.max(y1, y2);
    for (const o of obstacles) {
      if (sMaxX > o.minX + buf && sMinX < o.maxX - buf &&
          sMaxY > o.minY + buf && sMinY < o.maxY - buf) {
        return true;
      }
    }
    return false;
  }

  interface ANode {
    x: number; y: number;
    xi: number; yi: number;
    g: number; h: number; f: number;
    parent: ANode | null;
  }

  const startNode: ANode = {
    x: from.x, y: from.y, xi: startXi, yi: startYi,
    g: 0,
    h: Math.abs(from.x - to.x) + Math.abs(from.y - to.y),
    f: Math.abs(from.x - to.x) + Math.abs(from.y - to.y),
    parent: null,
  };

  const openList: ANode[] = [startNode];
  const closedSet = new Set<string>();
  const gScore = new Map<string, number>([
    [`${startXi},${startYi}`, 0],
  ]);

  const dirs = [
    { dxi: 0, dyi: -1 },
    { dxi: 0, dyi: 1 },
    { dxi: -1, dyi: 0 },
    { dxi: 1, dyi: 0 },
  ];

  let found: ANode | null = null;
  let iter = 0;

  while (openList.length > 0 && iter++ < MAX_ITER) {
    // Pop lowest-f node
    let lowestIdx = 0;
    for (let i = 1; i < openList.length; i++) {
      // i and lowestIdx are both valid indices into openList
      if (openList[i]!.f < openList[lowestIdx]!.f) lowestIdx = i;
    }
    const current = openList.splice(lowestIdx, 1)[0];
    if (!current) break; // openList is non-empty (while guard) → splice yields one node
    const key = `${current.xi},${current.yi}`;

    if (current.xi === endXi && current.yi === endYi) {
      found = current;
      break;
    }

    closedSet.add(key);

    for (const { dxi, dyi } of dirs) {
      const nxi = current.xi + dxi;
      const nyi = current.yi + dyi;
      if (nxi < 0 || nxi >= X.length || nyi < 0 || nyi >= Y.length) continue;

      const nKey = `${nxi},${nyi}`;
      if (closedSet.has(nKey)) continue;

      const nx = X[nxi];
      const ny = Y[nyi];
      if (nx === undefined || ny === undefined) continue; // bounds checked above

      if (segmentIntersects(current.x, current.y, nx, ny)) continue;

      const g = current.g + Math.abs(nx - current.x) + Math.abs(ny - current.y);
      const prev = gScore.get(nKey);
      if (prev !== undefined && g >= prev) continue;

      gScore.set(nKey, g);
      const h = Math.abs(nx - to.x) + Math.abs(ny - to.y);
      const neighbor: ANode = { x: nx, y: ny, xi: nxi, yi: nyi, g, h, f: g + h, parent: current };

      const existingIdx = openList.findIndex((n) => n.xi === nxi && n.yi === nyi);
      if (existingIdx >= 0) {
        openList[existingIdx] = neighbor;
      } else {
        openList.push(neighbor);
      }
    }
  }

  if (!found) {
    return computeCurvedPath(from, to, fromBubble, toBubble);
  }

  // Reconstruct and simplify the path
  const raw: PathPoint[] = [];
  let node: ANode | null = found;
  while (node) {
    raw.unshift({ x: node.x, y: node.y });
    node = node.parent;
  }

  const simplified = simplifyPolyline(raw);
  const first = simplified[0];
  if (!first) return computeCurvedPath(from, to, fromBubble, toBubble);
  let d = `M ${first.x} ${first.y}`;
  for (let i = 1; i < simplified.length; i++) {
    const pt = simplified[i];
    if (pt) d += ` L ${pt.x} ${pt.y}`;
  }
  return d;
}

/**
 * Removes collinear intermediate points from a polyline.
 */
function simplifyPolyline(points: PathPoint[]): PathPoint[] {
  if (points.length <= 2) return points;
  const first = points[0];
  if (!first) return points; // length > 2 guaranteed above
  const result: PathPoint[] = [first];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = result[result.length - 1];
    const curr = points[i];
    const next = points[i + 1];
    if (!prev || !curr || !next) continue; // loop bound guarantees curr/next; result is non-empty
    // Cross product: non-zero means direction changes (keep the point)
    const cross = (curr.x - prev.x) * (next.y - curr.y) - (curr.y - prev.y) * (next.x - curr.x);
    if (cross !== 0) result.push(curr);
  }
  const last = points[points.length - 1];
  if (last) result.push(last);
  return result;
}

/**
 * Finds the normalized parametric position (0–1) on a polyline
 * closest to the target point. Uses segment projection for sub-sample precision
 * rather than snapping to the nearest discrete sample.
 */
export function getClosestTOnPolyline(points: PathPoint[], target: PathPoint): number {
  if (points.length < 2) return 0;

  const segLengths: number[] = [];
  let totalLength = 0;
  for (let i = 0; i < points.length - 1; i++) {
    // i and i+1 are both in range (loop bound i < length - 1)
    const a = points[i]!;
    const b = points[i + 1]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    segLengths.push(len);
    totalLength += len;
  }

  if (totalLength === 0) return 0;

  let bestT = 0;
  let bestDist = Infinity;
  let cumLen = 0;

  for (let i = 0; i < points.length - 1; i++) {
    // i and i+1 are both in range (loop bound i < length - 1)
    const a = points[i]!;
    const b = points[i + 1]!;
    const ax = a.x, ay = a.y;
    const dx = b.x - ax;
    const dy = b.y - ay;
    const segLen = segLengths[i] ?? 0; // one entry pushed per segment i above

    if (segLen > 0) {
      // Project target onto segment, clamped to [0, 1]
      const t = Math.max(0, Math.min(1, ((target.x - ax) * dx + (target.y - ay) * dy) / (segLen * segLen)));
      const px = ax + t * dx;
      const py = ay + t * dy;
      const dist = (target.x - px) ** 2 + (target.y - py) ** 2;
      if (dist < bestDist) {
        bestDist = dist;
        bestT = (cumLen + t * segLen) / totalLength;
      }
    }

    cumLen += segLen;
  }

  return Math.max(0, Math.min(1, bestT));
}

/**
 * Gets a point at a parametric position along an SVG path element.
 * Returns (x, y) at position t ∈ [0, 1].
 */
export function getPointOnPath(
  pathElement: SVGPathElement,
  t: number,
): PathPoint {
  const length = pathElement.getTotalLength();
  const point = pathElement.getPointAtLength(t * length);
  return { x: point.x, y: point.y };
}

/**
 * Gets the angle (in degrees) of the path tangent at parametric position t.
 */
export function getAngleOnPath(
  pathElement: SVGPathElement,
  t: number,
): number {
  const length = pathElement.getTotalLength();
  if (length === 0) return 0;

  const epsilon = Math.max(0.1, Math.min(1, length * 0.001));
  const pos = t * length;

  const p1 = pathElement.getPointAtLength(Math.max(0, pos - epsilon));
  const p2 = pathElement.getPointAtLength(Math.min(length, pos + epsilon));

  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return 0;

  return Math.atan2(dy, dx) * (180 / Math.PI);
}

/**
 * Computes arrow points for an arrowhead at a given point and angle.
 * Returns a closed path (`… Z`) suitable for filled rendering — when
 * filled the tip is a sharp pointed vertex, whereas a stroked V-arrow
 * with `stroke-linejoin: round` adds a bevel that visibly protrudes
 * past the geometric tip and clips into the target tile on side bubbles.
 */
export function computeArrowHead(
  tip: PathPoint,
  angleDeg: number,
  size: number = 10,
): string {
  const angleRad = (angleDeg * Math.PI) / 180;
  const backAngle = Math.PI / 6; // 30 degree spread

  const x1 = tip.x - size * Math.cos(angleRad - backAngle);
  const y1 = tip.y - size * Math.sin(angleRad - backAngle);
  const x2 = tip.x - size * Math.cos(angleRad + backAngle);
  const y2 = tip.y - size * Math.sin(angleRad + backAngle);

  return `M ${x1} ${y1} L ${tip.x} ${tip.y} L ${x2} ${y2} Z`;
}

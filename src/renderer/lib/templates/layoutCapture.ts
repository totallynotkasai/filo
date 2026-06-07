import type {
  Tile,
  TileStyle,
  Connection,
  ConnectionLabel,
  LayoutTemplate,
  LayoutTemplateTile,
  LayoutTemplateConnection,
} from '../../schema/index';
import type { TileType } from '../../../shared/types';
import { createId } from '../utils/ids';

/**
 * Layout Templates capture the *structure* of a tile selection — type, size,
 * relative position, and full style — and deliberately strip everything that
 * counts as content: titles, body content, tags, lock state, file references
 * (src / filePath / url), backing-file content, and runtime state.
 *
 * The captured `relativePosition` is measured from the bounding-box top-left
 * of the selection, so an instantiation can drop the whole layout at any
 * canvas point without distortion.
 *
 * **Content groups.** When two captured text tiles referenced the same
 * backing `.md` file (same `contentId`), they are tagged with the same
 * anonymous `contentGroup` key. On instantiation each unique group is
 * assigned exactly one fresh `contentId` and one shared title, so the
 * resulting tiles back to a single new `.md` file — preserving the
 * many-tiles-to-one-file relationship the user authored. Tiles in distinct
 * groups each get their own file. Untagged text tiles (e.g. from older
 * templates without `contentGroup`) are treated as singletons.
 *
 * Inserting a template re-creates each tile through the normal `createTile`
 * factory, which provides fresh ids. Title and `contentId` are computed
 * here and passed as overrides so the per-group sharing is honoured and
 * titles are unique enough to drive distinct filename creation in
 * `boardCache.persistAddTile`.
 */

interface NormalizedSelection {
  tiles: Tile[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function normalizeSelection(tiles: Tile[]): NormalizedSelection | null {
  if (tiles.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const t of tiles) {
    if (t.position.x < minX) minX = t.position.x;
    if (t.position.y < minY) minY = t.position.y;
    const right = t.position.x + t.size.width;
    const bottom = t.position.y + t.size.height;
    if (right > maxX) maxX = right;
    if (bottom > maxY) maxY = bottom;
  }
  return { tiles, minX, minY, maxX, maxY };
}

/**
 * Returns the per-type config captured from a tile. Only Timer carries
 * non-content type-specific properties today; everything else (src, url,
 * filePath, contentId, content) is treated as content and excluded.
 */
function captureTypeConfig(tile: Tile): Record<string, unknown> | undefined {
  if (tile.type === 'timer') {
    return {
      duration: tile.duration,
      mode: tile.mode,
    };
  }
  return undefined;
}

export interface CaptureOptions {
  /**
   * Whether to capture connections between selected tiles. When `false` (or
   * when no edges exist between selected tiles) the resulting template has
   * no `connections` field and instantiation creates tiles only — matching
   * the pre-feature behaviour. Connections that cross the selection
   * boundary (one endpoint outside the selection) are always dropped.
   */
  includeConnections: boolean;
}

const DEFAULT_CAPTURE_OPTIONS: CaptureOptions = { includeConnections: true };

export function captureLayoutTemplate(
  tiles: Tile[],
  connections: Connection[],
  name: string,
  options: CaptureOptions = DEFAULT_CAPTURE_OPTIONS,
): LayoutTemplate {
  const norm = normalizeSelection(tiles);
  if (!norm) {
    throw new Error('Cannot create a Layout Template from an empty selection.');
  }

  // Build a stable mapping from original contentId → anonymous group key.
  // Tiles sharing a contentId become part of the same group on capture, so
  // they re-share a single .md file when the template is instantiated.
  const contentIdToGroup = new Map<string, string>();
  let nextGroupIdx = 0;

  const now = Date.now();
  const layoutTiles: LayoutTemplateTile[] = norm.tiles.map((t) => {
    const captured: LayoutTemplateTile = {
      type: t.type as TileType,
      relativePosition: {
        x: t.position.x - norm.minX,
        y: t.position.y - norm.minY,
      },
      size: { width: t.size.width, height: t.size.height },
      style: { ...(t.style as TileStyle) },
    };
    const config = captureTypeConfig(t);
    if (config) captured.config = config;
    if (t.type === 'text') {
      const cid = (t as Tile & { contentId?: string }).contentId;
      if (cid) {
        let group = contentIdToGroup.get(cid);
        if (!group) {
          group = `g${nextGroupIdx++}`;
          contentIdToGroup.set(cid, group);
        }
        captured.contentGroup = group;
      }
    }
    return captured;
  });

  const result: LayoutTemplate = {
    id: createId(),
    name: name.trim() || 'Untitled Template',
    version: 1,
    createdAt: now,
    updatedAt: now,
    boundingBox: {
      width: Math.max(0, norm.maxX - norm.minX),
      height: Math.max(0, norm.maxY - norm.minY),
    },
    tiles: layoutTiles,
  };

  if (options.includeConnections) {
    const tileIdToIndex = new Map<string, number>();
    norm.tiles.forEach((t, i) => tileIdToIndex.set(t.id, i));
    const captured: LayoutTemplateConnection[] = [];
    for (const c of connections) {
      const fromIdx = tileIdToIndex.get(c.fromTileId);
      const toIdx = tileIdToIndex.get(c.toTileId);
      if (fromIdx === undefined || toIdx === undefined) continue;
      captured.push({
        fromTileIndex: fromIdx,
        toTileIndex: toIdx,
        fromBubble: c.fromBubble,
        toBubble: c.toBubble,
        pathType: c.pathType,
        pathColor: c.pathColor,
        pathSize: c.pathSize,
        pathStyle: c.pathStyle,
        arrowType: c.arrowType,
        arrowColor: c.arrowColor,
        arrowSize: c.arrowSize,
        visibility: c.visibility,
        labelVisibility: c.labelVisibility,
        label: { ...c.label } as ConnectionLabel,
      });
    }
    if (captured.length > 0) result.connections = captured;
  }

  return result;
}

export interface InstantiateContext {
  /**
   * Canvas-space point where the bounding-box top-left of the template
   * should land. Each tile's `position` is computed as
   * `anchor + relativePosition`.
   */
  anchor: { x: number; y: number };
  /** Board the inserted tiles belong to. */
  boardId: string;
  /**
   * Tile factory injected by the caller — typically `createTile` from
   * `stores/tiles.svelte.ts`. Injection keeps this module pure (no Svelte
   * store imports) and makes it trivially testable with a mock factory.
   */
  createTile: (
    type: TileType,
    position: { x: number; y: number },
    boardId: string,
    overrides?: Record<string, unknown>,
  ) => Tile;
  /**
   * Titles already present on the target board. Used to compute fresh
   * `New Tile N` titles without colliding with existing tiles or with
   * other new tiles inserted from the same template. Pass
   * `Object.values(boardStore.tiles).map(t => t.title)`.
   */
  existingTitles: string[];
}

const BASE_TITLE = 'New Tile';

function parseTileNumber(title: string): number | null {
  if (title === BASE_TITLE) return 1;
  const m = title.match(/^New Tile (\d+)$/);
  if (!m) return null;
  const n = parseInt(m[1] ?? '', 10);
  return Number.isFinite(n) ? n : null;
}

function buildTitleAllocator(existingTitles: string[]): () => string {
  let maxN = 0;
  for (const t of existingTitles) {
    const n = parseTileNumber(t);
    if (n !== null && n > maxN) maxN = n;
  }
  return () => {
    maxN += 1;
    return maxN === 1 ? BASE_TITLE : `${BASE_TITLE} ${maxN}`;
  };
}

export interface InstantiateResult {
  tiles: Tile[];
  connections: Connection[];
}

export function instantiateLayoutTemplate(
  template: LayoutTemplate,
  ctx: InstantiateContext,
): InstantiateResult {
  const nextTitle = buildTitleAllocator(ctx.existingTitles);
  // Per-instantiation map: group key → { title, contentId } resolved once
  // and reused for every template tile in that group.
  const groupResolution = new Map<string, { title: string; contentId: string }>();

  const tiles: Tile[] = [];
  for (const t of template.tiles) {
    const overrides: Record<string, unknown> = {
      size: { width: t.size.width, height: t.size.height },
      style: { ...t.style },
      ...(t.config ?? {}),
    };

    let title: string;
    if (t.type === 'text' && t.contentGroup) {
      const existing = groupResolution.get(t.contentGroup);
      if (existing) {
        title = existing.title;
        overrides.contentId = existing.contentId;
      } else {
        title = nextTitle();
        const newContentId = createId();
        groupResolution.set(t.contentGroup, { title, contentId: newContentId });
        overrides.contentId = newContentId;
      }
    } else {
      title = nextTitle();
      if (t.type === 'text') {
        // Untagged text tile (e.g. legacy template) — give it its own fresh
        // contentId so it gets its own .md file.
        overrides.contentId = createId();
      }
    }
    overrides.title = title;

    const tile = ctx.createTile(
      t.type,
      {
        x: ctx.anchor.x + t.relativePosition.x,
        y: ctx.anchor.y + t.relativePosition.y,
      },
      ctx.boardId,
      overrides,
    );
    tiles.push(tile);
  }

  const connections: Connection[] = [];
  const templateConnections = template.connections ?? [];
  const now = Date.now();
  for (const c of templateConnections) {
    const from = tiles[c.fromTileIndex];
    const to = tiles[c.toTileIndex];
    if (!from || !to) continue;
    connections.push({
      id: createId(),
      boardId: ctx.boardId,
      fromTileId: from.id,
      toTileId: to.id,
      fromBubble: c.fromBubble,
      toBubble: c.toBubble,
      pathType: c.pathType,
      pathColor: c.pathColor,
      pathSize: c.pathSize,
      pathStyle: c.pathStyle,
      arrowType: c.arrowType,
      arrowColor: c.arrowColor,
      arrowSize: c.arrowSize,
      visibility: c.visibility,
      labelVisibility: c.labelVisibility,
      label: { ...c.label } as ConnectionLabel,
      createdAt: now,
      updatedAt: now,
    });
  }

  return { tiles, connections };
}

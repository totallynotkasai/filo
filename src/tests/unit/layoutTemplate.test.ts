import { describe, it, expect } from 'vitest';
import { captureLayoutTemplate, instantiateLayoutTemplate } from '@renderer/lib/templates/layoutCapture';
import { LayoutTemplateSchema } from '@renderer/schema/index';
import type { Tile, TileStyle, Connection } from '@renderer/schema/index';
import type { TileType } from '../../shared/types';

function makeConn(overrides: Partial<Connection> & { fromTileId: string; toTileId: string }): Connection {
  return {
    id: overrides.id ?? `conn-${overrides.fromTileId}-${overrides.toTileId}`,
    boardId: overrides.boardId ?? 'b1',
    fromTileId: overrides.fromTileId,
    toTileId: overrides.toTileId,
    fromBubble: overrides.fromBubble ?? 1,
    toBubble: overrides.toBubble ?? 5,
    pathType: overrides.pathType ?? 'curved',
    pathColor: overrides.pathColor ?? '',
    pathSize: overrides.pathSize ?? 2,
    pathStyle: overrides.pathStyle ?? 'solid',
    arrowType: overrides.arrowType ?? 'end',
    arrowColor: overrides.arrowColor ?? '',
    arrowSize: overrides.arrowSize ?? 10,
    visibility: overrides.visibility ?? 'visible',
    labelVisibility: overrides.labelVisibility ?? 'visible',
    label: overrides.label ?? {
      text: '',
      color: '',
      textColor: '',
      backgroundColor: '',
      position: 0.5,
      locked: false,
    },
    createdAt: 1,
    updatedAt: 1,
  } as Connection;
}

const baseStyle: TileStyle = {
  headerColor: '#444',
  bodyColor: '#fff',
  borderColor: '#000',
  shape: 'rounded',
  borderStyle: 'solid',
  borderWidth: 1,
  shadowIntensity: 0.3,
};

function makeTile(overrides: Partial<Tile> & { type?: string }): Tile {
  return {
    id: overrides.id ?? 'tile-1',
    type: (overrides.type as 'text') ?? 'text',
    title: overrides.title ?? 'Title',
    position: overrides.position ?? { x: 0, y: 0 },
    size: overrides.size ?? { width: 200, height: 120 },
    style: { ...baseStyle, ...(overrides.style ?? {}) },
    locked: overrides.locked ?? false,
    faded: overrides.faded ?? false,
    tags: overrides.tags ?? [],
    boardId: overrides.boardId ?? 'b1',
    createdAt: 1,
    updatedAt: 1,
    contentId: (overrides as { contentId?: string }).contentId ?? 'c1',
    content: (overrides as { content?: string }).content ?? '<p>private</p>',
    ...overrides,
  } as Tile;
}

function emptyContext() {
  return { anchor: { x: 0, y: 0 }, boardId: 'b', existingTitles: [] as string[] };
}

describe('captureLayoutTemplate', () => {
  it('throws on empty selection', () => {
    expect(() => captureLayoutTemplate([], [], 'X')).toThrow();
  });

  it('computes a bounding box from the union of all tiles', () => {
    const tiles: Tile[] = [
      makeTile({ id: 't1', position: { x: 100, y: 200 }, size: { width: 80, height: 40 } }),
      makeTile({ id: 't2', position: { x: 300, y: 260 }, size: { width: 120, height: 60 } }),
    ];
    const template = captureLayoutTemplate(tiles, [], 'Pair');
    expect(template.boundingBox.width).toBe(420 - 100); // 320
    expect(template.boundingBox.height).toBe(320 - 200); // 120
  });

  it('records relative positions from the bounding-box top-left', () => {
    const tiles: Tile[] = [
      makeTile({ id: 't1', position: { x: 50, y: 100 }, size: { width: 60, height: 40 } }),
      makeTile({ id: 't2', position: { x: 150, y: 200 }, size: { width: 60, height: 40 } }),
    ];
    const template = captureLayoutTemplate(tiles, [], 'Pair');
    expect(template.tiles[0].relativePosition).toEqual({ x: 0, y: 0 });
    expect(template.tiles[1].relativePosition).toEqual({ x: 100, y: 100 });
  });

  it('strips title, content, contentId, tags, lock, faded, and ids from each tile', () => {
    const tiles: Tile[] = [
      makeTile({
        id: 'tile-secret',
        title: 'Private Title',
        tags: ['secret'],
        locked: true,
        faded: true,
        position: { x: 0, y: 0 },
      }),
    ];
    const template = captureLayoutTemplate(tiles, [], 'OneText');
    const captured = template.tiles[0] as unknown as Record<string, unknown>;
    expect(captured.title).toBeUndefined();
    expect(captured.content).toBeUndefined();
    expect(captured.contentId).toBeUndefined();
    expect(captured.tags).toBeUndefined();
    expect(captured.locked).toBeUndefined();
    expect(captured.faded).toBeUndefined();
    expect(captured.id).toBeUndefined();
    expect(captured.boardId).toBeUndefined();
    expect(captured.filePath).toBeUndefined();
  });

  it('strips src / url / filePath for media and link tiles', () => {
    const tiles: Tile[] = [
      { ...makeTile({ id: 'i1', position: { x: 0, y: 0 } }), type: 'image', src: 'foo.png' } as Tile,
      { ...makeTile({ id: 'l1', position: { x: 50, y: 50 } }), type: 'link', url: 'https://example.com' } as Tile,
      { ...makeTile({ id: 'f1', position: { x: 100, y: 100 } }), type: 'file', filePath: 'doc.pdf', fileName: 'doc.pdf', fileExtension: 'pdf' } as Tile,
    ];
    const template = captureLayoutTemplate(tiles, [], 'Mixed');
    for (const t of template.tiles) {
      const rec = t as unknown as Record<string, unknown>;
      expect(rec.src).toBeUndefined();
      expect(rec.url).toBeUndefined();
      expect(rec.filePath).toBeUndefined();
      expect(rec.fileName).toBeUndefined();
    }
  });

  it('preserves Timer duration and mode via config but drops runtime state', () => {
    const tile = {
      ...makeTile({ id: 'tm', position: { x: 0, y: 0 } }),
      type: 'timer',
      duration: 600,
      remaining: 120,
      mode: 'hms',
      isRunning: true,
    } as Tile;
    const template = captureLayoutTemplate([tile], [], 'Pomodoro');
    expect(template.tiles[0].config).toEqual({ duration: 600, mode: 'hms' });
    const rec = template.tiles[0] as unknown as Record<string, unknown>;
    expect(rec.remaining).toBeUndefined();
    expect(rec.isRunning).toBeUndefined();
  });

  it('preserves the full style object', () => {
    const tile = makeTile({
      id: 't1',
      position: { x: 0, y: 0 },
      style: { ...baseStyle, headerColor: '#ff0066', shape: 'rectangle', borderWidth: 3 },
    });
    const template = captureLayoutTemplate([tile], [], 'Styled');
    expect(template.tiles[0].style.headerColor).toBe('#ff0066');
    expect(template.tiles[0].style.shape).toBe('rectangle');
    expect(template.tiles[0].style.borderWidth).toBe(3);
  });

  it('produces a JSON value that validates against LayoutTemplateSchema', () => {
    const tile = makeTile({ position: { x: 10, y: 20 } });
    const template = captureLayoutTemplate([tile], [], 'Roundtrip');
    const parsed = LayoutTemplateSchema.safeParse(JSON.parse(JSON.stringify(template)));
    expect(parsed.success).toBe(true);
  });
});

describe('instantiateLayoutTemplate', () => {
  function makeFactory() {
    let counter = 0;
    return (type: TileType, position: { x: number; y: number }, boardId: string, overrides?: Record<string, unknown>): Tile => {
      counter += 1;
      const id = `gen-${counter}`;
      return {
        id,
        type,
        title: `Tile ${counter}`,
        position,
        size: { width: 200, height: 120 },
        style: baseStyle,
        locked: false,
        faded: false,
        tags: [],
        boardId,
        createdAt: 2,
        updatedAt: 2,
        contentId: `gen-content-${counter}`,
        content: '',
        ...(overrides ?? {}),
      } as Tile;
    };
  }

  it('positions each tile by anchor + relativePosition', () => {
    const tiles: Tile[] = [
      makeTile({ id: 'a', position: { x: 100, y: 100 }, size: { width: 50, height: 50 } }),
      makeTile({ id: 'b', position: { x: 200, y: 150 }, size: { width: 50, height: 50 } }),
    ];
    const template = captureLayoutTemplate(tiles, [], 'L');
    const created = instantiateLayoutTemplate(template, {
      ...emptyContext(),
      anchor: { x: 1000, y: 2000 },
      boardId: 'newBoard',
      createTile: makeFactory(),
    });
    expect(created.tiles[0].position).toEqual({ x: 1000, y: 2000 });
    expect(created.tiles[1].position).toEqual({ x: 1100, y: 2050 });
  });

  it('hands the factory the captured style, size, and per-type config', () => {
    const timer = {
      ...makeTile({ id: 'tm', position: { x: 0, y: 0 } }),
      type: 'timer',
      duration: 90,
      remaining: 30,
      mode: 'ms',
      isRunning: false,
    } as Tile;
    const template = captureLayoutTemplate([timer], [], 'Tm');

    let captured: Record<string, unknown> | undefined;
    instantiateLayoutTemplate(template, {
      ...emptyContext(),
      createTile: (_type, _pos, _board, overrides) => {
        captured = overrides;
        return makeFactory()(_type, _pos, _board, overrides);
      },
    });
    expect(captured?.duration).toBe(90);
    expect(captured?.mode).toBe('ms');
    expect(captured?.size).toEqual({ width: 200, height: 120 });
    expect((captured?.style as TileStyle).headerColor).toBe(baseStyle.headerColor);
  });

  it('produces fresh ids for every tile across instantiations', () => {
    const tile = makeTile({ position: { x: 0, y: 0 } });
    const template = captureLayoutTemplate([tile], [], 'Once');
    const factory = makeFactory();
    const first = instantiateLayoutTemplate(template, { ...emptyContext(), createTile: factory });
    const second = instantiateLayoutTemplate(template, { ...emptyContext(), createTile: factory });
    expect(first.tiles[0].id).not.toBe(second.tiles[0].id);
    const firstContent = first.tiles[0] as unknown as { contentId?: string };
    const secondContent = second.tiles[0] as unknown as { contentId?: string };
    expect(firstContent.contentId).not.toBe(secondContent.contentId);
  });

  it('assigns distinct titles and distinct contentIds when source tiles had distinct contentIds', () => {
    const tiles: Tile[] = [
      makeTile({ id: 'a', contentId: 'doc-a', position: { x: 0, y: 0 } }),
      makeTile({ id: 'b', contentId: 'doc-b', position: { x: 100, y: 0 } }),
    ];
    const template = captureLayoutTemplate(tiles, [], 'TwoFiles');
    const captured: Array<Record<string, unknown>> = [];
    instantiateLayoutTemplate(template, {
      ...emptyContext(),
      createTile: (_t, _p, _b, overrides) => {
        captured.push(overrides ?? {});
        return makeFactory()(_t, _p, _b, overrides);
      },
    });
    expect(captured[0].title).toBe('New Tile');
    expect(captured[1].title).toBe('New Tile 2');
    expect(captured[0].contentId).toBeTypeOf('string');
    expect(captured[1].contentId).toBeTypeOf('string');
    expect(captured[0].contentId).not.toBe(captured[1].contentId);
  });

  it('shares one fresh title and one fresh contentId when source tiles shared a contentId', () => {
    const tiles: Tile[] = [
      makeTile({ id: 'a', contentId: 'doc-shared', position: { x: 0, y: 0 } }),
      makeTile({ id: 'b', contentId: 'doc-shared', position: { x: 100, y: 0 } }),
      makeTile({ id: 'c', contentId: 'doc-shared', position: { x: 200, y: 0 } }),
    ];
    const template = captureLayoutTemplate(tiles, [], 'OneFile');
    const captured: Array<Record<string, unknown>> = [];
    instantiateLayoutTemplate(template, {
      ...emptyContext(),
      createTile: (_t, _p, _b, overrides) => {
        captured.push(overrides ?? {});
        return makeFactory()(_t, _p, _b, overrides);
      },
    });
    expect(captured[0].title).toBe('New Tile');
    expect(captured[1].title).toBe('New Tile');
    expect(captured[2].title).toBe('New Tile');
    expect(captured[0].contentId).toBe(captured[1].contentId);
    expect(captured[1].contentId).toBe(captured[2].contentId);
  });

  it('numbers new titles past the highest existing "New Tile N" on the target board', () => {
    const tiles: Tile[] = [
      makeTile({ id: 'a', contentId: 'doc-a', position: { x: 0, y: 0 } }),
      makeTile({ id: 'b', contentId: 'doc-b', position: { x: 100, y: 0 } }),
    ];
    const template = captureLayoutTemplate(tiles, [], 'WithGaps');
    const captured: Array<Record<string, unknown>> = [];
    instantiateLayoutTemplate(template, {
      anchor: { x: 0, y: 0 },
      boardId: 'b',
      existingTitles: ['New Tile', 'New Tile 3', 'Other'],
      createTile: (_t, _p, _b, overrides) => {
        captured.push(overrides ?? {});
        return makeFactory()(_t, _p, _b, overrides);
      },
    });
    expect(captured[0].title).toBe('New Tile 4');
    expect(captured[1].title).toBe('New Tile 5');
  });

  it('records distinct contentGroup keys for distinct source contentIds (and a shared key when shared)', () => {
    const tiles: Tile[] = [
      makeTile({ id: 'a', contentId: 'doc-1', position: { x: 0, y: 0 } }),
      makeTile({ id: 'b', contentId: 'doc-2', position: { x: 50, y: 0 } }),
      makeTile({ id: 'c', contentId: 'doc-1', position: { x: 100, y: 0 } }),
    ];
    const template = captureLayoutTemplate(tiles, [], 'Mixed');
    expect(template.tiles[0].contentGroup).toBeTypeOf('string');
    expect(template.tiles[0].contentGroup).toBe(template.tiles[2].contentGroup);
    expect(template.tiles[0].contentGroup).not.toBe(template.tiles[1].contentGroup);
  });
});

describe('captureLayoutTemplate — connections', () => {
  function makeFactory() {
    let counter = 0;
    return (
      type: TileType,
      position: { x: number; y: number },
      boardId: string,
      overrides?: Record<string, unknown>,
    ): Tile => {
      counter += 1;
      return {
        id: `gen-${counter}`,
        type,
        title: `T${counter}`,
        position,
        size: { width: 200, height: 120 },
        style: baseStyle,
        locked: false,
        faded: false,
        tags: [],
        boardId,
        createdAt: 1,
        updatedAt: 1,
        contentId: `c-${counter}`,
        content: '',
        ...(overrides ?? {}),
      } as Tile;
    };
  }

  it('captures connections between selected tiles as index pairs and preserves style fields', () => {
    const tiles: Tile[] = [
      makeTile({ id: 'a', position: { x: 0, y: 0 } }),
      makeTile({ id: 'b', position: { x: 200, y: 0 } }),
    ];
    const conn = makeConn({
      fromTileId: 'a',
      toTileId: 'b',
      pathColor: '#ff0000',
      pathStyle: 'dashed',
      arrowType: 'both',
      label: { text: 'parent of', color: '', textColor: '#333', backgroundColor: '#eef', position: 0.5, locked: false },
    });
    const template = captureLayoutTemplate(tiles, [conn], 'Pair');
    expect(template.connections).toBeDefined();
    expect(template.connections).toHaveLength(1);
    const tc = template.connections![0];
    expect(tc.fromTileIndex).toBe(0);
    expect(tc.toTileIndex).toBe(1);
    expect(tc.pathColor).toBe('#ff0000');
    expect(tc.pathStyle).toBe('dashed');
    expect(tc.arrowType).toBe('both');
    expect(tc.label.text).toBe('parent of');
    expect(tc.label.textColor).toBe('#333');
  });

  it('drops connections that cross the selection boundary', () => {
    const tiles: Tile[] = [
      makeTile({ id: 'a', position: { x: 0, y: 0 } }),
      makeTile({ id: 'b', position: { x: 200, y: 0 } }),
    ];
    const connections: Connection[] = [
      makeConn({ fromTileId: 'a', toTileId: 'b' }),
      makeConn({ fromTileId: 'a', toTileId: 'outside' }),
      makeConn({ fromTileId: 'outside', toTileId: 'b' }),
    ];
    const template = captureLayoutTemplate(tiles, connections, 'Pair');
    expect(template.connections).toHaveLength(1);
    expect(template.connections![0].fromTileIndex).toBe(0);
    expect(template.connections![0].toTileIndex).toBe(1);
  });

  it('omits the connections field when includeConnections is false', () => {
    const tiles: Tile[] = [
      makeTile({ id: 'a', position: { x: 0, y: 0 } }),
      makeTile({ id: 'b', position: { x: 200, y: 0 } }),
    ];
    const conn = makeConn({ fromTileId: 'a', toTileId: 'b' });
    const template = captureLayoutTemplate(tiles, [conn], 'Off', { includeConnections: false });
    expect(template.connections).toBeUndefined();
  });

  it('omits the connections field when no within-selection edges exist', () => {
    const tiles: Tile[] = [
      makeTile({ id: 'a', position: { x: 0, y: 0 } }),
      makeTile({ id: 'b', position: { x: 200, y: 0 } }),
    ];
    const template = captureLayoutTemplate(tiles, [], 'Empty');
    expect(template.connections).toBeUndefined();
  });

  it('instantiation recreates connections pointing to the new tile ids with fresh ids', () => {
    const tiles: Tile[] = [
      makeTile({ id: 'a', position: { x: 0, y: 0 } }),
      makeTile({ id: 'b', position: { x: 200, y: 0 } }),
    ];
    const conn = makeConn({
      fromTileId: 'a',
      toTileId: 'b',
      pathColor: '#0f0',
      label: { text: 'edge', color: '', textColor: '', backgroundColor: '', position: 0.5, locked: false },
    });
    const template = captureLayoutTemplate(tiles, [conn], 'Pair');
    const result = instantiateLayoutTemplate(template, {
      anchor: { x: 50, y: 50 },
      boardId: 'newBoard',
      existingTitles: [],
      createTile: makeFactory(),
    });
    expect(result.connections).toHaveLength(1);
    const c = result.connections[0];
    expect(c.id).not.toBe(conn.id);
    expect(c.boardId).toBe('newBoard');
    expect(c.fromTileId).toBe(result.tiles[0].id);
    expect(c.toTileId).toBe(result.tiles[1].id);
    expect(c.pathColor).toBe('#0f0');
    expect(c.label.text).toBe('edge');
  });

  it('legacy templates without a connections field instantiate cleanly with empty connections', () => {
    const tiles: Tile[] = [makeTile({ id: 'a', position: { x: 0, y: 0 } })];
    const template = captureLayoutTemplate(tiles, [], 'Legacy');
    // Simulate a v1 template loaded from disk where connections is absent.
    expect(template.connections).toBeUndefined();
    const result = instantiateLayoutTemplate(template, {
      anchor: { x: 0, y: 0 },
      boardId: 'b',
      existingTitles: [],
      createTile: makeFactory(),
    });
    expect(result.tiles).toHaveLength(1);
    expect(result.connections).toEqual([]);
  });

  it('a captured template with connections round-trips through LayoutTemplateSchema', () => {
    const tiles: Tile[] = [
      makeTile({ id: 'a', position: { x: 0, y: 0 } }),
      makeTile({ id: 'b', position: { x: 100, y: 100 } }),
    ];
    const conn = makeConn({ fromTileId: 'a', toTileId: 'b', pathStyle: 'dotted' });
    const template = captureLayoutTemplate(tiles, [conn], 'RT');
    const parsed = LayoutTemplateSchema.safeParse(JSON.parse(JSON.stringify(template)));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.connections).toHaveLength(1);
      expect(parsed.data.connections![0].pathStyle).toBe('dotted');
    }
  });
});

import { describe, it, expect } from 'vitest';
import { ProjectSchema } from '@renderer/schema/project';
import { TileSchema } from '@renderer/schema/tile';
import { BoardSchema } from '@renderer/schema/board';
import { ConnectionSchema } from '@renderer/schema/connection';
import { FrameSchema } from '@renderer/schema/frame';
import { ProjectSettingsSchema } from '@renderer/schema/settings';

describe('Zod Schema Validation', () => {
  describe('ProjectSchema', () => {
    it('creates a valid project with defaults', () => {
      const now = Date.now();
      const result = ProjectSchema.parse({ createdAt: now, updatedAt: now });
      // Sprint C / C4 — `version` and `tags` no longer on the schema.
      expect(result.name).toBe('');
      expect(result.theme).toBe('light');
      expect(result.boards).toEqual([]);
      expect(result.connections).toEqual({});
      expect(result.frames).toEqual([]);
    });

    it('accepts valid theme values', () => {
      const now = Date.now();
      for (const theme of ['light', 'dark', 'blueprint', 'retro', 'nature'] as const) {
        const result = ProjectSchema.parse({ createdAt: now, updatedAt: now, theme });
        expect(result.theme).toBe(theme);
      }
    });

    it('rejects invalid theme values', () => {
      const now = Date.now();
      expect(() =>
        ProjectSchema.parse({ createdAt: now, updatedAt: now, theme: 'invalid' }),
      ).toThrow();
    });
  });

  describe('TileSchema', () => {
    const tileStyle = { headerColor: '#2a2a3e', bodyColor: '#1e1e30' };

    it('validates a text tile', () => {
      const tile = TileSchema.parse({
        id: 'tile-1',
        type: 'text',
        title: 'Test Tile',
        boardId: 'board-1',
        position: { x: 100, y: 200 },
        size: { width: 240, height: 160 },
        style: tileStyle,
        tags: [],
        locked: false,
        contentId: 'content-1',
        content: '<p>Hello</p>',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      expect(tile.type).toBe('text');
      expect(tile.title).toBe('Test Tile');
    });

    it('validates an image tile', () => {
      const tile = TileSchema.parse({
        id: 'tile-2',
        type: 'image',
        title: 'Image Tile',
        boardId: 'board-1',
        position: { x: 0, y: 0 },
        size: { width: 240, height: 160 },
        style: tileStyle,
        tags: [],
        locked: false,
        src: '/path/to/image.png',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      expect(tile.type).toBe('image');
    });

    it('validates a timer tile', () => {
      const tile = TileSchema.parse({
        id: 'tile-3',
        type: 'timer',
        title: 'Timer',
        boardId: 'board-1',
        position: { x: 0, y: 0 },
        size: { width: 240, height: 160 },
        style: tileStyle,
        tags: [],
        locked: false,
        duration: 0,
        mode: 'hms',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      expect(tile.type).toBe('timer');
      expect(tile.mode).toBe('hms');
    });

    it('coerces string dimensions to numbers', () => {
      const tile = TileSchema.parse({
        id: 'tile-coerce',
        type: 'text',
        title: 'Coerced Tile',
        boardId: 'board-1',
        position: { x: 0, y: 0 },
        size: { width: '300', height: '200' },
        style: { headerColor: '#fff', bodyColor: '#000', borderWidth: '2', shadowIntensity: '0.5' },
        tags: [],
        locked: false,
        contentId: 'c-1',
        content: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      expect(tile.size.width).toBe(300);
      expect(tile.size.height).toBe(200);
      expect(tile.style.borderWidth).toBe(2);
      expect(tile.style.shadowIntensity).toBe(0.5);
    });

    it('preserves renderedWidth and renderedHeight when provided', () => {
      const tile = TileSchema.parse({
        id: 'tile-rendered',
        type: 'text',
        title: 'Rendered Tile',
        boardId: 'board-1',
        position: { x: 0, y: 0 },
        size: { width: 240, height: 160 },
        style: { headerColor: '#fff', bodyColor: '#000' },
        tags: [],
        locked: false,
        contentId: 'c-2',
        content: '',
        renderedWidth: 280,
        renderedHeight: 350,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      expect(tile.renderedWidth).toBe(280);
      expect(tile.renderedHeight).toBe(350);
    });

    it('allows renderedWidth and renderedHeight to be omitted', () => {
      const tile = TileSchema.parse({
        id: 'tile-no-rendered',
        type: 'text',
        title: 'No Rendered',
        boardId: 'board-1',
        position: { x: 0, y: 0 },
        size: { width: 240, height: 160 },
        style: { headerColor: '#fff', bodyColor: '#000' },
        tags: [],
        locked: false,
        contentId: 'c-3',
        content: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      expect(tile.renderedWidth).toBeUndefined();
      expect(tile.renderedHeight).toBeUndefined();
    });
  });

  describe('BoardSchema', () => {
    it('validates a mind map board', () => {
      const board = BoardSchema.parse({
        id: 'board-1',
        type: 'mindmap',
        name: 'My Mind Map',
        settings: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      expect(board.type).toBe('mindmap');
      expect(board.name).toBe('My Mind Map');
    });

    it('validates a kanban board', () => {
      const board = BoardSchema.parse({
        id: 'board-2',
        type: 'kanban',
        name: 'My Kanban',
        settings: {},
        columns: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      expect(board.type).toBe('kanban');
    });
  });

  describe('ConnectionSchema', () => {
    it('validates a connection', () => {
      const conn = ConnectionSchema.parse({
        id: 'conn-1',
        fromTileId: 'tile-1',
        toTileId: 'tile-2',
        fromBubble: 0,
        toBubble: 4,
        boardId: 'board-1',
        pathType: 'curved',
        pathColor: '#6c63ff',
        pathStyle: 'solid',
        arrowType: 'end',
        arrowColor: '#6c63ff',
        visibility: 'visible',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      expect(conn.pathType).toBe('curved');
      expect(conn.arrowType).toBe('end');
    });
  });

  describe('FrameSchema', () => {
    it('validates a frame', () => {
      const frame = FrameSchema.parse({
        id: 'frame-1',
        boardId: 'board-1',
        title: 'Group A',
        position: { x: 50, y: 50 },
        size: { width: 400, height: 300 },
        style: {},
        tileIds: ['tile-1', 'tile-2'],
        collapsed: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      expect(frame.title).toBe('Group A');
      expect(frame.tileIds).toHaveLength(2);
    });
  });

  describe('ProjectSettingsSchema', () => {
    it('creates valid settings with all defaults', () => {
      const settings = ProjectSettingsSchema.parse({});
      expect(settings.general.globalFont).toBe('Inter, system-ui, sans-serif');
      expect(settings.general.globalToolbarScale).toBe(1.0);
      expect(settings.mindmap.backgroundPattern).toBe('grid');
      expect(settings.kanban.accentColor).toBe('');
    });

    it('accepts custom overrides', () => {
      const settings = ProjectSettingsSchema.parse({
        general: { globalToolbarScale: 1.25 },
      });
      expect(settings.general.globalToolbarScale).toBe(1.25);
    });

  });
});

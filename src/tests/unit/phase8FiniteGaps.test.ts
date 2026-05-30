import { describe, it, expect } from 'vitest';
import { MindMapBoardSchema, TaskListBoardSchema } from '@renderer/schema/board';
import { FiloLinkSchema } from '@renderer/schema/link';
import { LayoutTemplateSchema } from '@renderer/schema/layoutTemplate';

/**
 * Phase 8 / 8.3 — `.finite()` rejects NaN / ±Infinity on every coordinate
 * and size field that a hand-edited (or corrupted) file could otherwise
 * propagate into pan/zoom/transform math. The previous pass covered
 * tile placements and frame coords (see phase17SchemaTypeSafety.test.ts
 * H9); this pass closes the remaining gaps in:
 *
 *   - `MindMapBoardSchema.waypoints[*]` x/y/zoom
 *   - `TaskListSettingsSchema.tocPanelBounds` x/y/width/height
 *   - `FiloLinkSchema.targetPosition` x/y
 *   - `LayoutTemplateSchema` relativePosition / size / boundingBox
 */
describe('Phase 8 / 8.3 — .finite() on coord/size fields', () => {
  function baseMindMap(extra: Record<string, unknown> = {}): unknown {
    const now = Date.now();
    return {
      id: 'b1',
      type: 'mindmap',
      name: 'Alpha',
      emoji: '',
      createdAt: now,
      updatedAt: now,
      settings: {},
      placements: {},
      inlineTiles: {},
      connections: [],
      frames: [],
      waypoints: [],
      groups: [],
      ...extra,
    };
  }

  function baseTaskList(extra: Record<string, unknown> = {}): unknown {
    const now = Date.now();
    return {
      id: 'b1',
      type: 'tasklist',
      name: 'Tasks',
      emoji: '',
      createdAt: now,
      updatedAt: now,
      settings: { ...((extra as { settings?: Record<string, unknown> }).settings ?? {}) },
      tasks: [],
      sections: [],
      collapsedSubtasks: [],
    };
  }

  describe('MindMapBoardSchema.waypoints', () => {
    it('accepts a finite waypoint', () => {
      const r = MindMapBoardSchema.safeParse(
        baseMindMap({
          waypoints: [
            { id: 'w1', name: 'A', x: 100, y: 200, zoom: 1, icon: '📌', locked: false },
          ],
        }),
      );
      expect(r.success).toBe(true);
    });

    it('rejects NaN x on a waypoint', () => {
      const r = MindMapBoardSchema.safeParse(
        baseMindMap({
          waypoints: [
            { id: 'w1', name: 'A', x: NaN, y: 0, zoom: 1, icon: '', locked: false },
          ],
        }),
      );
      expect(r.success).toBe(false);
    });

    it('rejects Infinity y on a waypoint', () => {
      const r = MindMapBoardSchema.safeParse(
        baseMindMap({
          waypoints: [
            { id: 'w1', name: 'A', x: 0, y: Infinity, zoom: 1, icon: '', locked: false },
          ],
        }),
      );
      expect(r.success).toBe(false);
    });

    it('rejects -Infinity zoom on a waypoint', () => {
      const r = MindMapBoardSchema.safeParse(
        baseMindMap({
          waypoints: [
            { id: 'w1', name: 'A', x: 0, y: 0, zoom: -Infinity, icon: '', locked: false },
          ],
        }),
      );
      expect(r.success).toBe(false);
    });
  });

  describe('TaskListSettings.tocPanelBounds', () => {
    it('accepts finite bounds', () => {
      const r = TaskListBoardSchema.safeParse(
        baseTaskList({ settings: { tocPanelBounds: { x: 10, y: 20, width: 300, height: 400 } } }),
      );
      expect(r.success).toBe(true);
    });

    it('rejects NaN width', () => {
      const r = TaskListBoardSchema.safeParse(
        baseTaskList({ settings: { tocPanelBounds: { x: 0, y: 0, width: NaN, height: 100 } } }),
      );
      expect(r.success).toBe(false);
    });

    it('rejects Infinity x', () => {
      const r = TaskListBoardSchema.safeParse(
        baseTaskList({ settings: { tocPanelBounds: { x: Infinity, y: 0, width: 100, height: 100 } } }),
      );
      expect(r.success).toBe(false);
    });
  });

  describe('FiloLinkSchema.targetPosition', () => {
    it('accepts a finite position-nav link', () => {
      const r = FiloLinkSchema.safeParse({
        id: 'l1',
        type: 'position-nav',
        targetBoardId: 'b1',
        targetPosition: { x: 10, y: 20 },
        label: '',
      });
      expect(r.success).toBe(true);
    });

    it('rejects NaN x in targetPosition', () => {
      const r = FiloLinkSchema.safeParse({
        id: 'l1',
        type: 'position-nav',
        targetBoardId: 'b1',
        targetPosition: { x: NaN, y: 20 },
        label: '',
      });
      expect(r.success).toBe(false);
    });

    it('rejects Infinity y in targetPosition', () => {
      const r = FiloLinkSchema.safeParse({
        id: 'l1',
        type: 'position-nav',
        targetBoardId: 'b1',
        targetPosition: { x: 0, y: Infinity },
        label: '',
      });
      expect(r.success).toBe(false);
    });
  });

  describe('LayoutTemplateSchema', () => {
    function baseTemplate(extra: Record<string, unknown> = {}): unknown {
      const now = Date.now();
      return {
        id: 't1',
        name: 'Template',
        version: 1,
        createdAt: now,
        updatedAt: now,
        boundingBox: { width: 200, height: 100 },
        tiles: [
          {
            type: 'text',
            relativePosition: { x: 0, y: 0 },
            size: { width: 80, height: 40 },
            style: { headerColor: '', bodyColor: '', borderColor: '' },
          },
        ],
        ...extra,
      };
    }

    it('accepts a finite template', () => {
      expect(LayoutTemplateSchema.safeParse(baseTemplate()).success).toBe(true);
    });

    it('rejects NaN in relativePosition.x', () => {
      const r = LayoutTemplateSchema.safeParse(
        baseTemplate({
          tiles: [
            {
              type: 'text',
              relativePosition: { x: NaN, y: 0 },
              size: { width: 80, height: 40 },
              style: { headerColor: '', bodyColor: '', borderColor: '' },
            },
          ],
        }),
      );
      expect(r.success).toBe(false);
    });

    it('rejects Infinity in size.width', () => {
      const r = LayoutTemplateSchema.safeParse(
        baseTemplate({
          tiles: [
            {
              type: 'text',
              relativePosition: { x: 0, y: 0 },
              size: { width: Infinity, height: 40 },
              style: { headerColor: '', bodyColor: '', borderColor: '' },
            },
          ],
        }),
      );
      expect(r.success).toBe(false);
    });

    it('rejects NaN in boundingBox.height', () => {
      const r = LayoutTemplateSchema.safeParse(
        baseTemplate({ boundingBox: { width: 200, height: NaN } }),
      );
      expect(r.success).toBe(false);
    });
  });
});

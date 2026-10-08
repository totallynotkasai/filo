/**
 * A board template's own `"settings"` reach the board it makes: each one the
 * board's type has, with a value its schema takes. The board's place is
 * Filo's to choose, never a template's.
 */
import { describe, it, expect } from 'vitest';
import { boardDefaults } from '@renderer/core/boardDefaults';
import { withTemplateSettings } from '@renderer/lib/templates/templateBoardSettings';
import { BoardTemplateSkeletonSchema } from '@renderer/schema/boardTemplate';
import { KanbanBoardSchema } from '@renderer/schema/index';
import { parseTemplate } from '@renderer/lib/templates/templateService';

describe('withTemplateSettings', () => {
  it("lays a ```filo-board``` block's settings over a new board's", () => {
    const raw = '---\ntitle: Sprint\n---\n```filo-board\n{"type":"kanban","settings":{"accentColor":"#ff0000","backgroundPattern":"dots"},"columns":[]}\n```\n';
    const skeleton = BoardTemplateSkeletonSchema.parse(parseTemplate({ name: 'Sprint', path: 'Templates/Sprint.md', isBoard: false }, raw).boardJson);
    const board = boardDefaults.kanban('kanban_x', 'Sprint', undefined);
    const { settings, refused } = withTemplateSettings('kanban', board.settings as Record<string, unknown>, skeleton.settings);
    expect(settings).toMatchObject({ accentColor: '#ff0000', backgroundPattern: 'dots' });
    expect(refused).toEqual([]);
    // The board still loads.
    expect(KanbanBoardSchema.safeParse({ ...board, settings }).success).toBe(true);
  });

  it("leaves out a setting the board doesn't have, a value it can't take, and where the board keeps its notes", () => {
    const board = boardDefaults.tasklist('tasklist_x', 'Week', undefined);
    const { settings, refused } = withTemplateSettings('tasklist', board.settings as Record<string, unknown>, {
      groupBy: 'priority',
      titleFontSize: 400,
      sortBy: 'nonsense',
      defaultFolder: 'Elsewhere',
      unknownKey: 1,
    });
    expect(settings.groupBy).toBe('priority');
    expect(settings.titleFontSize).toBeUndefined();
    expect(settings.sortBy).toBe('priority');
    expect(settings.defaultFolder).not.toBe('Elsewhere');
    expect(settings.unknownKey).toBeUndefined();
    expect(refused).toEqual(['titleFontSize', 'sortBy', 'defaultFolder', 'unknownKey']);
  });
});

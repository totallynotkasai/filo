import { describe, it, expect, afterEach, vi } from 'vitest';
import { loadBoard } from '@renderer/lib/boards/boardLoader';
import { boardLoadFailedToast } from '@renderer/lib/boards/boardLoadFailedNotice';

/**
 * A board that fails validation names its first few problems, not every one:
 * a 300-tile board with one bad field in each used to put about 200 KB of
 * text in the notice. The whole list is one click away (Copy all problems).
 */

function badBoard(tiles: number): Record<string, unknown> {
  const placements: Record<string, unknown> = {};
  const tileDefs: Record<string, unknown> = {};
  for (let i = 0; i < tiles; i++) {
    placements[`t${i}`] = { x: 'left', y: 0, width: 100, height: 100 };
    tileDefs[`t${i}`] = { id: `t${i}`, type: 'text', filePath: `n${i}.md`, style: { headerColor: '', bodyColor: '' }, createdAt: 0, updatedAt: 0 };
  }
  return {
    version: 8,
    board: { id: 'mm', name: 'Big', emoji: '', type: 'mindmap', settings: {}, placements, inlineTiles: {}, createdAt: 0, updatedAt: 0 },
    tileDefs,
    connections: {},
    frames: [],
  };
}

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).filo;
  vi.unstubAllGlobals();
});

describe('a board that fails validation', () => {
  it('names three problems and how many more, and keeps the whole list', async () => {
    (window as unknown as Record<string, unknown>).filo = {
      invoke: async (channel: string) => (channel === 'board:load' ? badBoard(300) : null),
      on: () => () => {},
      send: () => {},
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await loadBoard('/vault', 'Big.board.json');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('schema-invalid');
    expect(result.problems).toHaveLength(300);
    expect(result.message).toMatch(/and 297 more$/);
    expect(result.message.length).toBeLessThan(400);

    const toast = boardLoadFailedToast('/vault', {
      path: 'Big.board.json', errorKind: result.error, message: result.message, problems: result.problems,
    }, '/vault/.filo/recovery/x/Big.board.json');
    expect(toast.text.length).toBeLessThan(700);
    expect(toast.actions.map((a) => a.label)).toEqual(['Show in folder', 'Copy all problems']);

    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    toast.actions[1]!.handler();
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('board.placements.t299.x'));
    expect((writeText.mock.calls[0] as unknown as [string])[0].split('\n')).toHaveLength(300);
  });

  it('a few problems are all named, with nothing to copy', () => {
    const toast = boardLoadFailedToast('/vault', {
      path: 'B.board.json', errorKind: 'schema-invalid', message: 'a: x; b: y', problems: ['a: x', 'b: y'],
    }, null);
    expect(toast.text).toContain('(a: x; b: y)');
    expect(toast.actions.map((a) => a.label)).toEqual(['Show in folder']);
  });
});

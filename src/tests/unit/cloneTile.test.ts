import { describe, it, expect } from 'vitest';
import { cloneTile } from '@renderer/lib/utils/cloneTile';
import type { Tile } from '@renderer/schema/index';

function makeTextTile(content: string): Tile {
  return {
    id: 'tile-1',
    type: 'text',
    title: 'Test',
    position: { x: 100, y: 200 },
    size: { width: 240, height: 160 },
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
    tags: ['tag1', 'tag2'],
    boardId: 'b1',
    createdAt: 1,
    updatedAt: 1,
    contentId: 'c1',
    content,
  } as Tile;
}

describe('cloneTile', () => {
  it('produces a tile with the same id and position', () => {
    const original = makeTextTile('<p>Hello World</p>');
    const clone = cloneTile(original);
    expect(clone.id).toBe(original.id);
    expect(clone.position.x).toBe(100);
    expect(clone.position.y).toBe(200);
  });

  it('shares large string content by reference', () => {
    const bigContent = '<p>' + 'x'.repeat(100_000) + '</p>';
    const original = makeTextTile(bigContent);
    const clone = cloneTile(original);
    // In JS, string identity is only guaranteed for interned strings,
    // but spread-assigned strings from the same object are the same reference
    const origRecord = original as Record<string, unknown>;
    const cloneRecord = clone as Record<string, unknown>;
    // Content should equal
    expect(cloneRecord.content).toBe(origRecord.content);
  });

  it('mutation of clone position does not affect original', () => {
    const original = makeTextTile('');
    const clone = cloneTile(original);
    clone.position.x = 999;
    expect(original.position.x).toBe(100);
  });

  it('mutation of clone tags does not affect original', () => {
    const original = makeTextTile('');
    const clone = cloneTile(original);
    clone.tags.push('newTag');
    expect(original.tags).toHaveLength(2);
    expect(clone.tags).toHaveLength(3);
  });

  it('preserves style properties', () => {
    const original = makeTextTile('');
    const clone = cloneTile(original);
    clone.style.headerColor = '#000';
    expect(original.style.headerColor).toBe('#fff');
  });

  // IMPL_PLAN_2026-05-26 / Item 3 — `TileStyle` is schema-validated as
  // flat today but uses `.passthrough()`, so a future writer could land
  // a nested sub-object (e.g. `style.background.colour`). A shallow
  // spread would alias that sub-object between the cache and the undo
  // snapshot, letting an in-place mutation corrupt history. The JSON
  // round-trip clone defends against this — assert directly.
  it('deep-clones nested style sub-objects', () => {
    const original = makeTextTile('');
    // Synthesise a nested style sub-object via passthrough. Casts to the
    // schema-validated shape are intentional — we're exercising the
    // shape future writers might use.
    (original.style as unknown as { background: { colour: string } }).background = {
      colour: '#fff',
    };

    const clone = cloneTile(original);
    // Mutate the clone's nested field in place. With a shallow spread,
    // this would also flip the original's value — the regression we
    // pin against.
    (clone.style as unknown as { background: { colour: string } }).background.colour = '#000';

    expect(
      (original.style as unknown as { background: { colour: string } }).background.colour,
    ).toBe('#fff');
  });
});

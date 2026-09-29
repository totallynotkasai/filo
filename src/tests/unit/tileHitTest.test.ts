import { describe, it, expect } from 'vitest';
import { tileIdFromTarget, topmostHitTile } from '@renderer/lib/mindmap/tileHitTest';

/**
 * A right-click on overlapping Mind Map tiles picks the tile drawn on top,
 * the same one a left click there would pick, whatever order the spatial
 * index returns its hits in.
 */
describe('topmostHitTile', () => {
  const none = (): boolean => false;

  it('takes the tile painted last, not the last spatial hit', () => {
    expect(topmostHitTile(['top', 'under'], {
      paintOrder: ['under', 'top'], isSelected: none, hidden: new Set(),
    })).toBe('top');
  });

  it('a selected tile is above an unselected one painted later', () => {
    expect(topmostHitTile(['a', 'b'], {
      paintOrder: ['a', 'b'], isSelected: (id) => id === 'a', hidden: new Set(),
    })).toBe('a');
  });

  it('a tile inside a collapsed frame is never hit', () => {
    expect(topmostHitTile(['a', 'b'], {
      paintOrder: ['a', 'b'], isSelected: none, hidden: new Set(['b']),
    })).toBe('a');
    expect(topmostHitTile(['b'], {
      paintOrder: ['a', 'b'], isSelected: none, hidden: new Set(['b']),
    })).toBeNull();
  });

  it('reads the tile id off the element under the pointer', () => {
    const shell = document.createElement('div');
    shell.setAttribute('data-canvas-tile-id', 't1');
    const inner = document.createElement('span');
    shell.appendChild(inner);
    expect(tileIdFromTarget(inner)).toBe('t1');
    expect(tileIdFromTarget(document.createElement('div'))).toBeNull();
    expect(tileIdFromTarget(null)).toBeNull();
  });
});

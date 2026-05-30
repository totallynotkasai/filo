import { describe, it, expect, beforeEach } from 'vitest';
import { SpatialIndex } from '@renderer/lib/spatialIndex';

describe('SpatialIndex', () => {
  let index: SpatialIndex;

  beforeEach(() => {
    index = new SpatialIndex();
  });

  it('starts empty', () => {
    expect(index.all()).toEqual([]);
  });

  it('inserts items', () => {
    index.insert('a', 0, 0, 100, 50);
    const all = index.all();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe('a');
    expect(all[0].minX).toBe(0);
    expect(all[0].maxX).toBe(100);
  });

  it('removes items', () => {
    index.insert('a', 0, 0, 100, 50);
    index.insert('b', 200, 200, 100, 50);
    expect(index.all()).toHaveLength(2);

    index.remove('a');
    expect(index.all()).toHaveLength(1);
    expect(index.all()[0].id).toBe('b');
  });

  it('removes non-existent item without error', () => {
    index.remove('nonexistent');
    expect(index.all()).toHaveLength(0);
  });

  it('updates item position', () => {
    index.insert('a', 0, 0, 100, 50);
    index.update('a', 500, 500, 100, 50);
    expect(index.all()).toHaveLength(1);
    const item = index.all()[0];
    expect(item.minX).toBe(500);
    expect(item.minY).toBe(500);
  });

  it('queries viewport correctly', () => {
    index.insert('visible', 50, 50, 100, 100);
    index.insert('outside', 2000, 2000, 100, 100);

    const results = index.queryViewport({
      left: 0,
      top: 0,
      right: 500,
      bottom: 500,
    });

    expect(results).toContain('visible');
    expect(results).not.toContain('outside');
  });

  it('queries viewport with partial overlap', () => {
    index.insert('partial', 450, 450, 100, 100);

    const results = index.queryViewport({
      left: 0,
      top: 0,
      right: 500,
      bottom: 500,
    });

    expect(results).toContain('partial');
  });

  it('clears all items', () => {
    index.insert('a', 0, 0, 100, 100);
    index.insert('b', 200, 200, 100, 100);
    index.clear();
    expect(index.all()).toEqual([]);
  });
});

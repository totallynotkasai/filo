import { describe, it, expect } from 'vitest';
import { isGeometryOnlyUpdate } from '../../renderer/lib/utils/tileUpdateFastPath';
import type { Tile } from '../../renderer/schema/index';

describe('isGeometryOnlyUpdate', () => {
  it('accepts position-only updates with finite numbers', () => {
    expect(isGeometryOnlyUpdate({ position: { x: 100, y: 200 } } as Partial<Tile>)).toBe(true);
    expect(isGeometryOnlyUpdate({ position: { x: 0, y: 0 } } as Partial<Tile>)).toBe(true);
    expect(isGeometryOnlyUpdate({ position: { x: -42.5, y: 1.5e6 } } as Partial<Tile>)).toBe(true);
  });

  it('accepts size-only updates with finite numbers', () => {
    expect(isGeometryOnlyUpdate({ size: { width: 240, height: 160 } } as Partial<Tile>)).toBe(true);
  });

  it('accepts combined position + size updates', () => {
    expect(isGeometryOnlyUpdate({
      position: { x: 1, y: 2 },
      size: { width: 100, height: 100 },
    } as Partial<Tile>)).toBe(true);
  });

  it('accepts rendered{Width,Height} alone or combined', () => {
    expect(isGeometryOnlyUpdate({ renderedWidth: 250 } as Partial<Tile>)).toBe(true);
    expect(isGeometryOnlyUpdate({ renderedHeight: 180 } as Partial<Tile>)).toBe(true);
    expect(isGeometryOnlyUpdate({
      position: { x: 0, y: 0 },
      renderedWidth: 200,
      renderedHeight: 150,
    } as Partial<Tile>)).toBe(true);
  });

  it('rejects empty update object', () => {
    expect(isGeometryOnlyUpdate({})).toBe(false);
  });

  it('rejects updates with non-geometry keys', () => {
    expect(isGeometryOnlyUpdate({ title: 'New title' } as Partial<Tile>)).toBe(false);
    expect(isGeometryOnlyUpdate({ locked: true } as Partial<Tile>)).toBe(false);
    expect(isGeometryOnlyUpdate({
      position: { x: 1, y: 2 },
      title: 'mixed',
    } as Partial<Tile>)).toBe(false);
  });

  it('rejects NaN / Infinity in position coordinates', () => {
    expect(isGeometryOnlyUpdate({ position: { x: NaN, y: 0 } } as Partial<Tile>)).toBe(false);
    expect(isGeometryOnlyUpdate({ position: { x: 0, y: NaN } } as Partial<Tile>)).toBe(false);
    expect(isGeometryOnlyUpdate({ position: { x: Infinity, y: 0 } } as Partial<Tile>)).toBe(false);
    expect(isGeometryOnlyUpdate({ position: { x: 0, y: -Infinity } } as Partial<Tile>)).toBe(false);
  });

  it('rejects NaN / Infinity in size dimensions', () => {
    expect(isGeometryOnlyUpdate({ size: { width: NaN, height: 100 } } as Partial<Tile>)).toBe(false);
    expect(isGeometryOnlyUpdate({ size: { width: 100, height: Infinity } } as Partial<Tile>)).toBe(false);
  });

  it('rejects NaN / Infinity in renderedWidth/Height', () => {
    expect(isGeometryOnlyUpdate({ renderedWidth: NaN } as Partial<Tile>)).toBe(false);
    expect(isGeometryOnlyUpdate({ renderedHeight: Infinity } as Partial<Tile>)).toBe(false);
  });

  it('rejects malformed position / size shapes', () => {
    expect(isGeometryOnlyUpdate({ position: null } as unknown as Partial<Tile>)).toBe(false);
    expect(isGeometryOnlyUpdate({ position: { x: 1 } } as unknown as Partial<Tile>)).toBe(false);
    expect(isGeometryOnlyUpdate({ size: { width: 1 } } as unknown as Partial<Tile>)).toBe(false);
    expect(isGeometryOnlyUpdate({ position: { x: '1', y: 2 } } as unknown as Partial<Tile>)).toBe(false);
  });
});

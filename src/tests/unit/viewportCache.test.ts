/**
 * `.filo/viewports.json`: every mind map's camera in one file, held in memory
 * and written on a long debounce so a pan / zoom session is one write. What
 * matters: a hand-edited file can't seed a NaN camera, the write carries every
 * board's entry (not just the last one moved), a closed vault is never
 * written, and the seed publishes the active vault path other guards read.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  seedViewportsCache,
  clearViewportsCache,
  getViewportFromCache,
  setViewport,
  removeViewport,
  type ViewportEntry,
} from '@renderer/lib/boards/viewportCache';
import { getActiveVaultPath } from '@renderer/lib/vault/activeVaultPath';
import { cancelAllPendingMiscWrites, flushAllMisc } from '@renderer/lib/boards/miscWriteScheduler';
import { __resetDirtyTrackingForTests, resetWriteTracking } from '@renderer/lib/boards/writeStateTracking';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

const DEBOUNCE_MS = 1500;
const saves: Array<{ vaultRoot: unknown; name: unknown; json: Record<string, ViewportEntry> }> = [];

beforeEach(() => {
  saves.length = 0;
  installFiloMock((channel: string, ...args: unknown[]) => {
    if (channel === 'config:save') {
      saves.push({ vaultRoot: args[0], name: args[1], json: JSON.parse(String(args[2])) });
      return { ok: true };
    }
    return undefined;
  });
  __resetDirtyTrackingForTests();
});

afterEach(() => {
  cancelAllPendingMiscWrites();
  clearViewportsCache();
  __resetDirtyTrackingForTests();
  vi.useRealTimers();
  restoreFiloDefault();
});

describe('seedViewportsCache', () => {
  it('loads well-formed entries and keeps their updatedAt', () => {
    seedViewportsCache('/vault', { a: { x: 1, y: 2, scale: 0.5, updatedAt: 99 } });
    expect(getViewportFromCache('a')).toEqual({ x: 1, y: 2, scale: 0.5, updatedAt: 99 });
  });

  it('skips entries a hand edit broke (non-number, non-finite, missing, not an object)', () => {
    const raw: Record<string, unknown> = {
      ok: { x: 0, y: 0, scale: 1 },
      str: { x: '1', y: 0, scale: 1 },
      nan: { x: Number.NaN, y: 0, scale: 1 },
      inf: { x: 0, y: Number.POSITIVE_INFINITY, scale: 1 },
      noScale: { x: 0, y: 0 },
      nul: null,
      num: 7,
    };
    // The file's contents are untrusted JSON; the seed must cope with any shape.
    seedViewportsCache('/vault', raw as Record<string, ViewportEntry>);
    expect(getViewportFromCache('ok')).toEqual({ x: 0, y: 0, scale: 1, updatedAt: undefined });
    for (const id of ['str', 'nan', 'inf', 'noScale', 'nul', 'num']) {
      expect(getViewportFromCache(id)).toBeNull();
    }
  });

  it('drops extra keys from an entry', () => {
    const raw: Record<string, unknown> = { a: { x: 1, y: 1, scale: 1, evil: 'x' } };
    seedViewportsCache('/vault', raw as Record<string, ViewportEntry>);
    expect(Object.keys(getViewportFromCache('a') ?? {}).sort()).toEqual(['scale', 'updatedAt', 'x', 'y']);
  });

  it('replaces the previous vault\'s cameras', () => {
    seedViewportsCache('/one', { a: { x: 1, y: 1, scale: 1 } });
    seedViewportsCache('/two', { b: { x: 2, y: 2, scale: 2 } });
    expect(getViewportFromCache('a')).toBeNull();
    expect(getViewportFromCache('b')?.x).toBe(2);
  });

  it('publishes the active vault path, and clearing withdraws it', () => {
    seedViewportsCache('/vault', {});
    expect(getActiveVaultPath()).toBe('/vault');
    clearViewportsCache();
    expect(getActiveVaultPath()).toBe('');
  });

  it('copes with a null map', () => {
    const missing: unknown = null;
    seedViewportsCache('/vault', missing as Record<string, ViewportEntry>);
    expect(getViewportFromCache('a')).toBeNull();
  });
});

describe('setViewport', () => {
  it('updates the cache at once, stamped with the time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(12_345);
    seedViewportsCache('/vault', {});
    setViewport('a', { x: 5, y: 6, scale: 2 });
    expect(getViewportFromCache('a')).toEqual({ x: 5, y: 6, scale: 2, updatedAt: 12_345 });
  });

  it('coalesces a burst into one write after the debounce, carrying every board', async () => {
    vi.useFakeTimers();
    seedViewportsCache('/vault', { other: { x: 9, y: 9, scale: 1 } });
    setViewport('a', { x: 1, y: 1, scale: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    setViewport('a', { x: 2, y: 2, scale: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    setViewport('a', { x: 3, y: 3, scale: 1.5 });

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1);
    expect(saves).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(saves).toHaveLength(1);
    expect(saves[0].vaultRoot).toBe('/vault');
    expect(saves[0].name).toBe('viewports.json');
    expect(Object.keys(saves[0].json).sort()).toEqual(['a', 'other']);
    expect(saves[0].json.a).toMatchObject({ x: 3, y: 3, scale: 1.5 });
    expect(saves[0].json.other).toMatchObject({ x: 9, y: 9, scale: 1 });
  });

  it('is written by a save-all flush without waiting for the debounce', async () => {
    seedViewportsCache('/vault', {});
    setViewport('a', { x: 1, y: 2, scale: 3 });
    const { failed } = await flushAllMisc();
    expect(failed).toEqual([]);
    expect(saves).toHaveLength(1);
    expect(saves[0].json.a).toMatchObject({ x: 1, y: 2, scale: 3 });
  });

  it('never writes with no vault seeded', async () => {
    setViewport('a', { x: 1, y: 1, scale: 1 });
    expect(getViewportFromCache('a')).not.toBeNull();
    await flushAllMisc();
    expect(saves).toHaveLength(0);
  });

  it('does not write a vault closed before the debounce fired', async () => {
    vi.useFakeTimers();
    seedViewportsCache('/vault', {});
    setViewport('a', { x: 1, y: 1, scale: 1 });
    clearViewportsCache();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    expect(saves).toHaveLength(0);
  });
});

describe('removeViewport', () => {
  it('drops the board and writes the file without it', async () => {
    seedViewportsCache('/vault', { a: { x: 1, y: 1, scale: 1 }, b: { x: 2, y: 2, scale: 1 } });
    removeViewport('a');
    expect(getViewportFromCache('a')).toBeNull();
    await flushAllMisc();
    expect(saves).toHaveLength(1);
    expect(Object.keys(saves[0].json)).toEqual(['b']);
  });

  it('does not write for a board it never had', async () => {
    seedViewportsCache('/vault', { a: { x: 1, y: 1, scale: 1 } });
    removeViewport('zzz');
    await flushAllMisc();
    expect(saves).toHaveLength(0);
  });
});

describe('resets', () => {
  it('the vault-swap write-tracking reset clears the cache', () => {
    seedViewportsCache('/vault', { a: { x: 1, y: 1, scale: 1 } });
    resetWriteTracking();
    expect(getViewportFromCache('a')).toBeNull();
    expect(getActiveVaultPath()).toBe('');
  });
});

import { describe, it, expect } from 'vitest';
import { forEachLimited } from '@renderer/lib/utils/forEachLimited';

describe('forEachLimited', () => {
  it('runs every item, never more than the limit at once, starting them in order', async () => {
    let running = 0;
    let peak = 0;
    const started: number[] = [];
    await forEachLimited([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      started.push(n);
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5 * (n % 3)));
      running--;
    });
    expect(started).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(peak).toBe(3);
  });

  it('a failure rejects only once every other item has settled', async () => {
    const done: number[] = [];
    await expect(forEachLimited([1, 2, 3, 4], 2, async (n) => {
      await new Promise((r) => setTimeout(r, n));
      if (n === 1) throw new Error('one failed');
      done.push(n);
    })).rejects.toThrow('one failed');
    expect(done.sort()).toEqual([2, 3, 4]);
  });

  it('an empty list resolves at once', async () => {
    await expect(forEachLimited([], 4, async () => {})).resolves.toBeUndefined();
  });
});

import { describe, it, expect } from 'vitest';
import { readFileWithCoherentStat } from '../../main/vault/fileOps';

/**
 * 6.4.M7 — coherent (content, stat) pairs.
 *
 * The legacy `vault:read-file-text` handler did stat → read, so an external
 * write landing in the gap meant the renderer received bytes from the NEW
 * file but a baseline (mtime/size) from the OLD file. Next reconcile then
 * fired a spurious "modified externally" prompt, or in the inverse race
 * silently pinned an older baseline against newer rendered bytes.
 *
 * The new helper takes two stats (pre and post). If they agree, mtime/size
 * are returned alongside content. If they disagree, mtime/size are
 * withheld and the renderer skips the baseline seed — a subsequent read
 * on a quiescent file seeds coherently.
 */
describe('readFileWithCoherentStat', () => {
  it('returns content + mtime/size when pre/post stat agree', async () => {
    const stat = async () => ({ mtimeMs: 1000, size: 5 });
    const readFile = async () => 'hello';
    const result = await readFileWithCoherentStat('/tmp/file.md', 1_000_000, {
      stat,
      readFile,
    });
    expect('tooLarge' in result).toBe(false);
    if ('tooLarge' in result) return;
    expect(result.content).toBe('hello');
    expect(result.mtimeMs).toBe(1000);
    expect(result.size).toBe(5);
  });

  it('withholds mtime/size when a write lands between pre- and post-stat (M7)', async () => {
    let statCalls = 0;
    const stat = async () => {
      statCalls++;
      // First call: pre-read snapshot. Second call: post-read snapshot.
      // The second call simulates a write landing in the read gap —
      // mtime advanced, size grew.
      if (statCalls === 1) return { mtimeMs: 1000, size: 5 };
      return { mtimeMs: 2000, size: 7 };
    };
    const readFile = async () => 'hello';
    const result = await readFileWithCoherentStat('/tmp/file.md', 1_000_000, {
      stat,
      readFile,
    });
    expect('tooLarge' in result).toBe(false);
    if ('tooLarge' in result) return;
    expect(result.content).toBe('hello');
    // The renderer must skip baseline seeding in this case; helper signals
    // by withholding the baseline fields.
    expect(result.mtimeMs).toBeUndefined();
    expect(result.size).toBeUndefined();
  });

  it('returns tooLarge before reading when pre-stat exceeds the cap', async () => {
    let readCalled = false;
    const stat = async () => ({ mtimeMs: 1000, size: 10_000_001 });
    const readFile = async () => {
      readCalled = true;
      return 'should-never-run';
    };
    const result = await readFileWithCoherentStat('/tmp/huge.md', 10_000_000, {
      stat,
      readFile,
    });
    expect('tooLarge' in result).toBe(true);
    if (!('tooLarge' in result)) return;
    expect(result.size).toBe(10_000_001);
    expect(readCalled).toBe(false);
  });

  it('returns content with no baseline when post-stat throws (e.g. ENOENT after read)', async () => {
    let statCalls = 0;
    const stat = async () => {
      statCalls++;
      if (statCalls === 1) return { mtimeMs: 1000, size: 5 };
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    const readFile = async () => 'hello';
    const result = await readFileWithCoherentStat('/tmp/file.md', 1_000_000, {
      stat,
      readFile,
    });
    expect('tooLarge' in result).toBe(false);
    if ('tooLarge' in result) return;
    expect(result.content).toBe('hello');
    expect(result.mtimeMs).toBeUndefined();
    expect(result.size).toBeUndefined();
  });
});

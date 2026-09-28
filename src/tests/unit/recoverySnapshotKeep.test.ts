/**
 * Recovery snapshots that may be the only copy left (the other version a Keep
 * mine / Keep local overwrote, an encoding conversion's original) are never
 * pruned, and a file that fails to load on every vault open is copied once
 * while it stays the same.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { snapshotForRecovery, __setSnapshotCapsForTests } from '../../main/services/recoverySnapshot';

async function allSnapshots(vaultRoot: string): Promise<string[]> {
  const root = join(vaultRoot, '.filo', 'recovery');
  const out: string[] = [];
  for (const dir of await fs.readdir(root)) {
    for (const name of await fs.readdir(join(root, dir))) out.push(`${dir}/${name}`);
  }
  return out.sort();
}

describe('recovery snapshots: kept copies and repeated load failures', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await fs.mkdtemp(join(tmpdir(), 'filo-recovery-keep-'));
    await fs.mkdir(join(vaultRoot, '.filo'), { recursive: true });
    // Small caps: the prunes run exactly as at 20 / 100, with a few writes.
    __setSnapshotCapsForTests({ perBasename: 3, total: 10 });
  });
  afterEach(async () => {
    __setSnapshotCapsForTests(null);
    await fs.rm(vaultRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('a Keep-mine copy survives more load-failure snapshots than the global cap', async () => {
    await fs.writeFile(join(vaultRoot, 'Note.md'), 'their version', 'utf-8');
    const kept = await snapshotForRecovery(vaultRoot, 'Note.md', 'keep');
    expect(kept).toMatch(/-keep[\\/]Note\.md$/);

    for (let i = 0; i < 15; i++) {
      const rel = `broken-${i}.board.json`;
      await fs.writeFile(join(vaultRoot, rel), `{ broken ${i}`, 'utf-8');
      await snapshotForRecovery(vaultRoot, rel, 'load-failure');
    }

    expect(await fs.readFile(kept, 'utf-8')).toBe('their version');
    const all = await allSnapshots(vaultRoot);
    // The global cap still bounds the prunable copies.
    expect(all.filter((p) => !p.includes('-keep/')).length).toBeLessThanOrEqual(10);
  });

  it('a Keep-mine copy is not pruned by the per-file cap either', async () => {
    await fs.writeFile(join(vaultRoot, 'Note.md'), 'first other version', 'utf-8');
    const kept = await snapshotForRecovery(vaultRoot, 'Note.md', 'keep');
    for (let i = 0; i < 6; i++) {
      await fs.writeFile(join(vaultRoot, 'Note.md'), `later ${i}`, 'utf-8');
      await snapshotForRecovery(vaultRoot, 'Note.md');
    }
    expect(await fs.readFile(kept, 'utf-8')).toBe('first other version');
  });

  it('opening twice with the same failed board takes one snapshot; a changed board takes another', async () => {
    await fs.writeFile(join(vaultRoot, 'Plan.board.json'), '{ not json', 'utf-8');
    const first = await snapshotForRecovery(vaultRoot, 'Plan.board.json', 'load-failure');
    await new Promise((r) => setTimeout(r, 5));
    const second = await snapshotForRecovery(vaultRoot, 'Plan.board.json', 'load-failure');
    expect(second).toBe(first);
    expect(await allSnapshots(vaultRoot)).toHaveLength(1);

    await fs.writeFile(join(vaultRoot, 'Plan.board.json'), '{ still not json', 'utf-8');
    await new Promise((r) => setTimeout(r, 5));
    await snapshotForRecovery(vaultRoot, 'Plan.board.json', 'load-failure');
    expect(await allSnapshots(vaultRoot)).toHaveLength(2);
  });
});

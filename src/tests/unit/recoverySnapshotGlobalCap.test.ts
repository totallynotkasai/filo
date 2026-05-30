/**
 * Phase A.6 — carry-over from IMPL_PLAN_2026-05-24 Phase 9.7.
 *
 * The constant `MAX_SNAPSHOTS_TOTAL` (Sprint C / C19 dropped from 200 to
 * 100) is exercised here:
 *
 *   1. Per-basename prune respected (existing 20-per-basename cap
 *      regression check).
 *   2. After per-basename prune, if total exceeds 100, the
 *      oldest-across-directory snapshots are pruned to 100.
 *   3. Cap is idempotent — calling snapshotForRecovery again with
 *      exactly 100 existing files doesn't churn the directory.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { snapshotForRecovery } from '../../main/services/recoverySnapshot';

describe('snapshotForRecovery — global cap (Phase A.6)', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await fs.mkdtemp(join(tmpdir(), 'filo-recovery-global-'));
    await fs.mkdir(join(vaultRoot, '.filo'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  it('case 1 — per-basename prune still respected after the global pass lands', async () => {
    // 25 historical snapshots of the SAME basename. Per-basename cap
    // (20) should drive the prune; the global cap (200) is well below
    // the file count so its pass is a no-op.
    const relPath = 'broken.board.json';
    await fs.writeFile(join(vaultRoot, relPath), 'snapshot-source', 'utf-8');

    const recoveryRoot = join(vaultRoot, '.filo', 'recovery');
    await fs.mkdir(recoveryRoot, { recursive: true });
    for (let i = 0; i < 25; i++) {
      const subdir = join(recoveryRoot, `2025-01-01T00-00-${String(i).padStart(2, '0')}`);
      await fs.mkdir(subdir, { recursive: true });
      const file = join(subdir, 'broken.board.json');
      await fs.writeFile(file, `historical-${i}`, 'utf-8');
      const mtime = new Date(2025, 0, 1, 0, 0, i);
      await fs.utimes(file, mtime, mtime);
    }

    await snapshotForRecovery(vaultRoot, relPath);

    // Per-basename prune brings the count from 26 → 20.
    const remaining: string[] = [];
    const dirs = await fs.readdir(recoveryRoot);
    for (const d of dirs) {
      const filePath = join(recoveryRoot, d, 'broken.board.json');
      try {
        await fs.access(filePath);
        remaining.push(filePath);
      } catch {
        // skip
      }
    }
    expect(remaining).toHaveLength(20);
  });

  // Sprint D — these two cases each create ~200 fs entries + utimes calls.
  // On Windows under ci:verify's parallel test load case 2 alone has been
  // observed at 25s. Bumped to 60s; not a behaviour change.
  it('case 2 — total above 100 is pruned to exactly 100', { timeout: 60000 }, async () => {
    // 110 unique basenames in 110 timestamp dirs. Per-basename pass is
    // a no-op (1 file each). The global pass must drop 11 oldest.
    const recoveryRoot = join(vaultRoot, '.filo', 'recovery');
    await fs.mkdir(recoveryRoot, { recursive: true });

    for (let i = 0; i < 110; i++) {
      const subdir = join(recoveryRoot, `2025-06-01T00-00-${String(i).padStart(3, '0')}`);
      await fs.mkdir(subdir, { recursive: true });
      const file = join(subdir, `file-${String(i).padStart(3, '0')}.board.json`);
      await fs.writeFile(file, `historical-${i}`, 'utf-8');
      const mtime = new Date(2025, 5, 1, 0, 0, i);
      await fs.utimes(file, mtime, mtime);
    }

    // Add one more (the 111th) — total becomes 111 → global pass cuts
    // 11 oldest → 100 remain.
    await fs.writeFile(join(vaultRoot, 'trigger.board.json'), 'fresh', 'utf-8');
    await snapshotForRecovery(vaultRoot, 'trigger.board.json');

    let total = 0;
    const dirs = await fs.readdir(recoveryRoot);
    for (const d of dirs) {
      const entries = await fs.readdir(join(recoveryRoot, d));
      total += entries.length;
    }
    expect(total).toBe(100);

    // The 11 oldest (indices 000..010) are gone.
    for (let i = 0; i <= 10; i++) {
      const subdir = join(
        recoveryRoot,
        `2025-06-01T00-00-${String(i).padStart(3, '0')}`,
      );
      await expect(fs.access(subdir)).rejects.toThrow();
    }
    // Indices 011..109 survive.
    for (let i = 11; i < 110; i++) {
      const subdir = join(
        recoveryRoot,
        `2025-06-01T00-00-${String(i).padStart(3, '0')}`,
      );
      await fs.access(subdir);
    }
  });

  it('case 3 — calling at exactly 100 is idempotent (no churn)', { timeout: 60000 }, async () => {
    // 99 unique basenames. Adding a single fresh snapshot brings the
    // count to exactly 100 — the global pass should short-circuit at
    // the count check WITHOUT removing anything.
    const recoveryRoot = join(vaultRoot, '.filo', 'recovery');
    await fs.mkdir(recoveryRoot, { recursive: true });

    for (let i = 0; i < 99; i++) {
      const subdir = join(
        recoveryRoot,
        `2025-07-01T00-00-${String(i).padStart(3, '0')}`,
      );
      await fs.mkdir(subdir, { recursive: true });
      const file = join(subdir, `file-${String(i).padStart(3, '0')}.board.json`);
      await fs.writeFile(file, `historical-${i}`, 'utf-8');
      const mtime = new Date(2025, 6, 1, 0, 0, i);
      await fs.utimes(file, mtime, mtime);
    }

    await fs.writeFile(join(vaultRoot, 'fresh.board.json'), 'fresh-100', 'utf-8');
    await snapshotForRecovery(vaultRoot, 'fresh.board.json');

    // Count is exactly 100 — the global pass should NOT have pruned any
    // historical entries.
    let total = 0;
    const dirs = await fs.readdir(recoveryRoot);
    for (const d of dirs) {
      const entries = await fs.readdir(join(recoveryRoot, d));
      total += entries.length;
    }
    expect(total).toBe(100);

    // None of the 99 historical entries should have been removed.
    for (let i = 0; i < 99; i++) {
      const subdir = join(
        recoveryRoot,
        `2025-07-01T00-00-${String(i).padStart(3, '0')}`,
      );
      await fs.access(subdir);
    }

    // Calling snapshotForRecovery again should also be a no-op (the
    // count would be 101 → 100, dropping the oldest). Verify the prune
    // is bounded and deterministic.
    await fs.writeFile(join(vaultRoot, 'fresh2.board.json'), 'fresh-101', 'utf-8');
    await snapshotForRecovery(vaultRoot, 'fresh2.board.json');

    let totalAfter = 0;
    for (const d of await fs.readdir(recoveryRoot)) {
      const entries = await fs.readdir(join(recoveryRoot, d));
      totalAfter += entries.length;
    }
    expect(totalAfter).toBe(100);
  });
});

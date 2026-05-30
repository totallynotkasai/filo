import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { snapshotForRecovery } from '../../main/services/recoverySnapshot';

/**
 * Phase 5 (P0-12) regression guard: when the renderer fails to load a
 * vault file (parse / schema-invalid), `snapshotForRecovery` preserves
 * its bytes in `.filo/recovery/<ts>/<basename>` so the original survives
 * any later overwrite. The user can fix the file by hand from that copy.
 */
describe('snapshotForRecovery', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await fs.mkdtemp(join(tmpdir(), 'filo-recovery-'));
    await fs.mkdir(join(vaultRoot, '.filo'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  it('copies the file bytes into .filo/recovery/<ts>/<basename>', async () => {
    const original = '{ broken json — preserved as-is';
    const relPath = 'broken.board.json';
    await fs.writeFile(join(vaultRoot, relPath), original, 'utf-8');

    const destAbs = await snapshotForRecovery(vaultRoot, relPath);
    expect(destAbs).toMatch(/\.filo[\\/]recovery[\\/].+[\\/]broken\.board\.json$/);
    const recovered = await fs.readFile(destAbs, 'utf-8');
    expect(recovered).toBe(original);
  });

  it('preserves nested basenames without recreating the source directory tree', async () => {
    const original = '{ nested broken content';
    const relPath = join('subfolder', 'inner.board.json');
    await fs.mkdir(join(vaultRoot, 'subfolder'), { recursive: true });
    await fs.writeFile(join(vaultRoot, relPath), original, 'utf-8');

    const destAbs = await snapshotForRecovery(vaultRoot, relPath);
    // Destination uses only the basename — there's no benefit to mirroring
    // the source tree; the recovery folder is timestamped so collisions
    // within the same call are limited to genuinely identical basenames.
    expect(destAbs.endsWith('inner.board.json')).toBe(true);
    // The recovery destination must not contain a `subfolder` segment;
    // mirroring would over-engineer the layout for no recovery benefit.
    expect(destAbs.includes(`${'subfolder'}/`) || destAbs.includes(`${'subfolder'}\\`)).toBe(false);
    const recovered = await fs.readFile(destAbs, 'utf-8');
    expect(recovered).toBe(original);
  });

  it('rejects a relativePath that resolves outside the vault root', async () => {
    await expect(
      snapshotForRecovery(vaultRoot, '../escape.txt'),
    ).rejects.toThrow(/Path traversal/);
  });

  /**
   * Phase 23 M22 — long-lived vaults that hit a flaky `.board.json` write
   * window can accumulate dozens of snapshots of the same file before the
   * user notices. The prune step keeps the most recent
   * `MAX_SNAPSHOTS_PER_BASENAME` (=20) per basename and drops the rest;
   * empty timestamp directories are tidied behind it.
   */
  it('prunes old snapshots past the 20-per-basename retention cap', async () => {
    const relPath = 'broken.board.json';
    const sourceAbs = join(vaultRoot, relPath);
    await fs.writeFile(sourceAbs, 'snapshot-source', 'utf-8');

    // Hand-create 25 historical snapshots with monotonically increasing
    // mtimes so we know exactly which 5 must get pruned (the oldest).
    const recoveryRoot = join(vaultRoot, '.filo', 'recovery');
    await fs.mkdir(recoveryRoot, { recursive: true });
    const created: Array<{ subdir: string; file: string }> = [];
    for (let i = 0; i < 25; i++) {
      const subdir = join(recoveryRoot, `2026-01-01T00-00-${String(i).padStart(2, '0')}`);
      await fs.mkdir(subdir, { recursive: true });
      const file = join(subdir, 'broken.board.json');
      await fs.writeFile(file, `historical-${i}`, 'utf-8');
      const mtime = new Date(2026, 0, 1, 0, 0, i);
      await fs.utimes(file, mtime, mtime);
      created.push({ subdir, file });
    }

    // Sanity: 25 copies on disk before snapshot.
    const beforeDirs = await fs.readdir(recoveryRoot);
    expect(beforeDirs).toHaveLength(25);

    // Add one more (the new snapshot the prune is triggered by) → 26 total
    // → 6 oldest get pruned → 20 remain.
    const destAbs = await snapshotForRecovery(vaultRoot, relPath);
    expect(destAbs).toMatch(/\.filo[\\/]recovery[\\/].+[\\/]broken\.board\.json$/);

    const remainingFiles: string[] = [];
    const afterDirs = await fs.readdir(recoveryRoot);
    for (const subdir of afterDirs) {
      const filePath = join(recoveryRoot, subdir, 'broken.board.json');
      try {
        await fs.access(filePath);
        remainingFiles.push(filePath);
      } catch {
        // Subdir doesn't contain the basename — fine.
      }
    }
    expect(remainingFiles).toHaveLength(20);

    // The 5 oldest historical files (indices 0..4) and the freshly created
    // pre-snapshot file with the lowest mtime among the surviving set —
    // actually, since the new snapshot has the *highest* mtime, the prune
    // drops the 6 oldest historical entries (indices 0..5).
    for (let i = 0; i < 6; i++) {
      const subdir = join(recoveryRoot, `2026-01-01T00-00-${String(i).padStart(2, '0')}`);
      // The single-basename subdirs we created should be removed entirely
      // by the empty-dir tidy step.
      await expect(fs.access(subdir)).rejects.toThrow();
    }
    for (let i = 6; i < 25; i++) {
      const subdir = join(recoveryRoot, `2026-01-01T00-00-${String(i).padStart(2, '0')}`);
      await fs.access(subdir);
    }
  });

  /**
   * C9 — when mtimes collide on the millisecond (filesystems with
   * second-level granularity, or simultaneous saves), the prune step
   * tiebreaks by subdirectory path lexicographically. The ISO-8601
   * timestamp subdir name is monotonically sortable, so a deterministic
   * lexicographic tiebreak gives stable retention behaviour.
   */
  it('uses lexicographic tiebreak when mtimes collide', async () => {
    const relPath = 'broken.board.json';
    const sourceAbs = join(vaultRoot, relPath);
    await fs.writeFile(sourceAbs, 'snapshot-source', 'utf-8');

    // Hand-create 25 historical snapshots that ALL share the same mtime —
    // older than "now" so they all sort BEFORE the freshly-written snapshot.
    // Without a tiebreak the colliding-mtime sort is implementation-defined;
    // with the lexicographic tiebreak the prune drops the smallest names
    // (indices 00..05) first.
    const recoveryRoot = join(vaultRoot, '.filo', 'recovery');
    await fs.mkdir(recoveryRoot, { recursive: true });
    const sharedMtime = new Date(2020, 0, 1, 12, 0, 0);
    for (let i = 0; i < 25; i++) {
      const subdir = join(recoveryRoot, `2020-01-01T12-00-00-${String(i).padStart(2, '0')}`);
      await fs.mkdir(subdir, { recursive: true });
      const file = join(subdir, 'broken.board.json');
      await fs.writeFile(file, `historical-${i}`, 'utf-8');
      await fs.utimes(file, sharedMtime, sharedMtime);
    }

    // Trigger the prune via a 26th snapshot. The new snapshot's mtime is
    // "now", well after sharedMtime, so it lands last in the sort.
    await snapshotForRecovery(vaultRoot, relPath);

    // The 6 lexicographically-smallest historical names (indices 00..05)
    // get pruned. The 19 newer-named historical ones (06..24) survive,
    // plus the just-written snapshot → 20 total.
    for (let i = 0; i < 6; i++) {
      const subdir = join(recoveryRoot, `2020-01-01T12-00-00-${String(i).padStart(2, '0')}`);
      await expect(fs.access(subdir)).rejects.toThrow();
    }
    for (let i = 6; i < 25; i++) {
      const subdir = join(recoveryRoot, `2020-01-01T12-00-00-${String(i).padStart(2, '0')}`);
      await fs.access(subdir);
    }
  });

  /**
   * IMPL_PLAN_2026-05-23_v2 P2.8 — when the prune step's `readdir` on the
   * recovery root fails with anything other than ENOENT (notably EACCES on
   * a network-share vault with restrictive permissions), surface it through
   * `logMainError` so the operator sees that snapshots are accumulating
   * unboundedly. The fresh snapshot itself still succeeds; tidy-up failure
   * is non-fatal.
   */
  it('logs the prune failure when readdir(.filo/recovery) fails with non-ENOENT', async () => {
    const relPath = 'broken.board.json';
    await fs.writeFile(join(vaultRoot, relPath), 'snapshot-source', 'utf-8');
    // Pre-create the recovery dir so the snapshot's own writes land there.
    const recoveryRoot = join(vaultRoot, '.filo', 'recovery');
    await fs.mkdir(recoveryRoot, { recursive: true });

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const readdirSpy = vi.spyOn(fs, 'readdir').mockImplementation(((async (p: unknown) => {
      // Only intercept the prune's recovery-root walk; let any other readdir
      // (e.g. atomicWriteFile's directory fsync probe) pass through.
      if (typeof p === 'string' && p.endsWith(join('.filo', 'recovery'))) {
        const err: NodeJS.ErrnoException = Object.assign(
          new Error('permission denied'),
          { code: 'EACCES' },
        );
        throw err;
      }
      const real = (await vi.importActual<typeof import('fs')>('fs')).promises.readdir;
      return real(p as never);
    }) as unknown) as typeof fs.readdir);

    try {
      const destAbs = await snapshotForRecovery(vaultRoot, relPath);
      // Fresh snapshot still succeeded — tidy-up failure does not abort.
      expect(destAbs).toMatch(/\.filo[\\/]recovery[\\/].+[\\/]broken\.board\.json$/);
      const recovered = await fs.readFile(destAbs, 'utf-8');
      expect(recovered).toBe('snapshot-source');

      // The prune failure surfaced through logMainError → console.error.
      // Look for the [recovery:snapshot:prune] subsystem tag.
      const calls = errSpy.mock.calls.map((c) => c.map(String).join(' '));
      expect(calls.some((s) => s.includes('[recovery:snapshot:prune]'))).toBe(true);
    } finally {
      readdirSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  /**
   * Phase 9.7 — even with per-basename pruning, a vault hit by a wide
   * multi-file corruption (one bad sync run touching 50+ boards) could
   * accumulate hundreds of recovery snapshots across different basenames.
   * After the per-basename prune runs, a global second pass walks every
   * timestamp subdir and drops the oldest files until the total count is
   * back under `MAX_SNAPSHOTS_TOTAL`. Sprint C / C19 lowered the cap
   * from 200 to 100.
   */
  it('caps total snapshots across all basenames at 100', async () => {
    const recoveryRoot = join(vaultRoot, '.filo', 'recovery');
    await fs.mkdir(recoveryRoot, { recursive: true });

    // Plant 110 historical snapshots spread across 110 unique basenames.
    // Each lives in its own timestamp subdir so per-basename pruning is a
    // no-op (1 file each); the global pass must do the cleanup.
    for (let i = 0; i < 110; i++) {
      const subdir = join(recoveryRoot, `2025-06-01T00-00-${String(i).padStart(3, '0')}`);
      await fs.mkdir(subdir, { recursive: true });
      const file = join(subdir, `file-${String(i).padStart(3, '0')}.board.json`);
      await fs.writeFile(file, `historical-${i}`, 'utf-8');
      const mtime = new Date(2025, 5, 1, 0, 0, i);
      await fs.utimes(file, mtime, mtime);
    }

    // Snapshot one more file (the 111th) — the per-basename pass is a no-op
    // (only one snapshot of `trigger.board.json`); the global pass must
    // bring the total back down to 100.
    await fs.writeFile(join(vaultRoot, 'trigger.board.json'), 'fresh', 'utf-8');
    await snapshotForRecovery(vaultRoot, 'trigger.board.json');

    // Walk every subdir and count surviving files.
    const dirs = await fs.readdir(recoveryRoot);
    let total = 0;
    for (const d of dirs) {
      const entries = await fs.readdir(join(recoveryRoot, d));
      total += entries.length;
    }
    expect(total).toBe(100);

    // The 11 oldest historical snapshots (indices 000..010) should be gone;
    // 011..109 remain (99) plus the fresh trigger (1) = 100.
    for (let i = 0; i <= 10; i++) {
      const subdir = join(recoveryRoot, `2025-06-01T00-00-${String(i).padStart(3, '0')}`);
      await expect(fs.access(subdir)).rejects.toThrow();
    }
    for (let i = 11; i < 110; i++) {
      const subdir = join(recoveryRoot, `2025-06-01T00-00-${String(i).padStart(3, '0')}`);
      await fs.access(subdir);
    }
  });

  it('does NOT log when readdir(.filo/recovery) fails with ENOENT (benign)', async () => {
    // No `.filo/recovery` exists in this vault yet; the first snapshot
    // will create it. The prune-side readdir would fail with ENOENT
    // BEFORE the snapshot's ensureDir runs, but `pruneOldSnapshotsForBasename`
    // runs AFTER the write, so by then ensureDir created `.filo/recovery`
    // and the readdir succeeds. Verify no `[recovery:snapshot:prune]`
    // error fires on a clean first-snapshot path.
    const relPath = 'broken.board.json';
    await fs.writeFile(join(vaultRoot, relPath), 'snapshot-source', 'utf-8');

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await snapshotForRecovery(vaultRoot, relPath);
      const calls = errSpy.mock.calls.map((c) => c.map(String).join(' '));
      expect(calls.some((s) => s.includes('[recovery:snapshot:prune]'))).toBe(false);
    } finally {
      errSpy.mockRestore();
    }
  });
});

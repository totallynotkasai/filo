import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  snapshotForRecovery,
  listRecoverySnapshots,
} from '../../main/services/recoverySnapshot';

/**
 * `listRecoverySnapshots` surfaces preserved `.filo/recovery/` snapshots to the
 * renderer on vault open WITHOUT pruning them. Read-only: the user's safety net
 * is only removed when they act on it (reveal → recover / delete) or the
 * write-time cap trims the oldest.
 */
describe('listRecoverySnapshots', () => {
  let vaultRoot: string;

  beforeEach(async () => {
    vaultRoot = await fs.mkdtemp(join(tmpdir(), 'filo-recovery-list-'));
    await fs.mkdir(join(vaultRoot, '.filo'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  it('returns [] when no recovery directory exists', async () => {
    expect(await listRecoverySnapshots(vaultRoot)).toEqual([]);
  });

  it('lists each preserved snapshot with basename, timestamp, and forward-slashed relPath', async () => {
    await fs.writeFile(join(vaultRoot, 'Notes.board.json'), '{ broken', 'utf-8');
    await snapshotForRecovery(vaultRoot, 'Notes.board.json');

    const list = await listRecoverySnapshots(vaultRoot);
    expect(list).toHaveLength(1);
    expect(list[0].basename).toBe('Notes.board.json');
    // ISO-ish timestamp subdir name (`:` swapped for `-`).
    expect(list[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Vault-relative, forward-slashed, never a backslash even on Windows.
    expect(list[0].relPath).toMatch(/^\.filo\/recovery\/.+\/Notes\.board\.json$/);
    expect(list[0].relPath).not.toContain('\\');
  });

  it('does not prune — the snapshots remain on disk after listing', async () => {
    await fs.writeFile(join(vaultRoot, 'a.board.json'), '{ broken a', 'utf-8');
    await snapshotForRecovery(vaultRoot, 'a.board.json');

    const before = await listRecoverySnapshots(vaultRoot);
    const after = await listRecoverySnapshots(vaultRoot);
    expect(after).toEqual(before);
    expect(after).toHaveLength(1);
  });

  it('excludes Filo sentinel basenames from the listing', async () => {
    // Plant a recovery subdir holding sentinel-named files alongside a real
    // preserved snapshot. (A sentinel can land here, e.g. via the forensic
    // `.dirty` copy path.) The listing must surface only the user file — a
    // `.dirty` / `*-pending.json` is not a recoverable document.
    const ts = '2026-06-02T10-00-00.000';
    const dir = join(vaultRoot, '.filo', 'recovery', ts);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, '.dirty.aaaaaaaaaaaa'), '{}', 'utf-8');
    await fs.writeFile(join(dir, 'tag-rewrite-pending.aaaaaaaaaaaa.json'), '{}', 'utf-8');
    await fs.writeFile(join(dir, 'rename-cascade-pending.aaaaaaaaaaaa.json'), '{}', 'utf-8');
    await fs.writeFile(join(dir, 'quit-failure.aaaaaaaaaaaa.json'), '{}', 'utf-8');
    await fs.writeFile(join(dir, 'Notes.board.json'), '{ broken', 'utf-8');

    const list = await listRecoverySnapshots(vaultRoot);
    expect(list.map((s) => s.basename)).toEqual(['Notes.board.json']);
  });

  it('orders newest-first across distinct timestamp subdirs', async () => {
    // Two snapshots of different basenames land in different timestamp dirs.
    await fs.writeFile(join(vaultRoot, 'first.board.json'), '{ first', 'utf-8');
    await snapshotForRecovery(vaultRoot, 'first.board.json');
    // Force a distinct timestamp subdir (ms-resolution names collide otherwise
    // only within the same millisecond).
    await new Promise((r) => setTimeout(r, 5));
    await fs.writeFile(join(vaultRoot, 'second.board.json'), '{ second', 'utf-8');
    await snapshotForRecovery(vaultRoot, 'second.board.json');

    const list = await listRecoverySnapshots(vaultRoot);
    expect(list).toHaveLength(2);
    // Newest (lexically-greatest timestamp dir) first.
    expect(list[0].timestamp >= list[1].timestamp).toBe(true);
    expect(list.map((s) => s.basename).sort()).toEqual([
      'first.board.json',
      'second.board.json',
    ]);
  });
});

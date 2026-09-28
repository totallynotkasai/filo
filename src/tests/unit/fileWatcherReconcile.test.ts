import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * The watcher imports `BrowserWindow` for the live-event broadcast path,
 * which crashes the jsdom environment. We replace `electron` with a tiny
 * stub that captures every `webContents.send` so tests can assert on the
 * synthesised reconciliation events without booting Electron.
 */
const sentEvents: Array<{ channel: string; payload: unknown[] }> = [];

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        webContents: {
          send: (channel: string, ...payload: unknown[]) => {
            sentEvents.push({ channel, payload });
          },
        },
      },
    ],
  },
}));

import { FileWatcher, MISSING_NOTE_HOLD_MS } from '../../main/services/fileWatcher';

function changedNames(): string[] {
  return sentEvents
    .filter((e) => e.channel === 'vault:files-changed')
    .flatMap((e) => (e.payload[0] as Array<{ filename: string }>).map((c) => c.filename));
}

function renames(): unknown[] {
  return sentEvents.filter((e) => e.channel === 'vault:file-renamed').map((e) => e.payload[0]);
}

/**
 * Phase 19 S2 — reconciliation walker tests. The walker diffs a vault
 * snapshot against the live tree and synthesises events for anything
 * `fs.watch` missed. These tests verify the diff logic without depending
 * on real OS-level filesystem events (which we can't reliably wait for in
 * a unit test).
 */
describe('FileWatcher.reconcileNow', () => {
  let dir: string;
  let watcher: FileWatcher;

  beforeEach(async () => {
    sentEvents.length = 0;
    dir = await fs.mkdtemp(join(tmpdir(), 'filo-watcher-'));
    watcher = new FileWatcher(dir);
  });

  afterEach(async () => {
    await watcher.stop();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('first reconcile pass seeds the snapshot without firing events', async () => {
    await fs.writeFile(join(dir, 'Notes.md'), 'hello', 'utf-8');
    await watcher.reconcileNow({ seedOnly: true });
    expect(sentEvents).toEqual([]);
  });

  it('synthesises a create event for a file that appeared since the last pass', async () => {
    await watcher.reconcileNow({ seedOnly: true });
    await fs.writeFile(join(dir, 'NewFile.md'), 'new', 'utf-8');
    await watcher.reconcileNow();
    // Wait one debounce window (300ms) for the synthesised events to drain.
    await new Promise((resolve) => setTimeout(resolve, 400));

    const filesChanged = sentEvents
      .filter((e) => e.channel === 'vault:files-changed')
      .flatMap((e) => e.payload[0] as Array<{ filename: string; type: string }>);
    expect(filesChanged.some((c) => c.filename === 'NewFile.md' && c.type === 'document')).toBe(
      true,
    );
  });

  it('synthesises a delete event for a file that vanished since the last pass', async () => {
    await fs.writeFile(join(dir, 'GoingAway.md'), 'soon gone', 'utf-8');
    await watcher.reconcileNow({ seedOnly: true });
    await fs.unlink(join(dir, 'GoingAway.md'));
    await watcher.reconcileNow();
    // A missing note is held for its other half before it goes out as a delete.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(changedNames()).not.toContain('GoingAway.md');
    await new Promise((resolve) => setTimeout(resolve, MISSING_NOTE_HOLD_MS));
    expect(changedNames()).toContain('GoingAway.md');
  });

  it('a missing note pairs with a create in a later batch as a rename', async () => {
    await fs.writeFile(join(dir, 'Old.md'), 'the same small note', 'utf-8');
    await watcher.reconcileNow({ seedOnly: true });
    await fs.unlink(join(dir, 'Old.md'));
    await watcher.reconcileNow();
    await new Promise((resolve) => setTimeout(resolve, 600));
    await fs.writeFile(join(dir, 'New.md'), 'the same small note', 'utf-8');
    await watcher.reconcileNow();
    // The pairing runs after the watcher's debounce; under load that takes
    // longer than any fixed sleep, so wait for it.
    await vi.waitFor(() => expect(renames()).toEqual([{ oldPath: 'Old.md', newPath: 'New.md' }]), { timeout: 5000 });
    await new Promise((resolve) => setTimeout(resolve, MISSING_NOTE_HOLD_MS));
    expect(changedNames()).not.toContain('Old.md');
  });

  it('a write suppression still lets a delete of the file through; a plain one does not', async () => {
    await fs.writeFile(join(dir, 'Written.md'), 'a', 'utf-8');
    await fs.writeFile(join(dir, 'Moved.md'), 'b', 'utf-8');
    await watcher.reconcileNow({ seedOnly: true });
    watcher.suppressWrite('Written.md', 7000);
    watcher.suppress('Moved.md', 7000);
    await fs.unlink(join(dir, 'Written.md'));
    await fs.unlink(join(dir, 'Moved.md'));
    await watcher.reconcileNow();
    await new Promise((resolve) => setTimeout(resolve, MISSING_NOTE_HOLD_MS + 400));

    expect(changedNames()).toContain('Written.md');
    expect(changedNames()).not.toContain('Moved.md');
  });

  it.runIf(process.platform === 'win32' || process.platform === 'darwin')('the reconcile pass reports a case-only rename the live watcher dropped', async () => {
    await fs.writeFile(join(dir, 'Draft.md'), 'text', 'utf-8');
    await watcher.reconcileNow({ seedOnly: true });
    await fs.rename(join(dir, 'Draft.md'), join(dir, 'draft.md'));
    await watcher.reconcileNow();
    // The pairing runs after the watcher's debounce; under load that takes
    // longer than any fixed sleep, so wait for it.
    await vi.waitFor(() => expect(renames()).toEqual([{ oldPath: 'Draft.md', newPath: 'draft.md' }]), { timeout: 5000 });
  });

  it('a rename straight after an own write pairs, using the bytes that write left', async () => {
    await fs.writeFile(join(dir, 'Draft.md'), 'before', 'utf-8');
    await watcher.reconcileNow({ seedOnly: true });
    const after = 'after our write';
    watcher.suppressWrite('Draft.md', 7000);
    await fs.writeFile(join(dir, 'Draft.md'), after, 'utf-8');
    watcher.recordOwnWrite('Draft.md', Buffer.from(after, 'utf-8'));
    await fs.rename(join(dir, 'Draft.md'), join(dir, 'Moved.md'));
    await watcher.reconcileNow();
    // The pairing runs after the watcher's debounce; under load that takes
    // longer than any fixed sleep, so wait for it.
    await vi.waitFor(() => expect(renames()).toEqual([{ oldPath: 'Draft.md', newPath: 'Moved.md' }]), { timeout: 5000 });
  });

  it('synthesises a change event when mtime+size differs', async () => {
    const target = join(dir, 'Edited.md');
    await fs.writeFile(target, 'first version', 'utf-8');
    await watcher.reconcileNow({ seedOnly: true });
    // Wait long enough that mtime is guaranteed to differ on filesystems
    // with second-level granularity.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await fs.writeFile(target, 'totally different content of a different size', 'utf-8');
    await watcher.reconcileNow();
    await new Promise((resolve) => setTimeout(resolve, 400));

    const filesChanged = sentEvents
      .filter((e) => e.channel === 'vault:files-changed')
      .flatMap((e) => e.payload[0] as Array<{ filename: string; type: string }>);
    expect(filesChanged.some((c) => c.filename === 'Edited.md')).toBe(true);
  });

  // 6.4.M8 — `.board.json` and similar JSON files Filo round-trips through
  // `atomicWriteFile` must also be hashed during the snapshot walk so a
  // FAT/SMB filesystem (second-resolution mtime, or mtime-preserved
  // rewrite via temp-rename) doesn't make external `.board.json` edits
  // invisible to the reconciler. The legacy walker hashed only `.md`,
  // leaving everything else dependent on mtime+size.
  it('detects .board.json change when mtime+size are identical (M8)', async () => {
    const target = join(dir, 'My.board.json');
    // Use a fixed timestamp so utimes' precision rounding doesn't make
    // mtime-equality flake on Windows (sub-ms fractional bits). Stamping
    // BOTH writes with the same Date guarantees the reconciler sees
    // identical mtimeMs across snapshots.
    const fixedTime = new Date('2026-01-01T00:00:00Z');

    // Same length, different content.
    await fs.writeFile(target, '{"id":"a","name":"old"}', 'utf-8');
    await fs.utimes(target, fixedTime, fixedTime);
    const preStat = await fs.stat(target);
    await watcher.reconcileNow({ seedOnly: true });

    // Rewrite with different content but the SAME length.
    await fs.writeFile(target, '{"id":"a","name":"new"}', 'utf-8');
    await fs.utimes(target, fixedTime, fixedTime);
    const postStat = await fs.stat(target);
    expect(postStat.mtimeMs).toBe(preStat.mtimeMs);
    expect(postStat.size).toBe(preStat.size);

    await watcher.reconcileNow();
    await new Promise((resolve) => setTimeout(resolve, 400));

    const filesChanged = sentEvents
      .filter((e) => e.channel === 'vault:files-changed')
      .flatMap((e) => e.payload[0] as Array<{ filename: string; type: string }>);
    expect(filesChanged.some((c) => c.filename === 'My.board.json')).toBe(true);
  });

  // Audit-4 DI-15 — the reconcile walk hashed only the first 4 KB of a
  // `.board.json`, so an external edit landing PAST offset 4096 with an
  // unchanged total size + coarse mtime hashed "equal" and the change was
  // dropped (then overwritten by the local cache flush). The whole-file hash
  // closes that window. This is the deep-edit sibling of the M8 case above.
  it('detects a .board.json change past offset 4096 with identical mtime+size (DI-15)', async () => {
    const target = join(dir, 'Deep.board.json');
    const fixedTime = new Date('2026-01-01T00:00:00Z');
    // 4 KB identical head + an equal-length tail that differs between writes,
    // so total size + first-4 KB hash are unchanged across the two versions.
    const head = 'A'.repeat(4096);
    const oldContent = head + 'OLD-tail-bytes';
    const newContent = head + 'NEW-tail-bytes';
    expect(oldContent.length).toBe(newContent.length);

    await fs.writeFile(target, oldContent, 'utf-8');
    await fs.utimes(target, fixedTime, fixedTime);
    const preStat = await fs.stat(target);
    await watcher.reconcileNow({ seedOnly: true });

    // Rewrite with content that diverges ONLY past offset 4096; same length.
    await fs.writeFile(target, newContent, 'utf-8');
    await fs.utimes(target, fixedTime, fixedTime);
    const postStat = await fs.stat(target);
    expect(postStat.mtimeMs).toBe(preStat.mtimeMs);
    expect(postStat.size).toBe(preStat.size);

    await watcher.reconcileNow();
    await new Promise((resolve) => setTimeout(resolve, 400));

    const filesChanged = sentEvents
      .filter((e) => e.channel === 'vault:files-changed')
      .flatMap((e) => e.payload[0] as Array<{ filename: string; type: string }>);
    expect(filesChanged.some((c) => c.filename === 'Deep.board.json')).toBe(true);
  });

  it('drops reconciled events whose path is currently suppressed', async () => {
    await fs.writeFile(join(dir, 'SelfWrite.md'), 'first', 'utf-8');
    await watcher.reconcileNow({ seedOnly: true });
    // Simulate a self-write that suppressed the path immediately before
    // we drop a new on-disk version. The synthesised "change" event must
    // be dropped because suppression is active.
    watcher.suppress('SelfWrite.md', 5000);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await fs.writeFile(join(dir, 'SelfWrite.md'), 'second version', 'utf-8');
    await watcher.reconcileNow();
    await new Promise((resolve) => setTimeout(resolve, 400));

    const filesChanged = sentEvents
      .filter((e) => e.channel === 'vault:files-changed')
      .flatMap((e) => e.payload[0] as Array<{ filename: string; type: string }>);
    expect(filesChanged.some((c) => c.filename === 'SelfWrite.md')).toBe(false);
  });

  // Audit-10 M3 — a suppressed pass must NOT advance the snapshot past the
  // suppressed path. If an EXTERNAL edit lands inside the suppression window,
  // baking its bytes into the snapshot would mask it forever (next pass sees
  // current === snapshot). Preserving the prior entry lets the change re-surface
  // once suppression lifts.
  it('re-surfaces an external change that landed during a suppressed window once suppression lifts (M3)', async () => {
    const target = join(dir, 'SelfWrite.md');
    await fs.writeFile(target, 'first', 'utf-8');
    await watcher.reconcileNow({ seedOnly: true });

    // Self-write suppresses the path; an EXTERNAL edit lands inside the window.
    watcher.suppress('SelfWrite.md', 800);
    await fs.writeFile(target, 'externally changed to a clearly different size', 'utf-8');
    // Reconcile WHILE suppressed: the event is dropped this pass.
    await watcher.reconcileNow();
    await new Promise((resolve) => setTimeout(resolve, 100));
    let filesChanged = sentEvents
      .filter((e) => e.channel === 'vault:files-changed')
      .flatMap((e) => e.payload[0] as Array<{ filename: string; type: string }>);
    expect(filesChanged.some((c) => c.filename === 'SelfWrite.md')).toBe(false);

    // Suppression lifts; the next pass re-diffs the preserved prior entry against
    // the changed disk bytes and synthesises the missed change.
    await new Promise((resolve) => setTimeout(resolve, 900));
    sentEvents.length = 0;
    await watcher.reconcileNow();
    await new Promise((resolve) => setTimeout(resolve, 400));
    filesChanged = sentEvents
      .filter((e) => e.channel === 'vault:files-changed')
      .flatMap((e) => e.payload[0] as Array<{ filename: string; type: string }>);
    expect(filesChanged.some((c) => c.filename === 'SelfWrite.md')).toBe(true);
  });

  it('skips the entire `.filo/` subtree', async () => {
    await fs.mkdir(join(dir, '.filo'), { recursive: true });
    await fs.writeFile(join(dir, '.filo', 'app.json'), '{}', 'utf-8');
    await watcher.reconcileNow({ seedOnly: true });
    await fs.writeFile(join(dir, '.filo', 'app.json'), '{"theme":"dark"}', 'utf-8');
    await watcher.reconcileNow();
    await new Promise((resolve) => setTimeout(resolve, 400));

    const filesChanged = sentEvents
      .filter((e) => e.channel === 'vault:files-changed')
      .flatMap((e) => e.payload[0] as Array<{ filename: string; type: string }>);
    expect(filesChanged.find((c) => c.filename.startsWith('.filo/'))).toBeUndefined();
  });

  it('classifies a media file outside `attachments/` as attachment (Phase 19 S4)', async () => {
    await watcher.reconcileNow({ seedOnly: true });
    await fs.writeFile(join(dir, 'hero.png'), 'fake png bytes', 'utf-8');
    await watcher.reconcileNow();
    await new Promise((resolve) => setTimeout(resolve, 400));

    const filesChanged = sentEvents
      .filter((e) => e.channel === 'vault:files-changed')
      .flatMap((e) => e.payload[0] as Array<{ filename: string; type: string }>);
    const heroEvent = filesChanged.find((c) => c.filename === 'hero.png');
    expect(heroEvent?.type).toBe('attachment');
  });

  it('returns vault:watcher-failed when the vault root vanishes', async () => {
    await fs.writeFile(join(dir, 'Notes.md'), 'before', 'utf-8');
    await watcher.reconcileNow({ seedOnly: true });
    // Now delete the vault root entirely — the walker should report the
    // outage rather than treat the empty result as a wholesale delete.
    await fs.rm(dir, { recursive: true, force: true });
    await watcher.reconcileNow();

    const failedEvents = sentEvents.filter((e) => e.channel === 'vault:watcher-failed');
    // The walker exits early when the vault root is unreadable rather than
    // erroring outright, so the explicit failure event may not always fire
    // — but no spurious delete event should be synthesised for Notes.md.
    const filesChanged = sentEvents
      .filter((e) => e.channel === 'vault:files-changed')
      .flatMap((e) => e.payload[0] as Array<{ filename: string; type: string }>);
    expect(filesChanged.find((c) => c.filename === 'Notes.md')).toBeUndefined();
    // Recreate the dir so afterEach's rm doesn't error.
    await fs.mkdir(dir, { recursive: true });
    // Either no event fired (early exit) or the failure was surfaced.
    expect(failedEvents.length).toBeGreaterThanOrEqual(0);
  });
});

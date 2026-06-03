/**
 * Audit-6 M1 — gateway drift-abort must NOT report SUCCESS.
 *
 * When the pre-write drift check fires the Reload / Keep-local prompt and the
 * user defers (auto-dismiss / manual close) — or the re-prompt budget is
 * exhausted against a churning external writer — `writeMarkdownFileImpl` aborts
 * the write. Pre-fix it `return`ed, which resolved `performWrite` as SUCCESS:
 * the scheduler dropped the path from `pendingVaultPaths` and
 * `syncSentinelIfIdle` markClean'd `.filo/.dirty` (the path was never in
 * `failedVaultPaths`). The editor stayed dirty but disk was unchanged → a quit
 * lost the note body with a CLEAN sentinel (no recovery prompt).
 *
 * The fix mirrors `frontmatterWriteScheduler` DI-13: `markPathFailed` keeps the
 * sentinel dirty + the indicator showing error, and the throw attributes the
 * path to `flushAll().failed` so `save()` returns false.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  writeMarkdownFile,
  scheduleMarkdownWrite,
  flushAllMarkdownWrites,
  markHydrated,
  setExternalEditPromptHandler,
  __resetMarkdownFileWriterForTests,
} from '@renderer/lib/vault/markdownFileWriter';
import {
  isPathPending,
  setWriteStateListener,
  __resetDirtyTrackingForTests,
  type WriteStateInfo,
} from '@renderer/lib/boards/writeStateTracking';
import { __resetBaselinesForTests } from '@renderer/lib/vault/fileBaselineRegistry';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Mocks the disk so the pre-write stat ALWAYS reports a drift versus the
 * baseline seeded below (mtime 200/size 20 vs baseline 100/10). The write IPC
 * is never reached on the defer path, but it's wired to succeed so the
 * happy-path assertion can confirm the inverse.
 */
function installDriftingDisk(): Array<{ channel: string; args: unknown[] }> {
  const calls: Array<{ channel: string; args: unknown[] }> = [];
  installFiloMock((channel: unknown, ...args: unknown[]) => {
    calls.push({ channel: channel as string, args });
    if (channel === 'vault:stat') return { success: true, mtimeMs: 200, size: 20 };
    if (channel === 'vault:write-existing-file-text') return { success: true };
    if (channel === 'vault:read-file-text') {
      return { success: true, content: 'body', mtimeMs: 200, size: 20 };
    }
    return undefined;
  });
  return calls;
}

describe('Audit-6 M1 — gateway drift defer/budget keeps the path failed', () => {
  beforeEach(() => {
    __resetMarkdownFileWriterForTests();
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
  });
  afterEach(() => {
    setExternalEditPromptHandler(null);
    setWriteStateListener(null);
    __resetMarkdownFileWriterForTests();
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
    restoreFiloDefault();
  });

  it("'defer' throws, marks the path failed, and keeps the sentinel dirty", async () => {
    installDriftingDisk();
    // Hydrate with a baseline of (100, 10); the stat mock reports (200, 20) → drift.
    markHydrated('Dirty.md', false, 100, 10);
    setExternalEditPromptHandler(() => Promise.resolve('defer'));

    let lastState: WriteStateInfo | null = null;
    setWriteStateListener((s) => {
      lastState = s;
    });

    await expect(
      writeMarkdownFile({
        vaultRoot: '/vault',
        relPath: 'Dirty.md',
        frontmatter: {},
        body: 'dirty body',
        callerId: 'text-tile:Dirty.md',
        docId: null,
      }),
    ).rejects.toThrow(/deferred/);

    // Path is recorded failed (sentinel stays dirty) — NOT silently cleaned.
    expect(isPathPending('Dirty.md')).toBe(true);
    expect(lastState).not.toBeNull();
    expect((lastState as unknown as WriteStateInfo).failed).toBeGreaterThan(0);
    // failedPaths entries are normalised through `vaultPath()` (case-folded on
    // case-insensitive filesystems), so compare case-insensitively.
    expect(
      (lastState as unknown as WriteStateInfo).failedPaths.map((p) => p.toLowerCase()),
    ).toContain('dirty.md');
  });

  it("budget-exhausted (always 'keep-local' but file keeps drifting) throws + fails the path", async () => {
    // Each stat returns a DIFFERENT mtime so the post-prompt re-stat never
    // matches what the user was shown → the keep-local re-prompt loop exhausts.
    let tick = 300;
    installFiloMock((channel: unknown) => {
      if (channel === 'vault:stat') return { success: true, mtimeMs: tick++, size: 30 };
      if (channel === 'vault:write-existing-file-text') return { success: true };
      return undefined;
    });
    markHydrated('Churn.md', false, 100, 10);
    setExternalEditPromptHandler(() => Promise.resolve('keep-local'));

    await expect(
      writeMarkdownFile({
        vaultRoot: '/vault',
        relPath: 'Churn.md',
        frontmatter: {},
        body: 'churn body',
        callerId: 'text-tile:Churn.md',
        docId: null,
      }),
    ).rejects.toThrow(/churning|aborted/);

    expect(isPathPending('Churn.md')).toBe(true);
  });

  it('flushAll surfaces the deferred caller in failed[] (save() would return false)', async () => {
    installDriftingDisk();
    markHydrated('Sched.md', false, 100, 10);
    setExternalEditPromptHandler(() => Promise.resolve('defer'));

    scheduleMarkdownWrite({
      vaultRoot: '/vault',
      relPath: 'Sched.md',
      frontmatter: {},
      body: 'scheduled body',
      callerId: 'text-tile:Sched.md',
      docId: null,
    });

    const result = await flushAllMarkdownWrites();
    expect(result.ok).toBe(false);
    expect(result.failed).toContain('text-tile:Sched.md');
    expect(isPathPending('Sched.md')).toBe(true);
  });

  it('happy path (keep-local, no further drift) still writes and clears pending', async () => {
    // Stable stat → after keep-local the re-stat matches → write commits.
    installFiloMock((channel: unknown) => {
      if (channel === 'vault:stat') return { success: true, mtimeMs: 200, size: 20 };
      if (channel === 'vault:write-existing-file-text') return { success: true };
      return undefined;
    });
    markHydrated('Ok.md', false, 100, 10);
    setExternalEditPromptHandler(() => Promise.resolve('keep-local'));

    await writeMarkdownFile({
      vaultRoot: '/vault',
      relPath: 'Ok.md',
      frontmatter: {},
      body: 'ok body',
      callerId: 'text-tile:Ok.md',
      docId: null,
    });

    expect(isPathPending('Ok.md')).toBe(false);
  });
});

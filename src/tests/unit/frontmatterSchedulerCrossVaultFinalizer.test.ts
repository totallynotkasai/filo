/**
 * Phase B / B.2 — `frontmatterWriteScheduler` finalizers must guard against
 * vault swap.
 *
 * In-flight writes' `.then`/`.catch` finalizers call `endWrite(vaultRoot,
 * relPath, ok)` with the vaultRoot captured at timer fire time. After a vault
 * swap, `resetFrontmatterScheduler` / `resetWriteTracking` clear the global
 * pending / failed sets and the scheduler's internal in-flight map, but the
 * settled promise's finalizer still runs against the OLD vault. Without a
 * guard:
 *   - `endWrite` mutates the NEW vault's `pendingVaultPaths` /
 *     `failedVaultPaths` global state (dropping a freshly-scheduled entry
 *     on success, or leaking the OLD path into failures on rejection).
 *   - The `.catch` branch calls `inFlightFailures.add(relPath)`, polluting
 *     a subsequent `flushAllPendingFrontmatterWrites` on the new vault.
 *
 * Fix: re-read `vaultStore.path` at finalizer time and skip the endWrite
 * (and the `inFlightFailures.add`) if the vault has swapped since the
 * timer fired.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  scheduleFrontmatterWrite,
  flushAllPendingFrontmatterWrites,
  resetFrontmatterScheduler,
} from '@renderer/lib/boards/frontmatterWriteScheduler';
import {
  resetWriteTracking,
  __resetDirtyTrackingForTests,
} from '@renderer/lib/boards/writeStateTracking';
import { documentStore } from '@renderer/stores/document.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

describe('frontmatterWriteScheduler — cross-vault finalizer (Phase B.2)', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    resetFrontmatterScheduler();
    restoreFiloDefault();
  });
  afterEach(() => {
    __resetDirtyTrackingForTests();
    resetFrontmatterScheduler();
    restoreFiloDefault();
    vi.useRealTimers();
    vaultStore.setPath('');
  });

  it('post-swap rejection does not pollute the new vault flush result', async () => {
    // ── Vault A ───────────────────────────────────────────────────────
    vaultStore.setPath('/vault-A');
    vi.useFakeTimers();

    let rejectA!: (err: unknown) => void;
    const ipcA = new Promise<unknown>((_, rej) => {
      rejectA = rej;
    });
    // 3.3 (Audit-18) — the write now `await`s an on-demand hydrate read before it
    // reaches (and attaches its handler to) this write IPC promise, so the
    // `rejectA(...)` below can fire one microtask BEFORE the write awaits `ipcA`.
    // The write still handles the rejection (via the scheduler's catch); this
    // no-op catch just suppresses the artificial "unhandled rejection" the
    // controlled early reject would otherwise flag (in prod the IPC promise is
    // created + awaited together, so this gap never exists).
    void ipcA.catch(() => {});
    installFiloMock({
      'vault:file-exists': () => true,
      // 3.3 (Audit-18) — writeFrontmatter hydrates on demand + fails loud on a
      // read error; supply a working read mock so the docState write proceeds.
      'vault:read-file-text': () => ({ success: true, content: 'x', mtimeMs: 1, size: 1 }),
      'vault:write-existing-file-text': () => ipcA,
    });

    documentStore.loadDocument({
      filename: 'Notes.md',
      title: 'Notes',
      body: 'vault A body',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter('Notes.md', { vault: 'A', title: 'Notes' });

    scheduleFrontmatterWrite('Notes.md', 'Notes.md');
    // Fire the debounce timer — write enters in-flight.
    vi.advanceTimersByTime(400);
    vi.useRealTimers();

    // ── Vault swap ────────────────────────────────────────────────────
    resetWriteTracking('/vault-A');
    vaultStore.setPath('/vault-B');

    // OLD IPC rejects AFTER the swap. With the bug unfixed, the `.catch`
    // would call `inFlightFailures.add('Notes.md')`, polluting vault B.
    rejectA(new Error('vault A bounced post-swap'));
    // Drain microtasks so the .catch chain runs.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // ── Vault B ───────────────────────────────────────────────────────
    let resolveB!: (val: unknown) => void;
    const ipcB = new Promise((res) => {
      resolveB = res;
    });
    installFiloMock({
      'vault:file-exists': () => true,
      // 3.3 (Audit-18) — writeFrontmatter hydrates on demand + fails loud on a
      // read error; supply a working read mock so the docState write proceeds.
      'vault:read-file-text': () => ({ success: true, content: 'x', mtimeMs: 1, size: 1 }),
      'vault:write-existing-file-text': () => ipcB,
    });

    documentStore.loadDocument({
      filename: 'Notes.md',
      title: 'Notes',
      body: 'vault B body',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter('Notes.md', { vault: 'B', title: 'Notes' });

    vi.useFakeTimers();
    scheduleFrontmatterWrite('Notes.md', 'Notes.md');
    vi.advanceTimersByTime(400);
    vi.useRealTimers();

    const flushPromise = flushAllPendingFrontmatterWrites();
    resolveB({ success: true });

    const result = await flushPromise;
    // Without the fix, vault A's stale `.catch` would have added
    // 'Notes.md' to `inFlightFailures`, surfacing it as a phantom failure
    // for vault B's flush.
    expect(result.failed).toEqual([]);
  });

  it('post-swap success finalizer does not corrupt the new vault tracking sentinel', async () => {
    // Scenario: vault A's IPC RESOLVES (not rejects) after swap. Without
    // the guard, the scheduler's `.then` calls endWrite(vault-A) which
    // deletes 'Notes.md' from the GLOBAL `pendingVaultPaths` — including
    // a freshly-scheduled vault-B entry at the same relPath. The bug:
    // vault B's sentinel becomes "clean" prematurely.
    vaultStore.setPath('/vault-A');
    vi.useFakeTimers();

    let resolveA!: (val: unknown) => void;
    const ipcA = new Promise((res) => {
      resolveA = res;
    });
    installFiloMock({
      'vault:file-exists': () => true,
      // 3.3 (Audit-18) — writeFrontmatter hydrates on demand + fails loud on a
      // read error; supply a working read mock so the docState write proceeds.
      'vault:read-file-text': () => ({ success: true, content: 'x', mtimeMs: 1, size: 1 }),
      'vault:write-existing-file-text': () => ipcA,
    });

    documentStore.loadDocument({
      filename: 'Notes.md',
      title: 'Notes',
      body: 'vault A body',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter('Notes.md', { vault: 'A', title: 'Notes' });

    scheduleFrontmatterWrite('Notes.md', 'Notes.md');
    vi.advanceTimersByTime(400);
    vi.useRealTimers();

    // Vault swap.
    resetWriteTracking('/vault-A');
    vaultStore.setPath('/vault-B');

    // Schedule a vault-B write at the same path — this re-arms the
    // pending/failed sentinel for vault B before the old IPC resolves.
    documentStore.loadDocument({
      filename: 'Notes.md',
      title: 'Notes',
      body: 'vault B body',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter('Notes.md', { vault: 'B', title: 'Notes' });

    let resolveB!: (val: unknown) => void;
    const ipcB = new Promise((res) => {
      resolveB = res;
    });
    installFiloMock({
      'vault:file-exists': () => true,
      // 3.3 (Audit-18) — writeFrontmatter hydrates on demand + fails loud on a
      // read error; supply a working read mock so the docState write proceeds.
      'vault:read-file-text': () => ({ success: true, content: 'x', mtimeMs: 1, size: 1 }),
      'vault:write-existing-file-text': () => ipcB,
    });

    vi.useFakeTimers();
    scheduleFrontmatterWrite('Notes.md', 'Notes.md');
    vi.advanceTimersByTime(400);
    vi.useRealTimers();

    // OLD IPC resolves AFTER the swap. With the bug unfixed, the `.then`
    // would mutate vault B's tracking sets.
    resolveA({ success: true });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Vault B finishes its OWN write.
    const flushPromise = flushAllPendingFrontmatterWrites();
    resolveB({ success: true });
    const result = await flushPromise;

    // No phantom failure attribution from vault A's stale `.then`.
    expect(result.failed).toEqual([]);
  });

  it('same-vault finalizer still updates sentinel (regression guard)', async () => {
    // Sanity check: when the vault doesn't swap, the finalizer runs as
    // before. Without this, the guard could over-fire and break the
    // happy-path sentinel maintenance.
    vaultStore.setPath('/vault-A');
    vi.useFakeTimers();

    installFiloMock({
      'vault:file-exists': () => true,
      // 3.3 (Audit-18) — writeFrontmatter hydrates on demand + fails loud on a
      // read error; supply a working read mock so the docState write proceeds.
      'vault:read-file-text': () => ({ success: true, content: 'x', mtimeMs: 1, size: 1 }),
      'vault:write-existing-file-text': () => ({ success: true }),
    });

    documentStore.loadDocument({
      filename: 'Notes.md',
      title: 'Notes',
      body: 'hello',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter('Notes.md', { vault: 'A', title: 'Notes' });

    scheduleFrontmatterWrite('Notes.md', 'Notes.md');
    vi.advanceTimersByTime(400);
    vi.useRealTimers();

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const result = await flushAllPendingFrontmatterWrites();
    expect(result.failed).toEqual([]);
  });
});

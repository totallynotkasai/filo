/**
 * Phase 1 / 1.4 — `moveIntoFolder` returns a typed `MoveIntoFolderResult`
 * so sidebar drop handlers can distinguish a name collision from a real
 * IO failure. Two surfaces under test:
 *
 *  1. `describeMoveIntoFolderFailure(result, source, target)` formats
 *     human-readable toast copy for each failure code.
 *  2. The end-to-end signature: a `rename` IPC returning
 *     `{ success: false, code: 'TARGET_EXISTS' }` propagates as
 *     `{ ok: false, code: 'TARGET_EXISTS' }` so the caller's toast
 *     dispatch picks the right branch. We exercise this via the slice
 *     factory rather than spinning up `vaultStore` — the slice is a
 *     pure functional unit once you stub the IPC layer.
 */
import { describe, it, expect } from 'vitest';
import {
  basenameOf,
  describeMoveIntoFolderFailure,
} from '@renderer/lib/vault/moveIntoFolderFeedback';
import type { MoveIntoFolderResult } from '@renderer/stores/vaultFolderOps';
import type { VaultContext } from '@renderer/stores/vaultStoreTypes';

/**
 * Builds a VaultContext stub that satisfies the interface but uses
 * inert implementations for every read/write helper. The slice's
 * `moveIntoFolder` only consults a couple of these; the rest are
 * present so the type-checker doesn't complain.
 */
function makeStubCtx(): VaultContext {
  const noop = (): void => {};
  return {
    getVaultPath: () => '/vault',
    setVaultPath: noop,
    getFileTree: () => [],
    setFileTree: noop,
    getSearchQuery: () => '',
    setSearchQuery: noop,
    getIsLoading: () => false,
    setIsLoading: noop,
    getExpandedFolders: () => new Set<string>(),
    setExpandedFolders: noop,
    getSelectedPaths: () => new Set<string>(),
    setSelectedPaths: noop,
    getProject: () => null,
    setProject: noop,
    getRecoveryPendingPaths: () => [],
    setRecoveryPendingPaths: noop,
    resolveRecoveryDismissed: noop,
    markMetaDirty: noop,
    refreshTree: async () => {},
    clearSelection: noop,
    clearActiveRootFolderIfMatches: noop,
  };
}

describe('describeMoveIntoFolderFailure', () => {
  it('names the file and target on a TARGET_EXISTS collision', () => {
    const r: Extract<MoveIntoFolderResult, { ok: false }> = {
      ok: false,
      code: 'TARGET_EXISTS',
    };
    expect(describeMoveIntoFolderFailure(r, 'Notes.md', 'Archive')).toBe(
      'A file named "Notes.md" already exists in "Archive".',
    );
  });

  it('renders a permission-denied message for PERMISSION_DENIED', () => {
    const r: Extract<MoveIntoFolderResult, { ok: false }> = {
      ok: false,
      code: 'PERMISSION_DENIED',
      reason: 'EACCES',
    };
    expect(describeMoveIntoFolderFailure(r, 'Notes.md', 'Archive')).toBe(
      'Permission denied moving "Notes.md" into "Archive".',
    );
  });

  it('falls back to a generic message + raw IPC code on OTHER', () => {
    const r: Extract<MoveIntoFolderResult, { ok: false }> = {
      ok: false,
      code: 'OTHER',
      reason: 'IO_ERROR',
    };
    expect(describeMoveIntoFolderFailure(r, 'Notes.md', 'Archive')).toBe(
      'Couldn\'t move "Notes.md" into "Archive" (IO_ERROR).',
    );
  });

  it('omits the parenthesised detail when no reason is supplied', () => {
    const r: Extract<MoveIntoFolderResult, { ok: false }> = {
      ok: false,
      code: 'OTHER',
    };
    expect(describeMoveIntoFolderFailure(r, 'Notes.md', 'Archive')).toBe(
      'Couldn\'t move "Notes.md" into "Archive".',
    );
  });
});

describe('basenameOf', () => {
  it('extracts the final segment of a POSIX path', () => {
    expect(basenameOf('/vault/Notes/Daily.md')).toBe('Daily.md');
  });

  it('extracts the final segment of a Windows path', () => {
    expect(basenameOf('C:\\vault\\Notes\\Daily.md')).toBe('Daily.md');
  });

  it('returns the original string for a single-segment input', () => {
    expect(basenameOf('Daily.md')).toBe('Daily.md');
  });

  it('skips a trailing separator', () => {
    expect(basenameOf('/vault/Notes/')).toBe('Notes');
    expect(basenameOf('C:\\vault\\Notes\\')).toBe('Notes');
  });

  it('returns the empty string for empty input', () => {
    expect(basenameOf('')).toBe('');
  });
});

/**
 * End-to-end signature regression: a `rename` IPC returning
 * `{ success: false, code: 'TARGET_EXISTS' }` propagates through the
 * slice as `{ ok: false, code: 'TARGET_EXISTS' }`. The slice is
 * constructed with a hand-rolled context whose `rename` stub returns
 * the desired underlying shape — that lets us pin the mapping without
 * mocking the whole vaultStore.
 */
describe('moveIntoFolder — end-to-end Result mapping', () => {
  it('maps TARGET_EXISTS through unchanged', async () => {
    const { makeFolderOpsSlice } = await import('@renderer/stores/vaultFolderOps');
    const ctx = makeStubCtx();
    const slice = makeFolderOpsSlice(ctx);
    // Override the slice's `rename` so the slice's `moveIntoFolder`
    // doesn't try to invoke IPC. Mutating the slice is fine — it's a
    // plain object literal.
    (slice as unknown as { rename: (a: string, b: string) => Promise<unknown> }).rename =
      async () => ({ success: false, code: 'TARGET_EXISTS' });
    const result = await slice.moveIntoFolder('/vault/Notes.md', '/vault/Archive');
    expect(result).toEqual({
      ok: false,
      code: 'TARGET_EXISTS',
      reason: 'TARGET_EXISTS',
    });
  });

  it('maps EACCES → PERMISSION_DENIED', async () => {
    const { makeFolderOpsSlice } = await import('@renderer/stores/vaultFolderOps');
    const ctx = makeStubCtx();
    const slice = makeFolderOpsSlice(ctx);
    (slice as unknown as { rename: (a: string, b: string) => Promise<unknown> }).rename =
      async () => ({ success: false, code: 'EACCES' });
    const result = await slice.moveIntoFolder('/vault/Notes.md', '/vault/Archive');
    expect(result).toEqual({
      ok: false,
      code: 'PERMISSION_DENIED',
      reason: 'EACCES',
    });
  });

  it('maps other rename errors to OTHER', async () => {
    const { makeFolderOpsSlice } = await import('@renderer/stores/vaultFolderOps');
    const ctx = makeStubCtx();
    const slice = makeFolderOpsSlice(ctx);
    (slice as unknown as { rename: (a: string, b: string) => Promise<unknown> }).rename =
      async () => ({ success: false, code: 'IO_ERROR' });
    const result = await slice.moveIntoFolder('/vault/Notes.md', '/vault/Archive');
    expect(result).toEqual({
      ok: false,
      code: 'OTHER',
      reason: 'IO_ERROR',
    });
  });

  it('returns ok: true with the new path on success', async () => {
    const { makeFolderOpsSlice } = await import('@renderer/stores/vaultFolderOps');
    const ctx = makeStubCtx();
    const slice = makeFolderOpsSlice(ctx);
    (slice as unknown as { rename: (a: string, b: string) => Promise<unknown> }).rename =
      async () => ({ success: true });
    const result = await slice.moveIntoFolder('/vault/Notes.md', '/vault/Archive');
    expect(result).toEqual({ ok: true, newPath: '/vault/Archive/Notes.md' });
  });

  it('returns a no-op ok: true result when the file is already in the target folder', async () => {
    const { makeFolderOpsSlice } = await import('@renderer/stores/vaultFolderOps');
    const ctx = makeStubCtx();
    const slice = makeFolderOpsSlice(ctx);
    // No rename stub needed — the no-op short-circuit fires before rename.
    const sourcePath = '/vault/Archive/Notes.md';
    const result = await slice.moveIntoFolder(sourcePath, '/vault/Archive');
    expect(result).toEqual({ ok: true, newPath: sourcePath });
  });
});

/**
 * Audit-4 DI-13 — an orphan frontmatter write (a Kanban / Task field edit with
 * no open editor) whose backing `.md` was deleted out-of-band must surface the
 * loss rather than swallow it.
 *
 * The orphan branch of `writeFrontmatter` hydrates the body fresh from disk; if
 * that read ENOENTs the write can't land. Pre-DI-13 the catch did a bare
 * `return`, so the board cache kept showing the edit while it never reached
 * disk and the save indicator stayed clean. DI-13 calls `markPathFailed` in
 * that catch, so the path lands in the failed set (sticky 'error' in the save
 * indicator) — matching the write-phase ENOENT discipline. The deleted file is
 * still NOT resurrected; the drop is just made visible.
 *
 * Audit5 2.3 (#7) — DI-13's bare `return` still resolved `performWrite` as a
 * SUCCESS, so `flushAllPendingFrontmatterWrites().failed` OMITTED the path and
 * `vaultStore.save()` returned true → Ctrl+S toasted a false "Saved" while the
 * indicator read error and `.dirty` was set. The catch now `throw`s so the
 * failure propagates into the flush result. These tests assert on that return
 * value, not just the transient indicator peak.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  scheduleFrontmatterWrite,
  flushAllPendingFrontmatterWrites,
  resetFrontmatterScheduler,
} from '@renderer/lib/boards/frontmatterWriteScheduler';
import { setWriteStateListener } from '@renderer/lib/boards/writeStateTracking';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/boardSaver';
import { __resetMarkdownFileWriterForTests } from '@renderer/lib/vault/markdownFileWriter';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { parseMarkdown } from '@renderer/lib/vault/vaultIndex';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { documentStore } from '@renderer/stores/document.svelte';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

describe('DI-13 — orphan frontmatter write to a deleted backing file', () => {
  let maxFailed = 0;

  beforeEach(() => {
    __resetMarkdownFileWriterForTests();
    __resetDirtyTrackingForTests();
    resetFrontmatterScheduler();
    vaultIndexStore.clear();
    documentStore.clear();
    vaultStore.setPath('/vault');
    maxFailed = 0;
    setWriteStateListener((info) => {
      maxFailed = Math.max(maxFailed, info.failed);
    });
  });
  afterEach(() => {
    setWriteStateListener(null);
    __resetMarkdownFileWriterForTests();
    __resetDirtyTrackingForTests();
    resetFrontmatterScheduler();
    vaultIndexStore.clear();
    documentStore.clear();
    vaultStore.setPath('');
    restoreFiloDefault();
  });

  it('marks the path failed (save indicator error) instead of silently dropping the edit', async () => {
    const relPath = 'Tasks/orphan.md';
    // Orphan path: docId null, FM sourced from the index. The index still has
    // the file's metadata (the edit scheduled this write), but the backing .md
    // was deleted out-of-band so the hydrate read ENOENTs.
    vaultIndexStore.restoreMetadata(
      relPath,
      parseMarkdown(relPath, '---\nstatus: todo\n---\nbody'),
    );

    installFiloMock({
      'vault:read-file-text': () => ({ success: false, code: 'ENOENT' }),
      'vault:write-existing-file-text': () => ({ success: true }),
      'vault:stat': () => ({ success: false, code: 'ENOENT' }),
    });

    scheduleFrontmatterWrite(relPath, null);
    const result = await flushAllPendingFrontmatterWrites();

    // The deleted-file ENOENT was surfaced as a failed path, not swallowed.
    expect(maxFailed).toBeGreaterThan(0);
    // Audit5 2.3 — and it propagates to the flush result that `save()` folds,
    // so Ctrl+S reports the failure instead of a false "Saved".
    expect(result.failed).toContain(relPath);
  });

  it('a healthy orphan write does NOT mark the path failed (no false positive)', async () => {
    const relPath = 'Tasks/healthy.md';
    vaultIndexStore.restoreMetadata(
      relPath,
      parseMarkdown(relPath, '---\nstatus: todo\n---\nbody'),
    );

    installFiloMock({
      'vault:read-file-text': () => ({
        success: true,
        content: '---\nstatus: todo\n---\nbody',
        mtimeMs: 1000,
        size: 100,
      }),
      'vault:write-existing-file-text': () => ({ success: true }),
      'vault:stat': () => ({ success: true, mtimeMs: 1000, size: 100 }),
    });

    scheduleFrontmatterWrite(relPath, null);
    const result = await flushAllPendingFrontmatterWrites();

    expect(maxFailed).toBe(0);
    // No false positive — a healthy orphan write reports no failure.
    expect(result.failed).toEqual([]);
  });
});

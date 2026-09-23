import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { documentStore } from '@renderer/stores/document.svelte';
import { boardStore } from '@renderer/stores/board.svelte';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { UpdatePropertiesCommand } from '@renderer/commands/index';
import {
  markHydrated,
  scheduleMarkdownWrite,
  flushMarkdownWrite,
  cancelAllMarkdownWrites,
} from '@renderer/lib/vault/markdownFileWriter';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { __resetBaselinesForTests } from '@renderer/lib/vault/fileBaselineRegistry';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * WRITE_PATH_REMEDIATION_PLAN_2026-06-04 Phase 5 — the "missing layer":
 * command/popup → write SEAM round-trips that assert the *bytes on disk*, the
 * layer the engine corpus/fuzz suites structurally cannot reach (they drive the
 * engine with pre-cleaned, pre-truncated objects).
 *
 * Phase 5 enumerates five items. This file closes the two 5.1 seams the Phase 4
 * suite left uncovered; the rest already have dedicated homes (cross-referenced
 * so the whole of Phase 5 is discoverable from one place):
 *
 *   5.1 field edit         → writePathRemediationPhase4.test.ts (Kanban writer:
 *                            empty key / full datetime / comment+order / #1 repro)
 *   5.1 Properties apply   → HERE  (delta path via UpdatePropertiesCommand)
 *   5.1 body save          → HERE  (cache-FM source-preserving path)
 *   5.2 external-then-edit  → writePathRemediationPhase2.test.ts +
 *                            updatePropertiesCommand.test.ts (H2) +
 *                            writePathRemediationPhase4.test.ts (#1 repro)
 *   5.3 malformed-then-edit → writePathRemediationPhase4.test.ts (field seam);
 *                            HERE proves the SECOND delta consumer (Properties)
 *   5.4 quit double-close   → windowCloseDecision.test.ts
 *   5.5 structural gate      → scripts/check-frontmatter-delta-write.mjs (ci gate)
 *
 * The two Properties/body seams both flow into the gateway's TWO distinct write
 * sources — the Properties popup/command rides the delta-on-fresh-disk branch,
 * a body save rides the cache-FM source-preserving branch — so covering them
 * here exercises both halves of the write path, not just the field-edit third.
 */

interface Captured {
  channel: string;
  args: unknown[];
}

function lastWrite(captured: Captured[]): string | undefined {
  for (let i = captured.length - 1; i >= 0; i--) {
    if (captured[i].channel === 'vault:write-existing-file-text') {
      return captured[i].args[2] as string; // (vaultRoot, relPath, fileText)
    }
  }
  return undefined;
}

// ───────────────────────────────────────────────────────────────────────────
// 5.1 — Properties apply seam (the gateway's delta-on-fresh-disk branch).
//
// UpdatePropertiesCommand records the keys it OWNS (those that differ between
// its before/after legs) as a FrontmatterDelta and lets the gateway apply ONLY
// those to a fresh disk read. Every key the popup did not touch — an empty
// `aliases:`, a full datetime, a comment — must survive on disk by construction.
// ───────────────────────────────────────────────────────────────────────────

describe('Phase 5.1 — Properties apply → write round-trip (untouched keys survive bytes on disk)', () => {
  let captured: Captured[];

  /** Installs a recorder whose `.md` on disk is `diskContent` (mtime stable). */
  function installDisk(diskContent: string): void {
    captured = [];
    installFiloMock((channel: unknown, ...args: unknown[]) => {
      captured.push({ channel: channel as string, args });
      if (channel === 'vault:read-file-text') {
        return { success: true, content: diskContent, mtimeMs: 5, size: diskContent.length };
      }
      if (channel === 'vault:stat') return { success: true, mtimeMs: 5, size: diskContent.length };
      if (channel === 'vault:write-existing-file-text') return { success: true };
      return undefined;
    });
  }

  /**
   * Drives a single-key Properties edit on a NOT-open text tile (a Kanban card /
   * Task row seeded once but never opened as a Document tab). No `loadDocument` /
   * `setFrontmatter` → `docState` is null and the command rebases onto a fresh
   * disk read, exactly the real not-open path.
   */
  async function applyPropertyEdit(
    relPath: string,
    docId: string,
    beforeFm: Record<string, unknown>,
    afterFm: Record<string, unknown>,
  ): Promise<void> {
    const cmd = new UpdatePropertiesCommand(
      { kind: 'frontmatter', relPath, docId, fm: beforeFm },
      { kind: 'frontmatter', relPath, docId, fm: afterFm },
    );
    await cmd.execute();
  }

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultIndexStore.clear();
    vaultStore.setPath('/vault');
    captured = [];
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
    boardCacheStore.clear();
    boardStore.clearBoard();
    vaultIndexStore.clear();
    vaultStore.setPath('');
    vi.restoreAllMocks();
  });

  it('preserves a present-but-empty disk key (aliases:) when a different property is edited', async () => {
    installDisk('---\naliases:\npriority: low\n---\nbody\n');

    await applyPropertyEdit('Note.md', 'doc-a', { priority: 'low' }, { priority: 'high' });

    const written = lastWrite(captured)!;
    expect(written).toContain('priority: high'); // the edit landed
    expect(written).toContain('aliases:'); // the empty key was NOT stripped
    expect(written).toContain('body');
  });

  it('preserves a full datetime on an untouched key', async () => {
    installDisk('---\ncreated: 2025-01-15T10:30:00Z\npriority: low\n---\nbody\n');

    await applyPropertyEdit('Event.md', 'doc-b', { priority: 'low' }, { priority: 'high' });

    const written = lastWrite(captured)!;
    expect(written).toContain('created: 2025-01-15T10:30:00Z'); // not truncated to date
    expect(written).toContain('priority: high');
  });

  it('preserves a comment + key order on untouched keys', async () => {
    installDisk('---\n# important note\nzeta: 1\npriority: low\nalpha: 2\n---\nbody\n');

    await applyPropertyEdit('Doc.md', 'doc-c', { priority: 'low' }, { priority: 'high' });

    const written = lastWrite(captured)!;
    expect(written).toContain('# important note'); // comment survived
    expect(written).toContain('zeta: 1');
    expect(written).toContain('alpha: 2');
    expect(written.indexOf('zeta')).toBeLessThan(written.indexOf('alpha')); // order preserved
    expect(written).toContain('priority: high');
  });

  it('preserves an externally-added key the command never saw (5.2 via the Properties seam)', async () => {
    // Disk carries `reviewed: true` an external editor added; the not-open card's
    // cache never learned it. The delta-on-fresh-disk write reads it back.
    installDisk('---\npriority: low\nreviewed: true\n---\nbody\n');

    await applyPropertyEdit('Ext.md', 'doc-d', { priority: 'low' }, { priority: 'high' });

    const written = lastWrite(captured)!;
    expect(written).toContain('priority: high'); // owned key changed
    expect(written).toContain('reviewed: true'); // external key survived
  });

  it('does NOT destroy a malformed frontmatter block on a property edit (5.3 via the Properties seam)', async () => {
    // Tab indentation + duplicate keys → the YAML parser refuses the block. The
    // gateway's delta branch reaches the same keep-raw safety net Finding #4
    // added, so the broken-but-present block is kept verbatim rather than
    // replaced by a dump of just the new key (total-FM-loss class).
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    installDisk('---\n\tbad: yaml\n  dup: 1\n  dup: 2\n---\nbody\n');

    await applyPropertyEdit('Bad.md', 'doc-e', {}, { priority: 'high' });

    const written = lastWrite(captured)!;
    expect(written).toContain('bad: yaml');
    expect(written).toContain('dup: 1');
    expect(written).toContain('body');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 5.1 — body save seam (the gateway's cache-FM source-preserving branch).
//
// A body-only editor save does NOT thread a delta; it rides the cache-FM path,
// which emits the frontmatter from `documentStore.getRawFrontmatter` (verbatim
// when unchanged) or patches the persistent `originalFrontmatterCache` baseline
// source-preservingly when one key was dirtied. Either way every untouched key —
// empty, datetime, comment — must survive the bytes on disk while the new body
// lands.
// ───────────────────────────────────────────────────────────────────────────

describe('Phase 5.1 — body save → write round-trip (untouched keys survive bytes on disk)', () => {
  let captured: Captured[];

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
    vaultIndexStore.clear();
    vaultStore.setPath('/vault');
    captured = [];
    installFiloMock((channel: unknown, ...args: unknown[]) => {
      captured.push({ channel: channel as string, args });
      if (channel === 'vault:stat') return { success: true, ok: true, mtimeMs: 1, size: 1 };
      if (channel === 'vault:write-existing-file-text') return { success: true, ok: true };
      return { success: true, ok: true };
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    restoreFiloDefault();
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
    cancelAllMarkdownWrites();
    documentStore.clear();
    vaultIndexStore.clear();
    vaultStore.setPath('');
    vi.restoreAllMocks();
  });

  it('a clean body-only save emits the FM block verbatim (empty + datetime + comment) and lands the new body', async () => {
    const docId = 'doc-body-1';
    const relPath = 'Notes/Body.md';
    // Seed the live cache from disk WITH the verbatim FM source bytes (what a
    // hydrate does) — the clean signal that lets a body-only save passthrough.
    const rawFm = '# top comment\naliases:\ncreated: 2025-01-15T10:30:00Z\nstatus: draft';
    documentStore.loadDocument({
      docId,
      filename: relPath,
      title: 'Body',
      body: 'old body',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter(
      docId,
      { aliases: null, created: '2025-01-15T10:30:00Z', status: 'draft' },
      rawFm,
    );
    markHydrated(relPath, false);

    // A body keystroke arms a body-only write (frontmatter untouched).
    scheduleMarkdownWrite({
      vaultRoot: '/vault',
      relPath,
      frontmatter: { aliases: null, created: '2025-01-15T10:30:00Z', status: 'draft' },
      body: 'edited body text',
      callerId: `text-tile:${docId}`,
      docId,
    });
    await flushMarkdownWrite(`text-tile:${docId}`);

    const written = lastWrite(captured)!;
    expect(written).toContain('# top comment'); // comment preserved verbatim
    expect(written).toContain('aliases:'); // empty key preserved
    expect(written).toContain('created: 2025-01-15T10:30:00Z'); // full datetime preserved
    expect(written).toContain('status: draft');
    expect(written).toContain('edited body text'); // the new body landed
    expect(written).not.toContain('old body');
  });

  it('a body save after one FM-cache edit preserves the OTHER untouched keys (source-preserving baseline)', async () => {
    const docId = 'doc-body-2';
    const relPath = 'Notes/Mixed.md';
    const rawFm = '# keep me\naliases:\ncreated: 2025-01-15T10:30:00Z';
    documentStore.loadDocument({
      docId,
      filename: relPath,
      title: 'Mixed',
      body: 'old body',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter(
      docId,
      { aliases: null, created: '2025-01-15T10:30:00Z' },
      rawFm,
    );
    markHydrated(relPath, false);

    // One field changes via the cache (e.g. a PropertiesPopup mutation), which
    // drops the verbatim-clean signal but KEEPS the disk baseline. The body
    // write then re-serialises source-preservingly against that baseline.
    documentStore.mergeFrontmatter(docId, { status: 'done' });

    scheduleMarkdownWrite({
      vaultRoot: '/vault',
      relPath,
      frontmatter: documentStore.getFrontmatter(docId) ?? {},
      body: 'new body content',
      callerId: `text-tile:${docId}`,
      docId,
    });
    await flushMarkdownWrite(`text-tile:${docId}`);

    const written = lastWrite(captured)!;
    expect(written).toContain('status: done'); // the cache edit landed
    expect(written).toContain('# keep me'); // untouched comment survived
    expect(written).toContain('aliases:'); // untouched empty key survived
    expect(written).toContain('created: 2025-01-15T10:30:00Z'); // untouched datetime survived
    expect(written).toContain('new body content');
  });
});

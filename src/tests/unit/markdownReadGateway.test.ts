/**
 * Phase 4 / E1 — `readMarkdownForHydrate` is the single disk-read hydrate
 * path (recurrence-proofs F1). These tests pin the invariant that a
 * disk-read hydrate ALWAYS seeds the pre-write drift baseline from the same
 * read's `mtimeMs`, so the writer's drift check can't no-op the way it did
 * before F1.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readMarkdownForHydrate,
  isHydrated,
  __resetMarkdownFileWriterForTests,
} from '@renderer/lib/vault/markdownFileWriter';
import {
  getBaseline,
  __resetBaselinesForTests,
} from '@renderer/lib/vault/fileBaselineRegistry';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/boardSaver';

type InvokeHandler = (...args: unknown[]) => unknown | Promise<unknown>;

function installFiloStub(routes: Record<string, InvokeHandler>): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async (channel: string, ...args: unknown[]) => {
      const handler = routes[channel];
      if (!handler) return { success: true };
      return handler(...args);
    },
    on: () => () => {},
    send: () => {},
  };
}

function uninstallFiloStub(): void {
  delete (window as unknown as Record<string, unknown>).filo;
}

describe('readMarkdownForHydrate — disk-read hydrate gateway', () => {
  beforeEach(() => {
    __resetMarkdownFileWriterForTests();
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
  });
  afterEach(() => {
    __resetMarkdownFileWriterForTests();
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
    uninstallFiloStub();
  });

  it('reads + parses + marks hydrated + seeds the drift baseline atomically', async () => {
    const relPath = 'Notes/a.md';
    installFiloStub({
      'vault:read-file-text': () => ({
        success: true,
        content: '---\ntags: [x]\n---\nHello body',
        mtimeMs: 4242,
        size: 50,
      }),
    });

    // Pre-condition: no baseline, not hydrated.
    expect(getBaseline(relPath)).toBeUndefined();
    expect(isHydrated(relPath)).toBe(false);

    const result = await readMarkdownForHydrate('/vault', relPath);

    // Parsed content surfaced to the caller.
    expect(result.body).toBe('Hello body');
    expect(result.frontmatter.tags).toEqual(['x']);
    expect(result.mtimeMs).toBe(4242);
    expect(result.size).toBe(50);
    expect(result.hadBom).toBe(false);

    // The invariant: hydrate gate set AND baseline (mtime + size) seeded
    // from the SAME read.
    expect(isHydrated(relPath)).toBe(true);
    expect(getBaseline(relPath)).toMatchObject({ mtimeMs: 4242, size: 50 });
  });

  it('records hadBom = true for a BOM-led file', async () => {
    const relPath = 'Notes/bom.md';
    installFiloStub({
      'vault:read-file-text': () => ({
        success: true,
        content: '﻿---\ntitle: T\n---\nBody',
        mtimeMs: 7,
        size: 12,
      }),
    });

    const result = await readMarkdownForHydrate('/vault', relPath);
    expect(result.hadBom).toBe(true);
    expect(getBaseline(relPath)).toMatchObject({ mtimeMs: 7, size: 12 });
  });

  it('propagates a read failure (caller owns the in-memory fallback)', async () => {
    installFiloStub({
      'vault:read-file-text': () => ({ success: false, code: 'ENOENT' }),
    });

    await expect(readMarkdownForHydrate('/vault', 'Notes/missing.md')).rejects.toBeDefined();
    // No baseline seeded on a failed read — the caller's catch decides how to
    // hydrate (or not).
    expect(getBaseline('Notes/missing.md')).toBeUndefined();
  });
});

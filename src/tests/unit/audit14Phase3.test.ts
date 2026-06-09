import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  markHydrated,
  writeMarkdownFile,
  cancelAllMarkdownWrites,
  __resetMarkdownFileWriterForTests,
} from '@renderer/lib/vault/markdownFileWriter';
import { __resetDirtyTrackingForTests, isPathPending } from '@renderer/lib/boards/boardSaver';
import { __resetBaselinesForTests } from '@renderer/lib/vault/fileBaselineRegistry';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { parseMarkdown } from '@renderer/lib/vault/vaultIndex';

/**
 * AUDIT-14 Phase 3 — frontmatter / markdown write edges on the gateway's
 * delta write path (`markdownFileWriter.writeMarkdownFileImpl`):
 *   3.2 — EOL must come from the FRESH in-chain read, not the stale hydrate
 *         `state.eol` snapshot (a LF↔CRLF external conversion since hydrate
 *         otherwise yields a mixed-EOL file).
 *   3.3 — a TRUNCATED/partial in-chain read (opening fence, no closing fence)
 *         must be refused, not assembled into a write that strips the on-disk
 *         frontmatter.
 *
 * (3.1 is covered in `replaceAllCommand.test.ts`; 3.4 is an accepted, drift-
 * stat-bounded micro-TOCTOU documented in the writer.)
 */

interface Captured {
  channel: string;
  args: unknown[];
}

function lastWriteBytes(captured: Captured[]): string | undefined {
  for (let i = captured.length - 1; i >= 0; i--) {
    if (captured[i].channel === 'vault:write-existing-file-text') {
      return captured[i].args[2] as string;
    }
  }
  return undefined;
}

function installFilo(diskContent: string): Captured[] {
  const captured: Captured[] = [];
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async (channel: string, ...args: unknown[]) => {
      captured.push({ channel, args });
      if (channel === 'vault:read-file-text') {
        return { success: true, content: diskContent, mtimeMs: 1, size: diskContent.length };
      }
      if (channel === 'vault:stat') return { success: true, mtimeMs: 1, size: diskContent.length };
      return { success: true, ok: true };
    },
    on: () => () => {},
    send: () => {},
  };
  return captured;
}

describe('AUDIT-14 Phase 3 — delta write EOL + truncation guard', () => {
  beforeEach(() => {
    __resetMarkdownFileWriterForTests();
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
    vaultIndexStore.clear();
  });
  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    cancelAllMarkdownWrites();
    __resetMarkdownFileWriterForTests();
    __resetDirtyTrackingForTests();
    __resetBaselinesForTests();
    vaultIndexStore.clear();
    (window as unknown as Record<string, unknown>).filo = {
      invoke: async () => undefined,
      on: () => () => {},
      send: () => {},
    };
  });

  it('3.2 — derives EOL from the fresh disk read, not the stale hydrate snapshot', async () => {
    const relPath = 'Note.md';
    // Disk was converted to CRLF by an external editor AFTER hydrate.
    const captured = installFilo('---\r\ncompleted: false\r\n---\r\nbody line\r\n');
    // Hydrate recorded LF (now stale). Pass no mtime so no drift baseline is
    // seeded — the drift prompt is irrelevant to this EOL test.
    markHydrated(relPath, false, undefined, undefined, '\n');

    await writeMarkdownFile({
      vaultRoot: '/vault',
      relPath,
      frontmatter: { completed: false },
      body: 'body line\r\n',
      callerId: 'eol-test',
      docId: null,
      frontmatterDelta: { set: { completed: true }, unset: [] },
    });

    const written = lastWriteBytes(captured)!;
    expect(written).toBeDefined();
    expect(written).toContain('completed: true'); // delta applied
    // The FM line carries CRLF (the bite: a stale LF snapshot flips it to LF).
    expect(written).toContain('completed: true\r\n');
    // Whole file is uniformly CRLF — strip every CRLF pair and no lone LF remains.
    expect(written.replace(/\r\n/g, '').includes('\n')).toBe(false);
  });

  it('3.2 — a CRLF→LF external conversion since hydrate yields uniform LF', async () => {
    const relPath = 'Note2.md';
    // Disk is now LF; hydrate had recorded CRLF.
    const captured = installFilo('---\npriority: low\n---\nbody\n');
    markHydrated(relPath, false, undefined, undefined, '\r\n');

    await writeMarkdownFile({
      vaultRoot: '/vault',
      relPath,
      frontmatter: { priority: 'low' },
      body: 'body\n',
      callerId: 'eol-test-2',
      docId: null,
      frontmatterDelta: { set: { priority: 'high' }, unset: [] },
    });

    const written = lastWriteBytes(captured)!;
    expect(written).toContain('priority: high');
    // No CRLF anywhere — the stale CRLF snapshot must NOT re-impose CR bytes.
    expect(written.includes('\r')).toBe(false);
  });

  it('3.3 — refuses a delta write when the fresh read is truncated mid-frontmatter', async () => {
    const relPath = 'Big.md';
    // The index records that this file HAS a frontmatter block.
    vaultIndexStore.restoreMetadata(
      relPath,
      parseMarkdown(relPath, '---\ntitle: real\nstatus: open\n---\nbody\n'),
    );
    // The in-chain read returns TRUNCATED bytes: opening fence, no closing fence
    // (a non-atomic external writer caught mid-write).
    const captured = installFilo('---\ntitle: real\nstatus: o');
    markHydrated(relPath, false);

    await expect(
      writeMarkdownFile({
        vaultRoot: '/vault',
        relPath,
        frontmatter: {},
        body: 'body\n',
        callerId: 'trunc-test',
        docId: null,
        frontmatterDelta: { set: { status: 'closed' }, unset: [] },
      }),
    ).rejects.toThrow(/closing fence|partial read/i);

    // Never wrote — refused to strip the real on-disk frontmatter.
    expect(captured.some((c) => c.channel === 'vault:write-existing-file-text')).toBe(false);
    // Marked failed so `.filo/.dirty` stays set (isPathPending covers failed paths).
    expect(isPathPending(relPath)).toBe(true);
  });

  it('3.3 — still writes when the file genuinely has NO frontmatter (no false positive)', async () => {
    const relPath = 'Plain.md';
    // Index records NO frontmatter for this path (rawFrontmatter is empty).
    vaultIndexStore.restoreMetadata(relPath, parseMarkdown(relPath, 'just a body, no fm\n'));
    const captured = installFilo('just a body, no fm\n');
    markHydrated(relPath, false);

    await writeMarkdownFile({
      vaultRoot: '/vault',
      relPath,
      frontmatter: {},
      body: 'just a body, no fm\n',
      callerId: 'plain-test',
      docId: null,
      frontmatterDelta: { set: { status: 'closed' }, unset: [] },
    });

    // The guard must NOT fire — a real FM-less file writes its new delta key.
    const written = lastWriteBytes(captured)!;
    expect(written).toContain('status: closed');
    expect(isPathPending(relPath)).toBe(false);
  });

  it('3.3 — a legitimate FM removal (no opening fence) is NOT misclassified as truncation', async () => {
    const relPath = 'Removed.md';
    // Index still believes the file had FM (stale)…
    vaultIndexStore.restoreMetadata(
      relPath,
      parseMarkdown(relPath, '---\ntitle: gone\n---\nbody\n'),
    );
    // …but the fresh read shows the FM was legitimately deleted: the file no
    // longer OPENS with a `---` fence, so this is a real edit, not a short read.
    const captured = installFilo('body with no frontmatter anymore\n');
    markHydrated(relPath, false);

    await writeMarkdownFile({
      vaultRoot: '/vault',
      relPath,
      frontmatter: {},
      body: 'body with no frontmatter anymore\n',
      callerId: 'removed-test',
      docId: null,
      frontmatterDelta: { set: { status: 'closed' }, unset: [] },
    });

    // Wrote (added the delta key as new FM) — no false refusal.
    expect(captured.some((c) => c.channel === 'vault:write-existing-file-text')).toBe(true);
    expect(isPathPending(relPath)).toBe(false);
  });
});

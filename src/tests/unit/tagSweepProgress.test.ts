/**
 * A vault-wide tag rename or delete can take minutes in a large vault, so it
 * says how far it has got:
 * - the sweep reports each note it reads and each it writes;
 * - a sticky toast shows the counts, updated a few times a second at most,
 *   and goes when the sweep ends (the caller's done or failure toast
 *   follows);
 * - `tagSweepStatus.running` is true for as long as it runs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  rewriteTagInAllMarkdown,
  __resetTagRewriteSweepForTests,
  type TagSweepProgress,
} from '@renderer/lib/vault/tagRewriteSweep';
import { __resetTagRewriteSentinelForTests } from '@renderer/lib/vault/tagRewriteSentinel';
import { noteStore } from '@renderer/stores/notes.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import type { FileMetadata } from '@renderer/lib/vault/vaultIndex';
import {
  tagSweepLabel,
  tagSweepProgressText,
  tagSweepStatus,
  withTagSweepProgress,
  TAG_SWEEP_UPDATE_MS,
} from '@renderer/stores/tagSweepProgress.svelte';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

const withTag = (tag: string, body: string): string => `---\ntags:\n  - ${tag}\n---\n${body}\n`;

function metadata(paths: string[], tag: string): FileMetadata[] {
  return paths.map((path) => ({
    path,
    title: path,
    headings: [],
    tags: [tag],
    frontmatter: {},
    links: [],
    content: '',
    lastModified: 0,
    rawFrontmatter: '',
  }));
}

function installVault(files: Map<string, string>): void {
  installFiloMock((channel: string, ...args: unknown[]) => {
    const rel = args[1] as string;
    if (channel === 'vault:read-file-text') {
      const content = files.get(rel);
      return content === undefined ? { success: false, code: 'ENOENT' } : { success: true, content, mtimeMs: 1, size: content.length };
    }
    if (channel === 'vault:stat') {
      const content = files.get(rel);
      return content === undefined ? { success: false, code: 'ENOENT' } : { success: true, mtimeMs: 1, size: content.length };
    }
    if (channel === 'vault:file-exists') return files.has(rel);
    if (channel === 'vault:write-existing-file-text' || channel === 'vault:write-file-text') {
      files.set(rel, args[2] as string);
      return { success: true };
    }
    return { success: true };
  });
}

const progressToasts = (): string[] => uiStore.toasts.filter((t) => t.dedupeKey === 'tag-sweep-progress').map((t) => t.text);

describe('the sweep reports its progress', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    noteStore.__resetForTests();
    __resetTagRewriteSweepForTests();
    __resetTagRewriteSentinelForTests();
  });
  afterEach(() => {
    noteStore.__resetForTests();
    __resetTagRewriteSweepForTests();
    __resetTagRewriteSentinelForTests();
    restoreFiloDefault();
  });

  it('counts each note read, then each note written, up to the total', async () => {
    const files = new Map([
      ['a.md', withTag('draft', 'A')],
      ['b.md', withTag('draft', 'B')],
      ['c.md', withTag('other', 'C')],
    ]);
    installVault(files);
    const seen: TagSweepProgress[] = [];
    const result = await rewriteTagInAllMarkdown({
      vaultRoot: '/vault',
      // c.md is listed with the tag but no longer has it: read, not written.
      metadata: metadata(['a.md', 'b.md', 'c.md'], 'draft'),
      oldName: 'draft',
      newName: 'review',
      applyChanges: async () => {},
      onProgress: (p) => seen.push({ ...p }),
    });

    expect(result.succeeded).toEqual(['a.md', 'b.md']);
    const reading = seen.filter((p) => p.phase === 'reading');
    const writing = seen.filter((p) => p.phase === 'writing');
    expect(reading.map((p) => p.done)).toEqual([0, 1, 2]);
    expect(reading.every((p) => p.total === 3)).toBe(true);
    expect(writing.map((p) => p.done)).toEqual([0, 0, 1, 2]);
    expect(writing.every((p) => p.total === 2)).toBe(true);
  });
});

describe('the progress toast', () => {
  beforeEach(() => {
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
  });

  it('names the change and the counts', () => {
    const label = tagSweepLabel('a', 'b');
    expect(label).toBe('Renaming tag "#a" to "#b"');
    expect(tagSweepLabel('a', null)).toBe('Deleting tag "#a"');
    expect(tagSweepProgressText(label, { phase: 'writing', done: 12, total: 3000 })).toBe('Renaming tag "#a" to "#b"… 12 of 3000 notes');
    expect(tagSweepProgressText(label, { phase: 'reading', done: 5, total: 3000 })).toBe('Renaming tag "#a" to "#b"… checking 5 of 3000 notes');
  });

  it('shows the latest count at most every few hundred ms, and goes when the sweep ends', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    let report!: (p: TagSweepProgress) => void;
    const done = withTagSweepProgress('Renaming tag "#a" to "#b"', (onProgress) => {
      report = onProgress;
      return new Promise<void>((resolve) => { finish = resolve; });
    });

    expect(tagSweepStatus.running).toBe(true);
    expect(progressToasts()).toEqual(['Renaming tag "#a" to "#b"…']);

    report({ phase: 'writing', done: 1, total: 3000 });
    expect(progressToasts()).toEqual(['Renaming tag "#a" to "#b"… 1 of 3000 notes']);
    // A burst inside the gap shows only its last count, once the gap is over.
    report({ phase: 'writing', done: 2, total: 3000 });
    report({ phase: 'writing', done: 3, total: 3000 });
    expect(progressToasts()).toEqual(['Renaming tag "#a" to "#b"… 1 of 3000 notes']);
    vi.advanceTimersByTime(TAG_SWEEP_UPDATE_MS);
    expect(progressToasts()).toEqual(['Renaming tag "#a" to "#b"… 3 of 3000 notes']);

    finish();
    await done;
    expect(progressToasts()).toEqual([]);
    expect(tagSweepStatus.running).toBe(false);
  });

  it('goes, and stops counting as running, when the sweep throws', async () => {
    await expect(withTagSweepProgress('Deleting tag "#a"', async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(progressToasts()).toEqual([]);
    expect(tagSweepStatus.running).toBe(false);
  });
});

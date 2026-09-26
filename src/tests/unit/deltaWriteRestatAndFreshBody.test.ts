import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetDirtyTrackingForTests, isPathPending } from '@renderer/lib/boards/boardSaver';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Note writer torn/stale-read guards.
 *
 *   - The write names the stat its fresh read saw, and the main process
 *     refuses it (STALE) if the file moved since; the writer then starts
 *     over. An external write landing between the read and our write would
 *     otherwise be overwritten unseen (its bytes replaced by a delta applied
 *     to the stale read). A file that keeps moving is never written and the
 *     failure is attributed.
 *   - A body-only save on a note loaded from a complete read keeps its
 *     frontmatter; a genuinely frontmatter-less note is not misclassified.
 *
 * (Corpus rows live in frontmatterInvariant.test.ts; tag rewriter edges in
 * tagRewriter.test.ts.)
 */

let vault: MemoryVault;

const mdWrites = (): string[] => vault.writes.filter(([, rel]) => rel.endsWith('.md')).map(([, , t]) => t);

/**
 * Makes an external program rewrite `rel` just before each of the writer's
 * writes lands (the read→write gap), `times` times.
 */
function externalWriteInGap(rel: string, times: number): void {
  let left = times;
  let n = 0;
  vault.beforeWrite = (r) => {
    if (r !== rel || left <= 0) return;
    left--;
    n++;
    vault.writeExternally(rel, `---\ntitle: t\n---\nexternal body ${n}\n`);
  };
}

beforeEach(() => {
  __resetDirtyTrackingForTests();
  vaultIndexStore.clear();
  vaultStore.setPath('/vault');
  noteStore.__resetForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  noteStore.__resetForTests();
  restoreFiloDefault();
  __resetDirtyTrackingForTests();
  vaultIndexStore.clear();
  vi.restoreAllMocks();
});

describe('a delta write re-checks the file after its fresh read', () => {
  it('an external write in the read→write gap is re-read, not overwritten', async () => {
    const relPath = 'GapWrite.md';
    vault = installMemoryVault({ [relPath]: '---\ntitle: t\n---\nbody\n' });
    externalWriteInGap(relPath, 1);

    noteStore.patchFrontmatter(relPath, { set: { status: 'closed' }, unset: [] });
    expect(await noteStore.flush(relPath)).toBe(true);

    // The delta landed on the external version, whose body survives.
    expect(mdWrites()).toHaveLength(1);
    expect(vault.read(relPath)).toBe('---\ntitle: t\nstatus: closed\n---\nexternal body 1\n');
    expect(isPathPending(relPath)).toBe(false);
  });

  it('a file that keeps changing is never written, and the failure is attributed', async () => {
    const relPath = 'Busy.md';
    vault = installMemoryVault({ [relPath]: '---\ntitle: t\n---\nbody\n' });
    externalWriteInGap(relPath, 100);

    noteStore.patchFrontmatter(relPath, { set: { status: 'closed' }, unset: [] });
    expect(await noteStore.flush(relPath)).toBe(false);

    // Never wrote, and the path is attributed as failed (sentinel stays dirty;
    // the change stays queued for a retry against the settled file).
    expect(mdWrites()).toEqual([]);
    expect(isPathPending(relPath)).toBe(true);
    expect(noteStore.hasPendingWrites(relPath)).toBe(true);
  });

  it('control — a stable file writes normally', async () => {
    const relPath = 'Stable.md';
    vault = installMemoryVault({ [relPath]: '---\ntitle: t\n---\nbody\n' });

    noteStore.patchFrontmatter(relPath, { set: { status: 'closed' }, unset: [] });
    expect(await noteStore.flush(relPath)).toBe(true);

    const written = mdWrites().at(-1)!;
    expect(written).toContain('status: closed'); // delta applied
    expect(written).toContain('title: t'); // untouched key preserved
    expect(isPathPending(relPath)).toBe(false);
  });
});

describe('a body-only save on a freshly loaded note', () => {
  it('a complete read keeps the frontmatter', async () => {
    const relPath = 'CleanSeed.md';
    vault = installMemoryVault({ [relPath]: '---\ntitle: Keep\n---\nold body\n' });
    const m = noteStore.acquire(relPath, 'v');
    await m.loaded;
    noteStore.setBody(relPath, 'new body', 'v');
    expect(await noteStore.flush(relPath)).toBe(true);

    expect(vault.read(relPath)).toBe('---\ntitle: Keep\n---\nnew body\n');
    expect(m.frontmatter).toEqual({ title: 'Keep' });
    expect(isPathPending(relPath)).toBe(false);
    noteStore.release(relPath, 'v');
  });

  it('a genuinely frontmatter-less file is not misclassified (no false positive)', async () => {
    const relPath = 'PlainSeed.md';
    vault = installMemoryVault({ [relPath]: 'just a body\n' });
    const m = noteStore.acquire(relPath, 'v');
    await m.loaded;
    noteStore.setBody(relPath, 'new body', 'v');
    expect(await noteStore.flush(relPath)).toBe(true);

    expect(vault.read(relPath)).toBe('new body\n');
    expect(isPathPending(relPath)).toBe(false);
    noteStore.release(relPath, 'v');
  });
});

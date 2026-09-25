import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetDirtyTrackingForTests, isPathPending } from '@renderer/lib/boards/boardSaver';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { noteStore, type NoteModel } from '@renderer/stores/notes.svelte';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Frontmatter / markdown write edges on the note writer's delta path:
 *   - EOL comes from the FRESH read at write time, not from what the note
 *     looked like when it loaded (a LF↔CRLF external conversion since then
 *     otherwise yields a mixed-EOL file).
 *   - A TRUNCATED read (opening fence, no closing fence) of a note known to
 *     carry frontmatter is refused, not assembled into a write that strips
 *     the on-disk frontmatter.
 *
 * (Replace All's own edges are covered in `replaceAllCommand.test.ts`.)
 */

let vault: MemoryVault;

async function loaded(rel: string): Promise<NoteModel> {
  const m = noteStore.acquire(rel, 'test-view');
  await m.loaded;
  return m;
}

const writesTo = (rel: string): string[] => vault.writes.filter(([, r]) => r === rel).map(([, , text]) => text);

describe('delta write EOL + truncation guard', () => {
  beforeEach(() => {
    __resetDirtyTrackingForTests();
    vaultIndexStore.clear();
    vaultStore.setPath('/vault');
    noteStore.__resetForTests();
  });
  afterEach(() => {
    noteStore.__resetForTests();
    __resetDirtyTrackingForTests();
    vaultIndexStore.clear();
    restoreFiloDefault();
  });

  it('derives EOL from the fresh disk read, not the one the note loaded from', async () => {
    const relPath = 'Note.md';
    vault = installMemoryVault({ [relPath]: '---\ncompleted: false\n---\nbody line\n' });
    await loaded(relPath);
    // An external editor converted the file to CRLF after it loaded.
    vault.writeExternally(relPath, '---\r\ncompleted: false\r\n---\r\nbody line\r\n');

    noteStore.patchFrontmatter(relPath, { set: { completed: true }, unset: [] });
    expect(await noteStore.flush(relPath)).toBe(true);

    const written = writesTo(relPath).at(-1)!;
    expect(written).toBeDefined();
    // The FM line carries CRLF (a stale LF snapshot would flip it to LF).
    expect(written).toContain('completed: true\r\n');
    // Whole file is uniformly CRLF — strip every CRLF pair and no lone LF remains.
    expect(written.replace(/\r\n/g, '').includes('\n')).toBe(false);
  });

  it('a CRLF→LF external conversion since load yields uniform LF', async () => {
    const relPath = 'Note2.md';
    vault = installMemoryVault({ [relPath]: '---\r\npriority: low\r\n---\r\nbody\r\n' });
    await loaded(relPath);
    vault.writeExternally(relPath, '---\npriority: low\n---\nbody\n');

    noteStore.patchFrontmatter(relPath, { set: { priority: 'high' }, unset: [] });
    expect(await noteStore.flush(relPath)).toBe(true);

    const written = writesTo(relPath).at(-1)!;
    expect(written).toContain('priority: high');
    // No CRLF anywhere — the note's earlier CRLF must NOT re-impose CR bytes.
    expect(written.includes('\r')).toBe(false);
  });

  it('refuses a delta write when the fresh read is truncated mid-frontmatter', async () => {
    const relPath = 'Big.md';
    vault = installMemoryVault({ [relPath]: '---\ntitle: real\nstatus: open\n---\nbody\n' });
    await loaded(relPath);
    // The fresh read returns TRUNCATED bytes: opening fence, no closing fence
    // (a non-atomic external writer caught mid-write, and it stays that way).
    vault.writeExternally(relPath, '---\ntitle: real\nstatus: o');

    noteStore.patchFrontmatter(relPath, { set: { status: 'closed' }, unset: [] });
    expect(await noteStore.flush(relPath)).toBe(false);

    // Never wrote — refused to strip the real on-disk frontmatter.
    expect(writesTo(relPath)).toEqual([]);
    // Marked failed so `.filo/.dirty` stays set (isPathPending covers failed paths).
    expect(isPathPending(relPath)).toBe(true);
  });

  it('still writes when the file genuinely has NO frontmatter (no false positive)', async () => {
    const relPath = 'Plain.md';
    vault = installMemoryVault({ [relPath]: 'just a body, no fm\n' });
    await loaded(relPath);

    noteStore.patchFrontmatter(relPath, { set: { status: 'closed' }, unset: [] });
    expect(await noteStore.flush(relPath)).toBe(true);

    // The guard must NOT fire — a real FM-less file writes its new delta key.
    expect(writesTo(relPath).at(-1)).toContain('status: closed');
    expect(isPathPending(relPath)).toBe(false);
  });

  it('a legitimate FM removal (no opening fence) is NOT misclassified as truncation', async () => {
    const relPath = 'Removed.md';
    vault = installMemoryVault({ [relPath]: '---\ntitle: gone\n---\nbody\n' });
    await loaded(relPath);
    // The FM was legitimately deleted: the file no longer OPENS with a `---`
    // fence, so this is a real edit, not a short read.
    vault.writeExternally(relPath, 'body with no frontmatter anymore\n');

    noteStore.patchFrontmatter(relPath, { set: { status: 'closed' }, unset: [] });
    expect(await noteStore.flush(relPath)).toBe(true);

    // Wrote (added the delta key as new FM) — no false refusal.
    expect(writesTo(relPath).at(-1)).toContain('status: closed');
    expect(isPathPending(relPath)).toBe(false);
  });
});

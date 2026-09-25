import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { noteStore } from '@renderer/stores/notes.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import type { TaskListBoard as TaskListBoardType, Tile } from '@renderer/schema/index';
import type { TaskRow } from '@renderer/lib/tasks/taskListModel';
import { __resetDirtyTrackingForTests, isPathPending } from '@renderer/lib/boards/writeStateTracking';
import { makeFrontmatterWriter } from '@renderer/lib/tasklist/frontmatterWriter';
import { patchToFrontmatterDelta } from '@renderer/lib/vault/frontmatterDelta';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Silent data loss around Task notes and field edits.
 *
 *  - Every Task notes edit reaches disk: the second and later edits, the
 *    first one after a field edit already flushed, and one typed while a
 *    write is in flight.
 *  - A change that lands while a write IPC is stalled is not counted as
 *    written by it; the next flush writes it.
 *  - Field edits on a read-only (lossy round-trip) note proceed with the body
 *    from DISK (never the lossy editor body), while a body the note can't
 *    write fails LOUDLY instead of being reported saved.
 *  - A note's first read never clobbers a field edit queued while it ran.
 */

let vault: MemoryVault;

function mdWrites(): string[] {
  return vault.writes.filter(([, rel]) => rel.endsWith('.md')).map(([, , text]) => text);
}

function makeWriter() {
  return makeFrontmatterWriter({
    getBoard: () =>
      ({ id: 'tl', type: 'tasklist', settings: {} }) as unknown as TaskListBoardType,
    vaultPathForTile: () => 'Task.md',
    readFrontmatter: () => ({ completed: false }),
    bumpCacheVersion: () => {},
  });
}

function makeRow(): TaskRow {
  return {
    placement: { tileId: 'tn', position: 0 },
    tile: { id: 'tn', type: 'text', filePath: 'Task.md', title: 'Task', tags: [] } as unknown as Tile,
    completed: false,
    priority: 'none',
    dueDate: '',
    dueTime: '',
    startDate: '',
    status: '',
    tags: [],
    parent: '',
    recurrence: '',
    recurrenceMode: 'schedule',
    category: '',
  };
}

function resetAll(): void {
  __resetDirtyTrackingForTests();
  noteStore.__resetForTests();
  vaultIndexStore.clear();
}

beforeEach(() => {
  resetAll();
  vaultStore.setPath('/vault');
});

afterEach(() => {
  resetAll();
  restoreFiloDefault();
  vaultStore.setPath('');
});

describe('every Task notes edit reaches disk', () => {
  const DISK = '---\ntitle: T\npriority: high\n---\nold body';

  beforeEach(() => {
    vault = installMemoryVault({ 'Task.md': DISK });
  });

  it('the SECOND sequential setNotesBody reaches disk', async () => {
    const writer = makeWriter();

    await writer.setNotesBody(makeRow(), 'first note');
    const res1 = await noteStore.flushAll();
    expect(res1.failed).toEqual([]);
    const afterFirst = mdWrites();
    expect(afterFirst.length).toBe(1);
    expect(afterFirst[0]).toContain('first note');

    await writer.setNotesBody(makeRow(), 'second note');
    const res2 = await noteStore.flushAll();
    expect(res2.failed).toEqual([]);

    const writes = mdWrites();
    expect(writes.length).toBe(2);
    expect(writes[1]).toContain('second note');
    // The untouched disk FM key still survives the body-only write.
    expect(writes[1]).toContain('priority: high');
  });

  it('a FIRST notes edit after a field edit already flushed still lands', async () => {
    // Field edit on an un-opened task, flushed.
    noteStore.patchFrontmatter('Task.md', patchToFrontmatterDelta({ completed: true }));
    const resField = await noteStore.flushAll();
    expect(resField.failed).toEqual([]);
    const afterField = mdWrites().length;
    expect(afterField).toBeGreaterThan(0);

    // Now the user expands the task and types a note.
    const writer = makeWriter();
    await writer.setNotesBody(makeRow(), 'my first note');
    const res = await noteStore.flushAll();
    expect(res.failed).toEqual([]);

    const writes = mdWrites();
    expect(writes.length).toBe(afterField + 1);
    expect(writes[writes.length - 1]).toContain('my first note');
    expect(writes[writes.length - 1]).toContain('completed: true');
  });

  it('a notes edit landing while a write is in flight is not skipped by the next flush', async () => {
    const writer = makeWriter();
    await writer.setNotesBody(makeRow(), 'first note');
    const flushP = noteStore.flushAll();
    // Edit again while the first flush is (possibly) mid-write.
    await writer.setNotesBody(makeRow(), 'edited during flight');
    await flushP;

    const res = await noteStore.flushAll();
    expect(res.failed).toEqual([]);
    const writes = mdWrites();
    expect(writes[writes.length - 1]).toContain('edited during flight');
    expect(vault.read('Task.md')).toContain('edited during flight');
  });
});

describe('a change landing during a stalled write IPC is not counted as written', () => {
  it('a frontmatter change queued mid-IPC lands on the next flush', async () => {
    vault = installMemoryVault({ 'V.md': '---\ntitle: V\n---\nb1' });
    let writeCalls = 0;
    let releaseWrite: () => void = () => {};
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    vault.beforeWrite = async (rel) => {
      if (!rel.endsWith('.md')) return;
      writeCalls++;
      if (writeCalls === 1) await writeGate; // stall the FIRST write only
    };

    noteStore.patchFrontmatter('V.md', { set: { priority: 'high' }, unset: [] });
    const flushP = noteStore.flushAll();
    // Wait until the first write IPC is actually in flight (stalled on the gate).
    await vi.waitFor(() => expect(writeCalls).toBe(1), { timeout: 2000, interval: 5 });

    // A mutation lands mid-IPC. Its bytes are NOT in the in-flight write.
    noteStore.patchFrontmatter('V.md', { set: { status: 'fresh' }, unset: [] });
    releaseWrite();
    await flushP;

    const res = await noteStore.flushAll();
    expect(res.failed).toEqual([]);

    const writes = mdWrites();
    expect(writes.length).toBe(2);
    expect(writes[0]).not.toContain('status: fresh');
    expect(writes[1]).toContain('status: fresh');
    expect(writes[1]).toContain('priority: high');
  });
});

describe('field edits on a read-only (lossy round-trip) note', () => {
  const LOSSY_DISK_BODY = '==highlight== %%comment%% body the editor cannot round-trip';
  const DISK_RO = `---\ntitle: RO\n---\n${LOSSY_DISK_BODY}`;

  beforeEach(() => {
    vault = installMemoryVault({ 'RO.md': DISK_RO });
  });

  it('a pending DELTA proceeds, sourcing the body from disk (never the lossy editor body)', async () => {
    const m = noteStore.acquire('RO.md', 'text-tile:ro');
    await m.loaded;
    noteStore.setLossy('RO.md', true);
    // A lossy note refuses editor bodies outright.
    noteStore.setBody('RO.md', 'LOSSY ROUND-TRIPPED EDITOR BODY', 'text-tile:ro');

    noteStore.patchFrontmatter('RO.md', patchToFrontmatterDelta({ priority: 'high' }));
    const res = await noteStore.flushAll();
    expect(res.failed).toEqual([]);

    const writes = mdWrites();
    expect(writes.length).toBe(1);
    // The field edit landed…
    expect(writes[0]).toContain('priority: high');
    // …the untouched disk FM survived…
    expect(writes[0]).toContain('title: RO');
    // …and the BODY is the on-disk bytes, byte-for-byte — never the lossy
    // round-tripped editor body (the whole reason the note is read-only).
    expect(writes[0]).toContain(LOSSY_DISK_BODY);
    expect(writes[0]).not.toContain('LOSSY ROUND-TRIPPED EDITOR BODY');
    noteStore.release('RO.md', 'text-tile:ro');
  });

  it('a body the note can no longer write fails LOUDLY: flushAll().failed, no silent success', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const m = noteStore.acquire('RO.md', 'text-tile:ro');
      await m.loaded;
      // A body queued before the note turned out lossy.
      noteStore.setBody('RO.md', 'typed before the lossy check', 'text-tile:ro');
      noteStore.setLossy('RO.md', true);

      const res = await noteStore.flushAll();
      expect(res.failed).toContain('RO.md');
      expect(mdWrites().length).toBe(0);
      expect(vault.read('RO.md')).toBe(DISK_RO);
      // Kept failed, so the recovery sentinel survives and save/quit report it.
      expect(isPathPending('RO.md')).toBe(true);
      noteStore.release('RO.md', 'text-tile:ro');
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe('a note\'s first read never clobbers a field edit queued while it ran', () => {
  it('a racing FIELD edit survives the load', async () => {
    const DISK_S = '---\ntitle: T\nexternal: added-by-editor\n---\ndisk body';
    vault = installMemoryVault({ 'S.md': DISK_S });
    let releaseRead: () => void = () => {};
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let reading = false;
    const invoke = window.filo.invoke;
    window.filo.invoke = (async (channel: string, ...args: unknown[]) => {
      if (channel === 'vault:read-file-text' && !reading) {
        reading = true;
        await readGate;
      }
      return (invoke as (c: string, ...a: unknown[]) => Promise<unknown>)(channel, ...args);
    }) as typeof window.filo.invoke;

    const m = noteStore.acquire('S.md', 'text-tile:s');
    await new Promise((r) => setTimeout(r, 0)); // the load reaches the gated read

    noteStore.patchFrontmatter('S.md', { set: { completed: true }, unset: [] });
    releaseRead();
    await m.loaded;

    // The disk bytes (with the externally-added key) and the racing field
    // edit are both in the model.
    expect(m.frontmatter).toHaveProperty('completed', true);
    expect(m.frontmatter).toHaveProperty('external', 'added-by-editor');
    await noteStore.flushAll();
    expect(vault.read('S.md')).toMatch(/^---\ntitle: T\nexternal: added-by-editor\ncompleted: true\n---\ndisk body\n?$/);
    noteStore.release('S.md', 'text-tile:s');
  });
});

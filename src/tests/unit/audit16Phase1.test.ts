import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { documentStore } from '@renderer/stores/document.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import type { TaskListBoard as TaskListBoardType, Tile } from '@renderer/schema/index';
import type { TaskRow } from '@renderer/lib/tasks/taskListModel';
import { __resetBaselinesForTests } from '@renderer/lib/vault/fileBaselineRegistry';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { makeFrontmatterWriter } from '@renderer/lib/tasklist/frontmatterWriter';
import {
  scheduleFrontmatterWrite,
  flushAllPendingFrontmatterWrites,
  resetFrontmatterScheduler,
} from '@renderer/lib/boards/frontmatterWriteScheduler';
import { seedDocumentFrontmatterFromDisk } from '@renderer/lib/boards/seedFrontmatterFromDisk';
import { cancelAllMarkdownWrites } from '@renderer/lib/vault/markdownFileWriter';
import { patchToFrontmatterDelta } from '@renderer/lib/vault/frontmatterDelta';
import { onError, type ReportedError } from '@renderer/lib/utils/errorBus';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Audit-16 Phase 1 — silent data loss in the frontmatter scheduler.
 *
 *  1.1 (CRITICAL) — the version-token guard only covered FRONTMATTER
 *      mutations, so a delta-less body write (Task notes) fired with
 *      `scheduledVersion <= lastFlushedVersion`, bare-returned as SUCCESS,
 *      and every second-and-later notes edit (or the first after a field
 *      toggle had flushed at that version) silently died on quit.
 *      Fix: `documentStore.updateContent` bumps the shared token.
 *  4.3 (folded in) — `lastFlushedVersion` was bumped to the POST-IPC
 *      mutation version, so a mutation landing mid-write was marked flushed
 *      while the pre-mutation bytes landed. Fix: record the version captured
 *      when the write's content was read (fire time).
 *  1.2 (HIGH) — field edits on a read-only (lossy round-trip) doc were
 *      silently dropped as SUCCESS. Fix: the delta path proceeds (FM
 *      round-trips cleanly; body sourced from DISK, never the lossy editor
 *      body); the delta-less path refuses LOUDLY (toast + markPathFailed +
 *      throw).
 */

interface Captured {
  channel: string;
  args: unknown[];
}

function byteLen(text: string): number {
  return new TextEncoder().encode(text).length;
}

function markdownWrites(captured: Captured[]): string[] {
  return captured
    .filter((c) => c.channel === 'vault:write-existing-file-text')
    .map((c) => c.args[2] as string);
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
    tile: { id: 'tn', type: 'text', contentId: 'doc_notes', title: 'Task', tags: [] } as unknown as Tile,
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
  resetFrontmatterScheduler();
  cancelAllMarkdownWrites();
  documentStore.clear();
  vaultIndexStore.clear();
  __resetBaselinesForTests();
}

describe('Audit-16 1.1 — body edits bump the write-staleness token', () => {
  let captured: Captured[];
  const DISK = '---\ntitle: T\npriority: high\n---\nold body';

  beforeEach(() => {
    resetAll();
    vaultStore.setPath('/vault');
    captured = [];
    installFiloMock(async (channel: string, ...args: unknown[]) => {
      captured.push({ channel, args });
      if (channel === 'vault:read-file-text') {
        return { success: true, content: DISK, mtimeMs: 5, size: byteLen(DISK) };
      }
      if (channel === 'vault:stat') return { success: true, mtimeMs: 5, size: byteLen(DISK) };
      return { success: true };
    });
  });

  afterEach(() => {
    restoreFiloDefault();
    resetAll();
    vaultStore.setPath('');
  });

  it('the SECOND sequential setNotesBody reaches the gateway (was skipped as stale)', async () => {
    const writer = makeWriter();

    await writer.setNotesBody(makeRow(), 'first note');
    const res1 = await flushAllPendingFrontmatterWrites();
    expect(res1.failed).toEqual([]);
    const afterFirst = markdownWrites(captured);
    expect(afterFirst.length).toBe(1);
    expect(afterFirst[0]).toContain('first note');

    // The second edit. Pre-1.1 the FM cache is already seeded so nothing bumps
    // the mutation version; the scheduled flush compared
    // `scheduledVersion <= lastFlushedVersion`, bare-returned as SUCCESS, and
    // the note existed only in documentStore — dead on quit.
    await writer.setNotesBody(makeRow(), 'second note');
    const res2 = await flushAllPendingFrontmatterWrites();
    expect(res2.failed).toEqual([]);

    const writes = markdownWrites(captured);
    expect(writes.length).toBe(2);
    expect(writes[1]).toContain('second note');
    // The untouched disk FM key still survives the body-only write.
    expect(writes[1]).toContain('priority: high');
  });

  it('a FIRST notes edit after a field edit already flushed at that version still lands', async () => {
    // Field edit on an un-opened task: seed the FM cache from disk, merge the
    // field, flush the delta write — lastFlushedVersion now records the
    // current mutation version for this docId.
    await seedDocumentFrontmatterFromDisk('doc_notes', '/vault', 'Task.md');
    documentStore.mergeFrontmatter('doc_notes', { completed: true });
    scheduleFrontmatterWrite('Task.md', 'doc_notes', patchToFrontmatterDelta({ completed: true }));
    const resField = await flushAllPendingFrontmatterWrites();
    expect(resField.failed).toEqual([]);
    const afterField = markdownWrites(captured).length;
    expect(afterField).toBeGreaterThan(0);

    // Now the user expands the task and types a note. Pre-1.1 this scheduled
    // with the SAME version the field flush recorded → skipped → first note
    // dropped (the plan's "toggle the checkbox first" variant).
    const writer = makeWriter();
    await writer.setNotesBody(makeRow(), 'my first note');
    const res = await flushAllPendingFrontmatterWrites();
    expect(res.failed).toEqual([]);

    const writes = markdownWrites(captured);
    expect(writes.length).toBe(afterField + 1);
    expect(writes[writes.length - 1]).toContain('my first note');
  });

  it('a notes edit landing while a write is in flight is not skipped by the next flush', async () => {
    const writer = makeWriter();
    await writer.setNotesBody(makeRow(), 'first note');
    const flushP = flushAllPendingFrontmatterWrites();
    // Edit again while the first flush is (possibly) mid-write.
    documentStore.updateContent('doc_notes', '', 'edited during flight');
    await flushP;

    scheduleFrontmatterWrite('Task.md', 'doc_notes');
    const res = await flushAllPendingFrontmatterWrites();
    expect(res.failed).toEqual([]);
    const writes = markdownWrites(captured);
    expect(writes[writes.length - 1]).toContain('edited during flight');
  });
});

describe('Audit-16 4.3 — flushed-version records the capture-time version, not post-IPC', () => {
  let captured: Captured[];
  const DISK_V = '---\ntitle: V\n---\nb1';

  beforeEach(() => {
    resetAll();
    vaultStore.setPath('/vault');
    captured = [];
  });

  afterEach(() => {
    restoreFiloDefault();
    resetAll();
    vaultStore.setPath('');
  });

  it('a mergeFrontmatter landing during a stalled write IPC is not marked flushed', async () => {
    let writeCalls = 0;
    let releaseWrite: () => void = () => {};
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    installFiloMock(async (channel: string, ...args: unknown[]) => {
      captured.push({ channel, args });
      if (channel === 'vault:read-file-text') {
        return { success: true, content: DISK_V, mtimeMs: 5, size: byteLen(DISK_V) };
      }
      if (channel === 'vault:stat') return { success: true, mtimeMs: 5, size: byteLen(DISK_V) };
      if (channel === 'vault:write-existing-file-text') {
        writeCalls++;
        if (writeCalls === 1) await writeGate; // stall the FIRST write only
        return { success: true };
      }
      return { success: true };
    });

    documentStore.loadDocument({
      docId: 'doc_v',
      filename: 'V.md',
      title: 'V',
      body: 'b1',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter('doc_v', { title: 'V' });

    scheduleFrontmatterWrite('V.md', 'doc_v');
    const flushP = flushAllPendingFrontmatterWrites();
    // Wait until the first write IPC is actually in flight (stalled on the gate).
    await vi.waitFor(() => expect(writeCalls).toBe(1), { timeout: 2000, interval: 5 });

    // An FM mutation lands mid-IPC. Its bytes are NOT in the in-flight write
    // (the FM was read before the IPC); pre-4.3 the success bookkeeping read
    // the CURRENT version after the await and recorded this mutation as
    // flushed — the follow-up scheduled write then skipped as "stale" and the
    // mutation never reached disk.
    documentStore.mergeFrontmatter('doc_v', { status: 'fresh' });
    releaseWrite();
    await flushP;

    scheduleFrontmatterWrite('V.md', 'doc_v');
    const res = await flushAllPendingFrontmatterWrites();
    expect(res.failed).toEqual([]);

    const writes = markdownWrites(captured);
    expect(writes.length).toBe(2);
    expect(writes[0]).not.toContain('status: fresh');
    expect(writes[1]).toContain('status: fresh');
  });
});

describe('Audit-16 1.2 — field edits on a read-only (lossy round-trip) doc', () => {
  let captured: Captured[];
  const LOSSY_DISK_BODY = '==highlight== %%comment%% body the editor cannot round-trip';
  const DISK_RO = `---\ntitle: RO\n---\n${LOSSY_DISK_BODY}`;

  beforeEach(() => {
    resetAll();
    vaultStore.setPath('/vault');
    captured = [];
    installFiloMock(async (channel: string, ...args: unknown[]) => {
      captured.push({ channel, args });
      if (channel === 'vault:read-file-text') {
        return { success: true, content: DISK_RO, mtimeMs: 7, size: byteLen(DISK_RO) };
      }
      if (channel === 'vault:stat') return { success: true, mtimeMs: 7, size: byteLen(DISK_RO) };
      return { success: true };
    });
    documentStore.loadDocument({
      docId: 'doc_ro',
      filename: 'RO.md',
      title: 'RO',
      body: 'LOSSY ROUND-TRIPPED EDITOR BODY',
      htmlContent: '',
      richText: [],
    });
    documentStore.setFrontmatter('doc_ro', { title: 'RO' });
    documentStore.setReadOnly('doc_ro', true);
  });

  afterEach(() => {
    restoreFiloDefault();
    resetAll();
    vaultStore.setPath('');
  });

  it('a pending DELTA proceeds, sourcing the body from disk (never the lossy editor body)', async () => {
    scheduleFrontmatterWrite('RO.md', 'doc_ro', patchToFrontmatterDelta({ priority: 'high' }));
    const res = await flushAllPendingFrontmatterWrites();
    // Pre-1.2 the bare `isReadOnly → return` resolved as SUCCESS with no
    // write; the delta stayed orphaned in pendingDeltas forever.
    expect(res.failed).toEqual([]);

    const writes = markdownWrites(captured);
    expect(writes.length).toBe(1);
    // The field edit landed…
    expect(writes[0]).toContain('priority: high');
    // …the untouched disk FM survived…
    expect(writes[0]).toContain('title: RO');
    // …and the BODY is the on-disk bytes, byte-for-byte — never the lossy
    // round-tripped editor body (the whole reason the doc is read-only).
    expect(writes[0]).toContain(LOSSY_DISK_BODY);
    expect(writes[0]).not.toContain('LOSSY ROUND-TRIPPED EDITOR BODY');
  });

  it('a delta-less write refuses LOUDLY: flushAll().failed + errorBus, no silent success', async () => {
    const errors: ReportedError[] = [];
    const unsubscribe = onError((e) => errors.push(e));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      scheduleFrontmatterWrite('RO.md', 'doc_ro');
      const res = await flushAllPendingFrontmatterWrites();
      // Pre-1.2 this resolved as SUCCESS (failed: []) and markClean wiped the
      // recovery sentinel while nothing reached disk.
      expect(res.failed).toContain('RO.md');
      expect(markdownWrites(captured).length).toBe(0);
      expect(errors.some((e) => e.context === 'frontmatter.readOnly')).toBe(true);
    } finally {
      errSpy.mockRestore();
      unsubscribe();
    }
  });
});

describe('Audit-16 1.1 — disk-FM refresh seed tolerates racing BODY bumps (A9-M2 preserved for FM)', () => {
  const DISK_S = '---\ntitle: T\nexternal: added-by-editor\n---\ndisk body';
  let releaseRead: () => void;

  beforeEach(() => {
    resetAll();
    vaultStore.setPath('/vault');
    releaseRead = () => {};
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    installFiloMock(async (channel: string) => {
      if (channel === 'vault:read-file-text') {
        await readGate;
        return { success: true, content: DISK_S, mtimeMs: 3, size: byteLen(DISK_S) };
      }
      if (channel === 'vault:stat') return { success: true, mtimeMs: 3, size: byteLen(DISK_S) };
      return { success: true };
    });
    documentStore.loadDocument({
      docId: 'doc_s',
      filename: 'S.md',
      title: 'S',
      body: 'old',
      htmlContent: '',
      richText: [],
    });
  });

  afterEach(() => {
    releaseRead();
    restoreFiloDefault();
    resetAll();
    vaultStore.setPath('');
  });

  it('a notes keystroke during the refresh read does NOT block the disk-FM refresh', async () => {
    documentStore.setFrontmatter('doc_s', { title: 'T' }); // index placeholder
    const placeholderVersion = documentStore.getFrontmatterOnlyMutationVersion('doc_s');

    const seedP = seedDocumentFrontmatterFromDisk('doc_s', '/vault', 'S.md', {
      refreshSeedVersion: placeholderVersion,
    });
    await new Promise((r) => setTimeout(r, 0)); // let the seed reach the gated read

    // Second rapid notes keystroke — bumps the shared write-staleness token
    // but must not be mistaken for an FM mutation (the refresh replaces only
    // the FM cache, never the body).
    documentStore.updateContent('doc_s', '', 'typed note');
    releaseRead();
    await seedP;

    // The refresh applied: the externally-added key + source baseline landed.
    expect(documentStore.getFrontmatter('doc_s')).toHaveProperty('external', 'added-by-editor');
    // The body bump was untouched by the refresh.
    expect(documentStore.getDocument('doc_s')?.body).toBe('typed note');
  });

  it('a racing FIELD edit still blocks the refresh (A9-M2 semantics intact)', async () => {
    documentStore.setFrontmatter('doc_s', { title: 'T' });
    const placeholderVersion = documentStore.getFrontmatterOnlyMutationVersion('doc_s');

    const seedP = seedDocumentFrontmatterFromDisk('doc_s', '/vault', 'S.md', {
      refreshSeedVersion: placeholderVersion,
    });
    await new Promise((r) => setTimeout(r, 0));

    documentStore.mergeFrontmatter('doc_s', { completed: true }); // FM mutation
    releaseRead();
    await seedP;

    // The stale disk bytes must NOT clobber the racing field edit.
    const fm = documentStore.getFrontmatter('doc_s');
    expect(fm).toHaveProperty('completed', true);
    expect(fm).not.toHaveProperty('external');
  });
});

/**
 * The Task List notes box: when its draft may be written, what the note store
 * says when it can't take a body, and the draft staying put when it can't.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { noteStore, type SetBodyStatus } from '@renderer/stores/notes.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { NotesBox, notesBoxDecision } from '@renderer/lib/tasklist/notesBox.svelte';
import { __resetDirtyTrackingForTests, unsavedWork } from '@renderer/lib/boards/writeStateTracking';
import { flushAllComponents, __resetComponentFlushesForTests } from '@renderer/lib/boards/componentFlush';
import { heldDecisions } from '@renderer/stores/heldDecisions';
import { takeNotesBoxRescueItems } from '@renderer/lib/tasklist/notesBox.svelte';
import { beginVaultGeneration } from '@renderer/lib/vault/vaultIdentity';
import { installFiloMock, restoreFiloDefault } from '../helpers/filoBridge';

describe('notesBoxDecision', () => {
  const base = { openedBody: 'A\n', currentBody: 'A\n', draft: 'A\n' };

  it('writes nothing when the user typed nothing, even if the body changed since', () => {
    expect(notesBoxDecision({ ...base, touched: false, currentBody: 'B\n' })).toBe('skip');
  });

  it('writes what was typed onto the body it was opened on', () => {
    expect(notesBoxDecision({ ...base, touched: true, draft: 'A, more\n' })).toBe('write');
  });

  it('asks when the body changed since the box opened', () => {
    expect(notesBoxDecision({ ...base, touched: true, draft: 'Mine\n', currentBody: 'Theirs\n' })).toBe('conflict');
  });

  it('writes nothing when the draft already matches the body', () => {
    expect(notesBoxDecision({ ...base, touched: true, currentBody: 'Same', draft: 'Same\n' })).toBe('skip');
  });
});

describe('noteStore.writeBody statuses', () => {
  let read: (rel: string) => Promise<unknown>;
  let disk: string;

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    noteStore.__resetForTests();
    beginVaultGeneration('/vault');
    vaultStore.setPath('/vault');
    disk = '---\ntitle: T\n---\nold\n';
    read = async () => ({ success: true, content: disk, mtimeMs: 5, size: disk.length, encoding: 'utf-8' });
    installFiloMock(async (channel: string, ...args: unknown[]) => {
      if (channel === 'vault:read-file-text') return read(args[1] as string);
      if (channel === 'vault:stat') return { success: true, mtimeMs: 5, size: disk.length };
      if (channel === 'vault:write-existing-file-text') { disk = args[2] as string; return { success: true }; }
      return { success: true };
    });
  });

  afterEach(() => {
    noteStore.__resetForTests();
    vaultStore.setPath('');
    restoreFiloDefault();
  });

  it('queued: the body is taken and written', async () => {
    expect(await noteStore.writeBody('T.md', 'new')).toBe('queued');
    await noteStore.flushAll();
    expect(disk).toBe('---\ntitle: T\n---\nnew\n');
  });

  it('read-only: a note that isn\'t UTF-8 is never written', async () => {
    read = async () => ({ success: true, content: 'Caf�', mtimeMs: 5, size: 4, encoding: 'invalid-utf-8' });
    expect(await noteStore.writeBody('Latin.md', 'new')).toBe('read-only');
  });

  it('unreadable: a note that couldn\'t be read takes nothing', async () => {
    read = async () => ({ success: false, error: 'EIO: i/o error', code: 'EIO' });
    expect(await noteStore.writeBody('Broken.md', 'new')).toBe('unreadable');
  });

  it('vault-changed: another vault opened while the note loaded', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const prior = read;
    read = async (rel) => { await gate; return prior(rel); };
    const pending = noteStore.writeBody('T.md', 'new');
    await new Promise((r) => setTimeout(r, 0));
    beginVaultGeneration('/other');
    release();
    expect(await pending).toBe('vault-changed');
  });
});

describe('NotesBox keeps its draft when the body is refused', () => {
  afterEach(() => {
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id);
  });

  it('stays open with the draft and says why', async () => {
    let body = 'old\n';
    const writes: string[] = [];
    let answer: SetBodyStatus = 'unreadable';
    const box = new NotesBox({
      path: () => 'T.md',
      body: () => body,
      write: async (b) => { writes.push(b); return answer; },
    });
    box.open();
    box.draft = 'typed';
    box.typed();
    await box.save(true);
    expect(writes).toEqual(['typed']);
    expect(box.expanded).toBe(true);
    expect(box.draft).toBe('typed');
    expect(uiStore.toasts.some((t) => t.type === 'error' && t.text.includes("couldn't be read"))).toBe(true);

    answer = 'queued';
    await box.save(true);
    body = 'typed';
    expect(box.expanded).toBe(false);
    expect(writes).toEqual(['typed', 'typed']);
  });
});

describe('NotesBox: a draft the note does not have is unsaved work', () => {
  afterEach(() => {
    for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id);
    __resetComponentFlushesForTests();
  });

  function conflictedBox(): { box: NotesBox; untrack: () => void; writes: string[] } {
    let body = 'opened\n';
    const writes: string[] = [];
    const box = new NotesBox({ path: () => 'Task.md', body: () => body, write: async (b) => { writes.push(b); return 'queued'; } });
    const untrack = box.track();
    box.open();
    // The note changed elsewhere, then the user typed.
    body = 'theirs\n';
    box.draft = 'mine';
    box.typed();
    return { box, untrack, writes };
  }

  it('a conflicted draft counts as unsaved, holds a decision, and is kept as a rescue item', async () => {
    const { box, untrack, writes } = conflictedBox();
    await box.save(false);
    expect(writes).toEqual([]);
    expect(unsavedWork().pending).toContain('task.md');
    expect(heldDecisions().map((d) => d.key)).toContain('notes-box:Task.md');
    const [item] = takeNotesBoxRescueItems();
    expect(item?.relPath).toBe('Task.md');
    expect(item?.text).toContain('mine');

    // Unmounted with the question open: still counted until it is answered.
    untrack();
    await new Promise((r) => setTimeout(r, 0));
    expect(unsavedWork().pending).toContain('task.md');
    const useTheirs = uiStore.toasts.find((t) => t.dedupeKey === 'notes-box:Task.md')?.actions?.find((a) => a.label === 'Use theirs');
    useTheirs?.handler();
    expect(unsavedWork().pending).not.toContain('task.md');
    expect(heldDecisions()).toEqual([]);
  });

  it('the save before leaving hands a typed draft to the note', async () => {
    const writes: string[] = [];
    const box = new NotesBox({ path: () => 'Task.md', body: () => 'opened\n', write: async (b) => { writes.push(b); return 'queued'; } });
    const untrack = box.track();
    box.open();
    box.draft = 'typed, not blurred';
    box.typed();
    expect(unsavedWork().pending).toContain('task.md');
    await flushAllComponents();
    expect(writes).toEqual(['typed, not blurred']);
    untrack();
  });
});

describe('NotesBox saves by itself once typing pauses', () => {
  afterEach(() => {
    vi.useRealTimers();
    __resetComponentFlushesForTests();
  });

  it('writes the draft 1.5 s after the last key, once, and keeps the box open', async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const box = new NotesBox({ path: () => 'Task.md', body: () => 'opened\n', write: async (b) => { writes.push(b); return 'queued'; } });
    const untrack = box.track();
    box.open();
    box.draft = 'typed';
    box.typed();
    await vi.advanceTimersByTimeAsync(1000);
    box.draft = 'typed more';
    box.typed();
    await vi.advanceTimersByTimeAsync(1000);
    expect(writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(600);
    expect(writes).toEqual(['typed more']);
    expect(box.expanded).toBe(true);
    untrack();
  });

  it('a box gone before the pause ends saves on its teardown, not again from the timer', async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const box = new NotesBox({ path: () => 'Task.md', body: () => 'opened\n', write: async (b) => { writes.push(b); return 'queued'; } });
    const untrack = box.track();
    box.open();
    box.draft = 'typed';
    box.typed();
    untrack();
    await vi.advanceTimersByTimeAsync(2000);
    expect(writes).toEqual(['typed']);
  });
});

describe('an open notes box follows its note until the user types (A-06)', () => {
  afterEach(() => {
    for (const x of [...uiStore.toasts]) uiStore.dismissToast(x.id);
  });

  function box(initial: string) {
    let body = initial;
    const writes: string[] = [];
    const b = new NotesBox({ path: () => 'Task.md', body: () => body, write: async (x) => { writes.push(x); return 'queued'; } });
    return { b, writes, setBody: (next: string) => { body = next; } };
  }

  it('shows the note as it is now, and writes nothing for it', async () => {
    const { b, writes, setBody } = box('first\n');
    b.open();
    setBody('changed in the Document tab\n');
    b.follow();
    expect(b.draft).toBe('changed in the Document tab\n');
    await b.save(true);
    expect(writes).toEqual([]);
  });

  it('typing after it followed writes onto the newer note, with no conflict', async () => {
    const { b, writes, setBody } = box('first\n');
    b.open();
    setBody('second\n');
    b.follow();
    b.draft = 'second, and mine';
    b.typed();
    await b.save(true);
    expect(writes).toEqual(['second, and mine']);
    expect(b.inConflict).toBe(false);
  });

  it('a box with typing in it keeps the typing, and its save asks', async () => {
    const { b, writes, setBody } = box('first\n');
    b.open();
    b.draft = 'mine';
    b.typed();
    setBody('theirs\n');
    b.follow();
    expect(b.draft).toBe('mine');
    await b.save(false);
    expect(writes).toEqual([]);
    expect(b.inConflict).toBe(true);
  });

  it('a closed box does nothing', () => {
    const { b, setBody } = box('first\n');
    setBody('second\n');
    b.follow();
    expect(b.draft).toBe('');
  });
});

/**
 * The Task List notes box: when its draft may be written, what the note store
 * says when it can't take a body, and the draft staying put when it can't.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { noteStore, type SetBodyStatus } from '@renderer/stores/notes.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { NotesBox, notesBoxDecision } from '@renderer/lib/tasklist/notesBox.svelte';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
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

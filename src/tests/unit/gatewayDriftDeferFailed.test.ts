/**
 * A note write that doesn't land must NOT report success.
 *
 * When an unsaved body meets a body another program wrote (a conflict the user
 * hasn't answered yet), or the file keeps changing under every attempt, the
 * writer keeps the change queued. It must also mark the path failed, so the
 * dirty sentinel stays dirty and `flushAll().failed` names the note (save()
 * returns false). Reporting success here would let a quit lose the body with
 * a clean sentinel and no recovery prompt.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isPathPending,
  setWriteStateListener,
  __resetDirtyTrackingForTests,
  type WriteStateInfo,
} from '@renderer/lib/boards/writeStateTracking';
import { noteStore, setNotePromptHandlers, type NoteModel } from '@renderer/stores/notes.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

const prompts = { conflict: vi.fn(), deletedWithUnsavedBody: vi.fn(), reloadShrank: vi.fn(), dismiss: vi.fn() };

describe('note writes that do not land are reported as failed', () => {
  let vault: MemoryVault;
  let lastState: WriteStateInfo | null;

  beforeEach(() => {
    __resetDirtyTrackingForTests();
    vaultStore.setPath('/vault');
    noteStore.__resetForTests();
    for (const fn of Object.values(prompts)) fn.mockReset();
    setNotePromptHandlers(prompts);
    vault = installMemoryVault({
      'Dirty.md': '---\ntitle: Dirty\n---\nBase\n',
      'Churn.md': '---\ntitle: Churn\n---\nBase\n',
    });
    lastState = null;
    setWriteStateListener((s) => {
      lastState = { ...s };
    });
  });
  afterEach(() => {
    setWriteStateListener(null);
    noteStore.__resetForTests();
    __resetDirtyTrackingForTests();
    vaultStore.setPath('');
    restoreFiloDefault();
  });

  async function editWhileTheyEdit(rel: string): Promise<NoteModel> {
    const m = noteStore.acquire(rel, 'view');
    await m.loaded;
    noteStore.setBody(rel, 'Mine', 'view');
    vault.writeExternally(rel, `---\ntitle: ${rel}\n---\nTheirs\n`);
    return m;
  }

  it('a body held by an unanswered conflict fails, marks the path failed, and keeps the sentinel dirty', async () => {
    const m = await editWhileTheyEdit('Dirty.md');

    expect(await noteStore.flush('Dirty.md')).toBe(false);

    expect(m.status).toBe('conflict');
    expect(vault.read('Dirty.md')).toBe('---\ntitle: Dirty.md\n---\nTheirs\n');
    expect(isPathPending('Dirty.md')).toBe(true);
    expect(lastState).not.toBeNull();
    expect(lastState!.failed).toBeGreaterThan(0);
    expect(lastState!.failedPaths.map((p) => p.toLowerCase())).toContain('dirty.md');
  });

  it('a file that keeps changing under every attempt fails the path instead of overwriting it', async () => {
    let n = 0;
    vault.afterRead = (rel) => {
      if (rel !== 'Churn.md') return;
      // Another program rewrites the file after each of our reads.
      queueMicrotask(() => vault.writeExternally('Churn.md', `---\ntitle: Churn\nrev: ${++n}\n---\nBase\n`));
    };
    noteStore.patchFrontmatter('Churn.md', { set: { status: 'mine' }, unset: [] });

    expect(await noteStore.flush('Churn.md')).toBe(false);

    expect(vault.read('Churn.md')).not.toContain('status: mine');
    expect(isPathPending('Churn.md')).toBe(true);
  });

  it('a note deleted before its write is not recreated, and the path is failed', async () => {
    noteStore.patchFrontmatter('Churn.md', { set: { status: 'mine' }, unset: [] });
    vault.remove('Churn.md');

    expect(await noteStore.flush('Churn.md')).toBe(false);

    expect(vault.read('Churn.md')).toBeUndefined();
    expect(isPathPending('Churn.md')).toBe(true);
    expect(lastState!.failedPaths.map((p) => p.toLowerCase())).toContain('churn.md');
  });

  it('flushAll names the held note in failed[] (save() would return false)', async () => {
    await editWhileTheyEdit('Dirty.md');

    const result = await noteStore.flushAll();

    expect(result.failed.map((p) => p.toLowerCase())).toContain('dirty.md');
    expect(isPathPending('Dirty.md')).toBe(true);
  });

  it('once the user keeps theirs, the write lands and the path is no longer pending', async () => {
    await editWhileTheyEdit('Dirty.md');
    await noteStore.flush('Dirty.md');

    await noteStore.resolveConflict('Dirty.md', 'keep-mine');

    expect(vault.read('Dirty.md')).toBe('---\ntitle: Dirty.md\n---\nMine\n');
    expect(isPathPending('Dirty.md')).toBe(false);
    expect((await noteStore.flushAll()).failed).toEqual([]);
  });
});

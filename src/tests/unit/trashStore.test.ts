import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { trashStore, purgeExpiredTrash, toastMovedToTrash, restoreTrashedItem } from '@renderer/stores/trash.svelte';
import { vaultStore } from '@renderer/stores/vault.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { beginVaultGeneration, captureVaultIdentity, __resetVaultIdentityForTests } from '@renderer/lib/vault/vaultIdentity';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

/**
 * Filo's trash from the renderer: Settings → Trash lists and restores items,
 * "Empty trash" sends them to the Recycle Bin, and when the Recycle Bin
 * refuses, nothing is deleted until the user answers "Delete permanently?".
 */

let vault: MemoryVault;
type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

/** Answer the open confirm dialog. */
async function answer(confirm: boolean): Promise<void> {
  await vi.waitFor(() => expect(uiStore.confirmDialog).not.toBeNull());
  const dialog = uiStore.confirmDialog!;
  uiStore.closeConfirm();
  if (confirm) dialog.onConfirm(false);
  else dialog.onCancel?.();
}

beforeEach(() => {
  __resetVaultIdentityForTests();
  vault = installMemoryVault({ 'Notes/A.md': 'alpha\n', 'B.md': 'beta\n' });
  vaultStore.setPath('/vault');
  beginVaultGeneration('/vault');
  vi.spyOn(vaultStore, 'enqueueRenameQueueWork').mockImplementation(async () => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  uiStore.closeConfirm();
  noteStore.__resetForTests();
  vaultStore.setPath('');
  restoreFiloDefault();
});

async function trash(rel: string): Promise<string> {
  const r = (await window.filo.invoke('vault:trash-move', '/vault', rel)) as { trashId: string };
  return r.trashId;
}

describe('Settings → Trash', () => {
  it('lists what is in the trash and restores an item to where it was', async () => {
    await trash('Notes/A.md');
    await trashStore.refresh();
    expect(trashStore.entries.map((e) => e.originalPath)).toEqual(['Notes/A.md']);

    await trashStore.restore(trashStore.entries[0]!);
    expect(vault.read('Notes/A.md')).toBe('alpha\n');
    expect(trashStore.entries).toEqual([]);
  });

  it('an open note that went missing reads its file again once it is restored', async () => {
    const m = noteStore.acquire('B.md', 'view-1');
    await m.loaded;
    await trash('B.md');
    noteStore.forgetDeleted('B.md');
    expect(noteStore.get('B.md')?.status).toBe('missing');

    await trashStore.refresh();
    await trashStore.restore(trashStore.entries[0]!);
    await vi.waitFor(() => expect(noteStore.get('B.md')?.status).toBe('ready'));
    expect(noteStore.get('B.md')?.body).toBe('beta\n');
    noteStore.release('B.md', 'view-1');
  });

  it('Empty trash sends every item to the Recycle Bin after a confirm', async () => {
    await trash('Notes/A.md');
    await trash('B.md');
    await trashStore.refresh();
    const emptied = trashStore.empty();
    await answer(true);
    await emptied;
    expect(vault.trash.size).toBe(0);
    expect(trashStore.entries).toEqual([]);
  });

  it('when the Recycle Bin refuses, nothing is deleted until the user says "Delete permanently"', async () => {
    const id = await trash('B.md');
    await trashStore.refresh();
    const base = window.filo.invoke as Invoke;
    const calls: string[] = [];
    window.filo.invoke = (async (channel: string, ...args: unknown[]) => {
      calls.push(channel);
      if (channel === 'vault:trash-purge') {
        return { success: false, code: 'TRASH_FAILED', purged: [], failed: [{ trashId: id, originalPath: 'B.md' }] };
      }
      return base(channel, ...args);
    }) as typeof window.filo.invoke;

    const emptied = trashStore.empty();
    await answer(true); // "Empty Filo's trash?"
    await vi.waitFor(() => expect(uiStore.confirmDialog?.title).toBe('Delete permanently?'));
    expect(uiStore.confirmDialog?.body).toContain('B.md');
    await answer(false); // keep it
    await emptied;
    expect(calls).not.toContain('vault:trash-delete-permanently');
    expect(vault.trash.has(id)).toBe(true);

    const again = trashStore.empty();
    await answer(true);
    await vi.waitFor(() => expect(uiStore.confirmDialog?.title).toBe('Delete permanently?'));
    await answer(true);
    await again;
    expect(calls).toContain('vault:trash-delete-permanently');
    expect(vault.trash.has(id)).toBe(false);
  });
});

describe('the 30-day purge on vault open', () => {
  it('asks the Recycle Bin for this machine\'s old items only, and never blocks on a refusal it can\'t resolve', async () => {
    const base = window.filo.invoke as Invoke;
    const seen: unknown[][] = [];
    window.filo.invoke = (async (channel: string, ...args: unknown[]) => {
      if (channel === 'vault:trash-purge') seen.push(args);
      return base(channel, ...args);
    }) as typeof window.filo.invoke;
    await purgeExpiredTrash('/vault', captureVaultIdentity());
    expect(seen).toEqual([['/vault', 'olderThan30d']]);
  });
});

describe('board delete toast', () => {
  it('Undo moves the board file back', async () => {
    vault.writeExternally('Plan.board.json', '{"version":8}');
    const id = await trash('Plan.board.json');
    toastMovedToTrash('Plan', async () => { await restoreTrashedItem('Plan', 'Plan.board.json', id); });
    const toast = uiStore.toasts.find((t) => t.text.includes("moved to Filo's trash"));
    expect(toast?.actions?.map((a) => a.label)).toEqual(['Undo']);
    uiStore.invokeToastAction(toast!.id, 0);
    await vi.waitFor(() => expect(vault.read('Plan.board.json')).toBe('{"version":8}'));
  });
});

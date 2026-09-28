/**
 * A loaded note meeting a change on disk, at the edges:
 * - a read that fails for a moment is tried again, not dropped;
 * - once another program's version is taken, Filo's earlier bytes turning up
 *   again are that program's doing, not an echo;
 * - a read that started before one of Filo's own writes landed never rolls
 *   that write back;
 * - a disk body identical to the unsaved one is no conflict, in the watcher
 *   and in the writer;
 * - "deleted with unsaved edits" stays a held decision while the file is gone;
 * - Keep mine / Reload leave the decision held when the answer didn't settle
 *   it, and Keep mine on a vanished file offers Save as new file.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { noteStore } from '@renderer/stores/notes.svelte';
import { registerNotePrompts } from '@renderer/stores/notePrompts';
import { heldDecisions } from '@renderer/stores/heldDecisions';
import { uiStore } from '@renderer/stores/ui.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { setActiveVaultPath } from '@renderer/lib/vault/activeVaultPath';
import { beginVaultGeneration, __resetVaultIdentityForTests } from '@renderer/lib/vault/vaultIdentity';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import { __resetKeepLocalBackupForTests } from '@renderer/lib/vault/keepLocalBackup';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

const REL = 'Note.md';
const note = (body: string, title = 'Note'): string => `---\ntitle: ${title}\n---\n${body}\n`;

let vault: MemoryVault;
/** What `recovery:snapshot` answers; null means the memory vault's default (no answer). */
let snapshotFails: string | null;

function clearToasts(): void {
  for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
}

function toast(fragment: string) {
  return uiStore.toasts.find((t) => t.text.includes(fragment));
}

async function loaded(): Promise<ReturnType<typeof noteStore.acquire>> {
  const m = noteStore.acquire(REL, 'tile');
  await m.loaded;
  return m;
}

beforeEach(() => {
  __resetDirtyTrackingForTests();
  __resetVaultIdentityForTests();
  __resetKeepLocalBackupForTests();
  beginVaultGeneration('/vault');
  setActiveVaultPath('/vault');
  vault = installMemoryVault({ [REL]: note('Start') });
  snapshotFails = null;
  const inner = vi.mocked(window.filo.invoke).getMockImplementation();
  if (!inner) throw new Error('memory vault has no invoke');
  vi.mocked(window.filo.invoke).mockImplementation(async (channel: string, ...args: unknown[]) => {
    if (channel === 'recovery:snapshot') {
      return snapshotFails
        ? { success: false, code: snapshotFails, error: snapshotFails }
        : { success: true, path: '/vault/.filo/recovery/backup.md' };
    }
    return Reflect.apply(inner, undefined, [channel, ...args]);
  });
  vaultIndexStore.clear();
  noteStore.__resetForTests();
  clearToasts();
  registerNotePrompts();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  noteStore.__resetForTests();
  clearToasts();
  restoreFiloDefault();
  vi.restoreAllMocks();
});

describe('a read that fails for a moment', () => {
  it('is tried again, and the model takes the change', async () => {
    const m = await loaded();
    vault.writeExternally(REL, note('Theirs'));
    vault.failNextRead(REL, 'EBUSY');
    await noteStore.onDiskChanged(REL);
    expect(m.body).toBe('Start\n');
    await vi.waitFor(() => expect(m.body).toBe('Theirs\n'), { timeout: 3000 });
  });
});

describe('Filo\'s own bytes after another program\'s version', () => {
  it('are reported when they turn up again, not taken as an echo', async () => {
    const m = await loaded();
    noteStore.setBody(REL, 'Mine', 'tile');
    expect(await noteStore.flush(REL)).toBe(true);
    const ours = vault.read(REL)!;
    vault.writeExternally(REL, note('Theirs'));
    await noteStore.onDiskChanged(REL);
    expect(m.body).toBe('Theirs\n');
    // A sync client puts Filo's version back.
    vault.writeExternally(REL, ours);
    await noteStore.onDiskChanged(REL);
    expect(m.body).toBe('Mine\n');
  });
});

describe('a read that started before Filo\'s own write landed', () => {
  it('doesn\'t roll the write back', async () => {
    const m = await loaded();
    noteStore.setBody(REL, 'Mine', 'tile');
    let once = true;
    vault.duringRead = async () => {
      if (!once) return;
      once = false;
      vault.duringRead = null;
      // The write lands while this read holds the older bytes.
      expect(await noteStore.flush(REL)).toBe(true);
    };
    await noteStore.onDiskChanged(REL);
    expect(m.body).toBe('Mine');
    expect(m.status).toBe('ready');
    expect(vault.read(REL)).toBe(note('Mine'));
  });
});

describe('the disk already holds the unsaved body', () => {
  it('the watcher takes it as the base, with no conflict', async () => {
    const m = await loaded();
    noteStore.setBody(REL, 'Mine', 'tile');
    vault.writeExternally(REL, note('Mine', 'Synced'));
    await noteStore.onDiskChanged(REL);
    expect(m.status).toBe('ready');
    expect(toast('changed by another program')).toBeUndefined();
    expect(m.hasUnsavedBody).toBe(false);
    expect(noteStore.hasPendingWrites(REL)).toBe(false);
    expect(m.frontmatter.title).toBe('Synced');
    expect(m.base?.rawText).toBe(note('Mine', 'Synced'));
  });

  it('the writer writes nothing and moves the base, with no conflict', async () => {
    const m = await loaded();
    noteStore.setBody(REL, 'Mine', 'tile');
    vault.writeExternally(REL, note('Mine', 'Synced'));
    const mdWrites = (): number => vault.writes.filter(([, rel]) => rel.endsWith('.md')).length;
    const writes = mdWrites();
    expect(await noteStore.flush(REL)).toBe(true);
    expect(m.status).toBe('ready');
    expect(toast('changed by another program')).toBeUndefined();
    expect(mdWrites()).toBe(writes);
    expect(m.hasUnsavedBody).toBe(false);
    expect(m.base?.rawText).toBe(note('Mine', 'Synced'));
  });
});

describe('deleted by another program with unsaved edits', () => {
  it('stays a held decision while the file is gone and the edit unsaved', async () => {
    await loaded();
    noteStore.setBody(REL, 'Mine', 'tile');
    vault.remove(REL);
    await noteStore.onDiskChanged(REL);
    await noteStore.__settleGraceChecksForTests();
    expect(toast('deleted by another program')).toBeDefined();
    expect(heldDecisions().map((d) => d.key)).toContain(`ext-deleted:${REL}`);
  });
});

describe('answering a conflict', () => {
  async function conflicted(): Promise<ReturnType<typeof noteStore.acquire>> {
    const m = await loaded();
    noteStore.setBody(REL, 'Mine', 'tile');
    vault.writeExternally(REL, note('Theirs'));
    expect(await noteStore.flush(REL)).toBe(false);
    expect(m.status).toBe('conflict');
    return m;
  }

  it('Keep mine whose backup is declined leaves the decision held', async () => {
    const m = await conflicted();
    snapshotFails = 'EBUSY';
    vi.spyOn(uiStore, 'confirmAsync').mockResolvedValue(false);
    await toast('changed by another program')?.actions?.find((a) => a.label === 'Keep mine')?.handler();
    expect(m.status).toBe('conflict');
    expect(vault.read(REL)).toBe(note('Theirs'));
    expect(heldDecisions().map((d) => d.key)).toContain(`ext-mod:${REL}`);
  });

  it('Keep mine that finds the file gone offers Save as new file', async () => {
    const m = await conflicted();
    vault.remove(REL);
    await toast('changed by another program')?.actions?.find((a) => a.label === 'Keep mine')?.handler();
    expect(m.status).toBe('ready');
    expect(m.hasUnsavedBody).toBe(true);
    const missing = toast('no longer exists');
    expect(missing?.actions?.map((a) => a.label)).toContain('Save as new file');
    await missing?.actions?.find((a) => a.label === 'Save as new file')?.handler();
    expect(vault.read(REL)).toBe(note('Mine'));
    expect(heldDecisions().map((d) => d.key)).not.toContain(`ext-mod:${REL}`);
  });
});

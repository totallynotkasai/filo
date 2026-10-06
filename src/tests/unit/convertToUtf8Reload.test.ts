/**
 * "Convert to UTF-8" on a note that isn't UTF-8:
 * - the note stays read-only until its views show the converted text, so no
 *   key can be typed on the old decode (with its U+FFFD characters) in between;
 * - the re-read that follows goes through the same check as any change on
 *   disk: a body still queued meets the converted one as a conflict, and is
 *   never written over it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { noteStore, setNotePromptHandlers } from '@renderer/stores/notes.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { setActiveVaultPath } from '@renderer/lib/vault/activeVaultPath';
import { beginVaultGeneration, __resetVaultIdentityForTests } from '@renderer/lib/vault/vaultIdentity';
import { __resetDirtyTrackingForTests } from '@renderer/lib/boards/writeStateTracking';
import {
  holdReadOnlyWhileConverting,
  isNonUtf8,
  noteReadEncoding,
  __resetNonUtf8PathsForTests,
} from '@renderer/lib/vault/nonUtf8Paths.svelte';
import { renameAllPathKeys } from '@renderer/lib/vault/renamePathKeys';
import { confirmConvertToUtf8 } from '@renderer/lib/vault/convertToUtf8';
import { installMemoryVault, type MemoryVault } from '../helpers/memoryVault';
import { restoreFiloDefault } from '../helpers/filoBridge';

const REL = 'Café.md';
const DECODED = '---\ntitle: Café\n---\nCaf� au lait\n';
const CONVERTED = '---\ntitle: Café\n---\nCafé au lait\n';

let vault: MemoryVault;
const prompts = {
  conflict: vi.fn(),
  deletedWithUnsavedBody: vi.fn(),
  writeTargetMissing: vi.fn(),
  reloadShrank: vi.fn(),
  reloadedOverTyping: vi.fn(),
  confirmReloadWithoutCopy: vi.fn(async () => false),
  dismiss: vi.fn(),
};

beforeEach(() => {
  __resetDirtyTrackingForTests();
  __resetVaultIdentityForTests();
  __resetNonUtf8PathsForTests();
  beginVaultGeneration('/vault');
  setActiveVaultPath('/vault');
  vault = installMemoryVault({ [REL]: DECODED });
  vaultIndexStore.clear();
  noteStore.__resetForTests();
  for (const fn of Object.values(prompts)) fn.mockReset();
  setNotePromptHandlers(prompts);
});

afterEach(() => {
  noteStore.__resetForTests();
  __resetNonUtf8PathsForTests();
  for (const t of [...uiStore.toasts]) uiStore.dismissToast(t.id, { silent: true });
  restoreFiloDefault();
});

describe('a forced reload with a body still queued', () => {
  it('meets the new version as a conflict and never writes the queued body over it', async () => {
    const m = noteStore.acquire(REL, 'doc');
    await m.loaded;
    // A keystroke lands on the text as shown (the replacement-character text).
    noteStore.setBody(REL, 'Caf� au lait, typed\n', 'doc');
    // The file is now the converted UTF-8 text, and the note is re-read.
    vault.writeExternally(REL, CONVERTED);
    await noteStore.reload(REL);
    await noteStore.flush(REL);

    expect(vault.read(REL)).toBe(CONVERTED);
    expect(prompts.conflict).toHaveBeenCalledTimes(1);
    expect(m.status).toBe('conflict');
    noteStore.release(REL, 'doc');
  });

  it('with nothing unsaved, the new version is simply taken', async () => {
    const m = noteStore.acquire(REL, 'doc');
    await m.loaded;
    vault.writeExternally(REL, CONVERTED);
    await noteStore.reload(REL);
    expect(m.body).toBe('Café au lait\n');
    expect(m.status).toBe('ready');
    expect(prompts.conflict).not.toHaveBeenCalled();
    noteStore.release(REL, 'doc');
  });
});

describe('Convert to UTF-8', () => {
  it('keeps the note read-only until the converted text is loaded', async () => {
    vault.nonUtf8.add(REL.toLowerCase());
    noteReadEncoding(REL, 'invalid-utf-8');
    const m = noteStore.acquire(REL, 'doc');
    await m.loaded;
    expect(isNonUtf8(REL)).toBe(true);

    // Main converts the bytes; every read after that reports UTF-8.
    const memoryInvoke = (window as unknown as { filo: { invoke: (c: string, ...a: unknown[]) => Promise<unknown> } }).filo.invoke;
    const readOnlyDuringReads: boolean[] = [];
    let converted = false;
    vault.duringRead = (rel) => {
      if (converted && rel === REL) readOnlyDuringReads.push(isNonUtf8(REL));
    };
    (window as unknown as { filo: { invoke: unknown } }).filo.invoke = async (channel: string, ...args: unknown[]) => {
      if (channel === 'vault:convert-to-utf8') {
        vault.writeExternally(REL, CONVERTED);
        vault.nonUtf8.delete(REL.toLowerCase());
        converted = true;
        return { success: true };
      }
      return memoryInvoke(channel, ...args);
    };

    confirmConvertToUtf8('/vault', REL);
    uiStore.confirmDialog?.onConfirm(false);
    await vi.waitFor(() => expect(uiStore.toasts.some((t) => t.text.startsWith('Converted'))).toBe(true));

    // Every read that loaded the converted text still found the note frozen.
    expect(readOnlyDuringReads.length).toBeGreaterThan(0);
    expect(readOnlyDuringReads.every(Boolean)).toBe(true);
    expect(m.body).toBe('Café au lait\n');
    expect(isNonUtf8(REL)).toBe(false);
    noteStore.release(REL, 'doc');
  });

  it('the hold follows a rename, and each hold releases only itself', () => {
    const release = holdReadOnlyWhileConverting('Notes/Café.md');
    renameAllPathKeys('Notes', 'Archive');
    expect(isNonUtf8('Archive/Café.md')).toBe(true);
    expect(isNonUtf8('Notes/Café.md')).toBe(false);
    const other = holdReadOnlyWhileConverting('Archive/Café.md');
    release();
    expect(isNonUtf8('Archive/Café.md')).toBe(true);
    other();
    expect(isNonUtf8('Archive/Café.md')).toBe(false);
  });
});

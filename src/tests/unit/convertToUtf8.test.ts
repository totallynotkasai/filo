/**
 * The renderer half of "Convert to UTF-8…": it confirms first, calls
 * `vault:convert-to-utf8`, clears the note's read-only non-UTF-8 flag and
 * re-reads the open note, so its views drop the U+FFFD-decoded text; a failure
 * (incl. UTF-16) leaves the flag set so the note stays protected. (The
 * main-side byte conversion + backup is covered by readFileNonUtf8.test.ts
 * against a real temp dir.)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { confirmConvertToUtf8 } from '@renderer/lib/vault/convertToUtf8';
import { isNonUtf8, noteReadEncoding, __resetNonUtf8PathsForTests } from '@renderer/lib/vault/nonUtf8Paths.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { noteStore } from '@renderer/stores/notes.svelte';
import { setActiveVaultPath } from '@renderer/lib/vault/activeVaultPath';
import { beginVaultGeneration, __resetVaultIdentityForTests } from '@renderer/lib/vault/vaultIdentity';

describe('confirmConvertToUtf8', () => {
  let calls: string[];
  let convertResult: Record<string, unknown>;
  let converted: boolean;

  beforeEach(() => {
    calls = [];
    converted = false;
    convertResult = { success: true, converted: true };
    __resetNonUtf8PathsForTests();
    __resetVaultIdentityForTests();
    beginVaultGeneration('/vault');
    setActiveVaultPath('/vault');
    noteStore.__resetForTests();
    noteReadEncoding('Legacy.md', 'invalid-utf-8');
    vi.spyOn(vaultIndexStore, 'applyChanges').mockResolvedValue(undefined);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    (window as unknown as Record<string, unknown>).filo = {
      invoke: async (channel: string) => {
        calls.push(channel);
        if (channel === 'vault:convert-to-utf8') {
          if (convertResult.success) converted = true;
          return convertResult;
        }
        if (channel === 'vault:read-file-text') {
          return converted
            ? { success: true, content: 'Réunion\n', encoding: 'utf-8', mtimeMs: 2, size: 9 }
            : { success: true, content: 'R�union\n', encoding: 'invalid-utf-8', mtimeMs: 1, size: 8 };
        }
        return { success: true };
      },
      on: () => () => {},
      send: () => {},
    };
  });

  afterEach(() => {
    uiStore.closeConfirm();
    noteStore.__resetForTests();
    setActiveVaultPath('');
    vi.restoreAllMocks();
    delete (window as unknown as Record<string, unknown>).filo;
    __resetNonUtf8PathsForTests();
  });

  it('does nothing until the user confirms', () => {
    confirmConvertToUtf8('/vault', 'Legacy.md');
    expect(uiStore.confirmDialog?.confirmLabel).toBe('Convert to UTF-8');
    expect(calls).toEqual([]);
    expect(isNonUtf8('Legacy.md')).toBe(true);
  });

  it('on confirm converts, clears the non-UTF-8 flag and re-reads the open note', async () => {
    const model = noteStore.acquire('Legacy.md', 'doc');
    await model.loaded;
    expect(model.body).toBe('R�union\n');
    expect(model.readOnly).toBe(true);
    calls = [];

    const onConverted = vi.fn();
    confirmConvertToUtf8('/vault', 'Legacy.md', onConverted);
    uiStore.confirmDialog?.onConfirm(false);
    await vi.waitFor(() => expect(onConverted).toHaveBeenCalled());
    expect(calls[0]).toBe('vault:convert-to-utf8');
    expect(calls).toContain('vault:read-file-text');
    expect(isNonUtf8('Legacy.md')).toBe(false);
    expect(model.body).toBe('Réunion\n');
    expect(model.readOnly).toBe(false);
    expect(uiStore.toasts.some((t) => t.text.includes('Converted "Legacy.md" to UTF-8'))).toBe(true);
  });

  it('a refused conversion (UTF-16) keeps the note flagged and read-only', async () => {
    convertResult = { success: false, code: 'UTF16', error: 'UTF-16' };
    const onConverted = vi.fn();
    confirmConvertToUtf8('/vault', 'Legacy.md', onConverted);
    uiStore.confirmDialog?.onConfirm(false);
    await vi.waitFor(() => expect(calls).toContain('vault:convert-to-utf8'));
    await new Promise((r) => setTimeout(r, 0));
    expect(onConverted).not.toHaveBeenCalled();
    expect(isNonUtf8('Legacy.md')).toBe(true);
  });
});

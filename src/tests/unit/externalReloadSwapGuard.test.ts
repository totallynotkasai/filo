/**
 * Audit-13 L17 — the async external-edit "Reload" toast handlers re-read disk via
 * `vaultIndexStore.applyChanges([rel])` and then synchronously mutate stores
 * (the open editor's body + frontmatter) keyed by the relative path. A vault
 * swap landing on that `await` would apply the OUTGOING vault's disk content to
 * the NEW vault's same-named file. The fix captures `captureVaultIdentity()` at
 * the top of each handler and bails via `isStillSameVault` after the re-read.
 *
 * `promptExternalEditOnSync` is the exported representative of the four sibling
 * handlers (the others — `promptBulkExternalChanges` "Reload all",
 * `promptModifiedFile` "Reload", `promptPartialReadExhausted` "Reload from disk"
 * — share the identical capture-then-bail shape and are pinned structurally by
 * `scripts/gates:reconciler-vault-guard`'s `applyChanges` trigger). This drives the
 * Reload action directly: a swap during `applyChanges` must `defer` without
 * touching any store; with no swap it applies and resolves `'reload'`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promptExternalEditOnSync } from '@renderer/stores/vaultExternalChanges';
import { uiStore } from '@renderer/stores/ui.svelte';
import { vaultIndexStore } from '@renderer/stores/vaultIndex.svelte';
import { documentStore } from '@renderer/stores/document.svelte';
import {
  beginVaultGeneration,
  __resetVaultIdentityForTests,
} from '@renderer/lib/vault/vaultIdentity';
import type { FileMetadata } from '@renderer/lib/vault/vaultIndex';
import { restoreFiloDefault } from '../helpers/filoBridge';

interface CapturedAction {
  label: string;
  handler: () => void;
}

/** Spies `pushToast` and returns a getter for the Reload action it captured. */
function captureReloadAction(): () => CapturedAction {
  let actions: CapturedAction[] = [];
  vi.spyOn(uiStore, 'pushToast').mockImplementation((spec) => {
    if (spec.actions) actions = spec.actions as unknown as CapturedAction[];
    return 'toast-id';
  });
  return () => {
    const reload = actions.find((a) => a.label === 'Reload');
    if (!reload) throw new Error('Reload action was not captured');
    return reload;
  };
}

function freshMetadata(path: string): FileMetadata {
  return {
    path,
    title: path,
    headings: [],
    tags: [],
    frontmatter: { tags: [] },
    links: [],
    content: 'disk body',
    lastModified: 42,
    rawFrontmatter: '',
    rawByteSize: 9,
  };
}

/** Opens an editor on `path` so the Reload handler has a document to refresh. */
function openEditor(path: string): string {
  documentStore.loadDocument({
    filename: path,
    title: path,
    body: 'local body',
    htmlContent: '',
    richText: [],
  });
  return path;
}

describe('Audit-13 L17 — external-reload handlers bail on a mid-applyChanges vault swap', () => {
  beforeEach(() => {
    __resetVaultIdentityForTests();
    documentStore.clear();
    vaultIndexStore.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    __resetVaultIdentityForTests();
    documentStore.clear();
    vaultIndexStore.clear();
    restoreFiloDefault();
  });

  it('Reload defers (no store mutation) when the vault swaps during applyChanges', async () => {
    beginVaultGeneration('/vault-A');
    const notePath = openEditor('l17-swap.md');
    const getReload = captureReloadAction();
    const reloadSpy = vi.spyOn(documentStore, 'applyReloadFromDisk');
    // applyChanges resolves AFTER bumping the vault generation — i.e. the vault
    // swapped to B while the re-read was in flight.
    vi.spyOn(vaultIndexStore, 'applyChanges').mockImplementation(async () => {
      beginVaultGeneration('/vault-B');
    });

    const settled = promptExternalEditOnSync({ path: 'l17-swap.md' });
    getReload().handler();
    const result = await settled;

    // Guard fired: defer the writer, and the editor was not refreshed with the
    // outgoing vault's content.
    expect(result).toBe('defer');
    expect(reloadSpy).not.toHaveBeenCalled();
    expect(documentStore.getDocument(notePath)?.body).toBe('local body');
  });

  it('control: Reload applies disk content + resolves "reload" when no swap occurs', async () => {
    beginVaultGeneration('/vault-A');
    const notePath = openEditor('l17-control.md');
    const getReload = captureReloadAction();
    const reloadSpy = vi.spyOn(documentStore, 'applyReloadFromDisk');
    vi.spyOn(vaultIndexStore, 'applyChanges').mockResolvedValue(undefined);
    vi.spyOn(vaultIndexStore, 'getMetadata').mockReturnValue(
      freshMetadata('l17-control.md'),
    );

    const settled = promptExternalEditOnSync({ path: 'l17-control.md' });
    getReload().handler();
    const result = await settled;

    expect(result).toBe('reload');
    expect(reloadSpy).toHaveBeenCalledWith(
      notePath,
      'disk body',
      expect.anything(),
      { tags: [] },
      '',
      { mtimeMs: 42, size: 9 },
    );
  });
});

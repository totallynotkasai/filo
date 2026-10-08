import type { LayoutTemplate } from '../schema/index';
import { vaultStore } from './vault.svelte';
import { uiStore } from './ui.svelte';
import { reportError } from '../lib/utils/errorBus';
import {
  listLayoutTemplates,
  saveLayoutTemplate,
  renameLayoutTemplate,
  deleteLayoutTemplate,
  type LayoutTemplateRecord,
} from '../lib/templates/layoutTemplateStore';
import { onVaultSwap } from '../core/vaultLifecycle';
import { captureVaultIdentity, isStillSameVault } from '../lib/vault/vaultIdentity';

/**
 * Reactive cache of layout templates from `<vault>/.filo/templates/`.
 * Components read `templatesStore.records` and call the mutation methods
 * to persist + refresh.
 */

let records = $state<LayoutTemplateRecord[]>([]);
let loaded = $state(false);
let loading = $state(false);

/**
 * Optional anchor (canvas-space) for the next template insertion.
 * Set by the canvas right-click handler before opening the browser so
 * the inserted layout lands where the user clicked. Cleared after use
 * or when the browser opens via Ctrl+T (which falls back to the
 * viewport centre).
 */
let pendingInsertAnchor = $state<{ x: number; y: number } | null>(null);

/**
 * The Template Browser was opened for a new board (the New Tab menu's "New
 * board from template…"): it lists only the templates that make a board,
 * even over a Mind Map.
 */
let newBoardOnly = $state(false);

async function refresh(): Promise<void> {
  const root = vaultStore.path;
  if (!root) {
    records = [];
    loaded = true;
    return;
  }
  // Capture identity before the list await: a swap during the read would
  // otherwise stamp the outgoing vault's templates into this cache after the
  // pre-swap reset cleared it.
  const identity = captureVaultIdentity();
  loading = true;
  try {
    const next = await listLayoutTemplates(root);
    if (!isStillSameVault(identity)) return;
    records = next;
    loaded = true;
  } catch (err) {
    reportError('templates.refresh', err, 'Failed to load layout templates');
  } finally {
    // Only release the spinner if we're still the active vault — a swap that
    // bailed above already had `loading` reset by the pre-swap handler.
    if (isStillSameVault(identity)) loading = false;
  }
}

export const templatesStore = {
  get records(): LayoutTemplateRecord[] {
    return records;
  },
  get loaded(): boolean {
    return loaded;
  },
  get loading(): boolean {
    return loading;
  },
  get pendingInsertAnchor(): { x: number; y: number } | null {
    return pendingInsertAnchor;
  },
  get newBoardOnly(): boolean {
    return newBoardOnly;
  },

  /**
   * Opens the Template Browser. Over a Mind Map it lists every template (a
   * layout or a note goes on the canvas, a board template makes a board);
   * anywhere else, and with `newBoard`, only the templates that make a board.
   */
  openBrowser(opts: { newBoard?: boolean } = {}): void {
    newBoardOnly = opts.newBoard === true;
    uiStore.openModal('template-picker');
  },

  setPendingInsertAnchor(anchor: { x: number; y: number } | null): void {
    pendingInsertAnchor = anchor;
  },

  consumePendingInsertAnchor(): { x: number; y: number } | null {
    const a = pendingInsertAnchor;
    pendingInsertAnchor = null;
    return a;
  },

  async load(): Promise<void> {
    await refresh();
  },

  hasName(name: string, excludeId?: string): boolean {
    const target = name.trim().toLowerCase();
    return records.some(
      (r) => r.template.name.trim().toLowerCase() === target && r.template.id !== excludeId,
    );
  },

  async save(template: LayoutTemplate): Promise<void> {
    const root = vaultStore.path;
    if (!root) throw new Error('No vault open');
    await saveLayoutTemplate(root, template);
    await refresh();
  },

  async rename(id: string, newName: string): Promise<void> {
    const root = vaultStore.path;
    if (!root) throw new Error('No vault open');
    const existing = records.find((r) => r.template.id === id);
    if (!existing) throw new Error('Template not found');
    const next: LayoutTemplate = {
      ...existing.template,
      name: newName.trim(),
      updatedAt: Date.now(),
    };
    await renameLayoutTemplate(root, existing.filename, next);
    await refresh();
  },

  async delete(id: string): Promise<void> {
    const root = vaultStore.path;
    if (!root) throw new Error('No vault open');
    const existing = records.find((r) => r.template.id === id);
    if (!existing) return;
    await deleteLayoutTemplate(root, existing.filename);
    await refresh();
  },
};

// Vault-swap reset: drop the template cache and pending insert anchor so the
// next vault's TemplateBrowser re-fetches instead of rendering stale entries.
onVaultSwap('pre-swap', 'templates', () => {
  records = [];
  loaded = false;
  loading = false;
  pendingInsertAnchor = null;
  newBoardOnly = false;
});

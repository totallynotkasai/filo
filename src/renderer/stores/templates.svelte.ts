import type { LayoutTemplate } from '../schema/index';
import { vaultStore } from './vault.svelte';
import { reportError } from '../lib/utils/errorBus';
import {
  listLayoutTemplates,
  saveLayoutTemplate,
  renameLayoutTemplate,
  deleteLayoutTemplate,
  type LayoutTemplateRecord,
} from '../lib/templates/layoutTemplateStore';
import { onVaultSwap } from '../core/vaultLifecycle';

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

async function refresh(): Promise<void> {
  const root = vaultStore.path;
  if (!root) {
    records = [];
    loaded = true;
    return;
  }
  loading = true;
  try {
    records = await listLayoutTemplates(root);
    loaded = true;
  } catch (err) {
    reportError('templates.refresh', err, 'Failed to load layout templates');
  } finally {
    loading = false;
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

// Phase 4 (Consolidation 2026-05-25) — vault-swap reset registration.
// Drops the per-vault template cache and the pending insert anchor so the
// next vault's TemplateBrowser opens empty and re-fetches against the new
// `.filo/templates/` directory rather than rendering stale entries.
onVaultSwap('pre-swap', 'templates', () => {
  records = [];
  loaded = false;
  loading = false;
  pendingInsertAnchor = null;
});

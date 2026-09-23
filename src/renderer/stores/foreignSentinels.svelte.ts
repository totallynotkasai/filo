/**
 * Audit-19 EXT-6 (plan D5) — other machines' crash-recovery sentinels in a
 * synced vault's `.filo/`, surfaced for INFORMATION only.
 *
 * A foreign sentinel's data lives on the other machine, so it is never
 * prompted for, resumed or cleared here (main refuses the write/delete anyway):
 *   - foreign unclean-shutdown markers + quit-failure breadcrumbs are listed in
 *     the Recovery Files modal;
 *   - a foreign marker / half-finished tag rename or rename cascade older than
 *     an hour (the other machine is not merely mid-edit) gets ONE info toast
 *     per vault per session.
 */
import { SvelteSet } from 'svelte/reactivity';
import { invokeOk } from '../lib/utils/invokeOk';
import { isStillSameVault, type VaultIdentity } from '../lib/vault/vaultIdentity';
import { getMachineIdentity } from '../lib/vault/machineIdentity';
import { onVaultSwap } from '../core/vaultLifecycle';
import { uiStore } from './ui.svelte';

export interface ForeignSentinel {
  kind: 'dirty' | 'rename-cascade' | 'tag-rewrite' | 'quit-failure';
  machineId: string;
  hostname?: string;
  relPath: string;
  mtimeMs: number;
}

export const FOREIGN_STALE_MS = 60 * 60 * 1000;

let list = $state<ForeignSentinel[]>([]);
// allow-module-state: per-session once-per-vault toast guard (a reopen stays quiet); not reactive state
const toasted = new SvelteSet<string>();

onVaultSwap('pre-swap', 'foreignSentinels', () => {
  list = [];
});

export const foreignSentinelsStore = {
  get list(): readonly ForeignSentinel[] {
    return list;
  },
};

export function machineLabel(s: Pick<ForeignSentinel, 'hostname' | 'machineId'>): string {
  return s.hostname ?? `another machine (${s.machineId})`;
}

function when(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Lists other machines' sentinels for `vaultRoot`. Best-effort; never throws. */
export async function surveyForeignSentinels(vaultRoot: string, captured: VaultIdentity, now = Date.now()): Promise<void> {
  let entries: ForeignSentinel[] = [];
  try {
    const res = await invokeOk('recovery:list-sentinels', vaultRoot);
    const me = getMachineIdentity().machineId;
    entries = res.entries.filter((e): e is ForeignSentinel => e.machineId !== null && e.machineId !== me);
  } catch {
    return;
  }
  if (!isStillSameVault(captured)) return;
  list = entries;
  if (toasted.has(vaultRoot)) return;
  const stale = entries.filter((e) => now - e.mtimeMs > FOREIGN_STALE_MS);
  if (stale.length === 0) return;
  toasted.add(vaultRoot);
  const lines = stale.map((e) => {
    switch (e.kind) {
      case 'tag-rewrite':
        return `A tag rename started on ${machineLabel(e)} on ${when(e.mtimeMs)} didn't finish. Re-run it here if you still need it; Filo won't resume another machine's operation.`;
      case 'rename-cascade':
        return `A rename started on ${machineLabel(e)} on ${when(e.mtimeMs)} didn't finish updating its boards. Open the vault on that machine to finish it.`;
      case 'dirty':
        return `${machineLabel(e)} has had unsaved changes since ${when(e.mtimeMs)} (it may have crashed). Open the vault on that machine to recover them.`;
      case 'quit-failure':
        return `${machineLabel(e)} preserved unsaved bytes after a failed save on ${when(e.mtimeMs)}. Open the vault on that machine to recover them.`;
    }
  });
  uiStore.pushToast({ text: lines.join('\n'), type: 'info', duration: 12000 });
}

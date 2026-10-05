/**
 * Settings → Recovery: the copies Filo keeps in `.filo/recovery/` (kept
 * versions, rescue copies, files that failed to load, partly written files),
 * listed by kind, each opened, shown in its folder or deleted.
 *
 * Nothing removes kept versions and rescue copies by itself (KNOWN_LIMITATIONS
 * #33), so this is where the user clears them. A delete sends the copy to the
 * Recycle Bin; only when that refuses does a confirm ask to delete for good.
 */
import { uiStore } from './ui.svelte';
import { vaultStore } from './vault.svelte';
import { onVaultSwap } from '../core/vaultLifecycle';
import { captureVaultIdentity, isStillSameVault, type VaultIdentity } from '../lib/vault/vaultIdentity';
import { invokeOk } from '../lib/utils/invokeOk';
import { reportError } from '../lib/utils/errorBus';
import { normalizePath } from '../lib/utils/path';
import { copyDisplayName, type RecoveryCopy } from '../lib/vault/recoveryCopies';

let copies = $state<RecoveryCopy[]>([]);
let loaded = $state(false);
let busy = $state(false);

function absPathOf(vaultRoot: string, copy: RecoveryCopy): string {
  return `${normalizePath(vaultRoot)}/${copy.relPath}`;
}

function showCopyInFolder(vaultRoot: string, copy: RecoveryCopy): void {
  void window.filo.invoke('shell:show-item-in-folder', absPathOf(vaultRoot, copy));
}

function countOf(n: number): string {
  return n === 1 ? 'this copy' : `these ${n} copies`;
}

/**
 * The Recycle Bin wouldn't take these copies (a network drive, a full bin):
 * asks before deleting them for good, as Settings → Trash does. Cancel keeps
 * them in .filo/recovery.
 */
async function offerPermanentDelete(vaultRoot: string, refused: string[], identity: VaultIdentity): Promise<void> {
  const list = refused.map((p) => `• ${copyDisplayName(p.split('/').pop() ?? p)}`).join('\n');
  const one = refused.length === 1;
  const forGood = await uiStore.confirmAsync({
    title: 'Delete permanently?',
    body: `The Recycle Bin couldn't take ${countOf(refused.length)}:\n${list}\n\nDelete ${one ? 'it' : 'them'} permanently? This can't be undone. Cancel keeps ${one ? 'it' : 'them'} in .filo/recovery.`,
    confirmLabel: 'Delete permanently',
    cancelLabel: 'Keep',
    danger: true,
  });
  if (!forGood || !isStillSameVault(identity)) return;
  const gone = await invokeOk('recovery:delete', vaultRoot, refused, true);
  if (gone.failed.length > 0) uiStore.toast(`Couldn't delete ${countOf(gone.failed.length)}. ${gone.failed.length === 1 ? 'It may be' : 'They may be'} open in another app.`, 'error');
}

export const recoveryCopiesStore = {
  get copies(): RecoveryCopy[] { return copies; },
  get loaded(): boolean { return loaded; },
  get busy(): boolean { return busy; },

  async refresh(): Promise<void> {
    const vaultRoot = vaultStore.path;
    if (!vaultRoot) return;
    const identity = captureVaultIdentity();
    try {
      const listed = await window.filo.invoke('recovery:list', vaultRoot);
      if (!isStillSameVault(identity)) return;
      copies = Array.isArray(listed) ? listed : [];
    } catch (err) {
      if (!isStillSameVault(identity)) return;
      reportError('recovery.list', err, "Couldn't read .filo/recovery. The folder may be locked; Show in folder still opens it.");
      copies = [];
    } finally {
      if (isStillSameVault(identity)) loaded = true;
    }
  },

  /** Opens the copy in the system's app for it, or shows it in its folder when there is none. */
  async open(copy: RecoveryCopy): Promise<void> {
    const vaultRoot = vaultStore.path;
    if (!vaultRoot) return;
    try {
      await invokeOk('recovery:open', vaultRoot, copy.relPath);
    } catch {
      uiStore.toast(`No app on this computer opens "${copyDisplayName(copy.basename)}", so its folder is shown instead.`, 'info');
      showCopyInFolder(vaultRoot, copy);
    }
  },

  showInFolder(copy: RecoveryCopy): void {
    const vaultRoot = vaultStore.path;
    if (vaultRoot) showCopyInFolder(vaultRoot, copy);
  },

  /**
   * Sends `targets` to the Recycle Bin. `confirm` asks first (Delete all);
   * one copy goes at once, since the Recycle Bin can bring it back.
   */
  async remove(targets: readonly RecoveryCopy[], opts: { confirm?: boolean } = {}): Promise<void> {
    const vaultRoot = vaultStore.path;
    if (!vaultRoot || busy || targets.length === 0) return;
    if (opts.confirm) {
      const ok = await uiStore.confirmAsync({
        title: 'Delete these copies?',
        body: `${targets.length === 1 ? 'This copy goes' : `These ${targets.length} copies go`} to the Recycle Bin, which can bring ${targets.length === 1 ? 'it' : 'them'} back. Filo itself doesn't use them.`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
    }
    const identity = captureVaultIdentity();
    busy = true;
    try {
      const paths = targets.map((c) => c.relPath);
      const result = await invokeOk('recovery:delete', vaultRoot, paths);
      if (!isStillSameVault(identity)) return;
      if (result.refused.length > 0) await offerPermanentDelete(vaultRoot, result.refused, identity);
      if (result.failed.length > 0) {
        uiStore.toast(`Couldn't delete ${countOf(result.failed.length)}. ${result.failed.length === 1 ? 'It may be' : 'They may be'} open in another app.`, 'error');
      }
    } catch (err) {
      reportError('recovery.delete', err, "Couldn't delete the copies in .filo/recovery.");
    } finally {
      busy = false;
      if (isStillSameVault(identity)) await this.refresh();
    }
  },
};

onVaultSwap('pre-swap', 'recoveryCopies', () => {
  copies = [];
  loaded = false;
  busy = false;
});

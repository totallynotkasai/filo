/**
 * Vault slice — external-edit DRIFT prompts.
 *
 * The Promise-based Reload / Keep-local prompts the markdown + board write paths
 * await when an external edit lands in the read->write gap
 * (`promptExternalEditOnSync` / `promptBoardExternalEdit`), their shared per-path
 * in-flight registry (`inFlightDriftPrompts`, with vault-swap reset and
 * rename-transfer wiring), the `recreateDeletedFile` Keep-local recovery write,
 * and the deferred `queueMicrotask` that registers the two prompts with the
 * writers via setters (the lib->store import cycle forces a setter, deferred so
 * the cycle's exports publish first).
 *
 * Dependency direction: `vaultExternalPrompts.ts` imports `recreateDeletedFile`
 * from here; this file imports nothing back. The `prompt*` builders that re-read
 * disk via `vaultIndexStore.applyChanges()` then mutate stores are scanned by
 * `scripts/gates:reconciler-vault-guard`.
 */
import { vaultIndexStore } from './vaultIndex.svelte';
import { documentStore } from './document.svelte';
import { fileTagsStore } from './fileTags.svelte';
import { boardStore } from './board.svelte';
import { uiStore } from './ui.svelte';
import { normalizeTags } from '../lib/vault/frontmatterSync';
import { assembleMarkdownFile } from '../lib/editor/markdownSync';
import { reportError } from '../lib/utils/errorBus';
import { dropPendingDelta } from '../lib/boards/frontmatterWriteScheduler';
import { markHydrated, setExternalEditPromptHandler } from '../lib/vault/markdownFileWriter';
import { setBoardExternalEditHandler } from '../lib/boards/boardWriteScheduler';
import { writeMarkdownAndReconcile } from '../lib/vault/syncOpenEditorsAfterDiskMutation';
import { registerPathRenamable } from '../lib/vault/renamePathKeys';
import { captureVaultIdentity, isStillSameVault, type VaultIdentity } from '../lib/vault/vaultIdentity';
import type { FileMetadata } from '../lib/vault/vaultIndex';
import type { VaultContext } from './vaultStoreTypes';
import { vaultSwapResettable } from '../core/vaultLifecycle';

/**
 * In-flight prompt registry. While a Reload / Keep-local toast is open for
 * `path`, every concurrent caller awaits the SAME Promise so repeated
 * keystrokes don't stack duplicate toasts. Cleared when the promise settles,
 * so a later external edit + write race opens a fresh prompt.
 *
 * Reset on vault swap so a stale unresolved entry can't block a fresh prompt
 * for the same path in the new vault.
 */
const inFlightDriftPrompts = new Map<string, Promise<'reload' | 'keep-local' | 'defer'>>();
vaultSwapResettable('vaultExternalChanges.inFlightDriftPrompts', () => inFlightDriftPrompts.clear());
// On rename, move an in-flight prompt to the new key so it isn't stranded under
// the old one and a post-rename keystroke doesn't open a duplicate prompt.
registerPathRenamable('vaultExternalChanges.inFlightDriftPrompts', (oldRel, newRel) => {
  const inflight = inFlightDriftPrompts.get(oldRel);
  if (inflight === undefined) return;
  inFlightDriftPrompts.delete(oldRel);
  inFlightDriftPrompts.set(newRel, inflight);
});

/**
 * Surfaces a Reload / Keep-local prompt when `syncTileMarkdown`
 * detects an external edit landed in the read/write gap (file mtime
 * changed between the pre-read stat and the pre-write stat).
 *
 * Returns a Promise that resolves to the user's choice:
 *   - 'reload' — vault index is refreshed against disk, fresh content
 *                is applied to the tile cache and (if open) the editor.
 *                The caller skips its write.
 *   - 'keep-local' — caller proceeds with the write. A confirmation
 *                    toast is surfaced so the user sees their choice
 *                    landed.
 *   - 'defer' — user dismissed the prompt without choosing.
 *                Caller MUST abort the write so the external edit on
 *                disk survives; the in-memory dirty state is left intact
 *                so the next debounced write re-prompts.
 *
 * Promise-based because the sync caller must branch on the outcome before
 * writing. The toast keeps the 15s cap (never sticky) and a timeout/dismiss
 * resolves 'defer', so the write can never strand. Deduped per path: a typing
 * storm produces ONE toast and ONE decision.
 */
export function promptExternalEditOnSync(args: {
  path: string;
}): Promise<'reload' | 'keep-local' | 'defer'> {
  const { path } = args;
  const existing = inFlightDriftPrompts.get(path);
  if (existing) return existing;

  const promise = new Promise<'reload' | 'keep-local' | 'defer'>((resolve) => {
    const editorDoc = documentStore.findByFilename(path);
    uiStore.pushToast({
      text: `"${editorDoc?.title || path}" was modified externally between Filo's read and write. Reload from disk, or keep your local edits? (Dismiss to defer — no changes saved.)`,
      type: 'warning',
      duration: 0,
      // On dismiss (manual or 15s cap), resolve 'defer' so the writer aborts
      // without touching disk OR editor. The dirty state survives, so the next
      // debounced write re-prompts and overwriting needs an explicit choice.
      onDismiss: () => resolve('defer'),
      actions: [
        {
          label: 'Reload',
          handler: () => {
            // Refresh the vault index against the latest disk state, then
            // pull the resulting FileMetadata. If the file vanished, fall
            // back to keep-local (the upstream write will ENOENT-skip).
            void (async () => {
              // Capture identity before the disk re-read; on a swap during it,
              // defer so the awaiting writer aborts without
              // applying the outgoing vault's content to the new vault.
              const identity = captureVaultIdentity();
              await vaultIndexStore.applyChanges([path]);
              if (!isStillSameVault(identity)) {
                resolve('defer');
                return;
              }
              const next = vaultIndexStore.getMetadata(path);
              if (!next) {
                resolve('keep-local');
                return;
              }
              boardStore.applyFrontmatterToBackedTiles(path, next);
              fileTagsStore.setFileTags(path, normalizeTags(next.frontmatter.tags));
              // Drop the armed field delta on this discard-reload.
              dropPendingDelta(path);
              if (editorDoc) {
                documentStore.applyReloadFromDisk(
                  editorDoc.docId,
                  next.content,
                  editorDoc.richText,
                  next.frontmatter,
                  next.rawFrontmatter, // refresh originalFrontmatterCache too
                  { mtimeMs: next.lastModified, size: next.rawByteSize },
                );
              }
              resolve('reload');
            })();
          },
        },
        {
          label: 'Keep local',
          // allow-keep-local-no-backup: resolves 'keep-local' to the markdown drift gate, which backs up (preWriteDriftGate)
          handler: () => {
            uiStore.pushToast({
              text: `External edit to "${editorDoc?.title || path}" overwritten with local changes.`,
              type: 'info',
              duration: 4000,
            });
            resolve('keep-local');
          },
        },
      ],
    });
  });

  inFlightDriftPrompts.set(path, promise);
  // Drop the entry when the prompt settles (success OR rejection) so a
  // future external-edit race opens a fresh prompt. `.finally` runs after
  // the await chain in callers, so the next caller in the same microtask
  // window still observes the in-flight promise.
  void promise.finally(() => {
    // Guard against an unrelated re-register having replaced our entry in
    // the gap — only clear if the slot still points at our promise.
    if (inFlightDriftPrompts.get(path) === promise) {
      inFlightDriftPrompts.delete(path);
    }
  });
  return promise;
}

/**
 * Test-only — exposes the in-flight prompt map size + entries for assertion.
 * Production code should never need this.
 */
export function __inFlightDriftPromptsForTests(): {
  size: number;
  has: (path: string) => boolean;
} {
  return {
    size: inFlightDriftPrompts.size,
    has: (path: string) => inFlightDriftPrompts.has(path),
  };
}

/**
 * Keep local on a "deleted externally" prompt: re-create the file from the
 * editor's (or the snapshot's) content.
 *
 * A sync client replaces a file as delete-then-create in separate batches, so
 * the other machine's version may land while this toast is open. The write is
 * therefore CREATE-EXCLUSIVE (`vault:create-file-text`): if anything is at `rel`
 * — probed at click time AND enforced by the O_EXCL open (no TOCTOU) — nothing
 * is written and `onReappeared(fresh)` routes to the modified-file prompt, whose
 * Keep local backs the other version up first.
 */
export async function recreateDeletedFile(
  rel: string,
  editorDoc: { docId: string; body: string },
  ctx: VaultContext,
  snapshot?: {
    fmSnapshot: Record<string, unknown>;
    bodySnapshot: string;
  },
  onReappeared?: (fresh: FileMetadata) => void,
): Promise<void> {
  const vaultRoot = ctx.getVaultPath();
  if (!vaultRoot) return;
  const identity = captureVaultIdentity();
  // Cheap first check (the common case shows the right prompt without a failed IPC).
  let alreadyBack = false;
  try {
    alreadyBack = (await window.filo.invoke('vault:file-exists', vaultRoot, rel)) === true;
  } catch {
    alreadyBack = false;
  }
  if (!isStillSameVault(identity)) return;
  if (alreadyBack) {
    await routeReappearedFile(rel, identity, onReappeared);
    return;
  }

  // Prefer LIVE state when the doc is still loaded (honours edits made between
  // toast-open and the Keep-local click); fall back to the snapshot when the
  // doc was unloaded mid-flow.
  const stillLoaded = documentStore.getDocument(editorDoc.docId) !== undefined;
  const liveFm = stillLoaded ? documentStore.getFrontmatter(editorDoc.docId) : undefined;
  let fm: Record<string, unknown> | null = null;
  let body: string | null = null;
  if (stillLoaded && liveFm) {
    fm = liveFm;
    body = editorDoc.body;
  } else if (snapshot) {
    fm = snapshot.fmSnapshot;
    body = snapshot.bodySnapshot;
  }
  if (fm === null || body === null) {
    // Neither live nor snapshot available. Rather than silently no-op or write
    // an empty file, confirm the body-only trade-off with the user.
    const proceedBodyOnly = await uiStore.confirmAsync({
      title: 'Recover without frontmatter?',
      body:
        `Frontmatter for "${rel}" couldn't be recovered (the editor closed before you clicked Keep local). ` +
        'Re-create the file with body content only? Tags, properties, and other YAML keys will be lost.',
      confirmLabel: 'Recreate body-only',
      danger: true,
    });
    if (!proceedBodyOnly) return;
    fm = {};
    body = editorDoc.body ?? '';
  }

  const fileText = assembleMarkdownFile(fm, body);
  try {
    // Coupled write+reconcile. The file-creating channel (not write-existing)
    // gives mkdir -p semantics for a file the watcher reported missing.
    // `mode: 'full'` cancels a debounced body write armed before the Keep-local
    // click — it captured the pre-recovery body and would otherwise fire ~300 ms
    // later and revert the recreation.
    const outcome = await writeMarkdownAndReconcile({
      vaultRoot,
      path: rel,
      content: fileText,
      mode: 'full',
      create: 'exclusive', // never overwrite a file that is back
    });
    if (outcome === 'exists') {
      await routeReappearedFile(rel, identity, onReappeared);
      return;
    }
    // Mark hydrated so later gateway writes (further edits in a still-open
    // editor) can proceed. BOM is false: the assembled fileText has none.
    markHydrated(rel, false);
  } catch (err) {
    reportError(
      'vaultExternalChanges',
      err,
      `Failed to re-create "${rel}" on disk. Local edits remain in memory but are not yet on disk.`,
    );
  }
}

/**
 * The "deleted" file is back on disk (sync re-created it with
 * the other machine's version): re-read it and hand it to the caller's
 * modified-file flow instead of writing over it.
 */
async function routeReappearedFile(
  rel: string,
  identity: VaultIdentity,
  onReappeared?: (fresh: FileMetadata) => void,
): Promise<void> {
  await vaultIndexStore.applyChanges([rel]);
  if (!isStillSameVault(identity)) return;
  const fresh = vaultIndexStore.getMetadata(rel);
  if (fresh && onReappeared) {
    onReappeared(fresh);
    return;
  }
  uiStore.pushToast({
    text: `"${rel}" reappeared on disk (probably from another device), so Filo didn't overwrite it.`,
    type: 'warning',
    duration: 8000,
  });
}

/**
 * Reload / Keep-local prompt for board JSON drift. Mirrors
 * `promptExternalEditOnSync` (which targets `.md` editors) but the body
 * names the .board.json path instead. Resolves to:
 *   - 'reload' — user wants Filo to discard the in-memory cache and let
 *                disk win. The caller is responsible for any reload
 *                bookkeeping; the toast just resolves and returns.
 *   - 'keep-local' — user wants their in-memory edits to overwrite the
 *                    external change. The caller proceeds with the write.
 *   - 'defer' — user dismissed the prompt without choosing.
 *                Caller MUST abort the write so the external edit on
 *                disk survives; the dirty board cache is left intact so
 *                the next debounced write re-prompts.
 *
 * Promise-backed toast: 15s cap (never sticky); a timeout or dismiss resolves
 * 'defer' so the paused write aborts instead of stranding.
 */
export function promptBoardExternalEdit(args: {
  path: string;
}): Promise<'reload' | 'keep-local' | 'defer'> {
  const { path } = args;
  // Share `promptExternalEditOnSync`'s per-path dedup map so a save storm
  // produces ONE toast + ONE decision and inherits its swap-reset +
  // rename-transfer wiring. `.board.json` and `.md` keys never collide.
  const existing = inFlightDriftPrompts.get(path);
  if (existing) return existing;

  const promise = new Promise<'reload' | 'keep-local' | 'defer'>((resolve) => {
    uiStore.pushToast({
      text: `"${path}" was modified externally between Filo's load and the next save. Reload from disk (discard in-memory changes), or keep your local edits? (Dismiss to defer — no changes saved.)`,
      type: 'warning',
      duration: 0,
      // Dismiss resolves to 'defer' so the writer aborts
      // without touching disk OR cache. The dirty board cache survives,
      // so the next debounced write re-prompts and the user must
      // explicitly choose to overwrite.
      onDismiss: () => resolve('defer'),
      actions: [
        {
          label: 'Reload',
          handler: () => {
            // Caller decides how to surface the reload. We just signal
            // the choice; the writer treats it as "abort this write".
            resolve('reload');
          },
        },
        {
          label: 'Keep local',
          // allow-keep-local-no-backup: resolves 'keep-local' to the board writer, which backs up (boardWriteScheduler)
          handler: () => {
            uiStore.pushToast({
              text: `External edit to "${path}" will be overwritten on the next save.`,
              type: 'info',
              duration: 4000,
            });
            resolve('keep-local');
          },
        },
      ],
    });
  });

  inFlightDriftPrompts.set(path, promise);
  // Drop the entry when the prompt settles so a future board-drift race opens
  // a fresh prompt; guard against an unrelated re-register replacing our slot.
  void promise.finally(() => {
    if (inFlightDriftPrompts.get(path) === promise) {
      inFlightDriftPrompts.delete(path);
    }
  });
  return promise;
}

// Register the Reload / Keep-local prompts with the writers at module load.
// `lib/` writers can't import `stores/` (circular), so wiring goes via setters,
// wrapped in `queueMicrotask` so the existing eval cycles (markdownFileWriter ↔
// documentStore; vaultIndexStore → vaultStore → vaultExternalChanges) publish
// their exports first. The `typeof === 'function'` guards tolerate vitest's
// module reset swapping a binding mid-microtask; the dev-only `else` fails LOUD
// so import-graph drift can't silently drop the prompts.
queueMicrotask(() => {
  if (typeof setExternalEditPromptHandler === 'function') {
    setExternalEditPromptHandler((path) => promptExternalEditOnSync({ path }));
  } else if (import.meta.env.MODE === 'development') {
    console.error('[vaultExternalChanges] setExternalEditPromptHandler not live at registration — external-edit drift prompts DISABLED (Audit-14 6.2 import-cycle regression).');
  }
  if (typeof setBoardExternalEditHandler === 'function') {
    setBoardExternalEditHandler((path) => promptBoardExternalEdit({ path }));
  } else if (import.meta.env.MODE === 'development') {
    console.error('[vaultExternalChanges] setBoardExternalEditHandler not live at registration — board drift prompts DISABLED (Audit-14 6.2).');
  }
});

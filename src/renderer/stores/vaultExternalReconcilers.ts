/**
 * vaultExternalReconcilers — registers the external-edit reconcilers with
 * `externalChangeRegistry`:
 *
 *  - `board`           → `boardJsonReconciler`
 *  - `config-tags`     → `tagsJsonReconciler`
 *  - `config-theme`    → `themeJsonReconciler`
 *  - `config-template` → `templateReconciler`
 *
 * The `document` / `attachment` reconcilers live on the `vaultStore` mixin
 * (`handleExternalMarkdownChanges` / `handleExternalAttachmentChanges`)
 * because they coordinate a lot of cross-store state. They register here as
 * batched reconcilers so the dispatcher's route is exhaustive.
 *
 * Each reconciler keeps its surface intentionally small:
 *  - Honour `isRecentSelfWrite` so a watcher echo of our own write
 *    doesn't trigger a "modified externally" prompt.
 *  - Surface user-visible toasts via `uiStore` for changes that deserve
 *    a choice (e.g. board JSON drift mid-edit).
 *  - Refresh the relevant cache directly when there's no in-memory
 *    state the user could lose (tags / themes / templates list).
 *  - **Vault-identity guard.** Every reconciler that reads the active vault
 *    path and then `await`s MUST `captureVaultIdentity()` before the await and
 *    `isStillSameVault(...)` after it, bailing before any store mutation.
 *    Otherwise a swap during the await applies the outgoing vault's data to the
 *    new vault (worst case: tags persisted into the new vault's
 *    `.filo/tags.json`). Enforced by `scripts/gates:reconciler-vault-guard`.
 *
 * Lives in `stores/` because the registrations need to import every store
 * involved. The pure registry surface lives in
 * `lib/vault/externalChangeRegistry.ts` per the lib-pure-of-stores rule.
 */

import {
  registerReconciler,
  registerBatchedReconciler,
  type ExternalChangeEvent,
  type BatchedReconciler,
} from '../lib/vault/externalChangeRegistry';
import { boardCacheStore } from './boardCache.svelte';
import { boardStore } from './board.svelte';
import { fileTagsStore } from './fileTags.svelte';
import { themeStore } from './theme.svelte';
import { templatesStore } from './templates.svelte';
import { uiStore } from './ui.svelte';
import { vaultStore } from './vault.svelte';
import { reportError } from '../lib/utils/errorBus';
import { assertIpcOk } from '../lib/utils/ipcEnvelope';
import { isRecentSelfWrite, isPathPending, isPathQueuedOrInFlight } from '../lib/boards/boardSaver';
import { loadBoard } from '../lib/boards/boardLoader';
import { loadTagsFile } from '../lib/vault/tagsStorage';
import { captureVaultIdentity, isStillSameVault } from '../lib/vault/vaultIdentity';
import { backupExternalVersion } from '../lib/vault/keepLocalBackup';
import { adoptBoardAtRuntime } from './boardDiscovery';
import { samePath } from '../lib/utils/path';
import { selfWriteDivergedFromBaseline } from './vaultExternalChanges';

// ── Board JSON reconciler ─────────────────────────────────────────────

/**
 * External `.board.json` edit. The board write scheduler's drift detector
 * catches this lazily on the next write; this surfaces the change
 * proactively so the user knows about it before they keep editing.
 *
 * Three flavours:
 *  - Board not in cache (untracked) — adopted into the running session
 *    (`adoptBoardAtRuntime`) when the file really exists.
 *  - Board in cache but clean (no pending writes) — reload silently.
 *    Mirrors the `reload-silently` branch of the `.md` classifier.
 *  - Board in cache AND has a pending debounced write — surface a
 *    "Board changed externally" toast with Reload / Keep your edits.
 *    Mirrors the dirty-editor branch of `promptModifiedFile`.
 */
async function reconcileBoardJsonChange(event: ExternalChangeEvent): Promise<void> {
  const rel = event.filename;
  // A recent self-write is dropped as our own echo ONLY when its fresh disk
  // stat still matches the baseline we wrote. A diverged stat means a second
  // writer touched the file inside the suppression window, so treat it as a
  // real external edit.
  if (isRecentSelfWrite(rel)) {
    const captured = captureVaultIdentity();
    const root = vaultStore.path;
    if (!root) return;
    const diverged = await selfWriteDivergedFromBaseline(root, rel);
    if (!isStillSameVault(captured)) return;
    if (!diverged) return;
    // A diverged stat while a newer self-write for this path is queued or in
    // flight is our own next save landing, not a second writer — prompting
    // here (and a "Reload" answer) would clobber un-persisted edits. A genuine
    // external edit in this window is still caught by `writeBoardFile`'s
    // pre-write drift check. Failed paths are excluded by the probe so a
    // failed write doesn't suppress real external edits.
    if (isPathQueuedOrInFlight(rel)) return;
  }

  // An untracked `.board.json` (synced from another machine, copied, moved
  // in) is adopted into the session when it really exists, instead of staying
  // invisible until the vault is reopened.
  const boardId = findBoardIdForPath(rel);
  if (!boardId) {
    const captured = captureVaultIdentity();
    const root = vaultStore.path;
    if (!root) return;
    let exists = false;
    try {
      exists = (await window.filo.invoke('vault:file-exists', root, rel)) === true;
    } catch {
      exists = false;
    }
    if (!isStillSameVault(captured) || !exists) return;
    await adoptBoardAtRuntime(rel, captured);
    return;
  }

  // `isPathPending` is the single pending-write authority shared with
  // the `.md` classifier in `vaultExternalChanges`. A pending/in-flight
  // `.board.json` write means the user has local edits the disk version
  // would clobber, so prompt rather than silently reloading.
  if (isPathPending(rel)) {
    promptBoardChangedExternally(rel, boardId);
    return;
  }

  // No pending write — apply disk silently. Mirrors the `reload-silently`
  // branch of the markdown classifier (clean editor + external edit).
  // `guardPending: true` re-checks for a write that lands DURING the read so
  // the silent reload can't clobber an edit made in that window.
  // `reloadBoardFromDisk` re-checks vault identity after its async load.
  await reloadBoardFromDisk(rel, boardId, true);
}

function findBoardIdForPath(rel: string): string | null {
  const paths = boardStore.paths;
  for (const [boardId, boardPath] of Object.entries(paths)) {
    // Case-insensitive, separator-agnostic compare: on Windows / macOS an
    // externally-edited `.board.json` whose OS-reported casing differs from
    // the stored casing must still match, or the event is ignored and the
    // board may later be evicted as missing.
    if (samePath(boardPath, rel)) return boardId;
  }
  return null;
}

async function reloadBoardFromDisk(
  rel: string,
  boardId: string,
  // When true (the silent reconciler path), re-check for a pending write AFTER
  // the async read. The explicit "Reload" handler passes false: the user there
  // chose to discard local edits.
  guardPending = false,
): Promise<void> {
  // Capture vault identity before the async load, so a swap during it can't
  // merge the outgoing vault's board into the new vault's cache.
  const captured = captureVaultIdentity();
  const vaultRoot = vaultStore.path;
  if (!vaultRoot) return;
  const result = await loadBoard(vaultRoot, rel);
  // Swap landed during the load — abandon: the loaded bytes belong to the
  // outgoing vault and `boardStore.cache` is now the new vault's.
  if (!isStillSameVault(captured)) return;
  if (!result.ok) {
    // Name the reason (a lock / offline placeholder is not a
    // corrupt file) and say what happens next.
    const reason =
      result.error === 'locked' ? 'the file is locked by another program'
        : result.error === 'offline' ? 'the file is online-only and could not be downloaded'
          : result.error === 'not-found' ? 'the file is missing'
            : `load failed: ${result.error}`;
    reportError(
      'externalChange.board',
      new Error(`${result.error}: ${result.message}`),
      `External change to "${rel}" couldn't be applied (${reason}). Filo's copy is unchanged; it will try again on the next change.`,
    );
    return;
  }
  // A user edit landing during loadBoard's IPC makes the pre-read pending
  // check stale; a silent replaceCache would clobber it, so prompt instead.
  if (guardPending && isPathPending(rel)) {
    promptBoardChangedExternally(rel, boardId);
    return;
  }
  // Rebind the stored path to the OS-reported casing. After a case-only
  // external rename the stale casing could later make a tree reconcile treat
  // the board as missing and evict it. `renameBoardPath` no-ops when the path
  // is byte-identical.
  const storedPath = boardStore.paths[boardId];
  if (storedPath) boardCacheStore.renameBoardPath(storedPath, rel);
  // Use the boardCache replace path: write the freshly-loaded data
  // straight into the cache slot for this boardId. `replaceCache`
  // accepts a full snapshot, so build one with just this entry merged
  // over the live cache.
  const merged = { ...boardStore.cache, [boardId]: result.data };
  boardCacheStore.replaceCache(merged);
}

function promptBoardChangedExternally(rel: string, boardId: string): void {
  uiStore.pushToast({
    text: `Board file "${rel}" was modified externally while you had unsaved changes. Reload from disk (discard your edits), or keep your edits and overwrite on next save?`,
    type: 'warning',
    duration: 0,
    sticky: true,
    dedupeKey: `board-mod:${rel}`,
    actions: [
      {
        label: 'Reload',
        handler: () => {
          // reloadBoardFromDisk re-checks vault identity across its async load.
          void reloadBoardFromDisk(rel, boardId);
        },
      },
      {
        label: 'Keep your edits',
        handler: async () => {
          // Back up the external board version first (the board writer's
          // keep-local branch dedupes against this snapshot).
          const identity = captureVaultIdentity();
          const vaultRoot = vaultStore.path;
          if (!vaultRoot || !(await backupExternalVersion(vaultRoot, rel))) return;
          if (!isStillSameVault(identity)) return;
          // No-op — the next debounced write will overwrite the disk
          // copy. The board writer's pre-write mtime check will catch
          // the drift again at that point and surface its own
          // "Reload / Keep-local" prompt; that's the second-chance
          // confirmation before we actually overwrite.
          uiStore.pushToast({
            text: `External edit to "${rel}" will be overwritten on the next save.`,
            type: 'info',
            duration: 4000,
          });
        },
      },
    ],
  });
}

// ── Tags JSON reconciler ──────────────────────────────────────────────

/**
 * External `.filo/tags.json` edit. Reload the tag registry + every
 * `fileTags[*]` membership directly — tags don't have a dirty-editor
 * notion the way docs do, so a silent re-read is the right behaviour.
 *
 * Pending in-memory tag mutations (the scheduler's debounce hadn't fired
 * yet) are 3-way merged with the external copy (`applyExternalReload`), and
 * the debounced save itself re-reads + merges before writing, so neither
 * side's registrations are lost; a tag-rewrite sweep mid-flight is protected
 * by the rewrite sentinel (`tagRewriteSentinel`).
 */
async function reconcileTagsJsonChange(event: ExternalChangeEvent): Promise<void> {
  // Inside the self-write window, drop the event only when the disk copy is
  // exactly what we last saved (our echo). Another machine's tags.json landing
  // in the window falls through and is merged below.
  const inSelfWriteWindow = isRecentSelfWrite(event.filename);
  // Capture identity before the async `tags:load`: a swap during the read
  // would otherwise make `applyExternalReload` (which `scheduleSave`s) persist
  // the outgoing vault's tags into the new vault's `.filo/tags.json`.
  const captured = captureVaultIdentity();
  const vaultRoot = vaultStore.path;
  if (!vaultRoot) return;
  try {
    // assertIpcOk re-throws a `{ ok: false }` error envelope
    // into the catch below; a bare string|null passes through unchanged.
    const raw = assertIpcOk(
      await window.filo.invoke('tags:load', vaultRoot),
      'tags:load',
    ) as string | null;
    if (!isStillSameVault(captured)) return;
    // Route through the version migrator so an externally-written from-future
    // tags.json flips the store read-only (preventing a downgrade re-save).
    const loaded = loadTagsFile(raw);
    if (inSelfWriteWindow && fileTagsStore.isLastSavedState(loaded.file)) return;
    // `applyExternalReload` returns false when the disk copy deep-equals our
    // in-memory registry (a self-write echo). Skip the toast and re-save then,
    // so an in-app save can't spin a perpetual "modified externally" loop.
    const changed = fileTagsStore.applyExternalReload(loaded);
    if (!changed) return;
    uiStore.pushToast({
      text: '.filo/tags.json was modified externally — tag registry refreshed.',
      type: 'info',
      duration: 4000,
    });
  } catch (err) {
    reportError(
      'externalChange.tags',
      err,
      "Couldn't re-read .filo/tags.json after an external edit. Tag changes from other tools may not be visible until next vault open.",
    );
  }
}

// ── Theme JSON reconciler ─────────────────────────────────────────────

/**
 * External `.filo/themes/<id>.json` edit. Refresh the theme catalogue
 * so ThemeManager / settings panels show the latest set. If the active
 * theme's file changed on disk AND the user has it active, re-apply it
 * so colour changes show up without a manual reload.
 *
 * No prompts here: themes are visual chrome, not data. A user hand-
 * editing `dark.json` clearly wants the new variables applied
 * immediately.
 *
 * Accepted: a self-write's echo arriving after the self-write window expires
 * triggers one spurious refresh/re-apply. It doesn't loop (neither the theme
 * nor template reconciler re-saves on reload), so dedup isn't worth a second
 * theme-file load.
 */
async function reconcileThemeChange(event: ExternalChangeEvent): Promise<void> {
  if (isRecentSelfWrite(event.filename)) return;
  // Capture identity before the async theme reload; a swap during it would
  // otherwise re-apply the outgoing vault's theme over the new vault.
  const captured = captureVaultIdentity();
  const vaultRoot = vaultStore.path;
  if (!vaultRoot) return;
  try {
    await themeStore.refreshAvailable(vaultRoot);
    if (!isStillSameVault(captured)) return;
    // Reapply the active theme if its file was the one that changed.
    // The path is `.filo/themes/<id>.json` — extract the id and compare.
    const match = event.filename.match(/^\.filo\/themes\/(.+)\.json$/);
    if (match && match[1] === themeStore.activeFileId) {
      // Best-effort reapply. Failure already routes through `applyById`'s
      // toast pipeline, so we don't double-surface here.
      await themeStore.applyById(vaultRoot, themeStore.activeFileId);
    }
  } catch (err) {
    reportError(
      'externalChange.theme',
      err,
      "Couldn't refresh themes after an external edit. Re-open the vault to see the latest theme set.",
    );
  }
}

// ── Template reconciler ───────────────────────────────────────────────

/**
 * External `.filo/templates/*.template.json` edit. Refresh the template
 * cache so the Template Browser shows the latest set. Templates are
 * read-only at use time (the user picks one and the layout is cloned
 * onto the canvas), so a silent refresh is fine — there's no in-memory
 * state to lose.
 */
async function reconcileTemplateChange(event: ExternalChangeEvent): Promise<void> {
  if (isRecentSelfWrite(event.filename)) return;
  try {
    await templatesStore.load();
  } catch (err) {
    reportError(
      'externalChange.template',
      err,
      "Couldn't refresh layout templates after an external edit.",
    );
  }
}

// ── Document / attachment batched reconcilers (bridge) ────────────────

/**
 * Bridges `vaultStore.handleExternalMarkdownChanges` into the registry so the
 * dispatcher is exhaustive. The store method owns the cross-store
 * coordination (vault index, frontmatter sync, partial-read retry,
 * dirty-editor prompt, properties-popup-dirty path); the bridge just adapts
 * the event shape to its `string[]` argument.
 */
const documentBatchedReconciler: BatchedReconciler = {
  kind: 'document',
  handleBatch: async (events) => {
    // Self-write filtering lives inside handleExternalMarkdownChanges (single
    // authority, so the partial-read retry timer that re-invokes it directly
    // is filtered too).
    const paths = events.map((e) => e.filename);
    if (paths.length === 0) return;
    await vaultStore.handleExternalMarkdownChanges(paths);
  },
};

const attachmentBatchedReconciler: BatchedReconciler = {
  kind: 'attachment',
  // Fire-and-forget so the handler's 500 ms attachment-delete grace deferral
  // runs outside the shared rename queue this batch is awaited inside —
  // awaiting it would stall every unrelated reconcile and queued rename
  // behind the grace window. The handler has its own re-existence + vault-swap
  // guards, and this catch reports its failures.
  handleBatch: (events) => {
    const paths = events
      .map((e) => e.filename)
      .filter((p) => !isRecentSelfWrite(p));
    if (paths.length === 0) return;
    void vaultStore.handleExternalAttachmentChanges(paths).catch((err) => {
      reportError(
        'externalChange.attachment',
        err,
        'Failed to reconcile external attachment changes',
      );
    });
  },
};

// ── Register-on-load ──────────────────────────────────────────────────

/**
 * Registers every renderer-side reconciler with the dispatcher at
 * module-load time. The four config/board reconcilers are single-event;
 * document and attachment are batched.
 *
 * Wrapped in a one-shot guard so a test that re-imports the module
 * (vitest's module reset) doesn't accumulate duplicate registrations.
 * In production this runs exactly once.
 */
let registered = false;
export function registerExternalChangeReconcilers(): void {
  if (registered) return;
  registered = true;
  registerReconciler({ kind: 'board', handle: reconcileBoardJsonChange });
  registerReconciler({ kind: 'config-tags', handle: reconcileTagsJsonChange });
  registerReconciler({ kind: 'config-theme', handle: reconcileThemeChange });
  registerReconciler({ kind: 'config-template', handle: reconcileTemplateChange });
  registerBatchedReconciler(documentBatchedReconciler);
  registerBatchedReconciler(attachmentBatchedReconciler);
}

// Deferred registration — same pattern as `vaultExternalChanges.ts`'s
// writer wiring. The store imports above form a partial-evaluation
// cycle through `vault.svelte.ts`; `queueMicrotask` runs after every
// module in the cycle has finished its top-level evaluation so the
// reconcilers see live store bindings. By `App.svelte` mount time the
// microtask has long since fired.
queueMicrotask(() => {
  registerExternalChangeReconcilers();
});

/**
 * Test-only — resets the once-guard so a test can re-call
 * `registerExternalChangeReconcilers()` after `_resetRegistryForTests()`.
 */
export function _resetRegistrationGuardForTests(): void {
  registered = false;
}

/**
 * vaultExternalReconcilers — registers the external-edit reconcilers with
 * `externalChangeRegistry`:
 *
 *  - `board`           → `boardJsonReconciler`
 *  - `config-tags`     → `tagsJsonReconciler`
 *  - `config-theme`    → `themeJsonReconciler`
 *  - `config-template` → `templateReconciler`
 *  - `config`          → `reconcileConfigFileChange` (configFileReconciler.ts)
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
import { fileTagsStore } from './fileTags.svelte';
import { themeStore } from './theme.svelte';
import { templatesStore } from './templates.svelte';
import { uiStore } from './ui.svelte';
import { vaultStore } from './vault.svelte';
import { reportError } from '../lib/utils/errorBus';
import { assertIpcOk } from '@shared/ipcEnvelope';
import { isRecentSelfWrite, isPathPending, isPathQueuedOrInFlight } from '../lib/boards/boardSaver';
import { loadTagsFile } from '../lib/vault/tagsStorage';
import { captureVaultIdentity, isStillSameVault } from '../lib/vault/vaultIdentity';
import { adoptBoardAtRuntime } from './boardDiscovery';
import { findBoardIdForPath, reloadBoardFromDisk, resolveBoardDrift } from './boardDrift';
import { selfWriteDivergedFromBaseline } from './vaultExternalChanges';
import { getBaseline, hasBaselineDrifted } from '../lib/vault/fileBaselineRegistry';
import { reconcileConfigFileChange } from './configFileReconciler';

// ── Board JSON reconciler ─────────────────────────────────────────────

/**
 * True only when the board file's stat equals its drift baseline. No baseline,
 * a failed stat or a vault swap during the stat answer false, so the change is
 * handled as before.
 */
async function boardMatchesBaseline(rel: string): Promise<boolean> {
  const baseline = getBaseline(rel);
  if (!baseline) return false;
  const captured = captureVaultIdentity();
  const root = vaultStore.path;
  if (!root) return false;
  try {
    const stat = await window.filo.invoke('vault:stat', root, rel);
    if (!isStillSameVault(captured)) return false;
    if (!stat || stat.success !== true) return false;
    return !hasBaselineDrifted(baseline, { mtimeMs: stat.mtimeMs, size: stat.size });
  } catch {
    return false;
  }
}

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

  // The file still holds what Filo last wrote or read (its stat equals the
  // drift baseline): nothing to reload and nothing to ask about, however old
  // the write. The watcher's scan can report a save of Filo's own long after
  // the self-write window, and a false prompt's Reload drops the edits armed
  // in the debounce. The writer's own drift check compares the same baseline.
  if (await boardMatchesBaseline(rel)) return;

  // `isPathPending` is the single pending-write authority shared with
  // the `.md` classifier in `vaultExternalChanges`. A pending/in-flight
  // `.board.json` write means the user has local edits the disk version
  // would clobber, so prompt rather than silently reloading.
  if (isPathPending(rel)) {
    void resolveBoardDrift(rel);
    return;
  }

  // No pending write — apply disk silently. Mirrors the `reload-silently`
  // branch of the markdown classifier (clean editor + external edit).
  // `guardPending: true` re-checks for a write that lands DURING the read so
  // the silent reload can't clobber an edit made in that window.
  // `reloadBoardFromDisk` re-checks vault identity after its async load.
  const outcome = await reloadBoardFromDisk(rel, boardId, { guardPending: () => isPathPending(rel) });
  // An edit landed during the read: ask rather than drop it.
  if (outcome === 'pending') void resolveBoardDrift(rel);
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
  // The path is `.filo/themes/<id>.json`. That theme is read again even if it
  // is cached, so a hand-edit shows.
  const match = event.filename.match(/^\.filo\/themes\/(.+)\.json$/);
  const activeId = themeStore.activeFileId;
  const activeName = themeStore.cache[activeId]?.name ?? activeId;
  try {
    await themeStore.refreshAvailable(vaultRoot, match?.[1] ? [match[1]] : []);
    if (!isStillSameVault(captured)) return;
    // Reapply the active theme if its file was the one that changed.
    if (match && match[1] === activeId) {
      // Best-effort reapply. Failure already routes through `applyById`'s
      // toast pipeline, so we don't double-surface here.
      const gone = !themeStore.available.includes(activeId);
      const result = await themeStore.applyById(vaultRoot, activeId);
      // A deleted theme falls back to Light; say why the colours changed.
      // `appearance.json` keeps naming it, so a copy synced back returns.
      if (gone && !result.ok && isStillSameVault(captured)) {
        uiStore.toast(`The theme "${activeName}" was deleted outside Filo, so Filo switched to Light.`, 'warning', 7000);
      }
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
 * dirty-editor prompt); the bridge just adapts
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
  registerReconciler({ kind: 'config', handle: reconcileConfigFileChange });
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

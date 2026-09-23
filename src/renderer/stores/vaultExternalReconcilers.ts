/**
 * vaultExternalReconcilers — Phase 3 / 3.2.
 *
 * Registers the four new external-edit reconcilers introduced in Phase 3
 * with `externalChangeRegistry`:
 *
 *  - `board`           → `boardJsonReconciler`
 *  - `config-tags`     → `tagsJsonReconciler`
 *  - `config-theme`    → `themeJsonReconciler`
 *  - `config-template` → `templateReconciler`
 *
 * The pre-existing `document` / `attachment` reconcilers continue to live
 * on the `vaultStore` mixin (`handleExternalMarkdownChanges` /
 * `handleExternalAttachmentChanges`) because they coordinate too much
 * cross-store state to extract cleanly in one phase. They register here
 * too — as batched reconcilers — so the dispatcher's `dispatchExternalChangeBatch`
 * route ends up exhaustive.
 *
 * Each reconciler keeps its surface intentionally small:
 *  - Honour `isRecentSelfWrite` so a watcher echo of our own write
 *    doesn't trigger a "modified externally" prompt.
 *  - Surface user-visible toasts via `uiStore` for changes that deserve
 *    a choice (e.g. board JSON drift mid-edit).
 *  - Refresh the relevant cache directly when there's no in-memory
 *    state the user could lose (tags / themes / templates list).
 *  - **Audit-6 H3/H4/L27 — vault-identity guard.** Every reconciler that
 *    reads the active vault path and then `await`s a disk read MUST
 *    `captureVaultIdentity()` before the await and `isStillSameVault(...)`
 *    after it, bailing before any store mutation. A vault swap can interleave
 *    on the await; without the re-check the outgoing vault's data is applied to
 *    the new vault — the worst case being `reconcileTagsJsonChange`, whose
 *    `applyExternalReload` can `scheduleSave` a merged delta, persisting vault A's
 *    tag registry into vault B's `.filo/tags.json` on disk. This is the G1
 *    discipline (`vaultIdentity.ts`) the rename/cascade paths already follow;
 *    `scripts/check-reconciler-vault-guard.mjs` enforces it here so a future
 *    reconciler can't forget (the structural, class-level cure for root-cause
 *    B — a runtime wrapper can't help because it can't refuse a mutation that
 *    has already happened mid-reconciler).
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
import { samePath } from '../lib/utils/path';
import { selfWriteDivergedFromBaseline } from './vaultExternalChanges';

// ── Board JSON reconciler ─────────────────────────────────────────────

/**
 * External `.board.json` edit. The pre-existing
 * `boardWriteScheduler.ts:213-249` drift detector catches the case
 * lazily — on the NEXT user-triggered write. Phase 3 / 3.2 surfaces the
 * change proactively so the user knows about it before they keep
 * editing.
 *
 * Three flavours:
 *  - Board not in cache (untracked) — silent. The next time the user
 *    opens it, `loadBoard` will pick up the new bytes naturally.
 *  - Board in cache but clean (no pending writes) — reload silently.
 *    Mirrors the `reload-silently` branch of the `.md` classifier.
 *  - Board in cache AND has a pending debounced write — surface a
 *    "Board changed externally" toast with Reload / Keep your edits.
 *    Mirrors the dirty-editor branch of `promptModifiedFile`.
 */
async function reconcileBoardJsonChange(event: ExternalChangeEvent): Promise<void> {
  const rel = event.filename;
  // P2.4 (Audit-15) — mirror the `.md` path's Audit-13 M4 divergence tiebreak: a
  // recent self-write is dropped as our own echo ONLY when its fresh disk stat
  // still matches the baseline we wrote. A diverged stat means a SECOND writer
  // touched the `.board.json` inside the self-write suppression window, so treat
  // it as a real external edit and fall through to the proactive reconcile.
  // Data-safe either way (no baseline / unreadable / matching stat → drop, prior
  // behaviour). Capture vault identity before the stat await and bail on a swap
  // (the downstream reloadBoardFromDisk also re-checks, but the gate — and
  // correctness — wants the guard at the live-path read here too).
  if (isRecentSelfWrite(rel)) {
    const captured = captureVaultIdentity();
    const root = vaultStore.path;
    if (!root) return;
    const diverged = await selfWriteDivergedFromBaseline(root, rel);
    if (!isStillSameVault(captured)) return;
    if (!diverged) return;
    // Audit-16 4.8 — a diverged stat while a NEWER self-write for this path
    // is still queued or in flight is write N+1's bytes landing between
    // write N's watcher echo and N+1's post-write baseline stamp — Filo's
    // own back-to-back saves during normal rapid editing, not a second
    // writer. Falling through here surfaced a spurious "Board changed
    // externally" prompt (the isPathPending branch below), and a "Reload"
    // answer would clobber the un-persisted in-memory edits. Drop the echo;
    // a genuine external edit in this narrow window is still caught lazily
    // by `writeBoardFile`'s pre-write drift check on the next save. The
    // probe deliberately excludes failed paths (see isPathQueuedOrInFlight)
    // so a failed write doesn't suppress real external-edit echoes.
    if (isPathQueuedOrInFlight(rel)) return;
  }

  // Look up boardId for this path. Reconciler is a no-op when no board
  // in the active project points at this path — a side `.board.json`
  // sitting on disk we never loaded is not our problem to react to.
  const boardId = findBoardIdForPath(rel);
  if (!boardId) return;

  // E3 — `isPathPending` is the single pending-write authority shared with
  // the `.md` classifier in `vaultExternalChanges`. A pending/in-flight
  // `.board.json` write means the user has local edits the disk version
  // would clobber, so prompt rather than silently reloading.
  if (isPathPending(rel)) {
    promptBoardChangedExternally(rel, boardId);
    return;
  }

  // No pending write — apply disk silently. Mirrors the `reload-silently`
  // branch of the markdown classifier (clean editor + external edit).
  // `guardPending: true` re-checks for a write that lands DURING the read
  // (6.4.M18) so the silent reload can't clobber an edit made in that window.
  // `reloadBoardFromDisk` reads the active vault path itself and re-checks
  // vault identity after its async load (Audit-6 H4) before mutating the cache.
  await reloadBoardFromDisk(rel, boardId, true);
}

function findBoardIdForPath(rel: string): string | null {
  const paths = boardStore.paths;
  for (const [boardId, boardPath] of Object.entries(paths)) {
    // M4 (Audit-12) — case-INSENSITIVE, separator-agnostic compare. Windows /
    // macOS aren't case-sensitive, so an externally-edited/renamed `.board.json`
    // whose OS-reported casing diverges from the stored casing must still match.
    // The raw `===` it replaces silently ignored such an event (no reload), and
    // the board could later be treated as missing and evicted. Mirrors the
    // document pipeline, which case-folds everywhere via `samePath`.
    if (samePath(boardPath, rel)) return boardId;
  }
  return null;
}

async function reloadBoardFromDisk(
  rel: string,
  boardId: string,
  // 6.4.M18 — when true (the silent reconciler path), re-check for a pending
  // write AFTER the async read. The explicit "Reload" handler passes false:
  // the user there chose to discard local edits, so no re-check.
  guardPending = false,
): Promise<void> {
  // Audit-6 H4 — capture vault identity BEFORE the async load. `loadBoard`
  // awaits a disk read; a vault swap can interleave on that await. Without the
  // re-check below, the freshly-loaded (outgoing-vault) board would be merged
  // into `boardCacheStore` AFTER the swap — injecting vault A's board JSON into
  // vault B's in-memory cache. Mirrors `runExternalRenameCascade`'s G1 guard.
  const captured = captureVaultIdentity();
  const vaultRoot = vaultStore.path;
  if (!vaultRoot) return;
  const result = await loadBoard(vaultRoot, rel);
  // Swap landed during the load — abandon: the loaded bytes belong to the
  // outgoing vault and `boardStore.cache` is now the new vault's.
  if (!isStillSameVault(captured)) return;
  if (!result.ok) {
    reportError(
      'externalChange.board',
      new Error(`${result.error}: ${result.message}`),
      `External change to "${rel}" couldn't be applied (load failed). Filo's in-memory copy is unchanged.`,
    );
    return;
  }
  // 6.4.M18 — a user edit landing DURING loadBoard's IPC flips isPathPending
  // true, but reconcileBoardJsonChange's pre-read check is stale by now. A
  // silent replaceCache would clobber that just-made edit, so defer to the
  // dirty-editor prompt instead of overwriting it.
  if (guardPending && isPathPending(rel)) {
    promptBoardChangedExternally(rel, boardId);
    return;
  }
  // L14 (Audit-13) — rebind the stored path to the OS-reported casing. A
  // case-only external rename/edit (`samePath` matched it in
  // `findBoardIdForPath`, so the fold is equal but the raw casing may differ)
  // would otherwise leave `boardPaths[boardId]` at the stale casing — and a
  // later tree reconcile could then treat the board as "missing on disk" and
  // evict it. `renameBoardPath` no-ops when the path is byte-identical and
  // rebinds the single matching entry otherwise (L2 made it case-only aware).
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
    actions: [
      {
        label: 'Reload',
        handler: () => {
          // reloadBoardFromDisk reads the active vault path + re-checks vault
          // identity across its async load itself (Audit-6 H4).
          void reloadBoardFromDisk(rel, boardId);
        },
      },
      {
        label: 'Keep your edits',
        handler: () => {
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
 * If the user had pending in-memory tag mutations (the scheduler's
 * debounce hadn't fired yet), those are already on the next-save path
 * and will overwrite the external edit when the debounce lands; a
 * tag-rewrite sweep mid-flight is protected by the rewrite sentinel
 * which routes through `tagRewriteSentinel`.
 */
async function reconcileTagsJsonChange(event: ExternalChangeEvent): Promise<void> {
  if (isRecentSelfWrite(event.filename)) return;
  // Audit-6 H3 — capture identity before the async `tags:load`. A vault swap
  // landing during the read would otherwise make the `applyExternalReload`
  // below (which `scheduleSave`s unconditionally) persist vault A's tag
  // registry into vault B's `.filo/tags.json` on disk. Re-check after the await.
  const captured = captureVaultIdentity();
  const vaultRoot = vaultStore.path;
  if (!vaultRoot) return;
  try {
    // Audit-14 4.4 — assertIpcOk re-throws a `{ ok: false }` error envelope
    // into the catch below; a bare string|null passes through unchanged.
    const raw = assertIpcOk(
      await window.filo.invoke('tags:load', vaultRoot),
      'tags:load',
    ) as string | null;
    if (!isStillSameVault(captured)) return;
    // F6 — route through the version migrator so an externally-written
    // from-future tags.json flips the store read-only (preventing a
    // downgrade re-save) instead of being parsed + persisted blindly.
    const loaded = loadTagsFile(raw);
    // Audit-17 0.2 — `applyExternalReload` returns false when the disk copy
    // deep-equals our in-memory registry (a self-write echo surfacing in the
    // 30 s reconcile pass). Skip the toast AND the re-save in that case so an
    // in-app tags save can't spin a perpetual "modified externally" + re-save
    // loop. Only a genuine external diff surfaces the toast.
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
 * Audit-17 0.2 (accepted) — the theme/template reconcilers share the tags
 * reconciler's expired-TTL hole: a self-write's echo can surface in the 30 s
 * reconcile pass and trigger one spurious refresh/re-apply. Unlike tags this
 * does NOT loop — neither reconciler re-saves on reload — so the cost is a
 * single (visual-only) CSS-variable re-apply per self-edit. A content-compare
 * would need a second theme-file load to dedup; not worth it for a one-shot.
 */
async function reconcileThemeChange(event: ExternalChangeEvent): Promise<void> {
  if (isRecentSelfWrite(event.filename)) return;
  // Audit-6 L27 (theme variant of H3/H4) — capture identity before the async
  // theme reload; a swap during it would otherwise re-apply the outgoing
  // vault's theme over the new vault (visual-only, same root cause).
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

// ── Document / attachment batched reconcilers (legacy bridge) ─────────

/**
 * Phase 3 / 3.2 — bridges the existing `vaultStore.handleExternalMarkdownChanges`
 * surface into the registry so the dispatcher is exhaustive. The store
 * method keeps the pre-Phase-3 cross-store coordination logic (vault
 * index, frontmatter sync, partial-read retry, dirty-editor prompt,
 * properties-popup-dirty path); the bridge just adapts the registry's
 * event shape to its `string[]` argument.
 */
const documentBatchedReconciler: BatchedReconciler = {
  kind: 'document',
  handleBatch: async (events) => {
    // Audit-7 L15 — self-write filtering now lives INSIDE
    // handleExternalMarkdownChanges (single authority, so the partial-read-
    // retry timer that re-invokes it directly is filtered too). The bridge
    // just forwards filenames; the handler drops recent self-writes.
    const paths = events.map((e) => e.filename);
    if (paths.length === 0) return;
    await vaultStore.handleExternalMarkdownChanges(paths);
  },
};

const attachmentBatchedReconciler: BatchedReconciler = {
  kind: 'attachment',
  // L5 (Audit-12) — fire-and-forget so the handler's 500 ms attachment-delete
  // grace deferral runs OUTSIDE the shared rename queue this batch dispatch is
  // awaited inside (vault.svelte.ts `enqueueRenameQueueWork`). The handler has
  // its own re-existence + vault-swap guards, so it needs no queue ordering;
  // awaiting it here stalled every unrelated .md / .board.json reconcile in the
  // batch — and the next queued rename/tree event — behind the grace window.
  // The detached promise reports its own failures (the handler's per-probe
  // guards plus this top-level catch).
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
 * Phase 3 / 3.2 — registers every renderer-side reconciler with the
 * dispatcher at module-load time. The four new reconcilers are
 * single-event; document and attachment are batched (legacy shape).
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

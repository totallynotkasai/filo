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
import { isRecentSelfWrite, isPathPending } from '../lib/boards/boardSaver';
import { loadBoard } from '../lib/boards/boardLoader';
import { loadTagsFile } from '../lib/vault/tagsStorage';

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
  if (isRecentSelfWrite(rel)) return;
  const vaultRoot = vaultStore.path;
  if (!vaultRoot) return;

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
  await reloadBoardFromDisk(vaultRoot, rel, boardId);
}

function findBoardIdForPath(rel: string): string | null {
  const paths = boardStore.paths;
  for (const [boardId, boardPath] of Object.entries(paths)) {
    if (boardPath === rel) return boardId;
  }
  return null;
}

async function reloadBoardFromDisk(
  vaultRoot: string,
  rel: string,
  boardId: string,
): Promise<void> {
  const result = await loadBoard(vaultRoot, rel);
  if (!result.ok) {
    reportError(
      'externalChange.board',
      new Error(`${result.error}: ${result.message}`),
      `External change to "${rel}" couldn't be applied (load failed). Filo's in-memory copy is unchanged.`,
    );
    return;
  }
  // Use the boardCache replace path: write the freshly-loaded data
  // straight into the cache slot for this boardId. `replaceCache`
  // accepts a full snapshot, so build one with just this entry merged
  // over the live cache.
  const merged = { ...boardStore.cache, [boardId]: result.data };
  boardCacheStore.replaceCache(merged);
}

function promptBoardChangedExternally(rel: string, boardId: string): void {
  const vaultRoot = vaultStore.path;
  uiStore.pushToast({
    text: `Board file "${rel}" was modified externally while you had unsaved changes. Reload from disk (discard your edits), or keep your edits and overwrite on next save?`,
    type: 'warning',
    duration: 0,
    actions: [
      {
        label: 'Reload',
        handler: () => {
          if (!vaultRoot) return;
          void reloadBoardFromDisk(vaultRoot, rel, boardId);
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
  const vaultRoot = vaultStore.path;
  if (!vaultRoot) return;
  try {
    const raw = (await window.filo.invoke('tags:load', vaultRoot)) as string | null;
    // F6 — route through the version migrator so an externally-written
    // from-future tags.json flips the store read-only (preventing a
    // downgrade re-save) instead of being parsed + persisted blindly.
    const loaded = loadTagsFile(raw);
    fileTagsStore.applyExternalReload(loaded);
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
 */
async function reconcileThemeChange(event: ExternalChangeEvent): Promise<void> {
  if (isRecentSelfWrite(event.filename)) return;
  const vaultRoot = vaultStore.path;
  if (!vaultRoot) return;
  try {
    await themeStore.refreshAvailable(vaultRoot);
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
    const paths = events
      .map((e) => e.filename)
      .filter((p) => !isRecentSelfWrite(p));
    if (paths.length === 0) return;
    await vaultStore.handleExternalMarkdownChanges(paths);
  },
};

const attachmentBatchedReconciler: BatchedReconciler = {
  kind: 'attachment',
  handleBatch: async (events) => {
    const paths = events
      .map((e) => e.filename)
      .filter((p) => !isRecentSelfWrite(p));
    if (paths.length === 0) return;
    await vaultStore.handleExternalAttachmentChanges(paths);
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

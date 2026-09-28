import { SvelteSet } from 'svelte/reactivity';
import type {
  FileTreeNode,
  VaultSortField,
  VaultSortDirection,
  VaultGroupField,
} from '../../shared/types';
import type { Project, ProjectSettings, WorkspaceState } from '../schema/index';
import { vaultIndexStore } from './vaultIndex.svelte';
import { tabStore } from './tabs.svelte';
import { uiStore } from './ui.svelte';
import { boardStore } from './board.svelte';
import { boardCacheStore } from './boardCache.svelte';
import { historyStore } from './history.svelte';
import { workspaceStore } from './workspace.svelte';
import { themeStore } from './theme.svelte';
import { normalizePath, toVaultRelative } from '../lib/utils/path';
// Aliased import — the vault store has its own local `let vaultPath = $state<string>('')`
// which shadows the constructor name otherwise.
import { vaultPath as brandVaultPath, type VaultPath } from '../../shared/vaultPath';
import { checkRecovery, markClean } from '../lib/vault/dirtyFlagRecovery';
import { readQuitFailureBreadcrumb, clearQuitFailureBreadcrumb, runPostBreadcrumbChecks } from '../lib/vault/quitFailureRecovery';
import {
  readPendingRewrite,
  clearPendingRewrite,
  hasPartialTagRewriteState,
  hasPartialTagRemovalState,
} from '../lib/vault/tagRewriteSentinel';
import { readPendingRenameCascades } from '../lib/vault/renameCascadeSentinel';
import { discardRenameCascade, repairRenameCascade } from '../lib/vault/renameCascadeRepair';
import { noteFolderMoves, takeFolderMoves } from '../lib/vault/unreconciledFolderMoves';
import { clearPinsOfMissingFolders } from '../lib/vault/folderPins';
import { assertBaselinesSeeded } from '../lib/vault/fileBaselineRegistry';
import {
  sortTree,
  filterTree,
  treesEqual,
  flattenTreePaths,
  type SortConfig,
} from '../lib/vault/vaultTreeSort';
import {
  loadVaultCandidate,
  type VaultCandidate,
} from '../lib/vault/vaultCandidate';
import { openFailed, openVaultFailureOf, type OpenVaultReport } from '../lib/vault/vaultOpenFailure';
import {
  beginVaultGeneration,
  captureVaultIdentity,
  isStillSameVault,
} from '../lib/vault/vaultIdentity';
import { isRenameInFlight } from '../lib/vault/renameInFlight';
import { markBoardProvisionallyMissing } from './boardProvisionalMissing';
import { adoptUntrackedTreeBoards } from './boardDiscovery';
import {
  scheduleConfigWrite,
  scheduleMiscWrite,
  flushAll,
  flushAllMisc,
  seedConfigSnapshots,
  seedViewportsCache,
  markCorruptConfigTarget,
  hasFailedWrites,
  type BoardFileData,
} from '../lib/boards/boardSaver';
import { markSalvagedSettingsFile, type ConfigWriteArgs } from '../lib/boards/configWriteScheduler';
import {
  dispatchExternalChangeBatch,
  type ExternalChangeEvent,
} from '../lib/vault/externalChangeRegistry';
// Side-effect import: registers the board / tags / theme / template
// reconcilers + the document / attachment batched bridges. Must load
// before `listenForChanges` runs, which it does because Svelte's
// module-graph evaluation finishes before `App.svelte` mounts. The
// registration itself is wrapped in `queueMicrotask` to defer past
// the circular dependency between this module and vaultExternalReconcilers.
import './vaultExternalReconcilers';
import { noteStore } from './notes.svelte';
import { setActiveVaultPath } from '../lib/vault/activeVaultPath';
import { reportError } from '../lib/utils/errorBus';
import { invokeOk } from '../lib/utils/invokeOk';
import { createTrailingDebounce } from '../lib/utils/trailingDebounce';
import { flushAllComponents } from '../lib/boards/componentFlush';
import { fileTagsStore } from './fileTags.svelte';
import { emptyTagsFile } from '../lib/vault/tagsStorage';
import { fireVaultSwap, isVaultTearingDown, onVaultSwap } from '../core/vaultLifecycle';
import type { VaultContext } from './vaultStoreTypes';
import { makeTreeSlice } from './vaultTree';
import { makeProjectSlice } from './vaultProject';
import { makeRecoverySlice } from './vaultRecovery';
import { makeRootFolderSlice } from './vaultRootFolder';
import { makeFolderOpsSlice } from './vaultFolderOps';
import { makeExternalChangesSlice } from './vaultExternalChanges';
import { saveBeforeLeaving, type LeaveOutcome } from './vaultLeaveGuard';

/**
 * Vault store — owns the open vault's lifecycle (open/close/save), the
 * virtual Project view for legacy consumers, and the file-tree UI state
 * (search, sort, expanded folders).
 *
 * Per-concern slices live in sibling `vault*.ts` files (tree UI, project
 * metadata, recovery, active-root-folder, folder ops, external changes).
 * Boards themselves (cache, paths, CRUD) live in `boardStore`.
 * Layout state (split panes, sidebar, active pane) lives in `workspaceStore`.
 * Tab state lives in `tabStore`.
 */

// ── File tree state ──
let vaultPath = $state<string>('');
let fileTree = $state<FileTreeNode[]>([]);
let searchQuery = $state<string>('');
let isLoading = $state<boolean>(false);
let expandedFolders = $state<Set<string>>(new Set());
let selectedPaths = $state<Set<string>>(new Set());

// ── Manual sidebar order (used when sortField === 'none') ──
//
// Keyed by parent folder absolute path (vault root = ''). Each value is the
// ordered list of child node absolute paths the user has dragged into place.
// Loaded from `.filo/sidebar-order.json` on vault open and persisted with a
// 300ms idle debounce on every reorder.
let manualOrder = $state<Record<string, string[]>>({});

// The sidebar-order write goes through `scheduleMiscWrite` so it joins the
// inflight / sentinel / failed-path pipeline — a failed config:save surfaces
// instead of silently dropping a manual drag.
const SIDEBAR_ORDER_KEY = 'config:.filo/sidebar-order.json';
const SIDEBAR_ORDER_PATH = '.filo/sidebar-order.json';

// External-rename serialisation queue. Each `vault:file-renamed` event appends
// to this chain so concurrent OS-level renames (a `git mv` burst, sync batch)
// propagate in arrival order — otherwise two renames touching the same
// `.board.json` could interleave and write A's name with B's body.
let renameQueue: Promise<unknown> = Promise.resolve();

// Non-null while a vault swap is mid-flight (between `vault:close` and
// `commitVaultCandidate`). `save()` awaits it before draining so a quit in that
// window doesn't fire writes against the released registry. Plain module var —
// not reactive UI.
let swapInProgress: Promise<void> | null = null;

// ── Project / vault metadata state ──
let currentProject = $state<Project | null>(null);

// ── Recovery UX — files that were in flight at last abnormal shutdown ──
let recoveryPendingPaths = $state<string[]>([]);

/**
 * Pending resolver for the recovery-files modal. Set when the recovery
 * sequencer opens the modal; resolved by `acknowledgeRecovery()` so the
 * sequencer can advance without stacking modals. Carries the vault path
 * captured at creation so a swap during the modal's life can be detected.
 */
let recoveryDismissedResolver: { resolve: () => void; vaultPath: string } | null = null;

/**
 * Promisifies the recovery-files modal close; resolves via
 * `acknowledgeRecovery`. Every close path acknowledges (Dismiss directly;
 * Esc / X / backdrop via the Modal `beforeClose` hook in AppShell), so the
 * sequencer can't park forever.
 *
 * A second `openVault()` while a modal is parked would orphan the prior
 * resolver, so resolve the stale one before overwriting; its downstream
 * guarded steps no-op since the vault has swapped.
 */
function awaitRecoveryDismiss(): Promise<void> {
  const stale = recoveryDismissedResolver;
  recoveryDismissedResolver = null;
  stale?.resolve();
  const capturedVaultPath = vaultPath ?? '';
  return new Promise((resolve) => {
    recoveryDismissedResolver = { resolve, vaultPath: capturedVaultPath };
  });
}

/**
 * Promisifies `uiStore.openConfirm` (true on Confirm, false on Cancel); the
 * original callbacks still fire. Async `onConfirm` / `onCancel` are AWAITED
 * before resolving, so the sequencer's next step can't start mid-flight (two
 * recoveries mutating the board cache concurrently).
 */
function awaitConfirm(config: {
  title: string;
  body: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm?: () => void | Promise<void>;
  onCancel?: () => void | Promise<void>;
}): Promise<boolean> {
  return new Promise((resolve) => {
    uiStore.openConfirm({
      title: config.title,
      body: config.body,
      confirmLabel: config.confirmLabel,
      cancelLabel: config.cancelLabel,
      danger: config.danger,
      onConfirm: async () => {
        try {
          await config.onConfirm?.();
        } finally {
          resolve(true);
        }
      },
      onCancel: async () => {
        try {
          await config.onCancel?.();
        } finally {
          resolve(false);
        }
      },
    });
  });
}

function getBoardWriteArgs(
  boardId: string,
): { vaultRoot: string; boardPath: string; cached: BoardFileData } | null {
  if (!vaultPath) return null;
  const boardPath = boardStore.paths[boardId];
  const cached = boardStore.cache[boardId];
  if (!boardPath || !cached) return null;
  return { vaultRoot: vaultPath, boardPath, cached };
}

function getConfigWriteArgs(): ConfigWriteArgs | null {
  if (!vaultPath || !currentProject) return null;
  const settings = JSON.parse(JSON.stringify(currentProject.settings)) as ProjectSettings;
  const workspace: WorkspaceState = tabStore.serialize();
  return {
    vaultRoot: vaultPath,
    settings,
    theme: currentProject.theme ?? 'light',
    workspace,
    layout: workspaceStore.serialize(),
    name: currentProject.name,
  };
}

function readSortConfig(): SortConfig {
  const g = currentProject?.settings.general;
  return {
    sortField: (g?.sidebarSortField as VaultSortField) ?? 'none',
    sortDirection: (g?.sidebarSortDirection as VaultSortDirection) ?? 'asc',
    groupField: (g?.sidebarGroupField as VaultGroupField) ?? 'none',
    groupDirection: (g?.sidebarGroupDirection as VaultSortDirection) ?? 'asc',
    manualOrder,
  };
}

function scheduleSidebarOrderWrite(): void {
  if (!vaultPath) return;
  // Route through `scheduleMiscWrite` for sentinel tracking, the envelope
  // check, the Ctrl+S / quit drain and the corruption gate. The getter
  // re-reads `manualOrder` + `vaultPath` at fire time (the latest drag).
  scheduleMiscWrite(SIDEBAR_ORDER_KEY, () => {
    if (!vaultPath) return null;
    const vaultRoot = vaultPath;
    const snapshot = JSON.parse(JSON.stringify(manualOrder)) as Record<string, string[]>;
    return {
      vaultRoot,
      path: SIDEBAR_ORDER_PATH,
      json: JSON.stringify(snapshot, null, 2),
      write: async () => {
        await invokeOk('config:save', vaultRoot, 'sidebar-order.json', snapshot);
      },
    };
  });
}

// Memoised sort/filter result. Without it, `get tree()` would allocate a fresh
// node graph on every reactive read, churning VaultSidebar's {#each} and every
// VaultFileItem's $derived (visible flicker).
const treeView = $derived(sortTree(filterTree(fileTree, searchQuery), readSortConfig()));

// A vault teardown's resets aren't user changes (see isVaultTearingDown).
function markMetaDirty(): void {
  if (!isVaultTearingDown()) scheduleConfigWrite(() => getConfigWriteArgs());
}

const vaultCtx: VaultContext = {
  getVaultPath: () => vaultPath,
  setVaultPath: (next) => { vaultPath = next; beginVaultGeneration(next); }, // keep the generation invariant in lock-step (no bare path set)
  getFileTree: () => fileTree,
  setFileTree: (next) => { fileTree = next; },
  getSearchQuery: () => searchQuery,
  setSearchQuery: (next) => { searchQuery = next; },
  getIsLoading: () => isLoading,
  setIsLoading: (next) => { isLoading = next; },
  getExpandedFolders: () => expandedFolders,
  setExpandedFolders: (next) => { expandedFolders = next; },
  getSelectedPaths: () => selectedPaths,
  setSelectedPaths: (next) => { selectedPaths = next; },
  getProject: () => currentProject,
  setProject: (next) => { currentProject = next; },
  getRecoveryPendingPaths: () => recoveryPendingPaths,
  setRecoveryPendingPaths: (next) => { recoveryPendingPaths = next; },
  resolveRecoveryDismissed: () => {
    const ctx = recoveryDismissedResolver;
    if (!ctx) return;
    recoveryDismissedResolver = null;
    // Always resolve so the awaiter can't hang; the sequencer's post-await
    // steps short-circuit if the vault changed during the modal's life.
    ctx.resolve();
  },
  markMetaDirty,
  // refreshTree returns a success boolean; slice consumers don't need it.
  refreshTree: async () => { await vaultStore.refreshTree(); },
  clearSelection: () => vaultStore.clearSelection(),
  clearActiveRootFolderIfMatches: (deletedPath) =>
    vaultStore.clearActiveRootFolderIfMatches(deletedPath),
  // Delegate to the orchestrator's rename queue.
  enqueueRenameQueueWork: (task) => vaultStore.enqueueRenameQueueWork(task),
};

const treeSlice = makeTreeSlice(vaultCtx);
const projectSlice = makeProjectSlice(vaultCtx);
const recoverySlice = makeRecoverySlice(vaultCtx);
const rootFolderSlice = makeRootFolderSlice(vaultCtx);
const folderOpsSlice = makeFolderOpsSlice(vaultCtx);
const externalChangesSlice = makeExternalChangesSlice(vaultCtx);

/**
 * Synchronous commit of a `VaultCandidate`. Every mutation
 * inside here is non-throwing: the candidate has already validated all
 * its inputs (theme base / tags / settings / config files), and the
 * stores being hydrated accept pre-loaded data directly without any
 * further I/O. Theme application is the one operation that COULD still
 * fail at the DOM level — if it does, `themeStore.commitFromCandidate`
 * falls back to built-in 'light' and reports the error, but the swap
 * itself completes.
 */
function commitVaultCandidate(
  candidate: VaultCandidate,
  store: { wireTabChangeListener: () => void },
): void {
  // Drain corruption sentinels into the writer scheduler so the next
  // debounced write won't overwrite a hand-edited bad file with our
  // in-memory defaults. A settings file read with some fields reset is copied
  // to .filo/recovery/ before its next write.
  for (const target of candidate.corruptionTargets) markCorruptConfigTarget(target);
  for (const file of candidate.salvagedSettings) markSalvagedSettingsFile(file);
  // Drain warning toasts the candidate buffered. We surface them
  // post-commit so a candidate that ultimately FAILS doesn't leave the
  // user staring at warning toasts for a vault they never opened.
  for (const w of candidate.warnings) {
    uiStore.pushToast(w); // may carry sticky + actions (board Retry)
  }

  // ── The actual atomic-looking swap ──
  currentProject = candidate.project;
  vaultPath = candidate.path;
  // Bump the vault-identity generation in lock-step with `vaultPath` so work
  // that captured the OUTGOING vault's identity reads as stale when it resumes
  // (close→reopen of the same path still bumps the generation).
  beginVaultGeneration(candidate.path);
  manualOrder = candidate.manualOrder;
  fileTree = candidate.tree;

  // ── Hydrate dependent stores (each method accepts data directly) ──
  boardStore.hydrateCache(candidate.boardCache, candidate.boardPaths);
  // Mark every board the loader repaired on the way in dirty (markDirty is
  // idempotent): orphan/dup prune (bytes snapshotted to `.filo/recovery/`),
  // boardId normalisation.
  const repairedBoardIds = [
    ...candidate.prunedBoardIds,
    ...candidate.normalizedBoardIds,
  ];
  for (const id of repairedBoardIds) {
    boardCacheStore.markDirty(id);
  }

  // Seed viewports BEFORE tab hydration so the BoardRouter effect
  // that fires for the restored active tab can immediately read the
  // saved camera position.
  seedViewportsCache(candidate.path, candidate.viewports);

  store.wireTabChangeListener();
  workspaceStore.hydrate(candidate.workspaceConfig as Parameters<typeof workspaceStore.hydrate>[0]);
  // Prime the per-target snapshot cache so the first save after open
  // only writes the .filo/ files the user actually changed.
  seedConfigSnapshots(
    candidate.settings,
    candidate.project.theme,
    candidate.project.workspace,
    workspaceStore.serialize(),
    candidate.project.name,
  );
  workspaceStore.setChangeListener(() => markMetaDirty());
  // Hydrate tabs LAST: at this point currentProject, boardCache, and
  // workspaceStore are all populated, so the BoardRouter effect that
  // fires for the restored active tab sees a fully-formed project on
  // its first run.
  tabStore.hydrateFromWorkspace(candidate.project.workspace, candidate.project.boards, { tree: candidate.tree, root: candidate.path });

  // Tags + theme — both pre-loaded, both synchronous.
  fileTagsStore.commitFromCandidate(candidate.path, candidate.tagsFile, candidate.tagsReadOnly);
  const themeResult = themeStore.commitFromCandidate({
    availableIds: candidate.availableThemeIds,
    themeCache: candidate.themeCache,
    activeId: candidate.activeThemeId,
    activeFile: candidate.activeThemeFile,
  });
  if (!themeResult.ok) {
    // The candidate-phase validator already rejected obviously bad
    // themes (unknown `base`), so reaching here means the DOM apply
    // itself failed — rare. Surface a non-blocking toast; the vault is
    // still fully open against the fallback built-in palette.
    uiStore.toast(
      `Theme "${candidate.activeThemeId}" couldn't be applied${themeResult.error ? ` — ${themeResult.error}` : ''}. Reverted to default.`,
      'warning',
      7000,
    );
  }

  // Re-run broken-ref scan against the freshly loaded tree + boardCache.
  // Mirrors the recompute that `refreshTree` performs on every tick;
  // doing it inline here means we don't re-fetch the tree just to
  // recompute against state we already have.
  boardStore.recomputeBrokenRefs(candidate.knownPaths);

  // Dev-only tripwire: every loaded `.board.json` should have had its drift
  // baseline seeded by `boardLoader`. Warns (never throws); no-op in production.
  assertBaselinesSeeded(Object.values(candidate.boardPaths), 'board');
  // Same tripwire for the `.filo/` configs that exist on disk — without the
  // seed, the configWriteScheduler's ENOENT-skip guard goes inert.
  assertBaselinesSeeded(candidate.seededConfigBaselinePaths, 'config');
}

/**
 * Fires the long-running work that doesn't need to block
 * the commit (or be retried atomically on its failure). Each task
 * here can fail without leaving stale global state, because the
 * commit point has already run.
 *
 *   - `vault:watch` failure surfaces a toast and leaves the vault
 *     open without an external-edit watcher; user can reopen the
 *     vault to retry.
 *   - `vaultIndexStore.rebuild` is best-effort full-text indexing;
 *     if it fails the search UI degrades but nothing else does.
 *   - The recovery sequencer surfaces three deferred modals (`.dirty`,
 *     tag-rewrite, rename-cascade) but each handles its own errors.
 */
function runPostCommitTasks(
  candidate: VaultCandidate,
  store: { handleExternalMarkdownChanges?: unknown },
): void {
  void store;
  const newVaultPath = candidate.path;
  // Generation-aware identity, so the post-await re-check below distinguishes a
  // close→reopen of the SAME path (a new generation) from a no-swap — a path
  // string compare can't.
  const identity = captureVaultIdentity();

  // ── 1. File watcher — must run against the committed vaultPath ───
  void (async () => {
    try {
      await invokeOk('vault:watch', newVaultPath);
    } catch (err) {
      reportError(
        'vault.watch',
        err,
        "Filo couldn't start the external-edit watcher. Edits made in other apps won't auto-refresh until you reopen the vault.",
      );
    }
  })();

  // ── 2. Vault-index rebuild + tags self-seed / orphan prune ───────
  void vaultIndexStore.rebuild(fileTree).then(() => {
    // Vault-identity guard. The rebuild yields, so an A→B swap can leave
    // `fileTree` pointing at B while `newVaultPath` is still A — pruning B's
    // tags against A's prefix would drop every entry and save them into B's
    // tags.json (`assertActiveVault` can't help: B is legitimately active).
    if (!isStillSameVault(identity)) return;
    if (!fileTagsStore.isEmpty()) {
      // Prune `.filo/tags.json:fileTags` entries whose path is no longer in
      // the tree. Uses the LIVE `fileTree`, not the load-time `candidate.tree`:
      // a file added/moved during the index rebuild would otherwise lose its
      // tag entry. The identity bail above guarantees it's this vault's tree.
      const flat = flattenTreePaths(fileTree, newVaultPath);
      const dropped = fileTagsStore.pruneOrphanFileTags(flat);
      if (dropped.length > 0) {
        uiStore.toast(
          `Pruned ${dropped.length} stale tag entr${dropped.length === 1 ? 'y' : 'ies'} from .filo/tags.json (files no longer in the vault).`,
          'info',
          5000,
        );
      }
      // Surface drift: orphan tag references (a tile or file points
      // at a tag name that has no registry entry).
      const { tile, file } = fileTagsStore.detectOrphans();
      if (tile + file > 0) {
        uiStore.toast(
          `Found ${tile + file} undefined tag reference${tile + file === 1 ? '' : 's'} (${tile} on tiles, ${file} on files). Open the Tags Browser to review.`,
          'warning',
          7000,
        );
      }
      return;
    }
    // tags.json was empty — seed the tag registry from the frontmatter tags
    // the index rebuild found. A note's tags themselves stay in its file.
    const seed = emptyTagsFile();
    let mutated = false;
    for (const md of vaultIndexStore.allMetadata()) {
      if (md.tags.length === 0) continue;
      const unique = Array.from(new SvelteSet(
        md.tags.map((t) => t.replace(/^#/, '').trim()).filter(Boolean),
      ));
      if (unique.length === 0) continue;
      for (const t of unique) {
        if (!seed.tags[t]) seed.tags[t] = { color: '#3a86ff', createdAt: Date.now() };
      }
      mutated = true;
    }
    if (mutated) fileTagsStore.setAll(seed);
  }).catch((err) => {
    // `rebuild()` can't reject (internally caught); backstop a programming
    // error in the follow-up above.
    reportError(
      'vault.postCommit',
      err,
      'Post-open housekeeping failed (frontmatter reconcile / tag seeding). Reopen the vault to retry.',
    );
  });

  // ── 3. Recovery sentinel sequencer ───────────────────────────────
  void runRecoverySequencer(newVaultPath);
}

/**
 * Best-effort registry release after a failed open with NO
 * outgoing vault to revert to. init-config arms the registry before later
 * candidate reads can throw; left armed, every OTHER vault fails the
 * "different vault already active" guard until restart.
 */
async function releaseRegistryBestEffort(): Promise<void> {
  try {
    await window.filo.invoke('vault:close');
  } catch {
    // Best-effort — the home screen is the safe fallback either way.
  }
}

/**
 * Revert to the outgoing vault after a failed candidate load.
 *
 * `openVault` must tear the outgoing vault down BEFORE the fallible candidate
 * load: `vault:init-config` (the load's first IPC) is the single registry-arming
 * authority and main refuses to re-anchor while a different vault is active,
 * and `pre-swap` handlers must flush the outgoing vault's sentinels while it is
 * still active. So a load that throws leaves the outgoing stores reset and the
 * registry released.
 *
 * Rather than strand the user on an empty-looking "still vault A" (where a
 * follow-up save could clobber A's `.filo/` layout), reopen the outgoing vault
 * from disk. `vault:close` first drops any registry the half-opened new vault
 * left armed. Saved edits are read back; edits left behind with "Open anyway"
 * are in `.filo/recovery/`, and the preserved `.filo/.dirty` resurfaces the
 * Recovery modal. If the outgoing vault
 * is also unreadable, fall to a clean no-vault home state.
 */
async function revertToOutgoingVault(
  outgoingPath: string,
  store: { wireTabChangeListener: () => void; handleExternalMarkdownChanges?: unknown },
): Promise<void> {
  try {
    // Release whatever registry the failed new-vault load left armed (it may
    // have init-config'd the new vault before a later read threw). Best-effort:
    // loadVaultCandidate below re-anchors the outgoing vault either way
    // (init-config is idempotent for the same path).
    try {
      await window.filo.invoke('vault:close');
    } catch {
      // Ignore — re-anchor proceeds regardless.
    }
    renameQueue = Promise.resolve();
    const restored = await loadVaultCandidate(outgoingPath);
    commitVaultCandidate(restored, store);
    runPostCommitTasks(restored, store);
  } catch (revertErr) {
    reportError(
      'vault.revert',
      revertErr,
      'Could not reopen the previous vault after a failed swap — returning to the home screen.',
    );
    // Release the registry too: `loadVaultCandidate` may have re-anchored the
    // outgoing vault (init-config) before its later read threw, which would
    // otherwise block opening ANY vault next (main refuses to re-anchor while one
    // is active). Best-effort.
    try {
      await window.filo.invoke('vault:close');
    } catch {
      // Ignore — nothing more we can do; the home screen is the safe fallback.
    }
    // Mirror closeVault's teardown so no stale currentProject / vaultPath points
    // at a vault whose stores are empty and whose .filo/ a follow-up save could
    // overwrite.
    currentProject = null;
    vaultPath = '';
    beginVaultGeneration('');
    fileTree = [];
  }
}

/**
 * Sequence the recovery sentinel surfaces so they appear one after another
 * rather than as a stack. Each step awaits the previous one's user action
 * before opening the next; a failing step is reported but doesn't abort the
 * chain.
 *
 * The vault may swap during any `await`, so every step re-checks the captured
 * identity and short-circuits rather than surface against the wrong vault.
 */
async function runRecoverySequencer(newVaultPath: string): Promise<void> {
  // Generation-aware `{ path, generation }` — a path-only compare would pass
  // across a close+reopen of the SAME path and let the outgoing session's
  // prompts / mutations land in the new one.
  const captured = captureVaultIdentity();

  // ── 0. `.filo/quit-failure.json` — preserved-partial locations ──
  // Surfaced FIRST as a standalone toast so it isn't gated behind the `.dirty`
  // modal. The breadcrumb is cleared only when the user dismisses the toast, so
  // a second crash before acknowledgement re-surfaces it.
  try {
    const quitFailure = await readQuitFailureBreadcrumb(newVaultPath);
    if (!isStillSameVault(captured)) return;
    if (quitFailure && quitFailure.files.length > 0) {
      const locations = quitFailure.files.map((f) => f.preservedPath).join('\n');
      uiStore.pushToast({
        text:
          `Filo couldn't fully save ${quitFailure.files.length} file(s) before the last quit. ` +
          `The unsaved bytes were preserved on disk — recover or delete them:\n${locations}`,
        type: 'error',
        duration: 0,
        // Only a genuine user dismiss may clear the breadcrumb — a vault swap /
        // toast-cap eviction would delete it before the user reads it.
        acknowledgeOnly: true,
        onDismiss: () => {
          if (isStillSameVault(captured)) void clearQuitFailureBreadcrumb(newVaultPath);
        },
      });
    }
  } catch (err) {
    reportError('vault.quit-failure-check', err, 'Failed to surface the quit-failure breadcrumb');
  }
  // AFTER the breadcrumb: sweep orphaned save temps; list foreign sentinels.
  await runPostBreadcrumbChecks(newVaultPath, captured);
  if (!isStillSameVault(captured)) return;

  // ── 1. `.filo/.dirty` — unflushed-files modal ───────────────────
  try {
    const status = await checkRecovery(newVaultPath);
    if (!isStillSameVault(captured)) return;
    if (status.needsRecovery && status.reason !== 'sentinel-unreadable') {
      const pending = status.pendingPaths ?? [];
      if (pending.length > 0) {
        // Recovery modal owns the markClean call — its Dismiss
        // button is the only "user acknowledged" signal.
        recoveryPendingPaths = pending;
        const dismissed = awaitRecoveryDismiss();
        uiStore.openModal('recovery-files');
        await dismissed;
        if (!isStillSameVault(captured)) return;
      } else {
        uiStore.pushToast({
          text: "Filo detected an incomplete write but couldn't identify the unflushed file. Check this machine's `.filo/.dirty.*` file manually if recent edits are missing.",
          type: 'error',
          duration: 0,
          // Acknowledge-only so a swap/cap can't `markClean` the sentinel unread.
          acknowledgeOnly: true,
          onDismiss: () => {
            if (isStillSameVault(captured)) void markClean(newVaultPath);
          },
        });
      }
    }
  } catch (err) {
    reportError(
      'vault.recovery-check',
      err,
      'Failed to check the crash-recovery sentinel — unflushed files may not be surfaced',
    );
  }

  // ── 2. `.filo/tag-rewrite-pending.json` — Resume / Discard ──────
  try {
    const res = await readPendingRewrite(newVaultPath);
    if (!isStillSameVault(captured)) return;
    if (res.payload) {
      const { oldName, newName, plan, preexistingNewNamePaths, committedPaths } = res.payload;
      const verb = newName === null ? 'removal' : 'rename';
      const target = newName === null ? `"${oldName}"` : `"${oldName}" → "${newName}"`;
      // Wait for the post-commit index rebuild (runs in parallel with this
      // sequencer) before sampling metadata — a mid-chunk index could miss
      // the `newName` carrier that proves a partial commit and offer
      // "Discard plan" on a vault that's mid-rename.
      if (newName !== null) {
        await vaultIndexStore.whenBuildComplete();
        if (!isStillSameVault(captured)) return;
      }
      // Detect partial state. A sweep that committed some files before the
      // crash leaves the vault split (rename: some .md carry `newName`, some
      // `oldName`; removal: some stripped, some not), so a bare Discard would
      // leave it split. Renames are classified from
      // the index (a `newName` carrier is the witness); removals can't be (an
      // absent tag ≠ "never had it") so they read the sentinel's `committedPaths`.
      const partialDetected =
        newName === null
          ? hasPartialTagRemovalState(committedPaths)
          : hasPartialTagRewriteState(
              newName,
              vaultIndexStore.allMetadata(),
              preexistingNewNamePaths,
            );
      const partialBody =
        newName === null
          ? `Filo found an unfinished tag removal (${target}) — the tag was already stripped from some files in the previous session. Resume to finish — Discard will finalise the removal so the vault doesn't split between files that still carry the tag and files that don't.`
          : `Filo found an unfinished tag rename (${target}) and some files have already been rewritten in the previous session. Resume to finish — Discard will finalise the rewrite so the vault doesn't split between the old and new tag.`;
      const body = partialDetected
        ? partialBody
        : `Filo found an unfinished tag ${verb} (${target}) that didn't complete in the previous session. Resume rewriting ${plan.length} file${plan.length === 1 ? '' : 's'}?`;
      // Converge forward — idempotent (already-processed files no-op); we can't
      // "undo" it (the sentinel holds the plan + progress, not a pre-edit snapshot).
      const convergeForward = async (): Promise<void> => {
        if (newName === null) {
          await fileTagsStore.removeTagEverywhere(oldName);
        } else {
          await fileTagsStore.renameTagEverywhere(oldName, newName);
        }
      };
      await awaitConfirm({
        title: `Incomplete tag ${verb} detected`,
        body,
        confirmLabel: 'Resume',
        cancelLabel: partialDetected ? 'Finalise & discard' : 'Discard plan',
        // Handlers return their promise so `awaitConfirm` awaits them and the
        // sequencer's next step can't race the converge.
        //
        // Both are vault-identity-guarded at entry AND after every await: the
        // pre-swap handler auto-CANCELS a parked confirm when another vault
        // opens, so onCancel can run with `fileTree` = vault B's tree and
        // `newVaultPath` = vault A's root. `flattenTreePaths` would then be
        // empty and the prune would wipe every fileTags entry into B's
        // tags.json (attachment tags are unrecoverable). No await separates
        // the final check from the prune.
        onConfirm: async () => {
          if (!isStillSameVault(captured)) return;
          await convergeForward();
        },
        onCancel: async () => {
          if (!isStillSameVault(captured)) return;
          // Partial: converge forward before clearing the breadcrumb so the
          // vault doesn't stay split; a clean state just clears it.
          if (partialDetected) {
            await convergeForward();
            if (!isStillSameVault(captured)) return;
          }
          await clearPendingRewrite(newVaultPath);
          if (!isStillSameVault(captured)) return;
          const flat = flattenTreePaths(fileTree, newVaultPath);
          fileTagsStore.pruneOrphanFileTags(flat);
        },
      });
    } else if (res.unreadable) {
      uiStore.pushToast({
        text: "Filo found a tag-rewrite breadcrumb but couldn't read it. Check this machine's `.filo/tag-rewrite-pending.*.json` manually if a previous tag rename looks incomplete.",
        type: 'warning',
        duration: 0,
      });
    }
  } catch (err) {
    reportError(
      'vault.tag-rewrite-recovery',
      err,
      'Failed to check the tag-rewrite recovery sentinel',
    );
  }

  // ── 3. `.filo/rename-cascade-pending.json` — Retry / Discard ────
  try {
    const res = await readPendingRenameCascades(newVaultPath);
    if (!isStillSameVault(captured)) return;
    if (res.entries && res.entries.length > 0) {
      const entries = res.entries;
      const summary = entries.length === 1
        ? `"${entries[0]?.oldPath ?? ''}" → "${entries[0]?.newPath ?? ''}"`
        : `${entries.length} renames`;
      const failedSummary = entries.flatMap((e) => e.failedBoardIds ?? []);
      const body = failedSummary.length > 0
        ? `Filo found an unfinished rename (${summary}) that didn't fully persist in the previous session. ${failedSummary.length} board file${failedSummary.length === 1 ? '' : 's'} still reference${failedSummary.length === 1 ? 's' : ''} the old path. Retry the cascade?`
        : `Filo found an unfinished rename (${summary}) that didn't fully persist in the previous session. Retry the cascade?`;
      await awaitConfirm({
        title: 'Incomplete rename detected',
        body,
        confirmLabel: 'Retry',
        cancelLabel: 'Discard',
        // Return the promise so `awaitConfirm` awaits the repair before the
        // sequencer's next step starts.
        onConfirm: async () => {
          // Thread the generation-aware identity so a swap before the click (or
          // mid-repair) bails instead of contaminating the new vault's cache.
          await repairRenameCascade(entries, newVaultPath, 'Retry', captured);
        },
        // "Discard" leaves everything as it is and only drops the breadcrumb.
        onCancel: () => discardRenameCascade(entries, newVaultPath, captured),
      });
    } else if (res.unreadable) {
      uiStore.pushToast({
        text: "Filo found a rename-cascade breadcrumb but couldn't read it. Check this machine's `.filo/rename-cascade-pending.*.json` manually if a previous rename looks incomplete.",
        type: 'warning',
        duration: 0,
      });
    }
  } catch (err) {
    reportError(
      'vault.rename-cascade-recovery',
      err,
      'Failed to check the rename-cascade recovery sentinel',
    );
  }

  // ── 4. `.filo/recovery/` — preserved-snapshot listing ─────
  // When Filo couldn't load a vault file but its bytes were intact, it
  // snapshots the originals into `.filo/recovery/<ts>/<basename>` before its
  // write pipeline can clobber them. Surface them once on open so the user
  // knows the backup exists and can recover or delete it; nothing is pruned here.
  try {
    const snapshots = await window.filo.invoke('recovery:list', newVaultPath);
    if (!isStillSameVault(captured)) return;
    if (snapshots.length > 0) {
      const shown = snapshots.slice(0, 8);
      const lines = shown.map((s) => `• ${s.basename} (${s.timestamp})`).join('\n');
      const more =
        snapshots.length > shown.length
          ? `\n…and ${snapshots.length - shown.length} more.`
          : '';
      const firstAbs = `${newVaultPath.replace(/[\\/]$/, '')}/${snapshots[0]?.relPath ?? ''}`;
      uiStore.pushToast({
        text:
          `Filo preserved ${snapshots.length} file snapshot${snapshots.length === 1 ? '' : 's'} in ` +
          `.filo/recovery/ from a previous failed-load window. Review or delete them when ` +
          `convenient:\n${lines}${more}`,
        type: 'warning',
        duration: 0,
        actions: [
          {
            label: 'Reveal',
            handler: () => {
              void window.filo.invoke('shell:show-item-in-folder', firstAbs);
            },
          },
        ],
      });
    }
  } catch (err) {
    // `recovery:list` re-throws a real scan failure (EACCES/EBUSY on a locked
    // share) rather than returning an empty list.
    reportError(
      'vault.recovery-snapshots',
      err,
      "Couldn't scan .filo/recovery for preserved snapshots — the folder may be locked. Check it manually if recent edits are missing.",
    );
  }
}

/**
 * Test seam — drives the recovery sentinel sequencer
 * directly so the rename-cascade Retry / Discard handlers can be exercised
 * without the full openVault path. Not referenced in production code.
 */
export function __runRecoverySequencerForTests(p: string): Promise<void> {
  return runRecoverySequencer(p);
}

export const vaultStore = {
  // ── File tree getters ──
  get path() { return vaultPath; },
  get tree() { return treeView; },
  get rawTree() { return fileTree; },
  get search() { return searchQuery; },
  get sortField(): VaultSortField {
    return (currentProject?.settings.general?.sidebarSortField as VaultSortField) ?? 'none';
  },
  get sortDirection(): VaultSortDirection {
    return (currentProject?.settings.general?.sidebarSortDirection as VaultSortDirection) ?? 'asc';
  },
  get groupField(): VaultGroupField {
    return (currentProject?.settings.general?.sidebarGroupField as VaultGroupField) ?? 'none';
  },
  get groupDirection(): VaultSortDirection {
    return (currentProject?.settings.general?.sidebarGroupDirection as VaultSortDirection) ?? 'asc';
  },
  get loading() { return isLoading; },
  get expandedFolders() { return expandedFolders; },
  get isOpen() { return vaultPath !== ''; },

  // ── Multi-selection (Ctrl/Cmd + click in the vault sidebar) ──
  //
  // Tracks the set of paths the user has selected so they can drag
  // multiple files into a folder at once. Stored as a Set wrapped in
  // `$state` (mirroring `expandedFolders`); mutations reassign the
  // whole set so Svelte tracks the change.
  get selectedPaths() { return selectedPaths; },
  clearSelection() {
    if (selectedPaths.size === 0) return;
    selectedPaths = new SvelteSet();
  },

  // ── Project metadata getters ──
  get project() { return currentProject; },
  get projectName() { return currentProject?.name ?? ''; },
  get theme() { return currentProject?.theme ?? 'light'; },

  // ── Recovery UX ──
  get recoveryPendingPaths() { return recoveryPendingPaths; },

  // ── File tree setters ──
  setPath(path: string) {
    vaultPath = path;
    // Keep the vault-identity generation and the committed-vault signal in
    // sync so production guards (which read those modules, not `vaultPath`)
    // stay consistent in unit tests, and a test can drive a swap by
    // re-`setPath`ing.
    beginVaultGeneration(path);
    setActiveVaultPath(path);
  },
  setTree(tree: FileTreeNode[]) { fileTree = tree; },
  setSearch(query: string) { searchQuery = query; },
  setLoading(loading: boolean) { isLoading = loading; },

  // ── Manual sidebar order (Sort By 'None') ──
  //
  // Reassigns the whole record so Svelte's reactive tracking fires. The
  // write is debounced (300ms idle) so a rapid sequence of drags collapses
  // into a single `.filo/sidebar-order.json` write.
  get manualOrder() { return manualOrder; },
  setManualOrder(parentAbs: string, orderedChildPaths: string[]) {
    const key = normalizePath(parentAbs);
    manualOrder = { ...manualOrder, [key]: orderedChildPaths.slice() };
    scheduleSidebarOrderWrite();
  },

  markMetaDirty,

  // ── Tree UI slice (sort/group, expanded folders, selection toggles) ──
  ...treeSlice,

  // ── Project slice (name, theme, project accessors) ──
  ...projectSlice,

  // ── Recovery slice ──
  ...recoverySlice,

  // ── Active root folder slice ──
  ...rootFolderSlice,
  // The spread above copies the slice's getters as values frozen at module
  // load (''), so the live getters must be defined here, after it.
  get activeRootFolder(): string { return rootFolderSlice.activeRootFolder; },
  get activeRootFolderAbs(): string { return rootFolderSlice.activeRootFolderAbs; },

  // ── Folder ops slice (create/rename/delete/move) ──
  ...folderOpsSlice,

  // ── External change handler slice ──
  ...externalChangesSlice,

  // ── Vault lifecycle ──

  /**
   * Opens an existing vault folder. Loads .filo/ config files,
   * scans + loads every .board.json, builds the virtual Project.
   *
   * Vault open is a transaction: `loadVaultCandidate` performs every
   * fallible I/O against a local snapshot; on success
   * `commitVaultCandidate` swaps globals synchronously. A throw in the
   * candidate phase leaves globals untouched, so the renderer can never
   * be half-open (path recorded but no watcher / tags / theme). On false,
   * `report.failure` says why (the user stayed, the folder is gone…).
   */
  async openVault(newVaultPath: string, report?: OpenVaultReport): Promise<boolean> {
    // Capture the outgoing vault path so a failed candidate load can revert to
    // it. See `revertToOutgoingVault`.
    const outgoingVaultPath: string | null = currentProject ? vaultPath || null : null;
    // Save the outgoing vault first; ask only if something is still unsaved
    // (see `saveBeforeLeaving`). `rescued` keeps the outgoing `.filo/.dirty`
    // so reopening that vault offers recovery.
    let leave: LeaveOutcome = 'saved';
    if (currentProject) {
      leave = await saveBeforeLeaving(() => this.save(), 'open');
      if (leave === 'cancelled') return openFailed(report, 'cancelled');
    }

    // Mark the swap "in progress" for the window during which the main-side
    // registry may be released but the new vault isn't committed. A quit
    // (`save()`) landing here would otherwise fire writes against the null
    // registry and fail closed with neither data nor a breadcrumb. Only needed
    // when there's an outgoing vault; the `finally` always settles it.
    const hadOutgoingVault = currentProject !== null;
    let resolveSwapWindow: () => void = () => {};
    // Local handle so the finally clears the module slot ONLY while it still
    // owns it — a concurrent second openVault overwrites `swapInProgress`, and
    // nulling ITS window mid-swap would let a quit drain inside it.
    let mySwapWindow: Promise<void> | null = null;
    if (hadOutgoingVault) {
      mySwapWindow = new Promise<void>((res) => { resolveSwapWindow = res; });
      swapInProgress = mySwapWindow;
    }
    try {
      if (currentProject) {
        // Fire the pre-swap lifecycle. Every store / scheduler / sentinel that holds vault-scoped state
        // subscribes via `onVaultSwap('pre-swap', ...)` at module load; the
        // event drains them in dependency order:
        //   - boardWriteScheduler cancels every queued debounced timer so a
        //     closure armed against the outgoing vault can't fire after the
        //     new vault opens.
        //   - writeStateTracking honours `saveOutgoing`: a clean save clears
        //     the `.filo/.dirty` sentinel; leaving with rescue copies keeps
        //     it, so reopening the outgoing vault surfaces the Recovery modal.
        //   - history / vaultIndex / tabs / workspace / etc. drop their local
        //     state so the new vault hydrates against a clean slate.
        await fireVaultSwap({
          phase: 'pre-swap',
          previousVault: vaultPath || null,
          nextVault: newVaultPath,
          saveOutgoing: leave === 'saved',
        });
        // Drop the rename queue's chain head (this module owns the swap event,
        // so it can't subscribe to it). Otherwise a stale watcher event queued
        // just before the swap keeps resolving against outgoing-vault state;
        // the new vault's first event runs on an empty chain.
        renameQueue = Promise.resolve();
        // Release the main-side registry before init-config;
        // board.ipc.ts refuses to re-anchor while a different vault is active.
        try {
          await window.filo.invoke('vault:close');
        } catch (err) {
          reportError('vault.close', err, 'Failed to release the previous vault');
        }
      }

      // ── Load the candidate against the new vault ───────
      // Every IPC + parse + recovery snapshot happens here against a
      // local object; nothing in `vaultStore` or any peer store is
      // touched until `commitVaultCandidate` runs synchronously below.
      let candidate: VaultCandidate;
      try {
        candidate = await loadVaultCandidate(newVaultPath);
      } catch (err) {
        // A caller that asks why (Home) says so itself when the folder is gone.
        if (!report || openVaultFailureOf(err) === 'failed') reportError('vault', err, 'Failed to open vault');
        // DECISION: the outgoing vault was already torn down above
        // (close-before-load is mandatory — see `revertToOutgoingVault`). Revert to
        // it rather than strand the user on a stale, empty half-open vault.
        if (outgoingVaultPath) {
          await revertToOutgoingVault(outgoingVaultPath, this);
        } else {
          // First open: init-config may have left the registry armed at the
          // failed path, locking out every OTHER vault.
          await releaseRegistryBestEffort();
        }
        return openFailed(report, openVaultFailureOf(err));
      }

      commitVaultCandidate(candidate, this);
      runPostCommitTasks(candidate, this);
      return true;
    } finally {
      // Close the swap window so a deferred `save()` proceeds. Clear the slot
      // only while this swap still owns it; resolving OUR window is always
      // correct, but the slot may already belong to a newer swap.
      if (hadOutgoingVault) {
        if (swapInProgress === mySwapWindow) swapInProgress = null;
        resolveSwapWindow();
      }
    }
  },


  /**
   * Closes the active vault and returns the renderer to
   * the home screen. Saves first like `openVault` (asking only if something
   * couldn't be saved), fires
   * the same `pre-swap` lifecycle so every per-vault store resets, then
   * tells main to release the watcher + drop the vault-registry pointer.
   *
   * Returns true on success (or no-op when nothing was open), false when
   * the user chose to stay.
   */
  async closeVault(): Promise<boolean> {
    if (!currentProject) return true;
    const leave = await saveBeforeLeaving(() => this.save(), 'close');
    if (leave === 'cancelled') return false;
    // Same swap-window guard as `openVault`: defer a concurrent quit's drain
    // until the close has settled so it doesn't write against the released
    // registry. Owner-checked clear as in openVault.
    let resolveSwapWindow: () => void = () => {};
    const mySwapWindow = new Promise<void>((res) => { resolveSwapWindow = res; });
    swapInProgress = mySwapWindow;
    try {
      await fireVaultSwap({
        phase: 'pre-swap',
        previousVault: vaultPath || null,
        nextVault: null,
        saveOutgoing: leave === 'saved',
      });
      renameQueue = Promise.resolve();
      try {
        await window.filo.invoke('vault:close');
      } catch (err) {
        reportError('vault.close', err, 'Failed to release vault watcher');
        // Continue anyway — the renderer is already torn down.
      }
      currentProject = null;
      vaultPath = '';
      // Bump the generation on close too, so work captured against the closed
      // vault no-ops if it resumes after the teardown.
      beginVaultGeneration('');
      fileTree = [];
      return true;
    } finally {
      // Close the swap window so a deferred `save()` proceeds (owner-checked,
      // see openVault's finally).
      if (swapInProgress === mySwapWindow) swapInProgress = null;
      resolveSwapWindow();
    }
  },

  /**
   * Creates a vault in `newVaultPath` and opens it. The open itself sets up
   * `.filo/` once the outgoing vault is saved and closed (main refuses to set
   * up a second vault while one is open), then `vaultName` is saved as its name.
   */
  async newVault(newVaultPath: string, vaultName: string = ''): Promise<boolean> {
    const opened = await this.openVault(newVaultPath);
    if (opened && vaultName && currentProject?.name !== vaultName) this.setName(vaultName);
    return opened;
  },

  /**
   * Flushes all pending debounced writes immediately: what components hold,
   * then notes, so any board-JSON write below sees what the user produced.
   *
   * Returns false if any flush failed so the Ctrl+S toast can honestly
   * report "Save failed" instead of flashing the success copy while a
   * `.md` / `.board.json` / `.filo/` write was actually rejected. The
   * individual writes already surface a toast via `trackComponentWrite` /
   * `notifyWriteError`; the boolean here just lets the outer Ctrl+S path
   * drop its own success toast. Board-JSON, config, misc and note
   * failures all fold into it; the note writer drains before the board JSON
   * write that references its edits.
   */
  async save(): Promise<boolean> {
    // Run all flushers unconditionally — no `!currentProject` short-circuit, so
    // a quit during the close transition still drains pending writes (against
    // the vault root the writers were registered with).
    //
    // If a vault swap is mid-flight (registry released, new vault not yet
    // committed), defer the drain until it settles; otherwise writes are
    // rejected by `assertActiveVault` and fail closed with no `.filo/.dirty`
    // breadcrumb. The quit path bounds `save()` with its own deadline, and
    // `save()` is never called from within the swap (no self-deadlock).
    if (swapInProgress) {
      try {
        await swapInProgress;
      } catch {
        /* swap-window errors are handled in openVault; just stop deferring */
      }
    }
    // Components hand over what they hold (an uncommitted title, a debounced
    // filter or camera move); then the async command chain settles, since a
    // command queues its note write only once its body has run on `runChained`.
    await flushAllComponents();
    await historyStore.whenChainSettled();
    const noteResult = await noteStore.flushAll();
    const flushResult = await flushAll(getBoardWriteArgs, getConfigWriteArgs);
    // Misc writes: tags / themes / templates / viewports / sidebar order.
    const miscResult = await flushAllMisc();
    return (
      noteResult.failed.length + noteResult.rawNotSaved.length === 0 &&
      flushResult.boardFailed.length === 0 &&
      flushResult.configFailed.length === 0 &&
      miscResult.failed.length === 0 &&
      // A write that failed on an earlier timer and already settled isn't in
      // any scheduler's maps, so the flushes above don't report it. Consult the
      // persistent failed-path set so the result stays honest.
      !hasFailedWrites()
    );
  },

  /**
   * Registers the tab-store change listener so open-tab mutations
   * get persisted to .filo/workspace.json.
   */
  wireTabChangeListener() {
    tabStore.setChangeListener(() => {
      if (!currentProject) return;
      this.markMetaDirty();
    });
  },

  /**
   * Returns whether `fileTree` now reflects a SUCCESSFUL
   * read. A failed read (envelope failure, IPC throw) leaves the existing
   * tree untouched and returns false so `refreshTreeAndCleanup` can skip
   * its eviction/clear walks instead of treating the stale tree as truth.
   * The trees-equal short-circuit and the no-vault early return both count
   * as success (the tree on hand IS the current disk state).
   */
  async refreshTree(): Promise<boolean> {
    if (!vaultPath) return true;
    // Only toggle `isLoading` on the initial cold-path scan (empty tree).
    // Subsequent refreshes — triggered by watcher events on every vault
    // write — must swap `fileTree` atomically without flipping the UI
    // through the `{#if vaultStore.loading}` branch in VaultSidebar, which
    // unmounts the entire `.root-dnd-zone` and causes a visible flicker.
    const isInitialLoad = fileTree.length === 0;
    if (isInitialLoad) isLoading = true;
    try {
      // A scan failure isn't an empty vault: toast and keep `fileTree`.
      const root = vaultPath;
      const identity = captureVaultIdentity();
      const envelope = await window.filo.invoke('vault:read-tree', root);
      if (envelope.ok === false) {
        // No toast for `too-large` (`vault:tree-too-large` says it better), nor
        // for a read of the vault being left, refused once main released it:
        // the sidebar on screen is fine. Other codes mean it may be stale.
        const code = envelope.code ?? 'unknown';
        const leaving = swapInProgress !== null || !isStillSameVault(identity) || root !== vaultPath;
        if (code !== 'too-large' && !(code === 'NO_ACTIVE_VAULT' && leaving)) {
          reportError(
            'vault.read-tree',
            new Error(envelope.error ?? code),
            `Could not read vault tree (${code}). The sidebar may be out of date.`,
          );
        }
        return false;
      }
      const tree = envelope.tree;
      // The watcher fires `vault:tree-updated` after any vault write that
      // touches a directory entry, including suppressed self-writes that
      // didn't actually change the tree shape. Skipping the reassignment
      // when nothing changed keeps `treeView` (and every VaultFileItem
      // sub-tree it feeds) referentially stable.
      if (treesEqual(fileTree, tree)) return true;
      noteFolderMoves(fileTree, tree, vaultPath);
      fileTree = tree;
      const knownPaths = new SvelteSet<VaultPath>();
      const walk = (nodes: FileTreeNode[]) => {
        for (const n of nodes) {
          const rel = toVaultRelative(n.path, vaultPath);
          if (!n.isDirectory && rel) knownPaths.add(brandVaultPath(rel));
          if (n.children) walk(n.children);
        }
      };
      walk(tree);
      boardStore.recomputeBrokenRefs(knownPaths);
      // Prune selection entries whose paths no longer exist (renamed or
      // deleted) so a stale path doesn't keep the row visually selected.
      // `allAbsPaths` holds *absolute* tree-node paths (not vault-
      // relative); the dedicated set lets the prune walk match by
      // identity without round-tripping through `VaultPath`.
      if (selectedPaths.size > 0) {
        // allow-string-path-key: keys are absolute file-tree paths, not vault-relative
        const allAbsPaths = new SvelteSet<string>();
        const walkAll = (nodes: FileTreeNode[]) => {
          for (const n of nodes) {
            allAbsPaths.add(n.path);
            if (n.children) walkAll(n.children);
          }
        };
        walkAll(tree);
        const pruned = new SvelteSet<string>();
        for (const p of selectedPaths) if (allAbsPaths.has(p)) pruned.add(p);
        if (pruned.size !== selectedPaths.size) selectedPaths = pruned;
      }
      return true;
    } catch (err) {
      reportError('vault', err, 'Failed to refresh vault tree');
      return false;
    } finally {
      if (isInitialLoad) isLoading = false;
    }
  },

  /**
   * Externalised so it can be enqueued onto `renameQueue`
   * alongside `handleExternalRename`, and so unit tests can drive it
   * directly. The watcher `vault:tree-updated` listener funnels every
   * event through this method via the shared queue, which serialises
   * concurrent tree reconciles with in-flight external renames (else a
   * `git mv` could evict the renamed board before its rebind applied).
   */
  async refreshTreeAndCleanup(): Promise<void> {
    const refreshed = await this.refreshTree();
    // Every walk below treats `fileTree` as the truth about disk. After a
    // FAILED read the tree is stale: a board created since the last good read
    // would be evicted (pending writes cancelled, tabs closed — recent edits
    // lost). Skip; the next successful refresh re-runs the cleanup.
    if (!refreshed) return;
    // A folder another program renamed (seen by any tree read since the last
    // reconcile) is followed first, so nothing below finds it missing.
    for (const move of vaultPath ? takeFolderMoves() : []) {
      await this.handleExternalRename(move.oldFolder, move.newFolder);
    }
    // A pinned folder deleted by another program: clear the pin.
    if (vaultPath) {
      clearPinsOfMissingFolders(fileTree, vaultPath, currentProject?.settings.general, (rel) => this.clearActiveRootFolderIfMatches(rel));
    }
    const root = vaultPath ? normalizePath(vaultPath) : '';
    // External deletion of a `.board.json` file (OS file explorer, git,
    // sync clients) — the in-memory cache survives the disk deletion unless
    // reconciled here, so a deleted board would reappear with its cached
    // state. Lowercase BOTH sides: on case-insensitive filesystems the tree
    // and `board:create` can report different casing, which would otherwise
    // evict freshly-created boards.
    if (root) {
      const flat = flattenTreePaths(fileTree, root);
      const flatLower = new SvelteSet<string>();
      for (const p of flat) flatLower.add(p.toLowerCase());
      // Eviction is destructive (cancels pending writes, closes tabs), so
      // confirm each candidate with a direct stat: the tree read can race a
      // concurrent `board:create` and make a LIVE board look missing. A probe
      // failure can't PROVE the file is gone — keep the board.
      const captured = captureVaultIdentity();
      for (const [boardId, relPath] of Object.entries(boardStore.paths)) {
        if (!relPath) continue;
        if (!flatLower.has(relPath.toLowerCase())) {
          let confirmedMissing = false;
          try {
            const exists = await window.filo.invoke('vault:file-exists', root, relPath);
            confirmedMissing = exists === false;
          } catch {
            confirmedMissing = false;
          }
          // A vault swap landing during the probe means `boardStore.paths`
          // now belongs to the NEW vault — stop instead of evicting its
          // same-id boards on the OLD vault's evidence.
          if (!isStillSameVault(captured)) return;
          // An in-app rename rebinds `boardStore.paths[boardId]` to the new
          // (not-yet-on-disk) path before the rename IPC lands, so the probe
          // would confirm "missing" for a LIVE board. Defer eviction while a
          // rename is in flight or the path was rebound since sampling.
          if (confirmedMissing && !isRenameInFlight() && boardStore.paths[boardId] === relPath) {
            // Hold + re-check (an external folder rename emits no child events).
            markBoardProvisionallyMissing(boardId, relPath, captured, (task) => this.enqueueRenameQueueWork(task));
          }
        }
      }
      void adoptUntrackedTreeBoards(flat, captured); // a .board.json that appeared mid-session
    }
  },

  /**
   * Enqueues work on the rename queue. The watcher listeners route both
   * `vault:tree-updated` and `vault:file-renamed` through it so they run in
   * arrival order; tests use it to interleave the two deterministically.
   *
   * With `errorContext`, a rejection is reported via `reportError` so
   * listener-driven tasks (which can't await) still surface failures. The
   * returned promise rejects either way. A rejection doesn't break the chain —
   * each task re-reads authoritative state at start.
   */
  enqueueRenameQueueWork<T>(
    task: () => Promise<T>,
    errorContext?: { label: string; message: string },
  ): Promise<T | undefined> {
    // Capture the vault identity at ENQUEUE time. Resetting `renameQueue` on
    // swap drops the chain head but doesn't cancel work already chained on the
    // prior tail, so an outgoing-vault task could resume against the new
    // vault's cache. Skip it if the vault swapped (resolving `undefined` keeps
    // the chain alive without a spurious error toast).
    const captured = captureVaultIdentity();
    const guardedTask = (): Promise<T | undefined> => {
      if (!isStillSameVault(captured)) return Promise.resolve(undefined);
      return task();
    };
    const next = renameQueue.then(guardedTask, guardedTask);
    renameQueue = next.catch(() => undefined);
    if (errorContext) {
      next.catch((err) => {
        reportError(errorContext.label, err, errorContext.message);
      });
    }
    return next;
  },

  listenForChanges(): () => void {
    // Coalesce `vault:tree-updated` bursts (sync storm / multi-file `git mv`)
    // into ONE reconcile via a short trailing debounce. `vault:file-renamed`
    // still enqueues immediately, so the debounced reconcile lands AFTER any
    // rename rebind by construction.
    const reconcileTreeDebounced = createTrailingDebounce(() => {
      // Shared rename queue = arrival order vs `vault:file-renamed`; errors go
      // through reportError (the listener can't await).
      void this.enqueueRenameQueueWork(
        () => this.refreshTreeAndCleanup(),
        {
          label: 'vault.treeUpdated',
          message: 'Failed to reconcile vault tree after external change',
        },
      ).catch(() => undefined);
    }, TREE_UPDATED_DEBOUNCE_MS);
    const unsubTree = window.filo.on('vault:tree-updated', () => reconcileTreeDebounced.trigger());

    const unsubFiles = window.filo.on('vault:files-changed', (...args: unknown[]) => {
      const changes = args[0] as Array<{ type: string; filename: string; eventType: string }>;
      if (!Array.isArray(changes)) return;

      // Exhaustive dispatch through the external-change registry, which
      // routes each `FileChangeType` arm (`document`, `attachment`, `board`,
      // `config-tags`, `config-theme`, `config-template`, `config`, `tree`)
      // to its dedicated reconciler.
      //
      // Funnelled through the shared rename queue so a concurrent
      // `vault:file-renamed` can't interleave between a batch's classifier
      // baseline pass and its reload writes.
      //
      // Self-write filtering happens inside each per-kind reconciler; the
      // cast to the registry's strict event shape makes wire-format drift a
      // type error rather than a silent miss.
      const events: ExternalChangeEvent[] = changes.map((c) => ({
        kind: c.type as ExternalChangeEvent['kind'],
        filename: c.filename,
        eventType: c.eventType,
      }));
      void this.enqueueRenameQueueWork(
        () => dispatchExternalChangeBatch(events),
        {
          label: 'vault.externalChange',
          message: 'Failed to reconcile external file changes',
        },
      ).catch(() => undefined);
    });

    // External cross-folder moves (OS file explorer, sync clients, git
    // operations) are correlated by the main-process watcher into a single
    // synthetic rename event. Route it through the same propagation pipeline
    // the in-app sidebar rename uses, so text-tile `filePath` gets stamped
    // on the moved file's tile defs (no silent broken refs).
    const unsubRenamed = window.filo.on('vault:file-renamed', (...args: unknown[]) => {
      const payload = args[0] as { oldPath?: string; newPath?: string } | undefined;
      if (!payload || typeof payload.oldPath !== 'string' || typeof payload.newPath !== 'string') return;
      const oldRel = payload.oldPath;
      const newRel = payload.newPath;
      if (!oldRel || !newRel || oldRel === newRel) return;

      // Chain through the shared queue so concurrent renames execute in
      // arrival order, AND so a tree-updated event arriving in the same
      // tick can't run its `cleanupMissingBoard` walk before the rename
      // handler rebinds `boardPaths`. Errors are
      // surfaced but don't break the chain (next event still fires) —
      // a single bad rename shouldn't poison every subsequent one.
      void this.enqueueRenameQueueWork(
        () => this.handleExternalRename(oldRel, newRel),
        {
          label: 'vault.handleRename',
          message: `Failed to propagate external rename "${oldRel}" → "${newRel}"`,
        },
      ).catch(() => undefined);
    });

    // fs.watch failed on this platform / filesystem (e.g., unsupported network
    // share, permissions, watcher limit hit). External-edit reconciliation is
    // silently dead without this — surface it so the user understands why
    // their changes from another editor aren't appearing.
    const unsubWatcherFailed = window.filo.on('vault:watcher-failed', (...args: unknown[]) => {
      const payload = args[0] as { reason?: string } | undefined;
      const reason = payload?.reason ? `: ${payload.reason}` : '';
      uiStore.toast(
        `External-edit watcher failed to start${reason}. Edits made in other apps won't auto-refresh until you reopen the vault.`,
        'error',
        8000,
      );
    });

    // Supervisor state events. Show a transient banner
    // when the watcher transitions to `reconnecting` and clear it once
    // it's back to `active`. `suspended` is the post-stop terminal state
    // (vault close); no toast there — the user just closed the vault.
    //
    // Throttled by attempt count: only the FIRST reconnecting transition
    // (attempt 0) surfaces a toast, so a flaky network share doesn't
    // pile a fresh toast on every backoff tick. A subsequent recovery
    // toast fires when state flips back to `active` with `attempt > 0`
    // implied (we only get `active` here when the watcher recovered, not
    // on initial start).
    const unsubWatcherState = window.filo.on('vault:watcher-state', (...args: unknown[]) => {
      const payload = args[0] as {
        state?: 'active' | 'reconnecting' | 'suspended';
        reason?: string;
        attempt?: number;
      } | undefined;
      if (!payload) return;
      if (payload.state === 'reconnecting' && (payload.attempt ?? 0) === 0) {
        const reason = payload.reason ? `: ${payload.reason}` : '';
        uiStore.toast(
          `External-edit watcher disconnected${reason} — retrying. Edits may show up with a delay until it reconnects.`,
          'warning',
          6000,
        );
      } else if (payload.state === 'active') {
        uiStore.toast(
          'External-edit watcher reconnected.',
          'info',
          3000,
        );
      }
    });

    // The main process refuses to enumerate vaults with
    // more than `VAULT_TREE_MAX_NODES` entries to avoid OOM-ing the main
    // process when the user accidentally points Filo at `~` or `C:\`.
    // Without this toast the sidebar would silently show an empty tree
    // and the user would have no idea the read was capped.
    const unsubTreeTooLarge = window.filo.on('vault:tree-too-large', (...args: unknown[]) => {
      const payload = args[0] as { limit?: number } | undefined;
      const limit = payload?.limit ?? 100_000;
      uiStore.toast(
        `Vault is too large to scan (over ${limit.toLocaleString()} entries). Open a more specific folder.`,
        'error',
        10_000,
      );
    });

    // Backgrounded windows accumulate missed events on every OS (macOS
    // coalesces, Windows drops on watcher pressure, Linux hits inotify
    // limits). Reconcile when the user tabs back so drift surfaces
    // immediately rather than on the 30s periodic tick.
    //
    // Throttled to once per 5 s so rapid alt-tabbing doesn't pin IPC on the
    // reconcile walker and starve live edits.
    const onFocus = (): void => {
      const now = Date.now();
      if (now - lastReconcileTriggerAt < RECONCILE_FOCUS_THROTTLE_MS) return;
      lastReconcileTriggerAt = now;
      // allow-envelope-bare: periodic reconcile is best-effort — the
      // watcher's own pipeline reports failures through other channels.
      void window.filo.invoke('vault:reconcile');
    };
    window.addEventListener('focus', onFocus);

    return () => {
      reconcileTreeDebounced.cancel();
      unsubTree();
      unsubFiles();
      unsubRenamed();
      unsubWatcherFailed();
      unsubWatcherState();
      unsubTreeTooLarge();
      window.removeEventListener('focus', onFocus);
    };
  },
};

// Focus-triggered reconcile throttle. Module scope so the `onVaultSwap` reset
// below registers at module load (`listenForChanges` only runs once
// `App.svelte` mounts, too late for the lifecycle-coverage gate's
// import-time registration check).
const RECONCILE_FOCUS_THROTTLE_MS = 5000;
let lastReconcileTriggerAt = 0;

// Trailing-debounce window for coalescing `vault:tree-updated` bursts into
// one reconcile. In-app rename/delete/create call `refreshTree()` directly, so
// this only throttles the external-watcher path.
const TREE_UPDATED_DEBOUNCE_MS = 250;

// Reset the focus-throttle clock on every vault swap, else the previous
// vault's timestamp throttles out the first focus event after a swap.
// Registered at module load so the lifecycle-coverage gate sees it on import.
onVaultSwap('pre-swap', 'reconcile-focus-throttle', () => {
  lastReconcileTriggerAt = 0;
});

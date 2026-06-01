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
import { workspaceStore } from './workspace.svelte';
import { themeStore } from './theme.svelte';
import { normalizePath, toPosix } from '../lib/utils/path';
// Aliased import — the vault store has its own local `let vaultPath = $state<string>('')`
// which shadows the constructor name otherwise.
import { vaultPath as brandVaultPath, type VaultPath } from '../../shared/vaultPath';
import { checkRecovery, markClean } from '../lib/vault/dirtyFlagRecovery';
import {
  readPendingRewrite,
  clearPendingRewrite,
  hasPartialTagRewriteState,
  hasPartialTagRemovalState,
} from '../lib/vault/tagRewriteSentinel';
import { readPendingRenameCascades } from '../lib/vault/renameCascadeSentinel';
import { repairRenameCascade } from '../lib/vault/renameCascadeRepair';
import { assertBaselinesSeeded } from '../lib/vault/fileBaselineRegistry';
import {
  sortTree,
  filterTree,
  treesEqual,
  directoryExistsInTree,
  flattenTreePaths,
  type SortConfig,
} from '../lib/vault/vaultTreeSort';
import {
  loadVaultCandidate,
  type VaultCandidate,
} from '../lib/vault/vaultCandidate';
import {
  scheduleConfigWrite,
  scheduleMiscWrite,
  flushAll,
  flushAllMisc,
  seedConfigSnapshots,
  seedViewportsCache,
  markCorruptConfigTarget,
  type V7BoardFileData,
} from '../lib/boards/boardSaver';
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
import { flushAllMarkdownWriters } from '../lib/vault/markdownFileWriter';
import { flushAllPendingFrontmatterWrites } from '../lib/boards/frontmatterWriteScheduler';
import { reportError } from '../lib/utils/errorBus';
import { invokeOk } from '../lib/utils/invokeOk';
import { fileTagsStore } from './fileTags.svelte';
import { emptyTagsFile } from '../lib/vault/tagsStorage';
import { fireVaultSwap, onVaultSwap } from '../core/vaultLifecycle';
import type { VaultContext } from './vaultStoreTypes';
import { makeTreeSlice } from './vaultTree';
import { makeProjectSlice } from './vaultProject';
import { makeRecoverySlice } from './vaultRecovery';
import { makeRootFolderSlice } from './vaultRootFolder';
import { makeFolderOpsSlice } from './vaultFolderOps';
import { makeExternalChangesSlice } from './vaultExternalChanges';

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

// Phase 31 B1.3 — sidebar-order write is now routed through
// `scheduleMiscWrite` so it participates in the inflight / sentinel /
// failedVaultPaths pipeline. The previous ad-hoc setTimeout swallowed
// config:save failures (no envelope check, no toast) which left a manual
// drag silently un-persisted on EACCES/ENOSPC.
const SIDEBAR_ORDER_KEY = 'config:.filo/sidebar-order.json';
const SIDEBAR_ORDER_PATH = '.filo/sidebar-order.json';

// Phase 31 B2.2 — external-rename serialisation queue. Each `vault:file-renamed`
// IPC event appends to this promise chain so concurrent OS-level renames
// (a `git mv` burst, sync-client batch) propagate through propagateRename /
// renameBoardPath / flushAllDirty in arrival order. The fire-and-forget IIFE
// the queue replaces could race two renames targeting the same `.board.json`
// — B's propagation landing after A's flush would serialise A's name with
// B's body to disk.
let renameQueue: Promise<unknown> = Promise.resolve();

// ── Project / vault metadata state ──
let currentProject = $state<Project | null>(null);

// ── Recovery UX — files that were in flight at last abnormal shutdown ──
let recoveryPendingPaths = $state<string[]>([]);

/**
 * Phase 3 / 3.3 — pending resolver for the recovery-files modal. Set when the
 * recovery sequencer opens the modal; resolved by `acknowledgeRecovery()` (the
 * only "user confirmed" exit) so the sequencer can advance to the next pending
 * sentinel without stacking modals on top of each other. Cleared when consumed.
 *
 * D.9 — paired with the vault path captured at resolver-creation time so the
 * sequencer can verify it's still operating on the same vault before
 * running any side effects after the modal closes. A vault swap during the
 * modal's lifetime previously left the sequencer running against the
 * outgoing vault's `newVaultPath` capture, scheduling further sentinel
 * checks / toasts that no longer applied to anything the user could see.
 */
let recoveryDismissedResolver: { resolve: () => void; vaultPath: string } | null = null;

/**
 * Promisifies the recovery-files modal close. Routes through the existing
 * `acknowledgeRecovery` dismiss path; the returned promise resolves when the
 * user clicks Dismiss (which clears the `.filo/.dirty` sentinel). Esc / X /
 * backdrop closes do NOT resolve this — those leave the sentinel intact for
 * the next launch by design.
 *
 * D.4 — a second `openVault()` while a previous recovery modal was still
 * parked would orphan the prior resolver (its sequencer chain hangs
 * forever). Resolve the stale resolver before overwriting; downstream
 * guarded steps no-op since the vault path has already swapped.
 *
 * D.9 — capture `vaultPath` at resolver creation so the sequencer (which
 * may run further side effects after the await) can detect a vault swap
 * during the modal's lifetime.
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
 * Phase 3 / 3.3 — promisifies `uiStore.openConfirm`. Resolves true on the
 * Confirm button, false on Cancel. The original `onConfirm`/`onCancel`
 * callbacks still fire, so existing per-action side effects stay intact.
 */
function awaitConfirm(config: {
  title: string;
  body: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm?: () => void;
  onCancel?: () => void;
}): Promise<boolean> {
  return new Promise((resolve) => {
    uiStore.openConfirm({
      title: config.title,
      body: config.body,
      confirmLabel: config.confirmLabel,
      cancelLabel: config.cancelLabel,
      danger: config.danger,
      onConfirm: () => {
        config.onConfirm?.();
        resolve(true);
      },
      onCancel: () => {
        config.onCancel?.();
        resolve(false);
      },
    });
  });
}

function getBoardWriteArgs(
  boardId: string,
): { vaultRoot: string; boardPath: string; cached: V7BoardFileData } | null {
  if (!vaultPath) return null;
  const boardPath = boardStore.paths[boardId];
  const cached = boardStore.cache[boardId];
  if (!boardPath || !cached) return null;
  return { vaultRoot: vaultPath, boardPath, cached };
}

function getConfigWriteArgs(): {
  vaultRoot: string;
  settings: ProjectSettings;
  theme: string;
  workspace: WorkspaceState;
  layout: ReturnType<typeof workspaceStore.serialize>;
} | null {
  if (!vaultPath || !currentProject) return null;
  const settings = JSON.parse(JSON.stringify(currentProject.settings)) as ProjectSettings;
  const workspace: WorkspaceState = tabStore.serialize();
  return {
    vaultRoot: vaultPath,
    settings,
    theme: currentProject.theme ?? 'light',
    workspace,
    layout: workspaceStore.serialize(),
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
  // Route through `scheduleMiscWrite` so the write inherits sentinel
  // tracking, IPC envelope assertion, and the `flushAllMisc` drain on
  // Ctrl+S / quit. The args getter re-reads `manualOrder` + `vaultPath`
  // at fire time so the snapshot reflects the latest drag, not the
  // schedule-time state. Corruption gating lives inside scheduleMiscWrite
  // via `isConfigPathCorrupt`.
  scheduleMiscWrite(SIDEBAR_ORDER_KEY, () => {
    if (!vaultPath) return null;
    const vaultRoot = vaultPath;
    const snapshot = JSON.parse(JSON.stringify(manualOrder)) as Record<string, string[]>;
    return {
      vaultRoot,
      path: SIDEBAR_ORDER_PATH,
      write: async () => {
        await invokeOk('config:save', vaultRoot, 'sidebar-order.json', snapshot);
      },
    };
  });
}

// Memoised sort/filter result. Without this, the `get tree()` getter
// allocated a fresh node graph on every reactive read, churning the
// {#each} block in VaultSidebar and re-running every VaultFileItem's
// $derived on every unrelated state change — the visible flicker.
const treeView = $derived(sortTree(filterTree(fileTree, searchQuery), readSortConfig()));

function markMetaDirty(): void {
  scheduleConfigWrite(() => getConfigWriteArgs());
}

const vaultCtx: VaultContext = {
  getVaultPath: () => vaultPath,
  setVaultPath: (next) => { vaultPath = next; },
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
    // D.9 — fire the resolver regardless so the awaiter doesn't hang
    // forever, but the resolver only stamps a "resolved against
    // matching vault" or "vault changed during the modal's life"
    // signal — the sequencer's post-await steps then short-circuit if
    // the vault changed.
    ctx.resolve();
  },
  markMetaDirty,
  refreshTree: () => vaultStore.refreshTree(),
  clearSelection: () => vaultStore.clearSelection(),
  clearActiveRootFolderIfMatches: (deletedPath) =>
    vaultStore.clearActiveRootFolderIfMatches(deletedPath),
};

const treeSlice = makeTreeSlice(vaultCtx);
const projectSlice = makeProjectSlice(vaultCtx);
const recoverySlice = makeRecoverySlice(vaultCtx);
const rootFolderSlice = makeRootFolderSlice(vaultCtx);
const folderOpsSlice = makeFolderOpsSlice(vaultCtx);
const externalChangesSlice = makeExternalChangesSlice(vaultCtx);

/**
 * Phase R4 — synchronous commit of a `VaultCandidate`. Every mutation
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
  // in-memory defaults.
  for (const target of candidate.corruptionTargets) {
    markCorruptConfigTarget(target);
  }
  // Drain warning toasts the candidate buffered. We surface them
  // post-commit so a candidate that ultimately FAILS doesn't leave the
  // user staring at warning toasts for a vault they never opened.
  for (const w of candidate.warnings) {
    uiStore.pushToast({ text: w.text, type: w.type, duration: w.duration });
  }

  // ── The actual atomic-looking swap ──
  currentProject = candidate.project;
  vaultPath = candidate.path;
  manualOrder = candidate.manualOrder;
  fileTree = candidate.tree;

  // ── Hydrate dependent stores (each method accepts data directly) ──
  boardStore.hydrateCache(candidate.boardCache, candidate.boardPaths);
  // Mark every board the loader repaired on the way in dirty (markDirty is
  // idempotent; overlap harmless): M26 displayIndex backfill, Phase 2.4
  // orphan/dup prune (bytes snapshotted to `.filo/recovery/`), Audit 2.1 boardId.
  const repairedBoardIds = [
    ...candidate.backfilledBoardIds,
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
  );
  workspaceStore.setChangeListener(() => markMetaDirty());
  // Hydrate tabs LAST: at this point currentProject, boardCache, and
  // workspaceStore are all populated, so the BoardRouter effect that
  // fires for the restored active tab sees a fully-formed project on
  // its first run.
  tabStore.hydrateFromWorkspace(candidate.project.workspace, candidate.project.boards);

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

  // Phase 4 / E4 — dev-only tripwire: every `.board.json` that loaded should
  // have had its drift baseline seeded by `boardLoader`. Warn (never throw)
  // if any is missing so an F1-style regression in eager baseline seeding
  // surfaces during development. No-op in production builds.
  assertBaselinesSeeded(Object.values(candidate.boardPaths), 'board');
}

/**
 * Phase R4 — fires the long-running work that doesn't need to block
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
    // Audit2 5.3 — reconcile every board's cached tile metadata against
    // the canonical frontmatter we just rebuilt the index from. The
    // live event path (vaultExternalChanges) already runs this for each
    // mid-session edit, but the on-load drift between `.board.json`
    // (cached completed / priority / date) and the backing `.md`
    // frontmatter was only ever reconciled when something touched the
    // file afterwards. Renders read frontmatter directly so the bug
    // never surfaces visually (the cache is invisible), but the on-disk
    // cache stays stale until a board write rewrites it — which means
    // any consumer that DOES read the cache (a downstream agent / a
    // future migration / a third-party tool) sees out-of-date values.
    // Walking the index once at open closes the drift in O(P × M × T)
    // where each inner check short-circuits on `tileBacksMarkdownPath`,
    // so the practical cost is tile count × backed-tile lookups.
    for (const md of vaultIndexStore.allMetadata()) {
      boardCacheStore.applyFrontmatterToBackedTiles(md.path, md);
    }
    if (!fileTagsStore.isEmpty()) {
      // Phase 23 M13 — prune `.filo/tags.json:fileTags` entries whose
      // path is no longer present in the live tree.
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
    // tags.json was empty — seed it from .md frontmatter discovered
    // during the index rebuild.
    const seed = emptyTagsFile();
    let mutated = false;
    for (const md of vaultIndexStore.allMetadata()) {
      if (md.tags.length === 0) continue;
      const unique = Array.from(new SvelteSet(
        md.tags.map((t) => t.replace(/^#/, '').trim()).filter(Boolean),
      ));
      if (unique.length === 0) continue;
      seed.fileTags[md.path] = unique;
      for (const t of unique) {
        if (!seed.tags[t]) seed.tags[t] = { color: '#3a86ff', createdAt: Date.now() };
      }
      mutated = true;
    }
    if (mutated) fileTagsStore.setAll(seed);
  });

  // ── 3. Recovery sentinel sequencer ───────────────────────────────
  void runRecoverySequencer(newVaultPath);
}

/**
 * Phase 3 / 3.3 — sequence the three recovery sentinel surfaces so
 * they appear one after the other rather than as a stack. Each step
 * awaits the previous one's user action (Dismiss / Resume / Discard
 * / Retry) before opening the next. Failures inside any single step
 * are surfaced via reportError but do NOT abort the chain.
 *
 * D.9 — vault-identity guard. After each `await` inside this
 * sequencer, the vault may have swapped (user picked a different
 * vault from the home screen, or the popout window signalled a
 * swap). Re-check against the captured `newVaultPath` and
 * short-circuit so subsequent toasts / confirms don't surface
 * against the wrong vault.
 */
async function runRecoverySequencer(newVaultPath: string): Promise<void> {
  const isStillSameVault = (): boolean => vaultPath === newVaultPath;

  // ── 1. `.filo/.dirty` — unflushed-files modal ───────────────────
  try {
    const status = await checkRecovery(newVaultPath);
    if (!isStillSameVault()) return;
    if (status.needsRecovery && status.reason !== 'sentinel-unreadable') {
      const pending = status.pendingPaths ?? [];
      if (pending.length > 0) {
        // Recovery modal owns the markClean call — its Dismiss
        // button is the only "user acknowledged" signal.
        recoveryPendingPaths = pending;
        const dismissed = awaitRecoveryDismiss();
        uiStore.openModal('recovery-files');
        await dismissed;
        if (!isStillSameVault()) return;
      } else {
        uiStore.pushToast({
          text: "Filo detected an incomplete write but couldn't identify the unflushed file. Check `.filo/.dirty` manually if recent edits are missing.",
          type: 'error',
          duration: 0,
          onDismiss: () => {
            void markClean(newVaultPath);
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
    if (!isStillSameVault()) return;
    if (res.payload) {
      const { oldName, newName, plan, preexistingNewNamePaths, committedPaths } = res.payload;
      const verb = newName === null ? 'removal' : 'rename';
      const target = newName === null ? `"${oldName}"` : `"${oldName}" → "${newName}"`;
      // IMPL_PLAN_2026-05-26 / Item 4 + 6.3 — Detect partial state. A sweep that
      // committed some files before the crash leaves the vault split (rename:
      // some .md carry `newName`, some `oldName`; removal: some stripped, some
      // not), so a bare Discard would leave it split. Renames are classified from
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
        onConfirm: () => {
          void convergeForward();
        },
        onCancel: () => {
          void (async () => {
            // Partial: converge forward before clearing the breadcrumb so the
            // vault doesn't stay split; a clean state just clears it.
            if (partialDetected) {
              await convergeForward();
            }
            await clearPendingRewrite(newVaultPath);
            const flat = flattenTreePaths(fileTree, newVaultPath);
            fileTagsStore.pruneOrphanFileTags(flat);
          })();
        },
      });
    } else if (res.unreadable) {
      uiStore.pushToast({
        text: "Filo found a tag-rewrite breadcrumb but couldn't read it. Check `.filo/tag-rewrite-pending.json` manually if a previous tag rename looks incomplete.",
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
    if (!isStillSameVault()) return;
    if (res.entries && res.entries.length > 0) {
      const entries = res.entries;
      const summary = entries.length === 1
        ? `"${entries[0].oldPath}" → "${entries[0].newPath}"`
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
        onConfirm: () => {
          void repairRenameCascade(entries, newVaultPath, 'Retry');
        },
        onCancel: () => {
          // Phase 4.5 (2026-05-30) — "Discard" repairs too. The renamed file
          // is already on disk; clearing the breadcrumb without repairing
          // would strand any board whose flush failed pointing at the old
          // path with no in-app fix. Run the SAME repair as Retry, then
          // confirm what changed so the user knows Discard wasn't a no-op.
          void (async () => {
            const repaired = await repairRenameCascade(entries, newVaultPath, 'Discard');
            if (repaired === null) return; // a flush failed; repair surfaced its own toast
            uiStore.pushToast({
              text:
                repaired > 0
                  ? `Repaired ${repaired} board reference${repaired === 1 ? '' : 's'} from the unfinished rename.`
                  : 'Unfinished rename resolved — no board references needed repair.',
              type: 'info',
              duration: 4000,
            });
          })();
        },
      });
    } else if (res.unreadable) {
      uiStore.pushToast({
        text: "Filo found a rename-cascade breadcrumb but couldn't read it. Check `.filo/rename-cascade-pending.json` manually if a previous rename looks incomplete.",
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
}

/**
 * Test seam (Phase 4.4 / 4.5) — drives the recovery sentinel sequencer
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
  setPath(path: string) { vaultPath = path; },
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

  // ── Folder ops slice (create/rename/delete/move) ──
  ...folderOpsSlice,

  // ── External change handler slice ──
  ...externalChangesSlice,

  // ── Vault lifecycle ──

  /**
   * Opens an existing vault folder. Loads .filo/ config files,
   * scans + loads every .board.json, builds the virtual Project.
   *
   * Phase R4 — vault open is now a transaction. `loadVaultCandidate`
   * performs every fallible I/O against a local snapshot; on success
   * `commitVaultCandidate` swaps globals synchronously; failures
   * inside the candidate phase throw, leaving the caller (and the
   * user) on the home screen with `currentProject` / `vaultPath`
   * untouched. The previous "commit then await async I/O" shape
   * could leave the renderer half-open — vault path recorded, but no
   * watcher / no tags / no theme — when an async step threw past the
   * commit point (e.g. a hand-edited custom theme with an unknown
   * `base`).
   */
  async openVault(newVaultPath: string): Promise<boolean> {
    // Save any existing work.
    //
    // Phase 31 A2.1 — three-way Save / Don't Save / Cancel dialog. The
    // previous two-button "Save?" flow had no way to abort the vault swap
    // and the Don't-Save path silently cleared the recovery sentinel, so a
    // user that hit "No" lost both the in-memory edits AND the breadcrumb
    // pointing at the unflushed files.
    //
    // Branches:
    //  - Save (button 0): flush; if the flush returns false (any write
    //    rejected) abort the swap with a toast so the user can act on the
    //    per-file errors first.
    //  - Don't Save (button 1): skip the flush AND skip the sentinel
    //    cleanup, so the old vault's `.filo/.dirty` survives. Reopening
    //    the old vault will surface the Recovery modal.
    //  - Cancel (button 2): return early. No flush, no sentinel touch,
    //    no in-memory state cleanup. Pending timers continue to run
    //    against the still-active old vault.
    if (currentProject) {
      let choice: -1 | 0 | 1 | 2 = 2;
      try {
        const raw = await window.filo.invoke(
          'dialog:choice',
          'You have unsaved changes. Save before opening a new vault?',
          ['Save', "Don't Save", 'Cancel'],
          { title: 'Open Vault', defaultId: 0, cancelId: 2 },
        );
        choice = (raw === 0 || raw === 1 || raw === 2 ? raw : 2) as 0 | 1 | 2;
      } catch {
        // Dialog itself failed — treat as Cancel to avoid silent data loss.
        choice = 2;
      }
      if (choice === 2) {
        return false;
      }
      if (choice === 0) {
        const ok = await this.save();
        if (!ok) {
          uiStore.toast(
            'Save failed — open-vault cancelled. Check the error toasts above, then try again.',
            'error',
            7000,
          );
          return false;
        }
      }
      // Phase 4 (Consolidation 2026-05-25) — fire the pre-swap lifecycle.
      // Every store / scheduler / sentinel that holds vault-scoped state
      // subscribes via `onVaultSwap('pre-swap', ...)` at module load; the
      // event drains them in dependency order:
      //   - boardWriteScheduler cancels every queued debounced timer so a
      //     closure armed against the outgoing vault can't fire after the
      //     new vault opens.
      //   - writeStateTracking honours `saveOutgoing`: the Save branch
      //     (choice === 0) clears the `.filo/.dirty` sentinel; the Don't
      //     Save branch (choice === 1) preserves it so reopening the
      //     outgoing vault surfaces the Recovery modal.
      //   - history / vaultIndex / orphans / fileTags / theme / pending
      //     settings / saveState / tabs / workspace / etc. drop their
      //     local state so the new vault hydrates against a clean slate.
      await fireVaultSwap({
        phase: 'pre-swap',
        previousVault: vaultPath || null,
        nextVault: newVaultPath,
        saveOutgoing: choice === 0,
      });
      // Phase 3 (IMPL_PLAN 2026-05-25) — drop the rename queue's chain
      // head. vault.svelte.ts owns the swap event so it can't subscribe
      // (would be circular), but the chain still holds promises that
      // target the outgoing vault's `handleExternalRename` /
      // `refreshTreeAndCleanup`. Leaving them attached lets a stale
      // watcher event enqueued just before the swap continue resolving
      // against the now-decommissioned vaultStore state. Resetting to a
      // fresh `Promise.resolve()` ensures the new vault's first
      // watcher event runs immediately on an empty chain.
      renameQueue = Promise.resolve();
    }

    // ── Phase R4 — load the candidate against the new vault ───────
    // Every IPC + parse + recovery snapshot happens here against a
    // local object; nothing in `vaultStore` or any peer store is
    // touched until `commitVaultCandidate` runs synchronously below.
    let candidate: VaultCandidate;
    try {
      candidate = await loadVaultCandidate(newVaultPath);
    } catch (err) {
      reportError('vault', err, 'Failed to open vault');
      return false;
    }

    commitVaultCandidate(candidate, this);
    runPostCommitTasks(candidate, this);
    return true;
  },


  /**
   * Sprint B / B24 — closes the active vault and returns the renderer to
   * the home screen. Mirrors `openVault`'s save-or-discard prompt, fires
   * the same `pre-swap` lifecycle so every per-vault store resets, then
   * tells main to release the watcher + drop the vault-registry pointer.
   *
   * Returns true on success (or no-op when nothing was open), false when
   * the user cancelled the save prompt.
   */
  async closeVault(): Promise<boolean> {
    if (!currentProject) return true;
    let choice: -1 | 0 | 1 | 2 = 2;
    try {
      const raw = await window.filo.invoke(
        'dialog:choice',
        'You have unsaved changes. Save before closing the vault?',
        ['Save', "Don't Save", 'Cancel'],
        { title: 'Close Vault', defaultId: 0, cancelId: 2 },
      );
      choice = (raw === 0 || raw === 1 || raw === 2 ? raw : 2) as 0 | 1 | 2;
    } catch {
      choice = 2;
    }
    if (choice === 2) return false;
    if (choice === 0) {
      const ok = await this.save();
      if (!ok) {
        uiStore.toast(
          'Save failed — close cancelled. Check the error toasts above, then try again.',
          'error',
          7000,
        );
        return false;
      }
    }
    await fireVaultSwap({
      phase: 'pre-swap',
      previousVault: vaultPath || null,
      nextVault: null,
      saveOutgoing: choice === 0,
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
    fileTree = [];
    // The post-commit/teardown work is done above; there is no `post-swap`
    // lifecycle phase (retired in Audit 5.7 — it was never registered or fired
    // on open, and fired into an empty handler set here).
    return true;
  },

  /**
   * Creates a new empty vault. Initialises .filo/ config directory, then opens it.
   *
   * Phase 31 A2.1 — delegates the "save before swap" prompt to `openVault`
   * (called at the end of this method) so the user sees a single dialog
   * instead of being prompted twice when switching between an open vault
   * and a brand-new one.
   */
  async newVault(newVaultPath: string, vaultName: string = ''): Promise<boolean> {
    try {
      await invokeOk('vault:init-config', newVaultPath);

      if (vaultName) {
        await invokeOk('config:save', newVaultPath, 'app.json', JSON.stringify({
          name: vaultName,
        }, null, 2));
      }

      return this.openVault(newVaultPath);
    } catch (err) {
      reportError('vault', err, 'Failed to create vault');
      return false;
    }
  },

  /**
   * Flushes all pending debounced writes immediately. Drains per-file
   * markdown/frontmatter timers (TextTile / DocumentEditor / PropertiesPopup
   * / TaskListBoard) first so any board-JSON write below sees the same
   * on-disk state the user just produced.
   *
   * Returns false if any flush failed so the Ctrl+S toast can honestly
   * report "Save failed" instead of flashing the success copy while a
   * `.md` / `.board.json` / `.filo/` write was actually rejected. The
   * individual writes already surface a toast via `trackComponentWrite` /
   * `notifyWriteError`; the boolean here just lets the outer Ctrl+S path
   * drop its own success toast.
   *
   * Phase 31 A1.1 — folds board-JSON and config-bundle failures into the
   * return value too (previously they were silent on the manual-save path).
   * Phase 31 A1.3 — also drains the app-wide frontmatter scheduler so
   * uncommitted frontmatter edits (Kanban / Task List card field changes
   * not yet through their 300ms debounce) land before the board JSON write
   * that references them.
   */
  async save(): Promise<boolean> {
    // Phase 7 (IMPLEMENTATION_PLAN_2026-05-27) — flush-and-quit path.
    // Previously this short-circuited `if (!currentProject) return false`,
    // which meant a quit fired while the home screen was showing skipped
    // every pending debounced write (markdown bodies, frontmatter, board
    // JSON, .filo/ config). In practice this is rare — closing a vault
    // drains writes first — but a quit triggered during the close
    // transition (or after a partial close failure) could race the
    // currentProject reset with the flush.
    //
    // Run all flushers unconditionally. When there's nothing to flush
    // each scheduler returns `{ failed: [] }` and the boolean is `true`
    // (vacuously safe). When `currentProject` is null but a writer still
    // has pending state, the flush completes against the prior vault root
    // those writers were registered with, so data is preserved.
    const mdResult = await flushAllMarkdownWriters();
    const fmResult = await flushAllPendingFrontmatterWrites();
    const flushResult = await flushAll(getBoardWriteArgs, getConfigWriteArgs);
    // Phase C / C.2 — fold misc-write failures (tags / themes / templates /
    // viewports / sidebar order) into the Ctrl+S aggregate boolean.
    // Previously `flushAllMisc` returned `void` and any failure was silent.
    const miscResult = await flushAllMisc();
    return (
      mdResult.failed.length === 0 &&
      fmResult.failed.length === 0 &&
      flushResult.boardFailed.length === 0 &&
      flushResult.configFailed.length === 0 &&
      miscResult.failed.length === 0
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

  async refreshTree(): Promise<void> {
    if (!vaultPath) return;
    // Only toggle `isLoading` on the initial cold-path scan (empty tree).
    // Subsequent refreshes — triggered by watcher events on every vault
    // write — must swap `fileTree` atomically without flipping the UI
    // through the `{#if vaultStore.loading}` branch in VaultSidebar, which
    // unmounts the entire `.root-dnd-zone` and causes a visible flicker.
    const isInitialLoad = fileTree.length === 0;
    if (isInitialLoad) isLoading = true;
    try {
      // D.2 — `vault:read-tree` now returns `{ ok, tree | code }`. A scan
      // failure (NO_ACTIVE_VAULT after swap, EACCES, too-large) used to
      // arrive as `[]` and was indistinguishable from a genuinely empty
      // vault; now we surface a toast and leave the existing `fileTree`
      // alone. The `vault:tree-too-large` push event still fires from
      // main, but the envelope's `code` lets us toast on other failures
      // too (NO_ACTIVE_VAULT after a fast vault swap is the typical one).
      const envelope = await window.filo.invoke('vault:read-tree', vaultPath);
      if (envelope.ok === false) {
        // Skip toast for `too-large` — the dedicated `vault:tree-too-large`
        // push event already surfaces a context-rich message via the
        // existing main→renderer channel. Other codes (NO_ACTIVE_VAULT,
        // EACCES, IO_ERROR) get a generic toast so the user knows the
        // sidebar isn't trustworthy.
        const code = envelope.code ?? 'unknown';
        if (code !== 'too-large') {
          reportError(
            'vault.read-tree',
            new Error(envelope.error ?? code),
            `Could not read vault tree (${code}). The sidebar may be out of date.`,
          );
        }
        return;
      }
      const tree = envelope.tree;
      // The watcher fires `vault:tree-updated` after any vault write that
      // touches a directory entry, including suppressed self-writes that
      // didn't actually change the tree shape. Skipping the reassignment
      // when nothing changed keeps `treeView` (and every VaultFileItem
      // sub-tree it feeds) referentially stable.
      if (treesEqual(fileTree, tree)) return;
      fileTree = tree;
      const knownPaths = new SvelteSet<VaultPath>();
      const walk = (nodes: FileTreeNode[]) => {
        const root = normalizePath(vaultPath).toLowerCase();
        for (const n of nodes) {
          const rel = toPosix(n.path).toLowerCase();
          if (rel.startsWith(root + '/')) {
            const slice = toPosix(n.path).slice(root.length + 1);
            if (!n.isDirectory && slice) knownPaths.add(brandVaultPath(slice));
          }
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
    } catch (err) {
      reportError('vault', err, 'Failed to refresh vault tree');
    } finally {
      if (isInitialLoad) isLoading = false;
    }
  },

  /**
   * Phase 2 / 2.4 — externalised so it can be enqueued onto `renameQueue`
   * alongside `handleExternalRename`, and so unit tests can drive it
   * directly. The watcher `vault:tree-updated` listener funnels every
   * event through this method via the shared queue, which serialises
   * concurrent tree reconciles with in-flight external renames. Without
   * the queue, a `git mv board.board.json Sub/board.board.json` could
   * fire both events in the same tick; the tree reconcile would run
   * first, observe the rebind not yet applied, and call
   * `cleanupMissingBoard` on the old path — evicting the renamed board.
   */
  async refreshTreeAndCleanup(): Promise<void> {
    await this.refreshTree();
    // External deletion of the active-root folder (OS file explorer, git,
    // sync clients) — clear the stale pointer so the next autosave
    // doesn't resurrect it.
    const rel = currentProject?.settings.general?.activeRootFolder ?? '';
    if (rel && !directoryExistsInTree(fileTree, this.activeRootFolderAbs)) {
      this.clearActiveRootFolderIfMatches(rel);
    }
    // Per-board pins suffer the same external-delete hazard. Walk every
    // cached board's pin and clear any whose folder no longer exists in
    // the live tree.
    const root = vaultPath ? normalizePath(vaultPath) : '';
    for (const data of Object.values(boardStore.cache)) {
      const pin = (data.board as { settings?: { defaultFolder?: string } })
        .settings?.defaultFolder ?? '';
      if (!pin || !root) continue;
      if (!directoryExistsInTree(fileTree, `${root}/${pin}`)) {
        boardStore.clearBoardDefaultFolderIfMatches(pin);
      }
    }
    // External deletion of a `.board.json` file (OS file explorer, git,
    // sync clients) — the in-memory cache survives the disk deletion
    // unless we reconcile here, which is what made closed-but-deleted
    // boards reappear in the tab bar with their last cached state when
    // the user clicked them. Normalise BOTH sides to lowercase: the
    // `flattenTreePaths` Set preserves the on-disk case of every node
    // (the lowercasing inside it is only used for the prefix check),
    // and board paths come from `board:create` with the case Node
    // reported. A case mismatch between the two — common on Windows /
    // macOS case-insensitive filesystems where the watcher's tree
    // refresh can report a different case than the IPC return — would
    // false-positive every board with any uppercase character in its
    // path, wiping freshly-created boards on creation. Lowercase both
    // sides so the lookup is case-insensitive.
    if (root) {
      const flat = flattenTreePaths(fileTree, root);
      const flatLower = new SvelteSet<string>();
      for (const p of flat) flatLower.add(p.toLowerCase());
      for (const [boardId, relPath] of Object.entries(boardStore.paths)) {
        if (!relPath) continue;
        if (!flatLower.has(relPath.toLowerCase())) {
          boardStore.cleanupMissingBoard(boardId);
        }
      }
    }
  },

  /**
   * Phase 2 / 2.4 — exposes the rename queue for test enqueueing. The
   * watcher listeners route both `vault:tree-updated` and
   * `vault:file-renamed` through this queue so they execute in arrival
   * order. Tests use it to interleave the two operations deterministically.
   */
  enqueueRenameQueueWork<T>(task: () => Promise<T>): Promise<T> {
    const next = renameQueue.then(task, task);
    renameQueue = next.catch(() => undefined);
    return next;
  },

  listenForChanges(): () => void {
    const unsubTree = window.filo.on('vault:tree-updated', () => {
      // Funnel through the shared rename queue so concurrent
      // `vault:tree-updated` + `vault:file-renamed` events execute in
      // arrival order. Without this, a `git mv` burst can land the
      // reconcile loop before `handleExternalRename` has rebound the
      // board path — the reconciler then sees the renamed board's
      // path as "missing" and calls `cleanupMissingBoard`, evicting
      // it from the project.
      renameQueue = renameQueue
        .then(() => this.refreshTreeAndCleanup())
        .catch((err) => {
          reportError('vault.treeUpdated', err, 'Failed to reconcile vault tree after external change');
        });
    });

    const unsubFiles = window.filo.on('vault:files-changed', (...args: unknown[]) => {
      const changes = args[0] as Array<{ type: string; filename: string; eventType: string }>;
      if (!Array.isArray(changes)) return;

      // Phase 3 / 3.2 — exhaustive dispatch through the external-change
      // registry. The registry routes each `FileChangeType` arm
      // (`document`, `attachment`, `board`, `config-tags`,
      // `config-theme`, `config-template`, `config`, `tree`) to its
      // dedicated reconciler. Pre-Phase-3 the inline filter chain here
      // silently dropped every kind except `document` and `attachment`,
      // so external edits to `.board.json` / `.filo/tags.json` /
      // theme / template files only surfaced on the next user-triggered
      // write (when the mtime drift gate finally noticed).
      //
      // Sprint B / B8 — funnel through the shared rename queue so a
      // concurrent `vault:file-renamed` event can't interleave between
      // a batch's classifier baseline pass and its reload writes.
      //
      // Phase 19 S3 — self-write filtering happens inside the
      // batched reconcilers themselves now (each per-kind reconciler
      // knows its self-write semantics), but we cast `changes` to the
      // registry's strict event shape here so a future drift in the
      // wire format surfaces as a type error rather than silent miss.
      const events: ExternalChangeEvent[] = changes.map((c) => ({
        kind: c.type as ExternalChangeEvent['kind'],
        filename: c.filename,
        eventType: c.eventType,
      }));
      renameQueue = renameQueue
        .then(() => dispatchExternalChangeBatch(events))
        .catch((err) => {
          reportError(
            'vault.externalChange',
            err,
            'Failed to reconcile external file changes',
          );
        });
    });

    // External cross-folder moves (OS file explorer, sync clients, git
    // operations) are correlated by the main-process watcher into a single
    // synthetic rename event. Route it through the same propagation pipeline
    // the in-app sidebar rename uses, so text-tile `filePath` gets stamped
    // on the moved file's tile defs (no more silent broken refs).
    //
    // Phase 31 B2.2 — concurrent rename events (e.g. a multi-file `git mv`
    // burst, or a sync client that fires several renames per debounce
    // tick) used to interleave their `ensureAllLoaded` / `propagateRename`
    // / `flushAllDirty` calls. Two renames hitting the same `.board.json`
    // could complete out-of-order: B's propagation could land after A's
    // flush had already serialised the cache to disk, so the `.board.json`
    // had A's name but B's content. Serialising through a promise chain
    // keeps the cascade ordered without blocking the IPC event-loop tick.
    const unsubRenamed = window.filo.on('vault:file-renamed', (...args: unknown[]) => {
      const payload = args[0] as { oldPath?: string; newPath?: string } | undefined;
      if (!payload || typeof payload.oldPath !== 'string' || typeof payload.newPath !== 'string') return;
      const oldRel = payload.oldPath;
      const newRel = payload.newPath;
      if (!oldRel || !newRel || oldRel === newRel) return;

      // Chain through the shared queue so concurrent renames execute in
      // arrival order, AND so a tree-updated event arriving in the same
      // tick can't run its `cleanupMissingBoard` walk before the rename
      // handler rebinds `boardPaths` (Phase 2 / 2.4). Errors are
      // surfaced but don't break the chain (next event still fires) —
      // a single bad rename shouldn't poison every subsequent one.
      renameQueue = renameQueue
        .then(() => this.handleExternalRename(oldRel, newRel))
        .catch((err) => {
          reportError('vault.handleRename', err, `Failed to propagate external rename "${oldRel}" → "${newRel}"`);
        });
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

    // Phase 3 / 3.1 — supervisor state events. Show a transient banner
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

    // Phase 1 / 1.5 — the main process refuses to enumerate vaults with
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

    // Phase 19 S2 — backgrounded windows accumulate missed events on every
    // OS (macOS coalesces, Windows drops on watcher pressure, Linux just
    // hits inotify limits). Trigger a reconciliation walk every time the
    // user tabs back so drift surfaces immediately rather than waiting for
    // the 30s periodic tick.
    //
    // Phase 31 C3.5 — throttle to once per 5 s. Rapid focus/blur (e.g. the
    // user alt-tabbing between Filo and a markdown viewer) was pinning IPC
    // on the reconcile walker, starving live edits. 5 s is the minimum
    // gap that still feels "immediate" to a returning user.
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

// Phase 19 S2 — focus-triggered reconcile throttle. Hoisted to
// module scope so the Sprint C / C25 `onVaultSwap` reset can fire at
// module-load (the `listenForChanges` method only runs once
// `App.svelte` mounts, which is too late for the lifecycle-coverage
// gate's import-time registration check).
const RECONCILE_FOCUS_THROTTLE_MS = 5000;
let lastReconcileTriggerAt = 0;

// Sprint C / C25 — reset the focus-throttle clock on every vault
// swap. Without this, the previous vault's "I just reconciled"
// timestamp persists into the new vault, silently throttling out the
// first focus event after a swap. Registered at module load so the
// lifecycle-coverage gate can see it on bare import.
onVaultSwap('pre-swap', 'reconcile-focus-throttle', () => {
  lastReconcileTriggerAt = 0;
});

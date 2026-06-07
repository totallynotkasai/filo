/**
 * File-size ratchet (Phase 7 regression-prevention gate).
 *
 * Enforces CLAUDE.md "one concern per file": no source file may exceed
 * LIMIT lines unless it is on ALLOWLIST. ALLOWLIST entries record the
 * snapshot LOC at the time the allowlist was set — a file may shrink or
 * stay the same, but growth past its snapshot fails the gate. To
 * legitimately raise a snapshot (e.g. after a feature lands and a
 * follow-up refactor will shrink it) the developer must edit ALLOWLIST,
 * which is visible in `git diff` and gets reviewed.
 *
 * Scans `src/main` and `src/renderer` for `.svelte`, `.svelte.ts`, `.ts`.
 * Tests (`src/tests/**`) are out of scope per the same convention.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const SCAN_DIRS = ['src/main', 'src/renderer'];
const EXTENSIONS = ['.svelte', '.svelte.ts', '.ts'];
const LIMIT = 1000;

/**
 * Files currently above LIMIT. Snapshot LOC = the ceiling for that file.
 * To shrink an entry off the allowlist entirely, refactor below LIMIT then
 * delete its row here.
 */
const ALLOWLIST = {
  // TaskList orchestrator: section/row drag (svelte-dnd-action), section
  // popups, bulk multi-select, filters/saved-views wiring, frontmatter
  // writer hookup, BoardBackground mount. Sprint 39 / 39.8 split out
  // filtersAndViews.svelte.ts (−120 LOC); further sharding
  // (sectionDragController, taskLifecycle, sectionPopups) is deferred per
  // the Sprint 39 memory entry. Bump history in git log.
  // AUDIT_REMEDIATION_PLAN_2026-05-30 Phase 7.1 — tightened to current LOC
  // (was 2245) to restore the ratchet's bite after Phase 5/6 trimming.
  // AUDIT2_REMEDIATION_PLAN_2026-05-31 Phase 5.6 — onDestroy calls
  // filters.dispose() so the lastView debounce can't fire after teardown;
  // +1 LOC of comment + call. New snapshot: 2192 LOC.
  // AUDIT4_REMEDIATION_PLAN_2026-06-02 Phase 3 DI-08 — the lastView persist
  // now routes through the pane-scoped, non-undoable `updateSettings` (so a
  // split-view timer can't write one pane's view into the active board or
  // pollute its undo stack) + an inline `$effect` cleanup mirroring Kanban.
  // +9 LOC of comment + cleanup. New snapshot: 2201 LOC.
  // AUDIT13_REMEDIATION_PLAN_2026-06-06 Phase 9 L12 — noUncheckedIndexedAccess
  // section-slice loop guard. +1 LOC. New snapshot: 2202 LOC.
  'src/renderer/components/boards/TaskListBoard.svelte': 2202,
  // Phase 7.1 — tightened to current LOC (was 1506).
  // PHASE6_PLAN_2026-06-01 Phase 6.3.P5 — added the `// allow-direct-write`
  // escape note above the `.filo/kanban-toolbar-pos.json` write so the
  // extended markdown-gateway gate doesn't flag the per-machine UI
  // geometry write. +2 LOC of comment. New snapshot: 1492 LOC.
  // PHASE6_PLAN_2026-06-01 Phase 6.1.R2 (follow-up) — added an `onDestroy`
  // that clears the live-filter `propDebounce` so it can't fire
  // `onFilterPropChange` after the toolbar unmounts on vault swap. +8 LOC.
  // New snapshot: 1500 LOC.
  // AUDIT13_REMEDIATION_PLAN_2026-06-06 Phase 9 L12 — noUncheckedIndexedAccess
  // narrowing guard in the reorder swap (capture endpoints + undefined bail).
  // +4 LOC. New snapshot: 1504 LOC.
  'src/renderer/components/boards/KanbanSideToolbar.svelte': 1504,
  // TaskItem row: title strip + notes panel + style cascade (headerColor /
  // bodyColor split across `.task-item` and `.task-notes-panel-inner`),
  // multi-select chrome, hover-reveal buttons, sticky note panel toggle.
  // Wrapping border + radius engineering is non-obvious — see in-file
  // comments. Bump history in git log.
  // AUDIT_REMEDIATION_PLAN_2026-05-30 Phase 5.7 — added the optional
  // "Delete Task & File…" context-menu entry (`onDeleteWithFile` prop +
  // type + one menu row). +3 LOC. New snapshot: 1542 LOC.
  'src/renderer/components/boards/TaskItem.svelte': 1542,
  // KanbanBoard orchestrator: column dndzone (svelte-dnd-action), per-column
  // card dndzone (replaces native HTML5), multi-card drag (`dragBlockIds`),
  // tag-editor popup + tile-style-popup wiring, BoardBackground mount,
  // empty-state card. Drag controller + filters/sort live in `lib/kanban/`;
  // further trimming needs a structural pass. Bump history in git log.
  // Phase 6.1 (IMPLEMENTATION_PLAN_2026-05-27) — added role/aria/tabindex
  // on the board container plus `findColumnAndIndex` / `neighbourTileId`
  // arrow-nav helpers + Enter→open-as-document handler inside
  // `handleBoardKeydown`. +~80 LOC.
  // AUDIT_REMEDIATION_PLAN_2026-05-29 Phase 3 — M2 added the `isActivePane`
  // guard + `enabled:` gating on the add-tile / add-column shortcut
  // registrations so a split view routes the shared bare `n` to the focused
  // pane; +7 LOC.
  // PHASE6_PLAN_2026-06-01 Phase 6.1.R2 (follow-up) — the lastView-persist
  // `$effect` now returns a cleanup that clears its debounce timer, so a board
  // close / vault swap inside the 300 ms window can't fire
  // `boardStore.updateSettings` against the swapped-in board. +9 LOC. New
  // snapshot: 1419 LOC.
  // AUDIT13_REMEDIATION_PLAN_2026-06-06 Phase 9 L12 — noUncheckedIndexedAccess
  // narrowing guards in the board keydown / arrow-nav helpers (column-swap
  // endpoints, focused-card reads, neighbour lookups). +10 LOC of guards +
  // one-line reasons. New snapshot: 1429 LOC.
  'src/renderer/components/boards/KanbanBoard.svelte': 1429,
  // KanbanColumn: column header (3-dot menu + WIP popover), card dndzone
  // shadow-placeholder rendering, outer `.kanban-column` drag handlers (so
  // OS file drops over the header don't paint the no-entry cursor), per-
  // column accent override, multi-card drag dimming. Bump history in git log.
  // Phase 7.1 — tightened to current LOC (was 1200).
  'src/renderer/components/boards/KanbanColumn.svelte': 1198,
  // VaultFileItem: sidebar tree row — inline rename, drag/drop move-into-folder
  // (svelte-dnd-action), OS file-drop import, tag badges, context menu, and
  // hover-auto-expand-during-drag. Was sitting exactly at the 1000-LOC limit.
  // PHASE6_PLAN_2026-06-01 Phase 6.1.R2 (follow-up) — added an `onDestroy`
  // that clears the hover `autoExpandTimer` so it can't fire
  // `vaultStore.toggleFolder(node.path)` after the row unmounts on vault swap.
  // +9 LOC (import + cleanup + comment) tipped it just over the default limit.
  // New snapshot: 1009 LOC. Splitting the drag/drop handlers into a sibling is
  // the eventual fix.
  'src/renderer/components/sidebar/VaultFileItem.svelte': 1009,
  // Vault store: lifecycle (open / close / swap / save), tree refresh + rename
  // queue (serialises external renames), recovery sentinels (.dirty +
  // tag-rewrite + rename-cascade, sequenced via awaitRecoveryDismiss),
  // three-way save-before-swap dialog, board-load orphan-prune dirty
  // propagation, vault:tree-too-large + vault:reconcile listeners. Lifecycle
  // slice extraction tried in Sprint D, reverted (microtask race); see
  // Phase 30 memory. Bump history in git log.
  // Phase 7 (IMPLEMENTATION_PLAN_2026-05-27) — `save()` no longer short-
  // circuits on missing currentProject (lets quit-during-vault-open flush
  // pending writes); +9 LOC for the explanatory comment.
  // AUDIT_REMEDIATION_PLAN_2026-05-28 Phase 4 — E4 added the dev-only
  // `assertBaselinesSeeded` tripwire at the end of the vault commit (+import
  // +call +comment) and E5 added the rename-cascade recovery's tag-sink
  // re-assert + flush before clearing the sentinel; +~32 LOC.
  // Phase 7.1 — tightened to current LOC (was 1425).
  // AUDIT2_REMEDIATION_PLAN_2026-05-31 Phase 5.3 — `runPostCommitTasks`
  // walks `vaultIndexStore.allMetadata()` after rebuild and calls
  // `boardCacheStore.applyFrontmatterToBackedTiles` for each so cached
  // tile metadata reconciles against canonical frontmatter on every
  // vault open (closes between-session drift). +10 LOC (loop + comment).
  // PHASE6_PLAN_2026-06-01 Phase 6.0.C1 — `openVault` now invokes
  // `vault:close` on the main side between the pre-swap dispatch and
  // `loadVaultCandidate` so the main-side `vault:init-config` guard
  // (`board.ipc.ts:108`, refuses to re-anchor while a different vault is
  // active) doesn't reject every user-driven vault swap. +7 LOC
  // (try/catch + one-line comment). New snapshot: 1406 LOC.
  // PHASE6_PLAN_2026-06-01 Phase 6.2.H2 — `awaitConfirm` now `await`s a
  // Promise-returning `onConfirm`/`onCancel` handler before resolving so
  // the recovery sequencer's next `await` doesn't race a still-pumping
  // convergeForward / repairRenameCascade. +~12 LOC (signature widening
  // + try/finally wrappers + two call-site comments). New snapshot: 1418
  // LOC.
  // PHASE6_PLAN_2026-06-01 Phase 6.2.H3 — the tag-rewrite recovery step
  // now `await vaultIndexStore.whenBuildComplete()` before sampling
  // metadata for partial-state detection so the rename branch can't see
  // a mid-rebuild empty index and offer the wrong "Discard" verb. +~11
  // LOC (guard + vault-identity recheck + docstring). New snapshot:
  // 1429 LOC.
  // PHASE6_PLAN_2026-06-01 Phase 6.2.H9 — the on-open reconcile loop
  // now routes through `applyFrontmatterToBackedTilesBatch` (one
  // setCache identity flip + microtask yields + mtime gate) instead of
  // a per-md `applyFrontmatterToBackedTiles` call. +~6 LOC of comment.
  // New snapshot: 1435 LOC.
  // PHASE6_PLAN_2026-06-01 Phase 6.3.P3 — the commit phase now also
  // calls `assertBaselinesSeeded(candidate.seededConfigBaselinePaths,
  // 'config')` so the dev tripwire warns if a future regression drops
  // the eager `.filo/` config baseline seed step. +6 LOC of comment +
  // call. New snapshot: 1441 LOC.
  // 6.4.M6 — `enqueueRenameQueueWork` learned an `errorContext` overload
  // so the three rename-queue listener sites stop duplicating their
  // `.then().catch(reportError)` pattern; the catch lives inside the
  // helper. +23 LOC of comment + signature + the three listener-site
  // refactors. New snapshot: 1464 LOC.
  // PHASE6_PLAN_2026-06-01 Phase 6.2.H4 (follow-up) — `runRecoverySequencer`
  // gained a `.filo/quit-failure.json` step: `consumeQuitFailureBreadcrumb`
  // reads + clears the main-written breadcrumb on vault open and surfaces the
  // preserved-partial locations in a persistent toast. +1 import + ~26 LOC
  // (recovery block + comments). New snapshot: 1491 LOC.
  // AUDIT4_REMEDIATION_PLAN_2026-06-02 Phase 2 DI-03 — `runPostCommitTasks`
  // gained a post-await vault-identity guard (so a fast A→B swap can't write
  // the outgoing vault's pruned tags into the incoming one) + the concise
  // race-explainer comment. +8 LOC. New snapshot: 1499 LOC.
  // AUDIT5_REMEDIATION_PLAN_2026-06-02 Phase 3 G1 + #11 — `beginVaultGeneration`
  // wired into commitVaultCandidate / closeVault / setPath, the
  // `enqueueRenameQueueWork` identity guard (no-op a task whose vault swapped
  // before it ran), and the `runRecoverySequencer` step 4 that surfaces
  // preserved `.filo/recovery/` snapshots (basename + ts + reveal) on open.
  // +76 LOC of guard wiring + recovery toast + comments. New snapshot: 1575 LOC.
  // AUDIT6_REMEDIATION_PLAN_2026-06-02 Phase 4 — L31 (`historyStore.whenChainSettled()`
  // import + the save() chain-drain comment) and L25 (`runRecoverySequencer`
  // captureVaultIdentity generation-guard comment). +20 LOC of explanatory
  // comments + one import. New snapshot: 1595 LOC.
  // AUDIT8_REMEDIATION_PLAN_2026-06-04 Phase 2 H2(b) — `runPostCommitTasks` now
  // captures `captureVaultIdentity()` alongside `newVaultPath` and the
  // post-await prune guard uses the generation-aware `isStillSameVault(identity)`
  // instead of the bare `vaultPath !== newVaultPath` string compare (which a
  // close→reopen of the SAME path passed). +7 LOC of capture + comment. New
  // snapshot: 1602 LOC.
  // AUDIT8_REMEDIATION_PLAN_2026-06-04 Phase 4 L4 — `runRecoverySequencer` now
  // surfaces `.filo/quit-failure.json` as step 0 (BEFORE the `.dirty` modal's
  // `await dismissed`, so the preserved-bytes notice isn't gated behind it) via
  // the split `readQuitFailureBreadcrumb` (read, no delete) +
  // `clearQuitFailureBreadcrumb` in the toast's `onDismiss` (clear only on
  // acknowledge, guarded by `isStillSameVault`). Net +6 LOC over the old
  // consume-on-read step 1b. New snapshot: 1608 LOC.
  // WRITE_PATH_REMEDIATION_PLAN_2026-06-04 Phase 3 / 3.1 — `save()` now ANDs
  // `!hasFailedWrites()` (import + one boolean term + explanatory comment) so the
  // Ctrl+S / flush-and-quit aggregate stays honest about a write that FAILED on an
  // earlier fire-and-forget timer and settled before the flush (no scheduler
  // re-surfaces it). +9 LOC. New snapshot: 1617 LOC.
  // AUDIT11_REMEDIATION_PLAN_2026-06-06 Phase 3 VS-1 — the rename-cascade
  // recovery's onConfirm/onCancel now thread the sequencer's generation-aware
  // `captured` identity into `repairRenameCascade` (so a swap before the click /
  // mid-repair bails instead of contaminating the new vault's cache). +4 LOC of
  // comments + threaded arg. New snapshot: 1621 LOC.
  // AUDIT12_REMEDIATION_PLAN_2026-06-06 Phase 2 M6 — `runPostCommitTasks` threads
  // the captured `identity` into `applyFrontmatterToBackedTilesBatch` (so the
  // on-open FM→cache reconcile batch bails before its terminal setCache if a swap
  // lands mid-reconcile, instead of flipping the outgoing vault's cache onto the
  // new one). +5 LOC of comment + threaded arg. New snapshot: 1626 LOC.
  // AUDIT13_REMEDIATION_PLAN_2026-06-06 Phase 3 H3 — `revertToOutgoingVault`
  // helper + the openVault capture/catch: a failed candidate load now reopens the
  // outgoing vault instead of stranding the user on an empty half-open vault.
  // New snapshot: 1704 LOC.
  // AUDIT13_REMEDIATION_PLAN_2026-06-06 Phase 4 L15 — `vaultCtx` exposes
  // `enqueueRenameQueueWork` to slices so the partial-read retry re-enters through
  // the serialised rename queue (ordering + vault-identity guard). +2 LOC. New
  // snapshot: 1706 LOC.
  // AUDIT13_REMEDIATION_PLAN_2026-06-06 Phase 7 M9 — the `vault:tree-updated`
  // listener now coalesces bursts through a trailing debounce
  // (`createTrailingDebounce`) so a sync-storm / multi-file git op collapses to
  // one tree reconcile instead of a full-vault walk per event. +3 LOC (import +
  // debounce const + cancel-on-teardown) net of comment trimming. New snapshot:
  // 1709 LOC.
  'src/renderer/stores/vault.svelte.ts': 1709,
  // In-app rename/delete/move orchestrator: drained disk-shape IPC + the
  // in-memory cascade (board cache, documentStore, tags, tabs, viewport,
  // undo) with per-await vault-identity bails so a swap mid-op can't apply the
  // outgoing vault's cascade to the new vault.
  // AUDIT12_REMEDIATION_PLAN_2026-06-06 Phase 3 L4 — `performDelete` gained two
  // more `isStillSameVault(deleteIdentity)` bails: one after the awaited
  // `fileTagsStore.flushPendingSave()` (before the B4 contentId-clear loop) and
  // one after the `Promise.allSettled(cleanupPromises)` (before the doc-unload
  // loop), matching the existing post-IPC/hydrate/flushAllDirty bails. +9 LOC of
  // guards + comments tipped it just over the default 1000-LOC limit. New
  // snapshot: 1008 LOC. Splitting the cascade out of the entry point is the
  // eventual fix.
  'src/renderer/stores/vaultFolderOps.ts': 1008,
  // External-changes orchestrator: classifies fs-watcher events into
  // editor-dirty toast / silent reload / sync-frontmatter / deleted-file
  // prompt / properties-popup-dirty prompt. 500 ms attachment-delete grace
  // period; bulk Reload-all path; cross-vault finalizer guard; markdown-
  // write gateway integration. Phase R2 added `runExternalRenameCascade`
  // helper (~45 LOC). Phase R6 added `promptBoardExternalEdit` (~35 LOC)
  // + the queueMicrotask registration of pre-write-stat handlers
  // (markdown writer + board scheduler) so drift detection routes
  // through Reload / Keep-local toasts. Bump history in git log.
  // Sprint B / B9 — `vaultIndexStore.renameKey` wire-up inside
  // `runExternalRenameCascade` adds an exact-match call + a folder-prefix
  // loop so vault search rebinds immediately on external rename.
  // Phase 4 — VaultPath import + per-loop `vaultPath(rel)` brand calls
  // for partial-read retry maps + previousByPath; +2 LOC.
  // AUDIT_REMEDIATION_PLAN_2026-05-28 Phase 2 — F4 added the
  // pending-local-write guard (`hasPendingWrite` intercept +
  // `promptMarkdownPendingWriteConflict`) and F3 added the synchronous
  // `fileTagsStore.flushPendingSave()` call inside `runExternalRenameCascade`;
  // +~84 LOC. Both are data-safety point-fixes; Phase 4 E3/E5 consolidate
  // them into shared authorities, which will shrink this back.
  // AUDIT_REMEDIATION_PLAN_2026-05-28 Phase 3 — M5 added the reload-silently
  // recovery snapshot (`promptReloadRecoveryIfSuspicious` + the pre-reload
  // capture in the reload-silently branch); +~72 LOC. Phase 4 E3 folded the
  // markdown classifier's dirty-check onto the shared `isPathPending`
  // authority (net-neutral rename) and E5 recorded the `tagsAffected` sink in
  // the external-rename cascade's sentinel write; +3 LOC.
  // AUDIT_REMEDIATION_PLAN Phase 2 / 7.9 — the file was over its prior 1530
  // ceiling (1538 LOC). Extracted the partial-read retry bookkeeping + the
  // attachment-delete grace window (module-scoped timing state + reset
  // helpers) into `lib/vault/externalChangeWindows.ts`; the store keeps its
  // public API via re-export. New snapshot: 1460 LOC.
  // AUDIT_REMEDIATION_PLAN_2026-05-30 Phase 4.2 — dropped the deleted file's
  // `.filo/tags.json` membership from the three user-confirmed deletion
  // handlers (promptDeletedFile Reload, bulk Reload-all, promptClosedBoard-
  // FileMissing Mark-broken-refs) so an external delete doesn't orphan its
  // tag entry. Three one-liners + comments scattered across those handlers;
  // nothing cleanly extractable for +14 LOC. The deferred 7.9 split (extract
  // the deletion-prompt cluster) will reclaim this. New snapshot: 1474 LOC.
  // AUDIT2_REMEDIATION_PLAN_2026-05-31 Phase 5.2 — added a per-path
  // in-flight `Map<path, Promise<choice>>` so concurrent
  // `promptExternalEditOnSync` callers for the same file share one toast
  // + one decision. Also exposed `__inFlightDriftPromptsForTests` so the
  // dedup contract is unit-testable. +45 LOC (map + dedup logic + finally
  // hook + test getter + docstrings). New snapshot: 1519 LOC.
  // PHASE6_PLAN_2026-06-01 Phase 6.1.R1 — `recreateDeletedFile` now
  // routes its post-write open-editor sync through the shared
  // `syncOpenEditorsAfterDiskMutation` helper. The helper's
  // `applyReloadFromDisk` self-cancels the armed body writer (6.0.C2),
  // which the bare `markClean(...)` it replaced did NOT — closing the
  // pre-recovery debounced-write race. +1 import line + 6 LOC of
  // comment + call site = +7 LOC. New snapshot: 1526 LOC.
  // PHASE6_PLAN_2026-06-01 Phase 6.1.R2 — `inFlightDriftPrompts` is now
  // reset on vault swap via `vaultSwapResettable` so a stale unresolved
  // entry can't block a fresh Reload / Keep-local prompt in the new
  // vault. +1 import addition (`vaultSwapResettable`) + 4 LOC for the
  // doc-line + subscription call. New snapshot: 1530 LOC.
  // PHASE6_PLAN_2026-06-01 Phase 6.1.R4 — added the `inFlightDrift-
  // Prompts` rename-transfer sweep via `registerPathRenamable` and
  // routed `runExternalRenameCascade` through `renameAllPathKeys`.
  // +~17 LOC (registration block + import + cascade-level helper call).
  // New snapshot: 1547 LOC.
  // PHASE6_PLAN_2026-06-01 Phase 6.2.H1 — sync-frontmatter dispatch
  // threads the post-sync `rawFrontmatter` through `setFrontmatter` so
  // the source-preserving FM engine's diff baseline refreshes too;
  // otherwise a body-only save after sync drops inline YAML comments on
  // externally-changed keys. +4 LOC of doc-comment + the threaded arg.
  // New snapshot: 1551 LOC.
  // PHASE6_PLAN_2026-06-01 Phase 6.3.P5 — added the `// allow-direct-write`
  // escape note above `recreateDeletedFile`'s direct
  // `vault:write-file-text` invoke (user-opt-in file recreation after
  // external delete) so the extended markdown-gateway gate doesn't
  // flag it. +3 LOC of comment. New snapshot: 1554 LOC.
  // 6.4.M4 — `promptExternalEditOnSync` + `promptBoardExternalEdit`
  // grew a `'defer'` return arm so auto-dismiss no longer silently
  // overwrites the external edit. +11 LOC of jsdoc, toast copy, and
  // the `onDismiss: () => resolve('defer')` arm. New snapshot: 1565 LOC.
  // 6.4.M19 — `runExternalRenameCascade` wraps `fileTagsStore.flushPendingSave()`
  // in a try/catch so a tags-flush rejection no longer aborts the board
  // cascade (sentinel write + flushAllDirty); the sentinel's tagsAffected
  // flag re-asserts the tag rename on recovery. +16 LOC of comment + guard.
  // New snapshot: 1581 LOC.
  // AUDIT4_REMEDIATION_PLAN_2026-06-02 Phase 4 DI-17 — the tags-only-rename
  // early-return now captures the synchronous tags flush's `{ ok }` result and,
  // when it FAILED, lays down a minimal recovery sentinel (no affected boards,
  // tagsAffected) so a failed tags-only rename is recoverable on reopen instead
  // of silently lost. +32 LOC of comment + flush-result capture + sentinel
  // write. New snapshot: 1613 LOC.
  // AUDIT5_REMEDIATION_PLAN_2026-06-02 Phase 3 G1 + #14 — `handleExternalRename`
  // captures the vault identity pre-drain and threads it through
  // `runExternalRenameCascade`, which now bails after its awaits if the vault
  // swapped (so the cascade can't run against the new vault's cache); and
  // `promptBoardExternalEdit` now shares the `inFlightDriftPrompts` dedup map
  // so it inherits the swap-reset + rename-transfer wiring. +43 LOC of guard
  // wiring + dedup + comments. New snapshot: 1656 LOC.
  // AUDIT7_REMEDIATION_PLAN_2026-06-03 Phase 4 — external-edit reconciliation
  // cluster: L13/L16 threads the read's (mtime,size) through every reload call
  // site so applyReloadFromDisk re-stamps the drift baseline (6 sites + handler
  // diskIdentity arg); L14 gates the handler on vaultIndex.isBuilding; L15 moves
  // the self-write filter inside the handler (single authority); L17 lays the
  // rename-cascade breadcrumb BEFORE the tag-flush bail so a swap-interrupted
  // cascade still leaves a retry trail. +63 LOC of comments + threaded args +
  // the early-sentinel block. New snapshot: 1719 LOC.
  // AUDIT8_REMEDIATION_PLAN_2026-06-04 Phase 2 H2(a) — `handleExternalMarkdownChanges`
  // captures `captureVaultIdentity()` before its awaits and bails
  // (`isStillSameVault`) after `applyChanges`, so a vault swap during the
  // awaits can't apply the outgoing vault's classification to the new vault's
  // same-named file (editor clobber / cross-vault tags / wrong-cache board).
  // +11 LOC of capture + guard + comments. New snapshot: 1730 LOC.
  // AUDIT8_REMEDIATION_PLAN_2026-06-04 Phase 3 M2 — the sync-frontmatter branch
  // now `noteBaseline(rel, next.lastModified, next.rawByteSize)` re-stamps the
  // per-file drift baseline (the body-only reload site already did; this FM-only
  // site didn't), so a subsequent in-app save doesn't fire a false "modified
  // externally" prompt. +1 import + ~10 LOC of comment + call. New snapshot: 1741 LOC.
  // AUDIT9_REMEDIATION_PLAN_2026-06-04 Phase 4 A9-L9 — the early rename-cascade
  // breadcrumb now records `[...new Set([...changedBoardIds, ...renamedBoardIds])]`
  // so a moved board (own `.board.json` relocated) lands in the recovered affected
  // set, not just reference-changed boards. +2 LOC of comment. New snapshot: 1743 LOC.
  // WRITE_PATH_REMEDIATION_PLAN_2026-06-04 Phase 2 / 2.1 — the sync-frontmatter
  // and reload-silently branches now call `dropStaleSeededFrontmatterCache(rel)`
  // (sibling lib) so a seeded-but-not-open Kanban card / Task row's FM cache is
  // dropped on an external edit and the next field write re-reads fresh disk
  // instead of reverting the external key. +1 import + ~10 LOC of comment + the
  // two call sites. New snapshot: 1754 LOC.
  // WRITE_PATH_REMEDIATION_PLAN_2026-06-04 Phase 3 / 3.4 — `promptModifiedFile`'s
  // Reload handler now re-reads CURRENT disk (`vaultIndexStore.applyChanges` +
  // `getMetadata`, inside an async IIFE) instead of replaying the `next` snapshot
  // captured at watcher-event time, so a second external write landing before the
  // user clicks Reload isn't lost. Mirrors `promptExternalEditOnSync`. +13 LOC.
  // New snapshot: 1767 LOC.
  // AUDIT11_REMEDIATION_PLAN_2026-06-06 Phase 3 EER-1 — every Reload-DISCARD site
  // now `dropPendingDelta(rel)` before `applyReloadFromDisk` (bulk Reload-all,
  // promptModifiedFile, promptPartialReadExhausted, promptExternalEditOnSync; the
  // F4 promptMarkdownPendingWriteConflict drops it via cancelFrontmatterWrite), so
  // a discarded Phase-4 field delta can't re-clobber disk via the reload's flush.
  // +13 LOC of import + four call sites + comments. New snapshot: 1780 LOC.
  // AUDIT12_REMEDIATION_PLAN_2026-06-06 Phase 3 L3 — the bulk "Reload all" handler
  // is now async and re-reads CURRENT disk per file (`vaultIndexStore.applyChanges`
  // + `getMetadata(p.rel) ?? p.next`) before `applyReloadFromDisk`, so a second
  // external write landing between detection and the click isn't lost (mirrors the
  // single-file promptModifiedFile Reload). +10 LOC of re-read + comment. New
  // snapshot: 1790 LOC.
  // AUDIT13_REMEDIATION_PLAN_2026-06-06 Phase 3 L16/L17 — generation-aware
  // `isStillSameVault` guards: L16 in `handleExternalAttachmentChanges` (replaces
  // a path-string compare) and L17 across the four async Reload toast handlers
  // that re-read disk via `applyChanges` then mutate stores. +32 LOC of
  // capture/bail + comments. New snapshot: 1822 LOC.
  // AUDIT13_REMEDIATION_PLAN_2026-06-06 Phase 4 — M4 (self-write suppression now
  // consults the drift baseline via the new `selfWriteDivergedFromBaseline`
  // helper + the per-path stat loop, so a real external edit in the window isn't
  // dropped), L5 (the no-editor body-only `ignore` branch re-stamps `noteBaseline`),
  // L1 (the five disk-reload `applyReloadFromDisk` sites + the reload-silently
  // `handleExternalChange` now thread `rawFrontmatter` so an external key keeps its
  // comment), L15 (the partial-read retry re-enters via `ctx.enqueueRenameQueueWork`).
  // +64 LOC. New snapshot: 1886 LOC.
  'src/renderer/stores/vaultExternalChanges.ts': 1886,
  // tileCommands.ts dropped off the allowlist (AUDIT_REMEDIATION_PLAN_2026-05-29
  // Phase 5 / C-3): the tag-driven commands (AddTileTag / RemoveTileTag /
  // AddPathTag / RemovePathTag / ToggleTagFade) moved to the new sibling
  // `commands/tileTagCommands.ts`, bringing the file back under the 1000-LOC cap.
  // PHASE6_PLAN_2026-06-01 Phase 6.1.R2 — `readOnlyTagToastShown` is now
  // reset on vault swap via `vaultSwapResettable` so a stale docId entry
  // can't suppress a legitimate read-only-tag toast in the new vault.
  // Import + doc comment + subscription call pushed the file just over
  // the default 1000-LOC limit. New snapshot: 1003 LOC. Splitting (e.g.
  // factoring the cascade orchestrators into a sibling) is queued for
  // a later pass — for now the growth is the smallest fix for the leak.
  // AUDIT5_REMEDIATION_PLAN_2026-06-02 R2 — the two single-tag writers
  // (writeTagChangeToTileMarkdown / writeTagChangeToMarkdownPath) now run their
  // whole read-modify-write inside `runSerializedMarkdownWrite` (per-path chain,
  // #8) and call `reconcileOpenEditorFrontmatter` so an open editor's next body
  // save keeps the tag (#4). +26 LOC of wrapping + reconcile + comments. New
  // snapshot: 1029 LOC. The queued cascade-orchestrator split will reclaim it.
  // AUDIT6_REMEDIATION_PLAN_2026-06-02 M3 — both single-tag writers now refresh
  // the gateway drift baseline (stat + refreshBaselineAfterWrite) after the
  // direct .md write so the next gateway/editor write doesn't false-positive a
  // "modified externally" prompt. +23 LOC of import + two stat/refresh blocks +
  // comments. New snapshot: 1052 LOC.
  // AUDIT8_REMEDIATION_PLAN_2026-06-04 Phase 3 M6 — `applyExternalReload` now
  // 3-way merges the external `.filo/tags.json` against a `lastSavedFile` base
  // instead of overwriting `file` wholesale, so a tag add/remove still inside the
  // ~300 ms save debounce (attachment tags have no other home) isn't discarded.
  // Adds the `lastSavedFile` base + `mergeTagsThreeWay`/`reapplyTagDelta`/
  // `cloneTagsFile`/`sameJson` helpers + base-update lines at hydrate /
  // commitFromCandidate / successful-save / reset. +76 LOC. New snapshot: 1128 LOC.
  // AUDIT9_REMEDIATION_PLAN_2026-06-04 Phase 4 A9-L7 — every `lastSavedFile`
  // re-set from outside the debounced save closure routes through `setMergeBase`
  // (bumps a `mergeBaseGeneration` token); the closure captures the token at fire
  // time and skips its trailing base assignment when a reload/reset advanced it
  // during the `tags:save` await, so a stale in-flight write can't clobber the
  // reload's fresh 3-way merge base back to a pre-reload snapshot. +36 LOC of
  // token + helper + guard + comments. New snapshot: 1164 LOC.
  // AUDIT11_REMEDIATION_PLAN_2026-06-06 Phase 3 VS-2 — both single-tag writers
  // (writeTagChangeToTileMarkdown / writeTagChangeToMarkdownPath) now
  // `captureVaultIdentity()` before the live-path read and `isStillSameVault`-bail
  // after each await before markPathFailed / refreshBaselineAfterWrite /
  // applyChanges, so a vault swap mid-write can't apply this vault's tag
  // bookkeeping to the new one (the baseline is keyed by relPath alone). +24 LOC
  // of import + capture + guards + comments. New snapshot: 1188 LOC.
  // AUDIT12_REMEDIATION_PLAN_2026-06-06 Phase 1 H2 + H3 — H2 deleted the local
  // `resolveTextTileFilePath` (vault-root fallback) and routed all four tile→path
  // resolvers through the canonical `resolveTextTileVaultPath`; H3 captures vault
  // identity in renameTagEverywhere / removeTagEverywhere, threads the captured
  // root into the sweep, and `isStillSameVault`-guards both in-memory commits.
  // Net +12 LOC (guards + comments; the deleted helper offset the H2 additions).
  // New snapshot: 1200 LOC.
  'src/renderer/stores/fileTags.svelte.ts': 1200,
  // Markdown write gateway: per-caller debounce, BOM-preserving hydrate,
  // pre-write drift prompt, in-flight tracking, force-write + cancel APIs.
  // PHASE6_PLAN_2026-06-01 Phase 6.4.M13 — the pre-write Reload/Keep-local
  // prompt now re-validates drift in a bounded loop (the file can drift again
  // while the modal is open), and 6.4.M17 added `flushFinalWriteOnDestroy`
  // (a swap-safe teardown write that no-ops once the gateway is reset). These
  // pushed the file just over the default 1000-LOC limit. New snapshot: 1009
  // LOC. Splitting (e.g. factoring the drift-prompt loop + hydrate gateway
  // into siblings) is queued for a later structural pass; for now the growth
  // is the smallest fix for two data-safety races.
  // AUDIT4_REMEDIATION_PLAN_2026-06-02 Phase 4 DI-09 + DI-17 — added a per-
  // resolved-path write chain (`writeChainByPath`) so two editors on one `.md`
  // (TextTile + DocumentEditor) serialise at the IPC layer instead of racing
  // and last-writer-clobbering the body (DI-09), plus the DI-17 documentation
  // of the H13 stale-cache re-read branch (retained as defense-in-depth,
  // believed unreachable under M1 docId-keyed monotonic versioning). +36 LOC
  // of map + chaining logic + comments. New snapshot: 1045 LOC.
  // AUDIT5_REMEDIATION_PLAN_2026-06-02 R2 + R3 — extracted the DI-09 per-path
  // chain into the exported `runSerializedMarkdownWrite` so the single-tag fast
  // path can enrol on the same chain (R2), and added the `MARKDOWN_WRITE_TIMEOUT_MS`
  // backstop wired into the scheduler's `writeTimeoutMs` so a wedged write can't
  // hang flushAll/save() forever (R3, #1). +43 LOC of helper + constant + doc.
  // New snapshot: 1088 LOC. The queued drift-prompt/hydrate split will reclaim it.
  // Audit-6 M1 (+22 LOC): the 'defer' / budget-exhausted drift aborts now
  // `markPathFailed` + throw (instead of a bare `return` that reported SUCCESS
  // and let `.filo/.dirty` be markClean'd while the edit never landed). New
  // snapshot: 1110 LOC.
  // Audit-7 M1 (+15 LOC): the write success path now `documentStore.markClean`s
  // the writer (guarded on `hasPending`) so a normally-saved editor goes clean —
  // the root-cause fix for the stuck-dirty writerId that pinned `isDirty` true
  // and triggered spurious external-edit prompts + frozen sibling reloads. New
  // snapshot: 1125 LOC.
  // Audit-7 L5 (+26 LOC): post-write baseline TOCTOU guard — capture the written
  // UTF-8 byte length and only stamp the baseline when the post-write stat's
  // size matches, so an external edit landing in the write→stat gap can't poison
  // the baseline into a silent next-write clobber. New snapshot: 1151 LOC.
  // AUDIT8_REMEDIATION_PLAN_2026-06-04 Phase 3 M1 — `FileState` carries the file's
  // real `eol`, sniffed once from the raw content in `readMarkdownForHydrate` and
  // threaded through `markHydrated` → `assembleMarkdownFile({ eol })`, so a CRLF
  // file with a single-line frontmatter keeps CRLF on a metadata edit (FM-source
  // detection alone can't tell — a one-line FM has no internal `\r\n`). +23 LOC of
  // field + param + sniff + thread + comments. New snapshot: 1174 LOC.
  // AUDIT9_REMEDIATION_PLAN_2026-06-04 Phase 3 A9-L5 — `WriteArgs` gained an optional
  // `originalFrontmatter` so a docId-less caller (orphan-card FM patch) can thread the
  // disk FM source; the assemble computation falls back to `args.originalFrontmatter`
  // when there's no docId, so the orphan write source-preserves instead of full-dumping.
  // +8 LOC of field + doc + fallback + comment. New snapshot: 1182 LOC.
  // AUDIT9_REMEDIATION_PLAN_2026-06-04 Phase 4 A9-L8 — `writeMarkdownFileImpl`
  // captures `captureVaultIdentity()` at entry and `return`s on `!isStillSameVault`
  // after the write await, BEFORE the post-write renderer-state bookkeeping (drift
  // baseline / vaultIndex restore / FM flushed-version / markClean), so a write
  // whose IPC committed against the outgoing vault can't upsert that vault's
  // metadata/baseline for `relPath` into the swapped-in vault's index/registry.
  // +19 LOC of import + capture + guard + comments. New snapshot: 1201 LOC.
  // WRITE_PATH_REMEDIATION_PLAN_2026-06-04 Phase 4 — `writeMarkdownFileImpl` gained
  // the delta write branch: when `args.frontmatterDelta` is present it reads CURRENT
  // disk in-chain, applies ONLY the delta keys (`applyFrontmatterDelta`), and
  // assembles against that same fresh source — so `nextFm` + `originalFrontmatter`
  // derive from one read and untouched (incl. external) keys are preserved by
  // construction. The legacy cache-FM path moved under an `else`. +58 LOC of the
  // delta branch + WriteArgs field + imports + comments. New snapshot: 1259 LOC.
  // AUDIT10_REMEDIATION_PLAN_2026-06-04 Phase 2 H2 — the cache-FM branch gained a
  // disk re-read guard: when the FM cache is never-seeded (`!hasFrontmatter`) and
  // the caller passes no FM (`argsFmEmpty`), it reads disk in-chain and seeds the
  // cache so a body-only save can't assemble against `{}` and strip the on-disk
  // YAML block (the TextTile sibling-adoption wipe). +27 LOC of guard + comments.
  // New snapshot: 1286 LOC.
  // AUDIT11_REMEDIATION_PLAN_2026-06-06 Phase 4 — N1 adds an `onFrontmatterRefused`
  // toast helper threaded into both assemble calls (surfaces a dropped metadata
  // edit over unparseable YAML instead of a silent success); N2/N3 + WC-2 add
  // explanatory comments (delta-branch BOM from the in-chain read; markClean
  // not gated on FM-pending). +25 LOC. New snapshot: 1311 LOC.
  // AUDIT13_REMEDIATION_PLAN_2026-06-06 Phase 7 L13 — DECISION comment on the
  // `fileState` registry: per-session growth is accepted (tiny entries cleared on
  // vault swap) rather than refcount-evicting open editors, which would risk
  // dropping live hydrate state in this gateway. Comment-only, no behavior change.
  // +7 LOC. New snapshot: 1318 LOC.
  // AUDIT13_REMEDIATION_PLAN_2026-06-06 Phase 9 L12 — noUncheckedIndexedAccess
  // guards in the two Promise.allSettled drain loops (capture the settled
  // result + the snapshot/target tuple, narrow before reading `.reason`). +5
  // LOC. New snapshot: 1323 LOC.
  // The gateway remains a candidate for a structural split in a later pass.
  'src/renderer/lib/vault/markdownFileWriter.ts': 1323,
  // AUDIT8_REMEDIATION_PLAN_2026-06-04 Phase 3 M5 — `UpdateOrphanFrontmatterCommand.
  // execute()` recomputes its inverse from a FRESH on-disk read on the first
  // execute (a `hasExecuted` guard) — mirroring the docId path's
  // captureInverseFromCache — so a stale vault-index inverse can't (1) falsely
  // conflict and DROP the user's edit on execute, or (2) mis-restore on undo when
  // an external editor changed the patched key. +~29 LOC of guard + recompute +
  // comments tipped the file just over the default 1000-LOC limit. New snapshot:
  // 1020 LOC. The command file is a candidate for a structural split in a later pass.
  // AUDIT9_REMEDIATION_PLAN_2026-06-04 Phase 1 — A9-H1 vault-identity bails across
  // the seed await in `UpdateCardFieldCommand.execute` + the orphan-FM paths
  // (`UpdateOrphanFrontmatterCommand.execute` + `applyOrphanPatchRebased`), so a
  // vault swap mid-seed can't write the outgoing vault's frontmatter onto the new
  // vault's same-named file. +19 LOC of `captureVaultIdentity()`/`isStillSameVault`
  // guards + concise comments (trimmed). New snapshot: 1039 LOC. The structural
  // split remains the eventual fix.
  // AUDIT9_REMEDIATION_PLAN_2026-06-04 Phase 2 — A9-L2: the orphan `commit()` now
  // lets a failed `writeMarkdownFile` propagate (was a swallowing catch) so
  // execute()/undo() reject + the history wrapper rolls back; the "Apply anyway"
  // toast handler grew its own `.catch(reportError)`. +6 LOC (guard logic +
  // trimmed rationale). New snapshot: 1045 LOC. The structural split still pends.
  // AUDIT9_REMEDIATION_PLAN_2026-06-04 Phase 3 A9-L5 — `applyOrphanPatchRebased`
  // captures the hydrate's `rawFrontmatter` and threads it into the docId-less
  // `writeMarkdownFile` as `originalFrontmatter`, so an orphan-card FM edit
  // source-preserves (comments / key order / quoting) instead of full-dumping.
  // +7 LOC of capture + thread + trimmed comments. New snapshot: 1052 LOC.
  // WRITE_PATH_REMEDIATION_PLAN_2026-06-04 Phase 4 — `UpdateCardFieldCommand.execute`
  // threads `patchToFrontmatterDelta(this.patch)` into `scheduleFrontmatterWrite`
  // (the import + the delta arg + the mergeFrontmatter-is-display-only rationale),
  // so the field write applies a delta to fresh disk instead of serialising the
  // cached object. +12 LOC. New snapshot: 1064 LOC. The structural split still pends.
  // AUDIT13_REMEDIATION_PLAN_2026-06-06 Phase 6 M5 + L7 — `MoveCardsCommand` gained a
  // forward-leg `toBeforeTileId` anchor (field + pre-move computation + execute arg)
  // so a cross-edit redo lands the block next to its original sibling instead of a
  // stale absolute index; L7 replaced the all-conflict-branch `markDirty` with a
  // no-op explainer (a no-write must not dirty the board). Net +14 LOC. New
  // snapshot: 1078 LOC. The structural split still pends.
  // AUDIT13_REMEDIATION_PLAN_2026-06-06 Phase 9 L12 — noUncheckedIndexedAccess
  // guards in DeleteCardCommand's placement snapshot, the next-survivor scan,
  // and DeleteColumnCommand's removed-column capture. +3 LOC. New snapshot:
  // 1081 LOC. The structural split still pends.
  'src/renderer/commands/kanbanCommands.ts': 1081,
};

function toPosix(p) {
  return p.split(sep).join('/');
}

function hasTrackedExtension(name) {
  return EXTENSIONS.some((ext) => name.endsWith(ext));
}

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      walk(full, out);
    } else if (s.isFile() && hasTrackedExtension(entry)) {
      out.push(full);
    }
  }
}

function countLines(path) {
  const text = readFileSync(path, 'utf8');
  if (text.length === 0) return 0;
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++;
  }
  if (text.charCodeAt(text.length - 1) === 10) count--;
  return count;
}

const files = [];
for (const dir of SCAN_DIRS) {
  walk(join(ROOT, dir), files);
}

const offenders = [];
const allowlistChecks = new Map(Object.entries(ALLOWLIST));

for (const abs of files) {
  const rel = toPosix(relative(ROOT, abs));
  const loc = countLines(abs);
  if (allowlistChecks.has(rel)) {
    const snapshot = allowlistChecks.get(rel);
    if (loc > snapshot) {
      offenders.push({ rel, loc, ceiling: snapshot, kind: 'allowlist-growth' });
    }
    allowlistChecks.delete(rel);
  } else if (loc > LIMIT) {
    offenders.push({ rel, loc, ceiling: LIMIT, kind: 'over-limit' });
  }
}

const staleAllowlist = [...allowlistChecks.keys()];

if (offenders.length === 0 && staleAllowlist.length === 0) {
  console.log(`[check-file-sizes] OK — scanned ${files.length} files, all within ceilings.`);
  process.exit(0);
}

if (offenders.length > 0) {
  console.error('[check-file-sizes] FAILED — files over their ceiling:');
  for (const o of offenders) {
    console.error(`  ${o.rel} — ${o.loc} LOC (ceiling ${o.ceiling}, ${o.kind})`);
  }
  console.error(
    '\nFix: split the file (see CLAUDE.md "one concern per file") or, if the growth\n' +
      'is intentional, edit ALLOWLIST in scripts/check-file-sizes.mjs in the same PR.',
  );
}

if (staleAllowlist.length > 0) {
  console.error('\n[check-file-sizes] FAILED — ALLOWLIST entries no longer exist on disk:');
  for (const path of staleAllowlist) console.error(`  ${path}`);
  console.error('\nFix: remove these entries from ALLOWLIST in scripts/check-file-sizes.mjs.');
}

process.exit(1);

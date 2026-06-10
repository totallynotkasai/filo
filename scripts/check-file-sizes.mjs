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
  // AUDIT14_REMEDIATION_PLAN_2026-06-07 Phase 5 5.3 — the completion checkbox
  // gained `role="checkbox"` + `aria-checked={completed}` + an `aria-label`
  // (was a bare `<button>` with only a `title`, exposing no accessible name or
  // state). +3 LOC. New snapshot: 1545 LOC.
  'src/renderer/components/boards/TaskItem.svelte': 1545,
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
  // AUDIT14_REMEDIATION_PLAN_2026-06-07 Phase 1 1.8 — `openVault`/`closeVault`
  // wrap their swap window (registry released → new vault committed) in a
  // `swapInProgress` promise + try/finally, and `save()` awaits it so a quit
  // landing in that window drains against a live vault instead of fail-closing
  // with neither data nor a breadcrumb. `openVault` was restructured: hoisted
  // `choice` to function scope, split the dialog/save `if (currentProject)` from
  // the swap-lifecycle one, and wrapped candidate-load + commit in the try. +62
  // LOC of guard + restructure indentation + comments. New snapshot: 1771 LOC.
  // AUDIT15_REMEDIATION_PLAN_2026-06-08 Phase 5 P5.1 — assessed for the structural
  // split and DEFERRED (by decision). Unlike the sibling `vaultExternalChanges.ts`
  // (split into `vaultExternalPrompts.ts` + `vaultExternalDriftPrompts.ts` this
  // phase because its prompt builders take `ctx` and touch no module state), the
  // lifecycle helpers here (`commitVaultCandidate` / `runPostCommitTasks` /
  // `revertToOutgoingVault` / `runRecoverySequencer`) ASSIGN the module-private
  // `$state` (`currentProject` / `vaultPath` / `manualOrder` / `fileTree` /
  // `recoveryPendingPaths`) directly, so getting under 1000 needs a state-accessor
  // refactor — the same lifecycle-slice extraction the Sprint D note records was
  // tried and reverted for a microtask race, on the most data-integrity-critical
  // file (vault swap / recovery). Not worth that risk for a LOW maintainability
  // item; revisit in a focused, isolated session. No LOC change. Snapshot 1771.
  // AUDIT16_REMEDIATION_PLAN_2026-06-09 Phase 3 — three cross-vault guard
  // fixes: 3.2 step-2 tag-rewrite onConfirm/onCancel vault-identity guards
  // (entry + after every await, so a swap-auto-cancelled confirm can't prune
  // the NEW vault's whole fileTags registry); 3.5 owner-checked
  // `swapInProgress` clear in openVault/closeVault finallys (a concurrent
  // swap's window survives the first swap's finally); 3.6 `refreshTree`
  // success boolean + `refreshTreeAndCleanup` skip-on-stale + per-candidate
  // `vault:file-exists` confirm before board eviction. +75 LOC of guards +
  // rationale comments. New snapshot: 1846 LOC.
  'src/renderer/stores/vault.svelte.ts': 1846,
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
  // AUDIT14_REMEDIATION_PLAN_2026-06-07 Phase 4 4.4 — tags:save / tags:load now
  // resolve a `{ ok:false }` envelope on error; the hydrate (`tags:load`) and
  // scheduled save (`tags:save`) call sites route through `assertIpcOk` (import
  // + two wrapped invokes) so the failure still re-throws into the existing
  // miscScheduler / catch paths, now carrying a typed code. +3 LOC. New
  // snapshot: 1203 LOC.
  'src/renderer/stores/fileTags.svelte.ts': 1203,
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
  // AUDIT14_REMEDIATION_PLAN_2026-06-07 Phase 3 (3.2 + 3.3) — the delta write
  // branch now (a) derives EOL from the fresh in-chain read instead of the stale
  // hydrate `state.eol` snapshot, and (b) refuses a TRUNCATED read (opening fence,
  // no closing fence, while the index recorded a FM block) rather than assembling
  // a delta that strips the on-disk frontmatter. +41 LOC of guard + EOL sniff +
  // rationale comments. New snapshot: 1364 LOC.
  // AUDIT15_REMEDIATION_PLAN_2026-06-08 Phase 1 P1.4 — the delta branch now
  // sources the body from the fresh in-chain disk read (`parsedFresh.body`) when
  // there is NO live editor for the docId, instead of the caller's watcher-index
  // snapshot, so a never-opened card/orphan write can't revert an external body
  // edit `fs.watch` missed. +5 LOC (live-editor check + body pick + comment). New
  // snapshot: 1369 LOC.
  // The gateway remains a candidate for a structural split in a later pass.
  'src/renderer/lib/vault/markdownFileWriter.ts': 1369,
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
  // AUDIT14_REMEDIATION_PLAN_2026-06-07 Phase 2 2.2 — DeleteCardCommand captures
  // a next-surviving-sibling `beforeTileId` anchor (field + ctor capture + undo
  // arg + rationale comment) so undo re-inserts a deleted mid-column card next
  // to its original sibling instead of at a stale absolute index (mirrors
  // MoveCardCommand 6.4.M16). +12 LOC. New snapshot: 1093 LOC. The structural
  // split still pends.
  'src/renderer/commands/kanbanCommands.ts': 1093,
  // writeScheduler.ts left the allowlist in AUDIT16 Phase 4: the public type
  // surface (CreateSchedulerOptions / Scheduler / FlushAllResult / entry
  // interfaces) moved to writeSchedulerTypes.ts (re-exported, importers
  // unchanged), bringing the implementation back under the limit even with
  // the 4.1 monotonic-generation mint, 4.4 parked-fire cancel, and 4.7
  // per-key failure-id prune added in the same phase. Bump history for its
  // 933→1175 era is in git log.
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

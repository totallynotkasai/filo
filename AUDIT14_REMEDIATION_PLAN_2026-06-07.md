# AUDIT-14 Remediation Plan — 2026-06-07

**Branch:** `chore/electron-42`
**Audit type:** Broad, fresh-eyes (data-integrity + write/concurrency + lifecycle/recovery + IPC/security + undo-redo + UI/UX & a11y + architecture + Electron-42 fallout). 9 parallel adversarial agents + maintainer verification of the top findings.
**Mode:** Report-only audit → this is the remediation plan. No code changed yet.

## Ground truth (verified, not assumed)

| Check | Result |
| --- | --- |
| `npm run check` (svelte-check / tsc) | ✅ exit 0 |
| `npm run build` (electron-vite, Electron 42) | ✅ exit 0 |
| `npm run test:unit` (full Vitest suite) | ✅ exit 0 |

The Electron 33→42 jump is clean at the type/build/test level. Findings are runtime-logic, UX, and safety-net gaps.

## Headline verdict

**No confirmed *silent* data-loss bug.** The frontmatter CST engine is byte-correct, the IPC boundary is hardened, vault-swap/generation guards are sound, and the H3 swap reorder is correct. The real risks are bounded correctness gaps — the most important can drop the **newest** edit on a hard quit during a slow write, but in every traced loss path the `.filo/.dirty` recovery sentinel stays set and warns on next launch (not silent). Safe to start dogfooding (esp. a single vault on local disk); fix Phase 1 before heavy use on OneDrive / many boards / split panes.

## Legend

- **Severity:** 🔴 HIGH · 🟠 MEDIUM · 🟡 LOW · ⚪ DOC/INFO
- **Status:** `[VERIFIED]` = maintainer read the code path and confirmed it · `[reported]` = a focused agent traced it with file:line evidence, credible but not independently re-run · confidence noted where relevant.
- **Each phase must end with `npm run ci:verify` green** and leave the app runnable (per CLAUDE.md "leave working software at every phase boundary").

## Master issue table

| ID | Sev | Area | File (primary) | One-liner |
| --- | --- | --- | --- | --- |
| 1.1 | 🔴 | write-drain | `writeScheduler.ts` | Parked write (mid-`drainPriorInFlight`) invisible to `flushAll`/`flush` → newest edit can be dropped on quit |
| 1.2 | 🔴 | recovery | `vaultRecovery.ts` | `acknowledgeRecovery` clears `.filo/.dirty` unconditionally |
| 1.3 | 🟠 | recovery | `vault.svelte.ts` | False-positive recovery prompt on first open of a legacy vault |
| 1.4 | 🔴 | write-order | `writeScheduler.ts` | `drainPriorInFlight` awaits the timeout-bounded tracker → >60s wedge re-opens out-of-order clobber |
| 1.5 | 🟠 | sentinel | `writeStateTracking.ts` | Gateway/frontmatter late-success heal not generation-gated (board/config/misc are) |
| 1.6 | 🟡 | write-order | `writeScheduler.ts` | `writeGenByPath` grows for the whole vault session |
| 1.7 | 🟠 | swap | `markdownFileWriter.ts` | Dead `cancelAndAwaitMarkdownWritesForDocument` — documented swap-await guarantee not wired |
| 1.8 | 🟡 | swap | `vault.svelte.ts` | Quit during open-vault swap window flushes fail-closed (no breadcrumb) |
| 2.1 | 🟠 | undo | `history.svelte.ts` | Cross-board undo/redo *rollback* restores onto the wrong board's stack |
| 2.2 | 🟠 | undo | `kanbanCommands.ts` | `DeleteCardCommand` undo re-inserts at a stale absolute index (no neighbour anchor) |
| 2.3 | 🟠 | undo | `tileCommands.ts` | `DeleteTilesCommand.undo` snapshot-restore write doesn't reconcile open editors |
| 2.4 | 🟡 | undo | `history.svelte.ts` | Command targeting a closed board strands un-undoable on a sibling's stack |
| 2.5 | 🟡 | undo | `tileTagCommands.ts` | Per-tile tag command undo is blind re-derivation, not snapshot |
| 3.1 | 🟠 | frontmatter | `replaceAllCommand.ts` | Replace-All FM-boundary regex diverges from the parser → silent skip / rare FM corruption |
| 3.2 | 🟡 | frontmatter | `markdownFileWriter.ts` | Delta path uses stale `state.eol` (not the fresh in-chain read's EOL) |
| 3.3 | 🟡 | frontmatter | `markdownFileWriter.ts` | Truncated/partial in-chain read can drop the on-disk FM block |
| 3.4 | 🟡 | frontmatter | `markdownFileWriter.ts` | Delta-path body TOCTOU (FM read in-chain, body read earlier) |
| 3.5 | ⚪ | docs | `replaceAllCommand.ts` + | Stale `gray-matter` references in comments (removed in Audit-13 M2) |
| 4.1 | 🟠 | security | `media.ipc.ts` | `media:open-external` skips the DNS-resolution SSRF check its sibling enforces |
| 4.2 | 🟠 | security | `dialog.ipc.ts` | `dialog:open-file` mints copy-source approvals with no active-vault gate / vault binding |
| 4.3 | 🟡 | security | `vault.ipc.ts` | `vault:copy-file` source `lstat`→`open` symlink-target-swap TOCTOU |
| 4.4 | 🟡 | security | `tags.ipc.ts` | `tags:load`/`tags:save` throw raw exceptions instead of an envelope |
| 4.5 | 🟡 | security | `main.ts` | CSP `frame-src https:` permits any third-party iframe origin |
| 4.6 | 🟡 | security | `board.ipc.ts` | `board:save`/`board:load` validate path without `forCreation` |
| 4.7 | 🟡 | security | `main.ts` | Prod HTTP-header CSP still authorizes `ws://localhost:*` |
| 5.1 | 🔴 | ui | `MindMapBoard.svelte` | Keyboard handler not pane-scoped → split-view double-dispatch (Delete/n/c/arrows) |
| 5.2 | 🟡 | ui | `AppShell.svelte` | Redundant `Delete` double-dispatch even single-pane |
| 5.3 | 🟠 | a11y | `TaskItem.svelte` | Task completion checkbox has no accessible name/state |
| 5.4 | 🟡 | ui | `EmojiPicker.svelte` | Panel can render below the viewport (no clamp/portal) |
| 5.5 | 🟡 | ui | `EmojiPicker.svelte` | Click-outside dismissal doesn't restore focus to trigger |
| 5.6 | 🟡 | ui | `TaskListToc.svelte` | IntersectionObserver effect has no per-run cleanup |
| 5.7 | 🟡 | perf | `TimerTile.svelte` | 100ms interval runs even when idle / clock-mode |
| 5.8 | 🟡 | a11y | (batch) | TabBar menu roles/Escape; mouse-only controls; FloatingVaultPanel role |
| 6.1 | 🟠 | arch | `fileWatcher.ts`, `vault.ipc.ts` | Two main files at exactly the 1000-LOC ceiling with no allowlist headroom |
| 6.2 | 🟠 | arch | `vaultExternalChanges.ts` | `queueMicrotask` cycle-break silently no-ops external-edit prompts if init order shifts |
| 6.3 | 🟠 | build | `electron.vite.config.mts` | `zod` left external in the main bundle (packaging relies on builder-26 collector) |
| 6.4 | 🟡 | dead-code | `configOps.ts` | 6 dead exported config savers |
| 6.5 | 🟡 | dead-code | (several) | Other dead / over-exported symbols |
| 6.6 | ⚪ | docs | `CLAUDE.md` | "seven grandfathered files" is stale (now 13–15) |
| 6.7 | ⚪ | docs | `KNOWN_LIMITATIONS.md` | #5 and #6 are stale (code is better than documented) |
| 7.1 | 🔴 | tests | `tests/e2e/` | No E2E for quit-with-pending-write + crash-recovery (highest-consequence flow) |
| 7.2 | 🔴 | gate | `check-no-silent-write-abort.mjs` | Exact-shape regex — a refactored abort slips through |
| 7.3 | 🟠 | gate | `check-md-writers-reconcile-editors.mjs` | Whole-file exemption hides 2.3's un-reconciled restore write |
| 7.4 | 🟠 | gate | `check-vault-lifecycle-coverage.mjs` | Checks subscription, not that the reset callback actually resets |
| 7.5 | 🟠 | tests | `frontmatterInvariant.test.ts` | Phase-4 delta write path is not in the fuzz corpus |
| 7.6 | 🟠 | tests | `app.test.ts` | One E2E asserts nothing; one is vacuously gated |
| 7.7 | 🟡 | tests | (several stores) | Thinly-exercised: `fileTagsCascade`, `boardFrontmatterSync`, `links.svelte` |
| 7.8 | 🟡 | gate | `check-ipc-parity.mjs` + | Literal-only channel scan (latent); orphan delta regex over-broad |

---

# Phase 1 — Write-drain & recovery integrity (do FIRST, before heavy dogfooding)

**Goal:** close every path that can drop a write or defeat the `.filo/.dirty` recovery breadcrumb. This is the data-integrity core.

> **STATUS: ✅ DONE 2026-06-07 — all of 1.1–1.8; `npm run ci:verify` green (exit 0).**
> New tests: `src/tests/unit/audit14Phase1.test.ts` (1.1/1.4/1.5/1.6, with 1.1 + 1.5 bite-verified), plus 1.2 in `vaultRecovery.test.ts` and 1.3 in `dirtyFlagRecovery.test.ts`. 1.7/1.8 are integration-level wirings covered by the type-check + full-suite regression (no dedicated unit test). File-size ceilings: `vault.svelte.ts` 1709→1771; new allowlist entry `writeScheduler.ts` 1109. Uncommitted.

### 1.1 🔴 [VERIFIED] Parked write invisible to `flushAll()`/`flush()`
- **File:** `src/renderer/lib/boards/writeScheduler.ts` (debounce-timer fire path ~L630-655; `flushAll` ~L777-896; `flush` ~L683-775; `drainPriorInFlight` ~L559-563).
- **Symptom / root cause:** When the debounce timer fires for a key that already has an in-flight write, it runs `pending.delete(key)` and then `void (async () => { await drainPriorInFlight(key); fireFromTimer(); })()`. `fireWrite` (which registers the entry in `inFlight`) only runs **after** the drain resolves. During that await the newest write B is in **neither** `pending` nor `inFlight`. `flushAll()`/`flush()` snapshot both maps **once** and never re-scan, so on quit they neither fire nor await B; `save()` can resolve `true` while B has not landed.
- **Why it is NOT silent loss (verified):** B keeps an outstanding `beginWrite` (its `endWrite` only fires inside `fireWrite`), so `inflightWriteCount > 0` and B's path stays in `pendingVaultPaths` → `markClean` cannot run until B actually resolves successfully. So the worst case is "newest edit dropped on a hard quit race, surfaced by the recovery prompt." Reachable on OneDrive/SMB where `board:save` exceeds the 300ms debounce. **Regression introduced by the recent Audit-13 H1 per-key-drain generalization.**
- **Fix (recommended):** make parked fires first-class.
  1. Add a per-key `parked` ledger: `const parked = new Map<string, { promise: Promise<void>; resolve: () => void }>()`.
  2. In the timer's drained branch, register a `parked` entry **before** `pending.delete`, and clear it inside `fireFromTimer` once `fireWrite` has added the `inFlight` entry (so there's no gap where the write is in no structure).
  3. In `flush(key)` and `flushAll()`, after the existing pending+inflight drain, **await any `parked` promises and then re-drain** the resulting `inFlight` entries (the parked fire registers its own entry on resolve).
- **Fix (alternative, simpler):** convert `flushAll`/`flush` to **drain-until-quiescent** — loop `while (pending.size || anyInFlight() || parkedCount())` with a hard iteration bound (e.g. 50) and a `console.warn` on hitting the bound, so a pathological reschedule loop can't hang quit.
- **Verify:** new unit test in `boardWriteOrdering.test.ts` — real-timer interleave: fire A (slow `performWrite`), schedule B, advance timers so B parks behind A's drain, call `flushAll()` **while B is parked**, assert B's `performWrite` ran and was awaited before `flushAll` resolved. Bite-check: revert the fix → test red. Also assert `save()` returns `true` only after B resolves.

### 1.2 🔴 [VERIFIED] `acknowledgeRecovery` clears the sentinel unconditionally
- **File:** `src/renderer/stores/vaultRecovery.ts` (`acknowledgeRecovery`, L24-31).
- **Root cause:** calls `await markClean(vaultRoot)` with no idle check; every other `markClean` caller gates on `inflightWriteCount === 0 && failedVaultPaths.size === 0 && pendingVaultPaths.size === 0`. Dismissing the modal while writes are pending (e.g. the 1.3 migration-repair writes) wipes the breadcrumb.
- **Fix:** replace `await markClean(vaultRoot)` with `syncSentinelIfIdle(vaultRoot)` (already exported from `writeStateTracking.ts` — it `markClean`s iff idle, else re-marks dirty with the *current* session's remaining paths, which correctly drops the acknowledged old paths). Keep `setRecoveryPendingPaths([])` and `resolveRecoveryDismissed()`.
- **Verify:** unit test — with one pending write tracked, call `acknowledgeRecovery`, assert `markClean` did **not** run and the sentinel still lists the pending path; with nothing pending, assert it cleared.

### 1.3 🟠 [VERIFIED] False-positive recovery prompt on first open of a legacy vault
- **File:** `src/renderer/stores/vault.svelte.ts` (`commitVaultCandidate` repaired-board `markDirty` ~L384-391; `checkRecovery` read ~L706) + `src/renderer/lib/vault/dirtyFlagRecovery.ts` (`SentinelPayload`).
- **Root cause:** migration repairs (`groupsBackfilled` / orphan-prune / boardId-normalize) call `markDirty` synchronously during the swap, writing a fresh `.filo/.dirty`; `checkRecovery` then reads it and cannot distinguish "previous crash" from "this session just wrote it" (no session marker). Surfaces a spurious recovery modal naming just-repaired boards, and feeds 1.2.
- **Fix (recommended):** add a per-launch session id to the sentinel payload.
  1. Mint a `launchId` once at app start (e.g. `createId()` in a module constant).
  2. `markDirty` stamps `launchId` into the payload; `checkRecovery` treats a sentinel whose `launchId === currentLaunchId` as "self, not a prior crash" → no prompt.
- **Fix (alternative):** in `checkRecovery`, drop any `pendingPaths` entry for which `isPathPending(rel) || isRecentSelfWrite(rel)` is true; if the list empties, suppress the prompt.
- **Verify:** unit test — open a vault whose boards trigger a migration repair; assert no recovery modal; then simulate a genuine prior-session sentinel (different `launchId`) and assert the modal shows.

### 1.4 🔴 [reported, confidence Med-High] `drainPriorInFlight` awaits the timeout-bounded tracker
- **File:** `src/renderer/lib/boards/writeScheduler.ts` (`drainPriorInFlight` L559-563; tracker built from the `writeTimeoutMs`-raced `innerPromise` L412-491).
- **Root cause:** the drain awaits `priorEntry.promise` = `tracker` = `innerPromise.then(...)`, which resolves at `min(write, writeTimeoutMs=60s)`. When a prior write exceeds 60s, the drain returns and the newer write fires while the older IPC is still pumping; if the OS lands the older one last it clobbers the newer payload, and the post-write `vault:stat` then stamps the drift baseline to the stale bytes (no future drift warning). Same data class H1 set out to close, displaced past the timeout. Narrow (needs a ≥60s wedge) but on the exact OneDrive/SMB target.
- **Fix (blast-radius reduction — recommended, low-risk):** gate the **post-write baseline stamp** on write-generation currency — only `refreshBaselineAfterWrite` when `writeGenByPath.get(pathKey) === writeGen` for this fire. A superseded write that lands late then leaves the baseline stale-vs-disk, so the next external/stale state is still detected as drift (preserves the warning that 1.4 otherwise destroys).
- **Fix (full — larger, optional):** add a monotonic write-sequence token to the `board:save`/`vault:write-*` IPC payload; main rejects a write whose token is older than the last one it durably wrote for that path. This makes out-of-order landing impossible regardless of timeout. Defer unless 1.1-class issues recur.
- **Verify:** unit — wedge A past `writeTimeoutMs`, fire B, land A late; assert the drift baseline was NOT stamped to A's bytes (recommended fix) — i.e. a subsequent external edit still prompts.

### 1.5 🟠 [reported, confidence Med] Late-success heal not generation-gated for gateway/frontmatter
- **File:** `src/renderer/lib/boards/writeStateTracking.ts` (`endWrite` success branch L488-490 — unconditional `failedVaultPaths.delete(key)`).
- **Root cause:** Audit-13 M3 gates the board/config/misc late-heal (`clearFailedPathAfterLateSuccess`) on `writeGenByPath`, but the gateway+frontmatter schedulers self-heal via `trackComponentWrite`'s `endWrite(true)`, which deletes the path from `failedVaultPaths` with no generation check. For a path written by multiple `.md` writers, a late success can clear a *different* writer's legitimately-recorded failure for the same path → false "clean" / premature `markClean`.
- **Fix:** thread the fire's write generation into `endWrite` (optional param) and, in the success branch, only `failedVaultPaths.delete(key)` when `writeGenByPath.get(key) === thisGen` (mirror M3). Where the generation isn't available, leave behavior unchanged (the `.md` per-path chain makes the ordering hard to hit, hence Med not High).
- **Verify:** unit — two `.md` writers for one path: older times-out+fails-heals while a newer legitimately fails; assert the newer failure survives.

### 1.6 🟡 [reported] `writeGenByPath` grows for the vault session
- **File:** `src/renderer/lib/boards/writeScheduler.ts` (created L404-408; cleared only in `reset()` L916).
- **Root cause:** one entry per distinct path ever written; pruned only on vault swap. Bounded by distinct-files-edited (small), but new in Audit-13.
- **Fix:** in `fireWrite`'s settle callback, when the write succeeds AND this gen is still newest AND the path is not failed/pending, `writeGenByPath.delete(pathKey)`. (Re-created on next write.) Keep it simple — don't prune mid-flight.
- **Verify:** unit — write N distinct paths to completion, assert `writeGenByPath.size` returns to ~0 (add a test-only size getter).

### 1.7 🟠 [reported, confidence Med] Dead `cancelAndAwaitMarkdownWritesForDocument`
- **File:** `src/renderer/lib/vault/markdownFileWriter.ts` (L1195, async sibling of the sync cancel); the only unload path `src/renderer/stores/document.svelte.ts` (~L804) calls the **sync** version.
- **Root cause:** the docstring asserts a swap/tab-close guarantee (no writer still pumping bytes against `docId` before proceeding) that is wired nowhere.
- **Fix (decide):** EITHER (a) wire the async version into the vault-swap pre-swap hook / `unloadDocument` so the swap genuinely awaits in-flight markdown writes for the doc (closes a latent swap clobber, complements 1.1); OR (b) delete it and correct the mental model if the per-path `.md` chain + generation guard already cover swap. **Recommendation:** (a) — await it in the pre-swap drain for open docs; it's cheap and aligns with the swap-safety investment.
- **Verify:** if (a), unit — open doc with an in-flight write, trigger swap, assert the write settled before the swap proceeded; gate against re-introducing a sync-only swap path.

### 1.8 🟡 [reported] Quit during the open-vault swap window flushes fail-closed
- **File:** `src/renderer/stores/vault.svelte.ts` (swap window ~L1106-1149, between `fireVaultSwap('pre-swap')`/`vault:close` and `commitVaultCandidate`).
- **Root cause:** in that sub-second window the registry is `null` but module `vaultPath` is still the outgoing path; a quit's `save()` writes (incl. the `.filo/.dirty` IPC) hit `assertActiveVault` → rejected. Fail-closed is safe (no cross-vault write), but a forced destroy here leaves neither data nor breadcrumb. Pre-swap already cancels timers, so usually nothing is pending.
- **Fix:** set a `swapInProgress` flag; have `handleFlushAndQuit`/`save()` await the in-flight swap (or treat a swap-in-progress as "defer ready-to-quit until the swap settles, then drain"). Low priority — narrow window.
- **Verify:** unit — fire `app:flush-and-quit` mid-swap; assert it waits for the swap to settle before signaling ready.

**Phase 1 exit:** `npm run ci:verify` green; new tests for 1.1/1.2/1.3 at minimum.

---

# Phase 2 — Undo/redo & command-pattern correctness

**Goal:** undo always fully restores and never corrupts a stack or an open editor's file.

> **STATUS: ✅ DONE 2026-06-07 — all of 2.1–2.5; `npm run ci:verify` green (exit 0).**
> - **2.1** `history.svelte.ts`: new `getStackFor(boardId)`; `undo()`/`redo()` capture `originBoardId` (the board active at call time) and thread it to `rollbackUndo`/`rollbackRedo`, which now resolve the move's origin stack instead of `getActiveStack()` (which reads the post-auto-switch board). markDirty uses `command.targetBoardId || originBoardId`.
> - **2.2** `DeleteCardCommand` captures a next-surviving-sibling `beforeTileId`; `persistAddKanbanPlacement` gained an optional `beforeTileId` anchor (mirrors `moveKanbanPlacement` 6.4.M16), falling back to the clamped absolute position.
> - **2.3** `DeleteTilesCommand.undoWithSnapshot` routes the restore write through `writeMarkdownAndReconcile({ mode: 'full', create: true })` (was a raw `vault:write-file-text`), so a restored `.md` open on a second pane is reloaded and can't be inverted by its next body save (#4). `tileCommands.ts` no longer has a raw write.
> - **2.4** `historyStore.clearBoard(boardId)` now also sweeps every surviving stack and drops commands whose `targetBoardId === boardId` (via `mutateStack`), so a closed board's command stranded on a sibling stack can't wedge Ctrl+Z. Every `clearBoard` caller fires only once the board is truly gone (verified the tab-close guards).
> - **2.5** `RemoveTileTagCommand` / `RemovePathTagCommand` snapshot the tag's global colour at construction and re-assert it via `ensureTag(name, colour)` before the inverse re-add on undo, so a definition deleted in the interim isn't resurrected with the default colour. **Deviation from the plan's literal "restore the membership snapshot":** the inverse op is KEPT for the tile/path tag array — a whole-array snapshot would clobber a tag a concurrent action added between execute and undo; only the colour metadata was genuinely lossy.
>
> New tests: `src/tests/unit/audit14Phase2.test.ts` (2.1, 2.3, 2.4, 2.5) + the `DeleteCardCommand` neighbour-anchor block in `kanbanStructureCommandsRoundTrip.test.ts` (2.2). All five fixes bite-verified (revert → red). File-size ceiling: `kanbanCommands.ts` 1081→1093. The 7.3 gate-narrowing (`tileCommands.ts` no longer needs its `RECONCILE_EXEMPT` entry) is deferred to Phase 7. Uncommitted.

### 2.1 🟠 [VERIFIED] Cross-board *rollback* restores onto the wrong stack
- **File:** `src/renderer/stores/history.svelte.ts` (`rollbackUndo` L363-375, `rollbackRedo` L385-397; the auto-switch in `undo()` L531-542 / `redo()`).
- **Root cause:** `undo()` does the synchronous stack move on board A's stack (correct), then `settleActiveScope(command.targetBoardId)` flips `activeBoardId` to B. If the async body rejects, `rollbackUndo` calls `getActiveStack()` **with no board arg**, now reading **B's** stacks — removing the command from B's redo (where it never was) and assigning A's `preUndoStack` onto **B's** undo stack. Corrupts both. (`rollbackExecute` is safe — it uses an explicit captured `stack`.)
- **Fix:** pass the target board to a stack resolver: `rollbackUndo(command, preUndoStack)` → resolve `const stack = getStackFor(command.targetBoardId ?? activeBoardId)` (add a `getStackFor(boardId)` helper alongside `getActiveStack`). Same for `rollbackRedo`. Use `command.targetBoardId` for the `markDirty` too.
- **Verify:** unit — push a command targeting B onto A's stack (inactive-pane case), make its async `undo()` reject, assert A's stacks are restored and B's stacks untouched. Bite-check: current code → B's undo stack mutated.

### 2.2 🟠 [reported] `DeleteCardCommand` undo uses a stale absolute index
- **File:** `src/renderer/commands/kanbanCommands.ts` (`DeleteCardCommand` ~L99-162; contrast `MoveCardCommand.undo` ~L255-261).
- **Root cause:** restores via `persistAddKanbanPlacement(..., this.snapshotPosition, ...)` with no neighbour anchor; the move commands already got the "next-surviving-sibling anchor" fix (6.4.M16 / Audit-7 M3). Sibling mutations between delete and undo land the card at the wrong slot.
- **Fix:** at delete time capture `beforeTileId` (the id of the next surviving card in the column, or null for tail); on undo insert relative to that anchor, falling back to clamped `snapshotPosition`. Mirror `MoveCardCommand`.
- **Verify:** add a round-trip test in `kanbanStructureCommandsRoundTrip` — delete a mid-column card, reorder siblings, undo, assert original slot.

### 2.3 🟠 [reported, confidence Med] `DeleteTilesCommand.undo` restore write doesn't reconcile open editors
- **File:** `src/renderer/commands/tileCommands.ts` (`undoWithSnapshot` raw `vault:write-file-text` ~L374-379; contrast `CascadeDeleteCommand.undo` which syncs open editors).
- **Root cause:** the same `.md` restored while a sibling editor (same file on a second board in another pane) holds a stale frontmatter cache → its next debounced body-save silently inverts the restore (the #4 class). Hidden today by a whole-file gate exemption (see 7.3).
- **Fix:** route the restore write through `writeMarkdownAndReconcile({...})` (the coupled write+reconcile helper) or call `reconcileOpenEditorFrontmatter` for the restored path, matching `CascadeDeleteCommand.undo`.
- **Verify:** unit — same file on two boards, one open as a Document; delete via the first, undo, then trigger the open editor's body save; assert the restored frontmatter survives. (Pairs with the gate narrowing in 7.3.)

### 2.4 🟡 [reported] Command targeting a closed board strands on a sibling's stack
- **File:** `src/renderer/stores/history.svelte.ts` (no-activator branch L508-515; `clearBoard` L664) + `src/renderer/stores/board.svelte.ts` (`cleanupAfterBoardRemoved` ~L146-157).
- **Root cause:** history is filed by the global active board, not `targetBoardId`. `clearBoard(B)` deletes B's own stack but not commands *targeting* B that sit on board A's stack; on Ctrl+Z `boardActivator(B)` fails → toast fires and the command is **not popped**, wedging A's undo behind it forever.
- **Fix:** in `cleanupAfterBoardRemoved`/`clearBoard`, also sweep every other stack and drop commands whose `targetBoardId === removedBoardId`. (Bounded scan over open boards' stacks.)
- **Verify:** unit — command targeting B on A's stack, close B, Ctrl+Z on A; assert A's undo proceeds to the next real command (no wedge).

### 2.5 🟡 [reported, confidence Med] Per-tile tag command undo is blind re-derivation
- **File:** `src/renderer/commands/tileTagCommands.ts` (`AddTileTagCommand`/`RemoveTileTagCommand`/path variants ~L82-165).
- **Root cause:** execute/undo are mirror `_applyAddTagToTile`/`_applyRemoveTagFromTile` with no captured before-state; if an external sync/another action changed the tile's tag set (or the tag's `.filo/tags.json` color) between execute and undo, the inverse op operates blindly. Every other field command moved to snapshot+rebase.
- **Fix:** snapshot the tile's tag membership (and, if removal can delete a global tag definition with color, that too) at execute; undo restores the snapshot rather than replaying the inverse. Confirm with `fileTags.svelte._apply*` whether tag *metadata* can be lost (the agent could not fully confirm).
- **Verify:** round-trip test exercising an external tag-set change between execute and undo.

**Phase 2 exit:** `ci:verify` green; round-trip tests for 2.1/2.2/2.3.

---

# Phase 3 — Frontmatter / markdown write edges

> **STATUS: ✅ DONE 2026-06-07 — all of 3.1–3.5; `npm run ci:verify` green (exit 0, incl. `ci:frontmatter-invariant` 295 tests).**
> - **3.1** `replaceAllCommand.ts`: deleted the divergent local `findFrontmatterEnd` (`---\r?\n`) and now measure the FM byte length with the SAME splitter the search index used — `splitFrontmatterSource(content)` → `content.length - body.length` (the body is a suffix of `content`). A trailing-space fence (`--- \n`) no longer silently skips every match (or splices into the FM). Also removes that file's stale `gray-matter` comment (3.5).
> - **3.2** `markdownFileWriter.ts` delta branch: EOL now comes from the fresh in-chain read (`freshContent.includes('\r\n')`), not the hydrate-time `state.eol` snapshot, so a LF↔CRLF external conversion since hydrate doesn't yield a mixed-EOL file. Falls back to `state.eol` only for an empty file (no signal).
> - **3.3** `markdownFileWriter.ts` delta branch: TRUNCATION guard — if the vault index recorded a FM block for the path but the fresh read parsed none AND the raw bytes still open with a `---` fence (a legitimate FM removal drops the opening fence too), `markPathFailed` + throw instead of assembling a delta that strips the on-disk frontmatter. Captured `freshContent` from the in-chain read to drive both 3.2 and 3.3.
> - **3.4** KEPT the current design (the pre-write drift stat straddles the read gap, and an open editor's LIVE body must win, so we can't source the body from `parsedFresh.body`); extended the Audit-11 N2 comment with the audit-14 3.4 decision.
> - **3.5** Updated stale `gray-matter` comments in `frontmatterSync.ts` (normalizeScalar) + `PropertiesPopup.svelte` (BOM sniff → `splitFrontmatterSource`); the `replaceAllCommand.ts` one went away with `findFrontmatterEnd`. The remaining `gray-matter` mentions in source are accurate "was removed" historical notes.
>
> New tests: `src/tests/unit/audit14Phase3.test.ts` (3.2 ×2 + 3.3 ×3, incl. two no-false-positive cases) + the trailing-space-fence block in `replaceAllCommand.test.ts` (3.1). All four behavioral fixes bite-verified (revert → red). File-size ceiling: `markdownFileWriter.ts` 1323→1364. Uncommitted.

### 3.1 🟠 [reported, confidence High on divergence] Replace-All FM-boundary regex divergence
- **File:** `src/renderer/commands/replaceAllCommand.ts` (`findFrontmatterEnd` L138-149; used L99/107-108/113).
- **Root cause:** `findFrontmatterEnd` uses `/^\s*---\r?\n([\s\S]*?)\r?\n---\r?\n/` while search offsets were computed against `FileMetadata.content` derived by `splitFrontmatterSource` (`/^---[ \t]*\r?\n.../`). On files with a trailing space on the fence (`--- \n`) the two disagree → Replace-All silently skips matches (the byte-equality guard `continue`s); a common search term colliding at the shifted offset could splice into the FM.
- **Fix:** compute the FM byte length with the shared `splitFrontmatterSource(content)` (or export the indexer's fence regex) so the boundary matches the offsets exactly. Delete the divergent local regex.
- **Verify:** unit — replace a term in a body of a file with a `--- ` (trailing-space) fence; assert the match is found and the FM is byte-untouched.

### 3.2 🟡 [reported] Delta path uses stale `state.eol`
- **File:** `src/renderer/lib/vault/markdownFileWriter.ts` (delta branch ~L716 passes `eol: state.eol` while FM bytes + BOM come from the fresh in-chain read ~L708-715).
- **Root cause:** EOL is from the hydrate snapshot; if an external editor converted LF↔CRLF after hydrate, `detectFrontmatterEol` honors the stale `options.eol` → mixed-EOL output. Cosmetic; self-heals on next full hydrate.
- **Fix:** derive `eol` from the fresh in-chain read (the same read that sources FM + BOM), e.g. sniff CRLF/LF from `parsedFresh` raw text, falling back to `state.eol`.
- **Verify:** unit — hydrate LF, externally convert to CRLF, apply a delta; assert output is uniformly CRLF.

### 3.3 🟡 [reported, confidence Low] Truncated in-chain read can drop the FM block
- **File:** `src/renderer/lib/vault/markdownFileWriter.ts` (delta branch ~L686-718).
- **Root cause:** if the in-chain `vault:read-file-text` returns *partial* content (a non-atomic external writer mid-write), `parseMarkdownFile` sees no closing fence → `hasFrontmatter:false`, and `assembleMarkdownFile` writes only the delta keys + truncated body, dropping the real FM. The drift `vault:stat` offers some cover; a thrown read is handled, a short read is not.
- **Fix:** after the in-chain read, sanity-check completeness before applying a delta — e.g. if the prior baseline/index recorded frontmatter for this path but the fresh read parses none AND the raw text lacks a closing fence, treat as a read anomaly → `markPathFailed` + throw (don't write). Conservative.
- **Verify:** unit — stub a fresh read returning a truncated FM-bearing file; assert the writer refuses + marks failed rather than stripping the FM.

### 3.4 🟡 [reported, confidence Med] Delta-path body TOCTOU
- **File:** `src/renderer/lib/vault/markdownFileWriter.ts` (~L698-704) with `frontmatterWriteScheduler.ts` (~L311) and `PropertiesPopup.svelte` (~L174).
- **Root cause:** `nextFm` is from the fresh in-chain read but `body` is the caller's earlier-read body; an external body edit between the two reads is overwritten with the stale body. Bounded by the pre-write drift stat (straddles the gap), so very narrow.
- **Fix:** for field/Properties writes, source the body from the **same** in-chain read as the FM (the gateway already reads the whole file — reuse its body) instead of the caller's earlier snapshot, OR keep the current design and add a comment + the drift assertion test pinning the bound. Decide based on cost.
- **Verify:** unit — external body edit between the caller's read and the gateway read; assert the external body survives (if fixed) or that drift prompts (if bounded).

### 3.5 ⚪ [reported] Stale `gray-matter` comments
- **Files:** `replaceAllCommand.ts:143`, `frontmatterSync.ts:64-66`, `PropertiesPopup.svelte:178`.
- **Fix:** update/remove the comments referencing `gray-matter` (removed in Audit-13 M2). The `replaceAllCommand` one actively misleads (implies `findFrontmatterEnd` matches the parser — see 3.1).

**Phase 3 exit:** `ci:verify` green; tests for 3.1 (+ 3.3 if implemented). `ci:frontmatter-invariant` still green.

---

# Phase 4 — Security & IPC hardening (hostile-vault threat model)

> **STATUS: ✅ DONE 2026-06-07 — all of 4.1–4.7; `npm run ci:verify` green (exit 0, incl. `ci:ipc-parity`, `ci:copy-file-source-guard`, `ci:untrusted-sinks`).**
> - **4.1** `media.ipc.ts` `media:open-external`: the http(s) branch now runs `isHostnamePrivate(host)` (the same DNS-resolution SSRF check `link:fetch-metadata` enforces) in an `else` to the static `isPrivateUrl`, so a public-looking hostname that RESOLVES to a private range (DNS rebinding / `169.254.169.254`) is refused before `shell.openExternal`. `mailto:`/`tel:` keep skipping it (no hostname).
> - **4.2** Vault-bound copy-source approvals. `approvedSources.ts` now stores `Map<sourceKey, vaultKey>` (binding = the registry's canonical path at mint time); `isApprovedCopySource` requires the binding to equal the CURRENTLY-active vault (both sides read the same `vaultRegistry`, so a symlinked-vs-canonical vault spelling still agrees). `registerApprovedSource` refuses when no vault is active. `dialog:open-file` is gated on `vaultRegistry.currentVaultPath` (fails closed in the no-vault window; the home-screen picker uses the separate `vault:select` openDirectory channel, so opening a vault is unaffected). The Audit-13 M11 swap-clear is kept as defence-in-depth.
> - **4.3** `fileOps.ts` `copyFileToVault` gained a `noFollowSource` param (default `false` → non-IPC callers unchanged) routing the source open through `openSourceForCopy`: `O_NOFOLLOW` on POSIX (ELOOP on a symlink final component) + a pre-open `lstat` symlink-reject on Windows (best-effort — Node has no fd→path API). Defeats a regular-file→symlink swap between the handler's pre-flight `lstat` and the open. `vault:copy-file` passes `true` for every source (in-vault sources are already required to be regular files, so it's pure hardening). The existing fstat `.isFile()` + `maxBytes` cap stay (`ci:copy-file-source-guard` green).
> - **4.4** `tags.ipc.ts` `tags:load`/`tags:save` resolve a typed `{ ok:false, code }` envelope on error (bare `string|null`/`void` on success — the `theme:load` precedent, deliberately NOT added to `ENVELOPE_CHANNELS`). **DEVIATION from the plan's literal "wrap in try/catch":** the renderer save path (`fileTags.scheduleSave`) DEPENDS on `tags:save` throwing (the miscScheduler catches throws to record the failure + keep `.filo/.dirty`); a naive envelope would silently swallow it. So all 4 consumers (fileTags load+save, vaultExternalReconcilers load, vaultCandidate load) route the result through `assertIpcOk`, which re-throws `{ok:false}` — preserving the exact throw-based control flow, now carrying `NO_ACTIVE_VAULT`/`FILE_TOO_LARGE`. Contract types updated.
> - **4.5** `frame-src https:` KEPT — Iframe tiles embed arbitrary user https origins, so a fixed allowlist isn't possible. Documented as accepted defence-in-depth (sandbox `allow-scripts` WITHOUT `allow-same-origin` + `asSafeIframeSrc`) in KNOWN_LIMITATIONS.md #10 + a CSP comment.
> - **4.6** `board.ipc.ts` `board:save` validates with `{ forCreation: true }` (it's a creating channel) so a reserved DOS stem / illegal char can't be authored for a cross-platform vault. `board:load`/`board:delete` stay creation-free (`ci:no-forcreation-on-read-delete` green).
> - **4.7** Extracted the app-origin CSP into the pure `utils/contentSecurityPolicy.ts` `buildAppContentSecurityPolicy(isPackaged)`; it drops `ws://localhost:*` from `connect-src` when packaged, matching the `filo-strip-dev-csp` Vite plugin that strips the same token from the index.html `<meta>`. `main.ts` uses the helper; the "mirrors index.html" comment corrected.
>
> New tests: `src/tests/unit/audit14Phase4.test.ts` (4.1 DNS ×4, 4.2 gate+binding ×3, 4.4 envelope ×3, 4.7 CSP ×3; **4.1 + 4.2 bite-verified**). `copyFileSourceGuard.test.ts` updated to the vault-binding model + the 4.2 cross-vault rejection + 4.3 symlink specs (skip without symlink privilege). `dialogOptionsValidation.test.ts` set an active vault for its valid-options specs + a no-vault gate spec. File sizes: the `vault.ipc.ts` edit was made net-zero (held at its 1000 ceiling — no allowlist add); `fileTags.svelte.ts` ceiling 1200→1203. Uncommitted.

### 4.1 🟠 [reported] `media:open-external` skips DNS SSRF check
- **File:** `src/main/ipc/media.ipc.ts` (~L290-306; contrast `link:fetch-metadata` ~L442/476).
- **Root cause:** for `http(s)://` it only does the static-string `isPrivateUrl(target)`; a public-looking hostname resolving to `10.x`/`169.254.169.254` passes and is opened in the browser.
- **Fix:** add the `await isHostnamePrivate(host)` DNS check (as `link:fetch-metadata` does) before `shell.openExternal`; refuse + log on private resolution. Browser-mediated, but close the asymmetry.
- **Verify:** unit — stub DNS to a private IP for a public name; assert refusal.

### 4.2 🟠 [reported] `dialog:open-file` approval has no active-vault gate / vault binding
- **File:** `src/main/ipc/dialog.ipc.ts` (~L117-159); `src/main/services/approvedSources.ts` (`isApprovedCopySource` ~L111-121).
- **Root cause:** callable with no `assertActiveVault`; every picked path is registered into a process-global set keyed by absolute path with no vault association, so `vault:copy-file` approves it for whatever vault is current. Audit-13 M11's swap-time `clearApprovedSources()` narrows but doesn't eliminate the cross-vault/TOCTOU window.
- **Fix:** (a) gate `dialog:open-file` on `assertActiveVault`; (b) tag each approved source with the vault root active when it was minted, and have `isApprovedCopySource(path, currentVaultRoot)` require a match. Keep the swap-time clear as defense-in-depth.
- **Verify:** unit — mint approval under vault A, swap to B, attempt `vault:copy-file`; assert rejection.

### 4.3 🟡 [reported] `vault:copy-file` source symlink-target-swap TOCTOU
- **File:** `src/main/ipc/vault.ipc.ts` (lstat ~L954-957); `src/main/vault/fileOps.ts` (`copyFileToVault` open ~L546-557).
- **Root cause:** `lstat` rejects non-regular sources, but `fs.open(sourcePath,'r')` follows symlinks; a regular-file-at-lstat swapped to a symlink-to-`/etc/passwd` before open is followed (the fstat sees the target, passes). The byte cap bounds size, not containment.
- **Fix:** open with `O_NOFOLLOW` where supported (Windows: open then compare `realpath(fd)`/`GetFinalPathNameByHandle` against the lstat'd path; reject on mismatch). Apply only to the approved-but-out-of-vault source path; in-vault copies are already contained.
- **Verify:** unit/integration — swap source to a symlink between lstat and open; assert refusal (best-effort on Windows).

### 4.4 🟡 [reported] `tags:load`/`tags:save` throw raw instead of envelope
- **File:** `src/main/ipc/tags.ipc.ts` (~L26-74; contrast `board.ipc.ts:281-311`).
- **Fix:** wrap both bodies in try/catch returning the `{ ok:false, code }` envelope so `NO_ACTIVE_VAULT` during a swap surfaces as a typed code, not an unhandled rejection. (Consistency/robustness; containment already holds.)
- **Verify:** the `ipcEnvelope` contract test — assert tags channels return an envelope on error.

### 4.5 🟡 [reported] CSP `frame-src https:` is broad
- **File:** `src/main/main.ts` (~L105); `index.html:6`.
- **Root cause:** any iframe tile / injected iframe can load arbitrary https origins (exfil-by-URL / fingerprinting), bounded by the tile sandbox (`allow-scripts`, no `allow-same-origin`) and `asSafeIframeSrc`.
- **Fix:** consider tightening to the origins the app actually embeds, or accept as documented defense-in-depth. Low priority given the sandbox; note the decision in `KNOWN_LIMITATIONS.md` if accepted.

### 4.6 🟡 [reported] `board:save`/`board:load` validate path without `forCreation`
- **File:** `src/main/ipc/board.ipc.ts` (~L169/199).
- **Fix:** pass `{ forCreation: true }` to `assertSafeRelativePath` for the creating channel (`board:save`) so a reserved DOS stem / illegal char can't be written for a cross-platform vault. Moot on Windows; portability only.

### 4.7 🟡 [reported] Prod HTTP-header CSP still allows `ws://localhost:*`
- **File:** `src/main/main.ts` (`installContentSecurityPolicy` ~L104).
- **Root cause:** the `filo-strip-dev-csp` Vite plugin strips `ws://localhost:*` only from the `index.html` `<meta>`, not from this header string; packaged builds emit a header CSP allowing a localhost websocket the app never opens. The doc comment "mirrors index.html" is now false in prod.
- **Fix:** build the header CSP's `connect-src` from a constant that omits `ws://localhost:*` when `app.isPackaged` (or share one source with the index.html strip). Update the comment.
- **Verify:** assert the packaged-mode CSP header has no `ws://`.

**Phase 4 exit:** `ci:verify` green (`ci:ipc-parity`, `ci:copy-file-source-guard`, `ci:untrusted-sinks` still green); tests for 4.1/4.2.

---

# Phase 5 — UI/UX & accessibility

> **STATUS: ✅ DONE 2026-06-08 — all of 5.1–5.8; `npm run ci:verify` green (exit 0).**
> - **5.1** `MindMapBoard.svelte`: `handleKeydown` early-returns `if (!isActiveScope(scope)) return;` as its first statement, so the `<svelte:window onkeydown>` handler only acts for the focused pane (was double-dispatching n/c/arrows/Delete/Backspace across split panes). Mirrors the Kanban/TaskList `enabled`-gated shortcuts.
> - **5.2** Same file: the bare-delete branch narrowed from `Delete || Backspace` to **`Backspace` only**. `Delete` now routes solely through the GLOBAL gated `tile:delete` command (AppShell), which also deletes selected connections + offers the delete-backing-file option — so the single-pane double-confirm is gone. **Deviation from the plan's literal "remove MindMapBoard's own Delete handler":** `Backspace` is KEPT as a board-local, pane-gated, tiles-only alias — a GLOBAL `Backspace` binding would double-fire against Task List / Kanban rows that bind it, and dropping Backspace entirely would be a (small) regression. `Delete`'s richer global path is strictly an improvement.
> - **5.3** `TaskItem.svelte`: the completion checkbox `<button>` gained `role="checkbox"` + `aria-checked={completed}` + `aria-label={`Completed: ${tile.title}`}` (was a bare button with only a `title` — no accessible name or state). File-size ceiling `TaskItem.svelte` 1542→1545.
> - **5.4** `EmojiPicker.svelte`: the panel now PORTALS to the nearest `<dialog>`/`<body>` and is positioned `fixed` via `updatePanelPos()` with a viewport clamp that flips ABOVE the trigger when below won't fit (mirrors `ColorPicker.panelPortal`); `Tab.svelte` dropped its manual `y - 300` upward nudge since the picker self-clamps. Verified `--z-dropdown` (2600) > Tab's `--z-context-menu-overlay` (2500) so portaled-panel clicks still reach the emoji buttons.
> - **5.5** Same file: `handleClickOutside` now routes through `closePicker()` (restores focus to the trigger) instead of a bare `showPicker = false`; the outside-click check also accounts for the portaled panel (`panelRef`).
> - **5.6** `TaskListToc.svelte`: the IntersectionObserver `$effect` returns a per-run cleanup (`localObserver.disconnect()` + clear the shared ref if still ours) and the deferred `queueMicrotask` observe bails if a later run/teardown replaced the captured instance (`observer !== localObserver`).
> - **5.7** `TimerTile.svelte`: the fixed lifetime-long 100 ms interval is replaced by a cadence `$effect` — **no interval** when a non-clock countdown is stopped/paused, **1 s** in clock mode, **100 ms** only for a running countdown — re-arming on `mode`/`isRunning` flips. The handle lives in the effect's own cleanup (untrack-wrapped body so `tick()`'s reactive reads don't re-arm it every fire), so the component-scope `intervalId` binding is gone (and `ci:component-timer-cleanup` has nothing to enforce).
> - **5.8** a11y batch: TabBar new-tab menu got `role="menu"`/`role="menuitem"` + aria-haspopup/expanded; BOTH new-tab and overflow menus got Escape-to-close that returns focus to their trigger button. TimerTile's stopped-display div + IframeTile's interact blocker got keyboard equivalents (Enter/Space → the same action; role=button + tabindex). FloatingVaultPanel's outer `role="dialog"` → `role="region"` (persistent non-modal panel) and the resize handle got keyboard resize (arrow keys, Shift = larger step, same clamp as the pointer path). **Minimap map-click left as-is on purpose** — a keyboard "click at a point" has no sensible target, and the waypoint buttons already give a keyboard navigation path (matches the plan's parenthetical).
>
> New test: `src/tests/unit/audit14Phase5.test.ts` (5.1 — two real `BoardScope`s + raw window-listener wiring, asserting a bare key acts on ONLY the active pane; **bite-verified**: dropping the guard fails 2/3). `svelte-check` 0 errors / 0 warnings (3 a11y false-positives suppressed with stacked single-code `svelte-ignore` comments — multi-code-per-comment isn't honored). The axe `a11y.test.ts` is Playwright/Electron E2E (runs on `main` + nightly), not part of `ci:verify` — the checkbox name/state, menu roles, and keyboard handlers feed its existing per-board axe scans. Uncommitted.

### 5.1 🔴 [reported] MindMapBoard keyboard handler not pane-scoped
- **File:** `src/renderer/components/boards/MindMapBoard.svelte` (`<svelte:window onkeydown={handleKeydown}>` L612; `handleKeydown` L430; `isActiveScope` already imported, used only for edge-pan L131).
- **Root cause:** unlike Kanban/TaskList (which gate shortcuts on `isActivePane`), MindMap's window handler has no active-pane gate; with two Mind Map panes a single Delete/n/c/arrow fires in both (one `n` creates a tile on two boards). Delete also double-dispatches with the global `tile:delete` command even single-pane.
- **Fix:** early-return in `handleKeydown` when `!isActiveScope(scope)`; fold the bare-`Delete` handling into the gated command registry (also fixes 5.2). Keep `isArrowConsumingTarget`.
- **Verify:** component test / E2E — two Mind Map panes, press `n`; assert exactly one tile created on the active pane.

### 5.2 🟡 [reported] Redundant `Delete` double-dispatch
- **File:** `src/renderer/components/layout/AppShell.svelte` (~L394, global `tile:delete`) + `MindMapBoard.svelte` (~L523).
- **Fix:** remove MindMapBoard's own Delete handler once 5.1 routes it through the gated command; two `openConfirm` calls with divergent copy collapse to one. (Subsumed by 5.1.)

### 5.3 🟠 [reported] Task completion checkbox has no accessible name/state
- **File:** `src/renderer/components/boards/TaskItem.svelte` (~L639-651; also reached by `TaskListRow` ~L132).
- **Root cause:** the most-used control on the Task board is a `<button>` with only a `title`; no `aria-label`, no `role="checkbox"`+`aria-checked` (or `aria-pressed`). State conveyed visually (✓ + fill).
- **Fix:** add `aria-label` (toggle wording) and `aria-pressed={completed}` (or `role="checkbox"` + `aria-checked`). Keep the existing strikethrough+opacity (non-color cue already present).
- **Verify:** `a11y.test.ts` axe pass for the Task board; assert the checkbox exposes a name + checked state.

### 5.4 🟡 [reported] EmojiPicker can render below the viewport
- **File:** `src/renderer/components/shared/EmojiPicker.svelte` (~L123-125; consumer `Tab.svelte:223`).
- **Fix:** portal + viewport-edge clamp like `ColorPicker.svelte` (`panelPortal` + `clampToViewport`), since the tab bar is the bottom-most chrome.

### 5.5 🟡 [reported] EmojiPicker click-outside doesn't restore focus
- **File:** `src/renderer/components/shared/EmojiPicker.svelte` (`handleClickOutside` ~L31-35).
- **Fix:** route outside-click through `closePicker()` (which restores focus to the trigger) instead of setting `showPicker = false` directly.

### 5.6 🟡 [reported] TaskListToc IntersectionObserver effect has no per-run cleanup
- **File:** `src/renderer/components/boards/TaskListToc.svelte` (~L32-65).
- **Fix:** `return () => observer?.disconnect()` inside the `$effect`; guard the `queueMicrotask`'d `observe()` against a replaced/disconnected observer (capture the instance, check identity before `observe`).

### 5.7 🟡 [reported] TimerTile 100ms interval always running
- **File:** `src/renderer/components/tiles/TimerTile.svelte` (~L187).
- **Fix:** pause the interval when `!isRunning && mode !== 'clock'`; use a 1s tick in clock mode. (Efficiency; already cleaned up on destroy.)

### 5.8 🟡 [reported] Misc a11y batch
- TabBar new-tab popup menu (`TabBar.svelte:254-265`): add `role="menu"`/`role="menuitem"` + Escape-to-close + focus management (the overflow menu also lacks Escape).
- TimerTile custom-time entry (`:226-232`) and IframeTile interact mode (`:143`): add keyboard equivalents (currently mouse-only).
- Minimap map-click navigation (`Minimap.svelte:277`): mouse-only (waypoints give a partial keyboard path).
- FloatingVaultPanel (`:160/182`): reconsider `role="dialog"` on a persistent non-modal panel; the resize-handle `role="separator"` has no keyboard resize.

**Phase 5 exit:** `ci:verify` green; axe `a11y.test.ts` green; component test for 5.1.

---

# Phase 6 — Architecture, dead code & build

> **STATUS: ✅ DONE 2026-06-08 — all of 6.1–6.7; `npm run ci:verify` green (exit 0).**
> - **6.1** Split both 1000-LOC main files back UNDER the ceiling (no allowlist bump). `vault.ipc.ts` (1000→814): the `vault:copy-file` handler moved to a new `src/main/ipc/vaultCopy.ipc.ts` (`registerVaultCopyHandlers`, wired into `ipc/index.ts` right after `registerVaultHandlers`), and the shared fs-error mapper to a new `src/main/ipc/ipcErrorCode.ts` (imported by both — its 4 error-class imports + 7 now-unused vault.ipc imports were cleaned up). `fileWatcher.ts` (1000→831): the `this`-free path-classification unit (`IGNORE_RULES` / `shouldIgnorePath` / `MEDIA_EXTENSIONS` / `classifyChange`) moved to a new `src/main/services/fileWatcherClassify.ts`; the class's `classifyForTests` seam + 4 internal call sites now use the imported free `classifyChange`, and the now-unused `extname` import was dropped. The `ci:copy-file-source-guard` gate's Target 1 path was repointed to `vaultCopy.ipc.ts` (Targets 2/3 — `copyFileToVault` in fileOps, `vault:close`/`vault:watch` clear — stayed in place). `ci:ipc-parity` green (copy-file found in its new file).
> - **6.2** Tactical fix (a), NOT the durable cycle-break (b) — option b is a large refactor in the weakest subsystem (external-edit reconciliation), deferred. The silent `queueMicrotask` registration guards in `vaultExternalChanges.ts` now `console.error` in a dev-only `else` gated on `import.meta.env.MODE === 'development'` (fires in `npm run dev`; quiet in vitest, where a module-reset non-live binding is legitimate, and in prod), so a future import-graph drift that disables external-edit prompts is caught at the dev console instead of shipping silently. Added `MODE: string` to `ImportMetaEnv` in `shims.d.ts` (was DEV/PROD only → `check` error). Compacted the surrounding comment to land **net −1 LOC** so the already-at-ceiling file (1886) didn't trip `ci:file-sizes`.
> - **6.3** `electron.vite.config.mts` main `externalizeDepsPlugin` exclude `['nanoid']`→`['zod']` so zod is BUNDLED into `dist/main` (verified: no `require("zod")` in `dist/main/main.js`, zod symbols inlined, main.js 277 kB). `nanoid` was a no-op (never imported in main).
> - **6.4** Deleted the 6 dead per-file config savers in `configOps.ts` (`saveApp/Appearance/Defaults/Hotkeys/Viewports/SidebarOrderConfig`); kept `saveWorkspaceConfig` (real caller: `board.ipc.ts` `config:save-workspace`).
> - **6.5** Deleted 6 dead exports (`getCanvasPointFromEvent`, `buildMarkdownFileFromEditor`, `findNearestBubble`, `findOptimalBubbles`, `boardNameFromPath`, `isBoardFile`; the now-unused `basename` import in `boardFileOps.ts` was dropped too) + de-exported 2 internal-only (`NANOID_REGEX` in `schemaUtils.ts`, `MEDIA_SNAPSHOT_EXTENSIONS` in `lib/canvas/deleteTileSnapshots.ts`). The documented false-positives (`exportTo*` / `defaultFontSizes` / `cascadeTagToBoardSettings` / `promptBoardExternalEdit`) were verified still-referenced and left intact.
> - **6.6** CLAUDE.md `ci:file-sizes` description: "seven grandfathered files" → "**13** as of Audit-14" + the ratchet-creep note (the intended remedy is to SPLIT, not bump — citing the 6.1 splits).
> - **6.7** KNOWN_LIMITATIONS #5 (self-write suppression — added the Audit-13 M4 content-aware note: a genuine external edit landing IN the window is NOT dropped, only suppressed when the fresh stat still matches the baseline; residual is just the post-window spurious toast) + #6 (minimap — documented the H4 perf split that memoizes `tilesAABB` independent of the viewport, so pan/zoom no longer re-walks the tiles; the residual recompute is confined to an actual tile drag).
>
> No new dedicated unit tests (6.x is refactor / dead-code / docs — the existing suite + svelte-check + the full `ci:verify` cover the splits and removals). **No file-size ceiling bumps.** `git`-verified the 3 new files (`vaultCopy.ipc.ts`, `ipcErrorCode.ts`, `fileWatcherClassify.ts`) are the only new source. Uncommitted (with Phases 1–5). Only Phase 7 (test/CI safety-net) remains.

### 6.1 🟠 [reported] Two main files at exactly the 1000-LOC ceiling
- **Files:** `src/main/services/fileWatcher.ts` (1000), `src/main/ipc/vault.ipc.ts` (1000) — not in `check-file-sizes.mjs` ALLOWLIST.
- **Root cause:** both pass at `loc > LIMIT` today but the next added line trips CI with no headroom — friction exactly where data-safety fixes land (this plan touches `vault.ipc.ts` in 4.x).
- **Fix:** split a cohesive unit out of each (e.g. extract the copy-file/source-approval handlers from `vault.ipc.ts`; extract the reconcile-timer/hash logic from `fileWatcher.ts`) to regain headroom, OR add an explicit allowlist entry with a dated rationale. **Recommendation:** split — adding allowlist entries is what produced the 13–15-file ratchet creep (see 6.6).
- **Verify:** `ci:file-sizes` green with both under 1000.

### 6.2 🟠 [reported, confidence Med] `queueMicrotask` cycle-break silently no-ops external-edit prompts
- **Files:** `src/renderer/stores/vaultExternalChanges.ts` (~L1879), `src/renderer/stores/vaultExternalReconcilers.ts` (~L394).
- **Root cause:** prompt-handler/reconciler registration runs in a `queueMicrotask` guarded by `if (typeof setExternalEditPromptHandler === 'function')` to dodge a real module-eval cycle (`markdownFileWriter`→`documentStore`→…→back). If the binding isn't live when the microtask fires, the guard makes it a **silent** no-op → external-edit prompts never appear (a write could clobber an external edit with no warning).
- **Fix:** (a) add a DEV assertion that the handler is actually a function after the microtask (fail loud in dev if wiring drifts); (b) better — break the import cycle so the registration can be synchronous (extract the shared type/handle into a leaf module both sides import, removing the `markdownFileWriter`→`documentStore` edge). (b) is the durable fix.
- **Verify:** a test that asserts the prompt handler is registered (non-null) after app wiring; if (b), a `madge`-style cycle check or the existing cycle-detection in `core/vaultLifecycle.ts`.

### 6.3 🟠 [reported, confidence Med] `zod` left external in the main bundle
- **File:** `electron.vite.config.mts` (main `externalizeDepsPlugin({ exclude: ['nanoid'] })` L10 — `nanoid` isn't imported in main; `zod` is and stays external).
- **Root cause:** `build.files` doesn't list `node_modules`, so packaging relies on electron-builder 26's new `@electron/node-module-collector` finding `zod`. Should work (npm + lockfiles present), but if the packaged app fails with "Cannot find module 'zod'", this is why.
- **Fix:** change the main exclude to `['zod']` (or `['nanoid','zod']`) so `zod` is bundled into `dist/main`, removing the runtime `node_modules` dependency. zod is tiny.
- **Verify:** `npm run build` then confirm `dist/main/main.js` has no `require("zod")`; ideally a smoke `electron-builder --dir` launch.

### 6.4 🟡 [reported] Dead exported config savers
- **File:** `src/main/vault/configOps.ts` (~L374-400): `saveAppConfig`, `saveAppearanceConfig`, `saveDefaultsConfig`, `saveHotkeysConfig`, `saveViewportsConfig`, `saveSidebarOrderConfig` — zero callers (live path is generic `saveConfig` via `config:save`). `saveWorkspaceConfig` IS used.
- **Fix:** delete the 6 unused functions.

### 6.5 🟡 [reported] Other dead / over-exported symbols
- Confirmed dead (delete): `coordinates.ts:25 getCanvasPointFromEvent`, `markdownSync.ts:587 buildMarkdownFileFromEditor`, `bubblePositions.ts:73/95 findNearestBubble/findOptimalBubbles`, `boardFileOps.ts:122/133 boardNameFromPath/isBoardFile`.
- Over-exported (drop `export`, used only internally): `schemaUtils.ts:114 NANOID_REGEX`, `deleteTileSnapshots.ts:33 MEDIA_SNAPSHOT_EXTENSIONS`.
- **Note:** the `exportTo*` family, `defaultFontSizes` family, `cascadeTagToBoardSettings`, `promptBoardExternalEdit` are **false positives** (dynamic `import()` / barrel / microtask wiring) — do NOT delete.
- **Verify:** `npm run check` + `ci:dead-derived` green after removal.

### 6.6 ⚪ [reported] CLAUDE.md "seven grandfathered files" is stale
- **Fix:** update the `ci:file-sizes` description in `CLAUDE.md` — the allowlist is now ~13–15 entries, each pinned at its current LOC. Note the ratchet-creep trend and that splits (not bumps) are the intended remedy (ties to 6.1).

### 6.7 ⚪ [reported] KNOWN_LIMITATIONS #5 / #6 are stale (better than documented)
- **Fix:** update #5 (self-write suppression now diff-checks the baseline — Audit-13 M4 — so a genuine external edit in-window is NOT dropped) and #6 (minimap caches `tilesAABB`, so it doesn't recompute the whole board each frame). Both currently over-state the risk; correct so a future reader doesn't "re-fix" a handled case.

**Phase 6 exit:** `ci:verify` green (`ci:file-sizes` with 6.1 splits); `npm run build` clean with bundled zod.

---

# Phase 7 — Test & CI safety-net

**Goal:** close the holes that let a regression of the above slip past CI, and cover the highest-consequence flow.

> **STATUS: ✅ DONE 2026-06-08 — 7.1–7.8; `npm run ci:verify` green (exit 0): lint, `check` (815 files, 0 errors), `test:unit:strict` (447 files / 4332 pass / 1 skip), `build`, all 47 gates.**
> - **7.1** New `src/tests/unit/audit14Phase7.test.ts` integration block ties the REAL write lifecycle (`trackComponentWrite` → `beginWrite` → `markDirty`) to the REAL recovery read (`checkRecovery`) through a `.filo/.dirty` sentinel on a mock disk: a never-resolving write arms the sentinel with its path BEFORE it lands; on a simulated relaunch (prior-launchId sentinel, dodging the 1.3 self-suppression) `checkRecovery` surfaces the unsaved path; a completed write `markClean`s the sentinel (no false prompt). This is the cadence-independent unit/integration version the plan prioritised. **The full kill+relaunch Playwright E2E is DEFERRED** — it needs vault-directory control + an abrupt-SIGKILL harness the current `tests/e2e/` suite lacks, and can't be verified in this environment; shipping an unverifiable spec that asserts unconfirmed selectors/infra would break the nightly. The integration test is the verifiable guard.
> - **7.2** `check-no-silent-write-abort.mjs`: the forbidden matcher is now built by `silentAbortRe(varName)` covering `!x` / `!x?.prop` / `!x.prop` / `x === undefined` / `x == null` / yoda, with the abort verb broadened to `return` OR `continue`; the file header + the matcher docstring state plainly it is a TRIPWIRE and the no-`loadDocument` behavioral matrices are the load-bearing guard; `selfTestFixtures()` runs the alternate-shape fixtures on every invocation so weakening a matcher fails the gate on its own fixtures (bite-verified). The markPathFailed same-function scoping for `!fm) return` is preserved.
> - **7.3** Gate narrowing + the matching code fix. `DeleteTaskCommand.undo` (taskCommands.ts) now routes its snapshot-restore through `writeMarkdownAndReconcile({ mode:'full', create:true })` (the task twin of 2.3 — its raw `vault:write-file-text` was the un-reconciled restore the file-level exemption hid); `tileCommands.ts` + `taskCommands.ts` were removed from `RECONCILE_EXEMPT` (neither does a raw `.md` write now). Behavioral test: the two-boards-one-open task case in `audit14Phase7.test.ts` (bite-verified — raw write → editor keeps the stale body; helper → reconciles). Bite-verified the narrowed gate now flags a re-introduced raw write in taskCommands.
> - **7.4** `check-vault-lifecycle-coverage.mjs`: (a) a `RESET_COVERAGE` manifest (5 critical vault-data modules → reset test + token) makes "the reset is actually TESTED" a CI invariant (bite-verified — a broken token fails the gate), closing the "checks subscription, not reset" gap; (b) the `$state`-only scan now also flags a MODULE-LEVEL (column-0, line-anchored) `new SvelteMap(` / `new SvelteSet(` declared without `$state` (`MODULE_LEVEL_REACTIVE_RE`) — per-board/per-pane factories (function-local, indented) are correctly NOT surfaced, so it's green today and a forward-guard for tomorrow (regex bite-verified). **Deviation:** scanned the REACTIVE collections only, not plain `new Map()`/`new Set()` — most module-level plain maps are non-reactive memo caches (the named plain-map vault stores are pinned by the manifest instead), so a plain-Map scan would drown the gate in false-positives.
> - **7.5** New delta-write fuzz block in `frontmatterInvariant.test.ts`: `applyDeltaLikeGateway` mirrors the gateway's delta-on-fresh-read branch, and a fast-check fuzzer (400 runs) over field-edit deltas (keys disjoint from the hostile corpus) asserts every untouched disk key survives value + scalar-BYTES, plus explicit POISON_ROWS for the plan's "untested shape" (a delta-set against an unresolvable alias / `<<` merge keeps the raw block verbatim and refuses the edit — VERIFIED SAFE: `patchFrontmatterSourceCst` returns null on the toJS throw, the assemble keep-raw branch fires). Bite-verified (dropping `applyFrontmatterDelta`'s base spread → red).
> - **7.6** `tests/e2e/app.test.ts`: "open project settings" no longer wraps the body in `if (await isVisible())` (vacuous) — it asserts the entry is visible, opens, asserts the modal, and asserts Escape closes it. "keyboard shortcuts work" now presses the CORRECT combo (Ctrl+Shift+F, the `vault:search` binding — the old test pressed Ctrl+f, which is unbound) and asserts the `.search-panel` appears then closes. (E2E runs nightly; structurally verified against the real bindings/DOM, not executed here.)
> - **7.7** The plan's premise was largely STALE: `fileTagsCascade.svelte.ts` already has a dedicated 570-line suite (`fileTagsCascade.test.ts`) and `boardFrontmatterSync.cascadeDeleteByVaultPath` is covered by the cascade-delete command suites. Only `links.svelte.ts` was a genuine gap. Added: `linksStore.test.ts` (the real gap — filo:// dispatch, board-nav happy + board-not-found toast), `boardFrontmatterSync.test.ts` (a dedicated direct-slice test the module lacked), and `fileTagsCascadeUnit.test.ts` (direct-unit isolation of the three named exports). No redundant tests added to the already-covered integration file. 13 tests, all green.
> - **7.8** `check-ipc-parity.mjs` pins a `MIN_LITERAL_REGISTRATIONS = 30` floor (63 today) so a future `ipcMain.handle(CHANNELS.x, …)` refactor that blinds the literal scan fails loud instead of silently voiding the gate (bite-verified). `check-frontmatter-delta-write.mjs` tightens the orphan forbidden from the over-broad `/\bfrontmatter\s*:/` to the whole-object-write shape `/\bfrontmatter\s*:\s*\{/` (bite-verified — catches `frontmatter: { …baseFm }`, ignores `frontmatterDelta:` + property reads).
>
> Files: 4 new test files (`audit14Phase7`, `linksStore`, `boardFrontmatterSync`, `fileTagsCascadeUnit`) + the delta block in `frontmatterInvariant.test.ts`; 4 gate scripts strengthened; 1 source fix (`taskCommands.ts` DeleteTaskCommand.undo) + its `RECONCILE_EXEMPT` removals. No file-size ceiling bumps. Uncommitted.

### 7.1 🔴 [reported] No E2E for quit-with-pending-write + crash-recovery
- **File:** `tests/e2e/` (the daily-driver specs cover persist/rename but not this).
- **Fix:** add a Playwright spec: seed a board, make an edit that arms a debounced write, kill the app **before** the debounce fires (or while a write is in flight), relaunch, assert the `.filo/.dirty` recovery modal lists the path and the edit is recoverable. This is the single most valuable test for "real data."
- **Note:** full E2E runs only on `main` + nightly (CLAUDE.md), so also add a unit/integration-level version that doesn't depend on the nightly cadence.

### 7.2 🔴 [reported] `check-no-silent-write-abort` is exact-shape regex
- **File:** `scripts/check-no-silent-write-abort.mjs` (~L233-234).
- **Root cause:** matches only `if (!docState) return` / `if (!fm) return`; a refactor to `=== undefined`/`== null`/`!docState?.body`/early `continue`/renamed local slips through. The real protection is the behavioral tests.
- **Fix:** broaden the forbidden set (cover `=== undefined`/`== null`/optional-chained guards) AND, more importantly, ensure the behavioral matrices (the no-`loadDocument` cases) are the load-bearing guard — add a note in the script that it's a tripwire, and add any missing behavioral case. Don't pretend the regex is complete.
- **Verify:** add a fixture for each alternate shape; bite-check.

### 7.3 🟠 [reported] `check-md-writers-reconcile-editors` whole-file exemption hides 2.3
- **File:** `scripts/check-md-writers-reconcile-editors.mjs` (`RECONCILE_EXEMPT` ~L76-77).
- **Root cause:** exempts all of `tileCommands.ts`/`taskCommands.ts` ("editor mounts afterward"), which fails for `DeleteTilesCommand.undo`'s restore write when the file is open on a second board.
- **Fix:** narrow the exemption from file-level to the specific add/create sites; require the restore/undo write paths to reconcile (pairs with the 2.3 code fix). Add the two-boards-one-open test.
- **Verify:** bite-check — the 2.3 code fix present → green; reverted → red.

### 7.4 🟠 [reported] `check-vault-lifecycle-coverage` checks subscription, not reset
- **File:** `scripts/check-vault-lifecycle-coverage.mjs` (~L114).
- **Root cause:** passes if `onVaultSwap(` appears anywhere; never inspects the callback body, and is blind to vault-scoped data held in module-level `Map`/`SvelteMap` (no `$state`).
- **Fix:** this is hard to make airtight statically; the pragmatic improvement is (a) require each vault-scoped module to have a per-module reset unit test (add a coverage manifest the gate checks), and (b) widen the `$state(` token to also flag module-level `new Map()/new SvelteMap()` so unmanaged vault-scoped collections are surfaced. Document that the unit tests are the real guard.
- **Verify:** add reset tests for any module the widened scan surfaces.

### 7.5 🟠 [reported] Phase-4 delta write path not in the fuzz corpus
- **File:** `tests/unit/.../frontmatterInvariant.test.ts` (fuzzes tag-ops + body-save only).
- **Fix:** add a fast-check fuzzer over `frontmatterDelta` set/unset ops applied to a **fresh disk read** across the hostile corpus (CRLF/BOM/anchors/`<<` merge/comments/empty keys), asserting untouched keys survive byte-for-byte. Include the untested shape: delta-set of a key whose disk value is an unresolvable alias or `<<` merge.
- **Verify:** bite-check by temporarily reverting the delta-on-fresh-read logic.

### 7.6 🟠 [reported] Weak E2E assertions
- **File:** `tests/e2e/app.test.ts` (L84 "keyboard shortcuts work" asserts nothing; L65 "open project settings" gated by `if (isVisible())` → vacuous).
- **Fix:** add real assertions (e.g. Ctrl+F opens the search UI; assert an element appears). Remove the `if (isVisible())` guard or `expect` the button exists first.

### 7.7 🟡 [reported] Thinly-exercised stores
- `fileTagsCascade.svelte.ts` (vault-wide tag rewrite — a data-loss surface) only touched by the swap-guard test; `boardFrontmatterSync.ts` only by the cover-image test; `links.svelte.ts` (filo:// rewrite on rename) no dedicated test.
- **Fix:** add focused unit tests (happy path + failure path) for each.

### 7.8 🟡 [reported] Latent gate fragilities
- `check-ipc-parity.mjs` (~L58): matches only string-literal channels — sound today (all 49 registrations are literals) but a future `ipcMain.handle(CHANNELS.x, …)` refactor would make channels invisible. Add a guard that the literal-registration count is non-trivially > 0.
- `check-frontmatter-delta-write.mjs` (~L181-183): the orphan-scope `forbidden: /\bfrontmatter\s*:/` is broad enough to false-positive a future benign `frontmatter:` key. Tighten to the whole-object-write shape.

**Phase 7 exit:** `ci:verify` green with the broadened gates; 7.1 + 7.5 added.

---

# Appendix A — Verified sound (do NOT "fix")

The audit confirmed these are correct; changing them risks regressions:
- Frontmatter CST engine byte-fidelity (ambiguous scalars `yes`/`null`/`123`/`---`, empty keys, inline comments, delete-last-key, anchors→safe-refuse→dump).
- Per-path `.md` write serialization (`writeChainByPath`) + the Audit-13 M3 generation guard for the *board/config/misc* late-success heal.
- The AUDIT13 H3 vault-swap reorder + `revertToOutgoingVault` (no config-from-A / data-from-B split).
- IPC path containment: Windows ADS, reserved DOS names, trailing dots/spaces, UNC, symlink realpath checks, the `filo://` Range parser (0-byte/finite/clamped/single-range), copy-source byte cap.
- Modal/popup focus-trap + restore, Escape stacking, `prefers-reduced-motion` (CSS reset + JS camera RAF cancel), Toast live-regions, ARIA roles.
- Escape-hatch discipline: only 3 `as any` in non-test source (all justified), zero `@ts-ignore`.

# Appendix B — Non-issues confirmed

- `recoverySnapshot.ts:231/302` `fs.rmdir` on **empty** dirs — valid in Node 24 (only file/recursive `rmdir` was deprecated). Don't "modernize" reflexively.

# Appendix C — Sequencing / commit guidance

- The whole Audit-7→12 tree was committed together (`a7528a2`); Audit-13 is on this branch (`4669363` etc.). Commit each phase separately for bisectability, `ci:verify` green per commit.
- **Minimum bar before dogfooding on OneDrive / multi-board / split-pane:** Phase 1 (esp. 1.1, 1.2, 1.3) + 5.1. Everything else can follow incrementally.
- Branch already passes `check`/`build`/`test:unit`; no Electron-42-blocking work — 6.3 is the only upgrade-related item and it's packaging robustness, not a runtime break.

---

*Generated from the 2026-06-07 broad audit (9 agents + maintainer verification). Findings tagged `[VERIFIED]` were independently confirmed by reading the code; `[reported]` findings carry the auditing agent's evidence and stated confidence. Line numbers are as of branch `chore/electron-42` and may drift — anchor on the named symbol/function.*

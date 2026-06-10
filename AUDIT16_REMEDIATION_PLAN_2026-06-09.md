# AUDIT-16 REMEDIATION PLAN — 2026-06-09

## Context

Audit-16 was a fresh-eyes, 9-agent adversarial audit of the **uncommitted working tree** on
`chore/electron-42` (Task List audit remediation + Audit-14 + Audit-15 + Electron 33→42), run
2026-06-09 with explicit instructions to ignore prior plans and hunt for new issues. Six finder
agents produced **38 candidate findings**; the verifier agents were lost to a session limit, so
the **top 7 findings were manually verified line-by-line in source** (marked ✅ VERIFIED below).
The rest are marked ⚠️ UNVERIFIED — each must be **confirmed or refuted before fixing** (see
Verification Protocol). Three findings were discovered independently by two agents each
(1.2, 2.1, 3.5) — strong corroboration.

**Headline:** one CRITICAL everyday-flow data-loss bug (task notes silently lost on the second
edit), six HIGH issues. **No architectural refactor is needed** — every verified issue is a
localized logic error. The recurring weak seam is the frontmatter scheduler's **implicit
version-token contract** (the mutation-version guard assumes every disk-bound mutation bumps the
version; body mutations don't), which Phase 1 closes structurally.

**Severity counts (35 unique issues):** 1 critical, 6 high, 11 medium, 17 low.

### Ordering rationale

1. **Phase 1** — the two silent data-loss bugs in the everyday Task List / Kanban flow (one file).
2. **Phase 2** — undo/redo corruption (writes wrong state to disk via Ctrl+Z).
3. **Phase 3** — cross-vault contamination races (worst blast radius per occurrence).
4. **Phase 4** — write-tracking / recovery honesty (failure masking, phantom recovery prompts).
5. **Phase 5** — frontmatter byte-preservation edge cases (exotic/external YAML).
6. **Phase 6** — UI/UX, lifecycle and error-surface polish (LOWs).
7. **Phase 7** — anti-regression gates + test matrix for everything above.

Run `npm run ci:verify` after each phase. Prefer splitting files over bumping `ci:file-sizes`
ceilings. Each phase leaves the tree working and committable.

### Verification Protocol (for ⚠️ UNVERIFIED items)

Before writing a fix: (a) read the cited lines and re-trace the mechanism; (b) write the failing
unit test FIRST where feasible (the repro in the `trigger` is the test sketch); (c) if the
mechanism doesn't hold, record the refutation in this file (strikethrough + reason) instead of
fixing — do NOT fix what isn't broken. Findings refuted during remediation must be listed in the
phase summary so a future audit doesn't re-raise them.

---

## Phase 1 — CRITICAL: silent data loss in the frontmatter scheduler (everyday flow)

### 1.1 ✅ VERIFIED · CRITICAL — Task notes body edits silently dropped by the version-token guard

- **File:** `src/renderer/lib/boards/frontmatterWriteScheduler.ts` L269-270 (guard) +
  `src/renderer/lib/tasklist/frontmatterWriter.ts` L313-393 (`setNotesBody`) +
  `src/renderer/stores/document.svelte.ts` (`updateContent` L444 — no version bump)
- **Mechanism (traced end-to-end):** the stale-write guard
  `if (!delta && scheduledVersion > 0 && scheduledVersion <= last) return;` compares the doc's
  frontmatter **mutation version**, which is bumped ONLY by `setFrontmatter` / `mergeFrontmatter`
  / `applyReloadFromDisk`. `documentStore.updateContent` (the task-notes body mutation) does NOT
  bump it, and `seedDocumentFrontmatterFromDisk` early-returns at its L80 cache-present guard on
  every call after the first. Task notes schedule with **no delta**. So: first notes edit on a
  fresh task writes (the placeholder seed bumped the version); **every subsequent notes edit — or
  any first notes edit after a field toggle already flushed at that version — fires with
  `scheduledVersion <= lastFlushedVersion`, bare-returns, resolves as SUCCESS → `endWrite(true)`
  → `markClean` wipes `.filo/.dirty`**. The note exists only in `documentStore` (board JSON never
  caches the body) and dies on quit. A later field edit on the same task incidentally rescues the
  body (delta writes read `docState.body` live), making the loss intermittent.
- **Trigger/repro:** Task List → expand a task's notes → type → wait 300 ms (lands) → edit the
  note again → quit → relaunch: second edit gone, no recovery prompt. Variant: toggle the
  checkbox first, then add a note — the FIRST note edit is dropped.
- **Fix:** make the version token cover the body. Add a per-doc **body mutation counter** in
  `documentStore.updateContent` (bump alongside a new `getBodyMutationVersion(docId)`), and fold
  it into the scheduler's token: `scheduledVersion = fmVersion + bodyVersion` is NOT safe
  (independent counters can mask each other) — instead bump the SAME `mutationVersions` map from
  `updateContent` (a body change makes the cached flush stale in exactly the way an FM change
  does; the guard's comment already reasons about "older body content"). Alternative (smaller
  blast radius): thread `bodyDirty: boolean` through `FrontmatterWriteArgs` — set by
  `setNotesBody`'s `getArgs` closure when `updateContent` ran since the last flush — and bypass
  the skip the way `delta` already does. Prefer the single-counter fix: it closes the CLASS
  (any future delta-less body caller), not just this caller.
- **Watch out:** bumping the shared counter from `updateContent` affects
  `lastFlushedVersion` bookkeeping in the gateway (`noteFrontmatterFlushedVersion`) — audit both
  consumers; also fix 4.3 (post-write version capture) in the same pass since both touch the same
  bookkeeping.
- **Tests:** unit — two sequential `setNotesBody` calls, assert the second write reaches the
  gateway (the audit confirmed NO existing test exercises a second sequential `setNotesBody`);
  field-toggle-then-notes ordering; notes edit during in-flight write. Add to the Phase 7 gate.

### 1.2 ✅ VERIFIED · HIGH — Field edits on a read-only (lossy round-trip) doc silently dropped as SUCCESS

- **File:** `src/renderer/lib/boards/frontmatterWriteScheduler.ts` L242-248
  (`if (docId && documentStore.isReadOnly(docId)) return;`)
- **Found independently by two agents.**
- **Mechanism:** a doc whose body fails the tiptap lossy round-trip check at editor load is
  flagged read-only. Only TextTile/DocumentEditor render that flag — Kanban card / Task row field
  controls do NOT check it (grep: no `isReadOnly` reference in `commands/` or board components).
  A completed/priority/dueDate edit merges into the FM display cache (UI updates), accumulates a
  `pendingDeltas` entry, arms the scheduler — and at fire time the L248 bare return resolves
  `performWrite` as SUCCESS → sentinel cleaned, indicator "saved". The delta is "deliberately
  LEFT in place for a later takeOwnership" but **nothing ever re-fires it** (quit-flush drains
  timers, not orphaned deltas; `resetFrontmatterScheduler` clears `pendingDeltas`). Exact
  B1/A9-L3 loss shape via a return token `ci:no-silent-write-abort` doesn't police.
- **Note the policy contradiction (proves the guard wrong):** the tag writer
  (`fileTags.svelte.ts` L374) deliberately DOES write frontmatter on read-only docs
  ("frontmatter round-trips cleanly even when the body doesn't") and toasts; the Properties popup
  writes through the gateway with no isReadOnly check. Only this path drops.
- **Fix (preferred — option a):** the read-only flag protects the BODY, not the FM. Let the
  **delta path proceed** for read-only docs, sourcing the body from the fresh disk read (the
  `!docState` branch at L319-343 already does exactly this) instead of `docState.body` — i.e.
  move the isReadOnly check to only force the disk-body branch, never to return. For the legacy
  (delta-less) path on a read-only doc, keep refusing but make it LOUD:
  `markPathFailed(vaultRoot, relPath); throw` + a toast mirroring
  `surfaceReadOnlyTagToastIfNeeded`.
- **Defense in depth:** gate the Kanban/Task field UI on `isReadOnly` (disable the controls with
  a tooltip), so the user isn't editing into a void even before the write path is reached.
- **Tests:** unit — read-only docId + pending delta → write lands with disk body preserved
  byte-for-byte (round-trip the lossy body); read-only + no delta → flushAll().failed contains
  the path. Gate arm in Phase 7.

---

## Phase 2 — Undo/redo corruption

### 2.1 ✅ VERIFIED · HIGH — `rollbackExecute` resolves the stack via `getActiveStack()` (Audit-14 2.1 fix missed execute())

- **File:** `src/renderer/stores/history.svelte.ts` L347-348 (`rollbackExecute` →
  `getActiveStack()`); contrast `rollbackUndo` L378/385 + `rollbackRedo` L409/413 which take
  `originBoardId` and use `getStackFor(originBoardId)`; `execute()` ~L497-503 never captures it.
- **Found independently by two agents.**
- **Mechanism:** `execute()` synchronously pushes the command onto the CURRENT board's stack,
  then runs the (possibly async) body. Async bodies that can reject exist:
  `UpdateOrphanFrontmatterCommand` (rethrows on write failure, A9-L2), `AddTaskCommand`
  (seedBackingFile rethrows), `BatchCommand` (rethrows after child rollback). If the user
  switches tabs during the awaited body and it rejects, `rollbackExecute` searches the WRONG
  board's stack — `lastIndexOf` misses, the redoStack identity check fails, nothing is rolled
  back. The never-applied command stays on the origin board's undo stack; a later Ctrl+Z replays
  its inverse (stale full-slice snapshots clobber interval edits) and the debounced writer
  persists the corruption. Also `markDirty`s the wrong board.
- **Fix:** mirror Audit-14 2.1 exactly: capture `const originBoardId = activeBoardId;` in
  `execute()` before `commitExecute`, pass it to `rollbackExecute`, resolve
  `getStackFor(originBoardId)`; mark dirty via `command.targetBoardId || originBoardId`.
- **Tests:** unit — async command body rejects after `activeBoardId` flips; assert the command is
  removed from the ORIGIN stack and the origin board (not the new board) is marked dirty. Mirror
  the existing 2.1 rollbackUndo test shape.

### 2.2 ✅ VERIFIED · HIGH — `DeleteSectionCommand.undo` appends the restored section LAST, stealing a tied sibling's slice (introduced by the uncommitted Task List remediation)

- **File:** `src/renderer/commands/sectionCommands.ts` L206-225 (undo: marker appended after
  `shiftedSections`); semantics in `src/renderer/stores/boardCacheTaskList.ts` L131 + L328
  ("among tied sections the LAST in array order owns the slice; callers must list empty ties
  BEFORE the populated owner").
- **Mechanism:** for an empty section A tied at position p with populated owner B (canonical
  array order `[A, B]`), delete-A then undo yields `nextSections = [B(p), A(p)]` — block.length
  is 0 so no positions shift, and A is appended LAST. The stable sort preserves that order, so A
  now owns `[p, next)`: **every one of B's tasks silently re-homes into the restored "empty"
  section**, persisted to `.board.json`. Compounds with later add-to-section ops.
- **Trigger:** Task List → move/delete all of a section's tasks (it now ties with the next
  section) → delete the empty section → Ctrl+Z.
- **Fix:** capture the removed section's **array index** (or successor section id) at
  construction time and `splice` the marker back at that index instead of appending — mirroring
  the `beforeTileId` anchor pattern `DeleteCardCommand` gained in Audit-14 2.2. Both
  `execute`-then-`undo` and `redo`-then-`undo` cycles must restore the original array order.
- **Tests:** round-trip — `[emptyA(p), populatedB(p)]` → delete A → undo → assert array order
  `[A, B]` restored AND `sectionedView` puts B's tasks back in B. Add the tie case to
  `boardCacheTaskList.test.ts`'s matrix. This command is covered by
  `ci:command-roundtrip-coverage` — the existing round-trip evidently never used a tied layout,
  so extend it rather than adding a parallel test.

### 2.3 ⚠️ UNVERIFIED · MEDIUM — `persistAddTaskPlacement` with a stale/missing `targetSectionId` shifts NO section boundaries (SEC-1 rewrite regression)

- **File:** `src/renderer/stores/boardCacheTaskList.ts` (SEC-1 branch:
  `targetArrayIdx >= 0 && arrayIdx > targetArrayIdx ? bump : s`)
- **Mechanism:** the rewrite resolves the target section by `findIndex` and bumps only sections
  AFTER it in array order. On a miss (`findIndex → -1`) the condition is false for EVERY section
  — nothing shifts — but the task was already spliced into `tasks[]` and renumbered. The OLD code
  degraded gracefully (numeric `position >= insertAt` bump). Now every section whose slice starts
  at/after `insertAt` is off by one, transitively.
- **Trigger:** add-to-section racing a section removal (undo of a task delete landing after an
  external board reload removed the section id; quick-add targeted at a just-deleted section).
- **Fix:** on `targetArrayIdx < 0`, fall back to the legacy numeric shift
  (`s.position >= insertAt ? {...s, position: s.position + 1} : s`) and `console.warn` the
  unresolved id.
- **Tests:** unit — add with a bogus `targetSectionId`; assert later sections shift by one and
  membership of every existing section is unchanged.

### 2.4 ⚠️ UNVERIFIED · MEDIUM — `historyStore.clearBoard` bypasses the `mutateStack` file-snapshot scan for the closed board's OWN stack

- **File:** `src/renderer/stores/history.svelte.ts` L713-725 (`delete stacks[boardId]` raw,
  then the Audit-14 2.4 `mutateStack` sweep of SIBLING stacks only)
- **Mechanism:** the module's documented invariant (mutateStack docstring L213-234) requires
  every command-dropping path to route through `mutateStack` so dropped `fileSnapshots`
  (CascadeDeleteCommand / DeleteTilesCommand — the only in-memory copy of a deleted `.md` body)
  fire the escalated "deleted files older than this point cannot be restored" toast. Audit-14 2.4
  fixed the cross-stack sweep but `clearBoard`'s first line still raw-deletes the target board's
  own stack. `tabStore.close`/`closeOthers` call `clearBoard` when the last tab for a board
  closes — the most common stack-discard path loses snapshots silently.
- **Trigger:** Mind Map → delete a text tile with "Delete with files" → close the board's tab
  without undoing.
- **Fix:** route the own-stack drop through
  `mutateStack(stack, boardId, s => { s.undoStack = []; s.redoStack = []; })`, then delete the
  empty record. Optionally gate tab close behind the same confirm when `lostFile` is true.
- **Tests:** unit — stack holding a command with `fileSnapshots` → `clearBoard` → assert the
  escalation path fired (toast spy / mutateStack hook).

### 2.5 ⚠️ UNVERIFIED · MEDIUM — `chainInflightDepth` underflows on a Don't-Save vault swap, permanently deferring every later command body

- **File:** `src/renderer/stores/history.svelte.ts` L166-199 (`runChained`), L781-785
  (pre-swap handler: `pendingChain = Promise.resolve(); chainInflightDepth = 0;`)
- **Mechanism:** an async command body still in flight at swap time (the Don't-Save branch never
  awaits `whenChainSettled()`) has its settle handler fire AFTER the unconditional reset,
  decrementing depth to -1. `chainInflightDepth === 0` is then never true again: every subsequent
  command body in the new vault — including purely synchronous ones — defers to a microtask,
  silently inverting the documented "sync body runs synchronously" contract for the rest of the
  session (each deferred op's own settle re-decrements to -1).
- **Fix:** underflow-proof the decrement (`chainInflightDepth = Math.max(0, depth - 1)`) AND/OR
  guard settle handlers with a generation token bumped by the pre-swap reset (prefer the token —
  it's exact; the clamp alone can still skew transiently with two in-flight bodies).
- **Tests:** unit — in-flight async body + pre-swap reset + body settles → assert depth is 0 and
  the next execute runs its body synchronously.

---

## Phase 3 — Cross-vault contamination & lifecycle races

### 3.1 ✅ VERIFIED · HIGH — `notifyRenderers` has no `aborted` re-check after `await correlateRenames`, so a late outgoing-vault rename event can drive the rename cascade against the NEW vault

- **File:** `src/main/services/fileWatcher.ts` — `aborted` check at L734 (top of
  notifyRenderers), `await correlateRenames(...)` L832 (real `fs` hash probes, hundreds of ms on
  slow volumes), then `webContents.send('vault:files-changed'/'vault:file-renamed'/
  'vault:tree-updated')` L863-874 with NO re-check. `stop()` (L434+) awaits
  `reconcileInFlightPromise` but never tracks the in-flight notify.
- **Mechanism:** during the hash-probe window the renderer swaps vaults (vault:close awaits
  stop(), candidate load, commit). The late send lands after `commitVaultCandidate`; the
  renderer's `enqueueRenameQueueWork` captures vault identity at ENQUEUE (arrival) time — after
  the commit — so the identity guard passes and `handleExternalRename(oldA, newA)` runs
  `renameAllPathKeys` / `renameBoardPath` / `propagateRename` / `fileTagsStore.renameFile` +
  `flushAllDirty` against vault B. If B has a same-relative-path file (Notes.md, README.md),
  persistent cross-vault corruption with no undo.
- **Fix:** (a) `if (this.aborted) return;` immediately after the `await correlateRenames(...)`
  line (and after any other await in the function); (b) track the in-flight notify promise (like
  `reconcileInFlightPromise`) and await it in `stop()`. Both — (a) is the correctness fix, (b)
  removes the window entirely.
- **Tests:** unit (main-side, mock fs) — slow `correlateRenames` resolved after `stop()`;
  assert zero `webContents.send` calls.

### 3.2 ⚠️ UNVERIFIED · HIGH — Recovery-sequencer tag-rewrite confirm `onCancel` runs unguarded post-await side effects; auto-cancelled by a vault swap it can prune EVERY fileTags entry in the NEW vault

- **File:** `src/renderer/stores/vault.svelte.ts` ~L803-812 (`runRecoverySequencer` step 2
  onCancel); `ui.svelte.ts` ~L499-503 (pre-swap handler fires parked confirms' onCancel
  fire-and-forget); `tagsStorage.ts` ~L537-556 (`pruneFileTagsAgainstKnownPaths`).
- **Mechanism:** the onCancel is async: optionally `await convergeForward()` (vault-wide sweep,
  seconds), `await clearPendingRewrite(newVaultPath)` (swallows failure), then synchronously
  `flattenTreePaths(fileTree, newVaultPath)` + `fileTagsStore.pruneOrphanFileTags(flat)`. Unlike
  step 3 (which threads `captured` per VS-1) there is NO `isStillSameVault` check. If the awaits
  straddle `commitVaultCandidate`, `fileTree` is vault B's tree and `newVaultPath` is vault A's
  root → `flattenTreePaths` returns the EMPTY set (no node startsWith A's root) →
  `pruneFileTagsAgainstKnownPaths` drops EVERY `fileTags` entry and `scheduleSave()`s the emptied
  registry into vault B's `.filo/tags.json`. Attachment tags are vault-local — unrecoverable.
- **Trigger:** vault A has a pending `.filo/tag-rewrite-pending.json` (partial progress); on open
  the confirm appears; instead of answering, the user opens vault B (the natural "wrong vault"
  flow); the pre-swap handler auto-cancels.
- **Fix:** inside step 2's onConfirm AND onCancel: `const captured = ...` (the sequencer already
  has it); `if (!isStillSameVault(captured)) return;` after EVERY await; compute the prune list
  from the candidate-captured tree (mirror DI-03's use of `candidate.tree`, never live
  `fileTree`). This puts the function under the existing `ci:reconciler-vault-guard` Part 1 scan
  if the trigger patterns match — check, and if not, add it to Part 3's pinned list (Phase 7).
- **Tests:** unit — parked step-2 confirm cancelled mid-`convergeForward` while the vault
  identity flips; assert `pruneOrphanFileTags` is NOT called (or called with the captured tree).

### 3.3 ✅ VERIFIED · MEDIUM-HIGH — Audit-14 1.3 LAUNCH_ID suppression swallows the Recovery prompt on a same-session vault reopen (Don't-Save / failed-write breadcrumb destroyed)

- **File:** `src/renderer/lib/vault/dirtyFlagRecovery.ts` L41 (`LAUNCH_ID = createId()` —
  process-lifetime), L157 (markDirty stamps it on EVERY sentinel), L314
  (`parsed.launchId === LAUNCH_ID → needsRecovery: false`).
- **Found independently by two agents.**
- **Mechanism:** the Don't-Save branch deliberately PRESERVES `.filo/.dirty` so "reopening the
  outgoing vault surfaces the Recovery modal" (documented contract, vault.svelte.ts ~L1066-1071).
  But that sentinel was written by THIS process → same-session reopen (A→B→A, or close→Home→
  reopen) hits the L314 suppression → no modal, no toast. The first clean write cycle in the
  reopened vault then markDirty/markCleans the breadcrumb away permanently — even a later app
  restart won't prompt. Same suppression hits a sentinel left by a FAILED write before a
  same-session reopen. The 1.3 fix targeted migration-repair writes during the CURRENT open but
  suppresses by PROCESS, over-matching every preserved sentinel from earlier in the session.
- **Fix:** scope the suppression to the current **vault open**, not the process: stamp the
  sentinel payload with `{ launchId, vaultGeneration }` (generation from `vaultIdentity`'s
  `beginVaultGeneration`) and suppress only when BOTH match the current open. Alternative: in the
  pre-swap Don't-Save preserve path, rewrite the sentinel stripping/rotating the launchId so a
  preserved breadcrumb never matches. Prefer the generation stamp — it also covers the
  failed-write case with no special-casing.
- **Tests:** unit — markDirty in open #1 → simulate swap-away preserving the sentinel →
  beginVaultGeneration → checkRecovery → assert `needsRecovery: true`; migration-repair write in
  the SAME open still suppressed (the original 1.3 test must stay green).

### 3.4 ⚠️ UNVERIFIED · MEDIUM — A parked fire survives vault-swap `reset()`: its missing-source settle runs `endWrite(false)` against fresh tracking state, polluting the new vault's failed-path set and `.dirty` sentinel with a foreign path

- **File:** `src/renderer/lib/boards/writeScheduler.ts` — `reset()` ~L1072-1098 (clears `parked`
  but the dangling closure proceeds); `fireFromTimer` missing-source path ~L699-715 (calls
  `safeEndWrite({oldVaultRoot, oldPath}, false)` directly, with NO `trackerIsCurrent` guard —
  reset()'s own comment claims the settle guard covers dangling parked closures, but this path
  never reaches `fireWrite`).
- **Mechanism:** timer parks behind an in-flight write → vault swap runs
  `cancelAllPendingWrites` + `resetWriteTracking` → old write settles, dangling parked closure
  resumes, `getArgs` → null (cache cleared) → `endWrite(oldVaultRoot, oldPath, false)` against
  the FRESH state: `failedVaultPaths.add(oldPath)` (new session), and at inflight 0 a
  `markDirty(oldVaultRoot, …)` (main-side rejected, but the in-memory pollution stays). Every
  subsequent sentinel refresh in the NEW vault then writes the union — including the old vault's
  path — into the NEW vault's `.filo/.dirty`. Ctrl+S reports failure all session; phantom
  recovery modal next launch.
- **Trigger:** edit on a slow volume → debounce fire parks → File > Open Vault → "Don't Save"
  (skips the drain) → old write settles after the new vault opens.
- **Fix:** give the parked IIFE a captured scheduler-generation (bumped in `reset()`); after
  `drainPriorInFlight`, bail without firing or calling `safeEndWrite` when the generation moved.
  Alternatively route the missing-source settle through the same `trackerIsCurrent` guard
  `fireWrite`'s settle uses. Coordinate with 4.4 (cancel-vs-parked) — one cancelled/generation
  token mechanism should solve both.
- **Tests:** unit — park a fire (use the existing Audit-15 P1.1 `__parkForTests` hook), `reset()`,
  settle the old write; assert `failedVaultPaths` empty and no `markDirty` fired.

### 3.5 ⚠️ UNVERIFIED · LOW — `swapInProgress` is a single module slot cleared unconditionally in `finally`; a second concurrent openVault's window can be nulled by the first swap's completion

- **File:** `src/renderer/stores/vault.svelte.ts` openVault finally
  (`if (hadOutgoingVault) { swapInProgress = null; resolveSwapWindow(); }` ~L1180; same shape in
  closeVault).
- **Mechanism:** openVault has no re-entrancy latch; double-firing vault opens (two clicks on
  recents) lets the first swap's finally null the SECOND swap's promise. A quit's `save()` then
  sees `swapInProgress === null` and drains inside the second swap's registry-null window — the
  exact fail-closed hole Audit-14 1.8 closed, reintroduced under concurrency.
- **Fix:** capture locally and clear only if still owner
  (`if (swapInProgress === myPromise) swapInProgress = null;`) — two lines; optionally add an
  explicit re-entrancy latch to openVault/closeVault (queue or reject the second call).
- **Tests:** unit — two interleaved openVault calls; assert the second's window survives the
  first's finally.

### 3.6 ⚠️ UNVERIFIED · LOW — `refreshTreeAndCleanup` evicts boards using a possibly-stale fileTree (failed read-tree or create-vs-read TOCTOU) — cancels pending writes and closes tabs for a live board

- **File:** `src/renderer/stores/vault.svelte.ts` ~L1508-1518 (`refreshTreeAndCleanup`),
  ~L1398-1413 (refreshTree leaves fileTree untouched on envelope failure and returns void —
  caller can't tell).
- **Mechanism:** missing-board walk evicts any `boardStore.paths` entry absent from
  `flattenTreePaths(fileTree)`. Stale shapes: (a) the read failed while paths gained a board
  created after the last good read; (b) the read-tree IPC enumerated BEFORE a concurrent
  `board:create` landed but applied after. Eviction = `removeBoardFromCache` (cancels pending
  debounced writes) + closes its tabs → recent edits silently lost (file on disk keeps older
  state).
- **Fix:** have `refreshTree` return a success boolean (or stamp a tree-generation) and skip the
  eviction walk on failure/stale; before evicting, confirm each candidate with a direct
  `vault:file-exists` stat (mirrors `handleExternalAttachmentChanges`' re-existence probe).
- **Tests:** unit — failed refreshTree → no eviction; board created mid-reconcile survives.

### 3.7 ⚠️ UNVERIFIED · LOW — The external-change renderer bridge is owned by VaultSidebar's mount lifecycle; a docked↔floating toggle drops watcher events delivered in the unmount/remount gap

- **File:** `src/renderer/components/sidebar/VaultSidebar.svelte` ~L280-285 ($effect calling
  `vaultStore.listenForChanges`); `AppShell.svelte` ~L558-599 (mutually exclusive `{#if}`
  branches on `uiStore.sidebarFloating`).
- **Mechanism:** flipping float/dock destroys one instance (unsubscribing every watcher listener,
  discarding a mid-debounce tree reconcile) and mounts the other. Events in the gap are dropped;
  a dropped `vault:file-renamed` is worst (the cascade never runs; the later reconcile sees
  delete+create and can evict the board as missing).
- **Fix:** hoist the `listenForChanges` subscription out of the component — register from
  App.svelte (app-lifetime), keyed on `vaultStore.isOpen`. (Cleanest; also removes a whole class
  of "UI layout change tears down data plumbing".)
- **Tests:** component/unit — toggle `sidebarFloating`; assert the watcher subscription object
  identity is unchanged (or events during the toggle are delivered).

---

## Phase 4 — Write-tracking & recovery honesty

### 4.1 ✅ VERIFIED · HIGH — Audit-14 1.6 write-generation prune re-opens the M3 late-success collision (writeScheduler)

- **File:** `src/renderer/lib/boards/writeScheduler.ts` L617-629 (success-path
  `writeGenByPath.delete`) vs the late-heal guard L546
  (`writeGenByPath.get(healKey) !== healGen → return`), gen mint L479 (`(get ?? 0) + 1`).
- **Mechanism:** write A (gen 1) overruns `writeTimeoutMs` → markPathFailed, healGen=1 captured.
  Write B (gen 2) succeeds → prune deletes the path's gen entry. Write C fires → gen restarts at
  **1**. C times out → legitimate failed mark. A's IPC finally lands → heal guard reads gen 1 ===
  healGen 1 (a COLLISION, not currency) → `clearFailedPathAfterLateSuccess` erases C's mark: save
  indicator clean, sentinel wiped, quit proceeds, **C's payload never reached disk, no recovery
  prompt**.
- **Fix:** make generations collision-proof: mint from a single module-level **monotonic
  counter** that never resets within a session (`writeGenByPath` then stores "latest gen for
  path" purely for the currency compare; pruning the entry is fine if the counter itself never
  reuses values — the heal guard must then treat a MISSING entry as "not current" for a non-zero
  healGen). Keep the Audit-13 M3 `reset()` clear (cross-vault healing stays dead because the
  counter keeps climbing).
- **Tests:** unit — the A(timeout)/B(success)/C(timeout)/A(late-success) interleaving; assert C's
  failed mark survives. The existing `__writeGenSizeForTests` boundedness test must stay green.

### 4.2 ⚠️ UNVERIFIED · MEDIUM — Same collision hole in `componentWriteGenByPath` (writeStateTracking, Audit-14 1.5)

- **File:** `src/renderer/lib/boards/writeStateTracking.ts` ~L521-539 (endWrite success branch
  deletes the gen entry) + `bumpComponentWriteGen`.
- **Mechanism:** mirror of 4.1 for direct `.md` component writers. The markdown gateway is
  per-path chained (DI-09) so overlap is hard there, but non-gateway `writeMarkdownAndReconcile`
  callers (fileTags fast-path, rename-cascade recreates, ReplaceAll, DeleteTaskCommand.undo
  restore) wrap `trackComponentWrite` around raw IPC with NO per-path chain — two writers can
  overlap on one path.
- **Fix:** same monotonic-counter approach as 4.1 — implement both in one pass with one shared
  helper if practical.
- **Tests:** unit — overlapping trackComponentWrite calls with the 4.1 interleaving.

### 4.3 ⚠️ UNVERIFIED · MEDIUM — `lastFlushedVersion` is bumped to the POST-write mutation version, marking an FM mutation that landed mid-IPC as flushed

- **File:** `src/renderer/lib/boards/frontmatterWriteScheduler.ts` L370-372
  (`lastFlushedVersion.set(docId, Math.max(last, currentVersion))` with `currentVersion` read
  AFTER the await) + `src/renderer/lib/vault/markdownFileWriter.ts` ~L931-934
  (`noteFrontmatterFlushedVersion(docId, getFrontmatterMutationVersion(docId))` post-IPC).
- **Mechanism:** the FM actually assembled was captured BEFORE the IPC. A
  `mergeFrontmatter`/`setFrontmatter` landing during the multi-hundred-ms await has its version
  N+1 recorded as flushed while version N's bytes landed. Any subsequent NO-delta scheduled write
  then short-circuits on `scheduledVersion <= last` and the mutation never reaches disk.
  Amplifies 1.1; the gateway's DI-17 comment reasons only about the safe direction.
- **Fix:** capture the mutation version at the moment the FM object is read for assembly (thread
  it through `WriteArgs` / `writeFrontmatter` locals) and bump `lastFlushedVersion` to THAT
  value. **Do together with 1.1** — same bookkeeping, one test matrix.
- **Tests:** unit — mergeFrontmatter lands during a stalled write IPC; assert the follow-up
  scheduled write is NOT skipped.

### 4.4 ⚠️ UNVERIFIED · MEDIUM — `cancel()` cannot reach a PARKED fire: deleting a board mid-park yields a false "couldn't save" error, a permanent failed mark, and a phantom recovery prompt

- **File:** `src/renderer/lib/boards/writeScheduler.ts` — `cancel()` ~L773-780 (only consults
  `pending`); parked IIFE ~L744-756; missing-source path in `fireFromTimer` ~L699-715.
- **Mechanism:** Audit-14 1.1's parked fires are registered only in `parked`; `cancel(key)`
  silently no-ops on them. `boardCacheStore.deleteBoard` calls `cancelBoardWrite` BEFORE the
  `board:delete` IPC; a parked fire then resumes after the delete, `getArgs` → null →
  `missingSourceMessage` reportError + `endWrite(false)` → deleted board's path enters
  `failedVaultPaths` for the session (no successful write can ever clear it) → sticky `.dirty` →
  phantom "Recover unsaved work" modal next launch. Trains the user to dismiss real prompts.
- **Fix:** per-key cancel token (or cancelled-keys set) consulted by the parked IIFE before
  `fireFromTimer`; `cancel(key)` marks any parked fire cancelled and emits the balanced
  `endWrite(success=true)` as it does for pending entries. **Implement with 3.4** — one
  generation/cancel mechanism covers both the reset and cancel paths.
- **Tests:** unit — park a fire (`__parkForTests`), `cancel(key)`, settle; assert no reportError,
  no failed mark.

### 4.5 ⚠️ UNVERIFIED · MEDIUM — Config delete-then-recreate-with-same-content blip permanently wedges that config target for the session (benign-reappear branch never rebases the baseline)

- **File:** `src/renderer/lib/boards/configWriteScheduler.ts` `writeConfigs` ~L297-396 — the
  Audit-7 L11 reappear-verify's FOREIGN branch rebases via `noteBaseline` (~L352); the BENIGN
  branch (content === lastWrittenConfigs — the common sync-client unlink+recreate) falls through
  to the drift check with the STALE pre-delete baseline → drifted → abort + `notifyWriteError` +
  `lastWrittenConfigs.delete`, and NO rebase → every later write to that target re-aborts; with
  lastWrittenConfigs deleted the content-verify can't even run on a future ENOENT.
- **Trigger:** OneDrive/Dropbox/AV placeholder hydration unlinks+recreates a `.filo/` config
  while a debounced config write is armed. Theme/workspace/settings changes then toast "modified
  externally; write aborted" until the vault is reopened.
- **Fix:** in the benign branch (bytes provably ours), call
  `noteBaseline(sentinelPath, reappearStat.mtimeMs, reappearStat.size)` before falling through —
  adopting the recreated stat is safe; the armed write then proceeds.
- **Tests:** unit — simulate ENOENT-then-reappear-same-content; assert the write lands and the
  NEXT write also lands (the wedge is the second write).

### 4.6 ⚠️ UNVERIFIED · LOW — `emergencyFileRegistry` never prunes on a later successful write → phantom "Filo preserved emergency files" notice + orphaned `.tmp`s

- **File:** `src/main/services/emergencyFileRegistry.ts` (no prune API; consumed by
  `quitFailureBreadcrumb.ts`).
- **Fix:** on a successful rename in `atomicWriteFile`, drop registry entries whose `targetPath`
  matches (add `clearPreservedEmergencyFilesForTarget`); or have `writeQuitFailureBreadcrumb`
  stat each target and skip entries whose target mtime postdates `at`. Prefer the former
  (deterministic). Consider also deleting the now-superseded preserved `.tmp` when its bytes
  provably landed (target content match) — otherwise leave the tmp (safer).
- **Tests:** unit — fail-then-succeed write to one path → breadcrumb empty at quit.

### 4.7 ⚠️ UNVERIFIED · LOW — Per-target failure ids leak in the scheduler's `failures` Set (success prunes only the primary id)

- **File:** `src/renderer/lib/boards/writeScheduler.ts` fireWrite settle ~L605-632 (success:
  `failures.delete(failureId)` only; failure: adds every id in `failureList`).
- **Mechanism:** config bundle writes record per-target ids (`app.json`, …) under the primary
  `'.filo/'` key; success never prunes them. Memory-only growth + latent attribution hazard.
- **Fix:** capture the failure ids recorded by THIS key's prior failures (per-entry
  `capturedFailures`) and prune them on the same key's later success.
- **Tests:** extend the existing `__failuresSizeForTests` boundedness test with a bundle-failure
  → success cycle.

### 4.8 ⚠️ UNVERIFIED · LOW — Audit-15 P2.4 self-write divergence tiebreak can misclassify Filo's own back-to-back board saves as external edits

- **File:** `src/renderer/stores/vaultExternalReconcilers.ts` `reconcileBoardJsonChange`
  (`isRecentSelfWrite → selfWriteDivergedFromBaseline` stat compare).
- **Mechanism:** write N's watcher echo arrives while write N+1 has landed but not yet stamped
  its post-write baseline → stat reflects N+1's bytes vs N's baseline → "diverged" → spurious
  external-edit reload/drift prompt during normal rapid editing; worst case a reload clobbers
  un-persisted in-memory board edits scheduled after the stat.
- **Fix:** treat "a newer self-write for this path is pending or in flight" as not-diverged —
  consult `isPathPending` / the board scheduler's in-flight set before trusting the stat compare.
- **Tests:** unit — two rapid board saves + delayed echo of the first; assert no drift prompt.

---

## Phase 5 — Frontmatter byte-preservation edge cases

### 5.1 ⚠️ UNVERIFIED · MEDIUM — An on-disk `tags: []` key is silently deleted by ANY frontmatter-dirty write (unconditional empty-tags drop predates and bypasses the baseline empty-key rescue)

- **File:** `src/renderer/lib/editor/markdownSync.ts` L447-453
  (`if ('tags' in fm && Array.isArray(fm.tags) && fm.tags.length === 0) delete fm.tags;`) vs
  L468-476 (baselineKeys rescue covers only `v === null`).
- **Mechanism:** `tags: []` parses to an empty ARRAY, not null; the dedicated drop runs even on
  the Phase-4 delta path where `fm` is the FRESH disk read. The CST engine then sees `tags`
  missing from nextObj and splices the line out as a deletion. Editing an UNRELATED field on a
  file carrying `tags: []` (very common Obsidian/template shape) removes the key — the exact
  "untouched key dropped" class `ci:frontmatter-invariant` forbids; the corpus has no
  `tags: []`-on-disk + unrelated-edit row.
- **Fix:** gate the empty-tags drop on the baseline exactly like the 1.1 null-rescue: only delete
  an empty `tags` array when `tags` is NOT in `frontmatterSourceKeys(originalFrontmatter)` (and
  check `parsedFresh` on the delta path). **Add the corpus row** to the frontmatter-invariant
  suite — that's the load-bearing part.
- **Tests:** corpus row (`tags: []` on disk + unrelated delta edit → byte-identical `tags: []`
  survives); fuzz already covers the rest once the row exists.

### 5.2 ⚠️ UNVERIFIED · MEDIUM — Delta-path body sourced from an unguarded in-chain read: a torn/stale BODY is written back verbatim when no live editor exists (Audit-14 3.3 guard protects only the FM)

- **File:** `src/renderer/lib/vault/markdownFileWriter.ts` ~L699-723 (3.3 torn-FM guard) vs
  ~L731-747 (`deltaBody = hasLiveEditorBody ? body : parsedFresh.body`).
- **Mechanism:** for the common board case (un-opened card/row) the delta write re-emits
  `parsedFresh.body`. A non-atomic external writer / sync client caught mid-write can return an
  intact-fenced read with a truncated or older body; the pre-write drift stat ran BEFORE the
  fresh read, so a write landing in the stat→read gap is invisible, and the post-write baseline
  adopts our bytes — suppressing later detection. Durable silent body truncation/reversion.
- **Fix:** re-stat after the in-chain read and verify `(mtimeMs, size)` matches the pre-write
  stat used for the drift decision; on mismatch `markPathFailed` + throw (next debounce retries).
  One extra `vault:stat` per delta write.
- **Tests:** unit — mock a body change between the pre-write stat and the in-chain read; assert
  the write aborts loudly and retries clean.

### 5.3 ⚠️ UNVERIFIED · LOW — Audit-10 H2 empty-cache re-read (body-only branch) has no torn-read guard: a partial read seeds `{}` and the assemble strips the on-disk YAML block — and the bogus seed is CACHED

- **File:** `src/renderer/lib/vault/markdownFileWriter.ts` ~L796-810 (cacheHasFm/argsFmEmpty
  re-read) — contrast the guarded delta branch.
- **Fix:** apply the 3.3-style guard: if prior vault-index metadata had non-empty
  `rawFrontmatter` and the fresh read parses `hasFrontmatter: false` while still opening with
  `---`, `markPathFailed` + throw instead of seeding `{}`.
- **Tests:** unit — torn read (opening fence only) on the sibling-adoption path; assert no write
  and no `{}` seed cached.

### 5.4 ⚠️ UNVERIFIED · LOW — CST engine mishandles non-scalar mapping keys (`[a, b]: x`): appended string-key twin → duplicate key → file's metadata bricked on next read

- **File:** `src/renderer/lib/vault/frontmatterCstModel.ts` ~L53-57 (itemKeyString → null for
  non-scalar keys, item passed through, presentKeys not updated) + ~L345-351 (addedKeys append
  of the toJS-stringified twin).
- **Mechanism:** one unrelated field edit on a file with an exotic YAML key appends a duplicate;
  next parse fails uniqueKeys → metadata collapses to `{}` and edits are refused (keep-raw).
  Raw data preserved but the user must hand-fix.
  - **Correction (verified 2026-06-10):** the "next parse fails uniqueKeys" half does NOT hold —
    a collection key and its string twin are distinct node types to the parser, and `toJS()`
    dedupes them silently (verified against yaml@2.9). So no metadata brick; the damage is a
    silent semantic DUPLICATE key appended by any unrelated edit. Mechanism otherwise as
    described; fix unchanged; LOW stands.
- **Fix:** when any mapping item's key is non-scalar (`itemKeyString === null`), return null
  (refuse → existing keep-raw/dump fallback decides), mirroring the multi-document and anchor
  refusals.
- **Tests:** corpus rows — `[a, b]: x` and `{k: 1}: x` + unrelated edit → engine refuses, file
  byte-identical.

### 5.5 ⚠️ UNVERIFIED · LOW — tagRewriter's anchored-tags skip (7.5) only inspects the START of the tags value: an alias INSIDE the collection falls through to the full-dump fallback, stripping every anchor/comment in the frontmatter

- **File:** `src/renderer/lib/vault/tagRewriter.ts` `tagsFieldIsAnchored` ~L335-343
  (`startsWith('&') || startsWith('*')`) + the `?? dumpYaml(fm)` fallbacks (~L497/538/606).
- **Mechanism:** `tags: [*shared]` starts with `[`; a block item `- *shared` has an empty header
  value — both report "not anchored". Rename/remove then resolves the alias on the load path,
  the CST engine refuses (alias on a changed key), and `dumpYaml(fm)` re-emits the WHOLE
  frontmatter from the resolved object — anchors on other keys dropped, aliases inlined, comments
  lost. Exactly what the 7.5 decision exists to prevent.
- **Fix:** scan the located tags field's FULL value range (header rest + block items) for a
  token starting with `&`/`*` and skip the rewrite (return rawContent); or make the fallback
  refuse instead of dumping when the CST refusal reason is an alias.
- **Tests:** unit — `tags: [*shared]` and block-item alias under a vault-wide tag rename; assert
  the file is untouched (skip) rather than dumped.

---

## Phase 6 — UI/UX, lifecycle & error-surface polish (LOWs)

### 6.1 ⚠️ UNVERIFIED · MEDIUM — Frame.svelte drag/resize has no pointercancel / lostpointercapture / onDestroy teardown (D.4 was applied to lib/canvas/* but not Frame's inline drag)

- **File:** `src/renderer/components/frames/Frame.svelte` ~L294-383 (handleDragStart/End),
  ~L457-462 (header binds only `onpointerup`); contrast `lib/canvas/tileDrag.ts` ~L405-454.
- **Mechanism:** pointercancel mid-drag (touch/pen, OS gesture) leaves
  `spatialStore.beginBatch()` open forever (revision frozen → viewport-culled rendering stops
  updating until a board switch — looks like data loss) and `isDragging` stuck (the next hover
  across the header moves the frame with NO undo command, persisted to disk).
- **Fix:** add `onpointercancel`/`onlostpointercapture` routing through
  handleDragEnd/handleResizeEnd (or a snap-back path mirroring tileDrag D.4), and an `onDestroy`
  that calls `endBatch()` when `isDragging` is still true.
- **Tests:** component test — dispatch pointercancel mid-drag; assert batch depth 0 and
  isDragging false. Check whether `ci:component-timer-cleanup`-style gate patterns can pin it
  (Phase 7).

### 6.2 ⚠️ UNVERIFIED · LOW — Unconditional success toast/announcement after a swallowed command rejection ("N tasks marked incomplete" / "Task added" fire even when rolled back)

- **File:** `src/renderer/lib/tasklist/frontmatterWriter.ts` `markAllIncomplete` ~L451-459;
  `lib/tasklist/taskCreation.ts` ~L266-274 / ~L358-367 / ~L402-419 (announce after
  `.catch(() => {})`).
- **Fix:** `const ok = await historyStore.execute(...).then(() => true, () => false);` — only
  toast/announce success when ok (announce the failure for screen readers otherwise; the visual
  error toast already exists via reportError).
- **Tests:** unit — failing batch; assert no success toast and an aria-live failure announcement.

### 6.3 ⚠️ UNVERIFIED · LOW — Reload handlers in `promptMarkdownPendingWriteConflict` / `promptPropertiesPopupModified` replay the detection-time snapshot instead of re-reading disk at click time; the no-editor branch skips `noteBaseline` + seeded-FM drop

- **File:** `src/renderer/stores/vaultExternalPrompts.ts` ~L534-554 / ~L603-622.
- **Fix:** mirror `promptModifiedFile` (the Audit-12 L3 / Audit-13 L17 shape): async handler,
  `captureVaultIdentity` → `await vaultIndexStore.applyChanges([rel])` → `isStillSameVault` bail
  → fresh metadata; in the no-editor branch add `noteBaseline(rel, fresh.lastModified,
  fresh.rawByteSize)` + `dropStaleSeededFrontmatterCache(rel)`. Note: the Audit-13 L16/L17
  `applyChanges` trigger in `ci:reconciler-vault-guard` should then automatically cover these
  two handlers — verify the gate flags them BEFORE fixing (bite check), then fix until green.
- **Tests:** unit — second external write between toast-open and Reload click; assert disk-fresh
  content adopted and baseline re-stamped.

### 6.4 ⚠️ UNVERIFIED · LOW — Reconcile walker skips `.filo/` entirely: external edits to tags.json/themes/templates are invisible while the live watcher handle is down, with no replay after reconnect

- **File:** `src/main/services/fileWatcher.ts` `walkDir` ~L638-643 (`.filo` skip).
- **Fix:** on supervisor reconnect (state → active), fire a one-shot synthetic
  `config-tags`/`config-theme`/`config-template` re-read; or stat the handful of known `.filo`
  config files in the reconcile walk instead of skipping the whole subtree.
- **Tests:** unit — edit tags.json while suspended → reconnect → assert a config-tags event.

### 6.5 ⚠️ UNVERIFIED · LOW — `persistRemoveTile` / `persistUpdateTile` bare-return on an unresolved boardId with no `warnUnresolved` (siblings of the already-fixed persistAddTile)

- **File:** `src/renderer/stores/boardCacheTiles.ts` ~L104-122.
- **Fix:** call `ctx.warnUnresolved('persistRemoveTile', tileId)` / `('persistUpdateTile',
  tileId)` in the null branches, matching persistAddTile.
- **Tests:** unit — cascade delete with an evicted board cache entry; assert the warn fired.

### 6.6 ⚠️ UNVERIFIED · LOW — Stale `activeScopeRef` after the last pane closes: global facades keep delegating to a destroyed pane's scope

- **File:** `src/renderer/lib/boards/boardScope.svelte.ts` ~L71-122; `PaneView.svelte` onDestroy
  (~L81-83) only destroys the canvas scope.
- **Fix:** in PaneView.onDestroy, call `resetActiveScope()` when `isActiveScope(scope)` (or have
  `workspaceStore.clearTree` fire it). Guard facade mutations on a live pane if cheap.
- **Tests:** unit — close last tab; assert facade reads route to the null/inert scope (no writes
  to the closed board's cache).

### 6.7 ⚠️ UNVERIFIED · LOW — Keystrokes typed during `tabStore.close()`'s flush window are destroyed (editor stays mounted + editable during the drain and any "Save failed — close anyway?" confirm)

- **File:** `src/renderer/stores/tabs.svelte.ts` `close()` ~L230-296.
- **Fix:** after the confirm resolves and before `tabs = tabs.filter(...)`, re-run the closing
  tab's flush once more (no-op when nothing re-armed); or set a per-tab `closing` flag editors
  consult to reject input during the drain. Prefer the re-flush (no UX change).
- **Tests:** unit — type after the first drain snapshot, then complete close; assert the second
  flush captured it.

### 6.8 ⚠️ UNVERIFIED · LOW — Audit-15 P1.4 gateway delta body-source liveness is re-derived at WRITE time, discarding a fire-time body if the doc unloads in between

- **File:** `src/renderer/lib/vault/markdownFileWriter.ts` delta branch
  (`hasLiveEditorBody = docId ? getDocument(docId) !== undefined : false`).
- **Fix:** decide the body source at FIRE time — `writeFrontmatter` already knows whether
  docState existed; thread `bodyIsLive: boolean` through WriteArgs instead of re-deriving from
  the mutable documentStore at write time.
- **Tests:** unit — unload the doc between fire and the in-chain read; assert the fire-time body
  (not parsedFresh.body) lands when it was live at fire.

---

## Phase 7 — Anti-regression gates & test-net

### 7.1 Extend `ci:no-silent-write-abort` for the 1.1/1.2 return shapes

- New arms in `scripts/check-no-silent-write-abort.mjs`:
  (a) forbid a bare `isReadOnly(...)) return` in writer/scheduler files without a
  `markPathFailed` in the same file (the 1.2 token);
  (b) require the 1.1 fix's distinctive token survives (whichever lands — the
  `updateContent` version bump or the `bodyDirty` bypass) so a refactor can't silently
  reintroduce the version-guard body blindness.
- Bite-verify both arms (temp-revert → exit 1), as with every prior gate.

### 7.2 Frontmatter-invariant corpus rows

- `tags: []` on disk + unrelated delta edit (5.1).
- Non-scalar mapping keys `[a, b]: x` / `{k: 1}: x` + unrelated edit → refuse, byte-identical
  (5.4).
- Alias inside the tags collection + tag rename → skip, file untouched (5.5).

### 7.3 Round-trip / behavioral matrices

- Two-sequential-`setNotesBody` + toggle-then-notes matrix (1.1) — the audit confirmed this exact
  sequence has NO existing test.
- Tied-sections round-trip for `DeleteSectionCommand` (2.2) under `ci:command-roundtrip-coverage`.
- The A/B/C generation-collision interleaving for both schedulers (4.1/4.2).
- LAUNCH_ID + vaultGeneration suppression matrix (3.3) — same-open suppressed, same-session
  reopen prompts, prior-session prompts.
- Parked-fire × {cancel, reset, missing-source} matrix (3.4/4.4) using `__parkForTests`.

### 7.4 Gate-coverage check for 3.2

- Verify `ci:reconciler-vault-guard` Part 1 triggers fire on `runRecoverySequencer`'s step-2
  handlers after the fix (live-path read + await). If the anonymous-handler shape evades the
  scan, pin the function in Part 3's explicit list (the VS-1 pattern).

### 7.5 Optional ratchet — pointer-capture teardown gate

- If 6.1 confirms, consider a small `check-pointer-capture-cleanup.mjs` modeled on
  `ci:component-timer-cleanup`: any component-scope `setPointerCapture` requires a
  `pointercancel` (or `lostpointercapture`) binding in the same component. Survey existing
  components first to size the allowlist; skip if false-positive-heavy.

---

## Deliberately NOT planned (accepted/known)

- `writeBoardFile` ENOENT clean-no-op on external delete (Audit 4.5 decision; watcher covers it).
- Drift-abort-without-rebase on a GENUINE external config edit (intentional — only the
  benign-reappear branch in 4.5 is a bug).
- Same-basename ≥10MB size-only rename pairing (documented accepted risk).
- `boardWriteScheduler` flushAll serial write latency.
- Suppression-window self-write deletes masking an external delete >30s (acknowledged M4
  trade-off).

## Execution notes

- **Fix order within Phase 1:** 1.1 and 4.3 together (same bookkeeping), then 1.2. These three
  are all in `frontmatterWriteScheduler.ts` + `document.svelte.ts` + the gateway tail — one
  coherent change-set, one test matrix.
- **Fix order within Phase 3/4:** 3.4 + 4.4 share the parked-fire token mechanism; 4.1 + 4.2
  share the monotonic-counter mechanism. Implement each pair once.
- Findings refuted during verification: record here with strikethrough + reason (Appendix-A
  style, matching prior plans).
- After all phases: full `npm run ci:verify`, then commit in phase-sized commits for
  bisectability (Audit-9's lesson: commit the pre-existing tree first if it isn't already
  committed — the current tree carries Task-List-audit + A14 + A15 uncommitted; **strongly
  consider committing that BEFORE starting Phase 1** so audit-16 fixes are separable).

## Status

- [x] Phase 1 — 1.1, 1.2 (+4.3 folded in) — **DONE 2026-06-09.** No findings refuted.
  Implementation notes for the record:
  - **1.1** took the preferred single-counter fix: `documentStore.updateContent` bumps the SAME
    `mutationVersions` map (body change ⇒ stale flush, exactly like an FM change). Consumer audit
    found one FM-only consumer the plan didn't name: the A9-M2 refresh-seed guard
    (`seedFrontmatterFromDisk` + the `placeholderVersion` capture in `tasklist/frontmatterWriter`)
    compares "did anything mutate FM since the placeholder" — a body bump there would SKIP the
    disk-FM refresh and strand the cache on the baseline-less index placeholder (lossy FM re-dump
    on rapid typing). Fix: a lockstep `bodyMutationVersions` map + `documentStore.
    getFrontmatterOnlyMutationVersion` (shared − body); both seed sites compare FM-only.
  - **1.1 adjacent (same loss class):** `mutationVersions` is no longer deleted on
    `clearFrontmatter` / `unloadDocument` (only on the whole-store `clear()`, matching the
    scheduler's `lastFlushedVersion` lifecycle). docIds are stable contentIds, so a counter reset
    under a reused docId restarted versions BELOW the surviving last-flushed high-water mark —
    the same `scheduledVersion <= last` silent skip on the first edits after a tile close+reopen.
  - **4.3** — scheduler success path records the FIRE-time `scheduledVersion`; the gateway
    threads `WriteArgs.mutationVersionAtCapture` (caller-captured, falling back to capture at
    `writeMarkdownFile` entry before the per-path chain wait) and `noteFrontmatterFlushedVersion`
    uses it instead of the post-IPC live counter.
  - **1.2** — delta writes on a read-only doc proceed with the body forced to a fresh disk read
    (never the lossy `docState.body`); delta-less writes refuse loudly (`reportError(
    'frontmatter.readOnly')` + `markPathFailed` + throw). The version guard now runs BEFORE the
    read-only check so a genuinely-stale no-delta flush stays a benign no-op. The "disable field
    UI" defense-in-depth was deliberately NOT done: post-fix, field edits on read-only docs land
    correctly (FM round-trips cleanly — same policy as the tag writer), so disabling the controls
    would be wrong; only delta-less body writes refuse, and they now surface a toast.
  - Tests: `audit16Phase1.test.ts` (8) — two-sequential-`setNotesBody`, toggle-then-first-note,
    edit-during-in-flight, 4.3 mid-IPC merge, 1.2 delta-on-read-only (disk body byte-preserved) +
    loud delta-less refusal, refresh-seed body-tolerance + A9-M2 field-edit blocking. All 8
    bite-verified (red against the pre-fix tree via stash, green after).
- [x] Phase 2 — 2.1, 2.2, 2.3, 2.4, 2.5 — **DONE 2026-06-10.** No findings refuted: the three
  ⚠️ UNVERIFIED items (2.3, 2.4, 2.5) were each confirmed in source before fixing.
  Implementation notes for the record:
  - **2.1** — `execute()` captures `originBoardId` before `commitExecute`; `rollbackExecute`
    takes it and resolves `getStackFor(originBoardId)` (mirroring the Audit-14 2.1 fix for
    `rollbackUndo`/`rollbackRedo`); marks dirty via `command.targetBoardId || originBoardId`.
  - **2.2** — took the successor-ID anchor (not the raw array index): the constructor captures
    the ids of the sections AFTER the removed one in `before.sections` array order
    (`successorIds`), and `undo()` splices the marker back in front of the FIRST surviving
    successor (append only when none survive — which IS the original tail slot, so deleting the
    populated tied OWNER round-trips too). Survives out-of-band section deletes between execute
    and undo, like the `DeleteCardCommand.beforeTileId` pattern it mirrors.
  - **2.3** — confirmed: on `findIndex → -1` no boundary shifted while the task was already
    spliced in. Fix is the planned legacy numeric fallback (`position >= insertAt` bump) +
    `console.warn` naming the unresolved id. The legacy branch's empty-tail-append carve-out is
    deliberately NOT applied to the fallback: the caller DID name a target section, so anchoring
    every at/after-insert boundary (rather than keeping an empty tail section pinned) is the
    conservative membership-preserving choice.
  - **2.4** — confirmed (`tabStore.close`/`closeOthers` → `clearBoard` was the most common
    stack-discard path). Own-stack drop now routes through
    `mutateStack(own, boardId, s => { undoStack = []; redoStack = []; })` before the record
    delete; the optional close-confirm gate was not added (out of scope, toast-only contract).
  - **2.5** — took the preferred generation token (`chainGeneration`, bumped by the pre-swap
    reset); both `runChained` settle paths route through `noteChainOpSettled(generation)` which
    decrements only while the generation still matches. No clamp — the token is exact and a
    clamp would only mask a future bookkeeping bug.
  - Tests: `audit16Phase2.test.ts` (4 — 2.1 origin-stack repair + redo restore, 2.4 escalated
    toast + silent-without-snapshots, 2.5 sync-body contract after an in-flight Don't-Save swap);
    `sectionCommandsDelta.test.ts` +3 (2.2 tied-empty round-trip incl. redo→undo cycle + the
    no-successor populated-owner case, 2.3 stale-id boundary shift + membership). 5 of the 7
    bite (red against the pre-fix tree via stash); the other 2 are negative/guard cases green on
    both sides by design.
- [x] Phase 3 — 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7 — **DONE 2026-06-10.** No findings refuted:
  all four ⚠️ UNVERIFIED items (3.2, 3.4, 3.5, 3.6, 3.7) were confirmed in source before
  fixing (3.4's reset() comment even claimed the `trackerIsCurrent` guard covered the dangling
  parked closure — it doesn't: the missing-source branch never reaches `fireWrite`).
  Implementation notes for the record:
  - **3.1** — both halves: `if (this.aborted) return;` immediately after the single await
    (`correlateRenames`) in `notifyRenderers`, AND the in-flight notify pass is tracked like the
    reconcile walk (`notifyInFlightPromise`, published before any suspension via a
    `notifyRenderers` wrapper around `notifyRenderersImpl`, owner-checked clear) and awaited in
    `stop()`. Test: `fileWatcherLateNotify.test.ts` (gated `correlateRenames` mock — stop()
    blocks while the pass is parked; the late resolution emits zero sends; positive control).
  - **3.2** — step 2's onConfirm AND onCancel guard with the sequencer's existing `captured`
    identity at entry and after every await. The prune deliberately stays on live `fileTree`:
    a passing `isStillSameVault(captured)` proves it is still THIS open's tree, and no await
    separates the check from the prune (a sequencer-start tree capture would be STALER). Steps
    0/1/3/4 were already guarded (VS-1 / D.9).
  - **3.3** — generation stamp, as preferred: `markDirty` stamps
    `vaultGeneration: currentVaultGeneration()` alongside the launchId; `checkRecovery`
    suppresses only when BOTH match. Sequencing verified: the 1.3 migration-repair writes fire
    after `commitVaultCandidate`'s `beginVaultGeneration` (L383 → L398), so same-open
    suppression is preserved; a Don't-Save-preserved sentinel carries the EARLIER generation
    and now prompts. A same-launch sentinel with NO generation stamp also prompts (pre-fix
    payloads from this very session are the only producers — prompting is the safe direction).
  - **3.4** — scheduler-wide `schedulerGeneration` bumped in `reset()`; the parked IIFE
    captures it at park time and bails after `drainPriorInFlight` when it moved — neither
    `fireFromTimer()` (stale re-fire into the fresh `inFlight` map) nor the missing-source
    `safeEndWrite(false)` (foreign path in the new session's failed set + sentinel) can run.
    The parked promise still resolves in `finally`. 4.4 will extend the same mechanism per-key.
  - **3.5** — owner-checked clear in all three finallys (openVault + closeVault):
    `if (swapInProgress === mySwapWindow) swapInProgress = null;` — resolving OUR window stays
    unconditional (its awaiters waited for THIS swap). No re-entrancy latch added (out of
    scope; the two-line owner check closes the reported hole).
  - **3.6** — `refreshTree()` now returns a success boolean (envelope failure / IPC throw →
    false; trees-equal short-circuit and no-vault both count as success);
    `refreshTreeAndCleanup` skips ALL its walks on a failed refresh (every one of them treats
    `fileTree` as disk truth), and the missing-board eviction additionally confirms each
    candidate with a direct `vault:file-exists` probe (probe failure ⇒ can't prove missing ⇒
    keep) plus an `isStillSameVault` bail after the awaits. `VaultContext.refreshTree` stays
    `Promise<void>` — slice consumers don't need the boolean and the narrower type keeps the
    three test-stub literals valid.
  - **3.7** — the `listenForChanges` $effect moved from VaultSidebar.svelte to App.svelte
    (app-lifetime, keyed on `vaultStore.isOpen`), removing the docked↔floating unmount gap
    entirely. Pinned by a source-shape test (the unit suite has no component-mount harness):
    App.svelte must contain the call, VaultSidebar/FloatingVaultPanel must not.
  - Tests: `fileWatcherLateNotify.test.ts` (2 — 3.1), `audit16Phase3.test.ts` (12 — 3.2 swap
    mid-converge / swap-before-cancel / positive control; 3.4 stale re-fire / missing-source
    pollution / positive control; 3.5 interleaved-swaps save-defer; 3.6 failed-read skip /
    create-vs-read probe rescue / genuine-delete control; 3.7 source pins), and
    `dirtyFlagRecovery.test.ts` +3 (3.3 generation stamp / same-session-reopen prompt /
    no-stamp back-compat; the 1.3 suppression row now stamps the current generation). Every
    guard test bite-verified red against the pre-fix tree via stash; positive controls green
    on both sides by design.
- [x] Phase 4 — 4.1, 4.2, 4.4, 4.5, 4.6, 4.7, 4.8 — **DONE 2026-06-10.** No findings refuted:
  all six ⚠️ items (4.2, 4.4–4.8) were confirmed against source line-by-line before fixing
  (4.3 had already shipped with Phase 1). Implementation notes:
  - **4.1 + 4.2** — one shared fix, as planned: a session-monotonic
    `mintWriteGeneration()` counter in `writeStateTracking.ts`, used by BOTH per-path maps
    (`writeGenByPath` in the scheduler primitive, `componentWriteGenByPath` in
    `trackComponentWrite`). The heal/endWrite guards keep their `!==` compares — a missing
    (pruned) entry already reads "not current" — so only the MINT changed. The counter is
    deliberately NOT reset on vault swap (the maps are; a stale continuation's generation must
    keep comparing unequal to every post-swap mint). The Audit-14 1.6/1.5 boundedness prunes
    and both `__*GenSizeForTests` probes are unchanged and still green.
  - **4.4** — `parked` entries became `ParkedEntry` objects (`{ promise, vaultRoot, path,
    cancelled }`); `cancel(key)` now marks every un-cancelled parked fire cancelled and emits
    its balanced `endWrite(success=true)` (same contract as a pending timer), and the parked
    IIFE bails after the drain on `cancelled` — sitting beside the 3.4 `schedulerGeneration`
    bail, exactly the "one generation/cancel mechanism" the plan called for. `flush`/
    `flushAll` await `entry.promise` as before.
  - **4.5** — the benign-reappear branch rebases ONLY when `reappearedVerifiedOurs` (read
    succeeded AND content === `lastWrittenConfigs`); the permissive read-hiccup path (
    `reappearedIsForeign = false` without verification) deliberately does NOT adopt the new
    baseline — unverified bytes must still face the drift check.
  - **4.6** — `clearPreservedEmergencyFilesForTarget(targetPath)` (win32 case-fold +
    `path.normalize`) called after the successful rename in BOTH `atomicWriteFile` and
    `copyFileToVault`. The preserved `.tmp` is left on disk per the plan's safer option (no
    content-match deletion).
  - **4.7** — per-key `failureIdsByKey` ledger: a failed fire records its attributed id list
    under its key; the key's next success prunes those ids from `failures` (not just the
    primary failureId). Cleared in `reset()`.
  - **4.8** — new NARROW probe `isPathQueuedOrInFlight` (pendingVaultPaths + gateway probes,
    deliberately EXCLUDING `failedVaultPaths` — a failed path doesn't explain a divergence,
    and including it would drop genuine external-edit echoes). The reconciler's tiebreak
    drops a diverged self-write echo only while a newer write is queued/in flight; a genuine
    external edit in that window is still caught by `writeBoardFile`'s pre-write drift check
    (positive control pinned in the test).
  - **File size:** `writeScheduler.ts` sat AT its 1175 ceiling; per the split-don't-bump rule
    the public type surface moved to `writeSchedulerTypes.ts` (type-only re-exports keep all
    importers unchanged), bringing the impl to ~998 LOC and REMOVING it from the
    `ci:file-sizes` allowlist (13 → 12 grandfathered files).
  - Tests: `audit16Phase4.test.ts` (13 — the 4.1 A/B/C/A-late interleaving + M2 control, the
    4.2 trackComponentWrite twin, 4.4 cancelled-parked-fire + fires-without-cancel control,
    4.5 blip-then-two-writes, 4.6 atomicWriteFile prune / breadcrumb no-op / case-fold, 4.7
    bundle-failure→success Set drain, 4.8 echo-dropped + two positive controls). All 8 guard
    tests bite-verified red against an in-place pre-fix emulation (each fix individually
    reverted in one pass → exactly the 8 guards red, all 5 positive controls green).
- [x] Phase 5 — 5.1, 5.2, 5.3, 5.4, 5.5 — **DONE 2026-06-10.** No findings refuted: all five
  ⚠️ UNVERIFIED items confirmed in source before fixing, with one SEVERITY CORRECTION on 5.4:
  the appended stringified twin does NOT trip `uniqueKeys` on the next read (a collection key
  and its string twin are distinct node types to the parser, and `toJS()` dedupes silently —
  verified empirically against yaml@2.9), so the file's metadata is not "bricked"; the real
  damage is a silent semantic DUPLICATE key (`[a, b]: x` + `"[ a, b ]": x`) appended by any
  unrelated edit. Mechanism real, fix unchanged, severity LOW stands.
  Implementation notes for the record:
  - **5.1** — `assembleMarkdownFile` computes `baselineKeys` BEFORE the empty-tags drop and
    gates the drop on `!baselineKeys?.has('tags')`, exactly like the 1.1 null rescue (one gate
    now covers both clean passes). On the delta path `originalFrontmatter` IS the fresh in-chain
    read, so the disk truth gates it by construction. Deliberate behaviour note: clearing the
    LAST tag via the FM-object path now leaves `tags: []` on disk instead of deleting the key —
    consistent with `tagRewriter.renderTagsField`, which already emits `tags: []` for empty.
  - **5.2** — new `preWriteVerifyStat` anchor in `writeMarkdownFileImpl`: the pre-write drift
    stat, re-anchored to the APPROVED re-check stat after a keep-local prompt (cleared when the
    legacy proceed-on-failed-re-stat path ran — no anchor, no verify). The delta branch re-stats
    AFTER its in-chain read; a `(mtimeMs, size)` mismatch → `markPathFailed` + throw (the next
    debounced write re-detects the drift and prompts). One extra `vault:stat` per delta write,
    skipped when no baseline existed (freshly-seeded file — same trust as before).
  - **5.3** — the 3.3 torn-read guard logic was extracted to a NEW shared module
    `lib/vault/tornFrontmatterRead.ts` (`freshReadLooksTornMidFrontmatter`); the Phase-5
    additions still put `markdownFileWriter.ts` over its 1369 ceiling (1418 raw), so per
    split-don't-bump the long-queued drift-prompt split (already noted as queued in
    `check-file-sizes.mjs`) was ALSO executed: the whole Phase R6 + 6.4.M13 pre-write drift
    gate moved to NEW `lib/vault/preWriteDriftGate.ts` (`runPreWriteDriftGate` — returns
    proceed/drop + the 5.2 `verifyStat` anchor; throws loudly for defer/exhaustion exactly as
    before), bringing the gateway to ~1330 raw LOC. Extraction nuance: the NO-BASELINE
    short-circuit stays at the gateway call site (sync `getBaseline` check, no await) — the
    pre-split code had zero awaits on that path, and the one extra microtask an `await` of the
    async gate added delayed the write IPC's handler attachment enough for an already-rejected
    IPC promise to surface as an unhandled rejection (caught by `test:unit:strict` via
    `frontmatterSchedulerCrossVaultFinalizer.test.ts`'s 3-tick drain budget).
    The H2 empty-cache seed re-read was restructured so the
    read's ENOENT-swallowing catch can't eat the guard throw: torn read → `markPathFailed` +
    throw, and the bogus `{}` is NEVER seeded into the cache (pre-fix it poisoned every later
    save for the docId, not just the current one).
  - **5.4** — `patchFrontmatterSourceCst` refuses (returns null) when ANY mapping item's key is
    non-scalar (`itemKeyString === null` — also covers explicit-key `? …` and empty-key forms).
    Routing decision beyond the plan text: the refusal goes to KEEP-RAW, not the dump — a new
    `frontmatterSourceHasNonScalarKey` joins `!frontmatterSourceParses` in the assemble's
    keep-raw condition (the dump would rewrite the key as its quoted string twin, a semantic key
    change, unlike the data-preserving flow-root/anchor dumps), surfacing via the existing
    `onFrontmatterRefused` toast. The same guard fronts tagRewriter's three `?? dumpYaml(fm)`
    fallbacks, so a tag op on such a file skips byte-identically too.
  - **5.5** — `tagsFieldIsAnchored` scans the field's FULL value range: header rest, each flow
    item, each block item (same blank-line-tolerant walk as `locateTagsField`). Detection stays
    precise — an UNQUOTED leading `&`/`*` is always an anchor/alias (indicator chars are illegal
    at plain-scalar start); a quoted tag containing them still rewrites. Also hardened
    `itemUnsafeForLinePath` with the same `/^[&*]/` decline so the block fast path can never
    treat an alias item as the LITERAL tag `*shared` (a latent corruption shape the audit text
    didn't name: a rewrite would re-emit the alias as a quoted literal).
  - Phase-7 advance: the 7.2 corpus rows for 5.1/5.4/5.5 shipped here — 5 new `HOSTILE_CORPUS`
    rows (exercised by the tag-op matrix, the body-only save, AND the Audit-14 7.5 delta
    fuzzer, which caught the 5.1 bug on its own once the row existed), plus dedicated 5.1/5.4
    describes; `assertSafeDeltaWrite` gained the byte-identical-refusal early return the
    non-scalar-key rows need.
  - Tests: `audit16Phase5.test.ts` (6 — 5.2 gap-write abort + stable control + no-baseline
    legacy-trust control; 5.3 torn-seed refuse-and-never-cache + clean-seed control +
    FM-less-file control), `frontmatterInvariant.test.ts` (+5 corpus rows, +2 5.1 delta rows,
    +4 5.4 engine/byte-identical rows), `tagRewriter.test.ts` (+4 — flow alias / block alias /
    item anchors / quoted-`*` negative control). All 11 guard tests bite-verified red against
    the pre-fix tree via stash (controls green on both sides); full strict unit suite green.
- [ ] Phase 6 — 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8
- [ ] Phase 7 — 7.1, 7.2, 7.3, 7.4, 7.5

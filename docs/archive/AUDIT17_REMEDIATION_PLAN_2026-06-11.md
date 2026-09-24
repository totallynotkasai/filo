# Audit-17 Remediation Plan — 2026-06-11

**Source:** Audit-17 fresh-eyes adversarial audit (9-agent workflow: 6 finders + 3 verifiers), run 2026-06-11
against branch `chore/electron-42` with the Audit-16 Phase 6 work uncommitted in the tree.
42 candidate findings → **37 confirmed/partially-confirmed (1 HIGH / 12 MEDIUM / 24 LOW), 5 refuted, +3 verifier-added.**
Every item below was verified end-to-end in source by an adversarial reviewer; line numbers reference the
2026-06-11 tree and may drift.

**Headline:** no silent-content-loss blocker on the common paths. The core markdown/frontmatter write path
(CST engine, delta-on-fresh-read, drift gates) held. The dominant theme of this round is **error honesty** —
several paths resolve *failure as success* — plus one HIGH undo/redo edge and one confirmed regression in the
uncommitted Audit-16 6.4 change (Phase 0).

**Area ratings given (1–10):** data integrity 8 · write-path error-honesty 6 · concurrency/lifecycle 6 ·
undo/redo 7 · security 8 · UI/UX 6 · architecture 7 · test/CI 8.

**Status legend:** 🟢 done · 🔴 not started · 🟡 in progress

---

## Phase 0 — Pre-commit blockers (must land before `chore/electron-42` is committed)

### 0.1 🟢 Stale A16-P6 tests + file-size ceiling overages (DONE 2026-06-11)
Fixed during the audit session itself: 4 stale unit tests updated to the intentional new behaviors
(`await` the now-async 6.3 Reload handlers in `cardPendingWriteClobber.test.ts` + `vaultExternalChanges.test.ts`;
double-flush counts in `tabsStoreCloseFlush.test.ts`), and 2 ceiling overages fixed by comment compression
(`kanbanCommands.ts` 1096→1093, `TaskListBoard.svelte` 2203→2202 — **no ceiling bumps**).
Full `ci:verify` GREEN (48 steps incl. the new `ci:pointer-capture-cleanup`).

### 0.2 🟢 MEDIUM — 6.4 reconcile walk turns every in-app tags.json save into a perpetual 30-second "modified externally" toast + re-save loop (DONE 2026-06-11)
**Files:** `src/main/services/fileWatcher.ts` (uncommitted `walkFiloConfig`),
`src/renderer/stores/vaultExternalReconcilers.ts` (`reconcileTagsJsonChange`),
`src/renderer/lib/boards/miscWriteScheduler.ts`.
**Mechanism (confirmed end-to-end):** `walkFiloConfig` puts `.filo/tags.json` in the 30 s reconcile snapshot
(`RECONCILE_INTERVAL_MS = 30_000`). A self-write's *live* echo is suppressed, but the next reconcile pass diffs
mtime up to 30 s later — far past both the main-side suppress window and the renderer `isRecentSelfWrite` TTL
(1.5–5 s). `reconcileTagsJsonChange` has **no disk-vs-memory compare** (unconditional toast + `applyExternalReload`),
and `applyExternalReload` ends in an unconditional `scheduleSave()`; the misc scheduler has **no content dedup**
(unlike config's `lastWrittenConfigs`), so an identical-bytes save fires, bumps mtime, and the next pass diffs
again — toast + load + merge + save, every 30 s, for the rest of the session. The Audit-10 M3 suppression
carry-forward only defers the diff one pass; it cannot break the loop. No bytes are lost (A8-M6 3-way merge keeps
them stable), but it is perpetual false-conflict noise, a disk write every 30 s on a synced vault, and it trains
the user to ignore the *genuine* tags.json conflict toast.
**Fix (two layers, both cheap):**
1. **Content compare in the reconciler** — `reconcileTagsJsonChange` loads the disk file anyway; if the parsed
   disk state deep-equals the in-memory registry, skip the toast AND the reload (mirror the config scheduler's
   reappear-content-distinguish shape from Audit-7 L11).
2. **Drop the unconditional `scheduleSave()`** in `applyExternalReload` when the merge produced no change
   (byte/deep-equality check before arming), so even a genuine external edit doesn't immediately echo a write.
**Side effect to fix in the same pass:** theme/template reconcilers share the expired-TTL hole (one-shot spurious
re-apply per self-write — no loop, they don't re-save). The same content-compare shape applies if cheap; otherwise
document as accepted.
**Test:** unit — simulate in-app tags save → synthesized `config-tags` reconcile event 30 s later → assert NO
toast and NO new save scheduled; counter-case: genuinely different disk bytes → toast + reload still fire.

### 0.3 🟢 LOW (process) — AUDIT16 plan status bullet is stale (DONE 2026-06-11)
`AUDIT16_REMEDIATION_PLAN_2026-06-09.md` (~L993–1001) still records the 4 failing tests + 2 `ci:file-sizes` reds
as "known pre-existing reds" — all now pass (0.1). A stale known-red list is exactly how the next genuine red gets
rationalised away. Update the bullet before commit.

---

## Phase 1 — The HIGH + write-correctness mediums (data on disk can be wrong)

### 1.1 🟢 HIGH — Undo/redo of a Kanban/Task field edit on a never-opened doc silently clobbers an external same-field edit (DONE 2026-06-11)
**Files:** `src/renderer/commands/frontmatterRebase.ts` (~L184–190),
`src/renderer/commands/kanbanCommands.ts` (`UpdateCardFieldCommand.undo` ~L645–656, isRedo execute leg ~L699–713).
**Mechanism (partially-confirmed; bug real, common path corrected by verifier):** when no editor is open, the
seeded FM cache is dropped by `dropStaleSeededFrontmatterCache` on a classified external FM edit — so the rebase
hits `current === undefined` and takes the documented **blind `commit(applying)`** branch with no conflict
detection. The inverse delta is scheduled and the gateway's delta-on-fresh-disk write unconditionally overwrites
the externally-changed field. The 4.2 conflict prompt never fires. The propertiesCommands twin (Phase 2.2 fresh
disk read, `applySnapshot` ~L193–212) and the orphan twin (`readMarkdownForHydrate`) were fixed; these two legs
were not.
**Fix:** in the `current === undefined` branch, re-read disk (same shape as `applySnapshot` — fresh
`vault:read-file-text` → parse → use as the compare base) instead of blind-committing. Apply to BOTH legs
(undo and isRedo-execute). On a conflict, route to the existing "Apply anyway" prompt path.
**Test:** unit round-trip — field edit on never-opened doc → external same-field edit lands on disk (watcher
event processed, seeded cache dropped) → undo → assert the external value survives / a conflict prompt fires,
NOT a silent revert. Mirror for redo.

### 1.2 🟢 MEDIUM — "Apply anyway" conflict toast writes a frozen conflict-time body, reverting interim editor saves (DONE 2026-06-11)
**File:** `src/renderer/commands/propertiesCommands.ts` (`applySnapshot` ~L229, toast handler ~L297–345).
**Mechanism:** `body = docState?.body ?? diskBody ?? index.content` and `bodyIsLive: docState != null` are both
evaluated ONCE at conflict time; the `duration: 0` toast can be clicked minutes later. The gateway honours the
caller's liveness flag and prefers the frozen body over its fresh in-chain disk read — reverting every body save
the editor made in the interim; post-write bookkeeping then adopts the reverted bytes as baseline. Worse corner:
if the editor was CLOSED between conflict and click, the captured `docState != null` still claims the frozen body
is live. The handler also stamps the conflict-time `merged` object into the display cache (~L324).
**Fix:** re-resolve at CLICK time inside the handler — re-read `documentStore.getDocument(docId)` for a live body
(and recompute `bodyIsLive`); when no live editor, pass no body / `bodyIsLive: false` and let the gateway's fresh
in-chain read supply it (the kanban orphan toast twin already does this). Recompute the display-cache stamp from
the post-write state, not the conflict-time object.
**Test:** unit — conflict toast armed → editor body changes + flushes → click "Apply anyway" → assert disk body
is the NEWER editor body with the FM delta applied; second case: editor closed before click → disk body preserved.

### 1.3 🟢 MEDIUM (verifier-added) — "Apply anyway" field-patch toast has no vault-identity guard; `scheduleFrontmatterWrite` resolves `vaultRoot` live at fire time (DONE 2026-06-11)
**File:** `src/renderer/commands/frontmatterRebase.ts` (`applyFrontmatterPatchRebased` toast handlers).
**Mechanism:** a click after a vault swap writes the outgoing vault's field patch onto the NEW vault's same-named
file (the exact class `ci:reconciler-vault-guard` exists to kill, but these handlers are anonymous arrows in a
commands file the gate doesn't sweep for this trigger).
**Fix:** `captureVaultIdentity()` when the toast is armed; `isStillSameVault(identity)` bail at the top of each
handler (the L17/Audit-13 shape used five times in `vaultExternalPrompts.ts`).
**Gate:** extend `check-reconciler-vault-guard.mjs` Part 3 pinned list with `applyFrontmatterPatchRebased`
(same rationale as Audit-16 7.4's `runRecoverySequencer` pin — anonymous handlers, file outside the Part 1 sweep).
**Test:** unit — arm toast, swap vault (bump generation), click → assert no write IPC fired.

### 1.4 🟢 MEDIUM — `UpdatePropertiesCommand` execute/undo swallow gateway write failure (DONE 2026-06-11)
**File:** `src/renderer/commands/propertiesCommands.ts` (~L280–295).
**Mechanism:** `documentStore.setFrontmatter(docId, merged)` runs BEFORE the write; the catch calls
`reportError` with **no rethrow**, so execute()/undo() resolve on failure. `historyStore` DOES roll back on
rejection (`rollbackExecute` / `rollbackUndo`) — the swallow is precisely what defeats it. Result: a never-applied
command sits on the stack as "applied" and the display cache diverges from disk. The orphan twin
(`applyOrphanPatchRebased`) already fixed this shape per A9-L2 by letting the rejection propagate.
**Fix:** rethrow after `reportError` in both legs (one-line each); verify the rollback path restores the display
cache (it restores the snapshot — confirm `setFrontmatter` pre-write stamp is reverted by the rollback, else move
the stamp to after the successful write like the orphan twin).
**Test:** unit — failing write IPC → execute → assert command NOT on stack + display cache matches disk;
same for undo (assert redo stack not corrupted).

---

## Phase 2 — Error honesty: failure-reported-as-success cluster

### 2.1 🟢 MEDIUM — `flushMarkdownWrite` can never reject; downstream catch blocks are dead code (DONE 2026-06-11)
**Landed:** `flushMarkdownWrite` returns `{ ok, error }` (`FlushMarkdownResult`); a per-callerId
`lastWriteFailureByCaller` map (cleared at fire-start so a stale error can't be misattributed to a
timeout, and on vault swap) captures the concrete error before the scheduler's `fireWrite` swallows
it. DocumentEditor only `markClean`s on ok and its ENOENT → `backingFileMissing` degraded mode is now
reachable; PropertiesPopup keeps its dirty flag on failure. Generic-failure `reportError`s dropped in
both components (trackComponentWrite already toasts — avoids double-reporting).
**Files:** `src/renderer/lib/vault/markdownFileWriter.ts` (~L969–977, docstring promises "Re-throws any IPC
failure"), `src/renderer/lib/boards/writeScheduler.ts` (~L276–278 swallow),
`src/renderer/components/boards/DocumentEditor.svelte` (~L246–264),
`src/renderer/components/tiles/PropertiesPopup.svelte` (~L239–264).
**Mechanism:** `fireWrite` wraps `performWrite` in `catch { return [failureId] }` and `flush()` returns `{ ok }`;
`flushMarkdownWrite` discards the boolean. DocumentEditor runs `markClean` unconditionally and its
ENOENT→`backingFileMissing` catch is unreachable (endless failing rewrites instead of the degraded mode);
PropertiesPopup clears `clearPropertiesPopupDirty(flusherId)` on a FAILED flush. Containment: `markPathFailed`
keeps the path in the failed set so the F4 conflict guard still works — the wrong state is `doc.isDirty` and the
never-entered degraded mode.
**Fix:** make `flushMarkdownWrite` honour its docstring — return/throw on `!ok` (suggest: return the `{ ok }`
and fix the two component callers to branch on it; throwing risks unhandled rejections in fire-and-forget
callers). DocumentEditor: only `markClean` on ok; enter `backingFileMissing` on the ENOENT failure code.
PropertiesPopup: keep the dirty flag on failure.
**Test:** unit — failing write → flush → assert `doc.isDirty` stays true, popup dirty flag retained,
DocumentEditor enters degraded mode on ENOENT.

### 2.2 🟢 MEDIUM — `atomicWriteFile` deletes the fully-fsynced tmp on EPERM/EBUSY exhaustion (DONE 2026-06-11)
**Landed:** EPERM + EBUSY joined the preserve list (only ENOENT still unlinks — the destination
itself is gone). The `(data preserved at <tmp>)` message annotation + `recordPreservedEmergencyFile`
breadcrumb ride the same branch, so the M5 toast regex parses these codes with no toast-side change.
**File:** `src/main/vault/filenameUtils.ts` (retry list ~L260, preserve list ~L283, unlink ~L297).
**Mechanism:** rename retries EPERM/EBUSY/EACCES as transient Windows lock errors, but the post-exhaustion
preserve-the-tmp list covers only ENOSPC/EIO/ENOMEM/EACCES — EPERM and EBUSY fall to `fs.unlink(tmpPath)` under a
comment claiming the tmp holds "nothing valuable" (false: fully written + fsynced). On a quit-time flush those
are the user's last bytes. The EACCES preserve rationale (Polish 1.1) applies verbatim to its two siblings.
**Fix:** add EPERM + EBUSY to the preserve list; update the M5 toast path (it already regex-parses the preserved
tmp path from the error message) — verify the message format carries the path for these codes too.
**Test:** unit — rename stub exhausts with EPERM → assert tmp NOT unlinked + error message names it.

### 2.3 🟢 MEDIUM ×2 — board scheduler's pre-write ENOENT = silent success (no re-stat parity with config) (DONE 2026-06-11)
**Landed:** re-stat once after `BOARD_ENOENT_RESTAT_DELAY_MS` (150 ms, exported); reappeared → falls
through to the existing drift check (prompt converts the silent loss into a user decision — no board
`lastWritten` cache needed); still missing → genuine-delete clean-no-op preserved; re-stat non-ENOENT
error → falls through so the save IPC surfaces the IO problem.
**File:** `src/renderer/lib/boards/boardWriteScheduler.ts` (~L278–280).
**Mechanism:** pre-write `vault:stat` ENOENT (baseline present) → bare `return` → scheduler resolves SUCCESS,
pending path + sentinel cleaned. A sync-client unlink/recreate blip during an armed write drops the debounce
window's board mutations; if the user quits next, Ctrl+S reported saved and recovery is clean. The config
scheduler closed exactly this class (Audit-6 L24 / Audit-16 4.5: re-stat once → content-verify → baseline
rebase → proceed); the board comment claims "Mirrors the equivalent guard in writeBoardFile" but the parity fix
only ever landed config-side. Bounding nuance: board writes are whole-file from the live cache, so any LATER edit
re-lands everything — loss is bounded to "no further edit before quit/reload".
**Fix:** re-stat once after a short delay; if reappeared → fall through to the EXISTING drift check (which
prompts on mismatch — a board `lastWritten` content cache is not required to convert silent loss into a user
decision); if still missing → treat as the genuine-delete path (current behavior, but see KNOWN acceptance note —
genuine deletes are handled by the watcher delete pipeline).
**Test:** unit — armed write, stat ENOENT once then reappear-stale → assert drift prompt (not silent success);
stat ENOENT twice → current delete semantics preserved.

### 2.4 🟢 LOW — `writeBoardFile` no-handler drift fallback silently resolves `keep-local` (DONE 2026-06-11)
**Landed:** no-handler → `'defer'`, which routes through the existing abort branch (notifyWriteError +
EXTERNAL_EDIT throw; dirty cache survives so the next debounced write re-prompts). Handler-slot
docstring corrected (it also still described a stale boolean protocol).
**File:** `src/renderer/lib/boards/boardWriteScheduler.ts` (~L287).
`const choice = handler ? await handler(boardPath) : 'keep-local'` contradicts the module docstring's claimed
`notifyWriteError` fallback. Today's window is near-zero (handler registers at module load) but nothing pins the
ordering. **Fix:** no-handler → `notifyWriteError` + abort (defer), matching the docstring; or fix the docstring
if keep-local is genuinely intended (it should not be — it silently overwrites an external edit).
**Test:** unit — unregister handler, drift detected → assert abort + error surface, not overwrite.

### 2.5 🟢 LOW ×2 — `uiStore.invokeToastAction` swallows async action failures (console-only) and dismisses immediately (DONE 2026-06-11)
**Landed:** both halves — `invokeToastAction` routes sync throws AND async rejections through
`reportError('toast.action', …)` (errorBus → aggregated toast); the two 6.3 cancel-first handlers
(`promptMarkdownPendingWriteConflict` + `promptPropertiesPopupModified` Reload) reordered to re-read
FIRST with cancellations + store applies in the synchronous tail (the debounce-during-re-read
trade-off this inverts is fronted by the drift gate / pending-path sentinel — refuted finding #5).
**File:** `src/renderer/stores/ui.svelte.ts` (~L422–439).
Covers both "toast-action swallow" and "now-async Reload handlers reject after their destructive synchronous
prefix ran". The L430 comment even references "the unhandled-rejection logger" — which does not exist (2.6).
**Fix (central):** route the catch through `reportError` (errorBus → aggregated toast) instead of `console.error`.
**Fix (ordering, in `vaultExternalPrompts.ts` 6.3 handlers):** perform the awaited re-read FIRST, then run all
cancellations + store applies in the synchronous tail — removes the destructive-prefix-then-reject shape entirely
and shrinks the debounce-fire window back to near-zero.
**Test:** unit — rejecting toast action → assert errorBus event; 6.3 handler with failing re-read → assert the
armed FM write was NOT cancelled (nothing destructive ran).

### 2.6 🟢 LOW — No global `unhandledrejection` / `window.onerror` hook in the renderer (DONE 2026-06-11)
**Landed:** both listeners in `src/renderer/main.ts`, routed through `reportError` → App.svelte's
coalescing errorBus aggregator (registered before mount; pre-mount reports keep the console breadcrumb).
**File:** `src/renderer/main.ts`.
**Fix:** ~5 lines — backstop listeners routed through the existing `errorToastAggregator` (rate-limited,
count-badged). Class-level hardening for unknown-unknowns; today's audited write paths all route through
`trackComponentWrite`/`markPathFailed`.

### 2.7 🟢 LOW — `runPostCommitTasks` index-rebuild follow-up chain has no `.catch` (DONE 2026-06-11)
**Landed:** `.catch` → `reportError('vault.postCommit', …)`, matching the sibling vault:watch task.
**File:** `src/renderer/stores/vault.svelte.ts` (~L504–584).
`void rebuild(...).then(async () => { ...~80 lines... })` — `rebuild()` itself cannot reject (internally caught)
and the per-file reads retry transient failures, so the realistic surface is a programming error in the callback
becoming a console-only unhandled rejection. **Fix:** one-line `.catch((e) => reportError('vault.postCommit', e, …))`
hygiene, matching the sibling vault:watch task.

---

## Phase 3 — Lifecycle, vault-swap, and recovery correctness (ALL 3.1–3.8 DONE 2026-06-11; tests in `audit17Phase3.test.ts`, every fix bite-verified, no file-size ceiling bumps)

### 3.1 🟢 MEDIUM — Failed FIRST vault open leaves the main-process registry armed at the failed path (all other vaults locked out until restart) (DONE 2026-06-11)
**Files:** `src/renderer/stores/vault.svelte.ts` (`openVault` catch ~L1197–1206, `newVault` ~L1307–1322),
`src/main/ipc/board.ipc.ts` (`vault:init-config` ~L91–138).
**Mechanism:** init-config arms `vaultRegistry.setCurrentVault(vaultRoot)` and only rolls back if
`initVaultConfig` itself throws; a later candidate-load failure leaves it armed. `revertToOutgoingVault` (the
only failure-path `vault:close`) fires only `if (outgoingVaultPath)` — null on a first open. Retrying the SAME
vault still works (idempotent re-arm); any OTHER vault fails every `assertActiveVault`-gated IPC until restart.
`newVault()` shares the hole through its own pre-openVault init-config.
**Fix:** in both catches, when `outgoingVaultPath` is null, best-effort `void invoke('vault:close')` (one line
each) to release the registry.
**Test:** unit — first open fails post-init-config → open a different vault → succeeds.
**Done (2026-06-11):** shared `releaseRegistryBestEffort()` helper in `vault.svelte.ts`; the `openVault`
candidate-load catch calls it on the no-outgoing-vault branch, and the `newVault` catch calls it when
`!currentProject` (never yanks a live vault's registry). Bite-verified via `audit17Phase3.test.ts` (failed
first open of A → B opens fine; registry simulated as in `vaultSwapRevertsOnFailedOpen.test.ts`).

### 3.2 🟢 MEDIUM — Open-time repair writes REPLACE a genuine prior-crash `.filo/.dirty` payload before recovery reads it (DONE 2026-06-11)
**Files:** `src/renderer/lib/vault/dirtyFlagRecovery.ts` (`markDirty` ~L164–205),
`src/renderer/stores/vault.svelte.ts` (commit ~L394–401, sequencer step 1 ~L716),
`src/renderer/lib/boards/writeStateTracking.ts` (`refreshSentinel` ~L323–328).
**Mechanism:** `commitVaultCandidate` marks loader-repaired boards dirty → `beginWrite` at schedule time →
`refreshSentinel` fires `markDirty` which **replaces** (never merges) the on-disk sentinel with THIS session's
pending set, stamped with this LAUNCH_ID — so the Audit-16 3.3 suppression then hides the prior crash entirely
and the unflushed-paths list is destroyed before `checkRecovery` (sequencer step 1) reads it. Structural flaw:
nothing reads the sentinel pre-commit; repairs are merely today's only vector — ANY future write scheduled
between commit and step 1 widens the hole.
**Fix (the verifier-endorsed shape):** read + stash the prior sentinel payload PRE-COMMIT (before any write can
fire), and have `checkRecovery` consume the stashed copy. Optionally make `markDirty` merge-or-preserve a
foreign-launchId payload until recovery has consumed it.
**Test:** unit — prior-crash sentinel on disk + a repair write scheduled at open → assert recovery modal lists
the crash's paths.
**Done (2026-06-11):** the verifier-endorsed stash shape. `stashRecoveryStatusBeforeCommit(vaultRoot)`
(dirtyFlagRecovery.ts) reads the sentinel and stashes it; `loadVaultCandidate` calls it right after
`vault:init-config` (registry must be armed for the read), i.e. before ANY write of the new open can fire;
`checkRecovery` consumes the single-use stash (cleared on every call so an aborted open can't leak one).
KEY NUANCE the plan didn't name: the stashed read SKIPS the A14-1.3/A16-3.3 launchId+generation self-write
suppression — pre-commit the generation hasn't been bumped yet, so a Don't-Save-preserved sentinel from a
previous open of the SAME path in the same process matches both and would be wrongly swallowed; pre-commit,
any sentinel is by definition a prior session/open's and must prompt. `markDirty` merge was left as-is
(optional half) — the stash covers the read; tests pin both the preserved payload and the
suppression-skip. Bite-verified in `audit17Phase3.test.ts` (incl. a control pinning the live-read
suppression still works).

### 3.3 🟢 MEDIUM — Esc/X/backdrop on the Recovery modal parks the recovery sequencer forever (DONE 2026-06-11)
**Files:** `src/renderer/stores/vault.svelte.ts` (`awaitRecoveryDismiss` ~L177–185, sequencer ~L716–747+),
`src/renderer/components/modals/RecoveryFiles.svelte`.
**Mechanism:** the sequencer `await dismissed` resolves ONLY via `acknowledgeRecovery`; Esc/X/backdrop
deliberately bypass it → steps 2–4 (tag-rewrite Resume/Discard, rename-cascade retry, snapshot listing) never run
that session — a vault mid-tag-rename stays split with no prompt. The "preserved for next launch" assumption is
also false: the first `beginWrite` REPLACES the sentinel (see 3.2 — fixing 3.2's merge/stash also fixes this leg).
A second `openVault` un-parks the orphaned sequencer (D.4 stale-resolver release) but only for the NEW open.
**Fix:** make Esc/X/backdrop resolve the same gate as acknowledge (dismiss-is-acknowledge), OR have the modal's
close path call `acknowledgeRecovery()` explicitly. The sentinel-preservation half rides on 3.2.
**Test:** unit — recovery modal up + pending tag-rewrite sentinel → Esc → assert sequencer steps 2–4 still run.
**Done (2026-06-11):** dismiss-is-acknowledge via the Modal's existing `beforeClose` hook in AppShell
(`beforeClose={async () => { await vaultStore.acknowledgeRecovery(); return true; }}`) — covers Esc, X, and
backdrop in one place (all three route through Modal's `tryClose`). `acknowledgeRecovery` is safe to run on
every close path (second call no-ops: paths cleared, resolver consumed). Stale "sentinel survives Esc"
comments rewritten in RecoveryFiles.svelte / vaultRecovery.ts / `awaitRecoveryDismiss`; the
sentinel-preservation half rides on 3.2's stash as planned. Test: source-pin of the AppShell wiring in
`audit17Phase3.test.ts` (the sequencer-resolver mechanics are already covered by
`recoveryDismissedResolverIdentity.test.ts` / `vaultRecovery.test.ts`).

### 3.4 🟢 MEDIUM — `withDrainedWrites` treats CONCURRENT sibling calls as nested (second disk-shape op runs with NO drain) (DONE 2026-06-11)
**File:** `src/renderer/lib/vault/vaultOperations.ts` (~L113, L137–148).
**Mechanism:** single module slot `drainingGeneration` set synchronously before the awaited drain; a sibling call
during the park (up to ~60 s behind a board drift prompt) sees the same generation and takes `return op()` with
no drain. Concurrency is watcher-driven (`handleExternalRename` also calls this), not only user-paced.
Blast-radius containment verified: gateway markdown writes use the no-create channel and board resurrection is
blocked by the ENOENT abort (2.3) — fix 2.3 without re-opening this.
**Fix:** queue siblings on a per-generation `drainPromise` (`if (drainingGeneration === gen) await drainPromise`
then proceed with their own op) instead of the bare `return op()`.
**Test:** unit — two concurrent `withDrainedWrites` with a slow drain → assert the second op runs only after the
drain resolves.
**Done (2026-06-11):** per-generation `drainPromise: Promise<boolean>` (never rejects; settled `true` when the
drain completes clean — BEFORE the outer op runs — and `false` from the `finally` when the drain threw). A
call seeing its own generation in-flight awaits it: `true` → run op (a genuinely NESTED call sees an
already-settled `true`, preserving the old short-circuit exactly); `false` → re-enter `withDrainedWrites`
recursively so the sibling runs + surfaces its OWN drain (re-capturing the generation in case a swap landed
while parked). Guard + promise cleared together in the owner-checked `finally`. Both branches bite-verified
in `audit17Phase3.test.ts` (parked sibling doesn't run early; failed-drain sibling neither hangs nor skips
its own drain); existing `vaultOperationsDrain.test.ts` nested/IPC-wrapper matrix still green.

### 3.5 🟢 LOW — `vault:watch` TOCTOU: re-arms the registry + starts a watcher after two awaits with no re-assert (DONE 2026-06-11)
**File:** `src/main/ipc/vault.ipc.ts` (~L400–436).
**Mechanism:** assert → `await stat` → `await activeWatcher.stop()` → UNCONDITIONAL `setCurrentVault` + new
FileWatcher. A `vault:close` (or rapid A-open→swap-to-B) completing inside the window is silently reversed —
worst variant re-arms A after B's init-config armed B, failing every gated write of B's session.
**Fix:** main-side epoch: capture a registry epoch/path before the awaits, re-check after each; bail (and do NOT
start the watcher) on mismatch. Mirrors the renderer's `isStillSameVault` discipline.
**Test:** unit (main) — interleave close during watch's awaits → assert registry stays closed, no watcher started.
**Done (2026-06-11):** `vaultRegistry` gains a monotonic `epoch` (bumped on EVERY `setCurrentVault` — open,
close, re-arm — so a same-path close→reopen is caught where a path compare passes). `vault:watch` captures
the epoch after `assertActiveVault`, re-checks after the `stat` await (also keeps a stale call from stopping
the NEW vault's running watcher) and after `activeWatcher.stop()`, throwing into the handler's existing
failure envelope on mismatch. Bite-verified in `audit17Phase3.test.ts` (close-during-stat → registry stays
null; swap-to-B-during-stat → registry stays B; undisturbed control still succeeds), driving the real
registered handler with electron mocked (the `vaultWatchRequiresActiveVault.test.ts` harness).

### 3.6 🟢 LOW — External-rename cascade silently dropped when the pre-cascade drain fails; reconcile-originated renames are never re-synthesised; fileTags then pruned permanently (DONE 2026-06-11)
**File:** `src/renderer/stores/vaultExternalChanges.ts` (~L561–573).
**Mechanism:** on `PendingWritesFailedError` the handler returns with only the drain's toast — no
`renameBoardPath`, no `propagateRename`, no `fileTagsStore.renameFile`, and **no rename-cascade sentinel**.
`fileWatcher.ts` advances the reconcile snapshot BEFORE synthesised events debounce, so a walk-surfaced rename is
never re-synthesised; on next open `pruneOrphanFileTags` drops the old path's attachment tags (vault-local —
permanently lost). Board refs ARE surfaced via broken-ref badges; only the tags are silent.
**Fix:** write the rename-cascade sentinel BEFORE the early return (matches the success path's step-8
"sentinel BEFORE the flush" discipline) so next-open recovery replays the cascade.
**Test:** unit — drain fails during external-rename handling → assert sentinel on disk naming old→new.
**Done (2026-06-11):** `handleExternalRename`'s `PendingWritesFailedError` catch now lays the rename-cascade
sentinel (best-effort, own try/catch + reportError) with `affectedBoardIds: []` + `tagsAffected: true` —
sufficient because `repairRenameCascade` recomputes the affected boards itself from oldPath/newPath and
re-asserts tags idempotently. The vault root is captured PRE-drain and the write is gated on
`isStillSameVault(captured)` (a swap during the drain must not plant the breadcrumb in the new vault; the
gated IPC would refuse anyway). Bite-verified in `audit17Phase3.test.ts`.

### 3.7 🟢 LOW — `writePendingRenameCascade` clobbers an UNREADABLE sentinel (DONE 2026-06-11)
**File:** `src/renderer/lib/vault/renameCascadeSentinel.ts` (~L240–243).
`const entries = existing.entries ?? []` replaces an unreadable (torn/zero-byte/transient-EACCES) sentinel with a
fresh single-entry file — dropping the crash breadcrumb AND (on a transient AV-lock read) any OTHER healthy
in-flight entries. The siblings (`clearPendingRenameCascade`, `markRenameCascadeFlushFailed`) already bail on
`!existing.entries` — the append path is the one oversight. **Fix:** refuse to clobber on `unreadable` (preserve
file, surface a toast); only append when the read genuinely parsed.
**Test:** unit — corrupt sentinel + new cascade → assert original bytes preserved.
**Done (2026-06-11):** the append path now bails on `existing.unreadable` — reportError (toast names the
preserved file) + throw, never writing. The throw lands in each caller's existing sentinel-failure handling:
the in-app rename (`vaultFolderOps`) reports "proceeding without crash protection", the external-rename
sites report and continue, matching the plan's preserve+surface shape. Bite-verified in
`audit17Phase3.test.ts` (torn sentinel → reject + zero writes; parseable sentinel → appends keeping the
existing entry).

### 3.8 🟢 LOW — Recovery snapshot same-ms basename collision + cross-folder pruner conflation (DONE 2026-06-11)
**File:** `src/main/services/recoverySnapshot.ts` (~L108–112, `pruneOldSnapshotsForBasename` ~L174–237).
Two legs: (a) `destAbs = join(destDir(ms-timestamp), basename(rel))` discards the folder — two same-basename
snapshots in the same ms silently keep one; (b) the pruner matches on basename across ALL timestamp dirs, so
20+ snapshots of `folderB/Notes.md` deterministically evict every copy of the unrelated `folderA/Notes.md`
(no race needed — the more reachable leg). **Fix (one change covers both):** flatten the relative path into the
snapshot filename (e.g. `folderA__Notes.md`) and key the prune on that.
**Test:** unit — snapshot `a/N.md` + `b/N.md` same ms → both preserved; 25 prunes of one → other untouched.
**Done (2026-06-11):** `flattenSnapshotName(rel)` (segments joined with `__`, defensive keep-the-tail
truncation at 180 chars) drives BOTH the dest filename and the per-name prune key, covering both legs with
one change as planned. Follow-ons the plan didn't name: the `listRecoverySnapshots` L13 sentinel filter now
matches the final `__`-segment as well as the bare name (a snapshotted `.filo/.dirty` is now
`.filo__.dirty`), and legacy bare-basename snapshots still list/prune (the global cap covers their tail).
Existing `recoverySnapshot.test.ts` suite unchanged-green (its nested-basename case asserts a suffix, which
the flattened name still satisfies). Bite-verified in `audit17Phase3.test.ts` (same-ms two-folder collision +
cross-folder prune isolation + flattened-sentinel filtering).

---

## Phase 4 — UI/UX silent-loss paper cuts (ALL 4.1–4.6 DONE 2026-06-11; tests in `audit17Phase4.test.ts` — 25 tests, behavioral fixes bite-verified, source-shape pins red-by-construction vs the pre-fix code; ci:verify green, NO file-size ceiling bumps)

**Implementation note discovered during 4.1/4.2/4.4:** the plan's commit/revert-at-teardown sketches assumed the
pane's stores still resolve the tile/frame — but on the headline tab-switch repro the scope ALREADY points at the
switched-in board by teardown time, so `boardStore.updateTile`/`updateFrame`/`renameTextTileBackingFile` would
silently no-op. All three teardown paths therefore dual-route: the scope stores while the board is still active
(keeps spatial in sync), else the board CACHE keyed by the home board (`tile.boardId` / `frame.boardId` / a
`dragHomeBoardId` captured at drag start) — `boardCacheStore.persistUpdateTile/persistUpdateFrame` resolve
detached. `renameTextTileBackingFile` gained an optional `homeBoardId` cache-fallback param. No teardown path
pushes history (mid-swap the global active stack can't be trusted — the 4.4 rule, applied uniformly).

### 4.1 ✅ MEDIUM — Tile title rename silently discarded when the tile unmounts inside the 200 ms blur→commit window
**File:** `src/renderer/components/tiles/TileHeader.svelte` (onBlur ~L189–203, unmount cleanup ~L222–227).
**Mechanism:** blur arms a 200 ms `blurCommitTimer`; the Audit-11 R3 unmount cleanup clears it and tears the
editor down — cancel, never commit. Clicking another tab/board both blurs AND unmounts within ms, so the rename
(including the backing `.md` file rename) silently never happens. R3 traded a fire-against-torn-down-editor bug
for this drop.
**Fix:** in the unmount cleanup, if a blur-commit is armed: snapshot `getText()`/`getHTML()` BEFORE
`destroyTitleEditor()`, clear the timer, and commit synchronously (the non-text branch is a pure store update;
the text branch's rename is already async-safe via `renameTextTileBackingFile`).
**Test:** component (jsdom) — type title → blur → unmount within 200 ms → assert rename committed.
**DONE 2026-06-11:** teardown snapshots via new shared `lib/editor/titleCommit.ts` (`resolveTitleCommitValues`)
before `destroyTitleEditor()`, then `applyTitleCommit(snap, true)`. The jsdom suite has no component-mount
harness (established repo constraint), so the test is the detached rename behavior (home-board cache fallback,
bite-verified) + a source-shape pin of the snapshot→clear→destroy→commit order.

### 4.2 ✅ LOW — Frame title rename: same unmount loss + the blur `setTimeout` is anonymous and uncleared
**File:** `src/renderer/components/frames/Frame.svelte` (onBlur ~L218–224, cleanup ~L238).
Same class as 4.1 (smaller blast radius — frame titles live only in `.board.json`); also stacks timers on
repeated blur/focus (self-guarding, so waste only). **Fix:** same commit-on-unmount shape as 4.1 + store/clear
the timer handle (the R3 treatment Frame never got). Do 4.1 + 4.2 in one pass to close the class.
**DONE 2026-06-11:** `blurCommitTimer` stored/cleared (satisfies `ci:component-timer-cleanup`); teardown commit
writes via `boardCacheStore.persistUpdateFrame` (no history push — see the phase implementation note).

### 4.3 ✅ LOW — Frame drag-end's "flush final position" is dead code (flag flipped before flush)
**File:** `src/renderer/components/frames/Frame.svelte` (`handleDragEnd` ~L352–361, `flushDragMove` guard ~L324).
`isDragging = false` runs BEFORE `flushDragMove()`, whose first guard is `if (!isDragging) return` — the pointer
motion since the last RAF tick is dropped (sub-frame inaccuracy; the MoveFrameCommand uses the last RAF-written
position so undo stays consistent). **Fix:** one-line reorder — flush before flipping the flag. (Resize path has
no RAF throttle; not affected.) **DONE 2026-06-11** (ordering pinned by a source-shape test).

### 4.4 ✅ LOW — 6.1 unmount-mid-drag teardown leaves persisted frame+tile moves with NO undo command
**File:** `src/renderer/components/frames/Frame.svelte` (unmount `$effect` ~L433–440, uncommitted).
**Mechanism:** the drag writes incrementally per RAF (`updateFrame` + `moveContainedTiles`); only `handleDragEnd`
pushes `MoveFrameCommand`. The new teardown clears flags + `endBatch()` but neither reverts nor commits — and its
comment ("mirrors tileDrag's destroy() cancel-not-commit") is wrong: `tileDrag.destroy()` RESTORES every captured
start position precisely because "a half-committed move would corrupt undo".
**Fix:** true cancel, matching tileDrag — revert the frame to `dragStartPosX/Y` and move `dragContainedTileIds`
back by the inverse delta BEFORE `endBatch()`. (Do NOT push a command from a teardown `$effect` — risks pushing
onto a history stack mid-board-swap.) Update the comment.
**Test:** unit — begin drag, move, unmount → assert frame + contained tiles back at start positions.
**DONE 2026-06-11:** revert extracted to `lib/frames/frameDragCancel.ts` (`revertFrameDragOnTeardown`, DI'd
write surface — behaviorally tested incl. the locked-tile skip: `moveContainedTiles` never moved locked tiles,
so the inverse delta must skip them too). Comment corrected; `spatialStore.endBatch()` kept after the revert
(the `ci:pointer-capture-cleanup` Frame anchor still sees ≥2 endBatch sites).

### 4.5 ✅ LOW — `lastView` persist debounce cancelled-without-flush on every board switch (TaskListBoard + KanbanBoard)
**Files:** `src/renderer/components/boards/TaskListBoard.svelte` (~L1136–1173), `KanbanBoard.svelte` (mirror).
**Mechanism:** the persist `$effect` cleanup does `clearTimeout` with no flush (deliberate DI-08 wrong-board-write
fix that traded in this drop); after a switch the `hydratedForBoardId` guard blocks any re-fire — a filter /
smart-list / showCompleted change within 300 ms of switching is never written.
**Fix:** capture the board id in the effect closure and flush synchronously on teardown FOR THAT ID (the DI-08
hazard was writing to the wrong board, not flushing per se); the existing JSON-equality guard makes it a no-op
when nothing changed. The canvas viewport path already demonstrates the safe flush-on-teardown pattern in-tree.
**Test:** unit — change filter → switch board within 300 ms → assert lastView persisted for the OLD board.
**DONE 2026-06-11:** new `lib/boards/lastViewFlush.ts` (`flushLastViewForBoard` — cache write keyed by the
CAPTURED id via `boardCacheStore.updateBoardSettings`, JSON-equality no-op guard). Both effects now snapshot
the slice at ARM time (a teardown can run AFTER the next board's hydrate re-seeded the filter state — building
at flush time would stamp the NEW board's view onto the old id) and flush it in both the timer body and the
cleanup. TaskList's `filters.dispose()` (onDestroy) also flushes, so the unmount path is covered regardless of
teardown-vs-onDestroy ordering; whichever runs first nulls the timer. Kanban additionally GAINED the
JSON-equality guard it never had. Behaviorally tested (incl. dispose-flush, bite-verified) + source pins.

### 4.6 ✅ LOW — Running TimerTile countdown unrecoverable on quit and on vault swap
**File:** `src/renderer/components/tiles/TimerTile.svelte` (~L240–258).
**Mechanism:** quit never unmounts the Svelte tree (onDestroy never runs) and a running countdown deliberately
arms no write (Audit2 4.1); on swap the pre-swap `boardCache.clear()` runs BEFORE unmount so onDestroy's
`updateTile` can't resolve a board. Pure transient state — lowest priority in this phase.
**Fix:** coarse periodic persist (30–60 s cadence) of `remaining` while running — at that cadence the board
debounce flushes between ticks, so the original per-100 ms 4.1 bug is NOT re-introduced. Optionally also persist
from the quit drain via a registered flusher.
**Test:** unit — run timer 90 s with fake timers → assert ≤2 writes and `remaining` on disk within 60 s of truth.
**DONE 2026-06-11:** new `lib/utils/coarsePersistGate.ts` (`createCoarsePersistGate`, 45 s cadence — armed per
RUNNING countdown in the interval $effect, consulted in `tick()`'s running branch). Test: simulated 90 s of
100 ms ticks → exactly 2 fires (45 s / 90 s) + staleness bound ≤ cadence. The optional quit-drain flusher was
NOT taken (the 45 s bound already caps the loss; a registered flusher would re-couple the timer to the drain
path Audit2 4.1 decoupled). The re-seed $effect's "running never writes tile.remaining" comment updated — the
coarse persist's echo re-seeds by at most one 100 ms tick.

---

## Phase 5 — Narrow-window hardening + engine edges (LOW) — ALL 5.1–5.8 DONE 2026-06-11

**Status (2026-06-11):** all eight items implemented; full `ci:verify` GREEN end-to-end
(lint → svelte-check → test:unit:strict → build → 47 guards). Tests: `audit17Phase5.test.ts`
(8 tests: 5.1/5.2/5.4/5.5), the 5.3 same-byte-size case folded into `postWriteBaselineToctou.test.ts`,
and a 5.8 dispatcher case in `vaultExternalChanges.test.ts`. ONE documented ceiling action:
`writeScheduler.ts` held under its hard 1000-LOC limit by comment trimming (sat at exactly 1000);
`markdownFileWriter.ts` allowlist bumped 1369→1392 for the 5.3 read-back + 5.5 parked-aware guard
(documented, matching the file's per-audit bump history — it remains a structural-split candidate).

### 5.1 🟢 `valuesEqual` / `valuesShallowEqual` treat NaN ≠ NaN — `.nan` keys churn on every unrelated edit (DONE 2026-06-11)
**Files:** `src/renderer/lib/vault/frontmatterEngine.ts` (~L33–67), `frontmatterDelta.ts` (~L153–172).
An untouched `.nan` key is flagged changed on every edit: scalar → spelling-canonicalised; collection containing
NaN → `rebuildPair`, permanently dropping that pair's inner comments/flow formatting (an untouched-key
byte-preservation violation). **Fix:** `Number.isNaN(a) && Number.isNaN(b) → true` in both helpers.
**Test:** add `.nan` rows to the frontmatter-invariant corpus (scalar + inside a list).

### 5.2 🟢 CST engine value-splice keeps a YAML `!!tag` token while replacing the value (DONE 2026-06-11)
**Done:** `sourceTokensHaveAnchor` → `sourceTokensHaveAnchorOrTag` (detects `'tag'` SourceTokens
in `start`/`sep`); the L27 refusal walk (`itemHasAnchorAliasOrTag`) now routes a CHANGED/DELETED
tagged key to the full-dump fallback (returns `null`), while an UNTOUCHED tagged scalar stays
byte-exact. Bite-verified (neutralising the `'tag'` check → the touched/deleted-tagged-scalar tests go red).
**File:** `src/renderer/lib/vault/frontmatterCstModel.ts` (`itemHasAnchorOrAlias` ~L101–121, `rebuildPair`).
A `tag` SourceToken in `item.sep` is invisible to the L27 refusal walk → Filo emits e.g. `priority: !!int high`.
Filo's own read survives (`parseInt`→NaN — silent corruption) but js-yaml-based tools (Obsidian) throw on the
file. `rebuildPair` silently DROPS a sep-tag rather than refusing. Trigger requires an externally-authored
explicit tag — rare. **Fix:** treat `'tag'` like `'anchor'` in the refusal walk (refuse→dump covers both paths,
matching the documented anchor semantics). **Test:** corpus rows — touched tagged scalar → dump path, untouched
tagged scalar → byte-exact.

### 5.3 🟢 Gateway post-write baseline TOCTOU is size-only (DONE 2026-06-11)
**Done:** on a size match the gateway now reads the bytes BACK (`vault:read-file-text`) and stamps
the baseline ONLY when disk holds EXACTLY what we wrote (`readBack.content === fileText`); any
content mismatch / unreadable read-back keeps the prior baseline (DI-14) so the next write's drift
gate re-detects + prompts. One extra read on the (common) size-match path. Test: the same-byte-count
foreign-write case in `postWriteBaselineToctou.test.ts` (+ the existing baseline tests' mocks updated
to model the post-write read-back).
**File:** `src/renderer/lib/vault/markdownFileWriter.ts` (~L882).
A same-byte-count foreign replacement inside the write→stat gap (and self-write suppression TTL) becomes the
baseline → next write clobbers promptless. Few-ms window + exact-size requirement = near the irreducible-residual
class. **Fix:** on size match, cheap content-hash compare (read-back or carry the written hash) before stamping;
on mismatch keep the prior baseline (drift gate then prompts). Document if instead accepted as a known limitation.

### 5.4 🟢 Board + config post-write baseline stamps lack the gateway's L5 written-bytes verify (DONE 2026-06-11)
**Done:** both `writeBoardFile` and `writeConfigs` now stamp the post-write baseline ONLY when
`postStat.size === writtenByteLength(payload)`, else keep the prior baseline (mirrors the gateway's
Audit-7 L5 guard). Shared `writtenByteLength` helper added to the dependency-free `boardWriteDebounce.ts`
leaf. Test: the board foreign-size case in `audit17Phase5.test.ts`.
**Files:** `boardWriteScheduler.ts` (~L336–337), `configWriteScheduler.ts` (~L444–445).
Both call `refreshBaselineAfterWrite` with whatever the post-save stat returns — a foreign write in the save→stat
gap becomes Filo's own baseline (the `isLatestWrite` gate covers only superseded SELF-writes). **Fix:** mirror the
gateway — stamp only when `postStat.size === writtenByteLength(payload)`, else keep the prior baseline.
**Test:** unit — foreign stat in the gap → baseline unchanged → next write prompts.

### 5.5 🟢 Gateway markClean guard + pending probe miss PARKED fires (DONE 2026-06-11)
**Done:** new `scheduler.hasParked(predicate)` (kept SEPARATE from `hasPendingTimer`, whose P2.5
armed-timer-only contract a test pins) iterates non-cancelled parked entries by `{ key, path }`.
The gateway's markClean guard (`info.key === callerId`) AND the `registerPendingProbe` path probe
(`info.path` case-folded) now OR it in, so write N's settle can't markClean / report idle while a
parked write N+1 is unsaved. Test: `hasParked` vs `hasPendingTimer` in `audit17Phase5.test.ts`.
**Files:** `markdownFileWriter.ts` (~L221–224, ~L928), `writeScheduler.ts` (fire/park ~L522–575).
A timer fire deletes its `pending` key then parks behind `drainPriorInFlight` — during the park `hasPendingTimer`
is false, so write N's settle markCleans the doc while parked write N+1's keystrokes are unsaved. Contained:
the pending-path sentinel keeps `isPathPending` true, so only `doc.isDirty` is transiently wrong.
**Fix:** track parked fires (an `inFlightOrParked` set keyed per path) and have both probes consult it.
**Test:** unit — park write N+1 behind slow N → assert no markClean until N+1 settles.

### 5.6 🟢 6.3 polish trio (uncommitted handlers in `vaultExternalPrompts.ts`) (DONE 2026-06-11)
**Done:** (a) `promptMarkdownPendingWriteConflict`'s no-editor Reload branch now cancels any
surviving gateway writer (`getDirtyInstancesForPath` → `cancelMarkdownWrite` + `clearPropertiesPopupDirty`)
BEFORE re-anchoring the baseline, mirroring its two siblings — a dirty popup write can no longer ride
the re-anchored baseline past the drift gate. (b) both F4 Reload handlers capture `wasIndexed`
pre-`applyChanges` and BAIL when the re-read returns undefined for a previously-indexed path (a
deletion — the watcher delete pipeline owns teardown), keeping the documented `?? next` fallback only
for the never-indexed transient case. (c) handled by 2.5's re-read-first reorder (already done).
(a) **F4 Reload no-editor branch:** also cancel gateway writers via `getDirtyInstancesForPath(rel)` +
`cancelMarkdownWrite` (mirror its two siblings) — or gate the new `noteBaseline` on `!isPathPending(rel)` —
so a surviving armed popup write can't ride the re-anchored baseline past the drift gate. The constructed
survivor (dirty popup over a never-loaded doc whose external edit changed body+FM) clobbers only the delta's FM
keys (body assembles from fresh disk), keeping this LOW.
(b) **Deleted-file fallback:** distinguish "getMetadata returned undefined AFTER applyChanges" (file gone — skip
all store mutations + baseline stamp; the delete pipeline owns it) from "never re-read" (~3 lines). The `?? next`
fallback itself is a documented decision — keep it for the transient case.
(c) Handler ordering — covered by 2.5's re-read-first reorder.

### 5.7 🟢 6.7 residual: keystrokes typed during the close-confirm can still die if the SECOND flush also fails (DONE 2026-06-11)
**Done (the verifier-endorsed "make editors read-only" shape):** new reactive `closeDrainGate.svelte.ts`
(`runWithCloseDrain(fn)` raises a `$state` `draining` flag with try/finally depth-counting so a cancel /
throw can never strand it; resets on vault swap via `onVaultSwap`). `tabs.close` + `tabs.closeOthers`
wrap their whole drain → confirm → re-drain window in it. Both TipTap editors (DocumentEditor + TextTile)
`$effect`-watch the flag and `editor.setEditable(false)` while it's raised, so no keystroke is accepted
during the close window — removing the re-arm window instead of chasing it with more flush passes.
(Quit not separately wired — its `flushAll` already bounds writes; the documented repro is tab close.)
**File:** `src/renderer/stores/tabs.svelte.ts` (~L285–289, closeOthers ~L367–371).
Strictly better than pre-6.7 (which destroyed them with no second attempt), not fully silent (toast + `.dirty`
sentinel fire) — but the unmounted editor's bytes are gone and recovery offers only old disk content.
**Fix (one mechanism, also covers closeOthers + quit):** make the affected editors read-only once the close drain
begins (visual "saving…" state), removing the re-arm window instead of chasing it with more flush passes.
**Test:** component — begin close with failing disk → keystroke during confirm → assert input refused.

### 5.8 🟢 (verifier-added) FM-only external edit with a dirty Properties popup over a never-loaded doc is silently dropped (DONE 2026-06-11)
**Done:** the dispatcher's `prompt-user` arm now routes to `promptPropertiesPopupModified(rel, next, null)`
when `editorDoc == null` AND the classifier reason is `properties-popup-dirty` (the classifier already
returns that regardless of editor state). `promptPropertiesPopupModified`'s signature relaxed to
`editorDoc: DocumentState | null`, with its title label + `documentStore.setFrontmatter` guarded on
`editorDoc` presence. Test: the never-loaded-doc case in `vaultExternalChanges.test.ts`.
**File:** `src/renderer/stores/vaultExternalChanges.ts` (dispatcher prompt-user case requires `editorDoc`).
Classifier says prompt-user; the dispatch arm requires an open editor doc, so the popup case falls through
silently. **Fix:** allow the `promptPropertiesPopupModified` route when `getDirtyInstancesForPath(rel)` is
non-empty even with `editorDoc == null` (the prompt only needs the rel + metadata; guard its
`documentStore.setFrontmatter` call on docId presence).
**Test:** unit — dirty popup, no loaded doc, external FM edit → assert prompt raised.

---

## Phase 6 — Gates, tests, and process net — ALL DONE 2026-06-11

### 6.1 🟢 LOW — 7.1 gate's `SILENT_READONLY` regex: false-positive on negated guards, false-negative on nested parens (DONE 2026-06-11)
**Done:** in `check-no-silent-write-abort.mjs` — added a nested-paren positive (`isReadOnly(idOf(tile)))`)
to `readOnlyShouldMatch` and the negated guard (`if (!readOnlyDoc) return;`) to `readOnlyShouldNotMatch`
FIRST, then fixed the regex: the `isReadOnly(...)` arm allows ONE level of balanced nesting and the alias
arm gained a `(?<![!\w])` lookbehind so `!readOnlyDoc` no longer trips. The embedded self-test harness
passes on every run; the real scan stays green.
**File:** `scripts/check-no-silent-write-abort.mjs` (~L327–328, fixtures ~L382–395).
`if (!readOnlyDoc) return;` (safe) would go red; `isReadOnly(idOf(tile))) return` (dangerous) slips the
`[^()]*` arm and the alias arm can't rescue it (no word boundary inside `isReadOnly`). No runtime effect today.
**Fix (self-verifying via the embedded fixture harness):** FIRST add `if (!readOnlyDoc) return;` to
`readOnlyShouldNotMatch` and a nested-paren positive to `readOnlyShouldMatch`, THEN adjust the regex
(`(?<![!\w])` lookbehind is supported by Node).

### 6.2 🟢 Anti-regression tests (DONE 2026-06-11)
**Done:** `audit17Phase5.test.ts` created (8 tests — 5.1 NaN equality + delta + CST scalar; 5.2 tag
refuse/preserve/delete; 5.5 `hasParked`; 5.4 board foreign-size baseline). 5.3 folded into
`postWriteBaselineToctou.test.ts`; 5.8 into `vaultExternalChanges.test.ts`. `tagsReconcileLoop.test.ts`
(0.2) + `audit17Phase1.test.ts` + `audit17Phase2.test.ts` + the `check-reconciler-vault-guard.mjs`
Part-3 extension all already landed (see below). Full unit suite: 4642 green.

Each phase item above names its test; the load-bearing new suites to create:
- `audit17Phase1.test.ts` — 1.1 blind-merge round-trips (undo + redo legs), 1.2 click-time body re-resolve,
  1.4 rollback-on-failure. **(DONE 2026-06-11 — 10 tests incl. 1.3 swap-bail ×2, the 1.1 no-false-conflict
  counter-case + nothing-visible legacy corner; every describe bite-verified by temp-reverting its fix.)**
- `audit17Phase2.test.ts` — 2.1 flush-failure honesty matrix (isDirty / popup-dirty / degraded mode),
  2.2 tmp-preserve on EPERM/EBUSY, 2.3 board ENOENT re-stat → drift prompt. **(DONE 2026-06-11 —
  15 tests; also covers 2.4 no-handler abort + 2.5 errorBus routing + the 6.3 re-read-first reorder
  (failing re-read leaves the armed FM write / popup dirty tracking intact). All five describes
  bite-verified by temp-reverting their fixes → 13 reds, success-path counter-cases stayed green.)**
- `tagsReconcileLoop.test.ts` — 0.2 (the must-fix): self-write → synthesized config-tags event → no toast,
  no echo save; genuine external diff → toast + reload.
- Extend `check-reconciler-vault-guard.mjs` Part 3 with `applyFrontmatterPatchRebased` (1.3) and bite-verify.
  **(DONE 2026-06-11 — pinned; bite-verified by stripping the body's `isStillSameVault` tokens → exit 1.)**

### 6.3 🟢 Consider for the gate net (optional, post-fix) — ASSESSED 2026-06-11, both deferred (no new gate)
- A "toast handlers that write must capture vault identity" sweep is the 1.3 class generalised — assess after 1.3
  whether more sites exist before building it. **Assessed:** the 1.3 pin (`applyFrontmatterPatchRebased` in
  `check-reconciler-vault-guard.mjs` Part 3) already covers the one known commands-file toast-write site; no
  further sites surfaced. A generalised sweep would over-fit a single case — DEFERRED until a second site appears.
- A `flushX-must-propagate-failure` token pin on `flushMarkdownWrite` once 2.1 lands (same shape as
  `ci:awaited-writes-bounded`). **Assessed:** the 2.1 honesty contract is behaviorally pinned by
  `audit17Phase2.test.ts` (flush-failure matrix). A token gate adds marginal value over the behavioral
  matrix; DEFERRED to avoid a brittle source-shape pin on a one-file API.

---

## Refuted findings (do NOT re-chase; archived for future audits)

1. **Same-basename rename correlation ≥10 MB size-only merge** — the same-basename pass is bounded; refuted.
2. **6.1 endBatch via global facade instead of pane scope** — facade delegates correctly; refuted.
3. **6.7 three-await re-arm window in the second pass** — the second pass's awaits resolve synchronously when
   nothing is armed; the residual is 5.7's failure case, not a third window; refuted as stated.
4. **6.3 `getMetadata ?? next` masks a failed re-read with stale content** — `applyChanges` surfaces failures and
   the fallback is the documented transient-coherence decision (5.6b polishes the deleted-file corner); refuted.
5. **6.3 armed GATEWAY write landing mid-re-read installs the user's own bytes as "external"** — the drift gate +
   pending-path sentinel front this; refuted (5.6a hardens the one constructed survivor).

---

## Suggested execution order

| Order | Phase | Why |
| --- | --- | --- |
| 1 | **Phase 0** (0.2 + 0.3) | Blocks committing `chore/electron-42`; 0.2 is the only confirmed regression in the new work. |
| 2 | **Phase 1** | The HIGH + the three writes-wrong-bytes mediums. ~1 day with tests. |
| 3 | **Phase 2** | The failure-as-success cluster — highest honesty payoff per line changed. |
| 4 | **Phase 3** | Lifecycle/recovery; 3.1–3.3 first (user-visible), 3.4–3.8 after. |
| 5 | **Phase 4** | UI paper cuts; 4.1/4.2 close the title-rename class, rest opportunistic. |
| 6 | **Phases 5–6** | Narrow windows + gate hygiene; safe to do while already dogfooding. |

Dogfooding can begin after Phase 1 (Phase 0 must precede the branch commit either way); Phases 2–6 are safe to
land while using the tool daily.

# Audit-11 Remediation Plan — Dogfood-Readiness Data-Integrity Audit (2026-06-06)

> **Source:** 9-agent adversarial audit + an independent tag-rewrite / rename-cascade
> pass, run against the uncommitted Audit-7/8/9 + write-path-remediation working tree.
> `npm run check` and `npm run test:unit` were both green at audit time, so every issue
> here lives in a gap the existing suite does not cover.
>
> **Thesis:** the foundation is strong (atomic writes everywhere, the single-parser CST
> frontmatter engine, the global per-path write-serialization chain, board-file
> quarantine, informational-only crash recovery). The real issues concentrate in three
> places the 10 prior persistence-focused audits never stressed: (1) the **Phase-4 delta
> refactor is incomplete** — the orphan-card path was left on the old lossy approach;
> (2) **UI pane-scoping** — `DocumentEditor` ignores its pane; (3) **write liveness on
> network volumes** — only 1 of 5 schedulers carries a timeout bound.
>
> **Overall data-integrity readiness at audit time: 7/10.** Single-pane / in-app-created
> content / local-disk vault is already safe (~8.5/10). The plan below clears the path
> to confident dogfooding for the import / split-pane / OneDrive cases too.

---

## Status legend

`[ ]` not started · `[~]` in progress · `[x]` done + `ci:verify` green

---

## Finding inventory & phase map

| ID | Severity | Area | Phase | Status |
| --- | --- | --- | --- | --- |
| **FILO-UR-1** | 🔴 HIGH (data loss) | Undo / orphan FM write | 1 | `[x]` |
| **R1** | 🔴 HIGH (correctness) | Reactivity / pane scope | 1 | `[x]` |
| **WC-1 / QC-1 / QC-2** | 🟠 MED (liveness; HIGH for quit) | Write schedulers / quit | 2 | `[x]` |
| **QC-3** | 🟡 LOW | Quit drain | 2 | `[x]` |
| **QC-4** | 🟡 LOW | Quit re-entrancy | 2 | `[x]` |
| **EER-1** | 🟠 MED (silent revert) | External-edit reconcile | 3 | `[x]` |
| **VS-1** | 🟠 MED | Vault-swap (recovery cascade) | 3 | `[x]` |
| **VS-2** | 🟠 MED | Vault-swap (fileTags writers) | 3 | `[x]` |
| **FILO-UR-2** | 🟠 MED | Vault-swap (Properties cmd) | 3 | `[x]` |
| **VS-3 / VS-4 / VS-5 / VS-6** | 🟡 LOW | Vault-swap residue | 4 | `[x]` |
| **WC-2 / WC-3** | 🟡 LOW | Scheduler bookkeeping | 4 | `[x]` |
| **T1 / T2** | 🟡 LOW | Tag rewrite | 4 | `[x]` |
| **N1 / N2 / N3** | 🟡 LOW | FM delta seams | 4 | `[x]` |
| **R2 / R3 / R4** | 🟡 LOW | Reactivity / lifecycle | 4 | `[x]` |
| **P1 / P2** | 🟡 LOW | Path / IPC | 4 | `[x]` |
| **B-INT-L1 / B-INT-L2** | 🟡 LOW | Board cache | 4 | `[x]` |
| **FILO-UR-3** | 🟡 LOW (coverage) | Undo test depth | 4 | `[x]` |
| **STALE-1** | 🟡 LOW (cleanup) | Dead interim code | 4 | `[x]` |
| Gates + docs | — | Anti-regression | 5 | `[x]` |

**Sequencing rationale:** Phase 1 first because it is the only outright silent data-loss
(FILO-UR-1) plus the only feature-breaking correctness bug (R1), and both are small,
localized, and low-risk. Phase 2 (liveness) protects the OneDrive/SMB target environment.
Phase 3 closes the external-edit + vault-swap MED gaps. Phase 4 sweeps the LOWs. Phase 5
locks every fix behind a CI ratchet and updates the docs. Run `npm run ci:verify` to green
at every phase boundary (the repo convention).

**File-size ceiling note:** several target files sit at or near their
`ci:file-sizes` ceiling (`kanbanCommands.ts`, `markdownFileWriter.ts`,
`vaultExternalChanges.ts`, `vault.svelte.ts`). Trim comments first; bump the ceiling in
`scripts/check-file-sizes.mjs` only when a fix genuinely needs the lines.

---

# Phase 1 — HIGH: silent data loss + feature-breaking correctness

## FILO-UR-1 · Orphan card/task field edit strips present-but-empty frontmatter keys

- **Severity:** 🔴 HIGH — silent, recurring data loss. Bites the moment a user imports
  existing Markdown notes (empty `aliases:` / `cssclasses:` / `subtitle:` keys are
  ubiquitous in Obsidian-style vaults).
- **Where:** `src/renderer/commands/kanbanCommands.ts:993-1017` (`applyOrphanPatchRebased.commit`),
  reached by `UpdateOrphanFrontmatterCommand` from both Kanban cards and Task List rows.
- **Trigger:** a card/row backed by a `.md` file with **no `contentId`** and **no open
  Document editor**, whose disk frontmatter carries a present-but-empty key. The user
  edits any field (priority / dueDate / completed / tags).
- **Root cause:** Phase 4 migrated the *docId* path to the delta-on-fresh-disk write but
  left the orphan twin on the old whole-object clean:
  ```js
  const merged = { ...baseFm, ...patch };
  for (const k of Object.keys(merged))                 // iterates ALL keys, incl. untouched
    if (v === '' || v === undefined || v === null) delete merged[k];
  await writeMarkdownFile({ frontmatter: merged, originalFrontmatter: baseRawFm }); // no delta
  ```
  `baseFm` is a fresh disk parse, so `aliases: null` → deleted from `merged`, and the CST
  engine then splices it out. Fires on **execute and undo**.
- **Fix:** thread a delta instead of a cleaned whole object. `WriteArgs.frontmatterDelta`
  already exists (`markdownFileWriter.ts:153`) and its gateway branch (`:660-686`) applies
  the delta to a fresh in-chain disk read — exactly what preserves untouched keys.
  1. In `commit(patch)`, replace the `merged` build + clean-loop with
     `const delta = patchToFrontmatterDelta(patch);` (already imported at `kanbanCommands.ts:31`).
  2. Call `writeMarkdownFile({ vaultRoot, relPath, frontmatterDelta: delta, body,
     callerId, docId: null, originalFrontmatter: baseRawFm })` — drop `frontmatter: merged`.
  3. Leave the conflict-detection (`conflicts`, `commit(applying)` subset) untouched — a
     subset patch produces a subset delta, preserving the keep-external behaviour.
  4. Keep the `A9-L2` loud-failure (`await` propagates the rejection) and the `A9-H1`
     `isStillSameVault(identity)` bail already present at `:991`.
- **Test:** new round-trip in a Phase-1 test file — orphan card backed by
  `---\naliases:\npriority: low\n---\nbody\n`, patch `{priority:'high'}`, assert the
  **disk bytes** still contain `aliases:` after both execute *and* undo. Add the
  present-but-empty + datetime + comment cases. (Existing orphan tests only use single-key
  `priority: low`, which is why this slipped through.)
- **Gate:** Phase 5 extends `ci:frontmatter-delta-write` to require the orphan path
  construct a delta (forbid `frontmatter:` on this write site).

## R1 · DocumentEditor renders/writes the globally-active doc, not its own pane

- **Severity:** 🔴 HIGH — split-pane Document editing is fundamentally broken; risk of
  editing the wrong file. **Single-pane sessions are unaffected** (global active tab ==
  the only pane's tab), which is why all prior audits missed it.
- **Where:** `src/renderer/components/boards/DocumentEditor.svelte:49-51` +
  `src/renderer/components/boards/BoardRouter.svelte:119`.
- **Root cause:** every canvas board resolves its board from the per-pane `BoardScope`
  context; `DocumentEditor` instead derives from the **global** tab:
  ```js
  let activeTab = $derived(tabStore.activeTab);   // GLOBAL
  let docId = $derived(activeTab?.boardId ?? '');
  ```
  and `BoardRouter` renders `<ActiveBoardComponent />` with no `tabId`. So two panes
  showing different Document boards both bind to the active tab's doc — both mirror it,
  the `mode:'full'` reload effect (`:392-409`) keeps swapping content underneath, and the
  `callerId = document-editor:${docId}` / force-writer identity (captured at mount, `:284`)
  goes stale, opening dirty+tab-switch edit-loss/misroute corners.
- **Fix:** make `DocumentEditor` pane-scoped via the `tabId` `BoardRouter` already holds.
  1. `BoardRouter.svelte:119` → `<ActiveBoardComponent {tabId} />`.
  2. `DocumentEditor.svelte`: add `let { tabId }: { tabId: string } = $props();` and replace
     the derivation with
     `let tab = $derived(tabStore.tabs.find((t) => t.id === tabId)); let docId = $derived(tab?.boardId ?? '');`
     Keep `docState` derived from `docId`. The `{#key tab.id}` in `BoardRouter` already
     remounts on a pane tab change, so `tabId` stays the pane's own tab.
  3. Canvas board roots (`MindMapBoard` / `KanbanBoard` / `TaskListBoard`) are already
     pane-correct via `BoardScope`; add an optional `tabId?: string` to their `$props()`
     so the passed prop is declared (Svelte 5 ignores undeclared props, but declaring it
     is cleaner and silences the a11y/prop lints).
  4. Audit the rest of `DocumentEditor` for any remaining `tabStore.activeTab` /
     `tabStore.activeTabId` read and re-point to `tab` (e.g. the teardown `flush` reads
     `docState` after an await — `:368-385` / `:229-247` — which now resolves to the
     pane's own doc, closing R4 as a side effect).
- **Risk:** `BoardRouter` is shared by every board type — smoke-test all four in a single
  pane and two Document boards in a 2-pane split.
- **Test:** component/integration test mounting two `BoardRouter`s with different document
  `tabId`s under distinct scopes; assert each `DocumentEditor` binds its own `docId`
  irrespective of `tabStore.activeTab`. A focused unit test on the new derivation
  (`tab = tabs.find(id===tabId)`) guards the regression cheaply.

**Phase 1 exit:** `npm run ci:verify` green; the two new byte-level / pane-scope tests pass.

**Phase 1 DONE (2026-06-06) — `ci:verify` green (411 test files, build OK, exit 0), UNCOMMITTED.**
- **FILO-UR-1:** `applyOrphanPatchRebased.commit` now threads `patchToFrontmatterDelta(patch)`
  via `frontmatterDelta` (dropped the `merged` build + clean-loop), so the gateway delta
  branch reads disk in-chain and preserves untouched keys. Made `WriteArgs.frontmatter`
  OPTIONAL (`markdownFileWriter.ts:124`) so the orphan site can drop `frontmatter:`; added a
  `?? {}` belt at the cache-FM branch `fm` resolve (`:716`). Side effect (intended, per step 4):
  a genuinely-failed orphan disk read is now a LOUD failure (markPathFailed + throw), not a
  silent index-fallback-write — `kanbanNoDocIdUndo.test.ts` updated (mutable-disk mock + the
  read-fail test rewritten to assert the loud failure).
- **R1:** `BoardRouter` passes `{tabId}` to `<ActiveBoardComponent>`; `DocumentEditor` derives
  `tab = tabStore.tabs.find(t => t.id === tabId)` from a new `tabId` prop (no more
  `tabStore.activeTab`); MindMap/Kanban/TaskList boards declare an ignored `tabId?` prop
  (Kanban/TaskList condensed an adjacent comment to stay under their LOC ceiling). R4 closed
  as a side effect (teardown `docState` resolves to the pane's own doc).
- New `src/tests/unit/audit11Phase1.test.ts` (5 tests, both fixes bite-verified). Phase 5 still
  owes the `ci:frontmatter-delta-write` orphan-site extension + `ci:document-editor-pane-scoped`
  gate.

---

# Phase 2 — Write liveness (network-volume quit hang & UI freeze)

> One root cause, three manifestations. **Not data loss** — atomic writes + the
> `.filo/.dirty` sentinel protect the bytes. This is an availability/UX class.

## WC-1 / QC-1 / QC-2 · Unbounded frontmatter (+board/config/misc) schedulers

- **Severity:** 🟠 MED overall; **HIGH for the quit-hang** manifestation on the documented
  OneDrive/SMB target environment.
- **Where:** `src/renderer/lib/boards/frontmatterWriteScheduler.ts:146` (`createScheduler`
  with no `writeTimeoutMs`) → `writeFrontmatter` (`:202`) → `await writeMarkdownFile`
  (`:326`); the quit drain at `src/renderer/lib/vault/handleFlushAndQuit.ts:60-72`; main's
  re-armed force-quit timer at `src/main/main.ts:200-203`.
- **Root cause:** only the markdown gateway's `writerScheduler` sets `writeTimeoutMs`
  (`markdownFileWriter.ts:204`). The frontmatter/board/config/misc schedulers return the
  raw `writePromise` (`writeScheduler.ts:401`) and await the IPC forever, yet
  `writeFrontmatter` reaches the *same* `vault:write-existing-file-text` IPC **and** the
  interactive drift prompt (`markdownFileWriter.ts:591`) the gateway's 60 s race exists to
  cap. At quit, `vaultStore.save()` awaits `flushAllPendingFrontmatterWrites()`
  (`vault.svelte.ts:1194`); the 2 s heartbeat re-arms main's 5 s destroy timer with **no
  absolute cap**, so a stalled volume freezes quit until hard-kill. The
  `check-awaited-writes-bounded.mjs:14-17` premise ("frontmatter scheduler awaits only
  fire-and-forget IPC") is factually wrong.
- **Fix (do both halves):**
  1. **Bound the schedulers.** Set `writeTimeoutMs: MARKDOWN_WRITE_TIMEOUT_MS` on the
     frontmatter scheduler's `createScheduler` config. Audit the board scheduler the same
     way — `writeBoardFile` performs an awaited pre-write `vault:stat` + write IPC; bound
     it too if it can reach an unbounded await. (Config/misc are genuinely whole-file
     fire-and-forget — confirm and leave, or bound for uniformity.) On timeout the existing
     `markPathFailed` + late-self-heal path (`writeStateTracking.ts:592`) already handles
     the abandoned promise correctly.
  2. **Cap the quit drain regardless.** In `handleFlushAndQuit`, wrap `await deps.save()`
     (and the subsequent `await deps.flushSentinel?.()`, see QC-3) in a `Promise.race`
     against an absolute deadline. On elapse: clear the heartbeat and send
     `app:quit-awaiting-user` so main's timer can fire and surface the existing "Save
     failed → Quit anyway / Stay" confirm — converting the silent freeze into a user
     decision.
- **Test:** a fake-timer test where the FM scheduler's underlying IPC never resolves;
  assert `flushAll()` rejects/aborts at `writeTimeoutMs` instead of hanging, and that the
  quit handler stops beating + emits `app:quit-awaiting-user` at the deadline.
- **Gate:** Phase 5 corrects `check-awaited-writes-bounded.mjs` — require the bound on
  every scheduler that transitively awaits `writeMarkdownFile`, and fix the false comment.

## QC-3 · Unbounded `flushSentinel` await on the terminal quit path — 🟡 LOW

- **Where:** `handleFlushAndQuit.ts:76,112` → `dirtyFlagRecovery.ts:66-68` (`sentinelMutex`
  tail).
- **Fix:** fold into the WC-1 Phase-2 `Promise.race` deadline (the heartbeat is already
  cleared by line 71, so worst case is a bounded delay then main's forced destroy — but
  bounding it explicitly is cleaner). No separate test beyond the WC-1 race test.

## QC-4 · No idempotency guard on `app:flush-and-quit` — 🟡 LOW (latent)

- **Where:** `src/renderer/App.svelte:93-104`.
- **Fix:** add an `isDrainingForQuit` module flag in the listener; a second dispatch
  no-ops. Defense-in-depth (main can't currently double-send). One-line guard + a unit
  test that a re-entrant dispatch doesn't start a second `save()`.

**Phase 2 exit:** `ci:verify` green; the wedged-IPC fake-timer test passes; manual smoke:
quit with a deliberately-stalled write (e.g. a paused VM disk) surfaces the confirm instead
of hanging.

**Phase 2 DONE (2026-06-06) — `ci:verify` green (412 test files, build OK, exit 0), UNCOMMITTED.**
- **Shared bound (cycle-safe):** added `WRITE_TIMEOUT_MS` (60 s) to the dependency-free
  `boardWriteDebounce.ts` leaf; `markdownFileWriter.ts` now re-exports it as
  `MARKDOWN_WRITE_TIMEOUT_MS` (was a local literal). Putting the const in `markdownFileWriter`
  and importing it into the board/config/misc schedulers would have created a module-eval
  cycle (scheduler → markdownFileWriter → boardSaver → scheduler) leaving the const in the TDZ
  at `createScheduler` time; the leaf sidesteps it. markdownFileWriter shrank 1286 → 1280 (no
  ceiling bump).
- **WC-1 / QC-1 / QC-2:** `writeTimeoutMs: WRITE_TIMEOUT_MS` added to ALL FOUR schedulers
  (`frontmatterWriteScheduler` + `boardWriteScheduler` REQUIRED — both reach an interactive
  drift prompt / write IPC; `configWriteScheduler` + `miscWriteScheduler` bounded for
  uniformity — their IPCs can wedge on a stalled OneDrive/SMB volume too). On timeout the
  primitive's existing `markPathFailed` + `endWrite(false)` keep `.filo/.dirty` dirty and
  attribute the failure; a late success self-heals via `trackComponentWrite`.
- **WC-1 half 2 / QC-3:** `handleFlushAndQuit` now races `deps.save()` against an absolute
  `QUIT_DRAIN_DEADLINE_MS` (60 s) via `raceDrainDeadline`; on elapse it clears the heartbeat,
  treats it as a failure, and falls through to the existing `app:quit-awaiting-user` + "Save
  failed" confirm — converting a silent freeze into a user decision. The terminal sentinel
  flush is likewise bounded (`flushSentinelBounded`, `SENTINEL_FLUSH_DEADLINE_MS` 5 s), so a
  wedged `.filo/.dirty` IPC can't hang the quit either.
- **QC-4:** module-level `isDrainingForQuit` guard (reset in `finally`) — a re-entrant
  `app:flush-and-quit` dispatch no-ops instead of starting a second `save()` / stacking a
  second confirm. `__resetQuitDrainingForTests` added for test isolation.
- **Tests:** new `src/tests/unit/audit11Phase2.test.ts` (4 tests, all bite-relevant): FM
  scheduler aborts a wedged hydrate-read IPC at `writeTimeoutMs` (fake timers); the quit drain
  caps at the deadline (stops beating + opens the confirm); a wedged `flushSentinel` still
  reaches `ready-to-quit`; a re-entrant dispatch runs `save()` once. Existing
  `handleFlushAndQuit.test.ts` gained the `__resetQuitDrainingForTests` reset in its hooks (all
  9 still pass).
- **Deferred to Phase 5 (per the per-finding "Gate:" bullets):** the
  `check-awaited-writes-bounded.mjs` correction (require the bound on the FM + board schedulers,
  fix the now-stale "fire-and-forget only" comment). The gate still PASSES today — it asserts
  only the `markdownFileWriter` + `writeScheduler` tokens, which are intact.

---

# Phase 3 — External-edit & vault-swap MED gaps

## EER-1 · Discarded field edit re-clobbers disk after an external "Reload"

- **Severity:** 🟠 MED — silent revert of an external edit the user explicitly chose to keep.
- **Where:** `src/renderer/lib/boards/frontmatterWriteScheduler.ts` (`pendingDeltas`,
  cleared only on success/rename/swap) + `src/renderer/stores/vaultExternalChanges.ts:1280`
  (`cancelFrontmatterWrite`) + `src/renderer/stores/document.svelte.ts:829`
  (`applyReloadFromDisk` → unconditional `flushAllPendingFrontmatterWrites()`).
- **Root cause:** the Phase-4 delta accumulator survives a "Reload" discard.
  `cancelFrontmatterWrite` cancels only the timer; the open-editor reload then *fires* the
  still-armed delta. The "no-op self-write" comment at `:829` predates the delta path and
  is now false.
- **Fix:**
  1. Add a `dropPendingDelta(relPath)` to `frontmatterWriteScheduler` (delete the
     `pendingDeltas` entry **and** cancel the timer) and call it from `cancelFrontmatterWrite`.
  2. At every Reload-discard site in `vaultExternalChanges.ts` (the closed-card F4
     `promptMarkdownPendingWriteConflict` Reload + the open-editor `promptModifiedFile` /
     bulk Reload-all paths), call `dropPendingDelta(rel)` **before**
     `applyReloadFromDisk`. Update the stale `:829` comment.
- **Test:** new reconciliation test — arm a field delta, fire an external edit, choose
  Reload, then trigger the next debounce / `applyReloadFromDisk`; assert the discarded
  field is **not** re-written to disk (both closed-card and open-editor legs).

## VS-1 · `repairRenameCascade` cross-vault contamination via the recovery modal

- **Severity:** 🟠 MED — in-memory only (disk writes are main-gated), but contaminates the
  new vault's board/doc cache with the outgoing vault's rename entries.
- **Where:** `src/renderer/lib/vault/renameCascadeRepair.ts:28-110`; the parked modal is at
  `src/renderer/stores/vault.svelte.ts:758-785`.
- **Root cause:** `repairRenameCascade` runs in-memory mutations (`ensureAllLoaded`,
  `renameBoardPath`, `markDirty`, `propagateRename`, `flushAllDirty`) across awaits with no
  generation guard; the recovery modal's `onConfirm`/`onCancel` fire at click time with no
  recheck.
- **Fix:** capture `captureVaultIdentity()` at `repairRenameCascade` entry (or thread the
  `{path, generation}` from the sequencer) and `isStillSameVault(identity)`-bail after each
  await before any in-memory mutation. Pattern-match the existing field-command guards.
- **Gate:** Phase 5 extends `ci:reconciler-vault-guard` Part 3 to pin
  `repairRenameCascade`.

## VS-2 · `fileTags` tag-markdown writers have zero vault-identity guards

- **Severity:** 🟠 MED — cross-vault *disk* write is blocked by main-side
  `assertActiveVault`, but the renderer-side discipline the gate enforces elsewhere is
  absent, and the failure/`applyChanges` path is keyed by a `relPath` that belongs to the
  new vault after a swap.
- **Where:** `src/renderer/stores/fileTags.svelte.ts:262-349, 438-512`
  (`writeTagChangeToTileMarkdown` / `writeTagChangeToMarkdownPath`).
- **Fix:** capture identity before the `vaultStore.path` read, `isStillSameVault`-bail
  after each await before `refreshBaselineAfterWrite` / `applyChanges` / `markPathFailed`.
- **Gate:** Phase 5 widens `ci:reconciler-vault-guard` Part 1 to scan `fileTags.svelte.ts`.

## FILO-UR-2 · `UpdatePropertiesCommand` async write has no vault-identity guard

- **Severity:** 🟠 MED — the different-path swap is blocked by main-side
  `assertActiveVault`; the residue is the close→reopen-same-path window (new generation,
  identical path string) + stale post-write renderer bookkeeping.
- **Where:** `src/renderer/commands/propertiesCommands.ts:142-275` (`applySnapshot`;
  `vaultRoot` captured at `:159`, written at `:267`).
- **Fix:** `captureVaultIdentity()` before the `await flushAllPendingFrontmatterWrites()` /
  `await readMarkdownForHydrate(...)` awaits, `isStillSameVault`-bail before the write IPC
  and the cache `setFrontmatter` / baseline bookkeeping.
- **Gate:** Phase 5 extends `ci:reconciler-vault-guard` to scan `propertiesCommands.ts`.

**Phase 3 exit:** `ci:verify` green; EER-1 reconciliation test + the three new vault-swap
guard tests pass.

**Phase 3 DONE (2026-06-06) — `ci:verify` green (413 test files, 4089 pass / 1 skip, build OK, exit 0), UNCOMMITTED.**
- **EER-1:** new `dropPendingDelta(relPath)` in `frontmatterWriteScheduler.ts` deletes the
  Phase-4 `pendingDeltas` entry AND cancels the scheduler timer; `cancelFrontmatterWrite`
  now delegates to it (closed-card F4 leg). Every Reload-DISCARD site in
  `vaultExternalChanges.ts` calls `dropPendingDelta(rel)` before `applyReloadFromDisk` — bulk
  Reload-all, `promptModifiedFile`, `promptPartialReadExhausted`, `promptExternalEditOnSync`
  (the F4 `promptMarkdownPendingWriteConflict` drops it via `cancelFrontmatterWrite`). Updated
  the now-false "no-op self-write" comment at `document.svelte.ts` `applyReloadFromDisk`
  (the flush there only drains unrelated/non-discard entries now; discard sites pre-drop).
- **VS-1:** `repairRenameCascade` gained a required `captured: VaultIdentity` 4th param,
  THREADED from the recovery sequencer's `captured` (vault.svelte.ts onConfirm/onCancel) so a
  swap BEFORE the click (parked modal) or DURING the repair bails. `isStillSameVault(captured)`
  re-checked after `ensureAllLoaded`, after `flushAllDirty` (before the tag-store mutations),
  and before clearing the sentinel — each `return null`. Test call in `auditNinePhase4.test.ts`
  updated to pass `captureVaultIdentity()`.
- **VS-2:** both `fileTags` single-tag writers (`writeTagChangeToTileMarkdown` /
  `writeTagChangeToMarkdownPath`) `captureVaultIdentity()` before the live-path read and
  `isStillSameVault`-bail after each await — before `markPathFailed`, before
  `refreshBaselineAfterWrite` (keyed by relPath ALONE → poisons the new vault otherwise), and
  before `applyChanges`.
- **FILO-UR-2:** `UpdatePropertiesCommand`'s `applySnapshot` captures identity before the
  `flushAllPendingFrontmatterWrites` drain and bails after the drain, after the hydrate read
  (before the FM-cache seed), and before the final `setFrontmatter` + write IPC.
- New `src/tests/unit/audit11Phase3.test.ts` (9 tests; EER-1 + VS-1 bite-verified by
  temp-neutering the guards → reds). Ceilings bumped (documented): `fileTags.svelte.ts`
  1164→1188, `vault.svelte.ts` 1617→1621, `vaultExternalChanges.ts` 1767→1780. Phase 5 still
  owes the gate widenings (`ci:reconciler-vault-guard` → fileTags/propertiesCommands/Part-3
  repairRenameCascade) + `ci:frontmatter-delta-write` orphan-site extension.

---

# Phase 4 — LOW correctness, hygiene & residue

> Group into one pass; each is small. Tests where behaviour changes; comment/doc-only where
> not.

| ID | Where | Fix |
| --- | --- | --- |
| **VS-3** | `boardCache.svelte.ts:479-504` (`ensureAllLoaded`) | `isStillSameVault` recheck after `loadBoard` before injecting into `boardCache`. |
| **VS-4** | `theme.svelte.ts:66-104,124-203` | Guard the direct `ThemeManager.svelte` call sites (or have `applyById`/`refreshAvailable` recheck after their awaits). Visual-only. |
| **VS-5** | `templates.svelte.ts:32-48,85-113` | Recheck after the list/load awaits before `records = …`. Display-only cache. |
| **VS-6** | `groupAndBoardCommands.ts:369,412`, `vaultIndex.svelte.ts:92`, `navigation.svelte.ts:69` | Replace the `=== newVaultPath` path-string compares with a generation-aware `isStillSameVault`, or document why each is unreachable. (All currently land on history-cleared / non-disk state.) |
| **WC-2** | `markdownFileWriter.ts:877-879` | Make the body-writer `markClean` also consult the frontmatter scheduler's pending set for the same path before clearing dirty (indicator accuracy). |
| **WC-3** | `writeScheduler.ts:586-636` | `flush(key)` can issue a redundant second write when both in-flight and pending exist; coalesce (benign today — confirm + add a guard). |
| **T1** | `tagRewriter.ts:428,456` (`rewriteTagInMarkdown`) | Dedup the post-rename tag list so a merge-rename (`draft`→`review` on a file already carrying `review`) yields `[review]`, not `[review, review]`. |
| **T2** | `tagRewriteSweep.ts:244-303` | Document (or close) the narrow race where keystrokes typed into an already-processed file *during* a large sweep are cancelled+overwritten by the `mode:'full'` reload. Lowest-risk fix: skip the reload for a file whose editor armed a write after the drain, or accept + add to KNOWN_LIMITATIONS. |
| **N1** | `markdownSync.ts:504-514` + `frontmatterWriteScheduler.ts:344` | When on-disk YAML is genuinely unparseable, the field edit is dropped as SUCCESS with no error surface. Surface a toast ("couldn't update metadata — fix the YAML in <file>") instead of silently clearing the sentinel. |
| **N2** | `frontmatterWriteScheduler.ts:305` vs `markdownFileWriter.ts:674` | Body and FM come from two disk reads; close by reading the body inside the same in-chain `parsedFresh` read, or document the micro-TOCTOU. |
| **N3** | `markdownFileWriter.ts:686` | Use `parsedFresh.hadBom` (in-chain) instead of stale `state.hadBom` for the delta-branch assembly. |
| **R2** | `OrphanCatcher.svelte:10-13` | Resolve the board from the active pane's `BoardScope` instead of the global `boardStore` facade (same root as R1; modal + undoable, low impact). |
| **R3** | `TileHeader.svelte:180-184` | Store the blur-commit `setTimeout` handle and clear it in `onDestroy` (the inline timer the `ci:component-timer-cleanup` gate can't see). |
| **R4** | `DocumentEditor.svelte:229-247,368-385` | Subsumed by R1 — re-verify the teardown `docState` read resolves to the pane's own doc after the Phase-1 fix; no separate change expected. |
| **P1** | `rangeHeader.ts:27-32` | Return `'invalid'` (→416) when `totalSize===0` so a 0-byte media file doesn't emit a malformed 206. |
| **P2** | `fileOps.ts:132-139` (`walkDirectoryTree`) | `lstat` each dir entry and realpath-confirm-within-vault before recursing, so an NTFS **junction** inside the vault isn't enumerated into the sidebar tree (name disclosure only; contents already guarded). |
| **B-INT-L1** | `frontmatterSync.ts:16,93` + `tile.ts:269-279` | Remove `date` from `SYNCED_FIELDS` **or** add it to the strip list, so a stale `date` can never leak into `.board.json` (inert today; prevents a future regression). |
| **B-INT-L2** | `boardWriteScheduler.ts:90-93` | Document the `JSON.parse(JSON.stringify())` clone's value coercion (drops `undefined`, ISO-stringifies `Date`) as the intended normalization, or replace with `structuredClone` if any field ever needs exact round-trip. Inert today. |
| **FILO-UR-3** | `frontmatterRebaseConflict.test.ts` + `check-command-roundtrip-coverage.mjs` | Add a **disk-bytes** undo round-trip for `UpdateCardFieldCommand` / `UpdateTaskFieldCommand` covering the previously-absent-key and present-but-empty-key cases (today only the display cache is asserted). |
| **STALE-1** | `staleSeededFrontmatter.ts` + 2 call sites in `vaultExternalChanges.ts:207,269` | The file's own docstring says delete it once Phase 4 lands (it has). Confirmed *not* a display regression (the reconciler refreshes backed tiles first + `clearFrontmatter` bumps the version tick → cards fall back to fresh index metadata). Remove the file + the two call sites + the import. |

**Phase 4 exit:** `ci:verify` green; new tests for the behaviour-changing items (T1 dedup,
N1 toast, P1 416, P2 junction skip, FILO-UR-3 disk round-trip).

**Phase 4 DONE (2026-06-06) — `ci:verify` green end-to-end (exit 0; 39 guards; build OK), UNCOMMITTED.**

*Fixed in code:*
- **VS-3/4/5/6** — `captureVaultIdentity()` + post-await `isStillSameVault` bails added to
  `boardCache.ensureAllLoaded` (VS-3), `theme.refreshAvailable`/`applyById` (VS-4, commits
  `availableThemeIds`+`themeCache` together AFTER the loop), `templates.refresh` (VS-5),
  and the two `=== path` string compares in `navigation.svelte.ts` + `vaultIndex.indexOnePath`
  (VS-6, now generation-aware). `groupAndBoardCommands` `CascadeDeleteCommand` (VS-6) kept its
  path-STRING compare + a documented unreachability note (the generation-gap cases all require a
  vault open, which fires `pre-swap` → `historyStore.clear()`, so the command is off the stack;
  converting would also desync its 4 direct-`vaultStore.path` tests).
- **WC-3** — `writeScheduler.flush(key)` now drains prior in-flight writes BEFORE firing the
  pending one (timer disarmed up-front to avoid a double-fire), so the newest write lands last
  (matters for the non-path-serialized board/config/misc schedulers). 20/20 writeScheduler tests
  still pass.
- **T1** — `rewriteTagInMarkdown` dedups the post-rename list (both the line-rewrite and dump
  paths) via a new `dedupeTags`, so a merge-rename yields `[review]` not `[review, review]`.
- **N3** — gateway delta branch assembles with `parsedFresh.hadBom` (in-chain read) instead of the
  stale `state.hadBom`.
- **N1** — new `AssembleMarkdownOptions.onFrontmatterRefused` hook; `assembleMarkdownFile` invokes
  it when it refuses an edit over unparseable on-disk YAML; the gateway wires it to a coalesced
  "couldn't update metadata — fix the YAML" toast (both the delta + cache-FM assemble calls).
- **R3** — `TileHeader` stores the blur→commit `setTimeout` handle (`blurCommitTimer`), clears it
  in `destroyTitleEditor` (commit/cancel) AND directly in the `$effect` teardown (so
  `ci:component-timer-cleanup` sees it).
- **P1** — `parseRangeHeader` returns `'invalid'` (→416) for any range against a 0-byte file.
- **P2** — `walkDirectoryTree` threads the realpath-resolved vault root and skips a reparse-point
  (NTFS junction / symlink) whose target escapes the vault (name-disclosure fix).
- **B-INT-L1** — `date` removed from `SYNCED_FIELDS` (+ its `canonicalValues` line), closing the
  leak of a frontmatter `date:` into `.board.json` at its reconcile source (no cached-`date`
  reader exists; the strip-list alternative would warn-loop, so removal is the complete fix).

*Documented (deviations from the literal plan, with reasoning):*
- **STALE-1** — NOT removed. Verified the seeded-but-not-open card display reads
  `documentStore.getFrontmatter` (cache-wins) and the reconciler refreshes only OPEN editors, so
  this helper's `clearFrontmatter` is still the only thing that freshens a not-open card after an
  external edit. Removing it WOULD be a display regression (contradicting the plan's "not a display
  regression" claim). Kept; its "delete me" docstring rewritten to record the retained display role.
- **WC-2** — NOT gated on FM-pending. The prescribed change would strand the body callerId (the FM
  write clears only its own callerId) → reopen the Audit-7 M1 "pinned dirty" hole; and the save
  indicator reads the write ledger (which already counts the FM scheduler's `sentinelMode:'full'`
  pending writes) while the sole `isDirty`-field reader is downstream-guarded by F4 `isPathPending`.
  Documented at the markClean site.
- **T2** — accepted + KNOWN_LIMITATIONS.md #8 (the closing fix would couple the deliberately
  store-free `tagRewriteSweep` to scheduler state; the race is narrow and self-heals).
- **N2** — accepted micro-TOCTOU, documented at the gateway delta branch (the delta path only carries
  field/FM edits, so the body is identical between the two reads; an open editor's live body must
  still win, so `parsedFresh.body` can't be blanket-swapped in).
- **B-INT-L2** — documented the `JSON.parse(JSON.stringify())` clone's value-coercion as intended.
- **R2** — verified OrphanCatcher renders at the AppShell root (no pane `BoardScope` in context) and
  the global `boardStore` is the active-pane-delegating facade (`getActiveScope`), the same facade
  `orphansStore` reads — so it's already pane-correct (R1's `tabStore.activeTab` was the truly-global
  one). Clarifying comment added; the prescribed `getContext` change is inapplicable + unnecessary.
- **R4** — re-verified closed by the Phase-1 R1 fix (DocumentEditor teardown `docState` derives from
  the `tabId` prop). No change.

*Coverage:* **FILO-UR-3** — new `audit11Phase4.test.ts` (3 disk-bytes round-trips for
`UpdateCardFieldCommand`/`UpdateTaskFieldCommand`: present-but-empty key + previously-absent key
survive execute→undo on disk). Plus T1 (tagRewriter.test.ts), N1 (assembleMarkdownEngine.test.ts),
P1 (filoMediaRange.test.ts), P2 (readDirectoryTreeCap.test.ts) added to existing suites.

*Ceiling:* `markdownFileWriter.ts` 1286→1311 (N1 toast helper + N2/N3/WC-2 comments).

*Deferred to Phase 5 (per the per-finding "Gate:" bullets):* the gate widenings
(`ci:frontmatter-delta-write` orphan site, `ci:reconciler-vault-guard` → fileTags/properties/Part-3,
`check-awaited-writes-bounded` FM+board schedulers, optional `ci:document-editor-pane-scoped`) +
the CLAUDE.md/MEMORY.md doc deltas. The KNOWN_LIMITATIONS.md #8 (T2) landed here because documenting
was T2's Phase-4 resolution.

---

# Phase 5 — Anti-regression gates & docs

Lock every fix behind a ratchet so it can't silently regress, and update the docs.

1. **`ci:frontmatter-delta-write`** — extend the scan to the orphan write site
   (`applyOrphanPatchRebased`): forbid a `frontmatter:`-object write there; require a
   `frontmatterDelta`. Closes FILO-UR-1's class structurally (mirrors how the gate already
   pins the docId path).
2. **`ci:reconciler-vault-guard`** — widen Part 1 to scan `fileTags.svelte.ts` (VS-2) and
   `propertiesCommands.ts` (FILO-UR-2); add a Part 3 pin for `repairRenameCascade` (VS-1).
   Bite-verify each (temp-revert a guard → gate goes red).
3. **`check-awaited-writes-bounded.mjs`** — correct the false premise; require
   `writeTimeoutMs` on every scheduler that transitively `await`s `writeMarkdownFile`
   (frontmatter + board), not just the gateway. (WC-1 / QC-1 / QC-2.)
4. **New micro-gate (optional)** — `ci:document-editor-pane-scoped`: forbid
   `tabStore.activeTab` / `tabStore.activeTabId` reads inside `DocumentEditor.svelte` (R1),
   so the pane-scope fix can't be reverted. Model on `check-no-dead-flush.mjs`.
5. **`KNOWN_LIMITATIONS.md`** — add entries for any deliberately-accepted residue (e.g. T2
   sweep-vs-typing race if accepted; N2 body/FM two-read TOCTOU if accepted). Do **not**
   add anything Phase 1-4 actually fixed.
6. **`CLAUDE.md`** — update the gate count + the load-bearing-gate list if gates are
   added/changed; note the orphan path now uses the delta (the "Common Gotchas"
   frontmatter section).
7. **`MEMORY.md`** — one concise index line for this audit (the index is already over its
   size budget — keep it under ~200 chars and move detail into a topic file).

**Phase 5 exit:** `npm run ci:verify` green end-to-end; every new/changed gate
bite-verified; the doc deltas land in the same commit as the code they describe.

**Phase 5 DONE (2026-06-06) — `ci:verify` green end-to-end (exit 0; 414 test files,
4102 pass / 1 skip; build OK; now 40 gates), UNCOMMITTED.** Every new/changed gate
bite-verified (temp-revert → red, then restored byte-exact).
- **1. `ci:frontmatter-delta-write` (FILO-UR-1).** Added a FUNCTION-SCOPED (`within`)
  check on `applyOrphanPatchRebased`: REQUIRES `patchToFrontmatterDelta(` +
  `frontmatterDelta:` and FORBIDS a `\bfrontmatter\s*:` whole-object write inside that
  one function. New `blankStringsAndComments` + `sliceFunctionBody` give a string/
  comment-safe brace-match for the slice; the whole-file checks keep `stripComments`
  (one asserts the `vault:read-file-text` STRING literal, which a string-blank would
  hide). Bite: `frontmatterDelta:`→`frontmatter:` at the orphan write → both arms red.
- **2. `ci:reconciler-vault-guard` (VS-2 / FILO-UR-2 / VS-1).** Part 1 GUARD_TARGETS
  widened to `fileTags.svelte.ts` (the two single-tag `.md` writers; the sync
  `resolveTextTileFilePath` never triggers — no await) and `propertiesCommands.ts`
  (`applySnapshot`, the only live-path reader). Part 3 generalized to a
  `PART3_TARGETS` list and now also pins `repairRenameCascade`
  (`renameCascadeRepair.ts`, a captured-`VaultIdentity`-param fn Part 1 can't see).
  Bite: neuter `isStillSameVault(` in all three files → gate names all four fns.
- **3. `check-awaited-writes-bounded.mjs` (WC-1/QC-1/QC-2).** Corrected the false
  "only the gateway can wedge" docstring premise; added required `writeTimeoutMs:` on
  `frontmatterWriteScheduler.ts` + `boardWriteScheduler.ts` (both transitively await
  `writeMarkdownFile` / an interactive drift prompt). Config/misc left unrequired
  (genuinely fire-and-forget). Bite: comment out the bound on both → both red.
- **4. NEW `ci:document-editor-pane-scoped` (R1).** 40th gate; forbids
  `tabStore.activeTab` / `tabStore.activeTabId` reads in `DocumentEditor.svelte`.
  Offset-preserving JS+HTML-comment blank so the explanatory comment that names the
  read can't trip it; a markup mustache read is still caught; `// allow-global-tab:`
  escape. Registered in `package.json` (script + `ci:verify` chain tail). Bite:
  restore a `tabStore.activeTab` derivation → red at the right line; green with the
  comment-only mention present (FP-safe).
- **Docs.** KNOWN_LIMITATIONS.md **#9** (N2 body/FM two-read TOCTOU — accepted; T2
  was already #8 from Phase 4). CLAUDE.md: gate count 39→40, the three changed gate
  descriptions (awaited-writes false-premise correction, reconciler Audit-11
  widenings, frontmatter-delta orphan arm), a new load-bearing bullet for the
  pane-scoped gate, and the "Common Gotchas" frontmatter note (orphan path now
  threads a delta, no longer an exception). MEMORY.md: one concise index line +
  topic file `audit11-data-integrity-2026-06-06.md`. No source change in Phase 5
  (gates + docs only); no new test files (the class-closing tests shipped in P1-4).

**ALL Audit-11 phases 1-5 COMPLETE.** `ci:verify` green exit 0. The tree stays
UNCOMMITTED per the prior plans' recommendation (commit Audit-7/8/9 + write-path
first for bisectability, then stack Audit-11).

---

## Suggested commit grouping (for bisectability)

- **Commit A — Phase 1** (FILO-UR-1 + R1): the two HIGH fixes + their tests.
- **Commit B — Phase 2** (liveness): scheduler bounds + quit-drain cap + gate correction.
- **Commit C — Phase 3** (EER-1 + VS-1/2 + FILO-UR-2): external-edit + vault-swap guards +
  gate extensions.
- **Commit D — Phase 4** (LOW sweep).
- **Commit E — Phase 5** (residual gates + docs), if any not already folded into A-D.

Keep this on a branch off `main` (the working tree already carries the uncommitted
Audit-7/8/9 + write-path tree; per the prior plans, commit those first for a clean base,
then stack Audit-11 on top).

---

## Out of scope / explicitly not changed

- The frontmatter delta/CST **write engine** itself (verified byte-correct across 20+
  adversarial inputs — 9/10).
- Path/IPC containment and the Electron shell hardening (9/10 — no escape found).
- `.board.json` load quarantine + informational crash recovery (9/10 — never overwrites).
- The accepted trade-offs in `KNOWN_LIMITATIONS.md` #1-7 (frontmatter narrow-loss cases,
  attachment-tag vault-locality, Windows dir-fsync, 5 s quit ceiling *for a responsive
  renderer*, self-write window misfire, minimap perf, large-attachment rename relink).

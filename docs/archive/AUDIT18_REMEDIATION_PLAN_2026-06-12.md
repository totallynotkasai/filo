# Audit-18 Remediation Plan — 2026-06-12

**Source:** Audit-18 fresh-eyes adversarial audit (9-agent workflow: 6 finders + 3 verifiers),
run 2026-06-12 against commit `e35c170` (`chore/electron-42`, Audit-16 P6 + Audit-17 just committed).
39 candidates → **3 HIGH / 7 MEDIUM / 26 LOW confirmed** (incl. 3 verifier-found), **6 refuted**.
Report: [AUDIT18_FRESH_EYES_2026-06-12.md](AUDIT18_FRESH_EYES_2026-06-12.md). Line numbers reference the
2026-06-12 tree and may drift.

**Headline:** the frontmatter CST engine and core scheduler discipline are sound (17 audit rounds have made the
*engine* hard to break). Every HIGH lives at the **periphery** — component-level write guards (TextTile,
PropertiesPopup) and a corrupt-file load gate (tags.json) — and every one is a "write succeeds and reports
success while losing data" shape, which is why all 3 block dogfooding despite narrow triggers. Two of the three
mirror fixes already shipped elsewhere (H3 = the TextTile twin of the Audit-12 DocumentEditor M1 fix; H1 = a
parked-fire variant of the cancel-idempotency assumption). The second-largest cluster is the external-edit /
reconcile flow (M2/M3/M5/M6 + LOWs 1-11) — almost all of which only fire on a cloud-synced or
externally-edited vault.

**Area ratings given (1–10):** FM/markdown write core 8.5 · Mind Map 8 · Kanban + Task List 7 ·
Documents / text editing 6 · external edits / cloud sync 6 · undo/redo 7 · error-handling/recovery 6.5 ·
security 8.5 · performance 7.5.

**Dogfood gate:** the audit rates the build **7/10 — dogfood-ready on a local, non-cloud-synced vault once the 3
HIGHs are fixed.** Phase 1 is the unblock set; Phases 2+ are safe to land while already dogfooding.

**Status legend:** 🟢 done · 🔴 not started · 🟡 in progress

---

## Phase 1 — Unblock dogfooding (the 3 HIGH + the cheap mediums the audit named in its "smallest set")

> This phase = the audit's "Recommended pre-dogfooding fix set" (its items 1-6). Three of the four mediums here
> (M3+M6, M5, M7) are bundled because they are small, high-confidence, and two of them (M3/M6) share one helper.

> **🟢 PHASE 1 DONE 2026-06-12** (working tree, not yet committed). `ci:verify` GREEN exit 0 (lint → check →
> test:unit:strict → build → 47 gates). New `src/tests/unit/audit18Phase1.test.ts` (14 tests: H1 parked-fire
> cancel ×2, H2 corrupt-load gate ×5, H3 gateway-contract twin ×3, M5 ENOENT-grace ×2, M7 popup-resolver ×2).
> Gate `ci:no-silent-write-abort` extended with the `TEXT_TILE_FILE` arm (bite-verified). Two ceiling bumps in
> `check-file-sizes.mjs` (KanbanBoard 1429→1448 for M7 glue after splitting out `TagPromptPopup.svelte`;
> markdownFileWriter 1392→1393 for the H1 `pendingOnly` param doc); writeScheduler/PropertiesPopup/fileTags held
> under ceiling by comment trim. **Two scope decisions:** (1) **H2 Layer 2 DEFERRED** — Layer 1 (the corrupt-load
> save gate) structurally closes the data-loss blocker (the corrupt file is preserved verbatim for the session,
> matching the from-future pattern); the Layer-2 explicit-"Discard corrupt tags file" affordance + pre-discard
> `recovery:snapshot` is net-new UX with no existing discard surface, deferred as a follow-up. (2) **M7** routes
> through a new `TagPromptPopup.svelte` component (the CLAUDE.md "split, don't bump" remedy) rather than an inline
> popup, plus a DI `promptForTag` resolver on `KanbanMultiSelectDeps`.

### 1.1 🟢 HIGH (H3) — TextTile embedded-content fallback after a NON-ENOENT hydrate failure leaves the tile WRITABLE → first keystroke replaces the real on-disk file (body + FM) with a stale board-JSON seed
**Files:** `src/renderer/components/tiles/TextTile.svelte` (non-ENOENT catch ~L354-357, embedded fallback
~L359-367, `buildWriteArgs` ~L110-125); CI gate `scripts/check-no-silent-write-abort.mjs`.
**Mechanism (confirmed):** the unfixed TextTile twin of Audit-12 M1 (DocumentEditor). A non-ENOENT read failure
(deterministic `FILE_TOO_LARGE` for a >25 MB note; transient EACCES/EBUSY from AV / OneDrive holding a read lock
at board open) falls through the `else` warn branch (L354-356) to the embedded seed (L359-367): it loads stale
`tile.content`, seeds the FM cache from the stale parse (`documentStore.setFrontmatter`), and `markHydrated(relPath,
parsed.hadBom)` with **no disk mtime → no drift baseline → the drift gate is skipped**. The Audit-10 H2 empty-cache
rescue is defeated because the cache WAS seeded. `buildWriteArgs` (L111) only refuses on `backingFileMissing ||
!hydrated`, so the tile is writable and the next debounced `vault:write-existing-file-text` succeeds, overwriting
the real file with the creation-time seed + keystroke. No prompt, no error, sentinel clean.
**Fix (mirror Audit-12 M1 exactly — the DocumentEditor pattern at `DocumentEditor.svelte` L372-397/L220-226):**
1. Add `let hydrateReadFailed = $state(false);` to TextTile.
2. In the catch, set `hydrateReadFailed = true` ONLY on the non-ENOENT branch (the `else` at L354); keep the
   embedded fallback for ENOENT (genuinely-missing backing file is the designed legacy/fresh-tile path) and
   skip the embedded-seed block when `hydrateReadFailed` is set (don't seed FM from the stale parse / don't
   `markHydrated` with no baseline — leave the editor empty + non-writable, like DocumentEditor's `readOk` guard).
3. `buildWriteArgs` returns `null` while `hydrateReadFailed && !lastLoadedBody` (L111 — add the same clause
   DocumentEditor uses at L226).
4. Clear `hydrateReadFailed` + re-enable on a successful retry hydrate; surface a small retry banner/affordance
   (TextTile has less chrome than DocumentEditor — at minimum hold non-writable + log; a retry button mirrors M1).
**Gate (REQUIRED — extend the existing arm):** add a `TEXT_TILE_FILE` REQUIRED block to
`check-no-silent-write-abort.mjs` (next to `DOC_EDITOR_FILE`, ~L580-605) pinning both distinctive tokens survive in
`TextTile.svelte`: `hydrateReadFailed = true` and `hydrateReadFailed && !lastLoadedBody`. Bite-verify (strip either
token → exit 1). Today the gate's `DOC_EDITOR_FILE` arm pins only DocumentEditor — the audit calls this out.
**Test:** unit/behavioral twin of `documentEditorHydrateFailure.test.ts` for TextTile — non-ENOENT read failure
(stub `readMarkdownForHydrate` to reject with a non-ENOENT `IpcEnvelopeError`) → assert `buildWriteArgs()` returns
null (no write IPC fires on a keystroke); counter-case: ENOENT → embedded fallback still loads + tile writable.

### 1.2 🟢 HIGH (H1) — PropertiesPopup onDestroy cancels a PARKED gateway write after flushing → newest property edits silently dropped, reported as success
**Files:** `src/renderer/components/tiles/PropertiesPopup.svelte` (onDestroy ~L439-458); `src/renderer/lib/boards/
writeScheduler.ts` (parked-fire path, `cancel`/`cancelMarkdownWrite` ~L596-605).
**Mechanism (confirmed):** onDestroy runs fire-and-forget `flushIfPending()` then synchronous
`cancelMarkdownWrite(flusherId)` (L444-451). The "cancel is idempotent" comment is true for a pending TIMER but
FALSE for a **parked** fire (the debounce fired while a prior write was in IPC — the Audit-13 H1 park-behind-
`drainPriorInFlight` path). `flush()`'s synchronous prefix doesn't consume the parked entry; it suspends at
`consumeInflight`. The same-tick `cancel()` (which Audit-16 4.4 extended to also mark parked fires cancelled with a
balanced `endWrite(true)`) marks the parked entry cancelled, so its closure later bails — the freshest rows never
write. `flush` resolves `ok:true` → popup-dirty cleared, history records an after-snapshot that never reached disk.
**Trigger:** slow volume (OneDrive/SMB/AV) — edit a property, keep editing while write 1 is in IPC, close the popup
before write 1 completes. **Blast:** every edit after write 1 lost; no toast, no `markPathFailed`, no `.filo/.dirty`;
undo history diverges from disk.
**Fix (pick one; the first is the cleanest):**
- Add a `pendingOnly` cancel mode to `cancelMarkdownWrite` / the scheduler `cancel` and have onDestroy pass it, so
  teardown cancels only an armed-but-unfired TIMER and never reaches a parked/in-flight fire (which `flushIfPending`
  already owns). **Preferred** — it makes the intent explicit and can't regress other teardown callers.
- OR: `await flushIfPending()` and only `cancel` after it resolves.
- OR: skip the `cancel` entirely when `flushIfPending()` reported it converted something to in-flight/park.
**Test:** unit — arm a parked fire (slow write 1 in flight + a newer pending write), invoke onDestroy's
flush→cancel sequence → assert the parked (newest) write still fires and lands its rows; popup-dirty NOT cleared
until it settles. Mirror the existing `boundedWriteFlush` / parked-fire harness.

### 1.3 🟢 HIGH (H2 — Layer 1 done; Layer 2 deferred) — Corrupt/schema-invalid `.filo/tags.json` loads as an EMPTY registry with NO write gate → the vault open itself overwrites the recoverable file within ~300 ms
**Files:** `src/renderer/lib/vault/tagsStorage.ts` (`loadTagsFile` parse-fail L79-86 + schema-fail L122-127,
both return `emptyTagsFile()` with both flags false); `src/renderer/stores/fileTags.svelte.ts` (`LoadTagsFileResult`
consumers L537-568/L650-662, `scheduleSave` gate L182-185); `src/renderer/stores/vault.svelte.ts`
(`runPostCommitTasks` FM tag-seeding `setAll(seed)` ~L519-561).
**Mechanism (confirmed):** only `from-future` / `no-migration-path` set the read-only flags. A JSON-parse failure
(L85) and a schema failure (L127) BOTH return `emptyTagsFile()` with `fromFuture:false, noMigrationPath:false`, so
`readOnlyFromFuture` (L540/L650) stays false. Post-commit FM tag-seeding calls `setAll(seed)` → `scheduleSave` →
`tags:save` atomically replaces the corrupt-but-salvageable file with **zero user action**, within the post-commit
debounce window. No recovery snapshot is ever taken for tags.json (boards get one; tags don't). The toast copy
"tags reset to empty for this session" is affirmatively misleading — the disk copy is destroyed.
**Blast:** all tag definitions/colors + every attachment `fileTags` entry (attachments have NO other home —
documented vault-local design). Permanently unsalvageable after the overwrite.
**Fix (two layers):**
1. **Gate the save.** Add a third flag `corrupt: boolean` to `LoadTagsFileResult`, set true on the parse-fail and
   schema-fail branches (replacing the current both-false return). In `fileTags.svelte.ts`, OR it into the save gate
   — rename the gate var to a general `readOnlyTags` (`fromFuture || noMigrationPath || corrupt`) and keep
   `scheduleSave` returning early on it (L185). The corrupt file is then preserved verbatim for the session, exactly
   like a from-future file.
2. **Snapshot before any first save + honest opt-in.** Before the gate is allowed to clear (the user must
   explicitly choose "Discard corrupt tags file" — a toast action or settings affordance), `recovery:snapshot`
   the corrupt tags.json so even an explicit discard is reversible. Fix the toast copy to say the file is
   **preserved, not saved** this session (not "reset to empty").
**Test:** unit — `loadTagsFile('{ not json')` and `loadTagsFile('{"version":1,"tags":"oops"}')` → assert
`corrupt:true`; integration — corrupt tags.json on open → drive `runPostCommitTasks` seed → assert NO `tags:save`
IPC fires (file bytes preserved); explicit discard → snapshot taken first.
**Note:** keep the empty in-memory registry (the app must run) — the fix is purely "don't let the empty registry
be *written back*."
**Status 🟢/🟡:** Layer 1 **DONE** — `corrupt` flag added to `LoadTagsFileResult` (set on both the parse-fail and
schema-fail branches), OR'd into the renamed `readOnlyTags` save gate (`fromFuture || noMigrationPath || corrupt`)
in `fileTags.svelte.ts`, threaded through `vaultCandidate.ts` + `applyExternalReload`, and the two corrupt toasts
re-worded ("preserved, not overwritten" vs the misleading "reset to empty"). This structurally closes the
data-loss blocker — the corrupt file is preserved verbatim for the session, exactly like a from-future file.
Layer 2 (the explicit user-driven "Discard corrupt tags file" affordance + pre-discard `recovery:snapshot`)
**DEFERRED** as a follow-up: it is net-new UX with no existing discard surface today (from-future files have no
discard path either), and the safe-by-default preserve behaviour is fully achieved by Layer 1.

### 1.4 🟢 MEDIUM (M3 + M6) — Reload / pending-write-conflict prompts cancel gateway writers only in the NO-editor branch → a dirty Properties popup (or armed FM write) over an open dirty editor re-applies discarded keys after Reload
**File:** `src/renderer/stores/vaultExternalPrompts.ts` — `promptModifiedFile` Reload handler (~L465-497, the
editor-dirty branch has NO cancel loop) and `promptMarkdownPendingWriteConflict` (~L586-606, the A17-5.6(a)
cancel loop runs only in the else/no-editor branch). **These are the same class — M6 is M3's sibling found by a
verifier.**
**Mechanism:** the classifier returns `editor-dirty` for a body+FM external change over a dirty editor →
`promptModifiedFile`, whose Reload has no `getDirtyInstancesForPath` → `cancelMarkdownWrite` loop.
`applyReloadFromDisk` re-stamps the drift baseline; the popup's armed delta write then passes the drift gate and
reverts exactly the keys the user chose to discard on Reload.
**Fix (one shared helper, runs unconditionally):** hoist the A17-5.6(a) cancel loop into a small helper
(`cancelDirtyGatewayWritersForPath(rel)`: `getDirtyInstancesForPath(rel)` → `cancelMarkdownWrite` +
`clearPropertiesPopupDirty`) and call it at the TOP of every Reload handler BEFORE the baseline re-anchor — a
no-op when nothing is dirty. Apply to both `promptModifiedFile` (M3 — add the loop) and
`promptMarkdownPendingWriteConflict` (M6 — hoist above the branch).
**Test:** unit — dirty popup over an open dirty editor, external body+FM edit → classified `editor-dirty` →
Reload → assert the armed popup FM write was cancelled (the discarded keys do NOT re-appear on disk). Mirror for
the pending-write-conflict prompt.

### 1.5 🟢 MEDIUM (M5) — Config scheduler's ENOENT re-stat has no grace delay (board side got 150 ms in A17-2.3) → a sync-client unlink→recreate blip drops the armed `.filo` config change as clean success
**File:** `src/renderer/lib/boards/configWriteScheduler.ts` (ENOENT re-stat ~L300-309); reference
`src/renderer/lib/boards/boardWriteScheduler.ts` (`BOARD_ENOENT_RESTAT_DELAY_MS` ~L74, used ~L305).
**Mechanism:** the A17-2.3 parity fix added a 150 ms grace delay before the board scheduler's ENOENT re-stat, but
the config twin — whose own comment claims it "mirrors writeBoardFile" — still re-stats microseconds later, so a
sync client's unlink→recreate blip during an armed write is seen as a genuine delete and the config mutation is
dropped as a clean success.
**Fix (near-trivial):** export `BOARD_ENOENT_RESTAT_DELAY_MS` (or hoist it to a shared leaf) and `await` it before
the config re-stat, exactly as the board scheduler does.
**Test:** unit — armed config write, stat ENOENT once then reappear-stale within the grace window → assert the
existing drift/content-verify path runs (not a silent clean no-op); stat ENOENT twice → genuine-delete semantics
preserved.

### 1.6 🟢 MEDIUM (M7) — Bulk "Add tag" uses `window.prompt`, which Electron does not implement → the feature throws on every use (dead in the packaged app)
**File:** `src/renderer/lib/kanban/kanbanMultiSelect.svelte.ts` (`tagSelectedTiles` ~L165).
**Mechanism:** `window.prompt(...)` is unimplemented in Electron's renderer → throws → a generic unhandled-rejection
toast; multi-select Add-tag never works in the packaged app. jsdom stubs `prompt`, so unit tests can't catch it.
The codebase already knows this pattern is banned (LinkInsertPopup's comment says it "Replaces window.prompt()").
**Fix:** route through an in-app text-input popup (the `LinkInsertPopup` pattern) or `uiStore.openConfirm` with an
input field, then build the existing `BatchCommand` of `UpdateCardFieldCommand` from the returned value. Keep the
`#`-strip + trim normalization (L167-168).
**Test:** unit — drive `tagSelectedTiles` with the popup resolver stubbed → assert the BatchCommand is built with
the normalized tag (no `window.prompt` reference remains).
**Optional gate:** a tiny `ci:no-window-prompt` sweep of `src/renderer/**` forbidding `window.prompt(`/`window.alert(`
(escape `// allow-window-dialog:`), since jsdom hides the class from unit tests. Assess after the fix — there may
be only this one site, in which case a gate over-fits (defer per the Audit-17 6.3 precedent).

---

## Phase 2 — Remaining MEDIUMs (lifecycle / undo / race — land during dogfooding; none fires on a local SSD vault not edited by other tools)

> **🟢 PHASE 2 DONE 2026-06-12** (working tree, not yet committed). `ci:verify` GREEN exit 0 (lint → check →
> test:unit:strict → build → 47 gates). New `src/tests/unit/audit18Phase2.test.ts` (10 tests: M1 swap-teardown +
> cap-eviction skip + normal-toast counter ×3, M2 rename-in-flight defer + path-rebind re-read + positive-control
> eviction + counter semantics ×4, M4 rejected-undo / rejected-redo interleave preservation + identity fast-path
> ×3). All three fixes bite-verified (revert each → its tests red, controls green). New leaf module
> `src/renderer/lib/vault/renameInFlight.ts` (M2 counter guard, cycle-free, mirrors `vaultIdentity.ts`). Two
> ceiling bumps in `check-file-sizes.mjs` (vault.svelte.ts 1846→1860 for M1 toast flags + M2 eviction guard;
> vaultFolderOps.ts 1008→1018 for the M2 `rename`-method begin/end bracket). ui.svelte.ts / history.svelte.ts held
> under their (un-allowlisted, <1000) ceilings.

### 2.1 🟢 MEDIUM (M1) — Vault-swap toast teardown (and toast-cap eviction) fires onDismiss callbacks that DESTROY unacknowledged recovery breadcrumbs
**Files:** `src/renderer/stores/ui.svelte.ts` (pre-swap teardown ~L479-497, `TOAST_CAP` eviction ~L360-376);
`src/renderer/stores/vault.svelte.ts` (~L701-703 / L733-735).
**Mechanism:** the 6.1.R2 pre-swap "fire every onDismiss" change collides with two toasts whose onDismiss means
"user acknowledged → destroy breadcrumb" (`clearQuitFailureBreadcrumb`, `markClean`). Pre-swap fires BEFORE the
generation bump, so `isStillSameVault` passes and the destructive IPC lands on the outgoing vault —
quit-failure.json (the pointer to preserved unsaved bytes) is deleted unread. Violates the Audit-8 L4 contract
written in the toast's own comment.
**Fix:** add an `onSwapTeardown: 'skip'` flag (or a `acknowledgeOnly` marker) to acknowledge-and-destroy toasts;
the pre-swap teardown and the TOAST_CAP eviction both skip firing onDismiss for flagged toasts (the breadcrumb
survives to next launch instead of being silently consumed by a swap/cap).
**Test:** unit — arm a quit-failure-breadcrumb toast, trigger a vault swap (and separately a TOAST_CAP overflow) →
assert `clearQuitFailureBreadcrumb` IPC did NOT fire.

### 2.2 🟢 MEDIUM (M2) — refreshTreeAndCleanup's board-eviction stat probe races an IN-APP rename → live board evicted mid-session
**Files:** `src/renderer/stores/vault.svelte.ts` (`refreshTreeAndCleanup` board-eviction ~L1563-1592);
`src/renderer/stores/vaultFolderOps.ts` (`runRename` cache rebind L436 vs the sentinel-write + rename IPCs
L479/L517).
**Mechanism:** `runRename` rebinds the board cache to the NEW path (L436) BEFORE the sentinel-write + rename IPCs
land (L479/L517), so for that window `boardStore.paths[boardId]` names a file that doesn't yet exist on disk. A
concurrently-armed reconcile's Audit-16 3.6 `vault:file-exists` probe confirms "missing" and `cleanupMissingBoard`
evicts the live board (tabs closed, pending writes cancelled, cascade flush skipped) while the rename sentinel
clears as success.
**Fix:** re-read `paths[boardId]` AFTER the probe and skip eviction when a rename is in flight / the path is
pending (a `renameInFlight` guard set across `runRename`, mirroring the `withDrainedWrites` discipline), or move
the cache rebind to AFTER the IPCs land.
**Test:** unit — begin an in-app rename (slow IPC), fire the reconcile board-eviction probe in the rebind→IPC
window → assert the live board is NOT evicted.

### 2.3 🟢 MEDIUM (M4) — rollbackUndo/rollbackRedo blindly restore the pre-op stack snapshot → history corruption when a user action interleaves a later-rejecting async undo/redo body
**File:** `src/renderer/stores/history.svelte.ts` (`rollbackUndo`/`rollbackRedo` unconditional restore ~L431/L459
vs `rollbackExecute`'s #18 array-identity guard ~L396-398).
**Mechanism:** stack MOVES are synchronous; command BODIES queue (and can park minutes on a drift prompt). An
interleaved Ctrl+Z / execute / `pushWithoutExecute` followed by a rejection → either the command sits on BOTH
stacks (inverse applicable twice) or the interleaved command is erased (applied but un-undoable). Rejecting bodies
are real (the A17-1.4 rethrow makes them reachable). `rollbackExecute` already guards this with an array-identity
compare (#18, Audit-5); the undo/redo siblings do not.
**Fix:** mirror the #18 array-identity guard symmetrically in `rollbackUndo`/`rollbackRedo`; on a mismatch (the
stacks moved under us) do a surgical single-command remove/re-insert instead of a blind snapshot restore.
**Test:** unit — arm a parking undo body, interleave a second user command, reject the first → assert the command
appears on exactly one stack and the interleaved command is preserved.

---

## Phase 3 — LOW: external-edit / baseline integrity (cloud-sync / external-editor surface; mostly inert on a local-only vault)

> Group ordering follows the audit's LOW list. `(pc)` = partially confirmed (real but narrower than first claimed).

> **🟢 PHASE 3 DONE 2026-06-12** (working tree, not yet committed). `ci:verify` GREEN exit 0 (lint → check →
> test:unit:strict → build → 47 gates). All 11 items (3.1–3.11) landed. New tests: tagRewriter.test.ts gains the
> 3.1 empty-fence + 3.2 `|+`/cosmetic trailing-blank cases; `frontmatterInvariant.test.ts` gains a
> `trailing |+ keep-chomped scalar` HOSTILE_CORPUS row (3.2, +7 tests). Five existing frontmatter-scheduler /
> attachment-cascade tests updated for the deliberate behaviour changes (3.3 fail-loud needs a `vault:read-file-text`
> mock; 3.8 cascade handler is now async). Allowlist: fileTags 1203→1252 (3.4 helper + per-site gating), vault.svelte
> 1860→1867 (3.10), NEW boardCache pin 1009 (3.11 — it sat exactly at the 1000 hard limit; the mark/clear lines are
> irreducible, split deferred); fileWatcher held ≤1000 by comment trim. KNOWN_LIMITATIONS.md gains #14 (board
> post-write baseline is size-only, accepted). **Three scope decisions:** (1) **3.1** — the empty-fence fix lands
> in the regex (both `parseMarkdownFile` + `tagRewriter`) + a tagRewriter test, but is NOT added to
> `frontmatterInvariant`'s HOSTILE_CORPUS: that corpus's body-only-save check requires the fence to survive a
> re-emit, and an empty `---\n---\n` block is dropped by `assembleMarkdownFile` (benign — no keys, no body change;
> preserving it would need threading `hasFrontmatter` through the gateway, scope-creep for a LOW). (2) **3.2 leg (a)**
> — the `reassemble` fix (re-emit the one separator newline) + append-at-end insert fully fix the trailing-blank
> collapse on the LINE-REWRITE path (existing tags field, incl. a `|+`-last scalar) and the cosmetic case. The
> remaining `|+`-LAST-key + FRESH-insert sub-case is a YAML-position effect (a `|+` scalar's EOF-keep blank becomes
> `hello\n` once any key follows it) that NO insert position fixes without reordering tags above the scalar — strictly
> no worse than before, accepted. (3) **3.6** — the config scheduler MIRRORS the A17-5.3 content read-back (small
> files, cheap); the whole-file board scheduler ACCEPTS the size-only check + documents it (KNOWN_LIMITATIONS #14),
> per the plan's "mirror or accept" option, to avoid doubling per-save IO on multi-MB boards during tile drags.

- **3.1 🟢 Empty FM block `---\n---\n` misparse.** `parseMarkdownFile` + `tagRewriter.splitFrontmatter`
  (`markdownSync.ts` ~L100) treat a zero-interior fence pair as "no frontmatter", so a tag-add prepends a SECOND FM
  block above the orphaned fences. **Fix:** accept the zero-interior form in the fence regex + add a corpus row.
- **3.2 🟢 `tagRewriter` trailing-blank-line value drift (two legs).** (a) a fresh-tags-block insert steals the
  blank line owned by a trailing `notes: |+` keep-chomped scalar → silent VALUE change that parse-only validation
  passes; (b) **verifier superset:** `splitFrontmatter`/`reassemble` collapse the FM's trailing blank line on
  EVERY successful tag edit (incl. the fast path). **Fix:** re-emit the separator newlines in
  `splitFrontmatter`/`reassemble`, not just at the insert site; corpus rows for `|+` + trailing-blank.
- **3.3 🟢 (pc) `frontmatterWriteScheduler` hydrate-failure fallback** does `markHydrated(relPath, false)` →
  BOM stripped, possible CRLF→LF FM flip, drift gate blind for that write (~L341-350). **Fix:** fail loudly like
  the no-docState branch (`markPathFailed` + throw) instead of silently writing against a never-read file. (Same
  class as H3, scheduler-side.)
- **3.4 🟢 (pc) Single-tag fast path's unconditional post-write `refreshBaselineAfterWrite`** launders an
  undetected external edit into the baseline → the editor's next body save silently reverts it
  (`fileTags.svelte.ts` ~L272-332/L456-500). **Fix:** only refresh when the pre-read stat matched the prior
  baseline (DI-14 keep-baseline-on-mismatch shape).
- **3.5 🟢 `loadBoard` stamps the drift baseline from a stat taken AFTER the content read** → a foreign write in
  the read→stat gap becomes "our" baseline; next save clobbers it promptless (`boardLoader.ts` ~L386-404).
  **Fix:** stat-read-stat (stamp only when the bracketing stats match).
- **3.6 🟢 Board/config post-write baseline kept the size-only check** — the A17-5.3 read-back closed the
  same-size-foreign-write hole for markdown only (`boardWriteScheduler.ts` / `configWriteScheduler.ts`).
  **Fix:** mirror the 5.3 read-back (or accept + document if the IO cost is judged too high for whole-file board
  writes — see 6.x).
- **3.7 🟢 (pc) Watcher reconcile suppression carry-forward (Audit-10 M3) protects modified paths only** — an
  external DELETE inside a suppression window is permanently swallowed (`fileWatcher.ts` ~L544-596). **Fix:** carry
  forward `previous`-only keys too.
- **3.8 🟢 Attachment-delete grace window can't suppress a reconcile-synthesised rename**; document-backed files
  get no grace — both prompt cascade-delete for a merely-MOVED file (`vaultExternalChanges.ts` ~L640-688).
  **Fix:** re-probe existence at click time before cascading the delete.
- **3.9 🟢 (pc) Reload handler's A17-5.6(b) deletion early-return skips the write-cancel tail** → an armed write
  fires against a deleted file (`vaultExternalPrompts.ts`). **Fix:** run the cancel tail before the early return
  (folds naturally into the 1.4 shared-helper hoist).
- **3.10 🟢 Post-commit `pruneOrphanFileTags` prunes against the LOAD-TIME candidate tree** → tags added/moved
  during a long index rebuild are dropped and the emptied registry persisted (`vault.svelte.ts` ~L519-532).
  **Fix:** prune against the live tree at prune time.
- **3.11 🟢 `deleteBoard` cancels pending/parked but never drains an IN-FLIGHT `board:save`** → a write suspended
  on a drift prompt resurrects the deleted `.board.json` as a ghost board (`boardCache.svelte.ts` ~L743-767).
  **Fix:** drain (or hard-cancel) the in-flight board write before the delete IPC.

---

## Phase 4 — LOW: recovery / error honesty (failure-reported-as-success + recovery breadcrumb edges)

> **🟢 PHASE 4 DONE 2026-06-12** (working tree, not yet committed). `ci:verify` GREEN exit 0 (lint → check →
> test:unit:strict → build → 47 gates). New `src/tests/unit/audit18Phase4.test.ts` (7 tests: 4.1 bypass-preserves /
> Dismiss-clears ×2, 4.2 corrupt-config failed+once-per-target ×1, 4.6 task-list + kanban toast-gating ×4); existing
> `recoverySnapshot.test.ts` (+4.3 legacy-basename prune), `recentVaultsCap.test.ts` (4.5 envelope reshape +
> non-existent-dir case), `exportSaveCap.test.ts` (4.4 `canceled` + real-failure counter-case), `writeErrorToast.test.ts`
> (4.2 `CONFIG_CORRUPT` message) extended; `audit17Phase3.test.ts` 3.3 pin updated for the 4.1 narrowing. NO ceiling
> bumps (every touched file is outside the size allowlist or net-trivial). **Scope notes:** (1) **4.5** is the lone
> envelope outlier among the recents channels — the read-only siblings keep their bare `RecentVault[]`; only the add
> path can mistake failure for empty and clobber the displayed list. (2) **4.6** `tasklist/frontmatterWriter.ts`
> `markAllIncomplete` was ALREADY gated (Audit-16 6.2), so the fix landed only in the genuinely-ungated bulk ops:
> `kanbanMultiSelect.tagSelectedTiles` + every `multiSelectController` bulk op (field-patch ops, `bulkMoveToSection`,
> `bulkDelete`); clearSelection stays synchronous (preserves the SEL-1 tests) while the success toast is gated behind
> the chain's settle. (3) **4.1** narrows A17-3.3: a bypassed close (`bypassRecoveryModalClose`) un-parks the sequencer
> so steps 2–4 still run, but preserves the `.filo/.dirty` sentinel + pending paths so recovery re-queues next launch;
> only the explicit Dismiss button (`acknowledgeRecovery`) destroys the breadcrumb.

- **4.1 🟢 (pc) Esc / X / backdrop on the Recovery modal clears the `.filo/.dirty` sentinel + pending-paths**
  (A17-3.3 over-reach; `AppShell.svelte`). The A17-3.3 "dismiss-is-acknowledge" wiring is too broad for a bypassed
  close. **Fix:** only the explicit Dismiss button destroys the sentinel; a bypassed close (Esc/X/backdrop)
  re-queues recovery for next launch. (Re-examine alongside A17-3.3 — this is a narrowing of that fix, not a
  reversal.) **Done** — new `bypassRecoveryModalClose()` recovery slice method (un-park only); AppShell `beforeClose`
  routes through it instead of `acknowledgeRecovery()`.
- **4.2 🟢 Corrupt-config write suppression resolves as SUCCESS all session** — the user edits defaults/viewports
  for hours, all silently unsaved (`configWriteScheduler.ts` ~L259-264). **Fix:** once-per-target toast +
  non-success in the Ctrl+S aggregate (the Audit-7 L1/`saveState` `failed>0` pattern). **Done** — the corrupt branch
  pushes the target onto `failed` AND fires a once-per-target `notifyWriteError({ code: 'CONFIG_CORRUPT' })`
  (`corruptSuppressToastShown` guard); `buildWriteErrorToast` emits an honest "settings not saving" message for that
  code instead of the misleading disk-space/permission copy.
- **4.3 🟢 (pc) Legacy recovery snapshots (bare basename) orphaned by the A17-3.8 flattened-name pruner**
  (`recoverySnapshot.ts`). **Fix:** also match the legacy bare basename in the pruner (the A17-3.8 note already
  flagged legacy-list/prune compatibility — extend it). **Done** — `pruneOldSnapshotsForBasename` now takes the
  `snapshotNameCandidates` (flattened name + legacy bare basename) and counts both toward the per-basename cap.
- **4.4 🟢 Export save-dialog cancel returns the same `{success:false}` as a real write failure** → spurious
  error toast (`export.ipc.ts` ~L86-88). **Fix:** add a `canceled:true` discriminator and treat cancel as a no-op.
  **Done** — cancel returns `{ success: false, canceled: true }`; threaded through the `export:save` contract,
  `doExport`, and `ProjectDropdown.handleExport` (no toast on cancel; real failures still toast).
- **4.5 🟢 `vault:add-recent` overloads `[]` as both failure and empty list** (`vault.ipc.ts` ~L835-853).
  **Fix:** typed envelope (`{ok, recents}` / `IpcEnvelopeError`). **Done** — handler returns `IpcOk<{ recents }>`;
  contract + envelope gate + `ipcEnvelopeAllChannels` inventory updated; `HomeScreen.recordOpen` uses `invokeOk` and
  leaves the displayed list intact on a failed add.
- **4.6 🟢 Bulk Kanban/Task-List ops show unconditional success toasts after swallowing command-chain rejections**
  (`kanbanMultiSelect.svelte.ts`, `multiSelectController.svelte.ts`, `tasklist/frontmatterWriter.ts`). **Fix:**
  gate the success toast on the awaited outcome (the Audit-7 6.2 pattern). (Pairs with M7 in `kanbanMultiSelect`.)
  **Done** — `tagSelectedTiles` + every `multiSelectController` bulk op gate their toast behind the chain's settle;
  `frontmatterWriter.markAllIncomplete` was already gated (Audit-16 6.2).

---

## Phase 5 — LOW: recent-change (Audit-17) regressions

> **🟢 PHASE 5 DONE 2026-06-13** (working tree, not yet committed). `ci:verify` GREEN exit 0 (lint → check →
> test:unit:strict → build → 47 gates). New `src/tests/unit/audit18Phase5.test.ts` (16 tests: 5.1 dispose
> timer-decoupling + no-spurious-write + cleanup/onDestroy source-shape ×4; 5.2 `pushWithoutExecuteOnBoard`
> home-board routing + null no-op + TileHeader defer/route source-shape ×4; 5.3 failed-drain shared-verdict +
> positive control + swap-during-park ×3; 5.4 threshold export + small-reads-back + large-skips-stamps +
> small-foreign-write-rejected + source-shape ×5). Existing `audit17Phase3.test.ts`'s A17-3.4 "sibling re-enters
> its OWN drain" test was rewritten to the new 5.3 shared-verdict contract (the deliberate behaviour change). Three
> ceiling bumps in `check-file-sizes.mjs` (KanbanBoard 1448→1471 for the 5.1 cleanup guard + onDestroy flush;
> TaskListBoard 2202→2209 for the 5.1 cleanup guard; markdownFileWriter 1393→1416 for the 5.4 threshold + size-gate);
> history.svelte.ts / vaultOperations.ts / TileHeader.svelte / filtersAndViews.svelte.ts all stayed under 1000.
> KNOWN_LIMITATIONS.md gained #15 (markdown read-back skipped ≥ 1 MB, accepted) and #14's markdown mention was
> amended to reference the threshold.

- **5.1 🟢 lastView persist `$effect` cleanup flush fires on EVERY effect re-run, structurally killing the 300 ms
  debounce** — both `TaskListBoard.svelte` and `KanbanBoard.svelte` (A17-4.5 regression). The cleanup runs on each
  reactive re-run, not only teardown, so the debounce never accumulates. **Done** — both cleanups now flush ONLY on
  a real board switch (`board?.id !== id`); a same-board dep tick just re-arms the timer. The unmount flush moved
  off the timer: `filters.dispose()` (TaskList) now flushes gated on `hydratedForBoardId` (not the timer the cleanup
  may have nulled), and KanbanBoard's `onDestroy` flushes the captured-id slice. Order-independent: the board-switch
  flush (cleanup, arm-time snapshot) and the unmount flush (dispose/onDestroy) never both fire for the same event.
- **5.2 🟢 (pc) Teardown-time title commit (A17-4.1) renames the `.md` on disk with NO undo entry,
  fire-and-forget, racing the board switch** (`TileHeader.svelte`). **Done** — the teardown commit is `queueMicrotask`-
  deferred past the switch, and a new `historyStore.pushWithoutExecuteOnBoard(command, boardId)` files the
  `RenameTitleCommand` onto the tile's HOME board's stack (threaded `{ boardId: tile.boardId }` so `targetBoardId`
  resolves to the home board and a later cross-board Ctrl+Z auto-switches). `pushBoundedAndNotify` /
  `clearRedoStackAndNotify` gained an optional `boardId` (default `activeBoardId`) so existing callers are byte-for-
  byte unchanged. Non-text teardown stays a cache write (no file rename to reverse).
- **5.3 🟢 (pc) `withDrainedWrites` sibling-parking (A17-3.4): a failing drain makes each queued sibling re-run a
  full drain serially (up to 60 s each); a parked sibling acts on moved-on state.** **Done** — the drain's verdict is
  now carried IN `drainPromise` (a `DrainOutcome` union, not a separately-cleared module var → immune to the
  finally-clears-before-the-await-resolves race). On a failed outer drain a parked sibling THROWS the same error
  instead of `return withDrainedWrites(op)` (no per-sibling re-drain, no duplicate toast); on a successful drain the
  sibling re-validates `currentVaultGeneration()` after the park and bails if the vault swapped (the recursion's
  implicit generation re-capture, made explicit).
- **5.4 🟢 Markdown gateway A17-5.3 read-back doubles per-write IO inside the bounded window** — multi-MB notes on
  slow volumes may hit timeout-then-self-heal flapping (`markdownFileWriter.ts`). **Done** — the post-write content
  read-back is size-gated by the new exported `MARKDOWN_READBACK_BYTE_THRESHOLD` (1 MB): notes below it read the
  bytes back (same-byte-count-foreign-write protection intact); notes at/above accept size-only confirmation
  (residual hole documented in KNOWN_LIMITATIONS #15, mirroring the board scheduler's whole-file decision in #14).

---

## Phase 6 — LOW: canvas / stores + residual narrow corners

> **🟢 PHASE 6 DONE 2026-06-13** (working tree, not yet committed). `ci:verify` GREEN exit 0 (lint → check →
> test:unit:strict → build → 47 gates). New `src/tests/unit/audit18Phase6.test.ts` (5 tests: 6.1 retarget-batch /
> non-active-pane / pointercancel ×3, 6.3 read-failure-refuse + source-shape-narrowness ×2); the behavioral arms
> bite-verified (global-facade spatial → 6.1 reds; neutered `readFailed && !docState` guard → 6.3 reds).
> `tileDragEscape.test.ts` updated for the new required `scope` param (passes `getActiveScope()`). NO ceiling bumps
> (tileDrag.ts ≈465 LOC, propertiesCommands.ts ≈400 LOC — both far under 1000; net deltas are small). **Two scope
> decisions:** (1) **6.1 — no gate extension.** `ci:document-editor-pane-scoped` forbids global
> `boardStore`/`canvasStore` identifiers; the minimal-diff fix keeps those NAMES as scope-derived LOCAL aliases
> (`const { board: boardStore, … } = options.scope`, mirroring TileContainer's own pattern), so adding tileDrag.ts
> to that gate would false-positive on the locals — the behavioral retarget test is the anti-regression pin instead.
> (2) **6.2 — doc-only, no code change** (KNOWN_LIMITATIONS #16); pruning per-docId on unload would re-open the
> Audit-16 1.1 post-reopen staleness class the maps were written to close.

- **6.1 🟢 (pc) `tileDrag.ts` opens/closes spatial batches via the global facade** → a split-pane touch retarget
  can leak an open batch (frozen spatial revision) (~L148/L206/L399/L449). **Fix:** thread `BoardScope` like
  Audit-12 M5 did for `dragDrop.ts`. (Note: `ci:pointer-capture-cleanup` already lists `tileDrag.ts` for the
  pointercancel binding — this is the orthogonal scope-threading gap.) **Done** — `TileDragOptions` gains a required
  `scope: BoardScope`; the action binds `board`/`canvas`/`selection`/`spatial` from it (so begin/endBatch stay
  balanced on the originating pane's spatial index even when a second touch flips the active scope mid-drag), and
  edge-pan now pins `scope.canvas`. Both TileContainer use sites thread the context scope.
- **6.2 🟢 (accept + document) `documentStore` mutationVersions/bodyMutationVersions grow unboundedly per docId
  until vault swap** — documented decision; listed for completeness. **Action:** add a `KNOWN_LIMITATIONS.md`
  entry (cleared on swap; per-docId growth is bounded by session doc count) — no code change unless a real
  memory complaint surfaces. **Done** — KNOWN_LIMITATIONS #16.
- **6.3 🟢 (pc) Properties undo/redo with no obtainable disk base falls back to index `content`/`''` as the file
  body** — doubly-narrow (path absent from index + read-fail/write-succeed), but the blind branch's comment
  wrongly assumes read-failure implies write-failure (`propertiesCommands.ts` ~L193-246). **Fix:** refuse on read
  failure when there's no docState (the B1 contract — `markPathFailed` + surface, don't blind-write index content).
  **Done** — `applySnapshot` tracks a `readFailed` flag; the no-baseline branch now `markPathFailed` + `reportError`
  + throws when `readFailed && !docState` (no live body to fall back on), and only blind-applies the target FM when a
  live editor body IS available. The command rejects → history rollback drops it; never a blind overwrite.

---

## Phase 7 — Gates, tests, and process net

> **🟢 PHASE 7 DONE 2026-06-13** (working tree, not yet committed). All four sub-items closed: 7.1 (gate arm,
> bite-verified) landed with Phase 1; 7.2 (`audit18Phase1.test.ts` + `audit18Phase2.test.ts`, plus the
> per-phase `audit18Phase{4,5,6}.test.ts` matrices) landed with Phases 1–6; 7.4 (KNOWN_LIMITATIONS #14/#15/#16)
> landed with Phases 3/5/6. 7.3 is an ASSESS-with-default-DEFER item — **assessed 2026-06-13, both optional gates
> deferred (no new gate, no source change)**, so this phase adds no code: `ci:verify` state is unchanged from
> Phase 6's GREEN exit 0. With all of Phases 1–7 closed, only H2 Layer-2 (the deferred net-new "Discard corrupt
> tags file" UX, per 1.3) remains outstanding from the whole Audit-18 plan.

### 7.1 🟢 CI gate extension (lands WITH 1.1/H3)
Extend `scripts/check-no-silent-write-abort.mjs` with the `TEXT_TILE_FILE` REQUIRED arm (the two
`hydrateReadFailed` tokens), bite-verified. Already itemized in 1.1 — restated here so the gate work is tracked
as part of the net. **DONE** — `TEXT_TILE_FILE` arm added next to `DOC_EDITOR_FILE`; bite-verified (perturbing
`hydrateReadFailed && !lastLoadedBody` → exit 1, reverted).

### 7.2 🟢 Anti-regression test suites (Phase 1 + Phase 2 parts DONE)
Create `audit18Phase1.test.ts` (H1 parked-fire cancel, H2 corrupt-load gate, H3 TextTile hydrate-failure twin,
M3/M6 reload-cancel, M5 config ENOENT grace, M7 popup-routed bulk add-tag) and `audit18Phase2.test.ts`
(M1 swap-teardown skip, M2 rename/eviction race, M4 rollback identity guard). Each LOW names its own test inline;
the load-bearing behavioral matrices are the H1/H2/H3 ones (the engine-level corpus rows for 3.1/3.2 go into the
existing `frontmatterInvariant.test.ts`). **Phase-1 part DONE** — `audit18Phase1.test.ts` shipped (14 tests:
H1 ×2 via the `createScheduler` primitive, H2 ×5, H3 ×3 gateway-contract twin, M5 ×2 fake-timer-gated, M7 ×2).
M3/M6 reload-cancel is covered structurally by the shared `cancelDirtyGatewayWritersForPath` helper (the helper
is module-private; the existing reconciler suites exercise the surrounding flow). **`audit18Phase2.test.ts` DONE
2026-06-12** (10 tests: M1 swap-teardown skip ×3, M2 rename/eviction race ×4, M4 rollback identity guard ×3; all
three fixes bite-verified).

### 7.3 🟢 Optional gates (assess, default DEFER per Audit-17 6.3 precedent) — ASSESSED 2026-06-13, both deferred (no new gate)
- `ci:no-window-prompt` (from 1.6/M7) — build only if a second `window.prompt`/`window.alert` site exists.
  **Assessed:** swept `src/renderer/**` — **zero** `window.prompt(`/`window.alert(` call sites remain. M7 removed
  the only one (`kanbanMultiSelect.tagSelectedTiles` now routes through the injected `promptForTag()` resolver);
  the surviving textual matches are all comments documenting the replacement (`LinkInsertPopup.svelte` "Replaces
  window.prompt()", `KanbanBoard.svelte` "replaces window.prompt"). With no current instance, a gate would protect
  a class with zero sites — the exact over-fit the Audit-17 6.3 precedent defers, and the jsdom-blindness argument
  was already weighed when the plan set the default to DEFER. The convention is self-documenting (LinkInsertPopup's
  comment) and the one fixed site is behaviorally pinned by `audit18Phase1.test.ts` (M7 drives `tagSelectedTiles`
  with the popup resolver stubbed; no `window.prompt` reference remains). **DEFERRED** until a second site appears.
  (Note: two `confirm()` calls in `TagsBrowser.svelte` are out of scope — `confirm()` IS implemented in Electron's
  renderer and the gate is specifically `window.prompt`/`window.alert`.)
- A "Reload handlers must cancel dirty gateway writers" pin (from 1.4/M3/M6) — the shared helper + the behavioral
  test already cover it; a source-shape gate would over-fit one helper. **Assessed:** the M3/M6 fix is centralized
  in the single `cancelDirtyGatewayWritersForPath(rel)` helper called at the top of both Reload handlers
  (`promptModifiedFile` + `promptMarkdownPendingWriteConflict`); a source-shape gate would pin that one helper's
  internal shape (over-fit), and the existing reconciler suites already exercise the surrounding flow. **DEFERRED.**

### 7.4 🟢 Docs
- `KNOWN_LIMITATIONS.md`: **DONE for 3.6** — #14 (board post-write baseline is size-only, accepted) landed with
  Phase 3. **DONE for 5.4** — #15 (markdown read-back skipped ≥ 1 MB, accepted) landed with Phase 5 (and #14's
  markdown mention was amended to reference the 1 MB threshold). **DONE for 6.2** — #16 (unbounded
  `documentStore` mutationVersions, accepted) landed with Phase 6.
- Update this plan's status bullets + the `MEMORY.md` index line as phases land. **Phase 3 bullets updated; Phase 5
  bullets updated + MEMORY index line updated 2026-06-13; Phase 6 bullets + 7.4 updated 2026-06-13.**

---

## Refuted findings (do NOT re-chase; archived for the next audit)

1. **filtersAndViews.dispose() builds the flush slice at teardown time** — contract drift is textually real but no
   reachable trigger exists; hardening note only.
2. **Rename-cascade sentinel clear swallowed silently** — misattributed branch; the success-path clear DOES
   `reportError`. The bare catch is on a near-unreachable defensive branch.
3. **closeDrainGate blanket `setEditable(true)` reopens the 5.7 window** — the gate effect reads
   `hydrateReadFailed` reactively and immediately re-freezes; one-effect-flush window, no competing writer.
4. **applyFrontmatterPatchRebased silent bails on swap** — history stacks are cleared on every vault swap, so no
   surviving stack can replay; siblings share the same silent-bail swap contract.
5. **Self-write watcher suppression swallows a genuine external edit for the session** — the 30 s hashing reconcile
   is a content-aware backstop; worst case ≈30 s staleness, by design. (But LOW 3.7's DELETE-shaped gap IS real.)
6. **DeleteTask/AddTask undo misroutes by stale absolute position** — impossible as described: undo is strictly
   LIFO per board stack, so the snapshot is valid by construction when reached.

---

## Suggested execution order

| Order | Phase | Why |
| --- | --- | --- |
| 1 | **Phase 1** | The 3 HIGH + the cheap mediums = the audit's "smallest set that unblocks." Two HIGHs (H3, H1) mirror shipped fixes; H2 is small-medium. ~1 day with tests. **Dogfooding can begin after this.** |
| 2 | **Phase 2** | The remaining mediums (swap-teardown, rename/eviction race, rollback guard) — safe during dogfooding; none fires on a local SSD vault. |
| 3 | **Phase 3** | External-edit / baseline integrity LOWs. Prioritize 3.4/3.5/3.6 if the vault will live on OneDrive/Dropbox; otherwise opportunistic. |
| 4 | **Phase 4** | Recovery / error-honesty LOWs — highest honesty payoff per line; 4.1 re-narrows an A17 fix. |
| 5 | **Phase 5** | Audit-17 regressions — close the lastView-debounce + title-rename classes. |
| 6 | **Phases 6–7** | Canvas/store residuals + gate/test/doc net; safe while already dogfooding. |

**Smallest unblock set (per the audit):** H3 → H1 → H2 → M3+M6 → M5 → M7 (= Phase 1). If the vault will be
cloud-synced, also pull 3.5 / 3.6 / M2 forward.

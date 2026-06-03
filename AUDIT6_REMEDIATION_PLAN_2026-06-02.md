# Audit-6 Remediation Plan — Data Integrity

**Date:** 2026-06-02
**Scope:** Data-integrity issues found in the Audit-6 adversarial review (9-agent sweep + independent verification against installed `yaml@2.9.0` / `js-yaml@4.1.1`).
**Status:** Phase 1 (C1) COMPLETE. Phase 2 (H1, H2, H3, H4, L27-theme, M1) COMPLETE — fixes + targeted tests landed, new `ci:reconciler-vault-guard` gate added (Phase 5.3), full `ci:verify` green (build + 33 guards; the lone full-run failure was the pre-existing Windows temp-dir flake in `recoverySnapshot.test.ts`, which passes in isolation). Phase 3 (M2, M3, M4, M5) COMPLETE 2026-06-02 — fixes + targeted tests landed (incl. Phase 5.1 M2 numeric corpus cases); full `ci:verify` green end-to-end (37/37 steps, no flake this run; 3621 unit tests pass). **Phase 4 (ALL LOW items 4a–4f) COMPLETE 2026-06-02** — fixes + targeted tests landed for L12/L13/L14/L15/L16/L18/L22/L23/L24/L25/L27/L28/L29/L30/L31 + VS1/VS2; L17 was already fixed (ConnectionLabel `$effect` cleanup) and L20 is already adequately surfaced (the unreadable-`.dirty` snapshot rides a prominent `dirtyFlag.check` toast). Full `ci:verify` green end-to-end (exit 0, 38 steps; 3648 unit tests pass). One deliberate deviation: **L27** uses a *narrow* guard (refuse the splice only when a CHANGED/DELETED key's subtree carries the anchor/alias) rather than the plan's broad "refuse any anchored doc" — the broad form regressed Audit-4 DI-05 (a tag-add on a doc with an untouched `<<: *base` merge key must keep it verbatim); the narrow form fixes the reproduced bug AND preserves DI-05. **L26** (call-site scoping of `ci:md-writers-reconcile-editors`) was attempted and DEFERRED to Phase 5.4 (the plan also lists it there): both enclosing-function scoping and "reconcile-after-write" false-positive on the legitimate write-in-helper/callback + reconcile-in-orchestrator pattern; correct scoping needs path data-flow analysis. Gate left at the robust file-level form with the finding documented in the script. Ceiling bump: `vault.svelte.ts` 1575 → 1595 (L25+L31 comments + the `historyStore` import). **Phase 5 (class-closing tests & gates) COMPLETE 2026-06-03** — 5.1 frontmatter corpus gaps (general set/delete/add op matrix + comment positions + CRLF×BOM + set-on-every-key) and 5.2 property-based set/delete/add fuzzer landed in `frontmatterInvariant.test.ts` (264 tests; verified they BITE — reverting M2 reds 10, incl. the fuzzer's byte-identity assertion); 5.3 `ci:reconciler-vault-guard` was already done in Phase 2; 5.4 (L26) hardened `ci:md-writers-reconcile-editors` from file-level to **same-top-level-block** call-site scoping (a reconcile in an unrelated sibling class no longer counts; `// reconcile-elsewhere:` escape for the rare cross-declaration case; per-path data-flow left to Phase 6 — verified zero false positives on all 5 writers + bites the cross-class gap); 5.5 new `ci:command-roundtrip-coverage` gate (34th) requires an execute/undo round-trip test per concrete Command or a documented full-snapshot/inverse-op exemption (71 commands: 59 round-tripped, 12 exempt) + 7 new round-trip tests for the untested delta/structure commands (kanban Add/Rename/Reorder column + Add card; tasklist Add/Rename section + MoveTaskBlock — incl. the `ReorderColumnCommand` H1-twin), verified it bites. Full `ci:verify` green end-to-end (34 gates). Phase 6 (optional refactor) not started.
**Inputs:** 1 CRITICAL, 4 HIGH, 5 MEDIUM, 21 LOW confirmed; 4 refuted; 3 verifier-stumbled.

---

## 0. Why this plan is structured to *end* the cycle, not just patch instances

Five prior audits fixed dozens of frontmatter/concurrency bugs, yet Audit-6 still found a CRITICAL. That is not (mostly) because the code is bad — it is because **the fixes have been instance-level while two of the bug sources are class-level**, and **the gates that should catch the class have blind spots**. This plan therefore follows three rules:

1. **Every fix closes the bug with a test or CI gate that would fail on the whole class**, not just the one input that was found. (See Phase 5 — the most important phase for your "will it ever be ready" worry.)
2. **The dogfood blocker tier (Phases 1–2) is surgical and ships first.** It is a *short* list. You can start using the app the moment it lands.
3. **The architectural question is answered with a decision gate (Phase 6), not assumed.** A refactor is offered, but the analysis below argues it is **optional**, not required.

### Is a broader refactor needed? — Honest assessment

**Short answer: No big rewrite. The subsystem is salvageable. The thing that makes it *feel* doomed is a gap in the test corpus, not the architecture.**

The recurring issues cluster into exactly **three** root causes, and only one is "architectural":

| Root cause | What it generates | Is it architectural? | Cure |
| --- | --- | --- | --- |
| **A. Frontmatter "diff object-vs-source then splice"** with **two different parsers** (`yaml` pkg for structure, `js-yaml` for the read) | C1, M2, L23/L27/L28 — canonicalization, comment loss, edge corruption | *Partly.* The dual-parser diff is a real smell, but the splice is small (~260 LOC) and now well understood. | **Plug the specific holes + make the fuzz corpus exhaustive** (Phase 5). Optionally collapse to one parser/operation model (Phase 6) to delete the diff step entirely. |
| **B. Vault-swap guard applied per-site instead of structurally** | H3, H4, L11 — the reconcilers read `vaultStore.path`, await, then mutate, with no `isStillSameVault` recheck | **No — this is a discipline gap.** The guard *exists* (`vaultIdentity.ts`); it just wasn't applied to the per-kind reconcilers. | **Make the safe path the only path:** one guarded dispatch wrapper + a CI gate that fails if a reconciler awaits after reading the vault path without re-checking. |
| **C. Hand-rolled delta undo commands** | H1, L22/L29/L30 — each delta command is bespoke and individually error-prone | **No — pattern gap.** | A shared delta-command helper + extend the snapshot-discipline gate to catch "command silently no-ops." |

**The key realization:** bugs keep "slipping through" because the **`ci:frontmatter-invariant` corpus has gaps** (it never set a value on a bare empty key; never tested `1_000`/`0b101` as untouched siblings; only ever edits `tags`). The audit found what the gate should have. **Fix the gate's coverage and the class stops regressing** — that is far cheaper and lower-risk than a rewrite, and it is the actual answer to "it never gets ready."

**Recommendation:** Do **Phases 1–5** (tactical fixes + class-closing gates). This gets frontmatter from **4/10 → ~8/10** and unblocks dogfooding. Treat **Phase 6** (single-parser CST refactor) as an *optional, post-dogfood* investment — valuable for eliminating the diff step structurally, but **not on the critical path** and itself risky if done before the corpus (Phase 5) exists to validate it.

> Do **not** refactor the frontmatter engine before dogfooding. C1 closes the acute wound; a refactor on the critical path would add new risk to the exact code you're trying to make trustworthy. Build the corpus first; let it guard either the patched engine *or* a future rewrite.

---

## Phase overview

| Phase | Theme | Gate to dogfooding? | Effort |
| --- | --- | --- | --- |
| **1** | CRITICAL — frontmatter destruction | ✅ **Blocker** | S |
| **2** | HIGH + the one note-body-losing MEDIUM (M1) | ✅ **Blocker** | M |
| **3** | Remaining MEDIUM | Recommended pre-dogfood | M |
| **4** | LOW (grouped) | Post-dogfood OK | M |
| **5** | **Class-closing tests & gates** (anti-whack-a-mole) — ✅ DONE | Do alongside 1–3 | M |
| **6** | *Optional* deep refactor (single-parser frontmatter) | Post-dogfood, decision-gated | L |

Effort: **S** ≈ <1 h · **M** ≈ a few h · **L** ≈ a day+.

---

## Phase 1 — CRITICAL (dogfood blocker) — ✅ DONE

### C1 · Empty-key frontmatter splice corrupts the whole block — ✅ FIXED
- **Done 2026-06-02:** added the `value.range[1] > value.range[0]` zero-width guard to `valueIsSingleLineScalar` in `frontmatterEngine.ts` (bare keys now route through `serializeKeyValue`), documented the comment-moved known-minor in the `patchFrontmatterSource` docstring, and added a 37-case `Audit-6 C1` block to `frontmatterInvariant.test.ts` (3 keys × 3 positions × ±comment × ±newline + 1 end-to-end `assembleMarkdownFile`). Verified the tests BITE (all 37 fail with the guard reverted, showing both the whole-block-collapse and `home# note` value-mangle modes). `ci:frontmatter-invariant` (198 tests), `npm run check` (0 errors), `npm run lint` (0 errors) all green.
- **File:** `src/renderer/lib/vault/frontmatterEngine.ts` — `patchFrontmatterSource`, `valueIsSingleLineScalar` branch (L188–L206).
- **Mechanism:** a bare `aliases:` parses to a **zero-width scalar** (`value.range = [n,n,n]`). The value-only splice emits `aliases:` + `home` = `aliases:home` (no space) → `js-yaml` throws on re-read → `parseMarkdownFile` collapses frontmatter to `{}` → corrupt bytes round-trip to disk. Variant: `aliases: # note` → `aliases: home# note` (value silently mangled to the string `home# note`).
- **Reproduced:** yes — directly against installed `yaml@2.9.0` + `js-yaml@4.1.1` (`range [8,8,8]`; `js-yaml.load('aliases:home')` throws `end of the stream … expected`).
- **Fix (S):** exclude the zero-width value from the value-only splice so it routes through `serializeKeyValue` (which emits `key: value` correctly):
  ```ts
  const valueIsSingleLineScalar =
    !!value &&
    isScalar(value as object) &&
    !!value.range &&
    value.range[1] > value.range[0] &&          // ← R6 C1: reject zero-width/empty value
    source.slice(value.range[0], value.range[1]).indexOf('\n') === -1;
  ```
- **Known minor after fix:** a comment on a *bare* key (`aliases: # note`) is moved when you first set the key's value (the whole pair re-serializes). This is the documented collections/type-change trade-off — acceptable, far better than corruption. Note it in the docstring.
- **Test/gate (mandatory — this is why it slipped):** add `frontmatterInvariant` cases that **set a value on a bare empty key** (`aliases:`, `tags:`, `cssclasses:`, with and without trailing comment, as first/middle/last line, with/without trailing newline) and assert the output **re-parses** and the value is correct. Without this case the gate stays blind. See Phase 5.

---

## Phase 2 — HIGH + M1 (dogfood blocker tier) — ✅ DONE

**Done 2026-06-02.** All six items landed with tests; `npm run check` (0 errors), full unit suite (3608 passing), and every `ci:*` guard green. Summary:
- **H1** — `ReorderSectionCommand` rewritten as a general N-section reorder (`applySectionOrderLive` re-derives task slices from live section boundaries); multi-slot drags now apply + round-trip execute→undo→redo. New `sectionCommandsDelta.test.ts` cases; the Audit5 adjacent-swap involution cases stay green (2-swap is the N=2 case).
- **H2** — `UpdatePropertiesCommand` frontmatter legs now rebase: diff the two legs for OWNED keys, merge only those onto the LIVE base (open-editor cache, else fresh disk read), preserving any untouched/externally-added key; per-key conflict → keep external + "Apply anyway" toast. Two new tests (cache-base + disk-base survival).
- **H3 / H4 / L27** — per-site `captureVaultIdentity()` + post-`await` `isStillSameVault()` guards in the tags / board / theme reconcilers (`reloadBoardFromDisk` now reads the vault path + guards internally, covering both the silent and user-Reload callers). New `reconcilerVaultSwapGuard.test.ts` simulates a swap landing during each read.
- **M1** — gateway `'defer'` / budget-exhausted drift aborts now `markPathFailed` + throw (was a bare `return` reporting SUCCESS that let `.filo/.dirty` be markClean'd while the edit never landed). New `gatewayDriftDeferFailed.test.ts`; the existing churn test updated to expect the throw + failed-path.
- **Phase 5.3 gate** (done alongside, per execution order) — new `scripts/check-reconciler-vault-guard.mjs` + `ci:reconciler-vault-guard` in `ci:verify`; verified it BITES when any guard is removed. Closes root-cause B structurally.
- Ceiling bump: `markdownFileWriter.ts` 1088 → 1110 (M1's +22 LOC).

### H1 · Multi-slot Task-List section drag is silently dropped (and not undoable)
- **File:** `src/renderer/commands/sectionCommands.ts` — `ReorderSectionCommand` ctor (L294–L310) + `swapAdjacentSectionsLive` (L242–L277); caller `components/boards/TaskListBoard.svelte` `onFinalizeSections` (L432–L486).
- **Mechanism:** the Audit5 delta rewrite only sets `idA/idB` when **exactly 2** positions change. A drag across 2+ slots changes 3+ positions → `idA/idB` stay `''` → `execute()`/`undo()` both early-return. The component doesn't apply the move itself, so the cache never reorders and the section snaps back. Context-menu Move up/down is safe (always 2 changed).
- **Fix (M):** make `ReorderSectionCommand` a **general** N-section reorder, not an adjacent swap:
  - Capture the full `{id → position}` map before/after; on each leg apply the new order to the **live** cache (re-derive task-slice order + renormalize section positions to be strictly increasing/contiguous). Mirror the delta discipline used by `DeleteSectionCommand`.
  - *Quick alternative* if you want the smallest diff: when `moved.length !== 2`, fall back to the full-slice `persistTaskListStructure(after.sections, after.tasks)` for that leg (accept the out-of-band-revert trade-off for multi-slot drags only).
- **Test:** drive a 3-section *move-first-to-last* reorder through `execute()` → `undo()` → `redo()` and assert order at each step.

### H2 · Properties-popup undo clobbers externally-added frontmatter keys
- **File:** `src/renderer/commands/propertiesCommands.ts` — `applySnapshot` (L101–L155); whole-FM snapshot taken in `PropertiesPopup.svelte` (L168–L173 / L464–L474).
- **Mechanism:** `UpdatePropertiesCommand` snapshots the *entire* FM object and `setFrontmatter`-replaces it wholesale on undo, with no rebase. Any key added externally (or by another writer) between the popup edit and Ctrl+Z is erased. The card/task commands already avoid this via `applyFrontmatterPatchRebased`; Properties was skipped (Audit2 4.2 gap).
- **Fix (M):** route the FM legs through `applyFrontmatterPatchRebased`: compute the **changed-key patch** (diff before vs after) + an `expectedCurrent`, and merge-rebase against live/disk FM instead of `setFrontmatter(whole object)`. Preserve any key not in the captured snapshot.
- **Test:** edit one property → externally add `reviewed: true` → undo → assert `reviewed` survives.

### H3 · Cross-vault tag corruption — tags.json reconciler after a swap
### H4 · Cross-vault board injection — board reconciler after a swap
### L27-theme · Theme reconciler after a swap (visual only, same root)
- **File:** `src/renderer/stores/vaultExternalReconcilers.ts` — `reconcileTagsJsonChange` (L184–L207), `reconcileBoardJsonChange` (L68–L94) + `reloadBoardFromDisk` (L104–L136), `reconcileThemeChange` (L221–L242).
- **Mechanism:** each captures `vaultStore.path`, awaits a disk read (`tags:load` / `loadBoard` / `refreshAvailable`), then mutates — **with no `isStillSameVault` recheck**. A vault swap during the read applies the outgoing vault's data to the new vault. H3 is worst: `applyExternalReload` **unconditionally `scheduleSave()`s**, persisting vault A's tag registry into vault B's `.filo/tags.json` on disk. This is the exact G1 class fixed for rename/cascade but never applied to the per-kind reconcilers (grep-confirmed: zero `captureVaultIdentity` calls in the file).
- **Fix (M) — per-site:** at each reconciler entry `const captured = captureVaultIdentity()`; after every `await`, `if (!isStillSameVault(captured)) return;` before any store mutation. (Mirrors `runExternalRenameCascade`.)
- **Fix (M) — class-level (do this too, it's the real cure for B):** introduce a single `runReconcilerGuarded(fn)` wrapper that captures identity, runs the reconciler, and refuses to apply if the vault changed — and make `dispatchExternalChangeBatch` route **every** per-kind reconciler through it. Then add the Phase-5 gate so a future reconciler can't forget.
- **Test:** simulate a swap landing between the read and the apply for tags + board; assert no cross-vault mutation and no `scheduleSave`.

### M1 (promoted) · Gateway drift-abort reports SUCCESS → deferred write silently lost
- **File:** `src/renderer/lib/vault/markdownFileWriter.ts` — `writeMarkdownFileImpl` defer return (L543) + budget-exhausted return (L571).
- **Why promoted to the blocker tier:** it is the only finding below HIGH that can **silently lose a note body** *and* clear the crash sentinel while the indicator says "saved." That combination is exactly what dogfooding must not have.
- **Mechanism:** on "defer"/budget-exhausted the impl returns before `trackComponentWrite`, so `performWrite` resolves as success → `safeEndWrite(true)` → path dropped from pending, sentinel may `markClean`. Editor stays dirty but on disk nothing changed; quit → loss with a clean sentinel. Inverse of the FM scheduler's DI-13 (`markPathFailed` + throw) which the gateway never mirrored.
- **Fix (S):** on the defer and budget-exhausted early returns, `markPathFailed(vaultRoot, relPath)` (and throw, like `frontmatterWriteScheduler` DI-13) so the path stays in `failedVaultPaths`, the indicator shows **error**, and `.filo/.dirty` survives. (The `'reload'` return at L536 is benign — leave it.)
- **Test:** force a drift→defer on a dirty file, then `flushAll` + read save-state → assert `error` + path in failed set + sentinel present.

---

## Phase 3 — MEDIUM — ✅ DONE

**Done 2026-06-02.** All four items landed with tests; `npm run check` (0 errors), full strict unit suite (3621 passing), `npm run lint` (0 errors), and full `ci:verify` green end-to-end (37/37 steps). Summary:
- **M2** — `frontmatterEngine.patchFrontmatterSource` now derives the value-comparison object via `js-yaml` CORE_SCHEMA (the read path's parser) instead of the `yaml` package's `doc.toJS()`, so an untouched `1_000` / `0b1010` sibling compares equal (both `1000` / `10`) and splices verbatim instead of being canonicalised on a neighbour's edit. Falls back to `doc.toJS()` on the rare js-yaml-rejects/yaml-accepts source (never returns null → never a lossy full dump). Verified against installed `yaml@2.9.0` / `js-yaml@4.1.1`. **Phase 5.1 corpus:** added `1_000`/`0b1010`/`0o17`/`0xFF` to the byte-equality `SCALAR_CLASSES`; confirmed the 2 mismatch cases BITE (fail on the old `doc.toJS()` comparison).
- **M3** — both single-tag writers (`writeTagChangeToTileMarkdown` / `writeTagChangeToMarkdownPath` in `fileTags.svelte.ts`) now `vault:stat` + `refreshBaselineAfterWrite` after the direct `.md` write, so the next gateway/editor write doesn't false-trip a "modified externally" drift prompt. New `tagWriteBaselineRefresh.test.ts`. Ceiling bump: `fileTags.svelte.ts` 1029 → 1052.
- **M4** — new shared `lib/boards/seedFrontmatterFromDisk.ts` (`seedDocumentFrontmatterFromDisk`) reads the CURRENT bytes from disk (`readMarkdownForHydrate`, with `rawFrontmatter`) to seed the FM cache for a card/row with no open editor; awaited before the (still-sync) `ensureSeededFm` index-seed in the Kanban writer (`updateTileFrontmatter`), the Task writer (`updateRowField` / `markAllIncomplete` / `setNotesBody`), and the Kanban bulk-tag path (`kanbanMultiSelect.tagSelectedTiles`). A key an external editor added since the last index rebuild is no longer dropped by the subsequent source-preserving write, and the `rawFrontmatter` seed restores comment/key-order preservation the index seed lacked. The field-setter signatures became `Promise<void>` (handlers ignore the return); `ensureSeededFm` / `buildTaskFieldCommand` stayed sync (kept off the undo/redo construction path). New `kanbanFrontmatterSeedFromDisk.test.ts`.
- **M5** — `dirtyFlagRecovery.flushDirtyFlagSentinel()` exports the sentinel-mutex tail; `handleFlushAndQuit` awaits it (via an optional `flushSentinel` dep wired in `App.svelte`) before `app:ready-to-quit` on BOTH the happy path and "Quit anyway", so the queued `markClean`/`markDirty` lands before main destroys the renderer — no phantom recovery prompt next launch. Two new ordering tests in `handleFlushAndQuit.test.ts`.

### M2 · Cross-parser canonicalization of untouched `1_000` / `0b101` — ✅ FIXED
- **File:** `frontmatterEngine.ts` L132 (`current = doc.toJS()`) vs `markdownSync.ts` L106 read (`js-yaml` CORE_SCHEMA).
- **Reproduced:** yes (`yaml` keeps `"1_000"`/`"0b101"` as strings; `js-yaml` CORE returns `1000`/`5`). `valuesEqual("1_000", 1000)` is false → untouched key looks "changed" → rewritten.
- **Fix (S):** compute the equality-comparison object with the **same** parser as the read. Keep `parseDocument` for CST ranges, but derive `currentObj` via `jsyaml.load(source, { schema: CORE_SCHEMA })` for `valuesEqual`. (This is the cheap version of Phase 6's single-parser goal.)
- **Test:** add `1_000`, `0b1010`, `0o17`, `007`, `0xFF` as **untouched siblings** to the byte-equality corpus.

### M3 · Single-tag write doesn't refresh the gateway drift baseline → false "modified externally" — ✅ FIXED
- **File:** `src/renderer/stores/fileTags.svelte.ts` — `writeTagChangeToTileMarkdown` / `writeTagChangeToMarkdownPath`.
- **Fix (S):** after the tag IPC succeeds, stat the file and `refreshBaselineAfterWrite(relPath, postStat.mtimeMs, postStat.size)` — matching the gateway/board/config schedulers. (Or route the tag write through the gateway.)
- **Test:** tag an open tile, then trigger the editor's pre-write drift check → assert no prompt.

### M4 · Kanban/Task field edit (no open editor) seeds FM from a stale index → drops external keys — ✅ FIXED
- **File:** `src/renderer/lib/kanban/kanbanFrontmatterWriter.ts` — `ensureSeededFm` (L74–L83).
- **Mechanism:** seeds `documentStore.setFrontmatter(docId, vaultIndexStore.getMetadata(path)?.frontmatter)` — from the index, not disk, and the staleness is **durable** (the sync-frontmatter reconciler only refreshes the cache for *open* editors). A later card edit then drops the externally-added key.
- **Fix (M):** seed from a fresh disk read (`readMarkdownForHydrate`) with `rawFrontmatter`, matching the orphan path (`applyOrphanPatchRebased`), so source preservation + key merge both work.
- **Test:** card with no editor → external add `priority: high` → toggle `completed` → assert `priority` survives.

### M5 · Quit destroys renderer before `.filo/.dirty` `markClean` flushes → phantom recovery prompt — ✅ FIXED
- **File:** `src/renderer/lib/vault/dirtyFlagRecovery.ts` (sentinel mutex) + `handleFlushAndQuit.ts` (L64–L66) + `writeStateTracking.ts` (`endWrite` fire-and-forget `markClean`).
- **Fix (S):** export `flushDirtyFlagSentinel()` returning the current `sentinelMutex` tail (`await sentinelMutex.catch(() => {})`); `await` it in `handleFlushAndQuit` **before** `send('app:ready-to-quit')`.
- **Test:** type → quit → assert the markClean IPC is awaited before ready-to-quit; sentinel absent next launch.

---

## Phase 4 — LOW (grouped; post-dogfood OK) — ✅ DONE

**Done 2026-06-02.** Every item landed with targeted tests; `npm run check` (0 errors), full unit suite (3648 passing), and full `ci:verify` green end-to-end (exit 0). Per-item outcomes:

- **4a** — L27 narrow anchor/alias guard in `frontmatterEngine.patchFrontmatterSource` (refuse the splice only when a CHANGED/DELETED key's subtree carries `&a`/`*a`; an anchor in an untouched key still splices verbatim, preserving DI-05's `<<: *base`); L23 top-level-only docstring + nested-comment pinning tests; L28 scalar→collection trailing-comment pinning test. New `Audit-6 L27/L23/L28` blocks in `frontmatterInvariant.test.ts` (210 tests).
- **4b** — L13 `listRecoverySnapshots` excludes sentinel basenames (`.dirty`, `*-pending.json`, `quit-failure.json`); L21 `recovery:list` re-throws a real scan failure (EACCES/EBUSY) instead of `[]` so the renderer's `vault.recovery-snapshots` catch surfaces a "couldn't scan, check manually" toast. L20 left as-is (the unreadable-`.dirty` snapshot already rides a prominent toast). Tests in `recoverySnapshotList.test.ts`.
- **4c** — L14 `conflictResolver.frontmatterEqual` uses `valuesEqual` (key-order-insensitive, was `JSON.stringify`); L12/VS1 `FileMetadata.rawByteSize` populated in `parseMarkdown` + used by `isLikelyPartialRead`, and the sync-frontmatter branch now guards a truncated-FM read; L15 small-file (`<CROSS_BASENAME_MIN_SIZE_BYTES`) floor on the same-basename rename pass + positive-hash-match short-circuit (the broader "refuse any asymmetric-hash pair" was rejected — it broke the legitimate attachment-move test); L25 `runRecoverySequencer` now uses the generation-aware `captureVaultIdentity()`/`isStillSameVault(captured)` instead of the path-only local. Tests in `conflictResolver.test.ts`, `renameCorrelationColdCache.test.ts`.
- **4d** — L29 `UpdateKanbanColumnCommand` only re-applies fields that actually changed; L30 `AddCard`/`AddTask` deep-clone `style`; L22 `persistTaskListStructure` forces strictly-increasing section positions (de-collides clamped trailing sections); L31 `save()` awaits `historyStore.whenChainSettled()` before flushing. Tests in `updateKanbanColumnCommand.test.ts`, `sectionCommandsDelta.test.ts`, `historyAsyncSerialisation.test.ts`.
- **4e** — L16 both drag controllers (`kanbanDragController` via `dispose()`, `taskDragController` via `cancelDrag()`) detach a still-armed `pointerup` on unmount-while-pressed; L17 was already fixed (ConnectionLabel `$effect` cleanup — verified). Tests in `kanbanDragController.test.ts`, `taskDragController.test.ts`.
- **4f** — L18 `config:load-all` tags a top-level failure (`__loadAllFailed`) so `loadVaultCandidate` pauses ALL config writes (preserving intact-but-locked files) + one low-key toast, instead of seeding defaults; L24 config-write ENOENT re-stats once to distinguish a transient unlink (blip → writes) from a real delete (still gone → respected). L26 DEFERRED to Phase 5.4 (call-site scoping false-positives on the write-in-callback + reconcile-in-caller pattern; needs data-flow analysis — documented in the gate script). Tests in `vaultCandidate.test.ts`, `configResurrectionGuard.test.ts`.

### 4a. Frontmatter engine edge cases (same module as C1/M2)
- **L27 · Anchor edit flips an aliased key** (reproduced). *Fix (S):* refuse the source-splice when the document has anchors — `if (doc.anchors && [...].length) return null;` so the caller dumps; or detect `&`/`*` on a pair and skip its value-only splice. Add an anchored-sibling corpus case.
- **L23 · Nested map/list edit drops inner comments** (R1 is top-level-only). *Fix (M or doc):* either recurse the per-pair splice into changed block collections, or **document the limit explicitly** ("verbatim preservation is top-level only") + add a pinning test. Recommend doc + test now, recurse later.
- **L28 · scalar→collection drops trailing comment.** *Fix (S):* it's a documented trade-off — just add a regression test pinning the boundary so any *widening* is caught.

### 4b. Recovery-surface honesty
- **L13 ·** exclude sentinel basenames (`.dirty`, rename/tag sentinels) from `listRecoverySnapshots`, or snapshot the unreadable sentinel to a non-`recovery/` forensic path.
- **L20 / L21 ·** `recovery:snapshot` and `recovery:list` swallow transient lock failures silently. *Fix (S):* distinguish `ENOENT` (truly nothing → `[]`) from `EACCES/EBUSY` (locked → log + a low-key "couldn't scan recovery, check `.filo/recovery` manually" toast). Closes the "recovery invisible exactly when the disk is locked" class (verifier-stumbled intersection).

### 4c. Concurrency residue
- **L15 · Same-basename rename mis-pair** on exact size coincidence + asymmetric cache. *Fix (S):* in `renameCorrelation.ts`, extend the cold-cache guard to also refuse when sizes are equal but **neither side has a comparable hash** (require a positive hash *match*, not mere absence-of-mismatch), and/or apply the `CROSS_BASENAME_MIN_SIZE_BYTES` floor to the same-basename pass. Add the asymmetric-cache test case the suite is missing.
- **L12 · partial-read heuristic measures body, not raw bytes** + **verifier-stumbled: `sync-frontmatter` has no partial-read guard.** *Fix (M):* carry `rawByteSize` on `FileMetadata` for the shrink ratio, and add a partial-read sanity check to the `sync-frontmatter` branch so a mid-write truncated-FM read can't clobber tile caches/tags.
- **L14 · `frontmatterEqual` nested-key-order false positive.** *Fix (S):* deep-canonicalize (recursively sort keys) before compare, or compare `rawFrontmatter` bytes.
- **L25 · `runRecoverySequencer` uses a path-only guard shadowing the generation-aware one.** *Fix (S):* `captureVaultIdentity()` before the `recovery:list` await; remove the shadowing local `isStillSameVault`. (Pre-existing function-wide; fold into Phase 2's reconciler-guard work.)

### 4d. Latent undo foot-guns (not triggerable today — defensive)
- **L29 · `UpdateKanbanColumnCommand` writes all 3 fields every leg.** *Fix (S):* apply only the field(s) that actually changed (store the diff at construction).
- **L30 · `AddCard`/`AddTask` store `style` by reference.** *Fix (S):* `this.style = style ? this.snapshot(style) : style;`.
- **L22 · `DeleteSection` keep-tasks tail-collision.** *Fix (S):* renormalize to strictly-increasing unique positions in `persistTaskListStructure`, or detect collision → full-slice fallback.
- **L31 · `save()` lacks a `runChained` quiescence gate.** *Fix (S):* `await historyStore.pendingChain` (or loop flushers until all report empty) before the final flush pass.

### 4e. Lifecycle leaks (transient, self-healing)
- **L16 · drag-controller `pointerup` listener** not removed on unmount-while-pressed. *Fix (S):* store the handle; `removeEventListener` in `endDrag()`/`dispose()`.
- **L17 · `ConnectionLabel` hide-timeout** not cleared on destroy. *Fix (S):* `clearTimeout(hideTimeout)` in `onDestroy`.

### 4f. Config & CI
- **L18 / L24 · `config:load-all` and config-write ENOENT silent skips** on a OneDrive/AV blip. *Fix (M):* on a top-level load failure, return `{ ok:false, code }` (or mark targets corrupt) so openVault doesn't seed defaults over intact config; on config-write ENOENT-with-baseline, re-stat once to disambiguate transient-unlink from intentional-delete (or `markPathFailed` + keep payload armed). At minimum surface a low-key toast.
- **L26 · `ci:md-writers-reconcile-editors` is file-level, not call-site.** *Fix (M):* scope the check to each write call site (same function/block, ideally same `relPath` arg). See Phase 5.

---

## Phase 5 — Class-closing tests & gates (the part that ends the cycle) — ✅ DONE 2026-06-03

> This phase is what makes Audit-7 boring. Do it **alongside** Phases 1–3, not after.

**Done 2026-06-03 — per-item outcome (full `ci:verify` green end-to-end, 34 gates):**
- **5.1 ✅** — `frontmatterInvariant.test.ts` gained a general object-patch op matrix (`set`/`delete`/`add` on any key — not just the tag ops), the comment-position cases (leading / standalone / standalone-above-a-deleted-key / inline-trailing), a "set a value on EVERY key leaves the other lines byte-identical" matrix, and a CRLF×BOM dirty-set matrix through `assembleMarkdownFile`. Each asserts the three invariants (re-parses; untouched single-line scalars byte-identical; touched keys value-correct). Suite 210 → 264 tests.
- **5.2 ✅** — a `fast-check` fuzzer builds frontmatter from RAW source lines mixing empty/bare keys, the canonicalisation-prone numeric forms (`02134`/`1_000`/`0xFF`/`0o17`/…), quoted scalars, and nested objects, then applies a random `set`/`delete`/`add` op and asserts the same three invariants (400 runs). **Verified it BITES:** reverting M2 (the engine's js-yaml-CORE comparison → `doc.toJS()`) reds 10 Phase-5 cases including the fuzzer's byte-identity assertion.
- **5.3 ✅** — `ci:reconciler-vault-guard` was already landed in Phase 2.
- **5.4 ✅ (L26)** — `ci:md-writers-reconcile-editors` hardened from file-level to **same-top-level-block** call-site scoping: each direct `.md` write must have a reconcile in its OWN enclosing top-level block (class / function / store object), so a reconcile in an unrelated sibling class no longer counts. Escape `// reconcile-elsewhere:` for the rare genuine cross-declaration case. Verified **zero false positives** on all 5 non-exempt writers (incl. the cross-method `replaceAll` / `CascadeDelete` patterns) and that it **bites** the write-in-class-A / reconcile-in-class-B gap. (Proving the reconciled PATH equals the written path is still the deferred data-flow part — Phase 6.)
- **5.5 ✅** — new gate `ci:command-roundtrip-coverage` (34th) requires every concrete `Command` to be exercised by an execute/undo round-trip test OR carry a documented `ROUNDTRIP_EXEMPT` reason (full before/after-snapshot / inverse-op commands that can't silently no-op). 71 commands: 59 round-tripped, 12 exempt. Added 7 round-trip tests for the untested delta/structure commands — kanban `AddColumn`/`RenameColumn`/`ReorderColumn`/`AddCard` (`kanbanStructureCommandsRoundTrip.test.ts`) and tasklist `AddSection`/`RenameSection`/`MoveTaskBlock` (`taskStructureCommandsRoundTrip.test.ts`); the `ReorderColumnCommand` test is the multi-slot **H1-twin** (confirmed it captures the whole order, no silent no-op). Verified the gate bites. `ReplaceAllCommand` is exempt (round-trip driven via `historyStore` — no literal `cmd.execute()`).

1. **Frontmatter invariant corpus — close the coverage gaps that let C1/M2 through:**
   - Op set must include **"set a value on key K"** for *every* key, including **bare/empty** ones — not only the current tag ops.
   - Corpus must include: bare empty keys (`aliases:`, `tags:`, `cssclasses:`) in first/middle/last position, with/without trailing comment, with/without trailing newline; `1_000`/`0b1010`/`0o17`/`007`/`0xFF`; anchors/aliases on non-tag keys; nested maps/lists with inline comments; comments in leading/standalone/trailing positions; CRLF×BOM matrix.
   - Assertions: output **re-parses**; untouched keys **byte-identical**; touched keys **value-correct**.
2. **Property-based fuzzer extension:** generate random `{key: value}` frontmatter (mixing empty values, the numeric/bool forms, nested objects) and random "set/delete/add" ops; assert the three invariants above. This is the single highest-leverage anti-regression investment.
3. **New gate `ci:reconciler-vault-guard`:** fail if a function in `vaultExternalReconcilers.ts` reads `vaultStore.path` (or receives a captured root) and then `await`s without a subsequent `isStillSameVault`. Converts root-cause **B** from discipline into an enforced invariant.
4. **Harden `ci:md-writers-reconcile-editors`** to call-site scope (L26).
5. **Extend `ci:command-snapshot-discipline`** (or add a test convention) to catch "command can silently no-op" — at minimum require an execute/undo round-trip test per delta command (would have caught H1).

---

## Phase 6 — *Optional* deep refactor (decision-gated, post-dogfood)

**Only consider after Phases 1–5 ship and the corpus exists.** Decision: do this **only if** you want to eliminate the object-vs-source diff step structurally rather than keep plugging its edges.

- **Direction:** make frontmatter mutations **operations applied to a single source-preserving model**, not a plain-object diff:
  - One parser. The read path and the write path both use the same library (`yaml` package CST with `keepSourceTokens`, or commit fully to `js-yaml` + a thin source-patcher). This deletes the entire `yaml`-vs-`js-yaml` mismatch class (M2, and the reason `valuesEqual` can be "wrong").
  - Express edits as `setKey/deleteKey/addTag` **operations** applied to the parsed CST/Document, then `stringify`. No `nextObj` diff → no "looks changed but isn't" → no canonicalization heuristics. The plain object stays a **read-only cache** for the index/board-JSON, never the thing written back.
- **Why it's optional:** with C1 + M2 + the anchor guard fixed and the corpus exhaustive (Phase 5), the byte-splice engine is defensible for the realistic PKM input space. The refactor buys *structural* elimination of the class, not a new capability.
- **Why it's risky on the critical path:** it re-touches the exact code you need to trust; without Phase 5's corpus as a net, a rewrite could introduce fresh corruption. **Sequence: corpus first, refactor second, corpus guards the refactor.**
- **Effort:** L (day+), plus a full corpus pass. **Recommended verdict: defer; revisit after a few weeks of dogfooding** — real-vault inputs will tell you whether the remaining edges are ever hit.

---

## Appendix — full issue index

| ID | Sev | Area | File | Phase | Effort |
| --- | --- | --- | --- | --- | --- |
| C1 | 🔴 crit | FM splice | frontmatterEngine.ts | 1 | S |
| H1 | 🟠 high | undo / feature | sectionCommands.ts | 2 | M |
| H2 | 🟠 high | undo / FM | propertiesCommands.ts | 2 | M |
| H3 | 🟠 high | vault swap (disk) | vaultExternalReconcilers.ts | 2 | M |
| H4 | 🟠 high | vault swap (mem) | vaultExternalReconcilers.ts | 2 | M |
| M1 | 🟡→blocker | silent loss | markdownFileWriter.ts | 2 | S |
| M2 | 🟡 med | FM canonicalization | frontmatterEngine.ts | 3 | S |
| M3 | 🟡 med | drift baseline | fileTags.svelte.ts | 3 | S |
| M4 | 🟡 med | stale-index FM | kanbanFrontmatterWriter.ts | 3 | M |
| M5 | 🟡 med | recovery UX | dirtyFlagRecovery.ts | 3 | S |
| L11 | ⚪ low | vault swap (visual) | vaultExternalReconcilers.ts | 2/4 | S |
| L12 | ⚪ low | partial read | conflictResolver.ts | 4c | M |
| L13 | ⚪ low | recovery UX | recoverySnapshot.ts | 4b | S |
| L14 | ⚪ low | FM equality | conflictResolver.ts | 4c | S |
| L15 | ⚪ low | rename mis-pair | renameCorrelation.ts | 4c | S |
| L16 | ⚪ low | leak | taskDragController / kanbanDragController | 4e | S |
| L17 | ⚪ low | leak | ConnectionLabel.svelte | 4e | S |
| L18 | ⚪ low | config silent | board.ipc.ts | 4f | M |
| L19 | ⚪ low | quit freeze | markdownFileWriter.ts | 4 | M |
| L20 | ⚪ low | recovery silent | dirtyFlagRecovery.ts | 4b | S |
| L21 | ⚪ low | recovery silent | board.ipc.ts | 4b | S |
| L22 | ⚪ low | undo collision | sectionCommands.ts | 4d | S |
| L23 | ⚪ low | FM nested comments | frontmatterEngine.ts | 4a | M |
| L24 | ⚪ low | config silent | configWriteScheduler.ts | 4f | S |
| L25 | ⚪ low | weak guard | vault.svelte.ts | 2/4 | S |
| L26 | ⚪ low | CI gate weak | check-md-writers-reconcile-editors.mjs | 5 | M |
| L27 | ⚪ low | FM anchor | frontmatterEngine.ts | 4a | S |
| L28 | ⚪ low | FM comment | frontmatterEngine.ts | 4a | S |
| L29 | ⚪ low | undo latent | kanbanCommands.ts | 4d | S |
| L30 | ⚪ low | undo latent | kanbanCommands.ts / taskCommands.ts | 4d | S |
| L31 | ⚪ low | flush quiescence | vault.svelte.ts | 4d | S |
| VS1 | ⚪ low | sync-FM partial read | conflictResolver.ts | 4c | M |
| VS2 | ⚪ low | recovery silent (intersection of L20+L21) | board.ipc.ts / dirtyFlagRecovery.ts | 4b | — |
| VS3 | 🟡 med | FM comment-mangle (C1 variant) | frontmatterEngine.ts | 1 | — |

**Refuted (no action):** `handleExternalMarkdownChanges` swap; vaultIndex retry-timer; `save()` re-arm during drain; vaultIndex resolver-drain stranding. (Guards verified present.)

---

## Suggested execution order

1. **C1** (Phase 1) + its corpus cases (Phase 5.1) → **dogfood unblocked on frontmatter.**
2. **H1, H2, H3, H4, M1** (Phase 2) + the reconciler-guard gate (Phase 5.3) → **dogfood-ready.**
3. **M2–M5** (Phase 3) + corpus numeric cases → frontmatter ≈ 8/10.
4. **Phase 4 + remaining Phase 5** as steady-state hardening.
5. **Phase 6** decision after a few weeks of real-vault use.

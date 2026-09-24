# Audit-9 Remediation Plan — 2026-06-04

**Scope:** fresh, independent data-integrity audit (write paths, frontmatter round-trip, concurrency, vault lifecycle, crash/quit/recovery, undo/redo) ahead of daily dogfooding across **all four board types** (Mind Map, Kanban, Task List, Document). Windows / Electron, vault under OneDrive (`My Files\…`), with **frequent multi-vault switching**.

**Method:** 9 parallel adversarial auditors (6 finders × 6 dimensions + 3 batch verifiers, refute-by-default), pointed at the **uncommitted Audit-7/8 working tree** (35 source files, +1314/−336) on top of HEAD `6067e4d`. 24 candidates → **16 confirmed/partial, 8 refuted**. Plus 7 hand-traces of the freshest hunks and a **runnable repro** for the headline finding ([`auditFreshSeedVaultSwapRace.repro.test.ts`](src/tests/unit/auditFreshSeedVaultSwapRace.repro.test.ts), green against current code). This plan only contains findings verified against the live source; the 8 refuted are listed at the end so they are not re-chased.

**Headline:** the committed core is strong (CST frontmatter engine byte-exact, store lifecycle leak-free, undo discipline sound — and 8 plausible attacks were actively refuted). **All serious findings live in the uncommitted delta and share ONE root cause:** async UI mutators that `await seedDocumentFrontmatterFromDisk(...)` are **off the history chain** (so quit's `whenChainSettled()` does not cover their in-flight seed) AND the **seed primitive has no vault-identity guard**. The same Audit-7/8 work that closed old silent-loss bugs opened this cluster. One CONFIRMED HIGH (cross-vault frontmatter corruption) + a tail of narrow-trigger MED/LOW losses.

> **Working-software rule:** each phase must leave `npm run ci:verify` green (lint → check → test:unit:strict → build → 37 guards) and the app runnable. Ship phases in order. **Phase 1 is the gate for resuming multi-vault Kanban/Task daily use.** Mind Map / single-vault use is unaffected today.

## Status snapshot

| ID | Severity | Confidence | Area | Affects | Phase |
|----|----------|-----------|------|---------|-------|
| **A9-H1** | 🟠 HIGH | **CONFIRMED (repro test)** | Cross-vault FM write via orphaned command | Kanban + Task, multi-vault | 1 ✅ |
| **A9-M1** | 🟡 MED | CONFIRMED | Seed primitive has no vault-identity guard (root cause) | Kanban + Task | 1 ✅ |
| **A9-M2** | 🟡 MED | CONFIRMED | Task notes-body lost on quit-during-seed (clean sentinel → no recovery) | Task List | 1 ✅ |
| **A9-M3** | 🟡 MED | CONFIRMED | Quick-add / create-task metadata lost on quit-during-seed | Task List | 1 ✅ |
| **A9-L1** | ⚪ LOW | CONFIRMED | Bulk tag-add partial loss on quit + not undoable | Kanban | 1 ✅ |
| **A9-G1** | 🛡️ GATE | — | `ci:reconciler-vault-guard` blind to command/seed paths | CI defense | 1 ✅ |
| **A9-L2** | ⚪ LOW | CONFIRMED | Orphan-card write failure swallowed (within-session incoherence) | Kanban | 2 ✅ |
| **A9-L3** | ⚪ LOW | PARTIAL | `if (!fm) return` silent no-op on docId-less Task fallback | Task List | 2 ✅ |
| **A9-L4** | 🛡️ GATE | CONFIRMED | `ci:no-silent-write-abort` scans only one file | CI defense | 2 ✅ |
| **A9-L5** | ⚪ LOW | CONFIRMED | Orphan-card FM edit full-dumps YAML (comment/order loss) | Kanban | 3 ✅ |
| **A9-L6** | ⚪ LOW | CONFIRMED | Deleting a FM key drops its doc-comment line (silent) | all | 3 ✅ |
| **A9-L7** | ⚪ LOW | PARTIAL | `tags.json` merge-base desync on concurrent external reload | all | 4 ✅ |
| **A9-L8** | ⚪ LOW | PARTIAL | Gateway post-write bookkeeping runs against new vault on swap | all | 4 ✅ |
| **A9-L9** | ⚪ LOW | PARTIAL | `repairRenameCascade` never re-applies `renameBoardPath` (latent) | all | 4 ✅ |
| **A9-L10** | ⚪ LOW | CONFIRMED | Coalesced write-error toast drops one preserved-tmp path | all | 4 ✅ |
| **A9-V1** | 🔍 VERIFY | — | Reserved-Win-name additions may reject a pre-existing vault file | new/rename | 5 ✅ |

Phase 5 = behavioral-matrix tests, repro-test inversion, the A9-V1 check, and `ci:verify` green.

**Refuted (do NOT re-chase — see appendix):** sync-frontmatter clobber (isPathPending guard), pending-tags cross-vault write (null-root guard), tags merge order-sensitivity (compares ours-vs-base), boardScope import-order, redo blind-merge (unreachable), CRLF single-line EOL clobber (no reachable path), quit-hang on wedged prompt (bounded ≤~45s), post-write baseline TOCTOU BOM/size (logical stat always matches).

---

## Phase 1 — The cluster: close the off-chain-seed + unguarded-primitive class (do this first)

> **Why grouped:** A9-H1/M1/M2/M3/L1 are five symptoms of one structural flaw. Two changes close most of it: **(1) a vault-identity guard on the shared seed primitive (A9-M1)** kills the cross-vault dimension at one site, and **(2) seed the FM cache synchronously before arming any write / put the mutator on the history chain (A9-M2/M3/L1)** kills the quit-during-seed losses. A9-H1 additionally needs a command-level bail; A9-G1 pins it so it can't regress.

> **✅ PHASE 1 COMPLETE (2026-06-04)** — all six items implemented; `npm run ci:verify` green end-to-end (exit 0, 37 guards). New/updated tests: `auditFreshSeedVaultSwapRace.repro.test.ts` inverted into an A9-M1 regression guard, new `auditNinePhase1.test.ts` (A9-H1 Kanban+Task cross-vault suppression, A9-M2 notes-body persistence, A9-M3 on-chain seed + rollback, A9-L1 BatchCommand routing), and `audit8Phase3.test.ts`'s A8-M3(b) test re-pointed (the seed now runs INSIDE `AddTaskCommand`). `ci:reconciler-vault-guard` (A9-G1) bite-verified; `kanbanCommands.ts` file-size ceiling 1020→1039. Uncommitted, on top of the Audit-7/8 working tree.

### A9-M1 — `seedDocumentFrontmatterFromDisk` injects cross-vault frontmatter past a swap (the root primitive)

**Status:** ✅ DONE — `seedDocumentFrontmatterFromDisk` captures `captureVaultIdentity()` before the await and bails on `!isStillSameVault`; added an opt-in `refreshSeedVersion` mode (for A9-M2). Repro test inverted.

**Severity:** 🟡 MED (load-bearing root of A9-H1) · **Confidence:** CONFIRMED (read end-to-end + green repro) · **Affects:** Kanban + Task first-touch field edits · **Regression?** Introduced by the Audit-6 M4 / Audit-7 H1 seed-into-command work (uncommitted).

**Symptom:** a stale frontmatter object keyed by the *outgoing* vault's `docId` is written into the *new* vault's freshly-cleared `documentStore` whenever a vault swap lands during the seed's disk read. In isolation an orphaned in-memory entry; combined with the command path (A9-H1) it becomes an on-disk cross-vault clobber.

**Root cause (verified):** [`seedFrontmatterFromDisk.ts:34-49`](src/renderer/lib/boards/seedFrontmatterFromDisk.ts:34) — captures `vaultRoot` from the caller (`vaultStore.path`), `await readMarkdownForHydrate(vaultRoot, relPath)`, then `documentStore.setFrontmatter(docId, …)` guarded **only** by a cache-presence re-check at [:43](src/renderer/lib/boards/seedFrontmatterFromDisk.ts:43), **not** vault identity. On a swap during the await, the document pre-swap handler runs `documentStore.clear()` (cache emptied), then this continuation re-injects vault A's FM. `setFrontmatter` has no `boundVault` guard ([document.svelte.ts:280](src/renderer/stores/document.svelte.ts:280)). `grep` confirms the module never references `isStillSameVault` / `captureVaultIdentity`, and `ci:reconciler-vault-guard` does not scan it.

**Fix:** capture vault identity before the await; bail after it (mirrors the G1 discipline in `vaultExternalReconcilers.ts`):

```ts
import { captureVaultIdentity, isStillSameVault } from '../vault/vaultIdentity';

export async function seedDocumentFrontmatterFromDisk(docId, vaultRoot, relPath): Promise<void> {
  if (!docId || !vaultRoot || !relPath) return;
  if (documentStore.getFrontmatter(docId)) return;
  const identity = captureVaultIdentity();           // ← before the await
  try {
    const hydrate = await readMarkdownForHydrate(vaultRoot, relPath);
    if (!isStillSameVault(identity)) return;          // ← a swap landed; never inject cross-vault FM
    if (!documentStore.getFrontmatter(docId)) {
      documentStore.setFrontmatter(docId, hydrate.frontmatter, hydrate.rawFrontmatter);
    }
  } catch {
    // unseeded — caller's index-seed fallback runs as before
  }
}
```

**Tests:** invert the repro at [`auditFreshSeedVaultSwapRace.repro.test.ts`](src/tests/unit/auditFreshSeedVaultSwapRace.repro.test.ts) — after the fix, a swap-clear during the gated read must leave `getFrontmatter(docA)` **`undefined`** (change the two final assertions). Add the no-swap path stays green (normal seed still populates).

**Verification:** `npm run test:unit -- auditFreshSeedVaultSwapRace` then `ci:verify`.

---

### A9-H1 — First-touch Kanban/Task field edit + "Open Vault → Don't Save" writes the OLD vault's frontmatter onto the NEW vault's same-named file

**Status:** ✅ DONE — `UpdateCardFieldCommand.execute` + `UpdateTaskFieldCommand.execute` capture identity before the seed await and `return` on `!isStillSameVault` before any cache/schedule/markDirty sink (the orphan-FM paths `UpdateOrphanFrontmatterCommand.execute` + `applyOrphanPatchRebased` got the same guard so the gate passes honestly).

**Severity:** 🟠 HIGH · **Confidence:** CONFIRMED (traced all three seams + green repro of the primitive) · **Affects:** Kanban + Task, only with multi-vault switching · **Regression?** Introduced by the uncommitted Audit-7 H1 "seed into `execute()`" refactor.

**Symptom:** toggle `completed` / set `priority` / pick `dueDate` on a card/row **never opened as a Document this session**, then immediately **File > Open Vault** (a vault that contains a file at the **same relative path**) and choose **"Don't Save"**. If the swap lands while the FM disk-seed IPC is in flight, vault B's file at that path has its **entire frontmatter replaced** by vault A's (patched). Silent; reports success against vault B. Only safe when vault B lacks the path (then ENOENT → `markPathFailed` + throw, no write).

**Root cause (verified, end-to-end):**
1. [`kanbanCommands.ts:616-643`](src/renderer/commands/kanbanCommands.ts:616) (`UpdateCardFieldCommand.execute`) and [`taskCommands.ts:422-447`](src/renderer/commands/taskCommands.ts:422) (`UpdateTaskFieldCommand.execute`) suspend at `await seedDocumentFrontmatterFromDisk(this.docId, vaultStore.path, this.relPath)` for an un-opened card (no FM cache entry).
2. On **Open Vault → "Don't Save"** ([vault.svelte.ts:993-1006](src/renderer/stores/vault.svelte.ts:993)), `choice === 1` **skips `this.save()`** — no `whenChainSettled()` drain. `fireVaultSwap('pre-swap')` then runs the history handler ([history.svelte.ts:661-665](src/renderer/stores/history.svelte.ts:661)) which **synchronously** sets `pendingChain = Promise.resolve()` + `chainInflightDepth = 0` — it does **not** await the in-flight `execute()`.
3. The orphaned continuation resumes after `vaultStore.path` is now vault B: `seedDocumentFrontmatterFromDisk` re-injects vault A's FM (A9-M1), then `mergeFrontmatter(patch)` + `scheduleFrontmatterWrite(relPath, docId)` **arm a 300 ms timer after the pre-swap reset** (so it survives).
4. `scheduleFrontmatterWrite` reads `vaultRoot = vaultStore.path` **lazily at fire time** ([frontmatterWriteScheduler.ts:115](src/renderer/lib/boards/frontmatterWriteScheduler.ts:115)) = vault B. The write assembles vault A's FM (over vault A's raw source held in `originalFrontmatterCache`) onto vault B's body. Main-side `assertActiveVault` accepts it (vault B is active).

**Fix:** make the command capture identity and bail across the seed await, before any cache/schedule sink. Restructure so the bail returns from `execute()` (not just the inner `if`):

```ts
async execute(): Promise<void> {
  const isRedo = this.hasExecuted;
  this.hasExecuted = true;
  if (this.docId && isRedo) { /* …existing rebase redo… */ return; }
  if (this.docId) {
    const identity = captureVaultIdentity();
    await seedDocumentFrontmatterFromDisk(this.docId, vaultStore.path, this.relPath);
    if (!isStillSameVault(identity)) return;     // ← swap mid-seed: abandon; do NOT schedule/markDirty against the new vault
    if (!documentStore.getFrontmatter(this.docId)) { /* …index fallback… */ }
    this.inversePatch = this.snapshot(captureInverseFromCache(this.docId, this.patch));
    documentStore.mergeFrontmatter(this.docId, this.patch);
  }
  scheduleFrontmatterWrite(this.relPath, this.docId);
  boardCacheStore.markDirty(this.targetBoardId);
}
```

With A9-M1 in place the cross-vault *disk* write cannot happen even if this guard is missed (the seed won't inject, so the scheduler finds no docState and reads vault B's own FM). This command guard additionally prevents arming a stray write/markDirty against the new vault. Apply identically to `UpdateTaskFieldCommand.execute`.

**Tests:** unit (jsdom) — drive `UpdateCardFieldCommand.execute` with the seed gated; flip `vaultStore.path` to vault B during the suspension; release; advance 300 ms; assert **no** `vault:write-existing-file-text` fired against vault B (and the FM cache holds no `docA` entry). Mirror for Task.

**Verification:** `ci:verify`. Manual: two vaults each with `Inbox.md`; on vault A toggle a never-opened card's `completed`, immediately Open Vault → vault B → Don't Save; confirm vault B's `Inbox.md` frontmatter is untouched.

---

### A9-M2 — Task-List notes-body edit silently lost on quit during the FM seed (clean sentinel → no recovery prompt)

**Status:** ✅ DONE — `setNotesBody` seeds the FM cache synchronously from the vault index before the early arm (so a quit's `flushAll` can't no-op on empty FM), then refreshes from disk via the primitive's `refreshSeedVersion` mode so source preservation / external keys are NOT regressed (overwrite gated on an unchanged mutation version).

**Severity:** 🟡 MED (more *probable* day-to-day than A9-H1; truly silent) · **Confidence:** CONFIRMED · **Affects:** Task List · **Regression?** The uncommitted A8-M3(a) early-arm changed the failure mode but did **not** close it on the quit path.

**Symptom:** type into a task row's notes/body for a row **never opened as a Document**, then immediately quit while the FM disk-seed read is in flight. The notes never reach disk; `.filo/.dirty` is **clean** → no recovery prompt. Unrecoverable (`.board.json` does not cache notes bodies). Window widens on OneDrive (slow seed read).

**Root cause (verified):** [`frontmatterWriter.ts setNotesBody (~200-247)`](src/renderer/lib/tasklist/frontmatterWriter.ts:200): `loadDocument` (no FM seed) → `updateContent` (body into cache, no `writerId` so no dirty writer) → **early** `scheduleFrontmatterWrite(path, docId)` (line ~229) → `await seedDocumentFrontmatterFromDisk` (line ~234) → re-arm (line ~245). For a first-touch row the FM cache is empty during the seed await, so if `save()`/quit's `flushAllPendingFrontmatterWrites` drains the early timer in that window, `writeFrontmatter` hits `if (!fm) return` ([frontmatterWriteScheduler.ts:181](src/renderer/lib/boards/frontmatterWriteScheduler.ts:181)) — a **no-op that resolves SUCCESS** → `endWrite(true)` → `markClean` wipes the sentinel. `setNotesBody` is not a Command, so `whenChainSettled()` ([vault.svelte.ts:1191](src/renderer/stores/vault.svelte.ts:1191)) does not await the seed; the post-seed re-arm lands after the flush and the renderer is torn down before it fires.

**Fix (minimal):** seed the FM cache **synchronously from the vault index** before arming, so the early flush cannot no-op on empty FM (the later disk seed still refines it; the scheduler reads FM live at fire time):

```ts
// setNotesBody, before the first scheduleFrontmatterWrite:
if (docId && !documentStore.getFrontmatter(docId)) {
  documentStore.setFrontmatter(docId, vaultIndexStore.getMetadata(path)?.frontmatter ?? {});
}
```

**Fix (robust alternative):** route notes-body edits through a Command (like `UpdateTaskFieldCommand`) so `whenChainSettled()` covers the in-flight seed AND the write participates in the drained-write barrier. Prefer this if touching the path anyway.

**Tests:** stub `readMarkdownForHydrate` to suspend; call `setNotesBody(row, 'typed notes')` for a row with no FM cache; before the seed resolves call `flushAllPendingFrontmatterWrites()`; assert a `vault:write-existing-file-text` containing the body **did** fire (post-fix) and the sentinel was **not** falsely markCleaned.

---

### A9-M3 — Quick-add / create-task / subtask metadata lost on quit during the off-chain `.md` seed; failed seed leaves an orphan placement

**Status:** ✅ DONE — the `.md` seed is folded into `AddTaskCommand.execute` (an optional thunk awaited on the first execute) so `whenChainSettled()` covers it; the placement persists synchronously first and rolls back on a seed-write failure (no orphan row). `seedMdFile`'s critical write now propagates; all three creation paths thread the thunk.

**Severity:** 🟡 MED · **Confidence:** CONFIRMED · **Affects:** Task List creation paths · **Regression?** Introduced by the uncommitted A8-M3(b) reorder (placement on-chain, `seedMdFile` off-chain).

**Symptom:** (a) type a quick-add line with metadata (`Buy milk !high @tomorrow #errands`), press Enter, quit within the seed window → the row persists in `.board.json` but its `.md` (priority/due/tags) never lands → broken-ref + lost metadata; a sentinel fires but cannot reconstruct the typed fields. (b) If `seedMdFile`'s write fails (ENOSPC/EACCES), the placement already executed → orphan board row referencing a missing `.md` (tracked broken-ref).

**Root cause (verified):** [`taskCreation.ts`](src/renderer/lib/tasklist/taskCreation.ts) — `createTaskInSection` (245-249), `addTaskFromQuickAdd` (334-337), `addSubtaskFor` (375-378) now `await historyStore.execute(new AddTaskCommand(...))` **before** `await seedMdFile(...)`. `AddTaskCommand.execute` ([taskCommands.ts:122](src/renderer/commands/taskCommands.ts:122)) only persists the **placement** (no `.md`). The FM payload is written **only** inside `seedMdFile` ([:153-189](src/renderer/lib/tasklist/taskCreation.ts:153)) via a bare `trackComponentWrite` → `invokeOk('vault:write-file-text')`, **not** in any scheduler. `addTaskFromQuickAdd` is wired `onSubmit=` directly (not via `historyStore.execute`), so `whenChainSettled()` covers only the `AddTaskCommand` body, not the free-floating seed tail.

**Fix:** fold the `.md` seed **into the chained command** so `whenChainSettled()` (awaited by `save()`/quit) covers it. Have `AddTaskCommand.execute` write the backing `.md` (assemble + `vault:write-file-text`) as part of its execute, and on write failure roll back the placement (or surface a toast offering to remove the broken row). Minimal alternative: mirror A9-M2 — seed FM into cache + arm a **scheduled** frontmatter write up front (which `flushAll` drains on quit) instead of relying on the off-chain `seedMdFile`.

**Tests:** stub `vault:write-file-text` to never resolve before the test calls `vault.save()`; call `addTaskFromQuickAdd(...)`; assert `save()` does **not** resolve until the seed is awaited (post-fix), i.e. the metadata write is on the drained chain. Add a write-failure case asserting the placement is rolled back / a broken-ref toast fires.

---

### A9-L1 — Kanban bulk tag-add loses the tag on un-processed cards if quit lands mid-loop; also not undoable

**Status:** ✅ DONE — `tagSelectedTiles` builds one `UpdateCardFieldCommand`/`UpdateOrphanFrontmatterCommand` per card and dispatches a single `BatchCommand` via `historyStore.execute` (crash-safe via `whenChainSettled` + undoable in one step). Each child seeds from disk inside its own on-chain `execute()`.

**Severity:** ⚪ LOW · **Confidence:** CONFIRMED · **Affects:** Kanban multi-select · **Regression?** Pre-existing (HEAD).

**Root cause (verified):** [`kanbanMultiSelect.svelte.ts tagSelectedTiles (158-199)`](src/renderer/lib/kanban/kanbanMultiSelect.svelte.ts:158) — per card the loop does `await seedDocumentFrontmatterFromDisk(...)` **first**, then `mergeFrontmatter` + `scheduleSharedFrontmatterWrite` (189-190). A quit while suspended at card N drains cards 0..N-1 (pending) but cards N..end were never merged or scheduled → their tag is in no cache/scheduler/sentinel. Free-floating async handler (not `historyStore.execute`), so `whenChainSettled()` doesn't cover it. Never constructs an Update command → the bulk op is **not undoable**.

**Fix:** route the bulk op through a `BatchCommand` of the existing single-card `UpdateCardFieldCommand` / `UpdateOrphanFrontmatterCommand` — crash-safe via `whenChainSettled()` **and** undoable. Minimal alternative: merge + `scheduleSharedFrontmatterWrite` for every selected card **synchronously up front**, then await the per-card disk seeds (the scheduler reads FM live at fire time).

**Tests:** stub `seedDocumentFrontmatterFromDisk` to suspend on card index 2 of 5; call `tagSelectedTiles`; while suspended run `flushAllPendingFrontmatterWrites`; assert cards 0-1 scheduled and (post-fix) cards 2-4 also have the tag armed. Assert `historyStore.canUndo` is true after a completed bulk tag add.

---

### A9-G1 — Extend `ci:reconciler-vault-guard` to the command + seed paths

**Status:** ✅ DONE — `check-reconciler-vault-guard.mjs` `GUARD_TARGETS` now also scans `seedFrontmatterFromDisk.ts` (vaultRootParam) + `kanbanCommands.ts` / `taskCommands.ts` (vaultStorePath); every flagged site carries an `isStillSameVault` bail (no exemptions). Bite-verified by temp-reverting the A9-M1 guard (gate reds).

**Type:** 🛡️ GATE (anti-regression for A9-H1/M1) · **Confidence:** — (gate-scope gap)

**Root cause:** `ci:reconciler-vault-guard` only scans `vaultExternalReconcilers.ts` / `vaultExternalChanges.ts`. It does not see `seedFrontmatterFromDisk.ts` or the command files that read `vaultStore.path` and `await`, so A9-H1/M1's missing guard passed CI.

**Fix:** add `src/renderer/lib/boards/seedFrontmatterFromDisk.ts` and the field-edit command files (`kanbanCommands.ts`, `taskCommands.ts`) to the gate's `GUARD_TARGETS` (or a sibling gate): any function that reads `vaultStore.path` and then `await`s must `isStillSameVault(...)` after the await. Bite-verify by temp-reverting the A9-M1 guard (gate must red).

---

## Phase 2 — Silent-error honesty

> **✅ PHASE 2 COMPLETE (2026-06-04)** — all three items implemented; `npm run ci:verify` green end-to-end. A9-L2: the orphan `commit()` now lets a failed `writeMarkdownFile` propagate (was a swallowing `reportError`-only catch) so `execute()`/`undo()` reject and the history wrapper rolls the command back; the "Apply anyway" toast handler grew its own `.catch(reportError)` to surface + swallow the now-rejecting fire-and-forget path. A9-L3: the docId-less Task `updateRowField` fallback routes through `UpdateOrphanFrontmatterCommand` (mirrors `kanbanFrontmatterWriter`'s no-`contentId` branch) instead of the silent `scheduleFrontmatterWrite(path, null)` no-op — a direct, undoable, loud-failing disk write. A9-L4: `check-no-silent-write-abort.mjs` widened from one hardcoded file to walk every `*riter*`/`*scheduler*` file under `lib/{boards,kanban,tasklist}` (7 files), forbidding `!docState) return` and a bare `!fm) return`-without-`markPathFailed`; bite-verified via a fixture tree (3 cases). New `auditNinePhase2.test.ts` (A9-L2 execute/undo rejection, A9-L3 persist + undoable) — both bite-verified by temp-reverting each fix. CLAUDE.md gate bullet updated. Uncommitted, on top of the Phase 1 + Audit-7/8 working tree.

### A9-L2 — `applyOrphanPatchRebased.commit` swallows a failed markdown write

**Status:** ✅ DONE — the orphan `commit()` no longer wraps `writeMarkdownFile` in a swallowing `try/catch`; the rejection propagates so `UpdateOrphanFrontmatterCommand.execute()`/`undo()` reject and `historyStore`'s `rollbackExecute`/`rollbackUndo` (which also `reportError`s) run. The gateway's `trackComponentWrite` already keeps `.filo/.dirty` dirty + fires the write-error toast; the "Apply anyway" toast button gained `.catch((err) => reportError(...))` so its fire-and-forget path surfaces the error without an unhandled rejection.

**Severity:** ⚪ LOW · **Confidence:** CONFIRMED · **Affects:** Kanban orphan-fm cards (no `contentId`).

**Root cause:** [`kanbanCommands.ts commit() (957-977)`](src/renderer/commands/kanbanCommands.ts:957) — `writeMarkdownFile` in a `try/catch` that only `reportError`s (no rethrow / no `markPathFailed` at the command layer). The command resolves **success** and the board is marked dirty while disk is stale. Partial mitigation: `trackComponentWrite`'s catch keeps `.filo/.dirty` dirty (recovery prompt next launch), so not silent on quit — only within-session incoherence (undo/redo visually "took" while disk diverged).

**Fix:** make `commit()` rethrow (or `markPathFailed` + surface to the history wrapper so `rollbackExecute`/`rollbackUndo` run) on write failure, matching the docId path.

**Tests:** stub `writeMarkdownFile` to reject for the orphan relPath; run `UpdateOrphanFrontmatterCommand.execute()`; assert the promise **rejects** (failure attributed), not resolves.

---

### A9-L3 — `if (!fm) return` silent no-op on the docId-less Task field fallback

**Status:** ✅ DONE — `updateRowField`'s docId-less fallback (`buildTaskFieldCommand` returns `null`) no longer arms the silent `scheduleFrontmatterWrite(path, null)`; it builds an `UpdateOrphanFrontmatterCommand` and dispatches it via `historyStore.execute` (mirroring `kanbanFrontmatterWriter`). The command reads body + FM fresh from disk, writes directly via the gateway, is undoable, and loudly fails (A9-L2) on a write error. The scheduler's `if (!fm) return` is left intact (it stays reachable only via legitimate null-docId sync writes and is now pinned by the A9-L4 gate to require a `markPathFailed` companion).

**Severity:** ⚪ LOW (very narrow: legacy contentId-less tile **and** path absent from vault index) · **Confidence:** PARTIAL.

**Root cause:** [`frontmatterWriter.ts updateRowField fallback (136-143)`](src/renderer/lib/tasklist/frontmatterWriter.ts:136) → `scheduleFrontmatterWrite(path, null)`; in `writeFrontmatter` a null docId resolves `fm = vaultIndexStore.getMetadata(relPath)?.frontmatter`, and `if (!fm) return` ([:181](src/renderer/lib/boards/frontmatterWriteScheduler.ts:181)) resolves the write as silent SUCCESS, dropping the edit. `ci:no-silent-write-abort` pins the `!docState` shape but not this `!fm` early-return.

**Fix:** in the docId-less fallback, refuse-and-toast when there is no docId/FM source, or route through `UpdateOrphanFrontmatterCommand` (reads body+FM fresh from disk, writes directly). Optionally widen the `!fm) return` to `markPathFailed` + throw when a write was genuinely armed.

**Tests:** legacy `TaskRow` with contentId-less tile + `getMetadata(path)` undefined → `updateRowField({completed:true})` → flush → assert no false-clean (the edit is either persisted or loudly failed, never silently dropped).

---

### A9-L4 — `ci:no-silent-write-abort` scans only one file

**Status:** ✅ DONE — the gate walks `src/renderer/lib/{boards,kanban,tasklist}/**` for every basename matching `/riter|scheduler/i` (7 files: `kanbanFrontmatterWriter`, `tasklist/frontmatterWriter`, + the five `*Scheduler.ts`). It FORBIDS `!docState) return` in any of them and a bare `!fm) return` *unless* that file also contains `markPathFailed`; it still REQUIRES `markPathFailed` + `readMarkdownForHydrate` in `frontmatterWriteScheduler.ts`. Comment-stripped (a doc-comment mention of the old shape can't trip it); per-file `// allow-silent-abort:` escape. Bite-verified against a temp fixture tree: CASE 1 `!docState) return` → red; CASE 2 bare `!fm) return` (no `markPathFailed`) → red; CASE 3 `!fm) return` WITH `markPathFailed` → pass. The docstring's old "single-function scope" overstatement is corrected.

**Type:** 🛡️ GATE · **Confidence:** CONFIRMED (no live second occurrence today).

**Root cause:** [`check-no-silent-write-abort.mjs:43`](scripts/check-no-silent-write-abort.mjs:43) hardcodes `const FILE = '…frontmatterWriteScheduler.ts'`; the silent-abort shape could be reintroduced in `kanbanFrontmatterWriter`, `tasklist/frontmatterWriter`, `boardCacheKanban`, or a future scheduler unguarded. The docstring overstates the single-function scope.

**Fix:** generalize the gate to walk `src/renderer/lib/{boards,kanban,tasklist}/**/*riter*.ts` + the schedulers, forbidding both `!docState) return` and a bare `!fm) return`-without-`markPathFailed` on a write path. Bite-verify (add the shape to a second file → gate must red).

---

## Phase 3 — Source-preservation / silent formatting loss (user-facing)

> **✅ PHASE 3 COMPLETE (2026-06-04)** — both items implemented; `npm run ci:verify` green end-to-end. A9-L5: a docId-less orphan-card FM edit now threads the disk FM source into the gateway (`WriteArgs.originalFrontmatter` + the `applyOrphanPatchRebased` capture) so it source-preserves via the CST engine instead of full-dumping — new `auditNinePhase3.test.ts`, bite-verified, ceilings bumped (`markdownFileWriter.ts` 1174→1182, `kanbanCommands.ts` 1045→1052). A9-L6: documented the deliberate deleted-key-comment trade-off (chose option (a)) in `KNOWN_LIMITATIONS.md` §1 + the `CLAUDE.md` gotcha enumeration — no code change. Uncommitted, on top of the Phase 1 + 2 + Audit-7/8 working tree.

### A9-L5 — Orphan-card frontmatter edits full-dump the YAML (comment / key-order / quoting loss)

**Status:** ✅ DONE — `WriteArgs` gained an optional `originalFrontmatter` (the disk FM source); the gateway's assemble computation falls back to it for a docId-less write instead of `undefined`. `applyOrphanPatchRebased` captures `hydrateResult.rawFrontmatter` and threads it into the docId-less `writeMarkdownFile`, so the orphan write routes through `patchFrontmatterSourceCst` (comments / key order / quoting survive) instead of the full-dump branch. New `auditNinePhase3.test.ts` (comment + quoted-title + key-order preservation) bite-verified by reverting the gateway fallback (full-dump strips the comment + unquotes the title → red). File-size ceilings bumped: `markdownFileWriter.ts` 1174→1182, `kanbanCommands.ts` 1045→1052.

**Severity:** ⚪ LOW (formatting loss, no key/value loss; only no-`contentId` cards — rare for Filo-created cards) · **Confidence:** CONFIRMED.

**Root cause:** [`kanbanCommands.ts applyOrphanPatchRebased commit() (957-977)`](src/renderer/commands/kanbanCommands.ts:957) calls `writeMarkdownFile` with `docId: null`. In the gateway `originalFrontmatter = docId ? getOriginalFrontmatterSource(docId) : undefined` ([markdownFileWriter.ts:684](src/renderer/lib/vault/markdownFileWriter.ts:684)) → `undefined`, so `assembleMarkdownFile` takes the **full-dump** branch ([markdownSync.ts:449-457](src/renderer/lib/editor/markdownSync.ts:449)) instead of the source-preserving CST patch. Comments / key order / exotic quoting are re-emitted away.

**Fix:** the orphan commit already reads the disk frontmatter via `readMarkdownForHydrate` (line ~947). Thread `hydrateResult.rawFrontmatter` into the write as a docId-less `originalFrontmatter` option so `patchFrontmatterSourceCst` source-preservingly patches the orphan write (matching the docId path).

**Tests:** orphan card whose `.md` FM has a `# comment` and ordered/quoted keys; `applyOrphanPatchRebased`; assert the written bytes **keep** the comment + order (post-fix) while applying the patch.

---

### A9-L6 — Deleting a frontmatter key silently drops the comment line documenting it

**Status:** ✅ DONE — chose option (a): documented the trade-off. Added a dedicated bullet to `KNOWN_LIMITATIONS.md` §1 alongside L23/L28 (the deleted key's own documenting comment line is dropped, not relocated — relocating would mis-document the survivor; option (b), relocate-to-trailing-block, is tracked if dogfooding shows users rely on FM comments), updated §1's Impact line, and kept the parallel "remaining narrow losses" enumeration in `CLAUDE.md` in sync. No code change — the L4 `gapWithoutCommentLines` behaviour and its pinning tests are unchanged.

**Severity:** ⚪ LOW (bounded to the deleted key's own comment line) · **Confidence:** CONFIRMED · **Regression?** Introduced by the uncommitted L4 `gapWithoutCommentLines` change.

**Root cause:** [`frontmatterCstModel.ts gapWithoutCommentLines (170-186)`](src/renderer/lib/vault/frontmatterCstModel.ts:170) + the Pass-2 delete branch (282-288) strip any source line carrying a `comment` token from a **deleted** key's leading tokens. Previously the comment relocated to the next surviving key; now it is dropped. Pinned by tests asserting the loss ([frontmatterCstModel.test.ts:157,172](src/tests/unit/frontmatterCstModel.test.ts:157), [frontmatterInvariant.test.ts:760](src/tests/unit/frontmatterInvariant.test.ts:760)).

**Decision + fix:** this is a deliberate trade-off (relocating mis-documents the survivor) but it is a **silent loss of user-authored bytes** when a metadata key is deleted via Properties, and it is **not** in `KNOWN_LIMITATIONS.md`. Choose one:
- **(a) Document it** — add a dedicated `KNOWN_LIMITATIONS` bullet (alongside L23/L28) so the trade-off is surfaced. Lowest effort; honest.
- **(b) Relocate to document end** instead of dropping — preserves the bytes (no key is mis-documented if the comment moves to a trailing block). More work; flip the two pinning tests.

Recommend (a) for Phase 3, with (b) tracked if dogfooding shows users rely on frontmatter comments.

---

## Phase 4 — Coherence / recovery completeness (latent / self-healing)

> **✅ PHASE 4 COMPLETE (2026-06-04)** — all four items implemented; `npm run ci:verify` green end-to-end (37 guards). New `auditNinePhase4.test.ts` (A9-L7 reload-not-clobbered merge-base survival, A9-L8 gateway swap-skip vs no-swap control, A9-L9 `renameBoardPath`+`markDirty`+repaired-count) + A9-L10 block in `writeErrorToast.test.ts` (per-path coalesceKey, distinct-path → separate toasts, same-path → counted, non-preserve → coalesce-by-kind). **All four bite-verified** by temp-revert (L7 guard, L8 guard, L9 `renameBoardPath` call, L10 `coalesceKey ?? context` → each reds). No new CI gate (these are coherence/self-healing fixes; the silent-loss classes already have their gates). Uncommitted, on top of the Phase 1+2+3 + Audit-7/8 working tree.

### A9-L7 — `tags.json` merge-base desync on a concurrent external reload

**Status:** ✅ DONE — every `lastSavedFile` re-set from OUTSIDE the debounced save closure (hydrate / candidate-commit / external reload / reset) routes through `setMergeBase`, which bumps a `mergeBaseGeneration` token. The save closure captures the token at fire time and skips its trailing `lastSavedFile = snapshot` assignment when a reload/reset advanced it during the `tags:save` await — so a stale in-flight write no longer clobbers the reload's fresh base. (Bare assignment, not `setMergeBase`, so two overlapping same-vault saves still each record their own bytes.) · **Severity:** ⚪ LOW (self-heals on next clean save; no tag dropped) · **Confidence:** PARTIAL.

**Root cause:** [`fileTags.svelte.ts`](src/renderer/stores/fileTags.svelte.ts) — the debounced save closure does `await invoke('tags:save', …)` then `lastSavedFile = JSON.parse(snapshot)` (line 178). If `applyExternalReload` (line 603) runs during the await, it sets `lastSavedFile = loaded.file`; the original write's trailing assignment then overwrites it back to the pre-reload snapshot, desyncing the next 3-way merge base. Self-heals via the re-armed save (line 605).

**Fix:** guard the post-await assignment with a captured generation token — only set `lastSavedFile = JSON.parse(snapshot)` if no newer mutation/reload superseded this write (mirror the FM scheduler's version-token guards).

---

### A9-L8 — Gateway post-write bookkeeping runs against the new vault on swap

**Status:** ✅ DONE — `writeMarkdownFileImpl` captures `captureVaultIdentity()` at entry (before the drift prompt + write await) and, after `trackComponentWrite` resolves, `return`s on `!isStillSameVault(...)` BEFORE the post-write renderer-state bookkeeping (drift-baseline refresh, `vaultIndexStore.restoreMetadata`, `noteFrontmatterFlushedVersion`, `documentStore.markClean`). A write whose IPC committed to the outgoing vault no longer upserts that vault's `FileMetadata`/baseline for `relPath` into the swapped-in vault. · **Severity:** ⚪ LOW (renderer-state only; disk protected by `assertActiveVault`; self-heals on next watcher event) · **Confidence:** PARTIAL.

**Root cause:** [`markdownFileWriter.ts writeMarkdownFileImpl (743-767)`](src/renderer/lib/vault/markdownFileWriter.ts:743) — `vaultIndexStore.restoreMetadata` / `noteFrontmatterFlushedVersion` / `documentStore.markClean` run after `await trackComponentWrite` with **no** identity guard. A write whose IPC committed to the old vault before a swap upserts the old vault's `FileMetadata` for `relPath` into the new vault's index. (`markClean` is a no-op post-swap since the doc was cleared.)

**Fix:** capture the gen/path at entry and gate the trailing block on `isStillSameVault(...)` so a post-swap settle becomes a no-op for these renderer-state mutations.

---

### A9-L9 — `repairRenameCascade` never re-applies `renameBoardPath` (latent recovery gap)

**Status:** ✅ DONE — `repairRenameCascade`'s per-entry loop now calls `boardCacheStore.renameBoardPath(entry.oldPath, entry.newPath)` (re-applying the moved board's OWN path key), marks each returned board dirty so `flushAllDirty` rewrites it under the new name, and counts them as repaired. Today it returns `[]` (the scan-driven `loadAllBoards` already holds the new path) so it's an idempotent no-op, but recovery is now self-sufficient regardless of how boards are rediscovered. Both early-breadcrumb sentinel writers (`vaultFolderOps.runRename`, `runExternalRenameCascade`) now record `[...new Set([...changedBoardIds, ...renamedBoardIds])]` so the breadcrumb names the full affected set. · **Severity:** ⚪ LOW (zero blast radius today — board discovery is scan-driven; latent only) · **Confidence:** PARTIAL.

**Root cause:** [`renameCascadeRepair.ts repairRenameCascade (28-98)`](src/renderer/lib/vault/renameCascadeRepair.ts:28) re-derives references-TO via `propagateRename` and re-asserts tags, but never calls `boardCacheStore.renameBoardPath` to fix a moved board's **own** path key. Masked because `loadAllBoards` rescans the tree on every open ([boardLoader.ts:698](src/renderer/lib/boards/boardLoader.ts:698)). The early L17 breadcrumb also records `affectedBoardIds = [...changedBoardIds]` only, omitting `renamedBoardIds`.

**Fix:** add `boardCacheStore.renameBoardPath(entry.oldPath, entry.newPath)` to the per-entry loop (idempotent) and include `renamedBoardIds` in the early breadcrumb's `affectedBoardIds`, so recovery is self-sufficient regardless of how boards are discovered.

---

### A9-L10 — Coalesced write-error toast drops one preserved-tmp recovery path

**Status:** ✅ DONE — `createErrorToastAggregator` now coalesces by an optional per-report `coalesceKey ?? context` (Map key only — the DISPLAY prefix stays `context`, so the count badge still reads per write KIND). `buildWriteErrorToast` returns `coalesceKey = "<context>::<preservedPath>"` only when bytes were preserved at a tmp path, and the `App.svelte` write-error wiring threads it through. Two same-kind failures that preserved to DIFFERENT locations now each keep their own toast (neither recovery path is hidden); same-path-twice still collapses to one counted toast; non-preserve failures still coalesce by kind. · **Severity:** ⚪ LOW (cosmetic — `.filo/quit-failure.json` + `emergencyFileRegistry` recover ALL preserved paths) · **Confidence:** CONFIRMED.

**Root cause:** [`errorToastAggregator.ts`](src/renderer/lib/utils/errorToastAggregator.ts) keys by `context` (the write kind). Two same-kind failures within `windowMs` with **different** preserved tmp paths → `updateToastText` replaces #1's path with #2's, so the user sees only the latest location in-session.

**Fix:** accumulate distinct preserved-path detail lines (append, don't replace), or key by `context + preservedPath` for the preserve case so each distinct recovery location keeps its own toast.

---

## Phase 5 — Verification, regression matrices, and the deferred check

> **✅ PHASE 5 COMPLETE (2026-06-04)** — `npm run ci:verify` green end-to-end (exit 0; lint → check → test:unit:strict → build → guard suite). A9-V1 VERIFIED CLEAN (no code fix needed) and pinned by a new [`auditNinePhase5.test.ts`](src/tests/unit/auditNinePhase5.test.ts) (8 tests, bite-verified); the Phase-1/2 behavioral matrices, the repro inversion, and the A9-G1/A9-L4 gates were shipped + bite-verified in their own phases and re-confirmed green here. **Audit-9 remediation COMPLETE.** Only the manual all-board smoke + the commit split remain (human steps). Uncommitted, on top of the Phase 1–4 + Audit-7/8 working tree.

**Status:** ✅ DONE

- **A9-V1 (🔍 VERIFY):** ✅ VERIFIED CLEAN — the reserved-Windows-name additions (CONIN$/CONOUT$/CLOCK$, stem-trim) in [`filenameUtils.ts`](src/main/vault/filenameUtils.ts) / [`pathSecurity.ts`](src/main/utils/pathSecurity.ts) **cannot** reject a pre-existing legit file on rename/move. `vault:rename` validates ONLY the NEW target ([`assertSafeFilename(basename(newPath), { forCreation: true })`](src/main/ipc/vault.ipc.ts:286)); the OLD basename is intentionally not re-validated (POSIX-read invariant already pinned by `pathSecurity.test.ts`). The move path preserves the source name (`computeMoveIntoFolderTarget`) and re-validates it with that strictest guard, so the new [`auditNinePhase5.test.ts`](src/tests/unit/auditNinePhase5.test.ts) enumerates 19 benign near-miss names (`money$.md`, `CONINNER$.md`, `Clock Tower.md`, `CLOCK $.md`, `Report .md`, `COM10.md`, …) that must clear `{ forCreation: true }`, models the move-target re-validation, and drives the **real `vault:rename` handler** moving a benign pre-existing file (`money$.md`, `Clock Tower.md`) into a subfolder — with negative controls proving the boundary still bites the genuine devices. Bite-verified: temp-reverting the stem `.trim()` reds the boundary-control case.
- **Behavioral matrices:** ✅ present + green — [`auditNinePhase1.test.ts`](src/tests/unit/auditNinePhase1.test.ts) covers A9-H1 (Kanban + Task cross-vault write-suppression), A9-M2 (notes-body persists across a quit-flush mid-seed), A9-M3 (backing-`.md` seed on the history chain + placement rollback on write failure), A9-L1 (chained, undoable `BatchCommand`). Each reds when its fix is temp-reverted (the A8 discipline; verified in Phase 1).
- **Repro inversion:** ✅ done — [`auditFreshSeedVaultSwapRace.repro.test.ts`](src/tests/unit/auditFreshSeedVaultSwapRace.repro.test.ts) is now the A9-M1 regression guard (`getFrontmatter('docA')` must be `undefined` after a swap commits during the seed read).
- **Gates:** ✅ green — `ci:reconciler-vault-guard` (A9-G1, scans the seed primitive + field-edit command files) and `ci:no-silent-write-abort` (A9-L4, 7 writer/scheduler files) both pass; bite-verified via temp-revert/second-file injection in Phases 1/2.
- **Green bar:** ✅ `npm run ci:verify` exit 0 (lint → check → test:unit:strict → build → guard suite).
- **Manual smoke / commit (human follow-up):** the manual all-board-type smoke (create/edit/quit/reopen on each of Mind Map, Kanban, Task, Document) is a human step, not done here. The working tree is currently the **entire** Audit-7/8 + this Audit-9 fix set, uncommitted. Recommend committing Audit-7/8 first (they are sound), then Audit-9 fixes as a follow-up, so the cross-vault fix is bisectable.

---

## Appendix — Refuted findings (verified non-issues; do not re-chase)

| Claim | Why refuted |
|---|---|
| sync-frontmatter reconcile clobbers an in-flight in-app FM mutation | The `isPathPending` guard ([vaultExternalChanges.ts:176-184](src/renderer/stores/vaultExternalChanges.ts:176)) routes to a prompt + `continue` before the clobber; every in-app FM mutation arms a pending scheduler write synchronously-adjacent. |
| Pending `tags.json` debounce fires cross-vault after swap | `fireVaultSwap('pre-swap')` runs `fileTagsStore.reset()` → `activeVaultRoot = null` for the whole `loadVaultCandidate` window; `scheduleSave` and its factory both bail on null root. |
| `tags.json` 3-way merge order-sensitively reverts an external reorder | `reapplyTagDelta` compares `ours[key]` vs **`base[key]`** (not `theirs`); a key the user didn't change is byte-identical to base → not overwritten → external value survives. |
| `boardScope` swap-reset unregistered if an early close precedes first board mount | The module is imported transitively at app entry (App → history/vault → board → boardScope), so `vaultSwapResettable('boardScope')` always runs at bootstrap. |
| Redo of a field command after FM-cache eviction blind-merges/collapses the file | The redo leg is unreachable with a live file: every eviction path either clears the redo stack (new command) or fails loudly (ENOENT → `markPathFailed` + throw) or clears history (vault swap). |
| CRLF single-line-FM file flips to LF if an ungated `markHydrated` clobbers `eol` | No reachable production path: every no-`eol` `markHydrated` is `isHydrated`-guarded, a genuine new-file/LF seed, or an ENOENT/recreate branch where the file is genuinely LF. |
| Quit hangs indefinitely on a wedged interactive drift prompt | The prompt has a 15 s hard auto-dismiss × `MAX_DRIFT_REPROMPTS = 3` → bounded ≤~45 s then `markPathFailed` + throw → `save()` returns false → `app:quit-awaiting-user`. |
| Post-write baseline TOCTOU leaves baseline un-stamped on BOM/size mismatch | `fs.stat().size` is the **logical** byte count and the IPC writes `fileText` (BOM-inclusive) verbatim, so a clean self-write always matches; the `else` fires only on a real foreign edit, where re-detecting drift on the next write is correct. |

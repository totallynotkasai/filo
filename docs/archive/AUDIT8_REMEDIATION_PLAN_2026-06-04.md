# Audit-8 Remediation Plan — 2026-06-04

**Scope:** data-integrity audit (write paths, frontmatter round-trip, concurrency, external-edit reconciliation, vault lifecycle, undo/redo) ahead of full daily dogfooding across **all four board types** (Mind Map, Kanban, Task List, Document). Windows / Electron, vault likely under OneDrive (`My Files\…`).

**Method:** 9 parallel adversarial domain auditors, then every BLOCKER/HIGH claim re-verified by hand against the live code (two agents directly contradicted each other; one HIGH was refuted as a false positive). This plan only contains findings confirmed or assessed against the actual source.

**Headline:** the infrastructure (atomic disk layer, board-cache persistence, vault lifecycle, single-parser CST engine) is genuinely strong. But there is **one CONFIRMED silent data-loss bug on the most common Kanban/Task operation** (B1), plus a CONFIRMED clean-editor clobber on OneDrive (H1). All seven prior audits and the recent test suite missed B1 because the tests pre-load a docState that the real UI never creates.

> **Working-software rule:** each phase must leave `npm run ci:verify` green (lint → check → test:unit:strict → build → 36 guards) and the app runnable. Ship phases in order; B1 is the gate for resuming Kanban/Task daily use.

## Status snapshot

| ID | Severity | Confidence | Area | Affects | Phase |
|----|----------|-----------|------|---------|-------|
| **A8-B1** | 🔴 BLOCKER | CONFIRMED | FM write scheduler ↔ command ↔ docState | Kanban + Task field edits | 1 ✅ DONE |
| **A8-H1** | 🟠 HIGH | CONFIRMED | External-change classifier | Any open editor on OneDrive | 2 ✅ DONE |
| **A8-H2** | 🟠 HIGH | CONFIRMED | Vault-identity guard uniformity | Vault swap | 2 ✅ DONE |
| **A8-M1** | 🟡 MED | CONFIRMED | FM EOL re-application | CRLF files (single-line FM) | 3 ✅ DONE |
| **A8-M2** | 🟡 MED | CONFIRMED | Drift baseline re-stamp | Open editor + external FM edit | 3 ✅ DONE |
| **A8-M3** | 🟡 MED | CONFIRMED | Quit-window before schedule | Task notes / quick-add create | 3 ✅ DONE |
| **A8-M4** | 🟡 MED | ~~LIKELY~~ **REFUTED** | Config failure attribution | `.filo/` config writes | 3 ✅ REFUTED |
| **A8-M5** | 🟡 MED | LIKELY | Orphan-card undo inverse | Kanban cards w/o `contentId` | 3 ✅ DONE |
| **A8-M6** | 🟡 MED | LIKELY | `tags.json` external reload | Concurrent tag edit | 3 ✅ DONE |
| **A8-L1** | ⚪ LOW | CONFIRMED | Reserved Windows names | New-file creation | 4 ✅ DONE |
| **A8-L2** | ⚪ LOW | CONFIRMED | Large/small external rename | Attachment rename outside app | 4 ✅ DONE |
| **A8-L3** | ⚪ LOW | CONFIRMED | Sticky `.dirty` sentinel toast | Read-only/locked share | 4 ✅ DONE |
| **A8-L4** | ⚪ LOW | CONFIRMED | Quit-failure breadcrumb UX | Post-crash recovery surfacing | 4 ✅ DONE |
| **A8-L5** | ⚪ LOW | CONFIRMED | Roundtrip-coverage gate scope | CI defense-in-depth | 4 ✅ DONE |
| **A8-L6** | ⚪ LOW | CONFIRMED | Quick-add month overflow | `in Nm` due dates | 4 ✅ DONE |

Phase 5 = anti-regression gates + test-blind-spot closure + doc updates.

---

## Phase 1 — BLOCKER: stop silent field-edit loss (do this first)

### A8-B1 — Kanban/Task field edit on an un-opened card/row is silently dropped on quit

**Status:** ✅ **DONE 2026-06-04** — fix applied to `frontmatterWriteScheduler.writeFrontmatter` (a `docId` with no live docState now falls through to the same fresh-disk-read body resolution the orphan branch used, instead of a silent-success `return`). 3 new bite-verified regression tests in `kanbanFrontmatterSeedFromDisk.test.ts` (Kanban no-docState write lands; ENOENT no-docState → `flushAll().failed` includes the path; Task-side mirror). Temp-reverting the fix reds exactly those 3 (write never captured / false-clean `.failed`); the 7 prior tests stay green. `npm run ci:verify` green end-to-end (working tree, not yet committed).

**Severity:** 🔴 BLOCKER · **Confidence:** CONFIRMED (traced end-to-end; the H1 test documents the abort) · **Affects:** both Kanban and Task List · **Regression?** Pre-existing (introduced by the 6.2.H5 `if (!docState) return` guard; the Audit-7 H1 refactor and its tests masked it). No prior audit or Codex caught it.

**Symptom:** Toggle a task's *completed* checkbox, set a card's *priority*, or pick a *due date* on any card/row you have **not** opened as a Document this session, then quit. The value shows correctly during the session, then **silently reverts on next launch** — no error, no toast, no `.filo/.dirty` recovery sentinel.

**Root cause (verified):**
1. The edit runs `UpdateCardFieldCommand` / `UpdateTaskFieldCommand.execute()` ([kanbanCommands.ts:616-643](src/renderer/commands/kanbanCommands.ts:616), [taskCommands.ts:431-447](src/renderer/commands/taskCommands.ts:431)) → seeds + `mergeFrontmatter` into the **frontmatter cache** and `scheduleFrontmatterWrite(relPath, docId)`.
2. `setFrontmatter`/`mergeFrontmatter` write **only** `frontmatterCache` ([document.svelte.ts:280](src/renderer/stores/document.svelte.ts:280), [:325](src/renderer/stores/document.svelte.ts:325)). A *docState* in `openDocuments` is created **only** by `loadDocument` ([document.svelte.ts:360](src/renderer/stores/document.svelte.ts:360)) — i.e. only when a card is opened as a Document tab (`openTileAsDocument`). `KanbanCard.svelte` / `TaskItem.svelte` only ever `getDocument()` to *read*.
3. At flush, [frontmatterWriteScheduler.ts:199-202](src/renderer/lib/boards/frontmatterWriteScheduler.ts:199):
   ```ts
   if (docId) {
     const docState = documentStore.getDocument(docId);
     if (!docState) return;   // ← bare return for an un-opened card
     body = docState.body;
   ```
   The bare `return` resolves `performWrite` as **success** (contrast the orphan branch at [:216-233](src/renderer/lib/boards/frontmatterWriteScheduler.ts:216), which does `markPathFailed` + `throw`). Success → `endWrite(true)` → `markClean` → **clears `.filo/.dirty`**. The `.md` is never written, and `.board.json` strips `priority`/`completed`/`dueDate` on write — so no copy survives anywhere.

**Why the tests passed:** every test that asserts a *disk write* pre-loads a docState to dodge the abort — see the explicit comment at [kanbanFrontmatterSeedFromDisk.test.ts:180-192](src/tests/unit/kanbanFrontmatterSeedFromDisk.test.ts:180) ("…the docId-path scheduler writes only when a docState exists… so load one to exercise the write end-to-end"). The test that omits `loadDocument` ([:163](src/tests/unit/kanbanFrontmatterSeedFromDisk.test.ts:163)) only asserts the in-memory cache.

**Fix:** unify body resolution so a `docId` with **no** docState falls through to the **same fresh-disk-read** the orphan branch already uses (not the stale index, so it cannot resurrect stale content; ENOENT still fails loudly). In `writeFrontmatter` ([frontmatterWriteScheduler.ts:198-234](src/renderer/lib/boards/frontmatterWriteScheduler.ts:198)):

```ts
let body: string;
const docState = docId ? documentStore.getDocument(docId) : undefined;
if (docState) {
  body = docState.body;
  if (!isHydrated(relPath)) {
    try { await readMarkdownForHydrate(vaultRoot, relPath); }
    catch { markHydrated(relPath, false); }
  }
} else {
  // No live editor (un-opened Kanban card / Task row, OR docId editor
  // unmounted between schedule and fire). Read the CURRENT body from disk
  // — never the body-stripped, possibly-stale vault index — and write the
  // merged FM. A throw (ENOENT/EACCES) surfaces the loss via markPathFailed
  // instead of silently dropping a real user edit. (Was: `if (!docId) {…}`.)
  try {
    const hydrate = await readMarkdownForHydrate(vaultRoot, relPath);
    body = hydrate.body;
  } catch (err) {
    markPathFailed(vaultRoot, relPath);
    throw err;
  }
}
```

This keeps the 6.2.H5 intent (no stale-index resurrection, no silent deletion-resurrection — the disk read throws if the file is gone) while persisting the field edit. Cost: one extra `vault:read-file-text` per field write on an un-opened card (the orphan path already pays this). The docId version-guard and the live-cache FM source above are unchanged and remain correct.

**Tests (these close the blind spot):**
- `kanbanFrontmatterSeedFromDisk.test.ts` — add a case that drives `writer.updateTileFrontmatter('t1', { completed: true })` **without** any `loadDocument`, flushes, and asserts a `vault:write-existing-file-text` landed containing `completed: true` and the preserved external `priority: high`.
- Add the Task-side mirror: `updateRowField` / the completed-toggle path with **no** docState → write lands.
- Add an ENOENT case: no docState + read fails → `flushAllPendingFrontmatterWrites().failed` includes the path (no false "Saved").

**Verification:** `npm run test:unit -- kanbanFrontmatterSeedFromDisk` then `npm run ci:verify`. Manual: in a real vault, create a Kanban card (don't open it), set priority, quit, reopen → priority persists. Repeat for a Task completed-toggle.

---

## Phase 2 — HIGH: silent clobber + cross-vault guard uniformity

### A8-H1 — Clean editor overwritten by a mid-write truncated read when mtime is in the future (OneDrive clock skew)

**Status:** ✅ **DONE 2026-06-04** — `isLikelyPartialRead` ([conflictResolver.ts:223](src/renderer/lib/vault/conflictResolver.ts:223)) now measures the mtime window with `Math.abs(now - next.lastModified)` (recency, not direction), so a clock-skewed future mtime within the window is held for `partial-read-retry` instead of falling through to `reload-silently`. 2 bite-verified tests in `conflictResolver.test.ts` (editor-clean branch + the VS1 FM-only branch, both at `lastModified = now + 500`); temp-reverting to `ageMs >= 0` reds exactly those 2 (→ reload-silently / sync-frontmatter). `npm run ci:verify` green.

**Severity:** 🟠 HIGH · **Confidence:** CONFIRMED (logic bug, untested branch) · **Affects:** any open editor on a synced/networked volume.

**Root cause:** [conflictResolver.ts:223-224](src/renderer/lib/vault/conflictResolver.ts:223):
```ts
const ageMs = now - next.lastModified;
return ageMs >= 0 && ageMs < PARTIAL_READ_MTIME_WINDOW_MS;
```
`ageMs >= 0` was meant to reject *old* mtimes (settled rewrite). But OneDrive/SMB routinely stamp a file's mtime **ahead** of the local clock; then `ageMs < 0`, `isLikelyPartialRead` returns `false`, the >90% mid-write truncation is **not** held for retry, and `classifyExternalChange` falls through to `reload-silently` ([:154](src/renderer/lib/vault/conflictResolver.ts:154)). A clean editor's view is replaced with the partial read; if the user then types and saves, truncated content is written back.

**Fix:** treat clock-skew symmetrically — the window is about *recency*, not direction:
```ts
const ageMs = Math.abs(now - next.lastModified);
return ageMs < PARTIAL_READ_MTIME_WINDOW_MS;
```
(Equivalently, gate on `now - next.lastModified > -SKEW_TOLERANCE && … < WINDOW`.) Update the docstring at [:200-206](src/renderer/lib/vault/conflictResolver.ts:200) to note future mtimes are in-window.

**Test:** `conflictResolver.test.ts` — add `isLikelyPartialRead(prev, next, now)` with `next.lastModified = now + 500` and a >90% shrink → expect `partial-read-retry`, not `reload-silently`. Pin a deterministic `now`.

**Verification:** `npm run test:unit -- conflictResolver` + `ci:verify`.

### A8-H2 — Vault-identity guard not applied uniformly across awaits

**Status:** ✅ **DONE 2026-06-04** — both sites converted to the generation-aware G1 guard. **(a)** `handleExternalMarkdownChanges` ([vaultExternalChanges.ts:113](src/renderer/stores/vaultExternalChanges.ts:113)) captures `captureVaultIdentity()` before its awaits and `return`s on `!isStillSameVault(identity)` immediately after `applyChanges` — the per-file loop is fully synchronous, so the single post-await check covers every sink. **(b)** `runPostCommitTasks` ([vault.svelte.ts:515](src/renderer/stores/vault.svelte.ts:515)) replaces `if (vaultPath !== newVaultPath) return;` with `if (!isStillSameVault(identity)) return;` (captured alongside `newVaultPath`). 3 bite-verified tests: a guard+control pair in `vaultExternalChanges.test.ts` (swap during `applyChanges` → clean editor NOT clobbered; no-swap control DOES reload) and a close→reopen-same-path case in `vaultSwapTagsGuard.test.ts` (the existing A→B test still passes under both; the new same-path test reds when reverted to the path-only compare). `ci:reconciler-vault-guard` stays green; file-size ceilings bumped (`vault.svelte` 1595→1602, `vaultExternalChanges` 1719→1730). `npm run ci:verify` green.

**Severity:** 🟠 HIGH · **Confidence:** CONFIRMED · **Affects:** vault swap mid-operation. **Mitigated** today by main-side `assertActiveVault` + fire-time vault-root capture (so no cross-vault *disk* write), which is why this is HIGH not BLOCKER — but it violates the project's own G1 discipline (`ci:reconciler-vault-guard`) at two sites and will become a real bug the day a backstop is refactored.

**Site (a) — the highest-stakes external reload path has no guard at all.** `handleExternalMarkdownChanges` ([vaultExternalChanges.ts:93-399](src/renderer/stores/vaultExternalChanges.ts:93)) awaits `whenBuildComplete()` ([:108](src/renderer/stores/vaultExternalChanges.ts:108)) and `applyChanges(paths)` ([:115](src/renderer/stores/vaultExternalChanges.ts:115)) and per-file retry timers, with **zero** `isStillSameVault()` checks. A swap during `applyChanges` can apply vault A's classification to vault B's same-named file (editor/tile/tag sinks).

**Fix (a):** import `captureVaultIdentity` / `isStillSameVault` from `lib/vault/vaultIdentity`. Capture at entry (after the self-write filter at [:99](src/renderer/stores/vaultExternalChanges.ts:99)); `return` if `!isStillSameVault(identity)` immediately after `applyChanges` ([:115](src/renderer/stores/vaultExternalChanges.ts:115)); and re-check `ctx.getVaultPath()`/identity before each mutation inside the per-file loop (the `sync-frontmatter` / `reload-silently` branches at [:174-237](src/renderer/stores/vaultExternalChanges.ts:174)). This is exactly the pattern `vaultExternalReconcilers.ts` already enforces.

**Site (b) — path-string guard instead of generation guard.** `runPostCommitTasks` ([vault.svelte.ts:515](src/renderer/stores/vault.svelte.ts:515)) uses `if (vaultPath !== newVaultPath) return;` after `applyFrontmatterToBackedTilesBatch`. A close→reopen of the *same path* is a new generation but passes the string check; the comment even claims to "Mirror `runRecoverySequencer`'s post-await re-check" but mirrors the pre-L25 version.

**Fix (b):** capture `const identity = captureVaultIdentity()` alongside `newVaultPath`/`candidate` (before the `vaultIndexStore.rebuild(fileTree).then(…)` at [vault.svelte.ts:485](src/renderer/stores/vault.svelte.ts:485)), and replace [:515](src/renderer/stores/vault.svelte.ts:515) with `if (!isStillSameVault(identity)) return;`. `vaultIdentity` is already imported in this file.

**Tests:** extend the existing vault-swap suites — a swap-then-same-path-reopen during a stubbed `applyChanges`/`rebind` must NOT mutate the new vault's tags/board. Confirm `ci:reconciler-vault-guard` still passes (and consider widening it to cover `vaultExternalChanges.handleExternalMarkdownChanges` — see Phase 5).

**Verification:** `ci:verify` (the guard gate must stay green).

---

## Phase 3 — MEDIUM

### A8-M1 — CRLF frontmatter flips to LF on single-line-FM files (the H2 fix has a hole)

**Status:** ✅ **DONE 2026-06-04** — robust fix (the threading option). `FileState` ([markdownFileWriter.ts:131](src/renderer/lib/vault/markdownFileWriter.ts:131)) gained `eol?`; `readMarkdownForHydrate` sniffs `content.includes('\r\n')` from the FULL raw file and threads it via `markHydrated(..., eol)` → `assembleMarkdownFile({ eol: state.eol })`. `detectFrontmatterEol` now prefers `options.eol`, and its detection fallback consults the body (not just the short-circuiting FM source) so a single-line-FM CRLF file with a CRLF body also stays CRLF for non-threading callers; `emitWithRawFrontmatter` takes the resolved eol. 5 new rows in `assembleMarkdownEngine.test.ts` (dirty + clean + threaded-eol + the all-LF documentation case); the existing H2 matrix stays green. `ci:eol-preservation` tokens (`function detectFrontmatterEol`, `const eol = detectFrontmatterEol(`, `.replace(/\n/g, eol)`) are intact. `npm run check` clean.

**Severity:** 🟡 MED (line-ending churn / mixed files, not content loss) · **Confidence:** CONFIRMED (reproduced through real `assembleMarkdownFile`) · **Affects:** CRLF files whose frontmatter is a single line (the common shape — one `title:`/`created:`/`tags:`). Directly undercuts the just-added Audit-7 H2 fix and matches the known "CRLF edit flip" hazard.

**Root cause:** EOL is detected from the **fence-stripped** frontmatter content:
- dirty branch: `detectFrontmatterEol` reads `options.originalFrontmatter || options.rawFrontmatter || body` ([markdownSync.ts:365-368](src/renderer/lib/editor/markdownSync.ts:365)). A single-line FM (`title: x`) has no internal `\r\n`, and the truthy `originalFrontmatter` short-circuits the CRLF-carrying `body`, so it returns `'\n'` for a CRLF file → fences/FM emitted LF, body stays CRLF → **mixed**.
- clean body-only branch: `emitWithRawFrontmatter` ([markdownSync.ts:347-351](src/renderer/lib/editor/markdownSync.ts:347)) has the identical `rawFrontmatter.includes('\r\n')` flaw.

**Fix (robust — capture the file's real EOL once, thread it):**
1. Extend `FileState` to `{ hadBom: boolean; eol?: '\r\n' | '\n' }` ([markdownFileWriter.ts:131](src/renderer/lib/vault/markdownFileWriter.ts:131)). In the hydrate read (`readMarkdownForHydrate`, which has the full raw file content) detect `content.includes('\r\n') ? '\r\n' : '\n'` and store it via `markHydrated` (add an `eol` param, mirroring `hadBom`).
2. Pass it at write time: `assembleMarkdownFile(fm, body, { …, eol: state.eol })` ([markdownFileWriter.ts:668-673](src/renderer/lib/vault/markdownFileWriter.ts:668)).
3. In `assembleMarkdownFile`, prefer an explicit `options.eol` when provided; only fall back to `detectFrontmatterEol`/`rawFrontmatter` detection for callers that don't supply it (new-file creation → LF, unchanged). Apply the same in `emitWithRawFrontmatter`.

**Fallback (minimal, if threading is deferred):** in both `detectFrontmatterEol` and `emitWithRawFrontmatter`, treat the file as CRLF if **any** of `originalFrontmatter`, `rawFrontmatter`, or `body` contains `\r\n` (don't let a truthy stripped FM short-circuit the body). Less precise than threading but closes the common single-line case.

**Tests:** `assembleMarkdownEngine.test.ts` — add single-line-FM CRLF rows for BOTH the dirty branch (Properties-style edit, CRLF body) and the clean body-only branch; assert the whole output (fences + FM + body) keeps `\r\n`. (Today every CRLF row uses ≥2-key FM, which has an internal `\r\n` and hides the bug.)

**Note:** `ci:eol-preservation` is a token-*presence* check and cannot catch a *wrong* eol value — the real protection is the behavioral test above (see Phase 5 for hardening the gate).

### A8-M2 — `sync-frontmatter` reconcile doesn't re-stamp the drift baseline → spurious "modified externally" prompt

**Status:** ✅ **DONE 2026-06-04** — the `sync-frontmatter` branch ([vaultExternalChanges.ts:200](src/renderer/stores/vaultExternalChanges.ts:200)) now calls `noteBaseline(rel, next.lastModified, next.rawByteSize)` after the `setFrontmatter`, UNCONDITIONALLY (whether or not an `editorDoc` exists — the baseline is per-file, keyed the way the gateway's `getBaseline(relPath)` reads it). 2 bite-verified tests in the new `audit8Phase3.test.ts` (no-editor + clean-editor-open, both assert the registry holds `{ mtimeMs: next, size: byteLen(content) }` after the sync). Without the stamp `getBaseline` stays `undefined`/stale, so a subsequent in-app save's pre-write drift check fires a false prompt.

**Severity:** 🟡 MED (no data loss; a spurious prompt the user can mis-answer with Reload, losing a keystroke) · **Confidence:** CONFIRMED. The Audit-7 L13/L16 baseline re-stamp covered every *body* reload site but missed this one.

**Root cause:** the `sync-frontmatter` branch ([vaultExternalChanges.ts:175-202](src/renderer/stores/vaultExternalChanges.ts:175)) calls `documentStore.setFrontmatter(editorDoc.docId, next.frontmatter, next.rawFrontmatter)` ([:189](src/renderer/stores/vaultExternalChanges.ts:189)) but never `noteBaseline(...)`. The sibling `reload-silently` branch threads `{ mtimeMs: next.lastModified, size: next.rawByteSize }` into `handleExternalChange` ([:226](src/renderer/stores/vaultExternalChanges.ts:226)) precisely so the per-file `(mtime,size)` baseline re-anchors. After an external FM-only edit, the stale baseline makes the next in-app save's pre-write drift check fire a false conflict prompt.

**Fix:** in the `sync-frontmatter` branch, after the `setFrontmatter`, add `noteBaseline(rel, next.lastModified, next.rawByteSize)` (import from `lib/vault/fileBaselineRegistry`). Place it whether or not an `editorDoc` exists (the baseline is per-file, keyed the same way the gateway's `getBaseline(relPath)` reads it).

**Test:** `audit7Phase4Reconciliation.test.ts` (or a new `audit8` test) — external FM-only edit classified `sync-frontmatter` → assert the baseline registry now holds `next.lastModified/rawByteSize` for `rel`, and a subsequent gateway pre-write drift check does NOT prompt.

### A8-M3 — Quit windows before a write is scheduled (Task notes body; quick-add task create)

**Status:** ✅ **DONE 2026-06-04** — **(a)** `setNotesBody` ([frontmatterWriter.ts:200](src/renderer/lib/tasklist/frontmatterWriter.ts:200)) loads the doc + applies the new body + arms `scheduleFrontmatterWrite` BEFORE the `seedDocumentFrontmatterFromDisk` await, and re-arms once more after the seed (so a `flushAll` that raced the gated seed against a still-empty FM cache and fired the early timer as a no-op doesn't strand the body). **(b)** all three task-creation paths (`createTaskInSection` / `addTaskFromQuickAdd` / `addSubtaskFor`, [taskCreation.ts](src/renderer/lib/tasklist/taskCreation.ts)) compute the insert slot and `await historyStore.execute(new AddTaskCommand(...))` BEFORE `await seedMdFile(...)` — `AddTaskCommand.execute` only mutates the board cache (no `.md`/doc dependency), and the seed's tracked write is in-flight the instant we enter `seedMdFile`, so the quit-drain catches the placement AND the file (no orphan `.md`); inserting first also tightens the insertPos TOCTOU. 2 bite-verified tests in `audit8Phase3.test.ts` (notes: `isPathPending` true while the seed read is gated + body lands; quick-add: dispatch ordered before the seed write).

**Severity:** 🟡 MED · **Confidence:** CONFIRMED · two sub-items, same shape as the bug Audit-7 H1 fixed, in spots H1 didn't cover.

**(a) Task notes body.** `setNotesBody` ([frontmatterWriter.ts:200-227](src/renderer/lib/tasklist/frontmatterWriter.ts:200)) `await`s `seedDocumentFrontmatterFromDisk(...)` *before* it calls `scheduleFrontmatterWrite` ([:225](src/renderer/lib/tasklist/frontmatterWriter.ts:225)), and is not on the history chain. A quit inside the seed-await window resolves `whenChainSettled()` immediately (empty chain), the flushers find nothing pending, and typed notes are lost with a clean sentinel.

**(b) Quick-add / new task create.** `addTaskFromQuickAdd` / `addSubtaskFor` / `createTaskInSection` ([taskCreation.ts:235-358](src/renderer/lib/tasklist/taskCreation.ts:235)) `await seedMdFile(...)` then dispatch `AddTaskCommand` **fire-and-forget**. A quit between the seed and the dispatch persists the `.md` (full frontmatter) but never runs the command's `markDirty`, so the `.board.json` placement is lost → an orphan `.md` the board doesn't reference.

**Fix:** schedule **before** awaiting the seed. `scheduleFrontmatterWrite` reads the FM/body live at fire time, so arming the timer first is safe and puts the pending path into the sentinel/flush set immediately. For (b), either `await historyStore.execute(new AddTaskCommand(...))` *before* the seed `await`, or hoist the seed into the command body (the H1 pattern) so the dispatch is on the chain.

**Tests:** gated-read tests mirroring `kanbanFrontmatterSeedFromDisk.test.ts`'s `whenChainSettled` block — suspend the seed read, assert (a) the notes write is already pending/flushable, (b) the task placement command has dispatched (board marked dirty) before the await resolves.

### A8-M4 — Config-bundle failure attribution is order-dependent → possible false "Saved"

**Status:** ✅ **REFUTED 2026-06-04 (verify-first → not-a-bug; no code change).** The PROBE (overlapping same-key fire-1-reject + fire-2-resolve, fire-2 settling first, then `flushAll`) does return `failed: []` — but that is CORRECT, not a loss: the config scheduler coalesces every write under ONE key/`failureId` and each fire's getter reads the LIVE config at fire time, so a later fire writes a state ≥ the earlier one. `writeConfigs` only advances `lastWrittenConfigs[target]` on success, so any file the earlier fire failed is RE-ATTEMPTED by the later fire — a later full success means the latest desired config (incl. the earlier failures' files) is on disk, so the earlier failure is genuinely SUPERSEDED. The plan's suggested per-fire-id fix would make `flushAll` report a *superseded* failure — a FALSE "save failed" for data that landed. Also: `writeConfigs` never throws (returns `{ failed }`), so the per-file ids it reports (`app.json`, …) are never the constant `failureId` the L12 prune deletes — the prune can't touch them. A genuinely-unresolved failure is still surfaced (later fire in-flight at `flushAll` → awaited + attributed; `notifyWriteError` per failed file). Documented + pinned with 2 tests in `writeScheduler.test.ts` (`A8-M4 (REFUTED) …`): the supersession case + a sanity sibling proving a still-in-flight later failure IS reported.

**Severity:** 🟡 MED · **Confidence:** ~~LIKELY~~ **REFUTED** — VERIFY FIRST done; behaviour is correct. · **Affects:** `.filo/` config writes only.

**Claimed root cause:** overlapping config fires share one `failureId` (`CONFIG_SENTINEL_PATH`). The L12 success-prune `failures.delete(failureId)` ([writeScheduler.ts:475](src/renderer/lib/boards/writeScheduler.ts:475)) on a *later* successful fire can erase an *earlier* fire's failure token before `flushAll` reads it ([:620-636](src/renderer/lib/boards/writeScheduler.ts:620)), dropping a real config-write failure from the `save()` aggregate → Ctrl+S flashes "Saved" while a config file failed.

**Step 1 — verify:** write a unit test in `writeScheduler.test.ts` that fires two overlapping config writes under one key, fire-1 rejecting and fire-2 resolving with fire-2 settling last, then asserts `flushAll().configFailed` still contains the path. If it's empty, the bug is real.

**Fix (if confirmed):** give each fire its own failure identity (e.g. `failureId = \`${CONFIG_SENTINEL_PATH}#${fireSeq}\``) or change `failures` from a `Set<string>` to a multiset / per-entry record so a later success can't erase an earlier failure's attribution. Keep the per-file granularity from `writeConfigs`' `failed[]` so the toast can name the specific config file.

### A8-M5 — Orphan-card undo can restore a stale value (inverse not re-captured from disk)

**Status:** ✅ **DONE 2026-06-04** — `UpdateOrphanFrontmatterCommand.execute()` ([kanbanCommands.ts:705](src/renderer/commands/kanbanCommands.ts:705)) now, on the FIRST execute only (a `hasExecuted` guard), drains pending FM writes, reads the CURRENT on-disk frontmatter via `readMarkdownForHydrate`, and recomputes `this.inversePatch` from it (mirroring the docId path's `captureInverseFromCache`); a read failure keeps the construction-time inverse. This fixes BOTH failure modes the stale-index inverse caused: (1) execute would FALSELY conflict (the rebase compares fresh disk vs the stale `expectedCurrent`) and DROP the user's edit, and (2) undo would restore `''`/absent instead of the true prior value. 1 bite-verified test in `updateOrphanFrontmatterRebase.test.ts` (external `priority: high`, stale `''` inverse, in-app set `low` → execute applies `low` with no conflict toast, undo restores `high`); the 2 existing rebase tests stay green.

**Severity:** 🟡 MED · **Confidence:** LIKELY (mostly masked by the rebase conflict prompt) · **Affects:** Kanban cards with **no** `contentId`.

**Root cause:** Audit-7 H1 re-captures the inverse from a fresh disk seed for the docId path (`captureInverseFromCache`), but `UpdateOrphanFrontmatterCommand` ([kanbanCommands.ts:705-727](src/renderer/commands/kanbanCommands.ts:705)) uses the construction-time inverse computed from the (possibly stale) vault index ([kanbanFrontmatterWriter.ts:99-106](src/renderer/lib/kanban/kanbanFrontmatterWriter.ts:99)). If an external editor added the key after the last index rebuild, undo restores `''`/absent instead of the true prior value. `applyOrphanPatchRebased` reads disk for the base/body but trusts the passed-in stale `expectedCurrent`/`inversePatch`.

**Fix:** in `UpdateOrphanFrontmatterCommand.execute()`, re-read the current on-disk frontmatter and recompute `this.inversePatch` from it (mirroring the docId path's `captureInverseFromCache`) before the first `applyOrphanPatchRebased`. Snapshot the recomputed inverse.

**Test:** orphan card whose disk `.md` gained `priority: high` externally → in-app set `priority: low` → undo restores `high`, not absent.

### A8-M6 — External `.filo/tags.json` reload replaces the registry wholesale, dropping un-flushed tag mutations

**Status:** ✅ **DONE 2026-06-04** — chose the merge approach. A new module-scoped `lastSavedFile` base ([fileTags.svelte.ts](src/renderer/stores/fileTags.svelte.ts)) tracks the last loaded/persisted disk state (set at `hydrate` / `commitFromCandidate`, on each successful debounced save, on external reload → the external copy, and cleared on `reset`); `applyExternalReload` now `mergeTagsThreeWay(base = lastSavedFile, ours = file, theirs = loaded.file)` re-applies our un-flushed delta (adds/changes/removes, vs the base) on top of the external disk copy instead of `file = loaded.file`. Untouched entries take the external value; a true same-key conflict resolves to OUR value (the user's in-app intent). 2 bite-verified tests in `audit8Phase3.test.ts` (a pending attachment-tag add survives a reload that lacks it AND the external registry addition is absorbed + persisted; an untouched path takes the external value).

**Severity:** 🟡 MED · **Confidence:** LIKELY · **Affects:** a tag added within the ~300 ms debounce window when an external write to `tags.json` lands.

**Root cause:** `applyExternalReload` ([fileTags.svelte.ts:526-530](src/renderer/stores/fileTags.svelte.ts:526)) overwrites the live `file` object with the disk copy then `scheduleSave()`. Any in-memory tag add/remove not yet flushed is discarded (attachment tags have no other home), and the subsequent save persists the disk version back.

**Fix:** merge rather than replace — re-apply the still-pending in-memory mutations on top of the loaded disk copy before `scheduleSave()` (track pending tag ops, or diff the dirty entries against the last-saved snapshot and re-apply). Alternatively, gate the reload behind `isRecentSelfWrite` parity so a genuine concurrent external write is the only trigger, then re-apply pending deltas.

**Test:** add tag X (debounce armed) → simulate external `tags.json` reload without X → assert X survives in the registry and the next save includes it.

---

## Phase 4 — LOW (hygiene / defense-in-depth; no data loss)

**Status:** ✅ **ALL PHASE 4 ITEMS DONE 2026-06-04** — L1–L6 landed; `npm run ci:verify` green end-to-end (38 steps incl. build + 36 guards; 3902 unit tests pass, 1 skipped). L2 is doc-only; the other five carry bite-verified tests. Working tree (commit alongside or after P1–P3). One file-size ceiling bumped (`vault.svelte` 1602→1608 for L4).

### A8-L1 — Reserved Windows device-name set incomplete

**Status:** ✅ **DONE 2026-06-04** — added `CONIN$`/`CONOUT$`/`CLOCK$` to `RESERVED_WINDOWS_NAMES` and changed the stem compare to `fileName.split('.')[0].trim().toUpperCase()` so a space-padded device name (` CON.md`, `CON .md`) is caught. 3 new tests in `pathSecurity.test.ts` (the three new device names + a non-device `$` name stays legal + space-padded `CON` rejects at creation).

[pathSecurity.ts:116-120](src/main/utils/pathSecurity.ts:116) omits `CONIN$`, `CONOUT$`, `CLOCK$`; the stem match ([:212](src/main/utils/pathSecurity.ts:212)) doesn't trim a leading space (` CON`). **Fix:** add the missing names; `stem = fileName.split('.')[0].trim().toUpperCase()`. **Test:** `assertSafeFilename('CONIN$.md', {forCreation:true})` and `' CON.md'` reject on win32. (Impact: device open is a no-op/hang on the *new* file — no escape/loss — hence LOW.)

### A8-L2 — Large/small external rename with a name change breaks tile references (no auto-relink)

**Status:** ✅ **DONE 2026-06-04 (documented, no code change — per plan).** Recorded as accepted trade-off #7 in `KNOWN_LIMITATIONS.md` (the `CROSS_BASENAME_MIN_SIZE_BYTES` 256 B floor + `CROSS_BASENAME_HASH_REQUIRED_BELOW` 10 MB ceiling, the same-basename-always-pairs nuance, and the manual broken-ref relink as the safety net). The proactive relink toast is left as a possible future enhancement, not a correctness fix.

`renameCorrelation` refuses correlation ≥10 MB and <256 B ([renameCorrelation.ts:364-382](src/renderer/lib/vault/renameCorrelation.ts:364)), so `git mv clip.mp4 final.mp4` on a 50 MB attachment emits delete+create → tiles dangle. Deliberate false-positive avoidance; the safety net is the manual broken-ref relink. **Fix (optional):** surface a proactive "renamed X? relink N tiles" toast for a large delete+create of matching size+extension. **No code-correctness change required;** document as accepted trade-off in `KNOWN_LIMITATIONS.md` if not fixing.

### A8-L3 — Zero-byte/unreadable `.dirty` sentinel toast can stick on a read-only share

**Status:** ✅ **DONE 2026-06-04** — chose the suppression option. `checkRecovery` now surfaces the `sentinel-unreadable` forensic toast + `recovery:snapshot` ONCE per vault per session via a module-scoped `Set<string>` (`surfacedUnreadableSentinel`, keyed by `vaultRoot`; not cleared on swap so an A→B→A doesn't re-nag) gating BOTH the EACCES branch and the zero-byte branch. The returned `RecoveryStatus` is unchanged (still flags recovery) — only the repeat surface is suppressed, and the modal already gates the reason out. New `__resetDirtyRecoveryDedupeForTests()` (called in the test `beforeEach` so the existing per-test toast-count assertions stay accurate) + 2 new tests (once-per-vault suppression; distinct vault still surfaces).

[dirtyFlagRecovery.ts:216,240](src/renderer/lib/vault/dirtyFlagRecovery.ts:216) returns `sentinel-unreadable`; the sequencer surfaces a toast but never `markClean`s ([vault.svelte.ts:592](src/renderer/stores/vault.svelte.ts:592)), so it self-heals only on a successful write. On a locked/read-only volume no write lands → toast every open. **Fix:** on `sentinel-unreadable`, attempt a best-effort sentinel clear/rewrite (or suppress the repeat after first surfacing per session). Advisory-only, no data loss.

### A8-L4 — Quit-failure breadcrumb consumed-on-read and sequenced behind a blocking `.dirty` modal

**Status:** ✅ **DONE 2026-06-04** — split `consumeQuitFailureBreadcrumb` into `readQuitFailureBreadcrumb` (read+parse, NEVER deletes) and `clearQuitFailureBreadcrumb` (best-effort delete). `runRecoverySequencer` now surfaces the quit-failure toast as **step 0** (BEFORE the `.dirty` modal's `await dismissed`, so it isn't gated behind it) and clears the breadcrumb only in the toast's `onDismiss` (guarded by `isStillSameVault` so a clear can't fire against a swapped vault) — a second crash before the user acknowledges re-surfaces the location instead of losing it. `quitFailureRecovery.test.ts` rewritten for the split (10 tests: read never deletes / survives a second read / clear consumes / read-then-clear integration). Stale doc-comments in `pathSecurity.ts`, `emergencyFileRegistry.ts`, `quitFailureBreadcrumb.ts` updated. `vault.svelte` ceiling 1602→1608.

`consumeQuitFailureBreadcrumb` deletes `.filo/quit-failure.json` before the user acts ([quitFailureRecovery.ts:70-83](src/renderer/lib/vault/quitFailureRecovery.ts:70)); a second crash before reading loses the *location* (the `.tmp` partials remain on disk). Also gated behind step-1's `.dirty` modal `await dismissed`. **Fix:** delete the breadcrumb only after the surfacing toast is shown/acknowledged; surface quit-failure independently of the `.dirty` modal. UX-only (bytes never lost).

### A8-L5 — `ci:command-roundtrip-coverage` is file-level

**Status:** ✅ **DONE 2026-06-04** — `isRoundTripped` now requires `.execute(` AND `.undo(` within a bounded forward window (`ROUNDTRIP_WINDOW = 1500` chars) of each `new <Class>(`, replacing the file-anywhere scan. **Bite-verified:** the tightened gate immediately flagged `AddConnectionCommand` — constructed + executed in `addFrameCommand.test.ts` but never `undo()`'d there (it passed the old gate for free via sibling commands' `.undo(` calls). Closed the real gap with a genuine execute→undo→redo round-trip test rather than an exemption (it's a deterministic add, so an exemption was also valid — the test is strictly better). Gate green: 71 commands, 59 round-tripped, 12 exempt. Forward-only window because you can't execute before constructing.

[check-command-roundtrip-coverage.mjs:114-119](scripts/check-command-roundtrip-coverage.mjs:114) marks a command "covered" if a file contains `new X(` + `.execute(` + `.undo(` anywhere — not necessarily on the same instance. A command merely *constructed* as a fixture passes. **Fix:** tighten to require construct + execute + undo within a bounded window of the same test block, or maintain an explicit per-command assertion allowlist. CI defense-in-depth.

### A8-L6 — Quick-add `in Nm` overflows month-end while recurrence clamps it

**Status:** ✅ **DONE 2026-06-04** — extracted the recurrence engine's month-clamp into a shared `lib/tasks/dateMath.ts` (`addMonthsClamped`) and routed BOTH `recurrence.addInterval` (month branch) and `quickAddParser` (the `in Nm` handler, replacing raw `setMonth`) through it, so `in 1m` on Jan 31 → Feb 28 (or Feb 29 leap), matching recurrence. New `dateMath.test.ts` (7 cases incl. leap, year-wrap, negative, no-mutate) + 2 quick-add cases (Jan 31 non-leap / leap). The existing recurrence monthly-clamp tests confirm behaviour is unchanged by the extraction.

[quickAddParser.ts:188](src/renderer/lib/tasks/quickAddParser.ts:188) uses raw `Date.setMonth` (Jan 31 + 1m → Mar 3); `recurrence.ts:111-118` clamps to Feb 28/29. Produces a valid but surprising ISO date — no corruption. **Fix:** reuse the recurrence month-clamp helper in quick-add for consistency. **Test:** quick-add `in 1m` on Jan 31 → `Feb 28/29`.

---

## Phase 5 — Anti-regression gates, test-blind-spot closure & docs

**Status:** ✅ **DONE 2026-06-04** — full `npm run ci:verify` green end-to-end (lint → check → test:unit:strict 3902 pass/1 skip → build → **37** guards). Three gates landed/changed, all bite-verified via temp-CWD copies (real source untouched): (1) NEW `ci:no-silent-write-abort` (37th gate) forbids B1's bare `if (!docState) return` on the FM write path + requires the `markPathFailed`/`readMarkdownForHydrate` loud-failure surface; (2) HARDENED `ci:eol-preservation` to also assert the A8-M1 single-line-CRLF behavioral matrix exists in `assembleMarkdownEngine.test.ts` (token pin stays a tripwire); (3) WIDENED `ci:reconciler-vault-guard` to scan `vaultExternalChanges.ts` with object-literal METHOD discovery (so H2(a)'s `handleExternalMarkdownChanges` is covered — trigger is the intrinsic live-path read, not the guard, so a removed guard can't evade it) + a `GUARD_EXEMPT` for the two main-side-mitigated live-path readers (`handleExternalAttachmentChanges`/`recreateDeletedFile`), and folded in the H2(b) ratchet forbidding `=== newVaultPath`/`!== newVaultPath` path-string swap compares in `vault.svelte.ts`. Docs: CLAUDE.md gate count 36→37 + revised gate bullets + EOL note on the frontmatter gotcha; KNOWN_LIMITATIONS #7 (L2) already present; memory index updated. Item-1 (B1) and item-3 (vault.svelte.ts:515 conversion) source/test work already shipped in P1/P2. **Item 5's manual all-board-types dogfood pass is a human step, not performed here.** Decision: the two latent live-path readers were EXEMPTED rather than converted — Phase 5 is anti-regression, not new fixes, and converting `handleExternalAttachmentChanges` would break `externalAttachmentDeleteGrace.test.ts`'s swap test (it simulates a swap via `setPath`, which does not bump the `vaultIdentity` generation that `isStillSameVault` reads).

The recurring signature across this audit is **"fixed per-site, not structurally"** + **tests that step around the bug.** Close the classes, not just the instances:

1. **B1 blind spot (highest value).** Add a standing test that drives the real field-edit path with **no** `loadDocument` (Phase 1 already adds the behavioral test). Optionally add a small `scripts/check-*.mjs` ratchet that fails a bare `if (!docState) return;` in `frontmatterWriteScheduler.ts` without an accompanying `markPathFailed` — i.e. forbid the silent-success-on-abort shape on a write path.
2. **Harden `ci:eol-preservation`** ([scripts/check-eol-preservation.mjs](scripts/check-eol-preservation.mjs)) — the token-presence check can't catch a wrong eol value. Back it with the single-line-CRLF behavioral matrix from A8-M1 (the real protection), and keep the token pin as a tripwire.
3. **Widen `ci:reconciler-vault-guard`** to also scan `vaultExternalChanges.handleExternalMarkdownChanges` (and any `stores/*` function that reads `vaultStore.path`/`vaultRoot` then awaits), so A8-H2(a) can't recur. Convert the path-only guard at [vault.svelte.ts:515](src/renderer/stores/vault.svelte.ts:515) and add a lint/grep ratchet forbidding `vaultPath !== newVaultPath` style guards in favor of `isStillSameVault`.
4. **Docs.** Update `CLAUDE.md` (the frontmatter/EOL gotcha + the new gate descriptions) and `KNOWN_LIMITATIONS.md` (A8-L2 if accepted). Append an Audit-8 entry to the memory index.
5. **Full gate run:** `npm run ci:verify` green (now 36 + any new guards), and a manual dogfood pass across all four board types focusing on field edits + OneDrive sync.

---

## Sequencing & exit criteria

- **Phase 1 (B1)** — required before resuming Kanban/Task daily use. Smallest, highest-impact change.
- **Phase 2 (H1, H2)** — required before trusting OneDrive sync + vault switching.
- **Phases 3–5** — pre-broad-dogfooding polish; M4 needs a verify-first step before its fix.

Ship each phase as its own commit, `ci:verify` green at every boundary. Suggested commit prefixes: `Audit-8 P1: B1 field-write loss`, `Audit-8 P2: H1/H2`, etc. Update this file's status table as items land.

## Refuted / not-a-bug (recorded so they aren't re-investigated)

- **"CRLF/BOM defeats the post-write baseline TOCTOU guard" — FALSE POSITIVE.** `writtenByteLength = utf8ByteLength(fileText)` ([markdownFileWriter.ts:677](src/renderer/lib/vault/markdownFileWriter.ts:677)) is measured from the *exact same string* the main process writes verbatim (no EOL/encoding transform in `atomicWriteFile`), so `postStat.size === writtenByteLength` holds for CRLF and BOM alike. The guard works as intended.
- **"Single shared markdown write path could clobber across two editors" — already closed** by `writeChainByPath` (per-resolved-path serialization, [markdownFileWriter.ts:235](src/renderer/lib/vault/markdownFileWriter.ts:235)).
- **Atomic-write durability, path-traversal containment, board.json corrupt-load-fail-safe, frontmatter-wins hierarchy** — verified solid; no action.

# Audit-5 Remediation Plan — Data Integrity (2026-06-02)

**Source:** Fifth data-integrity audit (9-agent adversarial sweep + manual re-verification of every HIGH). 25 candidates → 20 confirmed/partial, 5 refuted. The four HIGH findings were each independently reproduced or read-confirmed (the frontmatter one with a runnable probe against the installed `yaml`/`js-yaml`).

**Status at authoring:** Nothing fixed yet. This document is the work list.

---

## 0. Executive summary — do we need a broader refactor?

**Verdict: No rewrite. Yes to three contained, root-cause refactors.**

The foundations are genuinely sound and were verified clean: atomic writes with tmp-preservation + emergency registry, the IPC `ok/error` envelope contract, the command pattern with CI-enforced snapshot/`targetBoardId` discipline, and unusually thorough vault-swap reset coverage. The data model (open files = source of truth, frontmatter canonical, debounced writes) is coherent. Five candidate findings were *refuted* by real defenses in the code. This is not an architecture in trouble.

**Why it nonetheless "feels like it will never be ready":** the last four audits have remediated *symptoms*, not *roots*. The same three subsystems keep emitting new variants of the same bug:

| Recurring cluster | Audits that touched it | Why it keeps leaking | The root-cause fix |
| --- | --- | --- | --- |
| **Frontmatter serialization** | audit2 cluster, DI-01 (CORE_SCHEMA), DI-06 (folded `>`), now **#3** (untouched scalars) | The strategy is "parse the whole block → mutate → re-serialize via `yaml.toString()`". A serializer *cannot* preserve arbitrary untouched bytes; each audit whitelists one more value-class (dates, merge keys, folded blocks, now leading-zeros). It will keep leaking. | **R1** — true source-preserving patch: only the changed key's line(s) are rewritten; every other byte is spliced back verbatim. |
| **The "canonical" markdown write gateway** | DI-09 (per-path chain), now **#4 / #8** | The gateway is the canonical path *except* for `allow-direct-write` escape hatches (single-tag writes). A boundary with holes re-introduces the exact races/clobbers it exists to prevent. | **R2** — seal the boundary: route tag writes through the gateway; delete the escape hatch. |
| **Post-`await` resumption safety** | DI-03 (one vault-identity guard), now **#1 / #5 / #6 / #10 / #12 / #14** | Two missing disciplines: (a) no timeout/abort on awaited writes → a stranded promise hangs forever; (b) vault-identity / generation re-checks were added to *one* site, not generalized → siblings keep surfacing. | **R3** (bounded async) + **G1** (identity-guard helper). |

Each root-cause fix collapses a whole class of present *and future* findings. After Phase 1 + G1, audits should stop finding new variants of these three, and the trajectory toward "trust it with irreplaceable notes" becomes finite and visible.

**On "Live Service":** Filo is local-first — no server, no multi-user concurrency, no network. "Ready for Live Service" here means *durable enough to trust with your real vault*. That bar is data-loss-free write paths, not the reliability engineering of a networked service. It is achievable with the bounded work below; it does not require re-platforming.

**Confidence note:** the 4 blockers are personally verified. The 5 mediums and 9 lows rely on the audit's 3-way adversarial verification (well-reasoned, and it refuted 5 candidates) but were not all independently re-read by me. The refactor recommendation is engineering judgment — weigh it, don't take it as gospel.

---

## Phase 1 — Root-cause refactors (the "broader refactor", contained)

These three are the blockers **and** the cluster-killers. Do them first; several later items shrink or vanish once they land.

### R1 — Frontmatter: true source-preserving write `[#3 HIGH · data-corruption]`
**Files:** `src/renderer/lib/vault/frontmatterEngine.ts` (`patchFrontmatterSource`, L82–129; the offending `doc.toString({lineWidth:0})` at L128), reached from `src/renderer/lib/editor/markdownSync.ts` `assembleMarkdownFile` dirty branch (~L381–394).

**Root cause (reproduced):** changing *any one* key and re-serializing the whole `yaml` Document canonicalizes every untouched plain scalar — the `yaml` package does not retain source tokens for plain scalars. Probe output (only `title` changed): `zip: 02134→2134`, `isbn: 0306406152→306406152`, `color: 0xFF00FF→0xff00ff`, `exp: 6.022e23→6.022e+23`, `count: 007→7`. The `js-yaml.dump` fallback is equally lossy. Silent, on-disk, on every dirty FM write (Properties edit, task field toggle, Kanban card edit).

**Fix (pick one; (a) preferred):**
- **(a) Byte-level splice.** Compute the set of changed/added/deleted keys (already known via `valuesEqual`). Rewrite *only* those keys' source ranges in the original frontmatter text; leave all other lines byte-for-byte. The `yaml` CST exposes each node's `range`/`srcToken` — use it to locate untouched-key spans and copy them verbatim rather than re-emitting. This generalizes DI-06's folded-`>` splice to *all* untouched scalars.
- **(b) Quote-on-write guard (cheaper, partial).** Before `doc.set`, detect values whose source representation is ambiguous (leading-zero / hex / exponent / sexagesimal) and force a quoted style so the round-trip is lossless. Does not fix hex-case churn on *untouched* keys, so weaker than (a).

**Verification:**
- Unit: a corpus row per value-class (`02134`, `0306406152`, `0xFF00FF`, `6.022e23`, `007`, sexagesimal `1:30`, `+5`, `  padded`) — edit a *sibling* key, assert the untouched key's bytes are identical.
- **CI ratchet:** extend `scripts/check-frontmatter-invariant.mjs` to assert raw-**byte** equality on untouched keys (current `toEqual` on parsed values is blind — `2134===2134` passes). This is the gate that would have caught #3.

**Effort:** M–L (CST work + corpus). **Kills:** #3; ends the FM cluster; hardens #17.

---

### R2 — Seal the markdown write boundary `[#4 HIGH + #8 MED · data-loss / write-race]`
**Files:** `src/renderer/stores/fileTags.svelte.ts` `writeTagChangeToTileMarkdown` (L165–227) and `writeTagChangeToMarkdownPath` (L316–369) — both write via raw `vault:write-existing-file-text` (`allow-direct-write`, L205/L353) and call only `vaultIndexStore.applyChanges`. Contrast the gateway's per-path chain `writeChainByPath` (`markdownFileWriter.ts` L205, 407–414) and the canonical reconciler `syncOpenEditorsAfterDiskMutation`.

**Root cause:** single-tag writes bypass the gateway entirely, so they (a) never reconcile an open editor's frontmatter cache → on the next body save the gateway passthroughs stale FM and **drops the tag** (#4); and (b) are not enrolled in DI-09's per-path write chain → they can race a concurrent body write to the same file (#8). Same bypass, two symptoms.

**Fix:** route both single-tag writers through `writeMarkdownFile` (the gateway) instead of the raw IPC, OR — if the line-level tag fast-path must be kept for performance — after the direct write, (1) `await` the gateway's in-flight promise for that path / enroll in `writeChainByPath`, and (2) call `syncOpenEditorsAfterDiskMutation([{path, content: next}])` so the open editor's clean-bytes cache reflects the new tag. Then delete the `allow-direct-write` exemption for these two call sites so the boundary is genuinely closed.

**Verification:**
- Unit: open editor with clean FM cache + add tag + simulate body save → assert tag survives on disk.
- Unit: concurrent tag write + body write to same path → assert deterministic merge, no lost write.
- **CI ratchet:** new `scripts/check-md-writers-reconcile-editors.mjs` — any module issuing `vault:write-existing-file-text` / `vault:write-file-text` outside the gateway must also call `syncOpenEditorsAfterDiskMutation` (or be on an allowlist with a documented reason). This is the structural gate that prevents re-introduction.

**Effort:** M. **Kills:** #4, #8. **Also check:** `DocumentEditor.svelte` likely shares #4 (same `documentStore`) — fold into the same fix.

---

### R3 — Bounded, non-stranding write flush `[#1 HIGH + structural root · data-loss]`
**Files:** `src/renderer/stores/ui.svelte.ts` (`pushToast` eviction L327–331, `dismissToast` silent-skips `onDismiss` L390); `src/renderer/lib/boards/writeScheduler.ts` (`fireWrite` awaits `performWrite` with no timeout L354–361; `flush` L549–563; `flushAll` L639/L648); consumers `markdownFileWriter.ts` (`await handler(relPath)` ~L487) and `boardWriteScheduler.ts` (~L260).

**Root cause:** the external-edit drift prompt resolves its promise *only* via the toast's `onDismiss`/action. The toast queue caps at 8 and evicts via `dismissToast(id,{silent:true})`, which skips `onDismiss` → the promise is stranded forever. The write `await`s it with **no timeout anywhere in the flush chain**, so `flushAll → save()` hangs; on quit the 5s main timer destroys the window mid-save. The verifiers flagged the missing timeout as a HIGH structural root in its own right.

**Fix (do both — independent defenses):**
1. **Don't strand promises.** Exclude `onDismiss`/action-bearing toasts from the eviction victim search (`pushToast` L328), **or** fire `onDismiss` even on silent eviction for promise-backed toasts. Clear the `inFlightDriftPrompts` entry on eviction so a stranded promise isn't reused per-path.
2. **Bound every awaited write.** Wrap `await performWrite(args)` (or the `flush`/`flushAll` awaits) in `Promise.race([tracker, timeout])`; on timeout, resolve the drift decision to `'defer'` (keep dirty, do not lose) and record a failure id so the UI shows "Save failed" instead of freezing. This converts *any* future wedged `performWrite` (not just this toast bug) into a visible, recoverable error.

**Verification:**
- Unit: push 8 toasts incl. a promise-backed drift toast → assert the drift promise resolves (to `defer`) rather than stranding.
- Unit: a `performWrite` that never settles → assert `flushAll` rejects/marks-failed within the timeout, `save()` returns false.

**Effort:** S–M. **Kills:** #1; de-fangs the *hang* in #6 and #14 (the displaced/stacked prompts no longer freeze a flush). #6's stranded-decision still needs its own fix (see 2.4).

---

## Phase 2 — Remaining blocker + medium correctness

### 2.1 — Quit-drain heartbeat before/while draining `[#2 HIGH · data-loss]`
**Files:** `src/renderer/lib/vault/handleFlushAndQuit.ts` (L30–72; `await save()` at L33, heartbeat only at L55 on the failure branch); `src/main/main.ts` (close-event timer L177–183; menu-quit timer L428–431; `FLUSH_TIMEOUT_MS=5000` L55).
**Root cause:** no heartbeat is sent during `await save()`; the DI-04 `app:quit-awaiting-user` clears the 5s destroy timer but fires only *after* the drain, on failure. A drain >5s (contended volume — note the user's vault is under OneDrive) destroys the window mid-write.
**Fix:** send a drain-in-progress signal (reuse `app:quit-awaiting-user` or add `app:drain-in-progress`) **before** `await save()`, and re-send periodically (e.g. every 2s) while it runs; main resets its timer on each beat. Keep the failure-branch confirm as-is. **Verify:** test that a slow `save()` (fake 8s) does not let the main timer fire; heartbeat observed before save resolves.
**Effort:** S.

### 2.2 — `vaultIndex.rebuild()` generation guard `[#5 MED · state-incoherence]`
**Files:** `src/renderer/stores/vaultIndex.svelte.ts` (`rebuild` L163–187 — no `if (isBuilding) return`, no generation token; `indexOnePath` L70–106 captures root but no post-`await` recheck; resolvers drained in `finally` L184–185).
**Root cause:** a fast A→B vault swap runs two overlapping rebuilds on the same module-level `index`/`isBuilding`/`buildCompleteResolvers`; A's `finally` flips `isBuilding=false` and drains B's resolvers → recovery sequencer resolves against a half-built index (re-opens 6.2.H3) + leaked self-rescheduling 2s retry timers.
**Fix:** generation counter — increment on each `rebuild()` entry, capture locally, abort the chunk loop + skip the `finally` drain when stale; re-check `vaultStore.path === root` inside `indexOnePath` after the read before upsert/retry-schedule. (Reusable pattern → feeds G1.)
**Verify:** test overlapping rebuilds; assert the stale generation neither resolves resolvers nor schedules retries. **Effort:** M.

### 2.3 — Orphan-FM ENOENT must fail honestly `[#7 MED · silent-error]`
**Files:** `src/renderer/lib/boards/frontmatterWriteScheduler.ts` (`markPathFailed(...); return;` L228); `writeScheduler.ts` `fireWrite` treats non-throw as success (L356); `vault.svelte.ts` `save()` boolean (L1104–1110).
**Root cause:** the bare `return` after `markPathFailed` makes `flushAll().failed` omit the path → `save()` returns true → Ctrl+S toasts "Saved" while the indicator reads error and `.dirty` is set.
**Fix:** replace the bare `return` with `throw` (or surface `{failed:[relPath]}`) so the failure propagates to `save()`'s boolean. **Verify:** test orphan FM write whose backing file is gone → `save()` returns false, no "Saved" toast. **Effort:** S.

### 2.4 — `confirmDialog` must not strand a displaced decision `[#6 MED · liveness]`
**Files:** `src/renderer/stores/ui.svelte.ts` `openConfirm` (L249, unconditional overwrite); consumers `tabs.svelte.ts` `confirmCloseAnyway` (~L272), `handleFlushAndQuit.ts` (L56–70), `vaultExternalChanges.ts` `recreateDeletedFile` (~L1484).
**Root cause:** a second `openConfirm` overwrites a pending one; the first's `onConfirm/onCancel` can never fire → its `await` hangs (e.g. `tabStore.close()` wedges).
**Fix:** before replacing, fire the outgoing config's `onCancel()` (mirrors what `cancelTopLayer` and the vault-swap handler already do), or maintain a small confirm queue. **Verify:** test two overlapping `openConfirm`s → first promise resolves (to cancel), no hang. **Effort:** S.

### 2.5 — Section commands: delta-aware, not slice-replace `[#9 MED · undo-redo]`
**Files:** `src/renderer/commands/sectionCommands.ts` (`DeleteSectionCommand` L94–102 via `restoreTaskListSlice`; `ReorderSectionCommand` L174–188 via `persistTaskListStructure`); `taskCommands.ts` `restoreTaskListSlice` L68–82 (wholesale `tileDefs` replace).
**Root cause:** both replay a construction-time snapshot of the whole `tileDefs`/`tasks`/`sections`, so a task added/edited in another section between execute and undo is silently reverted. `AddSection`/`RenameSection` were already rewritten (A6.1) to be delta-aware; Delete/Reorder were left behind.
**Fix:** apply the A6.1 delta treatment — snapshot only the affected section(s) + their tasks, merge against live cache at execute/undo time. **Verify:** test delete-section → add-task-elsewhere → undo → added task survives. **Effort:** M.

---

## Phase 3 — Concurrency identity-guard generalization + lows

### G1 — Generalize the post-`await` vault-identity guard `[#10 + #12 + withDrainedWrites · LOW, but a pattern fix]`
**Files:** `src/renderer/stores/vaultExternalChanges.ts` (`handleExternalRename` L411, `runExternalRenameCascade` L519 — read `ctx.getVaultPath()` after awaits, no identity check); `vault.svelte.ts` `renameQueue` reassignment (L952/L1021) does not cancel already-enqueued tasks (L1283); `dirtyFlagRecovery.ts` mutex reset (L244–246) orphans in-flight `markClean` (`writeStateTracking.resetWriteTracking` L498–499); `vaultOperations.ts` `drainInProgress` module-global (L104/L129).
**Root cause (shared):** work that suspends on an `await` can resume *after* a vault swap and run against the new vault; guards exist at one site (DI-03) but not as a discipline.
**Fix:** a small helper — capture `(vaultPath, generation)` at enqueue/arm time; expose `isStillSameVault(captured)`; have each post-await resumption (rename cascade, tree cleanup, `markClean`, `withDrainedWrites`) early-return if stale. Scope `drainInProgress` per-vault (or per generation). Await `markClean(old)` before resetting the sentinel mutex (or sequence via `runAfter`).
**Verify:** test enqueue-then-swap for each path → handler no-ops against the new vault. **Effort:** M. **Kills:** #10, #12, the unscoped-drain related finding.

### Remaining lows (each small, independent)

| ID | Sev | Fix | Files |
| --- | --- | --- | --- |
| **#11** | L | Vault-open scan of `.filo/recovery/` → persistent toast/modal listing preserved snapshots (basename + ts + reveal); only prune after acknowledgement | `RecoveryFiles.svelte` L5; `recoverySnapshot.ts` `pruneOldSnapshotsGlobal` L233–291 |
| **#13** | L | Hoist the retry `setTimeout` into a module handle; clear on new navigate + in the existing `onVaultSwap('navigation')` handler; bail if `vaultStore.path` changed | `navigation.svelte.ts` L48–67, L89–95 |
| **#14** | L | Give `promptBoardExternalEdit` the same `inFlightDriftPrompts` dedup + swap-reset + rename-transfer wiring as `promptExternalEditOnSync` (the *hang* is already fixed by R3) | `vaultExternalChanges.ts` L1552–1589 vs L1359–1434 |
| **#15** | L | Capture `flushPendingSave().ok` at both in-app cascade sites; on failure fold `tagsAffected:true` into the existing `renameCascadeSentinel` (rename) / lay a tags-only sentinel (delete) | `vaultFolderOps.ts` L568, L835 |
| **#16** | L | (Your uncommitted diff) On ENOENT throw, proactively `boardRefIntegrity.recompute` (or mark path broken) so the badge is immediate; or downgrade to `console.debug` rather than full suppress | `TextTile.svelte` L350 |
| **#17** | L | `syncTileMarkdown`: call `documentStore.setFrontmatter(docId, diskParsed.frontmatter, diskParsed.rawFrontmatter)` before `writeMarkdownFile` so cache+baseline reflect the fresh read (or honour `args.frontmatter`). Largely mooted by R1 | `boardCache.svelte.ts` L862–917; gateway L550/585–597 |
| **#18** | L | `rollbackExecute`: restore the redo stack only if unchanged since `commitExecute` (identity-compare), or defer `commitExecute`'s push+clear until the chained body runs | `history.svelte.ts` L397–408, 271–303 |
| **#19** | L | Drift-abort branch: mirror the ENOENT branch's `lastWrittenConfigs.delete(target)` so a revert-to-prior payload isn't dedup-suppressed | `configWriteScheduler.ts` L311–319 vs L297–306 |
| **#20** | — | **Already fixed at HEAD** (6.3.P1/P2 platform-gating). Only add a CI guard asserting read/delete handlers never pass `forCreation:true`, to prevent regression | `pathSecurity.ts` L188–216 |

---

## Phase 4 — Anti-regression CI + follow-up audit surface

**New / extended CI ratchets (each pins a class shut):**
1. `ci:frontmatter-invariant` → assert raw-**byte** equality on untouched keys (catches #3-class). *(R1)*
2. `ci:md-writers-reconcile-editors` → direct `.md` writers must reconcile open editors. *(R2)*
3. `ci:no-forCreation-on-read-delete` → read/delete IPC handlers never pass `forCreation:true`. *(#20)*
4. (Optional) `ci:awaited-writes-bounded` → grep that `flushAll`/`fireWrite` awaits are timeout-wrapped. *(R3)*

**Follow-up audit surface (not deeply traced this round — schedule a targeted pass):**
- `DocumentEditor.svelte` — almost certainly shares #4's reconcile gap (same `documentStore`).
- `boardCacheKanban.ts` / `boardCacheTaskList.ts` internal cache writers (mediums #5/#9 touched the commands, not every writer).
- Frontmatter scheduler vs concurrent board-JSON writes (adjacent dimension).
- Nothing here was run dynamically — a Playwright E2E reproduction of #1 (toast-strand quit) and #4 (tag revert) would convert "static-traced" into "observed".

---

## Suggested sequencing & effort

```
Phase 1 (blockers + cluster-killers):  R1 (M–L) · R2 (M) · R3 (S–M)     ← biggest trust gain
Phase 2 (blocker + mediums):           2.1 (S) · 2.2 (M) · 2.3 (S) · 2.4 (S) · 2.5 (M)
Phase 3 (pattern fix + lows):          G1 (M) · #11/#13/#14/#15/#16/#17/#18/#19 (S each) · #20 CI (S)
Phase 4 (CI ratchets + follow-up):     gates 1–4 · scheduled targeted re-audit
```

Total is a **bounded, finite list** — roughly 1–2 focused sessions for Phase 1, a session for Phase 2, a session for Phase 3+4. The point of front-loading R1/R2/R3/G1 is that they end the *recurring* findings; after them, the remaining items are genuinely independent one-offs, not symptoms of a leaking root. Run `npm run ci:verify` green after each item (repo culture: every fix carries a test or ratchet).

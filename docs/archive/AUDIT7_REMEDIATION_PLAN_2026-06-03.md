# Audit-7 Remediation Plan — Data Integrity

**Date:** 2026-06-03
**Scope:** Data-integrity, write-path, concurrency, lifecycle and error-handling issues found in the Audit-7 adversarial review (9-agent sweep — 6 finders + 3 refute-by-default verifiers, with throwaway `vitest` probes run against the real code). Findings target the committed state at `HEAD = 6067e4d` ("Audit-5/6 + Phase 6"). Type-check at audit time was clean (807 files, 0 errors).
**Status:** Phases **1–7 DONE** (implemented + tested; `ci:verify` green, **36 gates**; working tree **uncommitted**). Phase **6** (state/undo edge: L8/L10/L9/L4) completed 2026-06-03 — L4 took fix-option (a) (drop a deleted key's glued comment instead of relocating it); L8 made `fmValueEqual` order-independent (objects key-order-independent, arrays multiset); L10 surfaces a warning toast on a deleted target board; L9 clamps both ends of the kanban placement splice. Phase **7** completed 2026-06-03 — the two anti-regression *gates* are now live: `ci:eol-preservation` ([scripts/check-eol-preservation.mjs](scripts/check-eol-preservation.mjs), pins H2's `.replace(/\n/g, eol)`) and `ci:no-dead-flush` ([scripts/check-no-dead-flush.mjs](scripts/check-no-dead-flush.mjs), flags M1's dead-flusher class). Both bite-verified against regressed fixtures + false-positive-safe (markup-bound ref / `// allow-dead-flush:` escape). The class-closing *tests* for items 1–3 already shipped with their Phase 1–6 fixes (`assembleMarkdownEngine.test.ts`, `audit7Phase4Reconciliation.test.ts`, `gatewayWriteClearsDirtyWriter.test.ts` + `documentDirtyPerWriter.test.ts`); item 4's `ci:no-dead-flush` was the optional-but-cheap lint and is included. (User scope decision for the audit was *report-only*; this plan is the follow-up artifact.)
**Inputs:** 3 HIGH, 5 MEDIUM, 18 LOW confirmed/partially-confirmed; 1 verifier-stumbled (folded into M1 as its root cause); 3 refuted (Appendix A — do **not** fix).

---

## 0. How to read this plan (and the honest "is a refactor needed?" answer)

**No rewrite is required. The catastrophic-loss core is sound.** The verifiers explicitly confirmed: atomic write sequence (open→write→fsync→close→rename→fsync-dir) with ENOSPC tmp-preservation, per-path write serialization, snapshot-at-fire-time deep-clones, `BatchCommand` rollback, the single-parser CST frontmatter engine (the dual-parser corruption class is *structurally dead*; exotic scalars/comments/key-order survive byte-for-byte), the quit handshake, `withDrainedWrites` draining all five pipelines generation-keyed, and 33+ vault-swap reset handlers. **No finding shows routine note-body loss.**

The confirmed issues are **instance-level holes and discipline gaps**, not architecture. They cluster into five root causes — fix the cluster, not just the instance:

| Cluster | Findings | Root cause | One-shot cure |
| --- | --- | --- | --- |
| **A · Line-ending not threaded** | H2 | `assembleMarkdownFile`'s dirty-FM branch hard-codes `\n` fences; only the clean path + `tagRewriter.reassemble` re-apply the file's eol. | Thread `eol` through `assembleMarkdownFile` and re-apply it on the dirty path. |
| **B · Reload doesn't re-stamp the drift baseline** | L13 ⚠️, L16 | `applyReloadFromDisk` / the reload prompt handlers never call `noteBaseline`, yet gateway **comments claim they do** — a future edit trusting the comment regresses to *real* silent clobber. | Re-stamp `fileBaselineRegistry` inside `applyReloadFromDisk` from the read it applied; correct the comments. Closes both. |
| **C · Dirty-writer entry never cleared** | M1 (+ verifier root cause) | `TextTile.flushPendingMarkdownWrite()` is **dead code**; `performWrite` never `markClean`s the writerId → `isDirty` pinned true → spurious external-edit prompts + sibling-view divergence. | Clear the per-writer dirty entry on successful write **and** on destroy. |
| **D · External-edit classifier fires spurious prompts** | M1, L13, L14, L15, L16 | Several entry paths see stale/null metadata or a stale baseline and route a non-conflict to `prompt-user`. | The B + C fixes remove most; L14/L15 close the rest by gating on `isBuilding` and unifying the self-write filter. |
| **E · Failure / preserved-data not surfaced honestly** | M4, M5, L1, L2, L3 | Catch/skip paths that log or fail-safe but don't tell the user (truncated sentinel, preserved tmp, wedged write, toast spam, session-long config pause). | Per-item: route through `reportError`/the toast aggregator; surface `preservedTmpPath`. |

**Recommendation:** Phases **1–3** before/at dogfooding (the loss + honesty tier). Phase **4** removes the day-to-day prompt noise a local-first + OneDrive user *will* hit — do it soon even though severity is low, because prompt-fatigue is the path to clicking through a real clobber. Phases **5–6** are post-dogfood hardening. Phase **7** (tests + 2 gates) runs **alongside** 1–4 so each fix closes its whole class.

### Effort key
**S** ≈ <1 h · **M** ≈ a few h · **L** ≈ a day+.

---

## Master findings table

`Vault?` = does it affect the user's current vault (a single **Mind Map** board, **Windows 11**, under **OneDrive**)? `—` = not on that path today.

| ID | Title | Sev | Cat | Phase | Primary file | Vault? |
| --- | --- | --- | --- | --- | --- | --- |
| **H1** | Kanban/Task field edit silently lost on quit/Ctrl+S (M4 pre-seed defers `execute` past `whenChainSettled`) | HIGH | data-loss | 1 | `lib/kanban/kanbanFrontmatterWriter.ts` | — (Kanban/Task only) |
| **H2** | Dirty-frontmatter writes drop CRLF → mixed file / whole-file LF flip | HIGH | corruption | 1 | `lib/editor/markdownSync.ts` | **Yes** (CRLF notes) |
| **H3** | Bulk "Keep all" on >5 externally-changed files never writes local edits | HIGH | data-loss | 1 | `stores/vaultExternalChanges.ts` | rare |
| **M1** | TextTile never clears its dirty-writer → `isDirty` stuck → spurious prompts + sibling divergence | MED | lifecycle | 2 | `components/tiles/TextTile.svelte` | **Yes** |
| **M2** | `tagRewriteSweep` clobbers a newer editor body flushed by its own inner drain | MED | data-loss | 2 | `lib/vault/tagRewriteSweep.ts` | tag-rename-while-typing |
| **M3** | `MoveCardsCommand.undo` restores multi-card moves to stale absolute positions | MED | undo-redo | 2 | `commands/kanbanCommands.ts` | — (Kanban only) |
| **M4** | Zero-byte `.filo/.dirty` sentinel detected as crash but swallowed (no modal/toast) | MED | recovery | 3 | `stores/vault.svelte.ts` + `lib/vault/dirtyFlagRecovery.ts` | crash-only |
| **M5** | Write-error toast hides the preserved emergency-tmp location on ENOSPC/EIO | MED | silent-err | 3 | `App.svelte` + `vault/filenameUtils.ts` | OneDrive near-full |
| **L1** | Save indicator shows "saving" (not "error") for a wedged-then-failed write | LOW | silent-err | 3 | `stores/saveState.svelte.ts` | rare |
| **L2** | Board/config/misc write failures bypass the errorBus aggregator → toast spam | LOW | silent-err | 3 | `App.svelte` | rare |
| **L3** | Transient `config:load-all` failure pauses ALL config writes for the session | LOW | silent-err | 3 | `lib/vault/vaultCandidate.ts` | possible (OneDrive lock) |
| **L13** ⚠️ | `applyReloadFromDisk` never re-stamps the drift baseline; comments claim it does | LOW | silent-err | 4 | `stores/document.svelte.ts` + `lib/vault/markdownFileWriter.ts` | **Yes** |
| **L16** | `promptExternalEditOnSync` Reload drops the write without refreshing the baseline | LOW | undo-redo | 4 | `lib/vault/markdownFileWriter.ts` + `stores/vaultExternalChanges.ts` | **Yes** |
| **L14** | Post-commit index rebuild `clear()`s before its async reads → `previousMetadata=null` | LOW | state | 4 | `stores/vaultIndex.svelte.ts` | possible |
| **L15** | Partial-read-retry timer bypasses the recent-self-write filter | LOW | silent-err | 4 | `stores/vaultExternalChanges.ts` | rare |
| **L17** | External-rename cascade sentinel only written on tag-flush failure; swap-mid-cascade leaves board refs un-flushed | LOW | recovery | 4 | `stores/vaultExternalChanges.ts` | very rare |
| **L6** | `originalFrontmatterCache` never cleared on vault swap | LOW | lifecycle | 5 | `stores/document.svelte.ts` | **Yes** (minor leak) |
| **L12** | `writeScheduler` `failures` Set retains fire-and-forget ids until reset | LOW | lifecycle | 5 | `lib/boards/writeScheduler.ts` | rare |
| **L18** | `boardScope.activeScopeRef` not reset on swap → facades resolve to dead pane scope | LOW | lifecycle | 5 | `lib/boards/boardScope.svelte.ts` | **Yes** (transient) |
| **L5** | Post-write baseline re-stat TOCTOU stamps an external edit's mtime/size | LOW | write-race | 5 | `lib/vault/markdownFileWriter.ts` | rare race |
| **L7** | `vault:write-existing-file-text` can resurrect a file deleted in the stat→rename gap | LOW | write-race | 5 | `main/ipc/vault.ipc.ts` | rare race |
| **L11** | `configWriteScheduler` re-stat guard misses delete-then-recreate-with-same-size | LOW | write-race | 5 | `lib/boards/configWriteScheduler.ts` | possible (OneDrive) |
| **L8** | `fmValueEqual` order-sensitive `JSON.stringify` → spurious conflict skips an undo | LOW | silent-err | 6 | `commands/frontmatterRebase.ts` | object/array FM only |
| **L10** | `UpdateBoardSettingsCommand` redo/undo silently no-ops when target board cache is gone | LOW | silent-err | 6 | `commands/groupAndBoardCommands.ts` | — (cross-board) |
| **L9** | `persistAddKanbanPlacement` splices at an unclamped position (defensive only; schema blocks it) | LOW | state | 6 | `stores/boardCacheKanban.ts` | — (schema-gated) |
| **L4** | CST engine relocates a deleted key's leading comment to the next key | LOW | corruption | 6 | `lib/vault/frontmatterCstModel.ts` | **Yes** (cosmetic) |

---

## Phase overview

| Phase | Theme | Gate to dogfooding? | Effort |
| --- | --- | --- | --- |
| **1** | HIGH — data loss & corruption | ✅ **Blocker** | M |
| **2** | MEDIUM — note-body loss, dirty-writer root cause, undo corruption | ✅ Recommended pre-dogfood | M |
| **3** | MEDIUM + related LOW — recovery & error honesty | ✅ Recommended pre-dogfood | M |
| **4** | LOW — external-edit reconciliation cluster (the 5/10 area) | Soon (L13 comment **now**) | M |
| **5** | LOW — lifecycle leaks & TOCTOU hardening | Post-dogfood OK | M |
| **6** | LOW — state/undo edge cases, formatting, docs | Post-dogfood OK | S |
| **7** | Class-closing tests & 2 new CI gates (anti-regression) | Do **alongside** 1–4 | M |

After every phase: run `npm run ci:verify` (lint → check → test:unit:strict → build → 34 guards) and confirm green before moving on. Bump `scripts/check-file-sizes.mjs` ceilings only when a fix legitimately grows an allowlisted file.

---

## Phase 1 — HIGH (dogfood blockers)

### H1 · Kanban/Task field edit silently lost on quit/Ctrl+S
- **Files:** `src/renderer/lib/kanban/kanbanFrontmatterWriter.ts` `updateTileFrontmatter` (L86–127: `await seedDocumentFrontmatterFromDisk` @L98 **before** `historyStore.execute(...)` @L116); twin in `src/renderer/lib/tasklist/frontmatterWriter.ts` `updateRowField`/`preSeedRow`/`setNotesBody`/`markAllIncomplete` (seed @L140 before execute @L143); also `src/renderer/lib/kanban/kanbanMultiSelect.svelte.ts` @L176.
- **Mechanism:** Audit-6 M4 made these setters `async` and inserted an IPC disk read (`seedDocumentFrontmatterFromDisk`) **before** `historyStore.execute()`. Only `execute()` enqueues onto `pendingChain` and schedules the FM disk write. `vaultStore.save()` (`vault.svelte.ts:1178`) and the quit path `await historyStore.whenChainSettled()` first — but that only drains commands *already on the chain*. If Ctrl+S/quit lands during the seed-await window, the chain is empty, all flushers find nothing, `save()` returns `true` → false "Saved" / `app:ready-to-quit` → renderer destroyed before the write fires. Because the vault was clean at edit time, **no `.filo/.dirty` was written → no recovery prompt next launch.**
- **Trigger:** On a Kanban/Task board, change a card's priority / due-date / completed (a card whose `.md` has no open editor and whose FM cache is cold), then within the disk-read window press Ctrl+S or quit. Window widens under OneDrive/AV latency. Narrowed to the **first** such edit per card/row per session (cache warms after).
- **Touches your vault:** No — `seedDocumentFrontmatterFromDisk` has no Mind Map / TextTile / Properties caller (verified: only the three Kanban/Task writers call it). **But this is a silent-loss blocker the moment you add a Kanban or Task board.**
- **Fix (M):** Hoist the disk read **into** the command so it's part of the chained body `whenChainSettled()` awaits. Move `seedDocumentFrontmatterFromDisk(...)` inside `UpdateCardFieldCommand.execute()` / `UpdateTaskFieldCommand.execute()` (await it before mutating), so the command is on `pendingChain` for the whole disk read. Alternative (smaller, weaker): enqueue a placeholder onto `pendingChain` before the seed await. Prefer the hoist — it makes the await structurally part of the drain.
- **Test:** unit — drive "edit field → immediately call `vaultStore.save()`" with an artificially-delayed `readMarkdownForHydrate`; assert `save()` does **not** resolve until the field write is scheduled, and the FM write lands. Pin that `whenChainSettled()` covers an in-flight seed.

### H2 · Dirty-frontmatter writes drop the file's CRLF line endings
- **File:** `src/renderer/lib/editor/markdownSync.ts` `assembleMarkdownFile` — the `objectHasKeys` branch (L395–411): `return ` + "`${bomPrefix}---\\n${yamlText}\\n---\\n${body}${trailing}`" (hard-coded `\n`, no eol). Confirmed at `markdownSync.ts:411`.
- **Mechanism:** `patchFrontmatterSourceCst` normalizes to LF (`frontmatterCstModel.ts:179`) and its docstring says "the caller re-applies the file's line ending" — but the caller doesn't. The clean body-only path `emitWithRawFrontmatter` (L391–392) *does* detect+re-apply CRLF, and `tagRewriter.reassemble` re-applies eol — only this dirty-FM branch emits unconditional LF. PropertiesPopup sources `body` from `diskBody` verbatim (`propertiesCommands.ts:207-208`) → CRLF file + LF frontmatter = **permanently mixed** file. An editor edit that also dirties FM → tiptap body is LF → **whole-file CRLF→LF flip.**
- **Trigger:** On Windows, open a CRLF `.md`, then (a) change/add a field via Properties popup, or (b) edit frontmatter via the editor → next debounced write rewrites the FM block as LF. No content lost — byte-level alteration + git/merge churn on every metadata edit.
- **Touches your vault:** **Yes, conditionally.** Filo-authored notes are LF and immune (LF→LF is a no-op). Any note that *arrived* as CRLF (imported / authored in a CRLF editor) flips on its first tag/property edit.
- **Fix (M):** Thread the file's eol into `assembleMarkdownFile` and re-apply it to the FM block + fences + body trailing on the dirty path, mirroring `tagRewriter.reassemble`. Derive eol from `options.rawFrontmatter`/`options.originalFrontmatter` the same way `emitWithRawFrontmatter` does, **or** add an explicit `eol` option that the gateway sets from `parsed` at hydrate time. Pseudocode:
  ```ts
  const eol = detectEol(options.rawFrontmatter ?? body); // '\r\n' | '\n'
  const fm = `---\n${yamlText}\n---\n`.replace(/\n/g, eol);
  return `${bomPrefix}${fm}${body}${body.endsWith(eol) ? '' : eol}`;
  ```
  (Keep `body` as-is — only normalize the parts *this* function emits; the body already carries its own endings from tiptap/diskBody.)
- **Test:** add CRLF×dirty-FM cases to `assembleMarkdownEngine.test.ts` (currently LF-only): (1) CRLF file + Properties-style dirty FM → assert the **whole** output is CRLF and the body is byte-identical; (2) CRLF file + editor (LF) body + dirty FM → assert the chosen policy is consistent (recommend: re-apply the *original file's* eol to the FM/fences, leave body as the editor produced it, and document the body-eol policy). See Phase 7 for the eol-preservation gate.

### H3 · Bulk "Keep all" on >5 externally-changed files never writes local edits
- **File:** `src/renderer/stores/vaultExternalChanges.ts` `promptBulkExternalChanges` "Keep all" handler (L877–897).
- **Mechanism:** the handler does `documentStore.markDirty(docId)` per modified doc then `void flushAllMarkdownWrites()`. `markDirty` (`document.svelte.ts:612`) only flips `isDirty` + registers a dirty-writer — it arms **no** gateway timer (editors arm `scheduleMarkdownWrite` only from TipTap `onUpdate`). `flushAllMarkdownWrites` = `writerScheduler.flushAll()`, which drains only `pending` timers + `inFlight` — it never iterates `forceWriters`. So for any doc whose debounce already fired during the prompt window, **nothing is armed and the drain is a no-op**; disk keeps the external content after the user chose "keep mine." Worse on Keep-all-then-swap/quit: `save()` also uses `flushAllMarkdownWriters` (not force-writers), then `pre-swap` `cancelAllMarkdownWrites()` clears hydrate state so the editors' `onDestroy` flush no-ops → **edits lost entirely.**
- **Trigger:** open ≥6 `.md` as tiles/editors, edit each unsaved, externally rewrite all 6 (git checkout / OneDrive / rsync) → aggregate "N files changed" toast → "Keep all". Edits expected on disk; nothing written.
- **Touches your vault:** rare near-term (needs 6+ simultaneously-edited-and-externally-rewritten files); OneDrive sync conflicts raise the odds.
- **Fix (S):** mirror the single-file path — in the bulk handler, for each modified prompt call `void forceWriteForDocument(p.editorDoc.docId)` (which reads the live editor body and commits through the canonical pipeline even with no armed debounce) instead of `markDirty` + `flushAllMarkdownWrites`.
- **Test:** unit — simulate the bulk handler with a doc whose debounce has already fired (no armed timer); assert "Keep all" writes the live editor body to disk for every modified doc.

---

## Phase 2 — MEDIUM (note-body loss + dirty-writer root cause + undo)

### M1 · TextTile never clears its dirty-writer entry → `isDirty` stuck true (root cause: dead code)
- **Files:** `src/renderer/components/tiles/TextTile.svelte` — `flushPendingMarkdownWrite` (L138–143, calls `documentStore.markClean(contentId, callerId)` @L142) is **defined but never invoked**; `onUpdate` arms only `scheduleMarkdownWrite` (L187); `onDestroy` uses `flushFinalWriteOnDestroy` (L460) which never `markClean`s. The scheduler's `performWrite` also never `markClean`s.
- **Mechanism:** `documentStore.dirtyWriters: Map<docId, Set<writerId>>` keeps `DocumentState.isDirty` true while any writerId remains (`document.svelte.ts:72, 578-602`). A TextTile registers its `callerId` on every keystroke and never removes it (only `applyReloadFromDisk`/`unloadDocument`/`clear`/vault-swap/`syncTileMarkdown(docId)` clear it). With `isDirty` pinned true: (a) the external-edit classifier (`vaultExternalChanges.ts:116`; `conflictResolver.ts:137`) routes a now-clean file's external edit to `prompt-user` → **spurious "modified externally" toast**; (b) the reactive reload `$effect` (L396, gated on `isWriterDirty`) never picks up a sibling DocumentEditor's edits → **two-view divergence**. `DocumentEditor.onDestroy` does **not** have this bug (its `flushPendingMarkdownWrite` `markClean`s with no destroyed-guard).
- **Trigger:** edit a Text tile, switch its pane to another board so it unmounts, then edit the `.md` externally → false Reload/Keep-local prompt though no live editor is dirty.
- **Touches your vault:** **Yes.** A OneDrive/Obsidian/git-pull external edit on a file you typed into earlier will nag with false prompts.
- **Fix (M):** two parts, fixing the root cause not just the symptom —
  1. Make a **successful debounced write** clear the writerId: have the gateway's success path (or `TextTile`'s post-write callback) call a writerId-scoped clear so a normally-saved tile goes clean. (`DocumentEditor` already does this via `flushPendingMarkdownWrite`.)
  2. On `onDestroy`, capture `contentId` at the top and drop this writer from the doc's dirty set even though `destroyed` is true (a `documentStore.dropDirtyWriter(contentId, callerId)` keyed by the captured id, so it's safe against a rebound `contentId`).
  Delete or wire up the dead `flushPendingMarkdownWrite`.
- **Test:** unit — keystroke into a TextTile writer, run a successful gateway write, assert `isWriterDirty(docId, callerId) === false` and `DocumentState.isDirty === false`; separately, unmount with a pending write and assert the writerId is gone afterward.

### M2 · `tagRewriteSweep` clobbers a newer editor body flushed by its own inner drain
- **File:** `src/renderer/lib/vault/tagRewriteSweep.ts` `runSweep` — Phase-1 read builds `plan[].nextContent` (L157); commit loop wrapped in `withDrainedWrites` (L239); write at L263 (`writeMarkdownAndReconcile({content: item.nextContent, mode:'full'})`). Caller `fileTags.svelte.ts` `renameTagEverywhere` drains up-front (L942-943).
- **Mechanism:** Phase 1 computes `nextContent = rewrite(oldBytes)` *before* the commit loop. The commit loop's `withDrainedWrites` calls `flushAllMarkdownWriters` → flushes any armed editor body (the **live** edited body) to disk; then L263 overwrites it with the **stale** `nextContent`, and the `mode:'full'` reconcile reloads the editor to the stale body too. The up-front drain closes the common case, but a keystroke landing after that drain and before this file's Phase-1 read re-arms a debounce; the inner drain then lands it only for L263 to clobber it. The dev comment at L226-228 already admits this.
- **Trigger:** open a `.md` carrying tag #X in an editor; vault-wide rename/remove #X; within the Phase-1 scan window (seconds on a large vault) type one more character → that keystroke is lost.
- **Touches your vault:** only if you do a vault-wide tag rename while actively typing in an affected file.
- **Fix (M):** make `nextContent` reflect the drained body — either move the Phase-1 read **inside** `withDrainedWrites`, or re-read+re-apply the tag rewrite per file inside the commit loop just before writing, or route each file through `runSerializedMarkdownWrite(path, read-modify-write)` like the single-tag fast path.
- **Test:** unit — arm an editor body write, run the sweep with the read snapshotted before the drain; assert the final disk bytes contain the live keystroke (tag-rewritten), not the pre-drain content.

### M3 · `MoveCardsCommand.undo` restores multi-card moves to stale absolute positions
- **File:** `src/renderer/commands/kanbanCommands.ts` `MoveCardsCommand.undo` (L307–315); contrast single-card `MoveCardCommand` 6.4.M16 anchors (L199-200, L225, L252).
- **Mechanism:** `undo()` calls `moveKanbanPlacement(boardId, tileId, fromColumnId, fromPosition)` with **no** `beforeTileId` anchor. `moveKanbanPlacement` (`boardCacheKanban.ts:471-474`) then falls back to `Math.min(Math.max(targetPosition,0), len)` against the **live** column. If a card was added/removed in a source column between the multi-move and the undo, restored cards land at wrong indices. The roundtrip-coverage gate doesn't catch it (no intervening mutation in a plain round-trip).
- **Trigger:** multi-select 2+ cards across columns → drag to a new column → add/delete a card in a source column → Ctrl+Z → cards return scrambled.
- **Touches your vault:** No — Kanban only.
- **Fix (M):** capture per-card neighbour anchors at construction (the tileId each card should sit before in its source column, computed with the moved set removed — mirror `moveKanbanPlacement`'s remove-then-insert), thread them on undo; **or** restore via a full before/after column slice like `MoveTaskBlockCommand`.
- **Test:** construct → execute → mutate a source column → undo → assert each card's index; add to `kanbanStructureCommandsRoundTrip` with the intervening-mutation variant.

---

## Phase 3 — MEDIUM + related LOW (recovery & error honesty)

### M4 · Zero-byte `.filo/.dirty` sentinel detected as a crash but swallowed
- **Files:** `src/renderer/stores/vault.svelte.ts:592` (openVault recovery gate) + `src/renderer/lib/vault/dirtyFlagRecovery.ts:218-227` (`if (!content)` branch).
- **Mechanism:** `checkRecovery` returns `{ needsRecovery: true, reason: 'sentinel-unreadable' }` for both the EACCES branch (L201, which **does** `reportError` → toast) and the zero-byte branch (L218, which calls **no** `reportError`). openVault gates the recovery UI on `needsRecovery && reason !== 'sentinel-unreadable'` (L592) → the truncated-sentinel case (the strongest mid-write-crash signal, the exact case 6.4.M5 added) reaches **neither** modal nor toast.
- **Severity note:** partially-confirmed, **medium** not high — `markClean` deletes the sentinel regardless of content, so it clears on the first edit or vault close (not "forever" as first claimed). No data corruption; defeated recovery affordance.
- **Touches your vault:** only after a real crash/power-loss that truncates the sentinel.
- **Fix (S):** emit a `reportError` in the zero-byte branch too (mirroring L201) so it routes through the same errorBus toast — no sequencer change needed. Or handle `reason === 'sentinel-unreadable'` explicitly in openVault with its own toast + `onDismiss → markClean`.
- **Test:** extend `dirtyFlagRecovery.test.ts` — the empty-content case should assert a toast fires (today it asserts only the reason; the EACCES test at L105 already asserts the toast).

### M5 · Write-error toast hides the preserved emergency-tmp location
- **Files:** `src/renderer/App.svelte` `setBoardWriteErrorListener` (L34–43) vs `src/main/vault/filenameUtils.ts` (L252-263) + `emergencyFileRegistry.ts` + `quitFailureBreadcrumb.ts`.
- **Mechanism:** on ENOSPC/EIO/ENOMEM/EACCES after the tmp is fully written+fsynced, `atomicWriteFile` PRESERVES the tmp, sets `err.preservedTmpPath` (L254), appends `(data preserved at <tmpPath>)` to `err.message` (L257), and records into `emergencyFileRegistry` (L263). But the renderer listener **ignores `info.error`** and emits a hardcoded "Your changes are not on disk yet…" — factually wrong (the bytes are on disk at the tmp) and names no path. The location only surfaces via the *quit* breadcrumb (`.filo/quit-failure.json`), so a mid-session recovery (free space, keep editing) never sees it; the sidebar hides `*.tmp` (`fileOps.ts:113`).
- **Touches your vault:** plausible — OneDrive near-full volume → ENOSPC.
- **Fix (M):** when `info.error` carries `preservedTmpPath` (or its message contains `data preserved at`), surface that location in the toast as the quit breadcrumb does. Plumb `preservedTmpPath` as an explicit envelope field on `vault:write-existing-file-text`/`vault:write-file-text` failure into `WriteErrorInfo` (today it rides only inside `String(err)`).
- **Test:** unit — a write-error envelope carrying `preservedTmpPath` produces a toast whose text includes the path.

### L1 · Save indicator shows "saving" (not "error") for a wedged-then-failed write
- **File:** `src/renderer/stores/saveState.svelte.ts` `setStatus` (L44-52) vs `lib/boards/writeScheduler.ts` (L401-408, WRITE_TIMEOUT → `markPathFailed`).
- **Mechanism:** the gateway races each write against `writeTimeoutMs` (60s). On timeout, `markPathFailed` populates `failedVaultPaths` and `save()` returns false — but `writeMarkdownFile`'s `trackComponentWrite` still holds its inflight increment (the real IPC hasn't settled). `setStatus` checks `if (inflight > 0 || pending > 0) state='saving'` **before** `if (failed > 0) state='error'`, so a genuinely-wedged IPC shows a perpetual "saving" spinner.
- **Touches your vault:** rare (a >60s wedged write — AV / network-share hang).
- **Fix (S):** in `setStatus`, surface `'error'` when `failed > 0` even if `inflight > 0` (or add a `'saving-with-errors'` state). The failed-paths popover + dirty sentinel are already correct; this is at-a-glance honesty only.
- **Test:** unit — `setStatus({inflight:1, failed:1})` yields `'error'`.

### L2 · Board/config/misc write failures bypass the errorBus aggregator
- **File:** `src/renderer/App.svelte` `setBoardWriteErrorListener` (L34-43) vs the errorBus aggregator wiring (L65-70).
- **Mechanism:** `errorToastAggregator` coalesces same-context failures into one count-badged toast, but it's wired only onto `errorBus`. `boardWriteScheduler`/`configWriteScheduler`/`miscWriteScheduler` call `notifyWriteError` per-failure with `duration:0` and no coalescing → a multi-board failure (e.g. many dirty `.board.json` on a full disk) emits one persistent toast **per** target. (The tag sweep itself already routes through `trackComponentWrite` with `notifyOnError:false`, so it's protected — the exposure is the board/config/misc paths.)
- **Touches your vault:** rare (multi-target write failure).
- **Fix (M):** route the `setBoardWriteErrorListener` path through the same aggregator (keyed by `kind+path` or `kind`), or give it its own coalescing window.
- **Test:** unit — N rapid board-write failures produce one coalesced toast.

### L3 · Transient `config:load-all` failure pauses ALL config writes for the session
- **File:** `src/renderer/lib/vault/vaultCandidate.ts` `loadVaultCandidate` (L204-222) → consumed by `configWriteScheduler.writeConfigs` (L259, `corruptConfigTargets.has → continue`).
- **Mechanism:** on a whole-`.filo/` read reject, `board.ipc.ts:345` tags the bag `__loadAllFailed`; `loadVaultCandidate` then marks **every** config target corrupt so `writeConfigs` skips them. `corruptConfigTargets` clears only on vault swap or the corrupt-config modal's "Use defaults" — which `__loadAllFailed` never shows (only a passive warning toast). So a transient OneDrive/AV lock at vault-open pauses all `.filo/` config writes (theme, defaults, workspace, sidebar, viewports, hotkeys) for the whole session.
- **Severity note:** partially-confirmed low — the deliberate fail-safe direction, a *persistent* warning toast is shown ("reopen the vault to retry"), no on-disk corruption.
- **Touches your vault:** possible — a OneDrive lock at the instant of vault open.
- **Fix (M):** on `__loadAllFailed`, schedule a bounded background re-stat/re-read that clears `corruptConfigTargets` once `.filo/` becomes readable; or show a modal with a "Retry read" action.
- **Test:** unit — `__loadAllFailed` then a successful re-read clears the corrupt targets and resumes writes.

---

## Phase 4 — LOW (external-edit reconciliation cluster — the 5/10 area)

> ⚠️ **Do L13's comment correction NOW, even before the rest of this phase.** The code is fail-safe today (it prompts), but `markdownFileWriter.ts:531-536` *asserts the baseline was re-stamped on reload* when it wasn't. A future change that trusts that comment and removes the re-prompt would convert this whole cluster into **real silent clobber.** Two-line comment fix is zero-risk; the full re-stamp fix below removes the duplicate prompts.

### L13 ⚠️ + L16 · Reload paths never re-stamp the drift baseline (shared root cause)
- **Files:** `src/renderer/stores/document.svelte.ts` `applyReloadFromDisk` (L733-772) — no `markHydrated`/`noteBaseline`; gateway early-return on `choice==='reload'` `markdownFileWriter.ts:531-536`; second reload entry `vaultExternalChanges.ts` `promptExternalEditOnSync` handler (L1404-1426).
- **Mechanism:** after an external-edit Reload, `applyReloadFromDisk` swaps body/FM and clears `isDirty` but never refreshes `fileBaselineRegistry`. The baseline stays at the pre-external-edit (mtime,size); the next keystroke's pre-write drift check compares the stale baseline against a fresh `vault:stat` (the external mtime, since disk still holds external bytes) → `hasBaselineDrifted` true → the prompt fires **again** for an edit already accepted. If the user picks Reload again, the write is dropped and the prompt recurs on **every** keystroke until a Keep-local write finally stamps a post-write baseline. `promptExternalEditOnSync`'s Reload handler has the same gap. The gateway comment claiming the baseline was re-stamped is inaccurate for **both** paths.
- **Touches your vault:** **Yes** — any external (OneDrive/Obsidian/git) edit you accept via Reload re-prompts on your next keystroke.
- **Fix (M):** thread the read's `mtimeMs`/`size` into `applyReloadFromDisk` and call `markHydrated(rel, hadBom, mtime, size)` / `noteBaseline` so the post-reload state is the new anchor. One fix here covers **all** reload call sites (L13 + L16). Then correct the gateway comments to match.
- **Test:** unit — open → external-edit → Reload → next keystroke does **not** re-trigger drift; assert `getBaseline(rel)` equals the reloaded read's (mtime,size).

### L14 · Post-commit index rebuild `clear()`s before its async reads
- **File:** `src/renderer/stores/vaultIndex.svelte.ts` `rebuild()` — `index.clear()` (L203) then awaited chunked reads.
- **Mechanism:** `runPostCommitTasks` fires `vault:watch` and `vaultIndexStore.rebuild` unordered. `rebuild` clears synchronously then awaits, so for the rebuild duration `getMetadata` returns null. A live watcher event in that window → `handleExternalMarkdownChanges` captures `previousByPath=null` → with a dirty editor, `classifyExternalChange` falls to `prompt-user`. (The "reconcile persists empty tags" sub-claim was **refuted** — `sync-frontmatter`/`reload-silently` require freshly-read `next`.) Severity low: transient spurious prompt; the watcher's initial `reconcileNow({seedOnly:true})` doesn't fire events on open.
- **Touches your vault:** possible on a large vault opening with a restored dirty editor + an external touch during the cold rebuild.
- **Fix (M):** gate `handleExternalMarkdownChanges` / batched reconcilers on `vaultIndexStore.isBuilding` / `whenBuildComplete()` (as the recovery sequencer already does), or build into a shadow index and swap atomically instead of `clear()`-then-fill.
- **Test:** unit — fire an external change while `isBuilding` is true; assert classification is deferred, not `prompt-user` with `previousMetadata=null`.

### L15 · Partial-read-retry timer bypasses the recent-self-write filter
- **File:** `src/renderer/stores/vaultExternalChanges.ts` `schedulePartialReadRetry` callback (L325-327, calls `handler([rel])` directly).
- **Mechanism:** the `document` batched reconciler filters `isRecentSelfWrite(p)` before calling `handleExternalMarkdownChanges`, but the retry timer re-invokes the handler **directly**, bypassing that filter. Blast radius is ~nil today (the gateway's post-write `restoreMetadata` already makes the index reflect self-written bytes, so a retry re-reads `prev≈next` → ignore) — a latent defense-asymmetry, not an active bug.
- **Fix (S):** move the `isRecentSelfWrite` guard **inside** `handleExternalMarkdownChanges` (single authority) so every entry path (bridge, retry timer, exhaustion-prompt Reload) is consistently self-write-filtered.
- **Test:** unit — a self-write during the retry window is not reclassified as external.

### L17 · External-rename cascade sentinel only written on tag-flush failure
- **File:** `src/renderer/stores/vaultExternalChanges.ts` `runExternalRenameCascade` (L572-674).
- **Mechanism:** after the synchronous tag rename + `flushPendingSave()`, a `captureVaultIdentity` re-check bails the cascade on a mid-flush vault swap (L587, correct — protects the NEW vault). But `propagateRename` (L550) already mutated the in-memory board cache before the bail; on swap that cache is discarded, the `.board.json` on disk keeps the OLD path, and the board-cascade sentinel write (L676-694) is past the bail → the OLD vault's board cascade is abandoned with no retry breadcrumb. Recoverable via broken-ref detection on load (flagged, not silent).
- **Severity note:** speculative/low; an extremely narrow sub-300ms swap landing in the post-flush/pre-sentinel window; also guarded by `enqueueRenameQueueWork`'s `captureVaultIdentity` and gen-keyed `withDrainedWrites`.
- **Fix (S):** write the rename-cascade sentinel **before** the post-tag-flush `isStillSameVault` bail (or before the tag-flush await), so a swap-interrupted cascade still leaves a retry breadcrumb for the outgoing vault.
- **Test:** unit — simulate a swap during `flushPendingSave`; assert a rename-cascade sentinel exists for the outgoing vault.

---

## Phase 5 — LOW (lifecycle leaks & TOCTOU hardening)

### L6 · `originalFrontmatterCache` never cleared on vault swap
- **File:** `src/renderer/stores/document.svelte.ts` `clear()` (L656-668) clears `frontmatterCache`/`rawFrontmatterCache`/`mutationVersions`/`readOnlyDocs` but **not** `originalFrontmatterCache` (declared L131).
- **Mechanism:** `clear()` is the registered pre-swap reset; the outgoing vault's disk-baseline FM sources persist unboundedly. Only comments/key-order could bleed on an astronomically-unlikely 12-char-nanoid docId collision — the engine always emits the live object's keys/values. Dominant cost is slow Map growth.
- **Touches your vault:** **Yes** (minor unbounded leak across swaps).
- **Fix (S):** add `originalFrontmatterCache.clear()` alongside the other clears at L660-662. One line; matches the per-doc `clearFrontmatter` cleanup.
- **Test:** unit — after `clear(nextVault)`, `getOriginalFrontmatterSource(anyDocId)` returns undefined.

### L12 · `writeScheduler` `failures` Set retains fire-and-forget ids
- **File:** `src/renderer/lib/boards/writeScheduler.ts` — `fireWrite` settle `failures.add(f)` (L458); `flush`/`flushAll` only delete failures for awaited in-flight entries (L611-615, L703-717).
- **Mechanism:** a debounced (fire-and-forget) write that fails and whose in-flight entry settled-and-was-removed before the next flush snapshots the bucket is in neither set → its failureId is never drained from `failures`. `endWrite(false)` still updates `failedVaultPaths` (crash recovery unaffected), and flushes never delete ids they didn't own (no false positives) → memory-only growth bounded by `reset()` on swap.
- **Fix (S):** prune `failures` on a later successful write to the same key, **or** have `flushAll` drain entries whose key has no live pending/in-flight entry. Or accept it and document `reset()` as the bound.
- **Test:** unit — a failing fire-and-forget write followed by a successful write to the same key leaves `failures` empty.

### L18 · `boardScope.activeScopeRef` not reset on vault swap
- **File:** `src/renderer/lib/boards/boardScope.svelte.ts` — `setActiveScope` (L92, only caller is `PaneView.svelte:61`, no return cleanup); no `onVaultSwap` reset.
- **Mechanism:** on swap, `workspace.reset()` unmounts every PaneView but `activeScopeRef`/`activeScopeRaw` retain the outgoing scope until the new vault's first PaneView `$effect` re-runs `setActiveScope`. Reads are null-safe (the dead scope's `currentBoardId` is absent from the new cache → `currentBoard` derives null), and the new PaneView mounts essentially synchronously — tiny window. A footgun for any future facade consumer that mutates during the swap window.
- **Touches your vault:** **Yes** (transient, every swap; harmless today).
- **Fix (S):** add `onVaultSwap('pre-swap', 'boardScope', …)` (or reset inside the workspace handler) that nulls `activeScopeRef`/`activeScopeRaw` so `getActiveScope()` rebuilds a fresh default for the new vault. Also reset on `closeVault`.
- **Test:** unit — after a simulated swap with no PaneView mounted, `getActiveScope()` returns a fresh scope, not the prior vault's.

### L5 · Post-write baseline re-stat TOCTOU
- **File:** `src/renderer/lib/vault/markdownFileWriter.ts` `writeMarkdownFileImpl` (L663-679) — write via `trackComponentWrite`, then a **separate** `vault:stat` (L675) feeds `refreshBaselineAfterWrite`.
- **Mechanism:** if an external edit lands between the write IPC resolving and the stat IPC resolving, `postStat` reflects the external (mtime,size) → the baseline is poisoned → the next write's drift check matches and silently overwrites the external edit. Bounded by the watcher reconcile pass (independent content hash) unless the next in-app write beats the watcher debounce.
- **Fix (M):** capture the post-write mtime/size from the **write itself** — have `vault:write-existing-file-text` return the renamed file's fstat (taken inside the same handler under the watcher-suppression window). Cheaper half: compare `postStat.size` against the written byte length and refuse to stamp a baseline whose size differs.
- **Test:** unit — inject an external (mtime,size) into the post-write stat; assert the baseline is not stamped to it (size-mismatch refusal) or that the write returns its own fstat.

### L7 · `vault:write-existing-file-text` can resurrect a file deleted in the stat→rename gap
- **File:** `src/main/ipc/vault.ipc.ts` handler (L766-777) — `fsPromises.stat` pre-check then `atomicWriteFile` (whose `fs.rename(tmp, dest)` creates `dest` unconditionally).
- **Mechanism:** the channel exists to stop a dirty editor's debounce resurrecting a just-deleted file, enforced only by the stat pre-check. A delete landing after the stat but before the rename recreates the file with stale editor bytes. Window is wider than "microseconds" — it spans the tmp write+fsync+close (ms, longer on SMB/cloud).
- **Fix (M):** for this existing-file channel, open the destination with `flags:'r+'` (ENOENT if absent) instead of staging tmp+rename, **or** thread an `expectExisting` flag into `atomicWriteFile` that re-checks existence immediately before the rename and aborts. Document the OS-limited residual.
- **Test:** main-side — delete the dest after the stat, before the rename; assert the write aborts (ENOENT) rather than recreating.

### L11 · `configWriteScheduler` re-stat guard misses delete-then-recreate-same-size
- **File:** `src/renderer/lib/boards/configWriteScheduler.ts` `writeConfigs` ENOENT branch (L297-327, re-stat L306) then drift check L329.
- **Mechanism:** on the reappeared branch the code falls through to `hasBaselineDrifted(baseline=load-time, preWriteStat)`. A recreate with *different-length* content trips drift and aborts (good). The clobber survives only on a same-size + same-second-mtime recreate — the documented mtime+size (not hash) residual, now on `.filo/` configs. Confined to config files, recoverable by reopening.
- **Fix (M):** treat the reappeared file as potentially-foreign — re-base to the reappeared stat AND route through the drift/keep-local prompt before writing; or upgrade the baseline tuple to a content hash for configs.
- **Test:** unit — delete + recreate a config with same-size different content; assert the write does not silently clobber.

---

## Phase 6 — LOW (state/undo edge cases, formatting, docs)

### L8 · `fmValueEqual` order-sensitive `JSON.stringify` skips a legitimate undo
- **File:** `src/renderer/commands/frontmatterRebase.ts` `fmValueEqual` (L42-54, `JSON.stringify` branch L46-50); consumers `applyFrontmatterPatchRebased` (L105-107), `kanbanCommands.applyOrphanPatchRebased`.
- **Mechanism:** object/array FM values are compared by `JSON.stringify(a)===JSON.stringify(b)` (order-sensitive) despite a "structural comparison" docstring. An external reorder of an object/array-valued key reads as a conflict → the rebase keeps the external value, **skips the user's undo for that field**, and shows a misleading "kept external" toast. Scalars (`===`) unaffected. Practical vector is mainly **arrays** reordered by an alphabetizing external tool.
- **Fix (S):** replace the stringify branch with an order-independent deep-equal (or sort object keys before stringifying). One predicate covers both docId and orphan paths.
- **Test:** unit — `fmValueEqual({a:1,b:2}, {b:2,a:1})` and `fmValueEqual(['x','y'], …)` per chosen array policy → true where structurally equal.

### L10 · `UpdateBoardSettingsCommand` redo/undo silently no-ops on a missing target
- **File:** `src/renderer/commands/groupAndBoardCommands.ts` `UpdateBoardSettingsCommand.applyToTarget` (L612-619, `if (!cached) return;`).
- **Mechanism:** bare early-return vs the Move* commands' "Cannot undo — board was deleted" toast. The finder's main premise was **refuted** (`deleteBoard` *does* `clearBoard`); the only residual is the cross-board stack corner (undo stacks file by global active board, so a command targeting board X can sit on board Y's stack; `clearBoard(X)` doesn't clear Y's).
- **Fix (S):** mirror Move* — `uiStore.toast('Cannot apply — the board was deleted', 'warning')` instead of a bare return.
- **Test:** unit — apply with `!cached`; assert a toast fires.

### L9 · `persistAddKanbanPlacement` splices at an unclamped position (defensive only)
- **File:** `src/renderer/stores/boardCacheKanban.ts` `persistAddKanbanPlacement` (L358, `splice(Math.min(position, len), 0, …)`).
- **Mechanism:** clamps the high end only; a negative position would splice from the end. The TaskList sibling clamps both. **Effectively a non-issue today** — `KanbanTilePlacementSchema.position` is `z.number().int().nonnegative()` (`placement.ts:98`), so a negative position can't survive load, and every in-code caller passes ≥0. Pure defensive symmetry.
- **Fix (S):** clamp both ends: `const insertAt = Math.min(Math.max(position, 0), placements.length); placements.splice(insertAt, 0, placement);`
- **Test:** unit — `persistAddKanbanPlacement(..., -1)` inserts at head, not tail.

### L4 · CST engine relocates a deleted key's leading comment to the next key
- **File:** `src/renderer/lib/vault/frontmatterCstModel.ts` `patchFrontmatterSourceCst` Pass-2 (L248-257 `pendingStart = pendingStart.concat(item.start)` on delete; relocate at L254-257 / L282-284).
- **Mechanism:** deleting a key concatenates its `start` tokens (leading blank lines **and** standalone comment) onto the next surviving key (or document end). A comment that documented the deleted key migrates to mis-document an unrelated key. Same trade-off family as KNOWN_LIMITATIONS #1 L23/L28, but the **delete-relocation** variant isn't documented there. Valid YAML, no value lost.
- **Touches your vault:** **Yes** (cosmetic) — clearing a commented property via Properties popup.
- **Fix (S) — choose one:** (a) when deleting a key, relocate only blank-line `SourceToken`s and **discard** comment tokens glued to the deleted key (no blank-line separation); or (b) accept it and document the delete-relocation case in `KNOWN_LIMITATIONS.md` #1 alongside L23/L28.
- **Test:** if fixing — corpus case in `frontmatterInvariant.test.ts`: delete a commented key, assert the comment does **not** reattach to the following key.

---

## Phase 7 — Class-closing tests & gates (run alongside Phases 1–4) — ✅ DONE 2026-06-03

The Audit-6 lesson: bugs slip through because gate **coverage** has holes, not because the architecture is wrong. Each fix above ships with a test; additionally add:

1. ✅ **eol-preservation gate / test (closes H2's class).** Extend `assembleMarkdownEngine.test.ts` (and consider a small `ci:*` assertion) with a matrix: {LF, CRLF} × {clean body-only, dirty-FM via Properties, dirty-FM via editor} × {BOM, no-BOM}. Assert the FM block + fences carry the file's original eol on every dirty path. This is the single most leak-prone formatting invariant the current LF-only suite never exercises. — **Test shipped with H2** (`assembleMarkdownEngine.test.ts` 8-case eol matrix). **Gate added**: `ci:eol-preservation` ([scripts/check-eol-preservation.mjs](scripts/check-eol-preservation.mjs)) — comment-stripped token-presence pinning `detectFrontmatterEol` + `.replace(/\n/g, eol)`; bite-verified against a regressed copy.
2. ✅ **baseline-stamp-on-reload test (closes B / L13+L16).** Every reload entry point (`applyReloadFromDisk`, `promptExternalEditOnSync` Reload, watcher-event Reload) must leave `fileBaselineRegistry` equal to the applied read's (mtime,size). One test per entry point; they'd all fail today. — **Shipped with Phase 4** (`audit7Phase4Reconciliation.test.ts` — `getBaseline` assertions per reload entry point).
3. ✅ **dirty-writer-cleared invariant (closes C / M1).** A successful gateway write and an `onDestroy` must both leave `dirtyWriters[docId]` without the writer's id. Add a TextTile-vs-DocumentEditor symmetry test (DocumentEditor passes today; TextTile fails). — **Shipped with M1**: gateway-write-clears half in `gatewayWriteClearsDirtyWriter.test.ts` (incl. the "clears only the writer that wrote" symmetry); `onDestroy`/`dropDirtyWriter` half in `documentDirtyPerWriter.test.ts`.
4. ✅ **Consider a `ci:no-dead-flush` lint** only if cheap: flag a defined-but-never-called `flush*` in a component (M1's root cause was dead code). Low priority — the invariant test in (3) already bites. — **Gate added** (it was cheap): `ci:no-dead-flush` ([scripts/check-no-dead-flush.mjs](scripts/check-no-dead-flush.mjs)) — walks `components/**.svelte`, flags any component-scope `function flush*` never referenced (script or markup); `// allow-dead-flush:` escape; bite-verified + false-positive-safe.

Keep `test:unit:strict` green (no `window.filo`-mock stderr noise) and re-run the full `ci:verify` (**36 gates**) after each phase.

---

## Appendix A — Refuted (do NOT fix)

These were investigated and **disproven** by the adversarial verifiers — fixing them would add risk for no benefit:

1. **`withDrainedWrites` re-entrancy double-drain** — refuted. `commitVaultCandidate` is synchronous, `closeVault` drains the outgoing vault before bumping the generation, and main-side `assertActiveVault` rejects any nested op targeting a swapped-away vault. No corruption path; every concrete-damage route is independently fenced by per-site `captureVaultIdentity`.
2. **Pruning toast/snapshot skipped for duplicate-only Kanban/TaskList placements** — withdrawn/refuted. `orphanReportHasFindings` (`boardLoader.ts:94-103`) includes `droppedKanbanDuplicates`/`droppedTaskListDuplicates`, so a duplicate-only prune still snapshots the original bytes before any rewrite.
3. **Edge-pan singleton dead-scope RAF leak on mid-draw unmount** — refuted. `MindMapBoard` applies `use:edgePanAction` unconditionally on its root; the action's `destroy()` calls `stopEdgePan()` (cancels the RAF, nulls the scope) synchronously on unmount regardless of draw state.

---

## Appendix B — Suggested execution order & "if you only do a little"

- **Minimum to dogfood a Mind Map vault safely:** H2 (CRLF) + L13 (the comment correction, even without the full re-stamp) + M1 (stop the false external-edit prompts). None is large.
- **Before adding any Kanban or Task board:** H1 (silent field-edit loss) and M3 (multi-card undo).
- **If you rely on git/OneDrive sync heavily:** prioritize Phase 4 in full (removes the prompt noise that erodes trust in the drift detector) + L11.
- **One-liners worth doing immediately:** L6 (`originalFrontmatterCache.clear()`), L1 (save-indicator ordering), the L13 comment correction.

**Provenance:** Audit-7, 2026-06-03 — 9-agent adversarial sweep (`audit-filo-data-integrity` workflow). 29 candidates → 26 confirmed/partial, 3 refuted. Full per-finding mechanism/trigger/blast-radius detail in the workflow result transcript. This plan deliberately does **not** rehash prior audits; every item is `not_already_in_audit2 = true` and targets the committed `HEAD = 6067e4d` state.

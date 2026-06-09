# Audit-15 Remediation Plan — 2026-06-08

**Branch:** `chore/electron-42`  ·  **Working tree:** uncommitted (Audit-7→14 + Electron-42 upgrade)  ·  **Platform:** win32

## Method

Fresh-eyes audit by 9 area-scoped agents reading the **actual working-tree source** (deliberately *not* the prior `AUDIT*_PLAN` docs / `KNOWN_LIMITATIONS.md` / memory — the goal was to find what those overlooked), plus an independent diff review of the riskiest recent changes and a full `ci:verify` run. Every MEDIUM was re-verified in code (marked ✅ below).

## Verdict

**No BLOCKER and no HIGH-severity issue in any area.** `ci:verify` is green (lint, svelte-check, 4332 unit pass / 1 skip, Electron-42 production build, 43 guards). The markdown/frontmatter write path — the only thing that loses real notes — is robust: the CST engine could not be made to lose a value through the delta-on-fresh-disk path across ~15 real-world frontmatter shapes. The worst confirmed issues are **5 MEDIUMs**; only **two touch data**, and both are narrow races backstopped by the `.filo/.dirty` crash-recovery sentinel (recover-on-next-launch, not guaranteed silent loss).

**Recommendation:** safe to dogf0od now on a real vault. Do **Phase 0** (runtime smoke) before trusting the *packaged* build, then **Phase 1** (the 5 MEDIUMs) soon. Phases 2–6 are quality/hardening and can land at leisure.

### Ratings (1–10 by area)

| Area | Rating | Worst |
|---|:--:|---|
| Architecture / leaks / perf | 9 | LOW |
| Electron-42 upgrade soundness | 9 | LOW (un-run packaged smoke) |
| Markdown / frontmatter write-path | 8.5 | MEDIUM |
| Board-cache & board-file integrity | 8.5 | MEDIUM |
| Vault lifecycle / swap / reconcile | 8.5 | LOW |
| Security / IPC / path safety | 8.5 | MEDIUM |
| UI/UX & accessibility | 8.5 | MEDIUM |
| Write schedulers / drain / quit | 8 | MEDIUM |
| Undo/redo & command correctness | 8 | LOW |

**Overall system ≈ 8.5/10. Data-integrity specifically ≈ 8/10.**

### Cross-cutting theme — the "sibling-parity" pattern

Almost every finding is the **same shape**: a hardened *primary* path received a fix that its lower-traffic *sibling* did not. This is now the dominant way bugs enter this codebase. Phase 6 adds gates so the class can't recur silently. The instances:

- `flush(key)` missed the `parked` check that `flushAll` + the drain loop got — **P1.1**
- `scanBoardFiles` matches `.board.json` case-sensitively while `fileOps`/`fileWatcher` case-fold — **P1.3**
- `vaultExternalChanges:1460` doesn't thread `rawFrontmatter` like its 6 sibling reload sites — **P2.1**
- `.board.json` self-write reconcile lacks the divergence tiebreak the `.md` path has — **P2.4**
- `UpdateCardFieldCommand` lacks the null-`docId` throw `UpdateTaskFieldCommand` has — **P2.6**
- Tab-rename / EmojiPicker / FileTile / SearchPanel each diverge from already-correct siblings — **P1.2, P4.x**

---

## Severity & effort legend

- **Severity:** BLOCKER › HIGH › MEDIUM › LOW. (None BLOCKER/HIGH.)
- **Effort:** S = <30 min · M = 0.5–2 h · L = multi-file / >2 h.
- **✅** = independently re-verified in code during the audit.
- *Each phase leaves working software (project rule #3). Run `npm run ci:verify` at every phase boundary.*

---

## Phase 0 — Runtime validation (no code; pre-dogfood)

The whole audit + `ci:verify` is **static** (you chose no app launch). These are the only places a runtime regression can still hide; do them on a **throwaway vault** before trusting the packaged build.

### P0.1 — Packaged-build runtime smoke — *effort M*
- **Why:** the Electron 33→42 jump is mechanically clean (already on `protocol.handle`, `registerSchemesAsPrivileged`, sandbox+contextIsolation; zero native modules; dependency-free asar), but none of the GUI/packaging paths were exercised headless.
- **Do:** `npm run package`, launch the artifact, and manually verify: `filo://` image **and** video load + **seek** (HTTP Range/206), iframe-tile CSP renders + blocks unsafe URLs, native open/save dialogs, **OS drag-drop** of a file onto a board, spellcheck, and a clean **quit while a write is pending** (confirm `.filo/.dirty` is cleared on graceful quit).
- **Done when:** all of the above work in the packaged app on Windows.

### P0.2 — Playwright E2E + kill-relaunch recovery — *effort M*
- **Why:** the undo agent flagged the async cross-board command machinery as the one thing it'd want E2E behind; the kill+relaunch recovery test is noted deferred in project memory.
- **Do:** run `npm run test:e2e`. Add/enable a **kill-mid-write → relaunch → assert Recovery modal lists the pending path** scenario (this is also the backstop that the Phase-1 write races rely on — prove it actually fires).
- **Done when:** E2E green on a real Electron binary + the kill-relaunch case passes.

### P0.3 — a11y axe scan — *effort S*
- **Do:** run the axe-core scan (CI runs it on push; run locally against the packaged/dev app). Confirm no new violations from the Audit-14 UI changes.

---

## Phase 1 — MEDIUM fixes (do before relying on it)

All 5 MEDIUMs. Two touch data (P1.1, P1.4); the rest are visibility / security / cosmetic-but-daily. None block dogfooding, but all are cheap relative to impact.

### P1.1 — `flush(key)` drops a parked write (false-"saved" on tab-close) — MEDIUM · *data* · ✅ · *effort S*
- **Where:** [src/renderer/lib/boards/writeScheduler.ts:791](src/renderer/lib/boards/writeScheduler.ts:791)
- **Root cause:** the Audit-14 1.1 "parked fires" change updated the `flush(key)` drain loop (checks `parked.get(key)?.size`) and `flushAll` (checks `anyParked()`), but **missed the `flush(key)` early-return**, which still only checks `pending` + `inFlight`:
  ```js
  if (!pendingEntry && (!initialBucket || initialBucket.size === 0)) return { ok: true };
  ```
  A debounce timer that fired behind an in-flight write registers a **parked** fire (in `parked`, not yet in `pending`/`inFlight`). In the microtask gap after the prior write settles but before the parked closure registers its `inFlight` entry, a single-key `flush` (tab-close: `flushBoardWrite`/`flushMarkdownWrite`/`flushMiscWrite`) sees both maps empty and returns `{ok:true}` **before the newest edit lands** → false success. (`.filo/.dirty` keeps it recoverable on a subsequent crash, so MEDIUM not HIGH.)
- **Fix:** bring the early-return into line with the loop + `flushAll`:
  ```js
  const parkedSet = parked.get(key);
  if (!pendingEntry && (!initialBucket || initialBucket.size === 0) && !(parkedSet && parkedSet.size > 0)) {
    return { ok: true };
  }
  ```
  Then ensure the existing drain loop runs (it already awaits parked). One line of real change.
- **Test:** extend [src/tests/unit/audit14Phase1.test.ts](src/tests/unit/audit14Phase1.test.ts) — drive the **empty-`inFlight`-but-parked** interleaving (prior write already settled+removed, parked closure not yet fired) and assert `flush(key)` awaits the parked write before resolving. Bite-verify: revert the fix → test red.

### P1.2 — SearchPanel undefined CSS variables (Replace toggle illegible in light themes) — MEDIUM · *cosmetic, daily-visible* · ✅ · *effort S*
- **Where:** [src/renderer/components/search/SearchPanel.svelte:447](src/renderer/components/search/SearchPanel.svelte:447), `:449`, `:480`, `:481`, `:482`; sibling [src/renderer/components/search/SearchFindAllPopup.svelte:257](src/renderer/components/search/SearchFindAllPopup.svelte:257)
- **Root cause:** references `--ui-accent` / `--ui-accent-text` / `--ui-surface-deep`, which are **defined nowhere** (verified: only `--accent-primary` exists, in all 5 themes + forced-colors at [src/css/style.css:179](src/css/style.css:179)). Line 480 `background: var(--ui-accent)` has no fallback → active Replace toggle has no accent fill; line 481 `color: var(--ui-accent-text, white)` falls back to white → white-on-near-white = invisible in light/sepia/forest themes.
- **Fix:** `--ui-accent` → `--accent-primary`; `--ui-accent-text` → `--text-inverse` (confirm token name in style.css; else `#fff` only on dark surfaces — but `--accent-primary` is dark enough that white text is correct); `--ui-surface-deep` → `--ui-surface`. Fix the same tokens in `SearchFindAllPopup.svelte:257` (currently fallback-masked but semantically wrong).
- **Test:** none required (CSS); optionally add a grep gate (see **P6.4**). Manually confirm the Replace toggle is legible in all 5 themes (covered by P0.1).

### P1.3 — `.board.json` case-fold gap: board silently invisible — MEDIUM · *visibility (data preserved)* · ✅ · *effort S*
- **Where:** [src/main/vault/boardFileOps.ts:111](src/main/vault/boardFileOps.ts:111) (`entry.name.endsWith(BOARD_EXTENSION)` — no lowercasing) and [src/main/services/fileWatcherClassify.ts:109](src/main/services/fileWatcherClassify.ts:109) (`relativePath.endsWith('.board.json')`). Siblings [src/main/vault/fileOps.ts:15](src/main/vault/fileOps.ts:15) and the watcher use `lower.endsWith(...)`.
- **Root cause:** `scanBoardFiles` is the authoritative enumerator behind `board:list`. On a case-insensitive FS, a board whose extension casing diverged (external tool / cloud sync) is excluded from the project at open with no toast. `classifyChange` likewise routes such a file to `tree` instead of `board`, skipping the board reconciler.
- **Fix:** case-fold both checks: `entry.name.toLowerCase().endsWith(BOARD_EXTENSION)` and `relativePath.toLowerCase().endsWith('.board.json')`. (Filo only ever *creates* lowercase, so this is purely robustness against external manipulation — but the siblings already do it.)
- **Test:** unit — `scanBoardFiles` over a fixture dir containing `Plan.Board.json` returns it; `classifyChange('My.BOARD.JSON')` → `board`. Gate in **P6.2**.

### P1.4 — Properties popup can write a stale body for a never-opened file — MEDIUM · *data (narrow)* · *effort M*
- **Where:** [src/renderer/components/tiles/PropertiesPopup.svelte:174](src/renderer/components/tiles/PropertiesPopup.svelte:174); gateway "N2" comment at [src/renderer/lib/vault/markdownFileWriter.ts:734](src/renderer/lib/vault/markdownFileWriter.ts:734)
- **Root cause:** for a file backing *only* a Kanban card / Mind-Map tile (never opened as a doc tab), the Properties write sources `body` from `vaultIndexStore.getMetadata(relPath)?.content` (the watcher snapshot) and the delta path deliberately keeps the caller's `body` (not `parsedFresh.body`, to protect a live open editor). The pre-write drift check is the guard — but if the watcher **entirely dropped** an external body edit (known-unreliable `fs.watch` on some volumes), the seeded baseline matches current stat and the stale index body overwrites disk.
- **Fix (options, pick one):**
  1. *Preferred, scoped:* when there is **no open `docState`** for the path (orphan/card-only), source the body from `parsedFresh.body` of the in-chain fresh read instead of the index snapshot. The "keep caller body" rule only exists to protect a live editor; with no live editor there's nothing to protect, and a field/FM delta never edits the body, so fresh-disk body is strictly safer.
  2. *Alternative:* re-read the file body in-chain at write time for the no-editor case and compare against the index snapshot; on mismatch, defer + prompt (reuse the drift prompt).
- **Test:** seed an index body, externally change the on-disk body *without* a watcher event, run a Properties field save on the (never-opened) file, assert the on-disk body is **not** reverted. Bite-verify against the current code (should fail pre-fix).

### P1.5 — No `setPermissionRequestHandler` / `setPermissionCheckHandler` — MEDIUM · *security (defense-in-depth)* · ✅ · *effort S*
- **Where:** [src/main/main.ts](src/main/main.ts) `app.whenReady` / `createWindow` (verified absent across `src/main`).
- **Root cause:** with CSP `frame-src https:` allowing arbitrary iframes, an embedded site can issue permission requests (geolocation, camera/mic, notifications, clipboard); Electron's defaults are version-dependent. The `allow-scripts allow-popups` sandbox (no `allow-same-origin`) bounds this, but the one standard Electron hardening control is missing.
- **Fix:** install a **deny-by-default** handler on `session.defaultSession` in `whenReady`:
  ```ts
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  ```
  Allowlist only what the app genuinely needs (likely nothing; spellcheck doesn't go through this). 
- **Test:** main-process unit asserting the handler is registered and returns `false` for a sample permission.

---

## Phase 2 — Data-path LOW parity (the sibling-parity sweep)

LOW-severity correctness items where a sibling missed a fix. None cause guaranteed loss today; all are regression magnets.

### P2.1 — Reload site doesn't thread `rawFrontmatter` (comment/format drift) — LOW · *effort S*
- **Where:** [src/renderer/stores/vaultExternalChanges.ts:1460](src/renderer/stores/vaultExternalChanges.ts:1460) (`promptPropertiesPopupModified` → Reload). Sibling sites at lines 297/1034/1212/1337/1398/1652 do thread it.
- **Root cause:** `setFrontmatter(docId, next.frontmatter)` with no `rawFrontmatter` → `originalFrontmatterCache` stays at the pre-external-edit source. A later body-only save diffs fresh FM against the stale baseline. **Values preserved**; only an external key's inline comment/quoting can be lost or re-appended out of place.
- **Fix:** pass `next.rawFrontmatter` (the read already has it; mirror the sibling calls).
- **Test:** add a row to the external-reload matrix asserting `originalFrontmatterCache` refreshes here too.

### P2.2 — Body-only save can drop a disk key when the FM cache is stale for a card never opened as a tab — LOW · *effort M*
- **Where:** body-only cache path [src/renderer/lib/vault/markdownFileWriter.ts:760](src/renderer/lib/vault/markdownFileWriter.ts:760)–862; seed skip at [src/renderer/lib/boards/seedFrontmatterFromDisk.ts:80](src/renderer/lib/boards/seedFrontmatterFromDisk.ts:80) (skips re-seed when *any* cache entry exists, even stale).
- **Root cause:** the one structural seam where the *display* cache is still the write source. An external editor adds a key to a card-only `.md`; cache isn't refreshed; a subsequent body-only save serializes from the stale cache and drops the key. (Field edits are safe — they use the delta path. Opening the file re-hydrates and fixes the cache.)
- **Fix:** in the body-only branch, when `!documentStore.hasFrontmatter(docId)` *or* the cache is known-stale, re-read FM from disk in-chain (the gateway already has the empty-cache re-read for `argsFmEmpty` — extend it to the stale-but-present case), or have the body-only path also apply an empty delta against fresh disk so untouched keys come from disk by construction.
- **Test:** stale-cache seam round-trip (mirror `writePathRemediationPhase4.test.ts`) for the body-only path.

### P2.3 — Truncated-read guard can false-positive on a body legitimately starting with `---` — LOW · *fail-safe* · ✅ · *effort S*
- **Where:** [src/renderer/lib/vault/markdownFileWriter.ts:711](src/renderer/lib/vault/markdownFileWriter.ts:711)–724 (Audit-14 3.3).
- **Root cause:** if a file previously had FM (`priorRawFm !== ''`) and an external edit removed the FM but left a leading `---` thematic break with no closing fence, the guard treats it as a partial read → `markPathFailed` + throw. Fails **safe** (loud, no data loss; next debounce retries), but turns a legit keep-local into a spurious "save failed".
- **Fix (optional):** tighten the heuristic — also require the fresh read length to be implausibly short vs the index `rawByteSize`, or confirm there's genuinely no second `---` anywhere in the read before refusing. Low priority given fail-safe direction.
- **Test:** add the leading-`---`-no-closing-fence case to the gateway matrix; assert chosen behavior.

### P2.4 — `.board.json` self-write reconcile lacks the divergence tiebreak — LOW · *effort S*
- **Where:** [src/renderer/stores/vaultExternalReconcilers.ts:86](src/renderer/stores/vaultExternalReconcilers.ts:86) (`if (isRecentSelfWrite(rel)) return;`). The `.md` path got `selfWriteDivergedFromBaseline` (Audit-13 M4) at [src/renderer/stores/vaultExternalChanges.ts:103](src/renderer/stores/vaultExternalChanges.ts:103)–148.
- **Root cause:** a `.board.json` externally edited inside the ~1.5–5 s self-write suppression window is dropped from the *proactive* reconcile. Backstopped by the board-write drift check + the 30 s reconcile pass, so not loss — just a missed proactive reload.
- **Fix:** mirror the `.md` divergence tiebreak — if the changed file's baseline diverged from the last self-write, treat as a real external edit even inside the window.
- **Test:** external `.board.json` edit inside the self-write window → reconcile fires.

### P2.5 — `hasPending(predicate)` ignores `parked` + `inFlight` (latent footgun) — LOW · *smell* · *effort S*
- **Where:** [src/renderer/lib/boards/writeScheduler.ts:1082](src/renderer/lib/boards/writeScheduler.ts:1082) (iterates only `pending`). Used by the gateway's post-write `markClean` guard ([src/renderer/lib/vault/markdownFileWriter.ts:943](src/renderer/lib/vault/markdownFileWriter.ts:943)) and the `isPathPending` probe (`:216`).
- **Root cause:** both current callers stay correct only because the **sentinel ledger** (`pendingVaultPaths`) independently keeps a parked/in-flight path "pending". But `hasPending` not covering parked is a trap for any future durability-relying caller.
- **Fix:** include `parked` and `inFlight` in `hasPending` (or rename it `hasPendingTimer` and document that durability checks must use the sentinel ledger).
- **Test:** assert `hasPending` returns true while a write is parked/in-flight.

### P2.6 — `UpdateCardFieldCommand` has no null-`docId` guard (dead, but regression magnet) — LOW · *effort S*
- **Where:** [src/renderer/commands/kanbanCommands.ts:597](src/renderer/commands/kanbanCommands.ts:597)–619 (keeps a dead null-docId branch that schedules a no-delta write). `UpdateTaskFieldCommand` throws ([src/renderer/commands/taskCommands.ts:421](src/renderer/commands/taskCommands.ts:421)).
- **Root cause:** both production constructors only build it with a non-null `docId` (else route to `UpdateOrphanFrontmatterCommand`), so it's dead today — but a future caller passing null gets silent loss with no loud failure.
- **Fix:** throw on null `docId` in the constructor (mirror the task command); delete the dead branch.
- **Test:** constructing with null `docId` throws.

### P2.7 — `renameBoardPath` descendant-slice length assumption is fragile — LOW · *latent* · *effort S*
- **Where:** [src/renderer/stores/boardCache.svelte.ts:403](src/renderer/stores/boardCache.svelte.ts:403)–416.
- **Root cause:** `norm.slice(oldPrefix.length)` mixes a case-preserving `normalizePath` prefix with a case-folded match; only safe because board paths carry no leading slash. A caller passing a leading-slash `oldPath` would corrupt descendant rebinds.
- **Fix:** derive the slice index from the **same** normalized string used for the match, or assert/normalize leading-slash-free at entry.
- **Test:** rename with a deep descendant tree; assert all descendant keys rebind correctly.

---

## Phase 3 — Security LOW hardening

### P3.1 — `media:read-file` missing `assertNotInFiloDir` — LOW · *MIME-mitigated* · ✅ · *effort S*
- **Where:** [src/main/ipc/media.ipc.ts:187](src/main/ipc/media.ipc.ts:187)–193 (only handler that omits the `.filo/` guard its siblings enforce).
- **Root cause:** a renderer can `media:read-file('.filo/themes/x.svg')`. Not currently exploitable (every sensitive `.filo/` file is JSON/font → `octet-stream` → refused by the MIME allowlist), but the channel relies on an adjacent control, not its own guard.
- **Fix:** add `assertNotInFiloDir(relativePath);` after `assertSafeRelativePath`. Covered by the consistency gate **P6.3**.
- **Test:** `media:read-file` into `.filo/` rejects.

### P3.2 — `link:fetch-metadata` returns favicon/og:image URLs without re-validation — LOW · *CSP-mitigated* · *effort S*
- **Where:** [src/main/ipc/media.ipc.ts:598](src/main/ipc/media.ipc.ts:598)–612.
- **Root cause:** extracted image/favicon URLs are returned verbatim; only the renderer CSP (`img-src 'self' data: blob: filo:`) stops them loading. If a future path fetches them main-side or `img-src` widens, this becomes SSRF.
- **Fix:** run returned `image`/`favicon` URLs through `isPrivateUrl` / origin check before returning.
- **Test:** a metadata response pointing at a private IP image is dropped/sanitized.

### P3.3 — `window.filo.on` accepts any channel string at runtime — LOW · *informational* · *effort S*
- **Where:** [src/main/preload.ts:54](src/main/preload.ts:54)–61.
- **Root cause:** compile-time typed only; a compromised renderer can subscribe to arbitrary channels (receive-only — `invoke`/`send` are both validated). Minimal impact.
- **Fix (optional):** allowlist receivable channel names at runtime in `on`. Low priority.

---

## Phase 4 — UI/UX LOW polish

### P4.1 — Tab rename input doesn't auto-focus — LOW · *effort S*
- **Where:** [src/renderer/components/layout/Tab.svelte:60](src/renderer/components/layout/Tab.svelte:60)–63, `:193`–200. Siblings `VaultFileItem.svelte:389` (focus + select-all) and `KanbanColumn.svelte:545` (`autofocus`) do it.
- **Fix:** focus + select the input on `isRenaming` (mirror `VaultFileItem`).

### P4.2 — EmojiPicker grid has no arrow-key navigation — LOW · *a11y* · *effort M*
- **Where:** [src/renderer/components/shared/EmojiPicker.svelte](src/renderer/components/shared/EmojiPicker.svelte) (only `Escape` handled). `ContextMenu`/`Dropdown` have full arrow nav.
- **Fix:** roving-tabindex / arrow-key movement across the grid + to "Clear emoji".

### P4.3 — Countdown timer gives no end-of-timer cue — LOW · *effort M*
- **Where:** [src/renderer/components/tiles/TimerTile.svelte:134](src/renderer/components/tiles/TimerTile.svelte:134)–141 (silent stop); `applyCustomInput`/`setDuration` (lines 167–183) silently ignore invalid input.
- **Fix:** on reaching 0, flash the tile (`transform`/`opacity` only) + `aria-live` announce + optional toast. Give feedback when custom input is rejected.

### P4.4 — FileTile shows no missing-file state — LOW · *consistency* · *effort S*
- **Where:** [src/renderer/components/tiles/FileTile.svelte:133](src/renderer/components/tiles/FileTile.svelte:133)–172 (failure only surfaces as a toast *after* clicking Open). ImageTile/VideoTile show inline broken-resource badges.
- **Fix:** proactively render a missing-file affordance in the tile body when `filePath` is set but the file is gone (the `TileHeader` broken-ref `!` badge already exists at the board level).

### P4.5 — Inconsistent "missing target" UX across commands — LOW · *cosmetic* · *effort S*
- **Where:** `MoveTilesCommand`/`MoveCardCommand` toast on a deleted target; `UpdateImageAltCommand`/`UpdateTimerConfigCommand`/`ResizeTileCommand`/`UpdateTileStyleCommand`/`AddCardCommand` silently no-op.
- **Fix:** surface a uniform toast when a redo/undo target no longer exists.

---

## Phase 5 — Architecture / maintainability

### P5.1 — File-size creep: split the two highest-risk stores + one board — LOW · *maintainability* · *effort L*
- **Where:** [scripts/check-file-sizes.mjs](scripts/check-file-sizes.mjs) allowlist (13 files at zero-headroom ceilings). Worst: `TaskListBoard.svelte` 2202, `vaultExternalChanges.ts` 1886, `vault.svelte.ts` 1771, `KanbanBoard.svelte` 1429, `markdownFileWriter.ts` 1364.
- **Root cause:** every audit round bumps ceilings via inline comments, against CLAUDE.md's own "**split, not bump**" rule. The two highest are the hardest-to-reason-about data-integrity files — exactly where the *next* subtle bug is most costly.
- **Fix:** structural split pass on `vault.svelte.ts` (e.g. extract the recovery sequencer + swap/revert transaction) and `vaultExternalChanges.ts` (extract the prompt handlers); drop their allowlist entries. Do this **after** Phases 1–2 land so it doesn't churn the diff under the fixes.
- **Test:** `ci:file-sizes` passes with the entries removed; full `ci:verify` green.

### P5.2 — Reactive collections in hot `$derived` bodies — LOW · *micro-perf* · *effort S*
- **Where:** [src/renderer/lib/tasklist/taskListViewModel.svelte.ts](src/renderer/lib/tasklist/taskListViewModel.svelte.ts) (lines 143/194/197/224/268) + `vaultIndex.svelte.ts:178`.
- **Fix:** use plain `Map`/`Set`/`Date` (reactivity already comes from the enclosing `$derived`) with `// eslint-disable svelte/prefer-svelte-reactivity` + reason, as the genuinely-hot ones already do (`spatial.svelte.ts:33`). UNCONFIRMED as a measurable slowdown — measure first.

### P5.3 — `sectionedView` is O(sections × rows) — LOW · *latent* · *effort S*
- **Where:** [src/renderer/lib/tasklist/taskListViewModel.svelte.ts:282](src/renderer/lib/tasklist/taskListViewModel.svelte.ts:282)–294 (`filter` per section).
- **Fix:** bucket rows by section id in one pass. Bounded today (few sections); only matters at hundreds.

### P5.4 — De-dup `frontmatterEqual` — LOW · *smell* · *effort S*
- **Where:** [src/renderer/lib/vault/conflictResolver.ts:281](src/renderer/lib/vault/conflictResolver.ts:281) reimplements the key-set + `valuesEqual` compare that already exists as `fmValueEqual`/`fmDeepEqual` (Audit-7 L8).
- **Fix:** route `frontmatterEqual` through the shared helper. Two definitions of "is this a real FM change" invite drift.

---

## Phase 6 — Anti-regression gates & tests (close the sibling-parity class)

So the Phase-1/2 pattern can't silently recur.

### P6.1 — Scheduler quiescence-parity test — *effort S*
- Add a unit test asserting all three quiescence checks in `writeScheduler.ts` (`flush` early-return, `flush` drain loop, `flushAll`) agree on `pending`+`inFlight`+`parked`. Backs **P1.1** / **P2.5**.

### P6.2 — Extend `ci:board-path-casefold` to enumeration + classification — *effort S*
- [scripts/check-board-path-casefold.mjs](scripts/check-board-path-casefold.mjs) already pins `findBoardIdForPath`/`renameBoardPath`. Extend it to assert `scanBoardFiles` ([src/main/vault/boardFileOps.ts](src/main/vault/boardFileOps.ts)) and `classifyChange` ([src/main/services/fileWatcherClassify.ts](src/main/services/fileWatcherClassify.ts)) case-fold the `.board.json` match. Backs **P1.3**. Bite-verify.

### P6.3 — `.filo/` read-guard parity gate — *effort S*
- Add a gate (or extend an IPC gate) asserting **every** vault read channel that takes a relative path calls `assertNotInFiloDir` — catches **P3.1** and any future read channel that forgets it.

### P6.4 — Undefined-CSS-variable gate — *effort S*
- A `scripts/check-css-vars.mjs` that collects every `var(--…)` token used in `.svelte`/`.css` and fails on any token never *defined* in `src/css/style.css` (theme blocks) or a component `<style>` (excluding ones with a literal fallback). Catches **P1.2** and future typos. Bite-verify.

### P6.5 — `rawFrontmatter`-threading coverage — *effort S*
- Extend the external-reload matrix so every `setFrontmatter` reload site is asserted to refresh `originalFrontmatterCache`. Backs **P2.1**.

---

## Appendix A — Verified clean / accepted trade-offs (do **not** "fix")

Recorded so they're not re-flagged:

- **Markdown write path:** single-parser (`yaml` pkg) read+diff+serialize; untouched/exotic keys byte-preserved; dangling-alias/forward-`<<` caught (refuse→keep-raw, no `{}` collapse); unparseable YAML kept verbatim + toast; BOM+CRLF correct (fresh-read EOL in delta path, body-sniff in adopt paths); failed-hydrate guards (`hydrateReadFailed && !lastLoadedBody`, empty-cache re-read).
- **Schedulers:** per-key pre-drain on all three fire paths (newest lands last — promise-FIFO traced); dual write-generation self-heal consistent; quit fully bounded (`QUIT_DRAIN_DEADLINE_MS` + heartbeat; drift prompts auto-defer at 15 s < 60 s).
- **Vault lifecycle:** generation-aware `isStillSameVault` applied at the intrinsic live-path-read trigger (gate-enforced); disk writes fail-closed via `assertActiveVault` on a realpath registry; watcher swap-teardown + self-write suppression sound.
- **Undo/redo:** multi-slot reorders capture full order (not degenerate); FM writes delta-on-fresh-disk on both legs; `replaceAll` stays in body; `targetBoardId` correct; `BatchCommand` LIFO rollback; snapshots deep-cloned.
- **Board cache:** malformed/old/future board files → `failedBoards` + recovery snapshot, never overwritten; unknown forward-compat keys preserved; boardId collisions routed to recovery; cache is **not** an FM write source.
- **Electron-42:** modern API surface; zero native modules; dependency-free asar; electron-builder 26 config passes schema validation.
- **Accepted LOWs (documented):** bulk add-tag array staleness ([kanbanMultiSelect.svelte.ts:196](src/renderer/lib/kanban/kanbanMultiSelect.svelte.ts:196)); cross-batch external rename can evict a board (watcher-correlation limit, recover on reopen); case-only external rename reversed-pair cosmetic casing drift ([renameCorrelation.ts:287](src/main/services/renameCorrelation.ts:287)); delta write vs non-map-root FM block (never produced by PKM tools); CST nested-comment / deleted-key-comment losses (KNOWN_LIMITATIONS #1, value-safe); `LAUNCH_ID` recovery suppression interaction (mostly by-design — `markClean`-on-save-swap clears the sibling sentinel; "Don't Save" suppression matches user intent).

## Appendix B — Suggested sequencing

1. **P0** (validation) — in parallel with starting to use a throwaway vault.
2. **P1** (5 MEDIUMs) — P1.1 + P1.2 first (minutes each), then P1.3 / P1.5, then P1.4.
3. **P2** (data-path parity) + **P6.1/P6.2/P6.5** (the matching gates) together.
4. **P3** (security) + **P6.3**.
5. **P4** (UI polish) + **P6.4**.
6. **P5** (arch/maintainability) — last, so the file-split doesn't churn the diff under earlier fixes.

Run `npm run ci:verify` at every phase boundary; commit per phase for bisectability (the working tree currently bundles Audit-7→14 uncommitted — consider committing that baseline *before* starting Audit-15 so these fixes are isolable).

# Frontmatter Write-Path Remediation Plan — 2026-06-04

**Source:** Independent data-integrity + UI/UX audit (9 read-only auditor agents, fresh read, all
High findings personally verified against the code).
**Scope:** The frontmatter write path and adjacent data-integrity surfaces (external-edit
reconciliation, quit/crash, IPC, undo/redo, UI error honesty).
**Status:** Phases 1–5 COMPLETE (2026-06-04). Phase 1 = all six tactical fixes (1.1–1.6).
Phase 2 = the stale-cache external-revert HIGH (2.1 + 2.2) with bite-verified seam round-trip
tests. Phase 3 = verified the six ◐ items against the current code and fixed all six (3.1 and 3.2
turned out PARTIAL — see the per-item verdicts below; 3.3–3.6 real) with a 7-test bite-verified seam
suite + a new `ci:reconciler-vault-guard` Part 3. **Phase 4 = the root-cause delta-based write-source
refactor (Track B): the field/popup write path now applies an explicit `FrontmatterDelta` to a FRESH
disk read at write time, so untouched keys — including external additions — are preserved BY
CONSTRUCTION; the in-memory cache is demoted to display-only and is never the write source. New
`ci:frontmatter-delta-write` gate (38th) + a 29-test seam/unit suite (incl. the #1 repro driven with a
deliberately-STALE cache, bite-verified).** `ci:verify` green (lint 0-err, svelte-check 0-err, 4020
unit tests, build, all 38 gates). **Phase 5 DONE 2026-06-04** — the seam layer is complete: 5.1's
field-edit third landed with Phase 4, and the new `writePathRemediationPhase5.test.ts` (7 tests) closes
the two seams Phase 4 left uncovered (Properties apply via the delta branch, body save via the cache-FM
source-preserving branch), each asserting untouched + empty + datetime keys survive the bytes on disk;
5.2/5.3/5.4 covered (`writePathRemediationPhase2/3/4`, `windowCloseDecision`), 5.5 = the new gate. See
the Phase 5 section for the full coverage map + bite-verification.

> This plan deliberately does **not** lean on the prior 9 audit plans. Every issue below was
> re-derived from the current code and the file:line references were verified on disk on
> 2026-06-04.

---

## 1. Executive summary

The codebase is well-engineered in most areas. The CST frontmatter engine, per-path write
serialization, vault-generation guards, the quit-drain handshake, and the UI/error-honesty layer
are all real and sound. **But there is a cluster of verified, silent data-loss bugs at one seam:
the write path serializes from an in-memory full-object cache (`documentStore.getFrontmatter(docId)`)
rather than from current disk bytes + an explicit field delta.** The CI `frontmatter-invariant` gate
misses all of them because they occur *upstream* of the engine it tests.

This plan has two tracks:

- **Track A — Tactical fixes (Phases 1–3).** Small, low-risk, ship-first. Stops active data loss and
  unblocks dogfooding of a single, primarily-Filo-edited vault.
- **Track B — Root-cause refactor (Phase 4).** A *narrow* change to the write-source model that
  makes the "never drop an untouched key" invariant **structural** instead of test-enforced. This is
  what ends the recurring-bug cycle. It is finite and scoped — not a rewrite.

**Readiness milestones**
- After **Phase 1 + 2**: safe to dogfood a single vault edited primarily inside Filo.
- After **Phase 4**: safe for heavy external-editing (Obsidian/VS Code on the same vault) + all board
  types.

---

## 2. Root-cause thesis (why this keeps recurring)

```
field edit / popup edit
      │  produces a PATCH (the delta the user actually changed)
      ▼
documentStore.mergeFrontmatter(docId, patch)     ← collapses the patch into a CACHED FULL OBJECT
      │
      ▼
scheduler reads documentStore.getFrontmatter(docId)   ← the FULL OBJECT (may be stale / lossy)
      │
      ▼
assembleMarkdownFile(fullObject, body, { originalFrontmatter: diskBytes })
      │
      ▼
patchFrontmatterSourceCst  ← diffs fullObject vs diskBytes; rewrites changed keys, deletes
                              keys present in diskBytes but ABSENT from fullObject
```

The engine is correct. The defect is that **the "full object" can disagree with disk for reasons
that have nothing to do with what the user changed**:

- it went **stale** (an external edit added a key that was never merged into the cache — Finding #1);
- it was **over-cleaned** (a present-but-empty key was stripped — Finding #2);
- it was **truncated** (a datetime became a date in the popup — Finding #3);
- it was **empty** because the source didn't parse, and a full-dump replaced the block (Finding #4).

In every case the engine faithfully writes the wrong object. Because audits test the engine in
isolation, these survive. **The fix is to stop feeding the engine a cached full object and instead
feed it `freshDiskFrontmatter + delta`** (Phase 4). Phases 1–3 are the safe interim mitigations.

---

## 3. Strategic decision: refactor vs continued point-fixes

| | Continue point-fixing only | Do the Phase-4 refactor |
|---|---|---|
| Stops the *current* known bugs | Yes | Yes |
| Stops the *class* from recurring | **No** — new sites keep appearing | **Yes** — untouched keys can't be touched |
| Complexity trend | Rising (more guards, more gates) | Falling (delete guards the model makes redundant) |
| Invariant strength | Test-enforced (fragile) | Structural (robust) |
| Risk | Low per fix, high cumulative | Moderate, one-time, test-covered |
| Confidence outcome | "Will it ever be done?" | A definable end state |

**Recommendation:** Do Track A now (cheap, stops loss, unblocks limited dogfooding), then do the
Phase-4 refactor as the **final** structural change to this area. Do not keep adding point-fixes to
the cached-object model indefinitely — that is the path that "never feels ready."

---

## 4. Phased plan

Severity legend: 🔴 High (silent data loss, plausible workflow) · 🟠 Medium · 🟡 Low.
Verification: **✓** = I read the code path myself · **◐** = agent-reported with citation, verify first.

### Phase 1 — Stop the bleeding (tactical, low-risk, do first)

Independent, small, safe fixes. Each ships with a regression test that exercises the **UI/command →
write round-trip** (the layer current tests skip).

> **DONE 2026-06-04.** All six fixes landed + `ci:verify` green (exit 0). Notes on scoping:
> - **1.1** needed *two* edits, not one — `mergeFrontmatter` cleans only `patch` keys AND
>   `assembleMarkdownFile`'s own null/undefined clean pass now preserves a `null` whose key exists in
>   the disk baseline (otherwise the CST engine still saw the stripped key as DELETED and spliced it
>   out, so the byte-level test would have failed on the merge-fix alone).
> - **1.2** `detectType`/`valueForRow` were extracted to `lib/utils/propertyRowTypes.ts` (pure, unit-
>   tested); a datetime is now `text` (not a truncating `date`), so it round-trips verbatim.
> - **1.3** the guard was extracted to a pure `main/utils/windowCloseDecision.ts` (`decideWindowClose`)
>   so the re-entrancy invariant is testable without a live BrowserWindow; `main.ts` calls
>   `event.preventDefault()` in the guarded branch. `setEnabled(false)` was deliberately NOT used — it
>   would also block the renderer's DI-04 "Save failed — retry" dialog.
> - **1.5** scoped to *genuine parse failure* only (`frontmatterSourceParses`): valid-but-non-mapping
>   YAML (sequence/flow-mapping) and anchor/alias refusals keep the long-standing dump fallback (the
>   dump preserves their data), so the existing `assembleMarkdownEngine` dump test stays green. The
>   user-facing toast was deferred to a `console.warn` breadcrumb — `assembleMarkdownFile` is a pure
>   fn called on every debounced write, so a toast there would spam; the data-safety (keep-raw) part
>   is the load-bearing fix and is complete.
> - **1.6** only error toasts with NO explicit positive duration are sticky; every non-error toast
>   (incl. the promise-backed external-edit decision warnings) keeps the Audit5 R3 15s cap.

#### 1.1 🟠✓ Empty frontmatter key dropped on any field edit
- **Where:** `src/renderer/stores/document.svelte.ts:325-339` (`mergeFrontmatter`, clean loop 328-331).
- **Root cause:** the clean loop iterates **all** keys of the merged object and deletes every
  empty/null value, so a present-but-empty disk key (`aliases:`, `cssclasses:`, `subtitle: ""`) is
  removed when an unrelated field is edited. `parseMarkdownFile` keeps such keys as
  `{aliases: null}` (verified `markdownSync.ts:113-118`), so they reach the cache and then get
  stripped.
- **Fix:** only clean keys **present in `patch`** (the keys the user actually set), not the whole
  merged object. A key the user didn't touch must never be deleted here.
  ```ts
  // before: for (const k of Object.keys(merged)) { ... delete }
  // after:  for (const k of Object.keys(patch)) {
  //           const v = merged[k];
  //           if (v === '' || v === undefined || v === null) delete merged[k];
  //         }
  ```
- **Test:** seed FM `{ aliases: null, title: 'x' }`, merge `{ priority: 'high' }`, assert `aliases`
  key survives the assembled output bytes.
- **Risk:** Very low. (Superseded entirely by Phase 4, but worth doing now.)

#### 1.2 🟠✓ Datetime frontmatter truncated to date-only by the Properties popup
- **Where:** `src/renderer/components/tiles/PropertiesPopup.svelte:95` (`detectType`), `:100-119`
  (`valueForRow`, the `value.slice(0, 10)` at `:112`).
- **Root cause:** `detectType` classifies `2025-01-15T10:30:00Z` as `'date'`, and `valueForRow`
  slices to 10 chars, dropping time + timezone on the next write.
- **Fix:** distinguish date-only from datetime. Either (a) add a `'datetime'` type that round-trips
  the full string, or (b) only `slice(0,10)` when the value has **no** `T`/timezone component.
  Minimal version: `if (/T|[+-]\d\d:?\d\d|Z/.test(value)) return value;  // keep full datetime`.
- **Test:** load FM `{ created: '2025-01-15T10:30:00Z' }`, simulate a popup apply, assert the written
  value is unchanged.
- **Risk:** Low (display + write formatting only).

#### 1.3 🟠✓ Double window-close destroys the window mid-drain
- **Where:** `src/main/main.ts:168-174` — the `if (isFlushingForQuit) return;` at `:174` returns
  **without** `event.preventDefault()`, so a second X-click while a drain is in progress lets
  Electron destroy the window and abort the in-flight write drain.
- **Root cause:** the window stays interactive during the (possibly slow, OneDrive) drain; the
  re-entrancy guard forgets to keep blocking the close.
- **Fix:** one line — preventDefault in the guarded branch too:
  ```ts
  mainWindow.on('close', (event) => {
    captureAndSaveWindowState();
    if (isFlushingForQuit) { event.preventDefault(); return; }  // keep blocking until drain done
    ...
  });
  ```
  Optionally also visually disable the window (`setEnabled(false)` or a "Saving…" overlay) during the
  drain so the user isn't tempted to click again.
- **Test:** unit-test the close handler invoked twice; assert `preventDefault` called both times while
  flushing. (Behavior also worth a Playwright E2E later.)
- **Risk:** Very low.

#### 1.4 🟡✓ `media:save-audio` missing the `.filo/` write guard
- **Where:** `src/main/ipc/media.ipc.ts:95-156` — the only vault-writing handler without
  `assertNotInFiloDir`; its schema accepts a 4th `destFolder` arg.
- **Root cause:** guard inconsistency; not practically exploitable without a compromised renderer
  (local-first, no network), but it breaks the "every `.filo`-touching channel is guarded" invariant.
- **Fix:** compute the relative path from `normalisedFolder + fileName` and call
  `assertNotInFiloDir(relPath)` before `atomicWriteFile`, mirroring `vault:write-file-binary`.
- **Test:** assert `media:save-audio(vault, bytes, 'app.json', '.filo')` rejects.
- **Risk:** None (the sole real caller passes no `destFolder`).

#### 1.5 🔴✓ Unparseable-but-fenced frontmatter destroyed when a key is added
- **Where:** `src/renderer/lib/editor/markdownSync.ts:443-457`; the safety net at `:471-476` only
  fires when the object is **empty**.
- **Root cause:** if the file's YAML is malformed (tabs, dup keys) the parse yields `{}` + a raw
  block; adding a key makes `objectHasKeys` true, so the safety net is bypassed,
  `patchFrontmatterSourceCst` returns null, and a full dump of *just the new key* replaces the block.
- **Fix:** when `options.originalFrontmatter` was present but `patchFrontmatterSourceCst` returns
  null (refused/unparseable), **do not full-dump over it** — either refuse the FM write (keep the raw
  block, surface a toast: "couldn't parse existing frontmatter; metadata edit not applied") or write
  the new keys *appended/merged into the preserved raw block* rather than replacing it. Refuse-and-warn
  is the safe default.
- **Test:** assemble with `originalFrontmatter = "\tbad: yaml\n  dup: 1\n  dup: 2"` + object
  `{ priority: 'high' }`; assert the original block is **not** discarded.
- **Risk:** Low. Requires malformed YAML on disk, but the consequence is total block loss, so worth it.

#### 1.6 🟡◐ Error / recovery toasts auto-dismiss after 15s
- **Where:** `ui.svelte.ts` toast lifetime (`duration: 0` → `TOAST_MAX_LIFETIME_MS` 15s cap);
  corroborated independently by 3 agents (write-failure toast, quit-failure breadcrumb, recovery hint).
- **Root cause:** genuinely-sticky toasts (save failed, recovery location) expire on a timer even
  though the failure persists.
- **Fix:** exempt `type: 'error'` / recovery-kind toasts from the lifetime cap (truly sticky until
  dismissed), or raise the cap substantially for those kinds. The toolbar indicator + `.dirty`
  sentinel already persist, so this is about not losing the *rich recovery hint*.
- **Test:** push an error toast with `duration: 0`; advance fake timers past 15s; assert still present.
- **Risk:** Low.

### Phase 2 — Close the stale-cache external-revert (the HIGH)

This is the most important finding and the bridge into the refactor. Do it even if you choose the
refactor, because it protects the existing code path until Phase 4 lands.

> **DONE 2026-06-04.** Both fixes landed + `ci:verify` green. Implementation notes:
> - **2.1** chose the plan's "drop the cache" option (the simpler/safer one). The drop lives in a
>   small sibling `lib/vault/staleSeededFrontmatter.ts` (`dropStaleSeededFrontmatterCache(relPath)`)
>   rather than inline, so Phase 4 removes it with a single-file delete + two call-site removals, and
>   so `vaultExternalChanges.ts` (which sat *exactly* at its 1743 file-size ceiling) grew by only the
>   import + two call sites + comments (ceiling bumped 1743 → 1754). The helper resolves
>   `relPath → contentId(s)` by walking the board cache's text-tile defs via the existing
>   `tileBacksMarkdownPath`, and clears ONLY seeded-but-not-open entries (an open editor's cache is
>   authoritative). Called from BOTH the `sync-frontmatter` and `reload-silently` branches. Safe
>   because the pre-switch F4 `isPathPending` guard already diverts any path with a pending write to
>   the prompt path, so no scheduled flush can read the just-cleared null cache.
> - **2.2** chose "re-read fresh disk for the not-open case" (a refinement of the plan's "always
>   re-read"): an OPEN editor's cache stays the rebase base (the reconciler keeps it fresh + it holds
>   unsaved popup edits, and "always read disk" risked losing those), but a NOT-open doc now rebases
>   `UpdatePropertiesCommand` onto a fresh disk read. The gate became `base === null || !isHydrated`
>   so hydration-on-demand for the BOM/baseline is preserved. All 8 existing `updatePropertiesCommand`
>   tests stay green.
> - **Tests:** `src/tests/unit/writePathRemediationPhase2.test.ts` — 6 tests: the helper in isolation
>   (clears not-open / preserves open / leaves unrelated paths alone), the 2.1 repro driven through the
>   real `handleExternalMarkdownChanges` + a follow-up Kanban field edit (the #1 end-to-end repro), and
>   the 2.2 repro (Properties undo of one key preserves an externally-added key the stale not-open
>   cache never saw). Both fixes were bite-verified by temp-reverting them (2.1 → 4 reds, 2.2 → 1 red).

#### 2.1 🔴✓ External frontmatter edit silently reverted for a non-open doc
- **Where:** `src/renderer/stores/vaultExternalChanges.ts:201` (cache refresh gated on `editorDoc`),
  `:211` (baseline re-stamp that *suppresses* the would-be drift prompt);
  `src/renderer/lib/boards/seedFrontmatterFromDisk.ts:80` (no-op on present cache);
  `src/renderer/stores/document.svelte.ts:235-243` (`findByFilename` searches only `openDocuments`).
- **Root cause:** on a `sync-frontmatter` / `reload-silently` external edit, the `documentStore` FM
  cache is refreshed **only if an editor is open**. A Kanban card / Task row that was field-edited
  once is *seeded* but not *open*, so its cache goes stale; the next field edit's seed no-ops, merges
  over the stale base, and drops the externally-added key — and the baseline re-stamp at `:211` means
  the pre-write drift prompt won't catch it.
- **Fix (interim):** in the `sync-frontmatter` and `reload-silently` branches, refresh **or drop** the
  FM cache for a seeded docId even when it is **not** in `openDocuments`:
  - Resolve the docId by the tile's `contentId` (via `boardStore`/tile lookup), not just
    `findByFilename`; if `documentStore.hasFrontmatter(docId)`, call
    `setFrontmatter(docId, next.frontmatter, next.rawFrontmatter)`; **or**
  - Simpler and safer: `documentStore.clearFrontmatter(docId)` for any seeded-but-not-open doc on an
    external sync, so the next field edit's `seedDocumentFrontmatterFromDisk` re-reads fresh disk
    (no longer no-ops).
- **Test:** seed a card's FM cache; simulate an external edit adding `status: blocked` with no open
  editor; trigger another field edit; assert `status` survives the assembled write.
- **Risk:** Low–moderate (touches the reconciler; cover with the new test). **Phase 4 makes this
  structural**, after which the interim guard can be removed.

#### 2.2 🔴✓ Properties / body-save revert via the same stale cache
- **Where:** `src/renderer/commands/propertiesCommands.ts:180` (`if (!isHydrated(relPath))` gates the
  disk re-read); `PropertiesPopup.svelte:158` reads the same stale cache first.
- **Root cause:** for a seeded (`isHydrated === true`) doc the fresh disk re-read is skipped, so the
  command rebases onto the stale cache and reverts untouched external keys.
- **Fix (interim):** re-read disk when the cache may be stale — gate the re-read on
  `!documentStore.hasFreshFrontmatter(...)` rather than `!isHydrated(relPath)`, **or** always re-read
  fresh disk inside the (already per-path-serialized) command and rebase onto that. Pair with 2.1's
  cache-drop so both paths converge on fresh disk.
- **Test:** seed FM cache; external-add a key; run `UpdatePropertiesCommand` editing a *different*
  key; assert the external key survives.
- **Risk:** Low–moderate. Also subsumed by Phase 4.

### Phase 3 — Verify and fix the ◐ Reported items

Each was agent-reported with a code citation but **not** independently traced by me. **Verify first**
(reproduce in code/tests), then fix only the real ones. Do not fix blind.

> **DONE 2026-06-04.** All six items traced against the current code; the real ones fixed with
> bite-verified seam tests (`src/tests/unit/writePathRemediationPhase3.test.ts`, 7 tests — each goes
> red when its fix is temp-reverted; all six reverted at once → exactly 6 reds). `ci:verify` green
> (exit 0; 401 files / 3971 unit tests; all 37 gates). Per-item verdicts:
> - **3.1 🟠 PARTIAL → fixed (honesty only).** The `.dirty` breadcrumb-wipe claim is **REFUTED**: a
>   settled fire-and-forget failure stays in `failedVaultPaths`, which keeps `.filo/.dirty` dirty
>   (`markClean`/`syncSentinelIfIdle` only fire when that set is empty) AND drives `saveState` to
>   `'error'`, so `handleFlushAndQuit` is already double-guarded (`ok` AND `saveStateState() !==
>   'error'`). The **real** part is boolean honesty: a per-scheduler `flushAll()` only re-surfaces
>   failures it drained THIS cycle, so a fire-and-forget write that FAILED and settled before the flush
>   left `vaultStore.save()` returning `true`. Fix: `save()` now ANDs `!hasFailedWrites()` (new getter
>   on `writeStateTracking`).
> - **3.2 🟠 PARTIAL → fixed.** The disk side is main-side mitigated by `assertActiveVault` (matching
>   the gate's existing `recreateDeletedFile` exemption), but `runRename`'s in-memory `replaceCache`
>   revert on IPC failure is NOT: a swap landing mid-rename (which *causes* the IPC to fail) would
>   re-inject the outgoing vault's `cacheSnapshot` into the swapped-in vault. Fix:
>   `captureVaultIdentity()` at the top of `runRename`, gate both reverts on `isStillSameVault`;
>   `performDelete` bails before its post-IPC cascade on a swap. New `ci:reconciler-vault-guard`
>   **Part 3** pins both functions carry the guard (bite-verified) — the generic Part-1 scan can't
>   reach them (`runRename` takes a `vaultPath` param; the `rename` wrapper only delegates).
> - **3.3 🟠 REAL → fixed.** `syncTileMarkdown`'s pre-write guard compared `mtimeMs` only; a
>   coarse-resolution FS (FAT / some OneDrive mounts) can stamp a same-second external write with an
>   identical mtime. Fix: compare size too (`vault:stat` already returns it). Same-size+same-mtime is
>   the documented residual (needs a content hash).
> - **3.4 🟠 REAL → fixed.** `promptModifiedFile`'s Reload replayed the `next` snapshot captured at
>   watcher-event time, so a second external write before the click was lost. Fix: re-read current disk
>   (`vaultIndexStore.applyChanges` + `getMetadata`), mirroring `promptExternalEditOnSync`; the handler
>   is now `async` so awaiting callers wait for the apply.
> - **3.5 🟠 REAL → fixed.** `reorderKanbanColumns` slice-replaced (`columns = orderedIds.map(...)`),
>   dropping any live column absent from the captured order — so an out-of-band column add was lost on a
>   stale-order undo. Fix: append live survivors in live order, mirroring the Task List
>   `applySectionOrderLive`.
> - **3.6 🟡 REAL → fixed.** `ReplaceAllCommand.undo` blindly overwrote `originalContent`, clobbering a
>   post-replace external edit. Fix: per-file drift check — revert only files whose disk still equals
>   what `execute` wrote; skip the rest and name them in one aggregate toast (skip+warn rather than N
>   per-file prompts, since it's a bulk op).
>
> Ceilings: `vault.svelte.ts` 1608→1617, `vaultExternalChanges.ts` 1754→1767; `vaultFolderOps.ts` held
> under the 1000 limit by trimming the 3.2 comments (no new allowlist entry).

| ID | Sev | Where | Claim | Action |
|---|---|---|---|---|
| 3.1 | 🟠◐ | `boards/writeScheduler.ts:692-742` | `flushAll()`/`save()` returns `true` for an already-failed write; `openVault`→Save then wipes the `.dirty` breadcrumb | Verify the settled-failure set isn't re-surfaced; if real, make `flushAll` consult `failedVaultPaths` and return failure |
| 3.2 | 🟠◐ | `stores/vaultFolderOps.ts:366,700` | In-app rename/delete cascade has no vault-identity guard (asymmetric with the external path) | Verify the swap-mid-rename window; if real, add `captureVaultIdentity`/`isStillSameVault` around the cascade and add it to `ci:reconciler-vault-guard`'s scan set |
| 3.3 | 🟠◐ | `stores/boardCache.svelte.ts:888` | Manual "Sync" uses an mtime-only (size-blind) guard → same-size same-second external edit clobbered | Verify; if real, compare mtime **and** size (or seed the gateway baseline from the read's stat) |
| 3.4 | 🟠◐ | `stores/vaultExternalChanges.ts:1196` | Watcher "Reload" applies stale captured content, not current disk | Verify; if real, re-read disk in the Reload handler (mirror `promptExternalEditOnSync`) |
| 3.5 | 🟠◐ | `commands/kanbanCommands.ts:504` | Kanban column-reorder undo drops an out-of-band-added column (Task List sibling guards this) | Verify; if real, mirror `applySectionOrderLive`'s append-survivors logic |
| 3.6 | 🟡◐ | `commands/replaceAllCommand.ts:195` | `undo` overwrites post-replace external edits with no drift check | Verify; if real, add a per-file drift check on undo and prompt on conflict |

### Phase 4 — Root-cause refactor: delta-based write source (DECISION POINT)

> **DONE 2026-06-04.** The structural refactor landed + `ci:verify` green (exit 0; 38 gates; 4020
> unit tests). Implementation + scoping decisions (the established judgment-call pattern of prior
> phases):
> - **New `lib/vault/frontmatterDelta.ts`** — the pure `FrontmatterDelta = { set, unset }` primitives
>   (`patchToFrontmatterDelta` for the field patch shape, `diffToFrontmatterDelta` for the popup's
>   whole-object diff, `applyFrontmatterDelta`, `mergeFrontmatterDelta` for coalescing,
>   `isEmptyFrontmatterDelta`). 19 unit tests.
> - **Gateway delta branch** (`markdownFileWriter.ts` `writeMarkdownFileImpl`) — when
>   `args.frontmatterDelta` is present it reads CURRENT disk **in-chain** (`vault:read-file-text`
>   inside `runSerializedMarkdownWrite`), applies ONLY the delta keys, and assembles with BOTH
>   `rawFrontmatter` AND `originalFrontmatter` sourced from that one fresh read — so the CST engine
>   rewrites only the delta keys and emits every untouched key byte-for-byte from disk. An in-chain
>   read failure → `markPathFailed` + throw (no resurrection). The legacy cache-FM path is unchanged
>   under an `else` (body-only editor saves + any no-delta caller).
> - **Per-path delta accumulator** (`frontmatterWriteScheduler.ts`) — `scheduleFrontmatterWrite(relPath,
>   docId, delta?)` folds deltas (`mergeFrontmatterDelta`) so coalesced edits collapse into one write;
>   the write peeks the delta and drops it only on SUCCESS (ref-identity), re-queuing on failure so a
>   retry/quit-flush never loses the edit. The three legacy guards (stale-version skip, cache-FM source,
>   `!fm` abort) are now `!delta`-gated. Registered with `renameAllPathKeys` (rename transfer) + cleared
>   on `resetFrontmatterScheduler`.
> - **Field commands + rebase chokepoint** thread `patchToFrontmatterDelta(patch)`
>   (`UpdateCardFieldCommand`/`UpdateTaskFieldCommand` first-execute legs + `applyFrontmatterPatchRebased`'s
>   `commit`, which covers every undo/redo leg). Kanban multi-select (tag bulk add) routes through the
>   same commands, so it is covered too.
> - **Properties** — `UpdatePropertiesCommand.applySnapshot` builds a delta from the non-conflicting
>   owned keys (+ the "Apply anyway" handler forces the conflict keys via a delta); the **popup
>   live-write** (`PropertiesPopup.buildFrontmatterWriteArgs`) threads
>   `diffToFrontmatterDelta(openTimeSnapshot, currentRows)` — the live variant of Finding #5.
> - **New gate `ci:frontmatter-delta-write`** (`scripts/check-frontmatter-delta-write.mjs`, 38th) pins
>   the structural invariant: the gateway's delta branch sources `nextFm` AND `originalFrontmatter`
>   from the SAME fresh read, and the field/popup sites construct a delta. Bite-verified (reverting the
>   task-command delta → red).
>
> **Decisions / scoping (documented like prior phases):**
> - **`mergeFrontmatter` is KEPT — for DISPLAY only.** `KanbanCard.svelte` + `TaskListBoard.svelte`
>   render each card/row's fields from `documentStore.getFrontmatter(contentId)`, so the cache MUST stay
>   live for the edit to show immediately. Phase 4 decouples the two: the cache feeds display, the delta
>   feeds the write. The cache is no longer the write source (step 4's intent), realised by NOT reading
>   it in the gateway delta branch — rather than by making `mergeFrontmatter` literally read-only (which
>   would break the board display).
> - **Explicit delta (not reconstruct-from-cache).** A `cache − seedSource` reconstruction was rejected:
>   several `setFrontmatter(obj)` sites (index fallback, popup, properties) replace the cache WITHOUT
>   updating the seed baseline, so the cache↔seed correspondence is fragile — exactly the bug class being
>   ended. The explicit delta depends on nothing but the user's patch.
> - **Phase 2 interim guards KEPT as belt-and-braces** (NOT removed — step 5 deferred). Conflict
>   detection on undo/redo stays cache-based + synchronous (the "keep external value, Apply anyway" UX is
>   unchanged), so keeping the cache fresh via `dropStaleSeededFrontmatterCache` (2.1) + the not-open
>   fresh-disk rebase (2.2) still improves conflict accuracy. Removing them is marginal cleanup with real
>   risk; deferred. Phase 4 makes the WRITE structural regardless of their presence (the seam tests prove
>   it with a stale cache).
> - **Left as-is per plan:** body-only editor saves (TextTile/DocumentEditor — keep the open-editor-
>   reconciled cache path), the orphan-card path (`applyOrphanPatchRebased` already reads fresh disk +
>   applies the patch + threads `originalFrontmatter` — it is the proven model Phase 4 generalises), and
>   `boardCache.syncTileMarkdown` (already writes the FRESH disk FM with the editor body — an
>   empty-delta-equivalent body sync).
> - **Read-only docs** leave the accumulated delta queued (it lands on a later `takeOwnership` +
>   re-schedule) rather than dropping it.
> - **Tests:** `frontmatterDelta.test.ts` (19), `gatewayDeltaWrite.test.ts` (5), and
>   `writePathRemediationPhase4.test.ts` (5 STRUCTURAL seam round-trips driven through the real Kanban
>   writer with a deliberately-stale cache: the #1 repro, empty-key survival, full datetime, comment +
>   key-order preservation, malformed-YAML keep-raw). `updatePropertiesCommand.test.ts` updated to serve
>   disk content (Phase 4 reads fresh disk; the mock now mirrors the reconciler's disk-read).
> - **Ceilings:** `markdownFileWriter.ts` 1201→1259, `kanbanCommands.ts` 1052→1064.

**Goal:** the write path applies an explicit field **delta** to a **fresh disk read at write time**,
so untouched keys (including external additions) are preserved *by construction*. The cache becomes a
read/display cache, never the write source.

**New shape (Kanban/Task field path first, then Properties):**
```ts
// A field edit records a delta instead of mutating a cached full object:
type FrontmatterDelta = { set: Record<string, unknown>; unset: string[] };

// Inside the per-path-serialized write (scheduler/gateway):
const fresh = parseMarkdownFile(await readDisk(path));        // current disk truth
const nextFm = applyDelta(fresh.frontmatter, delta);          // ONLY delta keys change
assembleMarkdownFile(nextFm, body, { originalFrontmatter: fresh.rawFrontmatter, ... });
//                    └── nextFm and rawFrontmatter derive from the SAME fresh read,
//                        so the CST engine rewrites ONLY the delta keys.
```

**Why this kills the class:**
- #1 / #2.1 (stale cache): untouched keys come from `fresh`, so an external addition is never dropped.
- #2 (empty-key over-clean): you only `unset` what the user unset; you never iterate foreign keys.
- #5 / #2.2 (Properties revert): the popup computes a delta vs the keys it loaded; untouched keys
  aren't in the delta.
- #4 (unparseable): applying a small delta to a refused block can degrade to "refuse + warn" without
  blowing away the block.
- **Undo/redo becomes more correct, not less:** the command already holds `patch` (forward delta) and
  `inversePatch` (inverse delta); applying the inverse delta to fresh disk *is* a rebase by
  construction, replacing the current `captureInverseFromCache` dance.

**What stays (do NOT rewrite):** the CST engine (`frontmatterCstModel.ts`), the gateway, per-path
serialization, write schedulers, vault-generation guards, the quit handshake. This is a single
data-flow swap behind the gateway.

**Body writes:** an open editor's unsaved **body** must still come from the editor, not the fresh
disk read. Keep body-source and FM-source separate (the gateway already takes `body` as a param).
Body-only saves are the least-affected and already have working open-editor reconciliation; migrate
them last or leave them once the field/popup paths are converted.

**Migration (incremental, low-risk):**
1. Introduce `FrontmatterDelta` + `applyDelta` + an `assembleMarkdownFileFromDelta` wrapper that does
   the fresh read inside the serialized chain (reuse the gateway's existing pre-write drift read so
   there's no extra IPC).
2. Convert `UpdateCardFieldCommand` / `UpdateTaskFieldCommand` to thread the delta (they already build
   `patch`/`inversePatch`).
3. Convert the Properties popup to emit a delta (set changed rows, unset removed rows) instead of
   `setFrontmatter(obj)`.
4. Make `mergeFrontmatter`/`getFrontmatter` cache read-only for the write path; keep them for display.
5. Remove the interim guards from Phase 2 once the structural invariant holds.

**New structural invariant + gate:** "the write path never reads a full FM object as its source; it
applies a delta to a fresh disk parse." Add a CI gate asserting the field/popup write sites construct
a delta and that `assembleMarkdownFile` callers on those paths pass a `fresh.rawFrontmatter` sourced
from a same-tick disk read.

**Risks & rollback:** moderate, one-time. Land behind the existing gateway so it can be toggled; keep
the cached-object path until the delta path passes the full corpus + new round-trip suite; convert one
writer at a time. The per-path serialization already prevents read-modify-write races within a path.

**Effort:** ~L (the engine and plumbing exist; the work is delta threading + popup conversion + tests).

### Phase 5 — Regression tests + gates (the missing layer)

> **DONE 2026-06-04.** All five items present + `ci:verify` green (exit 0). The seam layer is now
> complete and discoverable from one place. Coverage map (each item links to its home):
> - **5.1 field edit** → `writePathRemediationPhase4.test.ts` (Kanban writer: empty key / full
>   datetime / comment + key-order / the #1 repro, all driven with a deliberately-STALE cache).
> - **5.1 Properties apply** + **5.1 body save** → NEW `writePathRemediationPhase5.test.ts` (7 tests).
>   These were the two 5.1 seams Phase 4 left uncovered — Phase 4 only proved the *field-edit* third.
>   The Properties seam rides the gateway's **delta-on-fresh-disk** branch (via `UpdatePropertiesCommand`);
>   the body save rides the **cache-FM source-preserving** branch (via `scheduleMarkdownWrite` +
>   `documentStore.getRawFrontmatter` / `getOriginalFrontmatterSource`) — so the file exercises BOTH
>   halves of the write path, not just the field-edit third. Each asserts an untouched empty key
>   (`aliases:`), a full datetime, and a comment + key order survive the **bytes on disk**.
> - **5.2 external-then-edit** → `writePathRemediationPhase2.test.ts` (the end-to-end #1 repro through
>   the reconciler) + `updatePropertiesCommand.test.ts` H2 + `writePathRemediationPhase4.test.ts`; the
>   new Phase-5 file adds the external-key-survives proof through the **Properties** seam (the second
>   delta consumer).
> - **5.3 malformed-then-edit** → `writePathRemediationPhase4.test.ts` (field seam); the new Phase-5
>   file adds the keep-raw proof through the **Properties** seam.
> - **5.4 quit double-close** → `windowCloseDecision.test.ts` (the 1.3 re-entrancy guard, 4 tests).
> - **5.5 structural gate** → `scripts/check-frontmatter-delta-write.mjs` (the 38th `ci:` gate).
>
> **Bite-verified:** the Properties empty-key (`aliases:`) test goes RED when the delta threading is
> reverted (`frontmatterDelta: delta` → `undefined` in `propertiesCommands.ts`). The command's
> `cleanFrontmatter(merged)` strips the empty `aliases: null`, so the cache-FM fallback hands the CST
> engine an object MISSING `aliases` and it splices the on-disk key out — only the delta-on-fresh-disk
> path (delta carries just `{ set: { priority } }` applied to the fresh read) preserves it. Output
> collapses to `---\npriority: high\n---\nbody\n`. The other seam assertions (comment, datetime) are
> the source-preservation tripwires for the body-save branch. No source change in Phase 5 — tests +
> this status note only.

The existing corpus/fuzz suites drive the **engine** with pre-cleaned, pre-truncated objects, so they
structurally cannot catch Phase-1/2 bugs. Add **seam-level round-trip tests**:

- 5.1 Command/popup → write round-trips: field edit, Properties apply, body save — assert untouched +
  empty + datetime keys survive the **bytes on disk**.
- 5.2 External-edit-then-edit: external add a key with no open editor → in-app field edit → assert the
  external key survives (the #1 repro).
- 5.3 Malformed-YAML-then-edit (the #4 repro).
- 5.4 Quit double-close handler test (the #6 repro).
- 5.5 The Phase-4 structural gate described above.

---

## 5. Sequencing & effort

| Phase | Content | Effort | Unblocks |
|---|---|---|---|
| 1 | Tactical fixes 1.1–1.6 | S each (1 day total) | Most imported-frontmatter loss; double-close |
| 2 | Stale-cache external revert 2.1–2.2 | S–M | Dual-editor (Obsidian + Filo) safety for non-open docs |
| 3 | Verify + fix ◐ items | M (verify-gated) | Remaining medium edges |
| 4 | Delta-based write-source refactor | L | **Ends the recurring class**; all-board + heavy-external-edit safety |
| 5 | Seam round-trip tests + gate | M (overlaps 1–4) | Prevents regression of the whole class |

**Recommended order:** 1 → 2 → 5.1–5.4 → (dogfood a single Filo-edited vault) → 3 → 4 → 5.5.

**Minimum to start dogfooding (single, primarily-Filo-edited vault):** Phase 1 + Phase 2 + tests
5.1–5.4.

---

## 6. Appendix — full findings table

| # | Sev | Verified | Area | File:line |
|---|---|---|---|---|
| 1 | 🔴 | ✓ | External-edit reconciliation | `vaultExternalChanges.ts:201,211`; `seedFrontmatterFromDisk.ts:80`; `document.svelte.ts:235` |
| 2 | 🟠 | ✓ | Frontmatter cache | `document.svelte.ts:325-339` |
| 3 | 🟠 | ✓ | Properties popup | `PropertiesPopup.svelte:95,112` |
| 4 | 🔴 | ✓ | Markdown assembly | `markdownSync.ts:443-457,471-476` |
| 5 | 🔴 | ✓ | Properties / body write | `propertiesCommands.ts:180`; `PropertiesPopup.svelte:158` |
| 6 | 🟠 | ✓ | Quit / window lifecycle | `main.ts:168-174` |
| 7 | 🟡 | ✓ | IPC / path security | `media.ipc.ts:95-156` |
| 3.1 | 🟠 | ◐ | Write scheduler | `writeScheduler.ts:692-742` |
| 3.2 | 🟠 | ◐ | Vault lifecycle | `vaultFolderOps.ts:366,700` |
| 3.3 | 🟠 | ◐ | Manual sync | `boardCache.svelte.ts:888` |
| 3.4 | 🟠 | ◐ | External reload | `vaultExternalChanges.ts:1196` |
| 3.5 | 🟠 | ◐ | Undo/redo | `kanbanCommands.ts:504` |
| 3.6 | 🟡 | ◐ | Undo/redo | `replaceAllCommand.ts:195` |
| toast | 🟡 | ◐×3 | UI error honesty | `ui.svelte.ts` toast lifetime cap |

**Per-area ratings (1–10, critical):** Frontmatter write path 5 · External-edit reconciliation 5.5 ·
Board cache coherence 6 · Quit/crash recovery 6.5 · Write scheduling/gateway 7 · Vault lifecycle 7 ·
Undo/redo 7 · Main-process IPC/security 7.5 · UI/UX/a11y 8 · **Overall (data-integrity weighted) 6.**

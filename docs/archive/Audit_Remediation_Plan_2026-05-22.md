# Filo — Audit Remediation Plan (Phase 35+)

**Date:** 2026-05-22
**Author:** Senior UI/UX & systems engineering audit
**Status:** Draft — pending stakeholder approval

---

## Context

A fresh, deep audit of the Filo codebase ran on 2026-05-22, prior to the user beginning daily-driver use of the application against a large vault. The audit was conducted with four parallel deep-dive agents (data integrity, correctness + security, UX + accessibility, architecture + dead code) and used file/line citations rather than higher-level themes. CI gates were independently verified green at the time of the audit (`1638 / 1639 tests passing`, all seven gates clean).

The audit's bottom line: the codebase is in solid shape after ~30 phases of prior remediation, but **four silent-data-loss paths remain** and warrant fixing before non-technical daily-driver use. The remainder is iterative.

### Audit ratings (1–10)

| Area | Rating |
| --- | --- |
| Data integrity & durability | 6.5 / 10 |
| Correctness (bug risk) | 6 / 10 |
| Security & sandbox | 6 / 10 |
| UX polish | 7 / 10 |
| Accessibility | 7 / 10 |
| Architecture / cleanliness | 8 / 10 |
| **Overall daily-driver readiness** | **6.5 / 10** |

Target after this plan: **≥ 8 / 10 across the board** with Sprint 35 closing the daily-driver gate.

---

## Reading guide

- Six sprints, ordered by readiness impact.
- **Sprint 35 is the gate** to daily-driver use. Do not begin daily-driver use before it lands.
- Sprints 36–40 are iterative quality work.
- Each item lists: scope, file:line, approach, verification, rough effort.
- Standing rule for every sprint: end with `npm run ci:verify` green and add the listed unit tests. If a test isn't feasible (e.g. quit-during-debounce), drop a TODO and a memory entry — do not ship a verification claim that can't be backed up.

---

## Sprint 35 — Data-integrity gate (must-ship)

Goal: close four silent-data-loss paths.

### 35.1 — `Keep local` actually persists local edits

- **Files:** `src/renderer/stores/document.svelte.ts:464-473`, `src/renderer/components/tiles/TextTile.svelte:104-128`, `src/renderer/components/boards/DocumentEditor.svelte` (mirror), `src/renderer/lib/boards/markdownWriteRegistry.ts`
- **Bug:** the Keep-local handler is `markDirty + flushAllMarkdownWriters()`. `flushPendingMarkdownWrite` early-returns on `if (!writeTimer) return` — so if the prior debounce already fired (`writeTimer === null`), no write happens. The Phase 31 comment acknowledges the concern but the implementation doesn't actually re-arm a write when no debounce is pending.
- **Approach:** expose a `forceWriteNow()` from each markdown writer (writes the live editor body unconditionally, bypassing the `writeTimer` guard); register it on `markdownWriteRegistry` alongside `flush`. The Keep-local handler calls the new path for the specific `docId`. Alternative (simpler but coarser): handler also calls `scheduleMarkdownWrite()` to re-arm, then awaits one flush.
- **Test:** `src/tests/unit/keepLocalForcesWrite.test.ts` — open doc, write, advance time to clear `writeTimer`, fire Keep-local handler, assert disk content matches editor.
- **Effort:** ~3 hrs (incl. test).

### 35.2 — `CascadeDeleteCommand` snapshots style-clears

- **Files:** `src/renderer/stores/boardCacheFrontmatter.ts:65-127` (refactor to *return* clears), `src/renderer/commands/index.ts:2008-2090`
- **Bug:** cascade-delete mutates `placement.coverImage`, `frame.style.backgroundImage`, `defaults.frame.backgroundImage` in place. The command snapshots only `Tile[]` + `Connection[]` + `fileSnapshots`. After Ctrl+Z, tiles return but cover images and frame backgrounds stay wiped, and the next debounce persists the loss.
- **Approach:** change `findCascadeDeleteTargets` signature to return `{ byBoard, tileIds, styleClears: { coverImage[], frameBackground[], boardSettings[] } }`. Caller applies the clears (rather than the helper mutating inline). `CascadeDeleteCommand` constructor accepts the clears, deep-clones them, replays in `undo()` before placement restore. Preserve the existing `markDirty` cadence.
- **Test:** new unit test exercises a kanban card with `coverImage`, a frame with `backgroundImage`, and a mindmap `defaults.frame.backgroundImage` — all three pointing at the cascaded file — and asserts undo restores them.
- **Effort:** ~4 hrs.

### 35.3 — Rename-cascade two-phase commit with recovery sentinel

- **Files:** `src/renderer/stores/vaultFolderOps.ts:363-377`; new `src/renderer/lib/vault/renameCascadeSentinel.ts`; wire into `src/renderer/stores/vault.svelte.ts` startup. New IPC if needed (or reuse `vault:write-file-text` + `vault:read-tree`).
- **Bug:** flush-failure after a successful `vault:rename` leaves disk renamed but some `.board.json` references still on the old path. The user gets a toast — but there is no retry, no recovery sentinel, and the in-memory cache diverges from disk. Subsequent edits write the new cache state and can overwrite external mutations made between the failed flush and the next save.
- **Approach:** write `.filo/recovery/rename-cascade-{nanoid}.json` containing `{ oldPath, newPath, affectedBoardIds, timestamp }` *before* `vault:rename`. On full success, delete the sentinel. On partial failure, leave it; on next vault open, `vaultRecovery` lists sentinels and surfaces a "Retry rename cascade" modal (or auto-replays after a confirm). Mirrors the Phase 9 tag-rewrite-sweep pattern.
- **Test:** unit test with mocked `flushAllDirty` returning `{ failed: ['b1'] }` → assert sentinel persists; second test on startup with the sentinel present → assert replay path fires.
- **Effort:** 6–8 hrs.

### 35.4 — `frontmatterWriteScheduler` vault-swap reset

- **Files:** `src/renderer/lib/boards/frontmatterWriteScheduler.ts:69,217-229,232-236`; `src/renderer/lib/boards/writeStateTracking.ts:resetWriteTracking`
- **Bug:** module-level `lastFlushedVersion: Map<relPath, number>` survives vault swap. `Notes.md` in vault A at version 5 → swap to vault B with its own `Notes.md` → new writes get suppressed as "older than already-flushed." (Independently flagged by two of the four audit agents — high confidence.)
- **Approach:** rename `__resetFrontmatterSchedulerForTests` → `resetFrontmatterScheduler` (drop the test-only fence); call from `resetWriteTracking` before other reset work.
- **Test:** unit test asserts the Map is cleared on `resetWriteTracking(oldRoot)`.
- **Effort:** ~1 hr.

### Sprint 35 exit criteria

- 4 new unit tests, all green.
- `npm run ci:verify` green.
- Manual smoke: edit doc → external touch → Keep local; cascade-delete file used as a cover image → Ctrl+Z; rename folder while one board's flush is forced-failing → restart; vault-swap with a collision filename.

---

## Sprint 36 — Destructive surface & save visibility

Small, high-leverage UX/a11y consistency work.

### 36.1 — `BoardBrowser.deleteBoard` confirmation

- **Files:** `src/renderer/components/modals/BoardBrowser.svelte:194-202`
- **Fix:** route through `uiStore.openConfirm` with `{ danger: true, title: 'Delete board?', body: '<board name> and its placements are removed from the vault. The underlying note files stay (use the sidebar to delete those).', confirmText: 'Delete board' }`. Copy should match `KanbanBoard.deleteColumn`.
- **Effort:** 15 min.

### 36.2 — Tags Browser double-Modal

- **Files:** `src/renderer/components/layout/AppShell.svelte:515-521`, `src/renderer/components/tags/TagsBrowser.svelte:144`
- **Fix:** TagsBrowser is wrapped in `<Modal id="tags-browser" width="480px">` in AppShell AND opens its own `<Modal id="tags-browser" width="540px">` internally. Two `<dialog showModal()>` for the same id with conflicting widths. Delete one — pick the one whose component owns its open-state via `uiStore.openModal('tags-browser')`.
- **Test:** Playwright — open Tags Browser, assert exactly one `<dialog open>` with id `tags-browser`.
- **Effort:** 30 min.

### 36.3 — Save indicator into the global toolbar

- **Files:** `src/renderer/components/layout/ProjectDropdown.svelte:199-208` (remove), `src/renderer/components/layout/GlobalToolbar.svelte` (add slot)
- **Approach:** lift the three-state SVG group into `GlobalToolbar.svelte` next to the dropdown. Keep the `aria-live="polite"` and per-state `aria-label`. The dropdown can keep a smaller text confirmation if desired, but the ambient signal lives outside.
- **Effort:** 1 hr.

### 36.4 — Inline `<dialog>` confirmations through `ConfirmDialog`

- **Files:** `src/renderer/components/layout/AppShell.svelte:551-582` (multi-tile delete), `src/renderer/components/tiles/TileHeader.svelte:518-549` (single-tile delete)
- **Fix:** delete both hand-rolled `<dialog>` blocks. Replace with `uiStore.openConfirm({ ... })`. ConfirmDialog already provides focus-trap, Escape, Enter routing, and `aria-labelledby`.
- **Effort:** 1 hr.

### 36.5 — Modal accessible-name fallback

- **Files:** `src/renderer/components/shared/Modal.svelte:74`
- **Fix:** `aria-label={title ? undefined : id}` ships the internal id string (e.g. `"keyboard-shortcuts"`) to assistive tech when a title is omitted. Make `title` a required prop or fall back to `'Dialog'`. Audit every `<Modal>` call site for missing `title` and add.
- **Effort:** 45 min.

### 36.6 — Conditional mount for `project-settings` / `recovery-files`

- **Files:** `src/renderer/components/layout/AppShell.svelte:524-530`
- **Fix:** wrap both in `{#if uiStore.isModalOpen('...')}` like every sibling.
- **Effort:** 5 min.

### Sprint 36 exit criteria

- `npm run ci:verify` green.
- axe-core scan in `axeShell.spec.ts` shows no regressions.
- Playwright assert: single `<dialog>` for Tags Browser.

---

## Sprint 37 — Correctness & IPC security (P1)

### 37.1 — `DeleteTilesCommand` await-on-execute + path consistency

- **Files:** `src/renderer/commands/index.ts:210-238`
- **Fix:** `await Promise.allSettled` of the deletes inside `execute()` (mirror what `undo()` already does). Pass `snap.rel` (vault-relative) instead of `${vaultRoot}/${snap.rel}` to match every other `vault:delete` caller.
- **Effort:** 1 hr.

### 37.2 — `atomicWriteFile` preserves tmp on `ENOSPC`

- **Files:** `src/main/vault/filenameUtils.ts:186-194`
- **Fix:** keep the tmp on `ENOSPC` / `EIO` / `ENOMEM`; include its absolute path in the rejected error so `reportError` can surface it in a toast. Cleanup is correct for `ENOENT`; preserve data for the disk-full / I/O paths.
- **Effort:** 30 min.

### 37.3 — `sanitizeInlineHtml` explicit URI allowlist

- **Files:** `src/renderer/lib/utils/sanitizeHtml.ts:58-65`
- **Fix:** add `ALLOWED_URI_REGEXP: /^(https?|mailto|filo):/i` to the DOMPurify config. DOMPurify's defaults already block `javascript:`, so this is defence-in-depth rather than a live XSS — but the explicit allowlist guards against future config drift.
- **Effort:** 10 min.

### 37.4 — `copyFileToVault` Windows-reserved-name guard

- **Files:** `src/main/vault/fileOps.ts:149-171`, `src/main/ipc/vault.ipc.ts:512-554`
- **Fix:** call `assertSafeFilename(basename(sourcePath))` before `join`. Same for the unique-suffix branch's intermediate names.
- **Effort:** 20 min.

### 37.5 — `assertSafeRelativePath` on `destFolder` segments

- **Files:** `src/main/ipc/media.ipc.ts:79-90`, `src/main/ipc/vault.ipc.ts:540-545`
- **Fix:** when `destFolder` is non-empty, call `assertSafeRelativePath(normalisedFolder)` after the slash-normalisation. Catches per-segment Windows reserved names that current `assertWithinVault` misses.
- **Effort:** 30 min.

### 37.6 — Delete `vault:read-file-text` legacy single-arg branch

- **Files:** `src/main/ipc/vault.ipc.ts:309-339`
- **Fix:** confirm via grep that no renderer caller still uses the single-arg form (the inline A5.1 comment claims migration is complete). Delete the branch. If grep finds a caller, migrate it first.
- **Effort:** 30 min + grep audit.

### 37.7 — `media:open-external` / `shell:open-external` gate on `app.isPackaged`

- **Files:** `src/main/ipc/media.ipc.ts:197-203`, `src/main/ipc/shell.ipc.ts:33-40`
- **Fix:** swap `process.env.NODE_ENV !== 'production'` for `!app.isPackaged`. Electron packaged builds don't set `NODE_ENV`; the current check leaks the localhost allowance into production.
- **Effort:** 15 min.

### 37.8 — `link:fetch-metadata` charset detection

- **Files:** `src/main/ipc/media.ipc.ts:323-335`
- **Fix:** parse `Content-Type` for `charset=...`; if present and supported, pass to `new TextDecoder(charset)`. Fall back to UTF-8.
- **Test:** mocked fetch returning `Content-Type: text/html; charset=shift_jis` + Shift-JIS bytes → assert correct decoding.
- **Effort:** 1 hr.

### 37.9 — `MoveCardCommand.execute()` destination guard parity

- **Files:** `src/renderer/commands/index.ts:1533-1539`
- **Fix:** apply the same column-existence check that `undo()` got in Phase 28 B4.7. Toast + no-op if the target column was deleted before redo.
- **Effort:** 20 min.

### Sprint 37 exit criteria

- `npm run ci:verify` green.
- 2 new unit tests (charset, copyFileToVault).
- Grep audit findings recorded.

---

## Sprint 38 — Popup-contract consistency

The audit found 7+ popups using `role="dialog"` with mixed coverage on Escape / focus-trap / return-focus. Two paths:

- **38.A — Cheap path (recommended first):** downgrade roles where the contract isn't met; fix what's left.
- **38.B — Strategic path:** build a `Popover.svelte` primitive that bundles focus-trap + Escape + return-focus + `role="dialog"` + `aria-modal` + initial-focus. Migrate all 7 popups.

### 38.1 — Triage every popup

- **Files:** `EmojiPicker.svelte`, `ColorPicker.svelte`, `BackgroundImagePicker.svelte`, `KanbanTemplatePicker.svelte`, `TaskDatePicker.svelte`, `KanbanColumn` WIP popover, `FloatingTocPanel.svelte`
- For each: does it *need* dialog semantics? If yes, install `focus-trap`, Escape handler, return-focus-on-close, initial-focus. If no, drop the `role="dialog"` and use `role="group"` (or no role).
- **Effort:** 4–6 hrs (38.A) or ~10 hrs (38.B).

### 38.2 — Outline-removal audit

- **Files:** grep `outline: none` and `outline: 0` across `src/renderer/components/**/*.svelte`
- **Fix:** every match needs an alternate `:focus-visible` rule. Current global `:focus-visible` token works for default buttons; custom controls (ColorPicker `.hsl-wheel`, BoardBrowser `.search-input`) need explicit styling.
- **Effort:** 2 hrs.

### 38.3 — `RelinkTileModal` listbox semantics

- **Files:** `src/renderer/components/modals/RelinkTileModal.svelte:102-115`
- **Fix:** `<ul role="listbox">` containing `<button>` children breaks the role contract. Either drop the listbox role + use a regular list, or restructure as `<li role="option" aria-selected="...">`.
- **Effort:** 30 min.

### Sprint 38 exit criteria

- axe-core scan green.
- Manual keyboard sweep of every popup (Tab in, Esc out, focus returns to invoker).

---

## Sprint 39 — Architecture sweep (P2/P3)

Mechanical cleanups. Largely no-risk, parallelisable.

### 39.1 — Delete dead schema module

- **Files:** `src/renderer/schema/metadataEntry.ts` (104 LOC, zero imports)
- **Verify:** grep first to confirm. **Effort:** 5 min.

### 39.2 — Decide on `TileFrontmatterSchema`

- **Files:** `src/renderer/schema/frontmatter.ts:29-92`
- Two options: (a) wire into `lib/tasks/frontmatterReaders.ts` so the schema actually validates production reads (preferred — it has Obsidian-flavoured tag/date coercion that production currently re-implements ad hoc), or (b) delete the schema + its two tests.
- **Effort:** 1–3 hrs depending on choice.

### 39.3 — Remove dead npm dep

- **Files:** `package.json:48`
- Remove `@tiptap/pm`. Run `npm install` + `npm run check` + `npm run build` to confirm transitive resolution covers it.
- **Effort:** 15 min.

### 39.4 — Delete dead CSS

- **Files:** `src/css/style.css:861-868` (`.truncate`)
- Grep `class="truncate"` first. Delete if zero hits.
- **Effort:** 5 min.

### 39.5 — Dedupe CSS keyframes

- **Files:** `FrameStylePopup`, `TileStylePopup`, `ConnectionStylePopup`, `KanbanColumn`, `KanbanSideToolbar`, `KanbanCardStylePopup`, `TagsBrowser`, `KanbanColumnStylePopup`, `KanbanTemplatePicker`, `TaskDatePicker`, `TaskItemStylePopup`, `TaskListSideToolbar`, `TaskSectionStylePopup`, `ConfirmDialog`, `LinkInsertPopup`, `AppShell` — all have local `@keyframes popIn|slideUp|slideDown` that duplicate `src/css/style.css:802-832`.
- **Fix:** delete the 14+ local copies. Global keyframes are reachable from scoped Svelte styles.
- **Test:** Playwright visual diff or manual smoke on the affected popups.
- **Effort:** 1–2 hrs.

### 39.6 — Rewrite the `lib/` purity rule in CLAUDE.md

- **Files:** `CLAUDE.md` "Structure Rules" §2
- **New rule:** "`lib/` may use DOM globals and import from `stores/`, but must NOT contain Svelte component definitions (`.svelte` files) or import from `components/`."
- **Optional follow-up:** ESLint rule enforcing the new contract.
- **Effort:** 30 min for rule rewrite; +2 hrs for the lint rule.

### 39.7 — Split `commands/index.ts` (2148 LOC)

- Split into 8 sibling files + an `index.ts` re-export shim:
  - `tileCommands.ts` (~600 LOC)
  - `frameCommands.ts` (~200 LOC)
  - `connectionCommands.ts` (~150 LOC)
  - `waypointCommands.ts` (~250 LOC)
  - `sectionCommands.ts` (~250 LOC)
  - `taskCommands.ts` (~300 LOC)
  - `kanbanCommands.ts` (~400 LOC)
  - `groupAndBoardCommands.ts` (~250 LOC)
  - `index.ts` (re-export shim, ~50 LOC)
- Mechanical refactor — no behaviour change.
- **Effort:** 2 hrs.

### 39.8 — Shard `TaskListBoard.svelte` (2279 LOC)

- Mirror the Kanban sharding pattern:
  - `lib/tasklist/sectionDragController.svelte.ts`
  - `lib/tasklist/filtersAndViews.svelte.ts`
  - `lib/tasklist/taskLifecycle.ts`
  - `lib/tasklist/sectionPopups.ts`
- Target: drop the component to ≤ 900 LOC.
- **Effort:** 4–6 hrs.

### 39.9 — Split `fileTags.svelte.ts` (1096 LOC)

- Per `check-file-sizes.mjs:181-187` — extract cascade helpers (`commitTagRenameInMemory`, `commitTagRemovalInMemory`, `iterateInlineTiles`, `cascadeTagToBoardSettings`) into `stores/fileTagsCascade.svelte.ts`.
- **Effort:** 2 hrs.

### Sprint 39 exit criteria

- `npm run ci:verify` green.
- File-size ratchet shows reductions; allowlist snapshots updated downward where files shrank.
- No behaviour change in any sprint-39 PR.

---

## Sprint 40 — Coverage gaps & investigations

Things this audit couldn't reach. Each is an investigation that may or may not surface follow-up work.

### 40.1 — TipTap-Markdown lossy-detection coverage audit

- Read `src/renderer/lib/editor/markdownSync.ts`. Catalogue which Obsidian extensions are detected as lossy:
  - Math `$$ ... $$`
  - Callouts `> [!note]`
  - Footnotes `[^1]`
  - Embedded queries (` ```dataview `)
  - Comments `%% ... %%`
- For each undetected case: write a failing test, then add detection.
- **Risk:** medium — a false-negative here writes lossy output silently.

### 40.2 — Concurrent vault open from a second window

- Read `src/main/services/vaultRegistry.ts`. Verify a second renderer window opening the same vault is rejected, not coexisting. Add E2E if missing.
- **Risk:** low — likely already covered, but unverified by this audit.

### 40.3 — Binary write under disk-full

- `media:save-audio` and `vault:copy-file` paths. Confirm they go through atomic-write semantics (or document why they don't), and that `ENOSPC` surfaces to the user.
- **Risk:** low — annoyance, not data loss.

### 40.4 — The one skipped test

- `grep -n 'test.skip\|it.skip\|describe.skip' src/tests/`. Identify the skipped test. If still relevant, un-skip and fix. If obsolete, delete.
- **Effort:** 15 min.

### 40.5 — `boardWriteScheduler.flushAllScheduledBoards` interleaving claim

- The Phase 25 L12 comment claims the function "captures upfront before issuing any await." The audit thinks the snapshot capture happens *after* `clearTimeout`. Write a regression test that exercises rapid `propagateRename` mid-flush and verifies the captured `boardPath` matches the captured snapshot.
- **Effort:** 1–2 hrs.

### 40.6 — Renderer bundle weight (4.87 MB)

- Investigate code-splitting at the board/tile registry. Tile components and board components are already registry-routed — lazy-load them.
- **Risk:** low; bundle size doesn't affect Electron startup the way it does web, but it does affect initial paint.

---

## Suggested execution order

### Linear (single-track)

1. Sprint 35 (3–5 days) ← **gate to daily-driver use**
2. Sprint 36 (1–2 days)
3. Sprint 37 (1–2 days)
4. Sprint 38 (2–3 days)
5. Sprint 39 (3–4 days) — can interleave with 37/38
6. Sprint 40 (timeboxed investigation, 1–2 days)

### Parallel (if Sprint 35 needs to ship fast)

1. Sprint 35 sequentially
2. Then 36 + 37 in parallel (no overlapping files)
3. Then 38 + 39
4. Then 40

---

## CI additions

After Sprint 35:
- 4 new unit tests added to `npm run test:unit:strict`.

After Sprint 38:
- Extend axe-core sweep to cover every popup, not just modals.

After Sprint 39:
- Update `scripts/check-file-sizes.mjs` allowlist snapshots downward where files shrank.
- (Optional) ESLint rule enforcing the rewritten `lib/` purity contract.

---

## Open questions for stakeholder

1. Sprint 38: cheap path (38.A) or strategic `Popover.svelte` primitive (38.B)?
2. Sprint 39.2: wire `TileFrontmatterSchema` into production frontmatter reading, or delete it?
3. Sprint 40 sequencing: investigate-as-you-go, or batched at the end?

---

*End of plan.*

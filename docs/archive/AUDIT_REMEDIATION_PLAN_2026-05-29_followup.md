# Audit Remediation Plan — 2026-05-29 (Systems Follow-up)

**Source:** Second independent audit (senior UI/UX + systems engineering pass), run after `AUDIT_REMEDIATION_PLAN_2026-05-29.md`. Fresh read of the write path, schema/migration layer, undo/redo, external-change reconciliation, IPC/path-security, UI/UX, and dead code — deliberately *not* relying on prior plans.

**Verdict:** Overall ~8/10. **No bug that silently corrupts or loses vault data under normal operation.** Baseline green: `svelte-check` 0/0 across 751 files, **2891 unit tests pass**, build + lint + all 21 `ci:*` gates pass. Findings are forward-compat gaps, async-failure edge cases, and UI polish.

**Relationship to the same-day plan:** This complements `AUDIT_REMEDIATION_PLAN_2026-05-29.md`; it does **not** restate that plan's H1/M1/M2/M3/C-* items. Overlap is limited to its L2/L3 (frontmatter schema / YAML-comment loss) — see "Already tracked elsewhere" below. Archive both into `docs/archive/` once executed (per that plan's C-2).

**Legend:** `[V]` = location personally verified against source during this audit. `[A?]` = agent-reported in the breadth scan; confirm the exact line before editing.

---

## Findings recap

| ID | Severity | Area | Summary |
|---|---|---|---|
| DI-1 | Medium | Data integrity | General-settings round-trip drops unknown `app.json` keys despite the schema's `.passthrough()`. |
| UR-1 | Medium | Undo/redo | `redo()` / `undo()` run the command body with no rollback-on-failure, unlike the hardened `execute()`. |
| SC-1 | Low–Med | Schema | Non-numeric `width`/`height` silently folds to 240/160 instead of failing loud (contradicts the `Infinity` decision). |
| DI-2 | Low–Med | Data integrity | Connection-restore paths don't verify endpoint tiles exist → possible dangling edge. |
| UX-1 | Med (UX) | UI | `ImageTile` / `VideoTile` / Kanban cover have no `onerror` fallback — broken media shows the OS glyph silently. |
| UX-2 | Med (a11y) | UI | `HomeScreen` recent-project row nests interactive controls inside a `<button>` (invalid HTML / AT break). |
| UX-3 | Low | UI | Emoji used as chrome (`IframeTile` 🌍, `TaskQuickAddInput` 📅/🕐) — violates "SVG icons only". |
| UX-4 | Low | UI | Inline `z-index` literals + hard-coded accent colors bypass the token system. |
| DI-3 | Low | Data integrity | Main-side self-write suppression (500 ms) can expire before the renderer window (1.5/5 s) on very slow disks. |
| DI-4 | Low | Data integrity | Cross-basename rename pairing resolves both hash sides from the lazy cache → theoretical mispair. |
| DOC-1 | Low | Docs | `CLAUDE.md` references `schema/frontmatter.ts`, `constants/zindex.ts`, and `registerCommand/unregisterCommand` — none exist. |
| CR-1 | Cruft | Maintainability | `FlushAllResult` defined 3×; a few back-compat shims kept alive only by tests. |

---

## Already tracked elsewhere (do not duplicate)

- **YAML comments/formatting lost on frontmatter rewrite** → `AUDIT_REMEDIATION_PLAN_2026-05-29.md` **L3** (accepted limitation; `markdownSync` `js-yaml` load→dump).
- **`FrontmatterSchema` exported/tested but unwired + data-mutating `.transform()`** → that plan's **L2**. This audit independently confirmed `src/renderer/schema/frontmatter.ts` does not exist (the symbol, if present, lives elsewhere); folded into DOC-1 for the doc-correction half only.

## Explicitly out of scope — verified NOT bugs (don't "fix" these)

- **`InlineTileSchema` lacks `.passthrough()`** — *intentional security hardening* (`src/renderer/schema/placement.ts:123-128`) to block `javascript:` URL smuggling from hand-edited `.board.json`. Leave as-is.
- **"AddTileCommand undo destroys connections"** — *not reachable*: layout-template edges are wrapped in a `BatchCommand` (`src/renderer/stores/boardHistory.ts:49-63`); user-drawn edges are separate commands undone first by LIFO. No action.

---

## Phasing principle

Risk-adjusted value, zero-risk first. **Every phase must leave the app runnable and `npm run ci:verify` green** (CLAUDE.md phase-boundary rule). Phases are independent and can ship as separate small PRs.

---

## Phase 0 — Zero-risk cleanup (~30–45 min, no behavior change)

| ID | Change | Files |
|---|---|---|
| DOC-1 `[V]` | Correct `CLAUDE.md`: remove/replace the `schema/frontmatter.ts` reference (no such file), the `constants/zindex.ts` reference (only `defaults.ts`, `styleOptions.ts`, `taskPriorities.ts` exist; the z-scale lives as `--z-*` CSS vars), and the "registerCommand/unregisterCommand are API stubs" note (deleted — only the comment remains in `core/commandRegistry.ts`). | `CLAUDE.md` |
| CR-1 `[V]` | Collapse the three `FlushAllResult` definitions to one shared type where shapes match; leave the genuinely-different `ownerId` vs `callerId` variant documented inline. | `src/renderer/lib/boards/markdownFileWriter.ts:511`, `src/renderer/lib/boards/markdownWriteRegistry.ts:33`, `src/renderer/lib/boards/writeScheduler.ts:151` |
| CR-1 `[A?]` | (Optional) Drop `registerMarkdownFlusher`/`unregisterMarkdownFlusher` + `parseTagsFile` once their only callers (tests) are migrated to the gateway. | `markdownWriteRegistry.ts:58,70`, `lib/vault/tagsStorage.ts:147` |

- **Acceptance:** `npm run ci:verify` green; `CLAUDE.md` paths all resolve.
- **Risk:** none. **Rollback:** trivial.

---

## Phase 1 — Data-integrity correctness (DI-1, UR-1) (~half day)

**DI-1 `[V]` — settings round-trip drops unknown keys.**
- Root cause: `parseSettingsSlices` hand-builds `generalInput` from ~22 named keys, then `GeneralSettingsSchema.safeParse(generalInput)`. Keys not in that list never reach the (`.passthrough()`) parser, so they're dropped on load and lost on the next save.
- **Fix:** spread the raw config first, then layer the alias/fallback normalizations on top, e.g. `const generalInput = { ...appConfig, globalFont: appConfig.globalFont ?? '', toolbarColor: appConfig.toolbarColor ?? appConfig.toolbarColour ?? '', ... }`. Passthrough then preserves unknown keys.
- **Also:** trace the save path that serializes `general` back to `app.json` (config write) and confirm it doesn't re-drop the passthrough keys; if it hand-picks, mirror the spread there.
- **Files:** `src/renderer/lib/vault/vaultCandidate.ts:436-458` (+ the config serializer).
- **Test:** load an `app.json` containing an unknown key → save → assert the key survives the round-trip.

**UR-1 `[V]` — redo/undo lack rollback-on-failure.**
- Root cause: `execute()` (`history.svelte.ts:331-337`) captures `preRedoStack` and `.catch(rollbackExecute)`; `undo()` (`:364`) and `redo()` (`:386-389`) call `runChained(() => command.undo()/execute())` with no `.catch`. An async command whose body rejects mid-redo/undo leaves the stacks desynced (command on the wrong stack, state half-applied).
- **Fix:** give `redo()`/`undo()` symmetric rollback — on rejection, move the command back to the stack it came from and restore the counterpart entry (mirror `rollbackExecute`'s shape at `:279-291`).
- **Files:** `src/renderer/stores/history.svelte.ts:349-390`.
- **Test:** a stub async command whose `execute()`/`undo()` rejects; assert `canUndo`/`canRedo` and stack contents are unchanged after a failed redo/undo.

- **Acceptance:** new tests pass; all 21 gates green.
- **Risk:** low–medium — keep stack mutations synchronous (the existing contract tests inspect `canUndo` immediately).

---

## Phase 2 — Robustness hardening (SC-1, DI-2, DI-3, DI-4) (~half day)

**SC-1 `[V]` — corrupt size string silently substituted.**
- `coerceToNumber` (`schemaUtils.ts:32-39`) returns the fallback for an unparseable string, which then passes `.pipe(z.number().finite().min())`. This contradicts the documented M2 fail-loud stance for `Infinity`.
- **Fix:** in the string branch, return the parsed value (NaN for unparseable) instead of the fallback, so the downstream `.finite()` gate rejects it and the board routes to `failedBoards` + recovery snapshot — consistent with the `Infinity` path. Numeric strings (`"300"`) still parse.
- **Files:** `src/renderer/schema/schemaUtils.ts:32-39` (affects `placement.ts:15-16,142-143`, `tile.ts` size/position).
- **Test:** a board with `width: "wide"` lands in `failedBoards` (mirror the existing NaN-coord test).

**DI-2 `[V]` — connection-restore doesn't verify endpoints.**
- `boardConnections.addConnection` (`:17-24`) persists even on schema-parse failure; restore paths (`tileCommands.ts:382-384`, `groupAndBoardCommands.ts:482-484`) re-add snapshotted connections. The cache resolves boardId via `warnUnresolved` (`boardCacheConnectionsFrames.ts:59-71`) but doesn't gate on *both endpoint tiles existing*.
- **Fix:** before persisting a restored connection, skip-and-warn if either `fromTileId`/`toTileId` is absent from the target board's tiles. Cheapest at the restore sites (filter to connections whose endpoints are being restored).
- **Test:** undo a cascade-delete where one endpoint was independently removed → no dangling connection persists.

**DI-3 `[A?]` — self-write suppression window mismatch.**
- Main-side `FileWatcher.suppress()` defaults ~500 ms (`fileWatcher.ts:284`); renderer `recentSelfWrites` TTL is 1.5 s / 5 s-bulk (`writeStateTracking.ts:38-39` `[V]`). On very slow/network disks the main window can expire before the OS event; the renderer backstop normally covers it.
- **Fix (optional):** align main-side suppression with the renderer's adaptive bulk window, or extend it while writes are in flight. Verify `fileWatcher.ts:284` first.

**DI-4 `[A?]` — rename hash gate uses lazy cache.**
- `correlateRenames` (`renameCorrelation.ts:230-240`) can resolve both hash sides from `lastKnownHashes`, weakening the same-size+same-ext mispair guard. Theoretical; a mispair rewrites tile `src`/`file` refs to the wrong file.
- **Fix (optional):** force a fresh disk hash for the present-side before pairing, or tighten the gate. Confirm the cited lines first.

- **Acceptance:** new tests for SC-1/DI-2; gates green. DI-3/DI-4 are opportunistic.
- **Risk:** low. (SC-1 is slightly more aggressive — corrupt sizes now route to recovery instead of being silently fixed; that's the intended fail-loud behavior.)

---

## Phase 3 — UI/UX (UX-1…UX-4) (~half day; confirm line numbers at edit time)

All `[A?]` — from the breadth scan; open each file to confirm the exact line.

**UX-1 — media tiles lack `onerror` fallback.** Add an error handler + fallback UI mirroring the existing pattern in `AudioTile.svelte:307` / `IframeTile.svelte:111`.
- Files: `src/renderer/components/tiles/ImageTile.svelte:85`, `src/renderer/components/tiles/VideoTile.svelte:57-63`, `src/renderer/components/boards/KanbanCard.svelte:304`.
- Test: render with a missing `src` → fallback shown (Playwright or jsdom smoke).

**UX-2 — HomeScreen nested interactive controls.** Restructure the recent-project row so it's not a `<button>` containing pin/remove `role="button"` children — use a non-button row with sibling buttons (keeps keyboard/AT semantics valid).
- File: `src/renderer/components/home/HomeScreen.svelte:276-322`.

**UX-3 — emoji as chrome.** Replace `🌍` (IframeTile empty-state) and `📅`/`🕐` (TaskQuickAddInput preview chips) with inline 24×24 SVGs (matching the FileTile/ImageTile convention). Waypoint emoji are user content — excluded.
- Files: `src/renderer/components/tiles/IframeTile.svelte:152`, `src/renderer/components/boards/TaskQuickAddInput.svelte:152,156`.

**UX-4 — z-index literals + hard-coded colors.** Move inline `z-index` literals onto the `--z-*` scale and replace literal accent `rgba(108,99,255,…)` / `#000` / `#fff` with the existing accent CSS vars.
- Files: `PaneDropOverlay.svelte:104`, `MindMapBoard.svelte:838,862`, `TagsBrowser.svelte:364`, `TaskListSideToolbar.svelte:857`; `HomeScreen.svelte` (accent rgba), `VideoTile.svelte:96`, `TileContainer.svelte:451-452`.

- **Acceptance:** gates green; broken-media fallback visible; HomeScreen row keyboard-navigable; no emoji chrome; axe-core scan unchanged or improved.
- **Risk:** low. UX-4 is cosmetic; verify no stacking regressions against modals/popups.

---

## Cross-cutting conventions (apply in every phase)

- Add/extend unit tests in `src/tests/unit/` mirroring `src/` structure — this repo expects coverage with each change.
- Run `npm run ci:verify` at each phase boundary (lint → check → strict tests → build → 21 gates).
- No `as any` / `as unknown as` without `// allow-cast:`; route any new persisted state through the vault.
- UI changes aren't fully validated by unit tests — click-test in the running Electron app where feasible.

## Suggested sequencing

`0 → 1 → 2 → 3` are independent and can ship as separate small PRs. Phase 1 (DI-1, UR-1) is the highest-value correctness work; Phase 0 is free; Phases 2–3 are robustness/polish.

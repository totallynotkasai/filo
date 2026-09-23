# Filo — Audit Remediation Plan (2026-05-31)

Independent multi-agent data-integrity & systems audit (14-finder fan-out + adversarial
verification), followed by a **manual first-party re-read of every High and a sample of the
Mediums against the live code**. This plan lists only what survived that re-read, plus the
sweep's lower-confidence leads clearly marked as "reproduce first."

> **Headline:** The *infrastructure* — atomic writes, the debounced flush/scheduler layer,
> crash recovery, and the IPC/security boundary — is genuinely strong (8–9/10) and safe to
> trust with real data. The defects cluster in the **feature layer** (Orphan Catcher,
> board-file load dedup, rename→search, frontmatter↔cache sync), which the type-checker,
> linter, and 3027 passing tests cannot see. One user-facing feature (Orphan Catcher) is
> outright broken. There is **no catastrophic content-loss bug** in the write path.

---

## How to use this plan

**Provenance** — be appropriately skeptical per class:

- ✅ **confirmed** — I opened the cited file this audit and verified the mechanism *and* a
  concrete trigger path. Safe to fix directly (still write the regression test first).
- 🔍 **reported** — surfaced by a sweep agent with a plausible mechanism, but **I did not
  finish verifying it**. The sweep had a measured ~25% false-positive/stale rate (it
  hallucinated line numbers and audited since-fixed files). **Reproduce with a failing test
  BEFORE fixing.** If you can't write a failing test, the bug isn't real — downgrade to a
  doc note.
- 🔵 **defense-in-depth** — no reachable exploit/loss found today; harden anyway.

**Severity** is my re-adjudicated priority. **Effort:** S ≈ <1h · M ≈ a few hours · L ≈ a day+.
**Risk** is the chance the *fix itself* regresses something.

**Discipline for every fix (non-negotiable):**
1. Write the regression test that demonstrates the bug and **watch it fail**.
2. Fix the smallest thing that makes it pass.
3. `npm run ci:verify` green end-to-end (lint → check → test → build → all 21 guard scripts).
4. One commit per item where practical. Reference the item ID (e.g. `H1`) in the message.

> **Before Phase 1:** confirm an independent file-level backup of your real vault exists and a
> restore has been tested once. Filo's format is plain Markdown + JSON, so any generic backup
> tool works. The app's crash-safety cannot protect against an accidental delete or a fix that
> regresses — the backup is the universal net. (git already covers the source tree.)

### Phase summary

| Phase | Theme | Items | Risk addressed |
|---|---|---|:--:|
| 1 | Confirmed High — user-visible correctness | 2 | Broken feature, silent board loss (1.3 rename→search **refuted**) |
| 2 | Confirmed Medium — source-of-truth / sync integrity | 3 | Three-store divergence, false-comment landmine |
| 3 | Confirmed Medium/Low — canvas, security carve-outs | 3 | Wrong-pane edits, `.filo/` read gap, config clobber |
| 4 | Reported — undo/redo & persistence (reproduce first) | 5 | **DONE 2026-05-31:** 4.1 + 4.5 fixed; 4.2/4.3/4.4 REFUTED (failing-test bar) → Appendix A |
| 5 | Reported — canvas / reactivity / lifecycle | 8 | **DONE 2026-05-31:** 5 fixed (5.2/5.3/5.5/5.7/5.8); 5.1/5.4/5.6 REFUTED (failing-test bar) → Appendix A |
| 6 | Defense-in-depth — security & crash detection | 3 | **DONE 2026-05-31:** 6.2 + 6.3 fixed; 6.1 RESOLVED (premise stale — meta/header CSP already agree) |
| 7 | Hygiene — docs, dead-comment drift, perf | 6 | **DONE 2026-05-31:** all 6 fixed. 7.1/7.2 CLAUDE.md drift; 7.3 deleted dead fn (0 callers); 7.4 reproduced+fixed (authored tag order); 7.5/7.6 defense-in-depth; main chunk −562 kB |

**Appendix A** lists what I REFUTED or found ALREADY-FIXED — read it before "fixing" anything
that looks deliberate. **Appendix B** is the per-area rating table. **Appendix C** is the
quick file→item index.

---

## Phase 1 — Confirmed High-severity correctness (do first)

Each is user-visible, independently verified, and cheap relative to impact.

### 1.1 ✅ Orphan Catcher flags EVERY text tile as "Empty" — **HIGH**
- **Area:** canvas / correctness
- **Files:** `src/renderer/lib/canvas/orphanCatcher.ts:41-48` (`isEmptyTextTile`), `:64`
  (`findOrphans`); consumer `src/renderer/components/modals/OrphanCatcher.svelte`
- **Problem:** `isEmptyTextTile` reads `(tile as { content?: string }).content ?? ''`, but a
  text tile does **not** carry its body on the tile object — the body lives in `documentStore`
  / the backing `.md` (the `Tile` schema has no `content` field). So `content` is always
  `undefined → ''` and the function returns `true` for *every* text tile. `findOrphans` tags
  them all `reason: 'empty'`; the modal shows a red "Empty text tile" badge on each, and the
  bulk-delete paths will remove every text-tile placement. Mitigations that keep it from being
  catastrophic: bulk delete confirms, the action is undoable, and `.md` files are preserved.
  **No test covers this** — the one orphan test deliberately uses an image tile so the function
  never fires.
- **Fix:** Determine emptiness from the real body source. Resolve the tile's backing document
  (`documentStore.getDocument(tile.contentId)` or the convention `.md`) and test that text. At
  minimum, make absence ≠ empty: `if (typeof (tile as {content?:string}).content !== 'string') return false;`
  so a tile with no `content` field is never classified empty. Prefer passing resolved body text
  into `findOrphans` so the pure function stays pure.
- **Test:** A text tile whose backing document has content is NOT reported as an `empty` orphan;
  a genuinely blank one still is.
- **Effort:** S–M · **Risk:** Low

### 1.2 ✅ Two `.board.json` with the same `board.id` silently collapse on load — **HIGH**
- **Area:** schema / board load / data-integrity
- **Files:** `src/renderer/lib/boards/boardLoader.ts:637-641` (`loadAllBoards`);
  `src/renderer/lib/vault/vaultCandidate.ts` (ProjectSchema fallback);
  `src/renderer/schema/project.ts` (`uniqueBy('id','boards')`)
- **Problem:** `loadAllBoards` keys everything by `board.id` with no duplicate detection:
  `cache[data.board.id] = data` (second file silently overwrites the first), `paths[...] = relPath`
  (only the second path survives → the first board is unreachable and all its future saves target
  the survivor's file), and `Object.assign(connections, …)` + `frames.push(…)` merge
  **unconditionally across files** (the survivor absorbs the loser's connections/frames). The
  `ProjectSchema.uniqueBy('id')` safety net is bypassed downstream (vaultCandidate falls back to
  the *unvalidated* object on parse failure). Trivially produced by copying a `.board.json` in the
  OS file manager or restoring one from backup into the same vault — normal acts for a local-first
  app.
- **Fix:** In `loadAllBoards`, when `data.board.id` already exists in `cache`, do NOT overwrite:
  route the colliding file into `failedBoards` with a new `errorKind: 'duplicate-board-id'` and a
  toast naming **both** paths, and skip merging its connections/frames. `vaultCandidate` already
  snapshots `failedBoards` entries to `.filo/recovery/`, so the bytes are preserved. (Alternative:
  key the workspace by file path so two files coexist — larger change.)
- **Test:** Load two envelopes with the same `board.id`; assert the second lands in `failedBoards`,
  the first stays reachable, and the first's connections/frames are unpolluted.
- **Effort:** M · **Risk:** Med (touches the load path — keep the change additive)

### 1.3 ❌ REFUTED (was HIGH) — Folder rename with uppercase does NOT break search
- **Status (2026-05-31):** Test-confirmed non-issue — downgraded to Appendix A. The regression
  test `src/tests/unit/vaultFolderOpsRenameIndex.test.ts` renames an uppercase-named folder
  (`Projects` → `Archive`) and asserts the descendants rebind; it **PASSES against unmodified
  code**, so per this plan's own discipline ("if you can't write a failing test, the bug isn't
  real") the lead is dropped.
- **Why the mechanism was wrong:** the premise — "VaultIndex/MiniSearch keys are stored
  lowercased" — is false. `VaultIndex` keys every entry via `toPosix(...)` (separators only, never
  lowercased: see `lib/vault/vaultIndex.ts` `upsert`/`renameKey`/`get`), and `toVaultRelative`
  (`vaultTreeSort.ts:182`) slices the **original** `absolutePath`, so the `oldRel` handed to
  `renameVaultIndexUnderPrefix` is case-preserved too. `normalizePath` keeps `oldKey`/`childPrefix`
  case-preserved, so `"Projects/Note.md".startsWith("Projects/")` already matches and the
  descendant rebind already works. The case-insensitive `normalizeVaultRelative` fold the audit
  pointed at is used only for the `knownPaths` set and the branded `VaultPath` map keys — **not**
  the search index.
- **Do NOT apply the proposed fix:** lowercasing the keys via `normalizeVaultRelative` would make
  `childPrefix = "projects/"`, which fails the case-sensitive `startsWith` against the
  case-preserved `"Projects/Note.md"` (and `index.renameKey`'s case-preserved lookup would miss) —
  it would **regress** the currently-correct behaviour. Full evidence in Appendix A.

---

## Phase 2 — Confirmed source-of-truth / sync integrity

### 2.1 ✅ `boardFile.ts` superRefine justifies itself with a normalization pass that doesn't exist — **MEDIUM**
- **Area:** schema / data-integrity
- **Files:** `src/renderer/schema/boardFile.ts:113-146`; `src/renderer/lib/boards/boardLoader.ts:126-231`
  (`pruneOrphanRefsAndDuplicates`); write-back at `boardWriteScheduler.ts:142+`
- **Problem:** The superRefine detects a nested `connection.boardId` / `frame.boardId` / mindmap
  `group.boardId` that disagrees with `envelope.board.id`, but only `console.warn`s (never
  `ctx.addIssue`), justified by the comment "the loader-side normalisation pass in
  `boardLoader.pruneOrphanRefsAndDuplicates` already fixes the mismatch." I read that function in
  full — **it never reads or writes any `boardId` field.** So a stale/foreign `boardId` is neither
  rejected nor repaired, and round-trips back to disk on every save. Latent today; an active hazard
  combined with 1.2's cross-file merge (a copied board's connections merge under a foreign board
  while a stale `boardId` masks the mixup).
- **Fix (pick one):** (a) **Make the comment true:** in `pruneOrphanRefsAndDuplicates` (or an
  adjacent loader pass), rewrite `conn.boardId` / `frame.boardId` / `group.boardId` to
  `envelope.board.id` when they differ, record it in the prune report, and mark the board dirty
  (like `groupsBackfilled` / `orphansPruned`) so the corrected values reach disk. **(b) Minimum:**
  fix the false comment so no future maintainer relies on a step that isn't there.
- **Test:** Load an envelope whose connection/frame `boardId` differs from `board.id`; assert the
  loaded-then-persisted shape has them normalized (option a) — or at least that the behavior matches
  the documented intent.
- **Effort:** S (comment) / M (real normalization) · **Risk:** Low

### 2.2 ✅ Tag rename/remove is case-SENSITIVE while tag identity is case-INSENSITIVE everywhere else — **MEDIUM**
- **Area:** tags / sync-conflict
- **Files:** `src/renderer/lib/vault/tagRewriteSweep.ts:146` (candidate filter);
  `src/renderer/lib/vault/tagRewriter.ts` (`rewriteTagInMarkdown` / `removeTagFromMarkdown` /
  `addTagToMarkdown` presence check); identity authority `src/renderer/lib/vault/tagsStorage.ts:238-258`
  (`canonicaliseTagName`, folds via `toLocaleLowerCase('en-US')`); `vaultIndex.filesByTag`
- **Problem:** The sweep selects candidate files with exact `md.tags.some((t) => t === oldName)` and
  the rewriter compares with strict equality, but tag *identity* is case-folded everywhere else
  (registry, index, `valuesEqual`). A file whose frontmatter spells the tag `Project` (authored in
  Obsidian, or because `canonicaliseTagName` preserved a first-seen capital) is **skipped** when you
  rename the registry's `project` → `done`: `tags.json` and tile defs move, the canonical `.md`
  keeps `Project`, and the next external-edit reconcile re-asserts the stale tag. A sibling: the
  `addTagToMarkdown` idempotency check is also case-sensitive, so adding `project` to a file holding
  `Project` appends a duplicate (`[Project, project]`).
- **Fix:** Fold case to match identity. In the sweep candidate filter and in
  `rewriteTagInMarkdown` / `removeTagFromMarkdown` / `applyTagsLineRewrite` / `addTagToMarkdown`'s
  presence check, compare `a.toLocaleLowerCase('en-US') === b.toLocaleLowerCase('en-US')`. Preserve
  the file's own casing for the NEW name and the leading-`#` decision.
- **Test:** Frontmatter `tags: [Project]`, registry tag `project`; rename → assert the `.md` now
  reflects the new name (no stale `Project`); add a case-variant → assert no duplicate.
- **Effort:** M · **Risk:** Med (tag rewriter is delicate — lean on the new fixtures)

### 2.3 ✅ Live external-edit reconcile drops frontmatter fields the tile def doesn't already carry — **MEDIUM**
- **Area:** frontmatter ↔ cache sync
- **Files:** `src/renderer/lib/vault/frontmatterSync.ts:119` (`if (!(field in cache)) continue;`),
  `:233-235` (`reconcileBoardCacheWithFrontmatter`); `tileDefBuilder.ts:26-35`;
  `vaultExternalChanges.ts:134/150` (live path)
- **Problem:** `detectDivergence` only reconciles a synced field already present as a key on the
  cache. A tile def gets a `dueDate`/`priority`/`status`/`completed`/`parent`/`recurrence` key only
  if the frontmatter had it at creation/last-load. So adding `dueDate:` to a task's `.md` in an
  external editor (Obsidian/vim) for a field the tile didn't previously have emits no divergence —
  the live Kanban/Task board never reflects it until a board reload (which uses the unguarded
  `reconcileTextTileDef`). Smart-list filters/sort that read the cached field silently ignore the new
  value mid-session. Not permanent loss — but stale until reload, and the current unit test codifies
  the buggy behavior as intended.
- **Fix:** For fields the canonical frontmatter explicitly carries (`field in canonical`), drop the
  `if (!(field in cache)) continue;` guard — treat an absent cache key as `cached === undefined` and
  let `valuesEqual` decide. In `reconcileBoardCacheWithFrontmatter`, seed `cacheSubset` for every
  field returned by `canonicalValues(metadata)`, not only those already on the def. Keep the
  "don't pollute" behavior only for fields ABSENT from canonical. Update the stale test.
- **Test:** Create a task `.md` with no `dueDate`; externally add `dueDate`; advance the watcher;
  assert the cache/board reflects it without a reload.
- **Effort:** M · **Risk:** Med (sync path — verify no spurious writes for absent fields)

---

## Phase 3 — Confirmed canvas + security carve-outs

### 3.1 ✅ Split-pane wheel-zoom / drag-pan scrolls the WRONG canvas — **MEDIUM**
- **Area:** canvas / reactivity
- **Files:** `src/renderer/lib/canvas/gestures.ts:1` (imports the global `canvasStore` facade), `:52`
  (`panBy`), `:81/:93` (`zoomBy`); attached per-pane at `MindMapBoard.svelte:619`; the already-fixed
  sibling pattern is `edgePan.ts:18-24`
- **Problem:** `viewportAction` is attached per-pane but mutates through the **global** `canvasStore`
  facade, which delegates to whichever pane is active. A mouse wheel produces no pointerdown to
  activate the pane under the cursor, so scrolling over an inactive pane zooms the *active* pane —
  and persists the wrong board's viewport to `.filo/viewports.json`. `edgePan` was already refactored
  to take a per-pane `CanvasScope`; `viewportAction` never got the same fix.
- **Fix:** Make `viewportAction` accept the pane's `CanvasScope` as a parameter (mirror
  `startEdgePan(scope)` / `edgePanAction`) and call `scope.panBy` / `scope.zoomBy`. Wire from
  MindMapBoard as `use:viewportAction={canvasStore}` (the pane-local scope alias). Single-pane is
  unchanged.
- **Test:** With two mounted panes, dispatch a wheel event over the inactive pane; assert only that
  pane's scope `zoomBy` is called.
- **Effort:** M · **Risk:** Med (gesture plumbing — exercise single + split pane)

### 3.2 ✅ `filo://` media protocol skips the `.filo/` read guard every other channel enforces — **LOW**
- **Area:** IPC / security boundary
- **Files:** `src/main/protocol/filoMedia.ts:49-55`; guards in `src/main/utils/pathSecurity.ts`
- **Problem:** The handler resolves the decoded path with only `assertWithinVault`. It does NOT call
  `assertNotInFiloDir` or `assertSafeRelativePath`, unlike every other generic renderer-facing read
  channel. Path traversal (`../`) is still blocked, so this is **not** an out-of-vault read — the gap
  is strictly the `.filo/` carve-out and the per-segment structural validation. A hand-edited tile
  `file` pointing at `.filo/...`, or `fetch('filo://media/.filo/tags.json')`, streams config bytes.
  Not an escalation (the renderer already has sanctioned IPC for the same files), but it diverges
  from the project's own stated threat model.
- **Fix:** After computing `relPath`, call `assertSafeRelativePath(relPath)` then
  `assertNotInFiloDir(relPath)` before `path.join`, returning 403/404 on rejection — matching
  `vault:read-file-text`.
- **Test:** `filo://media/.filo/tags.json` returns 403/404; a normal media path still streams.
- **Effort:** S · **Risk:** Low

### 3.3 ✅ `appearance.json` save drops on-disk `snippets` despite a comment claiming it preserves them — **LOW**
- **Area:** config write / data-integrity
- **Files:** `src/renderer/lib/boards/configWriteScheduler.ts:198-208`; `src/main/vault/configOps.ts`
  (`saveConfig` → `atomicWriteFile`, whole-file replace); seed at `configOps.ts` `initVaultConfig`
- **Problem:** `buildConfigPayloads` writes `appearance.json` as a 2-key object
  (`{ activeTheme, font }`). `atomicWriteFile` is a tmp+rename whole-file replace, not a
  read-modify-write merge, so the next theme/font change overwrites any `snippets` array on disk.
  `initVaultConfig` seeds `snippets: []`, confirming it's a real on-disk member. Not user-visible
  today (the renderer carries no snippets in memory), but the in-code comment misleads, and a
  hand-added `snippets` (or a future build) is silently stripped. Contrast `app.json` (`:176`) which
  spreads `...settings.general` first specifically to preserve unknown keys.
- **Fix (pick one):** (a) round-trip unknown keys like `app.json` (keep the last-loaded appearance
  object and spread it before pinning `activeTheme` + `font`); or (b) if appearance is intentionally
  Filo-owned, delete the misleading comment AND stop seeding `snippets: []` so disk shape and
  ownership agree. (a) is safer.
- **Test:** Seed `appearance.json` with a `snippets` array; trigger a theme change; assert `snippets`
  survives (option a).
- **Effort:** S · **Risk:** Low

---

## Phase 4 — Reported: undo/redo & persistence (REPRODUCE FIRST)

🔍 Every item here is a sweep lead I did **not** finish verifying. Write the failing test first; if
you can't, it isn't real — move it to Appendix A. These matter because they touch persistence.

### 4.1 🔍 `DeleteTilesCommand.execute()` (redo) may not re-remove cross-board connections that undo restored — **MEDIUM**
- **Files:** `src/renderer/commands/tileCommands.ts:239-275` (execute), `:371-401` (restorePlacements)
- **Problem (claim):** `undo()` re-adds cross-board connections via `boardCacheStore.persistAddConnection`
  (onto inactive boards), but `execute()`/redo only loops `boardStore.removeTile(...)` on the active
  board and never iterates `this.connections` to remove them. If `removeTile` doesn't cascade a delete
  of every connection across all boards' caches, a delete→undo→redo can leave a dangling edge in an
  inactive board's `.board.json`.
- **Fix (if reproduced):** In `execute()`, after the removeTile loop, remove every snapshotted
  connection symmetrically with undo — same-board via `boardStore.removeConnection`, other-board via
  `boardCacheStore.persistRemoveConnection`.
- **Test:** Build a multi-tile delete whose connections span boards; delete → undo → redo; assert no
  dangling connection remains in the inactive board's cache.
- **Effort:** M · **Risk:** Med

### 4.2 ❌ REFUTED (was MEDIUM) — undo()/redo() do NOT leave the inactive board unscheduled
- **Status (2026-05-31):** Test-confirmed non-issue — downgraded to Appendix A. The regression
  guard `src/tests/unit/historyBoardSpanningDirty.test.ts` dispatches a board-spanning
  `CascadeDeleteCommand` through `historyStore.execute → undo` (exercising the exact
  `dirtyId = command.targetBoardId || activeBoardId` line at history.svelte.ts:442), drains the
  delete's scheduled writes, then proves the **inactive** board's `.board.json` write IS scheduled
  by the undo (a `board:save` fires for it, carrying the restored tile). It **PASSES against
  unmodified code**, so per this plan's discipline the lead is dropped.
- **Why the mechanism was wrong:** the premise — "only `activeBoardId` is marked dirty" — ignores
  that the plan's own proposed fix ("have the `persist*` cache writers mark their target board dirty
  internally") is *already implemented*. Every cache writer calls `ctx.markDirty(resolvedBoardId)`
  with the board it actually mutated, not the active board: tiles via
  `core/boardTileOps/mindmap.ts` (`addTile`/`removeTile`/`updateTile`), connections via
  `core/boardConnectionsOps.ts` (`addConnection`/`removeConnection`). So when
  `CascadeDeleteCommand.undo()` calls `persistAddTile`/`persistAddConnection` on an inactive board,
  that board is flagged by the op itself. The history dispatcher's `dirtyId` line is redundant
  belt-and-suspenders for board-spanning commands, not the sole scheduler.
- **Do NOT "fix" it:** adding a second markDirty loop keyed off the command's affected boards would
  duplicate work already done by the cache ops (the scheduler debounces, so it's harmless, but the
  code would imply the cache layer doesn't self-flag — a false signal for future maintainers).
- **Note on the guard:** `ci:commands-target-board` is unrelated to dirty-marking — it only asserts
  every Command declares `targetBoardId`. `CascadeDeleteCommand`'s `''` is intentional (skips the
  cross-board *undo-redirect* toast), and is independent of dirty scheduling. No conflict.

### 4.3 ❌ REFUTED (was MEDIUM, conf low) — full BatchCommand rollback stays consistent; only the documented partial-rollback path can dangle
- **Status (2026-05-31):** Refuted as an actionable defect — downgraded to Appendix A. The guard
  `src/tests/unit/batchCommandGroupTileConsistency.test.ts` runs the plan's own test spec — a real
  `ToggleGroupCommand` (the whole-array `replaceGroups` command the claim names) MERGED into an
  existing group, plus an element-level tile delete, then a child that throws on execute — and
  asserts the FULL rollback returns the exact pre-batch state with no group referencing a deleted
  tile. It **PASSES against unmodified code.**
- **Why the mechanism was wrong:** the groups slice and the tiles slice are independent, and the
  LIFO rollback restores each correctly. Because rollback walks `executed` in REVERSE, the
  element-level tile-restore runs BEFORE the whole-array `replaceGroups`, so the restored groups
  snapshot references tiles that already exist again. A normal (full) rollback can therefore never
  leave a dangling group→tile reference. (The premise "replays per-child inverses in the same
  direction as the failed pass" also misreads the code — it's reverse/LIFO.)
- **The only inconsistency path is already documented + surfaced:** a *dangling* group→tile ref
  requires a **partial** rollback — i.e. a child's own `undo()` ALSO throwing while a whole-array
  `replaceGroups` succeeds, restoring a group that references the tile the failed undo didn't bring
  back. That is precisely the case `BatchCommand` already flags via the D.5 "Inconsistent state"
  modal (`openBatchRollbackFailureModal`), which tells the user the batch is half-applied and to
  close without saving. It is a surfaced limitation, not silent corruption.
- **Do NOT apply the proposed fix:** the "coarse pre-batch snapshot of all affected slices" option
  can't be done generically — `BatchCommand` accepts arbitrary `Command` children across every board
  type, so "all affected slices" is effectively the whole board, which defeats the per-command
  snapshot memory discipline. And it wouldn't even fix the case where the tile-restore IS what threw.
  If the partial-rollback dangle is ever judged worth hardening, the right move is to record it in
  `KNOWN_LIMITATIONS.md` next to the D.5 modal, not to re-architect `BatchCommand`.
- **Note:** Consistent with the conf-low rating and the prior withdrawn `BatchCommand.undo` claim.

### 4.4 ❌ REFUTED (was LOW) — geometric redo faithfully reproduces the original action; no manual-override to lose
- **Status (2026-05-31):** Refuted — downgraded to Appendix A. The guard
  `src/tests/unit/frameMembershipRedoFidelity.test.ts` runs the plan's exact sequence for BOTH named
  commands (`MoveTilesCommand` and `UpdateFrameCommand` resize): action → manual membership tweak →
  undo → redo, asserting redo's membership matches the ORIGINAL action. Both **PASS against
  unmodified code.**
- **Why the mechanism was wrong:** frame membership is **purely geometric** — `updateContainment`
  and `syncTileMembership` (frames.svelte.ts) derive it solely from tile-centre-vs-frame-bounds, and
  EVERY drag/resize re-syncs. There is no persistent "manual membership override" that disagrees with
  geometry, so there is nothing for redo to "lose." A manual `updateFrame({ tileIds })` performed
  after the action is an out-of-band mutation (not a Command): undo discards it by restoring the
  pre-action state, and redo correctly re-derives the original geometric membership. The undo
  snapshot (`frameTileIdsBefore`) is itself just the geometric membership at the before-positions, so
  it never disagrees with what a re-derivation would produce.
- **Why a manual tweak can't strand a redo anyway:** if the "manual adjustment" were a tracked
  Command, pushing it would clear the redo stack — so the move/resize could not be redone while the
  tweak was in effect. The only sequence that reaches redo is action → undo → redo, where the
  snapshot and the geometric derivation agree.
- **Do NOT apply the proposed fix:** capturing an `afterContainment` snapshot to "replay exactly"
  would PIN a stale membership and actually REGRESS the correct behaviour — if a frame or tile
  legitimately moved (or was externally edited) between the action and the redo, the geometric
  re-derivation is the faithful result, not a frozen snapshot.

### 4.5 ✅ FIXED — a debounced board write firing after the `.board.json` is deleted no longer resurrects the file — **MEDIUM**
- **Status (2026-05-31):** Confirmed + fixed (test-first). Failing test
  `src/tests/unit/boardWriteSchedulerDeletedFile.test.ts` armed a write against a path with a drift
  baseline, made `vault:stat` report ENOENT (file deleted), and observed `board:save` fire on
  unmodified code (resurrecting the file). Now passes.
- **Files:** `src/renderer/lib/boards/boardWriteScheduler.ts` (`writeBoardFile` pre-write stat)
- **Problem (confirmed):** `writeBoardFile`'s pre-write `vault:stat` swallowed ENOENT, so a
  `.board.json` deleted on disk (external tool / sync client) while a 300 ms write was armed fell
  through to `board:save`, whose `ensureDir + atomicWriteFile` re-created the directory and file —
  fighting the deletion. The in-app delete path already cancels the armed write (`cancelBoardWrite`);
  this was the *external*-delete-racing-an-armed-write window.
- **Fix applied:** in the pre-write stat's catch, when `invokeOk('vault:stat')` throws
  `IpcEnvelopeError` with `code === 'ENOENT'`, abort the write with a clean `return` (not a throw),
  so the scheduler ends the entry successfully and the recovery sentinel isn't left dirty (mirrors
  `cancelBoardWrite`). Other stat errors (EACCES, transient) still fall through to the legacy write.
- **Scope decision (deviation from the plan's "independent of baseline"):** the abort is gated on a
  PRESENT baseline (the existing `if (baseline !== undefined)` block), NOT fully baseline-independent.
  Rationale: every board's file is created EAGERLY by `board:create` (`persistNewBoard`), so there is
  no legitimate "first write creates the file" path that a baseline-independent ENOENT abort could
  break — but a fully-independent stat-and-abort *would* risk aborting such a write if one ever
  existed, and adds a `vault:stat` to every no-baseline write. A board with no baseline was never
  persisted, so it has no on-disk file to be externally deleted; gating on baseline loses no real
  coverage while staying provably safe for first-creates.
- **Effort:** S · **Risk:** Low (gated strictly on ENOENT + baseline-present; existing scheduler /
  saver suites still green)

---

## Phase 5 — Reported: canvas / reactivity / lifecycle (REPRODUCE FIRST)

🔍 Lower-stakes leads. None is primary content loss. Confirm with a test, then fix or drop.

### 5.1 ❌ REFUTED (was MEDIUM) — manual resize tracks `size.width` exactly; no stale rbush width
- **Status (2026-05-31):** Refuted — downgraded to Appendix A. Guard test
  `src/tests/unit/tileResizeSpatialWidth.test.ts` resizes a real tile wider then narrower through
  `boardStore.updateTile` and asserts the pane's rbush footprint follows `size.width` on the X axis
  (the old wider extent does not linger). It **PASSES against unmodified code.**
- **Why the mechanism was wrong:** the claim rests on three premises that don't hold:
  (1) **`userResizedWidth` does not exist** — no such field in `tile.ts` (or anywhere); both proposed
  fixes are written around it.
  (2) **`renderedWidth` / `renderedHeight` have zero production writers** — grep shows the only `:=`
  sites are the schema definitions (`tile.ts:101,103`); every other reference is a READ in
  `renderedWidth ?? size.width`. So at runtime the coalesce always collapses to `size.width`, and
  placements never persist the rendered fields (`buildPlacement` emits only x/y/width/height/
  locked/faded/frameless). There is no stale value to leave behind.
  (3) the "re-measure effect" (`TileContainer.svelte` ResizeObserver) writes BOTH measured axes
  straight to the spatial index via `updateOrDefer`, not "only renderedHeight"; and `tileResize.ts`
  commits `size: { width, height }` — both axes.
- **Do NOT apply the proposed fix:** branching on / clearing `userResizedWidth` adds a field with no
  writer and no reader; "prefer `size.width` when `userResizedWidth` is true" can never fire. The
  realistic resize path is already correct.

### 5.2 ✅ FIXED — edge-pan during connection drawing armed the wrong pane's scope in split view — **LOW**
- **Status (2026-05-31):** Confirmed + fixed (test-first). `connectionsStore.drawing` is a GLOBAL
  `$state`, so in split view BOTH mounted MindMapBoards' edge-pan effects fire on its transition, and
  the module-singleton `startEdgePan` is first-caller-wins (`if (state.active) return`). The
  first-mounted pane therefore pinned ITS scope even when the user was drawing in the OTHER pane —
  edge-pan scrolled the wrong canvas (the earlier "Audit 5.4" fix pinned a scope but not necessarily
  the right pane's). Failing test `src/tests/unit/edgePanConnectionScope.test.ts` drives the two-pane
  race (inactive pane's effect first) and observed the inactive scope pinned on unmodified code.
- **Files:** `src/renderer/lib/canvas/edgePan.ts` (new `syncConnectionEdgePan` + `getEdgePanScope`);
  `src/renderer/components/boards/MindMapBoard.svelte` (edge-pan effect)
- **Fix applied:** extracted the per-pane decision into `syncConnectionEdgePan(scope, isDrawing,
  isActivePane)` and gated arming on the active pane — an inactive pane is a pure no-op (never arms,
  never stops, so it can neither pin its own scope nor cancel the active pane's pan). A connection
  draw activates its pane first (PaneView capture-phase pointerdown → `setActiveScope`), so the
  drawing pane is always the active one; single-pane is unchanged (the sole pane is active while
  drawing). MindMapBoard's effect now calls
  `syncConnectionEdgePan(canvasStore, !!connectionsStore.drawing, isActiveScope(scope))`.
- **Effort:** M · **Risk:** Low (single-pane behaviour identical; only the inactive split pane changes)

### 5.3 ✅ FIXED — `announce()` auto-clear timer now cancelled on unmount — **LOW (hygiene)**
- **Status (2026-05-31):** Confirmed + fixed. Both boards carried byte-identical inline `announce()`
  logic that armed a 4s `setTimeout` and never cleared it in `onDestroy`; a board unmounted within the
  window left the timer to fire against torn-down `$state` (harmless under Svelte 5, but unhygienic).
- **Files:** new `src/renderer/lib/utils/ariaAnnouncer.svelte.ts` (`createAriaAnnouncer`);
  `TaskListBoard.svelte` + `KanbanBoard.svelte` (consume it, `dispose()` in `onDestroy`)
- **Fix applied:** extracted the duplicated logic into a testable `createAriaAnnouncer()` helper whose
  `dispose()` cancels the pending clear timer; both boards now call `announcer.dispose()` in their
  existing `onDestroy`. Behaviour (zero-width-space repeat padding, 4s auto-clear) is preserved
  exactly; the `.tasklist-sr-live` / `.kanban-sr-live` aria-live regions now read `announcer.message`.
- **Test:** `src/tests/unit/ariaAnnouncer.test.ts` — auto-clear fires after the delay; `dispose()`
  cancels it so no late write occurs; repeat-padding verified.
- **Effort:** S · **Risk:** Low

### 5.4 ❌ REFUTED (was LOW) — the registry is armed by `vault:init-config` before `vaultPath` flips
- **Status (2026-05-31):** Refuted — downgraded to Appendix A. Guard test
  `src/tests/unit/vaultOpenRegistryOrder.test.ts` records `loadVaultCandidate`'s IPC order and asserts
  `vault:init-config` is the FIRST call. It **PASSES against unmodified code.**
- **Why the mechanism was wrong:** the registry is not armed by `vault:watch`. `vault:init-config`
  (`board.ipc.ts:120` → `vaultRegistry.setCurrentVault(vaultRoot)`) is the registration vector, and
  `loadVaultCandidate` awaits it as its FIRST IPC (`vaultCandidate.ts:149`). `openVault` awaits
  `loadVaultCandidate` (`vault.svelte.ts:876`) BEFORE the synchronous `commitVaultCandidate` that flips
  `vaultPath` (`:882`). So by the time the renderer considers the vault open — and the user can trigger
  a write — the main-side registry already points at the new vault and `assertActiveVault` passes. The
  fire-and-forget `vault:watch` in `runPostCommitTasks` (`:442`, itself `await`ed internally) only
  starts the file watcher and re-confirms the already-armed registry. board.ipc.ts:115-120 and
  vault.ipc.ts:444 both document this ordering as intentional.
- **Do NOT apply the proposed fix:** awaiting `vault:watch` before `openVault` returns is unnecessary
  (the registry is already armed) and would needlessly block the open transaction on the watcher start.

### 5.5 ✅ FIXED — `SpatialScope.clear()` force-closes an open batch so a reload mid-drag re-derives culling — **LOW**
- **Status (2026-05-31):** Confirmed + fixed (test-first). During a multi-tile drag, `beginBatch`
  raises `_batchDepth` and `bumpRevision()` defers (`_pendingBump = true`, no `revision++`). `clear()`
  (called by `rebuildSpatialIndex` on board reload / external-change reconcile) ran `bumpRevision()`
  WITHOUT resetting `_batchDepth`, so the clear + every re-`insert()` during repopulation stayed
  deferred — reactive viewport culling (which reads `revision`) kept the pre-reload view and the
  reloaded tiles flickered out until the drag's `endBatch`. Failing test
  `src/tests/unit/spatialClearBatchDepth.test.ts` opened a batch, called `clear()` + `insert()`, and
  observed `revision` unchanged on unmodified code.
- **Files:** `src/renderer/stores/spatial.svelte.ts` (`clear()`)
- **Fix applied:** `clear()` resets `_batchDepth = 0; _pendingBump = false` before `bumpRevision()`,
  so a wholesale rebuild bumps the revision immediately regardless of an open drag batch; the drag's
  eventual `endBatch()` safely no-ops (depth already 0). The ordinary per-tile defer path is unchanged
  (the existing `spatialBatchDefer` suite + a guard assertion both stay green).
- **Effort:** S · **Risk:** Low (only the clear/rebuild path changes; per-frame drag deferral intact)

### 5.6 ❌ REFUTED (was LOW) — including source/target tiles as obstacles does not defeat smart routing
- **Status (2026-05-31):** Refuted — downgraded to Appendix A. Guard test
  `src/tests/unit/smartPathObstacles.test.ts` runs `computeSmartPath` (a) on a clear direct
  bubble-to-bubble path and (b) routing AROUND a middle obstacle, both with the source AND target
  tiles present in the obstacle set, and asserts the result is an A* polyline (`L` segments), NOT the
  curved (`C`) fallback. Both **PASS against unmodified code** — A* succeeds, obstacle avoidance intact.
- **Why the mechanism was wrong:** (1) `segmentIntersects` (`pathRouter.ts:172-185`) uses a `±0.1`
  buffer (`o.minX + buf` / `o.maxX - buf`), so a segment leaving/arriving at a bubble that sits ON a
  tile edge does NOT register as intersecting that tile — the "first/last segments graze their own
  tiles" premise is false. (2) The curve fallback is gated on `MAX_ITER` (500) exhaustion, which is
  bound by GRID SIZE (obstacle count → Hanan lines), not by whether 2 of N tiles are the endpoints;
  excluding the source/target wouldn't change convergence on a dense board. (3) Including the
  source/target as obstacles is DESIRABLE — it stops the path cutting through its own tiles.
- **Do NOT apply the proposed fix:** excluding source/target would let A* route a segment straight
  through the connection's own source or target tile (the start point sits on that tile's edge), a
  visual regression, while fixing none of the claimed MAX_ITER behaviour.

### 5.7 ✅ FIXED (retired) — dead `post-swap` vaultLifecycle phase removed — **LOW**
- **Status (2026-05-31):** Confirmed + retired. Grep found zero `onVaultSwap('post-swap', …)`
  registrations; `openVault` never fired post-swap (post-commit work lives in `runPostCommitTasks`),
  and `closeVault` fired it into an empty handler set with `previousVault/nextVault = null`. A
  documented-but-dead extensibility phase that silently never fires is a trap for a future contributor.
- **Decision:** Retire (the plan's recommended, lower-risk option). Wiring it for real was rejected —
  the post-commit hook already exists (`runPostCommitTasks`); a second mechanism would be redundant.
- **Files:** `src/renderer/core/vaultLifecycle.ts` (type narrowed to `'pre-swap'`, docblock,
  `__getRegisteredHandlerNames`); `vault.svelte.ts` (closeVault post-swap fire removed);
  `vaultLifecycleRegistry.test.ts` + `vaultLifecycleCoverage.test.ts` (drop the now-moot two-phase
  dispatch tests / the post-swap key); `scripts/check-vault-lifecycle-coverage.mjs` + a
  characterization comment (prose).
- **Fix applied:** `VaultSwapPhase = 'pre-swap'` — removing the type arm makes `onVaultSwap('post-swap',
  …)` a compile error, so the trap is closed at the type level — removed the dead closeVault fire, and
  rewrote the docblock to state post-commit hydration lives in `runPostCommitTasks`, not a lifecycle
  phase. Coverage script + test stay green (20 subscribed, 13 exempt).
- **Note (5.3 follow-up):** the new `ariaAnnouncer.svelte.ts` (from 5.3) holds function-local `$state`,
  so it was added to the vault-lifecycle coverage EXEMPT list (script + test) alongside the other
  per-instance factories — surfaced while running the coverage gate for this item.
- **Effort:** S–M · **Risk:** Low

### 5.8 ✅ FIXED — `vault:init-config` rolls back the registry when `.filo/` init fails — **LOW**
- **Status (2026-05-31):** Confirmed + fixed (test-first). The handler armed the registry
  (`setCurrentVault(vaultRoot)`) then `await initVaultConfig(...)`; on a throw the catch returned
  `{ ok:false }` with NO rollback, so the half-initialised vault stayed armed. The "a different vault
  is already active" guard (`board.ipc.ts:109`) then blocked a clean re-open of any OTHER vault until a
  close, while the renderer (whose `loadVaultCandidate` threw) believed the open failed. Failing test
  `src/tests/unit/vaultInitConfigRollback.test.ts` mocks `initVaultConfig` to throw and observed the
  registry left armed at the failed vault on unmodified code.
- **Files:** `src/main/ipc/board.ipc.ts` (`vault:init-config` handler)
- **Fix applied:** wrap the `initVaultConfig` await in a nested try that, on failure, restores the
  registry to its PRIOR value (`current`, captured before arming) and re-throws to the existing catch.
  Restoring the prior value — not unconditional null — means a same-vault re-init failure leaves the
  already-active vault armed, and never clobbers a legitimately-active different vault.
- **Test:** rollback-to-null when nothing was armed; stays-armed when a same-vault re-init throws; the
  existing `vaultInitConfigHardening` suite (6 tests) stays green.
- **Effort:** S · **Risk:** Low

---

## Phase 6 — Defense-in-depth (no reachable exploit found; harden anyway)

### 6.1 ✅ RESOLVED (premise stale, 2026-05-31) — meta and header CSP already agree on `connect-src`
- **Status:** No code change needed; the audit's premise is false against current code. The plan claimed
  the `index.html` meta carries `connect-src 'self' ws://localhost:* https:`, but [index.html:6](index.html)
  has `connect-src 'self' ws://localhost:*` — **no `https:`** (the `https:` lives only in `frame-src`/
  `child-src`, intentional for Iframe tiles). The header CSP at [main.ts:98-102](src/main/main.ts) is
  byte-identical, and [main.ts:87](src/main/main.ts) documents that the two are kept in sync. A
  `git log -S` pickaxe for the claimed string returns zero hits in all history — it never existed. So the
  meta already omits `https:` from `connect-src`; renderer `https` fetches are already blocked by the
  meta regardless of whether the header fires. Likely fixed by the prior 2026-05-29 `L4a` header work.
- **Decision (user, 2026-05-31):** No drift-guard added (the "No guard" option) — record resolved and
  move on. (A unit parity guard asserting meta-CSP === header-CSP was offered and declined.)

### 6.2 ✅ FIXED — `asSafeThemeValue` now rejects `;` — **INFO**
- **Status (2026-05-31):** Fixed (test-first), commit `d52cd0a`. Note the comment was already milder than
  the audit described (it no longer claimed `;` was refused — it explained `setProperty` writes one
  declaration), but the behaviour gap was real: a bare `red; color: blue` (no `url(`/`@import`) slipped
  through wherever `CSS.supports` is absent. Failing test
  `src/tests/unit/sharedUntrusted.test.ts` (`rejects a bare \`;\``) returned the string on unmodified
  code; now null.
- **Files:** `src/shared/untrusted.ts` (`THEME_VALUE_BLOCKED_SUBSTRINGS`)
- **Fix applied:** added `;` to the blocklist and rewrote the comment to state `;` is refused outright in
  every environment (jsdom included, where the `CSS.supports` gate is absent and the substring list is the
  sole defence). A single CSS custom-property value never legitimately contains `;`. Decision was "Reject
  `;`" (the safer option) over "Clarify comment."
- **Effort:** S · **Risk:** Low (existing `sharedUntrusted` + `untrustedSinks` suites stay green)

### 6.3 ✅ FIXED — crash during a tag REMOVAL sweep is now detectable — **MEDIUM**
- **Status (2026-05-31):** Fixed (test-first), commit `17b8feb`. Decision was "Per-path progress" (the
  robust option) over the lighter index heuristic or doc-only. Confirmed accurate against live code:
  `hasPartialTagRewriteState` returned `false` for removals (`newName === null`), and although the
  recovery converge path already branched to `removeTagEverywhere`, it was never *reached* for removals.
  (The cited `fileTags.svelte.ts:418/:480` line numbers were stale; the real recovery call site is
  `vault.svelte.ts` §2.)
- **Files:** `src/renderer/lib/vault/tagRewriteSentinel.ts` (payload `committedPaths` +
  `hasPartialTagRemovalState`), `src/renderer/lib/vault/tagRewriteSweep.ts` (incremental breadcrumb),
  `src/renderer/stores/vault.svelte.ts` (recovery dispatch branch + verb-aware copy)
- **Fix applied:** the sweep records `committedPaths` incrementally in the sentinel as each `.md` is
  stripped (REMOVALS only — renames keep index-based detection); a new pure `hasPartialTagRemovalState`
  returns true when ≥1 path was committed. Reopen now branches: removal → `hasPartialTagRemovalState`,
  rename → `hasPartialTagRewriteState`, and a partial removal surfaces "Finalise & discard"
  (idempotent converge-forward) instead of a bare "Discard plan". `readPendingRewrite` defaults
  `committedPaths` to `[]` for pre-6.3 sentinels (forward-compatible). The recovery block was refactored
  (shared `convergeForward` helper, tighter comments) to keep `vault.svelte.ts` under its file-size
  ceiling.
- **Tests:** `tagRewriteSweep.test.ts` (records the breadcrumb on a partial removal — failed on unmodified
  code: `expected undefined to deeply equal [ 'a.md' ]`); `tagRewriteSentinel.test.ts`
  (`hasPartialTagRemovalState` + committedPaths round-trip/validation/legacy-tolerance);
  `vaultTagRewriteRecovery.test.ts` (recovery dispatch — partial removal → finalise; the old "removal
  never finalises" case was updated to the new contract).
- **Effort:** M · **Risk:** Low (removals-only breadcrumb; rename path unchanged; full `ci:verify` green)

---

## Phase 7 — Hygiene: docs, dead-comment drift, perf

These mislead maintainers (and AI agents following the docs) into editing the wrong place. Cheap.

### 7.1 ✅ CLAUDE.md references a non-existent `lib/vault/vaultApi.ts` — **LOW**
- **Files:** `CLAUDE.md` ("The Vault API Contract" section)
- **Problem:** The section is written around `lib/vault/vaultApi.ts` ("ALL file system operations go
  through the Vault API"). That module does not exist (zero hits repo-wide). The behavior lives in
  `lib/vault/fileRefIntegrity.ts` (rename/delete `.board.json` propagation), `stores/vaultFolderOps.ts`
  (in-app rename/delete/move), and the `window.filo` IPC bridge. A contributor following the guide will
  hunt for a phantom file or reimplement reference-propagation in the wrong place.
- **Fix:** Rewrite the section to name the real owners, or mark a single facade as "not yet built."
- **Effort:** S · **Risk:** none

### 7.2 ✅ CLAUDE.md `commands/` tree out of sync with the directory — **LOW/INFO**
- **Files:** `CLAUDE.md` (Project Structure → commands/); `commands/index.ts` header
- **Problem:** The tree attributes tag commands to `tileCommands.ts` but they live in
  `tileTagCommands.ts` (which exists and is re-exported); it omits `Command.ts` (the base interface) and
  `replaceAllCommand.ts`. `commands/index.ts`'s own header also omits several re-exported modules.
- **Fix:** Sync the CLAUDE.md tree and the `index.ts` header to the actual files.
- **Effort:** S · **Risk:** none

### 7.3 ✅ `flushMarkdownWriter()` has a stale "used by rename pipeline" comment + near-duplicate name — **LOW**
- **Files:** `src/renderer/lib/boards/markdownWriteRegistry.ts:128-134`; rename pipeline at
  `commands/renameTitleCommand.ts:18`
- **Problem:** The doc says `flushMarkdownWriter(ownerId)` is used by the tile-title rename pipeline, but
  that pipeline imports the gateway `flushMarkdownWrite` (one character different) from
  `markdownFileWriter.ts`. The shim half (`shimFlushers`, `register/unregisterMarkdownFlusher`,
  `flushMarkdownWriter`) is reachable only from one test. The name collision invites a wrong import.
- **Fix:** Either delete the now-test-only shim surface (production producers all use the gateway), or
  correct the comment to state it's a legacy shim with no production callers.
- **Effort:** S · **Risk:** Low (if deleting, confirm the test is the only consumer)

### 7.4 🔍 Reconciling a tag-set change rewrites the tile def's tag order to sorted — **LOW**
- **Files:** `src/renderer/lib/utils/normalizeTagsField.ts:74`; `frontmatterSync.ts:67, :147`
- **Problem (claim):** `normalizeTagsField` returns `…sort()`. When a genuine tag-set divergence is
  reconciled, the sorted form is written into the tile def while the `.md` keeps the user's authored
  order — cache vs. canonical order divergence. Cosmetic (same set renders).
- **Fix (if it matters to you):** Preserve authored order by deriving from order-preserving
  `parseTagsField(fm.tags)` and deduping case-insensitively first-seen; or document sorted as the
  canonical in-cache representation.
- **Effort:** S · **Risk:** Low

### 7.5 🔵 Tag rename on an anchored/aliased `tags:` field expands the YAML anchor — **LOW**
- **Files:** `src/renderer/lib/editor/markdownSync.ts:301`; `tagRewriter.ts` (`locateTagsField` returns
  null on `[&*]` → `dumpYaml` fallback)
- **Problem:** The formatting-preserving tag rewriter declines anchored/aliased `tags:` fields and falls
  back to `yaml.dump`, which expands the anchor and re-emits the whole block — a stronger, more
  surprising loss than the documented "comments dropped." (The general comment/key-order loss is already
  an accepted limitation in `KNOWN_LIMITATIONS.md`.)
- **Fix:** When `locateTagsField` declines because the field is an anchor/alias, **skip** the rewrite
  (leave the file untouched) rather than taking the lossy dump fallback. Longer term: route all
  frontmatter writes through the `yaml` package's `Document` API and patch only changed keys.
- **Effort:** S (skip) / L (Document API) · **Risk:** Low

### 7.6 🔵 Renderer ships a ~3.3 MB main JS chunk (no code-splitting) — **LOW (perf)**
- **Files:** `electron.vite.config.mts` (build/rollup config); observed in `npm run build` output
  (`index-*.js` ~3.3 MB + `tiptap-*.js` ~1 MB)
- **Problem:** The whole renderer loads as one chunk. Not a correctness issue, but startup parse/eval is
  heavier than necessary; TipTap, lowlight, html-to-image/jspdf are candidates for lazy/dynamic import
  (export and editor-heavy paths aren't needed at first paint).
- **Fix:** Dynamic-import the export service (`html-to-image`/`jspdf`) and consider a `manualChunks`
  split for TipTap/lowlight. Measure cold-start before/after.
- **Effort:** M · **Risk:** Low–Med (lazy boundaries can surface timing assumptions — smoke-test export
  and the editor)

---

## Appendix A — Verified non-issues / ALREADY FIXED / do NOT "fix"

Read this before touching anything that looks deliberate. I checked each against current code.

| Claimed issue | Verdict | Evidence |
|---|---|---|
| Recurrence month-end overflow (Jan 31 → Mar 3) | **REFUTED** | `recurrence.ts:102-118` already clamps via `Math.min(desiredDay, lastDay)`; doc comment `:23-25` states the clamp intent |
| Recurrence schedule-mode skips overdue cycles | **ALREADY FIXED** | `recurrence.ts:148-153` loops `while (next <= today)` — commit `d7021fb` "Phase 1.4" |
| Task dates parsed as UTC → off-by-one (Americas) | **ALREADY FIXED** | `taskListModel.ts:84` `parseLocalDate`, used by `isDeferred`/`smartListMatch`; comment "(Audit 1.1)" |
| Quick-add swallows unrecognized `@date` tokens | **REFUTED** | Current `quickAddParser.ts` uses `@` for *time*; unmatched date text stays in the title (`:241`). Agent audited a non-existent version |
| `core/boardTileOps.ts` + 2 siblings are dead code | **REFUTED** | Actively imported by `board.svelte.ts:32`, `boardCacheTiles.ts:2`, `boardCacheConnectionsFrames.ts:2-3` + tests. Agent hallucinated file contents |
| OrphanCatcher per-row delete is silent | **ALREADY FIXED** | `OrphanCatcher.svelte:61` toast + `:74/:89` confirm dialogs |
| In-app delete doesn't flush `tags.json` before cascade | **ALREADY FIXED** | `vaultFolderOps.ts:818` `await fileTagsStore.flushPendingSave()` — commit `169eb6b` "Phase 4.1" |
| `renameTagEverywhere` doesn't flush `tags.json` | **ALREADY FIXED** | `fileTags.svelte.ts:919` `await this.flushPendingSave()` — "Phase 4.3" |
| Rename-cascade recovery omits `documentStore.updateFilename` | **ALREADY FIXED** | `vaultFolderOps.ts:571` `propagateRename`; commit `8ab7ef8` "Phase 4.4" |
| `vaultExternalChanges.ts` over its file-size ceiling | **ALREADY FIXED** | `npm run ci:file-sizes` passes (file now 1474 LOC, under ceiling) |
| Project not under version control | **ALREADY FIXED** | git repo present, full history; remote `LittleKasai/filo` |
| `atomicWriteFile` / quit-flush / path-traversal guards | **VERIFIED STRONG — do not refactor** | `filenameUtils.ts:142` fsync+rename+tmp-preserve-on-ENOSPC; `main.ts:349` before-quit flush; `assertWithinVault` realpath check |
| `BatchCommand.undo` rollback order | **PREVIOUSLY WITHDRAWN** | A prior sweep self-verified the order/async sequencing are correct (see 4.3 — treat the related claim skeptically) |
| **1.3** Uppercase folder rename breaks descendant search | **REFUTED (this remediation, 2026-05-31)** | VaultIndex keys are case-PRESERVED (`vaultIndex.ts` `toPosix` in `upsert`/`renameKey`/`get`), and `toVaultRelative` (`vaultTreeSort.ts:182`) slices the original path so `oldRel` is case-preserved too; `renameVaultIndexUnderPrefix`'s case-preserved `startsWith` already rebinds descendants. Regression test `vaultFolderOpsRenameIndex.test.ts` PASSES against unmodified code. The proposed `normalizeVaultRelative` lowercasing fix would REGRESS it (`"projects/"` no longer matches case-preserved `"Projects/Note.md"`). The lowercasing fold applies only to `knownPaths` / branded `VaultPath` keys, not the search index. |
| **4.2** undo/redo marks the WRONG board dirty when `targetBoardId` empty | **REFUTED (this remediation, 2026-05-31)** | Every cache writer already calls `ctx.markDirty(resolvedBoardId)` for the board it mutates — tiles (`core/boardTileOps/mindmap.ts`), connections (`core/boardConnectionsOps.ts`). So a board-spanning `CascadeDeleteCommand.undo()` schedules the inactive board's write via the op itself, independent of history's `dirtyId = targetBoardId \|\| activeBoardId` line. Guard test `historyBoardSpanningDirty.test.ts` dispatches the cascade through `historyStore`, drains the delete's writes (control: a redundant flush writes nothing), then asserts the inactive board's `board:save` fires on undo carrying the restored tile — PASSES against unmodified code. The plan's own proposed fix ("persist* writers mark their target board dirty internally") is already implemented. |
| **4.3** BatchCommand rollback double-applies / dangles groups vs tiles | **REFUTED (this remediation, 2026-05-31)** | Groups and tiles are independent cache slices; rollback walks `executed` in REVERSE so the element-level tile-restore runs before the whole-array `replaceGroups`, leaving no dangling group→tile ref. Guard test `batchCommandGroupTileConsistency.test.ts` runs the plan's spec (group merge + tile delete + throwing child → full rollback) and asserts pre-batch state restored with every group ref live — PASSES unmodified. A dangling ref needs a PARTIAL rollback (a child's `undo()` also throwing), which is already surfaced by the D.5 "Inconsistent state" modal (`openBatchRollbackFailureModal`). The proposed coarse-snapshot fix can't be done generically over arbitrary children and would defeat the per-command snapshot discipline. |
| **4.4** Move/UpdateFrame redo re-derives membership geometrically vs undo snapshot | **REFUTED (this remediation, 2026-05-31)** | Frame membership is purely geometric (`framesStore.updateContainment` / `syncTileMembership` use tile-centre-vs-frame-bounds) and every drag/resize re-syncs — there is no persistent manual override to lose. A post-action manual `updateFrame({tileIds})` is out-of-band (not a Command): undo discards it, redo re-derives the original geometric membership. Guard test `frameMembershipRedoFidelity.test.ts` runs the plan's sequence (action → manual tweak → undo → redo) for both `MoveTilesCommand` and `UpdateFrameCommand` resize and asserts redo matches the original action — PASSES unmodified. The proposed `afterContainment` snapshot would REGRESS correct behaviour by pinning stale membership when a frame/tile legitimately moved between action and redo. |
| **5.1** Stale rbush width after resizing an auto-width text tile | **REFUTED (this remediation, 2026-05-31)** | The claim's `userResizedWidth` field does not exist anywhere. `renderedWidth`/`renderedHeight` have zero production writers (only the schema-definition `:=` sites at `tile.ts:101,103`; every other use is a `?? size.width` READ), so the coalesce always yields `size.width` and there is no stale value to retain; placements never persist the rendered fields either. The ResizeObserver writes BOTH measured axes to the index via `updateOrDefer` (not "only renderedHeight"), and `tileResize.ts` commits both axes. Guard test `tileResizeSpatialWidth.test.ts` resizes a real tile wider→narrower through `boardStore.updateTile` and asserts the rbush footprint tracks `size.width` with no lingering extent — PASSES unmodified. The proposed fix references a nonexistent field and would be dead code. |
| **5.4** vault:watch fire-and-forget leaves the registry stale post-open | **REFUTED (this remediation, 2026-05-31)** | The registry is armed by `vault:init-config` (board.ipc.ts:120 `setCurrentVault`), NOT vault:watch. `loadVaultCandidate` awaits init-config as its FIRST IPC (vaultCandidate.ts:149), and `openVault` awaits loadVaultCandidate (vault.svelte.ts:876) before the synchronous `commitVaultCandidate` that flips vaultPath (:882) — so the registry already points at the new vault before the user can write, and `assertActiveVault` passes. `vault:watch` (runPostCommitTasks, itself awaited internally) only starts the file watcher. Guard test `vaultOpenRegistryOrder.test.ts` asserts init-config is the first IPC loadVaultCandidate invokes — PASSES unmodified. Both board.ipc.ts:115-120 and vault.ipc.ts:444 document the ordering as intentional. |
| **5.6** Smart routing includes its own endpoint tiles as A* obstacles | **REFUTED (this remediation, 2026-05-31)** | `segmentIntersects` (pathRouter.ts:172-185) uses a ±0.1 buffer, so a segment leaving/arriving at a bubble ON a tile edge does NOT register as intersecting that tile — the "grazes its own tiles" premise is false. The curve fallback is gated on MAX_ITER (grid-size bound), not on whether 2 of N tiles are endpoints. Including source/target as obstacles is desirable (stops the path cutting through its own tiles); excluding them would risk routing a segment through the connection's own tile. Guard test `smartPathObstacles.test.ts` shows A* produces a polyline (not the curved fallback) on both a direct path and a route-around-obstacle path WITH source+target present — PASSES unmodified. |

**Accepted limitations (do NOT "fix" — see `KNOWN_LIMITATIONS.md`):** lossy YAML round-trip on non-tag
frontmatter writes; attachment tags are vault-local; Windows dir-fsync after rename is a no-op; quit
flush is best-effort under a 5s ceiling; self-write suppression window can misfire on a very slow disk.

---

## Appendix B — Per-area ratings (1–10, this audit)

| Area | Rating | Area | Rating |
|---|:--:|---|:--:|
| Write path & atomicity | 9 | Undo / redo | 6.5 |
| Scheduler / flush layer | 9 | Canvas / Mind Map engine | 6.5 |
| Crash safety & recovery | 8 | Frontmatter ↔ cache sync | 6 |
| IPC & security boundary | 8 | Rename / refs / cascade | 6 |
| Testing | 8 | Schema / migration / load | 6 |
| Build / tooling / VCS | 8 | UX / accessibility | 6.5 |
| State & reactivity (Svelte 5) | 7.5 | **Feature-layer correctness** | **5** |
| Code health / docs | 6.5 | | |

**Overall ≈ 7/10.** Infrastructure is 8–9 and trustworthy; the feature layer is the weak link, and
Orphan Catcher (1.1) is the one outright-broken feature.

---

## Appendix C — File → item index (fastest path when editing)

| File | Items |
|---|---|
| `lib/canvas/orphanCatcher.ts` | 1.1 |
| `lib/boards/boardLoader.ts` | 1.2, 2.1 |
| `stores/vaultFolderOps.ts` | 1.3 |
| `schema/boardFile.ts` | 2.1 |
| `lib/vault/tagRewriteSweep.ts`, `tagRewriter.ts`, `tagsStorage.ts` | 2.2, 7.5 |
| `lib/vault/frontmatterSync.ts` | 2.3, 7.4 |
| `lib/canvas/gestures.ts` + `MindMapBoard.svelte` | 3.1, 5.2 |
| `main/protocol/filoMedia.ts` | 3.2 |
| `lib/boards/configWriteScheduler.ts` | 3.3 |
| `commands/tileCommands.ts`, `frameCommands.ts`, `groupAndBoardCommands.ts` | 4.1, 4.3, 4.4 |
| `stores/history.svelte.ts` | 4.2 |
| `lib/boards/boardWriteScheduler.ts` | 4.5 |
| `stores/boardTiles.ts` + `TileContainer.svelte` | 5.1 |
| `TaskListBoard.svelte`, `KanbanBoard.svelte` | 5.3 |
| `stores/vault.svelte.ts` + `main/ipc/vault.ipc.ts` | 5.4, 5.8 |
| `stores/spatial.svelte.ts` | 5.5 |
| `lib/connections/pathRouter.ts` | 5.6 |
| `core/vaultLifecycle.ts` | 5.7 |
| `index.html` + `main/main.ts` | 6.1 |
| `shared/untrusted.ts` | 6.2 |
| `lib/vault/tagRewriteSentinel.ts` | 6.3 |
| `CLAUDE.md` | 7.1, 7.2 |
| `lib/boards/markdownWriteRegistry.ts` | 7.3 |
| `lib/editor/markdownSync.ts` | 7.5 |
| `electron.vite.config.mts` | 7.6 |

---

## Suggested execution order

1. **Phase 1** (the confirmed Highs — 1.1, 1.2; **1.3 refuted** under failing-test-first) — each ships failing-test-first. ~0.5 day. Highest user value.
2. **Phase 2** (sync integrity) — reproduce the divergence, fix, add fixtures. ~0.5–1 day.
3. **Phase 3** (canvas + security carve-outs). ~0.5 day.
4. **Phase 4** — ✅ DONE (2026-05-31). 4.1 (cross-board connection redo) + 4.5 (deleted-board-file
   resurrection) reproduced with failing tests and fixed; 4.2 (wrong-board dirty), 4.3 (BatchCommand
   rollback dangle), 4.4 (frame-membership redo) all REFUTED under the failing-test bar and moved to
   Appendix A with passing guard tests. Net: the two real defects were both narrow race/edge cases;
   the three "redo asymmetry" leads were already handled by existing mechanisms (per-op markDirty,
   LIFO rollback + D.5 modal, geometric membership).
5. **Phase 5** — ✅ DONE (2026-05-31). 5.2 (edge-pan pane scope), 5.3 (announce-timer leak),
   5.5 (spatial clear/batch), 5.7 (retire dead post-swap phase) and 5.8 (init-config registry
   rollback) fixed; 5.1 (stale rbush width), 5.4 (vault:watch registry lag) and 5.6 (smart-routing
   self-obstacle) REFUTED under the failing-test bar and moved to Appendix A with passing guard tests.
   Net: the canvas/reactivity/lifecycle defects were narrow split-pane / mid-drag / failure-path edge
   cases; the three refuted "asymmetry" leads were already handled (per-pane scope already passed,
   registry armed by init-config, A* edge-touch buffer + endpoint-as-obstacle is desirable).
6. **Phase 6** — ✅ DONE (2026-05-31). 6.2 (theme-value `;` rejection) + 6.3 (partial tag-removal
   detection via a per-path sentinel breadcrumb) fixed test-first; 6.1 (CSP `connect-src` parity)
   RESOLVED — the meta and header already agree (no `https:` in `connect-src`), the premise was stale.
   Net: one real hardening (6.3 removal crash-detection), one contract tightening (6.2), one
   already-resolved.
7. **Phase 7** — ✅ DONE (2026-05-31), all on `main`. 7.1+7.2 (commit 4d28888) reconciled the
   CLAUDE.md Vault-API section + commands/ tree + `index.ts` header against the real code; 7.3
   (2a9dba6) deleted the dead `flushMarkdownWriter` (0 callers, not "one test" — the rename drain
   moved to `withDrainedWrites`); 7.4 (4892815) preserved authored tag order on reconcile via a new
   order-preserving helper (test-first, the lone 🔍 lead — it DID reproduce); 7.5 (2ec0478) skips the
   lossy dump fallback on an anchored/aliased `tags:` field; 7.6 (7551106) lazy-loaded the export
   subsystem (main renderer chunk 3.33 → 2.77 MB, −562 kB). `npm run ci:verify` green end-to-end.

_Every fix: failing test first → fix → `npm run ci:verify` green → one commit referencing the item ID._

> **Provenance reminder:** Phases 1–3 and items 7.1–7.3 are ✅ first-party verified. Phases 4–5, 7.4 are
> 🔍 sweep leads — the burden of proof is a failing test, not this document. If a lead resists a failing
> test after honest effort, move it to Appendix A rather than "fixing" speculatively.
>
> **Update (2026-05-31):** even a ✅ item is not above the test-first bar — **1.3 was marked ✅ but its
> regression test passed against unmodified code, so it was refuted and moved to Appendix A.** Treat the
> ✅ marks as "verified at audit time," not "skip the failing test."

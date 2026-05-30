# Filo — Audit Remediation Plan (2026-05-30)

Independent data-integrity & systems audit. Compiled from first-party verification of
the five highest-stakes subsystems plus a 10-agent breadth sweep (self-refuting) over
the remaining areas. Goal: a phased, actionable checklist of every issue found and how
to fix it, ordered so the riskiest, cheapest wins come first.

> **Headline:** The core persistence engine, crash-safety, and security boundary are
> excellent (8–9/10). There is **no catastrophic data-loss bug**. The single biggest
> *practical* risk is **process, not code** — this working copy is not under version
> control and CI runs only 11 of the 25 guard scripts. Everything below the safety-net
> phase is edge-case hardening, correctness polish, and UX/a11y.

---

## How to use this plan

**Provenance** (be appropriately skeptical of each class):
- 🔬 **verified** — I read the code and confirmed the defect first-hand this audit.
- 🤖 **sweep** — surfaced by a subagent with a self-refutation note. Well-reasoned, but
  **reproduce with a failing test before fixing** — a few are narrow races that may be
  benign in practice.

**Severity** is my re-adjudicated priority (it sometimes differs from the sweep's label,
noted inline). **Effort:** S ≈ <1h · M ≈ a few hours · L ≈ a day+.

**Discipline for every fix:** write the regression test that demonstrates the bug *first*,
then fix, then run `npm run ci:verify` (the full gate set — see Phase 0.3). Don't batch:
one commit per item where practical.

### Phase summary

| Phase | Theme | Items | Risk addressed |
|---|---|---|---|
| 0 | **Safety net** (do before real data) | 3 | No rollback / unenforced gates |
| 1 | P1 correctness bugs | 4 | Visible misbehaviour in normal use |
| 2 | Editor ↔ disk / undo sync races | 6 | Narrow but real content-loss windows |
| 3 | Vault-swap & lifecycle cleanup | 4 | Leaks, hangs, cross-vault bleed |
| 4 | Tag & rename consistency | 5 | Registry drift, broken refs |
| 5 | Correctness polish | 7 | Undo order, stale reads, structure |
| 6 | UX & accessibility | 5 | a11y failures, no-confirm delete |
| 7 | Hygiene, docs, low-priority | 8 | Doc drift, documented limitations |

Verified non-issues and the 18/18 remediation-claim re-check are in the appendices —
**read Appendix C before "fixing" anything that looks deliberate.**

---

## Phase 0 — Safety net (do this BEFORE trusting it with real data)

This phase is the whole reason the report isn't a clean bill of health. None of it touches
app logic; all of it is the difference between "a bug is annoying" and "a bug is permanent."

### 0.1 🔬 Put the project under version control — **critical**
- **Problem:** `git rev-parse` fails — there is no `.git` directory, despite a `.gitignore`
  and a `.github/workflows/ci.yml` being present. No history means no rollback if a bug
  (or one of the last-48h changes) corrupts a board, and no `git diff` review for the
  allowlist/CI changes the guard scripts assume exist.
- **Fix:** `git init` → review `.gitignore` (ensure `node_modules/`, `dist/`, `release/`,
  `coverage/` are ignored) → `git add -A` → initial commit → push to a private remote
  (GitHub/GitLab/Gitea). Commit before starting Phase 1.
- **Effort:** S

### 0.2 🔬 Back up the vault separately — **critical**
- **Problem:** The vault is the user's actual data and lives outside the repo. The app's
  crash-safety is excellent but cannot protect against accidental deletes, a future
  regression, or disk failure.
- **Fix:** Point any file-level backup (versioned cloud sync, Time Machine, restic/Borg,
  etc.) at the real vault directory. Because Filo's format is plain Markdown + JSON, any
  generic backup tool works. Verify a restore once.
- **Effort:** S

### 0.3 🔬 Make CI enforce the full gate set — **high**
- **Problem:** `package.json`'s `ci:verify` chains **25** guard scripts; `.github/workflows/ci.yml`
  runs only **11**. The 14 unenforced ones include the safety-critical
  `ci:markdown-gateway`, `ci:markdown-read-gateway`, `ci:untrusted-sinks`,
  `ci:direct-board-mutations`, `ci:command-snapshot-discipline`, `ci:vault-scoped-state`,
  `ci:check-ipc-envelope-usage`, `ci:vault-path-keys`, `ci:versioned-config`,
  `ci:no-inline-path-normalize[-main]`, `ci:zindex-literals`, `ci:dead-derived`,
  `ci:commands-target-board`. With no git, none run automatically at all.
- **Fix:** Replace the explicit gate list in `ci.yml`'s `verify` job with a single
  `- run: npm run ci:verify` (it already chains everything in the right order), or add the
  missing 14 `- run:` lines. Then confirm a push actually triggers the workflow.
- **Test:** Push a branch with a deliberate `as any` (no `// allow-cast`) and confirm CI fails.
- **Effort:** S

---

## Phase 1 — P1 correctness bugs (surgical, high user-visible value)

### 1.1 🔬 Task dates parsed as UTC → off-by-one in the Americas — **high** (sweep: high)
- **Area:** Kanban & Task List · `kanban-task-1`
- **Files:** `src/renderer/lib/tasks/taskListModel.ts:86` (`isDeferred`), `:100` (`smartListMatch`), `:212` (`groupKey`)
- **Problem:** `new Date("2026-05-20")` parses ISO date-only as **UTC midnight**; after
  `setHours(0,0,0,0)` it becomes the *previous* local day in any UTC-negative zone (all of
  the Americas). "Today" smart-list misses today's tasks; "Overdue" falsely flags them. In
  `groupKey` it's an explicit mismatch — `today` is built local (`new Date(new Date().toDateString())`)
  but `due` is UTC. `dueDateFormat.ts` already does this correctly with local construction.
- **Fix:** Add and use a shared local-date parser at all three sites:
  ```ts
  function parseLocalDate(iso: string): Date | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  }
  ```
  Reuse the existing helper from `dueDateFormat.ts` if exported.
- **Test:** Unit test with `TZ=America/New_York` (set in the test) asserting a task due
  "today" matches the `today` smart list and is not "overdue."
- **Effort:** S

### 1.2 🔬 `addTile` / `batchUpdateTiles` persist Zod-invalid tiles — **high** (sweep: high)
- **Area:** Board cache & CRUD · `persist-cache-1`
- **Files:** `src/renderer/stores/boardTiles.ts:54-62` (`addTile`), `:244-250` (`batchUpdateTiles`)
- **Problem:** Both `console.warn` on `TileSchema.safeParse` failure and then **persist the
  invalid tile anyway** (`validTile = ... : stamped`/`merged`). The sibling `updateTile`
  ([:98](src/renderer/stores/boardTiles.ts:98)) correctly **rejects** with a `return` and a
  comment explaining why. A malformed tile reaching disk is silently dropped by `loadBoard`
  on next open → lost placement (and lost inline data for Link/Iframe/Timer tiles).
- **Fix:** Match `updateTile`'s hard-reject: in `addTile` `if (!parsed.success) { console.warn(...); return; }`;
  in `batchUpdateTiles` `if (!parsed.success) { console.warn(...); continue; }`. Surface a
  one-shot `uiStore.toast` so the drop isn't truly silent.
- **Test:** Unit test feeding a tile with a missing required field asserts no `persistAddTile`/
  `persistUpdateTile` call fires.
- **Effort:** S

### 1.3 🤖 `groupKey` is non-deterministic and ignores injected `today` — **medium** (sweep: medium)
- **Area:** Kanban & Task List · `kanban-task-4`
- **Files:** `src/renderer/lib/tasks/taskListModel.ts:211`
- **Problem:** `groupKey` computes `today` with a bare `new Date()` instead of accepting the
  caller's canonical `today` like every other date fn in the file. Combined with 1.1 it
  double-misclassifies; across a midnight render it can split a bucket.
- **Fix:** Add `today: Date` param to `groupKey` (mirror `smartListMatch`), pass the host's
  already-computed `today`. Fold this into the 1.1 change.
- **Test:** Covered by 1.1's TZ test plus a determinism assertion.
- **Effort:** S

### 1.4 🤖 Recurrence "schedule" mode skips/dupes a cycle when overdue — **medium** (sweep: high)
- **Area:** Kanban & Task List · `kanban-task-2`
- **Files:** `src/renderer/lib/tasklist/frontmatterWriter.ts:130-147`, `src/renderer/lib/tasks/recurrence.ts:125-145`
- **Problem:** In `schedule` mode, `nextDueDate` returns `currentDue + 1 interval` regardless
  of how overdue the task is, so completing a long-overdue recurring task produces a next due
  date that is still in the past (it doesn't advance to the future).
- **Fix:** In `schedule` mode loop `addInterval` until the result is strictly after today:
  ```ts
  let next = addInterval(base, parsed);
  while (next <= startOfDay(today)) next = addInterval(next, parsed);
  return fmtDate(next);
  ```
  Confirm desired semantics with the design doc (some apps intentionally keep one-interval
  steps); if so, this becomes a documentation item instead.
- **Test:** Unit test completing a task 3 intervals overdue asserts next due is in the future.
- **Effort:** S

---

## Phase 2 — Editor ↔ disk / undo sync races (the `documentStore` cluster)

Common root cause: several write paths update the file on disk but not the in-memory
`documentStore` that an open TipTap editor reads from, so the editor's next debounce can
re-clobber the change. **Reproduce each with an open editor before fixing.**

### 2.1 🤖 `ReplaceAllCommand.undo` doesn't sync open editors → undo gets clobbered — **high** (sweep: high)
- **Area:** Undo/redo · `undo-redo-3`
- **Files:** `src/renderer/commands/replaceAllCommand.ts:190-193`
- **Problem:** Undo writes the original content to disk but never updates `documentStore`,
  and `trackComponentWrite` suppresses the watcher event so reconciliation never fires. An
  open editor on an affected file re-saves its stale (post-replace) content within ~300ms,
  silently reverting the undo.
- **Fix:** After the disk writes settle, for each written path with an open document session,
  call `documentStore.setContentFromDisk(path, originalContent)` and cancel any pending
  debounced write via the `markdownWriteRegistry` drain. Apply symmetrically in `execute()`.
  Alternatively, refuse Replace-All when a target file has an open editor.
- **Test:** Open an editor on a file, Replace-All, Undo, advance timers 300ms, assert disk
  content == original.
- **Effort:** M

### 2.2 🤖 `UpdateOrphanFrontmatterCommand.undo` ignores a now-open editor — **medium** (sweep: medium)
- **Area:** Undo/redo · `undo-redo-4`
- **Files:** `src/renderer/commands/kanbanCommands.ts:560-569, :684-742`
- **Problem:** The orphan path assumes `docId: null` (no live editor), fixed at construction
  time. If the user opens the card's file as a Document between execute and undo, the undo
  writes disk but the open editor re-applies the post-edit frontmatter.
- **Fix:** At undo time, re-check for a live `documentStore` session on `relPath`; if present,
  `documentStore.mergeFrontmatter(liveDocId, inversePatch)` and cancel the pending debounced
  write instead of (or before) the disk write.
- **Effort:** M

### 2.3 🤖 Shared `isDirty` per docId races dual TextTile + DocumentEditor — **medium** (sweep: medium)
- **Area:** Document fidelity · `doc-markdown-2`
- **Files:** `src/renderer/stores/document.svelte.ts:347-357`, `TextTile.svelte:136-141`, `DocumentEditor.svelte:374-388`
- **Problem:** `markClean(docId)` clears one boolean shared by all writers; when both a
  TextTile and a DocumentEditor are open on the same file, one writer's flush clears the flag
  and lets the other's `$effect` reload from a stale store body, dropping recent keystrokes
  from the editor (one-cycle flicker; not a disk write of wrong content).
- **Fix:** Either track dirty per-writer (a `Set<callerId>`; only clear `isDirty` when empty)
  or have `DocumentEditor`'s reload `$effect` compare against its own `lastKnownBody`
  (updated on every `onUpdate`) so a reload equal to what it just wrote is a no-op.
- **Effort:** M

### 2.4 🤖 `_italic_` files falsely flagged lossy → editing blocked — **medium** (sweep: medium)
- **Area:** Document fidelity · `doc-markdown-3`
- **Files:** `src/renderer/lib/editor/markdownSync.ts:192-211`
- **Problem:** `normaliseForRoundTripCompare` normalizes list bullets but not emphasis
  delimiters. prosemirror-markdown always serializes `em` as `*italic*`, so a disk file using
  `_italic_` (common in Obsidian) diverges → `isLossyMarkdownRoundTrip` → read-only banner →
  the user can't edit the file without a cosmetic "take ownership" rewrite.
- **Fix:** Normalize emphasis in the comparator: `_x_`→`*x*`, `__x__`→`**x**` (and consider
  `~~`/`~`). Better: use a stable-point check (compare `getMarkdown()` after a second
  load→serialize cycle) to eliminate serializer-variant false positives generally.
- **Test:** A file with `_italic_` loads editable (not read-only).
- **Effort:** M

### 2.5 🤖 Pasted complex tables serialize to literal `[table]` → content lost — **medium** (sweep: medium)
- **Area:** Document fidelity · `doc-markdown-4`
- **Files:** `markdownSync.ts:163-173` (load-only lossy check); tiptap-markdown `table.js`/`html.js`
- **Problem:** A pasted table with merged/multi-paragraph cells is non-serializable; with
  `html:false` it serializes to the literal `[table]`, and the lossy guard only runs at load,
  so the 300ms write loses all cell content. (Internal table creation is safe — no
  merge-cell UI exists.)
- **Fix:** Add a **write-time** guard: if `editorMarkdown(editor)` contains `[table]`/`[taskList]`/
  `[<node>]` sentinels, block the write and show a non-dismissible banner (mirror the
  load-time lossy banner). Longer-term, enable `html:true` for table serialization or convert
  complex tables at paste time.
- **Effort:** M

### 2.6 🔬 Rich formatting (indent/highlight/underline/color/font) silently stripped on save — **medium** (sweep: high)
- **Area:** Document fidelity · `doc-markdown-1`
- **Files:** `src/renderer/lib/editor/createEditor.ts:61-101` (Indent), `:194,:224,:290`; tiptap-markdown `MarkdownSerializer.js`, `html.js`
- **Problem:** These marks/attrs have no Markdown serializer; with `html:false` they serialize
  to empty strings. The load-time lossy check never fires (the disk body never had these
  tokens), so formatting is dropped on the next save with no warning. The toolbar exposes
  these prominently. (Partly inherent — Markdown can't store underline/color — so the fix is
  about *honesty*, not necessarily fidelity.)
- **Fix (pick per feature):** (a) **Minimum:** write-time lossy banner — run
  `isLossyMarkdownRoundTrip(lastLoadedBody, editorMarkdown(editor))` in the update path and
  surface "formatting that won't be saved to Markdown." (b) Add real serializers where a
  Markdown/GFM equivalent exists (`==highlight==`; `<u>` with `html:true`; indent→nested
  list or blockquote). (c) Remove toolbar buttons for formatting with no representation and
  document them as transient.
- **Effort:** M–L (depends on how many features get real serializers)

---

## Phase 3 — Vault-swap & lifecycle cleanup

Cluster: `onVaultSwap`/teardown paths that don't fully tear down. The disk writes are safe
(snapshot-at-fire-time), so these are leaks/hangs/UX, not primary data loss — except 3.3.

### 3.1 🔬 Vault swap hangs a pending confirm dialog's promise — **medium** (sweep: high)
- **Area:** State/reactivity · `store-react-1`
- **Files:** `src/renderer/stores/ui.svelte.ts:421`; `tabs.svelte.ts:130-144, :270-274`
- **Problem:** The `ui` pre-swap handler sets `confirmDialog = null` directly, bypassing
  `cancelTopLayer()` ([:288](src/renderer/stores/ui.svelte.ts:288)) which exists to fire
  `cfg.onCancel?.()` first. A pending `confirmCloseAnyway` promise never resolves → the
  awaiting `close()`/`closeOthers()` is suspended forever, leaving a phantom tab.
- **Fix:** In the pre-swap handler, call `this.cancelTopLayer()` instead of nulling
  `confirmDialog`. That resolves the promise to `false` and lets the close return cleanly.
- **Test:** Open a tab-close confirm, fire a vault swap, assert the `close()` promise settles.
- **Effort:** S

### 3.2 🔬+🤖 `flyTo` animation not cancelled on board switch / pane close — **medium** (sweep: high+medium)
- **Area:** Canvas + State · `canvas-1` + `store-react-2`
- **Files:** `src/renderer/stores/canvas.svelte.ts:159-170` (`setBoard`/`clearBoard`), `:247-287` (RAF)
- **Problem:** `cancelFlyTo()` is called from `panBy`/`zoomBy`/`zoomTo` but **not** from
  `setBoard` or `clearBoard`. A minimap-click animation that's interrupted by a tab/pane
  switch keeps ticking and, on completion, persists the *old* board's end-transform as the
  *new* board's viewport in `.filo/viewports.json` (canvas-1). The same uncancelled RAF leaks
  CPU/state when a pane closes or the vault swaps (store-react-2).
- **Fix:** Add `cancelFlyTo()` as the first statement of `setBoard()` and `clearBoard()`;
  expose a `destroy()` on the canvas scope that calls it and invoke from `PaneView.svelte`'s
  `onDestroy`.
- **Test:** Start a flyTo, call `setBoard(other)`, advance RAF, assert the other board's saved
  viewport is unchanged.
- **Effort:** S

### 3.3 🤖 `loadDocument` can re-add a stale doc across a vault swap → cross-vault file write — **medium** (sweep: medium)
- **Area:** State/reactivity · `store-react-3`
- **Files:** `src/renderer/stores/document.svelte.ts:202` (`loadDocument`), `:400-411` (`clear`)
- **Problem:** `documentStore.clear()` on swap empties the map, but `loadDocument` has no
  vault-active guard. A tile `onMount`/`$effect` firing after `clear()` but before unmount
  re-populates the map with vault-A content under vault-B; a subsequent write could emit a
  `vault:write-file-text` with vault-A's relative path into vault B.
- **Fix:** Capture `vaultPath` at `clear()` time (or set a `_cleared`/generation token) and
  short-circuit `loadDocument` when the live vault path/generation differs. Verify against
  `vaultStore.path` before inserting.
- **Test:** Simulate a `loadDocument` after `clear()` with a changed vault path; assert it's a no-op.
- **Effort:** M

### 3.4 🤖 `tileResize` destroy leaks pointer capture — **low** (sweep: medium)
- **Area:** Canvas · `canvas-2`
- **Files:** `src/renderer/lib/canvas/tileResize.ts:133-153`
- **Problem:** `destroy()` nulls `activePointerId` without `releasePointerCapture`, unlike the
  parallel `tileDrag.ts` which calls `cancelDrag()`. The browser self-heals on node
  disconnect, but in-flight pointer events for that gesture are dropped (stuck cursor glitch).
- **Fix:** Replace the ad-hoc cleanup in `destroy()` with a call to `cancelResize()` (which
  already guards, restores size, releases capture, clears cursor), then remove listeners.
- **Effort:** S

---

## Phase 4 — Tag & rename consistency

Cluster of `.filo/tags.json` flush-ordering gaps and rename-recovery completeness. Each is a
narrow crash-window or a known-orphan path; none loses file content.

### 4.1 🤖 In-app delete doesn't flush `tags.json` before the board cascade — **medium** (sweep: medium)
- **Files:** `src/renderer/stores/vaultFolderOps.ts:823-824, :881`
- **Problem:** `dropFile`/`dropFolder` queue a 300ms debounced `tags.json` write, but the next
  line synchronously flushes the board cascade. A crash in between leaves a permanent orphan
  `fileTags` entry. The rename path ([:551](src/renderer/stores/vaultFolderOps.ts:551))
  already calls `flushPendingSave()` for exactly this reason — applied asymmetrically.
- **Fix:** Add `await fileTagsStore.flushPendingSave()` immediately after `dropFolder(rel)`,
  before `flushAllDirty()`.
- **Effort:** S

### 4.2 🤖 External `.md` delete never calls `dropFile` → orphan tag entry — **medium** (sweep: medium)
- **Files:** `src/renderer/stores/vaultExternalChanges.ts:391-407`; `fileTags.svelte.ts:656-661`
- **Problem:** External-delete resolution paths don't notify the tag store, so `tags.json`
  keeps the deleted file's entry until the next vault-open `pruneOrphanFileTags`. Long
  sessions accumulate phantom tag hits.
- **Fix:** In the deleted-file resolution handlers (and the `ignore`/`file-missing` branch),
  call `fileTagsStore.dropFile(rel)` when the file is confirmed gone. **Suppress** the drop on
  the "Keep local" recreate path (the file/tags are still valid there).
- **Effort:** S

### 4.3 🤖 `renameTagEverywhere` doesn't flush `tags.json` after the registry commit — **medium** (sweep: medium)
- **Files:** `src/renderer/stores/fileTags.svelte.ts:917-922`; `fileTagsCascade.svelte.ts:194-221`
- **Problem:** Same class as 4.1: registry rename schedules a debounced `tags.json` write, then
  `flushTagRewriteBoardWrites` synchronously flushes boards. A crash between leaves tile defs
  on disk with the new tag name but `tags.json` missing the definition (no colour/createdAt) —
  an orphan forward reference `pruneOrphanFileTags` won't repair.
- **Fix:** `await this.flushPendingSave()` after `commitTagRenameInMemory` (and
  `commitTagRemovalInMemory`), before `flushTagRewriteBoardWrites`.
- **Effort:** S

### 4.4 🤖 Rename-cascade recovery retry omits `documentStore.updateFilename` — **medium** (sweep: high, self-downgraded)
- **Files:** `src/renderer/stores/vault.svelte.ts:650-706`
- **Problem:** The sentinel-recovery retry repairs board JSON + tags.json but not the in-memory
  document filename pointer, unlike the normal rename path
  ([vaultFolderOps.ts:563-585](src/renderer/stores/vaultFolderOps.ts:563)). Practical impact is
  limited because at vault-open `documentStore` is empty; it bites only if a doc is already
  open when an in-session retry fires.
- **Fix:** In the retry `onConfirm`, after the `propagateRename` loop:
  `for (const e of entries) { const d = documentStore.findByFilename(e.oldPath); if (d) documentStore.updateFilename(d.docId, e.newPath); }`
- **Effort:** S

### 4.5 🤖 "Discard" on rename recovery silently leaves broken refs — **medium** (sweep: high)
- **Files:** `src/renderer/stores/vault.svelte.ts:708-714`
- **Problem:** Clicking "Discard" just clears the sentinel — no `propagateRename`, no warning.
  If the disk rename succeeded but some `.board.json` flushes failed (exactly the scenario that
  created the sentinel), affected boards keep pointing at the old path. Files are safe on disk,
  but board pointers are broken with no in-app repair (user must delete/re-add tiles).
- **Fix:** Make "Discard" do the repair silently (run `propagateRename` + `flushAllDirty` in
  `onCancel` too), or at minimum relabel to "Discard (keep broken refs)" and toast
  "Affected boards may show broken-ref badges." Consider a "repair all broken refs to newPath"
  action in the orphan/broken-ref UI generally.
- **Effort:** M

---

## Phase 5 — Correctness polish

### 5.1 🤖 `MoveCardsCommand.undo` scrambles same-column order — **medium** (sweep: medium)
- **Files:** `src/renderer/commands/kanbanCommands.ts:296-303`
- **Problem:** Undo restores ascending by `fromPosition`; each `moveKanbanPlacement` splice
  grows the array so later inserts land off-by-N. Multi-card same-column reorder undo lands
  out of order; the wrong order is written to `.board.json`.
- **Fix:** Sort **descending** by `fromPosition` within a column so higher indices insert first:
  `return b.fromPosition - a.fromPosition;`
- **Test:** Move 3 cards within one column, undo, assert original order.
- **Effort:** S

### 5.2 🤖 `deleteAllCompleted` reads stale index, not live `documentStore` — **medium** (sweep: medium)
- **Files:** `src/renderer/lib/tasklist/taskDeletion.ts:155-196`
- **Problem:** It reads `completed` from `vaultIndexStore` (300ms-debounced) while the rest of
  the board reads `documentStore` first. Checking tasks off and immediately bulk-deleting can
  silently skip just-completed tasks.
- **Fix:** Read `documentStore.getFrontmatter(docId)` first with `vaultIndexStore` fallback
  (mirror the `TaskRow` projection), or derive the completed set from the already-computed
  `rows` rather than re-reading the index.
- **Effort:** S

### 5.3 🤖 History `targetBoardId` guard wedges the stack / false-blocks split-pane — **medium** (sweep: medium+low)
- **Files:** `src/renderer/stores/history.svelte.ts:394-417, :426-448` (`undo-redo-5` + `store-react-4`)
- **Problem:** On `targetBoardId !== activeBoardId`, undo/redo toasts and returns without
  popping — every later undo on that board is wedged behind the stuck command. In split-pane it
  also fires even when the target board *is* open in another pane.
- **Fix:** When the target board is open in any pane's scope, allow the undo (shared boardCache).
  Otherwise skip past (pop without undoing) so earlier commands stay reachable instead of wedging.
- **Effort:** M

### 5.4 🤖 Edge-pan singleton pans the wrong canvas during connection draw — **medium** (sweep: medium)
- **Files:** `src/renderer/lib/canvas/edgePan.ts:20-25`; `MindMapBoard.svelte:119-125`
- **Problem:** `edgePan` is a module singleton calling the global `canvasStore.panBy`, which
  routes to the active pane. Connection drawing doesn't use pointer capture, so activating
  pane B mid-draw makes edge-pan scroll pane B (whose viewport then persists).
- **Fix:** Capture the pane-local canvas scope at `startEdgePan(scope)` time and pan that scope
  in `tick()`, instead of the global facade.
- **Effort:** M

### 5.5 🤖 `updateBoardSettings` mutates in place before the spread — **low** (sweep: medium)
- **Files:** `src/renderer/stores/boardCache.svelte.ts:502-508`
- **Problem:** In-place `cached.board.settings = settings` then a ref-copy spread; a transient
  inconsistent window and a divergence from the cache conventions used everywhere else. No known
  live data-loss (snapshot-at-fire captures the mutation).
- **Fix:** `boardCache = { ...boardCache, [boardId]: { ...cached, board: { ...cached.board, settings } } }; this.markDirty(boardId);`
- **Effort:** S

### 5.6 🤖 `removeTile` ops mutate `board` sub-objects without cache-identity spread — **low** (sweep: medium)
- **Files:** `boardTileOps/mindmap.ts:107-109`, `tasklist.ts:79-89`, `kanban.ts:77-83`, `boardCacheKanban.ts:332-334`
- **Problem:** Direct `delete board.placements[id]` / `board.tasks = …` then `updateEntry`
  spreads only `tileDefs`/`connections`, carrying the same `board` ref. Reactivity works today
  via deep-proxy tracking and disk writes are safe; latent risk if future code does identity
  comparison on `board`.
- **Fix:** Establish one convention — call `touchBoard(boardId)` after sub-object mutation, or
  spread `board: { ...cached.board }` in those `updateEntry` calls.
- **Effort:** M

### 5.7 🤖 Task/card delete keeps the backing `.md` with no UI indication — **low** (sweep: high)
- **Files:** `src/renderer/commands/taskCommands.ts:160-178`; `taskDeletion.ts`
- **Problem:** *(Deliberate design — see Appendix C.)* Task/Kanban delete removes the placement
  but keeps the `.md` file (undo restores placement, never touched the file). The menu just says
  "Delete task," so files accumulate and the mental model is wrong. Not a bug; a UX clarity gap.
- **Fix:** Relabel to "Delete task (file stays in vault)," or add an optional "Delete associated
  files" path mirroring Mind Map's `DeleteTilesCommand` (snapshot body on execute, restore on undo).
- **Effort:** S (label) / M (file-delete option)

---

## Phase 6 — UX & accessibility

### 6.1 🤖 OrphanCatcher per-row Delete fires with no confirm or feedback — **medium** (sweep: high)
- **Files:** `src/renderer/components/modals/OrphanCatcher.svelte:55-58, :192-196`
- **Problem:** Single click removes the tile (undoable, files kept) with no confirm and no
  toast — inconsistent with the bulk-delete paths that do confirm.
- **Fix:** Either route through `uiStore.openConfirm` like the bulk paths, or keep single-tap but
  immediately `uiStore.toast('Tile deleted — Ctrl+Z to undo', 'info', 2500)`.
- **Effort:** S

### 6.2 🤖 Board Browser search input has no accessible label — **low** (sweep: high; WCAG)
- **Files:** `src/renderer/components/modals/BoardBrowser.svelte:287-292`
- **Problem:** `placeholder` only — screen readers announce nothing (WCAG 1.3.1/4.1.2).
- **Fix:** Add `aria-label="Search boards"` to the input.
- **Effort:** S

### 6.3 🤖 Toast action buttons lack context labels — **low** (sweep: medium; WCAG)
- **Files:** `src/renderer/components/shared/Toast.svelte:59-66`
- **Problem:** Stacked conflict toasts ("Reload"/"Keep"/"Retry") are ambiguous to AT.
- **Fix:** `aria-label={`${action.label} — ${toast.text}`}` on each action button.
- **Effort:** S

### 6.4 🤖 Board Browser panel shares z-index with its backdrop — **low** (sweep: medium)
- **Files:** `AppShell.svelte:805-817`; `css/style.css:139-141`
- **Problem:** Panel and backdrop both `--z-modal-backdrop` (3000). Currently correct by DOM
  order, but a knife-edge: only one modal can be open at a time today, so it's latent.
- **Fix:** `.board-browser-panel { z-index: var(--z-modal); }` (3001), backdrop stays 3000.
- **Effort:** S

### 6.5 🤖 Board Browser drag-reorder has no keyboard alternative — **low** (sweep: low)
- **Files:** `src/renderer/components/modals/BoardBrowser.svelte:336-403`
- **Problem:** `draggable` only; no keyboard reorder, unlike `TabBar.svelte`'s `Alt+Arrow`.
- **Fix:** Port `TabBar`'s `Alt+ArrowUp/Down` reorder into the board list's `onkeydown`.
- **Effort:** M

---

## Phase 7 — Hygiene, docs, and low-priority

### 7.1 🔬 Doc drift: CLAUDE.md vs reality; file-size allowlist "4" vs 7 — **low**
- **Files:** `CLAUDE.md`; `scripts/check-file-sizes.mjs:28`
- **Problem:** CLAUDE.md's structure section omits modules that now exist (`recurrence.ts`,
  `quickAddParser.ts`, `SmartListTabs.svelte`, `protocol/rangeHeader.ts`, etc.) and says the
  file-size gate has "four grandfathered files" while the allowlist has **seven**, with ceilings
  padded 40–200 LOC above current size (e.g. `TaskListBoard.svelte` is 2042, ceiling 2245).
- **Fix:** Refresh the CLAUDE.md structure/CI sections; reconcile the "4 grandfathered" wording
  to 7; optionally tighten each ceiling down to current LOC to restore the ratchet's bite.
- **Effort:** S

### 7.2 🤖 Stale `Tasks/` convention comment — **low** (`rename-refs-3`)
- **Files:** `src/renderer/lib/vault/fileRefIntegrity.ts:298`
- **Fix:** Update the JSDoc — tasklist resolves to vault-root or vault/board pin, not `Tasks/`.
- **Effort:** S

### 7.3 🤖 Tag-rewrite recovery false-positive partial detection — **low** (`rename-refs-4`)
- **Files:** `src/renderer/lib/vault/tagRewriteSentinel.ts:211-219`
- **Problem:** `hasPartialTagRewriteState` flags any vault file already carrying `newName`,
  including ones that legitimately had it pre-rename → spurious "partial rewrite" warning on
  next open (Resume is idempotent, so harmless but confusing).
- **Fix:** Document the limitation; optionally snapshot pre-existing `newName` paths in the
  sentinel and exclude them from the scan.
- **Effort:** S (doc) / M (snapshot)

### 7.4 🤖 `addTagToMarkdown` reformats frontmatter on first tag — **low** (`tags-persist-4`)
- **Files:** `src/renderer/lib/vault/tagRewriter.ts:288-313`
- **Problem:** Adding the first tag to a file that has frontmatter but no `tags:` field falls to
  the `load→dump` path, discarding YAML comments/blank lines/key order (documented limitation,
  but avoidable here).
- **Fix:** When `hasFrontmatter && locateTagsField()===null`, insert a `tags:\n  - <tag>` block
  via the line-level rewriter instead of `yaml.dump`.
- **Effort:** M

### 7.5 🤖 Non-nanoid board IDs + uncapped tile→board scan — **low** (`persist-cache-4`)
- **Files:** `src/renderer/stores/boardCache.svelte.ts:619, :135-149`
- **Fix:** Generate board IDs as `${type}_${createId()}`; consider a tile→board reverse index to
  replace the O(boards×tiles) `findBoardIdFor*` scans on every keyless persist.
- **Effort:** M

### 7.6 🤖 `DocumentEditor.hydrateFromDisk` frontmatter-strip is a defensive near-miss — **low** (`doc-markdown-5`)
- **Files:** `src/renderer/components/boards/DocumentEditor.svelte:297-302`
- **Fix:** Current code is safe; add a dev assertion in `documentStore.updateContent` that
  `markdownBody` is body-only (`startsWith('---\n')` → error) to prevent regression.
- **Effort:** S

### 7.7 🤖 Spatial index can go stale on auto-height growth during batch — **low** (`canvas-4`)
- **Files:** `TileContainer.svelte:156-173`; `spatial.svelte.ts:35-53`
- **Problem:** ResizeObserver updates the rbush during a multi-tile-drag batch; smart guides
  read `tile.size` from the store, so a tile that reflows mid-drag (e.g., image load) can snap
  1–5px off. Visual only.
- **Fix:** Suspend ResizeObserver→`spatialStore.update` during batch mode, or have smart-guide
  candidate collection read the index geometry consistently.
- **Effort:** S

### 7.8 🔬 Document the accepted limitations (don't "fix") — **low**
Capture these in CLAUDE.md / a KNOWN_LIMITATIONS doc so they're not re-discovered as bugs:
- **Lossy YAML round-trip** — every non-tag frontmatter write does `load→dump`, dropping
  comments/blank lines/key order (`markdownSync.ts`). Already in CLAUDE.md.
- **Attachment tags are vault-local** — image/video/audio/file tags live in `.board.json` +
  `.filo/tags.json` only; moving media out of the vault loses them.
- **Windows directory fsync is a no-op** — file *data* is fsynced before rename, but rename
  metadata durability isn't enforceable via Node on Windows (`filenameUtils.ts:246`); a power
  loss in the instant after rename can theoretically lose a just-saved file on NTFS.
- **Quit flush is best-effort under a 5s ceiling** (`main.ts:53`) — a wedged renderer past the
  timeout loses pending writes (the `.dirty` sentinel then surfaces recovery next launch).
- **Self-write suppression window** (2000+1000ms) — on a very slow disk/AV, the app's own write
  can be reclassified as an external edit. Monitor; widen the window only if it bites.

---

## Appendix A — Severity index

| Severity | Phase 1 | Phase 2 | Phase 3 | Phase 4 | Phase 5 | Phase 6 | Phase 7 |
|---|---|---|---|---|---|---|---|
| **high** | 1.1, 1.2 | 2.1 | — | — | — | — | — |
| **medium** | 1.3, 1.4 | 2.2–2.6 | 3.1, 3.2, 3.3 | 4.1–4.5 | 5.1–5.4 | 6.1 | — |
| **low** | — | — | 3.4 | — | 5.5, 5.6, 5.7 | 6.2–6.5 | 7.1–7.8 |

Phase 0 items are not severity-rated — they are prerequisites.

## Appendix B — Per-area ratings (1–10, this audit)

| Area | Rating | Area | Rating |
|---|:--:|---|:--:|
| Write path & atomicity | 9 | Undo/redo & commands | 6.5 |
| Crash safety & recovery | 8 | UI/UX & accessibility | 6.5 |
| IPC & security boundary | 9 | Rename propagation & refs | 6 |
| Testing | 8 | Tag persistence | 6 |
| External-edit reconciliation | 7 | Kanban & Task List logic | 6 |
| Frontmatter ↔ cache sync | 7 | Document / Markdown fidelity | 6 |
| Canvas / Mind Map engine | 7 | **Build / tooling / VCS** | **4** |
| State & reactivity | 7 | Code health | 7 |

**Overall ≈ 7/10** — strong core, edge hardening needed, process is the weak link.

## Appendix C — Verified non-issues / do NOT "fix"

- **`refreshTree` "null deref"** (`vault.svelte.ts:1091`) — the `TypeError` in test logs is an
  incomplete mock returning `null`; production checks `envelope.ok === false` inside a
  try/catch. No action.
- **`BatchCommand.undo` rollback order** (`groupAndBoardCommands.ts:138-176`, sweep `undo-redo-2`)
  — the sweep agent **withdrew** this after self-verification; the order and async sequencing
  are correct. No action.
- **Task/card delete keeps `.md` files** — *deliberate* (the Vault API owns file deletion;
  Command undo never touches files). Item 5.7 is a UX-clarity tweak, not a bug fix.
- **Atomic write / quit flush / path security** — verified strong; don't refactor the
  `atomicWriteFile` tmp-preserve-on-ENOSPC behavior or the realpath traversal guard.

## Appendix D — Remediation-claim re-check

All **18** highest-risk fixes claimed in `AUDIT_REMEDIATION_PLAN_2026-05-28/29[_followup].md`
were independently re-verified against the current code: **18/18 HOLD.** The last-48h churn did
not regress prior fixes (spot-checked: F2 scheduler counter buckets, F5 sidebar-rename Escape
guard, the rename sentinel/mutex, the `markHydrated` empty-FM guard, BOM preservation).

---

## Suggested execution order

1. **Phase 0** — today, before any real data. (~1h)
2. **Phase 1** — the two `high`s (1.1 date bug, 1.2 Zod) plus 1.3/1.4. Each ships with a test. (~0.5 day)
3. **Phase 2** — reproduce-then-fix the editor-sync cluster; 2.1 first. (~1 day)
4. **Phases 3–4** — lifecycle + tag/rename consistency. (~1 day)
5. **Phases 5–7** — polish, a11y, docs, as capacity allows.

_Every fix: failing test first → fix → `npm run ci:verify` green → commit._

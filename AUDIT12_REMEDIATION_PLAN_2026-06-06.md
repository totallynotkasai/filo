# Audit-12 Remediation Plan — Independent Critical Data-Integrity Audit

**Date:** 2026-06-06
**Source:** Fresh adversarial audit (9 agents, prior plans deliberately ignored; every
HIGH finding re-verified by reading the live code). Performed against the
**uncommitted working tree** (~168 files / ~6,800 insertions = the entire
Audit-7/8/9 + write-path refactor, which had never been manually smoke-tested).
**Baseline at audit time:** `npm run ci:verify` = green (exit 0). The green suite
is NOT evidence of safety — see [Guiding principles](#guiding-principles).

**Overall system rating at audit time: 6/10.** No CRITICAL (nothing destroys note
*bodies* under a common action). **4 HIGH**, **6 MEDIUM**, **5 LOW/latent**, **2
security (defense-in-depth)** confirmed. Almost all live in the uncommitted
refactor — i.e. they are regressions the recent changes introduced.

---

## How to use this plan

- Work **top-down by phase**. Phase 1 is the "before you rely on Task List /
  subfolders / vault-wide tag renames" set. Phases 2–4 are quality/robustness.
- Each item is **self-contained**: root cause, exact files, numbered fix steps,
  the test to add, and the CI gate to extend so the *sibling-site* class can't
  silently reopen.
- After each item: run the named test + `npm run ci:verify`. Commit per phase
  (or per HIGH item) for bisectability.
- Tick the `Status` box when done.

### Status legend
- `[ ]` not started · `[~]` in progress · `[x]` done (test + ci:verify green)

### Per-area ratings (audit-time snapshot, re-rate after each phase)

| Area | Rating | Driving items |
|---|:---:|---|
| Frontmatter write engine (CST/delta/EOL) | 7 | L1 |
| Write scheduling / quit-drain / save-state | 6 | H4, M2 |
| Vault lifecycle / swap / rename-delete | 6 | H3, M6, L4 |
| External-edit reconciliation / watcher | 7 | M4, L3 |
| Kanban + Task List correctness | 6 | H1 (+H2 compound) |
| Undo/redo command pattern | 7 | M3 |
| Mind Map / canvas / Documents (TipTap) | 6 | M1, M5, L2 |
| IPC / path security / main | 7 | S1, S2 |
| Tags / tag-rewrite / search / recovery | 5 | H2, H3 |

---

## Guiding principles

1. **The bugs are in the *sibling sites the gates don't enumerate.*** The
   recurring failure mode in this codebase is *"the fix was applied in two of
   three places."* (H1: Kanban+MindMap persist `filePath`, Task List doesn't.
   H2: the canonical resolver case-folds/honours subfolders, the `fileTags`
   copy doesn't. H3: the single-tile tag writer is vault-swap-guarded, the
   vault-wide sweep isn't. H4: `flush()` has the WC-3 pre-drain, `flushAll()`
   doesn't.) **Every fix below MUST also extend/add a gate** that makes the
   invariant structural, not just pin this one instance.
2. **CI gates here are regression pins, not invariant proofs.** Token-presence
   checks and allowlists prove a *named* past bug didn't return. Prefer gates
   that scan for the *trigger* (e.g. a live vault-path read before an await),
   so a new offender site is caught by construction.
3. **No refactor required.** Every item is a localized change. The architecture
   (single-parser FM engine, per-path serialization, generation guard, command
   pattern) is sound.

---

## Summary table

| ID | Sev | Area | One-liner | Phase |
|---|:---:|---|---|:---:|
| H1 | High | Task List | Task creation never persists `filePath` → cold-load subfolder edit hits wrong file | 1 |
| H2 | High | Tags | `resolveTextTileFilePath` falls back to vault root (ignores subfolders) | 1 |
| H3 | High | Tags/Vault | Vault-wide tag rename/remove writes outgoing vault's change into new vault | 1 |
| H4 | High | Scheduler | `flushAll()` races new vs in-flight write → board/config clobber on slow volumes | 1 |
| M1 | Med | Documents | DocumentEditor mounts blank on failed read, then writes empty over real file | 2 |
| M2 | Med | Scheduler | Late-success board/config/misc write leaves a permanent phantom "failed" mark | 2 |
| M3 | Med | Undo | PropertiesPopup pushes its command onto the wrong board's stack (split-pane) | 2 |
| M4 | Med | Reconcile | `.board.json` external-edit/rename match is case-sensitive on Windows | 2 |
| M5 | Med | Canvas | OS file-drop lands on the wrong pane in split view | 2 |
| M6 | Med | Vault swap | On-open FM→cache reconcile batch can overwrite new vault's boards | 2 |
| L1 | Low | FM engine | `assembleMarkdownFile` empty-FM revert (latent; masked by auto-`id`) | 3 |
| L2 | Low | Documents | TextTile mutates in-memory `project.boards` (vestigial) | 3 |
| L3 | Low | Reconcile | Bulk "Reload all" replays stale detection-time snapshot | 3 |
| L4 | Low | Vault swap | `performDelete` tail + `.dirty` clean-toast dismiss not identity-guarded | 3 |
| L5 | Low | FM/Reconcile | Single-line-CRLF flip on adopt; attachment-delete grace blocks rename queue | 3 |
| S1 | Med* | Security | `vault:copy-file` source path unvalidated (arbitrary OS read) | 4 |
| S2 | Low | Security | `http://` allowed; reserved names in open-external; `isWithinVaultRoot` not case-folded | 4 |

\* S1 is Medium under a *hostile-vault* threat model; N/A for your own vault.

---

# Phase 1 — HIGH-severity blockers

> Fix all four before relying on Task List, files-in-subfolders, or vault-wide
> tag renames. Each is a small, isolated "apply the existing pattern" change.

## H1 — Task List never persists `filePath`

- **Status:** `[x]` (fix + `taskListFilePathPersistence.test.ts` + new `ci:creation-persists-filepath` gate; bite-verified; also stamps the two Task List file-drop sites for parity)
- **Severity:** High · **Confidence:** Confirmed (traced) · **Boards:** Task List only
- **Files:**
  - `src/renderer/lib/tasklist/taskCreation.ts` (`buildTaskDef` ~213-224; `seedMdFile` ~177; callers `createTaskInSection` ~257, `addTaskFromQuickAdd` ~304)
  - `src/renderer/commands/taskCommands.ts` (`AddTaskCommand` ctor ~119 deep-clones the def)

### Root cause
`AddTaskCommand`'s constructor deep-clones the def (`this.def = this.snapshot(def)`)
and `execute()` persists that clone via `persistAddTaskPlacement` **before**
`seedMdFile` runs. `seedMdFile` sets `def.filePath = relPath` on the **original**
object (line 177) — a different object that never enters the cache. So the cached
def and the persisted `.board.json` carry **no `filePath`**. After a restart
(boards don't preload docs → `documentStore` empty) the field/tag write resolvers
fall back to the per-board folder cascade or to vault root, hitting the wrong file
when the cascade has diverged (default-folder changed, vault root pin
added/removed, or the file moved externally). Kanban
(`kanbanTileCreation.ts:162`) and Mind Map
(`seedTextFileForNewTile.ts:50` → `buildTileDefinition` honours `tile.filePath`)
both bake `filePath` into the def **before** constructing the command — Task List
is the lone broken sibling.

### Fix
1. In `buildTaskDef`, immediately after `relPath` is computed and the `def` object
   is built (after line ~223 `(def).content = ''`), add:
   ```ts
   (def as Record<string, unknown>).filePath = relPath;
   ```
   This guarantees BOTH creation entry points (`createTaskInSection`,
   `addTaskFromQuickAdd`) carry `filePath` into the def before `AddTaskCommand`
   clones it.
2. Remove the now-redundant `(def as Record<string, unknown>).filePath = relPath;`
   at `seedMdFile:177` (it mutated the wrong object and is misleading). Leave the
   rest of `seedMdFile` (disk write + hydrate) untouched.
3. Verify the file-drop / round-trip creation paths (which pass a pre-existing
   def) still set `filePath` — if they build a text-task def without one, route
   them through `stampTextTileSeedPath(tile, boardId)` for parity.

### Test
- `tests/unit/taskListFilePathPersistence.test.ts` (new): build a task in a
  subfolder, assert the **persisted cache def** (`boardCacheStore` /
  `.board.json` payload) has `filePath === '<folder>/<title>.md'`. Bite-verify:
  revert the `buildTaskDef` line → `filePath` is `undefined`.
- Add a cold-load regression: clear `documentStore`, change the board's
  `defaultFolder`, then resolve the write path for a field edit → must equal the
  persisted `filePath`, not `<newFolder>/<title>.md`.

### Gate
- Extend `scripts/check-writer-path-honors-filepath.mjs` (or add
  `ci:creation-persists-filepath`): assert each text-tile **creation** path
  (`kanbanTileCreation`, `taskCreation`, `seedTextFileForNewTile`) assigns
  `filePath` onto the def **before** the `new Add*Command(` / `persistAdd*`
  call. Bite-verify by temporarily moving the assignment after construction.

### Verify
`npm run test:unit` + `npm run ci:verify`. Manual: create a Task in a subfolder,
restart (or clear doc cache), edit its priority without opening it as a Document
→ confirm the `.md` in the subfolder updated (not a root file).

---

## H2 — `resolveTextTileFilePath` falls back to the vault root

- **Status:** `[x]` (deleted the helper; all FOUR call sites — not the one the plan named — now use `resolveTextTileVaultPath`; `fileTagsSubfolderPath.test.ts`; `fileTags.svelte.ts` added to the writer-path gate; bite-verified)
- **Severity:** High · **Confidence:** Confirmed · **Boards:** any text tile / Task row (compounds with H1)
- **Files:** `src/renderer/stores/fileTags.svelte.ts` (`resolveTextTileFilePath` ~223-231; used by `writeTagChangeToTileMarkdown` ~273)

### Root cause
The single-tag add/remove path resolves the backing `.md` via a local helper whose
fallback chain ends at `` `${tile.title || 'Untitled'}.md` `` — **no folder
component** — unlike the canonical `resolveTextTileVaultPath`
(`lib/boards/textTilePath.ts`), which consults `getActiveContentFolder(board)`.
So a tag add/remove on a cold-loaded subfolder text tile (especially a Task row,
which lacks `filePath` per H1) writes the tag and the `.filo/tags.json` key to a
**root** file — corrupting an unrelated same-named root file or creating a ghost.

### Fix
1. Delete `resolveTextTileFilePath` and replace its single call site in
   `writeTagChangeToTileMarkdown` with:
   ```ts
   const relPath = resolveTextTileVaultPath(tile, (tile as { boardId?: string }).boardId);
   ```
   (Import `resolveTextTileVaultPath` from `../lib/boards/textTilePath`.)
2. Keep the existing `captureVaultIdentity()` / `isStillSameVault` guards in
   `writeTagChangeToTileMarkdown` (they're already correct).
3. If `resolveTextTileVaultPath` needs a board id the tile doesn't carry, thread
   the owning board id from the caller (the tag UI knows it).

### Test
- `tests/unit/fileTagsSubfolderPath.test.ts` (new): a cold-loaded (no `docState`)
  text tile with `filePath` set to `Notes/A.md` → tag add resolves to
  `Notes/A.md`; with `filePath` absent but a board content-folder of `Notes` →
  resolves to `Notes/A.md` (NOT `A.md`). Bite-verify by restoring the old
  helper.

### Gate
- Add `fileTags.svelte.ts` to the `check-writer-path-honors-filepath.mjs`
  allowlist (assert it references `resolveTextTileVaultPath`, forbid a
  `` `${...title...}.md` `` write-path literal in the tag-write function).

### Verify
`npm run ci:verify`. Manual: cold-load a vault, add a tag to a subfolder note via
the tile tag UI → confirm the subfolder `.md` and `tags.json[Notes/A.md]` updated.

---

## H3 — Vault-wide tag rename/remove writes the outgoing vault's change into the new vault

- **Status:** `[x]` (captured identity threaded through `runTagRewriteSweep` + retry; `isStillSameVault` guards on both commits; `tagSweepVaultSwapGuard.test.ts`; `ci:reconciler-vault-guard` Part 1 scans `fileTagsCascade.svelte.ts` + new `allMetadata` trigger; both guards bite-verified)
- **Severity:** High · **Confidence:** Confirmed (two independent agents) · **Blast radius:** whole vault
- **Files:**
  - `src/renderer/stores/fileTagsCascade.svelte.ts` (`runTagRewriteSweep` ~126-139, `rewriteAndCommitRetry` ~267-289, `commitTagRenameInMemory`/`commitTagRemovalInMemory` ~198/232)
  - `src/renderer/stores/fileTags.svelte.ts` (`renameTagEverywhere` ~1064, `removeTagEverywhere` ~1123)
  - `src/renderer/lib/vault/vaultIdentity.ts` (`captureVaultIdentity`/`isStillSameVault`)

### Root cause
`runTagRewriteSweep` reads `vaultStore.path` and `vaultIndexStore.allMetadata()`
**live** (no identity capture). The sweep is long-running; the failure toast
(`duration: 0`) survives a vault swap and its retry closure re-reads the live
path at click time. So after a swap, the retry walks the **new** vault's files
(scoped to the old vault's failed relative paths) and `assertActiveVault`
*accepts* the writes because they target the active vault — applying vault A's tag
operation to vault B's `.md`, `.board.json`, and `tags.json`. The in-memory
commits then mutate the new vault's boards. The **single-tile** writer beside it
(`writeTagChangeToTileMarkdown`) is fully `captureVaultIdentity`/`isStillSameVault`
guarded — the vault-wide sweep is the unguarded sibling.

### Fix
1. Capture identity at the entry points. In `renameTagEverywhere` /
   `removeTagEverywhere`, add `const identity = captureVaultIdentity();` before
   `ensureAllLoaded()`.
2. Make `runTagRewriteSweep` take an explicit captured root instead of reading
   live. Change its signature to accept `identity` (or `vaultRoot`), and inside
   pass that root to `rewriteTagInAllMarkdown({ vaultRoot: identity.path, ... })`.
   A post-swap write then targets the OLD root and is rejected by main-side
   `assertActiveVault` (fail-closed).
3. Guard the in-memory commits. Before `commitTagRenameInMemory` /
   `commitTagRemovalInMemory` and before `flushTagRewriteBoardWrites`, add
   `if (!isStillSameVault(identity)) return;` (the commits mutate the *active*
   `boardStore`/registry — they must not run if the vault swapped).
4. Thread identity into the retry path. Change `rewriteAndCommitRetry(store,
   old, new, failedPaths, identity)` and the toast closures
   (`retry: () => rewriteAndCommitRetry(this, old, new, failedSet, identity)`).
   At the top of `rewriteAndCommitRetry`, `if (!isStillSameVault(identity)) {
   /* drop: vault changed since the failed sweep */ return; }`.

### Test
- `tests/unit/tagSweepVaultSwapGuard.test.ts` (new): start a rename, simulate a
  vault swap (bump the generation via `beginVaultGeneration`), then drive the
  sweep/commit/retry → assert NO writes target the new vault and the in-memory
  commit is skipped. Bite-verify by removing each guard.

### Gate
- Extend `scripts/check-reconciler-vault-guard.mjs` **Part 1** to scan
  `fileTagsCascade.svelte.ts`: any function that reads `vaultStore.path` /
  `vaultIndexStore.allMetadata()` and then `await`s must `isStillSameVault`
  after the await (the trigger is the live-path read, so removing the guard
  can't evade the gate). Bite-verify with a temp offender.

### Verify
`npm run ci:verify`. Manual: trigger a tag rename that partially fails (e.g. lock
one file), leave the retry toast up, switch vaults, click Retry → confirm the new
vault is untouched.

---

## H4 — `flushAll()` races a new write against an in-flight one (board/config clobber)

- **Status:** `[x]` (per-key prior-in-flight pre-drain in `flushAll` mirrors `flush()`'s WC-3; `flushAllOrdering.test.ts`; `ci:awaited-writes-bounded` pins the `inFlight.get(entry.key)` token; bite-verified)
- **Severity:** High · **Confidence:** Confirmed · **Environment:** OneDrive/SMB/network drives
- **Files:** `src/renderer/lib/boards/writeScheduler.ts` (`flushAll` ~667-769; pattern to mirror: `flush` WC-3 pre-drain ~604-621). Affects board/config/misc schedulers (markdown/frontmatter are immune — they serialize per path).

### Root cause
The WC-3 fix that drains a key's prior in-flight write **before** firing the
pending (newest) one — so the newest lands last — exists only in `flush(key)`.
`flushAll()` fires all drained-pending writes (lines ~718-743) and then awaits
the already-in-flight ones concurrently (lines ~745-765). For a non-serialized
scheduler (board/config/misc), the older in-flight write and the newer pending
write are both in flight; the OS can land the stale one last, clobbering the
newer `.board.json`/config payload.

### Fix
1. In `flushAll`, before firing each drained-pending entry, await any
   pre-existing in-flight bucket entries **for that same key** (mirror the
   `flush()` WC-3 pre-drain). Concretely, in the `for (const entry of drained)`
   loop, before `await fireWrite(entry.key, entry.args)`:
   ```ts
   const prior = inFlight.get(entry.key);
   if (prior && prior.size > 0) {
     for (const p of Array.from(prior)) await p.promise; // drain prior first
   }
   ```
   so the freshly-fired pending write lands last. Keep the existing
   `inflightSnapshot` await afterward for keys with no pending entry.
2. (Alternative / stronger) give board/config/misc a per-key serialization chain
   like the markdown gateway's `writeChainByPath`, eliminating the race class
   entirely. Heavier; prefer (1) unless dogfooding shows more races.

### Test
- `tests/unit/flushAllOrdering.test.ts` (new): for a non-serialized scheduler,
  enqueue write A (slow, resolves after a tick), re-arm pending write B for the
  same key, call `flushAll()` → assert B's `performWrite` resolves AFTER A's
  (B last). Bite-verify by reverting the pre-drain.

### Gate
- Extend `scripts/check-awaited-writes-bounded.mjs` (or new
  `ci:flushall-predrain`): assert `flushAll` in `writeScheduler.ts` contains the
  per-key prior-in-flight drain before its pending fire (token: the
  `inFlight.get(entry.key)` drain inside the drained loop). Bite-verify.

### Verify
`npm run ci:verify`. Manual (best-effort): on a throttled/network volume, edit a
board, edit again quickly, Ctrl+S → confirm the latest layout persists.

---

# Phase 2 — MEDIUM-severity confirmed bugs

## M1 — DocumentEditor writes empty content over a real file after a failed hydrate read

- **Status:** `[ ]`
- **Severity:** Medium · **Confidence:** Confirmed · **Files:** `src/renderer/components/boards/DocumentEditor.svelte` (`hydrateFromDisk` ~332-371)

### Root cause
On a read failure the catch marks `hydrated` (no baseline) and the `finally`
sets `hydrated = true` with empty editor content and **no embedded fallback**
(unlike TextTile, which falls back to `tile.content`). If a transient read
failure (Windows file lock / OneDrive / antivirus) occurs and the user types
into the unexpectedly-blank editor, the next debounced write truncates the real
file.

### Fix
1. Track the failure: in the catch at ~344, set a flag, e.g.
   `hydrateReadFailed = true` (and leave `hydrated` as-is).
2. In `buildWriteArgs()` (or wherever the write args are assembled), return
   `null`/skip when `hydrateReadFailed && lastLoadedBody` is empty/null — i.e.
   never write an empty body over a file we failed to read.
3. Surface a clear, non-dismissable-until-resolved state: a toast ("Couldn't
   read <file> — edits are paused until it's readable") and keep the editor
   read-only, with a retry that re-runs `hydrateFromDisk`.
4. On a later successful read, clear `hydrateReadFailed` and resume.

### Test
- `tests/unit/documentEditorHydrateFailure.test.ts` (new): stub
  `readMarkdownForHydrate` to throw → assert no write fires on subsequent
  `scheduleMarkdownWrite`, and the editor is read-only. Then succeed → writes
  resume. Bite-verify by reverting the guard.

### Gate
- Extend `scripts/check-no-silent-write-abort.mjs` to assert the
  hydrate-failure branch sets a flag consulted by the write path (forbid a bare
  `hydrated = true` in a failed-read branch without a write guard).

### Verify
Manual: lock the `.md` (or simulate), open it as a Document → confirm it shows an
error/read-only rather than a blank, writable editor.

---

## M2 — Late-but-successful board/config/misc write leaves a permanent phantom "failed" mark

- **Status:** `[ ]`
- **Severity:** Medium · **Confidence:** Confirmed · **Files:** `src/renderer/lib/boards/writeScheduler.ts` (timeout branch ~408-417); `boardWriteScheduler.ts`, `configWriteScheduler.ts`, `miscWriteScheduler.ts`; `boardWriteDebounce.ts` (the "self-heals" docstring ~26-28)

### Root cause
On `writeTimeoutMs` expiry the path is moved to `failedVaultPaths` and `[failureId]`
returned. The docstring claims "a late success self-heals via its own
`trackComponentWrite` endWrite" — true only for the markdown gateway + frontmatter
scheduler. Board/config/misc call the IPC directly, so a write that exceeds 60s and
then **succeeds** never clears the failed mark → `vaultStore.save()` returns false
for the rest of the session, sticky `.filo/.dirty`, false "Save failed" toasts, and
a phantom recovery prompt next launch, while the bytes are actually on disk.

### Fix
- Option A (preferred): wrap board/config/misc `performWrite` IPCs in
  `trackComponentWrite` so a late settle fires `endWrite(true)` and self-heals
  (makes the docstring true everywhere).
- Option B: on timeout, attach a deferred continuation to the original
  `writePromise` that, on a late success, calls the failed-path clear
  (`endWrite(true)` / prune from `failedVaultPaths`) for that path.

### Test
- `tests/unit/writeTimeoutLateSuccess.test.ts` (new): a board write that resolves
  AFTER the timeout → assert the path is removed from `failedVaultPaths` and
  `hasFailedWrites()` is false. Bite-verify by reverting.

### Gate
- Extend `scripts/check-awaited-writes-bounded.mjs`: assert board/config/misc
  schedulers route through `trackComponentWrite` (Option A) OR contain the
  late-success continuation (Option B).

### Verify
Manual (throttled volume): force one slow board write past 60s, let it succeed →
confirm Ctrl+S/quit no longer reports "Save failed".

---

## M3 — PropertiesPopup pushes its undo command onto the wrong board's stack

- **Status:** `[ ]`
- **Severity:** Medium (High for non-text tiles) · **Confidence:** Confirmed · **Files:** `src/renderer/components/tiles/PropertiesPopup.svelte` (`pushHistoryEntry` ~445-453); `src/renderer/commands/propertiesCommands.ts` (`UpdatePropertiesCommand` reads `boardStore.current` ~65)

### Root cause
`UpdatePropertiesCommand` resolves its `targetBoardId` from the **globally-active**
board at destroy time. Every sibling style popup got a **mount-time** boardId
capture (with a comment naming this exact hazard); PropertiesPopup was missed. In
split-pane, opening Properties on pane B then clicking pane A and closing makes a
non-text tile's property edit un-undoable (the metadata `applySnapshot` targets
the wrong board → silent no-op) or pushes onto the wrong stack.

### Fix
1. At popup mount, capture `const mountBoardId = scope.board.current?.id ?? '';`
   (use the **pane-scoped** `scope.board`, not the global facade).
2. Pass it as the 3rd arg: `new UpdatePropertiesCommand(before, after, mountBoardId)`
   (the command already accepts an optional `boardId`).
3. (Related, optional) route the metadata-kind `applySnapshot` write through a
   `targetBoardId`-keyed cache method (mirror `UpdateBoardSettingsCommand`) to
   remove the residual async-pivot reliance on the global facade.

### Test
- `tests/unit/propertiesPopupBoardScope.test.ts` (new): simulate a board switch
  between popup-open and popup-close → assert the command's `targetBoardId` is the
  popup's board, and undo restores on that board. Bite-verify.

### Gate
- Extend the style-popup mount-capture gate (or `check-command-targets-self.mjs`)
  to include PropertiesPopup: assert it captures a mount-time board id and passes
  it to the command.

### Verify
Manual: split-pane, edit a non-text tile's properties in pane B, click pane A,
close popup, Ctrl+Z → confirm the edit undoes on pane B's tile.

---

## M4 — `.board.json` external-edit / rename matching is case-sensitive on Windows

- **Status:** `[ ]`
- **Severity:** Medium · **Confidence:** Confirmed · **Files:** `src/renderer/stores/vaultExternalReconcilers.ts` (`findBoardIdForPath` ~110-116); `src/renderer/stores/boardCache.svelte.ts` (`renameBoardPath` ~382-402); `src/renderer/lib/utils/path.ts` (`normalizePath` does NOT case-fold)

### Root cause
The document pipeline case-folds everywhere (`samePath`/`vaultPath()`); the board
pipeline compares with `===`/`normalizePath` (no case-fold). On a case-insensitive
FS, an externally edited/renamed `.board.json` whose OS-reported casing diverges
from the stored casing is silently ignored (no reload) or fails to rebind (the
board is later treated as missing and can be evicted).

### Fix
1. Route `findBoardIdForPath`'s comparison and `renameBoardPath`'s key lookup
   through the case-folding normaliser used by the document path
   (`samePath` / `normalizeVaultRelative` / `vaultPath()`), not `===`/`normalizePath`.
2. Audit other `boardStore.paths` consumers for the same raw compare.

### Test
- `tests/unit/boardPathCaseFold.test.ts` (new): register a board at
  `Board.board.json`, deliver an external event for `board.board.json` → assert
  the board is found and reconciled/rebound. Bite-verify.

### Gate
- Add a focused check (or extend an existing path gate): forbid `=== rel` /
  `boardPath ===` raw path compares in `vaultExternalReconcilers.ts` /
  `boardCache.svelte.ts` rename/lookup; require the case-folding helper.

### Verify
Manual (Windows): rename a `.board.json` in Explorer changing only case → confirm
the board still loads/reconciles.

---

## M5 — OS file-drop lands on the wrong pane in split view

- **Status:** `[ ]`
- **Severity:** Medium · **Confidence:** Confirmed · **Files:** `src/renderer/lib/canvas/dragDrop.ts` (global `boardStore`/`canvasStore` imports); `src/renderer/components/boards/MindMapBoard.svelte` (`use:dragDropAction` ~624)

### Root cause
`dragDropAction` reads the global `boardStore`/`canvasStore` facades (= active
scope). A `drop` event has no prior `pointerdown` to activate the target pane
(unlike tile-drag, which uses pointer capture), so dropping a file onto the
inactive pane creates the tile on the active pane's board with the active pane's
viewport transform.

### Fix
1. Refactor `dragDropAction(node, { canvas, board })` to take the pane-scoped
   stores as parameters (mirror `viewportAction`/`edgePanAction`).
2. At the `use:dragDropAction` call site in `MindMapBoard.svelte`, pass the
   pane's `scope.canvas` and `scope.board`.
3. (Belt-and-braces) activate the pane on `dragenter`/`drop` before creating the
   tile.

### Test
- `tests/unit/dragDropPaneScope.test.ts` (new) or E2E: drop onto pane B while pane
  A is active → assert the tile is added to pane B's board with pane B's
  coordinates. Bite-verify.

### Gate
- Extend `check-document-editor-pane-scoped.mjs` (or a new pane-scope gate) to
  forbid global `boardStore`/`canvasStore` reads inside `dragDrop.ts`.

### Verify
Manual: split-pane, drop an image onto the non-active pane → confirm it lands there.

---

## M6 — On-open FM→cache reconcile batch can overwrite the new vault's boards

- **Status:** `[ ]`
- **Severity:** Medium · **Confidence:** Confirmed · **Files:** `src/renderer/stores/vault.svelte.ts` (`runPostCommitTasks` ~512-523); `src/renderer/stores/boardCacheFrontmatter.ts` (`applyFrontmatterToBackedTilesBatch` ~122-153)

### Root cause
The batch reconcile is awaited **before** the `isStillSameVault` re-check (the
guard at ~523 is one statement too late). The batch captures the cache reference
once, yields across microtasks, then does a terminal `setCache({ ...cache })`. A
vault swap mid-yield on a large vault makes the finishing batch overwrite the new
vault's cache with the old vault's boards.

### Fix
1. Pass the captured `VaultIdentity` into `applyFrontmatterToBackedTilesBatch`.
2. Re-check `isStillSameVault` after each `queueMicrotask`/yield AND immediately
   before the terminal `setCache`/`markDirty`; bail if it changed.

### Test
- `tests/unit/onOpenReconcileSwapGuard.test.ts` (new): start the batch on vault A,
  bump generation mid-loop, finish → assert no `setCache` against the new vault.
  Bite-verify.

### Gate
- Covered by the H3 widening of `check-reconciler-vault-guard.mjs` if it also
  scans `boardCacheFrontmatter.ts` for a captured-cache + post-yield `setCache`
  without an identity check; add it explicitly if not.

### Verify
Manual (large vault with FM/board drift): open vault A, immediately open vault B →
confirm B shows B's boards.

---

# Phase 3 — LOW / latent / cleanup

## L1 — `assembleMarkdownFile` empty-FM revert (latent)

- **Status:** `[ ]`
- **Severity:** Low (latent; masked by auto-`id`) · **Confidence:** Confirmed (logic) · **Files:** `src/renderer/lib/editor/markdownSync.ts` (~492 `objectHasKeys` guard → ~551 raw safety-net)

### Root cause
When `fm` resolves to `{}` (user cleared all frontmatter), the function skips the
CST engine and the `rawHasContent` safety net re-emits the original block verbatim
— silently reverting the deletion. The safety net can't distinguish "couldn't
parse" from "user emptied it." **Currently masked**: the auto-`id` injection
(~455) keeps tile/doc-backed `fm` non-empty, so it's not reachable for normal
files — but it's fragile (any write path that omits `contentId`, or a file that
never had an `id`, would expose it).

### Fix
1. Gate the final raw-verbatim safety net (~551) on
   `!frontmatterSourceParses(rawFrontmatter)` — i.e. only re-emit raw bytes when
   the source is genuinely unparseable (mirror the refuse-branch gate at ~519).
2. When `frontmatterDirty !== false`, `objectHasKeys === false`, and the original
   **parses**, route through `patchFrontmatterSourceCst(original, {})` (which
   correctly emits an empty/comment-only block) or emit no FM block.

### Test
- Extend `tests/unit/assembleMarkdownEngine.test.ts`: clearing all keys on a
  parseable single-key FM emits an empty (or comment-only) block, NOT the
  original; an *unparseable* block is still preserved verbatim. Bite-verify.

### Gate
- The `frontmatter-invariant` corpus already asserts byte-equality on untouched
  keys; add an empty-FM row so the safety-net split is pinned.

---

## L2 — TextTile mutates in-memory `project.boards` (vestigial)

- **Status:** `[ ]`
- **Severity:** Low (cleanup; no data loss) · **Files:** `src/renderer/components/tiles/TextTile.svelte` (~158-166)

### Root cause
`onUpdate` writes `DocumentBoard.content`/`updatedAt` on the returned-by-reference
virtual-project object, bypassing reactivity. The virtual project is in-memory
only and nothing reads `.content` as a write source (the `.md` write sources from
the editor markdown). Vestigial.

### Fix
- Delete lines ~158-166. `documentStore.updateContent` (line 155) is the canonical
  sync; the DocumentEditor's reactive `$effect` on `docState.body` picks it up.

### Test
- `tests/unit/textTileNoProjectMutation.test.ts` (new) or extend an existing
  TextTile test: typing updates `documentStore` but does NOT mutate
  `vaultStore.getData().boards[*].content`.

---

## L3 — Bulk "Reload all" replays the stale detection-time snapshot

- **Status:** `[ ]`
- **Severity:** Low · **Files:** `src/renderer/stores/vaultExternalChanges.ts` (`promptBulkExternalChanges` "Reload all" ~929-949)

### Fix
- In the bulk "Reload all" loop, `await vaultIndexStore.applyChanges([p.rel])` and
  re-read `getMetadata(p.rel) ?? p.next` per file before `applyReloadFromDisk`
  (mirror the already-hardened single-file path). Test: a second external write
  between detection and click → "Reload all" applies the latest bytes.

---

## L4 — `performDelete` tail + `.dirty` clean-toast dismiss not identity-guarded

- **Status:** `[ ]`
- **Severity:** Low (main-side gated; consistency) · **Files:** `src/renderer/stores/vaultFolderOps.ts` (`performDelete` post-await mutations ~904/949/955); `src/renderer/stores/vault.svelte.ts` (`.dirty` clean-toast `onDismiss` ~647)

### Fix
- Add `if (!isStillSameVault(deleteIdentity)) return result.success;` after the
  `flushPendingSave()` (~904) and `allSettled` (~949) awaits, before the in-memory
  loops. Wrap the `.dirty` clean-toast `onDismiss` `markClean` in
  `if (isStillSameVault(captured))` to match the quit-failure dismiss 30 lines up.
- Also delete (or route through `beginVaultGeneration`) the dead `setVaultPath`
  setter in `vault.svelte.ts` (~298) that bypasses the generation invariant.

---

## L5 — Single-line-CRLF flip on adopt; attachment-delete grace blocks rename queue

- **Status:** `[ ]`
- **Severity:** Low (cosmetic / responsiveness) · **Files:** `markdownFileWriter.ts` (adopt-sibling `markHydrated` with no `eol` ~256/283); `vaultExternalChanges.ts` (`handleExternalAttachmentChanges` 500 ms sleep inside the rename queue ~536-566)

### Fix
- Adopt-sibling hydrate: inherit the sibling's `FileState.eol` (or sniff from the
  live body) so a single-line-CRLF FM doesn't emit LF fences.
- Attachment-delete grace: run the deferral OUTSIDE the shared rename queue (it
  has its own re-existence + swap guards) so it doesn't stall unrelated `.md`/board
  reconciles.

---

# Phase 4 — Security (defense-in-depth)

> Only relevant if you ever open a vault you didn't create (hostile content could
> reach IPC via TipTap `html:true`). N/A for your own dogfooding, but worth
> closing.

## S1 — `vault:copy-file` source path is unvalidated

- **Status:** `[ ]`
- **Severity:** Medium (hostile-vault model) · **Files:** `src/main/ipc/vault.ipc.ts` (`vault:copy-file` ~916-987)

### Root cause
The handler `lstat`s the source (rejects symlinks) but never constrains WHICH file
the renderer may name as the source — only the destination is `assertWithinVault`-d.
A compromised renderer could read any host file into the vault (arbitrary read).

### Fix
1. Constrain the source: require it to live within a user-approved location (the
   vault, or a path most-recently presented via a native dialog / `webUtils`
   drop), or at minimum block sensitive OS locations (outside the user home).
2. Add a TOCTOU guard: re-`lstat` after open, and cap total bytes copied (not just
   the pre-read `size`) to defeat a device-swap (`/dev/zero`) on POSIX.

### Test
- `tests/unit/copyFileSourceGuard.test.ts` (new): a source outside the
  approved set is rejected. Bite-verify.

### Gate
- Add a check that `vault:copy-file` validates the source (not just the dest).

---

## S2 — Minor hardening: `http://`, reserved names, case-fold

- **Status:** `[ ]`
- **Severity:** Low · **Files:** `src/main/ipc/media.ipc.ts` (`ALLOWED_URL_PREFIXES` ~263; local-path branch ~293-352); `src/main/vault/fileOps.ts` (`isWithinVaultRoot` ~105-109)

### Fix
1. Drop `http://` from `ALLOWED_URL_PREFIXES` (keep `https://`, `mailto:`,
   `tel:`); log a warning for legacy `http://` link tiles instead of opening.
2. Add `assertSafeFilename(path.basename(target))` in the `media:open-external`
   local-path branch (blocks `CON`/`NUL` reserved names).
3. Case-fold both sides in `isWithinVaultRoot` on Windows (mirror
   `assertWithinVault`).

---

# Phase 5 — CI gate hardening (consolidated)

The whole point: make each invariant **structural** so the next sibling site is
caught. New/extended gates introduced by this plan:

| Gate | From | What it pins |
|---|:---:|---|
| `check-writer-path-honors-filepath.mjs` (extend) | H1, H2 | Creation paths persist `filePath` before command construction; `fileTags` tag-write uses `resolveTextTileVaultPath`. |
| `check-reconciler-vault-guard.mjs` (extend Part 1) | H3, M6 | `fileTagsCascade.ts` + `boardCacheFrontmatter.ts` live-path/captured-cache reads guard `isStillSameVault` after await. |
| `check-awaited-writes-bounded.mjs` (extend) | H4, M2 | `flushAll` per-key pre-drain present; board/config/misc self-heal a late success. |
| `check-no-silent-write-abort.mjs` (extend) | M1 | A failed-read branch can't flip `hydrated=true` without a write guard. |
| command-target / popup mount-capture gate (extend) | M3 | PropertiesPopup captures a mount-time board id. |
| board-path case-fold check (new) | M4 | No raw `===` path compares in board reconcile/rename. |
| pane-scope check (extend) | M5 | `dragDrop.ts` doesn't read global board/canvas facades. |
| copy-file source guard check (new) | S1 | `vault:copy-file` validates the source path. |

**Every gate change must be bite-verified** (temporarily introduce an offender →
gate fails) before it's considered done.

---

# Appendix A — Verified clean (do NOT re-fix)

These were probed adversarially and found correct; cross-referenced so they're not
re-flagged:

- Frontmatter CST engine byte-preservation of untouched/external keys (incl.
  empty keys `aliases:`, comments, anchors/aliases on untouched keys, exotic
  scalars, folded/literal blocks, CRLF, BOM). See `KNOWN_LIMITATIONS.md #1`.
- EOL re-application on the dirty-FM branch (single-line-CRLF matrix) — except the
  adopt-sibling hydrate gap (L5).
- Quit/flush **hang** defense (per-write 60s race on every wedge-prone scheduler,
  heartbeat-re-armed main timer, awaited sentinel flush before ready-to-quit).
- Silent-write-abort class on the write paths (every early-return either
  `markPathFailed`+throws or is a provably-safe version guard) — except the
  DocumentEditor hydrate path (M1).
- Orphan card/task FM write is delta-on-fresh-disk (execute AND undo); drag/
  reorder/multi-select survivor-anchor undo; column/section structure commands;
  recurrence/quick-add month-clamp date math.
- Undo snapshot discipline (deep clones, rebased undo, reverse-order batch
  rollback) — except PropertiesPopup's wrong-board push (M3).
- External-edit conflict core (synchronous `isDirty`, `isPathPending` authority,
  fresh-disk delta writes, post-write index refresh) — except `.board.json`
  case-fold (M4) and bulk reload (L3).
- Path-security primitives (symlink resolution, ADS/reserved-name handling on the
  write path, crash-safe atomic writes) — except the copy-file source (S1) and
  the minor items (S2).

# Appendix B — Findings downgraded from the agents (transparency)

- **L1** (empty-FM revert) was reported High/Confirmed-reachable; downgraded to
  Low/latent because the auto-`id` injection masks it for tile/doc-backed files.
- **L2** (`project.boards` mutation) was reported High; downgraded to Low because
  the mutated field is in-memory-only and never a write source.
- **S1** (`copy-file` read) was reported High; scoped to Medium under a
  hostile-vault threat model only — N/A for first-party use.

# Appendix C — Interim usage guardrails (until Phase 1 lands)

- Use one vault, single pane, on a **local disk** (not OneDrive/SMB), with the
  vault under version control / backed up.
- Open a subfolder Task once as a Document before editing its fields/tags cold (H1/H2).
- Don't switch vaults while a "Retry tag rename" toast is showing (H3).
- Avoid vault-wide tag renames on a network drive (H3/H4).
- If a Document opens unexpectedly **blank, don't type — reopen** (M1).
- Stay single-pane to sidestep M3/M5.

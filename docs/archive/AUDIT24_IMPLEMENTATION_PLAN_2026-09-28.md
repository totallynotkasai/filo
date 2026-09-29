# Audit-24 (Pre-Dogfood): Implementation Plan

Source: the 2026-09-28 pre-dogfood audit, a 9-agent adversarial workflow (6 finders, then 3 reviewers who tried to refute each finding), run on `d43f224`.
- 48 candidates: 47 confirmed (15 of them only partly) and 1 refuted. The refuted one, the trash purge on a volume with no Recycle Bin, is already KNOWN_LIMITATIONS #25.
- The reviewers raised 5 more findings. Two duplicate items below, so this plan tracks **50 items** (A24-01 … A24-50).
- None of them is caught by an existing test or gate.

The user's context sets the priorities:
- The vault syncs with Syncthing, but is used on **one machine**.
- No other editors run alongside Filo.
- All four board types are in daily use.
- The vault holds 500–5,000 notes.

So a bug whose trigger needs two machines ranks below one that single-machine use can hit.

Each phase leaves a working app, passes `npm run ci:verify`, and is committed on its own. Paths are relative to the repo root, and line numbers are from `d43f224` (they will drift). Choices not yet confirmed are marked `DECISION:` with a default.

## Scorecard at audit time

| Area | Score | Main reasons |
|---|---|---|
| Note safety (`.md` write path) | 8.5 | Fresh-read writes, STALE refusal, trash, rescue copies. One real gap: the frontmatter dump fallback (A24-05). |
| Board saving | 7.5 | A failed reload moves the drift baseline (A24-01). |
| Undo / redo | 7 | Cross-board cascade steps replay stale snapshots. |
| Close / quit / crash recovery | 8 | Thorough. The notes box, connection label, audio and raw view sit outside the guard. |
| External changes (Syncthing) | 7.5 | Good detection, with a few timing windows. |
| Error messages and prompts | 7.5 | Honest, but some wording is misleading. |
| Code health | 8.5 | Gates hold. One dead function (`clearCorruptConfigTarget`) and a few stale comments. |
| **Overall** | **~8** | |

Target after Phase 6: no area below 8.5.

## Phases

| Phase | Scope | Risk | Dogfood gate |
|---|---|---|---|
| 1 | Silent loss in everyday use: board baseline, audio, notes box, connection label, frontmatter dump, tag sweep, open re-entrancy | Medium | **Before real use** |
| 2 | Undo / redo across boards | Medium; touches the cascade and Task List commands | Before heavy multi-board use |
| 3 | The Raw view | Medium | |
| 4 | Note write-path and external-change edges | High; touches the note store and the watcher | |
| 5 | Config files, misc writers and board lifecycle | Medium | |
| 6 | Messaging, settings on leave, path security | Low | |
| 7 | Verification, docs, archive | None (no code) | Sign-off |

### Cross-cutting rules for every phase

- **Every data-loss fix gets a failing test first.** User-visible flows go in characterisation specs (through `harness/` only); everything else in unit or component tests. Confirm the test fails on the current code, then fix.
- **Every new invariant gets a gate** in the matching group module, proven to bite (plant the violation, see the gate fail, revert).
- Comments explain *why*, never history. Audit IDs (`A24-xx`) go only in commit messages.
- Update CLAUDE.md and KNOWN_LIMITATIONS.md in the same commit as any behaviour they describe.

---

## Phase 1: Silent loss in everyday use

### A24-01 · A failed board reload still moves the drift baseline (HIGH) — also closes #6

**What goes wrong.** `loadBoard` (`src/renderer/lib/boards/boardLoader.ts:466`) stamps the drift baseline as soon as the two bracketing stats match. That happens *before* the version gate (`from-future` L514, `no-migration-path` L526), the prune snapshot (`snapshot-failed` L552) and the Zod parse (`schema-invalid` L564).

When the reload fails:
- `reloadBoardFromDisk` keeps Filo's cache, but the baseline already names the outside file.
- The next `writeBoardFile` finds no drift, so `board:save` overwrites the outside version with no prompt and no `.filo/recovery` copy.

**The same root cause (old #6).** A silent reload abandoned by `guardPending`, because the user edited during the read (`boardDrift.ts:153`), has also already stamped. The armed write then overwrites the outside version while the drift prompt is open.

**Fix.**
1. `loadBoard` stops stamping. It returns `{ ok: true, data, stat, seq }` (the seq ticket taken before the read).
2. Callers stamp with `noteBaseline(path, stat.mtimeMs, stat.size, { ifUnchangedSince: seq })`, and only once they adopt the data into the cache:
   - the initial open (`boardCache` load and `ensureAllLoaded`);
   - `adoptBoardAtRuntime`;
   - `reloadBoardFromDisk` after `replaceCache`.
3. The `pending` branch of `reloadBoardFromDisk` stamps nothing, so the writer's drift check still fires and routes to the one prompt.
4. The watcher reconciler's `boardMatchesBaseline` is then correct by construction.

**Tests.**
- Unit: `loadBoard` on a `version: 9` file leaves the baseline unset or unchanged; same for a schema-invalid file.
- Characterisation: a board is replaced on disk by a v9 copy, the user moves a tile, the save meets the drift prompt, and Keep local backs up the v9 file first.
- Unit: a reload abandoned by `guardPending` leaves the old baseline in place.

**Gate.** `writePath/board-baseline-after-adopt`: `boardLoader.ts` must not call `noteBaseline`.

### A24-02 · An audio recording is lost or unlinked when its tile unmounts (MEDIUM) — also closes #28

**What goes wrong.** `AudioTile.svelte` persists `isRecording: true` (L131; `tileDefBuilder.ts` L88/L165 keep it). `onDestroy` (L289) calls `stop()`, but the async `onstop → FileReader → media:save-audio` then reads `vaultStore.path` and `boardStore.current` *later*, and finishes with `boardStore.updateTile`. That call returns silently when the tile isn't on the now-active board (`boardTiles.ts:62-65`).

What that means in practice:
- A tab switch leaves the recording saved but unlinked.
- Quit drops it.
- **Panning the tile off-screen** unmounts it through viewport culling, which stops the take early.
- After a reload the tile shows "Recording…" for good, and Stop does nothing because `mediaRecorder` is null.

`media:save-audio` (`src/main/ipc/media.ipc.ts:167`) also writes with `atomicWriteFile`, which overwrites, and its file name is unique only to the second.

**Fix.**
1. Never persist `isRecording`: drop it from `tileDefBuilder` and treat it as runtime state in the component. Existing files with `isRecording: true` load as `false`.
2. Capture the board id and vault root at `startRecording`. Save through `boardCacheStore.persistUpdateTile(tileId, …, capturedBoardId)` under `isStillSameVault`.
3. Keep a recording tile mounted: `visibleTilesViewModel` never culls a tile whose id is in a `recordingTiles` set (a runtime `SvelteSet` in `tiles.svelte.ts`).
4. `registerComponentFlush('audio recording', …)` stops the recorder and awaits the save, so leave and quit keep the take.
5. `media:save-audio` reserves the name with `createExclusiveFile`, bumping ` (2)` on EEXIST, and returns `errorEnvelope` with a code.

**Tests.**
- Component: a recording tile unmounted by a board switch still links the file to the original board.
- Unit: the culling view model keeps a recording tile.
- Main unit: two saves with the same timestamp name produce two files.

### A24-03 · A Task List notes-box draft in conflict is invisible to leave and quit (MEDIUM)

**What goes wrong.** `lib/tasklist/notesBox.svelte.ts` `save()`, on `conflict`, only pushes a toast (`promptNotesBoxConflict`); on a refused status it only toasts. It registers no held decision, unsaved source or component flush, and `TaskItem.svelte` saves only on blur (L850). So close, open-another-vault and quit drop the draft with no dialog and no rescue copy.

**Fix.** While `touched && draft !== currentBody`, NotesBox registers:
- an **unsaved source** (`registerUnsavedSource`, reporting the note path, with rescue text = the draft over the note's frontmatter);
- a **component flush** that re-runs `save()`.

Both are unregistered on destroy after a final save. The conflict toast becomes a held decision (`holdDecision` keyed `notes-box:<path>`), so the save popover can re-open it.

**Tests.**
- Component: a notes box with a conflicted draft makes `unsavedWork()` non-empty.
- Characterisation: close the vault → the dialog names the note → Close anyway → the rescue copy holds the draft.

### A24-04 · A connection label being edited is lost on quit, close or Ctrl+W (LOW, but in daily use)

**What goes wrong.** `ConnectionLabel.svelte` commits only on Enter (L187) or an outside pointerdown (L218-240). `onDestroy` (L242) never commits, and the component registers no component flush.

**Fix.**
- `$effect(() => registerComponentFlush('connection label', () => { if (isEditing && labelEditor) commitEdit(); }))`.
- `onDestroy` commits an uncommitted edit the way TileHeader and Frame do: snapshot the text, then run the command by captured board id.

**Test.** Component: an edited label, then `save()`, updates the connection.

**Gate.** Extend `components/teardown-save-registers-flush` to cover `ConnectionLabel.svelte`, if the pattern isn't already caught.

### A24-05 · The frontmatter dump fallback silently changes untouched values (MEDIUM)

**What goes wrong.** When the CST patch returns null (a flow-mapping root, or a changed key carrying an anchor, alias or tag), `assembleMarkdownFile` (`src/renderer/lib/editor/markdownSync.ts:528`) dumps `new Document(fm).toString()`. `fm` is the core-schema JS value, so the dump turns `02134` into `2134`, `1.10` into `1.1` and `0xFF00FF` into `16711935`. The tag rewriter's `dumpYaml(fm)` (`tagRewriter.ts` L512, L554, L614) behaves the same way. KNOWN_LIMITATIONS #1 wrongly says the data stays exact.

**Fix.**
1. Add `dumpPreservesUntouched(sourceFm, dumped, touchedKeys)` in `frontmatterCstModel.ts`. It re-parses the dump and compares, for every key not in the delta, the source node's *source text* (`node.source ?? String(node.value)`) with the dump's. Any difference → null.
2. Both dump sites use it: on null, take the keep-raw + `onFrontmatterRefused` path (the note gets the "frontmatter can't take this change" wording) instead of writing.
3. Correct KNOWN_LIMITATIONS #1.

**Tests.**
- Unit: `{title: Draft, zip: 02134, version: 1.10}` with a tag add is refused and the file is unchanged.
- Unit: a mapping with one `!custom` key and `zip: 02134` gets a status change, which is refused.
- Unit: a plain dump with canonical scalars still succeeds.

### A24-06 · A tag rename or delete during the first index build rewrites only part of the vault (LOW)

**What goes wrong.** `runTagRewriteSweep` (`src/renderer/stores/fileTagsCascade.svelte.ts:130-144`) samples `vaultIndexStore.allMetadata()`, and its callers never await `whenBuildComplete()`.

**Fix.** `renameTagEverywhere` / `removeTagEverywhere` await `vaultIndexStore.whenBuildComplete()` before sampling. While the index is building, the Tags Browser shows "Indexing notes…" on the rename and delete actions and disables them.

**Test.** Unit: a sweep started while `isBuilding` waits and then covers notes indexed after it started.

### A24-07 · openVault has no re-entrancy guard (MEDIUM)

**What goes wrong.** Take a second `openVault` started while another is loading, for example a click on a recent vault during the launch auto-open. Its first-open failure branch calls `releaseRegistryBestEffort` (`vault.svelte.ts` ~L498), an unconditional `vault:close` that releases the *other* open's registry. Every gated write is then refused. `HomeScreen.openRecent` has no busy state.

**Fix.**
1. A module-level `openInFlight` promise in `vault.svelte.ts`: `openVault` / `closeVault` return `'busy'` while one runs.
2. HomeScreen disables its cards and shows a spinner on the one opening.
3. `vault:close` takes the root it means to release. Main releases it only when the registry holds that path (case-folded); otherwise it's a no-op. Update `ipcSchemas.ts` and `ipcContracts.ts`.

**Tests.**
- Unit: two concurrent `openVault` calls; the second returns `'busy'` and the first commits with its registry armed.
- Main unit: `vault:close` with a different root leaves the registry alone.

### Phase 1 outcome

*Written in Phase 7 from the `4ae8858` commit message, since Phase 1 recorded no outcome here.*

All seven items are fixed in `4ae8858`. Two gates were added: `writePath/board-baseline-after-adopt` (A24-01) and `vaultIdentity/vault-open-one-at-a-time` (A24-07). KNOWN_LIMITATIONS #1 was corrected in the same commit.

**Deviations from the plan**

- **A24-02.** `isRecording` became runtime state (`recordingTiles` in `tiles.svelte.ts`) and was dropped from the tile def schema and builder, so a board file never holds a stuck `isRecording`. `media:save-audio` now creates exclusively (` (n)` on a taken name) and answers failures with `errorResult`. Ctrl+S leaves a take running; only leave and quit stop it and wait for its save.
- **A24-03.** Besides the held decision, a notes-box draft the note doesn't have is counted as unsaved work for the leave dialog, and its rescue copy carries the note's frontmatter.
- **A24-04.** The uncommitted label is written on unmount through the cache, by the connection's own board, not the active one.

---

## Phase 2: Undo / redo across boards

### A24-08 · A CascadeDeleteCommand redo that can't trash the file reports success (MEDIUM)

`groupAndBoardCommands.ts` L370-372: when `trashFiles` returns `[]`, execute returns normally. The next undo skips the restore and replays every `placement.undo()` into caches that still hold the placement, so it adds a duplicate.

**Fix.**
1. Throw `ChangeRefusedError` from execute when the redo's trash move fails, so history leaves the step where it was.
2. Make `persistAddKanbanPlacement` (`boardCacheKanban.ts`), `persistAddTaskPlacement` (`boardCacheTaskList.ts`) and the Mind Map re-add in the cascade idempotent: a no-op when the `tileId` is already placed.

**Tests.** Unit: a redo with a failing trash leaves the stack unchanged; a double `persistAdd*Placement` leaves one placement.

### A24-09 · A board reload doesn't clear cross-board cascade steps (MEDIUM)

`history.clearBoard` (L768-782) filters by `targetBoardId === boardId`. `CascadeDeleteCommand` sets `targetBoardId = ''` but holds snapshots for other boards, and the toast-offered off-stack cascade undo (`runOffStack`) is also missed.

**Fix.**
- Add `touchedBoardIds(): ReadonlySet<string>` to `Command`: the default is `{ targetBoardId }`, and `CascadeDeleteCommand` and `BatchCommand` return the union.
- `clearBoard` drops any command whose set includes the reloaded board, including the pending off-stack cascade (the toast's Undo then reports the step is gone).

**Test.** Unit: a cascade touching Kanban K, then reload K; the Mind Map stack no longer holds the cascade.

**Gate.** `commands/cascade-touched-boards`: a command class that holds placement snapshots for boards other than its target must override `touchedBoardIds`.

### A24-10 · Undo of a Task List move replaces the whole arrays (MEDIUM) — also closes #32

`MoveTaskBlockCommand.undo` (`taskCommands.ts` L366-372) passes full `before` snapshots to `persistTaskListStructure`, which assigns `tl.tasks` wholesale. `AddTaskCommand` / `DeleteTaskCommand` restore *absolute* section starts (`restoreSectionPositions`, L77-87). Either reverts or misplaces placement changes that other stacks made in between.

**Fix.** Record moves as a delta over the moved tile ids: the ordered id list, the source section id and index, and the target section id and index. Apply it to the live arrays. Section boundaries are recorded as **the first task id of each section** (or `null` for empty), and starts are recomputed from the live order on undo. The same change applies to `ReorderTaskWithinSectionCommand` and `restoreSectionPositions`.

**Tests.**
- Unit: move, then an off-stack removal of another task, then undo the move; the removed task stays removed.
- Unit: add T1, then an off-stack removal in section A, then undo the add; every task stays in its section.

### A24-11 · An execute body queued behind an async command runs on the wrong board (LOW)

`history.svelte.ts:545` runs `runChained(() => command.execute())` without the `onTargetBoard` wrapper that undo (L610) and redo (L685) use.

**Fix.** Wrap the deferred execute in `onTargetBoard(command, …)`.

**Test.** Unit: an AddTile queued behind a slow delete, then a tab switch; the tiles land on the original board.

### A24-12 · Undo's conflict check reads the lagging model; Apply anyway doesn't follow renames (LOW)

`applyDeltaChecked` (`frontmatterInverse.ts:302`) uses `noteStore.currentFrontmatter`, which lags the disk by the watcher debounce. The Apply anyway `commit` closure captures `relPath`.

**Fix.**
- Compare against `readNoteFresh` with the queued delta laid over it.
- Register the pending Apply anyway with `registerPathRenamable` so it follows a rename.
- Fix the L207-208 comment to describe what the code does.

**Tests.** Unit: an external change to the same key within the debounce raises the conflict toast; a rename between the toast and Apply anyway writes the renamed note.

### Phase 2 outcome

All five items are fixed in `bbc631b`. The regression tests are `cascadeRedoTrashRefused`, `historyReloadDropsTouchingSteps`, `taskUndoKeepsOtherChanges`, `historyQueuedUndoBoard` and `undoConflictFreshRead` (27 tests, all passing). The new gate `commands/cascade-touched-boards` was proven to bite: with `CascadeDeleteCommand`'s override renamed, it fails and names the class, then passes again once reverted. CLAUDE.md is updated (gate count 73, the `commands` row, and three new Undo/Redo bullets).

**Deviations from the plan**

- **A24-08.** The redo throws `ChangeRefusedError` only when the trash move is *refused*. If the file is already gone, the redo still removes the placements, since there is nothing left to trash and a refusal would pin the step for good. To support this, `trashFiles` can collect refused paths instead of reporting them. The Mind Map re-add needed no change: placements are keyed by tile id, so it was already idempotent.
- **A24-09.**
  - `DeleteTilesCommand` also overrides `touchedBoardIds()`, because it holds cross-board connections. The plan named only `CascadeDeleteCommand` and `BatchCommand`.
  - `clearBoard` drops touching steps only when a board is read again from disk (`{ changedOnDisk: true }`). Closing or deleting a board still drops only the steps that *target* it, so a cascade filed on another board keeps its file restore. The plan had every `clearBoard` call drop by the touched set.
  - A gate escape hatch was added, `// allow-own-board-only: <reason>`, for a command that looks cross-board but writes only its own board.
- **A24-10.** Section boundaries are not stored as "the first task id of each section". Each step records every task's section and order, before and after, in the new `lib/tasklist/sectionMembership.ts`. Undo and redo then move only the tasks the step moved, placing them beside their live neighbours, and recompute section starts. The reason: a first-task id breaks when that task is itself removed off the stack, while per-task membership still places everything. A deleted task comes back beside its nearest surviving neighbour. `ReorderTaskWithinSectionCommand` delegates to `MoveTaskBlockCommand`.
- **A24-11.** Only an execute body made for the *active* board is wrapped in `onTargetBoard`. A board-agnostic or cross-board execute runs where it is, without switching. As with a queued undo, a body whose board was closed meanwhile is rolled back with a toast.
- **A24-12.**
  - The fresh read goes through `noteStore.currentFrontmatter(path, { fromDisk: true })`, not a direct `readNoteFresh` call, so the queued delta is laid over it in one place.
  - "Apply anyway" follows renames through a small `followRenames` helper, which is built on `registerPathRenamable`.
  - Extra fix: `renameAllPathKeys` now iterates over a copy. Without that, a sweep that unregisters itself mid-rename (as this one does) made the next sweep get skipped.

---

## Phase 3: The Raw view

### A24-13 · The `rescued` flag outlives a cancelled leave or quit (LOW) — merges #12, #27 and the reviewers' related item

`takeRawRescueItems` (`rawViews.ts` L91-96) marks every dirty view rescued *before* `recovery:keep-unsaved` runs. A cancelled leave, a cancelled quit or a thrown rescue never clears the flag, so `NoteRawView` onDestroy (L174) later skips both the save and the rescue copy.

**Fix.** `takeRawRescueItems` returns `{ items, commit(keptPaths), rollback() }`:
- mark views rescued only in `commit`, for paths that were kept;
- `saveBeforeLeaving` and `keepRescueCopiesOrAsk` call `rollback()` on cancel or throw.

In addition, a view stores the text it rescued and skips its teardown copy only while `text === rescuedText`.

**Test.** Unit: a failed rescue, then Cancel, then more typing, then close the tab; a rescue copy of the new text is written.

### A24-14 · The follow-reload overwrites text typed during its read (LOW)

In `NoteRawView.svelte`, `load()` (L56-68) assigns `text = baseText` after the await.

**Fix.** Capture `typedAtStart = text` before the await. Skip applying (and re-arm the follow) when `text !== typedAtStart || saving || conflict`.

**Test.** Component: type during a slow `readRaw`; the typed text survives.

### A24-15 · Raw typing never reaches the save indicator or the crash sentinel (LOW) — merges #24 and #26

**Fix.**
- A `$effect` on `dirty` calls `noteAdditionalPendingPath(path)` / `dropPendingPath(path)` plus `notifyWriteState()`, so the indicator turns yellow and the sentinel covers it.
- `saveBeforeLeaving`'s `'rescued'` branch calls `markDirty(previousVault, paths)` as `leftBehind` does, so reopening the vault offers recovery.
- `DECISION:` no raw-view autosave. The raw view is a deliberate "edit the file as text" mode, and blur, Ctrl+S, leave and quit already save it.

**Test.** Component: typing in the raw view makes the indicator show unsaved.

### A24-16 · The raw view adopts a post-save read as its base (MEDIUM) — merges #38 and the reviewers' related item

`writeTyped` (L112-121) sets `baseHash` from `readRaw`, which first flushes the note's queue (landing a Kanban or Task List field delta, or a tag add) and then reads. The next raw save passes the hash check and wipes that change with no conflict and no backup.

**Fix.**
- `noteStore.writeRaw` returns the hash of the bytes it wrote, and the view sets `baseHash` to that.
- The follow-up `readRaw` then compares: if the hash differs, keep the view's text and raise the conflict banner. Keep mine backs up first, as today.

**Test.** Characterisation: a raw edit in the Document tab, then a Task List completes the task (a field delta), then a second raw save; the conflict banner shows and `completed: true` is not lost silently.

### A24-17 · `NoteEditorView.serialize` ignores `setBody`'s refusal (LOW) — merges #22 and #33

`noteEditorView.ts` L93-118 clears `unserialised` whatever `setBody` / `setBodyBuiltOn` return.

**Fix.**
- Clear `unserialised` only on `'queued'`.
- On `'missing'`, route the text to the deleted-with-unsaved prompt (**Save as new file**).
- On `'read-only' | 'loading' | 'unreadable' | 'not-open'`, keep the flag and `reportError` naming the note, so leave and quit ask and the rescue copy takes the editor's text.

**Test.** Unit: serialise against a model in `missing` keeps `hasUnserialisedKeys()` true.

### Phase 3 outcome

All five items are fixed. The regression tests are the characterisation specs `rawViewSaveBase` (A24-16) and `rawViewRescueAndIndicator` (A24-13, A24-15), the component tests `noteRawViewFollow` (A24-14) and `noteEditorRefusedBody` (A24-17), a new assertion in `quitFailureMessage` (the quit path's rollback), and updated `noteRawView` unit cases for the new `writeRaw` result. Each new test was run against the pre-fix code and failed there. No gate was added: none of the five fixes creates a static invariant that a source scan could check.

**Deviations from the plan**

- **A24-13.**
  - The rollback is a module-level `rollbackRawRescues()`, not a `rollback()` on the object `takeRawRescueItems` returns. The reason: `keepRescueCopies` sits between the take and the caller's decision, and the caller never sees that object. `takeRawRescueItems` returns `{ items, commit(keptPaths) }`, and `keepRescueCopies` calls `commit(result.kept)` once the copies are written.
  - The quit path gets the rollback through a new injected dep, `rollbackRescue` (wired in `App.svelte`), to match how `handleFlushAndQuit` takes its other deps.
  - The regression test is a characterisation spec rather than a unit test. It makes the rescue fail by putting a file where `.filo/recovery/` should be. The closing harness helper `closeVault` now takes a list of answers.
- **A24-14.**
  - `load(follow)` gives way to text typed during its read on *every* reload, including "Show the new version".
  - Only a follow-reload re-arms when a save or a conflict got in the way.
  - The regression test is a component test.
- **A24-15.**
  - Besides the `noteAdditionalPendingPath` / `dropPendingPath` effect, dirty raw views are registered as an armed-path source. Without that, another writer finishing a write of the same note would clear the pending mark while the raw text was still unsaved.
  - The view drops its pending mark in `onDestroy` too, so a view that closes dirty leaves no stale mark.
  - The `rescued` branch names the files in their on-disk spelling, through the new `unsavedPathsAsSpelled`. The ledger keys are case-folded, so the plain keys would have made the recovery modal list `plan.md` for `Plan.md`.
  - Extra fix: `leftBehind` had the same case-folding problem and now uses the same helper.
  - The regression test is characterisation: the indicator shows "saving" while text is typed, and after Close anyway on a raw conflict, reopening the vault lists the note.
- **A24-16.**
  - `writeRaw` returns `RawWriteResult` (`{ status, hash }`).
  - When a change has landed on top of the save but nothing was typed since, the view follows that change instead of raising the banner. The banner shows only when typing went on, since only then was the text built on the older version.
- **A24-17.**
  - On `'missing'`, the new `noteStore.holdBodyOfMissing` makes the editor's text the model's unsaved body and raises the existing deleted-with-unsaved prompt. That prompt offers **Keep mine** (write it back) or **Discard**; "Save as new file" is the wording of the other prompt, the write-target-missing one.
  - On `'loading'`, the view retries once the note has loaded, with no toast.
  - The other refusals are reported once per kind, not at every keystroke.
  - A new `ViewHooks.unserialisedBody` lets `noteStore.unsavedTexts()` put the editor's refused text in the rescue copy.
  - The regression test is a component test rather than a unit test, since it needs a real editor. The component test helper `recordingFilo` now answers `vault:trash-list`, because a missing note's banner lists the trash.

---

## Phase 4: Note write-path and external-change edges

### A24-18 · The "reloaded and much shorter" safety net lives only in a toast (LOW) — merges #14 and #40

In `notePrompts.ts`, `promptReloadShrank` (L217-236) holds `priorBody` only in a non-sticky toast's closure.

**Fix.** Before adopting a version that shrank past the threshold:
- write `prior` over the base frontmatter to `.filo/recovery/<ts>-keep/` through `recovery:keep-unsaved` (purpose `keep`);
- make the toast sticky, offering **Undo reload** and **Show in folder**.

**Test.** Characterisation: a clean note truncated on disk gets a `-keep` copy holding the long body.

### A24-19 · A transient read error in `onDiskChanged` drops the change (LOW)

**Fix.** On a non-ENOENT error, retry with the index's backoff (3 attempts, `TORN_RETRY_MS`), then log once. The next edit's drift check stays the backstop.

**Test.** Unit: EBUSY then success; the model adopts the change.

### A24-20 · An own-write echo is still trusted after a foreign version was adopted (LOW)

**Fix.**
- Renderer: when `onDiskChanged` adopts bytes that aren't the latest own write, it clears `writer.ownWrites[path]`.
- Main: `watcherSuppression` clears `ownBytes` for the path once it reports a foreign event.

**Tests.**
- Unit, both sides: A (own), then C (foreign, reported), then A again within the window; A is reported.

### A24-21 · `onDiskChanged` can decide on a read that predates Filo's own write (LOW)

**Fix.** Capture `m.base?.hash` and a write generation before the read. If either changed when the read returns, read again (up to 2×) before deciding.

**Test.** Unit: a write lands during the read; the model doesn't roll back.

### A24-22 · The "deleted with unsaved edits" held decision can never be held (LOW)

In `notePrompts.ts`, `stillHeld` (L129) requires `m.status === 'missing'`, but the unsaved branch leaves the status alone.

**Fix.** Base it on `noteStore.get(m.relPath) === m && m.hasUnsavedBody && m.fileGone`, where `fileGone` is a new flag set in the missing branch.

**Test.** Unit: the held decision stays listed while the file is gone and the edit unsaved.

### A24-23 · Identical text on disk still raises a conflict (LOW)

**Fix.** In `noteWriter.writePending` (L499-511) and in `onDiskChanged`'s `bodyChanged`: when the disk body equals the pending or local body, adopt the disk as the base and clear `hasUnsavedBody`, with no conflict.

**Test.** Unit: disk = pending body; no prompt, and the base moves.

### A24-24 · Keep mine / Reload release the decision they just re-held (LOW)

In `notePrompts.ts` `promptConflict` (L60-79), `finally → releaseDecision` removes the decision that `resolveConflict` re-registered.

**Fix.** Release only when `m.status !== 'conflict'` after the await. Show a toast when Keep mine meets ENOENT, offering **Save as new file**.

**Test.** Unit: backup fails, then Cancel; the decision stays held.

### A24-25 · Editing a `.txt` behind a File tile shows a false "missing" warning (LOW)

`vaultExternalChanges.ts` `handleExternalMarkdownChanges` (L127-139) treats a null index entry as deleted, and the index skips non-Markdown files.

**Fix.** For a path the index doesn't handle (not `.md`), decide "deleted" with a `vault:file-exists` probe. Better: route `.txt` changes through the attachment reconciler, and keep `document` only for rename correlation.

**Test.** Unit: a `.txt` change event with File tiles pointing at it produces no missing prompt.

### Phase 4 outcome

All eight items are fixed. The regression tests are:
- the characterisation spec in `syncedVault` (A24-18);
- the new unit file `noteDiskChangeEdges` (A24-19 to A24-24, 8 tests);
- a new case in `watcherOwnWriteBytes` (the main-process half of A24-20);
- two new cases in `vaultExternalChanges` (A24-25).

Each new test was run against the pre-fix code and failed there. The test helper `memoryVault` gained `failNextRead` and `duringRead` (a read held open after it has taken the bytes). No gate was added: none of the eight fixes creates a static invariant that a source scan could check.

**Deviations from the plan**

- **Structure.** `onDiskChanged` moved out of `notes.svelte.ts` into the new `stores/noteDiskChanges.ts` (`createDiskChangeHandler`). `notes.svelte.ts` was at 965 lines, and this phase's additions would have taken it past the 1000-line gate. The store keeps `noteStore.onDiskChanged` as a one-line delegate.
- **A24-18.**
  - `recovery:keep-unsaved` had no purpose argument, so it gained an optional third one, `'keep'`, which names the folder `<ts>-keep/` instead of `<ts>-unsaved/`. Neither kind is pruned.
  - The copy's text is taken from the model *before* the adoption, but written just after it. The adoption stays synchronous with the decision, so a second disk change can't slip in between. The text is already in memory, so nothing is lost by writing it a moment later.
  - The toast has its own dedupe key (`reload-shrank:`). With the conflict key, the next clean reload of the note would have dismissed it.
  - If the copy can't be written, the toast says so and offers no **Show in folder**.
- **A24-19.** The retries share the torn-read schedule and attempt counter (`DISK_RETRY_MS`, 500 / 1500 / 3000 ms). After the last one the failure is logged with `console.warn`.
- **A24-20.**
  - Main clears the whole write window for the path, not only `ownBytes`. An empty `ownBytes` list means "drop every event while the window is open", so clearing only the list would have hidden *more*.
  - Main clears it only when a probe shows other bytes. It does not clear it when the file is seen missing, since that is not a version of the file.
  - The renderer forgets its last write on every `replace`, `take-frontmatter` and `conflict` decision.
- **A24-21.** The "write generation" is a per-path count of writes started (`writer.writeCount`). The re-read happens at once, with no wait. If a write is still in flight at the second read, its old bytes still match the base, so they are ignored.
- **A24-22.** `fileGone` is a plain (non-reactive) field. `stillHeld` also accepts `status === 'missing'`, which `holdBodyOfMissing` (Phase 3) uses.
- **A24-23.**
  - In the writer, a body on disk that equals the pending one is not drift. The write then skips unchanged bytes, and `onWritten` clears the unsaved flag and moves the base.
  - In the watcher, a new decision input, `diskHasLocalBody`, maps to `replace`, which also drops the matching pending body.
- **A24-24.**
  - The release check reuses the decision's own `stillHeld`.
  - Keep mine on a vanished file raises the existing write-target-missing prompt (**Save as new file** / **Discard change**). It also returns the note to `ready` and sets `fileGone`, so the note isn't left in `conflict` after a Save as new file.
- **A24-25.**
  - The plan's "better" option was taken: non-Markdown `document` events go to the attachment reconciler, which checks the file on disk after its grace window. Rename correlation in main is unchanged.
  - A note model loaded for such a path still gets `onDiskChanged`.
  - Not covered: a Markdown note under a hidden folder (`.stversions/`), which the index also skips, still reads as deleted. That only matters if a tile points into a sync client's archive, which the sidebar never shows.

---

## Phase 5: Config files, misc writers and board lifecycle

### A24-26 · Config baselines are stamped seconds after the read (LOW)

**Fix.** In `vaultCandidate.ts`:
- take `baselineSeq` and stat the four configs before `config:load-all`;
- stat them again after it;
- stamp at step 10 only the files whose two stats match, and leave the others unstamped so the first write checks the disk bytes.

**Test.** Unit: a stat change between the load and the stamp leaves that config unstamped.

### A24-27 · `sidebar-order.json`, `hotkeys.json` and `viewports.json` have no drift check (LOW)

**Fix.** Seed a stat baseline at load, and check it in `miscWriteScheduler.performWrite`:
- `viewports.json`: last writer wins. Silently re-read, merge per board id, then write.
- `sidebar-order.json`: re-read, merge per folder key (local wins for folders changed this session).
- `hotkeys.json`: the configDrift Reload / Keep local prompt.

Wire the `config` reconciler for these files so an outside change re-reads them when nothing local is pending.

**Test.** Unit: an outside `sidebar-order` change for folder B, then a local reorder of A; both survive.

### A24-28 · A corrupt or briefly locked view-state file makes every leave say "couldn't be saved" (LOW) — includes the dead `clearCorruptConfigTarget`

**Fix.**
- View-state targets (viewports, sidebar-order) are droppable. A corrupt mark skips their write and reports it once, and they don't count in `unsavedWork().failed`.
- On `__loadAllFailed`, retry the load at the first write instead of pausing for the session.
- Wire `clearCorruptConfigTarget` to the watcher: a config file that parses again after an outside change is un-paused.
- Fix the toast so it offers only actions that exist.

**Test.** Unit: a corrupt `viewports.json`, then a pan, then leave; no "couldn't be saved" dialog.

### A24-29 · Reloading an outside `app.json` keeps the old vault name (LOW)

**Fix.**
- `reloadConfigIntoMemory` also takes `disk.name` into `project.name`.
- `writeConfigs` rebuilds the remaining payloads from the live getter after an `adopted` verdict.

**Test.** Unit: reload an `app.json` with a new name, then save; the new name is kept.

### A24-30 · Deleting a board goes ahead after a failed final flush (LOW)

**Fix.** In `boardCacheDelete.ts:97`, when `flushWrite` fails, write the cached JSON as a rescue copy (`recovery:keep-unsaved`) before trashing, and say so in the "moved to Filo's trash" toast.

**Test.** Unit: a failing flush then delete; a rescue copy exists.

### A24-31 · The pre-prune board snapshot is prunable (LOW)

**Fix.** In `boardLoader.ts:545`, pass purpose `keep` when the prune drops tile types or refs, so the copy lands in a `-keep` folder the prunes skip.

**Test.** Unit: a load that drops an unknown tile type writes a `-keep` snapshot.

### A24-32 · A board that failed to load misses in-app renames and deletes (LOW) — includes the reviewers' `ensureAllLoaded` item

**Fix.**
1. `ensureAllLoaded` returns the boards it couldn't load. `vaultFolderOps` and `vaultDeleteOps` show a toast naming them (*"Plan couldn't be updated because it isn't loaded; its links to the moved files will need re-linking."*).
2. Record the session's in-app renames and deletes (old→new pairs from `renameAllPathKeys`, and trashed paths) in a per-vault journal. `adoptBoardAtRuntime` replays them through `propagateRename` and the cascade planner before `replaceCache`, and marks the board dirty.

**Test.** Unit: a failed board, then a folder rename, then adopt; the adopted board's paths point at the new folder.

### A24-33 · A write past the 60 s timeout drops out of ordering (LOW)

**Fix.** On timeout, keep the raw `writePromise` as a per-key zombie that `drainPriorInFlight` awaits before firing the same key again. Attribution (the failure report) stays immediate.

**Test.** Unit: a stalled write, a timeout, then a second write; the second fires only after the first settles.

### A24-34 · External renames during a leave leave no breadcrumb (LOW)

**Fix.** When the queue skips a rename task because its vault is retiring or tearing down, or when `runExternalRenameCascade` bails on a vault change, write the rename-cascade sentinel against the captured root first. The registry is still armed until `vault:close`, and the next open replays it.

**Test.** Unit: a rename enqueued after retire writes the sentinel.

### A24-35 · Same-size foreign writes in the board save-to-stat gap (LOW, theoretical)

**Fix.** `advanceReconcileSnapshot` (`fileWatcher.ts` L281-305) hashes the file and moves the snapshot only when the hash equals the written bytes. Update the stale comment at `boardWriteScheduler.ts:351-353`.

**Test.** Main unit: a different same-size file at stat time; the snapshot isn't moved.

### Phase 5 outcome

All ten items are fixed. The regression tests are:
- the new unit file `configMiscDrift` (A24-26, A24-27, A24-28; 8 tests);
- the new unit file `configFileReconciler` (the watcher side of A24-27 and A24-28, and A24-29; 7 tests);
- two new cases in `boardCacheDeleteBoardCancelPending` (A24-30);
- a new assertion in `nonFiniteCoordsAndUnknownTileTypes` (A24-31);
- the new unit file `unloadedBoardsCatchUp` (A24-32; 3 tests);
- the new unit file `overdueWritesAndSkippedRenames` (A24-33 and A24-34; 4 tests);
- a new case in `fileWatcherReconcile` (A24-35).

Each new test file was run against the pre-fix source and failed there (23 failures; the passing cases are controls). Three gates were added or extended, each proven to bite:
- `writePath/config-writes-drift-checked` (new): no renderer code invokes `config:save` except the two drift-checked writers; `saveMiscConfig` is only called after `readOutsideVersion`; `vaultCandidate.ts` and `hotkeys.ts` seed config baselines with `statConfigsBeforeRead` + `seedConfigBaselines` and never `noteBaseline`.
- `writePath/unloaded-board-catches-up` (new): `boardDiscovery.ts` and `boardCache.svelte.ts` record a failed load and replay missed renames on a later one; the open records the boards that failed.
- `writePath/awaited-writes-bounded` (extended): the timeout branch tracks the overdue write, and the drain waits for it.

**Deviations from the plan**

- **A general "unverified" baseline mark.** A24-26 says to leave a moved file unstamped "so the first write checks the disk bytes", but a file with no baseline was written blind. `fileBaselineRegistry` gained `markBaselineUnverified` / `isBaselineUnverified`: a writer reads such a file before writing over it, as if its baseline had drifted, and any stamp clears the mark. A24-26, A24-27 and A24-28 all use it. The seed lives in a new `lib/vault/configBaselineSeed.ts`, and it also covers `viewports.json` and `sidebar-order.json`; `hotkeys.json` is seeded the same way by `loadHotkeyOverrides`, which reads it separately.
- **A24-27.**
  - The check lives in a new `lib/boards/miscConfigDrift.ts` (`readOutsideVersion`, `saveMiscConfig`, `settleOutsideVersion`), called from each writer's `write`, not inside `miscWriteScheduler.performWrite`: only the writer knows how to merge its own state.
  - The sidebar order moved out of `vault.svelte.ts` into a new `stores/sidebarOrder.svelte.ts`. `vault.svelte.ts` was at its 1500-line ceiling; it is now 1467, and its allowlist row was lowered to match.
  - A viewport merge keeps the entry with the later `updatedAt` (ties keep this session's), and a board removed this session stays removed.
  - The watcher side is a new `stores/configFileReconciler.ts`, registered for the `config` kind (until now a no-op). It reads the vault root from `activeVaultPath`, not the vault store.
  - The Reload / Keep local prompt names "shortcuts" for `hotkeys.json`. A file that already holds what Filo would write is taken silently.
- **A24-28.**
  - View state (viewports, sidebar order) is `droppable`: any failure to save it, not only a corrupt mark, is dropped with one notice per file per session and never counted in `unsavedWork().failed`. A lock at quit would otherwise still hold up the close. KNOWN_LIMITATIONS #38 records this.
  - A droppable write re-reads a file marked unreadable each time, so a view state file fixed by hand saves again without the watcher.
  - On `__loadAllFailed`, nothing is paused any more: every loaded config is marked unverified. The first settings save reads the file; if it now differs from the defaults Filo shows, it asks Reload / Keep local (Keep local copies it first). The warning says so. The prompt's wording is the "changed outside Filo" one.
  - `clearCorruptConfigTarget` is wired to the watcher. A settings file that reads again is un-paused and marked unverified, and a held-back change is rescheduled (`rescheduleConfigWrite`), so its next write asks. It is not reloaded silently: memory may hold changes made while it was paused. `hotkeys.json` is reloaded silently when no shortcut change is waiting, and rescheduled (so it asks) when one is.
  - The CONFIG_CORRUPT toast no longer offers "Use defaults", which has no button.
- **A24-29.** `writeConfigs` gained an optional `live` getter; the scheduler passes the latest args getter, and tests keep the old signature.
- **A24-30.** If the rescue copy can't be written either, the board is not deleted (reported), rather than trashed without its last changes. The toast names the rescue folder.
- **A24-32.**
  - The journal is a new `stores/unloadedBoards.ts`. It records renames through a `renameAllPathKeys` sweep, so external renames are replayed too, and it replays only renames made after the board failed, so a board delivered later is not rewritten by an older rename.
  - Deleted files are not replayed through the cascade planner. Their tiles stay and show as missing once the board loads, where Re-link or Remove is offered, rather than being removed unseen. KNOWN_LIMITATIONS #37 records this and the session-only journal.
  - Each unloaded board is named once per session per kind of change, since a board broken for the whole session would otherwise raise the notice on every rename. The notice covers the boards that failed at open too, not only those `ensureAllLoaded` couldn't load (a board that failed at open isn't in `project.boards`, so `ensureAllLoaded` never sees it).
- **A24-33.** The zombie wait is bounded by one more `writeTimeoutMs`, so a write that never settles can't hang a flush or quit. A zombie still out after that is marked `overtaken`. If it later lands, the key's newest write fires again, so the newest bytes are last on disk. A late write that fails fires nothing. The existing `writeGenerationPruning` case (A times out, B and C follow, A lands) now settles its re-fire before it ends; otherwise that re-fire timed out during the next test.
- **A24-34.** `enqueueRenameQueueWork` gained an `onSkipped` callback. It runs only for a task skipped because its vault is being let go, with the identity captured at enqueue. `runExternalRenameCascade` leaves the breadcrumb at its two pre-mutation bails. The helper is `keepSkippedRenameBreadcrumb`; a failure to write it is logged, not toasted, since the vault may already be closed.
- **A24-35.** Compares the bytes (`Buffer.equals`) rather than hashing both, and only up to the watcher's 10 MB hash ceiling; above it the size check stays. The walk already re-reads a file younger than 5 s, so the gap is open only when the foreign write carries an old modification time (Syncthing keeps the source's). The test sets one. KNOWN_LIMITATIONS #14 now describes the backstop as it is.
- **Also changed.** The step-1 comment in `vaultCandidate.ts` read `` `.filo/*.json` ``. The gates' simple comment stripper took the `/*` inside it as the start of a block comment and dropped half the file from every scan of it; it was reworded.

---

## Phase 6: Messaging, settings on leave, path security

### A24-36 · Unsaved theme-editor and Settings edits are dropped on quit or close (LOW)

**Fix.** `vaultLeaveGuard` and `handleFlushAndQuit` consult `themeEditorHasChanges()` and `pendingSettingsStore.isDirty`. When either is set, ask **Apply / Save**, **Discard** or **Cancel** (reusing `settleThemeEditor` and `settleUnappliedEdits`) before the save runs.

**Test.** Component: dirty pending settings, then quit; the prompt appears.

### A24-37 · Retry's toast promises more than it does (LOW)

**Fix.** After Retry, diff `unsavedWork().failed` before and after, and name what still can't be saved and why. Word the toast per kind. Theme and template saves say "Retry again from here", not "at quit".

### A24-38 · The quit dialog calls a pending decision "Save failed" (LOW)

**Fix.** When every blocking item is a held decision, title the dialog *"Waiting for your decision"* and offer **Show decisions** (opens the save popover) instead of **Retry now**. Mixed cases list both.

### A24-39 · Tag-delete Undo's restored filters are overwritten by a mounted view (LOW)

**Fix.** `tagUndo.undoRemoval` replaces the settings object (not an in-place mutation) and calls `bumpBoardViewRevision(boardId)`.

**Test.** Unit: delete a tag, undo, flush; `lastView` keeps the chip.

### A24-40 · `assertWithinVault`'s canonical fallback returns a lexical path (LOW; security hardening)

**Fix.**
- `assertWithinVault` returns the canonical target when its canonical branch accepts.
- `vault:rename`, `vault:copy-file` and the media handlers compute every relative path from the canonical root and target.
- Also reject any lexical relative path starting with `..` in handlers that apply `.filo/` guards.

**Tests.** Main unit: an 8.3-alias path into `.filo/` is refused by `vault:rename`.

**Gate.** `ipcSecurity/relative-from-canonical`: handlers must not call `relativePosix(vaultRoot, …)` on a path `assertWithinVault` checked.

### Phase 6 outcome

All five items are fixed. The regression tests are:
- the new unit file `settingsOnLeave` (A24-36; 7 tests: quit, close and open another vault, each with Apply / Discard / Cancel and the theme editor);
- the new unit file `retryAndDecisionMessages` (A24-37 and A24-38; 9 tests);
- a new case in `tagUndo` (A24-39);
- the new unit file `filoGuardOtherSpelling` (A24-40; 7 tests).

Each new test was run against the pre-fix source and failed there (the passing cases are controls). Two gates were added (77 in all), each proven to bite:
- `ipcSecurity/relative-from-canonical` (new): no `relativePosix` / `path.relative` in `src/main/ipc` or `src/main/protocol` (escape hatch `// allow-lexical-relative: <reason>`); `assertWithinVault`'s canonical branch returns the canonical pair; `vaultRelativeWithin` takes its relative path from that pair.
- `writePath/leave-settles-unapplied-settings` (new): `saveBeforeLeaving` settles Settings edits before it freezes the editors, `handleFlushAndQuit` before `freeze()`, and `App.svelte` hands the quit handler `openSettingsEdits` and `settleOpenSettings('quit')`.

**Deviations from the plan**

- **A24-36.**
  - The prompts live in a new `lib/settings/settleOpenSettings.ts`, which runs `settleThemeEditor`, then `settleUnappliedEdits` for Global Defaults, then for Current Board (so up to three prompts, one per scope, each naming the action: "quit Filo", "close the vault", "open another vault"). A settled tab is re-armed from the live values (`startGlobal` / `startBoard`), as the dialog's own bulk actions do, because the leave can still be called off later and the dialog stays open.
  - `vaultLeaveGuard` loads that module with a dynamic `import()`. A static import made the settings stores part of the test setup's import graph (`setup.ts` → … → `vault.svelte.ts` → `vaultLeaveGuard`), so `vi.mock` of `pendingSettings` stopped working in `unappliedEditsPrompt.test.ts`; it also closed a `vault.svelte` ↔ `pendingSettings` import cycle. A failed load stays on the vault (reported), never drops the edits.
  - On quit, the prompt is asked before the editors freeze and before the drain, after `app:quit-awaiting-user` (main would otherwise close the window under it after 5 s). Main then no longer bounds the rest of that quit with its heartbeat timer; the renderer's own 60 s drain deadline still does. With nothing unapplied, nothing is awaited, so the first heartbeat still goes out synchronously.
  - The plan's component test is a unit test: `handleFlushAndQuit`, `saveBeforeLeaving` and the real prompts, with `pendingSettingsStore` mocked.
  - The characterisation harness's `stopApp` now answers **Discard** to any such prompt while it closes the vault. Several `themes` specs end with the theme editor still open and changed, and the new prompt otherwise waited forever in teardown. Only the harness changed; the specs are untouched.
- **A24-37.**
  - The Retry handler moved out of `App.svelte` into a new `lib/boards/retryFeedback.ts` (`retryAndReport`). It diffs `unsavedWork().failed` before and after, describes what is left with `describeUnsaved`, and words it with a new pure `retryResultText` in `unsavedMessages.ts`, grouped by kind: a board or note write ("another program may be holding it", retried on every save and asked about before leaving), a theme or template save ("tried again only from here"; new `componentRetryPaths()` in `componentWriteRetry.ts`), a held decision (named by `heldDecisions()` or a `conflict` cause; no retry helps), a missing file and a non-UTF-8 note. Everything saved gives a short success toast.
  - The toast is one paragraph (toasts render no line breaks), names up to three files, and carries its own **Retry again** when a write could still succeed, so "Retry again from here" is literally on it. It replaces the previous result toast (`dedupeKey`).
- **A24-38.**
  - A new pure `quitDialog` in `unsavedMessages.ts` decides the title from the held decisions' paths (`heldDecisions()`, passed in by `App.svelte`). "Waiting for your decision" is used only when every unsaved item is a held decision and no failed write preserved a `.tmp`; **Show decisions** sends `app:cancel-quit` and opens the save popover (`saveStateStore.requestDetails`). In a mixed case the dialog stays "Save failed" with **Retry now**, and `quitFailureBody` names how many of the items are waiting for a decision, in place of the old conflict-only line.
- **A24-39.** As planned: `restoreFilterChip` gives the board a new settings object (and a new saved view or `lastView`) holding the chip, marks it dirty and bumps its view revision.
- **A24-40.**
  - `assertWithinVault` now returns `{ root, target }`: the resolved pair, or the canonical pair when only the canonical forms matched. The symlink walk moved unchanged into `assertNoLinkOutOfVault`.
  - The relative path comes from a new `vaultRelativeWithin(vaultRoot, target)` rather than each handler reading the pair: it also throws for anything still starting with `..` or absolute, which covers the plan's third bullet in one place. `vaultRelativeIfInside` serves `vault:copy-file`'s source, which may be outside the vault; an inside source that `assertWithinVault` refuses (a link out, an unstatable folder) still gets its lexical path checked, so it can't skip the `.filo/` guard.
  - Beyond the handlers the plan named (`vault:rename`, `vault:copy-file`, media), `vault:create-folder`, `vault:delete` and `board:create` now use it too; the gate covers every handler file. The test uses a junction as the stand-in for an 8.3 alias (both are the vault spelled another way; a junction needs no admin rights and works on the CI runners).

---

## Phase 7: Verification, docs, archive

1. Run `npm run ci:verify` and `npm run test:e2e` locally, and the Windows job on CI.
2. Real-app check, following the dogfood checklist, on a copy of the Book Vault inside a Syncthing folder:
   - record audio then switch tabs, and pan away while recording;
   - edit a connection label then quit;
   - put a notes-box conflict before a close;
   - drop a v9 board in from outside, then move a tile;
   - raw view, then a Task List complete, then save;
   - rename a tag during the open.
3. Update KNOWN_LIMITATIONS (#1 corrected; entries for any gap this plan accepts instead of fixing), CLAUDE.md (the new gates and the `loadBoard` stamping rule) and the gates count.
4. Move this plan to `docs/archive/`.

### Phase 7 outcome

**1. Automated checks.**
- `npm run ci:verify` passes on `bc28e7d`: lint, svelte-check (837 files, 0 errors), `typecheck:main`, `test:unit:strict` (717 files; 6,782 passed, 5 skipped), build, and 77/77 gates. The 5 skips are platform-gated: 4 are the symlink cases, which this Windows account can't create links for.
- `npm run test:e2e`: 13 of 48 pass, run with `--workers=1` (see the deviations). The failures are the harness gap known since Audit-15, not regressions from this plan (details below).

**2. Real-app check.** Run on the built app (`dist/main/main.js`) through Playwright `_electron`, with the folder picker stubbed in main, on fresh vaults in the session scratchpad. All six scenarios pass on data safety, and no renderer errors were logged apart from the expected `from-future` board error.
- **Audio.** A take is saved and linked when its tab is switched mid-recording. Panning 6,600 px away keeps the recording tile mounted and recording. Nothing was left stuck in "Recording…".
- **Connection label.** Text typed and not committed, then the window closed: the label text is in the board file on disk.
- **Notes box.** A draft plus a body changed on disk from outside, then open another vault. The leave dialog names the note as "waiting for your answer". **Open anyway** writes `.filo/recovery/<ts>-unsaved/Alpha task.md` with the draft, keeps the other version on disk and keeps the sentinel.
- **v9 board.** A board overwritten with `version: 9` stays byte-identical through a tile move and through **Quit anyway**. The drift toast offers Reload / Keep local, and a rescue copy of Filo's version is written.
- **Raw view then Task List tick.** `completed: true` stays on disk after the raw view saves. The raw view shows its conflict banner, and quit is held by a dialog.
- **Tag rename during the open (3,000 notes).** Rename and Delete are disabled with "Indexing notes…" for the first ~5–7 s. Once enabled, a rename reached all 3,000 notes (0 left with the old tag). The sweep took about 180 s with no progress shown.

**3. Docs.** KNOWN_LIMITATIONS #1 was already corrected in Phase 1, and CLAUDE.md already carries every new gate, the `loadBoard` stamping rule and the count of 77 (checked against `node scripts/gates/run.mjs --list`). KNOWN_LIMITATIONS #5 gained the gap found in step 2 (below).

**4.** This plan moved to `docs/archive/`.

**Deviations from the plan**

- **No CI run.** The commits are not pushed, so the GitHub Windows job has not run. Its two commands (`test:unit:strict`, `typecheck:main`) passed locally on Windows 11 as part of `ci:verify`. The next push runs both jobs.
- **No Book Vault or Syncthing folder.** The Book Vault's location is unknown, and no Syncthing folder was available to the check. Each scenario built its own vault, and "sync" was simulated by writing files from the test script. The Syncthing-specific timing paths stay covered by the characterisation spec `syncedVault` and the unit tests from Phases 4 and 5.
- **E2E.** 35 of 48 failed on the first single-worker run, all for harness reasons:
  - Most specs `import('/src/…')` inside the page, which only resolves against a Vite dev server; the built app loads `file://`. This has been so since Audit-15 Phase 0, and the weekly Full E2E job has failed on it.
  - The axe scan throws `Target.createTarget: Not supported` in Electron.
  - `app.test.ts` checks old Home-screen text.
  - The default parallel workers make the Electron instances fight over `DevToolsActivePort`.
  - Two specs had gone stale since earlier UI and sentinel changes, and were fixed here (test-only changes). `documentOpenNoWrite` now double-clicks the row's name, because the row's centre now lands on a tag chip, which filters instead of opening. `recoveryRelaunch` writes this machine's `.dirty.<machineId>` sentinel and carries the machine id into the relaunch; per-machine sentinels replaced the shared `.filo/.dirty`. Both files pass.
  - Rewriting the rest to drive the built app is a separate task, suggested at the end of this session.
- **Findings from the real-app check, not fixed here** (Phase 7 changes no app code):
  - **A24-51 (LOW, messaging).** Only note prompts are held decisions. A board drift prompt and a raw-view conflict banner are not. So when one of them is all that's left at quit, the dialog is still "Save failed" with **Retry now**, and it gives the cause "another program … may be holding it". For a board it also says "keeps a copy of each unsaved note". A24-38's quit dialog works as built for held note decisions (the notes-box scenario above).
  - **A24-52 (LOW, UX).** Quitting with a held board drift took about 16 s to show its dialog, and "Board not saved (9×)" toasts pushed the Reload / Keep local toast out of view. The save loop keeps retrying a board whose write is held for a drift decision.
  - **A24-53 (LOW, accepted).** Another program's board write within main's time-only suppression window (about 7 s after a Filo save on Windows) raises no notice. It is still never overwritten: the next save's drift check asks. Recorded in KNOWN_LIMITATIONS #5.
  - A24-51 and A24-52 are a separate suggested task. Neither loses data.
- **Not covered.** A crash in the middle of a vault-wide tag sweep was not exercised in the real app. The recovery sentinel for it (`tag-rewrite-pending.<machineId>.json`) has unit coverage.

## Decisions

- `DECISION:` A24-15 has no raw-view autosave (see above).
- `DECISION:` A24-27 treats `viewports.json` as last writer wins with a per-board merge, and prompts only for `hotkeys.json`.
- `DECISION:` A24-06 disables the rename and delete actions while the index builds, rather than queueing them.

## Status

| Phase | Status | Commit |
|---|---|---|
| 1 | Done (2026-09-28) | see `git log --grep "Audit-24 Phase 1"` |
| 2 | Done (2026-09-28) | see `git log --grep "Audit-24 Phase 2"` |
| 3 | Done (2026-09-28) | see `git log --grep "Audit-24 Phase 3"` |
| 4 | Done (2026-09-28) | see `git log --grep "Audit-24 Phase 4"` |
| 5 | Done (2026-09-28) | see `git log --grep "Audit-24 Phase 5"` |
| 6 | Done (2026-09-29) | see `git log --grep "Audit-24 Phase 6"` |
| 7 | Done (2026-09-29); A24-51 and A24-52 open as a follow-up | see `git log --grep "Audit-24 Phase 7"` |

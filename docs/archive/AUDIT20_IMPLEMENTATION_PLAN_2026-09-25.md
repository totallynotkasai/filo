# Audit 20 — implementation plan (2026-09-25)

**Source:** [AUDIT20_PRE_DOGFOOD_2026-09-25.md](AUDIT20_PRE_DOGFOOD_2026-09-25.md).
**Base:** `main` at `dde5075`. Work on a branch (`audit20/fixes`), one commit per step or small group of steps.
**Status:** All 7 phases done (branch `audit20/fixes`). Committed and merged to `main`: Phase 1 `097185b`, the test renames `9c68ee4`, Phases 2–6 `2aa2875`, then Phase 7 docs. Archived to `docs/archive/`.

## Ground rules

1. **Spec first.** Every behaviour fix starts with a characterisation spec (`src/tests/characterisation/`) that fails on `main` for the reason in the report. Only then change the code. The audit's repro steps are written out per phase below.
2. **Harness, not internals.** Specs call only the `harness/` adapter. If an action is missing (such as an external rename on disk), add it to `harness/actions.ts`.
3. **Gates.** A new invariant gets a check in the matching group in `scripts/gates/`. Prove it bites before relying on it: introduce the violation, watch the check fail, then revert.
4. **Every phase ends green:** `npm run ci:verify`. After each phase, use the scratch vault in the real app for a few minutes.
5. **Order:** Phase 1 → 2 → 3 → 4 are the data-safety fixes; do them in this order. Phases 5–7 can come in any order after them.

---

## Phase 1 — Undo follows renames; a missing file can't lock the vault (H1, M2)

**Spec first** (`renamesAndDiskChanges.test.ts` or a new `undoAcrossRenames.test.ts`):
- Kanban: place `Card.md`, set a due date, rename it in the sidebar to `Renamed`, then Ctrl+Z on the board. Expect `Renamed.md` to have no `dueDate`, no `Card.md` to exist, and no error toast.
- The same for a Task List tick, a tile title edit (`UpdateTitleCommand`) and a Properties edit.
- A folder rename that contains the note, followed by undo.
- A rename in another app (added to the harness in Phase 2), followed by undo.
- After an undo whose note has been deleted, renaming an unrelated note still works.

**Steps**

1.1 **Commands can be re-pointed.**
- Add an optional `renamePath?(oldRel: string, newRel: string): void` to the `Command` interface (`commands/Command.ts`).
- Add a shared helper, `rebasePath(path, oldRel, newRel): string | null`. It handles an exact match and a folder prefix, compares on `vaultPath()` keys, and keeps the new spelling. Reuse the prefix logic from `lib/vault/renamePathKeys.ts`, or share a helper with it.

1.2 **Implement `renamePath`** in every command that names a note or file by path:
- `NoteFieldCommand`: make `relPath` mutable. This covers `UpdateCardFieldCommand` and the task field commands.
- `UpdateTitleCommand`, `UpdatePropertiesCommand`, `AddPathTagCommand` / `RemovePathTagCommand`.
- `ReplaceAllCommand`: its per-file splices are keyed by path.
- The task commands with `filePath` (`taskCommands.ts:205`) and the tile commands with `filePaths` (`tileCommands.ts:165`).
- Composites (`BatchCommand`, `CascadeDeleteCommand`) forward `renamePath` to their children.
- A `trashedFiles` entry is keyed by `trashId`, and restore already handles an original path that's taken again. Leave it as it is and record that as a `// DECISION:`.

1.3 **History sweep.** In `stores/history.svelte.ts`, call `registerPathRenamable('history', …)`, walking every stack's `undoStack` and `redoStack`, including Document-tab stacks. The in-app rename (`vaultFolderOps.runRename`) and the external cascade both call `renameAllPathKeys`, so both are covered.

1.4 **Undo on a note that's gone doesn't queue a write.**
- In `applyDeltaChecked` (`commands/frontmatterInverse.ts`), change the default from `whenUnreadable: 'apply'` to `'throw'` when the file is **missing**. Keep `'apply'` only for an unreadable but present file, which is rare. Keeping it there means a lock that clears later still lets the write land.
- Check how `history.svelte.ts` handles a throwing `undo()`. The command should stay where it was, with a toast saying *"Couldn't undo: 'Card.md' no longer exists."* It must not be half-popped.

1.5 **A failed write only blocks operations on the path it touches (M2).**
- `withDrainedWrites(op, { paths })` gets an optional list of affected paths. The drain still flushes everything. A failure then blocks the operation only if the failed path equals an affected path or sits under or over one.
- Other failures produce the existing error toast but the operation goes ahead.
- Vault close, vault open, quit and Save keep the global rule: any failure blocks.
- Callers pass their paths: `renameVaultPath` passes old and new, `trashVaultPath`/`restoreTrashed` pass the path, `createVaultFolder`/`copyFileIntoVault` pass the target, and the external rename passes old and new.
- `// DECISION:` a pending write can only disturb a disk-shape operation on the same path or a parent/child path, so an unrelated failure is no reason to refuse.

1.6 **The error toast for a gone file can resolve itself.** A note write that fails with ENOENT (`noteWriter.writePending`) raises a sticky toast with two actions:
- **"Save as new file"** runs `noteStore.recreate`, which creates the file exclusively and never overwrites.
- **"Discard change"** runs `writer.drop`, which clears the failed mark.

That way no failed write stays for the rest of the session unless the user wants it to.

1.7 **Gate `commands-follow-renames`** (`commands` group). Any class in `src/renderer/commands/` with a field named `relPath`, `filePath`, `filePaths`, `path` or `paths` must define `renamePath`. Prove it bites, for example by deleting it from `NoteFieldCommand`.

**Exit:**
- The new specs pass.
- `vaultOperationsDrain.test.ts` has cases for a scoped drain: an unrelated failure proceeds, an affected failure blocks, and close stays global.
- The repro from the report no longer blocks the second rename.

### Phase 1 — done (2026-09-25): what was built, and deviations

**Specs.** `src/tests/characterisation/undoAcrossRenames.test.ts` (6 cases, registered in the `characterisation-suite` gate). On `main` the first case timed out exactly as in H1, and the "note is gone" case failed on the blocked unrelated rename (M2). All six pass now. Unit tests: `commandRenamePath.test.ts` (new) and seven scoped-drain / prompt cases in `vaultOperationsDrain.test.ts`.

**Deviations from the plan:**

1. **One default `renamePath` instead of one per command (1.1, 1.2).** `Command.renamePath` (on the class, not the interface) calls `rebaseCommandFields` (`commands/commandPaths.ts`). It walks the command's own fields and rewrites every string held under a name in `PATH_FIELDS`, including inside snapshots (deleted tiles' `filePath`/`src`, Kanban covers, frame `backgroundImage`, a Replace All plan's `path`), array fields (`filePaths`) and child commands (batches, `DeleteTilesCommand`'s card commands, `UpdateTitleCommand`'s field command). So it covers more than the commands listed in 1.2, for example undoing a tile delete after its image was renamed.
   - It never walks the user's own data (`CONTENT_FIELDS`: `fm`, `metadata`, `forward`/`inverse` deltas, `splices`, `fileTags`), so a frontmatter key that happens to be called `path` is never rewritten.
   - Maps and Sets are skipped. In commands they are keyed by tile ids.
   - Only `RenameFileCommand` overrides it. Its own rename, in either direction, must not collapse its two ends into one.
2. **Trashed items (1.2 `// DECISION:`).** The plan said to leave `TrashedItem` alone. The same reasoning also applies to a command's *snapshot* paths under a trashed item: undo restores the item to its original path and then retargets the snapshots from that path. Those paths are therefore pinned (`trashedPaths` in `commandPaths.ts`), and a parent passes its pins to its child commands.
3. **`rebasePath` (1.1)** lives in `lib/vault/renamePathKeys.ts`. `fileRefIntegrity.rewritePath` now delegates to it. `trashedFiles.retargetPath` is unchanged.
4. **Missing vs unreadable (1.4).** When `currentFrontmatter` returns null, `applyDeltaChecked` asks `vault:file-exists`. If the file is gone, it throws `NoteGoneError` (new, `commands/noteGoneError.ts`), whatever `whenUnreadable` says. The history store rolls the command back to where it was and shows *Couldn't undo: "Card.md" no longer exists.* (or *redo*). The promise then resolves instead of rejecting, because the failure has been handled.
   - The probe counts as "gone" only when it answers `false`. An unanswered probe counts as present, so the change is kept.
   - `audit17Phase1.test.ts` pinned the old behaviour ("file gone applies the inverse"), which was the cause of H1. It now asserts `NoteGoneError` with nothing queued.
   - **Addition:** the toast has a **Skip this step** action that drops the command from its stack. Otherwise one unrecoverable step on top of the stack would block every earlier undo for the rest of the session. Keeping it by default still lets it work again if the file comes back from Filo's trash.
5. **Scoped drain (1.5).**
   - The scope applies to note, board, misc and config failures alike. Paths are compared case-folded, and absolute paths under the vault are made relative first.
   - A parked sibling judges the outer drain's shared result against its *own* scope, so it never re-drains. The refusal toast has a `dedupeKey`, so siblings show one toast.
   - **Also scoped** (not listed in the plan): the sidebar delete (`vaultDeleteOps`: the item) and the tile/task deletes (`AppShell`, `TileHeader`, `taskDeletion`). These pass the notes they trash, which is an empty scope when only tiles go.
   - `tagRewriteSweep` stays global.
   - `copyFileIntoVault` scopes to the target file (destination folder + source name).
6. **Gone-file toast (1.6).**
   - "Save as new file" is offered only when the queued change includes a body (it needs the model's body). A delta-only change offers only **Discard change**.
   - The toast shares its dedupe key with the "deleted by another program" prompt, so a note never shows both.
   - The writer no longer reports `note.missing` through the error bus. It calls a new host hook, `onTargetMissing`. `note.unreadable` is unchanged.
   - Discard is the new `noteStore.discardQueued` (`writer.drop` plus the model and overlay).
7. **Gate (1.7).** `commands-follow-renames` checks three things:
   - `Command.renamePath` defaults to `rebaseCommandFields(this, …)`;
   - the history store registers the `'history'` sweep and calls `renamePath`;
   - every path-like property name declared in `src/renderer/commands/` (class fields and snapshot types) is in `PATH_FIELDS`, is exempt with a reason (`rel`, `restoredPath`), or belongs to a class that overrides `renamePath`.

   With a default on the base class, "each class defines `renamePath`" would always pass, so the check is on field names instead. It was proved to bite in three ways, each reverted afterwards: `itemRel` removed from `PATH_FIELDS`, the base default made a no-op, and a new `oldSrc` field added. `beforeCover`/`afterCover` (`UpdateCoverImageCommand`) were added to `PATH_FIELDS` as a result.
8. **Specs.**
   - The Properties case goes through the Document tab's tag row, which issues the same `UpdatePropertiesCommand` and also covers a Document-tab stack. It does not use the tile Properties popup, which jsdom can't drive well.
   - The **external rename + undo** case is moved to Phase 2 (see findings below). `renameExternally` and `deleteExternally` were added to the harness now. The "note is gone" spec uses `deleteExternally`.
   - Two specs pause 3 s after creating a board before editing it. Otherwise H3's false drift prompt parks the drain, which is the Phase 3 bug and not what these specs test.

**Findings for Phase 2**, found while writing the external-rename spec; neither is fixed:
- **The watcher ignores a note for about 7 s after each Filo write to it (Windows).** Every note write calls `suppress(rel, LOCK_AWARE_SUPPRESS_MS)`, which is `WIN_LOCK_BUDGET_MS` 5000 + 2000. An external delete or rename in that window is dropped as our own echo and is only seen at the 30 s reconcile. In the spec, a delete 1.5 s after an edit was not seen within 20 s. This is exactly the H2 window (a rename within 300 ms of typing). Step 2.1 should check whether the rename event arrives at all before it looks at event order.
- **A rename shortly after a Filo edit is probably not paired.** Cross-basename pairing needs the old path's SHA-1, which the reconcile walk seeds. After Filo rewrites the file, the seed is stale, so the hashes don't match and the move arrives as a delete plus a create. Observed: a ~500-byte note renamed 8 s after a due-date edit was not paired within 20 s. The cause is not confirmed. Check it in 2.4, for example by refreshing `lastKnownHashes` on our own writes.

---

## Phase 2 — Follow renames made by other programs (H2)

**Harness first.** Add `renameExternally(app, from, to)` to `harness/app.ts`: a plain `fs.renameSync`, seen through the real watcher.

**Spec first:**
- Open `Draft.md` in a Document tab, type, and within 200 ms rename it on disk to `Moved.md`. Expect:
  - `Moved.md` contains the typed text and `Draft.md` doesn't exist;
  - there's no "deleted by another program" prompt and no error toast;
  - the tab now shows `Moved.md`, and further typing lands there.
- The same with the note also placed on a Kanban board: the card still shows the note, and the board file references `Moved.md`.
- A case-only rename on disk (`Draft.md` → `draft.md`, Windows): no prompt, and the text is kept.
- A note deleted on disk while dirty still shows the delete prompt (regression guard).

**Steps**

2.1 **Instrument, then confirm the event order.** Log which arrives first in the repro: the `vault:file-renamed` pair or a `vault:files-changed` for the old path. The fix depends on both orders being handled.

2.2 **Re-key before draining.** In `handleExternalRename` (`stores/vaultExternalChanges.ts`), call `renameAllPathKeys(oldRel, newRel)` **before** `withDrainedWrites`, because the file has already moved. Remove the later call in `runExternalRenameCascade`, or make sure a second call does nothing.
- With the writer's queue now at `newRel`, the drain writes the pending body to the moved file. The existing conflict check still applies, because the base moves with the model.
- Pass `{ paths: [oldRel, newRel] }` to the drain (from Phase 1.5).

2.3 **A missing file waits briefly before prompting.** In `noteStore.onDiskChanged`, when the action is `missing` and the note has an unsaved body, wait for the rename-correlation grace (the same window `ATTACHMENT_DELETE_GRACE_MS` uses; name it for this purpose) before `prompts.deletedWithUnsavedBody`.
- If a rename re-keyed the model in the meantime (`models.get(key) !== m`), or the file is back, don't prompt.
- `renameNotePaths` calls `prompts.dismiss(oldRel)`.

2.4 **Watcher correlation window.** Check that `renameCorrelation.ts` pairs a rename whose delete and create are further apart than the note writer's debounce (300 ms) on Windows with OneDrive running. If it's shorter, widen it for `.md`, and record the value in KNOWN_LIMITATIONS if it has limits.

**Exit:** the new specs pass. KNOWN_LIMITATIONS #19 (renames that look like sync-conflict names) is re-checked and stays accurate.

### Phase 2 — done (2026-09-25): what was built, and deviations

**Specs.** `src/tests/characterisation/externalRenames.test.ts` (6 cases, registered in the `characterisation-suite` gate):
- the four cases above (Document tab, the same note on a Kanban board, a case-only rename, a delete while dirty);
- a rename made shortly after Filo wrote the note (the first Phase 1 finding);
- the external rename + board undo case moved here from Phase 1. It no longer needs the 8 s pause that Phase 1's specs used.

Before the fix, the Document-tab case timed out: the text never reached `Moved.md`. The "shortly after a Filo write" case also timed out: the tab never followed. All six pass now.

Unit tests:
- `renameCorrelationSmallNote.test.ts` and `withOnDiskSpelling.test.ts` (new);
- `fileWatcherReconcile.test.ts`: the hold, a write suppression that still lets a delete through, a rename straight after an own write, and a case-only rename found by the reconcile pass;
- `noteStore.test.ts`: the grace, and a rename arriving within it, for both a missing event and a failed write.

**What 2.1 found.** Both Phase 1 findings were confirmed, and neither is about event order. The renderer never got a rename at all:
- **Rename within ~200 ms of typing.** Delete and create arrive in one watcher batch. They were not paired, for two reasons:
  - a note under 256 bytes never pairs across basenames;
  - the watcher had no cached size for the old path (the reconcile walk cached hashes only).

  The note's write (at ~450 ms) failed with ENOENT before that batch reached the renderer. Order: the failed write, then `vault:files-changed` for both paths.
- **Rename seconds after a Filo write.** The old path's delete was dropped as our own echo by the ~7 s write suppression. Only the create for the new path was sent.

**Deviations from the plan:**
1. **The main fix is in the watcher (not listed in the plan's steps):**
   - **`FileWatcher.suppressWrite`.** Note writes (`vault:write-file-text`, `vault:create-file-text`, `vault:write-existing-file-text`, `vault:convert-to-utf8`) now use it. It drops an event only while the file exists. An atomic write never leaves its destination missing, so a missing file in the window was deleted or moved by someone else.
   - Renames, deletes and trash keep the plain `suppress`.
   - Board, media, tags and template writes keep the plain `suppress` too. Phase 2 is about notes, so a board file renamed in Explorer right after a save still waits out the window.
   - The suppression windows moved out of `fileWatcher.ts` into `watcherSuppression.ts` (`SuppressionWindows`). The file had passed the 1000-line gate. `FileWatcher.suppress` / `suppressWrite` / `suppressTree` delegate to it, and no callers changed.
   - **`recordOwnWrite`** (through `noteOwnWrite` in `vault.ipc.ts`) refreshes the watcher's cached size and SHA-1 with the bytes Filo wrote. This confirms the second Phase 1 hypothesis. The reconcile walk now also caches sizes for notes.
   - **Small notes pair on a hash match.** Below 256 bytes, a whole-content SHA-1 match now pairs across basenames. Empty files never pair. `// DECISION:` in `renameCorrelation.ts`: two different notes with identical bytes, one deleted and one created at the same moment, can't be told apart from a move.
2. **2.4, correlation window.** Before this phase, a delete and a create paired only when they landed in the same debounce batch (300 ms, at most 1 s). A missing `.md` with no partner is now held for `MISSING_NOTE_HOLD_MS` = 1.5 s. It joins the next batch so a late create can pair with it, and only after that is it sent as a delete. As a result, a real external delete of a note is reported ~1.5 s later.
   - **Not done:** measuring the gap with OneDrive running. There is no OneDrive vault in this environment. The value and this gap are recorded in the new KNOWN_LIMITATIONS **#31**. Suggest adding it to the manual probe in 6.5 (M6).
3. **2.2** is done as planned: `renameAllPathKeys` runs before the drain, and the cascade no longer calls it. Two follow-on fixes the spec exposed:
   - `noteWriter.renamePath` clears the old path's failed mark when it moves a queue. Otherwise the drain, scoped to old + new, refused on the ENOENT failure that the rename explains.
   - `VaultIndex.renameKey` keeps the entry when the new path is already indexed. The drained write indexes `Moved.md` first, and MiniSearch threw "duplicate ID".
4. **2.3** covers both prompts:
   - the "deleted by another program" prompt;
   - Phase 1's "couldn't save … no longer exists" prompt (a failed write on the old path).

   Details:
   - The wait is `NOTE_RENAME_GRACE_MS` = 3 s (in `externalChangeWindows.ts`), not the 500 ms `ATTACHMENT_DELETE_GRACE_MS`, which is shorter than the watcher's hold plus its debounce.
   - After the wait (`askUnlessMoved` in `notes.svelte.ts`), nothing is asked if the note was re-keyed, saved or discarded. If the file came back, the disk change is decided again, or the failed write is re-armed.
   - `renameNotePaths` dismisses the old name's prompts, except a conflict prompt, which still needs its answer. It also re-reads a moved model the watcher had already marked missing.
   - Pending checks are dropped on a vault swap. Unit tests run them at once with `noteStore.__settleGraceChecksForTests()`.
5. **Two case-only rename bugs** turned up (not in the plan):
   - **Filo's own write undid another program's case-only rename.** The atomic rename names the file after the spelling it's given. The overwrite handlers now write through `withOnDiskSpelling` (`filenameUtils.ts`, which uses `fs.realpath`).
   - **The reconcile pass paired a case-only rename backwards.** It listed new paths before vanished ones, and the correlator takes the earlier event as the old name. Vanished paths now go first.
   - **Left as a limitation (#31):** a case-only rename within ~7 s of a Filo write is still not reported live. The echo window can't tell the two spellings apart. The file keeps its new name, and the reconcile pass reports the rename within 30 s.
6. **Specs.**
   - The notes have no `title:`, so the tab shows the file name.
   - The delete case answers its prompt with **Discard** at the end. An unanswered prompt keeps the queued change failed, and the next test's vault open is then refused. That is the close/open behaviour Phase 4 (M1) changes.
   - Two harness readers were added: `activeTabName` and `boardFilesText`. `renameExternally` has been in the harness since Phase 1.
7. **Gate** `note-write-suppression` (`writePath`): see "Gates added". It was proved to bite by putting a plain `suppress` back in `vault:write-existing-file-text`, then reverted. The gate count in CLAUDE.md ("55") is left for Phase 7.
8. **KNOWN_LIMITATIONS:**
   - #19 was re-checked and stays accurate: the conflict-copy refusal still runs after the new hash gate.
   - #7 now says small notes pair on a hash match and small attachments still don't.
   - #31 is new: the hold, the grace, the OneDrive gap and the case-only window.

---

## Phase 3 — No false "board modified externally" after creating a board (H3)

**Spec first:**
- For each board type: create the board, then immediately add a column or place a note three times in a row, with no pauses. Expect no drift prompt, and the board file on disk to hold all three edits.
- Regression guard: an edit to the board file from another program while the board has unsaved changes still prompts.

**Steps**

3.1 **Confirm the cause.** In the spec run, temporarily log every `noteBaseline` and `refreshBaselineAfterWrite` call for the path, with its mtime. The expected finding is that the loader's stat-read-stat stamp (`boardLoader.ts:450`) lands after a self-write's post-write stamp and rolls the baseline back. If the log shows something else, fix that instead and update the report.

3.2 **Baselines only move forward.**
- `fileBaselineRegistry` keeps a per-path stamp sequence, bumped by every `refreshBaselineAfterWrite`.
- A reader takes `const seq = baselineSeq(path)` before its read, then calls `noteBaseline(path, mtime, size, { ifUnchangedSince: seq })`. The stamp is skipped if a write refreshed the baseline in between.
- Apply this to `boardLoader`, `vaultCandidate.ts:509` and the config scheduler's stamps.

3.3 **Seed the baseline at create.**
- Have `board:create` return the new file's `mtimeMs` and `size` (main process: stat after `createBoardFile`).
- `persistNewBoard` stamps the baseline straight away, so the first write has an anchor and no later load is needed to provide one.

3.4 **Gate (`writePath`):** `noteBaseline(` is called only with the `ifUnchangedSince` option, except in the registry itself.

**Exit:** the specs pass, and the existing drift-prompt specs are unchanged.

### Phase 3 — done (2026-09-25): what was built, and deviations

**Specs.** `src/tests/characterisation/newBoards.test.ts` (4 cases, registered in the `characterisation-suite` gate):
- Kanban: create the board, then add three columns straight away. No prompt, and all three columns are in the board file.
- Mind map and Task List: create the board, then drop three notes on it straight away. No prompt, and all three notes are in the board file.
- Regression guard: another program rewrites the board file, and the user adds a column before Filo has seen the change. Filo still asks. Answering **Keep** leaves both columns on disk.

Before the fix, the Kanban and Task List cases failed on the prompt. The Mind map case passed. The regression guard passed before and after.

Unit tests:
- `fileBaselineDrift.test.ts`: six cases for the forward-only stamp. These cover a load that began before a save, a load with no save in between, a save whose stat failed, a ticket across a rename (both ways), and a save to another path.
- `boardCreateBaseline.test.ts` (new): `board:create` hides the new file from the watcher and returns its stat. `persistNewBoard` seeds the baseline from that stat and marks the path as a recent self-write. With no stat, it leaves the baseline unset.

**What 3.1 found: the cause is not the one the report guessed.** Logging every `noteBaseline` / `refreshBaselineAfterWrite` call and every board watcher event in the spec run showed the following:
- The loader never ran for the new board. There was no stamp to roll back: the first stamp was the first save's own refresh.
- The prompt was the **watcher reconciler's** prompt (*"… was modified externally while you had unsaved changes"*), not the writer's drift prompt. The report quotes that text.
- The trigger was the **create's own watcher echo**. `board:create` didn't suppress the watcher, and `persistNewBoard` didn't mark the path as a recent self-write. About 300 ms after the create, the watcher reported the new file (`eventType: rename`, `selfWrite=false`). The first edit's save was pending at that moment, so `reconcileBoardJsonChange` asked.
- With no save pending, the same echo takes the silent `reloadBoardFromDisk` branch instead. That is why the Mind map case (and the audit's runs with 2.5 s pauses) showed nothing. That branch runs `loadBoard`, and there the rollback the report describes can happen: a save landing during that load was stamped, then the load's older stat replaced it. So 3.2 still fixes a real race, though not the one that caused the prompt.

The report's H3 entry now gives the confirmed cause.

**Deviations from the plan:**
1. **The main fix is the create echo (not listed in the plan's steps):**
   - `board:create` calls `watcher.suppress(relativePath, LOCK_AWARE_SUPPRESS_MS)` after the write, like `board:save`. The file name is picked inside `createBoardFile`, so it can't be suppressed before the write. The watcher checks suppression when it flushes its debounced batch, so the after-write call still catches the echo.
   - `persistNewBoard` calls `markRecentSelfWrite(result.path)`. The reconciler then drops the echo while the stat still matches the seeded baseline, and also while a newer save is queued.
   - Each half fixes the spec on its own. Both were checked by disabling the other. They are kept together as defence in depth: the main-side window is time-based (#5), and the renderer-side check compares the stat.
2. **3.2** is done as planned, with one change: the stamp sequence is a **single counter** that never resets, and each path records the counter value of its last self-write. A ticket from before a vault swap or a rename can never match a later entry by accident.
   - A self-write whose post-write stat failed still advances the sequence. The write happened, so a read from before it must not stamp.
   - `renameBaselinePath` moves the sequence together with the baseline.
   - `resetAllBaselines` clears both.
   - `vaultCandidate.ts` takes its ticket just before the config stat, not before the config reads. No write to a vault that hasn't committed can run, so the two are equivalent. A comment there says so.
   - `configWriteScheduler` takes its ticket before its pre-write stat. Its two re-anchors (a benign recreate, and a foreign recreate) pass that ticket.
3. **`noteBaseline`'s fourth parameter** is now `{ ifUnchangedSince }` instead of `text`. The `text` field of `FileBaseline` (a confirmed copy of the bytes) had no reader and no writer left after notes moved to the note writer, so it was removed together with the parameter. `ifUnchangedSince` is optional in the type, so the unit tests that seed baselines directly keep their three-argument calls. The gate requires it in production code.
4. **3.3** is done as planned: `board:create` returns `mtimeMs` and `size` (absent when the stat fails; the contract in `ipcContracts.ts` says so).
5. **Gate** `baseline-stamp-forward-only` (`writePath`) also pins the create-echo fix: `board:create` suppresses `relativePath`, and `persistNewBoard` calls `markRecentSelfWrite(result.path)` and seeds the baseline. It was proved to bite three times, then reverted each time: by dropping `ifUnchangedSince` in `boardLoader`, by dropping the suppress in `board:create`, and by dropping the mark in `persistNewBoard`.
6. **Specs.**
   - The two "wait 3 s after `createBoard`" pauses in `externalRenames.test.ts`, and the one in `undoAcrossRenames.test.ts`, were removed. Those specs now edit the new board straight away. The 8 s pause in `undoAcrossRenames` stays: it is about the note watcher's own-echo window, not about new boards.
   - The regression guard waits 3 s after its first save before the external write, so that write can't fall inside Filo's own-echo window for that save (#5).
7. **Not changed:** the reconciler's prompt wording (*"Reload from disk (discard your edits)"*). A wording pass is listed in Part B.

---

## Phase 4 — Honest close and quit (M1, M3)

**Spec first:**
- Close the vault with nothing pending: no dialog (the harness's `dialog:choice` fake records its calls).
- Close with an edit typed less than 300 ms before: no dialog, and the edit is on disk.
- Close while a write has failed: a dialog appears that names the path.

**Steps**

4.1 **A single "is anything unsaved?" answer.** Add `unsavedWork(): { pending: string[]; failed: string[] }` in `lib/boards/writeStateTracking.ts`. It reads `pendingVaultPaths`, `failedVaultPaths`, the in-flight counts, and `noteStore` models with `hasUnsavedBody`.

4.2 **Close and open-another-vault save first, then ask only if something is left.**
- In `vaultStore.closeVault` and `openVault` (`vault.svelte.ts:1008`, `:1132`), run `save()` quietly first.
- If `unsavedWork()` is then empty, go ahead with no dialog.
- Otherwise ask: *"N changes couldn't be saved: a.md, b.md… Close anyway (they'll be kept in .filo/recovery) / Cancel"*.
- Drop the "Don't Save" option, because a local-first autosaving app has nothing to "not save" on purpose.

4.3 **Keep a rescue copy before losing anything.**
- On "Close anyway" and on the quit dialog's "Quit anyway", write each unsaved note body to `.filo/recovery/<timestamp>/<vault path>`.
- Use the frontmatter the note last had and the local body (the same assembly as `recreatedText` in `notePrompts.ts`), through the existing recovery-snapshot IPC.
- Board caches that failed to save are written there as JSON.
- The message says where the copies are.

4.4 **Quit message by cause.** `handleFlushAndQuit` builds its text from the failure kinds:
- a lock (EPERM/EBUSY/EACCES): the current text;
- a missing file: *"… no longer exists"*;
- a held conflict: *"waiting for your answer on …"*;
- non-UTF-8.

It mentions `.tmp` files only when some exist.

4.5 **Gate (`writePath`):** the close and quit paths never call `fireVaultSwap` while `unsavedWork()` is non-empty, unless a rescue copy has been written. A pattern check on the rescue call is enough.

**Exit:** the specs pass. `handleFlushAndQuit` unit tests cover each message.

### Phase 4 — done (2026-09-25): what was built, and deviations

**Specs.** `src/tests/characterisation/closeVault.test.ts` (5 cases, registered in the `characterisation-suite` gate):
- Close with nothing unsaved: no dialog.
- Close straight after typing (inside the 150 ms + 300 ms debounces): no dialog, and the edit is on disk.
- A change that can't be saved (the note was deleted by another program while it had an unsaved edit): the dialog names `Note.md` and says the file no longer exists. It has no "Don't Save" button. **Cancel** keeps the vault open and writes no copy.
- The same, answered **Close anyway**: the vault closes, and `.filo/recovery/` holds one copy with the note's frontmatter and the unsaved text.
- Open another vault straight after typing: no dialog, and the edit is on disk.

Before the fix, all five failed: the first two on the dialog that always appeared, the third because the dialog named nothing. The last two couldn't start, because the vault the third case left open couldn't be closed ("Save" failed, so the close was refused).

Harness changes:
- The fake `electron` message box records every dialog and takes scripted answers by button label. Unscripted, it still picks the first button, which is now "Close anyway".
- `app.ts` has new `closeVault(app, answer?)`, `openOtherVault(app, files, answer?)` and `recoveryCopies(app)` functions.

Unit tests:
- `quitFailureMessage.test.ts` covers the quit message for each cause (lock, missing file, conflict, non-UTF-8), `.tmp` wording only when some exist, the path list cap, and the close/open dialog text. It also checks that "Quit anyway" keeps rescue copies before `app:ready-to-quit`, that a copy that couldn't be written asks again ("Stay open" cancels the quit), and that a rescue that throws counts as not kept.
- `unsavedWork.test.ts`: the pending, failed, held-in-memory and path-less in-flight cases.
- `recoveryKeepUnsaved.test.ts` (main): the copies' folder and names, two paths that flatten to the same name, the vault-open listing, and a check that the snapshot prune leaves rescue copies alone.

**What was built:**
- **4.1** `unsavedWork()` in `writeStateTracking.ts` returns `{ pending, failed, inflight }`. `isUnsavedWorkEmpty()` is the "nothing to lose" test.
- **4.2** A new module, `stores/vaultLeaveGuard.ts`, has `saveBeforeLeaving(save, 'close' | 'open')`. It saves, returns `saved` if `unsavedWork()` is empty, and otherwise asks *"N changes couldn't be saved."*. The detail lists each file with its reason and says where the copies go. The buttons are **Close anyway** (or **Open anyway**) and **Cancel**, and Cancel is the default. `closeVault` and `openVault` call it and pass `saveOutgoing: leave === 'saved'`. A clean save clears `.filo/.dirty`. Leaving anyway keeps it, so reopening that vault offers recovery. "Don't Save" is gone.
- **4.3** `stores/unsavedRescue.ts` `keepRescueCopies()`:
  - Each unsaved note is copied with its last frontmatter and the queued change, over the local body. `noteStore.unsavedTexts()` builds these copies.
  - Each unsaved board's in-memory file is copied as JSON.
  - The copies go to `.filo/recovery/<timestamp>-unsaved/`. A toast after the close names the folder.
- **4.4** The quit dialog's text is built by `quitFailureBody(items, preservedTmp)` in the new `lib/vault/unsavedMessages.ts`. That module holds all the wording for close, open and quit. "Quit anyway" keeps rescue copies first.
- **4.5** Gate `close-keeps-rescue-copy` (`writePath`) checks five things:
  - `openVault` and `closeVault` call `saveBeforeLeaving()` before `fireVaultSwap()`, and clear the sentinel only for `'saved'`.
  - `vault.svelte.ts` has no "Don't Save".
  - `saveBeforeLeaving` returns `'saved'` only when `isUnsavedWorkEmpty(...)`, and returns `'rescued'` only after `keepRescueCopies()`.
  - The quit handler's "Quit anyway" branch runs `keepRescueCopiesOrAsk()` before `app:ready-to-quit`.
  - `App.svelte` passes `keepRescueCopies` to the quit handler.

  It was proved to bite four times, then reverted each time: by dropping the rescue in the guard, by setting `saveOutgoing: true`, by skipping the rescue on quit, and by returning `'saved'` on `save()`'s result without the empty check.

**Deviations from the plan:**
1. **Note bodies reach `unsavedWork()` through a registered source.** `writeStateTracking` can't import `noteStore` without an import cycle, so the note store registers `registerUnsavedSource()`. The source reports every model with an unsaved or queued body, every queued note change, and the bodies still waiting for their note to load. The result also carries `inflight`, so a write in flight with no path (an exclusive create) still counts. Paths are case-folded `VaultPath` keys. `unsavedRescue.ts` turns them back into on-disk spellings for the dialog, using the note's or board's own path.
2. **The dialog logic lives in `vaultLeaveGuard.ts`, not inline in `vault.svelte.ts`.** That file is over the size limit and may only shrink. It went from 1668 to 1613 lines, and its allowlist ceiling was lowered to match.
3. **A new IPC channel, not the existing recovery-snapshot one.** `recovery:snapshot` copies a file's bytes from disk, but unsaved text exists only in memory, and for a deleted note there are no bytes on disk at all. The new `recovery:keep-unsaved` (`src/main/ipc/recovery.ipc.ts`, `keepUnsavedCopies` in `recoverySnapshot.ts`) writes the text the renderer sends. It checks each name with `assertSafeRelativePath` and `assertNotInFiloDir`, and writes nothing at the note's own path. The channel is added to the channel union, schema, contract, envelope gate list and envelope test inventory.
4. **Where the copies go:** `.filo/recovery/<timestamp>-unsaved/<flattened path>`, not `<timestamp>/<vault path>`.
   - The name is flattened (`Notes__A.md`) like every other snapshot, so the vault-open recovery listing (one level deep) shows the copies.
   - The `-unsaved` suffix makes both snapshot prunes (20 per name, 100 in total) skip these folders. The copies hold text that exists nowhere else, so nothing deletes them automatically. Phase 7's KNOWN_LIMITATIONS entry should say this.
5. **A second confirm, not in the plan.** When a copy can't be written, Filo asks once more on both close and quit: *"Filo couldn't keep a copy of N changes … If you continue, they are lost"*, with "Close anyway and lose them" or "Quit anyway and lose them". A copy can't be written when it is over 25 MB, on a disk error, or for a failed `.filo/` config write, which the recovery channel refuses on purpose.
6. **The rescue text is built by one shared function.** `localNoteText()` in `lib/notes/noteFile.ts` builds it, and `notePrompts.recreatedText` now calls it too, with no change in behaviour. For the rescue it also applies the queued frontmatter change. A queued change to a note that no model holds is applied over a fresh read of the file. If the file can't be read, the copy holds only the changed keys.
7. **Causes are worked out when the dialog opens, not recorded at each failure.**
   - conflict: the model's status is `conflict`;
   - not UTF-8: `isNonUtf8`;
   - missing: a `vault:file-exists` probe;
   - pending: still queued or in flight after the save;
   - anything else is "the file couldn't be written (another program, such as OneDrive or antivirus, may be holding it)". This covers every other write error, not only EPERM, EBUSY and EACCES.
8. **The `.tmp` count** comes from a second new channel, `recovery:preserved-tmp`. It reads the main process's emergency-file registry through a new `preservedEmergencyFilesIn(vaultRoot)`, which is also used by the quit-failure breadcrumb.
9. **A failed save no longer refuses the close with a toast** (*"Save failed — close cancelled…"*). The dialog now lists what failed and lets the user choose.
10. **Two more spec cases than the plan listed:** Cancel keeps the vault open, and open-another-vault right after typing.
11. **Two vault swaps started back to back no longer overlap.** The second `openVault` now saves first, and `save()` waits out the first swap's window, so the second swap's window opens only after the first has settled.
    - `audit16Phase3`'s 3.5 case used to park both swaps at once. It now checks that the second swap waits, and still checks that `save()` defers to the second swap's window.
    - `vaultSwapResets` now pins `saveOutgoing: leave === 'saved'`.
    - Test mocks that answered `dialog:choice` with "Don't Save" now answer "Cancel". No leave dialog appears in them, because nothing is unsaved.

**Checks:** `npm run ci:verify` is green: 546 test files, 5418 tests, and 59/59 gates. The manual scratch-vault run in the real app was **not** done in this session (ground rule 4). Do it before committing: close the vault with and without a pending edit, delete an open, edited note in Explorer and then close, and quit while a note is locked.

---

## Phase 5 — Editor formatting (M4, M5)

5.1 **Alignment and indent.** Recommended: **remove** the align and indent buttons (`toolbarConfig.ts`, `TextFormattingToolbar.svelte`) and the `TextAlign` extension.
- `// DECISION:` Markdown has no portable way to store them. HTML blocks (`<p align>`) stop the Markdown inside from being parsed, so any bold or links in an aligned paragraph would turn into HTML too. That fights the open-format principle.
- The alternative, if you want to keep them: serialise aligned blocks as HTML with inline HTML marks, add a round-trip test, and accept that such paragraphs are HTML in the file. **Your call; ask before starting.**
- Test: `markdownHtmlMode.test.ts` asserts that no toolbar feature produces formatting the file can't hold. Loop over every toolbar command, apply it, serialise, reload and compare.

5.2 **Restyling of other apps' Markdown.**
- Add the list of normalisations (`_x_`→`*x*`, `__b__`→`**b**`, `* * *`→`---`, Setext→ATX, `1)`→`1.`, `+` bullets, hard-break style) to KNOWN_LIMITATIONS #17.
- Optional and later: a Settings note, or a one-time toast the first time a note's style is normalised. No code is required for safety.

**Exit:** green, and KNOWN_LIMITATIONS updated.

### Phase 5 — done (2026-09-25): what was built, and deviations

**Decision (the user, 2026-09-25): keep the alignment and indent buttons**, and save aligned or indented blocks as HTML in the file. The `// DECISION:` comment is in `lib/editor/blockLayout.ts`.

**Specs.** `src/tests/characterisation/blockLayout.test.ts` (2 cases, registered in the `characterisation-suite` gate):
- Centre a paragraph from the toolbar's Text Align menu. The file then holds `<p style="text-align: center;">First <strong>bold</strong> line</p>`, and the rest of the note stays Markdown. After reopening the vault, the paragraph is still centred and the note is not read-only.
- The same with Increase Indent: the paragraph is saved as `margin-left: 24px`.

Both failed before the fix (with the serializer disabled) and pass after it.

Harness: new `alignFirstBlock(app, ed, align)` and `indentFirstBlock(app, ed)` actions drive the real toolbar controls.

**What was built:**
- `lib/editor/blockLayout.ts` has `hasBlockLayout(node)`, which is true for a paragraph or heading whose alignment isn't left or whose indent is above 0. It also has `blockLayoutHtml(node)`, which writes that block as one HTML line through TipTap's own `getHTMLFromFragment`, so the styles are the ones the editor renders.
  - Body `#tag` marks are dropped from that HTML, so a tag is saved as bare `#tag` text, as everywhere else.
  - A link loses its editor-only `target`, `rel` and `class` attributes.
- `ParagraphWithBlankLines` and a new `HeadingWithLayout` (which replaces StarterKit's heading) write such a block as that HTML line. Every other block keeps its Markdown writer.
- On load, markdown-it passes the line through as an HTML block, and the existing TextAlign and Indent `parseHTML` read the styles back.
- 5.1's test is the new `toolbarFormattingRoundTrip.test.ts`, with 43 cases. It covers every command the formatting toolbar runs, plus combinations: a centred paragraph with bold, italic, a link and a tag; a block both centred and indented; text with `<`, `&` and `>`; a centred list item; and a centred or indented heading. Each case saves the note, reloads it into a fresh editor, and requires the same document, a reload not flagged lossy, and the same bytes on a second save.
- `markdownHtmlMode.test.ts`: the "indent is not saved" case now asserts that indent and a centred heading are saved.
- The golden corpus has a new fixture, `aligned-blocks.md`, covering an aligned heading, a right-aligned paragraph with a link, an indented paragraph, a block both centred and indented, a centred list item, and a justified quote. It round-trips byte-for-byte (LF and CRLF). It is added to the gate's required-fixture list.
- 5.2: KNOWN_LIMITATIONS #17 now lists the Markdown restylings in a table, says that aligned and indented paragraphs are HTML in the file, and says that another app's `<p align="center">` still opens read-only.

**Deviations from the plan:**
1. **Keep, not remove.** This is the user's decision, so the "Removing the alignment buttons" risk no longer applies.
2. **A list rule had to change.** tiptap-markdown reads a list as loose whenever an item contains a `<p>`. A tight list with one centred item therefore reloaded loose, gained blank lines on the next save, and would have opened read-only.
   - `isTightListElement` (in `taskListTight.ts`) now treats only an unstyled `<p>` as loose.
   - A new `FiloListTight` applies the rule to bullet and numbered lists, and is registered after the Markdown extension so its rule wins. The task-list rule uses it too.
   - One edge is left: a loose list in which every item is aligned reloads tight and opens read-only. Nothing is lost.
3. **The style is written with a trailing `;`** (`style="text-align: center;"`), which is how TipTap renders it. Writing it the same way TipTap renders it keeps the save → load → save cycle byte-stable.
4. **The test is a new file, not an addition to `markdownHtmlMode.test.ts`.** A new gate, `toolbar-formatting-saved` (`markdownFormat`), reads every command `toolbarConfig.ts` chains, and fails if the test has no case that runs it. It also requires the test to reload through the production path and assert `lossy === false`.
   - The gate bit on real gaps the first time it ran. Five commands (`unsetColor`, `unsetHighlight`, `setParagraph`, `liftListItem`, `unsetLink`) had no case yet, and cases were then added for them.
5. **The comparison treats equal values as equal.** Colour reads back as `rgb(…)`, an absent style as `''`, and "left" is the default alignment. None of these changes what the note shows, and the second save's bytes are compared exactly.
6. **Found and fixed (not in the plan): Line Spacing wasn't saved.** The toolbar's Line Spacing menu set a style on the one open editor only, so other views of the note didn't show it and it was lost when the note closed. The user chose to save it **per note, in the frontmatter** (`lineSpacing: 1.5`), which keeps the body pure Markdown and matches what the button did (the whole note).
   - `noteLineSpacing(path)` (`stores/noteMeta.ts`) reads it. It accepts a number or numeric string from 0.8 to 4, and anything else means the view's default.
   - `SetLineSpacingCommand` (`commands/noteLayoutCommands.ts`, a `NoteFieldCommand`) sets it as one undoable delta, and `null` removes the key. `stores/noteLayout.ts` `setNoteLineSpacing` dispatches it.
   - The toolbar now knows which note the focused editor shows: `setActiveEditor(editor, note)` takes a getter for `{ path, historyBoardId }`, which TextTile and DocumentEditor pass. Line Spacing is disabled for editors that aren't notes (labels, titles).
   - The menu gained **Default**, which removes the key. Views have different defaults (Document tab 1.75, tiles 1.5), so a note without the key keeps each view's own.
   - TextTile sets `line-height` on its editor container, and DocumentEditor sets `--note-line-height`, used by `.tiptap { line-height: var(--note-line-height, 1.75) }`.
   - Tests:
     - `noteLineSpacing.test.ts`: the command's execute and undo, `null` removing the key, and the parsing cases.
     - Characterisation `lineSpacing.test.ts` (3 cases): saved and still there after reopening, a tile of the same note shows the same spacing, and "Default" removes it while Ctrl+Z puts it back. All 3 failed with the save disabled.
     - Harness: `chooseLineSpacing` and `viewLineSpacing`.
7. **The optional one-time "your note's style was normalised" toast (5.2) was not built.** The plan marked it optional and later.

**Exit check (re-run 2026-09-25):** lint, `check` (750 files, 0 errors), `typecheck:main`, `ci:test-typecheck`, `test:unit:strict` (550 files, 5480 passed, 1 skipped), `build` and `ci:gates` (60/60) are all green. There were no further deviations. The work is still uncommitted on `audit20/fixes`, together with Phases 2–4.

---

## Phase 6 — Small fixes (L1–L4, M6)

6.1 **L1 — new notes appear in the sidebar at once.** Call `void vaultStore.refreshTree()` after the note is created, for card, task, quick-add, text tile and "New note". Find each through `noteStore.createUnique`/`createExclusive` callers and put it in one place if possible, such as a `createNoteFile` wrapper.
- Spec: after `addKanbanCard`, the sidebar row is there within 300 ms.

6.2 **L2 — "Keep mine" backs up the bytes it overwrites.**
- Move the backup into `noteStore.resolveConflict('keep-mine')`, so it backs up the same fresh read that becomes the new base.
- The writer's re-stat-before-write then restarts if a third write lands. On restart it needs a new backup, so pass a "backup before overwrite" flag on the queued body that the writer honours for that flush.

6.3 **L3 — trash restore never replaces a file.** In `restoreFromTrash` (`main/vault/trashOps.ts`), re-check just before the rename.
- For a file on the same volume, use `fs.link(item, target)`, which fails with EEXIST if the target exists, then `unlink(item)`. Fall back to the re-check when hard links aren't supported (FAT32, some network shares).
- A folder rename onto an existing non-empty folder already fails on Windows. On an EEXIST race, pick the next ` (restored n)` name.
- Unit test with a racing create.

6.4 **L4 — tidy up.**
- Rename `V7BoardFileData` → `BoardFileData`, and `v7` wording → `v8`/"current", across the renderer. This is mechanical, with no behaviour change.
- Move the tag-name validator in `tagsStorage` from `js-yaml` to the `yaml` package. Remove the `// allow-jsyaml:` exception and the dependency. Update the `markdownFormat` gate so js-yaml is banned everywhere.
- Rename the 41 `audit*Phase*.test.ts` files by subsystem, merging where they overlap, in a commit of its own that changes no tests.
- `tiptap-markdown` on TipTap 3: no change now. Add a line to KNOWN_LIMITATIONS or the dependency report saying it's the write path's most fragile dependency, and that the round-trip suites are its guard.

6.5 **M6 — OneDrive trash probe (manual, packaged build).**
- On the OneDrive vault, empty a Filo trash item that's a normal file, one that's an online-only placeholder, and a folder.
- Do the same on a mapped network share and a FAT32 USB stick, if you have them.
- Record the results in KNOWN_LIMITATIONS #25.

### Phase 6 — done (2026-09-25): what was built, and deviations

**6.1 L1 — new notes are listed in the sidebar at once.**
- Spec first: `src/tests/characterisation/newNotesInSidebar.test.ts` (3 cases, registered in the `characterisation-suite` gate). A new Kanban card, a quick-added task and a new mind-map text tile must each show in the sidebar within 300 ms. The card case failed before the fix; the task and tile cases already passed, because their paths re-read the tree.
- Harness: `revealInSidebar(app, rel, timeoutMs?)` takes a timeout.
- Fix, in one place: `noteStore.createExclusive`, `createUnique` and `recreate` tell a listener about every note they create (`setNoteCreatedListener`). The new `stores/newNotesInTree.ts` installs it from `App.svelte`, and it re-reads the tree. Creates in a burst share one re-read, plus one more if a create lands while it runs.
- **Deviation:** the plan said to call `refreshTree()` at each caller or in a `createNoteFile` wrapper. The note store is the one path every create goes through, including drops and "Keep mine" on a deleted note. `vault.svelte.ts` can't be the listener's home, because it may only shrink (1,613-line ceiling), so the listener has its own small module. Existing awaited `refreshTree()` calls (text tile seed, Kanban template, file drops) stay, because they need the tree before their next step.

**6.2 L2 — "Keep mine" backs up the bytes it overwrites.**
- New `backupThenRead(vaultRoot, rel, read)` (`lib/vault/keepLocalBackup.ts`) stamps the file (mtime and size), backs it up, runs the read, and stamps it again. It returns the read only if the file didn't change across the whole window. Otherwise it starts over, up to 3 times, then returns `changing`. A declined "Overwrite without a backup?" returns `cancelled`.
- `noteStore.resolveConflict('keep-mine')` now does the backup itself through `backupThenRead`, so the base it keeps is exactly the version it backed up. On `cancelled` or `changing` nothing is written and the conflict prompt comes back. The prompt's Keep mine handler just calls it and reports a failure.
- The raw view's Keep mine (`NoteRawView.svelte`) had the same gap (back up, then a separate read for the hash) and uses `backupThenRead` too.
- Gate `keep-local-backup`: its chokepoints now name `resolveConflict`, `backupThenRead` and the raw view's `keepMine`, each with the call it must make. The prompt's action object carries `// allow-keep-local-no-backup:` with the reason. Proven to bite: removing the call from `resolveConflict` fails the gate.
- Tests: `keepMineBackupRace.test.ts` (4 cases). A version written between the backup and the overwrite is backed up too; a file that never settles is not overwritten and the prompt comes back; `backupThenRead` retries, and a missing file reads through. With the stamp check disabled, 3 of the 4 fail.
- **Deviation: no "backup before overwrite" flag on the writer.** The writer already holds the body and asks again when the body on disk no longer matches the base. So once the base is the backed-up version, a restart after the writer's re-stat can only merge a frontmatter-only change (nothing lost) or raise a new conflict. It never overwrites bytes that weren't backed up. The flag would have guarded a path that can't overwrite.

**6.3 L3 — trash restore never replaces a file.**
- `restoreFromTrash` (`main/vault/trashOps.ts`) moves through the new `moveWithoutReplacing`:
  - A **file** is hard-linked into place (`fs.link` fails with EEXIST when the target exists), then unlinked from the trash. A trash copy that can't be unlinked is only a duplicate, and is left in the trash.
  - If `link` fails with anything but EEXIST (FAT32, some shares), and for a **folder**, it falls back to a rename with the target re-checked before every attempt (`retryOnWindowsLock`'s `beforeAttempt`).
  - A target taken during the restore moves the item to the next free ` (restored n)` name, up to 5 tries. After that it fails and the item stays in the trash.
- Tests (`trashMain.test.ts`, 4 new cases with a racing create through a test hook): with hard links, without hard links, a folder, and a path taken on every attempt. Against a plain `rename`, the three file cases fail. The folder case passes either way, because Windows already refuses to rename a folder onto a non-empty one, as the plan expected.
- **Deviation:** the plan said to fall back "on EPERM/ENOTSUP". The code falls back on any `link` error except EEXIST, because it's unclear what code each file system reports, and the fallback is safe either way (it re-checks, and the rename throws its own error). `restoreFromTrash` takes optional `RestoreHooks` (`beforeMove`, `link`) as test seams, like `purgeTrash`'s injected `trashItem`.

**6.4 L4 — tidy up.**
- `V7BoardFileData` → `BoardFileData` and `V7BoardFileDataSchema` → `BoardFileDataSchema` (557 references in 162 files), and the 29 "V7" comment words, the `[V7]` log prefix among them, now say what they mean. The change is mechanical and byte-preserving (no line-ending changes).
- The tag-name validator (`isSafeNewTagName`) is on the `yaml` package: the core schema plus timestamps, and an explicit check for binary integers (`0b1010`). A new differential test compares it with js-yaml across 40 names and finds them identical, so the validator's behaviour is unchanged (`on` / `yes` / `no` stay allowed; numbers, booleans, null, dates, `0x1F`, `.inf` stay refused).
- The `// allow-jsyaml:` exception is gone. The gate is renamed `no-jsyaml`. It scans `src/renderer`, `src/main` and `src/shared` with no escape, fails if js-yaml or gray-matter is a runtime dependency, and has a file-count tripwire. Proven to bite with a temporary import. References in `frontmatterRead.ts`, CLAUDE.md and KNOWN_LIMITATIONS were updated.
- **Deviation: js-yaml moved to devDependencies rather than removed.** Five test suites use it on purpose as an *independent* oracle, to re-parse what the `yaml`-based engine writes. Switching them to `yaml` would make them compare the engine with itself. The app no longer depends on it, and the gate stops it coming back.
- The 41 `audit*Phase*.test.ts` files are renamed by subject (`git mv`, e.g. `audit14Phase4` → `ipcSecurityHardening`, `audit4Phase1` → `frontmatterScalarFidelity`). The references in `testTypecheckBaseline.json`, the `vaultIdentity` gate, KNOWN_LIMITATIONS and one test comment were updated.
- **Deviation:** the files were **renamed, not merged**. No test changed; the only edits inside them are the mechanical `BoardFileData` rename above. Several are grab-bags spanning subsystems, and merging them safely means splitting them first, which is more than a no-test-change commit can hold. The names follow each file's main subject. The renames are staged (`git mv`) but **not committed**: no commit was requested, and Phases 2–5 are still uncommitted, so the plan's "commit of its own" is left for when the branch is committed.
- `tiptap-markdown`: KNOWN_LIMITATIONS #32 (new) says it's the write path's most fragile dependency, lists the round-trip suites that guard it, and says to upgrade it (or `@tiptap/*`) only on its own branch. Its 0.9 release does declare TipTap 3 as its peer.

**6.5 M6 — OneDrive trash probe (run with the user's go-ahead, not the packaged build).**
- An Electron script (the dev binary, the same `shell.trashItem` call) ran in a throwaway folder in the user's OneDrive. The folder was removed afterwards; the normal file and the folder are left in the Windows Recycle Bin.
  - A normal file and a folder went to the Windows Recycle Bin.
  - An **online-only placeholder** was deleted with no error but did **not** reach the Windows Recycle Bin. OneDrive routes it to its own web recycle bin.
  - The 6.3 hard-link restore works in OneDrive, for normal and online-only files, and a link onto an existing file fails with EEXIST.
- The results are in KNOWN_LIMITATIONS #25.
- **Still open (manual):** a mapped network share and a FAT32 stick (neither on this machine), and a re-run on the packaged build if you want that confirmed.
- **Follow-up for you to decide:** the Empty-trash confirm says "the Recycle Bin can [restore them]", which isn't true for online-only OneDrive files. A wording change (or a warning when the vault is in OneDrive) was not made, since the plan asked only to record the results.

**Also fixed in passing:** `lineSpacing.test.ts` (Phase 5) held a raw U+FEFF in a regex, the Write-tool trap. It is now the `\uFEFF` escape, with no behaviour change.

**Exit check (2026-09-25):** `npm run ci:verify` ran lint, `check`, `typecheck:main`, `test:unit:strict` (552 files, 5493 passed, 1 skipped) and `build`, all green. `ci:gates` then failed only `test-typecheck`, on one type error in the new `keepMineBackupRace.test.ts`. After the fix, `ci:gates` is 60/60 (`test-typecheck` included), the test passes and lint is clean. The real-app scratch-vault check was not done in this session. All of Phases 2–6 are uncommitted on `audit20/fixes`; only the test renames are staged.

---

## Phase 7 — Docs and wrap-up

- **CLAUDE.md:**
  - `Command.renamePath` and the history sweep go under Undo/Redo.
  - Scoped `withDrainedWrites({ paths })` goes under the Vault API contract.
  - The baseline stamp sequence goes under gotchas.
  - Close/quit rescue copies go under Persistence.
  - Add the new gates.
- **KNOWN_LIMITATIONS:**
  - #17 (normalisation list), #25 (probe results).
  - A new entry for what `.filo/recovery/` rescue copies are and that nothing deletes them automatically.
- **Report and plan:** update the audit report with the fix commits, and archive both documents to `docs/archive/`.
- **Memory:** mark Audit-20 done.

### Phase 7 — done (2026-09-25): what was built, and deviations

**CLAUDE.md:**
- **Undo/Redo:** commands follow renames (`Command.renamePath`, `rebaseCommandFields`, `PATH_FIELDS` / `CONTENT_FIELDS`, trashed paths pinned, the `'history'` sweep, `RenameFileCommand` the only override), and undo on a gone note (`NoteGoneError`, **Skip this step**).
- **Vault API contract:** the scoped drain (`withDrainedWrites(op, { paths })`, what each caller passes, what stays global), the gone-file toast, the 3 s rename grace, and "external renames re-key before draining".
- **Gotchas:** forward-only drift baselines (`baselineSeq` / `ifUnchangedSince`, the never-resetting counter, the seeded new-board baseline), "a note write hides only its own watcher echo", and aligned/indented blocks as HTML, with Line Spacing in frontmatter.
- **Persistence Boundary:** close, open-another-vault and quit save first, and rescue copies go to `.filo/recovery/<timestamp>-unsaved/`.
- **Gates:** the count is now 60 (it said 55). The `writePath`, `markdownFormat` and `commands` group summaries name the new and changed gates.

**KNOWN_LIMITATIONS:**
- #17 (the restyling list) and #25 (the OneDrive probe results) were already written in Phases 5 and 6, and were re-checked here.
- **#33 (new):** rescue copies. It covers what they hold, where they go, that the prunes skip them so only the user deletes them, that they sync, and when a copy can't be written.
- #4 now says the quit dialog names each file and its cause, and that **Quit anyway** keeps rescue copies.

**Report:** a new "Resolution" section, a table that gives each finding's phase, status, specs and commit. H3's workaround and the "Before you start using it" section are marked as superseded. Both documents are moved to `docs/archive/`.

**Memory:** the Audit-20 entry is marked done.

**Deviations from the plan:**
1. **Commits are grouped, not one per step.** Phases 2–6 were built uncommitted, so at the end they went in as three commits:
   - the Phase 6.4 test renames on their own (`9c68ee4`, pure `git mv`; the gate and baseline references to the new names are in the next commit);
   - all of Phases 2–6 in one commit (`2aa2875`), because their changes share files;
   - the Phase 7 docs.

   The report's Resolution table gives these hashes. The branch was fast-forward merged to `main`.
2. **Beyond the list:**
   - CLAUDE.md's project tree gains the new modules: `recovery.ipc.ts`, `watcherSuppression.ts`, `commandPaths.ts`, `noteGoneError.ts`, `noteLayoutCommands.ts`, `vaultLeaveGuard.ts`, `unsavedRescue.ts`, `newNotesInTree.ts`, `noteLayout.ts`, `keepLocalBackup.ts`, `unsavedMessages.ts` and `blockLayout.ts`.
   - The Source-of-Truth list names `lineSpacing:` as a note field.
   - KNOWN_LIMITATIONS #4 is updated.
3. **The rescue-copy entry is #33**, the next free number.
4. **Not done:** the real-app scratch-vault check (ground rule 4). It is still open for Phases 2–6, and it is listed under "Still open" in the report.

**Exit check (2026-09-25):** `npm run ci:verify` passed every step:
- lint;
- `check` (751 files, 0 errors, 0 warnings);
- `typecheck:main`;
- `test:unit:strict` (552 files, 5,493 passed, 1 skipped);
- `build`;
- `ci:gates` (60/60).

---

## Gates added

| Gate | Group | Pins |
|---|---|---|
| `commands-follow-renames` | commands | Every command that holds a path implements `renamePath`. |
| `note-write-suppression` (Phase 2, not in the original plan) | writePath | Note writes hide only their own echo (`suppressWrite` + `noteOwnWrite`), overwrite through `withOnDiskSpelling`, and the watcher passes whether the file exists into `isSuppressed`. |
| `baseline-stamp-forward-only` | writePath | Every `noteBaseline` call carries `ifUnchangedSince`. Also (Phase 3, not in the original plan): `board:create` suppresses its own echo, and `persistNewBoard` marks it as a self-write and seeds the baseline. |
| `close-keeps-rescue-copy` | writePath | Close and quit never drop unsaved work without writing a rescue copy. |
| `toolbar-formatting-saved` (Phase 5, not in the original plan) | markdownFormat | Every command the formatting toolbar runs has a save → reload case that must not come back lossy. |
| `no-jsyaml` (tightened) | markdownFormat | No `js-yaml` / `gray-matter` import anywhere in `src/renderer`, `src/main`, `src/shared`, and neither is a runtime dependency (tests may keep js-yaml as an oracle). |
| `keep-local-backup` (updated, Phase 6) | writePath | A note's Keep mine backs up inside `resolveConflict` through `backupThenRead`, so the overwrite is built on the bytes that were backed up. |

## Risks

| Risk | Mitigation |
|---|---|
| A scoped drain (1.5) lets an operation run next to a failed write that actually mattered. | The scope includes parent and child paths. Close, quit and Save stay global. Add unit cases for folder renames over a failed child. |
| Re-keying before the drain (2.2) runs sweeps for an external rename whose target then vanishes again (sync churn). | The sweeps are pure re-keying. A later delete event takes the normal missing path, and the Phase 2 regression spec guards the delete prompt. |
| Aligned paragraphs are HTML in the file (5.1, kept by the user's decision). | Only aligned or indented blocks are written that way; `toolbar-formatting-saved` and the `aligned-blocks.md` corpus fixture pin the round-trip. |
| A `fs.link` fallback (6.3) behaves differently on network drives. | Try `link`, fall back on EPERM/ENOTSUP, and cover it in the M6 manual probe. |

## Effort (rough)

| Phase | Size |
|---|---|
| 1 | Large (about 12 commands, history sweep, scoped drain, gate) |
| 2 | Medium |
| 3 | Medium (small once 3.1 confirms the cause) |
| 4 | Medium |
| 5 | Small (after your decision) |
| 6 | Small to medium (the L4 renames are mechanical but touch many files) |
| 7 | Small |

---

## Part B — What else holds the scores down (not bugs)

Fixing every finding above doesn't take each area to 10. The rest of each score comes from three things:

- **accepted trade-offs** already in KNOWN_LIMITATIONS;
- **areas this audit didn't examine closely**, where the score is capped by uncertainty rather than lowered by evidence;
- **structural debt**.

| Area | Now | After this plan | What still holds it back | Optional follow-up |
|---|---|---|---|---|
| Note content | 8.5 | 9 | #15: a foreign write in the last milliseconds before ours is overwritten. #11: the partial-read guard. `tiptap-markdown` as a single point of failure. | A post-write read-back hash check for notes, like the one `.filo/` config has. |
| Frontmatter | 9 | 9 | #1 narrow re-dump cases, #13 quoted `"true"`, #26 tag merge has no undo, #27 tag undo reorders. | Undo for tag merge. |
| Rename / move / delete | 6 | 8.5 | #7 large or small attachments aren't auto-relinked. #19 sync-conflict-looking names. Undo of a delete depends on the item still being in the trash (an Empty or a 30-day purge makes it impossible). | Undo checks the trash first and says clearly that the item is gone. |
| Undo / redo | 6.5 | 8.5 | Board undo and editor undo are separate stacks (by design). #26, #28 (15 s tag-undo toast). | None needed for safety. |
| External edits / synced folders | 7 | 8 | #5 the self-write window is time-based for board and `.filo/` files. #14 the board baseline is size-only. #18 conflict copies are recognised by English names only. #20 every machine must run the same version. #24 the trash syncs. Not yet tested against a real OneDrive vault with two machines. | Main-process hash matching (master plan Phase 5 step 7), then close #5. A two-machine sync soak test. |
| Board persistence | 7.5 | 8.5 | #14 size-only drift baseline. #29 old boards are refused. | A content hash on the board baseline for small boards. |
| Crash / quit | 8 | 9 | #3: Windows can't fsync a directory. #4: the quit flush is best-effort under a ceiling. | None practical. |
| Editor fidelity | 7.5 | 8 | #17 lossy notes open read-only. Normalisation churn (M5). The link and table limits of `tiptap-markdown`. | A "preserve original style" serialiser: large, and only if the churn bothers you in practice. |
| Safety prompts (UX) | 6.5 | 8 | Several prompts still offer two choices where one is destructive ("Reload (discard your edits)"). | A wording pass: every destructive choice says what is lost and where a backup is. |
| Code health | 8 | 8.5 | Six files over the 1000-line limit, on an allowlist (TaskListBoard 2,069, TaskItem 1,522, KanbanSideToolbar 1,503, KanbanBoard 1,450, KanbanColumn 1,197, vault.svelte.ts 1,668). | Split them over time. The gate already stops them growing. |
| Tests / CI | 8.5 | 9 | E2E and the a11y scan are manual-only. The test type-check baseline still carries 119 known errors in 45 test files. The three worst bugs had no spec, a sign the suite follows past audits more than user flows. | A small Windows E2E smoke test on every push. Bring the test type-check baseline to zero. A "user journeys" spec file (rename then undo, create then edit fast, external rename while typing). |
| Not audited this time | — | — | IPC security, export (PNG/SVG/PDF/MD), templates, canvas geometry, accessibility, performance on large vaults. | An audit per area, each small. Export is worth doing first, because it reads every note. |

**Short answer:** in the areas with the lowest scores (rename 6, undo 6.5, prompts 6.5), the findings are nearly all of the gap. In the higher-scoring areas, what's left is mostly documented trade-offs and areas I didn't examine closely. Those are ceilings on how sure I can be, not bugs I found.

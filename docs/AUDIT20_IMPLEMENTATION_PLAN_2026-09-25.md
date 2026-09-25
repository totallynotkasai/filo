# Audit 20 — implementation plan (2026-09-25)

**Source:** [AUDIT20_PRE_DOGFOOD_2026-09-25.md](AUDIT20_PRE_DOGFOOD_2026-09-25.md).
**Base:** `main` at `dde5075`. Work on a branch (`audit20/fixes`), one commit per step or small group of steps.
**Status:** Phase 1 done (branch `audit20/fixes`). Phases 2–7 not started.

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

---

## Gates added

| Gate | Group | Pins |
|---|---|---|
| `commands-follow-renames` | commands | Every command that holds a path implements `renamePath`. |
| `baseline-stamp-forward-only` | writePath | Every `noteBaseline` call carries `ifUnchangedSince`. |
| `close-keeps-rescue-copy` | writePath | Close and quit never drop unsaved work without writing a rescue copy. |
| `no-jsyaml` (tightened) | markdownFormat | No `js-yaml` import anywhere. |

## Risks

| Risk | Mitigation |
|---|---|
| A scoped drain (1.5) lets an operation run next to a failed write that actually mattered. | The scope includes parent and child paths. Close, quit and Save stay global. Add unit cases for folder renames over a failed child. |
| Re-keying before the drain (2.2) runs sweeps for an external rename whose target then vanishes again (sync churn). | The sweeps are pure re-keying. A later delete event takes the normal missing path, and the Phase 2 regression spec guards the delete prompt. |
| Removing the alignment buttons (5.1) is a visible feature change. | It is gated on your decision, and nothing on disk changes. |
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

# Audit-23: full audit and fix plan (2026-09-28)

Scope: the whole app at `17b6c48` (after Audit-22 Phases 1–6 and UI Feedback 4), with extra weight on data integrity under Syncthing, Documents / notes, Mind Map, Kanban / Task List, and themes and settings. Also covered: redundancy, legacy code and gaps.

User context that shaped the audit: the vault is a local folder synced between machines with **Syncthing**. Other editors are used rarely while Filo is open.

Method:
- **Data integrity.** Six parallel finders swept these dimensions:
  - the note write path
  - the board and config write paths
  - vault concurrency and the watcher
  - store concurrency and the vault lifecycle
  - error handling
  - recent changes
  
  Three adversarial verifiers then tried to refute each finding. Result: 47 candidates, 45 confirmed (13 of them only partly), 2 refuted, **0 critical, 0 high**.
- **Themes, settings, UI/UX.** One dedicated reviewer. It diffed every built-in theme block against the token list and traced each setting to its effect.
- **Code health.** One reviewer. Scanner scripts covered dead exports, file reachability, CLAUDE.md drift, dependencies and assertion-free tests.
- **Syncthing check.** Done by hand: conflict-copy names, temp files, `.stversions`.
- **Gates.** `npm run ci:verify` is green: 659 test files, 6313 tests passed, 5 skipped, 69/69 gates.
- **Spot checks.** The top findings (D1, D3, T1, T3, CH1) were re-read in the code by hand before this plan was written.

## Verdict

**Filo is genuinely good.** For notes, the part where loss would hurt most, nothing in normal use silently destroys text:
- every save is a change applied to a fresh read,
- a write the disk has moved past is refused,
- Keep mine backs up the bytes it overwrites,
- close and quit write rescue copies.

The remaining problems sit in three places:
1. How **boards** react to changes arriving from outside Filo. Syncthing will do this all the time.
2. **Undo** after that has happened.
3. The new **theme editor**.

## Ratings

| Area | Rating | One-line reason |
|---|---|---|
| Notes / Documents (data safety) | **8.5** | Excellent save path. Only rare edge cases. |
| Mind Map / Kanban / Task List (data safety) | **7** | A reload followed by undo can put old board state back. |
| Sync and external changes (Syncthing) | **7** | Conflict copies are handled well. There are false alarms and some missed renames. |
| Close / quit / crash recovery | **8** | Rescue copies are solid. The quit check is weaker than the close check. |
| Error handling | **7.5** | A few failures leave a "couldn't save" mark that never clears. |
| Themes | **5.5** | Built-ins are complete (96 tokens each). The new editor has real bugs. |
| Settings | **6** | Apply / Revert is solid. Several font-size defaults do nothing. |
| UI/UX | **6.5** | Consistent and keyboard-friendly. Some white-on-accent text is unreadable. |
| Code health | **8** | Almost no dead or legacy code. Some duplicated rules. |
| Tests and tooling | **8.5** | 69 invariant gates, 6300+ tests. The HTML sanitiser has no test. |
| **Overall** | **~7.3** | Safe for notes today. A focused fix round takes it to about 8.5. |

## Findings

Ids:
- **D** = data integrity (from the workflow)
- **R** = related finds the verifiers added
- **S** = Syncthing
- **T** = themes / settings / UI
- **CH** = code health

Severity is as adjusted by the verifiers. Findings the workflow reported twice are merged.

### Data integrity — medium

**D1: The 30 s watcher scan reports Filo's own board saves as outside edits**
- **Where:** [fileWatcher.ts:485-549](../src/main/services/fileWatcher.ts:485), [vaultExternalReconcilers.ts:70-128](../src/renderer/stores/vaultExternalReconcilers.ts:70).
- **Cause:** `reconcileNow` diffs against the snapshot from about 30 s earlier, and `recordOwnWrite` never updates that snapshot. The renderer compares the stat baseline only inside the 1.5 s self-write TTL.
- **Effect:**
  - If a board write is pending, a false "changed outside Filo" prompt appears. **Reload** drops the edits armed in the debounce.
  - Otherwise the board is silently reloaded, which feeds D3 and D17.
- **Also triggered by:** window focus, throttled to 5 s.

**D2: On vault open, stale attachment tags are pruned before the rename-cascade Retry can move them**
- **Where:** [vault.svelte.ts:468-499](../src/renderer/stores/vault.svelte.ts:468) vs the recovery sequencer at L779-806.
- **Effect:** attachment tags live only in `tags.json`, so this loss is permanent.
- **Trigger:** a crash or failed drain in the middle of a rename cascade, or Syncthing delivering `tags.json` before the renamed media.

**D3: Reloading a board from disk keeps its undo/redo stack** (merged with the workflow's #7)
- **Where:** [boardDrift.ts:125-164](../src/renderer/stores/boardDrift.ts:125). `historyStore.notePossiblyStale` ([history.svelte.ts:714](../src/renderer/stores/history.svelte.ts:714)) has no callers.
- **Effect:** undo after a reload writes pre-reload snapshots over what the other machine changed. The baseline was just re-stamped, so there is no drift prompt. The whole-array Task List undos are the worst case (`MoveTaskBlockCommand`, `ReorderTaskWithinSectionCommand`).

**D4: The watcher's per-file hash cache goes stale after another program edits a note, so a move soon after is not paired as a rename**
- **Where:** `fileWatcher.ts` `hashAsync` L849-867; [renameCorrelation.ts:93-100](../src/main/services/renameCorrelation.ts:93).
- **Cause:** sizes are refreshed on a change event, hashes are not. A stale hash then vetoes the pair.
- **Effect:** a delete plus a create, so tiles show as broken.
- **Syncthing case:** edit on machine B, then rename within 30 s.

**D5: Non-media files outside `attachments/` are classified `tree` and never paired as renames**
- **Where:** [fileWatcherClassify.ts:124-128](../src/main/services/fileWatcherClassify.ts:124), `renameCorrelation.ts` L209.
- **Effect:** an external move of `Report.docx` breaks File tiles. Its `fileTags` entry is then pruned at the next open.

**D6: A vault-wide tag rename or delete is reverted by open Task List / Kanban boards**
- **Where:** [fileTagsCascade.svelte.ts:70-112](../src/renderer/stores/fileTagsCascade.svelte.ts:70), `filtersAndViews.svelte.ts` L114-147, `KanbanBoard.svelte` `flushLastView` L804-826, `lastViewFlush.ts`.
- **Cause:** the cascade rewrites the cached `lastView.filterTags`. The mounted board's in-memory filter still holds the old tag, and `flushLastView` writes it back on the next save or unmount.
- **Effect:** tasks with the renamed tag also disappear from view at once.

**D8: `AddTaskCommand` / `DeleteTaskCommand` undo replays the whole `sections` array**
- **Where:** [taskCommands.ts](../src/renderer/commands/taskCommands.ts) (AddTask ctor L97-98 and `removePlacement` L147-155; DeleteTask ctor L228 and `restorePlacement` L288-303), and `CascadeDeleteCommand` in `groupAndBoardCommands.ts`.
- **Effect:** reverts section edits made in between. `CascadeDeleteCommand` sits on whichever stack is active, so this can happen across boards.

**D9: One invalid field in `app.json` / `defaults.json` makes the whole slice fall back to defaults, and the next settings change writes those defaults over the file**
- **Where:** `vaultCandidate.ts` `parseSettingsSlices` L642-667; `configWriteScheduler.ts` `seedConfigSnapshots` / `writeConfigs`.
- **Effect:** every other valid value and every unknown key is lost, with no backup. The toast doesn't say the file will be overwritten.
- **Realistic trigger:** a newer or older Filo on the other Syncthing machine.

**D10: Failed theme / template writes and a failed `createExclusive` leave a permanent "failed" mark**
- **Where:** [writeStateTracking.ts:760-797](../src/renderer/lib/boards/writeStateTracking.ts:760), `theme.svelte.ts` L335/L365, `layoutTemplateStore.ts` L88-130, `noteWriter.ts` `createExclusive` L577-605.
- **Cause:** there is no retained ledger entry. Retry does nothing and reports nothing.
- **Effect:**
  - `save()` stays false for the session.
  - Every leave asks "couldn't be saved".
  - A rescue copy can't be written, which brings a second "lose them" confirm.

### Data integrity — low

| Id | Finding | Where |
|---|---|---|
| D11 | Notify passes can overlap and send rename batches out of order; a pair split across two passes is never correlated | `fileWatcher.ts` `scheduleNotify` L705-730, `armHeldTimer` L733-747, `notifyRenderers` L749-762 |
| D12 | Board, config and misc writes queued after the leave check (by `renameQueue` work) are cancelled at pre-swap with no rescue copy; only notes get `keepLeftBehind` | `boardSaver.ts` L140, `notes.svelte.ts` L989 |
| D13 | Vault identity changes only at commit, so watcher work during pre-swap passes `isStillSameVault` against half-reset stores | `vault.svelte.ts` `openVault` L1021-1039, `enqueueRenameQueueWork` L1363-1385 |
| D14 | An outside restore of an older Filo-written version within 10 s is ignored as Filo's own echo (**same as Audit-22 `notes-2`**) | `notes.svelte.ts` `onDiskChanged` L618-629, `noteWriter.ts` `isOwnWrite` L837 |
| D15 | The 30 s scan reads every `.md` / `.board.json` in full, even when mtime and size are unchanged | `fileWatcher.ts` `walkDir` L671-690 |
| D16 | Changes between the candidate load and the watcher's seed snapshot are never reported (themes and templates stay stale; boards are caught only by the pre-write drift check) | `vault.svelte.ts` L455-465, `fileWatcher.start` L316 |
| D17 | After a board reload, the mounted board's stale filter state is written back on the next save (the hydrate effect is keyed on `board.id` only) | `TaskListBoard.svelte` L990-998, `KanbanBoard.svelte` L843-854 |
| D18 | A running countdown timer pauses while its board is unmounted (no wall-clock anchor) and rewrites the board file every 45 s | `TimerTile.svelte` L158-196, L182-189, L286-291 |
| D19 | The vault index retries an unreadable `.md` every 2 s for the whole session (the comment says a single retry) | `vaultIndex.svelte.ts` L142-152 |
| D20 | A frontmatter-only change that removes the last key brings back the leading `---` that the scene-break (M1) fix turned into `***` | `noteFile.ts` `assembleNoteText` L184 + `withDiskBody` L189-193 |
| D21 | A body save drops an empty frontmatter block (`---\n---`) and normalises fence lines and the last YAML line's ending | `markdownSync.ts` L483-493, L579-580, `emitWithRawFrontmatter` L400-408 |
| D22 | Convert-to-UTF-8 overwrites blind: no `expectStat`, no `refuseLink`, no `withOnDiskSpelling`; its backup comes from a second read (R2) | `vaultEncoding.ipc.ts` |
| D23 | Folder rename / trash / restore don't hold the write queues of the notes inside (`notePathsOfRel` keeps only `.md` paths) | `vaultOperations.ts` L404-467, L426-430 |
| D24 | A tag add or remove on a malformed-YAML, anchored, non-UTF-8 or linked note does nothing with no toast, yet the command lands on the undo stack | `noteTagWriter.ts`, `tagRewriter.ts` L592-598, `noteWriter.transform` L713/L721 |
| D25 | A `missing` note model accepts `setBody`, and the writer skips the body-drift check when `base` is undefined, so a file that reappears (a sync download) can be overwritten blind | `noteWriter.ts` L470, `notes.svelte.ts` L453-468 |
| D26 | The STALE guard is mtime + size only; a same-size save within one timestamp tick on FAT / exFAT / SMB passes it (undocumented) | `filenameUtils.ts` L308-313 |
| D28 | `vault:write-file-text` can still create or overwrite any non-`.filo` path, `.md` included, with no stale check; only a renderer source gate stops a note write through it | `vault.ipc.ts` L614-647 |
| D29 | An undo or redo queued behind a running async command runs against whichever board is active by then | `history.svelte.ts` L181-206, L555-640 |
| D30 | The "Switched to Manual sort" toast's Undo undoes whatever is on top of the active stack | `taskListKeyboardNav.svelte.ts` L233-245, `TaskListBoard.svelte` L846-858 |
| D31 | The misc scheduler reports skipped writes to a corrupt / lock-failed viewports / hotkeys / sidebar-order file as saved, with no rescue copy; a transient hotkeys lock at load disables saves for the session (R3) | `miscWriteScheduler.ts` L57, `writeScheduler.fireWrite` L175-178, `core/hotkeys.ts` L314-324 |
| D32 | `persistNewBoard` has no vault-identity check after `board:create` | `boardCache.svelte.ts` L605-665 |
| D33 | Quit's safety check is weaker than close / open: no `unsavedWork()` re-check, no editor freeze, no component flush | `handleFlushAndQuit.ts` L148-157, `noteWriter.flushAll` L675-683 |
| D34 | Note write channels fold EBUSY / EAGAIN into `IO_ERROR`, so the write isn't retained and Retry does nothing; the coded-failure gate omits the note channels | `vault.ipc.ts` L641-645, L757-760; `scripts/gates/ipcSecurity.mjs` L100-112 |
| D35 | `NoteEditorView.serialize()` clears `unserialised` before serialising, so a throw drops the keystrokes out of every unsaved check | `noteEditorView.ts` L95-110, `notes.svelte.ts` L372-383 |
| D36 | `openConfirm` auto-answers a displaced confirm with `onCancel`; for the startup rename-cascade / tag-rewrite prompts, that is the destructive answer | `ui.svelte.ts` L288-307, `vault.svelte.ts` L181-212, L731-806 |
| D38 | A completed write clears its path's pending mark while a newer debounced write is armed; the `.dirty` sentinel can be cleared too early | `writeStateTracking.ts` L583-642 |
| D39 | `failedVaultPaths` is silently trimmed at 256 entries | `writeStateTracking.ts` L231-250 |
| D40 | The error-toast aggregator coalesces by context without a path: a second error replaces the first file's name, and the raw context id is shown | `errorToastAggregator.ts` L109-157, `errorBus.ts` L32-51 |
| D41 | A trash restore by hard link leaves the entry listed when the trash-side unlink fails | `trashOps.ts` L150-171, L241-270 |
| D42 | Folder moves noted by any tree read are replayed at the next reconcile without checking they still hold | `unreconciledFolderMoves.ts`, `vault.svelte.ts` L1246, L1295-1305 |
| D43 | `refreshTree` applies a tree read from before a vault swap on its success path; `refreshTreeAndCleanup` then runs eviction and pin walks against it (R4) | `vault.svelte.ts` L1209-1260 |
| D44 | Since `17b6c48`, undo during the watcher's rename-correlation window reports the note as gone and offers **Skip this step** | `frontmatterInverse.ts` `applyDeltaChecked` L187-200 |
| R1 | `fileBaselineRegistry` comment and CLAUDE.md say the write sequence never resets, but `resetAllBaselines` clears `writeSeqs` (harmless today) | `fileBaselineRegistry.ts` L77-81, L252-255 |

Refuted: "the baseline registry's cleared `writeSeqs` lets a pre-swap read ticket overwrite a new vault's baseline" and "`resolveContentFolder` treats a root-pinned board as unpinned".

### Syncthing

**S1: Syncthing's `.stversions/` folder is not ignored by the watcher or the vault index**
- **Where:** [fileWatcherClassify.ts:29-34](../src/main/services/fileWatcherClassify.ts:29), `fileWatcher.ts` `walkDir` L642-652, [vaultIndex.svelte.ts:277-295](../src/renderer/stores/vaultIndex.svelte.ts:277).
- **Cause:** the sidebar tree skips dot entries, but the watcher and `vaultIndex.applyChanges` don't.
- **Effect when file versioning is on:** old versions (`Note~20260928-101112.md`) enter search, tag counts and the Replace All scope.
- **Rarer risk:** in the gap between Syncthing archiving the old file and renaming the new one into place, the cross-name correlator could pair `Note.md` → `.stversions/Note~….md` as a rename.
- **Already sound:** the Syncthing conflict-copy name is detected; `~syncthing~*.tmp` is ignored by the `.tmp` rule.

### Themes, settings, UI/UX

| Id | Sev | Finding | Where |
|---|---|---|---|
| T1 | high | Custom themes and System-only mode can't colour the toolbar or tab bar: with `toolbarColor` / `tabBarColor` blank, an effect calls `removeProperty('--toolbar-bg' / '--tabbar-bg')` after every theme paint, wiping what `applyCustomTheme` set. 7 editor rows are dead. | [App.svelte:241-250](../src/renderer/App.svelte:241), `themeManager.ts` L202-211, L251-261 |
| T2 | high | Global Defaults / Current Board font sizes don't affect new elements: every factory copies General "Default Board Font Size" into the element's own style, which wins the cascade | `tiles.svelte.ts` L26-37, `kanbanTileCreation.ts` L28-34, `taskCreation.ts` L40-46, `sectionOps.ts` L45, `ConnectionBubbles.svelte` L105, `SideToolbar.svelte` L149, `KanbanBoard.svelte` L255; `resolveStyle.ts` L69 |
| T3 | med-high | An active custom theme with an unknown `base` stops the vault opening | [vaultCandidate.ts:459-468](../src/renderer/lib/vault/vaultCandidate.ts:459) |
| T4 | medium | Theme files can set any CSS variable (`--z-modal` etc.), so dialogs can end up behind the app; disk-read theme files aren't schema-checked at all | `themeFiles.ts` L92-101, `themeManager.ts` L251-261, `theme.svelte.ts` L101-109 |
| T5 | medium | The theme editor's picker turns rgba tokens (Selection, backdrop, tints, pattern) opaque | `ThemeEditor.svelte` L176-180, `ColorPicker.svelte` L201-230 |
| T6 | medium | Hard-coded white text on `--accent-primary` is unreadable in Retro / Nature / Blueprint (~2:1); `--accent-on-primary` is used as if it existed but is defined nowhere | `SmartListTabs.svelte` L131/136, `TaskQuickAddInput.svelte` L234, `TagsBrowser.svelte` L394, `LinkInsertPopup.svelte` L241, `TaskItem.svelte` L963, `TagPromptPopup.svelte` L130, `SaveTemplateModal.svelte` L255, `TemplateBrowser.svelte` L641, `TileContainer.svelte` L409 |
| T7 | medium | Unsaved theme-editor work is discarded without asking on a tab switch or Escape | `confirmDiscardSettings.ts` L25, `ProjectSettings.svelte` L273 |
| T8 | low-med | The editor's Save bypasses `selectTheme`: no "use the theme's colours?" prompt, and it persists even in System-only mode | `ThemeEditor.svelte` L97-101, `themeActions.ts` L87-89 |
| T9 | low | Deleting the active custom theme outside Filo falls back to Light with no notice | `vaultExternalReconcilers.ts` L216-220, `theme.svelte.ts` L234-235 |
| T10 | low | Toggling System Colours Only doesn't repaint until the next theme pick | `theme.svelte.ts` L65-67 |
| T11 | low | Save silently ignores a mistyped colour (flagged red, but the old value is saved) | `ThemeEditor.svelte` L67-72, L84-91 |
| T12 | low | Accessibility: 96 swatches all announced as "Pick color"; Toolbar / Tab Bar Color labels are spans; theme cards don't expose which is active | `ColorPicker.svelte` L335, `GeneralSettings.svelte` L453/462, `ThemeManager.svelte` L105-152 |
| T13 | low | Built-in theme preview swatches are stale; every card shows the same accent dot; custom themes get no preview; the Danger-zone red is hard-coded (~2.3:1 in dark); the Themes tab is labelled "Auto" despite Save / Cancel | `ThemeManager.svelte` L20-26, `ProjectSettings.svelte` L420/443 |

Checked and fine:
- All 5 built-ins define all 96 tokens, with no strays.
- The value sanitiser works.
- Name rules hold.
- Delete goes to Filo's trash.
- Preview is undone on Cancel and on unmount.
- Apply merges only the changed fields.
- `settleUnappliedEdits` works.
- Number fields clamp.
- Every General setting traced has a real effect.

### Code health

| Id | Sev | Finding | Where |
|---|---|---|---|
| CH1 | medium | Two frontmatter object readers disagree on recoverable YAML errors (duplicate key, tab indent): the note model sees `{}` while the index sees the keys, so title and tags vanish once the note is opened | [markdownSync.ts:100-107](../src/renderer/lib/editor/markdownSync.ts:100) vs [frontmatterRead.ts:46-58](../src/renderer/lib/vault/frontmatterRead.ts:46) |
| CH2 | low-med | `sanitizeInlineHtml` (the DOMPurify sink for `titleHtml` from externally editable board JSON) has no test | `lib/utils/sanitizeHtml.ts` |
| CH3 | low | A second fence detector: the vault index takes its object from remark-frontmatter's `yaml` node; no divergence found in probes | `vaultIndex.ts` L111, L159-161 |
| CH4 | low | Three copies of the illegal-filename rules (`\x7f`, replace vs strip, reserved names differ) | `shared/fileNames.ts` L20, `main/vault/filenameUtils.ts` L13, `boardLoader.ts` L665-667 |
| CH5 | low | `pathsEqual` (case-sensitive) vs `samePath` (case-folded): the names invite misuse | `lib/utils/path.ts` L30/L50, caller `VaultSidebarToolbar.svelte` L168 |
| CH6 | low | About 88 ad-hoc `.toLowerCase()` path keys instead of `vaultPath()` (don't normalise `\` or a leading `/`); `tagsStorage.normalisePath` is a no-op wrapper | `boardDiscovery.ts` L51-93, `vaultDeleteOps.ts` L30-192, `folderPins.ts` L161, `tagsStorage.ts` L567/L597 |
| CH7 | low | A test-only branch in the production board store (`synthesizeCacheEntry`, the extra `setBoard` args) | `board.svelte.ts` L72-134, L321-336 |
| CH8 | low | Dead export `__resetRawViewsForTests`; 7 exports used only by tests | `rawViews.ts` L135 and others |
| CH9 | low | The `js-yaml` module shim sits in the renderer's type space | `shims.d.ts` L1-20 |
| CH10 | low | Stale comments: the "legacy consumers" virtual project, "mirrors sanitizeFilename", history in `ipcEnvelopeContract.test.ts` | `vault.svelte.ts` L97, `boardLoader.ts` L665, test L19 |
| CH11 | low | `NOTE_WRITE_DEBOUNCE_MS` repeats `BOARD_WRITE_DEBOUNCE_MS` instead of importing it | `noteWriter.ts` L70 |
| CH12 | low | Files at the 1000-line gate and not allowlisted: `notes.svelte.ts` 999, `MindMapBoard.svelte` 990, `TaskListSideToolbar.svelte` 979 | |
| CH13 | low | 80 source files are missing from the CLAUDE.md tree (largest: `TaskListSection`, `TextFormattingToolbar`, `VaultSidebarToolbar`, `TaskDatePicker`, the `CurrentBoard*` panels, `fileTagsCascade`, `boardDiscovery`, `renameCascadeRepair`) | CLAUDE.md |
| CH14 | low | Coverage ratchet at 45 % lines for `lib/**`; test-typecheck baseline 119 errors in 45 files; no direct tests for `themeActions`, `recentVaults`, `filoMedia`, `renameGrace`, `closeDrainGate`, `seedTextFileForNewTile`, `viewportCache` | `vitest.config.mts` L68, `testTypecheckBaseline.json` |
| CH15 | low | 150 test files carry Audit / Phase ids and 10 are named after phases (still open from Audit-22 `ci-8`) | `src/tests/` |
| CH16 | low | The `audit-filo-data-integrity` skill's prompts name deleted files (`markdownFileWriter.ts`, `conflictResolver.ts`, `frontmatterWriteScheduler.ts`) | the skill definition |

## Fix plan

Each phase is one commit on `main` after `npm run ci:verify`, with a real-app check where the change is visible. Each fix gets a regression test that fails before the fix. Prove any new gate bites before relying on it.

Phases are ordered by what hurts first in daily use with Syncthing: boards and undo, then settings and config safety, then themes. Decisions that change behaviour are listed under "Decisions needed" and should be settled before the phase that needs them starts.

### Phase 1: board reloads, drift and undo (D1, D3, D6, D8, D17, D29, D30, D44)

1. **D1, both sides.**
   - **Main:** `recordOwnWrite` (and the board-write suppress path) also updates `reconcileSnapshot` for that path, so the next scan diffs from Filo's own bytes.
   - **Renderer:** `reconcileBoardJsonChange` stats the file and returns early when it equals the drift baseline (`getBaseline`), at any age, not only inside the 1.5 s TTL. `resolveBoardDrift` checks the same before prompting.
   - **Tests:** a save followed by a scan 30 s later gives no prompt and no reload. A genuine external edit still prompts.
2. **D3.**
   - `reloadBoardFromDisk` clears that board's stacks (`historyStore.clearBoard(boardId)`) and shows one toast: *Undo history for "Plan" was cleared because the board changed outside Filo.*
   - Delete `notePossiblyStale` if it stays unused, or wire it in instead (see Decisions).
   - **Test:** reload, then Ctrl+Z, leaves the disk version intact.
3. **D17 + D6: re-hydrate on reload.**
   - Give each board cache entry a reload revision that `replaceCache` and the tag cascade bump.
   - The TaskListBoard / KanbanBoard hydrate effects key on `id + revision`, so the in-memory filters take the reloaded or cascaded `lastView`. `flushLastView` then has nothing stale to write back.
   - **Tests:** a tag rename with a filtered board open; a reload with a different `lastView` on disk.
4. **D8.**
   - `AddTaskCommand` / `DeleteTaskCommand` record section deltas: only the section they touched, and the task ids added or removed. This is the pattern `AddSectionCommand` / `DeleteSectionCommand` already use.
   - `CascadeDeleteCommand`'s placement children get `targetBoardId` so they undo on their own board.
   - **Test:** add a task, rename a section, undo the add, and the rename stays.
5. **D29.** The deferred branch of `runChained` re-checks `targetBoardId` against the active board when the queued body runs. On a mismatch it switches (and settles) as the synchronous path does, or it puts the command back with a toast.
6. **D30.** The Manual-sort toast records the id of the command it offers to undo. Undo runs only if that command is still on top of that board's stack; otherwise the toast says it can't.
7. **D44.** In `applyDeltaChecked`, a definite "missing" answer waits out the rename grace (`askUnlessMoved` / `NOTE_RENAME_GRACE_MS`) before throwing `NoteGoneError`, so a rename in progress re-keys the command first. Keep the `17b6c48` race fix: never queue a write for a path that is still missing after the grace.

#### Phase 1 status: done (2026-09-28)

All seven items are fixed. Each has a regression test that was run against the unfixed code, failed there, and passes with the fix. Decision 1 was taken as recommended: a reload clears the board's undo history, and `notePossiblyStale` is deleted.

| Item | Fix | Tests |
|---|---|---|
| D1 (main) | `FileWatcher.recordOwnWrite` also moves the reconcile snapshot's entry for the path (matched case-folded) to the bytes Filo wrote: the file's stat plus the same FNV hash the walk computes (`reconcileHash`, now shared with `walkDir`). Only an entry the snapshot already holds moves, and only when the file's size is still the size written. | `watcherOwnWriteReconcile.test.ts`: a save isn't reported by the next scan, other spelling, a later outside edit still is, a different size in the gap still is |
| D1 (renderer) | `reconcileBoardJsonChange` stats a tracked board and returns when the stat equals its drift baseline (`boardMatchesBaseline`), at any age. | `boardScanOwnSave.test.ts`: armed edit → no prompt; nothing armed → no reload; real change → prompt / reload |
| D3 | `reloadBoardFromDisk` calls `historyStore.clearBoard(boardId)` (which now returns how many steps it dropped) and, when there were any, toasts *Undo history for "Plan" was cleared because the board changed outside Filo.* `notePossiblyStale` and its once-per-session flag are removed, with their tests. | `boardChangedOutside.test.ts` (characterisation): outside change → notice → Ctrl+Z leaves the disk version |
| D17 + D6 | New `stores/boardViewRevision.svelte.ts`: a per-board revision, bumped by `replaceCache` for every entry whose data object changed and by `cascadeTagToBoardSettings` for every board whose saved views it rewrote. Kanban hydrates through a `ViewHydration` (board id + revision); the Task List's `FiltersAndViews.needsHydrate` does the same. | `boardChangedOutside.test.ts`: an outside `lastView` change shows at once; a tag rename keeps filtering and leaving saves the new tag |
| D8 | `AddTaskCommand` / `DeleteTaskCommand` record only each section's start index by id, and undo puts back only those starts on the sections that still exist. | `taskUndoKeepsSectionEdits.test.ts`: add / delete then rename or collapse a section; a section deleted since stays deleted |
| D29 | Undo and redo bodies run through `onTargetBoard`: a body that finds another board active when its turn comes (it was queued behind a running command) switches back and settles first, or, when that board is closed, throws `TargetBoardClosedError`; the rollback puts the step back and the usual "Switch to the originating board" toast shows. | `historyQueuedUndoBoard.test.ts` |
| D30 | New `historyStore.undoIfLatest(command, boardId)`. The Manual-sort switch lives in one helper, `lib/tasklist/manualSortSwitch.ts`, used by drag and keyboard reorder; its toast's Undo undoes the batch only while it is still the last step on that board, and otherwise says so. | `historyQueuedUndoBoard.test.ts` (`undoIfLatest`) |
| D44 | On a definite "missing", `applyDeltaChecked` waits up to `NOTE_RENAME_GRACE_MS` for a rename that moves the note (a temporary rename sweep, `rebasePath`, so a folder rename counts) and applies once more at the new path, or at the old one if the file came back. Missing again on that second try, it throws `NoteGoneError` as before, so nothing is queued for a missing path. | `undoWaitsOutRename.test.ts`: rename after the "missing" answer; still missing after the grace |

**Verification.** `npm run ci:verify` is green: 665 test files, 6331 tests passed, 5 skipped, 69/69 gates (the test-typecheck baseline for `phase24SchemaPolish.test.ts` went down from 12 to 6 with the removed block). A real-app check (built app, Playwright `_electron`, a fresh scratch vault, the real Windows watcher) confirmed:
- **D1:** three tasks added to a new Task List, then 40 s with no outside change: no drift prompt, no reload, no notice after the 30 s scan.
- **D3:** another program dropped a task from the board file. The list showed the two left at once, with *Undo history for "Task List 1" was cleared because the board changed outside Filo.* Ctrl+Z then changed nothing, on screen or on disk.
- No renderer or console errors.

D6 / D17, D8, D29, D30 and D44 are covered by the characterisation and unit specs above. They were not driven by hand.

**Deviations from the plan**

- **D1:** the plan put the renderer's baseline check in both `reconcileBoardJsonChange` and `resolveBoardDrift`. It is only in the reconciler. `resolveBoardDrift`'s other caller, the board writer, compares the same baseline right before it asks, so a second check there would change nothing. The main side also does not add a snapshot entry for a file the scan hasn't seen yet (a brand-new board): the scan reports it once, as before, and the renderer's baseline check now drops it, since `persistNewBoard` stamps the baseline at create.
- **D3:** the toast appears only when the board had undo or redo steps to drop, so a silent reload of a board nobody edited (every Syncthing update of it) stays silent. `clearBoard` also sweeps steps on other boards' stacks that target the reloaded board, as it already did for a closed board.
- **D17 + D6:** the plan put the revision in the board cache entry. It lives in its own small store instead, because `KanbanBoard.svelte` and `TaskListBoard.svelte` sit at their line ceilings and the cache entry is the board file's shape (a revision there would be written to disk or need stripping). `replaceCache` bumps every replaced entry, not only reloads, so the folder-rename rollback also re-hydrates. The characterisation spec needed an 8 s wait before the outside write: on Windows a board save hides its own watcher echo for 7 s (`LOCK_AWARE_SUPPRESS_MS`).
- **D8:** the plan said "only the section they touched". An add or delete shifts the start of every later section, so the command records every section's start (ids and numbers, no titles or styles) and restores only that field. `CascadeDeleteCommand`'s placement children already carried and acted on their own board id (they target the cache by id, not the active board's facades), so no change was needed there; the cross-board harm the plan described came from the whole-`sections` replay, which this fix removes.
- **D29:** instead of a check inside `runChained`, undo and redo wrap their body (`onTargetBoard`). `runChained` has no command to check, and `runOffStack` / `execute` bodies don't need it. A body that runs at once on its own board is still synchronous.
- **D30:** also removed the duplicated toast code: `TaskListBoard.svelte` shrank by 21 lines, and its ceiling in `scripts/gates/codebase.mjs` went from 1961 to 1940 (`KanbanBoard.svelte`: 1437 to 1436).
- **D44:** the plan named `askUnlessMoved`. That helper is built for a note model's prompts (it runs a callback, not a promise, and has no way to report the new path), so the wait is a small promise over `registerPathRenamable` that resolves as soon as the rename arrives. An undo of a note that really is gone now takes up to 3 s before it says so.
- **CLAUDE.md:** the two new modules are in the tree, and the drift gotcha says a reload clears the board's undo history.

### Phase 2: settings, config and failure reporting (D9, D10, D31, D34, D39, D40)

1. **D9.**
   - `parseSettingsSlices` salvages field by field. Each field that parses is kept, each field that fails falls back alone, and unknown keys are carried through (passthrough) so a newer Filo's keys survive.
   - Before the first write over a file that needed salvage, copy it to `.filo/recovery/<ts>-keep/`.
   - The toast names the fields that were reset and says a copy was kept.
   - **Tests:** out-of-range `globalFontSize`, an unknown enum value, an unknown key, then a settings change. Only the bad field changes on disk.
2. **D10.**
   - Failures from `trackComponentWrite` callers (theme save, template save) either retain a retry closure in a small ledger that Retry can re-fire, or call `markPathReported` so the path stops counting as unsaved once the toast has told the user.
   - `createExclusive` must not mark a never-created path as failed; its own toast already offers Save as new / Discard.
   - **Tests:** Retry re-fires a theme save; a failed exclusive create doesn't block leaving.
3. **D31.**
   - The misc scheduler reports a skipped write to a corrupt / lock-failed file as failed, not retryable, as `configWriteScheduler` already does.
   - `hotkeys.json` retries its load on the next write when the failure was a lock, not corruption.
4. **D34.**
   - `ipcErrorCode` maps EBUSY / EAGAIN to a retainable `LOCKED` code (or the note writer's scheduler sets `retainIoError`).
   - Add the note write channels to the gate's `WRITE_HANDLER_CHANNELS`.
5. **D39.** Stop trimming `failedVaultPaths`, or trim only entries whose path also has no retained ledger args.
6. **D40.** `reportError` accepts an optional path, and the aggregator keys on context + path. Show a readable label instead of the raw context id.

### Phase 3: themes and theme-related settings (T1–T13, T2)

1. **T1.** The App.svelte effect only sets the variables when the user chose a toolbar / tab bar colour. With the setting blank it must not `removeProperty` what the active theme set. Paint order: theme → user override. Recompute the black / white bar text from the effective colour. **Component test:** a custom theme with a red toolbar paints red, and System-only does too.
2. **T2.** Element factories stop copying font sizes into new elements, so new tiles, cards, tasks, sections, frames and connection labels inherit from the cascade.
   - Decide what General "Default Board Font Size" means once factories stop copying it (see Decisions).
   - Existing elements keep their explicit sizes; "Apply defaults to all" (`applyDefaultsToAll.ts`) already clears them on request.
   - **Tests:** Global Defaults title size 24, add a tile, it renders 24. Change the default again, and the tile follows.
3. **T3.** An unknown `base` falls back to `light` with a toast at open (the runtime path already does this). The vault must not refuse to open over a cosmetic file.
4. **T4.**
   - `normaliseThemeVariables` keeps only names in `THEME_TOKEN_NAMES`.
   - Disk-read theme files pass the same schema and filter as imports.
   - `applyCustomTheme` applies only theme tokens.
   - **Test:** a hostile import with `--z-modal`; the dialog still shows.
5. **T5.** The colour picker keeps alpha: add an opacity slider, or keep the original alpha when the picked hex replaces an rgba value. Tokens known to be translucent always show the alpha control.
6. **T6.**
   - Define `--accent-on-primary` in every built-in theme (set to `--text-inverse` where that is right) and add it to the theme tokens.
   - Replace every hard-coded `white` / `#fff` on the accent with it.
   - **Test:** a contrast check (`contrastRatio`) ≥ 4.5:1 for all 5 built-ins.
7. **T7.** The theme editor registers its dirty state with `confirmDiscardSettings`, so a tab switch or Escape asks Save / Discard / Cancel.
8. **T8.** The editor's Save goes through `selectTheme` (the colour prompt, and the System-only session rule).
9. **T9.** The external-delete fallback shows *"The theme 'X' was deleted outside Filo; switched to Light."*
10. **T10.** Toggling System Colours Only re-applies the active theme at once.
11. **T11.** Save is disabled, or refuses with the field named, while any colour is invalid.
12. **T12.**
    - Give each swatch an `aria-label` with its row name.
    - Make Toolbar / Tab Bar Color real `<label>`s.
    - Mark the active theme card with `aria-current` or `aria-pressed`.
13. **T13.**
    - Preview swatches read from the real theme values (built-in values taken from computed tokens, custom ones from the file).
    - Show each theme's own accent.
    - Use a theme token for the Danger-zone red.
    - Relabel the Themes tab.

**Real-app check:** switch through all 5 built-ins and one custom theme with toolbar and tab bar colours, and take screenshots.

### Phase 4: sync, watcher and attachment tags (S1, D2, D4, D5, D11, D15, D16)

1. **S1.**
   - Ignore Syncthing's `.stversions/` and `.stfolder/` in `shouldIgnorePath` and `walkDir`.
   - Make `vaultIndex.applyChanges` skip any path with a dot-segment, matching the tree walker (see Decisions for the general rule).
   - **Tests:** a create under `.stversions/` is not indexed and never pairs as a rename target.
2. **D2.** Run the open-time `pruneOrphanFileTags` after the recovery sequencer finishes. Or skip paths named in a pending rename-cascade sentinel and paths whose file is still missing because of a known pending cascade.
3. **D5.**
   - Classify every non-`.md`, non-board, non-`.filo` file as `attachment`, not only media and files under `attachments/`, so renames pair and tags follow.
   - Check the attachment reconciler prompts only when a tile or tag points at the file.
   - **Test:** an external move of `Report.docx` with a File tile and a tag.
4. **D4.** A change event invalidates `lastKnownHashes[path]`, so the correlator falls back to size, or re-hashes the file on the event.
5. **D11.** Serialise `notifyRenderers` passes: a new pass waits for the running one. Merge `heldMissing` rather than replacing it.
6. **D15.** `walkDir` re-hashes only when mtime or size changed since the last snapshot, or the cached hash is missing.
7. **D16.** After `vault:watch` seeds, compare the seed stats with the candidate-load baselines for boards, themes and templates, and dispatch a change for any that differ.

**Real-app check with two Syncthing peers, if available:**
- Edit then rename a note on B.
- Rename a `.docx` on B.
- Turn versioning on and check that search shows no `.stversions` notes.

### Phase 5: note write-path edges (D20, D21, D22, D24, D25, D35, CH1, D14, D26)

1. **CH1.** One frontmatter object reader. `markdownSync` calls `parseFrontmatterObject`, or both call one function with an explicit policy for recoverable errors. Decide whether a duplicate key reads (index behaviour) or reads as `{}` (see Decisions). Add a fixture with a duplicate key and a tab indent, opened and closed.
2. **D20.** `withDiskBody`'s no-frontmatter branch applies `bodyWithoutFenceLookalike` to `fresh.body`. **Test:** a scene-break note, then remove its last key.
3. **D21.**
   - An empty block (`---\n---`) is kept on a body save.
   - `emitWithRawFrontmatter` keeps the fence lines' original bytes and the frontmatter's own line ending.
   - **Round-trip fixtures:** an empty block, `--- ` with a trailing space, CRLF frontmatter over an LF body.
4. **D22.**
   - `vault:convert-to-utf8` snapshots the exact `bytes` it read (pass them to the snapshot, don't read again).
   - It passes `expectStat`, `refuseLink` and `withOnDiskSpelling` like every other note write.
5. **D24.** `writeTagChangeToMarkdownPath` shows the same "frontmatter is malformed / note is read-only" toast as `patchFrontmatter` when the rewrite can't apply, and the tag command is not pushed (or is removed).
6. **D25.** `setBody` refuses a `missing` model (as the editors already do). A write whose model has no `base` treats any existing file as drift, so it becomes a conflict, never a blind overwrite.
7. **D35.** Clear `unserialised` only after `setBody` succeeds. On a throw, keep the flag and report it with a named toast.
8. **D14.** Carried over from Audit-22 `notes-2`. Match only the latest own-write hash (and `base`) as an echo, or require the echo within the main-side suppression window. Test the V1 → V2 → V1-restore case.
9. **D26.** Document the coarse-mtime limit in KNOWN_LIMITATIONS. Optionally also compare a content hash in `beforeAttempt` for small files.

### Phase 6: vault lifecycle and queue edges (D12, D13, D23, D32, D33, D36, D38, D42, D43)

1. **D33.** Quit uses the same checks as `saveBeforeLeaving`:
   - `releaseFocusedField`,
   - `holdCloseDrainUntilSwap` (or an equivalent freeze),
   - `flushAllComponents`,
   - a second pass while `unsavedWork()` is not empty,
   - the decision based on `isUnsavedWorkEmpty(unsavedWork())`, not on `saveStateStore.state`.
   
   `noteWriter.flushAll` re-drains keys queued during its own await.
2. **D12.** `saveBeforeLeaving` drains `renameQueue` before its final check. The pre-swap board / config handlers write rescue copies for anything they cancel, as notes do (`keepLeftBehind`).
3. **D13.** Start the leave by setting the tearing-down flag (or bumping the generation) before the pre-swap handlers run. `enqueueRenameQueueWork` tasks bail on `isVaultTearingDown()`.
4. **D43.** `refreshTree` checks `isStillSameVault(identity)` and `root === vaultPath` on the success path too, and `refreshTreeAndCleanup` skips its walks on a stale read.
5. **D32.** `persistNewBoard` captures the vault identity and bails, with the board file left on disk for the old vault, when a swap finished during `board:create`.
6. **D36.** `openConfirm` queues a second confirm behind the first instead of cancelling it. At minimum, the startup recovery prompts are never auto-answered.
7. **D23.** Folder rename / trash / restore hold every note queue under the folder: a prefix hold in `noteWriter.hold` over `pending` and the models.
8. **D38.** Make `pendingVaultPaths` a count, or have `endWrite` leave the key when the scheduler still has a pending entry for the path.
9. **D42.** Before replaying a noted folder move, check that the old path is absent and the new one present; drop it otherwise.

### Phase 7: smaller runtime fixes (D18, D19, D28, D41, R1)

1. **D18.** The timer stores a wall-clock `endsAt` while running (schema: optional). The remaining time is computed from it on mount. Drop the 45 s coarse persist, or keep it only for display on another machine.
2. **D19.** Unreadable-note retries back off (2 s, 10 s, 60 s, then stop until the next watcher event).
3. **D28.** `vault:write-file-text` refuses `.md` / `.markdown` targets in main. Only sentinel paths may use it. Confirm how the sentinels pass `assertNotInFiloDir`.
4. **D41.** When the trash-side unlink fails after a hard-link restore, mark the manifest entry "restored, copy left in trash" so the list doesn't offer a second restore.
5. **R1.** Fix the `fileBaselineRegistry` comment and the CLAUDE.md line, or keep `writeSeqs` across swaps so the documented invariant is true.

### Phase 8: hygiene and code health (CH2–CH16)

1. **CH2.** Unit tests for `sanitizeInlineHtml`: script, event handlers, `javascript:` URLs, style and allowed marks.
2. **CH4.** One filename-rule module (`shared/fileNames.ts`). `sanitizeFilename` and `boardFileStem` call it.
3. **CH5.** Rename `pathsEqual` to `pathsEqualExact` (or remove it in favour of `samePath` after checking its one caller).
4. **CH6.** Replace the ad-hoc `.toLowerCase()` path keys with `vaultPath()` in the stores listed. Drop the no-op `normalisePath`. Consider a gate against new ones.
5. **CH7.** Move the test-only `setBoard` / `synthesizeCacheEntry` branch into a test helper.
6. **CH8, CH9, CH10, CH11.**
   - Remove the dead export.
   - Move the `js-yaml` shim to the test typings.
   - Fix the stale comments.
   - Import the shared debounce constant.
7. **CH12.** Split `notes.svelte.ts` before it crosses 1000 lines; the conflict / keep-mine half is a natural seam. Watch `MindMapBoard.svelte` and `TaskListSideToolbar.svelte`.
8. **CH13.** Add the 80 missing files to the CLAUDE.md tree (at least the larger ones).
9. **CH14.** Add direct tests for the modules listed. Raise the coverage ratchet as coverage allows. Keep reducing the test-typecheck baseline.
10. **CH15.** Carried over from Audit-22 `ci-8`; optional churn.
11. **CH16.** Refresh the `audit-filo-data-integrity` skill's file names (`noteWriter.ts`, `noteDiskChange.ts`, `notes.svelte.ts`, `scripts/gates/`).

## Decisions needed

| # | Question | Recommendation |
|---|---|---|
| 1 | D3: after a reload from disk, clear that board's undo history, or keep it and offer "Clear undo history" (`notePossiblyStale`)? | **Clear it** with a toast. Keeping it invites the exact overwrite this finding describes. Delete `notePossiblyStale`. |
| 2 | T2: once factories stop copying sizes, what is General "Default Board Font Size"? | Make it the **bottom layer of the cascade** (under Global Defaults), or retire it in favour of Global Defaults. Leave existing elements' explicit sizes alone. |
| 3 | S1: ignore just `.stversions` / `.stfolder`, or every dot-folder at any depth (matching the sidebar tree)? | **Every dot-segment** except Filo's own root `.filo/` rules, so the watcher and the index see exactly what the tree shows (this also covers `.obsidian/`, `.trash/`). |
| 4 | CH1: a note whose frontmatter has a duplicate key or tab indent: read its keys, or treat it as having no frontmatter? | **Read them** (the index behaviour) for display, but keep the writer refusing to patch a block with errors (it already fails closed). |
| 5 | D9: when a settings field is invalid, keep writing (salvage + backup) or pause writes to that file for the session like a corrupt file? | **Salvage + backup.** Pausing would silently drop every settings change for the session. |
| 6 | D18: timers keep running while their board is closed (wall-clock), or pause? | **Keep running**: that is what a countdown means. |

## Status

- **Phase 1:** done 2026-09-28 (status block under Phase 1).
- Phases 2–8: not started.

When a phase lands, add a "Phase N status" block (fix, tests, verification, deviations) as in Audit-22. When every phase is done, move this file to `docs/archive/`.

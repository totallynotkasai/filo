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

#### Phase 2 status: done (2026-09-28)

All six items are fixed. Each has a regression test that was run against the unfixed code, failed there, and passes with the fix. Decision 5 was taken as recommended: salvage plus a backup, never a paused file.

| Item | Fix | Tests |
|---|---|---|
| D9 | New `lib/settings/settingsSalvage.ts`: `salvageSlice` parses a slice, drops each field an issue points at (a bad item in a list drops the list) so its default applies, and copies back every key the schema doesn't know. `parseSettingsSlices` uses it for all five slices and names the reset fields in one warning per file. The candidate lists the salvaged files; the commit marks them in `configWriteScheduler`, whose first write over such a file copies it to `.filo/recovery/<ts>-keep/` first (`backupConfig`). No copy, no write: the change fails as `EBUSY`, kept for Retry. | `settingsSalvage.test.ts`: out-of-range size, unknown enum, unknown keys in both files, a bad list item; the first write copies first and changes only the bad and the edited field; a second write doesn't copy again; a failed copy blocks the write |
| D10 | `trackComponentWrite` takes `onFailure`. `{ retry }`: a transient failure is kept in the new `lib/boards/componentWriteRetry.ts` (a retry hook, so the toast's Retry and quit's "Retry now" fire it; its file goes into a rescue copy); any other failure is reported (`markPathReported`). `'report'`: always reported. Theme and template saves pass `retry`; theme and template deletes and template renames pass `'report'`. `createExclusive` no longer marks the path failed. | `componentWriteRetry.test.ts`: Retry re-fires a locked theme save and updates the theme list; fails again → kept again; unfixable → reported; deletes leave nothing unsaved; template save retried; a failed exclusive create leaves no mark |
| D31 | The misc scheduler no longer skips a corrupt file's write as saved: `performWrite` throws `CONFIG_CORRUPT` (not retained; one notice per file per session), so save() reports it and a leave keeps a rescue copy. `hotkeys.json` locked at open is no longer marked corrupt: the shortcut changes made meanwhile are recorded, the first write reads the file again (still locked → `EBUSY`, kept for Retry; unreadable → corrupt), and writes those changes over what it holds. | `configLoadFailure.test.ts`: a lock isn't corrupt; locked write kept, then Retry merges; a corrupt file's write reports failed and isn't retried |
| D34 | The three note write channels (`vault:write-file-text`, `vault:create-file-text`, `vault:write-existing-file-text`) answer every failure through `errorResult`, so EBUSY / EPERM reach the note writer as themselves and the write is kept for Retry. The channels are in the `ipc-errors-carry-code` gate (proved to bite on the old handlers). | `noteWriteLockedRetry.test.ts`: EBUSY not IO_ERROR; ENOENT and EEXIST unchanged; the note writer's Retry lands a locked change |
| D39 | `failedVaultPaths` is never trimmed. | `failureReporting.test.ts`: 300 failed paths stay unsaved |
| D40 | `reportError(context, error, message, path?)`. The error bus's aggregator runs `readable`: it keys on context + path, shows the message (or, without one, `readableContext` of the id, e.g. "Board cache: disk full"), and counts repeats of the same file. The note writer, the tag writer and the text-tile seed pass the file. | `failureReporting.test.ts`: two files, two toasts; a repeat counts; no raw ids |

**Verification.** `npm run ci:verify` is green: 669 test files, 6350 tests passed, 5 skipped, 69/69 gates. `vaultCandidate.test.ts` pinned the old whole-slice warning text and now checks the new one. A real-app check (built app, Playwright `_electron`, a scratch vault whose `app.json` had `globalFontSize: 99`, a custom `tabBarScale`, `radarEnabled: false` and an unknown key) confirmed D9:
- At open, one toast named only `globalFontSize`, and nothing was written or copied.
- Picking Sort by → Name first copied the untouched file to `.filo/recovery/<ts>-keep/`, then wrote `app.json` with `globalFontSize` at its default, the new sort, and every other value and the unknown key kept.
- No renderer or console errors.

D10, D31, D34, D39 and D40 are covered by the unit specs above; they were not driven by hand. The new `componentWriteRetry.ts` map carries `allow-no-rename-transfer` (it holds only `.filo/` theme and template paths, which vault renames never move).

**Deviations from the plan**

- **D9:** the backup is taken lazily, at the first write over the file, not at load, so a vault opened repeatedly without a settings change doesn't pile up copies (`-keep` folders are never pruned). Unknown keys are now carried inside all five slices (`defaults.json`'s slices were stripped before too), and the virtual project keeps the salvaged settings rather than re-parsing them with the stripping project schema. Keys at the top level of `defaults.json`, outside the four board slices, are still not kept: no Filo writes any today. The Reload answer of the settings drift prompt now takes a file with an invalid field the same way (salvage, toast, backup before the next write) instead of refusing the reload.
- **D10:** the plan offered "retain or report" as alternatives; both are used, chosen by the caller: saves are retained, deletes and renames (where nothing is left unsaved) are reported. A kept write is fired by Retry (and quit's "Retry now"), not by every Ctrl+S. `createExclusive` doesn't mark or report the path at all: the note it serves (a recreate) keeps its change queued, which already counts as unsaved.
- **D31:** instead of re-trying the hotkeys load on the next write only, a locked load also stops the file being treated as corrupt, and shortcut removals made while it was unread are applied as removals on the re-read file. `createScheduler`'s `shouldSkipWrite` option keeps its unit test but has no production caller now.
- **D34:** no new `LOCKED` code: `errorResult` keeps the errno (EBUSY, EPERM), which the schedulers already treat as retainable. `vault:write-existing-file-text` reports a missing file through the same path (code `ENOENT`, message now the fs error) and no longer logs it as a main-process error.
- **D39:** stopped trimming outright rather than trimming only entries without retained args: every failed path is unsaved work.
- **D40:** the path is passed at the note writer, tag writer and text-tile seed sites, not all 166 `reportError` calls; a report without a path still coalesces by context (latest message, with a count). The write-error aggregator is unchanged (it already names every file).

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

#### Phase 3 status: done (2026-09-28)

All thirteen items are fixed. Each has a regression test, and each test was proved to bite: a script put every old behaviour back in turn (16 mutations, one per item plus a second for T2, T4 and T6) and the matching test failed every time. Decision 2 was taken as recommended, first option: General → Default Board Font Size is the bottom layer of the cascade.

| Item | Fix | Tests |
|---|---|---|
| T1 | New `applyBarColours` (`chromeText.ts`) replaces the App.svelte block. `themeManager` now remembers the value it painted for each variable; `paintChromeOverride` puts a user colour over it, or with the setting blank gives the variable back to the theme (the painted value, else the stylesheet's). Bar text is black / white against the user's colour or a custom theme's; a built-in's bars keep their designed text. `snapshotThemeVariables` takes painted values as painted, so New Theme never captures the user's bar colour. | `themeBarColours.test.ts`: custom theme red bars stay red (System-only too); user colour wins and clearing it restores the theme's; snapshot; built-ins untouched |
| T2 | Every factory (tile, Kanban card and column, task, section, frame, connection label, new Task List board) stops copying sizes; `defaultFontSizes.ts` is deleted. `effectiveStyle.ts` resolves each font size through `generalFontSize` as the layer under the Global Defaults, and `taskListTitleFontSize` does the same for a Task List's group headers. The General button now **clears** every element's own size ("Use Default Font Sizes for all Existing Items"). | `fontSizeCascade.test.ts`: a new tile has no size; Global title 24 renders 24 and follows a change; General-only follows a change; board / element sizes still win; every element kind has the General layer. `applyDefaultsToAll.test.ts` rewritten for clearing |
| T3 | `readThemeFile` gives an unknown `base` Light with a note. The candidate no longer throws: the vault opens, the theme's colours paint over Light, and a warning names the file and the base. | `vaultCandidate.test.ts`, `themeStoreApplyById.test.ts`, `themeFiles.test.ts` |
| T4 | `cleanThemeVariables` keeps only `THEME_TOKEN_NAMES`. New `readThemeFile` / `loadedTheme` put every disk read (`refreshAvailable`, `applyById`, the vault candidate) through the same shape check and filter as an import. `applyCustomTheme` paints only theme tokens. | `themeFiles.test.ts`: hostile `--z-modal` dropped on import, on read and on paint |
| T5 | `ColorPicker` keeps the value's alpha: a picked colour takes it (`parseCssColor` / `formatCssColor` in `color.ts`), and an Opacity slider shows for a translucent value or when asked (`showAlpha`). The theme editor asks for it on the ten translucent tokens (`TRANSLUCENT_TOKENS`). | `colorPickerAlpha.test.ts` |
| T6 | Dark's `--text-inverse` goes from `#2b2b3d` (3.8:1) to `#14141f` (5.0:1). Every hard-coded white on the accent, and every use of the undefined `--accent-on-primary`, now uses `--text-inverse`; the Template Browser's danger button uses `--text-on-danger`. | `themeContrast.test.ts` (text on accent and accent hover ≥ 4.5:1, all 5 built-ins); new `contracts/textOnAccent.test.ts` (no white on the accent, no `--accent-on-primary`) |
| T7 | New `lib/themes/themeEditorGuard.ts`: the mounted editor registers; `settleThemeEditor` asks **Save / Discard / Keep editing**. `confirmDiscardSettings` (Escape, close button) asks it first; the Settings tabs switch through `selectTab`, which asks when leaving Themes (focus-driven switching included, without re-asking when the prompt hands focus back). | `themeEditorSave.test.ts` |
| T8 | The editor's Save calls `selectTheme`. When the pick is cancelled (the colours prompt), the saved theme is not left painted as a preview. | `themeEditorSave.test.ts` |
| T9 | The theme reconciler toasts *The theme "X" was deleted outside Filo, so Filo switched to Light.* | `themeActionsSession.test.ts` |
| T10 | New `setSystemColoursOnly` repaints at once. On: the active theme's chrome over the boards. Off: back to the theme the vault opens with (`project.theme`). | `themeActionsSession.test.ts` |
| T11 | Save refuses, naming each field, while a value box holds a non-colour. A value is now checked as a colour (`isCssColour`, the browser's parser), not only for injection, so a mistyped `#12` is flagged too. | `themeEditorSave.test.ts` |
| T12 | `ColorPicker` takes `id` and `ariaLabel`; each theme-editor swatch is "<row> colour"; Toolbar / Tab Bar Color are `<label for>`; theme cards and custom theme rows carry `aria-pressed`. | `colorPickerAlpha.test.ts` |
| T13 | `themePreview` reads each card's colours from the theme itself (a built-in's stylesheet block, a custom theme's file over its base); custom themes get a small preview too. The Themes tab loses its "Auto" chip and gets its own hint. The Danger zone uses theme tokens. | `themeActionsSession.test.ts` |

**Verification.** `npm run ci:verify` is green: 674 test files, 6394 tests passed, 5 skipped, 69/69 gates. Tests that pinned the old behaviour were updated: `vaultCandidate` and `themeStoreApplyById` (unknown base), `effectiveStyle` (no size anywhere now resolves to the General size), `buildBoardDefaults` (no Task List title seed), `themeManager` (non-token variable), and `taskFontSizeDefaults.test.ts` was deleted with its module. The untrusted-sink contract caught a direct `setProperty` in the first draft of `paintChromeOverride`; it now goes through `applySafeThemeVar`.

A real-app check (built app, Playwright `_electron`, a scratch vault whose active theme was a custom theme based on "solarized", plus a custom "Red bars" theme with red toolbar and tab bar and `--z-modal: -5`) confirmed:
- **T3:** the vault opened, with one warning naming the theme and the base; the theme's accent showed over Light.
- **T1 / T12:** Light, Dark, Blueprint, Retro, Nature and Red bars were each picked from Settings → Themes. Each card was `aria-pressed` once picked. Red bars painted the toolbar `rgb(204, 0, 0)` and the tab bar `#7a0000`; the built-ins painted their own bars.
- **T4:** Settings stayed visible over the app under Red bars; `--z-modal` stayed `3001`.
- **T6:** `--text-inverse` resolved to `#14141f` under Dark.
- **T13:** each card showed its theme's own colours, and the custom rows their own preview.
- **T7:** with an edited colour, clicking General and pressing Escape each asked *Save changes to the theme?*. Keep editing kept the editor; Discard closed Settings and put Red bars back.
- No renderer or console errors.

T5, T8, T9, T10 and T11 are covered by the specs above; they were not driven by hand.

**Deviations from the plan**

- **T1:** the bar text is recomputed only when the bar colour is the user's or a custom theme's. A built-in theme's bars keep the text colours the theme was designed with.
- **T2:** the plan said "Apply defaults to all" already cleared sizes. It stamped the General values onto every element instead, which would hide every later default change, so it now clears them (and is renamed). The Task List title (a board setting) also moved to the cascade: a new board no longer copies it, and its group headers fall back to General → Task List Title. A Kanban card made before this change keeps a copied size on its tile definition, under the card cascade; the card cascade now always resolves a size (General at the bottom), so that copy no longer shows. It was only ever a creation-time copy: a size set in a card's Style popup lives on the placement and still wins. `buildBoardSettingsFromGlobal` keeps its settings argument (a registry API passes it), marked unused.
- **T3:** the plan said "falls back to light". The theme is not dropped: its colours paint over Light and the warning says so. An import with an unknown base is accepted the same way instead of refused.
- **T4:** the plan named `normaliseThemeVariables`, which doesn't exist; the filter is in `cleanThemeVariables`. A theme file that isn't a theme at all (no `variables` map) now counts as a load failure, with the same "invalid JSON" toast as a file that doesn't parse.
- **T5:** both options: picks keep the value's alpha, and the Opacity slider shows for translucent values and for the known-translucent tokens.
- **T6:** no new `--accent-on-primary` token. `--text-inverse` is already the theme editor's "Text on accent", used almost only on the accent, and only Dark's value failed; a second token would duplicate it. The undefined `--accent-on-primary` references are gone.
- **T7:** the plan named `confirmDiscardSettings` for registering dirty state. The editor registers with its own small guard module instead, which `confirmDiscardSettings` and the tab switch both ask.
- **T8:** Save with a cancelled pick keeps the saved file and repaints the active theme.
- **T9:** `appearance.json` still names the deleted theme, so a copy Syncthing brings back returns on the next open.
- **T10:** turning it off repaints the theme the vault opens with, not the one picked while it was on (that pick was for the session only).
- **T11:** also added a real colour check (`isCssColour`); `asSafeThemeValue` only blocks injection, so a mistyped colour was never flagged before.
- **T13:** "use a theme token for the Danger-zone red": red text on the dialogs of Dark, Blueprint, Retro and Nature reads at 2.2–2.5:1 even with the theme's own danger colour. The zone's heading and buttons now use the text colour, marked by a `--accent-danger` rule and borders, with the `--menu-danger-bg` tint on hover. "Relabel the Themes tab": the chip is removed rather than renamed, since neither Auto nor Apply is true of the whole tab; its hint explains both.
- **Not in scope, noticed:** the Mind Map frame factory (`SideToolbar.svelte`) still copies the Global Defaults frame colours into each new frame, the colour version of T2.
- **CLAUDE.md:** the new module is in the tree, `defaultFontSizes.ts` is out, and the cascade and theme sections state the new rules.

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

#### Phase 4 status: done (2026-09-28)

All seven items are fixed. Each has a regression test, and each test was proved to bite: a script put every old behaviour back in turn (16 mutations in the unit tests, 2 in the characterisation spec) and the matching test failed every time. Decision 3 was taken as recommended: every hidden segment is ignored, except Filo's own `.filo/` rules.

| Item | Fix | Tests |
|---|---|---|
| S1 | New `hasHiddenSegment` (`shared/pathUtils.ts`). `shouldIgnorePath` ignores any path with a segment starting with a dot, outside `.filo/` (which keeps its own rules). The reconcile walk skips every hidden entry, not only `.git*` and the root `.filo`. `vaultIndex.applyChanges` skips hidden paths too. | `watcherSyncEdges.test.ts`: the ignore rule; a create under `.stversions/` is never reported; a note archived into `.stversions/` is not paired as a rename into it. `openTagPruneAndHiddenIndex.test.ts`: a `.stversions` note is not indexed and adds no tag. `syncedVault.test.ts` (characterisation): an archived version arriving while open adds no tag to the Tags browser |
| D2 | New `stores/openTagHousekeeping.ts` (`tidyTagsAfterOpen`), moved out of `vault.svelte.ts`. The prune waits for the recovery prompts (the rename-cascade Retry moves the tags first), and spares every path an unfinished rename named when the vault opened (`namedByPendingRename`), whatever the prompt's answer. The sentinel is read before the prompts start, so a Discard can't hide it. The tag-rewrite prompt's Discard prune spares them too. | `openTagPruneAndHiddenIndex.test.ts`: nothing pruned while the prompts are open; afterwards a gone file's entry is dropped and the pending rename's is kept; `namedByPendingRename` matches both sides, children, case-folded |
| D5 | `classifyChange` makes any other file with an extension an `attachment` (`isAttachmentByExtensionOnly`). The walk now caches every file's size, not only a hashed one's: without it an attachment's old side had no size, and the correlator's cold-cache rule refused every attachment pair. An `attachment` event for a path that is, or was, a folder (`v1.2`) goes out as `tree` (`knownDirs`). The attachment reconciler already prompts only when a tile points at the file. | `watcherSyncEdges.test.ts`: classification; an outside move of `Report.docx` pairs; a dotted folder goes out as `tree`. `syncedVault.test.ts`: a tagged `Report.docx` moved by another program keeps its tag at the new path |
| D4 | Before correlating, a notify pass re-hashes every present file whose hash is cached, so a later move compares current content. | `watcherSyncEdges.test.ts`: a small note edited by another program (live event, no walk), then moved, pairs |
| D11 | Notify passes are chained (`notifyChain`); `stop()` awaits the tail. Unpaired missing attachments are held like notes (`MISSING_NOTE_HOLD_MS`), so a move split across two passes pairs. | `watcherSyncEdges.test.ts`: three passes never overlap; an attachment delete and create in two passes pair |
| D15 | The walk keeps a file's hash without reading it when size, mtime, change time and inode all match the last walk's and the mtime was already more than 5 s old then (`TRUST_STAT_AFTER_MS`). A younger file is still read every walk. | `watcherSyncEdges.test.ts`: an old unchanged note isn't re-read; a young note is; a same-size rewrite that puts the old mtime back is still reported |
| D16 | `vaultRegistry.armedAt` records when a vault was armed (`vault:init-config`, the open's first IPC); a same-path re-arm keeps it. `vault:watch` passes it to the watcher, whose seed walk reports every note, board and reconciled `.filo/` config whose mtime or change time is at or after it (`changedSinceEvents`). | `watcherSyncEdges.test.ts`: a board changed after the vault was armed is reported, one from before and media aren't; no start time, no report; `armedAt` moves on arm, not on re-arm |

The reconcile walk moved to a new `main/services/fileWatcherWalk.ts`, since `fileWatcher.ts` would otherwise have crossed the 1000-line gate. `vault.svelte.ts` shrank from 1572 to 1541 lines and its gate ceiling follows. The new characterisation spec is registered in the `characterisation-suite` gate.

**Verification.** `npm run ci:verify` is green: 677 test files, 6414 tests passed, 5 skipped, 69/69 gates (the first run's `board-path-casefold` gate caught a `.board.json` compare on a lower-cased copy rather than an inline `.toLowerCase()`; fixed and the gates re-run). No existing test had to change.

A real-app check (built app, Playwright `_electron`, a scratch vault with `Note.md` tagged `real`, a `Report.docx` tagged `work` in `tags.json`, and an archived `.stversions/Note~….md` tagged `ghost` holding the same word) confirmed:
- **S1:** a search for the shared word found 1 result, not 2. A second archived version written while the vault was open added no tag: the Tags browser listed `real` and `work` only.
- **D5:** `Report.docx` moved to `Archive/` by another program; `tags.json` then keyed `archive/report.docx` only.
- **D4:** with `Note.md` open in a Document tab, another program edited it, then 2 s later moved it to `Moved/`. No "deleted" prompt or other toast appeared, the editor showed the edited text, and nothing was written back at the old name.
- No renderer or console errors.

D2, D11, D15 and D16 are timing- or crash-dependent and are covered by the specs above; they were not driven by hand.

**Deviations from the plan**

- **S1:** dotfiles are ignored as well as dot-folders (the sidebar tree skips both).
- **D2:** both options, not one: the prune runs after the recovery prompts *and* spares the sentinel's paths. The plan's second trigger, Syncthing delivering `tags.json` before the renamed media while this machine opens the vault, has no sentinel on this machine and can't be told from a real delete; it is written up as KNOWN_LIMITATIONS #35. The tag-rewrite prompt's Discard, which also pruned before the rename prompt, got the same guard.
- **D5:** the plan said "every non-`.md`, non-board, non-`.filo` file". A name with no extension (`LICENSE`) stays `tree`, because from the path alone it can't be told from a folder; KNOWN_LIMITATIONS #31 says so. Also needed, and not in the plan: the walk caching every file's size (without it no attachment moved outside `attachments/` could pair, even before this change), and the folder check.
- **D4:** the plan offered "invalidate or re-hash"; it re-hashes, so a small note (under the 256-byte size-only floor) still pairs. An edit and a move that land in the *same* pass still can't pair (the old bytes are gone before they can be read); the move then shows as a delete plus a create, as before.
- **D11:** also extended the missing-file hold from notes to attachments, which the plan didn't name, so a split attachment move pairs; `heldMissing` needs no merge once passes can't overlap.
- **D15:** the plan said "only when mtime or size changed". That alone would have lost the reason the walk hashes (a same-size rewrite within one coarse timestamp tick on FAT / SMB), so a stat is trusted only once the mtime is safely in the past, and change time and inode must match too.
- **D16:** the plan said "compare the seed stats with the candidate-load baselines". Themes and templates have no baselines, so the watcher instead reports files changed since the vault was armed; each reconciler already treats an unchanged file as a no-op. The change time counts too, since Syncthing gives a downloaded file the other machine's mtime.
- **Real-app check:** no second Syncthing machine was available; see Verification for what was driven by hand.

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

#### Phase 5 status: done (2026-09-28)

All nine items are fixed. Each has a regression test, and each test was proved to bite: a script put every old behaviour back in turn (17 mutations: one per item, a second for D14, D22, D24 and D25, and one each for the two follow-ons below) and the matching test failed every time. Decision 4 was taken as recommended: a block with a recoverable error reads its keys, and the writer keeps refusing to patch it.

| Item | Fix | Tests |
|---|---|---|
| CH1 | `parseMarkdownFile` takes its object from `parseFrontmatterObject`, the index's reader, so a duplicate key or a tab indent reads the same open as closed. The assembler's keep-raw check also falls back to `rawFrontmatter` when a caller passes no baseline, so a block that now reads keys can never be dumped over. | `noteWritePathEdges.test.ts`: both readers agree on a duplicate key and a tab indent; a delta is refused with the block kept; a body save keeps it. `frontmatterSafety.test.ts` (characterisation): the open note shows the duplicate-key note's tags |
| D20 | `withDiskBody`'s no-frontmatter branch passes the disk body through `bodyWithoutFenceLookalike`. | `noteWritePathEdges.test.ts`: removing a scene-break note's last key writes `***` and reads back with no frontmatter |
| D21 | A body save under an unchanged block (`withDiskFrontmatter` in `noteFile.ts`) keeps the BOM and the block's bytes as read (fences, trailing spaces, the block's own line ending, an empty block) and writes only the body, in the file's ending. | `noteWritePathEdges.test.ts`: empty block, `---  ` fences, CRLF block over an LF body, a file ending on its fence, a BOM, a CRLF body |
| D22 | `vault:convert-to-utf8` refuses a link, reads stat then bytes (a mismatch is `STALE`), backs up exactly those bytes (`snapshotForRecovery` takes them), and writes with `expectExisting`, `expectStat` (with the bytes' hash), `refuseLink` and `withOnDiskSpelling`. The renderer names `STALE` and `NOTE_IS_LINK` in its toast. | `staleWriteContentCheck.test.ts`: another program's same-size save between the read and the backup is left on disk, and the backup holds the converted bytes |
| D24 | `writeTagChangeToMarkdownPath` rejects with the new `ChangeRefusedError` when the rewriter refused the frontmatter, the note isn't UTF-8 or is a link, or an edit of it is unsaved. The tag commands return the write, and the history store shows the message and takes the step off the stack (execute) or leaves it in place (undo / redo). The Document tab's tag row, which sends a frontmatter delta, checks first (`noteFrontmatterProblem`) and queues nothing. The writer and the views share one wording (`lib/notes/frontmatterRefusal.ts`). | `noteWritePathEdges.test.ts`: malformed, non-UTF-8 and link notes reject; a note that already says so doesn't; the command leaves the stack with a toast. `frontmatterSafety.test.ts`: the tag row's refusal leaves the file and no undo step |
| D25 | `setBody` returns `missing` for a missing note (the Task List notes box keeps its draft and says so). The writer treats a body with no base as drifted unless the disk body already matches it, so it becomes the conflict prompt. | `noteWritePathEdges.test.ts`: a missing note takes no body; a body with no base meets a downloaded file as a conflict, and the file is untouched |
| D35 | `NoteEditorView.serialize` clears `unserialised` only after the body reached the store; a throw keeps it and reports it with the note's name. | `noteWritePathEdges.test.ts`: a failing serialiser leaves the keystrokes counted as unsaved |
| D14 | Both halves. The note writer remembers only its latest write per note, so an older write of ours that shows up again is someone else's restore and is taken. The main-process watcher kept the last four writes' bytes as echoes for 7 s, which hid that restore until the next 30 s scan; a write that has landed (`recordOwnWrite` → `recordLandedBytes`) now replaces the list, so only it (and a write still out) counts. | `noteWritePathEdges.test.ts`: V1 → V2 → another program puts V1 back → the note shows V1. `watcherOwnWriteBytes.test.ts`: the landed rule, and a watcher that reports the restore |
| D26 | `expectStat` carries the read's FNV-1a hash; before every rename attempt `atomicWriteFile` also compares the bytes of a file up to 2 MB (`stillHoldsHash`). A larger file keeps the stat check alone: KNOWN_LIMITATIONS #36. | `staleWriteContentCheck.test.ts`: a same-size save that kept the stat is refused (directly and through `vault:write-existing-file-text`) |

**Follow-on found by the full run.** With D25 in place, `honestSaveState.test.ts` (a note renamed by another program while its save is reading) failed: the rename moves the note's model to the new path, so the flush still running for the old path found no base and held the body as a conflict. It used to fall through to a write that failed `ENOENT` and was forgiven. The flush now stops as soon as it sees its queue entry moved or dropped while the read was out; the change is already armed at the new path.

**Verification.** Lint, `svelte-check`, `typecheck:main`, `ci:test-typecheck`, the build and all 69 gates pass. The last `npm run ci:verify` ran 679 test files: 6436 passed, 5 skipped, and 2 failed on timing (a 100 ms window in `fileWatcherReconcile.test.ts`, a 5 s timeout in `recoverySnapshotKeep.test.ts`). The machine was under heavy load from other applications (the runs took 270–390 s against 177 s earlier), and three earlier runs each failed a different 2–5 watcher or snapshot timing tests. Every file that failed passes when run alone, and none of those tests exercises the changed code. Two tests had to change because they pinned the old behaviour: `markdownSync.test.ts` (a tab-indented block now reads its keys) and `noteWriterSyncSafety.test.ts` (the expected stat now carries `hash`).

A real-app check (built app, Playwright `_electron`, a scratch vault) confirmed:
- **CH1 / D24:** `Dup.md` (duplicate `title:`) showed its tag `alpha` in the Document tab. Adding `beta` showed the malformed-frontmatter toast; the file was byte-identical and Undo stayed disabled.
- **D21:** typing in `Empty.md` (`---\n---\nold text`) saved `---\n---\nold text plus more\n`.
- **D14:** after saves "Start one" then "Start one two", another program put the first version back. Within 3 s the editor showed "Start one", with no prompt and nothing written back.
- **D22:** Convert to UTF-8 on a Windows-1252 note wrote `Réunion — café`; the `-keep` backup held the original bytes.
- No renderer or console errors.

D20, D25, D26 and D35 are covered by the specs above; they were not driven by hand.

**Deviations from the plan**

- **CH1:** as well as sharing the reader, the assembler's keep-raw check now also uses `rawFrontmatter` when no baseline is passed. No production caller omits the baseline, but the change means a block that now reads keys can't reach the full-dump fallback.
- **D21:** the plan named `emitWithRawFrontmatter`. The block is kept in `assembleNoteText` instead (`withDiskFrontmatter`), which has the fresh read's bytes; `emitWithRawFrontmatter` only sees the YAML between the fences.
- **D22:** also refuses a symbolic link up front, and a read whose byte count differs from the stat taken before it.
- **D24:** the plan named the tag writer; the Document tab's tag row sends a frontmatter delta instead (`UpdatePropertiesCommand`) and had the same leftover undo step, so it checks the note first. That needed a harness reader for the toolbar's Undo button (`undoAvailable`). Other frontmatter commands (Kanban / Task List fields) still rely on the writer's toast, which leaves their step on the stack: not in this finding.
- **D25:** a body with no base whose text already matches the disk body is not a conflict. The follow-on above was needed.
- **D14:** the plan offered "latest hash only" or "within the suppression window"; latest only, and the list of recent hashes became one entry per note. The real-app check showed the main-process watcher also hid the restore (it kept four recent writes as echoes), so the watcher now forgets a write's bytes once a later one lands. The plan named only the renderer side.
- **D26:** did the optional hash check, not only the documentation. The limit is 2 MB; KNOWN_LIMITATIONS #36 covers larger notes.
- **Line budget:** `notes.svelte.ts` is at 1000 lines, the gate's limit, after folding the D25 check into the existing status checks. Phase 8's split (CH12) is now needed before anything else is added there.

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

#### Phase 6 status: done (2026-09-28)

All nine items are fixed, each with a regression test. A script put every old behaviour back in turn (15 mutations: D13 ×3, D12 ×3, D33 ×3, one each for D43, D42, D32, D38, D23 and D36) and the matching test failed every time.

| Item | Fix | Tests |
|---|---|---|
| D33 | Quit uses the leave's save (`saveUntilSettled` in `vaultLeaveGuard.ts`): it releases the focused field, saves, runs the component flushes, waits for queued reconciles, and saves again while `unsavedWork()` isn't empty. `handleFlushAndQuit` takes `freeze` (wired to `holdCloseDrainUntilSwap`; thawed only when the user stays) and `nothingUnsaved` (`isUnsavedWorkEmpty(unsavedWork())`). The quit goes ahead only when that check passes as well as the save. `noteWriter.flushAll` drains again (up to 5 passes) while a timer armed during its own await is set. | `vaultLifecycleQueueEdges.test.ts`: the quit asks when work is left though the save said ok, and thaws on Stay open; a quit that goes ahead stays frozen. `noteWriter.test.ts`: flushAll drains a change queued while it was out |
| D12 | The leave waits for the rename queue (`settleRenameQueue`) before its last check. One `leftBehind` pre-swap handler (in `vaultLeaveGuard.ts`, after `tabs`, before the schedulers are cancelled) copies everything still unsaved when a vault is let go as saved (notes, boards, `.filo/` state) to `.filo/recovery/`, posts the rescue notice and sets the sentinel. The tracking reset then leaves the sentinel set when work is left. | `vaultLifecycleQueueEdges.test.ts`: a board write a reconcile queues during the save gets a second save, with no dialog. `leaveLastLine.test.ts`: a queued `tags.json` write is copied as `_filo__tags.json`, not fired into the swap, and the sentinel is never deleted |
| D13 | `retireVaultGeneration()` (`vaultIdentity.ts`) runs in `openVault` / `closeVault` right before `fireVaultSwap`. Work captured before it reads as stale. The rename queue (now `stores/vaultRenameQueue.ts`) skips every task while the vault is retired or tearing down. | `vaultLifecycleQueueEdges.test.ts`: the retire window; a task queued before or during the leave doesn't run. `vaultSwapResets.test.ts`: retire comes before `fireVaultSwap`, reset after |
| D43 | `refreshTree` returns false for a read that lands after the vault changed, without applying it. `refreshTreeAndCleanup` also stops after a folder-move replay that saw a swap. | `vaultLifecycleQueueEdges.test.ts`: a tree read that lands after the swap isn't applied |
| D32 | `persistNewBoard` captures the identity before `board:create`. If the vault was let go meanwhile, it returns false; the file stays on disk for that vault. | `vaultLifecycleQueueEdges.test.ts` |
| D36 | `openConfirm` queues a confirm asked for while another shows; it shows once the first is answered (`closeConfirm` shows the next). Nothing is answered for the user. Esc cancels only the dialog on screen. A vault swap still cancels the dialog on screen and every queued one, so no awaiter hangs, and D13's retire makes the vault-guarded recovery Cancels do nothing. | `confirmDialogDisplaced.test.ts` (rewritten): the queue, its order, Esc, the swap |
| D23 | `noteWriter.hold` treats every path as a folder too. It flushes and enters the queue of every note under it that has a change queued or an operation running. Any other note under it waits in `onPath`, which checks the holds right before an operation starts. `noteStore.hold` serialises the views of the notes under it. `renameVaultPath` / `trashVaultPath` / `restoreTrashed` pass every path, not just `.md`. | `noteWriter.test.ts`: a note in the folder with nothing queued waits until the move is done; a note outside doesn't |
| D38 | Each scheduler registers an armed-path check (`registerArmedPathSource`): a timer set or a fire parked for the path. `endWrite(success)` and `dropPendingPath` leave a path pending while one is armed. The scheduler takes an entry out of its armed set before it releases that entry's path (reschedule, reset, a parked fire). | `vaultLifecycleQueueEdges.test.ts`: a write that lands while a newer one is armed leaves the path pending until the newer one lands |
| D42 | `takeFolderMoves(tree, root)` keeps only the moves that still hold in the tree just read. | `folderPins.test.ts`: moved back, moved on, still moved |

**Verification.** `npm run ci:verify` passed: lint, `svelte-check`, `typecheck:main`, 680 test files (6453 passed, 5 skipped), the build, and 69/69 gates. `ci:test-typecheck` passes. Two tests were then tightened and re-run: the `leaveLastLine` sentinel assertion (it missed the delete's absolute path, which the mutation run caught) and one new test in `vaultLifecycleQueueEdges`.

A real-app check (built app, Playwright `_electron`, two scratch vaults) confirmed:
- **Quit right after typing:** the text was on disk, with no `.dirty` sentinel and no `-unsaved` folder. Reopening showed no recovery modal.
- **Ctrl+O to another vault right after typing:** the text was on disk, and the vault had no sentinel or rescue folder. Switching back showed no recovery modal, no confirm and no toast.
- **Another program moved `Folder` away and straight back:** nothing was replayed (no `Moved/`, tree unchanged), and an edit to `Folder/In.md` afterwards saved in place.
- No renderer or console errors.

**Deviations from the plan**

- **D33:** the quit still also requires the save indicator not to be in `error` / `attention`: both checks, not `unsavedWork()` alone, because a reported-only failure isn't in `unsavedWork()`. The flushAll re-drain is capped at 5 passes.
- **D12:** instead of a rescue in each board / config handler, one `leftBehind` handler copies everything through the existing `keepRescueCopies`. It replaces the note-only `keepLeftBehind`, and `lib/notes/leftBehind.ts` is deleted. The handler order is now `tabs` → `leftBehind` → `boardWriteScheduler` → `writeStateTracking`, so the schedulers are now cancelled after the tabs reset (before, registration order decided). The `writeStateTracking` reset clears the sentinel only when nothing is left.
- **D13:** chose the generation bump, not the tearing-down flag. The rename queue checks both, plus the retire window, which lasts until the next commit (the flag drops when the pre-swap handlers end). The rename queue moved to `stores/vaultRenameQueue.ts` to make room in `vault.svelte.ts` (1541 lines, its ceiling). Its ceiling is now 1523.
- **D36:** every confirm is queued, not only the startup prompts. The swap cancelling a recovery prompt is made harmless by D13's retire rather than by skipping it.
- **D23:** the plan's prefix hold over `pending` and the models also got a check in `onPath`. That covers a note under the folder that had nothing queued when the hold began.
- **D38:** took the plan's second option (leave the key while armed), applied to `dropPendingPath` too. The Task List notes box (`noteStore.writeBody`) dropped the path while the writer had it armed, which was the same bug.
- **D42:** checked against the tree just read (the reconcile's source of truth), not a new stat.
- **D43:** also stops the folder-move replay loop after a swap.
- **Line budget:** `notes.svelte.ts` is still at 1000 lines (4 removed, 4 added). Phase 8's CH12 split is still needed before anything else goes in.

### Phase 7: smaller runtime fixes (D18, D19, D28, D41, R1)

1. **D18.** The timer stores a wall-clock `endsAt` while running (schema: optional). The remaining time is computed from it on mount. Drop the 45 s coarse persist, or keep it only for display on another machine.
2. **D19.** Unreadable-note retries back off (2 s, 10 s, 60 s, then stop until the next watcher event).
3. **D28.** `vault:write-file-text` refuses `.md` / `.markdown` targets in main. Only sentinel paths may use it. Confirm how the sentinels pass `assertNotInFiloDir`.
4. **D41.** When the trash-side unlink fails after a hard-link restore, mark the manifest entry "restored, copy left in trash" so the list doesn't offer a second restore.
5. **R1.** Fix the `fileBaselineRegistry` comment and the CLAUDE.md line, or keep `writeSeqs` across swaps so the documented invariant is true.

#### Phase 7 status: done (2026-09-28)

All five items are fixed, each with a regression test. Each test was checked against the old behaviour (the fix reverted or broken on purpose) and failed every time.

| Item | Fix | Tests |
|---|---|---|
| D18 | A running countdown is stored as its wall-clock end, `endsAt` (epoch ms; optional on `TimerTileSchema`, `TimerTileDefSchema` and `InlineTileSchema`). The time left is computed from it on every tick and on mount (`lib/utils/timerCountdown.ts`). Nothing is written while it runs. The tile is written on Play (sets `endsAt`), on Pause, reset, mode change and duration change (clears it, keeping `remaining`), and when it reaches zero. The 45 s coarse persist (`coarsePersistGate.ts`), the unmount save and the timer's component flush are gone: there is no unsaved progress left to save. A board saved as running with no `endsAt` gets one stamped when it is first shown. `UpdateTimerConfigCommand` snapshots carry `endsAt`, so undoing a reset of a running timer resumes it where real time has taken it. | `timerCountdown.test.ts`: the helper; the Mind Map tile op saves and clears `endsAt`; the tile read back keeps it. Characterisation `leavingKeepsHeldChanges`: the board isn't rewritten while the timer runs, and after another board replaces it the saved countdown keeps going down |
| D19 | An unreadable note is read again after 2 s, 10 s and 60 s (`TRANSIENT_RETRY_DELAYS_MS`), then left alone until its next watcher event, which starts the retries again. A successful read or ENOENT cancels them. | `vaultIndexRetryBackoff.test.ts`: the reads over an hour with fake timers, the restart on a watcher event, and the stop once readable |
| D28 | `vault:write-file-text` refuses every path except this machine's crash-recovery sentinels, in main (`assertSentinelWriteTarget` in `pathSecurity.ts`, `FORBIDDEN`). The sentinels passed `assertNotInFiloDir` through `isPermittedSentinel` (a write only for this machine's id). The new check uses the same test, so the three sentinel writers (`dirtyFlagRecovery`, `renameCascadeSentinel`, `tagRewriteSentinel`), which are the channel's only callers, are unchanged. | `vaultWriteFileTextSentinelOnly.test.ts` (real handler, temp dir): an existing note keeps its bytes; no `.md`, `.markdown`, other file or folder is created; `.filo/app.json` and another machine's sentinel are refused; this machine's three sentinels are written. `readFileNonUtf8` / `symlinkNoteWrite` now expect `FORBIDDEN` from this channel |
| D41 | When a hard-link restore can't unlink the trash-side copy, the manifest is marked `restoredTo: <path>`. The Trash list shows the entry as "restored to …; a copy was left here" with Restore disabled. `restoreFromTrash` refuses it (`TrashAlreadyRestoredError`, reported as `TRASH_ITEM_MISSING`, so an undo still sees the file is back). `trashStore.entryHolding` skips it. Emptying the trash clears the copy as before. | `trashMain.test.ts`: a locked trash copy (an `unlink` seam in `RestoreHooks`) is marked, isn't restored a second time (no `Plan (restored).md`), and a purge clears it while `Plan.md` stays |
| R1 | Made the documented invariant true. A vault swap clears `writeSeqs` and takes a new floor from the never-resetting counter, and a path with no entry reads as that floor. So no ticket taken before a swap can match afterwards, including one for a path never written (before, that read as `0` on both sides of the swap). The comment and the CLAUDE.md line now say so. | `fileBaselineDrift.test.ts`: a ticket taken before a swap stamps nothing after it, for a written and an unwritten path; a ticket taken after it stamps as usual |

**Verification.** `npm run ci:verify` passed: lint, `svelte-check`, `typecheck:main`, 683 test files (6461 passed, 5 skipped), the build, and 69/69 gates.

**Deviations from the plan**

- **D18:** Decision 6 as recommended (timers keep running while their board is closed). The coarse persist was dropped rather than kept for display on another machine: the stored end time already gives every machine the same countdown. Two additions:
  - Changing the mode of a running timer now stops it at the time it had left, not at the value last saved.
  - A countdown that ran out while its board was closed stops quietly the next time the board is shown (display at zero, no toast). A toast then, possibly at vault open, wouldn't say which timer it was. This is a `// DECISION:` comment in `TimerTile.svelte`.
  
  Machines whose clocks disagree will disagree on the time left by the same amount.
- **D28:** narrower than "refuse `.md` / `.markdown`". The channel refuses every path that isn't this machine's sentinel, as the plan's second sentence asks. Its note-only checks (non-UTF-8, symbolic link) stay in the handler as defence; the gates inspect them.
- **R1:** a third option. The plan's "keep `writeSeqs` across swaps" would let a pre-swap ticket for a written path match its old entry after the swap. So the entries are still cleared, and a per-swap floor closes the gap for unwritten paths.

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
- **Phase 2:** done 2026-09-28 (status block under Phase 2).
- **Phase 3:** done 2026-09-28 (status block under Phase 3).
- **Phase 4:** done 2026-09-28 (status block under Phase 4).
- **Phase 5:** done 2026-09-28 (status block under Phase 5).
- **Phase 6:** done 2026-09-28 (status block under Phase 6).
- **Phase 7:** done 2026-09-28 (status block under Phase 7).
- Phase 8: not started.

When a phase lands, add a "Phase N status" block (fix, tests, verification, deviations) as in Audit-22. When every phase is done, move this file to `docs/archive/`.

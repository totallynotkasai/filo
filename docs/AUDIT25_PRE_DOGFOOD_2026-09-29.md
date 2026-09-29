# Audit-25: pre-dogfood audit (2026-09-29)

Audited: `main` @ 73cb12a (all of Audit-24 included).
Owner's setup: Windows 11, Syncthing on one machine, no other editors, all four board types, 500–5,000 notes.
Status: Phases 1–8 of the [implementation plan](AUDIT25_IMPLEMENTATION_PLAN_2026-09-29.md) are done (2026-09-29); Phase 9 (single newlines and literal asterisks, found on the owner's own vault) is open. See "After remediation" below the ratings.

## Verdict

Filo is safe to use for its data. In normal use I found no way to lose or corrupt a note, board, tag or setting:

- Every note write is applied to a fresh read of the file and checked in the main process before it lands.
- Deletes go to Filo's trash.
- Changes made outside Filo are either taken in or asked about.
- A note Filo can't save faithfully opens read-only rather than being rewritten.

The real-app checks backed this up, including a 5,000-note vault that Filo opened, browsed and quit without changing a single byte, and a Syncthing simulation where every case behaved correctly.

The weak spots are elsewhere:

- **The editor writes some ordinary formatting in a form it can't read back.** Examples: a checklist with an empty last item, a paragraph indented with spaces, a `|` in a table cell. The note then opens read-only on the next visit. Nothing is lost, but it will happen in the first week.
- **The Kanban board has a display bug and a scale problem.** After one plain click on a card, the columns stop showing new or moved cards. Boards with about 100 or more cards also pause on every open.
- **A handful of smaller metadata and UI bugs**, listed below.

Fix Phase 1 before relying on Filo day to day, or start now with the workarounds in the "If you start now" section.

## Ratings (1–10)

| Area | Score | Why |
|---|---|---|
| Notes: write safety | 9 | Fresh read per write, main-side stat/hash compare-and-swap, one conflict prompt, byte-exact frontmatter, trash for deletes. Nothing written by merely looking, even at 5,000 notes. |
| Boards: write safety | 8.5 | Forward-only drift baselines, the held-decision design from Audit-24 Phase 9 holds up. Edge gaps A25-16/17/19. |
| Sync and outside changes | 9 | Real-app Syncthing simulation passed every case (below). |
| Open / close / quit / crash recovery | 8 | Very thorough save-before-leave. Windows shutdown bypasses it (A25-15, low). Quit while minimized still saves. |
| Error handling and messages | 7 | Failures are kept and named. Some messages are wrong or overwhelming (A25-23, A25-25, A25-18). |
| Document editor and Markdown fidelity | 5 | The read-only guard is honest and nothing is lost, but everyday formatting trips it (A25-01..04, A25-14). |
| Undo / redo | 8 | Careful per-board stacks, delta undo, rename-following. Tag-rename undo is the exception (A25-09). |
| Mind Map | 7.5 | 400 tiles open in 0.13 s and pan smoothly. Minor selection edge cases. |
| Kanban | 4.5 | Click bug (A25-05), freezes with many cards (A25-06), Lock does nothing, text-form tags break it. |
| Task List | 7 | 400 tasks open in 0.3 s. Fields blank for ~4 s after opening a big vault (A25-07); notes-box newlines (A25-04). |
| Tags and search | 6.5 | Search is fast (0.1 s at 5,000 notes) and ignores `.stversions`. Tag undo, autocomplete and Replace All have sharp edges. |
| Settings and themes | 7.5 | Apply / Revert discipline is good. Not re-checked in depth this time. |
| Performance at 5,000 notes | 7 | Measured: sidebar 0.2 s, search 0.1 s, Mind Map and Task List fine. Kanban is the outlier. |
| UI polish and accessibility | 6 | Good keyboard and reduced-motion handling. Confusing read-only banner, a false "Overwrite" dialog, jargon in toasts. |
| Code health and tests | 8.5 | 6,803 unit/component/characterisation tests, 79 gates, CI green. The E2E suite still needs its rewrite; stale comments and some dead code. |
| **Overall** | **7** | Data integrity is about 9. Day-to-day usability is about 6 until Phase 1 lands. |

### After remediation (Phases 1–8, 2026-09-29)

Scored after the plan's Phase 8: `ci:verify` green (89 gates), the built-app E2E suite green (scale budgets included), and a real-app pass on a copy of the owner's vault.

| Area | Audit | Target | Now | Why |
|---|---|---|---|---|
| Notes: write safety | 9 | 9 | 9 | Unchanged design. Opening every note of the owner's vault and 1,000 generated ones, then quitting, changed no byte (E2E `noBytesByLooking`). |
| Boards: write safety | 8.5 | 9 | 9 | A25-16 / 17 fixed. Showing a Task List no longer rewrites its file. A25-19 deferred (KNOWN_LIMITATIONS #15). |
| Sync and outside changes | 9 | 9 | 9 | The Syncthing cases are now E2E specs, and the held decision was checked on the owner's vault. |
| Open / close / quit / recovery | 8 | 8.5 | 8.5 | Windows shutdown saves and keeps rescue copies (A25-15). Config drift no longer blocks the writer (A25-18). |
| Error handling and messages | 7 | 8.5 | 8.5 | Plain-language toasts (gate), the read-only banner names the line and offers the Raw view, one validation message per board. |
| Document editor and Markdown fidelity | 5 | 8.5 | 7 | Everything Filo writes now reads back (property test, 500+ documents). But **5 of the owner's 13 notes open read-only**: single newlines and literal asterisks (plan N14 / N15, Phase 9). |
| Undo / redo | 8 | 8.5 | 8.5 | Tag-rename undo touches only what it changed (checked on the owner's vault); Replace All undo from its toast. |
| Mind Map | 7.5 | 8 | 8 | Selection and hit-test lows fixed. |
| Kanban | 4.5 | 8.5 | 8.5 | The click bug is gone, 300 cards open in 0.4 s, lock and text-form tags work, and a long column's Add Card is reachable (fixed in Phase 8). |
| Task List | 7 | 8.5 | 8.5 | Fields are right 0.6 s after the rows appear, a recurring task ticked at once rolls forward, and the subtask hierarchy lives on the board. |
| Tags and search | 6.5 | 8 | 8 | Merge detection, autocomplete, Replace All Match case / Whole word and the count are fixed. |
| Settings and themes | 7.5 | | 7.5 | Not re-audited. |
| Performance at 5,000 notes | 7 | 8.5 | 8.5 | All budgets met on the final build (plan, Phase 8 table). |
| UI polish and accessibility | 6 | 8 | 7.5 | An axe scan of every view runs in E2E. Board Browser row structure (N12) and tertiary text contrast (N13) are open (KNOWN_LIMITATIONS #46, #47). |
| Code health and tests | 8.5 | 9 | 9 | 7,100+ unit / component / characterisation tests, 89 gates, and an E2E suite that drives the built app (it found five app bugs on its first runs). |
| **Overall** | **7** | **8.5** | **8** | Data integrity about 9. Day-to-day use about 8, held back by read-only notes on the owner's real vault until Phase 9. |

## How this was audited

- **Baseline.** `npm run ci:verify`: lint, svelte-check, main typecheck, 6,803 tests (723 files), build, 79/79 gates. All green.
- **Finder A** (data integrity and write paths), **Finder B** (features, undo, UI, legacy code), then a **refuter** agent that tried to knock down every finding and re-ran the editor probes itself. Finder B also started four helper agents of its own, beyond the agreed two finders and one refuter.
- **Real app.** The built app was driven with Playwright against scratch vaults; scripts are in the session scratchpad `realapp/`. That covered:
  - a generated 5,000-note vault (nested folders, frontmatter, CRLF and BOM notes, a 4,000-paragraph note) and boards filled with 300 Kanban cards, 400 tasks and 400 Mind Map tiles;
  - a Syncthing delivery simulation;
  - quit-while-minimized;
  - reproductions of every high finding.

Two things looked like bugs and were not:

- A "1-second-per-frame freeze" was the test window being minimized, which Windows throttles. With the window visible, frames took 0–5 ms.
- A "hung" Syncthing test was my script waiting on Filo's correct "Waiting for your decision" dialog.

## Findings

Severity is after the refuter's review. "App" means reproduced in the built app. "Probe" means reproduced with the real code in a scratch test.

### High: you will likely hit these in the first week

**A25-01 · Checklists and space-indented paragraphs reopen read-only** (App, Probe)
- **What happens:**
  - A checklist with an empty item at the end, which is what pressing Enter after the last task leaves, is saved as `- [ ] `. On the next open the note shows the read-only banner "Filo can't save this file without changing formatting it doesn't support", with a literal `[ ]` in the text.
  - Turning one bullet of a list into a checkbox (Ctrl+Shift+9) does the same, and adds a phantom empty checkbox.
  - A paragraph that starts with spaces does the same. The refuter found that 1–2 spaces are enough; 4 spaces turns it into a code block.
- **Effect on you:** nothing is lost, but the note is frozen until you fix it. The only button, **Take ownership**, makes it worse: the empty box becomes the text `\[ \]`, and the indented paragraph becomes a code block. The Raw view can fix it by hand.
- **Where:** `lib/editor/createEditor.ts:308-312` (TaskList/TaskItem use tiptap-markdown's parser); lossy check `markdownSync.ts:205-215` → `noteEditorView.ts:206`; `tabNode.ts` escapes a leading tab but nothing escapes leading spaces.
- **Fix:**
  - Parse `- [ ]` with no text as an empty task.
  - Parse mixed bullet/task lists without the filler item.
  - Escape leading spaces, or strip them on input.
  - Add these to `markdownBodyRoundTrip` and `toolbarFormattingRoundTrip`, which today test list toggles only on a lone paragraph.

**A25-02 · A `|` or a list inside a table cell breaks the table** (App, Probe)
- **What happens:** typing `yes|no` in a cell saves `| one yes|no | two |`. On reopen the table is one paragraph of pipes and the note is read-only. A list in a cell writes broken rows. Headings, code blocks and alignment inside cells are dropped silently.
- **Effect on you:** a table you built looks destroyed next time. The file itself is now a broken table in any Markdown app.
- **Where:** tiptap-markdown table serializer (`node_modules/tiptap-markdown/dist/tiptap-markdown.es.js:508-558`), not overridden by Filo.
- **Fix:** override the table serializer: escape `\|`, and fall back to an HTML table when a cell holds anything but one plain paragraph.

**A25-05 · After a plain click on a Kanban card, the board stops showing new and moved cards** (App, Probe)
- **What happens:** clicking a card sets the "dragging" marker (`kanbanDragController.svelte.ts:246`). Only a finished drag clears it, and svelte-dnd-action sends no finish event for a click without movement (`handleFalseAlarm`). While it is set, `syncCards` (`:209-210`) skips every column. In the app, after one click and "Add Card", the badge said 3 and the file held 3, but only 2 cards were shown. Filters also stop hiding the clicked card.
- **Effect on you:** you will think Add Card failed and press it again, creating duplicate notes. Moves and deletes look wrong until you drag something or reopen the board.
- **Where:** `resetDragState` / `onDragEnd` exist but have no callers; the comment at `:335-336` is wrong.
- **Fix:** clear `dragTileId` (and the snapshots) on pointerup when no drag started, then resync.

**A25-06 · Large Kanban boards freeze Filo on every open and every tab switch** (App, measured)
- **What happens:** every card mounts a full TipTap editor (`KanbanCard.svelte:318`) in one synchronous pass, with no lazy mounting.

  | Cards | Pause |
  |---|---|
  | 30 | under 1 s |
  | ~100 | 1–3.5 s, every open and every switch back to the tab |
  | 300 | about 22 s with the window unresponsive, and 215 MB of heap |

  For comparison, the Mind Map, which mounts only visible tiles, opens 400 tiles in 0.13 s, and the Task List opens 400 tasks in 0.3 s.
- **Effect on you:** a board that collects cards over months, especially a Done column, gets steadily slower. Closing the window during a long freeze loses only edits made in the half-second before the freeze started (main gives up after 5 s without a heartbeat).
- **Fix:** render a static preview of each card's body and mount the editor only on focus (or when visible), as the Mind Map already does.

### Medium

**A25-03 · A code block containing ``` breaks on reopen** (App, Probe)
- The serializer always uses a three-backtick fence, so pasted Markdown or code containing ``` ends the block early and the note opens read-only.
- **Fix:** use a fence longer than the longest backtick run in the block.

**A25-04 · Task List notes box: multi-line notes reopen read-only** (Probe)
- The notes box writes the textarea text as the note body. Single newlines are soft breaks in Markdown, so opening the note as a document or card shows the read-only banner (`TaskItem.svelte:839-851`, `notesBox.svelte.ts:244`).
- If a rich view of the same note is open at the time, the check is skipped and that view's next keystroke joins the lines.
- **Fix:** convert newlines to hard breaks on save and back on open.

**A25-07 · Task List shows every task as not done and unprioritised for a few seconds after opening a big vault** (App, measured)
- The vault index rebuild isn't awaited (`vault.svelte.ts:404`) and publishes its results only when it finishes (`vaultIndex.svelte.ts:258`). Task List rows read their fields from it.
- With 5,000 notes the 400 rows appeared after 0.6 s, but completion and priority stayed blank until about 4.5 s. (Finder B's 13–23 s came from jsdom; real Chromium is faster.)
- **Hazard:** ticking off a *recurring* task in that window completes it for good instead of rescheduling it (`frontmatterWriter.ts:47` reads the still-empty `row.recurrence`).
- Also, the rebuild runs a full remark parse and builds a MiniSearch index that nothing queries.
- **Fix:**
  - Publish per chunk, or do a frontmatter-first pass.
  - Hold recurring-task completion until the index is ready.
  - Drop or defer the unused parse and MiniSearch work.

**A25-08 · Every autosave re-derives every board and all Task List rows** (Probe; magnitude in real Chromium unmeasured)
- Each save re-parses the note and bumps one global index version (`notes.svelte.ts:148`, `vaultIndex.svelte.ts:326-334`).
- Task List depth is O(n²) (`TaskListRow.svelte:97` → `blockMove.ts:51`).
- The sidebar isn't virtualised, so expanding a folder of thousands of notes is slow.
- **Fix:** invalidate per path; compute depths once per render; virtualise the tree.

**A25-09 · Undoing a tag rename can re-tag notes that never had the old tag** (Probe)
- The "is this a merge?" check looks only at the tag registry, case-sensitively (`tagEditConfirm.ts:45-46`). Quick-add writes tags without registering them (`taskCreation.ts:268`).
- So renaming `blocked` → `waiting` when `waiting` exists only in notes, then pressing Undo, turns every `waiting` note into `blocked`. The case-only variant: `draft` → `Review` while `review` exists.
- This is silent and can touch many notes.
- **Fix:** detect a merge case-folded over the registry plus actual usage; make Undo touch only the paths the rename wrote.

**A25-10 · Kanban mishandles text-form tags (`tags: project`)** (Probe)
- Bulk "Add tag" replaces it with `[urgent]`, dropping `project` (`kanbanMultiSelect.svelte.ts:198-205`).
- A tag filter throws, and since the filter is saved with the board, the board stays broken (`kanbanFiltersAndSort.svelte.ts:61-66`).
- Filo itself writes arrays, so this bites only on notes written elsewhere.

**A25-11 · Tag autocomplete: Enter picks the first substring match** (Probe)
- Typing `urgent` and pressing Enter adds `not-urgent` (`tagRowInput.ts:64-81`, `NoteTagRow.svelte:112-113`).
- **Fix:** rank exact match, then prefix, then substring.

**A25-12 · Replace All is blunter than it looks**
- It matches case-insensitive substrings only, with no whole-word option (`runSearch.ts:77-83`): "cat" → "dog" also rewrites "Concatenate".
- The confirm counts title matches that are then skipped.
- At the 5,000-match cap it replaces a subset and reports success.
- It is undoable, and it never touches frontmatter.
- **Fix:** add Match case and Whole word; name the files in the confirm; refuse when the results were truncated.

**A25-13 · Dropping a vault file from Explorer onto a Kanban column copies it**
- It creates `Plan (1).md` instead of linking the original (`kanbanFileDropHandler.ts:130`). The Mind Map has the in-vault branch (`dragDrop.ts:186-212`); Kanban doesn't. Edits then go to the copy.

**A25-14 · Plain-text paste is parsed as Markdown with HTML on; copy-out adds escapes** (Probe)
- **Paste:** lines join, `List<String>` / `<Enter>` vanish, and `__init__` turns bold (`createEditor.ts:328-336`).
- **Copy out:** gives `C:\\Users`, `5 \* 3`.
- It is visible at paste time, and Ctrl+Z works.
- **Fix:** paste plain text as plain paragraphs; drop `transformCopiedText`.

### Low

**A25-15 · Windows shutdown / restart / sign-out skips the save-before-quit path**
- Nothing handles `query-session-end` / `session-end` (`main.ts`), and Electron doesn't fire `before-quit` then.
- A shutdown you start yourself blurs the window first, so typed text saves. What is exposed is a forced restart (Windows Update, the power button) while a decision is unanswered, Settings are unapplied, or a field is still focused.
- **Fix:** on `query-session-end`, run the quit drain and choose "Quit anyway" automatically, so rescue copies get written.

**A25-16 · Deleting a board whose last save failed or is held skips the rescue copy**
- `flush()` returns ok when only retained writes remain (`writeScheduler.ts:575-587`, `boardCacheDelete.ts:121`).
- For a drift-held board the failed mark outlives the delete (`boardCacheDelete.ts:97`), so quit warns about a board that is in the trash.
- **Fix:** treat retained, failed or held as "not flushed"; call `discardBoardWrite` after the trash move.

**A25-17 · A board loaded without a baseline skips the drift check on its first save**
- `boardLoader.ts:474-484`, `boardWriteScheduler.ts:274`.
- **Fix:** `markBaselineUnverified` like configs. Also correct the false comment at `boardLoader.ts:475-478`.

**A25-18 · A `.filo/` settings or shortcuts drift prompt is awaited inside the writer**
- `configDrift.ts:179`, `miscConfigDrift.ts:109`.
- Quit waits for it, then calls it "Save failed … another program may be holding it". It should be a held decision, as boards and raw views are since Audit-24 Phase 9.

**A25-19 · `board:save` / `config:save` have no main-side compare-and-swap**
- Notes have one (`board.ipc.ts:262-283`). It needs a second writer inside a few milliseconds, so it doesn't apply to this setup. Same class as KL #15. Defer.

**A25-20 · Smaller Kanban / Mind Map / Task List issues**
- Kanban Lock does nothing but pushes an undo step (`tileDefBuilder.ts:160-169`).
- Ctrl+A selects tiles hidden inside collapsed frames, so Delete removes invisible tiles (undoable; `AppShell.svelte:333-344`).
- A subtask's `parent:` is a board-local id written into the note (`taskCreation.ts:318`).
- `DeleteSectionCommand.undo` re-inserts at an absolute index (`sectionCommands.ts:210-227`).
- The "today" smart list goes stale after midnight (`taskListViewModel.svelte.ts:151,174`).
- Dropping one note twice onto a Task List makes two rows (`fileDropHandler.ts:249`).
- The toolbar Undo button always does board undo, even while typing (`GlobalToolbar.svelte:284-288`).

**A25-21 · Sidebar**
- The top-level manual order never persists: written under `normalizePath(vaultRoot)` (`sidebarOrder.svelte.ts:72`), read under `''` (`vaultTreeSort.ts:94`).
- A case-only rename shows "Overwrite file? … cannot be recovered" (`renameVaultEntry.ts:36-44`). For a real name clash, main refuses the rename anyway, so "Overwrite" ends in "Failed to rename" (`fileOps.ts:288-292`). Nothing is lost, but the dialog is wrong both ways.

**A25-22 · The read-only banner doesn't say what it can't handle**
- KL #17 understates the list: notes written elsewhere with `5 * 3`, `[TODO]`, `C:\Users`, footnotes or `~~~` fences open read-only.
- **Fix:** name the construct in the banner, and point to the Raw view rather than Take ownership.

**A25-23 · A board that fails validation shows every schema problem in the toast, uncapped**
- A 300-tile board produced about 200 KB of toast text (`boardLoader.ts:590-592` → `boardLoadFailedNotice.ts:27`).
- **Fix:** show the first 3 problems and "and N more".

**A25-24 · A board that fails to load loses its tab**
- `hydrateFromWorkspace` drops the tab (`tabs.svelte.ts:467-468`) and `workspace.json` is rewritten without it, so a repaired or re-synced board has to be reopened by hand.

**A25-25 · Wording**
- The BatchCommand rollback modal advises "closing without saving", which Filo can't do (`groupAndBoardCommands.ts:37`).
- Jargon in toasts: `vaultFolderOps.ts:371/484/495`, `renameCascadeRepair.ts:33`, `tagRewriteSweep.ts:274`, `fileTagsCascade.svelte.ts:204`.

**A25-26 · Other lows (not re-verified)**
- The Tags Browser busy guard doesn't gate double-click rename or the toast buttons.
- An audio take is orphaned if its tile is deleted mid-recording.
- A timer panned off-screen never announces that it finished.
- Editor minors:
  - Shift+Enter in a heading leaves a stray `\`;
  - a paragraph `1.` becomes an empty numbered list;
  - a horizontal rule inside a list item breaks the list.

### Refuted or downgraded

- **"1-second frames" freeze on a 400-tile Mind Map:** refuted. It was the test window being minimized; real frames took 0–5 ms.
- **Quit while minimized loses the last edit:** refuted in the app. The edit was saved in 0.2 s, both immediately and after 20 s minimized.
- **A1 (shutdown), high → low:** a user-initiated shutdown blurs first, so fields save.
- **A3 (board compare-and-swap):** not applicable to one machine.
- **B3 blank-field duration:** 13–23 s → about 4 s in real Chromium at 5,000 notes.
- **Notes-box Esc discards the draft:** by design (the placeholder says "Esc to cancel").

## Real-app checks that passed

- **5,000-note vault:**
  - the sidebar appeared in 0.2 s, search answered in 0.1 s, and quit took 0.15 s;
  - no toasts or console errors;
  - after opening, browsing every board type and quitting, **no file in the vault had changed** (SHA-1 of every file compared). That included CRLF, BOM and `zip: 02134` notes.
- **Syncthing simulation** (temp file renamed into place, source mtime an hour old):
  - an open, unedited note updated on screen;
  - a delivery landing mid-typing produced the "Reload or keep yours?" prompt, with nothing overwritten;
  - a board delivery updated the open Kanban silently;
  - `.stversions/` and `.syncthing.*.tmp` never appeared in the sidebar or in search;
  - a `*.sync-conflict-*` copy showed as its own file;
  - quitting with the question open showed "Waiting for your decision".
- **Quit while minimized**, right after typing: saved.
- **Task List with 400 tasks:** opened in 0.3 s, and ticking a task wrote `completed: true` to its note.

## If you start now

- Delete the empty checkbox Enter leaves at the end of a checklist, and indent with Tab, not spaces.
- Don't type `|` in table cells.
- If a note opens read-only, fix the flagged line in the **Raw** view (top-right toggle). Don't press **Take ownership**.
- On a Kanban board, if a card you added or moved doesn't show, drag any card a little or reopen the board before trying again.
- Keep Kanban boards under about 100 cards (move finished cards to an archive board).
- After opening the vault, give it a few seconds before ticking off recurring tasks.
- Avoid Undo on a tag rename into a tag that already exists.

## Fix plan

Each phase leaves a working app and ends with `npm run ci:verify` plus a real-app check of the phase's scenarios, using the scripts in the session scratchpad `realapp/`: `editorB1.mjs`, `kanbanB2.mjs`, `recover.mjs`, `taskBlank.mjs`, `syncsim.mjs`, `scale2.mjs`.

### Phase 1: notes that reopen read-only, and the Kanban display (do before daily use)
1. **A25-01:**
   - empty task items and mixed bullet/task lists parse back the same;
   - leading spaces are escaped or stripped;
   - `markdownBodyRoundTrip` / `toolbarFormattingRoundTrip` gain list-toggle-inside-a-list, Enter-after-last-task and leading-space cases;
   - a gate case: every toolbar and keyboard list command, applied inside a list, survives save → reload.
2. **A25-02:** override the table serializer (escape `|`, HTML fallback for complex cells).
3. **A25-03:** fence longer than the content's longest backtick run.
4. **A25-04:** notes-box newlines become hard breaks, and back.
5. **A25-05:** reset the Kanban drag state on a click without movement, with a component test for click → Add Card → card visible.
6. **Take ownership:** make it refuse (or warn) when it would turn a construct into escaped text or a code block, and point to the Raw view (part of A25-22).

### Phase 2: performance at scale
1. **A25-06:** Kanban cards render a static body preview and mount TipTap on focus. Target: 300 cards open in under 1 s.
2. **A25-07:**
   - publish the index per chunk, or do a frontmatter-first pass;
   - hold recurring-task completion until the index is ready;
   - drop or lazy-load the unused remark parse and MiniSearch.
3. **A25-08:** per-path invalidation instead of a global version bump; one depth pass per Task List render; virtualise the sidebar tree.

### Phase 3: metadata correctness
1. **A25-09:** case-folded merge detection over registry plus usage; Undo touches only the written paths.
2. **A25-10:** normalise text-form `tags:` in Kanban bulk add and filters.
3. **A25-11:** tag autocomplete ranking.
4. **A25-12:** Replace All: Match case, Whole word, accurate count, refuse when truncated.
5. **A25-13:** Kanban Explorer drop of an in-vault file links it.
6. **A25-14:** plain-text paste and copy-out.

### Phase 4: lifecycle edges
1. **A25-15:** `query-session-end` → quit drain + automatic rescue copies.
2. **A25-16:** board delete with a retained or held write → rescue copy + `discardBoardWrite`.
3. **A25-17:** a board with no baseline is marked unverified; fix the comment.
4. **A25-18:** config drift becomes a held decision (non-blocking, like boards).
5. **A25-19:** optional; defer unless a second writer appears.

### Phase 5: UX lows and hygiene
1. **Items:** A25-20, A25-21, A25-22, A25-23, A25-24, A25-25, A25-26.
2. **Dead code:**
   - `toggleTagFade` / `ToggleTagFadeCommand`, `getTagUsageCount`, the global `spatialStore` facade, `isThemeToken`, `vaultStore.setLoading`, `searchStore.togglePanel`;
   - unreachable `SideToolbar.svelte:88-115` cases, `workspaceStore.setSidebarWidth`;
   - the test-only `fileTags.hydrate()`, whose catch leaves tags writable;
   - `toolbarConfig.toggleTaskList` has no UI caller (only the TipTap Ctrl+Shift+9 shortcut reaches task lists).
3. **Duplicates:**
   - three tile factories and two frame factories (SideToolbar's copies freeze Global Defaults into new elements);
   - four date formatters;
   - `vaultRelativeFromAbsolute` vs `toVaultRelative`;
   - the timer-mode enum defined five times;
   - `nanoid(6)` in style popups instead of `createId()`.
4. **Stale comments:**
   - `boardWriteScheduler.ts` 43-52, 85, 207-211, 331-333;
   - `boardCacheDelete.ts:137-139`;
   - `boardDrift.ts:7,67-69`;
   - `writeStateTracking.ts` header;
   - `taskCommands.ts:26-32`;
   - `groupAndBoardCommands.ts:231-238`;
   - `vault.svelte.ts:365`;
   - `TaskItem.svelte:830-833`;
   - the `kanbanDragController` comment at 335-336;
   - about 20 comments naming removed identifiers.
5. **Audit-id gate:** it misses `E.11` (`KanbanNewTileModal.svelte:63`) and `(F1 regression?)` (`fileBaselineRegistry.ts:309`); widen the pattern.
6. **CLAUDE.md corrections:**
   - BoardRegistry has no toolbar or schema;
   - `getCanvasPointFromEvent` doesn't exist;
   - the quit-failure file is `quit-failure.<machineId>.json`;
   - configs use a 300 ms debounce (viewports 1,500 ms), not "write on panel close";
   - a Document tab's stack is keyed by `tab.boardId`.
7. **KNOWN_LIMITATIONS:**
   - #15 describes a renderer-side re-check that has since moved to main;
   - #4 should mention OS shutdown;
   - #17 needs the fuller list.
8. **Pre-swap ordering:** the `boardCache` / `fileTags` / `workspace` / `sidebarOrder` resets rely on module load order to run after `leftBehind`. Add `runAfter`, or a gate.
9. **Still open from Audit-24:** rewrite the E2E suite to drive the built app.

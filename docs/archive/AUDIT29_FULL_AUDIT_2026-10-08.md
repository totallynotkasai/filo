# Audit-29: full audit after Audit-28 and the page view (2026-10-08)

A whole-system audit after Audit-28's eight phases, the Document tab's page view and zoom, and the first evening of real use. It covers data integrity first, then bugs, logic errors, what the recent changes could have broken, gaps against the design doc, redundancy and legacy code, and the user experience of the four views.

- **Code audited:** `main` at `f830c42`, plus the uncommitted change in the working tree. That change removes the gap between paragraphs and shows typed blank lines in Kanban card previews; another session made it at your request on 7 October (`style.css`, `DocumentEditor.svelte`, `staticPreview.ts` and two tests). It was audited as finished work.
- **Your setup:** the same as for Audit-28, with two facts found on the way:
  - You run Filo on your book vault with `npm run dev`.
  - On 7 October another Claude session reorganised the book vault from outside Filo while Filo had it open: notes moved into new folders, new notes written, notes merged.
- **Method:**
  - Five finder agents and two refuter agents. The refuters tried to disprove every finding, re-running the finders' repro tests.
  - My own checks: the full test suites on Windows, the corpus check on your current notes, and five scripted tours of the built app on copies of your book vault. Section 9 has the details.

## How to read the scores

Every score is out of 10 and written like `7/10`.

| Score | 0/10 means | 5/10 means | 10/10 means |
|---|---|---|---|
| **Area score** | Unusable, or loses data routinely | Works, but with real gaps you will hit | Nothing left to improve |
| **Impact** (a finding) | Harmless | A real annoyance, or a small change lost now and then | Loses or corrupts notes |
| **Hard** (a fix) | Minutes | A few days, several files, new tests | Weeks; rewriting a major part of Filo |

**Severity:**
- **Critical:** silently loses or corrupts notes in normal use.
- **High:** loses or corrupts something in a plausible situation, or a core flow is broken.
- **Medium:** wrong or confusing behaviour you will hit; recoverable.
- **Low:** rare or cosmetic.

## 1. The short answer

**Filo is in clearly better shape than at Audit-28: no Critical and no High findings (Audit-28 had four Highs, all fixed and holding).** The note writer, the Raw view, conflicts, rescue copies and the leave and quit paths held up under the hardest checks yet, including your other Claude session reorganising the vault while Filo had it open. On this PC every check passes:
- **`ci:verify`:** 8,520 tests and 91 safety checks.
- **E2E:** 47/47 end-to-end runs of the built app, with the 5,000-note scale budgets.
- **Corpus:** no saved note changed against the last baseline, across 734 notes.
- **Your current notes:** 19 of your 20 book-vault notes open editable and save cleanly. The other one is written by the outside agent (section 7).

There are **7 Medium findings**, in three groups:

1. **How you run Filo (C-08, Medium).**
   - **Why it matters:** `npm run dev` reloads the window whenever another session edits most of Filo's logic files. That reload skips every save path: the quit save, rescue copies, held decisions, undo.
   - **Yesterday:** the edits that evening were to components and CSS, which hot-swap safely, so most likely nothing was lost.
   - **From now on:** the fix phases will edit exactly the files that force a full reload.
   - **The fix:** a one-line change in habit. Run a built copy for real work (section 7, item 1).
2. **The uncommitted "no gap after Enter" change (D-01, D-02, D-08, Medium).** It does what you asked for prose, but:
   - lists now stand looser than the text around them;
   - a line break now looks exactly like a new paragraph, so Heading or Align on "one line" changes a whole block of lines;
   - Enter at the end of such a line seems to do nothing, and what you type next is glued onto the following line.
   - **Before committing it:** answer decision D1 in the plan.
3. **Other programs and the keyboard (C-02, C-03, E-03, Medium).**
   - **An agent moving notes:**
     - A note an agent moves *and* edits in the same moment is reported as deleted, and "Keep mine" makes two copies (C-02).
     - A folder an agent renames while changing a file inside it takes up to 30 s to follow, with a wrong "file no longer exists" message meanwhile (C-03).
     - Until fixed: close Filo while an agent reorganises the vault.
   - **Task List:** Alt+Up / Alt+Down move tasks by their order in the file, not on screen (E-03).

The other 40 findings are Low. Several are small regressions from the last round, each where a fix landed. Examples: Escape no longer closes Search on a Task List (E-01), and Phase 4's keyboard fixes reached the Task List but not Kanban (E-02, E-05, E-06).

**Before your next evening in Filo:**
- Run a built copy, not `npm run dev`.
- Decide D1 (paragraph spacing).
- Close Filo while an agent reorganises the vault.
- Push the 11 local commits to GitHub before 19 October (C-05; they exist only on this disk).

**Overall for daily use: 7/10** (Audit-28: 6/10). **Data safety: 8/10** (Audit-28: 7/10); in a dev run it is lower, because C-08 bypasses the safety net.

## 2. Scores by area

**Overall for daily use: 7/10.** Data safety alone: **8/10.**

### Your data

| Area | Score | Audit-28 | Why | Findings |
|---|---|---|---|---|
| Saving notes (the note writer) | 8/10 | 8/10 | Fresh read per save, the "changed since I read it?" check, follows renames mid-save. Two narrow windows remain. | A-02, A-03 |
| Titles, tags and fields in frontmatter | 8/10 | 9/10 | Source-preserving as before. New: a note left "Untitled" keeps that title after a rename, and undoing a new card can trash metadata added in another view. | A-05, A-04 |
| Conflicts with changes from outside | 6/10 | 6/10 | Reload and the Raw view now keep a copy first. But an agent moving and editing at once is read as a delete, a folder rename plus an edit shows a wrong message for up to 30 s, and the notes box's "Use theirs" keeps no copy. | C-02, C-03, A-01, A-03 |
| The Raw view | 8/10 | 4/10 | Last audit's High is fixed; saves after a pause; copies kept everywhere. Closing a split pane doesn't ask. | A-06 |
| Making, naming and renaming notes | 8/10 | (new) | New note, placeholder names renamed after the first title, natural sort: all sound. | A-05, D-05 |
| Saving boards | 8/10 | 8/10 | Scheduler captures and board-move holds hold under every trace. Undoing a layout template leaves its empty notes. | B-01 |
| Board format and older boards | 8/10 | 7/10 | Shape checks, stale inline copies dropped, honest notice. No migration step exists yet. | BL-39 |
| Filo's settings files (`.filo/`) | 8/10 | 8/10 | Drift holds, nothing written by looking. BL-41 could not be reproduced. | — |
| Undo and redo | 8/10 | 7/10 | Per-key style undo and "a note-only step writes no board" are correct everywhere. | B-01, B-06, A-04 |
| Trash and restore | 7/10 | 8/10 | Restoring a "Delete tile and file" from Settings → Trash brings no tile back, and a later Ctrl+Z can attach the tile to a different note. | B-05, B-06 |
| Tags | 8/10 | 7/10 | Inline-tile tags fixed. One misleading bulk message. | B-08 |
| Opening, closing, quitting, Windows shutdown | 8/10 (built app) | 8/10 | Save, freeze, settle, save again, rescue copies. **A dev run bypasses all of it on a reload.** | C-08 |
| Crash recovery and rescue copies | 8/10 | 6/10 | Settings → Recovery, every kind of unsaved text covered, kept versions never pruned. | A-02 |
| Outside changes and sync | 6/10 | 6/10 | Plain moves, an 80-note burst and a restructure while open are all followed. Move plus edit at once, and a folder rename plus a change, are not. | C-02, C-03, C-07 |
| Security | 9/10 | 8/10 | `.filo/` guards on the disk's own spelling, public-only link fetches with the connected address checked. One URL check reads the whole string. | C-04 |

### The editor

| Area | Score | Audit-28 | Why | Findings |
|---|---|---|---|---|
| Formatting kept on save | 8/10 | 6/10 | The extended fuzz (emoji, RTL, quotes holding lists, images, tabs; four seeds, 2,900 documents) is clean. An image's alt text loses `[`, `]` and `*`. | D-06 |
| Your notes opening editable | 8/10 | 8/10 | 0 newly read-only across 734 corpus notes. Your one read-only note was written by the outside agent in a shape Filo can't keep. | H-05 (non-issue), H-02 |
| Editor controls (toolbar, paste, lists, links, spell check) | 7/10 | 5/10 | Most of Audit-28's list fixed. Zoom keys miss Ctrl and +, spell check off misses the task notes box, the read-only banner names the wrong line. | D-04, D-07, H-02 |
| Paragraphs and line breaks (the uncommitted change) | 5/10 | — | Tight paragraphs as asked, but lists stay loose, line breaks look like paragraphs, and Enter at a line break seems to do nothing. No setting, undocumented. | D-01, D-02, D-08, H-03 |
| Cards, tiles and titles | 7/10 | 4/10 | New cards and tiles take the caret; the card preview now matches the editor. Pasting two lines into a title puts a line break in `title:`. | D-05, E-05 |
| Document tab page view and zoom | 7/10 | (new) | Page layout and clicks are right at every zoom tested, in the rich editor and the Raw view. Slow on a 100,000-word note, key gaps, and the page can slide under the docked sidebar when zoomed on a laptop. | D-03, D-04, E-09, E-10 |
| Editor speed | 7/10 | 7/10 | About 1 to 2 ms per key at 100,000 words. The page view adds pauses only on very long notes. | D-03 |

### The four views and the interface

| Area | Score | Audit-28 | Why | Findings |
|---|---|---|---|---|
| Documents, tabs and panes | 7/10 | 5/10 | New note from the sidebar, page view, zoom, the text menu. | E-09, A-06 |
| Mind Map | 7/10 | 5/10 | Keys as commands, clear placement, nesting. A folded frame leaves inner frames drawn, arrow keys and N ignore what's off screen, and the empty Waypoints panel sits over tiles. | E-08, E-11, H-04, B-01 |
| Kanban | 6/10 | 5/10 | New cards take the caret; picker dates. Collapsed columns leak into Shift-click and the arrows, a card added while filtered vanishes, and the menu-key route doesn't exist. | E-02, E-05, E-06, E-12 |
| Task List | 6/10 | 5/10 | Phase 4 fixed the order of the arrows, Shift-click and Ctrl+A, plus the date picker and quick add. Alt+Up/Down, Tab and Escape still misbehave; the ToC still covers the list on laptops. | E-03, E-01, E-04, E-07, BL-35 |
| Sidebar, search, tags and settings | 7/10 | 5/10 | New note and folder, natural sort, the Search list, Settings → Recovery. The sidebar cuts names short and its Escape also closes Search. | E-12, H-04 |
| Templates | 6/10 | (new) | Board templates exist now, but their `settings` are ignored, a `:` in the title blocks them, undoing a layout leaves notes, and they start only from a Mind Map. | B-01, B-02, B-03, BL-32 |
| Keyboard and accessibility | 6/10 | 4/10 | Big gains, but four separate key mechanisms keep diverging, Kanban's "focused" card never has real focus, and Help lists only a fraction of the keys. | E-01 to E-07, E-13 |
| Matches the design doc | 8/10 | 6/10 | Most gaps from Audit-28 closed. Still missing: "Line & paragraph spacing", template `settings`, "all shortcuts" in Help, and "keys follow the screen" for Alt+Up/Down. | D-01, B-02, E-13, E-03 |

### Engineering and release

| Area | Score | Audit-28 | Why | Findings |
|---|---|---|---|---|
| Code health (redundancy, legacy, dead code, size) | 7/10 | 6/10 | One date parser, one priority vocabulary, one date picker, one delete flow: Audit-28's duplicates are gone. But key handling lives in four places, and the three allowlisted files sit at their ceilings with `KanbanBoard` 15 lines under the limit. | Section 5 |
| Docs accuracy | 7/10 | 7/10 | CLAUDE.md matches the code (the tree, every constant). KL #7, #17 and #31 understate, CLAUDE.md overstates Trash restores, two backlog items are stale, and the uncommitted change is undocumented. | Section 5.4 |
| Tests and CI | 8/10 | 7/10 | 8,520 tests, 91 safety checks, 47 E2E runs, the corpus check, all green. But the Mediums found here are interactions no suite exercises, and GitHub's Linux check has not run on 11 commits. | C-05 |
| Speed at scale | 8/10 | 8/10 | The 5,000-note budgets pass. Very long notes with pages on are the one weak spot. | D-03 |
| Release and install | 3/10 | 3/10 | No installer of today's code, the version has said 0.2.0 for 11 commits, real work runs under `npm run dev`, and nothing is pushed since 4 October. | C-08, C-01, C-05 |

## 3. Findings

Each finding has an ID by area:
- **A:** notes and the Raw view.
- **B:** boards, settings, undo, tags and templates.
- **C:** vault lifecycle, outside changes, recovery, security and release.
- **D:** the editor.
- **E:** the views and the interface.
- **H:** found hands-on in the built app.

The IDs restart from Audit-28's, so in commit messages write "Audit-29 A-01". Severity and scores are after the refuters' review. "Older" means the problem predates the last audit's base (`6c5f5a3`).

### 3.1 At a glance

51 findings went through review:
- **0 Critical, 0 High, 7 Medium, 40 Low.**
- **1 refuted:** B-07.
- **1 non-issue:** H-05.
- **2 duplicates:** H-01 is D-01, and E-15 is D-02.
- **BL-41 could not be reproduced** (section 6).

**Medium**, by impact:

| ID | Finding | Where you meet it | Impact | Hard | Since | Verified by |
|---|---|---|---|---|---|---|
| C-08 | Running Filo with `npm run dev`: an edit to most of Filo's logic files by another session reloads the window with no save | Every view | 4/10 | 1/10 | your setup | Refuter 2 (code and module graph) |
| C-02 | A note moved and edited by another program at the same moment is reported as deleted; Keep mine makes two copies | Outside changes | 4/10 | 4/10 | older | Refuter 2 (repro fails) |
| C-03 | A folder renamed by another program while a file in it changes is followed only after up to 30 s; meanwhile an open note says "the file no longer exists" | Outside changes | 3/10 | 2/10 | older | Refuter 2 (repro fails) |
| E-03 | Task List Alt+Up / Alt+Down move a task by its order in the file, not on screen | Task List | 3/10 | 2/10 | older | Refuter 2 (repro fails) |
| D-02 | A line break now looks exactly like a new paragraph, so Heading or Align on "one line" changes the whole block of lines | Every editor | 3/10 | 3/10 | uncommitted (cue removed); the behaviour is older | Refuter 1 (Chromium) |
| D-08 | Enter at the end of a line inside a block of line-broken lines seems to do nothing; what you type next joins the following line | Every editor | 3/10 | 2/10 | uncommitted (cue removed); the behaviour is older | Refuter 1 (Chromium, real keys) |
| D-01 | With paragraphs closed up, every list now stands looser than the text around it | Every editor | 2/10 | 1/10 | uncommitted | Refuter 1 (Chromium), built app |

**Low**, by impact:

| Impact | Findings |
|---|---|
| 2/10 | A-01 notes box "Use theirs" keeps no copy · A-03 Reload can show an older version · A-05 "Untitled" survives a rename · B-01 undoing a layout template leaves its notes · E-01 Escape doesn't close Search on a Task List · E-02 collapsed Kanban columns leak into ranges and arrows · E-05 a Kanban card added while filtered vanishes · E-08 folded frames leave inner frames drawn · E-09 zoomed page under the docked sidebar · E-11 Mind Map arrows and N ignore what's off screen · E-12 the same action differs between views · H-02 the read-only banner names the wrong line · H-04 sidebar names cut short, panels over tiles |
| 1/10 | A-02 · A-04 · A-06 · B-02 · B-03 · B-04 · B-05 · B-06 · B-08 · C-01 · C-04 · C-05 · C-07 · D-03 · D-04 · D-05 · D-06 · D-07 · E-04 · E-06 · E-07 · E-10 · E-13 · E-14 · H-03 |
| 0/10 | C-06 · E-16 |

### 3.2 Notes, the Raw view and conflicts (A)

Finder A's summary: no path in normal use silently loses or corrupts a note's text, including the outside-agent scenario.

**A-01 The Task List notes box's "Use theirs" drops what you typed, with no copy.** Low · Impact 2/10 · Hard 1/10 · older · confirmed, repro fails
- **What you see:**
  1. You type in a task's notes box while the same note changes somewhere else (its Document tab, or another program).
  2. A toast asks "Keep your notes, or use the other version?"
  3. "Use theirs" replaces your draft. Nothing goes to `.filo/recovery/`, and there is no undo.
- **Why:** Audit-28's fix (Reload and the Raw view's "Use the new version" keep a copy first) missed this third route. `stores/notePrompts.ts:142-148` → `lib/tasklist/notesBox.svelte.ts:274-278`, where `this.open()` overwrites the draft.
- **Fix:** `keepNoteVersion(…, rescueText())` before `open()`, asking if the copy fails; label the button "Use theirs (discard mine)".

**A-02 Keys typed during a rename stay unsaved until the next key.** Low · Impact 1/10 · Hard 1/10 · older · narrowed
- **What you see:** usually nothing. Keys typed in the instant a note is renamed (during the rename itself, or just before another program moves it) aren't saved until the next key, a click away, Ctrl+S, close or quit. Only a crash in that window loses them.
- **Narrowed:** in-app renames, including every placeholder rename, save every editor first (`withDrainedWrites` → `serializeViews`). So the window is the rename's own IPC call, or an outside move.
- **Where:** `lib/editor/noteEditorView.ts:90-96`, `:129-136`. `show(newPath)` serialises against the old key, finds no model and returns, having cleared its idle timer.
- **Fix:** serialise against the moved model in `show()`, or re-arm the timer.

**A-03 Reload in a conflict can show a version older than the file.** Low · Impact 2/10 · Hard 1/10 · since `6b590fe` · confirmed, repro fails
- **What you see:** another program saves the note twice in quick succession while you answer Reload, for example an AI agent making several edits. You see the first of those saves as clean, though the file holds the second.
- **Why it's not a loss:** your next keystroke meets the "changed since I read it" conflict prompt again.
- **Where:** `stores/notes.svelte.ts:673` reads the file. `:710` awaits the "keep your typing" copy. `:714` then adopts the earlier read.
- **Fix:** read again after `keepTyping()`, or adopt the newer `conflictDisk`.

**A-04 Undoing a new card, tile or task can trash metadata added in another view.** Low · Impact 1/10 · Hard 1/10 · since `decd96c` · narrowed
- **What you see:**
  1. You add a card.
  2. You give it tags in its Document tab's tag row, or frontmatter in the Raw view, but no body text.
  3. A later Ctrl+Z of "Add card" on the board sends the note, metadata and all, to Filo's trash.
- **Narrowed:** edits made on the board itself are undone first. Redo or Settings → Trash brings the note back.
- **Where:** `commands/newNoteUndo.ts:47` checks only the body.
- **Fix:** count the note as empty only while its frontmatter is still what Filo seeded.

**A-05 A new note left as "Untitled" keeps that title after a rename.** Low · Impact 2/10 · Hard 1/10 · since `decd96c` · confirmed
- **What you see:**
  1. New note, then Escape or click into the text.
  2. Later you rename the file "Prologue" in the sidebar.
  3. Tabs, tiles and search still say "Untitled", and "Rename file to match title" would rename it back.
- **Where:** `lib/notes/newNote.ts:23` → `createNote.ts:29` writes `title: Untitled`, and a sidebar rename never touches `title:`.
- **Fix:** don't write `title:` until you name the note, or let a sidebar rename update a placeholder title.

**A-06 Closing a split pane that shows a conflicted Raw view keeps a rescue copy without asking.** Low · Impact 1/10 · Hard 1/10 · older · confirmed
- **What you see:** switching tabs asks first (Audit-28 A-07's fix), but closing the pane doesn't. Your text goes to `.filo/recovery/` with a notice.
- **Where:** `PaneView.svelte:129-131` doesn't call `mayLeaveRawView`.

### 3.3 Boards, settings, undo, trash, tags and templates (B)

Finder B found nothing above Low. The two biggest recent changes, per-key undo (`keyDelta`) and "a note-only step writes no board file", were checked command by command and are sound.

**B-01 Undoing a layout-template insert leaves its new empty notes; a note that can't be made leaves a broken tile.** Low · Impact 2/10 · Hard 2/10 · older · confirmed, repro fails
- **What you see:** insert a two-tile layout template on a Mind Map (Ctrl+T), then Ctrl+Z. The tiles go, but `New Tile.md` and `New Tile 2.md` stay in the board's folder.
- **Where and why:**
  - `commands/tileCommands.ts:139-166`: `AddTilesCommand` has no new-note undo.
  - `TemplateBrowser.svelte:98-124`: the note paths are chosen ahead of time and never registered as "made for a new item".
  - `seedTextFileForNewTile.ts:91-109`: a preset path is not "fresh", so a failed create still reports success and leaves a broken tile.
  - Refuter 1 adds a rare case: a preset path taken by another program in the meantime is adopted, so the tile shows an unrelated note.
- **Fix:** one new-note undo per text tile, and register the notes (or let the normal path picker choose).

**B-02 A board template's `"settings"` are ignored.** Low · Impact 1/10 · Hard 1/10 · older · confirmed, repro fails
- **What you see:** a ```` ```filo-board ```` block with `"settings": {"accentColor": "#ff0000"}` makes a board with no settings of its own. The design doc (line 899) and the skeleton schema's comment both promise them.
- **Where:** `lib/templates/boardFromTemplate.ts:157` passes them as the vault's project settings, and `buildBoardDefaults.ts:35-38` ignores those.

**B-03 A template whose title holds `:` (or `?`, `/`) can't make a board.** Low · Impact 1/10 · Hard 1/10 · older · confirmed
- **What you see:** "Couldn't create the board: Names can't contain ':'". Only a frontmatter `title:` can carry these characters; a file name can't.
- **Where:** `boardFromTemplate.ts:157` builds the name without `fileNameSafe`.

**B-04 "Apply … Defaults to all Boards" keeps a Task List's own title font size.** Low · Impact 1/10 · Hard 1/10 · older · confirmed, repro fails
- **What you see:** the confirm says every board's font sizes are cleared, but a Task List title size set in Current Board stays.
- **Where:** `lib/styles/buildBoardDefaults.ts:128-151`. `titleFontSize` is never in the built block, so the merge keeps it.

**B-05 Restoring a "Delete tile and file" from Settings → Trash brings back the note but not the tile; a later Ctrl+Z can attach the tile to a different note.** Low · Impact 1/10 · Hard 2/10 · older · confirmed
- **Concrete sequence (Refuter 1):**
  1. "Delete tile and file" on `Elves.md`.
  2. New note titled "Elves" in the sidebar (an unrelated new `Elves.md`).
  3. Settings → Trash restores the original as `Elves (restored).md`, without its tile.
  4. Ctrl+Z on the board finds the trash item gone but a file at `Elves.md`, so it re-adds the tile on the *new* note.
- **Where:** `stores/trash.svelte.ts:290-335`: only sidebar deletes register their undo. `commands/trashedFiles.ts:86-92`: "a file exists at the old path" counts as restored.
- **Also:** CLAUDE.md says Trash restores "so the tiles come back too", which holds only for sidebar deletes.

**B-06 With board folders on, Ctrl+Z after renaming a board puts a deleted note back in a re-created old folder.** Low · Impact 1/10 · Hard 1/10 · older (an intended rule) · confirmed
- **What you see:** delete a tile with its file in "Mind Map 1", rename the board "Story", press Ctrl+Z. `Mind Map 1/Hero.md` reappears in a stray folder beside `Story/`. Nothing is lost.
- **Where:** `commandPaths.ts:77-84` (DECISION: a trashed item keeps its original path); `trashOps.ts:329` re-creates the folder.
- **Fix:** restore under the renamed folder when the old one no longer exists.

**B-08 Kanban bulk "Add tag" on only link or audio cards says they already have the tag.** Low · Impact 1/10 · Hard 1/10 · older · confirmed
- **What you see:** a mixed selection gets an honest count. Only a selection of nothing but link or audio cards gets "All selected cards already have #x".
- **Where:** `lib/kanban/kanbanMultiSelect.svelte.ts:192-203`.

### 3.4 Lifecycle, outside changes, recovery, security and release (C)

**C-08 Running Filo with `npm run dev`: a source edit by another session can reload the window, and the reload saves nothing.** Medium · Impact 4/10 · Hard 1/10 · your setup · confirmed by Refuter 2 (code and module graph; not run live on your profile)
- **What you see:** while a Claude session edits Filo's code, the Filo window suddenly reloads. A Recovery prompt may follow, naming files whose last changes are gone.
- **Why:**
  - Vite answers an edit to most `.ts` files with a full page reload: 266 of the 492 renderer and shared modules have no hot-swappable component boundary, among them `noteWriter.ts`, `notes.svelte.ts`, `markdownSync.ts` and `vaultLeaveGuard.ts`.
  - Nothing in Filo handles that reload: no `beforeunload`, `pagehide` or `import.meta.hot` hooks. The quit save, rescue copies and `leftBehind` all hang off the window's close, which a reload never fires.
- **What a reload drops:**
  - editor keys not yet serialised (150 ms; 1 s for long notes);
  - the note writer's 300 ms queue, board writes (300 ms) and camera positions (1.5 s);
  - Raw view and notes-box text (1.5 s), and a title being typed;
  - unapplied Settings and theme edits;
  - held decisions (a conflict's local text, drift holds) and failed writes kept for Retry;
  - every undo stack.
- **What is mostly safe:**
  - **Edits to components (`.svelte`) and CSS hot-swap.** The Document editor's teardown serialises and saves, so text is kept, though the caret and the editor's undo are lost.
  - **7 October:** all three files edited that evening were of this kind, so most likely nothing was lost.
- **Also:** dev mode (Svelte's dev runtime, the dev CSP) is not what `ci:verify`, the E2E suite or the packaged check verify.
- **Fix:** run a built copy for real work: `npm run preview` (section 7, item 1). An in-code guard is optional and needs care. A reload can't wait for a save, but a dev-only `beforeunload` could cancel it while work is unsaved, save, then reload. It must never block the real quit path, which closes the window the same way.

**C-02 A note moved and edited by another program in the same moment is reported as deleted; "Keep mine" forks it.** Medium · Impact 4/10 · Hard 4/10 · older (`7caae19`) · confirmed, repro fails
- **What you see:**
  - **The prompt:** "'Plot' was deleted by another program, but it has edits that weren't saved. Keep your version, or discard it?", though the note was only moved.
  - **Keep mine:** recreates `Plot.md` at its old place with your typing. `01 Story/Plot.md` keeps the other program's edit without your typing, and the Mind Map tile stays on the old `Plot.md`. Two copies then drift apart and nothing says so.
  - **Discard:** drops your typing.
- **How:** `Plot.md` is open with unsaved typing. An agent creates `01 Story`, moves the note into it and rewrites it (fixing links, say) within one watcher batch. That is exactly what your 7 October reorganisation did to other notes.
- **Where and why:** `src/main/services/renameCorrelation.ts` (`sameBasenameBytesPreserved`, around lines 75-130, `:89`, `:99`) refuses a same-name pair whose bytes changed, so the move arrives as a delete plus a create.
- **Fix:**
  - Phase 6A already proves the new path was free (`wasPresentBefore`). Pair a lone same-name `.md` move into a free path as a rename followed by a change; the existing check then asks Reload / Keep mine on the moved note.
  - Or have the prompt offer "It moved to 01 Story/Plot.md: follow it".
  - **Docs:** KL #7 ("same-basename renames always pair") and KL #31 understate this.

**C-03 A folder renamed by another program while a file in it changes is followed only after up to 30 s; meanwhile an open note says its file "no longer exists".** Medium · Impact 3/10 · Hard 2/10 · older · confirmed, narrowed
- **What you see (measured):**
  - **At 3.6 s:** a sticky toast, "Couldn't save changes to 'Castle': the file no longer exists" [Save as new file / Discard change].
  - **At 26.6 s:** the 30-second check follows the move, your typing lands in `04 Worldbuilding/Castle.md`, and the toast goes away.
- **Narrowed:** left alone it heals. You lose text only if the wrong message talks you into **Discard**; **Save as new file** makes a second copy.
- **Where and why:**
  - `src/renderer/lib/vault/treeFolderMoves.ts` (`folderMovesBetween`) pairs a renamed folder only when every file name and size matches.
  - Windows reports a folder rename by the folder names alone, so the files wait for the 30 s walk (`fileWatcher.ts:46`).
  - `askUnlessMoved` asks after 3 s.
  - Boards already avoid this: `boardProvisionalMissing.ts:74` asks main to check at once (`vault:reconcile`).
- **Fix:** do the same for a note write that fails because the file is missing, or accept a folder whose old files all reappear under the new name, with additions or changes allowed.

**C-01 Builds can't be told apart, and the packaged builds are stale.** Low · Impact 1/10 · Hard 1/10 · since `40b0e87` · confirmed, re-scoped
- **The version:** Settings has said "Filo 0.2.0" for 11 commits.
- **The packages:**
  - `release/Filo Setup 0.2.0.exe` was built before Phase 1, so it has none of Audit-28's fixes after Phase 0.
  - `release/win-unpacked` (6 October) has no BL-40 fix and no page view.
  - Nothing is installed.
- **Why Low:** alone this is harmless, since you don't run those builds. The risk is the dev run (C-08).
- **Fix:** bump the version with every build you use, and show the commit id beside it (the cheap half of KL #20).

**C-04 `isPrivateUrl` reads a bracketed IPv6-mapped address anywhere in a URL.** Low · Impact 1/10 · Hard 1/10 · older · confirmed, repro fails
- **What it means:** `https://192.168.1.1/?x=[::8.8.8.8]` counts as public, and so do `fc12::1` and `fe90::1`. An embed's page could make Filo open a private `https` page (a router's admin page) in your browser.
- **Unaffected:** link previews and the media open path, which have their own checks.
- **Where:** `src/main/utils/pathSecurity.ts:686`.
- **Fix:** test only the URL's host, with the fc00::/7 and fe80::/10 ranges.

**C-05 Eleven commits exist only on this PC.** Low · Impact 1/10 · Hard 1/10 · confirmed
- **The state:** `origin/main` is still `ead80a3` (4 October). Audit-28 Phases 0-8 and the page view, about 10,000 lines, have no copy off this disk, and GitHub's Linux check has never run on them.
- **The timing:** pushed after 19 October, their first run would coincide with the Ubuntu 26 switch (BL-21), and a failure couldn't be told apart.

**C-06 The full `npm audit` is no longer clean (development tools only).** Low · Impact 0/10 · Hard 1/10 · confirmed
- **The count:** 9 advisories: source-map-js (high, fixable with `npm audit fix`) and 8 moderate in electron-builder's download chain.
- **The app:** `npm audit --omit=dev` is 0, so the app itself is clean.

**C-07 A followed folder move can switch off the "rename over an existing file = replace" protection for its files.** Low · Impact 1/10 · Hard 1/10 · since `0ea3648` · confirmed by code, narrowed
- **The trigger:** a move reported file by file (a sync client) and also followed from the sidebar's tree read.
- **How long it lasts:** only until the next event or Filo write for that file.
- **Where:** `fileWatcher.ts:1021-1022`; `fileWatcherOwnMoves.ts` `rekey` copies `presence = false` over the new paths.

### 3.5 The editor (D)

D-01, D-02 and D-08 all come from the one uncommitted CSS rule (`.tiptap p:has(+ p) { margin-bottom: 0 }`) and should be fixed together, after decision D1. Finder D checked the rest of the change (the selector's specificity, the card preview matching the editor, the page view's measurement) and found it sound.

**D-01 With paragraphs closed up, every list now stands looser than the text around it.** Medium · Impact 2/10 · Hard 1/10 · uncommitted · confirmed (Chromium, built app)
- **What you see:**
  - Paragraphs touch, but bullet items are 20 px apart in a Document tab, checklist items 25 px, and list items 13 px in tiles and cards.
  - Before the change, paragraphs and list items both had the same gap. Section 7 has your `Duplicate Review` note as an example.
- **Older, but now visible:** there is no paragraph-spacing setting, although the design doc's toolbar lists "Line & paragraph spacing"; Line Spacing changes only the line height.
- **Undocumented:** the change is recorded only in a CSS comment, nowhere in CLAUDE.md, KNOWN_LIMITATIONS or the design doc.
- **Where:** `src/css/style.css:1036-1039` and `DocumentEditor.svelte:742-745` still give each list item's one paragraph a bottom margin, which `p:has(+ p)` never matches.

**D-02 A line break now looks exactly like a new paragraph, so a block command on "one line" changes the whole block.** Medium · Impact 3/10 · Hard 3/10 · uncommitted (the cue); the behaviour is older (`6e15477`, `0983a46`) · narrowed
- **What you see:**
  - Notes from Keep and Canvas, plain-text pastes and Shift+Enter all hold lines joined by single line breaks. They now look identical to separate paragraphs (39 px against 39 px).
  - Your `04 Worldbuilding/Leveling System Ideas.md` has a 19-line block like this, "**Potential stats**". Its lines "Physical (likely capped)" and "Edge stats worth considering" look like subheadings.
  - Choosing Heading 3 or a list button on one of them changes all 19 lines. It saves as `## Dear Aria,<br data-filo-soft-break>…`.
  - Ctrl+Z undoes it.
- **Fix ideas:** keep a small visible cue between paragraphs (decision D1), and/or make a block command split the paragraph at the line breaks around the caret first.

**D-08 Enter at the end of a line-broken line seems to do nothing, and what you type next joins the following line.** Medium · Impact 3/10 · Hard 2/10 · found by Refuter 1 · older (`0983a46`); the uncommitted change removes the only visible sign
- **What you see:**
  1. In that stat block, End, then Enter on "Strength – raw power".
  2. No new line appears. The caret moves to the start of "Endurance…".
  3. Typing "Speed" gives "SpeedEndurance – stamina".
- **Why:** `lib/editor/softBreak.ts:201-217` turns the line break into a paragraph boundary and hands Enter on. The caret then lands at the start of the next paragraph, which `softBreakEnter.test.ts` pins as intended. Under the old CSS a gap at least appeared.
- **Fix:** turn the break into a boundary and then open an empty paragraph at the caret (A, empty, B), as Enter at a paragraph's end does.

**D-03 The page view makes typing in a very long note stutter.** Low · Impact 1/10 · Hard 3/10 · since `f830c42` · confirmed
- **What you see:** at about 100,000 words with pages on (the default), measuring pages keeps the main thread busy 1.5 s of every 3.8 s of typing, with pauses up to 90 ms. At 40,000 words the cost is small, and at 20,000 it is negligible. You keep one chapter per note, hence Low.
- **Where:** `lib/editor/pageBreaks.ts:163-209` re-measures every block after every edit. `nodeDOM` is a linear scan per block, about 109 ms at 5,000 blocks.
- **Fix:** measure from the first changed block down, walk `view.dom.children`, skip when the height didn't change, and pause longer for long notes.

**D-04 Ctrl and + on the number pad (or Ctrl+Shift+=) doesn't zoom in, and no zoom key works in the Raw view.** Low · Impact 1/10 · Hard 1/10 · since `f830c42` · confirmed, repro fails
- **What still works:** Ctrl+=, Ctrl+wheel and the buttons.
- **Where:** `DocumentEditor.svelte:254` binds only `=`, and the zoom commands lack `allowInField`.

**D-05 Pasting two lines into a tile, card or frame title puts a line break in the note's title.** Low · Impact 1/10 · Hard 1/10 · older · confirmed, repro fails
- **What you see:** `title:` becomes "Chapter One\n\nThe River". The placeholder rename then names the file `Chapter One--The River.md`.
- **Where:** `createEditor.ts:487-530` (the label editor allows paragraphs), `TileHeader.svelte:121` `getText()`, and `titleCommit.ts:28` only trims.
- **Fix:** keep a title to one paragraph, or join pasted lines with a space.

**D-06 An image's alt text loses `[`, `]` or `*` after a save.** Low · Impact 1/10 · Hard 1/10 · older · confirmed, repro fails
- **What you see:** `![Aria [sketch]](…)` reopens with alt "Aria sketch".
- **Why it isn't flagged:** both versions render the same, so the note isn't read-only, and the next save writes the brackets away.
- **Where:** markdown-it's `renderInlineAsText` skips the tokens escapes produce.

**D-07 Turning Spelling off doesn't reach the Task List's notes box or title box.** Low · Impact 1/10 · Hard 1/10 · older (`f3370fe`) · confirmed
- **Where:** `TaskItem.svelte:747` (the `<textarea>`) has no `spellcheck` binding, and `toolbar.svelte.ts:102-109` updates only rich editors.

### 3.6 The four views and the interface (E, H)

**E-03 Task List Alt+Up / Alt+Down move a task by its order in the file, not on screen.** Medium · Impact 3/10 · Hard 2/10 · older (`f3370fe`) · confirmed, repro fails
- **What you see:**
  - **Under the default priority sort,** with file order A, B, C (low, high, medium) the screen shows B, C, A. Alt+Up on C switches to Manual sort and the screen becomes A, C, B: the whole list rearranges.
  - **Under Manual sort,** moving C up past a task with a subtask takes two presses. The first changes nothing visible, but still writes the board and adds an undo step.
- **Design doc:** :801 says "keys and ranges follow the screen". Phase 4 fixed the arrows, Shift-click and Ctrl+A, but not these two keys.
- **Where:** `lib/tasklist/taskListKeyboardNav.svelte.ts:154-230` moves the placement index ±1. The drag path rebuilds from the order as drawn.
- **Fix:** take the target from `renderedRows`, as drag does.

**E-01 On a Task List, Escape never closes the Search panel.** Low · Impact 2/10 · Hard 1/10 · **regression** from `f083071` · confirmed, lowered
- **What you see:** Search open, click a task row, press Escape: the panel stays. It works on a Mind Map or Kanban, and with focus inside the panel.
- **Why:** `TaskListBoard.svelte:1095-1097` calls `preventDefault()` on every Escape, though `cancelSectionDrag` acts only during a drag. The Search panel then sees the key as taken. In a split view the same listener can also swallow Kanban's Escape.
- **Fix:** prevent only when a drag was cancelled.

**E-02 Kanban: Shift-click ranges and the arrow keys reach the cards of a collapsed column.** Low · Impact 2/10 · Hard 1/10 · older · confirmed, lowered
- **What you see:** card A in column 1, Shift-click card C in column 3, with column 2 collapsed: the selection holds column 2's hidden cards too. The menu says "4 cards selected"; Remove is undoable and keeps the notes. ArrowRight can select an invisible card.
- **Where:** `KanbanBoard.svelte:839-845` (`flatVisibleTileIds`) and `:618-621` (`navColumns`), through `visiblePlacementsForColumn`, which never checks `collapsed`. This is Audit-28 E-01's fix applied to the Task List but not Kanban.

**E-04 Task List Tab: a refused indent keeps the keyboard stuck.** Low · Impact 1/10 · Hard 1/10 · older · narrowed
- **The bug:** when an indent is refused (too deep, or the row above is in another section), Tab is swallowed and focus stays. The code's own comment promises "never traps keyboard users".
- **Not a bug, a decision (D2):** "indent under the row above" is the design doc's own rule (:801). With A > A1 above B, Tab puts B two levels in; with A > A1 > A1a above B, Tab is refused. Word and most outliners instead indent one level, under the nearest row at the same level.
- **Where:** `taskListKeyboardNav.svelte.ts:119-146`.

**E-05 A Kanban card added while the find bar or a filter hides it disappears without a word.** Low · Impact 2/10 · Hard 1/10 · older · confirmed
- **What you see:** Add Card makes `New Card.md`, but the card isn't drawn and its title edit never opens. Typing then reaches the board's keys (N reopens the picker), and each retry leaves another empty note.
- **Compare:** the Task List says "… was added, but the filters hide it" (`taskCreation.ts:325`).
- **Where:** `lib/kanban/kanbanTileCreation.ts:132-139`.

**E-06 The Kanban "menu key on a selected card" route doesn't exist.** Low · Impact 1/10 · Hard 1/10 · since `10d5d54` (its claim) · confirmed
- **What you see:** the arrow keys select a card but never move keyboard focus to it. The menu key opens nothing, so one card still can't be moved to another column from the keyboard.
- **Where:** `KanbanBoard.svelte:600-605` and `:927-935`, and `TileContainer.svelte:239`. The comment at `kanbanContextMenus.ts:20-21` is false.

**E-07 The Task List's bare N acts from the vault sidebar.** Low · Impact 1/10 · Hard 1/10 · older · confirmed
- **What you see:** N on a sidebar row moves the caret into the Task List's quick-add box.
- **Where:** `TaskListBoard.svelte:1063` lacks the `focusIsInBoard` check that Kanban and the Mind Map got in Phase 3.

**E-08 Folding a frame leaves the frames inside it drawn as empty boxes that still take clicks.** Low · Impact 2/10 · Hard 1/10 · older · confirmed
- **Where:** `MindMapBoard.svelte:150` (`paintedFrames`) and the hit test at `:282` keep frames inside a collapsed frame.

**E-09 A zoomed Document page starts under the docked sidebar on a laptop.** Low · Impact 2/10 · Hard 1/10 · since `f830c42` · confirmed by arithmetic
- **What you see:** at 1,366 px and 150% zoom, the first ~58 px of every line sit under the sidebar. 125% is fine at every width; your 1080p desktop at 100% is fine.
- **Where:** `lib/utils/sidebarLayout.ts:20` doesn't know the zoom.

**E-10 Zoomed table columns drag at the zoom's speed.** Low · Impact 1/10 · Hard 1/10 · since `f830c42` · plausible by code
- **What happens:** at any zoom but 100%, dragging a table column's border moves it at the zoom factor times the pointer's speed.
- **Where:** prosemirror-tables' `draggedWidth` adds screen pixels to an unzoomed width. The key gaps are D-04.

**E-11 Mind Map arrow keys and N ignore what the sidebar covers or what is off screen.** Low · Impact 2/10 · Hard 2/10 · **regression** from Audit-28's Phases 1, 3 and 4 · confirmed by code
- **The arrow keys:** at 1,340 px and wider, an arrow key can select a tile under the docked sidebar without panning to it.
- **N:** N beside a selected tile that is off screen makes the new tile off screen. Its title edit is dropped after 2 s, so typing reaches the canvas keys, and each "n" makes another empty tile. That is Audit-28's H-01 again, by another route.
- **Where:** `MindMapBoard.svelte:408-416` and `:543-551` don't use BL-40's `newTileView`.

**E-12 The same action behaves differently between views.** Low · Impact 2/10 · Hard 2/10 · older · three spot-checked and confirmed
- **Escape:** clears the selection on Kanban and the Task List, but not on the Mind Map.
- **The sidebar's Escape:** it clears its multi-selection without saying so (no `preventDefault`), so the same Escape also closes Search (`VaultSidebar.svelte:196-205`).
- **"Delete from vault…":** on a task's menu and the sidebar's, never on a Kanban card's.
- **Delete with a selection:** on a Task List row it removes that row only; on Kanban, Delete removes the selection.
- **Ctrl+A:** does nothing on Kanban.
- **Menus:** the task menu "cycles" priority, while the card menu picks one by name. Move to column comes after the danger item.
- **Command names:** "Kanban: Add tile" and "Kanban: New card" do the same thing.
- **The new-card picker** says "Markdown note backed by a vault file" and "URL preview tile".
- **Dates:** the Kanban date picker has no time box; the Task List's does.

**E-13 Help → Shortcuts misses most row, card and editor keys.** Low · Impact 1/10 · Hard 1/10 · older · confirmed
- **What's missing:** the Task List row keys (Space, Enter, Delete, 0-4, D), Kanban's arrows, Enter, Delete and "/", and the editor's list and heading keys. A board's own commands show only while that board is mounted.
- **Design doc:** :725 promises "all Shortcuts".
- **Stale comment:** `KanbanBoard.svelte:919-926` wrongly says the Kanban keys are registered commands.

**E-14 A link reference definition between paragraphs turns into blank lines, and its links never resolve.** Low · Impact 1/10 · Hard 2/10 · older · confirmed
- **What it does:** `See [the map][m] here.` plus `[m]: https://…` loads as two empty paragraphs and a literal `[the map][m]`. Such a note opens read-only (KL #17).
- **KL #17 is wrong here:** it says a used definition's link is "written inline". Take ownership actually saves `[the map][m]` as plain text, and the address is lost. The uncommitted preview change just shows on cards what the editor always did.
- **Where:** `lib/editor/emptyParagraphs.ts:63-95`.

**E-16 Tidying.** Low · Impact 0/10 · Hard 1/10
- **Dead CSS variables:** `--body-text-color` (`TileContainer.svelte:146`), and `--frame-bg-opacity` and `--frame-border-color` (`Frame.svelte:144-145`) are set but never read.
- **Stale comment:** `sidebarNewItems.ts` still names the old "New Folder" button.
- **Developer wording:** `SideToolbar.svelte:182` says "tile(s)".

**H-02 The read-only banner names a harmless line, not the one that makes the note read-only.** Low · Impact 2/10 · Hard 2/10 · older · confirmed on your own note
- **What you see on `Duplicate Review.md`:** "Filo can't save this file without changing formatting it doesn't support, so it's open read-only.Saving would add a blank line above line 8."
  - **The wrong line:** line 8 is a cosmetic blank line. The real cause, line 18 (a bullet list that turns into a checklist), comes third in Take ownership's list, and is also described only as "a blank line". So Take ownership is chosen on false information.
  - **The missing space:** "read-only.Saving" is Svelte 5 trimming a space before an `{#if}`.
- **Where:** `lib/editor/lossyChanges.ts` and the banner. KL #17 says the banner names the change, which understates this case.

**H-03 A blank line typed at the end of a note doesn't survive reopening.** Low · Impact 1/10 · Hard 1/10 · older (`f3370fe`) · confirmed in the built app
- **What you see:** `Last line`, Enter, Enter is saved as `…\n\n\n`. Reopened, the empty line is gone; Ctrl+End then lands on the last text line, and the next save drops the blank lines from the file.
- **Where:** `encodeEmptyParagraphs` rebuilds empty paragraphs only between blocks, never at the start or end.

**H-04 The sidebar cuts names short, and two empty panels sit over the Mind Map's tiles.** Low · Impact 2/10 · Hard 1/10 · older · confirmed
- **The sidebar:** each row always keeps 100 px free for its hover buttons (`VaultFileItem.svelte` around line 765), so "03 Characters" shows as "03 Charac…" even with the buttons hidden.
- **The Mind Map:** on a fresh profile the empty Waypoints panel ("No waypoints yet") and the minimap sit over the tiles.

**H-05 Your agent-written note opens read-only.** Non-issue (documented) · Impact 2/10 · Hard 4/10
- **The cause:** `Duplicate Review.md` mixes bullets and checkboxes in one tight list, which KL #17 documents as read-only.
- **What's worth knowing:** the agent you use writes this shape (section 7). Track B's raw blocks (backlog section 3) would let the rest of such a note stay editable.

### 3.7 Refuted, non-issues, and claims the refuters narrowed

These are listed so they aren't re-filed:

| Claim | Outcome | Why |
|---|---|---|
| B-07: the tag editor's file-path mode and `fileTagsStore.addTagToPath` / `removeTagFromPath` are dead code | **Refuted** | The sidebar row's tag button and its menu's Tags item both open it (`VaultSidebar.svelte:588`). Only a comment in `TagEditor.svelte:26` ("and the Document board") is stale. |
| H-05: your agent-written note opens read-only | Non-issue | KL #17 describes exactly this shape. |
| H-01, E-15 | Duplicates | H-01 is D-01; E-15 is D-02. |
| C-01: the stale version and packages are Medium | Lowered to Low | Harmless alone, since you don't run them. The real risk is C-08. |
| E-01, E-02 | Lowered to Low | E-01: Escape inside the panel and the close button still work. E-02: rare; the menu shows the true count; Remove is undoable. |
| E-04: Tab indents under the wrong row | Narrowed | The depth rule is the design doc's (decision D2). The Tab trap is the bug. |
| A-02, A-04, C-03, C-07, D-02 | Narrowed | Real, but with a narrower trigger; each entry above uses the refuter's wording. |
| D-01 Medium at Impact 2/10 | Kept Medium | You'll see it in every note with a list, every day. |
| E-11, D-07 | "Since" corrected | E-11 comes from Audit-28's own phases; D-07 predates the last audit. |

## 4. What the recent changes could have broken

The last audit's base was `6c5f5a3`. Since then there have been 11 commits (about 270 app files and 10,000 lines added), plus the uncommitted change. Each was reviewed by the finder for its area and by me.

| Change | Commit | Verdict |
|---|---|---|
| Phase 0: version in Settings, board folders for new vaults | `40b0e87` | Sound. The version hasn't moved since (C-01). |
| Phase 1: your text first (Raw view undo, Reload keeps a copy, paste spans, new cards take the caret) | `6b590fe` | All four Highs fixed and holding. **Introduced A-03** (Reload can adopt an older read). Missed one route (A-01, the notes box). The 2-second title-edit drop is part of E-11. |
| Phase 2: formatting that survives a save | `e14866f` | Sound under an extended fuzz (four seeds, 2,900 documents). D-07's spell-check gap predates it. |
| Phase 3: making and finding notes (new note, placeholder renames, new-note undo, templates) | `decd96c` | Sound at its core. Brought A-04 and A-05. E-07 (the Task List missed the focus rule) and E-11 (bare N). B-01 to B-03 predate it. |
| Phase 4: Task List and Kanban correctness | `10d5d54` | The arrows, Shift-click, Ctrl+A, Group By, the date picker and quick add are sound. **Missed:** Alt+Up/Down (E-03), the Tab trap (E-04), the same fix on Kanban (E-02, E-05), and the menu-key claim (E-06). `selectByKey` is part of E-11. |
| Phase 5: the interface around the views (Escape protocol, text menu, toolbar density, nesting) | `f083071` | **Broke Escape on the Task List (E-01).** Nested frames: E-08. The rest checks out. |
| Phase 6A: sync and recovery (watcher presence, overflow walk, Settings → Recovery, note conflict copies) | `0ea3648` | Sound. One narrow gap (C-07). |
| Phase 6B: notes and boards (`changesBoardFile`, `keyDelta`, scheduler, BoardRouter) | `3195b17` | Sound: every command checked. |
| Phase 7: hardening (`.filo/` guards, `getPublic`, name caps, legacy fields) | `e76ed0b` | Sound. C-04 is older. |
| Phase 8 + BL-40 (new tiles clear of the sidebar) | `409a697` | Sound for placement. Keyboard selection doesn't use it (E-11). |
| The page view and zoom | `f830c42` | Layout and click placement are right at every zoom, in both editors. Brought D-03 (very long notes), D-04 (keys), E-09 (sidebar) and E-10 (table drag). |
| No gap after Enter; blank lines in card previews | uncommitted | The preview part is sound. The CSS part does what was asked for prose, but brings D-01 and removes the only cue for D-02 and D-08. |

**The pattern again:** each round's fixes leave small regressions exactly where they land. This round's were E-01, E-11 and A-03, and Phase 4 fixed the Task List but not the same code path on Kanban. They are much smaller than last time's (no High), but they come from the same cause: **key handling and "what's on screen" are computed in several places**, so a fix in one doesn't reach the others. Section 5 and the plan's Phase 3 aim at that.

## 5. Redundancy, legacy code, gaps and docs drift

### 5.1 The same thing done more than once

Audit-28's duplicates are gone: one day parser, one priority vocabulary, one date picker, one Mind Map delete flow, one Select All. What's left:

- **Key handling lives in four places:** the command registry, window listeners, capture-phase handlers, and per-row handlers. E-01, E-07 and E-12 come from them disagreeing. A board-level "who handles this key" rule (registry first, then the board, with one Escape protocol) would stop the drift.
- **"Cards on screen" is computed twice on Kanban, and both copies ignore collapsed columns.** `flatVisibleTileIds` and `navColumns` (E-02).
- **Two ways to reorder a Task List.** Drag rebuilds from the order as drawn; Alt+Up/Down moves the file index (E-03).
- **Two ways to add tiles.** Single adds register their new notes for undo; template adds don't (B-01).
- **Two kinds of delete undo.** Sidebar deletes register with Settings → Trash; "Delete tile and file" doesn't (B-05).

### 5.2 Legacy and dead code

- **Dead CSS variables:** three (E-16).
- **Stale comments:**
  - `TagEditor.svelte:26` (B-07);
  - `KanbanBoard.svelte:919-926` (E-13);
  - `kanbanContextMenus.ts:20-21` (E-06);
  - `taskListKeyboardNav`'s "never traps" (E-04);
  - `sidebarNewItems.ts` (E-16).
- **A documented key nothing uses:** the board-template skeleton schema's `"settings"` (B-02).
- **Legacy kept on purpose:** board-file fields nothing reads (BL-39, waiting for the first format step), and an older note's `parent:` (KL #44).
- **Markers:** no TODO, FIXME or HACK anywhere; 21 `DECISION:` comments (18 at Audit-28).

### 5.3 Gaps against the design doc

- "Line & paragraph spacing" in the toolbar: only line spacing exists (D-01).
- Template `settings` (B-02).
- "Help lists all shortcuts" (E-13).
- "Keys and ranges follow the screen", for Alt+Up/Down (E-03).
- Templates from every board (BL-32).
- Tile copy and paste (backlog decision).

### 5.4 Docs that no longer match the code

- **KNOWN_LIMITATIONS:**
  - #7 says same-name renames "always pair, at any size": not when the bytes changed in the same moment (C-02).
  - #31 says an unsaved edit is kept behind Keep mine, but hides the fork (C-02) and the 30 s folder case (C-03).
  - #17 says the banner names the change: it can name a cosmetic line first (H-02).
  - #17 says a used reference definition's link is written inline: the address is lost (E-14).
  - **Missing:** blank lines at the start or end of a note (H-03), and the paragraph-spacing change.
- **CLAUDE.md:**
  - "Settings → Trash restores through the delete's undo … so the tiles come back too" holds only for sidebar deletes (B-05).
  - Nothing describes the paragraph rule.
- **The design doc:** "Line & paragraph spacing" (D-01); paragraph spacing isn't described anywhere.
- **The backlog:**
  - BL-31 is stale. Board templates have been left out of Kanban's card picker since the first commit; only one whose `filo-board` block isn't valid JSON is listed.
  - BL-41 could not be reproduced.
  - Section 3's line counts are stale: TaskItem is 1,161, not 1,180; the file nearest the limit is now `KanbanBoard` at 985 of 1,000.

### 5.5 Size and complexity

- **The app has grown to about 144,800 lines** (Audit-28: 138,000) and the tests to about 149,500 (136,600). CLAUDE.md is 1,125 lines and KNOWN_LIMITATIONS 1,694, with 53 entries.
- **Files at their limit:**
  - **The three allowlisted files sit exactly at their ceilings:** `KanbanSideToolbar` 1,248, `TaskListBoard` 1,170 and `TaskItem` 1,161 lines of code.
  - **`KanbanBoard`** is at 985 of 1,000, so the Kanban fixes (E-02, E-05, E-06) need its keyboard and selection code moved into `lib/kanban/` first.
- **Recommendation, as last time:** prefer fixes that reuse one mechanism over adding another. Here that means one key-handling rule, one "on screen" list per board, and one new-note registration for every add path.

## 6. The backlog, re-checked

Every open item in `docs/BACKLOG.md` was checked against today's code. "Plan" means the draft plan (`AUDIT29_IMPLEMENTATION_PLAN_2026-10-08.md`) takes it.

### 6.1 Small findings

| Item | Still there? | What to do | Impact | Hard |
|---|---|---|---|---|
| BL-07 Task List speed budget has the least room | Passed today, with five agents running tests at the same time | Keep | 1/10 | 4/10 |
| BL-08 About 0.4 MB kept per reload into the same editor | Not re-measured. Your agent's outside edits make reloads of open notes more frequent. | **Plan** (optional, Phase 2): measure it in the built app after 200 outside edits to an open note; fix only if it grows there | 2/10 (was 1/10) | 3/10 |
| BL-09 Real-disk tests can miss under heavy load | Today's full run passed under the same load | Keep | 0/10 | 2/10 |
| BL-15 to BL-18 Notes that read differently on GitHub | Not re-checked | Keep for Track B. You don't read your notes on GitHub. | 1/10 | 2/10 to 3/10 |
| BL-21 CI's runner moves to Ubuntu 26 on 19 October | Still ahead (11 days), and 11 commits wait to be pushed | **Plan** (Phase 0): push before 19 October, so the switch is tested on its own (C-05) | 1/10 | 1/10 |
| BL-28 Kanban 300 switch-back budget spikes | Passed today | Keep | 0/10 | 2/10 |
| BL-31 Kanban's "From Template…" lists board templates | **Stale.** Excluded since the first commit; only a template whose `filo-board` block isn't valid JSON is listed. | **Plan** (Phase 5): leave those out too (or say the block is broken) and close BL-31 | 0/10 | 0/10 |
| BL-32 Board templates start only from a Mind Map | Yes | **Plan** (Phase 5), with B-01 to B-04: the templates phase | 1/10 | 2/10 |
| BL-35 The Task List's Table of Contents covers the list on laptops | Yes | **Plan** (Phase 3) | 2/10 | 2/10 |
| BL-39 Board-file fields nothing reads | Yes (by design, waits for the first format step) | Keep | 0/10 | 1/10 |
| BL-41 Quitting after an Apply in Global Defaults asks about unapplied changes | **Could not reproduce** through five routes: three built-app tours, Finder B's whole-app test, and Finder B's Chromium test. Nothing in its path changed since `409a697` except the Page Layout select, which writes only on change. | **Plan** (Phase 6): pin "quit after Apply exits" as an E2E case and close BL-41 unless you see it again | 2/10 | 1/10 |

### 6.2 Decisions waiting on you

| Item | Recommendation | Useful | Hard |
|---|---|---|---|
| Tertiary text in the other four themes (KL #47) | Decide once you settle on a theme; you use Light. | 2/10 | 1/10 |
| Light's hovered and selected rows | Darken a touch next time the theme is touched | 1/10 | 1/10 |
| Tile copy, paste and duplicate (`mindmap-10`) | Keep as a feature request | 5/10 | 4/10 |
| The Search panel's Find All popup | Drop it: the panel's own list covers it | 1/10 | 1/10 |
| Headings for the sidebar's Group By | Add them when the sidebar is next touched (H-04 is there too) | 2/10 | 2/10 |
| Removing one card or task | Now joined by E-12's missing "Delete from vault…" on a Kanban card. Decide both together (plan decision D6). | 2/10 | 1/10 |
| Folding a group inside a Task List section | Keep | 2/10 | 2/10 |

### 6.3 Bigger work deferred on purpose

| Item | Recommendation | Useful | Hard |
|---|---|---|---|
| Track B1: write note bodies without `tiptap-markdown` | Keep deferred. Today's fuzz is clean apart from D-06. | 6/10 | 6/10 |
| #17 raw blocks | **Raised.** Your agent writes mixed bullet and checkbox lists (H-05), so agent-written notes will keep opening read-only. Raw blocks would keep the rest of such a note editable. Before that, asking the agent not to mix them is free (section 7). | 6/10 (was 4/10) | 6/10 |
| Track B2: Markdown-text editor spike | Stays shelved | 2/10 | 5/10 |
| Splitting files of 900+ raw lines | **Do `KanbanBoard` now**, as the first task of the plan's Phase 3: it's 15 lines under the limit and three fixes land in it. | 6/10 (was 5/10) | 3/10 |
| A refactor pass on the three allowlisted files | Keep. The Task List fixes (E-03, E-04, E-07) land in `taskListKeyboardNav.svelte.ts`, not in them. | 4/10 | 6/10 |
| #34 hard-linked notes read-only | Keep | 1/10 | 2/10 |

### 6.4 Known limitations the Audit-27 review suggested improving

| # | Recommendation | Useful | Hard |
|---|---|---|---|
| #7 and #31: follow moves by file ID; measure sync timing | **Partly in the plan:** C-02 and C-03 fix the two cases your agent actually produces. File-ID pairing stays deferred. | 4/10 (was 3/10) | 5/10 |
| #20 Record each machine's Filo version | **Plan** (Phase 0), the cheap half: the version bumped per build, and the commit id shown in Settings | 4/10 | 1/10 |
| #28b A "recent vault changes" list with Undo | Keep. More useful now that an agent edits the vault, but it's a feature. | 6/10 | 6/10 |
| #17b, #6, #5, #12, #24, #35, #14 + #15, #21, #25, #46, #42 | Keep as they are | 1/10 to 5/10 (as scored in Audit-27) | 2/10 to 5/10 |

## 7. Your real use so far, and a setup checklist

**What Filo did to your book vault on 7 October** (read from the vault, never written; all tests ran on copies):
- **The vault:** Filo created `.filo/` with board-specific folders on, and one Mind Map board (format 8, no legacy fields) holding five of your existing notes.
- **The trash:** Filo's trash holds three items you deleted: the `05 Book Meta` folder, `Home.md` and `00 Inbox/From Phone.md`.
- **What's missing, which is good:**
  - There is no `.filo/recovery/` folder. That means there were no conflict prompts, no rescue copies and no shrink copies, even with the outside reorganisation.
  - No note holds a Filo writing artefact (`&#32;`, stray `<span>`, soft-break tags).
- **Your 20 notes:** 19 open editable, and a save writes them back as they are, or with only a blank line added between blocks or one trailing space dropped. The one read-only note is `Duplicate Review.md` (H-05, H-02).
- **The paragraph change:**
  - Your notes now mix one blank line (older paragraphs) with two (gaps you typed after the change). In Filo the first are tight and the second show a gap. Other Markdown apps, and a phone app later, show both the same.
  - Your `Leveling System Ideas.md` and `Old Magic Ideas.md` hold line-broken blocks, the shape D-02 and D-08 affect.

**Checklist:**

1. **Stop running your vault under `npm run dev` (C-08).** For real work, use one of these:
   - `npm run preview`. It builds the app and runs the built copy on your normal profile, with no dev server, so another session's edits can't reload it.
   - Or package and install: `npm run package:win`, then run the installer.

   A rebuild by another session doesn't touch a running copy; restart Filo to pick up a new build, after each phase lands. Keep `npm run dev` for development, ideally on a scratch profile (the plan's task 0.1 adds a `dev:scratch` script for that).
2. **Push the 11 local commits to GitHub before 19 October (C-05, BL-21).** That gives them an off-machine copy and runs the Linux check before the runner changes. I haven't pushed; it's your call.
3. **Decide the paragraph look before committing the uncommitted change (decision D1).** Until then, use Shift+Enter or Enter as before; just know that a block of line-broken lines takes a heading as a whole (D-02).
4. **When an agent reorganises your vault, close Filo first, or at least have no unsaved typing in the notes it moves (C-02, C-03).**
   - Ask it not to mix bullets and checkboxes in one list (`- a` then `- [ ] b`): separate them with a blank line or a heading, so Filo can edit the note (H-05).
   - If a "deleted by another program" prompt appears right after an agent ran, look in the new folder before choosing Keep mine.
5. **In a "changed by another program" toast in a task's notes box, choose Keep mine,** which backs up the other side, not "Use theirs" (A-01).
6. **Keep a real backup.** Filo's trash and `.filo/recovery/` live inside the vault, so they are not backups. Windows File History on `C:\Users\andre\My Files\Vaults` covers it.
7. **If you add Syncthing later:** PC Send Only, phone Receive Only, Staggered File Versioning on the phone (unchanged from Audit-28).

## 8. What was checked and found sound

So nobody re-checks these without cause:

- **Notes (Finder A):**
  - The note writer: a fresh read per flush, the stat and hash check, body drift becomes a conflict, frontmatter deltas on a fresh read.
  - Placeholder renames, checked case by case:
    - a queued or in-flight write;
    - a target name taken in another case;
    - undo and redo after further renames;
    - two views editing the same title;
    - the leave gate;
    - titles mapping to one stem.
  - New-note undo for body text: typed text goes to the trash with the note, never lost.
  - Reload's copy and Undo reload.
  - The Raw view: Audit-28's A-01 fix holds, skipped saves keep a rescue copy, and "Use the new version" keeps a copy.
  - The long-note 1 s serialise, holding read-only while converting, and the file-name rules.
  - The uncommitted preview change is display-only.
- **Boards (Finder B):**
  - Every command's `changesBoardFile()`, and per-key undo with same-shaped records.
  - `SetSectionCollapsedCommand`; the scheduler's captures and healing; `lastViewFlush` defaults.
  - `isStaleInlineCopy`, `boardShapeProblem`, the project-mirror removal, `addTile` returning false.
  - `globalDefaultImages`.
  - The page layout, zoom, panels and spell-check settings are written only when not default.
  - The whole-app flow "rename a board with folders on, undo, redo" (every note and tab follows).
- **Lifecycle, sync and security (Finder C):**
  - **The watcher:** its presence map (memory bounded), the overflow walk (also during a vault swap), followed moves, case-only renames, and an 80-note burst and a plain restructure while open (both followed).
  - **Recovery:** Settings → Recovery's path checks (no `..`, absolute, UNC or junction escapes) and its Recycle Bin hand-off.
  - **Guards:** the `.filo/` guards on the disk's spelling, and `vault:copy-file`'s approved sources.
  - **Main-process services:** `getPublic` (DNS and connected-address checks, every redirect hop, size and time caps), the clipboard payload, the text menu IPC (sender-checked, 300 ms timeout), new IPC channels all in the union and schemas and answered through envelopes, the packaged CSP, and session end.
- **The editor (Finder D):**
  - The `:has()` rule's specificity and cost: 1.4 ms per key at 100,000 words.
  - The card preview against the editor (18 shapes, equal heights in Chromium).
  - The page view's layout at 100% and 125% with a real fiction note.
  - Click placement under zoom at 75% to 200% in both editors, Ctrl+wheel, and the font size box under zoom.
  - The serializer under an extended fuzz.
  - One-line titles with Enter and IME.
- **The views (Finder E):**
  - Phase 4's `renderedRows` (arrows, Shift-click, Ctrl+A), Group By inside sections, the date picker's focus trap, quick add.
  - One Mind Map delete flow and Select All; the Mind Map's arrows skip folded frames.
  - All 87 IPC channels are used.
  - CLAUDE.md's project tree matches the disk both ways, and every constant it quotes matches the code.
- **Suites on Windows today** (HEAD plus the uncommitted change, in a separate worktree):
  - `ci:verify` passed: lint, knip, svelte-check, main typecheck, 873 test files (8,520 passed, 5 skipped), build, and 91/91 gates in 358 s, while five finders ran tests alongside.
  - The E2E suite passed 47/47 with the scale budgets, in 3.5 minutes.
  - The corpus: 0 outputs changed and 0 newly read-only across 734 notes compared with the Audit-28 Phase 8 baseline (2 more were moved to `docs/archive/`, 5 were edited between runs).
- **Built-app tours** (book-vault copies, fresh profile): no console errors, and every quit exited cleanly. The flows checked:
  - a new Mind Map tile titled by typing was renamed to `Hydra Lore.md`;
  - undo reverted the name, then trashed the empty note, and redo brought it back and cleared the trash entry;
  - two Kanban cards were named by typing;
  - quick add "… tomorrow !high every friday" set the priority, the date (9 Oct) and a weekly repeat;
  - the version showed in Settings;
  - Settings → Recovery opened;
  - widths of 1,440, 1,280 and 1,100 px.

## 9. How the audit was done

- **Agents:** you chose 5 finders and 2 refuters. Every prompt said "no helper agents", and none were spawned.
  - Finder A: notes and everything that writes, renames, rescues or discards a note's text.
  - Finder B: boards, undo, `.filo/` settings, trash, tags, templates.
  - Finder C: the main process, lifecycle, the watcher and outside changes, recovery, security, release.
  - Finder D: the editor, Markdown fidelity, the page view and zoom, the uncommitted change.
  - Finder E: the four views, the interface, code health and docs.
  - Refuter 1 checked Finders A, B and D (and E-14). Refuter 2 checked Finders C and E, and my hands-on findings.
  - Both refuters re-ran every repro for the Mediums and most Lows, and each found one new finding (C-08 and D-08).
- **Usage facts found on the way and given to the agents:** the outside agent's reorganisation on 7 October, and (from you) that you run `npm run dev`.
- **My own checks:**
  - `ci:verify`, the full E2E suite with scale budgets, and the corpus check, in a separate worktree of HEAD plus the uncommitted change, so the agents' temporary test files couldn't interfere.
  - Read-only checks of your vaults: the board format, Filo's trash, the absence of a recovery folder, and writing artefacts.
  - The corpus check on copies of your current notes.
  - Five scripted tours of the built app on copies of your book vault, with screenshots: the H findings, the paragraph spacing, the BL-41 attempts, and trailing blank lines.
  - The 11 commits reviewed against each finder's verdict.
  - The backlog, re-checked item by item.
- **Repro tests:** about 45 tests, each failing on today's code as described (or passing, for the "sound" checks). They are in this session's scratchpad (`…\72e6211b-2ce6-4339-a7f6-026c33750d39\scratchpad\repros\finder*` and `refuter1`), not in the repo. The tour scripts and screenshots are under `…\scratchpad\ux\`. The repo is as it was: only your five uncommitted files are modified.
- **Not reached, or only lightly:**
  - Timer, Audio, Link and Embed tiles (read briefly; nothing found).
  - Connection routing.
  - IME with a real Windows input method.
  - Files dropped from Explorer onto an editor.
  - Minimap speed on a large board.
  - Memory over a long session (BL-08).
  - A live dev-mode reload on your real profile (C-08 is from code and the module graph).

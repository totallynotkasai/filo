# Audit-28: pre-daily-use audit (2026-10-04)

A whole-system audit before you start using Filo every day: data integrity first, then bugs, logic errors, what the recent changes could have broken, gaps against the design doc, redundancy and legacy code, and the user experience of the four views you'll use (Documents, Mind Map, Kanban, Task List).

- **Code audited:** `main` at `6c5f5a3`. During the audit another session added `ead80a3`, a one-line note in an archived plan; no code changed.
- **Your setup, as you described it:** the vault lives on this PC. You might later sync it to your phone with Syncthing, and you're unlikely to edit it with any other app.
- **Method:** five finder agents, two refuter agents that tried to disprove every finding, and my own checks, including driving the built app on a copy of your book vault. Section 9 has the details.

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

**Yes, you can start using Filo for your notes, with the setup in section 7 and a few habits until the first fixes land.** Nothing in this audit silently loses or corrupts notes in ordinary use: there are no Critical findings. The core of how Filo saves a note held up under the hardest scrutiny yet. Every save reads the file fresh, refuses to write over a version it hasn't seen, and backs up the other side before "Keep mine". On a copy of your book vault, every note opened editable and nothing changed on disk until you typed. Both test suites pass on this PC: 7,836 tests and 91 safety checks, plus 29 end-to-end runs of the built app.

But it isn't safe by default yet in four places you'll meet early:

1. **The Raw view can save garbled text (A-01, High).** It's a regression in today's new Raw view: Ctrl+Z after the note changed elsewhere writes a mix of both versions. It's an easy fix (Hard 2/10). Until then, don't press Ctrl+Z in the Raw view.
2. **Pasting from Word or a web page locks the note (D-02, High).** The note opens read-only next time. Nothing is lost and "Take ownership" unlocks it, but you'll hit it the first time you paste research. Use Ctrl+Shift+V until it's fixed (Hard 2/10). The related D-01 locks a note whose bold or italic phrase has two neighbouring words in different colours or sizes.
3. **New cards and tiles don't take the caret (H-01, High).** What you type next goes to shortcuts. On the Mind Map, each `n` makes another tile with its own empty note in your vault; I made five tiles while typing three titles. Click into a new card or tile before typing.
4. **You can't make a note except through a board (E-03, High).** There's no "New note" or "New folder here", and every note a board makes is named `New Card (n).md` or `New Tile n.md` in your vault's top folder (E-13, H-03).

Two release gaps come with these: there's no installer of today's code (the only one is from 8 June), and the app shows no version number (H-09).

**What I'd fix before day one** (plan Phases 0 and 1, about four to six working days with tests): A-01, A-02, D-02, H-01, H-03 and H-09, plus the small data-safety items (A-03, C-02, E-07). **In the first weeks:** the other formatting items (D-01, D-03 to D-06, D-09), the Task List order problems (E-01, E-02), and E-03 / E-13 (making and naming notes).

Severity and impact are judged for how you said you'll use Filo: one PC, perhaps a phone kept in sync later, no other app editing the vault. Several Low findings (C-04, C-05, B-02) only matter if something other than Filo changes the vault, and the Syncthing setup in section 7 rules that out.

## 2. Scores by area

**Overall for daily use: 6/10.** Data safety alone: **7/10.**

Audit-26 gave "9 overall", so why lower now? That score was mostly about data integrity, where it measured how well the known faults were fixed. This audit also scores the editor's paste and formatting flows and the four views as you'll use them, hands-on in the built app, and it found four new Highs. The scale is strict: 10/10 means nothing left to improve.

### Your data

| Area | Score | Why | Findings behind the score |
|---|---|---|---|
| Saving notes (the note writer) | 8/10 | Every save reads the file fresh, checks drift, and refuses to overwrite a version it hasn't seen (hash-checked up to 16 MB). Renames are followed mid-save, and rescue copies cover every kind of unsaved text. Only rare edges remain. | A-04, A-05 |
| Titles, tags and task fields in frontmatter | 9/10 | Source-preserving edits that keep comments, quoting, BOM, line endings and scene breaks. Duplicate keys are refused loudly. Nothing new found. | — |
| Conflicts with changes from outside | 6/10 | Nothing is ever overwritten silently, and Keep mine backs up first. But Reload discards your typing with no copy, the notes box shows stale text, and Syncthing conflict copies of notes aren't announced. | A-02, A-06, C-04, C-05 |
| The Raw view | 4/10 | Leave, quit, shutdown and rescue are handled. But Ctrl+Z after an outside change saves a mix (a regression in today's new Raw view), it saves only when you leave it, a skipped save reads as saved, and a tab switch evicts conflicted text. | A-01, C-02, A-05, A-07 |
| Saving boards | 8/10 | Audit-27's full-save fix holds under every interleaving traced. Drift holds and baselines are careful. One narrow race when another program moves a board, and needless rewrites. | B-02, B-04, BL-02 |
| Board format and older boards | 7/10 | An older board is never written over, and it's copied before its first save. No migration steps exist yet, the notice for old boards is misleading, and some legacy fields are still written. | B-06, B-08 |
| Filo's settings files (`.filo/`) | 8/10 | Each file has its own drift hold. A deleted file is recreated only if still absent, and a damaged one is salvaged with a backup. Minor: `tags.json` conflicts resolve to Filo's side. | — |
| Undo and redo | 7/10 | Guarded rollbacks, rename following, steps dropped on a board reload. Some steps put back whole objects. | B-09, H-07 |
| Trash and restore | 8/10 | A restore never replaces a file, the purge covers this machine only, and it asks before deleting for good. | — |
| Tags | 7/10 | Note tags are solid. Tags on link, embed and timer tiles can be misapplied after a delete-and-undo. | B-01 |
| Opening, closing, quitting, Windows shutdown | 8/10 | Save first, freeze the editors, settle, save again. Rescue copies when something is left. Shutdown is held only when work could be lost. | C-09, C-11 |
| Crash recovery and rescue copies | 6/10 | Crash sentinels name what was unsaved. But Raw view and notes-box text since the last click-away is lost in a crash, one bad item blocks every rescue copy, and the recovery warning repeats every open. | C-02, C-01, C-03 |
| Outside changes and Syncthing | 6/10 (8/10 with the section 7 setup) | Temp files, `.stversions`, own echoes and older-mtime deliveries are handled. A change-buffer overflow is ignored, conflict copies of notes are silent, and folder renames are followed twice. | C-04, C-06, C-10, C-05 |
| Security | 8/10 | Sandbox, payload validation, deny-by-default permissions, navigation guards, the media path guard. Two defence-in-depth holes that need hostile code. | C-07, C-08 |

### The editor

| Area | Score | Why | Findings behind the score |
|---|---|---|---|
| Formatting kept on save | 6/10 | A 4,000-run sweep across colour, font, size, highlights, lists and tables is stable. But pasted HTML and some realistic combinations make a note read-only, and title sizes and table column widths are dropped. | D-02, D-01, D-08, D-10, D-12 |
| Your notes opening editable | 8/10 | All 43 of your notes open editable, and ordinary prose (dialogue, `*actions*`, `[[links]]`, `#tags`) stays editable. Filo's own saves can still lock a note (row above). | — |
| Editor controls (toolbar, paste, lists, spell check) | 5/10 | The size buttons start from the wrong size, rich paste is unfiltered, list buttons scramble nested lists, scene breaks are mistyped, the spell-check toggle doesn't stick, and there's no right-click menu. | D-03, D-05, D-06, D-09, D-11, E-04 |
| Cards, tiles and titles | 4/10 | Lazy card editors and previews are sound. But a new card or tile doesn't take the caret, Enter splits a title, a title's size vanishes after editing, and an empty card shows no hint. | H-01, D-04, D-10, BL-14 |
| Editor speed | 7/10 | About 1 ms per keystroke even at 100,000 words. The save after a pause grows faster than the note: fine for a chapter, slow for a whole manuscript. | D-07 |

### The four views and the interface

| Area | Score | Why | Findings behind the score |
|---|---|---|---|
| Documents, tabs and panes | 5/10 | Notes edit well, but you can't create one directly. Tab shortcuts don't work while typing, per-document settings can't be reached, and keyboard focus doesn't activate a pane. | E-03, E-10, E-20, E-21 |
| Mind Map | 5/10 | Undo is solid and the feature set is rich. But new tiles don't take the caret and stack on one spot, single-letter keys fire from the sidebar, nested frames come apart, templates drop frontmatter, and keyboard selection doesn't pan. | H-01, H-02, E-08, E-09, E-12, E-18 |
| Kanban | 5/10 | Drag, filters and saved views are sound. But new cards don't take the caret, the due-date box saves at the first digit, placeholder file names, picked covers are copied, and no keyboard "move to column" for one card. | H-01, E-06, E-13, E-14, E-18 |
| Task List | 5/10 | Recurrence, dates and midnight rollover are right. But keyboard and Shift-click order are wrong under the default sort, quick add goes to the last section, Escape loses note text, quick add misreads words, the status filter and Group By are broken, and the date picker can't be used from the keyboard. | E-01, E-02, E-07, E-05, E-15, E-16, E-17 |
| Sidebar, search, tags and settings | 5/10 | Find and Replace is much improved. But "Chapter 10" sorts before "Chapter 2", Group By does nothing, placeholder names make notes hard to find, search shows no list, Settings is hidden, and a warning repeats every open. | E-11, E-13, H-05, H-06, C-03 |
| Keyboard and accessibility | 4/10 | Menus, dialogs and tab lists are good. But shortcuts leak where focus isn't, the Task List's keyboard order is wrong, the date picker is mouse-only, and keyboard selection is invisible. | H-01, E-08, E-01, E-10, E-17, E-18, E-21 |
| Matches the design doc | 6/10 | Most features are present. Missing: standalone Documents, the text right-click menu, template frontmatter and skeletons, per-document settings, "copy link" for boards and tiles, and images inside notes. | E-03, E-04, E-12, E-20, E-22, D-13 |

### Engineering and release

| Area | Score | Why | Findings behind the score |
|---|---|---|---|
| Code health (redundancy, legacy, dead code, size) | 6/10 | Strong safety checks and very little dead code. But five date parsers, three spellings of "urgent", two date pickers, a duplicated delete flow, legacy board fields, and four files over the size limit where consistency bugs hide. | Section 5 |
| Docs accuracy | 7/10 | CLAUDE.md matches the code apart from one overstated claim. The design doc has about ten stale statements. KL #29 and #30 understate two behaviours. | Section 5 |
| Tests and CI | 7/10 | 7,836 tests, 91 safety checks, real-Chromium editor specs, and 29 end-to-end runs of the built app, all green. But this audit found four Highs the suites never exercised: HTML paste, Raw view undo after a reload, focus after adding a card, the Task List's rendered order. Windows checks run only by hand. | — |
| Speed at scale | 8/10 | The 5,000-note budgets pass, even with five agents testing at the same time. Long single notes are the one weak spot. | D-07 |
| Release and install | 3/10 | No installer of today's code, the same version number as the June build, no version shown in the app, an unsigned installer, and the old installer still in `release/`. | H-09 |

## 3. Findings

Each finding has an ID by area:
- **A:** notes and the Raw view.
- **B:** boards, settings, undo, tags.
- **C:** vault lifecycle, outside changes, recovery, security.
- **D:** the editor.
- **E:** the views and the interface.
- **H:** found hands-on in the built app.

Severity and scores are after the refuter's review. "Older" means the problem predates the last audit's base (`abf5212`).

### 3.1 At a glance

80 findings went through review:
- **0 Critical, 4 High, 19 Medium, 54 Low.**
- **3 turned out to be non-issues for you:** B-06, B-08 and E-28.
- **One part of C-11 was refuted:** section 3.7 covers it.

Every High and Medium is listed here, and the Lows are in the second table. Every finding is explained in sections 3.2 to 3.6.

**High and Medium**, by impact:

| ID | Finding | Where you meet it | Severity | Impact | Hard | Since | Verified by |
|---|---|---|---|---|---|---|---|
| A-01 | Raw view: Ctrl+Z after the note changed elsewhere saves a mix of both versions | Raw view | **High** | 6/10 | 2/10 | `5fb4da8`, today's Raw view | Refuter (repro fails) |
| H-01 | A new card or tile doesn't take the caret; typing triggers shortcuts and makes stray empty notes | Kanban, Mind Map | **High** | 5/10 | 2/10 | older | Built app |
| D-02 | Pasting from Word or a web page makes the note open read-only next time | Every editor | **High** | 5/10 | 2/10 | older | Refuter (4/4 fail in Chromium) |
| E-03 | No way to make a new note or a subfolder except through a board | Documents, sidebar | **High** | 5/10 | 3/10 | older | Refuter |
| H-09 | No installer of today's code; the app shows no version | Installing | Medium | 5/10 | 1/10 | — | This PC |
| A-02 | Reload (or "Show the new version") in a conflict throws your typing away with no copy | Conflict prompt, Raw view | Medium | 4/10 | 2/10 | older | Refuter (repro fails) |
| A-03 | A title starting with a dot makes a hidden note (or a hidden board) | Task List, tiles, boards | Medium | 4/10 | 1/10 | older | Refuter (repro fails) |
| D-01 | A bold or italic phrase whose neighbouring words have different colours, sizes, fonts or highlights reopens read-only; a gap in underline or highlight after Ctrl+B | Every editor | Medium | 4/10 | 2/10 | older | Refuter (Chromium) |
| D-03 | The font-size box and its + / − start from 14 px whatever size the text is | Toolbar | Medium | 4/10 | 1/10 | older | Refuter (Chromium) |
| D-06 | Rich paste pins black text, the source font and pt sizes, and drops Google Docs highlights | Every editor | Medium | 4/10 | 3/10 | older | Refuter (Chromium) |
| E-01 | Task List arrow keys, Tab and Shift-click follow the file's order, not the screen's | Task List | Medium | 4/10 | 3/10 | older | Refuter (repro fails) |
| E-02 | Quick add files tasks into the last section, hidden if it's collapsed | Task List | Medium | 4/10 | 1/10 | older | Refuter (repro fails) |
| E-04 | Right-clicking text shows no Cut / Copy / Paste menu | Everywhere | Medium | 4/10 | 2/10 | older | Refuter |
| E-07 | Escape in a task's notes box throws away what you typed | Task List | Medium | 4/10 | 1/10 | older | Refuter |
| E-11 | The sidebar puts "Chapter 10" before "Chapter 2", and Group By does nothing | Sidebar | Medium | 4/10 | 1/10 | older | Refuter (repro fails) |
| E-13 | New cards, tiles and tasks keep names like `New Card (7).md` for good | Every board | Medium | 4/10 | 2/10 | older | Refuter, built app |
| H-03 | A new vault puts every board's notes in the vault's top folder | Setup | Medium | 4/10 | 1/10 | older | Built app |
| D-04 | Enter inside a tile, card or frame title splits it in two | Titles | Medium | 3/10 | 1/10 | older | Refuter (repro fails) |
| D-05 | The list buttons scramble a nested list, or do nothing | Toolbar | Medium | 3/10 | 3/10 | older | Refuter (Chromium) |
| E-06 | Typing a Kanban due date saves it at the first digit | Kanban | Medium | 3/10 | 1/10 | older | Refuter (Chromium) |
| E-10 | Ctrl+W and Ctrl+Tab do nothing while typing; Ctrl+S does nothing in quick add or the notes box | Everywhere | Medium | 3/10 | 1/10 | older | Refuter |
| E-12 | Markdown templates lose their frontmatter, `{{date}}` and board skeleton | Mind Map, Kanban | Medium | 3/10 | 2/10 | older | Refuter |
| H-04 | At laptop widths the sidebar covers the note and the toolbar is cut off | Everywhere | Medium | 3/10 | 2/10 | older | Built app |

**Low** (each is in sections 3.2 to 3.6):

| Impact | Findings |
|---|---|
| 4/10 | C-02 Raw view and notes box save only on leaving · C-04 Syncthing conflict copies of notes aren't announced |
| 3/10 | B-01 link, embed and timer tiles keep a stale copy that tag actions misuse · C-01 a file dragged from a hidden vault folder is linked, blocking rescue copies · C-05 a note renamed over another open note · D-09 a lone `#` scene break becomes a heading, `* * *` a list · E-05 quick add reads words as dates · E-08 Mind Map keys fire from the sidebar · E-09 nested frames come apart · E-15 the status filter finds nothing · E-19 the same action behaves differently between views · H-02 toolbar-made tiles stack on one spot |
| 2/10 | A-04 · A-05 · A-06 · A-07 · B-02 · B-07 · C-03 · C-06 · C-09 · C-10 · C-11 · D-07 · D-08 · D-10 · D-11 · D-12 · D-13 · E-14 · E-16 · E-17 · E-18 · E-20 to E-26 · H-05 · H-06 · H-07 · H-08 |
| 1/10 | A-S1 · A-S2 · B-03 · B-04 · B-05 · B-09 · C-07 · C-08 · E-27 · H-10 |

### 3.2 Notes, the Raw view and conflicts (A)

**A-01 Raw view: pressing Ctrl+Z after the note changed elsewhere saves a mix of both versions.** High · Impact 6/10 · Hard 2/10 · **regression** from `5fb4da8` (today's CodeMirror Raw view) · confirmed, repro fails
- **What you see:**
  1. You type in the Raw view and click away, which saves.
  2. The same note changes elsewhere: you edit it in a Kanban card or a Mind Map tile, or a sync delivers a new version.
  3. The Raw view follows the change.
  4. You press Ctrl+Z in the Raw view and click away.

  The file then holds text that matches neither version:
  - In the test, a typed line vanished and a fragment of the other edit was left behind: `The first draft.\n, edited in the card`.
  - After **Show the new version** followed by Ctrl+Z, the frontmatter was split across the body, with a second `---`.

  The mix is on screen before the save, but nothing warns you and no copy is kept. A change to the frontmatter only (a Task List tick, say) is harmless when you typed in the body.
- **Why:** the Raw view loads text from disk without adding an undo step (`lib/editor/rawTextEditor.ts:345-354`), but keeps your earlier typing steps and maps them through the new text. Undoing one that overlaps the change lands on text that no longer exists. The old textarea threw its undo history away whenever text was set from code; CodeMirror doesn't. The save then succeeds, because the file still matches the version the view last loaded (`NoteRawView.svelte:186-232`). The existing test (`rawTextEditor.test.ts:81-94`) only checks that the old word is gone.
- **Fix:** clear the undo history whenever the view loads text from disk, keeping the selection. Assert in the test that undo does nothing after a load.

**A-02 Choosing the other version in a conflict throws your typing away, with no copy and no undo.** Medium · Impact 4/10 · Hard 2/10 · older (the Raw view's version since `5fb4da8`) · confirmed, repro fails
- **What you see:** while the "changed by another program: Reload or Keep mine?" prompt waits, the editor stays editable and you can keep typing. **Reload** then discards all of it, keeps no copy, and clears the editor's undo history. In the Raw view, **Show the new version** reads like a preview but replaces your text for good. **Keep mine**, by contrast, backs up the other version first.
- **Where:** `stores/notes.svelte.ts:626-630` (`resolveConflict('reload')`), `components/boards/NoteRawView.svelte:234-236`. The editors' freeze list has no `conflict` state (`TextTile.svelte:168-174`, `DocumentEditor.svelte:244-250`). Compare `noteDiskChanges.ts:127-129`, where a reload that shrinks a clean note does keep a copy.
- **Fix:** before Reload, keep your version in `.filo/recovery/<time>-keep/` and show "Undo reload". In the Raw view, keep a copy and relabel the button "Use the new version (discard mine)".

**A-03 A title starting with a dot makes a hidden note.** Medium · Impact 4/10 · Hard 1/10 · older · confirmed, repro fails
- **What you see:** a task quick-added as `...call the editor`, or a scene titled `...and then` followed by "Rename file to match title", becomes the file `...and then.md`. Filo treats every dot-name as hidden:
  - it never shows in the sidebar;
  - its tile or card says "Backing file is missing" straight away, though the file exists and edits normally;
  - outside changes to it aren't followed;
  - it isn't indexed, so search, tag counts, tag renames and Task List filters miss it.

  A board named `.Ideas` disappears too: with board folders on, at the next open; with them off, from the sidebar. The file is still on disk, and renaming it in Explorer fixes it.
- **Where:** `shared/fileNames.ts:45` strips only trailing dots. Every create path uses it.
- **Fix:** strip leading dots and spaces from generated names, and refuse a leading dot in typed file and board names.

**A-04 Converting a note to UTF-8 can save a keystroke over the converted text.** Low · Impact 2/10 · Hard 2/10 · older · partially confirmed
- **What you see:** this happens only if a keystroke is serialised in the moment after "Convert to UTF-8" and before the reload finishes. The disk then gets the old `Caf�` text plus the keystroke, with no prompt. The original bytes are kept in `.filo/recovery/`.
- **Where:** `stores/notes.svelte.ts:224-234` (`adoptDisk` keeps a queued body), `lib/vault/convertToUtf8.ts:41` (unfreezes the editor before reloading).
- **Fix:** a forced reload with a queued body goes through the normal conflict check. Unfreeze only after the reload.

**A-05 A Raw view save that the writer skips reads as saved.** Low · Impact 2/10 · Hard 1/10 · older · confirmed
- **What you see:** if the note turns non-UTF-8 or into a link while you have unsaved Raw text, which is very rare, the view marks your text saved and replaces it with the disk text.
- **Where:** `lib/notes/noteWriter.ts:759`, `stores/notes.svelte.ts:824-826`, `NoteRawView.svelte:186-232`.
- **Fix:** report "skipped" as a failure, so the text is kept and a rescue copy is made.

**A-06 An open Task List notes box doesn't follow the note.** Low · Impact 2/10 · Hard 2/10 · older · confirmed
- **What you see:** the box shows the text from when it opened. If the note changes elsewhere, your first keystroke raises the conflict prompt, and Keep mine writes the old draft plus your typing (the newer version is backed up).
- **Where:** `lib/tasklist/notesBox.svelte.ts:204-210`.
- **Fix:** while you haven't typed in the box, keep it in step with the note.

**A-07 Switching tabs away from a Raw view with a conflict sends your text to a rescue file without asking.** Low · Impact 2/10 · Hard 3/10 · older · confirmed
- **What you see:** your text is kept in `.filo/recovery/…-unsaved/`, with a notice. But the in-place Keep mine is gone, and the tab comes back in the formatted view. Closing a tab asks first; switching doesn't.
- **Where:** `stores/tabs.svelte.ts:390-395`, `NoteRawView.svelte:348-367`.
- **Fix:** ask, as tab close does, or keep a conflicted Raw view's text across the switch.

**A-S1 Ctrl+S doesn't save a task title you're still typing.** Low · Impact 1/10 · Hard 1/10 · confirmed. The title commits on Enter or click-away, and leaving the vault or quitting commits it too. Only a crash in between loses it (`TaskItem.svelte:259-290`).

**A-S2 Very long titles.** Low · Impact 1/10 · Hard 2/10 · confirmed
- A title of 128 or more emoji passes Filo's 200-character limit but fails Windows' 255-unit limit. The create fails loudly, but the new tile is left pointing at a missing note.
- Long non-Latin titles can pass Windows and still exceed Android's 255-byte limit if you sync to the phone.
- **Where:** `shared/fileNames.ts:46-47`.

### 3.3 Boards, settings, undo, trash and tags (B)

**B-01 Link, embed and timer tiles keep a stale second copy, which tag actions then misuse.** Low · Impact 3/10 · Hard 2/10 · older · partially confirmed, repro fails (7 of 8 cases)
- **What you see:** after a tagged link, embed or timer tile is deleted and brought back with Ctrl+Z, the board file holds two copies of it, and only one is kept up to date. Then:
  - a vault-wide tag delete or rename can overwrite the tile's current tags with ones computed from the stale copy;
  - the tag action's Undo can't repair that;
  - a rename's Undo is refused as "exists again";
  - every vault open warns about "undefined tag references" the Tags Browser can't show;
  - search lists such tiles twice.

  Notes are never touched.
- **Where:** `core/boardTileOps/mindmap.ts:43-44,70,144-174`, `stores/fileTagsCascade.svelte.ts:43-51,228,244`, `stores/fileTags.svelte.ts:310-329,413-430`, `stores/tagUndo.svelte.ts:203-209,253-256,329`, `lib/search/runSearch.ts:214-229`. The test helper `seedBoard.ts:53` seeds boards differently from the live code, which is why the suites never saw it.
- **Fix:** stop writing the second copy, make readers skip it where it exists, and fix the test helper.

**B-02 A board moved by another program during a full save can come back at its old path.** Low · Impact 2/10 · Hard 3/10 · older · confirmed (narrow race)
- **What you see:** a full save (Ctrl+S, quit, or a drain before a disk operation) has to wait behind a slow board write. If in that window another program moves a board file, Filo writes a ghost copy at the old path. At the next open you see "Two board files use the same id"; the newer copy wins, so nothing is lost. If the program renamed the board's folder instead:
  - the save fails;
  - links into that folder stay broken until the next open;
  - a phantom "couldn't save" stays for the session.
- **Where:** `lib/boards/writeScheduler.ts:703,797` (the frozen copy keeps the old path), `lib/boards/boardWriteScheduler.ts:292,320,379-380`, `stores/vaultExternalChanges.ts:224-255`.
- **Fix:** re-schedule a moved board so its frozen copy is replaced, and clear a failure mark the move made stale.

**B-03 Answering a board's "changed outside" prompt does nothing if the board was renamed meanwhile.** Low · Impact 1/10 · Hard 1/10 · older · confirmed. It recovers on its own: the next edit asks again (`stores/boardDrift.ts:55,232-260`).

**B-04 Ticking a task or editing a card field rewrites the board file unchanged.** Low · Impact 1/10 · Hard 2/10 · older · confirmed
- **What you see:** since boards stopped holding note fields, these edits change only the note, but Filo still rewrites the whole `.board.json` with the same content. That means extra sync traffic, and it contradicts KL #29 ("the file changes only when you change the board"). BL-02 is the same kind of needless write.
- **Where:** `stores/history.svelte.ts:277`, `commands/noteFieldCommand.ts:81`, `commands/frontmatterInverse.ts:221-225`.
- **Fix:** don't mark a board dirty for a note-only change, or skip a board write whose bytes are unchanged.

**B-05 The default frame background image doesn't follow a rename or delete of the image.** Low · Impact 1/10 · Hard 2/10 · older · confirmed (`lib/vault/fileRefIntegrity.ts:91-102` scans board settings, not `.filo/defaults.json`).

**B-07 A rare race can create an empty board file with a deleted board's id.** Low · Impact 2/10 · Hard 1/10 · older · confirmed (race only)
- **What you see:** if you click a deleted board's tab in another pane during the delete's save step, which normally lasts milliseconds, an old code path creates an empty board with the same id. Undoing the delete then gives two boards with one id. The original data stays on disk.
- **Where:** `components/boards/BoardRouter.svelte:98-112`.
- **Fix:** remove that legacy path; show an empty state instead.

**B-09 Some undo steps put back whole objects, reverting changes made outside the history.** Low · Impact 1/10 · Hard 2/10 · older · confirmed
- **What you see:** undoing a saved-view change made before a vault-wide tag rename brings back the old tag name in that view's filter. Undoing a style change brings back a font size that "Use Default Font Sizes for all Existing Items" had cleared.
- **Where:** `commands/savedViewsCommand.ts:56-79`, `commands/tileCommands.ts:548-556`.
- **Fix:** record per-key changes, as other commands already do.

(B-06 and B-08 are non-issues for you: see section 3.7.)

### 3.4 Vault lifecycle, outside changes, recovery and security (C)

**C-01 A file dragged onto a board from a hidden vault folder is linked in place, and one such note blocks every rescue copy at quit.** Low · Impact 3/10 · Hard 2/10 · older · partially confirmed
- **What you see:** you drag a rescue copy out of `.filo/recovery`, a trashed file out of `.filo/trash`, or an old version out of Syncthing's `.stversions` onto a board. The tile links the hidden file instead of copying it in.
  - Every save is refused, and the toast wrongly says "check disk space or file permissions".
  - At quit, writing rescue copies fails for *every* unsaved note, not only that one. Filo then asks "…and lose them", with Cancel offered, so nothing goes silently.
  - With `.stversions`, edits land in Syncthing's archive, which its cleanup later deletes.
- **Where:** `lib/vault/droppedFiles.ts:55-61` (any path under the vault root counts as in-vault). `main/ipc/recovery.ipc.ts:26-29` checks every item before writing any. The same all-or-nothing check can also fail the kept copy of a shrinking reload (`stores/notePrompts.ts:252-260`).
- **Fix:** treat a dropped path with a hidden segment as outside the vault (copy it in). Write rescue copies item by item. Word a refused write as refused.

**C-02 The Raw view and the Task List notes box save only when you leave them.** Low · Impact 4/10 · Hard 2/10 · older · partially confirmed
- **What you see:** both save on click-away, Ctrl+S, close, switching back and quit. A renderer crash or power cut during a long Raw view session loses everything typed since. The recovery notice names the note but holds no text.
- **Where:** `components/boards/NoteRawView.svelte:280-285`, `lib/tasklist/notesBox.svelte.ts:16-21`.
- **Fix:** an idle save 1–2 s after typing stops, through the same save, which keeps the conflict check. The same for the notes box.

**C-03 A "preserved snapshots" warning comes back on every vault open.** Low · Impact 2/10 · Hard 2/10 · older · partially confirmed
- **What you see:** once any kept version or rescue copy exists, every open shows "Filo preserved N file snapshot(s) … from a previous failed-load window". Filo makes these itself: a reload that shrank a note, Keep mine / Keep local, session-end rescues. The wording is wrong for them, and nothing deletes them, so the warning trains you to ignore warnings.
- **Where:** `stores/vault.svelte.ts:713-745`, `main/services/recoverySnapshot.ts:508-565`.
- **Fix:** show only new failed-load snapshots. Add Settings → Recovery to list and delete copies (KL #33).

**C-04 A Syncthing conflict copy of a note is never announced.** Low · Impact 4/10 · Hard 2/10 · older · confirmed
- **What you see:** if the phone edits a note too, `X.sync-conflict-….md` appears without a word. When the phone's version wins, an open note with no unsaved typing silently becomes the phone's version, and the PC's version sits in a new sidebar file. CLAUDE.md claims a notice per conflict copy.
- **Where:** `main/services/syncConflictNotifier.ts:63-97` (boards and refused renames only), `main/vault/boardFileOps.ts:136-153`.
- **Fix:** announce note conflict copies, live and at open. With the phone set to Receive Only (section 7), this can't happen.

**C-05 Another program replacing one open note with another can put the wrong text in a file.** Low · Impact 3/10 · Hard 3/10 · older · partially confirmed
- **What you see:** another program renames open note A over open note B while B has under a second of unsaved typing. B's typing lands on A's text.
  - A prompt appears. Keep mine recovers it with a backup; Reload loses A's text for good.
  - Both editors show A's text, which invites the wrong choice.
- **Where:** `main/services/renameCorrelation.ts:286-357`, `stores/notes.svelte.ts:866-890`, `lib/notes/noteWriter.ts:882`.
- **Fix:** don't pair a "present" path that was already a known file (that's a modify, not a rename). Or turn a displaced note with unsaved work into a backed-up conflict.

**C-06 A Windows change-buffer overflow is ignored.** Low · Impact 2/10 · Hard 1/10 · older · confirmed
- **What you see:** a big burst of changes, such as 500 Syncthing deliveries, overflowed the buffer 1–5 times in tests. The changes it dropped show only at the 30 s reconcile or when the window regains focus. Save checks still stop any overwrite.
- **Where:** `main/services/fileWatcher.ts:426` (`if (!filename) return;`).
- **Fix:** on an overflow, schedule a reconcile at once.

**C-07 Two vault-boundary holes in the main process (Audit-22 legacy-8).** Low · Impact 1/10 · Hard 3/10 · older · confirmed
- **What you see:** nothing in normal use.
  - Main accepts `.filo`'s 8.3 short name (`FILO~1/app.json`) for delete, overwrite, rename and trash.
  - `vault:copy-file` follows a junction inside the vault to write outside it.
  - Both need hostile code in the renderer.
- **Where:** `main/utils/pathSecurity.ts:442`, `main/services/approvedSources.ts:117-140` (its comment overstates what `lstat` stops), `main/ipc/vaultCopy.ipc.ts:113-114`.
- **Fix:** guard on the canonical long-name path. Check the copy destination before writing. Resolve real paths for in-vault sources.

**C-08 The link-preview fetch checks DNS apart from the connection.** Low · Impact 1/10 · Hard 3/10 · older · confirmed
- **What you see:** nothing. A DNS-rebinding name could make a Link tile fetch a page's title from your home network; this only applies to links you add.
- **Where:** `main/ipc/media.ipc.ts:29-55`, `:420-454`. The code comment claims rebinding is caught.
- **Fix:** validate the address actually connected to, on every hop.

**C-09 After a renderer crash and Reload, a different vault can't be opened until restart.** Low · Impact 2/10 · Hard 1/10 · older · confirmed
- **Where:** `main/services/rendererCrashHandler.ts:61` (reloads without releasing the vault), `main/ipc/board.ipc.ts:151-156`. Reopening the same vault works.
- **Fix:** release the vault registry and the watcher before reloading.

**C-10 A folder renamed in Explorer is followed twice.** Low · Impact 2/10 · Hard 3/10 · older · confirmed, measured
- **What you see:** the rename is followed at once from the tree, then again at the next 30 s reconcile, once per file. 40 notes meant 40 rename runs and about 4 s of busy save queue. The repeats are harmless.
- **Where:** `main/services/fileWatcher.ts:618-657`, `stores/vault.svelte.ts:1210-1213`.
- **Fix:** move the watcher's records when the folder move is followed.

**C-11 "Open last vault on launch" is skipped about one launch in six or seven.** Low · Impact 2/10 · Hard 1/10 · older · confirmed
- **What you see:** two reads of `recent-vaults.json` race at startup, and when the preference arrives first, Home shows instead of your vault. Two file reads finished out of order 15–17% of the time in a test.
- **Where:** `components/home/HomeScreen.svelte:42-72`.
- **Fix:** wait for the recent-vaults list before choosing.
- **Also checked:** C-11b, the dialog with no focused window, is a safe non-issue. C-11c, spell-check downloads, is refuted: on Windows the built-in checker is used.

### 3.5 The editor and formatting (D)

You said formatting is essential to how you write, so these weigh more for you than their numbers suggest.

**D-02 Pasting from Word or a web page makes the note open read-only next time.** High · Impact 5/10 · Hard 2/10 · older · confirmed, 4/4 fail in Chromium through the real paste
- **What you see:** pasted text looks fine and saves. At the next open, the note shows the read-only banner. The common triggers:
  - Word's double space after a full stop;
  - a web page's bold or underline written as a styled `<span>`;
  - a Google Docs tab.

  No text is lost, and "Take ownership" gets you out (it warns that formatting will be rewritten). HTML paste had never been audited.
- **Why:** the colour, font and size extension accepts *any* `<span style>` (`@tiptap/extension-text-style`, Filo's `FontSize` at `lib/editor/createEditor.ts:60`). A span whose style names none of those becomes an empty mark, which saves as a bare `<span>` that the next load doesn't read back.
- **Fix:** accept a span only when it carries a colour, font or size Filo keeps, and never write an empty one. Add Word, Docs and web paste fixtures with a save-and-reopen check.

**D-01 A bold or italic phrase whose neighbouring words are formatted differently reopens read-only.** Medium · Impact 4/10 · Hard 2/10 · older · partially confirmed (Chromium)
- **What you see:**
  - Example: make "Aria Kasai" bold, then colour "Aria" red and "Kasai" blue. The note opens read-only next time.
  - The same happens with any two neighbouring words inside a bold, italic or struck-through run that differ in colour, size, font or highlight.
  - One coloured word in a bold phrase is fine.
  - A quieter variant: select a word with Windows' double-click (which takes the trailing space) inside an underlined or highlighted phrase and press Ctrl+B. After reopening, the underline or highlight has a gap where the space was.
- **Why:** `prosemirror-markdown`'s `renderInline` (`node_modules/prosemirror-markdown/dist/index.js:731-760`) writes the space between the two words inside the first word's still-open marks. Filo's `DelimiterRuns` then turns the run into HTML, and the second save comes out different. The round-trip property test excludes whitespace-only runs on the premise that "a formatted space shows nothing", which is false for underline and highlight.
- **Fix:** before writing, let a whitespace-only run keep bold, italic or strike only when both neighbours have it. The finder's version passes a 1,500-run probe with no exclusions. Add whitespace runs, font and size to the property test's generator.

**D-03 The font-size box and its + / − buttons start from 14 px, whatever size your text is.** Medium · Impact 4/10 · Hard 1/10 · older · confirmed (Chromium)
- **What you see:**
  - In a Document, body text is 16 px but the box says 14, so pressing + *shrinks* it to 15 px.
  - In a heading shown at 32 px, + also goes to 15 px.
  - In a 13 px tile, − does nothing visible.
  - Pasted text sized in points is read as pixels, so + shrinks 11 pt text to 12 px.
- **Where:** `lib/editor/toolbarConfig.ts:94,247-255` (`parseInt(...) || 14`), `stores/toolbar.svelte.ts`.
- **Fix:** with no size set, use the size the text is actually shown at, converted from points where needed.

**D-06 Rich paste pins black text, the source's font and point sizes, and drops Google Docs highlights.** Medium · Impact 4/10 · Hard 3/10 · older · confirmed (Chromium)
- **What you see:** text pasted from Google Docs saves as black Arial 11 pt on every run. It's unreadable in a dark theme and smaller than your 16 px text, and its yellow highlight is lost. Word lists arrive as a `·` plus padding glued to the previous paragraph, which also opens read-only (D-02). Ctrl+Shift+V (plain paste) avoids all of this.
- **Where:** there is no paste clean-up (`transformPastedHTML`) anywhere.
- **Fix:** a paste clean-up that:
  - drops near-default colour, font and size;
  - turns a span's background colour into a highlight;
  - turns Word's bullets into a real list.

**D-04 Enter with the caret inside a tile, card or frame title splits the title in two.** Medium · Impact 3/10 · Hard 1/10 · older · confirmed, repro fails
- **What you see:** you click into "Chapter One" to fix a typo and press Enter, and the title becomes `Chap` and `ter One` on two lines. For a text tile or card, the note's `title:` gets a line break (it is still valid YAML, and Ctrl+Z on the board restores it). Connection labels behave the same.
- **Where:** `components/tiles/TileHeader.svelte:164-172`, `components/frames/Frame.svelte:231-234`, `components/connections/ConnectionLabel.svelte:201-208`. The title editor's own Enter splits the line before the commit handler runs (`createEditor.ts:419-457`).
- **Fix:** handle Enter inside the title editor as "commit", ignoring IME composition.

**D-05 The list buttons scramble a nested list, or do nothing.** Medium · Impact 3/10 · Hard 3/10 · older · confirmed (Chromium)
- **What you see:** select all of a character profile's nested bullet list and click Checklist. Items are demoted and promoted at random, and list types get mixed. With the caret in an item that has sub-items, Checklist and Bulleted do nothing. Numbered works. You can see the result straight away, and it can be undone.
- **Where:** `lib/editor/toolbarConfig.ts:280-293` calls TipTap's toggles unwrapped.
- **Fix:** Filo's own list-type switch that changes list and item types in place and keeps the depth.

**D-09 Typing common scene breaks turns them into a heading or a list.** Low · Impact 3/10 · Hard 2/10 · older · confirmed
- **What you see:**
  - A lone `#` (the standard manuscript scene break) then Enter becomes an empty heading, and your next line is typed as a heading.
  - `* * *` becomes a bullet list.
  - `1984. It was…` becomes a list numbered from 1984.
  - `***` and `---` work.
  - Backspace or Ctrl+Z straight after undoes it.
- **Where:** TipTap's input rules run on Enter (`@tiptap/core/dist/index.js:5005-5016`).
- **Fix:** make `* * *` and a lone `#` plus Enter a scene break (horizontal rule), or skip the heading and list rules on Enter.

**D-07 Saving a very long note stalls after each typing pause.** Low · Impact 2/10 · Hard 4/10 · older · partially confirmed (measured)
- **What you see:** typing stays fast (about 1 ms per key even at 100,000 words). But the save after each pause costs about 10 ms at 10,000 words, 70–140 ms at 40,000 and up to 0.7 s at 100,000. A chapter per note is fine; a whole manuscript in one note would stutter.
- **Where:** `prosemirror-markdown`'s `atBlank` scans the whole output each time, and `lib/editor/delimiterRuns.ts:161` re-filters per run.
- **Fix:** take the re-filter out of the loop, track the last character instead of re-scanning, and save larger notes less often.

**D-08 An imported font whose file name starts with a digit or holds brackets doesn't apply, and the note reopens read-only.** Low · Impact 2/10 · Hard 2/10 · older · confirmed
- **Examples:** "28 Days Later", "Lora[wght]".
- **Where:** `main/ipc/fonts.ipc.ts:100,143`, `lib/editor/toolbarConfig.ts:237-240` (the name is unquoted; Settings quotes it).
- **Fix:** quote font names.

**D-10 A title's font size shows while you edit it and disappears after.** Low · Impact 2/10 · Hard 1/10 · older · confirmed. The display sanitiser drops `font-size` (`lib/utils/sanitizeHtml.ts:31`). This is the same gap as W-9, where card previews drop font size and indent.

**D-11 The spell-check toggle doesn't reach editors opened later, and isn't remembered.** Low · Impact 2/10 · Hard 1/10 · older · confirmed
- **What you see:** turn spell check off to stop the squiggles under invented names. A new tab, card or tile shows them again, and the setting resets at every launch.
- **Where:** `stores/toolbar.svelte.ts:90-96`, `lib/editor/createEditor.ts:264,431`.

**D-12 A resized column in a Markdown table loses its width on save, without the note being flagged.** Low · Impact 2/10 · Hard 2/10 · older · confirmed (`lib/editor/tableMarkdown.ts:53-58`).

**D-13 Images embedded in a note never show, and card previews drop them.** Low · Impact 2/10 · Hard 3/10 · older · confirmed
- **What you see:** `![map](images/map.png)` points at the app, not your vault, and the security policy allows only `filo:` media. The file itself is kept byte for byte.
- **Where:** `lib/editor/createEditor.ts:329-331`.
- **Fix:** rewrite vault-relative image addresses to `filo://`.

### 3.6 The four views and the rest of the interface (E, H)

The H-findings come from driving the built app on a copy of your book vault, and each was seen on screen.

**H-01 A new card or tile doesn't take the caret, so what you type triggers shortcuts and is lost.** High · Impact 5/10 · Hard 2/10 · older · seen in the built app
- **What you see:** after Kanban "Add Card → Text", keyboard focus goes back to the Add Card button. Typing a title does nothing visible:
  - the space bar presses Add Card again;
  - `n` opens the card-type picker.

  After Mind Map "New Tile → Text", focus goes to the page body. The Mind Map's single-letter shortcuts then act:
  - `n` makes a new tile, each with a real empty note in your vault;
  - `c` starts connection mode;
  - Enter renames the selected tile;
  - Backspace asks to delete it.

  In the tour, typing three card titles left three empty "New Card" notes. Typing "Magic system", "River city" and "Antagonist" into three new tiles left **five** empty tiles: the two `n`s in "Antagonist" made two more.
- **Where:**
  - The Kanban add flow returns focus to `.add-tile-btn`.
  - `components/boards/SideToolbar.svelte` leaves focus on `<body>`.
  - Bare keys: `components/boards/MindMapBoard.svelte:523-566` (`n`, Enter, `c`) and `components/boards/KanbanBoard.svelte:776-778` (`n`, Shift+N).
- **Fix:**
  - Open a new card or tile with its title selected for editing, so typing replaces "New Card". Show BL-14's "Start typing…" in its body.
  - Let single-letter shortcuts act only while the board or canvas itself has focus.

**E-03 There is no way to make a new note, or a folder inside a folder, except through a board.** High · Impact 5/10 · Hard 3/10 · older · confirmed
- **What you see:** to start `Book/Part 1/Chapter 4.md` you must add a tile, card or task to some board, open it as a Document, retitle it, "Rename file to match title", and drag it into the folder. The folder itself can only be made at the vault root and dragged into place. Help promises "folders and subfolders", and the design doc (:57) promises standalone Documents.
- **Where:**
  - `components/layout/TabBar.svelte:41-43`: Document isn't in New Tab.
  - `components/modals/BoardBrowser.svelte:105`.
  - `lib/vault/sidebarFileMenu.ts:17-28`: no "New note" or "New folder".
  - `components/sidebar/VaultSidebarToolbar.svelte:146-170`: root only.
  - Ctrl+N is Mind Map only (`AppShell.svelte:312-316`).
- **Fix:** "New note" and "New folder" on the folder and empty-space menus (create with a title, open in a Document tab). Ctrl+N in a Document tab makes a note. Document in New Tab.

**H-03 A new vault puts every card, task and tile note in the vault's top folder.** Medium · Impact 4/10 · Hard 1/10 · older · seen in the built app
- **What you see:** Settings shows "Board-specific folders: Off" and "Root Directory: Vault root" by default. Every note a board makes lands next to your manuscript notes, and with E-13 they're all called `New Card (n).md` or `New Tile n.md`.
- **Fix:** turn board folders on for new vaults, or ask where notes should go when the first board is made. For now, set it yourself (section 7).

**E-13 New cards, tiles and tasks keep placeholder file names for good.** Medium · Impact 4/10 · Hard 2/10 · older · confirmed (also seen in the built app)
- **What you see:** the file is created before you type a title, and title edits never rename it. The sidebar shows file names and its search matches file names only, so a card titled "The Siege" shows as `New Card (7).md` and can't be found from the sidebar. Outside Filo the vault reads the same way, which works against the open-format goal.
- **Where:** `lib/kanban/kanbanTileCreation.ts:91-111`, `lib/tasklist/taskCreation.ts:103-109`, `stores/boardTiles.ts:117-129`, `lib/boards/seedTextFileForNewTile.ts:26-37,72`, `lib/vault/vaultTreeSort.ts:141-157`.
- **Fix:** when a note Filo created under a placeholder name gets its first title, rename the file to match (undoable). Let the sidebar search match titles too.

**E-01 Task List arrow keys, Tab and Shift-click follow the order in the file, not the order on screen.** Medium · Impact 4/10 · Hard 3/10 · older · partially confirmed
- **What you see:** new Task Lists sort by priority. Once tasks have different priorities:
  - ArrowDown jumps to the next task *in the file*, and sticks on a collapsed parent.
  - Tab makes a task a subtask of the task before it in the file, not of the one above it on screen.
  - A Shift-click range can include a task that isn't between the two you clicked. It is highlighted, so check before a bulk Delete; delete and indent can be undone.
- **Where:** `lib/tasklist/taskListKeyboardNav.svelte.ts:91-142`, `lib/tasklist/multiSelectController.svelte.ts:89-99` (both use `filteredRows`); the screen draws `sortedRows` (`taskListViewModel.svelte.ts:211-227`).
- **Fix:** give keyboard navigation and selection the rendered order, as Kanban already does.

**E-02 Quick add files every task into the last section, where it vanishes if that section is collapsed.** Medium · Impact 4/10 · Hard 1/10 · older · partially confirmed
- **What you see:** with sections "To do" and "Done" and Done collapsed, a quick-added task disappears into Done. The "+ Add task" path uses the first section instead.
- **Where:** `lib/tasklist/taskCreation.ts:288` (`insertPos = placementsNow.length`), `components/boards/TaskQuickAddInput.svelte:58`.
- **Fix:** use the same rule as Add task (the last-used section, else the first). Expand the section, or say where the task went.

**E-04 Right-clicking text shows no menu.** Medium · Impact 4/10 · Hard 2/10 · older · partially confirmed
- **What you see:** you get no Cut, Copy, Paste, Select All or Insert Link in notes, tiles, cards or text fields. A menu appears only on a misspelled word. Ctrl+X, C, V and A still work. The design doc (:1137-1142) promises the menu.
- **Where:** `main/main.ts:366-389` (`if (!misspelledWord) return;`).
- **Fix:** build the menu in main from roles (cut, copy, paste, select all, enabled from `editFlags`) plus the spelling items. Send "Insert link" to the renderer.

**E-07 Escape in a task's notes box throws away what you typed.** Medium · Impact 4/10 · Hard 1/10 · older · confirmed
- **What you see:** you get no confirm and no undo. The only hint is a placeholder that is hidden once there's text.
- **Where:** `components/boards/TaskItem.svelte:202-210`, `lib/tasklist/notesBox.svelte.ts:221-225`.
- **Fix:** make Escape save and close as clicking away does, or ask when the text changed.

**E-11 The sidebar puts "Chapter 10" before "Chapter 2", and Group By never groups.** Medium · Impact 4/10 · Hard 1/10 · older · confirmed
- **What you see:** names are compared without numeric order. The default order ("None") is whatever Windows lists (1, 10, 11, 2). Group By only breaks ties, so it changes nothing. Task List and Kanban title sorts have the same numeric problem.
- **Where:** `lib/vault/vaultTreeSort.ts:33,41,49-51,96-109`, `lib/tasks/taskListModel.ts:145`, `lib/kanban/kanbanFiltersAndSort.svelte.ts:112`.
- **Fix:** one shared `Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })`. Make the group the primary key.

**E-06 Typing a date in a Kanban card's due-date box saves it at the first digit and closes the box.** Medium · Impact 3/10 · Hard 1/10 · older · confirmed (real Chromium)
- **What you see:** Chromium fires a change on every keystroke in a date box. One digit saves a wrong date and closes the popover. From an empty date, the first valid year digit may save year 0002 (not tested). The Task List's time box makes one undo step per keystroke.
- **Where:** `components/boards/KanbanCard.svelte:197,205-208,416-427`, `components/boards/TaskDatePicker.svelte:217-225`.
- **Fix:** keep a draft and commit on Enter or blur, or reuse the Task List date picker.

**E-10 Ctrl+W and Ctrl+Tab do nothing while you're typing, and Ctrl+S doesn't work in quick add or the notes box.** Medium · Impact 3/10 · Hard 1/10 · older · confirmed
- **Where:** `components/layout/AppShell.svelte:394-436` (no `allowInEditor`), `core/hotkeys.ts:109-122` (inputs and textareas block everything but Escape). The code comment says this matches VS Code; it doesn't.
- **Fix:** let Ctrl+W, Ctrl+Tab and Ctrl+Shift+Tab through in editors, and Ctrl+S and Ctrl+Shift+F through in fields.

**E-12 Markdown templates lose their frontmatter, `{{date}}` and board skeleton.** Medium · Impact 3/10 · Hard 2/10 · older · confirmed
- **What you see:**
  - A "Character" template with `tags:`, `role:` and `age:`, inserted on a Mind Map, gives a note with only `title:`.
  - On Kanban, `{{date}}` in frontmatter stays literal.
  - A board template's columns and tiles are ignored.
- **Where:** `components/modals/TemplateBrowser.svelte:129-155`, `lib/boards/seedTextFileForNewTile.ts:72`, `lib/kanban/kanbanTileCreation.ts:158-173`.
- **Fix:** one instantiate path that merges and fills in frontmatter and creates the skeleton.

**H-04 At laptop widths the vault sidebar covers your note.** Medium · Impact 3/10 · Hard 2/10 · older · seen in the built app
- **What you see:** at 1,100 px the floating sidebar sits over the left edge of the note's text ("ara working" for "Shikara working"). The formatting toolbar cuts off its font and size boxes (BL-01).
- **Fix:** docking should push the content aside, or the sidebar should fold away below a width. Fix BL-01 with it.

**H-09 There is no build of today's code to install, and the app never shows its version.** Medium · Impact 5/10 · Hard 1/10 · seen on this PC
- **What you see:** `release/` holds only the 8 June installer. It has the same version number as today's code (`0.1.0`) and predates every data-safety fix since Audit-16. Nothing in the app shows a version (`app.getVersion` is never used), so you can't tell which build you're running.
- **Fix:** bump the version for each build you install, show it in Help, and build an installer (section 7).

**E-05 Quick add reads ordinary words as dates.** Low · Impact 3/10 · Hard 1/10 · older · partially confirmed
- **What you see:** these are all read as dates and cut from the title:
  - "next month" becomes next Monday;
  - "next wedding", "next friend" and "next sunrise" become weekdays;
  - "act 2/3" becomes 2 March.

  The chips show the date before you press Enter. "tomorrow 5pm" ignores 5pm (only `@5pm` works), there's no repeat token ("every friday" stays in the title), and `Chapter #3` becomes tag `3`.
- **Where:** `lib/tasks/quickAddParser.ts:202,235`.
- **Fix:** match weekday names and their usual abbreviations only. Don't read a fraction between words as a date.

**E-08 Mind Map shortcuts fire while the vault sidebar has focus.** Low · Impact 3/10 · Hard 2/10 · older · partially confirmed
- **What you see:** with a sidebar row focused and a Mind Map open:
  - the arrow keys also change the canvas selection;
  - `n` makes a tile;
  - Enter on a folder row also opens the selected tile's title for renaming;
  - Delete asks to remove a tile.
- **Where:** `lib/mindmap/mindMapKeyboard.ts:73-82`, `components/boards/MindMapBoard.svelte:393-404` (no `defaultPrevented` check), `components/sidebar/VaultSidebar.svelte:335-357`.
- **Fix:** the same as H-01's second half: canvas keys only while the canvas has focus.

**H-08 The Mind Map's single-letter shortcuts aren't listed anywhere and can't be changed.** Low · Impact 2/10 · Hard 2/10 · older · seen in code
- **What you see:** `n`, `c`, Enter and Backspace are hard-coded in `MindMapBoard.svelte`, not registered commands. So they're missing from Help → Shortcuts and the design doc's shortcut table, and can't be rebound. The doc says every command is listed and rebindable.
- **Fix:** register them as commands (with H-01's focus rule), or drop them.

**E-09 Nested frames come apart when you drag the outer one.** Low · Impact 3/10 · Hard 4/10 · older · partially confirmed
- **What you see:** the inner frame stays behind while its tiles move with the outer frame, and it keeps claiming them. Collapsing it later hides tiles far away. A larger frame drawn later covers the ones inside it.
- **Where:** `stores/frames.svelte.ts:54-95`, `components/frames/Frame.svelte:140,367-401,432`.
- **Fix:** move contained frames with the dragged one. Recompute membership for every frame affected. Order frames by nesting.

**E-15 Task List "Filter by Status" finds nothing for tasks made in Filo.** Low · Impact 3/10 · Hard 1/10 · older · partially confirmed
- **What you see:** only quick add's `=status` writes a status. So filtering by "todo" hides every task you made, while Group by Status shows them under To Do.
- **Where:** `lib/tasks/taskListModel.ts:215` vs `:224-231`.
- **Fix:** filter through the same bucket rule as grouping.

**H-02 Toolbar-made tiles land exactly on top of each other.** Low · Impact 3/10 · Hard 1/10 · older · seen in the built app
- **What you see:** "New Tile" from the side toolbar puts every tile at the viewport centre; two tiles had identical positions. Ctrl+N offsets by up to 50 px, and `n` places a tile beside the selection.
- **Where:** `components/boards/MindMapBoard.svelte:156-167`.
- **Fix:** step each new tile clear of the last one, or find free space.

**H-05 Search shows how many matches, but not where.** Low · Impact 2/10 · Hard 3/10 · seen in the built app
- **What you see:** the Search panel shows "1 / 23" and no list of the notes that match until you press Find All.
- **Fix:** list matching notes under the box, grouped by note.

**H-06 Settings is hard to find, and its tabs save in two different ways.** Low · Impact 2/10 · Hard 1/10 · seen in the built app
- **What you see:** no toolbar button opens Settings; only the vault-name menu or Ctrl+, does. General and Trash save at once ("AUTO"), while Global Defaults and Current Board need Apply.
- **Fix:** a Settings button in the toolbar, and one saving rule for every tab, or a clearer label.

**H-07 Undoing a new tile leaves its empty note in the vault.** Low · Impact 2/10 · Hard 2/10 · older · seen in code
- **What you see:** undo removes the tile from the board, but the note made for it stays, as it does when you delete a tile (by design). Accidental tiles (H-01) leave `New Tile 4.md` and friends behind.
- **Where:** `commands/tileCommands.ts:50-53` (`AddTileCommand.undo`).
- **Fix:** an undo of a tile whose note Filo created empty moments before can move that note to Filo's trash (redo restores it).

**E-14 Picking a picture or file that is already in the vault makes a copy.** Low · Impact 2/10 · Hard 1/10 · older · partially confirmed
- **Where:** the card cover, File tile and background pickers (`lib/kanban/kanbanFrontmatterWriter.ts:120-149`, `components/tiles/FileTile.svelte:39-89`, `components/shared/BackgroundImagePicker.svelte:52-73`). Drag-and-drop already links instead.
- **Fix:** link an in-vault pick by its path.

**E-16 Task List Group By is greyed out on every new board, and choosing None can lock it.** Low · Impact 2/10 · Hard 2/10 · older · partially confirmed
- **Where:** `components/boards/TaskListBoard.svelte:155,1467`, `core/boardDefaults.ts:100-102`.
- **Fix:** let Group By group within sections, and never disable the control that can undo its own choice.

**E-17 The Task List date picker can't be used from the keyboard.** Low · Impact 2/10 · Hard 2/10 · older · partially confirmed
- **What you see:** D opens it but focus stays behind it. Escape doesn't close it. Day labels read as ISO dates.
- **Where:** `components/boards/TaskDatePicker.svelte:115-121,157-163,199,206`.
- **Fix:** focus the selected day, arrow-key navigation, Escape, return focus, readable labels.

**E-18 Keyboard selection doesn't scroll to what it selects, and one Kanban card can't be moved by keyboard.** Low · Impact 2/10 · Hard 3/10 · older · partially confirmed
- **Where:** `components/boards/MindMapBoard.svelte:472-493`, `components/boards/KanbanColumn.svelte:410-421`, `lib/kanban/kanbanContextMenus.ts:20-28`.
- **Fix:** pan or scroll to the selection, and add "Move to column" to a single card's menu.

**E-19 to E-27 Smaller items.** Each confirmed; Low · Impact 1/10 to 3/10 · Hard 1/10 to 3/10:
- **E-19:** the same action behaves differently between views. Backspace on the Mind Map has its own delete prompt with no "delete files too" option. Delete asks on the Mind Map but not for one card or task. There are three spellings of "urgent" and two date pickers.
- **E-20:** Settings → Current Board can't be reached for a Document, and `CurrentBoardDocument.svelte` is dead.
- **E-21:** tabbing into a split pane doesn't make it the active pane.
- **E-22:** Help promises a link action that types into a tile, and the link popup asks for board ids nothing shows.
- **E-23:** developer words in messages ("tile placement(s)", "backing vault files", "deleted out-of-band").
- **E-24:** dates are shown three ways, and there are five copies of the date parser.
- **E-25:** the Repeat menu has five presets; "every N" and the completion mode can't be set. A rule Filo can't read makes Complete mark the task done for good, silently.
- **E-26:** the minimap and waypoint toggles reset every session.
- **E-27:** design-doc drift (section 5).

**H-10 The formatting toolbar looks active when no editor has focus.** Low · Impact 1/10 · Hard 1/10 · seen in the built app. On a Kanban or Mind Map board with no text being edited, the font, size and B/I/U controls look enabled and do nothing.

### 3.7 Refuted, non-issues, and claims the refuters narrowed

These are listed so they aren't re-filed:

| Claim | Outcome | Why |
|---|---|---|
| C-11c: spell check downloads dictionaries from Google, a network call | **Refuted** | `%APPDATA%\filo\Dictionaries` is empty: on Windows the built-in spell checker is used. |
| C-11b: a leave dialog with no focused window counts as Cancel | Non-issue | Cancel keeps the vault open, which is the safe answer. |
| B-06: boards from before format 8 are refused with "fix it in a text editor" | Non-issue for you (wording only) | Your book vault has no boards and your Test Vault's are format 8. Only two scratch vaults hold format-7 boards. The notice should say "rebuild the board; its notes are safe" (plan Phase 6). |
| B-08: legacy board fields and an unused project-level mirror | Non-issue (tidiness) | Nothing reads them. Drop them with the first real board-format step. |
| E-28: dead and duplicated UI code | Non-issue | Three unused CSS variables, possibly-unused keyframes, and two places that group tiles. Section 5 lists them. |
| A-03: the Task List checkbox stays disabled for a dot-named note | Narrowed | Disabled only while the index builds. Afterwards the row shows blank fields, which smart lists and filters miss. |
| A-04, B-02, C-05, D-01, E-01 | Narrowed (see each) | Real, but with a narrower trigger than first claimed. The details above use the refuters' wording. |
| C-01, C-02, C-03, E-05, E-08, E-09, E-14 to E-18 | Lowered to Low | Real, but a confirm stands before any loss, the trigger is rare, or the impact is friction rather than harm. |

## 4. What the recent changes could have broken

The last audit started from `abf5212`. Since then there have been 24 commits: Audit-27's fixes, the library updates, and BL-20. Each change that touched app code was reviewed, by me and by the finder for its area.

| Change | Commit(s) | Verdict |
|---|---|---|
| The CodeMirror Raw view | `ffd5b9e`, `5fb4da8` | **Broke something: A-01 (High).** CodeMirror keeps its undo history when text arrives from disk; the old textarea didn't. Everything else checks out: the save, conflict banner, composition guard, Ctrl+S, leave paths and session-end rescue. C-02, A-05 and A-07 existed in the old Raw view too. |
| Full saves keep the newer write (scheduler "captures") | `5f25a70` | Sound under every interleaving Finder B traced: two full saves, a flush during a capture, cancel, reset, overdue, holds. One narrow race remains in the same design: a board moved by another program during a full save (B-02). |
| Titles saved on click-away (`commitWhenLeft`) | `b8fe878` | Sound: no double commit, Escape cancels, the toolbar keeps the edit open. D-04 (Enter splits a title) predates it. |
| Older board formats load through tested steps | `2771755` | Sound: no write at open, a copy before the first save, refusals never written. No steps exist yet, and the notice for older boards promises a fix that can't work (B-06). |
| Find and Replace shows what it changes | `c92f14e` | Improved. BL-04 and BL-05 remain. |
| Small fixes (subtask order, paste edges, trash toasts, sticky tag-undo toasts, Light contrast) | `f6c76b9` | Fine. The design doc still says the tag Undo toast lasts 15 s (E-27). |
| The Search panel's close button | `29b96ee` | Fine. Escape still needs focus inside it (BL-03). |
| TipTap 3.31.4 and the HTML-table fix | `41162bd` | Fine (Finder D). |
| Theme values must be colours | `0e782e2` | Fine. Your vaults have no custom themes, so nothing of yours can be dropped. |
| knip (38 unused exports removed) | `fabac7a` | Fine: `ci:verify` and the E2E suite pass. |
| Packaging without `node_modules` | `6c5f5a3` | Verified: the packaged main process needs only Node's built-ins plus `electron`. Phase 8's 29/29 run against the packaged exe stands. |
| Safe updates, jsdom 30, micromark, Vitest browser mode, the corpus check, the line-limit gate | `5e7d57c`, `0a3d9b8`, `5219e45`, `0dc44c6`, `1de0170`, `de8562b` | Build and test tooling only. One caveat: the micromark comparison never sees pasted HTML, which is why D-02 went unnoticed. |

**Lesson for the next round:** Audit-26 and Audit-27 each found a regression introduced by the round before, and this audit found one in the newest feature. In each case the safety net had a blind spot exactly where the change landed. The plan therefore asks for a test of the specific interaction each fix touches, not only of the fix.

## 5. Redundancy, legacy code, gaps and docs drift

### 5.1 The same thing done more than once

- **Dates:** five copies of the date parser (`recurrence.ts`, `quickAddParser.ts`, `taskListModel.ts`, and two in `dueDateFormat.ts`), and three ways of showing a date. ISO dates appear in toasts and the start-date line, and the quick-add chip uses a different locale from parsing (E-24).
- **Pickers and priorities:** two date pickers (Kanban's native box and the Task List's own), and three spellings of top priority ("!!!", "Urgent", "!!! Urgent") (E-19).
- **Delete flows:** the Mind Map's Backspace has its own delete prompt beside the shared Delete flow, without its "delete files too" option. Grouping tiles is implemented twice, and so is Select All (E-19, E-28).
- **Board data:** link, embed and timer tiles are stored twice in a board file (B-01). A project-level mirror of connections and frames is written but never read (B-08).
- **Needless writes:** note-only edits rewrite the board file (B-04), and so does opening a Kanban board with no saved view (BL-02).

### 5.2 Legacy and dead code

- **Legacy paths:**
  - `BoardRouter.svelte:98-112` still creates and saves a default board for an unknown tab. It's the one legacy path that can do harm (B-07).
  - Legacy board fields: Mind Maps still write `board.viewport`, and the `connections` / `frames` id arrays are always empty (B-08).
  - Reading an older note's `parent:` is intended (KL #44).
- **Dead code:**
  - `CurrentBoardDocument.svelte` can never render (E-20).
  - Three unused CSS variables (`--z-canvas-background`, `--z-tile-dragging`, `--z-tab-bar`), possibly-unused keyframes, and a `:hover` rule that can't match (E-28).
- **Comments:** no TODO, FIXME or HACK markers anywhere, and 18 `DECISION:` comments.

### 5.3 Gaps against the design doc

Missing or half-built:
- standalone Documents and "New note" (E-03);
- the text right-click menu (E-04);
- template frontmatter, variables and board skeletons (E-12);
- per-document Current Board settings (E-20);
- "copy link" to a board or tile (E-22);
- "every N" and completion-mode repeats (E-25);
- images inside notes (D-13);
- the Tags Browser's "fade tiles of a tag", and the search-match pulse;
- tile copy and paste (Audit-22 `mindmap-10`).

### 5.4 Docs that no longer match the code

- **Design doc** (E-27):
  - tag Undo toast "15 s" (it's sticky);
  - Kanban toolbar position "per vault in `app.json`" (it's per board in `workspace.json`);
  - inline `#tags` feeding the Tags Browser;
  - "fade tiles of a tag";
  - the search-match pulse;
  - tile copy and paste;
  - Kanban Add Tile "at the top" (it adds at the bottom);
  - standalone Documents.
- **CLAUDE.md:** "one sticky notice per sync-client conflict copy (at open and live)" overstates the code, which covers boards and refused renames only (C-04).
- **KNOWN_LIMITATIONS:**
  - #30 doesn't say Raw view text reaches disk only when you leave the view (C-02).
  - #29's "the file changes only when you change the board" is contradicted by B-04 and BL-02.
- **Code comments:**
  - `AppShell.svelte:386-392` claims the tab shortcuts match VS Code (E-10).
  - `approvedSources.ts` claims `lstat` stops junction escapes (C-07).
  - `vault.svelte.ts` says the snapshot warning shows "once" (C-03).
  - `FileTile.svelte` and `frames.svelte.ts` have stale comments.
- **Help text** promises subfolders and a link action that types into a tile (E-03, E-22).

### 5.5 Size and complexity

- **The app is large for a one-person notes tool:** about 138,000 lines.
  - components: 47,600;
  - lib: 44,100;
  - stores: 19,900;
  - main process: 12,400.

  The tests are about as large again (136,600 lines), plus 91 static safety checks. The guidance docs are big too: CLAUDE.md is 1,062 lines and KNOWN_LIMITATIONS 1,546.
- **Four files are allowed over the 1,000-code-line limit:** `TaskListBoard` (1,368), `KanbanSideToolbar` (1,248), `TaskItem` (1,225) and `KanbanBoard` (1,027). E-01, E-16 and E-19 sit in or next to them.
- **The safety machinery is deep:** drift baselines, holds, captures, parked writes, grace windows, sentinels. It works, as the clean data-safety results show. But each new mechanism has interacted with older ones (section 4).
- **Recommendation for the next round:** prefer fixes that remove or reuse a mechanism rather than add one. The date helper, the delete flow and the inline-tile copy are good candidates.

## 6. The backlog, re-checked

Every open item in `docs/BACKLOG.md` was checked against today's code, and its scores were reviewed. "Plan" means the draft plan (`AUDIT28_IMPLEMENTATION_PLAN_2026-10-04.md`) takes it.

### 6.1 Small findings

| Item | Still there? | What to do | Impact | Hard |
|---|---|---|---|---|
| BL-01 Formatting toolbar cuts off its left end | Yes. Seen in the built app at 1,100 px: the font and size boxes are cut off. It comes with H-04, the sidebar covering the note. | **Plan** (laptop-width layout) | 3/10 (was 2/10: a 1,280–1,366 px laptop hits it) | 2/10 |
| BL-02 Opening a Kanban board with no saved view writes one | Yes. `lastViewFlush.ts` `holdsEveryValue` returns false when no view is saved. | **Plan**, with B-04 (board files rewritten by note edits) | 1/10 | 2/10 |
| BL-03 Escape closes Search only while focus is inside it | Yes (`SearchPanel.svelte`, `onPanelKeydown` on the panel) | **Plan** (quick wins) | 1/10 | 2/10 |
| BL-04 With a filter in the search, `C:\foo` loses its backslash | Yes (`queryParser.ts`, the colon-prefix escape rule) | **Plan** (quick wins) | 1/10 | 2/10 |
| BL-05 A Replace skipped because the note changed still moves on | Yes (not re-run; the code is unchanged) | **Plan** (quick wins) | 1/10 | 1/10 |
| BL-06 Ctrl+Shift+V of a line ending in two spaces reopens as a hard break | Yes (code unchanged) | **Plan**, with the paste fixes (D-02, D-06) | 1/10 | 1/10 |
| BL-07 The Task List speed budget has the least room | It passed today, while five agents were running tests at the same time | Keep in the backlog | 1/10 | 4/10 |
| BL-08 About 0.4 MB kept per reload into the same editor (seen in tests) | Not re-measured | Keep. Measure it in the built app if phone-synced changes become frequent. | 1/10 | 3/10 |
| BL-09 Two watcher tests can fail when the machine is very busy | Both passed today in a full run | Keep | 0/10 | 2/10 |
| BL-10 Test schedulers leave state behind | Yes (the unregister function from `registerArmedPathSource` is never called) | **Plan** (quick wins) | 0/10 | 1/10 |
| BL-14 An empty tile or card never shows "Start typing…" | Yes (only `DocumentEditor.svelte` has the `::before` rule) | **Plan**, with H-01: a new card that takes the caret should show it | 2/10 (was 1/10: with H-01 an empty new card gives no cue at all) | 1/10 |
| BL-15 to BL-18 Notes that read differently on GitHub | Not re-checked | Keep for Track B. You don't read your notes on GitHub or in other apps. | 1/10 | 2/10 to 3/10 |
| BL-21 CI's runner moves to Ubuntu 26 on 2026-10-19 | Still ahead (15 days) | Keep. Look at the first CI run after that date. | 0/10 | 1/10 |

### 6.2 Decisions waiting on you

| Item | Recommendation | Useful | Hard |
|---|---|---|---|
| Small grey text in the four other themes (KL #47) | Decide once you know which theme you use day to day. The Light theme already meets 4.5:1. | 2/10 | 1/10 |
| Light theme's hovered and selected rows (4.49:1 and 4.15:1) | Darken them a touch when the theme is next touched | 1/10 | 1/10 |
| Tile copy, paste and duplicate (Audit-22 `mindmap-10`) | Keep as a feature request. The design doc still mentions tile copy and paste (see E-27). | 5/10 | 4/10 |

### 6.3 Bigger work deferred on purpose

| Item | Recommendation | Useful | Hard |
|---|---|---|---|
| Track B1: write note bodies without `tiptap-markdown` | Keep deferred. D-01 and D-07 sit in the same serializer code (`prosemirror-markdown`'s `renderInline`, `atBlank`, and Filo's `DelimiterRuns`), so fixing them is a down payment on B1. | 6/10 | 6/10 |
| #17 raw blocks | Lower for you: none of your 43 notes opens read-only. The Raw view, which is today's way around a read-only note, needs A-01 and C-02 fixed first. | 4/10 | 6/10 |
| Track B2: Markdown-text editor spike | Stays shelved. You write formatted prose, not code. | 2/10 | 5/10 |
| Splitting the ten files with 900+ raw lines | Fold the Task List part into the E-01 fix: the keyboard-order bug lives between `TaskListBoard.svelte` (allowlisted at 1,368 code lines) and `taskListKeyboardNav.svelte.ts`. | 5/10 | 5/10 |
| A refactor pass on the four allowlisted files | Keep. E-01, E-16 and E-19 show the size hiding consistency bugs, so do it after the Task List fixes. | 4/10 | 6/10 |
| #34 hard-linked notes read-only | Keep. You don't use hard links. | 1/10 | 2/10 |

### 6.4 Known limitations the last audit suggested improving

| # | Recommendation | Useful | Hard |
|---|---|---|---|
| #33 Settings → Recovery (list and delete rescue copies) | **Plan.** C-03 makes the recovery folder show up as a warning on every vault open. | 5/10 (was 3/10) | 3/10 |
| #20 Record each machine's Filo version | **Plan** the cheap half: show the version in the app and bump it with every build (H-09). Leave the per-machine record until a second machine runs Filo. | 4/10 | 1/10 |
| #6 Minimap redraws every tile | Keep. The workaround of hiding the minimap doesn't stick across sessions (E-26), a small fix in the plan. | 4/10 | 5/10 |
| #14 + #15 Board and settings saves get the notes' "changed since I read it?" check | Keep. B-02 is a related case that the plan fixes directly. | 2/10 | 4/10 |
| #28b, #17b, #7, #12, #24, #31, #35, #21, #25, #46, #42, #5 | Keep as they are. Nothing in this audit raises them. | 1/10 to 6/10 (as scored in Audit-27) | 2/10 to 6/10 |

### 6.5 Older items to re-check (backlog section 5)

| Item | Result | What to do |
|---|---|---|
| Audit-22 `legacy-8` (the `.filo/` guard and 8.3 short names) | **Still reproduces.** On this PC `.filo` has the short name `FILO~1`, and the main process accepts `FILO~1/app.json` for delete, overwrite, rename and trash (C-07). It needs a compromised renderer to exploit. | **Plan** (security hardening) |
| Audit-22 `notes-2` (an older copy of Filo's bytes put back within ~10 s taken as Filo's echo) | **No longer reproduces for notes.** Main keeps only the latest landed bytes (`watcherSuppression.ts:100-103`) and the renderer counts only its latest write (`noteWriter.ts:898-904`). What remains is Filo's own in-flight write window, where the STALE re-read makes it harmless, and `.filo/` configs (KL #5). | Close it in the backlog |

## 7. Before you start: a setup checklist

These are specific to how you said you'll use Filo.

1. **Install a build of today's code, not the June installer.** No Filo is installed on this PC, and the only installer, `release/Filo Setup 0.1.0.exe`, is from 8 June. It predates 202 commits, including every data-safety fix from Audit-16 to Audit-27, and writes boards in the old format 7, which today's Filo refuses. Bump `version` in `package.json` (e.g. to `0.2.0`) so you can tell builds apart, then run `npm run package:win`. The installer is unsigned, so Windows SmartScreen will warn you ("More info", then "Run anyway").
2. **Choose where new notes go before you make any board in your book vault.** In a new vault, "Board-specific folders" is off and the Root Directory is the vault's top folder. So every card, task and tile note lands next to your manuscript notes, named `New Card (3).md`, `New Tile 5.md` and so on (H-03, E-13). Under Settings → General → Vault Sidebar, either turn on Board-specific folders or set a Root Directory such as a `Boards` folder.
3. **Keep a real backup.** Filo's trash (30 days) and its `.filo/recovery/` copies live inside the vault, so they are not backups. Turn on Windows File History, or another backup, for `C:\Users\andre\My Files\Vaults`.
4. **If you add Syncthing for the phone,** set the folder to **Send Only** on the PC and **Receive Only** on the phone, and turn on **Staggered File Versioning** on the phone. Then nothing on the phone can change or delete a note on the PC, and the phone keeps a history of old versions. Filo never needs to run on the phone. If you later want to edit on the phone, C-04 (conflict copies not announced) and C-05 start to matter.
5. **Until the plan's first phases land:**
   - Use the Raw view for short fixes only. Click out of it (or press Ctrl+S) every few minutes, and don't press Ctrl+Z in it after the note has changed elsewhere (A-01, C-02).
   - In the "changed by another program" prompt, choose **Keep mine**, which backs up the other version, not **Reload**, which throws your typing away (A-02).
   - Paste from Word, Google Docs or web pages with **Ctrl+Shift+V** (plain text) (D-02, D-06).
   - After adding a card or tile, click into it before typing (H-01).
   - In a Task List, set the sort to Manual before using Shift-click and bulk actions (E-01). Keep the last section expanded, or quick-added tasks seem to vanish (E-02).
   - Don't drag files from `.filo/recovery` onto a board. Open a rescue copy in a text editor and paste its text instead (C-01).
   - Don't start a title with a dot (`...and then she ran`): the note becomes a hidden file (A-03).
6. **What the first open of your book vault does:** on a copy, Filo created its `.filo` folder and changed no note. All 43 notes across your vaults open editable. 39 would save byte for byte, and the other 4 lose only spaces at the ends of lines on their first save (`From Canvas.md` and `Leveling System Ideas.md` in the book vault, plus their copies in TEST VAULT V2). Typing into your empty `Creature lexicon.md` saved correctly.

## 8. What was checked and found sound

So nobody re-checks these without cause:

- **Note writes:**
  - Each flush works on a fresh read and checks drift against the base.
  - The STALE compare-and-swap uses the hash up to 16 MB.
  - Renames are re-keyed while a write is queued or in flight.
  - Keep mine builds only on the bytes it backed up.
  - Editors serialise before they unmount, so tab, pane and board switches inside the 150 ms window keep the text.
  - Rescue copies hold serialised keystrokes, refused bodies, raw text, notes-box drafts and frontmatter-only changes. (Finder A)
- **Frontmatter:** these are all handled: CRLF, BOM, comments, flow lists, refused duplicate keys, `---\n---`, and scene breaks (`---`, `***`, `* * *`) in a note with or without frontmatter (`bodyWithoutFenceLookalike`). (Finder A)
- **Board saves after Audit-27's fix:**
  - The full-save capture logic holds under every interleaving traced: two full saves, a flush during a capture, cancel, reset, overdue, holds.
  - The board drift hold refuses without toasts and keeps the write for the answer.
  - Reload drops pending, parked and retained writes and clears history. (Finder B)
- **Undo:**
  - Identity-guarded rollbacks, rename following, and reload dropping the steps it invalidates.
  - Task List moves recorded as membership and order; the subtask insert index.
  - Kanban filtered drops; recurring completion decided from a fresh read. (Finder B)
- **Trash:** a restore never replaces a file, "(restored)" copies are re-targeted, the purge covers this machine's items only, and a refusal asks before deleting for good. (Finder B)
- **Leaving a vault:**
  - Close, open-another-vault and quit save first, with the editors frozen, settled, and a second save.
  - Session end holds Windows only when work could be lost.
  - The quit check counts titles being typed, filters, viewports, recordings, raw views, notes-box drafts, held decisions and Settings edits.
  - A vault swap mid-`await` is guarded. (Finder C)
- **Syncthing basics:** temp files (`~syncthing~*.tmp`) and `.stversions` are ignored. A delivery with an older modified time is still caught, because the STALE check compares for equality, not order. Own echoes are told apart by their bytes. (Finders A and C; E2E `syncDeliveries`)
- **Security and packaging:**
  - Single-instance lock, sandbox, preload validation, deny-by-default permissions, navigation and popup guards, the `filo://` media guard.
  - Redirects in the link-preview fetch are re-validated hop by hop.
  - After BL-20, the packaged main process needs only Node built-ins plus `electron`, and the CSP matches dev apart from the dev server. (Finder C)
  - Spell check: `%APPDATA%\filo\Dictionaries` is empty, so on Windows the built-in spell checker is used and nothing is downloaded. (Checked by me; C-11c refuted.)
- **The editor:**
  - 28 hand-made formatting combinations (colour inside bold; overlapping highlight, underline and italic; a coloured, highlighted, bold checklist item in a quote; an aligned heading with a coloured word; emoji and non-Latin text; dashes, curly quotes, ellipses).
  - A 4,000-run property sweep extended with colour, font, size and two highlight colours, apart from the D-01 class.
  - Typed `[[wiki]]`, `#hashtag`, `*sighs*`, `_names_` and `~5` stay editable.
  - Commit-on-click-away titles, lazy card mounting, the static preview (highlight, underline, colour, font, alignment) and the TipTap 3.31.4 table fix. (Finder D)
- **The views:**
  - Recurrence across month ends, leap years and DST; the midnight and wake rollover; local-date overdue checks.
  - Kanban keyboard and Shift-click order, context-menu keys and focus restore, modal focus traps, reduced motion, zoom limits.
  - No native `alert` or `confirm`, and only 3 unused CSS custom properties out of 151. (Finder E and me)
- **Test suites on Windows today:**
  - `ci:verify` passed: lint, knip, svelte-check, main typecheck, 804 test files (7,836 passed, 5 skipped), build, and 91/91 gates in 265 s.
  - The E2E suite passed 29/29 with the 5,000-note scale budgets, in 2.7 minutes.

## 9. How the audit was done

- **Agents:** you chose 5 finders and 2 refuters. Every prompt said "no helper agents", and none were spawned.
  - Finder A: the note write path.
  - Finder B: boards, `.filo/` settings, undo, trash, tags.
  - Finder C: vault lifecycle, file watcher and Syncthing, recovery, security, packaging.
  - Finder D: the editor and Markdown fidelity.
  - Finder E: the four views' behaviour, cross-cutting UI, code health and docs.
  - Refuter 1 checked Finders A, B and D. Refuter 2 checked Finders C and E. Both were stopped once by an account usage limit and resumed from where they were.
  - Each finding carries the refuter's verdict. Refuted claims are listed in section 3.3 so they aren't re-filed.
- **My own checks:**
  - **Baseline runs:** `ci:verify` and the full E2E suite with scale budgets, on Windows.
  - **Recent changes:** a review of the 24 commits since the last audit's base (`abf5212`).
  - **Your vaults, read-only:** board formats, the empty note, the absence of an installed build.
  - **The corpus check** on copies of your 43 notes.
  - **Three scripted tours of the built app** on a copy of your book vault, with screenshots: every view, 1,440 and 1,100 px widths, the dark theme, Settings, Search, where keyboard focus lands after adding a card or tile, and typing into a selected task row. The H-findings come from these.
  - **The backlog, re-checked** item by item.
  - **Sweeps** for unused CSS, legacy branches and leftover TODOs: none of the latter.
- **Repro tests:** about 35 small tests written by the finders, each failing on today's code as described. They are saved in this session's scratchpad (`repros\finder*`), not in the repo. The plan turns the relevant ones into permanent tests.
- **Not reached, or reached only lightly:**
  - Connection routing.
  - Timer, Audio, Link and Iframe tiles.
  - The Settings panels in depth.
  - The Tags Browser, Orphan Catcher, Relink and Recovery modals in depth.
  - IME composition with a real Windows input method.
  - Files dropped from Explorer onto an editor.
  - Minimap performance.
  - Memory over a long session.

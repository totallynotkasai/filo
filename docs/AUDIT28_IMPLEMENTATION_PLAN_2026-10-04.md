# Audit-28 implementation plan (draft, 2026-10-04)

- **Source:** [AUDIT28_PRE_DAILY_USE_2026-10-04.md](AUDIT28_PRE_DAILY_USE_2026-10-04.md). Finding IDs (A-01, H-01 …) refer to it.
- **Status:** Phases 0 and 1 done on 2026-10-04, Phases 2, 3, 4, 5, 6A and 6B on 2026-10-05, Phase 7 on 2026-10-06 (see section 4); Phase 6 was split into 6A and 6B at the owner's request. Phase 8 is not started. Decisions D1 to D10 have defaults (section 3); Phase 0 used D3 and D10 at their defaults, Phase 1 used D1, D4 and D5 at theirs, Phase 2 D6 and D7 at theirs, Phase 3 D2 at its default, Phase 4 D8 at its default, Phase 5 D9 at its default.
- **Scores:** out of 10, as in the report. **Hard:** 0/10 = minutes, 5/10 = a few days with tests, 10/10 = weeks.

## 1. How this plan works

- **Order:**
  1. protect your text;
  2. the formatting you rely on;
  3. making and finding notes;
  4. the four views;
  5. sync, recovery and boards;
  6. hardening and tidying last.

  Phases 0 and 1 are what I'd finish before you put real work into Filo.
- **Each fix starts with a test that fails on today's code.** The finders' repro tests are in this audit session's scratchpad, under `…\a643b672-214a-4fbb-a882-00f42072ec2d\scratchpad\repros\finder*` and `refuter*`. They are the starting point; turn each into a permanent test in the right project. Test the *interaction* each fix touches, not only the fix (see the report's section 4).
- **Each phase ends with:**
  - `npm run ci:verify` on Windows;
  - the E2E suite (with `FILO_E2E_SCALE=1`) when the phase touches the shell, startup, quit, file watching or the editor;
  - the corpus check (`corpus:run` + `corpus:compare` against today's baseline) for any phase that touches the editor or Markdown writing;
  - an outcome section in this file: what changed, deviations, new findings.
- **Findings a phase doesn't fix go to `docs/BACKLOG.md`** as BL-25 onwards (Phase 0 used BL-22 to BL-24 and fixed them, Phase 1 BL-25 and BL-26; Phase 2 added BL-27, fixed there, and BL-28; Phase 3 BL-29 and BL-30, fixed there, and BL-31 and BL-32; Phase 4 added two owner decisions and no numbered item; Phase 5 BL-33 and BL-34, fixed there, and BL-35; Phase 6A BL-36, fixed there; Phase 6B BL-37 and BL-38, fixed there; Phase 7 took BL-04, BL-05 and BL-10 and added BL-39).
- **Comments explain why, never history.** Audit IDs go in commit messages.

"Sum of Hard scores" adds up the Hard scores of the phase's tasks. It's a rough guide to size, not a score.

| Phase | What | Findings | Tasks | Sum of Hard scores | Rough size |
|---|---|---|---|---|---|
| 0 | Before day one: release and setup | H-09, H-03 | 2 | 2 | half a day |
| 1 | Your text first | A-01, A-02, C-02, A-05, D-02, H-01 (+ BL-14), A-03, E-07, A-S1 | 9 | 15 | 4–6 days |
| 2 | Formatting that survives a save | D-01, D-06 (+ BL-06), D-03, D-04, D-05, D-09, D-08, D-10, D-11, D-12, D-13, D-07 | 12 | 24 | 6–8 days |
| 3 | Making and finding notes | E-03, E-13, E-11, H-08 / E-08, H-02, H-07, E-12, E-14, H-05 | 9 | 17 | 4–6 days |
| 4 | Task List and Kanban correctness | E-01, E-02, E-05, E-15, E-16, E-17, E-06, E-18, E-25, A-06, E-19, E-24 | 12 | 23 | 6–8 days |
| 5 | The interface around the views | E-04, E-10, H-04 (+ BL-01), H-06, H-10, E-09, E-21, E-26, E-23, E-22, E-20, BL-03 | 12 | 20 | 5–7 days |
| 6A | Sync and recovery (tasks 6.1–6.8) | C-03 (+ #33), C-01, C-04, C-05, C-06, C-10, C-09, C-11 | 8 | 16 | 3–4 days |
| 6B | Notes and boards (tasks 6.9–6.18) | A-07, A-04, B-01, B-02, B-03, B-04 (+ BL-02), B-05, B-07, B-09, B-06 | 10 | 19 | 4–5 days |
| 7 | Hardening, tidying and docs | C-07, C-08, A-S2, B-08, E-28, docs drift, BL-04, BL-05, BL-10 | 6 | 13 | 3–4 days |
| 8 | Verification and archive | — | — | — | 1 day |

Phases 2 to 7 can be reordered or split to suit you; each stands on its own. Phase 2 needs Phase 1's paste fix (D-02) first.

## 2. Phases

### Phase 0: before day one (release and setup)

| # | Task | Finding | Hard |
|---|---|---|---|
| 0.1 | Show the version in the app, as one line in Help → About or the Settings footer: `app.getVersion()`, passed to the preload like `systemLocale`. Bump `package.json` to `0.2.0` (D10), build the installer (`npm run package:win`), and move the 8 June installer out of `release/`. *Done with two deviations: the version is read from `package.json` at build time, and it shows in the Settings footer (section 4).* | H-09 | 1/10 |
| 0.2 | A new vault's boards get their own folders. Turn `general.boardFolders` on in a new vault's `app.json`, or ask where notes should go when the first board is made (D3). Existing vaults keep their setting. *Done (folders on, D3's default); the characterisation suite needed updating, so nearer Hard 2/10 (section 4).* | H-03 | 1/10 |
| 0.3 | You: the setup checklist in the report's section 7 (where notes go, backups, Syncthing direction). | — | — |

**Pass:** the version shows in the app. A new vault's first board makes its own folder, and its cards land there. The installer built from this commit installs and opens a copy of your book vault.

### Phase 1: your text first

| # | Task | Finding | Hard |
|---|---|---|---|
| 1.1 | The Raw view clears its undo history whenever it loads text from disk (`rawTextEditor.ts` `setText`): `history()` in a Compartment, reconfigured to `[]` and back, keeping the selection. Unit: `undo(view)` is false after `setText`. Component: the finder's two cases (follow, then Ctrl+Z; Show the new version, then Ctrl+Z) save no mix. *Done as planned (section 4).* | A-01 | 2/10 |
| 1.2 | Before **Reload** in the note conflict prompt, keep your version in `.filo/recovery/<ts>-keep/` and offer **Undo reload**. In the Raw view, keep a rescue copy before showing the new version and relabel the button "Use the new version (discard mine)" (D1). *Done; the copy is kept by the note store itself, and a copy that can't be written asks first (section 4, deviation 1).* | A-02 | 2/10 |
| 1.3 | The Raw view saves 1.5 s after typing stops, through its normal save, which keeps the whole-file conflict check. The Task List notes box does the same. KL #30 is updated. *Done (section 4).* | C-02 | 2/10 |
| 1.4 | A Raw save the writer skips (non-UTF-8, link, other vault) reports a failure and keeps the text and a rescue copy, instead of "saved". *Done (section 4).* | A-05 | 1/10 |
| 1.5 | Pasted HTML never makes an empty colour, font or size mark. Filo's TextStyle `parseHTML` accepts a span only when it carries `color`, `font-family` or `font-size`, and the writer never emits a bare `<span>`. Add Word, Google Docs and web paste fixtures: save, reopen, not read-only (browser project). *Done (section 4).* | D-02 | 2/10 |
| 1.6 | A new card or tile opens with its title selected for editing, so typing replaces "New Card", and its empty body shows "Start typing…". Single-letter shortcuts (Mind Map `n`, `c`, Enter, Backspace; Kanban `n`, Shift+N) act only while the board or canvas element itself has focus (D4). E2E: add a card and type at once, and the title holds the text. On the Mind Map, typing "Antagonist" right after New Tile makes no extra tiles. *Done, with "has focus" read as "focus is inside the board", and Escape keeping a new title (section 4, deviations 2 and 3).* | H-01, BL-14, part of E-08 | 3/10 |
| 1.7 | No hidden names from titles. `safeFileName` strips leading dots and spaces; `fileNameProblem` and `boardNameProblem` refuse a leading dot. *Done (section 4).* | A-03 | 1/10 |
| 1.8 | Escape in a task's notes box saves and closes, as clicking away does (D5). *Done (section 4).* | E-07 | 1/10 |
| 1.9 | Ctrl+S commits a task title being typed (register its commit with `registerComponentFlush`). *Done; Save also had to be let through in text fields (section 4, deviation 4).* | A-S1 | 1/10 |

**Pass:**
- Every finder repro listed above passes.
- `ci:verify`.
- E2E: `rawView.e2e.ts` gains Ctrl+Z after an outside change, and the new-card and new-tile typing cases.
- The corpus check shows 0 changed and 0 newly read-only.
- The hands-on tour script from this audit (`scratchpad\ux\ux.pass.ts`) shows typed titles in the cards and tiles, and no stray `New Tile` notes.

### Phase 2: formatting that survives a save

| # | Task | Finding | Hard |
|---|---|---|---|
| 2.1 | A whitespace-only run keeps bold, italic or strike only when both neighbours have it. This pre-pass sits beside `withBreakMarksTrimmed`, as the finder's `A28D_FIX` sketch does. The round-trip property test's generator gains whitespace runs, font and size, and drops its "a formatted space shows nothing" exclusion. *Done; the rule also needs the marks nested outside to match (section 4, deviations 1 and 2).* | D-01 | 2/10 |
| 2.2 | A paste clean-up (`transformPastedHTML`) that: drops near-default colour (black or white), the source's base font and point sizes; turns a span's `background-color` into a highlight; and turns Word's `mso-list` bullets into real lists (D6). BL-06: a literal paste drops the spaces before each line break. *Done, D6 at its default (section 4, deviation 3).* | D-06, BL-06 | 3/10 |
| 2.3 | The size box and + / − start from the size shown at the caret (computed style), converting `pt` to px. *Done as planned (section 4).* | D-03 | 1/10 |
| 2.4 | Enter inside a tile, card, frame or connection-label title commits it (handled in the label editor's keymap), and IME composition is ignored. *Done (section 4, deviation 4).* | D-04 | 1/10 |
| 2.5 | Filo's own list-type switch: changes list and item types in place and keeps the depth. Disable the button where it can't. *Done; Ctrl+Shift+9 now changes the whole list (section 4, deviation 5).* | D-05 | 3/10 |
| 2.6 | Scene breaks: `* * *` and a lone `#` + Enter become a horizontal rule. No heading or list input rule fires on Enter, and `1984. ` doesn't start a list (D7). *Done, D7 at its default (section 4, deviation 6).* | D-09 | 2/10 |
| 2.7 | Quote imported font family names. *Done (section 4).* | D-08 | 1/10 |
| 2.8 | Allow `font-size` (and indent, for W-9) in the title and preview sanitiser. *Done, with caps (section 4, deviations 7 and 8).* | D-10 | 1/10 |
| 2.9 | The spell-check toggle applies to editors opened later and is remembered (`.filo/workspace.json`). *Done (section 4).* | D-11 | 1/10 |
| 2.10 | A table with a set column width is written as HTML, or column resizing is turned off. *Done: written as HTML (section 4).* | D-12 | 2/10 |
| 2.11 | Images in a note load through `filo://` (vault-relative sources rewritten in the image extension's render). The card preview shows them. *Done, in a node view so the file keeps its address (section 4, deviations 8 and 10).* | D-13 | 3/10 |
| 2.12 | Long-note saves: take `DelimiterRuns`' filter out of the loop, and track the last character instead of re-scanning in the serializer state. Above about 20,000 words, save on pause less often. *Done (section 4, deviation 9).* | D-07 | 4/10 |

**Pass:**
- Browser-project specs for each item.
- The extended property sweep (new generator, two seeds × 2,000 runs) is clean.
- The corpus check shows 0 changed and 0 newly read-only, with any intended change named.
- `markdownContentElsewhere.test.ts` is still green.

### Phase 3: making and finding notes

| # | Task | Finding | Hard |
|---|---|---|---|
| 3.1 | "New note" and "New folder" on the sidebar's folder menu and empty-space menu: create with a title (`createNoteFile`), then open in a Document tab. Ctrl+N in a Document tab makes a note. Document joins the New Tab menu. Help's "subfolders" line becomes true. | E-03 | 3/10 |
| 3.2 | A note Filo created under a placeholder name (`New Card (n)`, `New Tile n`, `New Task n`) is renamed to match its first title, undoably (D2). The sidebar search also matches titles. | E-13 | 2/10 |
| 3.3 | One shared natural collator (`Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })`) for the sidebar, Task List and Kanban title sorts. Group By becomes the primary key. | E-11 | 1/10 |
| 3.4 | The Mind Map's single-letter keys become registered commands, listed in Help → Shortcuts and rebindable. With 1.6's focus rule this closes E-08: the canvas ignores keys the sidebar handled (`defaultPrevented`). | H-08, E-08 | 2/10 |
| 3.5 | New tiles from the side toolbar step clear of the last new tile instead of stacking. | H-02 | 1/10 |
| 3.6 | Undoing a just-created empty tile moves its note to Filo's trash, and redo restores it. | H-07 | 2/10 |
| 3.7 | One template path for every board: merge and fill in the template's frontmatter (`{{date}}` …), and create a board template's columns and tiles. | E-12 | 2/10 |
| 3.8 | The cover, File tile and background pickers link a file already in the vault instead of copying it. | E-14 | 1/10 |
| 3.9 | The Search panel lists matching notes, grouped, under the box. | H-05 | 3/10 |

**Pass:**
- Component tests for each item.
- E2E: make a note and a nested folder from the sidebar, with no board involved. A card titled "The Siege" is found by sidebar search, and its file is `The Siege.md`.

### Phase 4: Task List and Kanban correctness

| # | Task | Finding | Hard |
|---|---|---|---|
| 4.1 | Arrow keys, Tab and Shift-click use the rendered row order (flattened sections, collapsed rows excluded), as Kanban already does. *Done; Ctrl+A follows it too (section 4).* | E-01 | 3/10 |
| 4.2 | Quick add uses Add task's section rule (last used, else first), and expands the section or says where the task went. *Done: both (section 4, deviation 2).* | E-02 | 1/10 |
| 4.3 | Quick add matches weekday names and their usual abbreviations only, doesn't read a fraction between words as a date, and reads "tomorrow 5pm". A repeat token ("every friday", "every 2 weeks") if D8 says yes. *Done, D8 at its default (section 4, deviation 3).* | E-05 | 2/10 |
| 4.4 | The status filter uses the grouping's bucket rule, and lists the statuses actually present. *Done (section 4).* | E-15 | 1/10 |
| 4.5 | Group By works within sections, and the control never disables itself. *Done; new lists start ungrouped, and the old grouped view is gone (section 4, deviation 4).* | E-16 | 2/10 |
| 4.6 | The date picker: focus the selected day on open, arrow-key grid, Escape, focus returned, readable labels, locale week start. *Done (section 4, deviation 5).* | E-17 | 2/10 |
| 4.7 | The Kanban due-date box keeps a draft and commits on Enter or blur (or reuses the Task List picker). The time box commits once. *Done: the card uses the Task List picker (section 4).* | E-06 | 1/10 |
| 4.8 | Keyboard selection pans or scrolls to the selection, and a single card's menu gains "Move to column". *Done (section 4, deviation 6).* | E-18 | 3/10 |
| 4.9 | The Repeat menu gains "every N days, weeks or months" and the completion mode, and warns about a rule it can't read instead of completing the task for good. *Done; Complete still completes such a task, and warns with Undo (section 4, deviation 7).* | E-25 | 2/10 |
| 4.10 | An open, untouched notes box follows its note. *Done (section 4).* | A-06 | 2/10 |
| 4.11 | One delete flow (Backspace through the shared Delete), one priority vocabulary, one collapse-undo policy. *Done (section 4, deviation 8).* | E-19 | 2/10 |
| 4.12 | One date parser and one display formatter in `lib/utils/dateFormat.ts`, used everywhere. *Done, for calendar days (section 4, deviation 9).* | E-24 | 2/10 |

**Pass:**
- The finder repros for E-01, E-02, E-05, E-06 and E-15 pass.
- A characterisation case: a priority-sorted list, then a Shift-click range and bulk delete, removes only the highlighted rows.
- E2E `dailyDriver` is still green.

### Phase 5: the interface around the views

| # | Task | Finding | Hard |
|---|---|---|---|
| 5.1 | A right-click menu on text, built in main from roles (Cut, Copy, Paste, Select All, enabled from `editFlags`), plus the spelling items and "Insert link" (sent to the renderer) (D9). *Done, D9 at its default; main asks the renderer whether a link can go at the caret, and the popup opens where the menu did (section 4, deviation 1).* | E-04 | 2/10 |
| 5.2 | Ctrl+W, Ctrl+Tab and Ctrl+Shift+Tab work while typing. Ctrl+S and Ctrl+Shift+F work in text fields. *Done; the edit ends first, and Ctrl+W waits for the title it commits (section 4, deviation 2).* | E-10 | 1/10 |
| 5.3 | Laptop widths: below a breakpoint, a docked sidebar pushes the content instead of covering it (or folds away). The toolbar uses `justify-content: safe center` (BL-01). Check at 1,100, 1,280 and 1,366 px. *Done; the breakpoint is 1,340 px (the page plus the sidebar both sides), and the toolbar narrows and folds into "More formatting" as its room calls for (section 4, deviations 3 and 4).* | H-04, BL-01 | 2/10 |
| 5.4 | A Settings button in the toolbar, and one saving rule for every Settings tab, or clearer labels. *Done: the gear button, and clearer labels (section 4, deviation 5).* | H-06 | 1/10 |
| 5.5 | The formatting toolbar shows as disabled when no editor has focus. *Done (section 4).* | H-10 | 1/10 |
| 5.6 | Dragging a frame moves the frames inside it. Membership is recomputed for every affected frame, and frames are ordered by nesting. *Done (section 4, deviation 6).* | E-09 | 4/10 |
| 5.7 | Keyboard focus entering a pane makes it the active pane. *Done as planned (section 4).* | E-21 | 1/10 |
| 5.8 | The minimap and waypoint toggles are remembered per board. *Done, in `.filo/workspace.json` (section 4).* | E-26 | 1/10 |
| 5.9 | Messages in plain words. Add "placement", "backing", "out-of-band" and "persist" to the components gate's word list. *Done; "backing up" stays allowed (section 4).* | E-23 | 1/10 |
| 5.10 | "Copy link to board / tile / note", and Help text that matches. *Done, cards and tasks too; main writes the clipboard (section 4, deviation 7).* | E-22 | 3/10 |
| 5.11 | Remove `CurrentBoardDocument.svelte` and its spec line, or store per-note page settings (decide in the phase). *Done: removed (section 4, deviation 8).* | E-20 | 2/10 |
| 5.12 | Escape closes the Search panel wherever focus is, unless something above it takes the key. *Done (section 4, deviation 9).* | BL-03 | 1/10 |

**Pass:**
- Component tests.
- The axe E2E scan is still clean.
- Screenshots at 1,100 and 1,366 px show nothing covered or cut off.

### Phase 6: sync, recovery and boards

The owner asked for this phase in two parts, each its own session and commit. The split follows the subsystems:
- **6A, sync and recovery** (6.1 to 6.8): the watcher, the vault-open checks, rescue copies, crash Reload and Home. Done on 2026-10-05 (section 4).
- **6B, notes and boards** (6.9 to 6.18): the Raw view and Convert to UTF-8, then the board writer, drift, undo steps and the older-board notice. Done on 2026-10-05 (section 4).

Each part has its own pass test, below the table.

| # | Task | Finding | Hard |
|---|---|---|---|
| **6A** | | | |
| 6.1 | The vault-open warning lists only new failed-load snapshots. Add Settings → Recovery to list, open and delete rescue copies and kept versions (KL #33). *Done; every snapshot is already named by its own notice, so the open notice is now a safety net, and the tab shows sizes too (section 4, deviation 1).* | C-03, #33 | 3/10 |
| 6.2 | A file dropped from a hidden vault folder is copied in, not linked. `recovery:keep-unsaved` writes item by item. A refused write isn't called a disk-space problem. *Done; main also had to allow copying a file the user chose out of `.filo/recovery` or `.filo/trash` (section 4, deviation 2).* | C-01 | 2/10 |
| 6.3 | Announce note conflict copies (`.sync-conflict-`), live and at open, and fix CLAUDE.md's line. *Done, for strong names only, with Open the copy (section 4, deviation 3).* | C-04 | 2/10 |
| 6.4 | The correlator doesn't pair a "present" path that was already a known file. Or: a displaced note with unsaved work becomes a backed-up conflict. *Done: the first option (section 4, deviation 4).* | C-05 | 3/10 |
| 6.5 | A watcher overflow (null filename) schedules a reconcile at once. *Done (section 4, deviation 5).* | C-06 | 1/10 |
| 6.6 | A folder move the renderer follows also moves the watcher's walk records. *Done, and the watcher's own renames move theirs (section 4, deviation 6).* | C-10 | 3/10 |
| 6.7 | A crash Reload releases the vault registry and the watcher first. *Done as planned (section 4).* | C-09 | 1/10 |
| 6.8 | Home waits for the recent-vaults list before auto-opening. *Done as planned (section 4).* | C-11 | 1/10 |
| **6B** | | | |
| 6.9 | Switching tabs away from a conflicted Raw view asks, as closing does. *Done; the switch saves the text first, and the view now saves under its own note when torn down (BL-37, section 4, deviation 1).* | A-07 | 3/10 |
| 6.10 | A forced reload with a queued body goes through the conflict check. Convert to UTF-8 unfreezes only after its reload. *Done, with a read-only hold (section 4, deviation 2).* | A-04 | 2/10 |
| 6.11 | Link, embed and timer tiles are stored once. Readers skip a stale copy; the tag-delete Undo puts back what it changed. *Done; the load drops a stale copy too, and two readers that needed it were fixed (BL-38, section 4, deviation 3).* | B-01 | 2/10 |
| 6.12 | A board moved during a full save is re-scheduled, so its frozen copy is replaced, and stale failure marks are cleared. *Done (section 4, deviation 4).* | B-02 | 3/10 |
| 6.13 | The board drift answer follows a rename. *Done, and a stale prompt left by a rename is gone (section 4, deviation 5).* | B-03 | 1/10 |
| 6.14 | Note-only edits don't rewrite the board file. Opening a Kanban board writes no default view (BL-02, which must be fixed before the first real board-format step). *Done: steps say whether they change the board; the Task List too (section 4, deviation 6).* | B-04, BL-02 | 2/10 |
| 6.15 | The Global Defaults frame image follows renames and deletes. *Done (section 4, deviation 7).* | B-05 | 2/10 |
| 6.16 | Remove BoardRouter's default-board auto-create. *Done, with an empty state (section 4).* | B-07 | 1/10 |
| 6.17 | The saved-views and style undo steps record per-key changes. *Done, every style popup and connection labels included (section 4, deviation 8).* | B-09 | 2/10 |
| 6.18 | The older-board notice says "rebuild the board; its notes are safe", and a string version is called invalid, not old. *Done (section 4, deviation 9).* | B-06 | 1/10 |

**Pass, 6A:**
- The finder repros for C-01, C-03, C-04 and C-05 pass.
- `syncDeliveries.e2e.ts` gains a note conflict-copy case.
- `ci:verify` on Windows, and the full E2E suite with scale.

**Pass, 6B:**
- The finder repros for B-01 and B-02 pass (`…\a643b672-…\scratchpad\repros\finderB`).
- `ci:verify` on Windows, and the full E2E suite with scale.

### Phase 7: hardening, tidying and docs

| # | Task | Finding | Hard |
|---|---|---|---|
| 7.1 | The `.filo/` guards use the canonical long-name path (8.3 names). `vault:copy-file` checks the destination before writing and resolves real paths for sources. *Done; Filo's trash move and the `filo://` media check go through it too, and a gate check pins it (section 4, deviation 1).* | C-07 (legacy-8) | 3/10 |
| 7.2 | The link-preview fetch validates the connected address on every hop. *Done, in a fetch of Filo's own on Node's `http` / `https` (section 4, deviation 2).* | C-08 | 3/10 |
| 7.3 | Names are capped by UTF-16 units (Windows) and UTF-8 bytes (Android), and a failed create leaves no broken tile. *Done; one cap in UTF-8 bytes covers both (section 4, deviation 3).* | A-S2 | 2/10 |
| 7.4 | Remove dead CSS and code (E-28). Drop legacy board fields with the first real format step (B-08). *Done for the code; the fields in board files wait for the first format step, as planned (BL-39; section 4, deviation 4).* | E-28, B-08 | 1/10 |
| 7.5 | Docs: the design-doc drift list (E-27), CLAUDE.md's conflict-notice line, KL #29 and #30, and stale code comments (report section 5.4). *Done; earlier phases had already fixed most of the list (section 4, deviation 5).* | docs | 1/10 |
| 7.6 | Backlog quick wins: BL-04 (keep backslashes except before a colon), BL-05 (stay on a skipped Replace), BL-10 (scheduler `dispose()` for tests). *Done (section 4, deviation 6).* | BL-04, BL-05, BL-10 | 3/10 |

**Pass:** `ci:verify`. The two security cases have unit tests (the finder's `zzA28C_filo83` and `zzA28C_copyJunction`).

### Phase 8: verification and archive

- `ci:verify` on Windows.
- E2E with `FILO_E2E_SCALE=1`.
- E2E against a packaged build (`npm run package:dir`, then `FILO_E2E_EXE`).
- The corpus check against today's baseline.
- The three hands-on tour scripts on a fresh copy of your book vault: none of the H-findings reproduces.
- Update `docs/BACKLOG.md`: remove what was taken, add what wasn't (BL-25 onwards). Close `notes-2`; `legacy-8` closes with 7.1.
- Archive the report and this plan to `docs/archive/`.

## 3. Decisions for you (defaults in bold)

| # | Decision | Options | Default |
|---|---|---|---|
| D1 | Reload in a conflict | **Keep a copy of your text and show "Undo reload"** / ask before discarding | Keep a copy |
| D2 | Placeholder file names | **Rename the file at its first title, while it still has its placeholder name** / a bulk "Rename files to match titles" command / leave as is | Rename at first title |
| D3 | Where a new vault's board notes go | **Board-specific folders on by default** / ask when the first board is made | Folders on |
| D4 | The Mind Map's and Kanban's single-letter shortcuts | **Keep them, only while the board or canvas has focus, registered as commands** / remove them | Keep, scoped |
| D5 | Escape in a task's notes box | **Save and close** / ask when the text changed | Save and close |
| D6 | Rich paste | **Keep colours, fonts and sizes that differ from your defaults; drop black text, the source's base font and pt sizes** / paste plain text unless Ctrl+Shift+V | Clean up |
| D7 | Typed scene breaks | **`* * *` and a lone `#` + Enter become a horizontal rule** / only stop them turning into a list or heading | Horizontal rule |
| D8 | A repeat token in quick add ("every friday", "every 2 weeks") | **Add it** / leave quick add without repeats | Add |
| D9 | The text right-click menu | **Cut, Copy, Paste, Select All, Insert Link, plus spelling** / also Insert Template | Without templates |
| D10 | Version numbers | **`0.2.0` now; bump for every build you install** / dates as versions | `0.2.0` |

## 4. Outcomes

Each phase adds its outcome here when it's done.

### Phase 0 outcome (2026-10-04)

**Status:** done, with the three small findings it turned up (BL-22 to BL-24) fixed in the same phase at the owner's request, and committed. D3 and D10 were taken at their defaults: board-specific folders on for new vaults, and version `0.2.0`.

**What changed**
- **0.1, the version (H-09).**
  - Settings shows `Filo 0.2.0` at the foot of its tab rail, under the tabs and outside the tablist (`components/modals/ProjectSettings.svelte`). The text comes from `src/renderer/constants/appVersion.ts`, which reads `version` from `package.json` when the app is built. Only that string reaches the renderer bundle (checked in `dist/`).
  - `package.json` and `package-lock.json` are at `0.2.0`.
  - The installer is `release/Filo Setup 0.2.0.exe` (112,846,107 bytes, built from the final code). Its `Filo.exe` carries ProductVersion 0.2.0.0, and `app.asar` is 6.7 MB.
  - The 8 June build (installer, blockmap, `latest.yml`, `builder-debug.yml`, `win-unpacked/`) moved to `release-archive/0.1.0 (2026-06-08)/`, which `.gitignore` now ignores.
- **0.2, a new vault's boards get their own folders (H-03).**
  - `newVaultGeneralSettings()` (`src/shared/generalSettingsDefaults.ts`) is the General defaults with `boardFolders: true`, and `initVaultConfig` (`src/main/vault/configOps.ts`) seeds a new vault's `app.json` with it.
  - The schema default stays `false`, so an existing vault whose `app.json` has no `boardFolders` key keeps its notes where they went.
  - Only a folder with no `.filo/` is seeded. A `.filo/` already there (opened before, or arriving through sync) is left alone, as before. Your book vault has no `.filo/`, so its first open turns board folders on.
- **Tests:**
  - **Unit** (`generalSettingsDefaults.test.ts`): the seed has board folders on, and an `app.json` without the key reads as off.
  - **Component** (`projectSettingsDialog.test.ts`): the version line matches `package.json` and sits outside the tablist.
  - **Characterisation** (`boardFolders.test.ts`, "a new vault"): the first board makes its own folder and its card lands there; an existing vault's `app.json` without the key keeps folders off.
  - **E2E** (new `versionAndNewVault.e2e.ts`), on a folder with no `.filo/`: Settings shows the build's version; the first Kanban board and its card go into `Kanban 1/`; nothing else is added to the top of the vault.
  - **Bite check:** with the seed set back to off, the unit test and the new characterisation case fail.
- **Docs:**
  - CLAUDE.md: the board-name gotcha says what a new vault seeds and that, with board folders on, a board's name must be free in the whole vault. The structure lists `constants/appVersion.ts`, and the `vaultDeleteOps.ts` line says its undo puts boards' cameras back.
  - `docs/BACKLOG.md`: BL-22 to BL-24 were written there, then fixed here, so the backlog only notes them; its next new item is BL-25.

**Deviations from the plan**
1. **Where the version comes from.** The plan said `app.getVersion()`, passed to the preload like `systemLocale`. A probe showed that `app.getVersion()` returns Electron's own version (`44.5.1`) when the app is started from `dist/main/main.js`, which is how the E2E suite and `FILO_E2E_MAIN` start it. So Settings would have said "Filo 44.5.1" there. The version is read from `package.json` at build time instead. electron-builder stamps the installer from the same field, so the two always agree in a packaged build (both say 0.2.0). This also adds nothing to `window.filo`.
2. **Where the version shows.** It's in the Settings footer, not Help → About. Help opens only from the Mind Map's side toolbar, while Settings opens from every view (Ctrl+, or the vault menu).
3. **The characterisation suite needed changes.** The plan scored 0.2 at Hard 1/10; it was nearer 2/10. Every `startApp` vault is brand new, so the new default moved boards into folders in every spec.
   - **Failed:** 12 cases in 7 files.
   - **Passed but now tested something else:** 3 more cases, which now pressed a board-folder button where they meant the Root Directory, or tested a name check that no longer applied.
   - **What changed in the specs:** cases about board folders being off (the Root Directory, board names and renames at the top of the vault) now turn them off first through Settings, as a user of an older vault has them. Cases unrelated to folders now expect paths inside the board's folder: board delete undo, workspace restore, the title-to-filename case, and undo after a rename.
   - **Harness fixes:**
     - `deleteBoardInBrowser` now clicks inside the Board Browser. A board's own folder in the sidebar has a button with the same "Delete <name>" label, and the old document-wide lookup clicked that one, deleting the folder instead.
     - New `openVaultMenu`: it clicks the vault menu's button only while the menu is shut. Before the BL-24 fix, the menu stayed open after Rename Vault, and the next case's click closed it.
   - The E2E specs needed nothing: `freshVault` makes a `.filo/`, which reads as an existing vault.
4. **The installer itself wasn't run.** Running the NSIS installer adds Start-menu and desktop shortcuts and an uninstall entry to this PC, and installing is item 1 of the report's section 7 checklist (task 0.3, yours). Instead I checked the `win-unpacked/Filo.exe` it installs. It passed the E2E suite, and it opened a copy of your book vault (see Checks).
5. **Where the old build went.** The plan said to move the June installer out of `release/` without naming a place. It went to `release-archive/0.1.0 (2026-06-08)/`, with one new `.gitignore` line. Nothing was deleted.

**Checks** (all run twice: once on the Phase 0 tasks, then again on the final code with the BL-22 to BL-24 fixes; the numbers are the final run's)
- `npm run ci:verify` on Windows: passed in 292 s. 805 test files, 7,847 passed and 5 skipped (as before), 91/91 gates. The first run: 804 files, 7,840 passed, 329 s.
- E2E with `FILO_E2E_SCALE=1` on the build: 30 passed (the 29 from before plus the new spec), 2.8 min.
- The installer was rebuilt from the final code: `release/Filo Setup 0.2.0.exe`, 112,846,107 bytes. It replaces the first 0.2.0 build, which was never installed.
- E2E against the packaged app (`FILO_E2E_EXE=release\win-unpacked\Filo.exe`): 27 passed and 3 skipped (the scale budgets, which need `FILO_E2E_SCALE=1`), 2.2 min.
- A fresh copy of your book vault (13 notes, no `.filo/`) in the packaged `Filo.exe`, on a scratch profile:
  - Home → Open Vault opened it; Settings showed `Filo 0.2.0`; `.filo/app.json` had `boardFolders: true`.
  - A new Kanban board and card became `Kanban 1/Kanban 1.board.json` and `Kanban 1/New Card.md`. No note changed and no console error appeared.
  - The window's close quit in 137 ms.
  - The original vault wasn't touched; it still has no `.filo/`.
- Corpus check: not run. Nothing in the editor or Markdown writing changed.

**Pass test**
- The version shows in the app: **met** in the component test, the built app (E2E) and the packaged app.
- A new vault's first board makes its own folder, and its cards land there: **met** (characterisation, E2E, and the book-vault copy).
- The installer built from this code installs and opens a copy of your book vault: **opening is met** with the app the installer contains. **Installing is left to you** (deviation 4).

**Found and fixed in this phase (BL-22 to BL-24)**

These were written into `docs/BACKLOG.md` first. The owner then asked for them to be fixed in this phase, before the commit, so their text moved here. BL-22 and BL-23 matter more since 0.2: every board in a new vault now lives in a folder of its own. Each fix has unit and characterisation cases, and each of those cases failed with the fix's source files set back to the previous commit (bite check).

- **BL-22: with board folders on, a board could take another board's name** (Impact 1/10, Hard 1/10).
  - **What you saw:** with boards "Kanban 1" (in `Kanban 1/`) and "Kanban 2" (in `Kanban 2/`), renaming "Kanban 2" to "Kanban 1" showed no inline message. The file became `Kanban 2/Kanban 1.board.json`, a toast said the folder "Kanban 2" kept its name, and the Board Browser listed two boards called "Kanban 1".
  - **Why:** a rename refused only another board's name in the same folder. With board folders on, two boards are never in the same folder. Filo's own picks for a new board (`isNewBoardNameTaken`) already skipped every board name in the vault.
  - **Fix:** with board folders on, a board's name must be free in the whole vault, for a rename (`boardRenameProblem`) and for a new board's typed name (`newBoardNameProblem`). The inline message names the other board's folder: *A board named "Kanban 1" already exists in "Kanban 1".* With them off, nothing changed: only a board in the same folder counts. The check is `boardNameTakenWithFolders` (`lib/boards/newBoardPlace.ts`).
  - **Tests:** `newBoardPlace.test.ts` (four cases, folders on and off); `boardFolders.test.ts` ("renaming a board to another board's name is refused…").
- **BL-23: undoing a sidebar delete of a board's folder lost the board's camera** (Impact 1/10, Hard 2/10).
  - **What you saw:** delete a board's folder from the sidebar, then Undo. The board came back at the default camera, without its side toolbar's place or pin. The Board Browser's delete already kept both.
  - **How it was found:** a characterisation helper clicked the sidebar folder's "Delete Mind Map 1" instead of the Board Browser's.
  - **Fix:** the sidebar delete (`performDelete`, `stores/vaultDeleteOps.ts`) records each affected board's view before dropping the board (`boardCacheStore.boardView`). The cascade-delete step holds those views (`boardViews` on `CascadeDeleteCommand`) and puts them back once its undo has restored the files (`putBackBoardView`). A redo records them again first, so the next undo shows the board as it was at the redo. Ctrl+Z, the toast's Undo and Settings → Trash all run that undo.
  - **Tests:** new `cascadeDeleteBoardViews.test.ts`; `boardDeleteUndo.test.ts` ("its folder deleted in the sidebar…").
- **BL-24: after Rename Vault and Enter, the vault menu stayed open** (Impact 0/10, Hard 0/10).
  - **Fix:** Enter saves the name and closes the menu, as the menu's other items do (`ProjectDropdown.svelte`). A blur still only saves: a click outside closes the menu by itself, and a click on another item runs that item.
  - **Test:** `folderPinsAndVaultName.test.ts` checks the menu is closed after the rename.

**Left for you (task 0.3, the report's section 7)**
1. Install `release\Filo Setup 0.2.0.exe`. It is unsigned, so SmartScreen warns: choose "More info", then "Run anyway". Settings → bottom left should say `Filo 0.2.0`. Bump the version before each build you install (D10), say to `0.2.1`.
2. Where notes go: nothing to do now for the book vault, since its first open turns board-specific folders on. Vaults Filo has already opened keep their setting (Settings → General → Vault Sidebar).
3. Keep a real backup (File History or similar) of `C:\Users\andre\My Files\Vaults`.
4. If you add Syncthing: Send Only on the PC, Receive Only on the phone, with Staggered File Versioning on the phone.
5. Until Phase 1 lands, the report's workarounds still apply (Raw view, Reload, rich paste, typing into a new card, Task List sort, titles starting with a dot).

### Phase 1 outcome (2026-10-04)

**Status:** done and committed. D1, D4 and D5 were taken at their defaults. All nine tasks are in, BL-14 with them. Four deviations are listed below. Two small findings, BL-25 and BL-26, were fixed in the phase at the owner's request (end of this section).

**What changed**
- **1.1, Ctrl+Z in the Raw view after an outside change (A-01).** `setText` (`lib/editor/rawTextEditor.ts`) loads text from disk and clears the undo history. `history()` sits in a Compartment: it is taken out in the load's transaction and put back, empty, in the next one (a field kept in both configurations would keep its value). Only the stretch that differs is replaced, so the caret, the selection and the scroll stay with their text. A `setText` with the text already shown changes nothing, so a save that re-reads the same bytes keeps Ctrl+Z working.
- **1.2, Reload throws nothing away (A-02).**
  - **The note conflict prompt.** `resolveConflict('reload')` (`stores/notes.svelte.ts`) first writes the note as typed (its frontmatter over the typed body) to `.filo/recovery/<ts>-keep/`. It uses the new `keepNoteVersion` (`lib/notes/keepVersion.ts`), which the shrinking-reload copy now shares. The drop follows with no wait in between, so the copy holds exactly what is dropped; text typed while the copy is written gets a new copy. A notice then says *"Chapter" now shows the other version. What you typed is saved in .filo/recovery/.* It offers **Undo reload** (backs the version on disk up, then puts the typing back as an unsaved edit) and **Show in folder**.
  - **The Raw view.** The banner's button is now **Use the new version (discard mine)**. It first copies the typed text to `.filo/recovery/<ts>-keep/` and says so, with **Show in folder**.
  - **When no copy can be written** (disk full, a lock), both ask first: *Reload without a copy?* or *Use the new version without a copy?*. Cancel keeps the text and the question.
  - `noteStore.restoreBody` now loads a note that no view holds any more, so Undo reload still works after the tab closed. It reports a body it couldn't take.
- **1.3, typed text saves on a pause (C-02).** The Raw view (`NoteRawView.svelte`) and the Task List notes box (`lib/tasklist/notesBox.svelte.ts`) save 1.5 s after typing stops, through their normal save and its conflict check. The Raw view waits out an IME composition first. It leaves alone text that a leave is already saving, or has kept as a rescue copy. The notes box doesn't fire while its conflict question is open. KL #30 and the design doc say so.
- **1.4, a skipped Raw save no longer reads as saved (A-05).** `writeRaw` returns `skipped` when the writer left the file alone without comparing it: the note stopped being UTF-8, became a link, or another vault opened. `unchanged` now means only "the file already holds these bytes". The view keeps the text, writes a rescue copy once per text, and says why: *Your raw edits to "Plan.md" were kept in .filo/recovery/… because the note is now a link.* Its status line tells a link from a non-UTF-8 file.
- **1.5, pasted spans (D-02).** New `lib/editor/textStyleSpans.ts`.
  - Filo's TextStyle (`createEditor.ts`) takes a `<span>` as a mark only when it sets a colour, a font family or a font size.
  - Any other styled span is plain text: Word's two spaces after a full stop, a web page's bold or underline span, a Google Docs tab. Bold, italic and underline still come through their own marks.
  - The serializer (`installNoteSerializer`) writes nothing for a text-style mark that sets nothing, so no bare `<span>` reaches a file, however such a mark was made.
- **1.6, new cards and tiles take the keyboard (H-01, BL-14, part of E-08).**
  - New `lib/boards/newTileTitle.ts`. The code that makes a tile or card asks for its title to open (`editTitleWhenShown`). The tile's header takes the request when it mounts (`TileHeader.svelte`) and selects the whole title, so typing replaces it. A request not taken within 2 s is dropped (the tile landed off screen, or a filter hides the card).
  - Every way to make one asks: the Mind Map side toolbar (every tile type), the canvas menu's New Tile, N, Ctrl+N, the empty board's "Create your first tile", and Kanban's Add Card (Text, Audio, Link). A card made from a template already has its title.
  - Enter or Escape in a title hands focus to the tile, so the board's keys work on from there. New Tile, type, Enter, N, type, Enter makes two named tiles.
  - The Mind Map's N, C, Enter and Backspace act only while focus is in the canvas. Kanban's bare N and Shift+N act only while it is in the board (`lib/utils/boardFocus.ts`). Kanban's shortcut registration moved to `lib/kanban/kanbanShortcuts.ts`.
  - BL-14: an empty tile or card shows "Start typing..." (one rule in `style.css` for both, in `--text-tertiary`). A card whose editor hasn't mounted yet shows the same hint in its static preview (`LazyTextTileBody.svelte`).
- **1.7, no hidden names (A-03).** `safeFileName` (`shared/fileNames.ts`) drops leading dots and spaces: `...and then she ran` becomes `and then she ran.md`, and `...` becomes `Untitled`. Every name Filo derives goes through it, the main process's font import included. `fileNameProblem` (sidebar rename) and `boardNameProblem` refuse a typed name that starts with a dot: *Names can't start with a dot.*
- **1.8, Escape in a task's notes box (E-07, D5)** saves what was typed and closes the box, as clicking away does. Its placeholder now reads *Add a task note. It saves as you type; Esc closes.*
- **1.9, Ctrl+S and a task title being typed (A-S1).** The title edit moved out of `TaskItem.svelte` into `lib/tasklist/taskTitleEdit.svelte.ts`. It registers its commit with `registerComponentFlush`, so a save commits a title still in its box. Save now reaches the app from a text field (deviation 4).
- **Size ceilings.** `TaskItem.svelte` went from 1,225 to 1,196 lines of code, and `KanbanBoard.svelte` from 1,027 to 1,023. Their rows in the `file-sizes` gate were lowered to match.
- **Docs.**
  - CLAUDE.md: the new modules; the hotkeys, notes box, Raw view, note prompt and file-name lines; debouncing; the test suites.
  - KL #30.
  - The design doc: the Reload prompt, Kanban's keys and new card, the Raw view, New Tile.
  - `docs/BACKLOG.md` drops BL-14. BL-25 and BL-26 were written there, then fixed here, so the backlog only notes them; its next new item is BL-27.

**Deviations from the plan**
1. **Where Reload's copy is made, and what happens without one (1.2).**
   - The plan put the copy "before Reload in the note conflict prompt". It is made in the note store's `resolveConflict('reload')`, next to the drop. So whatever answers a conflict with Reload keeps the copy, and the copy holds exactly the text dropped.
   - The plan didn't say what to do when no copy can be written. Filo asks before going on, as Keep mine already does when its backup fails.
   - The Raw view's copy goes to `<ts>-keep/`, like Reload's (the plan said "a rescue copy"). Both are versions Filo replaced at the user's word, and neither folder is ever pruned (KL #33).
   - The Raw view gets no Undo button. The plan asked for none, and the load clears its undo history (1.1).
2. **"Only while the board or canvas has focus" (1.6, D4)** is read as "while focus is inside the board": the board element itself, or a tile, a card or a button on it.
   - Clicking a tile focuses the tile, not the canvas. The stricter reading would have stopped Enter (rename) and Backspace (delete) on a clicked tile.
   - Text fields inside the board keep their keys as before.
   - The Mind Map's arrow keys and the global Delete still act from the sidebar. They are the rest of E-08, for task 3.4.
3. **Escape on a title that opened by itself keeps what was typed (1.6).**
   - Escape cancels a rename. But a new tile's or card's title is only a placeholder, so there is nothing to go back to, and Escape after typing threw the typing away. The audit's own tour types a name and presses Escape.
   - Renaming an existing title still cancels on Escape.
   - The code says so where it decides (`editingNewTile` in `TileHeader.svelte`).
4. **Save had to be let through in text fields (1.9).**
   - Registering the title's commit with `registerComponentFlush` wasn't enough. The hotkeys ignored every key but Escape in an input or a textarea, so Ctrl+S never reached the app while the title was being typed.
   - Save is now marked `allowInField` (`core/hotkeys.ts`, `AppShell.svelte`). It fires from any text field, unless the field took the key itself (the Raw view's own Ctrl+S, which saves the Raw view).
   - So Ctrl+S now also works in the notes box and in quick add. That is half of task 5.2's second sentence; Ctrl+Shift+F, Ctrl+W and Ctrl+Tab stay for 5.2.

**Also changed, outside the plan's wording**
- **The key routers give the same answer in jsdom as in Chromium.** `core/hotkeys.ts` and `lib/mindmap/mindMapKeyboard.ts` read `isContentEditable`, which jsdom doesn't implement. They now use `isContentEditableAware` (`lib/utils/editableTarget.ts`, now exported), which agrees with Chromium. The characterisation suite needed it: there, a key typed into a new tile's title reached the Mind Map's N.
- **The characterisation harness.**
  - A new tile or card now opens its title, so `editors(...)[0]` found the title editor. 7 cases in 5 spec files failed until `addMindMapTextTile` and `addKanbanCard` learned to end that edit as a user who doesn't name it would (Escape). They also take `{ title }` (type a name, then Enter) or `{ keepOpen }`.
  - New: `harness/typingFocus.ts` (each key goes to whatever has focus and bubbles to the window, as the keyboard sends it), `openTitleEditor`, and Task List notes-box and title helpers. `chooseRawConflict` takes the new label.
  - No spec changed.

**Tests** (each new case failed with its fix's source files set back to the previous commit, unless marked)
- **Unit:**
  - `rawTextEditor.test.ts`: undo does nothing after `setText`, the overlapping-edit case included; typing after a load starts a new history; the selection stays with its text; `composing()`.
  - New `conflictReloadKeepsCopy.test.ts` (from the finder's repro): the copy holds the typing done after the prompt appeared; Undo reload writes it back; Cancel keeps the conflict when no copy can be written; Reload anyway; Undo reload on a note no view holds.
  - `noteRawView.test.ts`: a note that stopped being UTF-8, or became a link, is `skipped`.
  - New `textStyleSpans.test.ts`: which spans count; an empty mark writes no bare `<span>`.
  - `fileNameRules.test.ts` (from the finder's repro): leading dots in titles; paths the sidebar, watcher and index can see; the typed-name refusal. `filenameUtilsSanitize.test.ts`: its "keeps a leading dot" case now expects the dot gone.
  - `hotkeys.test.ts`: Save fires from an input and a textarea, and nothing else does; a key the field took is left alone.
  - New `newTileTitle.test.ts`: a request is taken once and dropped after 2 s; `focusIsInBoard`; Kanban's bare keys only with focus in the board. Not bite-checked; its characterisation twin is.
  - New `taskTitleEdit.test.ts`: Enter, a save, Escape, a rename elsewhere, an emptied title. Not bite-checked (the class is new); its characterisation twin is.
  - `taskNotesBox.test.ts`: the idle save happens once, and not after the box is gone.
  - `vaultLifecycleCoverage.test.ts` and the `vault-scoped-state` gate list `taskTitleEdit.svelte.ts` with the other per-row classes.
- **Component:** new `noteRawViewConflict.test.ts`: both of the finder's Ctrl+Z cases, the copy before "Use the new version", Cancel without a copy, the idle save (undo still works after it), the skipped save.
- **Browser (Chromium):** new `pasteSpansInChromium.test.ts`. The finder's four paste fixtures (Word, a web page's bold and underline spans, a Google Docs tab) go through the real paste, save, and reopen editable with no bare `<span>`. A coloured span is kept. All four fixtures failed on the previous commit, as in the audit.
- **Characterisation**, both new and both in the `characterisation-suite` gate's list. All 11 cases failed on the previous commit's code.
  - `newCardsAndTiles.test.ts` (6 cases): a new card's and a new tile's title takes typing, and the empty body shows the hint; "Antagonist" makes no extra tiles; Escape keeps a new title; N after Enter makes the next tile; N from the page makes no tile or card, and from the board it does.
  - `typedTextReachesDisk.test.ts` (5 cases): Escape in the notes box; the notes box and the Raw view saving on a pause; Ctrl+S on a task title; Reload keeping a copy, and Undo reload.
- **E2E:** new `newCardsAndTiles.e2e.ts` (two cards and two tiles typed at once; no extra cards, tiles or pickers; the hint shown), and a `rawView.e2e.ts` case (type, leave, an outside rewrite, Ctrl+Z, leave: the file holds the outside version). All three failed against a build of the previous commit (`FILO_E2E_MAIN`) and pass on this one.

**Checks**
- `npm run ci:verify` on Windows: passed in 293 s on the final code (BL-25 and BL-26 included). 814 test files, 7,910 passed and 5 skipped (as before), 91/91 gates. The first run, before those two fixes, failed on one timed-out real-disk test that this phase didn't touch (BL-26); the second passed.
- E2E with `FILO_E2E_SCALE=1` on the build: 33 passed (the 30 from before and the 3 new cases), 2.9 min, both before and after the BL-25 and BL-26 fixes.
- **Corpus check** against the previous commit, built in a detached worktree with `node_modules` junctioned:
  - 741 notes: the repo's 106, 32 from a copy of your vaults folder, and 603 READMEs.
  - 0 changed, 0 newly read-only, 0 newly failing to load.
  - All 32 of your vault notes open editable.
- **The audit's hands-on tour** (`ux.pass.ts`) on a fresh copy of your book vault, against this build:
  - The three cards are titled "Outline chapter 3", "Name the river city" and "Fix magic costs".
  - The Mind Map has three tiles, "Magic system", "River city" and "Antagonist", and no others. The audit's run made five, two of them empty `New Tile` notes.
  - Every empty card and tile shows "Start typing...". No console errors; quit took 146 ms.
  - Its Settings step fails as it did in the audit: the toolbar has no Settings button (H-06, task 5.4).
  - The file names are still placeholders (`New Card (2).md`, `New Tile (3).md`). That is E-13, task 3.2.

**Pass test**
- Every finder repro listed: **met.** The repros for A-01, A-02, A-03 and D-02 are now permanent tests (above), and they pass.
- `ci:verify`: **met** (see Checks).
- E2E: `rawView.e2e.ts` has the Ctrl+Z case, and the new-card and new-tile typing cases are in `newCardsAndTiles.e2e.ts`: **met.**
- Corpus: 0 changed and 0 newly read-only: **met.**
- The tour shows typed titles in the cards and tiles, and no stray `New Tile` notes: **met.**

**Found and fixed in this phase (BL-25, BL-26)**

These were written into `docs/BACKLOG.md` first. The owner then asked for them to be fixed in this phase, before the commit, so their text moved here. Neither changes anything you see in the app.
- **BL-25: four focus checks read `isContentEditable`, which the test suites' jsdom doesn't implement** (Impact 0/10, Hard 1/10).
  - **Why it mattered:** Chromium answers correctly, but a jsdom test going through these checks saw a text editor as not being one, and could pass or fail where the app wouldn't. The key routers had the same problem (see "Also changed" above).
  - **The four:** the Home screen's Ctrl+N handler (`HomeScreen.svelte`), the sidebar's Escape handler (`VaultSidebar.svelte`), the blur before an additive tile click (`TileContainer.svelte`) and the blur on an empty-canvas click (`MindMapBoard.svelte`).
  - **Fix:** all four use `isContentEditableAware`. A new contract test, `src/tests/unit/contracts/contentEditableChecks.test.ts`, fails on any renderer code that reads `.isContentEditable` outside `editableTarget.ts`. With the four files set back to the previous commit, it fails and names all four.
- **BL-26: a real-disk recovery-snapshot test could time out under load** (Impact 0/10, Hard 1/10).
  - **What happened:** the first `ci:verify` run failed on one case of `recoverySnapshotKeep.test.ts` ("Test timed out in 5000ms"). Alone it takes about 220 ms, and it passed in the other full runs. It writes 16 snapshots to the real disk, so a busy machine could push it past Vitest's 5 s default. This phase didn't touch the code it tests.
  - **Fix:** the file's `describe` gives its three disk-heavy cases 20 s, as other real-disk tests have (`crashSentinelsAndDrains.test.ts`). A throwaway probe confirmed a case under such a `describe` may run past 5 s.

**Left for you**
1. `release/Filo Setup 0.2.0.exe` is the Phase 0 build and has none of these fixes, so the report's workarounds still apply to it. A build with Phase 1 would be `0.2.1` (D10), made with `npm run package:win`.

### Phase 2 outcome (2026-10-05)

**Status:** done and committed. All twelve tasks are in, BL-06 with them. D6 and D7 were taken at their defaults. Ten deviations are listed below; the one you may notice is that the list buttons and Ctrl+Shift+9 now change the whole list the caret is in (deviation 5). Two findings came up while checking the phase: BL-27 (spaces typed at the end of a line) was fixed here at the owner's request, along with three older no-break-space bugs its tests turned up (end of this section); BL-28 is in `docs/BACKLOG.md`.

**What changed**
- **2.1, spaces inside a formatted phrase (D-01).** New `lib/editor/spaceRuns.ts`, a pre-pass after `withBreakMarksTrimmed`, run by the paragraph, heading and Markdown table-cell writers.
  - It first runs prosemirror-markdown's own bookkeeping over the block (`misplacedSpace`, which follows `renderInline`: the marks open, the reordering of bold, italic and links, the whitespace moved out of a run) to find a space the writer would put inside other marks than its own. A block with none is left exactly as it was.
  - Such a space keeps bold, italic or strikethrough only where both its neighbours carry the mark with the same marks outside it, and keeps its other marks (an underline, a highlight, a colour). A misplaced space at the edge of a word is split off first, so Ctrl+B on "two " inside an underlined phrase leaves no gap in the underline. The block is checked again after each change. Spaces ending a line are left out of the file (BL-27, end of this section).
  - The writer's mark flags come from its own specs (`state.marks`), with prosemirror-markdown's defaults as a fallback.
  - **The property test** (`editorRoundTripProperty.test.ts`): its generator gains whitespace runs with marks of their own, spaces inside a run at its start or end, a second colour, a font, two sizes, a second highlight and table column widths. The "a formatted space shows nothing" exclusion is gone; "shows the same" now sets aside only bold, italic and strikethrough on whitespace (an underline or highlight there must survive). Its commands-in-context part gains the list buttons and a typed scene break.
- **2.2, rich paste (D-06, D6) and BL-06.**
  - New `lib/editor/pasteHtml.ts`, an extension-level `transformPastedHTML` in note editors and titles:
    - near-black and near-white text loses its colour (any channel above 0x40 keeps it; `windowtext` goes);
    - the font most of the paste is set in (by characters) loses its name, and so does a bare generic family;
    - every point size goes (Word's and Docs' body and heading sizes); pixel sizes stay;
    - a span's background colour, or Word's `mso-highlight`, becomes a highlight;
    - Word's list paragraphs (`mso-list … levelN`) become nested `<ul>` / `<ol>`, the bullet or number taken out of the text.
    - HTML copied from a Filo note (ProseMirror's `data-pm-slice`) is left as it is.
  - BL-06: Ctrl+Shift+V drops spaces and tabs before each newline (`pastePlainText.ts` `literalTextSlice`); spaces ending the whole paste stay. KL #41 says so.
  - KL #49 records what a rich paste drops, and why.
- **2.3, the font size box (D-03).** `toolbarConfig.ts` `shownFontSize`: the text's own size mark (a `pt` size converted to px), else the computed size at the caret (a selection: its first character). The box and + / − use it.
- **2.4, Enter in a title (D-04).** The title and label editor (`createLabelEditor`) gains `OneLineEnter`: Enter, Shift+Enter and Ctrl+Enter do nothing in the editor, so the host's existing keydown handler commits the title whole. `TileHeader`, `Frame` and `ConnectionLabel` ignore a key event while an IME composes.
- **2.5, the list buttons (D-05).** New `lib/editor/listSwitch.ts`, a `switchList(kind)` command. The toolbar's three list buttons and Ctrl+Shift+7 / 8 / 9 run it.
  - Every list one of whose own lines the selection reaches is rebuilt as the new kind, item by item (listItem ↔ taskItem), each item at its level; a nested list changes only where the selection reaches its lines.
  - Paragraphs selected with a list are wrapped into the new kind and joined to it; a heading is left as it is.
  - With no list in the selection, or every list it reaches already of that kind (the button turns the list off), TipTap's own toggle runs, as before.
  - The buttons are off where the editor holds no lists (titles, connection labels): `toolbarStore.listsAvailable`.
- **2.6, scene breaks (D-09, D7).** New `lib/editor/sceneBreaks.ts`.
  - `typedOnly` rebuilds the heading, bullet, numbered, quote and checkbox input rules so their patterns refuse the newline TipTap runs them with on Enter: they fire on the typed space only.
  - The numbered list's rule also refuses a number of three digits or more, so "1984. It was…" stays text (a `// DECISION:` comment).
  - `SceneBreakEnter`: Enter at the end of a paragraph holding only `#`, or a spaced thematic break (`* * *`, `- - -`, `_ _ _`, and `***`), or of a one-item bullet list holding `* *` / `- -` (the first `* ` already made the list), replaces it with a horizontal rule and an empty paragraph. It is its own undo step: Ctrl+Z puts the typed line back.
- **2.7, font names (D-08).** `fontFamilyValue` (`shared/fontStack.ts`) leaves a name CSS reads bare as it is (`Georgia`, `Arial Rounded MT`: notes keep their spelling) and quotes any other (`'28 Days Later'`, `'Lora[wght]'`). The toolbar's font picker uses it.
- **2.8, title and preview sizes (D-10, W-9).** The display sanitiser (`sanitizeHtml.ts`) keeps `font-size` up to 72 px (px, pt, em, rem or %) and `margin-left` up to 192 px (eight indent steps). Anything larger, negative or not a plain length is still dropped.
- **2.9, spell check (D-11).** The workspace store holds `spellcheck` (on unless turned off), saved in `.filo/workspace.json` only when off. Every editor reads it through a function attribute, so one opened later follows it; the Spelling button updates the open ones at once.
- **2.10, table column widths (D-12).** A table with a column dragged to a width is written as HTML (`tableMarkdown.ts`), which keeps the width. Column resizing stays on.
- **2.11, images in a note (D-13).** New `lib/editor/noteImages.ts`.
  - The editor's image node view shows a vault-relative address through `filo://media/`, resolved from the note's folder (an address starting with `/` from the vault's top; `%20` decoded; `?` and `#` dropped; one climbing above the vault's top shows nothing). The node, and so the file, keeps the address as written.
  - The note view tells its editor which note it shows before each load (`setImageNote`).
  - Card previews (`staticPreview.ts`) resolve image addresses the same way, cached per note folder. The preview sanitiser keeps `<img>` only with a `filo://media/` address, with `alt`, `width` and `height`.
- **2.12, long-note saves (D-07).**
  - New `lib/editor/noteSerializerState.ts`: a subclass of prosemirror-markdown's state whose writes go through `append`, which keeps the output's last two characters at hand, and whose `atBlank`, `ensureNewLine`, `write`, `flushClose` and `text` read those instead of the output. A direct write to `out` is noticed by the output's length.
  - `DelimiterRuns.finish` no longer filters every run's list per run: `flanks` checks `!o.html` inside its rare branch.
  - A note over about 20,000 words (120,000 document positions) is serialised after a 1 s pause instead of 150 ms (`serializeIdleMs`); blur, Ctrl+S, close and quit still save at once.

**Deviations from the plan**
1. **The space rule needed a second condition, and a guard (2.1).**
   - "Keeps bold, italic or strike only when both neighbours have it" doesn't fix the audit's own example: in a bold "Aria Kasai" with "Aria" red and "Kasai" blue, both neighbours of the space are bold, but the file writes the colour outside the `**`, so the bold closes at each colour change and the space was still written inside the red span. The rule also requires every mark nested outside it to be the same on the space and both neighbours.
   - Applied to every space, that rule made 5 of the corpus's notes newly read-only: in `*Thanks to [Titus Wormer](…) for …*` the link sits outside the italic in the schema, yet the writer keeps the italic open around it, so the old output was right and the rule broke the phrase in three. The pass now changes only a space the writer would misplace (the emulation above); the corpus then showed 0 changed and 0 newly read-only. Two such phrases are now named cases in `markdownBodyRoundTrip.test.ts`.
   - The finder's sketch passed its probe because its whitespace test had lost its backslash (`/S/`), so it stripped marks from most runs.
2. **A space between two differently formatted struck words loses its strikethrough (2.1).** Markdown can't hold it there (the same reason as above). It shows as a short gap in the line; KL #50 says so. A struck or bold space at the edge of a run was already written outside it.
3. **What D6's "pt sizes" covers (2.2).** Every size in points is dropped, including a heading's in Word or Docs (the heading keeps its level). A bare generic font (`sans-serif`) is dropped too, though it isn't the paste's main font. "Near-default colour" is defined as no channel above 0x40 (near-black) or every channel at 0xE0 or more (near-white). The clean-up also runs on titles and labels.
4. **Enter in a title (2.4)** is swallowed in the label editor's keymap and committed by the host's existing handler, rather than committed from the keymap. Its test is a component test (it mounts the three components), not a browser-project spec.
5. **The list buttons change the list the caret is in (2.5).** With the caret in one bullet, Ctrl+Shift+9 used to make only that line a checkbox, splitting the list in three; it now makes the whole list a checklist, as Numbered already changed the whole list (the audit counted that as working). The characterisation case "Ctrl+Shift+9 on the middle bullet of a list" was changed to expect the whole list, and the round-trip fixture for the old shape was renamed ("a checklist item between two bullet lists"); the shape still reads back. If you'd rather keep the one-line checkbox, it's a small change: say so.
6. **More markers than the plan named stop firing on Enter (2.6):** the quote (`>`) and checkbox (`[ ]`) rules too, and `- - -` and `_ _ _` are scene breaks like `* * *`. ```` ``` ```` and Enter still make a code block. Numbers of one or two digits start a list; three or more don't.
7. **Caps in the sanitiser (2.8).** The plan said "allow font-size"; it was allowed up to the toolbar's largest size (72 px) and indents up to eight steps, since the existing test kept out sizes that could cover the app (`font-size: 400px`).
8. **No mutation run for the sanitiser (2.8, 2.11).** As for other security checks, the new sanitiser tests weren't run with the check switched off; they fail against the previous commit's sanitiser instead (bite check).
9. **Where the long-note time went (2.12).** The finder's measured `atBlank` patch alone (a regular expression swapped for `endsWith`) took 100,000 words from 1,017 ms to 852 ms: any read of the output's content made the browser copy the whole output, since each write left it a fresh joined string. Reading only the tracked last characters took it to 11 ms. The 1 s idle for long notes is in as planned, though with the fix a save is cheap at any length.
10. **Images are shown through a node view, not the image's render (2.11).** The same render writes the HTML of an aligned paragraph or an HTML table into the file, so an address rewritten there would have saved `filo://media/…` into the note. The node view changes only the `<img>` on screen. Addresses resolve from the note's folder, as Markdown and other apps read them; the plan didn't say from where.

**Also changed, outside the plan's wording**
- `fontStack.ts` gains `fontFamilyValue` (shared, unit-tested).
- `toolbarCases.ts` gains four list-switch cases (the `toolbar-formatting-saved` gate asks for one per toolbar command); the toolbar suite, its Chromium twin and the micromark check run them.
- The characterisation harness gains `toggleSpellCheck`, `spellCheckButtonOn` and `spellCheckedIn`; the new spec `spellCheckSetting.test.ts` is in the `characterisation-suite` gate's list.
- Test fixtures with a hand-built workspace layout gained `spellcheck`, and two fake editors a document size (the note view now reads it).

**Tests** (each new case was run against the previous commit; see Checks)
- **Unit:** new `pasteHtml.test.ts` (13), `noteImages.test.ts` (8), `noteSerializerState.test.ts` (14: the state writes what prosemirror-markdown's own writes on eleven note shapes and a long note; the idle time); new cases in `pastePlainText.test.ts` (BL-06), `fontStack.test.ts`, `sanitizeHtml.test.ts` (sizes, indents, caps, preview images), `staticPreview.test.ts` (sizes, indents, images, the per-folder cache), `workspace.test.ts` (spell check).
- **Component:** new `titleEnterCommits.test.ts` (5: tile, Shift+Enter, frame, connection label, an IME's Enter) and `titleFontSizeShown.test.ts` (2).
- **Browser (Chromium):** new `spaceRunsInChromium` (6), `richPasteInChromium` (6), `fontSizeBoxInChromium` (6), `fontNamesInChromium` (8), `sceneBreaksInChromium` (19), `listSwitchInChromium` (14), `tableColumnWidthInChromium` (3), `noteImagesInChromium` (5), `longNoteSaveInChromium` (1: five times the words takes under twelve times the time, and under 500 ms at 100,000 words).
- **Characterisation:** new `spellCheckSetting.test.ts` (2); `editorFidelity.test.ts` changed as in deviation 5.
- **E2E:** new `noteImages.e2e.ts`: in the built app, an image a note embeds loads from the vault through `filo://media/`, with no security-policy error, and the note's file is left as it was.
- **Round-trip fixtures:** `markdownBodyRoundTrip.test.ts` gains an italic phrase holding links and a bold phrase holding a link (deviation 1).
- **Property sweep:** the final generator on the final code, seeds 1 and 20261005, 2,000 runs each: clean (192 s and 196 s). The suite's own 500 runs now take about 40 s on this machine (more shapes per document).
  - After BL-27 (the generator now keeps spaces at line ends), seeds 1 and 4242, 2,000 runs each on the final code: clean (186 s and 210 s). Before the no-break-space fixes, the suite's own 500 runs found the case after an opening break, seed 777 the last-line and cell-edge cases, and seed 4242 the blank cell.

**Checks**
- `npm run ci:verify` on Windows: passed in 310 s on the final code, BL-27 included. 831 test files, 8,123 passed and 5 skipped (as before), 91/91 gates.
  - Before BL-27 it had passed in 312 s (829 files, 8,094 passed). The first run after BL-27 failed one gate, `test-typecheck`: the new `lineEndSpaces.test.ts` handed the editor factory a document where it takes text (all its tests passed). The rerun passed.
  - The first run failed on 6 cases: the characterisation case changed in deviation 5, and two fake editors without a document size. The second passed (315 s); the space-rule rework and an untracked read of the spell-check setting (an editor updating inside a component's effect mustn't make that effect depend on it) came after it, so the final run was the third.
- E2E with `FILO_E2E_SCALE=1` on the build: 34 passed (the 33 from before and the new image case), 2.9 min, and again on the final build with BL-27 (34 passed, 2.9 min).
  - The first run had two failures: the new spec's locator (ProseMirror adds a hidden separator `<img>` after an inline image), fixed; and the Kanban 300 switch-back budget (562 ms against 500). Five runs each against a build of the previous commit and of this phase gave the same medians (switch back 256 ms and 261 ms, open 424 ms and 416 ms), with a spike on each build, so it is noise; it is BL-28.
- **Corpus check** against the previous commit, built in a detached worktree with `node_modules` junctioned:
  - 741 notes: the repo's 106, 32 from a copy of your vaults folder, and 603 READMEs.
  - 0 changed, 0 newly read-only, 0 newly failing to load (345 editable and 396 read-only on both).
  - All 32 of your vault notes open editable, 30 of them saving byte for byte, as before.
  - The first corpus run, with the space rule applied to every space, showed 5 READMEs newly read-only; that is deviation 1.
  - After BL-27, again against the previous commit with the same list: 0 changed, 0 newly read-only, 0 newly failing (345 editable, 393 read-only). The 3 not compared are repo documents edited between the runs (`CLAUDE.md`, the backlog, this plan).
- **Bite checks** (the new tests on the previous commit's code, in that worktree):
  - Chromium: all 9 new specs fail (44 cases). The 19 that pass are controls for what already worked: a plain font name, markers typed with a space, a table without widths, `***`, Numbered on a nested item, a copy from a Filo note.
  - Component: 7 of 7 fail. Characterisation: 2 of 2 fail. Unit: every new case in `pastePlainText`, `sanitizeHtml`, `staticPreview` and `workspace` fails.
  - The extended property test fails within 5 runs on the previous serialiser.
  - `pasteHtml`, `noteImages` and `noteSerializerState` are new modules, so their own unit tests have nothing to run against there.
- **Long-note save time** (Chromium, one save of prose with italics, bold and quotes): 10,000 words 4 → 2 ms; 20,000 words 12 → 3 ms; 40,000 words 73 → 5 ms; 100,000 words 881 → 11 ms (18 ms for the whole save, Markdown escapes included).

**Pass test**
- Browser-project specs for each item: **met**, except 2.4 (a component test, deviation 4) and 2.9 (a characterisation spec and unit tests: the setting lives in the app's stores and `.filo/`), which got the test that reaches them.
- The extended property sweep (new generator, two seeds × 2,000 runs) is clean: **met.**
- The corpus check shows 0 changed and 0 newly read-only: **met** (no change was intended).
- `markdownContentElsewhere.test.ts` is still green: **met** (it also runs the four new list-switch toolbar cases).

**Found in this phase and fixed at the owner's request (BL-27)**
- **What you saw** (Impact 1/10, Hard 1/10). Typed before Enter, two spaces were saved and dropped on reopening; typed before a single line break, they reopened as a hard break, saved later as `\`. Nothing was lost and the note stayed editable; only the bytes moved on a later save. Found by the audit's typing repro while checking this phase.
- **What changed.** New `lib/editor/lineEndSpaces.ts`; spaces typed at the end of a line are left out of the file.
  - Before a paragraph, heading or Markdown table cell is written, the spaces ending each of its lines are dropped from its text (`withLineEndSpacesDropped`): at the block's end, and in a paragraph before a soft break (a heading's or cell's soft break is `<br>`, before which spaces stay). A tab typed before them then ends the line and is written `&#9;`. A line of only spaces keeps its first, written `&#32;`.
  - Spaces a closing tag follows (`<u>a  </u>`, a link's text) are kept, since Markdown keeps them; on a bold, italic or struck run they go, since its delimiters push them out of every tag. Spaces before a Shift+Enter line break stay (`a  \`), and `spaceRuns.ts` no longer counts them as dropped.
  - A block written as HTML (an aligned paragraph, a table Markdown can't hold) loses the plain spaces ending each of its paragraphs (`withBlockEndSpacesTrimmed`): the load drops them there.
  - As a last check, the writer notes where each line of text ends (`NoteSerializerState.markLineEnd`: before a soft break's newline, at the end of a paragraph, heading or cell), and `withoutLineEndSpaces` cuts any space still standing before one; `DelimiterRuns.cut` moves the bold and italic runs recorded after a cut, so a run Markdown can't read still becomes `<strong>` where it stands.
  - The property test drops its "whitespace at the end of a line" exclusion: the generator keeps such spaces, and "shows the same" sets aside only spaces ending a line and line breaks ending a block, which show nothing.
- **Three older no-break-space bugs**, which the property sweep turned up once its generator kept spaces at line ends, were fixed with it. Each made a note reopen different from what was saved:
  - A paragraph opening with a line break (written `<br data-filo-soft-break>`) and then only a no-break space on that line was read as an HTML block, which took the lines below it as HTML: a list item's sub-list became its text. That no-break space is now written `&#160;` (`textEscapes.ts`).
  - A paragraph whose last line held only a no-break space lost that line on reopening: the blank-line encoder (`emptyParagraphs.ts`) took it for blank with JavaScript's `\S`. Blank is now Markdown's: spaces and tabs only.
  - A Markdown table cell opening or closing with a no-break space lost it (markdown-it trims cells of all whitespace), and a cell holding only one was written empty (`tableMarkdown.ts` `writesSomething` used `trim()`). A no-break space at a cell's edge is written `&#160;`, and a cell holding one writes it.
- **Tests.**
  - Unit: new `lineEndSpaces.test.ts` (20: the three helpers; notes saved and reopened with spaces before Enter and a soft break, a tab before them, a bold run after a cut, a no-break space alone on a line).
  - Chromium: new `lineEndSpacesInChromium.test.ts` (4, with real keys: spaces before Enter, before a soft break and at the end of a list item are left out; before Shift+Enter they stay).
  - Round-trip fixtures: five no-break-space shapes are named cases in `markdownBodyRoundTrip.test.ts`.
  - Bite checks: each change was switched off in turn and a new test failed every time. That covers the node-level drop, the last check, the run shift, each of the three `&#160;` writes, the blank-line rule and the blank-cell rule.
- **Checks:** in the Checks above (the final `ci:verify`, E2E, corpus and sweep runs include it).

**Found in this phase, not fixed (BL-28)**
- **BL-28: the Kanban 300 switch-back scale budget fails now and then** (Impact 0/10, Hard 2/10). A run spikes past 500 ms (562 and 722 ms in two of nine); the medians match the previous commit's (see Checks). The app is no slower.

### Phase 3 outcome (2026-10-05)

**Status:** done and committed. All nine tasks are in; D2 was taken at its default (rename the file at its first title, while it still has its placeholder name). Thirteen deviations are listed below; the ones you will notice are the sidebar's **+** button, which replaces New Folder and offers New note and New folder (deviation 2), and that a new note's title is typed in its tab (deviation 1). Two bugs turned up while testing and were fixed in the phase: BL-29 (a space typed in a tab's rename box was lost) and BL-30 (Help → Shortcuts failed with one board in two split panes); BL-31, BL-32 and two owner decisions are in `docs/BACKLOG.md`.

**What changed**
- **3.1, making notes and folders with no board (E-03).**
  - **New note** and **New folder** on a folder's right-click menu (made inside it) and on the menu of the empty space below the files (at the vault's top). The sidebar header's **+** button offers the same two at the top (deviation 2). New `lib/vault/sidebarNewItems.ts` (`newNoteIn`, `newFolderIn`): the tag filter and the name search are cleared first and the folder opens, so the new row shows; a new folder's name opens for typing, as the old New Folder button's did.
  - **New note** (`lib/notes/newNote.ts`, `createNewNote`) makes `Untitled.md` (` (n)` past a taken name) with `title: Untitled` and opens it in a Document tab whose name, the note's title, is selected for typing. The title typed names the file too (3.2), so typing "Chapter 4" and Enter gives `Chapter 4.md`; Enter or Escape then puts the caret in the note's text (deviation 1).
  - **Ctrl+N in a Document tab** (`note:new`, AppShell) makes a note beside the one the tab shows, in the same folder; it works while typing in the note. **+ New Tab → Document** makes one in the Root Directory.
  - Help → About's Vault entry says how notes, folders and subfolders are made.
- **3.2, placeholder names and title search (E-13, D2).**
  - New `lib/notes/placeholderNames.ts`. A note still under a name Filo gave it before it had a title (`New Card`, `New Tile 3`, `New Task 2`, `Plot - Subtask 1`, `Untitled`, each maybe ` (n)`) is renamed after the title it is given: `withPlaceholderRename` puts the title edit and a new `RenamePlaceholderCommand` in one `BatchCommand`, so one Ctrl+Z puts back both the name and the title, and redo does both again. The target is the title's file name (`pathForTitle`, shared with "Rename file to match title"), ` (n)` past a taken name.
  - It runs for a tile's or card's title (`TileHeader`), a task's (`lib/tasklist/taskRename.ts`, moved out of `TaskListBoard.svelte`) and a Document tab's (`setNoteTitle`). Not while the vault is closing, opening another or quitting (the editors are frozen then); the next title edit renames it (KL #51). A rename that can't happen (the name taken meanwhile, a lock) leaves the file and says so; the title still changes.
  - The sidebar's search matches a note's title as well as its file name (`filterTree` / `foldersOpenForSearch` take the title, `vaultStore.searchTitleOf`); a row found by its title shows the title beside the file name.
- **3.3, natural order and Group By (E-11).** New `lib/utils/naturalSort.ts` (`naturalCompare`: `Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })`, characters as the last tie-break). The sidebar, the Task List and Kanban title sorts and the template lists use it. Under the default Sort By None, the files and folders never reordered by hand are listed by name in this order too, after any placed by hand (they kept the raw listing's "1, 10, 2", which the audit named). Group By is now the primary key in `sortTree`: files are listed group by group, each group in the Sort By order (the manual order under Sort By None), folders first by name. Groups are names by first letter, dates by day, sizes by File Explorer's bands, types by extension with boards apart from other JSON (deviation 6). Dragging to reorder is off while a Group By is on.
- **3.4, the Mind Map's keys (H-08, E-08).**
  - New `lib/mindmap/mindMapShortcuts.ts`: N, C, Enter and Backspace are commands (`mindmap:new-tile`, `mindmap:connect`, `mindmap:rename-tile`, `mindmap:remove-tiles`), listed in Help → Shortcuts and rebindable like the others. Each acts only for the active pane, with focus in the canvas, and only with something to act on (C and Enter need one selected tile, Backspace one or more), so an idle key isn't taken from the page. `MindMapBoard`'s own handler keeps Escape and the arrows.
  - E-08 (deviation 7): `isCanvasKeyBlocked` leaves every key to the vault sidebar (docked or floating) while focus is in it; the sidebar's tree takes every arrow on its rows; the canvas skips an arrow something else took (`defaultPrevented`); Delete (`tile:delete`) acts only with focus on the canvas or on nothing. A press on the empty canvas now focuses it: in Chromium it didn't, so after a click there the keys stayed with whatever had focus before (the sidebar row).
- **3.5, new tiles clear of each other (H-02).** New `lib/canvas/newTilePlacement.ts` (`placeClear`): a new tile goes to the nearest spot, a tile's width or height and a 24 px gap at a time, that overlaps no tile; a free spot in view wins over a nearer one outside it. The side toolbar's New Tile (every type), Ctrl+N, N, and a Markdown template's tile use it (deviation 8). The old ±50 px random jitter is gone.
- **3.6, undoing a new tile trashes its empty note (H-07).** New `commands/newNoteUndo.ts`, used by `AddTileCommand`, `AddCardCommand` and `AddTaskCommand` (deviation 9). Undo moves the note to Filo's trash when Filo made it for that add in this session (`lib/notes/madeForNewItems.ts`, which follows renames and forgets on a vault swap), its body is empty and no tile on any board shows it; redo brings it back first (beside its old name when that was taken) and re-adds the item on it. A note with text stays.
- **3.7, one template path (E-12).**
  - New `lib/templates/templateNote.ts` (`noteFromTemplate`): every key of the template's frontmatter is kept (`boardType` aside) with `{{date}}`, `{{title}}`… filled in wherever it holds text, lists and maps included; the title is the template's own `title:` (filled in) or its name; the body is filled in. The Mind Map's Template Browser and Kanban's From Template… both use it. On the Mind Map the note is made first (`createNoteFile`) and the tile placed on it, at the canvas menu's spot or the middle of the view, clear of other tiles.
  - New `lib/templates/boardFromTemplate.ts` and `schema/boardTemplate.ts`: a board template's ```` ```filo-board ```` block makes its board's columns and cards (Kanban), sections and tasks (Task List) or tiles (Mind Map), each with a note in the board's folder; the template's own text goes into the first of them without text (deviation 10). A block that can't be read, or names another board type, makes no board and says so. `instantiateTemplate` (now unused) is gone.
- **3.8, picked files in the vault are linked (E-14).** New `lib/vault/pickedFile.ts` (`bringPickedFileIn`): the card cover, File tile and background image pickers link a file already in the vault by its path, and copy one from outside into the board's folder, as before. A pick inside a hidden vault folder (`.filo`, `.stversions`) is copied (deviation 11).
- **3.9, the Search panel's list (H-05).** New `lib/search/matchGroups.ts`; `SearchPanel.svelte` lists the matches under the box, grouped by note: each note's title, its board (or "On no board"), its match count and its first three matches with the words around each, the matched text marked; "N more in this note" opens the rest, and the note holding the current match is always open. A click shows the match, as Find does; the current one is marked and kept in view. The list is one Tab stop, with the arrows moving through it. The first 100 notes are listed, then "Narrow the search to see the rest" (deviation 12).
- **Size ceiling.** `TaskListBoard.svelte` went from 1,368 to 1,356 lines of code (the task rename moved to `lib/tasklist/taskRename.ts`); its row in the `file-sizes` gate was lowered to match.
- **Docs.** CLAUDE.md (the new modules; "Titles are not filenames"; undo of a new tile); the design doc (Note titles, standalone Documents, the Vault Sidebar, the side toolbar's New Tile, Markdown and board templates, the Search panel, the shortcut table, New Tab); KL #51; `docs/BACKLOG.md`.

**Deviations from the plan**
1. **A new note is made as `Untitled.md` and named in its tab (3.1).** The plan said to create the note with a title, then open it. Ctrl+N and New Tab → Document have nowhere to type a title first, so every "New note" makes the file at once, as a new card does, and the title typed into the tab names it through 3.2's rule. One flow for the three ways in; Escape keeps "Untitled".
2. **The sidebar header's New Folder button became a "+" with New note and New folder (3.1).** The plan named only the folder and empty-space menus. The empty space below the files is a 28 px strip in a sparse vault (the tree shrinks to its files), which the E2E run showed is hard to hit, and a seventh 26 px header button doesn't fit the sidebar at its 240 px minimum width. New Folder is now two clicks from the header; a folder's own menu still makes one in a click.
3. **Where each way puts a note.** A folder's menu: in it. The empty space and the header's +: the vault's top, like New Folder always did. Ctrl+N in a Document tab: beside the open note. New Tab → Document: the Root Directory, where other new files go. The plan didn't say.
4. **Which names count as placeholders, and when the rename runs (3.2).** Besides the plan's `New Card (n)`, `New Tile n` and `New Task n`: `Untitled` (3.1's new notes, and a title that is all dots) and `<parent> - Subtask n`. The rule is "while it still has its placeholder name", so a note under such a name is renamed at its next title edit even if its title was set before this change (an existing vault's `New Card (7).md` titled "The Siege" becomes `The Siege.md` at its next title edit). It doesn't run while the vault is closing or quitting (KL #51).
5. **The sidebar row shows the title it was found by (3.2).** Not asked for; without it a row found by title looked like a wrong match. In a narrow sidebar the title gives way first and shows in full on hover.
6. **What Group By groups by (3.3).** "Group By becomes the primary key" by the exact field would make Sort By do nothing (grouping by Date Modified is sorting by it). Groups are wider, as File Explorer's are: names by first letter (digits and symbols together), dates by day, sizes by Explorer's bands, types by extension. There are no group headings (an owner decision in the backlog). Drag-to-reorder is off while a Group By is on, since a row dropped in another group would jump back.
7. **How E-08 is closed (3.4).** The plan said the canvas ignores keys the sidebar handled (`defaultPrevented`). That alone missed Delete (a global command the sidebar doesn't handle) and the arrows the tree let pass (Left and Right on a file). So: focus in the vault sidebar blocks every canvas key in `isCanvasKeyBlocked`, which also makes the finder's repro (`zzA28E_canvasKeysFromSidebar`) pass as written; the tree takes every arrow on its rows; Delete acts only from the canvas or the page; and the `defaultPrevented` check is kept for the arrows. The canvas taking focus on a press needed fixing too (see 3.4 above). N now also selects the tile it makes in the middle of the view (it already did beside a selection), and Shift+N and Shift+C no longer act on the Mind Map (they were never listed).
8. **Clear of every tile, not only the last new one (3.5).** Stepping clear of the last new tile still stacks on an older one; the search for the nearest free spot covers both. It also serves Ctrl+N, N and template tiles, not only the side toolbar, and prefers a spot in view so a new tile is never placed off screen. A tile made from the canvas menu stays at the click.
9. **Cards and tasks too (3.6).** The plan named tiles. A new Kanban card or Task List task leaves the same empty `New Card.md` / `New Task.md` behind when undone, so the same rule covers `AddCardCommand` and `AddTaskCommand` (quick add included: its note's body is empty, though its title was typed).
10. **The board skeleton's format (3.7).** No format existed beyond `{ type, settings }`: the design doc said "a `.board.json` skeleton", but a board file names its notes by path, which a template can't know. The skeleton lists titles instead (`columns` / `cards`, `sections` / `tasks`, `tiles`), each made into a note; the design doc describes it. At most 200 notes are made from one template. The Template Browser is still reached only from a Mind Map (BL-32), and Kanban's card picker still lists board templates (BL-31).
11. **Hidden folders (3.8).** A file picked from a hidden folder in the vault is copied, not linked: the sidebar doesn't show those folders and Filo won't read inside `.filo`. That is the rule Phase 6 (task 6.2, C-01) plans for drops.
12. **How much the Search list shows (3.9).** The first three matches per note and the first 100 notes, so a one-letter search over a big vault doesn't build thousands of rows. Find All stays as it was; whether to keep it is an owner decision in the backlog.
13. **"Component tests for each item".** 3.4, 3.5 and 3.9 have component tests (real components mounted). 3.1, 3.2, 3.6, 3.7 and 3.8 are tested in the characterisation suite instead, which mounts the whole app on a real temp vault: each spans the sidebar, the stores, IPC and the disk, which a single mounted component can't show. 3.3 is a pure function (unit tests). Every item also has unit tests where it has logic of its own.

**Also changed, outside the plan's wording**
- `Tab.svelte` takes a title-edit request (`takeTitleEdit`, as a new tile's header does), and its rename box keeps its own keys (BL-29).
- Help → Shortcuts lists each command once (BL-30).
- The characterisation harness: `clickSidebarNewFolder` goes through the + menu; new `harness/makingNotes.ts`, `mindMapKeys.ts`, `templates.ts` and `pickers.ts`. The new spec `makingAndFindingNotes.test.ts` (16 cases) is in the `characterisation-suite` gate's list. No existing spec changed.

**Tests** (each new case was run against the Phase 2 commit, `e14866f`, in a detached worktree; see Checks)
- **Unit:**
  - New `placeholderNames.test.ts` (7): which names are placeholders; the rename target (the title's name, ` (n)` past a taken one, none for a named note or a placeholder title); one batch with the title step, not while leaving; `RenamePlaceholderCommand` renames, undoes and redoes, says why a rename failed, follows a later rename of its folder but not its own.
  - New `newTilePlacement.test.ts` (6), `mindMapShortcuts.test.ts` (4: listed with ids, act only from the canvas with something to act on, never from the sidebar, the page or another pane, follow a rebinding), `pickedFile.test.ts` (4), `matchGroups.test.ts` (3).
  - New cases in `vaultTreeSortHelpers.test.ts` (natural order, Group By as the primary key in all four groupings and under Sort By None, ties by name, the title search), `taskListModel.test.ts` and `kanbanFiltersAndSort.test.ts` (natural title sort), `mindMapInteraction.test.ts` (the finder's E-08 repro: a focused sidebar row keeps every key), `templateService.test.ts` (`noteFromTemplate`, the skeleton schema; the `instantiateTemplate` case went with it).
- **Component:** new `sideToolbarNewTilePlacement.test.ts` (five tiles of three types, none overlapping), `searchPanelResultsList.test.ts` (4), `tabRenameKeys.test.ts` (BL-29), `shortcutsListOnce.test.ts` (BL-30).
- **Characterisation:** new `makingAndFindingNotes.test.ts` (16 cases, in the `characterisation-suite` gate's list): a folder, a folder in it and a note in that from the sidebar; the empty space's menu, Escape keeping "Untitled", the next one ` (2)`; Ctrl+N in a Document tab and New Tab → Document; a card titled "The Siege" is `The Siege.md`, with undo and redo; a tile and a subtask renamed by their titles, a named note kept; the sidebar search by title; undo of a new tile, card and task trashing the empty note, redo restoring it, a note with text kept; Help listing the Mind Map's keys, a rebinding saved and acting; keys on a sidebar row doing nothing on the Mind Map; a press on the canvas giving it the keys, and five tiles apart; a Markdown template's frontmatter on a Mind Map and a Kanban card; a board template's columns and cards, sections and tasks; a card cover picked in the vault linked, one from outside copied.
- **E2E:** new `makingNotes.e2e.ts` (3), on the built app: a folder, a folder inside it and a note in that from the sidebar with no board, the note named by typing and its text typed at once; a card titled "The Siege" saved as `The Siege.md` and found by the sidebar search, and a note found by its title showing it; the Mind Map's keys doing nothing from a sidebar row, a click on the empty canvas focusing it, and N making a tile clear of the first.

**Checks**
- `npm run ci:verify` on Windows: passed in 323 s on the final code. 841 test files, 8,181 passed and 5 skipped (as before), 91/91 gates.
  - Four earlier runs during the phase: the first stopped at lint (a plain `Set` in Help's list, fixed); the second failed on the three `newCardsAndTiles.test.ts` cases that read a new card's or tile's note at its placeholder path (now renamed to its title, as task 3.2 intends: those three assertions were updated to the title's path, the spec's only change) and on five timing tests in code this phase didn't touch, all passing alone (the run took 525 s, the machine was busy); the third failed on one real-disk watcher test (`fileWatcherSuppressCaseFold`, passing alone; BL-09, which now names it too); the fourth passed (434 s). The final run came after the Sort By None change and the tooltip.
- E2E with `FILO_E2E_SCALE=1` on the final build: 37 passed (the 34 from before and the 3 new), 3.0 min.
  - An earlier full run, while the machine was slow, failed two scale budgets (Kanban 300 open 1,284 ms; Task List fields 1,284 ms after the rows). Three alternating runs of `scaleBudgets.e2e.ts` on the Phase 2 build and this one, at that time, gave medians of 1,262 against 863 ms (Kanban 300 open), 845 against 530 ms (switch back), 1,615 against 1,243 ms (Task List fields) and 136 against 105 ms (a 2,000-note folder's first rows): both builds missed the budgets, and Phase 3 was no slower.
- **Bite checks** (the new tests on the Phase 2 commit, `e14866f`, in a detached worktree with `node_modules` junctioned, since removed):
  - Unit: every new case in `vaultTreeSortHelpers`, `taskListModel`, `kanbanFiltersAndSort` and `mindMapInteraction` fails (10 cases). `placeholderNames`, `newTilePlacement`, `mindMapShortcuts`, `pickedFile` and `matchGroups` test new modules, so they have nothing to run against there.
  - Component: 6 of 7 fail; the one that passes is a control (no matches, no list). Characterisation: 15 of 16 fail, each for the reason it tests; the one that passes is a control (a note with text is kept). E2E (`FILO_E2E_MAIN` on a build of `e14866f`): 3 of 3 fail.
- Corpus check: not run. Nothing in the editor or the Markdown writer changed (template notes are written by the same `createNoteFile` as before).
- **Screenshots** of the built app (folder menu, a new note's title, the Search list, the sidebar's title search) were taken with a throwaway Playwright script, not kept in the repo.

**Pass test**
- Component tests for each item: **met**, with 3.1, 3.2, 3.6, 3.7 and 3.8 tested by mounting the whole app (the characterisation suite) rather than one component (deviation 13).
- E2E: a note and a nested folder made from the sidebar, with no board involved: **met** (`makingNotes.e2e.ts`, first case). A card titled "The Siege" is found by sidebar search, and its file is `The Siege.md`: **met** (second case).

**Found in this phase and fixed (BL-29, BL-30)**
- **BL-29: a space typed in a tab's rename box was lost** (Impact 2/10, Hard 0/10). The tab handles Space and Enter itself (to show the tab), and the rename box's keys bubbled up to it, so "Chapter 4" became "Chapter4" when a board or a note title was renamed from its tab. In the code since the first commit; the characterisation harness set the box's value without key presses, so no test saw it. The E2E run of 3.1 did. Fix: the tab's handler leaves keys typed in the box alone. Test: `tabRenameKeys.test.ts` (fails on the Phase 2 commit).
- **BL-30: Help → Shortcuts failed with one board in two split panes** (Impact 1/10, Hard 0/10). A board registers its commands once per pane (each acts only for its own pane), and Help's list, keyed by command id, threw Svelte's `each_key_duplicate` on the second copy. Two Kanban boards side by side already did it; with 3.4 two Mind Maps would too. Fix: the list names each command once. Test: `shortcutsListOnce.test.ts` (fails on the Phase 2 commit with that error).

**Found in this phase, not fixed (in `docs/BACKLOG.md`)**
- **BL-31: Kanban's "From Template…" lists board templates** (Impact 1/10, Hard 1/10); picking one makes a card from its text and drops its board.
- **BL-32: a board template can be started only from a Mind Map** (Impact 1/10, Hard 2/10): the Template Browser is the only place board templates are offered, and it opens only on a Mind Map.
- Two owner decisions: keep or drop the Search panel's Find All popup now that the panel lists matches itself (Useful 1/10, Hard 1/10); headings for the sidebar's Group By groups (Useful 2/10, Hard 2/10).
- BL-09 now also names `fileWatcherSuppressCaseFold.test.ts`, seen failing once under load.
- KL #51: a title typed as the vault closes leaves the note's placeholder file name until its next title edit.

### Phase 4 outcome (2026-10-05)

**Status:** done and committed. All twelve tasks are in; D8 was taken at its default (quick add reads a repeat). Ten deviations are listed below. The ones you will notice: Group By now groups the rows inside each section, so a Task List made before this change shows its stored Group By (Status, unless you changed it) as "To Do" / "Done" headings inside its sections (deviation 4; pick None in Group By for the old look); priority chips say "Urgent" and "Medium" where they said "!!!" and "Med" (deviation 8); and a Kanban card's due date is picked in the Task List's date picker. No new numbered backlog item; two owner decisions went to `docs/BACKLOG.md` (end of this section).

**What changed**
- **4.1, the keys and ranges follow the screen (E-01).** The view model draws each section's rows flat (`flatSections` in `lib/tasklist/taskListViewModel.svelte.ts`: a row, then its shown subtasks, group by group) and lists the rows on screen top to bottom (`renderedRows`): sections in order, a folded section's rows and a folded parent's subtasks left out. ArrowUp / ArrowDown, Tab (indent under the row above), Shift-click ranges and Ctrl+A (Select All) use it (`taskListKeyboardNav.svelte.ts`, `multiSelectController.svelte.ts`), so under the default priority sort a range is the rows shown between the two clicks, and ArrowDown no longer sticks on a folded parent. The board's own flattening moved into the view model with it.
- **4.2, quick add files where Add Task does (E-02).** `taskCreation.ts` has one rule for both (`defaultTargetSection`): the section last added to, while it exists, else the first. A folded target section opens first, as its own undo step (Ctrl+Z after a quick add removes the task, then folds the section again). When a filter hides the new task, a notice says so: *"Buy ink" was added to "To do", but the filters hide it.* Screen readers hear which section it went to.
- **4.3, quick add reads what was meant (E-05, D8).** `lib/tasks/quickAddParser.ts`:
  - **Weekdays:** "next" takes only a weekday's name or its usual short name (mon, tue, tues, wed, weds, thu, thur, thurs, fri, sat, sun); "next month", "next wedding", "next friend" and "next sunrise" stay text.
  - **Fractions:** `5/12` is a date only as the title's last word (a time may follow it), so "Revise act 2/3 of the book" keeps its fraction; "Pay rent 5/12 #home" is still a date.
  - **Times:** a clock time right after the due date is its time: "tomorrow 5pm", "next mon at 9:15am", "today 5 pm", "2026-06-01 17:30". It needs am/pm or a colon, so "Meet tomorrow 10 people" keeps its number. An `@time` wins; a `^start` date takes none.
  - **Repeats (D8):** "every friday" (weekly, from the first Friday, today included), "every 2 weeks", "every other day / week / tuesday", "every day / week / month / year", "every 3 months", "every weekday". Without a date typed with it, the due date is the repeat's first day. Every rule it writes is one `recurrence.ts` reads (tested). The preview shows *Repeats weekly*.
  - **Tags** need a letter, so "Chapter #3" and "Issue #123" keep their numbers (E-05's last example).
  - The preview chips show a date, time and priority as the row will (shared formatters), from the clock store's day.
- **4.4, Filter by Status (E-15).** `statusBucket` (`lib/tasks/taskListModel.ts`) is the one rule Group by Status and Filter by Status share: a completed task is Done, a task with no `status:` (every task made in Filo) is To Do, `doing` / `in_progress` are In Progress. The filter compares buckets, and reads an older saved view's `doing` as In Progress. The menu lists the statuses the board's tasks are in (`statusFilterOptions`), in the group order, with their labels; the active one stays listed while no task is in it.
- **4.5, Group By inside sections (E-16).** Group By groups each section's rows (`groupRows` in the view model): the group's first row carries a heading with its count (inside that row's own element, so each drag item is still one row); a subtask stays under its parent; groups follow the old order (To Do, In Progress, Done …). The button is never greyed out. Every Task List now draws its sections (a list with none draws the default "Task List" section); the separate grouped view is gone, with its folding groups. New lists start with Group By None (`buildBoardDefaults.ts`).
- **4.6, the date picker from the keyboard (E-17).** `TaskDatePicker.svelte`, with the arithmetic in new `lib/tasklist/calendarGrid.ts`:
  - It opens with focus on the task's day (else today), inside a focus trap; closing gives focus back to what had it (the row, or the chip).
  - The arrows move a day or a week, Home / End to the week's ends, Page Up / Page Down a month (clamped to the month's end); the ‹ › buttons move the keyboard's day with the month. Enter or Space picks; Escape closes and is kept from the row and the app behind it.
  - The week starts on the OS regional format's first day (Monday for en-GB, Sunday for en-US; `Intl.Locale` week info), with the weekday names in its language. Each day is read out in full (*Monday, 12 October 2026, today*), today is `aria-current="date"`, and the month heading is in the regional format. The grid is one Tab stop.
  - D on a row opens it, as before; now focus goes there.
- **4.7, the Kanban due date (E-06).** A card's due chip opens the Task List's picker, so a day is chosen whole: the native date box, which saved a wrong date at the first digit typed and closed, is gone (`KanbanCard.svelte`). The picker's time box keeps what is typed and saves it once: on Enter, on leaving the box, or when the picker closes (Done, Escape, a click outside). It used to save, as an undo step, at every part of the time typed.
- **4.8, keyboard selection in view, and Move to column (E-18).** The Mind Map's arrow keys (and Ctrl+Shift+arrows) pan the view just enough to show a tile they select off screen (`lib/canvas/revealRect.ts`, a 40 px margin; a tile in view leaves the view alone). Kanban's arrow keys scroll the card they select into view (`lib/kanban/kanbanKeyboardNav.ts`, which now holds Kanban's arrow-key navigation). One card's right-click menu ends with **Move to column** and the board's other columns (`buildCardContextMenu`); it moves the card to the end of that column as one undo step (`moveTilesToColumn`, shared with the bulk menu). "Moved 1 card to …" (it said "card(s)").
- **4.9, the Repeat menu (E-25).** New `lib/tasklist/taskDateMenus.ts` and `components/boards/RepeatPopup.svelte`:
  - The menu offers None, Daily, Weekdays, Weekly, **Every 2 weeks**, Monthly, Yearly and **Every…**, which opens a small box for any number (1–999) of days, weeks, months or years. A rule set that way shows and is checked as *Every 3 days…*.
  - With a rule set, it says what the next date counts from: **The due date** (schedule mode, the default) or **The day it is done** (`recurrenceMode: completion`; the anchor key goes with a change, `recurrenceModePatch`).
  - The repeat chip opens the Repeat menu (it opened the due-date picker), and its tooltip names the rule in words (*Repeats: Every 2 weeks*).
  - A rule Filo can't read is shown on its chip in the danger colour and named at the top of the menu. Completing such a task marks it done and says so with Undo: *Marked done, and it won't repeat: Filo can't read its repeat rule "every 2nd tuesday". Pick a rule in Repeat to keep it repeating.* (deviation 7). The bulk Mark Complete counts them in one notice.
  - The date chips' right-click menu shows the start date and rule in words.
- **4.10, an open notes box follows its note (A-06).** `NotesBox.follow` (`lib/tasklist/notesBox.svelte.ts`), run by the row's effect: while the user hasn't typed in an open box, it shows the note as it is now, so typing after a change made elsewhere writes onto that change with no question. Once they type, a change elsewhere still gets the conflict question (Keep mine backs the other version up first).
- **4.11, one delete flow, one vocabulary, one fold policy (E-19).**
  - Backspace on the Mind Map runs the same Remove as Delete and the menus (`requestDeleteSelected`): one prompt, *Remove tile from board?*, which offers to move the notes to Filo's trash too. Its own prompt, without that option and in developer words, is gone.
  - Priorities have one set of words everywhere (`constants/taskPriorities.ts`): Urgent, High, Medium, Low, No priority, on the chips (they said "!!!" and "Med"), the card's menu, the bulk bar, the filter chips (they showed `urgent`, `none`), the group headings ("No Priority") and the quick-add preview ("!!! Urgent", "! High").
  - Folding a Task List section is an undo step (`SetSectionCollapsedCommand`), as folding a Kanban column, a frame or a task's subtasks already was; it was the one fold that wasn't. A section opened for a quick add or a file dragged over it is a step too.
- **4.12, one day parser and one way to show a day (E-24).** `lib/utils/dateFormat.ts` holds `parseLocalIsoDate` (the one parser: a `YYYY-MM-DD` that is a real day), `localDate`, `formatDay` (the chip form in the OS regional format: *12 Oct*, with the year when it isn't this year's) and `formatDayLong`. The copies in `recurrence.ts`, `quickAddParser.ts`, `taskListModel.ts`, `dueDateFormat.ts` (two) and the date picker's state are gone. Days now show this way in the quick-add preview (it used the UI language), the "rescheduled to" notice and the start-date menu item (ISO), the start chip's tooltip, and the due chips' labels (*Due Monday, 12 October 2026: change due date*).
- **Size ceilings.** `TaskListBoard.svelte` went from 1,356 to 1,170 lines of code and `TaskItem.svelte` from 1,196 to 1,180; their rows were lowered to match. `KanbanBoard.svelte` (984) is within the limit and left the allowlist.
- **Docs.** CLAUDE.md (the new modules, the view model, dates, priorities, section folds, the allowlist); the design doc (the Task List example's Group By, recurring tasks and the Repeat menu, the Task List side toolbar, keys and ranges, quick add, the date picker, dates, folds, the notes box, Kanban's due date and Move to column, Backspace); `docs/BACKLOG.md`.

**Deviations from the plan**
1. **Ctrl+A follows the screen too (4.1).** The plan named the arrows, Tab and Shift-click. Select All took every filtered row, a folded section's and a folded parent's included, so a bulk Delete after it could remove rows the user couldn't see (the Mind Map's Select All already skips tiles in folded frames).
2. **Quick add does both (4.2):** it opens a folded section and, when a filter hides the task, says where it went. The plan said "or". The opening is its own undo step, undone after the add, as Add Subtask's opening of a folded parent already was.
3. **More of E-05 than the plan's wording (4.3).** Tags need a letter (the finding's "Chapter #3"); the existing test that read `#123` as a tag was changed to expect the number kept. The fraction rule is "the title's last word, a time may follow"; the plan said only "not between words". A repeat with no date sets the first due date, so the task shows in Today on its day (the recurrence engine needs a due date in schedule mode). "every other …" is read as every 2.
4. **Group By inside sections changes existing lists (4.5).**
   - Every board until now kept `groupBy: status` (the default, written when it was made) and ignored it once it had a section, which every new list has. Group By now applies inside sections, so an existing list shows To Do / Done headings with its completed tasks at the foot of each section, unless its Group By is changed to None. New lists start with None. A board's stored value can't tell a default from a choice, so the existing ones weren't changed.
   - The separate grouped view, with its foldable groups, is gone: every list draws its sections. Folding a group inside a section is an owner decision in the backlog.
   - The group heading is drawn inside its first row, so it travels with that row while it is dragged. A drag under a Group By keeps the task in its group (its fields decide the group), as a sort already does.
5. **The date picker (4.6)** keeps focus inside with a focus trap while open (the plan didn't say), and its grid is a labelled group of buttons with one Tab stop, not an ARIA grid (which needs rows of cells). The ‹ › buttons move the keyboard's day with the month.
6. **Keyboard selection (4.8)** pans the Mind Map only as far as needed rather than centring the tile, so a selection walking along a row of tiles doesn't jump the view each time.
7. **A rule Filo can't read (4.9).** The plan said "warns … instead of completing the task for good". Complete still marks the task done, since that is what the click asked for, and the warning offers Undo (while it is the board's last step); the rule shows in the danger colour on its chip and at the top of the Repeat menu before then. Refusing the click would leave tasks imported from other apps (Obsidian Tasks' "every week on Monday") uncompletable until their rule is fixed.
8. **The delete flow (4.11)** changed only Backspace, as planned. Removing one Kanban card or Task List task still happens at once (undoable) where one Mind Map tile asks first, since that prompt is where the tile's note can go to the trash too; whether to change that is an owner decision in the backlog (E-19's "Delete asks on the Mind Map but not for one card or task"). The fold policy is "every saved fold is an undo step"; the old in-memory group folds went with the grouped view.
9. **One date parser, for calendar days (4.12).** It is strict: text that isn't a `YYYY-MM-DD` day, or a day the calendar doesn't have, is shown as written, is never overdue and is in no smart list. Before, `2026-02-30` counted as 2 March in the smart lists and showed as "Mar 2", and the chips fell back to `new Date(text)` for other text. Times of day and moments (Settings → Trash, the recovery list, a board's "edited" stamp) are not calendar days and keep their own formatters.
10. **Two characterisation cases changed (4.10).** In `taskNotesBox.test.ts`, "typing after a change elsewhere asks first" and "a draft waiting on a conflict" typed after the outside change, which now follows into the box and saves without a question, as 4.10 intends. They now type first, then the outside change arrives, so they still test the conflict, Keep mine's backup and the rescue copy at close. A new case covers the follow. The harness's `setCardDueDate` drives the picker (its specs didn't change).

**Tests** (each new case was run against the Phase 3 commit, `decd96c`; see Checks)
- **Unit:**
  - `dateFormat.test.ts`: the parser (local midnight, Feb 30 and other shapes refused, round trip), `localDate`, `formatDay` (moved from `dueDateFormat.test.ts`, plus a non-day shown as written), `formatDayLong`.
  - `quickAddParser.test.ts`: the finder's five repros (next month / wedding / friend / sunrise; act 2/3), weekday short names, a date as the last word with tokens or a time after it, times after the date, repeats (every friday / mon / 2 weeks / 3 days / 6 months / other week / other tuesday / weekday / a date typed with it), every rule read by the recurrence engine, words that only start like a repeat, tags that need a letter.
  - `taskListFilter.test.ts` (the finder's E-15 repro and five more), `taskListModel.test.ts` (the shared "No priority" label).
  - New `taskListScreenOrder.test.ts` (14: the finder's E-01 repros for ArrowDown, Tab, a folded parent and the Shift-click range; folded sections; Select All; Group By inside sections by status and priority; a subtask under its parent; None).
  - New `taskQuickAddSection.test.ts` (6: the finder's E-02 repro; the last-used section; a folded target opened first; the filter notice).
  - `sectionOps.test.ts` (folds through a command, `expandSection`), `sectionCommandsDelta.test.ts` (`SetSectionCollapsedCommand` execute / undo / redo, a rename and a task in between kept, a gone section).
  - `datePickerViewState.test.ts` (week start, weekday names, the six-week grid, the keys, month clamping, the month buttons), new `taskRepeatMenu.test.ts` (9: the menu, Every…, the mode, a rule Filo can't read, every rule read back, the date menu, the mode patch, Complete's warning and its Undo on a real note store), `taskNotesBox.test.ts` (4: the follow), new `keyboardSelectionInView.test.ts` (9: `revealOffset`, Kanban's arrows and `revealCard`, the card menu's Move to column), `buildBoardDefaults.test.ts` (a new list starts ungrouped).
  - Tests that build the keyboard and selection controllers use the new `getRenderedRows`.
- **Component:** new `taskDatePickerKeyboard.test.ts` (10, the real picker): focus on the day, the keys, Enter, Escape with focus back and the key kept from the page, the readable labels, the week start for en-GB and en-US, today when there is no date, and the time box saving once (on leaving, on Enter, on Done; an unchanged time saves nothing). New `repeatPopupKeys.test.ts` (3, the real "Every…" popup): focus kept when the menu hands it back to the chip, so Escape closes it; the task's own rule to start from and Enter saving; a number it can't keep refused.
- **Characterisation:** new `listsAndBoards.test.ts` (9, in the `characterisation-suite` gate's list): the plan's case (a priority-sorted list, a Shift-click range, bulk Delete removing only those rows, the notes kept); ArrowDown and Tab; quick add into the first section with Done folded, and both undo steps; repeats, a time and words in quick add; the status filter and Group By in a section, the button never greyed; D, the arrows and Enter in the picker with focus back, and Escape; Every 3 days and the completion mode; a Kanban card's date in the picker and Move to column; Backspace's prompt on the Mind Map. `taskNotesBox.test.ts` as in deviation 10.
- **E2E:** new `taskListKeys.e2e.ts` (2, on the built app): on a priority-sorted list, ArrowDown follows the screen, D / ArrowRight / Enter pick a day with focus back on the row, Escape closes, and a Shift-click range and bulk Delete leave only the other rows; a Kanban card's date picked from the keyboard.

**Checks**
- `npm run ci:verify` on Windows: passed in 321 s on the final code. 848 test files, 8,301 passed and 5 skipped (as before), 91/91 gates.
  - Two earlier runs passed too (323 s and 325 s; 847 files, 8,298 passed), before the popup fix below and its test.
  - Before them, the gates had caught one type error in a new test (a spy returning nothing where a toast id is returned), fixed, and svelte-check two warnings (a grid's `svelte-ignore` code; a prop read once on purpose, now in `untrack`), fixed.
- **The characterisation suite** before the spec changes: 7 failures in 4 files, all expected. 5 used the harness's old due-date box (`setCardDueDate`, now driving the picker; no spec changed for it), and 2 were the notes-box cases of deviation 10. All pass now.
- **E2E with `FILO_E2E_SCALE=1` on the build** (39 cases: the 37 from before and the 2 new):
  - First run: 38 passed in 3.1 min. The failure was the new Kanban case, which typed the card's title before its title box had focus (a timing slip in the spec, not in the app); with the wait the other E2E specs use, both new cases pass.
  - Second run: 39 of 39 in 3.1 min.
  - Final run, after the popup fix: 38 passed in 3.6 min. The Kanban 300 "tab comes back in under 0.5 s" budget took 671 ms (BL-28). Three alternating runs of `scaleBudgets.e2e.ts` on this build and on a build of Phase 3 gave the same medians (switch back 274 ms on both; Kanban 300 open 434 and 436 ms; Task List fields 669 and 638 ms after the rows; a 2,000-note folder's first rows 61 and 58 ms), and the Phase 3 build spiked to 592 ms in one of them, so it is BL-28's spike, not a slower app. BL-28 notes it.
- **Bite checks** (the new tests on the Phase 3 commit, `decd96c`, in a detached worktree with `node_modules` junctioned, since removed):
  - Unit and component: 80 cases fail in 14 files. `datePickerViewState`, `taskRepeatMenu` and `keyboardSelectionInView` fail to load (they test new modules: `calendarGrid`, `taskDateMenus`, `revealRect`, `kanbanKeyboardNav`). In `quickAddParser`, 21 of the 32 new cases fail; the 11 that pass are controls (a weekday's full name or short form after "next", a date as the last word, a bare number after a date, a start date's time, words such as "every time"). In `taskQuickAddSection` 4 of 6 fail; the 2 controls are an open section left alone and no notice when the task shows. Every new case in the other files fails.
  - Characterisation: all 9 cases of `listsAndBoards.test.ts` fail, each for the reason it tests (the range took four rows; ArrowDown went to Alpha; the quick-added task vanished into the folded section; no `recurrence:`; the Group By button greyed; focus not on the picker's day; "Stretch every day" kept its words; no picker on the card; Backspace's old *Delete tile?* prompt). The new notes-box case fails (the box kept the old text); the two reordered conflict cases pass there too, as they should (that behaviour didn't change).
  - E2E (`FILO_E2E_MAIN` on a build of `decd96c`): both new cases fail (ArrowDown focused Alpha; no picker on the card).
- **Corpus check:** not run. Nothing in the editor or the Markdown writer changed.
- **Screenshots of the built app** (a throwaway Playwright script on a fresh vault, not kept in the repo): the status headings inside a section, the date picker with the week from Monday (en-GB) and today marked, the Repeat menu with Every 2 weeks checked and "The next date counts from", the "Every…" popup, and a card's menu with Move to column. They found the popup bug below; after the fix, Escape closes it there too.

**Found and fixed in this phase**
- **Escape didn't close the "Every…" popup** (Impact 1/10, Hard 0/10; found by the screenshot check above, in the built app). The Repeat menu hands focus back to the repeat chip as it closes, just after the popup has taken it, so Escape and Enter went to the chip and the popup's backdrop stayed over the app. The popup now keeps focus inside with a focus trap, as the date picker does, and still gives it back to the chip when it closes. `repeatPopupKeys.test.ts`'s first case fails without the trap (checked by putting the first version back for one run) and passes with it.

**Pass test**
- The finder repros for E-01, E-02, E-05, E-06 and E-15 pass: **met** for E-01, E-02, E-05 and E-15 (now permanent tests, above). The E-06 repro probes Chromium's own date box, which still fires a change per keystroke; Filo no longer uses that box on a card, so it is replaced by the E2E case and the time-box tests.
- A characterisation case: a priority-sorted list, then a Shift-click range and bulk delete, removes only the highlighted rows: **met** (`listsAndBoards.test.ts`, first case).
- E2E `dailyDriver` is still green: **met**, in all three full runs.

**Owner decisions added to `docs/BACKLOG.md` (section 2)**
- **Removing one card or task:** keep it at once (undoable), ask first as the Mind Map does, or make the Mind Map's one-tile Remove immediate with an Undo toast and a "Delete from vault…" menu item (Useful 1/10, Hard 1/10).
- **Folding a group inside a section** (Useful 2/10, Hard 2/10).

### Phase 5 outcome (2026-10-05)

**Status:** done and committed (Phase 4 and Phase 5 as two commits). All twelve tasks are in; D9 was taken at its default (no templates in the text menu). Nine deviations are listed below. The changes you will notice:
- right-clicking text shows Cut, Copy, Paste, Select All and, in a note, Insert Link;
- the formatting toolbar greys out with no text to format, and at laptop widths it narrows and folds its last group into a **More formatting** (⋯) button;
- below 1,340 px the docked sidebar pushes the board aside instead of covering it;
- a gear button opens Settings;
- **Copy link to …** on tiles, cards, tasks, tabs and the sidebar's notes and boards;
- Escape closes the Search panel from anywhere, and now also clears a Kanban selection (it never did).

Two bugs turned up and were fixed in the phase: BL-33 (the font box blank in a vault whose `app.json` names no font) and BL-34 ("Copy all problems" never reached the clipboard). BL-35 (the Task List's Table of Contents over the list at laptop widths, older than this phase) is in `docs/BACKLOG.md`.

**What changed**
- **5.1, the right-click menu on text (E-04, D9).**
  - Main builds it (`src/main/utils/textMenu.ts`, wired in `main.ts`): the spelling suggestions and Add to Dictionary on a misspelled word, then Cut, Copy and Paste, then Select All (each enabled from Chromium's `editFlags`), then **Insert Link…** in a note's text, or **Edit Link…** on a link. Text selected in an embedded page offers Copy alone; anywhere else Filo keeps its own menus, as before.
  - Only the renderer knows which editor has the focus, so as the menu opens main asks it (`app:text-menu-query`, answered by `app:text-menu-reply`; `src/main/services/textMenuQuery.ts`). An answer that doesn't come within 300 ms opens the menu without the link item. A title, a label or the Raw view gets no link item: they have no link mark.
  - The link item sends `app:insert-link` with where the menu opened, and the renderer (`lib/editor/textMenu.ts`) opens the Insert Link popup there, on the editor the menu was opened over, even though the native menu took the focus.
- **5.2, keys while typing (E-10).** Ctrl+W, Ctrl+Tab and Ctrl+Shift+Tab work in a note, a title, a text field and the Raw view, and Ctrl+Shift+F in a text field (Ctrl+S already did since Phase 1). Before closing or leaving a tab they end the edit, as a click on a tab does (`releaseTextFocus`), so a title or field that saves on blur hands its text over.
- **5.3, laptop widths (H-04, BL-01).**
  - The docked sidebar pushes the workspace aside (a left margin of its width) where the 860 px Document page would start under it: below 1,340 px with the default 240 px sidebar, more with a wider one (`lib/utils/sidebarLayout.ts`, `uiStore.sidebarPushesWorkspace`). Above that it lies over the workspace as before. Kanban's own shift for the sidebar stands down while the workspace is pushed.
  - The formatting toolbar starts at its left edge when it doesn't fit (`justify-content: safe center`), and no control is squeezed any more: at 1,100 px the font-size box had been squeezed to 2 px wide.
  - It takes the roomiest of three densities whose controls fit the room it has, measured (`lib/utils/toolbarDensity.ts`, a `ResizeObserver`): **normal**; **tight** (narrower dividers, font and style boxes); **compact** (short alignment labels, and line spacing, the indents and Clear Formatting folded into a **More formatting** popover). A toolbar still too wide (a large toolbar scale) scrolls from its left edge.
  - The vault menu's name is cut short with an ellipsis (160 px, 112 px below 1,200 px), with the whole name in its tooltip.
- **5.4, Settings (H-06).** A gear button (Settings, Ctrl+,) at the right of the toolbar. Every Settings tab now says how it saves in the same place, the bar above its page: *Changes here save as you make them.* (General), *No changes. Changes here wait for Apply.* / *Unsaved changes: Apply saves them, Revert drops them.* (Global Defaults, Current Board), *Picking a theme applies it at once. The theme editor saves when you click Save.* (Themes), *Restore and Empty trash act at once.* (Trash). General's old italic line moved into that bar.
- **5.5, the formatting toolbar with nothing to format (H-10).** With no editor as its target (`toolbarStore.editorActive`), the font, size, B / I / U, colour, style, link, align, list, indent and Clear Formatting controls are disabled and dimmed, and the toolbar's tooltip says *Click into a note or a title to format its text*. Spelling, a setting for every editor, stays live. Focus moving from an editor into the toolbar keeps that editor as the target, so the controls can now be reached with Tab; leaving the toolbar for anything else lets it go.
- **5.6, nested frames (E-09).**
  - Dragging a frame carries the frames wholly inside it (`lib/frames/nestedFrames.ts` `framesInside`) and their tiles.
  - Afterwards each moved frame takes the tiles now inside it, and each moved tile leaves the frames it left and joins those it landed in (`framesStore.refreshMembership`).
  - One undo puts it all back (`MoveFrameCommand` holds the nested frames' ids), and a drag torn down mid-gesture reverts them too (`frameDragCancel.ts`).
  - Frames are drawn and hit larger first (`framesInPaintOrder`), so a frame inside another is above it whichever was made first.
- **5.7, panes (E-21).** Focus moving into a pane (Tab, or a focus a dialog gives back) makes it the active pane, as a click does (`PaneView.svelte`).
- **5.8, the Mind Map's panels (E-26).** The minimap and the waypoints are shown or hidden per board, in `.filo/workspace.json` (`mindMapPanels`, by board id). The key is written only once a board hides one, so other vaults' files don't change. A deleted board's entry goes with it, and undoing a sidebar delete puts it back (it is part of the board's `BoardView`).
- **5.9, plain words (E-23).** The components gate's word list gains `placement`, `backing` (not "backing up"), `out-of-band` and `persist`. With them it found 13 messages, all reworded: for example *This column holds 3 cards. They leave this board with it; their notes stay in the vault. Undo puts them back.* and *Couldn't save the board "Plan" to disk*. Two labels the gate can't see were reworded too: the broken tile's **Recreate note** (was *Recreate backing file*) and its badge's tooltip.
- **5.10, links (E-22).**
  - **Copy link to tile / card / task** (their menus), **to board / note** (a tab's menu; the sidebar's menu on a loaded board or a note).
  - A note has a link of its own now: `filo://note/<path>` (`schema/link.ts`). It opens only a plain Markdown path in the vault: no drive or leading slash, no `..`, nothing in `.filo/`. A missing note says so instead of opening an empty tab.
  - The link goes on the clipboard twice over: as its address, and as a link reading the name of what it opens. Pasted into a note it is a named link (`[River City](filo://note/River%20City.md)`); pasted into Insert Link's address box it is the address.
  - Main writes the clipboard (`shell:copy-text`, `src/main/utils/clipboardPayload.ts`; deviation 7).
  - Help's Links entry says how links are made and followed. The link popup's address box suggests *example.com, or a link copied in Filo* (it asked for `filo://board/<id>`, which nothing showed).
  - KNOWN_LIMITATIONS #52: a link to a note names its path, so a rename or move leaves it behind.
- **5.11, Current Board for a note (E-20).** `CurrentBoardDocument.svelte` is gone (deviation 8). The Current Board tab, off while a note is shown, now says why: *A note has no board settings: its page follows Global Defaults → Document*. The design doc's "Document Board Settings" line says the same.
- **5.12, Escape and the Search panel (BL-03).**
  - Escape closes the panel wherever the focus is, once whatever lies above it has had the key (`lib/search/searchEscape.ts`; deviation 9): a dialog, a menu, a popup, a board's selection or connection mode, a text field or a title being edited.
  - Escape inside the panel closes it as before.
- **Size ceiling.** `TaskItem.svelte` went from 1,180 to 1,161 lines of code: its three inline-style computations moved to `lib/tasklist/taskRowStyle.ts`, which made room for the Copy link item. Its row in the `file-sizes` gate was lowered to match.
- **Docs.**
  - CLAUDE.md: the new modules, hotkeys, the toolbar, the workspace store, the gate's words, the test setup and the E2E list.
  - The design doc: the Settings button and saving rule, a note's Current Board, Escape and Search, the panels per board, panes, nested frames, the text menu (Insert Template is not in it), the Copy link items and a Links entry, the toolbar at laptop widths, and the sidebar's push.
  - KNOWN_LIMITATIONS #52; `docs/BACKLOG.md`.

**Deviations from the plan**
1. **How the text menu learns about links, and where the popup opens (5.1).**
   - The plan sent Insert Link to the renderer without saying how main knows to show it. Main asks the renderer as the menu opens (a 300 ms bound), since only the renderer knows which editor has the focus and whether it takes links.
   - The item reads **Edit Link…** on a link.
   - The popup opens where the menu opened, not at the caret.
   - The editor is focused again with ProseMirror's own `view.focus()`: TipTap's focus command waits for an animation frame, so the popup asked for the editor before it had the focus and said "Click into a text tile or document first". A component test found it.
2. **Keys while typing (5.2) end the edit first, and Ctrl+W waits for it.** A title being typed is committed by its blur through an undoable command, which writes asynchronously. Closing the tab at once ran the close's save before that write was queued, and the close then asked *Unsaved changes* about the note and its board (the characterisation case found it). Ctrl+W waits for the history chain (`whenChainSettled`) before closing. The wait isn't inside `tabStore.close`, since a board delete's command closes tabs and would wait on itself. The tab keys also work in text fields, not only in editors (the plan said "while typing").
3. **The sidebar's breakpoint (5.3)** is where the page would start under the sidebar: 860 px plus the sidebar on both sides, 1,340 px at the default width. A first rule (960 px of room, 1,440 px) pushed at 1,366 px too. There the page already clears the sidebar, and pushing made the Task List's Table of Contents open over the list instead of beside it. So at 1,366 px the sidebar lies over the workspace as before, with the page 38 px clear of it.
4. **The formatting toolbar needed more than `safe center` (5.3).**
   - `safe center` alone left the right end scrolled off with no visible scrollbar at 1,100 px: the controls need about 1,013 px and had 769. Every control also shrank, the size box to 2 px.
   - Controls no longer shrink. The toolbar narrows its boxes and then folds its last group into a popover, as far as its room calls for.
   - The room is measured, not read off the window's width. Fixed width steps fitted with a vault called "Book" but not with "Chrome Vault" (the E2E vault), since the vault's name and the toolbar scale change the room.
5. **Clearer labels, not one saving rule (5.4).** The plan offered either. The Apply tabs have a live preview and Revert, and the leave, quit and session-end prompts (and their gate, `leave-settles-unapplied-settings`) exist to guard their unapplied edits. Making those tabs save as you go would drop that safety net and ripple through all of it, far past the task's Hard 1/10. Every tab now states its rule in the same place instead.
6. **What "inside" means for frames (5.6).** A frame is inside another when it lies wholly within it and is smaller; two frames the same size don't carry each other, and one that only overlaps stays put. Membership is refreshed for the moved frames and every moved tile, which also covers frames elsewhere that a moved tile landed in or left. A frame's resize is unchanged (the plan named the drag).
7. **The clipboard is written by main (5.10).**
   - Filo's permission policy denies every page's clipboard writes, Filo's own included, and `permissionPolicy.test.ts` pins that. So `navigator.clipboard` failed in the app: the board-load notice's "Copy all problems" never copied anything (BL-34).
   - Rather than loosen the security policy, main writes the clipboard on request (`shell:copy-text`). It checks the text: at most 100,000 characters, and a name only on one of Filo's own `filo://` links. It builds the link's HTML itself.
   - Electron 44's main-process clipboard is the asynchronous W3C-style API (`write([new ClipboardItem(…)])`).
   - Cards and tasks got Copy link too (they are tiles on their boards).
8. **Removed, not per-note settings (5.11).** `CurrentBoardDocument.svelte` could not be reached: the Current Board tab edits no board while a note is shown (`settingsBoard()`). Per-note page settings would add keys to the user's notes for colours that Global Defaults → Document already sets for every note.
9. **How "something above it takes the key" is told (5.12).**
   - A listener that acts on Escape now says so (`preventDefault`). The Search panel decides once the whole dispatch is over, and closes only on an Escape nobody took.
   - Escape's global `app:cancel` used to take every Escape, whether it closed anything or not. It now leaves the key alone when there was no dialog or menu to close (a shortcut's action may return `false`).
   - Handlers that acted without saying so now say so: the four style popups, the Mind Map's connection mode, Kanban's selection, a Task List section drag, the side toolbars' menus, the save-error popover, and the tag and emoji popup overlays.
   - Escape typed in a text field or an editor stays with the edit (it ends a title, or clears a search box) and doesn't close the panel.
   - **A side effect:** Kanban's Escape now clears its selection. Its handler ignored a key already taken, and `app:cancel` had always taken it.

**Also changed, outside the plan's wording**
- `shell:copy-text` joins the IPC contract: the channel union, the payload schema (100,000 characters; a 4,000-character link with a 500-character name), the contract types, and the ipc-parity gate's and its test's lists for the three text-menu channels.
- The test setup gives jsdom an inert `ResizeObserver` (the toolbar measures its room). The characterisation suite's Electron fake records clipboard writes (`clipboardWrites`).
- Test fixtures that build a workspace layout by hand gained `mindMapPanels`. Test shortcuts written `() => n++` now return nothing.

**Tests** (each new case was run against the Phase 4 tree, the Phase 4 commit's; see Checks)
- **Unit:**
  - New `textMenu.test.ts` (8): the menu's items for editable text, spelling, Insert / Edit Link, an embed's selection; the reply checked; the query's answer, a reply from another page or to another question ignored, the 300 ms bound and a closed page.
  - New `interfaceAroundViews.test.ts` (16):
    - Escape and the Search panel (closes, and the five things that keep it);
    - the sidebar's breakpoint, at the plan's widths and with a wider sidebar, and the push only while docked and open;
    - nested frames, paint order, and a torn-down drag putting nested frames back;
    - the panels per board, hydrated, saved and dropped;
    - links read back, refused note paths, the copy going to main with its result toasted, main's payload checks, and the Copy link items on one item and not on a selection;
    - the row styles.
  - `hotkeys.test.ts`: an action that found nothing to act on leaves the key unprevented. `boardSchemaProblems.test.ts`: "Copy all problems" goes through main. `workspace.test.ts`: the round trip carries `mindMapPanels`.
- **Component:**
  - New `nestedFramesDrag.test.ts` (3, the real frames dragged by their headers): the inner frame and tiles travel, and each frame lists the tiles inside it; one undo and redo; an overlapping frame stays.
  - New `toolbarAndTextMenu.test.ts` (4, the real toolbar and a real tile): the controls disabled until an editor has the focus and again after; the editor kept while the focus moves into the toolbar; the menu's answer (none, insert, edit); Insert Link opening the popup on the editor after it lost the focus.
  - `projectSettingsDialog.test.ts`: the General tab's tooltip wording.
- **Characterisation:** new `interfaceAroundViews.test.ts` (12, in the `characterisation-suite` gate's list):
  - Ctrl+W on a task title being typed;
  - Ctrl+Tab and Ctrl+Shift+Tab from a note;
  - Ctrl+Shift+F from quick add;
  - Escape after a click on the board;
  - Escape closing a menu, then ending a title edit, before the panel;
  - the Settings button and every tab's rule;
  - Current Board's reason in a Document tab;
  - the toolbar disabled and then enabled;
  - focus moving into either pane;
  - the minimap per board, after reopening;
  - Copy link to tile and to note, and a note link followed;
  - the push at 1,100, 1,366 and 1,280 px, and with the sidebar hidden.

  `errorStates.test.ts`: the menu label *Recreate note*.
- **E2E:**
  - New `interfaceAroundViews.e2e.ts` (4, the built app):
    - the text menu built by main (its native popup captured) and its Insert Link opening the popup;
    - Filo's own menu on a tab building no text menu;
    - at 1,100, 1,280 and 1,366 px the note clear of the sidebar, every formatting control on screen and the font box showing Arial Rounded MT, and More formatting at 1,100;
    - a link copied from the sidebar pasted into a note as `[River City](filo://note/River%20City.md)` and followed with Ctrl+click. That case uses the machine's real clipboard and puts back what it held.
  - `searchPanel.e2e.ts`: Escape closes the panel after a click outside it.

**Checks**
- `npm run ci:verify` on Windows: passed on the final code. 853 test files, 8,345 passed and 5 skipped (as before), 91/91 gates; its test step took 287 s.
  - The first run stopped at lint (an unneeded `svelte-ignore`, and an unused variable in the new E2E spec), fixed.
  - The next three each failed on real-disk tests in code this phase didn't touch, every one passing alone:
    - two runs while a game was running on the PC (the runs took about 410 s against the usual 290): five watcher and recovery-snapshot cases, then one recovery-snapshot case;
    - one on a quieter machine: the characterisation case "the Root Directory is cleared, and undo puts it back", whose tree read met the folder mid-move (3 of 3 alone).

    BL-09 now names them.
- E2E with `FILO_E2E_SCALE=1` on the final build: 44 passed (the 39 from before and the 5 new), 3.3 min.
  - An earlier full run, with the game running, took 7.9 min and missed three scale budgets (Kanban 300 open 1,111 ms, switch back 1,641 ms; Task List fields 1,473 ms; the 2,000-note folder's whole check 6,832 ms).
  - Two alternating runs of `scaleBudgets.e2e.ts` on the Phase 4 build and this one right after met every budget on both.
- **Bite checks** (the new tests on the Phase 4 tree, the Phase 4 commit's, in a detached worktree with `node_modules` junctioned, since removed):
  - **Unit and component:** every new case fails. `textMenu`, `interfaceAroundViews` (unit) and `toolbarAndTextMenu` fail to load (their modules are new). The 3 frame-drag cases, the new `hotkeys` case, the clipboard case in `boardSchemaProblems` and the Settings tooltip fail. The 36 that pass are the files' existing cases.
  - **Characterisation:** all 12 cases fail, each for the reason it tests:
    - the tab never closes;
    - Ctrl+Tab stays on "Two";
    - no Search panel from quick add;
    - Escape leaves the panel open (twice);
    - no Settings button (twice);
    - the toolbar enabled with no editor;
    - focus doesn't move the active pane;
    - the second Mind Map's minimap hidden too;
    - no Copy link item;
    - no push at 1,100 px.
  - **E2E** (`FILO_E2E_MAIN` on a build of the Phase 4 tree): the text menu case (no menu built), the width case (the note's text at 217 px, under the 240 px sidebar), the link case (no Copy link item) and the Search panel's Escape case all fail. The tab-menu case is a control.
  - **The plain-words gate:** with the four new words it failed on 13 messages in the source, before they were reworded.
- **Screenshots** (a throwaway Playwright script on a fresh vault, not kept in the repo):
  - The Phase 4 build at 1,100 px: the sidebar over the note ("kara working"), the size box gone and the font box blank.
  - This build at 1,100 px: the note's text at 337 px, clear of the sidebar, and every control on screen at 1,100, 1,280, 1,366, 1,440 and 1,600 px. At 1,100 px the More formatting popover holds line spacing, the indents and Clear Formatting. Kanban and the Mind Map at 1,100 px show the toolbar disabled.
- **Corpus check:** not run. Nothing in the editor's Markdown reading or writing changed: the text menu and the toolbar call the existing commands, and a pasted link goes through the existing rich paste.

**Pass test**
- Component tests: **met**, for 5.1, 5.5 and 5.6. The others are tested where they live: 5.2, 5.4, 5.7, 5.8, 5.10, 5.11 and 5.12 in the characterisation suite (the whole app), 5.3 there and in the E2E suite (only a real window has layout), 5.9 by its gate.
- The axe E2E scan is still clean: **met** (`a11y.e2e.ts`, in the 44, scans each view, the Raw view and its find bar).
- Screenshots at 1,100 and 1,366 px show nothing covered or cut off: **met** for the note, the toolbar, Kanban and the Mind Map (the E2E case checks the geometry at 1,100, 1,280 and 1,366 px). The Task List's Table of Contents still opens over the list at 1,100 px, as it did before this phase (BL-35).

**Found and fixed in this phase (BL-33, BL-34)**
- **BL-33: the formatting toolbar's font box was blank in a vault whose `app.json` names no font** (Impact 1/10, Hard 0/10; found by the screenshot check, and the Phase 4 build shows it too). An `app.json` without `globalFont` loads as an empty font, which means the stylesheet's default (Arial Rounded MT), but the toolbar showed the empty name, and no option matched it. The toolbar now reads an empty global font as the default. The E2E width case checks the box.
- **BL-34: "Copy all problems" on a board that couldn't load never reached the clipboard** (Impact 1/10, Hard 1/10; found while building 5.10). The permission policy denies the page's clipboard writes, so the copy failed and said *Couldn't copy the problems*. It now goes through main (`shell:copy-text`). `boardSchemaProblems.test.ts` checks it.

**Found in this phase, not fixed (BL-35)**
- **BL-35: below about 1,300 px a Task List's Table of Contents opens over the list** (Impact 2/10, Hard 2/10), covering the progress count and the rows' right ends. It can't be closed. The Phase 4 build does the same at these widths.

### Phase 6A outcome (2026-10-05)

**Status:** done, not committed (the owner decides when). Phase 6 was split at the owner's request: 6A (tasks 6.1 to 6.8, sync and recovery) here, 6B (6.9 to 6.18, notes and boards) in a later session. No decision from section 3 applied. Six deviations are listed below. The changes you will notice:
- a new **Settings → Recovery** tab lists every copy Filo keeps in `.filo/recovery`, with Open, Show in folder and Delete;
- the "Filo preserved N file snapshots … failed-load window" warning no longer comes back at every open;
- a Syncthing (or Dropbox, OneDrive) conflict copy of a note gets a notice naming the note it split from, with **Open the copy**;
- a rescue copy or old version dragged out of `.filo/recovery`, `.filo/trash` or `.stversions` onto a board is copied into the vault, so what you type in it is saved;
- a folder renamed in Explorer is followed once, not once more per file 30 s later.

One latent bug from Phase 3 turned up and was fixed here: BL-36 (end of this section).

**What changed**
- **6.1, Settings → Recovery and the open notice (C-03, KL #33).**
  - New tab **Recovery** (`components/settings/RecoverySettings.svelte`, `stores/recoveryCopies.svelte.ts`). It lists the copies by kind, each with what it is: **Kept versions**, **Rescue copies**, **Files that failed to load**, **Partly written files**. A row shows the name the copy came from (`Notes/Draft.md`, not `Notes__Draft.md`), when it was kept and its size.
  - **Open** opens the copy in the system's app for it (main, `recovery:open`, `.md` / `.json` / `.txt` only); with no such app it says so and shows the copy in its folder. **Show in folder**. **Delete** sends one copy to the Recycle Bin at once; **Delete all** (per kind) asks first. If the Recycle Bin refuses, one confirm asks "Delete permanently?", as Settings → Trash does. A copy's timestamped folder goes once it is empty.
  - Main reaches only copies inside `.filo/recovery/` (`main/services/recoveryCopies.ts`); any other path is refused (FORBIDDEN) before anything is touched.
  - The vault-open notice (`lib/vault/recoveryCopies.ts`, called from the recovery sequence in `vault.svelte.ts`) names only load-failure snapshots this open made that no other notice of the open named. Its text: *Filo couldn't load a file, so it kept a copy in .filo/recovery before anything could write over it: • Plan.board.json. Settings → Recovery lists every copy Filo keeps.*, with **Show in folder** and **Open Recovery**.
  - `openSettingsAt(tab)` (`lib/settings/settingsTabRequest.svelte.ts`) opens Settings on a tab, or switches an open dialog to it.
  - The Recovery tab's rule line: *Open, Show in folder and Delete act at once.*
- **6.2, files from hidden vault folders (C-01).**
  - A file dropped from a hidden folder of the vault (`.filo/recovery`, `.filo/trash`, `.stversions`, any folder whose name starts with a dot) counts as outside the vault and is copied in (`classifyDroppedFile`, `isInHiddenFolder` in `lib/vault/droppedFiles.ts`, shared with the file picker's rule).
  - Main's `vault:copy-file` copies such a file when the user chose it (an OS drop or a file dialog) and it lies in `.filo/recovery` or `.filo/trash`; the rest of `.filo/` is still refused (deviation 2).
  - `recovery:keep-unsaved` checks each item on its own: a name it refuses fails alone, and the others are written. A note shown from inside `.filo/` (a tile an older build linked there) is kept under a `_filo__…` name instead of failing every copy.
  - A write main refuses (FORBIDDEN) now reads *Filo didn't save (…) because the file is inside .filo, the folder Filo keeps for itself. Your changes are kept in Filo for now: copy the text into a note elsewhere in the vault to keep it.*, with no Retry, instead of "check disk space or file permissions".
- **6.3, a note's sync conflict copy (C-04).**
  - Live: the watcher announces a note's conflict copy that appears beside its note (`noteConflictNotices` in `main/services/syncConflictNotifier.ts`).
  - At open: `board:list-conflicts` lists notes' copies too (`scanSyncConflicts`, was `scanBoardConflicts`, in `main/vault/boardFileOps.ts`; the channel kept its name).
  - The notice: *Syncthing kept two versions of the note "Chapter.md": the other is Chapter.sync-conflict-20261004-120000-ABCDEFG.md. Filo shows Chapter.md and leaves the copy alone; open the copy to take what you need from it.*, with **Open the copy**, **Show in folder**, **Dismiss**. An attachment's copy (from a refused rename) says "the file" and has no Open the copy.
  - CLAUDE.md's line about the notice is now true, and says boards and notes.
- **6.4, a file renamed over another (C-05).** The watcher records which paths hold a file (`presence` in `fileWatcher.ts`: every event, Filo's own writes, moves and trash moves, and its walks fill in the rest). The correlator never pairs a missing file with a "present" path that already held one (`wasPresentBefore` in `renameCorrelation.ts`): another program renaming A over B is A gone and B changed. B's open view reloads A's text, or, with typing not yet saved, the usual Reload / Keep mine prompt appears and A's text stays on disk until it is answered. A case-only rename still pairs.
- **6.5, a change-buffer overflow (C-06).** An event with no file name arms one walk 1 s later (`OVERFLOW_RECONCILE_DELAY_MS`), so the burst that overflowed the buffer can finish first. Overflows meanwhile join it; one during a walk runs another walk after it.
- **6.6, folder moves followed once (C-10).**
  - After the renderer follows a folder another program moved, it tells main (`vault:followed-move`), and the watcher moves its walk records with the folder (`noteFollowedMove`), once the disk shows the old folder gone and the new one a folder.
  - A rename the watcher itself sends moves its walk records too (deviation 6).
- **6.7, Reload after a crash (C-09).** Reload first releases the vault in main (`releaseActiveVault` in `vault.ipc.ts`: the watcher, the registry, the approved copy sources), so the reloaded page can open any vault.
- **6.8, "Open last vault on launch" (C-11).** Home waits for the recent-vaults list as well as the preference before it chooses (`HomeScreen.svelte`).
- **New IPC:** `vault:followed-move`, `recovery:open`, `recovery:delete`, in the channel union, the payload schemas, the contracts and the ipc-security gate's envelope list. `recovery:list` entries carry `size`.
- **Gate.** `deletes-go-to-trash` allowed the word "permanent" only inside Settings → Trash's confirmed fallback (`offerPermanentDelete` in `trash.svelte.ts`). The Recovery tab has the same fallback, so its `offerPermanentDelete` is allowed too (`PERMANENT_DELETE_FALLBACKS` in `scripts/gates/writePath.mjs`). Bite check: "permanent" in the Recovery tab's own Delete all confirm fails the gate.
- **Docs.**
  - CLAUDE.md: the new modules and channels, the watcher, correlator, crash handler, copy, drop and conflict-notice lines, and the rescue copies' Settings → Recovery.
  - KNOWN_LIMITATIONS #33 (Settings → Recovery; the open notice) and #18 (notes' copies announced only for strong names).
  - The design doc: Settings → Recovery, the tab rule, a note's conflict copy and a rename over another file.
  - `docs/BACKLOG.md`: KL #33's row (Settings → Recovery with sizes) is taken and removed.

**Deviations from the plan**
1. **The open notice is a safety net now (6.1).** The plan said to list only new failed-load snapshots. Every snapshot Filo takes at open is already named by its own notice: the board-load notice names its copy, and the duplicate-board notice says the unloaded file's copy is in .filo/recovery. So the open notice names only a new snapshot no notice of that open named, which today never happens; the old warning that named every copy at every open is gone. The tab also shows each copy's size (the backlog item asked for it), and has **Delete all** per kind, since clearing many copies one at a time would be slow.
2. **Copying out of `.filo/` (6.2).** The plan's "copied in" needed main to allow it: `vault:copy-file` refused any source inside `.filo/`, so the copy would have failed with "File rejected by vault safety check". It now copies a file the user chose (an OS drop or a dialog, registered by the preload or main) from `.filo/recovery` or `.filo/trash` only. The same refusal broke Phase 3's picker for a file in `.filo/trash` (BL-36). And `recovery:keep-unsaved` keeps a `.filo/` note's rescue copy under a `_filo__…` name rather than only failing it alone, since a board an older build linked that way still exists.
3. **Strong names only for notes (6.3).** A Syncthing, Dropbox / Nextcloud or OneDrive name counts; Google Drive's ` (1)` and iCloud's ` 2` don't, since a book's `Chapter 2.md` sits beside `Chapter.md`. The notice offers **Open the copy**. KL #18 says so.
4. **The first option, held as a record of where files are (6.4).** The plan offered "don't pair a present path that was already a known file" or "a displaced note with unsaved work becomes a backed-up conflict". The second would leave an open, unedited B showing its old text (the pairing swallows B's change event), so the first was taken. "Known" needed its own record (`presence`): the walk's record is replaced by each walk before the events it found are paired, and the size and hash caches keep deleted files. The cost: A's tiles show as missing (relinkable), as for any delete, since its text now lives under B's name.
5. **The overflow walk waits 1 s (6.5)**, so one walk finds the whole burst; the plan said "at once".
6. **The watcher's own renames move their walk records (6.6).** A single file renamed in Explorer was paired at once, then reported again by the next walk (as a delete and a create, since its caches had moved). Each rename the watcher sends now moves its walk record, as Filo's own moves always did.

**Tests** (each new case was run against the Phase 5 commit, f083071; see Checks)
- **Unit:**
  - New `recoveryAndCopyIpc.test.ts` (11): copies out of `.filo/recovery` and `.filo/trash` only when chosen, never `.filo/app.json`; rescue copies item by item, a `.filo/` name kept as `_filo__…`; `recovery:open` (the system app, NO_APP, nothing outside `.filo/recovery`); `recovery:delete` (Recycle Bin, the emptied folder, refused then deleted for good, nothing deleted when one path is outside); `releaseActiveVault`.
  - New `watcherOverflowAndReplace.test.ts` (7, the watcher driven through its own `fs.watch` listener): the overflow walk; a rename over a file is a change and a delete; a rename to a free name is a move, not reported again; a name freed by a delete takes a move; a followed folder move not reported again, and the control without it; a followed move taken only while the disk agrees.
  - New `renameOntoExistingFile.test.ts` (5): the correlator with `wasPresentBefore`, across folders, a case-only rename on a case-sensitive disk, and without the probe.
  - New `recoveryCopiesNotice.test.ts` (6): timestamps, names, sizes, which snapshots the notice names, the notice silent with old copies, and its text and actions.
  - `droppedFiles.test.ts` (+2), `writeErrorToast.test.ts` (+1), `syncConflictNotices.test.ts` (+4), `boardLoaderConflictTieBreak.test.ts` (+1), `rendererCrashHandler.test.ts` (+2; Quit releases nothing).
- **Component:** `homeRecentVaults.test.ts` (+2: the list arriving after the preference; the preference off). `projectSettingsDialog.test.ts` (+2: an open dialog switches to the tab asked for; a new one opens on it, and on General the next time).
- **Characterisation:** new `syncAndRecovery.test.ts` (10, in the `characterisation-suite` gate's list; harness `harness/recovery.ts`):
  - a kept version and a rescue copy raise no notice at open, then or after reopening;
  - Settings → Recovery lists them by kind; Delete and Delete all send them to the Recycle Bin, and the emptied folder goes;
  - a board two files share an id with is named once, by its own notice, and nothing else comes back at the next open;
  - a rescue copy dragged onto a board is copied in and its typing saved; the same for a note from `.stversions`;
  - a note's conflict copy arriving beside it is named and opens; when the other version wins, the open note shows it; copies already there are named at open, and a numbered note isn't;
  - a note renamed over an open note with typing keeps both texts;
  - a folder renamed in Explorer is followed once, and the next walk reports nothing more.

  The suite's Electron fake now takes a file away when Filo sends it to the Recycle Bin (`recycled`), as a real one does. `interfaceAroundViews.test.ts` lists the Recovery tab's rule.
- **E2E:** `syncDeliveries.e2e.ts` gains "that conflict copy is named in a notice, which opens it".

**Checks**
- `npm run ci:verify` on Windows: passed on the final code. 858 test files, 8,409 passed and 5 skipped (as before), 91/91 gates; its test step took 295 s.
  - The first run had 4 failures. Three were in this phase's work, all fixed: the IPC envelope test keeps its own list of channels, which needed the three new ones; and two new watcher cases renamed files while the watcher's own first walk was still reading them (Windows refused with EPERM), so the test now waits for that walk.
  - The fourth was the Chromium spec "Enter beside a soft break: in a list item" (`editorCaretInChromium.test.ts`), in editor code this phase didn't touch. It passed alone (11 of 11) and in the next full run. BL-09 now names it.
- E2E with `FILO_E2E_SCALE=1` on the final build: 45 passed (the 44 from before and the new case), 3.5 min.
- **Bite checks** (the new tests on the Phase 5 commit, `f083071`, in a detached worktree with `node_modules` junctioned, since removed):
  - **Unit:** all 27 new cases fail, in 9 files (`recoveryCopiesNotice` fails to load, as its module is new). The 63 that pass are the files' existing cases and the controls: a move to a free name, a case-only rename, a rename without the probe, a name freed by a delete, the walk without a follow.
  - **Component:** the Home case fails (Home stays on Home); `projectSettingsDialog` fails to load (no `openSettingsAt`).
  - **Characterisation:** all 10 cases of `syncAndRecovery.test.ts` fail, each for the reason it tests: the old warning at open; no Recovery tab; two notices for the duplicate board; the dropped copy's edits refused (FORBIDDEN, "check disk space"); the `.stversions` copy written in place; no conflict notice (three cases); B's typing written over A's text with A's text gone; 12 renames reported by the walk after the folder move. `interfaceAroundViews.test.ts`'s rule list fails too (no Recovery tab).
  - **E2E** (`FILO_E2E_MAIN` on a build of `f083071`): the new case fails (no notice); the four cases before it pass.
  - One characterisation case first passed on the old code: it answered the prompt before the old bug wrote over A's text. It now waits 4 s with the question open, and fails there as the audit's repro did.
- **The audit's repros**, run on this code: C-01, C-04 (both cases) and C-05 pass. C-03's repro asserted the old warning on the first open as its starting point, which no longer appears; its real check (nothing at the next open) holds, and the characterisation case replaces it. The refuter's C-10 measurement: 0 renames from the walk after a 40-note folder rename (was 40).
- **Screenshots of the built app** (a throwaway Playwright tour on a fresh vault, not kept in the repo): the Syncthing notice at open and no recovery warning; Settings → Recovery at 1,280 and 1,100 px (kinds, names as paths, dates, sizes, buttons); a Delete removing its row; the Delete all confirm. The tour's Delete used this PC's real Recycle Bin: a 50-byte `Chapter.md` from a temp vault is in it.
- **Corpus check:** not run. Nothing in the editor or the Markdown writer changed.

**Pass test (6A)**
- The finder repros for C-01, C-03, C-04 and C-05 pass: **met** for C-01, C-04 and C-05; for C-03, met for what it checks (no warning at the next open), with its starting assertion (the old warning) gone by design. All four are now permanent tests.
- `syncDeliveries.e2e.ts` gains a note conflict-copy case: **met**.
- `ci:verify` on Windows, and the full E2E suite with scale: **met**.

**Found and fixed in this phase (BL-36)**
- **BL-36: a file picked from Filo's trash for a card cover, a File tile or a background was refused** (Impact 1/10, Hard 1/10; found while building 6.2). Phase 3 (E-14) links a picked file that is in the vault and copies one from a hidden folder. But main's `vault:copy-file` refused any source inside `.filo/`, so a pick from `.filo/trash` failed with "File rejected by vault safety check". Phase 3's unit test mocked the copy, so it never met main. Fixed by 6.2's change in main; `recoveryAndCopyIpc.test.ts` ("copies a trashed note the user picked out of .filo/trash") fails without it.

**Left for 6B** (tasks 6.9 to 6.18, its pass test above): the Raw view's tab switch with a conflict (A-07), Convert to UTF-8's reload (A-04), the board items B-01 to B-09 and BL-02. The finder repros for B-01 and B-02 are in the audit session's scratchpad (`…\a643b672-…\scratchpad\repros\finderB`). Nothing in 6A changed them.

### Phase 6B outcome (2026-10-05)

**Status:** done, not committed (the owner decides when). Tasks 6.9 to 6.18 are in, BL-02 with them. No decision from section 3 applied. Nine deviations are listed below. Two bugs turned up while fixing these and were fixed here: BL-37 and BL-38 (end of this section). The changes you will notice:
- switching to another tab from a Raw view whose text can't be saved now asks, as closing the tab does; and text typed there in the last moments before a switch is no longer lost (BL-37);
- ticking a task, setting a card's date or priority, or retitling a note no longer rewrites the board's file, and showing a Kanban board or Task List with no saved view writes nothing;
- undoing a style change or a saved view no longer brings back a font size "Use Default Font Sizes" cleared, or an old tag name a vault-wide rename replaced;
- a board from an older Filo is called that, with its notes safe and a way on; a board file holding no board is called broken.

**What changed**
- **6.9, switching away from a Raw view (A-07).**
  - New `lib/notes/rawViewLeave.ts`. When the active pane is about to show another tab and the Document tab it shows has text typed in its Raw view that isn't on disk, the pane first saves it (`mayLeaveRawView`). If it can't be saved (the note changed elsewhere, or the write failed), a confirm asks: *Raw edits not saved. Your raw edits to "Plan.md" aren't saved: the note changed somewhere else, or the write failed. Switch anyway keeps a copy of them in .filo/recovery/. Cancel stays on the tab so you can choose which version to keep.* **Cancel** makes that tab active again, with the Raw view and its banner as they were; **Switch anyway** shows the other tab, and the Raw view's teardown keeps the rescue copy, as Close anyway does.
  - The check sits where the pane takes its tab (`AppShell.svelte`, the pane-tree effect), so every way of switching goes through it: a tab click, Ctrl+Tab, opening a note or board from the sidebar, the Board Browser. A tab already shown in another pane only makes that pane active and unmounts nothing, so it asks nothing.
  - `NoteRawView.svelte` keeps the note's path it was mounted with (renames move it), and its saves and rescue copies go by that, not by the `path` prop (BL-37).
- **6.10, Convert to UTF-8 (A-04).**
  - `holdReadOnlyWhileConverting` (`lib/vault/nonUtf8Paths.svelte.ts`) keeps a note read-only, as a non-UTF-8 note, until the hold is released; it follows a rename and each conversion releases only its own hold. `convertToUtf8.ts` holds the note from before the conversion until its views have the converted text.
  - `noteStore.reload` sends a note with an unsaved or queued body, or an open conflict, through the same check as any change on disk (`onDiskChanged`): a new body there meets the typed one as a conflict and is never written under. A note with nothing unsaved is read again as before.
- **6.11, link, embed and timer tiles stored once (B-01).**
  - The Mind Map writer (`core/boardTileOps/mindmap.ts`) puts such a tile only in `board.inlineTiles`, and drops a def or placement with the same id (the board schema refuses a tile that is both placed and inline).
  - `isStaleInlineCopy` (`lib/boards/tileDefBuilder.ts`): a def beside an inline tile is a stale copy. The loader drops it in memory (nothing is written for it, no recovery copy; the file loses it at the board's next real save). The tag readers (`iterateBoardOnlyTiles`: tag delete, rename, their Undo, the orphan count, "tag in use") and search skip it.
  - Two readers needed the stale copy: the undo of deleting such a tile put it back in its frames and groups only when it had a def (now: or an inline tile), and "Use Default Font Sizes for all Existing Items" cleared sizes only on the stale copy (BL-38).
- **6.12, a board moved during a full save (B-02).**
  - A full save holds each waiting board's write as it was when the save began. When the board's file (or a folder above it) moves meanwhile, a rename sweep in the board scheduler replaces that copy with a new write of the board (`replaceCapturesUnder` in `writeScheduler.ts`), which reads the board's new path and fires at once.
  - A write that failed at the old path (sent just before a folder rename) is kept for Retry as before; once the board saves at its new path, the failure left at the old path is cleared too (`onEarlierFailureHealed`), so no "couldn't save" stays for the session.
  - A write already sent to main when the move happens can still land at the old path; KNOWN_LIMITATIONS #15 now says so (deviation 4).
- **6.13, the drift answer and a rename (B-03).** `resolveBoardDrift` acts on the board where its hold is now (holds follow renames): Reload reads the renamed file, Keep local backs up and re-fires it there. A hold released meanwhile (the board left the cache) leaves nothing to do.
- **6.14, needless board writes (B-04, BL-02).**
  - A command says whether it changes its board's file (`changesBoardFile()`, `commands/Command.ts`). The history (`markBoardOf` in `history.svelte.ts`) arms a board write for a step only when it does, on execute, undo, redo, rollback and push. Steps that change only notes say no: card and task fields, line spacing, the Document tab's tags row, tile and note tags, titles, Replace All, and the file renames (their follow-up marks the boards whose paths it rewrites). A batch writes its board when any child changes it. Board parts of a step still go through the cache writers, which mark their board themselves.
  - `applyDeltaChecked` and `NoteFieldCommand` no longer mark a board dirty. A title edit whose formatting didn't change no longer touches the tile on the board.
  - BL-02: a Kanban board or a Task List with no `lastView` counts the view it shows with none as saved (`KANBAN_DEFAULT_VIEW`, `TASK_LIST_DEFAULT_VIEW` in `lastViewFlush.ts`, which the hydrate code shares), so nothing is written until the sort or a filter changes.
- **6.15, the Global Defaults' frame image (B-05).** New `stores/globalDefaultImages.ts`. A rename of the image or a folder above it (in Filo, by another program, or replayed after a crash) rewrites `mindmap.frame.backgroundImage` and saves `defaults.json`. A delete that takes the file clears it inside the delete's undo step (`CascadeDeleteCommand`): Undo puts it back unless another image was picked meanwhile; redo clears it again; a restore beside a file that took the old name follows the restored copy.
- **6.16, BoardRouter (B-07).** No default board is made for a tab whose board isn't in the cache or the project. The pane says so: *"Plans" isn't open any more. It may have been deleted. Nothing was saved in its place.*, with **Close tab**. The router re-runs only when the board comes or goes.
- **6.17, per-key undo (B-09).** New `commands/keyDelta.ts`: a step on a flat record as the keys it set and removed, applied to the record as it stands.
  - Style steps: a tile (`UpdateTileStyleCommand`), a frame, a Kanban card and column, a task and a section (`styleCommands.ts`), and a connection's fields and label keys (`UpdateConnectionCommand`).
  - Saved views (`UpdateSavedViewsCommand`): the views a step added (with their place), the ones it removed, and the keys it changed in the rest.
  - The element styles' live readers moved into `styleCommands.ts`, and the Style popup's targets (`elementStyleTargets.ts`) use them.
- **6.18, boards Filo can't open (B-06).**
  - An older board's message: *This board was made by an older Filo (board format 7), which this version can't open. The file was left unchanged, and its notes are safe: each is a .md file of its own. Make a new board and add them to it.* Its notice adds only *A copy is in .filo/recovery.*, without "fix it in a text editor".
  - `boardShapeProblem` (`boardLoader.ts`): a file that is one quoted text (a double-encoded board), a list, or no object, or whose `version` is text or not a whole number, is refused as broken: *a value in it isn't one Filo understands (the whole file is one quoted text, not a board)*.
  - The kept tab's hint now reads *Nothing in the file was changed. A file still syncing, or fixed in a text editor, opens with Retry.*
- **Docs.**
  - CLAUDE.md: the new modules, the writers, BoardRouter, the Raw view, and two undo rules (note-only steps write no board file; style and saved-view steps keep the keys they changed); the board-format gotcha's notice wording.
  - KNOWN_LIMITATIONS #29 (an older or broken board's notice; nothing is written by showing a board or by a note-only change), #30 (switching tabs asks) and #15 (a write already sent when a board moves).
  - The design doc: the Raw view's switch, and a board with no saved view.
  - `docs/BACKLOG.md`: BL-02 is taken and removed; BL-37 and BL-38 are noted as found and fixed.

**Deviations from the plan**
1. **The switch also saves, and a root cause was fixed (6.9).** The plan said to ask, as close does. The switch saves the Raw text first (as close does) and asks only when that fails. Building the bite test showed that switching away lost text the view could still have saved (BL-37): the view's teardown read its `path` prop after the pane had already moved to the next tab. So the view now keeps its own path, which protects any other way a pane can drop it (the undo of a step on another board brings that board's tab into the pane directly).
2. **A hold, not a reorder (6.10).** "Unfreeze only after its reload" could not be done by moving one line: the vault index's own read of the converted file reports UTF-8 and unfroze the editors before the note's reload. A read-only hold covers the whole conversion. The re-read also goes through the disk-change check when a conflict is already open, not only with a queued body.
3. **The load drops a stale copy; the test helper needed nothing (6.11).** Besides readers skipping it, the loader drops a stale copy in memory, so the board's next save leaves it out. The plan said to fix the test helper (`seedBoard.ts`), which seeded boards differently from the live writer: it already seeded the single copy the writer now writes, so only the writer changed. Two readers had relied on the second copy (above); one of them was BL-38.
4. **Written at once, and a sent write remains (6.12).** The replacement write fires at once rather than inside the full save that held the copy (that save doesn't wait for it; the next save and quit's settle loop do). A write already sent to main can't be recalled: it is KNOWN_LIMITATIONS #15's gap, which now names it.
5. **A stale prompt after a rename (6.13).** While fixing the answer, the in-flight prompt registry turned out to remove a settled prompt only under the key it was asked under. After a rename the prompt sat under the new key, so the renamed board's next drift got the old answer at once, without asking. Settled prompts and resolutions are now removed wherever a rename moved them.
6. **Steps say whether they change the board (6.14).** The audit offered "don't mark the board dirty for a note-only change" or "skip a board write whose bytes are unchanged". The first was taken: comparing bytes would need each board's canonical bytes at open, or a read before its first write. The Task List's `lastView` had BL-02's problem too, and is fixed the same way.
7. **External deletes (6.15).** An image deleted by another program while no tile shows it is not cleared from the defaults: the same rule as a frame's own background, which only the "Remove tiles" cascade clears.
8. **Every style popup, connections included (6.17).** The plan named the saved-views and style steps. Every style popup's step (tile, frame, card, column, task, section) now keeps its keys, and so does a connection's update, whose label size "Use Default Font Sizes" also clears.
9. **A missing version stays "older" (6.18).** A file with no `version` is still read as an older board (the oldest boards had none); only a version that is text or not a whole number, and a file holding no board, are called broken.

**Tests** (each new case was run against the Phase 6A commit, 0ea3648; see Checks)
- **Unit:**
  - New `boardMovedDuringFullSave.test.ts` (3, from the audit's B-02 repro): a file moved to another folder during a full save is saved at its new path; a renamed folder likewise, with nothing left failed; a write sent before a folder rename fails there and the next save clears that mark.
  - New `inlineTileStoredOnce.test.ts` (9, from the audit's B-01 repro): stored once; tag delete, rename and "in use"; the orphan count; search; a stale copy in a cache skipped, with the tag delete's Undo putting back what it took; a board loaded with one drops it and writes nothing.
  - New `convertToUtf8Reload.test.ts` (4, from the audit's A-04 repro): a forced reload with a queued body is a conflict and writes nothing; a clean one takes the file; Convert to UTF-8 keeps the note read-only through every read that loads the converted text; the hold follows a rename.
  - New `styleAndSavedViewUndoPerKey.test.ts` (7): tile, frame, connection label and card styles; saved views saved, deleted and overwritten.
  - New `noteOnlyStepsLeaveBoardFile.test.ts` (7): a note-only step on execute, undo, redo and push; a board step still arms; batches; a plain title edit; the Kanban and Task List default views.
  - `boardDriftHold.test.ts` (+2: Keep local and Reload after a rename, and the renamed board asked again), `boardLoader.test.ts` (+1, one changed: a string payload and text versions are broken), `boardFormatMigration.test.ts`, `errorStateMessages.test.ts`, `boardFileEncodingRoundTrip.test.ts` (the new wording and kinds), `boardCacheTiles.test.ts` (an inline tile has no def), `commandMarkDirtyOriginatingBoard.test.ts` (the originating-board rule now pinned with a column style step; a card field edit writes no board), `replaceAllCommand.test.ts` (its stand-in step is a `fakeCommand`).
- **Component:** new `boardRouterMissingBoard.test.ts` (no board made or saved, the empty state, Close tab) and `noteRawViewTeardownPath.test.ts` (2: the teardown save goes to the view's own note when its prop already names nothing, or another note). `boardRouterLoading.test.ts` seeds its board in the cache, as any board with a tab is.
- **Characterisation:** new `notesAndBoards.test.ts` (6, in the `characterisation-suite` gate's list; harness `harness/notesAndBoards.ts`): the switch question (Cancel stays with the banner, Switch anyway keeps a copy); a switch saving the Raw text; a ticked task and a card's date saving no board file; boards with no saved view staying byte-identical, then a new sort saved; the Global Defaults' frame image through a rename, a delete and Undo; the older-board and broken-board notices.
- **E2E:** `noBytesByLooking.e2e.ts` gains a hand-written Kanban board and Task List with no saved view, opened and shown before the quit.

**Checks**
- `npm run ci:verify` on Windows: passed on the final code. 866 test files, 8,448 passed and 5 skipped (as before), 91/91 gates; its test step took 263 s.
  - The first run had one failure, in this phase's new connection case: it ran while that command was being edited, on the version cached before the edit. It passed alone and in the full run that followed.
- E2E with `FILO_E2E_SCALE=1` on the final build: 45 passed (as before; `noBytesByLooking.e2e.ts` gained boards, not a case), 3.5 min.
- **Bite checks** (the new tests on the Phase 6A commit, `0ea3648`, in a detached worktree with `node_modules` junctioned, since removed):
  - **Unit:** all 39 new or changed cases fail, in 12 files, each for what it tests; the controls pass (a board step still arms its write, a clean reload takes the file, a re-added tile with an explicit board).
  - **Component:** the BoardRouter case fails (a default board is made and saved); both teardown cases fail (one saves to `""`, the other is refused by `Other.md`'s hash, and `Plan.md` keeps its old text).
  - **Characterisation:** all 6 cases fail, each for its reason: no switch question; the switch loses the Raw text; 2 board saves for a tick and a date; the hand-written boards rewritten; the frame image left at the old name; the old notice wording.
  - **E2E** (`FILO_E2E_MAIN` on a build of `0ea3648`): `noBytesByLooking.e2e.ts` fails, naming both hand-written boards as changed.
  - **BL-37 isolated:** on `0ea3648` with only the new `NoteRawView.svelte`, the case "saves text that can be saved" passes (its old code logged the teardown's path as `""`).
- **The audit's repros**, run unchanged on this code: B-02's two cases pass; B-01's seven behaviour cases pass, and its diagnostic case, which asserts the second copy's stale tags, now finds no copy; A-04's case passes.
- **Corpus check:** not run. Nothing in the editor or the Markdown writer changed.

**Pass test (6B)**
- The finder repros for B-01 and B-02 pass: **met** (B-01's diagnostic case shows the copy is gone). Both are now permanent tests.
- `ci:verify` on Windows, and the full E2E suite with scale: **met**.

**Found and fixed in this phase (BL-37, BL-38)**
- **BL-37: switching tabs away from a Raw view could lose what was typed there** (Impact 3/10, Hard 1/10; found by 6.9's bite test). The Raw view saves 1.5 s after typing stops. A switch to another tab inside that pause, to a note not open yet (opening one from the sidebar, say), tore the view down after the pane had moved on: its `path` prop then named the next tab's note, which hadn't loaded, so it read `""`. The teardown save failed, the rescue copy failed with it, and the text was gone without a word; with a note already open, the save was refused by that note's hash and the copy filed under its name. Fixed by 6.9 (the switch saves first) and in `NoteRawView.svelte` (the view keeps the path it was mounted with). Tests: `noteRawViewTeardownPath.test.ts`, and the characterisation case "saves text that can be saved, and asks nothing".
- **BL-38: "Use Default Font Sizes for all Existing Items" skipped a Mind Map's link, embed and timer tiles** (Impact 1/10, Hard 1/10; found by 6.11). It cleared sizes on the defs only, so these tiles were reached only through their stale second copy (B-01), which nothing shows: the tiles kept their sizes. It now clears the inline tiles' styles too (`applyDefaultsToAll.ts`).

### Phase 7 outcome (2026-10-06)

**Status:** done, not committed (the owner decides when). Tasks 7.1 to 7.6 are in. No decision from section 3 applied. Six deviations are listed below. BL-04, BL-05 and BL-10 are taken and fixed; `legacy-8` is closed; B-08's file fields wait for the first board-format step as BL-39. The changes you will notice:
- a search such as `tag:draft C:\notes` searches for `C:\notes` (the backslash used to be dropped);
- a Replace that finds the note changed since the search (the "Replace skipped" warning) now stays on that match, read again, so the next Replace tries it on the new text; it no longer moves on, and it leaves no undo step;
- a note, card, task or board named from a long title in Chinese, Japanese or emoji gets a file name that a phone the vault syncs to can hold; a name typed in the sidebar or for a board that is too long for Windows or a phone is refused inline;
- if a new Mind Map tile's note can't be created, the tile is taken off the board again and the message says so ("…so the tile wasn't added"), instead of a tile pointing at nothing;
- Ctrl+G with fewer than two tiles selected says "Select 2+ tiles to group", as the side toolbar's Group always did (it did nothing before).

Nothing changes in normal use for the two security fixes (7.1, 7.2): both holes needed hostile code in Filo's own window.

**What changed**
- **7.1, the vault boundary on disk (C-07, `legacy-8`).**
  - `assertNotInFiloDir` (`main/utils/pathSecurity.ts`) now takes the vault root and checks the path twice: as written, and as the disk names it (`onDiskRelative`: every existing folder by its long name, a junction followed, from the root's own canonical spelling). On a volume that keeps 8.3 short names, `.filo` is also `FILO~1`; `FILO~1/app.json` is now `.filo/app.json` to the guard, and so is a path through a junction inside the vault that leads into `.filo`. Every caller passes its vault root (delete, rename, create, write, folder, copy, media read and save, encoding, snapshot, followed move, and the `filo://` media resolver).
  - `vault:trash-move` had its own check on the path as written; it uses `namesFiloDir`, the same two-spelling test.
  - `vault:copy-file` checks its destination inside the vault, on disk, before it creates or writes anything (`assertWithinVault` on the folder and name), so a folder in the vault that is a junction to elsewhere is refused. The check after the copy came too late.
  - A source inside the vault as written is approved only when it is inside on disk too (`isWithinVaultOnDisk` in `approvedSources.ts`): `vault/out/secret.txt` through a junction `out` is no longer read in unless the user chose it (a drop or the file dialog). A path outside the vault as written is still never touched on disk before approval (a UNC path would reach the network). The comment that said `lstat` stops junction escapes is corrected.
  - Gate `filo-read-guard` now also fails when `assertNotInFiloDir` stops checking the on-disk spelling, or `vault:trash-move` stops using `namesFiloDir` (bite-checked both ways).
- **7.2, the link-preview fetch (C-08).**
  - New `main/services/publicHttp.ts`: `getPublic(url, …)`, a GET on Node's `http` / `https`. Each hop's socket resolves its host through `checkedLookup`, which refuses the name if any address it answers is private, loopback or link-local, so the socket connects only to an address that was checked; the address the socket actually connected to is checked again before the request is sent (an address literal skips the lookup) and once more when the response comes. Every redirect is a new request through the same checks; at most 5.
  - `link:fetch-metadata` (`media.ipc.ts`) uses it. The old path resolved the name to check it, then let `fetch` resolve it again, so a name answering a public address first and a private one second (DNS rebinding) was fetched. The separate pre-check is gone from the fetch: the connection's own lookup is the check.
  - The body is decoded from gzip, deflate or brotli, as `fetch` did, with the 512 KB cap counted on the decoded bytes. The 8 s limit now covers reading the body too (it used to end before the body was read).
  - `media:open-external` keeps its DNS check, which can only be best-effort (the browser resolves the name again itself); its comment no longer claims it catches rebinding.
- **7.3, long names (A-S2).**
  - `shared/fileNames.ts`: Windows allows 255 UTF-16 units in a name and Android 255 UTF-8 bytes. A name's UTF-8 length is never shorter than its UTF-16 length, so one cap in UTF-8 bytes (`nameTooLong`, 255) covers both. A name Filo derives (`safeFileName`: notes from titles, cards, tasks, folders, fonts) is cut to 200 bytes between characters as shown (grapheme clusters, so an emoji family is never split): 200 English letters, 66 Chinese characters, 50 emoji. A title of 128 emoji passed the old 200-character cut whole: 256 UTF-16 units before `.md`, more than Windows takes.
  - `fileNameProblem` (sidebar rename) refuses a name over 255 bytes; `boardNameProblem` counts the whole file name, `.board.json` included (a 250-character board name used to pass and then fail on disk).
  - Main's `assertSafeFilename` refuses a new name over 255 bytes (`forCreation`); an existing longer name stays reachable. A file copied in whose name is too long is shortened, its extension kept, instead of refused (`fittedCopyName` in `vault/fileOps.ts`).
  - A failed create: a new Mind Map tile is put on the board at once and its note created after. When the create fails, `seedTextFileForNewTile` reports it and resolves false; `BoardTileOps.addTile` and `persistAddTile` pass that on, and the tile comes off the board (and the spatial index) again; `AddTileCommand` takes its own step off the history (`historyStore.forget`). Kanban cards and Task List tasks already created the note first, so they never had the problem.
- **7.4, dead and duplicated code (E-28, B-08).**
  - Removed from `style.css`: the unused z-index tokens `--z-canvas-background`, `--z-tile-dragging` and `--z-tab-bar`, and the unused keyframes `pulse`, `radar-pulse` and the global `pulse-red` (the Audio tile uses its own).
  - Group / Ungroup: Ctrl+G (`AppShell.svelte`) and the side toolbar's Arrange menu (`SideToolbar.svelte`) each had a copy; both call `toggleGroupSelection` (`lib/mindmap/selectionActions.ts`) now. Select All: the canvas menu's copy uses `selectableTileIds`, as Ctrl+A did.
  - B-08: the project-level copy of every board's connections and frames (`project.connections` / `project.frames`) was written on every connection, frame and tile change and read by nothing; it is gone (`ProjectSchema`, `updateProjectConnectionsFrames` and its nine callers, `loadAllBoards`' return, the vault open, board discovery), with the comments that said the live stores read it. A new Mind Map no longer writes `board.viewport`. The schema comments that called the id lists a render order, and pointed at `tiles.json` / `project.json`, are corrected.
- **7.5, docs.**
  - The design doc: the tag Undo toast stays until dismissed or replaced (not 15 s) and is listed with the toasts that stay; the Kanban side toolbar's place is kept per board in `workspace.json`; the Tags Browser neither fades tiles nor lists body `#tags`; the Animations section describes the tile highlight that exists instead of a search pulse and a radar pulse that don't; no tile copy and paste; Kanban's Add card adds at the bottom; a Document tab makes no board file.
  - `frames.svelte.ts`: `syncTileMembership` adds a tile to every frame that holds it, not only the innermost. KNOWN_LIMITATIONS #22: the name limits. CLAUDE.md: the new module, the guard, the copy and source checks, the fetch, the name cap, the add's result, the shared selection helpers, `dispose` and the test helper.
- **7.6, backlog quick wins.**
  - BL-04 (`queryParser.ts`): a backslash is an escape only before a colon inside an operator value (`status:in\:progress`); every other backslash is text, quoted or not.
  - BL-05 (`replaceAllCommand.ts`): `ReplaceAllCommand.replacedNothing()`; a single Replace whose note had changed takes its step off the history, reads the results again and stays on the match.
  - BL-10: `Scheduler.dispose()` cancels the scheduler's timers and unregisters its armed-path check from `writeStateTracking`. The 15 test files that make their own scheduler get it from `src/tests/helpers/testSchedulers.ts`, which retires them after each test.
- **Docs and backlog.** `docs/BACKLOG.md`: BL-04, BL-05 and BL-10 removed, `legacy-8` closed (and in the Audit-22 report), BL-39 added. `notes-2` is left for Phase 8, as planned.

**Deviations from the plan**
1. **More of main goes through the guard, and a gate pins it (7.1).** Besides the 8.3 name, a junction inside the vault into `.filo` is caught by the same check. `vault:trash-move` and the `filo://` media resolver had their own lexical checks or calls and were brought in. The plan didn't ask for a gate; one check was added to `filo-read-guard` so the second spelling can't drop out unnoticed. A file the user chose through a junction (dropped from Explorer) still copies in: the approval is the user's choice, as for any outside file.
2. **Filo's own fetch (7.2).** "Validate the connected address on every hop" can't be done with `fetch`, which resolves names itself and doesn't say where it connected. So the fetch is now Node's `http` / `https` with a checking `lookup` (no new dependency). The separate DNS pre-check is gone from it, the body is decoded by hand (gzip, deflate, brotli), and the time limit now covers the body. No finder repro existed for C-08; the test is new (`publicHttpConnection.test.ts`, two local servers, one counted as public and one as private).
3. **One cap, in bytes; copies shortened (7.3).** The plan named two limits; capping UTF-8 bytes covers both. Derived names are cut by bytes, between characters as shown. A board name now counts its `.board.json`, which it didn't. A file copied in with a name too long is shortened rather than refused (the plan didn't mention copies). "No broken tile" needed only the Mind Map path, and its undo step goes too.
4. **The code now; the files' fields with the first format step (7.4).** E-28's "`:hover` rule that can't match" wasn't found: svelte-check reports no unused selector, and every global `:hover` rule's class is set somewhere. Nothing was removed for it. Of B-08, the in-memory copy and the new boards' `viewport` went now (no format change needed); the fields already in board files stay until the first board-format step, as the plan said (BL-39 describes the step). The two shared helpers change one thing: Ctrl+G with fewer than two tiles now says so.
5. **Most docs were already right (7.5).** Earlier phases had fixed CLAUDE.md's conflict-notice line (6A), KL #29 and #30 (1 and 6B), the VS Code comment in `AppShell.svelte` (5), the `FileTile.svelte` comments (3), the snapshot warning's "once" (6A) and the Help text (3 and 5); each was checked against the code. Left were the design-doc list, `frames.svelte.ts` and KL #22 (whose name limit was out of date).
6. **BL-05 drops the step; BL-10 by a helper (7.6).** A skipped single Replace changed nothing, so its undo step goes too (the rule for a change a note can't take). BL-10's `dispose()` is reached through a test helper rather than an `afterEach` written into each file by hand.

**Tests** (each new case was run against the Phase 6B code, the snapshot `refs/snapshots/phase6b`; see Checks)
- **Unit:**
  - New `vaultBoundaryOnDiskSpelling.test.ts` (17, from the finder's `zzA28C_filo83` and `zzA28C_copyJunction`): `.filo` reached by its 8.3 name and by a junction (delete, overwrite, create, a note moved into it, trash, `filo://`); the 8.3 cases skip where the volume keeps no short names (Linux CI); ordinary spellings (a folder named like a short name) still work; `vault:copy-file` never writes out through a junction destination, never reads in through a junction source, copies the same file when the user chose it, and copies an ordinary file.
  - New `publicHttpConnection.test.ts` (10): a private answer never connected to; one private answer among public ones refuses both; a redirect checked at its own hop; an address literal checked on connect; a public page through a redirect, gzip decoded; the body cap; too many redirects; the handler refusing a private name and a redirect to one, and returning a public page's title.
  - New `newTileNoteNotCreated.test.ts` (2): a failed create takes the tile off, leaves no undo step and says so; a created note keeps the tile and its step.
  - `fileNameRules.test.ts` (+5, one changed: the cut is by bytes), `copyFileToVaultReservedNames.test.ts` (+1, Windows only: Linux can't hold the source name), `seedTextFileForNewTile.test.ts` (+1, one changed: false on a failed new note), `queryParser.test.ts` (+2), `writeScheduler.test.ts` (+1: `dispose` lets go of an armed path).
  - Changed to fit: `vaultIpcFiloGuard.test.ts` and `machineSentinelMain.test.ts` (the guard takes a root); `linkFetchMetadataSanitize.test.ts` (it stubbed the global `fetch`; it now stands in for `getPublic`); `boardLoader.test.ts`, `boardLoaderConflictTieBreak.test.ts`, `schema.test.ts` and `zodDefaultsSnapshot.test.ts` (they pinned the project copy of connections and frames: the loader tests now read each board's own cache entry, the schema tests that the copy is gone); `boardCacheTiles.test.ts` (its path-stamp cases had no note create, so their tile now came off: the create succeeds there); `boardTilesInvalidTile.test.ts` (its spies resolve the add's `true`); and the 15 files that make their own schedulers (the helper).
- **Component:** `searchReplaceShowsNextMatch.test.ts` (+1: a skipped Replace stays on its match, leaves no step, and the next Replace changes it).

**Checks**
- `npm run ci:verify` on Windows: passed on the final code. 869 test files, 8,488 passed and 5 skipped (as before), 91/91 gates; its test step took 262 s, the whole run 335 s.
  - The first run had 8 failures. Seven were this phase's: five tests pinned the project copy of connections and frames this phase removed, and `boardCacheTiles.test.ts`'s path-stamp cases had no note create, so the new rule took their tile off. All fixed (the tests now read each board's own cache entry, and give the stamp cases a create).
  - The eighth, and the only failure of the second run, was the Chromium caret spec (`editorCaretInChromium.test.ts`): "ArrowDown and ArrowUp keep the column", then "Home on the second line, then Enter: the same", each a caret wait that timed out while the unit suite's workers ran beside it. Phase 7 changed no editor code. The browser project alone passed twice (178 of 178), on a quiet machine (8% CPU), and the third full run passed every test. BL-09 already names this spec.
  - The third run's tests all passed (8,488 passed, 5 skipped); the test type-check gate failed on two spies in `boardTilesInvalidTile.test.ts` that resolved `undefined` where the add now resolves a boolean. Fixed.
- E2E with `FILO_E2E_SCALE=1` on the built app: 45 passed (as before; this phase added no E2E case), 3.3 min.
- **Bite checks** (the new tests on the Phase 6B code, the snapshot `refs/snapshots/phase6b`, in a detached worktree with `node_modules` junctioned, since removed):
  - **Unit:** in eight files, all 30 new or changed cases fail, each for what it tests; the 66 that pass are the files' existing cases and the controls (ordinary spellings, a chosen file through a junction, an ordinary copy, a created note keeping its tile). `publicHttpConnection.test.ts` fails to load (its module is new). In `writeScheduler.test.ts` every case fails, because the old scheduler has no `dispose` for the helper to call; the `dispose` case is the one that tests it.
  - **Component:** the skipped-Replace case fails: the old panel moves on to `b.md` (BL-05).
  - Two cases first passed on the old code for another reason, and were changed to test their own point: renaming a note over `.filo/app.json` is refused anyway (no rename overwrites), so the case moves a note into `.filo` instead; and an outside edit before the match left the old panel on it by chance, so the edit now comes after the match.
- **The audit's repros** (`zzA28C_filo83`, `zzA28C_copyJunction`), unchanged: 4 of 4 pass on this code and 4 of 4 fail on the Phase 6B code. Both are now permanent tests (`vaultBoundaryOnDiskSpelling.test.ts`).
- **Gate bite check:** with the on-disk spelling taken out of `assertNotInFiloDir`, and with `vault:trash-move` back on its own check, `filo-read-guard` fails, naming each; restored, it passes.
- **Not checked:** the link preview was not fetched from a real website (no network call was made); its code is exercised against two local servers in the unit test, under Node 24, the Node in Electron 44. No built-app tour: the visible changes are a toast and messages, and the tests cover them.
- **Corpus check:** not run. Nothing in the editor or the Markdown writer changed.

**Pass test (7)**
- `ci:verify`: **met** (the final run).
- The two security cases have unit tests (the finder's `zzA28C_filo83` and `zzA28C_copyJunction`): **met**, in `vaultBoundaryOnDiskSpelling.test.ts`, with a junction into `.filo` beside the 8.3 name and controls for what must still work.

**Found while doing this phase**
- Within the tasks, fixed here: a board name of 245 to 255 characters passed the name check but its file name, with `.board.json`, didn't fit Windows (7.3); the link preview's 8 s limit ended before the body was read (7.2); `syncTileMembership`'s comment said "innermost frame" (7.5); KNOWN_LIMITATIONS #22 still gave the old 200-character cut (7.5).
- Added to the backlog: BL-39, the board-file fields B-08 leaves for the first board-format step.

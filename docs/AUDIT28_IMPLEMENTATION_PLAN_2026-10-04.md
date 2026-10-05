# Audit-28 implementation plan (draft, 2026-10-04)

- **Source:** [AUDIT28_PRE_DAILY_USE_2026-10-04.md](AUDIT28_PRE_DAILY_USE_2026-10-04.md). Finding IDs (A-01, H-01 …) refer to it.
- **Status:** Phases 0 and 1 done on 2026-10-04, Phase 2 on 2026-10-05 (see section 4); Phases 3 to 8 not started. Decisions D1 to D10 have defaults (section 3); Phase 0 used D3 and D10 at their defaults, Phase 1 used D1, D4 and D5 at theirs, Phase 2 D6 and D7 at theirs.
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
- **Findings a phase doesn't fix go to `docs/BACKLOG.md`** as BL-25 onwards (Phase 0 used BL-22 to BL-24 and fixed them, Phase 1 BL-25 and BL-26; Phase 2 added BL-27, fixed there, and BL-28).
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
| 6 | Sync, recovery and boards | C-03 (+ #33), C-01, C-04, C-05, C-06, C-10, C-09, C-11, A-07, A-04, B-01, B-02, B-03, B-04 (+ BL-02), B-05, B-07, B-09, B-06 | 18 | 35 | 7–9 days |
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
| 4.1 | Arrow keys, Tab and Shift-click use the rendered row order (flattened sections, collapsed rows excluded), as Kanban already does. | E-01 | 3/10 |
| 4.2 | Quick add uses Add task's section rule (last used, else first), and expands the section or says where the task went. | E-02 | 1/10 |
| 4.3 | Quick add matches weekday names and their usual abbreviations only, doesn't read a fraction between words as a date, and reads "tomorrow 5pm". A repeat token ("every friday", "every 2 weeks") if D8 says yes. | E-05 | 2/10 |
| 4.4 | The status filter uses the grouping's bucket rule, and lists the statuses actually present. | E-15 | 1/10 |
| 4.5 | Group By works within sections, and the control never disables itself. | E-16 | 2/10 |
| 4.6 | The date picker: focus the selected day on open, arrow-key grid, Escape, focus returned, readable labels, locale week start. | E-17 | 2/10 |
| 4.7 | The Kanban due-date box keeps a draft and commits on Enter or blur (or reuses the Task List picker). The time box commits once. | E-06 | 1/10 |
| 4.8 | Keyboard selection pans or scrolls to the selection, and a single card's menu gains "Move to column". | E-18 | 3/10 |
| 4.9 | The Repeat menu gains "every N days, weeks or months" and the completion mode, and warns about a rule it can't read instead of completing the task for good. | E-25 | 2/10 |
| 4.10 | An open, untouched notes box follows its note. | A-06 | 2/10 |
| 4.11 | One delete flow (Backspace through the shared Delete), one priority vocabulary, one collapse-undo policy. | E-19 | 2/10 |
| 4.12 | One date parser and one display formatter in `lib/utils/dateFormat.ts`, used everywhere. | E-24 | 2/10 |

**Pass:**
- The finder repros for E-01, E-02, E-05, E-06 and E-15 pass.
- A characterisation case: a priority-sorted list, then a Shift-click range and bulk delete, removes only the highlighted rows.
- E2E `dailyDriver` is still green.

### Phase 5: the interface around the views

| # | Task | Finding | Hard |
|---|---|---|---|
| 5.1 | A right-click menu on text, built in main from roles (Cut, Copy, Paste, Select All, enabled from `editFlags`), plus the spelling items and "Insert link" (sent to the renderer) (D9). | E-04 | 2/10 |
| 5.2 | Ctrl+W, Ctrl+Tab and Ctrl+Shift+Tab work while typing. Ctrl+S and Ctrl+Shift+F work in text fields. | E-10 | 1/10 |
| 5.3 | Laptop widths: below a breakpoint, a docked sidebar pushes the content instead of covering it (or folds away). The toolbar uses `justify-content: safe center` (BL-01). Check at 1,100, 1,280 and 1,366 px. | H-04, BL-01 | 2/10 |
| 5.4 | A Settings button in the toolbar, and one saving rule for every Settings tab, or clearer labels. | H-06 | 1/10 |
| 5.5 | The formatting toolbar shows as disabled when no editor has focus. | H-10 | 1/10 |
| 5.6 | Dragging a frame moves the frames inside it. Membership is recomputed for every affected frame, and frames are ordered by nesting. | E-09 | 4/10 |
| 5.7 | Keyboard focus entering a pane makes it the active pane. | E-21 | 1/10 |
| 5.8 | The minimap and waypoint toggles are remembered per board. | E-26 | 1/10 |
| 5.9 | Messages in plain words. Add "placement", "backing", "out-of-band" and "persist" to the components gate's word list. | E-23 | 1/10 |
| 5.10 | "Copy link to board / tile / note", and Help text that matches. | E-22 | 3/10 |
| 5.11 | Remove `CurrentBoardDocument.svelte` and its spec line, or store per-note page settings (decide in the phase). | E-20 | 2/10 |
| 5.12 | Escape closes the Search panel wherever focus is, unless something above it takes the key. | BL-03 | 1/10 |

**Pass:**
- Component tests.
- The axe E2E scan is still clean.
- Screenshots at 1,100 and 1,366 px show nothing covered or cut off.

### Phase 6: sync, recovery and boards

| # | Task | Finding | Hard |
|---|---|---|---|
| 6.1 | The vault-open warning lists only new failed-load snapshots. Add Settings → Recovery to list, open and delete rescue copies and kept versions (KL #33). | C-03, #33 | 3/10 |
| 6.2 | A file dropped from a hidden vault folder is copied in, not linked. `recovery:keep-unsaved` writes item by item. A refused write isn't called a disk-space problem. | C-01 | 2/10 |
| 6.3 | Announce note conflict copies (`.sync-conflict-`), live and at open, and fix CLAUDE.md's line. | C-04 | 2/10 |
| 6.4 | The correlator doesn't pair a "present" path that was already a known file. Or: a displaced note with unsaved work becomes a backed-up conflict. | C-05 | 3/10 |
| 6.5 | A watcher overflow (null filename) schedules a reconcile at once. | C-06 | 1/10 |
| 6.6 | A folder move the renderer follows also moves the watcher's walk records. | C-10 | 3/10 |
| 6.7 | A crash Reload releases the vault registry and the watcher first. | C-09 | 1/10 |
| 6.8 | Home waits for the recent-vaults list before auto-opening. | C-11 | 1/10 |
| 6.9 | Switching tabs away from a conflicted Raw view asks, as closing does. | A-07 | 3/10 |
| 6.10 | A forced reload with a queued body goes through the conflict check. Convert to UTF-8 unfreezes only after its reload. | A-04 | 2/10 |
| 6.11 | Link, embed and timer tiles are stored once. Readers skip a stale copy; the tag-delete Undo puts back what it changed. | B-01 | 2/10 |
| 6.12 | A board moved during a full save is re-scheduled, so its frozen copy is replaced, and stale failure marks are cleared. | B-02 | 3/10 |
| 6.13 | The board drift answer follows a rename. | B-03 | 1/10 |
| 6.14 | Note-only edits don't rewrite the board file. Opening a Kanban board writes no default view (BL-02, which must be fixed before the first real board-format step). | B-04, BL-02 | 2/10 |
| 6.15 | The Global Defaults frame image follows renames and deletes. | B-05 | 2/10 |
| 6.16 | Remove BoardRouter's default-board auto-create. | B-07 | 1/10 |
| 6.17 | The saved-views and style undo steps record per-key changes. | B-09 | 2/10 |
| 6.18 | The older-board notice says "rebuild the board; its notes are safe", and a string version is called invalid, not old. | B-06 | 1/10 |

**Pass:**
- The finder repros for C-01, C-03, C-04, C-05, B-01 and B-02 pass.
- `syncDeliveries.e2e.ts` gains a note conflict-copy case.
- The full E2E suite passes with scale.

### Phase 7: hardening, tidying and docs

| # | Task | Finding | Hard |
|---|---|---|---|
| 7.1 | The `.filo/` guards use the canonical long-name path (8.3 names). `vault:copy-file` checks the destination before writing and resolves real paths for sources. | C-07 (legacy-8) | 3/10 |
| 7.2 | The link-preview fetch validates the connected address on every hop. | C-08 | 3/10 |
| 7.3 | Names are capped by UTF-16 units (Windows) and UTF-8 bytes (Android), and a failed create leaves no broken tile. | A-S2 | 2/10 |
| 7.4 | Remove dead CSS and code (E-28). Drop legacy board fields with the first real format step (B-08). | E-28, B-08 | 1/10 |
| 7.5 | Docs: the design-doc drift list (E-27), CLAUDE.md's conflict-notice line, KL #29 and #30, and stale code comments (report section 5.4). | docs | 1/10 |
| 7.6 | Backlog quick wins: BL-04 (keep backslashes except before a colon), BL-05 (stay on a skipped Replace), BL-10 (scheduler `dispose()` for tests). | BL-04, BL-05, BL-10 | 3/10 |

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

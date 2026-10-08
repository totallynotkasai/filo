# Audit-29 implementation plan (draft, 2026-10-08)

- **Source:** [AUDIT29_FULL_AUDIT_2026-10-08.md](AUDIT29_FULL_AUDIT_2026-10-08.md). Finding IDs (A-01, C-08 …) refer to it. Write "Audit-29 A-01" in commit messages, since Audit-28 used the same letters.
- **Status:** in progress. Phases 0, 1 and 2 done 2026-10-08 (outcomes in section 4). Decided: D1 (a), tight paragraphs; D3 (`npm run preview`, then `npm start`; no dev guard); D4 (push now, for Phase 0; Phases 1 and 2 stay on this PC); D5 (follow a note moved and edited at once as a move). D2 and D6 to D8 still have only their defaults.
- **Scores:** out of 10, as in the report. **Hard:** 0/10 = minutes, 5/10 = a few days with tests, 10/10 = weeks.

## 1. How this plan works

- **Order:**
  1. how you run Filo, and a copy of the code off this PC;
  2. the uncommitted paragraph change, finished properly;
  3. other programs changing the vault (your agent);
  4. the Task List and Kanban keyboard;
  5. the Mind Map, Documents and the interface;
  6. templates and boards;
  7. tidying, hardening and docs;
  8. verification and archive.

  Phase 0 is the one to do before your next evening in Filo. Phase 1 decides whether the uncommitted change gets committed.
- **Each fix starts with a test that fails on today's code.** The finders' and refuters' repro tests are in this audit session's scratchpad, under `…\72e6211b-2ce6-4339-a7f6-026c33750d39\scratchpad\repros\finder*` and `refuter1`. Turn each into a permanent test in the right project. Test the *interaction* each fix touches: the report's section 4 shows each round's regressions landing exactly where the last fixes did.
- **Prefer reusing one mechanism to adding another** (report section 5):
  - one "who handles this key" rule per board;
  - one "on screen" list per board;
  - one new-note registration for every add path.
- **Each phase ends with:**
  - `npm run ci:verify` on Windows;
  - the E2E suite (with `FILO_E2E_SCALE=1`) when the phase touches the shell, startup, quit, file watching or the editor;
  - the corpus check (`corpus:run` + `corpus:compare` against this audit's `corpus-a29.json`) for any phase that touches the editor or Markdown writing;
  - an outcome section in this file: what changed, deviations, new findings;
  - **a version bump and a fresh build for you to run** (Phase 0 sets this up).
- **Findings a phase doesn't fix go to `docs/BACKLOG.md`** as BL-42 onwards.
- **Comments explain why, never history.** Audit IDs go in commit messages.

"Sum of Hard scores" adds up the Hard scores of the phase's tasks. It's a rough guide to size, not a score.

| Phase | What | Findings | Tasks | Sum of Hard scores | Rough size |
|---|---|---|---|---|---|
| 0 | How you run Filo; the code off this PC | C-08, C-01 (+ KL #20), C-05 (+ BL-21), C-06 | 5 | 4 | half a day |
| 1 | Paragraphs and line breaks (the uncommitted change, finished) | D-01, D-02, D-08, H-03, D-05 | 7 | 11 | 3–4 days |
| 2 | Other programs changing the vault | C-02, C-03, A-01, A-03, C-07 (+ BL-08) | 6 | 12 | 3–4 days |
| 3 | Task List and Kanban keyboard | E-03, E-01, E-04, E-07, E-02, E-05, E-06, E-13, BL-35 (+ the KanbanBoard split) | 10 | 14 | 4–5 days |
| 4 | Mind Map, Documents and the interface | E-08, E-11, E-09, D-04, E-10, D-03, H-02, H-04, D-07, A-05, A-06, E-12 | 12 | 17 | 4–6 days |
| 5 | Templates and boards | B-01, B-02, B-03, B-04, B-05, B-06, B-08, A-04, BL-31, BL-32 | 10 | 12 | 3–4 days |
| 6 | Tidying, hardening and docs | C-04, D-06, E-14, A-02, E-16, docs drift, BL-41 | 7 | 7 | 2–3 days |
| 7 | Verification and archive | — | — | — | 1 day |

Phases 2 to 6 can be reordered or split to suit you; each stands on its own. Phase 3 must split `KanbanBoard.svelte` before its Kanban fixes (task 3.1).

## 2. Phases

### Phase 0: how you run Filo, and the code off this PC

| # | Task | Finding | Hard |
|---|---|---|---|
| 0.1 | You: run real work with `npm run preview` (a built copy, no dev server) or an installed package, not `npm run dev` (D3). Keep `npm run dev` for development on a scratch profile: add a `dev:scratch` script that passes `-- --user-data-dir=<folder>` to electron-vite (`scripts/dev.mjs` doesn't forward arguments today). Add a short "Running Filo day to day" note to `README.md`. | C-08 | 0/10 |
| 0.2 | Bump `package.json` with every build you're handed (0.2.1 now). Show the short commit id beside the version in Settings' footer (read at build time like the version, `git rev-parse --short HEAD`; "dev" when unavailable). This is the cheap half of KL #20. E2E: `versionAndNewVault.e2e.ts` checks the shape. | C-01, KL #20 | 1/10 |
| 0.3 | Optional (D3): a dev-only guard against reloads. In dev builds only, a `beforeunload` handler cancels a navigation while `unsavedWork()` isn't empty, saves, then reloads. Never active in a built app, and never blocks the window-close quit path (the quit drain closes the window). Test: a component test with `import.meta.env.DEV` stubbed. | C-08 | 2/10 |
| 0.4 | You decide (D4): push `main` to GitHub before 19 October, so Audit-28, the page view and this plan's commits get an off-machine copy and a Linux CI run before the Ubuntu 26 switch. Then look at the first run after 19 October (BL-21). | C-05, BL-21 | 0/10 |
| 0.5 | `npm audit fix` for source-map-js (a development tool). Leave the electron-builder chain unless a non-breaking fix exists; note it in the outcome. | C-06 | 1/10 |

**Pass:** Settings shows the new version and commit id. You run Filo from `npm run preview` or an installed build. `git status` is clean after the push, if you choose to push.

### Phase 1: paragraphs and line breaks

Commits the uncommitted change together with what it needs. Decide D1 first.

| # | Task | Finding | Hard |
|---|---|---|---|
| 1.1 | Paragraph spacing as decided in D1. By default, keep the tight paragraphs you asked for. If D1 picks a gap or a setting, it goes in `defaults.json` → Document (applied to tiles and cards too) as a CSS variable, never in the note. Document it in CLAUDE.md (Common Gotchas), a new KNOWN_LIMITATIONS entry ("Other Markdown apps show a paragraph and a typed blank line differently"), and the design doc's "Line & paragraph spacing". | D-01 | 2/10 |
| 1.2 | Lists match the prose. A list item's own paragraph gets no bottom margin (`.tiptap li > p`, both in `style.css` and `DocumentEditor.svelte`); the list keeps its margin below the whole list. Checklist items (flex `li`) the same. Chromium: the finder's `zzA29D_paragraphGapsInChromium` turned into a spec (paragraph gap = item gap for each setting). | D-01 | 1/10 |
| 1.3 | Enter beside a line break opens a new empty line at the caret. `softBreak.ts:201-217` turns the break into a paragraph boundary and then splits once more, so the caret sits on an empty paragraph between the two halves (A, empty, B), as Enter at a paragraph's end does. Update `softBreakEnter.test.ts` and `editorCaretInChromium.test.ts`, which pin today's behaviour, and add Refuter 1's repros. | D-08 | 2/10 |
| 1.4 | A block command on one line of a line-broken block acts on that line only. Heading, Normal text, Align, Indent, Quote and the list buttons first split the paragraph at the line breaks around the selection; the rest of the block keeps its form. One undo step. Toolbar cases in `toolbarCases.ts` for each command; the Chromium spec on the `Leveling System Ideas` shape. | D-02 | 3/10 |
| 1.5 | Blank lines at the start and end of a note survive reopening. `encodeEmptyParagraphs` rebuilds them too, as it does between blocks. The corpus decides whether the start or the end is safe; if one isn't, document it in KL instead. | H-03 | 1/10 |
| 1.6 | A title stays one line. The label editor's document is a single paragraph; a paste joins its lines with a space; `resolveTitleCommitValues` collapses whitespace. | D-05 | 1/10 |
| 1.7 | Commit the uncommitted change with 1.1 to 1.6. Run the corpus against `corpus-a29.json` (0 changed, 0 newly read-only), plus a hands-on look in the built app at your `Leveling System Ideas` and `Duplicate Review` copies. | — | 1/10 |

**Pass:** in a tile, a card and a Document tab, lists and paragraphs are spaced alike. Heading 3 on one line of a 19-line block changes only that line. Enter at the end of a line-broken line shows a new empty line, and typing goes there. The corpus shows no change.

### Phase 2: other programs changing the vault

Your agent moves, rewrites and merges notes from outside Filo. Phase 2 makes that safe with Filo open.

| # | Task | Finding | Hard |
|---|---|---|---|
| 2.1 | A same-name note moved into a new folder and edited in the same moment is followed as a move plus a change (D5). In `renameCorrelation.ts`, a lone missing+present `.md` pair with the same file name, whose new path was free (`wasPresentBefore` false), pairs even when the bytes differ. The renderer then sees a rename (re-keying the note, its tabs and board tiles) followed by a change, and the existing body-drift prompt (Reload / Keep mine, with copies) handles the typing. Characterisation: the finder's `zzA29C_moveAndEditAtOnce` turned into a spec, and the deleted prompt never appears. Update KL #7 and #31. | C-02 | 4/10 |
| 2.2 | A note write that fails because the file is missing asks main to check the folder at once, as boards do (`vault:reconcile`, `boardProvisionalMissing.ts:74`), before the 3 s grace ends. Also accept a renamed folder whose old files all reappear by name under the new folder, even with sizes changed or files added (`treeFolderMoves.ts`). Characterisation: `zzA29C_folderRenamePlusNewFile`, followed within the grace, and no "no longer exists" toast. | C-03 | 2/10 |
| 2.3 | The notes box's "Use theirs" keeps a copy of your draft in `.filo/recovery/<ts>-keep/` first, and asks before going on without one, as Reload does. Label it "Use theirs (discard mine)". | A-01 | 1/10 |
| 2.4 | Reload adopts the newest version on disk. Re-read after `keepTyping()` resolves, or take `conflictDisk` when it is newer. Unit: `zzA29A_reloadStaleRead`. | A-03 | 1/10 |
| 2.5 | A followed folder move never copies "gone" presence entries over the new paths (`fileWatcherOwnMoves.ts` `rekey`: skip `false` entries, or don't overwrite an existing key). Unit test on the watcher's presence map. | C-07 | 1/10 |
| 2.6 | Optional: measure BL-08 in the built app. Make 200 outside edits to an open note, take a heap snapshot, and fix only if memory grows there. | BL-08 | 3/10 |

**Pass:** the agent-style scenarios run as characterisation specs with Filo open. Covered: a move plus an edit, a folder rename plus a new file, and a merge that deletes a note with typing in it. Every note follows, no "deleted" or "no longer exists" prompt is wrong, and your typing lands in the moved note.

### Phase 3: Task List and Kanban keyboard

| # | Task | Finding | Hard |
|---|---|---|---|
| 3.1 | First, move Kanban's keyboard and selection code out of `KanbanBoard.svelte` (985 of 1,000 lines of code) into `lib/kanban/`: `navColumns`, `flatVisibleTileIds` and `handleBoardKeydown`'s cases. Make one "cards on screen" function that both use. No behaviour change; the existing suites pass. | (size) | 3/10 |
| 3.2 | The "cards on screen" function leaves out collapsed columns. Shift-click ranges and the arrow keys never reach a hidden card. | E-02 | 1/10 |
| 3.3 | A card added while the find bar or a filter hides it: say so, as the Task List does ("… was added, but the filters hide it"), or let the new card through the filter until it's titled. No empty notes from retries. | E-05 | 1/10 |
| 3.4 | Kanban keyboard focus is real. The selected card takes focus (roving `tabindex`), and the menu key or Shift+F10 opens its menu, so **Move to column** works from the keyboard. Fix the comment at `kanbanContextMenus.ts:20`. | E-06 | 1/10 |
| 3.5 | Task List Alt+Up / Alt+Down follow the screen. Take the target from `renderedRows` (the previous or next visible task at the same level, with its whole block). Under a non-Manual sort, first fix the drawn order as the manual order, as a drag does, in one undo step with the toast. | E-03 | 2/10 |
| 3.6 | Task List Tab, as decided in D2. By default: one level in, under the nearest row above at the same level, and a refused indent lets Tab move focus on (never a trap). Update the design doc's :801 if D2 changes the rule. | E-04 | 1/10 |
| 3.7 | Escape on a Task List: prevent the key only when a drag was actually cancelled (`TaskListBoard.svelte:1095-1097`). Characterisation: `zzA29E_taskListEscape`, Task List and Kanban, single and split view. | E-01 | 1/10 |
| 3.8 | The Task List's bare N acts only with focus in the board (`focusIsInBoard`), as on Kanban and the Mind Map. | E-07 | 1/10 |
| 3.9 | Help → Shortcuts lists the row, card and editor keys. Give the Task List and Kanban row keys entries (registered commands where they can be; a fixed list otherwise), and fix the comment at `KanbanBoard.svelte:919-926`. | E-13 | 1/10 |
| 3.10 | The Task List's Table of Contents folds to its header where there's no room beside the list, remembered per board. | BL-35 | 2/10 |

**Pass:** the finders' repros pass as specs. In the built app, keyboard only: on a Kanban board with a collapsed column, select a card, move it to another column with the menu key, and Shift-click across the collapsed column. On a Task List under priority sort, move a task with Alt+Up as drawn, and indent with Tab, never trapped.

### Phase 4: Mind Map, Documents and the interface

| # | Task | Finding | Hard |
|---|---|---|---|
| 4.1 | Folding a frame hides the frames inside it, and they leave hit tests (`framesInside`). | E-08 | 1/10 |
| 4.2 | Mind Map keyboard selection and N use `newTileView`'s rect: an arrow key pans to a tile under the docked sidebar, and the tile N makes is revealed (and its title edit opened) wherever the selected tile is. | E-11 | 2/10 |
| 4.3 | The docked sidebar pushes the workspace aside when a zoomed Document page would start under it (`sidebarPushesWorkspace` takes the tab's zoom). | E-09 | 1/10 |
| 4.4 | The zoom keys: Ctrl and + (number pad, and Ctrl+Shift+=) zoom in, and all three keys work in the Raw view (`allowInField`). | D-04 | 1/10 |
| 4.5 | A table column dragged at a zoom other than 100% follows the pointer (divide the drag by the zoom). | E-10 | 1/10 |
| 4.6 | The page view measures only from the first changed block down. It walks `view.dom.children` instead of `nodeDOM`, skips when the editor's height didn't change, and pauses longer on long notes. The finder's Chromium perf repro becomes a budget spec. | D-03 | 3/10 |
| 4.7 | The read-only banner names the first change that makes the note read-only (a lossy one), not a cosmetic blank line. Take ownership lists it first and says what it is ("this list becomes a checklist"). Fix the missing space ("read-only.Saving"). Update KL #17. | H-02 | 2/10 |
| 4.8 | The sidebar row reserves space for its hover buttons only while they show, so names use the full width. The Mind Map's Waypoints panel starts hidden while a board has no waypoints. | H-04 | 1/10 |
| 4.9 | Spelling off reaches the Task List's notes box and title box (`spellcheck={toolbarStore.spellcheck}`). | D-07 | 1/10 |
| 4.10 | A new note's title, as decided in D7. By default, no `title:` until you name it, so a sidebar rename names it. | A-05 | 1/10 |
| 4.11 | Closing a split pane that shows a conflicted Raw view asks first (`mayLeaveRawView`), as a tab switch does. | A-06 | 1/10 |
| 4.12 | The cross-view consistency list:<br>• the sidebar's Escape prevents the key when it clears a selection;<br>• Escape clears the Mind Map's selection too;<br>• Kanban gets Ctrl+A;<br>• the card menu puts Move to column before the danger item;<br>• one name per command ("New card", "New task");<br>• the new-card picker in plain words;<br>• a time box in the Kanban date picker. | E-12 | 2/10 |

**Pass:** the finders' repros pass as specs. In the built app at 1,366 px: a 150%-zoomed note clears the sidebar, and N beside an off-screen tile reveals the new tile with its title open. Typing in a 100,000-word note with pages on has no pause over 30 ms.

### Phase 5: templates and boards

| # | Task | Finding | Hard |
|---|---|---|---|
| 5.1 | A layout-template insert registers its new notes (`noteMadeForNewItem`) and gives `AddTilesCommand` one new-note undo per text tile; a note that can't be made takes its tile off. | B-01 | 2/10 |
| 5.2 | A board template's `"settings"` are applied, through `boardSettingsSchemaFor(type).safeParse`. | B-02 | 1/10 |
| 5.3 | A template title is made file-name-safe before it names a board (`fileNameSafe`). | B-03 | 1/10 |
| 5.4 | "Apply … Defaults to all Boards" clears a Task List's `titleFontSize` too. | B-04 | 1/10 |
| 5.5 | "Delete tile and file" registers its undo with Settings → Trash, as sidebar deletes do, so a restore brings the tile back. A restore reports where the item landed, and undo uses that instead of trusting the old path. Correct CLAUDE.md. | B-05 | 2/10 |
| 5.6 | Restore a trashed note under its board's renamed folder when the original folder no longer exists (the DECISION in `commandPaths.ts` gets this exception). | B-06 | 1/10 |
| 5.7 | Kanban bulk "Add tag" tags link and audio cards (board-only tags), or says they were skipped. | B-08 | 1/10 |
| 5.8 | Undoing a new card counts its note as empty only while its frontmatter is still what Filo seeded. | A-04 | 1/10 |
| 5.9 | Leave templates whose `filo-board` block isn't valid JSON out of Kanban's card picker (or say the block is broken), and close BL-31. | BL-31 | 0/10 |
| 5.10 | Board templates start from every board and from New Tab ("New board from template…"); Ctrl+T opens the Template Browser on every board, showing layout templates only on a Mind Map. | BL-32 | 2/10 |

**Pass:** a board template with settings, a `:` in its title and a skeleton makes its board from a Kanban tab. Undoing a layout insert leaves no notes. Restoring a "Delete tile and file" from Settings → Trash brings the tile back.

### Phase 6: tidying, hardening and docs

| # | Task | Finding | Hard |
|---|---|---|---|
| 6.1 | `isPrivateUrl` tests the URL's host only, with the fc00::/7 and fe80::/10 ranges. | C-04 | 1/10 |
| 6.2 | Image alt text keeps `[`, `]` and `*`: a markdown-it core rule turns escape tokens inside image children into text (the note parser and previews), or the writer leaves alt text unescaped. Corpus check. | D-06 | 1/10 |
| 6.3 | Link reference definitions survive `encodeEmptyParagraphs` (they're part of the text, not a gap), so their links resolve. Correct KL #17's "written inline". | E-14 | 2/10 |
| 6.4 | `noteEditorView.show()` serialises against the moved model, so keys typed during a rename are saved on the idle timer. | A-02 | 1/10 |
| 6.5 | Remove the dead CSS variables (`--body-text-color`, `--frame-bg-opacity`, `--frame-border-color`). Fix the stale comments (`TagEditor.svelte:26`, `sidebarNewItems.ts`) and "tile(s)". | E-16, B-07 | 0/10 |
| 6.6 | The docs drift in report section 5.4:<br>• KL #7, #17 and #31;<br>• CLAUDE.md's Trash claim;<br>• the backlog's section 3 numbers. | — | 1/10 |
| 6.7 | BL-41: add an E2E case, "quit after an Apply in Global Defaults exits", and close BL-41 unless it reproduces. | BL-41 | 1/10 |

**Pass:** `ci:verify` green, and the security test for 6.1 bites (the owner runs the mutation proof; auto mode refuses weakened security checks).

### Phase 7: verification and archive

- `ci:verify`, the E2E suite with scale budgets, the corpus against `corpus-a29.json`, and the packaged app (`package:dir` + `FILO_E2E_EXE`).
- A built-app tour on a fresh copy of your book vault.
- Move this plan and the report to `docs/archive/`. Update `docs/BACKLOG.md`.
- Build and hand over the installer at the new version.

## 3. Decisions for you (defaults in bold)

| # | Decision | Options | Affects |
|---|---|---|---|
| D1 | Paragraph spacing | **(a) Tight, as you asked: no gap, with lists matched, Enter at a line break fixed, and block commands acting on one line (tasks 1.2 to 1.4).**<br>(b) A small gap, about a quarter line, so a paragraph's end stays visible. Task 1.4 then becomes optional.<br>(c) A "Space between paragraphs" choice in Global Defaults → Document: None / Small / Blank line. | Phase 1 |
| D2 | Task List Tab rule | **One level in, under the nearest row above at the same level, as in Word and outliners; update the design doc.**<br>Or keep "under the row above, at any depth". | 3.6 |
| D3 | How you run Filo day to day | **`npm run preview` after each phase, no dev guard.**<br>Or install a packaged build after each phase.<br>Or add the dev-only reload guard (0.3) and keep using `npm run dev`. | 0.1, 0.3 |
| D4 | Push to GitHub | **Push now, before 19 October.**<br>Or keep everything local. | 0.4 |
| D5 | A note moved and edited at once by another program | **Follow it as a move, then the usual Reload / Keep mine prompt.**<br>Or keep today's pairing and add "It moved to …: follow it" to the deleted prompt. | 2.1 |
| D6 | Removing one card or task (backlog decision), and "Delete from vault…" on a Kanban card | **Add "Delete from vault…" to the card menu; keep removing one card or task immediate, with Undo.** | 4.12 |
| D7 | A new note's title | **No `title:` until you name it.**<br>Or keep `title: Untitled` and let a sidebar rename update a placeholder title. | 4.10 |
| D8 | The Search panel's Find All popup (backlog decision) | **Drop it.**<br>Or keep both lists. | — |

## 4. Outcomes

### Phase 0 (done 2026-10-08)

**Decisions taken:** D3, the default: `npm run preview` after each phase, no dev guard (so task 0.3 is not done). D4, the default: push now.

**What changed**

| # | Change |
|---|---|
| 0.1 (C-08) | `npm run preview` builds into `dist-preview/` and runs Filo from there, on your own profile. **New `npm start`** runs that build again without building. **New `npm run dev:scratch`** runs the dev server on a scratch profile (`%APPDATA%\filo-dev`), which opens none of your vaults. Arguments after `--` reach Electron in all four. The launcher (`scripts/dev.mjs`) now runs electron-vite through node with no shell, so a path with spaces passes whole. `README.md` has "Running Filo day to day". CLAUDE.md's Quick Reference lists the new commands, and its rules 7 and 8 say: bump the version with every handed-over build; never launch Filo on your profile or write `dist-preview/`. Git and ESLint ignore `dist-preview/`. |
| 0.2 (C-01, KL #20) | Version 0.2.1. Settings' footer reads `Filo 0.2.1 (<commit>)`, with a tooltip saying what the commit is. The commit is stamped at build time by the renderer's `define` in `electron.vite.config.mts` and read as `APP_COMMIT` in `constants/appVersion.ts`; it is "dev" in the test runner or without git. The component test checks the text and tooltip; `versionAndNewVault.e2e.ts` checks the shape on the built app. KL #20 now says Settings names the build, so machines can be compared. |
| 0.3 | Not done (D3). |
| 0.4 (C-05, BL-21) | `main` pushed after this phase's checks; see "Push" below. BL-21 stays open until someone looks at the first run after 19 October. |
| 0.5 (C-06) | `source-map-js` 1.2.1 → 1.2.2 clears the one high advisory. The 8 moderate advisories in electron-builder's download chain stay (only `npm audit fix --force` touches them, and that downgrades electron-builder to 26.5.0): BL-42. `npm audit --omit=dev` is still 0. |

**Deviations from the plan**

1. **The preview builds into its own folder.** The plan and report (section 7) said a rebuild by another session doesn't touch a running built copy. That holds only for a copy outside `dist/`. Every `npm run build` (in `ci:verify`, before the E2E suite) empties `dist/renderer`. Filo loads some code only on first use (the Raw view, Replace, the Tags Browser), so a copy run from `dist/` breaks the first time one of those opens after a rebuild. Seen this phase: the `ci:verify` build deleted the files the earlier build's `index` chunk pointed at for those (`rawTextEditor-BIlyDguR.js`, `replaceAllCommand-dQTsvkSl.js`, `TagsBrowser-Caww4YLR.js`). `dist-preview/` is written only by `npm run preview`. Its `package.json` carries Filo's own name, so Electron still uses your profile folder (`%APPDATA%\filo`), checked with a throwaway app of the same shape.
2. **`npm start` was added** (not in the plan). It reopens the build you were handed without rebuilding, so half-done work by a session in this folder never reaches the copy you use. Run `npm run preview` once per handed-over build, `npm start` on the days between.
3. **A `+` after the commit** marks a build that also held uncommitted changes to its inputs (`src/main`, `src/renderer`, `src/shared`, `src/css`, `index.html`, `package.json`, `package-lock.json`, the Vite and Svelte configs). The plan asked for the bare id. Without the mark, a build made from today's tree, which holds the uncommitted paragraph change, would name a commit whose code it doesn't match.
4. **`npm audit fix` itself wasn't kept.** It also moved electron-builder and its parts from 26.15.3 to 26.16/26.17, plus `@electron/rebuild`, `node-abi`, `undici` and `@peculiar/asn1-schema`, and cleared no advisory by doing so. I reverted the lockfile and ran `npm update source-map-js` alone (a 3-line lockfile change).
5. **The audit report and this plan are committed with Phase 0**, as Audit-28's were with its Phase 0.

**Checks**

| Check | Result |
|---|---|
| `ci:verify`, main checkout (Phase 0 plus the uncommitted paragraph change, as your preview will build it) | Green in 349 s: lint, knip, svelte-check (916 files, 0 errors), main typecheck, 873 test files (8,520 passed, 5 skipped), build, 91/91 gates. |
| `ci:verify`, a worktree holding exactly the Phase 0 commit (no paragraph change) | Green in 351 s: the same stages, 873 test files (8,519 passed, 5 skipped; the paragraph change carries the other one), 91/91 gates. |
| E2E with `FILO_E2E_SCALE=1`, same worktree | 47/47 in 3.4 min, `versionAndNewVault` reading the new `Filo 0.2.1 (<commit>)` shape, and the scale budgets in. |
| Hands-on (scratch profile, `-- --user-data-dir=<scratch>`) | `npm run preview` built `dist-preview/` and Settings showed `Filo 0.2.1 (f830c42+)` with the tooltip "Built from commit f830c42, with changes not yet committed". `npm start` reopened it without building. `npm run dev:scratch` opened Home with "No recent vaults". Each window closed through the normal quit path. No file in your real profile (`%APPDATA%\filo`) changed. |
| Corpus | Not run: nothing in the editor or Markdown writing changed. |

**Push:** a6de678 and the 11 commits before it (Audit-28 Phases 0 to 8 and the page view) went to `origin/main` (`ead80a3..a6de678`) once the checks above passed. The uncommitted paragraph change stayed on this PC. GitHub's run [37763160533](https://github.com/totallynotkasai/filo/actions/runs/37763160533) passed on `ubuntu-24.04` in 54 min 27 s, the first Linux check of those commits. That's slower than the 35 to 43 minutes before, which is BL-43. This outcome note was pushed after it as a docs-only commit, which starts no run.

**New findings:** BL-42 (above), and BL-43: the GitHub run grew to 54 minutes, almost all of it the unit suite (3,100 s against 2,029 s on 4 October). The `dist/` rebuild hazard (deviation 1) was found and fixed in this phase.

**For you:** close Filo if it's open, then run `npm run preview` once. Settings should read `Filo 0.2.1 (<commit>+)`: the `+` is the paragraph change, still uncommitted until Phase 1. On the days after, open Filo with `npm start`.

### Phase 1 (done 2026-10-08)

**Decisions taken:** D1, the default (a): tight paragraphs, with lists matched, Enter at a line break fixed and block commands acting on one line. You also chose to keep Phase 1 on this PC: it is committed, not pushed.

**What changed**

| # | Change |
|---|---|
| 1.1 (D-01) | Tight paragraphs kept, with no setting: the uncommitted `p:has(+ p)` rule and the card preview's blank lines are committed with this phase. Written up in CLAUDE.md (Common Gotchas, "Paragraphs have no gap between them", and the structure list), KNOWN_LIMITATIONS #54 ("Other Markdown apps show a paragraph and a typed blank line differently") and the design doc's "Line & paragraph spacing". |
| 1.2 (D-01) | Lists stand as close as paragraphs. An item's paragraph (a checklist item's sits in a `div`) and a list nested in an item add no margin, in `style.css` and again in `DocumentEditor.svelte`, whose own `li` margin (0.3em) is gone. A whole list keeps its margin below. A checklist's checkbox label is one line tall (`1lh`), the box centred on it. New Chromium spec `paragraphSpacingInChromium.test.ts` (24 cases): in a tile, a card's preview and a Document tab, at each of the 7 Line Spacings, a paragraph, a bullet, a numbered and a checklist item are each a line apart, and a list keeps a gap below; a sub-list; the card preview as tall as its editor; Heading 3 on a stat block's line. |
| 1.3 (D-08) | Enter beside a line break opens a new empty line at the caret. The break becomes a block boundary (a new item, in a list), the caret stays on its line, and Enter then runs as usual. At the end of a line the new line opens under it and typing goes there; at the start of a line, above it; on an empty line between two breaks, under it. One Ctrl+Z puts it back. `softBreakEnter.test.ts` (8 cases, Refuter 1's stat block among them), `editorCaretInChromium.test.ts` with real keys (the note grows by a line, "Speed" never joins the next line), and a characterisation case through the whole app and disk. |
| 1.4 (D-02) | New `lib/editor/lineBlocks.ts`. Heading, Normal text, Align, Indent, Quote (Ctrl+Shift+B: the toolbar has no Quote button) and the list buttons, with their shortcuts, split a block of soft-broken lines at the soft breaks around the selection, then act, in one undo step. The heading menu's style clear (`clearBlockTextStyle`) clears only the selected lines. 12 new toolbar cases (saved, reloaded, and read by micromark too), `lineBlocks.test.ts` (11), the Chromium stat-block case, and a characterisation case: Heading 3 from the Text style menu changes only that line on disk. |
| 1.5 (H-03) | Blank lines after a note's last block are rebuilt on load (`encodeEmptyParagraphs`), so Enter, Enter after the last line survives reopening, and reopening writes nothing (characterisation case). Blank lines at the start can't be told from the gap under frontmatter: KNOWN_LIMITATIONS #55. |
| 1.6 (D-05) | A title is one line (new `lib/editor/oneLine.ts`). The title and label editor holds one paragraph. A pasted line break or paragraph, plain or HTML, becomes a space, formatting kept. A title saved over two paragraphs opens as one line with all its words, and the commit turns any line break into a space. `titleOneLine.test.ts` (7), `titlePasteInChromium.test.ts` (3, the browser's real paste). |
| 1.7 | One commit: the uncommitted change with 1.1 to 1.6. Version 0.2.2. |

**Deviations from the plan**

1. **Only soft breaks split (1.4).** A Shift+Enter line break keeps its paragraph whole, as in a word processor, where a paragraph style takes all its lines (a `DECISION` in `lineBlocks.ts`). The plan said "line breaks". Soft breaks are the lines from Keep, Canvas, an agent or a plain-text paste, which the owner didn't type as one paragraph.
2. **Lines a selection spans stay one block (1.4).** The split is at the breaks around the selection, as the plan says, not between the selected lines. Heading 3 on two of three lines makes one heading of two lines (`<br data-filo-soft-break>` in the file).
3. **Not in a list item or table cell (1.4).** A split there would make the item two paragraphs (a loose list) or turn the table into HTML, so a command there acts on the whole item, as before.
4. **Two problems found and fixed in 1.4 while testing it.**
   - A command that changes nothing split the block in the file anyway: Shift+Tab on a line with no indent, Align Left on a left line, Normal text on a paragraph. A split the command leaves alike on both sides is now joined back (alignment `left` counts as none).
   - Normal text (Ctrl+Alt+0) on a line that already was a paragraph threw "Invalid content for node type hardBreak". TipTap's `setNode` falls back to `clearNodes` there, which maps positions it reads from the split document through the split's own steps a second time. The wrapped command now runs on a transaction of its own over the split document (TipTap's `CommandManager` with a custom state), and its steps are added to the shared one.
5. **The heading menu's style clear (1.4)** removed the size, font and colour of every line in the block, not just the ones becoming a heading. It now clears the selected lines only.
6. **Only the end is rebuilt (1.5)**, as the plan allowed. The start is KNOWN_LIMITATIONS #55. The end's rebuild leaves the body as written when anything but blank lines follows the last block (a link reference definition, which the between-blocks rebuild drops: E-14, Phase 6). It also checks its own result, so a block left open to the end (a code fence never closed) never takes the empty lines in.
7. **More than `li > p` (1.2).** A nested list's margin, the Document tab's `li` margin and the checkbox label also had to go: a checklist stood 2 to 3 px looser than the text at Line Spacing 1 and 1.15, and at every spacing in a Document tab.
8. **Connection labels too (1.6)**, since they use the same editor. The commit turns only line breaks into spaces, not other runs of spaces: a tile header writes `title:` whenever the commit's text differs from it, so collapsing double spaces would rewrite titles nobody edited. The one-line Enter moved from `createEditor.ts` into `oneLine.ts`.
9. **The new line's kind (1.3).** In a list item the break becomes an item boundary, so the new line is an item between the two. In a heading the new line is a paragraph between two headings.
10. **The spacing spec reads the real styles.** `paragraphSpacingInChromium.test.ts` compiles `DocumentEditor.svelte` with `svelte/compiler` at test time, instead of copying its rules as the finder's repro and `pageBreaksInChromium.test.ts` do. `svelte/compiler` joined the browser project's `optimizeDeps` (found mid-run, it reloads the page under the running specs), and `src/tests/types/rawImports.d.ts` declares `?raw` imports.
11. **One test pinned the old behaviour.** `editorEditsReadBack.test.ts` ("a heading made from a one-line-per-thought paragraph, Ctrl+I from the end of its first line") put the caret on the first line and expected a two-line heading. It now selects both lines first, keeping its subject (italic across the break).
12. **The corpus shows changes, all from 1.5** (see Checks). The plan's pass said no change.

**Checks**

| Check | Result |
|---|---|
| `ci:verify`, main checkout (Phase 1 complete) | Green in 338 s: lint, knip, svelte-check (918 files, 0 errors), main typecheck, 877 test files (8,617 passed, 5 skipped), build, 91/91 gates. An earlier run, started before the last fixes, failed only the `editorEditsReadBack.test.ts` case in deviation 11. |
| E2E with `FILO_E2E_SCALE=1` | 47/47 in 3.7 min, scale budgets in. |
| Corpus, the 741-note list against `corpus-a29.json` | 0 newly read-only, 0 newly failed to load. 4 outputs changed, each a note ending in blank lines, which a save now keeps. Three of them now save byte for byte as their file. The fourth (`node_modules/filelist/README.md`) still differs from its file elsewhere: Filo writes its `*` bullets as `-`, as before. 5 notes not compared (docs edited between the runs); the 2 that failed before are the archived Audit-28 docs. |
| Corpus, your 21 book notes against `owner-corpus-a29.json` | 20 editable, 1 read-only (`Duplicate Review`, as before). 3 outputs changed, all now byte for byte as their files: `Plot Overview`, `Character Profiles` and `Old Magic Ideas` end in blank lines, now kept (and shown as empty lines at the end). |
| Hands-on, the built app | `dist/`, a scratch profile and a fresh copy of the book vault at 1,366 px, driven by Playwright. Heading 3 from the Text style menu on `Leveling System Ideas`'s "Physical (likely capped)" made that line alone a heading; the file read `**Potential stats**`, a blank line, `### Physical (likely capped)`, a blank line, then the stat lines as before. Ctrl+Z put it back. End and Enter on "Strength — raw power…" opened a line under it, and "Speed - movement" was typed there, saved as its own paragraph. `Duplicate Review`'s bullets stand a line apart, like its text. No toasts, no errors, and the quit exited. The first save of that note also dropped a space typed at the end of a line, which Filo has always done (`lineEndSpaces.ts`). |

**New findings:** BL-44 (a card whose note mixes bullets and checklist items in one list grows a line when its editor mounts; the note is read-only anyway) and BL-45 (typing `- ` at the start of a soft-broken line leaves it text). Both are in `docs/BACKLOG.md`.

**For you:** close Filo if it's open, then run `npm run preview` once. Settings should read `Filo 0.2.2 (<commit>)`, with no `+`. Then open `Leveling System Ideas` and try Heading 3, and Enter at the end of a stat line. On the days after, open Filo with `npm start`.

### Phase 2 (done 2026-10-08)

**Decisions taken:** D5, the default: a note moved and edited at once is followed as a move, then the usual Reload / Keep mine question. Task 2.6 (BL-08) measured, as you chose. Phase 2 stays on this PC with Phase 1: committed, not pushed.

**What changed**

| # | Change |
|---|---|
| 2.1 (C-02) | `renameCorrelation.ts`: a lone same-named pair of notes (`.md`, `.markdown`) whose new path held no file pairs even when its bytes changed (`movedAndChanged`), unless the new file is empty. The watcher sends the rename, then a change of the new path (`changedOnMove`), so the renderer re-keys the note, its tabs and tiles first, and the moved note's own drift check then asks Reload / Keep mine. A clean note just shows the edit. |
| 2.2 (C-03) | Every "is this note gone?" check (`askUnlessMoved`: a save that found its file gone, a note deleted with typing in it) asks the watcher for a walk at once: `vault:reconcile` with `{ now: true }` runs past the 5 s throttle, after any walk in flight, sends what it finds before replying, and calls that arrive while one waits share it (`FileWatcher.walkAndNotifyNow`). The check waits for that walk if it takes longer than the 3 s grace. A folder renamed by another program is followed from two tree reads when every file it held is in the new folder by name, with files added or changed meanwhile allowed (`treeFolderMoves.ts`); a folder holding exactly the old files wins over one holding them among others, and a pairing two folders could make is refused. |
| 2.3 (A-01) | The notes box's "Use theirs (discard mine)" keeps a copy of the draft (the note's frontmatter over it) in `.filo/recovery/<ts>-keep/` first, then a toast names it with Show in folder. With no copy it asks ("Use the other version without a copy?"); Cancel keeps the question and the draft. |
| 2.4 (A-03) | Reload takes a newer version that landed while the typing was being copied (`conflictDisk`, read by the disk-change handler while the note was still in conflict) over the read it started with, unless that one is older by its modification time. |
| 2.5 (C-07) | A followed folder move carries a path's "present" mark to the new path, never its "gone" mark (`moveCaches`), so a later rename onto one of the moved files is still a replace. |
| 2.6 (BL-08) | Measured; see "BL-08" below. |

**Deviations from the plan**

1. **The drain lets a note waiting for its answer through (2.1).** Pairing alone wasn't enough: the outside-rename handler drains every writer before it moves the boards on, and the moved note's typing met the other program's edit in that drain and became a conflict, which counts as a failed write. The drain refused, the tile stayed on the old path, and an error toast said "Couldn't complete the operation". `withDrainedWrites` takes a new `followsMove` scope, passed only by the outside-rename handler: a note whose body waits for the conflict answer doesn't block it there. In-app renames, trash and the rest still refuse on it. Unit-tested both ways.
2. **Not an empty note, and notes only (2.1).** An empty note created as the old one goes is far more often a new placeholder than the old one moved, so it isn't paired. A board or attachment whose bytes changed in the move still needs them to match, as before. The trade-off is in KNOWN_LIMITATIONS #7: two unrelated notes of the same name, one deleted and one created on a free path in the same moment, are followed as a move (relink the tiles; no text is lost).
3. **The walk, not only for failed writes (2.2).** The plan said a failed write asks main to check at once. The walk is asked by `askUnlessMoved`, which also guards the "deleted by another program" question for a note with typing in it, so both are covered. It's a new option of the existing `vault:reconcile` channel rather than a new channel.
4. **Folders match by name only (2.2).** I first kept a size check (at least one file keeping its size), then dropped it, as the plan says: the walk can't follow a note edited under a renamed folder either. By the time it runs, the watcher has already seen the edit at the new path, so the path reads as a file that was there before, and a move onto it as a replace. The tree's pairing by name is the only quick way such a note is followed. What's left is in KNOWN_LIMITATIONS #31: a folder renamed while, in the same moment, one of its notes is edited and another removed.
5. **The notes box: a toast and a confirm (2.3).** Not in the plan: the toast says where the copy went, and the confirm mirrors "Reload without a copy?".
6. **No second read (2.4).** The plan offered "re-read after `keepTyping()`" or "take `conflictDisk`". A read after the copy is an await between the copy and the drop, so keys typed during it would be dropped without a copy; taking `conflictDisk` needs no await.

**New characterisation spec** `agentReorganises.test.ts` (7 cases, registered in the `characterisation-suite` gate), all through the whole app and a real disk: a note moved into a new folder and edited at once, with typing (Keep mine keeps both sides; Reload keeps the typing), and without; a folder renamed while a note is written into it (followed in under 3 s, nothing asks); a one-note folder renamed and its note edited (Reload / Keep mine on the moved note, never "no longer exists"); a folder renamed while one of its notes is deleted (followed by the walk the save asks for); a note merged into a same-named one and deleted (the deleted question, not taken for a move). On the code before this phase, 6 of the 7 fail; the merge case pins that the new pairing doesn't misfire.

**Checks**

| Check | Result |
|---|---|
| `ci:verify`, main checkout (Phase 2 complete, version 0.2.3) | Green in 363 s: lint, knip, svelte-check (918 files, 0 errors), main typecheck, 879 test files (8,648 passed, 5 skipped), build, 91/91 gates. Two earlier runs this phase failed, and each is fixed or explained: the first only the Chromium caret case now in BL-09 (passed 3 of 3 alone); the second only the `ipc-envelope-usage` gate, which caught the walk request dropping its result unchecked (`renameGrace.ts` now uses `invokeOk`, so a failed walk falls back to the grace). |
| E2E with `FILO_E2E_SCALE=1` | 46/47 in 3.9 min. The miss was the Kanban 300 switch-back budget (636 ms against 500 ms), BL-28's known spike; that spec then passed 3 of 3 alone. Nothing in this phase touches Kanban. |
| Hands-on, the built app | `dist/`, scratch profiles, real Electron IPC (which the characterisation suite fakes), driven by Playwright. A note with typing moved into a new `01 Story` folder and rewritten at once: the sidebar showed only `01 Story`, the `Plot` tab stayed open with the typing, and the one toast was "'Plot' was changed by another program … Reload / Keep mine"; Keep mine wrote the typing into `01 Story/Plot.md` and kept the other version in `.filo/recovery/<ts>-keep/`. A folder renamed while one of its notes was deleted (the tree can't pair it): the open note followed in 890 ms with its typing and no toast, through the walk it asked for. No console errors. |
| Corpus | Not run: nothing in the editor or Markdown writing changed. |

**BL-08: measured, no growth, closed without a fix.** The built app (`dist/`, a scratch profile), a note of about 3,000 words open in a Document tab, and another program rewriting the note 600 times, each waited for until the editor showed it. After three forced garbage collections at each checkpoint (Chrome DevTools Protocol), the page's heap read:

| Outside edits | 0 | 25 | 100 | 200 | 300 | 450 | 500 | 525 | 600 |
|---|---|---|---|---|---|---|---|---|---|
| Heap in use (MB) | 13.27 | 14.69 | 15.05 | 15.37 | 15.60 | 15.63 | 15.63 | 15.06 | 15.08 |

DOM nodes (1,789) and event listeners (170) stayed the same throughout. The first 25 loads cost 1.4 MB (code and caches warming up). After that the heap rose about 2 KB a load, levelled at 15.6 MB, then dropped back. That's far below the 0.4 MB a load the unit environment showed, and it's bounded. A separate run of 200 edits gave the same curve. So what the unit environment keeps is most likely jsdom's own, not the app's. BL-08 leaves the backlog.

**New findings:**
- **BL-46** (backlog): a folder renamed while, in the same moment, one of its notes is edited and another removed. The tree can't pair the folders (a name is missing), and the walk reads the edited note's new path as a file that was already there, so the note is reported deleted. Confirmed with a throwaway characterisation spec, and written into KNOWN_LIMITATIONS #31. Hard 3/10: it needs the watcher to tell a path that appeared since the old one was last seen from one that held a file all along, without opening the replace case again.
- BL-28 seen again: one Kanban 300 switch-back spike in the E2E run (see Checks).
- BL-09 gains a case: the Chromium spec "ArrowDown and ArrowUp keep the column" failed once in the first full `ci:verify` of this phase (the caret still on its first line when the wait ran out), then passed 3 of 3 alone. No editor code changed in this phase.

**For you:** close Filo if it's open, then run `npm run preview` once. Settings should read `Filo 0.2.3 (<commit>)`. On the days after, open Filo with `npm start`. Your agent can now move and edit notes while Filo is open; if it moves a note you were typing in, you'll get one Reload / Keep mine question on the moved note.

# Filo backlog: open findings and deferred work

Everything known to be open that no current plan covers, in one place. Start the next implementation plan from here.

**How to use this file**
- When a plan takes an item, move its text into the plan and delete it here.
- When a phase finds something it doesn't fix, add it here (the phase's outcome still records it).
- Keep each entry self-contained: what you see, how to see it, where the code is, a fix idea, and scores.

**Scores** (out of 10)
- **Impact** (bugs): 0/10 = harmless; 5/10 = a real annoyance, or a small change lost now and then; 10/10 = loses or corrupts notes.
- **Useful** (improvements): 0/10 = no gain; 5/10 = a clear improvement you'd notice every week or so; 10/10 = essential.
- **Hard**: 0/10 = minutes; 5/10 = a few days, several files, new tests; 10/10 = weeks, rewriting a major part of Filo.

Last updated 2026-10-08, after Audit-29 Phase 0 ([AUDIT29_IMPLEMENTATION_PLAN_2026-10-08.md](AUDIT29_IMPLEMENTATION_PLAN_2026-10-08.md); the report is [AUDIT29_FULL_AUDIT_2026-10-08.md](AUDIT29_FULL_AUDIT_2026-10-08.md)), which adds BL-42 (the electron-builder advisories `npm audit fix` can't clear) and notes BL-21's push. The plan takes BL-08, BL-21, BL-31, BL-32, BL-35 and BL-41 in later phases; each leaves this file when its phase fixes it. The next new item is BL-43. Before that, last updated 2026-10-07, after the Document tab's page view and zoom, which records BL-41 (quitting after an Apply in Global Defaults still asks about unapplied changes), found while testing it and not fixed. The next new item is BL-42. Before that, last updated 2026-10-06, after Audit-28 Phase 8 ([archive/AUDIT28_IMPLEMENTATION_PLAN_2026-10-04.md](archive/AUDIT28_IMPLEMENTATION_PLAN_2026-10-04.md), all phases done; the report is [archive/AUDIT28_PRE_DAILY_USE_2026-10-04.md](archive/AUDIT28_PRE_DAILY_USE_2026-10-04.md)), which found every audit finding taken by a phase, closed section 5's `notes-2`, and records BL-40 (a new Mind Map tile could land partly under the docked sidebar), found and fixed there. The next new item is BL-41. Before that, after Audit-28 Phase 7, which took and fixed BL-04 (a filter in the search dropped a path's backslashes), BL-05 (a skipped Replace moved on) and BL-10 (test schedulers left state behind), closed section 5's `legacy-8` (the `.filo/` guards and 8.3 short names) and added BL-39 (the board-file fields B-08 leaves for the first board-format step). The next new item is BL-40. Before that, after Audit-28 Phase 6B ([archive/AUDIT28_IMPLEMENTATION_PLAN_2026-10-04.md](archive/AUDIT28_IMPLEMENTATION_PLAN_2026-10-04.md)), which took and fixed BL-02 (opening a Kanban board with no saved view wrote one; a Task List did too), and records BL-37 (switching tabs away from a Raw view lost text typed there that wasn't saved yet) and BL-38 ("Use Default Font Sizes for all Existing Items" left Mind Map link, embed and timer tiles alone), found and fixed there. The next new item is BL-39. Before that, after Audit-28 Phase 6A, which took section 4's #33 (Settings → Recovery, with sizes), records BL-36 (a file picked from Filo's trash for a cover, File tile or background was refused), found and fixed there, and widened BL-09. The next new item is BL-37. Before that, after Audit-28 Phase 5, which took and fixed BL-01 and BL-03, records BL-33 (the formatting toolbar's font box blank in a vault whose `app.json` names no font) and BL-34 ("Copy all problems" never reached the clipboard), found and fixed there, and added BL-35. The next new item is BL-36. Before that, after Audit-28 Phase 4, which added two owner decisions (section 2: removing one card or task, folding a group inside a section), saw BL-28 again, and added no new numbered item, so the next new item is still BL-33. Phase 3's outcome records BL-29 (a space typed in a tab's rename box was lost) and BL-30 (Help → Shortcuts failed with one board in two split panes), found and fixed there, and which added BL-31 and BL-32 and two owner decisions (section 2). The next new item is BL-33. Phase 2 took and fixed BL-06 and added BL-27 and BL-28; BL-27 (spaces typed at the end of a line) was then fixed in the same phase at the owner's request. Phase 1 took and fixed BL-14, and its outcome records BL-25 and BL-26, found and fixed there. Phase 0's outcome records BL-22 to BL-24, found and fixed there. Before that, after the library updates plan's Phase 8 ([archive/LIBRARY_UPDATES_PLAN_2026-10-02.md](archive/LIBRARY_UPDATES_PLAN_2026-10-02.md), all phases done), which closed BL-11 (`npm audit` is 0 since `http-cache-semantics` 4.3.0) and BL-19 (the design doc), and added BL-20 and BL-21. BL-20 (30 MB of unused `node_modules` in the package) was fixed the same day, in that outcome's follow-up. Phase 7 added BL-19, Phase 5 BL-15 to BL-18, Phase 3 BL-14; Phase 2's outcome records BL-12 and BL-13, found and fixed there. Before that, after Audit-27 (all phases done; see [archive/AUDIT27_IMPLEMENTATION_PLAN_2026-10-01.md](archive/AUDIT27_IMPLEMENTATION_PLAN_2026-10-01.md)).

---

## 1. Small findings (bugs and rough edges)

None of these loses data. Scores are estimates made when the item was written down; re-check them when planning.

| # | Finding | Found in | Impact | Hard |
|---|---|---|---|---|
| BL-07 | The Task List's speed budget has the least room of the scale checks | Audit-27 Phase 6 | 1/10 | 4/10 |
| BL-08 | About 0.4 MB of memory kept each time a note is loaded into the same editor (seen in tests) | Audit-26 Phase 2 | 1/10 | 3/10 |
| BL-09 | Some real-disk tests (the watcher, recovery snapshots, one folder-delete undo) and one Chromium caret spec can fail when the machine is very busy | Audit-27 Phase 5 | 0/10 | 2/10 |
| BL-15 | Text typed with a single `~` each side (`a ~one~ b`) shows struck through on GitHub | Library updates Phase 5 | 1/10 | 3/10 |
| BL-16 | A `~` typed right before struck text makes GitHub show the tildes and strike nothing | Library updates Phase 5 | 1/10 | 2/10 |
| BL-17 | A bare web address in text can get a `\` that GitHub's own linking keeps in the link | Library updates Phase 5 | 1/10 | 3/10 |
| BL-18 | Italic, struck-through and coloured text holding `**` reads differently on GitHub | Library updates Phase 5 | 1/10 | 2/10 |
| BL-21 | GitHub's `ubuntu-latest` moves to Ubuntu 26 from 2026-10-19; CI's Chromium install and Linux timings are untried there | Library updates Phase 8 | 0/10 | 1/10 |
| BL-28 | The Kanban 300 "tab comes back in under 0.5 s" scale budget fails now and then on a spike | Audit-28 Phase 2 | 0/10 | 2/10 |
| BL-31 | Kanban's "From Template…" lists board templates too; picking one makes a card from its text and drops its board | Audit-28 Phase 3 | 1/10 | 1/10 |
| BL-32 | A board template can be started only from a Mind Map (Ctrl+T and Insert Template are Mind Map only) | Audit-28 Phase 3 | 1/10 | 2/10 |
| BL-35 | Below about 1,300 px the Task List's Table of Contents opens over the list, and can't be closed | Audit-28 Phase 5 | 2/10 | 2/10 |
| BL-39 | Board files still carry fields nothing reads (a Mind Map's `viewport`, the board's `connections` / `frames` id lists): drop them with the first board-format step | Audit-28 Phase 7 | 0/10 | 1/10 |
| BL-41 | After an Apply in Settings → Global Defaults, quitting (or closing the vault) still asks "Global Defaults has unapplied changes" | Document page view | 2/10 | 2/10 |
| BL-42 | `npm audit` lists 8 moderate advisories in electron-builder's download chain (a development tool), with no fix but a downgrade | Audit-29 Phase 0 | 0/10 | 1/10 |

### BL-07: the Task List speed budget has the least room (Impact 1/10, Hard 4/10)
- **What you see:** nothing yet. In `scaleBudgets.e2e.ts` ("Task List fields are right within 1 s of its rows appearing at vault open"), two timed runs on a quiet machine took 897 ms and 655 ms against the 1,000 ms budget. On a slower or busier machine it may fail.
- **Where:** `src/tests/e2e/scaleBudgets.e2e.ts:97`; the Task List's first render at vault open (rows first, then each row's fields from the vault index).
- **Fix idea:** profile the gap between rows and fields at vault open with `FILO_E2E_SCALE=1`, and look for per-row work that could be batched. Don't loosen the budget to make it pass.

### BL-08: memory kept per reload into the same editor (Impact 1/10, Hard 3/10)
- **What you see:** nothing known in the app. In the unit environment, loading a note into the same editor again keeps about 0.4 MB each time (1,500 loads: 204 → 617 MB), on old and new code alike.
- **Why it might matter:** the app re-loads an open note into its editor on every change from disk (a Syncthing delivery, another editor's save). A long session with a note open while it syncs often could grow.
- **Where:** `src/renderer/lib/editor/noteEditorView.ts` (the reload) and `markdownSync.ts`.
- **Fix idea:** first measure in the built app (a heap snapshot after many disk changes to an open note). Fix only if it grows there.

### BL-09: real-disk tests can miss under heavy load (Impact 0/10, Hard 2/10)
- **What you see:** in a full `ci:verify` on a busy machine, `watcherOwnWriteBytes.test.ts` ("is reported when its bytes differ from ours") or `fileWatcherOwnMoves.test.ts` ("a rename by another program is still reported") can fail once; Audit-28 Phase 3 also saw `fileWatcherSuppressCaseFold.test.ts` ("a sibling file with a similar prefix is NOT swallowed by suppress") fail once that way. Audit-28 Phase 5, with a game running on the PC, saw `fileWatcherOwnMoves.test.ts` (two cases), `watcherOwnWriteReconcile.test.ts`, `watcherSyncEdges.test.ts` and two `recoverySnapshot.test.ts` cases (the retention cap, the tiebreak) time out or miss, and once, on a quieter machine, the characterisation case "the Root Directory is cleared, and undo puts it back" (`folderPinsAndVaultName.test.ts`) got a "Could not read vault tree (ENOENT)" toast from a tree read that met the folder mid-move. Audit-28 Phase 6A saw the Chromium spec "Enter beside a soft break: in a list item" (`editorCaretInChromium.test.ts`) fail once in a full run. All pass alone and on a quiet machine. This affects the tests only, not the app.
- **Fix idea:** give their waits for a real file-system event more room, or wait on the event instead of a fixed time, without loosening what they check. `recoverySnapshot.test.ts` could take the 20 s budget `recoverySnapshotKeep.test.ts` got (BL-26). The tree-read toast is worth a look in the app too: a sidebar refresh that meets a folder mid-move could retry once before saying so.

**BL-15 to BL-18 in common.** Each is a note Filo saves that reads the same in Filo (and opens editable) but reads differently on GitHub, checked against GitHub's own renderer. Nothing is lost in Filo. None occurs in the golden corpus, the toolbar cases, or the 333 notes of the real corpus that open editable. They were found by running 3,000 documents from the round-trip property test's generator through micromark, then the documents that differed through GitHub (the library updates plan's Phase 5 outcome has the counts). BL-15 and BL-16 are pinned under "known differences" in `src/tests/unit/markdownContentElsewhere.test.ts`: a fix makes those cases fail, and each then moves into that test's inputs. BL-17 and BL-18 are outside what micromark, as that test sets it up, can see. Changing what Filo writes here is Markdown-profile work (Track B), where the readings of other apps are weighed together.

### BL-15: single tildes show as strikethrough on GitHub (Impact 1/10, Hard 3/10)
- **What you see:** type `a ~one~ b` in a note. Filo shows it as typed and saves it as typed. GitHub (and any GitHub-flavoured reader) shows "one" struck through: its strikethrough takes one tilde each side as well as two. markdown-it, which Filo reads with, takes only `~~`. Other apps differ again: Pandoc, for one, reads `~one~` as subscript.
- **Where:** typed text goes through `src/renderer/lib/editor/minimalEscapes.ts`, which writes `~` bare wherever markdown-it renders the note the same. `renderedSame.ts` counts an escape added in front of `~` as a change (`EXTENSION_SYNTAX`), so a line from another app keeps its `~sub~`.
- **Fix idea:** escape a pair of single tildes that GitHub would pair (`a \~one\~ b`) only in text typed in Filo, never on a line the file already holds (`minimalEscapes` already writes such lines as the file spells them). Then every app shows the tildes, as Filo does. Decide first whether Filo should keep the GitHub reading instead.

### BL-16: a `~` right before struck text (Impact 1/10, Hard 2/10)
- **What you see:** type `x ~`, then struck-through `a`, then ` y`. Filo saves `x ~~~a~~ y`. markdown-it takes the last two tildes of the three as the opener, so Filo reads it back as typed. GitHub reads a run of three tildes as text: it shows `x ~~~a~~ y` and strikes nothing. The same holds for a `~` right after struck text (`x ~~a~~~ y`). A `~` inside the struck text is already escaped (`~~\~a~~`) and reads the same everywhere.
- **Where:** the strikethrough serialiser and `src/renderer/lib/editor/delimiterRuns.ts` (which already rewrites delimiter runs markdown-it wouldn't read back where they stand), with `minimalEscapes.ts`.
- **Fix idea:** escape a plain-text `~` that touches a `~~` delimiter (`x \~~~a~~ y`), or write such a run as `<s>a</s>`. Add the case to `markdownBodyRoundTrip.test.ts` and move the pinned case in `markdownContentElsewhere.test.ts` into its inputs.

### BL-17: GitHub's linking of a bare address keeps Filo's escape (Impact 1/10, Hard 3/10)
- **What you see:** a web address that is text rather than a link (pasted as plain text, or a line from another app that you then edit) gets a backslash where markdown-it would otherwise pair a `_` or `*` in it with one nearby. `_a https://en.wikipedia.org/wiki/A_(b)` is saved as `_a https://en.wikipedia.org/wiki/A\_(b)`. Filo and markdown-it read the `\_` as `_`. GitHub turns bare addresses into links before it reads escapes, so its link is `https://en.wikipedia.org/wiki/A%5C_(b)`, which is broken, and the backslash shows. Typing an address and a space makes it a link (`<…>`), which isn't affected.
- **Where:** `src/renderer/lib/editor/textEscapes.ts` / `minimalEscapes.ts`. `markdownContentElsewhere.test.ts` leaves GitHub's bare-address linking out on purpose (it also moves text for reasons that have nothing to do with Filo), so it can't see this.
- **Fix idea:** write a bare address that needs an escape inside it as an autolink (`<https://…>`), which every app reads the same, instead of escaping inside it. That changes text into a link in the note, so it needs the same care as `autolinkMarkdown.ts`.

### BL-18: italic, struck-through and coloured text holding `**` (Impact 1/10, Hard 2/10)
- **What you see:** make `2** -` italic, struck through and coloured. Filo saves `<span style="color: …;">*~~2** -~~*</span>`. markdown-it pairs the `~~` first, so Filo reads it back as typed. GitHub follows CommonMark's order: the `**` closes the italic, so it shows `~~2` in italics, then `* -~~*` as text, and nothing struck. micromark happens to agree with markdown-it here, so `markdownContentElsewhere.test.ts` can't see it.
- **Only with all three:** without the colour, or without the strikethrough, Filo escapes the stars (`*~~2\*\* -~~*`, `<span …>*2\*\* -*</span>`), which GitHub reads as Filo does; so does bold with strikethrough in a span (`**~~2\*\* -~~**`).
- **Where:** `src/renderer/lib/editor/minimalEscapes.ts` drops each escape markdown-it doesn't need. Inside the span it finds markdown-it reads the text the same without the `\*\*`, so it drops them; GitHub needs them.
- **Fix idea:** keep a `\*` or `\_` inside text that emphasis and strikethrough both wrap (markdown-it and CommonMark order that pairing differently), or more generally keep an escape whose removal changes how a strict CommonMark reader pairs delimiters. Check the result against GitHub (`gh api markdown -f mode=gfm -f text=…`), since neither markdown-it nor micromark reads this one as GitHub does.

### BL-21: CI's runner moves to Ubuntu 26 (Impact 0/10, Hard 1/10)
- **What you see:** nothing yet. GitHub's notice on CI run 37198999812 (2026-10-04): "The ubuntu-latest label will migrate to Ubuntu 26 beginning October 19, 2026" ([actions/runner-images#14748](https://github.com/actions/runner-images/issues/14748)).
- **What could break:** only CI, never the app. `npx playwright install --with-deps --only-shell chromium` installs system libraries by distribution, and Playwright 1.63 may not know Ubuntu 26's yet. The characterisation cases skipped on Linux (`it.skipIf(onLinux)`) were found timing out on Ubuntu 24.04, and the new image may time differently.
- **Where:** `.github/workflows/ci.yml` (`runs-on: ubuntu-latest` in `verify` and `coverage`).
- **Fix idea:** look at the first `verify` run after 2026-10-19. If it fails in the Chromium install, pin `runs-on: ubuntu-24.04` until Playwright supports the new image, then move back.
- **Audit-29 Phase 0 (2026-10-08)** pushed `main` before the switch, so the last run on Ubuntu 24.04 covers every commit to date and the first run after the 19th tests the new image alone. Audit-29 plan task 0.4 closes this item after looking at that run.

### BL-28: the Kanban 300 switch-back budget fails now and then (Impact 0/10, Hard 2/10)
- **What you see:** nothing in the app. In `scaleBudgets.e2e.ts` ("Kanban 300 opens in under 1 s and its tab comes back in under 0.5 s"), switching back to the 300-card board usually takes about 250 ms, but now and then a run spikes past the 500 ms budget: 562 ms and 722 ms in two of nine runs on 2026-10-05, while Phase 2 was checked.
- **Not a regression:** five runs each against the previous commit's build and Phase 2's gave the same medians (switch back 256 ms and 261 ms, open 424 ms and 416 ms), and the previous build spiked too (an open of 739 ms). A spike is one slow run, not a slower app.
- **Seen again in Audit-28 Phase 4** (671 ms in one full E2E run). Three alternating runs each on the Phase 3 and Phase 4 builds gave a 274 ms median switch-back on both, and the Phase 3 build spiked to 592 ms in one of them.
- **Where:** `src/tests/e2e/scaleBudgets.e2e.ts:74`.
- **Fix idea:** find what the slow runs spend the time on (a trace of a run over budget: garbage collection, a timer catching up, the preview cache), and fix that; or take the best of two switches, as the unit timing checks take the best of three. Don't loosen the budget.

### BL-31: Kanban's "From Template…" lists board templates (Impact 1/10, Hard 1/10)
- **What you see:** a Kanban column's Add Card → From Template… lists every template in `Templates/` whose `boardType` is unset or `kanban`, board templates (with a ```` ```filo-board ```` block) among them. Picking one makes a card from the template's text and title and ignores its board, with nothing to say so.
- **How to see it:** put a board template such as the design doc's Sprint example in `Templates/`, then pick it from a column's From Template….
- **Where:** `components/boards/KanbanTemplatePicker.svelte` (its list), `lib/kanban/kanbanTileCreation.ts` `createTileFromTemplate`.
- **Fix idea:** leave board templates out of the card picker (`parsed.content.boardJson !== null`), or mark them and make the board as the Template Browser does.

### BL-32: a board template can be started only from a Mind Map (Impact 1/10, Hard 2/10)
- **What you see:** the Template Browser (Ctrl+T, or the canvas menu's Insert Template) opens only on a Mind Map, so a board template (which makes a new Kanban board, Task List or Mind Map) is reached only from a Mind Map tab. A Kanban or Task List user has no way to it, and no other place lists board templates.
- **Where:** `components/layout/AppShell.svelte` (`template:open` is `enabled: onMindMap`), `components/modals/TemplateBrowser.svelte`.
- **Fix idea:** let Ctrl+T open the browser on every board and on a Document tab, showing the layout templates (and inserting a Markdown template as a tile) only on a Mind Map; or add "New board from template…" to the New Tab menu.

### BL-35: the Task List's Table of Contents covers the list at laptop widths (Impact 2/10, Hard 2/10)
- **What you see:** at a window about 1,300 px wide or narrower, a Task List's floating Table of Contents first opens over the right part of the list: the filter chips' end, the progress count and the right ends of the rows. It can be dragged and resized but not closed, and its place is saved per board once moved. At 1,366 px and wider it opens beside the list.
- **How to see it:** make a Task List in a window 1,280 px wide (or 1,100 px with the vault sidebar docked).
- **Where:** `src/renderer/lib/tasklist/tocPlacement.ts` (`tocDefaultBounds` falls back to the top-right corner when there is no room beside the list), `src/renderer/components/boards/FloatingTocPanel.svelte`.
- **Not new in Phase 5:** the Phase 4 build does the same at these widths. Phase 5 kept 1,366 px as it was: the docked sidebar pushes the workspace aside only below 1,340 px, where the list had no room beside it anyway.
- **Fix idea:** let the panel fold to its header (a Table of Contents button that shows and hides it, remembered per board), folded at first where there is no room beside the list; or move the list to the left of the panel while it is open.

### BL-39: board-file fields nothing reads (Impact 0/10, Hard 1/10 with the first format step)
- **What you see:** nothing. A Mind Map board file made before Audit-28 Phase 7 holds `board.viewport` (each board's camera is in `.filo/viewports.json`), and every board file holds `board.connections` / `board.frames` id lists, always empty (the file's own `connections` record and `frames` list, beside `board`, are the real ones). Phase 7 stopped new boards writing `viewport` and removed the in-memory project copy of connections and frames that nothing read (audit finding B-08).
- **Why it waits:** the board schema keeps unknown keys (`.passthrough()`) and defaults the id lists, so taking them out of files means rewriting every board: that belongs in the first real board-format step (`MIGRATION_STEPS` in `src/renderer/schema/migrations.ts`), not a change of its own.
- **Fix idea:** the step that first moves boards past format 8 also deletes `board.viewport`, `board.connections` and `board.frames`, and drops the two id lists from `MindMapBoardSchema` (`src/renderer/schema/board.ts`) and `boardDefaults.ts`. Its fixtures (gate `board-migration-steps`) include a v8 board carrying all three; `boardCreationParity.test.ts`, `sprintAFixes.test.ts` and `zodDefaultsSnapshot.test.ts` pin the id lists today.

### BL-41: quitting after an Apply in Global Defaults asks about unapplied changes (Impact 2/10, Hard 2/10)
- **What you see:** open Settings (Ctrl+,), Global Defaults, pick Board Type → Document, change Background Pattern (or Page Layout), press **Apply** (the setting is saved: `.filo/defaults.json` has it). Then quit, with Settings closed or still open: the quit stops at "Global Defaults has unapplied changes … Cancel / Discard them / Apply them". Nothing is lost either way, but the prompt is wrong and a quit by the window's X waits on it.
- **How to see it:** the steps above in the built app; a Playwright run of them against the Audit-28 Phase 8 build (409a697) shows the same prompt, so it isn't new with the page view.
- **Where:** `src/renderer/stores/pendingSettings.svelte.ts` (`hasGlobalChanges` compares the edit copy with the copy's start, re-armed by `startGlobal` after `applyGlobal` in `src/renderer/components/modals/ProjectSettings.svelte`), asked by `src/renderer/lib/settings/settleOpenSettings.ts`. Something writes to the re-armed copy after the Apply: a Global Defaults field's change handler running again on re-render is the first suspect (`src/renderer/components/settings/BoardDefaults.svelte`, the Board Type select).
- **Fix idea:** find which `update(...)` lands after `startGlobal` (log `pendingSettingsStore.update` paths in a component test that applies and re-checks `hasGlobalChanges()`), stop it, and pin it with that test plus an E2E quit after an Apply.

### BL-42: electron-builder's download chain has 8 moderate advisories (Impact 0/10, Hard 1/10)
- **What you see:** nothing in the app. `npm audit` reports 8 moderate advisories, all from one root: `sprintf-js` (denial of service through unbounded precision, [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c)) reached through `roarr` → `global-agent` → `@electron/get` (app-builder-lib's own copy) → `app-builder-lib`, `dmg-builder`, `electron-builder-squirrel-windows` and `electron-builder`. `npm audit --omit=dev` is 0: none of it ships in Filo. It runs only while packaging, on inputs Filo's own build gives it.
- **Why it waits:** every `sprintf-js` version is listed as affected, and npm's only fix is `npm audit fix --force`, which would install electron-builder 26.5.0, a downgrade from 26.15.3 that npm itself calls a breaking change. Audit-29 Phase 0 fixed the one high advisory (`source-map-js` 1.2.2) and left this chain. A plain `npm audit fix` also moves electron-builder from 26.15.3 to 26.17.0 without clearing any of these, so Phase 0 updated `source-map-js` alone.
- **Where:** `package.json` (`electron-builder`), `package-lock.json`.
- **Fix idea:** when an electron-builder release no longer depends on `global-agent` 3 (or `sprintf-js` publishes a fix), update to it and run `npm run package:dir` plus the E2E suite on the package (`FILO_E2E_EXE`). Don't take the forced downgrade.

---

## 2. Decisions waiting on the owner

Scores are estimates made when the item was written down.

| Item | What to decide | Useful | Hard |
|---|---|---|---|
| Tertiary text in the four other themes | Dark, Blueprint, Retro and Nature keep small grey text at 3.0–3.3:1 on the app background and 2.1–2.9:1 on cards and panels (KNOWN_LIMITATIONS #47). Raise them to 4.5:1 as Light was (decision D6)? A darker grey makes the secondary / tertiary difference harder to see. | 2/10 | 1/10 |
| Light's hovered and selected rows | Tertiary text is 4.49:1 and 4.15:1 there, just under 4.5:1. Darken it a touch more, or the hover and selection colours? | 1/10 | 1/10 |
| Tile copy, paste and duplicate (Audit-22 `mindmap-10`) | A new feature. Does a duplicated text tile show the same note, or a copy of the file? | 5/10 | 4/10 |
| The Search panel's Find All popup | The panel now lists the matching notes, grouped, under its box (Audit-28 task 3.9); Find All still opens a second, flat list of every match. Keep both, or drop Find All? | 1/10 | 1/10 |
| Headings for the sidebar's Group By | Group By now orders files group by group (first letter, day, size band, type), but shows no heading over each group, so Group By Name under Sort By Name looks like Sort By Name alone. Add File Explorer-style headings ("A", "Today", "Small", ".md")? | 2/10 | 2/10 |
| Removing one card or task | Removing one Kanban card or Task List task from its board (Delete, or the menu's Remove from board) happens at once, undoable, while one Mind Map tile asks first, because the Mind Map's prompt is also where its note can go to the trash (Audit-28 E-19; Phase 4 made Backspace use that same prompt). Keep it so, ask for one card or task too, or remove one tile at once with an Undo toast and add "Delete from vault…" to the tile menu? | 1/10 | 1/10 |
| Folding a group inside a section | Group By now groups the rows inside each Task List section (Audit-28 task 4.5), with a heading on each group's first row; the old grouped view, which folded each group, is gone. Make a group's heading fold its rows? | 2/10 | 2/10 |

---

## 3. Bigger work, deferred on purpose

| Item | What it is | Useful | Hard | Where it is described |
|---|---|---|---|---|
| Track B1 | Write note bodies without `tiptap-markdown` | 6/10 | 6/10 | Audit-27 plan, "Track B"; KNOWN_LIMITATIONS #32 |
| #17 raw blocks (after B1) | Keep HTML blocks, HTML comments and reference definitions as untouched blocks, so the rest of such a note stays editable | 7/10 | 6/10 | Audit-27 plan, B1; KNOWN_LIMITATIONS #17 |
| Track B2 spike | Try an editor whose document is the Markdown text (CodeMirror 6 live preview); deliver a go / no-go note only | 9/10 for the full change | 5/10 for the spike, 9/10 for the full change | Audit-27 plan, B2 (decision D9) |
| Split the ten files of 900+ raw lines | Along their natural seams, before an urgent fix lands in one. Less pressing since the gate counts code lines: all are under 1,000 lines of code, the closest `TaskListSideToolbar.svelte` with 136 to spare. | 5/10 | 5/10 | Audit-27 review §2, plan Phase 0 |
| A refactor pass on the three allowlisted files | `KanbanSideToolbar` (1,248 lines of code), `TaskItem` (1,180), `TaskListBoard` (1,170). They may only shrink, so changes there must swap lines in place. `KanbanBoard` left the list in Audit-28 Phase 4 (984). | 4/10 | 6/10 | Audit-27 review §2 |
| #34 hard-linked notes read-only | Report a link count above 1 and open the note read-only, as for a symbolic link. Not taken (decision D7); only worth it if hard links are used. | 1/10 | 2/10 | Audit-27 plan 4.7 |

**Owner requirement for Track B (2026-10-02).** Rich formatting is essential and used all the time, so no Track B work may take any of it away:
- text style and headings, font, font size, bold, italic, underline, text colour, highlight, clear formatting;
- alignment, indent, line spacing;
- bulleted, numbered and checklist lists, links;
- spell check.

What that means for each part:
- **B1** must keep all of it by its own pass test: no note opens or saves differently.
- **B2** is a no-go unless a spike shows every one of these working, looking and saving as today, in Document tabs, Kanban cards and Mind Map tiles. The owner writes notes in Filo, not code, so B2's main gain (notes from other apps saved byte for byte, no read-only notes) is small for them. Treat B2 as shelved unless that changes.

---

## 4. Known limitations the Audit-27 review suggested improving

Scores are the review's ([archive/AUDIT27_REVIEW_2026-10-01.md](archive/AUDIT27_REVIEW_2026-10-01.md), section 3); each `#` is a KNOWN_LIMITATIONS entry.

| # | The change | Useful | Hard |
|---|---|---|---|
| #28b | A "recent vault changes" list with Undo, beyond the single tag Undo notification | 6/10 | 6/10 |
| #17b | Clickable bare URLs that stay bare when saved | 5/10 | 4/10 |
| #6 | Minimap: give unchanged tiles a stable identity, so dragging on a large board doesn't redraw every tile (also speeds up connections) | 4/10 | 5/10 |
| #5 | Recognise Filo's own `.filo/` settings saves by their bytes, as boards already are, instead of by timing | 3/10 | 3/10 |
| #7 | Follow an outside rename of a very small or very large attachment by its NTFS file ID | 3/10 | 5/10 |
| #12 | A thin drop strip for the empty "Unsectioned" area above a Task List's first section, shown while dragging | 3/10 | 3/10 |
| #20 | Each machine records its Filo version in `.filo/`; a mismatch warns | 3/10 | 2/10 |
| #24 | A trash retention choice (7 / 30 / 90 days) and its total size in Settings → Trash | 3/10 | 2/10 |
| #31 | File-ID pairing (#7) for local moves; measure Syncthing's timing | 3/10 | 5/10 |
| #35 | Drop an attachment's tags only after it is missing at two opens, or for a week | 3/10 | 3/10 |
| #14 + #15 | Board and settings saves get the notes' main-process "did the file change since I read it?" check | 2/10 | 4/10 |
| #21 | Let the user pick the encoding when converting a non-UTF-8 note | 2/10 | 2/10 |
| #25 | Warn when the vault isn't on a local NTFS drive, where the Recycle Bin hand-off is untested | 2/10 | 3/10 |
| #46 | Board Browser rows: open the board as its own control, not a button holding buttons | 2/10 | 3/10 |
| #42 | Resolve the real path of a file dropped from Explorer, so an 8.3 or junction path is linked, not copied | 1/10 | 2/10 |

---

## 5. Older items to re-check before planning

Nothing is left here. `docs/AUDIT22_PRE_DOGFOOD_2026-09-27.md` stays in `docs/` only for `mindmap-10` (tile copy and paste), which is in section 2. Its two other open items are closed:
- `notes-2` (another program restoring an older copy of Filo's own bytes within about 10 s, taken as Filo's own echo) by Audit-28 Phase 8: the audit found it no longer reproduces for notes (report section 6), and `noteWritePathEdges.test.ts` and `watcherOwnWriteBytes.test.ts` pin both halves (the renderer and the watcher). Filo's own `.filo/` settings saves are still matched by timing (section 4, #5).
- `legacy-8` (the `.filo/` guard and 8.3 short names) by Audit-28 Phase 7 (task 7.1).

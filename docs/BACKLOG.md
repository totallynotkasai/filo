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

Last updated 2026-10-03, after the library updates plan's Phase 5 ([LIBRARY_UPDATES_PLAN_2026-10-02.md](LIBRARY_UPDATES_PLAN_2026-10-02.md)), which added BL-15 to BL-18. Phase 3 added BL-14; Phase 2's outcome records BL-12 and BL-13, found and fixed there. Before that, after Audit-27 (all phases done; see [archive/AUDIT27_IMPLEMENTATION_PLAN_2026-10-01.md](archive/AUDIT27_IMPLEMENTATION_PLAN_2026-10-01.md)).

---

## 1. Small findings (bugs and rough edges)

None of these loses data. Scores are estimates made when the item was written down; re-check them when planning.

| # | Finding | Found in | Impact | Hard |
|---|---|---|---|---|
| BL-01 | The formatting toolbar cuts off its left end at about 1,380 px wide | Audit-27 Phase 3 | 2/10 | 2/10 |
| BL-02 | Opening a Kanban board with no saved view writes one to its file | Audit-27 Phase 5 | 1/10 | 2/10 |
| BL-03 | Escape closes the Search panel only while focus is inside it | Audit-27 Phase 6 | 1/10 | 2/10 |
| BL-04 | With a filter in the search, `C:\foo` loses its backslash | Audit-27 Phase 2 | 1/10 | 2/10 |
| BL-05 | A Replace skipped because the note changed still moves on to the next match | Audit-27 Phase 2 | 1/10 | 1/10 |
| BL-06 | Ctrl+Shift+V of a line ending in two spaces reopens as a hard line break | Audit-27 Phase 4 | 1/10 | 1/10 |
| BL-07 | The Task List's speed budget has the least room of the scale checks | Audit-27 Phase 6 | 1/10 | 4/10 |
| BL-08 | About 0.4 MB of memory kept each time a note is loaded into the same editor (seen in tests) | Audit-26 Phase 2 | 1/10 | 3/10 |
| BL-09 | Two real-file watcher tests can fail when the machine is very busy | Audit-27 Phase 5 | 0/10 | 2/10 |
| BL-10 | A unit test that makes its own write scheduler leaves state behind for the next test | Audit-27 Phase 1 | 0/10 | 1/10 |
| BL-11 | `npm audit` reports 8 high findings in electron-builder's download chain (build time only) | Library updates Phase 0 | 0/10 | 2/10 |
| BL-14 | An empty text tile or Kanban card never shows its "Start typing..." placeholder | Library updates Phase 3 | 1/10 | 1/10 |
| BL-15 | Text typed with a single `~` each side (`a ~one~ b`) shows struck through on GitHub | Library updates Phase 5 | 1/10 | 3/10 |
| BL-16 | A `~` typed right before struck text makes GitHub show the tildes and strike nothing | Library updates Phase 5 | 1/10 | 2/10 |
| BL-17 | A bare web address in text can get a `\` that GitHub's own linking keeps in the link | Library updates Phase 5 | 1/10 | 3/10 |
| BL-18 | Italic, struck-through and coloured text holding `**` reads differently on GitHub | Library updates Phase 5 | 1/10 | 2/10 |

### BL-01: the formatting toolbar cuts off its left end (Impact 2/10, Hard 2/10)
- **What you see:** at a window about 1,380 px wide or narrower, the text-formatting toolbar overflows. Its left end is cut off, so the font box shows only its arrow, and you can't scroll to it.
- **How to see it:** open a note, then narrow the window to about 1,380 px.
- **Where:** `src/renderer/components/layout/TextFormattingToolbar.svelte`, `.toolbar-section.formatting` (`justify-content: center; overflow-x: auto;`). Content centred in a scrolling box spills off both ends, and the left overflow can't be scrolled to.
- **Fix idea:** `justify-content: safe center` (Chromium supports it in flexbox), or auto margins on the first and last child, so an overflowing toolbar starts at its left edge and scrolls. Check the Phase 2 screenshot width and the a11y E2E scan afterwards.

### BL-02: opening a Kanban board with no saved view writes one (Impact 1/10, Hard 2/10)
- **What you see:** nothing on screen. About a second after a Kanban board shows, Filo adds `settings.lastView` (`sortBy`, `filterTags`, `filterProp`) to its `.board.json`.
- **When it happens:** only for a board with no `lastView`. Boards Filo makes already have one, so today that means a board written by hand or by another tool.
- **Why it matters later:** when the first real board-format migration step exists, a migrated Kanban board without a `lastView` would be saved just by opening it. It would still be copied to `.filo/recovery/` first, so nothing is lost, but KNOWN_LIMITATIONS #29's "the file changes only when you change the board" wouldn't hold for it. **Fix before adding the first real step to `MIGRATION_STEPS`.**
- **Where:** `src/renderer/components/boards/KanbanBoard.svelte`, the "lastView persistence" `$effect`. Once the board's filters are hydrated it arms a 300 ms persist through `flushLastViewForBoard` (`lib/boards/lastViewFlush.ts`). That skips a write equal to the stored `lastView`, but a board with none stored never equals the default view, so the default is written.
- **Fix idea:** treat a missing `lastView` as the default view in that comparison, so it is written only once the user changes the sort or a filter. Check the Task List's `lastView` the same way. The E2E `noBytesByLooking.e2e.ts` could gain a hand-written Kanban board with no `lastView`.

### BL-03: Escape closes the Search panel only while focus is inside it (Impact 1/10, Hard 2/10)
- **What you see:** open Search (Ctrl+Shift+F), drag it by its header or click anywhere outside it, then press Escape: nothing happens. The ✕ button works (fixed in Audit-27 Phase 6).
- **Where:** `src/renderer/components/search/SearchPanel.svelte`, `onPanelKeydown` on the panel's `<section>`, so it only hears keys while focus is inside.
- **Fix idea:** while the panel is open, close it on an Escape that nothing else handled. Check first that it doesn't steal Escape from an open dialog, menu, popup, title edit or the canvas selection. `src/tests/e2e/searchPanel.e2e.ts` can take the case.

### BL-04: with a filter in the search, `C:\foo` loses its backslash (Impact 1/10, Hard 2/10)
- **What you see:** a search such as `tag:x C:\foo` searches for `C:foo`. Quoting doesn't help, because the escape is read inside quotes too. A search with no filter (no `tag:`, `board:` …) is taken exactly as typed and isn't affected.
- **Where:** `src/renderer/lib/search/queryParser.ts`, the tokeniser's backslash rule. It treats `\` as an escape whenever the current token already holds a colon, meant for `status:in\:progress`.
- **Fix idea:** honour the escape only for `\:` (a backslash before a colon), and keep every other backslash. Add cases to `queryParser.test.ts`.

### BL-05: a skipped Replace still moves on (Impact 1/10, Hard 1/10)
- **What you see:** if a note changes between Replace reading it and writing it, the write is skipped with a "Replace skipped" warning, but the panel moves on past that match as if it had been replaced. The behaviour predates Audit-27.
- **Where:** `src/renderer/components/search/SearchPanel.svelte` `handleReplaceCurrent` / `runReplaceCurrent`, and `searchStore.showMatchAfterReplace` in `src/renderer/stores/search.svelte.ts`.
- **Fix idea:** on a skipped write, refresh the results and stay on the same match, so the next Replace tries it again on the new text. Add a case to `src/tests/component/searchReplaceShowsNextMatch.test.ts`.

### BL-06: Ctrl+Shift+V of a line ending in two spaces becomes a hard break (Impact 1/10, Hard 1/10)
- **What you see:** paste literally (Ctrl+Shift+V) some text where a line ends in two spaces and another line follows. The file holds `abc··` and a newline, which Markdown, Filo included on reopening, reads as a hard line break. Nothing is lost, but a later save may write it as `abc\`.
- **Where:** `src/renderer/lib/editor/pastePlainText.ts`, `literalTextSlice`. Ctrl+V already drops such spaces, but only at the very end of the paste (`pasteEdges`).
- **Fix idea:** drop the spaces before each line break in a literal paste too. They are invisible, and kept they change the meaning. Add cases to `pastePlainText.test.ts`, with a save and reopen.

### BL-07: the Task List speed budget has the least room (Impact 1/10, Hard 4/10)
- **What you see:** nothing yet. In `scaleBudgets.e2e.ts` ("Task List fields are right within 1 s of its rows appearing at vault open"), two timed runs on a quiet machine took 897 ms and 655 ms against the 1,000 ms budget. On a slower or busier machine it may fail.
- **Where:** `src/tests/e2e/scaleBudgets.e2e.ts:97`; the Task List's first render at vault open (rows first, then each row's fields from the vault index).
- **Fix idea:** profile the gap between rows and fields at vault open with `FILO_E2E_SCALE=1`, and look for per-row work that could be batched. Don't loosen the budget to make it pass.

### BL-08: memory kept per reload into the same editor (Impact 1/10, Hard 3/10)
- **What you see:** nothing known in the app. In the unit environment, loading a note into the same editor again keeps about 0.4 MB each time (1,500 loads: 204 → 617 MB), on old and new code alike.
- **Why it might matter:** the app re-loads an open note into its editor on every change from disk (a Syncthing delivery, another editor's save). A long session with a note open while it syncs often could grow.
- **Where:** `src/renderer/lib/editor/noteEditorView.ts` (the reload) and `markdownSync.ts`.
- **Fix idea:** first measure in the built app (a heap snapshot after many disk changes to an open note). Fix only if it grows there.

### BL-09: two watcher tests can miss under heavy load (Impact 0/10, Hard 2/10)
- **What you see:** in a full `ci:verify` on a busy machine, `watcherOwnWriteBytes.test.ts` ("is reported when its bytes differ from ours") or `fileWatcherOwnMoves.test.ts` ("a rename by another program is still reported") can fail once. Both pass alone and on a quiet machine. This affects the tests only, not the app.
- **Fix idea:** give their waits for a real file-system event more room, or wait on the event instead of a fixed time, without loosening what they check.

### BL-10: test schedulers leave state behind (Impact 0/10, Hard 1/10)
- **What you see:** a unit test that makes its own `createScheduler` leaves its armed-path check registered for the rest of its file, so a scheduler left armed by one test can keep a path "pending" in the next.
- **Where:** `src/renderer/lib/boards/writeScheduler.ts` registers with `registerArmedPathSource` (`src/renderer/lib/boards/writeStateTracking.ts`), which already returns an unregister function that nothing calls.
- **Fix idea:** a `dispose()` on the scheduler that unregisters, used by tests in `afterEach`. `fullSaveKeepsNewerWrite.test.ts` already resets its schedulers by hand.

### BL-11: `npm audit` reports 8 high findings in electron-builder's download chain (Impact 0/10, Hard 2/10)
- **What you see:** `npm audit` lists 9 findings: DOMPurify (low; the library updates plan's Phase 1 fixes it) and 8 high ones, all from one advisory, GHSA-ch52-4w7c-c8xp. `http-cache-semantics` up to 4.2.0, its latest version, can serve one user's cached response to another through `max-stale`. The plan written on 2026-10-02 expected only the DOMPurify one; this advisory appeared since.
- **Where:** `electron-builder 26.15.3 → app-builder-lib → @electron/get 3.1.0 → got 11 → cacheable-request 7 → http-cache-semantics 4.2.0`. It runs only in `npm run package*`, to download Electron and its tools. Nothing in it ships in Filo, and a cache shared between users, which the advisory needs, doesn't exist on a build machine. Electron's own `@electron/get` 5.1.0 doesn't use `got`.
- **No fix in a release yet:** every `http-cache-semantics` version is affected. electron-builder 26.17.0 (the `v26` tag) still uses `@electron/get` 3. `27.0.0-alpha.9` (2026-09-26, the `next` tag) moves to `@electron/get` 5, which drops `got`, so electron-builder 27 fixes it. 27 is already on the library updates plan's "wait" list (pre-release). `npm audit fix --force` would move electron-builder back to 26.5.0, a step backward.
- **Fix idea:** take electron-builder 27 once it is released. Or, sooner, an npm `overrides` giving `app-builder-lib` `@electron/get` 5.x (what 27 does), kept only if `npm run package:dir` still downloads and packs. Until then, a "0 findings" pass test reads as "only GHSA-ch52-4w7c-c8xp, in the electron-builder chain".

### BL-14: an empty text tile or Kanban card never shows its placeholder (Impact 1/10, Hard 1/10)
- **What you see:** a new Kanban card, or a Mind Map text tile whose note is empty, shows a blank body. Nothing tells you to click and type.
- **Why:** the editor does mark the empty paragraph (`data-placeholder="Start typing..."`, from `createTiptapEditor`'s Placeholder), but only the Document editor has CSS that shows it (`DocumentEditor.svelte`, `.tiptap .is-empty::before`), and the Document editor sets its own placeholder to `''` on purpose. Tiles and cards have no such rule. Found in the library updates plan's Phase 3 built-app check; the same before and after the TipTap 3.31.4 update (`@tiptap/extensions` is byte-identical between them).
- **Where:** `src/renderer/lib/editor/createEditor.ts` (`Placeholder.configure`), `src/renderer/components/boards/DocumentEditor.svelte` (the only `attr(data-placeholder)` rule), `TextTile.svelte` / `LazyTextTileBody.svelte`.
- **Decide first:** show it (move the `::before` rule to `style.css` for every note editor, in `--text-tertiary`), or drop the default text so nothing pretends to show one. Showing it fits the design doc's placeholder line ("Placeholder text in empty editors"). Check the axe scan and a Kanban card's static preview (`LazyTextTileBody`) either way.

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

---

## 2. Decisions waiting on the owner

Scores are estimates made when the item was written down.

| Item | What to decide | Useful | Hard |
|---|---|---|---|
| Tertiary text in the four other themes | Dark, Blueprint, Retro and Nature keep small grey text at 3.0–3.3:1 on the app background and 2.1–2.9:1 on cards and panels (KNOWN_LIMITATIONS #47). Raise them to 4.5:1 as Light was (decision D6)? A darker grey makes the secondary / tertiary difference harder to see. | 2/10 | 1/10 |
| Light's hovered and selected rows | Tertiary text is 4.49:1 and 4.15:1 there, just under 4.5:1. Darken it a touch more, or the hover and selection colours? | 1/10 | 1/10 |
| Tile copy, paste and duplicate (Audit-22 `mindmap-10`) | A new feature. Does a duplicated text tile show the same note, or a copy of the file? | 5/10 | 4/10 |

---

## 3. Bigger work, deferred on purpose

| Item | What it is | Useful | Hard | Where it is described |
|---|---|---|---|---|
| Track B1 | Write note bodies without `tiptap-markdown` | 6/10 | 6/10 | Audit-27 plan, "Track B"; KNOWN_LIMITATIONS #32 |
| #17 raw blocks (after B1) | Keep HTML blocks, HTML comments and reference definitions as untouched blocks, so the rest of such a note stays editable | 7/10 | 6/10 | Audit-27 plan, B1; KNOWN_LIMITATIONS #17 |
| Track B2 spike | Try an editor whose document is the Markdown text (CodeMirror 6 live preview); deliver a go / no-go note only | 9/10 for the full change | 5/10 for the spike, 9/10 for the full change | Audit-27 plan, B2 (decision D9) |
| Split the ten files of 900+ raw lines | Along their natural seams, before an urgent fix lands in one. Less pressing since the gate counts code lines: all are under 1,000 lines of code, the closest `TaskListSideToolbar.svelte` with 136 to spare. | 5/10 | 5/10 | Audit-27 review §2, plan Phase 0 |
| A refactor pass on the four allowlisted files | `TaskListBoard` (1,368 lines of code), `KanbanSideToolbar` (1,248), `TaskItem` (1,225), `KanbanBoard` (1,027). They may only shrink, so changes there must swap lines in place. | 4/10 | 6/10 | Audit-27 review §2 |
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
| #33 | Settings → Recovery: list the rescue copies with their sizes, and delete them | 3/10 | 3/10 |
| #35 | Drop an attachment's tags only after it is missing at two opens, or for a week | 3/10 | 3/10 |
| #14 + #15 | Board and settings saves get the notes' main-process "did the file change since I read it?" check | 2/10 | 4/10 |
| #21 | Let the user pick the encoding when converting a non-UTF-8 note | 2/10 | 2/10 |
| #25 | Warn when the vault isn't on a local NTFS drive, where the Recycle Bin hand-off is untested | 2/10 | 3/10 |
| #46 | Board Browser rows: open the board as its own control, not a button holding buttons | 2/10 | 3/10 |
| #42 | Resolve the real path of a file dropped from Explorer, so an 8.3 or junction path is linked, not copied | 1/10 | 2/10 |

---

## 5. Older items to re-check before planning

`docs/AUDIT22_PRE_DOGFOOD_2026-09-27.md` still lists `legacy-8` (the `.filo/` guard and 8.3 short names) and `notes-2` (another program restoring an older copy of Filo's own bytes within about 10 s taken as Filo's own echo) as open. Later audits changed both areas: CLAUDE.md now describes `vaultRelativeWithin` for 8.3 names and junctions, and own-echo matching by the latest write's bytes. Check whether each still reproduces, then close it in that report or move it into section 1. `mindmap-10` is in section 2.

# Audit-25 (Pre-Dogfood): Implementation Plan

Source: [AUDIT25_PRE_DOGFOOD_2026-09-29.md](AUDIT25_PRE_DOGFOOD_2026-09-29.md), the 2026-09-29 audit of `73cb12a`. It used two finder agents and one refuter agent, and the built app was checked against scratch vaults (including a generated 5,000-note vault and a Syncthing delivery simulation). The report has 26 items (A25-01 … A25-26). The high and medium ones were reproduced in the built app or with the real code in a scratch test, and the refuter confirmed or downgraded each one.

The owner's context sets the priorities:
- Windows 11, Syncthing on **one machine**, no other editors;
- all four board types in daily use;
- 500–5,000 notes.

No path loses data in normal use. What remains is:
- notes that reopen **read-only** after ordinary formatting;
- a **Kanban** board that stops showing cards after a click, and freezes with many cards;
- a few metadata bugs that can quietly change tags.

So the order is: what the owner will hit in week one, then speed, then metadata, then rare edges, then polish.

Conventions:
- Paths are relative to the repo root.
- Line numbers are from `73cb12a` and will drift.
- Choices not yet confirmed are marked **DECISION** with a default; the table at the end collects them.
- Each phase leaves a working app, passes `npm run ci:verify`, and is committed on its own.

## Scorecard at audit time, and targets

| Area | Now | After Phase 1 | After Phase 3 | After Phase 6 |
|---|---|---|---|---|
| Notes: write safety | 9 | 9 | 9 | 9 |
| Boards: write safety | 8.5 | 8.5 | 8.5 | 9 |
| Sync and outside changes | 9 | 9 | 9 | 9 |
| Open / close / quit / recovery | 8 | 8 | 8 | 8.5 |
| Error handling and messages | 7 | 7.5 | 7.5 | 8.5 |
| Document editor and Markdown fidelity | 5 | 8 | 8.5 | 8.5 |
| Undo / redo | 8 | 8 | 8.5 | 8.5 |
| Mind Map | 7.5 | 7.5 | 7.5 | 8 |
| Kanban | 4.5 | 6.5 | 8 | 8.5 |
| Task List | 7 | 7.5 | 8 | 8.5 |
| Tags and search | 6.5 | 6.5 | 8 | 8 |
| Performance at 5,000 notes | 7 | 7 | 8.5 | 8.5 |
| UI polish and accessibility | 6 | 6.5 | 7 | 8 |
| Code health and tests | 8.5 | 8.5 | 8.5 | 9 |
| **Overall** | **7** | **7.5** | **8** | **8.5** |

## Phases

| Phase | Scope | Items | Risk | Size | Gate |
|---|---|---|---|---|---|
| 1 | Notes Filo can't read back; the Kanban click | A25-01, 02, 03, 04, 05, 22 | Medium: changes how Markdown is written | L | **Before daily use** |
| 2 | Performance at scale | A25-06, 07, 08 | Medium: Kanban rendering, index reactivity | L | Before a board passes ~100 cards |
| 3 | Metadata correctness | A25-09, 10, 11, 12, 13, 14 | Low–medium | M | Before heavy tag use |
| 4 | Lifecycle edges | A25-15, 16, 17, 18, 19 | Medium: quit path, board writer | M | |
| 5 | UX lows | A25-20, 21, 23, 24, 25, 26 | Low | M | |
| 6 | Hygiene: dead code, duplicates, comments, docs, gates | from the report's Phase 5 list | Low | M | |
| 7 | Real-app regression suite (the E2E rewrite, open since Audit-15) | new | Low (tests only) | M | |
| 8 | Verification, docs, archive | none | None | S | Sign-off |

Size: S under half a day, M a day or two, L several days.

### Order and dependencies

- **1.0 first.** The editor round-trip harness underpins A25-01 … A25-04. A25-05 (Kanban) is independent and can go first as a quick win.
- **A25-07 before A25-08.** Both change how the vault index publishes; A25-08's per-path signals build on A25-07's chunked publishing.
- **A25-06 before Phase 7's scale spec,** which pins its budget.
- **A25-13 and part of A25-20** both touch drop handlers; do A25-13's shared helper first.
- **Phase 6 last among code phases,** so comment and doc fixes describe the final code.

### Cross-cutting rules for every phase

- **Every fix starts with a failing test.**
  - User-visible flows: characterisation specs, through `harness/` only.
  - Editor fidelity: `markdownBodyRoundTrip` / `toolbarFormattingRoundTrip` / the new property test.
  - Everything else: unit or component tests.
  - Confirm the test fails on `73cb12a`, then fix.
- **No note already on disk may be written differently by accident.** Phase 1 changes serialisers. Before and after each serialiser change, run the whole round-trip corpus and a generated vault through `parse → serialise`. Every note that round-tripped non-lossy before must produce byte-identical output after. Only the cases this plan targets may change.
- **Every new invariant gets a gate** in the matching group module (`scripts/gates/<group>.mjs`), proven to bite: plant the violation, see the gate fail, revert.
- **Comments explain why, never history.** `A25-xx` ids go only in commit messages.
- **Docs travel with behaviour.** Update CLAUDE.md and KNOWN_LIMITATIONS.md in the same commit as any behaviour they describe.
- **Real-app check at the end of each phase.** Use the phase's scenarios with the session-scratchpad scripts (`realapp/`) until Phase 7 moves them into the repo. Their lessons:
  - restore the window and turn off background throttling before timing anything (a minimized test window looks frozen);
  - double-click a sidebar row on its name, not its centre (the centre can land on a tag chip, which filters the tree).

---

## Phase 1: Notes Filo can't read back, and the Kanban click

Goal: nothing typed or clicked in Filo produces a note that reopens read-only, and the Kanban board always shows its cards.

### 1.0 · An editor round-trip property test (new; underpins A25-01 … A25-04)

**Why.** Each Phase 1 editor bug is the same failure: Filo serialises a document it can't parse back to the same document. The existing suites test chosen strings and toolbar commands on a lone paragraph, so list, table and code contexts were never exercised. A property test closes the class, not just today's instances.

**Build.**
1. **Generator.** `src/tests/unit/editorRoundTripProperty.test.ts`, using `fast-check` (already a dev dependency). Generate ProseMirror documents from the editor's own schema (`createTiptapEditor(...).schema`):
   - paragraphs and headings with random text, including leading and trailing spaces, tabs, `|`, backticks, `*`, `_`, `[`, `]`, `\`, `<`, `&`, `#`, digits followed by `.`;
   - bullet, ordered and task lists, including empty items, nested lists and adjacent lists of different kinds;
   - tables whose cells hold one paragraph, several paragraphs, or a list;
   - code blocks containing runs of backticks;
   - blockquotes, hard breaks, horizontal rules;
   - marks: bold, italic, code, link, underline, colour.
2. **Property.** `serialise(doc)` → `loadMarkdownIntoEditor` → not lossy, and `serialise(reloaded) === serialise(doc)` (a fixpoint).
3. **Runs.** 500 runs in CI, seeded; failures print the minimal counter-example as Markdown.
4. **Commands.** Also drive the editor's commands in context: `toggleTaskList`, `toggleBulletList`, `toggleOrderedList`, `sinkListItem`, Enter at the end of a list, Shift+Enter, `insertTable`, and typing `[ ] ` at a line start. Apply each inside a paragraph, a list item, a table cell and a heading, then run the same property. This extends `toolbarFormattingRoundTrip`, which today applies toggles only on a lone paragraph.
5. **Corpus.** Keep every counter-example found while fixing as a named case in `markdownBodyRoundTrip.test.ts`, so it is still covered if the generator changes.

**Gate.** `markdownFormat/editor-round-trip-property`: the property test exists, isn't skipped, and runs at least 500 cases (mirrors `toolbar-formatting-saved`).

### A25-01 · Checklists and space-indented paragraphs reopen read-only (HIGH)

**What goes wrong.** tiptap-markdown parses task lists with `markdown-it-task-lists`, which only recognises an item whose text starts with `[ ] ` **with a space after it** (`node_modules/markdown-it-task-lists/index.js`, `startsWithTodoMarkdown`). markdown-it trims the trailing space, so:
- **An empty checkbox** (`- [ ] `) reloads as a bullet with the text `[ ]`. Pressing Enter after the last task and clicking away is enough to create one.
- **A mixed list** is broken both ways. The plugin marks the whole `<ul>` `contains-task-list` when any item is a task, and ProseMirror's `taskList` can hold only `taskItem`s, so a mixed list gains a filler checkbox.
  - Filo writes one bullet converted with Ctrl+Shift+9 as `- a\n\n- [ ] b\n\n- c`, which CommonMark reads as one loose mixed list.
  - A mixed GFM list from another app hits the same problem.
- **A paragraph starting with spaces.** Leading spaces are written raw. CommonMark drops up to three of them, and four or more make an indented code block. The same applies after a hard break and at the start of a list item's text. The tab has an escape for this (`tabNode.ts`, `&#9;`); spaces don't.

In every case, `loadMarkdownIntoEditor` (`lib/editor/markdownSync.ts:205-215`) flags the round trip as lossy and the note opens read-only. **Take ownership** then makes the damage permanent.

**Fix.**
1. **Empty task items parse as tasks.** New `lib/editor/taskItems.ts` with `FiloTaskList = TaskList.extend(...)` and `FiloTaskItem = TaskItem.extend(...)`.
   - Their `addStorage().markdown.parse.setup(md)` registers `markdown-it-task-lists` itself, since overriding `parse` replaces tiptap-markdown's registration.
   - It also adds a core rule `filo-empty-task` **before** `github-task-lists`. For an `inline` token inside `list_item_open > paragraph_open` whose content is exactly `[ ]`, `[x]` or `[X]`, the rule appends a space to the token and its first text child. The plugin then makes it a task with empty text.
   - Register these in place of `TaskList` / `TaskItem` in `createEditor.ts:308-312`.
2. **A mixed list parses without a filler item.** In `FiloTaskList`'s `parse.updateDOM`, split every `ul.contains-task-list` whose `<li>` children mix `.task-list-item` and plain items into consecutive `<ul>` runs: plain runs stay bullet lists, and task runs become task lists. This runs before tiptap-markdown's own `data-type="taskList"` pass.
3. **Adjacent lists are written so they stay separate.** New `lib/editor/listMarkers.ts` with `listMarkerFor(parent, index)`: `-` by default, and the other bullet (`*`) when the previous sibling is a bullet or task list that used `-` (and vice versa). CommonMark starts a new list when the bullet character changes.
   - `FiloBulletList = BulletList.extend(...)` (StarterKit `bulletList: false`) and `FiloTaskList` use it in their `serialize`.
   - The lossy normaliser already maps `*` to `-` on both sides (`markdownSync.ts:267`), so compare is unaffected.
4. **Leading spaces survive.** **DECISION D1** (default: keep them, mirroring the tab).
   - `NoteText.serialize` (`lib/editor/textEscapes.ts`) receives `(state, node, parent, index)`. When the text node is the first inline child of its textblock, or follows a `hardBreak`, and starts with a space, it writes that first space as `&#32;`. One is enough: the line then no longer starts with whitespace.
   - On load, markdown-it decodes the entity to a space, but `tidyParsedWhitespace` (`keepSpaces.ts`) would strip it again, because it can't tell it from indentation. So the parse must mark it. A markdown-it core rule turns a leading `text_special` token with markup `&#32;` (markdown-it 14's entity token) into `html_inline` `<span data-filo-space> </span>`.
   - A `LeadSpace` inline atom (in `tabNode.ts`, or a sibling `leadSpace.ts`) parses that span, renders a space, and serialises back as `&#32;` at a line edge, like `TabChar`.
   - Alternative (D1b): strip leading spaces on save. It's simpler, but the indent the user typed disappears on reopen.
5. **Corpus.** Add every case from the report to `markdownBodyRoundTrip.test.ts`: `- [ ] a\n- [ ] ` (the Enter-after-last-task shape), `x\n\n- [ ] `, the Ctrl+Shift+9-in-a-list output, `- a\n- [ ] b` (foreign mixed), paragraphs with 1, 2 and 4 leading spaces, a leading space after Shift+Enter, and `-   text`.

**Foreign mixed lists (DECISION D2, default: stay read-only).** After step 2, a mixed list written by another app (`- a\n- [ ] b`) loads without the phantom item. Filo would write it back as two lists (`- a\n\n* [ ] b`), a real change to the file's structure, so the lossy check keeps it read-only. Alternative D2b: teach the normaliser that the two shapes are equal, and let Filo rewrite such notes on the next edit.

**Tests.**
- The 1.0 property test and commands.
- Characterisation `editorFidelity.test.ts` (new): type a checklist then Enter then click away, close and reopen the note, and check there is no read-only banner and the file reads `- [ ] first task\n- [ ] ` or better. Same for Ctrl+Shift+9 on the middle bullet, and a paragraph typed with four leading spaces.

**Verify (real app).** `editorB1.mjs`: the Checklist, Mixed and Indent notes reopen editable, with the text as typed.

### A25-02 · A `|` or a list inside a table cell breaks the table (HIGH)

**What goes wrong.** tiptap-markdown's table serialiser (`node_modules/tiptap-markdown/dist/tiptap-markdown.es.js:497-534`) writes each cell with `renderInline(firstChild)` and never escapes `|`. prosemirror-markdown's `esc` (`node_modules/prosemirror-markdown/dist/index.js:821`) doesn't either.
- `isMarkdownSerializable` checks only `childCount > 1`, so a cell holding a single list or heading is "serialisable", and its block content is flattened or broken.
- Result: `| one yes|no | two |` reopens as a paragraph of pipes, read-only, and it is a broken table in any Markdown app.

**Fix.**
1. `FiloTable = Table.extend(...)` in new `lib/editor/tableMarkdown.ts`, with its own `serialize`:
   - A table is written as GFM only when every cell holds exactly one paragraph, the first row is all header cells, no body cell is a header, and no cell spans.
   - Otherwise it falls back to the HTML serialisation tiptap-markdown already uses for merged cells (reuse its `HTMLNode` path, or `getHTMLFromFragment` + an HTML block). That path round-trips: `markdownHtmlMode.test.ts` covers it.
2. `NoteText.serialize` escapes `|` as `\|` while `state.inTable` is set (tiptap-markdown sets it in the table serialiser).
3. **Pipes inside inline code in a cell.** GFM reads `\|` in a code span in a table cell as `|`. Confirm markdown-it 14 does the same with a unit test. If it doesn't, a table with a `|` inside inline code falls back to HTML.
4. Keep column alignment, which the normaliser today leaves lossy on purpose (`markdownSync.ts:281-287`): store `align` from the delimiter row on the cell attrs, and write `:--`, `:-:` and `--:` back. Optional, but it removes another read-only trigger for tables from other apps. **DECISION D10** (default: include).

**Tests.** Property cases for tables (1.0). `markdownBodyRoundTrip` cases: `|` in a cell, `|` in inline code in a cell, a list in a cell, a heading in a cell, an aligned table.

**Verify (real app).** `editorB1.mjs` Table note reopens editable, with `one yes|no` in the cell.

### A25-03 · A code block containing ``` breaks on reopen (MEDIUM)

**What goes wrong.** The codeBlock serialiser always writes a three-backtick fence (`tiptap-markdown.es.js:323-326`). Content containing a ``` line closes the block early. It is also why a `~~~` fence from another app opens read-only: Filo writes it back with backticks.

**Fix.**
1. `FiloCodeBlock = CodeBlockLowlight.extend(...)`, whose `serialize` uses a fence one longer than the longest backtick run in the content (at least three). It keeps the language info string, and keeps tiptap-markdown's `parse.setup` / `updateDOM` (copy them; overriding `markdown` replaces them).
2. In `normaliseForRoundTripCompare`, collapse fence lines `^ {0,3}(`{3,}|~{3,})([^`\n]*)$` to "```" plus the info string, on both sides. Fence style and length are then cosmetic, and `~~~` notes from other apps stop opening read-only (part of A25-22).

**Tests.** Property (1.0) plus cases: content with ```, content with ````, a `~~~` fence with a language.

**Verify (real app).** `editorB1.mjs` Code note reopens editable with the typed ```.

### A25-04 · Task List notes box: multi-line notes reopen read-only (MEDIUM)

**What goes wrong.** The notes box (`TaskItem.svelte:839-851`, `lib/tasklist/notesBox.svelte.ts`) is a textarea over the raw Markdown body, and writes what was typed. A single newline between two lines is a soft break, so the rich editor loads it as a space. The next open of that note as a document or card is lossy and read-only. If a rich view of the note is already open, the check is skipped (`noteEditorView.ts:206`) and that view's next keystroke joins the lines in the file.

**Fix.** **DECISION D4** (default: a newline typed in the box is a line break).
1. `lib/tasklist/notesBoxMarkdown.ts` (new):
   - `boxTextToBody(text)` parses the text with a markdown-it instance configured like the editor but with `breaks: true`, loads it into a headless editor (the `createTiptapEditor` config with no view), and serialises it. Single newlines inside paragraphs become hard breaks (`\` then a newline). Lists, headings and blank-line paragraphs are unchanged.
   - `bodyToBoxText(body)` turns `\` + newline (and two-space hard breaks) back into plain newlines for display.
2. `NotesBox` stores the displayed text. `save()` writes `boxTextToBody(draft)`, and `openedBody` / conflict comparisons use the body form, so the conflict logic is unchanged.
3. Rescue copies (`takeNotesBoxRescueItems`) keep the draft exactly as typed: it is the user's text, and the rescue folder is not re-read by Filo.

**Tests.**
- Unit: `boxTextToBody('line one\nline two')` reloads non-lossy, and `bodyToBoxText` inverts it.
- A list typed in the box is unchanged.
- Component: type two lines in the box, blur, mount a TextTile on the same note: no read-only state, and the lines stay separate.

**Verify (real app).** A Task List note with two lines, opened as a document tab: editable, with two lines.

### A25-05 · After a plain click on a Kanban card, the board stops showing new and moved cards (HIGH)

**What goes wrong.**
- `onCardPointerDown` sets `dragTileId` and snapshots (`lib/kanban/kanbanDragController.svelte.ts:236-255`). Only `onFinalizeCards` → `resetCardDrag` (`:416-424`) clears them.
- svelte-dnd-action sends no event for a press and release without movement (`handleFalseAlarm`).
- The armed `pointerup` only re-locks `cardDragDisabled` (`:243-245`).
- While `dragTileId` is set, `syncCards` (`:209-210`) skips every column. The clicked card keeps the `drag-active` look, filters stop hiding it, and new or moved cards don't render.
- `resetDragState` / `onDragEnd` (`:525-534`) have no callers, and the comment at `:335-336` claims a pointerup reset that doesn't exist.

**Fix.**
1. Add `private dragStarted = false`. Set it in `onConsiderCards` (the library fires `consider` only once a real drag begins), and clear it in `resetCardDrag`.
2. In the `onCardPointerDown` pointerup handler, after re-locking, defer one task (`setTimeout(0)`) so a real drop's `finalize` runs first. Then, if `!this.dragStarted`, call `resetCardDrag()`, and have the host resync (`syncCards` runs from its effect once `dragTileId` is null; make sure the effect depends on it).
3. If a real drag ends outside any zone, the source zone's finalize (`:333-337`) returns early; call `resetCardDrag()` there too. Write the comment to describe what now happens.
4. Delete `resetDragState` / `onDragEnd`, or wire `onDragEnd` if a caller needs it.

**Tests.**
- Unit, controller: pointerdown then pointerup with no consider → `dragTileId === null`. With a consider, then finalize → committed as today.
- Component, KanbanBoard: click a card, press Add Card, and the new card renders (the count of `.kanban-card-shell` equals the badge).

**Verify (real app).** `kanbanB2.mjs`: after one click and Add Card, 3 cards shown, badge 3, 3 on disk, no `drag-active`.

### A25-22 (moved into Phase 1) · The read-only banner says what it can't handle, and points to the Raw view

**What goes wrong.** The banner (`DocumentEditor.svelte:340-344`) says only "formatting it doesn't support". Its one button, Take ownership, rewrites the unsupported part: `[ ]` becomes `\[ \]`, and an indented paragraph becomes a code block. KNOWN_LIMITATIONS #17 understates what triggers it (`5 * 3`, `[TODO]`, `C:\Users`, footnotes, `~~~` fences in notes from other apps).

**Fix.**
1. `loadMarkdownIntoEditor` returns, with `lossy`, the first differing line of the normalised compare: `{ line, original, filo }`.
2. The banner names it: "Line 12 would change from `- [ ] ` to `- \[ \]`".
3. Buttons: **Edit in Raw view** first (switches to the raw view scrolled to that line), then Take ownership.
4. The Take ownership confirm lists up to three lines that will change.
5. Update KNOWN_LIMITATIONS #17 with the fuller list, and remove what Phase 1 fixed.

**Tests.** Unit for the first-difference helper. Component: a lossy note's banner names the line, and the Raw button opens the raw view.

### Phase 1 exit criteria

- `ci:verify` green, with the property test at 500 runs and no failures.
- The serialiser corpus check (cross-cutting rule 2): byte-identical output for every note that was non-lossy before.
- Real app: `editorB1.mjs` all five notes reopen editable; `kanbanB2.mjs` passes.
- Docs updated: CLAUDE.md "Common Gotchas" (list markers, the leading-space escape, table fallback, fence length) and KNOWN_LIMITATIONS #17.

### Phase 1 outcome (2026-09-29)

**Done.** All six items (A25-01, 02, 03, 04, 05, 22), the 1.0 property test and its gate, plus D11's Checklist toolbar button. Every fix started from a test that fails on `73cb12a` (checked by running the new specs in a `73cb12a` worktree).

| Item | Where | Tests |
|---|---|---|
| 1.0 property test | `src/tests/unit/editorRoundTripProperty.test.ts`: 500 generated documents (seed 20260929) plus 72 command-in-context cases (12 commands × 6 contexts). Also run by hand at 1,500 documents on 8 other seeds, all passing. | gate `markdownFormat/editor-round-trip-property` (proved to bite: `NUM_RUNS = 50` fails it); gate count 79 → 80 |
| A25-01 | `lib/editor/taskItems.ts` (`filo-empty-task` rule, mixed-list split, `fillEmptyItemText`), `lib/editor/listMarkers.ts` (`FiloBulletList`, `FiloOrderedList`), `lib/editor/leadSpace.ts`, `lib/editor/textEscapes.ts` | `markdownBodyRoundTrip` named cases; characterisation `editorFidelity.test.ts` (3 cases) |
| A25-02 | `lib/editor/tableMarkdown.ts` (`FiloTable`), `\|` escape in `textEscapes.ts` | named cases (pipe, pipe in code, alignment, list / heading in a cell) |
| A25-03 | `lib/editor/codeFence.ts` (`FiloCodeBlock`), fence normalisation in `normaliseForRoundTripCompare` | named cases (three- and four-backtick lines, `~~~` fence) |
| A25-04 | `lib/tasklist/notesBoxMarkdown.ts`, `notesBox.svelte.ts`, `getBodyPreview` drops a trailing break mark | unit `notesBoxMarkdown.test.ts`; characterisation `taskNotesBox.test.ts` (new case) |
| A25-05 | `kanbanDragController.svelte.ts` (`dragStarted`, click-end check after pointerup), `KanbanBoard.svelte` card-sync effect reads `dragTileId`; dead `resetDragState` / `onDragEnd` deleted | unit `kanbanDragController.test.ts` (3 new, the placeholder test replaced by a real one); characterisation `kanbanClick.test.ts` |
| A25-22 | `roundTripChanges` / `lineOfRoundTripChange` (`markdownSync.ts`), `lib/editor/lossyChanges.ts`, `NoteModel.lossyChanges`, banner + **Edit in Raw view** in `DocumentEditor.svelte`, `NoteRawView.revealLine` | unit `lossyChanges.test.ts`; component `lossyBannerNamesLine.test.ts` |
| D11 | Checklist button in `TextFormattingToolbar.svelte` | component `checklistToolbarButton.test.ts` |

**Serialiser corpus check (cross-cutting rule 2).** 6,150 Markdown files (the repo's own 96 `.md`, the audit's generated vaults including the 5,000-note BigVault, and 3,000 READMEs from `node_modules` as real-world Markdown; the Book Vault wasn't at its last known path) were loaded and serialised by `73cb12a` and by Phase 1. Of the 5,197 that opened editable before, **none** opens read-only now and **5,194** serialise byte-identically. The other 3 differ only because an empty line after a list is now kept (see deviation 6): each file has a list followed by two blank lines, which the old code dropped on the next save. 3 files that opened read-only before now open editable.

**Checks.** `npm run ci:verify` green (729 test files, 6,938 tests; 80/80 gates). Real app (built, driven by Playwright): `editorB1.mjs`: all five notes (Checklist, Mixed, Indent, Table, Code) reopen with no read-only banner, with the text as typed; on disk `- [ ] first task\n- [ ] `, `- a\n\n* [ ] b\n\n- c`, `&#32;   Indented…`, `| one yes\|no | two |` and a four-backtick fence. `kanbanB2.mjs`: after one click and Add Card, 3 cards shown, badge 3, 3 on disk, no `drag-active`.

**Deviations from the plan.**

1. **Lead space (D1) is as planned (entity → span → `leadSpace` atom), with these differences.** A simpler first try (a marker span read as plain text, no atom) failed: ProseMirror drops a whitespace-only text node where no paragraph is open yet (a tight list item's first line), so the atom stays. It lives in `leadSpace.ts`, not `tabNode.ts`. The `filo-lead-space` rule runs before markdown-it's `text_join` (which would merge the entity back into text). A space opening a *bold / italic / strikethrough* run is moved out of the run first (`withLeadSpacesOutsideRuns`), since tiptap-markdown pushes whitespace outside delimiters where Markdown drops it. HTML-written blocks (an HTML table, an aligned paragraph) write the lead space as the atom's span.
2. **The `filo-empty-task` rule runs before markdown-it's `inline` rule, not before `github-task-lists`.** tiptap-markdown re-registers the task-list plugin on every parse (its `setup` runs each time), and `ruler.before('github-task-lists')` would depend on that order. Adding the space to the block token's content before the inline parse is order-independent. The rule and the mixed-list split live in a separate `FiloListParse` extension, so `FiloTaskList` keeps tiptap-markdown's own parse (plugin + `data-type`) and only replaces the writer.
3. **D2 (foreign mixed lists stay read-only) holds for tight mixed lists only.** A *loose* mixed list (`- a`, blank, `- [ ] b`, blank, `- c`), which is exactly what the old Ctrl+Shift+9 wrote, compares equal to Filo's three-list form once `*` normalises to `-`, so those notes now open editable and are split into three lists on their next save. That is the desired outcome for notes the old bug already damaged; it is recorded in KNOWN_LIMITATIONS #17.
4. **Numbered lists got the same treatment** (`FiloOrderedList`, StarterKit `orderedList: false`): Enter twice in a numbered list leaves two lists with an empty line between, which read back as one list. Adjacency now skips empty paragraphs for both bullets and numbers (`1.` then `1)`).
5. **More writers than planned, each found by the property test** (every counter-example is a named case in `markdownBodyRoundTrip.test.ts`):
   - a tight list whose item holds a table, code or quote after its text is written loose (`asWritten`), which is how it reads back;
   - an empty first item of a nested list under a line of text is written `- &#32;` (a bare `-` there made the line above a Setext heading);
   - an empty list item followed by its sub-list gets an empty paragraph at parse (`fillEmptyItemText`), else ProseMirror moved the sub-list out of the item;
   - Shift+Enter in a heading is written `<br>` (`FiloHardBreak`, `hardBreak.ts`), and the break writes the next line's prefix itself;
   - a paragraph writes its prefix before its text: tiptap-markdown's delimiter tidy recorded a bold run's start before a quote's `> ` and cut into it;
   - a quote whose first paragraph is empty no longer leaves a bare `>` line (`FiloBlockquote`, `blockquote.ts`);
   - text escapes (`escapeBlockStart`, `escapeAfterBreak`): a lone `+` or `1.` line, a list / heading / quote marker or `===` / `---` row after a line break (also before a tab), a heading ending in ` #`, and a `!` before a link after an escaped backslash;
   - `ORDERED_PAREN_START` no longer accepts leading spaces (a paragraph opening with a space now starts with `&#32;`).
   These close the same class as A25-01..03 (Filo writing Markdown it can't read back); none changes the bytes of a note that opened editable before (corpus check above).
6. **Empty paragraphs after a list survive** (`encodeEmptyParagraphs` ends a block at its last line with text; markdown-it's list map runs on over the blank lines after it). This is the only output change for already-editable notes (3 of 5,197 in the corpus), and it keeps what the file has.
7. **A25-04 is textual, not a headless-editor round trip.** `boxTextToBody` adds `\` to each paragraph line that continues onto the next, using markdown-it's block map (`markdown-it` is now a direct dependency) to find paragraphs, and leaves everything else as typed. The plan's version (parse with `breaks: true`, load into a headless editor, serialise) would also have rewritten every other construct in the box into Filo's form on each save. `bodyToBoxText` takes the marks off for display; rescue copies keep the draft as typed.
8. **A25-22 line numbers** are in the whole file (as the Raw view shows it), found by matching the round-trip check's normal form of each file line; the changed lines come from trimming the common head and tail of the two normalised texts (no full diff). A line that can't be found reads "A line would change…". The Take ownership confirm lists up to three.
9. **A25-05 step 3 needed no reset**: a drop outside every zone puts the card back in its source zone, whose finalize then takes the no-op path and resets. The source-zone early return is only reached after a drop in another column; its comment now says so.
10. **Dependencies added** (all already installed as transitive dependencies, same versions): `@tiptap/extension-bullet-list`, `@tiptap/extension-ordered-list`, `@tiptap/extension-hard-break`, `@tiptap/extension-blockquote`, `markdown-it`.
11. **The property test's generator leaves out three shapes on purpose**, each commented in the test: whitespace at the end of a line (Markdown drops it, it shows nothing, the lossy check ignores it), a bold / italic / strikethrough run starting mid-word next to punctuation (new finding N1), and inline code with a space at both ends (N2). Its reader editor is cleared before each load, as a note opens (N3).
12. **Characterisation harness additions**: `clickKanbanCard`, `kanbanColumnCounts`, `kanbanColumnsDragActive`, `caretAfter`, `pressInEditor`, `typeKeys`, `leaveEditor`; the two new specs are listed in the `characterisation-suite` gate.

**New findings (out of Phase 1 scope; proposed for Phase 5 or 6).**

- **N1** — tiptap-markdown's delimiter tidy (`trimInline`) shifts a `**` / `*` / `~~` that can't open or close where it sits (mid-word next to punctuation) one character at a time, and can cut into an HTML tag or an entity (`a<~~u>a</u>~~` for strikethrough + underline on part of a word). The note then opens read-only. Fix: write such a run as HTML (`<s>`, `<strong>`, `<em>`) when its delimiter wouldn't flank. KNOWN_LIMITATIONS #32 mentions it.
- **N2** — inline code that starts and ends with a space (or is only spaces) loses one space each side on reload (CommonMark trims it); the note opens read-only. Fix: a code-mark writer that pads such spans. Listed in KNOWN_LIMITATIONS #17.
- **N3** — reloading a note that is only a horizontal rule into an editor, when the file now holds only an empty code block, gives an empty paragraph (pre-existing on `73cb12a`); the note is flagged read-only, so nothing is written. Very narrow; note it for Phase 6.
- **N4** — tiptap-markdown's `setup` calls `md.use(markdown-it-task-lists)` on every parse, so each editor's core rule list gains another copy of `github-task-lists` with every load (read in the source, not measured). A later copy could read a task whose remaining text starts with `[ ] ` as a second checkbox (not reproduced). Filo's own rules are registered once per instance (a `WeakSet`). Candidate for Phase 6.

---

## Phase 2: Performance at scale

Goal, measured in the built app:
- a 300-card Kanban opens in under 1 s, and switching back to its tab takes under 0.5 s;
- in a 5,000-note vault, Task List fields are right within 1 s of the rows appearing;
- an autosave doesn't re-derive other notes' rows.

### 2.0 · Measurement first

Add `scripts/perf/` (not run in CI): a generator for a large vault (from `realapp/genVault.mjs` + `fillBoards.mjs`) and a Playwright `_electron` script that records:
- vault open to sidebar;
- search latency;
- each board type's open and tab-switch time;
- Task List fields-ready time;
- autosave re-derive count.

It must restore the window and turn off background throttling first. Record the baseline in this plan's outcome section before changing anything.

### A25-06 · Large Kanban boards freeze Filo on every open and tab switch (HIGH for large boards)

**What goes wrong.**
- `KanbanCard.svelte:318` renders a full `TextTile` (TipTap editor + `NoteEditorView` + `loadMarkdownIntoEditor`) for every card, in one synchronous Svelte flush.
- The CPU profile at 102 cards: 3.4 s in that flush, with `Editor` construction, `createView`, `loadMarkdownIntoEditor`, `setEditorEditable` and `hasSelection` / `selectionToDOM` dominating. The cost per editor grows with the size of the DOM.
- Measured pauses:

  | Cards | Pause |
  |---|---|
  | 30 | under 1 s |
  | ~100 | 1–3.5 s, every open and every tab switch |
  | 300 | about 22 s, with 215 MB of heap |

**Fix.** **DECISION D3** (default: lazy mount near the viewport, with a static preview).
1. `lib/editor/staticPreview.ts` (new): `renderNotePreviewHtml(body)` uses a module-level markdown-it configured like the editor (`html: true`, task lists, tables). Its output goes through `sanitizeHtml.ts`, and it is cached by body hash. Wrap it in the same `.ProseMirror` / tiptap content classes, so a card looks the same before and after its editor mounts.
2. `components/tiles/LazyTextTileBody.svelte` (new):
   - It renders the preview until the card is within about one screen of the viewport (an IntersectionObserver on the column's scroll container, with a `rootMargin` of one viewport height).
   - Then it queues the real `TextTile` mount on a shared **mount queue**, `lib/editor/editorMountQueue.ts`. The queue mounts at most N editors per animation frame (N from measurement, likely 4–6) and gives priority to cards on screen.
   - A pointerdown or focus on a preview mounts that card at once, and places the caret with `posAtCoords` at the click point once the editor exists.
   - Once mounted, an editor stays mounted until the board unmounts, which keeps editing state simple.
3. `KanbanCard.svelte` uses `LazyTextTileBody` for text cards.
4. **Unsaved-work parity.** A card without an editor holds no unsaved text, so leave, quit and rescue logic is unchanged. A card whose editor is mounted registers as today.
5. **Tab switch.** Boards unmount on switch, so the budget applies again on return, and the preview path makes it cheap. Keeping boards mounted while hidden is out of scope (memory).

**Tests.**
- Component: mount a KanbanBoard with 300 placements. The first flush creates at most 2×N editors (count `.ProseMirror` excluding previews via a data attribute). Scrolling a column mounts more.
- Clicking a preview mounts it and focuses it. Typing saves to the right note.
- A lazily mounted card's title and tags match the note.

**Gate.** `components/kanban-cards-mount-lazily`: `KanbanCard.svelte` must not render `TextTile` directly (it goes through `LazyTextTileBody`).

**Verify (real app).** `recover.mjs` on the 300-card board: answered in under 1 s. `tabswitch.mjs` with 102 cards: switch back in under 0.5 s.

### A25-07 · Task List shows every task as not done for seconds after opening a big vault (MEDIUM) — and a recurring task can be completed for good

**What goes wrong.**
- `vaultIndexStore.rebuild` isn't awaited at open (`vault.svelte.ts:404`) and bumps `version` only in its `finally` (`stores/vaultIndex.svelte.ts:236-270`).
- Task List rows read their fields from the index, so with 5,000 notes the rows appeared at 0.6 s, but completion and priority were blank until about 4.5 s.
- `completionPatchForRow` (`lib/tasklist/frontmatterWriter.ts:47`) decides "roll forward or complete" from `row.recurrence`, which is still empty in that window. So ticking a recurring task then completes it for good.
- The rebuild also runs a full remark parse and adds every note to MiniSearch, yet nothing calls `VaultIndex.query()` and nothing reads the parsed headings or links. Confirm with a grep during the phase.

**Fix.**
1. **Publish progressively.** `indexPathsChunked` bumps `version` after each chunk, throttled to at most once every 150 ms, and exports a reactive `indexing` flag (today's `isBuilding`).
2. **Frontmatter first.** `rebuild` reads each note and records frontmatter, title, tags and body text first, and publishes. Body-derived work comes after, in idle time or on demand.
3. **Decide from the fresh read.** The completion decision is made on the note's fresh frontmatter, in the writer. Add `noteStore.patchFrontmatterFrom(path, (fm) => FrontmatterDelta)`, which computes the delta from the frontmatter the writer just read inside the path's queue. It is the same "apply to a fresh read" principle the writer already uses.
   - `completionPatchForRow` becomes a function of that `fm`, so recurrence is read from the file, never from a possibly empty row.
   - The Kanban "done" column move uses the same path, if it applies recurrence.
4. **Honest loading state.** While `indexing` is true and a row's metadata hasn't arrived, its checkbox, priority and due date show a neutral loading style, not "not done". "Hide completed" and smart lists wait for the metadata rather than showing everything.
5. **MiniSearch and remark.** **DECISION D5** (default: keep MiniSearch in the stack, which CLAUDE.md locks, but build it lazily on first `query()`; drop the remark body parse if no consumer is found). Update CLAUDE.md's `vaultIndex.svelte.ts` / `vaultIndex.ts` rows to say which data is built when.

**Tests.**
- Unit: `rebuild` publishes before it finishes (the version bumps more than once on a 1,000-path fake).
- Unit: completing a recurring task whose index entry is missing rolls it forward (the delta comes from the fresh `fm`).
- Characterisation: open a vault of about 300 notes and tick a recurring task immediately. On disk, the due date moved and `completed` is not `true`.

**Verify (real app).** `taskBlank.mjs`: completion and priority are right within 1 s of the rows appearing.

### A25-08 · Every autosave re-derives every board and all Task List rows (MEDIUM)

**What goes wrong.**
- The note writer's `afterWrite` re-parses the note and calls `restoreMetadata` (`stores/notes.svelte.ts:148` → `vaultIndex.svelte.ts:326-334`), which bumps one global `version`.
- Every consumer that reads `void vaultIndexStore.version` re-runs: each TaskItem's `rawBody` (`TaskItem.svelte:163-168`), the Task List view model, `projectDef` for every tile on every open board, sidebar tag chips, and Tags Browser counts.
- `TaskListRow.svelte:97` calls `getTaskDepth`, which builds a Map of all rows per row (`lib/tasklist/blockMove.ts:51`), so depths are O(n²).
- The sidebar tree isn't virtualised, so expanding a folder of thousands of notes mounts every row.

**Fix.**
1. **Per-path signals.**
   - `vaultIndexStore` keeps a `SvelteMap<VaultPath, number>` of entry versions. `getMetadata(path)` reads that path's entry, so a consumer tracks only the notes it reads.
   - `restoreMetadata`, `applyChanges` and `removePath` bump only the paths they touch.
   - A separate `listVersion` bumps when the set of paths changes or tags are added or removed (the tag-count and search consumers).
2. **Migrate the hot consumers** off `vaultIndexStore.version`: TaskItem `rawBody`, `taskListViewModel`, `projectTile.ts` / `projectDef`, Kanban card fields, the Task List and Kanban filter predicates, and `NoteTagRow` suggestions.
   - Tag counts (`allTagCounts`) and the Tags Browser follow `listVersion`.
   - Grep for `vaultIndexStore.version` afterwards; each remaining use carries a comment saying why it needs every change.
3. **One depth pass per render.** `taskListViewModel` builds the depth map once from the ordered rows and hands `depth` to `TaskListRow` as a prop. `getTaskDepth` stays only for callers without a view model.
4. **Sidebar.** **DECISION D6** (default: measure first). With the 2.0 script, expand a folder of 2,000 notes. If mounting takes over 300 ms, window the flattened visible rows in `VaultSidebar.svelte`, rendering the rows in view plus a margin at a fixed row height. The tree's keyboard navigation (`listKeyNav`) must keep working across the window.

**Tests.**
- Unit: an autosave of note A bumps A's entry and not `listVersion` when A's tags didn't change.
- Component: in a Task List with 400 rows, saving one note re-derives one row (count the derived runs with a test hook).
- Unit: depth map equals `getTaskDepth` for random trees (fast-check).

**Gate.** `components/no-global-index-version`: files under `components/` and `lib/` may read `vaultIndexStore.version` only with an `// allow-global-index-version: <reason>` marker.

**Verify (real app).** With the 2.0 script, typing in a note while a 400-task Task List is open in a split pane: frame times stay under 16 ms.

### Phase 2 exit criteria

- The 2.0 script meets every budget above; before and after numbers are recorded here.
- `ci:verify` green.
- Docs: CLAUDE.md for the index store's reactivity, the Kanban lazy mount and the new gate names.

---

## Phase 3: Metadata correctness

### A25-09 · Undoing a tag rename can re-tag notes that never had the old tag (MEDIUM)

**What goes wrong.**
- The merge check reads only the tag registry, case-sensitively: `fileTagsStore.allTagNames().includes(newName)` (`lib/tags/tagEditConfirm.ts:45-46`, `stores/tagUndo.svelte.ts:216`).
- Tags written by quick-add aren't registered (`lib/tasklist/taskCreation.ts:268`), and the sweep matches case-insensitively.
- So renaming `blocked` → `waiting` while `waiting` exists only in notes is treated as a plain rename. Its Undo then renames **every** `waiting` note to `blocked`.
- The case-only variant: `draft` → `Review` while `review` exists.

**Fix.**
1. `fileTagsStore.tagExists(name)`: case-folded, over the registry ∪ the vault index's tag counts ∪ media-file tags. Use it in `renameTagWithConfirm` and `renameTagWithUndo`, so these are reported as merges (with the "can't be undone" confirm).
2. Undo touches only what the rename changed. `renameTagWithUndo` keeps `outcome.writtenPaths` and the board-only tiles it changed. `undoRename` calls a new `renameTagInPaths(newName, oldName, paths, boardTileIds)`: the same two-phase sweep, restricted to those notes and tiles.
3. Quick-add registers the tags it writes (`taskCreation.ts:268`), as the tag row already does. That prevents the drift at its source.

**Tests.**
- Characterisation `tagUndo`: note A tagged `blocked`, note B tagged `waiting` (not registered). Rename `blocked` → `waiting`: the merge confirm shows. With a plain rename and Undo, B stays `waiting`.
- Unit: `tagExists` is case-folded.

### A25-10 · Kanban mishandles text-form tags (MEDIUM for imported notes)

**What goes wrong.**
- Bulk "Add tag" reads `fm.tags` only as an array and writes `{ tags: [...existing, new] }` (`lib/kanban/kanbanMultiSelect.svelte.ts:198-205`), so `tags: project` becomes `[urgent]`.
- The tag filter spreads `frontmatter.tags` as an array (`lib/kanban/kanbanFiltersAndSort.svelte.ts:61-66`) and throws on a string. The filter is saved with the board, so the board stays broken on reopen.

**Fix.**
1. Bulk add goes through the tag-row writer (`lib/tags/noteTagWriter.ts`, the rewriter that keeps the field's source form), one command per note, batched as today. It is undoable through its own inverse.
2. Filters read tags with `noteTags(path)` (`stores/noteMeta.ts`), or `normalizeTagsField`.
3. Sweep the renderer for other raw `frontmatter.tags` / `frontmatter?.tags` reads and route them the same way.

**Gate.** `codebase/tags-read-through-normaliser`: no `\.frontmatter\??\.tags` outside `normalizeTagsField.ts`, `noteMeta.ts`, `tagRewriter.ts` and `vaultIndex.ts`.

**Tests.** Unit: bulk add on `tags: project` gives `tags: project, urgent` (string form kept) or `[project, urgent]`, per the rewriter's rule. A filter on a board with a string-form note doesn't throw.

### A25-11 · Tag autocomplete: Enter picks the first substring match (LOW–MEDIUM)

**What goes wrong.** `tagSuggestions` (`lib/tags/tagRowInput.ts:64-81`) returns known tags that contain the typed text, in registry order. `NoteTagRow.svelte:41,112-113` preselects the first. So typing `urgent` and pressing Enter adds `not-urgent`.

**Fix.**
- Rank the suggestions: exact (case-folded), then prefix, then substring.
- With no exact match, nothing is preselected: Enter adds exactly what was typed, and ArrowDown picks a suggestion.
- Apply the same to every autocomplete that uses `tagSuggestions` (the Tags popup and the Kanban bulk prompt).

**Tests.** Unit ranking cases. Component: type `urgent` + Enter with `not-urgent` known → `urgent`.

### A25-12 · Replace All is blunter than it looks (LOW–MEDIUM)

**What goes wrong.**
- Matching is always a case-insensitive substring (`lib/search/runSearch.ts:77-83`, flags `'gi'`).
- The confirm counts title matches, which Replace All then skips (`SearchPanel.svelte:163` vs `replaceAllCommand.ts:121`).
- At `MAX_MATCHES` (`runSearch.ts:291`) it replaces a subset and reports success.
- Undo sits on the stack of whichever tab was active.

**Fix.**
1. Add **Match case** and **Whole word** toggles to `SearchPanel`, passed into `buildNeedleRegex`. Whole word uses `\b` for word characters, and Unicode-aware boundaries (`(?<![\p{L}\p{N}_])…(?![\p{L}\p{N}_])` with the `u` flag).
2. The confirm counts only body matches, names up to five files, and says "and N more".
3. When `truncated`, Replace All is disabled, with "Too many matches to replace safely; narrow the search."
4. The success toast carries **Undo**, which undoes that command wherever it sits (the command id is kept on the toast).

**Tests.** Unit for the toggles and the cap refusal. Component for the confirm text.

### A25-13 · Dropping a vault file from Explorer onto a Kanban column or a Task List copies it (MEDIUM)

**What goes wrong.**
- Kanban's OS drop always calls `importKanbanFileTile` → `copyFileIntoVault` (`KanbanBoard.svelte:503`, `lib/kanban/kanbanFileDropHandler.ts:130`).
- The Task List's `importOsMarkdownFile` (`lib/tasklist/fileDropHandler.ts:133-178`) creates a new note from the file's text.
- Only the Mind Map checks `isInsideVault` first (`lib/canvas/dragDrop.ts:186-212`).
- A note already in the vault is duplicated (`Plan (1).md`), and edits go to the copy. (The audit found the Task List case while planning; it wasn't in the report.)

**Fix.**
1. `lib/vault/droppedFiles.ts` (new): `classifyDroppedFile(file, vaultRoot)` returns `{ kind: 'in-vault', relPath }` or `{ kind: 'outside', sourcePath }`, using `isInsideVault` and `vaultRelativeFromAbsolute` from `lib/canvas/vaultPath.ts`.
2. All three boards use it. In-vault files are linked by path, exactly as a sidebar drop is. Outside files are copied or imported as today.
3. Move `isInsideVault` / `vaultRelativeFromAbsolute` to `lib/vault/`, since they aren't canvas-specific. This also retires the duplicate `vaultRelativeFromAbsolute` vs `toVaultRelative` (see Phase 6).

**Gate.** `codebase/os-drops-classify-first`: `copyFileIntoVault` and `createUnique` from a drop handler must follow a `classifyDroppedFile` call in the same function.

**Tests.** Unit for `classifyDroppedFile` (case-folded and 8.3-style paths via the shared path helpers). Component: an in-vault drop on each board type makes no new file.

### A25-14 · Plain-text paste is parsed as Markdown with HTML on; copy-out adds escapes (MEDIUM)

**What goes wrong.** `Markdown.configure({ html: true, breaks: false, transformPastedText: true, transformCopiedText: true })` (`lib/editor/createEditor.ts:317-336`):
- **Pasted plain text:** `<Enter>` / `List<String>` / `<!-- -->` vanish, lines join, and `__init__` becomes bold.
- **Copying out:** gives Markdown source (`C:\\Users`, `5 \* 3`, `a &lt; b`).

**Fix.** **DECISION D7** (default below).
1. **Paste.** Set `transformPastedText: false`, and add a Filo paste plugin (`lib/editor/pastePlainText.ts`). For a `text/plain` paste with no `text/html`:
   - parse it with a markdown-it configured `html: false, breaks: true`, so HTML-like text stays text and every line break is kept;
   - build the slice through the editor's parser.
   Pasting Markdown from another app still gives formatting. **Ctrl+Shift+V** always inserts literal text (paragraphs per blank line, hard breaks per newline).
2. **Copy.** Set `transformCopiedText: false`, so `text/plain` on the clipboard is the text as shown. Filo-to-Filo copy uses the HTML flavour, so formatting still survives.

**Tests.** Unit on the plugin: `List<String>` survives; two lines stay two lines; `**x**` still bolds. Component: copying `C:\Users` yields `C:\Users` in `text/plain`.

### Phase 3 exit criteria

- `ci:verify` green.
- Real app: a tag rename-and-undo scenario, a Kanban bulk add on a string-form note, an Explorer drop of an in-vault note on each board type, a paste of `List<String>`.

---

## Phase 4: Lifecycle edges

### A25-15 · Windows shutdown / restart / sign-out skips the save-before-quit path (LOW)

**What goes wrong.** `main.ts` handles the window `close` (L209), `before-quit` (L472) and SIGINT/SIGTERM (L586-587). Nothing handles `query-session-end` / `session-end`, and Electron doesn't fire `before-quit` when Windows ends the session.

A shutdown the user starts blurs the window first, so fields save. A **forced** restart (Windows Update, the power button) can still drop:
- an unanswered conflict or drift decision;
- unapplied Settings or theme-editor edits;
- retained failed writes;
- a still-focused field.

**Fix.** **DECISION D8** (default: delay shutdown briefly, only while there is something to rescue).
1. `mainWindow.on('query-session-end', (e) => …)`:
   - If the renderer reports unsaved or held work (a new `app:session-ending` round trip that returns `unsavedWork()` plus held decisions), call `e.preventDefault()`.
   - Then send `app:session-ending`.
2. **Renderer (`handleSessionEnding`):**
   - flushes (`saveUntilSettled`, bounded to about 3 s);
   - writes rescue copies (`keepRescueCopies`) for anything still unsaved, including unapplied Settings as `_filo__*.json`;
   - keeps the sentinel;
   - acknowledges.
   There is no dialog, since the user is leaving.
3. **Main** then lets the session end: it stops preventing, and quits with `app.exit(0)` after `stopActiveWatcher`. Windows proceeds, or shows its standard "Filo is preventing shutdown" screen for those few seconds.
4. `session-end` (no chance to delay) runs the same rescue synchronously as far as possible (the renderer fire-and-forget) and writes the quit-failure breadcrumb.
5. KNOWN_LIMITATIONS #4 mentions OS shutdown.

**Tests.**
- Unit: a `decideSessionEnd` pure helper in `main/utils/`, in the style of `windowCloseDecision.ts`.
- Renderer unit: `handleSessionEnding` writes rescue copies for a held note conflict and unapplied settings.
- Manual check in the real app: send `WM_QUERYENDSESSION` to the window with a small PowerShell `SendMessage` helper, then kill the process, and confirm the rescue folder.

### A25-16 · Deleting a board whose last save failed or is held skips the rescue copy (LOW)

**What goes wrong.**
- `deleteBoard` decides with `ctx.flushWrite(boardId).ok` (`stores/boardCacheDelete.ts:121`). `writeScheduler.flush()` (`writeScheduler.ts:575-587`) reports ok when only **retained** writes remain, so the scheduler's drain re-fires the write.
- That re-fired write then no-ops because of `markBoardPathDeleting` (`boardWriteScheduler.ts:249`) and counts as success, so no rescue copy is made.
- For a drift-held board, `removeBoardFromCache` releases the hold (`:97`) but the failed mark and retained entry stay. Quit then warns about a board that is in the trash, and "Quit anyway" shows the "couldn't keep copies" confirm.
- Scratch repro: session scratchpad `finderA/deleteRetained.test.ts.done`.

**Fix.**
1. In `deleteBoard`, "flushed" means `flush().ok && !boardHasUnsavedWrite(boardId) && !isFailed(path) && !isBoardDriftHeld(path)`. Otherwise keep the rescue copy of the cached board, as A24-30 intended.
2. After the trash move succeeds, call `discardBoardWrite(boardId, boardPath, vaultRoot)` (`boardWriteScheduler.ts:151`). That clears the retained entry and the failed mark.

**Tests.** Promote the scratch repro into `src/tests/unit/boardDeleteRescue.test.ts`, with both the EBUSY-retained and drift-held cases asserting a `recovery:keep-unsaved` call and an empty `unsavedWork().failed` afterwards.

### A25-17 · A board loaded without a baseline skips the drift check on its first save (LOW)

**What goes wrong.**
- `loadBoard` offers no baseline when the pre-stat fails or the stats around the read disagree (`lib/boards/boardLoader.ts:474-484`).
- `adoptLoadedBoardBaseline` stamps nothing (`boardBaseline.ts:17`), and `writeBoardFile` skips the drift check when `baseline === undefined` (`boardWriteScheduler.ts:274`).
- The comment at `boardLoader.ts:475-478` claims the next save re-detects.

**Fix.**
- `adoptLoadedBoardBaseline` calls `markBaselineUnverified(path)` when no baseline is offered.
- `writeBoardFile` treats unverified as drifted: it reads, compares to the cache, and asks through the normal drift path.
- Rewrite the comment. This mirrors A24-26 for configs.

**Gate.** Extend `writePath/board-baseline-after-adopt`: `boardBaseline.ts` must call `markBaselineUnverified` on the no-baseline branch.

**Tests.** Unit: a load whose stats disagree, then a save, leads to the drift prompt (not a silent write).

### A25-18 · A `.filo/` settings or shortcuts drift prompt blocks the writer (LOW)

**What goes wrong.**
- `configDrift.ts:179` and `miscConfigDrift.ts:109` await the Reload / Keep local prompt inside the write.
- Quit waits for it, up to the 15 s toast cap, then reports "Save failed … another program may be holding it" (`unsavedMessages.ts:52`).
- Since A24-51/52, boards and raw views instead hold a decision and refuse the write at once.

**Fix.**
1. A `configDriftHold` (`lib/boards/configDriftHold.ts`), mirroring `boardDriftHold.ts`: the writer refuses at once with `CONFIG_DRIFT_HELD` and the scheduler keeps the write retained without re-firing it.
2. The prompt is a held decision (`holdDecision`, kind `config-drift`), so the save popover can re-open it.
3. **Keep local** backs the other version up to `.filo/recovery/<ts>-keep/`, then re-fires. **Reload** reads the file and drops the write.
4. The quit dialog lists it under "Waiting for your decision", with its own cause in `unsavedMessages.ts`.

**Gate.** `writePath/config-drift-held`: the config and misc writers never await a prompt (the same pattern check as `board-drift-held`).

**Tests.** Unit for the hold and the refusal. Characterisation: an outside edit of `app.json` with a pending settings write, then quit, shows "Waiting for your decision", not "Save failed".

### A25-19 · `board:save` / `config:save` have no main-side compare-and-swap (VERY LOW; deferred)

It needs a second writer inside a few milliseconds, which is not this setup. It is the same class as KNOWN_LIMITATIONS #15.

- **Plan:** record it in KL #15, and correct that entry, since the note-side compare-and-swap already lives in main.
- **If done later:** pass the pre-write `{ mtimeMs, size }` (and the hash under 2 MB) into `board:save` / `config:save`, have `atomicWriteFile({ expectStat })` refuse with `STALE`, and route `STALE` into the drift path.

### Phase 4 exit criteria

- `ci:verify` green.
- Real app: board delete with a locked file (hold the file open with a PowerShell `FileStream`), the `WM_QUERYENDSESSION` check, and an outside `app.json` edit before quit.

---

## Phase 5: UX lows

Each item gets a component or unit test unless noted.

### A25-20 · Board behaviour lows

1. **Kanban Lock does nothing but pushes an undo step.**
   - `locked` isn't a Kanban placement field (`schema/placement.ts` `KanbanTilePlacementSchema`), and `tileDefBuilder.ts:160-169` drops a def-level one.
   - **Fix:** add `locked` to `KanbanTilePlacementSchema`, like `TaskPlacementSchema.locked`, and have the lock command write the placement. `boardCacheKanban.ts:70` reads it from there.
   - A locked card can't be dragged; the controller already checks `locked`.
2. **Ctrl+A selects tiles hidden inside collapsed frames** (`components/layout/AppShell.svelte:333-344`), so Delete removes invisible tiles.
   - **Fix:** select-all skips tiles whose frame is collapsed. Delete with a selection that includes hidden tiles says so in its confirm.
3. **Right-click on overlapping Mind Map tiles** takes the last spatial hit (`MindMapBoard.svelte:241`).
   - **Fix:** take the topmost by z-order, the same rule as the left click.
   - First reproduce it in the app; the refuter didn't verify it.
4. **A subtask's `parent:` is a board-local tile id** written into the note (`lib/tasklist/taskCreation.ts:318`, `TaskListBoard.svelte:790`, read in `taskListViewModel.svelte.ts:206-215`). The id means nothing outside that board. **DECISION D9** (default: move the hierarchy into the board file).
   - Add `parentTileId` to `TaskPlacementSchema` and read it first; the hierarchy is board structure, like sections and order.
   - An existing `parent:` in a note is read as a fallback. Filo stops writing it and never removes it (no note write just to migrate).
   - Indent and outdent commands record the placement field, and their undo is unchanged in shape.
   - Alternative D9b: store the parent note's vault path in frontmatter, so the hierarchy carries across Task Lists. That needs a new note-writing cascade when a parent is renamed, like the tag sweep.
5. **`DeleteSectionCommand.undo` re-inserts at an absolute index** (`commands/sectionCommands.ts:210-227`). Use the `sectionMembership` approach A24-10 used for tasks.
6. **The "today" smart list goes stale after midnight** (`taskListViewModel.svelte.ts:151,174,234`). Add a `clock.svelte.ts` rune that ticks at local midnight (and on resume from sleep), read by the view model.
7. **Dropping one note twice onto a Task List makes two rows** (`fileDropHandler.ts:249`). Honour the `duplicate` flag: focus the existing row and toast "Already on this list".
8. **The toolbar Undo / Redo buttons always do board undo** (`GlobalToolbar.svelte:284-288`). When a text editor is focused, or was the last focus inside the active pane, the buttons run that editor's undo, so they match Ctrl+Z. Tooltips say which.

### A25-21 · Sidebar

1. **The top-level manual order never persists.** It is written under `normalizePath(vaultRoot)` (`stores/sidebarOrder.svelte.ts:72`, via `VaultSidebar.svelte:57`) and read under `''` (`lib/vault/vaultTreeSort.ts:61,94`).
   - **Fix:** one key for the root (`''`), plus a one-time read of a root-path key so an order written by the current build isn't lost.
2. **The "Overwrite file?" rename confirm** (`lib/vault/renameVaultEntry.ts:36-44`) is wrong both ways:
   - a case-only rename isn't a clash (`samePath`) and should rename directly;
   - for a real clash, main refuses the rename (`RenameTargetExistsError`, `main/vault/fileOps.ts:288-292`), so the dialog should say "A file named X already exists" with **OK** only.
   - Nothing is ever overwritten; remove the "cannot be recovered" text.

### A25-23 · A board that fails validation shows every schema problem in the toast

`boardLoader.ts:590-592` joins every Zod issue, and `boardLoadFailedNotice.ts:27` shows them all: about 200 KB for a 300-tile board.
- **Fix:** show the first three issues and "and N more". The full list goes to the `.filo/recovery` copy's sibling `…-problems.txt` and to the main log.

### A25-24 · A board that fails to load loses its tab

`hydrateFromWorkspace` drops any tab whose board isn't loaded (`stores/tabs.svelte.ts:467-468`), and `workspace.json` is rewritten without it.
- **Fix:** keep tabs for boards in `unloadedBoards` (failed or locked, not deleted) as placeholder tabs that show the board's error and a Retry button (`adoptBoardAtRuntime`).
- A deleted board's tab still goes.

### A25-25 · Wording

1. **The BatchCommand rollback modal** advises "closing without saving" (`commands/groupAndBoardCommands.ts:37`). Reword it to what Filo actually offers.
2. **Jargon in toasts:** `vaultFolderOps.ts:371/484/495`, `renameCascadeRepair.ts:33`, `tagRewriteSweep.ts:274`, `fileTagsCascade.svelte.ts:204`. Rewrite each in plain terms: what happened, what the user can do.
3. **Gate.** `components/toast-plain-language`: a word list (`sentinel`, `cascade`, `drain`, `baseline`, `IPC`, `envelope`) must not appear in string literals passed to `uiStore.toast` / `pushToast` / `openConfirm`.

### A25-26 · Other lows (reproduce first; fix those that reproduce)

1. **Tags Browser busy guard** doesn't gate double-click rename or the toast buttons. Gate them with `tagSweepProgress.running`.
2. **An audio take is orphaned if its tile is deleted mid-recording.** On tile delete, stop the recorder and either link the take to a restored tile on undo, or move the take to Filo's trash with the tile.
3. **A timer panned off-screen never announces it finished.** Keep running timers out of culling (like `recordingTiles`), or announce from the board-level timer tick.
4. **Editor minors** (each needs a property-test case first; several may already be fixed by Phase 1):
   - Shift+Enter in a heading leaves a stray `\`;
   - a paragraph `1.` becomes an empty numbered list;
   - a horizontal rule inside a list item breaks the list;
   - a typed trailing ` ##` in a heading is lost;
   - blank-line spacing after a list is dropped.

### Phase 5 exit criteria

- `ci:verify` green.
- Real app: a Kanban lock, a sidebar root reorder then relaunch, a case-only rename, a broken board file then fix and Retry from its tab.

---

## Phase 6: Hygiene

No behaviour changes. Each commit is small, and `ci:verify` stays green.

1. **Dead code** (grep-verify each before deleting):
   - `toggleTagFade` (`stores/fileTags.svelte.ts:849`) and `ToggleTagFadeCommand`, `getTagUsageCount`;
   - the global `spatialStore` facade, `isThemeToken`, `vaultStore.setLoading`, `searchStore.togglePanel`;
   - the tileRegistry `name` / `selectable` fields, the unreachable `SideToolbar.svelte:88-115` cases, `workspaceStore.setSidebarWidth` / `sidebarWidth` (and its `workspace.json` field, read and ignored);
   - the unused `role` prop on VaultSidebar / VaultFileItem, the `backupExternalVersion` re-export, `AddSectionCommand`'s legacy params;
   - `toolbarConfig.toggleTaskList`: keep it only if Phase 1 adds a Checklist toolbar button (**DECISION D11**, default: add the button, since checklists are a core feature and today only Ctrl+Shift+9 or typing `[ ] ` reaches them);
   - `fileTagsStore.hydrate()` (test-only, and its catch leaves tags writable): delete, and move its tests to `commitFromCandidate`.
2. **Test-only exports.** `encodeFiloLink` / `FiloLinkSchema`, `parseTagsField` (if unused in app), `clearBaseline`, `SETTINGS_VAR_NAMES`, `vaultStore.setPath` / `setTree`. Mark them `/** @internal test-only */`, or move them to `src/tests/helpers`.
3. **Duplicates:**
   - one tile factory (`stores/tiles.svelte.ts`) and one frame factory. The SideToolbar copies that freeze Global Defaults into new elements (`SideToolbar.svelte:52-155`) go; this is a behaviour fix, so give it a test that a new tile follows a later default change;
   - one date formatter (`lib/utils/dateFormat.ts`), local time; TemplateBrowser uses UTC today;
   - `vaultRelativeFromAbsolute` → `toVaultRelative` (after A25-13);
   - `pinIsUnder` → `isAtOrUnder`;
   - one timer-mode enum in `schema/`;
   - style popups use `createId()`, not `nanoid(6)`.
4. **Stale comments:**
   - `boardWriteScheduler.ts` 43-52 (orphaned doc block), 85, 207-211, 331-333;
   - `boardCacheDelete.ts:137-139`;
   - `boardDrift.ts:7, 67-69`;
   - the `writeStateTracking.ts` header;
   - `taskCommands.ts:26-32`;
   - `groupAndBoardCommands.ts:231-238`;
   - `vault.svelte.ts:365`;
   - `TaskItem.svelte:830-833`: it animates `grid-template-rows`, which also breaks the transform/opacity-only animation rule. Fix the animation (scaleY on an inner wrapper, or no animation under reduced motion) or document the exception.
   Also fix about 20 comments naming removed identifiers (`DocumentState`, `document.svelte.ts`, old reconciler names, `RENDERER_PERMITTED_FILO_PATHS`, `taskListCommands.ts`). A one-off grep list goes in the commit message.
5. **The audit-id gate** (`scripts/gates/codebase.mjs:153-160`) misses `E.11` (`KanbanNewTileModal.svelte:63`) and `(F1 regression?)` (`fileBaselineRegistry.ts:309`).
   - Widen it: `\b[A-Z]\d?\.\d+\b` in comments only, `\bF\d+ regression\b`, and `\bA\d{2}-\d{2}\b`.
   - Prove it bites, then clean the hits.
6. **Pre-swap ordering.** The `boardCache` / `fileTags` / `workspace` / `sidebarOrder` resets rely on module load order to run after `leftBehind`. Give each `runAfter: ['leftBehind']`, plus a gate (`vaultIdentity/pre-swap-after-left-behind`) that checks the declared order.
7. **Drift maps keyed by exact spelling.** `inFlightDriftPrompts` / `inFlightResolutions` in `boardDrift.ts` use raw strings. Key them by `VaultPath` (a case-only spelling difference gives two toasts today).
8. **CLAUDE.md corrections:**
   - BoardRegistry has no toolbar or schema;
   - `getCanvasPointFromEvent` doesn't exist;
   - the quit-failure file is `quit-failure.<machineId>.json`;
   - configs use a 300 ms debounce (viewports 1,500 ms);
   - a Document tab's history is keyed by `tab.boardId` (`PaneView.svelte:72`);
   - plus everything Phases 1–5 changed.
9. **KNOWN_LIMITATIONS.** #4 (OS shutdown, after A25-15), #15 (the compare-and-swap is in main for notes; boards and configs per A25-19), #17 (after Phase 1).

---

## Phase 7: Real-app regression suite (the E2E rewrite)

**Why.** Most of `src/tests/e2e/` `import('/src/…')` inside the page, which only resolves against a Vite dev server, so the weekly Full E2E job has failed since Audit-15. Meanwhile this audit's most useful checks were Playwright scripts driving the **built** app. Put those in the repo, so the next audit (and CI) runs them.

**Build.**
1. **`src/tests/e2e/helpers/app.ts`**, from the scratchpad `realapp/lib.mjs`:
   - `launchBuilt(vault, opts)` starts `dist/main/main.js` with a fresh `--user-data-dir`, stubs `dialog.showOpenDialog` / `showMessageBox` in main (recording boxes, answering from a queue), restores the window and turns off background throttling;
   - `quitLikeUser` (with the `\s+` regex fixed);
   - `openNoteByName` (clicks the row's name, not its centre);
   - `toasts`, `confirmDialogs`, `freshVault`, `generateVault(n)`.
2. **Specs** (each small, one behaviour):
   - `editorFidelity.e2e.ts`: the five editor cases from `editorB1.mjs`, reopened editable.
   - `kanbanClick.e2e.ts`: `kanbanB2.mjs`.
   - `syncDeliveries.e2e.ts`: `syncsim.mjs` (temp file renamed into place with an older mtime; typing race → prompt; conflict copy; `.stversions`; board delivery; quit shows "Waiting for your decision").
   - `quitMinimized.e2e.ts`: `minquit.mjs`.
   - `noBytesByLooking.e2e.ts`: generate 1,000 notes (CRLF, BOM, `02134`), open every board type, quit, SHA-1 compare.
   - `scaleBudgets.e2e.ts` (weekly only): the Phase 2 budgets on a generated 5,000-note vault.
3. **Retire or port the existing dev-server specs.** Port those whose behaviour isn't covered elsewhere (`dailyDriverSmoke`, `preDailyUseRegressionBracket`, `recoveryRelaunch`, `documentOpenNoWrite`) and delete the rest.
4. **Accessibility.** The axe scan fails in Electron (`Target.createTarget: Not supported`). Inject `axe-core`'s source into the page and run `axe.run()` through `evaluate` instead.
5. **Config.** `playwright.config.ts` with `workers: 1`, since parallel Electron instances fight over `DevToolsActivePort`.
6. **CI.** The weekly job runs `npm run build && npm run test:e2e` on `windows-latest`. `scaleBudgets` only runs there.

**Gate.** `codebase/e2e-drives-built-app`: no `import('/src/` in `src/tests/e2e/`.

---

## Phase 8: Verification, docs, archive

1. `npm run ci:verify` and `npm run test:e2e` locally; push and confirm the Linux, Windows and weekly E2E jobs.
2. A real-app pass on a **copy of the Book Vault** inside a Syncthing folder (ask the owner for its location). A week-one checklist:
   - checklists with an empty last item;
   - an indented paragraph;
   - a table with `|`;
   - a Kanban click then Add Card;
   - a 150-card Kanban;
   - tick a recurring task right after open;
   - a tag rename then Undo;
   - an Explorer drop of an in-vault note;
   - paste `List<String>`;
   - quit with a held decision.
3. Record the before and after numbers from the 2.0 script, and each phase's outcome and deviations, in this file.
4. Update the report's scorecard, CLAUDE.md (gate count and new gates), and KNOWN_LIMITATIONS.
5. Move this plan and the report to `docs/archive/`.

---

## Decisions

| # | Question | Default | Alternative |
|---|---|---|---|
| D1 | Leading spaces in a paragraph | Keep them: write the first as `&#32;`, parse it back as a `LeadSpace` atom (mirrors the tab) | Strip leading spaces on save |
| D2 | Mixed bullet/task lists written by other apps | Load without the phantom item; stay read-only (Filo would split the list) | Treat as equal in the lossy compare and let Filo split them on the next edit |
| D3 | Kanban card bodies | Static preview, editor mounted near the viewport through a per-frame mount queue, and at once on click | Static preview until click only (cheaper, but no inline editing without a click first) |
| D4 | Newlines typed in the Task List notes box | Line breaks (hard breaks in the file) | Paragraphs (a blank line per newline) |
| D5 | MiniSearch and the remark body parse at open | Keep MiniSearch (locked stack) but build it lazily; drop the remark parse if unused | Remove MiniSearch and update the locked-stack table |
| D6 | Sidebar virtualisation | Measure first; window the tree only if expanding 2,000 notes takes over 300 ms | Virtualise now |
| D7 | Plain-text paste | Markdown parse with HTML off and line breaks kept; Ctrl+Shift+V for literal text | Always literal text |
| D8 | Windows shutdown with unsaved work | Delay shutdown only while rescue copies are written (about 3 s), no dialog | Never delay; rescue on `session-end` only |
| D9 | Subtask hierarchy | `parentTileId` on the Task List placement (board file); `parent:` in a note read as a fallback, never written | The parent note's vault path in frontmatter, with a rename cascade |
| D10 | Table column alignment | Keep it (store and write `:--` / `:-:` / `--:`) | Leave aligned tables read-only |
| D11 | Checklist toolbar button | Add one (today only Ctrl+Shift+9 or typing `[ ] ` makes a checklist) | Keep it keyboard-only |

Taken in Phase 1, all at their defaults: D1 (with the differences in deviation 1), D2 (a loose mixed list now opens editable, deviation 3), D4 (implemented textually, deviation 7), D10, D11.

## Not included

- **Keeping boards mounted while their tab is hidden** (memory cost). A25-06 makes remounting cheap instead.
- **A second-writer compare-and-swap for boards and configs** (A25-19). Deferred, with KL #15 corrected.
- **Rescue copies on a crash or power loss mid-typing.** The dirty sentinel names the files, which is the existing contract (KL #4).
- **Sync-conflict notices for note conflict copies.** The sticky notice covers board forks, and a note's conflict copy appears in the sidebar as its own file. With one editing machine this should be rare. Revisit if the owner adds a second machine.

## Status

Plan written 2026-09-29.

- **Phase 1: done** 2026-09-29 (see "Phase 1 outcome" for the deviations and four new findings, N1–N4). The report and this plan are committed with it.
- Phases 2–8: not started.

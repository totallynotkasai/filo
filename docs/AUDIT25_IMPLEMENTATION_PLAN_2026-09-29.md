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

### Phase 2 outcome (2026-09-29)

**Done.** A25-06, A25-07 and A25-08, the 2.0 measurement script, and two new gates (82 in all). D3 and D5 taken at their defaults; D6 measured over its threshold and resolved differently (deviation 9).

**Measurements** (built app, `scripts/perf/measure.mjs` on a 5,021-note vault from `scripts/perf/genVault.mjs`; window restored, background throttling off; the machine's display runs at 240 Hz, so an idle frame is 4 ms). "Before" is `cc24ee5` (Phase 1), "after" is this phase's final build. Launch-to-launch noise is about ±150 ms.

| Measure | Budget | Before | After |
|---|---|---|---|
| Kanban 300: open | < 1 s | 21,582 ms (300 editors) | 305–411 ms (0 editors at first paint) |
| Kanban 300: switch back to its tab | < 0.5 s | 24,886 ms | 208–268 ms |
| Kanban 300: long tasks in the 3 s after open | | (the open itself) | 2–9, total 0.5–0.8 s, the longest (0.3–0.4 s) the open itself; 13–14 editors mounted in idle time |
| Kanban 102: open / switch back | | 1,367 / 1,156 ms | 73–114 / 104–109 ms |
| Task List 400: open / switch back | | 493 / 720 ms | 254–334 / 284–438 ms |
| Mind Map 400: open | | 456 ms | 319–412 ms |
| Task List fields right after the rows appear (5,000-note vault open) | < 1 s | 3,489 ms | 749–939 ms |
| Typing in a note beside Task List 400, then its autosave | frames < 16 ms | 1 long task (94 ms) | no long task, longest frame 8–13 ms |
| The same, typing in one of the list's own tasks (`typingtask`, added after the baseline) | frames < 16 ms | not measured | no long task; one 46 ms frame at the autosave |
| Sidebar: expand a folder of 2,000 notes | D6: 300 ms | 585 ms, in one task | first rows 51–81 ms; all 2,000 in 1.25–1.85 s, at most one 55 ms task |
| Search ("dragon castle") | | 89 ms | 74 ms |
| Vault open → sidebar | | 944 ms | 873–955 ms (one run 1,787 ms) |
| JS heap after the board run | | 290 MB | 117–133 MB |

**What changed, by item.**

| Item | Where | Tests |
|---|---|---|
| 2.0 | `scripts/perf/genVault.mjs` (deterministic vault: 5,000 notes, a 2,000-note folder, Kanban 300 / 102, Task List 400, Mind Map 400), `scripts/perf/measure.mjs` (scenarios `boards`, `fields`, `typing`, `typingtask`, `profile`); the old `scripts/gen-perf-vault.mjs` is removed | (not in CI) |
| A25-06 | `components/tiles/LazyTextTileBody.svelte`, `lib/editor/staticPreview.ts` (`renderNotePreviewHtml`, `sanitizeNoteHtml` in `sanitizeHtml.ts`), `lib/editor/editorMountQueue.ts`, `KanbanCard.svelte` (preview body; checklist badge from `noteBody`), `TextTile.svelte` (`onEditorReady`), `KanbanColumn.svelte` (`data-lazy-mount-root`); `lib/utils/keyedReactivity.svelte.ts` (`KeyedSvelteMap`) for the note store's `models` / `overlays` | unit `staticPreview.test.ts`; component `lazyTextTileBody.test.ts` (no editor or read off screen; a press mounts it and typing saves to the note; focus mounts it; at most `MOUNTS_PER_IDLE` per idle batch; an unmounted card leaves nothing queued), `keyedReactivity.test.ts`; gate `components/kanban-cards-mount-lazily` (proved to bite: importing `TextTile.svelte` in `KanbanCard` fails it) |
| A25-07 | `stores/vaultIndex.svelte.ts` (batched publishing every 150 ms while building, `isBuilding`, `prioritize`, board notes read first via `notesOnBoards()` in `boardCache.svelte.ts`), `lib/vault/vaultIndex.ts` (no remark parse, MiniSearch built on first `query()`), `commands/noteFieldCommand.ts` (`forwardFrom`), `lib/tasklist/frontmatterWriter.ts` (`completionPatchForFrontmatter`, every completion decided from the note), loading state in `TaskItem.svelte` / `taskListModel.ts` / `taskListViewModel.svelte.ts` (`fieldsPending`, `noteFieldsKnown`) | unit `recurringCompleteFreshRead.test.ts` (fails with the decision taken from the row, as on `cc24ee5`: the blank row completes the task for good; checked by switching `forwardFrom` off, since `cc24ee5` no longer runs against the uninstalled remark packages), `vaultIndex.test.ts` updated; component `vaultIndexPublishing.test.ts` (a rebuild publishes before it finishes); characterisation `taskFieldsAtOpen.test.ts` |
| A25-08 | `KeyedVersions` per note in `vaultIndexStore.getMetadata`, `listVersion` / `listMetadata()` / `allTags()` for notes and tags; `TaskItem` body via `noteBody`; the view model drops `vaultIndexStore.version` and reuses unchanged row objects; tag counts and the sidebar tag filter on `listMetadata()`; `buildTaskDepths` / `viewModel.taskDepths` for `TaskListRow`; cached `Intl.DateTimeFormat` in `dueDateFormat.ts`; `lib/utils/progressiveCount.svelte.ts` in `VaultFileItem.svelte` | component `vaultIndexPublishing.test.ts` (an autosave of A re-runs A's readers only, not tag readers; with 400 rows showing, one save re-runs one row; a note arriving later reaches its reader; a rename tells both paths); unit `taskDepthMap.test.ts` (fast-check, 300 runs); gate `components/no-global-index-version` (proved to bite: a `void vaultIndexStore.version` in the view model fails it) |

**Deviations from the plan.**

1. **The Kanban freeze wasn't mostly TipTap.** Profiling after the lazy mount showed each editor mount re-running every card on the board: `SvelteMap.get` of a key that isn't in the map subscribes to the whole map, so opening one note (a new `NoteModel`) re-ran every card that had asked about its own not-yet-open note. That made mounting cards one by one quadratic. `KeyedSvelteMap` / `KeyedVersions` (`lib/utils/keyedReactivity.svelte.ts`) give each key its own signal: keys are put into the `SvelteMap`'s underlying `Map` without a reactive write, so `SvelteMap.get` creates a per-key source the reader tracks. `keyedReactivity.test.ts` pins both the Svelte behaviour it works around and the fix. The note store's `models` and `overlays` use it, and so does the vault index (A25-08).
2. **The mount queue runs in idle time, not N editors per animation frame.** Even after deviation 1 an editor mount on a 300-card page costs 20–60 ms, so a per-frame batch still made every frame a long task. The preview already shows the text and a press mounts at once, so a queued mount is never urgent: `requestIdleCallback` (timeout 1 s), at most `MOUNTS_PER_IDLE` (4) per idle period, stopping when under 8 ms remain. "On screen" comes from a second IntersectionObserver with no margin; the scroll root is the column body, marked `data-lazy-mount-root`. `content-visibility` on cards was tried and measured no gain, so it isn't used.
3. **The preview is a `.tiptap` element, not `.ProseMirror`,** so nothing that looks for editors finds it (the editor styles are scoped to `.tiptap`). It is marked `data-note-preview`, is a focusable `role="textbox"`, and joins soft breaks, wraps list-item text in paragraphs and builds TipTap's task-list structure so the swap doesn't move anything. Its limits are KNOWN_LIMITATIONS #39.
4. **A card's checklist badge reads `noteBody(path)`** (the model when open, else the vault index). It read the open model only, which every card had while every card built an editor.
5. **The completion decision lives in the command, not in a new writer API.** `NoteFieldCommand` already reads the note as it stands on its first execute (the model when loaded, else a fresh read of the file) to build its inverse; a command given `forwardFrom` now also decides its change from that read. `buildTaskFieldCommand` gives every completing patch (plain complete or roll-forward) `completionPatchForFrontmatter`, so the single-row and bulk paths both read recurrence from the file. The plan's `noteStore.patchFrontmatterFrom` (deciding inside the writer's queue) would narrow the window further, to the flush itself; the gap between the read and the queued write is milliseconds. The Kanban done-column move doesn't apply recurrence, so it needed nothing.
6. **Publishing is batched, and big batches tell every reader at once.** Per-note publishing as each note was read made a Task List re-derive once per arriving note (fields took 50 s to fill in during the first try). While building, changed notes collect for 150 ms and publish together; a batch of more than 32 notes bumps one shared epoch that every per-note reader also tracks, because Svelte walks everything downstream of each bumped source (300 bumps feeding one list cost 750 ms).
7. **The rebuild reads notes on boards first, and views ask for theirs** (`notesOnBoards()`, `vaultIndexStore.prioritize`): a Task List row or Kanban card whose note isn't read yet asks for it, and the next chunk reads it. Without this the task notes came last in the tree walk and fields lagged 1.9 s.
8. **Row objects are reused when unchanged** (`TaskListViewModel.#lastRows`), so a save, or a batch of notes arriving, re-renders only the rows it changed. `vault.svelte.ts` and `TaskItem.svelte` are at their allowlisted line ceilings (1,467 and 1,481), so their changes were kept line-neutral.
9. **D6: progressive rendering, not windowing.** Expanding 2,000 notes measured 443–585 ms, over the 300 ms threshold. Each folder's drag-to-reorder zone (svelte-dnd-action) needs every row in the page, so windowing would mean a new reorder. A folder instead renders its first 150 rows at once and the rest 150 per idle period (`ProgressiveCount`); reorder waits until all are rendered, as it already does under a search or tag filter. First rows in 51–81 ms, all 2,000 in 1.25–1.85 s, at most one 55 ms task. KNOWN_LIMITATIONS #40.
10. **D5: the remark parse is gone and so are its packages.** Nothing read a note's headings or links, and nothing calls `VaultIndex.query()`. `parseMarkdown` now reads frontmatter with the shared fence parser and the `yaml` package (the note writer's path), and keeps the body as text; `headings` and `links` left `FileMetadata`. `unified`, `remark-parse`, `remark-frontmatter` and `@types/mdast` are uninstalled; MiniSearch stays and is built on the first `query()`. CLAUDE.md's stack table says so.
11. **Found by profiling, fixed on the way:** `formatDueDateAbsolute` built an `Intl.DateTimeFormat` per call (and `chipLocale` ran `supportedLocalesOf` per call); both are cached now.
12. **"Autosave re-derive count" is counted in tests, not in the built app.** The app has no counter hook; `vaultIndexPublishing.test.ts` counts derived runs, and the real-app script records frame gaps and long tasks around the autosave.

**New findings (for later phases).**

- **N5** — `electron.vite.config.mts`'s `manualChunks` still names gray-matter, js-yaml, remark, micromark and unified for a `markdown-tools` chunk; none is in the app now. Phase 6.
- **N6** — typing in the note of a task that is on an open 400-task list still gives one ~46 ms frame at the autosave (the list re-sorts and lays out); no long task. Worth a look if lists grow past a few hundred tasks.
- **N7** — a board's tile projection (`getFullTilesForBoard`) is one derived per board, so a change to one card's note re-projects every card on that board (about 5 ms at 300 cards). Fine now; per-tile projection would be the next step for boards in the thousands.

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

### Phase 3 outcome (2026-09-29)

**Done.** A25-09 … A25-14, D7 taken at its default, two new gates (84 in all), and one pre-existing bug found by the real-app check and fixed (deviation 9).

**Real-app check** (built app, a session-scratchpad Playwright script driving `dist/main/main.js`; an Explorer drop is a real on-disk `File` from a file input, carried by a `drop` event):

| Scenario | Result |
|---|---|
| Rename `blocked` → `waiting`, where `waiting` is only in B.md (not registered) | The merge confirm shows; Cancel leaves A and B as they were |
| Rename `old` → `fresh`, another program then writes E.md with `tags: [fresh]`, Undo | D.md back to `tags: [old]`; E.md keeps `fresh` |
| Drop `Notes/Plan.md` from Explorer onto a Mind Map, a Task List and a Kanban column (and C.md on the Kanban) | Each shows the note; no new `.md` anywhere (no `Plan (1).md`) |
| Kanban bulk "Add tag" `urgent` on C.md (`tags: project`) and Plan.md | C.md: `tags:` list `project`, `urgent`; Plan.md: `urgent` |
| Paste `Use List<String> here\nand <Enter> there` into a note, relaunch, reopen | Shown as pasted on two lines; saved `List&lt;String&gt; here\` + newline; reopens editable, no read-only banner |

**What changed, by item.**

| Item | Where | Tests |
|---|---|---|
| A25-09 | `fileTagsStore.tagInUse` / `tagExists` (case-folded over the registry, the vault index's tags, attachments and board-only tiles); `isMergingRename` in `stores/tagUndo.svelte.ts`, used by `renameTagWithConfirm` (which now waits for the index build first) and `renameTagWithUndo`; a rename records a `TagRenameSnapshot` (notes written, attachments, board-only tiles and filter chips that carried the old name) and `undoRename(snapshot)` changes back only those; quick-add registers the tags it writes (`taskCreation.ts`); the tag-rewrite sentinel records `scoped`, and Resume of a scoped sweep rewrites only its plan (`renameTagEverywhere` / `removeTagEverywhere` take `onlyNotes`) | characterisation `tagUndo.test.ts` (+3: an unregistered tag in a note is a merge; another spelling is a merge; Undo leaves a note tagged with the new name since); unit `tagUndo.test.ts` (`tagExists` case-folded, attachments renamed back only where changed), `tagRewriteSentinel.test.ts` (`scoped` round-trips) |
| A25-10 | Kanban bulk "Add tag" is one `AddPathTagCommand` per card (the tag-row writer, fresh read, the field's own form) in one `BatchCommand`; the Kanban tag filter and find bar read `noteTags(path)`; the Task List's `FIELD_READERS.tags` uses `orderPreservingTagsField` | unit `kanbanTextFormTags.test.ts` (`tags: project` + `urgent` → a list of both; the filter matches a text-form tag and doesn't throw); gate `codebase/tags-read-through-normaliser` (proved to bite: the old filter line fails it) |
| A25-11 | `tagSuggestions` ranks exact → prefix → substring; `preselectedSuggestion` preselects only an exact match, so Enter adds what was typed; `NoteTagRow` and `TagEditor` (the Tags popup) both use them | unit `tagRowInput.test.ts` (ranking, preselect); characterisation `tagRowAndRawView.test.ts` (+1: typing `urgent` + Enter with `not-urgent` known adds `urgent`; fails on the old row) |
| A25-12 | `buildNeedleRegex(needle, { matchCase, wholeWord })` (whole word: `(?<![\p{L}\p{N}_])…(?![\p{L}\p{N}_])` with `u`); Match case / Whole word checkboxes in `SearchPanel` (search store `matchCase` / `wholeWord`, cleared by `reset()`); `lib/search/replaceAllText.ts` (confirm body: body matches only, up to five notes named, "…and N more", title matches said to be skipped; `TOO_MANY_TO_REPLACE`); Replace All disabled and refused when `truncated`; the success toast's Undo calls `historyStore.undoFromToast` | unit `replaceAllText.test.ts` (wording, `replaceableMatches`, the regex options), `replaceAllCommand.test.ts` (+3: options narrow the replace; a capped list writes nothing; the toast's Undo works from another tab with a step on top); component `searchReplaceAllConfirm.test.ts` (the real panel's confirm text; the Match case checkbox) |
| A25-13 | `lib/vault/droppedFiles.ts`: `classifyDroppedFile` → `InVaultDrop` / `OutsideDrop` / null, plus `isInsideVault`, `vaultRelativeFromAbsolute`, `resolveDroppedFilePath` (moved from `lib/canvas/vaultPath.ts` and `dragDrop.ts`; the old file is gone); Mind Map, Kanban and Task List drops link an in-vault file by path; `importKanbanFileTile` and the Task List's `importOsMarkdownFile` take an `OutsideDrop` | unit `droppedFiles.test.ts` (was `vaultPath.test.ts`; +4 for `classifyDroppedFile`); characterisation `explorerDrops.test.ts` (new: an in-vault note dropped on each board type makes no new file, fails with classification switched off; an outside note is copied); gate `codebase/os-drops-classify-first` (proved to bite twice: dropping the `OutsideDrop` parameter type from either copier fails it) |
| A25-14 | `lib/editor/pastePlainText.ts` (`PastePlainText`: a second parser of the same class as tiptap-markdown's, `html: false, breaks: true`; Ctrl+Shift+V → `literalTextSlice`); `transformPastedText: false`, `transformCopiedText: false` in `createEditor.ts` | unit `pastePlainText.test.ts` (tag-like text kept, two lines stay two, `**x**` still bolds, Ctrl+Shift+V literal, copy-out `C:\Users` / `5 * 3` / `a < b` as shown; 4 of 5 fail with the old configuration) |

**Deviations from the plan.**

1. **A25-09: the undo is scoped by a snapshot, not a new `renameTagInPaths`.** The existing sweep already took a path filter, so `undoRename(snapshot)` runs `runTagRewriteSweep(new, old, root, writtenPaths)` and then changes back, in memory, only the attachments, board-only tiles and filter chips the snapshot names; the old name's definition comes back with its colour, and the new name's is dropped unless something carries it since. A failed note offers Retry of just the failed notes.
2. **A25-09: a crash mid-undo resumes scoped.** The tag-rewrite sentinel gained `scoped`, so the next open's Resume rewrites only the plan's notes; without it, Resume of an interrupted undo would have renamed every note carrying the new name (the bug again, through recovery). `vault.svelte.ts` stayed at its line ceiling.
3. **A25-09: a different spelling of the same tag is not a merge** (`draft` → `Draft`), since the sweep treats spellings as one tag.
4. **A25-10: the gate also allows a raw read handed straight to a `*TagsField(...)` normaliser and assignments building a new note** (`fm.tags = […]` in quick-add), and exempts `markdownSync.ts`, whose assembler only drops an empty `tags: []` it is writing. The sweep found one more reader: the Task List's own `FIELD_READERS.tags`, which split text on spaces too (`tags: Book 1` was two tags there and one everywhere else); it now uses the shared normaliser.
5. **A25-11: the Kanban bulk prompt has no autocomplete** (`TagPromptPopup` is a plain field), so nothing changed there. The Tags popup's `TagEditor` had its own copy of the substring list; it now uses `tagSuggestions`, and a chosen suggestion replaces only the entry being typed (`completeLastEntry`) instead of dropping the rest of a comma list.
6. **A25-12: Undo from the toast drops the command rather than moving it to a redo stack** (KNOWN_LIMITATIONS #43); Ctrl+Z on its own tab still undoes it with a redo. The toggles apply to free text only; a `/regex/` keeps its own flags. `reset()` now clears them (a Clear or a vault swap starts plain). The confirm test mounts the real panel (component) and the wording has its own unit test.
7. **A25-13: 8.3 / junction spellings aren't resolved.** The renderer sees only the path Explorer reports; the shared helpers compare case-insensitively and across separators, but can't expand `C:\MYVAUL~1`. Such a drop is copied, as before (KNOWN_LIMITATIONS #42). A file with no OS path now gets "Could not read dropped file" on the Task List too (it used to import by content), as the Mind Map already did. The sidebar's own OS drop onto a folder (`VaultFileItem.svelte`) still copies: dropping a file onto a folder reads as "put a copy here", and it isn't a board. `KanbanBoard.svelte` shrank 20 lines, and its allowlist ceiling was lowered to 1,416.
8. **A25-14: tests are unit tests on a real editor** (`createTiptapEditor`) rather than a component mount; the paste goes through ProseMirror's own `clipboardTextParser` prop and the copy through `view.serializeForClipboard`. The paste parser is built from the class of tiptap-markdown's parser (the package doesn't export it), so every Filo extension's Markdown setup applies to pastes too.
9. **Found by the real-app check, fixed: Enter couldn't confirm a tag merge.** Enter in the Tags Browser's rename field opened the merge confirm, which focuses Cancel; Chromium then delivered the same key's `keypress` to that button, so the confirm closed at once and nothing was merged. It predates this phase (a registered-tag merge did the same) and jsdom doesn't reproduce it. The field now calls `preventDefault()` on Enter; component `tagsBrowserRenameEnter.test.ts` pins that.
10. **Harness:** the characterisation `RecordingDataTransfer` lists `Files` when it carries files, and the bridge's `getPathForFile` returns the path `dropFromExplorer` recorded and registers it with main as an approved copy source, as the preload does.

**New findings (for later phases).**

- **N8** — the same Enter-then-`keypress` hazard can reach any in-app confirm opened from an Enter `keydown` that doesn't `preventDefault` (a text field that opens a confirm on Enter). Worth a sweep in Phase 5 or a gate in Phase 6.

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

### Phase 4 outcome (2026-09-29)

**Done.** A25-15 … A25-18 fixed, A25-19 recorded (deferred as planned), D8 taken at its default, one gate added and one extended (85 in all). `ci:verify` green (748 test files, 7,035 tests; 85/85 gates).

**Real-app check** (built app, a session-scratchpad Playwright script driving `dist/main/main.js`; `WM_QUERYENDSESSION` sent with a PowerShell `SendMessage` to the window's native handle):

| Scenario | Result |
|---|---|
| Board file held open with a `FileStream` (share None), a tile added: the save fails and is kept; lock released; board deleted from the Board Browser | The kept write lands first: the trashed board has both tiles, no rescue copy needed, quit exits with no dialog |
| Board changed by another program while a Filo edit waits (the drift question shows); board deleted | Rescue copy `.filo/recovery/<ts>-unsaved/Mind Map 1.board.json` holds Filo's 2 tiles; the trash holds the other program's version; quit exits with no dialog |
| Text typed in a note, the note deleted outside Filo, then `WM_QUERYENDSESSION` | `SendMessage` returns 0 (held); Filo exits 1.3 s later; the rescue copy holds every typed word; the dirty sentinel stays |
| Nothing unsaved, no field focused, then `WM_QUERYENDSESSION` | Returns 1 (not held); Filo keeps running |
| `app.json` changed by another program, then Rename Vault, then close the window | The Reload / Keep local toast shows at once; the quit dialog appears in 50 ms: "Waiting for your decision … .filo/app.json: these settings were changed outside Filo"; `app.json` keeps the other program's name |

**What changed, by item.**

| Item | Where | Tests |
|---|---|---|
| A25-15 | Main: `services/sessionEnd.ts` (`createSessionEndHandlers`: holds `query-session-end` only when the renderer last reported that leaving could lose work, sends `app:session-ending`, exits on `app:session-ending-done` or after 4 s, teardown bounded; `session-end` asks the renderer anyway and writes the breadcrumb) and `utils/sessionEndDecision.ts` (`decideSessionEnd`); wired in `main.ts`. Renderer: `lib/vault/unsavedStateReport.ts` pushes `app:unsaved-state` (anything unsaved, a held decision, unapplied Settings, a focused text field) on write-state / decision changes, focus moves and a 1 s poll; `lib/vault/handleSessionEnding.ts` freezes the editors, saves (`saveUntilSettled`, 2.5 s bound), keeps rescue copies (1.2 s bound) including unapplied Settings and the theme editor's draft (`_filo__defaults.unapplied.json`, `_filo__board-settings.unapplied.json`, `_filo__themes__theme.unapplied.json`), flushes the sentinel, replies. Three new IPC channels. KNOWN_LIMITATIONS #4 | unit `sessionEnd.test.ts` (decision table; hold, reply → exit; no reply → exit at the bound; a hung teardown still exits; `session-end`), `handleSessionEnding.test.ts` (order, rescue only when something is left, unapplied Settings, a hung save, a throwing rescue; the theme draft kept only when asked); characterisation `sessionEnd.test.ts` (the report goes true then false; typed text saved; a change that can't be saved is kept in `.filo/recovery`, no dialog) |
| A25-16 | `boardCacheDelete.ts`: `saveBeforeDelete` re-fires a write kept for Retry (unless the board is drift-held) and counts the board saved only when nothing is left, it isn't failed (`isPathFailed`, new) and it isn't held; after the move `discardBoardWrite` clears the kept write and the failed mark | unit `boardDeleteRescue.test.ts` (kept write that fails again → rescue copy, nothing owed after; kept write that lands now → no rescue, two saves; drift-held → rescue copy, no write, nothing owed). All three fail on the old code |
| A25-17 | `loadBoard` offers the JSON it read (`UnpinnedBoardLoad`) when no stat pins the version; `adoptLoadedBoardBaseline` marks the board unverified with it (`markBaselineUnverified(path, content)`; the registry's unverified set is now a map, and rekeys descendants on a folder rename); `writeBoardFile` reads an unverified board before its first save (`diskIsFilosVersion`): the version the load read, or Filo's own bytes, are written over; anything else goes to the drift question; unreadable → kept for Retry (`EBUSY`). Loader comments rewritten | unit `boardUnverifiedBaseline.test.ts` (marked unverified; another version asks and writes nothing; the loaded version is written over after an edit; unreadable is kept, not written). Gate `writePath/board-baseline-after-adopt` extended (proved to bite: the old no-baseline branch fails it) |
| A25-18 | `lib/boards/configDriftHold.ts`: `refuseHeldConfigWrite` holds the file, asks without waiting (re-asks only for a different change) and throws `ConfigDriftHeldError` (`CONFIG_DRIFT_HELD`, retainable); `resolveConfigDrift` carries out the answer (Keep local: `backupConfig`, baseline to the other version, re-fire; Reload: read into memory, baseline moves); per-file targets registered by the settings bundle and `hotkeys.ts`. `checkConfigDisk` returns `drifted` instead of awaiting the prompt; `settleOutsideVersion` is synchronous. Held decisions gain `ledgerPath` (`heldDecisionPaths()`), so the `.filo/` ledger key counts as a decision; quit names the held file with cause `config-drift` | unit `configExternalChanges`, `configMiscDrift`, `configFileReconciler` (7 cases rewritten for the new flow: refused and held, the answer carries it out, a dismissed one re-asks only for a new change); characterisation `decisionsAtQuit.test.ts` (+1: an outside `app.json` edit then a rename, quit says "Waiting for your decision" within 5 s; fails on the old code). Gate `writePath/config-drift-held` (proved to bite: 7 violations on the old code) |
| A25-19 | Not implemented (deferred as planned). KNOWN_LIMITATIONS #15 rewritten: the note compare-and-swap already lives in main; the board / config gap is recorded with the fix to take if it bites | — |

**Deviations from the plan.**

1. **A25-15: main can't make a round trip inside `query-session-end`,** which must be answered synchronously. So the renderer keeps main told (`app:unsaved-state`, pushed on change) and main decides from the last report; the save and rescue run after main has already held the session. The report is generous on purpose (a focused text field counts). Text typed in the last second before a forced shutdown may not have been reported yet (KNOWN_LIMITATIONS #4).
2. **A25-15: the pure helper sits in `main/utils/sessionEndDecision.ts` as planned, but the hold/exit sequencing is its own service** (`main/services/sessionEnd.ts`, deps injected) so it is unit-tested without Electron; `main.ts` only wires it.
3. **A25-15: the renderer releases its editor freeze once it replies,** so if Windows doesn't end the session after all (only `session-end` fire-and-forget could hit that), Filo stays usable.
4. **A25-15: unapplied Settings are kept as three fixed rescue names** (`_filo__defaults.unapplied.json`, `_filo__board-settings.unapplied.json` naming its board, `_filo__themes__theme.unapplied.json` from a new `draft()` on the theme editor's registration). Only a Windows session end keeps them; close / quit still ask as before.
5. **A25-16: the delete re-fires a kept write before deciding,** rather than only checking. When the lock has gone meanwhile the trashed file then has the changes and no rescue copy is needed (the real-app check shows this); a drift-held board is never written.
6. **A25-17: the check compares against the JSON the load read, not only against the cache.** A freshly loaded board doesn't serialise byte-equal to its file (schema defaults), so comparing disk with Filo's payload alone would have asked on every first save of an unverified board. The loader now offers `{ readJson }` in place of a stat, and the check accepts either that JSON or Filo's own bytes.
7. **A25-18: a held settings write is re-fired freely rather than kept un-fired** (no `holdRetained` for the config and misc schedulers). The refusal is immediate, with no stat and no prompt, so a re-fire costs nothing and lets the bundle's other files (a layout change) still be written; the question is asked again only for a different change. **Reload re-fires the bundle** rather than dropping it (the other files may be owed; the reloaded file is skipped when memory now says what disk says); for `hotkeys.json` Reload drops the held write, as planned.
8. **A25-18: the quit test is a characterisation spec** through a vault rename (the harness has no Settings-field action), which writes `app.json` the same way. Tests calling `writeConfigs` directly wait for the answer with a test-only `__configDriftSettledForTests()`.
9. **A25-18: in the quit dialog, a held settings file hides any other failure of the same bundle** (the bundle is tracked as `.filo/` as a whole); the rescue copy still covers every unsaved settings file.

**New findings (for later phases).**

- **N9** — a "Board save failed" toast stays up after that board's kept write has landed (and after the board was deleted). Worth clearing a write-failure toast once its path saves, in Phase 5.

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

### Phase 5 outcome (2026-09-29)

**Done.** Every item (A25-20 … A25-26 except A25-22, done in Phase 1), plus N8 and N9 from earlier phases, D9 taken at its default, and two new gates (87 in all). Each fix started from a test that fails without it (checked by running the new spec with the fix switched off, or, for new helpers, by the failing import), except where noted.

**Checks.** `npm run ci:verify` green: 760 test files, 7,096 tests (5 skipped, as before); 87/87 gates. One full run before that timed out once in `boardFolders.test.ts` ("renaming the .board.json … renames the board", waiting for the tab to follow); it passed alone (11/11) and in the next full run, so it reads as a load-dependent timeout, not a regression.

**Real-app check** (built app, a session-scratchpad Playwright script driving `dist/main/main.js`):

| Scenario | Result |
|---|---|
| Kanban: add a card, press its Lock, quit, relaunch | The placement has `locked: true` on disk; after the relaunch the card still shows Unlock and the locked style |
| Sidebar (Sort By None): Alpha, Bravo, Charlie; move Alpha down twice with the drag handle's keyboard reorder; quit, relaunch | Bravo, Charlie, Alpha before and after the relaunch; `.filo/sidebar-order.json` holds it under `""` |
| Rename `plan.md` to `Plan` in the sidebar, then `other.md` to `Plan` | The first renames at once, no dialog (`Plan.md` on disk). The second shows "Name already taken … nothing was renamed" with OK only, and it stays up after the real Enter (its keypress no longer presses the button); both files unchanged |
| A Mind Map tab; quit; the board file cut short (`{ "version": 8, "board": `); relaunch; the file put back; Retry in the tab | The tab is still there, saying "Filo couldn't open "Mind Map 1"" and why in plain words (the parse error's wording was replaced by the notice's), with Retry; the broken file is left byte-for-byte; `workspace.json` keeps the tab; after Retry the board shows in the same tab |

**What changed, by item.**

| Item | Where | Tests |
|---|---|---|
| A25-20.1 Kanban lock | `KanbanTilePlacementSchema.locked`; `kanbanTileOps.updateTile` writes a lock to the card's placement (`setPlacementLocked`) and the projection reads it; `getFullTilesForKanbanBoard` now delegates to `kanbanTileOps.getFullTiles` (the two copies of the projection were one) | unit `kanbanCardLock.test.ts` (lock → placement and card; unlock removes the field; the schema keeps it) |
| A25-20.2 Ctrl+A | `selectableTileIds` (skips `framesStore.hiddenTileIds`); the Delete confirm says how many selected tiles are inside collapsed frames | unit `selectAllCollapsedFrames.test.ts` |
| A25-20.3 right-click | `lib/mindmap/tileHitTest.ts`: the tile under the pointer (`data-canvas-tile-id` on the tile shell), else the spatial hits by paint order (a selected tile on top, then board tile order); a tile inside a collapsed frame is never hit | unit `tileHitTest.test.ts` |
| A25-20.4 subtask parent (D9) | `TaskPlacementSchema.parentTileId`; `lib/tasklist/taskParent.ts` (`taskParent`, `buildSetParentCommand`); `SetTaskParentCommand`; `boardCacheStore.setTaskPlacementParent`; indent / outdent (drag, Tab), "keep subtasks" on delete and Add Subtask (a new `AddTaskCommand` argument) write the placement; `TaskRow.noteParent` keeps the note's own field for the fallback | characterisation `taskSubtasks.test.ts` (Tab writes the board, not the note, and Undo takes it back; a note's `parent:` shows nested and Shift+Tab outdents without touching it); unit `taskListPlacementCommands.test.ts` (+5) |
| A25-20.5 section delete undo | `DeleteSectionCommand` records the layout before the delete and the section's tasks; undo puts the marker back at its array slot, tied with its successor, and `applyMove`s the tasks into it | unit `sectionDeleteUndoMembership.test.ts` (keep-tasks with a task added above; delete-tasks with a task removed / added above) |
| A25-20.6 Today after midnight | `stores/clock.svelte.ts` (`clockStore.today`: a midnight timer, window focus / visibility, a 5-minute recheck); the Task List view model's three "today"s read it | unit `clockStore.test.ts` (midnight; a sleep through midnight caught up on focus) |
| A25-20.7 duplicate drop | `addNoteAsTask` honours `duplicate`: focuses the existing row and toasts "Already on this list" (every drop path: Explorer, sidebar) | characterisation `explorerDrops.test.ts` (+1: Explorer twice and a sidebar drop leave one row) |
| A25-20.8 toolbar Undo / Redo | `toolbarStore.editorHistory` (the focused editor's can-undo / can-redo, from `syncStateToToolbar`); `tiptapToolbar.undoInEditor` / `redoInEditor`; the buttons read "Undo typing" / "Redo typing" then | characterisation `toolbarUndo.test.ts` |
| A25-21.1 sidebar root order | `sidebarOrderStore.set` saves the root under `''`; `seed` and the merge take an order saved under the vault's own path as the root's | unit `sidebarRootOrder.test.ts` |
| A25-21.2 rename clash | a case-only rename renames directly; a taken name gets a notice ("Name already taken", OK only, nothing renamed); `ConfirmDialogConfig.notice` (no Cancel) | unit `renameVaultEntryClash.test.ts` |
| A25-23 schema problems | `summariseProblems` (three and "and N more"); `LoadBoardError.problems` / `FailedBoardEntry.problems`; the notice's **Copy all problems** | unit `boardSchemaProblems.test.ts` (300 problems: a short message, the whole list copied) |
| A25-24 failed board's tab | a board tab saves `boardPath` and `boardType` in `workspace.json`; a tab whose board is in `unloadedBoards` comes back as a placeholder (`TabData.unloadedPath`, `UnloadedBoardTab.svelte`: why, and **Retry**); `adoptBoardAtRuntime` turns it back into the board's tab (`tabStore.resolveUnloaded`); a file gone at Retry closes the tab; `BoardRouter` never makes a default board for such a tab | characterisation `workspaceRestore.test.ts` (+1: broken → tab kept, file untouched → fixed → Retry shows the board) |
| A25-25 wording | the rollback notice ("Part of a change stayed in place", OK only, no "close without saving"); 28 messages reworded | unit `batchRollbackFailureModal.test.ts` (updated); gate `components/toast-plain-language` |
| A25-26.1 tag sweep guard | `whenTagSweepsIdle`; every tag rename / delete / restore / undo waits for a running sweep (`afterRunningSweeps` in `tagUndo`), so a double-click, the Tags popup or a toast's Undo / Retry can't start a second sweep over the same notes; the double-click rename is disabled while busy, like the button | unit `tagSweepOneAtATime.test.ts` |
| A25-26.2 audio take | a take whose tile was deleted is kept and named in a notice with **Show in folder** (KL #45) | component `audioRecordingKeepsTake.test.ts` (+1) |
| A25-26.3 timer off screen | `runningTimerTiles` (like `recordingTiles`): a running countdown stays mounted when panned off screen, so it still announces | unit `visibleTilesViewModel.test.ts` (+1) |
| A25-26.4 editor minors | none reproduces (all fixed by Phase 1); three commands added to the property test's commands-in-context (insert a horizontal rule, type " ##", Enter then "1."), 18 new cases | unit `editorRoundTripProperty.test.ts` |
| N8 Enter + keypress | `preventDefault()` in 17 Enter handlers (sidebar, tab and board renames, vault name, Kanban column and task titles, waypoint rename, the media URL fields, the timer's custom time, the Board Browser row, the colour hex field, the vault name setting) | gate `components/enter-keeps-the-key` |
| N9 stale failure toast | `lib/boards/writeFailureToasts.ts`: a board-save failure toast closes once none of its boards is failed or pending (saved, or deleted and its write dropped); the write-error aggregator returns its toast id | unit `boardFailureToastSettles.test.ts` |

**Deviations from the plan.**

1. **A25-20.3 was reproduced by reading, not in the app.** The spatial index (rbush) returns hits in tree order, so the last hit was arbitrary. The tile under the pointer is now read off the event target; the attribute is `data-canvas-tile-id`, not `data-tile-id`, because the Kanban insert-position walk counts `[data-tile-id]` elements and a nested second one would be counted twice. The fix also stops a right-click from hitting a tile hidden in a collapsed frame.
2. **A25-20.4: outdenting a task whose note names a parent writes `parentTileId: ""`** (only that overrides the note); an indent / outdent is otherwise one `SetTaskParentCommand` whose undo restores the field exactly (including its absence). The note's `parent:` is never removed (KL #44). A new subtask gets its parent on its placement through `AddTaskCommand` (a new last argument), so the placement and the parent are one step.
3. **A25-20.6: no main-process resume event.** A timer delayed by sleep fires on wake anyway, and focus / visibility plus a 5-minute recheck cover the rest. Only the Task List's lists and groups read the clock; see N10.
4. **A25-20.8: "the focused editor", not "the last focus inside the pane".** The active editor is cleared 300 ms after it loses focus, so once focus leaves the text the buttons act on the board again, as Ctrl+Z does (it acts on the board whenever no editor is focused). A read-only editor's typing isn't undoable, so the buttons are disabled there.
5. **A25-21.2: the clash is a notice, not a toast.** `ConfirmDialog` gained `notice: true` (the confirm button only; Escape still closes it). The rollback notice (A25-25) uses it too.
6. **A25-23: no `…-problems.txt` file.** A text file in `.filo/recovery/` would be counted by the snapshot prunes and listed by the recovery modal, and needs a new IPC argument. Instead the notice names three problems and offers **Copy all problems** (the whole list, one per line), and the renderer console logs it. The message is capped at the source (`loadBoard`), so the adoption path's error toast is capped too.
7. **A25-24: a tab saved by an earlier build has no board path** and is dropped once, as before. From now on board tabs save `boardPath` and `boardType` (so `workspace.json` is written once more after the upgrade, at the next change).
8. **A25-25: the gate also checks `reportError`'s message** (its third argument is what the toast shows). That found 28 messages, not the 6 listed; all were reworded to say what happened and what to do. The rollback modal's wording is not caught by the word list; it was rewritten by hand.
9. **A25-26.1: a second sweep waits instead of being refused.** A toast's Undo is gone once pressed, so refusing it would lose the undo; waiting (with a short "Waiting for the tag change…" toast) keeps it. The wait is in the store functions, so every entry point is covered.
10. **A25-26.2: the take is kept and named, not trashed or re-linked on undo** (KL #45). The delete's undo step is recorded before the take finishes; changing it afterwards would make undo depend on two asynchronous saves.
11. **N8 is a gate, not only a sweep**: `components/enter-keeps-the-key` (an Enter branch in a component must call `preventDefault`; escape `// allow-enter-default:`). Proved to bite: removing the sidebar rename fix fails it.
12. **N9 tracks board failures only.** A settings or file failure toast is keyed by names the write ledger doesn't use, so closing it on "nothing pending" could close it while the failure stands.
13. **Found by the real-app check, fixed: the kept tab showed the loader's raw error** ("IpcEnvelopeError: SyntaxError: Unexpected end of JSON input"). `boardLoadReason` (in `boardLoadFailedNotice.ts`) now gives the notice's plain words for a broken or unrecognised file, and the kept tab, the adoption's Retry prompt and `ensureAllLoaded` all record that reason.
14. **The `toolbar-formatting-saved` gate counts the toolbar's new undo / redo** (it reads every `chainIfEditable()` chain), so `toolbarFormattingRoundTrip.test.ts` gained "bold, then undo" and "bold, undo, then redo" cases. The `unloaded-board-catches-up` gate's pattern now allows the reason argument to `markBoardUnloaded(relPath, …)`.
15. **Gates:** `components/toast-plain-language` (proved to bite: 28 violations before the rewording) and `components/enter-keeps-the-key` (7 violations before the sweep's last fixes; 1 with the sidebar fix removed). 85 → 87.

**New findings (for later phases).**

- **N10** — a Kanban card's and a Task List row's "overdue" colour and "Today" / "Tomorrow" label read the date when they render (`isOverdue`, `dueDateFormat`), so they also go stale over midnight until the card re-renders. `clockStore.todayDate()` can feed their `now`. Phase 6.
- **N11** — `.filo/sidebar-order.json` keys and lists are absolute paths (`C:\…\Vault\Alpha.md`), so the manual order is lost when the vault is opened from another path or on another machine (Syncthing). Store vault-relative paths, reading absolute ones once. Phase 6.

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

### Phase 6 outcome (2026-09-29)

**Done.** Items 1–9, plus N4, N5, N10 and N11 from earlier phases. One new gate (88 in all) and a widened one. Where a change alters behaviour (the SideToolbar factories, the drift-prompt keys, the date formatter in TemplateBrowser, N4, N10, N11), a test was written first and seen to fail with the fix switched off.

**Checks.** `npm run ci:verify`: lint, svelte-check, typecheck:main, 765 test files / 7,106 tests (5 skipped, as before), build all green; the first gates run failed `test-typecheck` (a new test helper's return type), fixed, then 88/88 gates. Two earlier full runs caught a test still calling `AddSectionCommand` with the old arguments (`sectionOps.test.ts`, updated) and that type error.

**Real-app check** (built app, a session-scratchpad Playwright script, `realapp/phase6.mjs`):

| Scenario | Result |
|---|---|
| Sidebar (Sort By None): move Alpha below Charlie with the drag handle's keyboard reorder; quit; copy the vault to another folder; open it there | `sidebar-order.json` holds `{ "": ["Bravo.md", "Charlie.md", "Alpha.md"] }`; the moved vault shows Bravo, Charlie, Alpha |
| `defaults.json` sets a Mind Map tile header `#aa0000`, shape rounded, frame border `#00aa00`; a new Mind Map board; side toolbar New → Timer, then New → Frame; quit | Both show the default colours on screen; the board file holds the tile style `{ headerColor: "", bodyColor: "", borderColor: "" }` and the frame's with `borderColor: ""`. The same run on a build of `bec1a17` saved `#aa0000`, `rounded`, the border and shadow into the tile and `#00aa00` into the frame |

**What changed, by item.**

| Item | Where | Tests |
|---|---|---|
| 1 Dead code | removed: `toggleTagFade` + `ToggleTagFadeCommand` (and its gate exemption), `getTagUsageCount`, the global `spatialStore` facade, `isThemeToken`, `vaultStore.setLoading`, `searchStore.togglePanel`, the tile registry's `name` / `selectable`, `workspaceStore.setSidebarWidth` / `sidebarWidth` (no longer written to `workspace.json`; an old file's key is ignored), the `role` prop on VaultSidebar / VaultFileItem, the `backupExternalVersion` re-export, `AddSectionCommand`'s before / after arrays (it takes the new section), `fileTagsStore.hydrate()` (its seven test users seed through `commitFromCandidate`). SideToolbar's unreachable `switch` cases went with its factory copy (item 3). `toolbarConfig.toggleTaskList` stays: Phase 1 added the Checklist button (D11) | updated `workspace.test.ts`, `configExternalChanges.test.ts`, `sectionCommandsDelta.test.ts`, `taskStructureCommandsRoundTrip.test.ts` |
| 2 Test-only exports | `/** @internal test-only */` on `encodeFiloLink` / `FiloLinkSchema` (dropped from `schema/index.ts`), `clearBaseline`, `SETTINGS_VAR_NAMES`, `vaultStore.setPath` / `setTree`. `parseTagsField` is used by the app (tag writer, rewriter), so it stays as is | — |
| 3 Duplicates | one tile and one frame factory (`stores/tiles.svelte.ts`: `createTile`, new `createFrame`); SideToolbar and MindMapBoard (three tiles, one frame) build through them, so a new element no longer freezes the Global Defaults colours / shape into its style. One date formatter (`lib/utils/dateFormat.ts`: `localIsoDate`, `localIsoDateInDays`) for TaskBulkActionBar, TaskDatePicker, quick add, recurrence, templates and TemplateBrowser (which used UTC: a template board made after midnight UTC but before local midnight was named with tomorrow's date). `vaultRelativeFromAbsolute` → `toVaultRelative`; `pinIsUnder` → `isAtOrUnder`; one `TimerModeSchema` (`schema/tile.ts`) for the tile, placement, command and the mode button; style popups use `createId()` | component `sideToolbarNewElements.test.ts` (fails on the old toolbar: `#aa0000` baked in); unit `dateFormat.test.ts`; `droppedFiles.test.ts` and `folderPins.test.ts` now test the shared helpers |
| 4 Stale comments | `boardWriteScheduler.ts` (the orphaned handler doc merged into one; the writer never awaits the drift question), `boardDrift.ts` (Reload clears undo; the toast is sticky), `writeStateTracking.ts` header, `taskCommands.ts` (moves record the move; delete undo is a restore from the trash), `groupAndBoardCommands.ts` (the orphaned cascade doc), `vault.svelte.ts` (`runPostCommitTasks`, and its dead `store` argument), the TaskItem notes animation (see deviation 3), and 30 comments naming removed identifiers (list in the commit message) | — |
| 5 Audit-id gate | `codebase/no-audit-narration` also matches `A25-01` and `F1 regression` anywhere, and a lettered item id (`E.11`, `C5.2`) in comments; proved to bite (14 hits), all cleaned | gate |
| 6 Pre-swap order | `runAfter: ['leftBehind']` on `boardCache`, `fileTags`, `workspace`, `sidebarOrder`, `pendingSettings`, `nonUtf8Paths` (`boardWriteScheduler` already had it) | new gate `vaultIdentity/pre-swap-after-left-behind` (proved: fails with the `workspace` declaration removed) |
| 7 Drift keys | `inFlightDriftPrompts` / `inFlightResolutions` keyed by `VaultPath` | unit `driftPromptDedup.test.ts` (+1: two spellings, one toast; fails without) |
| 8 CLAUDE.md | BoardRegistry (lazy component, no toolbar / schema), TileRegistry (defaults only), `coordinates.ts`, `quit-failure.<machineId>.json`, config debounce (300 ms; viewports 1,500 ms), a Document tab's stack keyed by `tab.boardId`, gate count and the two gate descriptions, the new modules | — |
| 9 KNOWN_LIMITATIONS | #4 and #15 were already current (Phase 4); #17 and #4 lost their audit narration, and two `ci:` names now name the gates | — |
| N4 | `taskItems.ts` `addEachCoreRuleOnce`: a core rule whose name is registered isn't added again, whichever setup runs first | unit `taskListRuleOnce.test.ts` (6 copies after 5 loads before) |
| N5 | `electron.vite.config.mts`: the `markdown-tools` chunk (gray-matter, js-yaml, remark…) removed | build |
| N10 | TaskItem and KanbanCard pass `clockStore.todayDate()` to `isOverdue` and the date chip | component `dueChipMidnight.test.ts` (a row due today turns overdue at midnight; fails without) |
| N11 | `sidebar-order.json` holds vault-relative paths; the store keeps absolute ones as the tree spells them; an absolute file is still read and is written back relative at the next change; the tree matches paths separator-agnostically | unit `sidebarOrderRelative.test.ts` (3 cases; all fail without) |

**Deviations from the plan.**

1. **"One tile factory" kept `createTile`'s signature;** a pane-scoped caller passes `title` from its own board, since the factory's fallback names from the active pane. Before, only AppShell's Ctrl+N and templates used the factory; now every Mind Map new-tile path does.
2. **Item 6 covers six handlers, not four:** the leave rescue also reads unapplied Settings (`pendingSettings`) and the read-only note set (`nonUtf8Paths`), so both got the declaration and are in the gate's list.
3. **TaskItem's notes panel: fixed, not documented as an exception.** The row now snaps between `0fr` and `1fr` and its content fades and slides in (opacity and transform only), with no transition under reduced motion. Subtasks below move at once instead of gliding.
4. **Item 1: `AddSectionCommand` takes the new section itself** rather than keeping the old parameters as unused; its three test call sites were updated.
5. **`kanbanDragController`'s stale comment (report, 335-336) was already gone;** `boardCacheDelete.ts:137-139` had been rewritten in Phase 4.
6. **The audit-id gate's `F1 regression` pattern applies to code too:** the one hit was in a console message (`fileBaselineRegistry.ts`), which the plan's "comments only" wording would have missed.
7. **N1, N2 and N3 not done.** N1 and N2 change how Markdown is written (outside "no behaviour changes") and stay in KNOWN_LIMITATIONS #32 / #17. N3 (an empty code block after a lone horizontal rule reloads as an empty paragraph) writes nothing, since the note is read-only; left as found.
8. **The stale-identifier sweep used a scratch script** (backticked names in comments that appear in no code or file name); it found more than the ~20 expected, about 30 real ones after dropping runes, `.json` names and library internals (`animateDraggedToFinalPosition`, `styleDraggable`, `registerPlugin`).

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

### Phase 7 outcome (2026-09-29)

**Done.** Items 1–6 and the gate (89 in all). The old dev-server specs are gone; `npm run build && npm run test:e2e` runs 24 tests in 11 spec files against the built app (21 pass locally in about 2 minutes; the 3 scale budgets skip unless `FILO_E2E_SCALE` is set, and pass with it). The new suite found three app bugs on its first runs, fixed here (below), and two it records (N12, N13).

**Checks.** `npm run ci:verify`: lint, svelte-check, typecheck:main, 765 test files / 7,107 tests (5 skipped, as before), build and 89/89 gates all green. `npm run test:e2e`: 21 passed, 3 skipped; with `FILO_E2E_SCALE=1`, the 3 scale specs pass.

**What was built.**

| Item | Where | Notes |
|---|---|---|
| 1 Helpers | `src/tests/e2e/helpers/app.ts` | `launchBuilt(vault, { open, throttled, sameMachineAs })` (fresh `--user-data-dir`; `showOpenDialog` and `showMessageBox` stubbed in main, boxes recorded and answered from `setAnswers`; window restored, throttling off unless `throttled`), `quitLikeUser` (closes the window so the quit flow runs; on a timeout records the native boxes and in-app dialogs, `\s+` fixed, and kills the process tree), `requestClose`, `openNoteByName(win, stem, title?)` (double-clicks the row's name, then waits for the note's own tab), `openBoardByName`, `newBoard`, `sidebarRow`, `toasts`, `confirmDialogs`, `freshVault`, `generateVault(n)` (CRLF, BOM, a comment and `zip: 02134`, no-frontmatter notes, task fields, tables, code, checklists, plus a small v8 board of each type), `hashVault` / `changedFiles`, `setPickedVault` (the folder Ctrl+O picks), `machineIdOf`, `killApp`. `FILO_E2E_MAIN` points the suite at another build |
| 2 Specs | `editorFidelity.e2e.ts` (5 cases: a checklist with an empty last item, a list item turned into a checkbox, a space-indented paragraph, `\|` in a table cell, a fence in a code block; each saved, then reopened editable with its text), `kanbanClick.e2e.ts`, `syncDeliveries.e2e.ts` (5 tests: an older-mtime delivery shown and never written back; a delivery while typing asks; quit shows "Waiting for your decision", Stay open, Keep mine, the other version in `.filo/recovery/`; a conflict copy listed, `.stversions` and `.syncthing.*.tmp` not, search skips `.stversions`; a delivered board shown), `quitMinimized.e2e.ts` (2 variants), `noBytesByLooking.e2e.ts` (1,000 generated notes plus five hand-made shapes; every board type and five notes opened; quit; SHA-1 of every file outside `.filo/` unchanged; no effect loop), `scaleBudgets.e2e.ts` | |
| 3 Ported | `dailyDriver.e2e.ts` (from `dailyDriverSmoke`), `vaultSwitchAndBom.e2e.ts` (from `preDailyUseRegressionBracket`), `recoveryRelaunch.e2e.ts`, `keyboardAccess.e2e.ts` (from `contextMenuKeyboard` and `sidebarDeleteButtonFocus`); `documentOpenNoWrite` folded into `noBytesByLooking` (same CRLF / LF notes, same effect-loop check) | deleted: `app`, `confirmDialogFocus`, `focusTrap`, `homescreenShortcuts`, `kanbanBoard`, `kanbanEmptyState`, `kanbanTagPopupEscape`, `sidebarRenameEscape`, `splitPanes`, `taskListBoard` (store-driven smoke checks, or behaviour the component and unit suites already pin: confirm focus, focus traps, rename Escape, the tag popup, split panes) |
| 4 Accessibility | `a11y.e2e.ts`: `axe-core`'s own source evaluated in the page (through the debugger, which the CSP doesn't govern), then `axe.run()`; Home, the app shell's landmark and skip link, Mind Map, Template Browser, Kanban, Task List, a Document tab, Settings, Board Browser | `@axe-core/playwright` uninstalled, `axe-core` a direct dev dependency |
| 5 Config | `playwright.config.ts`: `testMatch: '**/*.e2e.ts'`, `workers: 1`, 120 s per test | |
| 6 CI | `.github/workflows/ci.yml`: one `e2e` job on `windows-latest` (weekly and manual): `npm run build`, `npm run test:e2e`, with `FILO_E2E_SCALE=1` and `FILO_E2E_BUDGET_FACTOR=2`; the separate Linux `a11y` job is gone | |
| Gate | `codebase/e2e-drives-built-app`: no `import('/src/…')` under `src/tests/e2e/`, and every spec outside `helpers/` named `*.e2e.ts` (Playwright runs nothing else) | proved: a planted `import('/src/…')` and a planted `old.test.ts` both fail it |

**Found by the suite and fixed.**

| Finding | Fix | Tests |
|---|---|---|
| **Showing a Task List rewrote its board file**, every time, in every launch (`noBytesByLooking`). The `lastView` flush compared the whole saved slice with the view's; the Task List schema defaults `groupBy` / `sortBy` into the loaded slice (they live in the board settings) and orders its keys, so the two never matched and each open wrote the board (a whole-file rewrite: key order, `borderColor: ""`). With Syncthing that is a change to sync on every look. A board Filo made in the same session escaped it, which is why `bytesOnDisk` stayed green | `lib/boards/lastViewFlush.ts`: the flush writes only when a key the view owns has a different value | characterisation `bytesOnDisk.test.ts` +1 (a Task List and a Kanban board file written elsewhere, opened and shown, stay byte-identical; fails without the fix; the gate's minimum for the file is now 5) |
| The save indicator carried an `aria-label` on a `div` with no role (`aria-prohibited-attr`), so screen readers could drop it | `GlobalToolbar.svelte`: `role="status"` when it isn't the error button | `a11y.e2e.ts` |
| Settings → General → Undo History Limit had no label (`label`) | `GeneralSettings.svelte`: the row's label is a `<label for="history-limit">` | `a11y.e2e.ts` |

**Real-app check.** The suite is the check. Measured by `scaleBudgets` on this machine: Kanban 300 opens in 434 ms and its tab comes back in 292 ms; Task List fields right 451 ms after the rows (rows at 883 ms); `Bulk/` shows its first rows in 53 ms and all 2,000 in 1,220 ms.

**Deviations from the plan.**

1. **Spec files are `*.e2e.ts`,** and Playwright matches only that; the gate enforces it, so a leftover `*.test.ts` can't sit unrun.
2. **The ports changed shape, and one was added.** `dailyDriverSmoke` is now UI-driven (`dailyDriver.e2e.ts`): three board types, since a Document board isn't made from the tab bar, and no tile tags. `preDailyUseRegressionBracket` became `vaultSwitchAndBom.e2e.ts`: its "Don't Save" swap no longer exists (opening another vault saves first), so the spec types in vault A, presses Ctrl+O for vault B at once, and checks A holds the edit and B is untouched; its "body set before the note loaded" case is a store race the UI can't produce and stays with the unit tests. `documentOpenNoWrite` is folded into `noBytesByLooking`. `keyboardAccess.e2e.ts` is extra: the context-menu keys and the sidebar row's focus-revealed actions weren't pinned anywhere else.
3. **The axe scan is one test with a step per view and soft checks,** so one view's violations don't hide the next's; each scan first waits for running animations (a fade measured mid-way read as low contrast). **DECISION:** axe's `color-contrast` rule is off in the scan: `themeContrast.test.ts` checks every built-in theme's palette and holds tertiary text to 3:1 on purpose, where axe wants 4.5:1 for every small string (N13). `nested-interactive` is off for the Board Browser only (N12).
4. **`syncDeliveries`:** the board delivery lands 2 s after the board is made, not 9 s: a board write now hides only its own bytes, so there's no echo window to wait out. The typing race's question is the note's toast; the quit test answers it (Stay open, then Keep mine) and checks the note and the backup.
5. **`scaleBudgets` pins three budgets** (Kanban 300 open and switch back, Task List fields, the 2,000-note folder's first rows) on the Phase 2 vault (`scripts/perf/genVault.mjs`). The typing frame budget isn't pinned: frame times on a hosted runner are noise; `scripts/perf/measure.mjs typing` keeps measuring it. CI runs the budgets at twice their size (`FILO_E2E_BUDGET_FACTOR=2`).
6. **One CI job, not two:** the Linux `a11y` job ran the old dev-server scan; the axe scan is now part of the Windows `e2e` job. No `playwright install` (Electron brings its own Chromium) and no `xvfb`.
7. **`quitMinimized` keeps background throttling on** (`launchBuilt(vault, { throttled: true })`), as a user's minimized window has it; every other spec turns it off.
8. **The E2E sources are type-checked:** `tsconfig.tests.json` included everything under `src/tests` except `e2e/`; it now includes it, under the `test-typecheck` ratchet (0 errors).
9. **Proving the specs bite.** `kanbanClick` was run against a build with the Phase 1 click fix switched off (fails: the clicked card keeps `.drag-active`); `editorFidelity` with a planted note that reopens read-only (fails: `contenteditable="false"`); `noBytesByLooking` failed on the real bug above before its fix. The other specs weren't run against an older build.

**New findings (for later).**

- **N12** — Board Browser rows are `role="button"` with their Rename and Delete buttons inside (axe `nested-interactive`): a screen reader treats a button's children as presentational, so those two buttons can be unreachable in browse mode. The fix is a row structure with the open action as its own control, which touches the row's drag and Alt+Arrow reorder.
- **N13** — Colour contrast by axe's bar: the Light theme's `--text-tertiary` (`#80868b`) is 3.7:1 on white (hints, counts, dates, the Raw toggle's label), under 4.5:1 for small text; the project's own bar for tertiary text is 3:1 (`themeContrast.test.ts`). The Task List's keyboard-hints strip (tertiary at 55% opacity, `aria-hidden`) is 1.8:1, under either bar. A palette decision for the owner.

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

Taken in Phase 2: D3 at its default (the queue runs in idle time, Phase 2 deviation 2); D5 at its default, with the remark packages uninstalled (deviation 10); D6 measured over its threshold (443–585 ms) and resolved by progressive rendering instead of windowing (deviation 9).

Taken in Phase 4: D8 at its default (the session is held only while there is something to rescue, about 4 s at most, no dialog; Phase 4 deviation 1).

Taken in Phase 5: D9 at its default (`parentTileId` on the placement; an older note's `parent:` read as a fallback, never written; KNOWN_LIMITATIONS #44).

Taken in Phase 3: D7 at its default (Markdown with HTML off and line breaks kept; Ctrl+Shift+V literal; KNOWN_LIMITATIONS #41).

## Not included

- **Keeping boards mounted while their tab is hidden** (memory cost). A25-06 makes remounting cheap instead.
- **A second-writer compare-and-swap for boards and configs** (A25-19). Deferred, with KL #15 corrected.
- **Rescue copies on a crash or power loss mid-typing.** The dirty sentinel names the files, which is the existing contract (KL #4).
- **Sync-conflict notices for note conflict copies.** The sticky notice covers board forks, and a note's conflict copy appears in the sidebar as its own file. With one editing machine this should be rare. Revisit if the owner adds a second machine.

## Status

Plan written 2026-09-29.

- **Phase 1: done** 2026-09-29 (see "Phase 1 outcome" for the deviations and four new findings, N1–N4). The report and this plan are committed with it.
- **Phase 2: done** 2026-09-29 (see "Phase 2 outcome": before / after numbers, 12 deviations, new findings N5–N7).
- **Phase 3: done** 2026-09-29 (see "Phase 3 outcome": the real-app check, 10 deviations including a pre-existing merge-confirm bug fixed, new finding N8).
- **Phase 4: done** 2026-09-29 (see "Phase 4 outcome": the real-app check, 9 deviations, new finding N9; A25-19 recorded in KNOWN_LIMITATIONS #15 and deferred).
- **Phase 5: done** 2026-09-29 (see "Phase 5 outcome": the real-app check, 15 deviations, N8 and N9 done, new findings N10–N11; two gates added, 87 in all).
- **Phase 6: done** 2026-09-29 (see "Phase 6 outcome": the real-app check, 8 deviations, N4, N5, N10 and N11 done; N1–N3 left as recorded; one gate added, 88 in all).
- **Phase 7: done** 2026-09-29 (see "Phase 7 outcome": 11 spec files on the built app, 9 deviations, three app bugs the suite found and fixed, new findings N12–N13; one gate added, 89 in all).
- Phase 8: not started.

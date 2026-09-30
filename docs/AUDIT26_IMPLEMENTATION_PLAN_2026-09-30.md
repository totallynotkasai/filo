# Audit-26 (pre-daily use): implementation plan

Source: [AUDIT26_PRE_DAILY_USE_2026-09-30.md](AUDIT26_PRE_DAILY_USE_2026-09-30.md), the 2026-09-30 audit of `db1af24`.

How it was audited:
- three finder agents and one refuter;
- `ci:verify` and the E2E suite on Windows;
- a scripted day of use on a generated 5,000-note vault.

Every Medium or above was reproduced (a scratch test, the built app, or both) and confirmed by the refuter.

The owner's context sets the order:
- Windows 11, one machine, Syncthing, no other editors;
- all four board types;
- 500–5,000 notes;
- about to start daily use.

No path loses note text. So the order is:
1. boards around renames (the only High, and the one data-loss path);
2. editor writes that break Markdown;
3. notes that open read-only for no stated reason;
4. the Kanban and interface regressions;
5. undo, tags and search;
6. lows and hygiene;
7. verification.

## Conventions

- **Paths:** relative to the repo root; line numbers are from `db1af24` and will drift.
- **Decisions:** choices not yet confirmed are marked **DECISION** with a default; the table at the end collects them.
- **Each phase:**
  - leaves a working app;
  - passes `npm run ci:verify` on Windows;
  - runs the E2E suite when it touches the shell, startup, quit, watching or renames;
  - is committed on its own;
  - gets an "outcome" section here (what changed, deviations, new findings).
- **Repro tests** from the audit are in session `8b86c9b8` scratchpad:
  - `finderB_repros/zzA26B_*.test.ts`;
  - `zzA26A_slowFolderRename.test.ts.done`, `zzA26A_failedFolderRename.test.ts.done`;
  - `refuter/zzA26R_walkEcho.test.ts.done`;
  - the real-app scripts `sim/sim.pass.ts` and `sim/delundo.pass.ts`.

  Each fix turns its repro into a permanent characterisation, component or unit test, which must fail on `db1af24` and pass after the fix.

## Scorecard and targets

| Area | Now | After Phase 1 | After Phase 3 | After Phase 6 |
|---|---|---|---|---|
| Notes: write safety | 9 | 9 | 9 | 9 |
| Boards: write safety | 8 | 9 | 9 | 9 |
| Renames, moves, trash and their undo | 6 | 8.5 | 8.5 | 9 |
| Sync and outside changes | 8.5 | 9 | 9 | 9 |
| Open / close / quit / recovery | 8 | 8.5 | 8.5 | 9 |
| Editor: nothing lost | 8 | 8 | 9 | 9 |
| Editor: notes open editable | 6.5 | 6.5 | 8.5 | 8.5 |
| Undo / redo | 7 | 7.5 | 7.5 | 8.5 |
| Tags and search | 7.5 | 7.5 | 7.5 | 8.5 |
| Kanban | 7 | 7 | 7 | 8.5 |
| Accessibility and keyboard | 6.5 | 6.5 | 6.5 | 7.5 |
| **Overall** | **8** | **8.5** | **8.5** | **9** |

## Phase 1: renames and moves (A26-01, A26-02, A26-03, R-02, A26-29)

### 1.1 Board links change only after the rename succeeds (A26-01)

In `stores/vaultFolderOps.ts:253-273`:
- **Before the IPC:** compute the rewritten links, but don't `markDirty` any board.
- **After success:** `markDirty` every changed or renamed board.
- **On failure:**
  - put back only the affected boards from the snapshot (not `replaceCache` of the whole cache);
  - keep any edit made meanwhile;
  - make sure disk matches memory (mark the affected boards dirty if a write already landed).

If an in-memory cascade must run before the IPC, hold those boards' writes instead:
- use a retained, BOARD_DRIFT_HELD-style refusal;
- re-fire the writes on success;
- drop them on failure.

Tests:
- characterisation, slow `vault:rename` (0.8 s delay, then success): the boards carry the new links, and nothing is written early;
- characterisation, slow then failed (EPERM): the boards on disk still carry the old links after reopen, and a board edit made during the rename survives.

### 1.2 `board:save` never creates folders for an existing board (A26-03, N16)

- In `main/vault/boardFileOps.ts:49-54`, only `board:create` makes directories. A save whose folder is gone fails with a new retryable code (e.g. `BOARD_FOLDER_MISSING`), which the writer keeps like any failed write.
- In `lib/boards/boardWriteScheduler.ts:270-272`, refuse (and retain) a write whose board path was rebound by a rename still in flight.
- Test: the Finder A repro (a slow board-folder rename) leaves no stray `Plan/Plan.board.json`, and N16's CI case can't recur.

### 1.3 The reconcile walk doesn't echo Filo's own renames (A26-02 root cause, R-01)

- When `vault:rename` (and the trash move, restore and case rename) succeeds, main re-keys `reconcileSnapshot` from the old path prefix to the new one.
- Doing it on success, rather than stretching the 5 s suppression window, keeps a real outside rename during the window visible.
- Unit test (from `zzA26R_walkEcho`): an in-app rename of a 40-file folder, then a walk after the window, gives **0** rename or create events. An outside rename is still reported.

### 1.4 An undo re-adds tiles without waiting for the watcher queue (A26-02)

- In `CascadeDeleteCommand.undo`, `DeleteTilesCommand` and `DeleteTaskCommand`:
  - re-add placements as soon as the file is back;
  - run `syncAfterRestore`'s tree refresh and reindex afterwards (or unawaited, as redo already does).
- Keep the rule "the file is back before the tile", so no empty note is seeded.
- Test: characterisation. Block the rename queue with a slow task, then Ctrl+Z a delete: the card is back within 1 s, and the tree catches up later.

### 1.5 Quit says what it's waiting for (A26-02)

- **DECISION D1:** when quit or close waits on the history chain for more than about 2 s, show the quit dialog's waiting state ("Finishing an undo…").

  *Default: yes, reusing the existing waiting dialog.*

### 1.6 A name clash fails fast (R-02)

- `vault:rename` checks for an existing target before the rename. Make sure the EPERM-for-existing-target case returns `TARGET_EXISTS` at once instead of entering the 5 s lock retry.

### 1.7 Media handles (A26-29)

- Built-app check: open a board with a Video tile, then rename its folder.
- If the `filo://` stream holds the file open, close streams for paths under a folder before renaming it.

### 1.8 Real-app check

- Extend `sim.pass.ts`:
  - a folder rename that fails (a file in it held open by a child process);
  - a delete, then undo, 35 s after a 1,107-note folder rename;
  - quit right after an undo.
- Expected:
  - the links are unchanged after the failed rename;
  - the card is back within about 1 s;
  - quit is under 2 s.

### Phase 1 outcome (2026-09-30)

**Status:** done. Verified on Windows:
- `npm run ci:verify` green: 770 test files, 7,202 tests passed (5 skipped), 89/89 gates;
- `FILO_E2E_SCALE=1 npm run test:e2e`: 25/25;
- the real-app checks below.

**What changed**

- **1.1 (A26-01): boards change only once the rename has succeeded.** `runRename` (`stores/vaultFolderOps.ts`):
  - before the IPC, only works out which boards the rename touches (`boardCacheStore.renameImpact`, a dry run), for the crash sentinel;
  - after a successful `vault:rename`, runs `renameBoardPath` and `propagateRename` in the same synchronous block as `renameAllPathKeys`.
  - A refused rename therefore changes nothing in memory or on disk. There is no snapshot revert any more: `replaceCache` of the whole cache and `boardStore.rehydrateSpatial` (now unused, removed) are gone from this path, and an edit made during the rename is kept because nothing is put back.
  - If the vault is let go during the IPC, the boards are left alone and the sentinel stays for the next open.
- **1.2 (A26-03, N16):**
  - `board:save` never creates a folder (`BoardFolderMissingError`, code `BOARD_FOLDER_MISSING`, kept for a retry).
  - Boards whose own `.board.json` moves are held for the move (`lib/boards/boardMoveHold.ts`, by board id). A write that comes due is armed again (new scheduler option `deferFire`), so it stays pending rather than failed. One forced out by a save meanwhile is refused (`BOARD_MOVE_HELD`), retained, and not re-fired while held (`holdRetained`).
  - After the move, the moved boards are armed again at the path the move ended at.
- **1.3 (A26-02 root cause, R-01): Filo's own moves no longer echo through the reconcile walk.** New module `main/services/fileWatcherOwnMoves.ts`:
  - `vault:rename` moves the walk's record with the files (`noteOwnMove`); case-only renames go through the same call;
  - a trash move takes the records out and keeps them by trash id (`noteOwnTrash`), and the restore puts them back (`noteOwnRestore`);
  - a walk that runs during a move waits for it (`beginOwnMove`), replays it on what it read, and fills in any moved file it missed.
- **1.4:** `restoreFiles` now awaits only `syncRestoredNotes`: open views of a restored note read it again, and a restored note is back in the search index. The tree refresh (`syncRestoredTree`) runs behind the watcher's queue, unawaited, so the command re-adds its tiles at once. Settings → Trash and the board toast's Undo still await the whole `syncAfterRestore`.
- **1.5 (D1):** a save that waits more than 2 s on the history chain shows a sticky toast, "Finishing the last undo or change before saving…" (`lib/vault/historySettleNotice.ts`). This applies to Ctrl+S, close and quit, since all three run `save()`.
- **1.6 (R-02):** `renameItem` checks for the target before each lock retry, so a name that appears mid-retry fails at once with `TARGET_EXISTS` instead of after 5 s.
- **1.7 (A26-29):** checked in the built app, and not reproduced (see the deviations).
- **Tests added:**
  - characterisation: `slowRenames.test.ts` (5 cases, registered in the gate), with harness `harness/slowDisk.ts` (hold or refuse one main call, start a rename without waiting, keep the watcher queue busy);
  - unit: `fileWatcherOwnMoves` (6), `boardMoveHold` (3), `boardSaveMissingFolder` (3), `renameItem` name clash (2), `boardProvisionalMissing` (+2).
- **Proof on `db1af24`:**
  - 4 of the 5 characterisation cases fail there, run in a worktree;
  - the undo case fails with the old awaiting `restoreFiles` restored in this checkout (a worktree run loads the harness and the app as two module instances, so there it can't block the app's queue);
  - the watcher test fails 5 of 6 with the re-key disabled; the one that passes is "another program's rename is still reported".
- **Hardening:** 5 existing watcher cases waited a fixed 400 ms for a 300 ms debounce, and 4 of them flaked under full-suite load (`fileWatcherReconcile` ×3, `watcherSyncEdges` ×1). Their positive checks now poll (`vi.waitFor`); the negative "nothing reported" checks keep their fixed waits.

**Real-app checks** (built app, script `p1sim/phase1.pass.ts` + `playing.pass.ts` in session `323ee1ae` scratchpad, run on this build and on a `db1af24` build):

| Check | `db1af24` | Now |
|---|---|---|
| Folder rename refused (a file in it held open by another process) | "Failed to rename" after 7.1 s; **14 Mind Map links saved pointing at `Notes/Deeper`** | "Failed to rename" after 6.9 s; links unchanged |
| Same folder rename (1,107 notes) once allowed | 0.9 s | 1.0 s |
| Sidebar delete of a Kanban card's note + Ctrl+Z, 35 s after that rename | card back in 3.1 s | card back in 0.5 s |
| Another delete + Ctrl+Z, then quit at once | quit 1.8 s | quit 1.1 s; card and note saved, no sentinel left |
| Rename of a folder holding a loaded Video and Audio tile | renamed in 0.6 s, but **both tiles then show "format not supported"** (404s) | renamed in 0.6 s; both tiles play from the new path |
| Same, while the Audio tile plays (a 10-minute WAV) | renamed in 0.6 s | renamed in 0.6 s |

**Deviations from the plan**

1. **1.1 mechanism.** The plan said: compute the rewritten links before the IPC; `markDirty` after success; on failure, put back only the affected boards.
   - Instead nothing is rewritten before the IPC at all; only which boards are affected is worked out, for the sentinel.
   - A failure then needs no revert, and an edit made meanwhile survives by construction, which is simpler than a per-board revert.
   - The plan's hold alternative is used only for boards whose own file moves.
2. **1.2 refusal.** The writer refuses by board id while the board's file is moving. The plan's "a board path rebound by a rename still in flight" no longer arises, since the path isn't rebound until the move is done. Added `deferFire`, so a slow rename doesn't flash "Save failed".
3. **1.5 (D1): a toast, not the quit dialog's waiting state.** The dialog's choices (Retry now / Quit anyway / Stay open) don't fit a running undo, which quit must simply wait for. The toast covers Ctrl+S and close as well as quit. After 1.3 and 1.4 the wait is short in practice (quit 1.1 s above).
4. **1.7 (A26-29) not reproduced.** Filo's own `filo://` streams don't block a folder rename in the built app, either with a loaded Video and Audio tile or while a long Audio tile plays (both builds rename in about 0.6 s).
   - A plain Node read stream left open does block a folder rename on Windows (EPERM), so the refuter's concern was reasonable; Chromium's use of the response evidently doesn't hold the file that way.
   - Stream-closing code was written, then removed as unneeded.
5. **1.8.** The checks are a focused script rather than an extension of `sim.pass.ts`, run on both builds; the table above has the numbers the plan asked for.

**New findings**

- **"Save at original location" did nothing for a loaded board.** Its write's pre-write stat met ENOENT and returned as a clean no-op, because every loaded board has a drift baseline; the unit test passed only because it set none.
  - The edit then stayed in memory, and nothing counted as unsaved.
  - Fixed with 1.2: `recreateBoardAt(path)` marks the one write allowed to create the file (and its folder) again, sent as `board:save … { recreate: true }`.
  - Covered by a new `boardProvisionalMissing` case with a baseline.
- **On `db1af24`, renaming a folder broke the Video and Audio tiles in it** until the board was reopened. The early link rewrite made them request the new path before the folder had moved (404), and they didn't recover. Gone with 1.1 (real-app table).
- **The reconcile walk can briefly lock a folder against rename on Windows** (it opens notes to hash them). `renameItem`'s lock retry covers it. Seen as EPERM in the watcher unit test, whose own rename now uses the same retry.

**Scores after Phase 1** (the targets in the table above):
- Boards: write safety 9;
- Renames, moves, trash and their undo 8.5;
- Sync and outside changes 9;
- Open / close / quit / recovery 8.5;
- Undo / redo 7.5.

Overall 8.5, as targeted.

## Phase 2: editor writes that break Markdown (A26-04, A26-05, A26-11, A26-12, A26-22, A26-23)

### 2.1 Aligned or indented list items (A26-04)

- **DECISION D2:** the Align and Indent buttons don't apply inside list and task items.

  *Default: disabled there, with a tooltip. The alternative, writing the whole list as HTML, loses Markdown lists for other apps.*
- `createEditor.ts:180-183`: never emit block-layout HTML for a paragraph inside a list item, as a backstop.
- Test: toolbar round trip of Select All → Center on a nested list.

### 2.2 Marks on line breaks (A26-05)

- Before serialising, strip from every hard and soft break any mark that isn't on **both** neighbours.
- Do the same in `writeMarkdownTable`, where cells skip `withSoftBreakMarksTrimmed` (`tableMarkdown.ts:111`).
- Tests: Finder B's T2 / T5 / T7 cases (quote, heading, table cell, soft and hard break).

### 2.3 Non-flanking emphasis (A26-11, N1)

- In Filo's serializer state, treat an output position of 0 as a real position (`start !== undefined`).
- Where a delimiter run still can't flank, write the run as `<strong>`, `<em>` or `<s>` instead (N1's own fix).
- Tests: `**A)**Answer`, `a,*b`, `**Name:***Aria*`.

### 2.4 Zero-padded list numbers (A26-12)

- `textEscapes.ts:103`: escape `^(0*1)([.)])` at a line start.
- Tests: `Chapters:` + Shift+Enter + `01. Arrival`; a soft-break variant.

### 2.5 Code block from a soft-break paragraph (A26-22)

- Convert soft breaks to newlines when a paragraph becomes a code block, as hard breaks already are.

### 2.6 Nested ordered-list start (A26-23)

- Write a nested ordered list that doesn't start at 1 with a blank line before it (or as `start` HTML), so it can't merge into the parent's text.

### 2.7 The property test compares documents (FB-15)

- `editorRoundTripProperty.test.ts`: after save → reload, compare the ProseMirror documents (with the normalisation in `finderB_repros/zzA26B_fuzz.test.ts`), not just the Markdown text.
- Extend the generator with:
  - marks on breaks;
  - alignment and indent;
  - nested list starts other than 1;
  - `01.` after a break;
  - URLs;
  - three or more marks per run.
- Keep the gate's 500-document floor.

### Phase 2 outcome (2026-09-30)

**Status:** done. Verified on Windows:
- `npm run ci:verify` green: 772 test files, 7,258 tests passed (5 skipped), 89/89 gates;
- the property test at its fixed seed (500 documents);
- a sweep of 16 other seeds, 1,500 documents each (24,000), after the last serialiser change: 14 green, 2 counter-examples, both the `minimalEscapes` shape recorded below for Phase 3 (an escape moves between saves; the document is the same, and the note opens read-only rather than different). Earlier sweeps found the four new findings below and the rule-of-three shapes, all fixed;
- the E2E suite on the built app: 22 passed, 3 skipped (the scale budgets), including `editorFidelity.e2e.ts` with five new cases (below), which also passed three times on its own.

**What changed**

- **2.1 (A26-04, D2): no alignment or indent inside a list or checklist item.** New module `lib/editor/listItemLayout.ts`:
  - `FiloTextAlign`: `setTextAlign` skips list items, and fails when nothing it touches can be aligned. Select All + Center aligns only the text outside lists.
  - The toolbar's Align control is disabled while the caret is in a list, code or a connection label (`can().setTextAlign`), and in a list its tooltip says "Text in a list can't be aligned".
  - `ListItemLayout`: whatever still brings a layout into a list item (a centred paragraph made into a list, a paste) has it cleared by an `appendTransaction`, so the editor shows what the file holds.
  - Backstop: the paragraph and heading writers never write block-layout HTML directly in a list item.
- **2.2 (A26-05): a line break keeps only the marks on both sides of it** (`withBreakMarksTrimmed` in `softBreak.ts`, replacing the soft-break-only, next-side-only trim). Applied to paragraphs, headings and now table cells. A selection from the end of a line to the end of the next, then Ctrl+B / I / strike, saves as `> Name: Aria\n> *Age: 24*`, `# Title<br>**Sub**`, `| c<br>*more* |`.
- **2.3 (A26-11, N1): bold, italic and strikethrough are written as Markdown only where Markdown reads them back.** New module `lib/editor/delimiterRuns.ts`, installed by `createTiptapEditor`:
  - The editor's serializer now uses prosemirror-markdown's own state, without tiptap-markdown's delimiter tidy. Each run's delimiters are recorded where they are written.
  - Once the note is written, a run whose opening delimiter can't open, or whose closing one can't close (markdown-it's `scanDelims`), is written as `<strong>` / `<em>` / `<s>`.
  - Where a delimiter could go either way (between two letters or two punctuation marks), Markdown's pairing must still land on the run as written, or the run is HTML too: a delimiter merged with a neighbour's into a run that could both open and close; an opening that could close while another run of its character is open around it (`***A*b*c***` read the second `*` as closing); a pair the rule of three won't pair.
  - `**A)**Answer` → `<strong>A)</strong>Answer`; `a,*b` → `a<em>,</em>b`; `**Name:***Aria*` → `<strong>Name:</strong>*Aria*`; `***A*b*c***` → `***A*b<em>c</em>**`. Runs that read back stay Markdown (`**Name:** Aria`, `**Kasai**san`, so an intraword run in another app's note doesn't become read-only).
- **2.4 (A26-12):** after a line break, `0{0,8}1.` / `)` is escaped (`01\. Arrival`), since any number worth 1 can start a list under text.
- **2.5 (A26-22):** making a paragraph code (toolbar, Ctrl+Alt+C, or typing a fence) turns its soft breaks into lines of code first (`softBreaksAsHardBreaks`, `FiloCodeBlock`'s commands and input rules).
- **2.6 (A26-23):** a tight list whose item holds a numbered sub-list not starting at 1 right under the item's text is written loose (`- parent\n\n  3. child`), which reads back as a list.
- **2.7 (FB-15): the property test compares documents.** `editorRoundTripProperty.test.ts`:
  - after save → reload, it checks the reloaded document shows what the generated one did (`shownDocument`), besides "not lossy" and "same bytes";
  - the generator now covers marks on breaks, alignment and indent (outside lists), numbered lists starting at 2, 3 or 10, `01.` / `001)` / `1)` / `- ` / `# ` / `> ` lines, autolinks and links with awkward addresses, bare URLs, up to three marks per run, bold / italic / strikethrough over punctuation straight against their neighbours, and highlight;
  - the gate `editor-round-trip-property` now also requires the document comparison (proved: removing it fails the gate).
- **Tests added:**
  - unit `editorEditsReadBack.test.ts` (35 cases: Finder B's T2 / T5 / T7 and heading / cell flows, the N1 shapes, `01.` after Shift+Enter and in a soft line, code from a soft-break paragraph, nested start 3);
  - `toolbarFormattingRoundTrip.test.ts`: the "centred list item" case now expects the list left alone, plus Select All + Center / Right over nested bullet, numbered and checklist lists, indent-then-list and centre-then-checklist, and an old aligned list item opening read-only with its line named;
  - `markdownBodyRoundTrip.test.ts`: 12 named `FILO_WRITES` cases from the property test's counter-examples;
  - component `alignInListToolbar.test.ts` (3: Align disabled in a list with its reason, enabled and saving on text; disabled in a checklist; Indent nests a checklist item);
  - E2E `editorFidelity.e2e.ts`: Quote (italic from the end of a line), Chapters (`01.` after Shift+Enter), Characters (Select All + Center with a nested list, Align disabled in the list), Answer (bold `A)` before a letter), Snippet (typing a fence on a soft-break paragraph).
- **Proof on the old code** (this phase's `src/renderer` stashed, the new tests kept): 45 unit cases fail there (every A26-04 / 05 / 11 / 12 / 22 / 23 case, the new findings' named cases, and the property test), and the 3 component cases; all pass with the fix. The cases that pass on both are the regression guards ("a paragraph, soft break, Ctrl+B", runs that stay Markdown, a nested list starting at 1).

**Deviations from the plan**

1. **2.1 (D2): Indent isn't disabled in lists.** In a list the Indent buttons already nest or un-nest the item (a list level in the file, as Tab does), which is safe; only the indent *attribute* is kept out of list items. The buttons used the bullet item type even in a checklist, where they did nothing; they now use the innermost item's type.
   - Beyond the plan: the `ListItemLayout` guard, so no path (list toggles, paste, split) leaves a layout the file wouldn't hold.
   - Consequence: a list item an earlier Filo aligned (`- <p style=…>`) now opens read-only, the banner naming its line; Take ownership saves it as a plain item. The golden fixture `aligned-blocks.md` lost its aligned list item for that reason.
2. **2.3: no shifting at all, and the state is replaced rather than patched.** tiptap-markdown's serializer state isn't exported, so "Filo's serializer state" is prosemirror-markdown's own, driven by tiptap-markdown's node and mark writers. `prosemirror-markdown` (already installed at 1.13.8 as tiptap-markdown's dependency) is now a direct dependency, same version, no new download.
   - The plan kept tiptap-markdown's tidy (only fixing position 0) and fell back to HTML where it still failed. The tidy moved a delimiter across punctuation, which took the formatting off that character, so every run that can't flank where it stands is now written as HTML.
   - The pairing rules came from the property test's seed sweep: `**X***Y**Z***` and `***A*b*c***` shapes paired differently. The merged-run rule also turns `**bold***italic*`, which did read back, into `<strong>bold</strong>*italic*`. Refusing every delimiter that could go either way was the simpler rule, but it would have made existing intraword runs (`**un**believable`) read-only.
3. **2.4:** the escape is capped at nine digits (a longer number isn't a list marker, and an escape there would make an existing note lossy), and it also applies when formatting carries on across the break (a new finding below).
4. **2.6:** only when the item has text above the sub-list; with no text (`- ` then `3.`) the list can start there and stays tight.
5. **2.7:** the seed moved from 20260929 to 20260930 with the rewrite. Three shapes are kept out of the generator, each named in its header: a bare URL as the last word of the first block (FB-06, Phase 3.3), a numbered list starting at 0 (A26-24, Phase 6.2), and the same bare URL twice in one block (new finding below, Phase 3). The document comparison sets aside what the file can't say and the note doesn't show: marks on breaks, the link's rendering attributes, colour spellings, a list's tight / loose spacing, a paragraph of one space (`- &#32;`), alignment on an empty paragraph, and empty paragraphs in quotes and after an item's first block.
6. **Pulled forward from Phase 6.2 (A26-24, FB-10):** a list right after another of its kind is written after one blank line, not two; the second read back as an empty paragraph between them (the property test's first document failure once it compared documents).
7. **Docs pulled forward from Phase 6.4:** KNOWN_LIMITATIONS #32 (it described the delimiter tidy this phase removed) and #17's aligned-block paragraph (list items); CLAUDE.md's tree, tech-stack line and the "writes only Markdown it reads back" note.
8. **Beyond the plan:** the E2E cases above. The Quote case waits 200 ms after its Shift+→ presses and checks the italic landed: Playwright sends keys faster than a person types, and the editor had taken in only six of the eight when Ctrl+I arrived (checked with a mutation and selection probe: nothing reloads the note; it is only timing).

**New findings** (the widened property test found the first four; all fixed here)

- **An autolink was written with Markdown escapes inside `<…>`**, where a backslash is part of the address: a link typed as `https://example.com/~user` or with a `*` reopened pointing elsewhere, read-only. `NoteText` now writes an autolink's text unescaped (`textEscapes.ts`).
- **An autolink whose address Markdown shows decoded** (`%20`, a punycode host) reopened with different text, read-only. Such a link is now written `[address](address)` (new module `autolinkMarkdown.ts`, `FiloLink`).
- **A line after a break whose formatting carries on across it** (underline, colour or bold over `a` / break / `1. one`) wasn't escaped, so `1.`, `01.`, `- ` or `#` there started a list or heading on reopen. Now escaped too (`textEscapes.ts`).
- **A loose list nested in a tight one made the outer list reload loose** (the tight rule counted every `<p>` inside the list, `taskListTight.ts`), so it gained blank lines and opened read-only. Now only the list's own items count. Also in `listMarkers.ts`: in a loose list, an item with no text followed by a sub-list got a blank line after `- `, which ends such an item; the sub-list now follows on the next line.
- **Not fixed, for Phase 3 (read-only shapes): `minimalEscapes` isn't always a fixed point**, so a note can reopen read-only (never silently different: the document is the same, only an escape moves). Two shapes, both from the seed sweep:
  - two identical lines in one paragraph, each with a lone `*` that would pair across them: one escape is dropped, the other kept; on reopen the "keep a line the file holds" rule, keyed by line text, keeps both;
  - a line whose escapes were dropped only in part (the whole-note search tried them together, and kept `\*\*` once dropping it with another run changed the render): on reopen the line no longer matches the file (the serialiser escapes the `_` it had dropped), so its escapes are tried again and both drop.
  - Fix direction: match `keepLines` by position, and settle the search (run it until a second pass drops nothing, or decide each line's escapes on their own).
- **Not investigated, for Phase 6 (hygiene):** loading a note into the same editor again keeps about 0.4 MB of heap each time in the unit environment (1,500 loads of one small note: 204 → 617 MB), on the old code as on the new. A 2,000-run property sweep in one process ran out of its 4 GB heap, so the final sweep read each document back in a fresh editor (the committed test keeps its one reused editor; 500 runs stay well inside the heap). Whether the app itself holds this (it re-loads an open note on every change from disk) needs a heap snapshot in the built app.

**Scores after Phase 2:**
- Editor: nothing lost 8 → 9 (the Phase 3 target, reached here: every Phase 2 item plus the four found above);
- Editor: notes open editable 6.5 → 7 (Filo's own writes no longer produce read-only notes in these shapes; other apps' shapes are Phase 3).

## Phase 3: notes that open read-only for no stated reason (A26-06, A26-16)

### 3.1 A blank line Filo adds is cosmetic

- In `normaliseForRoundTripCompare`, treat a blank line inserted before a block start as the same text: a list, heading, quote, fence, rule or table after a paragraph or heading.
- Better, and **DECISION D3:** decide lossiness by comparing markdown-it's rendered HTML of both sides, with the existing cosmetic rules kept as a fast path.

  *Default: HTML compare. It covers the `1. 1. 1.` numbering, an unspaced `***` and future shapes at once.*

### 3.2 The banner always names a line

- `roundTripChanges` reports inserted or removed lines, e.g. "a blank line would be added above line 7".
- Raw view opens there, and Take ownership lists it.

### 3.3 Autolink on load (FB-06)

- Set `preventAutolink` on the load transaction, so a bare URL in the file stays plain text as KL #17 says.

### 3.4 Remaining shapes

- A tab before a soft break.
- A `"` in a link address: the Insert Link popup should encode it or refuse it.
- An image path with a space (R-04).

Fix each where cheap; otherwise list it in KL #17.

### 3.5 The separator after the frontmatter (A26-16)

- **DECISION D4:** keep the file's blank line(s) between the closing `---` and the body on a body edit.

  *Default: keep them.*

### 3.6 Corpus check

- Re-run the Audit-25 corpus recipe (19,014 notes; `buildList.mjs` plus `zzCorpus.test.ts` in the repo and in a worktree of `db1af24`).
- Pass condition: no note changes bytes, and none becomes newly lossy.
- Record how many are newly **unlocked**.

### Phase 3 outcome (2026-09-30)

**Status:** done. Verified on Windows:
- `npm run ci:verify` green: 775 test files, 7,329 tests passed (5 skipped), 89/89 gates;
- the corpus check (3.6): 18,870 notes, **0 changed bytes, 0 newly lossy, 112 newly unlocked** (18 of them now save byte for byte; the other 94 change only spelling on their first edit, per KL #17's table);
- the property test at its fixed seed (500 documents), plus a sweep of 14 other seeds at 1,500 documents each (21,000) on the final code: no counter-example. Two seed runs hit the test's 180 s timeout under load; seed 5 re-run alone passed all 1,500 (worst document 325 ms);
- the E2E suite on the built app: 22 passed, 3 skipped (the scale budgets; Phase 3 touches no shell, startup, quit, watching or rename code, but it changes what a save writes, so the editor-fidelity, no-bytes-by-looking and BOM specs were worth a run).

**What changed**

- **3.1 (A26-06, D3 = HTML compare, as defaulted): a note is read-only only when a save would change what it says.** New module `lib/editor/renderedSame.ts`. `isLossyMarkdownRoundTrip` keeps the cosmetic rules as the fast path; past them, both texts are rendered with the note's own markdown-it and must give the same HTML. Two things the HTML doesn't show still count:
  - link reference definitions (their parsed set must match), since a save that dropped one, even an unused one, would render the same;
  - a backslash escape the file didn't have in front of a character other apps give meaning to (brackets, `!`, `#`, `$`, `%`, `=`, `^`, `|`, `~`, `<`, `>`, braces, backtick, `:`, `@`, `&`): markdown-it reads `\[\[Page\]\]` like `[[Page]]`, Obsidian doesn't.

  Unlocked by this alone: a list, checklist, heading, quote, fence or table straight under text (or text under a heading), `1. 1. 1.` and `01. 02.` numbering, an unspaced `***`, lazy continuation lines, an indented continuation line, entities, raw `<` / `>`, a tab opening a heading, padded inline code.
- **3.2: the banner always names a line.** `roundTripChanges` now diffs the changed region (a longest-common-subsequence edit script, positional pairing past 1,500 lines), pairs text lines with text lines, and reports an added line with the file line it goes above (`above`). When anything else changes, blank lines added or dropped are left out (the spelling, not the reason). `locateChanges` / `describeChange` (`lossyChanges.ts`): "Saving would add a blank line above line 7", "A blank line would be dropped"; Edit in Raw view opens at that line and Take ownership lists it.
- **3.3 (FB-06): a load never autolinks.** `preventAutolink` on the load transaction and on the empty-paragraph sentinel strip. A bare URL anywhere in the file stays text; typing a URL and a space still links it.
- **3.4 (remaining shapes):**
  - a tab before a soft or hard break is written as a tab (`tabNode.ts`: `&#9;` only opening a line or ending a block), since markdown-it keeps it there;
  - the Insert Link popup percent-encodes `"` and the other ASCII characters markdown-it encodes in an address (`<`, `>`, backtick, braces, `|`, `\`, `^`) (`normaliseLinkUrl`), so a typed address reads back as typed;
  - an image path with a space (R-04) now saves byte for byte (below).
- **The Phase 2 carry-over: `minimalEscapes` is a fixed point.** `withMinimalEscapes` first writes each line the loaded file holds as the file spells it: a line is matched by what it says with every escape taken out, in file order (the next unused match after the last one, else any unused one), and the swap is kept while markdown-it renders the whole note the same (split and retried per span, within the render budget). Both Phase 2 shapes (identical lines escaped differently; escapes dropped only in part) now save byte for byte. `loadedLines` is now the body's lines in order, not a set.
- **3.5 (A26-16, D4 = keep, as defaulted):** `assembleNoteText` puts the fresh read's blank lines between the closing `---` and the text back in front of a new body (`withBlankLinesAfterFence`), in both the body-only and the body-plus-frontmatter paths; `sameBody` ignores leading blank lines (the editor never holds them), so the drift and echo checks don't see the kept separator as a change.
- **Tests added or changed:**
  - unit `notesOpenEditable.test.ts` (50 cases through the real editor: every A26-06 / FB-06 / FB-07 / R-04 shape, what stays read-only and the line it names, the fixed-point shapes, a typed link with `"`, the frontmatter separator, `sameBody`);
  - unit `renderedSame.test.ts` (escape counting, the extension-escape guard, references, the three-argument `isLossyMarkdownRoundTrip`);
  - `lossyChanges.test.ts` (blank line above a line, pairing around blank lines, locating an addition), `minimalEscapes.test.ts` (the new escapes, brackets that would make a link, a heading marker);
  - component `keepNoteSpelling.test.ts` (typing on the line of an Obsidian note with a separator, callout, wiki link and `[TODO]` writes only what was typed) and two new cases in `lossyBannerNamesLine.test.ts` (a blank-line-only change names its line; a Keep checklist note has no banner);
  - the property test: the bare-URL and "same URL once per block" exclusions are gone;
  - golden corpus: `link-schemes` left the lossy set (baseline: the fixture bar its final newline); `misc-syntax`'s callout keeps `[!note]`.
- **Proof on the old code** (`src/renderer` stashed, the new tests kept): 67 cases fail there, across 7 files; all pass with the fix.

**Deviations from the plan**

1. **3.1: beyond the plan, the extension-escape guard and the reference-definition check.** HTML equality alone would have unlocked notes whose save drops an unused `[1]: https://…` line (renders nothing), and notes whose `[[wiki links]]` a save would escape (renders the same in markdown-it, breaks the link in Obsidian). Both stay read-only.
2. **3.4: the image path and every other "Filo escapes what the file doesn't" shape were fixed rather than listed in KL #17.** The fixed-point work (matching lines by what they say) makes any unedited line save as the file spells it, so `[[wiki links]]`, `![[embeds]]`, `> [!note]` callouts, `[TODO]`, footnotes, `C:\Users` paths and `#tags` all save byte for byte.
   - A component test then showed the gap this left: typing on the *same line* as a wiki link re-escaped it (`\[\[Page\]\]`), which would have broken the link in Obsidian now that the note is editable. So the minimal-escape search now also tries `[`, `]`, `#`, `~` and `\` escapes (was `*` and `_` only), dropping each where markdown-it renders the note the same: brackets typed in Filo are now written bare too (`Hello [x]`), and a bullet whose text starts `[ ]` keeps an escape so it doesn't become a task.
   - Cost: a save of a 69 KB note with many brackets takes 35 ms (was 23 ms); load unchanged.
3. **3.4: a tab before a hard break** (not only a soft break) is written as a tab: markdown-it keeps it before `\` or `<br>` too.
4. **3.6: the corpus was compared against `HEAD` (`5b90a6f`, Phase 2), not `db1af24`.** Phase 2 changed outputs on purpose; comparing with its result isolates what Phase 3 changed. The list is 18,870 notes (Audit-25's recipe re-walked; scratch folders have changed since).
5. **Docs pulled forward from Phase 6.4:** KNOWN_LIMITATIONS #17 rewritten (how "would change" is decided, what stays read-only, the first-edit spelling table extended, the separator kept, bare URLs on load), CLAUDE.md's tree (`renderedSame.ts`, `minimalEscapes.ts`, `lossyChanges.ts`, `tabNode.ts`) and the "writes only Markdown it reads back" note.

**New findings**

- **Inline code inside bold, italic or a link** (``**`npm run`**``, ``[`CLAUDE.md`](CLAUDE.md)``) opens read-only: the editor's code mark excludes other marks, so a save would drop the bold or the link. Correctly read-only (the banner names the line); listed in KL #17. Seen in the corpus's READMEs and project docs; not fixed (a schema change).
- **What still keeps a corpus note read-only** (372 of 18,870, almost all package READMEs and project docs): HTML blocks and comments, reference definitions, and the code-in-bold/link shape above.
- **The property test got slower:** 1,500 documents take about 130 s per seed (Phase 2's sweep: 70–106 s), from the extra renders in the escape pass on its deliberately dense documents. The committed 500-run test stays well inside its 180 s timeout.

**Scores after Phase 3:**
- Editor: notes open editable 7 → 8.5 (the target: the everyday Keep and Obsidian shapes open editable, what stays read-only names its line, and Obsidian syntax survives an edit);
- Editor: nothing lost stays 9;
- Document tab and sidebar: the separator (A26-16) fixed.

## Phase 4: Kanban and interface (A26-08, A26-09, A26-10, A26-13, A26-26, A26-28)

### 4.1 Kanban find (A26-08)

- `kanbanFiltersAndSort.svelte.ts:86-88`: use `noteBody(notePath)`.
- Unit test with a card whose note isn't open.

### 4.2 Shortcuts behind dialogs (A26-09)

- The global handler (`core/hotkeys.ts`) and the `AppShell` shortcuts skip everything except `allowInEditor` keys while any `dialog[open]` or `[aria-modal="true"]` is up.
- **DECISION D5:** or give every Modal `isolateShortcuts` by default.

  *Default: the global check. One place, and it covers confirms too.*
- Component test: Ctrl+Z and Ctrl+W with the Tags Browser open do nothing to the board.

### 4.3 Sidebar name search (A26-10)

- While a name search is active, every folder left in the filtered tree shows open (as the tag filter does).

### 4.4 Right-click on an unmounted card (A26-13)

- `LazyTextTileBody`: remember the pointer button in `onpointerdown` and skip `caretTarget` for button ≠ 0.
- Skip the focus in `handleEditorReady` when a menu or dialog holds focus.
- **DECISION D6:** which menu a right-click on card text shows once the editor is mounted.

  *Default: Filo's card menu, as before mount.*

### 4.5 Board Browser Enter (A26-26)

- In the row handler, `if (e.target !== e.currentTarget) return;`, as `VaultFileItem` does.
- Correct KL #46.

### 4.6 Small ones (A26-28)

- The checklist badge counts only task items.
- Add `pointercancel` to box-select and the connection-label drag (the gate `pointer-capture-cleanup` should then cover them).

### Phase 4 outcome (2026-09-30)

**Status:** done. Verified on Windows:
- `npm run ci:verify` green: 777 test files, 7,344 tests passed (5 skipped), 89/89 gates;
- the E2E suite on the built app: 23 passed, 3 skipped (the scale budgets). The new right-click spec fails on a build without the `LazyTextTileBody` fix (the menu loses the focus).
- after the owner's review (folder-name search, Mind Map right-click): `ci:verify` green again (7,348 tests, 89/89 gates); the E2E suite 22 passed, 1 failed, 3 skipped. The failure was `quitMinimized` "typed, saved, minimized for 20 s": the note saved as `Original line EDITED  ` (the typed space landed after the word). It passed 6 of 6 on a repeat run, and it types into a Document tab, which the changes don't touch: the known Playwright-keys-outrun-ProseMirror flake (see New findings).

**What changed**

- **4.1 (A26-08): the Kanban find reads every card's text.** `tileMatchesFilters` reads `noteBody(path)`: the open note's model when there is one, else the vault index's copy. Cards whose editor hasn't mounted (most of a long column) match on their text again, and so do mounted ones after a find (the models they held were let go).
- **4.2 (A26-09, D5 = one global check, as defaulted): shortcuts leave the board behind a dialog alone.** `core/hotkeys.ts` skips every shortcut while a modal dialog is up (`isModalDialogOpen`, new `lib/utils/modalOpen.ts`: a `dialog[open]` or any `aria-modal="true"`, the same test the Mind Map's own keys already used), except Escape (it closes the top layer) and commands registered `allowInDialog` (only Save). The Kanban and Task List board handlers already act only on keys from inside their board, which a focus-trapped dialog never sends.
- **4.3 (A26-10): the sidebar name search shows its matches.** `sidebarTagFilter` treats the name search like the tag filter: every folder left in the cut-down tree shows open unless the user collapses it during this search; a new query (or tag) starts open again; the user's own expanded folders are untouched and come back when the search clears. Expand / Collapse All act on what the search shows. After the owner's review, a folder whose **own name** matches is shown too, with everything inside it (`filterTree`); it and the folders above any match open, while the folders inside it start closed unless they hold a match (`foldersOpenForSearch`), so a match on a big folder doesn't open everything under it.
- **4.4 (A26-13, D6): a right-click on card text is not a press into it.**
  - `LazyTextTileBody` cancels the focus a right or middle press would give card text that isn't being edited (`mousedown` default prevented), so the preview neither mounts its editor nor takes focus; the editor that would have stolen the menu's focus a frame later never starts.
  - `handleEditorReady` leaves the focus alone when a context menu is open or focus sits in a menu or dialog.
  - D6: the card's menu shows on card text whether or not its editor has loaded (`wantsNativeTextMenu`, used by the Kanban card's context-menu handler), and the right-click is left to spell-check only while that card's text is being edited.
  - Filo's only built-in right-click menu is spell-check (`main.ts`, `context-menu`): suggestions and "Add to Dictionary" on a misspelled word, and nothing at all elsewhere. There is no cut / copy / paste menu (an earlier draft of this section, and an older comment in `editableTarget.ts`, said there was; both corrected).
  - **Mind Map text tiles, the same rule (option A, the owner's choice after review):** `TextTile` marks its text (`data-tile-text`) and keeps a right or middle press on text that isn't being edited from focusing it (`keepFocusOnSecondaryPress`, shared with `LazyTextTileBody`), and `MindMapBoard`'s context-menu handler uses `wantsNativeTextMenu`. A right-click on a tile's text now opens the tile menu, without moving the caret into it; the tile being typed in keeps spell-check. Before, a right-click on a tile's text showed nothing (or spell-check on a misspelled word) and moved the caret there; the tile menu was only on the header and edge.
- **4.5 (A26-26): Enter on a Board Browser row's Rename or Delete button is that button's.** The row's key handler returns unless the row itself is the target. KL #46 corrected.
- **4.6 (A26-28):**
  - the checklist badge counts task items only (`lib/kanban/checklistProgress.ts`: a list item opening with `[ ]` / `[x]`, nested or quoted; not a `[x]` in text, inline code, a link or a fenced block);
  - box-select ends its box on `pointercancel` (keeping what it had selected); a cancelled connection-label drag puts the label back and leaves no undo step;
  - the gate `pointer-capture-cleanup` now requires a `pointercancel` / `lostpointercapture` handler for **every** pointer capture, not only those that open a spatial batch (proved: it fails with the label's handler removed).
- **Tests added or changed:**
  - unit `kanbanFiltersAndSort.test.ts` (a card whose note no editor has opened matches on its text), `hotkeys.test.ts` (a dialog up: Ctrl+Z skipped and not `preventDefault`ed, Save and Escape fire), `checklistProgress.test.ts`, `marqueeSelectionCancel.test.ts`;
  - component `lazyTextTileBody.test.ts` (a right press doesn't focus or mount; an editor loading under an open menu leaves the focus; the menu a mounted card's text gets, editing or not), `connectionLabelSaved.test.ts` (a cancelled label drag);
  - unit `vaultTreeSortHelpers.test.ts` (a folder whose name matches is kept whole; `foldersOpenForSearch`);
  - characterisation `boardShortcutsAndUndo.test.ts` (Ctrl+Z and Ctrl+W with the Tags Browser open; Enter on the Board Browser's buttons; a right-click on a Mind Map tile's text, not being edited and being edited), `tagFilters.test.ts` (the name search opens folders; a search on a folder name; one existing case updated, since it pinned the old closed folder);
  - E2E `kanbanClick.e2e.ts`: a right-click on card text, before and after the editors load, opens the card menu, which keeps the focus; a key typed then changes no file.
- **Proof on the old code** (each fix reverted alone, its tests kept): every new case fails there (find 1, dialog shortcuts 1, sidebar 2, folder-name search 1, right-click 3, Mind Map right-click 1, Board Browser 1, label cancel 1).

**Deviations from the plan**

1. **4.2: the exception list is Escape plus an explicit `allowInDialog`, not "the `allowInEditor` keys".** `allowInEditor` also covers Ctrl+O, Ctrl+Shift+W, Ctrl+, and Ctrl+Shift+F, which would open a vault, close it, open Settings or the Search panel behind the dialog. Only Save is marked `allowInDialog`. `Modal`'s `isolateShortcuts` is kept (Settings still sets it) but is now redundant for app shortcuts.
2. **4.4: the focus is cancelled at the press rather than by remembering the button.** `handlePointerDown` already ignored a right press; the mount came from the *focus* the browser gives a `tabindex` preview on any press. Preventing that focus also keeps the menu's "return focus to the opener" from landing on the card and mounting it after the menu closes.
3. **D6 refined:** the card menu shows on text that isn't being edited, mounted or not (the default), but a right-click in a card the user is typing in is left to spell-check, so its suggestions stay where they are used. A right press on a mounted card that isn't being edited doesn't move the caret or focus into it either.
7. **Beyond the plan, after the owner's review of the new findings:** D6's rule extended to Mind Map text tiles, and the sidebar search shows folders by their own name (both below, now fixed).
4. **4.6: four more drags got `pointercancel`** (the Tile, Frame, Connection and Element style popups' header drags), found by widening the gate; each now ends its drag on cancel.
5. **E2E run although Phase 4 touches no shell, startup, quit or watching code:** the right-click fix depends on Chromium's focus-on-press behaviour, which jsdom doesn't model.
6. **Docs pulled forward from Phase 6.4:** KL #46 (with 4.5, as planned) and CLAUDE.md's tree (`modalOpen.ts`, `checklistProgress.ts`, `editableTarget.ts`, `hotkeys.ts`, `sidebarTagFilter.svelte.ts`) and the `components` gate row.

**New findings**

- **The name search matched file names only** (older than Phase 4): searching "Chapter 1" didn't show a folder "Chapter 1 - Blah" unless a file in it had "Chapter 1" in its name. **Fixed** (the owner's call): see 4.3.
- **A right-click on a Mind Map text tile's text showed no menu** (or spell-check on a misspelled word), and put the caret there; the tile menu was only on its header and edge. **Fixed** with option A (the owner's call): see 4.4. Options not taken: B (leave it), C (also the tile menu in the tile being typed in when no word under the pointer is misspelled; needs main to tell the renderer, since only it knows).

- **`quitMinimized.e2e.ts` types `' EDITED'` in one `keyboard.type` call**, which can outrun ProseMirror's reading of the DOM selection (seen once in 7 runs: the space landed after the word). Not a product bug; the spec should type with a delay (`{ delay: 50 }`) and check what the editor shows before quitting. For Phase 6 (hygiene).

**Scores after Phase 4:**
- Kanban 7 → 8 (find, right-click and the badge fixed; A26-14's undo placement is Phase 5);
- Accessibility and keyboard 6.5 → 7 (shortcuts behind dialogs, Board Browser Enter; N12 / N13 still open);
- Document tab and sidebar: the name search (A26-10) fixed.

## Phase 5: undo, tags and search (A26-07, A26-14, A26-15, A26-25, A26-27)

### 5.1 Replace All and markup (A26-07)

- **DECISION D7:** by default, leave matches inside Markdown syntax alone:
  - a line-start list or number marker;
  - a rule or table delimiter row;
  - a link or image destination;
  - an HTML tag.

  The confirm says "N matches inside Markdown formatting were left alone". *Default: yes.*
- Document it in KNOWN_LIMITATIONS.

### 5.2 Undo of a sidebar delete (A26-14)

- **DECISION D8:** always show the "moved to Filo's trash" toast with **Undo**, while keeping the step on the active board's stack; undoing from either removes it from the other.

  *Default: yes.*
- Settings → Trash restore should also put back the tiles the delete removed, when the trash entry carries them.

### 5.3 Tag rename speed and drain scope (A26-15)

- Profile the per-note cost (78 ms a note).
- Batch the writes and the vault-index publishes.
- Scope the sweep's drain to the notes it touches, so renames and deletes elsewhere aren't blocked for two minutes.

### 5.4 Undo of an empty key (A26-25)

- `frontmatterInverse.ts:99-110`: a key present with no value is restored as present-and-empty, not deleted.

### 5.5 Search re-runs (A26-27)

- Re-run the Search panel's query on its own inputs and `listVersion`, and refresh body matches on a short debounce, not on every autosave.

### Phase 5 outcome (2026-09-30)

**Status:** done. Verified on Windows:
- `npm run ci:verify` green: 781 test files, 7,375 tests passed (5 skipped), 89/89 gates;
- the E2E suite on the built app: 23 passed, 3 skipped (the scale budgets). Phase 5 touches no shell or quit code, but the tag sweep now writes several notes at once while the watcher runs, so it was worth a run.

**What changed**

- **5.1 (A26-07, D7 = leave syntax alone, as defaulted): Replace All changes words, not structure.** New pure module `lib/search/markdownSyntax.ts` finds the syntax ranges in a note body: a list or number marker opening a line (in a quote too, with a task box after it), a thematic break or a table delimiter row (whole line), a link / image / reference destination or autolink, and an HTML tag or comment.
  - `runVaultSearch` flags a body match that touches one (`SearchMatch.inSyntax`); Find still shows it.
  - `replaceableMatches` counts those apart, and the confirm says "N matches inside Markdown formatting (list markers, rules, table lines, link addresses and HTML tags) are left alone." When every match is syntax, a toast says so and nothing runs.
  - `buildPlans` re-checks each match against the syntax ranges of the **fresh** file it reads, so what is left alone is decided on the bytes being written, not on the index copy.
  - Replace (one match) on a syntax match says why it won't.
  - KNOWN_LIMITATIONS #48.
- **5.2 (A26-14, D8 = always a toast, as defaulted): a sidebar delete's undo is offered wherever the user looks.** `offerDeleteUndo` (`stores/vaultDeleteOps.ts`):
  - the step stays on the active board's stack (Ctrl+Z there still undoes it);
  - the "moved to Filo's trash" toast is now shown for every sidebar delete, and its Undo takes the step off whichever stack holds it (`historyStore.undoFromToast`, which the CascadeDelete command qualifies for: no target board, and its undo puts back only the item and the placements a board no longer holds). Undone from Ctrl+Z first, the toast's Undo says the item is already back; dropped by a board reload, it points to Settings → Trash;
  - **Settings → Trash restore brings the tiles back too** while the delete's step is still in the history: `trash.svelte.ts` keeps a per-session registry (`registerDeleteUndo`, keyed by the command's current trash id, emptied at every vault swap), and `trashStore.restore` runs the delete's undo instead of a bare restore ("Restored X and the tiles that showed it.").
  - With no board open the step is held off every stack as before, and the toast and Settings → Trash reach it through `undoOffStack`.
  - KNOWN_LIMITATIONS #43 extended (an Undo from the toast leaves nothing to redo).
- **5.3 (A26-15): tag rename 2.6× faster, and it no longer blocks renames and deletes.** Profiled with a timing probe in the characterisation harness (real main-process IPC handlers on a temp vault, the Tags Browser open). Three costs, per note:
  1. the rewrites ran strictly one after another (each an fsync'd atomic write, about 50 ms);
  2. every rewrite published the vault index at once, and a tag change bumps `listVersion`, so every tag view (the Tags Browser counts, the sidebar chips) re-counted the whole vault **per note**: O(N²), which is why the audit's 5,000-note vault paid more per note than a small one;
  3. each write armed and cleared the crash sentinel (two more small file ops per note).

  Fixes:
  - the sweep reads and rewrites six notes at a time (new `lib/utils/forEachLimited.ts`); each rewrite is still a fresh read inside the note's own queue;
  - `vaultIndexStore.batchPublishes` (used by `runTagRewriteSweep`, so rename, delete, their undo and Resume all get it): inside it the index tells `version` / `listVersion` readers on the 150 ms throttle, and once at the end;
  - a removal's progress breadcrumb is rewritten one write at a time with the latest list, not once per note;
  - **the drain is scoped and short**: the sweep drains only the notes it will rewrite, once, before it starts, and holds nothing while it writes. A rename, delete or restore elsewhere now runs at once instead of waiting for the whole sweep. The rewrites need no exclusion: each runs in its note's write queue and follows a rename (`movedTo`, already there).

  Harness timings (1,000 notes, the Tags Browser open): **68 ms → 26 ms per note**; at 200 notes 64 → 31 ms. Sentinel file ops fell from 402 to about 60 per 200 notes.
- **5.4 (A26-25): undo puts back an empty key as it was.** `inverseDelta` records a key present with no value (`status:` → `null`, `due: ""` → `''`) as a set, not an unset; the writer already keeps a `null` for a key the file holds. The CST engine now writes a `null` as a bare `key:` (`serializeKeyValue`; the value-only splice no longer handles `null`), never `key: null`.
- **5.5 (A26-27): an autosave no longer re-runs the vault search.** `runVaultSearch` reads each note's title, tags and body untracked; it re-runs on the query, the options, the board cache and `listVersion` (a note added or gone, a tag changed). A note edit re-runs it only once notes have settled for `NOTE_REFRESH_MS` (400 ms), and only while the panel is open with a query (`search.svelte.ts`, an effect that only restarts a timer, and skips a refresh when the index hasn't moved since the last search). Replace All and its confirm work from `searchStore.searchNow()`, a search run at that moment, so a match that moved in the last 400 ms isn't skipped as stale.
- **Tests added or changed:**
  - unit `fieldCommandUndoBytes.test.ts` (`status:` and `due: ""` come back byte for byte on undo);
  - component `searchNoteRefresh.test.ts` (three autosaves don't re-run the search; it re-runs once they pause; a new note or a new query re-runs at once; nothing runs with the panel closed);
  - unit `markdownSyntax.test.ts`, `replaceAllCommand.test.ts` (four cases: a dash in a sentence vs list markers and a task box, `--` vs a rule and a delimiter row, a word in a link, image path, reference definition, HTML attribute and autolink, only-syntax matches), `replaceAllText.test.ts` (the count and the confirm's line); the cap case now uses a real 5,001-match note, since Replace All searches again itself;
  - characterisation `trash.test.ts` (a card on a Kanban deleted with a Mind Map active: the toast's Undo brings the note and the card back and leaves nothing on the Mind Map's stack; Ctrl+Z first, then the toast says it is already back; Settings → Trash restores the note and the card);
  - unit `tagRewriteSweep.test.ts` (a drained op on another path runs while the sweep is still writing), `tagSweepProgress.test.ts` (progress counts finished notes, up to the total), `forEachLimited.test.ts`; component `vaultIndexBatchPublishes.test.ts` (fifty tag changes re-count the tag views once).
- **Proof on the old code** (each fix reverted alone, its tests kept): empty key 2 fail, search refresh 2, Replace All syntax 4, sidebar delete 3, sweep drain 1.

**Deviations from the plan**

1. **5.1: Replace works from a fresh search, not the panel's list** (a consequence of 5.5's debounce: the list can trail an edit by 400 ms, and a stale offset is skipped silently). The confirm's counts come from the same fresh search.
2. **5.1: the syntax check is deliberately line-based**, not a full Markdown parse: a list-looking line or a rule inside a code block counts as syntax too (left alone, and counted in the confirm). Heading markers, emphasis delimiters and blockquote markers are not in D7's list and are still replaced.
3. **5.2: Settings → Trash brings tiles back only within the session** (while the delete's step is in the undo history). The plan said "when the trash entry carries them"; the entry on disk doesn't: board snapshots in `.filo/trash/<id>/manifest.json` would go stale as boards change, and replaying them after a restart could overwrite later edits. After the step has left the history (a restart, a board reload, the history cap), Settings → Trash restores the file alone, as before.
4. **5.3: the sentinel toggling wasn't changed at its source.** Running six writes at a time keeps the in-flight count above zero for most of the sweep, which removed most of the arm / clear pairs without touching `writeStateTracking`.
5. **5.3: progress counts finished notes** (`done` reaches `total`), not notes started, since several run at once.
6. **5.5: the search store owns its debounce** (a module-level `$effect.root`), so it works whether or not the panel component is mounted; it only runs while `open` and a query is set.

**New findings**

- **The query parser trims the needle**: searching ` - ` finds every `-`. Replacing it then adds spaces around hyphens in words (`well-known` → `well – known`). Older than Phase 5; not fixed (a query-syntax decision). For Phase 6 or the owner.
- **The unit test project runs Svelte's server build**, where effects never run and a `$derived` re-computes on every read; reactivity tests (like 5.5's) must live in the component project (`probeDerived`).

**Scores after Phase 5:**
- Undo / redo 7.5 → 8.5 (a delete's undo is reachable from the toast and Settings → Trash; empty keys come back);
- Tags and search 7.5 → 8.5 (tag rename 2.6× faster and no longer blocks other work; Replace All leaves syntax alone; typing with the panel open no longer re-runs the search);
- Kanban 8 → 8.5 (a deleted card comes back from wherever the user undoes).

## Phase 6: lifecycle lows and hygiene (A26-17 … A26-21, A26-24, FC-08, FC-09, FC-10)

### 6.1 Lifecycle lows

- **A26-17:** register a new board's path before `board:create`, or treat a very young or empty board's parse failure as transient.
- **A26-18:** a scoped Resume of a tag-rename undo replays only the planned attachments, tiles and chips (store them in the sentinel).
- **A26-19:** `writeScheduler.flushAll` keeps captured-but-unfired entries visible to `flush(key)` and `hasWork`.
- **A26-20:** a focused editor counts as "may lose work" only when it has unserialised keystrokes; a plain input only when its value changed.
- **A26-21:** config `resume` calls `rescheduleConfigWrite()`.

### 6.2 Editor cosmetics (A26-24)

Fix where cheap, otherwise list in KL #17:
- the empty paragraph between adjacent lists;
- a `0.` list start;
- `<br data-filo-soft-break>` after Enter;
- `\` line ends on plain paste (also fix KL #41);
- nested block reloads.

### 6.3 Gates (FC-08)

- `no-global-index-version` also matches `allMetadata(`, and scans markup and `stores/`.
- `component-timer-cleanup` matches any component-scope `setTimeout` / `setInterval` assignment.
- `enter-keeps-the-key` accepts either quote style.
- `toast-plain-language` follows a message variable to its string, or bans variables.
- Prove each one bites (plant, fail, revert).

### 6.4 Docs (FC-09)

- **KNOWN_LIMITATIONS:**
  - #13 (`yes` / `no` read as strings; **DECISION D9:** accept `yes` / `no` / `on` / `off` for `completed`, *default: yes, read-only; write stays `true` / `false`*);
  - #6 (rewrite without narration);
  - #17 (whatever Phase 3 leaves);
  - #32 (after 2.3);
  - #41;
  - #46.
- **CLAUDE.md:**
  - the MiniSearch line;
  - real IPC channel examples;
  - the link-preview fetch under "No network calls";
  - add `LazyTextTileBody.svelte`, `staticPreview.ts`, `editorMountQueue.ts`, `keyedReactivity.svelte.ts` and `progressiveCount.svelte.ts` to the tree.

### 6.5 Dead code (FC-10)

- Remove:
  - `VaultIndex.query()` and its MiniSearch index, and `filesByTag`;
  - `boardStore.clearCache` / `updateCacheEntry`;
  - the store-level `toggleWaypointLock`;
  - the **`dialog:confirm`** channel (handler, schema, contract, union entry);
  - the two unused CSS rules.
- Mark test-only exports `@internal`, or move them into test helpers.

### Phase 6 outcome (2026-09-30)

**Status:** done. Verified on Windows:
- `npm run ci:verify` green: 784 test files, 7,392 tests passed (5 skipped), 89/89 gates;
- the E2E suite on the built app: 23 passed, 3 skipped (the scale budgets), `quitMinimized` included. Phase 6 changes the write scheduler's `flushAll` (the quit drain runs it) and the shutdown report, so it was run.

**What changed**

- **6.1 Lifecycle lows**
  - **A26-17: a board created during a sidebar refresh is no longer marked "not loaded".** `persistNewBoard` registers the planned path before `board:create` (`beginBoardCreate` in `stores/unloadedBoards.ts`, released when the create settles). The tree scan skips a path being created without marking it scanned, `adoptBoardAtRuntime` answers `'already'` for it (also when the create began during its read), and a successful create clears any mark a load of another spelling left (`catchUpLoadedBoard`).
  - **A26-18: Resume of a crashed tag-rename Undo renames back only what that Undo recorded.** The Undo's sweep writes its attachments, board-only tiles, filter chips and colour into the sentinel (`undoOfRename`, validated on read; a malformed one makes the sentinel unreadable, as the other fields do). Resume goes through `resumeTagSweep` (`stores/tagUndo.svelte.ts`), which replays such a sweep as that Undo (`undoRename(…, retrying)`), and converges every other sweep forward as before.
  - **A26-19: `flush(key)` and `hasWork` see a write a full save has captured but not yet sent.** `flushAll` registers each captured entry as parked until it fires (removed just before `fireWrite`, which registers its in-flight entry synchronously, so the write is never in no structure). `cancel(key)` now reaches such an entry too: a board deleted while a Ctrl+S or the quit drain is saving other boards no longer has its captured write fire into a missing file.
  - **A26-20: a caret resting in a note no longer holds a Windows shutdown back.** `mayLoseWorkNow` counts a focused field only when its text changed since it took focus (recorded on `focusin`); a note editor counts only through its unserialised keystrokes, which `nothingUnsaved` already reports. An `input` listener re-checks on the next task, so typing is reported at once rather than on the 1 s poll.
  - **A26-21: Keep local on a held settings file writes it even when a corrupt file failed in the same save.** The config drift target's `resume` schedules the bundle again from the latest settings, then re-fires a retained write if there is one.
- **6.2 Editor cosmetics (A26-24)**
  - **A `0.` list saves as `0.`** (`serializeOrderedList` took `start || 1`). The property test's generator now includes lists starting at 0 (closing Phase 2 deviation 5).
  - **Enter beside a soft break splits the paragraph there** (`SoftBreakEnter`, high priority in `softBreak.ts`): it removes the break and hands the key on, so a list item's Enter (a new item) or the paragraph split runs on the text without it. No `<br data-filo-soft-break>` in the file, no empty first line.
  - **Pasted plain text saves bare newlines.** The paste parser uses `breaks: false`, so a single newline is a soft break, as when the same text is opened from a file; Ctrl+Shift+V's literal paste uses soft breaks too. KL #41 updated.
  - **Adjacent lists and nested blocks were already fixed** by Phase 2's list writers (`listMarkers.ts`): `* a / * b` then `- c` and a nested item holding a rule, code block or quote both reopen editable and stable. Pinned as named round-trip cases. What is left of the nested case is spelling: the nested list is written loose, the list around it stays tight (a row in KL #17's table).
- **6.3 Gates (FC-08)**, each proven by planting a violation in a temporary component and store (all four failed), then removing it:
  - `no-global-index-version` also matches `allMetadata(`, scans component markup as well as script, and scans `stores/`. Its seven existing one-off reads (a rename, the recovery prompt, the tag sweep, open housekeeping, a trash move, the search runner's untracked read) carry the marker;
  - `component-timer-cleanup` also catches an untyped component-scope variable assigned `setTimeout` / `setInterval` anywhere in the component;
  - `enter-keeps-the-key` accepts either quote style;
  - `toast-plain-language` follows a message passed by name (the whole argument, or a `text:` / `body:` / `title:` / `message:` option) to what it is set to in the same file.
- **6.4 Docs (FC-09)**
  - KNOWN_LIMITATIONS: #13 rewritten for D9; #6 rewritten without narration (and without the stale "no component-mount harness" reason); #41 for the soft-break paste; #17 (the nested-list row, `0.`, the two edits that no longer leave markup); #32 names `softBreak.ts`; #4's shutdown paragraph for A26-20.
  - CLAUDE.md: the search row (MiniSearch only in the Template Browser), real IPC channel examples, the Link tile's preview fetch under "No network calls", the five files in the tree, `softBreak.ts` / `pastePlainText.ts` lines, and the `components` gate row.
- **6.5 Dead code (FC-10):** removed `VaultIndex.query()` with its MiniSearch index and `filesByTag`, `boardStore.clearCache` / `updateCacheEntry`, the store-level `toggleWaypointLock`, the `dialog:confirm` channel (handler, schema, contract, union entry) and the two CSS rules. The ten test-only exports are marked `@internal test-only`. `minisearch` stays a dependency (the Template Browser uses it).
- **Tests added or changed:**
  - unit `boardDiscovery.test.ts` (a tree refresh inside `board:create` loads nothing and marks nothing);
  - unit `tagRewriteSentinel.test.ts` (the Undo's scope round-trips) and `tagUndo.test.ts` (Resume renames back only the recorded attachment);
  - unit `writeScheduler.test.ts` (`flush('b')` waits while `flushAll` is still sending `a`; a key cancelled while held isn't written);
  - unit `unsavedStateReport.test.ts` (new: a focused editor with nothing unsaved, typed keystrokes, an input only once changed);
  - unit `configExternalChanges.test.ts` (Keep local with a corrupt `workspace.json` in the same save);
  - component `softBreakEnter.test.ts` (new), unit `pastePlainText.test.ts`, `markdownBodyRoundTrip.test.ts` (`0.`, adjacent lists, the nested rule), `frontmatterReaders.test.ts` (new, D9), `vaultIndex.test.ts` (the removed methods' cases now read `allTags` / `get`);
  - E2E `quitMinimized.e2e.ts` paces its typing and waits to see it land (the Phase 4 flake).
- **Proof on the old code** (each fix reverted alone, its tests kept): create race 1 fail, scheduler 2, shutdown report 2, config resume 1, editor 5 (Enter 2, paste 2, `0.` 1). The A26-18 test calls a function the old code doesn't have; the old Resume path (`renameTagEverywhere`) renames every attachment by construction.
- **Property sweep:** 4 seeds × 600 documents with the widened generator, clean.

**Deviations from the plan**

1. **A26-17: the create is guarded, and the scan never marks it.** The plan offered either option; the planned path is registered before `board:create`, and a load of a path being created answers `'already'` instead of failing. No "young file" heuristic.
2. **A26-18: Resume replays the Undo itself** rather than a scoped note sweep plus a separate replay: `resumeTagSweep` rebuilds the Undo's snapshot from the sentinel and runs `undoRename`, so the order (notes first, then attachments, tiles, chips, registry) is the Undo's own. It lives in `tagUndo.svelte.ts`: `vault.svelte.ts` is over the size cap and may only shrink (it did, by four lines).
3. **A26-19 goes one step further:** a captured entry is cancellable, not only visible, since it now sits in the parked set that `cancel(key)` already walks. The fix took `writeScheduler.ts` past the 1,000-line gate, so the parked set moved to its own module (`lib/boards/writeSchedulerParked.ts`: `ParkedWrites`, `newParkedEntry`); the scheduler is now 947 lines, down from 972.
4. **6.2: two of the five cosmetics needed no change** (adjacent lists, nested blocks), fixed earlier by Phase 2; they are pinned as tests and the residual spelling is listed.
5. **D9 took its default and one more word:** a quoted `"true"` reads as done too (the case KL #13 was written for). `yes` / `on` / `"true"`, any case, read as done; the write stays a boolean.
6. **Two small items beyond the plan's list:** the vault index's retry maps are keyed by `VaultPath` (FC-10's "minor key inconsistency"), and the `quitMinimized` E2E flake from Phase 4 is paced.
7. **Docs pulled forward in earlier phases:** KL #32 (Phase 2), KL #46 (Phase 4) and most of #17 (Phases 2 and 3) were already current; this phase only added to #17 and #32.

**Not done (for the owner or later)**

- **The search query parser trims the needle** (Phase 5's finding): ` - ` still finds every `-`. It is a query-syntax decision (quoting? a literal mode?), so it is left for the owner.
- **About 0.4 MB of heap kept per reload into the same editor** (Phase 2's finding, unit environment only) was not investigated.

**Scores after Phase 6:**
- Renames, moves, trash and their undo 8.5 → 9 (a new board is never falsely "not loaded"; a crashed tag-rename Undo resumes as that Undo);
- Open / close / quit / recovery 8.5 → 9 (a board deleted during a save keeps its last edit in the trash copy; a routine shutdown no longer shows "preventing shutdown"; Keep local always writes);
- Editor: notes open editable stays 8.5 (`0.` lists now open editable; the rest was cosmetic);
- Accessibility and keyboard stays 7 (Phase 4's score). The 7.5 target isn't claimed: the Light theme's tertiary text (KL #47) and the Board Browser's nested buttons (KL #46) are still open.
- **Overall 9.**

## Phase 7: verification and archive

1. Run the checks:
   - `npm run ci:verify` on Windows;
   - `npm run build && FILO_E2E_SCALE=1 npm run test:e2e`;
   - the 5,000-note pass (`sim.pass.ts`, extended in Phase 1.8), all green;
   - the corpus check (3.6).
2. Update the report's scorecard with the scores achieved.
3. Move both documents to `docs/archive/`.
4. Commit and push (after the owner's go-ahead).

## Decisions

| # | Question | Default |
|---|---|---|
| D1 | Quit shows "Finishing an undo…" when it waits on the history chain > 2 s | Yes |
| D2 | Align / Indent inside list items | Disabled there |
| D3 | How lossiness is decided | Compare markdown-it HTML; cosmetic rules as a fast path |
| D4 | Blank line after the frontmatter on a body edit | Keep it |
| D5 | Shortcuts while a dialog is open | One global check |
| D6 | Right-click on a mounted card's text | Filo's card menu (taken: on text not being edited, Kanban cards and Mind Map tiles; the text being typed in keeps spell-check) |
| D7 | Replace All matches inside Markdown syntax | Left alone, counted in the confirm |
| D8 | Sidebar delete undo | Always a toast with Undo, plus the active board's stack |
| D9 | `completed: yes` | Read as done; still write `true` |

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
| D6 | Right-click on a mounted card's text | Filo's card menu |
| D7 | Replace All matches inside Markdown syntax | Left alone, counted in the confirm |
| D8 | Sidebar delete undo | Always a toast with Undo, plus the active board's stack |
| D9 | `completed: yes` | Read as done; still write `true` |

# Audit-27: implementation plan

Source: [AUDIT27_REVIEW_2026-10-01.md](AUDIT27_REVIEW_2026-10-01.md), the 2026-10-01 review of `abf5212`.

How it was reviewed:
- one orchestrating session and one finder agent;
- one refuter, who confirmed all ten bugs, most of them with a throwaway test.

The owner's context sets the order:
- Windows 11, one machine, Syncthing;
- all four board types;
- 500–5,000 notes;
- in daily use from now on.

No path loses note text, so the plan's order is:
1. board saves (the one bug that can lose a change without a word);
2. Find and Replace;
3. titles that aren't saved;
4. the small bugs and quick wins;
5. board-format migrations, before any future format change needs them;
6. verification.

Phase 0 comes first because it is tiny and gives Phase 1 room in a file at 947 lines.

The Markdown editor work (#32) is a separate, later track (B), with its own branch and go / no-go points.

## How to read the scores

Every score is out of 10:
- **Impact** (bugs): how much the bug can hurt you in daily use.
  - 0/10 = harmless;
  - 5/10 = a real annoyance, or a small change lost now and then;
  - 10/10 = loses or corrupts notes.
- **Useful** (improvements): what you'd gain.
  - 0/10 = nothing;
  - 5/10 = a clear improvement you'd notice every week or so;
  - 10/10 = essential.
- **Hard**: how much work it is.
  - 0/10 = minutes;
  - 5/10 = a few days, several files, new tests;
  - 10/10 = weeks, rewriting a major part of Filo.

## Overview

| Phase | What | Items | Impact / Useful | Hard |
|---|---|---|---|---|
| 0 | The line-limit gate counts code lines | Gate change | Useful 6/10 | 1/10 |
| 1 | Board saves never go back a step | F-01, F-02, N-2 check | Impact 7/10 | 4/10 |
| 2 | Find and Replace | U-01, U-04 | Impact 5/10 each | 2/10 each |
| 3 | Titles are saved when you click away | N-1, F-03 | Impact 4/10 and 3/10 | 3/10 |
| 4 | Small bugs and quick wins | U-02, U-03, F-04, F-05, #28, #47, #36, #34 | Impact 0–2/10; Useful 1–5/10 | 1–2/10 each |
| 5 | Board-format migrations | #29 | Useful 8/10 | 4/10 |
| 6 | Verification and archive | — | — | 2/10 |
| B1 (later) | Write notes without `tiptap-markdown` | #32 Step 1 (also helps #17) | Useful 6/10 | 6/10 |
| B2 (later) | A source-preserving editor: a spike and a go / no-go | #32 Step 2 | Useful 9/10 (the full change) | 9/10 full; 5/10 for the spike |

## Conventions

- **Paths and lines.** Paths are relative to the repo root. Line numbers are from `abf5212` and will drift.
- **Decisions.** Choices not yet confirmed are marked **DECISION** with a default; the table at the end collects them.
- **Each phase:**
  - leaves a working app;
  - passes `npm run ci:verify` on Windows;
  - runs the E2E suite (`npm run build && npm run test:e2e`, with `FILO_E2E_SCALE=1` for Phases 1 and 6) when it touches saving at quit, shutdown, startup or watching;
  - is committed on its own;
  - gets an "outcome" section here (what changed, deviations, new findings).
- **Repro tests.** Each fix turns its audit repro into a permanent test that **fails on `abf5212` and passes after the fix**. To prove a test bites, revert the fix in the main checkout, run the test, then restore. Repros are in session `93923062`'s scratchpad (`…/93923062-ddd8-4861-aee3-39a29bce7042/scratchpad/`):
  - `finder/`: `zzA27_flushAllReorder`, `zzA27_boardFlushAllReorder`, `zzA27_labelEditorShutdown`;
  - `refuter/`: `zzA27R_deleteAfterTimer`, `zzA27R_titleBlur`, `zzA27R_queryQuote`;
  - `mine/`: `zzA27_replaceNext` (component), `zzA27_queryTrim`, `zzA27_pasteTrailing` (unit), `zzA27_subtaskOrder` (characterisation).
- **No finding IDs in code.** No `F-01` or `U-04` in code, comments or test names (CLAUDE.md, gate `no-audit-narration`): tests are named after the behaviour; IDs go in commit messages.

---

## Phase 0: the line-limit gate counts code lines (Useful 6/10, Hard 1/10)

Why first:
- Phase 1 changes `writeScheduler.ts`, which is at 947 lines, a third of them comments.
- Under today's count the fix would force a hurried split of that file in the middle of a data-safety fix.

### 0.1 Count code lines

- In `scripts/gates/codebase.mjs`, `countLines` (`:127`) counts every line.
- Make the `file-sizes` check (`:137`) count only lines that are neither blank nor comment-only:
  - `//` lines;
  - lines inside `/* … */` and `<!-- … -->`;
  - JSDoc ` * ` lines.
- Keep `LOC_LIMIT = 1000`.
- Re-measure the six allowlisted files and **lower** each ceiling to its new count. Remove any file that drops below 1,000 from the allowlist, since the limit then covers it like any other file.
  - By a rough count, `vault.svelte.ts` goes to about 880 lines of code and leaves the allowlist.
  - `TaskListBoard.svelte` stays over, at about 1,420.
- Unit-test the counter in `src/tests/unit/`:
  - a file of only comments counts 0;
  - a mixed file counts only its code lines;
  - a `/* */` block spanning lines and a Svelte `<!-- -->` block are skipped.

### 0.2 Docs

- CLAUDE.md, "Structure Rules" item 1 and the `codebase` gate row: "1000 lines of code (blank and comment-only lines don't count)".
- Note in the outcome which of the ten 900+ files are now well under the limit.

**Not in this plan:**
- planned splits of the ten 900+ files (Useful 5/10, Hard 5/10);
- a refactor pass on the allowlisted files (Useful 4/10, Hard 6/10).

Revisit both once 0.1 shows the new counts.

### Phase 0 outcome (done 2026-10-01)

**What changed**
- New `scripts/gates/codeLines.mjs`: `countCodeLines(text, { svelte })`.
  - A line counts when it holds code. These don't count:
    - blank lines;
    - `//` lines;
    - lines inside `/* … */`, JSDoc included;
    - lines inside `<!-- … -->` in Svelte markup;
    - lines inside `/* … */` in a Svelte `<style>`. `//` there is not a CSS comment, so it counts.
  - The scanner knows strings, template literals (with `${ … }` nesting) and regex literals. So a `//` or `/*` inside one of them is code. A misread regex stops at the end of its line, so it can't swallow the lines after it.
- The `file-sizes` check (`scripts/gates/codebase.mjs`) counts with it. `LOC_LIMIT` stays at 1000, and the old `countLines` is gone.
- The allowlist is lowered to the new counts. `vault.svelte.ts` and `KanbanColumn.svelte` have left it.
- New test `src/tests/unit/fileSizeCodeLines.test.ts`, 9 cases:
  - comments only counts 0;
  - a mixed file;
  - a block comment over several lines, with code on its closing line;
  - comment markers inside strings, templates and a regex;
  - a comment inside a template expression;
  - a division not read as a regex;
  - CRLF, a BOM and an empty file;
  - a Svelte file with comments in markup, script and style;
  - markup with code beside a comment.
- CLAUDE.md updated:
  - the `codebase` gate row;
  - Structure Rules item 1 (the allowlist is now four files);
  - the gates intro, which named a single helper module.

**New counts** (lines of code; raw lines in brackets)

| File | Before | Now | Status |
|---|---|---|---|
| TaskListBoard.svelte | ceiling 1,940 (1,932) | 1,371 | stays on the allowlist |
| KanbanSideToolbar.svelte | 1,439 | 1,248 | stays |
| TaskItem.svelte | ceiling 1,481 (1,479) | 1,225 | stays |
| KanbanBoard.svelte | 1,416 | 1,027 | stays, 27 over |
| KanbanColumn.svelte | 1,170 | 902 | **leaves the allowlist** |
| vault.svelte.ts | ceiling 1,467 (1,460) | 879 | **leaves the allowlist** |

All ten 900+ files are now under the limit:

| File | Raw lines | Lines of code | Room left |
|---|---|---|---|
| TaskListSideToolbar.svelte | 979 | 864 | 136: the closest; it is mostly markup and CSS (88% code) |
| MindMapBoard.svelte | 949 | 736 | 264 |
| VaultFileItem.svelte | 919 | 699 | 301 |
| noteWriter.ts | 963 | 679 | 321 |
| Frame.svelte | 935 | 678 | 322 |
| notes.svelte.ts | 929 | 664 | 336 |
| writeScheduler.ts | 947 | 579 | 421: room for Phase 1 |
| boardLoader.ts | 919 | 554 | 446 |
| fileWatcher.ts | 963 | 553 | 447 |
| history.svelte.ts | 939 | 492 | 508 |

The whole of `src/main` + `src/renderer` is 133,937 raw lines and 91,229 lines of code (68%). Four files are still over 1,000.

**Verification**
- **Against TypeScript's own parser.** Every `.ts` file in `src/main`, `src/renderer` and `src/shared`, and every Svelte `<script>` block, was checked line by line: does the line hold a token? There were 0 disagreements with the counter.
- **Markup and `<style>`.** No line that starts like a comment is counted. Every line skipped there is inside a comment.
- **Mutations.** Each of these breaks at least one test:
  - no regex detection;
  - every `/` read as a regex;
  - no template literals;
  - no `${ }`;
  - no strings;
  - Svelte files scanned as plain script;
  - counting every line (all 9 tests fail).
- **The gate bites in real source** (each file restored byte-for-byte afterwards):

  | Change | Result |
  |---|---|
  | `KanbanBoard.svelte` gets one more code line | fails: 1,028 is over its ceiling of 1,027 |
  | `KanbanBoard.svelte` gets 400 more comment lines | passes |
  | `KanbanColumn.svelte` gets 120 more code lines | fails: 1,022 is over the limit |
  | `writeScheduler.ts` gets 600 more comment lines | passes |
  | `vault.svelte.ts` goes back on the allowlist | fails: "within the limit — remove its allowlist entry" |
- `npm run ci:verify` on Windows: green.
  - lint, svelte-check and `typecheck:main` clean;
  - `test:unit:strict`: 785 files, 7,403 tests passed, 5 skipped;
  - build;
  - 89/89 gates, including `file-sizes`, `test-typecheck` (the new test and `codeLines.d.mts` type-check clean) and `no-audit-narration`.
- **E2E not run.** Phase 0 changes no app code: only a gate, a test and two comments.

**Deviations from the plan**
1. **Where the counter lives.** It is in its own module, `scripts/gates/codeLines.mjs` with types in `codeLines.d.mts`, not inside `codebase.mjs` or `lib.mjs`.
   - The unit test has to import it type-checked: a new test file must type-check clean under the `test-typecheck` ratchet.
   - A `.d.mts` for all of `lib.mjs` would be a second copy of its whole API that could drift.
   - It is a helper, not a check, so CLAUDE.md's "don't add a standalone `scripts/check-*.mjs`" still holds.
2. **One new rule in the gate.** An allowlisted file at or under 1,000 lines of code now fails with "remove its allowlist entry". The plan only asked for the entries to be removed once. The rule keeps that true later as well.
3. **The rough estimates were off:**
   - `TaskListBoard.svelte` is 1,371, not about 1,420.
   - `KanbanColumn.svelte` also leaves the allowlist (902). The plan expected only `vault.svelte.ts` (879, as estimated).
   - `KanbanBoard.svelte` stays, at 1,027.
4. **Two comments fixed, not in the plan.** `writeSchedulerFailures.ts` and `writeSchedulerTypes.ts` said `writeScheduler.ts` "sits at the 1000-LOC limit" and named the gate as the reason they exist. That is no longer true (579), and it was history. Both now just say what the module holds.
5. **More tests than asked for.** The plan listed three cases. The test also covers strings, templates, regex, division, CRLF and BOM, since those are where a comment scanner goes wrong.

**New findings:** none in app code. The planned splits and the refactor pass ("Not in this plan" above) look less pressing now:
- only four files are over the limit;
- `KanbanBoard.svelte` is 27 lines from leaving the allowlist;
- the closest file under the limit is `TaskListSideToolbar.svelte`, with 136 lines of room.

---

## Phase 1: board saves never go back a step (F-01, F-02; Impact 7/10, Hard 4/10)

### 1.1 A captured write never lands after a newer one (F-01)

`createScheduler.flushAll` (`src/renderer/lib/boards/writeScheduler.ts:663-684`) snapshots every pending key up front, then fires them one by one (`:745-755`). Meanwhile a fresh `schedule()` of the same key arms its own timer, and `onDue` (`:444-454`, `:114`) sees nothing in flight. The newer write lands, then the captured older one lands on top.

Fix in the shared scheduler, so every user of `createScheduler` gets it:
- Keep a **per-key schedule sequence**: bumped on every `schedule(key, …)`, recorded on each pending entry and on each flushAll capture.
- When flushAll comes to fire a captured entry, skip it if the key's sequence has moved past the captured one. A newer entry was scheduled after the capture: it is pending, in flight or already written.
  - Its parked promise then resolves when that newer write settles, so `flush(key)` and `hasWork(key)` still tell the truth.
  - Its write-state accounting (`endWrite`) stays balanced, so nothing is left counted as in flight.
- Keep the up-front capture itself: it is what freezes a board's path and payload against a rename landing mid-loop (the comment at `:657-663`).
- **DECISION D1:** skip a superseded capture, rather than making `onDue` wait for parked captures.

  *Default: skip. Waiting would delay the user's newest write behind an older, slower one; skipping is also what a single-key flush already does.*

### 1.2 Board delete trashes the latest version (F-02)

- With 1.1, `flush(key)` (`:572-634`) no longer waits for a superseded parked entry and returns once the newest write has landed.
- So `saveBeforeDelete` (`src/renderer/stores/boardCacheDelete.ts:76`) moves the latest bytes to Filo's trash.
- No separate change expected. Confirm with the test.

### 1.3 The config and misc schedulers (N-2, unverified)

- `configWriteScheduler.ts:483` has one key (`CONFIG_KEY`).
- `miscWriteScheduler.ts:53` has several: viewports, sidebar order, hotkeys. Its `getArgs` closures capture the values at flushAll time.
- Write the same reorder test against each. 1.1 fixes them too if they're affected; record the result in the outcome.

### Tests

| Kind | Test |
|---|---|
| Unit, generic scheduler (from `zzA27_flushAllReorder`) | Two keys, the first write slow. Re-schedule the second key during it; its timer fires. After flushAll the disk holds the second key's **newer** value. `hasWork` is false and no failure is reported. A second case: the key already in flight when flushAll reaches it. |
| Unit, boards (from `zzA27_boardFlushAllReorder`) | The real `scheduleBoardWrite` / `flushAllScheduledBoards` / `writeBoardFile` with drift baselines. B on disk is edit 2. |
| Unit (from `zzA27R_deleteAfterTimer`) | Delete during the slow flush: the trashed `.board.json` is the newest version. |
| Unit | The parked set and write-state counters are empty after each case (no stray in-flight count, no stuck sentinel). |
| Characterisation | `harness/slowDisk.ts` `holdNextMainCall('board:save', …)` holds board A's save. Press Ctrl+S, drag a tile on board B, release A, quit and reopen. B shows the drag. |
| E2E | Full suite with `FILO_E2E_SCALE=1`: flushAll runs at every quit. |

### Phase 1 outcome (done 2026-10-01)

**What changed** (all in the shared `createScheduler`, so the board, settings, misc and note writers all get it)
- `writeScheduler.ts`:
  - `flushAll` records each entry it captures in a new per-key `captures` map, beside the parked set it already used.
  - `schedule(key)` takes the key's capture out (`takeCapture`) when it finds one:
    - the capture is marked `superseded`, leaves the parked set, and its promise resolves;
    - the new pending entry replaces it as a reschedule replaces a pending entry. Its write-state count carries over, so there is no extra `endWrite` or `beginWrite`. The path bookkeeping (`onReschedule`, pending-path retarget) is the same as for a reschedule.
  - The `flushAll` loop skips a superseded capture, both before and after it waits for an earlier write of the key.
  - `flush(key)`: the pending-entry send is now a local `sendPending`. If an entry it waited for turns out to be superseded, it sends the key's newer pending write too, and returns only once that has landed.
  - `cancel(key)` removes the key's capture (it settles it as a parked fire, so no later schedule may take it over), and `reset()` clears the map.
  - The file is now 601 lines of code (998 raw), up from 579 (947). Under the old raw count it would have been 2 lines from the limit.
- `writeSchedulerTypes.ts`: `ParkedEntry.superseded`; the `schedule` doc now says a full save's copy of the key is dropped.
- `writeSchedulerParked.ts`: header comment; `newParkedEntry` sets `superseded: false`.
- CLAUDE.md: the `writeSchedulerParked.ts` line in the project tree.
- No change to `boardCacheDelete.ts` (1.2): with 1.1, the delete's save-first flush returns once the newest version has landed, as expected.

**Tests**

| File | Cases | On `de8562b` (same scheduler as `abf5212`) |
|---|---|---|
| `src/tests/unit/fullSaveKeepsNewerWrite.test.ts` (generic scheduler) | 11 | 7 fail; the 4 accounting guards pass |
| `src/tests/unit/fullSaveKeepsNewerWriteSchedulers.test.ts` (real writers) | 5 | all 5 fail |
| `src/tests/characterisation/slowRenames.test.ts`, new case | 1 | fails |

- **Generic scheduler** (`fullSaveKeepsNewerWrite.test.ts`):
  - a key edited again while an earlier key is slow ends on its newer version, for both `full` and `pending-path` tracking. The older copy is never sent, and `hasWork` is false as soon as the newer write has landed.
  - the key's newer write is still being written when the full save reaches it;
  - a key's `flush` during the full save (a board delete) returns without waiting for the slow key, with the newer version on disk:
    - when the newer write is still waiting;
    - when it has already landed;
    - when the flush was already waiting for the old copy before the key was edited again.
  - a newer write that fails stays failed (the old copy no longer papers over it), and Retry writes the newer version;
  - accounting guards: cancelled after its newer schedule; cancelled, then edited again; edited again after the full save sent it; after a vault swap (`reset`). Each one checks `unsavedWork()`, `hasWork` and `hasParked` end empty, or count the new write while it is out.
- **Real writers** (`fullSaveKeepsNewerWriteSchedulers.test.ts`):
  - boards: `scheduleBoardWrite` / `flushAllScheduledBoards` / `writeBoardFile` with drift baselines stamped. Board B on disk is edit 2, nothing failed, nothing unsaved.
  - board delete through the real `boardCacheStore.deleteBoard`. The file moved to the trash is the newest version, whether the newer edit had already been saved or was still waiting.
  - the settings bundle (N-2): see below.
  - `.filo/tags.json` on the misc writer, using the real `fileTagsStore` (N-2): see below.
- **Characterisation** (`slowRenames.test.ts`, "a rename whose board saves are slow"):
  1. A note is on two Kanban boards.
  2. A sidebar rename's save writes both boards. The first board's `board:save` is held with `holdNextMainCall`.
  3. A column is added to the second board meanwhile.
  4. The held save is released, and the vault reopened.
  5. The second board still has both columns, on disk and on screen.
  - The gate's minimum for the spec goes from 5 to 6.
- **Each part of the fix is pinned.** Each mutation below was applied in turn, the two unit files run, and the source restored byte-for-byte:

  | Mutation | Tests that fail |
  |---|---|
  | `schedule` doesn't take the capture over | 12 |
  | the `flushAll` loop sends a superseded capture | 11 |
  | `flush(key)` doesn't send the newer write | 1 |
  | `cancel` keeps the capture | 1 |
  | `unpark` keeps a sent capture | 1 |
  | `reset` keeps captures | 1 |

**N-2: the settings and misc writers were affected too**
- **Misc writer:** `.filo/tags.json` takes its snapshot when its args are read, which for a full save is when the save starts.
  - Behind a slow write of another `.filo/` file, a tag change made meanwhile was saved by its own timer.
  - The save's older copy then landed on top: the test's disk held `one` instead of `two`, with nothing left unsaved.
  - The 3-way merge didn't catch it, because the merge base had moved to the newer save.
  - Viewports, sidebar order and hotkeys serialise inside their write, so their old copies wrote current data. Those three were not affected in content.
- **Settings bundle:** it has one key, so the race needs an earlier bundle write still out when the full save starts.
  - The save's copy (bundle 2) and the newer bundle 3, which was parked behind bundle 1, were both sent when bundle 1 landed. They raced each other.
  - When bundle 2 landed last, `app.json` held the older settings and nothing was pending: the test read `Two` instead of `Three`.
  - Now bundle 2 is dropped.
- **Note writer (not asked):** not affected. Its captures hold only the note's path, and the write reads the queued change when it runs.
  - With the fix, a superseded note capture is skipped.
  - The note writer's own `flushAll` already drains again while any timer is armed, so the change is still written inside that `flushAll`.

**Verification**
- **Repro tests bite.** The three scheduler files were put back to `de8562b` and the new tests run, then the files restored byte-for-byte:
  - unit: 12 of 16 fail (the 4 accounting guards pass, as they should);
  - characterisation: the new case fails, with the second board on 1 column instead of 2.
- **The scheduler's existing tests.** Every unit file that touches a scheduler or a full save (125 files, 734 tests) passed before the full run.
- `npm run ci:verify` on Windows: green.
  - lint, svelte-check and `typecheck:main` clean;
  - `test:unit:strict`: 787 files, 7,420 tests passed, 5 skipped;
  - build;
  - 89/89 gates, including `file-sizes`, `test-typecheck` (both new test files type-check clean) and `characterisation-suite`.
- E2E on the built app, `FILO_E2E_SCALE=1`: 26 passed, none skipped (2.6 min). That includes the quit, crash-recovery and sync-delivery specs (a full save runs at every quit) and the three scale budgets.

**Deviations from the plan**
1. **Detected at `schedule`, not with a per-key sequence.** The plan wanted a per-key sequence, checked when `flushAll` reaches the captured entry. Instead, `schedule(key)` finds the capture and takes it out at once.
   - Checked only when the loop reaches it, the superseded entry would stay parked until then. So `flush(key)` (a board delete's save) would still wait for the slow earlier board, and `hasWork` would report a write that is never sent.
   - It is still decision D1 (skip, don't make `onDue` wait), only detected earlier.
2. **What waits on the old copy.** The plan said its parked promise "resolves when that newer write settles". Instead it resolves at once, and the one waiter that matters, a `flush(key)` already waiting for it, sends the newer write itself and returns once it has landed.
   - Same guarantee for the waiter.
   - It avoids threading a promise through every way a pending entry can end (timer, flush, a second capture, cancel, reset).
3. **Accounting by carry-over, not a separate `endWrite`.** The plan asked for `endWrite` to "stay balanced". It does, but by carrying the old copy's count over to the newer schedule, as a reschedule does.
   - A separate `endWrite(success)` would wrongly clear the failed mark of a newer write that had failed: the board, settings and misc writers clear a path's failed mark on any successful `endWrite`.
   - The test "the newer write's failure stays reported" pins this.
4. **The characterisation case uses a rename, not Ctrl+S.**
   - The race needs both boards waiting to save when the full save starts.
   - The harness can't make edits on two boards inside one 300 ms debounce reliably. A rename's save schedules both boards at once, and it is one of the full saves the review names.
   - "Quit and reopen" is `reopenVault`, the specs' usual reopen.
   - The case went into the existing `slowRenames.test.ts` (gate minimum 5 → 6) rather than a new spec.
5. **More tests than the plan listed.**
   - The delete case drives the real `boardCacheStore.deleteBoard`, in both orders, rather than only the generic scheduler.
   - Added: the failure case, the four accounting guards, the flush already waiting, and the six-mutation check.
6. **CLAUDE.md:** one line in the project tree, not in the plan.

**New findings**
- Unit tests that make their own `createScheduler` leave its armed-path check registered for the rest of the file. A scheduler left armed by one test keeps that path pending for the next.
  - The new generic test resets its schedulers after each case.
  - Other files that make ad-hoc schedulers rely on distinct paths.
  - Low value; not fixed.

---

## Phase 2: Find and Replace (U-01, U-04; Impact 5/10 each, Hard 2/10 each)

### 2.1 After Replace, the shown match is the one the next Replace changes (U-01)

`SearchPanel.svelte:159-162` (`handleReplaceCurrent`) calls `next()` against a list that refreshes only after `NOTE_REFRESH_MS` (`search.svelte.ts:26`, `:65`).

Fix:
1. Add `searchStore.refreshNow()`, which bumps `noteTick` so the list re-reads note bodies at once.
2. After a successful single Replace, call it.
3. Then:
   - if the replaced match has left the results (the usual case), keep the index: it now points at the following match. Request the jump to it.
   - if it is still there (the replacement contains the search text, e.g. `foo` → `foobar`), call `next()` as today.

`replaceCurrentMatch`'s fresh-check (`replaceAllCommand.ts`) stays as the guard.

Tests (component, from `zzA27_replaceNext`), with matches in notes A, B and C:
- Replace A: the jump goes to B; after `NOTE_REFRESH_MS` the current match is still B and the counter reads "1 / 2"; the next Replace changes B.
- Two Replace clicks 100 ms apart change A, then B, with no "Match moved" toast.
- `foo` → `foobar`: Replace moves on to the next match.

### 2.2 The search text is what you typed (U-04)

`queryParser.ts:191` trims the raw query and `:220` joins the free-text tokens with one space.

- **DECISION D2:** when the query has **no operators and isn't a `/regex/`**, the needle is the text exactly as typed, spaces included.
  - An all-space query is still empty.
  - With operators (`tag:x foo`), keep today's tokenising; a quoted phrase (`" - "`) already keeps its spaces.

  *Default: as described.* It matches how editors such as VS Code and Notepad++ treat find text.
- **Replace All's confirm names the search and the replacement**, with spaces made visible, e.g. `Replace " - " with " – " (12 matches in 4 notes)?` (`replaceAllText.ts:27-37`). An accidental trim can then be seen before confirming.

Tests:
- `parseQuery`: ` - ` stays ` - `; `a  b` stays `a  b`; `tag:x  foo` is unchanged from today.
- `runVaultSearch`: ` - ` doesn't match `well-known`, and two spaces match a double space.
- The confirm body shows the quoted search text.

### 2.3 Docs

- KNOWN_LIMITATIONS #48: its example now works as described; no change of substance.
- The Search panel's placeholder or help mentions quoting and `/regex/`. *Optional; Useful 2/10.*

### Phase 2 outcome (done 2026-10-01)

**What changed: Replace shows the match it changes next (U-01)**
- `search.svelte.ts`:
  - `refreshNow()` bumps `noteTick`, so the list reads every note's text at once.
  - `showMatchAfterReplace(replaced)` refreshes, keeps the replaced match's index (it now holds the match after it), skips any match in the same note that starts inside the replacement, wraps to the first match past the end, and requests the jump.
  - New type `ReplacedMatch`: the match, its index and the replacement.
- `replaceAllCommand.ts`: `replaceCurrentMatch` returns what it replaced (`ReplacedMatch`) instead of `true`, or `null` when it replaced nothing. Its fresh-check stays as the guard.
- `SearchPanel.svelte`:
  - after a single Replace it calls `showMatchAfterReplace`, not `next()`;
  - Replace clicks run one after another, so a second click acts on the match the first moved on to;
  - after Replace All it calls `refreshNow()`.

**What changed: the search text is what you typed (U-04)**
- `queryParser.ts`: with no operator and no `/regex/`, `freeText` is the query exactly as typed: spaces, quotes and backslashes included. With an operator, the tokenising is unchanged.
- `runSearch.ts`:
  - `runVaultSearch` no longer trims the free text before deciding there is nothing to search.
  - `buildNeedleRegex`: Whole word checks no end where the needle itself is whitespace. So ` - ` with Whole word on still finds the one in `a - b`.
- `replaceAllText.ts`: the confirm names the search and the replacement, e.g. `Replace " - " with " – " (12 matches in 4 notes)?`.
  - Every space in them is a no-break space. The dialog's `white-space: pre-line` collapses a run of ordinary spaces, so a double space would read as one.
  - Text that is only spaces adds a count: `"  " (2 spaces)`.
  - An empty replacement reads `with nothing`.
  - A `/regex/` is named as typed.
  - `searchedText(query)` builds the search's name. `replaceAllConfirmBody` now takes one object (`ReplaceAllPreview`).
- `SearchPanel.svelte`: the find box has a tooltip: text is found exactly as typed; the filters; quote text with spaces when using a filter; `/pattern/` for a regular expression.
- CLAUDE.md: the project-tree lines for `search.svelte.ts`, `queryParser.ts` and `replaceAllText.ts`.
- KNOWN_LIMITATIONS #48: no change, as planned.

**What changed: the Search panel opens above the sidebar (found during the real-app check)**
- The Search panel and the Find All popup used `z-index: var(--z-floating, 800)`, but `--z-floating` was defined nowhere. So they sat at 800, under the docked sidebar (1000) and the toolbar (1100).
- The panel opens at the top left, so with the sidebar open (the default) the sidebar's own search bar covered the find box and the drag handle. You could type, but not see what you typed.
- `style.css` now defines `--z-floating: 1300`: above the sidebar, the toolbars and the side toolbars (1200); below popups, menus and modals.
- Both components use it with no fallback, so the `css-vars` gate fails if the token goes. Proved: with the token removed the gate names both lines.

**Tests**

| File | Cases | On `5f25a70` (fix files put back) |
|---|---|---|
| `src/tests/component/searchReplaceShowsNextMatch.test.ts` (new) | 6 | 5 fail |
| `src/tests/unit/queryParser.test.ts` | 5 new, 3 rewritten | the 5 new ones fail |
| `src/tests/unit/runSearch.test.ts` | 4 new | 3 fail |
| `src/tests/unit/replaceAllText.test.ts` | 4 new, 3 updated | 3 fail on the old parser; the wording is a new API |
| `src/tests/component/searchReplaceAllConfirm.test.ts` | 1 new, 1 updated | the new one fails |

- **Replace** (`searchReplaceShowsNextMatch.test.ts`): the real panel, the real Replace command and note writer, over in-memory files, with matches in notes A, B and C.
  - Replace A: the panel jumps to B, the current match is B and the counter reads "1 / 2". After `NOTE_REFRESH_MS` it is still B and "1 / 2". The next Replace changes B and leaves C.
  - Two Replace clicks 100 ms apart change A, then B, with no warning.
  - Two clicks at once also change A, then B.
  - A second match in the same note is the one shown and changed next.
  - `frodo` → `frodo baggins` moves on to B, not to the `frodo` inside the replacement. This case passes on the old code too, as the plan expected.
  - Replacing the last match goes back to the first.
- **Search text**:
  - `parseQuery`: ` - `, `a  b` and `the end. ` stay as typed; quotes stay; a misspelled operator keeps its spaces; `C:\foo\bar` stays whole (the old parser made it `C:foobar`); `tag:x  foo   bar ` still gives `foo bar`; ` / - / ` is still a regex; a query of only spaces is searched.
  - `runVaultSearch`: ` - ` finds the spaced hyphen and not the one in `well-known`; two spaces find the double space; Whole word with ` - `; an operator query is tokenised as before.
  - `buildNeedleRegex`: Whole word with a space at one or both ends, and `-` alone still skipping the hyphen inside a word.
  - The confirm: the quoted search and replacement, the space count, `with nothing`, a regex, and in the real panel a Replace All of ` - `.

**Verification**
- **The tests bite.** The fix files were put back to `5f25a70` and the tests run, then the files restored byte-for-byte:
  - Replace (`search.svelte.ts`, `SearchPanel.svelte`, `replaceAllCommand.ts`): 5 of 6 fail. On the old code the counter reads "2 / 3" and the panel then sits on C; the 100 ms double click leaves B unchanged behind a "match moved" warning.
  - Search text (`queryParser.ts`, `runSearch.ts`): 12 fail, the 49 existing cases in those files pass.
- **The real app.** A Playwright script drove the built app over a small vault of four notes on no board (`phase2check.mjs`, this session's scratchpad). All 13 checks passed, with no renderer errors:
  - "1 / 3"; Replace changes Alpha, opens Beta and reads "1 / 2", still "1 / 2" 0.7 s later;
  - the next Replace changes Beta and leaves Gamma;
  - ` - ` finds one match;
  - the confirm reads `Replace " - " with " – " (1 match in 1 note)?`, and Replace All changes only the spaced hyphen, leaving `well-known` and the double space;
  - two spaces find one match.
  - Before the z-index fix, the element on top of the find box was the sidebar's search bar; after it, the find box itself.
- `npm run ci:verify` on Windows: green.
  - lint, svelte-check (858 files) and `typecheck:main` clean;
  - `test:unit:strict`: 788 files, 7,440 tests passed, 5 skipped;
  - build;
  - 89/89 gates, including `test-typecheck` (the new test file type-checks clean), `css-vars` and `no-audit-narration`.
- E2E not run: this phase changes no quit, shutdown, startup or watching path.

**Deviations from the plan**
1. **A query of only spaces is searched.** D2 said an all-space query stays empty. But the plan's own test ("two spaces match a double space") and the review's complaint ("removing double spaces is impossible") both need it.
   - A single space finds every space, capped at 5,000 matches like any other search, and Replace All refuses a capped list.
   - The confirm says how many spaces it will replace.
2. **With no operator, quotes are part of the text.** "Exactly as typed" includes quote characters, as in an editor's Find: `"hello world" plain` looks for the quotes too. Quotes still group words after a filter (`tag:x " - "`), which is what the plan's note about quoted phrases covers. The existing test of quote grouping now uses a filter.
3. **Whole word, not in the plan.** Without the change, ` - ` with Whole word on found nothing in `a - b`, because the letter before the space failed the word check. That combination was rare while the text was always trimmed.
4. **Matches inside the replacement are skipped, not "call `next()` if it's still there".** Every match in the same note that starts before the end of the replacement is passed over, as an editor's Replace does.
   - `foo` → `foobar` behaves as the plan describes.
   - `foo` → `xfoo` is caught too. Its inner match starts one character later, so a "still there" check by position would have missed it, and the next Replace would have made `xxfoo`.
5. **Not in the plan:**
   - Replace clicks are queued. Two clicks closer together than one write could both act on A (the second then failed with "skipped" or "match moved").
   - `refreshNow()` also runs after Replace All, so the replaced matches leave the list at once. Otherwise a single Replace within the next 0.4 s warned "match moved".
6. **`replaceCurrentMatch` returns what it replaced** instead of a boolean, so the panel knows the match, its index and the replacement text used.
7. **The confirm** also handles text that is only spaces, an empty replacement and a regex. `replaceAllConfirmBody` takes one object (6 values).
8. **2.3 help** is a tooltip on the find box rather than more placeholder text: the placeholder already fills the box.
9. **The z-index fix** (above) was not in the plan. It came from the real-app check, and it decides whether you can see the text you are searching, which is the point of U-04.

**New findings** (low, not fixed)
- With a filter in the query, the tokeniser still drops a backslash after a colon: `tag:x C:\foo` searches `C:foo`. Quoting doesn't help, since the escape is read inside quotes too. Rare.
- If a note changes between Replace's read and its write, the write is skipped with a "Replace skipped" warning, but the panel still moves on past that match. Before this phase it moved on the same way.

---

## Phase 3: titles are saved when you click away (N-1, F-03; Impact 4/10 and 3/10, Hard 3/10)

### 3.1 Clicking away commits a tile or frame title (N-1)

`TileHeader.svelte:197-209` and `Frame.svelte:263-268` commit on blur only if `tiptapToolbar.activeEditor !== titleEditor` after 200 ms. A title editor's blur never changes the active editor, and `clearActiveEditor`'s own delay is 300 ms.

- **DECISION D3:** after the 200 ms, commit unless focus is now inside the formatting toolbar or a popup it opened (link insert, colour picker), using `document.activeElement.closest(...)`.

  *Default: yes. It keeps "click Bold while editing a title" working and commits on any other move.*
- Check `ConnectionLabel.svelte` (it does call `clearActiveEditor` at `:221`) for the same pattern, and align it.

Tests (component, from `zzA27R_titleBlur`):
- type a title, blur to the canvas, wait 400 ms: the board holds the new title;
- type, click the toolbar's Bold: still editing, not committed;
- then click the canvas: committed with the bold.

### 3.2 A half-typed title holds back a Windows shutdown (F-03)

`unsavedStateReport.ts:30` treats any `.ProseMirror` as a note editor, whose keystrokes the note store reports, so title editors are never counted.

Fix:
- Give **note** editors their own attribute, e.g. `data-note-editor` set through `createTiptapEditor`'s `editorProps.attributes`.
- `isNoteEditor` checks that attribute. A title (label) editor then falls under the existing "a focused field whose text changed since it took focus" rule.

Tests:
- unit (from `zzA27_labelEditorShutdown`): a focused label editor with changed text sets the report flag;
- a note editor still doesn't (its text is reported by the note store);
- an unchanged focused title doesn't.

### 3.3 Docs

- KNOWN_LIMITATIONS #4 then holds as written. Re-read it and adjust the wording if 3.2 differs from it.

E2E: the session-end spec, if one exists, plus the full suite (this phase touches the shutdown report).

### Phase 3 outcome (done 2026-10-01)

**What changed: a title is saved when you click away (N-1)**
- New `src/renderer/lib/editor/titleEditFocus.ts`, one rule for every title and label editor:
  - `commitWhenLeft(host, commit)` ends the edit:
    - at once, on a press anywhere outside the editor;
    - 200 ms after focus moves anywhere outside it (Tab, a click on something that takes focus).
  - Neither counts when it lands in the app toolbar (`.global-toolbar`, which holds the formatting toolbar and its colour panels) or in a popup marked `data-keeps-editor-focus` (the colour picker, the link popup). So Bold, a colour or a font can still be applied mid-edit.
  - Every focus move in the document is watched, not only the editor's own blur. Focus that went into the toolbar (the font box) and from there elsewhere ends the edit too.
  - A window switch doesn't end the edit: the editor stays the focused element. F-03 below makes a shutdown in that state safe.
  - `keepsEditing`, `KEEPS_EDITING_SELECTOR` and `TITLE_FOCUS_LEAVE_MS` are exported for the tests.
- `TileHeader.svelte` (Mind Map tiles and Kanban cards) and `Frame.svelte`:
  - the TipTap `onBlur` timer, which committed only when another editor had become the toolbar's active editor, is gone, with its `blurCommitTimer` handle;
  - an `$effect` runs `commitWhenLeft` while the title editor's host is bound;
  - Enter, Escape, the save before leaving (component flush) and the unmount commit are unchanged.
- `ConnectionLabel.svelte` already committed on a press outside the label. Its own press handler is replaced by `commitWhenLeft`, so it now also commits when focus leaves by Tab.

**What changed: a half-typed title holds back a Windows shutdown (F-03)**
- `createTiptapEditor` sets `data-note-editor="true"` on every note editor (text tiles, Kanban cards, Document tabs). `createLabelEditor` (titles, labels) doesn't.
- `editableTarget.ts`: `NOTE_EDITOR_ATTRIBUTE` and `isInNoteEditor`.
- `unsavedStateReport.ts` treats only an element inside `[data-note-editor]` as a note editor. A title or label editor falls under the existing rule: a focused field whose text changed since it took focus.
- The session-end save already commits the title: its `vaultStore.save()` runs the component flushes. No change was needed there.

**Docs**
- KNOWN_LIMITATIONS #4: the list of what holds a shutdown back now names "a tile, frame or connection title being typed".
- CLAUDE.md: project-tree lines for `titleEditFocus.ts`, `unsavedStateReport.ts` and `editableTarget.ts`.

**Tests**

| File | Cases | On `c92f14e` (fix files put back) |
|---|---|---|
| `src/tests/component/titleCommitsOnClickAway.test.ts` (new) | 8 | 6 fail; the window-switch and Escape guards pass |
| `src/tests/unit/titleEditFocus.test.ts` (new) | 9 | new module: no old code to run against |
| `src/tests/unit/unsavedStateReport.test.ts` | 3 new, 2 updated | 1 fails: the title case; the two guards pass |
| `src/tests/characterisation/noteModel.test.ts`, new case | 1 | fails (times out waiting for the title) |
| `src/tests/characterisation/sessionEnd.test.ts`, new case | 1 | fails (main is never told) |
| `src/tests/unit/titleAndFrameTeardownCommits.test.ts` | 3 updated | — |

- **Component** (`titleCommitsOnClickAway.test.ts`): the real `TileHeader`, `Frame`, `ConnectionLabel` and `TextFormattingToolbar`, with a focusable canvas beside them.
  - A tile title is saved, as one undo step, when focus goes to the canvas.
  - A press on the toolbar's Bold, and focus on it, keep the title open; Bold applies; a click on the canvas then saves it, bold (`titleHtml` holds `<strong>`).
  - Focus in the font box keeps it open; focus on to the canvas saves it.
  - A press that moves no focus (the Mind Map canvas) saves it, with focus still in the font box.
  - A window switch (blur without focus moving) keeps it open, unsaved.
  - Escape still drops the typed title, and leaves no undo step.
  - A frame title is saved when focus goes to the canvas.
  - A connection label is saved when focus moves away with no press (Tab).
- **Unit** (`titleEditFocus.test.ts`): `keepsEditing` for the editor, the toolbar, a popup, elsewhere and nothing; `commitWhenLeft` for a press outside, presses inside / on the toolbar / in a popup, focus elsewhere (only after 200 ms), focus to nothing, toolbar then elsewhere, focus back within the check, a window switch, and stopping.
- **Unit** (`unsavedStateReport.test.ts`), with real editors: a title being typed holds a shutdown back; an unchanged focused title doesn't; a note editor's changed text is left to the note store. The two existing note-editor cases now carry `data-note-editor`.
- **Characterisation**:
  - `noteModel.test.ts`: a title typed and then clicked away from is saved, with no Enter; the file changes only on its `title:` line. Gate minimum 13 → 14.
  - `sessionEnd.test.ts`: a tile title being typed makes main hold a shutdown back, and the session-end save writes it. The spec joins the gate's list (minimum 4).
  - Harness: `typeTileTitle` (F2, type, no Enter; `renameTileTitle` now calls it) and `clickEmptyCanvas`.
- `titleAndFrameTeardownCommits.test.ts` pinned the old timer by source shape. Its three cases now pin "snapshot, destroy, then commit" and the shared rule; the behaviour is in the component test.

**Verification**
- **The tests bite.** The five fix files (`TileHeader.svelte`, `Frame.svelte`, `ConnectionLabel.svelte`, `createEditor.ts`, `unsavedStateReport.ts`) were put back to `c92f14e` and the new tests run, then the files restored byte-for-byte (table above). On the old code the titles stay `Old title`, `Old frame` and `Old label`, and main is told "nothing to lose" while a title is typed.
- **Each part of the new rule is pinned.** Each mutation of `titleEditFocus.ts` below was applied in turn, its unit and component tests run, and the file restored byte-for-byte:

  | Mutation | Tests that fail |
  |---|---|
  | no press listener | 2 |
  | no focus listener | 8 |
  | the toolbar doesn't keep the edit open | 5 |
  | a popup doesn't keep it open | 2 |
  | the editor itself doesn't keep it open (a window switch) | 10 |
  | focus checked at once, not after 200 ms | 1 |
  | stopping leaves the pending check armed | 1 |
- **The real app.** A Playwright script drove the built app over a vault with a Mind Map (a note's tile and a frame) and a Kanban board (`phase3check.mjs`, this session's scratchpad). All 23 checks passed, with no renderer errors:
  - main is told "nothing to lose" at rest, "could lose work" while a title is typed, and "nothing to lose" once it is saved;
  - a window switch keeps the title open and unsaved;
  - a click on the canvas saves the title (`title:` in the note) and closes the editor;
  - the toolbar's Bold keeps it open and is saved with it (`<strong>` on the board);
  - focus in the font box keeps it open; a click on the canvas then saves it;
  - Tab saves it; Escape drops it;
  - a frame title is saved on a canvas click;
  - a Kanban card's title opened with F2 stays open, and a click on the board saves it.
- `npm run ci:verify` on Windows: green.
  - lint, svelte-check (859 files) and `typecheck:main` clean;
  - `test:unit:strict`: 790 files, 7,462 tests passed, 5 skipped;
  - build;
  - 89/89 gates, including `test-typecheck` (the new test files type-check clean), `characterisation-suite` (the new minimums), `file-sizes` and `no-audit-narration`.
- E2E on the built app: 23 passed in 2.5 min, including the quit, crash-recovery, sync-delivery and Kanban click specs. The 3 skipped are the scale budgets, which run only with `FILO_E2E_SCALE=1` (the plan asks for them in Phases 1 and 6). There is no session-end E2E spec; the characterisation case above covers it.

**Deviations from the plan**
1. **A press ends the edit, as well as focus leaving.** D3 checks only where focus is 200 ms after the editor's blur. The real-app check showed that is not enough: a press on the Mind Map canvas moves no focus (its pan handler cancels the press's default; the canvas click handler blurs a focused editor, but not a focused toolbar control). With focus in the font box, a click on the canvas left the title open. ConnectionLabel already had the press rule, so all three editors now share it.
2. **Every focus move is watched, not only the editor's blur.** Focus that went into the toolbar and then elsewhere fires no second blur of the editor.
3. **Focus still on the editor keeps it open.** A window switch fires the editor's blur but leaves it focused. Committing then would close the title whenever you switch apps mid-title, which the old code didn't do either. F-03 covers a shutdown in that state.
4. **The keep-open zone is the whole app toolbar**, not only its formatting section: the selector ConnectionLabel already used. The toolbar's Undo / Redo act on the title editor too. A press on another toolbar control (the vault menu, the sidebar toggle) leaves the title open until the next press or focus move, or the save before leaving.
5. **ConnectionLabel "aligned"** means it uses the shared helper: its press rule is unchanged, and Tab away now commits.
6. **The note-editor attribute lives in `editableTarget.ts`**, not `createEditor.ts`, so the shutdown report doesn't import TipTap.
7. **More tests than the plan listed**: the helper's own unit test, the press-without-focus, font box, window switch, Escape, frame and connection label cases, and the two characterisation cases. `sessionEnd.test.ts` joins the characterisation gate's list.
8. **KNOWN_LIMITATIONS #4** held as written, but its list of what holds a shutdown back now names titles, so the promise is explicit.

**New findings** (low, not fixed)
- At a window about 1,380 px wide, the formatting toolbar overflows: its section is centred and scrolls, so its left end is clipped and the font box shows only its arrow. Phase 2's screenshot shows the same, so it predates this phase.

---

## Phase 4: small bugs and quick wins (each Hard 1–2/10)

### 4.1 New subtasks go below the earlier ones (U-02; Impact 2/10, Hard 1/10)

- `taskCreation.ts:333` inserts at `parentIdx + 1`. Insert after the parent's last descendant instead (`collectDescendantIds` in `lib/tasklist/blockMove.ts`), within the parent's section.
- Test: characterisation (from `zzA27_subtaskOrder`). "Add subtask" twice gives Subtask 1 then Subtask 2, and an undo removes the right one.

### 4.2 A pasted trailing newline leaves no `\` (U-03; Impact 2/10, Hard 1/10)

`pastePlainText.ts:76`: tiptap-markdown re-appends a trailing `\n`, and ProseMirror's parser turns it into a hard break.

- **DECISION D4:** a trailing newline in plain-text Ctrl+V becomes a **soft break**, like every other newline in the paste, so typing continues on the next line and saves as a bare newline.

  *Default: yes.* The alternative is dropping it, which would leave typing on the pasted line.
- Tests (unit, from `zzA27_pasteTrailing`):
  - `just one line\n`, then typing, saves `just one line\ntyped after`;
  - CRLF input behaves the same;
  - Ctrl+Shift+V is unchanged.
- Docs: KNOWN_LIMITATIONS #17's sentence about pasted text then holds.

### 4.3 The delete notification's Undo after a Trash restore (F-04; Impact 1/10, Hard 1/10)

- In `vaultDeleteOps.ts:91-94`, check `command.trashId === null` (already restored) first. Close the notification quietly, or say "Already restored".
- Test: unit or characterisation.
  1. With no board open, delete a note.
  2. Restore it from Settings → Trash.
  3. Click the notification's Undo.

  No "reloaded from disk" warning, and nothing changes.

### 4.4 The Trash undo registry stops growing (F-05; Impact 0/10, Hard 1/10)

- In `trash.svelte.ts:48-56`, drop an entry when its item is restored by any route, or when its step leaves the history.
- Test: unit. Restore an item and the registry no longer holds it.

### 4.5 Tag delete and rename Undo stays until dismissed (#28; Useful 5/10, Hard 2/10)

- `TAG_UNDO_TOAST_MS` (`tagUndo.svelte.ts:46`) is used at `:173`, `:291` and `:298`. Make those toasts **sticky** with a `dedupeKey`.
  - `ui.svelte.ts:162` supports this for non-promise decision toasts.
  - The Undo itself already re-checks safety (the merge refusal, edits since).
- **DECISION D5:** a newer vault-wide tag action's notification replaces the older one, whose Undo then goes.

  *Default: yes, so they can't stack. Undo is newest-first anyway.*
- Docs: KNOWN_LIMITATIONS #28 rewritten (the Undo lasts until dismissed or replaced).

### 4.6 Light theme small text at 4.5:1 (#47; Useful 4/10, Hard 1/10)

- **DECISION D6:** Light `--text-tertiary` goes from `#80868b` to `#6b7075` (≈5:1 on white). The Task List's keyboard-hint strip drops its 55% opacity.

  *Default: yes. It is the owner's palette call, so confirm before Phase 4.* **Confirmed by the owner, 2026-10-01.**
- `themeContrast.test.ts`: raise the Light theme's tertiary bar to 4.5:1. Leave the other built-in themes at their current bar unless the owner wants them raised too.
- Docs: KNOWN_LIMITATIONS #47 removed or rewritten.

### 4.7 Optional, from the report's "what I'd do first" list

| Item | What | Useful | Hard |
|---|---|---|---|
| #36 | Raise `STALE_HASH_MAX_BYTES` (`src/main/vault/filenameUtils.ts:412`) from 2 MB to 16 MB. Update KNOWN_LIMITATIONS #36 and its test. | 1/10 | 1/10 |
| #34 | Hard-linked notes open read-only: `vault:read-file-text` reports `nlink > 1` alongside `link`, with a banner "This note has another name (a hard link); edit it through one name only". The note writer refuses it as it refuses symlinks. | 1/10 | 2/10 |

- **DECISION D7:** include 4.7.

  *Default: include #36, skip #34 unless the owner uses hard links.*

E2E: not needed unless 4.7 #34 is taken (it touches the read path in main; then run it).

### Phase 4 outcome (done 2026-10-01)

**What changed**

| Item | Change |
|---|---|
| 4.1 U-02 | `blockMove.ts`: new `subtaskInsertIndex(rows, placements, sections, parentId)`: after the last task under the parent (its subtasks and theirs) inside the parent's section; the end of the list when the parent is gone. `taskCreation.ts` `addSubtaskFor` uses it instead of `parentIdx + 1`. |
| 4.2 U-03 | `pastePlainText.ts`: `pasteEdges(text)` splits the paste into the text to parse and its closing newlines (CRLF read as LF; newlines opening it dropped; spaces before a closing newline dropped). `closeWithNewlines` then ends the parsed slice: one newline is a soft break at the end of its paragraph text, two or more close the paragraph. A paste ending in a list, quote, heading or code block is left as today. A paste of nothing but newlines goes to the literal paste. |
| 4.3 F-04 | `vaultDeleteOps.ts`: the "moved to Filo's trash" toast's Undo first checks `command.trashId === null` and says `"X" is already back.`, whichever stack held the step. |
| 4.4 F-05 | `trash.svelte.ts`: a registered delete carries `inHistory()`; the list drops every delete whose step has left the history whenever a delete is registered or looked up. New `historyStore.holds(command)` (on any undo or redo stack, or held off-stack) and `deleteUndoCount()`. |
| 4.5 #28 | `tagUndo.svelte.ts`: `pushTagActionToast` gives every vault-wide tag action's toast one `dedupeKey`; the delete and rename toasts are `sticky` with their Undo. `TAG_UNDO_TOAST_MS` is gone. |
| 4.6 #47 | `style.css`: Light `--text-tertiary` `#80868b` → `#6b7075`. `TaskListBoard.svelte`: the shortcut strip loses its 0.55 opacity (and the 0.95 hover opacity and its transition, which only animated that). |
| 4.7 #36 | `filenameUtils.ts`: `STALE_HASH_MAX_BYTES` 2 MB → 16 MB. Measured here: reading and hashing 16 MB takes about 20 ms (2 MB: about 3 ms). |
| 4.7 #34 | Not taken (D7 default: no hard links in use). |

Docs:
- KNOWN_LIMITATIONS:
  - #28 rewritten: the Undo stays until dismissed or replaced by the next tag action's toast.
  - #36: 16 MB, and the measured cost.
  - #47 rewritten: Light meets 4.5:1 on its plain backgrounds; what is still under (hovered and selected rows in Light; the other four themes).
  - #41: what a paste's first and last newlines do.
  - #17: "no `\` at each line end, the last one included".
  - #15: its two mentions of the 2 MB hash limit.
- CLAUDE.md: the hash limit in the note writer's gotcha, the tag Undo line under Undo/Redo, and the project-tree lines for `tagUndo.svelte.ts` and `pastePlainText.ts`.

**Tests**

| File | Cases | On `b8fe878` (fix files put back) |
|---|---|---|
| `src/tests/characterisation/taskSubtasks.test.ts`, new case | 1 | fails |
| `src/tests/unit/blockMove.test.ts`, `subtaskInsertIndex` | 6 | new function |
| `src/tests/unit/pastePlainText.test.ts` | 10 new | 8 fail; the 2 guards for unchanged behaviour pass |
| `src/tests/characterisation/trash.test.ts`, new case | 1 | fails |
| `src/tests/unit/trashDeleteUndoRegistry.test.ts` (new) | 5 | all 5 fail (new API) |
| `src/tests/unit/tagUndo.test.ts` | 2 new | both fail |
| `src/tests/unit/themeContrast.test.ts` | 3 new | all 3 fail |
| `src/tests/unit/staleWriteContentCheck.test.ts` | 1 new | fails |

- **Subtasks** (characterisation): a Task List with "Plan trip" and "Pack". "Add subtask" twice from the context menu shows Plan trip, Subtask 1, Subtask 2, Pack, on screen and in the saved board; Ctrl+Z takes back Subtask 2. The harness gains `addSubtask(app, row)`; the gate minimum for the spec goes from 2 to 3. The unit cases: no subtasks yet, after earlier subtasks, after a subtask's own subtasks, a subtask placed after an unrelated task, the section end, a parent that is gone.
- **Paste** (unit, the real editor): `just one line\n` then typing saves `just one line\ntyped after`, as a soft break. Also:
  - CRLF;
  - pasted after text;
  - `abc  \n` (the spaces would read back as a hard break);
  - two and three closing newlines (a new paragraph);
  - several paragraphs;
  - a list or heading (unchanged);
  - opening newlines dropped, as Ctrl+Shift+V drops them;
  - Ctrl+Shift+V unchanged;
  - `pasteEdges` itself.

  Every saved text is reopened and must save the same.
- **Trash Undo after a restore** (characterisation): with no board open, delete a note, restore it from Settings → Trash, click the toast's Undo. The toast reads `"Solo.md" is already back.`, no "reloaded from disk" warning, and the note is unchanged. The gate minimum for `trash.test.ts` goes from 9 to 10.
- **The Trash list** (unit, real history store): `holds` on the undo stack, the redo stack and off-stack. A delete leaves the list when undone from its toast or off-stack. Undone with Ctrl+Z it stays, since a redo trashes it again, and leaves once the history drops it. 20 deletes, 15 undone, leave 5.
- **Tag Undo** (unit, fake timers): the delete's Undo is still there after 10 minutes and goes when dismissed. A rename's toast replaces it. A merge's toast (no Undo) replaces that, and goes after 15 s.
- **Contrast**: Light tertiary at 4.5:1 on `--ui-bg`, `--ui-surface` and `--ui-bg-secondary`.
- **Hash limit**: a 10 MB note changed to a same-size, same-stat version is refused (`STALE`); past the limit the stat alone decides.

**Verification**
- **The tests bite.** The eight fix files were put back to `b8fe878`, the new tests run, and the files restored byte-for-byte (table above).
- **Each part of the new logic is pinned.** Each mutation below was applied in turn, its tests run, and the file restored byte-for-byte:

  | Mutation | Tests that fail |
  |---|---|
  | subtask slot ignores the section end | 1 |
  | subtask slot goes after direct subtasks only | 1 |
  | subtask slot stops at the first other task | 1 |
  | paste keeps the spaces before a closing newline | 2 |
  | paste reads two closing newlines as one | 1 |
  | paste keeps opening newlines | 2 |
  | the Trash list is never pruned | 4 |
  | `holds` ignores the redo stack | 2 |
  | tag action toasts not keyed | 1 |
- **The real app.** A Playwright script drove the built app over a vault with a Task List and a note (`phase4check.mjs`, this session's scratchpad). All 12 checks passed, with no renderer errors:
  - the theme is Light, and the shortcut strip's computed colour is `rgb(107, 112, 117)` at opacity 1;
  - "Add subtask" twice from the context menu shows Plan trip, Subtask 1, Subtask 2, Pack, and the saved board has the same order;
  - in a Document tab, Enter, then Ctrl+V of `just one line\r\n` from the system clipboard, then typing, saves `just one line\ntyped after` with no `\`, shown as a soft break.
- `npm run ci:verify` on Windows: green.
  - lint, svelte-check (859 files) and `typecheck:main` clean;
  - `test:unit:strict`: 791 files, 7,491 tests passed, 5 skipped;
  - build;
  - 89/89 gates, including `characterisation-suite` (the new minimums), `test-typecheck` (the new test file type-checks clean), `css-vars` and `no-audit-narration`.
- E2E on the built app: 23 passed in 1.9 min, including the quit, crash-recovery, sync-delivery and editor-fidelity specs (every note write goes through the #36 check). The 3 skipped are the scale budgets, which run only with `FILO_E2E_SCALE=1` (Phase 6).

**Deviations from the plan**
1. **4.2 handles both ends of the paste, and more than one newline.** The plan covered one trailing newline.
   - Newlines opening a paste are dropped. They became a hard break too (`existing\` then `abc`, the same stray `\`). Ctrl+Shift+V already drops them.
   - Two or more closing newlines close the paragraph, as a blank line does in the paste and as Ctrl+Shift+V does. Before, they were two hard breaks (`a\` `\`).
   - Spaces before a closing newline are dropped. Kept, two of them before the soft break read back as a hard break.
   - Only a paste that ends in paragraph text takes the soft break. One that ends in a list, quote, heading or code block already ended its block and still does: a soft break in a heading would be saved as HTML.
2. **4.3 says "already back"** rather than closing quietly (the plan offered either). It is the wording the toast already used when Ctrl+Z had undone the delete.
3. **4.4 drops a delete when its step leaves the history**, checked when a delete is registered or looked up, not at the moment of the restore.
   - A delete undone with Ctrl+Z stays listed: its step is on the redo stack, and a redo puts the item back in the trash, where Settings → Trash should again restore it with its tiles.
   - The list is therefore bounded by the history itself.
4. **4.5: a merge's toast takes the same key.** It has no Undo and still closes after 15 s, but it replaces an older Undo, as D5 asks for "a newer vault-wide tag action". Closing or switching the vault also closes the toast, as it did.
5. **4.6: the strip's hover rule and transition went with its opacity.** The hover only raised the opacity to 0.95, which at full colour would have dimmed it. The contrast test also checks `--ui-bg-secondary`. KNOWN_LIMITATIONS #47 is rewritten rather than removed, since hovered and selected rows in Light (4.5:1 and 4.2:1) and the other themes are still under 4.5:1.
6. **4.7 #36 adds a test**, which the plan called "its test": there was no size-limit case before.
7. **Not in the plan:** KNOWN_LIMITATIONS #15 and #41, and the CLAUDE.md lines above, which named the old behaviour.
8. **The `file-sizes` allowlist:** `TaskListBoard.svelte` lost 3 lines of CSS, so its ceiling is pinned at its new count (1,371 → 1,368), as Phase 0 did.
9. **E2E was run** although the plan didn't ask for it without #34: #36 changes the check every note write makes in main.

**New findings** (low, not fixed)
- **Ctrl+Shift+V of a line ending in two spaces, with a line after it**, puts the spaces before a soft break. The file then holds `abc··` and a newline, which Markdown (Filo included, on reopening) reads as a hard break. Nothing is lost, but a later save may write it as `\`. Ctrl+V now drops such spaces only at the end of the paste.
- **Tertiary text in the four other built-in themes** is 3.0–3.3:1 on the app background (the test's 3:1 bar) but 2.1–2.9:1 on card and panel surfaces, which no test checks. Raising them is a palette call, like D6.
- **Light's hovered and selected rows** take tertiary text to 4.49:1 and 4.15:1, just under 4.5:1.

---

## Phase 5: board-format migrations (#29; Useful 8/10, Hard 4/10)

Your boards are now real data. Today a board in any format but v8 is refused (`schema/migrations.ts`, `boardLoader.ts` `no-migration-path` / `from-future`), so the next board-format change would strand every board. Build the mechanism now, while nothing needs it, and test it with a synthetic step.

### 5.1 The pipeline

- `MIGRATION_STEPS` becomes an ordered list of `{ from: n, to: n + 1, migrate(raw): raw }`, empty today.
- The loader:
  1. runs the steps from the file's version up to `CURRENT_BOARD_FILE_VERSION`;
  2. validates the result with the current schema;
  3. keeps refusing a file from the future or with no path forward, as now.
- A migrated board is **not written until the user changes it**. Before its first write, its original bytes are copied to `.filo/recovery/<ts>-keep/`, which is never pruned.
- One notice per vault open: "N boards were updated to the new format; the originals are in .filo/recovery/…", with **Show in folder**.
- A step that throws, or output that fails validation: the board is listed as failed, exactly as today. The file is untouched.
- **DECISION D8:**

  *Default: as described.*

### 5.2 The gate

Rework `no-legacy-board-migration` (`scripts/gates/codebase.mjs:273`). Instead of requiring `MIGRATION_STEPS` to be empty, it requires:
- the steps to be contiguous and to end at `CURRENT_BOARD_FILE_VERSION`;
- every step to have a fixture test: an old file → the new file → valid under the current schema, and a second load of the result changes nothing.

Prove it bites:
1. Add a step without a fixture: the gate fails.
2. Revert.

### 5.3 Tests

- A test-only registry with a synthetic v8 → v9 step (it renames one field):
  - the board loads;
  - nothing is written by opening it;
  - the first edit writes v9 after the recovery copy;
  - the notice appears once.
- A step that throws: the board is listed failed and its file is byte-identical afterwards.
- Characterisation: open a vault holding a board one version behind (synthetic step), edit it, reopen. The edit is there and the original is in `.filo/recovery/`.

### 5.4 Docs

- CLAUDE.md "Only v8 board files load" becomes: "Boards load at the current version or through tested migration steps".
- KNOWN_LIMITATIONS #29 rewritten.

E2E: full suite (the vault-open path changes).

---

## Phase 6: verification and archive (Hard 2/10)

1. Run the checks:
   - `npm run ci:verify` on Windows;
   - `npm run build && FILO_E2E_SCALE=1 npm run test:e2e`;
   - the 5,000-note real-app pass (`sim.pass.ts` and `phase1.pass.ts`, recipe in memory `audit26-predailyuse-2026-09-30`), all green.
   - No corpus run is needed: no phase changes how a note body is written. Phase 4.2 changes paste only.
2. KNOWN_LIMITATIONS: confirm #4, #17, #28, #29, #47 (and #34 / #36 if 4.7 was taken) say what the code now does.
3. Add an "after fixes" column to the review's bug table.
4. Move the review and this plan to `docs/archive/`.
5. Commit, and push after the owner's go-ahead.

---

## Track B (later): the Markdown editor pipeline

Not part of this round. Start only after Phases 0–6 have had some weeks of daily use, on its own branch (KNOWN_LIMITATIONS #32: upgrade only on its own branch, with the full `test:unit:strict` run green). Each part gets its own plan when it starts. The sketches below set its scope.

### B1: write note bodies without `tiptap-markdown` (#32 Step 1; Useful 6/10, Hard 6/10)

- Filo already replaces tiptap-markdown's serializer state with `prosemirror-markdown`'s (`delimiterRuns.ts`) and extends its writers in a dozen modules.
- Drive `prosemirror-markdown` and markdown-it directly:
  - parser: markdown-it tokens → ProseMirror nodes;
  - serializer: Filo's existing writers registered as `prosemirror-markdown` node and mark specs.
- Drop the `tiptap-markdown` dependency.
- Go / no-go evidence, all required:
  - the corpus run (18,870 notes): 0 changed, 0 newly lossy against the current output;
  - the property sweep: 14 seeds × 1,500 clean;
  - every round-trip suite green unchanged.
- Gain: one fewer unmaintained dependency on the write path, and a parser Filo controls. That is the base for keeping HTML blocks and reference definitions as verbatim "raw" blocks (#17, Useful 7/10, Hard 6/10), planned as a follow-on.

### B2: a source-preserving editor, spike only (#32 Step 2; Useful 9/10 for the full change, Hard 9/10 full; the spike Hard 5/10)

- **The idea:** an editor whose document *is* the Markdown text, styled as you type (CodeMirror 6 with live preview, Obsidian's model). Notes would be byte-exact by construction, which removes:
  - read-only notes;
  - the restyle-on-first-edit table;
  - most of the editor-fidelity code.
- **Spike:** a Document tab prototype on a branch. Measure:
  - fidelity on the corpus;
  - feature gaps against today's editor: tables, checklists, aligned blocks, line spacing, the formatting toolbar, Kanban card and Mind Map tile editors;
  - typing and load performance at 5,000 notes;
  - the size of the change to `noteEditorView.ts` and the note model.
- **Deliverable:** a go / no-go note in `docs/` with a phased plan if "go". Nothing merged from the spike.
- **DECISION D9:** B2 starts as a spike only.

  *Default: yes.*

---

## Decisions

| # | Question | Default |
|---|---|---|
| D1 | A flushAll capture superseded by a newer schedule of the same key | Skipped; its waiters settle with the newer write |
| D2 | Search text with no operators and no `/regex/` | Exactly as typed, spaces included; the confirm shows it quoted |
| D3 | When a tile / frame title commits on blur | Unless focus moved into the formatting toolbar or one of its popups |
| D4 | A trailing newline in a plain-text Ctrl+V | A soft break, like the paste's other newlines |
| D5 | Several vault-wide tag Undo notifications | Sticky; the newest replaces the older |
| D6 | Light theme tertiary text colour | `#6b7075` (≈5:1); the Task List hint strip at full tertiary (confirmed by the owner, 2026-10-01) |
| D7 | Optional quick wins | Take #36 (hash limit 16 MB); skip #34 (hard links) unless needed |
| D8 | Board-format migrations | Steps up to current; no write until edited; original kept in `.filo/recovery/<ts>-keep/`; a failed step leaves the file untouched |
| D9 | Source-preserving editor | Spike and go / no-go note only |

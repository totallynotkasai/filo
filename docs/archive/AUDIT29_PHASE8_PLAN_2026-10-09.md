# Audit-29 Phase 8: three backlog items (draft, 2026-10-09)

- **Source:** `docs/BACKLOG.md` items BL-09, BL-45 and BL-46, chosen by you after Audit-29 Phase 7 ([AUDIT29_IMPLEMENTATION_PLAN_2026-10-08.md](AUDIT29_IMPLEMENTATION_PLAN_2026-10-08.md)). A follow-on to that plan, so commits say "Audit-29 Phase 8" with the BL number.
- **Status:** done (2026-10-09); see section 5. You took every default: D1 all block markers, D2 the Linux skip off, D3 E2E once at the end, D4 installer and push. You also took the extra from section 4: `recoverySnapshot.test.ts` gets the 20 s budget (folded into 8.1).
- **Version:** 0.2.9 when it is handed over.
- **Scores**, out of 10:
  - **Impact:** 0/10 is harmless, 10/10 loses notes.
  - **Hard:** 0/10 is minutes, 5/10 a few days with tests, 10/10 weeks.

## 1. What and why

| # | Item | What you'd notice today | Impact | Hard |
|---|---|---|---|---|
| 8.1 | BL-09, the component tests | Nothing in Filo. Tests that give a save a fixed 520 ms, when it lands at about 485 ms, turn a run red on a busy PC or GitHub's slower runner. Last night's red GitHub run was partly this. | 0/10 | 2/10 |
| 8.2 | BL-46 | Your agent renames a folder and, at the same moment, edits one note in it and deletes another. If you were typing in the edited note, Filo says it was deleted, and **Keep mine** writes a second copy at the old place. On Linux it happens without the edit, which is why one test now skips there. | 2/10 | 3/10 |
| 8.3 | BL-45 | In a note whose lines are joined by single line breaks (from Keep, a plain-text paste, your agent), typing `- ` at the start of a line leaves it text (saved `\- `) instead of starting a list. | 1/10 | 2/10 |
| 8.4 | Checks and handover | Version 0.2.9, the checks, the backlog, and the build. | — | 1/10 |

Sum of Hard scores: 8. Rough size: two days.

**Order:** the test fix first, so the checks of the other two can be trusted on a busy PC; then the watcher (main process); then the editor.

## 2. Tasks

### 8.1 BL-09: the component tests wait for the save, not a fixed time

Phase 7 added `drainUntilWritten` (`src/tests/component/helpers/mountEditor.ts`) and used it in the two tests that failed. 17 component test files still call `drainDebounce()` 43 times.

| Step | What |
|---|---|
| a | Sort each `drainDebounce()` call by what follows it: a count of saves expecting one or more; a check that **no** save was made; or neither (it only lets things settle). |
| b | Saves expected: use `drainUntilWritten`. |
| c | No save expected: a new `drainUntilSettled()`. It waits the debounce at least, then until nothing is left to save (`unsavedWork()` empty: no keys an editor hasn't serialised, nothing pending or in flight). A save that comes late on a busy machine is then still caught. Today such a test can pass without seeing it. |
| d | Neither: leave as it is. |
| e | Bite check for each helper: with the edit removed, a `drainUntilWritten` test fails; with a stray save added after the edit's own, a `drainUntilSettled` test fails. |
| f | BL-09 keeps the rest it lists (the watcher and recovery-snapshot waits, the Chromium caret cases, two E2E waits). The "Not in this phase" list below names them. |

**Tests:** the 17 files themselves. The suite's run time should not grow: the new helpers return as soon as the save lands.

### 8.2 BL-46: a folder renamed while one note in it is edited and another removed

**Why it happens.** Windows reports another program's folder rename by the two folder names alone. Filo's walk then finds `Places/Castle.md` gone and `04 Worldbuilding/Castle.md` there. But the live watcher has already reported the edit at the new path, so the presence map (`fileWatcher.ts`, `presence`) says that path "held a file before". The pairing then reads the move as a replace (`renameCorrelation.ts`, `replacesFile`), on purpose: a file renamed over an existing one is that file changed, not a move.

On Linux, Node's watcher reports every file of the renamed folder as new, so the same thing happens with no edit.

**The fix.** The watcher remembers, for each path, whether it **arrived**: an event first saw it holding a file where the presence map had none (gone, or never seen), and nothing paired with it.

- In a later batch, a same-named note the walk finds gone may pair with an arrival, when the walk's last record of the old path (`ReconcileEntry.seenAt`) is older than the arrival. The note moved after it was last seen.
- The pairing's usual checks then decide as now: the bytes, or `movedAndChanged` for an edited note, with its Reload / Keep mine on the moved note.
- A path that held a file at the last walk, or that Filo wrote, or that an event saw changing while it was already known, still refuses: a replace stays a replace.

| Step | What |
|---|---|
| a | `fileWatcher.ts`: record arrivals beside `presence`, and clear one once the path is paired, written by Filo, walked, or gone. |
| b | `renameCorrelation.ts`: `wasPresentBefore` stays the question, answered "no" for an arrival newer than the missing note's last walk record. Only for a same-named note pair, as `movedAndChanged` is now. |
| c | `fileWatcherOwnMoves.ts`: a followed folder move carries arrivals with it, as it carries presence (Phase 2's rule: never carry a "gone" mark over a new path). |
| d | KNOWN_LIMITATIONS #31: take out the case this fixes, and say what's left. |
| e | Take the Linux skip off `agentReorganises.test.ts` (D2). |

**Tests:**
- **Characterisation, BL-46's own case** (new, in `agentReorganises.test.ts`): `Places/Castle.md` open with typing. Rename `Places` to `04 Worldbuilding`, rewrite `04 Worldbuilding/Castle.md` and delete `04 Worldbuilding/Forest.md` at once. The one question is Reload / Keep mine on the moved note, never "deleted". The tile names the new path. After Keep mine there is no `Places/Castle.md`.
- **The same with no typing:** the note just shows the edit.
- **Controls that must stay green:** `renameOntoExistingFile.test.ts` and `watcherOverflowAndReplace.test.ts` (a rename onto an existing file is a replace), and the merge case in `agentReorganises.test.ts` (a note merged into a same-named one and deleted still asks).
- **New unit cases** (`renameCorrelationMovedAndChanged.test.ts` or a new watcher test):
  - an arrival pairs with a walk-found missing note;
  - a file present at the last walk does not;
  - an arrival that is then replaced by a live rename stays a replace;
  - an arrival carried through a followed folder move.
- Run on the code before this phase, the new characterisation case must fail; it did, with a throwaway spec, in Phase 2.

### 8.3 BL-45: a list marker typed at the start of a soft-broken line

**Why it happens.** TipTap's input rules match the text from the start of the paragraph to the caret. A soft break reads there as a placeholder, so `^\s*([-+*])\s$` never matches after one. All of Filo's block input rules go through `typedOnly` (`lib/editor/sceneBreaks.ts`): bullets, numbers, checklists, quotes and headings.

**The fix.** In `typedOnly`, when the text before the caret holds a soft break:

- match the rule against the text after the last break;
- on a match, make the caret's line a block of its own first: split at the soft break before it and the one after it, as the toolbar does since Phase 1 (`isolateSelectedLines` in `lineBlocks.ts`);
- then run the rule on that block, in one undo step.

The lines above and below stay as they are. Not inside a list item or a table cell, where a split would change the list or the table (Phase 1's rule). A marker typed mid-line stays text. Backspace straight after (TipTap's "undo input rule") and Ctrl+Z give back the typed `- ` with the lines joined as they were. Which markers: D1.

| Step | What |
|---|---|
| a | `sceneBreaks.ts` `typedOnly`: the after-the-break match and the split, sharing `lineBlocks.ts`'s split (no second copy of it). |
| b | Undo: Backspace straight after, and Ctrl+Z, restore the text and the soft breaks. |
| c | BL-45 leaves the backlog. |

**Tests:**
- **Chromium, real keys** (`sceneBreaksInChromium.test.ts` or a new `lineMarkersInChromium.test.ts`): on line 2 of a three-line soft-broken paragraph, each marker D1 takes. Line 2 becomes that block, lines 1 and 3 stay text, one Backspace gives back `- `, and a `- ` typed mid-line stays text.
- **jsdom unit** for the rule itself: the split, the undo, refused in a list item and a table cell.
- **Characterisation:** typed in a Document tab, the file reads `L1`, a blank line, `- L2`, a blank line, `L3`, and reopens editable as the same note.
- **Round trip:** the property test (gate `editor-round-trip-property`) stays green.
- **Corpus:** no output changes; input rules don't run on load, but CLAUDE.md asks for the corpus after any editor change.

### 8.4 Checks and handover

- `npm run ci:verify` on Windows.
- The corpus (`corpus:run` + `corpus:compare` against `corpus-a29.json` and `owner-corpus-a29.json`).
- The E2E suite, if D3 says so: 8.2 changes file watching and 8.3 the editor, both of which CLAUDE.md lists for it.
- Version 0.2.9, and the build as D4 says.
- The backlog: BL-45 and BL-46 leave it, and BL-09 keeps what 8.1 doesn't cover.
- This file gets an outcome section and moves to `docs/archive/`.

**Pass:**
- Your agent's folder rename with an edit and a delete is followed, with one Reload / Keep mine question and no copy left at the old place.
- `- ` at the start of a Keep-style line starts a list on that line alone.
- `ci:verify` passes without a timing miss, and GitHub's run passes with the Linux case back on.

## 3. Decisions for you (defaults in bold)

| # | Decision | Options | Affects |
|---|---|---|---|
| D1 | Which markers start a block at the start of a soft-broken line | **All of Filo's typed block markers: `- ` `* ` `+ ` (bullets), `1. ` (numbers), `[ ] ` (checklist), `> ` (quote) and `# ` to `###### ` (headings), each on that line alone, as the toolbar acts on one line since Phase 1.**<br>Or lists and checklists only. | 8.3 |
| D2 | The Linux skip on `agentReorganises.test.ts` | **Take it off with the fix, and let GitHub's run decide. If it still fails there, put the skip back and record why.**<br>Or leave it skipped. | 8.2 |
| D3 | The E2E suite (Phase 7 ran none, at your request) | **Run it once at the end, at a time you say the PC is free (about 5 minutes, with Filo windows opening).**<br>Or skip it again. | 8.4 |
| D4 | Handover | **Version 0.2.9 as an installer in `release/` (like 0.2.8), and push once the checks pass.**<br>Or `npm run preview` only (no installer), or keep it on this PC. | 8.4 |

## 4. Not in this phase

All stay in `docs/BACKLOG.md`.

| Item | Why not now | Impact | Hard |
|---|---|---|---|
| The rest of BL-09: the watcher tests, the Chromium caret cases, two E2E waits | Different waits (real disk events, the caret), each its own fix. `recoverySnapshot.test.ts` taking the 20 s budget its neighbour got, a one-line change, was taken into 8.1 at your request. | 0/10 | 0/10 to 2/10 |
| BL-21 | Look at the first GitHub run after 19 October; nothing to do before. | 0/10 | 1/10 |
| BL-43 | GitHub's hour-long run; about 330 of the 2,000 free minutes used in October so far (seven runs). | 1/10 | 2/10 |
| BL-07, BL-28 | Scale-budget spikes in the E2E suite only. | 0/10 to 1/10 | 2/10 to 4/10 |
| BL-15 to BL-18 | Notes reading differently on GitHub's website, which you don't use for notes. | 1/10 | 2/10 to 3/10 |
| BL-39, BL-42, BL-44 | Each waits on something else, or is cosmetic on a read-only note. | 0/10 | 1/10 |

## 5. Outcome

Done 2026-10-09. You took every default (D1 all block markers, D2 the Linux skip off, D3 E2E once at the end, D4 installer and push) and the extra from section 4 (`recoverySnapshot.test.ts`'s budget).

### 8.1 BL-09: the component tests wait for the save

- **The sort** (step a). The 43 calls in 17 files: 19 expect a save and now use `drainUntilWritten`; 17 expect none and use the new `drainUntilSettled`; 7 stay `drainDebounce`, since they are neither or can't settle: `documentEditorSelfReload` after its undo (checks the editor only), `leavingDocumentTab` (checks the toolbar), `textTileHrBody` between two mounts, and four whose note holds the typing on purpose (`noteEditorRefusedBody` twice, `textTileAdoptPlaceholder` (b) twice: an unreadable note), where waiting for nothing to be left would never end.
- **The helpers.** `drainUntilSettled` waits the debounce (520 ms), then until nothing is pending or in flight (a failed write counts as settled: nothing more reaches the disk until Retry).
- **Deviations from the plan:**
  - `drainUntilSettled` **throws** when work is still left after 3 s, rather than returning, so a test whose note holds a change can't quietly take 3 s longer. That is how case (b) above was found to be one of them.
  - `drainUntilWritten` changed from Phase 7's form: it waits for the write, then until nothing is left to save (instead of a fixed debounce more), and gives up after 3 s instead of 5, under the component project's 5 s test timeout, so a missing save fails on the test's own expectation. Windows' 15 ms timer floor makes each `settle()` cost about 300 ms, so the first version (write, a 200 ms wait, then the settle) was slower than the old fixed wait; this one isn't.
- **Bite check** (step e), with a throwaway spec: a stray save armed 600 ms after the unmount passed the old fixed wait (one save counted) and failed `drainUntilSettled` (two); with the edit removed, `drainUntilWritten` failed on the count (0) inside the test's timeout.
- **Run time:** the 15 changed files' summed test time 143.7 s, against 148.5 s with the old waits.
- **The extra:** `recoverySnapshot.test.ts` has the 20 s budget.

### 8.2 BL-46: a folder renamed while one note in it is edited and another removed

- **What changed.** A new module, `src/main/services/fileWatcherArrivals.ts` (`Arrivals`), keeps three records: when each path **arrived** (an event first saw it holding a file where the presence map had none, and nothing paired with it), when each path was last **seen** holding a file (an event, or Filo's own write), and, for each note the walk finds gone, the time of the walk's last record of it. `correlateRenames` takes one more probe, `arrivedSinceLastSeen`: for a same-named pair of notes, a known path that arrived after the walk's note was last seen isn't a replace, and the bytes or `movedAndChanged` decide as before. The watcher records arrivals in its notify pass, clears one when the path is paired, written by Filo, trashed, gone, or recorded by a second walk, and carries arrivals with Filo's own and followed moves.
- **Deviations from the plan:**
  - The records live in their own module, not in `fileWatcher.ts`, so the watcher's change is wiring and the rules have unit tests of their own. Step c's carry goes through `rekeyUnder`, now exported from `fileWatcherOwnMoves.ts` (its `moveCaches` uses it too), called from `noteOwnMove`, so a move Filo makes carries arrivals as a followed one does.
  - **"Last seen" is not only the walk's record:** an event or Filo's own write that saw the old note after the arrival counts too. Otherwise a note another program edited after a same-named note appeared elsewhere, then deleted where the live watcher can't see it (inside a removed folder), would be taken for a move.
  - **Two holes found by the new unit cases and closed:** (1) a note the live watcher already reported gone (a file renamed over another: a replace) is reported again by the next walk, and the plan's rule turned that into a move then; the walk now records a vanished note for the rule only when nothing has reported it gone. (2) A path the walk finds new counted as arrived at the walk's time even when Filo had written it, or a followed move had placed it, which let a note Filo just made take a same-named note's tiles; it now counts only when nothing placed it. One more watcher case covers (2): a note Filo wrote is never taken for the arrival.
- **Tests.** Characterisation (`agentReorganises.test.ts`, 2 new): with typing, the one question is Reload / Keep mine on the moved note, the tile names the new path, Keep mine leaves no `Places/Castle.md` and keeps the other version in `.filo/recovery/`; without typing, the note shows the edit at its new place once Filo walks the vault (the window regaining focus; the harness's `walkVaultNow`). **Both failed on the code before this phase** and pass now. Watcher (`watcherOverflowAndReplace.test.ts`, 5 new): the plan's four, plus the Filo-written note. Bite checks: without the "already reported gone" rule the replace case fails; without the carry, the followed-move case fails; without the walk-new rule, the Filo-written case fails. Pairing (`renameCorrelationMovedAndChanged.test.ts`, 4 new) and `Arrivals` (`fileWatcherArrivals.test.ts`, 10). Controls green: `renameOntoExistingFile.test.ts`, `watcherOverflowAndReplace.test.ts`'s replace cases, and the merge case in `agentReorganises.test.ts`.
- **D2:** the Linux skip is off `agentReorganises.test.ts`'s "one of its notes deleted" case, and `harness/platform.ts` no longer names that reason. GitHub's run decides.
- **Docs:** KNOWN_LIMITATIONS #31 (what the walk now follows, what is left: such a folder is followed by the walk, not the tree, so a note with no typing in it moves when the window takes the focus or at the 30 s walk; boards and attachments aren't followed this way; and the flip side, an unrelated same-named note followed as a move over up to 30 s instead of 1.5 s) and #7's flip side. CLAUDE.md's structure lists the new module.
- **Gate:** `characterisation-suite`'s floors raised to the new counts: `agentReorganises.test.ts` 9, `editorFidelity.test.ts` 7 (it had 6 cases against a floor of 3).

### 8.3 BL-45: a list marker typed at the start of a soft-broken line

- **What changed.** `typedOnly` (`sceneBreaks.ts`) now gives each block rule a second rule, `atLineStart`: the same pattern matched after the block's last newline, which on a soft break splits the caret's line off with `isolateSelectedLines` (`splitsAtLines` now exported from `lineBlocks.ts`) and runs the rule on that block, all in the rule's own transaction. Backspace straight after (TipTap's undo of an input rule) and Ctrl+Z give back the typed marker with the lines joined. All of D1's markers: `- * +`, `1.` (a year still refused), `[ ]` / `[x]`, `>`, `#` to `######`.
- **Deviation:** BL-45 said a soft break reads as `%leaf%` in the text the rules match. It reads as a newline (its `renderText`), and so does a hard break, so the rule checks that the node before the marker is a soft break: after Shift+Enter the marker stays text, as the toolbar's line rule does. The rule at the block's start is untouched (a second rule rather than a changed one).
- **Tests.** jsdom `lineStartMarkers.test.ts` (22: each marker, only the caret's line, the last line and one after an empty line, joining the list above, both undos, the Backspace key; staying text mid-line, after a hard break, in a list item, in a table cell, for a year, and on Enter). Chromium `sceneBreaksInChromium.test.ts` (13 new, real keys: eight markers, the text typed after, Backspace, Ctrl+Z, mid-line). Characterisation `editorFidelity.test.ts` (1 new: typed in a Document tab, the file reads `Physical`, a blank line, `- Strength - raw power`, a blank line, `Endurance - stamina`, and reopens editable, writing nothing). The harness gained `caretBefore`. **Bite checks:** with the old `typedOnly`, 15 of the jsdom cases and 11 of the Chromium ones fail (the rest are the "stays text" controls).

### 8.4 Checks and handover

- **`npm run ci:verify` on Windows:** green in 371 s: 897 files, 8,841 passed, 5 skipped (platform-only cases), 91/91 gates.
- **Corpus:** against Phase 7's results (`corpus-p7.json`, `owner-corpus-p7.json`, the same lists), no output changed, none newly read-only or failing to load (3 notes not compared: this phase's own docs). Against `corpus-a29.json` / `owner-corpus-a29.json`: the same 4 + 3 changed outputs every phase since Phase 1 has reported (trailing blank lines now kept, all toward the file's own text), 0 newly read-only.
- **E2E (D3):** `npm run test:e2e` with `FILO_E2E_SCALE=1`, on the build `ci:verify` made: 56 of 56 passed in 3.9 minutes, the scale budgets included.
- **Version** 0.2.9; HANDOVER_RESULT
- **Backlog:** BL-45 and BL-46 closed; BL-09 keeps the watcher tests, the Chromium caret cases, the folder-delete undo's tree read and the two E2E waits; Phase 7's green run (37904980748, 59 min) recorded under BL-21 and BL-43. No new item: the next is still BL-51.

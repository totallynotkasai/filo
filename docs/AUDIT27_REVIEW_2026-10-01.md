# Audit-27: whole-codebase review, the line-limit gate, and the known limitations (2026-10-01)

Audited: `main` @ `abf5212`. The eight Audit-26 commits (`db1af24..abf5212`) were pushed to GitHub first, as asked. They were verified on Windows in the Phase 7 session (`ci:verify` 7,394 tests and 89 gates, E2E 26/26 with scale budgets).

How it was done (three reviewers in all, per the "as few agents as possible" brief):
- **The orchestrating session** reviewed the renderer feature layer: search and replace, Task List, Kanban, Mind Map selection, the editor and paste, hotkeys, tabs, settings and templates. It also wrote this report.
- **One finder agent** reviewed the data layer: the main process, the note, board and config writers, vault open, close and rename, and trash.
- **One refuter agent** tried to knock down every finding.

Every finding below was confirmed by the refuter, most of them with a throwaway test. Those tests are not in the repo. They are kept in the session scratchpad: `mine/`, `finder/` and `refuter/`.

Nothing was fixed (report only, as agreed). No app source changed.

---

## How to read the scores

Every score in this report is a number **out of 10**, written like `7/10`. There are three kinds.

| Score | 0/10 means | 5/10 means | 10/10 means |
|---|---|---|---|
| **Impact** (bugs only): how much the bug can hurt you in daily use | harmless, nothing you'd notice | a real annoyance, or a small change lost now and then | loses or corrupts your notes |
| **Useful**: how much you'd gain if it were fixed or added | no gain for you | a clear improvement you'd notice every week or so | essential |
| **Hard**: how much work it is | minutes: one line or a constant | a few days, touching several files, with new tests | weeks: rewriting a major part of Filo |

The **Useful** scores are for your setup: one Windows machine, Syncthing, 500–5,000 notes, all four board types.

---

## Summary

**Bugs.** 10 survived the refuter. Their impact scores run from 7/10 down to 0/10, and none loses the text of a note.

| Bug | What | Impact |
|---|---|---|
| **F-01** (most important) | When several boards have unsaved changes and one board's save is slow, a board you edit during the save can end up holding the version from a moment before. Filo believes it is saved. | 7/10 |
| **U-01** | After **Replace**, the match Filo shows and the match the next Replace changes drift apart. | 5/10 |
| **U-04** | The search text is trimmed, so searching ` - ` finds every hyphen. | 5/10 |

**The 1,000-line gate.** It doesn't stop any change I'd want to make. It adds friction in two places:
- the six files already over the limit;
- the ten safety-critical files sitting just under it.

It also penalises the "why" comments the project requires. Recommendation in section 2.

**Known limitations.** Every one of the 45 still-open entries is scored in section 3:
- most are correct trade-offs, where a change would be worth 0/10 to 2/10 to you;
- the ones worth doing:

  | Entry | Useful | Hard |
  |---|---|---|
  | #29 board-format migrations | 8/10 | 4/10 |
  | #32 / #17 the Markdown editor pipeline | 6/10 to 9/10 | 6/10 to 9/10 |
  | #28 a longer-lasting tag Undo | 5/10 | 2/10 |
  | #6 the minimap | 4/10 | 5/10 |
  | #47 text contrast | 4/10 | 1/10 |

Only #32 (with #17) is genuinely a library or framework question. The rest are architectural or platform limits.

---

## 1. Bugs

| ID | What | Impact | Hard to fix | New since Audit-26? | Proof |
|---|---|---|---|---|---|
| F-01 | A full save can write an older copy of a board over a newer one | **7/10** | 4/10 | No (older design) | Test, real board scheduler |
| U-01 | After Replace, the shown match and the replaced match drift apart | **5/10** | 2/10 | Yes (fd7718a) | Component test |
| U-04 | Search trims and re-spaces the text you type | **5/10** | 2/10 | No (known-open, undocumented) | Unit test |
| N-1 | Clicking away from a tile or frame title doesn't save it | 4/10 | 3/10 | No | Component test + code |
| F-02 | Deleting a board during a slow save can trash an older copy | 3/10 | 0/10 (fixed with F-01) | Yes (0983a46) | Test |
| F-03 | A half-typed tile, frame or connection title doesn't hold back a Windows restart | 3/10 | 2/10 | Yes (0983a46) | Test |
| U-02 | Each new subtask appears above the earlier ones | 2/10 | 1/10 | No | Whole-app test |
| U-03 | Ctrl+V of plain text ending in a newline saves a stray `\` | 2/10 | 1/10 | Partly (incomplete fix in 0983a46) | Unit test |
| F-04 | Wrong message from the delete notification's Undo after a Trash restore | 1/10 | 1/10 | Yes (fd7718a) | Code |
| F-05 | The Trash restore list keeps one small entry per delete for the session | 0/10 | 1/10 | Yes (fd7718a) | Code |

### F-01: a full save can write an older copy of a board over a newer one (Impact 7/10, Hard 4/10)

**In plain terms.** Ctrl+S saves every board with unsaved changes, one after another. So do a sidebar rename, move, delete or new folder, which save first. Filo takes a copy of each waiting board at the start and writes them in turn.

If one of those writes is slow, you may drag a tile on a board further down the list in the meantime. Slowness is mainly Windows holding a file locked for a few seconds (antivirus, a sync client), or a very large board. Your new change is then saved straight away. A moment later Filo reaches its old copy of that board in the list and writes it on top. The board file ends up one step behind what you see. Filo thinks everything is saved, so nothing is retried.

**How it affects use.** Usually you'll never notice, because your next change to that board rewrites the whole file correctly. If that drag (or card move, or column change) was your last change to the board before closing Filo, it is gone the next time you open it. There is no warning and no rescue copy. Notes are not affected: the note writer reads the latest text at write time.

**Where.**
- `src/renderer/lib/boards/writeScheduler.ts:663-684`: `flushAll` captures every pending board up front.
- `:745-755`: it fires the captured copy after waiting for any write in flight.
- `:444-454` and `:114`: a fresh 300 ms timer for the same board doesn't wait for the captured copy.
- `boardWriteScheduler.ts:192-195`: the snapshot is frozen at capture.
- The drift check can't catch it: the baseline is Filo's own newer write.

**Fix sketch.** Give each board key a sequence number, and have `flushAll` skip (or re-read) a captured entry whose key was scheduled again after the capture. Or make the timer treat a captured entry as a prior write and wait for it. The note writer's "read at write time" pattern is the model. The refuter suspects the shared `createScheduler.flushAll` may expose the config and misc schedulers the same way. That is unverified; check it with the fix.

### U-01: after Replace, the match Filo shows and the match it changes drift apart (Impact 5/10, Hard 2/10)

**In plain terms.** Since Audit-26 Phase 5, the Search panel refreshes its results 0.4 s after notes stop changing. This stops typing from stuttering with the panel open. But single **Replace** replaces the current match and then moves to the next one in the *old* list.

Example with matches in notes A, B and C:
1. You click Replace on A.
2. Filo jumps to B's tile.
3. 0.4 s later the list refreshes to [B, C] and the counter says "2 / 2". The current match is now **C**, while the screen still shows B.
4. The next Replace changes C, which you never looked at. B is skipped.
5. Clicking Replace again within 0.4 s instead shows a false "Match moved or was edited externally".

**How it affects use.** If you step through matches deciding one by one, you can replace text in a note you didn't review. It is undoable with Ctrl+Z or from the notification. Replace All is not affected: it searches afresh.

**Where.** `src/renderer/stores/search.svelte.ts:65` (`searchResult`, now debounced by `NOTE_REFRESH_MS` at `:26`) and `src/renderer/components/search/SearchPanel.svelte:159-162` (`handleReplaceCurrent` → `next()`). Before Phase 5 the list refreshed at once, so `next()` also skipped B, but the shown match and the target at least agreed.

**Fix sketch.** After a successful single Replace, refresh the results immediately (`searchNow()` or bump `noteTick`), keep the same index (it now points at the following match), and request the jump.

### U-04: search trims and re-spaces what you type (Impact 5/10, Hard 2/10)

**In plain terms.** The search box removes spaces at the start and end of what you type, and squeezes runs of spaces into one:
- ` - ` becomes `-`;
- `a  b` becomes `a b`;
- `end. ` loses its trailing space.

**How it affects use.**
- **Replace All of ` - ` with ` – `** (the very clean-up `markdownSyntax.ts` names as its example) rewrites every hyphen in every word: `well-known` becomes `well – known`.
- **Removing double spaces is impossible**: the search for two spaces becomes empty.
- The confirm shows a count and file names but not the text actually searched, so the damage is easy to miss. Undo is available.
- Workarounds exist but nothing hints at them. Quote the text (`" - "`) or use a regex (`/ - /`). Whole word doesn't help.

**Where.** `src/renderer/lib/search/queryParser.ts:191` (`raw.trim()`) and `:220` (tokens joined with one space). Listed as open in `docs/archive/AUDIT26_IMPLEMENTATION_PLAN_2026-09-30.md` (lines 588, 699, 760), but not in KNOWN_LIMITATIONS.

**Fix sketch.** When the query has no operators (`tag:`, `board:` …), search the text exactly as typed. Also show the searched text in the Replace All confirm.

### N-1: clicking away from a tile or frame title doesn't save it (Impact 4/10, Hard 3/10; found by the refuter)

**In plain terms.**
1. Double-click a Mind Map tile's or frame's title and type.
2. Click on empty canvas.
3. The title looks done, but it isn't saved: it stays in the title editor until you press Enter or Ctrl+S, switch tab, or leave the vault.

Meanwhile the save indicator says "Saved", and a crash loses the title.

**Where.** `src/renderer/components/tiles/TileHeader.svelte:197-209` and `src/renderer/components/frames/Frame.svelte:266`. The blur check commits only when another editor has become the toolbar's active editor. A title editor's blur never clears that, and the toolbar's own clear waits 300 ms, longer than the 200 ms check. It dates from the first commit. Fix: decide by whether focus moved into the formatting toolbar, not by the active editor.

### F-02: deleting a board during a slow save can trash an older copy (Impact 3/10, Hard 0/10 once F-01 is fixed)

**In plain terms.** This is F-01's race followed by a delete of that board while the slow save is still going. Since Audit-26 Phase 6, the delete waits for Filo's old captured copy. That copy lands last, so the file moved to Filo's trash is one step behind. Undo, or Restore in Settings → Trash, brings the board back without its last change.

The delete goes through the Board Browser's confirm, so a person can't hit the exact timing easily. The F-01 fix covers it.

**Where.** `writeScheduler.ts:674` (the captured entry is now "parked") and `:572-634` (`flush(key)` fires the newer write, then waits for the older one); `src/renderer/stores/boardCacheDelete.ts:76`.

### F-03: a half-typed title doesn't hold back a Windows restart (Impact 3/10, Hard 2/10)

**In plain terms.** When Windows shuts down or restarts, Filo asks it to wait only if something could be lost. Since Phase 6 it decides that by asking whether the focused text is a note editor. It treats every editor of that kind as a note, but tile, frame and connection titles use the same editor kind. Their half-typed text isn't counted anywhere else either.

**How it affects use.** Rename a tile, switch to another app before pressing Enter, and let Windows Update restart the PC. The new title is lost. This contradicts KNOWN_LIMITATIONS #4, which promises that "a focused field whose text changed" counts. A best-effort save is still sent at shutdown, so the title survives if Windows waits long enough. This is the shutdown side of N-1.

**Where.** `src/renderer/lib/vault/unsavedStateReport.ts:30` (`isNoteEditor` = any `.ProseMirror`). Fix: mark note editors with their own attribute, or compare title editors' text like any other field.

### U-02: each new subtask appears above the earlier ones (Impact 2/10, Hard 1/10)

**In plain terms.** On a Task List, "Add subtask" puts the new subtask directly under its parent, above the parent's existing subtasks. Adding three gives the order "Subtask 3, Subtask 2, Subtask 1", the reverse of what most people expect. A sort other than manual hides it.

**Where.** `src/renderer/lib/tasklist/taskCreation.ts:333` (`insertAt = parentIdx + 1`). Fix: insert after the end of the parent's existing subtasks. Proven with a whole-app test.

### U-03: Ctrl+V of plain text ending in a newline saves a stray `\` (Impact 2/10, Hard 1/10)

**In plain terms.** Text copied with a final newline arrives with that newline. Typical sources are whole lines selected in Notepad and terminal output. Pasted with Ctrl+V, the final newline becomes a hard line break, and if you keep typing, the note saves `pasted line\` followed by your text on the next line. The `\` is how Markdown writes a hard line break. Obsidian hides it, but a plain text editor shows it.

KNOWN_LIMITATIONS #17 says pasted text "saves its lines as bare newlines (no `\` at each line end)". Phase 6 fixed this for every line except a trailing one. Ctrl+Shift+V is fine.

**Where.** `src/renderer/lib/editor/pastePlainText.ts:76`. tiptap-markdown re-appends the trailing newline, and ProseMirror turns it into a hard break. Fix: strip one trailing newline before parsing.

### F-04: wrong message from the delete notification's Undo (Impact 1/10, Hard 1/10)

With no board open:
1. Delete a note in the sidebar.
2. Restore it from Settings → Trash.
3. Within 10 s, click Undo on the "moved to Filo's trash" notification.

Filo says it couldn't undo because a board was reloaded from disk. The note is already back and nothing changes. `src/renderer/stores/vaultDeleteOps.ts:91-94`. Fix: check `command.trashId === null` first and say it's already restored.

### F-05: the Trash restore list grows for the session (Impact 0/10, Hard 1/10)

Each sidebar delete adds one small entry, holding the removed tiles and connections, to Settings → Trash's undo registry. It is emptied only when you switch vault (`src/renderer/stores/trash.svelte.ts:48-56`). It still behaves correctly. Tidy it when F-04 is fixed.

### Checked and found sound

In the renderer:
- the tabs and close flow;
- Settings Apply / Revert;
- the clock store (midnight, DST);
- recurrence and date maths, and the quick-add parser;
- Kanban undo commands and drag positions under filters;
- Mind Map marquee selection (skips collapsed frames);
- hotkeys while a dialog is open;
- right-click on card text;
- the sidebar name search and drag-into-folder;
- the raw view;
- the template parser.

From the data-layer agent: the sentinel coalescing (the Phase 7 fix), the parked-write bookkeeping, rename-after-IPC, `fileWatcherOwnMoves`, `board:save` without folder creation, the six-at-a-time tag sweep, and resume of an interrupted tag rename.

---

## 2. Is the 1,000-line gate hindering changes?

**Short answer: no. It has never stopped a change I needed to make, but it has costs worth fixing.**

What the gate is: no source file in `src/main` or `src/renderer` may exceed 1,000 lines. Six older files are allowed over it, but may only shrink (`scripts/gates/codebase.mjs:12-23`):

| File | Lines |
|---|---|
| TaskListBoard.svelte | 1,932 |
| TaskItem.svelte | 1,479 |
| vault.svelte.ts | 1,460 |
| KanbanSideToolbar.svelte | 1,439 |
| KanbanBoard.svelte | 1,416 |
| KanbanColumn.svelte | 1,170 |

**Where it helped.** Forced splits have mostly produced sensible modules:
- `noteDiskChanges.ts` out of `notes.svelte.ts` (Audit-24);
- `sidebarOrder.svelte.ts` out of `vault.svelte.ts` (Audit-24);
- `writeSchedulerParked.ts` out of `writeScheduler.ts` (Audit-26).

**Where it costs.**
1. **"Line-neutral" edits in the six allowlisted files.** Audit-25 kept `vault.svelte.ts` and `TaskItem.svelte` changes line-neutral, and Audit-26 notes that KanbanColumn changes "must swap lines in place". That pressure shows as squeezed code: `KanbanColumn.svelte:583` puts three statements in one `onclick` on one line, and `KanbanSideToolbar.svelte` has 16 lines over 140 characters. These are the most complex UI files, where readability matters most.
2. **Code goes where there is room, not where it belongs.** A26-18's resume logic went into `tagUndo.svelte.ts` partly because `vault.svelte.ts` "may only shrink".
3. **Comments count.** CLAUDE.md requires comments that explain the why, and in the safety-critical files they are a third of the lines:

   | File | Comment lines |
   |---|---|
   | fileWatcher.ts | 352 of 963 (37%) |
   | writeScheduler.ts | 314 of 947 (33%) |
   | vault.svelte.ts | 505 of 1,460 (35%) |

   The gate rewards deleting exactly the comments that stop the next audit from re-breaking an invariant.
4. **The next forced splits will land in the riskiest code, under time pressure.** Ten files sit at 900–999 lines:

   | File | Lines |
   |---|---|
   | TaskListSideToolbar | 979 |
   | noteWriter | 963 |
   | fileWatcher | 963 |
   | MindMapBoard | 949 |
   | writeScheduler | 947 |
   | history | 939 |
   | Frame | 935 |
   | notes.svelte | 929 |
   | boardLoader | 919 |
   | VaultFileItem | 919 |

   The next fix in the note writer or the scheduler will have to split a tightly coupled state machine mid-bugfix. `writeSchedulerParked.ts` already reaches into the scheduler's internals, and F-01 / F-02 live exactly in that seam.

**Recommendations, scored on the same scale:**

| Change | Useful | Hard |
|---|---|---|
| Count only **code lines** against the limit: exclude blank and comment-only lines, keep 1,000 as the number. Complexity stays capped and documentation stops being penalised; on that count `fileWatcher.ts` is about 550 lines of code, not 963. | 6/10 | 1/10 |
| Plan splits of the ten 900+ files along their natural seams *before* an urgent fix lands there. | 5/10 | 5/10 |
| One dedicated refactor pass on the six allowlisted files instead of piecemeal shrinking (see below). | 4/10 | 6/10 |

For the refactor pass, for example:
- `TaskListBoard`: section drag-and-drop and the shortcut table out;
- `KanbanSideToolbar`: the Saved View and Manage Columns dialogs as their own components;
- `vault.svelte.ts`: the startup recovery prompts apart from open / close.

---

## 3. Known limitations, one by one

Every open entry has two scores out of 10 (see "How to read the scores" at the top):
- **Useful**: what fixing or changing it would be worth to you.
- **Hard**: how much work that change is.

A low Useful score usually means the limitation is the right trade-off and should stay. #8, #9 and #16 are closed and not scored.

The other columns:
- **Verdict.** Keep = correct trade-off, leave it. Improve = small and worthwhile. Fix = should be done. Later = worthwhile, but a bigger job.
- **Kind.** Arch = a code-design matter, no library needed. Lib = a library or framework would genuinely help. Platform = a Windows / operating-system limit.

All constants and claims spot-checked against the code match. The exceptions are #4 (see F-03) and #17 (see U-03).

| # | What it means | Verdict, and the change scored | Kind | Useful | Hard |
|---|---|---|---|---|---|
| 1 | A metadata edit on unusual frontmatter (anchors, `{ }` maps, a changed nested list) rewrites that block in a standard style; comments inside it can go. Values never change: an edit that would change one is refused. | Keep. Change scored: keep comments inside changed nested blocks too. | Lib limit (the `yaml` package already is the right tool) | 1/10 | 8/10 |
| 2 | Tags on images and PDFs live only in `.filo/tags.json`, so they're lost if the file leaves the vault without `.filo/`. | Keep. Change scored: write tags into the media file itself (XMP / ID3), which modifies your media, so not advised. | Arch (no sidecar files, by design); the change needs a library such as exiftool | 2/10 | 7/10 |
| 3 | A power cut in the instant after a rename could in theory lose that rename (never file contents). | Keep. Change scored: a native add-on to flush the folder on Windows. | Platform | 1/10 | 6/10 |
| 4 | A frozen quit gives up after 5 s of silence (60 s total), a Windows shutdown after ~4 s; leftover work is flagged for recovery. | Keep (but fix F-03 so the promise in it holds). Change scored: waiting longer, which Windows doesn't allow. | Platform | 1/10 | 9/10 |
| 5 | Filo recognises its own saves of `.filo/` settings files by timing. A very slow disk can trigger a needless Reload / Keep local, and another program's edit of a settings file within ~7 s of a Filo save shows only at Filo's next write (still never overwritten). | Improve: reuse the byte-matching boards already have. | Arch | 3/10 | 3/10 |
| 6 | The minimap redraws every tile on every drag frame; large boards can stutter while dragging. | Fix when convenient: give unchanged tiles a stable identity (also speeds up connections). | Arch | 4/10 | 5/10 |
| 7 | An outside rename of a very small (<256 B) or very large (≥10 MB) attachment isn't followed; its tiles show as missing until relinked. | Improve: pair moves by the NTFS file ID (Node's `fs.stat` gives it), exact at any size. Doesn't help Syncthing deliveries. | Arch | 3/10 | 5/10 |
| 10 | An Iframe tile can embed any `https://` site, sandboxed with no access to your vault. | Keep. Change scored: an allowlist setting. | Security trade-off | 1/10 | 2/10 |
| 11 | A save can be refused for a few seconds after another program removed a note's frontmatter, if the note now starts with `---`. Loud, and retried. | Keep (it fails safe). Change scored: telling that case apart from a half-written file. | Arch | 1/10 | 7/10 |
| 12 | You can't drag a task back into an empty "Unsectioned" area above the first section. | Improve: a thin drop strip shown only while dragging. | Arch (svelte-dnd-action can do it) | 3/10 | 3/10 |
| 13 | `completed:` counts as done only for true / yes / on. | Keep. Change scored: accepting more words (`done`, `x`, `1`). | Arch | 1/10 | 1/10 |
| 14 + 15 | Board and settings saves lack the final "did the file change since I read it?" check in the main process that notes have; a window of a few milliseconds. | Improve together: reuse the notes' `expectStat` compare-and-swap; the building block exists. | Arch | 2/10 | 4/10 |
| 17 | Notes Filo can't save faithfully open read-only: HTML comments and blocks, `[1]: url` reference links, code inside bold or links, tight mixed bullet / checklist lists. Other apps' Markdown is restyled on the first edit. | Later: keep such blocks as verbatim "raw" blocks, so the rest of the note stays editable. | Lib + Arch (the editor pipeline; see #32) | 7/10 | 6/10 |
| 17b | Bare URLs in a note aren't clickable. | Improve: clickable bare URLs that stay bare on save. | Arch | 5/10 | 4/10 |
| 18 | Only English sync-conflict names are recognised. Syncthing's `.sync-conflict-` names are, which is your client. | Keep. Change scored: adding other languages' names. | Arch | 1/10 | 2/10 |
| 19 | A rename to a name that looks like a conflict copy isn't followed. | Keep; #7's file-ID pairing would fix it properly. | Arch | 2/10 | 5/10 |
| 20 | Every machine opening a synced vault must run the same Filo build. | Improve cheaply: each machine records its version in `.filo/`; a mismatch warns. You use one machine today. | Arch | 3/10 | 2/10 |
| 21 | Non-UTF-8 notes are read-only; "Convert to UTF-8" assumes Windows-1252. | Improve: let you pick the encoding. Chromium's built-in TextDecoder already handles UTF-16, Latin-2, Cyrillic and others; no new library. | Arch | 2/10 | 2/10 |
| 22 | Paths deeper than 64 folders or longer than 4,096 characters are refused. | Keep. Change scored: raising the limits. | Arch | 0/10 | 1/10 |
| 23 | A whole number above 2^53 in a board makes it invalid. | Keep. Change scored: big-number support. | Arch | 0/10 | 7/10 |
| 24 | Filo's trash is in the vault, so it syncs and uses space for 30 days. | Improve: a retention choice (7 / 30 / 90 days) and the total size in Settings → Trash. | Arch | 3/10 | 2/10 |
| 25 | Emptying the trash on a FAT32 stick or network drive may delete for good (untested there). | Improve: warn when the vault isn't on a local NTFS drive; probe once. | Platform | 2/10 | 3/10 |
| 26 | Merging two tags can't be undone. | Keep (it's confirmed first). Change scored: recording enough to split a merge back. | Arch | 3/10 | 5/10 |
| 27 | Undoing a tag delete may move the tag to the end of a note's list. | Keep (cosmetic). Change scored: putting it back in its old position. | Arch | 1/10 | 3/10 |
| 28 | Undo of a vault-wide tag delete or rename is only on its notification, for 15 s. | Improve: keep that notification until you dismiss it. | Arch | 5/10 | 2/10 |
| 28b | (same) | Bigger option: a "recent vault changes" list with Undo. | Arch | 6/10 | 6/10 |
| 29 | Only the current board format (v8) loads; older or newer is refused. | **Fix before the board format next changes.** Your boards are now real data, so a future build must convert them, not refuse them. Add a tested migration step (`migrations.ts` is the scaffold). | Arch | **8/10** | 4/10 |
| 30 | The Raw view saves the whole file, and only over the version it started from. | Keep (design). Change scored: merging raw edits with outside changes. | Arch | 2/10 | 6/10 |
| 31 | An outside move is followed only if its two halves arrive within ~1.5 s. | Improve: file-ID pairing (#7) for local moves; measure Syncthing's timing. | Arch | 3/10 | 5/10 |
| 32 | `tiptap-markdown` writes every note body; it is old, little-maintained, and Filo patches it in a dozen places. | **Later, strategic. Step 1:** write through `prosemirror-markdown` + markdown-it directly (Filo already swaps in its serializer state). | **Lib** | 6/10 | 6/10 |
| 32b | (same) | **Step 2:** a source-preserving editor, where the Markdown text is the document (CodeMirror 6 live preview, Obsidian's model). Removes read-only notes, the restyle-on-first-edit table and most editor-fidelity code. | **Lib / framework** | **9/10** | **9/10** |
| 33 | Rescue copies in `.filo/recovery/` are never deleted automatically. | Improve: Settings → Recovery listing them with sizes and Delete. | Arch | 3/10 | 3/10 |
| 34 | A hard-linked note isn't detected (a save splits it from its twin). | Improve cheaply: Node reports a link count; above 1, open read-only like a symlink. | Arch | 1/10 | 2/10 |
| 35 | An attachment's tags are dropped if its file is missing when the vault opens. | Improve: drop only after it is missing at two opens, or for a week. | Arch | 3/10 | 3/10 |
| 36 | Notes over 2 MB are checked for outside changes by date and size only. | Improve trivially: raise the hash limit (hashing 16 MB takes milliseconds). | Arch | 1/10 | 1/10 |
| 37 | A board that only loads in a later session keeps links to files renamed meanwhile (Re-link fixes them). | Keep. Change scored: a saved rename journal. | Arch | 3/10 | 6/10 |
| 38 | Camera positions and the sidebar order are saved best-effort. | Keep. Change scored: treating them as unsaved work at quit. | Arch | 1/10 | 2/10 |
| 39 | A Kanban card shows a static preview until its editor loads. | Keep (it made 300-card boards usable). Change scored: loading every editor at once, which brings back the 20 s freeze. | Arch | 1/10 | 4/10 |
| 40 | A folder of thousands of notes fills in over about a second. | Keep. Change scored: a windowed sidebar with new drag-to-reorder. | Arch | 2/10 | 7/10 |
| 41 | Plain text pasted is read as Markdown; Ctrl+Shift+V pastes literally. | Keep, but fix U-03. Change scored: literal paste by default. | Arch | 1/10 | 1/10 |
| 42 | A file dropped from Explorer by a short (8.3) or junction path is copied instead of linked. | Improve cheaply: resolve the real path in main, one call per drop. | Arch | 1/10 | 2/10 |
| 43 | An Undo taken from a notification can't be redone. | Keep. Change scored: redo after a notification Undo. | Arch | 1/10 | 5/10 |
| 44 | Old `parent:` lines in notes from older builds are read, never removed. | Keep. Change scored: removing them automatically. | Arch | 1/10 | 3/10 |
| 45 | Deleting an Audio tile while it records leaves the recording unlinked (named in a notice). | Keep. Change scored: re-linking the recording on undo. | Arch | 1/10 | 5/10 |
| 46 | Board Browser rows are buttons with buttons inside, awkward for screen readers. | Fix in a UI pass. | Arch (accessibility) | 2/10 | 3/10 |
| 47 | Small grey text in the Light theme is 3.7:1 contrast, under the 4.5:1 guideline. | Fix (your palette call): e.g. `#6b7075` gives about 5:1 on white. | Theme colour | 4/10 | 1/10 |
| 48 | Replace All leaves matches inside Markdown syntax alone. | Keep, but fix U-04, which undermines its own motivating example. Change scored: an option to replace inside syntax too. | Arch | 1/10 | 2/10 |

### Library or framework, or architecture?

- **Only #32, and #17 with it, is a real library question.** The fragile part is `tiptap-markdown`.
  - Replacing it with `prosemirror-markdown` driven directly: Useful 6/10, Hard 6/10.
  - Moving to an editor whose document *is* the Markdown text (CodeMirror 6 with live preview): Useful 9/10, Hard 9/10. It is the one change that makes this whole class of problems disappear rather than be patched.
- **#2 and #21 could use a library but don't need one.** #21's encodings are already in the browser engine, and #2 would mean writing into your media files.
- **Everything else is architectural or a platform limit.** No library would remove them; they are design decisions or small missing features.

### What I'd do first

| Order | What | Useful | Hard |
|---|---|---|---|
| 1 | Bugs F-01 (with F-02) | Impact 7/10 | 4/10 |
| 2 | Bugs U-01 and U-04 | Impact 5/10 each | 2/10 each |
| 3 | #29 migration scaffold, before the next board-format change | 8/10 | 4/10 |
| 4 | Count only code lines in the line-limit gate | 6/10 | 1/10 |
| 5 | #28 keep the tag Undo notification until dismissed | 5/10 | 2/10 |
| 6 | #47 contrast | 4/10 | 1/10 |
| 7 | #36 raise the hash limit | 1/10 | 1/10 |
| 8 | #34 hard-link check | 1/10 | 2/10 |
| 9 | #32 Step 1, when you next touch the editor: the biggest long-term fidelity win | 6/10 | 6/10 |

---

## Housekeeping

- Pushed `db1af24..abf5212` to `origin/main`. GitHub's Linux CI run for it was in progress when this report was written.
- No app source, test or config changed. The throwaway tests (`zzA27_*`, `zzA27R_*`) were removed from the repo. Copies are in this session's scratchpad.

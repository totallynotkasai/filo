# Audit-26: pre-daily-use audit (2026-09-30)

Audited: `main` @ `db1af24` (all of Audit-25 included).

Owner's setup:
- Windows 11, one machine;
- the vault synced by Syncthing, with no other editors touching it;
- all four board types in use;
- 500–5,000 notes, prose-heavy.

Plan: [AUDIT26_IMPLEMENTATION_PLAN_2026-09-30.md](AUDIT26_IMPLEMENTATION_PLAN_2026-09-30.md).

**Status (2026-10-01): all seven phases of the plan are done.** Every finding below is fixed, listed in KNOWN_LIMITATIONS, or named as still open in the plan's Phase 7 outcome; the "After fixes" column of the ratings has the scores reached (overall 9). The "If you start now" list at the end no longer applies. Phase 7's checks are recorded in the plan.

## Verdict

Filo is genuinely good, and safe to start using for your notes. The owner's impression from scratch testing ("felt pretty good") is right.

In normal use I found no way for Filo to lose the words in a note:
- Every save is applied to a fresh read of the file, and the main process refuses it if the file changed in between.
- Changes made by Syncthing are taken in, or asked about.
- Deletes go to Filo's trash.
- A note Filo can't save faithfully opens read-only instead of being rewritten.

A scripted day of use on a generated 5,000-note vault confirmed this byte by byte:
- edits in every view;
- a 1,484-note tag rename and its undo;
- Replace All and its undo;
- a 1,107-note folder rename;
- delete and undo;
- a Syncthing delivery;
- quit and relaunch.

The relaunch changed nothing by looking.

What is not yet right, in the order you'd meet it:

1. **Boards around folder renames (the one High).** If Windows refuses a folder rename, Filo says "Failed to rename" but has already saved the boards pointing at the new name. This happens when a file inside the folder is open in another program. The next day those cards and tiles show as missing. The notes themselves are untouched.
2. **Renaming a big folder makes Filo busy for about a minute.** It re-processes every moved file once more about 30 seconds later. During that time an undo of a delete brings the note back at once but its card only after about 40 s, and quitting waits silently. Killing Filo during that wait loses the card's place on the board.
3. **A few formatting actions write Markdown Filo can't read back.** The note then opens read-only on its next visit:
   - aligning a list item that has sub-items;
   - bold or italic on a selection that starts at the end of a line inside a quote, heading or table cell.

   No words are lost.
4. **Common Markdown from Keep or Obsidian opens read-only, without saying why:**
   - a list, heading or code block directly under a line of text;
   - a bare link at the end of the first paragraph.
5. **Smaller interface bugs:**
   - the Kanban `/` find misses most cards (a regression from Audit-25's speed work);
   - Ctrl+Z and Ctrl+W act on the board behind an open dialog;
   - the sidebar name search hides its matches inside closed folders;
   - Replace All also changes Markdown markup, such as list dashes or `---` breaks.

You can start now. Follow the "If you start now" list below until Phase 1 of the plan lands.

## Ratings (1–10)

| Area | Score | Why | After fixes | What changed |
|---|---|---|---|---|
| Notes: write safety | 9 | Fresh read per write, main-side stat and hash check, one conflict prompt, own-write echo by hash, exclusive creates, trash for deletes. Nothing found that loses note text. | 9 | Unchanged. |
| Boards: write safety | 8 | Drift holds, forward-only baselines and the unverified-board check all held up. The stray board of N16 is now explained (A26-03). | 9 | Board links change only after a rename succeeds; `board:save` never creates folders (Phase 1). |
| Renames, moves, trash and their undo | 6 | Trash, restore and delete-undo are byte-exact. But a failed rename leaves boards pointing at the wrong name (A26-01), and a big rename floods the queue (A26-02). | 9 | A refused rename changes nothing; Filo's own moves no longer echo; a delete's card is back in 0.7 s after a 1,107-note rename (Phases 1, 6). |
| Sync and outside changes (Syncthing) | 8.5 | Syncthing temp files, `.stversions`, conflict copies and old-mtime deliveries are all handled (E2E and the 5,000-note pass). Deliveries wait behind the rename flood (A26-02). | 9 | No rename flood for deliveries to wait behind (Phase 1). |
| Open / close / quit / crash recovery | 8 | Mature. Quit waits silently behind a slow undo (A26-02). Most Windows shutdowns briefly show "preventing shutdown" (A26-20). | 9 | Quit in 0.2 s after the day of use, no stale sentinel (Phase 7 fix); no "preventing shutdown" for a caret (Phase 6). |
| Editor: nothing lost | 8 | Untouched notes save byte-identical or open read-only. Two formatting actions write broken Markdown (A26-04/05), but it opens read-only rather than losing words. One rare case is silent (A26-11). | 9 | The formatting actions that wrote broken Markdown are fixed (Phase 2). |
| Editor: notes open editable | 6.5 | Everyday Keep and Obsidian shapes still open read-only, and the banner can't say why (A26-06). | 8.5 | Keep and Obsidian shapes open editable, and the banner names a line (Phase 3). |
| Frontmatter | 9 | Every shape tried is preserved byte for byte or correctly refused. The task tick in the real app changed only `completed:` and kept a hand-written comment. | 9 | `completed: yes` / `on` / `"true"` read as done (D9). |
| Undo / redo | 7 | Careful design. Delete-undo is slow after a big rename (A26-02), undo sits on the active board only (A26-14), shortcuts act behind dialogs (A26-09), and an empty key can go on undo (A26-25). | 8.5 | A sidebar delete's undo is on its toast and Settings → Trash; shortcuts no longer act behind dialogs (Phases 4, 5). |
| Tags and search | 7.5 | Tag rename is byte-exact, but slow: 116 s for 1,484 notes, and it blocks renames meanwhile (A26-15). Replace All is exact and undoable but edits markup (A26-07). | 8.5 | Tag rename of 1,484 notes in 23 s (was 116 s), not blocking renames; Replace All leaves syntax alone (Phase 5). |
| Mind Map | 8 | Solid. Two missing pointer-cancel handlers (A26-28). | 8.5 | Pointer-cancel handlers added; right-click on tile text gives the tile menu (Phase 4). |
| Kanban | 7 | Opens 30 cards in 0.13 s; drag, undo and disk agree. The find bar and a right-click focus bug regressed with lazy editors (A26-08, A26-13). | 8.5 | Find reads every card; right-click fixed; a deleted card comes back from anywhere (Phases 4, 5). |
| Task List | 8.5 | Quick add, indent, tick and undo all wrote the right bytes in the built app. | 8.5 | Unchanged. |
| Document tab and sidebar | 7.5 | Sidebar search hides matches (A26-10). The blank line after the frontmatter goes on first edit (A26-16). | 8.5 | Name search shows its matches; the blank line after the frontmatter is kept (Phases 3, 4). |
| Settings, themes, templates | 8 | Apply / Revert writes only what changed. Nothing found. | 8 | Unchanged. |
| Accessibility and keyboard | 6.5 | Good base. A26-09 and A26-26, plus N12 / N13 still open. | 7 | Dialogs and the Board Browser fixed; KL #46 / #47 still open. |
| Performance at 5,000 notes | 8 | Vault opens in 1.0 s; all E2E scale budgets pass. Tag rename and the rename flood are the slow spots. | 8.5 | Tag rename 5× faster; no rename flood; scale budgets pass. |
| Code health | 8.5 | Very little dead code, every dependency used, no TODOs. Six files are allowlisted over 1,000 lines. | 8.5 | Dead code removed; the six allowlisted files remain. |
| Docs accuracy | 8 | CLAUDE.md's tree and gate count are exact. A few stale KNOWN_LIMITATIONS entries (#13, #17, #32, #41, #46) and five missing files. | 9 | The stale KNOWN_LIMITATIONS entries and CLAUDE.md lines fixed (Phase 6). |
| Tests and gates | 8.5 | 7,181 tests and 89 gates green, and an E2E suite on the built app. Some text-pattern gates can be sidestepped, and the property test compares text, not documents. | 9 | Four gates tightened; the property test compares documents; 7,394 tests. |
| **Overall** | **8** | Data integrity is about 9 for notes and about 7 for boards around renames. Day-to-day use is about 7.5. | **9** | All seven phases done; verified in Phase 7 (below). |

## How this was audited

- **Baseline on Windows.** `npm run ci:verify` passed: lint, svelte-check (0 errors), main type-check, 7,181 tests passed (5 skipped) in 766 files, build, and 89/89 gates.
- **E2E on the built app.** `FILO_E2E_SCALE=1 npx playwright test`: 25/25 passed in 2.6 min, including the 5,000-note scale budgets.
- **Agents.** Three finders:
  - A: data integrity, lifecycle, Syncthing;
  - B: editor fidelity, frontmatter, tags, undo;
  - C: UI, performance, code health, docs, gates.

  Plus one **refuter**, which re-ran every Medium-or-above repro and tried to knock each finding down. None spawned helpers. Experiments ran in a scratch worktree; the repo was never touched.
- **Real-app pass.** A scripted day of use on a generated 5,000-note vault. It included hand-written CRLF, BOM, comment and prose notes, and ran over two launches. Script and outputs: session scratchpad `sim/` (`sim.pass.ts`, `delundo.pass.ts`, `report*.json`).

Results of the real-app pass:

| Step | Result |
|---|---|
| Open 5,000 notes | Workspace in 1.0 s, no console errors |
| Kanban card edit (BOM + CRLF + comment note) | BOM, CRLF and every frontmatter byte kept. Only the typed text changed, plus the blank line after the frontmatter (A26-16) |
| Task List tick, then Ctrl+Z | Only `completed: false → true` changed, the inline comment kept; undo byte-identical |
| Tag rename `idea → concept` (1,484 notes), then Undo | Only the tags line changed in each; no other file touched; undo restored all 1,484 byte-identical. 116 s and 58 s (A26-15) |
| Replace All (25 notes), then Undo | Exactly the replacement; undo byte-identical |
| Folder rename `Notes/Deep → Notes/Deeper` (1,107 notes on the Mind Map) | All moved, board links re-pointed, no folder resurrected |
| Sidebar delete of a Kanban card's note, then Ctrl+Z | Byte-identical restore; card back at once, except 40.6 s after a big rename (A26-02) |
| Syncthing-style delivery to a card's note | Shown on the card, never written back |
| Quit and relaunch | No recovery prompt; **zero bytes changed by looking** |
| A Keep-style note | Opened read-only with no line named (A26-06) |

## Findings

IDs are A26-nn. Severity follows the refuter's verdict: Critical, High, Medium or Low. The source column maps each back to the finder IDs in the scratchpad reports.

### High

**A26-01. A rename or move that Windows refuses leaves boards on disk pointing at the new name.** *(FA-01; confirmed twice)*
- **What happens:**
  1. You rename or move a folder (or a file) in the sidebar.
  2. Filo rewrites every board's links to the new name, and saves them 300 ms later, **before** asking Windows to do the rename.
  3. If Windows refuses (a file inside is open in another program, Explorer's preview, Defender or Syncthing holds it), Filo retries for about 5 s, then shows "Failed to rename".
  4. It puts its memory back but doesn't save the boards again, and nothing counts as unsaved.
  5. After a restart, those cards and tiles show as missing.
- **Also:** the revert swaps the whole board cache back to its pre-rename copy, so a board edit made during those seconds is silently undone.
- **Why it matters:** on NTFS any open handle to a file inside a folder blocks the folder's rename (verified), so one PDF open in a viewer is enough.
- **Workaround:** if a rename says "Failed to rename", do the same rename again once the file is closed.
- **Where:**
  - `stores/vaultFolderOps.ts:253-273` (links rewritten before the IPC) and `:342-373` (a memory-only revert);
  - `stores/boardCacheFrontmatter.ts:46-52`.

### Medium

**A26-02. After renaming a big folder, Filo is busy for about a minute; an undo of a delete then brings the card back ~40 s late, and quitting waits silently.** *(M5 + R-01; real app + unit test)*
- **Cause:**
  1. The main process hides its own rename from the watcher for only 5 s.
  2. It never tells the 30-second background check (the reconcile walk) that the files moved.
  3. So the next walk reports every file in the folder as "renamed by another program": 1,107 separate events, each running the full rename cascade over every board, about 36 ms each.
- **Knock-on effects:**
  - An undo of a delete (and of "delete tile and file" on any board) restores the file first. It then waits for that whole queue before putting the card back: 40.6 s measured.
  - Board edits made meanwhile queue behind the undo.
  - A normal quit waits for it and saves the card, but shows nothing for up to a minute.
  - Killing Filo, a Windows shutdown or a crash during that wait loses the card's place. The note is safe. This was reproduced.
  - Syncthing deliveries also wait behind the flood.
- **Where:**
  - main's reconcile snapshot is not re-keyed on `vault:rename`;
  - `stores/trash.svelte.ts:58-71` (`syncAfterRestore` awaits the rename queue before the undo re-adds placements);
  - `commands/groupAndBoardCommands.ts:415-440`.

**A26-03. A slow rename of a board's folder can leave a stray duplicate board that loads instead of the real one.** *(FA-02 = known N16, now proven)*
- **What happens:** with board-specific folders on, the board's write lands at the new folder before the folder is renamed, and `board:save` creates that folder. The real rename then fails ("TARGET_EXISTS").
- **After a restart:** the stray copy wins the duplicate-id tie-break, so the board opens with every card missing. A warning toast appears both times, and nothing is deleted.
- **Also:** Windows reports a rename onto an existing folder as EPERM, which Filo treats as a lock, so every real name clash waits 5 s (R-02).
- **Where:** `lib/boards/boardWriteScheduler.ts:270-272`, `main/vault/boardFileOps.ts:49-54`.

**A26-04. Centring, right-aligning or indenting a list item that has sub-items breaks the list in the file.** *(FB-01)*
- **What happens:** the item is written as `- <p style=…>…</p>`, and its sub-items become raw text inside that HTML. On the next open the sub-items show as a literal `-` line, and the note is read-only. An aligned checklist item's text is also read as Markdown (a `\` or `__x__` in it changes).
- **Where:** `lib/editor/createEditor.ts:180-183`, `lib/editor/blockLayout.ts:31-45`.

**A26-05. Bold, italic or strike applied to a selection that starts at the end of a line corrupts quotes, headings and table cells.** *(FB-02)*
- **What happens:**
  - `> Name: Aria` / `> Age: 24`, then Shift+Down from the end of line 1 and Ctrl+I, saves as `*> Age: 24*`.
  - A heading or table cell saves as `Title<**br>Sub**`.
  - The next open shows a literal `>` or `<br>` and is read-only.
- **Recency:** the heading and cell form came with Audit-25 Phase 1; the soft-break form with Phase 9.
- **Where:** `lib/editor/softBreak.ts:78-98`, `lib/editor/tableMarkdown.ts:111`.

**A26-06. Common Markdown from Keep or Obsidian opens read-only, and the banner can't say why.** *(M1 + FB-07 + FB-06 + R-04)*
- **Shapes that open read-only:**
  - `Todo:` directly above `- [ ] one`;
  - `# Title` directly above text;
  - text directly above a heading, list, quote or code fence;
  - a `***` break with no blank lines around it;
  - lists numbered `1. 1. 1.`;
  - a bare URL as the last word of the note's first paragraph (autolink runs on load);
  - an image path with a space.
- **Why:** for most of these the only change is a blank line Filo would add. The round-trip check doesn't treat that as cosmetic, and `roundTripChanges` returns nothing. So the banner names no line, Raw view opens at line 0, and Take ownership lists nothing. KNOWN_LIMITATIONS #17 lists none of these shapes.
- **Where:** `lib/editor/markdownSync.ts:300-372` (`normaliseForRoundTripCompare`, `roundTripChanges`).

**A26-07. Replace All changes Markdown markup too.** *(FB-05)*
- **What happens:** it matches and splices the raw file text.
  - Replacing ` - ` with ` – ` hits nested list markers.
  - Replacing `--` with `—` hits `---` scene breaks and table rows.
  - A word also inside a link address or colour style is replaced there too.
- **Safety:** exact and undoable (checked), but it can change a note's structure, and the confirm doesn't show that.
- **Where:** `lib/search/runSearch.ts:352-405`, `commands/replaceAllCommand.ts:115-190`.

**A26-08. The Kanban `/` find misses most cards.** *(FC-01; regression from Audit-25 Phase 2)*
- **What happens:** the find reads only notes whose card editor has mounted, so cards further down never match their text. After one find, even mounted ones drop out. Titles still match.
- **Where:** `lib/kanban/kanbanFiltersAndSort.svelte.ts:86-88` (use `noteBody(path)`).

**A26-09. Ctrl+Z, Ctrl+W and other app shortcuts act on the board behind an open dialog.** *(FC-03)*
- **What happens:** with the Tags Browser open, Ctrl+Z undid a Kanban change you couldn't see, and Ctrl+W closed the board's tab. Only Settings blocks shortcuts.
- **Where:** `core/hotkeys.ts:95-116`, `components/layout/AppShell.svelte:203-440`.

**A26-10. The sidebar name search leaves its matches inside closed folders.** *(FC-05)*
- **What happens:** searching "invoice" shows only the closed "Projects" folder. The tag filter opens folders; the name search doesn't.
- **Where:** `lib/vault/vaultTreeSort.ts:136`, `stores/sidebarTagFilter.svelte.ts:66-69`.

### Low

| ID | What | Source |
|---|---|---|---|---|
| A26-11 | Silent literal `**`. A note starting with a bold run that ends in punctuation right before a letter (`**A)**Answer`), or a mark on one punctuation character (`a,*b`), saves with stray asterisks, and the note does **not** open read-only. Rare shapes. KL #32 and N1 claim these open read-only. | FB-03 |
| A26-12 | `01.` or `01)` typed at a line start after Shift+Enter or in a one-line-per-thought note becomes a numbered list; the note opens read-only. `textEscapes.ts:103` escapes only `1`. | FB-04 |
| A26-13 | Right-clicking a Kanban card before its editor loads: the editor steals focus from the menu a frame later, so ↓ / Enter type into the note (an undoable blank line). | FC-02 |
| A26-14 | A sidebar delete's undo lives on the board that was active, with no toast. Ctrl+Z on the board that held the card undoes something else; Settings → Trash brings back the file but not the card. | M4 |
| A26-15 | A vault-wide tag rename holds the drain for its whole run: 116 s for 1,484 notes, and renames, deletes and restores wait. Byte-exact. | M3 |
| A26-16 | The first body edit removes the blank line after the frontmatter, even in notes Filo created (cosmetic diff). | FC-06 = M2 |
| A26-17 | A board created during a sidebar refresh can be marked "not loaded" for the session (false warnings). | FA-03 |
| A26-18 | Resuming a crashed tag-rename **undo** re-renames every attachment, tile and filter chip, not just the planned ones. | FA-04 |
| A26-19 | `flush(key)` can report "saved" while that board's write still waits in a concurrent full save. A board deleted right then loses its last edit from the Undo copy. | FA-05 |
| A26-20 | A focused note editor alone counts as "may lose work", so most Windows shutdowns briefly show "Filo is preventing shutdown". | FA-06 |
| A26-21 | Keep local on a held settings file doesn't re-fire the write if a corrupt config failed in the same save (not lossy). | FA-07 |
| A26-22 | Turning a one-line-per-thought paragraph into a code block glues the lines (`onetwo`); visible and undoable. | FB-08 |
| A26-23 | A pasted or imported nested numbered list starting at a number other than 1, directly under its parent's text, merges into the parent as text (silent; paste or import only). | FB-09 |
| A26-24 | Editor cosmetics: adjacent same-kind lists gain an empty paragraph; a `0.` list saves as `1.`; Enter in a soft-break line leaves `<br data-filo-soft-break>`; plain paste writes `\` line ends; a nested list holding a rule, code or quote reloads loose. | FB-10/11/12/14/16 |
| A26-25 | Undoing a field edit deletes a key that was present but empty (an Obsidian template's `status:`). | FB-13 |
| A26-26 | In the Board Browser, Enter on a row's Rename or Delete button opens the board instead (KL #46 says the keyboard works). | FC-04 |
| A26-27 | With the Search panel open and a query typed, every autosave re-runs the vault search (about 75 ms at 5,000 notes). | FC-07 |
| A26-28 | The Kanban checklist badge counts any `[x]` in the note. Mind Map box-select and connection-label drag lack `pointercancel`. | FC-11, FC-12 |
| A26-29 | *Unverified.* A `filo://` media stream may hold a handle inside its folder while a Video or Audio tile is on screen, which would trigger A26-01 on a rename. One built-app check settles it. | R-03 |

Hygiene (no user impact today):
- **Gate blind spots (FC-08):**
  - `no-global-index-version` misses `allMetadata()`;
  - `component-timer-cleanup` misses an untyped timer;
  - `enter-keeps-the-key` misses `"Enter"` in double quotes;
  - `toast-plain-language` misses a message passed as a variable.
- **Property test (FB-15):** it compares Markdown text, never documents, which is why A26-11 / 23 / 24 stayed silent.
- **Stale docs (FC-09, R-04):**
  - KL #13 (`completed: yes` reads as a string, so the task shows not done);
  - KL #6 (stale, with audit narration);
  - #17 (A26-06's shapes, the image-path space);
  - #32 (A26-11);
  - #41 (paste `\`);
  - #46 (A26-26);
  - CLAUDE.md: MiniSearch `query()` has no caller, the example IPC names are not real, link-tile previews are a network call, and five Phase 2 files are missing from the tree.
- **Dead code (FC-10):**
  - `VaultIndex.query()` and its MiniSearch index, and `filesByTag`;
  - `boardStore.clearCache` / `updateCacheEntry`;
  - the store-level `toggleWaypointLock`;
  - the unused **`dialog:confirm` IPC channel** (attack surface);
  - about ten test-only exports;
  - two unused CSS rules.

## Checked and fine

These held up under the finders, the refuter or the real app:

- **The note writer:**
  - fresh read per flush;
  - main-side stat check (plus content hash up to 2 MB) before every rename attempt, including during the Windows lock back-off;
  - Reload / Keep mine on body drift;
  - own-echo by hash;
  - torn and cut-short reads read again;
  - no recreating a deleted note, links refused, exclusive creates, queued writes follow renames.
- **Frontmatter:**
  - titles with colons, quotes, `#` or `---`;
  - bare keys, duplicate keys (refused), `02134`, block scalars, comments, CRLF + BOM;
  - the tag rewriter keeps the body byte-identical.
- **Audit-25's recent work:**
  - Phase 2: the vault index can't be overwritten by a slow read, per-key reactivity hides nothing from save or quit, lazy editors can't be typed into before the note loads, previews never write.
  - Phase 4: board and settings drift holds, the unverified board, board delete rescue, Windows session end.
  - Phase 5: unloaded-board tabs, the midnight clock, subtask parents, right-click hit test.
  - Phase 6: the factory merge dropped nothing.
  - Phase 9: soft breaks and minimal escapes in ordinary Keep-style notes.
- **Syncthing:**
  - `~syncthing~*.tmp` / `.syncthing.*.tmp`, `.stversions`, `.stfolder` and `.stignore` are ignored everywhere;
  - conflict copies (boards included) are recognised and never paired as renames;
  - old-mtime deliveries are detected;
  - a delivery to an open, unedited note or board shows and is never written back.
- **Leave and quit:** save until settled, rescue copies before "anyway", late changes kept, bounded drains.
- **Path security:** 8.3 names, junctions and symlinks; `.filo/` guards; the blind writer limited to sentinels.
- **Recurrence:** month-end clamping, Feb 29, long-overdue catch-up.
- **Code health:** all 36 runtime dependencies imported, every source file imported, no TODO / FIXME, no `.only` / `.todo`, every General setting read by the app, and CLAUDE.md's tree accurate.

## If you start now (until Phase 1 lands)

*No longer needed: every item below is fixed (Phases 1 to 5).*

1. **Folder renames and moves:**
   - Close files from that folder in other programs first.
   - If Filo says "Failed to rename", do the same rename again.
   - If it says a board's folder couldn't be renamed, delete the stray `.board.json` it names before restarting.
2. **After renaming a big folder, give Filo a minute** before undoing a delete or quitting, and never end a slow-closing Filo from Task Manager.
3. **Don't align or indent list items that have sub-items.** In quotes, headings and tables, start a bold or italic selection at the start of the text, not at the end of the line above.
4. **For a read-only note from Keep or Obsidian, fix it in Raw view** instead of using Take ownership:
   - add a blank line above the list or heading;
   - or put `<` `>` around a bare link.
5. **Before a vault-wide Replace All,** read the match list if your search text could be Markdown (`-`, `--`, `*`, `#`, `|`, parts of links).
6. **Search and shortcuts:**
   - In a Kanban, use Ctrl+Shift+F instead of `/`.
   - Close dialogs before Ctrl+Z or Ctrl+W.
   - After a sidebar name search, use Expand All.
7. **Undo a sidebar delete from the board that was active when you deleted.**

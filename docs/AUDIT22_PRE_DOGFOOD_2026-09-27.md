# Audit-22: pre-dogfood full audit (2026-09-27)

Scope: the whole app at `f315ccc`, with extra weight on data integrity, themes and settings, the 19 commits since Audit-21 (`2c59a86..f315ccc`), and board / editor UX.

Method:
- **11 parallel auditors.** Nine read code, one per area. One ran every CI gate. One drove the real built app (Playwright `_electron`, about 15 launches against a scratch vault), switching through all 5 themes with screenshots, testing that settings stick, renaming boards with folders on and off, quitting right after typing, pinning toolbars and undoing.
- **Verification.** A separate skeptic tried to refute each area's findings. Every surviving high or critical finding got a second, independent skeptic.
- **Result.** No finding was refuted outright; severities were adjusted where the verifiers traced them lower. The critical finding and all five high findings were reproduced or traced end to end by two verifiers.

## Verdict

**Filo is genuinely good, and your impression from scratch testing is right.** The save engine is unusually strong, stronger than most shipping note apps. Every note write is a change applied to a fresh read. A write is refused if the file changed on disk since that read. Conflicts can't be dismissed into loss. Deletes go to a crash-ordered trash, and close or quit either saves or writes rescue copies. In the live test, text typed and followed straight away by a window close was on disk every time. Undo and redo were correct. Board rename, board folders, toolbar pin and Settings Apply/Revert all worked end to end. All 5 themes looked coherent, with no renderer or main-process errors. All static CI gates are green, and 6064 of 6076 tests pass. The rest are 5 skips and 7 failures that happen only under load and pass on rerun.

**But don't start real use until Phase 1 below is done.** It is small: six bugs a normal user hits in the first week. One silently removes tasks from a Task List. Two mangle ordinary typing. One makes undo/redo look like lost text. Two make themes look broken. None of them destroys the text of a `.md` note, which is the property you care most about.

## Ratings

| Area | Rating | One-line reason |
|---|---|---|
| Note save path & external changes | **8.5** | Most hardened part of the codebase. One real fidelity bug (leading `---` rule). |
| Vault lifecycle, trash, recovery | **8** | Crash-ordered trash, transactional vault swap, rescue copies. New Vault is broken while a vault is open. |
| Board & config persistence | **7** | In-app flows are solid. Boards renamed *by another program* are handled badly. |
| Recent changes (19 commits) | **8** | No data-loss regression. A few edge cases and stale comments. |
| Mind Map / canvas / undo | **7** | Mature and well defended. Redo of a new tile orphans its note; locks leak in group moves; Smart Guides are dead. |
| Kanban & Task List | **6** | The field-write core is production-grade. Drag and sort have real bugs, one critical. (8 once Phase 1 and 4 are done.) |
| Document editor & markdown | **7** | Disk path is strong. Everyday typing fidelity bugs (`#tag` + space, double spaces, `1)`). |
| **Themes & settings** | **6** | Plumbing is safe and all 5 built-in themes define all 92 tokens. What the user sees is thin: stale text colours on switch, the custom theme isn't remembered, no theme editor. |
| Security & maintainability | **8** (security ~9) | Sandboxed, validated IPC, layered path guards. Little dead code. |
| Real-world UX (live run) | **8** | Everything important worked. Document tabs aren't restored, and a custom theme doesn't persist. |
| Tests & CI | **8.5** | 6076 tests, 68 invariant gates, all green. A few timing-flaky tests; E2E is manual-only. |
| **Overall** | **7.5** | Trustworthy with your data today; Phase 1 needed before daily use. |

## Findings

Severity is as adjusted by the verifiers. Duplicate findings from different auditors are merged, with both ids listed.

### Critical

**C1 — Task List: dragging one task silently removes every hidden task from the board** (`lists-1`)
[taskDragController.svelte.ts:544](../src/renderer/lib/tasklist/taskDragController.svelte.ts:544), [blockMove.ts:201](../src/renderer/lib/tasklist/blockMove.ts:201)

- **Cause:** a single-row drop rebuilds the board's whole `tasks` array from the drag items, and those contain only *visible* rows. Hidden rows are dropped. That includes a collapsed parent's subtasks, completed tasks with "Show completed" off, rows outside the active smart list, and filtered rows.
- **When it fires:** the "nothing moved" guard compares lengths, so even a wiggle released in place commits the loss.
- **What survives:** the `.md` files, and Ctrl+Z restores the placements if you notice straight away. Nothing warns you.
- **Simplest trigger:** collapse a parent with subtasks, then drag a sibling.
- **Fix:** rebuild from the full placements. Re-insert hidden rows after their previous visible neighbour, or route the single-row drop through `moveTaskBlock` as the multi-row path does. Add a hard guard that refuses a commit whose tile-id set differs from the current one.

### High

**H1 — Typing a space after `#tag` eats the space, and keeps eating spaces** (`editor-1`)
[tagExtension.ts:28](../src/renderer/lib/editor/tagExtension.ts:28)

- `INPUT_TAG_RE` ends in `\s$`, and the mark input rule swallows the typed space.
- "Meeting notes #project follow up" becomes "Meeting notes #projectfollowup". The joined word re-matches, so each following space is eaten too.
- Two verifiers reproduced it with the real editor. Nothing tests the typing path.

**H2 — Two spaces in a row make the note reopen read-only; with two views open, both freeze mid-typing** (`editor-2`)
[markdownSync.ts:246](../src/renderer/lib/editor/markdownSync.ts:246)

- **Cause:** ProseMirror collapses internal space runs on load, and the round-trip compare doesn't normalise them, so the note is flagged lossy.
- **Two views:** with the note open as a Document tab and a tile, the other view reloads and sets `model.lossy`, so both editors freeze. Take ownership lasts only until the next keystroke.
- **Scope:** also hits imported notes with double spaces. This isn't in KNOWN_LIMITATIONS #17.

**H3 — Undo then redo of a new text tile points it at a new blank note; your text is orphaned** (`mindmap-1`)
[tileCommands.ts:26](../src/renderer/commands/tileCommands.ts:26)

- **Cause:** `AddTileCommand` keeps a tile snapshot without `filePath`. The path is stamped on a Zod copy, so on redo it allocates `New Tile (2).md`.
- **Effect:** the original note is still on disk, but the tile shows blank with no notice, which looks exactly like data loss.
- **Scope:** Kanban and Task List add commands likely share the pattern (not traced).

**H4 — Switching theme leaves stale text colours (black on dark tiles) until each view remounts** (`themes-1`)
[effectiveStyle.ts:144](../src/renderer/lib/styles/effectiveStyle.ts:144)

- **Cause:** with Dynamic Contrast Text on (the default), the resolvers read CSS variables through `getComputedStyle` and bake `#000` or `#fff` into inline styles. Their `$derived` never depends on the theme.
- **Effect:** Light → Dark shows black text on navy on every open board. This is the "theme gaps" feeling you described.

**H5 — New Task Lists get `accentColor: ''`: the progress bar never fills and a completed tick is invisible in Light** (`themes-2`)
[TaskItem.svelte:577](../src/renderer/components/boards/TaskItem.svelte:577), [TaskListBoard.svelte:1335](../src/renderer/components/boards/TaskListBoard.svelte:1335)

- `settings.accentColor ?? ACCENT_COLOR` doesn't catch `''`, so the style directives clear the colour.
- The tick is drawn white on a transparent box over a white row.
- Seen on the first ticked task in a fresh vault.

### Medium

**Data integrity**
- **M1 `notes-1`:** a note with no frontmatter whose body starts with a horizontal rule is saved as `---\n…\n---`. The next read takes the text up to the second rule as frontmatter, so it is hidden, and later saves duplicate it. Hit by imported fiction that uses scene breaks. Fix: never emit a leading bare `---` without real frontmatter (prefix an empty `---\n---\n`, or write the first rule as `***`). [markdownSync.ts:578](../src/renderer/lib/editor/markdownSync.ts:578)
- **M2 `mindmap-3`:** deleting a tile inside a frame leaves its id in `frame.tileIds`. The next open shows an error-style "pruned orphan refs" toast and writes a recovery snapshot, for a routine action. [mindmap.ts:80](../src/renderer/core/boardTileOps/mindmap.ts:80)

**Boards renamed or moved by another program** (one root cause plus a regression)
- **M3 `boards-1`:** `board:save` never records its written size with the watcher. For about 30 s after a save, an Explorer or OneDrive rename of the `.board.json` isn't paired. The board then vanishes from Filo with a false "two board files use the same id" warning, until the vault is reopened. [board.ipc.ts:249](../src/main/ipc/board.ipc.ts:249)
- **M4 `boards-2`:** the same cause with board folders. Renaming a board's folder outside Filo clears its pin and shows a false "unsaved changes" prompt. Its "Save at original location" button creates a duplicate board. [folderPins.ts:103](../src/renderer/lib/vault/folderPins.ts:103)
- **M5 `boards-3` / `lifecycle-4`:** a regression from 9e4b869. A `.board.json` renamed outside Filo keeps its old board name for the session, and the next save writes the old name into the new file. The name sweep runs before `renameBoardPath`. [vaultExternalChanges.ts:197](../src/renderer/stores/vaultExternalChanges.ts:197)

**Vault lifecycle**
- **M6 `lifecycle-1`:** **New Vault always fails while a vault is open** (toolbar menu and Home). `newVault` calls `vault:init-config` before `openVault` has closed the current vault. [vault.svelte.ts:1133](../src/renderer/stores/vault.svelte.ts:1133)
- **M7 `lifecycle-2`:** on Home, cancelling the leave dialog, or a drive that is briefly unavailable, says "moved or deleted" and **removes the vault from recents, pinned ones included**. [HomeScreen.svelte:149](../src/renderer/components/home/HomeScreen.svelte:149)
- **M8 `lifecycle-3`:** a sidebar delete clears the Root Directory and board-folder pins *before* the trash move. A failed move (a locked file) or an undo doesn't put them back. [vaultDeleteOps.ts:105](../src/renderer/stores/vaultDeleteOps.ts:105)

**Themes and settings**
- **M9 `themes-3` / `live-1`:** picking a custom theme is never saved; a relaunch goes back to the last built-in theme. `Project.theme` is typed as the built-in enum. Seen in the live run. [ThemeManager.svelte:54](../src/renderer/components/settings/ThemeManager.svelte:54)
- **M10 `themes-4`:** there is no in-app way to author theme colours. "Save as theme" snapshots a built-in theme. Hand-edits to a theme file that's already loaded are never re-read, because the cache skips known ids. [theme.svelte.ts:80](../src/renderer/stores/theme.svelte.ts:80)
- **M11 `themes-6`:** a custom theme captures and then *erases* your font, font size, UI scales and toolbar colour. Switching away falls back to 13px Arial Rounded while Settings still shows your values. [themeManager.ts:171](../src/renderer/lib/themes/themeManager.ts:171)
- **M12 `themes-7`:** Global Defaults only partly reach existing boards. `''` colours follow, but baked shape, border and shadow don't. Kanban, Task List and Document backgrounds ignore the global background, and the Current Board tab's "blank inherits from global" hint is wrong for them. [buildBoardDefaults.ts:42](../src/renderer/lib/styles/buildBoardDefaults.ts:42)
- **M13 `themes-8`:** deleting a theme unlinks the file for good, with no confirm and no trash. Saving silently overwrites a same-slug theme. A theme named "Light", "Dark" and so on becomes an invisible orphan file, although the toast says it was saved. [configOps.ts:440](../src/main/vault/configOps.ts:440)

**Mind Map**
- **M14 `mindmap-2`:** undo or redo of a frame move displaces locked tiles that the drag never moved. [frameCommands.ts:138](../src/renderer/commands/frameCommands.ts:138)
- **M15 `mindmap-4`:** bare-key shortcuts (N, C, Enter, Backspace, arrows) fire behind open dialogs and on focused buttons. Pressing `n` with Settings open creates a tile and a note behind it. [MindMapBoard.svelte:547](../src/renderer/components/boards/MindMapBoard.svelte:547)
- **M16 `mindmap-5`:** Smart Guides can never appear. "Snap Tiles" switches to grid snap, which disables the guide branch. The snap choice isn't persisted either (`settings.snapToGrid` is never read). [TileContainer.svelte:316](../src/renderer/components/tiles/TileContainer.svelte:316)
- **M17 `mindmap-6`:** locked tiles still move in a multi-select or group drag, and in Align, Distribute and Tree/Radial layout. [tileDrag.ts:149](../src/renderer/lib/canvas/tileDrag.ts:149)

**Kanban and Task List**
- **M18 `lists-2`:** Kanban Sort (title, created, due, priority) has no visible effect, and keyboard navigation follows the invisible sorted order. [KanbanColumn.svelte:699](../src/renderer/components/boards/KanbanColumn.svelte:699)
- **M19 `lists-3`:** with a filter or find query active, Kanban card drag picks the wrong card. Hidden cards are in `items` but have no DOM node. [KanbanColumn.svelte:709](../src/renderer/components/boards/KanbanColumn.svelte:709)
- **M20 `lists-4`:** keyboard Tab-indent skips the drag path's guards: section boundary, 3-level cap, collapsed rows and sorted order. A task can vanish under a collapsed parent. [taskListKeyboardNav.svelte.ts:111](../src/renderer/lib/tasklist/taskListKeyboardNav.svelte.ts:111)

**Editor, search and links**
- **M21 `editor-3`:** typing "1) Buy milk" becomes a numbered list after reopening, unflagged. [markdownSync.ts:293](../src/renderer/lib/editor/markdownSync.ts:293)
- **M22 `editor-4`:** Find / Replace All skip every note not placed on a board, although they say "across the vault". [runSearch.ts:358](../src/renderer/lib/search/runSearch.ts:358)
- **M23 `legacy-1`:** `http://` links are accepted and shown as openable, but main refuses them. In notes and iframe tiles the click silently does nothing. [linkClicks.ts:32](../src/renderer/lib/editor/linkClicks.ts:32)

**Workspace**
- **M24 `live-2`:** open Document tabs are dropped on every relaunch, because `serialize()` doesn't store `notePath`. [tabs.svelte.ts:431](../src/renderer/stores/tabs.svelte.ts:431)

### Low

- **Boards and lifecycle:**
  - `boards-4`: an external-rename drain could, rarely, write a queued board save to the old path.
  - `boards-5` / `recent-3`: with board folders on, existing boards stop using the Root Directory, silently.
  - `recent-4` / `live-7`: a new board can reuse a deleted board's leftover folder, or a name used elsewhere in the vault.
  - `lifecycle-5`: tree-diff folder-rename detection is skipped if a direct `refreshTree()` runs first.
  - `lifecycle-6`: an in-app folder rename moves the Root Directory pin but clears the sentinel without saving `app.json`.
  - `lifecycle-8`: the recovery modal promises to "ask again next time", but any write clears the sentinel.
  - `recent-2`: Current Board Apply writes back a settings snapshot taken when the dialog opened.
- **Themes:**
  - `themes-5`: clicking a built-in theme silently wipes customised Global Default colours.
  - `themes-9`: warning and danger tokens are defined in no theme.
  - `themes-10`: the toolbar colour has no contrast handling across themes.
  - `themes-11`: "System colours only" re-skins Kanban and Task List surfaces.
  - `live-5`: tag chips use the tag colour as text, unreadable on Blueprint, Nature and Retro.
- **Settings UI:**
  - `live-3`: Current Board edits a hidden board while a Document tab is active.
  - `live-4`: "Discard settings changes?" sometimes appears with nothing edited.
- **Mind Map:**
  - `mindmap-7`: tiles hidden in a collapsed frame are still selectable.
  - `mindmap-8`: Ctrl- or Shift-click on a locked tile's header toggles the selection twice.
  - `mindmap-9`: a connection can be drawn across boards (plausible).
  - `mindmap-10`: there is no tile copy, paste or duplicate.
- **Task List and Kanban:**
  - `lists-5`: Tab and Shift+Tab are trapped on task rows (a11y).
  - `lists-6`: group-by-due puts tomorrow under Today on the day the clocks go forward.
  - `lists-7`: quick-add ignores nested and non-ASCII tags.
- **Editor:**
  - `editor-5`: typed `&amp;`-style entities change meaning on reopen.
  - `editor-6`: the Tags Browser counts every spelling of a tag, but its popup lists only exact-case matches.
  - `editor-7`: Tab over a selection that reaches into a list rewrites the items as HTML.
  - `editor-8`: Backspace at the start of an indented paragraph joins it to the one above instead of outdenting.
  - `recent-1`: a tab at the end of a bold or italic run breaks the emphasis on reload.
- **Other:**
  - `legacy-2`: the vault index skips `.md` files under a top-level `attachments/` folder.
  - `legacy-3`: links inside iframe embeds do nothing.
  - `legacy-4`: a dead pending-probe mechanism is left over from the removed markdown gateway.
  - `legacy-8`: the `.filo/` carve-out doesn't recognise 8.3 short names.
  - `notes-2`: another program restoring an older copy of Filo's own bytes within about 10 s is taken as Filo's own echo.
- **CI:**
  - `ci-1`, `ci-2`, `ci-3`: timing-flaky tests.
  - `ci-4`: the coverage ratchet runs on PRs only, and work goes straight to `main`.
  - `ci-5`: E2E and a11y are manual-only.
  - `ci-6`: `settleUnappliedEdits` is tested only indirectly.

### Nits

- **Stale docs:** KNOWN_LIMITATIONS #17 still lists tab characters (`notes-3` / `editor-9`). Comments are stale around Hide Vault (`recent-5`), `syncTileMarkdown` (`recent-6`), the TagSweepOutcome JSDoc (`recent-7` / `editor-11`) and the Kanban drag doc (`lists-9`). CLAUDE.md's structure section misses the new modules (`recent-8`), README is stale (`legacy-6`), and audit narration is left in test comments (`ci-8`).
- **Code hygiene:** test-only exports (`legacy-5`), duplicated iframe-URL and hex-colour validators (`legacy-7`), `static/themes/*.json` shipped but never read (`themes-12`), and `test-unit-strict` spawning with `shell:true` (`ci-7`).
- **Editor:** inline code over a tab splits in two (`editor-10`).
- **UX:**
  - The due-date chip is hard-coded to en-US with no year (`lists-8`).
  - Floating panels cover content at their default positions (`live-8`).
  - 42 `derived_inert` warnings appear when leaving a Document tab (`live-6`).
  - Undoing a board delete doesn't restore its toolbar and viewport (`boards-6`).
  - Close Vault is keyboard-only (`lifecycle-7`). This was your deliberate choice in f315ccc; only the stale comments need fixing.

## Fix plan

Each phase is one commit on `main` after `npm run ci:verify`, with a real-app check where the change is visible. Each fix gets a regression test that fails before the fix.

### Phase 1 — before daily use (C1, H1–H5, M1)
1. **C1** Task List drop: rebuild from the full placements, with a tile-id-set guard that refuses the commit. Tests: a collapsed parent, `showCompleted=false`, a smart list, and an in-place release.
2. **H1** Remove the decorative body `#tag` mark (`lib/editor/tagExtension.ts`, and its registration in `createEditor.ts`). Decided 2026-09-27: tags live only in the tag row / frontmatter, and a `#word` in the text is plain text. This removes the space-eating input rule entirely. The mark serialised as bare text, and `blockLayout.ts` already strips it from HTML lines, so no file on disk carries it. Before removing it, confirm that no note has a `span.filo-tag` in it. Test: typing `a #tag b` saves as typed.
3. **Tags with spaces** (see "Tags with spaces" below). Allow internal spaces in tag names, split the string form on commas only, and test the tag row, rename, delete, sidebar filter and search with `Book 1` / `Planning Project`.
4. **H2** Double spaces: preserve them (serialise runs as a space plus `&nbsp;`, or parse with whitespace preserved), or at minimum collapse internal runs in the lossy compare. Stop a non-owning view's `setLossy` from overriding Take ownership. Tests: a typed double space, and an imported one.
5. **H3** Add-tile commands keep the stamped `filePath` (Mind Map, and check Kanban and Task List). Characterisation case: add, type, undo, redo, same file.
6. **H4** A `themeStore.version` counter read by every contrast resolver and by BoardBackground. Component test: switch theme, and the text colour changes.
7. **H5** Resolve `accentColor || 'var(--accent-primary)'` once in TaskListBoard and TaskItem.
8. **M1** Never emit a leading bare `---` without a real frontmatter block. Round-trip fixture.

#### Phase 1 status: done (2026-09-27)

All eight items are fixed. Each has a regression test that was run against the unfixed code, failed there, and passes with the fix.

| Item | Fix | Tests |
|---|---|---|
| C1 | `rebuildPlacementsFromDndItems` puts every hidden row back after the visible row it followed (at the top of its section if none), and never emits a tile twice. Both drop paths refuse to commit a result whose tile set differs from the board's, with a toast. | `taskDragHiddenRows.test.ts`: collapsed parent, hidden completed task, smart-list rows, in-place release, cross-section, multi-row, the guard |
| H1 | `tagExtension.ts` removed, with its registration, the `.filo-tag` CSS and the tag-mark strip in `blockLayout.ts`. | `editorTyping.test.ts` types key by key through the input rules |
| Tags with spaces | `isValidTagName` allows spaces (not tabs or line breaks). `cleanTagName` trims, drops `#` and collapses runs of spaces at the three inputs (tag row, tag editor, Tags Browser rename). New names may not contain a comma. `parseTagsField` splits the string form on commas only. | `tagsWithSpaces.test.ts`: tag row, add, rename and remove on flow / block / comma-string fields, index, sidebar filter, search |
| H2 | Notes load with `preserveWhitespace: true`. A new `lib/editor/keepSpaces.ts` tidies markdown-it's HTML first, so the change keeps only runs of spaces. Take ownership holds until a new body comes from disk (`NoteModel.ownedDiskRevision`), and only a body from disk can mark a note lossy. | `doubleSpaceTwoViews.test.ts` (component), `editorTyping.test.ts`, fixture `double-spaces.md` |
| H3 | `AddTileCommand` / `AddTilesCommand` read the tile's note path back from the board on undo, so redo re-adds the tile on the same note. | `undoRedoNewTile.test.ts` (characterisation) |
| H4 | New `stores/themeVersion.svelte.ts` counter. `applyBuiltinTheme` / `applyCustomTheme` bump it, and `resolveBackgroundColor` and `BoardBackground` read it. | `themeSwitchContrast.test.ts` (component) |
| H5 | TaskListBoard resolves `accent = settings.accentColor \|\| 'var(--accent-primary)'` once. TaskItem falls back the same way. | `taskAccent.test.ts` (characterisation) |
| M1 | `bodyWithoutFenceLookalike` in `frontmatterFence.ts` writes the first rule as `***` when a note has no frontmatter and its opening `---` rule would pair with a later one. The assembler's two no-frontmatter branches use it. | `leadingRuleNoFrontmatter.test.ts`, `sceneBreaks.test.ts` (characterisation), fixture `scene-breaks.md` |

**Verification.** `npm run ci:verify` is green: 630 test files, 6128 tests passed, 5 skipped, 68/68 gates. A real-app check (built app, Playwright `_electron`, a fresh scratch vault) confirmed:
- **H5:** a ticked task's box and the progress bar are painted in the accent colour.
- **H4:** switching Light → Dark flips open Mind Map tiles' body text from black to white without a remount.
- **H1 / H2:** typing `Meeting notes #project follow up. End.  Next sentence.` into a Document tab saves exactly as typed, and the note stays editable.
- No renderer or console errors.

The drag fix (C1), redo (H3) and scene breaks (M1) are covered by the characterisation and unit specs above. They were not driven by hand.

**Deviations from the plan**

- **C1:** the plan offered two fixes; I combined them. The single-row drop still takes the visible order from the drag, which keeps the sorted order a drag commits when it switches to Manual. The hidden rows are then put back around it. I also fixed the multi-row path, which the plan didn't mention. It passed the drop's *visible* index to `moveTaskBlock` as an offset into the *full* section, so with hidden rows above, a block landed in the wrong place. It now lands before the first visible row that follows it (`blockInsertOffset`). The guard compares tile *sets*, so a board that already holds a duplicate placement can still be dragged.
- **H1:** I checked every folder under `My Files\Vaults` for a `filo-tag` span before removing the mark. None had one.
- **Tags with spaces:** this is a behaviour change for existing files. A string-form field such as `tags: foo bar` used to read as two tags and now reads as one tag, `foo bar`. List-form fields (`[a, b]` or `- a`) are unaffected. `canonicaliseTagName` deliberately does *not* collapse inner spaces, so a tag another program wrote with two spaces can still be found and removed. Search needs quotes for a spaced tag (`tag:"Book 1"`), which the query parser already supported. No search UI changed. The validation toasts now say "avoid commas" instead of "avoid spaces".
- **H2:** I took the "preserve" route, not the "collapse in the compare" fallback. The plan's `&nbsp;` idea would have put entities in the file. Plain `preserveWhitespace: true` wasn't enough on its own: it turned every soft line break into a hard break, which the lossy compare can't see, and kept the space after a task item's checkbox. `keepSpaces.ts` handles both, and leaves tab characters for the Tab node. A 30-case before/after probe showed no change except the fixed double-space cases. Hard-wrapped paragraphs still open read-only (KNOWN_LIMITATIONS #17, unchanged).
- **H3:** only the Mind Map commands had the bug. Kanban creates the note before `AddCardCommand` is built, and `AddTaskCommand` already re-stamps a bumped path. The path is read back at *undo* rather than right after execute, because the ` (n)` bump on a name collision happens asynchronously after execute. I added a `redo` action to the characterisation harness.
- **H4:** the counter lives in its own store, not as `themeStore.version`. `themeManager` (lib) bumps it, which covers every apply path, the vault-open and fallback-Light paths included. Reading it inside `resolveBackgroundColor` covers every contrast resolver and the Minimap without editing each one. `BoardBackground` now follows the counter instead of `themeStore.active`, so it also updates for a custom theme on the same base. The new store is exempt from the vault-lifecycle coverage check (gate and contract test): it holds a count, not vault data. The test watches the resolver in a live `$derived`; it doesn't mount a whole board.
- **H5:** `TaskListBoard.svelte` sits at its 1961-line ceiling, so I removed the now-unused `ACCENT_COLOR` import to make room for the new line.
- **M1:** of the plan's two options, I chose writing the first rule as `***` over an empty `---\n---` block, so no frontmatter is invented. The rewrite happens only when a later `---` rule would pair with the first one, so any other body keeps its bytes. It lives in `frontmatterFence.ts` because gate `single-fence-parser` keeps every fence regex there. A note an earlier version already saved in the broken shape is not repaired: its hidden text is still in the file, between the first two rules.
- **Tests changed:** `markdownSync.test.ts` now expects the `parseOptions` passed to `setContent`. Old tag tests that pinned "spaces are rejected" and "`tags: foo bar` is two tags" were rewritten to the new rule. `tagExtension.test.ts` was deleted with the module.


### Phase 2 — external renames and the vault lifecycle (M2–M8, boards-4)
- `board:save` and `board:create` record their own write with the watcher (size and hash). `adoptOnce` treats "loaded path missing" as a rename.
- The external-rename cascade applies the stem name after `renameBoardPath`.
- Pin clearing skips boards that are provisionally missing. Delete clears pins only after the move succeeds, and undo restores them.
- New Vault goes through `openVault`. `openVault` returns a reason, and recents are removed only when the folder is confirmed missing, never if pinned.
- Tile delete prunes `frame.tileIds` and group ids, and undo restores them.

#### Phase 2 status: done (2026-09-27)

All eight items are fixed. Each has a regression test that was run against the unfixed code, failed there, and passes with the fix.

| Item | Fix | Tests |
|---|---|---|
| M3 | `board:save` and `board:create` call `recordOwnWrite` with the bytes they wrote (`saveBoardFile` now returns them). `adoptOnce` checks a duplicate id's loaded path on disk: if it is gone, the new file is the same board, renamed, and it runs `handleExternalRename` on the rename queue instead of warning. | `boardWriteOwnBytes.test.ts`, `boardDiscovery.test.ts` (two cases), `boardRenamedOutside.test.ts` (characterisation) |
| M4 | `clearPinsOfMissingFolders` leaves a board's pin alone while the board's own `.board.json` is missing from the tree too, and clears only that board's pin otherwise. | `folderPinsMissingBoard.test.ts`, `boardRenamedOutside.test.ts` (folder renamed right after a save) |
| M5 + boards-4 | `handleExternalRename` rebinds a moved `.board.json` (`renameBoardPath`) before `renameAllPathKeys` and before the drain. The name sweep then finds the board at its new path, and the drain writes a queued save to the new path. | `boardRenamedOutside.test.ts` |
| M6 | `newVault` is `openVault` plus the name: the open sets `.filo/` up once the outgoing vault is closed. | `newVault.test.ts` (characterisation) |
| M7 | `openVault(path, report?)` fills `report.failure` with `cancelled`, `missing`, `unavailable` or `failed`. `vault:init-config` answers `ENODEV` when the folder's drive or share can't be reached, and `ENOTDIR` for a file. Home (a click and the open-on-launch) removes a recent entry only for `missing`, and never a pinned one. | `homeRecentVaults.test.ts` (component), `boardWriteOwnBytes.test.ts` (the init-config codes) |
| M8 | The delete snapshots the pins it clears (`pinsUnder`), restores them if the trash move fails, and passes them to `CascadeDeleteCommand`, whose undo restores them and whose redo clears them again. | `folderPinsAndVaultName.test.ts` (two new characterisation cases) |
| M2 | `mindmapTileOps.removeTile` takes the tile out of every frame and group, and drops a group it leaves empty. `DeleteTilesCommand` and `CascadeDeleteCommand` snapshot the memberships (`lib/boards/tileMemberships.ts`) and restore them on undo. | `tileDeleteMemberships.test.ts` |

**Verification.** `npm run ci:verify` is green: 636 test files, 6153 tests passed, 5 skipped, 68/68 gates. A real-app check (built app, Playwright `_electron`, a fresh scratch vault, two launches) confirmed:
- **M3 / M5:** `Kanban 1.board.json` renamed to `Roadmap.board.json` in the file system while open: the tab becomes "Roadmap" with its cards, the file holds `"name": "Roadmap"`, nothing reappears at the old path, and no toast is shown.
- **M6:** Vault menu → New Vault while a vault is open opens the new vault with its `.filo/` folder, and it is listed under Recent vaults.
- **M7:** with the first vault's folder moved away, clicking its pinned entry on Home keeps the entry and says so; once unpinned, the same click removes it.
- No renderer or console errors.

The "right after a save" rename (M3), the board-folder rename (M4), the delete pins (M8) and the frame and group membership (M2) are covered by the characterisation and unit specs above. They were not driven by hand.

**Deviations from the plan**

- **M3:** the rename that `adoptOnce` follows is queued, not awaited, because the adoption can itself run on the rename queue. The sidebar open (`adoptAndFindBoard`) waits for it. A duplicate id whose loaded file is still on disk keeps the duplicate warning, and a failed existence probe counts as "still there".
- **M4:** the rule is "the board's own file is missing from the tree", not a lookup of the provisional-missing state. In `refreshTreeAndCleanup` the pins are cleared before the boards are marked provisionally missing in the same pass, so the state isn't set yet when the pins are checked. A board whose file really went is evicted later, pin and all.
- **M5 / boards-4:** one change fixes both. The cascade inside the drain no longer calls `renameBoardPath`; it gets the renamed board ids from `handleExternalRename`.
- **M8:** the plan said to clear the pins only after the move succeeds. I kept the clear *before* the move, because it stops a write that resolves a path through the pin from recreating the folder during the move, and added the restore on failure instead. Undo and a failed move restore a pin only where nothing has set a new one meanwhile. A pin restored beside a name taken meanwhile (`… (restored)`) follows the restored copy.
- **M6:** the old `newVault` also overwrote an existing `app.json` with just `{ name }`, dropping the seeded defaults (or a real vault's settings, if the chosen folder was one). That is gone: the name is saved through `setName` only when it differs from the default, the folder name.
- **M7:** the plan said `openVault` "returns a reason". It keeps its boolean result and takes an optional report object instead, so its other callers and some 50 test call sites are unchanged. When a caller asks for the reason, the generic "Failed to open vault" error is left out for a missing or unreachable folder, since the caller shows its own message.
- **M2:** undo puts back only the deleted tiles, so a tile the user took out of a group after the delete isn't regrouped. A group that emptied out is recreated. Undo of the sidebar delete (`CascadeDeleteCommand`) restores memberships too.
- **Found during the real-app check, fixed here:** the vault menu's New Vault never added the new vault to Recent vaults; Open Vault did. It now calls `rememberOpenVault` too.
- **Housekeeping:** `vault.svelte.ts` shrank, so its file-size ceiling is lowered from 1586 to 1573. The `vault.ipc` mocks in `boardCreateBaseline.test.ts` and `boardCreateRelativePath.test.ts` gained `recordOwnWrite`. The characterisation harness gained `newVaultFromMenu` and `recentVaultPaths`.

### Phase 3 — themes and settings (M9–M13, themes-5/9/10/11/12, live-3/4/5, recent-2)
- Persist the custom theme id. Re-read a changed theme file.
- Stop themes capturing font, size, scale and toolbar settings.
- Theme delete goes to the trash with a confirm. Refuse slug and built-in name clashes.
- Pick one Global Defaults rule and state it in the UI. Kanban, Task List and Document backgrounds fall back to the global background.
- Define the warning and danger tokens in every theme. Fix tag-chip contrast.
- **In-app theme editor (approved 2026-09-27).** It replaces "Save Current Settings as Theme":
  - **New theme** starts from the active theme's current colours, which is what Save does today, then opens the editor.
  - The editor shows grouped colour pickers that apply live, with Save, Save as new and Cancel (Cancel reverts).
  - A custom theme gets Edit, Duplicate and Delete (Delete goes to the trash). A built-in theme can be duplicated, not edited.
  - Import takes a theme `.json` file.
  - Fonts, sizes and scales stay settings and are not part of a theme (fixes M11).

#### Phase 3 status: done (2026-09-27)

All items are fixed. Each fix has a regression test. I checked that the tests bite by putting each bug back one at a time: M9, M10, M11, M12, M13, themes-5, live-3, live-4 and recent-2 were each caught by their test, which passes with the fix.

| Item | Fix | Tests |
|---|---|---|
| M9 | `Project.theme` is any theme id, built-in or custom. Every theme pick is saved to `appearance.json` (`lib/themes/themeActions.ts` `selectTheme`), so a relaunch opens on a custom theme. | `themes.test.ts` (characterisation: a new theme and a picked theme survive a relaunch), `schema.test.ts` |
| M10 | New in-app theme editor (below). A theme file changed by another program is read again: the watcher's reconciler passes its id to `refreshAvailable(root, reload)`, and a file deleted elsewhere leaves the cache. | `themeStoreCatalogue.test.ts`, `themeEditorPreview.test.ts` (component) |
| M11 | A theme is colours only (`lib/themes/themeTokens.ts`). The font, size, scale and toolbar variables are no longer captured, and a theme saved by an older version has them skipped on apply. A new theme's snapshot reads the toolbar and tab bar colours from under the user's own colour settings. App.svelte writes the settings variables again after every theme paint. | `themeSettingsVars.test.ts` |
| M13 | Delete asks first and moves the file into Filo's trash (`trashTheme`); Settings → Trash restores it and the theme list refreshes. A name that is a built-in theme's name or id ("Light", "Light Mode", "dark") or another custom theme's id is refused inline, never overwritten (`themeNameProblem`). | `themeTrashMain.test.ts`, `themeFiles.test.ts`, `themes.test.ts` |
| M12 | One rule, stated at the top of Global Defaults and in Current Board: a board follows the Global Defaults, live, for every field it leaves blank; a field set on the board is its own. New boards no longer bake the Global Defaults in. The Kanban, Task List and Document background and accent now fall back to the Global Defaults before the theme. | `buildBoardDefaults.test.ts` (incl. a Global Defaults change reaching a new board), `applyDefaultsToAllBoards.test.ts` |
| themes-5 | Picking a theme when the user has set Global Defaults colours asks: **Use theme colours**, **Keep my colours** or Cancel. | `themes.test.ts` (all three answers) |
| themes-9 | `--ui-warn-bg`, `-bg-hover`, `-border`, `-text` are defined in all five themes. The undefined danger names (`--ui-danger`, `--ui-danger-soft`, `--ui-danger-bg`, `--status-error`) are replaced with the defined `--accent-danger` / `--menu-danger-bg`. | `themeContrast.test.ts` (warning text 4.5:1; every theme token defined in every theme) |
| themes-10 | A user toolbar or tab bar colour gets black or white text, whichever reads better (`lib/themes/chromeText.ts`). The bars' controls read it as `--chrome-*`; menus, popups and the active tab reset it. | `themeHelpers.test.ts` |
| themes-11 | With "System colours only" on, boards keep the theme they had: BoardRouter gives the board its `data-theme` (`themeStore.boardTheme`), set only once a theme was painted that way. | `themeStoreCatalogue.test.ts` |
| themes-12 | `static/themes/*.json` deleted, with its `package.json` build entry. | `themeContrast.test.ts` now reads `style.css` |
| live-3 | The Current Board tab edits `settingsBoard()`: none while the active pane shows a note, so the tab is disabled there. | `pendingSettingsEditsOnly.test.ts`, `themes.test.ts` |
| live-4 | "Discard settings changes?" compares the dialog's copy with the values it was copied from, not with the live settings. | `pendingSettingsEditsOnly.test.ts` |
| recent-2 | Apply writes only the fields the user edited, onto the live settings (both tabs). | `pendingSettingsEditsOnly.test.ts` |
| live-5 | Tag chip text is the tag colour pulled 45% towards the theme's text colour. | (CSS only) |

**The theme editor** (Settings → Themes):
- **New Theme** starts from the colours on screen and opens the editor. **Import Theme…** reads a theme `.json` and opens the editor on it. Nothing is written until Save.
- The editor lists 91 colours in 8 groups (backgrounds, text, borders, accents and status, toolbar/tabs/sidebar, canvas/tiles/frames, connections, priorities). Each row has a colour picker and a value box; the box also takes `rgba(…)`. A value that isn't a safe colour is marked and not applied.
- Every change paints at once, one paint per frame while a picker is dragged. **Save** writes the file and makes it the active theme. **Save as new** does the same under a new name. **Cancel**, closing Settings, or leaving the vault paints the active theme again.
- A custom theme has Edit, Duplicate and Delete. A built-in theme has Duplicate (on hover), not Edit.

**Verification.** `npm run ci:verify` is green: 644 test files, 6218 tests passed, 5 skipped, 68/68 gates, and the test type-check ratchet. A real-app check (built app, Playwright `_electron`, a fresh scratch vault, two launches) confirmed:
- **Editor:** changing App background to `#5a2d1a` paints it at once. Save writes `.filo/themes/sunset.json` with no font or size in it, `appearance.json` names `sunset`, and a toast says it was saved.
- **M9:** after a relaunch the vault opens on Sunset (`--ui-bg` is `#5a2d1a`), marked active in Settings.
- **M11 / themes-10:** with toolbar colour `#1a2b5c` set in `app.json`, the toolbar icons are white, and switching to Dark Mode keeps both the toolbar colour and the font size.
- **M13:** Delete asks, then `.filo/themes/sunset.json` is in `.filo/trash`.
- No renderer or console errors.

**Deviations from the plan**

- **Where the editor lives.** It opens inside the Themes tab, in place of the theme list, rather than in a separate dialog, so Settings' own Esc and close still apply. Closing Settings mid-edit reverts the preview. The theme cards show a Duplicate button on hover; it isn't a separate row.
- **Editing keeps the file.** Save on an edited theme writes over the same file, even if the name changed, so renaming a theme never leaves the old file behind. Save as new takes an id from the new name.
- **Deleting the active theme** switches to the built-in theme it was based on, and saves that.
- **Theme trash.** The trash manifest parser refused every `.filo/` path, so that a synced manifest can't steer a restore into Filo's folder. It now admits exactly one pattern, a single `.filo/themes/<name>.json`. Settings → Trash lists the entry by that path.
- **M12, existing boards.** Existing boards keep the values they baked in at creation, because a baked value can't be told apart from one the user chose. The Current Board tab shows them as the board's own. "Apply Current Global Defaults to all Boards" now clears every board's own style, so all boards follow the Global Defaults from then on. Visually it gives the same result as before; its confirm text says what it does. "Apply Theme Defaults to all Boards" is unchanged. The Settings live preview still shows the Global Defaults only.
- **themes-5.** The question now also comes up for custom themes, which never reset colours before. The reset covers every default colour; the old hand-kept list missed the Kanban card header and body, the Task List task header and border, and the document header.
- **themes-9.** The danger aliases were replaced with existing tokens rather than defined as new ones. `themeContrast.test.ts` used to read `static/themes/*.json`, copies that were never loaded and could drift from the real palettes; it now parses `style.css`. All pairs still pass against the real palettes.
- **themes-10** covers the global toolbar (icon buttons, vault menu trigger, formatting controls) and inactive tabs. It needs a hex colour, which is what the colour picker produces.
- **themes-11.** The pinned theme covers everything inside a board, including a board's own side toolbar and in-board menus. A board that was showing a custom theme's colours gets its base built-in theme instead, since "System colours only" already cleared the custom colours.
- **live-4.** I couldn't make the stray prompt appear on demand. The code had two ways to cause it: the copy was taken from the active board while the compare read the board cache, and any live change (a Mind Map toggle, a theme's colour reset) counted as an edit. The fix removes both.
- **Also found:** `vaultProject.setTheme` wrote the theme id to `<html data-theme>`, which would have left the app unstyled for a custom id. It now only records the id. The save status colours (`--toolbar-save-*`) were never captured in a saved theme; they are now.
- **Tests changed:** `buildBoardDefaults.test.ts` was rewritten for the new rule. `applyDefaultsToAllBoards.test.ts` now expects a cleared accent. `schema.test.ts` accepts a custom theme id and rejects a blank one.
- **Housekeeping:** CLAUDE.md lists the new `lib/themes/` modules and `ThemeEditor.svelte`, drops `static/`, and states the Global Defaults and theme rules under "Override Cascade". The characterisation harness gained `harness/themes.ts`.

### Tags with spaces (found 2026-09-27, after the audit)
You expect comma-separated tags such as `Book 1`, but `isValidTagName` ([tagsStorage.ts:233](../src/renderer/lib/vault/tagsStorage.ts:233)) rejects any whitespace. So the tag row, the Tags Browser and the tag editor all refuse `Book 1`. `parseTagsField` ([normalizeTagsField.ts:45](../src/renderer/lib/utils/normalizeTagsField.ts:45)) also splits the string form `tags: "a b"` on spaces.

To support them:
- Allow internal spaces in tag names.
- Split the string form on commas only.
- Check the tag rewriter's line-level fast path, the tag rename and delete sweeps, and the sidebar filter with spaced names. Add tests for each.

Body `#tag` highlighting is decorative only: real tags live in frontmatter, and the vault index ignores body tags. It can't express a spaced tag anyway.

### Phase 4 — board and editor interaction (M14–M23, the rest of the Mind Map / list / editor lows)
- **Mind Map:** locks respected in group drag, align, layout and frame undo. Bare-key shortcuts gated on modals, menus and buttons. Smart Guides separated from grid snap, and snap persisted.
- **Kanban:** Sort renders the sorted order and disables within-column reorder. `items` and the DOM kept one-to-one under a filter.
- **Task List:** keyboard indent reuses the drag guards.
- **Editor and links:** escape a leading `1)`. Search also covers notes on no board, or its label is corrected. One `http://` policy with a visible error.

#### Phase 4 status: done (2026-09-27)

All items are fixed except `mindmap-10` (see the deviations). Each fix has a regression test. I checked that the tests bite by putting each bug back one at a time: all 24 reverted fixes were caught by their test, which passes with the fix.

| Item | Fix | Tests |
|---|---|---|
| M14 | Frame drag captures only the unlocked tiles it moves, and `MoveFrameCommand` drops locked ids, so undo and redo never shift a locked tile. | `lockedTilesStayPut.test.ts` |
| M17 | `tilesToDrag` (`lib/canvas/tileDrag.ts`) leaves locked tiles out of a selection or group drag. Align / Distribute leave a locked tile in place, though it still sets the edge the others line up with; Tree and Radial arrange only the unlocked tiles. | `lockedTilesStayPut.test.ts` |
| M15 | `isCanvasKeyBlocked` (`lib/mindmap/mindMapKeyboard.ts`): no Mind Map key while a modal is open or focus is in a dialog, menu or listbox; Enter / Space stay with a focused button, arrows with a tab strip or list. The global Delete (`tile:delete`) uses the same gate. | `mindMapInteraction.test.ts` |
| M16 | Smart Guides run whenever grid snap is off (Shift still suspends them). "Snap Tiles" is `boardStore.toggleSnapToGrid`, saved as `settings.snapToGrid` and applied when the board opens. | `mindMapInteraction.test.ts` |
| mindmap-7 | Tiles in a collapsed frame are left out of box selection, Select All (board and frame), the arrow keys, and leave the selection when the frame collapses. | `mindMapInteraction.test.ts` |
| mindmap-8 | The header's pointerdown marks the event (`isSelectionHandled`), so the tile container no longer toggles a locked tile's selection a second time. | `lockedTilesStayPut.test.ts` |
| mindmap-9 | `connectionsStore.drawingOn(board)`: a connection started on another board (split view, tab switch) isn't finished here; the click starts a new one. | `mindMapInteraction.test.ts` |
| M18 + M19 | The card dndzones get exactly the cards each column shows, filtered and sorted (`syncCards`), so the sort is visible and a hidden card is never picked up. A drop is placed in the saved order next to the visible card it landed by (`insertIndexAmongPlacements`); a file dropped on a column is placed the same way. A reorder inside a sorted column is refused with a toast. | `kanbanFilteredSortedDrag.test.ts`, `kanbanDragController.test.ts` |
| M20 | One indent rule (`lib/tasklist/indentRules.ts` `indentProblem`) for the drag and Tab: same section, no cycle, three levels at most, counting the task's own subtasks. Tab commits through the drag's `commitIndent`, which is undoable and expands a collapsed new parent. | `taskIndentRules.test.ts`, `taskDragController.test.ts` |
| lists-5 | Only the focused row itself indents; Tab from a button in the row, and a Tab or Shift+Tab with nothing to do, move focus as usual. | `taskIndentRules.test.ts` |
| lists-6 | Due-date groups count whole calendar days (`Math.round`), so a 23-hour day doesn't put tomorrow under Today. | `taskListModel.test.ts` |
| lists-7 | Quick-add takes tags in any script and nested tags (`#work/filo`, `#café`). | `quickAddParser.test.ts` |
| M21 | A paragraph starting like `1)` is saved as `1\)`, so it reopens as text, not a list. | `editorTyping.test.ts` |
| M22 | Search also walks every note on no board. Such a match sorts after the boards, shows "On no board" in Find All, and Find opens the note in a Document tab. | `runSearch.test.ts` |
| M23 | Every link click goes through `lib/utils/openExternal.ts`: an `http://` link shows a toast with **Open with https://**, and a refusal from main is shown. The Insert Link popup saves a typed `http://` as `https://`. | `openExternalUrl.test.ts`, `linkUrl.test.ts` |
| editor-5 | The editor's text node (`lib/editor/textEscapes.ts`) writes an `&` that starts a character reference as `&amp;`, so typed `&amp;` or `&copy;` reopens as typed. | `editorTyping.test.ts` |
| editor-6 | The tag popup lists tiles and files of every spelling of the tag, matching the Tags Browser count. | `tagPopupAnyCase.test.ts` |
| editor-7 | Indent (Tab over several lines, or the toolbar) skips lines inside lists and tables. | `editorTabKeys.test.ts` |
| editor-8 | Backspace at the start of an indented paragraph is its own high-priority extension (`IndentBackspace`), ahead of the core join. | `editorTabKeys.test.ts` |
| recent-1 | A tab at the edge of a bold, italic or strikethrough run is saved outside the run (`**bold**\t`, `withEdgeTabsOutsideRuns`). | `editorTabKeys.test.ts` |

**Verification.** `npm run ci:verify` is green: 649 test files, 6276 tests passed, 5 skipped, 68/68 gates, and the test type-check ratchet. A real-app check (built app, Playwright `_electron`, a fresh scratch vault) confirmed:
- **M21 / editor-5:** typing `1) Buy milk` and `Prices at AT&amp;T` into a Document tab saves `1\) Buy milk` and `AT&amp;amp;T`, and the note stays editable.
- **M15:** with Settings open (focus not inside the dialog), pressing N creates no tile; after closing it, N creates one.
- **M16:** Snap Tiles writes `"snapToGrid": true` into the board file.
- **M22:** Find for a word only in a note on no board finds it (1 / 1), and Enter opens that note as a Document tab.
- No renderer or console errors.

The drag, lock, frame, Kanban and Task List fixes are covered by the unit specs above. They were not driven by hand.

**Deviations from the plan**

- **mindmap-10 (no tile copy, paste or duplicate) is not done.** It is a new feature, not a fix, and it needs a decision first: does a duplicated text tile show the same note, or a copy of the file? Left for a later phase.
- **M18: refused, not disabled.** The plan said Sort "disables within-column reorder". The drag can't be disabled for one column only while cross-column moves stay allowed, so a drop inside a sorted column is refused with a toast ("Switch to Manual sort to reorder them") and the cards go back. The old toast that said a hidden reorder was saved is gone.
- **M17 rule.** Align / Distribute keep a locked tile as a reference but never move it. With a locked tile in the middle, Distribute leaves uneven gaps around it.
- **M15: letters still work on a focused button.** Only Enter and Space (and arrows in tab strips / lists) are left to the focused control; N, C and Backspace still act on the board right after a toolbar button is clicked.
- **M20 and sorted order.** Tab indents under the row shown above, as a drag onto that row does, in any sort. The rule also counts the task's own subtasks against the three-level cap, which the drag didn't; the drag now uses the same rule, and its `isCycleTarget` / `isDepthExceeded` options are gone.
- **lists-5.** Tab from a button inside a row now moves focus instead of indenting the row, a behaviour change.
- **M23 policy.** `http://` stays refused (main's rule), rather than allowed. The renderer's `asSafeOpenExternal` keeps its documented asymmetry; the new helper catches `http://` before it reaches main. `http://` iframe embeds are unchanged.
- **editor-6.** Only what the popup lists is case-insensitive. The file list a delete acts on (and its undo snapshot) stays exact-case; `filesForTag` takes an `anyCase` flag for the popup.
- **recent-1.** I first wrote an edge tab as `&#9;`, but `**bold&#9;**x` still isn't bold in CommonMark (the delimiter follows punctuation and precedes a letter), so the tab is moved outside the run when saving instead. The document itself isn't changed. A tab in the middle of a run keeps its marks, so existing files open unchanged.
- **Tests changed:** `runSearch.test.ts` pinned "a note on no board is never a match" and now pins the opposite. `taskDragController.test.ts` lost its mocked cycle-guard case (a drag can't reach it with real rows; the rule is tested in `taskIndentRules.test.ts`) and its depth case uses real rows. `kanbanDragController.test.ts` passes shown ids to `syncCards`. `linkUrl.test.ts` expects `http://` to become `https://`.
- **Housekeeping:** KanbanBoard and TaskListBoard stayed under their line ceilings (1436 / 1960). MindMapBoard's keyboard comment was shortened to keep it under 1000 lines. CLAUDE.md lists the new modules.

### Phase 5 — workspace polish
Restore Document tabs, board-folder name and reuse rules, the recovery-modal wording, the Root Directory with board folders on, and the remaining UX lows.

#### Phase 5 status: done (2026-09-28)

All items are fixed. Each fix except the recovery wording has a regression test. For M24, boards-5, recent-4, lifecycle-5, lifecycle-6, boards-6, live-6 and editor-10 I put the old code back and confirmed the test fails, then passes with the fix. live-8 and legacy-3 are new modules with their own unit tests. The lists-8 and legacy-2 tests assert the opposite of the old behaviour.

| Item | Fix | Tests |
|---|---|---|
| M24 | `tabStore.serialize()` stores a Document tab's `notePath` in `workspace.json`. On open, a Document tab comes back only while its note is in the vault tree, under the tree's spelling, so a hand-edited path can't name anything outside the vault. A rename saves the new path at once. | `workspaceRestore.test.ts` (characterisation: order and active tab, a rename, a note deleted while the vault was closed) |
| boards-5 / recent-3 | With board folders on, a board with no folder of its own (made before the switch, or its pin toggled off) uses the Root Directory, then the vault root. The sidebar's green tree button marks where files actually go. | `conventionPaths.test.ts`, `boardFolders.test.ts` |
| recent-4 / live-7 | A new board's name is refused when its own folder already exists (a deleted board's folder is left behind with its notes). Names Filo picks itself ("Kanban 2", a template's board) also skip any name another board in the vault has (`isNewBoardNameTaken`). | `boardFolders.test.ts` (two cases) |
| lifecycle-8 | The recovery list no longer promises to "ask again next time". It says closing the list another way keeps it only until Filo saves a change, which is what happens. | (wording only) |
| lifecycle-6 | An in-app folder rename that moves the Root Directory saves `app.json` before it clears the rename-recovery marker, as the external-rename path already did. | `folderPinsAndVaultName.test.ts` |
| lifecycle-5 | Every tree read notes the folder moves it sees (`lib/vault/unreconciledFolderMoves.ts`), and the watcher's reconcile follows them. An in-app read that sees another program's folder rename first no longer hides it. Filo's own renames are left out: both paths are marked as its own writes again just before the rename reads the tree. | `folderPinsAndVaultName.test.ts`, `folderPins.test.ts` |
| boards-6 | A board delete keeps the board's camera and side-toolbar place, and the toast's Undo puts them back. | `boardDeleteUndo.test.ts` (characterisation) |
| live-6 | `tiptapToolbar.releaseEditor(editor)` drops an unmounted editor at once. The blur's clear waits 300 ms, and in that time the toolbar kept calling the destroyed view's note callback. This affected Document tabs, text tiles, tile and frame titles, and connection labels. | `leavingDocumentTab.test.ts` (component) |
| live-8 | The Task List's Table of Contents first opens beside the list column when there is room, narrowed to 180 px at least, instead of over the list's right edge. It waits for the list to be laid out before it places itself (`lib/tasklist/tocPlacement.ts`). | `tocPlacement.test.ts` |
| lists-8 | The due-date chip uses the OS regional format (`16 May` on en-GB) and shows the year when the date isn't in this year. | `dueDateFormat.test.ts` |
| editor-10 | Tab inside inline code types a tab character into the code. When a code mark is put over an existing tab, the tab is saved as code text. Either way the note keeps one code span. | `editorTabKeys.test.ts` (two cases) |
| legacy-2 | The vault index no longer skips notes under a top-level `attachments/` folder. | `vaultIndex.test.ts` |
| legacy-3 | A link inside an iframe tile's page that asks for a new window opens in the default browser: public `https://` only, at most one a second (`src/main/utils/embedPopup.ts`). KNOWN_LIMITATIONS #10 describes this. | `embedPopup.test.ts` |

**Verification.** `npm run ci:verify` is green: 655 test files, 6299 tests passed, 5 skipped, 68/68 gates, and the test type-check ratchet. A real-app check (built app, Playwright `_electron`, a fresh scratch vault, two launches) confirmed:
- **M24:** Kanban, Task List, Mind Map and two Document tabs (one on `attachments/Caption.md`) came back after a relaunch in the same order, with the same tab active. `workspace.json` names both notes.
- **legacy-2:** Find for a word only in `attachments/Caption.md` finds it (1 / 1).
- **live-8:** the screenshots show the Kanban and Mind Map panels at their default places don't cover content. The Task List's Table of Contents did cover the progress count and the list's right edge; after the fix it sits beside the list.
- **live-6:** no console warnings when leaving a Document tab. The build is a production build, where Svelte's `derived_inert` warning is off, so the component test is the real check for this.
- No renderer or console errors.

**Deviations from the plan**

- **Root Directory with board folders on.** The UI Feedback 4 table said a board whose pin is toggled off saves files at the vault root. It now falls back to the Root Directory, and only then to the vault root. Without a Root Directory nothing changes. With one, clicking a green Root Directory folder pins the board to it, and clicking it again leaves it green, since files still go there. Settings' hint says so.
- **Board names elsewhere in the vault.** Only names Filo picks itself skip another board's name vault-wide. A name the user types is still refused only in the same folder, as decided in UI Feedback 4. A leftover folder is refused for both.
- **lifecycle-8** is fixed with wording, as planned, not by keeping the unclean-shutdown marker until the list is dismissed.
- **boards-6.** Only the toast's Undo brings the camera and toolbar back. They are kept in memory for this session, so a restore from Settings → Trash later doesn't. `restoreTrashedItem` now returns whether the item came back.
- **live-8** covered only the Task List's Table of Contents; the Kanban and Mind Map defaults were clear in the live run. On a window too narrow for the panel beside the list, it still opens in the corner over the list (it has no close button).
- **Items taken from other groups:** lifecycle-5, lifecycle-6, editor-10, legacy-2 and legacy-3 weren't named for this phase. They are user-visible lows that fit no other phase, so I did them here. `legacy-8` (8.3 short names) and `notes-2` (an older copy restored within ~10 s) are left: they aren't UX and need their own look.
- **Tests changed:** `conventionPaths.test.ts` pinned "pin toggled off → the vault root", now the Root Directory. `vaultIndex.test.ts` pinned "attachments/ is ignored". `dueDateFormat.test.ts` now passes a fixed locale and date. `boardCacheDeleteBoardCancelPending.test.ts` matches the delete result instead of equalling it (it now carries `view`). `trashStore.test.ts` wraps the restore in a void callback. The characterisation harness gained `openTabs`, `reopenVaultAfter`, `deleteBoardInBrowser` and `filoReadsTreeNow`.
- **Flaky tests (pulled one fix forward from Phase 6).** `recoverySnapshotKeep.test.ts` ("survives 150 later load-failure snapshots") timed out at 60 s in 2 of 4 full runs. It takes about 6 s alone. The four new characterisation specs add enough disk load to tip it, so its timeout is now 120 s; what it checks is unchanged. `undoAcrossRenames.test.ts` ("undo on a note that is gone") timed out once waiting for its toast under load and passed 3/3 alone and in every other full run. It is left for Phase 6 with ci-1 to ci-3.
- **Housekeeping:** `vault.svelte.ts` stayed at its 1573-line ceiling. CLAUDE.md lists `unreconciledFolderMoves.ts` and `embedPopup.ts`.

### Phase 6 — hygiene
Docs and comment nits, dead code, duplicated validators, flaky tests, and CI (run the coverage ratchet on `main`; consider a scheduled E2E run).

#### Phase 6 status: done (2026-09-28)

All Phase 6 items are done. Two flaky tests turned out to be real product races, and those are fixed too (see the deviations). Each behaviour change has a regression test that I ran against the old code, where it failed; the rest is docs, comments, dead code and CI.

| Item | Fix | Tests |
|---|---|---|
| notes-3 / editor-9 | KNOWN_LIMITATIONS #17 no longer lists "tab characters". A probe of 11 cases showed that a tab inside a line, and (since Phase 5) inside inline code, round-trips. Still read-only: a tab at the start of a heading or list item, or directly before a hard break. The bullet now says exactly that. | (docs) |
| recent-5 / lifecycle-7 | The Hide Vault comment, the `vault:close` handler and the contract doc say Ctrl+Shift+W closes the vault. | (comments) |
| recent-6 | The `vault:stat` doc names its real users (the drift baselines), not the removed `syncTileMarkdown`. | (comments) |
| recent-7 / editor-11 | The TagSweepOutcome JSDoc is back on TagSweepOutcome. | (comments) |
| lists-9 | The Kanban drag controller's doc describes the per-column dndzones and why their items must be exactly the shown cards. | (comments) |
| legacy-6 | README: Find is Ctrl+Shift+F, dropped files go to the board's folder / Root Directory / vault root (not `attachments/`), and it lists Ctrl+Shift+T and Ctrl+Shift+W. The Template Browser hint lists all 7 placeholders (`datetime`, `year`, `month`, `day` were missing). The templates module no longer claims its folder is configurable (it isn't). The drop-handler comment is also fixed. | (docs) |
| recent-8 | CLAUDE.md lists tabNode, tabKeys, boardModules, boardModulePreload, fontStack, generalSettingsDefaults, importedFonts, the four `lib/settings/` modules, tocPlacement, SettingsActionBar and PinIcon. The finished AUDIT21, UI Feedback 3 and UI Feedback 4 plans are in `docs/archive/`. | (docs) |
| legacy-4 | Removed `registerPendingProbe` / `pendingProbes`, the deprecated `manageSentinel` scheduler option and the `hasPendingWrite` alias. None had a production caller. Every "markdown gateway" / "frontmatter scheduler" comment now describes the note writer and its `'pending-path'` mode. | `boardReconcilerDrainRace.test.ts` now marks the path pending through the real ledger (`noteAdditionalPendingPath`) instead of a probe. It still fails with the mark taken out. |
| legacy-5 | Removed dead exports: `readFileContents` (and its gate entry), `ConnectionVisibility`, `ToolbarSize`, `SidebarFloatingBounds`, `SidebarPatch`, `FieldName`, `DndFinalizeResult`. Removed code only tests ran: `spliceBlockMove` (superseded by `spliceBlockContiguous`), `restoreTaskListSlice`, `emptyFrontmatterDelta`, `operatorKey`, with their tests. | `snapshotHelpersDeepClone.test.ts` now pins the deep clone on `snapshotTaskListSlice`, the half the section commands actually use. |
| legacy-7 | `iframeSrcProblem` (`shared/untrusted.ts`) is the one iframe URL rule. `asSafeIframeSrc` and the tile's `isSafeIframeUrl` reason both read it, so they can't disagree. `isValidHex` uses `vaultColor.ts`'s `HEX_COLOR`. The ad-hoc `.toLowerCase()` path folds in `trash.svelte.ts` and `tileCommands.ts` use `vaultPath()` / `samePath()`. | Existing `urlSafety` / `untrusted` / colour tests unchanged and green |
| ci-1 | The three watcher rename-pairing tests wait for the pairing (`vi.waitFor`, 5 s) instead of a fixed 400 ms sleep. | `fileWatcherReconcile.test.ts` |
| ci-2 | `__setSnapshotCapsForTests` lowers the two retention caps. The kept-copy tests cross them with 5–15 snapshots instead of 150 (≈60 s → milliseconds). The test that pins the real cap of 100 keeps its 110 files and gets a 30 s timeout. Temp-vault removal retries (`maxRetries`), so a timed-out test no longer causes a second ENOTEMPTY failure. | `recoverySnapshotKeep`, `recoveryKeepUnsaved`: all three kept-copy cases fail when the prune is allowed to take kept copies |
| ci-3 | The element-style-popup test unmounts any popup a failed or timed-out test left open before resetting history, so its undo step can't leak into the next test. The four-mount test gets a 20 s timeout. | `elementStylePopup.test.ts` |
| ci-4 | The coverage job runs on pushes to `main` as well as PRs. `test:unit:coverage` passes `--disableConsoleIntercept` (see the deviations). | A local run passes every threshold: statements 86.9 %, branches 78.6 %, functions 91.5 %, lines 89.5 % |
| ci-5 | The full Electron E2E and the a11y scan run weekly (Monday 06:00 UTC) as well as on demand. | (CI) |
| ci-6 | Direct unit tests for `settleUnappliedEdits` (no edits, Apply, refused Apply, Discard, Cancel), `newBoardNameProblem` / `freeNewBoardName` (illegal and reserved names, case-only clashes, a board the cache holds before the tree lists it, another folder's board), and `currentBoardHelpers` (`readPath`, boolean selects). | `unappliedEditsPrompt.test.ts`, `newBoardPlace.test.ts`, `currentBoardHelpers.test.ts`. Two mutations of the prompt (wrong tab discarded, refused apply goes ahead) are each caught. |
| ci-7 | `test-unit-strict.mjs` runs vitest's own bin under the current Node with no shell (no DEP0190 warning). `eslint.config.js` is now `eslint.config.mjs` (no MODULE_TYPELESS_PACKAGE_JSON warning on every lint). | (tooling) |
| ci-8 | Audit ids are gone from app source and build config: `blockLayout.ts`, `ui.svelte.ts`, `vitest.config.mts`, `electron.vite.config.mts`. New gate `no-audit-narration` (codebase group, now 69 gates) keeps them out of `src/main`, `src/renderer`, `src/shared` and the three configs. Algorithm steps ("Phase 1 — read…") stay allowed. The dead one-off `scripts/add-aria-hidden.py` is deleted. | The gate fails on an `Audit-23` comment in `ids.ts` and on a `Phase 40 / 40.6` comment in `vitest.config.mts`, and it would have failed on the original vitest comment |

**Verification.** `npm run ci:verify` is green: 659 test files, 6313 tests passed, 5 skipped, 69/69 gates, and the test type-check ratchet. `npm run test:unit:coverage` passes too. A real-app check (built app, Playwright `_electron`, a fresh scratch vault) confirmed:
- **README shortcuts:** Ctrl+Shift+F opens Find and finds a word in a note (1 / 1). Ctrl+T opens the template picker. Ctrl+Shift+W closes the vault back to Home.
- **Template hint:** the picker's empty-state hint lists all 7 placeholders.
- No renderer or console errors.

**Deviations from the plan**

- **Two flaky tests were real races, now fixed in the product.**
  - **Undo after another program deletes a note.** `undoAcrossRenames` "undo on a note that is gone" (left open in Phase 5) failed in 2 of 4 runs *alone*. For a second or two after another program deletes an open note, before the watcher's missing-file hold and the model's own check finish, the note model still holds its last frontmatter. An undo in that window skipped the "is it gone?" probe and queued a write. That write then failed with a sticky "Couldn't save changes… the file no longer exists" instead of the documented *Couldn't undo* with **Skip this step**. `applyDeltaChecked` now asks main whether the file exists even when the model answered. The cost is one IPC per undo leg. After the fix: 5/5 passes. New unit case in `commandRenamePath.test.ts`; it fails on the old code.
  - **Tree read for the vault being left.** `newVault` failed under coverage load. A sidebar tree read sent for the vault being left came back NO_ACTIVE_VAULT once main had released it, and it showed a "Could not read vault tree… may be out of date" error toast over the new vault. `refreshTree` now stays quiet for that refusal while a swap is in progress, or when the vault changed during the read. The same refusal for the vault still open still toasts. New `treeReadAfterSwap.test.ts`; it fails on the old code. `vault.svelte.ts` shrank by a line, so its size ceiling is now 1572.
- **Coverage run: console capture off.** Before `main` could run the coverage job, two local runs had to pass. The first failed on the two races above. The second passed every test and threshold, but it still exited 1 on 8 "Closing rpc while onUserConsoleLog was pending" worker-teardown errors. These appear only under the instrumented full suite's load and never with a file alone. `--disableConsoleIntercept` removes them; the next run exited 0. The strict runner, which reads the console output, still captures it.
- **Fuzz timeouts.** The three `frontmatterInvariant` fuzz cases (300–400 generated notes each) get an explicit 30 s timeout. One hit the 5 s default under coverage.
- **ci-8, test files not swept.** About 159 test files still carry Audit / Phase ids in their comments. Rewriting them is churn with no behaviour change, and the audit's own fix asked for at least the production references and the config, which are done. The new gate covers app source only.
- **legacy-5, kept on purpose.** `contrastRatio` (the theme-contrast tests' measuring tool), `isVaultPath` and `isCorruptConfig` (type guards over exported types), and `getEdgePanScope` (a documented test accessor).
- **ci-5.** The E2E and a11y jobs have never run on a GitHub runner automatically. The first scheduled run is their first unattended run, so it may need fixes. I chose a weekly run over running the smoke test on every push to `main`, so a problem with the Linux runner can't turn every push red.
- **ci-6.** `updatePath` (a one-line pass-through to `pendingSettingsStore.updateBoard`) and the other indirectly covered modules (`renameGrace`, `leftBehind`, `viewportCache`) got no new direct tests.
- **lifecycle-7.** No visible Close Vault entry was added. Removing it was your decision in f315ccc; only the stale comments were wrong.
- **Still open:** `mindmap-10` (tile copy / paste, which needs a decision on whether a duplicate shares the note). So this plan stays in `docs/`, not `docs/archive/`. `legacy-8` (8.3 short names) was closed by Audit-28 Phase 7, task 7.1 (2026-10-06): the `.filo/` guards check the path as the disk names it. `notes-2` (an older copy restored within ~10 s) was closed by Audit-28 Phase 8 (2026-10-06): the audit found it no longer reproduces for notes, since main and the note writer each count only the latest bytes Filo wrote; `noteWritePathEdges.test.ts` and `watcherOwnWriteBytes.test.ts` pin it.

## Also checked and found sound

- **Note save path:** every note write is a change applied to a fresh read. The main process refuses STALE writes on every lock-retry rename. Keep mine backs up the exact bytes it overwrites. Keystrokes typed into a replaced body are held as a conflict, and own-write echoes are recognised by hash on both sides. BOM, CRLF and comments are preserved (probed), and the new Tab node round-trips byte for byte.
- **Trash and recovery:** trash is manifest-first with a single rename. Restore never overwrites (hard-link or re-checked rename), and the manifest is treated as untrusted. The vault swap is a transaction, and quit has a heartbeat and a deadline.
- **Settings and themes:** Apply refuses a schema-invalid slice and clamps numbers. Per-tab Revert and Apply work. All 5 built-in themes define all 92 tokens, and theme values are sanitised before any CSS sink.
- **Security:** a sandboxed renderer, Zod-validated IPC, allowlisted receive channels, layered path guards, the `filo://` protocol behind the same guards, and a CSP.
- **Recent changes:** no data-loss regression across the 19 commits. `board:create` is now exclusive, and the BoardRouter scope pin fixes a real wrong-board write.

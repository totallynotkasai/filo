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

### Phase 5 — workspace polish
Restore Document tabs, board-folder name and reuse rules, the recovery-modal wording, the Root Directory with board folders on, and the remaining UX lows.

### Phase 6 — hygiene
Docs and comment nits, dead code, duplicated validators, flaky tests, and CI (run the coverage ratchet on `main`; consider a scheduled E2E run).

## Also checked and found sound

- **Note save path:** every note write is a change applied to a fresh read. The main process refuses STALE writes on every lock-retry rename. Keep mine backs up the exact bytes it overwrites. Keystrokes typed into a replaced body are held as a conflict, and own-write echoes are recognised by hash on both sides. BOM, CRLF and comments are preserved (probed), and the new Tab node round-trips byte for byte.
- **Trash and recovery:** trash is manifest-first with a single rename. Restore never overwrites (hard-link or re-checked rename), and the manifest is treated as untrusted. The vault swap is a transaction, and quit has a heartbeat and a deadline.
- **Settings and themes:** Apply refuses a schema-invalid slice and clamps numbers. Per-tab Revert and Apply work. All 5 built-in themes define all 92 tokens, and theme values are sanitised before any CSS sink.
- **Security:** a sandboxed renderer, Zod-validated IPC, allowlisted receive channels, layered path guards, the `filo://` protocol behind the same guards, and a CSP.
- **Recent changes:** no data-loss regression across the 19 commits. `board:create` is now exclusive, and the BoardRouter scope pin fixes a real wrong-board write.

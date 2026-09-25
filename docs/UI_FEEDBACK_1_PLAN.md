# UI Feedback Round 1: Implementation Plan

Source: the first hands-on test run (2026-09-25). This plan covers every issue raised, what the code shows is behind each one, and the fix. Decisions the user made are marked **Decided**. Other choices are marked `DECISION:` and can be changed before the phase starts.

Each phase leaves a working app, passes `npm run ci:verify`, and is committed on its own. Paths are relative to the repo root.

| Phase | Scope | Risk |
|---|---|---|
| 1 | Focus-trap crashes, Board Browser accessibility | Low; touches every modal |
| 2 | Insert link, heading dropdown | Medium; touches the editor and the markdown round-trip |
| 3 | Minimap, multi-selection context menu | Low |
| 4 | Sidebar tag filter, Tags Browser search | Low |
| 5 | Remove Properties, Export and Sync All | Low; mostly deleting code |
| 6 | Save-state colours, palette-and-brush Style icon | Low |

---

## Phase 1: Focus-trap crashes and Board Browser

### What goes wrong

- **Tab in a text tile throws** "Your focus-trap must have at least one container with at least one tabbable node".
- **Opening a board from the Board Browser** logs "Blocked aria-hidden…" and then the same focus-trap error.

### Why (one shared cause)

All focus traps share a single global stack (focus-trap 8.2.2). A closed dialog is supposed to take its trap off that stack.

- `src/renderer/lib/utils/focusTrapSafe.ts:19` returns early when the host element is already detached. The host sits inside an `{#if}`, so it is **always** detached by the time teardown runs.
- Every close therefore leaks a live trap. The trap keeps its document `keydown`, `mousedown` and `focusin` listeners, and its container is a detached node.
- **Tab path:** the next Tab goes to `checkTabKey` → `updateTabbableNodes` on the detached container, which finds no tabbable node and has no `fallbackFocus`, so it throws.
- **Mousedown path:** the next mousedown anywhere runs the leaked trap's `clickOutsideDeactivates`. That deactivates it and unpauses the leaked trap below it, and that unpause throws.

Leaking call sites:

| Component | Location |
|---|---|
| Board Browser (AppShell) | `src/renderer/components/layout/AppShell.svelte:61-89` |
| Modal | `src/renderer/components/shared/Modal.svelte:45-72`. The effect also has no cleanup, so a parent `{#if}` destroying the Modal never deactivates it. |
| ConfirmDialog | `src/renderer/components/shared/ConfirmDialog.svelte:31-72` |
| KanbanSideToolbar | `src/renderer/components/boards/KanbanSideToolbar.svelte:242-260` |
| KanbanNewTileModal | `src/renderer/components/boards/KanbanNewTileModal.svelte:33-51` |
| KanbanTemplatePicker | `src/renderer/components/boards/KanbanTemplatePicker.svelte:110-139` |
| GlobalToolbar save popover | `src/renderer/components/layout/GlobalToolbar.svelte:108-141`. It has `fallbackFocus`, so it is harmless, but it is fixed anyway. |

**The aria-hidden warning** is separate. The Board Browser panel (`role=dialog`) is nested *inside* `div.board-browser-backdrop aria-hidden="true"` (`AppShell.svelte:598-634`), so its focused close button sits under a hidden ancestor.

A side issue: `TileStylePopup.svelte:269` reads `boardStore.current?.id` inside the trap `$effect`. That makes the board id a dependency, so the trap is rebuilt whenever the board changes.

### Fix

1. **`focusTrapSafe.ts`:** always call `trap.deactivate()`, whether or not the host is attached. Keep the try/catch. Fix the comment: deactivate throws only when a trap below it has leaked, never because the host is detached.
2. **Deactivate on close at every site listed above.** Each `$effect` returns a cleanup that calls `safeDeactivateTrap(trap)`, so a parent `{#if}` destroying the component also releases the trap. Drop the `host:` argument everywhere.
3. **Give every trap a `fallbackFocus`** pointing at its own container, with `tabindex="-1"` added where it is missing. This covers Modal, ConfirmDialog, the Board Browser, TagEditor and the three Kanban dialogs. `updateTabbableNodes` can then never throw.
4. **Board Browser markup:**
   - Make the backdrop an empty sibling *behind* the panel, not its parent, and remove its `aria-hidden`.
   - Use `clickOutsideDeactivates: false`, because the backdrop click already closes the browser.
   - Don't return focus to the previous element when a board was opened from the browser.
5. **`TileStylePopup.svelte:269`:** read the board id with `untrack` so it isn't an effect dependency.

### Tests and gates

- New component test: open and close a Modal, a ConfirmDialog and the Board Browser. Then press Tab inside a contenteditable and mousedown on the canvas. There should be no error, and focus-trap's stack should be empty.
- New `ci:gates` check (`components` group): every `createFocusTrap(` call passes `fallbackFocus`, and no `safeDeactivateTrap(` call passes `host:`. Prove it bites before relying on it.

### Status: done (2026-09-25)

Fix steps 1–5 are implemented as written, with the deviations below.

- **Tests:** `src/tests/component/focusTrapRelease.test.ts` mounts the real `AppShell`. It covers the Modal, ConfirmDialog and Board Browser open/close cycle, then Tab in a contenteditable and mousedown elsewhere, plus a confirm stacked over a modal, the backdrop being a sibling, and focus returning when the browser is dismissed. It fails 3/3 against the pre-fix code.
- **Gate:** `focus-trap-release` is in `scripts/gates/components.mjs`. It fails when a `fallbackFocus` is missing, when `host:` is passed, or when a trap is never released in a teardown. All three were proven by planting the violation and reverting it. The gate count is now 61, and CLAUDE.md is updated.
- **Real app:** a Playwright script drove the built Electron app against a scratch vault. It opened the Board Browser, opened a board from it, pressed Tab in a text tile, clicked the canvas, closed the Board Browser by its backdrop, and opened and closed Project Settings. With the fix there were no console errors or warnings. On the pre-fix build, the same script throws the reported "Your focus-trap must have at least one container…" error on Tab after the modal closes.
- `npm run ci:verify` passes.

### Deviations from the plan

1. **The gate checks one more thing than planned.** It also fails when a file creates a trap but no teardown (`return () => …` / `onDestroy`) calls `safeDeactivateTrap`. Fix step 2 is the actual leak, and without this check the gate wouldn't catch it coming back.
2. **The `fallbackFocus` requirement covers every trap, not just the sites listed in step 3.** The five style popups (Tile, Frame, Connection, Task item, Task section) and the two Kanban style popups already had it. The Kanban Reorder Columns dialog, KanbanNewTileModal and GlobalToolbar already had `tabindex="-1"`. `tabindex="-1"` was added to the Modal `<dialog>`, the ConfirmDialog `<dialog>` and the KanbanTemplatePicker card.
3. **How "a board was opened from the browser" is detected (step 4).** BoardBrowser now takes an `onBoardOpened` prop and calls it from every open path (click, Alt+click split, multi-select, create) before it closes itself. The trap's `setReturnFocus` returns `false` when that flag is set. Dismissing the browser (close button, Esc, backdrop) still returns focus to the opener. The first attempt compared the active tab before and after instead, but the real-app run showed it fails when the chosen board is already the active tab.
4. **The `untrack` fix (step 5) was applied to all three popups with the same pattern:** `TileStylePopup`, `ConnectionStylePopup` and `FrameStylePopup` all read `boardStore.current?.id` inside their trap `$effect`.
5. **Other small hardening beyond the plan:**
   - ConfirmDialog now runs its effect once per config, so a confirm that displaces another re-seeds its checkbox and focus. Its cleanup closes the `<dialog>`.
   - KanbanTemplatePicker activates its trap inside `untrack`, because `initialFocus` reads `searchInputEl` and would otherwise make it an effect dependency.
   - The GlobalToolbar popover guards against a close landing before its `tick()`, which would otherwise create a trap after its own cleanup had run.
   - The Board Browser backdrop's dead `onkeydown` was removed; it is not focusable, and the panel handles Esc.
6. **The component test borrows the characterisation harness's DOM polyfills** (`src/tests/characterisation/harness/domPolyfills.ts`) for `<dialog>`, client rects and observers, instead of duplicating them.

---

## Phase 2: Editor (links and headings)

### 2a. Insert link

**What goes wrong:** no link could be inserted at all, **even with text selected**.

**Not yet reproduced.** With a selection, the code path looks correct on paper: the toolbar button keeps editor focus (`IconButton` prevents default on mousedown), the popup saves the editor and range, and Apply runs `setTextSelection → extendMarkRange('link') → setLink`. The editor stays editable when it blurs, and the toolbar is always mounted. So the selected-text failure is not explained by reading alone.

**Step 0 of this phase is to reproduce it** in `npm run dev`, with DevTools open, before any fix. Record:
- Does the popup appear?
- Does the URL input take focus and accept typing?
- Does Apply run, and what does the chain return?

Suspects, in order:

1. **Phase 1's leaked focus traps.** A leaked trap's `focusin` listener treats focus moving to the popup's input as having escaped its (detached) container. It calls `stopImmediatePropagation()` and tries to pull focus back. Typing can then go nowhere, or into the editor over the selected text. This happens after any Modal, ConfirmDialog or the Board Browser has been opened once, which is likely in a test run. **Phase 1 lands first, so re-test after Phase 1 before changing link code.**
2. **The popup is not portalled.** It renders inside the toolbar's stacking context (`--z-toolbar`, 1100). Its full-screen overlay and the popup can be covered by, or lose clicks to, canvas layers with a higher z-index.
3. **The chain** refuses silently in a case the refused-href toast doesn't cover. Log the return value of each step while reproducing.

Whatever the cause, a new component test drives the *real* path: mount a TextTile, select text, click the toolbar's link button, type a URL into the popup, press Enter, and check the saved `.md`. Today's round-trip test only calls `tiptapToolbar.setLink()` directly, which is why this slipped through.

**Other defects found while reading** (`src/renderer/components/layout/TextFormattingToolbar.svelte:68-127`, `LinkInsertPopup.svelte`):

1. **Nothing is inserted without a selection.** With a collapsed caret, `extendMarkRange('link').setLink()` only sets a stored mark. No text is inserted and no error is shown. The popup has no "text to show" field.
2. **Any click on a link opens it immediately, even while editing.** The document capture-phase listener at `AppShell.svelte:468-500` does this, so the caret can never be placed inside a link to edit it.
3. **Links without a scheme are dead.** `example.com` is saved as-is, but the click handler only opens `https?:`, `mailto:`, `tel:` and `filo:` links.
4. **The popup can be covered.** It isn't portalled; it renders inside the toolbar's stacking context (`--z-toolbar`), so tile popups can cover it.
5. **The button never looks active.** The toolbar has no "link active" state.

Markdown is not a limitation here. A link is stored as `[text](https://…)`, which tiptap-markdown already round-trips (`src/tests/unit/toolbarFormattingRoundTrip.test.ts:116-130`).

**Fix:**

1. **LinkInsertPopup gets two fields: Text and URL.**
   - With a selection or a caret inside a link, Text is pre-filled and edits the existing link.
   - With an empty caret, Apply inserts the text (falling back to the URL) as a new link node: `insertContent({ type: 'text', text, marks: [{ type: 'link', attrs: { href } }] })`.
2. **Normalise the URL on apply.** A URL with no scheme that looks like a domain gets `https://` added. `filo://` links and existing schemes are left alone. `javascript:` and similar are still refused with the existing toast.
3. **Clicking a link:**
   - `DECISION:` in an editable, focused editor, a plain click places the caret, and **Ctrl+click** (Cmd on macOS) opens the link.
   - Anywhere else (a read-only view, or a tile that isn't being edited), a plain click opens it.
   - The link tooltip says "Ctrl+click to open".
4. **Portal the popup to `<body>`** (`use:portal`) with z-index `--z-tile-popup` or above, and clamp it to the viewport.
5. Add `link: boolean` to the synced toolbar state so the button highlights when the caret is inside a link.
6. Ctrl+K keeps opening the same popup (`AppShell.svelte:382-385`).

**Tests:**
- Insert with an empty caret, insert over a selection, and edit an existing link; each saves and reloads as `[text](url)`.
- Scheme normalisation.
- The click rules: plain click in an edited tile does not open the link; Ctrl+click does.
- Add a save → reload case per the `toolbar-formatting-saved` gate.

### 2b. Heading dropdown

**What goes wrong:** the headings don't look different from each other.

**Why:**
- The options are mislabelled. "Title" is h1, "Subtitle" is h2, and "Heading 1–3" are actually h3–h5. There is no h6 option, so an h6 heading shows a blank select.
- There are no heading font sizes for text tiles, so browser defaults apply relative to the tile's 13px body: h4 is the same size as body text and h5 is smaller.
- `DocumentEditor.svelte:458-501` styles only h1–h3.
- An inline `fontSize` mark (from the size buttons or pasted text) overrides the heading size.

**Fix:**
1. **Decided:** the options are **Normal text** and **Heading 1** to **Heading 6**, mapping directly to h1–h6. Each option previews its size.
2. Add an explicit, graded scale to `src/css/style.css` for `.tiptap h1…h6` (em-based, so it follows the tile's body size), for example 2.0 / 1.6 / 1.35 / 1.15 / 1.0 / 0.9em. h5 and h6 are distinguished by weight and letter-case rather than being smaller than body text. Add the h4–h6 rules to DocumentEditor.
3. **Decided:** applying a heading (or Normal text) overrides other text formatting in the affected blocks. `DECISION:` this removes the `textStyle` mark (font size, font family and colour) over the block range. Bold, italic, underline, strike, code and links are kept, because they change meaning, not size or look. Say if you want those cleared too.

**Tests:** a save → reload for each level; applying a heading removes an inline font-size span.

---

## Phase 3: Canvas

### 3a. Minimap

**What goes wrong:**
- On a big mind map with a far-away tile, the minimap looks blank.
- Its colour ignores the board background.

**Why:**
- The minimap always fits *every* tile plus the viewport (`src/renderer/lib/canvas/minimapBounds.ts:72-97`), with no cap. One distant tile makes `mapScale` tiny: everything else collapses to a few dots, and the viewport box shrinks to its 10×8px minimum.
- `computeTilesAABB` doesn't filter out non-finite coordinates. A NaN or Infinity position makes every pip `NaNpx`, which is truly blank.
- `Minimap.svelte:356-366` uses a fixed `var(--ui-surface)` background.

**Fix (Decided: scale with zoom and focus on the local area):**
1. **Replace fit-all with a local window.** The minimap shows a region centred on the viewport centre, `LOCAL_FACTOR` (≈4) times the viewport's canvas width and height.
   - Zooming out widens the window and zooming in narrows it, so the minimap scales with zoom.
   - The viewport box stays a constant, readable size in the middle.
   - The window is never smaller than the tiles bounding box if that box is smaller, so a small board still shows whole.
2. Tiles and waypoints outside the window are clipped (`overflow: hidden`, as today). Click and drag on the minimap use the same local transform, so navigation stays correct.
3. Skip tiles with non-finite position or size, both in the bounding box and as pips.
4. **Background colour.**
   - MindMapBoard passes `bgColor={viewModel.bgColor}` into `<Minimap>` (`MindMapBoard.svelte:757`), with `var(--canvas-bg)` as the fallback. This is the same resolved colour the board background uses, including unsaved Settings edits.
   - The minimap derives a slightly contrasted shade for its own fill.
   - It picks a light or dark viewport-box stroke from the background's luminance, using a helper in `lib/utils/color.ts`.

**Tests:**
- `minimapBounds.test.ts`:
  - The local window follows the viewport and scales with zoom.
  - A far-away tile doesn't change the scale.
  - Non-finite tiles are ignored.
- A unit test for the contrast helper.

### 3b. Right-click with several tiles selected

**What goes wrong:**
- Right-clicking empty canvas with a multi-selection offers no Lock/Unlock (Ctrl+L already works).
- **Found while investigating:** Lock/Unlock in a *tile's* context menu only toggles the clicked tile, not the selection (`MindMapBoard.svelte:240-248`).

**Fix (Decided: all actions, applied to every selected tile):**
1. In `buildCanvasContextMenu` (`src/renderer/lib/mindmap/mindMapContextMenus.ts:110-165`), when 2 or more tiles are selected, prepend a "N tiles selected" group:
   - **Lock / Unlock (N tiles):** same rule as Ctrl+L. If any tile is unlocked, lock them all; otherwise unlock them all.
   - **Tags (N tiles)**
   - **Style (N tiles)**
   - **Delete (N tiles)**
   - then a divider.
2. **Move the lock logic out of the Ctrl+L handler** (`AppShell.svelte:363-377`) into a shared `toggleLockSelection()` helper. The hotkey and both context menus call it through `boardStore.setTilesLockedWithHistory`, so it is one undo step.
3. Fix the tile context menu's Lock to use `toggleLockSelection()` whenever the clicked tile is part of the selection.
4. **Multi-tile Style.**
   - TileStylePopup takes an optional `tileIds` list. The popup is seeded from the right-clicked or first selected tile, and its header reads "Style: N tiles".
   - Each pick is applied to every tile in the list.
   - On close it pushes one `BatchCommand` of `UpdateTileStyleCommand`s, so the whole session is one undo step.
   - Tiles of mixed types only get properties they support (e.g. no body font on an image tile).
5. Tags and Delete reuse the existing selection-aware paths behind the tile menu's "Tags (N tiles)" and Delete.

**Tests:**
- Menu contents with 0, 1 and N selected.
- One undo reverts a multi-lock and a multi-style.
- The tile-menu lock covers the whole selection.

---

## Phase 4: Tags

### 4a. Clicking a tag chip in the sidebar filters the tree

**Current state:**
- The chips on file rows (`src/renderer/components/sidebar/VaultFileItem.svelte:88-97, 566-577`) have no click action. A click falls through to row select.
- The comment at 89-91 wrongly says a click opens the tag editor.

**Fix (Decided: filter, not select):**
1. Clicking a chip sets a sidebar **tag filter**. The tree then shows only:
   - files carrying that tag (notes via frontmatter, media via `.filo/tags.json`), using `fileTagsStore.filesForTag(tag)`; confirm it covers notes, otherwise union it with the vault index;
   - their ancestor folders, auto-expanded.
2. A removable **"#tag ×"** pill appears in the sidebar search bar. It combines with the name search (both apply). Clicking the pill's ×, clicking the same chip again, or pressing Esc in the search box clears it.
3. Clicking a different chip replaces the filter. Child tags match hierarchically: filtering by `project` also shows files tagged `project/a`.
4. The filter is sidebar view state, not persisted, and it resets on vault swap (`vaultIdentity` gates). Convert `filesForTag`'s vault-relative paths to the tree's absolute `node.path`.
5. Chips become real `<button>`s with an accessible name ("Filter by tag X"), and the stale comment is removed.

**Tests:**
- The filter shows matching files plus their ancestors.
- It combines with name search.
- It clears.
- It resets on vault swap.
- Child tags match.

### 4b. Search in the Tags Browser

**Current state:** `src/renderer/components/tags/TagsBrowser.svelte` offers only scope buttons (All / Files / Tiles) and no text filter. `visibleTags` also calls `getTilesWithTag` (a walk of every board) once per row, on every re-render.

**Fix:**
1. Add a search input above the scope buttons. It autofocuses when the browser opens and filters case-insensitively on the full tag path, so `proj` matches `work/project`. When a child tag matches, its parent rows stay visible so the hierarchy still reads. Esc clears the search first; a second Esc closes the modal.
2. Show an empty state: "No tags match 'x'".
3. Compute a tag → counts map once per render (`$derived`) instead of per row.

**Tests:** filtering, parents kept, and Esc behaviour.

---

## Phase 5: Removals

### 5a. Remove the Properties popup

**Decided:** remove it. Frontmatter fields are edited through dedicated controls (title double-click, Tags button, task and card controls), or by hand in the `.md` file. Any future frontmatter field gets its own dedicated control rather than a generic form.

**Delete:**
- `src/renderer/components/tiles/PropertiesPopup.svelte`
- `src/renderer/lib/utils/propertyRowTypes.ts` and `src/tests/unit/propertyRowTypes.test.ts`
- The header button and `toggleProperties` (`TileHeader.svelte:456-463, 533-541`)
- The `tile-properties` listener and the popup render (`TileContainer.svelte:227-245, 387-398`)
- `src/tests/unit/propertiesPopupBoardScope.test.ts` and `src/tests/unit/propertiesPopupNestedFrontmatter.test.ts`
- Cases in `dragPaneScopeAndPropertiesUndoRead.test.ts` and `undoNeverOpenedNoteAndPropertiesConflict.test.ts` that mount the popup. Keep any case that covers `UpdatePropertiesCommand` directly.

**Keep:** `UpdatePropertiesCommand` (`src/renderer/commands/propertiesCommands.ts`) and its tests, because `components/tags/NoteTagRow.svelte:57` uses it for Document-tab tag edits.

**Update:**
- The gates: `scripts/gates/commands.mjs:250-258` (the popup's mount-board check) and `scripts/gates/writePath.mjs:167` (the popup write-path entry).
- Comments naming PropertiesPopup: `src/main/ipc/vault.ipc.ts:678`, `src/renderer/App.svelte:43`, `src/renderer/stores/vault.svelte.ts:1167`, `src/renderer/lib/boards/writeSchedulerTypes.ts:248`.
- CLAUDE.md, in two places: the tree entry for `PropertiesPopup.svelte`, and `propertiesCommands.ts`, which stays but is described as the tag-row delta command.

**Remove tile `metadata` too (Decided: no legacy data to support).** It exists only to hold values from the Properties popup on media and board-only tiles; nothing else reads it. (`runSearch.ts` and `vaultIndex.ts` use a different `metadata`, the vault index's, which stays.)

Remove it from:
- the tile def schema: `TileMetadataSchema` and its two uses (`src/renderer/schema/tile.ts:256-273`)
- the runtime tile schema (`src/renderer/schema/placement.ts:153-154`)
- `tileDefBuilder.ts:68-69, 79-101, 135-136`

The board file stays `version: 8`. No existing board carries the field, so no migration is needed.

Check whether the def schemas are `.passthrough()` for this field. If they are, an unexpected `metadata` key would be carried through rather than dropped; that is acceptable here because none exists.

**Remove the Task List "Properties…" inspector (Decided).** `src/renderer/components/modals/TaskPropertiesModal.svelte` is a read-only debug view: tile id, file path, timestamps, and the raw frontmatter and placement as JSON. The row controls already edit every field, and the `.md` file shows the rest.

Delete:
- the modal
- `openTaskProperties`, `taskPropertiesContext` and its `$effect`, and the `<Modal id="task-properties">` block (`TaskListBoard.svelte:49, 1085-1115, 1652-1660`)
- the `onShowProperties` prop and the "Properties…" context-menu entry (`TaskItem.svelte:71, 127-128, 456-459`)
- any test that references them

`TaskListBoard.svelte` is on the 1000-line allowlist, so the ceiling in the gate should drop to its new size.

### 5b. Remove Export from the project dropdown

**Decided:** remove it.

**Delete:**
- The Export submenu and `handleExport` (`src/renderer/components/layout/ProjectDropdown.svelte:64-97, 154-183`). Delete the submenu CSS only if nothing else uses it.
- `src/renderer/lib/export/exportService.ts` (its only importer is ProjectDropdown).
- `src/main/ipc/export.ipc.ts` and its registration (`src/main/ipc/index.ts:7, 28`).
- The `export:save` channel from:
  - `src/shared/types.ts:115-116`
  - `src/shared/ipcContracts.ts:449-461`
  - `src/shared/ipcSchemas.ts:175-178`
  - `src/tests/unit/ipcEnvelopeAllChannels.test.ts:86`
- `PAYLOAD_LIMITS.MEDIA` (`src/main/utils/payloadLimits.ts:58-66`), used only by export.
- `src/tests/unit/exportSaveCap.test.ts`.
- **Canvas export mode:** `exportMode` / `setExportMode` in `stores/canvas.svelte.ts`, and their reads in `lib/mindmap/visibleTilesViewModel.svelte.ts:82` and `components/connections/ConnectionLayer.svelte:100-109`. Also adjust the tests that touch it: `canvasFlyToCancel.test.ts:106` and `canvasViewportPersist.test.ts:99, 181-187`.
- The npm dependencies `html-to-image` and `jspdf`.

**Update:**
- The stale comment at `stores/boardCacheKanban.ts:160-161`.
- CLAUDE.md: the Export row of the tech stack, the `export.ipc.ts` and `lib/export/` tree entries, and the `board:export-png` naming example.

`ipcChannelParity.test.ts` must pass with both sides removed.

### 5c. Remove "Sync all tiles on this board"

**Decided:** remove it. Boards no longer hold note content, so it only flushes this board's notes, which is a subset of **Save**. It also reports non-text tiles as "synced".

**Delete:**
- The menu item and `handleSyncAllTiles` (`ProjectDropdown.svelte:46-62, 184-192`).
- `syncAllOnBoard` (`src/renderer/stores/boardCache.svelte.ts:697-726`).

**Keep:** `syncTileMarkdown` and `syncTile`. The broken-link **Recreate backing file** action uses them (`TileHeader.svelte:313`).

---

## Phase 6: Visual polish

### 6a. Save-state indicator colours

**Current state:**
- The floppy icon beside the project dropdown is `GlobalToolbar.svelte:163-199`. It is a status indicator driven by `saveStateStore` (`idle | saving | saved | error`), not a button.
- It is clickable only in the error state, when it opens the failed-files popover. In the idle state it looks like a Save button that does nothing.

**Fix (Decided: colour carries the state):**

| State | Colour token | Icon | Tooltip |
|---|---|---|---|
| idle / saved | `--accent-success` (green) | check-circle | "All changes saved" |
| saving (writes pending or in flight) | `--accent-warning` (yellow) | spinner | "Saving…" |
| error | `--accent-danger` (red) | alert-circle | "Save failed — click for details" |

1. Replace the floppy icon; it is what made the indicator look like a button. Each state keeps a distinct icon *and* colour, so the state doesn't rely on colour alone (a11y).
2. `saved` no longer decays to a separate neutral idle. Green means "everything written".
3. Show yellow whenever there is pending, in-flight or queued work (`unsavedWork()` is not empty), not only while an IPC call is in flight. Debounce it about 150 ms so fast saves don't flicker.
4. Red stays clickable with the existing popover (failed files plus **Retry save**). The pointer cursor appears only in red.
5. Check that all three colours read against every built-in theme's toolbar background. Add themed token overrides if one fails.

**Tests:** state → colour/icon mapping, and that pending work shows yellow.

### 6b. One Style icon: palette and brush

**Fix:** add `src/renderer/components/shared/StyleIcon.svelte`, a lucide-style palette with a brush (24×24 viewBox, 2px stroke, `size` prop). Also add a matching path-string constant for context menus, `STYLE_ICON_PATH` in `src/renderer/constants/icons.ts`. Then replace every Style glyph:

| Where | Location |
|---|---|
| Tile header | `components/tiles/TileHeader.svelte:584-585` |
| Frame header | `components/frames/Frame.svelte:649-656` |
| Connection label | `components/connections/ConnectionLabel.svelte:444-449` |
| Task row | `components/boards/TaskItem.svelte:770-779` |
| Task section | `components/boards/TaskListSection.svelte:257-271` |
| Tile and frame context menus | `lib/mindmap/mindMapContextMenus.ts:21-26, 69-74` |
| Kanban column / card Style menus | `components/boards/KanbanColumn.svelte:399, 445-449` |
| Style entries that have no icon today | `connections/ConnectionLayer.svelte:127-133`, `boards/TaskListBoard.svelte:496`, `boards/KanbanColumn.svelte:610` |

The Settings gears (`ProjectDropdown.svelte:196`, `ProjectSettings.svelte:118`) are **not** style buttons and stay.

Update CLAUDE.md's Icons note (it says there is no shared icon location).

---

## Out of scope / not changed

- The board file version (stays v8; only the unused `metadata` field goes).
- Waypoint emoji icons (user content, per CLAUDE.md).

## Verification per phase

- `npm run ci:verify` passes (lint → check → typecheck:main → test:unit:strict → build → ci:gates).
- A manual run in `npm run dev` of the issue's original steps, with no errors in the console.

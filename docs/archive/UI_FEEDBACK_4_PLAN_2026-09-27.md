# UI Feedback 4: implementation plan (2026-09-27)

This plan comes from the first real test run. It covers:
a pin for the floating board toolbars, replacing the sidebar's Close Vault button with
Hide Vault, the Smart connection route, a Vault Sidebar settings section, and
board-specific folders.

It ships as six phases. Each phase is its own commit and must pass `npm run ci:verify`
before the next one starts. Nothing is pushed until the user says so.

Order: **0 → 1 → 1b → 2 → 3 → 4 → 5**. Phase 1b was added after Phase 1 found its bug. Phase 0 fixes existing bugs in the folder-pin and
vault-name code that Phase 5 builds on. Every board gets a pin once board folders are
on, so these bugs would get much more visible.

## Decisions already made

| Question | Answer |
|---|---|
| Which toolbars get the pin | Mind Map, Kanban **and** Task List. The Task List toolbar can't be moved today, so it becomes draggable too. |
| Pin scope | **Per board.** The toolbar position is per board as well (Kanban's is one shared value today). |
| Sidebar Close Vault button | Becomes **Hide Vault**, which hides the sidebar. It keeps the door icon, and its arrow flips with the shown / hidden state. |
| Top-left sidebar toggle | Moves to the far left of the global toolbar, is always visible, and keeps its current panel icon. |
| Remember hidden sidebar | Yes, across restarts. |
| Closing a vault | Stays on Ctrl+Shift+W and is added to the vault name dropdown. |
| Smart connections | **Fix, don't remove.** Give Smart the same stubs along the bubble normal that Elbow has. |
| Vault settings location | A **Vault Sidebar** section inside the existing **General** tab. There is no new tab. |
| Sort by / Group by | The same setting the sidebar buttons change. The section is a second place to set it. |
| Vault colour | Shown in the Home recent-vaults list, the sidebar header, and the vault name in the global toolbar. |
| Where a board's `.board.json` lives with board folders on | Inside its folder. |
| Board name vs file name | **Always identical, for every board.** Renaming either renames the other. |
| Illegal characters in a board name | Blocked in the name field, with an inline message. |
| Board delete | Unchanged. Only the `.board.json` goes to Filo's trash; the folder and its files stay. There is no prompt. |
| Existing boards / legacy data | No legacy support. The user has not started using Filo yet, so no migration is needed. |
| Root directory model | **One pin** (see Phase 5). With board folders on, "Use as root directory" is the active board's folder. With them off, it is the vault-wide Root Directory. With no pin, files go to the vault root. |
| Root directory button | Green while active. |
| What goes in a board folder | Everything the board creates: cards, tasks, dropped files, audio recordings, File-tile picks, cover and background images. |

---

## Phase 0: Folder-pin and vault-name bugs

These were found by reading the code while planning. Each fix gets a regression test
that fails before the fix.

### 0a. Renaming the vault is not saved

`vaultStore.setName` (`stores/vaultProject.ts:12-16`) sets `project.name` and marks the
metadata dirty. The `app.json` writer (`lib/boards/configWriteScheduler.ts`) serialises
only `settings.general`, and nothing copies `project.name` into it. The rename is lost
when the vault is reopened.

Fix: the `app.json` payload carries `name` from `project.name`. Test: rename, save, reload
the candidate, and assert the name.

### 0b. Dropping a file onto a mind map fails while a folder pin is set

`lib/canvas/dragDrop.ts:159` builds `targetDir` as an **absolute** folder
(`getActiveContentFolderAbs(...) || vaultDir`). It then passes it as the **vault root**
argument of `copyFileIntoVault` (`:222`, `:241`). The main handler calls
`assertActiveVault(vaultPath)` (`main/ipc/vaultCopy.ipc.ts:55`), which needs an exact
match, so the copy is refused.

Fix: `copyFileIntoVault(sourcePath, vaultRoot, relFolder)`, using the handler's existing
`destFolder` argument.

### 0c. Pins reset instead of following a folder renamed outside Filo

The watcher reports a folder renamed outside Filo as a series of per-file renames
(`Old/a.md → New/a.md`). None of them match the pin `Old`. `refreshTreeAndCleanup`
(`stores/vault.svelte.ts:1314-1328`) then sees `Old` missing and **clears** both
`activeRootFolder` and every board's `defaultFolder`.

Crash recovery has the same problem. `repairRenameCascade`
(`lib/vault/renameCascadeRepair.ts:85-99`) does not replay the pin rewrites. The sentinel's
`affectedBoardIds` also leaves out boards that are affected only through their pin.

Fix:
- When file renames share a common old → new folder prefix, apply that prefix to the pins
  before the missing-folder cleanup runs.
- The rename sentinel records the pin rewrites, and recovery replays them.

### 0d. Pin matching is case-sensitive

`clearBoardDefaultFolderIfMatches` (`stores/board.svelte.ts:489-511`) compares paths
exactly. The project rule is case-folded compares. It should use the shared path helpers.
Also confirm that `defaultFolder` is covered when undo history follows renames
(`commands/commandPaths.ts` `PATH_FIELDS`).

### Phase 0: status and deviations (done 2026-09-27)

All four fixes are in, each with a regression test that fails on the old code:
`characterisation/folderPinsAndVaultName.test.ts` (4 cases, registered in the
`characterisation-suite` gate), `unit/folderPins.test.ts`, `unit/dragDropPinnedFolder.test.ts`
and `unit/vaultNameSaved.test.ts`.

Deviations from the plan:

1. **A fifth bug: the vault-wide Root Directory never worked.** `vaultStore` merges the
   root-folder slice with `...rootFolderSlice`. The spread runs the slice's getters once at
   module load, so `vaultStore.activeRootFolder` and `activeRootFolderAbs` were plain values
   frozen at `''`. The pin was saved to `app.json`, but the tree button never turned green, no
   creation path saw it, and the tree reconcile cleared it on the next watcher event. Fixed with
   live getters on the store after the spread (the board store already had the same fix for its
   waypoints). Phase 5c depends on this.
2. **0c: the watcher doesn't report per-file renames for a folder, at least on Windows.** An
   external folder rename arrives as two `tree` events (`Old`, `New`). Per-file renames only come
   from the watcher's 30 s reconcile walk, long after the 250 ms tree reconcile has cleared the
   pins. So the main fix is in the tree reconcile: `lib/vault/treeFolderMoves.ts` compares the tree
   before and after a refresh. A folder that left while a folder holding exactly the same files
   (names and sizes) arrived is run through `handleExternalRename(old, new)` **before** the
   missing-pin cleanup. That is the full external-rename cascade, so tile references, board files
   inside the folder, media tags and the rename sentinel follow at once too. Empty folders and
   ambiguous matches are never paired; their pins are cleared as before.
   The plan's per-file approach is still there for platforms (and the reconcile walk) that do
   report per-file renames: `confirmedFolderMove` reads the folder off the file paths and moves
   the pins only when the disk confirms the old folder is gone. A file moved between two folders
   that both remain leaves the pins alone.
3. **0c sentinel.** Pin rewrites now happen before the early breadcrumb, so the breadcrumb's
   `affectedBoardIds` includes boards touched only through their pin (the late second
   breadcrumb is gone). A folder move revealed by a file rename gets its own entry, because the
   file entry's paths don't name the pinned folder. A Root Directory move also lays a
   breadcrumb, and the cascade saves `app.json` before clearing it. Recovery replays pin moves
   for every entry and saves `app.json` when the Root Directory moved.
4. **0c: the external cascade now keeps the breadcrumb when the tag flush failed** (the in-app
   rename already did this; the external one cleared it on `pathKeysOk` alone).
5. **Shared pin helpers.** The in-app folder rename, the external rename cascade and recovery all
   use `followRenameInPins` (`lib/vault/folderPins.ts`). The case-folded path rules live in
   `lib/vault/folderPinPaths.ts`, which has no store imports so `board.svelte.ts` can use it. The
   missing-pin cleanup moved out of `vault.svelte.ts` into `clearPinsOfMissingFolders`, which keeps
   that allowlisted file shrinking (1592 → 1586; ceiling lowered to match).
6. **0d, beyond the plan.** `clearActiveRootFolderIfMatches` is case-folded too, and both pin
   toggles (`setActiveRootFolder`, `setBoardDefaultFolder`) use `samePath`, so clicking the pinned
   folder under another spelling unpins it. `defaultFolder` was **not** in `PATH_FIELDS`; it is now.
7. **0b.** `getActiveContentFolderAbs` had no other caller, so it was removed rather than kept as a
   trap. `copyFileIntoVault`'s drain scope now names a vault-root copy as `name`, not
   `<vault path>/name`.
8. **Tag popup order.** `fileTagsStore.filesForTag` now lists notes in path order. The vault
   index holds notes in the order their reads finish, so the Tags browser popup's file order
   was a race. The extra tree-reconcile work above shifted its timing and made
   `tagFilters.test.ts` fail every time when run after the other tests in that file.

Known gap, accepted: if a crash leaves a rename breadcrumb and a watcher event reaches the tree
reconcile while the recovery prompt is still open, a missing pin can be cleared before Retry
replays it.

---

## Phase 1: Smart connection route

### Why it misbehaves

All four path types attach to the same 8 fixed bubbles (`lib/connections/bubblePositions.ts`).
Curved and Elbow leave and arrive along the bubble's outward normal (`getBubbleNormal`).

Smart (`computeSmartPath`, `lib/connections/pathRouter.ts:112-311`) runs A* from exactly
the bubble point to exactly the other bubble point. `segmentIntersects` only rejects a
segment more than 0.1px **inside** a tile, so a segment lying on a tile edge is allowed.
The route can therefore arrive by sliding along the edge. The arrowhead angle comes from
the last segment (`getAngleOnPath`, `:383-401`), so the arrow points sideways with half
of it over the tile. Corner bubbles are worse, because they sit on two edges.

### Fix (about 20 lines, one file)

- Compute the stub points `s = from + normal(fromBubble) * PADDING` and
  `e = to + normal(toBubble) * PADDING`, and add them to the grid axes.
- Run A* from `s` to `e`, and build the result as `[from, ...route, to]`.
- The last segment is then always along the inward normal: the same approach as Elbow,
  and diagonal at corners.

Tests (`pathCalc.test.ts` / `smartPathObstacles.test.ts`): the last segment of a Smart
path is collinear with the bubble normal, for a side bubble and for a corner bubble.

Accepted as is: Smart still falls back to a curve when there is nothing to route around.

### Phase 1: status and deviations (done 2026-09-27)

`computeSmartPath` now routes stub to stub and returns `[bubble, stub, route, stub, bubble]`.
New cases in `unit/pathCalc.test.ts` ("leaves and arrives along the bubble normal"): side
bubbles, arriving straight down into a top bubble, corner bubbles, and never running along the
target tile's edge. Three of the four fail on the old router. The side-to-side case passed
before too, since a straight-across route already arrived head-on. Checked in the built app:
side, top and corner arrows all arrive along the normal.

Deviations from the plan:

1. **The stubs replace the bubbles on the grid axes; they are not added alongside them.** A
   bubble lies on its tile's edge, so keeping its x / y as grid lines would still give A* a line
   running along that edge. The heuristic also measures to the end stub.
2. **Two existing tests had bubble indices that didn't match their geometry.**
   `smartPathObstacles.test.ts` used bubbles 1 → 3 for a right-edge → left-edge link, and the 3×3
   grid case in `pathCalc.test.ts` used 4 → 0 for points just outside the top-left and
   bottom-right tiles. With stubs, those normals put a stub inside a tile, and the route
   correctly fell back to a curve. The indices now match the geometry (3 → 7 and 0 → 4).
3. **Accepted: a stub inside another tile falls back to a curve.** When a neighbouring tile is
   closer than 25 px to the bubble, the stub lands inside it, A* has no first move, and the
   route falls back to a curve (the same fallback as any failed route).
4. **Seen, not changed:** A* has no penalty for bends, so of two equally long routes it can
   pick one with an extra jog (for example, dropping to the other stub's y straight after
   leaving). This is cosmetic, so it's out of scope for this fix.
5. **Found while checking, not fixed here:** `board:create` (`main/ipc/board.ipc.ts`) makes
   the returned path with `fullPath.replace(vaultRoot, '')`. When the vault root is spelled with
   other separators or drive-letter case, the replace does nothing. The board then keeps an
   absolute path, and every later save of it is refused. `npm run scratch-vault` with a
   forward-slash `FILO_SCRATCH_VAULT` shows it. This bug predates Phase 0. It is fixed in
   Phase 1b.

---

## Phase 1b: `board:create` returns an absolute path

Added after Phase 1, which found it. Phase 5 builds on `board:create` (a board inside its
folder, a refused name clash), so it's fixed before then.

### Why it misbehaves

`board:create` (`main/ipc/board.ipc.ts`) made the path it returns with
`toPosix(fullPath.replace(vaultRoot, ''))`. `createBoardFile` builds `fullPath` with
`path.join`, which normalises the root. When the root the renderer sent is spelled
differently (forward slashes on Windows, a trailing separator), the replace finds nothing,
and the handler returns the absolute path. `persistNewBoard` keeps it as the board's path.
Every later `board:save` and `vault:stat` refuses it as an unsafe path. So the new board is
never saved, and closing the vault leaves the crash marker behind.

### Fix

The path is `relativePosix(vaultRoot, fullPath)` (`main/utils/pathHelpers.ts`, `path.relative`),
which doesn't depend on how the root is spelled.

Test: `unit/boardCreateRelativePath.test.ts` runs the real handler with the root as given,
with forward slashes, with a trailing separator, and (on Windows) with the other drive-letter
case. It also creates into a subfolder. The forward-slash and trailing-separator cases fail on
the old code.

### Phase 1b: status and deviations (done 2026-09-27)

Done as planned. No other main-process handler builds a relative path by stripping the root
as a string. The shared `toVaultRelative` does slice by the root's length, but only after a
case-folded, normalised prefix match, so it's safe. `npm run scratch-vault` with a
forward-slash `FILO_SCRATCH_VAULT` now builds cleanly.

One test note: the drive-letter-case case already passed on the old code, because
`fullPath` is joined from the same string, so the strip still matched. It stays as a guard.

---

## Phase 2: Floating board toolbar pin

### Today

- **Mind Map** (`components/boards/SideToolbar.svelte`): drag state is local
  (`:35-66`), and the position is **not saved** (it resets on reload). There is no
  `pointercancel` handler.
- **Kanban** (`components/boards/KanbanSideToolbar.svelte:92-141`): a copy of the same
  drag code. It saves one position for every Kanban board
  (`workspaceStore.setKanbanToolbar`), and a right-click resets it.
- **Task List** (`components/boards/TaskListSideToolbar.svelte`): no drag code at all.

### Work

1. **Shared helper** `lib/canvas/floatingToolbarDrag.ts`: pointer down / move / up /
   cancel, clamp to the window, button exclusion, and a `pinned` getter that stops a drag
   before it starts. The three toolbars use it.
2. **Per-board state** in `.filo/workspace.json`: `boardToolbars: { [boardId]: { x, y, pinned } }`,
   replacing `kanbanToolbar`. It is validated by hand like the other layout fields in
   `stores/workspace.svelte.ts`. The entry is removed when a board is deleted. The dead
   `sideToolbar` / `vaultSidebar` keys in the new-vault seed (`main/vault/configOps.ts:119-124`)
   are dropped.
3. **Pin button** at the end of each toolbar (an SVG pin icon, `aria-pressed`). While
   pinned, the grab cursor and the drag title go away, and right-click reset is ignored.
4. Update the characterisation harness (`harness/saveState.ts` `kanbanToolbarPosition`)
   to the new shape.

Tests: helper unit tests (pinned blocks drag, cancel ends drag, clamp); a workspace
round-trip of `boardToolbars`; a component test that the pin toggles.

### Phase 2: status and deviations (done 2026-09-27)

All three toolbars (Mind Map, Kanban, Task List) drag by their background, have a pin
button at the end, and keep their position and pin per board in `.filo/workspace.json`.
Tests: `unit/floatingToolbarDrag.test.ts` (background-only, right press, pinned, cancel,
clamp), new `boardToolbars` cases in `unit/workspace.test.ts` (per board, pinned refuses
move / dock, no entry for a docked unpinned toolbar, removal, round-trip, bad entries
dropped), `component/boardToolbarPin.test.ts` (the real Task List toolbar: pin toggles,
drag saves for that board only, pinned ignores drag and right-click, right-click docks),
and a new characterisation case in `honestSaveState.test.ts` (a pinned Kanban toolbar
stays put and is still pinned after reopening the vault).

Deviations from the plan:

1. **Entry shape is `{ position: { x, y } | null, pinned }`, not `{ x, y, pinned }`.** A
   docked toolbar can be pinned too (pinning is about stopping accidental drags, not only
   about a dragged spot), so the position must be able to be absent. A docked, unpinned
   toolbar has no entry at all.
2. **Two modules, not one.** `lib/canvas/floatingToolbarDrag.ts` is the pure pointer
   helper the plan named (plus `clampToolbarPosition` / `floatingToolbarStyle`).
   `lib/boards/boardToolbar.svelte.ts` wraps it with the reactive state and the workspace
   store (`createBoardToolbar`), so each toolbar needs only a few lines instead of three
   copies of the same drag, pin and reset wiring.
3. **Board id from the board scope.** Kanban and Task List read the board id from the
   `BOARD_SCOPE_KEY` context instead of a new prop, so the allowlisted `KanbanBoard.svelte`
   and `TaskListBoard.svelte` don't grow.
4. **Right-click reset now on all three toolbars.** Only Kanban had it. For consistency the
   Mind Map and Task List toolbars dock again on a right-click of the background too
   (ignored while pinned). The reset stops the event so the board's own context menu
   doesn't open over it.
5. **A cancelled drag puts the toolbar back** where it was before the drag (nothing is
   saved), rather than leaving it at the last pointer position.
6. **The Task List toolbar**, docked, still sits in the board's corner (`position: absolute`).
   Once dragged it becomes `position: fixed` in window pixels, like the other two.
7. **No migration of the old `kanbanToolbar` key** (no legacy support needed). An old
   value is ignored and dropped on the next workspace save. The new-vault seed also loses
   the dead `rightSidebar` key, beside `sideToolbar` and `vaultSidebar`.
8. **Pin icon** is shared: `PIN_ICON_PATH` in `constants/icons.ts`, drawn by
   `components/shared/PinIcon.svelte` (filled while pinned), like the Style icon.
9. **`KanbanSideToolbar.svelte` shrank** (1473 → 1439 lines); its allowlist ceiling is
   lowered to match.
10. Accepted: undoing a board delete brings the board back with a docked, unpinned
    toolbar; the toolbar entry is removed with the board and is not part of the trash.

---

## Phase 3: Hide Vault

### Today

- **Close vault** (`components/sidebar/VaultSidebarToolbar.svelte:425-438`) calls
  `vaultStore.closeVault()`. The only other way to close a vault is Ctrl+Shift+W
  (`AppShell.svelte:229-235`).
- **Toggle Sidebar** (`components/layout/GlobalToolbar.svelte:312-322`) sits in the
  right-hand section and is always rendered.
- `uiStore.sidebarOpen` (`stores/ui.svelte.ts:10`) is **not saved**. In floating mode it
  is ignored: `FloatingVaultPanel` mounts `VaultSidebar open={true}`.

### Work

1. The sidebar button becomes **Hide Vault** (title and label). It calls
   `uiStore.setSidebarOpen(false)` and keeps the door icon, with the arrow flipped by the
   open state.
2. Move Toggle Sidebar to the far left of the global toolbar, always visible while a vault
   is open, with its current icon.
3. Floating mode respects `sidebarOpen`: the floating panel is not rendered while hidden.
4. Save `open` in `sidebar-state.json` (main schema `services/sidebarState.ts`, strict patch
   schema, and renderer hydrate).
5. Add **Close vault** to the vault name dropdown (`components/layout/ProjectDropdown.svelte`).

Tests: sidebar-state round-trip with `open`; hiding in floating mode; the button calls hide
and not close.

### Phase 3: status and deviations (done 2026-09-27)

The sidebar's last button is **Hide Vault**: it hides the sidebar (docked or floating) and
leaves the vault open. The sidebar toggle is now the first button of the global toolbar,
shown whenever a vault is open and on screen. The shown / hidden state is saved as `open`
in `sidebar-state.json` and restored at startup. **Close Vault** is in the vault name
dropdown (and still on Ctrl+Shift+W).
Tests: `unit/sidebarStateOpen.test.ts` (default shown, hidden survives a restart with the
other fields kept, an old file without `open` reads as shown, the patch schema accepts
`open` and still refuses unknown keys) and a new characterisation spec
`hideVault.test.ts` with its driver `harness/sidebar.ts` (docked hide leaves the vault
open and the toggle brings it back; floating hide unmounts the panel and it comes back
floating; `open` lands on disk; Close Vault from the menu closes the vault and the toggle
goes with it). The floating case was checked to fail with step 3 reverted.

Deviations from the plan:

1. **Hide Vault is a toggle** (`setSidebarOpen(!sidebarOpen)`), not a one-way
   `setSidebarOpen(false)`, so the flipped arrow and its label ("Show Vault") are honest
   if the button is ever reached while hidden. In practice it is only reachable while the
   sidebar is shown: its arrow then points left, the way the sidebar goes.
2. **The docked sidebar is `inert` while hidden.** It only slid off-screen before, so Tab
   could still reach its buttons (Hide Vault included). Now nothing in it is focusable
   until it is shown again.
3. **The toolbar toggle sits before the Home button** (the far left), and is hidden on the
   Home screen as well as with no vault, since there is no sidebar to show there. It
   comes in through a new `showSidebarToggle` prop from `AppShell` (which owns the
   "Home is showing" state). It also gets `aria-pressed`, and its title reads
   "Hide Sidebar" / "Show Sidebar".
4. **Close Vault in the dropdown shows only while a vault is open**, sits after Save, and
   uses the old door icon (the arrow pointing out), the one the sidebar button had.
5. **No component test**; the behaviour is pinned by the characterisation spec instead,
   which mounts the whole app, so it also covers the `AppShell` / `GlobalToolbar` wiring
   a mounted `VaultSidebarToolbar` alone would miss.

---

## Phase 4: Vault Sidebar section in General settings

A new **Vault Sidebar** section inside `components/settings/GeneralSettings.svelte`.
It saves at once through `markMetaDirty`, like the rest of General, and writes to
`.filo/app.json`.

| Field | Storage |
|---|---|
| Vault name | `app.json` `name` (fixed in Phase 0a) |
| Sort by + direction | `general.sidebarSortField / sidebarSortDirection` (the sidebar buttons change the same value) |
| Group by + direction | `general.sidebarGroupField / sidebarGroupDirection` |
| Show file extensions | `general.showFileExtensions` |
| Root Directory | Shows the current pin, with a Clear button |
| Vault colour | New `general.vaultColor` (hex or empty), picked with the shared `ColorPicker` |
| Board-specific folders | New `general.boardFolders: boolean` (default `false`) |

**Vault colour:**
- It is also copied into `recent-vaults.json` (`RecentVault.color`, `main/services/recentVaults.ts`),
  so Home can show it without opening the vault. The copy is refreshed whenever the vault
  is opened or the colour changes.
- It is shown in the Home recent list (`HomeScreen.svelte`), the sidebar header, and the
  vault name in the global toolbar.

Tests: schema defaults for the new keys; an `app.json` round-trip; a recent-vaults colour
round-trip.

### Phase 4: status and deviations (done 2026-09-27)

General settings now opens with a **Vault Sidebar** section (while a vault is open): vault
name, vault colour, Sort by and Group by (each with its direction), Show file extensions,
and the Root Directory with a Clear button. Everything saves at once to `.filo/app.json`.
The vault colour shows as a dot before the vault name in the global toolbar and before
"Vault" in the sidebar header, and it tints the vault's icon in the Home recent list.
Tests: `unit/vaultSidebarSettings.test.ts` (defaults, a hex colour and the switch read from
`app.json`, a bad value read as the default without resetting the rest of General, a
write → read round-trip, `safeVaultColor`), `unit/recentVaultsColor.test.ts` (the real
`vault:add-recent` handler: the colour survives a restart, is kept when an add leaves it out,
keeps the pin, is cleared by `''`, a bad colour is stored as none, a non-string is refused),
and the updated `zodDefaultsSnapshot.test.ts`. Checked in the built app: rename, colour, sort
and extensions all land in `app.json` and `recent-vaults.json`, and the three dots / tint
show the colour.

Deviations from the plan:

1. **The Board-specific folders switch is not shown yet.** `general.boardFolders` is in the
   schema, the shared defaults, the loader and the `app.json` writer (with tests), but the
   switch itself comes with Phase 5. Until then it would change nothing, and the project
   rule is no placeholder features.
2. **The section is its own component**, `components/settings/VaultSidebarSettings.svelte`,
   placed inside `GeneralSettings.svelte` right after the launch setting. That keeps one
   concern per file, and `GeneralSettings.svelte` shrinks (817 → 805 lines).
3. **Show file extensions moved** into the section. It is no longer in the main General list,
   so there is one switch, not two.
4. **Only `#rgb` / `#rrggbb` is kept as a vault colour** (`shared/vaultColor.ts`
   `safeVaultColor`, used by the loader, the recent-vaults service and every place that shows
   it). The value comes from files another program can edit and ends up in inline styles.
   Anything else reads as no colour, and the loader normalises it first, so a bad value can't
   make the whole General slice fall back to defaults.
5. **`vault:add-recent` takes an optional third argument, the colour.** Left out, the stored
   colour is kept; `''` clears it. The renderer always sends the open vault's colour through
   `rememberOpenVault`, which now runs on every open (Home's recent list and auto-open used to
   write back the entry's old name). So a vault renamed or recoloured from any place, and a
   rename from the vault name menu, reaches Home too.
6. **Sort and Group option lists are shared** (`constants/vaultSidebarOptions.ts`) by the
   sidebar's menus and the section. A direction menu is disabled while its field is None.
7. **Colour display:** the toolbar dot comes from a new optional `swatch` prop on the shared
   `Dropdown`. No colour, no dot.
8. **Clear Root Directory** empties `general.activeRootFolder`; the pin is still set from the
   sidebar's tree button (Phase 5c changes what that button means with board folders on).

---

## Phase 5: Board folders and board names

### 5a. Board name equals file name (every board)

The file name is the source of truth. `board.name` in the JSON is kept equal to it.

- **Name field:** it blocks characters Windows does not allow in file names
  (`/ \ : * ? " < > |`, trailing dot or space, reserved names), with an inline message.
  It uses `fileNameProblem` from `shared/fileNames.ts`.
- **Rename in the app** (`stores/boardIdentity.ts`): renames the `.board.json` through
  `renameVaultPath` (disk-shape op, drained), then updates `board.name`, the project list
  and the tabs. If a board with that name already exists in the same folder, the rename
  is refused with a message, without a ` (2)` suffix.
- **Rename of the `.board.json`** (sidebar, or another program): the board's name
  becomes the new file stem.
- **On load:** if `board.name` differs from the file stem, the stem wins.
- **Board creation** (`persistNewBoard` → `board:create`): the name is checked first,
  and a clash is refused rather than suffixed.

### 5b. Board-specific folders (when `general.boardFolders` is on)

- **Create:** make a folder named after the board inside the current Root Directory, or
  the vault root when none is set. Create the `.board.json` inside it (`board:create`
  already takes a `subfolder` argument), and set `board.settings.defaultFolder` to that
  folder.
- **Rename board:** the `.board.json` is renamed (5a). The folder is renamed too **only while
  its name still equals the board's old name**. A folder the user has renamed no longer
  matches and is left alone. If the new folder name is taken, the folder keeps its name
  and a notice says so.
- **Rename folder:** never changes the board. The pin follows through the existing folder
  rename cascade, fixed in Phase 0c.
- **Delete board:** unchanged; the folder stays.

### 5c. One root-directory pin

The folder row's bookmark button ("Default folder for board …",
`components/sidebar/VaultFileItem.svelte:572-586`) is **removed**. The tree button
("Use as root directory", `:596-603`) means:

| Board folders | Tree button shows / sets | Files go to |
|---|---|---|
| On, board active | The active board's `settings.defaultFolder` | That folder, or the vault root when the pin is toggled off |
| On, no board active | Disabled: "Open a board to choose its folder" | — |
| Off | The vault-wide `general.activeRootFolder` | That folder, or the vault root |

`getActiveContentFolder` (`lib/vault/conventionPaths.ts:107-128`) is changed to match this
table. The tree button gets a **green** active state.

### 5d. Every creation path uses the resolved folder

These places currently ignore the pin and write to the vault root:
- Kanban OS file drop (`lib/kanban/kanbanFileDropHandler.ts:128`)
- Kanban cover image (`lib/kanban/kanbanFrontmatterWriter.ts:137`)
- Frame and board background image (`components/shared/BackgroundImagePicker.svelte:61`)
- File tile pick (`components/tiles/FileTile.svelte:58`)
- Audio recording (`components/tiles/AudioTile.svelte:101`, pass `destFolder`)

The paths that already resolve it stay as they are: new text tile, Kanban card,
Task List task / quick-add / subtask / `.md` drop, note templates, and mind-map drop
(fixed in 0b).

### Tests

- Unit: name validation; the rule for when the folder follows a board rename; the
  resolution table in 5c; each creation path in 5d uses the resolved folder.
- Characterisation spec, run with board folders on:
  1. create a board: the folder and its `.board.json` exist
  2. add a card: it lands in the folder
  3. rename the board: the file and folder follow
  4. rename the folder by hand, then rename the board: the folder stays
  5. rename the `.board.json` in the sidebar: the board name follows
  6. switch board folders off: new files go to the Root Directory or the vault root

### Phase 5: status and deviations (done 2026-09-27)

A board's name is now its `.board.json` stem everywhere. Renaming a board (tab or Board
Browser) renames its file; renaming the file (sidebar or another program) renames the board;
on load the stem wins. A name the file system can't take, or another board's name in the same
folder, is shown inline and refused. General → Vault Sidebar has the **Board-specific
folders** switch. With it on, a new board gets a folder named after it (inside the Root
Directory, or at the vault root) holding its `.board.json`, its `settings.defaultFolder` pins
that folder, and everything the board creates goes there. The folder follows a board rename
while it still has the board's name. The sidebar's bookmark button is gone; the one tree
button follows the 5c table and is green while active.

Tests: `unit/boardNaming.test.ts` (name rules, new-board place, the folder-follow rule, free
names), new `resolveContentFolder` cases in `unit/conventionPaths.test.ts` (the 5c table),
`component/boardFolderCreationPaths.test.ts` (the real File tile, Audio tile and background
picker, plus the Kanban cover and OS-drop import, all write into the board's folder; all five
fail with the 5d changes reverted), and `characterisation/boardFolders.test.ts` (the six plan
cases plus an illegal name and a same-folder clash; registered in the `characterisation-suite`
gate). The two rename-follow cases were checked to fail with the rule disabled. Checked in
the built app: the switch lands in `app.json`, a new Kanban board is `Kanban 1/Kanban
1.board.json` with its folder's tree button green, its first card lands in `Kanban 1/`,
`Q3: plan` shows "Names can't contain ":"" by the tab, and renaming to `Plan` gives
`Plan/Plan.board.json` with the card moved along. That check found the tab strip sits at the
bottom of the window, so the tab's message now opens above the input when there's no room
below.

Deviations from the plan:

1. **`board:create` is an exclusive create.** It used to sanitise the name and bump a taken
   one to ` (2)`, which would leave a board named differently from its file. It now uses the
   name verbatim (the stem itself must pass `assertSafeFilename`, so a trailing dot or space
   is refused too) and creates through `createExclusiveFile`, so a taken name fails with
   `EEXIST` and nothing is overwritten. The renderer turns that into "A board named … already
   exists in …".
2. **Names Filo picks itself are made free first.** A new tab's board ("Kanban 1"), the Board
   Browser's suggestion ("Untitled Board 2") and a template's board take the first name whose
   file is free where the board would go (`lib/boards/newBoardPlace.ts`). New-tab numbering is
   now the lowest free number rather than "count + 1". Only a name the user typed is refused.
3. **Two new modules.** `lib/boards/boardNaming.ts` holds the pure rules (name problem, new-board
   place, folder-follow rule, free names); `lib/boards/newBoardPlace.ts` applies them to the open
   vault (the tree plus the board cache, since the tree refresh after a create lands a moment
   later). The board-name-follows-file rule is a rename sweep (`boardIdentity.names`),
   installed from `App.svelte`, so it runs from every rename cascade: in-app, external, the
   folder pairing from Phase 0c and crash recovery.
4. **Rename order: the file first, then the folder.** If the folder rename fails, or its new
   name is already taken, the board keeps its new name and a notice says the folder kept its
   own. The folder-follow compare is case-folded, and only runs with board folders on (a board
   that merely sits in a same-named folder with the switch off never moves the folder).
5. **The sidebar rename of a `.board.json` to another board's name is refused.** It used to
   offer "Overwrite file?", which would have destroyed the other board.
6. **On load the stem wins in memory only.** Nothing is written for it; the next save carries
   the name. The duplicate-board-id ranking still compares against the name the JSON declares
   (`LoadBoardResult.declaredName`), since the loaded name now always matches.
7. **A pre-existing bug: `fileNameProblem` let a backslash through.** Its character class had
   `\|` (just `|`), so `a\b` passed the inline check and then failed in main. Fixed in
   `shared/fileNames.ts`; a note title with `\` now gets `-` in its file name too.
8. **5c details.** With board folders on, the tree button is disabled with "Open a board to
   choose its folder" while no board is open. The vault-wide Root Directory can then only be
   set from the sidebar while board folders are off; Settings still shows it (it is where new
   board folders go) and can clear it. The hint under it says so.
9. **5d: `BackgroundImagePicker` takes an optional `folder`.** The frame style popup passes
   its pane's board folder; the Current Board and Global Defaults settings pickers fall back to
   the active board's. The Kanban OS drop gets `destFolder` from `KanbanBoard.svelte` with a
   same-line change, so that allowlisted file doesn't grow.
10. **Name fields.** The tab rename shows its message in a fixed-position note under the input
    (the tab strip clips anything below it). Enter does nothing while the name is refused; a
    blur with a refused name toasts the reason and keeps the old name. The Board Browser's
    rename and its New Board form use the same check (the form compared board names
    vault-wide; it now checks the file where the new board would go).
11. **`persistNewBoard` says why a create failed**, so the "Failed to create board" toasts in
    `TabBar` / `BoardBrowser` / `TemplateBrowser` are gone (a failure used to show two).
12. **Existing tests updated.** Four reconciler tests used `board.name` as the "disk version"
    marker, which the stem now overrides; they use the emoji. The per-board pin cases in
    `conventionPaths.test.ts`, `dragDropPinnedFolder.test.ts` and
    `taskListFilePathPersistence.test.ts` turn board folders on. `boardFileEncodingRoundTrip`
    (d) now expects the refusal. The Phase 0 board-pin characterisation case turns board
    folders on before pinning.
13. **Characterisation harness race fixed.** Since Phase 4 every open writes the recent-vaults
    list, so closing a case's vault showed Home, which auto-opened that (temp, being deleted)
    vault and raced the next case's open ("Failed to open vault"). The harness now turns off
    "open last vault on launch" before mounting the app.

Accepted as is: a board rename is not on the board's undo stack (it wasn't before either; it
is a disk rename). A tab whose board file is missing still re-creates it under the tab's name
(`BoardRouter`); a clash there is refused with the same message.

---

## Follow-ups after the plan (2026-09-27)

Requested by the user after Phase 5:

1. **The sidebar toggle moved** from the far left of the global toolbar (Phase 3) to right
   after Undo / Redo. `hideVault.test.ts` now pins that position.
2. **Close Vault was removed from the vault name menu** (added in Phase 3, step 5). The user
   found it unnecessary, and it needed several clicks to act. Closing a vault is Ctrl+Shift+W.
   `hideVault.test.ts` now checks the menu has
   no Close Vault item and closes with the shortcut.

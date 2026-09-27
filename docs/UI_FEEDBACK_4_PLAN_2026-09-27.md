# UI Feedback 4: implementation plan (2026-09-27)

This plan comes from the first real test run. It covers:
a pin for the floating board toolbars, replacing the sidebar's Close Vault button with
Hide Vault, the Smart connection route, a Vault Sidebar settings section, and
board-specific folders.

It ships as six phases. Each phase is its own commit and must pass `npm run ci:verify`
before the next one starts. Nothing is pushed until the user says so.

Order: **0 → 1 → 2 → 3 → 4 → 5**. Phase 0 fixes existing bugs in the folder-pin and
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

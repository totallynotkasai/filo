# CLAUDE.md — Filo Development Guide

## Project Overview

Filo is a local-first, visual-first Personal Knowledge Management (PKM) desktop application. It combines an infinite canvas (Mind Map), Kanban boards, Task Lists, and Documents into a single tool. All data lives on the user's device as Markdown and JSON files — no accounts, no cloud, no lock-in.

**Key technical identity:** Electron + Svelte 5 + TypeScript + Vite. Vanilla CSS only. No Tailwind, no CSS-in-JS, no preprocessors.

---

## Quick Reference

```
Run dev:        npm run dev
Lint:           npm run lint             (eslint, --max-warnings 0: a warning fails CI)
Type-check:     npm run check            (renderer + shared, svelte-check)
                npm run typecheck:main   (main process)
                npm run ci:test-typecheck (test sources, per-file ratchet)
Unit tests:     npm run test:unit
E2E tests:      npm run test:e2e
Build:          npm run build
Package:        npm run package
```

### CI gates (`.github/workflows/ci.yml`)

`npm run ci:verify` mirrors the GitHub Actions `verify` job: **lint → check (svelte-check) → typecheck:main → test:unit:strict → build → ci:gates**. A second job, `verify-windows`, runs `test:unit:strict` and `typecheck:main` on `windows-latest`.

`ci:gates` runs `node scripts/gates/run.mjs`: 73 small static checks that pin invariants which past data-loss bugs broke. They share one helper module ([scripts/gates/lib.mjs](scripts/gates/lib.mjs)) and are grouped by subsystem. `--list` shows every check, `--only <id,id>` / `--group <name>` narrow a run, and each failure prints `file:line` plus a fix hint.

| Group | Protects |
|---|---|
| `writePath` | Only the note writer ([noteWriter.ts](src/renderer/lib/notes/noteWriter.ts)) writes a `.md`, and it applies every change to a **fresh read of the file**; a note is renamed, trashed or restored only while its write queue is held; writes are time-bounded, failed writes are kept and re-fired, and nothing silently aborts; new files are created exclusively (never overwrite an existing note); "Keep mine" / "Keep local" first backs up the other version (for a note, inside `resolveConflict`, so the backup is of the bytes it then overwrites); user deletes move items to `.filo/trash` (only a confirmed fallback deletes for good); a note overwrite names the stat of the read it builds on and the main process refuses it (STALE) if the file changed since; a note write hides only its own watcher echo (the bytes it wrote), so another program's save, rename or delete right after it still gets through; a drift baseline only moves forward, a new board's create counts as Filo's own write, and a board's baseline is stamped only once its loaded data is in the cache (never by a load that failed or was set aside); close, open-another-vault and quit save first and never let unsaved work go without a rescue copy. |
| `markdownFormat` | Byte fidelity: BOM, UTF-8 validation (non-UTF-8 notes are read-only), EOL re-application, a single YAML parser (no js-yaml / gray-matter anywhere in the app) and a single frontmatter-fence parser (`frontmatterFence.ts`), editor load/undo/unmount discipline, a save → reload case for every formatting-toolbar command, the note writer refusing any write that would turn a parsing frontmatter block into one that doesn't, and that the frontmatter-invariant and markdown body round-trip suites exist and aren't skipped. |
| `vaultIdentity` | A vault swap mid-`await` can't apply the outgoing vault's data to the new one (`isStillSameVault`); vault-scoped state resets on swap; path-keyed stores use `VaultPath` keys, case-fold compares, and follow renames (path keys in `boardDiscovery` / `vaultDeleteOps` / `folderPins` / `tagsStorage` go through `vaultPath()`, and "the item or inside it" is `isAtOrUnder`); crash sentinels are per-machine; disk-shape IPC goes through `vaultOperations.ts`; one vault open or close runs at a time, and every `vault:close` names the vault it releases (main releases only that one). |
| `ipcSecurity` | Every `ipcMain` channel is in the `IpcChannel` union (and vice versa); envelope usage; untrusted values pass an `asSafe*` validator before a sink; `vault:copy-file` only copies approved sources; renderer reads can't reach `.filo/`, and no renderer write names a `.filo/` path on a `vault:*` channel that refuses it (Filo's own state goes through its config / misc schedulers); every write handler answers a failure through `errorEnvelope` / `errorResult`, so it always carries a code and Retry can re-fire it; config loaders migrate before parsing. |
| `commands` | Undo/redo: high-value mutations go through Commands, which snapshot their slice, carry a `targetBoardId`, and have an execute→undo round-trip test; no command keeps a copy of a note body; every path a command holds follows renames; a command holding snapshots of boards beyond its own names them in `touchedBoardIds()`, so a board reload drops it; Task List section positions are clamped. |
| `components` | Component timers are cleared, `flush*` functions are actually called, no dead `$derived`, DocumentEditor / drag-drop are pane-scoped, pointer capture + spatial batches handle `pointercancel`, z-index tokens, every `var(--x)` without a fallback is defined, every focus trap has a `fallbackFocus` and is released in an effect cleanup even when its host is already detached, views read notes from the note store (nothing keeps its own copy of a note), every global `tile:` shortcut says which board it is for (`enabled`), so it never shadows a Kanban or Task List command, and a component that saves on teardown also registers that save with `registerComponentFlush`, so the save before leaving runs it while it still counts. |
| `codebase` | No file in `src/main` / `src/renderer` over 1000 lines except the allowlisted ones, which may only shrink (**split an over-limit file, don't raise its ceiling**); no `as any` / `as unknown as`; test sources type-check under `tsconfig.tests.json`, with a per-file error baseline (`scripts/gates/testTypecheckBaseline.json`) that may only go down; board tile defs never store a note's title, tags or body; the board loader accepts only the current format; a note is named only by its vault path (no `contentId` / `docId`); the characterisation suite stays whole, un-skipped and black-box; app source and build config carry no audit ids (`Audit-N`, `P0-N`, `Phase N / N.N`). |

**Escape hatches** are same-line comments with a reason, e.g. `// allow-cast: <reason>`, `// allow-direct-write: <reason>`, `// allow-module-state: <reason>`. Keep the marker text exact; the checks look for it.

**Adding a check:** put it in the matching group module as `{ id, title, run(ctx) }` using the shared lib. Don't add a standalone `scripts/check-*.mjs`. Before relying on it, prove it bites: introduce the violation in real source, confirm the check fails, then revert.

`test:unit:strict` ([scripts/test-unit-strict.mjs](scripts/test-unit-strict.mjs)) runs vitest and also fails on known noise patterns in its output: a missing `window.filo` mock, a duplicate object key, the `yaml` collection-key warning, and Svelte effect-loop / unsafe-mutation warnings.

The `coverage` job (the vitest coverage ratchet) runs on pushes to `main` and on PRs. The a11y axe-core scan and full Electron E2E run weekly (Monday 06:00 UTC) and on demand (Actions tab → CI → Run workflow).

**Comments:** explain *why* (the invariant, the hazard a guard prevents), never history. No audit IDs, phases, dates or "used to…" in code: that belongs in commit messages. Plans and audit reports live in `docs/` (active) and `docs/archive/` (done), not the repo root.

---

## Tech Stack (Locked — Do Not Substitute)

| Layer              | Technology                                                             |
| ------------------ | ---------------------------------------------------------------------- |
| Shell              | Electron (main process: Node.js)                                      |
| Frontend           | Svelte 5 (runes: `$state`, `$derived`, `SvelteSet`), TypeScript, Vite |
| Rich text editor   | TipTap (ProseMirror) + tiptap-markdown for MD round-tripping          |
| Canvas             | Custom pointer-event handlers + rbush (spatial index)                  |
| Markdown parsing   | unified + remark-parse + remark-frontmatter; `yaml` package for FM     |
| Full-text search   | MiniSearch                                                             |
| Schema validation  | Zod                                                                    |
| List drag-and-drop | svelte-dnd-action                                                      |
| IDs                | nanoid                                                                 |
| Focus management   | focus-trap                                                             |
| Testing            | Vitest (unit, jsdom env), Playwright (E2E + a11y axe-core)             |
| CSS                | Vanilla CSS only. CSS custom properties for theming.                   |

**Critical:** Canvas-level tile dragging is built on raw pointer-event handlers in `lib/canvas/`, NOT svelte-dnd-action (which only handles list-based drag in Kanban / Task List).

---

## Project Structure

```
filo/
├── package.json
├── electron.vite.config.mts
├── tsconfig.json
├── tsconfig.main.json
├── svelte.config.mjs
├── vitest.config.mts
├── playwright.config.ts
├── CLAUDE.md                          # This file
├── KNOWN_LIMITATIONS.md               # Accepted trade-offs (do NOT "fix")
├── Filo_Design_Doc_Rework_V5.md
│
├── src/
│   ├── main/                          # Electron main process
│   │   ├── main.ts                    # App entry, window creation, lifecycle
│   │   ├── preload.ts                 # contextBridge API exposure
│   │   ├── ipc/                       # IPC handler registrations
│   │   │   ├── index.ts               # Aggregated registration entry point
│   │   │   ├── ipcErrorCode.ts        # errorEnvelope / errorResult: every write failure carries a code
│   │   │   ├── vault.ipc.ts           # File CRUD, directory ops
│   │   │   ├── vaultCopy.ipc.ts       # vault:copy-file (approved sources only)
│   │   │   ├── vaultEncoding.ipc.ts   # vault:convert-to-utf8 for a non-UTF-8 note
│   │   │   ├── vaultTrash.ipc.ts      # .filo/trash move / restore / list / purge
│   │   │   ├── machine.ipc.ts         # Machine identity + per-machine sentinel listing
│   │   │   ├── board.ipc.ts           # Board file list/load/save/create, config + theme
│   │   │   ├── dialog.ipc.ts          # Native open dialogs
│   │   │   ├── shell.ipc.ts           # External URL opening, reveal-in-folder
│   │   │   ├── media.ipc.ts           # Media save/copy helpers (a recording is created exclusively, ` (n)` on a taken name)
│   │   │   ├── fonts.ipc.ts           # System font enumeration
│   │   │   ├── tags.ipc.ts            # .filo/tags.json load/save
│   │   │   ├── templates.ipc.ts       # .filo/templates/ CRUD
│   │   │   ├── sidebar.ipc.ts         # Sidebar geometry (userData)
│   │   │   └── recovery.ipc.ts        # recovery:keep-unsaved (rescue copies) / recovery:preserved-tmp
│   │   ├── services/                  # Main-process-only services
│   │   │   ├── fileWatcher.ts         # fs.watch wrapper, debounced events
│   │   │   ├── fileWatcherTypes.ts    # Shared watcher types
│   │   │   ├── fileWatcherClassify.ts # Path classification + ignore rules for watcher events (hidden segments like .stversions/ ignored; any other file with an extension is an attachment)
│   │   │   ├── fileWatcherHash.ts     # Content hash (with a size ceiling) for echo and rename matching
│   │   │   ├── fileWatcherWalk.ts     # The 30 s reconcile walk (re-reads a file only when its stat moved); files changed since the vault was armed
│   │   │   ├── watcherSupervisor.ts   # Reopens the fs.watch handle after it dies
│   │   │   ├── watcherSuppression.ts  # Own-echo windows: suppress / suppressWrite / suppressTree
│   │   │   ├── syncConflictNotifier.ts # Live notices for sync-client conflict copies
│   │   │   ├── nonUtf8Registry.ts     # Notes whose bytes aren't valid UTF-8 (opened read-only)
│   │   │   ├── machineIdentity.ts     # userData/machine-id.json: keeps sentinels per machine
│   │   │   ├── approvedSources.ts     # Which source paths vault:copy-file may copy
│   │   │   ├── emergencyFileRegistry.ts # Files preserved after a failed write (disk full, locked)
│   │   │   ├── orphanTmpSweep.ts      # Sweeps orphaned atomic-write temps
│   │   │   ├── quitFailureBreadcrumb.ts # `.filo/quit-failure.json` when quit preserved files
│   │   │   ├── vaultRegistry.ts       # Active vault tracker (gates IPC); armedAt: when the open began
│   │   │   ├── recoverySnapshot.ts    # `.filo/recovery/` snapshots; `<ts>-unsaved/` rescue copies and `<ts>-keep/` kept versions (never pruned)
│   │   │   ├── renameCorrelation.ts   # Pairs missing+present events into renames
│   │   │   ├── rendererCrashHandler.ts # Renderer crash → breadcrumb + Reload/Quit dialog
│   │   │   ├── recentVaults.ts        # Persisted recent vault list
│   │   │   ├── windowState.ts         # Window size/position (userData)
│   │   │   └── sidebarState.ts        # Sidebar width/floating bounds (userData)
│   │   ├── protocol/                  # Custom protocol handlers
│   │   │   ├── filoMedia.ts           # The filo:// protocol: streams vault media
│   │   │   ├── mediaPathGuard.ts      # resolveServableMediaPath: in-vault, not `.filo/`
│   │   │   └── rangeHeader.ts         # HTTP Range parsing for media streaming
│   │   ├── vault/                     # Main-side vault file primitives
│   │   │   ├── fileOps.ts
│   │   │   ├── boardFileOps.ts
│   │   │   ├── boardLoadErrors.ts     # Typed `board:load` failure codes (locked / offline / not found), so transient ones offer Retry
│   │   │   ├── configOps.ts
│   │   │   ├── trashOps.ts            # .filo/trash/<id>/ entries: move in, restore, purge to Recycle Bin
│   │   │   ├── exclusiveCreate.ts     # createExclusiveFile: `wx` reserve, write over only our placeholder, unlink only ours
│   │   │   └── filenameUtils.ts       # atomicWriteFile, tmpSiblingPath
│   │   └── utils/
│   │       ├── pathSecurity.ts        # assertWithinVault, assertSafeRelativePath (depth/length caps), assertSafeFilename (Windows-only rules only on Windows or at creation)
│   │       ├── pathHelpers.ts         # relativePosix (path.relative, resolves `..`; kept apart from the string-only shared helpers)
│   │       ├── permissionPolicy.ts    # decidePermission: only app-frame audio capture is allowed
│   │       ├── activeVaultCheck.ts    # assertActiveVault (gates IPC handlers)
│   │       ├── contentSecurityPolicy.ts # The app-origin CSP header
│   │       ├── navigationGuard.ts     # will-navigate: in-app navigation allowed, external blocked
│   │       ├── embedPopup.ts          # An iframe tile's new-window link → default browser (public https, one a second)
│   │       ├── payloadLimits.ts       # Size caps for every write-shaped IPC handler
│   │       ├── windowCloseDecision.ts # The window close handler's re-entrancy decision
│   │       ├── mainLogger.ts          # Structured main-process logger
│   │       └── mime.ts                # MIME-type sniffing for media tiles
│   │
│   ├── renderer/                      # Svelte frontend (all UI)
│   │   ├── main.ts                    # Svelte app mount
│   │   ├── App.svelte                 # Root component, layout shell
│   │   ├── shims.d.ts                 # Ambient type shims (window.filo, etc.)
│   │   │
│   │   ├── core/                      # Core application wiring
│   │   │   ├── commandRegistry.ts     # Keyboard-shortcut binding surface (no palette yet)
│   │   │   ├── tileRegistry.ts        # Tile-type metadata + creation defaults (getTileDefaults); tile bodies render via board snippets, not a component map
│   │   │   ├── boardRegistry.ts       # Board-type registration; `component` is a lazy () => import() loader so boards code-split out of the Home preload
│   │   │   ├── boardDefaults.ts       # Per-type default board factories
│   │   │   ├── boardModules.ts        # A board type's loaded component module (or its one pending import)
│   │   │   ├── boardTileOps.ts        # BoardTileOps contract + BoardType → ops registry (opsFor)
│   │   │   ├── boardTileOps/          # Per-board-type tile-op registries (mindmap/kanban/tasklist/document)
│   │   │   │   ├── mindmap.ts, kanban.ts, tasklist.ts # Each board type's tile add / remove / update ops
│   │   │   │   ├── document.ts        # Exhaustive no-op (a Document board has no tiles)
│   │   │   │   └── projectTile.ts     # projectDef: a tile's title / tags / file name read from its note, tags.json or path
│   │   │   ├── boardConnectionsOps.ts # BoardType → connection mutators registry (connectionsOpsFor)
│   │   │   ├── boardFramesOps.ts      # BoardType → frame mutators registry (framesOpsFor)
│   │   │   ├── vaultLifecycle.ts      # onVaultSwap pre/post-swap hook registry
│   │   │   └── hotkeys.ts             # Keyboard shortcut binding
│   │   │
│   │   ├── stores/                    # Svelte 5 rune stores (.svelte.ts files)
│   │   │   ├── vault.svelte.ts        # Vault lifecycle, file tree, virtual project
│   │   │   ├── vaultIndex.svelte.ts   # In-memory metadata index + MiniSearch
│   │   │   ├── notes.svelte.ts        # noteStore: one NoteModel per open note (by VaultPath), owns the note writer
│   │   │   ├── noteModel.svelte.ts    # The NoteModel class and the note store's public types (notes.svelte.ts re-exports them)
│   │   │   ├── noteMeta.ts            # noteTitle / noteTags / noteFrontmatter selectors (model, else vault index)
│   │   │   ├── notePrompts.ts         # The note conflict prompt (Reload / Keep mine) + deleted-note prompt
│   │   │   ├── vaultExternalChanges.ts  # Watcher events → vault index + noteStore.onDiskChanged
│   │   │   ├── vaultExternalReconcilers.ts # Registers a reconciler per watcher event kind
│   │   │   ├── vaultExternalPrompts.ts  # Attachment / note deleted outside Filo while tiles point at it
│   │   │   ├── vaultExternalDriftPrompts.ts # Startup registration of the writers' drift prompts
│   │   │   ├── openTagHousekeeping.ts # After open: seed an empty tag registry, or prune gone files' tags once the recovery prompts are answered
│   │   │   ├── search.svelte.ts       # Search panel state: query, matches, replace
│   │   │   ├── vaultRecovery.ts       # `.filo/.dirty.<machineId>` sentinel + recovery modal
│   │   │   ├── foreignSentinels.svelte.ts # Other machines' sentinels in a synced `.filo/`: listed / one info toast, never resumed or cleared
│   │   │   ├── vaultLifecycleGuard.svelte.ts # One vault open or close at a time (a second returns 'busy'; Home disables its cards)
│   │   │   ├── awaitConfirm.ts        # uiStore.openConfirm as a promise (the recovery sequencer's steps)
│   │   │   ├── vaultLeaveGuard.ts     # saveBeforeLeaving / saveUntilSettled: close, open another vault and quit save first, ask only if work is left; leftBehind copies late work at the swap
│   │   │   ├── vaultRenameQueue.ts    # The watcher reconcile chain: arrival order, skipped once its vault is let go
│   │   │   ├── vaultOpen.ts           # pickAndOpenVault: folder picker → openVault → Recent vaults (Home, vault menu, Ctrl+O)
│   │   │   ├── vaultColor.ts          # activeVaultColor: the open vault's colour (toolbar, sidebar header)
│   │   │   ├── unsavedRescue.ts       # keepRescueCopies → `.filo/recovery/<ts>-unsaved/` (notes, boards, `_filo__*.json` for `.filo/` state)
│   │   │   ├── heldDecisions.ts       # Changes held for a Reload / Keep mine answer (the save popover re-opens each prompt)
│   │   │   ├── saveStateFeed.ts       # unsavedWork() + held decisions + reported failures → the save indicator
│   │   │   ├── boardDrift.ts          # One board drift prompt per path (watcher and writer); Reload reads disk into the cache and clears the board's undo history
│   │   │   ├── boardViewRevision.svelte.ts # Bumped on a reload / tag rename, so a mounted Kanban / Task List hydrates its filters again
│   │   │   ├── configDriftPrompt.ts   # Reload / Keep local for a `.filo/` settings file changed outside Filo
│   │   │   ├── newNotesInTree.ts      # Every created note re-reads the sidebar tree
│   │   │   ├── sidebarTagFilter.svelte.ts # Sidebar tag-chip filter (view state; folder open/closed while filtering)
│   │   │   ├── noteLayout.ts          # setNoteLineSpacing
│   │   │   ├── vaultFolderOps.ts      # In-app rename/move
│   │   │   ├── vaultDeleteOps.ts      # Sidebar delete → .filo/trash + tile cascade (undoable)
│   │   │   ├── trash.svelte.ts        # Settings → Trash list, restore, empty, 30-day purge
│   │   │   ├── vaultStoreTypes.ts     # Shared store types
│   │   │   ├── vaultTree.ts           # File-tree projection helpers
│   │   │   ├── vaultProject.ts        # Per-vault virtual project bootstrap
│   │   │   ├── vaultRootFolder.ts     # User-marked vault root for sidebar
│   │   │   ├── board.svelte.ts        # Active board facade
│   │   │   ├── boardCache.svelte.ts   # Per-board file cache + persist* CRUD
│   │   │   ├── boardCacheTiles.ts     # Cache-side tile/placement writers
│   │   │   ├── boardCacheKanban.ts    # Kanban cache writers
│   │   │   ├── boardCacheTaskList.ts  # Task-list cache writers
│   │   │   ├── boardCacheConnectionsFrames.ts
│   │   │   ├── boardCacheFrontmatter.ts # Path-field rewrites on rename + cascade-delete planning
│   │   │   ├── boardCacheDelete.ts    # Board delete → .filo/trash
│   │   │   ├── boardDiscovery.ts      # adoptBoardAtRuntime: a .board.json that appeared mid-session or failed to load at open
│   │   │   ├── boardProvisionalMissing.ts # A vanished board is held, not evicted, until a recheck (Windows folder renames report no children)
│   │   │   ├── boardCacheTypes.ts
│   │   │   ├── boardConnections.ts    # Active-board connection facade
│   │   │   ├── boardFrames.ts         # Active-board frames facade
│   │   │   ├── boardTiles.ts          # Active-board tiles facade
│   │   │   ├── boardWaypointsGroups.ts
│   │   │   ├── boardFrontmatterSync.ts  # Rename propagation + cascade delete (history dispatch)
│   │   │   ├── boardIdentity.ts       # Board rename (renames the .board.json, and its folder while named after the board) / emoji; a renamed .board.json renames its board
│   │   │   ├── boardHistory.ts        # Per-board history facade for boardStore
│   │   │   ├── boardRefIntegrity.svelte.ts  # Broken file-reference tracking
│   │   │   ├── boardStoreTypes.ts
│   │   │   ├── canvas.svelte.ts
│   │   │   ├── selection.svelte.ts
│   │   │   ├── history.svelte.ts      # Per-board undo/redo stacks
│   │   │   ├── tabs.svelte.ts
│   │   │   ├── workspace.svelte.ts    # Split-pane layout
│   │   │   ├── connections.svelte.ts
│   │   │   ├── frames.svelte.ts
│   │   │   ├── fileTags.svelte.ts     # `.filo/tags.json`: tag registry + media-file tags; vault-wide rename/remove
│   │   │   ├── fileTagsCascade.svelte.ts # Tag rename / remove cascade into board-only tiles and board settings, plus the `.md` sweep
│   │   │   ├── tagUndo.svelte.ts      # Undo toast for vault-wide tag delete / rename
│   │   │   ├── templates.svelte.ts    # Layout-template store
│   │   │   ├── ui.svelte.ts           # Modals, toasts, context menu state
│   │   │   ├── theme.svelte.ts
│   │   │   ├── themeVersion.svelte.ts # Counts theme applications; colours read off :root re-resolve on a switch
│   │   │   ├── spatial.svelte.ts      # rbush index wrapper
│   │   │   ├── guides.svelte.ts       # Smart guides
│   │   │   ├── pendingSettings.svelte.ts  # Settings modal Apply/Cancel scope
│   │   │   ├── orphans.svelte.ts
│   │   │   ├── links.svelte.ts        # filo:// internal link handling
│   │   │   ├── tiles.svelte.ts        # Tile factory + drop-type detection; recordingTiles (runtime: Audio tiles recording now)
│   │   │   ├── saveState.svelte.ts    # Saved / saving / failed / waiting-for-a-decision indicator
│   │   │   └── toolbar.svelte.ts      # Toolbar undo/redo state
│   │   │
│   │   ├── schema/                    # Zod schemas + inferred TypeScript types
│   │   │   ├── index.ts               # Re-exports
│   │   │   ├── project.ts              # Virtual Project (in-memory only — no file on disk)
│   │   │   ├── board.ts
│   │   │   ├── boardFile.ts           # v8 .board.json file shape (visuals only) + boardId cross-checks
│   │   │   ├── tile.ts
│   │   │   ├── styleEnums.ts           # Shape / border / pattern / path / arrow enums: the one source for style options
│   │   │   ├── placement.ts
│   │   │   ├── connection.ts
│   │   │   ├── frame.ts
│   │   │   ├── settings.ts
│   │   │   ├── tagsFile.ts             # .filo/tags.json envelope + migration scaffold
│   │   │   ├── layoutTemplate.ts       # .filo/templates/*.json envelope + migration scaffold
│   │   │   ├── link.ts                 # filo:// link encode/decode + DecodedFiloLinkSchema
│   │   │   ├── migrations.ts          # Board version gate: only the current version loads (no steps today)
│   │   │   └── schemaUtils.ts          # uniqueBy / uniqueStrings / idString (NANOID_REGEX)
│   │   │
│   │   ├── commands/                  # Command pattern objects (undo/redo)
│   │   │   ├── index.ts               # Re-export shim — every import path still works
│   │   │   ├── Command.ts             # Base Command interface + abstract class (targetBoardId, renamePath)
│   │   │   ├── commandPaths.ts        # rebaseCommandFields: PATH_FIELDS / CONTENT_FIELDS, trashed paths pinned
│   │   │   ├── noteGoneError.ts       # Undo / redo on a note that no longer exists
│   │   │   ├── missingTargetToast.ts  # "The target no longer exists" toast for an undo / redo whose tile or column is gone
│   │   │   ├── changeRefusedError.ts  # A note that can't take a command's change: toast, and the step leaves the stack
│   │   │   ├── noteLayoutCommands.ts  # SetLineSpacingCommand (frontmatter `lineSpacing:`)
│   │   │   ├── tileCommands.ts        # tile add/delete/move/resize/style/lock
│   │   │   ├── trashedFiles.ts        # trashFiles / restoreFiles: shared by the delete commands' undo
│   │   │   ├── noteFieldCommand.ts    # Base of the card/task field commands: forward + inverse FrontmatterDelta
│   │   │   ├── frontmatterInverse.ts  # inverseDelta, applyDeltaChecked (same-key conflict check on undo)
│   │   │   ├── updateTitleCommand.ts  # Title edit = frontmatter `title:` delta (+ board titleHtml)
│   │   │   ├── renameFileCommand.ts   # Undo of "Rename file to match title"
│   │   │   ├── tileTagCommands.ts     # tile/path tag add/remove + fade-by-tag
│   │   │   ├── connectionCommands.ts  # connection add/delete/update
│   │   │   ├── frameCommands.ts       # frame add/update/move/delete
│   │   │   ├── sectionCommands.ts     # Task List section add/delete/rename/reorder
│   │   │   ├── taskCommands.ts        # Task List add/delete/move/field/lock/style
│   │   │   ├── kanbanCommands.ts      # Kanban card + column add/delete/move/rename
│   │   │   ├── waypointCommands.ts    # Mind Map waypoint add/remove/rename/move/icon/lock
│   │   │   ├── groupAndBoardCommands.ts # BatchCommand, ToggleGroupCommand, CascadeDeleteCommand, UpdateBoardSettingsCommand
│   │   │   ├── styleCommands.ts       # Style-popup commands (Frame/Card/Column/Task/Section/Connection)
│   │   │   ├── propertiesCommands.ts  # UpdatePropertiesCommand: the Document tab's tag-row frontmatter delta
│   │   │   ├── attachmentSrcCommand.ts # Image/Video/Audio/File swap
│   │   │   ├── replaceAllCommand.ts   # Vault-wide find-and-replace (keeps splices + hashes, never whole notes)
│   │   │   └── savedViewsCommand.ts   # UpdateSavedViewsCommand
│   │   │
│   │   ├── constants/
│   │   │   ├── defaults.ts            # TILE_DEFAULTS, FRAME_DEFAULTS, ACCENT_COLOR
│   │   │   ├── icons.ts               # Shared single-path icon `d` strings (STYLE_ICON_PATH, PIN_ICON_PATH)
│   │   │   ├── boardIcons.ts          # Each board type's icon path (New-board menu, sidebar file tree)
│   │   │   ├── styleOptions.ts        # Style option lists, read from the `schema/styleEnums.ts` enums
│   │   │   ├── menuVocabulary.ts      # Context-menu labels, icons, plural headings; order Open, Style, Tags, Lock, Remove, Delete
│   │   │   ├── taskPriorities.ts      # Task / Kanban priority display metadata (color + label)
│   │   │   └── vaultSidebarOptions.ts # Sidebar Sort By / Group By choices (sidebar menus + settings)
│   │   │
│   │   ├── lib/                       # Pure logic, no UI
│   │   │   ├── notes/                 # The note model's pure half + note flows
│   │   │   │   ├── noteWriter.ts      # THE only .md writer: one queue per path, fresh read per flush, body-drift → conflict
│   │   │   │   ├── noteFile.ts        # Pure parse/assemble: frontmatter, body, BOM, EOL, content hash
│   │   │   │   ├── frontmatterFence.ts # splitFrontmatterFence: the one place a `---` block is found
│   │   │   │   ├── frontmatterRefusal.ts # The one wording for a metadata edit a note's frontmatter can't take
│   │   │   │   ├── noteDiskChange.ts  # decideDiskChange: what a watcher event does to a loaded note
│   │   │   │   ├── rawViews.ts        # Mounted raw views: unsaved text for close / quit and the save indicator, flush, rescue copies (marked only once kept; a called-off leave rolls back)
│   │   │   │   ├── renameGrace.ts     # askUnlessMoved: wait out a rename before "deleted" / "couldn't save"
│   │   │   │   ├── unsavedNoteTexts.ts # The text a rescue copy holds for each unsaved note
│   │   │   │   ├── createNote.ts      # createNoteFile: exclusive create with `title:`, ` (n)` on collision
│   │   │   │   ├── openNote.ts        # openNoteInDocumentTab
│   │   │   │   ├── recreateNote.ts    # recreateMissingNote: a broken text tile's "Recreate backing file" (exclusive create)
│   │   │   │   ├── renameToTitle.ts   # "Rename file to match title"
│   │   │   │   └── setNoteTitle.ts    # Document-tab title edit → frontmatter `title:`
│   │   │   ├── vault/                 # Vault-side helpers (renderer)
│   │   │   │   ├── vaultIndex.ts      # Metadata indexing + MiniSearch wiring
│   │   │   │   ├── vaultOperations.ts # Disk-shape IPC: withDrainedWrites, rename, trash/restore, folder, copy
│   │   │   │   ├── fileRefIntegrity.ts # Board path rewrites on rename, cascade-delete targets, broken refs
│   │   │   │   ├── dirtyFlagRecovery.ts # `.filo/.dirty.<machineId>` sentinel read/write
│   │   │   │   ├── machineIdentity.ts # This machine's id, fetched once at boot; builds its own sentinel paths
│   │   │   │   ├── machineSentinels.ts # Read / clear this machine's own crash-recovery sentinel
│   │   │   │   ├── quitFailureRecovery.ts # Read / clear `.filo/quit-failure.json` on open (cleared only when the user dismisses)
│   │   │   │   ├── vaultIdentity.ts   # isStillSameVault: path + generation token, checked after every await
│   │   │   │   ├── activeVaultPath.ts # The committed vault root as a leaf holder (no store imports, so no cycle)
│   │   │   │   ├── vaultOpenFailure.ts # Why a vault didn't open (Home drops a recent only when the folder is gone)
│   │   │   │   ├── loadVersionedFile.ts # Migrate-then-validate for every versioned `.filo/` config (refuses from-future)
│   │   │   │   ├── convertToUtf8.ts   # "Convert to UTF-8…" on a non-UTF-8 note (backup, then decode as Windows-1252)
│   │   │   │   ├── syncConflictNotices.ts # One sticky notice per sync-client conflict copy (at open and live)
│   │   │   │   ├── nonUtf8Paths.svelte.ts # Read-only note paths: non-UTF-8 bytes, and symbolic links (isLinkedNote)
│   │   │   │   ├── recoveryLocations.ts # Rescue folders + moved-aside files the recovery modal points at
│   │   │   │   ├── vaultCandidate.ts  # Vault open as a transaction: every fallible read before the swap
│   │   │   │   ├── externalChangeRegistry.ts # The one exhaustive dispatcher for `vault:files-changed`
│   │   │   │   ├── handleFlushAndQuit.ts # The quit drain: save, then rescue copies if work is left
│   │   │   │   ├── conventionPaths.ts # Default folders + free-name helpers for new files
│   │   │   │   ├── extension.ts
│   │   │   │   ├── moveIntoFolder.ts
│   │   │   │   ├── moveIntoFolderFeedback.ts # The toast wording for a failed move into a folder
│   │   │   │   ├── renameVaultEntry.ts # Sidebar rename: re-attaches a hidden extension, confirms before replacing a target
│   │   │   │   ├── renamePathKeys.ts  # renameAllPathKeys: every path-keyed map registers a rename sweep
│   │   │   │   ├── renameInFlight.ts  # Non-zero while an in-app rename is mid-flight, so a reconcile doesn't evict the board
│   │   │   │   ├── renameCascadeRepair.ts # Replay or discard a rename cascade a crash left half-done
│   │   │   │   ├── boardTypeForPath.ts # A sidebar `.board.json`'s board type, for its icon (in-memory lookup)
│   │   │   │   ├── tagsStorage.ts     # `.filo/tags.json` mutators
│   │   │   │   ├── tagsFileMerge.ts   # 3-way merge of `.filo/tags.json` (external reload, pre-write)
│   │   │   │   ├── tagRewriteSweep.ts # Two-phase tag rename/remove across .md (each write via noteStore.transform)
│   │   │   │   ├── tagRewriter.ts     # Frontmatter tag rename/remove/add (line-level fast path, CST-patch fallback)
│   │   │   │   ├── frontmatterCstModel.ts # patchFrontmatterSourceCst: source-preserving FM patch on the `yaml` CST; dumpPreservesUntouched (the dump fallback's check)
│   │   │   │   ├── frontmatterEngine.ts # Shared FM value helpers for the CST engine
│   │   │   │   ├── frontmatterDelta.ts  # FrontmatterDelta { set / unset } + merge
│   │   │   │   ├── frontmatterRead.ts # The one FM read path (`yaml` package)
│   │   │   │   ├── tagRewriteSentinel.ts # `.filo/tag-rewrite-pending.<machineId>.json` crash-recovery
│   │   │   │   ├── renameCascadeSentinel.ts # Rename-cascade crash-recovery sentinel (path rewrites only)
│   │   │   │   ├── fileBaselineRegistry.ts # Pre-write drift baselines (mtime/size) for board + `.filo/` files
│   │   │   │   ├── externalChangeWindows.ts # Self-write / attachment-delete / note-rename grace windows
│   │   │   │   ├── keepLocalBackup.ts # backupThenRead: back up, read, re-stat (Keep mine overwrites only what it backed up)
│   │   │   │   ├── relinkTargets.ts   # Which files a broken tile may be re-linked to (a file tile: any)
│   │   │   │   ├── folderPins.ts      # Root Directory + board folder pins: follow renames, clear on delete
│   │   │   │   ├── folderPinPaths.ts  # Case-folded pin path rules (no store imports)
│   │   │   │   ├── treeFolderMoves.ts # Folder renames read off two tree reads (Windows reports only the folder names)
│   │   │   │   ├── unreconciledFolderMoves.ts # Folder moves any tree read saw, kept for the next reconcile
│   │   │   │   ├── unsavedMessages.ts # Close / open / quit wording for unsaved work, by cause
│   │   │   │   ├── sidebarTagFilter.ts # Files a tag (or child tag) selects; tree cut down to them
│   │   │   │   ├── sidebarFileMenu.ts # The sidebar file / folder context menu
│   │   │   │   └── vaultTreeSort.ts   # Sidebar sort/group helpers
│   │   │   ├── boards/                # Board file load/save logic
│   │   │   │   ├── boardLoader.ts     # Loads and validates a board; hands its stat back, never stamps the drift baseline
│   │   │   │   ├── boardBaseline.ts   # adoptLoadedBoardBaseline: stamps a loaded board's baseline once its data is in the cache
│   │   │   │   ├── boardLoadFailedNotice.ts # An unusable board: what is wrong, the .filo/recovery copy, Show in folder
│   │   │   │   ├── boardLoadRetryPrompt.ts # A board locked / offline at open: sticky notice with Retry (adoptBoardAtRuntime)
│   │   │   │   ├── boardReorder.ts    # Board Browser keyboard reorder (Alt+Arrow swap in the visible list)
│   │   │   │   ├── boardSaver.ts      # File-write helpers
│   │   │   │   ├── boardScope.svelte.ts
│   │   │   │   ├── boardScopeFactory.ts
│   │   │   │   ├── boardWriteScheduler.ts
│   │   │   │   ├── boardWriteDebounce.ts
│   │   │   │   ├── configWriteScheduler.ts
│   │   │   │   ├── configDrift.ts     # A `.filo/` config changed or deleted outside Filo: rebase, keep layout, ask for settings, recreate
│   │   │   │   ├── miscWriteScheduler.ts
│   │   │   │   ├── writeScheduler.ts  # createScheduler: the shared debounce/retry/timeout primitive
│   │   │   │   ├── writeSchedulerTypes.ts # createScheduler's type surface (re-exported by writeScheduler.ts)
│   │   │   │   ├── writeSchedulerFailures.ts # Failure attribution + retention of transient failures for Retry / Ctrl+S
│   │   │   │   ├── writeErrorToast.ts # The toast for a failed debounced write (names a preserved temp file)
│   │   │   │   ├── lastViewFlush.ts   # Writes a Kanban / Task List `lastView` by the captured board id at teardown
│   │   │   │   ├── tileMemberships.ts # A deleted Mind Map tile's frames and groups, put back on undo
│   │   │   │   ├── boardNaming.ts     # A board's name is its .board.json stem: name rules, new-board place, folder-follow rule
│   │   │   │   ├── newBoardPlace.ts   # Where a new board goes in the open vault, and whether its name is free there
│   │   │   │   ├── seedTextFileForNewTile.ts # Creates the backing .md for a new text tile
│   │   │   │   ├── tileDefBuilder.ts
│   │   │   │   ├── textTilePath.ts
│   │   │   │   ├── viewportCache.ts
│   │   │   │   ├── toggleLockSelection.ts # Ctrl+L rule (lock all if any unlocked), one undo step
│   │   │   │   ├── boardToolbar.svelte.ts # A board's floating side toolbar: drag, pin, right-click dock (per board, `.filo/workspace.json`)
│   │   │   │   ├── componentFlush.ts  # registerComponentFlush: what a mounted view holds, handed over by a save or a leave
│   │   │   │   ├── componentWriteRetry.ts # A locked theme / template save kept for Retry and for a rescue copy
│   │   │   │   ├── boardModulePreload.ts # Loads every board type's code while idle after a vault opens
│   │   │   │   └── writeStateTracking.ts # trackComponentWrite + counters
│   │   │   ├── canvas/                # Canvas engine (custom pointer events)
│   │   │   │   ├── coordinates.ts     # screenToCanvas, getCanvasPointFromEvent
│   │   │   │   ├── gestures.ts        # Pan/zoom pointer-event bindings
│   │   │   │   ├── edgePan.ts         # Edge-panning on drag
│   │   │   │   ├── tileDrag.ts
│   │   │   │   ├── tileResize.ts
│   │   │   │   ├── dragDrop.ts        # OS file drop → tile factory
│   │   │   │   ├── markdownTileSeed.ts
│   │   │   │   ├── layout.ts          # Auto-layout algorithms
│   │   │   │   ├── orphanCatcher.ts
│   │   │   │   ├── floatingToolbarDrag.ts # Shared toolbar drag: background only, pin blocks it, cancel reverts, clamp to window
│   │   │   │   ├── vaultPath.ts
│   │   │   │   ├── minimapBounds.ts   # Minimap window math: a local window around the viewport, tiles AABB apart
│   │   │   │   └── smartGuides.ts     # Alignment guide calculations
│   │   │   ├── connections/           # Connection path routing
│   │   │   │   ├── pathRouter.ts      # Curved, Straight, Elbow, Smart routing
│   │   │   │   ├── connectionCulling.ts # Viewport culling for connections (endpoint AABB vs. viewport)
│   │   │   │   ├── connectionPathMemo.ts # Caches each path's `d` by its inputs, so a pan re-routes nothing
│   │   │   │   └── bubblePositions.ts
│   │   │   ├── editor/                # TipTap setup
│   │   │   │   ├── createEditor.ts    # Editor factory with all extensions
│   │   │   │   ├── closeDrainGate.svelte.ts # Freezes the editors while a leave saves (held until the swap unmounts them)
│   │   │   │   ├── markdownSync.ts    # MD ↔ ProseMirror round-trip
│   │   │   │   ├── blockLayout.ts     # Aligned / indented paragraph or heading → one HTML line
│   │   │   │   ├── noteEditorView.ts  # Editor ↔ noteStore bridge (150 ms idle serialise; never reloads its own body)
│   │   │   │   ├── editorHistory.ts   # resetEditorHistory: a full load is an undo boundary
│   │   │   │   ├── setEditorEditable.ts # Toggle editability without emitting `update` (no phantom write)
│   │   │   │   ├── emptyParagraphs.ts # Blank lines the user typed survive the Markdown round-trip (sentinel encode / strip)
│   │   │   │   ├── taskListTight.ts   # A list stays tight on reload when an item holds an aligned / indented HTML paragraph
│   │   │   │   ├── titleCommit.ts     # TileHeader / Frame title commit: trim, default, drop unstyled HTML
│   │   │   │   ├── toolbarConfig.ts   # Formatting toolbar ↔ active editor bridge (every command runs via chainIfEditable)
│   │   │   │   ├── insertLink.ts      # Insert Link popup target + apply/remove (a caret inside or right after a link edits it; else inserts)
│   │   │   │   ├── linkUrl.ts         # normaliseLinkUrl: bare domain → https://, address → mailto:; isOpenable (the one scheme list)
│   │   │   │   ├── linkClicks.ts      # Link clicks: plain click edits in a focused editor, Ctrl/Cmd+click opens
│   │   │   │   ├── blockTextStyle.ts  # Heading / Normal text clears the blocks' inline font size, family, colour
│   │   │   │   ├── keepSpaces.ts      # Load keeps runs of spaces; soft breaks still join with one space
│   │   │   │   ├── tabNode.ts         # A typed tab: one inline item, saved as a tab character
│   │   │   │   ├── tabKeys.ts         # Tab / Shift+Tab / Backspace in a note, as in a word processor
│   │   │   │   └── textEscapes.ts     # The text node: a typed `&amp;` / `&copy;` is saved so it reopens as typed
│   │   │   ├── media/                 # Audio tile recordings
│   │   │   │   └── audioRecording.ts  # A take is saved and linked to the board and vault it started on, even after the tile unmounts
│   │   │   ├── tags/                  # Tag editing helpers
│   │   │   │   ├── noteTagWriter.ts   # Tile/path tag add/remove on a note (fresh-read rewrite)
│   │   │   │   ├── tagEditConfirm.ts  # Tags-browser delete/rename confirms → tagUndo
│   │   │   │   ├── tagRowInput.ts     # Tag-row parsing: comma list, autocomplete
│   │   │   │   └── tagBrowserFilter.ts # Tags Browser search (keeps parent rows) + one-pass tag counts
│   │   │   ├── frames/                # Frame delete confirm + drag cancel
│   │   │   │   ├── confirmRemoveFrame.ts # The Delete Frame confirm (frame button and context menu)
│   │   │   │   └── frameDragCancel.ts # A frame drag torn down mid-gesture reverts the frame and its tiles
│   │   │   ├── kanban/                # Kanban-board logic
│   │   │   │   ├── kanbanContextMenus.ts # Card / column / bulk menus
│   │   │   │   ├── kanbanFrontmatterWriter.ts # Card field edits → note frontmatter deltas
│   │   │   │   ├── kanbanDragController.svelte.ts, kanbanMultiSelect.svelte.ts
│   │   │   │   ├── kanbanFiltersAndSort.svelte.ts, kanbanSavedViews.svelte.ts
│   │   │   │   └── kanbanTileCreation.ts, kanbanFileDropHandler.ts, kanbanInsertPosition.ts
│   │   │   ├── tasklist/              # Task List logic
│   │   │   │   ├── notesBox.svelte.ts # The row notes box draft; an unsaved draft counts for leave / quit (rescue copy, held conflict)
│   │   │   │   ├── taskContextMenus.ts
│   │   │   │   ├── frontmatterWriter.ts # Task field edits → note frontmatter deltas
│   │   │   │   ├── indentRules.ts     # indentProblem: one indent rule for drag and Tab (section, cycle, 3 levels)
│   │   │   │   ├── manualSortSwitch.ts # Reorder under a non-manual sort: one undo step, a toast whose Undo undoes only that step
│   │   │   │   ├── tocPlacement.ts    # Where the Table of Contents first opens (beside the list when there is room)
│   │   │   │   ├── fileDropHandler.ts # OS / sidebar file drop onto a Task List → tasks
│   │   │   │   ├── datePickerViewState.svelte.ts # TaskDatePicker's shown month (re-seeds only when the value changes)
│   │   │   │   ├── clearStaleDndStyles.ts # Action clearing svelte-dnd-action's leftover inline styles on a section
│   │   │   │   ├── sectionMembership.ts # A Task List as section + order per task: undo moves only the tasks a step moved, starts recomputed live
│   │   │   │   ├── taskCreation.ts, taskDeletion.ts, sectionOps.ts, sectionMath.ts, blockMove.ts
│   │   │   │   ├── taskDragController.svelte.ts, multiSelectController.svelte.ts, indentGesture.ts
│   │   │   │   └── filtersAndViews.svelte.ts, taskListViewModel.svelte.ts, taskListKeyboardNav.svelte.ts
│   │   │   ├── tasks/                 # Task helpers shared by Kanban and Task List
│   │   │   │   ├── frontmatterReaders.ts # Task fields read from a note's frontmatter
│   │   │   │   ├── taskBodyText.ts    # A task's notes text (the body under the frontmatter)
│   │   │   │   ├── quickAddParser.ts  # Natural-language quick add
│   │   │   │   └── recurrence.ts, dateMath.ts, dateOrder.ts, dueDateFormat.ts, taskListModel.ts, taskMove.ts
│   │   │   ├── mindmap/               # Mind-map keyboard + selection
│   │   │   │   ├── mindMapContextMenus.ts # Tile / frame / canvas menus ("N tiles selected" group)
│   │   │   │   ├── mindMapKeyboard.ts # Arrow-key neighbour tile, and when the canvas leaves keys alone
│   │   │   │   ├── marqueeSelectionController.svelte.ts # Per-pane shift-drag marquee selection
│   │   │   │   ├── visibleTilesViewModel.svelte.ts # Per-pane viewport culling of tiles
│   │   │   │   ├── frameHitTest.ts    # Topmost frame under a point (a collapsed frame: its header only)
│   │   │   │   └── selectionActions.ts # Lock / Tags / Style / Delete on the selection (the Delete key too)
│   │   │   ├── settings/              # Settings dialog helpers
│   │   │   │   ├── settingsSalvage.ts # app.json / defaults.json load: a bad field resets alone, unknown keys kept
│   │   │   │   ├── currentBoardHelpers.ts # Current Board fields: dotted-path read / write, boolean selects
│   │   │   │   ├── numberInput.ts     # Number fields: clamp to the schema range, blank = inherit
│   │   │   │   ├── unappliedEditsPrompt.ts # settleUnappliedEdits: Apply / Discard / Cancel before a bulk action
│   │   │   │   └── confirmDiscardSettings.ts # Closing Settings with unapplied edits asks first
│   │   │   ├── fonts/
│   │   │   │   └── importedFonts.ts   # `.filo/fonts/` registered with the page on every vault open
│   │   │   ├── styles/                # Override-cascade resolver
│   │   │   │   ├── effectiveStyle.ts  # Tile / column / card / task / document style cascade; General font sizes as its bottom layer
│   │   │   │   ├── elementStyleTargets.ts # Per-kind fields, writer and undo command for ElementStylePopup
│   │   │   │   ├── resolveStyle.ts
│   │   │   │   ├── resolvedTileStyleContext.ts
│   │   │   │   ├── buildBoardDefaults.ts
│   │   │   │   ├── applyDefaultsToAll.ts # "Use Default Font Sizes for all Existing Items": clears every element's own size
│   │   │   │   └── tileStyleSupport.ts # Which style fields each tile type renders
│   │   │   ├── themes/                # Theme loading + CSS variable injection
│   │   │   │   ├── themeManager.ts    # Paints a built-in or custom theme onto :root; snapshotThemeVariables
│   │   │   │   ├── themeTokens.ts     # The colours a theme holds, grouped for the editor; the settings variables it never holds
│   │   │   │   ├── themeFiles.ts      # Custom theme names / ids (no built-in name, no overwrite); import and disk reads keep only theme tokens, unknown base → Light
│   │   │   │   ├── themeActions.ts    # Pick (saved to appearance.json), System colours only, card previews, delete to Filo's trash, editor sessions
│   │   │   │   ├── themeEditorGuard.ts # Unsaved theme-editor changes: Save / Discard / Keep editing before a tab switch or Settings closing
│   │   │   │   ├── defaultColours.ts  # The Global Defaults colours a theme pick hands back to the theme
│   │   │   │   └── chromeText.ts      # Toolbar / tab bar colour settings over the theme's, and their black / white text
│   │   │   ├── templates/             # Layout templates
│   │   │   │   ├── templateService.ts
│   │   │   │   ├── layoutCapture.ts
│   │   │   │   └── layoutTemplateStore.ts
│   │   │   ├── search/                # Query parser + full-text search runner (MiniSearch)
│   │   │   │   ├── queryParser.ts     # `tag:` / `board:` / `has:` / `property:` / `type:` operators, /regex/, free text
│   │   │   │   └── runSearch.ts       # runVaultSearch: every tile on every board plus notes on no board
│   │   │   ├── spatialIndex.ts        # rbush wrapper
│   │   │   └── utils/                 # Shared utilities
│   │   │       ├── ids.ts             # nanoid wrapper
│   │   │       ├── lineEnding.ts      # fileLineEnding (majority) / frontmatterLineEnding: note writer + tag rewriter
│   │   │       ├── color.ts           # Colour manipulation helpers
│   │   │       ├── cloneTile.ts
│   │   │       ├── contextMenuKey.ts
│   │   │       ├── editableTarget.ts
│   │   │       ├── errorBus.ts        # Renderer error → toast routing
│   │   │       ├── openExternal.ts    # openExternalUrl: every link click; http:// refused with a toast
│   │   │       ├── errorToastAggregator.ts
│   │   │       ├── invokeOk.ts        # Envelope-aware `window.filo.invoke`: resolves the success value, rejects IpcEnvelopeError
│   │   │       ├── openVaultFile.ts   # Open a vault file in its OS app (allowlisted types; else Show in folder)
│   │   │       ├── saveIndicatorView.ts # Icon + colour per save state for the toolbar indicator
│   │   │       ├── trailingDebounce.ts # Minimal trailing-edge debounce (coalesces `vault:tree-updated` bursts)
│   │   │       ├── ariaAnnouncer.svelte.ts # aria-live announcer with an auto-clear timer disposed on unmount
│   │   │       ├── focusTrapSafe.ts   # safeDeactivateTrap: release a focus trap even when its host is detached
│   │   │       ├── listKeyNav.ts
│   │   │       ├── mediaUrl.ts
│   │   │       ├── mediaErrorText.ts  # A media tile's load error ("File not found" before any format error)
│   │   │       ├── normalizeTagsField.ts
│   │   │       ├── path.ts            # pathsEqualExact (case counts), samePath (case-folded); re-exports the shared path helpers
│   │   │       ├── popupAnchor.ts
│   │   │       ├── portal.ts
│   │   │       ├── sanitizeHtml.ts
│   │   │       ├── tileUpdateFastPath.ts
│   │   │       ├── timerCountdown.ts  # A running timer is its wall-clock end (`endsAt`): it counts while its board is closed
│   │   │       ├── urlSafety.ts
│   │   │       └── navigation.svelte.ts # navigateToTile + highlight state
│   │   │
│   │   └── components/                # Svelte components (UI only)
│   │       ├── shared/                # Shared UI primitives
│   │       │   ├── Modal.svelte
│   │       │   ├── ConfirmDialog.svelte
│   │       │   ├── ContextMenu.svelte # A heading and its items render as a labelled role="group"
│   │       │   ├── Toast.svelte
│   │       │   ├── ColorPicker.svelte
│   │       │   ├── EmojiPicker.svelte
│   │       │   ├── IconButton.svelte
│   │       │   ├── StyleIcon.svelte   # The palette Style icon (STYLE_ICON_PATH) for every Style button
│   │       │   ├── BackgroundImagePicker.svelte # Upload / remove a vault-relative background image, with preview
│   │       │   ├── FiloLogo.svelte    # The Filo brand mark (kept in sync with resources/icon.svg)
│   │       │   └── PinIcon.svelte     # The floating toolbars' pin glyph
│   │       ├── home/                  # Home / vault picker screen
│   │       │   └── HomeScreen.svelte
│   │       ├── layout/                # App shell layout
│   │       │   ├── AppShell.svelte    # Sidebar + workspace + tab bar
│   │       │   ├── GlobalToolbar.svelte
│   │       │   ├── ProjectDropdown.svelte # The toolbar's vault menu: new / open / rename vault
│   │       │   ├── TextFormattingToolbar.svelte # The rich-text formatting toolbar for the active editor
│   │       │   ├── LinkInsertPopup.svelte # Insert Link (toolbar button, Ctrl+K): text + URL applied to the captured range
│   │       │   ├── Dropdown.svelte
│   │       │   ├── TabBar.svelte
│   │       │   ├── Tab.svelte
│   │       │   ├── SplitPaneContainer.svelte
│   │       │   ├── PaneView.svelte
│   │       │   └── PaneDropOverlay.svelte
│   │       ├── sidebar/               # Vault sidebar
│   │       │   ├── VaultSidebar.svelte
│   │       │   ├── VaultSidebarToolbar.svelte # Header buttons: New Folder, Sort By, Group By, Expand / Collapse, Pop-out / Dock
│   │       │   ├── FloatingVaultPanel.svelte # The sidebar as a draggable, resizable in-window panel
│   │       │   ├── VaultFileItem.svelte
│   │       │   ├── FileIcon.svelte    # A tree row's icon by file kind (board type, Markdown, media, folder)
│   │       │   └── FileTagChips.svelte # A row's tag chips; a click filters the tree by that tag
│   │       ├── boards/                # Board-type root components
│   │       │   ├── BoardRouter.svelte
│   │       │   ├── MindMapBoard.svelte
│   │       │   ├── MindMapPopups.svelte # The Mind Map's frame / connection / tile style and tag-editor popups
│   │       │   ├── KanbanBoard.svelte
│   │       │   ├── KanbanColumn.svelte
│   │       │   ├── KanbanCard.svelte
│   │       │   ├── KanbanSideToolbar.svelte
│   │       │   ├── KanbanFindBar.svelte # Filter-in-place text input over the columns
│   │       │   ├── KanbanNewTileModal.svelte # Tile-type picker for a new card (Text / Audio / Link)
│   │       │   ├── KanbanTemplatePicker.svelte # "From Template…": Markdown templates for a new card
│   │       │   ├── TagPromptPopup.svelte # Text input for the Kanban bulk "Add tag"
│   │       │   ├── TaskListBoard.svelte
│   │       │   ├── TaskListSection.svelte # One section: header, row dndzone, quick-add / add-task footer
│   │       │   ├── TaskListRow.svelte # Wraps TaskItem for a row (dnd key, depth, section context)
│   │       │   ├── taskListRowProps.ts # Prop bundles for TaskListRow / TaskListSection
│   │       │   ├── TaskItem.svelte
│   │       │   ├── TaskDatePicker.svelte # Floating date (and optional time) picker
│   │       │   ├── TaskBulkActionBar.svelte # Bulk verbs for the selected tasks
│   │       │   ├── TaskListToc.svelte # Table of Contents body: section jump links, active header highlight
│   │       │   ├── FloatingTocPanel.svelte # The Task List's draggable, resizable Table of Contents panel
│   │       │   ├── ElementStylePopup.svelte # Style popup for a Kanban card / column, task or section
│   │       │   ├── TaskListSideToolbar.svelte
│   │       │   ├── SmartListTabs.svelte # Task List smart-list filter tabs
│   │       │   ├── TaskQuickAddInput.svelte # Task List quick-add (natural-language) input
│   │       │   ├── DocumentEditor.svelte # A note in a Document tab: tag row, editor, Raw toggle
│   │       │   ├── NoteRawView.svelte # Raw view: the whole file (frontmatter included) in a textarea
│   │       │   └── SideToolbar.svelte # Mind-map side toolbar (move/new/etc.)
│   │       ├── canvas/                # Canvas rendering layer
│   │       │   ├── BoardBackground.svelte
│   │       │   ├── Minimap.svelte
│   │       │   ├── SmartGuides.svelte
│   │       │   └── WaypointMarker.svelte
│   │       ├── connections/           # Connection UI
│   │       │   ├── ConnectionLayer.svelte
│   │       │   ├── ConnectionPath.svelte
│   │       │   ├── ConnectionLabel.svelte
│   │       │   ├── ConnectionStylePopup.svelte
│   │       │   └── ConnectionBubbles.svelte
│   │       ├── frames/
│   │       │   ├── Frame.svelte
│   │       │   └── FrameStylePopup.svelte
│   │       ├── tiles/                 # Tile components
│   │       │   ├── TileContainer.svelte
│   │       │   ├── TileHeader.svelte  # Title, tags, lock, style, delete
│   │       │   ├── TileStylePopup.svelte
│   │       │   ├── TextTile.svelte
│   │       │   ├── ImageTile.svelte
│   │       │   ├── VideoTile.svelte
│   │       │   ├── AudioTile.svelte
│   │       │   ├── FileTile.svelte
│   │       │   ├── LinkTile.svelte
│   │       │   ├── IframeTile.svelte
│   │       │   └── TimerTile.svelte
│   │       ├── settings/              # Settings panels
│   │       │   ├── GeneralSettings.svelte
│   │       │   ├── CurrentBoardSettings.svelte
│   │       │   ├── CurrentBoardMindMap.svelte, CurrentBoardKanban.svelte, CurrentBoardTaskList.svelte, CurrentBoardDocument.svelte # Per-type Current Board fields (via pendingSettingsStore)
│   │       │   ├── BoardDefaults.svelte
│   │       │   ├── LivePreview.svelte
│   │       │   ├── SettingsActionBar.svelte # A tab's Apply / Revert bar, above its scrolling page
│   │       │   ├── ThemeManager.svelte # Settings → Themes: pick, New / Import, Edit / Duplicate / Delete
│   │       │   ├── ThemeEditor.svelte # Grouped colour pickers with a live preview; Save / Save as new / Cancel
│   │       │   ├── TrashSettings.svelte # Settings → Trash: Restore / Empty trash
│   │       │   ├── VaultSidebarSettings.svelte # General → Vault Sidebar: name, colour, sort / group, extensions, Root Directory
│   │       │   └── KeyboardShortcuts.svelte
│   │       ├── modals/                # Other modal dialogs
│   │       │   ├── ProjectSettings.svelte  # Tabbed wrapper around settings/
│   │       │   ├── BoardBrowser.svelte
│   │       │   ├── TemplateBrowser.svelte
│   │       │   ├── SaveTemplateModal.svelte
│   │       │   ├── OrphanCatcher.svelte
│   │       │   ├── RelinkTileModal.svelte # Re-link a broken tile to a vault file (undoable)
│   │       │   └── RecoveryFiles.svelte
│   │       ├── search/                # Search, Find and Replace
│   │       │   ├── SearchPanel.svelte # The floating find / replace panel (Ctrl+Shift+F)
│   │       │   └── SearchFindAllPopup.svelte
│   │       └── tags/                  # Tag UI
│   │           ├── NoteTagRow.svelte  # Tag row at the top of a note in a Document tab
│   │           ├── TagBadge.svelte
│   │           ├── TagEditor.svelte
│   │           ├── TagsBrowser.svelte
│   │           └── TagsPopupMenu.svelte
│   │
│   ├── css/                           # Global stylesheets
│   │   ├── style.css                  # App-wide base styles + CSS variables
│   │   └── conn.css                   # Connection-specific styles
│   │
│   ├── shared/                        # Shared between main + renderer
│   │   ├── types.ts                   # IpcChannel union, file-tree types
│   │   ├── vaultPath.ts               # VaultPath: the case-folded key every path-keyed map uses; isAtOrUnder (the item or inside it)
│   │   ├── sentinelPaths.ts           # Per-machine sentinel names (`.filo/.dirty.<machineId>` …)
│   │   ├── fileNames.ts               # fileStemFromTitle, fileNameProblem (shared filename rules)
│   │   ├── conflictCopy.ts            # The one sync-client conflict-copy detector
│   │   ├── vaultColor.ts              # safeVaultColor: only #rgb / #rrggbb (app.json, recent-vaults.json, inline styles)
│   │   ├── pathUtils.ts               # toPosix / stripLeadingSlash / normalizePath / toVaultRelative (main + renderer)
│   │   ├── fontStack.ts               # A picked font's CSS stack, and the family the pickers show
│   │   ├── generalSettingsDefaults.ts # The General settings defaults (schema + a new vault's app.json)
│   │   ├── systemLocale.ts            # OS regional-format locale, passed to the preload as a process argument
│   │   ├── ipcSchemas.ts              # Per-channel Zod payload validation
│   │   ├── ipcContracts.ts            # Per-channel arg/result TYPE contracts (ChannelResult<C>, etc.)
│   │   ├── untrusted.ts               # Branded `Untrusted<T>` + asSafe* validators (untrusted-sink discipline); iframeSrcProblem is the one iframe URL rule
│   │   └── ipcEnvelope.ts             # IPC ok/error envelope + IpcEnvelopeError
│   │
│   └── tests/
│       ├── unit/                      # Vitest unit tests (flat; contracts/ holds whole-codebase contract checks)
│       ├── component/                 # Vitest: real components mounted in jsdom
│       ├── characterisation/          # Vitest: whole App against a real temp vault + real IPC handlers
│       ├── e2e/                       # Playwright E2E tests
│       ├── helpers/                   # Shared test helpers (memory vault, window.filo bridge, machine id, fake command, editor loop breaker)
│       │   └── seedBoard.ts           # Seeds the board cache from runtime tiles, then calls setBoard
│       └── types/
│           └── js-yaml.d.ts           # Test-only js-yaml declaration (js-yaml is a test oracle, banned from the app)
│
└── scripts/                           # Build / dev scripts (electron-vite launcher)
```

### Structure Rules

1. **One concern per file.** Aim for new files under ~300 lines, and split a file when a second concern moves in (many existing files are longer; size alone isn't a reason to split one). The hard limit is the 1000-line gate. The files over it (TaskListBoard, TaskItem, KanbanBoard, KanbanColumn, KanbanSideToolbar, vault.svelte.ts) are allowlisted at their current size and may only shrink; new code should not exceed the threshold.
2. **`lib/` holds non-UI logic.** It may use DOM globals and import from `stores/`, but must NOT contain Svelte component definitions (`.svelte` files) or import from `components/`. Must be testable with Vitest + jsdom alone.
3. **`components/` is UI only.** Components read from stores and call into `lib/`. Minimal logic in `<script>` blocks.
4. **`stores/` bridges the two.** Stores import from `lib/` for heavy logic and expose reactive state to components.
5. **`schema/` holds Zod schemas + their inferred TypeScript types.** Components and lib modules both import from here (named `schema/`, not `types/`). Never define shared types inline.
6. **Electron IPC is a hard boundary.** The renderer NEVER imports Node.js modules directly. All file system access goes through the preload bridge → IPC → main process.
7. **Canvas gestures use custom pointer-event handlers.** Pan, zoom, drag, resize, edge-pan all live in `lib/canvas/` as direct pointer-event listeners. `@use-gesture/vanilla` was previously listed as a dep but is no longer installed.

---

## Coding Conventions

### TypeScript

- Strict mode enabled. No `any` unless absolutely unavoidable (document why in a comment).
- Use `interface` for object shapes, `type` for unions/intersections.
- All function parameters and return types must be explicitly typed.
- Prefer `const` over `let`. Never use `var`.
- Use `createId()` from `lib/utils/ids.ts` (a `nanoid` wrapper with a 12-character default length) for all ID generation. Most IDs are unprefixed; a few call sites prepend a semantic prefix (e.g. `sec_${createId()}`).

### Svelte 5

- Use runes exclusively: `$state`, `$derived`, `$effect`, `SvelteSet`.
- No legacy `$:` reactive statements, no `writable()`/`readable()` stores.
- Store files use `.svelte.ts` extension to enable rune syntax.
- Component files use `.svelte` extension.
- Props use `$props()` destructuring with type annotation.
- Prefer `$derived` over `$effect` for computed values.

### CSS

- **Vanilla CSS only.** No Tailwind, no SCSS, no CSS-in-JS.
- Theme-dynamic values use CSS custom properties defined in `style.css` and overridden per theme.
- Component-scoped styles go in `<style>` blocks within Svelte components.
- Global styles go ONLY in `/css/style.css` and `/css/conn.css`.
- Inline styles are ONLY for runtime-dynamic values (tile positions, user-chosen colours).
- All animations use `transform` and `opacity` only (GPU-accelerated). Never animate `width`, `height`, `top`, `left`, `margin`, `padding`.
- Always respect `prefers-reduced-motion: reduce`.

### Naming

- Files: `camelCase.ts` for modules, `PascalCase.svelte` for components, `camelCase.svelte.ts` for stores.
- CSS variables: `--ui-{category}-{property}` (e.g., `--ui-surface`, `--ui-border`, `--ui-text-primary`).
- IPC channels: `vault:read`, `vault:write`, `dialog:open`, `window:minimize` (namespace:action).
- Store exports: named exports, not default. e.g., `export const boardStore = ...`.
- Command names: `verb:noun` format (e.g., `tile:add`, `connection:delete`, `tile:toggle-lock`).

### Icons

- **All icons must be SVG.** No emojis as icons, ever.
- Most SVG icons are inline `<svg>` markup in the component that uses them. An icon that stands for the same action in several places is shared, so it always looks the same: its single-path `d` string lives in `src/renderer/constants/` (`icons.ts`: `STYLE_ICON_PATH`; `boardIcons.ts`: board types), which a context-menu item's `icon` can carry, and a button renders it through a small component (`components/shared/StyleIcon.svelte`). Every Style button and menu entry uses the palette Style icon; the gear is for Settings only.
- Use lucide-style icons for consistency. If adding custom icons, match the 24×24 viewBox, 2px stroke convention.
- **Exception — waypoint icons.** Mind Map waypoint icons are user-selectable content (a label the user picks for their own waypoint), not UI chrome, so they remain emoji. See `src/renderer/components/canvas/WaypointMarker.svelte`. Do not flag these in icon audits.

---

## Architecture Rules

### Data Flow

```
User action → Store mutation → Reactive UI update
                ↓
        Debounced write (300ms) → IPC → Main process → File system
```

```
External file change → fs.watch (main) → IPC → Store update → Reactive UI update
```

### Source of Truth Hierarchy

1. **File system** is the ultimate source of truth.
2. **The `.md` file is the only copy of a note's title, tags, fields and body.** The title is frontmatter `title:`, or the filename stem when there is no `title:`. Tags are frontmatter `tags:`. Task and card fields (`completed`, due date, priority, status, recurrence…) are frontmatter keys, and so is the note's Line Spacing (`lineSpacing:`).
3. **Board JSON holds visuals only.** A note-backed tile def stores its `filePath` (vault-relative) plus position, size, style, lock/fade, column or section and order, and optional `titleHtml` (formatting, shown only while its text matches the note's title). It never stores a note's title, tags or body, so there is nothing to keep in sync (gate `board-schema-no-note-copies`). Board-only tiles (link, iframe, timer) keep their own `title` and `tags`, because they have no file.
4. **Media and other non-Markdown files** keep their tags in `.filo/tags.json:fileTags[path]`, their only copy.
5. **In-memory stores** reflect the file system state. They are caches, not sources. One note open in several views is one `NoteModel` in `noteStore`; closed notes are read from the vault index.

### Persistence Boundary

All project state lives **inside the vault** — either a `.board.json`, a vault file (Markdown/media), or a `.filo/` config file. There is no `electron-store`, no `localStorage`, no `sessionStorage`, no `IndexedDB`. If you add a new piece of persisted state, route it through the vault.

The only state that lives in Electron `userData` (i.e. outside any vault) is the small carve-out of per-machine UI geometry and the launch bootstrap:

| File | Why it's outside the vault |
| --- | --- |
| `recent-vaults.json` | Must be readable before any vault is open. |
| `window-state.json` | Window size/position is per-display, not per-vault. |
| `sidebar-state.json` | Sidebar width and floating bounds are per-display; shown / hidden (Hide Vault) goes with them. |
| `machine-id.json` | Identifies this machine so crash sentinels in the synced vault (`.filo/.dirty.<machineId>` …) never cross machines. |

Anything else — including overlay positions (Kanban side toolbar etc.), open tabs, viewports, themes, defaults — goes in `.filo/`.

**Close, open-another-vault and quit never drop unsaved work silently.** `closeVault` / `openVault` call `saveBeforeLeaving` (`stores/vaultLeaveGuard.ts`). It takes focus off a text field (`releaseFocusedField`, so a field that saves on blur hands its text over), freezes the editors (`closeDrainGate`, held until the swap has unmounted them), saves, waits for the watcher reconciles already queued (`settleRenameQueue`), and saves once more if anything was handed over meanwhile (`saveUntilSettled`). The window-close quit runs the same save with the editors frozen and makes the same `unsavedWork()` check before it quits. `save()` first runs every **component flush** (`lib/boards/componentFlush.ts`): a title typed but not committed, a Kanban / Task List filter or a camera move inside its debounce, a running timer. Views unmount later, in the swap, where their teardown saves would be cancelled. It goes ahead with no dialog when `unsavedWork()` (`lib/boards/writeStateTracking.ts`: pending, failed, in-flight, plus note bodies from the note store's registered source, keys an editor hasn't serialised yet, and text in an open raw view, `lib/notes/rawViews.ts`) is then empty. From that point the outgoing vault's generation is retired (`retireVaultGeneration`), so suspended work reads as stale and queued reconciles are skipped. As a last line, anything still unsaved when the vault is let go as saved (a note, or a board / `.filo/` write the swap would cancel) is copied to `.filo/recovery/` and the sentinel stays set (the `leftBehind` pre-swap handler), never reset away. `noteStore.flushAll` saves raw views first, since quit never unmounts them. Otherwise it asks *"N changes couldn't be saved"*, naming each file and its cause, with **Close anyway** / **Open anyway** and **Cancel** (the default). There is no "Don't Save". Leaving anyway, and the quit dialog's **Quit anyway**, first write **rescue copies** (`stores/unsavedRescue.ts` → IPC `recovery:keep-unsaved`) to `.filo/recovery/<timestamp>-unsaved/<flattened path>`: each unsaved note as its last frontmatter plus the local body, each raw view's text as typed, each unsaved board as JSON, and Filo's own unsaved `.filo/` state (tags, settings, layout…) as `_filo__<name>.json`. The notice naming the folder outlives the vault switch and offers **Show in folder**. The `-unsaved` suffix makes the snapshot prunes skip these folders, so only the user deletes them (KNOWN_LIMITATIONS #33). A copy that can't be written triggers a second confirm ("… and lose them"); cancelling it lets every raw view save its text again. Leaving anyway keeps `.filo/.dirty.<machineId>`, naming each file as it is spelled on disk, so reopening the vault offers recovery. All the wording lives in `lib/vault/unsavedMessages.ts`. Gate `close-keeps-rescue-copy`.

**Tag persistence — note for attachments.** A note's tags live only in its YAML frontmatter (`tags: [...]`). Attachment tags (image / video / audio / generic file) have nowhere to write into the file itself, so they live only in `.filo/tags.json:fileTags[mediaPath]`. The trade-off: tags on attachments are **vault-local** — copying or moving an attachment outside the vault without `.filo/` will lose its tags, whereas text-tile tags travel with the `.md` file. This is a deliberate consequence of the open-format principle (no sidecar files next to media). Don't add a sidecar without a separate design discussion.

### The Vault API Contract

There is no single `vaultApi.ts` module. The "Vault API" is a contract split
across a few owners, all of which call IPC to the main process — the renderer
NEVER touches `fs` directly (Electron context isolation; see "Persistence
Boundary").

- **Reads and board / config writes** go through the `window.filo` preload
  bridge (`src/main/preload.ts` → `src/main/ipc/*`). The renderer calls
  `window.filo.invoke(channel, ...args)` (or the envelope-checking `invokeOk`
  in `lib/utils/invokeOk.ts`), never `require('fs')`.
- **`.md` notes are written only by the note writer** (`lib/notes/noteWriter.ts`),
  reached through `noteStore` (`stores/notes.svelte.ts`): `setBody`,
  `patchFrontmatter`, `transform`, `writeRaw`, `createUnique`/`createExclusive`.
  There is one queue per note path. Each flush reads the file fresh inside that
  queue and applies the change to what it read, so nothing is written from a
  stale copy. Gate `single-note-writer` forbids any other module from invoking
  the `.md` write or create channels. Main backs this up: the blind
  `vault:write-file-text` writes only this machine's crash-recovery sentinels
  (`assertSentinelWriteTarget`) and refuses every other path with `FORBIDDEN`.
- **Disk-shape mutations** (rename / trash / restore / create-folder /
  copy-file) go through `lib/vault/vaultOperations.ts`. `withDrainedWrites(op)`
  first drains every writer pipeline, then runs the op. Such ops run one at a
  time: `op` receives a `DrainToken`, and a call made from inside it passes
  the token on (`{ within: token }`, or the helpers' last argument) to run under
  the same drain. Any other call waits for the running op, then drains for
  itself. A nested call without the token would wait for its own op (a dev
  watchdog warns after 30 s), so an op must never await the history chain
  (an undo's restore may be queued behind it). `renameVaultPath`,
  `trashVaultPath` and `restoreTrashed` also hold the affected notes' write
  queues (`noteStore.hold`) so no write can land on the old path mid-move.
  Gate `no-raw-disk-shape-ipc` forbids raw renderer invokes of these channels
  outside this module.
- **The drain is scoped.** `withDrainedWrites(op, { paths })` always flushes
  everything, but a failed write refuses the op only if its path equals one of
  `paths` or sits under or over one (case-folded). Other failures keep their
  error toast and the op goes ahead: a pending write can only disturb a
  disk-shape op on the same path or a parent/child. Each caller passes the
  paths it touches (rename: old and new; trash / restore: the item; new folder
  and copy: the target; external rename: old and new). With no `paths`, the
  global rule applies: any failure refuses (the vault-wide tag sweep drains
  this way). Close, open-another-vault and quit don't drain-and-refuse: they
  save, then ask if anything at all is left (see "Persistence Boundary").
- **A note write that fails because the file is gone** raises one sticky
  toast with **Save as new file** (`noteStore.recreate`, exclusive create; only
  when the queued change has a body) and **Discard change**
  (`noteStore.discardQueued`), so a failed mark never lingers for the session.
  Both it and the "deleted by another program" prompt wait
  `NOTE_RENAME_GRACE_MS` (3 s) first and ask nothing if a rename re-points the
  note meanwhile (`askUnlessMoved`).
- **External renames re-key before draining.** `handleExternalRename`
  (`stores/vaultExternalChanges.ts`) calls `renameAllPathKeys` first, since the
  file has already moved, so a pending body lands on the new path.
- **Deletes go to Filo's trash.** Every user-facing delete (sidebar file or
  folder, board, "delete tile and file", "delete task and file") calls
  `trashVaultPath`, which moves the item to
  `.filo/trash/<trashId>/files/<originalPath>` next to a `manifest.json`. Undo
  and Settings → Trash call `restoreTrashed`, a rename back (or beside the
  original as `… (restored)` if the name is taken again). Emptying the trash
  and the 30-day purge send items to the OS Recycle Bin; only if that refuses
  does a confirm ask "Delete permanently?" (gate `deletes-go-to-trash`).
- **On file rename:** `lib/vault/fileRefIntegrity.ts` rewrites every
  `.board.json` path field that pointed at the old path. Titles and tags are
  never touched, because boards don't hold them. The in-app rename/move entry
  point is `stores/vaultFolderOps.ts`; the sidebar delete is
  `stores/vaultDeleteOps.ts`.
- **On file delete (from vault):** the cascade removes every tile placement
  referencing that file from each `.board.json`; undo puts them back.
- **Broken file references** are detected on board load and tracked via
  `stores/boardRefIntegrity.svelte.ts` — flagged, not silently ignored.

### Debouncing

- Content edits (tile text, frontmatter): the editor serialises its Markdown into the note model after 150ms idle (at once on blur, unmount, save and quit), then the note writer waits a 300ms idle debounce before the disk write. Within that window the latest body wins and frontmatter deltas merge.
- Layout changes (tile move/resize, connections): 300ms idle debounce.
- Config changes (`.filo/` files): write on panel close or confirmation.
- File watcher events: 300ms debounce to batch rapid changes.

### Registry Pattern

Three registries power extensibility:

- **TileRegistry** — Maps `TileType` string to its display metadata + creation defaults (`getTileDefaults`). Adding a new tile type means registering its defaults here. Tile *bodies* are rendered by the boards via Svelte snippets, not through the registry (eager `*.svelte` imports there would pull TipTap into the Home-screen preload).
- **BoardRegistry** — Maps `BoardType` string to board component + toolbar component + schema.
- **CommandRegistry** — Binds keyboard shortcuts via `registerCommandWithShortcut` using a verb:noun naming scheme. There is no command palette yet; when one lands, add `registerCommand` / `unregisterCommand` backed by a `Map<name, handler>` populated alongside the shortcut.

When adding a new tile type or board type: register it, implement the interface, done. Never scatter type checks across the codebase.

### Undo/Redo

- Uses command pattern. Every undoable action implements `{ execute(): void; undo(): void }`.
- Each board has its own independent undo/redo stack. A Document tab has its own stack too, keyed by the tab's id (PaneView makes it the active history board); `boardCacheStore.markDirty` ignores such ids, since no board file carries them.
- **Board undo covers layout plus inverse frontmatter deltas.** A command that changes a note (title, tags, task/card fields) records a forward and an inverse `FrontmatterDelta`. Undo sends the inverse through `noteStore.patchFrontmatter`, so it lands on a fresh read of the file and keeps unrelated edits made in between. If another program changed the same key since (checked against a fresh read of the file, never the open note's model, which lags the watcher debounce), undo keeps that value and offers "Apply anyway" on a toast (`applyDeltaChecked`), because a blind inverse would overwrite the newer value. "Apply anyway" writes the note wherever a rename has moved it meanwhile.
- **Commands follow renames.** Every command on every stack (Document-tab stacks included) is re-pointed when a file or folder is renamed, in-app or by another program: `stores/history.svelte.ts` registers a `'history'` rename sweep that calls `Command.renamePath(old, new)`. The default (`rebaseCommandFields` in `commands/commandPaths.ts`) rewrites every string held under a name in `PATH_FIELDS`, including snapshots, arrays and child commands; it never walks the user's own data (`CONTENT_FIELDS`: frontmatter, deltas, splices), and paths under a trashed item stay pinned, because restore puts the item back at its original path first. A new path-like field name must go in `PATH_FIELDS` (gate `commands-follow-renames`). Only `RenameFileCommand` overrides `renamePath`.
- **A board reload drops every step that touches it.** When a board is read again from disk (`reloadBoardFromDisk`), `historyStore.clearBoard(id, { changedOnDisk: true })` drops, from every stack and from the off-stack cascades a toast still offers (`holdOffStack` / `undoOffStack`), each command whose `touchedBoardIds()` holds it: by default its `targetBoardId`; `CascadeDeleteCommand`, `BatchCommand` and `DeleteTilesCommand` add every board they hold a snapshot of (gate `cascade-touched-boards`). Closing or deleting a board drops only the steps that target it. A redo whose file can't go to Filo's trash throws `ChangeRefusedError`, so it stays a redo; placement re-adds (`persistAddKanbanPlacement`, `persistAddTaskPlacement`) are no-ops for a tile already placed.
- **Task List steps record the move, not the arrays.** `MoveTaskBlockCommand` keeps the ids that moved and every task's section and order before and after (`lib/tasklist/sectionMembership.ts`); undo and redo put only those tasks beside their neighbours on the live board and recompute section starts. `AddTaskCommand` / `DeleteTaskCommand` recompute starts from each task's section too, so a task added or removed meanwhile by anything else is neither undone nor pushed into another section.
- **A queued execute runs on its own board.** An execute body waiting behind a running command switches back to the board it was made on first (as a queued undo or redo does), and is rolled back with a toast if that board was closed.
- **Undo on a note that's gone doesn't queue a write.** `applyDeltaChecked` throws `NoteGoneError` when the file no longer exists; the history store puts the command back where it was and shows *Couldn't undo: "Card.md" no longer exists.* with **Skip this step** (drops it so earlier steps can still be undone).
- **A change a note can't take leaves no undo step.** A tag add or remove on a note whose frontmatter the rewriter won't touch (malformed YAML, an anchored `tags:`), that isn't UTF-8, is a link, or has an unsaved edit rejects with `ChangeRefusedError` (`commands/changeRefusedError.ts`); the history store shows its message and takes the step off the stack (or, for undo / redo, leaves it where it was).
- **No command keeps a note body.** Delete undo is a restore from `.filo/trash` (a rename back); Replace All keeps only the replaced snippets and before/after hashes, and applies only while the file's bytes match. Gate `no-note-body-in-commands`.
- Text editing undo is handled by TipTap/ProseMirror internally (separate from board undo). Board-level Ctrl+Z fires when no TipTap editor is focused.
- **Vault-wide tag delete and rename are undone from their toast** (`stores/tagUndo.svelte.ts`, 15 s), not from board history, because they touch many files and belong to no board. A merge (rename into an existing tag) has no undo. A board delete, and a sidebar delete that no open board's stack can hold, also offer Undo on their "moved to Filo's trash" toast.

### Override Cascade (Styles)

```
Per-element style (Tile Style popup) > Current Board Settings (.board.json) > Global Defaults (.filo/defaults.json)
```

A board follows the Global Defaults, live, for every style field it leaves blank (a new board has no style of its own); a field set in its Current Board tab is its own. The Kanban, Task List and Document background and accent fall back the same way. A blank colour anywhere means the theme's colour.

Font sizes have one more layer, under the Global Defaults: General → Default Board Font Size (`.filo/app.json`, `generalFontSize` in `effectiveStyle.ts`). Element factories never copy a size into a new element, so a new tile, card, task, section, column, frame or connection label follows the cascade, and a later change of any default reaches it.

Themes are colours only (`lib/themes/themeTokens.ts`): the user's font, sizes, UI scales and toolbar / tab bar colour are settings and a theme never carries them. A theme may set only the theme tokens; any other variable in a theme file is dropped on import, on read from disk and on paint. Text on the accent is `--text-inverse`, 4.5:1 or better in every built-in. A blank toolbar / tab bar colour setting leaves the bar to the theme. The built-in palettes live only in `style.css` (`[data-theme='…']`); custom themes are `.filo/themes/<id>.json`, and `appearance.json` names the active one, built-in or custom. Picking a theme clears the Global Defaults colours so the theme shows, after asking when the user set any. Deleting a custom theme moves it to Filo's trash (the one `.filo/` path a trash manifest may name).

---

## Key Design Decisions — Do Not Deviate

1. **Local-first. No network calls.** No telemetry, analytics, or remote APIs. Everything works offline.
2. **Open format.** Text is Markdown. Boards are JSON. Media files are stored as-is. A user must be able to read their data with any text editor.
3. **File-backed tiles.** Text, Image, Video, Audio, and File tiles point to real files in the vault. Link, Iframe, and Timer tiles store data inline in board JSON.
4. **One `.md` file = one document.** A Text Tile and a Document Board are two views of the same `.md` file. Edits in either view reflect immediately in the other.
5. **Same file on multiple boards.** Board JSON stores placement (position, size, style). Content comes from the shared vault file.
6. **Frontmatter is canonical.** A note's title, tags and fields live only in its frontmatter; board JSON never copies them.
7. **No external state management libraries.** Svelte 5 runes only.
8. **Vanilla CSS only.** CSS custom properties for theming. No Tailwind, no preprocessors.
9. **SVG icons only.** No emojis as icons.

---

## Common Gotchas

- **tiptap-markdown** — This handles Markdown ↔ ProseMirror round-tripping. The unified/remark pipeline is for VaultIndex metadata extraction, NOT for the editor.
- **svelte-dnd-action** — This is for Kanban column/tile reordering and Task List reordering. Canvas tile dragging is custom (raw pointer-event handlers + manual transform).
- **`$effect` vs `$derived`** — Use `$derived` for computed values. Use `$effect` only for side effects (IPC calls, DOM manipulation, subscriptions). Overuse of `$effect` is a code smell.
- **Store file extension** — Must be `.svelte.ts` for runes to work. Plain `.ts` files cannot use `$state`.
- **Electron context isolation** — `contextBridge` exposes a small API object as `window.filo` (`invoke`, `on`, `send`, `getPathForFile`, `systemLocale`). The renderer calls `window.filo.invoke('vault:read-file-text', vaultRoot, relPath)`, NOT `require('fs')`. The preload validates every payload against `ipcSchemas.ts` before it reaches main.
- **Board JSON `filePath` field** — Vault-relative paths, not absolute. e.g., `"Notes.md"` or `"subfolder/Notes.md"`. The path is a note's only identity (no `contentId` / `docId`); path-keyed maps use the case-folded `VaultPath` and follow renames.
- **A note that is a symbolic link is read-only.** `vault:read-file-text` reports `link: true` (lstat), the views freeze with *"This note is a link; edit the original."*, and main refuses a write to it (`NOTE_IS_LINK`, `atomicWriteFile({ refuseLink })`), since an atomic rename would replace the link with a plain file. Hard links aren't detected (KNOWN_LIMITATIONS #34).
- **Titles are not filenames.** A title edit writes frontmatter `title:` and never renames the file. The filename is derived from the title once, at creation (illegal characters become `-`, ` (n)` on collision). The sidebar shows filenames; its context menu offers "Rename file to match title".
- **A board's name is its file name.** `Plan.board.json` is the board "Plan"; `board.name` in the JSON is a copy, and on load the stem wins. Renaming the board renames the file (and, with board-specific folders on, its folder while that folder still has the board's name); renaming the file renames the board. A name the file system can't take, or another board's name in the same folder, is refused inline, never bumped to ` (2)` (`board:create` is an exclusive create). With `general.boardFolders` on, a new board gets its own folder and `settings.defaultFolder` pins it; `getActiveContentFolder` then uses only the board pin, and with it off only the vault-wide Root Directory.
- **Only v8 board files load.** The loader accepts exactly `version: 8`. An older or newer board is listed as failed and never written.
- **Frontmatter writes are source-preserving.** `assembleNoteText` (`lib/notes/noteFile.ts`) hands the fresh frontmatter source to `assembleMarkdownFile` (`lib/editor/markdownSync.ts`), which patches it with `patchFrontmatterSourceCst` (`lib/vault/frontmatterCstModel.ts`), a CST engine on the `yaml` package. It rewrites only the keys whose value changed and emits every untouched key byte-for-byte from the on-disk source: comments, key order, quoting, and exotic scalars (`02134`, `0xFF00FF`, `1_000`) all survive. A full re-dump (`new Document(fm).toString()`) happens only for a new file, a block that isn't a block mapping, or a changed/deleted key carrying an anchor/alias or tag, and for an existing block only when every untouched key comes out saying what it said (`dumpPreservesUntouched`): a dump that would turn `02134` into `2134` or drop a `!tag` is refused (`lossy`) and the block kept. Remaining narrow losses: KNOWN_LIMITATIONS #1.
  - **One parser.** Reads (`readNoteText`, the vault index via `lib/vault/frontmatterRead.ts`), the tag rewriter and the engine's value-compare all use the `yaml` package. js-yaml and gray-matter are banned from the app (gate `no-jsyaml`; a second parser coerces unquoted dates / `0b1010` / `<<` merges differently). Tests keep js-yaml only as an independent oracle.
  - **Line endings and BOM.** The engine works in LF, so line endings are re-applied from the fresh read at each flush (`lib/utils/lineEnding.ts`, shared with the tag rewriter). A frontmatter-only change rewrites the block in the ending its fence already has and keeps the body byte-exact, even in a file with mixed endings; a body write gives the body the file's ending by majority. The BOM is kept. Without it, a CRLF note flips to LF on its first metadata edit.
  - **Every write is a change applied to a fresh read.** Each note-writer flush reads the file inside the path's queue, then applies the queued change: a `FrontmatterDelta` (`lib/vault/frontmatterDelta.ts`) patches the fresh frontmatter, and a body replaces the fresh body. A batch without a body keeps the body on disk. So keys or text added by another program are never dropped, and no write is assembled from a cached whole file.
  - **Body drift is a conflict, frontmatter drift is not.** If the batch carries a body and the body on disk no longer matches the one the edit was built on (`NoteModel.base`; with no base, any other body on disk), the writer holds the body and the note store shows one prompt: **Reload** or **Keep mine** (which first backs the other version up to `.filo/recovery/`). A change on disk that only touched frontmatter is taken silently and the local body is kept (`lib/notes/noteDiskChange.ts`). Keys an editor typed into a body the model has since replaced (the disk changed during the read, a reload, a rewrite) are held the same way (`noteStore.setBodyBuiltOn`), never written over the change. A rewrite (`transform`: Replace All, tag sweeps, the raw view) throws `NoteBusyError` while an edit of the note can't be saved, and a rewrite never moves the base on under an unsaved body.
  - **Own-write echoes are recognised by content hash.** The writer remembers the hash of its latest write to each note, and a disk change whose bytes match it (or the model's base) is ignored. An older version of ours put back by another program (a restore, a sync) is a real change.
  - **The write names the read it builds on.** The writer skips the write when the assembled bytes equal what is on disk; otherwise it passes the fresh read's `{ mtimeMs, size, hash }` to `vault:write-existing-file-text`, and `atomicWriteFile` re-checks it before every rename attempt (the bytes too, for a file up to 2 MB, since a coarse FAT / SMB timestamp can hide a same-size save; KNOWN_LIMITATIONS #36) (a Windows lock backoff lasts seconds). A changed file fails with code `STALE` and the writer starts over from a new read; a body that keeps meeting a newer version becomes the conflict prompt. A read with no coherent stat is never written over, and a read that looks cut short (empty though the note had text, or recent and under half its size) is read again first. Gate `note-write-expects-stat`.
- **Drift baselines only move forward.** Board and `.filo/` files are checked for drift against a stat baseline (`lib/vault/fileBaselineRegistry.ts`). A reader takes `const seq = baselineSeq(path)` before its read and stamps with `noteBaseline(path, mtime, size, { ifUnchangedSince: seq })`; if one of Filo's own writes refreshed the baseline meanwhile, the reader's older stat is dropped instead of rolling it back (which made the next save see its own previous write as external). The sequence is one counter that never resets, and a vault swap also takes a new floor from it for every path not yet written, so a ticket from before a swap or rename can't match by accident. Production calls must pass `ifUnchangedSince` (gate `baseline-stamp-forward-only`). A new board is seeded at create: `board:create` suppresses its own echo and returns the stat, and `persistNewBoard` marks a self-write and stamps it. `loadBoard` never stamps: it returns the stat (`result.baseline`) and the caller stamps it with `adoptLoadedBoardBaseline` only after putting the data in the cache (open, `ensureAllLoaded`, `adoptBoardAtRuntime`, a reload). A reload that fails (a newer format, a schema error) or is set aside because an edit landed during the read keeps the old baseline, so the next save still finds the outside version and asks (gate `board-baseline-after-adopt`).
- **A drift is decided once, and never blocks a file for the session.** A board changed outside Filo while it has unsaved changes gets one prompt per path, whether the watcher or the writer notices first (`stores/boardDrift.ts`): **Reload** reads the disk version into the cache, cancels the queued write and clears that board's undo history (its steps hold snapshots of the version replaced; a silent reload does the same); **Keep local** copies the other version to `.filo/recovery/<ts>-keep/` and moves the baseline to it. A `.filo/` config (`lib/boards/configDrift.ts`): Filo's own bytes with a new stamp rebase silently; `workspace.json` keeps Filo's layout after a copy; `app.json` / `defaults.json` / `appearance.json` ask Reload / Keep local; a deleted config is created again with `config:save … { createOnly }`, so a copy put back meanwhile is never overwritten.
- **A note write hides only its own watcher echo.** Note-write IPC handlers call `FileWatcher.suppressWrite(path, ms, content)` (drops an event only while the file still exists, since an atomic write never leaves it missing, and only while it holds the bytes Filo wrote, so another program's save inside the window is still reported; once a later write has landed, an earlier one's bytes no longer count, so a restore of an older version is reported too) and `noteOwnWrite` / `recordOwnWrite` (refreshes the watcher's cached size and SHA-1, so a rename right after pairs). A missing `.md` with no partner is held `MISSING_NOTE_HOLD_MS` (1.5 s) for a late create. Overwrites go through `withOnDiskSpelling`, so Filo never undoes another program's case-only rename. Board, media and config writes keep the plain `suppress`. Gate `note-write-suppression`; limits in KNOWN_LIMITATIONS #31.
- **Aligned or indented blocks are HTML in the file.** A paragraph or heading with a non-left alignment or an indent is saved as one HTML line (`lib/editor/blockLayout.ts`); everything else stays Markdown. Line Spacing is per note, frontmatter `lineSpacing:` (`SetLineSpacingCommand`, read by `noteLineSpacing`). Every toolbar command needs a save → reload case in `toolbarFormattingRoundTrip.test.ts` (gate `toolbar-formatting-saved`).

---

## Testing Strategy

- **Unit tests (Vitest):** Cover all `lib/` modules. Stores should have unit tests for their logic. Target: every function in `lib/` has at least one test.
- **Component tests (jsdom + Vitest):** `vitest.config.mts` has three projects: `unit` (`src/tests/unit/`), `component` (`src/tests/component/`, resolved with the `browser` export condition so Svelte 5 client `mount()` works) and `characterisation` (below). Component tests mount the REAL components with [src/tests/component/helpers/mountEditor.ts](src/tests/component/helpers/mountEditor.ts) (`recordingFilo`, `mountTextTile`, `mountDocumentEditor`, `pressUndo`, `settle`, `drainDebounce`). All three projects run in `test:unit:strict`. Heavy interaction coverage still lives in Playwright E2E.
- **Characterisation suite:** `src/tests/characterisation/` mounts the whole `App.svelte` against a real temp vault, with the real main-process IPC handlers behind `window.filo` (only the Electron shell is faked). The specs pin what the user sees (views, one model across views, frontmatter edits, renames, disk changes, delete + undo through the trash, tag undo, the tag row and raw view, bytes never written by looking) and call only the `harness/` adapter. When an internal API moves, update the harness, not the specs; the `characterisation-suite` gate enforces this. The one skip allowed is `it.skipIf(onLinux)` (`harness/platform.ts`), for the few cases that time out only on the Linux CI runner's file watcher; Filo targets Windows, where they run. `npm run scratch-vault` uses the same harness to build the dogfooding vault.
- **E2E tests (Playwright):** Cover critical user flows — create vault, create board, add tile, edit content, delete tile, switch tabs, undo/redo.
- **Test file location:** Unit tests go flat in `src/tests/unit/`, named after the module or behaviour they cover (`noteWriter.test.ts`). `src/tests/unit/contracts/` holds checks that read the whole codebase (IPC envelope, untrusted sinks, command coverage); it is not the characterisation suite. Component tests go in `src/tests/component/`, characterisation specs in `src/tests/characterisation/`, E2E tests in `src/tests/e2e/`.

---

## When Working on This Project

1. **Read the Design Doc first** (`Filo_Design_Doc_Rework_V5.md`) for any feature you're implementing. It's the authoritative specification.
2. **Don't build what isn't in scope.** Each phase has a clear deliverable. Don't pull in features from later phases.
3. **Leave working software at every phase boundary.** Each phase must result in a runnable app, even if incomplete.
4. **Test as you go.** Write unit tests for `lib/` modules as you build them. Don't batch testing to the end.
5. **No placeholder content.** No "Lorem ipsum", no sample images, no stub data in production code. If a feature isn't ready, don't ship a fake version of it.
6. **If something is ambiguous,** check the Design Doc. If it's still ambiguous, make a reasonable decision, document it with a `// DECISION:` comment, and move on.

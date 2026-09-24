# CLAUDE.md — Filo Development Guide

## Project Overview

Filo is a local-first, visual-first Personal Knowledge Management (PKM) desktop application. It combines an infinite canvas (Mind Map), Kanban boards, Task Lists, and Documents into a single tool. All data lives on the user's device as Markdown and JSON files — no accounts, no cloud, no lock-in.

**Key technical identity:** Electron + Svelte 5 + TypeScript + Vite. Vanilla CSS only. No Tailwind, no CSS-in-JS, no preprocessors.

---

## Quick Reference

```
Run dev:        npm run dev
Type-check:     npm run check
Unit tests:     npm run test:unit
E2E tests:      npm run test:e2e
Build:          npm run build
Package:        npm run package
```

### CI gates (`.github/workflows/ci.yml`)

`npm run ci:verify` mirrors the GitHub Actions `verify` job: **lint → check (svelte-check) → test:unit:strict → build → ci:gates**.

`ci:gates` runs `node scripts/gates/run.mjs`: ~53 small static checks that pin invariants which past data-loss bugs broke. They share one helper module ([scripts/gates/lib.mjs](scripts/gates/lib.mjs)) and are grouped by subsystem. `--list` shows every check, `--only <id,id>` / `--group <name>` narrow a run, and each failure prints `file:line` plus a fix hint.

| Group | Protects |
|---|---|
| `writePath` | Every `.md` write goes through the gateway ([markdownFileWriter.ts](src/renderer/lib/vault/markdownFileWriter.ts)) or `writeMarkdownAndReconcile` (write + open-editor reconcile for the same path); writes are time-bounded and never silently abort; field/Properties edits write a **delta on a fresh disk read**, never a cached whole FM object; new files are created exclusively (never overwrite an existing note); Keep-local takes a backup. |
| `markdownFormat` | Byte fidelity: BOM, UTF-8 validation (non-UTF-8 notes are read-only), EOL re-application, a single YAML parser (no js-yaml / gray-matter on frontmatter), editor load/undo/unmount discipline, and that the frontmatter-invariant and markdown body round-trip suites exist and aren't skipped. |
| `vaultIdentity` | A vault swap mid-`await` can't apply the outgoing vault's data to the new one (`isStillSameVault`); vault-scoped state resets on swap; path-keyed stores use `VaultPath` keys, case-fold compares, and follow renames; crash sentinels are per-machine; disk-shape IPC goes through `vaultOperations.ts`. |
| `ipcSecurity` | Every `ipcMain` channel is in the `IpcChannel` union (and vice versa); envelope usage; untrusted values pass an `asSafe*` validator before a sink; `vault:copy-file` only copies approved sources; renderer reads can't reach `.filo/`; config loaders migrate before parsing. |
| `commands` | Undo/redo: high-value mutations go through Commands, which snapshot their slice, carry a `targetBoardId`, and have an execute→undo round-trip test; Task List section positions are clamped. |
| `components` | Component timers are cleared, `flush*` functions are actually called, no dead `$derived`, DocumentEditor / drag-drop are pane-scoped, pointer capture + spatial batches handle `pointercancel`, z-index tokens, and every `var(--x)` without a fallback is defined. |
| `codebase` | No file in `src/main` / `src/renderer` over 1000 lines except the allowlisted ones, which may only shrink (**split an over-limit file, don't raise its ceiling**); no `as any` / `as unknown as`. |

**Escape hatches** are same-line comments with a reason, e.g. `// allow-cast: <reason>`, `// reconcile-elsewhere: <reason>`, `// allow-module-state: <reason>`. Keep the marker text exact; the checks look for it.

**Adding a check:** put it in the matching group module as `{ id, title, run(ctx) }` using the shared lib. Don't add a standalone `scripts/check-*.mjs`. Before relying on it, prove it bites: introduce the violation in real source, confirm the check fails, then revert.

`test:unit:strict` ([scripts/test-unit-strict.mjs](scripts/test-unit-strict.mjs)) runs vitest and also fails on known stderr-noise patterns (e.g. a missing `window.filo` mock).

The a11y axe-core scan and full Electron E2E are manual-only (Actions tab → CI → Run workflow).

**Comments:** explain *why* (the invariant, the hazard a guard prevents), never history. No audit IDs, phases, dates or "used to…" in code: that belongs in commit messages. Plans and audit reports live in `docs/` (active) and `docs/archive/` (done), not the repo root.

---

## Tech Stack (Locked — Do Not Substitute)

| Layer              | Technology                                                             |
| ------------------ | ---------------------------------------------------------------------- |
| Shell              | Electron (main process: Node.js)                                      |
| Frontend           | Svelte 5 (runes: `$state`, `$derived`, `SvelteSet`), TypeScript, Vite |
| Rich text editor   | TipTap (ProseMirror) + tiptap-markdown for MD round-tripping          |
| Canvas             | Custom pointer-event handlers + rbush (spatial index)                  |
| Markdown parsing   | unified + remark-parse + remark-frontmatter, gray-matter for FM        |
| Full-text search   | MiniSearch                                                             |
| Schema validation  | Zod                                                                    |
| List drag-and-drop | svelte-dnd-action                                                      |
| IDs                | nanoid                                                                 |
| Focus management   | focus-trap                                                             |
| Export             | html-to-image, jspdf                                                   |
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
│   │   │   ├── vault.ipc.ts           # File CRUD, directory ops
│   │   │   ├── board.ipc.ts           # Board file create/delete, config + theme
│   │   │   ├── dialog.ipc.ts          # Native open dialogs
│   │   │   ├── shell.ipc.ts           # External URL opening, reveal-in-folder
│   │   │   ├── media.ipc.ts           # Media save/copy helpers
│   │   │   ├── fonts.ipc.ts           # System font enumeration
│   │   │   ├── tags.ipc.ts            # .filo/tags.json load/save
│   │   │   ├── templates.ipc.ts       # .filo/templates/ CRUD
│   │   │   ├── sidebar.ipc.ts         # Sidebar geometry (userData)
│   │   │   └── export.ipc.ts          # PNG/SVG/PDF/Markdown export
│   │   ├── services/                  # Main-process-only services
│   │   │   ├── fileWatcher.ts         # fs.watch wrapper, debounced events
│   │   │   ├── fileWatcherTypes.ts    # Shared watcher types
│   │   │   ├── vaultRegistry.ts       # Active vault tracker (gates IPC)
│   │   │   ├── recoverySnapshot.ts    # `.filo/recovery/` snapshot helper
│   │   │   ├── renameCorrelation.ts   # Pairs missing+present events into renames
│   │   │   ├── recentVaults.ts        # Persisted recent vault list
│   │   │   ├── windowState.ts         # Window size/position (userData)
│   │   │   └── sidebarState.ts        # Sidebar width/floating bounds (userData)
│   │   ├── protocol/                  # Custom protocol handlers
│   │   │   └── rangeHeader.ts         # HTTP Range parsing for media streaming
│   │   ├── vault/                     # Main-side vault file primitives
│   │   │   ├── fileOps.ts
│   │   │   ├── boardFileOps.ts
│   │   │   ├── configOps.ts
│   │   │   └── filenameUtils.ts       # atomicWriteFile, assertSafeFilename
│   │   └── utils/
│   │       ├── pathSecurity.ts        # assertWithinVault, assertSafeRelativePath
│   │       ├── activeVaultCheck.ts    # assertActiveVault (gates IPC handlers)
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
│   │   │   ├── boardTileOps/          # Per-board-type tile-op registries (mindmap/kanban/tasklist/document)
│   │   │   ├── vaultLifecycle.ts      # onVaultSwap pre/post-swap hook registry
│   │   │   └── hotkeys.ts             # Keyboard shortcut binding
│   │   │
│   │   ├── stores/                    # Svelte 5 rune stores (.svelte.ts files)
│   │   │   ├── vault.svelte.ts        # Vault lifecycle, file tree, virtual project
│   │   │   ├── vaultIndex.svelte.ts   # In-memory metadata index + MiniSearch
│   │   │   ├── vaultExternalChanges.ts  # External-edit classifier consumer
│   │   │   ├── vaultRecovery.ts       # `.filo/.dirty` sentinel + recovery modal
│   │   │   ├── vaultFolderOps.ts      # In-app rename/delete/move
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
│   │   │   ├── boardCacheFrontmatter.ts
│   │   │   ├── boardCacheTypes.ts
│   │   │   ├── boardConnections.ts    # Active-board connection facade
│   │   │   ├── boardFrames.ts         # Active-board frames facade
│   │   │   ├── boardTiles.ts          # Active-board tiles facade
│   │   │   ├── boardWaypointsGroups.ts
│   │   │   ├── boardFrontmatterSync.ts  # Frontmatter→cache writer
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
│   │   │   ├── fileTags.svelte.ts     # `.filo/tags.json` + tile-def sync
│   │   │   ├── templates.svelte.ts    # Layout-template store
│   │   │   ├── document.svelte.ts
│   │   │   ├── ui.svelte.ts           # Modals, toasts, context menu state
│   │   │   ├── theme.svelte.ts
│   │   │   ├── spatial.svelte.ts      # rbush index wrapper
│   │   │   ├── guides.svelte.ts       # Smart guides
│   │   │   ├── pendingSettings.svelte.ts  # Settings modal Apply/Cancel scope
│   │   │   ├── orphans.svelte.ts
│   │   │   ├── links.svelte.ts        # filo:// internal link handling
│   │   │   ├── tiles.svelte.ts        # Tile factory + drop-type detection
│   │   │   ├── saveState.svelte.ts    # Idle/saving/saved/error indicator
│   │   │   └── toolbar.svelte.ts      # Toolbar undo/redo state
│   │   │
│   │   ├── schema/                    # Zod schemas + inferred TypeScript types
│   │   │   ├── index.ts               # Re-exports
│   │   │   ├── project.ts              # Virtual Project (in-memory only — no file on disk)
│   │   │   ├── board.ts
│   │   │   ├── boardFile.ts           # V7 .board.json file shape + boardId cross-checks
│   │   │   ├── tile.ts
│   │   │   ├── placement.ts
│   │   │   ├── connection.ts
│   │   │   ├── frame.ts
│   │   │   ├── document.ts
│   │   │   ├── settings.ts
│   │   │   ├── tagsFile.ts             # .filo/tags.json envelope + migration scaffold
│   │   │   ├── layoutTemplate.ts       # .filo/templates/*.json envelope + migration scaffold
│   │   │   ├── link.ts                 # filo:// link encode/decode + DecodedFiloLinkSchema
│   │   │   ├── migrations.ts
│   │   │   └── schemaUtils.ts          # uniqueBy / uniqueStrings / idString (NANOID_REGEX)
│   │   │
│   │   ├── commands/                  # Command pattern objects (undo/redo)
│   │   │   ├── index.ts               # Re-export shim — every import path still works
│   │   │   ├── Command.ts             # Base Command interface + abstract class (targetBoardId)
│   │   │   ├── tileCommands.ts        # tile add/delete/move/resize/style/lock
│   │   │   ├── tileTagCommands.ts     # tile/path tag add/remove + fade-by-tag (via fileTagsStore)
│   │   │   ├── connectionCommands.ts  # connection add/delete/update
│   │   │   ├── frameCommands.ts       # frame add/update/move/delete
│   │   │   ├── sectionCommands.ts     # Task List section add/delete/rename/reorder
│   │   │   ├── taskCommands.ts        # Task List add/delete/move/field/lock/style + snapshots
│   │   │   ├── kanbanCommands.ts      # Kanban card + column add/delete/move/rename
│   │   │   ├── waypointCommands.ts    # Mind Map waypoint add/remove/rename/move/icon/lock
│   │   │   ├── groupAndBoardCommands.ts # BatchCommand, ToggleGroupCommand, CascadeDeleteCommand, UpdateBoardSettingsCommand
│   │   │   ├── styleCommands.ts       # Style-popup commands (Frame/Card/Column/Task/Section/Connection)
│   │   │   ├── propertiesCommands.ts  # UpdatePropertiesCommand
│   │   │   ├── attachmentSrcCommand.ts# Image/Video/Audio/File swap
│   │   │   ├── renameTitleCommand.ts  # Tile title rename (cache + doc + .md file)
│   │   │   ├── replaceAllCommand.ts   # Vault-wide find-and-replace (history-tracked)
│   │   │   └── savedViewsCommand.ts   # UpdateSavedViewsCommand
│   │   │
│   │   ├── constants/
│   │   │   ├── defaults.ts            # TILE_DEFAULTS, FRAME_DEFAULTS, ACCENT_COLOR
│   │   │   ├── styleOptions.ts        # Shared style option lists (shape/border/pattern/path/arrow)
│   │   │   └── taskPriorities.ts      # Task / Kanban priority display metadata (color + label)
│   │   │
│   │   ├── lib/                       # Pure logic, no UI
│   │   │   ├── vault/                 # Vault-side helpers (renderer)
│   │   │   │   ├── vaultIndex.ts      # Metadata indexing + MiniSearch wiring
│   │   │   │   ├── fileRefIntegrity.ts# Rename propagation, broken-ref detection
│   │   │   │   ├── frontmatterSync.ts # External-edit reconciliation
│   │   │   │   ├── conflictResolver.ts# External-vs-dirty editor classifier
│   │   │   │   ├── dirtyFlagRecovery.ts # `.filo/.dirty` sentinel read/write
│   │   │   │   ├── conventionPaths.ts # Default attachment/board paths
│   │   │   │   ├── extension.ts
│   │   │   │   ├── moveIntoFolder.ts
│   │   │   │   ├── tagsStorage.ts     # `.filo/tags.json` mutators
│   │   │   │   ├── tagRewriteSweep.ts # Two-phase tag rename across .md
│   │   │   │   ├── tagRewriter.ts     # Frontmatter tag rename/remove/add (line-level fast path; dump fallback now routes through frontmatterEngine)
│   │   │   │   ├── frontmatterEngine.ts # Source-preserving FM serializer — `yaml` Document/CST API
│   │   │   │   ├── markdownFileWriter.ts # CANONICAL markdown write gateway: per-caller debounce, BOM-preserving hydrate, unified drain
│   │   │   │   ├── tagRewriteSentinel.ts # `.filo/tag-rewrite-pending.json` crash-recovery
│   │   │   │   ├── renameCascadeSentinel.ts # Rename-cascade crash-recovery sentinel
│   │   │   │   ├── fileBaselineRegistry.ts # Pre-write drift baselines (mtime/size)
│   │   │   │   ├── externalChangeWindows.ts # Self-write / attachment-delete timing windows
│   │   │   │   └── vaultTreeSort.ts   # Sidebar sort/group helpers
│   │   │   ├── boards/                # Board file load/save logic
│   │   │   │   ├── boardLoader.ts
│   │   │   │   ├── boardSaver.ts      # File-write helpers
│   │   │   │   ├── boardScope.svelte.ts
│   │   │   │   ├── boardScopeFactory.ts
│   │   │   │   ├── boardWriteScheduler.ts
│   │   │   │   ├── boardWriteDebounce.ts
│   │   │   │   ├── configWriteScheduler.ts
│   │   │   │   ├── miscWriteScheduler.ts
│   │   │   │   ├── frontmatterWriteScheduler.ts
│   │   │   │   ├── seedTextFileForNewTile.ts # Creates the backing .md for a new text tile
│   │   │   │   ├── tileDefBuilder.ts
│   │   │   │   ├── textTilePath.ts
│   │   │   │   ├── viewportCache.ts
│   │   │   │   └── writeStateTracking.ts # trackComponentWrite + counters
│   │   │   ├── canvas/                # Canvas engine (custom pointer events)
│   │   │   │   ├── coordinates.ts     # screenToCanvas, getCanvasPointFromEvent
│   │   │   │   ├── viewport.ts
│   │   │   │   ├── gestures.ts        # Pan/zoom pointer-event bindings
│   │   │   │   ├── edgePan.ts         # Edge-panning on drag
│   │   │   │   ├── tileDrag.ts
│   │   │   │   ├── tileResize.ts
│   │   │   │   ├── dragDrop.ts        # OS file drop → tile factory
│   │   │   │   ├── markdownTileSeed.ts
│   │   │   │   ├── textTileDropPlan.ts
│   │   │   │   ├── layout.ts          # Auto-layout algorithms
│   │   │   │   ├── orphanCatcher.ts
│   │   │   │   ├── vaultPath.ts
│   │   │   │   └── smartGuides.ts     # Alignment guide calculations
│   │   │   ├── connections/           # Connection path routing
│   │   │   │   ├── pathRouter.ts      # Curved, Straight, Elbow, Smart routing
│   │   │   │   ├── connectionSelection.ts
│   │   │   │   └── bubblePositions.ts
│   │   │   ├── editor/                # TipTap setup
│   │   │   │   ├── createEditor.ts    # Editor factory with all extensions
│   │   │   │   ├── markdownSync.ts    # MD ↔ ProseMirror round-trip
│   │   │   │   └── tagExtension.ts
│   │   │   ├── kanban/                # Kanban-board logic
│   │   │   ├── tasklist/              # Task List logic
│   │   │   ├── tasks/                 # Task-frontmatter helpers, recurrence, quickAddParser (shared)
│   │   │   ├── mindmap/               # Mind-map keyboard + selection
│   │   │   ├── settings/              # Settings cascade helpers
│   │   │   ├── styles/                # Override-cascade resolver
│   │   │   │   ├── effectiveStyle.ts  # Tile / column / card / task / document style cascade
│   │   │   │   ├── resolveStyle.ts
│   │   │   │   ├── resolvedTileStyleContext.ts
│   │   │   │   ├── buildBoardDefaults.ts
│   │   │   │   ├── applyDefaultsToAll.ts
│   │   │   │   └── defaultFontSizes.ts
│   │   │   ├── themes/                # Theme loading + CSS variable injection
│   │   │   │   └── themeManager.ts
│   │   │   ├── export/                # PNG, SVG, PDF, Markdown export
│   │   │   │   └── exportService.ts
│   │   │   ├── templates/             # Layout templates
│   │   │   │   ├── templateService.ts
│   │   │   │   ├── layoutCapture.ts
│   │   │   │   └── layoutTemplateStore.ts
│   │   │   ├── search/                # Query parser + full-text search runner (MiniSearch)
│   │   │   ├── spatialIndex.ts        # rbush wrapper
│   │   │   └── utils/                 # Shared utilities
│   │   │       ├── ids.ts             # nanoid wrapper
│   │   │       ├── color.ts           # Colour manipulation helpers
│   │   │       ├── cloneTile.ts
│   │   │       ├── contextMenuKey.ts
│   │   │       ├── editableTarget.ts
│   │   │       ├── errorBus.ts        # Renderer error → toast routing
│   │   │       ├── errorToastAggregator.ts
│   │   │       ├── listKeyNav.ts
│   │   │       ├── mediaUrl.ts
│   │   │       ├── normalizeTagsField.ts
│   │   │       ├── path.ts
│   │   │       ├── popupAnchor.ts
│   │   │       ├── portal.ts
│   │   │       ├── sanitizeHtml.ts
│   │   │       ├── tileUpdateFastPath.ts
│   │   │       ├── urlSafety.ts
│   │   │       └── navigation.svelte.ts # navigateToTile + highlight state
│   │   │
│   │   └── components/                # Svelte components (UI only)
│   │       ├── shared/                # Shared UI primitives
│   │       │   ├── Modal.svelte
│   │       │   ├── Dropdown.svelte
│   │       │   ├── ContextMenu.svelte
│   │       │   ├── Toast.svelte
│   │       │   ├── ColorPicker.svelte
│   │       │   ├── EmojiPicker.svelte
│   │       │   └── IconButton.svelte
│   │       ├── home/                  # Home / vault picker screen
│   │       │   └── HomeScreen.svelte
│   │       ├── layout/                # App shell layout
│   │       │   ├── AppShell.svelte    # Sidebar + workspace + tab bar
│   │       │   ├── GlobalToolbar.svelte
│   │       │   ├── TabBar.svelte
│   │       │   ├── Tab.svelte
│   │       │   ├── SplitPaneContainer.svelte
│   │       │   ├── PaneView.svelte
│   │       │   └── PaneDropOverlay.svelte
│   │       ├── sidebar/               # Vault sidebar
│   │       │   ├── VaultSidebar.svelte
│   │       │   └── VaultFileItem.svelte
│   │       ├── boards/                # Board-type root components
│   │       │   ├── BoardRouter.svelte
│   │       │   ├── MindMapBoard.svelte
│   │       │   ├── KanbanBoard.svelte
│   │       │   ├── KanbanColumn.svelte
│   │       │   ├── KanbanCard.svelte
│   │       │   ├── KanbanSideToolbar.svelte
│   │       │   ├── TaskListBoard.svelte
│   │       │   ├── TaskItem.svelte
│   │       │   ├── TaskListSideToolbar.svelte
│   │       │   ├── SmartListTabs.svelte # Task List smart-list filter tabs
│   │       │   ├── TaskQuickAddInput.svelte # Task List quick-add (natural-language) input
│   │       │   ├── DocumentBoard.svelte
│   │       │   ├── DocumentEditor.svelte
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
│   │       │   ├── BoardDefaults.svelte
│   │       │   ├── LivePreview.svelte
│   │       │   ├── ThemeManager.svelte
│   │       │   └── KeyboardShortcuts.svelte
│   │       ├── modals/                # Other modal dialogs
│   │       │   ├── ProjectSettings.svelte  # Tabbed wrapper around settings/
│   │       │   ├── BoardBrowser.svelte
│   │       │   ├── TemplateBrowser.svelte
│   │       │   ├── SaveTemplateModal.svelte
│   │       │   ├── TaskPropertiesModal.svelte
│   │       │   ├── OrphanCatcher.svelte
│   │       │   └── RecoveryFiles.svelte
│   │       └── tags/                  # Tag UI
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
│   │   ├── ipcSchemas.ts              # Per-channel Zod payload validation
│   │   ├── ipcContracts.ts            # Per-channel arg/result TYPE contracts (ChannelResult<C>, etc.)
│   │   ├── untrusted.ts               # Branded `Untrusted<T>` + asSafe* validators (untrusted-sink discipline)
│   │   └── ipcEnvelope.ts             # IPC ok/error envelope + IpcEnvelopeError
│   │
│   └── tests/
│       ├── unit/                      # Vitest unit tests
│       └── e2e/                       # Playwright E2E tests
│
├── static/                            # Static assets bundled by Vite
│   └── themes/                        # Built-in theme JSON files
│
└── scripts/                           # Build / dev scripts (electron-vite launcher)
```

### Structure Rules

1. **One concern per file.** If a file grows past ~300 lines, split it. Existing larger files (board.svelte.ts, boardCache.svelte.ts, MindMapBoard.svelte) are tracked for further splitting; new code should not exceed the threshold.
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
- Command names: `verb:noun` format (e.g., `tile:add`, `connection:delete`, `board:export-png`).

### Icons

- **All icons must be SVG.** No emojis as icons, ever.
- Store SVG icons inline (as inline `<svg>` markup) in the component that uses them. There is **no** shared icon directory today — neither `components/common/icons/` nor `static/icons/` exists; a handful of reused glyphs are currently duplicated inline. If a shared set grows enough to warrant it, create `components/common/icons/` at that point and update this note.
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
2. **YAML frontmatter** in `.md` files is the canonical source for metadata.
3. **Board JSON** fields that duplicate frontmatter (e.g., `completed`, `date`) are derived caches. On conflict, frontmatter wins.
4. **In-memory stores** reflect the file system state. They are caches, not sources.

### Persistence Boundary

All project state lives **inside the vault** — either a `.board.json`, a vault file (Markdown/media), or a `.filo/` config file. There is no `electron-store`, no `localStorage`, no `sessionStorage`, no `IndexedDB`. If you add a new piece of persisted state, route it through the vault.

The only state that lives in Electron `userData` (i.e. outside any vault) is the small carve-out of per-machine UI geometry and the launch bootstrap:

| File | Why it's outside the vault |
| --- | --- |
| `recent-vaults.json` | Must be readable before any vault is open. |
| `window-state.json` | Window size/position is per-display, not per-vault. |
| `sidebar-state.json` | Sidebar width and floating bounds are per-display. |
| `machine-id.json` | Identifies this machine so crash sentinels in the synced vault (`.filo/.dirty.<machineId>` …) never cross machines. |

Anything else — including overlay positions (Kanban side toolbar etc.), open tabs, viewports, themes, defaults — goes in `.filo/`.

**Tag persistence — note for attachments.** Text-tile tags live in two synced places: `.board.json` tile defs and the file's YAML frontmatter (`tags: [...]`). Attachment-tile tags (image / video / audio / generic file) have nowhere to write into the file itself, so they live in `.board.json` plus `.filo/tags.json:fileTags[mediaPath]`. The trade-off: tags on attachments are **vault-local** — copying or moving an attachment outside the vault without `.filo/` will lose its tags, whereas text-tile tags travel with the `.md` file. This is a deliberate consequence of the open-format principle (no sidecar files next to media). Don't add a sidecar without a separate design discussion.

### The Vault API Contract

There is no single `vaultApi.ts` module. The "Vault API" is a contract split
across a few owners, all of which call IPC to the main process — the renderer
NEVER touches `fs` directly (Electron context isolation; see "Persistence
Boundary").

- **Reads / generic writes** go through the `window.filo` preload bridge
  (`src/main/preload.ts` → `src/main/ipc/*`). The renderer calls `window.filo.*`,
  never `require('fs')`.
- **Disk-shape mutations** (rename / delete / create-folder / copy-file) go
  through `lib/vault/vaultOperations.ts`. `withDrainedWrites(op)` first drains the
  writer pipelines, then runs the op via the thin IPC wrappers (`renameVaultPath`,
  `deleteVaultPath`, `createVaultFolder`, `copyFileIntoVault`). The CI gate
  gate `no-raw-disk-shape-ipc` (scripts/gates) forbids raw renderer invokes of those
  four channels outside this module.
- **On file rename:** `lib/vault/fileRefIntegrity.ts` scans and updates ALL
  `.board.json` file references. The in-app rename/delete/move entry point is
  `stores/vaultFolderOps.ts`.
- **On file delete (from vault):** the same cascade removes every tile placement
  referencing that file from each `.board.json`.
- **Broken file references** are detected on board load and tracked via
  `stores/boardRefIntegrity.svelte.ts` — flagged, not silently ignored.

### Debouncing

- Content edits (tile text, frontmatter): 300ms idle debounce before disk write.
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
- Each board has its own independent undo/redo stack.
- Text editing undo is handled by TipTap/ProseMirror internally (separate from board undo).
- Board-level Ctrl+Z fires when no TipTap editor is focused.

### Override Cascade (Styles)

```
Per-element style (Tile Style popup) > Current Board Settings (.board.json) > Global Defaults (.filo/defaults.json)
```

Themes overwrite Global Defaults. They are not a separate layer.

---

## Key Design Decisions — Do Not Deviate

1. **Local-first. No network calls.** No telemetry, analytics, or remote APIs. Everything works offline.
2. **Open format.** Text is Markdown. Boards are JSON. Media files are stored as-is. A user must be able to read their data with any text editor.
3. **File-backed tiles.** Text, Image, Video, Audio, and File tiles point to real files in the vault. Link, Iframe, and Timer tiles store data inline in board JSON.
4. **One `.md` file = one document.** A Text Tile and a Document Board are two views of the same `.md` file. Edits in either view reflect immediately in the other.
5. **Same file on multiple boards.** Board JSON stores placement (position, size, style). Content comes from the shared vault file.
6. **Frontmatter is canonical.** Board JSON caches metadata but frontmatter wins on conflict.
7. **No external state management libraries.** Svelte 5 runes only.
8. **Vanilla CSS only.** CSS custom properties for theming. No Tailwind, no preprocessors.
9. **SVG icons only.** No emojis as icons.

---

## Common Gotchas

- **tiptap-markdown** — This handles Markdown ↔ ProseMirror round-tripping. The unified/remark pipeline is for VaultIndex metadata extraction, NOT for the editor.
- **svelte-dnd-action** — This is for Kanban column/tile reordering and Task List reordering. Canvas tile dragging is custom (raw pointer-event handlers + manual transform).
- **`$effect` vs `$derived`** — Use `$derived` for computed values. Use `$effect` only for side effects (IPC calls, DOM manipulation, subscriptions). Overuse of `$effect` is a code smell.
- **Store file extension** — Must be `.svelte.ts` for runes to work. Plain `.ts` files cannot use `$state`.
- **Electron context isolation** — `contextBridge` exposes a limited API object on `window`. The renderer calls `window.api.vault.read(path)`, NOT `require('fs')`.
- **Board JSON `file` field** — Vault-relative paths, not absolute. e.g., `"Notes.md"` or `"subfolder/Notes.md"`.
- **Frontmatter writes are source-preserving.** `assembleMarkdownFile` (`lib/editor/markdownSync.ts`) routes through `patchFrontmatterSourceCst` (`lib/vault/frontmatterCstModel.ts`), a CST engine on the `yaml` package. It rewrites only the keys whose value changed and emits every untouched key byte-for-byte from the on-disk source: comments, key order, quoting, and exotic scalars (`02134`, `0xFF00FF`, `1_000`) all survive. A full re-dump (`new Document(fm).toString()`) happens only for a never-read file, a block that isn't a block mapping, or a changed/deleted key carrying an anchor/alias. Remaining narrow losses: KNOWN_LIMITATIONS #1.
  - **One parser.** Reads (`parseMarkdownFile`, the vault index via `lib/vault/frontmatterRead.ts`), the tag rewriter and the engine's value-compare all use the `yaml` package. js-yaml and gray-matter are banned on frontmatter (a second parser coerces unquoted dates / `0b1010` / `<<` merges differently). The one exception, a tag-name validator in `tagsStorage`, carries `// allow-jsyaml:`.
  - **Line endings.** The engine works in LF, so the file's real EOL (sniffed at hydrate, `FileState.eol`) is re-applied to the FM block and fences. Without it, a CRLF note flips to LF on its first metadata edit.
  - **Write source = delta on fresh disk.** Field edits (Kanban/Task) and Properties edits record a `FrontmatterDelta` (`lib/vault/frontmatterDelta.ts`). The gateway applies it to a fresh disk read at write time, so keys added externally are never dropped. The `documentStore` FM cache is display-only, never a write source. Body-only editor saves are the one path that still assembles from the open editor's reconciled cache.

---

## Testing Strategy

- **Unit tests (Vitest):** Cover all `lib/` modules. Stores should have unit tests for their logic. Target: every function in `lib/` has at least one test.
- **Component tests (jsdom + Vitest):** `vitest.config.mts` has two projects: `unit` (`src/tests/unit/`) and `component` (`src/tests/component/`, resolved with the `browser` export condition so Svelte 5 client `mount()` works). Component tests mount the REAL components with [src/tests/component/helpers/mountEditor.ts](src/tests/component/helpers/mountEditor.ts) (`recordingFilo`, `mountTextTile`, `mountDocumentEditor`, `pressUndo`, `settle`, `drainDebounce`). Both projects run in `test:unit:strict`. Heavy interaction coverage still lives in Playwright E2E.
- **E2E tests (Playwright):** Cover critical user flows — create vault, create board, add tile, edit content, delete tile, switch tabs, undo/redo.
- **Test file location:** Mirror `src/` structure under `tests/unit/`. E2E tests go in `tests/e2e/`.

---

## When Working on This Project

1. **Read the Design Doc first** (`Filo_Design_Doc_Rework_V5.md`) for any feature you're implementing. It's the authoritative specification.
2. **Don't build what isn't in scope.** Each phase has a clear deliverable. Don't pull in features from later phases.
3. **Leave working software at every phase boundary.** Each phase must result in a runnable app, even if incomplete.
4. **Test as you go.** Write unit tests for `lib/` modules as you build them. Don't batch testing to the end.
5. **No placeholder content.** No "Lorem ipsum", no sample images, no stub data in production code. If a feature isn't ready, don't ship a fake version of it.
6. **If something is ambiguous,** check the Design Doc. If it's still ambiguous, make a reasonable decision, document it with a `// DECISION:` comment, and move on.

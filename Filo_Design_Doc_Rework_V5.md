# Filo - A Personal Knowledge Management Tool

## Overview

Filo is a highly customizable, PKM (Personal Knowledge Management) tool. It utilises an infinite-canvas, Kanban Board, Task List and Document builder as its main utilities. It is designed to help users visually structure ideas, manage tasks, and connect multimedia concepts. Moving beyond traditional text-based mind maps, Filo acts as a dynamic workspace where users can build and manage complex, interconnected boards tailored to their specific workflows—whether for free-form brainstorming, structured project management, or multimedia curation.

## Core Philosophy

* **Local-first** — All data lives on the user's device. No account or internet required. The user retains full ownership of their data at all times.
* **Open format** — Notes are stored as Markdown files, boards as JSON and other media is stored in their native formats. No proprietary lock-in. Files are readable by any text editor.
* **Visual-first, text-capable** — Unlike text-first PKMs, Filo leads with spatial canvases but treats every text tile as a full Markdown document, bridging visual and textual thinking.
* **Modular by design** — The codebase is structured into self-contained modules (e.g., Search, Templates) with clear interfaces between them. New tile types, board types, and features can be added without modifying unrelated code.

## Core Concepts

**Core Design Rules**

* All UI elements must be fully responsive and work on all screen sizes.
* All Icons must be SVG and must be scalable.
* No emojis should be used as icons, only SVG icons should be used.

* **Vault** — A vault is simply a standard folder on the user's computer or device. Filo stores all of its information within this folder. The user can connect their vault to a cloud storage service such as Google Drive, Dropbox, OneDrive, etc. Users can create both folders and subfolders to organize their information how they want. Configuration is stored in a hidden `.filo/` subfolder within the vault containing JSON settings files and theme data.

* **Board** — A board is a canvas where the user can create and manage their content. A board can be saved as a file on the user's computer or device. A board can be of any type, such as a Mind Map, Kanban Board, Task List, or Document. Files can be dragged onto a board that aren't necessarily in the user's vault, these files will be copied to the user's vault when dragged onto the board. The moment the file is dropped, Filo creates the relevant tile type to contain the file.

* **Tile** — A tile is a container for content that can be placed on any board. A tile can be moved, resized, and deleted. A tile can be of any type, such as a Text Tile, Image Tile, Video Tile, Audio Tile, File Tile, Link Tile or Iframe(Embed) Tile. Tiles default to the Text type, which is a rich Markdown editor and also corresponds to the Document board type — meaning the user can expand any text tile into a full Document board if necessary. Most tile types are backed by a file in the vault; the exceptions are Link, Iframe, and Timer tiles, which store their data entirely in the board JSON (see **Tile Storage** in the Data Model section for how each tile type maps to vault files). See **File Deletion Handling** in the Architecture section for how tile and file deletions propagate.

* **Properties (Frontmatter)** — Every text tile's underlying Markdown file supports YAML frontmatter enclosed in `---` delimiters. Properties store structured metadata: tags, custom fields (status, priority, due date, etc.). Properties are indexed by the VaultIndex and are queryable via search operators and the Tags Browser. Properties defined in frontmatter are the canonical source of truth for tile metadata — the UI reads from and writes to this frontmatter. For non-text tile types that lack a Markdown file (Link, Iframe, Timer) or that have a non-Markdown vault file (Image, Video, Audio, File), metadata is stored in the board JSON tile entry under a `metadata` object and is indexed identically by the VaultIndex. Properties can be edited directly in the Markdown frontmatter or via the Properties popup accessible from the tile header (see Tiles section).

* **Tags** — A tag is a label that can be applied to a tile either inline in content (prefixed with `#`) or in frontmatter properties. Tags support nesting (`#project/active`). Tags can be used to organize tiles, filter views, and navigate between related content across all boards.

* **Tabs** — Tabs are used to organize boards and can be used to switch between boards. There is a Tab Browser button for the user to quickly open and close tabs. The Tab Bar is located at the bottom of the screen.

## Data Model

**Frontmatter Source-of-Truth Rule:** For any file-backed tile, YAML frontmatter in the `.md` file is the canonical source of truth for metadata (status, dates, priority, etc.). Board JSON fields that duplicate frontmatter values (e.g., a task's `completed` flag) are derived caches. On any conflict — such as an external edit to the `.md` file — the frontmatter value wins and the board JSON is updated to match.

### Tile Storage

Every tile on a board is either backed by a file in the vault or stores its data directly in the board JSON. The board JSON references file-backed tiles via a `file` field (a vault-relative path) and stores data for non-file tiles inline. How that storage works depends on the tile type:

* **Text Tile** — Stored as a Markdown file (`.md`) in the vault. The same `.md` file can be opened as a standalone Document board (see Text Tile / Document Board relationship below). Supports YAML frontmatter for properties.
* **Image Tile** — The image file (`.png`, `.jpg`, `.gif`, `.webp`, etc.) is stored as-is in the vault. The board JSON `file` field points to the image path. No sidecar `.md` file is created; tile metadata (tags, properties) is stored in the board JSON's tile entry under a `metadata` object.
* **Video Tile** — The video file (`.mp4`, `.webm`, etc.) is stored as-is in the vault. The board JSON `file` field points to the local file.
* **Audio Tile** — Recordings are stored as `.mp3` files in the vault. The board JSON `file` field points to the audio file path.
* **File Tile** — The original file is stored as-is in the vault in whatever format it was provided (`.pdf`, `.docx`, `.zip`, etc.). The board JSON `file` field points to the file path. Opening a File Tile hands the file to the OS default app only for document, image, audio and video types. Scripts, macro-enabled Office files, archives, disk images and HTML-like files are never launched. For those, and for unknown types, Filo offers **Show in folder** instead.
* **Link Tile** — No file is stored in the vault. The board JSON tile entry stores the URL directly in a `url` field. The tile renders a clickable link with an optional preview fetched at display time.
* **Iframe (Embed) Tile** — No file is stored in the vault. The board JSON tile entry stores the embed URL in a `url` field. The tile renders the URL inside an `<iframe>`.
* **Timer Tile** — No file is stored in the vault. Timer configuration (mode, duration) is stored entirely within the board JSON tile entry under a `config` object. Timers are ephemeral UI widgets and do not persist state between sessions.

For tile types that store a file in the vault (Text, Image, Video, Audio, File), when the tile is created by dragging a file onto the board, Filo copies the file into the vault if it is not already there. For tile types that do not store a vault file (Link, Iframe, Timer), all data lives in the board JSON. See **Properties (Frontmatter)** in Core Concepts for how metadata is stored per tile type.

### Text Tile / Document Board Relationship

A Text Tile and a Document Board are two views of the same underlying `.md` file. When a user creates a Text Tile on a Mind Map board, the tile content is written to a `.md` file in the vault. The "Expand to Document" button opens that same `.md` file as a full-page Document board in a new tab. Any edits made in either view are reflected immediately in the other, because both read from and write to the same file. A Document board can also be created independently (without originating from a tile) — in this case Filo still creates a backing `.md` file in the vault. If that file is later referenced as a tile on a Mind Map board, the same bidirectional sync applies.

### Tiles on Multiple Boards

The same vault file (e.g., `Notes.md`) can be placed on multiple boards simultaneously. Each board stores its own placement data for the tile (position, size, style) in its `.board.json` file, but the **content** comes from the shared vault file.

* Editing tile content on any board writes to the same underlying file — all boards displaying that file reflect the change immediately.
* Each board's placement is independent: the same file can have different positions, sizes, and style overrides on different boards.
* For how tile and file deletions propagate, see **File Deletion Handling** in the Architecture section.

### Board File (.board.json)

All board types are stored as `.board.json` files. Every board file shares a common top-level structure with a `type` field that determines how the rest of the file is interpreted. Below are schemas for each board type.

#### Envelope Versioning

On disk, every `.board.json` is wrapped in a versioned envelope:

```json
{
  "version": 7,
  "board": { /* board-type-specific shape, see below */ },
  "tileDefs": { /* tileId → tile definition */ },
  "connections": { /* connectionId → connection */ },
  "frames": [ /* frame[] */ ]
}
```

* **`version`** — A pinned integer literal (`7` for the current shape — `CURRENT_BOARD_FILE_VERSION` in `src/renderer/schema/boardFile.ts`). When the on-disk shape changes in a way that requires structural migration, this is bumped and a matching branch is added to `migrateBoardFile` in `src/renderer/schema/migrations.ts`. A `.board.json` whose `version` is *higher* than the running binary supports must fail to load loudly rather than be misinterpreted by code that doesn't know the new shape; the loader surfaces a "from-future board" toast and skips the file.
* **`board` / `tileDefs` / `connections` / `frames`** — V7 stores tile definitions, connections, and frames as side-bag records alongside the board rather than nested inside it (older shapes embedded them). Tile *placements* — position, size, per-board style overrides — still live inside `board`; the side-bag records carry the *definitions* those placements reference. The schemas listed in the per-board-type sections below describe the resolved in-memory shape (placements + their definitions merged) rather than the raw envelope; the envelope itself is validated by `V7BoardFileDataSchema`.

The runtime `V7BoardFileData` type used by the renderer cache deliberately *omits* the `version` field — the literal is stamped at parse time and re-injected on save, so in-memory consumers never read it. This is documented at the type declaration site (`src/renderer/lib/boards/tileDefBuilder.ts`).

#### Mind Map Board

```json
{
  "type": "mindmap",
  "settings": {
    "background": "#1a1a2e",
    "pattern": "dots",
    "snapToGrid": true,
    "semanticZoom": true
  },
  "tiles": [
    {
      "id": "tile_a1b2c3",
      "tileType": "text",
      "file": "Notes.md",
      "x": 120, "y": 80,
      "width": 300, "height": 200,
      "style": {
        "headerColour": "#3a86ff",
        "bodyColour": "#ffffff",
        "shape": "rounded",
        "borderStyle": "solid",
        "borderWidth": 1,
        "shadowIntensity": 0.3
      },
      "locked": false
    },
    {
      "id": "tile_img001",
      "tileType": "image",
      "file": "assets/diagram.png",
      "x": 500, "y": 80,
      "width": 250, "height": 200,
      "style": { "borderStyle": "solid", "borderWidth": 1, "shadowIntensity": 0.2 },
      "metadata": { "tags": ["reference"] },
      "locked": false
    },
    {
      "id": "tile_link001",
      "tileType": "link",
      "url": "https://example.com/article",
      "x": 800, "y": 80,
      "width": 250, "height": 100,
      "style": { "borderStyle": "solid", "borderWidth": 1, "shadowIntensity": 0.2 },
      "locked": false
    }
  ],
  "connections": [
    {
      "id": "conn_x1y2z3",
      "from": { "tile": "tile_a1b2c3", "bubble": 3 },
      "to": { "tile": "tile_d4e5f6", "bubble": 7 },
      "type": "smart",
      "style": "solid",
      "arrows": "end",
      "label": {
        "text": "depends on",
        "position": 0.5
      }
    }
  ],
  "frames": [
    {
      "id": "frame_001",
      "title": "Phase 1",
      "x": 80, "y": 40,
      "width": 800, "height": 500,
      "children": ["tile_a1b2c3", "tile_d4e5f6"],
      "collapsed": false,
      "style": {
        "headerColour": "#2d3436",
        "bodyColour": "#dfe6e9",
        "borderStyle": "solid",
        "borderWidth": 1
      }
    }
  ],
  "waypoints": [
    { "id": "wp_001", "name": "Design Section", "x": 120, "y": 80, "zoom": 1.0 }
  ]
}
```

#### Kanban Board

```json
{
  "type": "kanban",
  "settings": {
    "background": "#1a1a2e",
    "accentColour": "#3a86ff"
  },
  "columns": [
    {
      "id": "col_001",
      "title": "Backlog",
      "position": 0,
      "style": {
        "headerColour": "#2d3436",
        "bodyColour": "#dfe6e9",
        "borderStyle": "solid",
        "borderWidth": 1,
        "shadowIntensity": 0.2
      },
      "tiles": [
        {
          "id": "tile_001",
          "tileType": "text",
          "file": "Task - Design review.md",
          "position": 0,
          "style": {
            "backgroundColour": "#ffffff",
            "borderStyle": "solid",
            "borderWidth": 1,
            "shadowIntensity": 0.1
          }
        }
      ]
    },
    {
      "id": "col_002",
      "title": "In Progress",
      "position": 1,
      "style": { "headerColour": "#2d3436", "bodyColour": "#dfe6e9", "borderStyle": "solid", "borderWidth": 1, "shadowIntensity": 0.2 },
      "tiles": []
    }
  ]
}
```

Kanban columns contain tiles from the same tile system used by Mind Map boards. Supported tile types are Text, Audio, Image, File, and Link. Video, Iframe (Embed), and Timer tiles are not supported. Text and Audio tiles can be created via the "+ New Tile" button or by drag-and-drop; Image and File tiles are created exclusively by drag-and-drop; Link tiles via the "+ New Tile" button. See **Tile Storage** in the Data Model for how each tile type maps to vault files. Tiles can be dragged between columns to update their workflow status.

#### Task List Board

```json
{
  "type": "tasklist",
  "settings": {
    "background": "#1a1a2e",
    "accentColour": "#3a86ff",
    "groupBy": "status",
    "sortBy": "priority"
  },
  "tasks": [
    {
      "id": "task_001",
      "file": "Task - Write tests.md",
      "position": 0,
      "completed": false,
      "style": {
        "headerColour": "#2d3436",
        "bodyColour": "#ffffff",
        "borderStyle": "solid",
        "borderWidth": 1,
        "shadowIntensity": 0.1
      }
    }
  ]
}
```

Task list items reference `.md` files in the vault. Unlike Mind Map and Kanban boards, the Task List does not use the tile UI system — tasks are displayed as flat list rows rather than spatial tile containers. However, each task's content is still a full Markdown document with metadata (status, priority, due date, assignee) stored in YAML frontmatter. The `completed` field in the board JSON is a derived cache — see the **Frontmatter Source-of-Truth Rule** above. Grouping and sorting is driven by frontmatter property values.

#### Document Board

```json
{
  "type": "document",
  "settings": {
    "background": "#ffffff",
    "accentColour": "#3a86ff"
  },
  "file": "Project Overview.md"
}
```

A Document board is the simplest board type — it is a full-page view of a single `.md` file. The board JSON simply points to the file. All content lives in the Markdown file. See the **Text Tile / Document Board Relationship** section above.

### Vault Configuration (.filo/)

All files in `.filo/` store **vault-wide (Global) settings**. Per-board settings live in each board's `.board.json` file under the `settings` object (see Settings > Current Board Settings).

```
.filo/
├── app.json              # Core app settings (toolbar sizes, radar toggle, font settings)
├── appearance.json       # Active theme, font
├── defaults.json         # Board-type defaults (tile styles, connection styles, frame styles)
├── hotkeys.json          # Custom keyboard shortcut overrides
├── workspace.json        # Layout state (open tabs, sidebar state, toolbar positions, split panes)
├── themes/               # Theme files (collections of defaults + appearance overrides)
│   ├── light-mode.json
│   ├── dark-mode.json
│   ├── nature-mode.json
│   ├── blueprint.json
│   ├── retro.json
│   └── custom-theme.json
└── fonts/                # User-imported custom fonts
```

#### workspace.json

Stores the UI layout state so it can be restored on next launch.

```json
{
  "openTabs": [
    { "boardFile": "Project Plan.board.json", "active": true },
    { "boardFile": "Meeting Notes.board.json", "active": false }
  ],
  "splitPanes": {
    "orientation": "horizontal",
    "sizes": [60, 40],
    "boards": ["Project Plan.board.json", "Meeting Notes.board.json"]
  },
  "vaultSidebar": { "open": true, "width": 260 },
  "sideToolbar": { "position": "right", "pinned": true },
  "lastOpenBoard": "Project Plan.board.json"
}
```

### External Edit Conflict Resolution

When the VaultIndex detects an external change to a `.md` file that is currently open in the TipTap editor with unflushed in-memory edits, Filo displays a non-blocking toast notification offering two choices: **"Reload from disk"** (discards in-memory edits and loads the externally modified file) or **"Keep local"** (first copies the external version into `.filo/recovery/`, then keeps the in-memory edits and flushes them to disk; if that backup fails, Filo asks before overwriting without one). The prompt stays on screen until the user chooses; while it is open nothing is overwritten. For frontmatter-only conflicts on files not currently being edited, the **Frontmatter Source-of-Truth Rule** applies automatically with no user prompt.

### Tag System — Frontmatter Canonical, Body Decorative

Tags have two distinct surfaces in Filo, and only one of them is canonical:

* **Frontmatter `tags:` (canonical).** The array under a file's YAML frontmatter is the authoritative tag list for that file. VaultIndex indexes it, the tag browser reads it, rename/delete sweeps rewrite it, and `.filo/tags.json:fileTags[path]` mirrors it. Tile entries on `.board.json` cache the same names for offline reads but defer to frontmatter on conflict.
* **Body `#tag` chips (decorative).** TipTap's tag extension recognises `#tag` and `#tag/subtag` runs in body text and styles them as chips for readability. These chips are *not* indexed and *not* rewritten by rename/delete operations. They survive a markdown round-trip as bare `#tag` text so external editors see exactly what the user typed, but they have no presence in the tag registry.

This split is intentional. Body chips give users the freedom to mention a tag in a sentence without changing the file's canonical tag set; frontmatter is the single, structured surface where tag identity lives. Hovering a body chip surfaces a tooltip explaining the distinction so users aren't surprised when a rename leaves body mentions untouched.

Tags are global to the vault (their colour definitions live in `.filo/tags.json:tags`) and may be hierarchical (`parent/child`). Renaming a parent does *not* cascade to children — the tag browser warns the user when a rename would orphan child tags so they can decide explicitly.

## Architecture

### Application Shell

* **Desktop:** Electron main process (Node.js) for file system access, window management, and native OS integration.
* **Mobile (Out of scope for v1):** A future Capacitor (Ionic) wrapper is conceivable but not on the v1 roadmap and is not being designed or tested for. The current architecture happens to leave the door open — file I/O is abstracted behind the Vault API (swappable for Capacitor's Filesystem plugin), UI components use responsive CSS, and platform-specific code (Electron IPC, native menus, file watchers) is isolated in a thin shell layer — but no mobile work is planned. Treat any "mobile-friendly" hedging in this document as opportunistic, not a commitment.
* **Frontend:** Svelte 5 with TypeScript, bundled with Vite.
* **Rendering:** Custom infinite canvas with rbush spatial indexing. Pan, zoom, drag, resize, and edge-pan are all implemented as raw pointer-event handlers in `src/renderer/lib/canvas/` — there is no gesture library.

### Data Layer

* **File System** — The vault folder is the single source of truth. Text tiles and document boards are `.md` files, non-text tiles are stored as their native file type (`.png`, `.mp3`, `.svg`, etc.) or have no vault file at all (Link, Iframe, Timer tiles store data in the board JSON). Boards are `.board.json` files. Configuration lives in `.filo/`.
* **VaultIndex** — An in-memory index that parses and caches metadata from all vault files: headings, tags, and frontmatter properties. Markdown files are parsed using the unified/remark pipeline (remark-parse + remark-frontmatter) for metadata extraction. Full-text search is powered by a MiniSearch instance that is updated alongside the metadata index. The index rebuilds incrementally on file changes via file system watchers (Node.js `fs.watch`). File change events are debounced (300ms) to batch rapid saves. When a change is detected, only the affected file is re-parsed and its MiniSearch entry updated — a full rebuild is only performed on vault open. External edits to vault files (e.g., from another text editor) are detected by the same watcher and trigger re-parsing; frontmatter conflicts are resolved per the **Frontmatter Source-of-Truth Rule** (see Data Model). Validated with Zod schemas.
* **Vault API** — Programmatic interface for file CRUD operations. When a tile or file is renamed, the Vault API updates all board JSON references to the old file path. Broken file references (pointing to deleted or non-existent files) are detected during board loading and flagged. This is the single system responsible for all file reference resolution and renaming propagation.

### File Sync Model

Filo uses a debounced write strategy to keep vault files up to date without hammering the file system. Content edits (tile text, frontmatter changes) are held in memory and flushed to disk after 300ms of idle — this prevents every keystroke from triggering a file write and an accompanying file watcher event that would need to be distinguished from external edits. Layout changes (tile moves, resizes, connection updates) to `.board.json` files use the same 300ms debounce. Configuration changes to `.filo/` files are written on confirmation or panel close. If the application is closed or crashes with unflushed edits, a dirty flag in `.filo/workspace.json` triggers a recovery flush on next launch. The source of truth hierarchy is defined in the **Data Layer** section above; the file system watcher (Node.js `fs.watch`, debounced at 300ms) detects external changes and updates in-memory state accordingly.

### File Deletion Handling

* **Deleting a tile from a board** removes only that board's placement entry in the `.board.json` file. The underlying vault file is never deleted by this action, regardless of tile type. To permanently delete a file, the user must remove it from the vault via the Vault Sidebar or an external file explorer.
* **Deleting a file from the vault** (via the Vault Sidebar or externally) triggers the file system watcher, which propagates the deletion by automatically removing all placements referencing that file from every `.board.json` in the vault. The VaultIndex is also updated to remove the file's indexed metadata.
* **Deleting a `.board.json` file** removes the board from the vault. Any open tabs referencing that board are closed. Vault files referenced by tiles on the deleted board are not affected — they remain in the vault.

### Modular Architecture

Filo's codebase is organized into self-contained feature modules with clear boundaries and interfaces. This ensures maintainability and makes it straightforward to add new features without touching unrelated code.

* **Feature Modules** — Each major feature is its own module with a defined interface: Search, Templates, Word Count. Modules can be toggled on/off in settings.
* **Module API** — Modules interact with the core through shared TypeScript interfaces:

    * **`App`** — Global application object. Provides access to all other APIs and the current vault context.
        ```typescript
        interface App {
          vault: Vault;
          workspace: Workspace;
          vaultIndex: VaultIndex;
          boardManager: BoardManager;
          commands: CommandRegistry;
        }
        ```

    * **`Vault`** — File CRUD operations with file reference integrity. All file system access goes through this interface.
        ```typescript
        interface Vault {
          // File operations
          read(path: string): Promise<string>;
          write(path: string, content: string): Promise<void>;
          create(path: string, content?: string): Promise<string>; // returns created path
          delete(path: string): Promise<void>;  // removes file + cleans all .board.json references
          rename(oldPath: string, newPath: string): Promise<void>; // updates all board JSON references
          exists(path: string): Promise<boolean>;
          copy(sourcePath: string, destPath: string): Promise<string>;

          // Directory operations
          listFiles(folderPath?: string): Promise<string[]>;
          createFolder(path: string): Promise<void>;

          // Vault info
          getVaultPath(): string;
          getRelativePath(absolutePath: string): string;

          // Events
          on(event: 'create' | 'modify' | 'delete' | 'rename', callback: (path: string) => void): void;
        }
        ```

    * **`Workspace`** — UI pane, tab, and toolbar management.
        ```typescript
        interface Workspace {
          getActiveBoard(): Board | null;
          getActiveTile(): TilePlacement | null;
          openBoard(boardPath: string, options?: { split?: 'right' | 'down'; newTab?: boolean }): void;
          closeTab(boardPath: string): void;
          getOpenTabs(): TabInfo[];
          getSplitPanes(): PaneInfo[];

          // Sidebar management
          toggleVaultSidebar(): void;

          // Events
          on(event: 'board-change' | 'tab-change' | 'selection-change', callback: () => void): void;
        }
        ```

    * **`VaultIndex`** — Cached metadata queries. Powered by the file system watcher.
        ```typescript
        interface VaultIndex {
          // Queries
          getFileMetadata(path: string): FileMetadata | null;
          getTaggedFiles(tag: string): string[];
          getAllTags(): Map<string, number>; // tag → count
          searchByProperty(key: string, value: string): string[];

          // Events
          on(event: 'changed' | 'resolved', callback: (path: string) => void): void;
        }
        ```

    * **`BoardManager`** — Board and tile manipulation.
        ```typescript
        interface BoardManager {
          // Board operations
          createBoard(type: BoardType, name: string): Promise<string>; // returns .board.json path
          loadBoard(path: string): Promise<Board>;
          saveBoard(board: Board): Promise<void>;
          deleteBoard(path: string): Promise<void>;

          // Tile operations on active board
          addTile(tileType: TileType, options?: { x?: number; y?: number; file?: string }): TilePlacement;
          removeTile(tileId: string): void;
          getTile(tileId: string): TilePlacement | null;

          // Connection operations
          addConnection(fromTile: string, fromBubble: number, toTile: string, toBubble: number): Connection;
          removeConnection(connectionId: string): void;

          // Frame operations
          addFrame(options?: { x?: number; y?: number; width?: number; height?: number }): Frame;
          removeFrame(frameId: string): void;
        }
        ```
* **Tile Type Registry** — New tile types (e.g., Timer, Audio) are registered through a central registry pattern, making it easy to add new types without modifying existing tile code.
* **Board Type Registry** — New board types beyond the built-in five can be added by implementing a standard board interface and registering it.
* **Command Registry** — All actions (toolbar buttons, keyboard shortcuts, context menu items) are registered as commands in a central registry, enabling consistent keyboard shortcut mapping and action dispatch.

### State Management

The frontend uses Svelte 5 Runes (`$state`, `$derived`, `SvelteSet`) for all reactive state. No external state management libraries are used. Stores are organized by domain in `/src/renderer/stores/`:

| Store | Responsibility |
|---|---|
| **vault** | Current vault path, file watcher integration, vault metadata |
| **board** | Active board data: tile placements, connections, frames, waypoints. CRUD operations for board elements |
| **canvas** | Pan/zoom transform state (`x`, `y`, `scale`), viewport rectangle, minimap visibility, semantic zoom toggle |
| **selection** | Currently selected tile IDs, multi-select state |
| **history** | Per-board undo/redo stacks. Each board maintains an independent command stack |
| **tabs** | Open board tabs, active tab tracking. Switching tabs loads the corresponding board |
| **connections** | Connection management: creation, deletion, visibility toggling |
| **frames** | Frame management: creation, deletion, collapse/expand, child tile tracking |
| **tags** | Tag definitions: create, rename, recolour, delete |
| **templates** | In-memory cache of Layout Templates from `.filo/templates/` plus the pending insertion anchor; save / rename / delete actions |
| **document** | Loaded Markdown documents mapped by content ID. Handles read/write to `.md` files |
| **ui** | Transient UI state: open modals, active toast messages, context menu position, toolbar state |
| **theme** | Active theme name and CSS variable values |
| **spatial** | RBush spatial index for viewport culling — only tiles within the visible viewport are rendered |
| **guides** | Smart guide state: active guide lines, snap distance, alignment calculations |
| **search** | Vault-wide Search query, parsed operator filters, match results, current-match cursor, Find/Replace mode toggle |
| **vaultIndex** | In-memory index of parsed vault metadata (headings, tags, frontmatter). Powers search and tag queries |

**Data flow:** User action → store mutation → reactive UI update. For file-backed data, store mutations schedule a debounced write (300ms idle) to the vault via the Vault API (IPC to main process). External file changes detected by the file watcher flow in reverse: watcher event → IPC to renderer → store update → reactive UI update.

### Undo/Redo System

Filo uses a **command pattern** for undo/redo. Every undoable action is encapsulated as a command object with `execute()` and `undo()` methods. Executed commands are pushed onto the active board's undo stack; the redo stack is cleared on any new action.

**Per-board stacks:** Each board maintains its own independent undo and redo stack. Switching tabs changes which stack is active. This means undoing on Board A never affects Board B.

**Command types:**
* `AddTileCommand` / `DeleteTilesCommand` — Creating or removing tile placements
* `MoveTilesCommand` — Changing tile positions (drag)
* `ResizeTileCommand` — Changing tile dimensions
* `AddConnectionCommand` / `DeleteConnectionCommand` — Creating or removing connections
* `AddFrameCommand` / `DeleteFrameCommand` — Creating or removing frames
* `AlignTilesCommand` — Aligning selected tiles (left, right, top, bottom)
* `LayoutTilesCommand` — Auto-layout (tree horizontal, tree vertical, radial)
* Style change commands — Tile, connection, and frame style modifications

**Text editing integration:** Text content changes within the Tiptap editor use Tiptap's built-in ProseMirror undo/redo (Ctrl+Z / Ctrl+Y while the editor is focused). Board-level undo (Ctrl+Z while no editor is focused) operates on the board's command stack. These two undo systems are independent.

### Editor

* **Rich Text:** Tiptap (ProseMirror) with the following Extensions:
    * @tiptap/core — Headless rich text editor framework
    * @tiptap/pm — ProseMirror bindings
    * @tiptap/starter-kit — Basic extensions bundle (bold, italic, lists, etc.)
    * tiptap-markdown — Markdown serialization/deserialization for round-tripping between TipTap's ProseMirror document model and `.md` files. This is essential for the open-format philosophy — without it, TipTap defaults to HTML output. All tile `.md` files are read into TipTap via this extension's parser and written back to disk via its serializer.
    * @tiptap/extension-text-align — Text alignment (left, center, right, justify)
    * @tiptap/extension-text-style — Inline text styling
    * @tiptap/extension-underline — Underline formatting
    * @tiptap/extension-color — Text color
    * @tiptap/extension-highlight — Text background highlighting
    * @tiptap/extension-font-family — Font family selection
    * @tiptap/extension-link — Hyperlink support
    * @tiptap/extension-image — Image insertion
    * @tiptap/extension-placeholder — Placeholder text in empty editors
    * @tiptap/extension-table — Table support
    * @tiptap/extension-table-cell — Table cells
    * @tiptap/extension-table-header — Table headers
    * @tiptap/extension-table-row — Table rows
    * @tiptap/extension-task-list — Checkbox/task lists
    * @tiptap/extension-task-item — Individual task items
    * @tiptap/extension-code-block-lowlight — Syntax-highlighted code blocks
    * lowlight — Syntax highlighting engine for code blocks

### Theming

* **CSS-based theming** — The UI is themeable via CSS variables. Themes are collections of CSS variable overrides plus default style settings. The app exposes semantic CSS classes on all UI elements.
* **Vanilla CSS Only** — No Tailwind, no CSS-in-JS, no preprocessors.
* **CSS Custom Properties** — All theme-dynamic values use CSS variables.
* **Component Scoped Styles** — Use `<style>` blocks in Svelte components.
* **Global Styles** — Only in `/css/style.css` and `/css/conn.css`.
* **Inline Styles** — Only for runtime-dynamic values (positions, user-set colours).

## UI/UX Structure

The UI is split up into 5 main sections:

1. **Global Toolbar** at the top of the screen.
2. **Board Specific Toolbars** which are located on the right hand side of the screen by default but can be freely moved around the screen and pinned anywhere.
3. **Vault Sidebar** on the left hand side of the screen which can be expanded or collapsed.
4. **Board Workspace** which is the main area of the screen where the user can create and manage their content. Supports split-pane viewing — users can open up to three boards side-by-side (horizontal or vertical split) for reference or drag-and-drop between boards.
5. **Tab Bar** at the bottom of the screen.

### Global Toolbar

The Global Toolbar consists of the following buttons:

* **Home** — Takes the user to the home screen where they can manage their vaults and choose to create a new vault or open an existing vault.

* **Manage Filo (Dropdown)**
    * **Export Options (Side-Menu)**
        * PNG — Exports Current Board to PNG.
        * SVG — Exports Current Board to SVG.
        * PDF — Exports Current Board to PDF.
        * Markdown — Exports Current Board to Markdown.
    * **Settings (Button)** — Takes the user into the Filo settings page. Settings are split into two scopes: **Global Settings** (vault-wide defaults stored in `.filo/`) and **Current Board Settings** (per-board overrides stored in the active board's `.board.json`). The override cascade is: **per-element style** (e.g., Tile Style popup) > **Current Board Settings** > **Global Defaults**. If a value is not set at a higher level, the next level down is used. Applying a Theme overwrites Global Defaults — themes are a convenient way to bulk-set Global Defaults rather than a separate cascade layer. Once applied, the user can further customise Global Defaults as they wish; those customised values become the new Global Defaults.

        * **Settings Live Preview** — Both the Global Settings and Current Board Settings panels include a live preview area displayed alongside the settings controls. As the user adjusts any style value (colours, borders, shapes, shadows, patterns, fonts), the preview renders a representative sample of the affected element (e.g., a mock tile for Tile Defaults, a mock column for Column Defaults, a mock connection for Connection Path Defaults) using the new value in real time. Changes are not committed until the user confirms — the preview is non-destructive. If the user is editing Current Board Settings, the preview uses the active board's content as context. For Global Settings, the preview uses a generic sample.

        * **Colour Picker** — All colour pickers throughout Filo use the same component. The picker displays a grid of preset swatches corresponding to the active theme's colour palette (similar to the colour picker in Google Docs). Below the presets, a "Custom Colour" button opens an expanded panel with a hue/saturation wheel, a brightness slider, a hex input field, and an eyedropper tool for sampling any colour on screen. Recently used custom colours are saved and displayed as an additional row of swatches for quick re-use.

        * **Global Settings** — Vault-wide settings that apply across all boards. Stored in `.filo/app.json`, `.filo/appearance.json`, and `.filo/defaults.json`.

            * **General** (stored in `.filo/app.json`)
                * Global Font (Dropdown) — Sets all UI elements font.
                * System Fonts (Reactive List) — User can remove any fonts they want as long as there is 1 font remaining.
                * Import Custom Font (.otf or .ttf) — Allows user to import custom font into the tool.
                * Global Tool Bar Size — Changes the tool bar scale to be either Small, Medium or Large.
                * Global Tool Bar Colour — Changes the tool bar colour.
                * Tab Bar Size — Changes the tab bar scale to be either Small, Medium or Large.
                * Tab Bar Colour — Changes the tab bar colour.
                * Toggle Radar — Toggles the Radar on active media on and off for the mini map.

            * **Defaults** (stored in `.filo/defaults.json`) — Default style values applied to all new boards and elements. Individual boards can override these via Current Board Settings. A Board Type dropdown selects which board type's defaults to edit: Mind Map, Kanban Board, Task List, or Document.

                * **Standard Element Style Properties** — The following properties are shared by all element types (tiles, columns, tasks, document pages, frames). Each board type's element defaults include these unless noted otherwise:
                    * Header Colour — Default header colour.
                    * Body Colour — Default body colour.
                    * Dynamic Contrast Text (Toggle) — See **Dynamic Contrast Text** in General Features. Defaults to on.
                    * Border Style (Dropdown) — solid, dashed, or dotted.
                    * Border Width (Dropdown) — Numeric value.
                    * Shadow Intensity — Drop shadow intensity (slider).

                * **Standard Board Properties** — All board types include:
                    * Board Background Colour — Default background colour.
                    * Accent Colour — Default accent colour. *(All board types except Mind Map, which uses Board Background Pattern instead.)*

                * **Mind Map Defaults** — Board Background Colour, Board Background Pattern (Grid, Dots, Lines, None), plus:
                    * **Tile Defaults** — Standard Element Style Properties plus Shape (Dropdown: Rectangle or Rounded). Individual tiles can override via the Tile Style popup.
                    * **Connection Path Defaults** — Connection Path Colour, Path Type (Curved, Straight, Elbow, Smart), Path Style (solid, dashed, dotted), Arrow Type (neither, start, end, both), Arrow Colour. Individual connections can override via the Connection Style popup.
                    * **Connection Label Defaults** — Default Label Text (blank if empty), Label Colour.
                    * **Frame Defaults** — Standard Element Style Properties plus Frame Background Image and Frame Background Opacity. Individual frames can override via the Frame Style popup.

                * **Kanban Board Defaults** — Standard Board Properties, plus:
                    * **Column Defaults** — Standard Element Style Properties (excluding Dynamic Contrast Text and Shape).
                    * **Tile Defaults (Kanban)** — Standard Element Style Properties plus Shape (Dropdown: Rectangle or Rounded).

                * **Task List Defaults** — Standard Board Properties, plus:
                    * **Task Defaults** — Standard Element Style Properties.

                * **Document Defaults** — Standard Board Properties, plus:
                    * **Document Page Defaults** — Standard Element Style Properties.

            * **Themes** (stored in `.filo/themes/`)
                * **Default Themes** — Themes are collections of default style values that restyle the entire tool. Applying a theme overwrites the values in `.filo/defaults.json` and `.filo/appearance.json`, making those values the new Global Defaults. There are 5 built-in themes: Light Mode, Dark Mode, Blueprint, Retro and Nature. Each theme file is a JSON object containing the full set of default values for all board types plus appearance settings (see `.filo/themes/` in Vault Configuration).
                * **Custom Themes** — Lists custom themes the user has created.
                * **Save Current Settings as Theme** — Saves the current Global Defaults as a new named theme JSON file in `.filo/themes/`.

        * **Current Board Settings** — Per-board overrides that apply only to the active board. Stored in the `settings` object within the board's `.board.json` file. These override Global Defaults for the current board only. Accessed via Settings > Current Board tab, or via a "Board Settings" button in each board's side toolbar. The available options mirror the Global Defaults for the active board's type:

            * **Mind Map Board Settings** — Board Background Colour, Board Background Pattern, Semantic Zoom (Toggle), Dynamic Contrast Text (Toggle), and all Tile/Connection/Frame default overrides.
            * **Kanban Board Settings** — Board Background Colour, Accent Colour, Dynamic Contrast Text (Toggle), and all Column/Tile default overrides.
            * **Task List Board Settings** — Board Background Colour, Accent Colour, Dynamic Contrast Text (Toggle), and all Task default overrides.
            * **Document Board Settings** — Board Background Colour, Accent Colour, Dynamic Contrast Text (Toggle), and all Document Page default overrides.

    * **Help (Button)** — See Help button below for full description.

* **Global Undo (Button / Ctrl+Z)** — Undoes the last action on the active board. The undo history is scoped per-board — each board maintains its own independent undo stack. In split-pane mode, undo applies to whichever pane the user is actively editing. Tracked actions vary by board type but broadly cover: element creation/deletion, moves and resizes, text content changes (integrated with TipTap's built-in undo), style changes, and board-level setting changes. This button is faded if there is no undo action available.

* **Global Redo (Button / Ctrl+Y)** — Redoes the last undone action on the active board. Uses the same per-board redo stack. This button is faded if there is no redo action available.

* **Search, Find and Replace (Button / Ctrl+Shift+F)** — Opens a floating Search panel in the top-left of the workspace. The panel is draggable so the user can reposition it; closing returns focus to the previously focused element. The find box accepts a query; toggling Replace mode reveals a second box and the Replace / Replace All actions. Supports search operators (combinable; AND-joined):
    * `tag:#tagname` — Search by frontmatter tag (leading `#` is optional)
    * `board:boardname` — Restrict to a single board (case-insensitive, quoted strings preserve spaces)
    * `has:connections` — Tiles with at least one connection on either end
    * `property:status=active` — Search by frontmatter property value (case-insensitive key, array values match if any element equals)
    * `type:image` — Search by tile type (`text|image|video|audio|file|link|iframe|timer`)
    * Regex support with `/pattern/` or `/pattern/flags` syntax (the global flag is added automatically; user flags are preserved)
    * Find / Find All buttons sit next to the find box. **Find** cycles through matches in order — board name → tile title → match offset — and highlights the active tile via the existing `navigateToTile` flow (board switch, viewport centre, 2 s highlight pulse). **Find All** opens a popup listing every match with its tile title, owning board, tags, and a snippet; click-to-jump.
    * **Replace** (single match) and **Replace All** sit next to the replace box. Replace All is **atomic in its pre-flight phase**: if any candidate file fails to read, no writes occur. Once writes begin, per-write failures are surfaced via toast but already-committed writes remain on disk (the filesystem can't be atomically rolled back across files). Both Replace and Replace All push a `ReplaceAllCommand` so Ctrl+Z restores every modified file from in-memory snapshots — the command implements `hasFileSnapshots()` so a history truncation that drops it escalates the standard "earlier actions are no longer reversible" toast to the stronger "deleted/replaced file content older than this point cannot be restored" form.
    * **Replace scope:** body matches only. Title-only matches surface in Find / Find All but are skipped by Replace because renaming a tile title also has implications for the backing file rename — that's the `renameTitleCommand` flow, not Replace.
    * **Match cap:** the engine returns at most 5 000 matches; a truncation indicator surfaces in the panel header so the user knows to refine the query.
    * **Hotkeys inside the panel:** Enter / F3 cycles to the next match, Shift+Enter to the previous; Escape closes the panel; Ctrl+Shift+F opens or closes from anywhere in the app (including inside a TipTap editor).
    * **Search indexing:** Structured queries (tags, properties, tile type) walk the live board cache + VaultIndex frontmatter directly. Full-text and regex queries scan `FileMetadata.content` from the VaultIndex (built on vault open, updated incrementally on file change events). Tile titles are searched alongside body content so non-text tiles (image, link, iframe, etc.) participate in the result set even though they have no backing file body.

* **Text Formatting** — Allows the user to format their text. Here is the list of text formatting that needs to be added and what order it needs to be in:

* **Font Selection** — Changes the typeface of selected text (dropdown menu showing the current font). All text defaults to the global font set in Settings > General > Global Font. The font dropdown in the toolbar allows users to override the font for a specific text selection only — unselected text remains in the global font. Per-selection font overrides are stored as inline TipTap marks in the document.

* **Font size** — Decreases or increases the text size (a minus sign, a number, and a plus sign).

* **Bold** — Makes text thicker (a bold B).

* **Italic** — Slants text to the right (an italicized I).

* **Underline** — Draws a line under the text (an underlined U).

* **Text color** — Changes the color of the text (an 'A' with a thick line underneath).

* **Highlight color** — Applies a background color behind the text (a marker icon).

* **Styles** — Applies pre-set formatting like Title, Subtitle, and Headings (dropdown menu usually showing "Normal text").

* **Spelling and grammar check** — Uses Electron's built-in spellchecker (backed by the OS-level spellcheck service) to underline misspelled words and offer corrections. No third-party library required — Electron exposes this via the `webFrame.setSpellCheckProvider` API and context menu suggestions (an 'A' with a checkmark).

* **Insert link** — Turns text into a clickable hyperlink (a chain link icon).

* **Align** — Changes the horizontal placement of text (Left, Center, Right, or Justify). Depending on your layout, this is either a dropdown or four separate icons showing horizontal lines.

* **Line & paragraph spacing** — Adjusts the vertical space between lines of text and paragraphs (horizontal lines with a vertical double-arrow).

* **Bulleted list** — Creates an unordered list using bullet points (dots next to horizontal lines).

* **Numbered list** — Creates an ordered list using numbers (numbers next to horizontal lines).

* **Decrease indent** — Moves the paragraph closer to the left margin (horizontal lines with a left-pointing arrow).

* **Increase indent** — Moves the paragraph further from the left margin (horizontal lines with a right-pointing arrow).

* **Clear formatting** — Removes all bold, italic, font, and size adjustments, returning the text to the default style (a 'T' with a diagonal slash through it).

### Side Toolbar — Mind Map

* **+ New Tile (Button)** — Prompts the user to select what tile type they'd like to create out of the following options: Text, Audio, Link, Iframe (Embed), Timer. Creates a new tile on the board. This uses the tile defaults setup in Filo Settings. Image, Video, and File tiles cannot be created via this button — they are created exclusively by dragging and dropping a file from the user's computer onto the canvas (see **Drag-and-Drop File Import** in General Features).

* **Connections Mode (Button)** — Toggles connections mode on and off.

* **Manage Tiles (Dropdown)**
    * **Snap Tiles (Toggle)** — Snaps tiles on a grid so that they can be aligned easily.
    * **Group/Ungroup Tiles** — Groups tiles together so that they can be moved all at once without having to select the tiles each time.
    * **Fade/Unfade** — Lowers selected tiles, connection paths and connection labels opacity.
    * **Align Left** — Aligns all selected tiles to the left most selected tile.
    * **Align Right** — Aligns all selected tiles to the right most selected tile.
    * **Align Top** — Aligns all selected tiles to the top most selected tile.
    * **Align Bottom** — Aligns all selected tiles to the bottom most selected tile.
    * **Align Tree (Horizontal)** — Moves all tiles in order of their connections, any tiles with connections going from the bottom bubbles of their tile will be above tiles with connections on their top bubbles in a tree-like structure. There needs to be a fixed distance between these tiles.
    * **Align Tree (Vertical)** — Moves all tiles in order of their connections, any tiles with connections going from the right bubbles of their tile will be on the left of tiles with connections on their left bubbles in a tree-like structure. There needs to be a fixed distance between these tiles.
    * **Align Radial** — Moves all tiles in order of their connections, the tile with the most connections on its bubbles will be in the centre, with each tile being moved around it corresponding to the location of the connection on the main tile. There needs to be a fixed distance between these tiles.

* **View (Dropdown)** — The View dropdown provides access to board management features. The Tags Browser is shared across all board-type side toolbars. Mind Map boards include additional toggle items specific to the canvas.
    * **Tags Browser (Button)** — Opens Tag Browser pop-up window. Where the user can see all the tags they have created and how many tiles have each tag. The user can also fade tiles of associated tags, rename, change the colour of tags or delete tags from here. Tags are sourced from both inline `#tags` and frontmatter properties.
    * **Hide All Connection Paths (Toggle)** — Hides all connection paths by switching their opacity to 0. *(Mind Map only)*
    * **Hide All Connection Labels (Toggle)** — Hides all connection labels by switching their opacity to 0. *(Mind Map only)*
    * **Hide Waypoints (Toggle)** — Hides all waypoints by switching their opacity to 0. *(Mind Map only)*
    * **Orphan Catcher (Button)** — Highlights all orphaned tiles on the canvas: tiles that have no connections, no tags, and are physically far from any tile cluster, as well as completely empty tiles. Highlighted tiles are visually marked (e.g., pulsing border or distinct overlay colour) and listed in a popup panel. From the panel the user can select individual tiles to navigate to, bulk-select, or delete them. Useful for cleaning up abandoned thoughts on large boards. *(Mind Map only)*

* **Toggle Minimap (Button)**
    * Mini-Map — when toggled on a mini-map displays in the bottom right of the board it can be used to navigate quickly around the board.
    * Waypoints — On massive boards, panning around gets tedious. Allow users to right-click a spot on the canvas or a specific Tile and select "Save as Waypoint." These waypoints appear as a list next to the Minimap, allowing the user to instantly snap the camera to that specific area.

* **Help (Button)**
    * About — Lists core concept definitions.
    * Shortcuts — Lists all Shortcuts available in the tool.

### Side Toolbar — Kanban

* **+ New Column (Button)** — Creates a new column at the end of the board. The user is prompted to name the column.
* **+ New Tile (Button)** — Creates a new tile in the currently selected column (or the first column if none is selected). Prompts the user to select tile type: Text, Audio, Link. Image and File tiles are created by drag-and-drop only. Text tiles are backed by a new `.md` file in the vault.
* **Manage Columns (Dropdown)**
    * **Reorder Columns** — Opens a drag-and-drop reorder interface for columns, with per-column width overrides.
    * **Collapse All Columns** — Collapses all columns to show only headers.
    * **Expand All Columns** — Expands all collapsed columns.
* **View (Dropdown)** — Shared View dropdown (Tags Browser). See Mind Map Side Toolbar > View for full description.
* **Filter (Dropdown)**
    * **Filter by Tag** — Shows only tiles matching selected tags. Tag list is searchable for vaults with many tags. Active filters render as removable chips with a "Clear all" button.
    * **Filter by Property** — Shows only tiles matching a frontmatter property value (key + value text fields, debounced on each keystroke).
* **Sort (Dropdown)**
    * **Sort Tiles By** — Sorts tiles within each column by manual, title, date created, due date, or priority. Switching off manual sort surfaces an info toast on next within-column drag so the user knows the drag order was saved but is hidden by the active sort.
* **Saved Views (Dropdown)** — Named snapshots of the current sort + filter state, applied or deleted from the list. Same-name saves replace the existing view. Stored on `board.settings.savedViews`.

The side toolbar is draggable — pointer-drag the toolbar background to reposition; right-click the background to reset to the docked position. Position persists in `.filo/app.json` per vault.

### Kanban Board — Implemented Extras

Capabilities present in the V7 build that aren't part of the original V5 spec but ship as canonical Kanban features:

* **WIP Limits per column** — Optional integer cap on the number of cards in a column. When exceeded the column header tints red and the count badge shows `N/M`. Set via the column "…" menu → "Set WIP Limit…"; cleared by entering 0 or blank. Persisted on `column.wipLimit`. Optimistic preview: while the popover is open, the column border previews based on the typed draft.
* **Per-column width override** — Width in px settable from the Manage Columns modal. `null` inherits the cascade (board defaults → global defaults → KANBAN_COLUMN_DEFAULTS.width). Stored on `column.style.width`.
* **Cover image (placement-level)** — Text cards expose an "Add cover image" affordance that copies an image into the vault and stamps the relative path onto the placement's `coverImage`. Lives on the placement (not the tile def) so the same `.md` can appear on multiple boards with independent cover art. Path is sanitised (rejects absolute, traversal, and URL-scheme inputs).
* **Find bar** — `/` opens an in-board search that filters visible placements across all columns by title, tag, and body text. Search query is treated as an additional filter alongside the toolbar Filter/Sort state.
* **Bulk multi-select** — Ctrl-click / Shift-click selects multiple cards. The bulk context menu offers Move to Column, Add Tag, and Delete with confirmation. Selection clears on Escape or board click.
* **Last view restored** — Filter chips + sort mode survive tab switch and vault reload (persisted to `board.settings.lastView`). Saved Views are still available for named snapshots; lastView is the "where I was when I closed the tab" memory.
* **Keyboard shortcuts** — `n` opens the Add Tile picker for the current column; `Shift+N` adds a new column. `/` opens the find bar. Both `n`/`Shift+N` are user-rebindable via Keyboard Shortcuts settings (commandIds `kanban:add-tile` and `kanban:add-column`).
* **Open as Document** — Right-click a text card → "Open as Document" opens the backing `.md` in a Document tab. Also wired to double-click the card body.
* **A11y** — Column reorder via **Alt+ArrowLeft / Alt+ArrowRight** with the column title focused. Toolbar and column menus have arrow-key navigation, `aria-haspopup="menu"`, and `role="menuitem"` on items. Modals (Add Tile picker, Manage Columns) trap focus.

### Side Toolbar — Task List

* **+ New Task (Button)** — Creates a new task at the end of the list. The task is backed by a new `.md` file in the vault.
* **Group By (Dropdown)** — Changes how tasks are grouped: by status, priority, tag, due date, or none.
* **Sort By (Dropdown)** — Changes task sort order: by title, date created, due date, priority, or manual.
* **Filter (Dropdown)**
    * **Filter by Tag** — Shows only tasks matching selected tags.
    * **Filter by Status** — Shows only tasks with a specific status (e.g., open, in progress, complete).
    * **Filter by Priority** — Shows only tasks with a specific priority level.
    * **Show Completed (Toggle)** — Toggles visibility of completed tasks.
* **View (Dropdown)** — Shared View dropdown (Tags Browser). See Mind Map Side Toolbar > View for full description.

### Side Toolbar — Document
There is no side toolbar for the document board. The document board uses the global toolbar for all its functionality.

## Vault Sidebar

The Vault Sidebar displays the contents of the current vault as a file and folder tree. It allows the user to browse, organise, and manage all files and boards in the vault.

* **Search** — Allows the user to search for a specific file or folder within the vault.
* **New Folder** — Creates a new folder in the vault.
* **Change sort order** — Changes the sort order of the files and folders in the vault. Options are:
    * Alphabetical
    * Reverse Alphabetical
    * Newest
    * Oldest
* **Collapse All** — Collapses all folders and subfolders in the vault.
* **Expand All** — Expands all folders and subfolders in the vault.

## Boards

* **Mind Map** — An "infinite" canvas that the user can navigate by clicking and dragging their mouse. The user can also zoom in and out of the board by scrolling on their mouse wheel. The user can make selections by holding Ctrl and clicking on tiles or by dragging a selection box around tiles.
* **Kanban** — A column-based board for managing workflows. The board displays a horizontal row of columns (e.g., Backlog, In Progress, Review, Done). Each column contains vertically stacked tiles that can be dragged between columns. Kanban boards support Text, Audio, Image, File, and Link tile types. Users can add, rename, reorder, and delete columns. Text tiles display their title, tags, and a content preview. Tiles can be opened as a Document board for full editing.
* **Task List** — A structured list view for tracking tasks. Unlike Mind Map and Kanban boards, the Task List does not use the spatial tile UI — tasks are displayed as flat rows in a list. Each task row shows a checkbox, title, tags, due date, and priority. Tasks can be grouped by frontmatter properties (status, priority, category) and sorted by any property or date. Clicking a task opens it as a Document board for full Markdown editing. Tasks are backed by `.md` files with metadata stored in YAML frontmatter.
* **Document** — The Document board is a maximised view of a single `.md` file using the same Tiptap editor as text tiles. It provides a distraction-free writing environment with the full formatting toolbar and seperates text with a purely visual page layout. See the **Text Tile / Document Board Relationship** section in the Data Model.

### Tiles

Tiles are the main way that the user interacts with the tool. Tiles can be created via the "+ New Tile" button in the Board Specific Side Toolbar or by dragging and dropping a file from the user's computer onto the canvas. Tiles have a Tile Header and a Tile Body. Tiles have a minimum size based on the size of the tile title and header buttons; there is no maximum size. When content exceeds the tile body's visible area, a vertical scrollbar appears on the right side of the tile. The user can also manually resize the tile larger to fit the content. The Tile Header contains:

* Tile Title (Text)
* Tags (Button)
* Properties (Menu Pop-up)
* Tile Lock (Button)
* Tile Style (Menu Pop-up)
* Expand to Document (Button(Text Tile Exclusive))
* Delete Tile (Button)

* **Tile Title** — The Tile Title is a text field that can be edited by the user. It is located in the top left corner of the tile header. The Tile Title can be edited with the Toolbar's text formatting options. It is what the tile will be called within the vault. The default tile title is "New Tile" it iterates by a one if the user creates multiple tiles without renaming them. Renaming a tile triggers the Vault API to update all board JSON file references pointing to it.

* **Tags (Button)** — When the tags button is clicked by the user it opens a pop-up with a text field where the user can input the tags they want a tile to have this is comma separated. Tags are written to the tile's frontmatter properties. When submitted tags are put in the bottom left corner of a tile, they can be clicked which opens the **Tag Context Menu**.
    * **Tag Context Menu** — Clicking a tag displayed on a tile opens a contextual menu showing all other tiles that share that tag. The menu lists each tile's Title, Board Name, and all tags on that tile. Clicking an entry navigates directly to that tile. This is a lightweight, contextual version of the full Tags Browser (accessible from the Side Toolbar's View dropdown), which offers additional management features such as renaming, recolouring, fading, and deleting tags across the entire vault.

* **Properties (Menu Pop-up)** — Opens a form view for editing the tile's YAML frontmatter. Shows all properties with type-appropriate inputs (text, date picker, tag selector, dropdown for status, etc.). Users can add custom properties, remove existing ones, and see all metadata at a glance. Changes are written directly to the tile's `.md` file frontmatter. For non-text tile types without a Markdown file, properties are stored in the board JSON's tile entry under a `metadata` object.

* **Tile Lock (Button)** — This button locks the tile in place on the board. When a tile is locked it cannot be moved or resized. It can be unlocked by clicking the button again.

* **Tile Style (Menu Pop-up)** — Per-tile style overrides using the Standard Element Style Properties (see Defaults in Settings) plus Shape (Dropdown: Rectangle or Rounded). Per-tile values override both Current Board Settings and Global Defaults (see override cascade in Settings).

* **Expand to Document (Button(Text Tile Exclusive))** — Opens the tile's backing `.md` file as a full-page Document board in a new tab. See the **Text Tile / Document Board Relationship** section in the Data Model.

* **Delete Tile (Button)** — Removes the tile from the current board. See **File Deletion Handling** in Architecture for how deletions propagate.

* **Basic Tile Types** — Created by drag-and-drop only (cannot be created via the "+ New Tile" button). See **Data Model > Tile Storage** for file storage details.
    * **Image** — Displays an uploaded image within the tile. The user can remove the media.
    * **Video** — Plays back an uploaded video within the tile. The user can remove the media.
    * **File** — Displays/previews an uploaded file within the tile (`.pdf`, `.docx`, `.zip`, etc.). The user can remove the media.

* **Advanced Tile Types** — Created via the "+ New Tile" button or board-specific creation workflows. See **Data Model > Tile Storage** for file storage details.
    * **Text** — A rich Markdown editor (TipTap/ProseMirror). Supports `#tags` and standard hyperlinks.
    * **Audio** — Can be created both via the "+ New Tile" button (which opens a blank recorder) and by dragging an existing audio file onto the canvas (which creates a playback tile). Provides record, play/pause, and volume controls. The user can record a new audio clip or replace an existing one.
    * **Link** — Accepts a pasted URL displayed as a clickable link. Filo attempts to fetch a preview (page title, favicon, description) at display time. The user can edit or remove the URL.
    * **Iframe (Embed)** — Accepts a pasted URL rendered inside an `<iframe>`. Useful for embedding YouTube videos, Google Maps, Figma files, or any embeddable web page. The user can edit or remove the URL.
    * **Timer** — A simple timer with play/pause, reset, and change mode buttons. Four modes: Hours Minutes Seconds, Minutes Seconds, Seconds, Clock. The clock mode uses the user's system time.

### Connections

* **Connections Mode** — Whilst the user is in connections mode all tiles have 8 bubbles around them, one on each corner and one half way up each side. The user can then draw a connection between 2 tiles at which point a connection path is generated between the 2 tiles with a connection label. Whilst the user is in connections mode all connection paths and connection labels are visible, they also have an eye icon next to them so that you can toggle their visibility individually. There are 4 visibility types, visible, visible locked, not visible and not visible locked. If a Connection path or label is toggled off in connections mode they become faded within connections mode and not visible to the user when they exit out of connections mode.

    * **Bubble Index Layout** — Each tile has 8 connection points (bubbles) indexed 0–7 arranged clockwise from the top-left corner:
        ```
          0 ── 1 ── 2
          │         │
          7         3
          │         │
          6 ── 5 ── 4
        ```
        * 0 = top-left, 1 = top-centre, 2 = top-right
        * 3 = middle-right
        * 4 = bottom-right, 5 = bottom-centre, 6 = bottom-left
        * 7 = middle-left

        Connection endpoints in the board JSON reference these numeric indices via `from.bubble` and `to.bubble` fields.

    * **Connection Paths** — Connection paths are visual lines drawn between two tiles. There are 4 different types of connection paths (Curved, Straight, Elbow, Smart).
        * Curved — A curved line between two tiles. It finds the shortest path between 2 tiles and does not route around tiles.
        * Straight — A straight line between two tiles. It finds the shortest path between 2 tiles and does not route around tiles.
        * Elbow — An elbow-shaped (right-angle) line between two tiles. It finds the shortest path between 2 tiles and does not route around tiles.
        * Smart — A line between two tiles that uses smart routing to mathematically find the shortest path between 2 tiles while routing around any tiles that are in its way, instead of going underneath them.

    * **Connection Labels** — Connections Labels selectable objects that looks very similar to a tile when they are opened — when they are not opened they simply display their label within its container. Connection labels stick to their connection path, they can move along the path and they also move with the path when the connected tiles are moved.

        * **Connection Style (Button)** — Per-connection style overrides matching the Connection Path Defaults and Connection Label Defaults (see Defaults in Settings). Per-connection values override the defaults. Includes Path Styling (colour, arrow colour, path type, path style, arrow type) and Label Styling (font size, text colour, background colour).

        * **Connection Label Lock (Button)** — This button locks the label in place on the connection path.
        * **Connection Deletion (Button)** — Deletes the connection path and connection label.

### Frames

Frames are selectable objects that can be placed on a board, they are used to group tiles together. Frames have a header and a body, the header is where the user can input the frame title and the body is where the user can add tiles to the frame. The user can add tiles to a frame by dragging and dropping them into the frame. The user can remove tiles from a frame by dragging and dropping them out of the frame. Frames can also be moved around the board by dragging and dropping them everything in the frame moves with it. Frames can also be resized by dragging and dropping the corners of the frame.

* **Frame Collapse** — The collapse button collapses the frame, hiding the body of the frame and resizing it to only show the header. All of the tiles within the frame are also hidden when the frame is collapsed.
* **Frame Title** — The title of the frame, the user can edit this by clicking on it and typing in the new title.
* **Frame Style** — Per-frame style overrides matching the Frame Defaults (see Defaults in Settings). Includes Standard Element Style Properties plus Frame Background Image and Frame Background Opacity.
* **Frame Delete** — The delete button deletes the frame. Tiles are not deleted and stay in place where they were.

### Templates

Templates capture reusable structure that can be inserted into the current board. Filo supports two kinds of template, both surfaced through the same Template Browser.

* **Layout Templates** — Capture the *structure* of a selection of Mind Map tiles: each tile's type, size, position (relative to the selection's bounding box), and full style settings. They deliberately do **not** capture content: titles, body content, tags, lock state, file references (`src` / `url` / `filePath`), and the contents of any backing `.md` file are all stripped. Layout templates persist as `.template.json` files inside `<vault>/.filo/templates/`.
    * **Save as Template** — Right-click a tile or multi-tile selection on the Mind Map and choose **Save as Template**. Filo prompts for a name (uniqueness-checked) and saves the layout. Type-specific configuration that isn't content — for example a Timer tile's `duration` and `mode` — is preserved.
    * **Insert** — Right-click empty canvas and choose **Insert Template**, or press **Ctrl+T**, to open the Template Browser. Inserting a layout template re-creates the structure with fresh tiles: every tile gets a new id, Text tiles get a fresh `contentId` and a new empty `.md` file named via the normal tile-naming sequence, and the whole batch lands as a single undo step. When invoked from the canvas right-click, the layout anchors to the click position; when invoked via Ctrl+T, it lands centred in the viewport.
* **Markdown Templates** — Plain Markdown files in a configurable vault folder (default `Templates/`) with `{{title}}`, `{{date}}`, `{{time}}`, `{{datetime}}`, `{{year}}`, `{{month}}`, `{{day}}` variable substitution. A Markdown template may also embed a fenced ```` ```filo-board ```` block carrying a `.board.json` skeleton; instantiating such a template creates an entirely new board.
* **Template Browser (Ctrl+T)** — Unified picker with two sections. The **Layout Templates** section is a grid of cards showing an SVG mini-preview of each layout (rectangles coloured to match each tile's style), along with rename and delete actions. The **Markdown Templates** section lists `.md` templates from the vault. A single search input filters both sections.

### Tabs

Tabs are used to organize the user's boards. Each tab represents a different board. When the user clicks the "+ New Tab" button in the tab bar they are prompted to select the board type they would like to create and the name of the board.

* **Tab Bar** — The tab bar is located at the bottom of the screen and is permanently visible. If all tabs are closed the tool defaults to blank screen with a message in the centre that says "Open a Tab to get started". The tab bar displays all the tabs that are currently open and can be used to switch between tabs. Users can double click on the tab name to rename the tab, tabs can be closed by clicking a small "x" next to their name. Closing a tab does not delete it.

* **Split Panes** — Users can drag a tab to the left or right edge of the workspace to create a side-by-side split view. This allows referencing one board while working on another, or dragging tiles between boards. Splits can be horizontal or vertical and are resizable. A maximum of 3 panes can be open simultaneously. The same board can be opened in multiple panes. Undo/redo applies to whichever pane the user is actively editing — each pane targets its board's independent undo stack. If a board displayed in a split pane is deleted from the Vault Sidebar, that pane is automatically closed. Split layout state is persisted in `.filo/workspace.json` and restored on next launch.

* **Board Browser** — The board browser is a button that opens a pop-up menu from which the user can view all of their boards. It is located in the bottom left corner of the screen and in line with the Tab Bar. The Board Browser is a list of all the boards that currently exist in the user's vault. From this list the user can open a new tab for a board, rename boards, create new board and delete boards. The user can also drag and drop boards to re-organize them in the browser, they can also CTRL + Click to select multiple boards. There is a search bar at the top of the board browser that allows the user to search for boards by name, the board browser also has a scroll bar if the user has more boards than can fit in the browser window. The Board Type is listed next to the name of the board in the browser.

## General Features

* **Edge-Panning** — When a user is dragging a tile or drawing a connection line and their mouse hits the edge of the screen, the canvas should automatically begin panning in that direction. This is crucial for infinite canvases so users don't have to drop the tile, manually pan, and pick it up again.
* **Viewpoint Rendering** — The canvas viewport uses GPU-accelerated `transform` for smooth panning and zooming. Only tiles within the visible viewport are rendered (powered by the rbush spatial index) to maintain performance on large boards.
* **Zooming** — The user should be able to zoom in and out of the canvas using the mouse wheel or pinch-to-zoom on touch devices. The zoom should be centered on the mouse position. Maximum zoom should be 300% and minimum zoom should be 10%.
* **Semantic Zoom (LOD — Level of Detail)** — When zoomed out past 50%, hide the body text and media completely, replacing the tile with just a solid colored block and a bold Title. This massively improves performance and provides a clean "birds-eye" view. This feature is toggleable on and off in Board Settings.
* **Panning** — The user should be able to pan horizontally if they are using a mouse wheel with wheel tilt. The pan should be centered on the mouse position.
* **Canvas "Radar" for Active Media** — If a user has a massive board, they might start a Video Tile or Timer Tile, pan away, and forget where it is. The Mini-Map should have glowing "Radar" pips indicating the location of currently playing audio/video or running timers. This feature is toggleable on and off in Board Settings.
* **Drag-and-Drop File Import** — If a user drags an image, audio file, video file, or other supported file from their computer desktop directly onto the canvas, Filo should intercept the drop event, calculate the mouse coordinates on the canvas, and instantly generate the corresponding Tile (Image, Audio, Video, File) at that exact location.
* **Escape Key** — The escape key should be used to exit the current mode or action. For example, if the user is in connections mode, the escape key should exit connections mode. If the user has any of the pop-up menus open the escape key should close them.
* **File Reference Integrity** — Handled by the Vault API (see Architecture > Data Layer). Renames propagate automatically; broken references are flagged on board load. When a referenced file disappears outside Filo (deleted, or moved by a sync client), its tiles are kept and shown as missing; removing them from every board is a separate, explicitly confirmed action that lists the affected boards.
* **Dynamic Contrast Text** — When enabled, Filo automatically calculates the perceived brightness of a tile's (or column's, task's, event's) background colour using relative luminance and swaps the text colour to white (for dark backgrounds) or black (for light backgrounds). This ensures WCAG AA contrast compliance without manual intervention. The setting is toggleable at three levels following the override cascade: Global Defaults, Current Board Settings, and per-element Tile Style popup. Defaults to on.
* **Smart Guides** — When the user drags a tile on the Mind Map canvas, real-time visual alignment guides appear showing when the tile's edges or centre align with other tiles' edges or centres. Guide lines are rendered as thin coloured lines spanning the relevant axis. When a tile is within a configurable snap distance (default: 8px at current zoom) of an alignment, it snaps to the guide position. Smart guides make it easy to create visually tidy layouts without enabling snap-to-grid. *(Mind Map only)*
* **Orphan Catcher / Canvas Cleanup** — See Side Toolbar — Mind Map > Orphan Catcher for full description. Also accessible from the canvas right-click menu. *(Mind Map only)*
* **Toast Notifications** — Non-blocking notification messages used for confirmations (save, export), errors, and user prompts (e.g., external edit conflicts). Toasts display at the top centre of the board workspace, directly below the Global Toolbar. They auto-dismiss after a few seconds unless they require user action. A conflict prompt that is not blocking a save (e.g. "Reload from disk" / "Keep local" on an open note) is sticky: it stays until the user acts, and a newer prompt for the same file replaces the older one. A prompt that is blocking a pending save auto-dismisses after 15 seconds and defers that save (nothing is written; it re-prompts on the next save). Toasts stack vertically in a column — newer toasts appear below existing ones. A maximum of 8 toasts are visible at once; if the limit is reached, the oldest plain notification is dismissed first. See the **Animations** section for entrance/exit transitions.

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| Ctrl + N | New Tile |
| Ctrl + T | Insert Template |
| Ctrl + Z | Undo |
| Ctrl + Y | Redo |
| Ctrl + G | Group/Ungroup |
| Ctrl + K | Insert Link |
| Ctrl + Shift + F | Vault-wide Search |
| Ctrl + Shift + Arrow | Add/Select Neighbour |
| Shift + Drag | Area Selection |
| Delete | Remove Selected |
| Escape | Cancel Action |
| Alt + Click | Open in Split Pane |

All keyboard shortcuts are customisable via `.filo/hotkeys.json` or the Settings UI.

## Animations

All animations use CSS keyframes and CSS transitions. Animations prioritize GPU-accelerated properties (`transform`, `opacity`) for smooth 60fps performance.

### Transition Timing Standards

| Category | Duration | Easing | Examples |
|---|---|---|---|
| Micro-interactions | 0.1s–0.15s | ease | Button hover, color changes, opacity shifts |
| Panel transitions | 0.15s–0.2s | ease | Sidebar open/close, dropdown expand, tab switch |
| Canvas elements | 0.2s | ease | Connection path hover, frame selection, tile elevation |
| Entrance animations | 0.15s–0.3s | ease-out | Modal appear, toast slide-in, popup scale-in |

### Keyframe Animations

#### Toast Notifications (`toast-in`)
- **Duration:** 0.3s ease-out
- **Effect:** Opacity 0→1 + translateY(16px→0)
- **Trigger:** When a toast message appears (save confirmation, error, etc.)

#### Search Match Pulse (`pulse`)
- **Duration:** 1s infinite
- **Effect:** Scale 1→1.02→1
- **Trigger:** Applied to tiles matching the current search query

#### Radar Pulse (`radar-pulse`)
- **Duration:** 1.5s infinite ease-in-out
- **Effect:** Scale 1→1.15 with drop-shadow glow
- **Trigger:** Minimap indicators for active media (playing video, running timer)

#### Minimap Active Pip (`mm-pulse-anim`)
- **Duration:** 1.5s infinite ease-out
- **Effect:** Scale 1→3 with opacity 1→0 (expanding ripple)
- **Trigger:** Active media location pips on the minimap

#### Audio Recording Indicator (`pulse-red`)
- **Duration:** 1.5s infinite
- **Effect:** Scale pulse + expanding red box-shadow ripple
- **Trigger:** While audio is being recorded in an Audio Tile

#### Modal/Panel Entry (`fadeIn` + `slideUp`/`slideDown`)
- **Duration:** fadeIn 0.12–0.15s ease, slide 0.15–0.2s ease
- **Effect:** Opacity fade combined with vertical translate
- **Trigger:** Opening modals (keyboard shortcuts, search panel, tab browser)

#### Popup Scale Entry (`popIn`)
- **Duration:** 0.15s ease
- **Effect:** Scale 0.95→1 + opacity 0→1
- **Trigger:** Small popup menus (emoji picker, color picker, style menus)

### Hover & Interaction Transitions

| Element | Property | Duration | Effect |
|---|---|---|---|
| Buttons | background-color | 0.15s | Subtle background shift on hover |
| Tiles | box-shadow | 0.2s | Elevated shadow on hover |
| Connection paths | stroke-width, stroke | 0.2s | Thicker/brighter stroke on hover |
| Connection labels | opacity, transform | 0.2s | Fade-in tools on selection |
| Tabs | border-color, background | 0.15s | Active state highlight |
| Frames | box-shadow, height | 0.2s | Selection glow, collapse animation |
| Menu items | background-color | 0.1s | Hover highlight |
| Color picker handles | transform | 0.1s | Crosshair/slider position |

### Canvas Interactions (No Animation Delay)

| Interaction | Behaviour |
|---|---|
| Zoom | Smooth `transform: scale()` centered on cursor position |
| Pan | `transform: translate()` with `cursor: grab`/`grabbing` |
| Tile drag | Real-time position update — no transition delay |
| Selection box | Instant render following mouse coordinates |
| Snap-to-grid | Immediate snap — no easing or spring effect |
| Edge-panning | Canvas begins scrolling when drag reaches screen edge |

### Accessibility & Performance Rules

1. **`prefers-reduced-motion: reduce`** — Disable all keyframe animations and reduce transitions to 0.01s. Canvas operations remain unaffected.
2. **GPU acceleration only** — Animate `transform` and `opacity` exclusively. Never animate `width`, `height`, `top`, `left`, `margin`, or `padding`.
3. **`will-change` usage** — Apply sparingly to elements that will animate (tiles during drag, modals on open). Remove after animation completes.
4. **Infinite animations** — Only used for status indicators (recording, radar). Never for decorative purposes.
5. **No animation on initial page load** — All content renders immediately without entrance animations on app start.

## Context Menu

A custom-built context menu component replaces the browser/Electron default right-click menu. The menu is contextual — its items change based on what the user right-clicked on.

### Trigger Behaviour

- **Activation:** Right-click (or Ctrl+Click on Mac) on canvas, tiles, frames, connections, or tabs
- **Positioning:** Fixed position at mouse cursor coordinates, clamped to viewport edges
- **Dismissal:** Click outside the menu, press Escape, or select an item
- **Prevention:** The native browser/Electron context menu is suppressed via `e.preventDefault()`

### Menu Items — Mind Map Board (Canvas)

Right-clicking on the **canvas background** (no element selected):

| Item | Icon | Shortcut | Action |
|---|---|---|---|
| New Tile | `icon-plus` | Ctrl+N | Creates a default text tile at the right-click position |
| Insert Template | `icon-file-text` | Ctrl+T | Opens the Template Browser; the layout anchors to the right-click position |
| Save as Waypoint | `icon-map-pin` | — | Saves the current canvas position as a named waypoint |
| ─── | Divider | | |
| Select All | `icon-select-all` | Ctrl+A | Selects all tiles on the board |
| Orphan Catcher | `icon-search` | — | Highlights orphaned and empty tiles for review and cleanup |

### Menu Items — Mind Map Board (Tile Selected)

Right-clicking on a **tile** (or with tiles selected):

| Item | Icon | Shortcut | Action |
|---|---|---|---|
| Style | `icon-palette` | — | Opens the tile style popup (colours, shape, border) |
| Tags | `icon-tag` | — | Opens the tag editor for the selected tile |
| Properties | `icon-settings` | — | Opens the Properties editor for the tile's frontmatter |
| ─── | Divider | | |
| Save as Template | `icon-bookmark` | — | Saves the current selection as a Layout Template (captures type, size, position, style — strips content, tags, lock, and file references) |
| Lock / Unlock | `icon-lock` | — | Toggles tile position lock (text changes dynamically) |
| ─── | Divider | | |
| Delete | `icon-trash` | Delete | Removes the tile from the board (styled in red as danger action) |

### Menu Items — Connection Path/Label

Right-clicking on a **connection path or label**:

| Item | Icon | Action |
|---|---|---|
| Style | `icon-palette` | Opens connection style popup (colour, type, arrows) |
| Edit Label | `icon-edit` | Focuses the label text for editing |
| ─── | Divider | |
| Delete Connection | `icon-trash` | Removes the connection path and its label (danger action) |

### Menu Items — Frame

Right-clicking on a **frame**:

| Item | Icon | Action |
|---|---|---|
| Style | `icon-palette` | Opens frame style popup |
| Collapse / Expand | `icon-chevron-down` / `icon-chevron-right` | Toggles frame collapse state |
| ─── | Divider | |
| Select All in Frame | `icon-select-all` | Selects all tiles contained within the frame |
| Delete Frame | `icon-trash` | Removes frame only — tiles remain in place (danger action) |

### Menu Items — Kanban Board (Column)

Right-clicking on a **Kanban column header**:

| Item | Icon | Action |
|---|---|---|
| Add Tile | `icon-plus` | Creates a new tile at the top of this column |
| Rename Column | `icon-edit` | Focuses the column title for inline editing |
| Collapse / Expand | `icon-chevron-down` / `icon-chevron-right` | Toggles column collapse state |
| Set WIP Limit… | — | Opens an inline editor to cap the column at N cards (clearing the cap removes the limit) |
| ─── | Divider | |
| Delete Column | `icon-trash` | Removes column and drops its tile placements (danger action; the underlying `.md` files are preserved) |

Column reordering is performed by drag (pointer) or **Alt+ArrowLeft / Alt+ArrowRight** with the column title focused (a11y). The dedicated "Move Left / Move Right" context-menu rows present in the V5 design have been removed — the drag handle and keyboard shortcut cover both use cases.

### Menu Items — Kanban Board (Tile)

The Kanban tile right-click menu is intentionally minimal in the V7 implementation. Style, Tags, Properties, lock, and Sync-to-disk live on the tile's own TileHeader (visible on hover/focus) — duplicating them in the right-click menu would just be noise. The Mind Map context menu is richer because canvas tiles support actions (auto-layout, copy/paste, connection mode) that don't apply to a column-bound flow layout.

Right-clicking on a **text tile within a Kanban column**:

| Item | Icon | Action |
|---|---|---|
| Open as Document | `icon-expand` | Opens the tile's `.md` file as a Document board in a new tab (also wired to double-click on the card body) |
| ─── | Divider | |
| Remove from Column | `icon-trash` | Drops the placement from this column (danger action; the underlying `.md` and any other placements are preserved) |

Non-text tiles (image / audio / file / link) get a single "Remove from Column" item — they don't back to a `.md` file so "Open as Document" doesn't apply.

### Menu Items — Task List Board (Task Row)

Right-clicking on a **task row**:

| Item | Icon | Action |
|---|---|---|
| Open as Document | `icon-expand` | Opens the task's `.md` file as a Document board in a new tab |
| Tags | `icon-tag` | Opens the tag editor for the task |
| Properties | `icon-settings` | Opens the Properties editor for the task's frontmatter |
| ─── | Divider | |
| Toggle Complete | `icon-check` | Toggles the task's completed state |
| ─── | Divider | |
| Delete | `icon-trash` | Removes the task from the list (danger action) |

### Menu Items — Document Board

Right-clicking within the **Document board editor area** uses the standard TipTap/ProseMirror context menu with text editing actions (Cut, Copy, Paste, Select All) plus:

| Item | Icon | Action |
|---|---|---|
| Insert Link | `icon-link` | Opens the URL insertion dialog |
| Insert Template | `icon-file-text` | Opens the template picker (Ctrl+T) |

### Menu Items — Tab Bar

Right-clicking on a **tab**:

| Item | Icon | Action |
|---|---|---|
| Rename Board | `icon-edit` | Focuses the tab name for inline editing |
| Set Board Icon | `icon-smile` | Opens the icon picker for the tab |
| Split Right | `icon-columns` | Opens this board in a right split pane |
| Split Down | `icon-rows` | Opens this board in a bottom split pane |
| ─── | Divider | |
| Close Tab | `icon-x` | Closes the tab (does not delete the board) |
| Close Other Tabs | `icon-x-circle` | Closes all tabs except this one |

### Keyboard Navigation

| Key | Action |
|---|---|
| Arrow Up / Down | Move focus between menu items (skips dividers) |
| Enter / Space | Activate the focused menu item |
| Escape | Close the menu without action |
| Home / End | Jump to first / last menu item |

### Accessibility Requirements

- Container element: `role="menu"`
- Menu items: `role="menuitem"` with descriptive text
- Dividers: `role="separator"`
- Focus management: First item auto-focused on open, focus trapped within menu
- `aria-disabled="true"` on items that are not applicable in current context
- Screen reader announcement via `aria-live="polite"` region

### Visual Styling

| Property | Value |
|---|---|
| Background | `--ui-surface` (theme-aware) |
| Border | 1px solid `--ui-border` |
| Border-radius | 4px |
| Box-shadow | `--ui-shadow` (elevation) |
| Min-width | 180px |
| Padding | 4px 0 |
| Item padding | 8px 16px |
| Item hover | `--ui-surface-hover` background |
| Danger items | `#d32f2f` text, `#ffebee` hover background |
| Disabled items | 50% opacity, `cursor: not-allowed` |
| Z-index | 2500 (overlay), 2501 (menu) |
| Animation | `popIn` 0.1s ease (scale 0.95→1 + opacity) |

## Complete Technology Stack

* **Frontend:** Svelte 5, TypeScript, Vite
* **Backend:** Electron main process (Node.js)
* **Mobile (Out of scope for v1):** No mobile target on the v1 roadmap. The architecture leaves the door open for a future Capacitor wrapper (see Architecture > Application Shell) but no mobile code or testing exists.
* **Rich Text:** Tiptap (ProseMirror) with extensions (see Editor section)
* **Storage:** File system (vault folder on user's disk) — Node.js fs
* **Data Formats:** Markdown (.md) for tiles/documents, JSON (.board.json) for boards, JSON for configuration
* **Canvas:** Custom infinite canvas with rbush spatial indexing. Pan, zoom, drag, resize, and edge-pan are implemented as raw pointer-event handlers in `src/renderer/lib/canvas/`.
* **Markdown Processing:** unified + remark ecosystem (remark-parse, remark-frontmatter) for Markdown parsing and frontmatter extraction in the VaultIndex pipeline; gray-matter for inline frontmatter read/write at file-edit time. Not used by the TipTap editor, which uses tiptap-markdown for round-tripping. dompurify for HTML sanitisation.
* **Full-Text Search:** MiniSearch — lightweight in-memory full-text search engine. Integrated with the VaultIndex and updated incrementally on file change events. Powers plain-text and regex vault-wide search queries with sub-millisecond response times.
* **Drag-and-Drop:** svelte-dnd-action — Svelte-native sortable list library for Kanban column reordering, tile ordering within columns, task list reordering, and cross-container dragging. Canvas-level tile dragging uses the custom canvas implementation (not svelte-dnd-action).
* **Metadata Indexing:** Custom VaultIndex with Zod schema validation
* **Utilities:** nanoid (ID generation), focus-trap (modal focus management)
* **Editor Extensions:** Custom Tiptap extension for `#tags`
* **Export:** html-to-image, jspdf
* **Module System:** TypeScript interfaces with registry pattern for tiles, boards, and commands
* **Testing:** Vitest (unit, jsdom env), Playwright (E2E + a11y axe-core scan)

## Technical Considerations

**Platform:** Desktop (Windows, macOS, Linux). Mobile is out of scope for v1 — see Architecture > Application Shell.
**Responsive:** Yes, desktop-first
**Performance:** Page load < 3 seconds. VaultIndex + MiniSearch enables fast structured and full-text search across large vaults. Spatial indexing (rbush) ensures canvas performance with hundreds of tiles.
**Accessibility:** WCAG 2.1 AA minimum. Dynamic Contrast Text (enabled by default) ensures text-on-background colour combinations meet WCAG AA contrast ratios automatically. All animations respect `prefers-reduced-motion`. See Accessibility Requirements under Context Menu and Animations sections for further detail.
**Security/Privacy:** Local-first by default. No telemetry. No account required. Optional cloud sync via user's own storage provider.
**Offline:** Fully functional offline. All features work without internet.

## Quality Standards

**What This App Will NOT Accept:**
- Placeholder content in production ("Lorem ipsum", sample images)
- Broken features — everything listed works or isn't included
- Ignoring accessibility basics
- Broken file references — all board JSON file paths must resolve or be flagged as broken

*These standards will be enforced by the AI coding assistant.*
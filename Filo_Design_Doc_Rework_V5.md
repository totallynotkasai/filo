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

* **Properties (Frontmatter)** — Every text tile's underlying Markdown file supports YAML frontmatter enclosed in `---` delimiters. Properties store structured metadata: tags, custom fields (status, priority, due date, etc.). Properties are indexed by the VaultIndex and are queryable via search operators and the Tags Browser. Properties defined in frontmatter are the canonical source of truth for tile metadata — the UI reads from and writes to this frontmatter. Tiles without a Markdown file have no properties beyond their tags: Image, Video, Audio and File tiles keep their tags in `.filo/tags.json`, so they follow the file onto every board, and Link, Iframe and Timer tiles keep theirs in the board file. Each property is edited through its own control (the title, the Tags button, the task and card controls, the Document tab's tag row), or by hand in the Markdown file. There is no generic properties form: a new frontmatter field gets its own control.

* **Tags** — A tag is a label on a note, a media file or a board-only tile. A note's tags live in its frontmatter `tags:` list; `#tag` written in body text is styled as a chip but is decorative (see **Tag System** in the Data Model). Tags support nesting (`#project/active`). Tags can be used to organize tiles, filter views, and navigate between related content across all boards.

* **Tabs** — Tabs are used to organize boards and can be used to switch between boards. There is a Tab Browser button for the user to quickly open and close tabs. The Tab Bar is located at the bottom of the screen.

## Data Model

**Frontmatter Source-of-Truth Rule:** The `.md` file is the only copy of a note's title, tags, metadata (completed, due date, priority, status, recurrence, etc.) and body. Board JSON never copies them: a board refers to a note by its vault path (`filePath`) and stores only what is visual (position, size, style, lock/fade, which column or section it sits in and its order there, and optional title formatting). Because there is no second copy, there is nothing to reconcile: an external edit to the `.md` file shows on every board at once.

**Note titles.** A note's title is its frontmatter `title:` value. A note without a `title:` key (for example one written by another app) shows its filename without `.md`. Filo always writes `title:` when it creates a note. Editing a title — in a tile header, a card, a task row or a Document tab — changes only the `title:` line; the file is **not renamed** by a title edit. The filename is derived from the title once, at creation: characters that aren't allowed in filenames become `-`, and ` (2)`, ` (3)`… is added if the name is taken. After that, titles and filenames are independent. The one exception is a note Filo had to make before it had a title (a new card, tile or task, a subtask, a new note): it is made under a placeholder name (`New Card.md`, `New Tile 3.md`, `New Task 2.md`, `Plot - Subtask 1.md`, `Untitled.md`), and the first title it is given names the file too, in the same undo step, so the vault reads by title in any other app. A title set while the vault is closing or quitting leaves the file for the next title edit. The Vault Sidebar shows filenames, and its right-click menu offers **Rename file to match title** when you want them aligned (undoable). Formatting applied to a tile title (bold, colour…) is stored on the board as `titleHtml` and shown only while its text still matches the note's title.

### Tile Storage

Every tile on a board is either backed by a file in the vault or stores its data directly in the board JSON. The board JSON references file-backed tiles via a `filePath` field (a vault-relative path) and stores data for non-file tiles inline. How that storage works depends on the tile type:

* **Text Tile** — Stored as a Markdown file (`.md`) in the vault. The same `.md` file can be opened as a standalone Document board (see Text Tile / Document Board relationship below). Its title, tags and properties are YAML frontmatter in that file; the board stores only `filePath` and visuals.
* **Image Tile** — The image file (`.png`, `.jpg`, `.gif`, `.webp`, etc.) is stored as-is in the vault. The board JSON `filePath` field points to the image path. No sidecar `.md` file is created. Its tags live in `.filo/tags.json` (`fileTags[path]`), so they follow the file onto every board.
* **Video Tile** — The video file (`.mp4`, `.webm`, etc.) is stored as-is in the vault. The board JSON `filePath` field points to the local file.
* **Audio Tile** — Recordings are stored as `.mp3` files in the vault. The board JSON `filePath` field points to the audio file path.
* **File Tile** — The original file is stored as-is in the vault in whatever format it was provided (`.pdf`, `.docx`, `.zip`, etc.). The board JSON `filePath` field points to the file path; the displayed name and extension come from that path. Opening a File Tile hands the file to the OS default app only for document, image, audio and video types. Scripts, macro-enabled Office files, archives, disk images and HTML-like files are never launched. For those, and for unknown types, Filo offers **Show in folder** instead.
* **Link Tile** — No file is stored in the vault. The board JSON tile entry stores the URL directly in a `url` field. The tile renders a clickable link with an optional preview fetched at display time.
* **Iframe (Embed) Tile** — No file is stored in the vault. The board JSON tile entry stores the embed URL in a `url` field. The tile renders the URL inside an `<iframe>`.
* **Timer Tile** — No file is stored in the vault. Timer configuration (mode, duration) is stored entirely within the board JSON tile entry under a `config` object. Timers are ephemeral UI widgets and do not persist state between sessions.

For tile types that store a file in the vault (Text, Image, Video, Audio, File), when the tile is created by dragging a file onto the board, Filo copies the file into the vault if it is not already there. For tile types that do not store a vault file (Link, Iframe, Timer), all data lives in the board JSON. See **Properties (Frontmatter)** in Core Concepts for how metadata is stored per tile type.

### Text Tile / Document Board Relationship

A Text Tile and a Document Board are two views of the same underlying `.md` file. When a user creates a Text Tile on a Mind Map board, the tile content is written to a `.md` file in the vault. The "Expand to Document" button opens that same `.md` file as a full-page Document board in a new tab. Any edits made in either view are reflected immediately in the other: every open view of a note shares one in-memory copy of it, and the view being typed in owns it while the others follow. All writes to the file go through a single writer that re-reads the file before each save, so a change made elsewhere (another view, another app, a sync client) is never overwritten unseen. The expanded view of a text tile *is* its Document tab; there is no separate expanded-tile mode. A Document board can also be created independently (without originating from a tile): **New note** on the vault sidebar (a folder's right-click menu, the empty space below the files, or the sidebar's **+** button), **Ctrl+N** in a Document tab (a note beside the one it shows), or **+ New Tab → Document** (a note in the Root Directory). Filo creates the backing `.md` file at once as `Untitled.md`, opens it in a Document tab with its title (the tab's name) selected for typing, and the title typed names the file; Enter then puts the caret in the note's text. If that file is later referenced as a tile on a Mind Map board, the same bidirectional sync applies.

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
  "version": 8,
  "board": { /* board-type-specific shape, see below */ },
  "tileDefs": { /* tileId → tile definition */ },
  "connections": { /* connectionId → connection */ },
  "frames": [ /* frame[] */ ]
}
```

* **`version`** — A pinned integer literal (`8` for the current shape — `CURRENT_BOARD_FILE_VERSION` in `src/renderer/schema/boardFile.ts`). The loader accepts exactly this version. A board with any other version — older, missing, or *higher* than the running binary supports — fails to load loudly rather than being misinterpreted: it is listed as failed with a toast, its bytes are copied to `.filo/recovery/`, and Filo never writes to it. Filo has not shipped, so there are no migration steps (`migrateBoardFile` in `src/renderer/schema/migrations.ts` is only the version gate). A future format change would add a step there and bump the version.
* **v8 = visuals only.** A text tile's definition holds `filePath` and board-owned visuals (style, optional `titleHtml`), never the note's title, tags or body. Media and file tile definitions hold no tags (those are in `.filo/tags.json`) and no file name or extension (derived from `filePath`). Board-only tiles (Link, Iframe, Timer) keep their own `title` and `tags`, because they have no file.
* **`board` / `tileDefs` / `connections` / `frames`** — Tile definitions, connections, and frames are stored as side-bag records alongside the board rather than nested inside it. Tile *placements* — position, size, per-board style overrides — still live inside `board`; the side-bag records carry the *definitions* those placements reference. The schemas listed in the per-board-type sections below describe the resolved in-memory shape (placements + their definitions merged) rather than the raw envelope; the envelope itself is validated by `V7BoardFileDataSchema`.

The runtime `V7BoardFileData` type used by the renderer cache makes `version` optional (typed as the literal `8`): the saver stamps it on every write, and in-memory consumers never read it, because every loaded board is the current version. This is documented at the type declaration site (`src/renderer/lib/boards/tileDefBuilder.ts`).

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
      "filePath": "Notes.md",
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
      "filePath": "assets/diagram.png",
      "x": 500, "y": 80,
      "width": 250, "height": 200,
      "style": { "borderStyle": "solid", "borderWidth": 1, "shadowIntensity": 0.2 },
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
          "filePath": "Task - Design review.md",
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
    "groupBy": "none",
    "sortBy": "priority"
  },
  "tasks": [
    {
      "id": "task_001",
      "filePath": "Task - Write tests.md",
      "position": 0,
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

Task list items reference `.md` files in the vault. Unlike Mind Map and Kanban boards, the Task List does not use the tile UI system — tasks are displayed as flat list rows rather than spatial tile containers. However, each task's content is still a full Markdown document with metadata (status, priority, due date, assignee) stored in YAML frontmatter. The board JSON holds only the task's `filePath`, its position and its style; `completed` and every other field are read from the note's frontmatter (see the **Frontmatter Source-of-Truth Rule** above). Grouping and sorting is driven by frontmatter property values.

**Recurring tasks.** A recurring task stores its rule in frontmatter (`recurrence`, with a mode). The Repeat menu (the repeat chip, or the date chips' right-click menu) offers None, Daily, Weekdays, Weekly, Every 2 weeks, Monthly, Yearly and **Every…** (any number of days, weeks, months or years), and, once a rule is set, what the next date counts from: **the due date** (schedule mode, the default) or **the day it is done** (`recurrenceMode: completion`). A rule Filo can't read (written by hand or by another app) is named at the top of the menu and shown in the danger colour on its chip; completing such a task marks it done and says it won't repeat, with Undo. Quick add reads a repeat too: "every friday", "every 2 weeks", "every other day", "every month", "every weekday"; without a date typed with it, the first due date is the repeat's first day. In schedule mode, a monthly task due on the 29th–31st, or a yearly task due on 29 February, also gets an optional `recurrenceAnchor: YYYY-MM-DD` key. The next due date is then stepped from that anchor in whole periods, so Jan 31 → Feb 28 → Mar 31 → Apr 30 rather than drifting to the 28th. The key is written only in those cases. It is removed when the recurrence changes or is cleared, and when it no longer matches the due date (the date was moved by hand).

#### Document Board

A Document board is the simplest board type — it is a full-page view of a single `.md` file, shown in a Document tab. Filo makes no board file for it: the tab names the note's path (kept with the open tabs in `.filo/workspace.json`), and all content lives in the Markdown file. The `document` type stays in the board format for files older builds made. See the **Text Tile / Document Board Relationship** section above.

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

When another program changes an open note, Filo decides from what changed:

* **The note has no unsaved edits** — the views simply show the new version.
* **Only the frontmatter changed** (a sync client updated tags or a field), even while the user is typing — Filo takes the new frontmatter and keeps the unsaved body. No prompt.
* **The body changed while the user has unsaved edits** — one non-blocking prompt per note: **"Reload"** (first keeps a copy of the unsaved edits in `.filo/recovery/`, asking before it goes on without one, then shows the other version and offers **Undo reload**) or **"Keep mine"** (first copies the other version into `.filo/recovery/`, then writes the local edits; if that backup fails, Filo asks before overwriting without one). The prompt stays on screen until the user chooses; while it is open nothing is overwritten, and the unsaved edit stays queued.
* **The file was deleted while the user has unsaved edits** — **"Keep mine"** recreates the file with the local text, or **"Discard"**.

Filo's own writes coming back through the file watcher are recognised by their content and ignored. Board files use a separate **"Reload" / "Keep local"** prompt when a board changed on disk between load and save.

### Tag System — Frontmatter Canonical, Body Decorative

Tags have two distinct surfaces in Filo, and only one of them is canonical:

* **Frontmatter `tags:` (canonical).** The array under a note's YAML frontmatter is the note's only tag list. VaultIndex indexes it, the tag browser reads it, and rename/delete sweeps rewrite it. Board files hold no copy.
* **Where other things keep their tags.** Media and other non-Markdown files (image, video, audio, generic file) have no frontmatter, so their tags live only in `.filo/tags.json:fileTags[path]`; they follow the file onto every board. Board-only tiles (Link, Iframe, Timer) keep their tags on the tile in their board file.
* **Body `#tag` chips (decorative).** TipTap's tag extension recognises `#tag` and `#tag/subtag` runs in body text and styles them as chips for readability. These chips are *not* indexed and *not* rewritten by rename/delete operations. They survive a markdown round-trip as bare `#tag` text so external editors see exactly what the user typed, but they have no presence in the tag registry.

This split is intentional. Body chips give users the freedom to mention a tag in a sentence without changing the file's canonical tag set; frontmatter is the single, structured surface where tag identity lives. Hovering a body chip surfaces a tooltip explaining the distinction so users aren't surprised when a rename leaves body mentions untouched.

Tags are global to the vault (their colour definitions live in `.filo/tags.json:tags`) and may be hierarchical (`parent/child`). Renaming a parent does *not* cascade to children — the tag browser warns the user when a rename would orphan child tags so they can decide explicitly.

**Editing a note's tags.** A note's tags can be edited from the tile header's Tags popup, a card or task row, or the **tag row** at the top of the note in its Document tab. The tag row shows the tags as chips (click a chip for the tag menu, × to remove it) followed by an input that takes comma-separated tags with autocomplete from the tag registry; Enter, a comma or leaving the field adds them, and Backspace in the empty input removes the last tag. Every one of these writes the note's frontmatter `tags:` and is one board-undo step; removing the last tag removes the `tags:` key.

**Vault-wide delete and rename (Tags Browser).** Deleting a tag removes it from every note, attachment, board-only tile and saved filter; renaming rewrites it everywhere. Both are confirmed first, and both can be undone from the **Undo** button on the toast that reports them, which stays until it is dismissed or the next tag action's toast replaces it. They are not on a board's Ctrl+Z stack, because they touch many files and belong to no board. Undoing a delete puts the tag back in exactly the places it was removed from, re-reading each note first so edits made in between are kept (in a note it comes back at the end of the list). Undoing a rename renames it back, unless a tag with the old name exists again. Renaming a tag into one that already exists **merges** them; the confirm warns that a merge can't be undone, and no Undo is offered.

## Architecture

### Application Shell

* **Desktop:** Electron main process (Node.js) for file system access, window management, and native OS integration.
* **Mobile (Out of scope for v1):** A future Capacitor (Ionic) wrapper is conceivable but not on the v1 roadmap and is not being designed or tested for. The current architecture happens to leave the door open — file I/O is abstracted behind the Vault API (swappable for Capacitor's Filesystem plugin), UI components use responsive CSS, and platform-specific code (Electron IPC, native menus, file watchers) is isolated in a thin shell layer — but no mobile work is planned. Treat any "mobile-friendly" hedging in this document as opportunistic, not a commitment.
* **Frontend:** Svelte 5 with TypeScript, bundled with Vite.
* **Rendering:** Custom infinite canvas with rbush spatial indexing. Pan, zoom, drag, resize, and edge-pan are all implemented as raw pointer-event handlers in `src/renderer/lib/canvas/` — there is no gesture library.

### Data Layer

* **File System** — The vault folder is the single source of truth. Text tiles and document boards are `.md` files, non-text tiles are stored as their native file type (`.png`, `.mp3`, `.svg`, etc.) or have no vault file at all (Link, Iframe, Timer tiles store data in the board JSON). Boards are `.board.json` files. Configuration lives in `.filo/`.
* **VaultIndex** — An in-memory index of every note in the vault: its frontmatter properties, title, tags and body text. The frontmatter is read with the `yaml` package, the one frontmatter parser the note writer also uses. The index does not parse Markdown: nothing reads a note's headings or links, so opening a vault doesn't pay for a parse per note, and markdown-it stays the one Markdown parser in the app. The Search panel matches titles, tags and note bodies over the index itself; there is no separate search engine. The index rebuilds incrementally on file changes via file system watchers (Node.js `fs.watch`). File change events are debounced (300ms) to batch rapid saves. When a change is detected, only the affected file is read again — a full rebuild is only performed on vault open. External edits to vault files (e.g., from another text editor) are detected by the same watcher and trigger a re-read; open notes follow the rules in **External Edit Conflict Resolution** (see Data Model). The index is read-only: nothing is ever written from it. A note's title in the index is its frontmatter `title:`, or its filename stem when there is none.
* **Vault API** — Programmatic interface for file CRUD operations. When a tile or file is renamed, the Vault API updates all board JSON references to the old file path. Broken file references (pointing to deleted or non-existent files) are detected during board loading and flagged. This is the single system responsible for all file reference resolution and renaming propagation.

### File Sync Model

Filo uses a debounced write strategy to keep vault files up to date without hammering the file system. Content edits (tile text, frontmatter changes) are held in memory and flushed to disk after 300ms of idle — this prevents every keystroke from triggering a file write and an accompanying file watcher event that would need to be distinguished from external edits. (The editor hands its text to the shared note after 150ms of idle, and at once on blur, closing, save and quit.) Each note has one write queue: every save re-reads the file and applies the change to what is on disk, so frontmatter keys or text added by another program are kept. Layout changes (tile moves, resizes, connection updates) to `.board.json` files use the same 300ms debounce. Configuration changes to `.filo/` files are written on confirmation or panel close. While writes are pending, Filo keeps a per-machine dirty flag, `.filo/.dirty.<machineId>`; if the application is closed or crashes with unflushed edits, the flag is still there on the next launch and Filo tells the user the last session ended mid-write. (A separate file is used rather than a flag inside `workspace.json`, because `workspace.json` is itself written on a debounce and would race with it.) Each machine only reads and clears its own flag, so machines syncing one vault never act on each other's crash state. The source of truth hierarchy is defined in the **Data Layer** section above; the file system watcher (Node.js `fs.watch`, debounced at 300ms) detects external changes and updates in-memory state accordingly.

### File Deletion Handling

**Filo's trash.** Nothing Filo deletes is deleted outright. Every delete made in Filo — a file or folder from the Vault Sidebar, a board, "delete tile and file", "Delete Task & File" — moves the item into `.filo/trash/<trashId>/` inside the vault (the item under `files/`, plus a `manifest.json` recording its original path, when it was deleted and which machine deleted it). The move is a rename on the same drive, so it is atomic: if any part of a folder is locked, nothing moves. Confirm dialogs say so plainly, e.g. *"X" will be moved to Filo's trash. Undo, or restore it from Settings → Trash.*

* **Undo** of a delete moves the item back (a rename, never a rewrite), so it works for any file type and size. If the original name has been taken again in the meantime, the item comes back beside it as `… (restored)`, and the restored tiles point at the restored copy.
* **Settings → Trash** lists trashed items, newest first, each with **Restore**, plus **Empty trash**.
* **Emptying** the trash sends items to the operating system's Recycle Bin. On vault open, items older than **30 days** are sent there too, but only by the machine that trashed them. If the Recycle Bin refuses an item, a confirm lists every such file and asks **"Delete permanently?"**; Cancel keeps them in Filo's trash.
* Filo's trash is inside the vault, so a cloud-synced vault syncs it too (see KNOWN_LIMITATIONS).

**What each delete does:**

* **Deleting a tile from a board** removes only that board's placement. The underlying vault file stays, unless — for a text tile — the user ticks "Delete associated file from vault as well?" in the confirm, in which case the `.md` file goes to Filo's trash and any other tile showing it becomes a broken link. Undo brings back both.
* **Deleting a file or folder from the Vault Sidebar** moves it to Filo's trash and removes every placement that referenced it (or anything inside the folder) from every board. One undo restores the file and all of those tiles. If no open board can hold the undo step, the "moved to Filo's trash" toast offers Undo instead.
* **Deleting a `.board.json` file** (Board Browser or sidebar) moves the board to Filo's trash. Any open tabs showing it are closed. Its notes and media stay in the vault. Because a board's undo history goes with the board, undo is offered on the toast, and later from Settings → Trash.
* **A sync client's conflict copy of a note** (`Chapter.sync-conflict-…-ABCDEFG.md` from Syncthing, `Chapter (… conflicted copy …).md` from Dropbox, `Chapter-<device>.md` from OneDrive) is named in a notice, live and when the vault opens: which note it split from, which version Filo shows, and **Open the copy**. Only these unmistakable names count; `Chapter 2.md` beside `Chapter.md` is an ordinary note. Filo never merges, deletes or renames a copy.
* **A file renamed over another file** by another program (Explorer's "Replace") is that file changed and the renamed one gone, not a move: the replaced note's views reload, and typing not yet saved in it meets the usual Reload / Keep mine prompt.
* **A file deleted outside Filo** (another app, a sync client) is detected by the watcher. Its tiles are kept and shown as missing; removing them from every board is a separate, confirmed action. The VaultIndex drops the file's metadata.

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
          delete(path: string): Promise<void>;  // moves to .filo/trash + removes tile references (undoable)
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
| **fileTags** | Tag definitions (create, rename, recolour, delete) and media-file tags, in `.filo/tags.json` |
| **templates** | In-memory cache of Layout Templates from `.filo/templates/` plus the pending insertion anchor; save / rename / delete actions |
| **notes** | One shared model per open note, keyed by its vault path, used by every view of it. Owns the note writer, the only code that writes `.md` files, and the external-change handling |
| **trash** | Filo's trash: Settings → Trash list, restore, empty, the 30-day purge |
| **ui** | Transient UI state: open modals, active toast messages, context menu position, toolbar state |
| **theme** | Active theme name and CSS variable values |
| **spatial** | RBush spatial index for viewport culling — only tiles within the visible viewport are rendered |
| **guides** | Smart guide state: active guide lines, snap distance, alignment calculations |
| **search** | Vault-wide Search query, parsed operator filters, match results, current-match cursor, Find/Replace mode toggle |
| **vaultIndex** | In-memory index of each note's frontmatter, title, tags and body text. Powers search and tag queries |

**Data flow:** User action → store mutation → reactive UI update. For file-backed data, store mutations schedule a debounced write (300ms idle) to the vault via the Vault API (IPC to main process). External file changes detected by the file watcher flow in reverse: watcher event → IPC to renderer → store update → reactive UI update.

### Undo/Redo System

Filo uses a **command pattern** for undo/redo. Every undoable action is encapsulated as a command object with `execute()` and `undo()` methods. Executed commands are pushed onto the active board's undo stack; the redo stack is cleared on any new action.

**Per-board stacks:** Each board maintains its own independent undo and redo stack. Switching tabs changes which stack is active. This means undoing on Board A never affects Board B. A Document tab has its own stack too, so a title or tag edit made there is undone there.

**What board undo covers:** layout (tiles, connections, frames, columns, sections, styles, settings) **plus edits to note metadata** (title, tags, task and card fields). A metadata edit is undone by applying the *opposite change* to the note's frontmatter, on a fresh read of the file, so edits made to other keys in between are kept. If another program changed the same key since, undo keeps that value and offers "Apply anyway". Board undo never restores a note's body from a saved copy: undo of a delete moves the file back out of Filo's trash, and Replace All undoes only the text it replaced, and only while the file is unchanged since.

**Outside board history:** vault-wide tag delete and rename are undone from their toast (see **Tag System**), and a board delete from its toast or Settings → Trash.

**Command types:**
* `AddTileCommand` / `DeleteTilesCommand` — Creating or removing tile placements
* `MoveTilesCommand` — Changing tile positions (drag)
* `ResizeTileCommand` — Changing tile dimensions
* `AddConnectionCommand` / `DeleteConnectionCommand` — Creating or removing connections
* `AddFrameCommand` / `DeleteFrameCommand` — Creating or removing frames
* `AlignTilesCommand` — Aligning selected tiles (left, right, top, bottom)
* `LayoutTilesCommand` — Auto-layout (tree horizontal, tree vertical, radial)
* Style change commands — Tile, connection, and frame style modifications
* `UpdateTitleCommand`, the tag commands, the card/task field commands and `UpdatePropertiesCommand` (the Document tab's tag row) — note metadata, undone as the opposite frontmatter change
* `RenameFileCommand` — undo of "Rename file to match title" (renames back)
* `RenamePlaceholderCommand` — a placeholder-named note renamed after its first title, inside that title edit's step
* `CascadeDeleteCommand` — a sidebar delete and the tiles it removed; undo restores both from Filo's trash

**Text editing integration:** Text content changes within the Tiptap editor use Tiptap's built-in ProseMirror undo/redo (Ctrl+Z / Ctrl+Y while the editor is focused). Board-level undo (Ctrl+Z while no editor is focused) operates on the board's command stack. These two undo systems are independent.

### Editor

* **Rich Text:** Tiptap (ProseMirror) with the following Extensions:
    * @tiptap/core — Headless rich text editor framework
    * @tiptap/pm — ProseMirror bindings
    * @tiptap/starter-kit — Basic extensions bundle (bold, italic, lists, etc.)
    * tiptap-markdown — Markdown serialization/deserialization for round-tripping between TipTap's ProseMirror document model and `.md` files. This is essential for the open-format philosophy — without it, TipTap defaults to HTML output. All tile `.md` files are read into TipTap via this extension's parser and written back to disk via its serializer.
    * @tiptap/extension-paragraph, -heading, -blockquote, -hard-break — StarterKit's own nodes, imported directly because Filo extends each (blank lines, alignment and indent, quotes, line breaks)
    * @tiptap/extension-text-align — Text alignment (left, center, right, justify)
    * @tiptap/extension-text-style — Inline text styling: the TextStyle mark, Color (text colour) and FontFamily (font family selection)
    * @tiptap/extension-underline — Underline formatting
    * @tiptap/extension-highlight — Text background highlighting
    * @tiptap/extension-link — Hyperlink support
    * @tiptap/extension-image — Image insertion
    * @tiptap/extensions — Placeholder (placeholder text in empty editors)
    * @tiptap/extension-table — Tables: Table, TableRow, TableHeader and TableCell
    * @tiptap/extension-list — Lists: BulletList, OrderedList, TaskList (checkbox lists) and TaskItem
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

* **Settings (Gear button, Ctrl+,)** — Opens Settings, as the vault menu's Settings does. Each Settings tab says how it saves in the same place, the bar above its page: General saves as you make changes and Trash and Recovery act at once; Global Defaults and Current Board wait for **Apply** (with **Revert**); on Themes a pick applies at once and the theme editor saves on its Save button.

* **Manage Filo (Dropdown)**
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
                    * **Page Layout** — **Pages** (the note on page cards, the default) or **One continuous sheet**. See **Document** under Board Types.
                    * **Document Page Defaults** — Standard Element Style Properties.

            * **Themes** (stored in `.filo/themes/`)
                * **Default Themes** — Themes are collections of default style values that restyle the entire tool. Applying a theme overwrites the values in `.filo/defaults.json` and `.filo/appearance.json`, making those values the new Global Defaults. There are 5 built-in themes: Light Mode, Dark Mode, Blueprint, Retro and Nature. Each theme file is a JSON object containing the full set of default values for all board types plus appearance settings (see `.filo/themes/` in Vault Configuration).
                * **Custom Themes** — Lists custom themes the user has created.
                * **Save Current Settings as Theme** — Saves the current Global Defaults as a new named theme JSON file in `.filo/themes/`.

            * **Trash** — Lists everything in Filo's trash (`.filo/trash/`), newest first, with its original path and when it was deleted. **Restore** moves an item back to where it was (or beside it as `… (restored)` if that name is taken again). A restored board reappears; tiles that a delete removed from boards come back only through Undo of that delete, not through Restore. **Empty trash** sends every item to the operating system's Recycle Bin; if the Recycle Bin refuses any, one confirm lists them and asks "Delete permanently?". Items older than 30 days are emptied automatically on vault open, by the machine that trashed them. See **File Deletion Handling** in Architecture.

            * **Recovery** — Lists the copies Filo keeps in `.filo/recovery/`, by kind: **Kept versions** (the version a Reload, Keep mine, Keep local, Convert to UTF-8 or a board's first save in the new format replaced), **Rescue copies** (changes that couldn't be saved when the vault closed, another opened or Filo quit anyway, or Windows shut down), **Files that failed to load** (copies taken before anything could write over them; the newest 20 of each file, 100 in all) and **Partly written files** (what unfinished saves left, moved aside at open). Each copy has **Open** (in the system's app for it; its folder when there is none), **Show in folder** and **Delete**; each kind has **Delete all**, which asks first. A delete sends the copy to the Recycle Bin; if the Recycle Bin refuses, one confirm asks "Delete permanently?". Kept versions and rescue copies are never deleted by Filo itself, so this is where they are cleared. Each copy is announced when it is made, so opening the vault names only a load-failure copy that no other notice of that open named.

        * **Current Board Settings** — Per-board overrides that apply only to the active board. Stored in the `settings` object within the board's `.board.json` file. These override Global Defaults for the current board only. Accessed via Settings > Current Board tab, or via a "Board Settings" button in each board's side toolbar. The available options mirror the Global Defaults for the active board's type:

            * **Mind Map Board Settings** — Board Background Colour, Board Background Pattern, Semantic Zoom (Toggle), Dynamic Contrast Text (Toggle), and all Tile/Connection/Frame default overrides.
            * **Kanban Board Settings** — Board Background Colour, Accent Colour, Dynamic Contrast Text (Toggle), and all Column/Tile default overrides.
            * **Task List Board Settings** — Board Background Colour, Accent Colour, Dynamic Contrast Text (Toggle), and all Task default overrides.
            * **A Document tab** shows a note, which has no board file, so it has no Current Board settings: the tab is off while a note is shown, and says why. A note's page follows Global Defaults → Document, and its line spacing is the note's own (`lineSpacing:` in its frontmatter, from the toolbar).

    * **Help (Button)** — See Help button below for full description.

* **Global Undo (Button / Ctrl+Z)** — Undoes the last action on the active board. The undo history is scoped per-board — each board maintains its own independent undo stack. In split-pane mode, undo applies to whichever pane the user is actively editing. Tracked actions vary by board type but broadly cover: element creation/deletion, moves and resizes, text content changes (integrated with TipTap's built-in undo), style changes, and board-level setting changes. This button is faded if there is no undo action available.

* **Global Redo (Button / Ctrl+Y or Ctrl+Shift+Z)** — Redoes the last undone action on the active board. Uses the same per-board redo stack. This button is faded if there is no redo action available.

* **Search, Find and Replace (Button / Ctrl+Shift+F)** — Opens a floating Search panel in the top-left of the workspace. The panel is draggable so the user can reposition it; closing returns focus to the previously focused element. Escape closes it wherever the focus is (a click on the board takes the focus out of it), once whatever lies above it has had the key: a dialog, a menu or popup, a board's selection or connection mode, or a text field or title being edited. The find box accepts a query; toggling Replace mode reveals a second box and the Replace / Replace All actions. Supports search operators (combinable; AND-joined):
    * `tag:#tagname` — Search by frontmatter tag (leading `#` is optional)
    * `board:boardname` — Restrict to a single board (case-insensitive, quoted strings preserve spaces)
    * `has:connections` — Tiles with at least one connection on either end
    * `property:status=active` — Search by frontmatter property value (case-insensitive key, array values match if any element equals)
    * `type:image` — Search by tile type (`text|image|video|audio|file|link|iframe|timer`)
    * Regex support with `/pattern/` or `/pattern/flags` syntax (the global flag is added automatically; user flags are preserved)
    * Find / Find All buttons sit next to the find box. **Find** cycles through matches in order — board name → tile title → match offset — and highlights the active tile via the existing `navigateToTile` flow (board switch, viewport centre, 2 s highlight pulse). **Find All** opens a popup listing every match with its tile title, owning board, tags, and a snippet; click-to-jump.
    * **The list under the box** — Below the find box the panel lists the matching notes, grouped by note: each note's title, its board (or "On no board"), how many matches it has, and its first three matches with the words around each, the matched text marked ("N more in this note" opens the rest). A click on a match shows it, as Find does; the current match is marked and kept in view. Arrow keys move through the list, which is one Tab stop. The first 100 notes are listed; a narrower search shows the rest.
    * **Replace** (single match) and **Replace All** sit next to the replace box. Replace All is **atomic in its pre-flight phase**: if any candidate file fails to read, no writes occur. Once writes begin, per-write failures are surfaced via toast but already-committed writes remain on disk (the filesystem can't be atomically rolled back across files). Both Replace and Replace All push a `ReplaceAllCommand`, so Ctrl+Z puts each replaced match's original text back. The command keeps only the replacements and a hash of each file before and after, never a copy of the note, and it rewrites a file only while its bytes are exactly what the replace left — an edit made to the file in between is never overwritten.
    * **Replace scope:** body matches only. Title-only matches surface in Find / Find All but are skipped by Replace, because a title edit is its own undoable command (`UpdateTitleCommand`, a frontmatter `title:` change).
    * **Match cap:** the engine returns at most 5 000 matches; a truncation indicator surfaces in the panel header so the user knows to refine the query.
    * **Hotkeys inside the panel:** Enter / F3 cycles to the next match, Shift+Enter to the previous; Escape closes the panel; Ctrl+Shift+F opens or closes from anywhere in the app (including inside a TipTap editor).
    * **Search indexing:** Structured queries (tags, properties, tile type) walk the live board cache + VaultIndex frontmatter directly. Full-text and regex queries scan `FileMetadata.content` from the VaultIndex (built on vault open, updated incrementally on file change events). Tile titles are searched alongside body content so non-text tiles (image, link, iframe, etc.) participate in the result set even though they have no backing file body.

* **Text Formatting** — Allows the user to format their text. Here is the list of text formatting that needs to be added and what order it needs to be in:

* **Font Selection** — Changes the typeface of selected text (dropdown menu showing the current font). All text defaults to the global font set in Settings > General > Global Font. The font dropdown in the toolbar allows users to override the font for a specific text selection only — unselected text remains in the global font. Per-selection font overrides are stored as inline TipTap marks in the document. A font whose name CSS can't read unquoted (an imported font named after its file, such as "28 Days Later") is written quoted.

* **Font size** — Decreases or increases the text size (a minus sign, a number, and a plus sign). The number is the size the selected text is shown at (a Document's 16 px body, a heading's size, a size pasted in points), and the buttons step from it.

* **Bold** — Makes text thicker (a bold B).

* **Italic** — Slants text to the right (an italicized I).

* **Underline** — Draws a line under the text (an underlined U).

* **Text color** — Changes the color of the text (an 'A' with a thick line underneath).

* **Highlight color** — Applies a background color behind the text (a marker icon).

* **Styles** — Applies pre-set formatting like Title, Subtitle, and Headings (dropdown menu usually showing "Normal text").

* **Spelling and grammar check** — Uses Electron's built-in spellchecker (backed by the OS-level spellcheck service) to underline misspelled words and offer corrections. No third-party library required — Electron exposes this via the `webFrame.setSpellCheckProvider` API and context menu suggestions (an 'A' with a checkmark). Turning it off applies to every editor, those opened later included, and the vault remembers it (`.filo/workspace.json`).

* **Insert link** — Turns text into a clickable hyperlink (a chain link icon).

* **Align** — Changes the horizontal placement of text (Left, Center, Right, or Justify). Depending on your layout, this is either a dropdown or four separate icons showing horizontal lines.

* **Line & paragraph spacing** — Adjusts the vertical space between lines of text and paragraphs (horizontal lines with a vertical double-arrow). Line Spacing is the note's own (`lineSpacing:` in its frontmatter) and sets the height of every line. Paragraphs have no space between them: Enter puts the next paragraph on the next line, as a wrapped line sits, and list items stand the same way, a line apart; a gap is a blank line you type, an empty paragraph, written to the file as one more blank line (blank lines after the last line are kept too; those above the first aren't, KNOWN_LIMITATIONS #55). Headings, quotes, code blocks, tables and a whole list keep a margin around them. Lines joined by single newlines (a note from Keep or another app, a plain-text paste) look the same as paragraphs, so Heading, Normal text, Align, Indent, Quote and the list buttons on one of them act on that line alone (the block is split there, in the same undo step), and Enter beside one opens a new empty line at the caret. A line break typed with Shift+Enter looks the same too, but keeps its paragraph whole, as in a word processor: a paragraph style takes all its lines. Other Markdown apps space paragraphs their own way (KNOWN_LIMITATIONS #54).

* **Bulleted list** — Creates an unordered list using bullet points (dots next to horizontal lines). The list buttons (and Ctrl+Shift+8 / 7 / 9) change every list the selection reaches to their kind in place, each item at its level; a nested list changes only where the selection reaches its lines. Plain paragraphs selected with a list join it. Where no list can go (a title, a connection label) the buttons are off.

* **Numbered list** — Creates an ordered list using numbers (numbers next to horizontal lines).

* **Decrease indent** — Moves the paragraph closer to the left margin (horizontal lines with a left-pointing arrow).

* **Increase indent** — Moves the paragraph further from the left margin (horizontal lines with a right-pointing arrow).

* **Clear formatting** — Removes all bold, italic, font, and size adjustments, returning the text to the default style (a 'T' with a diagonal slash through it).

With no text editor to act on, the formatting controls show disabled (Spelling, a setting for every editor, stays live); the focus moving from an editor into the toolbar keeps that editor as their target, so they can be reached with Tab. At laptop widths the toolbar narrows its boxes rather than run off the end, as far as the room it has calls for (the vault's name and the toolbar scale count): first the dividers and the font and style boxes, then shorter alignment labels, with the note-layout controls (line spacing, indents, Clear formatting) folded into a **More formatting** (⋯) button. A toolbar still too wide scrolls from its left edge. The vault menu's name is cut short with an ellipsis (its tooltip has it whole).

Typing in a note: `# `, `- `, `* `, `1. `, `> ` and `[ ] ` start a heading, list, quote or checkbox once the space after them is typed, never on Enter, and a number of three digits or more (a year opening a sentence) starts no list. A scene break typed on a line of its own (a lone `#`, `* * *`, `- - -`, `_ _ _`, `***`) becomes a horizontal rule on Enter; Ctrl+Z puts the typed line back. Rich text pasted from Word, Google Docs or a web page keeps its bold, italic, underline, colours, fonts, pixel sizes and highlights; the source's own text colour (black or white), main font and point sizes are dropped, so the paste takes the note's look, and Word's bullets become a real list. Ctrl+Shift+V pastes plain text. An image a note embeds (`![map](images/map.png)`) shows from the vault, its address read from the note's folder, in the editor and in a Kanban card's preview. A tile, card, frame or connection title is one line: Enter saves it.

### Side Toolbar — Mind Map

* **+ New Tile (Button)** — Prompts the user to select what tile type they'd like to create out of the following options: Text, Audio, Link, Iframe (Embed), Timer. Creates a new tile on the board, in the middle of the view, or stepped clear of the tiles already there (the nearest free spot, a tile's width or height and a gap at a time, preferring one in view), so new tiles never pile up; Ctrl+N and N do the same. This uses the tile defaults setup in Filo Settings. Undoing a new tile whose note is still empty (and shown by no other tile) moves that note to Filo's trash, and redo brings it back; the same goes for a new Kanban card or Task List task. Image, Video, and File tiles cannot be created via this button — they are created exclusively by dragging and dropping a file from the user's computer onto the canvas (see **Drag-and-Drop File Import** in General Features).

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
    * **Tags Browser (Button)** — Opens Tag Browser pop-up window. Where the user can see all the tags they have created and how many tiles have each tag. The user can also rename tags, change their colour or delete them from here. The tags listed are notes' frontmatter `tags:`, attachments' tags (`.filo/tags.json`) and board-only tiles' tags; a `#tag` written in a note's text is decorative and isn't listed (see **Tag System**).
    * **Hide All Connection Paths (Toggle)** — Hides all connection paths by switching their opacity to 0. *(Mind Map only)*
    * **Hide All Connection Labels (Toggle)** — Hides all connection labels by switching their opacity to 0. *(Mind Map only)*
    * **Hide Waypoints (Toggle)** — Hides all waypoints by switching their opacity to 0. Remembered for each board (`.filo/workspace.json`), like the minimap. *(Mind Map only)*
    * **Orphan Catcher (Button)** — Highlights all orphaned tiles on the canvas: tiles that have no connections, no tags, and are physically far from any tile cluster, as well as completely empty tiles. Highlighted tiles are visually marked (e.g., pulsing border or distinct overlay colour) and listed in a popup panel. From the panel the user can select individual tiles to navigate to, bulk-select, or delete them. Useful for cleaning up abandoned thoughts on large boards. *(Mind Map only)*

* **Toggle Minimap (Button)**
    * Mini-Map — when toggled on a mini-map displays in the bottom right of the board it can be used to navigate quickly around the board. Shown or hidden is remembered for each board, in `.filo/workspace.json`.
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

The side toolbar is draggable — pointer-drag the toolbar background to reposition; right-click the background to reset to the docked position. Its position and pin are kept per board in `.filo/workspace.json`.

### Kanban Board — Implemented Extras

Capabilities present in the V7 build that aren't part of the original V5 spec but ship as canonical Kanban features:

* **WIP Limits per column** — Optional integer cap on the number of cards in a column. When exceeded the column header tints red and the count badge shows `N/M`. Set via the column "…" menu → "Set WIP Limit…"; cleared by entering 0 or blank. Persisted on `column.wipLimit`. Optimistic preview: while the popover is open, the column border previews based on the typed draft.
* **Per-column width override** — Width in px settable from the Manage Columns modal. `null` inherits the cascade (board defaults → global defaults → KANBAN_COLUMN_DEFAULTS.width). Stored on `column.style.width`.
* **Cover image (placement-level)** — Text cards expose an "Add cover image" affordance that copies an image into the vault and stamps the relative path onto the placement's `coverImage`. Lives on the placement (not the tile def) so the same `.md` can appear on multiple boards with independent cover art. Path is sanitised (rejects absolute, traversal, and URL-scheme inputs).
* **Find bar** — `/` opens an in-board search that filters visible placements across all columns by title, tag, and body text. Search query is treated as an additional filter alongside the toolbar Filter/Sort state.
* **Bulk multi-select** — Ctrl-click / Shift-click selects multiple cards. The bulk context menu offers Move to Column, Add Tag, and Delete with confirmation. Selection clears on Escape or board click. One card's own menu offers Move to column too, and the arrow keys scroll the card they select into view.
* **Due date** — A card's due chip opens the Task List's date picker (keyboard and all), so a date is chosen whole.
* **Last view restored** — Filter chips + sort mode survive tab switch and vault reload (persisted to `board.settings.lastView`). Saved Views are still available for named snapshots; lastView is the "where I was when I closed the tab" memory. A board with no lastView shows the default view, and nothing is written until the sort or a filter changes.
* **Keyboard shortcuts** — `n` opens the Add Tile picker for the current column; `Shift+N` adds a new column; both act only while focus is in the board (its empty space, a card or a button on it), so typing in the sidebar or a title never adds a card. A new card opens with its title selected for typing, and an empty card shows "Start typing..." where its text goes. `/` opens the find bar. Both `n`/`Shift+N` are user-rebindable via Keyboard Shortcuts settings (commandIds `kanban:add-tile` and `kanban:add-column`).
* **Open as Document** — Right-click a text card → "Open as Document" opens the backing `.md` in a Document tab. Also wired to double-click the card body.
* **A11y** — Column reorder via **Alt+ArrowLeft / Alt+ArrowRight** with the column title focused. Toolbar and column menus have arrow-key navigation, `aria-haspopup="menu"`, and `role="menuitem"` on items. Modals (Add Tile picker, Manage Columns) trap focus.

### Side Toolbar — Task List

* **+ New Task (Button)** — Creates a new task at the end of the section last added to, else the first section. The task is backed by a new `.md` file in the vault.
* **Group By (Dropdown)** — Groups the tasks inside each section: by status, priority, tag, due date, category, or none (a new list starts with none). Each group's first row carries its heading and count; a subtask stays under its parent. The button is never greyed out.
* **Sort By (Dropdown)** — Changes task sort order: by title, date created, due date, priority, or manual.
* **Filter (Dropdown)**
    * **Filter by Tag** — Shows only tasks matching selected tags.
    * **Filter by Status** — Shows only tasks in one status, by the rule Group by Status uses: a task with no `status:` (every task made in Filo) is To Do, a completed one is Done, `doing` / `in_progress` are In Progress. It lists the statuses the board's tasks are in.
    * **Filter by Priority** — Shows only tasks with a specific priority level (Urgent, High, Medium, Low, No priority: the words every view uses).
    * **Show Completed (Toggle)** — Toggles visibility of completed tasks.
* **View (Dropdown)** — Shared View dropdown (Tags Browser). See Mind Map Side Toolbar > View for full description.

### Side Toolbar — Document
There is no side toolbar for the document board. The document board uses the global toolbar for all its functionality.

## Vault Sidebar

The Vault Sidebar displays the contents of the current vault as a file and folder tree. It allows the user to browse, organise, and manage all files and boards in the vault. Docked, it lies over the left edge of the workspace while a centred page still clears it; in a window narrower than the Document page plus the sidebar on both sides (1,340 px with the default 240 px sidebar) it pushes the workspace aside instead, so it never covers the start of a note's lines. Popped out, it floats where the user puts it.

* **Search** — Finds files and folders by name, and notes by their title too (the row then shows the title beside the file name), so a note is found by what the user called it.
* **+ (New note or folder)** — A note or a folder at the vault's top: a new note opens in a Document tab with its title ready to type; a new folder shows with its name ready to type. The same two are on the right-click menu of the empty space below the files, and a folder's right-click menu makes them inside that folder.
* **Sort By** — Name, Date Modified, Type or Size, ascending or descending, or None (the order the user dragged the files into; files never dragged follow, by name). Names sort as File Explorer does: "Chapter 2" before "Chapter 10", case and accents aside.
* **Group By** — Lists the files group by group, each group in the Sort By order: names by their first letter, dates by day, sizes by File Explorer's bands (Empty, Tiny, Small, Medium, Large, Huge, Gigantic), types by extension (boards apart from other JSON). Folders lead, by name. While a Group By is on, dragging to reorder is off.
* **Collapse All** — Collapses all folders and subfolders in the vault.
* **Expand All** — Expands all folders and subfolders in the vault.

The sidebar shows **filenames**, not note titles (see **Note titles** in the Data Model). Right-clicking an item offers, among others:

* **New note / New folder** *(folders only)* — Makes a note or a folder inside the folder (see **+** above).

* **Copy link to note / Copy link to board** *(a note, or a board Filo has loaded)* — Puts a link to it on the clipboard (see **Links** under General Features).

* **Rename** — Renames the file or folder. Characters that aren't allowed in filenames are blocked with an inline message. Renaming a note's file never changes its title, and every board tile pointing at it follows the new path.
* **Rename file to match title** *(notes only)* — Renames the `.md` file to its current title (with the same character rules as creation). Undoable.
* **Delete file / Delete folder** — Moves the item to Filo's trash and removes the tiles that showed it from every board; undoable. See **File Deletion Handling** in Architecture.

## Boards

* **Mind Map** — An "infinite" canvas that the user can navigate by clicking and dragging their mouse. The user can also zoom in and out of the board by scrolling on their mouse wheel. The user can make selections by holding Ctrl and clicking on tiles or by dragging a selection box around tiles.
* **Kanban** — A column-based board for managing workflows. The board displays a horizontal row of columns (e.g., Backlog, In Progress, Review, Done). Each column contains vertically stacked tiles that can be dragged between columns. Kanban boards support Text, Audio, Image, File, and Link tile types. Users can add, rename, reorder, and delete columns. Text tiles display their title, tags, and a content preview. Tiles can be opened as a Document board for full editing.
* **Task List** — A structured list view for tracking tasks. Unlike Mind Map and Kanban boards, the Task List does not use the spatial tile UI — tasks are displayed as flat rows in a list. Each task row shows a checkbox, title, tags, due date, and priority. Tasks can be grouped by frontmatter properties (status, priority, category) inside their sections and sorted by any property or date. Clicking a task opens it as a Document board for full Markdown editing. Tasks are backed by `.md` files with metadata stored in YAML frontmatter.
    * **Keys and ranges follow the screen.** The arrow keys, Tab (indent under the row above), Shift-click ranges and Ctrl+A follow the rows as drawn (the sort, the groups, sections in order), and leave out a folded section's rows and a folded parent's subtasks.
    * **Quick add** files a task where Add Task does (the section last added to, else the first), opening a folded section first; when a filter hides the new task, a notice says where it went. It reads `today`, `tomorrow`, `next fri` (a weekday's name or its usual short name only: "next month" is text), `in 3d`, an ISO date, and `5/12` as the title's last word ("act 2/3 of the book" keeps its fraction), with a time after the date ("tomorrow 5pm", "fri at 9:30am"), repeats (above), `!priority`, `#tag` (a tag needs a letter: "Chapter #3" keeps its number) and `=status`.
    * **The date picker** opens with focus on the task's day (else today): the arrows move a day or a week, Home / End to the week's ends, Page Up / Page Down a month, Enter picks, Escape closes, and focus goes back to the row. The week starts on the OS regional format's first day, and each day is read out in full. Its time box saves once (Enter, leaving it, or closing the picker). D on a row opens it.
    * **Dates read the same everywhere**: every chip, menu and message shows a day in the OS regional format (`12 Oct`, with the year when it isn't this year's).
    * **Folding a section** is an undo step, as folding a Kanban column, a frame or a task's subtasks is.
    * **An open notes box** follows its note while the user hasn't typed in it, so it never shows, or saves, an older version.
* **Document** — The Document board is a maximised view of a single `.md` file using the same Tiptap editor as text tiles. It provides a distraction-free writing environment with the full formatting toolbar and separates text with a purely visual page layout (see **Pages** below). See the **Text Tile / Document Board Relationship** section in the Data Model.
    * **Pages** — The note is laid out on page cards with A4's proportions at the page's width, one under the other with a gap between them. A block (paragraph, heading, list item, code block, table, task) that would run past a page's bottom margin starts the next page; a horizontal rule is never moved. The pages are drawn only: the note is one flow of text, its file holds no page breaks, and typing, the caret, selection, copy and undo cross from one page to the next as on one sheet. A block taller than a page's text area (a very long paragraph, table or code block) isn't split: its page grows to hold it. Global Defaults → Document → **Page Layout** switches between **Pages** (the default) and **One continuous sheet**. The Raw view is always one sheet.
    * **Zoom** — A control in the bottom-right corner of the tab (−, the level, +) zooms the page from 50% to 200%; clicking the level returns to 100%. Ctrl+= / Ctrl+− / Ctrl+0 do the same while a Document tab is focused, and Ctrl+wheel (or a touchpad pinch) over the page zooms a level at a time. Zoom is one level for every note, kept in `.filo/workspace.json`, and changes only how large the page is drawn: the text wraps as it does at 100% while the window has room for the page.
    * **Tag row** — At the top of the note, above the text, the note's tags show as chips with an input for adding more (comma-separated, with autocomplete). See **Tag System** in the Data Model.
    * **Raw view** — A **Raw** toggle shows the whole file as plain text, frontmatter included, for editing exactly what is on disk; **Formatted** switches back. The text box colours the Markdown, numbers the lines, shows invisible characters (a zero-width space, a stray BOM, a control character) and finds inside the note (Ctrl+F); it never changes the text by itself, and Tab leaves it. It saves 1.5 s after typing stops, when the text box loses focus, on Ctrl+S, when switching back, when switching to another tab and when the tab closes; switching or closing asks first when the text can't be saved (Cancel stays on the tab). While it has no unsaved changes it follows changes made elsewhere; text it loads from disk clears its undo history, so Ctrl+Z never mixes the two versions. A save lands only if the file hasn't changed since the raw view loaded it; otherwise nothing is written and a banner offers **Use the new version (discard mine)**, which first keeps a copy of the typed text in `.filo/recovery/`, or **Keep mine** (which first backs the other version up there). The file's BOM and line endings are kept. The raw view is read-only for a non-UTF-8 note. It stays editable for a note the rich editor opens read-only because it can't reproduce its formatting, since raw text never passes through the rich editor.
    * **Title** — Renaming the Document tab edits the note's `title:`; it never renames the file.

### Tiles

Tiles are the main way that the user interacts with the tool. Tiles can be created via the "+ New Tile" button in the Board Specific Side Toolbar or by dragging and dropping a file from the user's computer onto the canvas. Tiles have a Tile Header and a Tile Body. Tiles have a minimum size based on the size of the tile title and header buttons; there is no maximum size. When content exceeds the tile body's visible area, a vertical scrollbar appears on the right side of the tile. The user can also manually resize the tile larger to fit the content. The Tile Header contains:

* Tile Title (Text)
* Tags (Button)
* Tile Lock (Button)
* Tile Style (Menu Pop-up)
* Expand to Document (Button(Text Tile Exclusive))
* Delete Tile (Button)

* **Tile Title** — The Tile Title is a text field that can be edited by the user. It is located in the top left corner of the tile header. The Tile Title can be edited with the Toolbar's text formatting options. For a text tile it is the note's title: frontmatter `title:`, or the filename stem if the note has none (see **Note titles** in the Data Model). When a new note is created, its filename is derived from the title once. Editing the title later changes only the note's `title:` line and doesn't rename the file (except the first title of a note still under its placeholder name, see **Note titles**), so no board references change; the new title shows on every board at once. Use **Rename file to match title** in the Vault Sidebar to align the filename. Formatting on the title is stored per board and hidden once the title text changes elsewhere. Board-only tiles (Link, Iframe, Timer) keep their title in the board file.

* **Tags (Button)** — When the tags button is clicked by the user it opens a pop-up with a text field where the user can input the tags they want a tile to have this is comma separated. For a text tile, tags are written to the note's frontmatter `tags:`; for a media or file tile, to `.filo/tags.json`; for a Link, Iframe or Timer tile, to the tile in the board file. When submitted tags are put in the bottom left corner of a tile, they can be clicked which opens the **Tag Context Menu**.
    * **Tag Context Menu** — Clicking a tag displayed on a tile opens a contextual menu showing all other tiles that share that tag. The menu lists each tile's Title, Board Name, and all tags on that tile. Clicking an entry navigates directly to that tile. This is a lightweight, contextual version of the full Tags Browser (accessible from the Side Toolbar's View dropdown), which offers additional management features such as renaming, recolouring, fading, and deleting tags across the entire vault.

* **Tile Lock (Button)** — This button locks the tile in place on the board. When a tile is locked it cannot be moved or resized. It can be unlocked by clicking the button again.

* **Tile Style (Menu Pop-up)** — Per-tile style overrides using the Standard Element Style Properties (see Defaults in Settings) plus Shape (Dropdown: Rectangle or Rounded). Per-tile values override both Current Board Settings and Global Defaults (see override cascade in Settings).

* **Expand to Document (Button(Text Tile Exclusive))** — Opens the tile's backing `.md` file as a full-page Document board in a new tab. See the **Text Tile / Document Board Relationship** section in the Data Model.

* **Delete Tile (Button)** — Removes the tile from the current board. For a text tile, the confirm also offers "Delete associated file from vault as well?", which moves the `.md` file to Filo's trash. (A media file is deleted from the Vault Sidebar.) See **File Deletion Handling** in Architecture for how deletions propagate.

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

Frames are selectable objects that can be placed on a board, they are used to group tiles together. Frames have a header and a body, the header is where the user can input the frame title and the body is where the user can add tiles to the frame. The user can add tiles to a frame by dragging and dropping them into the frame. The user can remove tiles from a frame by dragging and dropping them out of the frame. Frames can also be moved around the board by dragging and dropping them everything in the frame moves with it, frames drawn inside it included (with their tiles); each tile moved then belongs to the frames it lands in, and one undo puts it all back. A frame inside another is drawn above it, whichever was made first. Frames can also be resized by dragging and dropping the corners of the frame.

* **Frame Collapse** — The collapse button collapses the frame, hiding the body of the frame and resizing it to only show the header. All of the tiles within the frame are also hidden when the frame is collapsed.
* **Frame Title** — The title of the frame, the user can edit this by clicking on it and typing in the new title.
* **Frame Style** — Per-frame style overrides matching the Frame Defaults (see Defaults in Settings). Includes Standard Element Style Properties plus Frame Background Image and Frame Background Opacity.
* **Frame Delete** — The delete button deletes the frame. Tiles are not deleted and stay in place where they were.

### Templates

Templates capture reusable structure that can be inserted into the current board. Filo supports two kinds of template, both surfaced through the same Template Browser.

* **Layout Templates** — Capture the *structure* of a selection of Mind Map tiles: each tile's type, size, position (relative to the selection's bounding box), and full style settings. They deliberately do **not** capture content: titles, body content, tags, lock state, file references (`src` / `url` / `filePath`), and the contents of any backing `.md` file are all stripped. Layout templates persist as `.template.json` files inside `<vault>/.filo/templates/`.
    * **Save as Template** — Right-click a tile or multi-tile selection on the Mind Map and choose **Save as Template**. Filo prompts for a name (uniqueness-checked) and saves the layout. Type-specific configuration that isn't content — for example a Timer tile's `duration` and `mode` — is preserved.
    * **Insert** — Right-click empty canvas and choose **Insert Template**, or press **Ctrl+T**, to open the Template Browser. Inserting a layout template re-creates the structure with fresh tiles: every tile gets a new id, and each Text tile (or group of tiles that shared one note) gets a new empty `.md` file at a fresh path, named via the normal tile-naming sequence with `title:` in its frontmatter, and the whole batch lands as a single undo step. When invoked from the canvas right-click, the layout anchors to the click position; when invoked via Ctrl+T, it lands centred in the viewport.
* **Markdown Templates** — Plain Markdown files in a configurable vault folder (default `Templates/`) with `{{title}}`, `{{date}}`, `{{time}}`, `{{datetime}}`, `{{year}}`, `{{month}}`, `{{day}}` variable substitution. Every board makes a note from a template the same way (the Mind Map's Template Browser, a Kanban card's **From Template…**): the template's frontmatter is kept, every key of it (`boardType`, a picker hint, aside), with the variables filled in wherever it holds text; the note's title is the template's own `title:` (filled in), else the template's name; the body is filled in too. On the Mind Map the new tile goes where the menu was opened, or the middle of the view, clear of the tiles there.
    * **Board templates** — A Markdown template may also embed a fenced ```` ```filo-board ```` block; instantiating it creates an entirely new board, named after the template and the day. The block is JSON: `type` (`mindmap`, `kanban` or `tasklist`), `settings`, and the board's skeleton — `columns: [{ "title": "To do", "cards": ["Outline", { "title": "Draft", "body": "…" }] }]` for a Kanban board, `sections: [{ "title": "Monday", "tasks": [ … ] }]` for a Task List, `tiles: [{ "title": "Hero", "x": 0, "y": 0, "width": 300, "height": 200, "body": "…" }]` for a Mind Map. Each card, task and tile gets a note of its own in the board's folder (titles and bodies filled in). The template's own text, outside the block, goes into the first of them without text, or into a note of its own, titled after the template, first on the board. A block that can't be read makes no board and says so; at most 200 notes are made.
* **Template Browser (Ctrl+T)** — Unified picker with two sections. The **Layout Templates** section is a grid of cards showing an SVG mini-preview of each layout (rectangles coloured to match each tile's style), along with rename and delete actions. The **Markdown Templates** section lists `.md` templates from the vault. A single search input filters both sections.

### Tabs

Tabs are used to organize the user's boards. Each tab represents a different board. When the user clicks the "+ New Tab" button in the tab bar they are prompted to select the board type they would like to create and the name of the board. **Document** makes a new note in the Root Directory and opens it (see **Text Tile / Document Board Relationship**).

* **Tab Bar** — The tab bar is located at the bottom of the screen and is permanently visible. If all tabs are closed the tool defaults to blank screen with a message in the centre that says "Open a Tab to get started". The tab bar displays all the tabs that are currently open and can be used to switch between tabs. Users can double click on the tab name to rename the tab, tabs can be closed by clicking a small "x" next to their name. Closing a tab does not delete it.

* **Split Panes** — Users can drag a tab to the left or right edge of the workspace to create a side-by-side split view. This allows referencing one board while working on another, or dragging tiles between boards. Splits can be horizontal or vertical and are resizable. A maximum of 3 panes can be open simultaneously. The same board can be opened in multiple panes. Undo/redo applies to whichever pane the user is actively editing — each pane targets its board's independent undo stack. A pane becomes the active one when the user clicks in it or the keyboard focus moves into it (Tab). If a board displayed in a split pane is deleted from the Vault Sidebar, that pane is automatically closed. Split layout state is persisted in `.filo/workspace.json` and restored on next launch.

* **Board Browser** — The board browser is a button that opens a pop-up menu from which the user can view all of their boards. It is located in the bottom left corner of the screen and in line with the Tab Bar. The Board Browser is a list of all the boards that currently exist in the user's vault. From this list the user can open a new tab for a board, rename boards, create new board and delete boards (a deleted board moves to Filo's trash; its notes stay in the vault, and it can be restored from the toast's Undo or Settings → Trash). The user can also drag and drop boards to re-organize them in the browser, they can also CTRL + Click to select multiple boards. There is a search bar at the top of the board browser that allows the user to search for boards by name, the board browser also has a scroll bar if the user has more boards than can fit in the browser window. The Board Type is listed next to the name of the board in the browser.

## General Features

* **Links** — A link in a note can open a web page, or a board, a tile, card or task, or a note in the vault. **Copy link to …** (on a tab, a tile, a card, a task, and a note or board in the vault sidebar) puts the link on the clipboard twice over: as its address (`filo://board/<id>`, `filo://tile/<board id>/<tile id>`, `filo://note/<path>`) and as a link reading the name of what it opens, so pasting it into a note makes a named link, and pasting it into Insert Link's address box (Ctrl+K) gives the address. A click follows a link; in a note being edited, Ctrl+click does. A link to a note names its path, so it no longer opens the note once the note is renamed or moved (KNOWN_LIMITATIONS #52). Main writes the clipboard; the page itself may not (the permission policy).

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
* **Toast Notifications** — Non-blocking notification messages used for confirmations (e.g. save), errors, and user prompts (e.g., external edit conflicts). Toasts display at the top centre of the board workspace, directly below the Global Toolbar. Every toast closes on its own after **at most 15 seconds** (a shorter duration can be set; a longer one is capped), with three exceptions that stay until the user acts:
    * **Sticky decision prompts** that aren't holding up a write — the note prompts ("Reload" / "Keep mine" on a changed note, "Keep mine" / "Discard" on a deleted one). A newer prompt for the same file replaces the older one, so they can't stack.
    * **Error toasts** without an explicit duration (e.g. a failed save, or where a recovery copy was put), because the failure outlasts any timer.
    * **The Undo of a vault-wide tag delete or rename**, which touches many files and is on no board's Ctrl+Z: it stays until dismissed or until the next tag action's toast replaces it.

  A **promise-backed** decision — one a pending write is waiting on, such as the board "Reload" / "Keep local" prompt — can never be sticky. It closes after 15 seconds and resolves as "defer": nothing is written, and it asks again on the next save. Other toasts that offer **Undo** use the cap too: 10 seconds for "moved to Filo's trash" (which Settings → Trash backs up). Toasts stack vertically in a column — newer toasts appear below existing ones. A maximum of 8 toasts are visible at once; if the limit is reached, the oldest plain notification is dismissed first. See the **Animations** section for entrance/exit transitions.

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| Ctrl + N | New Tile (Mind Map), New Card (Kanban), New Task (Task List), New Note beside the open one (Document tab) |
| Ctrl + T | Insert Template |
| Ctrl + Z | Undo |
| Ctrl + Y, Ctrl + Shift + Z | Redo |
| Ctrl + S | Save |
| Ctrl + O | Open Vault (from Home or an open vault) |
| Ctrl + Shift + W | Close Vault |
| Ctrl + , | Settings |
| Ctrl + W | Close Tab |
| Ctrl + Tab, Ctrl + Shift + Tab | Next / Previous Tab |
| Ctrl + G | Group/Ungroup |
| Ctrl + L | Lock/Unlock Selected |
| Ctrl + A | Select All |
| Ctrl + K | Insert Link |
| Ctrl + Shift + F | Vault-wide Search |
| Ctrl + Shift + T | Tags Browser |
| Ctrl + =, Ctrl + −, Ctrl + 0 | Zoom in, zoom out, zoom to 100% (Document tab) |
| N | New tile beside the selected tile, or in the middle of the view (Mind Map) |
| C | Start a connection from the selected tile (Mind Map) |
| Enter | Rename the selected tile (Mind Map) |
| Backspace | Remove the selected tiles from the board (Mind Map): the same confirm as Delete, which also offers to move their notes to Filo's trash |
| Arrow | Select the nearest tile in that direction (Mind Map) |
| Ctrl + Shift + Arrow | Add the nearest tile in that direction to the selection (Mind Map) |
| Ctrl + Arrow | Move the selected tiles (Mind Map) |
| Shift + Drag | Area Selection |
| Delete | Remove Selected |
| Escape | Cancel Action |
| Alt + Click | Open in Split Pane |

Every shortcut registered as a command is listed in Help → Shortcuts and can be rebound there; overrides are stored in `.filo/hotkeys.json`. The Mind Map's N, C, Enter and Backspace are commands like the others (`mindmap:new-tile`, `mindmap:connect`, `mindmap:rename-tile`, `mindmap:remove-tiles`). They, Delete and the arrows act on the Mind Map only while focus is on its canvas or a tile on it (a click on the empty canvas gives it focus): typed on a sidebar row or a toolbar button they do nothing there. There is no native application menu: these shortcuts replace it.

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

#### Tile Highlight (`tile-nav-pulse`)
- **Duration:** 0.8s ease-in-out, twice
- **Effect:** An accent ring that grows out from the tile and fades
- **Trigger:** A tile navigated to (Find, a search result, a link to a tile, a waypoint), within its 2 s highlight

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
- **Prevention:** The native browser/Electron context menu is suppressed via `e.preventDefault()`, except on editable text (a note, a title being edited, a text field), which gets Filo's **text menu**, built by the main process: the spelling suggestions and **Add to Dictionary** on a misspelled word, then **Cut**, **Copy**, **Paste** and **Select All** (each enabled as the text allows), and in a note's text **Insert Link…** (**Edit Link…** on a link), which opens the Insert Link popup where the menu opened. Text selected in an embedded page offers **Copy**.

### Menu Items — Mind Map Board (Canvas)

Right-clicking on the **canvas background** (no element selected):

| Item | Icon | Shortcut | Action |
|---|---|---|---|
| New Tile | `icon-plus` | Ctrl+N | Creates a default text tile at the right-click position, its title selected for typing |
| Insert Template | `icon-file-text` | Ctrl+T | Opens the Template Browser; the layout anchors to the right-click position |
| Save as Waypoint | `icon-map-pin` | — | Saves the current canvas position as a named waypoint |
| ─── | Divider | | |
| Select All | `icon-select-all` | Ctrl+A | Selects all tiles on the board |
| Orphan Catcher | `icon-search` | — | Highlights orphaned and empty tiles for review and cleanup |

### Menu Items — Mind Map Board (Tile Selected)

Right-clicking on a **tile** (or with tiles selected):

| Item | Icon | Shortcut | Action |
|---|---|---|---|
| Copy link to tile | `icon-link` | — | One tile only: puts a link to it on the clipboard (see **Links**) |
| Style | `icon-palette` | — | Opens the tile style popup (colours, shape, border) |
| Tags | `icon-tag` | — | Opens the tag editor for the selected tile |
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
| Add card | `icon-plus` | Adds a new card at the bottom of this column, its title ready to type |
| Rename Column | `icon-edit` | Focuses the column title for inline editing |
| Collapse / Expand | `icon-chevron-down` / `icon-chevron-right` | Toggles column collapse state |
| Set WIP Limit… | — | Opens an inline editor to cap the column at N cards (clearing the cap removes the limit) |
| ─── | Divider | |
| Delete Column | `icon-trash` | Removes column and drops its tile placements (danger action; the underlying `.md` files are preserved) |

Column reordering is performed by drag (pointer) or **Alt+ArrowLeft / Alt+ArrowRight** with the column title focused (a11y). The dedicated "Move Left / Move Right" context-menu rows present in the V5 design have been removed — the drag handle and keyboard shortcut cover both use cases.

### Menu Items — Kanban Board (Tile)

The Kanban tile right-click menu is intentionally minimal in the V7 implementation. Style, Tags and lock live on the tile's own TileHeader (visible on hover/focus) — duplicating them in the right-click menu would just be noise. The Mind Map context menu is richer because canvas tiles support actions (auto-layout, grouping, connection mode) that don't apply to a column-bound flow layout.

Right-clicking on a **text tile within a Kanban column**:

| Item | Icon | Action |
|---|---|---|
| Open as Document | `icon-expand` | Opens the tile's `.md` file as a Document board in a new tab (also wired to double-click on the card body) |
| Copy link to card | `icon-link` | Puts a link to the card on the clipboard (see **Links**) |
| ─── | Divider | |
| Remove from Column | `icon-trash` | Drops the placement from this column (danger action; the underlying `.md` and any other placements are preserved) |
| ─── | Divider | |
| Move to column | heading | The board's other columns, one item each: moves the card to the end of that column (undoable) |

Non-text tiles (image / audio / file / link) get a single "Remove from Column" item — they don't back to a `.md` file so "Open as Document" doesn't apply.

### Menu Items — Task List Board (Task Row)

Right-clicking on a **task row**:

| Item | Icon | Action |
|---|---|---|
| Open as Document | `icon-expand` | Opens the task's `.md` file as a Document board in a new tab |
| Copy link to task | `icon-link` | Puts a link to the task on the clipboard (see **Links**) |
| Tags | `icon-tag` | Opens the tag editor for the task |
| ─── | Divider | |
| Toggle Complete | `icon-check` | Toggles the task's completed state |
| ─── | Divider | |
| Delete Task | `icon-trash` | Removes the task from the list (danger action); its `.md` file stays in the vault |
| Delete Task & File… | `icon-trash` | Removes the task and moves its `.md` file to Filo's trash (danger action, confirmed; undoable) |

### Menu Items — Document Board

Right-clicking within the **Document board editor area** (or a text tile's or card's text being edited) shows the text menu (see **Trigger Behaviour**): spelling, Cut, Copy, Paste, Select All, and:

| Item | Icon | Action |
|---|---|---|
| Insert Link… / Edit Link… | — | Opens the Insert Link popup (as Ctrl+K does) |

Templates are inserted from the Template Browser (Ctrl+T on a Mind Map), not from this menu.

### Menu Items — Tab Bar

Right-clicking on a **tab**:

| Item | Icon | Action |
|---|---|---|
| Rename Board | `icon-edit` | Focuses the tab name for inline editing |
| Set Board Icon | `icon-smile` | Opens the icon picker for the tab |
| Copy link to board / note | `icon-link` | Puts a link to the tab's board, or (a Document tab) its note, on the clipboard (see **Links**) |
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
* **Raw view:** CodeMirror 6, loaded when a Raw view first opens
* **Storage:** File system (vault folder on user's disk) — Node.js fs
* **Data Formats:** Markdown (.md) for tiles/documents, JSON (.board.json) for boards, JSON for configuration
* **Canvas:** Custom infinite canvas with rbush spatial indexing. Pan, zoom, drag, resize, and edge-pan are implemented as raw pointer-event handlers in `src/renderer/lib/canvas/`.
* **Markdown Processing:** markdown-it is the one Markdown parser in the app: the editor reads and writes notes through it (via tiptap-markdown, see Editor section), and Kanban card previews and plain-text paste use it too. The VaultIndex doesn't parse Markdown. The `yaml` package is the one frontmatter parser, and writes patch the frontmatter source key by key through its CST, so untouched keys, comments and quoting survive byte-for-byte. dompurify for HTML sanitisation. The tests also read saved notes with micromark, as a second parser, to check the content reads the same outside Filo; it is never part of the app.
* **Full-Text Search:** The Search panel matches titles, tags and note bodies over the VaultIndex itself (plain text or regular expressions, with Match case and Whole word); there is no separate search engine. MiniSearch only filters template titles in the Template Browser.
* **Drag-and-Drop:** svelte-dnd-action — Svelte-native sortable list library for Kanban column reordering, tile ordering within columns, task list reordering, and cross-container dragging. Canvas-level tile dragging uses the custom canvas implementation (not svelte-dnd-action).
* **Metadata Indexing:** Custom VaultIndex (frontmatter read with the `yaml` package). Zod validates board files, `.filo/` configuration and IPC payloads.
* **Utilities:** nanoid (ID generation), focus-trap (modal focus management)
* **Editor Extensions:** Custom Tiptap extension for `#tags`
* **Module System:** TypeScript interfaces with registry pattern for tiles, boards, and commands
* **Testing:** Vitest: unit and component tests in jsdom; the editor and Raw view specs also in headless Chromium (Vitest's browser mode); a characterisation suite that mounts the whole app against a real temporary vault with the real main-process handlers. Playwright drives the built Electron app (E2E, with an axe-core accessibility scan).

## Technical Considerations

**Platform:** Desktop (Windows, macOS, Linux). Mobile is out of scope for v1 — see Architecture > Application Shell.
**Responsive:** Yes, desktop-first
**Performance:** Page load < 3 seconds. The in-memory VaultIndex enables fast structured and full-text search across large vaults. Spatial indexing (rbush) ensures canvas performance with hundreds of tiles.
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
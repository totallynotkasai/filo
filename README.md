# Filo

A local-first, visual-first Personal Knowledge Management desktop app.
Mind maps, kanban boards, task lists, and documents — one tool, your
files on your disk, no accounts, no cloud.

## Why

Your notes are Markdown. Your boards are JSON. Open a vault folder in
any text editor and everything is readable. Move it to OneDrive,
Dropbox, or a USB stick — it still works. No lock-in.

## Quick start

### Install (end users)

Grab the latest installer from the [releases page](#) for your
platform:

- Windows: `Filo-Setup-x.y.z.exe` (NSIS installer)
- macOS:  `Filo-x.y.z.dmg`
- Linux:  `Filo-x.y.z.AppImage`

Launch the app, pick a folder to use as your vault, and start adding
boards.

### Build from source

```bash
git clone <repo-url>
cd "Filo - From Scratch"
npm install
npm run preview      # build into dist-preview/ and run it (see below)
npm start            # run the last dist-preview/ build again
npm run dev:scratch  # development with hot reload, on a scratch profile
npm run build        # production build to dist/ (what the tests drive)
npm run package      # build + electron-builder for current platform
npm run package:win  # Windows NSIS only
npm run package:mac  # macOS DMG only
npm run package:linux # Linux AppImage only
```

Installers land in `release/`.

### Running Filo day to day

Use a built copy for real work, never the dev server.

1. When a change has landed, close Filo and run `npm run preview`. It builds
   the app into `dist-preview/` and opens it on your own profile, with your
   recent vaults.
2. On other days, run `npm start`. It opens that same build again without
   building, so work still under way in this folder never reaches the copy
   you use.
3. Settings shows which build is running, at the foot of its tabs:
   `Filo 0.2.1 (f830c42)` is version 0.2.1, built from commit `f830c42`. A
   `+` after the commit means the build also held changes not yet committed.

Or install it: run `npm run package:win`, then `release/Filo Setup <version>.exe`.
An installed copy is apart from this folder altogether.

**Why not `npm run dev`:** the dev server reloads the window when a source
file changes, for instance when another Claude session edits Filo's code. A
reload skips everything Filo does when it closes: typing not yet saved,
pending board writes, the copies it keeps of unsaved work, changes waiting
for your answer and the undo history are all lost.

**Why its own folder:** `npm run build` and the test suites rebuild `dist/`.
Filo loads some of its code (the Raw view, Replace, the Tags Browser) only the
first time you use it, and a rebuild deletes the files a running copy would
load. Nothing but `npm run preview` writes `dist-preview/`.

**For development,** `npm run dev:scratch` runs the dev server on a scratch
profile (`%APPDATA%\filo-dev`), so it opens none of your vaults; open a test
vault from Home. Plain `npm run dev` uses your own profile and reopens your
last vault.

### First run

1. Click **Open Vault** on the home screen.
2. Pick any folder. Filo creates a hidden `.filo/` directory there for
   workspace state and never touches files outside the vault.
3. Right-click the canvas to add a tile, or use the side toolbar to
   create a new board.

## Boards

| Board     | Best for                                       |
|-----------|------------------------------------------------|
| Mind Map  | Free-form ideas, infinite canvas, connections  |
| Kanban    | Status-tracked work (To do / Doing / Done)     |
| Task List | Linear / hierarchical task tracking            |
| Document  | Long-form writing on a single `.md` file       |

Same `.md` file can appear on multiple boards. Edits sync everywhere
because the file system is the single source of truth.

## Tile types

Text, Image, Video, Audio, File, Link, Iframe, Timer.

Drag any file from your OS into the canvas — Filo picks the right tile
type, copies the file into the vault (the board's own folder, else the
Root Directory you picked in the sidebar, else the vault root), and
creates a tile.

## Keyboard

Most shortcuts are rebindable in **Settings → Keyboard Shortcuts**.
Defaults:

- `Ctrl+Z` / `Ctrl+Shift+Z` — Undo / Redo (per board)
- `Ctrl+T` — Insert from template
- `Ctrl+Shift+F` — Find & Replace (with `tag:`, `type:`, `board:`, `/regex/` operators)
- `Ctrl+N` — New tile
- `Ctrl+Shift+T` — Tags Browser
- `Ctrl+Shift+W` — Close the vault

## Tech

- **Electron** + **Svelte 5** (runes) + **TypeScript** + **Vite**
- **TipTap** + **tiptap-markdown** for rich text ↔ Markdown round-trip
- **CodeMirror 6** for a note's Raw view
- **rbush** for spatial indexing on the canvas
- Search over an in-memory index of the vault's notes (no search engine)
- Custom pointer-event canvas engine (pan, zoom, drag, edge-pan, snap)
- Vanilla CSS — no Tailwind, no preprocessors

See [`CLAUDE.md`](CLAUDE.md) for architecture, conventions, and
development guide. See
[`Filo_Design_Doc_Rework_V5.md`](Filo_Design_Doc_Rework_V5.md) for the
full specification.

## Licence

TBD.

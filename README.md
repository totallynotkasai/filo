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
npm run dev          # development with hot reload
npm run build        # production build to dist/
npm run package      # build + electron-builder for current platform
npm run package:win  # Windows NSIS only
npm run package:mac  # macOS DMG only
npm run package:linux # Linux AppImage only
```

Installers land in `release/`.

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

# Filo vault format: a guide for AI agents

This guide is for an AI agent that writes into a Filo vault: notes with the right frontmatter and formatting, and boards (Mind Maps with tiles, connections and frames; Kanban boards; Task Lists). It describes Filo 0.2.11 and board format version 8.

Filo treats what you write exactly as it treats the user's own edits. Two things decide whether your work shows up as you meant it:

1. **Notes must use the spellings Filo writes itself.** A note Filo couldn't save back unchanged opens **read-only**: the user sees a banner and can't type in it until it is fixed.
2. **Boards must pass Filo's checks.** One bad value (a repeated id, a missing number, a connection to a tile that isn't there) and the board doesn't load at all. Filo never writes over a board it couldn't load, so nothing is lost, but nothing shows either.

Read section 1 before writing anything. The checklist in section 11 is worth running before you finish.

## Contents

1. Rules that matter most
2. What a vault looks like
3. Notes: frontmatter, file names, the body, links
4. Board files: the envelope, tile defs, styles
5. Mind Map boards: placements, layout, connections, frames, groups, waypoints
6. Kanban boards
7. Task List boards
8. Tag colours
9. Working while Filo is open
10. Board templates
11. Checklist
12. A complete example

---

## 1. Rules that matter most

1. **A note's own file is the only home of its title, tags, fields and text.** A board file never holds them: it points at the note by path, and holds only where the note sits and how it looks.
2. **Paths are vault-relative, with forward slashes**: `Plot Breakdown/Act I/Opening.md`. Never an absolute path, never `\`, never `..` out of the vault.
3. **Write the notes first, then the board.** A tile whose note doesn't exist yet shows as broken.
4. **Write formatting only in the spellings in section 3.3.** Any other HTML, or a listed form spelled differently (a `#hex` colour, a missing `;`), makes the note read-only.
5. **Every id is unique**, and uses only `A–Z a–z 0–9 _ -`. Board ids are unique across the vault. Tile, connection, frame, column, section, group and waypoint ids are unique within their board. Filo's own ids are 12 random characters (`H_O_2TOWdCLV`); short readable ones (`t_opening`) work too. The examples here use readable ones.
6. **A board's name is its file name.** `Plot Breakdown.board.json` is the board "Plot Breakdown". Set `board.name` to the same text.
7. **Leave Filo's own folder alone.** Don't edit `.filo/`, except `.filo/tags.json` if you want to give tags colours (section 8).
8. **Save text as UTF-8.** LF or CRLF line endings are both fine, and so is a BOM. Another encoding opens read-only.
9. **Filo may be open while you work.** It picks up your changes within a second or two. Read section 9 before changing a note or board the user might have open.

---

## 2. What a vault looks like

```text
My Vault/
├── Welcome.md                          a note on no board
├── Plot Breakdown/                     a board's own folder
│   ├── Plot Breakdown.board.json       the board (layout and looks only)
│   ├── Opening.md                      notes shown as tiles on it
│   └── Act I/Arrival.md
├── Attachments/garden.png              media: images, video, audio, any file
├── Templates/                          Markdown templates (section 10)
└── .filo/                              Filo's own state: don't edit (except tags.json)
```

- Any folder can hold notes and boards. Filo finds every `*.board.json` in the vault, at any depth.
- New vaults give each board its own folder, named after the board, with the board's notes inside it. `settings.defaultFolder` on the board names that folder, and the notes the user adds to the board go there. Do the same when you make a board.
- Folders and files whose names start with `.` are hidden from Filo.
- A note can be on any number of boards, or on none. Every view of it is the same file: edit it once and every tile, card and task showing it changes.

---

## 3. Notes

### 3.1 Frontmatter

A note may start with a YAML block between two `---` lines. Every key is optional.

```markdown
---
title: "Chapter 3: The Ferry"
tags:
  - plot
  - act-1/arrival
lineSpacing: 1.5
---

The ferry leaves at dawn.
```

| Key | Value | What it does |
| --- | --- | --- |
| `title` | text | The title shown on the note's tile, card, task row and tab. Without it, the title is the file name without `.md`. |
| `tags` | a list of text | The note's tags. A `/` makes a hierarchy: `act-1/arrival` sits under `act-1`. A leading `#` is dropped. |
| `lineSpacing` | a number, 0.8 to 4 | Line spacing for this note in every view. Without it, the vault's default applies (1.5 unless changed in Settings). |

**Task and card fields.** A Task List row and a Kanban card read these from their note. They are harmless on any other note.

| Key | Value | What it does |
| --- | --- | --- |
| `completed` | `true` or `false` | Done. Absent means not done. |
| `priority` | `urgent`, `high`, `medium` or `low` | Absent means no priority. |
| `dueDate` | `YYYY-MM-DD` | The due day (a local calendar day). |
| `dueTime` | `HH:MM`, 24-hour | A time on the due day. Only with `dueDate`. |
| `startDate` | `YYYY-MM-DD` | The start day. |
| `status` | `todo`, `in-progress`, `done`, or a word of your own | A Task List grouped by status uses it. Absent means To Do, and `completed: true` counts as Done whatever it says. Kanban ignores it: a card's column is its status. |
| `category` | text | A Task List grouped by category uses it. |
| `recurrence` | `daily`, `weekly`, `monthly`, `yearly`, `weekdays`, or `every N days` / `every N weeks` / `every N months` / `every N years` | A repeating task. Completing it moves `dueDate` on instead of marking it done. |
| `recurrenceMode` | `completion` | The next date counts from the day it was done. Absent means it counts from the due date. |

Filo writes `recurrenceAnchor` itself. Don't write it.

**Writing the block well**

- **Your own keys are kept.** Filo changes only the keys it edits and leaves every other line exactly as written, comments and order included. Add `source:`, `aliases:`, `pov:` or anything else you need. A Kanban saved view can filter on any key (section 6).
- **Quote titles.** Write `title: "…"` and escape a `"` inside it as `\"`. An unquoted title breaks on `: `, a leading `#`, `[`, `{`, `*`, `&` or `!`, and on words YAML reads as something else (`yes`, `no`, `null`, a number).
- **Dates need no quotes.** Filo reads YAML 1.2, where `dueDate: 2026-10-20` stays text.
- **Yes and no** are `true` and `false`, never `yes` and `no`.
- **No anchors, aliases or YAML tags** (`&a`, `*a`, `<<:`, `!!str`). Filo refuses to change a block holding them.
- **Tags as a list.** `tags: plot, draft` (one comma-separated text) is read too, but the list form is what Filo writes.
- Filo keeps whatever blank lines you leave between the closing `---` and the text.

### 3.2 File names

- **A note keeps its file name.** Changing `title:` later doesn't rename the file, so name the file after the title when you create it.
- **Not allowed in a name:** `< > : " / \ | ? *`, a leading dot, a trailing dot or space, the Windows device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, with any extension), and names over 255 bytes.
- **Do what Filo does:** replace each forbidden character with `-`, trim spaces and dots from both ends, and keep the real title in `title:`. For example, `Chapter 3- The Ferry.md` holds `title: "Chapter 3: The Ferry"`.
- Two files in one folder can't differ only by capitals (Windows treats `Notes.md` and `notes.md` as one file).

### 3.3 The body

Write Markdown (CommonMark, with GitHub's tables, strikethrough and checklists). Written the way below, a note opens editable and stays byte for byte as you wrote it until the user edits it.

#### Lines and gaps

Filo shows paragraphs with no space between them, the way a word processor shows lines:

```markdown
First paragraph.

Second paragraph, shown on the very next line.


Third paragraph, shown after one empty line.
Fourth line, inside the third paragraph.
```

- One blank line between two blocks puts the second on the next line, with no gap.
- Each extra blank line shows one empty line, a gap.
- A single newline inside a paragraph shows a line break, and is kept as a single newline.
- A line ending in `\` is a hard line break (what Shift+Enter makes).
- Headings, lists, quotes, code blocks and tables keep their own spacing.

#### Markdown

| Formatting | Write |
| --- | --- |
| Headings 1 to 6 | `# Title` to `###### Title`, with a blank line after |
| Bold, italic | `**bold**`, `*italic*` |
| Strikethrough | `~~gone~~` |
| Bullet list | `- item`; nest an item with two more spaces |
| Numbered list | `1. item`; nest an item with three more spaces |
| Checklist | `- [ ] open` and `- [x] done` |
| Quote | `> text` |
| Inline code | a word between backticks |
| Code block | a fence of three backticks above and below |
| Horizontal rule | `---` on its own line, with a blank line above it (without one, the line above becomes a heading) |
| Table | a GitHub pipe table, each cell one line of text (below) |
| Link | `[text](https://example.com)` |
| Image | `![what it shows](../Attachments/sketch.png)`, the path relative to the note's own folder |

Write a table's divider row with a space each side of every `---`, as Filo does:

```markdown
| Character | Role |
| --- | --- |
| Aria | Scout |
```

#### Colour, size, font, highlight and underline

Markdown can't say these, so Filo writes them as small pieces of HTML. Copy these spellings exactly: the spaces, the `;` after each property, and colours as `rgb(r, g, b)`. The same formatting spelled any other way looks right but opens the note read-only, because Filo would save it differently.

| Formatting | Write |
| --- | --- |
| Underline | `<u>text</u>` |
| Highlight (the default colour) | `<mark>text</mark>` |
| Highlight in a colour | `<mark data-color="#fff3a3" style="background-color: rgb(255, 243, 163); color: inherit;">text</mark>`, with the same colour as hex in `data-color` and as `rgb(…)` in `style` |
| Text colour | `<span style="color: rgb(192, 57, 43);">text</span>` |
| Font size | `<span style="font-size: 20px;">text</span>` |
| Font | `<span style="font-family: Georgia;">text</span>` |
| Font whose name has a space | `<span style="font-family: &quot;Times New Roman&quot;;">text</span>` |
| Several at once | one span, in the order colour, font, size: `<span style="color: rgb(192, 57, 43); font-family: Georgia; font-size: 20px;">text</span>` |
| Bold text in a colour | the span outside, Markdown inside: `<span style="color: rgb(192, 57, 43);">**text**</span>` |

#### Alignment and indent

A centred, right-aligned, justified or indented paragraph or heading is saved as one line of HTML. The formatting inside that line is HTML too: `<strong>`, `<em>`, `<s>`, `<u>`, `<a href="…">` and the spans above.

```markdown
<p style="text-align: center;">A centred line with <strong>bold</strong> and <a href="https://example.com">a link</a></p>

<h2 style="text-align: center;">A centred heading</h2>

<p style="margin-left: 48px;">Indented two steps</p>

<p style="text-align: right; margin-left: 24px;">Right-aligned and indented one step</p>
```

- `text-align` is `center`, `right` or `justify`. Left is the default, written as plain Markdown.
- The indent is `margin-left` in steps of 24px: `24px`, `48px`, and so on up to `192px` (8 steps).
- With both, `text-align` comes first.
- A line break inside an aligned paragraph is `<br data-filo-soft-break="">`.
- Write `<`, `>` and `&` inside these lines as `&lt;`, `&gt;` and `&amp;`.
- List items, checklist items and table cells can't be aligned or indented.

#### What to avoid

These open the note read-only:

- `<br>` (start a new line, or end the line with `\`)
- `<div>`, `<font>`, `<center>`, and any other HTML not listed above
- the listed forms spelled another way: a hex colour such as `color: #c0392b`, or `text-align: center` without its `;`
- inline code inside bold or italic text: Filo's editor can't hold it there. End the bold before the code and start it again after it, or leave the code plain

#### Tidying that is not a problem

When the user next edits a note, Filo writes a few things its own way: `*` bullets become `-`, a heading gets a blank line after it, a table at the end of the note gets a final newline. These don't change what the note says, and they don't make it read-only.

### 3.4 Links between notes, boards and tiles

Filo's own links are `filo://` addresses inside ordinary Markdown links. The user opens them with Ctrl+click.

| A link to | Write |
| --- | --- |
| A note | `[Arrival](filo://note/Plot%20Breakdown%2FAct%20I%2FArrival.md)`: the note's vault path, encoded whole as `encodeURIComponent` does (a space is `%20`, a `/` is `%2F`) |
| A board | `[Plot board](filo://board/<boardId>)` |
| A tile, card or task | `[The opening](filo://tile/<boardId>/<tileId>)` |
| A place on a Mind Map | `[The village](filo://position/<boardId>/<x>/<y>)` |

- A note link names the note by its path, so it stops working if the note is later renamed or moved. Renames don't rewrite links inside notes.
- `[[Wiki links]]` from other apps are kept as written, but in Filo they are plain text.
- `#word` in the text is plain text too. A note's tags are only the ones in `tags:`.

### 3.5 When a note opens read-only

Filo shows a banner naming the line it couldn't keep. The usual causes are HTML not listed in 3.3, a file that isn't UTF-8, or a note that is a symbolic link. Rewrite the line in a spelling from 3.3 and Filo opens it editable.

---

## 4. Board files

A board is one JSON file named `<Board name>.board.json`. Every board file has this shape:

```text
{
  "version": 8,
  "board":       { … },     the board: id, name, type, settings, and where things sit
  "tileDefs":    { … },     one entry per tile, card or task: which note or file it shows
  "connections": { … },     Mind Map arrows, keyed by connection id ({} on other boards)
  "frames":      [ … ]      Mind Map frames ([] on other boards)
}
```

- `version` is always `8`. Filo refuses a file with any other number.
- Write it as UTF-8 JSON. Filo indents with two spaces.
- Keys Filo doesn't know are kept on the board, its settings, placements, columns, sections, connections and frames. They are dropped from tile defs, inline tiles and style blocks.

### 4.1 Fields every board has

```text
"board": {
  "id": "pbBoard00001",
  "name": "Plot Breakdown",
  "emoji": "",
  "createdAt": 1792300000000,
  "updatedAt": 1792300000000,
  "type": "mindmap",
  "settings": { "defaultFolder": "Plot Breakdown", … },
  … the fields for its type (sections 5 to 7)
}
```

| Field | What it is |
| --- | --- |
| `id` | Unique across the vault. When two board files share an id, Filo loads one and refuses the other. |
| `name` | The file name without `.board.json`. |
| `type` | `mindmap`, `kanban` or `tasklist`. A note open by itself is a Document tab and needs no board file. |
| `createdAt`, `updatedAt` | Milliseconds since 1970 (`Date.now()`). Every object that has these takes the same kind of number. |
| `emoji` | Shown with the board's name. `""` for none. |
| `settings.defaultFolder` | The folder notes made on this board go in. Vault-relative, no `/` at either end; `""` is the vault root. |
| `settings.backgroundColor` | `#rrggbb`, or `""` for the theme's. |
| `settings.backgroundPattern` | `grid`, `dots`, `lines` or `none`. Leave it out to follow the vault's default. |

### 4.2 Tile defs

Every tile, card and task has an entry in `tileDefs`, keyed by its id, with the same id in its `id` field.

**A note** (a Mind Map text tile, a Kanban card, a Task List task):

```json
{
  "id": "t_opening",
  "type": "text",
  "filePath": "Plot Breakdown/Opening.md",
  "style": { "headerColor": "", "bodyColor": "", "borderColor": "" },
  "createdAt": 1792300000000,
  "updatedAt": 1792300000000
}
```

Only these keys. A text def has no `title`, `tags` or `content`: those are the note's, and Filo drops them from a def.

**An image** (Mind Map). `title` is the caption in the tile's header, and `src` is vault-relative (an image inside a note is relative to the note instead):

```json
{
  "id": "t_sketch",
  "type": "image",
  "title": "Layout sketch",
  "src": "Attachments/garden.png",
  "alt": "Top-down sketch of the garden",
  "style": { "headerColor": "", "bodyColor": "", "borderColor": "" },
  "createdAt": 1792300000000,
  "updatedAt": 1792300000000
}
```

- A `video` or `audio` def is the same with `"type": "video"` or `"audio"`, a `src`, and no `alt`.
- A `file` def shows any file and opens it in its own app: `"type": "file"` with `"filePath"` in place of `src`, and a `title`.
- A media file's tags live in `.filo/tags.json` (section 8), since the file has no frontmatter.

### 4.3 Styles

A def's `style` needs `headerColor` and `bodyColor`; `""` means the theme's colour. Everything else is optional, and a field left out follows the board's defaults, then the vault's:

| Field | Value |
| --- | --- |
| `headerColor`, `bodyColor`, `borderColor` | `#rrggbb`, or `""` |
| `shape` | `rectangle` or `rounded` |
| `borderStyle` | `solid`, `dashed` or `dotted` |
| `borderWidth` | 0 to 10 |
| `shadowIntensity` | 0 to 1 |
| `dynamicContrastText` | `true` picks black or white text to suit the colour behind it |
| `fontSizeTitle`, `fontSizeBody` | 8 to 48 (pixels) |

Frames, connections, Kanban columns and cards, and Task List rows and sections take the same kinds of fields; each section below lists them. To style a whole board at once, set `settings.defaults` on the board (sections 5.8, 6 and 7) instead of repeating a style on every element.

---

## 5. Mind Map boards

```json
{
  "id": "pbBoard00001",
  "name": "Plot Breakdown",
  "emoji": "",
  "createdAt": 1792300000000,
  "updatedAt": 1792300000000,
  "type": "mindmap",
  "settings": {
    "defaultFolder": "Plot Breakdown",
    "snapToGrid": false,
    "connectionsVisible": true,
    "labelsVisible": true
  },
  "placements": {},
  "inlineTiles": {},
  "groups": [],
  "waypoints": [],
  "connections": [],
  "frames": []
}
```

`board.connections` and `board.frames` are old id lists that nothing reads: leave them `[]`. A Mind Map's connections and frames are the file's top-level `connections` and `frames`.

### 5.1 Placements

Each tile in `tileDefs` needs a placement under the same id, and each placement a def:

```json
"placements": {
  "t_opening": { "x": 40, "y": 72, "width": 300, "height": 200 }
}
```

| Field | What it is |
| --- | --- |
| `x`, `y` | The tile's top-left corner, in canvas pixels. `x` grows to the right, `y` grows down. |
| `width`, `height` | The tile's size. New tiles in Filo are 300 × 200; the smallest a user can drag one to is 220 × 100. |
| `locked` | `true`: the tile can't be moved or resized. |
| `faded` | `true`: the tile is dimmed. |
| `frameless` | `true`, media tiles only: no header or border, just the image or video. |

A text tile keeps the size you give it and scrolls its text, so size it for its note: about 300 × 200 for a paragraph or two, 360 × 280 for a longer note, and 220 × 100 for a title with a line under it.

### 5.2 Laying a board out

- **The board first opens with canvas point (0, 0) at the top-left corner of the board's area, at 100%.** Start your layout near (0, 0) and build right and down. Anything at negative coordinates starts off screen.
- **Use the grid.** Filo snaps to 20 px and draws its background grid every 40 px. Put positions and sizes on multiples of 20 and the user's own moves line up with yours.
- **Leave room.** 40 to 80 px between tiles gives connections space to bend and labels space to sit.
- **Rows and columns.** Tiles in a row share `y` and `height`. Tiles in a column share `x` and `width`. The next tile in a row goes at `x + width + gap`.
- **Centring.** To centre a tile under a wider one: `x = wide.x + (wide.width − narrow.width) / 2`.
- **No overlaps.** A tile drawn over another hides it.
- **Reading order.** Lay a flow left to right or top to bottom, and connect each tile from the side facing the next (section 5.3).

### 5.3 Connections

An arrow from one tile to another. They go in the file's top-level `connections`, keyed by id:

```json
"connections": {
  "c_open_arrive": {
    "id": "c_open_arrive",
    "boardId": "pbBoard00001",
    "fromTileId": "t_opening",
    "toTileId": "t_arrival",
    "fromBubble": 3,
    "toBubble": 7,
    "pathType": "curved",
    "arrowType": "end",
    "label": { "text": "leads to" },
    "createdAt": 1792300000000,
    "updatedAt": 1792300000000
  }
}
```

- `boardId` is the board's own `id`.
- `fromTileId` and `toTileId` name tiles on this board: placements or inline tiles. A connection can't end on a frame.
- `fromBubble` and `toBubble` say which point on each tile's edge the connection leaves or meets:

```text
    0 ──── 1 ──── 2
    │             │
    7     tile    3
    │             │
    6 ──── 5 ──── 4
```

- **Left to right:** from 3 (right middle) to 7 (left middle). **Top down:** from 5 (bottom middle) to 1 (top middle). **Right to left:** 7 to 3. **Bottom up:** 1 to 5.

Optional fields. Leave any out to follow the board's defaults (5.8):

| Field | Value |
| --- | --- |
| `pathType` | `curved`, `straight`, `elbow` (right angles) or `smart` (routes round tiles) |
| `pathColor`, `arrowColor` | `#rrggbb`, or `""` |
| `pathSize` | 1 to 10 |
| `pathStyle` | `solid`, `dashed` or `dotted` |
| `arrowType` | `none`, `start`, `end` or `both` |
| `arrowSize` | 4 to 24 |
| `visibility`, `labelVisibility` | `visible` or `hidden` |
| `label` | `{ "text": "…", "textColor": "", "backgroundColor": "", "fontSize": 13, "position": 0.5 }`. `position` is how far along the path the label sits: 0 at the start, 0.5 in the middle, 1 at the end. Leave the label out for none. |

### 5.4 Frames

A frame is a titled box behind a set of tiles. Moving the frame moves its tiles; folding it hides them. Frames go in the file's top-level `frames` list:

```json
"frames": [
  {
    "id": "f_act1",
    "boardId": "pbBoard00001",
    "title": "Act I",
    "position": { "x": 20, "y": 20 },
    "size": { "width": 700, "height": 272 },
    "style": { "headerColor": "#22304a" },
    "collapsed": false,
    "tileIds": ["t_opening", "t_arrival"],
    "createdAt": 1792300000000,
    "updatedAt": 1792300000000
  }
]
```

- **List exactly the tiles whose centre lies inside the frame** in `tileIds`. That is the rule Filo applies whenever a tile or frame moves. A tile listed but outside the frame, or inside but not listed, behaves oddly until it is next moved.
- **The title bar is 32 px tall.** Put the first row of tiles at least 32 px plus some padding below the frame's top.
- **To fit a frame round some tiles**, take the tiles' bounding box (left, top, right, bottom) and a padding `p` of 20 px:
  - `position = { x: left − p, y: top − 32 − p }`
  - `size = { width: right − left + 2p, height: bottom − top + 32 + 2p }`
- Keep a frame at least 200 × 150.
- **Frames can nest.** A frame inside another is drawn above it. A tile inside both is listed in both.
- `collapsed: true` folds the frame to its title bar and hides its tiles.
- `style` takes `headerColor`, `bodyColor`, `borderColor`, `borderStyle`, `borderWidth`, `shape`, `shadowIntensity`, `dynamicContrastText` and `fontSizeTitle` (section 4.3), plus `backgroundImage` (a vault path to an image) and `backgroundOpacity` (0 to 1).

### 5.5 Groups

Tiles that select and move together, shown with a small number badge:

```json
"groups": [
  { "id": "g_1", "boardId": "pbBoard00001", "tileIds": ["t_opening", "t_arrival"], "displayIndex": 1 }
]
```

- `displayIndex` is the badge number: 1, 2, 3 and on, never reused on the board.
- Keep each tile in one group at most.

### 5.6 Waypoints

Named places on the board the user can jump to:

```json
"waypoints": [
  { "id": "w_village", "name": "The village", "x": 1200, "y": 400, "zoom": 1, "icon": "🏘️", "locked": false }
]
```

- The marker is drawn at (`x`, `y`), and jumping to it centres the view there at `zoom` (1 is 100%).
- `icon` is one emoji.

### 5.7 Link, embed and timer tiles

These tiles have no file behind them, so they live whole in `board.inlineTiles`, with no `tileDefs` entry and no placement:

```json
"inlineTiles": {
  "i_mapref": {
    "id": "i_mapref",
    "type": "link",
    "title": "Map reference",
    "url": "https://example.com/map",
    "x": 760,
    "y": 72,
    "width": 300,
    "height": 200,
    "tags": [],
    "style": { "headerColor": "", "bodyColor": "" },
    "createdAt": 1792300000000,
    "updatedAt": 1792300000000
  }
}
```

- **Link** (`link`) shows a web page's title and address. `url` must start with `https://` or `http://`.
- **Embed** (`iframe`) shows a web page inside the tile. Same `url` rule.
- **Timer** (`timer`) is a countdown: `duration` and `remaining` in milliseconds (`1200000` is 20 minutes), `mode` (`hms`, `ms`, `s`, or `clock` for the time of day) and `isRunning: false`.
- Their `title` and `tags` live here, since there is no note.
- An id is either in `placements` or in `inlineTiles`, never both.
- Connections and frames can include them like any other tile.

### 5.8 Mind Map settings and defaults

```json
"settings": {
  "defaultFolder": "Plot Breakdown",
  "semanticZoom": true,
  "snapToGrid": false,
  "connectionsVisible": true,
  "labelsVisible": true,
  "defaults": {
    "tile": { "shape": "rounded", "shadowIntensity": 0.2, "dynamicContrastText": true },
    "connectionPath": { "pathType": "elbow", "pathSize": 2, "arrowType": "end", "arrowSize": 8 },
    "connectionLabel": { "fontSize": 12 },
    "frame": { "shape": "rounded", "borderWidth": 1 }
  }
}
```

- `defaults.tile` takes the fields in 4.3.
- `defaults.connectionPath` takes `pathColor`, `pathSize`, `pathType`, `pathStyle`, `arrowType`, `arrowColor` and `arrowSize`.
- `defaults.connectionLabel` takes `defaultText`, `textColor`, `backgroundColor` and `fontSize` (8 to 32).
- `defaults.frame` takes the frame style fields in 5.4.
- `connectionsVisible` and `labelsVisible` set to `false` hide every connection, or every label, on the board.

---

## 6. Kanban boards

```json
{
  "id": "hpBoard00001",
  "name": "Home Projects",
  "emoji": "",
  "createdAt": 1792300000000,
  "updatedAt": 1792300000000,
  "type": "kanban",
  "settings": { "defaultFolder": "Home Projects", "accentColor": "" },
  "columns": [
    {
      "id": "col_ideas",
      "title": "Ideas",
      "position": 0,
      "style": { "accent": "#9b8afb" },
      "tilePlacements": [
        { "tileId": "k_seat", "position": 0 },
        { "tileId": "k_shed", "position": 1 }
      ]
    },
    {
      "id": "col_doing",
      "title": "Doing",
      "position": 1,
      "tilePlacements": [
        { "tileId": "k_hall", "position": 0, "coverImage": "Attachments/paint swatches.png" }
      ]
    }
  ]
}
```

- **Columns** run left to right by `position` (0, 1, 2 …). Every column needs a `title`.
- **Cards** run top to bottom by their `position` in `tilePlacements` (0, 1, 2 …). Each `tileId` has a text def in `tileDefs`, and is in one column only.
- **A card shows its note**: the title, tags, priority, due date and time, the text, and a count of the note's checklist items (`- [ ]`, `- [x]`). A card's column is where it is; there is no status field for it.
- **Card options**, on its placement:
  - `coverImage`: a vault path to an image shown at the top of the card.
  - `locked`: `true` keeps the card from being dragged.
  - `style`: `backgroundColor`, `headerColor`, `bodyColor`, `shape`, `borderColor`, `borderStyle`, `borderWidth`, `shadowIntensity`, `dynamicContrastText`, `fontSizeTitle`, `fontSizeBody`.
  - Colour cards here, on the placement, and leave the def's style colours `""`.
- **Column options**:
  - `collapsed`: `true` folds the column.
  - `wipLimit`: how many cards before the column warns.
  - `coverImage`: an image in the column header.
  - `style`: `headerColor`, `bodyColor`, `borderColor`, `borderStyle`, `borderWidth`, `shadowIntensity`, `dynamicContrastText`, `width` (120 to 2000 px), `fontSizeTitle`, `accent` (the colour of the bar in the column's header and its card count).
- **Settings**:
  - `accentColor`: `#rrggbb`, or `""` for the theme's.
  - `defaults`: `{ "column": { … }, "card": { … } }`, with the same fields as above.
  - `savedViews`: named views the user can switch between, each `{ "id": "v_due", "name": "By due date", "sortBy": "dueDate", "filterTags": [], "filterProp": null }`. `sortBy` is `manual`, `title`, `created`, `dueDate` or `priority`. `filterTags` keeps only cards with all those tags. `filterProp` is `null`, or `{ "key": "pov", "value": "Aria" }` to keep only cards whose note has that frontmatter value.

---

## 7. Task List boards

```json
{
  "id": "twBoard00001",
  "name": "This Week",
  "emoji": "",
  "createdAt": 1792300000000,
  "updatedAt": 1792300000000,
  "type": "tasklist",
  "settings": { "defaultFolder": "This Week", "sortBy": "manual", "groupBy": "none" },
  "tasks": [
    { "tileId": "tk_post", "position": 0 },
    { "tileId": "tk_shop", "position": 1 },
    { "tileId": "tk_milk", "position": 2, "parentTileId": "tk_shop" },
    { "tileId": "tk_bread", "position": 3, "parentTileId": "tk_shop" },
    { "tileId": "tk_boiler", "position": 4 }
  ],
  "sections": [
    { "id": "sec_errands", "title": "Errands", "position": 0 },
    { "id": "sec_home", "title": "Home", "position": 4 }
  ],
  "collapsedSubtasks": []
}
```

- **One flat list, in display order.** `tasks` holds every task and subtask. Each task's `position` is its index in the list (0, 1, 2 …), and each `tileId` has a text def in `tileDefs`.
- **Manual sort keeps your order.** Set `settings.sortBy` to `manual` to show tasks as you listed them. The default, `priority`, sorts by the notes' priorities instead. The others are `title`, `created` and `dueDate`.
- **Sections.** A section's `position` is the index in `tasks` where it starts, and it runs until the next section starts. Tasks before the first section sit in an unnamed group at the top. Every section needs a `title`. While a board has sections, Group By is off.
- **Subtasks.** `parentTileId` is the parent task's tile id. Put subtasks straight after their parent, in its section, as Filo does. Tasks nest three levels deep at most: a task, its subtasks, and theirs.
- **A row shows its note**: the title, a checkbox (`completed`), priority, due date and time, repeat and tags. The note's text is the row's notes box.
- `collapsedSubtasks` lists the tile ids whose subtasks are folded.
- **Row options**, on the task: `locked`, and `style` with `headerColor`, `bodyColor`, `borderColor`, `borderStyle`, `borderWidth`, `shadowIntensity`, `dynamicContrastText`, `fontSizeTitle`, `fontSizeBody`. A row takes its look only from here and the board's defaults, never from the def.
- **Section options**: `collapsed`, and `style` with the row fields except `fontSizeBody`.
- **Settings**:
  - `groupBy`: `status`, `priority`, `tag`, `dueDate`, `category` or `none`.
  - `accentColor`, and `titleFontSize` (8 to 48) for the board's own title.
  - `defaults`: `{ "task": { … }, "section": { … } }`.
  - `savedViews`: `{ "id", "name", "groupBy", "sortBy", "filterTags": [], "filterStatus": null, "filterPriority": null, "showCompleted": true, "smartList": "all" }`. `smartList` is `all`, `today`, `upcoming`, `overdue`, `no-date` or `completed`.

---

## 8. Tag colours: `.filo/tags.json`

Tags work without this file. A tag it doesn't list is shown in Filo's default tag blue (`#3a86ff`), the colour Filo gives it when it lists it. To give tags their own colours, list them here:

```json
{
  "version": 1,
  "tags": {
    "plot": { "color": "#3a86ff" },
    "act-1/arrival": { "color": "#4c9a5b" }
  },
  "fileTags": {
    "Attachments/map.png": ["plot"]
  }
}
```

- `tags` maps each tag name, spelled exactly as in the notes, to its colour.
- `fileTags` holds the tags of media and other non-note files, keyed by vault path. A note's tags stay in its own frontmatter, never here.
- Keep every entry already in the file, and add yours. Filo merges a change made while it is open with its own, but it is simplest to edit this file while Filo is closed.

---

## 9. Working while Filo is open

Filo watches the vault. A change you make shows within a second or two, and a full check of the vault runs every 30 seconds.

- **New notes and boards appear by themselves.**
- **A note you change.** If the user has no unsaved typing in it, Filo shows your version. If they are typing in it and you changed its text, Filo asks them: Reload (take yours) or Keep mine. A change to the frontmatter alone is always taken quietly.
- **A board you change.** If the board has no unsaved changes, Filo reloads it, and the board's undo history is cleared. If the user changed it moments before, Filo asks them: Reload (take yours) or Keep local. Keeping theirs first copies your version to `.filo/recovery/`, so it isn't lost.
- **Renames and moves.** While Filo is open, it follows a note you rename or move and updates the boards that show it. While Filo is closed it can't: update every `filePath` that pointed at the old path yourself.

So, to work smoothly alongside the user:

1. Tell the user which notes and boards you are about to change, or ask them to close those tabs first.
2. Write each file in one go, not a line at a time.
3. Write the notes first and the board last.
4. Don't keep temporary or backup files inside the vault: Filo shows any file it finds there as an attachment.

---

## 10. Board templates

A simpler way to start a board, when you don't need connections, frames or styling. A note in the vault's `Templates/` folder holding a `filo-board` code block is a board template. The user picks it from **New Tab → New board from template…**, and Filo makes the board and a note for every card, task or tile in it.

````markdown
---
title: "Chapter Planner"
---

Notes on how to use this board.

```filo-board
{
  "type": "kanban",
  "columns": [
    { "title": "To draft", "cards": ["Opening", { "title": "Arrival", "body": "The ferry scene." }] },
    { "title": "Drafted", "cards": [] }
  ]
}
```
````

- `type` is `kanban` (with `columns` of `cards`), `tasklist` (with `sections` of `tasks`) or `mindmap` (with `tiles`).
- A card or task is a title, or `{ "title": "…", "body": "…" }`.
- A Mind Map tile is `{ "title": "…", "body": "…", "x": 0, "y": 0, "width": 300, "height": 200 }`; only `title` is required.
- `settings` may hold any board settings from sections 5 to 7, except `defaultFolder`.
- A template makes 200 notes at most.
- Template text may use `{{title}}`, `{{date}}`, `{{time}}`, `{{datetime}}`, `{{year}}`, `{{month}}` and `{{day}}`.

---

## 11. Checklist

Before you finish, check:

**Notes**

- [ ] Every note is UTF-8, its frontmatter is valid YAML, and its title is quoted.
- [ ] Task fields use the exact values in 3.1 (`true`/`false`, `YYYY-MM-DD`, `HH:MM`, the priority words).
- [ ] Every piece of HTML in a body is one of the spellings in 3.3, copied exactly.
- [ ] Every file name is allowed (3.2) and every image path in a note is relative to that note's folder.

**Boards**

- [ ] The file is valid JSON with `"version": 8`, named `<board.name>.board.json`.
- [ ] `board.id` is used by no other board file in the vault.
- [ ] Every id uses only `A–Z a–z 0–9 _ -`, is unique within the board, and matches its key wherever the object sits in a keyed map.
- [ ] Every `createdAt` and `updatedAt` is a number of milliseconds.
- [ ] Every `filePath` and `src` names a file that exists, by its vault path, with the same capitals.
- [ ] Every def has its placement (Mind Map), card slot (Kanban) or task entry (Task List), and every one of those has its def.
- [ ] Every connection's `fromTileId` and `toTileId` name a tile on the board, and its `boardId` is the board's id.
- [ ] Every frame's `tileIds` lists exactly the tiles whose centre is inside it.
- [ ] Mind Map tiles don't overlap, and the layout starts near (0, 0).
- [ ] Task List: `sortBy` is `manual` if your order matters, each section's `position` is the index where it starts, and subtasks follow their parent.

---

## 12. A complete example

A small Mind Map: two notes in a frame, an arrow between them, and a third note below. These are the four files. In a real vault each would be in its own file at the path named above it.

`Story Map/Opening.md`

```markdown
---
title: "Opening: The Platform"
tags:
  - plot
  - act-1
---

Aria waits on the platform.

<p style="text-align: center;"><strong>Key scene</strong></p>
```

`Story Map/Arrival.md`

```markdown
---
title: "Arrival"
tags:
  - plot
  - act-1
status: in-progress
---

The ferry docks at dawn.
<span style="color: rgb(192, 57, 43);">**Open question:**</span> who meets her?

- [ ] Decide who meets her
- [x] Pick the harbour
```

`Story Map/Themes.md`

```markdown
---
title: "Themes"
---

<mark>Belonging</mark> and leaving home.
```

`Story Map/Story Map.board.json`

```json
{
  "version": 8,
  "board": {
    "id": "smBoard00001",
    "name": "Story Map",
    "emoji": "",
    "createdAt": 1792300000000,
    "updatedAt": 1792300000000,
    "type": "mindmap",
    "settings": {
      "defaultFolder": "Story Map",
      "semanticZoom": true,
      "snapToGrid": false,
      "connectionsVisible": true,
      "labelsVisible": true,
      "defaults": {
        "tile": { "shape": "rounded", "shadowIntensity": 0.2 },
        "connectionPath": { "pathType": "curved", "arrowType": "end", "pathSize": 2 }
      }
    },
    "placements": {
      "t_opening": { "x": 40, "y": 72, "width": 300, "height": 200 },
      "t_arrival": { "x": 400, "y": 72, "width": 300, "height": 200 },
      "t_themes": { "x": 220, "y": 360, "width": 300, "height": 160 }
    },
    "inlineTiles": {},
    "groups": [],
    "waypoints": [
      { "id": "w_act1", "name": "Act I", "x": 370, "y": 156, "zoom": 1, "icon": "📍", "locked": false }
    ],
    "connections": [],
    "frames": []
  },
  "tileDefs": {
    "t_opening": {
      "id": "t_opening",
      "type": "text",
      "filePath": "Story Map/Opening.md",
      "style": { "headerColor": "#22304a", "bodyColor": "", "borderColor": "" },
      "createdAt": 1792300000000,
      "updatedAt": 1792300000000
    },
    "t_arrival": {
      "id": "t_arrival",
      "type": "text",
      "filePath": "Story Map/Arrival.md",
      "style": { "headerColor": "#22304a", "bodyColor": "", "borderColor": "" },
      "createdAt": 1792300000000,
      "updatedAt": 1792300000000
    },
    "t_themes": {
      "id": "t_themes",
      "type": "text",
      "filePath": "Story Map/Themes.md",
      "style": { "headerColor": "#b5523b", "bodyColor": "", "borderColor": "" },
      "createdAt": 1792300000000,
      "updatedAt": 1792300000000
    }
  },
  "connections": {
    "c_open_arrive": {
      "id": "c_open_arrive",
      "boardId": "smBoard00001",
      "fromTileId": "t_opening",
      "toTileId": "t_arrival",
      "fromBubble": 3,
      "toBubble": 7,
      "label": { "text": "next" },
      "createdAt": 1792300000000,
      "updatedAt": 1792300000000
    },
    "c_arrive_themes": {
      "id": "c_arrive_themes",
      "boardId": "smBoard00001",
      "fromTileId": "t_arrival",
      "toTileId": "t_themes",
      "fromBubble": 5,
      "toBubble": 1,
      "pathStyle": "dashed",
      "arrowType": "none",
      "createdAt": 1792300000000,
      "updatedAt": 1792300000000
    }
  },
  "frames": [
    {
      "id": "f_act1",
      "boardId": "smBoard00001",
      "title": "Act I",
      "position": { "x": 20, "y": 20 },
      "size": { "width": 700, "height": 272 },
      "style": { "headerColor": "#e6e6e6" },
      "collapsed": false,
      "tileIds": ["t_opening", "t_arrival"],
      "createdAt": 1792300000000,
      "updatedAt": 1792300000000
    }
  ]
}
```

How the numbers fit together:

- **The two tiles in the frame** share `y` (72) and `height` (200), with a 60 px gap between them (40 + 300 + 60 = 400).
- **The frame** fits round them with 20 px of padding: its left edge is 40 − 20, its top is 72 − 32 − 20 (room for the 32 px title bar), its width is 700 − 40 + 40, and its height is 272 − 72 + 32 + 40.
- **Themes** sits outside the frame (its centre, y 440, is below the frame's bottom at 292), so it isn't in `tileIds`. It is centred under the pair: (40 + 700) / 2 − 300 / 2 = 220.
- **The arrow** runs from Opening's right middle (3) to Arrival's left middle (7). The dashed line runs from Arrival's bottom middle (5) to Themes' top middle (1).

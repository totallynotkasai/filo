# Filo Tags System Audit — 2026-05-18

This audit covers the tags system end-to-end: schema, persistence, sync, UI, search, and consistency across the Mind Map, Kanban, Task List, and Document boards plus the vault sidebar. The audit produced a punch list of findings; the ones in scope for the accompanying hardening pass are marked **Fixed in this pass**, the rest are tagged **Deferred** or **By design**.

---

## 1. Architecture map

### Schema

| Where tags live | File | Shape |
| --- | --- | --- |
| Central tag registry | `src/renderer/schema/tagsFile.ts` | `{ tags: Record<name, {color, createdAt?}>, fileTags: Record<path, string[]> }` |
| Frontmatter on `.md` | `src/renderer/schema/frontmatter.ts` | `tags: string[]` (default `[]`) |
| Tile on a board | `src/renderer/schema/tile.ts` (`BaseTileSchema`) | `tags: string[]` |
| Inline tile on a board (Link / Iframe / Timer) | `src/renderer/schema/placement.ts` (`InlineTileSchema`) | `tags: string[]` |
| Board saved-view filter | `src/renderer/schema/board.ts` | `filterTags: string[]` (Kanban + Task List) |

Tag identity is the **tag name**, not an ID. The schema docstring on `tagsFile.ts` mentions `/` hierarchy in tag names (e.g. `urgent/blocker`) — the storage layer treats these as flat names; the TagsBrowser now groups them visually under the parent prefix (presentation only).

### Persistence layers

- **`.filo/tags.json`** — single canonical store, read/written via the `tags:load` and `tags:save` IPC channels. Atomic write through `atomicWriteFile`. Path security enforced by `assertWithinVault`.
- **Markdown frontmatter** — canonical source for text-tile tags. Rewriter helpers (`addTagToMarkdown` / `removeTagFromMarkdown` / `rewriteTagInMarkdown`) live in `src/renderer/lib/vault/tagRewriter.ts` and are pure (no I/O).
- **`.board.json:tileDefs[id].tags`** — fast read cache per board.
- **`.board.json:inlineTiles[id].tags`** — same shape, but for inline tiles (Link / Iframe / Timer). These tiles are board-local; they do **not** participate in `.filo/tags.json:fileTags`.

### Stores

- `fileTagsStore` (`src/renderer/stores/fileTags.svelte.ts`) — owns the `.filo/tags.json` state; provides tile-aware mutation helpers (`addTagToTile`, `removeTagFromTile`, `renameTagEverywhere`, `removeTagEverywhere`). All mutations are debounced via `scheduleMiscWrite`.
- `vaultIndexStore` (`src/renderer/stores/vaultIndex.svelte.ts`) — wraps `VaultIndex` (MiniSearch + metadata map). Exposes `filesByTag(tag)` and `allTags()`.
- `boardStore` — exposes `allTileDefs` and `allInlineTiles`; mutations route through `updateTile` / `persistUpdateTile`.

### IPC surface

Only two tag channels exist:

- `tags:load(vaultRoot) → string | null` — read raw JSON.
- `tags:save(vaultRoot, json) → void` — atomic write.

All higher-level operations (rename, delete, recolour) are pure renderer logic on top of these.

---

## 2. Findings

Severity scale: `S1` = correctness / data-loss risk, `S2` = consistency / UX gap, `S3` = polish.

| ID | Severity | Surface | Finding | Resolution |
| --- | --- | --- | --- | --- |
| F-1 | S2 | KanbanCard | Cards never render tags. The underlying tile carries them, but the card chrome has no `TagBadge`. | **Fixed in this pass** — KanbanCard renders chips + an edit affordance hooked into the existing `tile-tag-editor` event pattern. |
| F-2 | S2 | TaskItem | Tasks carry tags but the row UI shows nothing. Editing is gated behind right-click → "Edit tags". | **Fixed in this pass** — TaskItem renders inline `TagBadge` chips and a visible edit button; the existing context-menu path remains as a second entry point. |
| F-3 | S2 | DocumentBoard | A Document is backed by a `.md` whose frontmatter carries tags, but the Document board has no UI to view or edit them. | **Fixed in this pass** — frontmatter `tags:` strip near the title, edited via the popup `TagEditor` in file-path mode. Writes route through `addTagToMarkdown` / `removeTagFromMarkdown` and `fileTagsStore.addTagToFile` / `removeTagFromFile`. |
| F-4 | S2 | VaultFileItem | Sidebar uses a bespoke inline `<input>` editor + popover; everything else uses the popup `TagEditor`. Three different visual treatments of the same chip. | **Fixed in this pass** — sidebar trigger now opens the same `TagEditor` (file-path mode); inline popover removed; chip styling routed through the unified `TagBadge`. |
| F-5 | S2 | Vault index / search | Inline tiles (Link / Iframe / Timer) carry tags but `vaultIndex.filesByTag` only walks frontmatter — searching `tag:bookmark` misses a Link tile carrying `bookmark`. | **Fixed in this pass** — `vaultIndex` gains an `inlineTileTagsProvider` callback so `filesByTag` and `allTags` union in inline-tile tags; `searchService` filter set still keys by file path, but tile-typed surfaces drive their own filter through `fileTagsStore.getTilesWithTag` (already correct). |
| F-6 | S2 | TagBadge | Three different visual treatments (canvas pill, popup mini-tag, sidebar chip) for the same concept. | **Fixed in this pass** — `TagBadge` accepts `size?: 'sm' \| 'md'` and `variant?: 'solid' \| 'outline'`; `TagsPopupMenu` and `VaultFileItem` adopt it. |
| F-7 | S3 | TagEditor | No autocomplete on the add-input. Free-text only. | **Fixed in this pass** — suggestions from `fileTagsStore.allTagNames()` filter as the user types; arrow keys + Enter to select, Escape to dismiss the dropdown without closing the popup. |
| F-8 | S3 | TagsBrowser | Schema docstring promises `/` hierarchy; UI renders flat. | **Fixed in this pass** — TagsBrowser groups child tags under their top-level prefix visually. Storage and rename/delete semantics stay flat. |
| F-9 | S3 | Command registry / hotkeys | No discoverable command or shortcut to open TagsBrowser. Three call sites in board components each call `uiStore.openModal('tags-browser')` directly. | **Fixed in this pass** — `tag:open-browser` registered with a default `Ctrl+Shift+T` binding through `registerCommandWithShortcut`; the three call sites continue to work unchanged. |
| F-10 | S3 | fileTagsStore | `migrateLegacyTileTagIds()` runs on every vault open. Targeted pre-unification nanoid-shape entries that no clean vault still carries. | **Fixed in this pass** — function and its call site in `vault.svelte.ts` removed. |
| F-11 | S3 | TagsPopupMenu | Bespoke mini-tag CSS (border-only, 10px, transparent) lives inline alongside the canvas pill in TileContainer. Duplicate visual vocabulary. | **Fixed in this pass** — popup uses `TagBadge size="sm" variant="outline"`. |
| F-12 | S2 | Inline tag mentions in body text | Inline `#foo` runs in `.md` body text are styled by TipTap but **not** indexed and **not** rewritten on rename/delete. Frontmatter is canonical. | **By design** — confirmed with the user; no change. Documented in `tagRewriter.ts:1-12` and `vaultIndex.ts:128-131`. |
| F-13 | S3 | Tag aliases / faceted search | No alias mapping; no faceted UI in find-replace results. Query syntax (`tag:foo`) works. | **Deferred** — out of scope for this pass. |
| F-14 | S3 | TagsBrowser a11y | No focus trap; tablist (`All / Files only / Tiles only`) doesn't respond to arrow keys. | **Deferred** — out of scope for this pass. |
| F-15 | S3 | Bulk multi-file edit | Can't select multiple sidebar files and tag them at once. | **Deferred** — multi-tile mode exists in `TagEditor`; per-file multi-mode wasn't needed for this pass. |

---

## 3. Persistence contract

Adding a tag to a **text tile** writes to **three** sinks atomically (the first two synchronously; the third fire-and-forget but tracked via `trackComponentWrite` for error surfacing):

1. `boardStore.updateTile(tileId, { tags: [...prev, name] })` — in-memory + debounced `.board.json` write.
2. `fileTagsStore.addTagToFile(path, name)` — `.filo/tags.json:fileTags[path]` += name; debounced `tags:save`.
3. `writeTagChangeToTileMarkdown(tile, name, 'add')` — reads the backing `.md`, calls `addTagToMarkdown`, writes back via `vault:write-file-text`, then re-indexes via `vaultIndexStore.applyChanges`.

Siblings (other tiles backed by the same `.md` on other boards) get patched in step 2.5 via `propagateTileTagChangeToSiblings`.

Adding a tag from the **Document board** or **sidebar** writes to sinks **2 and 3** only — there's no tile to update because the editing surface isn't a tile. Anywhere the same file is *also* placed as a text tile, the sibling propagation path in `fileTagsStore.setFileTags` (now also called for these surfaces) keeps the tile chips in sync.

Adding a tag to an **inline tile** writes to sink **1 only**. Inline tiles have no backing file, so the `.filo/tags.json:fileTags` registry intentionally doesn't track them. They surface in tag searches via the new `inlineTileTagsProvider` callback wired into `VaultIndex.allTags()`.

External edits to a `.md` file's frontmatter flow back through `handleExternalMarkdownChanges` → `boardStore.applyFrontmatterToBackedTiles` + `fileTagsStore.setFileTags`, so all three sinks reconcile reactively when the user edits a file outside Filo.

Rename and delete propagate everywhere:

- `renameTagEverywhere(old, new)` → `.filo/tags.json` (definition + `fileTags`) + every `.board.json` tile def + every `.md` frontmatter via `rewriteTagInAllMarkdown`.
- `removeTagEverywhere(name)` → same path with `null` as the new name.

---

## 4. Surface coverage matrix

| Surface | Display tags? | Edit affordance | Component | Status after this pass |
| --- | --- | --- | --- | --- |
| Canvas tile (Mind Map) | ✅ Footer (LOD: full only) | Header icon button → popup `TagEditor` | `TileContainer.svelte` + `TileHeader.svelte` + `MindMapPopups.svelte` | unchanged |
| Kanban card | ✅ **NEW** chip row under title | **NEW** edit icon → popup `TagEditor` | `KanbanCard.svelte` + `KanbanBoard.svelte` | fixed |
| Task list row | ✅ **NEW** inline chips | **NEW** edit icon (visible) + existing context menu entry | `TaskItem.svelte` | fixed |
| Document board | ✅ **NEW** chip strip near title | **NEW** "+ tag" affordance → popup `TagEditor` (file-path mode) | `DocumentBoard.svelte` | fixed |
| Vault sidebar | ✅ chip line (unchanged); inline editor replaced | Edit icon → popup `TagEditor` (file-path mode) | `VaultFileItem.svelte` | unified |
| Tags Browser modal | ✅ flat list **now grouped by `/`** | Inline rename + delete + colour picker | `TagsBrowser.svelte` | hierarchy added |
| Tags popup menu | ✅ Other tags as mini-tag | None (navigation only) | `TagsPopupMenu.svelte` | mini-tag → unified `TagBadge` |

---

## 5. Test plan

End-to-end verification (manual):

1. **Display parity** — add a tag to a Mind Map tile backed by `Foo.md`. Open a Kanban board containing a card backed by the same file; the card shows the chip. Open the Task List that references it; the row shows the chip. Open the Document board for `Foo.md`; the title strip shows the chip.
2. **Edit propagation** — add a tag from the Document board. Confirm `.md` frontmatter has it, `.filo/tags.json:fileTags` has it, and the sibling Kanban card / canvas tile show it. Remove it from the Kanban card; confirm all three sinks lose it.
3. **Inline-tile search** — drop a Link tile on a canvas board with tag `bookmark`. Open the Tags Browser; `bookmark` shows with a tile count of 1. From the popup menu, click the tile entry to navigate to it.
4. **Sidebar unification** — click the edit-tags icon on a sidebar file. The popup `TagEditor` opens anchored next to the row. Tag added/removed via the popup is reflected in the sidebar chip line.
5. **Autocomplete** — type `bo` in any `TagEditor` add-input. Suggestions filter to `bookmark`, `boss`, etc. Arrow keys highlight a suggestion; Enter selects; Escape dismisses the dropdown without closing the popup.
6. **Hierarchy display** — create `urgent`, `urgent/blocker`, `urgent/critical`. Open the Tags Browser. The two child rows are visually indented under `urgent`. Rename `urgent/blocker` → `urgent/fatal`; the row updates and stays under `urgent`.
7. **Command + shortcut** — press `Ctrl+Shift+T`. The Tags Browser opens. Re-bind via the Keyboard Shortcuts modal; confirm the new binding takes effect.
8. **Legacy migration removed** — open a clean vault. No `migrateLegacyTileTagIds` reference remains; app boots cleanly.

Automated:

- `npm run check` — svelte-check clean.
- `npm run test:unit:strict` — green; new tests cover `TagEditor` file-path mode add/remove and `vaultIndex.filesByTag` inline-tile inclusion.
- `npm run ci:verify` — local CI mirror passes (lint → check → test:unit:strict → build → file-sizes → type-casts → ipc-parity).

---

## 6. Open items kept on the backlog

- Tag aliases / merge UI (F-13).
- TagsBrowser focus trap + arrow-key tab navigation (F-14).
- Bulk multi-file tag edit from sidebar selection (F-15).
- Faceted tag chips in find-replace results.

These are tracked here so the next audit cycle picks them up without re-discovery.

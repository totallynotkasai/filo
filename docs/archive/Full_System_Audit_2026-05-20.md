# Filo — Full System Audit

**Date:** 2026-05-20
**Scope:** Static code review focused on data integrity, plus cross-checks of dead code, schema/IPC safety, undo/redo, rename/delete cascade, and design-doc gaps.
**Method:** Five parallel deep-read agents across the codebase + targeted spot checks. No app launch or E2E execution.
**Baseline at time of audit:** `check`, `test:unit:strict` (88 files / 1259 tests), `build`, `ci:file-sizes`, `ci:type-casts`, `ci:ipc-parity` all green. `lint` red on 2 errors (one config, one real).

---

## Headline assessment

**Do not start using Filo as your daily-driver vault yet.** The architecture is sound and the team has clearly invested heavily in the persistence layer — atomic writes for boards and configs, a dirty-flag sentinel for crash recovery, debounced writes with a `trackComponentWrite` accounting layer, watcher self-write suppression, rename correlation, and a graceful shutdown chain through `app:flush-and-quit`. Most code is well organised and the CI gates (file-size ratchet, IPC parity, type-cast ratchet) are doing real work.

But five P0 classes of bug reach real data the user would put into a vault within minutes of opening Filo:

1. **The user's `.md` files are not atomically written**, while every other file in the vault is. A crash or power loss mid-write corrupts the actual notes — the most valuable data — while leaving the metadata around them intact.
2. **External delete + dirty editor silently re-creates the deleted file** from the in-memory editor copy.
3. **Renaming a file in OS Explorer with a name change** (e.g. `Foo.md` → `Bar.md`) disconnects every tile that referenced it. Same for moving an image out of `attachments/`. The cascade only sees identical-basename renames of `.md`/`.board.json` files.
4. **The attachment-tag store (`.filo/tags.json:fileTags`) has helper functions for rename and delete that no production site ever calls.** Tag-on-image associations are reliably orphaned on the first rename/delete.
5. **The Crash Recovery sentinel is cleared the instant the recovery modal opens**, before the user has acknowledged anything. A second crash leaves no breadcrumb.

Two additional P0s are security rather than data-integrity, but they shape the trust model: several IPC handlers accept a renderer-supplied `vaultRoot` without verifying it matches the open vault, and `theme:save` / `snippet:load` accept a `name` parameter with no traversal guard. A bug or compromised iframe tile could rewrite arbitrary `.json` files outside the vault.

**Recommended path to production use:** the P0 list below is your blocker set. Most fixes are small and localised — the average is one helper plus 3-10 lines per call site. Roughly two days of focused work and a follow-up audit pass would clear the headline risks. The P1 list is what to ship in the second week; the P2/P3 are post-launch hygiene.

**Subsystem scorecard (out of 10, per the sub-agents):**
- Persistence layer: 8 — strong foundations, P0 gaps drag effective score to ~6
- Rename/delete cascade: 6 — three reachable classes of silent data loss
- Schema integrity: 6 — strong Zod coverage; no version+migration system
- IPC safety: 5 — right architecture, inconsistent enforcement
- Undo/redo correctness: 6 — command pattern is sound, multiple feature categories non-undoable

---

## P0 — Data-loss / corruption / security blockers

These must be addressed before the app is used on real data.

### [P0-1] `.md` writes are not atomic — power loss or crash mid-write corrupts user notes

**Location:** [src/main/ipc/vault.ipc.ts:227](src/main/ipc/vault.ipc.ts:227)

**What's wrong:** `vault:write-file-text` calls plain `fsPromises.writeFile(fullPath, content, 'utf-8')`. Every `.board.json` and `.filo/*.json` write goes through `atomicWriteFile` (write to `.tmp` then rename) — but the channel that writes every user `.md` file, every tag-rename sweep, every frontmatter update, every recovery flush, every tile creation, does not.

**Impact:** A crash, OS forced shutdown, or power loss during a `.md` write corrupts the user's actual notes. Board JSON and config are protected; the user's writing is not. This inverts the priority — losing a board can be recovered by recreating placements; losing the body of an unsynced note is permanent.

**Fix sketch:** Route `vault:write-file-text` through `atomicWriteFile` (already present in `filenameUtils.ts:114`). The `fs.watch` self-suppression pattern at [board.ipc.ts:96-106](src/main/ipc/board.ipc.ts:96) is the model — increase the suppress duration to 2000ms for parity with board saves.

---

### [P0-2] External-delete + dirty-editor silently resurrects the deleted file

**Location:** [src/renderer/stores/vaultExternalChanges.ts:33-40](src/renderer/stores/vaultExternalChanges.ts:33); supporting [src/renderer/lib/vault/conflictResolver.ts:55-58](src/renderer/lib/vault/conflictResolver.ts:55)

**What's wrong:** `classifyExternalChange` correctly returns `{action: 'prompt-user', reason: 'editor-dirty'}` when a file is deleted externally while an editor has a dirty buffer. But immediately after, line 40 reads `if (!next) continue;` — short-circuiting the switch before the prompt fires. The user gets no toast. The dirty editor's pending 300ms debounce then fires, hitting `vault:write-file-text`, which `mkdir-p`s and recreates the file from the in-memory body.

**Impact:** External deletion (git checkout, OS file explorer, sync-client conflict resolution) is silently undone by a stale in-memory editor copy. The user thinks they deleted a file; Filo writes it back, possibly with stale content from a previous session.

**Fix sketch:** Move `if (!next) continue;` inside the switch — handle `prompt-user` first, only continue for `sync-frontmatter` / `reload-silently`. Surface a Reload / Re-create / Discard toast.

---

### [P0-3] Editor writes don't verify the backing file still exists

**Location:** [src/renderer/components/tiles/TextTile.svelte:87-109](src/renderer/components/tiles/TextTile.svelte:87), [src/renderer/components/boards/DocumentEditor.svelte:53-75](src/renderer/components/boards/DocumentEditor.svelte:53), [src/renderer/components/tiles/PropertiesPopup.svelte:158-186](src/renderer/components/tiles/PropertiesPopup.svelte:158)

**What's wrong:** Only `frontmatterWriteScheduler.writeFrontmatter` (frontmatterWriteScheduler.ts:132) gates the write on `vault:file-exists`. The three per-component markdown writers don't. `vault:write-file-text` calls `fs.mkdir(dirname, {recursive: true})` before writing, so any vault-relative path can be silently recreated.

**Impact:** Compounds with P0-2. Even when the user does see and act on a Reload toast, an already-armed 300ms write can fire after the click and resurrect the file.

**Fix sketch:** Reuse the `frontmatterWriteScheduler` precondition inside `trackComponentWrite`. Better: add a `vault:write-existing-file-text` IPC variant that errors on ENOENT, and route editor writes through it.

---

### [P0-4] Recovery sentinel cleared before the user reviews recovered files

**Location:** [src/renderer/stores/vault.svelte.ts:477-487](src/renderer/stores/vault.svelte.ts:477)

**What's wrong:** After `checkRecovery` returns `needsRecovery=true`, the code opens the RecoveryFiles modal (or shows a toast) and then *immediately* calls `markClean(newVaultPath)` — line 486 runs unconditionally. The user has not yet acted on the modal. If Filo crashes again before they review, the sentinel is gone and the second crash leaves no breadcrumb.

**Impact:** Defeats the whole purpose of the dirty-flag system. Users get one chance to see what crashed mid-write; subsequent crash erases the evidence.

**Fix sketch:** Move `markClean` into the RecoveryFiles modal's Acknowledge handler and into the toast's auto-dismiss callback. When `pending.length === 0 && needsRecovery === true`, surface a persistent warning toast rather than a 4 s success toast — the sentinel itself is the user-visible fact.

---

### [P0-5] `boardCacheStore.syncTile` bypasses `trackComponentWrite`

**Location:** [src/renderer/stores/boardCache.svelte.ts:688](src/renderer/stores/boardCache.svelte.ts:688); same pattern in [boardCacheTiles.ts:135](src/renderer/stores/boardCacheTiles.ts:135), [kanbanTileCreation.ts:144,221](src/renderer/lib/kanban/kanbanTileCreation.ts:144), [taskCreation.ts:155](src/renderer/lib/tasklist/taskCreation.ts:155), [fileDropHandler.ts:151](src/renderer/lib/tasklist/fileDropHandler.ts:151), [KanbanSideToolbar.svelte:109](src/renderer/components/boards/KanbanSideToolbar.svelte:109)

**What's wrong:** The Tile Sync recovery flush writes directly: `await window.filo.invoke('vault:write-file-text', ...)` then `documentStore.markClean(...)` — no `trackComponentWrite` wrapper. On failure, the rejection propagates back to the recovery UI but `failedVaultPaths` is never updated, `saveStateStore` stays "saved", and the `.filo/.dirty` sentinel doesn't keep the path. The same pattern recurs in five other tile-creation sites.

**Impact:** The recovery flush — the operation a user reaches for *after* suspecting data loss — is itself a hidden data-loss vector when it fails.

**Fix sketch:** Wrap line 688 in `trackComponentWrite(vaultRoot, filename, () => window.filo.invoke(...))`. Same fix for all five sister sites.

---

### [P0-6] Attachment-tag store is never updated on rename or delete

**Location:** Helpers exist at [src/renderer/stores/fileTags.svelte.ts:616-628](src/renderer/stores/fileTags.svelte.ts:616) (`renameFile` / `dropFile`); the missing call sites are [src/renderer/stores/vaultFolderOps.ts:39-77](src/renderer/stores/vaultFolderOps.ts:39) (in-app rename), [:96-143](src/renderer/stores/vaultFolderOps.ts:96) (in-app delete), and [src/renderer/stores/vault.svelte.ts:685-695](src/renderer/stores/vault.svelte.ts:685) (external rename handler)

**What's wrong:** A project-wide grep finds zero non-test call sites for `fileTagsStore.renameFile` / `dropFile`. Renaming or deleting an attachment (image, video, audio, file tile) leaves its entry in `.filo/tags.json:fileTags` orphaned. After a rename, the on-tile tag is rewritten by `propagateRenameAcrossBoards`; the registry side now keys against a dead path. Delete is worse — the entry survives forever.

**Impact:** Every attachment rename leaks tag entries; the Tags Browser counts attachments under dead paths, `detectOrphans` flags them as phantom orphans on every vault open, and a new file written to the same path later silently inherits the old file's tags. The deliberate "attachment tags are vault-local" design (memory note `feedback_tag_badge_placement.md`) is negated.

**Fix sketch:** In `vaultFolderOps.rename`, after the rel-path computation, call `fileTagsStore.renameFile(oldRel, newRel)`. In `delete`, after `boardStore.cascadeDeleteByVaultPath`, call `fileTagsStore.dropFile(rel)`. In `vault.svelte.ts:685-695`, same. For folder renames, iterate keys whose path starts with `oldRel + '/'` and rewrite the prefix; for folder deletes, drop those keys.

---

### [P0-7] External attachment renames are converted to delete + create — placements vanish

**Location:** [src/main/services/renameCorrelation.ts:31](src/main/services/renameCorrelation.ts:31)

**What's wrong:** `correlateRenames` only buckets events where `c.type === 'document' || c.type === 'board'`. Attachments and anything else fall through. An external rename of `attachments/img.png` → `attachments/photo.png` lands as a delete + create, routed only through `vault:tree-updated`.

**Impact:** `vault:file-renamed` never fires, so `boardStore.propagateRename` never runs. Every image/video/audio/file tile that pointed at the old path becomes a broken-ref ghost. The placement, size, style, and tag association are silently disconnected. Pulling an image out of `attachments/` with Windows Explorer is one of the highest-likelihood real-world events.

**Fix sketch:** Extend correlation to include `'attachment'` events. Same basename + missing/present pairing invariant. Keep `.filo/` config files excluded.

---

### [P0-8] Rename correlation requires identical basename — `Foo.md` → `Bar.md` misses

**Location:** [src/main/services/renameCorrelation.ts:32-49](src/main/services/renameCorrelation.ts:32)

**What's wrong:** Correlation buckets by `basename(c.filename)`. A user renaming `Foo.md` → `Bar.md` in OS Explorer produces a delete for `Foo.md` and a create for `Bar.md` — they go to different basename buckets and never pair.

**Impact:** Every external rename that *changes the filename* (the most common rename!) is treated as delete + create. The placement, size, style, connections, tags, and waypoints attached to that tile are stranded. There is no UX to repair — no "did you mean to rename?" prompt.

**Fix sketch:** Add a content-hash or near-mtime + same-size heuristic when exactly one delete and one create land in the debounce batch. Or, more robust: switch from raw `fs.watch` to `chokidar`, which has rename detection. Either way, document the residual case so the user knows folder-only renames are the safe path.

---

### [P0-9] Rename cascade lives in-memory until a 300ms debounce flushes — crash mid-window loses cascade

**Location:** [src/renderer/lib/vault/fileRefIntegrity.ts:197](src/renderer/lib/vault/fileRefIntegrity.ts:197) (`propagateRenameAcrossBoards`); contrast with [src/renderer/stores/fileTags.svelte.ts:744-778](src/renderer/stores/fileTags.svelte.ts:744) (`renameTagEverywhere` which DOES await `ensureAllLoaded`)

**What's wrong:** `propagateRenameAcrossBoards` iterates `boardCacheStore.cache` and calls `markDirty(boardId)` — the on-disk write is debounced 300 ms. If the app crashes in that window, the rename is on disk for the renamed `.md` but every `.board.json` still points at the dead path. The asymmetry with `renameTagEverywhere` (which awaits `ensureAllLoaded` first) means a future lazy-load mode would also silently lose cascade.

**Impact:** Rare but reachable: rename a file, app crashes within 300 ms, every board points at the old path on reopen.

**Fix sketch:** Make `propagateRename` await `ensureAllLoaded` first. Flush the debounce immediately after a rename rather than waiting — file renames are infrequent enough that 300 ms savings don't matter.

---

### [P0-10] Cascade-delete misses Kanban placement `coverImage`

**Location:** [src/renderer/lib/vault/fileRefIntegrity.ts:367-388](src/renderer/lib/vault/fileRefIntegrity.ts:367) (`findTilesToCascadeDelete`); contrast with [:145-157](src/renderer/lib/vault/fileRefIntegrity.ts:145) (`forEachTileLike` which DOES visit placements)

**What's wrong:** `findTilesToCascadeDelete` only walks `data.tileDefs`. Kanban placements live in `b.columns[*].tilePlacements[*]` with an independent `coverImage` field that `forEachTileLike` visits for rename and broken-ref scanning, but cascade-delete skips entirely.

**Impact:** Deleting a Kanban card cover image leaves the dead path permanently in the JSON — broken-ref badge shows but on-disk JSON stays inconsistent.

**Fix sketch:** In `findTilesToCascadeDelete`, also walk Kanban placements and let the caller null out matching `coverImage` fields.

---

### [P0-11] No board envelope `version` field; no migration system

**Location:** [src/renderer/lib/boards/boardLoader.ts:26](src/renderer/lib/boards/boardLoader.ts:26) — schema defined inline; the file `src/renderer/schema/migrations.ts` referenced in CLAUDE.md does not exist

**What's wrong:** `V7BoardFileDataSchema = z.object({ board, tileDefs, connections, frames })`. No `version` field at the envelope. CLAUDE.md refers to "V7 .board.json file shape" but the schema doesn't carry a `version: 7` discriminator. The viewport-strip code at [boardWriteScheduler.ts:117-120](src/renderer/lib/boards/boardWriteScheduler.ts:117) already suggests format evolution is happening silently.

**Impact:** When the next format change ships, there's no way to detect which legacy revision a file came from. Files load by structural match only.

**Fix sketch:** Add `version: z.literal(7).default(7)` to the envelope. Create `schema/migrations.ts` with `migrate(rawJson, fromVersion)` keyed by detected version. Route `loadBoard` through it before `safeParse`.

---

### [P0-12] `board:load` silently downgrades schema failures by skipping the board

**Location:** [src/renderer/lib/boards/boardLoader.ts:166-171](src/renderer/lib/boards/boardLoader.ts:166)

**What's wrong:** `loadAllBoards` does `console.warn(...); continue;` on any failed `loadBoard`. A corrupted `.board.json` makes the entire board vanish from the in-memory tree, the sidebar, tabs, and search index — but the user gets nothing visible. The next `flushAll` writes `.filo/workspace.json` *without* that board, dropping the tab that referenced it.

**Impact:** Silent data loss. A `.board.json` file the user can still see on disk doesn't appear in the app; the next unrelated edit then rewrites workspace.json to forget the tab. Disk file still exists, but Filo treats it as gone.

**Fix sketch:** Bubble per-file errors to the caller. Surface a toast — "Filo couldn't load Project A.board.json: schema-invalid". **Preserve the tab entry** so the user can investigate. Snapshot the offending JSON to `.filo/recovery/<timestamp>/` before any subsequent save touches workspace.json.

---

### [P0-13] `loadConfig` swallows every error to a `{}` fallback — destroys hand-edits

**Location:** [src/main/vault/configOps.ts:169-189](src/main/vault/configOps.ts:169)

**What's wrong:** `try { fs.readFile … } catch { return fallback }` — any read or parse error returns the empty fallback. A user who manually edits `.filo/defaults.json` and introduces a missing comma sees the app boot with default defaults. The very first save (which serializes the in-memory state) rewrites their config with schema defaults, **overwriting their hand-edit on disk**.

**Impact:** Quietly corrupts user-edited config files on the first edit after a typo. Violates the local-first principle — the user owns the file format but cannot recover.

**Fix sketch:** Distinguish ENOENT (truly missing, fallback OK) from JSON.parse errors (corrupt, do NOT proceed). On parse failure, return `{ __corrupt: true, raw, error }` and have the renderer surface a blocking modal: Recover / Ignore / Open in editor. Do not run any debounced save while the corrupt flag is set.

---

### [P0-14] `theme:save` / `theme:delete` / `theme:load` / `snippet:load` accept `name` with no traversal guard

**Location:** [src/main/ipc/board.ipc.ts:256-275](src/main/ipc/board.ipc.ts:256) and [src/main/vault/configOps.ts:296-321](src/main/vault/configOps.ts:296) (`saveTheme`/`deleteTheme`), [:342-345](src/main/vault/configOps.ts:342) (`loadSnippet`)

**What's wrong:** `saveTheme(vaultRoot, themeName, ...)` builds `path.join(themesDirPath(vaultRoot), '${themeName}.json')`. A `themeName` of `../../../etc/passwd` collapses to an out-of-vault path. There's **no `assertWithinVault` and no `assertSafeFilename`** inside `configOps.saveTheme/deleteTheme` and **none in the IPC wrapper**.

**Impact:** A renderer (buggy or compromised via a malicious iframe tile) can write arbitrary `.json` files anywhere on disk that the user can write to, simply by passing `..` in the `name` parameter. Same primitive for delete.

**Fix sketch:** Add `assertSafeFilename(themeName)` at the IPC layer for `theme:save/delete/load` and `snippet:load`. Same for any other `name`-parameter handlers.

---

### [P0-15] `config:save` (and family) accept caller-supplied `vaultRoot` without active-vault check

**Location:** [src/main/ipc/board.ipc.ts:181-192](src/main/ipc/board.ipc.ts:181) → [src/main/vault/configOps.ts:235-244](src/main/vault/configOps.ts:235); same hole in `config:load`, `config:save-workspace`, `config:load-all`, `theme:list`, `theme:save`, `theme:delete`, `snippet:list`, `snippet:load`, `templates:layout:list`, `templates:layout:write`

**What's wrong:** `saveConfig(vaultRoot, file, data)` joins `configFilePath(vaultRoot, file)` and calls `atomicWriteFile`. The `file` parameter is gated by `isConfigFile` (good), but the **`vaultRoot` is not validated against the active watcher vault**. A renderer can pass `vaultRoot = 'C:\\'` and write `C:\.filo\app.json`.

**Impact:** Renderer-controlled arbitrary `vaultRoot` lets the main process write `.filo/`-shaped files anywhere on disk.

**Fix sketch:** Centralise a `requireActiveVault(vaultRoot)` helper that asserts `vaultRoot === getVaultRoot()` (case-insensitive on Windows). Every handler accepting a `vaultRoot` calls it first.

---

### [P0-16] `vault:rename` / `vault:delete` / `vault:create-folder` skip containment when no vault is open

**Location:** [src/main/ipc/vault.ipc.ts:111-117, 136-138](src/main/ipc/vault.ipc.ts:111)

**What's wrong:** `if (currentVaultRoot) assertWithinVault(currentVaultRoot, oldPath);` — `currentVaultRoot` is null before `vault:watch` is called. During the launch window or after a vault is closed, a renderer call to `vault:rename('C:\Users\me\Documents\important.docx', 'C:\trash\important.docx')` would succeed. Containment is not checked and `fs.rename` is happy.

**Impact:** A buggy or compromised renderer can rename/delete arbitrary files on the host filesystem during the brief window before any vault is open.

**Fix sketch:** Fail closed: if `currentVaultRoot` is null, return `{ success: false, error: 'no vault open' }`. The renderer should never issue these calls without a vault.

---

### [P0-17] `media:open-external` has no SSRF guard despite the comment claiming one

**Location:** [src/main/ipc/media.ipc.ts:82-105](src/main/ipc/media.ipc.ts:82)

**What's wrong:** The comment says "Allow http:// for localhost dev scenarios but not arbitrary URLs", but there's **no check that the URL is actually localhost**. `shell.openExternal('http://192.168.1.1/router-admin')` happily fires. The sister handler `link:fetch-metadata` does have an `isPrivateUrl` guard; `media:open-external` does not.

**Impact:** Renderer-triggered drive-by request to arbitrary URLs (including private network). Click-equivalent on internal devices.

**Fix sketch:** Apply `isPrivateUrl()` to the http(s) branches. If dev mode needs localhost, gate behind `process.env.NODE_ENV !== 'production'`.

---

### [P0-18] "Delete file too" makes Ctrl+Z unrecoverable — file is gone, ghosts return

**Location:** [src/renderer/components/layout/AppShell.svelte:124-143](src/renderer/components/layout/AppShell.svelte:124) + [src/renderer/commands/index.ts:96-177](src/renderer/commands/index.ts:96)

**What's wrong:** When the user ticks "Delete associated files from vault" in the multi-tile delete confirmation, `confirmDelete` calls `vault:delete` on the `.md` file **before** pushing the undoable `DeleteTilesCommand`. The file deletion is not part of any Command. On Ctrl+Z, tile placements are restored from the snapshot but the backing file is gone. The Command's own toast acknowledges this with a "restored tiles reference missing files" warning — proof it's a known asymmetry.

**Impact:** User deletes five tiles with "delete files" checked, regrets it, hits Ctrl+Z. Tiles come back as broken-ref ghosts pointing at deleted markdown. The body content is unrecoverable.

**Fix sketch:** Either (a) snapshot the markdown file contents before deleting, have `DeleteTilesCommand` carry them, and restore the files via the vault API on undo; or (b) make the file deletion explicit and one-way — show a separate confirmation that the file delete is permanent, and disable the Ctrl+Z restore for that specific step. (a) is the least surprising.

---

## P1 — Correctness bugs the user will hit

### [P1-1] Renamer falsely pairs unrelated cross-directory delete + create with same basename

**Location:** [src/main/services/renameCorrelation.ts:30-50](src/main/services/renameCorrelation.ts:30)

**What's wrong:** Events bucket by basename. Two unrelated ops within the 300 ms debounce window — user deletes `notes/foo.md` AND independently creates `archive/foo.md` (git checkout, file explorer) — produce a single missing + single present and fuse into a fake `notes/foo.md → archive/foo.md` rename. Tile filePath fields then silently rewrite to the unrelated file.

**Impact:** Tile references silently point at the wrong file. Content swaps "magically".

**Fix sketch:** Add a same-file-size heuristic (cheap, available via `fs.stat`) before treating as rename. Or surface a low-confidence "Detected rename: foo.md → archive/foo.md — apply?" toast.

---

### [P1-2] `vault:write-file-text` watcher suppression is too short on slow disks

**Location:** [src/main/ipc/vault.ipc.ts:226](src/main/ipc/vault.ipc.ts:226) (no explicit suppress duration → 500 ms default) vs [board.ipc.ts:104](src/main/ipc/board.ipc.ts:104) (2000 ms with re-suppress after write)

**What's wrong:** Board saves use 2000 ms with a re-suppress after the write. `.md` file writes use the 500 ms default with no re-suppress. On a slow filesystem (network share, antivirus quarantine, BitLocker) the `fs.writeFile` can take 800 ms+, the watcher fires after the suppress expires, and the renderer treats the just-written event as external — racing the still-armed 300 ms TextTile debounce.

**Impact:** Intermittent ghost-reload toasts on slow disks, with risk of clobbering in-progress edits.

**Fix sketch:** Mirror `board.ipc.ts:104` — suppress 2000 ms before AND after the write.

---

### [P1-3] Concurrent rename + write race — body silently writes to old path

**Location:** [src/renderer/stores/vaultFolderOps.ts:39-77](src/renderer/stores/vaultFolderOps.ts:39); editor write at [src/renderer/components/tiles/TextTile.svelte](src/renderer/components/tiles/TextTile.svelte) and [DocumentEditor.svelte](src/renderer/components/boards/DocumentEditor.svelte)

**What's wrong:** The rename IPC is awaited synchronously, but the editor's debounced markdown writer may have a flush armed against the *old* path at the moment rename fires. The rename IPC lands, `documentStore.updateFilename` runs, but if a `vault:write-file-text` is already on the wire targeting the old path, the old `.md` gets resurrected. The conflict resolver only classifies external *edits*, not renames. `flushAllMarkdownWriters` runs only on explicit `save()`, not on rename.

**Impact:** Rename `Foo.md` → `Bar.md` while an active editor has a pending write. After: `Bar.md` exists with renamed content, then a debounce resurrects `Foo.md` with the same content. Duplicate file, no broken-ref since both exist.

**Fix sketch:** In `vaultFolderOps.rename`, `await flushAllMarkdownWriters()` (or cancel any markdown writer targeting `oldRel`) before the IPC. Then rename; `documentStore.updateFilename` re-arms against the new path.

---

### [P1-4] `vault:rename` is not transactional with tile filePath cascade

**Location:** [src/renderer/stores/vaultFolderOps.ts:39-77](src/renderer/stores/vaultFolderOps.ts:39)

**What's wrong:** Step 1 fs.rename → Step 2 in-memory `propagateRename` → Step 3 `documentStore.updateFilename` → Step 4 `refreshTree`. If step 2 throws or the renderer crashes between steps, the disk is at the new path but tile defs still point at the old. No rollback.

**Impact:** Partial cascades leave broken refs; future writes resurrect the old file via mkdir-p.

**Fix sketch:** Run propagation BEFORE the IPC rename. On IPC failure, revert in-memory. Or wrap with try/catch and rebuild from `vault:read-tree` on error.

---

### [P1-5] Tag-rename sweep has no rollback or retry on per-file failure

**Location:** [src/renderer/stores/fileTags.svelte.ts:329-388](src/renderer/stores/fileTags.svelte.ts:329) (`rewriteTagInAllMarkdown`)

**What's wrong:** The aggregate toast at 380-387 reports failed files, but `.filo/tags.json` and the in-memory tile-def rewrites have **already committed**. There's no rollback. The user is told "Tag rename failed for N of M files" with no path to retry, and no way to roll back `.filo/tags.json`.

**Impact:** Permanent drift: `.filo/tags.json` says `newTag`, board JSON says `newTag`, failed `.md` files still say `oldTag` in frontmatter. On next vault open, `detectOrphans` flags lingering `#oldTag` as undefined.

**Fix sketch:** Flip the order — rewrite `.md` files first in a try/catch loop, commit registry + board changes only on full success. Or pre-flight a writability probe and surface failed paths via toast for retry.

---

### [P1-6] `flushAllMarkdownWriters` swallows per-writer errors; Ctrl+S falsely reports "Saved"

**Location:** [src/renderer/lib/boards/markdownWriteRegistry.ts:31-39](src/renderer/lib/boards/markdownWriteRegistry.ts:31)

**What's wrong:** `Promise.all(snapshot.map(fn => fn().catch(err => console.error(...))))` — errors are logged but not propagated. `vaultStore.save()` calls this first; if a markdown flush fails, the boolean return is still `true`. App quit handles this via `saveStateStore.state === 'error'`, but interactive Ctrl+S just shows "Saved" because `save()` returns `true`.

**Impact:** Manual save falsely reports success when a markdown flush failed mid-batch. The user trusts a lie.

**Fix sketch:** Return `{ ok: number, failed: number }` from `flushAllMarkdownWriters`. `vaultStore.save()` returns false on any failure; Ctrl+S UI reflects it.

---

### [P1-7] Multiple `.md` write callers don't surface failures at all

**Location:** [src/renderer/stores/boardCacheTiles.ts:135](src/renderer/stores/boardCacheTiles.ts:135) (text-tile creation), [kanbanTileCreation.ts:144,221](src/renderer/lib/kanban/kanbanTileCreation.ts:144), [taskCreation.ts:155](src/renderer/lib/tasklist/taskCreation.ts:155), [fileDropHandler.ts:151](src/renderer/lib/tasklist/fileDropHandler.ts:151), [KanbanSideToolbar.svelte:109](src/renderer/components/boards/KanbanSideToolbar.svelte:109)

**What's wrong:** Each writes a new `.md` file without `trackComponentWrite`. Failures don't increment `failedVaultPaths`, don't surface through the save-error toast, and don't keep `.filo/.dirty` populated. Some show an ad-hoc toast on catch; others swallow.

**Impact:** Failed creations (disk full, permission denied) produce a tile in memory whose backing file never exists — broken-ref state.

**Fix sketch:** Wrap each in `trackComponentWrite(vaultRoot, relPath, () => …)`.

---

### [P1-8] `dirtyFlagRecovery` swallows non-ENOENT errors as "no recovery needed"

**Location:** [src/renderer/lib/vault/dirtyFlagRecovery.ts:105-107](src/renderer/lib/vault/dirtyFlagRecovery.ts:105)

**What's wrong:** The outer `try…catch { return { needsRecovery: false } }` catches every error, including permission-denied and corrupted-JSON cases where recovery is actually needed.

**Impact:** A vault that needed recovery but has a corrupted sentinel silently boots clean — the very crash signal that should fire is muted.

**Fix sketch:** Split: only ENOENT becomes `needsRecovery: false`. Any other error → `needsRecovery: true` with a "sentinel unreadable" reason.

---

### [P1-9] Frontmatter writers return null on read failure with no surfacing

**Location:** [src/renderer/stores/fileTags.svelte.ts:139-160](src/renderer/stores/fileTags.svelte.ts:139) (`writeTagChangeToTileMarkdown`), [:290-317](src/renderer/stores/fileTags.svelte.ts:290)

**What's wrong:** `if (raw === null) return;` — on read failure, the tag-change write is silently skipped. The tile def and `.filo/tags.json` are already updated, but frontmatter on disk is not. No toast.

**Impact:** Tag drift between `.filo/tags.json` and `.md` frontmatter.

**Fix sketch:** When read returns null but `vault:file-exists` is true, surface a per-file warning and add the path to `failedVaultPaths`.

---

### [P1-10] `renameItem` is `fs.rename` — fails on cross-FS and case-only renames on Windows

**Location:** [src/main/vault/fileOps.ts:76-78](src/main/vault/fileOps.ts:76)

**What's wrong:** `fs.rename` returns `EXDEV` across volumes; on Windows (case-insensitive), `fs.rename('Foo.md', 'foo.md')` is a no-op or errors depending on Node version.

**Impact:** Case-only renames silently no-op (UI shows rename succeeded after tree refresh, but disk wasn't changed). Cross-drive moves error out.

**Fix sketch:** Windows: detect case-only rename, route via a temporary name. On EXDEV: `fs.copyFile` + `fs.unlink`. The renderer cascade is path-string-based so the copy semantics are fine.

---

### [P1-11] Folder rename does not cascade `.filo/tags.json`

**Location:** [src/renderer/lib/vault/tagsStorage.ts:287-296](src/renderer/lib/vault/tagsStorage.ts:287) (`renameFile` is exact-match only) + the missing call site in `vaultFolderOps`

**What's wrong:** `tagsStorage.renameFile` only rewrites a single exact-match key. When a folder is renamed, every child file's path changes prefix — nothing iterates child entries. (Compounded by P0-6 — even fixing the call site, the helper only handles single-file rename.)

**Impact:** Renaming any folder containing tagged attachments orphans all tag assignments.

**Fix sketch:** Add `renameFolderInTags(file, oldPrefix, newPrefix)` that walks keys, rewrites the prefix, and call it from the folder-rename path.

---

### [P1-12] `UpdateCardFieldCommand` doesn't flush pending writes before applying

**Location:** [src/renderer/commands/index.ts:1329-1363](src/renderer/commands/index.ts:1329); contrast [:700-712](src/renderer/commands/index.ts:700) (`UpdateTaskFieldCommand`, which DOES flush)

**What's wrong:** The Task variant explicitly drains `flushAllPendingFrontmatterWrites()` to avoid a "rapid toggle → undo races the still-debounced forward write against the inverse patch" bug. The Kanban variant doesn't.

**Impact:** Rapid Kanban-card frontmatter toggle followed by Ctrl+Z can see a stale debounced write land *after* the inverse patch, restoring the wrong state.

**Fix sketch:** Mirror the Task command — `void flushAllPendingFrontmatterWrites();` at top of both `execute()` and `undo()`.

---

### [P1-13] `UpdateCardFieldCommand` reads stale source for inverse snapshot

**Location:** [src/renderer/lib/kanban/kanbanFrontmatterWriter.ts:88](src/renderer/lib/kanban/kanbanFrontmatterWriter.ts:88)

**What's wrong:** Reads `fmBefore` from `vaultIndexStore` (last-rescan). The Task counterpart reads from `documentStore` (live, in-memory). Two rapid edits before flush + Ctrl+Z restores the *pre-pre* state, not the immediate predecessor.

**Impact:** Undo jumps back two steps' worth on rapid Kanban-field edits.

**Fix sketch:** Prefer `documentStore.getFrontmatter(docId)`, fall through to `vaultIndexStore`.

---

### [P1-14] Whole categories of operations are non-undoable

**Location:** [src/renderer/components/layout/AppShell.svelte:260-334](src/renderer/components/layout/AppShell.svelte:260) (group/lock/ungroup); [src/renderer/stores/boardWaypointsGroups.ts](src/renderer/stores/boardWaypointsGroups.ts) entire file (waypoints); [src/renderer/stores/board.svelte.ts:262-269](src/renderer/stores/board.svelte.ts:262) (`updateSettings`)

**What's wrong:** Ctrl+G group, Ctrl+L lock-toggle, waypoint add/remove/move/rename/lock, group/ungroup tiles, and **all Current Board Settings** changes go straight to `boardCacheStore.markDirty` without a Command.

**Impact:** Accidental Ctrl+G can't be undone. Worse, the *next* Ctrl+Z reverses an *older* tile move with no UI indication that the group op was skipped. Same for any board background or default-font tweak.

**Fix sketch:** Add `ToggleGroupCommand`, `ToggleLockCommand`, waypoint command classes, and `UpdateBoardSettingsCommand(boardId, patch, inversePatch)`. Wrap call sites with `historyStore.execute(new …)`.

---

### [P1-15] `historyStore` cap silently drops oldest commands

**Location:** [src/renderer/stores/history.svelte.ts:22, 76, 106, 119](src/renderer/stores/history.svelte.ts:22)

**What's wrong:** `MAX_HISTORY = 100`; on overflow, `slice(-MAX_HISTORY)` drops the head with no notice. No toast, no greying of the toolbar button.

**Impact:** Long editing session: user assumes Ctrl+Z keeps going. It does, until it suddenly stops with the toolbar still active.

**Fix sketch:** Emit a one-shot info toast the first time truncation happens. Deeper fix: ring buffer so toolbar disabled state matches reality.

---

### [P1-16] `cascadeDeleteByVaultPath` for an active board bypasses history

**Location:** [src/renderer/stores/boardFrontmatterSync.ts:126-137](src/renderer/stores/boardFrontmatterSync.ts:126)

**What's wrong:** `ctx.removeTile(tileId)` runs directly without wrapping in a Command. The user has no way to undo the cascade — accidentally deleting a folder of 30 `.md` files sweeps 30+ tiles across boards with no undo.

**Impact:** Folder restore from Recycle Bin doesn't bring tile placements back. Manual re-placement.

**Fix sketch:** Wrap the cascade in a batch Command per board that records every removed tile.

---

### [P1-17] `ProjectSettings.safeParse` failure discards all user settings

**Location:** [src/renderer/stores/vault.svelte.ts:336-371](src/renderer/stores/vault.svelte.ts:336)

**What's wrong:** If one numeric field is out of range (a user manually editing `kanban.column.width: 5000` past the 120-2000 max), `safeParse` fails and the renderer falls back to *all-defaults*. The next debounced save re-writes `defaults.json` with all-default settings, discarding everything else the user had.

**Impact:** One bad value silently wipes every other custom setting.

**Fix sketch:** Use `.partial()` or per-field `.catch()` so invalid fields fall back individually. Surface a toast: "Some settings couldn't be loaded; see console."

---

### [P1-18] Frontmatter `tags` accepts only string arrays — Obsidian compat breaks

**Location:** [src/renderer/schema/frontmatter.ts:15](src/renderer/schema/frontmatter.ts:15)

**What's wrong:** `tags: z.array(z.string()).default([])`. A user with YAML `tags: foo, bar` (comma-string) hits the schema reject; `TileFrontmatterSchema.default({})` falls back to `{}`, silently dropping tags from the index. Obsidian vaults commonly use comma-separated or single-string tags.

**Impact:** Imported Obsidian vaults silently lose tags.

**Fix sketch:** `z.preprocess` to coerce string→split on comma, null→`[]`. Same for `aliases`.

---

### [P1-19] `vault:write-file-text` accepts deeply nested paths without depth limit

**Location:** [src/main/ipc/vault.ipc.ts:215-234](src/main/ipc/vault.ipc.ts:215)

**What's wrong:** `relativePath` is taken at face value as a string and `mkdir({recursive:true})`-ed. `assertWithinVault` blocks `..` escape but a renderer passing `Notes/sub/sub/.../sub/file.md` materialises an unbounded tree. No length limit, no control-char check.

**Impact:** Bug or compromised extension can materialise an unexpectedly deep tree inside the vault.

**Fix sketch:** Max-depth check (e.g. 10 segments), per-segment `assertSafeFilename`, schematize the payload with Zod.

---

### [P1-20] Preload IPC bridge accepts `unknown[]` args — no per-channel type narrowing

**Location:** [src/main/preload.ts:13-35](src/main/preload.ts:13)

**What's wrong:** `invoke: (channel: IpcChannel, ...args: unknown[]) => …`. No per-channel payload type. Every IPC handler in main must defensively narrow `unknown`; some do (e.g. `vault:add-recent`), most don't.

**Impact:** Compounds every other finding — a renderer call with malformed types crashes the handler with an unhelpful stack trace, leaks to console.

**Fix sketch:** Per-channel payload schemas (`const PAYLOADS = { 'vault:rename': z.tuple([z.string(), z.string()]), ... }`). Central `invoke` wrapper runs `safeParse` and rejects with `{ ok: false, error: 'bad-payload' }`.

---

### [P1-21] `shell:show-item-in-folder` accepts any path — no vault containment

**Location:** [src/main/ipc/shell.ipc.ts:24-28](src/main/ipc/shell.ipc.ts:24)

**What's wrong:** `shell.showItemInFolder(fullPath)` reveals any path the renderer passes. Inconsistent with the otherwise strict vault containment.

**Impact:** A compromised renderer can open arbitrary host folders (phishing/lateral move primitive).

**Fix sketch:** `if (!getVaultRoot()) return false; assertWithinVault(getVaultRoot(), fullPath);`.

---

### [P1-22] `vault:copy-file` has no read-side guard for `sourcePath`

**Location:** [src/main/ipc/vault.ipc.ts:291-314](src/main/ipc/vault.ipc.ts:291) → [fileOps.ts:107-129](src/main/vault/fileOps.ts:107)

**What's wrong:** Reads from any absolute path the renderer supplies. Combined with `media:read-file`, this is a primitive for "copy any host file into the vault". Intended for drag-drop, but no rate limit, no provenance, no size cap.

**Impact:** Compromised renderer can systematically slurp the user's filesystem into the vault.

**Fix sketch:** Stat the source first, refuse > N MB. Optionally require `IpcMainInvokeEvent.senderFrame.url` check.

---

### [P1-23] Application errors aren't surfaced to the user

**Location:** [src/renderer/core/app.ts:8](src/renderer/core/app.ts:8) — TODO already notes this. errorBus exists at [src/renderer/lib/utils/errorBus.ts](src/renderer/lib/utils/errorBus.ts) but only 7 production sites call `reportError` versus 154 raw `console.error/warn/log` across 71 files.

**What's wrong:** Most subsystem failures (boardSaver, vaultIndex, fileRefIntegrity, conflictResolver, dirtyFlagRecovery, fileTags, every component-level write) write to the dev console, which the end-user never opens. The Toast subscriber on `errorBus` is wired in `App.svelte` — but almost nothing publishes to it.

**Impact:** Silent failures hide data-loss bugs from the user. Many P0/P1 issues above are reachable specifically because there's no UI surface for the underlying error.

**Fix sketch:** Replace `console.error` with `reportError(context, err, message)` in every subsystem that touches disk or user data. Keep `console.error` as a breadcrumb (the bus already mirrors it). Focus first on: boardSaver, vault.ipc, configOps, all vault/* lib modules, every IPC `.catch()` branch in main.

---

### [P1-24] Ctrl+K "Insert Link" shortcut is documented but unbound

**Location:** [src/renderer/components/layout/AppShell.svelte:228-335](src/renderer/components/layout/AppShell.svelte:228) (shortcut registrations); design doc table at `Filo_Design_Doc_Rework_V5.md:870`

**What's wrong:** Doc lists `Ctrl+K → Insert Link`. The shortcut is not registered. `setLink` exists in `toolbarConfig.ts:210` and `TextFormattingToolbar.svelte:97` only as a toolbar button.

**Impact:** Documented shortcut silently does nothing.

**Fix sketch:** Register `editor:insert-link` via `registerCommandWithShortcut` bound to Ctrl+K.

---

### [P1-25] Ctrl+Arrow "Add/Select Neighbour" not implemented

**Location:** design doc `Filo_Design_Doc_Rework_V5.md:872`

**What's wrong:** Doc lists `Ctrl+Arrow → Add/Select Neighbour`. Grep for `selectNeighbour|addNeighbour|navigateNeighbour` returns zero matches. Only basic arrow-key tile selection exists in [mindMapKeyboard.ts:32-35](src/renderer/lib/mindmap/mindMapKeyboard.ts:32).

**Impact:** Documented shortcut silently no-ops.

**Fix sketch:** Wire it up, or remove from doc.

---

### [P1-26] `npm run package` fails — icon raster files missing, raster deps not installed

**Location:** [package.json](package.json) (`win.icon: 'resources/icon.ico'`, `mac.icon: 'resources/icon.icns'`, `linux.icon: 'resources/icon.png'`); [scripts/generate-icons.mjs](scripts/generate-icons.mjs:44)

**What's wrong:** Only `resources/icon.svg` exists. The `generate-icons.mjs` script requires `sharp`, `png-to-ico`, and `png2icons` — **none of which are declared in `package.json` devDependencies**. The `package` npm script does `npm run build && electron-builder` with no icon-generation step.

**Impact:** `npm run package` / `npm run package:win` will fail with a missing-icon error on the first try after a fresh `npm install`.

**Fix sketch:** Either chain `npm run icons` into `package`, install the deps as devDependencies, or commit the rasterised outputs.

---

## P2 — Hygiene / robustness

### Persistence / cascade hygiene

- **[P2]** Atomic-write retry leaves orphan `.tmp` files on prior crash. ([filenameUtils.ts:114-138](src/main/vault/filenameUtils.ts:114))
- **[P2]** `assertWithinVault` realpath loop exits silently if the whole chain to root doesn't exist. ([pathSecurity.ts:27-55](src/main/utils/pathSecurity.ts:27))
- **[P2]** `flushBoardWrite` re-arm race has a subtle "args getter at fire time" invariant with no test or comment. ([boardWriteScheduler.ts:158-181](src/renderer/lib/boards/boardWriteScheduler.ts:158))
- **[P2]** No write queue per board — `scheduleBoardWrite` is last-wins; rapid re-arming during an in-flight write can fire two parallel `board:save` IPCs. Atomic-write retry handles it on Windows; Linux/macOS may interleave. ([boardWriteScheduler.ts:34-69](src/renderer/lib/boards/boardWriteScheduler.ts:34))
- **[P2]** `boardLoader.findBrokenRefs` is narrower than `detectBrokenRefs` (only checks `src`/`filePath`, not `file`/`coverImage`) and its result is never consumed. Dead code. ([boardLoader.ts:130-142](src/renderer/lib/boards/boardLoader.ts:130))
- **[P2]** `flattenTreePaths` emits case-as-on-disk while consumers re-lowercase — confusing latent invariant. ([vaultTreeSort.ts:203-216](src/renderer/lib/vault/vaultTreeSort.ts:203))
- **[P2]** Concurrent rename + external write race not classified by conflictResolver. ([conflictResolver.ts:45-83](src/renderer/lib/vault/conflictResolver.ts:45))
- **[P2]** Sentinel `pendingPaths` Set relies on Set-iteration-is-insertion-order for "trim oldest" — load-bearing convention with no comment. ([writeStateTracking.ts:46-58](src/renderer/lib/boards/writeStateTracking.ts:46))
- **[P2]** `vault:read-file-text` (absolute) vs `vault:write-file-text` (vaultRoot+rel) asymmetric API breeds encoding bugs at call sites. ([vault.ipc.ts:168-184](src/main/ipc/vault.ipc.ts:168))
- **[P2]** Config-write skip-if-unchanged dedupe never recovers from a partial-write failure. ([configWriteScheduler.ts:140-166](src/renderer/lib/boards/configWriteScheduler.ts:140))
- **[P2]** `boardWriteScheduler.scheduleBoardWrite` leaks the original path on mid-debounce rename — sentinel accumulates stale paths until trim. ([boardWriteScheduler.ts:38-49](src/renderer/lib/boards/boardWriteScheduler.ts:38))
- **[P2]** `detectBrokenRefs` skips paths with leading `/` or scheme but doesn't normalise vault-relative paths first — asymmetric with rewrite path. ([fileRefIntegrity.ts:450](src/renderer/lib/vault/fileRefIntegrity.ts:450))
- **[P2]** Inline `#tag` body text not rewritten on tag rename; the body chip styling can mis-resolve. ([tagRewriter.ts:6-12](src/renderer/lib/vault/tagRewriter.ts:6))
- **[P2]** `propagateMarkdownRenameToTextTiles` skip-when-`filePath` makes the two rename pipelines have a fragile implicit contract. ([fileRefIntegrity.ts:294-295](src/renderer/lib/vault/fileRefIntegrity.ts:294))

### Schema hygiene

- **[P2]** `BoardSchema` `.passthrough() + .default([])` on every collection field creates silent data drift if a `$state` proxy returns `undefined` for a deleted property. ([board.ts:482-488](src/renderer/schema/board.ts:482))
- **[P2]** `loadConfig` legacy "double-stringified" recovery is silent one-way mutation with no log. ([configOps.ts:178-184](src/main/vault/configOps.ts:178))
- **[P2]** `TileDefinitionSchema` task-metadata strip list duplicated in `TASK_METADATA_FIELDS_ON_WRITE` — two places to keep in sync. ([tile.ts:205-225](src/renderer/schema/tile.ts:205))
- **[P2]** Mind-map viewport silently stripped on save without snapshot — hand-edits lost. ([boardWriteScheduler.ts:117-120](src/renderer/lib/boards/boardWriteScheduler.ts:117))
- **[P2]** `vault:file-exists` collapses ENOENT and permission-error to `false` — caller can't distinguish "not there" from "blocked". ([vault.ipc.ts:193-205](src/main/ipc/vault.ipc.ts:193))
- **[P2]** `recent-vaults.json` reader has no schema; malformed file crashes launch. ([recentVaults.ts:31-51](src/main/services/recentVaults.ts:31))

### IPC hygiene

- **[P2]** `media:read-file` lacks a `typeof === 'string'` guard on its path param. ([media.ipc.ts:55-76](src/main/ipc/media.ipc.ts:55))
- **[P2]** `media:save-audio` rejects `..` in `destFolder` only via the joined `assertWithinVault` — silently normalises to vault root rather than erroring. ([media.ipc.ts:20-46](src/main/ipc/media.ipc.ts:20))
- **[P2]** `export:save` doesn't whitelist `format` or sanitize `defaultName` — Windows reserved names (CON.png, NUL.png) can land on disk. ([export.ipc.ts:14-53](src/main/ipc/export.ipc.ts:14))
- **[P2]** `dialog:open-file` / `dialog:save-file` returns host paths that downstream callers trust without re-validation. Document the trust boundary. ([dialog.ipc.ts:33-86](src/main/ipc/dialog.ipc.ts:33))

### Undo / commands hygiene

- **[P2]** `DeleteTilesCommand` connection snapshot is shallow `{...c}` — nested `label` reference shared with live object. ([commands/index.ts:103-124](src/renderer/commands/index.ts:103))
- **[P2]** `cloneTile` reportedly shares string references "to save memory" — audit for `style`/`tags`/`position` deep clone. ([commands/index.ts:106](src/renderer/commands/index.ts:106))
- **[P2]** `AddColumnCommand.undo` doesn't snapshot full kanban slice — interleaved column+card batches can leave orphan placements. ([commands/index.ts:1226-1259](src/renderer/commands/index.ts:1226))
- **[P2]** `UpdateTileStyleCommand` defined but never used — tile style edits aren't undoable. ([commands/index.ts:238-258](src/renderer/commands/index.ts:238))
- **[P2]** `MoveTilesCommand` asymmetric toast: warns on missing tiles in `undo` but not `execute`. ([commands/index.ts:188-213](src/renderer/commands/index.ts:188))
- **[P2]** Hotkey filter fires board undo when focus is on a modal-trapped element, silently mutating board behind the modal. ([hotkeys.ts:53-71](src/renderer/core/hotkeys.ts:53))
- **[P2]** Closing a tab does not clear that board's history — memory grows across long sessions of opening/closing boards. ([tabs.svelte.ts:80-101](src/renderer/stores/tabs.svelte.ts:80))
- **[P2]** Commands constructor-time snapshots are a fragile implicit contract — caller must dispatch atomically. Worth a comment at the top of `commands/index.ts`.

### Dead code / dead deps

- **[P2]** `lib/commands/` directory is empty (legacy scaffolding).
- **[P2]** Dead npm dependencies: `marked`, `turndown` (+ `@types/turndown`), `remark-stringify`, `@use-gesture/vanilla`. All imported by zero files. (`package.json:57,66,63,50`)
- **[P2]** `dialog:save-file` IPC handler unused — `export:save` is the real path. ([dialog.ipc.ts:63-90](src/main/ipc/dialog.ipc.ts:63))
- **[P2]** Snippets feature shipped in main, never reachable from UI — `snippet:list` / `snippet:load` IPC handlers exist with no caller. ([board.ipc.ts:278-294](src/main/ipc/board.ipc.ts:278))
- **[P2]** Window chrome IPC handlers (`window:minimize/maximize/unmaximize/close/is-maximized`) wired but unreachable — no custom titlebar. ([window.ipc.ts:19-50](src/main/ipc/window.ipc.ts:19))
- **[P2]** `board:rename` IPC handler unused (renames go through `vault:rename`). ([board.ipc.ts:147](src/main/ipc/board.ipc.ts:147))
- **[P2]** `core/app.ts` global app object never imported — direct store imports won out. ([core/app.ts:27](src/renderer/core/app.ts:27))
- **[P2]** `getAllCommands` / `getCommand` / `isCommandEnabled` exported from commandRegistry but unused — command palette never built. ([commandRegistry.ts:70-89](src/renderer/core/commandRegistry.ts:70))

### Docs drift

- **[P2]** CLAUDE.md project-structure section is stale on multiple counts: `boardCache.svelte.ts` split into many files (not reflected), several listed stores don't exist (`clipboard.svelte.ts`, `tags.svelte.ts`, `tiles.svelte.ts`), `lib/connections/smartRouter.ts` doesn't exist, `TemplatePicker.svelte` should be `TemplateBrowser.svelte`, `ConnectionLabelStyle.svelte` should be `ConnectionStylePopup.svelte`, `lib/utils/debounce.ts` and `lib/utils/navigation.ts` don't exist.
- **[P2]** `static/icons/` doesn't exist despite CLAUDE.md listing it. (All icons inline today.)
- **[P2]** Design doc still says Kanban side-toolbar position "persists in localStorage per machine" — `localStorage` was eliminated 2026-05-17 (memory: `save_system_audit.md`).
- **[P2]** Design doc Vault Sidebar lists legacy sort vocabulary (`Alphabetical / Reverse Alphabetical / Newest / Oldest`) — new UI uses `VaultSortField + VaultSortDirection`.
- **[P2]** Design doc references "Help → About" sub-item — no About panel exists; current Help modal is keyboard-shortcuts only.
- **[P2]** Recovery Files modal title text reads as toast copy ("Recovered from unflushed changes"), not modal title. ([AppShell.svelte:490](src/renderer/components/layout/AppShell.svelte:490))

### Lint / build hygiene

- **[P2]** `coverage/` directory not in [eslint.config.js](eslint.config.js:9) ignores — lint trips on auto-generated coverage HTML.
- **[P2]** `vault.svelte.ts:657` uses `new Set<string>()` (local hot-path lookup); lint flags as needing `SvelteSet`. False positive — the variable isn't reactive — but worth a disable comment with rationale or a swap to `Array.includes`.
- **[P2]** `KanbanColumn.svelte:78` unused param `e` should be `_e` to satisfy the convention.
- **[P2]** Test coverage thresholds at 35% lines / 35% statements / 50% functions / 60% branches are very low. Critical data-integrity paths (boardSaver, conflictResolver, fileRefIntegrity, frontmatterSync, dirtyFlagRecovery, vaultIndex) ARE covered, but `lib/export`, most of `lib/kanban`, `lib/mindmap`, `lib/editor`, and most of `lib/canvas` are uncovered.
- **[P2]** E2E suite is thin — 6 spec files (`a11y`, `app`, `contextMenuKeyboard`, `focusTrap`, `splitPanes`, `taskListBoard`). The headline user flow "create vault → board → tile → close → reopen → see tile" is not exercised.

---

## P3 — Known deferrals (re-ranked alongside new findings)

Per the audit request, surfacing these so they're on one page with the rest:

- **Phase 5.3-5.8 store refactor (partial).** `board.svelte.ts` (488 LOC) and `boardCache.svelte.ts` (691 LOC) are within CI file-size budget; further splitting deferred. *Rank*: P3 — no data-integrity angle.
- **P3.7 / P3.8 / P3.9 from Style Menu Audit Phase 3.** Deferred as larger refactors. *Rank*: P3.
- **Cheerful-Wolf items 2 + 9.** Deferred pending `@testing-library/svelte` dep. *Rank*: P3 — testing infrastructure, not user-facing.
- **a11y axe-core scan / nightly E2E.** Already running (per `phase7_ci_gates.md`). Status: green. No change.
- **ESLint backlog.** Already cleared. The current 2 lint errors above are new since the clearance memo.

---

## Subsystem scorecard

| Area | Score | Comment |
|---|---|---|
| Persistence layer | **8/10** | Strong foundations (atomic boards/configs, sentinel, debouncing, suppression, graceful shutdown). P0 gaps drag effective score to 6 — most acutely the non-atomic `.md` writes. |
| Rename / delete cascade | **6/10** | In-app paths work; external rename/delete has three reachable silent-loss classes. |
| Schema integrity | **6/10** | Strong Zod coverage at boundaries; no version+migration system; `.passthrough() + .default([])` pattern creates silent-drop paths. |
| IPC safety | **5/10** | Right architecture, inconsistent enforcement; arbitrary-write primitives reachable from a renderer bug. |
| Undo/redo | **6/10** | Command pattern sound; whole feature categories (groups, waypoints, lock, board settings) non-undoable; "delete file too" is unrecoverable. |
| Tests / CI | **7/10** | Unit coverage is solid; gates are well-designed and ratchet correctly. E2E thin; coverage thresholds too low. |
| Dead code / dependency hygiene | **6/10** | A round of cleanup will remove four deps and ~8 dead handlers/exports. |
| Docs drift | **5/10** | CLAUDE.md and design doc both have known drift; doc-only fixes. |

---

## Recommended fix order

### Sprint A — must clear before starting to use Filo on real data

The P0 list. None require architectural rework; all are localised. Roughly two days of focused work:

1. Make `vault:write-file-text` atomic (P0-1). One helper swap.
2. Fix the `prompt-user` short-circuit in external-change classifier (P0-2). Three-line move.
3. Add file-exists precondition to editor writers (P0-3). One wrapper or a new IPC variant.
4. Move recovery-sentinel clear into modal-acknowledge handler (P0-4).
5. Wrap the six `vault:write-file-text` orphan call sites in `trackComponentWrite` (P0-5).
6. Wire `fileTagsStore.renameFile` / `dropFile` into rename, delete, and external-rename handlers; add folder variants (P0-6, P1-11).
7. Extend rename correlation to attachments (P0-7) and add size-based heuristic for filename-change renames (P0-8, P1-1).
8. Flush debounce immediately after rename + await `ensureAllLoaded` (P0-9).
9. Cascade-delete also clears Kanban `coverImage` (P0-10).
10. Add `version: 7` to board envelope + skeleton `migrations.ts` (P0-11).
11. Surface `board:load` failures via toast and preserve the tab (P0-12).
12. Distinguish ENOENT from JSON parse error in `loadConfig` (P0-13).
13. Add `assertSafeFilename` to `theme:*` / `snippet:*` and central `requireActiveVault(vaultRoot)` helper to every `vaultRoot`-accepting handler (P0-14, P0-15).
14. Fail closed when no vault is open in `vault:rename/delete/create-folder` (P0-16).
15. Apply `isPrivateUrl` to `media:open-external` (P0-17).
16. Snapshot `.md` contents into `DeleteTilesCommand` and restore via vault API on undo (P0-18).

### Sprint B — second week, ship before regular use widens

The high-leverage P1s. Roughly a week:

- **Reliable error surfacing** (P1-23): replace `console.error` with `reportError` in the disk-touching subsystems. This alone makes every other bug visible.
- **Editor / rename race fixes** (P1-3, P1-4).
- **`flushAllMarkdownWriters` and write-tracker propagation** (P1-6, P1-7).
- **Tag-rename atomicity** (P1-5).
- **Recovery branch for non-ENOENT sentinel error** (P1-8).
- **Watcher suppression parity for `.md`** (P1-2).
- **Windows case-only rename + EXDEV fallback** (P1-10).
- **Frontmatter writer null-result toast** (P1-9).
- **`ProjectSettings` partial fallback** (P1-17).
- **`UpdateCardFieldCommand` flush + live-source snapshot** (P1-12, P1-13).
- **Undoable group / lock / waypoints / board settings** (P1-14).
- **history truncation toast** (P1-15).
- **Cascade-delete via Command** (P1-16).
- **Frontmatter tag coercion (Obsidian compat)** (P1-18).
- **Per-channel Zod payload narrowing in IPC** (P1-19, P1-20).
- **`shell:show-item-in-folder` containment** (P1-21).
- **`vault:copy-file` source-side stat + size cap** (P1-22).
- **Packaging icon path** (P1-26): chain `npm run icons` into `package`, or commit raster outputs.
- **Wire Ctrl+K** (P1-24); remove Ctrl+Arrow from doc or implement it (P1-25).

### Sprint C — pre/post launch, ongoing

The P2s — dead code/dep cleanup, doc refresh, lint config, deeper test coverage. None block, but they reduce future maintenance load.

---

## What I did not check

- **Runtime behaviour.** No app launch, no Playwright runs, no live data integrity tests. All findings come from static reading.
- **Performance.** No claims about bundle size, frame rate, large-vault throughput, MiniSearch query latency.
- **Accessibility beyond static.** Did not run axe-core; the existing axe E2E suite is presumed green per Phase 6 memos.
- **Visual / pixel-level regressions.** No screenshots, no theme contrast spot-checks beyond reading the CSS.
- **Cross-platform binaries.** Only verified that `npm run build` produces a dist; did not verify the packaged installers work end-to-end.

---

*Audit produced by a five-agent parallel deep read on 2026-05-20. Findings reference `file_path:line_number` per project convention — each marker is clickable in the editor.*

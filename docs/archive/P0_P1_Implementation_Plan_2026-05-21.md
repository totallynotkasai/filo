# Filo — P0/P1 Implementation Plan

**Source audit:** [Full_System_Audit_2026-05-20.md](../audits/Full_System_Audit_2026-05-20.md)
**Plan date:** 2026-05-21
**Goal:** Clear every P0 blocker before the app is used on real data; ship the high-leverage P1s in the same release window; queue P2 hygiene for the follow-up sprint.

---

## Executive summary

The audit found **18 P0 issues** that touch user data, security, or crash-recovery breadcrumbs. None require architectural rework — the persistence, IPC, and command-pattern foundations are sound. What's missing is consistent enforcement of patterns that already exist elsewhere in the codebase: `atomicWriteFile`, `trackComponentWrite`, `assertWithinVault`, `assertSafeFilename`, `requireActiveVault`, the `errorBus`, and the `Command` interface.

The plan organises P0 work into **six phases**, each tightly scoped to a single subsystem so verification can happen against well-defined acceptance tests. Phases 1-6 are the blocker set; phases 7-12 are the high-leverage P1s; phase 13 is the P2 hygiene sweep.

### Phase summary

| Phase | Theme | P0s | P1s | Effort |
| --- | --- | --- | --- | --- |
| 1 | Atomic write safety | P0-1, P0-3, P0-5 | — | ~0.5 day |
| 2 | External-change & crash recovery | P0-2, P0-4 | — | ~0.5 day |
| 3 | IPC security hardening | P0-14, P0-15, P0-16, P0-17 | — | ~1 day |
| 4 | Rename / delete cascade | P0-6, P0-7, P0-8, P0-9, P0-10 | — | ~1.5 days |
| 5 | Schema & loader resilience | P0-11, P0-12, P0-13 | — | ~1 day |
| 6 | Destructive-action undo | P0-18 | — | ~0.5 day |
| 7 | Error surfacing | — | P1-23 | ~1 day |
| 8 | Race conditions & write reliability | — | P1-2, P1-3, P1-4, P1-6, P1-7, P1-10 | ~2 days |
| 9 | Tag atomicity & frontmatter compat | — | P1-5, P1-9, P1-11, P1-18 | ~1 day |
| 10 | Undo coverage extension | — | P1-12 .. P1-17 | ~2 days |
| 11 | Remaining IPC safety | — | P1-1, P1-8, P1-19, P1-20, P1-21, P1-22 | ~1.5 days |
| 12 | Doc/shortcut polish + packaging | — | P1-24, P1-25, P1-26 | ~0.5 day |
| 13 | P2 hygiene sweep | — | — | ~2 days |

**Sprint A (P0):** ~5 days. **Sprint B (P1):** ~8 days. **Sprint C (P2):** ~2 days.

### Sequencing rationale

1. **Phase 1 first** because atomic writes underpin everything else. If `vault:write-file-text` is non-atomic, every later fix is built on a corruptible primitive. Also touches the smallest surface (one IPC handler + six call sites), so it lands cleanly without blocking parallel work.
2. **Phase 2 next** because the external-change classifier silently resurrects deleted files and erases the crash-recovery sentinel — both undermine the trust-the-files-on-disk contract.
3. **Phase 3 before cascade work** because the security primitives (`requireActiveVault`, `assertSafeFilename`) are reused by handlers touched in Phase 4. Easier to add them once.
4. **Phase 4** cleans up the rename/delete pipeline. After this the file system, board JSONs, and `.filo/tags.json` are kept consistent.
5. **Phase 5** is loader resilience — once writes are safe, make sure loads don't silently lose data or corrupt user-edited config.
6. **Phase 6** closes the only P0 that's purely an undo-system gap, separated because it changes a Command class rather than IPC/vault code.
7. **Phase 7 (P1-23) is the most important P1** because every later P1 fix is easier to verify once subsystem errors are visible in the UI rather than the dev console.
8. **Phases 8-12** then attack P1s in the same subsystem groupings used for the P0 phases.

### Cross-cutting invariants to preserve

- Every disk-touching IPC handler must (a) atomic-write, (b) `assertWithinVault`, (c) `requireActiveVault`, (d) suppress its own watcher event, (e) return `{ success, code, error? }` on failure.
- Every renderer write site must wrap in `trackComponentWrite(vaultRoot, relPath, fn)` so `saveStateStore`, `failedVaultPaths`, and `.filo/.dirty` stay coherent.
- Every disk failure must route through `errorBus.reportError(context, err, message)` so the user sees a toast.
- Every undoable user action must dispatch a `Command` via `historyStore.execute`, never mutate stores directly.
- Schemas live in [src/renderer/schema/](../../src/renderer/schema/); IPC types in [src/shared/types.ts](../../src/shared/types.ts). Adding a new IPC channel still requires updating both (enforced by `ci:ipc-parity`).

### Exit gate for "ready for daily-driver use"

- All Phase 1-6 (P0) tasks merged.
- `npm run ci:verify` green.
- New unit tests covering each P0 fix.
- Manual smoke: kill the app mid-write at 5 different points; verify recovery modal surfaces the unflushed file every time.
- External rename + external delete drills (OS Explorer, `git checkout` round-trip): no broken refs.

---

## Phase 1 — Atomic write safety

**P0s addressed:** P0-1, P0-3, P0-5

### Goal

Make `.md` writes as crash-safe as `.board.json` writes already are, and stop every callsite from being able to silently recreate a file the user just deleted.

### Why first

The non-atomic `.md` write is the single most likely path to permanent data loss in everyday use. Until it's fixed, every other phase is built on a corruptible primitive. The change is also extremely localised: one helper swap in main, six wrapper additions in the renderer.

### Tasks

#### 1.1 — Route `vault:write-file-text` through `atomicWriteFile`

- **File:** [src/main/ipc/vault.ipc.ts:215-234](../../src/main/ipc/vault.ipc.ts)
- **Change:** Replace `fsPromises.writeFile(fullPath, content, 'utf-8')` with `atomicWriteFile(fullPath, content)` (already exported from [filenameUtils.ts:114](../../src/main/vault/filenameUtils.ts)).
- **Suppression:** Increase the `activeWatcher?.suppress(relativePath)` window from default 500 ms to 2000 ms to mirror [board.ipc.ts:96-106](../../src/main/ipc/board.ipc.ts).
- **Re-suppress after write:** Mirror the board pattern — call `activeWatcher?.suppress(...)` again *after* the write completes, so a slow disk's flush event doesn't escape the window. Resolves P1-2 as a side effect.

#### 1.2 — Add a `vault:write-existing-file-text` IPC variant that fails on ENOENT

- **Files:** [src/main/ipc/vault.ipc.ts](../../src/main/ipc/vault.ipc.ts), [src/shared/types.ts](../../src/shared/types.ts) (`IpcChannel` union), [src/main/preload.ts](../../src/main/preload.ts) if needed.
- **Behaviour:** Same payload as `vault:write-file-text`. If `fs.stat(fullPath)` returns ENOENT, return `{ success: false, code: 'ENOENT', error: 'file no longer exists' }` and DO NOT `mkdir -p`. Route the editor write paths (TextTile, DocumentEditor, PropertiesPopup) through this new variant.
- **Why a separate channel rather than an "expectExisting" flag:** keeps the existing semantics for file-creation call sites (tile factory drops, kanban card creation) intact without a behaviour flag the renderer can forget to set.

#### 1.3 — Wire `vault:write-existing-file-text` into editor writers

- **Editor write sites (must use the new variant):**
  - [src/renderer/components/tiles/TextTile.svelte:87-109](../../src/renderer/components/tiles/TextTile.svelte)
  - [src/renderer/components/boards/DocumentEditor.svelte:53-75](../../src/renderer/components/boards/DocumentEditor.svelte)
  - [src/renderer/components/tiles/PropertiesPopup.svelte:158-186](../../src/renderer/components/tiles/PropertiesPopup.svelte)
- **Behaviour on ENOENT:** Toast "File no longer exists" via `errorBus.reportError(...)`, mark the editor doc as "untracked", and disarm its pending writer.

#### 1.4 — Wrap orphan write sites in `trackComponentWrite`

The audit names six call sites that bypass write tracking. Wrap each:
- [src/renderer/stores/boardCache.svelte.ts:688](../../src/renderer/stores/boardCache.svelte.ts) (Tile Sync recovery flush)
- [src/renderer/stores/boardCacheTiles.ts:135](../../src/renderer/stores/boardCacheTiles.ts) (text-tile creation)
- [src/renderer/lib/kanban/kanbanTileCreation.ts:144, 221](../../src/renderer/lib/kanban/kanbanTileCreation.ts)
- [src/renderer/lib/tasklist/taskCreation.ts:155](../../src/renderer/lib/tasklist/taskCreation.ts)
- [src/renderer/lib/tasklist/fileDropHandler.ts:151](../../src/renderer/lib/tasklist/fileDropHandler.ts)
- [src/renderer/components/boards/KanbanSideToolbar.svelte:109](../../src/renderer/components/boards/KanbanSideToolbar.svelte)

Pattern at every site:
```ts
await trackComponentWrite(vaultRoot, relPath, () =>
  window.filo.invoke('vault:write-file-text', vaultRoot, relPath, content),
);
```

### Verification

- New unit tests:
  - `vault.ipc` — write-file-text leaves no partial files when interrupted mid-write (simulated via `atomicWriteFile` failure injection).
  - `vault.ipc` — `vault:write-existing-file-text` returns ENOENT when target is missing.
  - `boardCacheStore.syncTile` — on `vault:write-existing-file-text` ENOENT, `failedVaultPaths` is incremented and `saveStateStore` reflects error.
- Manual smoke: open a Text Tile, type some content, kill the app mid-write (Task Manager). Reopen → Recovery modal lists the file with non-empty content; no `.tmp` orphan on disk.

### Dependencies

None — Phase 1 is self-contained.

### Exit criteria

- `ci:ipc-parity` passes with the new channel.
- All six orphan write sites pass `trackComponentWrite` review.
- Manual crash test recovers cleanly.

---

## Phase 2 — External-change reconciliation & crash recovery

**P0s addressed:** P0-2, P0-4

### Goal

Stop the in-memory editor from silently re-creating a file the user just deleted on disk, and keep the crash-recovery sentinel until the user has actually acknowledged what was recovered.

### Why second

These two are reachable within seconds of any external file operation (`git checkout`, OS file explorer move/delete, sync-client conflict resolution). They're both small fixes but high consequence — the first re-creates deleted data, the second erases the breadcrumb left by an earlier crash.

### Tasks

#### 2.1 — Fix `prompt-user` short-circuit in classifier consumer

- **File:** [src/renderer/stores/vaultExternalChanges.ts:33-40](../../src/renderer/stores/vaultExternalChanges.ts)
- **Change:** The `if (!next) continue;` guard on line 40 fires *before* the switch, so the `prompt-user` case for an externally deleted file is never executed. Move the `!next` short-circuit *inside* the switch — only short-circuit for `sync-frontmatter` and `reload-silently` where there's nothing to apply. For `prompt-user`, surface a persistent toast: "Filo detected this file was deleted externally. [Reload] [Keep local copy]".
- **Reload action:** drop the in-memory doc from `documentStore` and cancel any pending writer for that path (`markdownWriteRegistry.cancel(rel)`).
- **Keep-local action:** re-create the file on disk via `vault:write-existing-file-text` (will fail because file is missing) — actually a new `vault:write-file-text` is correct here because user opted to re-create. Mark the doc clean.

#### 2.2 — Pair the fix with `vault:file-exists` precondition

This was P0-3's `frontmatterWriteScheduler` precondition pattern — already done as 1.2 above. After Phase 1 ships, the dirty-editor 300 ms debounce hitting after a delete cannot recreate the file, even if 2.1's toast handling is slow.

#### 2.3 — Defer `markClean` until user acknowledges recovery

- **File:** [src/renderer/stores/vault.svelte.ts:477-487](../../src/renderer/stores/vault.svelte.ts)
- **Change:** Remove the unconditional `markClean(newVaultPath)` at line 486. Instead:
  - If `pending.length === 0 && needsRecovery === true`: surface a *persistent* error toast ("Filo detected an incomplete write but couldn't find the unflushed file. Check `.filo/.dirty` manually."). The user dismisses → `markClean`.
  - If `pending.length > 0`: open the Recovery modal. The modal's "Acknowledge" handler calls `markClean`. If the user closes the modal without acknowledging (Esc / close), keep the sentinel. Add a comment.
- **Tests:** unit test asserts the sentinel survives modal cancel.

### Verification

- Unit: `vaultExternalChanges` reducer applies a delete → toast emitted on `errorBus` → file not silently recreated.
- Unit: `vaultStore.checkRecovery` does not clear sentinel when recovery is required.
- Manual: open a tile, type, kill the app. Reopen, see recovery modal. Close it without acknowledging. Close + reopen Filo → recovery modal appears again.

### Dependencies

Phase 1's `vault:write-existing-file-text` makes 2.1's race fix tight rather than best-effort.

### Exit criteria

- External delete with dirty editor → persistent toast, file stays deleted, no resurrection on disk.
- Recovery sentinel survives until explicit modal acknowledgement.

---

## Phase 3 — IPC security hardening

**P0s addressed:** P0-14, P0-15, P0-16, P0-17

### Goal

Eliminate the renderer's ability to write arbitrary files outside the open vault, open arbitrary URLs, or rename/delete host files when no vault is open.

### Why third

These don't cause silent data loss in the same way as Phases 1-2, but they invalidate the security model — a buggy or compromised iframe tile can rewrite arbitrary `.json` files. The required primitives are mostly already in the codebase (`assertWithinVault`, `assertSafeFilename`, `isPrivateUrl`); the issue is inconsistent enforcement. Fixing Phase 3 before Phase 4 means the rename/delete cascade work can rely on a tightened IPC contract.

### Tasks

#### 3.1 — Introduce `requireActiveVault(vaultRoot)` helper

- **New file:** [src/main/utils/activeVaultCheck.ts](../../src/main/utils/activeVaultCheck.ts).
- **Signature:** `assertActiveVault(vaultRoot: string): void` — throws if `vaultRoot !== getVaultRoot()` (case-insensitive on Windows, strict on POSIX).
- **Use a getter** — `getVaultRoot()` from [src/main/services/vaultManager.ts](../../src/main/services/vaultManager.ts) (or wherever the current vault is tracked).

#### 3.2 — Apply `assertActiveVault` to every `vaultRoot`-accepting handler

The audit lists these in P0-15:
- [src/main/ipc/board.ipc.ts](../../src/main/ipc/board.ipc.ts) — `config:save`, `config:load`, `config:save-workspace`, `config:load-all`, `theme:list`, `theme:save`, `theme:delete`, `snippet:list`, `snippet:load`, `templates:layout:list`, `templates:layout:write`.
- [src/main/ipc/vault.ipc.ts](../../src/main/ipc/vault.ipc.ts) — `vault:write-file-text`, `vault:write-existing-file-text` (Phase 1), `vault:rename`, `vault:delete`, `vault:create-folder` (the no-vault branch in P0-16).
- Anywhere else `grep "vaultRoot:" src/main/ipc` reveals.

Pattern: `try { assertActiveVault(vaultRoot); ... } catch (err) { return { success: false, code: 'NO_ACTIVE_VAULT', error: String(err) }; }` at the top of each handler.

#### 3.3 — Apply `assertSafeFilename` to `name`-parameter handlers

- **Files:**
  - [src/main/ipc/board.ipc.ts:256-275](../../src/main/ipc/board.ipc.ts) — `theme:save`, `theme:delete`, `theme:load`, `snippet:load`.
  - [src/main/vault/configOps.ts:296-345](../../src/main/vault/configOps.ts) — `saveTheme`, `deleteTheme`, `loadSnippet`.
- **Existing helper:** `assertSafeFilename` already exists in [src/main/vault/filenameUtils.ts](../../src/main/vault/filenameUtils.ts).
- Add it at the IPC layer AND inside the `configOps` helpers (defence in depth).

#### 3.4 — Fail closed when no vault is open in `vault:rename/delete/create-folder`

- **File:** [src/main/ipc/vault.ipc.ts:111-138](../../src/main/ipc/vault.ipc.ts)
- **Change:** Replace `if (currentVaultRoot) assertWithinVault(...)` with `assertActiveVault(currentVaultRoot)` (which throws if null). No silent "skip the check" branch.

#### 3.5 — Apply `isPrivateUrl` guard to `media:open-external`

- **File:** [src/main/ipc/media.ipc.ts:82-105](../../src/main/ipc/media.ipc.ts)
- **Change:** For `http:`/`https:` URLs, reject when `isPrivateUrl(url)` returns true (mirrors `link:fetch-metadata` at the sister handler). Gate localhost behind `process.env.NODE_ENV !== 'production'` if dev needs it.

### Verification

- New unit tests in `tests/unit/main/ipc/` covering each helper with traversal payloads (`../../../etc/passwd`, `C:\\`, etc.).
- A property-style test: for every IPC channel that accepts `vaultRoot`, attempting to call with a mismatched root returns `code: 'NO_ACTIVE_VAULT'`.

### Dependencies

None.

### Exit criteria

- `ci:ipc-parity` passes; new channels (if any) registered.
- Manual: with two vaults open in sequence, calling any handler with the closed vault's path returns the active-vault error.

---

## Phase 4 — Rename / delete cascade integrity

**P0s addressed:** P0-6, P0-7, P0-8, P0-9, P0-10

### Goal

When the user renames or deletes a vault file (in app *or* in OS Explorer / git), every dependent reference — board JSON tile defs, `.filo/tags.json`, Kanban placement `coverImage` — moves with it. No silent orphans, no broken-ref ghosts after a rename that changes the basename.

### Why fourth

Once writes are atomic (Phase 1) and the classifier respects the dirty editor (Phase 2), the cascade work can land without compounding existing data loss. Phase 3's `requireActiveVault` lets Phase 4 call IPC with confidence.

### Tasks

#### 4.1 — Wire `fileTagsStore.renameFile` / `dropFile` into the in-app rename/delete handlers

- **Helpers exist:** [src/renderer/stores/fileTags.svelte.ts:616-628](../../src/renderer/stores/fileTags.svelte.ts).
- **In-app rename:** [src/renderer/stores/vaultFolderOps.ts:39-77](../../src/renderer/stores/vaultFolderOps.ts) — after the IPC rename succeeds, call `fileTagsStore.renameFile(oldRel, newRel)`.
- **In-app delete:** [src/renderer/stores/vaultFolderOps.ts:96-143](../../src/renderer/stores/vaultFolderOps.ts) — after `boardStore.cascadeDeleteByVaultPath`, call `fileTagsStore.dropFile(rel)`.
- **External rename:** [src/renderer/stores/vault.svelte.ts:685-695](../../src/renderer/stores/vault.svelte.ts) — same `renameFile` call.

#### 4.2 — Folder-rename + folder-delete variants for the tags store

- **File:** [src/renderer/lib/vault/tagsStorage.ts:287-296](../../src/renderer/lib/vault/tagsStorage.ts) — current `renameFile` is exact-match only.
- **Add:**
  - `renameFolderInTags(file, oldPrefix, newPrefix)` — walks keys, rewrites every entry whose path starts with `oldPrefix + '/'`.
  - `dropFolderInTags(file, prefix)` — drops every entry whose path starts with `prefix + '/'`.
- **Call sites:** the folder branches of `vaultFolderOps.rename` and `vaultFolderOps.delete`.
- Resolves P1-11 as a side effect.

#### 4.3 — Extend rename correlation to attachments

- **File:** [src/main/services/renameCorrelation.ts:31](../../src/main/services/renameCorrelation.ts)
- **Change:** Replace `if (c.type !== 'document' && c.type !== 'board') continue;` with `if (c.type !== 'document' && c.type !== 'board' && c.type !== 'attachment') continue;`. Keep `.filo/` config files excluded.
- **Verify:** `correlateRenames` emits a single `vault:file-renamed` for `attachments/img.png → attachments/photo.png`, and `boardStore.propagateRename` cascades it across boards.

#### 4.4 — Same-size heuristic for filename-change renames

- **File:** [src/main/services/renameCorrelation.ts:32-49](../../src/main/services/renameCorrelation.ts)
- **Change:** When the basename buckets don't pair, gather all unpaired missing events and unpaired present events in the same batch window. If exactly one missing and one present have the same `size` (from `fs.stat`), treat as a rename. Otherwise emit a per-pair confidence telemetry (`reportError` low-severity) for debugging.
- **Better fallback (optional, defer to P1 sprint):** switch to `chokidar` for native rename detection. Note in code that the heuristic is best-effort.

#### 4.5 — Flush propagation debounce immediately after rename

- **File:** [src/renderer/lib/vault/fileRefIntegrity.ts:197](../../src/renderer/lib/vault/fileRefIntegrity.ts) (`propagateRenameAcrossBoards`).
- **Change:** Mirror `renameTagEverywhere` at [fileTags.svelte.ts:744-778](../../src/renderer/stores/fileTags.svelte.ts) — `await boardCacheStore.ensureAllLoaded()` first, then iterate. After the iteration, call `boardWriteScheduler.flushAll()` (or the equivalent flush helper) instead of relying on the 300 ms debounce.

#### 4.6 — Cascade-delete clears Kanban placement `coverImage`

- **File:** [src/renderer/lib/vault/fileRefIntegrity.ts:367-388](../../src/renderer/lib/vault/fileRefIntegrity.ts) (`findTilesToCascadeDelete`).
- **Change:** Walk `b.columns[*].tilePlacements[*]` in addition to `data.tileDefs`. Return both tile-id deletions AND a list of placements whose `coverImage` matched, so the caller nulls them.

### Verification

- Unit:
  - `correlateRenames` now pairs attachment renames; pairs cross-basename renames when sizes match; does NOT pair when sizes differ.
  - `fileTagsStore.renameFile` is invoked by `vaultFolderOps.rename` (mock + assert call).
  - `findTilesToCascadeDelete` returns `coverImage` clears for matching Kanban placements.
- Integration: create board with image tile + tagged attachment; rename via OS Explorer; reopen vault; assert tile path updated AND tag association preserved.

### Dependencies

Phase 3's `assertActiveVault` is reused in any new IPC paths added here. Phase 1's atomic writes guarantee a partially-flushed cascade survives a crash.

### Exit criteria

- External rename of `attachments/img.png` → `attachments/photo.png` survives a reopen with all tile placements + tags intact.
- External rename `Foo.md` → `Bar.md` survives a reopen (best-effort via size heuristic).
- Kanban card with cover image: delete the image file → JSON no longer references the dead path.

---

## Phase 5 — Schema & loader resilience

**P0s addressed:** P0-11, P0-12, P0-13

### Goal

Add a versioned board envelope and a migration scaffold; stop silently dropping un-loadable boards from the sidebar; stop silently rewriting user-edited config files when the user's edit introduces a syntax error.

### Why fifth

Writes are now safe (1), reconciliation is correct (2), security is tight (3), cascade is consistent (4) — but the load path can still silently corrupt user-edited files. This phase closes the last "data loss without warning" class.

### Tasks

#### 5.1 — Add `version: 7` to board envelope

- **Files:**
  - [src/renderer/schema/boardFile.ts](../../src/renderer/schema/boardFile.ts) — add `version: z.literal(7).default(7)` to `V7BoardFileDataSchema`.
  - [src/renderer/lib/boards/boardLoader.ts:26](../../src/renderer/lib/boards/boardLoader.ts) — update inline schema reference.
  - [src/renderer/lib/boards/boardSaver.ts](../../src/renderer/lib/boards/boardSaver.ts) and [boardWriteScheduler.ts](../../src/renderer/lib/boards/boardWriteScheduler.ts) — ensure the serialised JSON includes `version: 7`.
- **New file:** [src/renderer/schema/migrations.ts](../../src/renderer/schema/migrations.ts).
- **Skeleton:**
  ```ts
  type RawBoard = unknown;
  export function migrateBoardFile(raw: RawBoard): { data: V7BoardFileData; migratedFrom: number | null } { ... }
  ```
- **Behaviour:** if `version === 7`, pass through. If `version` missing, treat as legacy "V6" and run a no-op migration (since schema didn't change structurally) but emit a one-time telemetry. Future revisions hang off `migrate(fromVersion)` cases.
- **Route through:** `loadBoard` calls `migrateBoardFile(raw)` before `safeParse`.

#### 5.2 — Surface `board:load` failures via toast and preserve tab

- **File:** [src/renderer/lib/boards/boardLoader.ts:166-171](../../src/renderer/lib/boards/boardLoader.ts) (`loadAllBoards`).
- **Change:** Replace `console.warn(...); continue;` with:
  - `errorBus.reportError('board-load', err, 'Filo couldn't load <name>.board.json: <reason>')`.
  - Snapshot the offending JSON to `.filo/recovery/<timestamp>/<basename>` via a new `recovery:snapshot` IPC channel (or reuse existing snapshot helper if present).
  - Return an entry in the result `failedBoards: { boardId, path, error }[]` so the caller can render a placeholder "Failed to load" tab rather than silently dropping it from `workspace.json`.
- **Workspace.json safety:** ensure the next `flushAll` does not strip failed-board tabs. Add a `quarantined: true` flag inside the workspace entry while the file is unloadable.

#### 5.3 — Distinguish ENOENT from parse errors in `loadConfig`

- **File:** [src/main/vault/configOps.ts:169-189](../../src/main/vault/configOps.ts).
- **Change:**
  ```ts
  try {
    const raw = await fs.readFile(path, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    return { __corrupt: true, raw, error: String(err) };
  }
  ```
- **Renderer:** check for `__corrupt` and surface a blocking modal: Recover from default / Open file in OS editor / Keep current and retry later. **Disable the debounced save for that file** until the user resolves the choice.

#### 5.4 — Snapshot mind-map viewport on save (audit P2 callout, fold into 5.x)

- **File:** [src/renderer/lib/boards/boardWriteScheduler.ts:117-120](../../src/renderer/lib/boards/boardWriteScheduler.ts).
- **Change:** before stripping viewport, dump a copy to `.filo/.viewport-snapshot.json` (small file, last-wins). On load, reapply if user's `general.preserveViewport` is on.
- **Why fold in:** the stripping happens during the same envelope-version work and the snapshot is one line.

### Verification

- Unit:
  - `migrateBoardFile` round-trips a V7 file unchanged.
  - `loadAllBoards` with a corrupted `.board.json` produces a `failedBoards` entry and emits `errorBus`.
  - `loadConfig` distinguishes ENOENT from parse errors.
- Manual: hand-edit `.filo/defaults.json` to insert a syntax error → app boots with a blocking toast, **no save fires**, file on disk is unchanged.

### Dependencies

Phase 1 (so any snapshot writes use atomic). Phase 7 (`errorBus`) is helpful but not blocking — we can use `reportError` directly even before Phase 7's wider migration.

### Exit criteria

- Corrupted `.board.json` → tab visible with a "failed to load" badge, original file untouched, copy in `.filo/recovery/`.
- Corrupted config file → modal blocks save until resolved.

---

## Phase 6 — Destructive-action undo

**P0s addressed:** P0-18

### Goal

The "Delete associated files from vault" path must either be undoable (preferred) or be a clearly one-way action that disables undo for the affected tiles.

### Why sixth

It's a single Command-level change, not data-pipeline work; isolated from Phases 1-5 but blocking the "production-ready" gate because user trust in Ctrl+Z is the most relied-on safety net.

### Tasks

#### 6.1 — Snapshot `.md` contents into `DeleteTilesCommand`

- **File:** [src/renderer/commands/index.ts:96-177](../../src/renderer/commands/index.ts) (`DeleteTilesCommand`).
- **Change:**
  - In the constructor, when `deleteFiles === true`, *await read* each backing `.md` (via `vault:read-file-text`) and store `{ rel, content, frontmatter }` on the command instance.
  - In `execute()`, perform the file delete only after the tile placements are removed and after the read snapshot is in hand.
  - In `undo()`, write the snapshot contents back via `vault:write-file-text` BEFORE restoring tile placements (so the file exists when the placement re-resolves).
  - On write failure during undo, leave tiles restored but emit a clear toast: "Tile restored but file content could not be recovered" — record into `failedVaultPaths`.

#### 6.2 — Confirmation copy update

- **File:** [src/renderer/components/layout/AppShell.svelte:124-143](../../src/renderer/components/layout/AppShell.svelte) (`confirmDelete`).
- **Change:** Update the confirm dialog to explain that the file body is also snapshotted into undo, so the user knows Ctrl+Z is safe. Remove the "restored tiles reference missing files" toast from the Command since the snapshot now restores the file body too.

#### 6.3 — Optional fallback for very large attachments

- If any selected tile points at a > 25 MB attachment (image/video/audio), DO NOT include it in the snapshot (memory pressure). Show the warning copy: "Attachments over 25 MB will be permanently deleted and cannot be restored with Ctrl+Z. Continue?".

### Verification

- Unit: delete 5 tiles with `deleteFiles=true` → Ctrl+Z restores tile placements AND backing `.md` files on disk.
- Integration: simulate write failure on undo (disk full) → tiles restored, toast reports the file failures, failed paths in tracker.

### Dependencies

Phases 1, 2: writes are atomic and the file-exists guard prevents the "delete + race" pattern from breaking the restore.

### Exit criteria

- Manual scenario: delete a tile with file → confirm dialog explains restore behaviour → Ctrl+Z → tile back, file body identical to pre-delete.

---

## Phase 7 — Error surfacing (P1-23)

**P1s addressed:** P1-23

### Goal

Replace 154 raw `console.error/warn/log` calls across 71 files with `errorBus.reportError` so the user actually sees disk failures.

### Why first in the P1 set

Every other P1 fix is easier to verify when errors are visible to the user. Many of the P0/P1 issues are *only reachable* because errors stay hidden.

### Tasks

#### 7.1 — Inventory and prioritise

- Grep audit: `rg "console.(error|warn|log)" src/renderer src/main` — current count ~154.
- Prioritise call sites in disk-touching subsystems first:
  - `lib/boards/boardSaver.ts`, `boardWriteScheduler.ts`, `boardLoader.ts`, `markdownWriteRegistry.ts`.
  - `lib/vault/fileRefIntegrity.ts`, `frontmatterSync.ts`, `conflictResolver.ts`, `dirtyFlagRecovery.ts`, `vaultIndex.ts`.
  - `stores/fileTags.svelte.ts`, `boardCache.svelte.ts`, `vault.svelte.ts`, `vaultExternalChanges.ts`.
  - Every `.catch()` branch in `src/main/ipc/*.ts`.

#### 7.2 — Convert each site

- Pattern: `console.error('msg', err)` → `reportError('subsystem.action', err, 'User-facing message')`.
- Keep the `console.error` as a breadcrumb — `errorBus` already mirrors. Do not delete the console line; the dev console remains useful for stack traces.

#### 7.3 — Toast aggregation policy

- The current Toast subscriber must aggregate rapid-fire errors so a tag-rename sweep doesn't spam 50 toasts. Either (a) coalesce by `subsystem.action` over a 1 s window with a count badge, or (b) push to an error log panel reachable from the toast.

#### 7.4 — `core/app.ts` TODO cleanup

- [src/renderer/core/app.ts:8](../../src/renderer/core/app.ts) — resolve the TODO with the now-wired `errorBus`.

### Verification

- Unit: at least one site per subsystem has a test asserting `errorBus.emit` is called on simulated failure.
- Manual: yank the vault root mid-edit → toast appears with the operation that failed.

### Dependencies

None — `errorBus` exists, just needs broader adoption.

### Exit criteria

- Grep count of `console.error` in `src/` drops below 40 (keeping only the breadcrumb form alongside `reportError`).
- A failing disk operation in any of the named subsystems produces a user-visible toast within 1 s.

---

## Phase 8 — Race conditions & write reliability

**P1s addressed:** P1-2, P1-3, P1-4, P1-6, P1-7, P1-10

### Goal

Eliminate the race windows around rename/write interleaving, Windows case-only renames, cross-FS moves, and silent "save succeeded" reports when in fact a `.md` flush failed.

### Tasks

#### 8.1 — Watcher suppression parity for `.md` writes (P1-2)

- Folded into Phase 1.1 — confirm done.

#### 8.2 — Flush pending writes before rename (P1-3)

- **File:** [src/renderer/stores/vaultFolderOps.ts:39-77](../../src/renderer/stores/vaultFolderOps.ts).
- **Change:** Before the IPC rename, `await flushAllMarkdownWriters(rel)` for the path being renamed (or `flushAll()` if cheaper). Cancel any in-flight writer targeting `oldRel`.

#### 8.3 — Transactional rename + cascade (P1-4)

- **File:** [src/renderer/stores/vaultFolderOps.ts:39-77](../../src/renderer/stores/vaultFolderOps.ts).
- **Change:** Run `propagateRenameAcrossBoards` BEFORE the IPC rename. If IPC fails, revert the in-memory cascade. On unexpected throw, run a forced `vault:read-tree` and rebuild.

#### 8.4 — `flushAllMarkdownWriters` returns aggregate status (P1-6)

- **File:** [src/renderer/lib/boards/markdownWriteRegistry.ts:31-39](../../src/renderer/lib/boards/markdownWriteRegistry.ts).
- **Change:** `Promise.all(...)` → `Promise.allSettled(...)`. Return `{ ok: number; failed: { path; error }[] }`. `vaultStore.save()` returns `false` if any failed; Ctrl+S toast reflects this honestly.

#### 8.5 — Wrap every `.md` write site in `trackComponentWrite` (P1-7)

- Folded into Phase 1.4 — confirm none missed.

#### 8.6 — Windows case-only + EXDEV `renameItem` (P1-10)

- **File:** [src/main/vault/fileOps.ts:76-78](../../src/main/vault/fileOps.ts).
- **Change:**
  ```ts
  export async function renameItem(oldAbs: string, newAbs: string): Promise<void> {
    if (process.platform === 'win32' && oldAbs.toLowerCase() === newAbs.toLowerCase() && oldAbs !== newAbs) {
      const tmp = `${oldAbs}.case-rename-${Date.now()}`;
      await fsPromises.rename(oldAbs, tmp);
      await fsPromises.rename(tmp, newAbs);
      return;
    }
    try {
      await fsPromises.rename(oldAbs, newAbs);
    } catch (err: any) {
      if (err?.code === 'EXDEV') {
        await fsPromises.copyFile(oldAbs, newAbs);
        await fsPromises.unlink(oldAbs);
        return;
      }
      throw err;
    }
  }
  ```

### Verification

- Unit:
  - `vaultFolderOps.rename` — a queued markdown writer is flushed before the IPC.
  - `flushAllMarkdownWriters` — returns failed paths.
  - `renameItem` — case-only rename on Windows succeeds via the temp-name path.
- Manual: rapid type → rename → assert no resurrection of the old file.

### Dependencies

Phase 1 (atomic writes), Phase 7 (so failures surface).

---

## Phase 9 — Tag system atomicity & frontmatter compat

**P1s addressed:** P1-5, P1-9, P1-11, P1-18

### Goal

Make tag-rename sweeps atomic (or at least retryable), surface frontmatter read failures, complete the folder-rename tag cascade, accept Obsidian-flavoured tag frontmatter.

### Tasks

#### 9.1 — Reorder tag-rename sweep (P1-5)

- **File:** [src/renderer/stores/fileTags.svelte.ts:329-388](../../src/renderer/stores/fileTags.svelte.ts) (`rewriteTagInAllMarkdown`).
- **Change:** Pre-flight all writes (open + close file handle to probe writability). Rewrite `.md` files first in a try/catch loop, accumulating failures. Only commit `.filo/tags.json` + tile-def rewrites when *all* `.md` writes succeed. On partial failure, surface a toast with retry that targets only the failed paths.

#### 9.2 — Frontmatter read-null surfacing (P1-9)

- **Files:** [src/renderer/stores/fileTags.svelte.ts:139-160, 290-317](../../src/renderer/stores/fileTags.svelte.ts) (`writeTagChangeToTileMarkdown` and sibling).
- **Change:** When `raw === null` but `vault:file-exists` is `true`, add the path to `failedVaultPaths` and `reportError('frontmatter-write', null, 'Could not read <rel> to update frontmatter')`.

#### 9.3 — Folder-rename tags cascade (P1-11)

- Folded into Phase 4.2 — confirm done.

#### 9.4 — Obsidian-flavoured `tags` coercion (P1-18)

- **File:** [src/renderer/schema/frontmatter.ts:15](../../src/renderer/schema/frontmatter.ts).
- **Change:** `tags: z.preprocess(coerceTags, z.array(z.string())).default([])` where `coerceTags(input)` accepts: `null` → `[]`, single string → split on `,`/`/` then trim and drop blanks, array → preserve, anything else → `[]`. Same shape for `aliases`.

### Verification

- Unit:
  - `coerceTags("foo, bar")` → `['foo', 'bar']`.
  - `rewriteTagInAllMarkdown` with one un-writable file → registry unchanged, retry toast surfaces.
- Manual: drop an Obsidian vault with comma-separated `tags:` into Filo → tags visible in the Tags Browser.

### Dependencies

Phases 1, 7.

---

## Phase 10 — Undo coverage extension

**P1s addressed:** P1-12, P1-13, P1-14, P1-15, P1-16, P1-17

### Goal

Fix the Kanban field-update undo races, make group / lock / waypoints / board-settings undoable, surface history truncation to the user, route cascade-delete through a Command.

### Tasks

#### 10.1 — `UpdateCardFieldCommand` flush + live source (P1-12, P1-13)

- **Files:** [src/renderer/commands/index.ts:1329-1363](../../src/renderer/commands/index.ts); [src/renderer/lib/kanban/kanbanFrontmatterWriter.ts:88](../../src/renderer/lib/kanban/kanbanFrontmatterWriter.ts).
- **Change:** Mirror `UpdateTaskFieldCommand`: `void flushAllPendingFrontmatterWrites()` at the top of `execute()` and `undo()`. Read `fmBefore` from `documentStore.getFrontmatter(docId)` first, falling back to `vaultIndexStore`.

#### 10.2 — New undoable commands (P1-14)

- **Add to** [src/renderer/commands/index.ts](../../src/renderer/commands/index.ts):
  - `ToggleGroupCommand(boardId, tileIds, action: 'group'|'ungroup', previousGroups)`.
  - `ToggleLockCommand(boardId, tileIds, previousLockStates)`.
  - `AddWaypointCommand` / `MoveWaypointCommand` / `RemoveWaypointCommand` / `RenameWaypointCommand` / `ToggleWaypointLockCommand`.
  - `UpdateBoardSettingsCommand(boardId, patch, inversePatch)`.
- **Wire call sites:**
  - `AppShell.svelte:260-334` group/lock/ungroup handlers — wrap in `historyStore.execute(new …)`.
  - `boardWaypointsGroups.ts` — replace direct mutations with command dispatch.
  - `board.svelte.ts:262-269` (`updateSettings`) — replace with `UpdateBoardSettingsCommand`.

#### 10.3 — History truncation toast (P1-15)

- **File:** [src/renderer/stores/history.svelte.ts:22, 76, 106, 119](../../src/renderer/stores/history.svelte.ts).
- **Change:** When the slice drops the head for the first time in a board's session, emit a one-shot info toast: "Undo history limit reached — earlier actions are no longer reversible." Gate by `boardId` so re-truncation in the same session doesn't re-toast.

#### 10.4 — Cascade-delete via Command (P1-16)

- **File:** [src/renderer/stores/boardFrontmatterSync.ts:126-137](../../src/renderer/stores/boardFrontmatterSync.ts).
- **Change:** Replace the direct `ctx.removeTile(tileId)` calls with a single `CascadeDeleteCommand(boardId, removedTiles)` per affected board. Note: this only restores the placement; the backing file is gone (handled by Phase 6's snapshot for in-app deletes).

#### 10.5 — `ProjectSettings` partial-fallback parse (P1-17)

- **File:** [src/renderer/stores/vault.svelte.ts:336-371](../../src/renderer/stores/vault.svelte.ts).
- **Change:** Replace `ProjectSettingsSchema.safeParse(raw)` with a per-field merge: parse each top-level slice with `.catch()` so failures fall back per field. Surface a toast naming which slice was reset.

### Verification

- Unit: each new command class has `execute` + `undo` symmetry tests.
- Manual: ungroup, undo → group is back. Lock a tile, undo → unlocked. Change board background, undo → previous background.

### Dependencies

Phase 7 for the truncation toast.

---

## Phase 11 — Remaining IPC safety

**P1s addressed:** P1-1, P1-8, P1-19, P1-20, P1-21, P1-22

### Tasks

#### 11.1 — Fake-rename detection (P1-1)

- Folded into Phase 4.4 (size heuristic). Confirm covers cross-directory case.

#### 11.2 — `dirtyFlagRecovery` non-ENOENT branch (P1-8)

- **File:** [src/renderer/lib/vault/dirtyFlagRecovery.ts:105-107](../../src/renderer/lib/vault/dirtyFlagRecovery.ts).
- **Change:** Split the outer catch. ENOENT → `{ needsRecovery: false }`. Anything else → `{ needsRecovery: true, reason: 'sentinel-unreadable', error }` and surface a toast.

#### 11.3 — Path depth + per-segment validation (P1-19)

- **File:** [src/main/ipc/vault.ipc.ts:215-234](../../src/main/ipc/vault.ipc.ts).
- **Change:** Reject `relativePath` if `split('/').length > 10` or any segment fails `assertSafeFilename`.

#### 11.4 — Per-channel Zod payload narrowing (P1-20)

- **File:** [src/main/preload.ts:13-35](../../src/main/preload.ts) — but the actual schemas live in `src/shared/ipcSchemas.ts` (new).
- **Pattern:**
  ```ts
  const PAYLOADS = {
    'vault:rename': z.tuple([z.string(), z.string()]),
    'vault:write-file-text': z.tuple([z.string(), z.string(), z.string()]),
    // ...
  } satisfies Record<IpcChannel, z.ZodTuple>;
  ```
- **Wrapper:** central `invoke` calls `safeParse`, rejects with `{ ok: false, code: 'BAD_PAYLOAD' }` before the channel sees the call. Bonus: enables typed `invoke<C>(channel, ...)`.

#### 11.5 — `shell:show-item-in-folder` containment (P1-21)

- **File:** [src/main/ipc/shell.ipc.ts:24-28](../../src/main/ipc/shell.ipc.ts).
- **Change:** `if (!getVaultRoot()) return false; assertWithinVault(getVaultRoot(), fullPath);`.

#### 11.6 — `vault:copy-file` source-side guard (P1-22)

- **File:** [src/main/ipc/vault.ipc.ts:291-314](../../src/main/ipc/vault.ipc.ts).
- **Change:** `stat(sourcePath)`; reject if size > configurable cap (default 100 MB). Optionally check `IpcMainInvokeEvent.senderFrame.url` so iframe tiles can't trigger.

### Verification

- Property tests for each channel rejecting malformed payloads.
- Manual: try to call `shell:show-item-in-folder` with `C:\Windows\System32` — returns `false`.

### Dependencies

Phase 3 introduces the helpers reused here.

---

## Phase 12 — Doc / shortcut polish + packaging

**P1s addressed:** P1-24, P1-25, P1-26

### Tasks

#### 12.1 — Wire Ctrl+K → editor:insert-link (P1-24)

- **File:** [src/renderer/components/layout/AppShell.svelte:228-335](../../src/renderer/components/layout/AppShell.svelte).
- **Change:** `registerCommandWithShortcut('editor:insert-link', 'Ctrl+K', () => editor.commands.setLink({}))`. Existing handler at `toolbarConfig.ts:210` is the target.

#### 12.2 — Ctrl+Arrow neighbour (P1-25)

- Decide: either implement in [src/renderer/lib/mindmap/mindMapKeyboard.ts:32-35](../../src/renderer/lib/mindmap/mindMapKeyboard.ts) (basic spatial neighbour lookup) OR remove from design doc.
- **Recommendation:** remove from doc; the feature isn't trivial and there are higher-value mind-map features ahead.

#### 12.3 — Packaging icon path (P1-26)

- **File:** [package.json](../../package.json).
- **Option A:** Add `sharp`, `png-to-ico`, `png2icons` as `devDependencies` and chain `npm run icons` into `package`. Output written to `resources/`. Add `resources/icon.{ico,icns,png}` to `.gitignore`.
- **Option B:** Run `npm run icons` once, commit the raster outputs (simpler CI, ~few MB).
- **Recommendation:** Option A. Cleaner repo, deterministic builds.

### Verification

- Manual: Ctrl+K in a text tile inserts a link prompt.
- CI: `npm run package` succeeds after a clean `npm install`.

---

## Phase 13 — P2 hygiene sweep

**Themes:**

### Dead code / dependencies

Remove four dead deps (`marked`, `turndown`, `@types/turndown`, `remark-stringify`, `@use-gesture/vanilla`) and dead handlers (`dialog:save-file`, `snippet:list`, `snippet:load`, `window:*`, `board:rename`). Empty `lib/commands/` scaffold can go. `core/app.ts` global is unused — either land it or delete.

### Docs drift

Update CLAUDE.md project-structure block (per the audit's enumerated items). Update the Design Doc's references to `localStorage`, Calendar board, "Help → About", `TemplatePicker.svelte`, `ConnectionLabelStyle.svelte`, etc.

### Lint / CI

Add `coverage/` to ESLint ignores. Disable the `SvelteSet` lint rule for `vault.svelte.ts:657` with a comment, or swap to `Array.includes`. Rename `KanbanColumn.svelte:78` `e` → `_e`.

### Test coverage

Raise coverage thresholds gradually as new tests land in Phases 1-12. Target 50% lines / 50% branches by end of Sprint C. Add E2E for the headline flow `create vault → board → tile → close → reopen → see tile`.

### Schema / persistence hygiene

- Add a `__corrupt` recovery flow alongside Phase 5.3.
- Document the `pendingPaths` Set ordering invariant in [writeStateTracking.ts:46-58](../../src/renderer/lib/boards/writeStateTracking.ts).
- Add `boardLoader.findBrokenRefs` removal (dead code).
- Snapshot mind-map viewport (P2 callout, folded into Phase 5.4).

### Undo hygiene

- Use `Command` for tile style edits (`UpdateTileStyleCommand` exists but isn't wired).
- Deep clone connection snapshot in `DeleteTilesCommand`.
- Clear per-board history when a tab is closed.

---

## Cross-cutting deliverables

These touch multiple phases and should be tracked separately:

### New helpers / modules

- `src/main/utils/activeVaultCheck.ts` (Phase 3).
- `src/main/ipc/vault.ipc.ts` — `vault:write-existing-file-text` channel (Phase 1).
- `src/renderer/schema/migrations.ts` (Phase 5).
- `src/shared/ipcSchemas.ts` (Phase 11).
- Recovery snapshot helper (Phase 5.2) — likely `src/main/services/recoverySnapshot.ts`.

### Test infrastructure

- Mock filesystem abstraction for IPC handler tests (consider `memfs`).
- Property-based payload tests (consider `fast-check`).
- E2E recipe for kill-mid-write scenarios.

### Memory entries to update on completion

After each phase merges, update the relevant memory entry:
- `phase7_ci_gates.md` — note any new gates added (e.g. payload-schema gate, recovery-snapshot gate).
- `save_system_audit.md` — supersede when atomic `.md` writes ship.
- `feedback_*.md` — add new patterns as feedback (e.g. `feedback_track_component_write.md`, `feedback_require_active_vault.md`).
- A new memory entry per sprint capturing what shipped (`p0_blockers_sprint_a.md`, `p1_followup_sprint_b.md`).

---

## Acceptance gates per sprint

### Sprint A (Phases 1-6, P0)

- Every P0 task above merged.
- `npm run ci:verify` green.
- New unit tests cover each P0 fix (target +30 tests).
- Manual smoke checklist (see below) passes 100%.
- A second-pass audit (single agent, focused on the P0 list) confirms zero regressions.

**Sprint A smoke checklist:**
1. Type in a text tile, kill app via Task Manager mid-keystroke → recovery modal lists the file with non-empty body on relaunch. No `.tmp` orphan.
2. Delete a file in OS Explorer while its Text Tile is dirty → persistent toast appears, file stays deleted, no resurrection.
3. Kill the app right after a save with `.filo/.dirty` populated → recovery modal appears. Close modal without acknowledging → relaunch → modal appears again.
4. Rename an attachment in OS Explorer (`img.png` → `photo.png`) → reopen → tile path updated, tag association preserved.
5. Rename `Foo.md` → `Bar.md` in OS Explorer → reopen → tile placements moved (best effort via heuristic).
6. Hand-edit `.filo/defaults.json` to introduce a syntax error → boot shows blocking modal, file untouched.
7. Delete a tile with "delete file" checked → Ctrl+Z → tile back, file body identical.
8. Attempt to pass a `..` traversal name to `theme:save` from devtools → rejected.

### Sprint B (Phases 7-12, P1)

- Every P1 task above merged.
- `console.error` grep below 40 in `src/`.
- E2E headline flow added and green.
- `npm run package` succeeds end-to-end.
- A second-pass audit confirms zero regressions across the P0+P1 fix set.

### Sprint C (Phase 13, P2)

- Dead deps removed; bundle-size delta documented in CHANGELOG.
- CLAUDE.md + Design Doc refreshed.
- Coverage thresholds raised.

---

## Risk register

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Phase 1's atomic-write change races with existing watcher suppression on slow disks | Low | Medium | Include the 2000 ms re-suppress (mirrors `board.ipc.ts`). Add a test that simulates 1500 ms write latency. |
| Phase 3's `assertActiveVault` breaks valid scenarios (multi-vault tabs) | Low | High | Audit `multiVault` design first. Currently Filo is single-vault, but check for any code that opens a second vault read-only. |
| Phase 4's size heuristic falsely pairs unrelated renames | Medium | Medium | Only pair when exactly one missing + one present match. Emit a low-severity warning. Defer to `chokidar` later. |
| Phase 5's envelope `version` breaks existing `.board.json` files | Low | High | Migration treats missing `version` as 7 (no structural change). Add round-trip test on the existing test corpus. |
| Phase 6's snapshot adds significant memory pressure on bulk delete | Low | Medium | Cap snapshot read at 25 MB per file; surface warning. |
| Phase 7's toast aggregation feels noisy | Medium | Low | Coalesce by `subsystem.action`; add an opt-in "verbose errors" setting. |
| Phase 10's new commands break the `historyStore` cap order | Low | Medium | Adding more commands per user action raises truncation rate. Phase 10.3's toast covers UX; verify ring-buffer not needed. |

---

## What this plan explicitly defers

- **Architectural store splits** (Phase 5.3-5.8 of the earlier refactor work). Per memory `phase5_refactor_progress.md`, this is P3 because `board.svelte.ts` and `boardCache.svelte.ts` are within CI budget. Revisit once Sprint B closes.
- **`@testing-library/svelte` dependency** for the Cheerful-Wolf items 2 + 9. P3.
- **Switch from raw `fs.watch` to `chokidar`** for native rename detection. Considered for Phase 4; deferred unless the size heuristic proves insufficient in production.
- **Command palette** (`getAllCommands` / `getCommand` / `isCommandEnabled` exist but unused). P3.
- **Custom window chrome** (`window:minimize`/`maximize`/etc. handlers exist but unwired). P3.
- **Performance work** (bundle size, MiniSearch latency, large-vault throughput). Not in the audit scope; revisit when reaching production-readiness.

---

## Appendix — File reference cheat sheet

For quick navigation during implementation:

**Atomic write helpers:** [src/main/vault/filenameUtils.ts:114](../../src/main/vault/filenameUtils.ts)
**Watcher suppression model:** [src/main/ipc/board.ipc.ts:96-106](../../src/main/ipc/board.ipc.ts)
**Path security:** [src/main/utils/pathSecurity.ts](../../src/main/utils/pathSecurity.ts)
**Filename validation:** [src/main/vault/filenameUtils.ts](../../src/main/vault/filenameUtils.ts) (`assertSafeFilename`)
**Active vault tracking:** [src/main/services/vaultManager.ts](../../src/main/services/vaultManager.ts)
**Private URL check:** [src/main/ipc/link.ipc.ts](../../src/main/ipc/link.ipc.ts) (`isPrivateUrl`)
**Error bus:** [src/renderer/lib/utils/errorBus.ts](../../src/renderer/lib/utils/errorBus.ts)
**Component write tracking:** [src/renderer/lib/boards/writeStateTracking.ts](../../src/renderer/lib/boards/writeStateTracking.ts) (`trackComponentWrite`)
**Markdown writer registry (for flushAll):** [src/renderer/lib/boards/markdownWriteRegistry.ts](../../src/renderer/lib/boards/markdownWriteRegistry.ts)
**History store:** [src/renderer/stores/history.svelte.ts](../../src/renderer/stores/history.svelte.ts)
**IPC channel registry:** [src/shared/types.ts](../../src/shared/types.ts) (`IpcChannel` union, enforced by `ci:ipc-parity`)

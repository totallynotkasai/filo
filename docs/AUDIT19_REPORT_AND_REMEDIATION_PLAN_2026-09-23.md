# Audit-19: Pre-Dogfood Audit and Remediation Plan (2026-09-23)

**Branch:** `chore/dependency-majors` @ `28d3063` (Electron 44, TS 6, Vite 7, vitest 5, Svelte ^5.57.1, Zod 4, TipTap 3)
**Scope:** All four board types (Mind Map, Kanban, Task List, Documents) on a **cloud-synced vault** (OneDrive/Dropbox), plus UI/UX, legacy and dead code, gaps, and CI health.
**Method:** 6 finders, each covering one area (upgrades, write paths, sync/lifecycle, board logic, robustness/IPC/security, UX/legacy/CI), then 2 adversarial verifiers that tried to refute every finding against the code. 8 agents in total. I checked the three most surprising headline findings (BL-1, ERR-1, ERR-2) against the source myself.
**Automated baseline:** `npm run check` 0 errors / 0 warnings; `npm run test:unit` 4914 passed / 1 skipped; all 48 `ci:*` gates pass; `tsc -p tsconfig.main.json` clean. **Everything is green, and the defects below are still present.** The suite tests the write *gateway* thoroughly but not what the *editors* feed into it or what *main* actually puts on disk (for example, stat results are stubbed).

**Result:** 58 raw findings. After verification: **1 CRITICAL, 10 HIGH, 20 MEDIUM, 22 LOW** and 5 duplicates merged. The verifiers refuted none of them outright, but they downgraded 13, and 10 remain PLAUSIBLE (not traced fully end to end).

---

## 1. Scores (1–10, harsh; 10 = production-grade, no known defects)

| Area | Score | One-line verdict |
|---|---|---|
| Frontmatter engine and write gateway (CST, delta-on-fresh-disk, drift gate) | **7** | Holds up well after 18 audits. Loss now comes from the layers around it, not from this core. |
| Markdown body integrity (Documents and Text tiles) | **3** | Undo can empty a note after load. The body is re-parsed as if it had frontmatter. Viewing a board rewrites files. Read-only mode silently drops typed text. |
| Board logic: Mind Map | **6** | Safe new-file creation. Convention-path rebinding still affects dropped files. |
| Board logic: Kanban and Task List | **4** | A new card or task can **silently overwrite an existing note** (CRITICAL). Bulk-delete undo scrambles order. |
| Cloud sync and external change handling | **4** | No conflict-copy awareness. Boards are evicted on external folder moves. Lock retry is about 310 ms. Destructive buttons carry harmless-sounding labels. |
| Error handling, recovery and IPC | **4** | Board files are JSON-encoded twice, which causes a **false "modified externally" prompt on every board after the first save**. Titles containing ".." are rejected. |
| Security | **6** | Strong IPC and vault gating. The open-file blocklist misses the `.js`, `.wsf` and `.cpl` script types. |
| Dependency-upgrade execution | **7** | The migration itself is careful (Zod 3-vs-4 differential over 4,433 mutations showed identical output; TipTap 3 `emitUpdate` and StarterKit changes handled). Only one real upgrade regression: Audio recording blocked by the new permission handler. |
| UI/UX | **5** | Several destructive flows promise undo they can't deliver. Decision toasts disappear after 15 s. A native `confirm()` is still used. |
| Code health (redundancy, legacy, dead code) | **6** | Little dead code. The real debt is duplicated path resolvers that disagree with each other (the source of 3 bugs). Docs drift from the code. |
| Tests and CI | **5** | Green, but the tests stub the wrong layer. CI is Linux-only while you run Windows. Main and test sources aren't type-checked in `ci:verify`. E2E is manual-only. |
| **Overall readiness to dogfood on a synced vault** | **4** | Don't put irreplaceable notes in yet. Phase 0 below is small (about 9 targeted fixes) and would lift this to about 7. |

**Why this differs from Codex's 8–9:** Codex (like the gates) scored the hardened gateway. Every serious finding here sits in a layer the gates don't look at: TipTap history, component mount and unmount, filename choice, main-side serialisation, and cloud-sync file semantics.

---

## 2. Findings

Severity shown is the verifier-corrected severity. ✅ = CONFIRMED (traced end to end); ◐ = PLAUSIBLE.

### CRITICAL

**BL-1 ✅ Creating a Kanban card or Task List task, or dropping a .md file onto them, silently overwrites an existing vault file.**
`src/renderer/lib/vault/conventionPaths.ts:40` `nextUniqueMdPath` only checks tile *titles on loaded boards*. It ignores the disk, the vault index and NTFS case-folding. Callers then write through the create-**or-overwrite** channel `vault:write-file-text`. The write is marked as Filo's own, so the watcher raises no drift prompt, and no snapshot is taken.
Callers: `kanbanTileCreation.ts:155,258`, `taskCreation.ts:166`, `tasklist/fileDropHandler.ts:152-159` (its docstring wrongly says "collision-checked").
Repro: quick-add the task "Groceries" when a sidebar note `Groceries.md` exists, and the note is replaced by `---\ncompleted: false\n---`. Or delete card "New Card" (its file is kept), add a new card, and the old notes are wiped. The Mind Map path (`seedTextFileForNewTile.ts:70`) checks `vault:file-exists` and is safe.

### HIGH

**MD-1 / DEP-1 ✅ Loading a file goes into ProseMirror's undo history.** `markdownSync.ts:201` calls `setContent(..., {emitUpdate})` without `addToHistory: false`, and StarterKit's UndoRedo is still on. After opening a note, Ctrl+Z empties it and autosave writes the empty body. On a synced vault, Ctrl+Z after an external reload brings back the pre-sync text and overwrites the other device's edit with no prompt. Reproduced in the real TipTap 3.31.3 editor. This is not new with TipTap 3, and no test covers it.

**MD-3 ✅ Body re-parsed as a whole file: an opening `---` rule and a later `---` rule are stripped as if they were frontmatter.** `TextTile.svelte:255,296,447` and `DocumentEditor.svelte:331,457` run `parseMarkdownFile()` on `DocumentState.body`, which is body-only by contract. Everything between the two rules is dropped, and the next write (see MD-2) saves the truncated body. The user never has to type anything for this to happen.

**MD-2 ✅ TextTile writes its file on every unmount, even when nothing changed.** `TextTile.svelte:469` has no dirty check, and the gateway has no identical-bytes skip. Panning (culling), zooming out (level-of-detail rendering) and switching boards therefore rewrite notes with TipTap-normalised syntax (`_x_`→`*x*`, Setext→ATX, `***`→`---`, mixed line endings). Each rewrite bumps the mtime, which churns cloud sync and invites conflict copies. It also amplifies MD-3.

**MD-5 ✅ Sibling-adopt loads an unhydrated placeholder (body `''`) into a writable editor.** `TextTile.svelte:251-285` has no `hasFrontmatter`/hydrated guard, unlike its sibling branches. Scenario: a Document tab fails to read an online-only or locked OneDrive file, while a tile for the same file mounts in another pane. The tile adopts the empty body, and typing or an unmount write wipes the note.

**UX-1 / MD-7 ✅ Lossy read-only mode silently discards typed text.** `isLossyMarkdownRoundTrip` flags very common Markdown: hard-wrapped paragraphs, GFM tables, bare URLs, tight task lists, multi-line blockquotes, `1. 1.` lists, `[[wiki]]` links. The note becomes "Saving is disabled", but the editor stays editable (`TextTile.svelte:529-541`, `DocumentEditor.svelte:~228/473`). Anything typed afterwards is lost on close, with no prompt. Notes you import from elsewhere will hit this often.

**DEP-2 ✅ `linkify: true` turns filenames and domains into links.** `createEditor.ts:254`: `Notes.md`, `main.rs` and `example.com` round-trip as `[Notes.md](http://Notes.md)`, which marks the note lossy and read-only. Typing a filename saves a bogus link. Any PKM note that mentions a filename is affected.

**ERR-1 ✅ Every `.board.json` is JSON-encoded twice. This regression came with Audit-17 5.4 and produces false "modified externally" prompts.** The renderer sends `JSON.stringify(fileData)` (`boardWriteScheduler.ts:392`, `boardCache.svelte.ts:660`), and main stringifies it again (`boardFileOps.ts:33,65`). Files on disk are therefore a JSON *string literal*. Because of that, the post-write size check (`boardWriteScheduler.ts:429`) never matches, the baseline never refreshes, and **every board's second save shows a "was modified externally — Reload (discard in-memory changes)?" prompt**. On cloud sync you'd naturally blame OneDrive and click Reload, which **discards your edits**. Two more side effects: plain-JSON boards (hand-edited, restored or tool-written) fail to load, and the file on disk is larger than the 50 MB cap assumes. The tests stub `vault:stat`, so none of them sees it.
*The fix must keep reading the existing double-encoded files.*

**ERR-2 ✅ Any path segment containing `..` is rejected.** `pathSecurity.ts:193` checks `fileName.includes('..')`, so a title ending in "." ("Call Bob." becomes `Call Bob..md`) or containing "..." can't be created, renamed, read or saved. The task you typed vanishes with an error toast. Imported files with such names appear in the sidebar but can never be opened.

**UX-3 ✅ Sidebar delete says it's undoable but permanently deletes files it never snapshotted.** `vaultFolderOps.ts:744`: only `.md` files and small media are snapshotted. `.board.json`, `.docx`, `.pdf`-type files, media over 25 MB and unreadable cloud placeholders are removed with `fs.rm`: no Recycle Bin, and no warning before you confirm.

### MEDIUM

| ID | ✓ | Issue | Location |
|---|---|---|---|
| ERR-3 (+GAP-1, EXT-7) | ✅ | A sync conflict copy (`Plan-DESKTOP-X.board.json`, `Plan (1)…`) sorts before the real file and wins the duplicate-id tie-break. The real board is left unloaded, the toast tells you to delete it, and new edits go into the conflict copy. | `boardFileOps.ts:88`, `boardLoader.ts:766` |
| EXT-2 | ◐ | A conflict copy created by rename is correlated as a *rename*, so every tile, editor and tag is rebound to the losing copy. No conflict-copy name detection exists anywhere. | `renameCorrelation.ts:394` |
| EXT-1 | ◐ | An external or sync-side folder rename evicts open boards and cancels their pending edits. There's no runtime board discovery, so the board stays gone until the vault is reopened. | `vault.svelte.ts:1610` |
| EXT-4 | ✅ | The "Mark broken refs" button actually **deletes placements on every board**. | `vaultExternalPrompts.ts:441` |
| EXT-3 | ◐ | "Keep local" on the external-delete prompt recreates the file without checking whether sync has already re-created it, which overwrites the other device's version. | `vaultExternalDriftPrompts.ts:254` |
| EXT-5 / ERR-9 | ◐ | The atomic-write lock retry lasts about 310 ms (`[10,20,40,80,160]`). Failed writes aren't re-fired ("Stay open and retry" does nothing), and each failure leaves a `.tmp` that gets synced. | `filenameUtils.ts:233` |
| ERR-4 | ✅ | `board:load` returns null for every error, so a transient lock or an offline placeholder reads as "not-found" and the board is dropped for the session, with no retry. | `board.ipc.ts:187` |
| ERR-7 | ✅ | Notes that aren't UTF-8 (e.g. Windows-1252) are decoded lossily, and any write (including a vault-wide tag rename) persists U+FFFD. | `fileOps.ts:701` |
| ERR-5 | ◐ | A partial folder delete (EBUSY mid-way) leaves the index and boards stale and throws away the undo snapshots. `fs.rm` isn't given retries. | `fileOps.ts:427` |
| ERR-6 | ✅ | The open-file blocklist misses `.js .jse .wsf .wsh .vbe .cpl .chm .mht .msp .psm1`. | `media.ipc.ts:406` |
| BL-2 | ✅ | Undoing a Task List bulk delete or "Delete completed" scrambles task order and moves tasks between sections. | `multiSelectController.svelte.ts:335` |
| BL-3 | ✅ | A `.md` dropped from a Kanban board's own convention folder gets no `filePath`, so card reads and writes resolve to the vault-root file. | `textTileDropPlan.ts:87` |
| BL-4 | ✅ | Convention-backed text tiles (no `filePath`) silently rebind to a different file when the vault pin or content folder changes. | `vaultRootFolder.ts:77` |
| MD-11 | ✅ | TextTile's inline path resolver ignores the board content folder, so it diverges from `resolveTextTileVaultPath`. | `TextTile.svelte:109` |
| MD-9 | ✅ | "Expand to Document" ignores `tile.filePath` and opens or edits the root `X.md`. TileHeader is missing from `ci:writer-path-honors-filepath`. | `TileHeader.svelte:497` |
| MD-4 | ✅ | DocumentEditor reloads its own content after every autosave. This wipes redo, breaks IME composition, and triggers MD-3 even in a single view. | `DocumentEditor.svelte:453` |
| MD-6 | ◐ | Two views of the same tile or document (split panes) share one `callerId`. Closing one pane can cancel the other's pending write and clear its dirty flag. | `DocumentEditor.svelte:311` |
| UX-2 (+DEP-4, MD-8) | ✅ | `filo://` internal links can't be inserted (`setLink` fails silently), and notes that contain one open read-only. | `createEditor.ts:213` |
| DEP-3 | ✅ | **Upgrade regression:** the deny-all permission handler blocks microphone access, so Audio-tile recording always fails. | `permissionPolicy.ts:25` |

### LOW

| ID | Issue | Location |
|---|---|---|
| BL-5 | Monthly and yearly recurrence drifts permanently (31st → 28th). | `recurrence.ts:146` |
| BL-6 | Deleting a Kanban column leaves orphan tileDefs in `.board.json` forever. | `boardCacheKanban.ts:112` |
| BL-7 | A sidebar rename of a filePath-backed card or task leaves its title stale, which feeds BL-1. | `fileRefIntegrity.ts:424` |
| BL-8 | Quick-add parses `3/4` as US month/day (you're in the UK). | `quickAddParser.ts:150` |
| BL-9 | Kanban "sort by due date" puts undated cards first. | `kanbanFiltersAndSort.svelte.ts:116` |
| MD-10 | A body edit on a CRLF note produces mixed line endings (CRLF frontmatter, LF body). | `markdownSync.ts:485` |
| UX-7 | Checklists are written as loose lists, which Obsidian and GitHub render with extra spacing. | task-lists fixture |
| EXT-6 / ERR-8 | Machine-local crash sentinels (`.filo/.dirty`, rename and tag-rewrite sentinels) sync between devices and trample each other. | `dirtyFlagRecovery.ts:212`, `configOps.ts:156` |
| EXT-8 | The tags.json reconciler drops a synced external update that lands inside the self-write window. | `vaultExternalReconcilers.ts:255` |
| UX-4 | Board delete is permanent: no snapshot, Recycle Bin or undo. | `boardCache.svelte.ts:743` |
| UX-5 | Vault-wide tag rename and delete use a native `window.confirm` and can't be undone. | `TagsBrowser.svelte:117,134` |
| UX-6 | External-edit decision toasts auto-dismiss after 15 s, and "Keep local" overwrites the other device's edit with no backup. The comments and design doc still say "persistent". | `ui.svelte.ts:412` |
| ERR-10 | `config:load` returns `{}` on a transient stat error, so a later hotkey edit wipes the other custom bindings. | `board.ipc.ts:299` |
| ERR-11 | Path depth is capped at 10. Names of about 239–255 characters can't be saved (the `.tmp` suffix pushes them over the limit). | `pathSecurity.ts:237` |
| ERR-12 | The quit-failure breadcrumb overwrites the previous unacknowledged one. There's no `render-process-gone` handler. | `quitFailureBreadcrumb.ts:62` |
| DEP-5 | The Svelte version was widened to `^5.57.1`, but the open-without-write guard is only a manual E2E. | `package.json:134` |
| DEP-6 | Zod 4 `.int()` rejects values above 2^53, so such a board fails to load (arguably correct; document it). | `placement.ts:98` |
| CI-1 | `ci:verify` doesn't type-check main or test sources, and CI is Linux-only. | `package.json`, `ci.yml` |
| CI-2 | stderr noise (duplicate keys, yaml warnings) hides real warnings, and the strict runner doesn't catch it. | `taskListModel.test.ts:51` |
| DEAD-1 | Dead code: `UpdatePlacementStyleCommand`, `defaultConnectionLabelFontSize`, `TAGS_FILE_RELATIVE_PATH`, an unused `noteBaseline` import, a duplicate `toVaultRelative`. | `taskCommands.ts:613` et al. |
| DOC-1 | CLAUDE.md says 13 allowlisted files (the script has 12) and lists `Dropdown.svelte`, which no longer exists. The design doc's text on toasts and the dirty flag is stale. | `CLAUDE.md` |

**Redundancy theme:** three text-tile path resolvers disagree with each other: `resolveTextTileVaultPath`, TextTile's inline fallback, and TileHeader's hard-coded `${title}.md`. Implicit convention-path resolution (tiles with no `filePath`) is the shared root cause of BL-3, BL-4, MD-9 and MD-11. Retiring it is the structural fix.

---

## 3. Phased Remediation Plan

Each phase leaves `ci:verify` green. Every fix gets a test that fails without it (a bite test).

### Phase 0: Blockers before any real data (must do)
1. **BL-1**: add a create-exclusive channel `vault:create-file-text` (`fs.open(..., 'wx')`, which returns a typed `EEXIST`). Route every seed write through it (Kanban, template card, task, Task List drop), bumping ` (n)` on EEXIST. Also fold vault-index paths into `nextUniqueMdPath` with case-folded comparison. Tests: one per creation site, each with a pre-existing file that is on no board, plus a case-only collision. New gate `ci:seed-writes-exclusive` forbids `vault:write-file-text` in the creation modules.
2. **ERR-1**: main writes a string payload verbatim (`typeof data === 'string' ? data : JSON.stringify(...)`). The loader accepts both a string (legacy double-encoded) and an object, so the first save migrates each file. Add an integration test that runs the real `saveBoardFile`, then the real stat, then the renderer size check, with no stubbed stat.
3. **MD-1**: dispatch every load and reload with `addToHistory: false`, and clear history after the first hydrate. Test: load, undo, then assert no `onUpdate` fired and the body is unchanged. Also cover reload followed by undo.
4. **MD-3**: never call `parseMarkdownFile` on `DocumentState.body` (5 sites). Add a corpus fixture whose body starts with a `---` rule and contains a second one.
5. **MD-2**: write on destroy only if `isWriterDirty(contentId, callerId)` is true or a write is pending or parked. Add a gateway skip when the assembled bytes equal the last-read or last-written bytes. Add a unit test that mounts and unmounts TextTile and asserts no `vault:write-*` call.
6. **UX-1 / MD-7**: make the lossy read-only mode really non-editable (`setEditorEditable(false)`), with a clear banner and a single **Take ownership** action.
7. **DEP-2**: set Markdown `linkify: false`, and allow Link autolink only for URLs with an explicit scheme. Add corpus fixtures for bare filenames, domains and emails.
8. **MD-5**: guard sibling-adopt the same way the other adopt branches are guarded. Otherwise do the tile's own disk read, holding the failed-read state.
9. **ERR-2**: reject only a segment equal to `..` or `.`. Make `fileNameSafe` strip trailing dots and spaces.

### Phase 1: Cloud-sync hardening (needed for your OneDrive/Dropbox setup)
1. Add a `lib/vault/conflictCopy.ts` detector (OneDrive `-HOSTNAME`, Dropbox `(… conflicted copy …)`, ` (n)`). Use it in (a) the board duplicate-id tie-break, which should prefer the canonical name and otherwise the newest mtime, with neutral toast wording (**ERR-3**); (b) rename correlation, which should refuse to correlate onto a conflict-copy name (**EXT-2**); (c) a "Sync conflict: A vs B" toast.
2. **EXT-1**: treat a missing `.board.json` as provisional. Defer eviction until a reconcile or correlation pass has run, prompt if there are pending writes, and discover boards at runtime from `board` create and tree events.
3. **EXT-5 / ERR-9**: a bounded EPERM/EBUSY backoff of about 5 s on win32, also applied to `renameItem`. Keep the last args of failed writes and re-fire them from `flushAll` and a real **Retry** action. Sweep orphan `*.<12hex>.tmp` files into `.filo/recovery/` on vault open.
4. **ERR-4**: `board:load` returns a typed envelope (`EBUSY`/`OFFLINE`/`TOO_LARGE`/`IO`), with the same transient retry as configs and a Retry option on the failed board.
5. **EXT-3**: re-probe at click time. If the file exists, send "Keep local" to the modified-file conflict flow.
6. **EXT-4**: relabel the button "Remove N tiles from boards…" behind a confirm. The default should do nothing and let the broken-ref badge show.
7. **UX-6**: before any "Keep local" overwrite, snapshot the external bytes to `.filo/recovery/`. Make decision toasts sticky.
8. **ERR-7**: decode with a fatal UTF-8 decoder. A file that isn't UTF-8 becomes read-only and is skipped by sweeps with a toast.
9. **EXT-6 / ERR-8**: sentinels keyed by machine (`.filo/.dirty.<machineId>`); only ever clear your own. **EXT-8**: tags.json divergence tie-break.

### Phase 2: Editor and path correctness
**MD-4** (set `lastLoadedBody` in `onUpdate` and add the IME guard), **MD-6** (per-instance `callerId`), **MD-9 / MD-11 / BL-3 / BL-4** (route every resolver through `resolveTextTileVaultPath`, stamp `filePath` on every drop, and back-fill `filePath` once on load to retire implicit convention paths; add TileHeader and TextTile to the gate), **UX-2** (allow the `filo:` protocol and toast when `setLink` fails), **MD-10** (re-apply CRLF to the body, or document it), **UX-7** (tight task lists).

### Phase 3: Board logic
**BL-2** (sort bulk-delete children by descending position, or use next-survivor anchors), **BL-5** (store the recurrence anchor day), **BL-6**, **BL-7**, **BL-8** (locale-aware d/m), **BL-9**.

### Phase 4: Destructive actions and security
**UX-3 / ERR-5 / UX-4** (use `shell.trashItem` for user deletes; list anything that can't be snapshotted before the confirm; give `fs.rm` retries; refresh the tree and push the undo for the part that was removed), **UX-5** (themed confirm plus a before-snapshot), **DEP-3** (allow audio-only `media` for the app's own origin), **ERR-6** (switch the blocklist to an allowlist), **ERR-10**, **ERR-11**, **ERR-12**.

### Phase 5: Tests, CI, docs and dead code
**CI-1** (add `tsc -p tsconfig.main.json` and a tests tsconfig to `ci:verify`, and a `windows-latest` job), **DEP-5** (pin Svelte exactly, or promote the open-without-write check to a jsdom unit test), **CI-2**, **DEAD-1**, **DOC-1**, **DEP-6** (a KNOWN_LIMITATIONS entry). Add an editor-level round-trip suite that drives the real TipTap editor through load → undo, reload → undo, and mount → unmount.

---

## 4. Safe-use guidance until Phase 0 lands
- Don't Ctrl+Z inside a note straight after opening it or after it reloads from sync.
- Don't create Kanban cards or tasks whose titles match an existing note, and don't reuse a deleted card's name.
- Avoid titles that end with "." or contain "...".
- If a board shows "modified externally" right after you've edited it, choose **Keep local**, not Reload (that's ERR-1).
- Keep OneDrive or Dropbox version history on, and take a manual copy of the vault before the first real session.

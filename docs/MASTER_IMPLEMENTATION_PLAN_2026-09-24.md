# Filo Master Implementation Plan (2026-09-24)

**Supersedes:**
- `docs/archive/AUDIT19_IMPLEMENTATION_PLAN_2026-09-23.md`. Phases 0–1 are done. Its Phases 2–5 are re-sequenced here.
- The draft `FILE_MODEL_REFACTOR_PLAN_2026-09-24.md`, which is folded in here and deleted.

**Findings source:** [AUDIT19_REPORT_AND_REMEDIATION_PLAN_2026-09-23.md](AUDIT19_REPORT_AND_REMEDIATION_PLAN_2026-09-23.md).

**Status:** not started. **Base:** `main`, once `chore/dependency-majors` is merged.

**Goal:** make the `.md` file the only copy of a note's title, tags and content. The board files keep only what is visual. There is one in-memory model per file and one writer per file. The audit fixes that still matter land along the way.

**Structure of this plan:**
- **Part A:** the rules for working through this plan.
- **Part B:** the final decisions.
- **Part C:** the target model.
- **Part D:** where each remaining Audit-19 item went.
- **Part E:** the phases.
- **Part F:** impact, gates, risks and timeline.

All paths are relative to `src/renderer/` unless marked `src/main/` or `src/shared/`. Line anchors come from the Audit-19 plan (verified 2026-09-23) and will drift. Re-grep them before editing. The archived Audit-19 plan keeps the full per-line specs of each carried-over item.

---

## Part A — Working rules (apply to every step)

1. **Write the failing test first.** Every step starts with a test that fails against today's code (the "bite" test). Then fix, run `npm run ci:verify` until it's green, then commit.
   - Node isn't on PATH, so put `C:\Program Files\nodejs` at the front of PATH for every npm/node/npx command.
   - Every new gate, or new part of a gate, has to be proven: put the violation into a temporary copy of the code and confirm the gate exits 1.
2. **Never raise a file-size ceiling.** Split the file instead. When a split brings a file under 1000 lines, take it off the allowlist.
3. **New IPC channel checklist:**
   - the `IpcChannel` union (with no `'` or `;` in its comments);
   - the Zod tuple in `ipcSchemas.ts`;
   - the contract in `ipcContracts.ts`;
   - the handler (`ci:ipc-parity`);
   - the envelope inventories (`check-ipc-envelope-usage.mjs` and `ipcEnvelopeAllChannels.test.ts`).
4. **Vault identity.** A renderer module that reads the live vault and then `await`s must call `captureVaultIdentity()` before, and `isStillSameVault()` after every await. It must also be listed in `ci:reconciler-vault-guard`.
5. **Comments explain *why*.** No audit IDs, phases or history in code. Those go in commit messages.
6. **Every phase ends with a working app.** Dogfood each phase on a scratch vault before starting the next.
7. **Don't add new sync guards for duplicated-copy bugs.** If one turns up before Phase 5 lands, fix it minimally and note which phase removes its cause.

---

## Part B — Decisions (final)

### B.1 File-model decisions (owner-confirmed 2026-09-24)

| # | Decision | Phase |
|---|---|---|
| **D1** | **A note's title lives in frontmatter as `title:`.** A note without a `title:` key shows its filename stem. New notes are always created with `title:`. Editing a title is a frontmatter edit, never a file rename. The vault index's title is frontmatter `title`, falling back to the filename stem. The first-heading fallback is removed. | 3 |
| **D2** | **Formatted titles are visual, so the board owns them.** `titleHtml` stays on the board's tile def. It is shown only while its plain text equals the note's current title. When the title is changed anywhere, `titleHtml` is ignored and dropped on the next board save. | 3 |
| **D3** | **Note tags always live in frontmatter.** Things that exist only on a board keep their tags in the board file: today those are the inline link, iframe and timer tiles. No tags are added to frames or connections; that's out of scope. | 3 |
| **D4** | **Board Ctrl+Z covers layout, plus frontmatter edits** (title, tags, task and card fields), undone by applying the *inverse change* to the file through the writer. It never restores a note body from a copy in memory. Text undo belongs to the editor. | 6 |
| **D5** | **"Delete tile and file" moves the file to `.filo/trash/<id>/…`.** Undo moves it back (a rename, never a rewrite). Items older than 30 days are purged. | 6 |
| **D6** | **Stop writing the frontmatter `id:` key.** Existing ones are left alone, because the CST engine preserves untouched keys. | 4 |
| **D7** | **When two editors show the same note, the one being typed in owns it.** The other views follow the shared model after about 150 ms of idle, and never push changes while they aren't focused. | 5 |
| **D8** | **Illegal filename characters:** blocked with an inline message in the sidebar rename UI. In automatic flows (creation, quick-add, drops, templates), they're replaced with `-` when the filename is derived from the title. Because of D1, titles themselves can contain any character. | 3 |
| **D9** | **No legacy support.** Filo hasn't shipped. Compatibility code for older *Filo data formats* is deleted, and old boards are refused rather than migrated. Tolerance for *notes written by other apps* (a missing `title:`, CRLF, BOM, odd YAML, non-UTF-8) stays, because that's user content, not a Filo format. | 3 |

### B.2 Gap-filling decisions (owner-confirmed 2026-09-24)

| # | Question | Decision | Why |
|---|---|---|---|
| **D1a** | When a title changes, does the file get renamed to match? | **No.** The filename is set from the title once, at creation. After that, titles and filenames are independent. The sidebar shows filenames. A context-menu action, **"Rename file to match title"**, is available when you want them aligned. | It follows from D1: a title edit touches one file's frontmatter, with no rename cascade and no board rewrites. It is also how Obsidian's frontmatter-title plugins behave. |
| **D3a** | Tags on images, video, audio and generic files, which have no frontmatter | Keep them in **`.filo/tags.json:fileTags[path]`**, their only copy. The board def no longer carries a `tags` copy. | It's the arrangement discussed on 2026-09-24. The tags follow the file across boards. The alternative is per-board tags on the placement, which would be simpler but wouldn't follow the file. |
| **D5a** | Sidebar file/folder deletes and board deletes | **Also go to `.filo/trash/`**, which replaces Audit-19's Recycle-Bin design (its D9). Emptying Filo's trash sends items to the OS Recycle Bin. If that fails, a confirm lists the files before anything is deleted permanently. | One delete mechanism for everything. Undo becomes a rename that works for every file type and size, with no snapshot caps and no "can't restore" lists. The `trashItem` probe only matters for purging. |

### B.3 Audit-19 decisions still in force

| Old # | Decision | Status |
|---|---|---|
| D1–D3, D5–D8 | Lossy notes, create-exclusive seeds, verbatim board payloads, per-machine sentinels, lock retry, Keep-local backup, conflict-copy detector | **Done** (Phases 0–1). D3's "loader accepts legacy double-encoded boards" half is **removed** under D9. D5's "legacy single sentinel migrated once" is **removed** under D9. |
| D4 | Retire convention paths through a back-fill | **Superseded.** With no legacy data there's nothing to back-fill. The schema requires `filePath` and the convention code is deleted (Phase 3). |
| D9 | User deletes go to the Recycle Bin | **Replaced by D5/D5a**, which only uses the Recycle Bin for purges. |
| D10 | Audio: audio-only `media` from the app's main frame. `shell.openPath` uses an allowlist. | **In force** (Phase 1). |
| D11 | DEP-5: keep `svelte ^5.57.1` and guard in jsdom | **In force** (Phase 2). |
| BL-5 / BL-8 | BL-5: an optional `recurrenceAnchor` frontmatter key, written only for days 29–31 (or Feb 29 yearly). BL-8: date order read from `app.getSystemLocale()`. | **Approved 2026-09-24.** BL-8 in Phase 1, BL-5 in Phase 7. |

---

## Part C — Target model

### C.1 The rules

1. **Board file = visuals only.**
   - It holds position, size, style, locked/faded/frameless, which column or section an item is in and its order there, connections, frames, waypoints, board settings and `titleHtml`.
   - It refers to a note by **`filePath`** (its vault path) and nothing else.
   - Inline tiles (link, iframe, timer) keep their own `title`/`tags`, because they have no file.
2. **The `.md` file holds the title (`title:`), the tags (`tags:`), every other field (completed, due date, priority, status, recurrence…) and the body.**
3. **`noteStore`:** one `NoteModel` per open note, keyed by `VaultPath`, shared by every view.
4. **`noteWriter`:** one queue per path. Each save reads the file fresh, applies the change, and writes. Nothing else writes `.md`.
5. **One disk-change handler** refreshes the one model. There is one prompt, and only when an unsaved body edit meets a body change on disk.

### C.2 Board file v8 — text tile def

```jsonc
"t_abc123": {
  "id": "t_abc123",
  "type": "text",
  "filePath": "Notes/Shopping.md",      // required
  "style": { … },
  "titleHtml": "<b>Shopping</b>",       // optional styling (D2)
  "createdAt": "…", "updatedAt": "…"
}
```

**Removed from text defs:** `title`, `tags`, `content`, `contentId`, the legacy `file`.

**Removed from media and file defs:** `tags` (now in `tags.json`), plus `fileName`/`fileExtension`, which can be derived from the path.

**Document board:** holds `filePath` instead of `contentId` + `content`.

**Loader:** accepts exactly `version: 8`. Anything else goes into `failedBoards` with the reason "made by an older Filo; not supported" and is never written.

### C.3 `NoteModel` and `noteStore` (`stores/notes.svelte.ts`)

```ts
interface NoteModel {
  path: VaultPath;                         // the only name a note has
  status: 'loading' | 'ready' | 'readOnly' | 'missing' | 'conflict';
  frontmatter: Record<string, unknown>;    // parsed with the `yaml` package
  body: string;                            // markdown without frontmatter
  base: DiskSnapshot;                      // what the local state is built on
  localBodyVersion: number;
  hasUnsavedBody: boolean;
  editorOwner: ViewId | null;              // D7
}
interface DiskSnapshot { rawText: string; hash: string; mtimeMs: number; size: number; hadBom: boolean; eol: '\n' | '\r\n'; }
// title(path) = frontmatter.title (non-empty string) ?? basename(path) without .md
```

**API:**
- `acquire(path, viewId)` / `release(path, viewId)` (reference-counted)
- `get(path)`, `meta(path)`, `title(path)`, `tags(path)`
- `setBody(path, md, viewId)`, `patchFrontmatter(path, delta, opts)`
- `renameFile(path, newStem)`, `trash(path)`, `onDiskChanged(path)`

`meta(path)` returns the loaded model if there is one. Otherwise it returns the **vault-index projection**, so a Kanban or Task List board with hundreds of cards never loads their bodies. The index is **read-only**: it is refreshed by `noteWriter` after each write and by the watcher, and while a note is loaded it is fed from the model. Nothing writes from it.

### C.4 `noteWriter` (`lib/notes/noteWriter.ts`)

```ts
type NoteMutation =
  | { kind: 'body'; markdown: string; basedOn: string }
  | { kind: 'frontmatter'; delta: FrontmatterDelta }
  | { kind: 'raw'; text: string; basedOn: string }                                  // Raw view
  | { kind: 'create'; frontmatter: Record<string, unknown>; body: string }          // exclusive, title: included
  | { kind: 'renameFile'; to: VaultPath }
  | { kind: 'trash' };
```

Within the 300 ms debounce, the latest `body` wins and frontmatter deltas merge.

**Each flush, inside the path's queue:**
1. **Fresh read:** read the file and parse it (BOM, EOL, UTF-8, frontmatter source, body).
2. **Body drift check** (only when the batch includes `body` or `raw`): if the body on disk no longer matches `base`, set `status = 'conflict'` and hand off to C.5. A change on disk that only touched frontmatter is **not** a conflict.
3. **Apply:** patch the fresh frontmatter source with `patchFrontmatterSourceCst`. Replace the body if the batch has one; otherwise keep the body from disk.
4. **Assemble** with the fresh BOM and EOL. Skip the write if the bytes are identical.
5. **Write:** `vault:write-existing-file-text` (atomic), or `vault:create-file-text` (exclusive) for `create`.
6. **After the write:** set `base` to the new snapshot, record its hash in `recentSelfWrites`, update the model and refresh the index projection.

`renameFile` and `trash` hold the path's queue while they run: drain, IPC, re-key the model and the board path fields, release.

### C.5 Disk-change handler

| Situation | Action |
|---|---|
| Hash is in `recentSelfWrites` | Ignore it: it's our own write coming back. |
| Note isn't loaded | Refresh the index projection. |
| Loaded, no unsaved body | Replace the model; the views follow. |
| Unsaved body, disk body unchanged | Take the disk frontmatter and keep the local body. No prompt. |
| Unsaved body, disk body changed | One prompt: **Reload**, or **Keep mine** (the external version is backed up to `.filo/recovery/` first, which is Audit-19 D7). |
| File gone | `status = 'missing'`; the broken-ref overlay shows; rename correlation may re-key the note. |
| Partial or torn read | Retry with backoff (`externalChangeWindows.ts` stays). |

### C.6 What stays as it is

The CST frontmatter engine, `frontmatterDelta.ts`, BOM/EOL/UTF-8 handling, `atomicWriteFile`, exclusive create, the file watcher, `renameCorrelation`, the conflict-copy detector, per-machine sentinels, recovery snapshots, `withDrainedWrites`, the vault-swap guards, the canvas, board layouts, styles and themes.

---

## Part D — Where every remaining Audit-19 item went

| Audit-19 | Finding | Disposition | Lands in |
|---|---|---|---|
| 2.1 | MD-9/MD-11/BL-3/BL-4 convention paths | **Absorbed.** `filePath` is required by the schema, the convention machinery is deleted, and there's no back-fill (D9). | Phase 3 |
| 2.2 | BL-7 sidebar rename leaves the title stale | **Obsolete.** Under D1 the title isn't the filename, so renaming a file correctly leaves the title alone. | — |
| 2.3 | MD-6 split panes share a callerId | **Absorbed** by the per-mount `viewId` (C.3). | Phase 5 |
| 2.4 | MD-10 CRLF body goes mixed-EOL | **Kept.** The fix moves into `noteFile.ts` in Phase 5. | Phase 1 |
| 3.1 | BL-2 bulk-delete undo order | **Kept** (a layout undo). | Phase 1 |
| 3.2 | BL-9 due-date sort | **Kept.** | Phase 1 |
| 3.3 | BL-6 column delete leaves tileDefs | **Kept, reduced.** The one-time orphan clean-up is dropped (D9). | Phase 1 |
| 3.4 | BL-8 `d/m` date order | **Kept**. | Phase 1 |
| 3.5 | BL-5 recurrence drift | **Kept.** It runs after the refactor so it only touches the one field list. | Phase 7 |
| 4.1 | DEP-3 audio permission | **Kept.** | Phase 1 |
| 4.2 | ERR-6 `openPath` allowlist | **Kept.** | Phase 1 |
| 4.3 | UX-3 + ERR-5 sidebar delete and undo | **Reshaped** into `.filo/trash` (D5a). The snapshot caps and second-confirm lists go away. | Phase 6 |
| 4.4 | UX-4 board delete is permanent | **Reshaped** into `.filo/trash` (D5a). | Phase 6 |
| 4.5 | ERR-10 `config:load` returns `{}` | **Kept.** | Phase 1 |
| 4.6 | ERR-12 breadcrumb merge and renderer crash | **Kept.** | Phase 1 |
| 4.7 | ERR-11 path depth and `.tmp` length | **Kept.** | Phase 1 |
| 4.8 | UX-5 tag rename/delete confirm and undo | **Split.** 5a (themed confirm) is kept in Phase 1. 5b (undo) is rebuilt on inverse deltas in Phase 7. | 1 + 7 |
| 5.1 | CI-2 stderr noise | **Kept.** | Phase 1 |
| 5.2 | CI-1 type-check main and tests, Windows CI | **Kept.** | Phase 1 |
| 5.3 | DEP-5 phantom-write guard in jsdom | **Kept**, as part of the characterisation suite. | Phase 2 |
| 5.4 | DEAD-1 dead code | **Reduced.** The `normalizeTags` alias and `__baselineCountForTests` disappear with their modules. | Phase 7 |
| 5.5 | DEP-6 Zod safe-integer | **Kept.** | Phase 1 |
| 5.6 | DOC-1 docs drift | **Kept, and widened** to the new architecture. | Phase 7 |

---

## Part E — Phases

| Phase | Name | Effort | Done when |
|---|---|---|---|
| 1 | Independent fixes | 5–7 days | Every Phase 1 item is merged with its bite test, and CI covers main, the tests and Windows. |
| 2 | Refactor preparation | 1–2 days | The characterisation suite is green on today's code. The open decisions are confirmed. |
| 3 | Boards stop copying notes; title and tags from the note; legacy removed | 5–7 days | No board file holds a note's title, tags or body. The loader accepts only v8. |
| 4 | The path is the only identity | 1–2 weeks | `contentId` is gone from `src/`. |
| 5 | One model, one writer | ~2 weeks | Only `noteWriter` writes `.md`. One note in three views means one model. |
| 6 | Undo split and trash | 5–7 days | Every delete goes to `.filo/trash`, and undo is a rename. Board undo is layout plus inverse deltas. |
| 7 | New features, remaining items, clean-up, docs | 5–7 days | Tag row, raw view, tag undo, BL-5 recurrence, dead code removed, docs match the code. |

Phase 1 can run alongside Phase 2. Phases 3 → 6 are sequential, and Phase 7 comes last. **4.1 and 4.2 are one-file security fixes, so do them first.**

---

### Phase 1 — Independent fixes (none of these depend on the file model)

The full per-line specs are in the archived Audit-19 plan, in the section with the same number.

**1.1 DEP-3 — Audio recording is blocked** *(Audit-19 4.1, S)*
- **Fix:** add a pure `decidePermission(input, ctx)` to `src/main/utils/permissionPolicy.ts`. It allows only this combination:
  - `permission === 'media'`,
  - `isMainFrame`,
  - the request comes from the app's own webContents id,
  - `requestingUrl` starts with the app URL prefix (the dev origin, or the prod `file://…/index.html` href),
  - the media types are exactly audio.

  Wire it into both the request handler and the check handler. Set `appWebContentsId` in `createWindow`.
- **Tests:** `permissionPolicy.test.ts` covers the allowed case, and denies an iframe, audio+video, video, a foreign webContents, an `https://evil` main frame, and every non-media permission. **Bite:** reduce the check to `permission==='media'`.
- **Accept:** recording works in dev and in the packaged build. Iframe permissions are still denied.

**1.2 ERR-6 — `shell.openPath` blocklist → allowlist** *(Audit-19 4.2, S)*
- **Fix:**
  - Add a single `OPEN_PATH_ALLOWED_EXTENSIONS` plus `isOpenPathAllowed()` in `src/shared/untrusted.ts`. Allowed: documents, images, audio and video. Excluded: macro Office files, archives and disk images, and anything HTML-renderable.
  - Delete both blocklists. `media.ipc.ts` returns `EXTENSION_NOT_ALLOWED`.
  - `FileTile` shows a "Show in folder" toast instead.
- **Tests:** replace the parity block in `sharedUntrusted.test.ts`. Cover the script types (`js jse wsf …`), a source scan confirming `media.ipc.ts` uses the shared list, and the FileTile toast. **Bite:** re-add `.js`.

**1.3 MD-10 — CRLF body** *(Audit-19 2.4, S)*
- **Fix:** in `assembleMarkdownFile`, when `options.eol === '\r\n'` is passed in explicitly, normalise the body to CRLF once. The same applies on the no-frontmatter return.
- **Gate:** extend `ci:eol-preservation`.
- **Tests:** add a block "CRLF body" to `assembleMarkdownEngine.test.ts` covering: no bare `\n`, the dirty-frontmatter branch, no frontmatter, no `eol` means the body is untouched, and no `\r\r\n`.
- **Carry over:** Phase 5's `noteFile.ts` keeps this behaviour.

**1.4 BL-2 — Task List bulk-delete undo scrambles order** *(Audit-19 3.1, S)*
- **Fix:** `orderForBatchDelete(boardId, ids)` sorts the ids by **descending** position. Use it in `multiSelectController.bulkDelete`, `deleteAllCompleted` and the subtask cascade. Add a docstring on `DeleteTaskCommand` stating the ordering invariant.
- **Tests:** `taskBulkDeleteUndoOrder.test.ts` (A,B,C | D,E): each case deep-equals the original after undo, and redo matches. **Bite:** remove the sort.

**1.5 BL-9 — Kanban due-date sort puts undated cards first** *(Audit-19 3.2, S)*
- **Fix:** undated cards sort last, ISO dates compare lexically, and the sort stays stable. Unknown priorities also sort last.
- **Tests:** in `kanbanFiltersAndSort.test.ts`.

**1.6 BL-6 — Deleting a column leaves its cards' defs in the board file** *(Audit-19 3.3, S, reduced)*
- **Fix:**
  - `removeKanbanColumnWithDefs` drops the defs of cards that aren't placed in any other column.
  - `insertKanbanColumnAt(…, defs?)` re-merges them on undo.
  - `DeleteColumnCommand` snapshots the removed defs on its first execute. `kanbanCommands.ts` is at its ceiling, so trim its docstring to make room.
  - **Dropped (D9):** the one-time load-time orphan prune.
- **Tests:** in `kanbanColumnDelta.test.ts`: delete, then undo, with a sibling-edit case.

**1.7 BL-8 — Quick-add reads `d/m` as US month/day** *(Audit-19 3.4, S/M, approved)*
- **Fix:**
  - `parseQuickAdd(input, { dayFirst })`, with a pure `localeIsDayFirst(locale)`.
  - Main passes `--filo-system-locale=${app.getSystemLocale()}` through `additionalArguments`. The preload exposes it as `window.filo.systemLocale`.
  - The hint text follows the order.
- **Tests:** `quickAddParser.test.ts` and `dateOrder.test.ts` (en-GB, en-US, de-DE).
- **Accept:** check once in the packaged app that it reads `en-GB`.

**1.8 ERR-10 — `config:load` returns `{}` on non-ENOENT errors** *(Audit-19 4.5, S)*
- **Fix:**
  - The handler returns `{ __loadFailed: true, error }` instead.
  - `hotkeys.ts` retries with the `[150,400,900]` ms backoff. If it still fails, it marks `hotkeys.json` corrupt and keeps the overrides in memory.
  - `configWriteScheduler` treats `__loadFailed` as unverified, not as a foreign edit.
- **Tests:** in `audit19Phase4.test.ts`.

**1.9 ERR-12 — Quit breadcrumb overwrites an earlier one; renderer crash leaves a blank window** *(Audit-19 4.6, M)*
- **Fix:**
  - Merge the breadcrumb with any earlier unacknowledged one: take the union by `preservedPath` and drop entries whose file is gone.
  - Add `rendererCrashHandler.ts`. On `render-process-gone` (not a clean exit), write the breadcrumb and offer Reload or Quit. `unresponsive` is logged only.
  - `decideWindowClose({ rendererAlive })` skips the drain when the renderer is dead.
- **Tests:** the existing breadcrumb test, `windowCloseDecision.test.ts`, and a new `rendererCrashHandler.test.ts`.

**1.10 ERR-11 — Path depth cap and `.tmp` name length** *(Audit-19 4.7, S)*
- **Fix:**
  - `MAX_VAULT_PATH_DEPTH = 64`, plus a total length limit of 4096.
  - `tmpSiblingPath()` truncates the base name so the temporary file's name is ≤ 255. It is safe for surrogate pairs and used at all three tmp sites.
- **Tests:** `pathSecurity.test.ts`, `filenameUtils.test.ts`, a real 250-character write, and a source scan for stray tmp name templates.

**1.11 UX-5a — Tag rename/delete uses native `confirm()`** *(Audit-19 4.8 part 5a, S)*
- **Fix:**
  - Add `confirmAsync()` in `ui.svelte.ts`, and reuse it in `vaultFolderOps`.
  - Delete: a danger confirm showing how many notes and tiles it touches.
  - Merging a rename into an existing tag: a confirm warning that it can't be undone.
  - A childless rename needs no confirm.
- **Tests:** spy on `window.confirm` and assert it is never called. Cancel means no sweep. After this, `src/renderer` has **zero** `confirm(` calls.
- The undo half (5b) is Phase 7.

**1.12 CI-2 — Unit-test stderr noise** *(Audit-19 5.1, S)*
- **Fix:**
  - Remove the duplicate keys in 4 test files.
  - Pass `{ logLevel: 'error' }` at every production `parseDocument` site.
  - Widen `NOISE_PATTERNS` in `test-unit-strict.mjs` (duplicate keys, the yaml collection-key warning, effect-depth and state-mutation warnings) and scan both stdout and stderr.
- **Gate:** the widened strict runner. **Bite:** re-add a duplicate key.

**1.13 CI-1 — Main and tests aren't type-checked; CI is Linux-only** *(Audit-19 5.2, M)*
- **Fix:**
  - Add `typecheck:main` to `ci:verify`.
  - Add `tsconfig.tests.json` and a `ci:test-typecheck` ratchet, seeded from today's per-file baseline (373 errors in 131 files).
  - Add a `verify-windows` job: strict unit tests plus `typecheck:main`.
  - Keep the coverage floor at 70 ("ratchet up only").
- **Bite:** introduce a type error in a clean test file, and separately in a main IPC file.
- **Note:** the ratchet shrinks naturally in Phases 3–5 as whole test files are deleted.

**1.14 DEP-6 — Zod rejects integers above 2^53** *(Audit-19 5.5, S)*
- **Fix:** accept the stricter behaviour and document it in KNOWN_LIMITATIONS.
- **Tests:** `zodSafeIntegerBoundary.test.ts`, including a board-loader case where `1e20` goes to `failedBoards` with a snapshot.

**Phase 1 exit:**
- Every item above is merged with its bite test.
- `ci:verify` includes the main and test type-checks.
- The Windows CI job is green.

---

### Phase 2 — Refactor preparation

**2.1 Merge the branch and settle the base.** Merge `chore/dependency-majors` to `main`. Start each later phase on its own branch off `main`.

**2.2 Characterisation suite.** These tests pin behaviour the user can see, independent of how it's implemented. **They aren't edited in Phases 3–6**, except for the assertions listed under "expected changes" below.
- **Editing and views:**
  - Edit a note in a tile and in a Document tab; split panes show the same note.
  - Kanban card and Task List row show the title, tags, due date and priority.
- **Metadata edits land in the file:**
  - Tick a task → `completed: true` is in the file.
  - Tag a card → the tag is in the frontmatter and shows on a second board.
- **Renames, disk changes and deletes:**
  - Sidebar rename of a note → the tiles follow.
  - External edit while the note is clean, while it is dirty, and a frontmatter-only change.
  - Delete a tile and its file, then undo.
  - Vault-wide tag rename.
- **Bytes on disk:**
  - Open and pan a board → 0 bytes written.
  - Opening and closing a note never writes.
- **DEP-5 (Audit-19 5.3):** `documentEditorOpen.test.ts` and `textTileLifecycle.test.ts` (a) are part of this suite.
  - They must fail against the pre-`90e4092` `setEditable` code. If jsdom can't reproduce that failure, pin `svelte` exactly and record why.
  - Extend `ci:markdown-body-roundtrip` with their tokens.
- **Expected changes:**
  - Phase 3: title edit → frontmatter `title:`, not a file rename.
  - Phase 6: delete → `.filo/trash`.

  Update those assertions in the phase that changes them, and nowhere else.

**2.3 Decisions.** All decisions (D1–D9, D1a, D3a, D5a, BL-5, BL-8) were confirmed on 2026-09-24. Nothing is waiting on the owner.

**2.4 Scratch vault.** Create a fresh test vault for Phases 3–7: a few boards of every type, notes with and without `title:`, CRLF and BOM notes, media with tags, and a Document board. Under D9, the existing Book Vault's *notes* stay fine, but its *boards* will be refused from Phase 3 on and must be rebuilt.

---

### Phase 3 — Boards stop copying notes; title and tags from the note; legacy removed

**3.1 Board format v8 (pure)**
- **Schema (`schema/tile.ts`, `board.ts`, `boardFile.ts`):**
  - Text defs require `filePath` and drop `title`, `tags`, `content`, `contentId` and `file`.
  - Media and file defs drop `tags`, `fileName` and `fileExtension`.
  - Inline tiles keep `title` and `tags`.
  - The Document board swaps `contentId`/`content` for `filePath`.
  - Remove `.passthrough()` from the note-backed variants, so dropped keys can't survive a load and save.
- **Versioning:**
  - `CURRENT_BOARD_FILE_VERSION = 8` (the constant and the literal).
  - `schema/migrations.ts`: delete the board migration chain. The loader accepts only v8.
  - Keep `loadVersionedFile` as the future-proof scaffold, with no steps.
- **Writing:** `tileDefBuilder.buildTileDefinition` and every creation site always stamp `filePath`, never the removed fields. Delete the strip-on-write step in `boardWriteScheduler.ts:251-269`.

**3.2 Legacy removal (D9)**

Go through the 47 files that mention "legacy" (132 hits). For each hit:
- **Delete** it if it tolerates an older *Filo data format*.
- **Keep** it if it tolerates *user notes from other tools*.

Known deletions:
- The loader's acceptance of double-encoded boards (Audit-19 ERR-1 D3).
- The legacy single-`.filo/.dirty` sentinel migration (`machineSentinels.ts`, D5).
- The board migration steps 6→7.
- The text-def `file` field.
- Every convention-path resolver and branch:
  - `textTilePath.ts` falls back to `${title}.md`;
  - `getConventionFolder*` and `joinConventionPath` are used only for new-file placement;
  - the convention branches in `fileRefIntegrity` (`propagateMarkdownRenameToTextTiles`, `findTilesToCascadeDelete`, `detectBrokenRefs`);
  - the duplicate resolvers in `KanbanCard.svelte:147`, `TextTile.svelte:106`, `TaskItem.svelte:171`, `TileHeader.svelte:497`, `tileCommands.ts:28`, `runSearch.ts:118`, `TagsPopupMenu.svelte:24`, `frontmatterSync.tileBacksMarkdownPath`;
  - `kanbanFolderFreeze.ts`, if its only purpose is legacy convention freezing (verify).
- Old-version migration steps in the `tags.json`, template and config loaders. Keep their envelopes and current version numbers.

Delete the tests that only exercise legacy formats. Record each removal in the commit message.

**3.3 Titles (D1, D1a, D2, D8)**
- **Reading:**
  - Add a `noteTitle(path)` selector: frontmatter `title` if it's a non-empty string, otherwise the filename stem.
  - Until Phase 5 it reads `documentStore` (for open notes) or the vault index.
  - `vaultIndex.ts:308-312`: title = frontmatter `title`, else the stem. The first-heading fallback is removed.
- **Views:** `TileHeader`, `TileContainer`, `KanbanCard`, `TaskItem`, the Document header, search results and `OrphanCatcher` all use `noteTitle(path)`. `titleHtml` is shown only while `stripHtml(titleHtml) === noteTitle(path)`.
- **Editing a title** is a frontmatter delta `{ set: { title } }` through the existing delta write path (`frontmatterWriteScheduler`, until Phase 5).
  - Delete `renameTextTileBackingFile` (`boardTiles.ts:135`) and `replaceTitleInVaultPath`, and the rename branch of `TaskListBoard.renameTask`.
  - Replace `RenameTitleCommand` with `UpdateTitleCommand`. It records the old and new title as a frontmatter delta, and its execute→undo round-trip test covers the delta (`ci:command-roundtrip-coverage`).
- **Creating a note** (`seedTextFileForNewTile`, `kanbanTileCreation`, `taskCreation`, `fileDropHandler`, templates, quick-add):
  - The frontmatter includes `title: <exact title>`.
  - The filename is `fileNameSafe(title)`, with illegal characters replaced by `-`, reserved names and trailing dots or spaces handled, and ` (n)` added on collision.
  - Merge the duplicate collision helpers into `conventionPaths.ts`.
  - OS drops of an existing `.md` don't write `title:`; they show the filename stem until the title is edited.
- **Sidebar file rename:**
  - Illegal characters are blocked with an inline message (D8); the main process still validates too.
  - Renaming a file never changes a title.
  - Add a context-menu action **"Rename file to match title"** (D1a).
- **Delete** `fileRefIntegrity`'s title rewriting and the `SYNCED_FIELDS` title copy.

**3.4 Tags (D3, D3a)**
- **Note tags:** the tile tag commands (`tileTagCommands.ts`) become a single frontmatter delta for `.md` files. For media files they become a single `tags.json:fileTags[path]` change. Inline tiles edit their own board `tags`.
- **`fileTags.svelte.ts` and `fileTagsCascade.svelte.ts`:**
  - Delete: `propagateTileTagChangeToSiblings`, the tile-def and sibling cascades, and `fileTags` entries for `.md` paths.
  - Make `pruneFileTagsAgainstKnownPaths` drop any `.md` key.
  - Split the file below its 1252-line ceiling and lower the ceiling to match.
- **`renameTagEverywhere` / `removeTagEverywhere`:** the frontmatter sweep stays (`tagRewriteSweep` + `tagRewriter`). The commit step now only touches the registry, media `fileTags`, inline tiles and board-settings chips.
- **Views:** tag chips and filters read `tags(path)`. This also fixes Task List rows filtering on frontmatter tags while showing `tile.tags` chips.

**3.5 Delete the frontmatter → board sync**
- Delete `lib/vault/frontmatterSync.ts` (288 lines).
- Delete the reconcile half of `stores/boardCacheFrontmatter.ts` (per-file :90, the on-open batch :129). Keep the cascade-delete target helpers.
- In `vaultExternalChanges.ts`: remove `applyFrontmatterToBackedTiles`, `fileTagsStore.setFileTags` for `.md`, and `dropStaleSeededFrontmatterCache`.
- Task fields are read only from `meta(path)`. `TASK_METADATA_FIELDS` stripping becomes unnecessary, because the schema no longer carries those fields.

**3.6 Gates**
- **Add:** `board-schema-no-note-copies` — text and file tile schemas mustn't declare `title|tags|content|contentId|file`, and inline schemas may.
- **Add:** `no-legacy-board-migration` — `migrations.ts` has no board steps, and the loader has no double-decode branch.
- **Retire:**
  - `writer-path-honors-filepath` and `creation-persists-filepath`, because the schema now requires `filePath`;
  - the part of `sentinel-machine-scoped` that covers the legacy single sentinel.
- Prove each new gate bites (Part A.1).

**3.7 Tests**
- Schema: a v7 file goes to `failedBoards` and is never written.
- A v8 round trip is byte-stable.
- Titles:
  - A title edit changes only the `title:` line (CRLF and BOM preserved) and never renames the file.
  - A sidebar rename leaves the title alone, and the tiles follow the path.
  - A note without `title:` shows its stem.
  - A new note created from the title `What? / Why` gets the filename `What- - Why.md` and `title: "What? / Why"`.
  - `titleHtml` is hidden after an external title change.
- Tags:
  - A tag on a card appears only in the frontmatter, and shows on a second board.
  - A media tag appears only in `tags.json`.
- The characterisation suite still passes, apart from the listed title-rename change.

**Exit:** `grep` finds no `title`/`tags`/`content`/`contentId` on any note-backed def in the scratch vault's board files. `frontmatterSync.ts` is gone. The UI looks the same.

---

### Phase 4 — The path is the only identity

1. **Re-key `documentStore` by `VaultPath`** instead of docId. This is an interim step; Phase 5 replaces the store.
   - `findByFilename` becomes a map lookup.
   - `propagateRename` becomes a re-key.
2. **Replace `contentId` with `filePath` everywhere.** Current counts:
   - lib: tasklist 35, canvas 28, kanban 20, templates 19, vault 9, boards 6, editor 4;
   - components: 82; stores: 27; commands, core and schema: 19.
3. **Delete the sibling docId adoption** in `TextTile.svelte` (:245-281).
4. **D6:** stop writing frontmatter `id:` (`markdownSync.ts:480`, `kanbanTileCreation.ts:252`). `markdownTileSeed.ts:29` no longer reads it.
5. **Templates:** capture and instantiate notes by relative path.
6. **Tests:** update about 92 unit files and 311 references. Mostly mechanical: fixtures change from `contentId: 'x'` to `filePath: 'x.md'`. Work one directory at a time, keeping CI green after each.
7. **Gate:** add `no-content-id`, which bans the identifiers `contentId` and `docId` in `src/`.

**Exit:** `grep -r contentId src/` is empty. A rename re-keys one map entry plus the path fields on the boards.

---

### Phase 5 — One model, one writer (highest risk)

**Order of work: build, cover with tests, move callers family by family, then delete the old code.**

1. **Build the new modules:**
   - `lib/notes/noteFile.ts`: pure parse and assemble over `markdownSync` and the CST engine. It carries over the MD-10 CRLF rule from Phase 1.
   - `lib/notes/noteWriter.ts` (C.4).
   - `stores/notes.svelte.ts` (C.3), with `title(path)` built on D1.
   - Give them full unit coverage before any caller moves:
     - queue ordering per path;
     - a body plus a delta coalescing into one write;
     - a body change on disk → conflict;
     - a frontmatter-only change on disk → no conflict;
     - the self-write hash echo;
     - `renameFile` holding the queue;
     - a vault swap mid-flush;
     - read-only for lossy and non-UTF-8 notes;
     - create-exclusive with EEXIST → ` (n)`.
2. **Editors:** move `TextTile`, `DocumentEditor` and `PropertiesPopup` to `acquire` / `setBody` / `patchFrontmatter`.
   - `viewId` is per pane and per mount, which **absorbs MD-6**.
   - Add the D7 owner rule.
   - Serialisation is idle-debounced at about 150 ms.
   - Delete the force-writer registry. Keep-mine now lives in the single conflict handler.
3. **Field editors:** move `taskCommands`, `kanbanCommands`, `kanbanFrontmatterWriter`, `tasklist/frontmatterWriter`, `UpdateTitleCommand` and the tag commands to `patchFrontmatter`. Delete `frontmatterWriteScheduler.ts`. `frontmatterRebase.ts` feeds Phase 6.
4. **Remaining writers:** `propertiesCommands`, `replaceAllCommand`, `tagRewriteSweep`, the orphan patches, `boardCache.syncTileMarkdown`, the creation flows and the undo restores each become a `NoteMutation`. This closes the unchained writes listed in the Audit-19 map.
5. **External changes:** `vaultExternalChanges.ts` passes events to `noteStore.onDiskChanged` (C.5). Merge `vaultExternalDriftPrompts.ts` into the single prompt. `conflictResolver.ts` shrinks to the C.5 table.
6. **Delete:**
   - `document.svelte.ts` (887 lines);
   - `markdownFileWriter.ts` (1132);
   - `markdownPostWrite.ts`;
   - `syncOpenEditorsAfterDiskMutation.ts`;
   - the `.md` parts of `writeStateTracking.ts` and `fileBaselineRegistry.ts`, which become `NoteModel.base`.
7. **Main process, optional:** match `.md` self-writes by content hash instead of a time window. The watcher already hashes `.md` files. That would close KNOWN_LIMITATIONS #5.
8. **Gates:**
   - **Add:**
     - `single-note-writer`: only `noteWriter.ts` may invoke the `.md` write or create IPC.
     - `views-read-note-store`: nothing imports `documentStore`, and components don't parse `.md`.
     - `note-queue-per-path`: `.md` rename and trash only through `noteWriter`.
   - **Retire:** `markdown-gateway`, `md-writers-reconcile-editors`, `reload-cancels-writes`, and the callerId/flush checks that are specific to the gateway.
   - **Fold in:** `frontmatter-delta-write` becomes part of `single-note-writer`.
   - **Keep:** `keep-local-backup`, `markdownFormat`, `vaultIdentity` and `ipcSecurity`.
9. **Tests:**
   - The characterisation suite.
   - Split pane: type in A, B follows; then type in B.
   - An OneDrive-style external edit while typing, with a body change and with a frontmatter-only change.
   - Quit while dirty: the flush completes within the 5 s ceiling.
   - 1,000 rapid toggles on one note: one write per debounce window, and the final bytes are correct.

**Exit:** exactly one module writes `.md`. One note open in three views means one model. KNOWN_LIMITATIONS #9 (two separate reads) is closed.

---

### Phase 6 — Undo split and trash (absorbs Audit-19 4.3 and 4.4)

**6.1 `.filo/trash` (D5, D5a)**
- **Main:** new module `src/main/vault/trashOps.ts` and handler `src/main/ipc/vaultTrash.ipc.ts`.
  - `vault:trash-move(vaultRoot, rel)` → `{ trashId }`:
    - It renames the item to `.filo/trash/<trashId>/<rel>` and writes `manifest.json`: `{ originalPath, deletedAt, machineId, kind }`.
    - It's the same volume, so the rename is atomic. A locked child makes the whole rename fail **cleanly, with nothing moved**. This resolves ERR-5 (partial delete) by construction.
    - It keeps the `suppressTree` / `suppress` bracket.
  - `vault:trash-restore(vaultRoot, trashId)`: renames the item back. If the original path is now taken, it restores alongside as `… (restored).md` and reports that.
  - `vault:trash-purge(vaultRoot, trashIds | 'olderThan30d')`: `shell.trashItem` into the OS Recycle Bin. If that fails, it returns `TRASH_FAILED` with the file list and deletes nothing.
  - Follow the full IPC checklist (Part A.3). Renderer access goes only through `vaultOperations.ts` (`trashVaultPath`, `restoreTrashed`, `purgeTrash`), which extends `no-raw-disk-shape-ipc`.
- **Renderer callers:**
  - Sidebar file/folder delete (`performDelete`, split out to `stores/vaultDeleteOps.ts`, which takes `vaultFolderOps.ts` off the allowlist).
  - Board delete (`boardCacheDelete.ts` slice, which splits `boardCache.svelte.ts`).
  - "Delete tile and file".
  - Task delete with its file.
  - The cascade.
- **Confirms:** honest wording, for example: `"X" will be moved to Filo's trash. Undo or restore it from Settings → Trash.` Never "permanent".
- **Purge:**
  - On vault open, items older than 30 days are purged. This only runs on the machine that trashed them, going by `machineId` in the manifest.
  - Settings → Trash lists items with Restore and Empty.
  - If `TRASH_FAILED`, a confirm lists every file and asks "Delete permanently?".
  - **Probe first (the Audit-19 4.3 Step 0):** on the packaged build, check `trashItem` on the OneDrive vault (including an online-only placeholder), on a mapped share, and on a FAT32 USB stick. Record the results in KNOWN_LIMITATIONS.
- **Delete:**
  - `deleteTileSnapshots.ts` and its 5 MB / 25 MB caps;
  - snapshot capture in `vaultFolderOps` (`captureCascadeFileSnapshots`, `readSnapshotForRel`, the media snapshot readers);
  - `absToVaultRelative` (DEAD-1);
  - the body-restore code in `CascadeDeleteCommand`, `DeleteTaskCommand` and `tileCommands.executeFileDeletes`;
  - the zero-tile early return in `boardFrontmatterSync.ts:61-63`. Undo no longer depends on a snapshot, so a sidebar delete of a note on no board can be restored from Settings → Trash.
- **Gate:** add `deletes-go-to-trash` (replacing Audit-19's planned `user-delete-recycle`). It requires:
  - user-facing delete paths call `trashVaultPath(`;
  - `vault:delete` is referenced only from the purge fallback and `.filo/` sentinel clean-ups;
  - the purge handler never calls `fs.rm` or `unlink` on its own.

  Confirm-body literals mustn't say "permanent" except in the fallback dialog.
- **Tests:**
  - Main: move, then restore, round-trips the bytes. A locked child means nothing moves. Restoring onto an existing path goes alongside. `.filo/` paths are refused. Purge falls back to `TRASH_FAILED` with the list.
  - Renderer: sidebar delete then undo restores the file and every tile, for a `.docx`, a 40 MB video, a folder and a board. A vault swap before undo means no restore.

**6.2 Board undo = layout plus inverse deltas (D4)**
- Commands that change a note (`UpdateTitleCommand`, the tag commands, the task and card field commands, `UpdatePropertiesCommand`) record an inverse `FrontmatterDelta`. Undo sends it through `patchFrontmatter`, so it's safe against edits made in between, by construction. `frontmatterRebase.ts` is replaced by this.
- `renameFile` undo is a reverse `renameFile` through the queue.
- Delete undo is `restoreTrashed`.
- Text undo stays in TipTap. Board Ctrl+Z only fires when no editor is focused.
- **Gate:** `commands` group. Every command keeps its execute→undo round-trip test. Add a gate check that no command stores a note `body` string in its snapshot.

**Phase 6 exit:**
- Every user-facing delete is recoverable, for every file type and size.
- No command keeps a copy of a note body.
- `vaultFolderOps.ts` and `boardCache.svelte.ts` are off the allowlist or have lowered ceilings.

---

### Phase 7 — New features, remaining items, clean-up and docs

1. **Tag row.** A comma-separated tag row at the top of the note, in `DocumentEditor` and the expanded `TextTile`. It reads `tags(path)` and writes through `patchFrontmatter`, with autocomplete from the registry.
2. **View Raw Markdown.** A toggle that shows the file's full text, frontmatter included, in a plain-text editor. Saving sends a `{ kind: 'raw' }` mutation, with the same drift check. It is read-only for lossy and non-UTF-8 notes.
3. **UX-5b tag undo** *(Audit-19 4.8 part 5b, rebuilt)*
   - New `stores/tagUndo.svelte.ts` with `removeTagWithUndo` and `renameTagWithUndo`.
   - A removal records which notes were written, plus the registry definition, media `fileTags`, inline-tile tags with their positions, and board-settings chips. It pushes an Undo toast (15 s).
   - Undo re-adds the tag with a frontmatter add-delta to exactly those notes, and restores the rest.
   - Undoing a rename is the reverse rename. A merge offers no undo.
   - Add it to `ci:reconciler-vault-guard` Part 1.
   - Tests from Audit-19 4.8, plus: undo after a note was edited in between keeps that edit.
4. **BL-5 recurrence anchor** *(Audit-19 3.5; approved)*
   - `nextDueDate(…, anchor?)` steps in multiples from a base date instead of chaining one step after another.
   - An optional `recurrenceAnchor` frontmatter key is written only for day ≥ 29 (or Feb 29 yearly), and cleared when the recurrence changes.
   - After the refactor this touches only the task-field reader lists and `completionPatchForRow`. There's no board field list or sync list to update.
   - Tests: the Audit-19 table (Jan 31 → Feb 28 → Mar 31 → Apr 30, leap years, overdue catch-up, re-anchoring after a manual move).
5. **DEAD-1** *(Audit-19 5.4, reduced)*
   - Delete `UpdatePlacementStyleCommand` and its describe block, the four unused `default*FontSize` helpers, `TAGS_FILE_RELATIVE_PATH` and `__resetCloseDrainGateForTests`.
   - Move `toVaultRelative` to `lib/utils/path.ts`.
   - Remove the unused imports.
   - Change `lint` to `--max-warnings 0`, or a ratchet.
   - Anything already gone with its module is skipped (`normalizeTags`, `__baselineCountForTests`, `absToVaultRelative`).
6. **Clean-up:**
   - `fileRefIntegrity.ts` down to path-only work (about 500 lines).
   - `vaultFolderOps` rename flow: no tags or titles steps.
   - `renameCascadeSentinel` down to path rewrites only.
   - Re-check every file on the size allowlist and lower each ceiling to its new size.
7. **Docs (DOC-1, widened)** — last, once every count has settled.
   - **CLAUDE.md:**
     - project tree: add `notes.svelte.ts`, `noteWriter.ts`, `noteFile.ts`, `vaultDeleteOps.ts`, `boardCacheDelete.ts`, `trashOps.ts`, `vaultTrash.ipc.ts`, `rendererCrashHandler.ts`, `permissionPolicy.ts`, `tagUndo.svelte.ts`; remove the deleted modules and the four stale entries Audit-19 found;
     - Source of Truth (boards no longer cache frontmatter);
     - Vault API contract (`noteWriter`, trash);
     - frontmatter gotchas;
     - the gate table and count;
     - the gotcha to `window.filo.invoke(...)`.
   - **Design doc:** titles (D1/D1a), tags (D3/D3a), deletion and trash, the raw view and the tag row, the toast cap, the dirty-flag location.
   - **KNOWN_LIMITATIONS:**
     - close #9, and #5 if the hash change lands;
     - update #2 (attachment tags) and #16 (`documentStore` maps);
     - add: `.filo/trash` syncs through OneDrive, the Recycle Bin probe results, the path depth and length limits, the Zod safe-integer limit, tag merge can't be undone, v8 boards only.
   - Archive this plan to `docs/archive/`.

---

## Part F — Impact, gates, risks, timeline

### F.1 Code removed or shrunk (estimate)

| Area | Today (lines) | After |
|---|---|---|
| `frontmatterSync.ts` | 288 | 0 |
| `boardCacheFrontmatter.ts` | 455 | ~150 |
| `fileTags.svelte.ts` + `fileTagsCascade.svelte.ts` | 1,483 | ~600 |
| `fileRefIntegrity.ts` (convention and title branches) | 804 | ~500 |
| `document.svelte.ts` | 887 | 0 (`notes.svelte.ts` ~350) |
| `markdownFileWriter.ts` + `markdownPostWrite.ts` | 1,252 | 0 (`noteWriter` + `noteFile` ~500) |
| `frontmatterWriteScheduler.ts` + `frontmatterRebase.ts` | 745 | 0 |
| `syncOpenEditorsAfterDiskMutation.ts` | 187 | 0 |
| External-change store + two prompt modules | 2,054 | ~900 |
| `vaultFolderOps.ts` (rename/delete + snapshots) | 949 | ~450 (+ `vaultDeleteOps` ~250) |
| Rename sentinel + repair | 433 | ~250 |
| Delete snapshots (`deleteTileSnapshots`, body restores in 3 commands) | ~400 | 0 |
| Title-as-filename rename path (`renameTextTileBackingFile`, `replaceTitleInVaultPath`, collision copies) | ~250 | ~60 |
| Legacy format code (D9) and `contentId` plumbing | ~800 | 0 |

**Net:** about **6,000–7,500 fewer lines** in `src/renderer`, plus the tests that only exercised the removed machinery.

### F.2 Gate changes

| Group | Add | Retire or fold in |
|---|---|---|
| `writePath` | `single-note-writer`, `note-queue-per-path`, `deletes-go-to-trash` | `markdown-gateway`, `md-writers-reconcile-editors`, `reload-cancels-writes`, `writer-path-honors-filepath`, `creation-persists-filepath`, `frontmatter-delta-write` (folded), gateway callerId/flush checks |
| `markdownFormat` | `eol-preservation` CRLF-body arm; `markdown-body-roundtrip` DEP-5 arm | — |
| `vaultIdentity` | — | the legacy-sentinel part of `sentinel-machine-scoped` |
| `commands` | "no body in command snapshots" | — |
| `components` | `views-read-note-store` | — |
| `codebase` | `board-schema-no-note-copies`, `no-content-id`, `no-legacy-board-migration`, `test-typecheck` (ratchet) | — |
| (CI chain) | `typecheck:main`, the widened strict runner, lint `--max-warnings` | — |

Every addition has to be proven to bite (Part A.1). Recount the gates in Phase 7.

### F.3 Risks

| Risk | Phase | Mitigation |
|---|---|---|
| Titles no longer follow filenames, so a sidebar name and a card title differ | 3 | This is intended under D1/D1a. "Rename file to match title" exists. The sidebar could also show the title as a tooltip. |
| Notes from other tools have no `title:` | 3 | They fall back to the filename stem, and `title:` is added on the first title edit. Nothing is written on open. |
| Old Book Vault boards are refused | 3 | Accepted under D9. Notes are unaffected. Rebuild the boards in the scratch vault. |
| Two editors fight over one note | 5 | The D7 owner rule, a per-mount `viewId`, and split-pane tests. |
| A bug in `noteWriter` affects every write | 5 | Build and test it fully before any caller moves. Move callers family by family with CI green. The old path stays until the last caller has moved. |
| Serialisation cost while typing | 5 | Idle-debounce at about 150 ms. Profile a 50 KB note. |
| Large Kanban and Task List boards | 5 | Metadata views use `meta(path)` (the index projection) and never `acquire`. |
| `.filo/trash` grows and syncs | 6 | The 30-day purge to the Recycle Bin, a visible Trash list, and a KNOWN_LIMITATIONS entry. |
| `trashItem` deletes permanently on some volumes | 6 | Probe before merge. If needed, pre-check the drive type and route to the permanent-delete confirm. |
| Test churn hides a regression | 3–6 | The characterisation suite (Phase 2) is the fixed reference. Only the listed assertions may change. |

### F.4 Refuted or narrowed during Audit-19 (don't chase)

- ERR-3's "conflict copy always wins" trigger isn't reachable through the documented sync-client naming. The real issue, an invisible fork, was fixed in Audit-19 1.7.
- UX-6's 15 s cap for promise-backed toasts is deliberate.
- ERR-8's "init overwrites settings" can't happen (seeding runs only when the file is missing).
- EXT-1's descendant-expansion sub-fix isn't needed.
- EXT-5's "Stay open does nothing" is only half right; the missing retry was fixed in 1.4.
- MD-11's Mind Map repro doesn't hold. Under this plan the whole question goes away, because every def has a `filePath`.

### F.5 Timeline

| Phase | Effort | Cumulative |
|---|---|---|
| 1. Independent fixes | 5–7 days | ~1.5 weeks |
| 2. Preparation | 1–2 days | ~1.5 weeks (can overlap with Phase 1) |
| 3. Board v8, title and tags from the note, legacy removed | 5–7 days | ~3 weeks |
| 4. Path identity | 1–2 weeks | ~4.5 weeks |
| 5. One model, one writer | ~2 weeks | ~6.5 weeks |
| 6. Undo split and trash | 5–7 days | ~7.5 weeks |
| 7. Features, remaining items, docs | 5–7 days | **~8.5–9 weeks** |

You can stop after any phase and still have a working app. After Phase 3, the most confusing duplicates (titles, tags and convention paths) are gone.

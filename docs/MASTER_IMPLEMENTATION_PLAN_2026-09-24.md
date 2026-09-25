# Filo Master Implementation Plan (2026-09-24)

**Supersedes:**
- `docs/archive/AUDIT19_IMPLEMENTATION_PLAN_2026-09-23.md`. Phases 0–1 are done. Its Phases 2–5 are re-sequenced here.
- The draft `FILE_MODEL_REFACTOR_PLAN_2026-09-24.md`, which is folded in here and deleted.

**Findings source:** [AUDIT19_REPORT_AND_REMEDIATION_PLAN_2026-09-23.md](AUDIT19_REPORT_AND_REMEDIATION_PLAN_2026-09-23.md).

**Status:** Phase 1 done on 2026-09-24 (commits `512adfa`..`65683eb` on `chore/dependency-majors`; see "Phase 1 — status and deviations"). Phase 2 done on 2026-09-24 (commits `f6d01ae`..`02c14f7` on `master-plan/phase-2`, branched from `main` after the merge; see "Phase 2 — status and deviations"). Phase 3 done on 2026-09-24 (branch `master-plan/phase-3`; see "Phase 3 — status and deviations"). Phase 4 done on 2026-09-25 (branch `master-plan/phase-4`, on top of Phase 3; see "Phase 4 — status and deviations"). Phase 5 done on 2026-09-25 (branch `master-plan/phase-5`, branched from `main` at `7205e55`; see "Phase 5 — status and deviations"). Phase 6 done on 2026-09-25 (same branch, on top of Phase 5; see "Phase 6 — status and deviations"). Phase 7 not started. **Base:** `main`; nothing is pushed yet.

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

#### Phase 1 — status and deviations (2026-09-24)

**Done.** Each item is one commit with its bite test, on `chore/dependency-majors` (not pushed):

| Item | Commit | Item | Commit |
|---|---|---|---|
| 1.1 DEP-3 | `512adfa` | 1.8 ERR-10 | `efa992c` |
| 1.2 ERR-6 | `5491ab6` | 1.9 ERR-12 | `8d427ce` |
| 1.3 MD-10 | `a48992a` | 1.10 ERR-11 | `eb70be1` |
| 1.4 BL-2 | `5a6fc48` | 1.11 UX-5a | `5612962` |
| 1.5 BL-9 | `3785629` | 1.12 CI-2 | `46b19a0` |
| 1.6 BL-6 | `e8b3c4d` | 1.13 CI-1 | `f9d4237` |
| 1.7 BL-8 | `a9b2c57` | 1.14 DEP-6 | `65683eb` |

`ci:verify` is green after the last commit. It now runs `typecheck:main`, and the gates include `test-typecheck` (54 gates).

**Deviations from the plan:**
- **Baseline commit.** The working tree held a large uncommitted change set (the comment clean-up, the `scripts/gates/` consolidation, and plans moved to `docs/`). With the owner's OK it was committed first as `22c1a08`, so each Phase 1 commit holds only its own item.
- **Extra commit `7274208`: file-size ceilings tightened.** The comment clean-up had already brought `kanbanCommands.ts`, `vaultFolderOps.ts` and `boardCache.svelte.ts` under 1000 lines. Per Part A.2 they left the allowlist, and the other eight ceilings were lowered to their current size. So 1.6 needed no docstring trim in `kanbanCommands.ts` (991 lines).
- **Commit rhythm (A.1).** Each item ran its own tests, bite, lint and the relevant type-check or gates before its commit. The full `ci:verify` ran at checkpoints (after 1.2, after 1.10, and at the end), not before every single commit. All were green.
- **Test file names.** New tests have descriptive names instead of the planned `audit19Phase4*.test.ts`: `openVaultFile`, `configLoadFailure`, `tagEditConfirm`, `rendererCrashHandler`, `tmpSiblingPath`, `yamlCollectionKeyQuiet`, `permissionPolicy`, `taskBulkDeleteUndoOrder`, `kanbanFiltersAndSort`, `dateOrder` and `zodSafeIntegerBoundary`.
- **1.1.** The old deny-all test block in `audit15Phase1.test.ts` was replaced by `permissionPolicy.test.ts`.
- **1.2.**
  - The FileTile open logic moved to `lib/utils/openVaultFile.ts`, so it is unit-testable without mounting the component.
  - Files with no extension and dotfiles (`README`, `.gitignore`) are now refused too, because they aren't on the allowlist. They get the "Show in folder" toast.
- **1.3.** Two older A8-M1 test rows pinned the mixed-EOL output (a CRLF frontmatter block over an LF body). They now expect all-CRLF.
- **1.6.** The one-time load-time orphan prune is not added (D9, as planned).
- **1.7.**
  - The argv parsing lives in `src/shared/systemLocale.ts` and validates the locale tag.
  - `window.filo.systemLocale` is a required field on `FiloAPI`. The renderer still falls back to `navigator.language` when it is empty.
- **1.8.**
  - The hotkeys loader also treats a `__corrupt` file like `__loadFailed`: it keeps the in-memory overrides and blocks hotkey writes, where before it silently installed empty overrides.
  - A vault swap during the retries drops the result.
- **1.9.** The existence check on preserved files applies only to entries carried over from an earlier breadcrumb. This session's partials are always written.
  - A renderer crash *during* a quit drain closes the window without the Reload/Quit dialog, because nothing is left to drain.
  - `rendererAlive: false` wins over an in-flight drain in `decideWindowClose`.
- **1.10.**
  - `tmpSiblingPath` also keeps the tmp name within 255 UTF-8 *bytes*, for ext4 and APFS, not only 255 UTF-16 units.
  - `machineIdentity.ts` keeps its inline tmp name. It writes a fixed, short `userData` file and can't import `filenameUtils` because that would be an import cycle. The source-scan test exempts it.
  - Added as KNOWN_LIMITATIONS #22.
- **1.11.**
  - The delete confirm says "This can't be undone" rather than the Audit-19 copy "You can undo from the notification that follows". Undo (5b) only arrives in Phase 7, so Phase 7 must update this text.
  - Besides `vaultFolderOps`, `confirmAsync` also replaced the identical wrapper in `VaultFileItem.svelte`, `keepLocalBackup.ts` and `vaultExternalDriftPrompts.ts`. `confirmDiscardSettings.ts` keeps its own wrapper, because its tests inject a `ui` double.
  - The logic lives in `lib/tags/tagEditConfirm.ts`.
- **1.12.**
  - `logLevel: 'error'` was also added to the three *test* helpers that parse the hostile YAML corpus directly.
  - The strict runner already scanned stdout and stderr; only its patterns were widened.
- **1.13.**
  - `test-typecheck` is a gate in the `codebase` group, with its baseline in `scripts/gates/testTypecheckBaseline.json`, not a standalone `check-*.mjs` (CLAUDE.md rule). `npm run ci:test-typecheck` runs just that gate.
  - `tsconfig.tests.json` also includes `src/tests/component`.
  - Before seeding the baseline, the catch-all `installFiloMock` handler type in `src/tests/helpers/filoBridge.ts` was fixed. That one type caused most of the TS2769 errors. The seeded baseline is **191 errors in 79 files**, against the 381 in 138 measured today (the plan's 373/131 predates later tests).
- **1.14.** No code change was needed. The recovery snapshot of a refused board already happens in `vaultCandidate` (`schema-invalid` is in the snapshot kinds); the test pins it. Added as KNOWN_LIMITATIONS #23.

**Still open (needs the owner or a push):**
- **The Windows CI job has not run yet.** The branch isn't pushed. Locally on Windows 11, `test:unit:strict` and `typecheck:main` pass.
- **Manual checks on the packaged build:**
  - Audio tile recording works, and an Iframe tile to a mic-test page is denied (1.1).
  - `window.filo.systemLocale` reads `en-GB`, and "Dentist 3/4" lands on 3 April (1.7).
  - A killed renderer (Task Manager → end the GPU/renderer process) shows the Reload/Quit dialog (1.9).

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

#### Phase 2 — status and deviations (2026-09-24)

**Done.** `ci:verify` is green after the last commit: lint, check, typecheck:main, 535 test files (5,369 passed, 1 skipped) under `test:unit:strict` with clean output, build, and 55/55 gates.

| Item | Commit(s) |
|---|---|
| 2.1 Merge | `main` fast-forwarded to `57fbbab`, plus the no-op merge `84d7c76` (see below). Phase 2 is on `master-plan/phase-2`. |
| 2.2 Suite | `a555c46` (suite, harness, gate), `02c14f7` (title-edit spec) |
| 2.2 DEP-5 | `d58169d` |
| 2.2 Bugs the suite found | `f6d01ae`, `a275b3d`, `cdfa2fa`, `d0282b9` |
| 2.3 Decisions | Nothing to do. |
| 2.4 Scratch vault | `d44c0a5`. The vault is at `C:\Users\andre\My Files\Filo Scratch Vault`. |

**Deviations from the plan:**

- **2.1 merge.**
  - `origin/main` held GitHub's merge commit for PR #1 (`b6715b5`). Its tree is identical to `28d3063`, which is already on the branch.
  - After the fast-forward, `main` merged `origin/main` (`84d7c76`, no file changes), so a later push is a fast-forward.
  - Nothing is pushed. `main` is 41 commits ahead of `origin/main`, and `master-plan/phase-2` is 8 more on top.
  - The Windows CI job from Phase 1 still hasn't run.
  - The owner merges `master-plan/phase-2` into `main` and pushes.

- **2.2 How the suite is built.**
  - It is a new vitest project, `characterisation` (`src/tests/characterisation/`). It is not a set of component tests: it mounts the whole `App.svelte` in jsdom against a real temp vault.
  - `window.filo` goes to the **real main-process IPC handlers**. Payload validation and structured cloning work as in the preload. Only the Electron shell is faked (`harness/electronFake.ts`), including `webContents.send` back to the renderer, so the real file watcher delivers external edits.
  - Specs call only the `harness/` adapter (`app.ts`, `actions.ts`).
  - **The rule "the suite isn't edited in Phases 3–6" is enforced as:** the spec files keep their assertions, and the adapter may change when internals move.
  - A new gate, `characterisation-suite` (codebase group), keeps the specs present and un-skipped, with a minimum number of cases each, and imports limited to `vitest`, `yaml`, `node:` and `./harness/`. It also checks that the loop breaker is installed and the vitest project is wired. Every arm was bite-verified in a temp copy.
  - The suite runs in `test:unit:strict`. Its four files take 40–70 s each, run in parallel with the other projects; the whole strict run took about 105 s.

- **2.2 Scope as built.** 22 specs.
  - **Covered as listed:** tile, Document tab and split panes; Kanban card and Task List row show title, tags, due date and priority; ticking a task; tagging a card, seen on a second board (a mind-map tile of the same note); sidebar rename, including across a relaunch; external edits while clean, while dirty ("keep mine" and "reload") and frontmatter-only; delete tile and file, then undo (Kanban and mind map); vault-wide tag rename; opening notes and boards never writes; panning.
  - **Also covered:** due date and priority on a card; ticking a task keeps unknown keys and comments byte-for-byte; a card title edit (the Phase 3 expected change needs a current behaviour to change from); a clean close leaves nothing to recover.
  - **"Open and pan a board → 0 bytes written"** is asserted for notes and board files. `.filo/viewports.json` records the camera by design, so it is excluded.
  - **Not covered:**
    - A frontmatter-only disk change *while a body edit is unsaved* (the frontmatter-only spec runs with the note clean). Today's behaviour there wasn't checked; C.5 defines the target (take the disk frontmatter, keep the body, no prompt), and Phase 5 adds the spec.
    - The Task List's "Delete Task & File" (context-menu path).
    - Rows show due date and priority, but Task List tags live in the collapsed notes panel and aren't asserted.
  - **Title edit on a card.** The file is renamed and the text follows, but the *other board's* tile keeps the old title. That's the duplicated-copy bug Phase 3 removes. No guard is added (A.7); Phase 3's expected change adds that assertion (noted in 3.7).
  - **Disk-conflict prompt label.** The adapter accepts "Keep local" (today) or "Keep mine" (C.5), so the rename is an adapter change, not a spec change.

- **2.2 Bugs the suite found, fixed here** (each red then green):
  - `f6d01ae`: after a vault swap, the first global-facade read inside a `$derived` lazily built the default board scope by writing `$state`. Svelte threw `state_unsafe_mutation` and the first mind map after opening a vault failed to render.
  - `a275b3d`: the Reload / Keep-local drift prompts were registered from a module-load microtask behind `typeof` guards. When a store import cycle left a setter unbound, which is what vitest's async evaluation does, no prompt was registered and the writer silently kept the local version (after a backup).
    - Now `App.svelte` calls `registerDriftPromptHandlers()` at startup. This is Audit-14 6.2's deferred option (b).
    - The production bundle evaluates synchronously, so it very likely worked there, but only by import order.
  - `cdfa2fa`: the tile header's Delete on a Kanban card (with or without the file), then Ctrl+Z, brought the file back but not the card. `DeleteTilesCommand` restored only the def.
    - It now restores through `DeleteCardCommand` snapshots.
    - `persistAddKanbanPlacement` also refreshes the board identity, like its siblings do.
  - `d0282b9`: a normal Save-and-close left `.filo/.dirty.<machine>`, so the next open showed "Recovered from unflushed changes". The teardown's tab and workspace resets were persisted as user changes.
    - `vaultLifecycle.isVaultTearingDown()` now gates `markMetaDirty`.
  - None of these is a duplicated-copy bug, so A.7 doesn't apply.

- **DEP-5 (Audit-19 5.3).**
  - **The bite:** the pre-`90e4092` close-drain effect (a raw, tracked `editor.setEditable`) was restored in DocumentEditor on svelte 5.57.1.
  - **Result:** `documentEditorOpen.test.ts` **hung**. The editor ↔ effect loop re-queues itself through microtasks, so neither Svelte's depth guard nor the test timeout fires. The TextTile twin timed out case by case.
  - **So jsdom does reproduce it, and svelte keeps its caret range (D11).**
  - To make the regression a clean failure, `src/tests/helpers/editorLoopBreaker.ts` throws after 500 editor `update` events in one test. With it the same bite gives three red cases, and the characterisation byte specs go red too.
  - `ci:markdown-body-roundtrip`'s EDITOR_SUITE arm now pins the breaker in `mountEditor.ts`. The characterisation gate pins it in the suite's setup.
  - The E2E `documentOpenNoWrite` docstring now points at its jsdom twins.
  - **Correction to the plan:** the tokens asked for in "Extend `ci:markdown-body-roundtrip` with their tokens" were already there since Audit-19 0.2.

- **2.4 Scratch vault.**
  - **Built by the app, not by hand:** `npm run scratch-vault` (own config, `vitest.scratch-vault.config.mts`; `FILO_SCRATCH_VAULT` names an empty target) drives the real app through the harness.
  - **Why:** its v7 boards are refused in Phase 3 like any others, and re-running the builder after 3.1 gives v8 boards.
  - **Contents:**
    - notes with and without `title:`, one whose title differs from its filename, and CRLF, BOM and odd-YAML notes;
    - a subfolder and a tagged PNG;
    - a mind map, a two-column Kanban (placed notes plus a new card with due date, priority and tag) and a Task List (quick-added tasks, one done);
    - an open Document tab (the "Document board").
  - The builder fails if an expected element doesn't appear or a crash marker is left, and it drops the test machine's `.filo/machines/` record.

**Still open (needs the owner):**
- Merge `master-plan/phase-2` into `main` and push. The Windows CI job (Phase 1) runs on that push.
- **A.6 dogfood:** open the scratch vault in the real app and use it. The builder checks the files, not the running app.
- The Phase 1 manual checks on the packaged build are still open.

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
- The characterisation suite still passes, apart from the listed title-rename change. In `metadataEdits.test.ts` ("editing a card title…"), that change is: the file keeps its name and frontmatter `title:` changes. Also add an assertion that the other board's tile shows the new title. Today it keeps the old one; see "Phase 2 — status and deviations".

**Exit:** `grep` finds no `title`/`tags`/`content`/`contentId` on any note-backed def in the scratch vault's board files. `frontmatterSync.ts` is gone. The UI looks the same.

#### Phase 3 — status and deviations (2026-09-24)

**Done** on branch `master-plan/phase-3` (off `main` at `5107b61`; nothing pushed). `ci:verify` is green: lint (0 errors), check, typecheck:main, 528 test files (5,287 tests) under `test:unit:strict`, including the characterisation suite (5 files, 33 specs), build, and 55/55 gates. The test type-check baseline went from 191 errors in 79 files to 175 in 70.

**Exit check.** The scratch vault was rebuilt by `npm run scratch-vault` (with `FILO_SCRATCH_VAULT` set to `C:\Users\andre\My Files\Filo Scratch Vault`; the builder's default target is `~/Filo Scratch Vault`). All three board files are `version: 8` and no note-backed def carries `title`/`tags`/`content`/`contentId`/`file`; media defs carry no `tags`/`fileName`/`fileExtension`; `tags.json` holds only `attachments/diagram.png`. The Phase 2 vault is kept, renamed to `Filo Scratch Vault (v7, before Phase 3)`. `frontmatterSync.ts` is gone. Net production change is about −2,300 lines in `src/renderer`/`src/main`/`src/shared`.

**How the model works in Phase 3 (the interim until Phases 4–5):**
- The board file stores the v8 shape. The in-memory cache holds exactly that shape too (defs are built by `buildTileDefinition`; `defPatchFor` keeps only board-owned fields of a tile update, per type).
- A board's runtime tiles are derived with `projectDef` (`core/boardTileOps/projectTile.ts`), used by `getFullTiles` and by the Kanban / Task List derivations: a text tile's `title`, `tags` and `contentId` come from its note, a media tile's `tags` from `tags.json`, a file tile's name/extension from its path. So every view that read `tile.title` / `tile.tags` now reads the note, reactively, without a board copy.
- `noteTitle(path)` / `noteTags(path)` / `noteFrontmatter(path)` live in `stores/noteMeta.ts`: the document store's live frontmatter when seeded, else the vault index.
- **`contentId` is runtime-only.** `stores/noteIds.ts` hands out one session id per vault path (case-folded, follows renames via `renameAllPathKeys`, reset on vault swap); every document is opened under it (`openNoteInDocumentTab`, creation sites, `loadDocument` binds a foreign id). This is the Phase 4 identity model in miniature; Phase 4 still removes the identifier itself.

**Deviations from the plan:**
- **3.1 Media titles.** Media and file defs keep `title` (a board caption), as C.2 says; only the *text* def loses it. The `board-schema-no-note-copies` gate therefore bans `title|tags|content|contentId|file` on the text def and `tags|content|contentId|file|fileName|fileExtension` on media/file defs, where 3.6's wording ("text and file tile schemas mustn't declare title…") could be read as banning a file tile's title too.
- **3.1 Properties on media and board-only tiles.** Those defs gained an optional `metadata` record (and `InlineTileSchema` too): the Properties panel stores a non-note tile's properties there, and the strict v8 defs would otherwise drop them. (Inline mind-map tiles had silently dropped them before; now they keep them.)
- **3.1 New boards are written with `version: 8`** at creation (`persistNewBoard`), not only on the first debounced save. Without it the watcher reloaded the just-created file and the version gate refused it.
- **3.2 Extra legacy removals** found in the sweep:
  - the mind-map inline `viewport` migration on save;
  - the group `displayIndex` backfill on load (`groupsBackfilled`, `backfilledBoardIds`);
  - the Kanban `kanbanFolder` field entirely (new cards already used the content folder; it only fed the convention resolver);
  - the recovery-snapshot "legacy bare basename" pruning;
  - the config double-encoded unwrap (a non-object config JSON is now `__corrupt`);
  - `mergeBoardTiles` (dead code);
  - the `.md` drop's legacy `<!-- Filo document metadata -->` header and frontmatter-`id:` reuse.
  Kept as generic robustness, not legacy: the unknown-tile-type strip on load (comment reworded), and tag-key canonicalisation in `tags.json`.
- **3.2 Loader migration steps** in the `tags.json`, template and config loaders: there were none (all were empty scaffolds), so nothing to delete.
- **3.3 `noteTitle` and ids.** The selector lives in `stores/noteMeta.ts` (not `lib/`), because it reads two stores. `noteDocId` reads only the id registry, never the open-document map, so typing in a note doesn't re-derive every tile. Tiles do still re-derive when the vault index bumps (after each write); Phase 5's note model removes that.
- **3.3 Title edits.** `UpdateTitleCommand` wraps `UpdateCardFieldCommand` for the frontmatter half (fresh-disk delta, inverse recaptured from disk on first execute, rebase on undo/redo) and updates `titleHtml` on the board. The teardown commit runs it and then files it on the home board's stack (`pushWithoutExecuteOnBoard`).
- **3.3 Document tabs** show the note's title (they used to keep the name they opened with), and renaming a Document tab now edits the note's `title:` (`lib/notes/setNoteTitle.ts`). This goes slightly beyond "the UI looks the same", but it is what D1 implies for the Document header.
- **3.3 Creation.**
  - New mind-map tiles: a tile without `filePath` gets `fileNameSafe(title)` in the board's content folder, bumped past taken paths.
  - Template layouts allocate one note path per content group (`allocateNotePath`), so grouped tiles still share one note.
  - The Markdown-template insert keeps its body.
  - A tile that names a missing path creates it with `title:` too (a note created by Filo always gets one).
  - Quick-add tags go only to frontmatter.
  - Filenames: `fileStemFromTitle` in `src/shared/fileNames.ts`, shared with main's `RESERVED_WINDOWS_NAMES`.
  - The duplicate collision wrappers in Kanban, Task List, the Task List file drop and `TaskListBoard` are gone. Creation goes through `nextFreeMdPath` or the new `createNoteFile` (`lib/notes/createNote.ts`).
- **3.3 Sidebar.** The rename validation message is `fileNameProblem` (shared). Enter is blocked while it shows; a blur abandons the rename. To stay under the 1000-line limit, the rename body moved to `lib/vault/renameVaultEntry.ts`, which took `VaultFileItem.svelte` off the allowlist (958 lines).
- **3.4 Tag writes.** A tile/path tag change on a note uses the existing fresh-read add/remove rewriter (`writeTagChangeToMarkdownPath`, now in `lib/tags/noteTagWriter.ts`), not a `FrontmatterDelta`. The delta type has no list operations, and setting the whole `tags` array from a cached read could drop a concurrently added tag. The rewriter already applies the change to a fresh disk read.
- **3.4 Split.** `fileTags.svelte.ts` went from 1,183 to 826 lines, so it left the allowlist (rather than getting a lower ceiling).
- **3.4 Vault open.** When `tags.json` is empty, the self-seed now registers tag *definitions* only (no `.md` `fileTags` entries). `pruneOrphanFileTags` drops any `.md` key left in an existing `tags.json` (with its usual toast).
- **3.5 `dropStaleSeededFrontmatterCache` is kept**, rewritten to be path-based, instead of removed. The views prefer a seeded frontmatter cache over the index, so without it an external edit to a once-field-edited card would keep showing stale values until Phase 5 replaces the cache.
- **3.6 Gates.**
  - `sentinel-machine-scoped` keeps its ban on the shared bare names, reworded from "legacy". Only the per-machine names exist now (`parseSentinelBasename` and main's `isPermittedSentinel` no longer accept bare names), so the ban still guards against re-introducing a shared name.
  - `seed-writes-exclusive` accepts `createNoteFile` and pins `lib/notes/createNote.ts`.
  - The characterisation gate requires the new `noteModel.test.ts` (11 cases).
  - Both new gates were proven to bite on every arm: 4 arms for `board-schema-no-note-copies` (a title on the text def, `.passthrough()`, a lost inline `tags`, `fileName` on the file def) and 3 for `no-legacy-board-migration` (a step, main's double-decode, the renderer re-parse).
  - File-size ceilings were lowered to current size: `TaskListBoard.svelte` 2077, `TaskItem.svelte` 1533, `KanbanBoard.svelte` 1456, `vault.svelte.ts` 1668.
- **3.7 Tests.**
  - The Phase 3 behaviours are pinned black-box in a new characterisation file, `noteModel.test.ts`. It uses two new harness actions: `sidebarRenameMessage` and `renameFileToMatchTitle`.
  - Unit tests: `boardFormatV8`, `noteTitles` (including `titleHtml` hidden after a title change), `updateTitleCommand`, `updateTitleCommandActiveBoard` and `buildTextTileDefForNote`.
  - `metadataEdits.test.ts` got exactly the listed expected change plus the cross-board title assertion. The component helper `mountTextTile` now defaults `filePath`/`contentId` the way tile derivation does.
  - About 100 unit/component test files were moved to the v8 shape. Seven files were deleted because they only covered removed code: `frontmatterSync`, `boardCacheReconcileBatch`, `boardCacheReconcileOnLoad`, `onOpenReconcileSwapGuard`, `renameTitleCommand`, `renameTitleCommandCleanUndo`, `boardStoreRenameTextTile`. So were `kanbanFolder{LegacyFreeze,Move,Stability}`, `dragDropDedupe`, `dragDropTagSeed` and `buildTextTileDefFromMarkdownFile`; their still-valid intent moved to the new tests. Individual cases for removed behaviour were deleted too: convention paths, legacy sentinels, migration steps, the save-time strip and the viewport migration.
- **Bugs found by the suites and fixed here:**
  - Kanban cards and Task List rows lost their title/tags (they had their own def→tile derivations).
  - New boards were refused on reload (no version).
  - A new mind-map tile's note lost its `title:` on the first keystroke: its editor cached the empty frontmatter it read before the seed created the file. The seed now records the created frontmatter, and the editor's missing-file path no longer overwrites a cached one.

**Still open (needs the owner):**
- Merge `master-plan/phase-3` into `main` and push.
- **A.6 dogfood:** open the rebuilt scratch vault in the real app. The Book Vault's boards are now refused (D9), so they have to be rebuilt.
- The Phase 1 manual checks and the Windows CI job are still open.

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

#### Phase 4 — status and deviations (2026-09-25)

**Done** on branch `master-plan/phase-4`, branched from `master-plan/phase-3` (see the first deviation); nothing is pushed. `ci:verify` is green: lint (0 errors), check, typecheck:main, 529 test files (5,300 tests passed, 1 skipped) under `test:unit:strict` with clean output, including the characterisation suite (5 files, 35 specs), build, and 56/56 gates. The test type-check baseline went from 175 errors in 70 files to 174 in 69.

**Exit check.** `grep -rniE "(content|doc)Ids?\b" src/` finds nothing, in production code, tests and E2E specs alike, and the new `no-content-id` gate keeps it that way. A rename re-keys the document store's entries for that path (one entry per note) through the existing `renameAllPathKeys` sweep, and the rename cascade rewrites the boards' `filePath` fields as before.

**How identity works now:**
- `documentStore` keys every per-note map by the note's case-folded `VaultPath`: the open documents, per-writer dirty sets, the three frontmatter caches, the mutation counters and the read-only set. Every method takes the path in any spelling. `DocumentState` has no id; `filename` is the on-disk spelling.
- **Renames.** A stable opaque id used to make renames free, so the path keys need rename handling that the ids didn't. The store's sweep (`registerPathRenamable('documentStore')`) moves every entry for the exact file or a folder's descendants. A case-only rename keeps the key and updates `filename`. The mutation counters move with the note and never go backwards. Three more pieces of per-note state follow renames the same way:
  - the frontmatter scheduler's last-flushed marks. A mark left at the old path would make the first writes of a new note created there look stale, so they would be skipped;
  - the force-writer registry, so Keep-local still reaches an editor whose note moved;
  - open Document tabs.
- `findByFilename` is a map lookup, and `propagateRename` is the sweep.
- The runtime text tile has no `contentId`. Views key by `tile.filePath`, or `resolveTextTileVaultPath(tile)` for text-only call sites.
- **Removed:** `stores/noteIds.ts`, `noteDocId`, `documentStore.updateFilename` / `updateTitle` / `updateTitleClean`, TextTile's sibling-id adoption, and the external-rename cascade's separate `updateFilename` call. That call covered only an exact file rename, not a folder's descendants; the sweep covers both.

**Deviations from the plan:**
- **Branch base.** Phase 3 isn't merged into `main` yet, so this branch starts from `master-plan/phase-3` (`bb4b97b`). Merge Phase 3 first, then this branch.
- **Document tabs.** A Document tab's `boardId` was the session doc id. It is now an opaque id, and the note is a new `TabData.notePath` field opened with `tabStore.openNote(path, name)` and matched case-insensitively. Using the path as the `boardId` would have stranded the tab's undo stack, which is keyed by board id, on every rename. The rename sweep rewrites `notePath` only. Document tabs still aren't restored across a relaunch, as before.
- **Write arguments keep a path field.** `WriteArgs.docId` became `WriteArgs.notePath`, not a boolean. It is the note's own path, or `null` for a cache-less write (orphan-card patch), so behaviour is unchanged. The same applies to the commands' and the scheduler's `docId` parameters. The field is redundant with `relPath` and goes away with the gateway in Phase 5.
- **Plan item 5 (templates).** No change was needed. Phase 3 already captures text tiles grouped by note path and instantiates each group at a freshly allocated path; no id was involved.
- **Plan item 4 (D6).** `markdownTileSeed.ts` and `kanbanTileCreation.ts` had already stopped reading or writing `id:` in Phase 3. What remained was `assembleMarkdownFile`'s opt-in `contentId` option, which no caller used; it is deleted. An `id:` already in a file is preserved (unit-tested).
- **File size.** The rename sweep pushed `markdownFileWriter.ts` over its 1132-line ceiling. Per A.2 the force-writer registry moved to `lib/vault/markdownForceWriters.ts` (the gateway re-exports `registerForceWriter` / `unregisterForceWriter`). The ceiling is lowered to 1092.
- **Gates.**
  - **Added `no-content-id`** (codebase group). It bans `contentId` / `docId` in any casing, as a whole name or a camelCase part (`openDocId`), in every source, test and JSON file under `src/`, comments included, but not a longer word such as `docIdentity`. It was proven on a production renderer file, on `src/main`, and on the `docIdentity` false-positive case.
  - **Changed `editor-body-discipline` rule D.** It pinned `hasFrontmatter(existing.docId)` on the deleted sibling-adopt branch. It now requires the in-memory body branch that remains to check `hasFrontmatter(notePath)`, and was proven by removing that check.
  - `relpath-rename-transfer` no longer exempts `document.svelte.ts` or `frontmatterWriteScheduler.ts`, because both now register sweeps.
  - The `characterisation-suite` minimum for `noteModel.test.ts` went from 11 to 13.
- **Tests.**
  - **New `notePathIdentity.test.ts` (11 cases):** one document per path in any spelling; the rename re-key (file, folder, case-only, counters); the scheduler mark following a rename; Keep-local after a rename; a Document tab following a rename; D6. Each of the four rename sweeps was switched off in turn, and each time its cases went red.
  - **Two new characterisation specs** in `noteModel.test.ts`: a note open in a tile and a Document tab keeps saving to its new name after a sidebar rename, and a folder rename above an open note sends later edits to the moved file. These add coverage; no existing spec assertion changed.
  - **Test migration.** About 145 test files moved to paths, done by five parallel agents under a shared brief with no production edits allowed, rather than one directory at a time (item 6). They found no production bugs. Two files were renamed: `frontmatterSchedulerDocIdKeying` became `frontmatterSchedulerPathKeying`, and `kanbanNoDocIdUndo` became `kanbanOrphanFrontmatterUndo`.
  - **Cases deleted or rewritten** because they tested id machinery:
    - "injects contentId as id" (deleted);
    - the scheduler's two-ids-one-path aliasing case, which became "the mark carries across a rename";
    - "shares the same docId" and "updateFilename retargets", which became path equivalents.
  - **E2E.** The Kanban and Task List E2E specs called a `documentStore.createDocument` that no longer existed before this phase. They now seed the note on disk. They weren't run, because E2E is manual-only.
- **Observed, not changed:** typing in a note without frontmatter drops the file's final newline (`Monday\n` becomes `Monday Tuesday`). This happens without any rename and predates this phase. The new folder-rename spec deliberately doesn't pin it either way.

**Still open (needs the owner):**
- Merge `master-plan/phase-3`, then `master-plan/phase-4`, into `main` and push. The Windows CI job runs on that push.
- **A.6 dogfood:** open the scratch vault in the real app, and rename a note while it's open in a tile and a Document tab. The board format didn't change, so the Phase 3 scratch vault still loads.
- The Phase 1 manual checks are still open.

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

#### Phase 5 — status and deviations (2026-09-25)

**Done** on branch `master-plan/phase-5`, branched from `main` at `7205e55` (Phases 1–4 merged and pushed); nothing is pushed. `ci:verify` is green: lint, svelte-check, `typecheck:main`, 524 test files (5,217 tests, 1 skipped), build, and 53/53 gates.

| Step | Commit(s) |
|---|---|
| 1. `noteFile`, `noteWriter`, `noteStore` + unit tests (not wired) | `b6710a7` |
| 2–6. Callers moved, old modules deleted, tests migrated | `15fc204` |
| 8. Gates | `5c162d6` |

**Exit check.**
- **Exactly one module writes `.md`.** `lib/notes/noteWriter.ts` is the only renderer file that invokes `vault:write-existing-file-text`, `vault:write-file-text` for a note, or `vault:create-file-text` (gate `single-note-writer`; the three `.filo/` sentinel writers and the Kanban toolbar's position file keep their `allow-direct-write:` markers).
- **One note in three views is one model.** Every view acquires the note's `NoteModel` by path; a tile, a Document tab and a split pane of the same note share it (characterisation `oneModel.test.ts`, `editingAndViews.test.ts`).
- **KNOWN_LIMITATIONS #9 (two separate reads) is closed:** a write now reads the file once, inside the path's queue, and applies the change to that read. Updating the KNOWN_LIMITATIONS text is Phase 7 (DOC-1).

**How it works now**
- `lib/notes/noteFile.ts` — pure: `readNoteText` (frontmatter, body, BOM, line ending), `assembleNoteText(fresh, { body?, delta? })` (CST patch of the fresh frontmatter source, disk body kept when no new body, fresh BOM and EOL re-applied, CRLF body per MD-10), `newNoteText`, FNV-1a `noteTextHash` (the same digest the main-process watcher computes).
- `lib/notes/noteWriter.ts` — `createNoteWriter(host)`. One queue per path on the existing `createScheduler` primitive (300 ms debounce, `pending-path` sentinel mode, `NOTE_WRITE_TIMEOUT_MS` bound, retained retries). Each flush runs inside the path's promise chain: fresh read (re-read when the read overlapped another writer), torn-frontmatter check, body-drift check against the model's `base` (conflict → the body stays queued and the flush fails, so save/quit report it), assemble, skip identical bytes, re-stat and start over if the file moved since the read, `trackComponentWrite` + write, then report to the store. Also: exclusive create with ` (n)` bumps, `transform` (rewrite from fresh bytes), `restore`, `hold` (rename/delete), `renamePath`, and a short own-write hash memory.
- `stores/notes.svelte.ts` — `noteStore`: one `NoteModel` per open note keyed by `VaultPath`; `acquire`/`release` reference-counted by view id; `setBody` (only a view holding the model may write; D7 owner = the view that typed); `patchFrontmatter` (delta, shown at once; for an unloaded note laid over the vault index until it lands); `currentFrontmatter`; `onDiskChanged` (the C.5 table, in `lib/notes/noteDiskChange.ts`); `resolveConflict`; rename sweep; vault-swap reset.
- `stores/notePrompts.ts` — the one conflict prompt (**Reload** / **Keep mine**, the latter backs the other version up to `.filo/recovery/` first), a deleted-with-unsaved-edit prompt (**Keep mine** recreates exclusively / **Discard**), and "reloaded and much shorter" (**Undo reload**).
- `lib/editor/noteEditorView.ts` — the editor side, shared by `TextTile` and `DocumentEditor`: serialise after 150 ms idle and on blur/unmount/store request; never reload the view's own body; never load mid-IME or over unserialised keystrokes; a load is not an edit.
- `commands/noteFieldCommand.ts` — the shared base of `UpdateCardFieldCommand` / `UpdateTaskFieldCommand` (first execute recomputes the inverse from the note as it stands; undo/redo rebase through `frontmatterRebase.ts`, which now sends deltas to the store).

**Deviations from the plan**
- **Callers moved in one change, not family by family (steps 2–6).** Moving one family at a time would have meant keeping the old gateway and the new writer running side by side, with a shim to keep the document store and the note store in step. That shim would be a new sync guard, which rule A.7 forbids. So `b6710a7` built and tested the new modules on their own, and `15fc204` moved every caller and deleted the old stack together. The characterisation suite was green before and after.
- **The orphan-card command was folded into `UpdateCardFieldCommand`.** With one writer there is no difference between an open and an unopened card note, so `UpdateOrphanFrontmatterCommand` and `applyOrphanPatchRebased` went. Both field commands now share `commands/noteFieldCommand.ts`, and their `notePath` argument was dropped (the note's path is the only identity since Phase 4).
- **`conflictResolver.ts` was deleted rather than shrunk (step 5).** The C.5 table lives in `lib/notes/noteDiskChange.ts` (`decideDiskChange`: ignore / retry / missing / replace / take-frontmatter / conflict). `vaultExternalDriftPrompts.ts` keeps only the board-file prompt; the note prompts moved to `stores/notePrompts.ts`.
- **`status` is separate from `readOnly`, and there is an `unreadable` status.** A note whose first read stays torn after three retries (500 / 1,500 / 3,000 ms) is `unreadable` and read-only, so nothing is written over the half-written file. A `missing` note is read-only too, until the deleted-note prompt recreates it.
- **Reload drops only the body.** Queued frontmatter deltas still land on the reloaded file, since they are deltas on a fresh read and never conflict.
- **Prompts dropped:** the Properties-popup prompt, the bulk "many files changed" prompt and the partial-read retry prompt. With one model there is one conflict prompt per note (the new spec pins that one conflict shows one prompt; the old code showed two), a frontmatter-only change is taken silently, and a torn read is retried by the store, not the user.
- **`notePossiblyStale` is no longer raised for `.md` changes.** The note store decides for loaded notes; unloaded notes are re-read from the index.
- **Up to 150 ms of typing can be lost on a crash.** The editor serialises after 150 ms of idle (and at once on blur, unmount, save and quit), so a hard crash mid-burst loses at most that window. Save and quit are unaffected.
- **Trash is Phase 6.** Undo of a delete writes the snapshot back through `noteStore.restore` (exclusive create), as before; `note-queue-per-path` covers rename and delete through `noteStore.hold` until trash lands.
- **Two additions to the store API:**
  - `writeBody(path, body)`: for the Task List notes box, which edits a note's body without an editor view.
  - `transform(path, fn)`: rewrites from the fresh bytes inside the path's queue. Tag writes and Replace All use it; Replace All only applies while the bytes still match what the user previewed.
- **Step 7 (main-process hash matching) was not done.** The renderer writer remembers the hashes of its own recent writes and ignores their echo, which closes the practical half of KNOWN_LIMITATIONS #5; moving the check into main is left open.
- **Docs are Phase 7.** `CLAUDE.md` and KNOWN_LIMITATIONS still describe the gateway. KNOWN_LIMITATIONS #8 and #9 are effectively closed by this phase and should be rewritten in DOC-1.
- **`// allow-raw-read:` escape.** `views-read-note-store` forbids components from reading or parsing files themselves; `KanbanSideToolbar`, `KanbanTemplatePicker` and `TemplateBrowser` read non-note files and carry the marker.
- **`vaultStore.setPath` now also sets the active vault path** used by the identity guards, so tests and the app agree on which vault a write belongs to.
- **The tag-rename sweep stops on a vault swap.** It checks the active vault before each file; before, a sweep running during a swap could write into the new vault.
- **A frontmatter-only edit is byte-exact at the end of the file.** A note with no final newline keeps none; before, the gateway added one.
- **Profile:** serialising a 50 KB note takes a median 12.5 ms (max 21.6 ms) in jsdom, well inside the 150 ms idle window. Kanban cards still mount a full editor per card, as before this phase.
- **Gates:** 56 → 53. Added `single-note-writer`, `note-queue-per-path` and `views-read-note-store`; retired `markdown-gateway`, `md-writers-reconcile-editors`, `reload-cancels-writes`, `markdown-read-gateway` and `no-prod-md-test-flushers`; folded `frontmatter-delta-write` into `single-note-writer`. `keep-local-backup` now matches "Keep mine" and checks the `notePrompts.promptConflict` chokepoint. Every new or changed arm was shown to bite in a scratch copy. File-size ceilings went down (TaskListBoard 2070, TaskItem 1522, KanbanBoard 1450, KanbanColumn 1197; `markdownFileWriter` removed). The test type-check baseline went from 174 errors in 69 files to 149 in 55.
- **Bugs found while migrating, fixed with tests:** Task List notes typed while the note loads were missed by a quit drain; a failed Keep-mine recreate lost the edit; Discard after an external delete kept the tags entry and skipped the remove-tiles offer; a tag write that couldn't read the note didn't mark the path failed; a torn read of a note no view had loaded could be written over; a model could stay `loading` across a vault change; a frontmatter-only edit added a final newline; the tag sweep kept writing after a vault swap.

**Still open (needs the owner)**
- Merge `master-plan/phase-5` into `main` and push; the Windows CI job runs on that push.
- **A.6 dogfood:** open the scratch vault in the real app: type in a tile and a Document tab of the same note, split a pane, edit a note in another program while it is open (clean, typing, frontmatter only), rename and delete open notes.
- The Phase 1 manual checks on the packaged build are still open.

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

#### Phase 6 — status and deviations (2026-09-25)

**Done** on branch `master-plan/phase-5` (on top of the Phase 5 commits, as the owner asked; Phase 5 isn't merged yet); nothing is pushed. `ci:verify` is green: lint (0 errors; the 14 pre-existing unused-variable warnings are Phase 7 DEAD-1), svelte-check, `typecheck:main`, 529 test files (5,269 tests, 1 skipped) under `test:unit:strict` (unit, component and characterisation), build, and 55/55 gates. The test type-check baseline went from 149 errors in 55 files to 119 in 45.

**Exit check.**
- **Every user-facing delete is recoverable, for every file type and size.** The sidebar delete of a file or folder, a board delete, "delete tile and file" and "delete task and file" all move the item into `.filo/trash` (gate `deletes-go-to-trash`). Undo moves it back with a rename. The characterisation suite deletes a `.docx`, a 40 MB video, a folder and a board file from the sidebar, then undoes, and gets back the same bytes and every tile (`trash.test.ts`).
- **No command keeps a copy of a note body** (gate `no-note-body-in-commands`). Delete undo is a restore from the trash; note-field undo is an inverse `FrontmatterDelta`; Replace All keeps only the replaced snippets.
- **`vaultFolderOps.ts`** went from 923 to 513 lines, with the sidebar delete now in `stores/vaultDeleteOps.ts`. **`boardCache.svelte.ts`** went from 793 to 734, with the board delete now in `stores/boardCacheDelete.ts`. Neither is on the size allowlist.

**How it works now**
- **Main process.** `src/main/vault/trashOps.ts` + `src/main/ipc/vaultTrash.ipc.ts`.
  - Each entry is `.filo/trash/<trashId>/manifest.json` (`{ originalPath, deletedAt, machineId, kind }`) plus the item at `.filo/trash/<trashId>/files/<originalPath>`. The id looks like `20260925T101500Z-a1b2c3`.
  - A move writes the manifest first, then renames the item in, with the Windows lock retry. A failure removes the bookkeeping and nothing moves. On this Windows machine, a folder holding an open file fails with EPERM and stays whole; there is a Windows-only test for this.
  - A restore goes to the original path, or beside it as `… (restored).md` / `Plan (restored).board.json` when that path is taken. It recreates missing parent folders.
  - A purge calls `shell.trashItem` for each item. Items it refuses come back as `TRASH_FAILED` with the list; the purge only ever `rmdir`s empty folders and unlinks the manifest.
  - A manifest is synced data, so one naming a path outside the vault or inside `.filo/` is ignored.
  - The watcher ignores `.filo/trash/`. Moves and restores suppress the watcher for the paths (the whole tree for a folder).
- **Renderer access.** Only through `lib/vault/vaultOperations.ts`: `trashVaultPath` and `restoreTrashed` drain the writers and hold the note's write queue, as `renameVaultPath` does. `listTrash`, `purgeTrash` and `deleteTrashPermanently` complete the set.
- **Commands.** `commands/trashedFiles.ts` (`trashFiles` / `restoreFiles`) is shared by `DeleteTilesCommand` (`{ filePaths }`), `DeleteTaskCommand` (`{ filePath }`) and `CascadeDeleteCommand` (`{ trashed, fileTags, styleClears }`).
  - After a restore, `stores/trash.svelte.ts: syncAfterRestore` refreshes the tree (which re-adopts a restored board), re-reads the search index under the path, and reloads any open note that had gone missing (`noteStore.restoredFromTrash`).
  - A file restored beside a newer one re-targets the restored tiles to the restored copy.
- **Settings → Trash** (`components/settings/TrashSettings.svelte`) lists items newest first with Restore, plus "Empty trash" (to the Recycle Bin). If the Recycle Bin refuses, one confirm lists every file and asks "Delete permanently?"; Cancel keeps them in Filo's trash.
- **Vault open.** This machine's items older than 30 days go to the Recycle Bin (`purgeExpiredTrash`, run after the other open checks).
- **Board undo of frontmatter (6.2).** `commands/frontmatterRebase.ts` became `commands/frontmatterInverse.ts`.
  - `NoteFieldCommand` records a forward and an inverse `FrontmatterDelta`, the inverse taken from the note as it stands on first execute. Undo sends the inverse through `noteStore.patchFrontmatter`, so the writer applies it to a fresh read of the file.
  - `UpdatePropertiesCommand` uses the same `applyDeltaChecked`, so its duplicate conflict code is gone.
  - Undo of "Rename file to match title" is `RenameFileCommand`: the reverse rename through `vaultStore.rename`, which holds the queue and makes the boards follow.

**Deviations from the plan**
- **Trash layout.** The item sits under `files/` inside its entry (`.filo/trash/<id>/files/<rel>`), not at `.filo/trash/<id>/<rel>`, so a vault-root file named `manifest.json` can't collide with the manifest.
- **Two extra channels.** `vault:trash-list` feeds Settings → Trash. `vault:trash-delete-permanently` is the confirmed fallback. The plan had the fallback use `vault:delete`, but `vault:delete` refuses `.filo/` paths by design; a dedicated channel that only accepts trash ids is narrower than loosening that guard. `vault:delete` is now used only by the `.filo/` sentinel clean-ups (gate).
- **Two channels removed.** `board:delete` (boards go to the trash) and `vault:write-file-binary`, whose only caller was the media-snapshot undo. `deleteVaultPath` is gone from `vaultOperations.ts`.
- **Board delete undo is a toast.** A board's undo history goes with the board, so its Ctrl+Z has nowhere to live. The "moved to Filo's trash" toast offers Undo; Settings → Trash covers it later. The same toast appears for a sidebar delete that no reachable undo stack holds: when no board is open, or when the active board's own file goes. Its Undo runs that delete's `CascadeDeleteCommand.undo`.
- **The 30-day purge is not awaited on open.** It may ask "Delete permanently?", and the rest of the vault-open sequence must not wait for that answer. Cancelling asks again at the next open.
- **The same-key conflict check stays in 6.2.** The plan calls inverse deltas "safe against edits made in between, by construction". That holds for keys the command didn't touch. For a key it did touch, a blind inverse would overwrite another program's newer value, so the "keep the external value / Apply anyway" check from Phase 5 stays, now on deltas.
- **Only "Rename file to match title" got undo.** Sidebar renames still aren't on board undo, as before this phase.
- **Replace All no longer keeps whole notes.** It kept each file's text before and after for undo. Each plan now holds the file's before/after hash and length and the replaced snippets. Undo and redo apply only when the bytes are exactly what the plan expects.
- **`Command.hasFileSnapshots` is removed.** So is the history store's "deleted files … cannot be restored" toast: dropping undo history no longer loses a file.
- **The zero-tile early return in `cascadeDeleteByVaultPath` is kept for the case with nothing to undo** (no tile, no style field, nothing trashed). A trashed item always gets a command, so a note on no board can be undone.
- **Behaviour fixed along the way**, each with a test:
  - redo of a sidebar delete now moves the item to the trash again (before, it removed the tiles and left the file on disk);
  - undo now puts back an attachment's `.filo/tags.json` file tags (before, they were dropped for good);
  - a vault swap now clears history's active board. Before, a vault opened with no board showing filed its commands under the previous vault's board, where no undo could reach them;
  - when undo restores a file beside a newer one that took its name, a later redo moves the restored copy to the trash again, not the newer file. The tiles (Kanban cards included) and file tags follow the restored copy.
- **Not done here (needs the packaged build).** The `trashItem` probe on the OneDrive vault (including an online-only placeholder), a mapped share and a FAT32 USB stick. Its results, and "`.filo/trash` syncs through OneDrive", go into KNOWN_LIMITATIONS with Phase 7 DOC-1.
- **Gates: 53 → 55.** Each new or changed arm was shown to bite in a scratch copy.
  - Added `deletes-go-to-trash` (writePath) and `no-note-body-in-commands` (commands).
  - Extended `no-raw-disk-shape-ipc` (the trash channels), `note-queue-per-path` (trash move and restore) and the `reconciler-vault-guard` pins (the delete, trash and inverse-delta helpers).
  - Re-pointed `single-note-writer` at `frontmatterInverse.ts`.
  - `characterisation-suite` gained `trash.test.ts` (minimum 9).
- **Tests.**
  - New: `trashMain.test.ts` (17 cases: round-trip bytes, locked child, restore beside, `.filo/` refused, a tampered manifest, `TRASH_FAILED`, the 30-day sweep, no `fs.rm` in a purge); `trashStore.test.ts` (6); `renameFileCommand.test.ts` (3); `historyVaultSwapActiveBoard.test.ts` (1).
  - Characterisation: `trash.test.ts` (9). `renamesAndDiskChanges.test.ts` gained only the listed expected change (the file is in `.filo/trash` after "delete tile and file", and gone from it after undo).
  - About 22 existing test files were migrated by three parallel agents under a shared brief with no production edits allowed. They found no production bugs.
- **Size.** Tracked production files: +707 / −1,505 lines. The new modules add about 1,500 (the trash module, IPC, store, Settings tab, delete slices and helpers). Removed: the snapshot capture and caps, the body and media restores in three commands, the snapshot escalation, and Properties' duplicate conflict code.

**Still open (needs the owner)**
- Merge `master-plan/phase-5` (Phases 5 and 6) into `main` and push; the Windows CI job runs on that push.
- **The `trashItem` probe** on the packaged build: OneDrive (with an online-only placeholder), a mapped share, and a FAT32 USB stick.
- **A.6 dogfood.** In the scratch vault:
  - delete a note, a media file, a folder and a board from the sidebar, then undo each;
  - restore from Settings → Trash, including over a name that is taken again;
  - Empty trash;
  - "Rename file to match title", then undo.
- The Phase 1 manual checks on the packaged build are still open.

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

# Audit-19 Implementation Plan (2026-09-23)

> **SUPERSEDED 2026-09-24** by [MASTER_IMPLEMENTATION_PLAN_2026-09-24.md](MASTER_IMPLEMENTATION_PLAN_2026-09-24.md). Phases 0–1 below are done; Phases 2–5 were re-sequenced, absorbed or made obsolete there (see its Part D). Keep this file for the per-line specs of carried-over items.

**Source:** [AUDIT19_REPORT_AND_REMEDIATION_PLAN_2026-09-23.md](AUDIT19_REPORT_AND_REMEDIATION_PLAN_2026-09-23.md). That file holds the findings, scores and evidence; this file is the build plan.
**Branch:** `chore/dependency-majors` @ `28d3063`. All line anchors were re-verified on 2026-09-23 by four read-only planners, each covering one group: editor layer, files/paths/boards, cloud sync, deletes/security/CI.
**Status:** Phase 0 DONE 2026-09-23 (commits 858f7e7..2947037 on chore/dependency-majors; ci:verify green, 50 gates, 5097 tests). **Phase 1 DONE 2026-09-23** (commits 5b4c4a2..da5ddac; ci:verify green, 54 gates, 5252 tests): 1.1-1.12 all landed, each with a bite-verified test; new gates ci:keep-local-backup, ci:failed-write-refire, ci:sentinel-machine-scoped, ci:utf8-validated-read (+ arms in awaited-writes-bounded, board-path-casefold, md-writers-reconcile-editors, filo-read-guard, reconciler-vault-guard). Phase 1 deviations: a dedicated `vault:convert-to-utf8` channel instead of an allowReencode flag; nonUtf8Paths set instead of FileMetadata.encoding; "Show in folder" instead of "Open both"; foreign-sentinel stale toast in addition to the modal listing; the EXT-8 vault guard needed a new Part 3 pin (Part 1 does not see `activeVaultRoot`). CLAUDE.md gate count/list NOT updated (left for 5.6). Phases 2-5 not started. Phase 0 deviations: `nextFreeMdPath` takes the cache as a parameter (avoids a conventionPaths<->boardCache cycle); `boardFileEncodingRoundTrip.test.ts` stands in for `boardSaveStat.test.ts`; MD-2 LOD-toggle test not written (needs a TileContainer mount); an extra hole found and closed in MD-5 (onUpdate ignores edits while a disk read has failed); unconfirmed writes drop the baseline text (MD-2 layer-2 hardening).

## How to use this plan

- Work **phase by phase and step by step** in the numbered order below. Each step has **Files · Mechanism · Fix · Gate · Tests · Acceptance criteria · Risks**.
- **Finding IDs** (BL-1, MD-2, …) are the stable references. Step numbers (0.5, 1.4) are ordering only. Some sections mention "steps" inside another item; that means that item's numbered Fix list.
- **Every step:** write the failing (bite) test first, then fix it, then `npm run ci:verify` green, then commit. Node isn't on PATH, so prefix commands with `C:\Program Files\nodejs`. Each new gate or gate arm must be bite-verified: a temp copy of the regression must exit 1.
- **Never raise a file-size ceiling.** Split instead, as each section specifies. Files that are exactly at their limit today: `writeScheduler.ts` 1000 (not allowlisted), `markdownFileWriter.ts` 1416, `vault.svelte.ts` 1867, `boardCache.svelte.ts` 1009, `kanbanCommands.ts` 1093, `TaskListBoard.svelte` 2209, `fileTags.svelte.ts` 1252, `vaultFolderOps.ts` 1018. `fileWatcher.ts` is at 994 and has 6 lines of headroom.
- **Checklist for a new IPC channel:** `IpcChannel` union (`src/shared/types.ts`, no `'` or `;` in its comments), Zod tuple (`ipcSchemas.ts`), contract (`ipcContracts.ts`), handler (`ci:ipc-parity`), `ENVELOPE_CHANNELS` in `check-ipc-envelope-usage.mjs` plus its parity test if it returns an envelope, and `MAIN_TO_RENDERER_EVENTS` + `RECEIVE_CHANNELS` for pure events. Markdown writers also need the `ci:markdown-gateway` and `ci:md-writers-reconcile-editors` entries.
- **Vault-identity discipline:** any new renderer module that reads the live vault path and then `await`s must `captureVaultIdentity()` / `isStillSameVault()` after every await, and must be added to `ci:reconciler-vault-guard`.

## Owner decisions (defaults applied; overrule any before its phase starts)

| # | Decision | Where |
|---|---|---|
| D1 | A note flagged lossy becomes **truly non-editable**, with one **Take ownership** action. False positives are reduced separately (linkify off, `filo:` allowed, tight task lists, table and `1)` normalisation). | 0.14 (UX-1) |
| D2 | New `.md` seeds use a **create-exclusive** channel `vault:create-file-text` (`'wx'` → typed EEXIST), with ` (n)` bumping. | 0.5 (BL-1) |
| D3 | `.board.json`: main writes string payloads **verbatim**; the loader accepts legacy double-encoded **and** plain JSON, and each file migrates on its next save. | 0.4 (ERR-1) |
| D4 | **Retire implicit convention paths.** Stamp `filePath` on every drop and creation, do a one-time idempotent back-fill at vault open (and again just before any pin change), and route every resolver through `resolveTextTileVaultPath`. | 2.1 (MD-9 cluster) |
| D5 | Crash sentinels stay in `.filo/` but are **per machine** (`.filo/.dirty.<machineId>`, with the id minted in userData). Each machine only clears its own. Legacy single sentinels are migrated once. | 1.10 (EXT-6) |
| D6 | Windows lock retry: about **5 s** of time-bounded EPERM/EBUSY backoff on `atomicWriteFile` + `renameItem`. Failed writes keep their args and re-fire from Retry and the quit drain. Orphan `.tmp` files are swept to `.filo/recovery/`. | 1.4 (EXT-5) |
| D7 | "Keep local" always **backs up the external bytes** to `.filo/recovery/` first. Non-promise decision toasts are sticky; promise-backed toasts keep the Audit5-R3 15 s cap. | 1.2 (UX-6) |
| D8 | One shared conflict-copy detector in `src/shared/conflictCopy.ts`. OneDrive host names only count when the host is known; ` (1)` and ` 2` only count when the original sits alongside. Includes a negative corpus (`Report (2).md` stays safe). | 1.1 (C0) |
| D9 | User-initiated deletes (sidebar file/folder, board) go to the **Recycle Bin** through a new `vault:trash` channel. Main never silently falls back to a permanent delete; if trash fails, a second confirm lists every file Undo cannot restore. App-internal deletes stay on unlink. | 4.3 / 4.4 |
| D10 | Audio: allow only **audio-only `media`** requests from the main frame of the app window. Iframe tiles are denied. `shell.openPath` moves to an **allowlist**; unknown extensions get "Show in folder". | 4.1 / 4.2 |
| D11 | DEP-5: keep `svelte ^5.57.1` and move the open-without-write check into the jsdom component suite. It must be shown to fail against the pre-`90e4092` code, or the fallback is an exact pin. | 5.3 |
| **Needs your OK** | BL-5 adds an optional `recurrenceAnchor` frontmatter key, written only for days 29–31. BL-8 reads the date order from `app.getSystemLocale()`. | 3.5 / 3.4 |

## Release and rollout notes (read before shipping Phase 0)

1. **ERR-1 can't be downgraded.** Once the fixed build saves a board, **older builds can't open it**. Update every machine that opens the synced vault before using the new build on any of them.
2. **Take a full copy of the vault** before the first run of the Phase 2 back-fill (D4). It re-saves every legacy board once. Do one manual open of that copy to confirm.
3. **The Recycle Bin behaviour must be probed first** (4.3 Step 0) on the packaged Electron 44 build: OneDrive NTFS including an online-only placeholder, a mapped or network share, and FAT32 USB. If `trashItem` permanently deletes instead of rejecting on any of them, main must pre-check the drive type.

## Phase exit criteria

| Phase | Done when | Unlocks |
|---|---|---|
| 0 | The editor integration suite is green for MD-1/MD-2/MD-3/ERR-1. `ci:editor-body-discipline` and `ci:seed-writes-exclusive` are live. No false board prompt appears after two saves. Opening and panning a board writes 0 bytes. | **Dogfooding with real notes** (about 7/10). The safe-use rules in the report can be retired. |
| 1 | Conflict copies are detected and surfaced, not adopted. A 2 s file lock no longer fails a save. Retry and the quit drain re-fire failed writes. A second machine never clears the first machine's sentinel. | A two-machine synced vault. |
| 2 | Every text tileDef has a `filePath`. `ci:no-convention-path-resolution` is live. A pin change doesn't rebind any tile. | Safe folder reorganisation. |
| 3 | Round-trip tests exist for bulk-delete undo, recurrence and the locale date order. | — |
| 4 | Deletes go to the Recycle Bin, or the confirm lists every unrecoverable file. Audio recording works. `.js`/`.wsf` files can't be opened. | — |
| 5 | Main and tests are type-checked in `ci:verify`. A Windows CI job exists. Docs match the code. | Next audit. |

**Gate count:** 48 today. New gates: `ci:editor-body-discipline`, `ci:seed-writes-exclusive`, `ci:no-convention-path-resolution`, `ci:keep-local-backup`, `ci:failed-write-refire`, `ci:utf8-validated-read`, `ci:sentinel-machine-scoped`, `ci:user-delete-recycle` and `ci:test-typecheck`, for **57** in total. Extended: `ci:markdown-body-roundtrip`, `ci:markdown-gateway`, `ci:md-writers-reconcile-editors`, `ci:ipc-envelope-usage`, `ci:creation-persists-filepath`, `ci:writer-path-honors-filepath`, `ci:awaited-writes-bounded`, `ci:reconciler-vault-guard`, `ci:filo-read-guard` and `ci:file-sizes` (splits only). Update CLAUDE.md's count and load-bearing list as each one lands (5.6 does the final sweep).

**Parallelism:** Phases 0 → 1 are sequential: Phase 1 depends on BL-1, ERR-1 and UX-1. **4.1 (DEP-3) and 4.2 (ERR-6) are independent one-file fixes** and can be done at any time, including before Phase 0. Phase 3 items are independent of each other. BL-6 should land after 2.1. **0.6 (MD-4) and 0.7 (MD-1) ship in one commit.**

## Master index

| Step | Finding(s) | Summary | Effort | Depends on |
|---|---|---|---|---|
| 0.1 | T0 (prerequisite, test infra) | Component-mount test project for TextTile / DocumentEditor | S | none |
| 0.2 | NEW (cross-cutting) | Editor-level integration suite (real TipTap + real Svelte components in jsdom + real main-side board IO) | M | none to build it; each case goes green when its fix lands (MD-1, MD-2, MD-3, ERR-1) |
| 0.3 | ERR-2 HIGH | `assertSafeFilename` rejects any name containing `..`, so "Call Bob." / "Ideas… later" can't be created, read, | S | none |
| 0.4 | ERR-1 HIGH | `.board.json` is JSON-encoded twice; the Audit-17 size check never matches, so every board's 2nd save shows a  | M | none (must land **before** the path-cluster back-fill, which mass-dirties boards) |
| 0.5 | BL-1 CRITICAL | New Kanban card / task / Task-List OS drop silently overwrites an existing vault file | L | ERR-2 (same `fileNameSafe` edit; land ERR-2 first or together) |
| 0.6 | MD-4 MEDIUM (pulled into Phase 0) | DocumentEditor reloads its own content after every successful autosave, which wipes redo, breaks IME compositi | S | none |
| 0.7 | MD-1 + DEP-1 HIGH (was CRITICAL) | Loading or reloading a file is recorded in ProseMirror's undo history, so Ctrl+Z empties the note or reverts a | S | MD-4 (must ship in the same change, see Risks) |
| 0.8 | MD-3 HIGH | Re-parsing a body-only store body strips a leading `---…---` horizontal-rule pair as frontmatter, and the trun | S-M | T0 (tests) |
| 0.9 | MD-5 HIGH | TextTile sibling-adopt loads an unhydrated placeholder `DocumentState` (body `''`) into a writable editor | M | MD-3 (same lines) |
| 0.10 | MD-2 HIGH | TextTile's onDestroy writes the file on every unmount, even when nothing was edited (culling, LOD, board or ta | M | T0; lands after MD-3/MD-5 so their bites stay observable |
| 0.11 | DEP-2 HIGH | `linkify: true` turns filenames and bare domains into links, so ordinary notes open read-only and typed filena | S | none |
| 0.12 | UX-2 + DEP-4 + MD-8 MEDIUM | `filo://` internal links can't be inserted (setLink silently returns false), and notes that contain one open r | S | none |
| 0.13 | UX-7 LOW | Filo writes checklists as loose lists, which other editors render with extra spacing | S | none |
| 0.14 | UX-1 + MD-7 HIGH | Lossy "read-only" mode disables saving but not editing, so typed text is silently discarded | M | DEP-2 / UX-2 / UX-7 for the false-positive step (step 5) |
| 1.1 | C0 (infrastructure for ERR-3 / EXT-2 / EXT-7) | shared conflict-copy detector | S | none |
| 1.2 | UX-6 LOW (MEDIUM on a synced vault) | Decision toasts vanish after 15 s, and "Keep local" overwrites the other device's edit with no backup | M | none (EXT-3/EXT-4/ERR-3/EXT-2 consume it) |
| 1.3 | EXT-4 MEDIUM | "Mark broken refs" actually deletes placements on every board (the copy says "closed boards") | S | none |
| 1.4 | EXT-5 + ERR-9 MEDIUM | A lock retry of about 310 ms, no re-fire of failed writes, stray `.tmp` files in the synced vault, and no retr | L | none (EXT-1 and ERR-4 consume step 3) |
| 1.5 | ERR-4 MEDIUM | `board:load` returns `null` for every error, so a lock or offline placeholder reads as "not-found" and the boa | M | ERR-1 (payload shape); EXT-5 step 1 (`WIN_LOCK_CODES`) |
| 1.6 | EXT-1 MEDIUM | An external folder rename evicts open boards (discarding the pending edit) and they are never rediscovered in  | L | EXT-5 step 3 (retained failed writes) and ERR-4 (shared `adoptBoardAtRuntime`) |
| 1.7 | ERR-3 + GAP-1 + EXT-7 MEDIUM | Duplicate board id: first file in code-unit order wins, and conflict forks of a `.board.json` are invisible | M | C0; ERR-1 (loader payload shape) |
| 1.8 | EXT-2 MEDIUM | A cross-basename rename is correlated onto a sync conflict copy, rebinding every tile, editor and tag to the l | S | C0 |
| 1.9 | EXT-3 MEDIUM | "Keep local" on the deleted-externally prompt re-creates the file without re-probing, overwriting what sync ha | S | BL-1 (create-exclusive `vault:create-file-text`); UX-6 (backup helper) |
| 1.10 | EXT-6 + ERR-8 LOW (MEDIUM for a two-machine user) | Machine-local crash sentinels live in the synced `.filo/`, so machines clear or replay each other's recovery s | L | none (C0 uses the machine registry) |
| 1.11 | ERR-7 MEDIUM | Non-UTF-8 notes are decoded lossily, and any write (including a vault-wide tag sweep) persists U+FFFD | M | UX-1/MD-7 (Phase 0: a real non-editable read-only mode) |
| 1.12 | EXT-8 LOW | A tags.json update from another machine that lands inside the self-write window is dropped, and the next local | S | none |
| 2.1 | MD-9 / MD-11 / BL-3 / BL-4 MEDIUM | Text tiles resolve their `.md` through divergent implicit convention rules; stamp `filePath` everywhere, back- | L | ERR-1 (the back-fill mass-dirties every legacy board. Without ERR-1, each of those writes  |
| 2.2 | BL-7 LOW | Sidebar rename of a filePath-backed card/task leaves the tile title stale | S | path cluster |
| 2.3 | MD-6 MEDIUM (PLAUSIBLE) | Two views of the same tile or document (split panes) share one `callerId`, which defeats per-writer dirty gati | S | MD-2 (it removes the stale final-write half of the scenario) |
| 2.4 | MD-10 LOW | Any body edit on a CRLF note produces a mixed-EOL file (CRLF frontmatter, LF body) | S | none (improves MD-2's skip for CRLF notes) |
| 3.1 | BL-2 MEDIUM | Undo of Task-List bulk delete / "Delete completed" scrambles order and moves tasks between sections | S | none |
| 3.2 | BL-9 LOW | Kanban "Sort: Due date" puts undated cards first | S | none |
| 3.3 | BL-6 LOW | Deleting a Kanban column leaves its cards' tileDefs in `.board.json` forever | S/M | none (coordinate with the path-cluster back-fill: orphan defs would otherwise be back-fill |
| 3.4 | BL-8 LOW | Quick-add parses `d/m` as US month/day | S/M | none |
| 3.5 | BL-5 LOW | Monthly/yearly schedule-mode recurrence drifts permanently (31st → 28th, Feb 29 → Feb 28) | M | none |
| 4.1 | DEP-3 MEDIUM | Deny-all permission handler blocks Audio-tile recording (Electron-upgrade regression) | S | none |
| 4.2 | ERR-6 MEDIUM | `shell.openPath` blocklist misses Windows script types → switch to an allowlist | S | none |
| 4.3 | UX-3 + ERR-5 HIGH | Sidebar delete promises undo it can't deliver, and a partial folder delete strands state and discards the snap | L | ERR-1 (Phase 0 ERR-1, only for the board-restore half shared with UX-4), DEAD-1 absToVault |
| 4.4 | UX-4 MEDIUM (verifier: LOW) | Board delete is permanent: no Recycle Bin, no undo, no warning | M | UX-3 steps 1-4 (`vault:trash` + `trashVaultPath`), ERR-1 (Phase 0 ERR-1, board serialisati |
| 4.5 | ERR-10 LOW | `config:load` returns the `{}` fallback on non-ENOENT errors | S | none |
| 4.6 | ERR-12 LOW | Quit-failure breadcrumb overwrites an unacknowledged one; no crashed-renderer handling | M | none |
| 4.7 | ERR-11 LOW | Path depth capped at 10; the `.tmp` suffix makes 239–255-char names unwritable | S | ERR-2 (Phase 0 ERR-2, which edits the same `assertSafeFilename` L193 + `pathSecurity.test. |
| 4.8 | UX-5 MEDIUM (verifier: LOW) | Vault-wide tag rename/delete uses native `confirm()` and cannot be undone | M (5a: S, 5b: M) | none |
| 5.1 | CI-2 LOW | Unit-test stderr noise that the strict runner doesn't catch | S | none |
| 5.2 | CI-1 LOW | Main and test sources aren't type-checked in `ci:verify`; CI is Linux-only; coverage floor lowered | M | CI-2 (the duplicate-key fixes remove 4 of the test type errors) |
| 5.3 | DEP-5 LOW | The Svelte phantom-write guard is E2E-only while svelte is a caret range | S (on top of the suite) | editor-level integration suite |
| 5.4 | DEAD-1 LOW | Dead or duplicate code (each symbol grep-confirmed 2026-09-23) | S | UX-3 step 5 for `absToVaultRelative` |
| 5.5 | DEP-6 LOW | Zod 4 `.int()` rejects integers above 2^53, so such boards fail to load | S | none |
| 5.6 | DOC-1 LOW | CLAUDE.md, the design doc and code comments contradict the code | S | everything above; UX-6 (Phase 1 UX-6, toast persistence) |
---

## Phase 0 — Blockers: fix before any real data goes in

**Re-verified:** 2026-09-23 on `chore/dependency-majors` @ `28d3063` (working tree clean apart from the Audit-19 report).
**Method:** I re-opened every cited line and then drove the real code through scratch vitest probes (scratchpad `probe/*.probe.test.ts`, run with a probe config layered over `vitest.config.mts`):
- `a.probe`: real `createTiptapEditor` + `loadMarkdownIntoEditor`. Covers MD-1's bite and fix, MD-3's parse, the lossy false-positive list and the `filo://` setLink failure.
- `b.probe` / `c.probe`: the same editor with the proposed DEP-2 / UX-2 / UX-7 configuration, run over the whole golden corpus to see which baselines move.
- `e.probe`: **mounts the real `TextTile.svelte`** in jsdom (Svelte `mount` with a stub `BoardScope` context and the `installFiloMock` bridge). It reproduced MD-2 and MD-3 end to end with no typing at all. On a note `---\ntitle: x\n---\n---\n\nSome intro\n\n---\n\nMore _text_\n`, mount → unmount wrote `… More *text*` (a phantom normalising write). A remount displayed only "More text", and the second unmount wrote `---\ntitle: x\n---\nMore *text*\n`: **the intro and both rules were deleted from disk**.

Ceilings checked (`scripts/check-file-sizes.mjs`): `TextTile.svelte` 637, `DocumentEditor.svelte` 837, `markdownSync.ts` 612, `createEditor.ts` 336 and `document.svelte.ts` 927 are all under 1000 and not allowlisted. **`markdownFileWriter.ts` is exactly at its ceiling (1416/1416)**, so every gateway change in this group must be net-zero or come with an extraction (see MD-2).

---

> **Reconciling 0.1 and 0.2 (build ONE harness):** two planners proposed the same component-mount harness independently. It is the failing test for MD-1, MD-2, MD-3 and ERR-1. They disagree on one point: 0.1 puts `resolve.conditions: ['browser']` in a separate vitest `component` project, while 0.2 flips it globally (its probe showed all 4914 existing tests still pass that way).
> **DECISION:** use 0.1's separate `component` project for isolation and coverage stability. Put the files under `src/tests/component/`, merge 0.2's `mountEditor.ts` helper and suite cases into it, and take 0.2's real-fs board save→stat integration test as-is. Register the suite in `ci:markdown-body-roundtrip` (0.2's gate step), pointing at the component paths.

### 0.1 T0 (prerequisite, test infra) — Component-mount test project for TextTile / DocumentEditor
**Phase:** 0 · **Depends on:** none · **Effort:** S
**Files:** `vitest.config.mts` (the `test` block at L9-L41); new dir `src/tests/component/`; `scripts/test-unit-strict.mjs` (L23 already spawns a bare `vitest run`, so it needs no change).
**Mechanism (re-verified 2026-09-23):** no unit test mounts a `.svelte` component today (the TextTile tests `audit12L5.test.ts` and `textTileNoProjectMutation.test.ts` only regex the source). Under the repo config, a `mount()` fails with `lifecycle_outside_component`, because the bare `svelte` import resolves to the server entry. My probe mounted `TextTile.svelte` successfully once `resolve.conditions: ['browser']` was set. MD-2, MD-3, MD-5 and UX-1 all live in component mount/unmount/hydrate code, so their bite tests need this.
**Fix:**
1. Turn `vitest.config.mts` into two `test.projects`:
   - `unit`: the current config, unchanged.
   - `component`: `include: ['src/tests/component/**/*.test.ts']`, `resolve.conditions: ['browser']`, the same `setupFiles` and aliases.
   Do **not** flip the conditions globally: 4,900 existing tests run against the current resolution.
2. Add `src/tests/component/helpers/mountTextTile.ts`. It exports `mountTextTile({ tile, file, scope? })`, which calls `vaultStore.setPath('/vault')`, installs `installFiloMock` with read/stat/write handlers, and returns `{ target, component, writes, calls, settle, unmount }`. `settle()` loops `await tick(); await setTimeout(0)` about 20 times (the probe used this). Add a sibling `mountDocumentEditor({ tabId, … })` that seeds a `tabStore` tab.
3. Mock envelope detail: `invokeOk` returns non-envelope payloads unchanged, so a read handler returns `{ ok: true, content, mtimeMs, size }` (not `{ data: … }`).
**Gate:** none of its own. `test:unit:strict` runs every project, so these tests are already inside `ci:verify`.
**Tests:** `src/tests/component/harnessSmoke.test.ts`. Mount a TextTile on a plain note and assert that the editor text shows the body and that `documentStore.getDocument(contentId).body` equals the disk body.
**Acceptance criteria:** `npm run test:unit` reports both projects. The whole existing suite still passes with identical counts.
**Risks / interactions:** coverage config lives under `test`, so keep it on the root or the `unit` project so `test:unit:coverage` thresholds are unchanged. Every Group A item below uses this harness.

---

### 0.2 NEW (cross-cutting) — Editor-level integration suite (real TipTap + real Svelte components in jsdom + real main-side board IO)
**Phase:** 5, but **pull the harness forward to the start of Phase 0**; see the execution order. · **Depends on:** none to build it; each case goes green when its fix lands (MD-1, MD-2, MD-3, ERR-1) · **Effort:** M
**Files:**
- `vitest.config.mts` (add `resolve.conditions`).
- New `src/tests/helpers/mountEditor.ts`.
- New tests under `src/tests/unit/editorIntegration/` (the existing include glob `src/tests/unit/**/*.test.ts` picks them up).
- Existing `src/tests/unit/markdownBodyRoundTrip.test.ts` + corpus `src/tests/unit/fixtures/markdown-body-roundtrip/`.
- `scripts/check-markdown-body-roundtrip.mjs` (TEST_FILE L24, REQUIRED_TOKENS L41-48).
- `src/renderer/components/tiles/TextTile.svelte` (props L41-50; `getContext(BOARD_SCOPE_KEY)` L18; onMount L157-213).
- `src/renderer/components/boards/DocumentEditor.svelte` (prop `tabId` L56).
- `src/main/vault/boardFileOps.ts` (`saveBoardFile`); `src/renderer/lib/boards/boardWriteScheduler.ts` L385-437.

**Mechanism (re-verified 2026-09-23):**
- The existing body round-trip net drives `createTiptapEditor` + `loadMarkdownIntoEditor` + `editorMarkdown` **without** the components. It cannot see what TextTile/DocumentEditor do on mount, unmount, undo or reload.
- `vault:stat` is stubbed in every board-write test.
- Probe results (header): a real `mount(TextTile)` in jsdom **reproduces MD-2 and MD-1** (writes `*emphasis*`/ATX on no-edit unmount; writes `"\n"` after Ctrl+Z). So this layer can be tested cheaply, and nothing tests it today.

**Fix:**
1. `vitest.config.mts`: add `resolve.conditions: ['browser']`. DECISION: global rather than a separate vitest project. The probe ran all 484 files / 4914 tests green with it, and it is required for Svelte 5 client `mount()`. Keep `environment: 'jsdom'`.
2. `src/tests/helpers/mountEditor.ts`:
   - `recordingFilo(files: Record<string,string>)`. It is built on `installFiloMock` catch-all and handles `vault:read-file-text`, `vault:stat`, and `vault:write-*` (which updates the in-memory file and records it). It exposes `writesTo(rel)` and ignores `.filo/.dirty`.
   - `mountTextTile({ tile, files })`: `vaultStore.setPath('/vault')`, `mount(TextTile, { target, props:{ tile }, context: new Map([[BOARD_SCOPE_KEY, getActiveScope()]]) })`, and `await settle()` (flushSync + `setTimeout(0)` + a hydrate wait).
   - `mountDocumentEditor({ tabId, docPath, files })`: seed the tab and board via the store APIs the Document board uses.
   - `pressUndo(target)` / `pressRedo(target)`: dispatch `keydown` `z`/`y` with `ctrlKey` on `.ProseMirror` (proven in the probe).
   - `unmountAndDrain(c)`: `unmount` + advance past the 300 ms debounce.
   - `captureConsoleErrors()`, for `effect_update_depth_exceeded`.
3. Suites:
   - `editorIntegration/textTileLifecycle.test.ts`:
     - (a) **mount→unmount without edit writes nothing**, parameterised over **every fixture in the markdown-body-roundtrip corpus** (LF + CRLF). Today it is red on at least `_x_`/Setext; MD-2 flips it green.
     - (b) **load→Ctrl+Z leaves body and disk unchanged** (red today, writes `"\n"`; MD-1).
     - (c) **reload→Ctrl+Z**: after mount, apply an external change through the real reload path (`applyReloadFromDisk` / the "Reload" handler in `vaultExternalPrompts`); Ctrl+Z must not resurrect the pre-reload text and must not write (MD-1 reload half).
     - (d) **body starting with a `---` rule plus a later `---` survives mount→edit one char→write** (MD-3).
     - (e) **one-char edit writes once with only that delta** (sanity; green today).
   - `editorIntegration/documentEditorOpen.test.ts`:
     - (a) **open CRLF note → close: bytes unchanged, zero `effect_update_depth_exceeded`** (the DEP-5 promotion of `e2e/documentOpenNoWrite.test.ts`);
     - (b) open LF note, same assertions;
     - (c) load→Ctrl+Z (DocumentEditor twin of MD-1).
   - `editorIntegration/boardSaveStat.test.ts` (**real main-side IO**):
     - Route `board:save` to the real `saveBoardFile(join(tmpdir, rel), data)` from `src/main/vault/boardFileOps.ts` and `vault:stat` to a real `fs.stat` (tmp dir via `fs.mkdtemp`, the pattern `renameItem.test.ts` uses).
     - Drive the renderer's real board write, then assert (i) the bytes on disk parse with a single `JSON.parse` into the board object, and (ii) `getBaseline(boardPath)` holds the real `size`/`mtimeMs`, meaning the size check matched.
     - Red today (ERR-1); green after Phase 0 ERR-1.
     - Also: a legacy double-encoded file on disk still loads (ERR-1 migration requirement).
4. **Gate extension:** extend `scripts/check-markdown-body-roundtrip.mjs` with an `EDITOR_SUITE` block. It requires the three files to exist and pins these tokens (comment-stripped):
   - `mount(` + `TextTile` + `unmount(` in `textTileLifecycle.test.ts`;
   - `ctrlKey: true` (undo driven through the real keymap);
   - the corpus directory constant (so case (a) stays tied to the corpus);
   - `DocumentEditor` + `effect_update_depth_exceeded` in `documentEditorOpen.test.ts`;
   - `saveBoardFile(` + `fs.stat`/`stat(` in `boardSaveStat.test.ts` (real main function, not a stub).

   Keep the name `ci:markdown-body-roundtrip` (it is now "the editor byte net"), update its docstring, and bite-verify each arm (delete a token in a temp copy → exit 1).

**Tests:** the suite itself. **Bite cases:** (a)/(b) are red on today's tree (probe-verified); each Phase-0 fix is accepted only when its case flips. For DEP-5, see below.
**Acceptance criteria:** the suite runs inside `test:unit:strict` in `ci:verify` (no E2E needed), fails on a phantom write, an undo-empties-note, or a board-baseline mismatch, and is pinned by the extended gate.
**Risks / interactions:**
- jsdom has no layout. Tiles that depend on `IntersectionObserver`/`ResizeObserver` need no-op polyfills in the helper; TextTile didn't in the probe.
- The global `browser` condition could change which build a future dependency resolves under test. The probe showed no change today; revisit if a package ships divergent browser/node builds.
- The suite adds about 2–4 s (TipTap transform cached per worker).
- CLAUDE.md: rewrite the `ci:markdown-body-roundtrip` bullet and add the helper under Testing Strategy ("component tests: mount real components with `mountEditor.ts`").

### 0.3 ERR-2 HIGH — `assertSafeFilename` rejects any name containing `..`, so "Call Bob." / "Ideas… later" can't be created, read, renamed or saved
**Phase:** 0 · **Depends on:** none · **Effort:** S
**Files:**
- `src/main/utils/pathSecurity.ts` L184-230 (`assertSafeFilename`; the substring test at L193), L256-285 (`assertSafeRelativePath` applies it per segment)
- `src/renderer/lib/vault/conventionPaths.ts` L21-28 (`fileNameSafe`)
- `src/renderer/lib/vault/fileRefIntegrity.ts` L28-40 (`sanitizeForFilename`, the documented mirror of `fileNameSafe`)
- Callers of `fileNameSafe`: taskCreation.ts:210, kanbanTileCreation.ts:140/236, fileDropHandler.ts:152, TaskListBoard.svelte:766, boardCache.svelte.ts:647 + kanbanFolderFreeze.ts:27 (Kanban folder freeze)
- Tests: `src/tests/unit/pathSecurity.test.ts` L39-42, L221, L295-301

**Mechanism (re-verified 2026-09-23):** L193 throws "contains path separators" when `fileName.includes('..')`.
I compiled the validator with esbuild (scratch probe, `forCreation: true`): it REJECTS `Call Bob..md`,
`Ideas... later.md`, `notes/Wait... what.md`, and ACCEPTS `Done.md`. `fileNameSafe` keeps a trailing `.`, so the
title "Email the landlord." gives `buildTaskDef` (taskCreation.ts:210-214) the path `Email the landlord..md`.
The write is rejected, and `AddTaskCommand` rolls back with an error toast. Every channel validates relative paths
with `assertSafeRelativePath` (read-file-text, write*, stat, file-exists, board:load/save/create, the rename
target), so imported names like `Thoughts... 2026.md` show up in the sidebar but can't be opened. The substring test adds no traversal protection. `assertSafeRelativePath` splits on `/` and `\`,
so any traversal attempt reaches `assertSafeFilename` as a bare `..` segment. A bare `..` or `.` is already
rejected by the trailing-dot rule (L205), and `assertWithinVault` contains every joined path anyway. main's `sanitizeFilename` (filenameUtils.ts:29-37, board names) already
strips trailing dots.

**DECISION (owner, from the report's Phase 0 list):** reject only a segment that is exactly `..` or `.`. Make
`fileNameSafe` strip trailing dots and spaces.

**Fix:**
1. pathSecurity.ts:193 →
   ```ts
   if (fileName === '.' || fileName === '..' || path.basename(fileName) !== fileName || fileName.includes('\\')) {
     throw new Error('Unsafe filename rejected — contains path separators or is a dot segment');
   }
   ```
   Update the L171 doc bullet ("`.`/`..` segments", not "`..`").
2. `fileNameSafe` (conventionPaths.ts:21-28): add `.replace(/[. ]+$/, '')` after `.trim()`, before the
   `|| 'Untitled'` fallback, so "Done." gives `Done.md` and "..." gives `Untitled`. Apply the identical change to
   `sanitizeForFilename` (fileRefIntegrity.ts:33-40) to keep the documented mirror in lockstep. This is safe for
   legacy name-derived Kanban folders because no Filo build could ever create a folder segment ending in `.`
   (L205 rejects it). For the same reason, the Kanban folder freeze (boardCache.svelte.ts:647,
   kanbanFolderFreeze.ts:27) now produces a legal folder for a board named "Q3.".
3. No renderer change is needed for imported files. Once main accepts them, they read and write normally.

**Gate:** none — justification: a two-line validator change fully pinned by `pathSecurity.test.ts` (below). A token
gate would only restate the test.

**Tests:** `pathSecurity.test.ts`:
- new `it('accepts ellipses and double dots inside a name')` → `Call Bob..md`, `Ideas... later.md`, `v1..2.md`,
  `notes/Wait... what.md` pass `assertSafeRelativePath(…, { forCreation: true })`. **Bite:** revert L193 and this goes red.
- The existing `..`, `../etc/passwd`, `..\\Windows`, `foo/../bar.md`, `notes\\..\\..\\evil.md` cases stay red,
  proving no traversal regression. Add `'.'` and `'a/./b.md'` → throw.
- `conventionPaths` test: `fileNameSafe('Call Bob.') === 'Call Bob'`, `fileNameSafe('...') === 'Untitled'`,
  `fileNameSafe('a. ') === 'a'`. Same for `sanitizeForFilename` through `getConventionFolderForBoardType('kanban', 'Q3.')`.
- A taskCreation-level case in `seedWritesExclusive.test.ts`: quick-add "Email the landlord." → `Email the landlord.md`.

**Acceptance criteria:** quick-add "Call Bob." creates `Call Bob.md`. A vault file `Thoughts... 2026.md` opens,
edits and saves. `vault:rename` to `Plan... v2.md` succeeds. `..`-segment traversal is still rejected.

**Risks / interactions:** titles that end in "." lose the dot in the filename, and so in the title (the title
derives from `relPath`). That's intended. It overlaps with BL-1's helper, which also needs the rule for each
candidate (`base (n)` never ends in `.`). Tiny diff, no ceiling files touched.

---

### 0.4 ERR-1 HIGH — `.board.json` is JSON-encoded twice; the Audit-17 size check never matches, so every board's 2nd save shows a false "modified externally" prompt
**Phase:** 0 · **Depends on:** none (must land **before** the path-cluster back-fill, which mass-dirties boards) · **Effort:** M
**Files:**
- `src/main/vault/boardFileOps.ts` L21-24 (`loadBoardFile`), L32-36 (`saveBoardFile`), L45-68 (`createBoardFile`, stringify at L65)
- `src/main/ipc/board.ipc.ts` L166-190 (`board:load`), L196-229 (`board:save`), L234-263 (`board:create`)
- `src/renderer/lib/boards/boardWriteScheduler.ts` L392-433 (payload L392, save L395, size check L429)
- `src/renderer/stores/boardCache.svelte.ts` L657-663 (`board:create` with `JSON.stringify(fileData, null, 2)`)
- `src/renderer/lib/boards/boardLoader.ts` L399-433 (`raw` typed `string | null`, second `JSON.parse` at L430)
- `src/shared/ipcContracts.ts` L206-209 (`'board:load'` result typed `string | null`, which encodes the double-encoding assumption)
- Precedent: `src/main/vault/configOps.ts` L211-217 + L301-306 (config legacy double-encode unwrap) and L367 (`typeof data === 'string' ? data : JSON.stringify(...)`)

**Mechanism (re-verified 2026-09-23):** the renderer serialises the board
(`const payload = JSON.stringify(fileData, null, 2)`, boardWriteScheduler.ts:392) and sends the **string**
(`board:save`, L395). `board.ipc.ts:222` → `saveBoardFile` runs `JSON.stringify(data, null, 2)` on that string
again (boardFileOps.ts:34), so the file on disk is a JSON **string literal**. `board:create` does the same
(boardCache.svelte.ts:660-663 → boardFileOps.ts:65). A node probe confirms it: a 69-byte payload lands as 89 bytes,
and `typeof JSON.parse(onDisk) === 'string'`. Loading only works because both sides unwrap symmetrically
(`loadBoardFile` parses to a string, then boardLoader.ts:430 parses again). The post-write check at
boardWriteScheduler.ts:429 compares `postStat.size` with `writtenByteLength(payload)`. That's the un-escaped
length, so it never matches, and `refreshBaselineAfterWrite(undefined, undefined)` keeps the load-time baseline
(DI-14 rule). Save #2's pre-write stat then differs from that baseline (L350), `boardExternalEditHandler` →
`promptBoardExternalEdit` fires, and every later save prompts again, including on quit (`flushAll` blocks until
`writeTimeoutMs`). There are two side effects. A plain-JSON board (hand-edited or tool-written) fails to load,
because `JSON.parse(object)` throws "[object Object]" (boardLoader.ts:430). And `jsonPayloadByteSize` measures the
un-escaped string (payloadLimits.ts:100-104), so a board under the 50 MB `board:save` cap can exceed
`PAYLOAD_LIMITS.BOARD` on disk, and `board:load` then refuses it (board.ipc.ts:176-179).
**Other dependents checked:** `board:create`'s only renderer caller is `persistNewBoard` (boardCache.svelte.ts:660),
which templates, BoardBrowser, TabBar and BoardRouter all go through. Layout templates are read by
`templates.ipc.ts:85` (their own files, not boards). Export and recovery snapshots copy bytes. E2E tests seed
boards in memory with `boardCacheStore.hydrate` and verify through the app (`dailyDriverSmoke.test.ts:336-367`), so
nothing reads raw `.board.json` bytes. Unit stubs for `board:load` return `JSON.stringify(board)`, a single
encoding (boardLoader.test.ts ×14, audit13Phase4:350, audit16Phase4:513, boardReconcilerDrainRace:102/122). Those
keep working if the renderer accepts a string. No committed `.board.json` fixture exists (`find` = 0).
`boardCreate*Guard.test.ts` call `createBoardFile` with objects, and those still work.

**DECISION (owner):** main writes string payloads verbatim. The loader accepts both legacy double-encoded files
(JSON string literal) and plain JSON objects, so existing boards keep loading and migrate on their next save.

**Fix:**
1. `saveBoardFile` / `createBoardFile` (boardFileOps.ts:34, :65):
   `const json = typeof data === 'string' ? data : JSON.stringify(data, null, 2);`, matching `saveConfig`
   (configOps.ts:367). Guard against a renderer bug writing a non-board string with a cheap sniff that doesn't
   re-parse multi-MB boards on the 300 ms hot path: if `typeof data === 'string'` and its first non-whitespace
   char isn't `{`, throw `Error('board payload is not a JSON object')`.
2. `loadBoardFile` (boardFileOps.ts:21-24): mirror configOps' legacy unwrap.
   `const parsed = JSON.parse(raw); return typeof parsed === 'string' ? JSON.parse(parsed) : parsed;`. An inner
   parse failure throws, and `board:load`'s catch returns `null` as today. The typed `board:load` envelope is
   ERR-4, Phase 1.
3. `boardLoader.ts:399-433`: type `raw` as `unknown`, change the `!raw` guard to `raw == null`, and replace L430 with
   `rawJson = typeof raw === 'string' ? JSON.parse(raw) : raw;`. That accepts an object from the new main, and a
   string from old stubs or a mid-upgrade main.
4. `ipcContracts.ts` L206-209: `'board:load'` result becomes `unknown` (object | null). Remove the cast at boardLoader.ts:401.
5. Leave `boardWriteScheduler.ts:392-395` and `boardCache.svelte.ts:660-663` as they are. They still send the
   string, which main now writes verbatim, so `writtenByteLength(payload) === onDiskSize` holds and L429 refreshes
   the baseline. No ceiling file changes.
6. Doc: update the `loadBoardFile` / `saveBoardFile` docstrings. Add a KNOWN_LIMITATIONS line under #14: "boards
   written by builds after Audit-19 are plain JSON; builds from before it cannot open them (see Risks)".

**Gate:** none new — justification: the invariant ("on-disk size equals the renderer's payload byte length") is
behavioural, and the integration test below pins it with the real main code. A token gate on `typeof data === 'string'`
would duplicate that without catching a wrong encoding. Optional cheap tripwire: add a `ci:awaited-writes-bounded`-style
token pin that `saveBoardFile` does not call `JSON.stringify(data` unconditionally. Default: not added.

**Tests:**
- **Required integration test** `src/tests/unit/boardFileEncodingRoundTrip.test.ts`, using the **real** main-side
  `saveBoardFile` / `loadBoardFile` / `createBoardFile` against `fs.mkdtemp(tmpdir())` with **no stubbed
  `vault:stat`**:
  (a) `saveBoardFile(p, JSON.stringify(data, null, 2))` → `JSON.parse(await fs.readFile(p))` is an **object**
  deep-equal to `data`, and `(await fs.stat(p)).size === writtenByteLength(payload)` (import the real helper from
  `boardWriteDebounce.ts`);
  (b) legacy file: write `JSON.stringify(JSON.stringify(data, null, 2), null, 2)` raw → `loadBoardFile` returns an
  object deep-equal to `data`;
  (c) hand-written plain JSON → loads;
  (d) `createBoardFile(root, 'X', JSON.stringify(fd))` → plain object on disk, with the `(2)` collision still working;
  (e) **end-to-end renderer path**: install a `window.filo` whose `board:save` → real `saveBoardFile(join(root, rel), data)`,
  `vault:stat` → real `fs.stat` mapped to `{ success, mtimeMs, size }`, `board:load` → real `loadBoardFile`,
  `vault:read-*` unused. Run `loadBoard(root, rel)` on a **legacy** file, then `writeBoardFile` with an edit
  (save #1, the migration), then another edit and `writeBoardFile` (save #2). Assert that the registered
  `boardExternalEditHandler` spy is **never** called, `getBaseline(rel).size` equals the on-disk size after each
  save, and the file is plain JSON after save #1. **Bite:** put back
  `const json = JSON.stringify(data, null, 2)` in `saveBoardFile` and (a) plus (e) go red (the handler spy fires on save #2).
- `boardLoader.test.ts`: add "`board:load` returns an object → loads" and keep the string-stub cases.
- Leave `fileBaselineDrift.test.ts` alone (it's a unit of the drift logic). Add a comment pointing to the new
  integration test as the authority on real sizes.

**Acceptance criteria:** after opening an existing vault and making three consecutive edits on a board (each past
the 300 ms debounce), no "modified externally" prompt appears. The `.board.json` on disk is a plain JSON object
after the first save. A hand-edited plain-JSON board loads. `ci:verify` is green.

**Risks / interactions:**
- **Downgrade / multi-machine:** once a board is saved by the fixed build, a build from before the fix (another
  PC on the same OneDrive vault, or a rollback) fails to load it, because the old `boardLoader` does `JSON.parse(object)`.
  The board lands in `failedBoards` and gets a recovery snapshot, so nothing is lost, but the board won't open
  there. **Update every machine before opening the vault.** Call this out in the release notes and in the
  Audit-19 safe-use section.
- The migration is lossless: `JSON.parse∘JSON.parse` then `JSON.stringify` round-trips JSON data (the only
  exceptions are duplicate keys and `-0`, which Filo never writes).
- The main-side content hash (`fileWatcherHash.ts`) changes on the first migrating save, but that save is a
  suppressed self-write, so no reconcile runs.
- No ceilinged file changes. `boardFileOps.ts` +6 LOC.

---

### 0.5 BL-1 CRITICAL — New Kanban card / task / Task-List OS drop silently overwrites an existing vault file
**Phase:** 0 · **Depends on:** ERR-2 (same `fileNameSafe` edit; land ERR-2 first or together) · **Effort:** L
**Files:**
- `src/renderer/lib/vault/conventionPaths.ts` L21-28 (`fileNameSafe`), L40-58 (`nextUniqueMdPath`)
- `src/renderer/lib/kanban/kanbanTileCreation.ts` L39-41 (wrapper), L137-186 (`createTile` text branch, write at L155), L232-272 (`createTileFromTemplate`, write at L258)
- `src/renderer/lib/tasklist/taskCreation.ts` L42-44 (wrapper), L152-199 (`seedMdFile`, write at L166), L201-236 (`buildTaskDef`)
- `src/renderer/lib/tasklist/fileDropHandler.ts` L44-46 (wrapper), L133-168 (`importOsMarkdownFile`, write at L159; docstring L136 wrongly says "collision-checked")
- `src/renderer/commands/taskCommands.ts` L88-177 (`AddTaskCommand`, seed hook L101/L154-161)
- `src/renderer/lib/boards/seedTextFileForNewTile.ts` L69-86 (Mind Map exists-then-write, TOCTOU; parity only)
- Main: `src/main/ipc/vault.ipc.ts` L664-699 (`vault:write-file-text`, create-or-overwrite), 883 LOC today
- IPC inventories: `src/shared/types.ts` L27-32, `src/shared/ipcSchemas.ts` L88-94, `src/shared/ipcContracts.ts` L144-159, `scripts/check-ipc-envelope-usage.mjs` L37-75, `src/tests/unit/ipcEnvelopeAllChannels.test.ts` L56-79, `src/main/utils/payloadLimits.ts` L44

**Mechanism (re-verified 2026-09-23):** `nextUniqueMdPath` (conventionPaths.ts:40-58) builds `taken` from
`${prefix}${def.title}.md` of cached text defs only. It never looks at disk or the vault index, it compares
case-sensitively, and its own docstring (L36-38) admits the gap. The four creation sites then call
`invokeOk('vault:write-file-text', …)` (kanbanTileCreation.ts:155 writes `''`, :258 writes the template body;
taskCreation.ts:166 writes `---\ncompleted: false\n---\n` or the quick-add FM; fileDropHandler.ts:159 writes the
dropped bytes). The handler (vault.ipc.ts:665-699) does `mkdir -p`, then an unconditional `atomicWriteFile`, with
no existence check. The watcher is self-suppressed (L689/L691), so there's no drift prompt, no recovery snapshot,
and undo only removes the placement. Two more paths lead to the same result: a deleted card's title leaves `taken`
(`removeKanbanPlacement` drops the def, boardCacheKanban.ts:402-421), and `Groceries.md` vs `groceries.md` differ
under the case-sensitive compare while NTFS treats them as the same file.
Mind Map is not affected: `seedTextFileForNewTile.ts:70` probes `vault:file-exists` and **adopts** an existing
file. That still leaves a small exists→write TOCTOU window.
`TaskListBoard.renameTask` (TaskListBoard.svelte:766-796) also uses `nextUniqueMdPath`, but it renames through
`vault:rename`, which refuses to overwrite (`TARGET_EXISTS`). It fails safely and is not part of BL-1.
Kanban's OS-file drop goes through `vault:copy-file` → `copyFileToVault` (fileOps.ts:560-575), which already
does an `'wx'` + ` (n)` loop. That function is the precedent the fix copies.

**DECISION (owner):** add a create-exclusive IPC channel `vault:create-file-text` (fs open `'wx'`) that returns a
typed `EEXIST` envelope. The seed writes loop with ` (n)` suffixes on EEXIST.

**Fix:**
1. **Main handler** — add `vault:create-file-text` to `vault.ipc.ts` next to `vault:write-file-text` (≈45 LOC →
   ~930, still under 1000). Model it on `copyFileToVault`'s reserve-then-replace:
   ```ts
   ipcMain.handle('vault:create-file-text', async (_e, vaultRoot: string, rel: string, content: string) => {
     try {
       assertActiveVault(vaultRoot);
       assertSafeRelativePath(rel, { forCreation: true });
       assertNotInFiloDir(rel);
       assertPayloadByteSize(Buffer.byteLength(content, 'utf-8'), PAYLOAD_LIMITS.MARKDOWN, 'vault:create-file-text');
       const full = join(vaultRoot, rel);
       assertWithinVault(vaultRoot, full);
       await fsPromises.mkdir(dirname(full), { recursive: true });
       let placeholder: FileHandle;
       try { placeholder = await fsPromises.open(full, 'wx'); }          // O_EXCL; case-insensitive on NTFS/APFS
       catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST')
                     return { success: false, code: 'EEXIST', error: 'file already exists' };  // no logMainError, no suppress
                   throw e; }
       await placeholder.close();
       activeWatcher?.suppress(rel, 2000);                                // only AFTER we own the name
       try { await atomicWriteFile(full, content); }                      // tmp → rename over our 0-byte placeholder
       catch (e) { await fsPromises.unlink(full).catch(() => undefined); throw e; }  // drop our placeholder only
       activeWatcher?.suppress(rel, 1000);
       return { success: true, path: full };
     } catch (err) { logMainError('vault:create-file-text', err); return { success: false, code: ipcErrorCode(err), error: String(err) }; }
   });
   ```
   `ipcErrorCode` (ipcErrorCode.ts:18) has no EEXIST mapping, so the handler returns `'EEXIST'` itself **before**
   the generic catch. Watcher suppression runs only after the `'wx'` open succeeds, so a losing attempt never
   masks a real external edit of the existing file.
2. **Everything a new channel needs to pass CI.** Each of these is enforced by a gate or test:
   - `src/shared/types.ts` `IpcChannel` union: add `| 'vault:create-file-text'` after L29. Keep any comment free of
     `'` and `;` (the `ci:ipc-parity` scan harvests quoted literals from that block).
   - `src/shared/ipcSchemas.ts`: `'vault:create-file-text': z.tuple([nonEmptyString, nonEmptyString, z.string()])`.
     `ipcPayloadSchemas.test.ts:37-41` fails if a main-registered channel has no schema.
   - `src/shared/ipcContracts.ts` `IpcChannelMap`: `{ args: [vaultRoot, relPath, content]; result: IpcSuccess<{ path: string }> }`.
     `EnvelopeChannel` (L449) derives from this automatically, so `invokeOk` accepts it.
   - `scripts/check-ipc-envelope-usage.mjs` `ENVELOPE_CHANNELS` **and** `ipcEnvelopeAllChannels.test.ts`
     `SUCCESS_DISCRIMINATED`. The test's drift-parity case scrapes the gate, so both lists must change together.
   - `scripts/check-markdown-write-gateway.mjs` `channelRe` (L66-67): widen to
     `vault:(?:write-(?:existing-)?|create-)file-text` so new direct callers need `// allow-direct-write:`.
   - `scripts/check-md-writers-reconcile-editors.mjs` `channelRe` (L95): same widening. Add the new helper module
     (step 3) to `RECONCILE_EXEMPT` with the reason "creates a brand-new .md (EEXIST otherwise — never targets an open editor)".
   - `payloadLimits.ts` L44 doc comment; `pathSecurity.ts` L257/L337 doc lists.
   - `ci:no-forcreation-on-read-delete`: the name doesn't match `/(read|delete|stat|exists)/`, so `forCreation: true` is allowed. No change.
   - `src/main/preload.ts` needs no change: `invoke` is typed on `IpcChannel` and validated through `IPC_PAYLOAD_SCHEMAS`.
   - CLAUDE.md gate count and gate list (see Gate).
3. **Renderer helper** — new `src/renderer/lib/vault/createMdExclusive.ts` (~90 LOC):
   ```ts
   export async function createUniqueMdFile(args: {
     vaultRoot: string; folder: string; baseName: string;
     buildContent: (finalTitle: string) => string;      // template body interpolates the FINAL title
     firstCandidate?: string;                           // pre-picked by nextFreeMdPath (step 4)
   }): Promise<{ relPath: string; finalTitle: string; content: string }>
   ```
   It loops over `firstCandidate`, then `base (2)`, `base (3)` … up to 100 (then throws a typed
   `NameExhaustedError`). Each attempt calls the channel through a tracking wrapper that keeps a **losing EEXIST
   attempt out of the per-path write accounting**. This matters: `trackComponentWrite` (writeStateTracking.ts:710-752)
   runs `beginWrite(path)` → `pendingVaultPaths.add`, then `markRecentSelfWrite(path)`, then on "success"
   `endWrite(true)` → `pendingVaultPaths.delete` + `failedVaultPaths.delete`. Wrapping an EEXIST attempt in it
   would erase another writer's pending or failed mark on the **user's existing file** and hide its next external
   change. So the helper does:
   - `beginWrite(vaultRoot)` with **no path** (in-flight counter + `.filo/.dirty` sentinel cover the create window);
   - `window.filo.invoke('vault:create-file-text', …)` with a manual `.success` check. That satisfies
     `ci:check-ipc-envelope-usage`'s "`.success` within 6 lines" rule; `// allow-direct-write:` sits on the line
     above the call;
   - on success: `markRecentSelfWrite(rel)` then `endWrite(vaultRoot)`;
   - on `code === 'EEXIST'`: `endWrite(vaultRoot)` (neutral), then try the next candidate;
   - on any other failure: `notifyWriteError({ kind: 'component', path: rel, error })`, then
     `markPathFailed(rel)` and `endWrite(vaultRoot, undefined, false)`, then throw an `IpcEnvelopeError`. This
     matches `trackComponentWrite`'s failure surface: toast, sticky sentinel, and the caller rolls back.
   Build candidates with the same `prefix` rules as `nextUniqueMdPath`, and check every candidate against
   `fileNameSafe` / ERR-2's stem rules.
4. **Make the pre-pick disk-aware and case-folded** (lowers how often EEXIST happens; step 3 is still the authority):
   - Change `nextUniqueMdPath(cache, folder, baseName, extraTaken: Iterable<string> = [])`. Build `taken` with
     `normalizeVaultRelative` (case-fold) from (a) each cached text def's `filePath` when present, otherwise
     `${prefix}${title}.md` (after the path cluster, `filePath` is always present), and (b) `extraTaken`. Compare
     the candidate through the same fold.
   - Add `nextFreeMdPath(folder, baseName)` in conventionPaths.ts. It passes `boardCacheStore.cache` plus
     `flattenTreePaths(vaultStore.fileTree, vaultStore.path)` (vaultTreeSort.ts:187). conventionPaths already imports `vaultStore`.
   - Point the three wrappers (kanbanTileCreation.ts:39, taskCreation.ts:42, fileDropHandler.ts:44) and the
     TaskListBoard wrapper (TaskListBoard.svelte:258-260) at `nextFreeMdPath`. The TaskListBoard edit is one line
     changed for one line, so its 2209 ceiling holds. The rename then picks a free name instead of failing with `TARGET_EXISTS`.
5. **Kanban `createTile`** (kanbanTileCreation.ts:137-186): swap the `trackComponentWrite` +
   `vault:write-file-text` block for `createUniqueMdFile({ …, buildContent: () => '' })`, then take `relPath` and
   `finalTitle` from its result **before** building `def`. On a non-EEXIST failure, `reportError` and **return
   without adding the card**. Today it adds a card whose def has no `filePath`, which breaks the path-cluster
   invariant. Keep the `filePath = relPath` assignment before `new AddCardCommand(`, because
   `ci:creation-persists-filepath` pins it.
6. **Kanban `createTileFromTemplate`** (L232-272): `buildContent: (t) => assembleMarkdownFile({ …fmWithoutBoardType, id: contentId }, interpolate(content.bodyWithoutBoardBlock, { title: t }))`,
   so a bumped name also re-interpolates `{{title}}`. Use the returned `content`'s body for `def.content` and `loadDocument`.
7. **Task creation** (taskCreation.ts). The def is deep-cloned into `AddTaskCommand` **before** the seed runs
   (the placement is persisted first, then the seed is awaited on the history chain; A9-M3 at taskCommands.ts:131-162).
   A bump inside the seed therefore has to re-stamp the def that is already cached:
   - `buildTaskDef` stays **synchronous** and keeps `filePath = relPath` inside its body.
     `ci:creation-persists-filepath`'s `extractFnBody` (check-creation-persists-filepath.mjs:88-133) explicitly
     can't parse a `Promise<{…}>` return type, so don't make it async. It gets its pre-pick from `nextFreeMdPath` (step 4).
   - Change `AddTaskCommand`'s `seedBackingFile?: () => Promise<void>` to
     `() => Promise<{ relPath: string; title: string } | void>`. In `execute()`, after the awaited seed, if the
     returned `relPath` differs from `this.def.filePath`, set `this.def = { …this.def, filePath: relPath, title }`
     (redo re-adds the bumped def) and call `boardCacheStore.persistUpdateTile(this.def.id, { filePath, title }, this.boardId)`.
     `tasklistTileOps.updateTile` (core/boardTileOps/tasklist.ts:116-127) already accepts `title` and `filePath`.
   - `seedMdFile` (L152-199) uses `createUniqueMdFile({ firstCandidate: relPath, buildContent: () => seedBody })`,
     then runs `markHydrated`, `loadDocument` and `applyChanges` on the **returned** path and returns `{ relPath, title }`.
     The three callers announce from the command's final def title, not the pre-pick.
8. **Task-List OS drop** (fileDropHandler.ts:139-168): `createUniqueMdFile({ buildContent: () => rawContent })`.
   Use the returned `relPath` for `buildTextTileDefFromMarkdownFile` and the `filePath` stamp (L190). Fix the L136
   docstring. The sidebar-drop branch (L285-320) references an existing file and writes nothing, so it's unaffected.
9. **Mind Map parity (low-risk hardening):** in `seedTextFileForNewTile.ts:69-94`, replace the `file-exists` probe
   and `write-file-text` with one `vault:create-file-text` call through the helper's single-attempt primitive.
   Treat `EEXIST` as today's "exists → adopt" branch. Semantics are unchanged; the TOCTOU window closes.
10. Once steps 5-9 land, no creation module calls `vault:write-file-text`. The remaining legitimate callers
    (restore / sentinel / `writeMarkdownAndReconcile` `create:true` / KanbanSideToolbar geometry) are unchanged.

**Gate:** new `ci:seed-writes-exclusive` (`scripts/check-seed-writes-exclusive.mjs`, the 49th guard; add it to `ci:verify`
and CLAUDE.md). It pins two things. (a) The creation modules — `lib/kanban/kanbanTileCreation.ts`,
`lib/tasklist/taskCreation.ts`, `lib/tasklist/fileDropHandler.ts`, `lib/boards/seedTextFileForNewTile.ts` — contain
**no** `invoke(Ok)?('vault:write-file-text'` call (raw-source scan with `check-markdown-write-gateway.mjs`'s
`channelRe`) and each references `createUniqueMdFile` or its single-attempt primitive. (b) `createMdExclusive.ts`
calls `'vault:create-file-text'` and never `trackComponentWrite(`. That's the EEXIST-accounting invariant in step 3.
A listed file that goes missing fails loudly. Bite-verify with a temp CWD: put a `vault:write-file-text` back into
`taskCreation.ts` → exit 1; add `trackComponentWrite(` to the helper → exit 1; faithful copy → exit 0.
Extend `ci:markdown-gateway` and `ci:md-writers-reconcile-editors` as in step 2.

**Tests:**
- `src/tests/unit/vaultCreateFileText.test.ts` (main, **real temp dir**, pattern from `atomicWriteFile.test.ts`).
  Register the handler with a fake `ipcMain` and an active vault. Cases: creates a new file (bytes exact, parents
  mkdir'd); an existing file returns `{ success:false, code:'EEXIST' }` with the existing bytes byte-identical and
  mtime unchanged; a case-only collision (`Groceries.md` exists, create `groceries.md`) returns EEXIST on
  win32/darwin (`it.skipIf(process.platform === 'linux')`); `.filo/x.md` → FORBIDDEN; `CON.md` → INVALID_FILENAME;
  a write failure after the reserve removes the placeholder (stub `atomicWriteFile` to throw) and leaves no 0-byte
  file. **Bite:** point the handler at `atomicWriteFile` without the `'wx'` open and the EEXIST case goes red.
- `src/tests/unit/seedWritesExclusive.test.ts` (renderer). An in-memory `window.filo` fake implements
  `vault:create-file-text` with **case-insensitive** EEXIST over a `Map`, and asserts `vault:write-file-text` is
  never invoked. One case per site, each with a pre-existing **off-board** file:
  (1) Kanban `createTile` with `New Card.md` present → `New Card (2).md`, original bytes intact;
  (2) delete-then-re-add card (the audit's scenario a) → `(2)`;
  (3) template card with `{{title}}` → the body carries the bumped title;
  (4) quick-add `Groceries` → `Groceries (2).md`, and `Groceries.md` is untouched;
  (5) case-only: `Groceries.md` exists **but is missing from the tree snapshot** (stale tree), quick-add
  `groceries` → the EEXIST loop bumps, and the cached def's `title` and `filePath` are re-stamped to
  `groceries (2)` (the AddTaskCommand re-stamp path, step 7);
  (6) OS drop `README.md` onto a Task List with `README.md` in the vault → `README (2).md`;
  (7) accounting: a pre-existing path that is in `failedVaultPaths` / pending stays failed / pending after a
  losing EEXIST attempt, and `markRecentSelfWrite` is not called for it;
  (8) non-EEXIST failure → the task placement rolls back (existing A9-M3 behaviour), and a Kanban card is not added.
- Update the stubs in existing creation tests (`audit8Phase3.test.ts`, `taskListFilePathPersistence.test.ts`,
  plus any other test that stubs `vault:write-file-text` for the four sites; `grep -l` shows 46 files stub the
  channel, most for other writers) to answer `vault:create-file-text`.
- `ipcEnvelopeAllChannels.test.ts` inventory entry (step 2).

**Acceptance criteria:** with `Notes.md` in the vault and on no board, quick-adding "Notes", adding a Kanban card
titled "Notes" (via rename + new), and OS-dropping a `Notes.md` all create `Notes (2).md`, and `Notes.md`'s bytes
and mtime don't change. No creation module references `vault:write-file-text`. `ci:verify` is green with 49 guards.

**Risks / interactions:**
- **EEXIST accounting** (step 3) is the subtle part. Reusing `trackComponentWrite` for the loop would clear
  pending/failed marks on the user's existing file. The new gate arm (b) pins this.
- The placeholder-then-rename briefly shows a 0-byte file under the final name. Main suppresses the path, and
  `copyFileToVault` has shipped the same pattern since Audit-12.
- `AddTaskCommand` redo reuses `this.def`. After a re-stamp, redo re-adds the bumped path, which is correct because
  the file exists there.
- File sizes: vault.ipc.ts ~930; kanbanTileCreation / taskCreation / fileDropHandler all stay under 500. No
  ceilinged file grows (TaskListBoard: one line swapped for one).
- Linux is case-sensitive, so `groceries.md` next to `Groceries.md` is a legitimate distinct file there. The
  case-fold in step 4 only affects which name is pre-picked, never correctness.

---

### 0.6 MD-4 MEDIUM (pulled into Phase 0) — DocumentEditor reloads its own content after every successful autosave, which wipes redo, breaks IME composition and re-triggers MD-3
**Phase:** 0 (moved from Phase 2 as MD-1's co-requisite) · **Depends on:** none · **Effort:** S
**Files:** `src/renderer/components/boards/DocumentEditor.svelte` onUpdate L284-292, reload `$effect` L446-463, onMount L276-314.
**Mechanism (re-verified 2026-09-23):**
- onUpdate (L284-292) never sets `lastLoadedBody`. TextTile does (L169).
- `dirtyWriters` is a `SvelteMap<string, SvelteSet>` (`document.svelte.ts:81`), so `isWriterDirty` is reactive. While the writer is dirty the effect returns at L453.
- When the gateway's `markClean(docId, callerId)` runs (`markdownFileWriter.ts:988`), the effect re-runs. `docState.body` (the user's typed md) `!== lastLoadedBody` (still the hydrate body), so L460 reloads the editor's own content: a `setContent` that today enters history (MD-1), plus a re-parse (MD-3).
- There is no composition listener, unlike TextTile L203-212.
**Fix:**
1. In onUpdate, set `lastLoadedBody = md` before `documentStore.updateContent(...)`, mirroring TextTile L169.
2. Add `let isComposing = $state(false);` and the same `compositionstart` / `compositionend` listeners on `editor.view.dom` after `createTiptapEditor` (copy TextTile L208-212). Add `if (isComposing) return;` in the reload effect, after the `isWriterDirty` check.
**Gate:** `ci:editor-body-discipline` **Arm B:** in `DocumentEditor.svelte`'s comment-stripped `onUpdate:` arrow body, require `lastLoadedBody = md`. In the reload `$effect`, require `isComposing`. Bite-verify both.
**Tests:** `src/tests/component/documentEditorSelfReload.test.ts` (T0). Mount DocumentEditor, type through `editor.commands.insertContent('x')`, advance timers past the 300 ms debounce, `settle()`, and assert:
- `loadMarkdownIntoEditor` was not re-entered, via a `vi.spyOn` on the `markdownSync` module export;
- `editor.can().redo()` survives (undo, wait for the save, redo works);
- with a `compositionstart` event dispatched, a sibling `updateContent` does not reload until `compositionend`.

Today the redo assertion fails.
**Acceptance criteria:** after an autosave, the first Ctrl+Z undoes the last edit, Ctrl+Y works after a save, and a CJK composition survives a background save.
**Risks / interactions:** a sibling view's edit is still picked up, because its `updateContent` sets `body` to a value different from this view's `lastLoadedBody`. MD-3 then applies at the same site.

---

### 0.7 MD-1 + DEP-1 HIGH (was CRITICAL) — Loading or reloading a file is recorded in ProseMirror's undo history, so Ctrl+Z empties the note or reverts a synced edit, and autosave writes the result
**Phase:** 0 · **Depends on:** MD-4 (must ship in the same change, see Risks) · **Effort:** S
**Files:** `src/renderer/lib/editor/markdownSync.ts` L166-238 (`loadMarkdownIntoEditor`; `setContent` at **L201**); `src/renderer/lib/editor/createEditor.ts` L186-199 (StarterKit keeps `undoRedo`); `src/renderer/lib/editor/emptyParagraphs.ts` L118 (already `addToHistory:false`); new `src/renderer/lib/editor/editorHistory.ts`.
**Mechanism (re-verified 2026-09-23):** `markdownSync.ts:201` calls `editor.commands.setContent(contentToLoad, { emitUpdate: emit })`. tiptap-markdown 0.9.0's override (`dist/tiptap-markdown.es.js:974`) just forwards to core `setContent` (`@tiptap/core` 3.31.3 `setContent.ts`), and that function sets only `preventUpdate`, never `addToHistory`. Every load is therefore an undoable step. That covers the hydrate loads (TextTile L264/299/321/345/408, DocumentEditor L334/401) and the reloads (TextTile L450, DocumentEditor L460). Probe result: after a load, `can().undo() === true`, and `undo()` leaves `editorMarkdown === "\n"` with `onUpdate` fired once. The onUpdate handlers (TextTile L162-185, DocumentEditor L284-292) only skip while `isUpdatingFromStore` is set, and that flag is false during a user undo. They then call `updateContent` + `scheduleMarkdownWrite`, and `buildWriteArgs` (TextTile L121-142, DocumentEditor L221-240) has no empty or reverted-body guard. The empty body is written 300 ms later. `loadMarkdownIntoEditor` is the **only** `setContent` call in `src/renderer` (grep), so it is a true chokepoint.
**Fix:**
1. In `loadMarkdownIntoEditor`, replace L201 with a chained, non-history load (verified in the probe: `can().undo() === false`, zero updates):
   ```ts
   editor.chain()
     .command(({ tr }) => { tr.setMeta('addToHistory', false); return true; })
     .setContent(contentToLoad, { emitUpdate: emit })
     .run();
   ```
   The chain shares one `tr`, so the meta covers the replace step. tiptap-markdown's override receives the same `props`.
2. Add `src/renderer/lib/editor/editorHistory.ts`:
   ```ts
   /** Drop the undo/redo stacks without emitting a transaction. Same technique TipTap's own
    *  registerPlugin uses (reconfigure + view.updateState). */
   export function resetEditorHistory(editor: Editor): void {
     if (!editor || editor.isDestroyed) return;
     const s = editor.state;
     const isHistory = (p: Plugin) => (p as unknown as { key: string }).key.startsWith('history$');
     const without = s.reconfigure({ plugins: s.plugins.filter((p) => !isHistory(p)) });
     editor.view.updateState(without.reconfigure({ plugins: s.plugins }));
   }
   ```
   Call it at the **end** of `loadMarkdownIntoEditor` (after the sentinel strip and the selection restore, before the lossy check), on every load and reload.
   **DECISION:** a full-document load is a history boundary. Undo can never cross a hydrate or a reload. This is what closes Scenario B (Ctrl+Z past an external OneDrive reload). Probe: with `addToHistory:false` alone, the pre-reload `!` event survives, remapped to a no-op, and `can().undo()` stays true. With the reset, `can().undo() === false`, typing still records history, and undo of new typing works (96 plugins intact).
3. Leave StarterKit's `undoRedo` on. Text undo is a required feature (CLAUDE.md "Undo/Redo").
**Gate:** new `ci:editor-body-discipline` (`scripts/check-editor-body-discipline.mjs`, gate 49; later items add arms to it). **Arm A (MD-1):**
- (a) on a comment-stripped `markdownSync.ts`, the `loadMarkdownIntoEditor` body must contain `setMeta('addToHistory', false)` and `resetEditorHistory(`;
- (b) no raw `.setContent(` or `commands.setContent(` anywhere in `src/renderer` outside `markdownSync.ts` (all loads go through the chokepoint). Escape: `// allow-raw-setcontent: <reason>`.

Also extend `ci:markdown-body-roundtrip` `REQUIRED_TOKENS` with `/load → undo is a no-op/`. Bite-verify each: revert the meta → test red; drop the reset → the reload test red; add a raw `editor.commands.setContent('x')` in a scratch component → gate exit 1.
**Tests:** in `src/tests/unit/markdownBodyRoundTrip.test.ts`, per fixture (same loop as "emits no update"):
- `"<name>: load → undo is a no-op"`: load, then `commands.undo()` returns false, `editorMarkdown` is unchanged, 0 updates, `undoDepth(state) === 0` (from `@tiptap/pm/history`).
- `"<name>: reload → undo cannot cross the reload"`: load body A, `insertContent('!')`, `closeHistory`, reload body B with `{ preserveSelection: true }`, then `undo()` gives B unchanged and no update.
- A positive control: after the load, type, undo, and the typed char is gone (history still works).
- Component bite in `src/tests/component/textTileUndo.test.ts` (T0): mount a TextTile, run `editor.commands.undo()` via the toolbar's active editor, `settle()`, and assert no `vault:write-existing-file-text`.

Today the first unit case fails (probe: `"\n"`, updates 1).
**Acceptance criteria:** after opening any note, Ctrl+Z inside the editor does nothing. After an external reload, Ctrl+Z never restores the pre-reload text. Typing followed by Ctrl+Z still undoes typing.
**Risks / interactions:**
- **MD-4 is a hard co-requisite.** DocumentEditor currently reloads its own content after every autosave (MD-4). With step 2's reset, every save would wipe the user's undo stack. MD-4 must land in the same change, or first.
- A clean split-pane sibling that reloads another pane's keystrokes loses its own (already-saved) undo history on each reload. That is acceptable and should be documented in the helper's docstring.
- `view.updateState` bypasses TipTap's transaction events, which is intended (no `onUpdate`, no `onTransaction`). The toolbar re-syncs on the next selection event.
- `preserveSelection` still works because `reconfigure` keeps `state.selection`.
- `markdownSync.ts` grows by about 6 LOC, well under limits.

---

### 0.8 MD-3 HIGH — Re-parsing a body-only store body strips a leading `---…---` horizontal-rule pair as frontmatter, and the truncated body is written back
**Phase:** 0 · **Depends on:** T0 (tests) · **Effort:** S-M
**Files:**
- `src/renderer/components/tiles/TextTile.svelte`: **L255** (sibling-adopt), **L296** (cached body), **L447** (reload effect). The adopt-eol sniffs at L277 and L309 read `parsed.body`.
- `src/renderer/components/boards/DocumentEditor.svelte`: **L331** (cached body), **L457** (reload effect).
- `src/renderer/lib/tasklist/taskCreation.ts` **L184** (a full-file body entering the store, see step 3).
- `src/renderer/stores/document.svelte.ts` L490-506 (the Phase 7.6 tripwire).
**Mechanism (re-verified 2026-09-23):**
- `parseMarkdownFile` (`markdownSync.ts:108`, fence regex) treats any text that starts with a `---` line and has a later `---` line as frontmatter. Probe: `parseMarkdownFile('---\n\nSome intro\n\n---\n\nMore text\n')` returns `body "\nMore text\n"`, `hasFrontmatter: true`.
- `DocumentState.body` is body-only by contract, yet these five sites re-parse it and load `parsed.body`.
- A note with real FM whose body starts with an HR keeps `docState.body = "---\n\nSome intro…"` after the disk read (probe). The next remount (TextTile L296, gated only on `hasFrontmatter`) or reload shows the truncated body, and the next write persists it. The `e.probe` component run reproduced the on-disk deletion with no typing.
- DocumentEditor L331 is subtler. It sets `lastLoadedBody = docState.body` (the raw value) but loads `parsed.body`, so the reload effect never corrects the editor and the first keystroke saves the truncated text.
- **Refinement:** for a file with **no** real frontmatter that starts with an HR pair, the disk read itself (`readMarkdownForHydrate`) classes the intro as raw FM. It round-trips verbatim through the `frontmatterDirty:false` raw passthrough (`markdownSync.ts:515`), so it is hidden but not lost. This is the same ambiguity Obsidian has and is out of scope. The **loss** requires real FM plus an HR-leading body.
**Fix:**
1. Load the store body verbatim at all five sites. Delete the `parseMarkdownFile(...)` calls and use the raw body:
   - TextTile L255-264: `const body = existing.body ?? ''; lastLoadedBody = body; … loadMarkdownIntoEditor(editor, body)`. The L277 sniff reads `body`.
   - TextTile L296-299 and L309: the same with `docState.body`.
   - TextTile L447-450: `lastLoadedBody = body ?? ''; … loadMarkdownIntoEditor(editor, body ?? '', { preserveSelection: true })`.
   - DocumentEditor L331-334 and L457-460: the same. `lastLoadedBody` and the loaded text are now the same value.
   - Update the stale "strip defensively" comments at TextTile L441-446 and DocumentEditor L454-456.
2. Remove `parseMarkdownFile` from both components' imports where it is no longer used. TextTile still needs it at L317/L404 for the embedded `tile.content` seed, which is a creation-time full-file seed and is out of scope.
3. **New finding (required so step 1 doesn't regress):** `taskCreation.ts:184` calls `loadDocument({ body: seedBody })`, and `seedBody` is a **full file** (`assembleMarkdownFile(fm, '')` or `'---\ncompleted: false\n---\n'`, L156). L185 also seeds FM, so the TextTile L296 cached branch adopts it. Today the defensive parse hides this. After step 1, a new task opened in a Document tab would render the YAML as body text and save it into the body, duplicating the FM. Change L184 to `body: ''` (the seed has no body). Grep confirmed the other `loadDocument` callers pass body-only values: `seedTextFileForNewTile` → `initialBody`, `kanbanTileCreation` → `interpolatedBody`, `TagsPopupMenu` → `parsed.body`, `tasklist/frontmatterWriter` → `vaultIndex` `content` (body-only per `vaultIndex.ts:330`), and the rest pass `''`. **Coordinate with BL-1**, which also rewrites `seedMdFile`.
4. Keep the Phase 7.6 DEV tripwire in `updateContent` as-is. It will `console.error` on a legitimate HR-pair body in DEV, which is noise and not a failure. Tests that exercise that shape `vi.spyOn(console, 'error')` so the output isn't stray stderr.
**Gate:** `ci:editor-body-discipline` **Arm C:** forbid `parseMarkdownFile\(\s*(?:existing|docState|body)\b` (i.e. re-parsing a store body) anywhere under `src/renderer`, and forbid `body:\s*seedBody` in `taskCreation.ts`. Escape: `// allow-body-reparse: <reason>`. Bite-verify by restoring L296's parse.
**Tests:**
- `src/tests/component/textTileHrBody.test.ts` (T0; the bite is the `e.probe` scenario). File `---\ntitle: x\n---\n---\n\nSome intro\n\n---\n\nMore _text_\n`. Mount, unmount, then remount and assert the editor text contains "Some intro". A DocumentEditor twin runs the cached branch plus one keystroke and asserts that the written body still contains "Some intro". Both fail today.
- Fixture `src/tests/unit/fixtures/markdown-body-roundtrip/hr-leading-body.md`, **with** a frontmatter block first. The corpus loader itself runs `parseMarkdownFile(raw).body` (L50), so the fixture must have real FM or the harness strips the rules too. It pins the editor round-trip of an HR-pair body. Add it to `REQUIRED_FIXTURES`.
- Unit: `taskCreation` seeds `documentStore` body `''` (`src/tests/unit/taskCreationSeedBodyOnly.test.ts`).
**Acceptance criteria:** a note with FM whose body opens with `---`, text, `---` survives any number of pans, remounts and saves byte-identically in its body (modulo the MD-2 normalisation, which MD-2 removes). A new task opened as a Document shows an empty body.
**Risks / interactions:**
- Any future writer that pushes a full file into `DocumentState.body` would now surface as a visible duplicated-FM bug instead of being silently masked. That is the right direction, and Arm C plus the tripwire catch it.
- KNOWN_LIMITATIONS #11 (the torn-read guard on HR-leading bodies) is unaffected.

---

### 0.9 MD-5 HIGH — TextTile sibling-adopt loads an unhydrated placeholder `DocumentState` (body `''`) into a writable editor
**Phase:** 0 · **Depends on:** MD-3 (same lines) · **Effort:** M
**Files:** `src/renderer/components/tiles/TextTile.svelte` L251-285 (adopt), L287-313 (the guarded sibling branch it should mirror), L327-357 (the disk read and `loadDocument` at L348); `src/renderer/stores/document.svelte.ts` `loadDocument` L416-445 (returns the existing entry, no overwrite). Placeholder creators with `body: ''`:
- `VaultFileItem.svelte:366`
- `DocumentEditor.svelte:167`
- `TileHeader.svelte:506`
- `TaskListBoard.svelte:731`
- `kanbanFrontmatterWriter.ts:144`
- `kanbanTileCreation.ts:163`
**Mechanism (re-verified 2026-09-23):**
- L252-264: `existing = findByFilename(relPath)` with a different docId leads to `parseMarkdownFile(existing.body ?? '')` and a load, with **no** `hasFrontmatter` / real-body guard. The L295 branch has one (audit2 2.2).
- If the sibling DocumentEditor's read failed (L373-383: `markHydrated(filename,false)` + `hydrateReadFailed`, no FM seed, placeholder body stays `''`), the adopting tile gets `hydrated=true`, `hydrateReadFailed=false` and no baseline, so `buildWriteArgs` returns args.
- The gateway's empty-FM rescue (`markdownFileWriter.ts:793-822`) re-reads disk for the FM only, so it writes the real FM plus the empty or near-empty body.
- **Second variant found while planning:** `kanbanFrontmatterWriter.openTileAsDocument` (L144) creates a placeholder under the card's **own** `contentId`, and Kanban/Task field edits can seed FM for it. `hasFrontmatter` alone is therefore not proof that a body was read.
- Also, when the tile falls through to its own disk read, L348 `loadDocument` is a no-op for an existing placeholder. The store keeps `body: ''` while the editor shows the disk body, and any later reactive re-run of the reload effect (L425-452; `body '' !== lastLoadedBody`, writer clean) loads `''` into the editor.
**Fix:**
1. Guard adopt the same way as L295: adopt `existing.body` only when `existing.body && documentStore.hasFrontmatter(existing.docId)`. That means a sibling really read disk: FM seeded **and** a non-empty body. An empty real file just falls through to a disk read, which is harmless.
2. Otherwise keep the docId unification: `boardStore.updateTile(tile.id, { contentId: existing.docId })` and `registerForceWriter(callerId, existing.docId, buildWriteArgs)`. Then **fall through** to the authoritative `readMarkdownForHydrate` path with a local `const docId = existing.docId`. Thread `docId` through L342 / L345 / L348 instead of re-reading `tile.contentId`, since the prop may not have re-derived yet. A failed read takes the existing Audit-18 H3 `hydrateReadFailed` hold (L379-396).
3. Add `documentStore.adoptDiskBodyIfPlaceholder(docId, body, htmlContent)`. It sets `body` / `htmlContent` only when the doc exists, `doc.body === ''`, `!doc.isDirty` and it has no dirty writers, without cancelling writes (unlike `applyReloadFromDisk`, which calls `cancelMarkdownWritesForDocument`). Call it after L348's `loadDocument` so an existing placeholder is upgraded to the disk body. This also lets the DocumentEditor that failed its read show the text on its reactive reload. Its `hydrateReadFailed` hold stays until Retry.
**Gate:** `ci:editor-body-discipline` **Arm D:** TextTile's comment-stripped adopt block (the text between `findByFilename(` and the next `return;`) must contain `hasFrontmatter(existing.docId)`, and `TextTile.svelte` must reference `adoptDiskBodyIfPlaceholder(`. Bite-verify by removing either.
**Tests:** `src/tests/component/textTileAdoptPlaceholder.test.ts` (T0).
- (a) Seed a placeholder with `loadDocument({ docId:'P', filename:'X.md', body:'' })` and no FM, then mount a TextTile with `contentId:'T'` for X.md. The disk read returns `'---\na: 1\n---\nReal body\n'`. Assert the editor shows "Real body", the store body for P is `"Real body\n"`, and on keystroke + flush the written bytes contain "Real body". Today the editor is empty and the write drops "Real body".
- (b) Same, but the read rejects `EBUSY`. Assert `buildWriteArgs` refuses: no write IPC after a keystroke attempt (the editor is non-editable), and the banner shows Retry.
- (c) A placeholder with FM seeded but body `''` (the Kanban variant) falls through to the disk read.
- (d) Regression: a genuine hydrated sibling (FM + body) is still adopted without a second read.
**Acceptance criteria:** no TextTile ever shows an empty editable body for a file whose content it has not read. A failed read shows the Retry banner.
**Risks / interactions:**
- An extra disk read on adopt of a not-yet-hydrated sibling. That is cheap.
- `adoptDiskBodyIfPlaceholder` must not bump `mutationVersions` (a body read isn't a user mutation). Mirror `applyReloadFromDisk`'s non-bumping body set.
- `document.svelte.ts` grows by about 15 LOC (927 → about 942, still under 1000).
- `ci:no-silent-write-abort`'s `TEXT_TILE_REQUIRED` tokens (`hydrateReadFailed = true`, `hydrateReadFailed && !lastLoadedBody`) must survive. They do.

---

### 0.10 MD-2 HIGH — TextTile's onDestroy writes the file on every unmount, even when nothing was edited (culling, LOD, board or tab switch)
**Phase:** 0 · **Depends on:** T0; lands after MD-3/MD-5 so their bites stay observable · **Effort:** M
**Files:** `src/renderer/components/tiles/TextTile.svelte` onDestroy **L454-520** (`buildWriteArgs()` at L469, `flushFinalWriteOnDestroy` at L506); `src/renderer/lib/vault/markdownFileWriter.ts` `flushFinalWriteOnDestroy` L587-590, `writeMarkdownFileImpl` L592-996 (drift gate L625-629, assemble L866-879, IPC L884-886, post-write stat/read-back L907-941, markClean L984-989), `markHydrated` L340-354, `readMarkdownForHydrate` L464-486; `src/renderer/lib/vault/fileBaselineRegistry.ts` (`FileBaseline` L63-66, `noteBaseline` L130-146, `refreshBaselineAfterWrite` L196-216).
**Mechanism (re-verified 2026-09-23):**
- onDestroy builds args and fires a final write whenever the tile is hydrated and not read-only (L469, L501-519), with no dirty check. The gateway has no identical-content skip.
- The `e.probe` mount → unmount with no typing wrote `More _text_` → `More *text*`. With a CRLF note it also yields mixed EOL (MD-10).
- Unmounts are routine: viewport culling, the LOD body switch (`TileContainer.svelte:322/344/401`), board/tab switch, and Kanban cards.
**Fix (two layers):**
1. **Component (primary):** write on destroy only when this writer actually has unsaved work.
   - Add a gateway export `hasPendingMarkdownWriteFor(callerId): boolean`, returning `writerScheduler.hasPendingTimer(a => a.callerId === callerId) || writerScheduler.hasParked(i => i.key === callerId) || inFlightWrites.has(callerId)`.
   - Add a TextTile-local `let userEdited = false;`, set to `true` in onUpdate after the `isUpdatingFromStore` check (covers tiles without a `contentId`).
   - In onDestroy, compute the condition before `buildWriteArgs()`:
     ```ts
     const hasUnsaved = userEdited && (
       !contentId || documentStore.isWriterDirty(contentId, callerId) || hasPendingMarkdownWriteFor(callerId));
     const finalArgs = hasUnsaved ? buildWriteArgs() : null;
     ```
     The rest is unchanged. When `finalArgs` is null there is no cancel and no write. The `dropDirtyWriter` at L499 stays unconditional.
   - A failed earlier write keeps the writer dirty (the gateway only markCleans on success, L984-989), so destroy still retries it.
2. **Gateway (defence in depth, identical-bytes skip).**
   **DECISION:** the skip is anchored to the **drift baseline**, so it cannot break the baseline refresh, the Keep-local overwrite or the markClean / `.filo/.dirty` lifecycle.
   - (a) Extend `FileBaseline` with `text?: string`. `noteBaseline(path, mtimeMs, size, text?)` **replaces** the entry, so any re-stamp without text drops it. External reloads (`applyReloadFromDisk` → `noteBaseline` at `document.svelte.ts` ~L883), Keep-local re-anchors and rename all end up text-less. `renameBaselinePath` carries the entry. Store text only when `utf8ByteLength(text) < MARKDOWN_READBACK_BYTE_THRESHOLD` (1 MB, `markdownFileWriter.ts:101`), which bounds memory.
   - (b) `readMarkdownForHydrate` passes `result.content` through `markHydrated(…, eol, diskText)` into `noteBaseline`. The post-write `confirmed` branch (L934-935) passes `fileText` to `refreshBaselineAfterWrite(relPath, mtime, size, fileText)`. Confirmed there means the bytes were read back equal. A large note without read-back gets no text, so it never skips.
   - (c) In `writeMarkdownFileImpl`, after assembly (L879) and before `trackComponentWrite` (L884):
     ```ts
     const base = getBaseline(relPath);
     if (base?.text !== undefined && preWriteVerifyStat &&
         !hasBaselineDrifted(base, preWriteVerifyStat) && fileText === base.text) {
       finishWriteBookkeeping(args);   // noteFrontmatterFlushedVersion + the guarded markClean (L966-989)
       return;                          // no IPC, no baseline/index change (disk is unchanged)
     }
     ```
     The skip needs the drift gate to have returned `proceed` on a **non-drifted** stat. After a Keep-local choice the stat differs from the baseline, so the write always goes through. The skip does **not** call `clearFailedPathAfterLateSuccess`: a failed mark might belong to a different pending FM change for the path, so it stays sticky until a real write lands. That is the safe direction.
   - Sentinel: a scheduled fire that returns without `trackComponentWrite` is already handled like the drift-`drop` return. `safeEndWrite` (`writeScheduler.ts:195-212`, `pending-path` mode) drops the pending path and syncs the sentinel.
   - (d) **Ceiling:** `markdownFileWriter.ts` is at 1416/1416. Extract the post-write tail (the stat + read-back + `refreshBaselineAfterWrite` block L895-941, and the index refresh + flushed-version + markClean block L942-996) into a new `src/renderer/lib/vault/markdownPostWrite.ts` exporting `confirmPostWriteBaseline(...)` and `finishWriteBookkeeping(...)`. The skip branch reuses `finishWriteBookkeeping`, so the markClean guard lives in one place. The new file makes no `markHydrated` call, so it stays outside `ci:markdown-read-gateway`'s pairing rule (read + `markHydrated`). Its `vault:read-file-text` read-back is a plain read, which that gate allows. Check `ci:reload-cancels-writes` and `ci:vault-lifecycle-coverage` still pass. Target: the gateway net-shrinks, and the ceiling is **tightened**, not bumped.
**Gate:** `ci:editor-body-discipline` **Arm E:** in TextTile's comment-stripped `onDestroy` body, `buildWriteArgs()` must be conditional. Require `isWriterDirty(` and `hasPendingMarkdownWriteFor(` in onDestroy, and forbid a bare `const finalArgs = buildWriteArgs();`. Bite-verify by restoring the unconditional line.
**Tests:**
- `src/tests/component/textTileNoPhantomWrite.test.ts` (T0; the bite is the `e.probe` result).
  - Mount → settle → unmount: zero `vault:write-*` calls.
  - Mount, type one char, unmount within 300 ms: exactly one write containing it.
  - Mount, type, let the debounce save, then unmount: no second write.
  - Mount, type, write fails (EBUSY), then unmount: one retry write.
  - LOD variant: toggle the `TileContainer` LOD prop so the body unmounts, with zero writes.
- `src/tests/unit/gatewayIdenticalBytesSkip.test.ts`:
  - hydrate → `writeMarkdownFile` with identical body: no write IPC, `markClean` fired (writer cleared), sentinel clean;
  - drifted stat plus Keep-local with identical body: the write IPC **does** fire;
  - baseline re-stamped by `applyReloadFromDisk` (text dropped): the write fires;
  - post-write confirmed: the next identical write skips;
  - a note of 1 MB or more never skips.
- Keep `postWriteBaselineToctou.test.ts` and `fileBaselineDrift.test.ts` green. Their stubs return written bytes on read-back, so they still exercise confirmation.
**Acceptance criteria:** panning, zooming out and switching boards over untouched notes produce **no** writes and no mtime change (manual check: file mtimes before and after a pan). An edited-then-culled tile still saves.
**Risks / interactions:**
- The skip compares against the last **confirmed** bytes, never the last-read editor-normalised form. An untouched note that tiptap would normalise (`_x_` → `*x*`) still is not written, because layer 1 prevents the call entirely.
- Keep-local is protected by the drift check.
- The dirty-sentinel pending path is released by the existing `safeEndWrite`.
- The in-memory `text` roughly doubles memory for hydrated notes under 1 MB. Accepted and documented in the registry docstring.
- `ci:relpath-keyed-stores-register-rename` already covers `baselines` (L135).
- MD-10 interaction: once bodies are re-CRLF'd, an untouched CRLF note assembles byte-equal and skips too.

---

### 0.11 DEP-2 HIGH — `linkify: true` turns filenames and bare domains into links, so ordinary notes open read-only and typed filenames are saved as bogus `http://` links
**Phase:** 0 · **Depends on:** none · **Effort:** S
**Files:** `src/renderer/lib/editor/createEditor.ts` `Link.configure` **L213-216**, `Markdown.configure` `linkify: true` **L254**; fixtures in `src/tests/unit/fixtures/markdown-body-roundtrip/`; `src/tests/unit/markdownBodyRoundTrip.test.ts` `LOSSY_ON_TIPTAP2` L78-85; `scripts/check-markdown-body-roundtrip.mjs` `REQUIRED_FIXTURES` L31-44.
**Mechanism (re-verified 2026-09-23):**
- Probe (current): `See Notes.md and example.com here` → `See [Notes.md](http://Notes.md) and [example.com](http://example.com) here` (lossy). `main.rs and script.py` → both linked. `a@b.co` → `mailto:` link. Bare `https://example.com` → `<https://example.com>` (lossy).
- Typing ` see Notes.md ` produced `[Notes.md](http://Notes.md)`, because Link's default `shouldAutoLink` (`link.ts` addOptions) accepts any dotted hostname.
**Fix:**
1. `Markdown.configure({ …, linkify: false })` (L254).
2. `Link.configure({ openOnClick: false, HTMLAttributes, shouldAutoLink: (url) => /^[a-z][a-z0-9+.-]*:\/\//i.test(url) })`. Only explicit-scheme URLs autolink while typing.
3. Re-baseline `links-underline.expected.md`. Byte justification: `autolink https://example.org/path` is no longer wrapped as `<https://example.org/path>`; the source text is emitted verbatim. It stays lossy because of the `<u>` re-nesting.
4. New fixture `bare-names-and-domains.md`: `See Notes.md, main.rs and script.py; visit example.com or https://example.com/x; mail a@b.co.` The expected output is the body itself, not lossy. Add it to `REQUIRED_FIXTURES`.

Verified with the patched editor over the full corpus: only `links-underline` (this item), `link-schemes` (UX-2) and `task-lists` (UX-7) change output. Every other fixture is byte-identical to its current baseline.
**Gate:** `ci:markdown-body-roundtrip`: add `bare-names-and-domains.md` to `REQUIRED_FIXTURES`. The fixture's not-lossy assertion is the behavioural pin. Bite-verify by reverting `linkify` → the fixture test goes red.
**Tests:**
- The corpus (LF, CRLF, fixed point, verdict).
- New cases in `markdownBodyRoundTrip.test.ts`: `"typing a filename does not autolink"` (insert ` see Notes.md ` → no `](http`), and `"typing an explicit https URL still autolinks"` (→ `<https://example.com>`, probe-confirmed).
**Acceptance criteria:** notes that mention filenames, domains or emails open editable and round-trip unchanged. Typed filenames stay plain text.
**Risks / interactions:** bare URLs already on disk are no longer rendered as clickable links (they round-trip as plain text). Accepted: an open-format file keeps its bytes, and users can wrap a URL as `<url>` or `[t](url)`. Typing next to a bare URL can still autolink it once whitespace follows (scheme present). Mention both in the KNOWN_LIMITATIONS #17 entry.

---

### 0.12 UX-2 + DEP-4 + MD-8 MEDIUM — `filo://` internal links can't be inserted (setLink silently returns false), and notes that contain one open read-only
**Phase:** 2, **recommended to ship with DEP-2 in Phase 0** (same file, same fixture re-baseline, and it is UX-1 step 5c) · **Depends on:** none · **Effort:** S
**Files:** `src/renderer/lib/editor/createEditor.ts` L213-216; `src/renderer/components/layout/TextFormattingToolbar.svelte` `applyLink` **L101-111**; `src/renderer/lib/editor/toolbarConfig.ts` `setLink` **L218-224**; `src/renderer/schema/link.ts` `isFiloLink` L122; `link-schemes.expected.md`.
**Mechanism (re-verified 2026-09-23):**
- `@tiptap/extension-link` 3.31.3 `isAllowedUri` (`link.ts:176-212`) allows only http/https/ftp/ftps/mailto/tel/callto/sms/cid/xmpp plus the `protocols` option, and it gates `setLink`, `parseHTML` and paste.
- Probe: `setLink({ href: 'filo://board/abc123def456' })` returns false and changes nothing. `See [b](filo://…) now` → `See b now` (lossy).
- `applyLink` and `setLink` ignore `.run()`'s boolean.
**Fix:**
1. Use `Link.configure({ …, isAllowedUri: (url, ctx) => isFiloLink(url) || ctx.defaultValidate(url) })`.
   **DECISION:** use a custom `isAllowedUri`, **not** `protocols: ['filo']`. `protocols` calls linkifyjs `registerCustomProtocol` in `onCreate`, and Link's `onDestroy` calls linkifyjs `reset()` **globally**. Every TextTile unmount would wipe the registration for all other editors and log "already initialized" warnings. Probe: with `isAllowedUri`, setLink returns true → `[hello](filo://board/abc123def456) world`; `javascript:alert(1)` is still refused.
2. `applyLink` / `toolbarConfig.setLink`: `const ok = …run(); if (!ok) uiStore.toast("That link couldn't be added. Use https://, mailto: or a filo:// link.", 'error')`.
3. Re-baseline `link-schemes.expected.md` to `Internal [board link](filo://board/abc123def456) and [spot](filo://position/abc123def456/10/20).\n\nWiki style \[\[Some Note\]\] stays text.` Byte justification: the link marks now survive. The file stays lossy only because of `[[wiki]]` escaping, so its entry in `LOSSY_ON_TIPTAP2` stays but the comment changes.
4. New fixture `filo-links.md` (filo links only) that is **not** lossy. Add it to `REQUIRED_FIXTURES`.
**Gate:** `ci:markdown-body-roundtrip` `REQUIRED_FIXTURES` += `filo-links.md`. Bite: revert `isAllowedUri` → the fixture reads lossy and goes red.
**Tests:**
- The fixtures above.
- `src/tests/unit/filoLinkInsert.test.ts`: the real editor, select text, `setLink({ href: 'filo://board/<12-char id>' })` returns true, and `editorMarkdown` contains `](filo://`. A `javascript:` href returns false.
- A `toolbarConfig.setLink` failure path calls `uiStore.toast`.
**Acceptance criteria:** Insert Link accepts `filo://board/<id>` and AppShell's click handler (`AppShell.svelte:505-516`) navigates. Notes containing `filo://` links open editable. An invalid scheme shows a toast.
**Risks / interactions:** markdown-it's `validateLink` accepts `filo:`. The security surface is unchanged: `AppShell` routes `filo://` to `linksStore`, and other schemes still go through the `media:open-external` allowlist.

---

### 0.13 UX-7 LOW — Filo writes checklists as loose lists, which other editors render with extra spacing
**Phase:** 2, **recommended alongside DEP-2** (UX-1 step 5b) · **Depends on:** none · **Effort:** S
**Files:** `src/renderer/lib/editor/createEditor.ts` (extensions list L185-260); `node_modules/tiptap-markdown/src/extensions/tiptap/tight-lists.js` (`listTypes: ['bulletList','orderedList']`, not configurable from `Markdown.configure`); `task-lists.expected.md`; `markdownBodyRoundTrip.test.ts` `LOSSY_ON_TIPTAP2`.
**Mechanism (re-verified 2026-09-23):**
- tiptap-markdown's `taskList` serializer reuses `renderList`.
- prosemirror-markdown's `renderList` reads `node.attrs.tight`. `taskList` has no `tight` attribute (`MarkdownTightLists` only covers bullet and ordered lists), so it falls back to the serializer default (loose).
- Probe: `- [ ] a\n- [ ] b` → `- [ ] a\n\n- [ ] b`.
**Fix:** add a tiny Filo extension in `createEditor.ts` (or `lib/editor/taskListTight.ts`):
```ts
Extension.create({ name: 'filoTaskListTight', addGlobalAttributes: () => [{ types: ['taskList'],
  attributes: { tight: { default: true,
    parseHTML: (el) => el.getAttribute('data-tight') === 'true' || !el.querySelector('p'),
    renderHTML: (a) => ({ 'data-tight': a.tight ? 'true' : null }) } } }] })
```
Probe results:
- a tight source round-trips tight;
- `task-list-loose` stays loose (unchanged);
- a new checklist typed in Filo serialises `- [ ] milk\n- [ ] eggs`;
- `task-lists` becomes byte-identical to its body minus the trailing newline, and **not lossy**.
Re-baseline `task-lists.expected.md` to `Shopping:\n\n- [ ] milk\n- [x] eggs\n- [ ] bread\n  - [ ] rye\n  - [x] sourdough\n\nDone.` Byte justification: the blank lines between items are removed and nothing else changes. Remove `'task-lists'` from `LOSSY_ON_TIPTAP2` and update its comment.
**Gate:** none new. The existing `ci:markdown-body-roundtrip` corpus (`task-lists.md` and `task-list-loose.md` are both already REQUIRED or in the corpus) pins both directions.
**Tests:** the corpus. Add `"a new checklist created in the editor serialises tight"` (toggleTaskList + two items).
**Acceptance criteria:** checklists written by Filo are tight. Tight checklists from Obsidian or GitHub open editable. Loose ones stay loose.
**Risks / interactions:** existing loose checklists previously written by Filo stay loose, because the parse detects `<p>`. That is correct preservation.

---

### 0.14 UX-1 + MD-7 HIGH — Lossy "read-only" mode disables saving but not editing, so typed text is silently discarded
**Phase:** 0 · **Depends on:** DEP-2 / UX-2 / UX-7 for the false-positive step (step 5) · **Effort:** M
**Files:**
- `src/renderer/components/tiles/TextTile.svelte`: `readOnly` L526, close-drain effect **L528-541**, banner L573-578, `takeOwnership` L550-561, `buildWriteArgs` refusal L129.
- `src/renderer/components/boards/DocumentEditor.svelte`: `readOnly` L466, effect **L468-479**, banner L524-529, `takeOwnership` L488-499, refusal L228.
- `src/renderer/lib/editor/toolbarConfig.ts` (20 `activeEditor?.chain()` call sites, `setLink` L218-224); `src/renderer/components/layout/TextFormattingToolbar.svelte` `applyLink` / `removeLink` L101-122; `src/renderer/lib/editor/markdownSync.ts` `normaliseForRoundTripCompare` L256-304; `KNOWN_LIMITATIONS.md`.
**Mechanism (re-verified 2026-09-23):**
- The effects at TextTile L535-541 and DocumentEditor L473-479 toggle editability only for `closeDrainGate.draining`. `readOnly` drives only the banner. The comment at TextTile L529-531 says so explicitly.
- `buildWriteArgs` returns null for a read-only doc, so typing updates `documentStore` / `tile.content` and never reaches disk. Tab close finds nothing pending and closes with no prompt.
- Probe: these are all flagged lossy:
  - hard-wrapped paragraph
  - GFM table with a `|---|` delimiter
  - bare URL
  - tight task list
  - two-line blockquote
  - `1. 1.` list
  - `[[wiki]]`
  - `a < b & c`
  - a tab character
  - HTML comment
  - `See Notes.md` / `example.com` / `a@b.co` (DEP-2)
  - `[b](filo://…)` (UX-2)
**Fix:**
1. **DECISION: a note flagged lossy is truly NON-EDITABLE.** Fold `readOnly` into both editability effects:
   ```ts
   $effect(() => {
     const frozen = closeDrainGate.draining || readOnly;
     if (!hydrateReadFailed) untrack(() => setEditorEditable(editor, !frozen));
   });
   ```
   `readOnly` is `$derived` from `documentStore.isReadOnly` (reactive via `readOnlyVersion`), so Take ownership re-enables the editor automatically. Rewrite the L529-531 comment.
2. **Programmatic edits:** a non-editable editor still accepts TipTap commands. In `toolbarConfig.ts`, route every mutating command through a private `chainIfEditable()` that returns `null` when `!activeEditor?.isEditable`. In `TextFormattingToolbar.svelte`, `applyLink` / `removeLink` bail when `!editor.isEditable`. This also closes the same hole during a close-drain freeze.
3. **Banner and single action (DECISION):** both components show one non-dismissable banner with one button.
   - Banner copy: "Filo can't save this file without changing formatting it doesn't support, so it's open read-only." Button: **Take ownership**. Keep `role="status"` and the existing classes.
   - Keep the existing confirm, but reword its body: "Filo will be able to edit and save this file, but formatting it can't preserve (for example hard-wrapped lines, callouts, wiki links, comments) will be rewritten or removed on the next save. Continue?"
   - `documentStore.takeOwnership` (L482-484) is unchanged. It clears read-only, the effect re-enables editing, and the next edit writes.
   - There is no other action and no dismiss.
4. **Mid-session flip (the MD-7 scenario):** a reload that flags lossy runs only when this writer is clean (reload effect gate), so there is no unsaved text in this view. A dirty sibling view's already-armed write keeps its captured args. With editing now blocked, nothing new can be typed into a doc that can't be saved. No close prompt is needed (the owner chose non-editable over a prompt).
5. **Reduce false positives where cheap (DECISION, a separate step):**
   - (a) DEP-2 (`linkify:false` + scheme-only autolink) removes filenames, domains, emails and bare URLs from the lossy set (probe: all four now round-trip byte-exact).
   - (b) UX-7 (tight task lists) removes tight checklists.
   - (c) UX-2 (`filo://`) removes internal links.
   - (d) In `normaliseForRoundTripCompare`, canonicalise GFM table **spacing only**. On lines that start with `|`, strip spaces around `|`, and collapse a delimiter cell `:?-+:?` to `:?---:?` **keeping the colons**. Probe: tiptap drops alignment (`:--` → `---`), so an aligned table must stay lossy and must not be masked.
   - (e) Normalise the ordered-list delimiter `1)` → `1.`. Probe: `1) a` → `1. a`, cosmetic; the start number survives (`3. a` → `3. a`).
   - Do **not** normalise soft-wrap joins, blockquote joins, `<`/`&` entities, tabs, wiki-escapes or HTML comments. Those are real byte or semantic changes that the serializer can't preserve cheaply; they stay read-only.
   - Add a KNOWN_LIMITATIONS entry "#17 Lossy notes open read-only" that lists them and the Take-ownership trade-off.
**Gate:** `ci:editor-body-discipline` **Arm F:** in both components, the editability `$effect` body must contain `readOnly` alongside `closeDrainGate.draining`, and `toolbarConfig.ts` must contain `isEditable`. Bite-verify by removing `|| readOnly` in either file.
**Tests:**
- `src/tests/component/lossyReadOnlyNotEditable.test.ts` (T0). Mount a TextTile and a DocumentEditor on a hard-wrapped note. Assert:
  - `editor.isEditable === false` and the banner button is present;
  - `tiptapToolbar.toggleBold()` changes nothing and there is no `updateContent`;
  - after `documentStore.takeOwnership(docId)` and `settle()`, `isEditable === true`, and one keystroke produces a write.

  Today `isEditable` is true (bite).
- `src/tests/unit/markdownSync.test.ts`: new `isLossyMarkdownRoundTrip` cases:
  - `|a|b|\n|---|---|` vs `| a | b |\n| --- | --- |`: not lossy;
  - `|:-|` vs `| --- |`: still lossy;
  - `1) a` vs `1. a`: not lossy;
  - soft wrap: still lossy.
- `markdownBodyRoundTrip` fixture changes are covered under DEP-2 / UX-7.
**Acceptance criteria:** a lossy note can't be typed into, formatted or linked. The banner offers exactly one action. After Take ownership, edits save. Filename-, URL-, checklist- and plain-table-bearing notes open editable.
**Risks / interactions:**
- Users with many hard-wrapped notes see more read-only banners in practice, not fewer, because the behaviour is now honest. KNOWN_LIMITATIONS explains why.
- `setEditorEditable` is non-emitting (`setEditorEditable.ts`), and `editorSetEditableDiscipline.test.ts` still passes.
- The `hydrateReadFailed` hold still wins.
- TextTile's "Take ownership" confirm copy changes, so update any test that matches the old copy (grep `Take ownership of this file`).

---


---

## Phase 1 — Cloud-sync hardening (OneDrive / Dropbox)

#### Re-verification summary

| ID(s) | Audit verdict | Re-verified status | Severity (this plan) |
|---|---|---|---|
| ERR-3 + GAP-1 + EXT-7 | ✅ / dup / dup | **Mechanism CONFIRMED. Stated trigger PARTLY REFUTED:** OneDrive, Dropbox and iCloud put their suffix before the **last** extension, so a conflict copy of `Plan.board.json` is `Plan.board-HOST.json` (or `Plan.board (… conflicted copy …).json`, or `Plan.board 2.json`). `scanBoardFiles` never sees those names. The realistic sync outcome is therefore EXT-7's corollary: **a fork that is invisible.** The first-wins hijack remains reachable by any copy that keeps the compound `.board.json` suffix and sorts before the original. | MEDIUM |
| EXT-2 | ◐ | **CONFIRMED (code path).** Microsoft documents the trigger shape: the local copy is renamed with the device name and the online version downloads under the original name. | MEDIUM |
| EXT-1 | ◐ | **CONFIRMED.** A probe on this machine, using Node `fs.watch` with `recursive` on Windows 11, emitted only `rename Projects` and `rename Work` for a folder rename. No child events were emitted. | MEDIUM |
| EXT-5 + ERR-9 | ◐ | **CONFIRMED (code).** It isn't verified how often sync clients hold rename-blocking locks. | MEDIUM |
| ERR-4 | ✅ | **CONFIRMED** | MEDIUM |
| EXT-3 | ◐ | **CONFIRMED (code path).** The Reload twin has the mirror bug. | MEDIUM |
| EXT-4 | ✅ | **CONFIRMED** | MEDIUM |
| UX-6 | ✅ | **CONFIRMED** (no backup; stale "persistent" comments). The 15 s cap itself is deliberate (Audit5 R3). | LOW→MEDIUM for sync users |
| ERR-7 | ✅ | **CONFIRMED.** Probe: `Buffer([52 e9 75 6e 69 6f 6e]).toString('utf-8')` → `"R�union"`. | MEDIUM |
| EXT-6 + ERR-8 | ◐ | **Sentinels CONFIRMED.** This also includes the *sequential* case (A crashes, B opens, B's Dismiss deletes A's breadcrumb), not only concurrent use. The config-seeding sub-claim is PLAUSIBLE, and its "overwrites" half is refuted (see the refuted section). | LOW→MEDIUM |
| EXT-8 | ◐ | **CONFIRMED, and wider than reported.** The **main-side** watcher suppression also drops the event, and `tags:save` is a blind whole-file overwrite with no pre-write merge. | LOW |

#### Cross-cutting constraints (they apply to every item below)

- **File-size ratchet (`ci:file-sizes`):** `writeScheduler.ts` is at **exactly 1000** LOC, which is the limit and not allowlisted, so **any net +1 fails**. `vault.svelte.ts` sits at its 1867 ceiling. `boardCache.svelte.ts` sits at its 1009 ceiling. `markdownFileWriter.ts` sits at its 1416 ceiling. `fileWatcher.ts` is at 994 (6 lines of headroom). New logic goes in **new modules**, and those three files may only shrink or stay net-zero. No ceiling bumps (CLAUDE.md: split, don't bump).
- **Vault-identity discipline (`ci:reconciler-vault-guard`):** every new renderer module that reads the live vault path and then `await`s must `captureVaultIdentity()` / `isStillSameVault()` after each await. New files are added to the gate's Part 1 scan list (or its Part 3 pinned list when they take a captured-identity param).
- **New IPC channels:** each needs an `IpcChannel` union entry (`src/shared/types.ts`), a Zod tuple (`src/shared/ipcSchemas.ts`), a contract (`src/shared/ipcContracts.ts`) and a handler (`ci:ipc-parity`). Envelope-returning ones also go in `ENVELOPE_CHANNELS` (`scripts/check-ipc-envelope-usage.mjs:37`). Pure main→renderer events go in `MAIN_TO_RENDERER_EVENTS` (`scripts/check-ipc-parity.mjs:33`) **and** `RECEIVE_CHANNELS` (`src/shared/types.ts`, the preload allowlist from Audit-15 P3.3). Union comments must avoid `'` and `;` (Audit-5 lesson).
- **Phase-0 dependencies:** **BL-1** (create-exclusive `vault:create-file-text`, `'wx'`) is used by EXT-3. **ERR-1** (board double-encode) changes the `board:load` payload that ERR-4 re-envelopes. **UX-1/MD-7** (a real non-editable read-only mode) is reused by ERR-7.

### 1.1 C0 (infrastructure for ERR-3 / EXT-2 / EXT-7) — shared conflict-copy detector
**Phase:** 1 · **Status:** new infrastructure · **Depends on:** none · **Effort:** S
**Files:** new `src/shared/conflictCopy.ts`; new `src/tests/unit/conflictCopy.test.ts`; consumers `src/main/vault/boardFileOps.ts:84-90`, `src/main/services/renameCorrelation.ts:305-398`, `src/renderer/lib/boards/boardLoader.ts:755-777`.
**Mechanism (re-verified 2026-09-23):** `grep -ri "conflict" src/main src/renderer src/shared` finds no filename-pattern logic. Nothing in Filo recognises sync-client conflict names.

**DECISION:** one pure module lives in **`src/shared/conflictCopy.ts`**. It has no Node or DOM imports, and both main (scan and correlation) and the renderer (loader tie-break and toasts) import it. This replaces the suggested `lib/vault/conflictCopy.ts` plus a main twin, because two copies of the regex table would drift.

**Researched naming schemes** (sources at the end):

| Client | Documented shape | Example for `Note.md` | Example for `Plan.board.json` | Strength |
|---|---|---|---|---|
| OneDrive (personal/business, non-Office files) | the local copy gets `-<DEVICE NAME>` appended before the extension, and the online version keeps the original name | `Note-DESKTOP-1A2B3C4.md`, `Note-JOHNS-SURFACE.md` | `Plan.board-DESKTOP-1A2B3C4.json` | **strong only when `<DEVICE NAME>` is a KNOWN host** (see below); otherwise ambiguous (`Meeting-Notes.md`, `Plan-B.md`) |
| Dropbox | `<name> (<user>'s conflicted copy YYYY-MM-DD).<ext>` on the **last-saved** version; also `(conflicted copy YYYY-MM-DD HHMMSS)`, `(Case Conflict)`, `(Selective Sync Conflict)` | `Note (Andrew's conflicted copy 2026-09-23).md` | `Plan.board (Andrew's conflicted copy 2026-09-23).json` | strong |
| Google Drive for desktop | ` (1)`, ` (2)` appended; some reports also show a Dropbox-style "conflicted copy" | `Note (1).md` | `Plan.board (1).json` | **weak**, since users pick `Report (2).md` themselves |
| iCloud Drive | a bounced name with space + number: `abc.txt` → `abc 2.txt` → `abc 3.txt` | `Note 2.md` | `Plan.board 2.json` | **weak**, since users pick `Chapter 2.md` |
| Syncthing / Nextcloud (free extras) | `.sync-conflict-YYYYMMDD-HHMMSS-<DEVID>` / `(conflicted copy YYYY-MM-DD HHMMSS)` | `Note.sync-conflict-20260923-101112-ABCDEFG.md` | — | strong |

**Fix:**
1. Export a single pure API:
   ```ts
   export type ConflictStrength = 'strong' | 'weak';
   export interface ConflictMatch { strength: ConflictStrength; client: 'onedrive'|'dropbox'|'gdrive'|'icloud'|'syncthing'; canonicalName: string; }
   /** basename in, canonical basename out; `knownHosts` = OneDrive device names seen for this vault. */
   export function detectConflictCopy(basename: string, opts?: { knownHosts?: readonly string[] }): ConflictMatch | null;
   /** Strips a conflict suffix from a FULL rel path (dir preserved). */
   export function canonicalPathFor(relPath: string, opts?): string | null;
   ```
   The split is always on the **last** extension, with a board carve-out: for `*.board<suffix>.json`, the canonical name is `*.board.json`.
2. Pattern table, all anchored immediately before the final extension and all case-insensitive except the host rule:
   - Dropbox/Nextcloud (strong): `/ \((?:[^()]*'s )?conflicted copy(?: \d{4}-\d{2}-\d{2})?(?: \d{6})?\)$/i`, `/ \((?:Case|Selective Sync) Conflict\)$/i`.
   - Syncthing (strong): `/\.sync-conflict-\d{8}-\d{6}-[A-Z0-9]{7}$/`.
   - OneDrive (strong): `-(<knownHost>)(?:-\d+)?$`, where the host is regex-escaped and matched case-insensitively. Also strong: the **Windows default-hostname** shape `/-(?:DESKTOP|LAPTOP)-[A-Z0-9]{7}$/` (case-sensitive uppercase), which no user plausibly types. An arbitrary `-WORD` suffix is **never** matched.
   - Google Drive (weak): `/ \(\d{1,3}\)$/`. iCloud (weak): `/ \d{1,3}$/`.
3. **False-positive policy (DECISION):** a **weak** match counts as a conflict copy **only when its canonical sibling path exists** (the caller passes an `exists(canonicalRel)` probe or a tree set). It is never counted on its name alone. So `Report (2).md` with no `Report.md` beside it is a normal file, and `Chapter 2.md` next to `Chapter.md` is at worst *eligible*. Consumers treat a weak-plus-sibling match only as a **tie-break preference** or **correlation refusal**, and never as grounds to delete, hide or rename anything.
4. **Known hosts:** main writes `.filo/machines/<machineId>.json` = `{ hostname, firstSeen }` once per machine on vault open (see EXT-6, where the machine id is minted). `knownHosts` is the union of `os.hostname()` and every `hostname` in `.filo/machines/*.json`. Each machine owns its own file, so this registry never sync-conflicts.

**Gate:** none new. C0 is pure and covered by the table-driven tests below. Its consumers get the gates listed in their own sections.
**Tests:** `src/tests/unit/conflictCopy.test.ts`:
- a positive row for every client example above (both `.md` and `.board<sfx>.json`);
- **negative rows:** `Report (2).md` (weak with no sibling → null when the probe says absent), `Chapter 2.md`, `Meeting-Notes.md`, `Plan-B.md`, `Q3-2024.md`, `my-LAPTOP-notes.md`, `Notes - Copy.md`, `Plan (2).board.json` with no sibling, and `DESKTOP-1A2B3C4.md` (a bare host as the whole name);
- known-host matching is case-insensitive and hyphen-safe (`JOHNS-SURFACE`);
- `canonicalPathFor('A/B/Plan.board-DESKTOP-1A2B3C4.json') === 'A/B/Plan.board.json'`.
**Acceptance criteria:** every documented scheme is recognised. No row in the negative corpus matches. The module has zero imports.
**Risks / interactions:** localized Dropbox strings (for example German "Kopie mit Konflikt") are not covered, so a localized copy would be treated as a normal file (the status quo). Recording this is a KNOWN_LIMITATIONS note. `src/shared` is bundled into both processes, so the file must stay dependency-free (the `check-untrusted-sink-discipline` / `ci:ipc-parity` conventions don't apply).

---

### 1.2 UX-6 LOW (MEDIUM on a synced vault) — Decision toasts vanish after 15 s, and "Keep local" overwrites the other device's edit with no backup
**Phase:** 1 · **Status:** CONFIRMED (no backup; stale "persistent" docs). The cap is deliberate (not a bug). · **Depends on:** none (EXT-3/EXT-4/ERR-3/EXT-2 consume it) · **Effort:** M
**Files:** `src/renderer/stores/ui.svelte.ts:143-155` (`TOAST_MAX_LIFETIME_MS` + the Audit5 R3 rationale), `:360-424` (cap eviction + lifetime); Keep-local sites: `vaultExternalPrompts.ts:231-248` (Keep all), `:559-571` (`promptModifiedFile`), `:678-686` (`promptMarkdownPendingWriteConflict`), `:783` (`promptPropertiesPopupModified`), `:848` (`promptDeletedFile`); `src/renderer/stores/document.svelte.ts:816-829`; `src/renderer/stores/vaultExternalReconcilers.ts:222-234` ("Keep your edits"); promise-backed: `vaultExternalDriftPrompts.ts:90-180` (`promptExternalEditOnSync`), `:294-345` (`promptBoardExternalEdit`); consumers `src/renderer/lib/vault/preWriteDriftGate.ts:73-110`, `src/renderer/lib/boards/boardWriteScheduler.ts:350-378`, `src/renderer/stores/boardCache.svelte.ts:~965-972`; stale comments `vaultExternalDriftPrompts.ts:83` ("Persistent toast … user MUST choose") and `ui.svelte.ts:151` (says the promise toasts resolve 'keep-local' on dismiss; they resolve **'defer'** since 6.4.M4).
**Mechanism (re-verified 2026-09-23):**
1. `pushToast` maps `duration:0` on any non-error toast to 15 s (:412-424).
2. **Audit5 R3's reasons** (ui.svelte.ts:145-154, :361-368): (i) a re-firing conflict prompt must not blanket the screen, and (ii) a promise-backed toast (the two drift prompts that block a write and resolve only via action/onDismiss) must never strand its promise and hang flush or quit.
3. Every Keep-local path writes local bytes over the externally changed file (`forceWriteForDocument`, or a drift-gate `'keep-local'` → proceed), and **no path copies the external bytes anywhere first**.

**Fix:**
1. **Sticky, the R3-compatible way.** Add `sticky?: boolean` and `dedupeKey?: string` to the toast options.
   - A `sticky` toast gets no lifetime timer.
   - **DECISION:** `sticky` is **refused (ignored, with a dev `console.warn`) when `onDismiss` is set.** Promise-backed drift toasts therefore keep the 15 s cap → `'defer'` (R3 reason ii preserved; a deferred write keeps the dirty state and re-prompts on the next write).
   - A `dedupeKey` **replaces** any existing toast with the same key: the old one is dismissed silently, and it has no onDismiss by the rule above (R3 reason i).
   - The 8-toast cap still applies, and sticky toasts are non-disposable, so disposable ones evict first.
   Mark sticky + deduped: `promptModifiedFile` (`'ext-mod:'+rel`), `promptMarkdownPendingWriteConflict`, `promptPropertiesPopupModified`, `promptDeletedFile` (`'ext-deleted:'+rel`), `promptBulkExternalChanges` (`'ext-bulk'`), `promptBoardChangedExternally` (`'board-mod:'+rel`), `document.svelte.ts` handleExternalChange (`'ext-mod:'+filename`, the same key so it doesn't double up with the vaultExternalPrompts one), the EXT-4 prompts, and the new sync-conflict toasts (ERR-3/EXT-2).
2. **Backup before any Keep-local overwrite.** New module `src/renderer/lib/vault/keepLocalBackup.ts`:
   ```ts
   /** Snapshots the CURRENT disk bytes of `rel` to .filo/recovery/ before a Keep-local overwrite.
    *  Deduped per (rel, mtimeMs, size) so the handler + the drift gate don't double-snapshot. */
   export async function backupExternalVersion(vaultRoot: string, rel: string): Promise<{ ok: true; path?: string } | { ok: false; reason: string }>
   ```
   It uses `vault:stat` then `invokeOk('recovery:snapshot', vaultRoot, rel)` (byte-exact read then atomic write, recoverySnapshot.ts:171-240). ENOENT → `{ok:true}` (nothing to back up). **DECISION:** any other failure (locked, >25 MB `RECOVERY_SNAPSHOT_TOO_LARGE`) **blocks** the overwrite behind a danger confirm: *"Filo couldn't back up the other version of X (reason). Overwrite it anyway?"*. Cancel → `'defer'`. Call sites:
   (a) `runPreWriteDriftGate`: right after `choice === 'keep-local'` and the unchanged re-stat, before `return { action:'proceed' }` (preWriteDriftGate.ts:~101). This chokepoint covers `promptExternalEditOnSync` and every forced write that re-enters the gate;
   (b) `boardWriteScheduler.ts` `'keep-local'` fallthrough (~:376) and `boardCache.svelte.ts` ~:970. boardCache is at its 1009 ceiling, so fold that site into a one-line call to a helper in `boardWriteScheduler.ts` (net 0 in boardCache);
   (c) the non-gate handlers (`promptModifiedFile`, document.svelte.ts:816, bulk Keep all, `promptPropertiesPopupModified`, `promptMarkdownPendingWriteConflict`, "Keep your edits") `await backupExternalVersion` **before** `markDirty`/`forceWriteForDocument`. `forceWriteForDocument` may bypass the gate when the baseline was re-anchored, so the handler-level call is load-bearing, and the dedup makes the second call free.
3. The confirmation toast names the location: *`Kept your version of "X". The other version is saved in .filo/recovery/2026-09-23T10-02-11.123/Notes__X.md.`* (info, 8 s, `acknowledgeOnly` not needed).
4. Fix the stale comments (vaultExternalDriftPrompts.ts:83, ui.svelte.ts:151 → `'defer'`), and fix the design doc's *General Features › Toast Notifications* to state the sticky/deduped vs promise-capped split.

**Gate:** **new `ci:keep-local-backup`** (`scripts/check-keep-local-backup.mjs`). It scans `src/renderer/**` (string-preserving, comment-stripped) for every toast action object whose `label` is `'Keep local'`, `'Keep all'` or `'Keep your edits'`, plus every `choice === 'keep-local'` / `case 'keep-local'` branch in `preWriteDriftGate.ts`, `boardWriteScheduler.ts` and `boardCache.svelte.ts`. It REQUIRES `backupExternalVersion(` within the handler body or branch (brace-matched). Escape: `// allow-keep-local-no-backup: <reason>`. `MIN_SITES` tripwire = 9. Bite-verify: delete one call → exit 1. Also extend `uiStoreToasts.test.ts` rather than gating `sticky`.
**Tests:**
- `keepLocalBackup.test.ts`: **bite:** the drift gate resolves keep-local → `recovery:snapshot` invoked with `rel` **before** `vault:write-existing-file-text` (the call-order assertion fails today); ENOENT → proceeds without a snapshot; snapshot EBUSY → confirm, and cancel → throws deferred (`markPathFailed`); a dedup call → one snapshot;
- `uiStoreToasts.test.ts`: a sticky toast survives 60 s of fake time; sticky + onDismiss → still auto-dismisses at 15 s (R3); the same dedupeKey replaces; the cap evicts disposable before sticky.
**Acceptance criteria:** every Keep-local overwrite leaves the overwritten external bytes in `.filo/recovery/` or requires an explicit "overwrite without backup". Decision toasts stay until acted on, never stack more than one per file, and never strand a write.
**Risks / interactions:** snapshot retention (`pruneOldSnapshotsForBasename`, 20 per basename, plus the global cap) means a chatty conflict loop can rotate old backups out. That is acceptable, and the recovery browser lists them. The 25 MB snapshot cap means big notes get the confirm path. `.filo/recovery/` itself syncs, which is actually desirable here (the backup reaches both machines). Coordinate the `ci:reconciler-vault-guard` scan of `vaultExternalPrompts.ts`: the new awaits happen before store mutation, so add an `isStillSameVault` check after `await backupExternalVersion` in each handler that then mutates stores.

---

### 1.3 EXT-4 MEDIUM — "Mark broken refs" actually deletes placements on every board (the copy says "closed boards")
**Phase:** 1 · **Status:** CONFIRMED · **Depends on:** none · **Effort:** S
**Files:** `src/renderer/stores/vaultExternalPrompts.ts:402-455` (`promptClosedBoardFileMissing`: label :424, text :419, `cascadeDeleteByVaultPath` :441, `dropFile` :446); the doc-comment at :402-409; the cascade `findCascadeDeleteTargets` (vault-wide); the history target at `groupAndBoardCommands.ts` (`CascadeDeleteCommand`, filed on the globally active board's stack per `commitExecute`).
**Mechanism (re-verified 2026-09-23):** the action labelled **"Mark broken refs"** runs `boardStore.cascadeDeleteByVaultPath(rel, {}, vaultRoot)`, which removes every placement, connection and style ref for `rel` across **all** boards, open ones included. It then runs `fileTagsStore.dropFile(rel)`. The click-time probe (:431-437) skips it only if the **same** path exists again, so a move to a new path (the EXT-1/EXT-2 timing on a synced vault) still cascades. Undo lands on the globally active board's stack (Audit-4 P3 learning), so it is often out of reach.

**Fix:**
1. The **default does nothing.** Replace the two actions with **"Keep tiles (show as missing)"** (primary: a no-op, leaving the existing `boardRefIntegrityStore` broken-ref badge as the signal) and **"Remove N tiles from boards…"** (secondary).
2. "Remove …" opens `uiStore.openConfirm({ title: 'Remove tiles for a missing file?', body: 'This removes N tiles and their connections from K boards: <board names>. The file itself is already missing. Undo is available on the board that is active when you confirm.', confirmLabel: 'Remove tiles', danger: true })`. The existing probe and cascade run only on confirm.
3. Fix the text: *`"X.md" is missing from the vault (deleted or moved outside Filo). N tiles on K boards now show as missing.`* Compute K from `findCascadeDeleteTargets` at toast time, not "closed boards".
4. Apply the same treatment to `promptExternalAttachmentDeleted` (:66-121, "Remove references"), which gets the confirm and the board list (the label is already honest).
5. The toast becomes sticky (UX-6) with `dedupeKey: 'missing:'+rel`, and is dismissed if `rel` reappears.

**Gate:** none new. Justification: this is UX copy plus a confirm. The behavioural test pins that the default path performs no mutation.
**Tests:** `src/tests/unit/closedBoardMissingPrompt.test.ts`:
- **bite:** invoke action index 0 → `cascadeDeleteByVaultPath` not called and `dropFile` not called (today index 0 cascades);
- "Remove…" → confirm → the cascade runs, and cancel → no cascade;
- the text names the board count.
**Acceptance criteria:** no single click on a sync-triggered toast removes tiles.
**Risks / interactions:** `ci:reconciler-vault-guard` scans this file, and the handler `await`s the probe with a param-threaded `vaultRoot`. Keep the existing shape. The design doc's external-delete text needs updating.

---

### 1.4 EXT-5 + ERR-9 MEDIUM — A lock retry of about 310 ms, no re-fire of failed writes, stray `.tmp` files in the synced vault, and no retry on `renameItem`
**Phase:** 1 · **Status:** CONFIRMED (code); lock-duration frequency unverified · **Depends on:** none (EXT-1 and ERR-4 consume step 3) · **Effort:** L
**Files:** `src/main/vault/filenameUtils.ts:177-264` (`atomicWriteFile`, `RETRY_DELAYS_MS=[10,20,40,80,160]` at :233), `:266-313` (tmp preservation + `recordPreservedEmergencyFile`), `:315-354` (dir-fsync retry); `src/main/vault/fileOps.ts:312-370` (`renameItem`; the case-only path has `CASE_RENAME_RETRY_DELAYS`, and the plain `fs.rename` at :370-371 retries only on EXDEV); `src/renderer/lib/boards/writeScheduler.ts:128` (`failures` Set of ids only), `:735-900` (`flushAll` re-fires `pending` only); `src/renderer/lib/vault/handleFlushAndQuit.ts:14-16,78` + `src/renderer/App.svelte:86-104` ("Stay open and retry" only rewinds the quit); `src/main/ipc/board.ipc.ts:211-223` (suppress 2000 / 1000); `src/main/services/emergencyFileRegistry.ts`; `src/main/services/quitFailureBreadcrumb.ts:40-60`.
**Mechanism (re-verified 2026-09-23):**
1. After a successful tmp write and fsync, the rename loop retries only EPERM/EBUSY/EACCES, for about 310 ms in total (:233-264). On exhaustion the tmp is kept as `<file>.<12 hex>.tmp` next to the target (:283-299), inside the synced folder. The tree (fileOps.ts:152) and watcher (fileWatcherClassify.ts:39) hide it, the sync client uploads it, and nothing ever sweeps it.
2. The scheduler keeps only failure **ids**. The `getArgs` closure of the failed fire is gone, and `flushAll` re-fires only `pending`.
3. The quit dialog's "Stay open and retry" sends `app:cancel-quit`. No write is re-issued. The next quit's `save()` finds nothing pending, so the edit exists only in memory (lost at exit) and in the `.tmp` (breadcrumb only).
4. `renameItem`'s normal path (fileOps.ts:370) fails immediately on EPERM, which Windows returns for a directory rename while OneDrive or Explorer holds a child handle. `runRename` then reverts.

**Fix:**
1. **Shared, time-bounded Windows lock backoff.** Add to `filenameUtils.ts`:
   ```ts
   export const WIN_LOCK_CODES = new Set(['EPERM','EBUSY','EACCES']);
   export const WIN_LOCK_BUDGET_MS = process.platform === 'win32' ? 5000 : 310;
   export async function retryOnWindowsLock<T>(op: () => Promise<T>, opts?: { budgetMs?: number; beforeAttempt?: () => Promise<void> }): Promise<T>
   ```
   It uses an exponential schedule 10, 20, 40, 80, 160, 320, 640, then 1000 ms (capped), until **elapsed ≥ budget** (time-based, not count-based), for about 5 s on win32. **DECISION:** win32 only. Other platforms keep the existing ~310 ms, so a POSIX `EACCES` (a real permission error) doesn't stall for 5 s. `beforeAttempt` carries the Audit-7 L7 `expectExisting` re-check (:245-251) so it still runs on **every** attempt. Replace the loop at :233-264 with `retryOnWindowsLock(() => fs.rename(tmpPath, filePath), { beforeAttempt })`. Leave the dir-fsync loop (:315-354) at its short schedule, since it is best-effort.
2. **`renameItem`**: wrap the plain `fs.rename` at fileOps.ts:370 in `retryOnWindowsLock` (the EXDEV branch runs only after the lock retry, on its own code). Replace `CASE_RENAME_RETRY_DELAYS` in the case-only path with the same helper so there's one policy.
3. **Retain and re-fire failed writes** (the scheduler is at exactly 1000 LOC, so **split first**): move the failure-attribution bookkeeping (`failures` Set add/delete/consume, `__failuresSizeForTests`, and the new retention map) into a new `src/renderer/lib/boards/writeSchedulerFailures.ts` factory used by `createWriteScheduler`. Keep the tokens `ci:awaited-writes-bounded` pins (`Promise.race`, `WRITE_TIMEOUT`, `drainPriorInFlight(key)`, `drainPriorInFlight(entry.key)`, `clearFailedPathAfterLateSuccess`, `writeGenByPath`) in `writeScheduler.ts`. Then:
   - on a performWrite rejection whose code (the `IpcEnvelopeError.code` / errno, or `WRITE_TIMEOUT`) is in **`RETAINABLE = {EPERM, EBUSY, EACCES, EAGAIN, ENOSPC, EIO, BOARD_PATH_HELD, WRITE_TIMEOUT}`**, store `retained.set(key, getArgs)`. **DECISION:** user-deferred failures (drift-gate `'defer'` / budget exhaustion, preWriteDriftGate.ts:77-86,113-117) and validation errors are **not** retained. Re-firing them would re-prompt during a quit drain;
   - a new `schedule(key, …)` clears `retained.get(key)` (the newer args supersede it), and so does a success for that key;
   - `flushAll()` first moves every retained entry into `pending` (one re-fire per flushAll), then proceeds as today. `ci:awaited-writes-bounded`'s H1 pre-drain applies unchanged;
   - export `retryFailed(key?)`, which moves retained entries to pending and fires. `writeStateTracking` gets `retryAllFailedWrites()`, which fans out to all five schedulers (board, markdown gateway, frontmatter, config, misc).
4. **A real Retry.** `writeErrorToast.ts`'s save-failed toast gets a **Retry** action → `retryAllFailedWrites()`. In `handleFlushAndQuit.ts`, rename "Stay open and retry" to **"Retry now"**: it calls `retryAllFailedWrites()`, then `save()` again. On success it proceeds to `app:ready-to-quit`, and on failure it re-shows the confirm, keeping "Quit anyway" and a third option **"Stay open"** (the old cancel semantics). The heartbeat (`DRAIN_HEARTBEAT_MS`) must beat during the retry.
5. **Watcher suppression covers the longer rename:** in every `suppress(rel, 2000)` pre-call (board.ipc.ts:221, tags.ipc.ts:101, media.ipc.ts:183, templates.ipc.ts:120/165/196, vault.ipc.ts:254/272/350, export.ipc.ts:124), use `WIN_LOCK_BUDGET_MS + 2000`. The post-write re-suppress stays.
6. **Orphan tmp sweep on vault open** in a new `src/main/services/orphanTmpSweep.ts`, invoked by main at the end of `vault:watch` start (after the watcher is live, so the moves are suppressed) or by a new envelope channel `vault:sweep-orphan-tmp` the renderer calls **after** `readQuitFailureBreadcrumb` has been surfaced. The sweep:
   - walks the vault, skipping `.filo/`, `.git`, `node_modules`;
   - matches `/\.[0-9a-f]{12}\.tmp$/` and `/\.case-rename-\d{10,}$/`;
   - **only** touches files older than 10 min (mtime), to spare another process's or machine's in-flight write, that aren't listed in any `.filo/quit-failure*.json` breadcrumb (all machines), and that aren't in this process's `listPreservedEmergencyFiles()`;
   - moves each with `fs.rename` (same volume) to `.filo/recovery/orphan-tmp/<ISO ts>/<flattened target rel>` + `.recovered`, where the target rel has the nonce and `.tmp` stripped and the suffix keeps it out of the tree and index;
   - returns `{ moved: Array<{from,to}> }`.
   One info toast follows: *`Filo moved 3 leftover temporary save files into .filo/recovery/orphan-tmp/. They may hold unsaved edits from an earlier failed save.`* An `EPERM` on a move is skipped silently (retried next open). **DECISION:** move, never delete. Writing the tmp outside the synced folder was rejected, because a cross-volume rename isn't atomic.

**Gate:** extend `ci:awaited-writes-bounded` with one arm. It REQUIRES that `filenameUtils.ts` define `retryOnWindowsLock` with an **elapsed-time** bound (`Date.now()`/`performance.now()` compared against `budgetMs`), and that `atomicWriteFile` and `renameItem` (function-scoped, string/comment-blanked) each call `retryOnWindowsLock(`. It also FORBIDS a re-introduced `RETRY_DELAYS_MS` literal array in `atomicWriteFile`. Bite: remove either call → exit 1. **New gate `ci:failed-write-refire`** (`scripts/check-failed-write-refire.mjs`) pins that `writeScheduler.ts`'s `flushAll` body references the retention drain (`drainRetained(` or similar) and that `writeSchedulerFailures.ts` defines `RETAINABLE` **without** the drift-defer marker. Bite-verify both.
**Tests:**
- `atomicWriteFileLockBudget.test.ts` (fake timers; `fs.rename` stubbed to EPERM for 3 s, then OK): win32 → succeeds, with no preserved tmp (**bite:** fails today after 310 ms); EPERM for 6 s → throws with `preservedTmpPath`; `expectExisting` still aborts mid-backoff;
- `renameItemLockRetry.test.ts`: EBUSY ×3 then OK → resolves (**bite**);
- `writeSchedulerRetainedRefire.test.ts`: a fire rejects `EPERM`, then `flushAll()` re-invokes the same `getArgs` and resolves `ok` (**bite:** today it resolves with nothing re-fired); a drift-`defer` failure is NOT re-fired; a newer `schedule` supersedes the retained args;
- `handleFlushAndQuit.test.ts`: add "Retry now → retryAllFailedWrites → save ok → ready-to-quit";
- `orphanTmpSweep.test.ts` (temp dir): an old nonce tmp is moved, a young one is kept, a breadcrumb-listed one is kept, and a user file `notes.tmp` (no nonce) is kept.
**Acceptance criteria:** a 3 s OneDrive rename lock produces no "Save failed". A failed write re-fires on Retry and on the quit drain. No `*.<12hex>.tmp` older than 10 min survives a vault open outside `.filo/recovery/`.
**Risks / interactions:**
- KL#4 (quit flush under a 5 s ceiling): the heartbeat re-arms main's timer, but a drain of N serialised locked writes can take up to N×5 s. `QUIT_DRAIN_DEADLINE_MS` (60 s) still bounds it. Update KL#4's text.
- KL#5 (self-write window on slow disk): a write that lands after 4 s of backoff can have its watcher echo miss the renderer's `isRecentSelfWrite` window. The md/board reconcilers' baseline-divergence tie-break (Audit-13 M4 / Audit-15 P2.4) absorbs it, and `writeSchedulerRetainedRefire` has a case for it. Update KL#5.
- `WRITE_TIMEOUT_MS` (60 s, boardWriteDebounce.ts:42) stays well above 5 s.
- The `ci:file-sizes` split is **mandatory** before touching writeScheduler.
- The breadcrumb's absolute `preservedPath` is machine-specific (see EXT-6).

---

### 1.5 ERR-4 MEDIUM — `board:load` returns `null` for every error, so a lock or offline placeholder reads as "not-found" and the board is gone for the session
**Phase:** 1 · **Status:** CONFIRMED · **Depends on:** ERR-1 (payload shape); EXT-5 step 1 (`WIN_LOCK_CODES`) · **Effort:** M
**Files:** `src/main/ipc/board.ipc.ts:166-190`; `src/main/vault/boardFileOps.ts:21-24` (`loadBoardFile`); `src/shared/ipcContracts.ts:206-209` (`result: string | null`); `src/renderer/lib/boards/boardLoader.ts:399-406` (`!raw` → `'not-found'`), `:338-351` (`LoadBoardError`), `:735-752` (the failedBoards toast); `src/main/vault/configOps.ts:257-267` (`readConfigWithTransientRetry`, the precedent); callers `boardCache.svelte.ts:524`, `vaultExternalReconcilers.ts:171`.
**Mechanism (re-verified 2026-09-23):**
1. `board:load` returns `null` for three cases: too-large (:178-179), any read or parse error (:187-189), and also ENOENT.
2. `loadBoard` maps `!raw` to `error:'not-found'` (:404-406). `loadAllBoards` toasts *"couldn't load X: not-found"* and skips the board.
3. Unlike configs (one 500 ms transient retry), boards get no retry. An online-only OneDrive placeholder while offline (EIO / `ERROR_CLOUD_FILE_*` → EIO/EACCES in libuv), or a brief lock, looks like a deleted board for the whole session.

**Fix:**
1. **Envelope.** `board:load` returns `IpcSuccess<{ data: unknown }> | { success:false; code: 'ENOENT'|'LOCKED'|'OFFLINE'|'TOO_LARGE'|'PARSE'|'IO'; error: string }`. The mapping: ENOENT → `ENOENT`; `WIN_LOCK_CODES` → `LOCKED`; `EIO`/`ETIMEDOUT` and a Windows cloud-file error → `OFFLINE`; oversize → `TOO_LARGE`; `SyntaxError` → `PARSE`; else `IO`. Main applies `retryOnWindowsLock` (EXT-5 step 1) around the read, with a smaller **1500 ms** budget at load: one board shouldn't stall the vault open for 5 s. Update `ipcContracts.ts:206`, add `'board:load'` to `ENVELOPE_CHANNELS`, and route renderer reads through `invokeOk`.
2. **Renderer mapping** in `loadBoard`: extend `LoadBoardError['error']` with `'locked' | 'offline' | 'too-large'`, and map `ENOENT` → `'not-found'`, `PARSE` → `'parse-error'`. User messages: *"Plan.board.json is locked by another program (OneDrive/antivirus). [Retry]"*, *"… is online-only and this PC is offline. [Retry]"*.
3. **Retry affordance:** `failedBoards` entries with a transient `errorKind` (`locked`/`offline`/`io-error`) get a sticky toast with **Retry** → `adoptBoardAtRuntime(relPath, captured)` (the EXT-1 module). The same happens in the sidebar: double-clicking such a board calls `adoptBoardAtRuntime`. Also, `vaultCandidate` must **not** snapshot transient failures into `.filo/recovery/` (vaultCandidate.ts:298-306 currently snapshots every failed board, and a snapshot of a locked or offline file fails or hydrates the placeholder). Snapshot only `parse-error`/`schema-invalid`/`from-future`/`no-migration-path`/`duplicate-board-id`/`sync-conflict-copy`.
4. `reloadBoardFromDisk` (vaultExternalReconcilers.ts:171-185): name the code in its toast (*"couldn't be applied: file is locked — Filo's copy is unchanged; it will retry on the next change"*).

**Gate:** none new. The `ENVELOPE_CHANNELS` addition makes `ci:ipc-envelope-usage` enforce `invokeOk` at every `board:load` call site (bite: a bare `window.filo.invoke('board:load', …)` → exit 1).
**Tests:**
- `boardLoadEnvelope.test.ts` (main, `fs` injected): EBUSY ×2 then OK → success (**bite**); a persistent EBUSY → `LOCKED`; EIO → `OFFLINE`; oversize → `TOO_LARGE`;
- `boardLoader.test.ts`: `LOCKED` → `errorKind:'locked'`, no recovery snapshot invoked, Retry → adopted.
**Acceptance criteria:** a transiently locked board loads after the retry. A board that still can't load shows an accurate reason and a working Retry without reopening the vault.
**Risks / interactions:** this changes a bare channel into an envelope, so every call site and test stub (`window.filo.invoke` mocks returning a string) must change, and `test:unit:strict` will flag missing mocks. Coordinate with ERR-1, which changes what `data` holds: accept both a legacy double-encoded string and an object. `ci:filo-read-guard`'s sweep notes that `board:load` delegates its read to `loadBoardFile`, so keep the read primitive in the helper.

---

### 1.6 EXT-1 MEDIUM — An external folder rename evicts open boards (discarding the pending edit) and they are never rediscovered in the session
**Phase:** 1 · **Status:** CONFIRMED · **Depends on:** EXT-5 step 3 (retained failed writes) and ERR-4 (shared `adoptBoardAtRuntime`) · **Effort:** L
**Files:** `src/renderer/stores/vault.svelte.ts:1577-1612` (eviction loop in `refreshTreeAndCleanup`); `src/renderer/stores/board.svelte.ts:589-596` (`cleanupMissingBoard`); `src/renderer/stores/boardCache.svelte.ts:722-739` (`removeBoardFromCache` → `cancelBoardWrite`); `src/renderer/stores/vaultExternalReconcilers.ts:117-119` (`findBoardIdForPath` null → return); `src/renderer/components/sidebar/VaultFileItem.svelte:340-351` ("reopen the vault"); `src/main/services/renameCorrelation.ts:236` (`tree` skipped); `src/main/ipc/vault.ipc.ts:521-530` (`vault:reconcile`); `src/renderer/lib/boards/boardWriteScheduler.ts:91-104,222,385` (the `boardsBeingDeleted` hold precedent).
**Mechanism (re-verified 2026-09-23):**
1. **Probe:** Node `fs.watch(root,{recursive:true})` on Windows 11, then `renameSync('Projects','Work')` → events `["rename Projects","rename Work"]` only.
2. `classifyChange` returns `'tree'` for extension-less paths (fileWatcherClassify.ts:146), and `correlateRenames` skips `'tree'` (:236), so no rename is synthesised live.
3. `vault:tree-updated` → `refreshTreeAndCleanup`: the board path isn't in the tree, `vault:file-exists` confirms it is missing (:1593-1598), and it isn't an in-app rename (:1609), so `cleanupMissingBoard` runs. `removeBoardFromCache` drops `paths`/`cache`/`project.boards`, calls `cancelBoardWrite(boardId)` (the pending debounce is discarded with no snapshot), and closes the tabs.
4. Within 30 s the reconcile walk diffs its snapshot and pairs `Projects/Plan.board.json → Work/Plan.board.json` (same basename and bytes). By then `renameBoardPath` finds no entry, so it does nothing.
5. There's no runtime board discovery: `board:list` is called only at load (boardLoader.ts:723), the reconciler ignores untracked `.board.json` (vaultExternalReconcilers.ts:117-119), and the sidebar says "reopen the vault" (VaultFileItem.svelte:350).
6. The same eviction happens for a sync-applied cross-machine board move when the delete and create arrive more than 1 s apart.

**Fix:**
1. **Provisional-missing state, in a new module** `src/renderer/stores/boardProvisionalMissing.ts` (vault.svelte.ts is at its ceiling). Replace the direct `boardStore.cleanupMissingBoard(boardId)` at vault.svelte.ts:1610 with `markBoardProvisionallyMissing(boardId, relPath, captured)`. This is net ≤ 0 LOC in vault.svelte.ts: the moved comment block shrinks. The function:
   a. **holds** the board's writes: `holdBoardPath(relPath)` in `boardWriteScheduler.ts` (540 LOC, headroom OK) mirrors `boardsBeingDeleted`, but `writeBoardFile` **throws** a typed `BoardPathHeldError` (code `BOARD_PATH_HELD`) instead of returning. So the write is recorded as failed (the sentinel stays dirty) and, through EXT-5 step 3, its args are **retained** rather than dropped. `writeErrorToast.ts` filters `BOARD_PATH_HELD` so the user sees no "Save failed". This stops a pending write from resurrecting `Projects/Plan.board.json` (`board:save` is a creating channel with `ensureDir`, board.ipc.ts:219-222);
   b. fires `vault:reconcile` (not awaited inside the rename queue, which would deadlock with the rename events it synthesises), then enqueues a deferred re-check on the **rename queue** after the reconcile promise settles, plus a 2 s grace timer;
   c. on re-check: `isStillSameVault(captured)`. If `boardStore.paths[boardId]` has been rebound (the reconcile rename ran `renameBoardPath`), `releaseBoardPath(old)` and `retryFailedBoardWrite(boardId)` re-fire the retained write to the **new** path (the `getWriteArgs` closure reads the path at fire time). Otherwise it re-probes `vault:file-exists`: if the file is back, release; if it's still missing, go to step d;
   d. **still missing, no pending or retained write:** `cleanupMissingBoard` as today. **Pending or retained write:** show a sticky prompt *`Board "Plan" was moved or deleted outside Filo while it had unsaved changes. [Save at original location] [Discard changes]`*. "Save" releases the hold and re-fires, recreating the file. "Discard" runs `cleanupMissingBoard`. Dismissing keeps the hold (the edit stays in memory; the next vault close's drain surfaces it through the save-failed quit path).
2. **Runtime discovery**, in a new module `src/renderer/stores/boardDiscovery.ts`, with `adoptBoardAtRuntime(relPath, captured): Promise<'adopted'|'duplicate'|'failed'>`. It loads via `loadBoard`, checks `isStillSameVault`, applies the ERR-3 tie-break against `boardStore.cache` (a duplicate id → the ERR-3 toast, no adopt), then composes `boardCacheStore.replaceCache` / `replacePaths`, pushes into `project.boards`, and merges connections/frames the same way `vaultCandidate` does. Callers:
   (a) `reconcileBoardJsonChange` when `findBoardIdForPath` is null (vaultExternalReconcilers.ts:118): replace the silent `return` with `await adoptBoardAtRuntime(rel, captured)` for a **create/modify of a real file** (probe first);
   (b) `refreshTreeAndCleanup`: after the eviction loop, adopt any tree `.board.json` not present in `boardStore.paths` (debounced; at most one in flight);
   (c) the sidebar double-click (VaultFileItem.svelte:349-351): call `adoptBoardAtRuntime`, then open the tab. The toast becomes a fallback only on `'failed'`.
3. Delete the "reopen the vault" string once (c) lands.

**Gate:** extend `ci:reconciler-vault-guard`. Add `src/renderer/stores/boardDiscovery.ts` and `src/renderer/stores/boardProvisionalMissing.ts` to the **Part 3 pinned list** (scripts/check-reconciler-vault-guard.mjs:475-478), with names `['adoptBoardAtRuntime']` and `['recheckProvisionalBoard']`, because both take a captured identity param that Part 1 can't see. Bite-verify by deleting the `isStillSameVault` → exit 1. No `ci:awaited-writes-bounded` arm is needed: `BOARD_PATH_HELD` is a synchronous throw, not an await.
**Tests:** `src/tests/unit/boardProvisionalMissing.test.ts`:
- **bite:** a board with a pending write, then a tree-updated with its path missing, then a reconcile rename to `Work/Plan.board.json` → the board is still in `project.boards`, `paths[id]==='Work/Plan.board.json'`, the retained write fires to the new path, and **no** `board:save` for the old path ever fires (fails today: evicted + cancelled);
- genuinely deleted with no pending write → evicted after the re-check;
- deleted with a pending write → the prompt appears and "Discard" evicts;
- a vault swap during the re-check → bail.
`src/tests/unit/boardDiscovery.test.ts`:
- an untracked `.board.json` create event → adopted and openable;
- a duplicate id → not adopted and the ERR-3 toast is shown;
- a swap mid-load → no injection.
**Acceptance criteria:** renaming a folder that holds an open, just-edited board in Explorer loses no edit, and the board stays open at its new path within about 1–30 s. A `.board.json` that appears mid-session (sync, copy) becomes openable without reopening the vault.
**Risks / interactions:** Audit-18 M2's `isRenameInFlight()` defer stays in front. Audit-16 3.6's stat probe stays. Holding writes keeps `.filo/.dirty` dirty during the window (intended). The `vault:reconcile` throttle (`RECONCILE_THROTTLE_MS`, vault.ipc.ts:524) can return `skipped`, so the 2 s grace timer is the fallback. `boardCache.svelte.ts` (1009 ceiling) must not grow: discovery composes public methods only. Runtime adoption must run `boardRefIntegrityStore` over the new board (broken-ref detection) and `backfill`/`prune` flags must be honoured the same way `vaultCandidate` marks them dirty. The ci:no-silent-write-abort sweep covers `lib/boards/*Scheduler*`, and a `BOARD_PATH_HELD` throw is the loud shape, not a bare return.

---

### 1.7 ERR-3 + GAP-1 + EXT-7 MEDIUM — Duplicate board id: first file in code-unit order wins, and conflict forks of a `.board.json` are invisible
**Phase:** 1 · **Status:** Mechanism CONFIRMED. Trigger re-assessed (hijack by documented sync names REFUTED, invisible-fork CONFIRMED). · **Depends on:** C0; ERR-1 (loader payload shape) · **Effort:** M
**Files:** `src/main/vault/boardFileOps.ts:84-90` (`scanBoardFiles` → `results.sort()`), `:92-120` (`scanDir`); `src/renderer/lib/boards/boardLoader.ts:382-430` (`loadBoard`, with `preStat` at :392-397), `:723-777` (`loadAllBoards`, duplicate branch :766-777); `src/renderer/lib/vault/vaultCandidate.ts:279-306` (the failed-board snapshot loop); `src/main/ipc/board.ipc.ts:146-154` (`board:list`).
**Mechanism (re-verified 2026-09-23):**
1. `scanBoardFiles` returns `results.sort()` (boardFileOps.ts:88), which is UTF-16 code-unit order, so `' '` (0x20) and `'-'` (0x2D) sort before `'.'` (0x2E).
2. `loadAllBoards` loads the files sequentially in that order (boardLoader.ts:735-736). At :766 the **first** file holding a given `board.id` becomes `cache[id]`/`paths[id]`. Every later file goes to `failedBoards` with a toast telling the user to "give it a new id or remove the copy" (:770-775), and gets snapshotted (vaultCandidate.ts:298-306).
3. **Trigger reality check:** OneDrive, Dropbox and iCloud insert their suffix before the **final** extension, giving `Plan.board-HOST.json`, `Plan.board (… conflicted copy …).json` and `Plan.board 2.json`. `scanDir` keeps only names that end in `.board.json` (case-folded, Audit-15 P6.2), so **these copies are never listed**. The diverged edits sit on disk with no warning (EXT-7's corollary). This is the realistic cloud outcome.
4. The hijack itself still happens for any id-duplicating copy that keeps the compound suffix and sorts first: `Plan (1).board.json` (from a tool treating `.board.json` as the extension, or restore software) and `Plan - Copy.board.json`. The canonical file then goes to `failedBoards`, and every save goes into the copy.

**Fix:**
1. **Tie-break by name and freshness, not scan order.** In `loadAllBoards`, collect all successful loads first as `{relPath, data, mtimeMs}`, then group by `data.board.id`. `mtimeMs` is threaded out of `loadBoard` by adding `mtimeMs?: number` to `LoadBoardResult`, taken from the bracketed `preStat` at :394. Within a group, rank each entry:
   (a) basename has no C0 match (strong, or weak-with-sibling), i.e. canonical, first;
   (b) then basename equals `sanitizeFilename(board.name) + '.board.json'`;
   (c) then newest `mtimeMs`;
   (d) then the existing code-unit order as the final deterministic tie-break.
   The winner populates `cache`/`paths`/connections/frames. Losers go to `failedBoards` with a new `errorKind: 'sync-conflict-copy'` when C0 matched, otherwise keep `'duplicate-board-id'`. The Audit 1.2 contract ("survivor never polluted by the loser's connections/frames") must be preserved: merge only the winner's.
2. **Neutral toast** (replaces boardLoader.ts:770-775): *`Two board files use the same id: "Plan.board.json" (loaded, edited 23 Sep 10:02) and "Plan (1).board.json" (not loaded, edited 22 Sep 18:40). Both files are unchanged on disk; a copy of the unloaded one is in .filo/recovery/. To keep the other version, open it in a text editor, or rename it and give it a new "id".`* The toast must never say "remove the copy" and never name which one is a "duplicate".
3. **Surface invisible forks (EXT-7).** In `scanDir` (main), also collect names matching `/\.board.+\.json$/i` that C0 identifies as a conflict copy of an existing `*.board.json`. Return them from a **new** envelope channel `board:list-conflicts` → `IpcSuccess<{ copies: Array<{ copyPath: string; canonicalPath: string; client: string }> }>` rather than changing `board:list`'s bare `string[]` contract. After the vault opens, `vaultCandidate` shows one sticky "Sync conflict" toast (via the UX-6 sticky mechanism) per canonical board: *`OneDrive kept a conflicting copy of "Plan": Plan.board-DESKTOP-1A2B3C4.json. Filo is using Plan.board.json. [Show in folder] [Dismiss]`*. `Show in folder` reuses `shell` reveal. No automatic merge (DECISION: comparing two board JSONs is a Phase-later feature and out of scope).
4. The live watcher raises the same notice: `fileWatcherClassify` already classifies `Plan.board-HOST.json` as `'tree'`. Rather than adding lines to `fileWatcher.ts` (994 LOC), the notice is emitted from the new `src/main/services/syncConflictNotifier.ts` (shared with EXT-2), which the watcher calls through one hook line. It sends the main→renderer event `vault:sync-conflict` `{ copyPath, canonicalPath, client }`.

**Gate:** extend `ci:board-path-casefold` (scripts/check-board-path-casefold.mjs) with an arm that function-scopes `loadAllBoards` (string/comment-blanked) and **REQUIRES** `detectConflictCopy(` + `mtimeMs`, and **FORBIDS** the old first-wins shape `hasOwnProperty.call(cache, data.board.id)` (bite-verify by restoring the old guard → exit 1).
**Tests:** `src/tests/unit/boardLoaderConflictTieBreak.test.ts`:
- **bite:** `Plan (1).board.json` plus `Plan.board.json` with the same id, where the copy sorts first → `paths[id] === 'Plan.board.json'` (fails on today's code);
- `Plan - Copy.board.json` (older mtime) loses to `Plan.board.json`;
- two non-conflict names with the same id → the newer mtime wins and the toast names both paths;
- the loser's connections/frames are not merged.
Main: `scanBoardConflicts.test.ts`: a temp dir containing `Plan.board.json` and `Plan.board-DESKTOP-1A2B3C4.json` → `board:list-conflicts` lists the pair, and `board:list` still returns only the canonical file.
**Acceptance criteria:** a canonical board always wins over a copy with the same id. No toast tells the user to delete a file. A OneDrive/Dropbox fork of a board raises a visible notice within 1 s (live) or at open.
**Risks / interactions:** `board:list-conflicts` is an envelope channel, so it needs `ENVELOPE_CHANNELS`, `ci:ipc-parity`, the Zod tuple and `assertActiveVault`. `vault:sync-conflict` needs `MAIN_TO_RENDERER_EVENTS` + `RECEIVE_CHANNELS`. `boardLoader.ts` is 840 LOC, and the added grouping (~40 LOC) keeps it under 1000. `vaultCandidate`'s snapshot loop must also snapshot `sync-conflict-copy` losers. ERR-1 must land first so `loadBoard`'s payload parsing is stable.

---

### 1.8 EXT-2 MEDIUM — A cross-basename rename is correlated onto a sync conflict copy, rebinding every tile, editor and tag to the losing file
**Phase:** 1 · **Status:** CONFIRMED (code path) · **Depends on:** C0 · **Effort:** S
**Files:** `src/main/services/renameCorrelation.ts:236-248` (bucketing), `:251-270` (same-basename pass), `:305-398` (cross-basename pass, pairing at :394); `src/main/services/fileWatcher.ts:941` (the `correlateRenames` call); renderer consumer `runExternalRenameCascade` (vaultExternalChanges / vault.svelte.ts rename queue).
**Mechanism (re-verified 2026-09-23):**
1. OneDrive documents the conflict shape: the local file is **renamed** to `Note-<DEVICE>.md` with identical bytes, and the online version is downloaded as `Note.md`.
2. If the download lands after the watcher batch closes (`maxDebounceWaitMs = 1000`, fileWatcher.ts:99), the batch contains `Note.md` (missing, because `relPathExists` is evaluated against live disk at :321) and `Note-DESKTOP-A.md` (present).
3. The two basenames differ, so the same-basename pass skips the pair. The cross-basename pass (:305-398) sees one missing and one present with equal size ≥ 256 B (:318), the same extension (:347-352) and an equal SHA-1 (:374-380, missing-side hash from `lastKnownHashes`). It pushes the rename (:394).
4. The renderer's rename cascade then rebinds tiles, `DocumentState.filename` and tags.json membership to the conflict copy and flushes the boards. When `Note.md` (the other machine's edit) arrives in the next batch, it is an untracked create. Both files' bytes survive, but every reference now points at the losing copy, and the boards sync that rebinding to the other machine.
Nothing checks the name (grep: no conflict logic).

**Fix:**
1. In `correlateRenames`, before each `renames.push` (both the :264 same-basename push and the :394 cross-basename push), add:
   ```ts
   const cc = detectConflictCopy(basename(p.filename), { knownHosts });
   const isConflictOfMissing = cc && samePathFold(canonicalPathFor(p.filename, { knownHosts }), m.filename, caseInsensitiveFs);
   if (isConflictOfMissing) { conflicts.push({ copyPath: p.filename, canonicalPath: m.filename, client: cc.client }); continue; }
   ```
   The **refusal fires only when the present file's canonical path equals the missing path.** A strong match to some unrelated missing file still correlates, and a weak `(1)`/` 2` match refuses only in this exact shape. That shape is where the weak patterns are genuinely conflict-shaped, and a user rename `Note.md → Note (1).md` in Explorer is rare. It then degrades to delete + create, which after EXT-4's fix is non-destructive by default.
2. Extend the return type with `conflicts: Array<{copyPath, canonicalPath, client}>`. `knownHosts` is a new optional parameter (defaulting to `[os.hostname()]` via the caller) to keep the test seam pure. The watcher passes the vault's known hosts, loaded at `start()`, into `syncConflictNotifier.ts`, which emits `vault:sync-conflict` (shared with ERR-3 step 4). Only the one-line call site is added to `fileWatcher.ts`, and the loader lives in the notifier module (headroom: 994 → ≤ 1000).
3. Both the missing and present events stay unsuppressed, so they flow on as delete and create. The renderer's `vault:sync-conflict` handler shows a sticky toast: *`Sync conflict: "Note.md" and "Note-DESKTOP-A.md". Your boards still point at Note.md. [Open both] [Dismiss]`*. It also suppresses the per-file "deleted externally" prompt for `canonicalPath` for a 10 s grace window, because the canonical file is expected to reappear. That uses the `externalChangeWindows.ts` mechanism the attachment-delete grace already uses.
4. The 30 s reconcile walk calls the same `correlateRenames`, so it inherits the refusal with no further change.

**Gate:** none new. The pure-function test below is the net, and `renameCorrelation.ts` is already exercised by four suites. (Justification: the refusal is a small, pure guard with exhaustive tests; a token gate would duplicate them.)
**Tests:** `src/tests/unit/renameCorrelationConflictCopy.test.ts`:
- **bite:** missing `Note.md` + present `Note-DESKTOP-1A2B3C4.md` with the same size and hash → `renames` is empty and `conflicts` has one entry (fails today);
- the same with a Dropbox name, and a weak `Note (1).md` whose canonical equals the missing path → refused;
- **negative:** missing `Draft.md` + present `Final (1).md` with the same hash → still a rename (the canonical isn't the missing path);
- `Meeting.md` → `Meeting-Notes.md` → still a rename (no host match);
- a case-only rename is unaffected.
**Acceptance criteria:** a OneDrive/Dropbox conflict never rebinds references. A genuine rename to a different name still rebinds.
**Risks / interactions:** a user who genuinely renames `Note.md` to `Note-<their own hostname>.md` gets delete + create instead of a rebind. That is acceptable, and is documented as a new KNOWN_LIMITATIONS entry ("renames that look like sync-conflict names are not auto-relinked"). `vault:sync-conflict` is a new receive channel (parity + `RECEIVE_CHANNELS`). The KL#7 text (large/small attachment relink) gets a cross-reference.

---

### 1.9 EXT-3 MEDIUM — "Keep local" on the deleted-externally prompt re-creates the file without re-probing, overwriting what sync has since re-created (and "Reload" drops tags of a live file)
**Phase:** 1 · **Status:** CONFIRMED (code path) · **Depends on:** BL-1 (create-exclusive `vault:create-file-text`); UX-6 (backup helper) · **Effort:** S
**Files:** `src/renderer/stores/vaultExternalDriftPrompts.ts:193-273` (`recreateDeletedFile`: `writeMarkdownAndReconcile({create:true, mode:'full'})` at :250-256); `src/renderer/stores/vaultExternalPrompts.ts:808-858` (`promptDeletedFile`), `:231-248` (bulk "Keep all" → `recreateDeletedFile`); `src/renderer/lib/vault/conflictResolver.ts:86-90`; sibling probes at `vaultExternalPrompts.ts:92-100` and `:425-434`.
**Mechanism (re-verified 2026-09-23):**
1. A sync client replaces a file as delete, then create, in separate batches.
2. Batch 1: `nextMetadata === null` with an open editor → `prompt-user` (conflictResolver.ts:86-89) → the "deleted externally" toast.
3. Batch 2 recreates the file with the other machine's bytes.
4. The user clicks the still-visible Keep local, and `recreateDeletedFile` writes unconditionally through the **create-or-overwrite** channel (`create:true`). It assembles `assembleMarkdownFile(fm, body)` with no `rawFrontmatter` baseline, which is a full YAML re-dump (KL#1). The other machine's edit is overwritten with no drift gate and no backup.
5. The mirror bug: **Reload** (vaultExternalPrompts.ts:825-839) calls `unloadDocument` + `fileTagsStore.dropFile(rel)` for a file that exists again, dropping its tags.json membership.
Unlike the attachment and closed-board prompts (Audit-18 3.8), neither handler re-probes.

**Fix:**
1. **Structural, not just a probe:** switch `recreateDeletedFile`'s write to the BL-1 **create-exclusive** path (`writeMarkdownAndReconcile({ …, create: 'exclusive' })` → `vault:create-file-text`, `'wx'`). On `EEXIST` the file is back, so do **not** write. Instead route to the modified-file flow: `await vaultIndexStore.applyChanges([rel])`, check `isStillSameVault`, then `promptModifiedFile(rel, fresh, editorDoc)`. That prompt's Keep local now backs up first (UX-6). This closes the probe→write TOCTOU by construction.
2. Keep a click-time `vault:file-exists` probe as a cheap first check (same pattern as :92-100) so the common case shows the right prompt without a failed IPC.
3. **Reload:** probe first. If the file exists, don't `dropFile` and don't unload. Instead apply the fresh disk version (`applyChanges` + `applyReloadFromDisk`), which is what "Reload" means once the file is back.
4. Bulk "Keep all" (vaultExternalPrompts.ts:245) goes through the same `recreateDeletedFile`, so it inherits step 1.
5. Dismiss a stale deleted-toast when a later batch sees the path reappear: the prompt registers `dedupeKey: 'ext-deleted:'+rel` (UX-6 mechanism), and `handleExternalMarkdownChanges` dismisses that key when `rel` shows up with `nextMetadata`.

**Gate:** extend `ci:md-writers-reconcile-editors`'s `RECONCILE_EXEMPT`/coupled-helper audit so `recreateDeletedFile` must pass `create: 'exclusive'` (function-scoped token check, which forbids `create: true` inside it). Bite-verify by reverting to `create: true` → exit 1. This also serves as BL-1's `ci:seed-writes-exclusive` twin, so coordinate the one shared script.
**Tests:** `src/tests/unit/recreateDeletedFileReprobe.test.ts`:
- **bite:** the deleted toast opens, then the file reappears on disk with other bytes, then Keep local → no `vault:write-file-text`/`create-file-text` success overwrites it, and `promptModifiedFile` is shown (fails today);
- a still-missing file → recreated;
- Reload with the file back → `dropFile` not called and the editor shows the disk bytes;
- a swap during `applyChanges` → bail.
Update `recreateDeletedFileCancelsPendingWrites.test.ts` / `recreateDeletedFileFrontmatterRace.test.ts` for the exclusive create.
**Acceptance criteria:** Keep local on a deleted-toast can never overwrite a file that exists at click time.
**Risks / interactions:** `vaultExternalPrompts.ts` / `vaultExternalDriftPrompts.ts` are in `ci:reconciler-vault-guard` Part 1 (the :148/:158 scan entries), so the new `await applyChanges` handlers need the L16/L17 guard: the gate's `applyChanges` trigger fires on the containing `prompt*` body. BL-1 must land first. If it slips, step 2 plus a *re-probe immediately before the write* is the interim, with the residual TOCTOU documented.

---

### 1.10 EXT-6 + ERR-8 LOW (MEDIUM for a two-machine user) — Machine-local crash sentinels live in the synced `.filo/`, so machines clear or replay each other's recovery state
**Phase:** 1 · **Status:** Sentinels CONFIRMED (the concurrent **and** sequential multi-machine cases). Config-seed race PLAUSIBLE (its overwrite half is refuted). · **Depends on:** none (C0 uses the machine registry) · **Effort:** L
**Files:** `src/renderer/lib/vault/dirtyFlagRecovery.ts:24` (`DIRTY_SENTINEL_PATH`), `:42` (`LAUNCH_ID`), `:164-205` (`markDirty`, payload without a machine), `:212-240` (`markClean`: unconditional delete), `:309-420` (`checkRecovery`/`readRecoveryStatus`); `src/renderer/lib/vault/renameCascadeSentinel.ts:35,218-310`; `src/renderer/lib/vault/tagRewriteSentinel.ts:32,107-190`; `src/renderer/lib/vault/quitFailureRecovery.ts:27,52-115`; `src/main/services/quitFailureBreadcrumb.ts:24,40-60` (stores **absolute** `preservedPath`); `src/main/utils/pathSecurity.ts:323-358` (`RENDERER_PERMITTED_FILO_PATHS`, exact set); `src/main/services/recoverySnapshot.ts:34-49` (`SENTINEL_BASENAMES`); `src/main/vault/configOps.ts:156-160` (seeding); the recovery sequencer `runRecoverySequencer` in `vault.svelte.ts`.
**Mechanism (re-verified 2026-09-23):**
1. One path, `.filo/.dirty`, is shared by every machine that syncs the vault. `markDirty` writes a payload with `launchId` + `vaultGeneration` and no machine identity. `markClean` deletes the file unconditionally.
2. **Sequential case (the most realistic):** A crashes with unflushed edits, and `.filo/.dirty` syncs. The user opens the vault on B, and B's `checkRecovery` finds a sentinel whose `launchId` isn't B's, so it prompts with A's pending paths. The data is only on A, so B's modal is meaningless. B's Dismiss (or its next clean `markClean`) deletes the file, the delete syncs, and **A never shows its recovery prompt.**
3. **Concurrent case:** B's idle `markClean` deletes A's live sentinel.
4. **Replay:** A's `tag-rewrite-pending.json` makes B's recovery sequencer offer "Resume", so B rewrites the same files A is sweeping.
5. The quit-failure breadcrumb's absolute paths are meaningless on the other machine.
6. **ERR-8 config seeding:** `initVaultConfig` writes each default only when `pathExists` is false, using `atomicWriteFile`. If a real config arrives later from sync, the client produces a conflict copy of `app.json` etc. (it doesn't overwrite, see the refuted section).

**Fix:**
1. **Machine identity (DECISION: userData, per owner).** A new `src/main/services/machineIdentity.ts` creates `userData/machine-id.json` = `{ id: randomBytes(6).toString('hex'), createdAt }` on first launch. The 12-hex id matches the tmp-nonce alphabet, and the file is read once and cached. It exposes `getMachineIdentity(): { machineId, hostname: os.hostname() }` and the bare invoke channel `app:machine-identity` (union + Zod `z.tuple([])` + contract + handler). The renderer fetches it once at App boot before any vault opens, via `src/renderer/lib/vault/machineIdentity.ts`, which caches it. Add a row to CLAUDE.md's **Persistence Boundary** userData table: `machine-id.json` — *identifies this machine so crash sentinels in the synced vault never cross machines*. An unreadable or corrupt file is regenerated, which only orphans that machine's old sentinels (handled by the legacy path in step 4).
2. **Per-machine sentinel names:**
   - `.filo/.dirty.<machineId>`
   - `.filo/rename-cascade-pending.<machineId>.json`
   - `.filo/tag-rewrite-pending.<machineId>.json`
   - `.filo/quit-failure.<machineId>.json`
   Payloads gain `machineId` and `hostname`. Main writes `.filo/machines/<machineId>.json` (`{hostname, firstSeen}`) on vault open, only if it's missing or the hostname changed. This registry feeds C0's `knownHosts` and labels foreign sentinels.
3. **Main-side ownership enforcement** (so "only ever clear your own" is structural). `assertNotInFiloDir(rel, { access: 'read' | 'write' })`:
   - **write/delete** is permitted for the four exact names with **this** machine's id, plus the legacy bare names for the migration delete in step 4;
   - **read** is permitted for the same patterns with **any** 12-hex id.
   All generic write/delete handlers pass `'write'`, and `vault:read-file-text` passes `'read'` (it's in `FILO_READ_EXEMPT` already). Also add an envelope channel `recovery:list-sentinels` → `IpcSuccess<{ entries: Array<{ kind: 'dirty'|'rename-cascade'|'tag-rewrite'|'quit-failure'; machineId: string | null; relPath: string; mtimeMs: number }> }>`, which does a readdir of `.filo/` so the renderer never needs to list directories. Extend `SENTINEL_BASENAMES` (recoverySnapshot.ts:34) into a matcher that accepts the `.<id>` forms.
4. **Backwards compatibility (the legacy bare files).** Legacy files carry no `machineId`, and the originating machine can't be proven.
   - On open, the renderer reads **its own** per-machine sentinels, and, if present, the **legacy** file of each kind.
   - A legacy sentinel is handled exactly as today (prompt, resume, breadcrumb), **once**. After the user's action, or immediately if its `launchId` shows it's this process's own, it is deleted. **New code never writes a legacy name.** This is a one-way migration: the first launch of the new build on any machine consumes the legacy files.
   - **DECISION:** a mixed-version fleet (an old Filo on the other machine still writes and deletes the bare `.filo/.dirty`) is supported only in the sense that the new build never deletes a *per-machine* file it doesn't own. The old build can still trample the legacy file. Documented in a new KNOWN_LIMITATIONS entry ("run the same Filo version on every machine that opens a synced vault").
5. **Foreign sentinels are informational (DECISION, per owner).**
   - Foreign `.dirty.<id>` files are **never** prompted (while another machine is editing, its sentinel legitimately exists). They're listed read-only in the Recovery Files modal (`RecoveryFiles.svelte`): *"LAPTOP-X: unclean-shutdown marker since 23 Sep 10:02 (3 files). Open the vault on LAPTOP-X to recover."*
   - A foreign `tag-rewrite`/`rename-cascade` sentinel older than 1 hour gets **one** info toast per session: *"A tag rename started on LAPTOP-X on 22 Sep didn't finish. Re-run it here if you still need it; Filo won't resume another machine's operation."* The `runRecoverySequencer` resume path only ever consumes own-machine or legacy sentinels (step 4).
   - A foreign `quit-failure` breadcrumb is listed only, because its absolute paths are foreign.
6. **ERR-8 seeding (narrow).** In `initVaultConfig` (configOps.ts:156-160), when `.filo/` already existed **before** this call (it was created on another machine) and some config file is missing, **don't seed** that file. The renderer's `config:load` fallback already supplies defaults in memory, and the first real save creates it. A brand-new vault (no `.filo/`) seeds as today. This removes the "default `app.json` races the synced one" conflict-copy source. The ordering constraint from the openVault swap memo (init-config re-anchor before the candidate load) is unchanged.

**Gate:** extend `ci:filo-read-guard` with a named anchor. `assertNotInFiloDir` must take `access` and must compare the machine id against `getMachineIdentity().machineId` on the write arm (function-scoped token check: `access === 'write'` + `getMachineIdentity(`). Bite: drop the id compare → exit 1. **New `ci:sentinel-machine-scoped`** (`scripts/check-sentinel-machine-scoped.mjs`) forbids the literals `'.filo/.dirty'`, `'.filo/rename-cascade-pending.json'`, `'.filo/tag-rewrite-pending.json'` and `'.filo/quit-failure.json'` in `src/renderer/**` and `src/main/**`, except in a single `LEGACY_SENTINEL_PATHS` constant module (`src/shared/sentinelPaths.ts`). This makes the per-machine builder the only way to name a sentinel. Bite-verify.
**Tests:**
- `dirtyFlagMachineScoped.test.ts`: **bite:** machine B's `markClean` never invokes `vault:delete` on A's `.filo/.dirty.<A>` (fails today, where the single file is deleted); B's `checkRecovery` with only A's sentinel present → `needsRecovery:false` and A listed as foreign; legacy `.filo/.dirty` → prompt once, then deleted, and a second open → no prompt;
- `pathSecurityMachineSentinel.test.ts`: a write to a foreign id → `FiloDirForbiddenError`, and a read → allowed;
- `tagRewriteForeignSentinel.test.ts`: a foreign tag-rewrite is never resumed, and there's one toast when older than 1 h;
- `initVaultConfigNoSeedExisting.test.ts`: `.filo/` exists without `app.json` → nothing written;
- `machineIdentity.test.ts`: the id is stable across calls and regenerated when corrupt.
**Acceptance criteria:** two machines on one synced vault can never delete, prompt for, or resume each other's recovery state. An upgrade from a legacy sentinel prompts exactly once.
**Risks / interactions:** four channel families touch pathSecurity, so `ci:ipc-parity` and `ci:filo-read-guard` both need care. `app:machine-identity` and `recovery:list-sentinels` are new channels (union/Zod/contract, and `ENVELOPE_CHANNELS` for the latter). `runRecoverySequencer` is pinned in `ci:reconciler-vault-guard` Part 3 (Audit-16 7.4), so its guard must survive the refactor. Recovery-snapshot listing must hide the new sentinel names (L13). `vault.svelte.ts` is at its ceiling, so the sentinel-kind fan-out lives in the sentinel modules, not the store. The sentinel files are still synced (by owner decision), so each machine's `.dirty.<id>` churns sync once per dirty/clean cycle, the same as today.

---

### 1.11 ERR-7 MEDIUM — Non-UTF-8 notes are decoded lossily, and any write (including a vault-wide tag sweep) persists U+FFFD
**Phase:** 1 · **Status:** CONFIRMED · **Depends on:** UX-1/MD-7 (Phase 0: a real non-editable read-only mode) · **Effort:** M
**Files:** `src/main/vault/fileOps.ts:700-702` (`readFileContents` → `fs.readFile(p,'utf-8')`), `:748-790` (`readFileWithCoherentStat`); `src/main/ipc/vault.ipc.ts:548-590` (`vault:read-file-text`, the only markdown read channel, per `ci:markdown-read-gateway`); write handlers in `vault.ipc.ts` (`vault:write-file-text`, `vault:write-existing-file-text`); renderer readers `src/renderer/stores/vaultIndex.svelte.ts:74`, `src/renderer/lib/vault/tagRewriteSweep.ts:162,257`, the gateway hydrate (`readMarkdownForHydrate`).
**Mechanism (re-verified 2026-09-23):**
1. `fs.readFile(p,'utf-8')` silently replaces invalid sequences (probe: `52 e9 75…` → `"R�union"`).
2. `grep -rn "FFFD\|fatal\|isUtf8" src` → none.
3. Every renderer write assembles from the decoded string: the tag sweep (tagRewriteSweep.ts:162 read → rewrite → write), the FM delta (the gateway's fresh read), and body saves. So the first write persists U+FFFD for every non-ASCII byte, even for a file the user never opened (the sweep).

**Fix:**
1. **Main: detect, don't guess.** In `readFileWithCoherentStat`, read a **Buffer** (not `'utf-8'`), then `const valid = require('buffer').isUtf8(buf)` (available in Node 18.14+; the probe confirmed `isUtf8` exists in this runtime). Decode with `buf.toString('utf-8')` either way, so display still works. Return `encoding: valid ? 'utf-8' : 'invalid-utf-8'`. `vault:read-file-text` passes `encoding` through in its success envelope (an additive field, contract update in `ipcContracts.ts`). A UTF-8 BOM stays as today (`﻿` preserved, BOM handling unchanged).
2. **Main: structural write refusal.** Add a new `src/main/services/nonUtf8Registry.ts` with a `Set<absPath>` filled by every `invalid-utf-8` read and cleared on a valid read or a vault swap. `vault:write-existing-file-text` and the overwrite case of `vault:write-file-text` refuse with code `NOT_UTF8` when the target is registered, unless the payload carries `{ allowReencode: true }` (the explicit "Convert to UTF-8" action below). Without this guard, a renderer bug that forgets the flag would still corrupt the file.
3. **Renderer:**
   - The vault index stores `encoding` on `FileMetadata`.
   - The gateway hydrate treats `invalid-utf-8` like the lossy read-only verdict: the editor is non-editable (reusing Phase-0 UX-1's `setEditorEditable(false)`), with the banner *"This note isn't UTF-8 (probably Windows-1252). Filo won't save it, to avoid corrupting characters. [Convert to UTF-8…]"*.
   - `tagRewriteSweep` skips such files and collects them into one toast: *"Tag rename skipped 2 notes that aren't UTF-8: …"*.
   - Field/Properties writes on such a path fail loudly through the existing `markPathFailed` route, and the `NOT_UTF8` code maps to a clear message in `writeErrorToast.ts`.
4. **"Convert to UTF-8…" (DECISION: explicit, lossy-aware).** Main re-reads the Buffer, decodes it as **windows-1252** via `new TextDecoder('windows-1252')` (Electron's ICU supports it), snapshots the original bytes to `.filo/recovery/` first, and writes UTF-8 with `allowReencode`. There is no auto-detection of other code pages. The confirm names Windows-1252 and says the original is backed up.

**Gate:** extend `ci:filo-read-guard`'s sibling idea as a new small gate, **`ci:utf8-validated-read`** (`scripts/check-utf8-validated-read.mjs`). It REQUIRES that `readFileWithCoherentStat` (function-scoped) call `isUtf8(` and FORBIDS `readFile(<…>, 'utf-8')`/`'utf8'` inside it and `readFileContents`. It REQUIRES the `vault:write-existing-file-text` handler segment to reference `isRegisteredNonUtf8(`. Bite-verify both arms.
**Tests:**
- `readFileNonUtf8.test.ts` (main): a 1252 buffer → `encoding:'invalid-utf-8'`, and the content still contains U+FFFD for display; UTF-8 with BOM → `'utf-8'`;
- **bite:** read, then `vault:write-existing-file-text` → `NOT_UTF8`, and the on-disk bytes are unchanged (fails today: they're overwritten);
- `tagRewriteSweepNonUtf8.test.ts`: the sweep skips the file, the bytes are unchanged, and the toast is listed;
- `convertToUtf8.test.ts`: `R\xE9union` → `Réunion` in UTF-8, with a snapshot taken.
**Acceptance criteria:** no Filo write path can change the bytes of a non-UTF-8 file except the explicit Convert action (with a backup).
**Risks / interactions:** UTF-16 files (Notepad "Unicode", BOM `FF FE`) are also reported `invalid-utf-8`, which is correct and read-only. The Convert action must refuse them (detect the BOM and offer nothing). `isUtf8` on a 25 MB file is fast (native). `markdownFileWriter.ts` (1416 ceiling) must not grow, so put the hydrate check in the existing `readMarkdownForHydrate` helper module. `test:unit:strict` stubs of `vault:read-file-text` stay valid because `encoding` is optional (absent means `'utf-8'`).

---

### 1.12 EXT-8 LOW — A tags.json update from another machine that lands inside the self-write window is dropped, and the next local tag save overwrites it
**Phase:** 1 · **Status:** CONFIRMED (wider than reported) · **Depends on:** none · **Effort:** S
**Files:** `src/renderer/stores/vaultExternalReconcilers.ts:254-255` (`if (isRecentSelfWrite(event.filename)) return;`); `src/main/ipc/tags.ipc.ts:99-103` (main-side `suppress(TAGS_REL_PATH, 2000)` before and `1000` after); `src/renderer/stores/fileTags.svelte.ts:103-176` (`lastSavedFile` merge base, `mergeTagsThreeWay`), `:187-222` (`scheduleSave`: a **blind** `tags:save` of the in-memory snapshot); `src/main/services/fileWatcher.ts:~700-710` (`walkFiloConfig` re-adds tags.json to the 30 s reconcile).
**Mechanism (re-verified 2026-09-23):**
1. A saves tags at t0. B's tags.json lands at t0+1 s.
2. (a) The **main** watcher suppresses the path for ~1 s after the write, so the live event may never reach the renderer. (b) If it does, the renderer drops it on `isRecentSelfWrite` (:255). Unlike the board reconciler (:96-115), there is no baseline-divergence tie-break.
3. The 30 s reconcile walk would eventually re-deliver it (tags.json is in `walkFiloConfig`), **unless A saves tags again first**. `scheduleSave` writes A's in-memory registry with no pre-write read or merge (fileTags.svelte.ts:203), so B's registration is overwritten. The later reconcile sees disk == memory, and `applyExternalReload` returns false. B's update is lost silently.

**Fix:**
1. **Structural: merge on write (the real fix, since the event can be suppressed main-side).** In `scheduleSave`'s `write` closure (fileTags.svelte.ts:199-222), before `tags:save`: `tags:load`, then `isStillSameVault` (a captured identity, not only `activeVaultRoot`), then `loadTagsFile(raw)`. If the disk file ≠ `lastSavedFile` (JSON compare), `mergeTagsThreeWay(lastSavedFile, file, disk)` → assign `file = merged`, and write `merged`. Otherwise write `file`. A read-only or corrupt disk (`readOnlyTags` semantics / Audit-18 H2) → abort as today. **DECISION:** reuse the A8-M6 3-way merge verbatim (a same-key conflict resolves to ours), so there's no new merge semantics.
2. **Event path tie-break:** replace the bare `isRecentSelfWrite` return at :255 with the board-style check. Within the window, `tags:load` and compare to `lastSavedFile`. If equal, it's an echo, so drop it. Otherwise fall through to `applyExternalReload` (which already 3-way merges). This keeps Audit-17 0.2's no-loop property (an echo compares equal).
3. Leave the main-side suppression, because step 1 makes it harmless.

**Gate:** extend `ci:reconciler-vault-guard` Part 1. `fileTags.svelte.ts` is already scanned (Audit-11 VS-2), so the new `await tags:load` in the save closure must carry `isStillSameVault` or the existing gate fails. There's no new gate: the merge is a few lines and the behavioural bite test pins it.
**Tests:** `src/tests/unit/tagsJsonMergeOnWrite.test.ts`:
- **bite:** memory {a}, lastSaved {a}, disk rewritten externally to {a, b}, then a local add of c and a save → disk = {a, b, c} (fails today: {a, c});
- disk == lastSaved → a single `tags:save` with no merge;
- an echo inside the window → dropped with no toast;
- a foreign change inside the window → applied;
- a vault swap during the pre-write `tags:load` → no write.
**Acceptance criteria:** no interleaving of a local tag save and a synced tags.json update loses either side's registrations (up to a same-key conflict, which goes to local).
**Risks / interactions:** it adds one read per tag save (a small file, debounced). The A9-L7 `mergeBaseGeneration` guard must still wrap the post-write base update. `miscWriteScheduler` bounds the write (ci:awaited-writes-bounded: misc is bound-for-uniformity).

---


---

## Phase 2 — Editor and path correctness (retire implicit convention paths)

### 2.1 MD-9 / MD-11 / BL-3 / BL-4 MEDIUM — Text tiles resolve their `.md` through divergent implicit convention rules; stamp `filePath` everywhere, back-fill once, and route every resolver through `resolveTextTileVaultPath`
**Phase:** 2 · **Depends on:** ERR-1 (the back-fill mass-dirties every legacy board. Without ERR-1, each of those writes would trigger the false-prompt cycle), BL-7 (must ship in the **same** change, see BL-7) · **Effort:** L
**Files:**
- Canonical resolver: `src/renderer/lib/boards/textTilePath.ts` L30-40
- Divergent resolvers: `TextTile.svelte` L94-109 (MD-11); `TileHeader.svelte` L491-518 (MD-9, hard-coded root at L497); `KanbanCard.svelte` L145-156; `commands/tileCommands.ts` L28-39 (`getTileFileRef`); `lib/search/runSearch.ts` L118-127 (`getDefFilePath`); `components/tags/TagsPopupMenu.svelte` L24-33; `lib/vault/frontmatterSync.ts` L185-209 (`tileBacksMarkdownPath`); dead `?? \`${title}.md\`` fallbacks at `TaskItem.svelte:178`, `TaskListBoard.svelte:271`, `kanbanFrontmatterWriter.ts:77`, `seedTextFileForNewTile.ts:48/67`
- Convention machinery (pin- and board-type-dependent): `fileRefIntegrity.ts` L57-103 (`getConventionFolder*`, `joinConventionPath`), L359-437 (`propagateMarkdownRenameToTextTiles` convention branch), L540-600 (`findTilesToCascadeDelete` convention arm L587-597), L705-778 (`detectBrokenRefs` convention arm L744-775); `conventionPaths.ts` L98-106 (`getActiveContentFolder`)
- Drop planner (BL-3): `lib/canvas/textTileDropPlan.ts` L63-92 (omits `filePath` at L87-90); `lib/canvas/markdownTileSeed.ts` L145-174 (conditional spread L167, root `tagFileKey` L172); callers `dragDrop.ts:347-362`, `kanbanFileDropHandler.ts:59-100` (→ `KanbanBoard.svelte:476` → `AddCardCommand`, never stamped), `tasklist/fileDropHandler.ts:175-190/297-305` (already stamps)
- Pin setters (BL-4): `stores/vaultRootFolder.ts` L65-84 (`setActiveRootFolder`); `stores/board.svelte.ts` L460-500 (per-board `defaultFolder` set + clear sweep); `stores/vault.svelte.ts` L1545-1552 (`refreshTreeAndCleanup` clears a missing pin)
- Load path: `lib/boards/boardLoader.ts` L382-433 (`loadBoard`), L716-800 (`loadAllBoards`); `lib/vault/vaultCandidate.ts` ~L280-290 (boards) and L369 (`knownPaths`); `stores/vault.svelte.ts` L378-387 (repaired ids → `markDirty`); `stores/boardCache.svelte.ts` L501-535 (`ensureAllLoaded`); `stores/vaultExternalReconcilers.ts` L168-200 (external reload)

**Mechanism (re-verified 2026-09-23):** a text def with no `filePath` has **three** live interpretations:
(a) the READ resolvers `TextTile.svelte:108` and `KanbanCard.svelte:155` fall back to the **vault root**
`${title}.md`; (b) the WRITE resolver `resolveTextTileVaultPath` (textTilePath.ts:36-39) uses
`getActiveContentFolder(board)` (vault pin → board pin → root); (c) broken-ref / cascade-delete / rename
propagation (fileRefIntegrity.ts:744-775, 566-597, 399-415) use `getConventionFolder`, which is
**`Kanban/<kanbanFolder>`** for Kanban and the pin cascade for mindmap/tasklist. (b) and (c) re-read the **live**
pins, so any pin change retargets every such tile (**BL-4**: vaultRootFolder.ts:65-84 only flips the setting and
recomputes badges). Defs without `filePath` are still being minted. `planTextTileDrop` returns `filePath: null`
when the drop sits at the convention path (textTileDropPlan.ts:87-90). The Kanban drop path
(`kanbanFileDropHandler.ts:79` → `AddCardCommand` → `persistAddKanbanPlacement`) never calls
`stampTextTileSeedPath`, so a card dropped from `Kanban/<board>/X.md` is written by (b) to the content folder and
read by (a)/`KanbanCard` from the root, and neither is `Kanban/<board>/X.md` (**BL-3**). **MD-9:**
`TileHeader.expandToDocument` (L491-518) hard-codes `filename = \`${tile.title}.md\`` (L497) whenever no
`DocumentState` exists for the contentId. That covers the LOD-"simplified" case, where the header renders but the
body never mounted. It ignores even an explicit `filePath`, so **every** stamped subfolder tile is affected. The
`loadDocument` then pins that wrong filename under the tile's docId, and later `loadDocument` calls are no-ops for
an existing id. (Also, the L502-506 comment says it "never seeds body=''", but L512 seeds `body: ''`.)
**MD-11 correction:** the verifier's Mind-Map repro does **not** hold. Every Mind-Map add goes through
`boardStore.addTile` → `persistAddTile` → `mindmapTileOps.addTile` (core/boardTileOps/mindmap.ts:42), which calls
`stampTextTileSeedPath` and stamps the canonical path before the def is cached. MD-11 **does** hold for Kanban
cards, because `KanbanCard.svelte:32/342` mounts `TextTile`, and for BL-3 drops and legacy defs. MEDIUM stands.
**Adjacent defect found in re-verification (fold in here):** `frontmatterSync.tileBacksMarkdownPath`
(L191-209) returns true for the explicit `filePath` **and also** for the root `${title}.md`, even when an explicit
path exists and differs. So an external edit to an unrelated root `X.md` reconciles its frontmatter into a
`Notes/X.md` tile's def (`reconcileBoardCacheWithFrontmatter` L255), feeds `staleSeededFrontmatter.ts:65`, and
skews tag counts (`fileTags.svelte.ts:454`).

**DECISION (owner):** retire implicit convention-path resolution. Stamp `filePath` on every text-tile drop and
creation. Run a one-time, idempotent back-fill of `filePath` on board load for defs that lack it, resolved with the
**current** rules, before any pin change. Route all resolvers through `resolveTextTileVaultPath`.

**Back-fill design decisions (proposed, flagged for owner review):**
- *Which "current rule" when (a)/(b)/(c) disagree?* Generate candidates in this order: (c) the broken-ref
  convention path (Kanban → `Kanban/<folder>/`, mindmap/tasklist → pin cascade); (b) the write resolver's
  `getActiveContentFolder` path (identical to (c) for mindmap/tasklist); (a) the vault-root path. Try each with the
  exact `title` first, then `title.trim()`. **Stamp the first candidate that exists on disk**, using the on-disk
  casing from the tree. If none exists, stamp (c). That's the path the broken-ref badge already shows, so the
  missing-file UX doesn't change. This freezes the binding the user actually sees working and never picks a
  non-existent path over an existing one. If the def carries a legacy `file` string and no `filePath`, stamp
  `filePath = file`, since that's already its explicit path.
- *Does it write the board?* **Yes.** Stamped boards are marked dirty through the existing load-repair channel
  (`vault.svelte.ts:378-387` already `markDirty`s `backfilledBoardIds` / `prunedBoardIds` / `normalizedBoardIds`),
  so the stamp persists on the first debounce after open. It's additive only (one key per def), so no recovery
  snapshot is needed.
- *Undoable?* **No.** It's a load-time normalisation, not a user action, and it doesn't change what any tile
  currently resolves to. It must not go through `historyStore`, because `commitExecute` files by the **global**
  active board (Audit-4 P3 learning), which would pollute another board's stack. And a Ctrl+Z that un-stamped it
  would re-expose BL-4.
- *Boards not currently loaded?* `loadAllBoards` loads **every** `.board.json` at vault open
  (boardCache.svelte.ts:492-496), so the candidate-phase pass covers the whole vault. Boards loaded later go
  through `loadBoard` with a live back-fill context: `ensureAllLoaded`, the external-change reload at
  vaultExternalReconcilers.ts:171, and EXT-1's future runtime discovery. `failedBoards` aren't in the cache and
  can't be written; they get back-filled on the open after they're fixed.
- *Which gate forbids new filePath-less defs?* Extend `ci:creation-persists-filepath` (drop builders + a persist
  chokepoint) and add `ci:no-convention-path-resolution` (below). Also add a dev-only runtime tripwire in `writeBoardFile`.

**Fix:**
1. **Pure core** — new `src/renderer/lib/boards/textTilePathBackfill.ts` (~120 LOC, no store imports):
   ```ts
   export interface BackfillContext { knownPaths: ReadonlySet<string>; activeRootFolder: string }
   /** Mutates `data.tileDefs` in place; returns stamped tile ids. Idempotent. */
   export function backfillTextTileFilePaths(data: V7BoardFileData, ctx: BackfillContext): string[]
   ```
   It uses `getConventionFolder` / `joinConventionPath` (fileRefIntegrity.ts) plus a new pure
   `resolveContentFolder(vaultPin, board)` extracted from `getActiveContentFolder` (conventionPaths.ts:98-106, which
   then delegates to it). Case-folded existence lookups use `normalizeVaultRelative`, mapped back to the tree's casing.
2. **Load wiring:**
   - `loadBoard(vaultRoot, relPath, opts?: { backfill?: BackfillContext })`. When `opts.backfill` is set, run the
     pure function after `loadVersionedFile` succeeds and return `filePathsBackfilled: boolean`.
     `loadAllBoards(vaultRoot, backfill?)` threads it through and folds stamped ids into its existing
     `normalizedBoardIds` array (documented as "any load-time normalisation that must persist"). **`vault.svelte.ts`
     needs no edit**, because L378-387 already `markDirty`s them, and its 1867 ceiling holds.
   - `vaultCandidate.ts`: the tree (`knownPaths`, ~L369) is computed **after** `loadAllBoards` (~L280). Keep
     `loadAllBoards` pure and run the back-fill over `boardCache` in vaultCandidate right after `knownPaths` and
     `settings` exist, with `{ knownPaths, activeRootFolder: settings.general.activeRootFolder ?? '' }`. Append the
     stamped ids to `normalizedBoardIds`. It uses the **candidate's** tree and pin, never the live `vaultStore`
     (which still holds the outgoing vault during the candidate phase).
   - Live context helper `liveBackfillContext()` in `boardCache.svelte.ts` next to `collectFolderPinOptions`
     (L78-94), built from `flattenTreePaths(vaultStore.fileTree, vaultStore.path)` + `vaultStore.activeRootFolder`.
     Pass it at `ensureAllLoaded` (L524) and vaultExternalReconcilers.ts:171, and `markDirty` when
     `filePathsBackfilled`. boardCache.svelte.ts is at its 1009 ceiling, so trim equal comment lines in the same
     file (for example the 10-line `ensureAllLoaded` docstring L480-490 can lose 3 lines). The reconciler call sits
     after the existing `isStillSameVault(captured)` guard (L173), so `ci:reconciler-vault-guard` stays satisfied.
3. **Stamp at every creation/drop (BL-3):**
   - `planTextTileDrop` (textTileDropPlan.ts:87-92): always return `filePath: droppedRelPath`. Reduce duplicate
     detection to `samePath(t.filePath, dropped) || contentId` match, and drop the convention-path compare
     (L81-84), which is dead once every def is stamped. Delete the now-unused `conventionFolderOverride`,
     `boardName`, `kanbanFolder` inputs and update the three callers.
   - `buildTextTileDefFromMarkdownFile` (markdownTileSeed.ts:167/172): unconditional `filePath: plan.filePath` and
     `tagFileKey = plan.filePath`. That also fixes the root-keyed tag registration for pinned-folder drops.
   - Remove the now-redundant explicit stamps at `tasklist/fileDropHandler.ts:190/305` and simplify
     `dragDrop.ts:356-362`.
   - **Chokepoint safety net:** `persistAddKanbanPlacement` (boardCacheKanban.ts:322) and `persistAddTaskPlacement`
     (boardCacheTaskList.ts:90) call a small `ensureTextDefFilePath(def, boardId)` that stamps through
     `resolveTextTileVaultPath` and `console.warn`s in DEV if it had to. The mindmap/kanban/tasklist
     `addTile` ops already stamp through `stampTextTileSeedPath`. This is a backstop only: creation sites must stamp
     **before** the command's deep clone, or redo would re-resolve under a possibly changed pin.
4. **Freeze before any pin change (BL-4 belt-and-braces)** — expose `boardCacheStore.backfillTextTileFilePaths()`
   (runs the pure function over the whole cache with `liveBackfillContext()`, `setCache` + `markDirty` per changed
   board, non-undoable). Call it **before** the setting mutates in `vaultRootFolder.setActiveRootFolder`
   (L74, before `project.settings.general.activeRootFolder = next`), in `board.svelte.ts` `setBoardDefaultFolder`
   (L465-467, before `updateSettings`), in the clear-defaultFolder sweep (L472-500), and in
   `vault.svelte.ts:1548-1550` (pin cleared because its folder vanished; offset by trimming one comment line in
   that block, since the file is at its ceiling). After step 2 this is a no-op in practice, but it guarantees that
   "resolved with the current rules, before any pin change" holds even for a def that slips past the gate.
5. **Route every resolver through the canonical helper:**
   - `TileHeader.expandToDocument` (L497): `const filename = resolveTextTileVaultPath(tile, tile.boardId) ?? 'Untitled.md';`
     and fix the misleading L502-506 comment. Confirm that `DocumentEditor`'s hydrate treats `body: ''` as
     "unhydrated" (Audit-12 M1 `hydrateReadFailed` path).
   - `TextTile.vaultRelativePath` (L94-109): `return resolveTextTileVaultPath(tile, tile.boardId);`. Keep the
     `vaultRoot` null guard.
   - `KanbanCard.vaultPathForTile` (L147-156): `return isText ? resolveTextTileVaultPath(tile, tile.boardId) : null;`
     (−8 LOC).
   - `tileCommands.getTileFileRef` (L33-39) text branch, `runSearch.getDefFilePath` (L126), `TagsPopupMenu`
     (L28-30): use a def-level sibling `resolveTextDefVaultPath(def, boardId)` added to textTilePath.ts, with the
     same priority as the Tile version, so board-cache shapes don't need a Tile cast.
   - `frontmatterSync.tileBacksMarkdownPath` (L199-207): **if an explicit `file`/`filePath` exists, return only its
     comparison**. Use the title fallback only when neither exists (dead after back-fill, kept for defence).
   - Drop the dead `?? \`${title}.md\`` fallbacks at TaskItem.svelte:178, TaskListBoard.svelte:271 (one line
     changed, not added), kanbanFrontmatterWriter.ts:77, seedTextFileForNewTile.ts:48/67. The canonical resolver
     never returns null for a text tile.
6. **Legacy convention branches in fileRefIntegrity:** leave the filePath-less arms of
   `propagateMarkdownRenameToTextTiles` (L420-435), `findTilesToCascadeDelete` (L587-597) and `detectBrokenRefs`
   (L760-775) in place for this phase. After back-fill they never match. Add a `// LEGACY: filePath-less defs only
   (pre-Audit-19 back-fill)` marker and record their deletion as a Phase 5 dead-code item, once one release has
   run the back-fill on the user's vault. `getConventionFolderForBoardType` stays: the back-fill uses it, and so
   does the Kanban folder-move propagation (L328-357).

**Gate:**
- Extend **`ci:creation-persists-filepath`** (`SITES` in check-creation-persists-filepath.mjs:135-156) with
  `lib/canvas/markdownTileSeed.ts → buildTextTileDefFromMarkdownFile` (must contain an unconditional
  `filePath:` property). Add a new FORBID arm on that function's blanked body: the token sequence
  `plan.filePath ?` (conditional spread) is banned. Also require `ensureTextDefFilePath(` inside
  `persistAddKanbanPlacement` and `persistAddTaskPlacement` (function-scoped with `extractFnBody`; both are object
  methods, so add a method-extractor or scope to the `makeKanbanSlice`/`makeTaskListSlice` bodies).
- New **`ci:no-convention-path-resolution`** (`scripts/check-no-convention-path-resolution.mjs`, the 50th guard).
  It scans `src/renderer/**` (string-preserving and comment-stripped, like `ci:board-path-casefold`) for template
  literals matching `` /`[^`]*\$\{[^}]*\btitle\b[^}]*\}\.md`/ `` and fails outside an allowlist:
  `textTilePath.ts` (the single canonical fallback), `textTilePathBackfill.ts`, `conventionPaths.ts` (new-name
  minting), `fileRefIntegrity.ts` (`joinConventionPath` + LEGACY arms), and `renameTitleCommand.ts` /
  `textTilePath.replaceTitleInVaultPath` (rename-target minting). `markdownTileSeed.ts` is deliberately **not**
  allowlisted, because step 3 removes its root `tagFileKey` literal. Escape:
  `// allow-title-path: <reason>`. A `MIN_SCANNED` tripwire fails if the walker goes stale. Bite-verify: put
  back TileHeader's L497 literal → exit 1; KanbanCard's L155 → exit 1.
- Extend **`ci:writer-path-honors-filepath`** `RESOLVER_SITES` (L42-55) with `components/tiles/TileHeader.svelte`,
  `components/tiles/TextTile.svelte`, `components/boards/KanbanCard.svelte`, `commands/tileCommands.ts`, and
  rewrite its docstring (L16-24), which currently says TextTile/KanbanCard are intentionally excluded.
- Dev-only tripwire in `writeBoardFile` (boardWriteScheduler.ts, near L392): in DEV, `console.warn` when a text def
  in `fileData.tileDefs` lacks `filePath`, mirroring `assertBaselinesSeeded`. Zero prod cost.

**Tests:** `src/tests/unit/textTilePathBackfill.test.ts` (pure):
- mindmap def without `filePath`, file at the pinned folder → stamped `Pinned/X.md`; file only at the root →
  stamped `X.md` (existence beats rule order); neither exists → stamped with the broken-ref path; idempotent
  (second run returns `[]`, bytes unchanged);
- Kanban def, file at `Kanban/Sprint/Fix login.md` (BL-3 scenario) → stamped there, **not** at the root or the
  content folder; case-only difference → stamped with the on-disk casing; legacy `file` field → copied.
`src/tests/unit/audit19PathCluster.test.ts` (store-level, window.filo stubs):
- **BL-4:** load a board with a filePath-less root `Ideas.md` tile, back-fill, then `setActiveRootFolder('Notes')`
  where `Notes/Ideas.md` exists → `resolveTextTileVaultPath` still returns `Ideas.md`; `detectBrokenRefs` reports
  nothing; `findTilesToCascadeDelete(…, 'Notes')` does **not** include the tile; a sidebar rename of root
  `Ideas.md` still propagates. **Bite:** skip the back-fill and each assertion goes red.
- **BL-3:** Kanban sidebar drop of `Kanban/Sprint/Fix login.md` → the cached def has that `filePath`; `setTilePriority`
  writes that path (the stubbed `vault:write-existing-file-text` receives it), not the root.
- **MD-9:** a subfolder tile with `filePath: 'Notes/X.md'` and no DocumentState → `expandToDocument` registers
  `filename === 'Notes/X.md'`. **Bite:** the old L497 fails.
- **MD-11:** TextTile mounted for a Kanban card whose def lacks `filePath` but the board has a content folder →
  the hydrate read targets the canonical path (run through the back-fill first, then also directly via the resolver).
- **frontmatterSync:** a def with `filePath: 'Notes/X.md'`, and an external change to root `X.md` → `tileBacksMarkdownPath` is false.
- **Persistence:** after `commitVaultCandidate`, every back-filled board id is in the dirty set, and after flush the
  written JSON carries `filePath` on every text def (with ERR-1 in place: plain JSON).
- Update `textTileDropPlan` / `markdownTileSeed` tests that assert `filePath: null` for convention drops. They now
  expect the dropped path.

**Acceptance criteria:** after opening an existing vault once, every text def in every `.board.json` has
`filePath`. Changing the vault pin or a board's default folder changes where **new** files land and nothing else:
no badge flips, no retargeted edits, no cascade removals. "Expand to Document" on a zoomed-out subfolder tile opens
that subfolder file. `ci:verify` is green with 50 guards.

**Risks / interactions:**
- **One-time mass write at first open:** every legacy board with a filePath-less def is re-saved about 300 ms
  after open. With ERR-1 fixed first, those saves are clean self-writes; on OneDrive that's one upload per board.
  Without ERR-1 it would also trigger the false-drift prompt on every board, which is why ERR-1 is a hard prerequisite.
- **Undo stacks:** no command snapshots are touched. Commands built before the back-fill don't exist at load time.
  Pin-change back-fill (step 4) mutates defs outside history. An older `DeleteTilesCommand` snapshot that lacks
  `filePath` re-adds through the chokepoint, which stamps it with the current rule. That's acceptable and warned in DEV.
- **BL-7 must land in the same change.** Once every tile is filePath-backed, the in-folder "rename updates the
  title" behaviour (fileRefIntegrity.ts:431-433) never fires again. Without BL-7, every sidebar rename would leave
  a stale title.
- Ceilings: `vault.svelte.ts` (one line changed for one line at L1548 plus a comment trim), `boardCache.svelte.ts`
  (+~4, offset by a docstring trim), `TaskListBoard.svelte` (L271 edited in place), `kanbanCommands.ts` untouched.
  New files are small.
- `getConventionFolderForBoardType` semantics are preserved for the back-fill. The Kanban `Kanban/<folder>`
  convention now only matters for (1) back-fill candidate generation and (2) folder-move `kanbanFolder` propagation.

### 2.2 BL-7 LOW — Sidebar rename of a filePath-backed card/task leaves the tile title stale
**Phase:** 2 (ships **with** the cluster above) · **Depends on:** path cluster · **Effort:** S
**Files:** `src/renderer/lib/vault/fileRefIntegrity.ts` L241-262 (`rewriteRenameInBoard`), L268-283
(`propagateRenameAcrossBoards`), L424 (`if (d.file || d.filePath) continue`), L285-290 (`basenameWithoutMd`);
caller `src/renderer/stores/boardCacheFrontmatter.ts` L198-212 (`propagateRename`).
**Mechanism (re-verified 2026-09-23):** `rewriteRenameInBoard` rewrites only the `FILE_REF_FIELDS` path strings
(L247-258). `propagateMarkdownRenameToTextTiles` skips any def with `file`/`filePath` (L424), and that function is
the only place a title follows its file (L431-433). All new tiles are stamped (Mind Map through
`stampTextTileSeedPath`, Kanban/Task through the creation modules), so a sidebar or OS rename of `Buy milk.md` →
`Buy oat milk.md` leaves the row reading "Buy milk". After the back-fill this affects **every** text tile.
`TaskListBoard.renameTask` sets the title itself, so in-board renames are unaffected.
**Fix:**
1. In `rewriteRenameInBoard`'s visitor (L247-258), when `field === 'filePath'`, `tile.type === 'text'`, the match is
   an **exact file** rename (`normalizeVaultRelative(current) === normalizeVaultRelative(oldPath)`, not a folder
   prefix), `basenameWithoutMd(oldPath)` and `basenameWithoutMd(newPath)` are both non-null and differ, and
   `typeof tile.title === 'string' && tile.title.trim().toLowerCase() === oldBase.toLowerCase()`: set
   `tile.title = newBase` and `tile.updatedAt = Date.now()`. Count it in `updates`. Titles that don't match the old
   basename (for example user-set titles that were sanitised) are left alone.
2. `propagateRename` (boardCacheFrontmatter.ts:198-212) already `markDirty`s changed boards. Also sync the live
   `DocumentState.title` for that def's `contentId` if the rename pipeline's `updateFilename` hook doesn't already
   do it (check `document.svelte.ts` `updateFilename`), so open Document tabs show the new name.
3. Round-trip symmetry: an in-board `renameTask` → `vaultStore.rename` → propagation sets the same `finalTitle` the
   `RenameTitleCommand` records, and its undo's reverse rename propagates the old title back. Both write the same
   value, so there's no double-history. Verify with a test.
**Gate:** none — justification: a pure-function behaviour change fully covered by unit tests. A token gate can't
express "title follows basename".
**Tests:** `fileRefIntegrity.test.ts` new cases: exact rename updates a matching title (case-insensitive);
a folder move (`A/x.md` → `B/x.md`) keeps the title; a non-matching custom title is kept; a Kanban placement
`coverImage` rename doesn't touch titles. `audit19PathCluster.test.ts`: sidebar-rename a task → the row title
updates and `nextUniqueMdPath` treats the new name as taken. `TaskListBoard.renameTask` then undo: the title and
file round-trip exactly. **Bite:** remove step 1 and the first case goes red.
**Acceptance criteria:** renaming `Buy milk.md` in the sidebar shows "Buy oat milk" in the Task List immediately,
and still after restart.
**Risks / interactions:** a user who deliberately gave a tile a title equal to its filename, and wants it to stay
fixed through renames, sees it follow. That's the documented convention-tile behaviour, so it isn't a regression.
No ceiling files touched.

---

### 2.3 MD-6 MEDIUM (PLAUSIBLE) — Two views of the same tile or document (split panes) share one `callerId`, which defeats per-writer dirty gating and collides scheduler and force-writer keys
**Phase:** 2 · **Depends on:** MD-2 (it removes the stale final-write half of the scenario) · **Effort:** S
**Files:** `src/renderer/components/tiles/TextTile.svelte` **L86**; `src/renderer/components/boards/DocumentEditor.svelte` **L311**; `src/renderer/stores/tabs.svelte.ts` `partitionMarkdownFailuresByBoard` L31-96 (parses `text-tile:` L74-75 / `document-editor:` L84-85); `src/renderer/components/layout/Tab.svelte` L29-36; `src/renderer/stores/workspace.svelte.ts` `splitLeaf` L213-233.
**Mechanism (re-verified 2026-09-23):**
- `splitLeaf` does not refuse a tab already shown, so Alt+Click can mount the same board or doc twice.
- Both instances compute the same callerId. They share the scheduler key, the `dirtyWriters` entry and the `forceWriters` entry.
- TextTile onDestroy L473 `cancelMarkdownWrite(callerId)` and L499 `dropDirtyWriter` therefore act on the sibling's write and dirty flag.
- The stale-final-write overwrite was PLAUSIBLE. MD-2's destroy guard removes that half, because a clean pane B no longer writes. The cancel and dirty-drop cross-talk still holds structurally.
**Fix:**
1. Make callerId unique per component instance while keeping the parseable prefix. Use `#` as the separator, since it is outside nanoid's `A-Za-z0-9_-` alphabet:
   - TextTile: `const instanceId = createId(); let callerId = $derived(\`text-tile:${tile.id}#${instanceId}\`);`
   - DocumentEditor L311: `` `document-editor:${docId}#${createId()}` ``.
2. `tabs.svelte.ts` L75 / L85: strip the suffix, e.g. `ownerId.slice(prefix.length).split('#')[0]`.
3. **DECISION:** keep the split-same-tab feature (don't refuse in `splitLeaf`). With unique ids, the audit2 2.2 per-writer gating works as designed: a clean pane reloads the other pane's keystrokes. `forceWriteForDocument` already iterates every writer for a docId, serialised per path (`markdownFileWriter.ts:1333-1358`).
**Gate:** none. The change is two string templates. Behavioural tests pin it, and a token gate would only restate them.
**Tests:**
- `src/tests/component/splitPaneSameTile.test.ts` (T0). Mount two TextTiles for the same tile def, type in A, and unmount B within 300 ms. Assert A's pending write still fires with A's text, and `isWriterDirty(docId, A.callerId)` stays true until it lands. Today B's destroy cancels A's timer.
- Update `tabsStoreCloseFlush.test.ts` / `tabCloseSaveFailure.test.ts` to cover a suffixed owner id attributed to the correct board. Existing tests that hard-code `text-tile:<id>` as a callerId in gateway-only calls are unaffected, because they don't go through the component.
**Acceptance criteria:** closing one of two panes showing the same board never cancels or cleans the other pane's unsaved edit.
**Risks / interactions:** the callerId now changes on remount, and the scheduler key follows. A remount already cancels or finishes the old instance's write in onDestroy, so there is no stranded key. `lastWriteFailureByCaller` entries for dead instances are small and cleared on vault swap.

---

### 2.4 MD-10 LOW — Any body edit on a CRLF note produces a mixed-EOL file (CRLF frontmatter, LF body)
**Phase:** 2 · **Depends on:** none (improves MD-2's skip for CRLF notes) · **Effort:** S
**Files:** `src/renderer/lib/editor/markdownSync.ts` `assembleMarkdownFile` L453-612 (`emitWithRawFrontmatter` L408-416, dirty branch L574-577, empty-object branch L594-608, no-FM L611); `src/renderer/lib/vault/markdownFileWriter.ts` assemble call L866-879 (`eol: state.eol`); `scripts/check-eol-preservation.mjs`.
**Mechanism (re-verified 2026-09-23):**
- `editorMarkdown` is always LF.
- `assembleMarkdownFile` re-applies `eol` only to the fences, the FM block and the trailing newline (L415, L575-576); the body is emitted verbatim.
- For a CRLF note the gateway passes `eol: '\r\n'` (sniffed at hydrate, `markdownFileWriter.ts:473`), which gives CRLF FM and an LF body.
- With no FM (L611), the whole file flips to LF.
**Fix:**
1. In `assembleMarkdownFile`, when `options.eol === '\r\n'` was **explicitly supplied** (the gateway's hydrate-sniffed value, never the detection fallback), normalise the body once at the top: `body = body.replace(/\r?\n/g, '\r\n')`. Because only the gateway threads `eol`, the Properties popup and new-file paths are unchanged.
2. Apply it to the no-FM return (L611) too, so a CRLF note without frontmatter stays CRLF.
**Gate:** extend `ci:eol-preservation` with a token `/options\.eol\s*===\s*'\\r\\n'[\s\S]{0,120}\.replace\(\s*\/\\r\?\\n\/g/` in `markdownSync.ts`, and require a new `assembleMarkdownEngine.test.ts` describe block, "A19-MD10 CRLF body". Bite-verify by removing the normalisation.
**Tests:** `assembleMarkdownEngine.test.ts`, "A19-MD10 CRLF body":
- `(fm, 'a\n\nb\n', { eol:'\r\n', rawFrontmatter, frontmatterDirty:false })` → the file contains no bare `\n`;
- the dirty-FM branch gives the same;
- no FM with `eol:'\r\n'` → all CRLF;
- no `eol` → the body is untouched (the Properties diskBody path);
- an already-CRLF body is not doubled (`\r\r\n` never appears).
**Acceptance criteria:** editing a CRLF note keeps every line CRLF (`git diff` shows only the edited lines).
**Risks / interactions:**
- A deliberately mixed-EOL file becomes uniformly CRLF on its first edit. That is acceptable (it was already being rewritten) and should be documented in the `eol` option docstring.
- Tests that assert LF bodies with `eol:'\r\n'` must be updated. Grep `eol: '\r\n'` in `src/tests/unit`.
- The `ci:frontmatter-invariant` corpus asserts FM bytes and is unaffected.

---


---

## Phase 3 — Board logic

### 3.1 BL-2 MEDIUM — Undo of Task-List bulk delete / "Delete completed" scrambles order and moves tasks between sections
**Phase:** 3 · **Depends on:** none · **Effort:** S
**Files:** `src/renderer/lib/tasklist/multiSelectController.svelte.ts` L319-349 (`bulkDelete`, cmds at L335);
`src/renderer/lib/tasklist/taskDeletion.ts` L160-197 (`deleteAllCompleted`, cmds at L186-188), L119-129
(subtask cascade, already reversed at L125); `src/renderer/commands/taskCommands.ts` L211-238 (ctor snapshots),
L319-333 (`restorePlacement`); `src/renderer/stores/boardCacheTaskList.ts` L90-125 (absolute splice L121-125);
`BatchCommand` in `commands/groupAndBoardCommands.ts` (undo in reverse).
**Mechanism (re-verified 2026-09-23):** every `DeleteTaskCommand` captures `snapshotPlacement` and `sectionsBefore`
**in its constructor** (taskCommands.ts:222-237), and both bulk paths construct all of them up front in row order,
which is ascending position. `BatchCommand.undo` replays children in reverse, so the highest-index task is
restored first into an array still missing the lower ones. `persistAddTaskPlacement` splices it at
`min(position, len)`, which is too early. Then the last child's `sectionsBefore` overwrites the section slices,
which are absolute indices, over the misordered array. The trace A,B,C | D,E, delete {B,C}, then undo, gives
S1=[A,B,D], S2=[C,E], as the finding states. Absolute-index replay is correct only for children in **descending**
position order, which is exactly what the cascade does at taskDeletion.ts:125.
**Fix:**
1. Add to `lib/tasklist/taskDeletion.ts` (exported, pure over the cache):
   ```ts
   export function orderForBatchDelete(boardId: string, tileIds: readonly string[]): string[] {
     const pos = new Map(((boardCacheStore.cache[boardId]?.board as TaskListBoard | undefined)?.tasks ?? [])
       .map((p) => [p.tileId, p.position] as const));
     return [...tileIds].sort((a, b) => (pos.get(b) ?? -1) - (pos.get(a) ?? -1));   // DESCENDING
   }
   ```
2. `multiSelectController.svelte.ts:335` → `orderForBatchDelete(board.id, sel.map((r) => r.tile.id)).map((id) => new DeleteTaskCommand(board.id, id))`.
3. `taskDeletion.ts:186-188` → the same over `completedTileIds`.
4. `taskDeletion.ts:125`: replace `[...descendants].reverse()` with `orderForBatchDelete(b.id, descendants)`, so
   the invariant no longer depends on `collectDescendantIds` returning rows in order.
5. Add a docstring on `DeleteTaskCommand` stating that batched instances **must** be ordered by descending position.
**Proposed decision:** descending sort rather than Kanban-style next-survivor anchors. It's a three-site change,
matches the existing cascade, and needs no new placement API. Anchors are only worth revisiting if a non-batch
interleaving (an edit between delete and undo) shows up. That case is already covered for sections by
`sectionsBefore` replay semantics.
**Gate:** none — justification: `ci:command-roundtrip-coverage` covers single commands, and batch ordering is a
call-site property best pinned by the behavioural test. (Optional: a token pin that both bulk sites reference
`orderForBatchDelete(`; default not added.)
**Tests:** `src/tests/unit/taskBulkDeleteUndoOrder.test.ts`: board A,B,C | D,E (S1@0, S2@3). (1) bulk-delete {B,C},
then undo → `tasks` and `sections` deep-equal the original; (2) "Delete completed" with B and D completed
(non-tail, across sections) → undo deep-equal; (3) delete {A,E} → undo deep-equal; (4) redo after undo → same
post-delete state as the first execute. **Bite:** remove the sort and (1) and (2) go red with the exact S1=[A,B,D]
scramble.
**Acceptance criteria:** any multi-select delete followed by Ctrl+Z restores the exact order and section membership.
**Risks / interactions:** none. `multiSelectController` (466) and `taskDeletion` (268) are far from 1000.

### 3.2 BL-9 LOW — Kanban "Sort: Due date" puts undated cards first
**Phase:** 3 · **Depends on:** none · **Effort:** S
**Files:** `src/renderer/lib/kanban/kanbanFiltersAndSort.svelte.ts` L98-124 (`sortPlacements`; due-date compare L115-117, priority compare L118-121).
**Mechanism (re-verified 2026-09-23):** `String(fmA.dueDate ?? '').localeCompare(String(fmB.dueDate ?? ''))` sorts
`''` before every ISO date, so undated cards rise to the top. The sibling priority compare has the same shape: an
unknown value gives `indexOf === -1`, which sorts **first**.
**Fix:**
```ts
if (sortBy === 'dueDate') {
  const da = typeof fmA.dueDate === 'string' ? fmA.dueDate : '';
  const db = typeof fmB.dueDate === 'string' ? fmB.dueDate : '';
  if (!da || !db) return (da ? 0 : 1) - (db ? 0 : 1);   // empties last, ties keep manual order (stable sort)
  return da < db ? -1 : da > db ? 1 : 0;                // ISO: lexical == chronological; avoid locale collation
}
if (sortBy === 'priority') {
  const rank = (v: unknown) => { const i = order.indexOf(String(v ?? '')); return i < 0 ? order.length : i; };
  return rank(fmA.priority) - rank(fmB.priority);
}
```
Array.prototype.sort is stable, so ties keep manual placement order, matching the Task List due-date grouping.
**Gate:** none — justification: a pure comparator covered by a unit test.
**Tests:** `kanbanFiltersAndSort.test.ts`: 3 undated cards and 1 due tomorrow → the dated card comes first and the
undated ones keep manual order; two dated cards in chronological order; priority with an unknown value (`'p1'`)
sorts last. **Bite:** revert to `localeCompare` on `''` and the first case goes red.
**Acceptance criteria:** "Sort: Due date" lists the soonest-due card first in every column, with undated cards at the bottom.
**Risks / interactions:** none (file ~150 LOC).

---

### 3.3 BL-6 LOW — Deleting a Kanban column leaves its cards' tileDefs in `.board.json` forever
**Phase:** 3 · **Depends on:** none (coordinate with the path-cluster back-fill: orphan defs would otherwise be back-filled too, which is harmless) · **Effort:** S/M
**Files:** `src/renderer/stores/boardCacheKanban.ts` L112-117 (`removeKanbanColumn` filters `columns` only),
L138-153 (`insertKanbanColumnAt`); `src/renderer/commands/kanbanCommands.ts` L443-489 (`DeleteColumnCommand`,
**at its 1093 ceiling**); `src/renderer/lib/boards/boardLoader.ts` L142-~230 (`pruneOrphanRefsAndDuplicates`).
**Mechanism (re-verified 2026-09-23):** `removeKanbanColumn` drops the column and its placements but leaves
`cached.tileDefs[...]` for every card in it (compare `removeKanbanPlacement` L402-421, which drops the def). The
loader's prune removes refs to **missing** defs, never **unplaced** defs, so the orphans persist indefinitely.
They bloat the JSON, get rename rewrites nothing renders, match cascade-delete, and (before BL-1) inflate `taken`.
**Fix:**
1. `boardCacheKanban.ts`: add `removeKanbanColumnWithDefs(boardId, columnId): Record<string, TileDefinition>`. It
   removes the column, deletes the defs of its placements that are **not placed in any other column**, calls
   `updateEntry(boardId, { board, tileDefs })` + `markDirty`, and returns the removed defs. Give
   `insertKanbanColumnAt` an optional `defs?: Record<string, TileDefinition>` that re-merges only the ids absent
   from `tileDefs`.
2. `DeleteColumnCommand`: snapshot `removedDefs` on the **first** execute (`this.snapshot(...)` of the returned
   map), use `removeKanbanColumnWithDefs` in execute, and pass `cloneForSnapshot(this.removedDefs)` to
   `insertKanbanColumnAt` in undo. The file is at its ceiling (+~4 LOC), so trim the matching lines from the
   L447-456 docstring in the same commit.
3. One-time cleanup of existing orphans: in `pruneOrphanRefsAndDuplicates`, for **kanban** boards only, drop text
   defs that no column placement references. Record them in a new `report.unplacedDefs`. That already routes
   through `orphansPruned` → `prunedBoardIds` → `markDirty`, and the recovery snapshot of the pre-prune bytes
   happens there. Mind Map and Task List stay out of scope.
**Gate:** none — justification: `ci:command-roundtrip-coverage` already requires a DeleteColumnCommand round-trip.
Extend that test instead.
**Tests:** `kanbanColumnDelta.test.ts`: delete a column with 3 cards → their defs are gone from `tileDefs`; undo →
the defs and column are restored deep-equal; delete, rename a sibling column, undo → the sibling edit survives
(the existing Audit-5 #9 case) and the defs are back. `boardLoader.test.ts`: a kanban file with 2 unplaced text
defs → pruned, reported, board marked for write; a def placed in another column is kept. **Bite:** revert step 1's
def deletion and the first assertion goes red.
**Acceptance criteria:** after deleting a 20-card column and restarting, `.board.json` has no defs for those cards.
Undo within the session restores the cards fully.
**Risks / interactions:** cards whose `.md` files remain are untouched on disk (only board metadata is pruned).
The load-time prune runs in `loadBoard`, so an external reload during a session also prunes. That's safe because
reload already replaces the cache that undo snapshots refer to.

### 3.4 BL-8 LOW — Quick-add parses `d/m` as US month/day
**Phase:** 3 · **Depends on:** none · **Effort:** S/M
**Files:** `src/renderer/lib/tasks/quickAddParser.ts` L1-27 (docstring L13), L122-127 (`parseQuickAdd` signature),
L205-221 (the `\d{1,2}/\d{1,2}` pattern: `m[1]` month, `m[2]` day); `src/renderer/components/boards/TaskQuickAddInput.svelte`
L41 (`parseQuickAdd(value)`), L188 (hint "month/day"); `src/main/main.ts` (BrowserWindow `webPreferences`),
`src/main/preload.ts` L62-124 (`api` object), `src/renderer/shims.d.ts` (`window.filo` type).
**Mechanism (re-verified 2026-09-23):** the regex handler reads `m[1]` as the month and `m[2]` as the day with no
locale input (L208-209). A UK "Dentist 3/4" becomes 4 March, and "25/12" fails `validDateOrNull` and stays in the title.
**DECISION (owner):** the user is in the UK, so use a locale-derived d/m order.
**Fix:**
1. `parseQuickAdd(input, options: { now?: Date; dayFirst?: boolean } = {})`. In the handler,
   `const [month, day] = options.dayFirst ? [b, a] : [a, b];`. The default stays `false`, so existing tests are
   unchanged and the function stays pure. Update the L13 docstring.
2. New pure helper `lib/tasks/dateOrder.ts`:
   `export function localeIsDayFirst(locale?: string): boolean` using
   `new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'numeric' }).formatToParts(new Date(2026, 11, 25))`
   and comparing the indices of `day` and `month`.
3. **Locale source (important on Windows):** Chromium's default `navigator.language` / `Intl` locale follows the
   Windows **display language**. A UK user with an "English (United States)" display language and a "United
   Kingdom" region (a common setup) would get `en-US` and stay month-first. Use Electron's
   `app.getSystemLocale()`, which reflects the regional format (e.g. `en-GB`): pass
   `additionalArguments: [\`--filo-system-locale=${app.getSystemLocale()}\`]` in the main window's
   `webPreferences`, parse it in the preload from `process.argv` (available to sandboxed preloads), and expose it as
   a read-only `systemLocale: string` on the `filo` api (no IPC channel, so no parity or envelope work). Fall back
   to `navigator.language`. Update `shims.d.ts`.
4. `TaskQuickAddInput.svelte`: `const dayFirst = localeIsDayFirst(window.filo.systemLocale || navigator.language);`,
   `parseQuickAdd(value, { dayFirst })`, and have the L188 hint render "day/month" or "month/day" to match.
**Gate:** none — justification: pure parser behaviour, covered by tests.
**Tests:** `quickAddParser.test.ts`: `dayFirst: true` → "Dentist 3/4" on 2026-09-23 gives 2027-04-03 (past → next
year), "25/12" → 2026-12-25, "31/2" rejected and kept in the title; `dayFirst: false` → the existing cases are
unchanged. `dateOrder.test.ts`: `en-GB` → true, `en-US` → false, `de-DE` → true. **Bite:** ignore `dayFirst` and
the en-GB cases go red.
**Acceptance criteria:** on the user's machine (UK region), "Dentist 3/4" schedules 3 April and the hint says "day/month".
Verify once in the packaged app that `window.filo.systemLocale` reads `en-GB`.
**Risks / interactions:** incidental tokens like "1/2 cup" are still consumed as a date in either order. That's
pre-existing and out of scope; a `^`-prefix requirement was considered and not adopted. `preload.ts` is 124 LOC.

### 3.5 BL-5 LOW — Monthly/yearly schedule-mode recurrence drifts permanently (31st → 28th, Feb 29 → Feb 28)
**Phase:** 3 · **Depends on:** none · **Effort:** M
**Files:** `src/renderer/lib/tasks/recurrence.ts` L84-115 (`addInterval`), L122-151 (`nextDueDate`, chained loop
L145-149); `src/renderer/lib/tasklist/frontmatterWriter.ts` L71-84 (`completionPatchForRow`), L278-282
(`setRecurrence`); field lists that carry `recurrenceMode`: `src/renderer/schema/tile.ts` L269-279
(`TASK_METADATA_FIELDS`), `lib/tasks/frontmatterReaders.ts` L70, `lib/tasks/taskListModel.ts` L40,
`lib/tasklist/taskListViewModel.svelte.ts` L136, `lib/vault/frontmatterSync.ts` L33/L114.
**Mechanism (re-verified 2026-09-23):** `nextDueDate` computes `next = addInterval(parsedDue)` and then chains
`addInterval(next)` (L146-149). `addMonthsClamped(Jan 31, 1)` gives Feb 28, which is correct, but every later step
starts from the clamped 28th. The yearly branch (L104-111) does the same for Feb 29. The completion patch
overwrites `dueDate` (frontmatterWriter.ts:75-80) and nothing stores the original day, so the drift is permanent
across completions. It also compounds inside one overdue catch-up.
**Proposed decision (not owner-made; flag for review):** persist an optional FM key `recurrenceAnchor: YYYY-MM-DD`,
written only when it matters (schedule mode, unit m/y, anchor day ≥ 29, or Feb 29 for yearly). Monthly tasks on
the 1st–28th never gain the key.
**Fix:**
1. `nextDueDate(currentDue, recurrence, mode, completedOn, anchor?: string)`. For schedule mode with unit `m`/`y`,
   compute `anchorDay` (and for yearly also `anchorMonth`) from `anchor` **if consistent** with `currentDue`
   (`currentDue.day === min(anchorDay, lastDayOf(currentDue.month))`, and same month for yearly). Otherwise the
   user moved the date by hand, so re-anchor to `currentDue`. Then step **by multiples from the base** rather than
   chaining: `k = 1, 2, …` with `candidate = clampDay(addMonths(base, k * count * (unit==='y' ? 12 : 1)), anchorDay)`
   until `candidate > today`. This also fixes the intra-completion compounding even when no anchor is stored.
   `d`/`w`/weekday are unchanged.
2. `completionPatchForRow`: pass `row.recurrenceAnchor`, and when the anchor rule above applies and the key is
   absent or different, add `recurrenceAnchor: <iso>` to the patch (it goes through the existing delta write,
   `patchToFrontmatterDelta`, so untouched keys are preserved).
3. `setRecurrence` (L278-282): when clearing or changing the recurrence, delete `recurrenceAnchor` through the patch
   (delta delete).
4. Add `recurrenceAnchor` everywhere `recurrenceMode` appears in the field lists above. In `TASK_METADATA_FIELDS`
   that keeps it stripped from board JSON; the reader returns an ISO string or `undefined`.
**Gate:** none — justification: pure date logic, covered by table tests.
**Tests:** `recurrence.test.ts` table: Jan 31 monthly schedule → Feb 28 → (anchor 01-31) Mar 31 → Apr 30;
leap Feb 29 yearly → 2029-02-28 → 2032-02-29; overdue catch-up from 01-31 completed on 04-05 → Apr 30 (not Apr 28);
a manual move of due to 03-15 with a stale anchor 01-31 → re-anchors (next 04-15); `every 2 months`; weekly/daily
unchanged. `frontmatterWriter` test: the patch includes `recurrenceAnchor` only for day ≥ 29, and clearing the
recurrence deletes it. **Bite:** revert to chained stepping and the Mar 31 row goes red.
**Acceptance criteria:** "Pay rent" due 2026-01-31 monthly shows 02-28, 03-31, 04-30, 05-31 across successive completions.
**Risks / interactions:** it adds a new FM key to the user's `.md` files, only in the ≥29th case. Old builds ignore
it (passthrough FM), so it's harmless. `frontmatterWriter.ts` is 497 LOC.


---

## Phase 4 — Destructive actions and security

#### Cross-cutting DECISIONS for UX-3 / ERR-5 / UX-4 (read first)

- **DECISION: user-initiated deletes go to the OS Recycle Bin via `shell.trashItem`.** This covers the sidebar file/folder delete (`vaultFolderOps.performDelete`) and the Board Browser board delete (`boardCacheStore.deleteBoard`). It is the only safety net that covers **every** file type (boards, `.docx`, >25 MB video, cloud placeholders). The in-app snapshot never can.
- **DECISION: app-internal deletes stay on `vault:delete` (unlink).** These are the tile-delete "also delete backing file" path (`tileCommands.ts:288-320` `executeFileDeletes`), the Task List delete (`lib/tasklist/taskDeletion.ts:233-250`, which already *refuses* to delete a file it can't snapshot) and the `.filo/` sentinel cleanups (`dirtyFlagRecovery.ts:223` et al.). Each one only deletes bytes it holds a snapshot of, and its redo re-executes the delete. Sending those to the Recycle Bin would drop a fresh copy there on every redo and add nothing, since undo already restores the bytes.
- **DECISION: what Undo means once the original is in the Recycle Bin.** The Recycle Bin copy and the in-app undo are **independent**.
  - `CascadeDeleteCommand.undo` (`commands/groupAndBoardCommands.ts:409-518`) keeps writing the **captured snapshot bytes** back to the original path. It uses `writeMarkdownAndReconcile({create:true})` for `.md` files and `vault:write-file-binary` for media, then restores placements.
  - It does **not** pull the file back out of the Recycle Bin. Electron has no restore-from-trash API, and there is no stable cross-version Shell API for it.
  - So after an undo the Recycle Bin still holds a (now duplicate) copy. If the user restores that copy by hand after an undo, Windows shows its normal "Replace or Skip" prompt. The bytes are identical unless the note was edited after the undo.
  - Files the command did **not** snapshot (`.board.json`, non-md/non-media types, media over 5 MB, read failures) come back as **broken-ref placements** on undo. The undo then shows a toast: "Restore these from the Recycle Bin: …". Once the user restores them, the file-create watcher event re-resolves the broken ref.
- **DECISION: a snapshot is still pushed when no tile references the deleted file.**
  - **New finding, re-verified.** `boardFrontmatterSync.ts:61-63` returns before creating the `CascadeDeleteCommand` when `targets.tileIds.length === 0 && !hasStyleClears`. So deleting a sidebar note that sits on **no** board discards its captured snapshot, and the "undoable" claim is false even for plain `.md` files.
  - The command is also filed on the *active* board's stack (`history.svelte.ts:97/124`, where `activeBoardId` null means no push). With no board tab open there is **no** undo at all.
  - Trash makes both gaps safe. The confirm text must stop promising Ctrl+Z, and the command should still be pushed when snapshots exist, even with zero tiles.
- **DECISION: fallback when `trashItem` fails** (no Recycle Bin on a network share / `subst` / FAT32 removable drive, or a lock):
  - Main **never** silently falls back to a permanent delete. It returns `{ success:false, code:'TRASH_FAILED', error, files }` with nothing deleted. `files` is the authoritative pre-listed vault-relative file set.
  - The renderer then opens a **second** danger confirm, "Can't use the Recycle Bin — delete permanently?". It lists **every file undo cannot restore**: `files` minus the snapshot keys. That covers unsupported types, `.board.json`, media over 5 MB, `FILE_TOO_LARGE` over 25 MB, and read failures such as EBUSY or offline placeholders. It shows up to 15 names plus "…and N more".
  - Only an explicit "Delete permanently" runs `vault:delete`.
  - For a **board** delete the list is empty, because the whole board is held in memory. That dialog says Undo (toast) still works for this session.
- **Must-verify before merging (Step 0 of UX-3):**
  - Electron's `shell.trashItem` on Windows uses `IFileOperation` with `FOFX_RECYCLEONDELETE` and a progress sink that returns `E_ABORT` from `PreDeleteItem` when the item would not be recycled. I believe this makes `trashItem` **reject rather than permanently delete** on a volume with no Recycle Bin, but I could not verify it from this sandbox.
  - Probe it on the packaged Electron 44 build: `trashItem` on (a) a file on the OneDrive-synced NTFS vault, including an online-only placeholder, (b) a `subst`/mapped network share, and (c) a FAT32 USB stick.
  - If (b) or (c) **permanently deletes** instead of rejecting, main must pre-check instead. Use `SHQueryRecycleBinW` via a tiny helper, or treat any non-local volume (`GetDriveTypeW != DRIVE_FIXED`) as `TRASH_FAILED` before calling `trashItem`. Record the result in the plan and in KNOWN_LIMITATIONS.

### 4.1 DEP-3 MEDIUM — Deny-all permission handler blocks Audio-tile recording (Electron-upgrade regression)
**Phase:** 4 · **Depends on:** none · **Effort:** S
**Files:**
- `src/main/utils/permissionPolicy.ts` L24-29.
- `src/main/main.ts` L395 (`installPermissionHandlers(session.defaultSession)`), L341-366 (dev `loadURL(ELECTRON_RENDERER_URL)` / prod `loadFile(join(__dirname,'../renderer/index.html'))`), L156-160 (webPreferences: `contextIsolation`, `sandbox`, and no `webviewTag`), L333 (`setWindowOpenHandler` deny).
- `src/renderer/components/tiles/AudioTile.svelte` L72 (`getUserMedia({ audio: true })`).
- `src/renderer/components/tiles/IframeTile.svelte` L105-108.

**Mechanism (re-verified 2026-09-23):**
- Both handlers deny unconditionally, and `getUserMedia({audio:true})` triggers a `'media'` permission request from the app document, so recording always fails with `NotAllowedError`.
- **How iframe tiles are hosted (verified):** a plain `<iframe sandbox="allow-scripts allow-popups">` **inside the main window's own webContents and `session.defaultSession`**. There is no `<webview>` (no `webviewTag`, no `will-attach-webview`) and no second session.
- So iframe permission requests reach the **same** handler with the **same** `webContents`. The only sound discriminators are `details.isMainFrame` (false for any iframe) and `details.requestingUrl` (the frame's own `https://…` URL).
- Origin-string compares are **unsound here**. The prod app URL is `file://…`, whose serialized origin is `"null"`, and a sandboxed iframe without `allow-same-origin` *also* has the opaque origin `"null"`.
- Chromium's Permissions-Policy default for `microphone` is `self`, so a cross-origin iframe without `allow="microphone"` is normally refused before the handler runs. The handler check is defence-in-depth and must not rely on that.

**Fix:**
1. In `permissionPolicy.ts`, export a pure `decidePermission(input: { permission: string; isMainFrame: boolean; requestingUrl: string; mediaTypes?: string[]; mediaType?: string; webContentsId: number }, ctx: { appWebContentsId: number | null; appUrlPrefix: string }): boolean`. It returns true only when **all** of these hold:
   - `permission === 'media'`;
   - `isMainFrame === true`;
   - `webContentsId === ctx.appWebContentsId`;
   - `requestingUrl.startsWith(ctx.appUrlPrefix)`;
   - on a request, `mediaTypes` is exactly `['audio']` (non-empty, every entry `'audio'`); on a check, `mediaType === 'audio'`.

   Everything else is denied, including `video`, `display-capture`, `clipboard-*`, `geolocation` and `notifications`.
2. `installPermissionHandlers(session, getCtx: () => ctx)`:
   - Request handler: `(wc, permission, cb, details) => cb(decidePermission({ permission, isMainFrame: details.isMainFrame, requestingUrl: details.requestingUrl, mediaTypes: details.mediaTypes, webContentsId: wc?.id ?? -1 }, getCtx()))`.
   - Check handler: `(wc, permission, _origin, details) => decidePermission({ …, isMainFrame: details.isMainFrame, requestingUrl: details.requestingUrl, mediaType: details.mediaType, webContentsId: wc?.id ?? -1 }, getCtx())`.
3. In `main.ts`, compute `appUrlPrefix` once:
   - dev: `new URL(process.env.ELECTRON_RENDERER_URL).origin + '/'`, only when `!app.isPackaged`;
   - prod: `pathToFileURL(join(__dirname,'../renderer/index.html')).href`, an exact document-URL prefix, not an origin.

   Set `appWebContentsId = mainWindow.webContents.id` in `createWindow`. The will-navigate block (L336-340) already pins the main frame to the app URL.
4. Update the docstring. Delete the false "Filo itself needs none of these permissions" and name the one allowlisted branch.

**Gate:** none. DECISION: a single-site policy function is fully pinned by its unit matrix. A source-shape gate would over-fit (Audit-18 7.3 precedent).
**Tests:** new `src/tests/unit/permissionPolicy.test.ts` (pure):
- Allowed: app main frame + audio-only.
- Denied: iframe (`isMainFrame:false`, https URL) + audio; app main frame + `['audio','video']`; app + `['video']`; a foreign `webContentsId`; a `requestingUrl` of `https://evil/` with `isMainFrame:true` (defence against a navigated main frame); every non-media permission; check-handler parity.
- **Bite:** make the function return `permission==='media'` → the iframe and video cases go red.
- Manual acceptance (packaged Win11 build): Audio tile → Record works, and an Iframe tile to a mic-test page is denied.

**Acceptance criteria:** Audio recording works in dev and packaged builds, and every iframe permission is still denied.
**Risks / interactions:**
- `details.mediaTypes` can be `undefined` for some Chromium paths, so treat undefined as deny.
- Electron 44 signature: verify the `details` field names against `node_modules/electron/electron.d.ts` (`PermissionRequest`/`MediaAccessPermissionRequest`/`PermissionCheckHandlerHandlerDetails`) at implementation time.
- Docs: amend KNOWN_LIMITATIONS #10 (iframe CSP) with one sentence ("iframes are denied every browser permission; only the app document may request microphone audio"). DEPENDENCY_UPGRADE_REPORT_2026-09-23: note the regression and the fix.

### 4.2 ERR-6 MEDIUM — `shell.openPath` blocklist misses Windows script types → switch to an allowlist
**Phase:** 4 · **Depends on:** none · **Effort:** S
**Files:**
- `src/main/ipc/media.ipc.ts`: local-path branch L370-438 (`UNSAFE_FILE_EXTENSIONS` L406-418, `launcherExtension` L432, `shell.openPath` L438). It already imports `launcherExtension` from `../../shared/untrusted` (L14).
- `src/shared/untrusted.ts`: `UNSAFE_LOCAL_FILE_EXTENSIONS` L207-219, `launcherExtension` L246-255, `asSafeOpenExternal` L271-298, `UNSAFE_LOCAL_FILE_EXTENSIONS_FOR_TESTS` L305.
- `src/renderer/components/tiles/FileTile.svelte` `handleOpen` L22-45. This is the **only** local-path opener (re-grepped; AppShell L528, LinkTile L129 and IframeTile L33 pass `https/mailto/tel` URLs only).
- `src/main/ipc/shell.ipc.ts` `shell:show-item-in-folder` (vault-bound, bare boolean).
- Tests: `src/tests/unit/sharedUntrusted.test.ts` L308-335, `characterization/untrustedSinks.test.ts` L33/L156, `mediaOpenExternalLauncherExt.test.ts` L228.

**Mechanism (re-verified 2026-09-23):** any in-vault file whose `launcherExtension` is not in the 29-entry blocklist reaches `shell.openPath`. That includes `.js`, `.jse`, `.wsf`, `.wsh`, `.vbe`, `.cpl`, `.msp`, `.psm1`, `.chm`, `.mht`, `.mhtml`, `.iso`, `.img`, `.vhd(x)`, `.docm`, `.xlsm`, `.appx(bundle)`, `.msix`, `.settingcontent-ms` and `.library-ms`. WSH runs `.js`/`.jse`/`.wsf` on double-click by default. The two copies of the list (main + shared) are "kept in sync" only by comment plus a parity test.

**Fix:**
1. **Single source of truth.** Export `OPEN_PATH_ALLOWED_EXTENSIONS: ReadonlySet<string>` from `src/shared/untrusted.ts`, plus `isOpenPathAllowed(path): boolean` (`OPEN_PATH_ALLOWED_EXTENSIONS.has(launcherExtension(path))`). Main imports it from there, so there is no second list. DECISION, the allowlist contents:
   - documents: `.pdf .txt .md .markdown .rtf .csv .tsv .doc .docx .odt .xls .xlsx .ods .ppt .pptx .odp .epub`
   - images: `.png .jpg .jpeg .gif .webp .bmp .tif .tiff .heic .avif`
   - audio: `.mp3 .wav .ogg .oga .opus .m4a .aac .flac`
   - video: `.mp4 .m4v .mov .webm .mkv .avi`
   - **Deliberately excluded:** macro-enabled Office (`.docm/.xlsm/.pptm`), archives/disk images (`.zip .7z .rar .iso .img .vhd .vhdx`, which Explorer mounts or opens as folders), and everything HTML-renderable (`.html .htm .svg .xml .mht .mhtml`, per Phase 5 / P1-10).
2. `media.ipc.ts`: delete `UNSAFE_FILE_EXTENSIONS`. After the existing trailing-dot/ADS/`assertSafeFilename` checks (keep them), add `if (!isOpenPathAllowed(target)) return { success:false, code:'EXTENSION_NOT_ALLOWED', error: 'Refusing to open file: <ext> is not an allowed document/media type' }`.
3. `untrusted.ts`: the `asSafeOpenExternal` local branch uses `isOpenPathAllowed`. Delete `UNSAFE_LOCAL_FILE_EXTENSIONS` and replace the `_FOR_TESTS` export with `OPEN_PATH_ALLOWED_EXTENSIONS` itself.
4. **DECISION: unknown extension → "Show in folder" instead.**
   - In `FileTile.handleOpen`, when `asSafeOpenExternal(abs)` is null for a local path (or main returns `EXTENSION_NOT_ALLOWED`), push a warning toast: `Filo doesn't open ".xyz" files directly.` with action `{ label:'Show in folder', handler: () => window.filo.invoke('shell:show-item-in-folder', abs) }` (`// allow-envelope-bare:` bare boolean channel). This replaces today's `reportError`.
   - Revealing is safe: Explorer selects the file and does not execute it.

**Gate:** none new. DECISION: `ci:untrusted-sinks` already polices renderer sinks. The structural pin is a test that `media.ipc.ts` contains no extension `new Set([` literal and references `isOpenPathAllowed(` before `shell.openPath(`, so the two lists can never diverge again. It is a source-scan test in `sharedUntrusted.test.ts`, which is cheaper than a gate.
**Tests:**
- `sharedUntrusted.test.ts`: replace the parity block (L308-335) with:
  - `every former blocklist extension is NOT allowed` (keep the 29 as a deny fixture);
  - `ERR-6 script types are NOT allowed` (`js jse wsf wsh vbe cpl msp psm1 chm mht mhtml iso img vhd vhdx docm xlsm`);
  - `common document/media types ARE allowed`;
  - `trailing-dot/ADS forms of an allowed ext still resolve via launcherExtension`;
  - `unknown ext (.xyz, no ext, .gitignore) not allowed`;
  - `media.ipc.ts uses the shared allowlist` (source scan).
- `mediaOpenExternalLauncherExt.test.ts`: add `readme.js → EXTENSION_NOT_ALLOWED, shell.openPath not called`; `report.pdf → openPath called`.
- `characterization/untrustedSinks.test.ts` L156: re-point to the allowlist.
- New FileTile unit in `audit19Phase4.test.ts`: `not-allowed ext → toast with Show in folder action → shell:show-item-in-folder invoked`.
- **Bite:** re-add `.js` to the allowlist → the script-type case goes red.

**Acceptance criteria:** only document/media types launch via the OS. Script, launcher and disk-image types never do, and the user gets a "Show in folder" path instead. There is one list, in `shared/untrusted.ts`.
**Risks / interactions:**
- Users with legit `.zip` or `.json` File tiles lose one-click open and gain "Show in folder". This is intended; note it in the design doc File Tile section.
- No IPC shape change beyond a new `code` value (`IpcSuccess` already carries `code`).
- Docs: CLAUDE.md is unaffected. Update the `media.ipc.ts` docstring.

### 4.3 UX-3 + ERR-5 HIGH — Sidebar delete promises undo it can't deliver, and a partial folder delete strands state and discards the snapshots
**Phase:** 4 · **Depends on:** ERR-1 (Phase 0 ERR-1, only for the board-restore half shared with UX-4), DEAD-1 absToVaultRelative (fold in) · **Effort:** L
**Files:**
- `src/renderer/stores/vaultFolderOps.ts`: `performDelete` L727-1006; confirm body L744-745; snapshot capture L786-796; post-confirm oversized toast L797-803; self-write marks L810-814; `deleteVaultPath` L818; failure toast L819-830; cascade L889. `readSnapshotForRel` L163-179, `readMediaSnapshotAndStore` L188-208 (silent `if (!result.success) return` L196, `catch {}` L205), `readSnapshotAndStore` L239-257. The file is **1018 LOC, at its ceiling** (`scripts/check-file-sizes.mjs:305`).
- `src/renderer/stores/boardFrontmatterSync.ts` L37-117 (zero-tile early return L61-63).
- `src/renderer/commands/groupAndBoardCommands.ts` `CascadeDeleteCommand` L267-530.
- `src/main/vault/fileOps.ts` `deleteItem` L418-430 (`fs.rm` with no `maxRetries`, L427).
- `src/main/ipc/vault.ipc.ts` `vault:delete` L321-359 (file is 883 LOC).
- `src/main/services/fileWatcher.ts` L578-583 (tree-suppressed deletes are not carried forward).
- `src/renderer/lib/vault/vaultOperations.ts` `deleteVaultPath` L328-335.
- `src/renderer/components/sidebar/VaultFileItem.svelte` L490-493 (the only caller of `vaultStore.delete`).
- `src/main/ipc/media.ipc.ts` L250-255 (`FILE_TOO_LARGE`).
- `src/renderer/lib/canvas/deleteTileSnapshots.ts` L16/L26 (25 MB / 5 MB caps).

**Mechanism (re-verified 2026-09-23):**
- The confirm says "The delete is undoable from the toolbar (subject to a snapshot cap)" (L744-745).
- The confirm resolves **before** anything is known about snapshot coverage.
- `readSnapshotForRel` captures only `.md`/`.markdown` and `isCascadeMediaPath` files. Everything else is skipped (comment at L177).
- A media read that fails, including `FILE_TOO_LARGE` for files over 25 MB, returns silently (L196). Only files of 5–25 MB reach `oversized`. Any throw is swallowed (L205).
- The one warning appears *after* confirm and says "The delete will still proceed" (L799).
- Main then runs `fs.rm({recursive,force})` or `fs.unlink` (fileOps L427-429). There is no Recycle Bin and no retries.
- ERR-5 (the partial delete):
  - `fs.rm` throws after it has already unlinked some children.
  - `performDelete` only toasts (L819-830). It pushes no cascade, runs no `refreshTree`, and lets `fileSnapshots`/`mediaSnapshots` go out of scope.
  - Main had `suppressTree(rel, 5000)` (vault.ipc L346-348). `fileWatcher.ts:581` deliberately does not carry tree-suppressed deletions forward.
  - The removed files are therefore never reported to the renderer, so boards keep their tiles, search keeps its hits, and edits hit ENOENT.
- Additional mechanism found while re-verifying: the zero-tile early return in `boardFrontmatterSync.ts:61-63` discards snapshots for notes that sit on no board. See DECISIONS above.

**Fix:**
0. **Verify `trashItem` semantics** (see "Must-verify" above) and record the outcome.
1. **Main: new module `src/main/vault/deleteOps.ts`**, which keeps `fileOps.ts` (782 LOC) from growing. It contains:
   - `listFilesUnder(absPath): Promise<string[]>`, a bounded recursive walk (reuse the `VAULT_TREE_MAX_NODES` cap) that returns absolute file paths.
   - `diffRemoved(preList): Promise<string[]>`, which `lstat`s each pre-listed file and returns those now `ENOENT`.
   - `deleteItemWithRetries(itemPath)`. It moves `deleteItem` here, adds `fs.rm(itemPath, { recursive:true, force:true, maxRetries: 5, retryDelay: 150 })`, and adds a bounded EBUSY/EPERM retry loop for `fs.unlink`: `[50,100,200,400,800]` ms on win32, ~1.5 s total. Re-export `deleteItem` from `fileOps.ts` for existing imports, or update the one import in `vault.ipc.ts:9`.
   - `trashItem(itemPath)`, a thin wrapper over `shell.trashItem` so tests can `vi.mock('electron')`.
2. **Main: new `src/main/ipc/vaultDelete.ipc.ts`** (`registerVaultDeleteHandlers`, registered in `src/main/ipc/index.ts` next to `registerVaultCopyHandlers`). **Move** `vault:delete` here from `vault.ipc.ts` L308-359, which takes `vault.ipc.ts` down about 50 LOC. Add `vault:trash`:
   - Guards: `assertActiveVault`, `assertWithinVault`, `assertNotInFiloDir(relativePosix(...))`, the same stat → `suppressTree`/`suppress` bracket, and `preList = await listFilesUnder(itemPath)`.
   - `await trashItem(itemPath)` → `{ success:true }`.
   - On rejection, compute `removed = await diffRemoved(preList)`:
     - `removed.length === 0` → `{ success:false, code:'TRASH_FAILED', error, files: preList.map(toVaultRel) }`.
     - Otherwise it was a partial trash → `{ success:false, code:'PARTIAL', error, removed: rel[], files: rel[] }`.
   - **It never calls `deleteItem`/`fs.rm`** (pinned by the gate below).
   - `vault:delete` gains the same `preList` + `removed` reporting. On any throw it returns `{ success:false, code, error, removed }`.
3. **Shared types** (IPC parity):
   - `src/shared/types.ts`: add `| 'vault:trash'` next to `'vault:delete'` (L12). Keep union comments free of `'` and `;`.
   - `src/shared/ipcSchemas.ts`: add `'vault:trash': z.tuple([nonEmptyString, nonEmptyString])` next to L58.
   - `src/shared/ipcContracts.ts` next to L107: a `vault:trash` result of `{ success:true } | { success:false; code?: 'TRASH_FAILED'|'PARTIAL'|string; error?: string; files?: string[]; removed?: string[] }`. Widen the `vault:delete` failure branch with `removed?: string[]`.
4. **Renderer gateway:** in `lib/vault/vaultOperations.ts`, add `trashVaultPath(vaultRoot, itemPath)` (drained, mirroring `deleteVaultPath` L328-335). Only this module may invoke `vault:trash`.
5. **Split `performDelete` out of `vaultFolderOps.ts`** into a new `src/renderer/stores/vaultDeleteOps.ts`. `vaultFolderOps.delete` (L368) becomes a one-line delegate. Also move the snapshot helpers `captureCascadeFileSnapshots`/`readSnapshotForRel`/`readMediaSnapshotAndStore`/`readSnapshotAndStore`/`findTreeNode` (L128-257). That drops `vaultFolderOps.ts` roughly 400 LOC below 1000: **remove it from the file-size ALLOWLIST** rather than lowering its ceiling. It is a split, not a bump.
   - While moving, delete `absToVaultRelative` (L230-237) and use `toVaultRelative` (DEAD-1). This closes the absolute-path snapshot-key case, because `toVaultRelative` returns `null` outside the root.
6. **New `performDelete` flow** in `vaultDeleteOps.ts`:
   - (a) First confirm, outside the drain as today. The title stays "Delete file?"/"Delete folder?". Body: `"X" (and everything inside it) will be moved to the Recycle Bin. Tile placements that reference it are removed from every board.` Drop every "undoable" claim. Confirm label: "Move to Recycle Bin".
   - (b) `withDrainedWrites`: clear the root/default-folder pins as today, capture snapshots as today, run the self-write marks as today, then `trashVaultPath`.
   - (c) **Success:** run the existing cascade unchanged (L834-996), then toast: `Moved "X" to the Recycle Bin.` If snapshots were captured, also add `Ctrl+Z restores N notes and their tiles`.
   - (d) **`PARTIAL`:** run the cascade **per removed rel** (step 7), with snapshots restricted to `removed`. Then `refreshTree`, and toast "Moved K of N files to the Recycle Bin; M are still in "X" (open in another program?)".
   - (e) **`TRASH_FAILED`:** return from the drained block with `{ files, fileSnapshots, mediaSnapshots }`. Then open the **second confirm** outside the drain:
     - Title: "Can't use the Recycle Bin".
     - Body: `Filo couldn't move "X" to the Recycle Bin (<error>). Deleting it will be PERMANENT.` Then either `Undo can't restore these M files:\n• a\n• b…` or `Undo can restore every file.`
     - Confirm label: "Delete permanently".
     - On confirm, run a new drained block. It **re-captures** snapshots (drift-safe). If the re-captured unrestorable set is **not a subset** of the set shown, abort with a toast: "A file became unreadable; nothing was deleted." Otherwise call `deleteVaultPath`, then run the cascade. On `removed` from a failed `vault:delete`, handle it as in (d).
   - (f) Keep all existing `isStillSameVault(deleteIdentity)` bails at every await, including the new second-confirm await.
7. **Cascade for partial/multi-path:**
   - Add `cascadeDeleteByVaultPaths(rels: string[], fileSnapshots, vaultRoot, mediaSnapshots)` to `boardFrontmatterSync.ts` (120 LOC). It unions `findCascadeDeleteTargets(rel)` over `rels` and emits **one** `CascadeDeleteCommand`. The existing single-path function delegates to it.
   - Change the early return at L61-63 to `if (no tiles && !hasStyleClears && no snapshots) return`, so a delete with snapshots but no tiles still pushes the command. Where no board stack is active, the push is a no-op and the Recycle Bin is the net.
8. **`CascadeDeleteCommand.undo`:** track the files the delete removed that it had no snapshot for, via a new constructor field `unrestorable: string[]`, passed from `performDelete` as `files − snapshotKeys`. When that list is non-empty, show a toast after the restore: "Restored N notes. Restore these from the Recycle Bin: …". The file is 530+ LOC and not allowlisted; check the LOC.
9. **Suppression:** `markRecentSelfWrite` currently covers only the rel plus the snapshot keys (L810-814). Extend it to every rel in the pre-confirm tree walk so non-snapshotted descendants can't leak an external-delete prompt if the watcher suppression lapses. `suppressTree` already covers most of this; this is defence-in-depth.

**Gate:**
- **New `ci:user-delete-recycle`** (`scripts/check-user-delete-recycle.mjs`). It works on string/comment-blanked, function-scoped bodies, following the `check-copy-file-source-guard.mjs` pattern:
  - (a) `vaultDeleteOps.ts` `performDelete` references `trashVaultPath(`, and any `deleteVaultPath(` inside it appears only after a `Delete permanently` confirm token.
  - (b) `vaultDelete.ipc.ts`: the `vault:trash` handler segment contains `trashItem(` and **no** `deleteItem`/`fs.rm`/`unlink`. This is the "no silent permanent fallback" pin.
  - (c) The `boardCacheDelete.ts` `deleteBoard` body (UX-4) references `trashVaultPath(`.
  - (d) The confirm-body string literals in `vaultDeleteOps.ts` contain no `/undoable/i`. That arm runs on a string-PRESERVING copy.
  - Bite-verify each arm with a temp copy: swap in `deleteVaultPath` → exit 1; add `await deleteItem(itemPath)` into the trash handler → exit 1; restore the "undoable" text → exit 1.
- **Extend `ci:no-raw-disk-shape-ipc`** (`scripts/check-no-raw-disk-shape-ipc.mjs` channel list L65-69) with `'vault:trash'`.
- **Extend `ci:no-forcreation-on-read-delete`** so `READ_DELETE_RE` (L32) also matches `trash`.
- **Update `ci:reconciler-vault-guard` Part 3** (`scripts/check-reconciler-vault-guard.mjs:475`). Move `performDelete` to `{ file: 'src/renderer/stores/vaultDeleteOps.ts', names: ['performDelete'] }` and keep `runRename` on `vaultFolderOps.ts`. The Part 3 missing-file fail-loud must stay.

**Tests:**
- `src/tests/unit/audit19Phase4Delete.test.ts` (renderer, `installFiloMock` catch-all recorder):
  - `sidebar delete: trash success → no vault:delete, cascade pushed, Recycle-Bin toast`.
  - `confirm body never claims undoable` (read `uiStore` confirm config).
  - `TRASH_FAILED → second confirm lists a .board.json, a >25 MB mp4 (media:read-file → FILE_TOO_LARGE), a .docx and an EBUSY-read .md; Cancel → no vault:delete`.
  - `TRASH_FAILED → Delete permanently → vault:delete fires once`.
  - `re-capture discovers a new unreadable file → abort, no vault:delete`.
  - `PARTIAL: removed=[a.md,b.md] → one CascadeDeleteCommand with snapshots for a,b only; refreshTree called; c.pdf tiles kept`. This is the ERR-5 bite.
  - `zero-tile .md delete still pushes an undoable command when a board stack is active`.
  - `vault swap during the second confirm → bail, no vault:delete`.
  - **Bite:** revert `performDelete` to call `deleteVaultPath` directly → the first and third cases go red.
- `src/tests/unit/vaultDeleteIpc.test.ts` (main, `vi.mock('electron')` with a fake `shell.trashItem`, real temp dir in the `renameItem.test.ts` style):
  - trash resolves → success.
  - trash rejects with the item intact → `TRASH_FAILED` + `files`, and **the file still exists on disk**.
  - trash rejects after removing one child → `PARTIAL` + `removed`.
  - `vault:delete` with a locked child (`itOnWindows` using an open handle; POSIX via a stubbed `fs.rm` throw after a partial unlink) → `removed` populated.
  - `.filo/` path refused.
  - `fs.rm` called with `maxRetries`.
- `cascadeDeleteCommand.test.ts`: add `undo toasts the unrestorable list`.
- The existing `deleteCascadeTagsFlush.test.ts`, `phase18FsIntegrityCascade.test.ts` and `audit14/16/18` delete cases re-pointed to `vault:trash` where they drive `vaultStore.delete`.

**Acceptance criteria:**
- A sidebar delete on the OneDrive vault puts the item in the Windows Recycle Bin, and restoring it there brings back every file type.
- No confirm text claims undo.
- On a volume without a Recycle Bin, the user sees a second, explicit permanent-delete confirm that names every file undo cannot restore, and nothing is deleted without it.
- A mid-delete lock leaves boards, search and the sidebar consistent with disk, and the removed part is undoable.
- `vaultFolderOps.ts` is under 1000 LOC and off the allowlist.
- `ci:verify` is green with the new gate bite-verified.

**Risks / interactions:**
- **IPC:** new channel `vault:trash`. Update `IpcChannel` (types.ts), `ipcSchemas.ts`, `ipcContracts.ts`, and **both** envelope inventories: `scripts/check-ipc-envelope-usage.mjs` `ENVELOPE_CHANNELS` (success-discriminated block, L55-58) and `src/tests/unit/ipcEnvelopeAllChannels.test.ts` `SUCCESS_DISCRIMINATED` (L59-62). The parity test scrapes both. `ci:ipc-parity` passes once the handler and union land together.
- **`ci:filo-read-guard`** is unaffected (no read primitive in either handler).
- **File sizes:** `vault.ipc.ts` shrinks (vault:delete moves out). `vaultFolderOps.ts` leaves the allowlist. The new files stay under 300–400 LOC. `boardFrontmatterSync.ts` is about +25.
- **Watcher:** keep `suppressTree` for trash. A folder moved to `$Recycle.Bin` surfaces as a delete, the same as `rm`.
- **Recycle Bin quotas:** the OS can purge the oldest items silently. Document it.
- **Docs:**
  - KNOWN_LIMITATIONS: new entry "User deletes use the Recycle Bin; in-app undo restores only snapshotted notes/small media; permanent-delete fallback on volumes without one". Take the next free number at landing (today #17; other Audit-19 groups may take numbers first).
  - Design doc §File Deletion Handling (`Filo_Design_Doc_Rework_V5.md:343-347`): sidebar delete → Recycle Bin, plus the fallback. Add a **Delete** bullet to §Vault Sidebar (L747-760).
  - CLAUDE.md: a Vault-API-contract bullet naming `trashVaultPath` + `vault:trash`, the new gate in the load-bearing list, and the gate count.

### 4.4 UX-4 MEDIUM (verifier: LOW) — Board delete is permanent: no Recycle Bin, no undo, no warning
**Phase:** 4 · **Depends on:** UX-3 steps 1-4 (`vault:trash` + `trashVaultPath`), ERR-1 (Phase 0 ERR-1, board serialisation format for the restore write) · **Effort:** M
**Files:**
- `src/renderer/components/modals/BoardBrowser.svelte` L220-236 (confirm body L225).
- `src/renderer/stores/board.svelte.ts` `deleteBoard` L562-566 → `cleanupAfterBoardRemoved` (history dropped at L155).
- `src/renderer/stores/boardCache.svelte.ts` `deleteBoard` L743-775 (`invokeOk('board:delete')` L761); `removeBoardFromCache` L722-740. The file is **1009 LOC, at its ceiling** (`check-file-sizes.mjs:379`).
- `src/main/ipc/board.ipc.ts` `board:delete` L270-282.
- `src/main/vault/boardFileOps.ts` `deleteBoardFile` L75-77 (`fs.unlink`).

**Mechanism (re-verified 2026-09-23):**
- The confirm body says the board "and its placements are removed from the vault" and does not say this is irreversible (L225).
- `boardCacheStore.deleteBoard` cancels or marks pending writes, then `board:delete` → `fs.unlink`. There is no `recovery:snapshot`, trash or undo.
- `cleanupAfterBoardRemoved` calls `historyStore.clearBoard(boardId)`, so the board's undo stack is dropped.
- Board-level Ctrl+Z is per-board, and the deleted board's stack no longer exists, so a history-command undo is not the right affordance.

**Fix:**
1. **Split first.** Move `deleteBoard` (L743-775) plus the new restore logic into a new slice `src/renderer/stores/boardCacheDelete.ts`, spread into the store the same way `tilesSlice`/`connectionsFramesSlice` are (L777-781). **Lower** `boardCache.svelte.ts`'s ceiling to its new LOC, or drop it from the allowlist if it falls under 1000.
2. In the new `deleteBoard`:
   - Capture `restore = { boardId, relPath, fileData: $state.snapshot(boardCache[boardId]), projectEntry, viewport }` **before** the IPC. Use the JSON round-trip, not `structuredClone`, on `$state` proxies.
   - `cancelBoardWrite` / `markBoardPathDeleting` as today.
   - `trashVaultPath(vaultRoot, join(vaultRoot, relPath))`.
   - On `TRASH_FAILED`, open the permanent confirm: "Can't use the Recycle Bin — delete the board permanently? You can still undo from the next notification". If confirmed, use `board:delete`.
3. After a successful removal, `pushToast({ text: 'Moved board "X" to the Recycle Bin.', actions:[{ label:'Undo', handler: restoreDeletedBoard(restore) }], duration: 10000 })`.
4. `restoreDeletedBoard`:
   - Guard with `isStillSameVault(identity)`.
   - Refuse if `boardPaths` already holds `boardId` (the user restored it from the Recycle Bin and the watcher re-discovered it). In that case toast "already restored".
   - Write via `board:save(vaultRoot, relPath, payload)` using **the same serialiser as `boardWriteScheduler.ts:392` after ERR-1**. `board:save` is `forCreation:true` (board.ipc L208), so it recreates the file.
   - Re-insert `boardPaths`/`boardCache`/`project.boards`/viewport, reusing `persistNewBoard`'s insertion lines (L665-672).
   - The board's undo history is **not** restored. DECISION: document it; history is session-scoped anyway.
5. BoardBrowser confirm body becomes: `"X" will be moved to the Recycle Bin. Its placements, connections and frames go with it; the note files stay in the vault. You can undo from the notification.` Label: "Move to Recycle Bin".
6. `board:delete` stays for the permanent fallback. Its only caller becomes the new slice.

**Gate:** covered by `ci:user-delete-recycle` arm (c) (UX-3). No separate gate.
**Tests:** `src/tests/unit/audit19Phase4BoardDelete.test.ts`:
- `delete → vault:trash with the board's abs path, no board:delete`.
- `Undo toast action → board:save with the captured payload at the same relPath, cache/paths/project restored`.
- `Undo after the board reappeared via watcher → no write, info toast`.
- `TRASH_FAILED → permanent confirm → board:delete; cancel → board still cached`.
- `vault swap before Undo → no write`.
- **Bite:** remove the trash call (restore `invokeOk('board:delete')`) → case 1 red.

**Acceptance criteria:** a board deleted by mistake is recoverable from the Undo toast (session) or the Recycle Bin (always). The confirm is honest. `boardCache.svelte.ts` does not grow.
**Risks / interactions:**
- No new channel beyond `vault:trash`. The restore payload format must follow ERR-1's single-encoding fix. If ERR-1 lands later, the restore silently inherits the double-encoding, so land it after ERR-1 or test both.
- `markBoardPathDeleting` must be cleared on restore so `writeBoardFile` isn't blocked (`boardCache.svelte.ts:756`).
- Docs:
  - Design doc §File Deletion Handling L347 ("Deleting a `.board.json` file removes the board…") → Recycle Bin + Undo toast.
  - Design doc §Board Browser (L866): mention the Undo toast.
  - KNOWN_LIMITATIONS: share the UX-3 entry and add "board undo history is not restored".

### 4.5 ERR-10 LOW — `config:load` returns the `{}` fallback on non-ENOENT errors
**Phase:** 4 · **Depends on:** none · **Effort:** S
**Files:**
- `src/main/ipc/board.ipc.ts` `config:load` L290-301 (catch → `return {}` L299).
- `src/main/vault/configOps.ts` `loadConfig` L269-300 (rethrows non-ENOENT stat errors, L283).
- `src/renderer/core/hotkeys.ts` `loadHotkeyOverrides` L296-306.
- `src/renderer/lib/boards/configWriteScheduler.ts` reappear verify L382-391 and read-back L510-513; `markCorruptConfigTarget` / `isConfigPathCorrupt` L100-137.
- `src/renderer/lib/boards/miscWriteScheduler.ts` L55 (`shouldSkipWrite: isConfigPathCorrupt`).
- `src/shared/ipcContracts.ts` L239-242.

**Mechanism (re-verified 2026-09-23):**
- `statAndAssertSize` failing with EBUSY/EPERM/EACCES is rethrown by `loadConfig`, and the handler turns it into `{}`, which is indistinguishable from "file absent".
- `loadHotkeyOverrides` then installs **empty** overrides. `hotkeys.json` is not in the corrupt set, because `config:load-all` succeeded. The next rebind writes a one-entry `hotkeys.json` through the misc scheduler, wiping every other custom binding.
- In `configWriteScheduler`, `{}` ≠ `lastWritten`, so it is read as `reappearedIsForeign = true`: a false EXTERNAL_EDIT abort.

**Fix:**
1. `board.ipc.ts` catch: `return { __loadFailed: true, error: String(err) }`, a new marker distinct from `__corrupt`. The unknown-file and inactive-vault throws take the same path, which is safer than `{}`.
2. `hotkeys.ts`:
   - Retry `config:load` with the existing `[150,400,900]` ms backoff (reuse the `loadAllConfigsWithRetry` delays exported from `vaultCandidate.ts`).
   - If it is still `__loadFailed` or `__corrupt`, call `markCorruptConfigTarget('hotkeys.json')` so `miscWriteScheduler.shouldSkipWrite` gates hotkey writes (the honest-toast machinery already exists), **keep the current in-memory overrides**, and `reportError(... 'Couldn't read .filo/hotkeys.json — shortcut changes won't be saved this session')`.
3. `configWriteScheduler.ts` L383: treat `'__loadFailed' in loaded` like the read-hiccup catch at L392-397 (permissive and **unverified**, not foreign). At L511 it is already excluded from `confirmed`, because it has no `__corrupt` key; add an explicit `!('__loadFailed' in loaded)`.
4. Contract comment in `ipcContracts.ts` L239-242: document both markers.

**Gate:** none. DECISION: three call sites of a bare channel, all covered by the tests below. `ci:check-ipc-envelope-usage` doesn't apply (bare `unknown` result).
**Tests:** `src/tests/unit/audit19Phase4.test.ts`:
- `config:load handler returns __loadFailed on EBUSY stat` (main, `vi.mock('electron')`, stub `fs.stat` rejection).
- `hotkeys: __loadFailed after retries → hotkeys.json marked corrupt, overrides untouched, misc write skipped on next rebind`.
- `configWriteScheduler reappear: __loadFailed → not foreign, no EXTERNAL_EDIT`.
- **Bite:** revert the handler to `return {}` → cases 1 and 2 go red.

**Acceptance criteria:** a transient stat error can never become "no custom shortcuts" or a fake external-edit abort.
**Risks / interactions:** `board.ipc.ts` is 506 LOC (fine). The `config:load-all` path is unchanged (it already has `__loadAllFailed`).

### 4.6 ERR-12 LOW — Quit-failure breadcrumb overwrites an unacknowledged one; no crashed-renderer handling
**Phase:** 4 · **Depends on:** none · **Effort:** M
**Files:**
- `src/main/services/quitFailureBreadcrumb.ts` `writeQuitFailureBreadcrumb` L40-63.
- `src/renderer/lib/vault/quitFailureRecovery.ts` `readQuitFailureBreadcrumb` L52-85 (the renderer reader; its schema is unchanged).
- `src/main/main.ts`: window `close` L182-285; `before-quit` L436-538; `createWindow` (no `render-process-gone`/`unresponsive` handlers; grep confirms none in `src/main`).
- `src/main/utils/windowCloseDecision.ts` `decideWindowClose` (pure) + `src/tests/unit/windowCloseDecision.test.ts`.

**Mechanism (re-verified 2026-09-23):**
- `writeQuitFailureBreadcrumb` builds `files` from **this session's** registry and `atomicWriteFile`s over `.filo/quit-failure.json`. A previous unacknowledged breadcrumb's entries are lost.
- On renderer OOM/crash, `webContents.isDestroyed()` stays false, so `decideWindowClose` starts a drain. It sends `app:flush-and-quit` to a dead renderer and waits out `FLUSH_TIMEOUT_MS` in a blank window, with no reload offer.

**Fix:**
1. **Merge:**
   - Read the existing breadcrumb (tolerate absent/corrupt → `[]`).
   - Union by `preservedPath` with the new files.
   - **Drop entries whose `preservedPath` no longer exists** (`fs.access`), because the user may have already recovered or deleted them.
   - Write only if the union is non-empty. If an existing breadcrumb is left with zero surviving entries, leave it alone; the renderer's existing clear owns deletion.
   - `savedAt` = now; keep each entry's own `at`.
2. **Crash handling.** New `src/main/services/rendererCrashHandler.ts` with `attachRendererCrashHandlers(win, deps)`:
   - `render-process-gone` (ignore `details.reason === 'clean-exit'`):
     - set `rendererGone = true`;
     - `logMainError('renderer:gone', details)`;
     - `void writeQuitFailureBreadcrumb(vaultRegistry.currentVaultPath)` (preserved partials are main-side state);
     - `dialog.showMessageBox(win, { type:'error', message:'Filo's window stopped working', detail:'Reason: <reason>. Changes typed in the last moment may not have been saved; the next vault open will offer recovery.', buttons:['Reload','Quit'], defaultId:0 })`. **Reload** → `win.webContents.reload()` (the vault reopen + `.filo/.dirty` recovery flow runs as on a fresh launch). **Quit** → `win.destroy()`.
   - `unresponsive`: **log only** (DECISION). A "Reload" offered while hung would discard in-flight writes, and the existing drain heartbeat already bounds quit.
   - `responsive`: log.
3. `decideWindowClose` gains `rendererAlive: boolean`. When false → `{ preventDefault:false, startDrain:false }` (close immediately; nothing to drain). `main.ts` L192 passes `rendererAlive: !rendererGone`. The `before-quit` path (L436-439) gets the same early `return` when `rendererGone`. Reset `rendererGone = false` on `did-finish-load` after a reload.

**Gate:** none. DECISION: pure-function units pin both halves.
**Tests:**
- `quitFailureBreadcrumb.test.ts` (existing): `merges a prior unacknowledged breadcrumb`, `drops prior entries whose preserved file is gone`, `dedupes by preservedPath`, `corrupt prior file → overwritten with the current session only`.
- `windowCloseDecision.test.ts`: `rendererAlive:false → close proceeds without drain`.
- New `rendererCrashHandler.test.ts` (`vi.mock('electron')`): `render-process-gone(oom) → breadcrumb written, dialog shown; Reload → webContents.reload`; `clean-exit ignored`.
- **Bite:** revert the merge (write session files only) → the merge case goes red.

**Acceptance criteria:** preserved-partial pointers survive until acknowledged or gone, and a renderer crash gives a Reload/Quit choice instead of a blank window and a 5 s hang.
**Risks / interactions:** no new IPC channel (dialog is main-only). `main.ts` is 557 LOC, fine. The breadcrumb stays in `RENDERER_PERMITTED_FILO_PATHS`. This interacts with EXT-6/ERR-8 (machine-keyed sentinels, Phase 1): if that phase keys `.filo/*` sentinels by machine, apply the same key to `quit-failure.json` here.

---

### 4.7 ERR-11 LOW — Path depth capped at 10; the `.tmp` suffix makes 239–255-char names unwritable
**Phase:** 4 · **Depends on:** ERR-2 (Phase 0 ERR-2, which edits the same `assertSafeFilename` L193 + `pathSecurity.test.ts`) · **Effort:** S
**Files:**
- `src/main/utils/pathSecurity.ts`: `assertSafeFilename` L185-229 (255-char cap L203); `MAX_VAULT_PATH_DEPTH = 10` L237; depth check L286-290.
- tmp-name sites: `src/main/vault/filenameUtils.ts:183` (`atomicWriteFile`), `src/main/vault/fileOps.ts:383` (cross-device rename copy), `src/main/vault/fileOps.ts:585` (`copyFileToVault`).
- `src/renderer/lib/boards/writeErrorToast.ts:54` (regex `/data preserved at (.+\.tmp)\)/`); watcher/tree `.tmp` filters (`fileWatcherClassify.ts:39`, `fileOps.ts:152`, `fileWatcher.ts:736`).
- `src/tests/unit/pathSecurity.test.ts` L285-293.

**Mechanism (re-verified 2026-09-23):**
- Every relpath channel rejects 11 or more segments, but `readDirectoryTree` has only node-count and size caps (`VAULT_TREE_MAX_NODES` fileOps L31), so deep files show in the sidebar and then fail every read and write.
- `assertSafeFilename` allows 255-char segments, but `${filePath}.${12hex}.tmp` adds 17 chars. The NTFS component limit is 255, so writes to names of about 239 characters or more fail with ENAMETOOLONG.

**Fix:**
1. `MAX_VAULT_PATH_DEPTH = 64`, plus a new `MAX_VAULT_RELATIVE_PATH_LENGTH = 4096` total-length check in `assertSafeRelativePath`. That is still a pathological-payload bound. Node on Windows uses `\\?\` namespaced paths for fs, so MAX_PATH 260 does not apply to Filo's own IO. Update the docstring.
2. New helper `tmpSiblingPath(finalPath: string, nonce: string): string` in `filenameUtils.ts`. It returns `${dir}/${base}.${nonce}.tmp`, but when `base.length + 1 + nonce.length + 4 > 255` it truncates `base` (by UTF-16 code units, and never splits a surrogate pair) so the component is ≤ 255. Use it at all three tmp sites.
3. The preserved-tmp regex (`writeErrorToast.ts:54`) and the `.tmp` filters are unaffected, because the suffix is unchanged.

**Gate:** none. DECISION: a constant and a helper with three call sites, pinned by the tests. Add a source-scan test that no `` `${…}.${nonce}.tmp` `` template remains outside the helper.
**Tests:**
- `pathSecurity.test.ts`: `accepts 11..64 segments`, `rejects 65`, `rejects total length > 4096`.
- New `filenameUtils.test.ts` cases: `tmpSiblingPath keeps a 255-char basename's tmp ≤ 255`, `surrogate-pair safe`, `short names unchanged`.
- An `atomicWriteFile` real-tmpdir write of a 250-char name succeeds (itOnWindows plus POSIX, where ext4 also has a 255 limit).
- A source scan for stray tmp templates.
- **Bite:** revert `atomicWriteFile` to the raw template → the 250-char write fails with ENAMETOOLONG.

**Acceptance criteria:** any file the sidebar lists within 64 levels can be opened and saved, and a 255-char name saves.
**Risks / interactions:** coordinate with ERR-2's edits to the same function. KNOWN_LIMITATIONS: one line in the new entry (or a new small entry) noting "vault paths deeper than 64 levels / longer than 4096 chars are refused".

### 4.8 UX-5 MEDIUM (verifier: LOW) — Vault-wide tag rename/delete uses native `confirm()` and cannot be undone
**Phase:** 4 · **Depends on:** none · **Effort:** M (5a: S, 5b: M)
**Files:**
- `src/renderer/components/tags/TagsBrowser.svelte`: `saveEdit` L93-131 (native `confirm` L117, and **no confirm at all** for a childless rename); `deleteTagByName` L133-139 (native `confirm` L134).
- `src/renderer/stores/fileTags.svelte.ts`: `renameTagEverywhere` L1112-1172, `removeTagEverywhere` L1181-1227. The file is **1252 LOC, at its ceiling** (`check-file-sizes.mjs:369`).
- `src/renderer/stores/fileTagsCascade.svelte.ts` (317 LOC): `commitTagRemovalInMemory` L241-263, `runTagRewriteSweep` L134-148.
- `src/renderer/lib/vault/tagRewriter.ts` `addTagToMarkdown` L602.

**Mechanism (re-verified 2026-09-23):**
- Both prompts are `window.confirm`, which blocks the renderer event loop, including debounced write timers.
- `removeTagEverywhere` rewrites the frontmatter of every tagged `.md` and commits the registry, tile, inline and board-settings removal. There is no `historyStore` involvement and nothing to undo.
- The dialog does not say the change is permanent or how many files it touches.
- A rename into an **existing** tag name merges the two. That cannot be inverted by renaming back.

**Fix:**
- **5a (themed confirm):**
  1. Add a `confirmAsync(config): Promise<boolean>` wrapper around `uiStore.openConfirm`, put next to it in `stores/ui.svelte.ts`. Sweep for other Promise-wrapper duplicates (`vaultFolderOps.ts:746-756` builds the same thing inline) and reuse it there.
  2. Delete confirm: `danger:true`, title `Delete tag "#work"?`. Body: `Removes the tag from N notes and M tiles/attachments across every board. You can undo from the notification that follows.` Count N from `vaultIndexStore.allMetadata()` tag membership and M from `fileTagsStore` + tile defs. Label: "Delete tag".
  3. Rename with children: keep the orphan-children warning text in the themed dialog.
  4. Rename into an existing name: new dialog `Merge "#a" into "#b"? This can't be undone.`
  5. Childless rename to a new name: no confirm (the rename is reversible by 5b).
- **5b (undo via toast, not history). DECISION:**
  - Tag ops are vault-scoped. Per-board history is the wrong owner, because it would file the undo on whichever board happens to be active (the ReplaceAll precedent is exactly that quirk).
  - New module `src/renderer/stores/tagUndo.svelte.ts` holds `removeTagWithUndo(name)` and `renameTagWithUndo(old, new)`.
  - (i) Snapshot before the op: the registry def (colour, etc.); `fileTags` entries for attachments; `.md` paths whose FM carries the tag; tile/def/inline ids with the tag's **index** in each `tags` array; the board-settings chip locations (savedViews/lastView), from `cascadeTagToBoardSettings`'s scan.
  - (ii) Call the store op. **Change its return type** to `Promise<{ committed: boolean; writtenPaths: string[] }>`, net-zero LOC in `fileTags.svelte.ts` (the `return;` lines become `return { committed:false, writtenPaths:[] }` and the result is already in scope).
  - (iii) On `committed`, push a toast with an **Undo** action (duration 15 s).
  - Removal undo:
    - Re-add the tag to exactly `writtenPaths` through a gateway-routed add sweep (new `runTagAddSweep(tag, paths, vaultRoot)` in `fileTagsCascade.svelte.ts` built on `addTagToMarkdown` + `writeMarkdownAndReconcile`).
    - Re-insert tile tags at their recorded indices.
    - Restore the registry def + `fileTags` + board-settings chips.
    - Flush with the same `flushPendingSave` + `flushTagRewriteBoardWrites` ordering the forward op uses.
  - Rename undo (only when the target did not exist before) = `renameTagEverywhere(new, old)` plus a registry colour restore. A merge offers no Undo.
  - TagsBrowser calls the `*WithUndo` wrappers.

**Gate:**
- **Extend `ci:reconciler-vault-guard` Part 1** to scan `src/renderer/stores/tagUndo.svelte.ts`. It reads `vaultStore.path`/`allMetadata` and awaits, so every undo handler must `isStillSameVault(identity)` after its awaits. Bite-verify by dropping one guard.
- No `no-native-confirm` gate. DECISION: after 5a there are **zero** `confirm(` call sites in `src/renderer` (re-grepped: only `TagsBrowser.svelte:117,134` today), matching the Audit-18 7.3 precedent of not gating a zero-instance class. The strict test below pins it instead.

**Tests:** `src/tests/unit/audit19Phase4Tags.test.ts`:
- `delete opens uiStore confirm (danger, counts N/M), never window.confirm` (spy `window.confirm` → not called).
- `cancel → no sweep`.
- `delete → Undo → FM tag re-added to exactly the written paths, tile tag restored at original index, registry colour restored`.
- `rename to new name → Undo → renamed back`.
- `merge rename → no Undo action`.
- `vault swap before Undo → no writes`.
- **Bite:** have `deleteTagByName` call `removeTagEverywhere` directly → the Undo case goes red.
- Plus `tagRewriter.test.ts`: `addTagToMarkdown is the inverse of removeTagFromMarkdown on the hostile FM corpus` (byte-equal where the original list ended with the tag; position-insensitive otherwise, documented).

**Acceptance criteria:** no native dialogs remain in the renderer. Tag delete says what it will touch and is undoable for 15 s. A merge warns that it is irreversible. `fileTags.svelte.ts` does not grow.
**Risks / interactions:**
- Undo re-adds the tag at the end of a FM `tags:` list when it wasn't last, so the order may differ; document it.
- A note edited between the op and the Undo is handled correctly, because the add sweep reads fresh disk (M2 pattern).
- `ci:md-writers-reconcile-editors`: the add sweep must use `writeMarkdownAndReconcile`.
- Docs: design doc Tags Browser bullet (L686) should mention the Undo; KNOWN_LIMITATIONS: "tag merge is irreversible; undo may reorder FM tag lists".


---

## Phase 5 — Tests, CI, docs and dead code

**Group D planner notes (Phase 4 + 5 scope):** UX-3, ERR-5, UX-4, UX-5, DEP-3, ERR-6, ERR-10, ERR-11, ERR-12 (Phase 4); CI-1, DEP-5, CI-2, DEAD-1, DOC-1, DEP-6, plus the new **editor-level integration suite** (Phase 5).
**Probes run for this plan (scratchpad only, no repo edits):**
- `tsc -p tsconfig.main.json --noEmit` → exit 0 (main is clean today).
- A tests-only tsconfig probe (extends `tsconfig.json`, includes `src/tests/unit|helpers|setup.ts`): **1384 errors / 246 files** under the repo's strict flags; **373 errors / 131 files** with `noUncheckedIndexedAccess: false` and e2e excluded.
- A full `vitest run`: 4914 passed / 1 skipped. stderr holds **220** yaml `Keys with collection values will be stringified` warnings and **4** esbuild `Duplicate key` warnings.
- **The full unit suite run with `resolve.conditions: ['browser']` added: 484 files / 4914 tests pass.** Svelte 5 `mount()` only works under that condition. Without it the server build loads and `mount(...)` throws `lifecycle_function_unavailable`.
- **Real-component jsdom harness (the basis for the editor suite and the DEP-5 decision).** I mounted the real `TextTile.svelte` with `mount()`, the real TipTap editor, a recording `window.filo` stub and `vaultStore.setPath('/vault')`, then:
  - Mount, hydrate, then **unmount with no edit** → `vault:write-existing-file-text("Note.md", "# Hello\n\nSome *emphasis* here.\n\n# Setext")` from a source of `...Some _emphasis_ here.\n\nSetext\n======\n`. This reproduces **MD-2** in jsdom.
  - Mount, hydrate, then **Ctrl+Z** keydown on `.ProseMirror` → `vault:write-existing-file-text("Note.md", "\n")`. This reproduces **MD-1** in jsdom. The note is emptied.

---

### 5.1 CI-2 LOW — Unit-test stderr noise that the strict runner doesn't catch
**Phase:** 5 · **Depends on:** none · **Effort:** S
**Files:** `src/tests/unit/taskListModel.test.ts` L36-52 (`placement`, `tile` at L37-38 then again at L51-52); `src/tests/unit/taskListFilter.test.ts` L~33-48 (same shape, L47-48); `src/tests/unit/boardStoreRenameTextTile.test.ts` L83/L86 and `src/tests/unit/textTilePath.test.ts` L11/L14 (TS2783 duplicates found by the tests-tsconfig probe; esbuild doesn't warn on these); `scripts/test-unit-strict.mjs` `NOISE_PATTERNS` L18-21; the yaml warning source is `frontmatterInvariant.test.ts` L210-211 (hostile `[a, b]: x` / `{k: 1}: x` keys) through the production `parseDocument().toJS()` sites `src/renderer/lib/vault/frontmatterRead.ts:56`, `lib/editor/markdownSync.ts:126`, `lib/vault/frontmatterCstModel.ts:227/410/434`, `lib/vault/tagRewriter.ts:143`.
**Mechanism (re-verified 2026-09-23):**
- A full run writes 261 stderr lines: **220** yaml `Keys with collection values will be stringified` process warnings and **4** esbuild `Duplicate key "tile"/"placement"`.
- `test-unit-strict.mjs` only matches the missing-`window.filo` TypeErrors.
- The yaml warning is also emitted in **production** for a note with a collection key (`console.warn` in the renderer). Stringifying is deliberate, documented behaviour (5.4 Audit-16), so the warning is pure noise.

**Fix:**
1. Delete the first `placement,`/`tile,` pair (L37-38 in `taskListModel.test.ts`, equivalent in `taskListFilter.test.ts`). The later deep-merge lines already produce the correct value. Remove the duplicate `id`/`title` keys in the other two files the same way.
2. Pass `{ logLevel: 'error' }` (a yaml 2.9.1 `DocumentOptions` field; `addPairToJSMap.js:57` gates the warning on `ctx.doc.options.logLevel`) at every production `parseDocument` site listed. Merge it into the existing `{ uniqueKeys: true }` objects. No behaviour change: stringification is unchanged.
3. `test-unit-strict.mjs`: extend `NOISE_PATTERNS` with `/Duplicate key ".*" in object literal/`, `/Keys with collection values will be stringified/`, `/effect_update_depth_exceeded/`, `/\[svelte\] (?:state_unsafe_mutation|ownership_invalid_mutation)/`. Scan **stdout + stderr**: vite warnings go to stdout, so widen `tee` matching to both buffers. Keep the docstring rationale.

**Gate:** the widened `test:unit:strict` (already in `ci:verify`). Bite-verify: re-add one duplicate key → strict run exits 1; drop `logLevel` at `frontmatterRead.ts:56` → exits 1.
**Tests:** add `frontmatterRead.test.ts`: `collection key parses without emitting a process warning` (spy `process.emitWarning` / `console.warn`).
**Acceptance criteria:** `npm run test:unit` stderr holds no warnings, and any new Svelte effect-loop or duplicate-key warning fails CI.
**Risks / interactions:** `frontmatterCstModel.ts` / `tagRewriter.ts` are pinned by `ci:frontmatter-invariant` and `ci:no-jsyaml-in-frontmatter`. The option change is outside their token pins, but run both.

### 5.2 CI-1 LOW — Main and test sources aren't type-checked in `ci:verify`; CI is Linux-only; coverage floor lowered
**Phase:** 5 · **Depends on:** CI-2 (the duplicate-key fixes remove 4 of the test type errors) · **Effort:** M
**Files:** `package.json:16` (`check`), `:67` (`ci:verify`); `tsconfig.json` L21-25 (includes renderer + shared only); `tsconfig.main.json` (not referenced by any script); `.github/workflows/ci.yml` L20-36 (`verify` on `ubuntu-latest` only); `vitest.config.mts` L20-41 (branches 70); Windows-only tests (`itOnWindows` in `renameItem.test.ts`, `renameItemCaseRename.test.ts`, `activeVaultCheck.test.ts`, `copyFileSourceGuard.test.ts`, `fileWatcherRename.test.ts`, `mediaOpenExternalLauncherExt.test.ts`, `audit14Phase4.test.ts`, `audit16Phase4.test.ts`); `.gitattributes` (`* text=auto eol=lf`, so a Windows checkout stays LF).
**Mechanism (re-verified 2026-09-23):**
- `tsc -p tsconfig.main.json --noEmit` exits 0 today, but nothing runs it, and electron-vite/esbuild strips types.
- `src/tests` is outside every tsconfig. The probe found **1384** errors under the repo flags, and **373 in 131 files** with `noUncheckedIndexedAccess:false` and e2e excluded (178× TS2769 overloads, 48× TS2345, 43× TS2741 missing props, 4× TS2783 duplicate keys, …).
- Every CI job is `ubuntu-latest`, so `itOnWindows` cases never run in CI.
- `vitest.config.mts` branches went 80→70. The comment explains that 80 was never actually measured (the first real run was 67.3%), so it is a first real floor, not a ratchet-down.

**Fix:**
1. `package.json`: `"typecheck:main": "tsc -p tsconfig.main.json --noEmit"`, inserted into `ci:verify` right after `npm run check`.
2. New `tsconfig.tests.json` at the root: extends `./tsconfig.json`, `noUncheckedIndexedAccess: false` (DECISION: fixtures index freely; the production flag stays strict), `types: ["vitest/globals","node"]`, includes `src/tests/unit/**/*.ts`, `src/tests/helpers/**/*.ts`, `src/tests/setup.ts` and `src/renderer/**/*.d.ts`. e2e is excluded: it imports `/src/renderer/...` via the Vite dev-server harness, and those 74 TS2307 errors aren't fixable by config.
3. New ratchet `scripts/check-test-typecheck.mjs` (`ci:test-typecheck`):
   - Runs `tsc -p tsconfig.tests.json --noEmit --pretty false` and parses per-file error counts.
   - Fails when any file **exceeds** its entry in a `BASELINE` map (seeded from today's 131 files / 373 errors) **or** a file not in `BASELINE` has any error.
   - Prints "ratchet down" hints when a file improves.
   - This follows `ci:file-sizes`, so new test code is fully typed from day one and the backlog only shrinks.
4. `.github/workflows/ci.yml`: new job `verify-windows` (`runs-on: windows-latest`, `needs: []`) running `npm ci` + `npm run test:unit:strict` + `npm run typecheck:main`. DECISION: not the full `ci:verify`. The ratchet scripts are platform-agnostic, so doubling `build` + 48 guards would only double runtime; the Windows value is the `itOnWindows` tests and the case-insensitive fs paths. Update the workflow header comment.
5. `vitest.config.mts`: keep 70. Tighten the comment to "first measured floor; ratchet up only". Raising it is a separate ratchet as coverage grows.

**Gate:** `ci:test-typecheck` (new ratchet) + `typecheck:main` in the chain. Bite-verify: introduce a type error in a scratch copy of a clean test file → exit 1; in `src/main/ipc/*.ts` → `typecheck:main` exit 2.
**Tests:** none new (CI plumbing). First Windows CI run must be green; if not, fix or `itOnWindows`-gate the offenders in the same PR.
**Acceptance criteria:** a wrong IPC payload type in `src/main` fails `ci:verify`, new test files must type-check, and Windows-only tests run on every push.
**Risks / interactions:** `ci:verify` gains about 2 s (tsc main) + about 5–8 s (tsc tests). Windows runner minutes cost about 2× Linux. CLAUDE.md Quick Reference: add `typecheck:main`, `ci:test-typecheck` and the Windows job; update the gate count and ordered chain text.

### 5.3 DEP-5 LOW — The Svelte phantom-write guard is E2E-only while svelte is a caret range
**Phase:** 5 · **Depends on:** editor-level integration suite · **Effort:** S (on top of the suite)
**Files:** `package.json:134` (`"svelte": "^5.57.1"`); `package-lock.json:9534-9537` (locked 5.57.1); `.github/workflows/ci.yml` e2e job L86-106 (`workflow_dispatch` only); `src/tests/e2e/documentOpenNoWrite.test.ts`; commit `90e4092` (the §0.2 fix: `setEditorEditable` + pin widened).
**Mechanism (re-verified 2026-09-23):** only the manual E2E opens a real document and checks the bytes. `npm ci` pins 5.57.1 via the lock, but any lock refresh can move within `^5`. `ci:verify` has no open-without-write check. The 90e4092 E2E docstring claims "only the built renderer … reproduces it". That was true of the jsdom suite as configured (no `browser` condition → server build), but the probe shows the real client runtime mounts fine in jsdom once the condition is set.
**Fix:**
- **DECISION: promote open-without-write to the jsdom component suite (`editorIntegration/documentEditorOpen.test.ts` + `textTileLifecycle.test.ts` (a)) and keep the caret.** Justification:
  - A pin only stops accidental drift. It detects nothing, and the same class of regression can come from *our* effect code (MD-2 is exactly that and is independent of the Svelte version).
  - The jsdom harness runs the real Svelte client runtime and real TipTap and already reproduces two phantom-write bugs, so it guards every version and every code change on every push.
  - A pin also blocks the Svelte security and bug-fix patches the caret exists to receive.
1. **Bite-verify against the original regression**, a mandatory acceptance step:
   - In a scratch branch, restore the raw `editor.setEditable(...)` call from `git show 90e4092^:src/renderer/components/boards/DocumentEditor.svelte` (only the close-drain effect), keep svelte 5.57.1, and run `documentEditorOpen.test.ts`. It must go **red** (a write fires and/or `effect_update_depth_exceeded` is logged).
   - **Fallback:** if jsdom cannot reproduce it, pin `"svelte": "5.57.1"` exactly with a `// DECISION:` note in DEPENDENCY_UPGRADE_REPORT, and keep the E2E as the only guard until a harness reproduces it.
2. Keep `e2e/documentOpenNoWrite.test.ts` (it remains the real-Electron check) and reword its docstring to point at the unit twin.

**Gate:** covered by the extended `ci:markdown-body-roundtrip` (the `DocumentEditor` + `effect_update_depth_exceeded` tokens).
**Tests:** see the suite. The bite is step 1.
**Acceptance criteria:** a Svelte bump that reintroduces an open-path write fails `ci:verify`.
**Risks / interactions:** DEPENDENCY_UPGRADE_REPORT_2026-09-23: record the decision.

### 5.4 DEAD-1 LOW — Dead or duplicate code (each symbol grep-confirmed 2026-09-23)
**Phase:** 5 (except `absToVaultRelative`, folded into UX-3) · **Depends on:** UX-3 step 5 for `absToVaultRelative` · **Effort:** S
**Files and grep evidence** (non-test `src` references / test files / scripts):

| Symbol | Location | Non-test refs | Tests | Action |
|---|---|---|---|---|
| `UpdatePlacementStyleCommand` | `src/renderer/commands/taskCommands.ts:613` | 1 (definition) | `taskListPlacementCommands.test.ts:7,21,117` | Delete the class and its `describe` block. The UI uses `UpdateTaskItemStyleCommand` (`styleCommands.ts:173`, used by `TaskItemStylePopup.svelte:15`). |
| `defaultConnectionLabelFontSize` | `lib/styles/defaultFontSizes.ts:48` | 1 | 0 | Delete |
| `defaultFrameFontSize` | `defaultFontSizes.ts:53` | 1 | 0 | Delete |
| `defaultKanbanColumnFontSize` | `defaultFontSizes.ts:58` | 1 | 0 | Delete |
| `defaultTaskListTitleFontSize` | `defaultFontSizes.ts:77` | 1 | 0 | Delete |
| `TAGS_FILE_RELATIVE_PATH` | `schema/tagsFile.ts:43` | 1 | 0 | Delete |
| `__resetCloseDrainGateForTests` | `lib/editor/closeDrainGate.svelte.ts:69` | 1 | 0 | Delete |
| `__baselineCountForTests` | `lib/vault/fileBaselineRegistry.ts:271` | 1 | 0 | Delete |
| `absToVaultRelative` | `stores/vaultFolderOps.ts:230` | 2 (def + L156) | 0 | Replace with `toVaultRelative`, which returns `null` outside the root (the caller already `continue`s on falsy). Done in UX-3 step 5. |
| `toVaultRelative` (misplaced) | `lib/vault/vaultTreeSort.ts:178` | 8 | `vaultTreeSortHelpers.test.ts` | Move to `lib/utils/path.ts` and re-point the imports. Keep a re-export in `vaultTreeSort.ts` only if more than 8 importers make it noisy; otherwise update all. |
| `normalizeTags` alias | `lib/vault/frontmatterSync.ts:61` | 5 importers (`markdownTileSeed.ts:2`, `vaultIndex.ts:7`, `vaultExternalChanges.ts:10`, `vaultExternalDriftPrompts.ts:27`, `vaultExternalPrompts.ts:36`) | 1 | Re-point to `normalizeTagsField` from `lib/utils/normalizeTagsField.ts` and delete the alias. |

Unused imports, confirmed by running `eslint` on the five files (5 × `@typescript-eslint/no-unused-vars` warnings):
- `noteBaseline` at `lib/boards/boardWriteScheduler.ts:40`;
- `boardCacheStore` at `lib/kanban/kanbanMultiSelect.svelte.ts:2`;
- `const boardStore = scope.board` at `components/tiles/ImageTile.svelte:8` and `IframeTile.svelte:7` (check `scope` is still used elsewhere; drop `scope` too if not);
- `type RelinkContext` at `components/modals/RelinkTileModal.svelte:29`.

**Mechanism (re-verified 2026-09-23):** as tabulated. None has runtime impact. The absolute-path snapshot key (`absToVaultRelative` returning the abs path) is theoretical, because the walk only visits nodes under the vault root.
**Fix:**
1. Delete or move as tabulated.
2. Make `lint` fail on warnings: `"lint": "eslint . --max-warnings 0"`. First run `npx eslint .` for the current total; if other warnings exist, use `--max-warnings <current>` as a ratchet and record it in CLAUDE.md Quick Reference.

**Gate:** the `lint` warning ratchet (in `ci:verify`). Bite-verify: re-add an unused import → exit 1.
**Tests:** delete the `UpdatePlacementStyleCommand` describe. `ci:command-roundtrip-coverage` auto-discovers subclasses, so deleting class and test together keeps it green; confirm there is no `ROUNDTRIP_EXEMPT` entry naming it (grep: none in `scripts/`). Re-point `vaultTreeSortHelpers.test.ts`.
**Acceptance criteria:** zero ESLint unused-var warnings in production code, no zero-importer exports from this list, and a single path-relativiser.
**Risks / interactions:** `defaultFontSizes.ts` may be covered by the `lib/**` coverage thresholds, since deleting uncovered functions raises coverage. `taskCommands.ts` shrinks from 682 to about 610.

### 5.5 DEP-6 LOW — Zod 4 `.int()` rejects integers above 2^53, so such boards fail to load
**Phase:** 5 · **Depends on:** none · **Effort:** S
**Files:** `src/renderer/schema/placement.ts:98,114`; `src/renderer/schema/board.ts:395,478,482,528`; `src/renderer/schema/tagsFile.ts:36`; `src/renderer/schema/layoutTemplate.ts:53-56,88`; `src/renderer/schema/settings.ts:272` (bounded, unaffected); `src/renderer/schema/connection.ts:30` (bounded).
**Mechanism (re-verified 2026-09-23):** Zod 4 `.int()` means a safe integer. Only unbounded `.int()` fields change behaviour. The verifier's differential found only the 1e20 cases.
**Fix:**
- **DECISION: accept the stricter behaviour** (it is more correct: positions above 2^53 aren't representable exactly anyway, and every reorder would corrupt them). No preprocess clamp.
1. KNOWN_LIMITATIONS new entry: "Board/tags/template integer fields above 2^53 (Number.MAX_SAFE_INTEGER) fail validation; the board is refused with a recovery snapshot + toast rather than loaded". Include the field list and the recovery path.
2. DEPENDENCY_UPGRADE_REPORT_2026-09-23: add a line under the Zod 4 section.

**Gate:** none.
**Tests:** new `src/tests/unit/zodSafeIntegerBoundary.test.ts`: `position = 2**53-1 accepted`, `position = 2**53 rejected`, and the same for `wipLimit`, `TaskListSection.position` and `TagsFile.version`. Plus one through the real board loader: `a .board.json with position 1e20 → failedBoards + recovery snapshot, not a crash`. This pins the behaviour so a future Zod change is noticed.
**Acceptance criteria:** the behaviour is documented and pinned.
**Risks / interactions:** none.

---

### 5.6 DOC-1 LOW — CLAUDE.md, the design doc and code comments contradict the code
**Phase:** 5 (last, after every other Group D item so the counts are final) · **Depends on:** everything above; UX-6 (Phase 1 UX-6, toast persistence) · **Effort:** S
**Files and confirmed drifts:**
- `CLAUDE.md:32`: "**13** as of Audit-14". The `ALLOWLIST` in `scripts/check-file-sizes.mjs` has **12** entries (L53, 66, 79, 115, 121, 131, 286, 305, 369, 379, 491, 538). After this group: vaultFolderOps leaves (UX-3), and boardCache possibly leaves (UX-4).
- `CLAUDE.md:27,30`: "48 × ci:*" (`package.json` has 49 `"ci:` keys, 48 guards + `ci:verify`). Recount after `ci:user-delete-recycle` + `ci:test-typecheck`.
- `CLAUDE.md` tree entries that don't exist:
  - `components/shared/Dropdown.svelte` (L339). It lives at `components/layout/Dropdown.svelte`.
  - `components/boards/DocumentBoard.svelte` (L370).
  - `lib/connections/connectionSelection.ts` (L289).
  - `lib/canvas/viewport.ts` (L275).
  (Found by a scripted existence check of every filename in CLAUDE.md.)
- `CLAUDE.md:614`: `window.api.vault.read(path)`; the real call is `window.filo.invoke('vault:read-file-text', vaultRoot, rel)`.
- `Filo_Design_Doc_Rework_V5.md:341`: dirty flag "in `.filo/workspace.json`". It is `.filo/.dirty` (`dirtyFlagRecovery.ts`).
- Design doc L882: "maximum of 10 toasts". `ui.svelte.ts:370` `TOAST_CAP = 8`. The same line says conflict toasts persist; make the text match whatever UX-6 lands (sticky → persistent is correct again).
- `src/renderer/lib/editor/closeDrainGate.svelte.ts:25-26` describes a raw `editor.setEditable(...)` call; the code uses `setEditorEditable(...)` (`lib/editor/setEditorEditable.ts:19`).
- `src/renderer/stores/vaultExternalDriftPrompts.ts:83`: "Persistent toast (duration: 0)". This is correct only if UX-6 makes it sticky; otherwise fix the comment.

**Mechanism (re-verified 2026-09-23):** as listed.
**Fix:**
1. Regenerate the allowlist count, gate count and ordered chain from `scripts/check-file-sizes.mjs` + `package.json` `ci:verify`.
2. Fix the four tree entries: move Dropdown, remove the three that don't exist, add the new files from this group (`vaultDeleteOps.ts`, `boardCacheDelete.ts`, `tagUndo.svelte.ts`, `vaultDelete.ipc.ts`, `deleteOps.ts`, `rendererCrashHandler.ts`, `permissionPolicy.ts` (missing from the tree today), `tests/helpers/mountEditor.ts`).
3. Fix the gotcha to `window.filo.invoke(...)`.
4. Fix the design-doc lines and the two comments.
5. Add the new gates to the load-bearing list.
6. Add `scripts/check-claude-md-paths.mjs`? DECISION: no gate. Docs drift is caught by this periodic audit, and a path-existence gate over free-form prose would false-positive on intentional "does not exist" mentions (`vaultApi.ts`, `components/common/icons/`). Record the one-liner check used here in the plan instead.

**Gate:** none (justified above).
**Tests:** none.
**Acceptance criteria:** every file path named in CLAUDE.md's tree exists, the counts match the scripts, and the design doc matches the dirty-flag, toast-cap and deletion behaviour.
**Risks / interactions:** land last in Group D, after the counts settle.


---

## Refuted or narrowed during planning (do NOT chase)

- **MD-11 (Mind Map repro):** every Mind Map add stamps `filePath`, so the Mind Map path is fine. The bug is real only for Kanban cards that mount `TextTile`; fixed in 2.1.
- **MD-3 severity nuance:** data is lost only when the note has **real frontmatter**. Without frontmatter the intro is hidden but kept. The fix is unchanged, and it must also fix `taskCreation.ts:184`, which seeds a full file into the body-only store.

- **ERR-3's specific trigger, "OneDrive names the copy `Plan-DESKTOP-ABC.board.json` and Dropbox `Plan (conflicted copy …).board.json`, so the conflict copy always wins."** The documented schemes (Microsoft's `Report-JOHNS-SURFACE.txt`, Dropbox's "username + conflicted copy + date added to the filename", iCloud's `abc 2.txt`) all insert before the **last** extension, which gives `Plan.board-HOST.json`. `scanBoardFiles` never lists that (case-folded `.board.json` suffix), so no hijack happens through those clients. The real outcome is the invisible fork, which ERR-3 step 3 addresses. The first-wins tie-break is still fixed, because it is reachable through compound-suffix copies.
- **UX-6: "the 15 s toast cap is a bug."** It is deliberate (Audit5 R3: don't blanket, don't strand a promise). The plan keeps the cap for promise-backed toasts and makes only non-promise decision toasts sticky.
- **ERR-8: "init seeds defaults that overwrite the user's settings."** Seeding runs only when `pathExists` is false (configOps.ts:157). It can't overwrite an existing local file. The residual is a sync-client *conflict copy* when the real file arrives later, handled narrowly in EXT-6 step 6.
- **EXT-1's suggested sub-fix, "expand a `tree` rename into descendant paths from the last reconcile snapshot inside the live batch."** Not chased: `reconcileNow` already synthesises the per-child renames from its snapshot diff. The plan triggers it (`vault:reconcile`) and defers eviction, rather than adding a second expansion path to `fileWatcher.ts` (994 LOC).
- **EXT-5: "Stay open and retry does nothing."** Only half right: it does correctly cancel the quit (6.2.H4). What's missing is the retry, which the plan adds. Nothing to fix in the cancel path itself.
- **EXT-3: "the 15 s auto-dismiss narrows the window, so it's low risk."** Moot. After UX-6 the deleted-toast is sticky, so the re-probe (EXT-3 step 1) becomes *more* necessary, not less.

**New defects found during planning** (already folded into the steps above):
- `boardFrontmatterSync.ts:61-63` drops the delete snapshot when no tile references the file, so even plain `.md` sidebar deletes aren't undoable. With no board tab open nothing is undoable at all (in 4.3).
- `frontmatterSync.tileBacksMarkdownPath` also matches the root `${title}.md` when a tile has a different explicit `filePath` (in 2.1).
- The Kanban placeholder variant of MD-5: frontmatter is seeded but the body is empty (in 0.9).
- EXT-8 is wider than reported: the main-side watcher also drops the event, and `tags:save` overwrites blindly (in 1.12).
- EXT-6 also occurs with **sequential** use of two machines, not only concurrent use (in 1.10).

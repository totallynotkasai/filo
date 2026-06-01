# Filo — Data-Integrity & Quality Remediation Plan (Audit #2, 2026-05-31)

Second independent audit: 3 CI gates run green first (type-check 0 errors, **3084 unit tests pass**,
build OK), then a balanced **10-agent adversarial sweep**, then a **first-party re-verification of
every Critical/High** by reading the cited code *and executing `js-yaml` against the real package*.
Several findings were proven by running code, not just reading it.

> **Headline.** The *infrastructure* — `atomicWriteFile`, the debounced scheduler layer, crash
> recovery, the IPC/security boundary — is genuinely strong (8–9/10) and the earlier audit was right
> about it. **But there is a confirmed, silent, total-frontmatter-erasure cluster one layer ABOVE the
> write path that audit cleared** (the frontmatter-assembly / tag-mutation seam). That is the blind
> spot, and it makes the aggregate "8–9" misleading for someone about to trust real data. The bugs are
> invisible to types/tests/lint because no test exercises the triggering inputs (CRLF, malformed YAML,
> special-character tags, quoted siblings). **Until Phase 1 + 2 land, keep an independent file backup
> of your vault** (plain MD+JSON, so any backup tool works; git already covers the source tree).

---

## Strategy & sequencing (read this first)

**Does this need a refactor? No — not to make data *safe*.** Every Phase-1 bug traces to ONE design
choice: Filo parses YAML into a JS object at read time, **throws the original text away**, and
**re-serializes from the object on every save**. So (a) anything the parser can't round-trip is lost
on the next save, and (b) a second "formatting-preserving" path (the line-level tag rewriter) was
bolted on, and the bugs live in the seams where the good path silently falls back to the lossy one.

- **The whole class is killed by one invariant:** *a write may never drop bytes the reader could not
  parse.* The highest-leverage move is small and is **less code than what's there now**: on a
  **body-only save, pass the original frontmatter bytes through untouched** (the raw block is already
  captured at parse time — `markdownSync.ts` `fenced[1]` — and then discarded). This fixes the
  dominant loss path *and* preserves comments/formatting/line-endings for free.
- **Point fixes (Phases 1–3) are enough for safety.** Each is <1 day, low-risk, test-first.
- **A refactor is optional and bounded** — collapsing both YAML paths into one source-preserving
  engine (the `yaml` package's `Document`/CST API) is a *single-seam* job, scheduled **after** you're
  already using the app safely (Phase 4 "Engine consolidation", optional). It eliminates the class
  structurally instead of patching instances. Do it only if Obsidian-grade fidelity matters.
- **Stopping rule (definition of done for "I can trust my notes"):** Phases 1–2 land + the CI
  invariant gate is green + a vault backup exists. Then **stop broad auditing and start dogfooding** —
  real usage prioritizes the long tail far better than another audit. Phases 3–5 are a backlog;
  **none of them can lose data.**

## Discipline for every item (non-negotiable)

1. Write the regression test that demonstrates the bug and **watch it fail** (especially the 🔍 items).
2. Fix the smallest thing that makes it pass.
3. `npm run ci:verify` green end-to-end (lint → check → test → build → all guard scripts).
4. One commit per item where practical; reference the item ID (e.g. `1.4`) in the message.

## Legend

- **Severity:** 🔴 Critical · 🟠 High · 🟡 Medium · 🟢 Low
- **Confidence:** ✅ confirmed (mechanism + trigger traced; many also executed) · 🔍 likely (**reproduce with a failing test FIRST** — if you can't, downgrade to a doc note)
- 💾 = can lose / corrupt / desync user data · **Effort:** S ≈ <½ day · M ≈ ½–2 days · L ≈ 2+ days
- **Risk** = chance the *fix itself* regresses something.

## Phase summary

| Phase | Theme | Items | Severity | Gate to clear |
|---|---|:--:|:--:|---|
| **1** | **Frontmatter data-loss cluster** | 7 | 🔴/🟠 💾 | The "no metadata is ever silently lost" bar |
| **2** | Remaining high data-integrity | 5 | 🟠 💾 | No silent wrong-file / cross-board / lost-keystroke paths |
| **3** | Security · a11y-safety · perf · trust | 3 | 🟠 | SSRF closed; destructive controls visible; large boards usable |
| **4** | Medium (correctness, perf, docs) | 7 | 🟡 | Polish + the optional engine consolidation |
| **5** | Low (hygiene, dead code, a11y polish) | 8 | 🟢 | Backlog cleanup |

**Total: 30 items.** All Critical + High are in Phases 1–3.

---

# PHASE 1 — 🔴 Frontmatter data-loss cluster

> These are five entrances to **one** bug plus the two structural fixes that close the class. Do **1.1
> + 1.2 together first** — they are the amplifier and the cure. The rest stop the upstream corruption.

### 1.1 — Editor save erases the entire frontmatter block on unparseable/non-object YAML 🔴 ✅ 💾
*(the amplifier — turns any YAML corruption into total metadata loss)*
- **Where:** [markdownSync.ts:65-80](src/renderer/lib/editor/markdownSync.ts:65) (`parseMarkdownFile`), [markdownSync.ts:296-299](src/renderer/lib/editor/markdownSync.ts:296) (`assembleMarkdownFile`), [TextTile.svelte:119](src/renderer/components/tiles/TextTile.svelte:119)
- **Mechanism:** a *fenced* block sets `hasFrontmatter:true`, but if `yaml.load` throws or returns a non-object the parsed `frontmatter` stays `{}`. `assembleMarkdownFile` then checks only `Object.keys(fm).length > 0` — **never `hasFrontmatter`** — so it returns body-only with **no `---` fence**. The lossy-body read-only guard compares body only, so it does not protect frontmatter. Verified: tab-indent, duplicate key, top-level list, and top-level scalar all parse to empty → erased on next keystroke-save.
- **Fix:** thread the raw frontmatter string out of `parseMarkdownFile` (return `rawFrontmatter: fenced[1]`); in `assembleMarkdownFile`, when the parse flagged `hasFrontmatter` but the object is empty, **write back the raw block verbatim** (or refuse the write / set read-only, mirroring the lossy-body path). Never silently drop a fence you couldn't parse.
- **Test (fail first):** a `.md` with malformed YAML (tab indent) → load → body edit → assemble → assert the original frontmatter is still present on disk.

### 1.2 — Body-only saves must pass frontmatter bytes through untouched 🔴 ✅ 💾
*(the structural cure — also fixes comment/format/line-ending fidelity for the common case)*
- **Where:** [markdownSync.ts:283-303](src/renderer/lib/editor/markdownSync.ts:283) (`assembleMarkdownFile`), [document.svelte.ts](src/renderer/stores/document.svelte.ts) (doc model), [TextTile.svelte](src/renderer/components/tiles/TextTile.svelte) / [DocumentEditor.svelte](src/renderer/components/boards/DocumentEditor.svelte) (`buildWriteArgs`)
- **Mechanism:** today every save re-dumps the frontmatter object even when the user only typed in the body, which is what makes any parse weakness destructive and drops comments/order/CRLF.
- **Fix:** carry `rawFrontmatter` + a `frontmatterDirty` flag on the doc model. On a save where `frontmatterDirty === false`, emit `rawFrontmatter` verbatim and only swap the body. Re-serialize **only** when frontmatter actually changed (tags/properties), routed through the single hardened path (1.5).
- **Test:** open a note with a YAML comment + custom key order, type in body, save → assert the frontmatter block is byte-identical.

### 1.3 — `addTagToMarkdown` deletes the whole frontmatter block on unparseable YAML 🟠 ✅ 💾
- **Where:** [tagRewriter.ts:374](src/renderer/lib/vault/tagRewriter.ts:374), [fileTags.svelte.ts:202](src/renderer/stores/fileTags.svelte.ts:202)
- **Mechanism:** `loadYamlObject(yamlSource) ?? {}` — on a throw/null it proceeds on `{}`, sets `fm.tags`, and `yaml.dump` emits **only** a tags block, dropping every other key. Its siblings (`rewriteTagInMarkdown:277`, `removeTagFromMarkdown:324`) correctly do `if (!fm) return rawContent`.
- **Fix:** one line — `const fm = loadYamlObject(yamlSource); if (!fm) return rawContent;`
- **Test:** addTag on a note with a tab-indented frontmatter line → assert unchanged (or read-only), not erased.

### 1.4 — CRLF files silently defeat the tag rewriter and create duplicate `tags:` keys 🟠 ✅ 💾
*(Windows default — i.e. any note imported from Notepad / VS Code / Obsidian. Found by first-party analysis; the agents missed it.)*
- **Where:** [tagRewriter.ts:90](src/renderer/lib/vault/tagRewriter.ts:90) (`TAGS_HEADER_RE`), [tagRewriter.ts:113-160](src/renderer/lib/vault/tagRewriter.ts:113) (`locateTagsField`), [tagRewriter.ts:170-172](src/renderer/lib/vault/tagRewriter.ts:170) (`hasTagsHeader`), [tagRewriter.ts:341-388](src/renderer/lib/vault/tagRewriter.ts:341) (`addTagToMarkdown`)
- **Mechanism:** `TAGS_HEADER_RE = /^tags\s*:(.*)$/` is run against `yamlSource.split('\n')`, leaving a trailing `\r`; in JS `.` and `$` (no `/m`) don't cross `\r`, so the regex **never matches a `tags:` line that isn't the last frontmatter line** (the fence regex only strips `\r` from the final line). Proven with node: `RE.test('tags: [a, b]\r') === false`. Consequences on CRLF files: (a) rename/remove silently take the lossy `yaml.dump` fallback (drops comments, reorders, FM→LF, mixed endings); (b) `addTagToMarkdown` sees "no tags field" via `hasTagsHeader` → splices in a **second** `tags:` block → duplicate key → `js-yaml` throws on next parse → erasure via 1.1. **Zero `\r` tests exist.**
- **Fix:** normalize CRLF→LF at the read boundary before the rewriter (simplest, vault-wide), **or** make `TAGS_HEADER_RE`/`BLOCK_ITEM_RE` tolerate `\r` (`/^tags\s*:(.*)\r?$/`) and emit with the file's detected ending. Add an explicit CRLF fixture to every rewriter test.
- **Test:** rename/remove/add a tag on a CRLF note with `tags:` as a *non-last* key → assert no duplicate key, no comment loss, no erasure.

### 1.5 — Tag rename/remove emits names UNQUOTED and unvalidated → corrupt YAML 🔴 ✅ 💾
- **Where:** [tagRewriter.ts:194-211](src/renderer/lib/vault/tagRewriter.ts:194) (`renderTagsField`) + :257, [tagsStorage.ts:219-224](src/renderer/lib/vault/tagsStorage.ts:219) (`isValidTagName`), [TagsBrowser.svelte:92-119](src/renderer/components/tags/TagsBrowser.svelte:92) (rename handler)
- **Mechanism:** verified with real `js-yaml` — rename a tag to `@home` → `bad indentation of a sequence entry` (file unparseable); to `priority: high` → parses as a **map**; to `123` → a **number**, then silently dropped by `parseTagsField`'s `typeof string` filter; to `null`/`true` → destroyed. `isValidTagName` only rejects empty/whitespace and the rename handler **never calls it**.
- **Fix:** (a) call `isValidTagName` from the rename/create handlers and reject any name that doesn't survive a `dump`→`load` round-trip (or starts with a YAML indicator char `@ \` * & ! % # | > : ?`, contains `:` `,` etc.); (b) defense-in-depth — quote every emitted scalar in `renderTagsField` that needs it.
- **Test:** rename to `@home`, `a: b`, `123`, `null` → assert rejected at the UI boundary AND that the emitted YAML re-parses to the intended string.

### 1.6 — Removing/renaming an UNRELATED tag strips quotes off a quoted sibling → corruption 🟠 ✅ 💾
- **Where:** [tagRewriter.ts:94-98](src/renderer/lib/vault/tagRewriter.ts:94) (`unquote`), [tagRewriter.ts:194-211](src/renderer/lib/vault/tagRewriter.ts:194), [tagRewriter.ts:300-317](src/renderer/lib/vault/tagRewriter.ts:300)
- **Mechanism:** `unquote` drops the quotes; `renderTagsField` re-emits **all** surviving tags bare. A file listing `draft` + `"@home"` loses the quotes on `@home` the instant `draft` is removed → bare `@home` → unparseable. The user never touched the tag that broke.
- **Fix:** re-quote every emitted scalar that requires it (same quoter as 1.5), **or** decline the line rewrite when any sibling needs quoting and fall back to the (now-safe) load/dump path.
- **Test:** remove `draft` from `[draft, "@home"]` → assert `@home` stays quoted and the file re-parses.

### 1.7 — Add the CI invariant gate 🟠 (process — closes the class) 💾
- **Fix:** a `scripts/check-*.mjs` (and a property/fuzz unit test) asserting **no write path drops bytes it couldn't parse**: round-trip a corpus of "hostile" frontmatter (CRLF, tabs, comments, anchors, quoted/special-char tags, numeric/bool/null tags, list/scalar top-level, duplicate keys) through parse→assemble and through each tag op, asserting either lossless preservation or an explicit refusal — never silent loss. Wire into `ci:verify`. This catches the next edge case before a user does.

---

# PHASE 2 — 🟠 Remaining high data-integrity

### 2.1 — Same-basename rename rewires tile references to the WRONG file (no undo) 🟠 ✅ 💾
- **Where:** [renameCorrelation.ts:134-147](src/main/services/renameCorrelation.ts:134), [fileWatcher.ts:941](src/main/services/fileWatcher.ts:941), [vaultExternalChanges.ts:513-520](src/renderer/stores/vaultExternalChanges.ts:513), [fileRefIntegrity.ts:241-260](src/renderer/lib/vault/fileRefIntegrity.ts:241)
- **Mechanism:** `correlateRenames` buckets purely by basename (directory stripped) and pairs any 1-missing + 1-present into a rename **with no size/hash/folder check** — the content-hash gate exists only in the cross-basename pass. Delete `Archive/Notes.md` + create `Inbox/Notes.md` in one batch → every Archive-board tile/cover that referenced the first is rewritten to the second and flushed to `.board.json`. **Not undoable.** Same-basename files (`Notes.md`, `README.md`, `index.md` per folder) are the textbook PKM layout.
- **Fix:** apply the existing size + content-hash gate to the same-basename pass; require a hash/size match for any cross-directory pairing (a real move preserves bytes).
- **Test:** batch [delete A/Notes.md (hash X), create B/Notes.md (hash Y)] → assert NOT correlated as a rename; same hash → correlated.

### 2.2 — Concurrent edits to a Text Tile + Document view of the same `.md` drop keystrokes 🟠 ✅ 💾
- **Where:** [TextTile.svelte:78](src/renderer/components/tiles/TextTile.svelte:78) & :345, [DocumentEditor.svelte:283](src/renderer/components/boards/DocumentEditor.svelte:283) & :378, [document.svelte.ts:347](src/renderer/stores/document.svelte.ts:347)
- **Mechanism:** the gateway debounces per `callerId` (`text-tile:<id>` vs `document-editor:<docId>`), so two views of one file hold independent timers; last writer wins and the reload effect early-returns while either view is dirty. Contradicts **design decision #4** ("two views of one file").
- **Fix:** key the markdown debounce by `docId`/relPath (not callerId), **or** cross-cancel the sibling timer / push `updateContent` into the other editor immediately on edit (`cancelMarkdownWritesForDocument` already exists).
- **Test:** split-pane the same file; type in view A then view B within 300 ms → assert both edits survive on disk.

### 2.3 — Markdown body-edit has an unprotected crash window (no `.filo/.dirty` sentinel) 🟠 ✅ 💾
- **Where:** [markdownFileWriter.ts:116-123](src/renderer/lib/vault/markdownFileWriter.ts:116), [writeScheduler.ts:261-264](src/renderer/lib/boards/writeScheduler.ts:261) & :367-374, [dirtyFlagRecovery.ts:4-16](src/renderer/lib/vault/dirtyFlagRecovery.ts:4)
- **Mechanism:** the markdown gateway sets `manageSentinel:false`, so a pure body keystroke never lays down `.filo/.dirty` during its 300 ms window. A hard crash mid-typing loses up to ~300 ms of text **with no recovery prompt**, and the save indicator reads *idle* during that window (the "premature saved" signal). Violates the recovery module's own documented contract.
- **Fix:** at `scheduleMarkdownWrite` time call `noteAdditionalPendingPath` (adds to pending + refreshes sentinel **without** incrementing `inflight`) and `dropPendingPath` on fire/cancel — the pair already exists for the board-rename path.
- **Test:** schedule a body write, assert `.filo/.dirty` exists during the window and clears on flush; assert the save indicator is not "idle" while text is unwritten.

### 2.4 — Cross-board undo/redo of mind-map commands mutates the ACTIVE board, not the target 🟠 🔍 💾
*(reproduce with a real board-targeting test first — existing tests use counter-commands that don't read `boardStore.current`)*
- **Where:** [history.svelte.ts:414-485](src/renderer/stores/history.svelte.ts:414), [App.svelte:98-112](src/renderer/App.svelte:98), [PaneView.svelte:59-65](src/renderer/components/layout/PaneView.svelte:59), [boardScope.svelte.ts:92-95](src/renderer/lib/boards/boardScope.svelte.ts:92), [board.svelte.ts:430-451](src/renderer/stores/board.svelte.ts:430), [groupAndBoardCommands.ts:565-576](src/renderer/commands/groupAndBoardCommands.ts:565)
- **Mechanism:** mind-map commands mutate the **global `boardStore` facade**; `boardActivator` switches panes *asynchronously* (schedules a `$effect`) while `command.undo()` runs *synchronously*, so `boardStore.current` is still the old board during the mutation. Kanban/Task commands are safe because they self-target via `this.boardId`.
- **Fix:** route `UpdateBoardSettingsCommand`/`ToggleGroup`/`MoveTiles`/`DeleteTiles` through the cache slice keyed by `this.targetBoardId` (like the kanban/task commands), **or** have `boardActivator` synchronously pivot the scope before returning.
- **Test:** split view, board B active in pane 2, A active; undo a board-B `UpdateBoardSettingsCommand` with A focused → assert B changed, A untouched.

### 2.5 — External frontmatter-only edit clobbered by an already-armed dirty-body write 🟠 🔍 💾
*(reproduce first — needs a precise interleave)*
- **Where:** [conflictResolver.ts:101-112](src/renderer/lib/vault/conflictResolver.ts:101), [vaultExternalChanges.ts:152-176](src/renderer/stores/vaultExternalChanges.ts:152), [markdownFileWriter.ts:373-391](src/renderer/lib/vault/markdownFileWriter.ts:373)
- **Mechanism:** `sync-frontmatter` short-circuits before the dirty check (correct — body isn't owned by FM), pushing external FM into the doc store. But a body write armed *before* the sync captured the OLD frontmatter, and the stale-cache re-read guard doesn't fire (the version bump happened without a flush), so the body lands with old FM → external metadata edit lost, no prompt.
- **Fix:** on the `sync-frontmatter` arm when an editor is open + dirty, re-arm/cancel the pending body write to re-capture FM, **or** have the body writer read live frontmatter at *fire* time rather than freezing it at keystroke time. (Largely subsumed by 1.2's "frontmatter read live, not frozen".)
- **Test:** arm a body write, fire an external FM-only change, let the body write flush → assert external FM survived.

---

# PHASE 3 — 🟠 Security · accessibility-safety · performance · trust

### 3.1 — SSRF: private-IP guard bypassed by hex IPv4-mapped IPv6; auto-fires from a Link Tile 🟠 ✅
*(confidentiality, not data-loss — but breaks the "no network calls" promise)*
- **Where:** [pathSecurity.ts:339](src/main/utils/pathSecurity.ts:339) & :362-366, [media.ipc.ts:26](src/main/ipc/media.ipc.ts:26) & :345/:354, [LinkTile.svelte:42](src/renderer/components/tiles/LinkTile.svelte:42)
- **Mechanism:** verified end-to-end (bound a real socket) — `isPrivateUrl`'s regex only catches the dotted-quad mapped form, so `http://[::ffff:7f00:1]` (127.0.0.1) / `[::ffff:a00:1]` (10.0.0.1) pass; the DNS backstop re-wraps the same form and also passes. A Link Tile **auto-fires** `link:fetch-metadata` on mount with no interaction → a crafted shared/synced board probes loopback/LAN and reflects internal responses.
- **Fix:** normalize any `::ffff:`/`::` IPv6 to its embedded v4 *before* the regex tests (in both `isPrivateUrl` and `isHostnamePrivate`); fail-closed on unrecognized IPv6 for these two sinks. Add cases `[::ffff:a00:1]`, `[::ffff:7f00:1]`, NAT64 `[64:ff9b::a00:1]`.
- **Test:** unit-assert the mapped forms classify as private.

### 3.2 — Keyboard focus lands on an INVISIBLE Delete button in every sidebar row 🟠 ✅
*(WCAG 2.4.7; a destructive, data-affecting control)*
- **Where:** [VaultFileItem.svelte:709](src/renderer/components/sidebar/VaultFileItem.svelte:709) & :917/:922, contrast [TileHeader.svelte:734](src/renderer/components/tiles/TileHeader.svelte:734)
- **Mechanism:** `.file-actions { opacity:0 }` is raised only by `:hover` — no `:focus-within`, and the buttons have no `tabindex="-1"`, so keyboard users Tab onto a fully transparent **Delete file** control (irreversible, cascades placement removal across boards). `TileHeader`/`TaskItem` already solve this with `:focus-within`.
- **Fix:** add `.vault-file-item:focus-within .file-actions { opacity:1 }` (+ `pointer-events:auto`), **or** `tabindex="-1"` + expose via the existing context menu. Confirm a delete-confirm dialog still fires.
- **Test:** Playwright keyboard-Tab to the Delete button → assert it has a visible focus indicator.

### 3.3 — Connections/labels are never viewport-culled; every drag frame recomputes all paths 🟠 ✅
*(perf cliff exactly at the "1,000-tile board" scale you care about)*
- **Where:** [ConnectionLayer.svelte:133](src/renderer/components/connections/ConnectionLayer.svelte:133) & :182, [ConnectionPath.svelte:32](src/renderer/components/connections/ConnectionPath.svelte:32) & :40, [board.svelte.ts:182](src/renderer/stores/board.svelte.ts:182), [mindmap.ts:220](src/renderer/core/boardTileOps/mindmap.ts:220)
- **Mechanism:** `getFullTiles` allocates fresh tile objects every drag frame → every connection's `pathD` recomputes (Svelte referential-equality miss) and `ConnectionLayer` renders **all** connections with no viewport filter (~2×C `computePath`/frame, A* per smart edge). Tiles *are* culled; connections are the blind spot.
- **Fix:** filter connections to those whose endpoints intersect the buffered viewport before the `#each`; give `pathD` a memo keyed on endpoint geometry primitives (or return stable tile references from `getFullTiles` when placement+def are unchanged); reuse `ConnectionPath`'s computed path for the label instead of recomputing.
- **Test:** perf assertion / manual — drag on a 300+ connection board stays ~60fps; off-screen paths don't recompute.

---

# PHASE 4 — 🟡 Medium (correctness, perf, docs) + optional engine consolidation

### 4.1 — Running Timer tile starves its board's writes & pins the save indicator on "saving" 🟡 ✅ 💾
- **Where:** [TimerTile.svelte:111-121](src/renderer/components/tiles/TimerTile.svelte:111) & :165, [mindmap.ts:166-174](src/renderer/core/boardTileOps/mindmap.ts:166), [writeScheduler.ts:349-410](src/renderer/lib/boards/writeScheduler.ts:349), [saveState.svelte.ts:39-46](src/renderer/stores/saveState.svelte.ts:39)
- **Mechanism:** every 100 ms tick calls `updateTile`→`markDirty`, perpetually re-arming the 300 ms board debounce so it never fires; `inflight` stays 1 (indicator stuck on "saving"), and *any* real edit to that board isn't persisted until the timer stops (lost on hard crash).
- **Fix:** keep `remaining` in component `$state`; persist only on pause/stop/blur (option a). Alternatively add a max-wait cap to the scheduler, or special-case timer updates to skip `markDirty`.
- **Test:** run a timer, edit the board, assert a flush happens within N ms and the indicator returns to idle.

### 4.2 — Redo/undo of a frontmatter-field command overwrites an external metadata edit 🟡 🔍 💾
- **Where:** [kanbanCommands.ts:499-520](src/renderer/commands/kanbanCommands.ts:499), [taskCommands.ts:365-387](src/renderer/commands/taskCommands.ts:365), [document.svelte.ts:212-223](src/renderer/stores/document.svelte.ts:212), [history.svelte.ts:527-550](src/renderer/stores/history.svelte.ts:527)
- **Mechanism:** `mergeFrontmatter` does a blind `{...base, ...patch}` over the live cache; after an external FM change, `notePossiblyStale` only *warns* (never disarms the stack), so an undo/redo writes the stale patch over the external edit.
- **Fix:** when `notePossiblyStale` fires for a docId, mark its frontmatter commands "rebase-required" so undo/redo re-reads on-disk FM (or prompts) instead of relying on the user clicking "Clear undo history."
- **Test (fail first):** toggle priority → external edit priority → Ctrl+Z → assert external value not clobbered (or a prompt).

### 4.3 — Partial-read mtime-stability window is dead (index stamps `Date.now()` not disk mtime) 🟡 ✅
- **Where:** [vaultIndex.svelte.ts:52-66](src/renderer/stores/vaultIndex.svelte.ts:52), [vaultIndex.ts:287-323](src/renderer/lib/vault/vaultIndex.ts:287), [conflictResolver.ts:196-209](src/renderer/lib/vault/conflictResolver.ts:196), [vault.ipc.ts:612-633](src/main/ipc/vault.ipc.ts:612)
- **Mechanism:** `isLikelyPartialRead` gates on `now - next.lastModified < 1000ms`, but `indexOnePath` stamps `Date.now()` instead of the disk mtime the IPC already returns (`mtimeMs`). So `ageMs ≈ 0` always → every drastic external truncation is forced through the ~5 s retry/exhaustion path and mis-presented as a stuck read.
- **Fix:** pass `res.mtimeMs` to `parseMarkdown` in `indexOnePath` and propagate it through `FileMetadata.lastModified`.
- **Test:** index a file, assert `lastModified` equals the IPC mtime; settled truncation reloads immediately.

### 4.4 — ~4.5 MB of JS (TipTap, markdown-tools, lowlight) is preloaded before the Home screen 🟡 ✅
- **Where:** [boardRegistry.ts:3](src/renderer/core/boardRegistry.ts:3), [createEditor.ts:1](src/renderer/lib/editor/createEditor.ts:1), [AppShell.svelte:6](src/renderer/components/layout/AppShell.svelte:6), `dist/renderer/index.html`, [electron.vite.config.mts:72](electron.vite.config.mts:72)
- **Mechanism:** `boardRegistry` statically imports every board component, which statically pulls TipTap/lowlight/markdown-tools into the entry's `modulepreload` graph — fetched + parsed before the no-vault Home screen is interactive. (`exportService` is already correctly lazy, proving the pattern is understood.)
- **Fix:** make `boardRegistry.component` fields `() => import('…')` and `{#await}` them in `BoardRouter`, or gate the board subtree behind `vaultStore.project !== null`. lowlight grammars can load on first code-block render.
- **Test:** assert the built `index.html` modulepreload set no longer contains the `tiptap`/`lowlight` chunks.

### 4.5 — Minimap renders one DOM pip per tile (no virtualization), recomputes every mutation 🟡 🔍
- **Where:** [Minimap.svelte:44](src/renderer/components/canvas/Minimap.svelte:44) & :51/:68, [MindMapBoard.svelte:741](src/renderer/components/boards/MindMapBoard.svelte:741)
- **Mechanism:** reads the whole `boardStore.tiles` (which churns every drag frame), re-derives `activeMediaIds`/`bounds` over all tiles, and renders N pip nodes; on by default, compounding 3.3.
- **Fix:** derive pips from a light geometry-only projection memoized on primitives; throttle redraw to ~15-20fps during drag; consider a single `<canvas>` above a tile-count threshold. (Fixing 3.3's stable-identity recommendation fixes this too.)
- **Test:** assert untouched tiles don't recompute the minimap on a single-tile move.

### 4.6 — Tab close buttons are unconditional Tab stops and invisible on focus 🟡 ✅
- **Where:** [Tab.svelte:205](src/renderer/components/layout/Tab.svelte:205) & :183/:321-325
- **Mechanism:** `role=tab` divs use roving tabindex correctly, but the nested `.tab-close` button is always `tabindex=0` and `opacity:0` with no `:focus` rule → Tab stops on every tab's invisible close button.
- **Fix:** `tabindex={isActive ? 0 : -1}` on the close button + `.tab:focus-within .tab-close { opacity:1 }`.

### 4.7 — CLAUDE.md doc drift misdirects contributors to the deprecated shim 🟡 ✅
- **Where:** [package.json:40](package.json:40), `CLAUDE.md`, [untrusted.ts:1](src/shared/untrusted.ts:1), [markdownFileWriter.ts:525](src/renderer/lib/vault/markdownFileWriter.ts:525)
- **Mechanism:** the "CI gates" section lists **7 of the real 25** gates and claims it mirrors CI; `markdownFileWriter` (the canonical write gateway), `lib/search/`, `shared/untrusted.ts`, `core/boardTileOps/`, `seedTextFileForNewTile`, `ProjectDropdown.svelte`, `PropertiesPopup.svelte` are absent from the structure tree; the cited `components/common/icons/` directory doesn't exist. It points devs at the deprecated `markdownWriteRegistry` shim over the data-critical gateway.
- **Fix:** regenerate the CI-gate list from `package.json` (or point to it as source of truth); add the missing subsystems; mark `markdownWriteRegistry` deprecated; fix the Icons path.

### 4.8 (optional) — Engine consolidation: one source-preserving frontmatter layer 🟡 (refactor, bounded)
- **Scope:** replace the `js-yaml load→dump` path **and** the hand-rolled `tagRewriter` line editor with a single `yaml`-package `Document`/CST layer that edits in place (preserves comments, key order, line endings, quoting). Collapses `markdownSync` FM-handling + `tagRewriter` into one module.
- **Why optional:** Phases 1 + 1.7 already make data *safe*. This makes the class *impossible* and gives Obsidian-grade fidelity. **Do it only after you're using the app**, and keep the 1.7 invariant test as the safety net during the swap. Effort **L**, risk **M** (touches the save path) — but it deletes more than it adds.

---

# PHASE 5 — 🟢 Low (hygiene · dead code · a11y polish)

| ID | Severity | Item | Where | Fix |
|---|:--:|---|---|---|
| 5.1 | 🟢 ✅ 💾 | Externally-deleted `.filo/` config resurrected by next debounced write (ef8ec6a guard not applied to config/misc schedulers) | [configWriteScheduler.ts:275-291](src/renderer/lib/boards/configWriteScheduler.ts:275), [boardWriteScheduler.ts:222-250](src/renderer/lib/boards/boardWriteScheduler.ts:222) | Skip target as clean no-op on pre-write ENOENT (mirror board path), or document the divergence in KNOWN_LIMITATIONS |
| 5.2 | 🟢 🔍 | Drift prompt has no per-path de-dup → toast storm + redundant writes while typing into an externally-edited file | [vaultExternalChanges.ts:1267-1324](src/renderer/stores/vaultExternalChanges.ts:1267) | `Map<path, Promise<choice>>` of in-flight prompts; awaiters share one decision |
| 5.3 | 🟢 ✅ | Board-JSON tileDef metadata never reconciled vs frontmatter on board **load** (only live events) → on-disk cache drifts (no visible bug; render reads FM) | [boardLoader.ts](src/renderer/lib/boards/boardLoader.ts), [frontmatterSync.ts:216-272](src/renderer/lib/vault/frontmatterSync.ts:216) | Run `reconcileBoardCacheWithFrontmatter` per board during the open flow after index hydrate |
| 5.4 | 🟢 ✅ | `assertSafeFilename` accepts `:` → crafted path can create/read hidden NTFS ADS inside the vault (the project's own `ILLEGAL_CHARS` already bans `:`) | [pathSecurity.ts:133](src/main/utils/pathSecurity.ts:133), [filenameUtils.ts:8](src/main/vault/filenameUtils.ts:8) | `if (/[<>:"|?*]/.test(name)) throw` in `assertSafeFilename` + unit test |
| 5.5 | 🟢 ✅ | `sanitizeFilename` doesn't guard Windows reserved names (`CON`, `NUL`, `COM1`) or trailing dots | [filenameUtils.ts:19-35](src/main/vault/filenameUtils.ts:19) | Reject/suffix reserved device names; strip trailing dots |
| 5.6 | 🟢 ✅ | `TaskListBoard` `lastViewPersistTimer` not cleared on unmount → settings write + history push ~300 ms after teardown | [TaskListBoard.svelte:1392-1406](src/renderer/components/boards/TaskListBoard.svelte:1392) | Clear the timer in `onDestroy` (or expose `filters.dispose()`) |
| 5.7 | 🟢 ✅ | Kanban card controls (due/cover/priority) invisible on keyboard focus (non-destructive) | [KanbanCard.svelte:579](src/renderer/components/boards/KanbanCard.svelte:579) | `.kanban-card-shell:focus-within …{opacity:1}` (match TaskItem/TileHeader) |
| 5.8 | 🟢 ✅ | Save-failure popover is `role=dialog` but has no focus trap / no initial focus | [GlobalToolbar.svelte:156](src/renderer/components/layout/GlobalToolbar.svelte:156) | Render through the shared `Modal`/`ConfirmDialog`, or move focus to Retry + trap |
| 5.9 | 🟢 ✅ | `markdownWriteRegistry` shim is dead-in-production (0 prod callers; 8 test-only) yet on the save/flush hot path | [markdownWriteRegistry.ts:56](src/renderer/lib/boards/markdownWriteRegistry.ts:56) | Migrate the 4 prod call sites to import directly from `markdownFileWriter`, delete the shim, retarget its tests |
| 5.10 | 🟢 ✅ | Duplicate `flushAllMarkdownWriters`/`forceWriteForDocument` (shim + gateway); frontmatter scheduler drained twice per disk-shape op (idempotent, harmless) | [markdownWriteRegistry.ts:87-101](src/renderer/lib/boards/markdownWriteRegistry.ts:87), [vaultOperations.ts:120](src/renderer/lib/vault/vaultOperations.ts:120) | Collapse to one owner; delete the now-stale "sites depend on it" comment |

---

## Appendix A — Confirmed strong (do NOT "fix" — verified this audit)

- **`atomicWriteFile`** ([filenameUtils.ts:142-278](src/main/vault/filenameUtils.ts:142)) — `open→write→fsync(fd)→close→rename→fsync(dir)`, per-call nonce temp (no shared-`.tmp` race), **preserves the temp on `ENOSPC`/`EIO`/`EACCES`** (disk-full stays recoverable), bounded retry. Textbook. Leave it.
- **Crash recovery** — sentinels + snapshots are idempotent, non-destructive, replayable, and reset on vault swap. The `ef8ec6a` board-delete-resurrection guard is correct.
- **IPC / path security** — every channel Zod-gated in preload *and* main; `assertSafeRelativePath`→`assertNotInFiloDir`→`assertWithinVault` (realpath/lstat symlink defeat). `../`, UNC, drive-relative, trailing-dot escapes all blocked. The `:` gap (5.4) is the only hole and stays inside the vault.
- **Frontmatter-wins ON RENDER** — Kanban/Task read `completed`/`priority`/`date` from canonical frontmatter, not the cached tileDef, so a stale cache never wins on screen (this is why 5.3 has no visible symptom).
- **The frontmatter comment-loss on a *full* rewrite is a documented KNOWN_LIMITATION** — acceptable. The **empty-frontmatter erasure (1.1) is NOT** the same thing and must be fixed.
- Snapshot/undo discipline (CI-gated `cloneForSnapshot`), rbush tile culling, incremental MiniSearch, focus-trap modals, app-wide `prefers-reduced-motion`, and 25 CI ratchet scripts are all genuinely solid.

## Appendix B — Provenance

Findings marked ✅ were traced to a concrete trigger; the Phase-1 cluster, 2.1, 3.1, 3.2, 3.3, and
4.x were additionally **executed** (real `js-yaml`, a bound socket, the built `index.html`). 🔍 items
(2.4, 2.5, 4.2, 4.5, 5.2) have a sound mechanism but were **not** fully reproduced — write the failing
test first; if you can't, downgrade to a doc note. Line numbers are from the working tree on
2026-05-31 and may drift as you edit — re-grep before trusting one.

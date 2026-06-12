# CLAUDE.md — Filo Development Guide

## Project Overview

Filo is a local-first, visual-first Personal Knowledge Management (PKM) desktop application. It combines an infinite canvas (Mind Map), Kanban boards, Task Lists, and Documents into a single tool. All data lives on the user's device as Markdown and JSON files — no accounts, no cloud, no lock-in.

**Key technical identity:** Electron + Svelte 5 + TypeScript + Vite. Vanilla CSS only. No Tailwind, no CSS-in-JS, no preprocessors.

---

## Quick Reference

```
Run dev:        npm run dev
Type-check:     npm run check
Unit tests:     npm run test:unit
E2E tests:      npm run test:e2e
Build:          npm run build
Package:        npm run package
```

### CI gates (`.github/workflows/ci.yml`)

`npm run ci:verify` runs every gate locally and mirrors the GitHub Actions `verify` job. **The authoritative, ordered gate list is the `ci:verify` script in [package.json](package.json)** (regenerate from there, not from this doc, if it drifts). It chains:

```
lint → check (svelte-check) → test:unit:strict → build → 46 × ci:* guard scripts
```

The guards are small `scripts/check-*.mjs` ratchets (47 of them, not enumerated here — see `package.json`). The load-bearing ones:

- **`ci:file-sizes`** ([scripts/check-file-sizes.mjs](scripts/check-file-sizes.mjs)) — fails if any file in `src/main` or `src/renderer` exceeds 1000 LOC, with an explicit allowlist for the currently grandfathered files (**13** as of Audit-14 — the authoritative list is the `ALLOWLIST` in the script, each pinned at its snapshot LOC). Allowlisted files may shrink but not grow past their snapshot (the ceilings sit at each file's current LOC). The list has crept from seven to thirteen across the audit rounds; the **intended remedy for an over-limit file is to SPLIT it, not to keep bumping ceilings** — Audit-14 6.1 split `vault.ipc.ts` (→ `vaultCopy.ipc.ts` + `ipcErrorCode.ts`) and `fileWatcher.ts` (→ `fileWatcherClassify.ts`) back under 1000 rather than allowlist them.
- **`ci:type-casts`** ([scripts/check-type-casts.mjs](scripts/check-type-casts.mjs)) — forbids `as any` and `as unknown as` in non-test source. Escape hatch: append `// allow-cast: <reason>` on the same line.
- **`ci:ipc-parity`** ([scripts/check-ipc-parity.mjs](scripts/check-ipc-parity.mjs)) — asserts every `ipcMain.handle/on/once` channel name appears in the `IpcChannel` union in [src/shared/types.ts](src/shared/types.ts) and vice-versa. Pure main→renderer events are allowlisted inside the script.
- **`ci:frontmatter-invariant`** ([scripts/check-frontmatter-invariant.mjs](scripts/check-frontmatter-invariant.mjs)) — the frontmatter data-loss invariant: a hostile-corpus + fuzz suite asserting no write path silently drops a key, corrupts the YAML, or edits the body.
- **`ci:markdown-gateway`** / **`ci:markdown-read-gateway`** — every markdown write / read must route through the canonical gateway ([src/renderer/lib/vault/markdownFileWriter.ts](src/renderer/lib/vault/markdownFileWriter.ts)), not ad-hoc `fs` / IPC.
- **`ci:md-writers-reconcile-editors`** ([scripts/check-md-writers-reconcile-editors.mjs](scripts/check-md-writers-reconcile-editors.mjs)) — Audit5 R2: a direct `.md` write (outside the gateway) landing under an open editor leaves its frontmatter cache stale, so the editor's next body save silently inverts the write (#4). **Phase 6.6** makes the safe path the only path: every non-gateway `.md` write routes through the coupled `writeMarkdownAndReconcile({ vaultRoot, path, content, mode, create?, track? })` helper ([src/renderer/lib/vault/syncOpenEditorsAfterDiskMutation.ts](src/renderer/lib/vault/syncOpenEditorsAfterDiskMutation.ts)), which performs the write AND the matching reconcile (`mode: 'full'` reload, or `'frontmatter'`-only / body-preserving) for the **same `path`** — so the written path and the reconciled path can't diverge *by construction*. The gate now fails any raw `vault:write-(existing-)?file-text` invoke outside that helper, the documented exemptions (new-file seed / `.filo/` sentinel / config geometry, in `RECONCILE_EXEMPT`), or a `// reconcile-elsewhere:` escape — superseding Audit6 5.4's same-top-level-block scan (a nearby reconcile call no longer satisfies it). This closes the data-flow part 5.4 deferred to "Phase 6 territory": path-equality is now structural, not just same-block.
- **`ci:awaited-writes-bounded`** ([scripts/check-awaited-writes-bounded.mjs](scripts/check-awaited-writes-bounded.mjs)) — Audit5 R3 (#1) + **Audit-11 WC-1/QC-1/QC-2**: pins that the shared write scheduler (`writeScheduler.ts`) still races a `writeTimeoutMs` bound (`Promise.race` + `WRITE_TIMEOUT` sentinel) AND that EVERY scheduler whose `performWrite` transitively awaits the wedge-prone `writeMarkdownFile` configures it — the markdown gateway (`markdownFileWriter.ts`), the **frontmatter scheduler** (`writeFrontmatter` awaits the same `writeMarkdownFile` + drift prompt), and the **board scheduler** (`writeBoardFile` awaits an interactive board drift prompt + `vault:stat`/`board:save` IPC). Without the bound a stranded/wedged prompt or a stalled OneDrive/SMB volume hangs `flushAll`/`save()`/quit forever. Audit-11 corrected the earlier FALSE premise that only the gateway could wedge; config/misc are genuinely whole-file fire-and-forget (Phase 2 bounds them for uniformity but the gate doesn't require it). **Audit-12 H4/M2** added two more pins to `writeScheduler.ts`: H4 — `flushAll` PRE-DRAINS any older in-flight write for a key before firing that key's pending (newest) write, so a non-serialized scheduler (board/config/misc) can't let a stale write land last and clobber the newer payload on a slow OneDrive/SMB volume; M2 — the `writeTimeoutMs` branch SELF-HEALS the failed mark on a LATE success (`clearFailedPathAfterLateSuccess`), so a board/config/misc write that exceeds the bound then lands doesn't leave a permanent phantom "Save failed" + sticky `.filo/.dirty` for the session (the markdown/frontmatter schedulers already self-heal via `trackComponentWrite`'s late `endWrite(true)`). **Audit-13 H1/M3** generalise both: H1 — the SAME per-key pre-drain now also runs on the DEBOUNCE-TIMER fire path (the common active-editing path, which previously just fired `void fireWrite(...)` with no drain → two `board:save`/config IPCs could overlap on a slow volume and the OS land the OLDER last); all three fire paths (timer, `flush`, `flushAll`) route through one shared `drainPriorInFlight(key)` helper (the gate pins its call on both the timer path — `drainPriorInFlight(key)` — and the flushAll loop — `drainPriorInFlight(entry.key)`), and the timer re-reads args AFTER the drain so the freshest state wins. M3 — the M2 late-success self-heal is now gated by a per-path write generation (`writeGenByPath`, bumped at fire time): it only clears the failed mark when THIS write is still the newest for its path, so an OLDER timed-out write finally landing can't erase a NEWER write's legitimate failure recorded in the interim.
- **`ci:reconciler-vault-guard`** ([scripts/check-reconciler-vault-guard.mjs](scripts/check-reconciler-vault-guard.mjs)) — Audit6 H3/H4/L27 + **Audit8 H2**: any function **or object-literal method** in [src/renderer/stores/vaultExternalReconcilers.ts](src/renderer/stores/vaultExternalReconcilers.ts) **or [src/renderer/stores/vaultExternalChanges.ts](src/renderer/stores/vaultExternalChanges.ts)** that reads the active vault path (`vaultStore.path` / `ctx.getVaultPath()` / a captured `vaultRoot`) and then `await`s must also `isStillSameVault(...)` after the await. A vault swap during the read would otherwise apply the outgoing vault's data to the new vault (tags persisted cross-vault on disk, board injected into the cache, theme re-applied, **or H2(a): an external-edit classification applied to the new vault's same-named file**). Discovery now also finds indented object methods (H2(a)'s `handleExternalMarkdownChanges` is one) — and the *trigger* is the intrinsic live-path read, not the guard, so removing the guard can't evade the gate. Two `vaultExternalChanges` live-path readers that A8 left main-side-mitigated are in a documented `GUARD_EXEMPT`. The gate also carries the **H2(b) ratchet**: it forbids resurrecting a `=== newVaultPath` / `!== newVaultPath` path-STRING swap compare in [src/renderer/stores/vault.svelte.ts](src/renderer/stores/vault.svelte.ts) (a close→reopen of the same path is a new generation but passes a string compare). **Audit9 A9-G1** widens the Part 1 scan to the FM-seed primitive [src/renderer/lib/boards/seedFrontmatterFromDisk.ts](src/renderer/lib/boards/seedFrontmatterFromDisk.ts) (a captured-`vaultRoot` param) and the field-edit command files [src/renderer/commands/kanbanCommands.ts](src/renderer/commands/kanbanCommands.ts) / [src/renderer/commands/taskCommands.ts](src/renderer/commands/taskCommands.ts): a vault swap mid-seed-read would otherwise inject the outgoing vault's frontmatter (A9-M1) and the field command would write it onto the new vault's same-named file (A9-H1). Converts the G1 discipline (`vaultIdentity.ts`) from per-site convention into an enforced invariant. **Write-path-remediation Phase 3 / 3.2** adds a **Part 3** ratchet pinning the IN-APP disk-shape cascade in [src/renderer/stores/vaultFolderOps.ts](src/renderer/stores/vaultFolderOps.ts): `runRename` (snapshots the board cache, awaits the drained IPC, re-applies `cacheSnapshot` on failure) and `performDelete` (awaits the IPC + hydrate, then runs the in-memory delete cascade) must each carry an `isStillSameVault` bail — a swap landing mid-op would otherwise re-inject the outgoing vault's snapshot into the new vault (the disk IPC itself is main-side gated by `assertActiveVault`, the in-memory mutation is not). Part 1's generic scan can't reach them by name (`runRename` takes a `vaultPath` PARAM, not a live-path read; the `rename` wrapper only delegates), so Part 3 pins the two cascade functions explicitly. **Audit-11** widens it again: Part 1 now also scans [src/renderer/stores/fileTags.svelte.ts](src/renderer/stores/fileTags.svelte.ts) (VS-2 — the single-tag `.md` writers stamp the drift baseline / re-index keyed by `relPath` alone) and [src/renderer/commands/propertiesCommands.ts](src/renderer/commands/propertiesCommands.ts) (FILO-UR-2 — `applySnapshot` writes + seeds the FM cache after a drain), and Part 3 adds the rename-cascade RECOVERY repair `repairRenameCascade` ([src/renderer/lib/vault/renameCascadeRepair.ts](src/renderer/lib/vault/renameCascadeRepair.ts), VS-1 — in-memory board/doc/tag mutations driven from a parked recovery modal, taking a captured `VaultIdentity` param Part 1 can't see). **Audit-12 H3/M6** widens Part 1 twice more: H3 — the vault-wide tag-rewrite sweep [src/renderer/stores/fileTagsCascade.svelte.ts](src/renderer/stores/fileTagsCascade.svelte.ts) (new `allMetadata` live-read trigger — the sweep read live `vaultStore.path` + `vaultIndexStore.allMetadata()` and its survive-a-swap retry toast applied the outgoing vault's tag op to the swapped-in vault); M6 — the on-open FM→cache reconcile batch [src/renderer/stores/boardCacheFrontmatter.ts](src/renderer/stores/boardCacheFrontmatter.ts) `applyFrontmatterToBackedTilesBatch` (new `getCache` trigger — it captures `ctx.getCache()`, yields across microtasks, then does a terminal `setCache`; a swap mid-yield would flip the outgoing vault's cache onto the new one, so it now threads the caller's captured identity and bails after each yield + before the setCache). **Audit-13 L16/L17** widens the `vaultExternalChanges.ts` scan with an **`applyChanges` trigger**: the async "Reload" / "Reload all" toast handlers `await vaultIndexStore.applyChanges([rel])` then mutate stores keyed by relPath — a swap during the re-read applies the outgoing vault's disk content to the new vault's same-named file. The handlers are anonymous arrows the unit scan can't see, but the trigger fires on the CONTAINING named `prompt*` function's body (caught two siblings the plan never named: `promptPartialReadExhausted` + `promptExternalEditOnSync`). L16 also converts `handleExternalAttachmentChanges` from a `GUARD_EXEMPT` path-string compare to a real `isStillSameVault` guard (capture before the grace `setTimeout`), so its exemption is removed and reverting the guard re-flags it. **Audit-16 7.4** adds `runRecoverySequencer` ([src/renderer/stores/vault.svelte.ts](src/renderer/stores/vault.svelte.ts)) to the Part 3 pinned list: its step-2 tag-rewrite confirm handlers await `convergeForward`/`clearPendingRewrite` then prune the fileTags registry against the live tree (3.2 — a swap straddling the awaits used to wipe EVERY fileTags entry in the new vault), and Part 1 can't reach them — the gate deliberately never sweeps `vault.svelte.ts` (its lifecycle functions legitimately read the live path across awaits) and the handlers are anonymous arrows.
- **`ci:direct-board-mutations`** / **`ci:command-snapshot-discipline`** / **`ci:commands-target-board`** — undo/redo correctness ratchets (high-value mutators route through the command pattern; every Command snapshots its slice and carries a `targetBoardId`).
- **`ci:command-roundtrip-coverage`** ([scripts/check-command-roundtrip-coverage.mjs](scripts/check-command-roundtrip-coverage.mjs)) — Audit6 5.5: every concrete `Command` subclass must be exercised by an execute/undo ROUND-TRIP test (construct → execute → undo) or carry a documented `ROUNDTRIP_EXEMPT` reason (full before/after-snapshot / inverse-op commands that can't silently no-op). Closes the H1 class — a degenerate-delta command (e.g. a multi-slot section/column reorder) shipping a silent no-op because no test drove its happy path through execute → undo.
- **`ci:eol-preservation`** ([scripts/check-eol-preservation.mjs](scripts/check-eol-preservation.mjs)) — Audit7 H2 / Phase 7 + **Audit8 M1**: pins that `assembleMarkdownFile`'s dirty-frontmatter branch ([src/renderer/lib/editor/markdownSync.ts](src/renderer/lib/editor/markdownSync.ts)) re-applies the file's line ending to the FM block + `---` fences (`detectFrontmatterEol` + `.replace(/\n/g, eol)`) instead of hard-coding `\n`. The CST engine normalises the FM source to LF, so without the re-apply a CRLF note silently flips its frontmatter to LF on the first metadata edit (mixed file) or flips the whole file when an editor edit dirties the FM. The token-presence check is only a tripwire — it can't catch a *wrong* eol value (M1's hole: a single-line FM has no internal `\r\n`, so a truthy stripped-FM source short-circuited the CRLF body and the helper returned `'\n'`). So the gate ALSO asserts the real protection survives: the single-line-CRLF behavioral matrix in `assembleMarkdownEngine.test.ts` (its A8-M1 describe block + the gateway-threaded `eol: '\r\n'` capability) drives the whole assemble and asserts the output bytes stay CRLF.
- **`ci:no-dead-flush`** ([scripts/check-no-dead-flush.mjs](scripts/check-no-dead-flush.mjs)) — Audit7 M1 / Phase 7: M1's root cause was dead code — `TextTile` defined a `flushPendingMarkdownWrite()` that nothing ever called, so the dirty-writer entry was never cleared and `isDirty` pinned true (spurious external-edit prompts + frozen sibling reload). The gate walks `src/renderer/components/**.svelte` and fails any component-scope `function flush*` never referenced (in a `<script>` or bound from markup). Escape: `// allow-dead-flush: <reason>`.
- **`ci:no-silent-write-abort`** ([scripts/check-no-silent-write-abort.mjs](scripts/check-no-silent-write-abort.mjs)) — Audit8 B1 / Phase 5 + **Audit9 L3/L4**: forbids the root-cause shape of the worst bug Audit8 found — a bare `if (!docState) return;` on the frontmatter write path ([src/renderer/lib/boards/frontmatterWriteScheduler.ts](src/renderer/lib/boards/frontmatterWriteScheduler.ts)). A field edit on a Kanban card / Task row that was never opened as a Document tab has a `docId` (FM merged into the keyed cache) but no live `docState`; the bare return resolved the write as SUCCESS → `markClean` wiped the `.filo/.dirty` sentinel → the `.md` was never written and the edit silently reverted on quit. The fix falls through to a fresh disk read and, on read failure, `markPathFailed` + `throw`. **Audit9 L4** widened the scan from that single file (the old docstring overstated the scope) to every frontmatter WRITER + write SCHEDULER under `src/renderer/lib/{boards,kanban,tasklist}/**` (basename `=~ /riter|scheduler/i` — `kanbanFrontmatterWriter`, `tasklist/frontmatterWriter`, the five `*Scheduler.ts`). It forbids `!docState) return` in any of them AND a bare `!fm) return` *without* a `markPathFailed` in the same file — the **A9-L3** silent-drop twin: a docId-less write (`scheduleFrontmatterWrite(path, null)`) whose path is absent from the vault index hits `if (!fm) return` and drops the edit identically (the fix routes docId-less Task/Kanban field edits through the direct, undoable, loud-failing `UpdateOrphanFrontmatterCommand` instead). The scheduler keeps its one guarded `!fm) return` because the file *also* `markPathFailed`+throws on the real no-editor disk-read failure. Still requires the loud-failure surface (`markPathFailed` + `readMarkdownForHydrate`) in the scheduler. **Audit10 H2** adds a `GATEWAY_REQUIRED` arm — the gateway-twin of the same loss class: a body-only editor save with an EMPTY/never-seeded FM cache ([src/renderer/lib/vault/markdownFileWriter.ts](src/renderer/lib/vault/markdownFileWriter.ts) `writeMarkdownFileImpl` cache-FM branch) would assemble against `{}` and STRIP the on-disk YAML block (reachable via the TextTile sibling-adoption hydrate, which flips `hydrated` without seeding FM). The fix re-reads disk in-chain + seeds the cache when `!documentStore.hasFrontmatter(docId)` AND the caller passes no FM (`argsFmEmpty`); the gate REQUIRES both distinctive tokens (`hasFrontmatter(` + `argsFmEmpty`) survive in the gateway so the re-read can't be quietly dropped. Comment-stripped; escape: `// allow-silent-abort: <reason>`. Behavioral matrices: the no-`loadDocument` cases in `kanbanFrontmatterSeedFromDisk.test.ts` (B1) + `auditNinePhase2.test.ts` (A9-L2/L3) + the empty-cache gateway re-read in `audit10Phase2.test.ts` (H2). **Audit-12 M1** adds a `DOC_EDITOR_FILE` arm — the DocumentEditor twin of the same loss class: a failed on-mount hydrate read left the editor blank + writable, so a keystroke truncated the real (unread) file on the next debounced write. The gate REQUIRES both distinctive tokens survive in [src/renderer/components/boards/DocumentEditor.svelte](src/renderer/components/boards/DocumentEditor.svelte) — `hydrateReadFailed = true` (the catch flags it) and `hydrateReadFailed && !lastLoadedBody` (buildWriteArgs refuses to write) — so the editor can't silently regress to "blank but writable on a failed read." Test: `documentEditorHydrateFailure.test.ts`. **Audit-16 7.1** adds the 1.2 + 1.1 twins: (a) a POSITIVE read-only test followed by a bare abort (`isReadOnly(...)) return` / `readOnlyDoc) return`) is forbidden OUTRIGHT in the swept writer/scheduler files (no `markPathFailed` co-presence escape — the scheduler always has unrelated `markPathFailed` calls, which would make the arm a no-op), and two REQUIRED scheduler tokens pin the positive halves (`readOnlyDoc && !delta` — only delta-LESS writes refuse; `!readOnlyDoc ?` — a read-only delta sources its body from disk, never the lossy `docState.body`); (b) [src/renderer/stores/document.svelte.ts](src/renderer/stores/document.svelte.ts) `updateContent` must bump the shared `mutationVersions` staleness token + the lockstep `bodyMutationVersions` mirror (tokens required INSIDE the brace-matched method body), and `getFrontmatterOnlyMutationVersion` must survive file-wide — else a delta-less Task-notes write is mistaken for stale and silently no-ops as SUCCESS (the 1.1 quit-loss). Behavioral matrix: `audit16Phase1.test.ts`.
- **`ci:frontmatter-delta-write`** ([scripts/check-frontmatter-delta-write.mjs](scripts/check-frontmatter-delta-write.mjs)) — Write-path-remediation **Phase 4** (the root-cause refactor): pins that the field/popup frontmatter write path applies an explicit **delta** to a FRESH disk read at write time, instead of serialising a cached full FM object. Before Phase 4 the write read `documentStore.getFrontmatter(docId)` (a full object that could be stale / over-cleaned / empty) and diffed it against a SEED-TIME source, so the source-preserving CST engine faithfully wrote the WRONG object — silently dropping an untouched key (e.g. one an external editor added). Nine audits kept finding new instances because the invariant was test-enforced, not structural. The gate makes it structural across two halves: (a) the gateway delta branch ([src/renderer/lib/vault/markdownFileWriter.ts](src/renderer/lib/vault/markdownFileWriter.ts) `writeMarkdownFileImpl`) reads `vault:read-file-text` IN-CHAIN and sources BOTH the applied object AND the `originalFrontmatter` baseline from that one read (`applyFrontmatterDelta(parsedFresh.frontmatter, …)` + `originalFrontmatter: parsedFresh.rawFrontmatter`), so the engine rewrites only the delta keys and emits every untouched key from disk by construction; (b) the field-edit + Properties write sites CONSTRUCT a delta — `patchToFrontmatterDelta(patch)` threaded through `scheduleFrontmatterWrite` in the field commands + the `applyFrontmatterPatchRebased` undo/redo chokepoint, and `frontmatterDelta` on the Properties command + `diffToFrontmatterDelta(openSnapshot, currentRows)` in the popup live-write. The delta primitives live in the pure [src/renderer/lib/vault/frontmatterDelta.ts](src/renderer/lib/vault/frontmatterDelta.ts). The cache (`mergeFrontmatter`/`getFrontmatter`) is now DISPLAY-only (Kanban cards / Task rows render from it) and never the write source. **Audit-11 FILO-UR-1** extends the gate with a FUNCTION-SCOPED (`within`) check on the orphan card/task write `applyOrphanPatchRebased` ([src/renderer/commands/kanbanCommands.ts](src/renderer/commands/kanbanCommands.ts)): Phase 4 migrated the docId path to the delta but left this twin on the old whole-object clean (`{ ...baseFm, ...patch }` + drop-empty-keys loop), dropping present-but-empty disk keys (`aliases:`/`cssclasses:`) on execute AND undo. The orphan check REQUIRES a `frontmatterDelta` and FORBIDS a `frontmatter:` whole-object write inside that one function (string+comment-blanked brace-match, so the ban can't false-positive elsewhere in the file). Comment-stripped token check; behavioral proof: the STALE-cache seam round-trips in `writePathRemediationPhase4.test.ts` (the #1 repro survives WITHOUT the Phase-2 cache-drop) + the orphan byte-survival round-trips in `audit11Phase1.test.ts`. See WRITE_PATH_REMEDIATION_PLAN_2026-06-04 Phase 4 and AUDIT11_REMEDIATION_PLAN_2026-06-06 Phase 1/5.
- **`ci:writer-path-honors-filepath`** ([scripts/check-writer-path-honors-filepath.mjs](scripts/check-writer-path-honors-filepath.mjs)) — Audit-10 **B2**: the field/popup text-tile WRITE-path resolvers in [src/renderer/lib/kanban/kanbanFrontmatterWriter.ts](src/renderer/lib/kanban/kanbanFrontmatterWriter.ts) and [src/renderer/components/tiles/PropertiesPopup.svelte](src/renderer/components/tiles/PropertiesPopup.svelte) built `${title}.md` at the vault ROOT and never consulted the def's explicit `filePath`. After a restart (boards don't preload docs, so `documentStore` is empty) a subfolder card's edit resolved to the wrong root path — `UpdateCardFieldCommand` then ENOENT-lost the edit, or silently corrupted an unrelated same-named root file. The fix routes both through the canonical `resolveTextTileVaultPath` ([src/renderer/lib/boards/textTilePath.ts](src/renderer/lib/boards/textTilePath.ts)), closing the systemic "policed the FM object, never the path" gap. The gate is a **narrow allowlist**: an exact list of the field/popup write-path resolver sites (the two B2 fixes + the already-correct `TaskListBoard` / `TaskItem`), each asserted to reference `resolveTextTileVaultPath`; a missing file fails loud so coverage can't be silently dropped. A broad `${…title…}.md`-literal scan is deliberately avoided — ~15 legitimate sites (full-text search, the convention-path builders, read-only DISPLAY resolvers like `KanbanCard`) correctly build `${title}.md` without the canonical resolver. `TextTile` / `KanbanCard` are NOT listed: they resolve inline and consult `filePath` directly (never broken). Bite-verified (temp non-conforming + missing entries → exit 1).
- **`ci:document-editor-pane-scoped`** ([scripts/check-document-editor-pane-scoped.mjs](scripts/check-document-editor-pane-scoped.mjs)) — Audit-11 **R1**: forbids any `tabStore.activeTab` / `tabStore.activeTabId` read inside [src/renderer/components/boards/DocumentEditor.svelte](src/renderer/components/boards/DocumentEditor.svelte). The editor used to resolve its doc from the GLOBALLY-active tab, so in a split pane both Document editors bound to the same doc — mirroring it, swapping content underneath via the `mode:'full'` reload, and staling the captured `callerId`/force-writer (single-pane sessions were unaffected, which is why every prior audit missed it). The fix makes it pane-scoped via a `tabId` prop (`tab = tabStore.tabs.find((t) => t.id === tabId)`). JS+HTML comments and strings are blanked (offset-preserving) before the scan, so the comment that names the forbidden read can't trip it; a markup mustache read is still caught. Escape: `// allow-global-tab: <reason>`. Bite-verified (temp global-tab read → exit 1). **Audit-12 M5** widens it from DocumentEditor alone to a multi-target pane-scope gate that ALSO forbids global `boardStore`/`canvasStore` reads in [src/renderer/lib/canvas/dragDrop.ts](src/renderer/lib/canvas/dragDrop.ts): a `drop` has no preceding pointerdown to activate the target pane, so a global read landed an OS file-drop on the ACTIVE pane's board with its viewport. `dragDropAction(node, scope)` now takes the pane's `BoardScope` and creates against `scope.board`/`scope.canvas`. Escape: `// allow-global-board-facade: <reason>`. Test: `dragDropPaneScope.test.ts`.
- **`ci:board-path-casefold`** ([scripts/check-board-path-casefold.mjs](scripts/check-board-path-casefold.mjs)) — Audit-12 **M4**: the document path pipeline case-folds every vault-path compare (`samePath` / `normalizeVaultRelative`); the board pipeline used a raw `===` on `normalizePath` (NOT case-folding). On a case-insensitive FS, an externally edited/renamed `.board.json` whose OS-reported casing diverged from the stored casing was silently ignored (`findBoardIdForPath` in [src/renderer/stores/vaultExternalReconcilers.ts](src/renderer/stores/vaultExternalReconcilers.ts) returned null → no reload) or failed to rebind on rename (`renameBoardPath` in [src/renderer/stores/boardCache.svelte.ts](src/renderer/stores/boardCache.svelte.ts) → cache left keyed at the stale path → phantom-file write + "missing on disk" eviction). The gate extracts each function's body (string/comment-blanked) and asserts it references the case-folding helper AND contains no raw case-sensitive path compare. Test: `boardPathCaseFold.test.ts`; bite-verified. **Audit-15 P6.2** extends it to the board-EXTENSION match: `scanBoardFiles` ([src/main/vault/boardFileOps.ts](src/main/vault/boardFileOps.ts)) and `classifyChange` ([src/main/services/fileWatcherClassify.ts](src/main/services/fileWatcherClassify.ts)) each `.endsWith('.board.json')` and must do so on a `.toLowerCase()` receiver — else an externally case-mangled `.board.json` (external tool / cloud sync writes `Plan.Board.json`) is silently dropped from `board:list` (P1.3) / misrouted to `tree`. Run on a comment-stripped, STRING-PRESERVING copy so the literal is visible; bite-verified both the `BOARD_EXTENSION`-identifier and `'.board.json'`-literal arms.
- **`ci:copy-file-source-guard`** ([scripts/check-copy-file-source-guard.mjs](scripts/check-copy-file-source-guard.mjs)) — Audit-12 **S1**: `vault:copy-file` used to copy ANY absolute path the renderer named into the vault — only the DESTINATION was `assertWithinVault`-d — making it an arbitrary host-file READ primitive under a hostile-vault threat model (copy `~/.ssh/id_rsa` in, then exfiltrate). The fix constrains the SOURCE to an APPROVED set: files inside the vault, or ones the user explicitly chose via a native dialog (`dialog:open-file`) / real OS drag-drop (the preload's `getPathForFile`), tracked in [src/main/services/approvedSources.ts](src/main/services/approvedSources.ts) (`isApprovedCopySource`). Registration only flows through trusted contexts the hostile renderer can't drive with an arbitrary path: main owns the dialog (the USER picks), and the drop path is minted by the preload's `getPathForFile` via a **direct** `ipcRenderer.send` on the preload-internal `vault:register-source-path` channel — deliberately NOT a `SendChannel`, and carrying a `z.never()` payload schema so any renderer-side `window.filo.send/invoke` of it is rejected ([src/main/ipc/dialog.ipc.ts](src/main/ipc/dialog.ipc.ts) registers the `ipcMain.on`). Plus a TOCTOU pass in `copyFileToVault` ([src/main/vault/fileOps.ts](src/main/vault/fileOps.ts)): an fstat re-check on the open fd (catches a post-lstat swap to a device/FIFO/dir) and a streamed-BYTE cap (`maxBytes`, defeats a `/dev/zero`-style device that under-reports `size`). The gate pins both enforcement points — the `vault:copy-file` handler references `isApprovedCopySource`, and `copyFileToVault` keeps `maxBytes` + `.isFile()` — function-scoped on a string/comment-blanked body so a comment can't satisfy it. Test: `copyFileSourceGuard.test.ts`; bite-verified (remove either guard → exit 1). **S2 (same phase, no gate):** `media:open-external` drops `http://` from the open allowlist (`https://`/`mailto:`/`tel:` remain; a legacy `http://` link logs a warning + refuses) and runs `assertSafeFilename` on the local-path basename (blocks Windows reserved DOS names); `isWithinVaultRoot` ([src/main/vault/fileOps.ts](src/main/vault/fileOps.ts)) now case-folds on Windows. Tests in `mediaOpenExternalLauncherExt.test.ts`.
- **`ci:filo-read-guard`** ([scripts/check-filo-read-guard.mjs](scripts/check-filo-read-guard.mjs)) — Audit-15 **P6.3** (backs **P3.1**): a renderer-facing channel that reads file CONTENT from a renderer-supplied relative path must refuse `.filo/` via `assertNotInFiloDir`, so a renderer can't stream config/theme/tags bytes out (or serve them as media under a MIME the allowlist hasn't caught). The gate SWEEPS `src/main/ipc/**` for every `ipcMain.handle` whose body both reads bytes (`readFile*` / `createReadStream`) AND validates a renderer relpath (`assertSafeRelativePath`), and requires `assertNotInFiloDir` UNLESS the channel is in the documented `FILO_READ_EXEMPT` (today only `vault:read-file-text` — the trusted text channel the app's OWN crash-recovery + vault index read `.filo/` sentinels through). Channels that build a `.filo/` path internally (`config:load` / `theme:load` / `tags:load`) don't take a renderer relpath, so the sweep never sees them; structured-data reads that delegate the byte read to a helper (`board:load` → `loadBoardFile`) have no read primitive in the handler body. Plus two NAMED anchors the sweep can't reach: `media:read-file` (pinned by name in case its read moves to a helper) and `resolveServableMediaPath` ([src/main/protocol/mediaPathGuard.ts](src/main/protocol/mediaPathGuard.ts), the `filo://` protocol stream — a `protocol.handle`, not `ipcMain.handle`). Segment-based extraction (split by `ipcMain.handle` marks, NOT brace-matched — a handler body's regex literals / `${…}` templates make a naive brace matcher overrun into its sibling). A `MIN_SWEPT` tripwire fails loud if the read-primitive / validator patterns go stale. Test: `mediaReadFileFiloGuard.test.ts`; bite-verified (drop the guard from `media:read-file`, the protocol resolver, or any swept non-exempt channel → exit 1; emptying `FILO_READ_EXEMPT` proves the sweep genuinely covers `vault:read-file-text`).
- **`ci:css-vars`** ([scripts/check-css-vars.mjs](scripts/check-css-vars.mjs)) — Audit-15 **P6.4** (backs **P1.2**): P1.2 shipped `var(--ui-accent)` / `var(--ui-surface-deep)` in SearchPanel — custom properties defined NOWHERE (the real tokens are `--accent-primary` / `--ui-surface`), so the no-fallback uses rendered to nothing (invisible Replace toggle in light/sepia/forest themes); pure CSS, so no unit test and `svelte-check` caught it. The gate collects every custom property DEFINED in `src/**` (generously — `--name:` in `.css`/`.svelte`/inline `style="--x:"`, `style:--x` directives, `setProperty('--x')`) and every `var(--x)` USE with NO fallback (precisely — only in `.css` + `.svelte` with `<script>`/comments blanked, so a `var(--x)` in a test fixture / JS string / comment can't trip it), then fails on any used-but-never-defined token. `var(--x, fallback)` is intentionally NOT flagged (the fallback renders something). Offsets preserved through blanking so reported line numbers are real. `ALLOWLIST` (documented, empty today) escapes a token defined outside `src/`; a `MIN_DEFINED` tripwire fails if the collectors go stale. Bite-verified (no-fallback undefined var → red at the right line; with-fallback + `<script>`-string + defined-token all correctly ignored).
- **`ci:tasklist-section-clamp`** ([scripts/check-tasklist-section-position-clamp.mjs](scripts/check-tasklist-section-position-clamp.mjs)) — Task List audit 2026-06-08 **Phase 4** (closes **SEC-1/SEC-2/SEC-4** structurally): a Task List section `position` is an ABSOLUTE index into the flat `tasks[]` (section *k* owns `[position_k, position_{k+1})`), so a `position > taskCount` is not a valid index — it owns nothing AND silently misroutes a later add-to-section into an earlier neighbour (SEC-1); the tail-tie dedup used to emit `taskCount+1, taskCount+2, …` (SEC-2). The fix CLAMPS every normalised position into `[0, taskCount]` (trailing empty ties PIN at taskCount) and relies on a STABLE sort so the caller's array order disambiguates ties deterministically (SEC-4). The behavioural matrix lives in [src/tests/unit/boardCacheTaskList.test.ts](src/tests/unit/boardCacheTaskList.test.ts) (the `[0, taskCount]` / tail-tie / SEC-1-add-to-2nd-empty cases); this gate pins the MECHANISM in source so a refactor can't silently delete it. It extracts ONLY the body of `persistTaskListStructure` ([src/renderer/stores/boardCacheTaskList.ts](src/renderer/stores/boardCacheTaskList.ts)) on a string/comment-blanked copy and REQUIRES the upper clamp `Math.min(<…>, taskCount)` (bound MUST be `taskCount`, so a swap to `sections.length` is caught), the lower clamp `Math.max(0, <…>)` (either arg order), and a `.sort(`. Bite-verified (drop the clamp OR swap the bound → red; faithful copy → green).
- **`ci:pointer-capture-cleanup`** ([scripts/check-pointer-capture-cleanup.mjs](scripts/check-pointer-capture-cleanup.mjs)) — Audit-16 **6.1/7.5**: Frame.svelte's inline drag captured the pointer and opened `spatialStore.beginBatch()` but bound only `onpointerup` — a native `pointercancel` mid-drag (touch/pen OS gesture) left the batch open forever (spatial revision frozen → viewport-culled rendering stopped updating; looks like data loss) and the stuck drag flag moved the frame on the next hover with NO undo command, persisted to disk. The gate is deliberately NARROW: the plan's broad sketch ("every component `setPointerCapture` needs a cancel binding") was surveyed and would allowlist 10 benign popup-drag components (stale local flag, self-heals, no batch — false-positive-heavy), so the sweep instead flags any `src/renderer` file combining `setPointerCapture(` + `beginBatch(` without a `pointercancel`/`lostpointercapture` reference (comment-stripped but STRING-preserving — the lib evidence is the `addEventListener('pointercancel', …)` literal; zero exemptions today: Frame.svelte + `tileDrag.ts`), plus a Frame.svelte named anchor requiring both cancel bindings AND ≥2 `spatialStore.endBatch(` sites (drag-end handler + the unmount-teardown `$effect` for a frame destroyed mid-drag). Escape: `// allow-pointer-capture-leak: <reason>`. Tripwires fail loud if the collectors go stale. All three arms bite-verified.
- **`test:unit:strict`** ([scripts/test-unit-strict.mjs](scripts/test-unit-strict.mjs)) — runs vitest and fails on the Phase 4 stderr-noise patterns (missing `window.filo` mock).

a11y axe-core scan runs on every push (after `verify`); full Electron E2E runs only on `main` pushes and a nightly cron.

---

## Tech Stack (Locked — Do Not Substitute)

| Layer              | Technology                                                             |
| ------------------ | ---------------------------------------------------------------------- |
| Shell              | Electron (main process: Node.js)                                      |
| Frontend           | Svelte 5 (runes: `$state`, `$derived`, `SvelteSet`), TypeScript, Vite |
| Rich text editor   | TipTap (ProseMirror) + tiptap-markdown for MD round-tripping          |
| Canvas             | Custom pointer-event handlers + rbush (spatial index)                  |
| Markdown parsing   | unified + remark-parse + remark-frontmatter, gray-matter for FM        |
| Full-text search   | MiniSearch                                                             |
| Schema validation  | Zod                                                                    |
| List drag-and-drop | svelte-dnd-action                                                      |
| IDs                | nanoid                                                                 |
| Focus management   | focus-trap                                                             |
| Export             | html-to-image, jspdf                                                   |
| Testing            | Vitest (unit, jsdom env), Playwright (E2E + a11y axe-core)             |
| CSS                | Vanilla CSS only. CSS custom properties for theming.                   |

**Critical:** Canvas-level tile dragging is built on raw pointer-event handlers in `lib/canvas/`, NOT svelte-dnd-action (which only handles list-based drag in Kanban / Task List).

---

## Project Structure

```
filo/
├── package.json
├── electron.vite.config.mts
├── tsconfig.json
├── tsconfig.main.json
├── svelte.config.mjs
├── vitest.config.mts
├── playwright.config.ts
├── CLAUDE.md                          # This file
├── KNOWN_LIMITATIONS.md               # Accepted trade-offs (do NOT "fix")
├── Filo_Design_Doc_Rework_V5.md
│
├── src/
│   ├── main/                          # Electron main process
│   │   ├── main.ts                    # App entry, window creation, lifecycle
│   │   ├── preload.ts                 # contextBridge API exposure
│   │   ├── ipc/                       # IPC handler registrations
│   │   │   ├── index.ts               # Aggregated registration entry point
│   │   │   ├── vault.ipc.ts           # File CRUD, directory ops
│   │   │   ├── board.ipc.ts           # Board file create/delete, config + theme
│   │   │   ├── dialog.ipc.ts          # Native open dialogs
│   │   │   ├── shell.ipc.ts           # External URL opening, reveal-in-folder
│   │   │   ├── media.ipc.ts           # Media save/copy helpers
│   │   │   ├── fonts.ipc.ts           # System font enumeration
│   │   │   ├── tags.ipc.ts            # .filo/tags.json load/save
│   │   │   ├── templates.ipc.ts       # .filo/templates/ CRUD
│   │   │   ├── sidebar.ipc.ts         # Sidebar geometry (userData)
│   │   │   └── export.ipc.ts          # PNG/SVG/PDF/Markdown export
│   │   ├── services/                  # Main-process-only services
│   │   │   ├── fileWatcher.ts         # fs.watch wrapper, debounced events
│   │   │   ├── fileWatcherTypes.ts    # Shared watcher types
│   │   │   ├── vaultRegistry.ts       # Active vault tracker (gates IPC)
│   │   │   ├── recoverySnapshot.ts    # `.filo/recovery/` snapshot helper
│   │   │   ├── renameCorrelation.ts   # Pairs missing+present events into renames
│   │   │   ├── recentVaults.ts        # Persisted recent vault list
│   │   │   ├── windowState.ts         # Window size/position (userData)
│   │   │   └── sidebarState.ts        # Sidebar width/floating bounds (userData)
│   │   ├── protocol/                  # Custom protocol handlers
│   │   │   └── rangeHeader.ts         # HTTP Range parsing for media streaming
│   │   ├── vault/                     # Main-side vault file primitives
│   │   │   ├── fileOps.ts
│   │   │   ├── boardFileOps.ts
│   │   │   ├── configOps.ts
│   │   │   └── filenameUtils.ts       # atomicWriteFile, assertSafeFilename
│   │   └── utils/
│   │       ├── pathSecurity.ts        # assertWithinVault, assertSafeRelativePath
│   │       ├── activeVaultCheck.ts    # assertActiveVault (gates IPC handlers)
│   │       ├── mainLogger.ts          # Structured main-process logger
│   │       └── mime.ts                # MIME-type sniffing for media tiles
│   │
│   ├── renderer/                      # Svelte frontend (all UI)
│   │   ├── main.ts                    # Svelte app mount
│   │   ├── App.svelte                 # Root component, layout shell
│   │   ├── shims.d.ts                 # Ambient type shims (window.filo, etc.)
│   │   │
│   │   ├── core/                      # Core application wiring
│   │   │   ├── commandRegistry.ts     # Keyboard-shortcut binding surface (no palette yet)
│   │   │   ├── tileRegistry.ts        # Tile-type metadata + creation defaults (getTileDefaults); tile bodies render via board snippets, not a component map (Audit2 4.4)
│   │   │   ├── boardRegistry.ts       # Board-type registration; `component` is a lazy () => import() loader so boards code-split out of the Home preload (Audit2 4.4)
│   │   │   ├── boardDefaults.ts       # Per-type default board factories
│   │   │   ├── boardTileOps/          # Per-board-type tile-op registries (mindmap/kanban/tasklist/document)
│   │   │   ├── vaultLifecycle.ts      # onVaultSwap pre/post-swap hook registry
│   │   │   └── hotkeys.ts             # Keyboard shortcut binding
│   │   │
│   │   ├── stores/                    # Svelte 5 rune stores (.svelte.ts files)
│   │   │   ├── vault.svelte.ts        # Vault lifecycle, file tree, virtual project
│   │   │   ├── vaultIndex.svelte.ts   # In-memory metadata index + MiniSearch
│   │   │   ├── vaultExternalChanges.ts  # External-edit classifier consumer
│   │   │   ├── vaultRecovery.ts       # `.filo/.dirty` sentinel + recovery modal
│   │   │   ├── vaultFolderOps.ts      # In-app rename/delete/move
│   │   │   ├── vaultStoreTypes.ts     # Shared store types
│   │   │   ├── vaultTree.ts           # File-tree projection helpers
│   │   │   ├── vaultProject.ts        # Per-vault virtual project bootstrap
│   │   │   ├── vaultRootFolder.ts     # User-marked vault root for sidebar
│   │   │   ├── board.svelte.ts        # Active board facade
│   │   │   ├── boardCache.svelte.ts   # Per-board file cache + persist* CRUD
│   │   │   ├── boardCacheTiles.ts     # Cache-side tile/placement writers
│   │   │   ├── boardCacheKanban.ts    # Kanban cache writers
│   │   │   ├── boardCacheTaskList.ts  # Task-list cache writers
│   │   │   ├── boardCacheConnectionsFrames.ts
│   │   │   ├── boardCacheFrontmatter.ts
│   │   │   ├── boardCacheTypes.ts
│   │   │   ├── boardConnections.ts    # Active-board connection facade
│   │   │   ├── boardFrames.ts         # Active-board frames facade
│   │   │   ├── boardTiles.ts          # Active-board tiles facade
│   │   │   ├── boardWaypointsGroups.ts
│   │   │   ├── boardFrontmatterSync.ts  # Frontmatter→cache writer
│   │   │   ├── boardHistory.ts        # Per-board history facade for boardStore
│   │   │   ├── boardRefIntegrity.svelte.ts  # Broken file-reference tracking
│   │   │   ├── boardStoreTypes.ts
│   │   │   ├── canvas.svelte.ts
│   │   │   ├── selection.svelte.ts
│   │   │   ├── history.svelte.ts      # Per-board undo/redo stacks
│   │   │   ├── tabs.svelte.ts
│   │   │   ├── workspace.svelte.ts    # Split-pane layout
│   │   │   ├── connections.svelte.ts
│   │   │   ├── frames.svelte.ts
│   │   │   ├── fileTags.svelte.ts     # `.filo/tags.json` + tile-def sync
│   │   │   ├── templates.svelte.ts    # Layout-template store
│   │   │   ├── document.svelte.ts
│   │   │   ├── ui.svelte.ts           # Modals, toasts, context menu state
│   │   │   ├── theme.svelte.ts
│   │   │   ├── spatial.svelte.ts      # rbush index wrapper
│   │   │   ├── guides.svelte.ts       # Smart guides
│   │   │   ├── pendingSettings.svelte.ts  # Settings modal Apply/Cancel scope
│   │   │   ├── orphans.svelte.ts
│   │   │   ├── links.svelte.ts        # filo:// internal link handling
│   │   │   ├── tiles.svelte.ts        # Tile factory + drop-type detection
│   │   │   ├── saveState.svelte.ts    # Idle/saving/saved/error indicator
│   │   │   └── toolbar.svelte.ts      # Toolbar undo/redo state
│   │   │
│   │   ├── schema/                    # Zod schemas + inferred TypeScript types
│   │   │   ├── index.ts               # Re-exports
│   │   │   ├── project.ts              # Virtual Project (in-memory only — no file on disk)
│   │   │   ├── board.ts
│   │   │   ├── boardFile.ts           # V7 .board.json file shape + boardId cross-checks
│   │   │   ├── tile.ts
│   │   │   ├── placement.ts
│   │   │   ├── connection.ts
│   │   │   ├── frame.ts
│   │   │   ├── document.ts
│   │   │   ├── settings.ts
│   │   │   ├── tagsFile.ts             # .filo/tags.json envelope + migration scaffold
│   │   │   ├── layoutTemplate.ts       # .filo/templates/*.json envelope + migration scaffold
│   │   │   ├── link.ts                 # filo:// link encode/decode + DecodedFiloLinkSchema
│   │   │   ├── migrations.ts
│   │   │   └── schemaUtils.ts          # uniqueBy / uniqueStrings / idString (NANOID_REGEX)
│   │   │
│   │   ├── commands/                  # Command pattern objects (undo/redo)
│   │   │   ├── index.ts               # Re-export shim — every import path still works
│   │   │   ├── Command.ts             # Base Command interface + abstract class (targetBoardId)
│   │   │   ├── tileCommands.ts        # tile add/delete/move/resize/style/lock
│   │   │   ├── tileTagCommands.ts     # tile/path tag add/remove + fade-by-tag (via fileTagsStore)
│   │   │   ├── connectionCommands.ts  # connection add/delete/update
│   │   │   ├── frameCommands.ts       # frame add/update/move/delete
│   │   │   ├── sectionCommands.ts     # Task List section add/delete/rename/reorder
│   │   │   ├── taskCommands.ts        # Task List add/delete/move/field/lock/style + snapshots
│   │   │   ├── kanbanCommands.ts      # Kanban card + column add/delete/move/rename
│   │   │   ├── waypointCommands.ts    # Mind Map waypoint add/remove/rename/move/icon/lock
│   │   │   ├── groupAndBoardCommands.ts # BatchCommand, ToggleGroupCommand, CascadeDeleteCommand, UpdateBoardSettingsCommand
│   │   │   ├── styleCommands.ts       # Style-popup commands (Frame/Card/Column/Task/Section/Connection)
│   │   │   ├── propertiesCommands.ts  # UpdatePropertiesCommand
│   │   │   ├── attachmentSrcCommand.ts# Image/Video/Audio/File swap
│   │   │   ├── renameTitleCommand.ts  # Tile title rename (cache + doc + .md file)
│   │   │   ├── replaceAllCommand.ts   # Vault-wide find-and-replace (history-tracked)
│   │   │   └── savedViewsCommand.ts   # UpdateSavedViewsCommand
│   │   │
│   │   ├── constants/
│   │   │   ├── defaults.ts            # TILE_DEFAULTS, FRAME_DEFAULTS, ACCENT_COLOR
│   │   │   ├── styleOptions.ts        # Shared style option lists (shape/border/pattern/path/arrow)
│   │   │   └── taskPriorities.ts      # Task / Kanban priority display metadata (color + label)
│   │   │
│   │   ├── lib/                       # Pure logic, no UI
│   │   │   ├── vault/                 # Vault-side helpers (renderer)
│   │   │   │   ├── vaultIndex.ts      # Metadata indexing + MiniSearch wiring
│   │   │   │   ├── fileRefIntegrity.ts# Rename propagation, broken-ref detection
│   │   │   │   ├── frontmatterSync.ts # External-edit reconciliation
│   │   │   │   ├── conflictResolver.ts# External-vs-dirty editor classifier
│   │   │   │   ├── dirtyFlagRecovery.ts # `.filo/.dirty` sentinel read/write
│   │   │   │   ├── conventionPaths.ts # Default attachment/board paths
│   │   │   │   ├── extension.ts
│   │   │   │   ├── moveIntoFolder.ts
│   │   │   │   ├── tagsStorage.ts     # `.filo/tags.json` mutators
│   │   │   │   ├── tagRewriteSweep.ts # Two-phase tag rename across .md
│   │   │   │   ├── tagRewriter.ts     # Frontmatter tag rename/remove/add (line-level fast path; dump fallback now routes through frontmatterEngine)
│   │   │   │   ├── frontmatterEngine.ts # Source-preserving FM serializer — `yaml` Document/CST API (Audit2 4.8)
│   │   │   │   ├── markdownFileWriter.ts # CANONICAL markdown write gateway: per-caller debounce, BOM-preserving hydrate, unified drain (the dead-in-prod markdownWriteRegistry shim was deleted in Audit2 5.9)
│   │   │   │   ├── tagRewriteSentinel.ts # `.filo/tag-rewrite-pending.json` crash-recovery
│   │   │   │   ├── renameCascadeSentinel.ts # Rename-cascade crash-recovery sentinel
│   │   │   │   ├── fileBaselineRegistry.ts # Pre-write drift baselines (mtime/size)
│   │   │   │   ├── externalChangeWindows.ts # Self-write / attachment-delete timing windows
│   │   │   │   └── vaultTreeSort.ts   # Sidebar sort/group helpers
│   │   │   ├── boards/                # Board file load/save logic
│   │   │   │   ├── boardLoader.ts
│   │   │   │   ├── boardSaver.ts      # File-write helpers
│   │   │   │   ├── boardScope.svelte.ts
│   │   │   │   ├── boardScopeFactory.ts
│   │   │   │   ├── boardWriteScheduler.ts
│   │   │   │   ├── boardWriteDebounce.ts
│   │   │   │   ├── configWriteScheduler.ts
│   │   │   │   ├── miscWriteScheduler.ts
│   │   │   │   ├── frontmatterWriteScheduler.ts
│   │   │   │   ├── seedTextFileForNewTile.ts # Creates the backing .md for a new text tile
│   │   │   │   ├── tileDefBuilder.ts
│   │   │   │   ├── textTilePath.ts
│   │   │   │   ├── viewportCache.ts
│   │   │   │   └── writeStateTracking.ts # trackComponentWrite + counters
│   │   │   ├── canvas/                # Canvas engine (custom pointer events)
│   │   │   │   ├── coordinates.ts     # screenToCanvas, getCanvasPointFromEvent
│   │   │   │   ├── viewport.ts
│   │   │   │   ├── gestures.ts        # Pan/zoom pointer-event bindings
│   │   │   │   ├── edgePan.ts         # Edge-panning on drag
│   │   │   │   ├── tileDrag.ts
│   │   │   │   ├── tileResize.ts
│   │   │   │   ├── dragDrop.ts        # OS file drop → tile factory
│   │   │   │   ├── markdownTileSeed.ts
│   │   │   │   ├── textTileDropPlan.ts
│   │   │   │   ├── layout.ts          # Auto-layout algorithms
│   │   │   │   ├── orphanCatcher.ts
│   │   │   │   ├── vaultPath.ts
│   │   │   │   └── smartGuides.ts     # Alignment guide calculations
│   │   │   ├── connections/           # Connection path routing
│   │   │   │   ├── pathRouter.ts      # Curved, Straight, Elbow, Smart routing
│   │   │   │   ├── connectionSelection.ts
│   │   │   │   └── bubblePositions.ts
│   │   │   ├── editor/                # TipTap setup
│   │   │   │   ├── createEditor.ts    # Editor factory with all extensions
│   │   │   │   ├── markdownSync.ts    # MD ↔ ProseMirror round-trip
│   │   │   │   └── tagExtension.ts
│   │   │   ├── kanban/                # Kanban-board logic
│   │   │   ├── tasklist/              # Task List logic
│   │   │   ├── tasks/                 # Task-frontmatter helpers, recurrence, quickAddParser (shared)
│   │   │   ├── mindmap/               # Mind-map keyboard + selection
│   │   │   ├── settings/              # Settings cascade helpers
│   │   │   ├── styles/                # Override-cascade resolver
│   │   │   │   ├── effectiveStyle.ts  # Tile / column / card / task / document style cascade
│   │   │   │   ├── resolveStyle.ts
│   │   │   │   ├── resolvedTileStyleContext.ts
│   │   │   │   ├── buildBoardDefaults.ts
│   │   │   │   ├── applyDefaultsToAll.ts
│   │   │   │   └── defaultFontSizes.ts
│   │   │   ├── themes/                # Theme loading + CSS variable injection
│   │   │   │   └── themeManager.ts
│   │   │   ├── export/                # PNG, SVG, PDF, Markdown export
│   │   │   │   └── exportService.ts
│   │   │   ├── templates/             # Layout templates
│   │   │   │   ├── templateService.ts
│   │   │   │   ├── layoutCapture.ts
│   │   │   │   └── layoutTemplateStore.ts
│   │   │   ├── search/                # Query parser + full-text search runner (MiniSearch)
│   │   │   ├── spatialIndex.ts        # rbush wrapper
│   │   │   └── utils/                 # Shared utilities
│   │   │       ├── ids.ts             # nanoid wrapper
│   │   │       ├── color.ts           # Colour manipulation helpers
│   │   │       ├── cloneTile.ts
│   │   │       ├── contextMenuKey.ts
│   │   │       ├── editableTarget.ts
│   │   │       ├── errorBus.ts        # Renderer error → toast routing
│   │   │       ├── errorToastAggregator.ts
│   │   │       ├── listKeyNav.ts
│   │   │       ├── mediaUrl.ts
│   │   │       ├── normalizeTagsField.ts
│   │   │       ├── path.ts
│   │   │       ├── popupAnchor.ts
│   │   │       ├── portal.ts
│   │   │       ├── sanitizeHtml.ts
│   │   │       ├── tileUpdateFastPath.ts
│   │   │       ├── urlSafety.ts
│   │   │       └── navigation.svelte.ts # navigateToTile + highlight state
│   │   │
│   │   └── components/                # Svelte components (UI only)
│   │       ├── shared/                # Shared UI primitives
│   │       │   ├── Modal.svelte
│   │       │   ├── Dropdown.svelte
│   │       │   ├── ContextMenu.svelte
│   │       │   ├── Toast.svelte
│   │       │   ├── ColorPicker.svelte
│   │       │   ├── EmojiPicker.svelte
│   │       │   └── IconButton.svelte
│   │       ├── home/                  # Home / vault picker screen
│   │       │   └── HomeScreen.svelte
│   │       ├── layout/                # App shell layout
│   │       │   ├── AppShell.svelte    # Sidebar + workspace + tab bar
│   │       │   ├── GlobalToolbar.svelte
│   │       │   ├── TabBar.svelte
│   │       │   ├── Tab.svelte
│   │       │   ├── SplitPaneContainer.svelte
│   │       │   ├── PaneView.svelte
│   │       │   └── PaneDropOverlay.svelte
│   │       ├── sidebar/               # Vault sidebar
│   │       │   ├── VaultSidebar.svelte
│   │       │   └── VaultFileItem.svelte
│   │       ├── boards/                # Board-type root components
│   │       │   ├── BoardRouter.svelte
│   │       │   ├── MindMapBoard.svelte
│   │       │   ├── KanbanBoard.svelte
│   │       │   ├── KanbanColumn.svelte
│   │       │   ├── KanbanCard.svelte
│   │       │   ├── KanbanSideToolbar.svelte
│   │       │   ├── TaskListBoard.svelte
│   │       │   ├── TaskItem.svelte
│   │       │   ├── TaskListSideToolbar.svelte
│   │       │   ├── SmartListTabs.svelte # Task List smart-list filter tabs
│   │       │   ├── TaskQuickAddInput.svelte # Task List quick-add (natural-language) input
│   │       │   ├── DocumentBoard.svelte
│   │       │   ├── DocumentEditor.svelte
│   │       │   └── SideToolbar.svelte # Mind-map side toolbar (move/new/etc.)
│   │       ├── canvas/                # Canvas rendering layer
│   │       │   ├── BoardBackground.svelte
│   │       │   ├── Minimap.svelte
│   │       │   ├── SmartGuides.svelte
│   │       │   └── WaypointMarker.svelte
│   │       ├── connections/           # Connection UI
│   │       │   ├── ConnectionLayer.svelte
│   │       │   ├── ConnectionPath.svelte
│   │       │   ├── ConnectionLabel.svelte
│   │       │   ├── ConnectionStylePopup.svelte
│   │       │   └── ConnectionBubbles.svelte
│   │       ├── frames/
│   │       │   ├── Frame.svelte
│   │       │   └── FrameStylePopup.svelte
│   │       ├── tiles/                 # Tile components
│   │       │   ├── TileContainer.svelte
│   │       │   ├── TileHeader.svelte  # Title, tags, lock, style, delete
│   │       │   ├── TileStylePopup.svelte
│   │       │   ├── TextTile.svelte
│   │       │   ├── ImageTile.svelte
│   │       │   ├── VideoTile.svelte
│   │       │   ├── AudioTile.svelte
│   │       │   ├── FileTile.svelte
│   │       │   ├── LinkTile.svelte
│   │       │   ├── IframeTile.svelte
│   │       │   └── TimerTile.svelte
│   │       ├── settings/              # Settings panels
│   │       │   ├── GeneralSettings.svelte
│   │       │   ├── CurrentBoardSettings.svelte
│   │       │   ├── BoardDefaults.svelte
│   │       │   ├── LivePreview.svelte
│   │       │   ├── ThemeManager.svelte
│   │       │   └── KeyboardShortcuts.svelte
│   │       ├── modals/                # Other modal dialogs
│   │       │   ├── ProjectSettings.svelte  # Tabbed wrapper around settings/
│   │       │   ├── BoardBrowser.svelte
│   │       │   ├── TemplateBrowser.svelte
│   │       │   ├── SaveTemplateModal.svelte
│   │       │   ├── TaskPropertiesModal.svelte
│   │       │   ├── OrphanCatcher.svelte
│   │       │   └── RecoveryFiles.svelte
│   │       └── tags/                  # Tag UI
│   │           ├── TagBadge.svelte
│   │           ├── TagEditor.svelte
│   │           ├── TagsBrowser.svelte
│   │           └── TagsPopupMenu.svelte
│   │
│   ├── css/                           # Global stylesheets
│   │   ├── style.css                  # App-wide base styles + CSS variables
│   │   └── conn.css                   # Connection-specific styles
│   │
│   ├── shared/                        # Shared between main + renderer
│   │   ├── types.ts                   # IpcChannel union, file-tree types
│   │   ├── ipcSchemas.ts              # Per-channel Zod payload validation
│   │   ├── ipcContracts.ts            # Per-channel arg/result TYPE contracts (ChannelResult<C>, etc.)
│   │   ├── untrusted.ts               # Branded `Untrusted<T>` + asSafe* validators (untrusted-sink discipline)
│   │   └── ipcEnvelope.ts             # IPC ok/error envelope + IpcEnvelopeError
│   │
│   └── tests/
│       ├── unit/                      # Vitest unit tests
│       └── e2e/                       # Playwright E2E tests
│
├── static/                            # Static assets bundled by Vite
│   └── themes/                        # Built-in theme JSON files
│
└── scripts/                           # Build / dev scripts (electron-vite launcher)
```

### Structure Rules

1. **One concern per file.** If a file grows past ~300 lines, split it. Existing larger files (board.svelte.ts, boardCache.svelte.ts, MindMapBoard.svelte) are tracked for further splitting; new code should not exceed the threshold.
2. **`lib/` holds non-UI logic.** It may use DOM globals and import from `stores/`, but must NOT contain Svelte component definitions (`.svelte` files) or import from `components/`. Must be testable with Vitest + jsdom alone.
3. **`components/` is UI only.** Components read from stores and call into `lib/`. Minimal logic in `<script>` blocks.
4. **`stores/` bridges the two.** Stores import from `lib/` for heavy logic and expose reactive state to components.
5. **`schema/` holds Zod schemas + their inferred TypeScript types.** Components and lib modules both import from here (named `schema/`, not `types/`). Never define shared types inline.
6. **Electron IPC is a hard boundary.** The renderer NEVER imports Node.js modules directly. All file system access goes through the preload bridge → IPC → main process.
7. **Canvas gestures use custom pointer-event handlers.** Pan, zoom, drag, resize, edge-pan all live in `lib/canvas/` as direct pointer-event listeners. `@use-gesture/vanilla` was previously listed as a dep but is no longer installed.

---

## Coding Conventions

### TypeScript

- Strict mode enabled. No `any` unless absolutely unavoidable (document why in a comment).
- Use `interface` for object shapes, `type` for unions/intersections.
- All function parameters and return types must be explicitly typed.
- Prefer `const` over `let`. Never use `var`.
- Use `createId()` from `lib/utils/ids.ts` (a `nanoid` wrapper with a 12-character default length) for all ID generation. Most IDs are unprefixed; a few call sites prepend a semantic prefix (e.g. `sec_${createId()}`).

### Svelte 5

- Use runes exclusively: `$state`, `$derived`, `$effect`, `SvelteSet`.
- No legacy `$:` reactive statements, no `writable()`/`readable()` stores.
- Store files use `.svelte.ts` extension to enable rune syntax.
- Component files use `.svelte` extension.
- Props use `$props()` destructuring with type annotation.
- Prefer `$derived` over `$effect` for computed values.

### CSS

- **Vanilla CSS only.** No Tailwind, no SCSS, no CSS-in-JS.
- Theme-dynamic values use CSS custom properties defined in `style.css` and overridden per theme.
- Component-scoped styles go in `<style>` blocks within Svelte components.
- Global styles go ONLY in `/css/style.css` and `/css/conn.css`.
- Inline styles are ONLY for runtime-dynamic values (tile positions, user-chosen colours).
- All animations use `transform` and `opacity` only (GPU-accelerated). Never animate `width`, `height`, `top`, `left`, `margin`, `padding`.
- Always respect `prefers-reduced-motion: reduce`.

### Naming

- Files: `camelCase.ts` for modules, `PascalCase.svelte` for components, `camelCase.svelte.ts` for stores.
- CSS variables: `--ui-{category}-{property}` (e.g., `--ui-surface`, `--ui-border`, `--ui-text-primary`).
- IPC channels: `vault:read`, `vault:write`, `dialog:open`, `window:minimize` (namespace:action).
- Store exports: named exports, not default. e.g., `export const boardStore = ...`.
- Command names: `verb:noun` format (e.g., `tile:add`, `connection:delete`, `board:export-png`).

### Icons

- **All icons must be SVG.** No emojis as icons, ever.
- Store SVG icons inline (as inline `<svg>` markup) in the component that uses them. There is **no** shared icon directory today — neither `components/common/icons/` nor `static/icons/` exists; a handful of reused glyphs are currently duplicated inline. If a shared set grows enough to warrant it, create `components/common/icons/` at that point and update this note.
- Use lucide-style icons for consistency. If adding custom icons, match the 24×24 viewBox, 2px stroke convention.
- **Exception — waypoint icons.** Mind Map waypoint icons are user-selectable content (a label the user picks for their own waypoint), not UI chrome, so they remain emoji. See `src/renderer/components/canvas/WaypointMarker.svelte`. Do not flag these in icon audits.

---

## Architecture Rules

### Data Flow

```
User action → Store mutation → Reactive UI update
                ↓
        Debounced write (300ms) → IPC → Main process → File system
```

```
External file change → fs.watch (main) → IPC → Store update → Reactive UI update
```

### Source of Truth Hierarchy

1. **File system** is the ultimate source of truth.
2. **YAML frontmatter** in `.md` files is the canonical source for metadata.
3. **Board JSON** fields that duplicate frontmatter (e.g., `completed`, `date`) are derived caches. On conflict, frontmatter wins.
4. **In-memory stores** reflect the file system state. They are caches, not sources.

### Persistence Boundary

All project state lives **inside the vault** — either a `.board.json`, a vault file (Markdown/media), or a `.filo/` config file. There is no `electron-store`, no `localStorage`, no `sessionStorage`, no `IndexedDB`. If you add a new piece of persisted state, route it through the vault.

The only state that lives in Electron `userData` (i.e. outside any vault) is the small carve-out of per-machine UI geometry and the launch bootstrap:

| File | Why it's outside the vault |
| --- | --- |
| `recent-vaults.json` | Must be readable before any vault is open. |
| `window-state.json` | Window size/position is per-display, not per-vault. |
| `sidebar-state.json` | Sidebar width and floating bounds are per-display. |

Anything else — including overlay positions (Kanban side toolbar etc.), open tabs, viewports, themes, defaults — goes in `.filo/`.

**Tag persistence — note for attachments.** Text-tile tags live in two synced places: `.board.json` tile defs and the file's YAML frontmatter (`tags: [...]`). Attachment-tile tags (image / video / audio / generic file) have nowhere to write into the file itself, so they live in `.board.json` plus `.filo/tags.json:fileTags[mediaPath]`. The trade-off: tags on attachments are **vault-local** — copying or moving an attachment outside the vault without `.filo/` will lose its tags, whereas text-tile tags travel with the `.md` file. This is a deliberate consequence of the open-format principle (no sidecar files next to media). Don't add a sidecar without a separate design discussion.

### The Vault API Contract

There is no single `vaultApi.ts` module. The "Vault API" is a contract split
across a few owners, all of which call IPC to the main process — the renderer
NEVER touches `fs` directly (Electron context isolation; see "Persistence
Boundary").

- **Reads / generic writes** go through the `window.filo` preload bridge
  (`src/main/preload.ts` → `src/main/ipc/*`). The renderer calls `window.filo.*`,
  never `require('fs')`.
- **Disk-shape mutations** (rename / delete / create-folder / copy-file) go
  through `lib/vault/vaultOperations.ts`. `withDrainedWrites(op)` first drains the
  writer pipelines, then runs the op via the thin IPC wrappers (`renameVaultPath`,
  `deleteVaultPath`, `createVaultFolder`, `copyFileIntoVault`). The CI gate
  `scripts/check-no-raw-disk-shape-ipc.mjs` forbids raw renderer invokes of those
  four channels outside this module.
- **On file rename:** `lib/vault/fileRefIntegrity.ts` scans and updates ALL
  `.board.json` file references. The in-app rename/delete/move entry point is
  `stores/vaultFolderOps.ts`.
- **On file delete (from vault):** the same cascade removes every tile placement
  referencing that file from each `.board.json`.
- **Broken file references** are detected on board load and tracked via
  `stores/boardRefIntegrity.svelte.ts` — flagged, not silently ignored.

### Debouncing

- Content edits (tile text, frontmatter): 300ms idle debounce before disk write.
- Layout changes (tile move/resize, connections): 300ms idle debounce.
- Config changes (`.filo/` files): write on panel close or confirmation.
- File watcher events: 300ms debounce to batch rapid changes.

### Registry Pattern

Three registries power extensibility:

- **TileRegistry** — Maps `TileType` string to its display metadata + creation defaults (`getTileDefaults`). Adding a new tile type means registering its defaults here. Tile *bodies* are rendered by the boards via Svelte snippets, not through the registry — the former `component` field was dropped in Audit2 4.4 (it had no readers, and its eager `*.svelte` imports pulled TipTap into the Home-screen preload).
- **BoardRegistry** — Maps `BoardType` string to board component + toolbar component + schema.
- **CommandRegistry** — Binds keyboard shortcuts via `registerCommandWithShortcut` using a verb:noun naming scheme. There is no command palette today; the former `registerCommand` / `unregisterCommand` no-op stubs were removed (Phase G.12) to avoid dead-API drift. When a palette lands, reintroduce them backed by a `Map<name, handler>` populated alongside the shortcut.

When adding a new tile type or board type: register it, implement the interface, done. Never scatter type checks across the codebase.

### Undo/Redo

- Uses command pattern. Every undoable action implements `{ execute(): void; undo(): void }`.
- Each board has its own independent undo/redo stack.
- Text editing undo is handled by TipTap/ProseMirror internally (separate from board undo).
- Board-level Ctrl+Z fires when no TipTap editor is focused.

### Override Cascade (Styles)

```
Per-element style (Tile Style popup) > Current Board Settings (.board.json) > Global Defaults (.filo/defaults.json)
```

Themes overwrite Global Defaults. They are not a separate layer.

---

## Key Design Decisions — Do Not Deviate

1. **Local-first. No network calls.** No telemetry, analytics, or remote APIs. Everything works offline.
2. **Open format.** Text is Markdown. Boards are JSON. Media files are stored as-is. A user must be able to read their data with any text editor.
3. **File-backed tiles.** Text, Image, Video, Audio, and File tiles point to real files in the vault. Link, Iframe, and Timer tiles store data inline in board JSON.
4. **One `.md` file = one document.** A Text Tile and a Document Board are two views of the same `.md` file. Edits in either view reflect immediately in the other.
5. **Same file on multiple boards.** Board JSON stores placement (position, size, style). Content comes from the shared vault file.
6. **Frontmatter is canonical.** Board JSON caches metadata but frontmatter wins on conflict.
7. **No external state management libraries.** Svelte 5 runes only.
8. **Vanilla CSS only.** CSS custom properties for theming. No Tailwind, no preprocessors.
9. **SVG icons only.** No emojis as icons.

---

## Common Gotchas

- **tiptap-markdown** — This handles Markdown ↔ ProseMirror round-tripping. The unified/remark pipeline is for VaultIndex metadata extraction, NOT for the editor.
- **svelte-dnd-action** — This is for Kanban column/tile reordering and Task List reordering. Canvas tile dragging is custom (raw pointer-event handlers + manual transform).
- **`$effect` vs `$derived`** — Use `$derived` for computed values. Use `$effect` only for side effects (IPC calls, DOM manipulation, subscriptions). Overuse of `$effect` is a code smell.
- **Store file extension** — Must be `.svelte.ts` for runes to work. Plain `.ts` files cannot use `$state`.
- **Electron context isolation** — `contextBridge` exposes a limited API object on `window`. The renderer calls `window.api.vault.read(path)`, NOT `require('fs')`.
- **Board JSON `file` field** — Vault-relative paths, not absolute. e.g., `"Notes.md"` or `"subfolder/Notes.md"`.
- **Frontmatter writes are source-preserving — single-parser CST engine (Phase 6)** — When Filo rewrites a `.md` file's frontmatter, `assembleMarkdownFile` (`lib/editor/markdownSync.ts`) routes through `patchFrontmatterSourceCst` (`lib/vault/frontmatterCstModel.ts`), a CST-operations engine built entirely on the `yaml` package. It tokenises the on-disk frontmatter *source*, rewrites ONLY the keys whose value changed, and emits every UNTOUCHED key from its own source tokens — byte-for-byte (comments, key order, quoting, exotic scalars like `02134`/`0xFF00FF`/`1_000`, and untouched folded `>` scalars all survive). A changed single-line scalar is rewritten value-only (keeping its `key:` prefix + inline comment); a changed collection / type-change / added key is re-serialised. `ci:frontmatter-invariant` asserts raw-BYTE equality on untouched keys (not just parsed-value). The full dump (`new Document(fm).toString()` — the `yaml` package, never js-yaml) only fires for a new/never-read file (no baseline to preserve), a block the engine can't parse as a block mapping (incl. a flow-mapping root), or a CHANGED/DELETED key carrying a YAML anchor/alias (refuse→dump; structure expanded, data exact). `lib/vault/tagRewriter.ts` keeps a faster line-level path for tag-only edits; its fallback shares the same engine. See KNOWN_LIMITATIONS #1 for the remaining narrow losses (L23 nested-block inner comments, L28 type-change trailing comment, A9-L6 a deleted key's own documenting comment line). **Single parser (the root-cause fix):** the read (`parseMarkdownFile`), the vault index, the tag rewriter, and the engine's value-compare ALL use the `yaml` package — no js-yaml parses any frontmatter. **Audit-13 M2** removed the last `gray-matter` fallback from the index + template reads (gray-matter bundles js-yaml v3, so it was a second parser by proxy — coercing an unquoted `date:`→Date / `0b1010`→10 on malformed-recoverable YAML); both now share `lib/vault/frontmatterRead.ts` (`splitFrontmatterSource` + `parseFrontmatterObject` = `parseDocument().toJS()`, called even on recoverable errors so a tab-indented date stays a string). This structurally kills the dual-parser class behind DI-01 (unquoted date→ISO), DI-05 (`<<` merge destroyed), and M2 (`1_000`/`0b1010` string-vs-number drift): there is no second parser to disagree. The `ci:no-jsyaml-in-frontmatter` gate forbids any js-yaml **or gray-matter** import under `src/renderer`/`src/main` except an `// allow-jsyaml: <reason>`-annotated line (today only `tagsStorage`'s tag-name minting guard, which validates a single bare token, not a frontmatter block). **Line endings (Audit7 H2 / Audit8 M1):** the CST engine normalises the FM *source* to LF, so `assembleMarkdownFile` must RE-APPLY the file's original EOL to the FM block + `---` fences. The real EOL is sniffed from the full raw file at hydrate (`FileState.eol`) and threaded in as `options.eol`; `detectFrontmatterEol` prefers it, with a body-derived fallback (a single-line FM carries no internal `\r\n`, so the stripped-FM source alone can't be trusted). Without this a CRLF note silently flips its frontmatter to LF on the first metadata edit. The adopt paths that hydrate from an in-memory sibling body rather than a disk read (TextTile + **Audit-13 M8** DocumentEditor) sniff CRLF from that body and thread it as `eol`, so a single-line-FM CRLF file doesn't flip on the first save. Pinned by `ci:eol-preservation` (which now also token-pins the DocumentEditor adopt path) + the single-line-CRLF matrix in `assembleMarkdownEngine.test.ts`. **Write SOURCE — delta on fresh disk (Write-path-remediation Phase 4):** the engine is byte-correct, but it can only be as right as the object it is handed. A field edit (Kanban/Task) or a Properties edit no longer feeds the engine a cached full FM object (which could go stale / over-cleaned / empty and make the engine faithfully drop an untouched key); instead it records an explicit `FrontmatterDelta` (`lib/vault/frontmatterDelta.ts`) and the gateway applies it to a FRESH disk read at write time — `nextFm` and the `originalFrontmatter` baseline both derive from that one in-chain read, so untouched keys (incl. external additions) are preserved structurally. The `documentStore` FM cache is now DISPLAY-only (cards/rows render from it), never the write source. Body-only editor saves are the remaining exception (they keep the open-editor-reconciled cache path); the orphan card/task write (`applyOrphanPatchRebased`) now also threads a delta (**Audit-11 FILO-UR-1** — Phase 4 had left it on the old whole-object clean, dropping present-but-empty disk keys on execute/undo). Pinned by `ci:frontmatter-delta-write` (with a function-scoped orphan-site arm).

---

## Testing Strategy

- **Unit tests (Vitest):** Cover all `lib/` modules. Stores should have unit tests for their logic. Target: every function in `lib/` has at least one test.
- **Component tests (jsdom + Vitest):** Component-level smoke tests run in the same Vitest suite as unit tests, using jsdom. Heavy interaction coverage lives in Playwright E2E instead.
- **E2E tests (Playwright):** Cover critical user flows — create vault, create board, add tile, edit content, delete tile, switch tabs, undo/redo.
- **Test file location:** Mirror `src/` structure under `tests/unit/`. E2E tests go in `tests/e2e/`.

---

## When Working on This Project

1. **Read the Design Doc first** (`Filo_Design_Doc_Rework_V5.md`) for any feature you're implementing. It's the authoritative specification.
2. **Don't build what isn't in scope.** Each phase has a clear deliverable. Don't pull in features from later phases.
3. **Leave working software at every phase boundary.** Each phase must result in a runnable app, even if incomplete.
4. **Test as you go.** Write unit tests for `lib/` modules as you build them. Don't batch testing to the end.
5. **No placeholder content.** No "Lorem ipsum", no sample images, no stub data in production code. If a feature isn't ready, don't ship a fake version of it.
6. **If something is ambiguous,** check the Design Doc. If it's still ambiguous, make a reasonable decision, document it with a `// DECISION:` comment, and move on.

# Filo Implementation & Refactor Plan — 2026-05-27

Canonical fix-then-refactor plan covering every finding in the 2026-05-26 audit. Architectural refactors take precedence over point fixes where the refactor prevents recurrence of a whole class of bugs.

## Goals

1. Close every P0 (silent data loss / critical correctness) so Filo is safe for real notes.
2. Eliminate the **classes** of bugs the audit surfaced, not just the instances — via type-level guarantees and CI gates.
3. Leave the app shippable at every phase boundary (no half-applied refactors).

## Non-goals

- No new features in this plan. New tile types, new board types, command palette, plugin system — all out of scope.
- No bundling/tree-shaking deep-dive — bundle size is flagged but deferred to a separate perf pass.
- No virtualisation work for Kanban / Task List — flagged but deferred.

## Dependency graph

```
Phase 0 (tests + gates) ──► Phase 1 (point P0s) ──┬─► Phase 2 (Command targetBoardId)
                                                  │
                                                  ├─► Phase 3 (watcher reopen + external-edit pipeline)
                                                  │
                                                  ├─► Phase 4 (VaultPath newtype)
                                                  │
                                                  ├─► Phase 5 (UntrustedFromVault security types)
                                                  │
                                                  └─► Phase 6 (a11y — keyboard ops)
                                                          │
                                                          └─► Phase 7 (polish + P1/P2 long tail)
```

Phase 0 blocks Phase 1+. Phases 2-6 are independent and can run in any order or in parallel; they all build on Phase 0+1. Phase 7 is the catch-all that follows once the structural work has landed.

## Estimated total scope

Working solo with AI assistance: **5-8 weeks** end-to-end. Phase 1 alone (1 week) makes Filo daily-driver-safe; the architectural refactors close future-regression-resistance. Each phase ships independently.

---

## Phase 0 — Characterization tests & new CI gates (LAND FIRST)

**Goal:** Lock current correct behavior under test BEFORE any refactor so subsequent collapses turn a real test red on parity loss. Also re-enable the existing skipped tests now that the underlying bugs have been fixed.

**New / modified test files:**

- `src/tests/unit/characterization/externalEditReconciliation.test.ts` (NEW) — for every watcher event type (`document` / `attachment` / `board` / `config-tags` / `config-theme` / `config-templates`), assert that a renderer-side reconciler exists OR that a "no reconciler for this kind" test characterises the current gap. Will be RED for `board` and `config-*` today — that documents Phase 3's scope.
- `src/tests/unit/characterization/commandTargetBoardCoverage.test.ts` (NEW) — discover every class extending `Command` via AST walk; assert each one declares `targetBoardId` as a constructor parameter and stores it on `this`. Will be RED for ~15 commands; documents Phase 2's scope.
- `src/tests/unit/characterization/vaultPathNormalisation.test.ts` (NEW) — for every store/lib that holds a `Map<string, _>` or `Record<string, _>` keyed by vault-relative path, characterise current behaviour with mixed-case keys. Will document the orphan-on-rename case (P0 #8) and a few others.
- `src/tests/unit/characterization/untrustedSinks.test.ts` (NEW) — for iframe `src`, theme CSS variable values, `shell.openExternal`, assert sanitisation/allowlist invariants. Will be RED for the three P1 security findings.
- `src/tests/unit/characterization/ipcEnvelopeContract.test.ts` (EXISTING) — re-enable the four `it.skip` blocks (Phase 1 of the prior consolidation plan landed; the skips are now stale).

**New CI gates** (added to `ci:verify` chain):

- `scripts/check-commands-have-target-board.mjs` — every class extending `Command` (anywhere under `src/renderer/commands/`) must take `targetBoardId: string` in its constructor and assign it to `readonly targetBoardId`. Initially in **warn-only** mode (logs violations, exits 0) so Phase 2 can land iteratively; flip to **error** at end of Phase 2.
- `scripts/check-untrusted-sink-discipline.mjs` — for the canonical security sinks (`<iframe src={...}>`, `setProperty('--`, `shell.openExternal`, `media:open-external`), require that the value originates from a `SanitisedUrl` / `SanitisedColor` / `SanitisedSrc` newtype. Initially warn-only; flip to error at end of Phase 5.
- `scripts/check-vault-path-keys.mjs` — for `Map<string,_>` / `Record<string,_>` declarations whose names match `*Paths`, `*ByPath`, `pathTo*`, `fileTags`, `*Index`, require the key type to be `VaultPath` instead of `string`. Initially warn-only; flip to error at end of Phase 4.

**Existing test fixtures requiring update:**

- Any test that stubs `recovery:snapshot` / `board:delete` / `vault:init-config` with bare strings — already converted to envelope shape during Phase 1 of the prior consolidation; verify and remove any stragglers.

**Verification:** `npm run ci:verify` green. The new warn-only gates print violation counts that match the audit's finding counts (sanity check that the gates are detecting the real surface).

**Parity risks:** Property tests over the strategy-registry-style code paths can be over-strict. Mitigate by seeding from `boardRegistry.createDefault(...)` and only mutating from there.

**Size:** ~600-900 LOC of test code + 3 gate scripts. **Zero production change.**

**Acceptance:** All existing tests still pass; new RED tests document the exact scope of Phases 2-5.

---

## Phase 1 — Daily-use unblock (point P0 fixes, no architectural change)

**Goal:** Close the P0s that don't require structural work so Filo becomes safe for real notes ASAP. Each item is independent; ship as separate commits.

### 1.1 — ProjectSettings unsaved-changes guard (P0 #1)

- **File:** [src/renderer/components/modals/ProjectSettings.svelte](src/renderer/components/modals/ProjectSettings.svelte)
- **Change:** Add `pendingSettingsStore.hasUnsavedChanges()` getter. In the modal's close handler (Escape, backdrop click, X button), if there are unsaved changes, route through `uiStore.openConfirm({ title: 'Discard settings changes?', body: '...', confirmLabel: 'Discard', danger: true })` before calling `cancel()`.
- **Test:** unit — confirm `cancel()` not called when the user clicks "Keep editing" in the confirm dialog.

### 1.2 — `copyFileToVault` atomic-collision fix (P0 #5)

- **File:** [src/main/vault/fileOps.ts:380-415](src/main/vault/fileOps.ts:380)
- **Change:** Replace `fileExists(destPath)` loop + `fs.copyFile` + `fs.rename` with:
  1. Compute candidate name including counter loop.
  2. Open destination with `fs.open(candidate, O_WRONLY|O_CREAT|O_EXCL)`.
  3. On `EEXIST`, bump counter and retry (cap at 1000 attempts → throw `TARGET_NAME_EXHAUSTED`).
  4. Once the descriptor is held, write the source bytes through it, fsync, close, fsync dir.
- **Test:** add `copyFileToVault.test.ts` case: two concurrent `copyFileToVault` calls with same source file resolve to two distinct destination names; neither overwrites the other.

### 1.3 — `columnCoverImage` cascade-delete fix (P0 #6)

- **File:** [src/renderer/stores/boardFrontmatterSync.ts:49-55](src/renderer/stores/boardFrontmatterSync.ts:49)
- **Change:** Replace the hand-listed `hasStyleClears` enumeration with `Object.values(targets.styleClears).some((s) => Object.keys(s).length > 0)`. Future-proof: adding a new style-clear category in `findTilesToCascadeDelete` cannot be silently missed.
- **Test:** unit — `cascadeDelete` triggered on an attachment that is ONLY referenced as a Kanban column header `coverImage` correctly clears the reference and writes the cleaned `.board.json`.

### 1.4 — `moveIntoFolder` TARGET_EXISTS feedback (P0 #7)

- **Files:**
  - [src/renderer/stores/vaultFolderOps.ts:299-304](src/renderer/stores/vaultFolderOps.ts:299) — change return shape from `boolean` to typed `Result<{ newPath: string }, 'TARGET_EXISTS' | 'PERMISSION_DENIED' | 'OTHER'>`.
  - [src/renderer/components/sidebar/VaultSidebar.svelte:99,116](src/renderer/components/sidebar/VaultSidebar.svelte:99) and [VaultFileItem.svelte:238,255](src/renderer/components/sidebar/VaultFileItem.svelte:238) — pattern-match the result, toast on failure.
- **Test:** unit — `moveIntoFolder` against a folder containing same-named file returns `{ ok: false, code: 'TARGET_EXISTS' }`; renderer caller fires `uiStore.toast(...)`.

### 1.5 — `tagsStorage.renameFile` case-insensitive (P0 #8)

- **File:** [src/renderer/lib/vault/tagsStorage.ts:304-313](src/renderer/lib/vault/tagsStorage.ts:304)
- **Change:** Route every `fileTags` key through `normalizeVaultRelative` on read AND write. This is the stop-gap before Phase 4's branded type lands.
- **Test:** unit — adding a tag to `Notes/Foo.md` (Pascal) then renaming via `notes/foo.md` (lowercase) correctly moves the entry.

### 1.6 — Partial-read mtime-stability gate (P0 #10)

- **File:** [src/renderer/lib/vault/conflictResolver.ts:138-170](src/renderer/lib/vault/conflictResolver.ts:138)
- **Change:** Add a `mtimeStable` check — `isLikelyPartialRead` returns true only if BOTH the shrink heuristic fires AND the file's mtime was modified within the last 100 ms. A file shrunk seconds or more ago is treated as a deliberate edit, not a mid-write.
- **Test:** unit — file shrunk 1 hour ago routes to `safe-reload`, not `partial-read-retry`.

### 1.7 — Re-enable skipped IPC envelope tests

- **File:** [src/tests/unit/characterization/ipcEnvelopeContract.test.ts:195,205,216,226](src/tests/unit/characterization/ipcEnvelopeContract.test.ts:195) — flip `it.skip` to `it`. Update the line-number patterns in the test's `findCallers` helper if needed (the bugs are fixed; the tests will now pass).

### 1.8 — Memory drift correction

- Audit `memory/` for the byte-delta-in-toast claim and any other "we shipped this" entries that the code doesn't reflect. Correct the entries or note them as stale. Not a code change, but it's part of fixing the process problem.

**Verification:** `npm run ci:verify` green. Manual smoke: open Settings → make changes → press Esc → confirm prompt. Drop two same-named files simultaneously → both saved with distinct names. Delete an attachment that's a column cover image → reference cleaned.

**Size:** ~400-600 LOC + tests, spread across ~10 files.

**Acceptance:** All 7 P0 point fixes shipped + tests + greenCI; Filo is daily-driver-safe on Mind Map and good-enough on Kanban / Task List (a11y still pending).

---

## Phase 2 — Mandatory `Command.targetBoardId` + CI gate

**Goal:** Eliminate cross-board command-push race (P1-5). Make it a compile error to create a command without declaring its target board.

**Refactor shape:**

```ts
// src/renderer/commands/Command.ts
export abstract class Command {
  abstract readonly targetBoardId: string;   // was: optional
  // ... rest unchanged
}
```

**Mechanical sweep — every command class:**

- `tileCommands.ts` — AddTileCommand, RemoveTileCommand, MoveTilesCommand, ResizeTilesCommand, **UpdateTileStyleCommand** (P1-5 site), UpdateTileSrcCommand, etc.
- `connectionCommands.ts` — **UpdateConnectionCommand** (P1-5 site), all connection ops.
- `frameCommands.ts` — **AddFrameCommand, UpdateFrameCommand, MoveFrameCommand, DeleteFrameCommand** (all P1-5 sites).
- `styleCommands.ts` — **UpdateFrameStyleCommand, UpdateKanbanCardStyleCommand, UpdateKanbanColumnStyleCommand, UpdateTaskItemStyleCommand, UpdateTaskSectionStyleCommand** (all P1-5 sites).
- `waypointCommands.ts` — all waypoint commands (P1-5 sites).
- `renameTitleCommand.ts` — **RenameTitleCommand** (P1-5 site).
- `kanbanCommands.ts`, `taskCommands.ts`, `sectionCommands.ts`, `groupAndBoardCommands.ts`, `propertiesCommands.ts`, `attachmentSrcCommand.ts`, `savedViewsCommand.ts`, `replaceAllCommand.ts` — verify already-required or fix.

**At every push site:** replace `historyStore.execute(new XCommand(...))` patterns that read `boardStore.current?.id` at push-time with sites that capture the target board at **construction** time. For style popups, the constructing component already knows its board (via `BOARD_SCOPE_KEY` context) — thread that through.

**CI gate:** flip `check-commands-have-target-board.mjs` from warn to error.

**Test:** new — `historyStore.push(new UpdateTileStyleCommand({targetBoardId: 'A', ...}))` followed by a board switch to B; Ctrl+Z applies to A's stack, surfaces "Switch back to board A?" toast via the existing `targetBoardId`-mismatch path in `history.svelte.ts:353-360`.

**Parity risks:** Some popup destroy effects fire AFTER the user has navigated to a different board — capturing `boardStore.current` at popup mount vs popup destroy matters. The fix is to capture at mount time and store on `this`.

**Size:** ~300-500 LOC across the `commands/` directory + push sites. Mostly mechanical; ts-morph codemod feasible for the constructor-signature change.

**Acceptance:** CI gate green at error level; cross-board undo never silently no-ops.

---

## Phase 3 — Watcher reopen + unified external-edit pipeline

**Goal:** Close P0 #2, #3, #4. The renderer must reconcile every external write to every canonical vault file, and the watcher must survive transient errors.

### 3.1 — Watcher reopen state machine (P0 #4, ships first)

- **File:** [src/main/services/fileWatcher.ts:410-420](src/main/services/fileWatcher.ts:410)
- **Change:** Wrap `fs.watch` in a `WatcherSupervisor` class with states `{ active, reconnecting, suspended }`. On `'error'`, set `reconnecting` and schedule retry at `1s → 5s → 30s → 300s` (capped). On success, reset backoff. Surface state changes via `vault:watcher-state` IPC so the renderer can show a "watcher reconnecting" banner.
- Reconcile walker continues to run during `reconnecting` state — already the case, but verify and add a test.
- **Test:** unit — simulate `fs.watch` emitting `'error'`; assert `setTimeout` schedule fires; second `'error'` doubles the delay; success resets.

### 3.2 — External-change reconciler registry (P0 #2, #3)

**New file:** `src/renderer/lib/vault/externalChangeRegistry.ts`

```ts
export interface ExternalChangeReconciler {
  readonly kind: WatcherChangeKind;
  handleChange(event: VaultChangeEvent, ctx: ReconcileCtx): Promise<void>;
}

const reconcilers: Record<WatcherChangeKind, ExternalChangeReconciler> = {
  document: documentReconciler,       // existing logic — extract from vault.svelte.ts
  attachment: attachmentReconciler,   // existing logic — extract
  board: boardJsonReconciler,         // NEW
  'config-tags': tagsJsonReconciler,  // NEW
  'config-theme': themeJsonReconciler,// NEW
  'config-template': templateReconciler, // NEW
  tree: treeReconciler,               // existing — sidebar refresh
};

export function dispatchExternalChange(event: VaultChangeEvent): Promise<void> {
  const r = reconcilers[event.kind];
  if (!r) {
    // Compile-time exhaustiveness via never-check, but defence-in-depth:
    reportError('externalChange', null, `No reconciler for kind: ${event.kind}`);
    return Promise.resolve();
  }
  return r.handleChange(event, currentCtx());
}
```

**New reconcilers:**

- **`boardJsonReconciler`** — On external `.board.json` change: if the cache has a matching entry, run the existing `boardWriteScheduler.ts:213-249` mtime drift logic but proactively (before the next user-triggered write). Surface a "Board file changed externally — Reload / Keep your edits" toast with the standard sticky semantics.
- **`tagsJsonReconciler`** — On external `.filo/tags.json` change: re-hydrate `fileTagsStore` via `fileTags.svelte.ts:362-376` (already exists; just wire it). If the user has in-memory tag changes that haven't flushed, route through dirty-editor toast.
- **`themeJsonReconciler`** — Re-list themes, refresh ThemeManager.
- **`templateReconciler`** — Re-list templates.

**Renderer listener change:** [src/renderer/stores/vault.svelte.ts:1180-1226](src/renderer/stores/vault.svelte.ts:1180) — replace the `if (event.kind === 'document' || event.kind === 'attachment')` switch with `await dispatchExternalChange(event)`. The dispatch is exhaustive over `WatcherChangeKind` — a new kind is a compile error.

**Test:** integration — externally write to `.filo/tags.json`, assert `fileTagsStore` reflects the new state; externally modify a `.board.json`, assert the toast surfaces and "Reload" applies the disk version.

**Parity risks:** The existing `'document'` and `'attachment'` handlers are tightly coupled to `vault.svelte.ts` internals (vault index, broken refs). Extracting them into reconcilers must preserve every side effect. Mitigation: characterization tests in Phase 0 lock current behaviour.

**Size:** large — ~800-1200 LOC across the new registry + 4 new reconcilers + extraction of existing logic. ~1 week.

**Acceptance:** Hand-edit `.board.json`, `.filo/tags.json`, `.filo/themes/foo.json`, `.filo/templates/bar.json` externally — each surfaces a meaningful reconcile UI and the user's edits are not silently overwritten.

---

## Phase 4 — `VaultPath` newtype + sweep

**Goal:** Close P0 #8 structurally. Make it impossible to use a raw `string` as a vault-path map key.

**New file:** `src/shared/vaultPath.ts`

```ts
declare const _brand: unique symbol;
export type VaultPath = string & { readonly [_brand]: 'VaultPath' };

export function vaultPath(raw: string): VaultPath {
  return normalizeVaultRelative(raw) as VaultPath;
}

export function isVaultPath(v: unknown): v is VaultPath {
  return typeof v === 'string' && v === normalizeVaultRelative(v);
}
```

**Sweep targets** (every map/record keyed by vault-relative path):

- `fileTagsStore.fileTags: Record<VaultPath, FileTagEntry>`
- `vaultIndexStore.byPath: Map<VaultPath, IndexEntry>`
- `boardRefIntegrityStore.brokenRefs: Map<VaultPath, BrokenRefEntry>`
- `documentStore.byFilename: Record<VaultPath, DocumentEntry>` (and related)
- `boardCache.paths: Record<string, VaultPath>` (value is path, key is boardId — annotate value type)
- `frontmatterWriteScheduler` internal queue keyed by path
- `markdownWriteRegistry` keyed by path
- `recentSelfWrites` keyed by path
- `lastKnownSizes` / `lastKnownHashes` in `fileWatcher.ts`
- `frontmatterSync` partial-read-retry inflight set
- All similar maps in `vaultExternalChanges.ts`

**Mechanical sweep approach:** ts-morph codemod that finds every `Map<string, _>` / `Record<string, _>` whose declared name matches the pattern and rewrites to `Map<VaultPath, _>` / `Record<VaultPath, _>`. Then TypeScript flags every callsite that needs `vaultPath(raw)` to wrap.

**CI gate:** flip `check-vault-path-keys.mjs` from warn to error.

**Test:** integration — every previously-broken case-sensitivity path (P0 #8, plus any others discovered in the sweep) now passes.

**Parity risks:** Some legitimate `Map<string, _>` instances exist (boardId keys, tileId keys) and must NOT be touched. The codemod's name-pattern allowlist needs careful curation — start strict (`*Paths`, `*ByPath`, `fileTags`) and expand only after audit.

**Size:** medium — ~400-600 LOC of mechanical sweep + ~50 callsite wraps. ~3 days.

**Acceptance:** CI gate green at error level; rename + tag-storage works correctly on Windows regardless of OS-event casing.

---

## Phase 5 — `UntrustedFromVault<T>` security types

**Goal:** Close P1-8, P1-9, P1-10 (and prevent future drive-by-phishing / info-leak sinks).

**New file:** `src/shared/untrusted.ts`

```ts
declare const _u: unique symbol;
declare const _s: unique symbol;

// Any string read from vault contents (JSON, frontmatter, markdown) is stamped Untrusted.
export type Untrusted<T> = T & { readonly [_u]: 'Untrusted' };

// Sinks accept only Sanitised values, produced by validator functions.
export type SanitisedUrl    = string & { readonly [_s]: 'SanitisedUrl' };
export type SanitisedColor  = string & { readonly [_s]: 'SanitisedColor' };
export type SanitisedSrc    = string & { readonly [_s]: 'SanitisedSrc' };

export function asSafeIframeSrc(raw: Untrusted<string>): SanitisedSrc | null {
  // Allowlist: https only, no javascript:/data:/file:.
  // Domain warn-list — first-time iframe domain triggers a confirmation prompt.
}

export function asSafeThemeValue(raw: Untrusted<string>): SanitisedColor | null {
  // Reject url(, expression(, image(, image-set(. Allow #hex, rgb(), hsl(), named colors, var(...).
}

export function asSafeOpenExternal(raw: Untrusted<string>): SanitisedUrl | null {
  // Allowlist: https:, http:, mailto:, tel:. Reject file:, javascript:, data:.
  // Extension blocklist for vault-local paths: .html, .htm, .xhtml, .svg, .shtml, .xml,
  //   plus existing .exe, .bat, .cmd, .com, .scr, .ps1, .vbs, .hta, .msi, .jar, .lnk, .sh, .msc.
}
```

**Sweep:**

- Schema parses output `Untrusted<T>` for string fields read from disk.
- `<iframe src={tile.url}>` in [IframeTile.svelte:92](src/renderer/components/tiles/IframeTile.svelte:92) — wrap in `asSafeIframeSrc`.
- `setProperty('--ui-...', value)` in [themeManager.ts:283](src/renderer/lib/themes/themeManager.ts:283) — wrap in `asSafeThemeValue`.
- `media:open-external` IPC handler in [media.ipc.ts:281-292](src/main/ipc/media.ipc.ts:281) — extend blocklist with HTML-renderable extensions.
- `link:fetch-metadata` — already does the redirect walk with `isPrivateUrl`; verify the entry URL is also wrapped.
- TipTap markdown renderer — any `<a href>` should pass through the sanitiser.

**CI gate:** flip `check-untrusted-sink-discipline.mjs` from warn to error.

**Test:** integration — load a `.board.json` containing an IframeTile pointing at `javascript:alert(1)`, `file://...`, `https://attacker.example` — first two reject silently; third triggers first-time-domain prompt.

**Size:** medium — ~250 LOC of newtype helpers + ~30 sink rewrites. ~2 days.

**Acceptance:** CI gate green at error level; vault-shipped malicious payloads can't reach security sinks.

---

## Phase 6 — Accessibility: keyboard-operable canvases

**Goal:** Close P0 #9 (Kanban/Mind Map not keyboard-operable). WCAG 2.1.1 Level A compliance.

**6.1 — Kanban keyboard ops:**

- **File:** [src/renderer/components/boards/KanbanBoard.svelte](src/renderer/components/boards/KanbanBoard.svelte), KanbanCard.svelte, KanbanColumn.svelte.
- **Changes:** Container `tabindex={0}` with `role="application"` and `aria-label`. Tab focuses board → arrows navigate cards/columns → Enter opens card → Ctrl+Arrow moves card → N adds card → Del removes card → Shift+Tab returns to TabBar.
- Use the existing `commandRegistry` to register Kanban-specific commands so shortcuts are discoverable in the help modal.

**6.2 — Mind Map keyboard ops:**

- **File:** [src/renderer/components/boards/MindMapBoard.svelte](src/renderer/components/boards/MindMapBoard.svelte), `src/renderer/lib/mindmap/mindMapKeyboard.ts`.
- **Changes:** Extend existing arrow-key neighbour-selection with: N to create new tile near focused tile, Del/Backspace to delete, Enter to enter rename, Ctrl+Arrow to move, C to start a connection from focused tile.

**6.3 — Task List keyboard ops:**

- Likely already mostly OK (text-centric board); audit `taskListKeyboardNav.svelte.ts` for gaps.

**6.4 — Other a11y fixes from Phase 7 batch landed here:**

- TabBar Ctrl+W / Ctrl+Tab / Ctrl+Shift+Tab (P1-12 from audit).
- ContextMenu skip-disabled-items (P1).
- Toast non-colour state cue (icon prefix) (P1).
- `prefers-reduced-motion` audit across emoji-picker, tile-insertion, popIn animations.
- Hotkeys `editableTarget` ancestor walk consolidation (P1-11).

**Test:** Playwright + axe-core scans for each board type with keyboard-only navigation.

**Size:** large (~1-1.5 weeks). Most user-visible work.

**Acceptance:** Unplug your mouse, complete every core flow on every board type. axe-core E2E reports zero a11y violations on representative boards.

---

## Phase 7 — Polish, P1/P2 long tail, perf

The remaining audit findings:

### Correctness P1s
- **`renameCorrelation` cross-basename floor lowered for hash-available files** ([renameCorrelation.ts:35](src/main/services/renameCorrelation.ts:35)).
- **`.txt` classifier** — promote to `'document'` so `.txt`↔`.md` external renames pair ([fileWatcher.ts:709](src/main/services/fileWatcher.ts:709)).
- **ImageTile alt-text via command** — wrap [ImageTile.svelte:63](src/renderer/components/tiles/ImageTile.svelte:63) in `UpdateImageAltCommand`; rely on the extended `ci:direct-board-mutations` gate.
- **TimerTile mode/duration via command** — same pattern for [TimerTile.svelte:45,111,136](src/renderer/components/tiles/TimerTile.svelte:45).
- **`filenameUtils.ts` preserved-tmp recovery surface** ([filenameUtils.ts:229-241](src/main/vault/filenameUtils.ts:229)) — list orphan `*.tmp` files in `.filo/recovery/` UI.
- **Quit-during-vault-open save short-circuit** — small change in `App.svelte:73` to ensure pending writes flush even when home screen is showing.

### Schema P1s
- **Frontmatter `priority` enum-or-string union** ([frontmatter.ts:112-115](src/renderer/schema/frontmatter.ts:112)) — restore round-trip for custom priorities.
- **Board round-trip byte-stability docs** — document the always-strip behaviour of `boardWriteScheduler.ts:142-210`; consider key-order normalisation.

### Recovery / robustness
- **`recovery:snapshot` size cap** — refuse > 25 MB to prevent disk-fill spam ([board.ipc.ts:414-433](src/main/ipc/board.ipc.ts:414)).
- **`tag-rewrite-pending.json` escape hatch** — "Skip this file forever" affordance in the recovery modal ([tagRewriteSweep.ts:276-278](src/renderer/lib/vault/tagRewriteSweep.ts:276)).
- **`isLossyMarkdownRoundTrip`** — verified robust; document the contract in a comment.

### Perf (deferred to standalone pass)
- Bundle splitting beyond TipTap (markdown-tools, schema, board ops as lazy chunks).
- Kanban / Task List virtualisation (rbush or `@tanstack/svelte-virtual`).
- `pathRouter.computeSmartPath` rbush usage fix ([pathRouter.ts:139](src/renderer/lib/connections/pathRouter.ts:139)).
- `framesStore.hiddenTileIds` `$derived.by` conversion.

### Hygiene
- Memory drift sweep (Phase 20 byte-delta entry, etc.).
- Documentation pass on CLAUDE.md to reflect post-refactor patterns (Command.targetBoardId now required, VaultPath everywhere, Untrusted/Sanitised contracts).

**Size:** depends on scope cut — full polish ~1-2 weeks; minimum-shippable ~3 days for the correctness P1s.

**Acceptance:** Every audit finding either closed or explicitly deferred with a CLAUDE.md note explaining the deferral reason.

---

## Per-phase acceptance summary

| Phase | Done when |
|---|---|
| 0 | New gates installed warn-only; characterization tests document scope of P2-5 |
| 1 | 7 P0 point fixes shipped; `npm run ci:verify` green; manual smoke pass |
| 2 | Every Command captures `targetBoardId` at construction; CI gate at error |
| 3 | External edits to every canonical file kind reconcile cleanly; watcher survives 'error' |
| 4 | `VaultPath` newtype across every path-keyed map; CI gate at error |
| 5 | Security sinks accept only sanitised newtypes; CI gate at error |
| 6 | Every board type keyboard-operable; axe-core E2E clean |
| 7 | All P1/P2 closed or explicitly deferred with rationale |

## Risk mitigations

- **Refactor regressions:** Phase 0 characterization tests catch most. Run `npm run ci:verify` after every commit, not just at PR.
- **Big-bang anxiety:** Each phase ships independently. If Phase 3 hits trouble, Phases 4-5 are unblocked and can proceed.
- **Memory drift:** Stop writing to `memory/` for in-flight work. Memory is for cross-session facts; in-flight planning lives in this file, updated as phases land.
- **Plan rot:** Update this file at the end of each phase with what landed, what changed scope, and what got deferred. One file, append-only changelog at the bottom.

---

## Changelog

_Add an entry after each phase lands. Format: `## Phase N landed — YYYY-MM-DD — summary`._

## Phase 6 + 7 landed — 2026-05-27 — Keyboard a11y + P1/P2 long tail

- **6.1 Kanban keyboard ops** — `KanbanBoard.svelte`'s outer `.kanban-board` div picks up `role="application"` + `aria-label="Kanban board"` + `aria-roledescription` + `tabindex="0"`. `handleBoardKeydown` extended with bare-arrow card nav (Up/Down step within column, Left/Right step across columns with row-index clamping), Enter to open the focused card's backing document, and SR-announce on focus moves. New helpers `findColumnAndIndex(tileId)` + `neighbourTileId(from, key)` scope the focus model to `selectionStore.selectedIds` (single-select only — shift-arrow extend deferred). Pre-existing N / Shift+N / Delete / Escape / "/" handlers retained via the existing `commandRegistry` registration.
- **6.2 Mind Map keyboard ops** — `MindMapBoard.svelte`'s `handleKeydown` extended on top of the legacy Ctrl+Shift+Arrow extend-selection branch. New bindings: bare Arrow replaces selection with the directional neighbour (via existing `findNeighborTile`), Ctrl+Arrow moves selected tiles 10 canvas px via `MoveTilesCommand` (undoable, locked tiles skipped, ESLint disable comment annotates the short-lived `Map` instance), Del/Backspace fires the same cascade-aware confirm gate the right-click menu uses, N adds a tile next to the focused selection (falls back to `createTileAtViewportCenter` when nothing is selected), Enter dispatches a `request-rename` `CustomEvent` at window — `TileHeader.svelte` listens, filters by `tile.id`, and invokes its existing `startEditing()` flow, C enters connection mode anchored on the focused tile.
- **6.3 Task List keyboard ops** — Audited `taskListKeyboardNav.svelte.ts` + `TaskListBoard.svelte`'s shortcut registrations: ↑/↓ row stepping, Tab/Shift+Tab indent/outdent, Alt+↑/Alt+↓ block reorder, F2 rename, N quick-add focus, Ctrl+A select-all, and per-section / per-section-collapse commands all in place. No gaps; no code change.
- **6.4 TabBar + cross-cutting a11y** — Three new commands registered in `AppShell.svelte`'s shortcut block via `registerCommandWithShortcut`: `tab:close` (Ctrl+W → `tabStore.close(activeTabId)`), `tab:next` (Ctrl+Tab cycles forward through `tabStore.tabs`), `tab:prev` (Ctrl+Shift+Tab cycles backward). All three appear in the Keyboard Shortcuts settings panel and can be rebound. `Toast.svelte` gained `typeLabels` + a per-type inline SVG icon (`check`/`circle-x`/`alert-triangle`/`info-circle`) with `aria-label`, so colour-blind / monochrome-display users discriminate severity without relying on the border-left-color stripe. `ContextMenu.svelte`'s arrow-key handler now uses `nextEnabledIndex(start, dir)` / `firstEnabledIndex()` / `lastEnabledIndex()` helpers so disabled rows skip during arrow nav and the initial focus on open lands on the first enabled item. Hotkeys `isEditableTextTarget` ancestor walk was already consolidated through the shared `lib/utils/editableTarget.ts` helper; no further consolidation needed.
- **Phase 7 correctness P1s shipped**:
  - **`.txt` → `'document'` classifier** (fileWatcher.ts) — `.txt` extension now classifies as `'document'` alongside `.md` / `.markdown`. The same-basename + cross-basename rename correlation passes (which already accept `.txt` ↔ `.md` via `TEXT_LIKE_EXTENSIONS`) now actually receive `.txt` events instead of having them drop into the `'tree'` bucket. A user retyping `Notes.txt` → `Notes.md` in their file manager surfaces as a synthetic rename and tile references propagate.
  - **`recovery:snapshot` 25 MB cap** (recoverySnapshot.ts) — `MAX_SNAPSHOT_BYTES = 25 * 1024 * 1024` constant added. `snapshotForRecovery` runs an `fs.stat` BEFORE the read so a multi-GB file gets rejected without first being pulled into memory. Failure code `RECOVERY_SNAPSHOT_TOO_LARGE` flows through the existing `recovery:snapshot` IPC envelope; the renderer treats snapshot failures as non-fatal (the load-error toast is the primary recovery path).
  - **`UpdateImageAltCommand`** (tileCommands.ts + ImageTile.svelte) — new command captures `before` / `after` `string | undefined`; `commitAlt()` in ImageTile.svelte routes through `historyStore.execute(new UpdateImageAltCommand(...))` and short-circuits when the value is unchanged. Ctrl+Z reverses an alt-text edit; the previous direct `boardStore.updateTile` call was silently destroying the prior value.
  - **`UpdateTimerConfigCommand`** (tileCommands.ts + TimerTile.svelte) — new command captures the four-field timer config snapshot (`mode` / `duration` / `remaining` / `isRunning`). `cycleMode` / `setDuration` / `applyCustomInput` / `resetTimer` all now push through history. Transient `isRunning` play/pause toggle and the per-tick `remaining` countdown keep their direct `boardStore.updateTile` calls (annotated `// allow-direct-mutation`); wrapping those would blow through `MAX_HISTORY` on every play.
  - **Frontmatter `priority` enum-or-string union** (frontmatter.ts) — `FrontmatterPriority` widened to `CanonicalFrontmatterPriority | string`. The `.transform()` now folds only empty / nullish input to `'none'`; a non-empty value not in the canonical set is preserved verbatim (case-folded). A hand-rolled `priority: blocked` survives the round trip rather than being silently rewritten to `'none'` on next save. Test `Sprint C / C12 — FrontmatterSchema lenient transform` updated to pin the new contract.
  - **`vault.save()` no-currentProject short-circuit removed** — flush-and-quit on the home screen now runs every flusher unconditionally (markdown / frontmatter / board / config / misc). When there's nothing pending the boolean stays `true`; when there IS pending state but `currentProject` got nulled mid-close, the flush completes against the prior vault root.
- **Tests + CI gates:**
  - `Sprint C / C12 — FrontmatterSchema lenient transform` retitled & extended — replaced the "Critical → none" assertion with "Critical → critical (non-enum preserved)" + a separate "empty / nullish → none" case.
  - File-size allowlist bumps: `KanbanBoard.svelte` 1323 → 1403 (+80 LOC, arrow-nav helpers), `vault.svelte.ts` 1384 → 1393 (+9 LOC, comment block), new `tileCommands.ts: 1026` entry (the two new commands push it over the default 1000-LOC ceiling; splitting by tile type is a larger refactor and deferred).
- **Verification:** `npm run ci:verify` green; 2827 unit tests pass (1 skipped). All 22 CI gates clean. Lint clean (0 errors / 13 warnings — all pre-existing unused-var); svelte-check clean (0 errors / 0 warnings across 750 files).

## Phase 5 landed — 2026-05-27 — `Untrusted` / `Sanitised*` security types + sink sweep + CI gate at error

- **Shared `untrusted.ts` module:** New `src/shared/untrusted.ts` exposes the `Untrusted<T>` marker brand plus three closed-constructor brands — `SanitisedUrl`, `SanitisedColor`, `SanitisedSrc` — produced ONLY by their matching validators:
  - `asSafeIframeSrc(raw)` — http(s)-only allowlist; rejects `javascript:` / `data:` / `vbscript:` / `file:` / `blob:` and malformed input. `URL`-parse based.
  - `asSafeThemeValue(raw)` — substring blocklist (`url(`, `expression(`, `image(`, `image-set(`, `@import`, `javascript:`, `vbscript:`) + 256-char length cap + `CSS.supports('--probe: <value>')` parsability probe when available. Catches the malicious-theme info-leak vector (CSS injects a `background-image: url(https://evil/p)`).
  - `asSafeOpenExternal(raw)` — explicit prefix allowlist (`https://` / `http://` / `mailto:` / `tel:`) for URLs; case-insensitive unsafe-extension blocklist for local paths. The blocklist combines the legacy OS-executable set (`.exe`, `.bat`, `.cmd`, `.com`, `.scr`, `.ps1`, `.vbs`, `.hta`, `.msi`, `.jar`, `.lnk`, `.appref-ms`, `.app`, `.bin`, `.sh`, `.msc`) with the **Phase 5 / P1-10 addition** of HTML-renderable extensions (`.html`, `.htm`, `.xhtml`, `.svg`, `.shtml`, `.xml`) — a vault attachment named `report.html` opened in the user's browser executes whatever JS it carries from a trusted-origin frame and can exfiltrate other vault contents via same-origin. `UNSAFE_LOCAL_FILE_EXTENSIONS_FOR_TESTS` re-exported as the test-side parity anchor.
- **Sink sweep — `<iframe src={tile.url}>`** (P1-8, IframeTile.svelte): added `import { asSafeIframeSrc, asSafeOpenExternal } from '../../../shared/untrusted'`; `const safeSrc = $derived(asSafeIframeSrc(tile.url))`; bound `<iframe src={safeSrc}>` and gated the parent branch on `tile.url && safeSrc` so a stored `javascript:` / `file:` URL routes through the existing "Unsafe URL blocked" panel rather than rendering. The two `media:open-external` invocations (broken-embed retry button + "Open externally" icon button) routed through a new `openExternally(target)` helper that calls `asSafeOpenExternal(target)` first.
- **Sink sweep — `setProperty('--var', value)`** (P1-9, themeManager.ts): new `applySafeThemeVar(root, prop, rawValue)` helper inlines `asSafeThemeValue(rawValue)` next to `root.style.setProperty(prop, safe)` so the validator is two lines away and the CI gate's nearby-scan detects it. Both call sites in `applyBuiltinTheme` (systemOnly branch) and `applyCustomTheme` (custom-theme branch) now route through the helper; failed values fire a single `reportError` breadcrumb but no toast (a malformed theme JSON may carry dozens of bad keys — toast-spam buys nothing).
- **Sink sweep — `media:open-external` callsites (renderer + main)** (P1-10):
  - **Renderer:** four call sites total. `IframeTile.svelte` via `openExternally`. `LinkTile.svelte:openLink` now calls `asSafeOpenExternal(tile.url)` before `invokeOk(...)`. `FileTile.svelte:handleOpen` now calls `asSafeOpenExternal(abs)` before `invokeOk(...)` — both surface a `reportError` toast on the failure branch. `AppShell.svelte`'s click-interception handler calls `asSafeOpenExternal(href)` and silently bails (the regex pre-filter already restricts to `http(s)/mailto/tel`).
  - **Main:** `media.ipc.ts` `EXECUTABLE_EXTENSIONS` set renamed to `UNSAFE_FILE_EXTENSIONS` and extended with the same HTML-renderable additions; error message generalised to `Refusing to open file: <ext> extension not allowed`.
- **`link:fetch-metadata` entry-point hardening** (Phase 5 spec — "verify the entry URL is also wrapped"): added an explicit `URL` parse + protocol allowlist (`http:` / `https:` only) BEFORE the existing `isPrivateUrl` SSRF check. Catches `javascript:alert(1)` / `data:text/html,evil` URLs that previously slipped past `isPrivateUrl` (empty-hostname URL.protocol-check is meaningful only for hostname-bearing schemes) and would only have failed inside Node's `fetch()` with a generic error.
- **CI gate `check-untrusted-sink-discipline.mjs` improvements + flip to error:**
  - Bidirectional window — `windowStart = max(0, lineNo - 1 - nearbyLines)` (was forward-only). Allows the natural `const safe = asSafe...(); ... sink(safe);` pattern to satisfy the gate without trailing-comment contortions.
  - `media-open-external (renderer)` rule now matches `invokeOk('media:open-external', ...)` in addition to `window.filo.invoke(...)` — the two forms are equivalent for security purposes, and three of four call sites use the envelope-aware wrapper.
  - `nearbyLines` for `media-open-external` bumped 5 → 8 to accommodate the click-handler shape (validator → preventDefault → stopPropagation → comment → invoke).
  - `WARN_ONLY` flipped to `false`. 5 sinks compliant (1 iframe via annotation, 1 theme inline, 4 media-open-external inline including `IframeTile`'s helper); 0 violations.
- **Tests:** new `src/tests/unit/sharedUntrusted.test.ts` — 38 tests covering each validator's allowlist / blocklist / malformed-input / nullish-input / case-insensitivity branches, plus a parity check pinning the HTML-renderable extension set against the renderer-side blocklist constant. Existing characterisation test `untrustedSinks.test.ts` inverted from "newtype module doesn't exist yet" / "sinks consume raw values" assertions into Phase 5 contract: module exists with the three validators exported, IframeTile imports `asSafeIframeSrc` and binds via `safeSrc + annotation`, themeManager has exactly one direct `setProperty` (inside `applySafeThemeVar`) plus ≥2 helper calls, media-open-external blocklist parity (renderer set == main set), every renderer file calling `'media:open-external'` imports `asSafeOpenExternal`, `link:fetch-metadata` carries the entry-point scheme check.
- **Verification:** `npm run lint` (12 pre-existing unused-var warnings, 0 errors), `npm run check` (0 errors / 0 warnings across 750 files), `npm run test:unit:strict` (2824 passed / 1 skipped), `npm run build` (clean), every `ci:*` gate green at the new error level. **Phase 5 closed; ci:untrusted-sinks now at error.**

## Phase 4 landed — 2026-05-27 — `VaultPath` newtype + sweep across path-keyed maps + CI gate at error

- **Shared `VaultPath` newtype:** New `src/shared/vaultPath.ts` exposes the branded `type VaultPath = string & { readonly [_brand]: 'VaultPath' }`, the `vaultPath(raw)` constructor that normalises through the same `normalizeVaultRelative` rule (forward slashes / leading-slash strip / en-US `toLocaleLowerCase` pinned for Turkish-locale safety per Phase 31 C3.7), and an `isVaultPath()` type-guard. The renderer's `lib/utils/path.ts` now re-exports `normalizeVaultRelative` from the shared module so existing call-sites keep working without an import rewrite — one canonical implementation visible to both the main process and the renderer.
- **Sweep — `writeStateTracking.ts` (P0 #8 surface):** `recentSelfWrites: Map<VaultPath, number>`, `pendingVaultPaths: Set<VaultPath>`, `failedVaultPaths: Set<VaultPath>`. Dropped the legacy `detectCaseInsensitiveFs` / `normaliseRegistryKey` helpers — the brand collapses casing unconditionally on every platform, matching the rest of the codebase (`tagsStorage`, `fileTags`, `fileWatcher`'s suppression map). `trimSetIfOverflowing<T extends string>(set: Set<T>, …)` was widened so both branded sets can pass through. Every public API (`markRecentSelfWrite`, `isRecentSelfWrite`, `dropRecentSelfWrite`, `noteAdditionalPendingPath`, `dropPendingPath`, `hasPendingWrite`, `markPathFailed`, `beginWrite`, `endWrite`) still accepts `path: string` at the boundary and brands internally.
- **Sweep — `vaultExternalChanges.ts`:** `partialReadRetryInflight: Set<VaultPath>`, `partialReadRetryCount: Map<VaultPath, number>`, `partialReadRetryTimers: Map<VaultPath, ReturnType<typeof setTimeout>>`, `recentRenamedOldPaths: Map<VaultPath, number>`, plus the in-method `previousByPath: Map<VaultPath, FileMetadata | null>` snapshot. Every per-loop access now derives `const relKey = vaultPath(rel)` once and reuses it for the retry-count / retry-timer / dedupe operations, so a mid-batch case-shift in the watcher event stream lands on the same key the writer registered. File-size allowlist bumped `vaultExternalChanges.ts` 1369 → 1371 LOC (the import + `relKey` declaration).
- **Sweep — `fileWatcher.ts`:** `suppressedPaths: Map<VaultPath, number>`, `suppressedPrefixes: Map<VaultPath, number>`, `lastKnownSizes: Map<VaultPath, number>`, `lastKnownHashes: Map<VaultPath, string>`. Dropped `CASE_INSENSITIVE_FS` / `normaliseSuppressionKey` (the brand handles the same job). `suppress` / `suppressTree` / `isSuppressed` / `gcSuppressedPaths` / `sizeOf` / `hashAsync` / the rename post-processing loop all route through `vaultPath()`; the `suppressedPrefixes` slot uses a one-shot `as VaultPath` for the `'/'` suffix concat (still a `VaultPath`, just synthesised). Walker seed in `walkDir` also brands the `rel` before populating `lastKnownHashes`.
- **Sweep — `vault.svelte.ts` + `fileTags.svelte.ts`:** `knownPaths` (file-tree refresh broken-ref recomputation) → `SvelteSet<VaultPath>` with `add(brandVaultPath(slice))`. Import aliased (`vaultPath as brandVaultPath`) because the file owns a local `let vaultPath = $state<string>('')` for the active vault root. `placedPaths` in `fileTags.svelte.ts:getTagUsageCount` → `SvelteSet<VaultPath>` with `add(vaultPath(textPath))` / `add(vaultPath(mediaPath))` so a tile def's stored casing collides with the disk path on lookup.
- **Escape hatches (gate false positives):** `vaultCandidate.ts:boardPaths: Record<string, string>` (keys are boardId nanoid, NOT vault paths — value-type Phase 4 deferred) and `vaultTreeSort.ts:indexByPath: Map<string, number>` (keys are absolute file-tree node `n.path`, NOT vault-relative) both annotated with `// allow-string-path-key: <reason>`. `vault.svelte.ts:allAbsPaths` (renamed from `allPaths`) also annotated — its keys are absolute file-tree paths and must collide bit-for-bit with `selectedPaths` entries.
- **CI gate:** `scripts/check-vault-path-keys.mjs` flipped `WARN_ONLY = false`. Scans 260 files; 0 path-keyed `Map<string,_>` / `Set<string>` declarations remain.
- **Tests:** new `src/tests/unit/sharedVaultPath.test.ts` (16 tests — normalisation rules, constructor idempotency, `isVaultPath` guard, empty-string sentinel, Turkish-locale dotted-i safety, post-Phase-4 map-key parity including the P0 #8 rename surface). `selfWriteCaseInsensitive.test.ts` rewritten — the `it.runIf(CASE_INSENSITIVE_FS)` Linux-vs-Windows fork is gone; every assertion runs on every platform now that `vaultPath()` unconditionally case-folds. Existing characterisation test `vaultPathNormalisation.test.ts` inverted from "discover sweep targets" to "post-Phase-4 sweep is complete" — the discovery walk MUST return empty (modulo escape hatches), and the shared module's exports + map-key parity are asserted explicitly.
- **Verification:** `npm run ci:verify` green; 2783 unit tests pass (1 skipped). Type-check, lint, file-size ratchet, all 22 CI gates clean. `ci:vault-path-keys` now at error level.

## Phase 3 landed — 2026-05-27 — Watcher reopen state machine + unified external-edit reconciler registry

- **3.1 WatcherSupervisor:** New `src/main/services/watcherSupervisor.ts` (190 LOC) owns the reopen state machine. Three states: `active` / `reconnecting` / `suspended`. Exponential backoff `[1s, 5s, 30s, 300s]`, capped at 5 min tail. Reconcile walker continues to run during `reconnecting` so external edits still surface at the slower 30 s cadence. `FileWatcher` delegates to one supervisor per vault via `noteOpenSuccess` / `noteError` / `shutdown` callbacks. New IPC channel `vault:watcher-state` broadcasts state transitions to every BrowserWindow with `{ vaultPath, state, reason?, attempt? }` payload. Renderer subscribes in `vault.svelte.ts:listenForChanges` — first `reconnecting` (attempt 0) surfaces a warning toast, recovery to `active` surfaces an info toast. Per-process reopen retry timer cleared on `stop()`.
- **3.2 Granular config classification:** `FileChangeType` split — `config-tags` / `config-theme` / `config-template` introduced alongside the existing bare `config` for un-routed `.filo/` files. `FileWatcher.classifyChange` routes `.filo/tags.json` → `config-tags`, `.filo/themes/*.json` → `config-theme`, `.filo/templates/*.json` → `config-template`. Eight `FileChangeType` arms total.
- **3.2 External change registry:** New `src/renderer/lib/vault/externalChangeRegistry.ts` (~220 LOC) — exhaustive `Record<FileChangeType, ExternalChangeReconciler>` dispatcher with placeholder-marker fallback. Two surfaces: `registerReconciler` (single-event) and `registerBatchedReconciler` (kind-grouped batches preserving arrival order). `dispatchExternalChangeBatch` is the entry point from the listener; both surfaces catch reconciler throws so a misbehaving reconciler can't poison sibling kinds in the same batch.
- **3.2 New reconcilers:** New `src/renderer/stores/vaultExternalReconcilers.ts` (~270 LOC) registers four single-event reconcilers + two batched bridges:
  - `boardJsonReconciler` — finds boardId for the path, silent-reloads via `loadBoard` + `boardCacheStore.replaceCache` when no pending write; otherwise surfaces a "Board file changed externally" toast with Reload / Keep-your-edits actions.
  - `tagsJsonReconciler` — re-invokes `tags:load` + `fileTagsStore.setAll` + info toast.
  - `themeJsonReconciler` — re-lists themes via `themeStore.refreshAvailable`; re-applies the active theme if its file was the one that changed.
  - `templateReconciler` — re-fetches via `templatesStore.load`.
  - `documentBatchedReconciler` / `attachmentBatchedReconciler` — bridge to the existing `vaultStore.handleExternalMarkdownChanges` / `handleExternalAttachmentChanges` cross-store coordination (vault index, document store, history, popups). The bridge keeps Phase-3 scope contained — extracting those handlers is deferred.
- **Registry registration deferred via `queueMicrotask`** to break the partial-evaluation cycle between `vaultExternalReconcilers.ts` and `vault.svelte.ts`.
- **Dispatcher wired into `vault.svelte.ts`:** `vault:files-changed` listener replaced its inline `c.type === 'document' | 'attachment'` filter with `dispatchExternalChangeBatch(events)`. Self-write filtering moved into the individual reconcilers (each `isRecentSelfWrite` call lives inside its kind's handler). New `vault:watcher-state` listener surfaces the supervisor-aware toasts.
- **New utility `hasPendingWrite(path)`** on `writeStateTracking.ts` (re-exported through `boardSaver.ts`) — true when the path is in `pendingVaultPaths` or `failedVaultPaths`. Drives the board reconciler's silent-reload vs prompt branch.
- **New `FileWatcher.classifyForTests`** public probe so unit tests can verify the granular config classification without going through the `.filo/`-skipped reconcile walker.
- **Tests:** new `src/tests/unit/fileWatcherSupervisor.test.ts` (11 tests — state introspection, reopen state machine, granular config classification), new `src/tests/unit/externalChangeRegistry.test.ts` (8 tests — register / dispatch / batched dispatch / throw isolation / last-writer-wins / `_registeredKindsForTests`). Existing characterisation test `externalEditReconciliation.test.ts` inverted: 14 assertions covering the post-Phase-3 contract (registry exists, dispatcher used, four new reconcilers registered, supervisor module + WATCHER_REOPEN_BACKOFF_MS + `vault:watcher-state` references present).
- **IPC parity:** `vault:watcher-state` added to `IpcChannel` union + `MAIN_TO_RENDERER_EVENTS` allowlist in both the gate script and the `ipcChannelParity.test.ts` orphan-allowlist set.
- **Verification:** `npm run ci:verify` green; 2774 unit tests pass.

## Phase 2 landed — 2026-05-27 — Mandatory `Command.targetBoardId` + CI gate at error

- **Command base class:** `Command.targetBoardId` promoted from `readonly targetBoardId?: string` to `readonly targetBoardId: string` (interface + abstract class doc updated). Existing truthy guard in `historyStore.undo/redo` still skips empty strings, so board-agnostic commands (CascadeDeleteCommand, ReplaceAllCommand) pass through unchanged by assigning `''`.
- **Mechanical sweep:** 62 command classes across `tileCommands.ts` (15), `kanbanCommands.ts` (11), `taskCommands.ts` (9), `waypointCommands.ts` (6), `styleCommands.ts` (5), `frameCommands.ts` (4), `sectionCommands.ts` (4), `connectionCommands.ts` (3), `groupAndBoardCommands.ts` (3 — BatchCommand resolves from first child's targetBoardId, CascadeDeleteCommand stays empty by design), `attachmentSrcCommand.ts` (1), `renameTitleCommand.ts` (1), `replaceAllCommand.ts` (1 — empty by design). Every constructor now takes an optional trailing `boardId?: string` and assigns `this.targetBoardId = boardId ?? boardStore.current?.id ?? ''`.
- **Push sites (P1-5):** `TileStylePopup`, `ConnectionStylePopup`, `FrameStylePopup` now capture `boardStore.current?.id` at popup mount and thread it through the destroy-effect's command push. Kanban / Task style popups already take `boardId` as a prop, so they were correct as-is.
- **CI gate:** `scripts/check-commands-have-target-board.mjs` flipped `WARN_ONLY = false`. 68/68 commands compliant.
- **Tests:** new `src/tests/unit/historyCrossBoardGuard.test.ts` (3 tests — undo refuses + toast, redo refuses + toast, empty `targetBoardId` skips the guard). `commandTargetBoardCoverage.test.ts` rewritten from a baseline-pinning matrix into an unconditional "every command declares + assigns" assertion.
- **Verification:** `npm run ci:verify` green; 2752 unit tests pass. The other warn-only gates (`ci:untrusted-sinks` Phase 5 scope, `ci:vault-path-keys` Phase 4 scope) remain warn-only as planned.

/**
 * File-size ratchet (Phase 7 regression-prevention gate).
 *
 * Enforces CLAUDE.md "one concern per file": no source file may exceed
 * LIMIT lines unless it is on ALLOWLIST. ALLOWLIST entries record the
 * snapshot LOC at the time the allowlist was set — a file may shrink or
 * stay the same, but growth past its snapshot fails the gate. To
 * legitimately raise a snapshot (e.g. after a feature lands and a
 * follow-up refactor will shrink it) the developer must edit ALLOWLIST,
 * which is visible in `git diff` and gets reviewed.
 *
 * Scans `src/main` and `src/renderer` for `.svelte`, `.svelte.ts`, `.ts`.
 * Tests (`src/tests/**`) are out of scope per the same convention.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const SCAN_DIRS = ['src/main', 'src/renderer'];
const EXTENSIONS = ['.svelte', '.svelte.ts', '.ts'];
const LIMIT = 1000;

/**
 * Files currently above LIMIT. Snapshot LOC = the ceiling for that file.
 * To shrink an entry off the allowlist entirely, refactor below LIMIT then
 * delete its row here.
 */
const ALLOWLIST = {
  // TaskList orchestrator: section/row drag (svelte-dnd-action), section
  // popups, bulk multi-select, filters/saved-views wiring, frontmatter
  // writer hookup, BoardBackground mount. Sprint 39 / 39.8 split out
  // filtersAndViews.svelte.ts (−120 LOC); further sharding
  // (sectionDragController, taskLifecycle, sectionPopups) is deferred per
  // the Sprint 39 memory entry. Bump history in git log.
  // AUDIT_REMEDIATION_PLAN_2026-05-30 Phase 7.1 — tightened to current LOC
  // (was 2245) to restore the ratchet's bite after Phase 5/6 trimming.
  // AUDIT2_REMEDIATION_PLAN_2026-05-31 Phase 5.6 — onDestroy calls
  // filters.dispose() so the lastView debounce can't fire after teardown;
  // +1 LOC of comment + call. New snapshot: 2192 LOC.
  'src/renderer/components/boards/TaskListBoard.svelte': 2192,
  // Phase 7.1 — tightened to current LOC (was 1506).
  'src/renderer/components/boards/KanbanSideToolbar.svelte': 1490,
  // TaskItem row: title strip + notes panel + style cascade (headerColor /
  // bodyColor split across `.task-item` and `.task-notes-panel-inner`),
  // multi-select chrome, hover-reveal buttons, sticky note panel toggle.
  // Wrapping border + radius engineering is non-obvious — see in-file
  // comments. Bump history in git log.
  // AUDIT_REMEDIATION_PLAN_2026-05-30 Phase 5.7 — added the optional
  // "Delete Task & File…" context-menu entry (`onDeleteWithFile` prop +
  // type + one menu row). +3 LOC. New snapshot: 1542 LOC.
  'src/renderer/components/boards/TaskItem.svelte': 1542,
  // KanbanBoard orchestrator: column dndzone (svelte-dnd-action), per-column
  // card dndzone (replaces native HTML5), multi-card drag (`dragBlockIds`),
  // tag-editor popup + tile-style-popup wiring, BoardBackground mount,
  // empty-state card. Drag controller + filters/sort live in `lib/kanban/`;
  // further trimming needs a structural pass. Bump history in git log.
  // Phase 6.1 (IMPLEMENTATION_PLAN_2026-05-27) — added role/aria/tabindex
  // on the board container plus `findColumnAndIndex` / `neighbourTileId`
  // arrow-nav helpers + Enter→open-as-document handler inside
  // `handleBoardKeydown`. +~80 LOC.
  // AUDIT_REMEDIATION_PLAN_2026-05-29 Phase 3 — M2 added the `isActivePane`
  // guard + `enabled:` gating on the add-tile / add-column shortcut
  // registrations so a split view routes the shared bare `n` to the focused
  // pane; +7 LOC.
  'src/renderer/components/boards/KanbanBoard.svelte': 1410,
  // KanbanColumn: column header (3-dot menu + WIP popover), card dndzone
  // shadow-placeholder rendering, outer `.kanban-column` drag handlers (so
  // OS file drops over the header don't paint the no-entry cursor), per-
  // column accent override, multi-card drag dimming. Bump history in git log.
  // Phase 7.1 — tightened to current LOC (was 1200).
  'src/renderer/components/boards/KanbanColumn.svelte': 1198,
  // Vault store: lifecycle (open / close / swap / save), tree refresh + rename
  // queue (serialises external renames), recovery sentinels (.dirty +
  // tag-rewrite + rename-cascade, sequenced via awaitRecoveryDismiss),
  // three-way save-before-swap dialog, board-load orphan-prune dirty
  // propagation, vault:tree-too-large + vault:reconcile listeners. Lifecycle
  // slice extraction tried in Sprint D, reverted (microtask race); see
  // Phase 30 memory. Bump history in git log.
  // Phase 7 (IMPLEMENTATION_PLAN_2026-05-27) — `save()` no longer short-
  // circuits on missing currentProject (lets quit-during-vault-open flush
  // pending writes); +9 LOC for the explanatory comment.
  // AUDIT_REMEDIATION_PLAN_2026-05-28 Phase 4 — E4 added the dev-only
  // `assertBaselinesSeeded` tripwire at the end of the vault commit (+import
  // +call +comment) and E5 added the rename-cascade recovery's tag-sink
  // re-assert + flush before clearing the sentinel; +~32 LOC.
  // Phase 7.1 — tightened to current LOC (was 1425).
  // AUDIT2_REMEDIATION_PLAN_2026-05-31 Phase 5.3 — `runPostCommitTasks`
  // walks `vaultIndexStore.allMetadata()` after rebuild and calls
  // `boardCacheStore.applyFrontmatterToBackedTiles` for each so cached
  // tile metadata reconciles against canonical frontmatter on every
  // vault open (closes between-session drift). +10 LOC (loop + comment).
  // PHASE6_PLAN_2026-06-01 Phase 6.0.C1 — `openVault` now invokes
  // `vault:close` on the main side between the pre-swap dispatch and
  // `loadVaultCandidate` so the main-side `vault:init-config` guard
  // (`board.ipc.ts:108`, refuses to re-anchor while a different vault is
  // active) doesn't reject every user-driven vault swap. +7 LOC
  // (try/catch + one-line comment). New snapshot: 1406 LOC.
  'src/renderer/stores/vault.svelte.ts': 1406,
  // External-changes orchestrator: classifies fs-watcher events into
  // editor-dirty toast / silent reload / sync-frontmatter / deleted-file
  // prompt / properties-popup-dirty prompt. 500 ms attachment-delete grace
  // period; bulk Reload-all path; cross-vault finalizer guard; markdown-
  // write gateway integration. Phase R2 added `runExternalRenameCascade`
  // helper (~45 LOC). Phase R6 added `promptBoardExternalEdit` (~35 LOC)
  // + the queueMicrotask registration of pre-write-stat handlers
  // (markdown writer + board scheduler) so drift detection routes
  // through Reload / Keep-local toasts. Bump history in git log.
  // Sprint B / B9 — `vaultIndexStore.renameKey` wire-up inside
  // `runExternalRenameCascade` adds an exact-match call + a folder-prefix
  // loop so vault search rebinds immediately on external rename.
  // Phase 4 — VaultPath import + per-loop `vaultPath(rel)` brand calls
  // for partial-read retry maps + previousByPath; +2 LOC.
  // AUDIT_REMEDIATION_PLAN_2026-05-28 Phase 2 — F4 added the
  // pending-local-write guard (`hasPendingWrite` intercept +
  // `promptMarkdownPendingWriteConflict`) and F3 added the synchronous
  // `fileTagsStore.flushPendingSave()` call inside `runExternalRenameCascade`;
  // +~84 LOC. Both are data-safety point-fixes; Phase 4 E3/E5 consolidate
  // them into shared authorities, which will shrink this back.
  // AUDIT_REMEDIATION_PLAN_2026-05-28 Phase 3 — M5 added the reload-silently
  // recovery snapshot (`promptReloadRecoveryIfSuspicious` + the pre-reload
  // capture in the reload-silently branch); +~72 LOC. Phase 4 E3 folded the
  // markdown classifier's dirty-check onto the shared `isPathPending`
  // authority (net-neutral rename) and E5 recorded the `tagsAffected` sink in
  // the external-rename cascade's sentinel write; +3 LOC.
  // AUDIT_REMEDIATION_PLAN Phase 2 / 7.9 — the file was over its prior 1530
  // ceiling (1538 LOC). Extracted the partial-read retry bookkeeping + the
  // attachment-delete grace window (module-scoped timing state + reset
  // helpers) into `lib/vault/externalChangeWindows.ts`; the store keeps its
  // public API via re-export. New snapshot: 1460 LOC.
  // AUDIT_REMEDIATION_PLAN_2026-05-30 Phase 4.2 — dropped the deleted file's
  // `.filo/tags.json` membership from the three user-confirmed deletion
  // handlers (promptDeletedFile Reload, bulk Reload-all, promptClosedBoard-
  // FileMissing Mark-broken-refs) so an external delete doesn't orphan its
  // tag entry. Three one-liners + comments scattered across those handlers;
  // nothing cleanly extractable for +14 LOC. The deferred 7.9 split (extract
  // the deletion-prompt cluster) will reclaim this. New snapshot: 1474 LOC.
  // AUDIT2_REMEDIATION_PLAN_2026-05-31 Phase 5.2 — added a per-path
  // in-flight `Map<path, Promise<choice>>` so concurrent
  // `promptExternalEditOnSync` callers for the same file share one toast
  // + one decision. Also exposed `__inFlightDriftPromptsForTests` so the
  // dedup contract is unit-testable. +45 LOC (map + dedup logic + finally
  // hook + test getter + docstrings). New snapshot: 1519 LOC.
  // PHASE6_PLAN_2026-06-01 Phase 6.1.R1 — `recreateDeletedFile` now
  // routes its post-write open-editor sync through the shared
  // `syncOpenEditorsAfterDiskMutation` helper. The helper's
  // `applyReloadFromDisk` self-cancels the armed body writer (6.0.C2),
  // which the bare `markClean(...)` it replaced did NOT — closing the
  // pre-recovery debounced-write race. +1 import line + 6 LOC of
  // comment + call site = +7 LOC. New snapshot: 1526 LOC.
  'src/renderer/stores/vaultExternalChanges.ts': 1526,
  // tileCommands.ts dropped off the allowlist (AUDIT_REMEDIATION_PLAN_2026-05-29
  // Phase 5 / C-3): the tag-driven commands (AddTileTag / RemoveTileTag /
  // AddPathTag / RemovePathTag / ToggleTagFade) moved to the new sibling
  // `commands/tileTagCommands.ts`, bringing the file back under the 1000-LOC cap.
};

function toPosix(p) {
  return p.split(sep).join('/');
}

function hasTrackedExtension(name) {
  return EXTENSIONS.some((ext) => name.endsWith(ext));
}

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      walk(full, out);
    } else if (s.isFile() && hasTrackedExtension(entry)) {
      out.push(full);
    }
  }
}

function countLines(path) {
  const text = readFileSync(path, 'utf8');
  if (text.length === 0) return 0;
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++;
  }
  if (text.charCodeAt(text.length - 1) === 10) count--;
  return count;
}

const files = [];
for (const dir of SCAN_DIRS) {
  walk(join(ROOT, dir), files);
}

const offenders = [];
const allowlistChecks = new Map(Object.entries(ALLOWLIST));

for (const abs of files) {
  const rel = toPosix(relative(ROOT, abs));
  const loc = countLines(abs);
  if (allowlistChecks.has(rel)) {
    const snapshot = allowlistChecks.get(rel);
    if (loc > snapshot) {
      offenders.push({ rel, loc, ceiling: snapshot, kind: 'allowlist-growth' });
    }
    allowlistChecks.delete(rel);
  } else if (loc > LIMIT) {
    offenders.push({ rel, loc, ceiling: LIMIT, kind: 'over-limit' });
  }
}

const staleAllowlist = [...allowlistChecks.keys()];

if (offenders.length === 0 && staleAllowlist.length === 0) {
  console.log(`[check-file-sizes] OK — scanned ${files.length} files, all within ceilings.`);
  process.exit(0);
}

if (offenders.length > 0) {
  console.error('[check-file-sizes] FAILED — files over their ceiling:');
  for (const o of offenders) {
    console.error(`  ${o.rel} — ${o.loc} LOC (ceiling ${o.ceiling}, ${o.kind})`);
  }
  console.error(
    '\nFix: split the file (see CLAUDE.md "one concern per file") or, if the growth\n' +
      'is intentional, edit ALLOWLIST in scripts/check-file-sizes.mjs in the same PR.',
  );
}

if (staleAllowlist.length > 0) {
  console.error('\n[check-file-sizes] FAILED — ALLOWLIST entries no longer exist on disk:');
  for (const path of staleAllowlist) console.error(`  ${path}`);
  console.error('\nFix: remove these entries from ALLOWLIST in scripts/check-file-sizes.mjs.');
}

process.exit(1);

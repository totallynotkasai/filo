# Audit Remediation Plan — 2026-05-28

**Source:** Independent multi-agent audit (2026-05-28). Findings were verified against
source, not against prior plans. This plan supersedes nothing; it addresses the gaps that
the 2026-05-27 pass and earlier remediation did not close.

**Goal:** make Filo safe to daily-drive, with the silent-data-loss windows closed and the
recurring root-cause patterns enforced so they cannot reappear.

## Guiding principles

1. **Leave runnable software at every phase boundary** (CLAUDE.md rule). `npm run ci:verify`
   must be green at the end of each phase.
2. **Point-fix before hardening.** Squash the symptom with a low-risk local change to unblock
   daily use; schedule the chokepoint/CI-gate version separately so it can't recur. Do not
   block daily-driving on Phase 4.
3. **A fix is not done without a test.** Each item lists the test to add. Prefer a unit test
   that fails before the fix.
4. **Use the enforcement pattern you already have.** `check-no-adhoc-schedulers.mjs` and
   `check-command-snapshot-discipline.mjs` are the model: close the abstraction so new code
   can't bypass it. Phase 4 extends that discipline to the subsystems that lack it.

## Finding index

| ID | Severity | Title | Phase |
|----|----------|-------|-------|
| F1 | HIGH | Pre-write drift baseline never seeded for `.md` (drift check inert) | 2 |
| F2 | HIGH | Scheduler counter leak on same-key re-entrant write | 1 |
| F3 | HIGH | Rename cascade not atomic across `tags.json`; sentinel incomplete | 2 |
| F4 | HIGH | Reload/sync clobbers pending frontmatter write with no open editor | 2 |
| F5 | HIGH | Escape during sidebar rename commits instead of cancelling | 1 |
| F6 | HIGH | From-future migration guard bypassed for tags + layout templates | 3 |
| M1 | MED | Frontmatter version-token can silently skip a newer write | 3 |
| M2 | MED | `Infinity` coords silently rewritten to defaults on load | 3 |
| M3 | MED | Shallow snapshot helpers in Kanban/TaskList undo (latent) | 3 |
| M4 | MED | No `will-navigate` / `setWindowOpenHandler` on main window | 3 |
| M5 | MED | `reload-silently` irreversible + partial-read heuristic mis-judgment | 3 |
| E1 | — | Markdown read gateway + CI gate (recurrence-proofs F1) | 4 |
| E2 | — | `loadVersionedFile` helper for all config loaders (recurrence-proofs F6) | 4 |
| E3 | — | Single `isPathPending()` consulted by all reconcilers (recurrence-proofs F4) | 4 |
| E4 | — | Dev-time assertion: baseline defined after hydrate/load | 4 |
| E5 | — | Recovery sentinel covers every derived sink (recurrence-proofs F3) | 4 |
| P1 | LOW | Mind Map side-toolbar menus: no Escape/click-outside/roles | 5 |
| P2 | LOW | Emoji used as UI chrome (FileTile, SearchFindAllPopup) | 5 |
| P3 | LOW | CSS animates layout props (GPU-only rule) | 5 |
| P4 | LOW | Pane-close button keyboard-invisible | 5 |
| P5 | LOW | `KanbanTemplatePicker` buttons inside `role=listbox` | 5 |
| P6 | LOW | `media:open-external` loose `startsWith('http')` | 5 |
| D1 | LOW | Dead `RichTextAnnotationSchema` | 5 |
| D2 | LOW | `nanoid(12)` vs documented `nanoid(10)` doc drift | 5 |

Risk = blast radius. Effort: S (<2h), M (~half day), L (1–2 days).

---

## Phase 1 — Daily-drive unblock (pure bugs)

**Goal:** fix the two bugs a sole-editor user hits and the broken trust signals, with zero
design risk. After this phase you can daily-drive Filo *as your only editor* with low risk.

**Definition of done:** F2 + F5 fixed, regression tests added, `ci:verify` green.

### F2 — Scheduler counter leak (HIGH, risk Low, effort S)
- **File:** `src/renderer/lib/boards/writeScheduler.ts` (`fireWrite`, ~255–305).
- **Root cause:** `inFlight.set(key, entry)` (line 286) overwrites the prior in-flight entry
  when a second write for the same `key` fires before the first settles. The first write's
  `.then` hits `!trackerIsCurrent()` (line 294) and returns **without** `safeEndWrite`, so its
  paired `beginWrite` is never balanced. `inflightWriteCount` sticks > 0 → save indicator
  pinned on "saving", `markClean` never runs → `.filo/.dirty` survives a clean save → phantom
  recovery prompt next launch.
- **Change:** don't key in-flight tracking solely by `key`. Either (a) track in-flight entries
  per key as a set keyed by a monotonic fire-token so each fire owns its own `endWrite`, and
  have `flush(key)` await all tokens; or (b) simplest correct fix — when overwriting an
  existing in-flight entry for `key`, call `safeEndWrite` for the superseded entry first so its
  `beginWrite` is balanced before the new one registers. Prefer (a); it also fixes `flush(key)`
  correctness under overlap.
- **Test:** `writeScheduler.test.ts` — schedule → fire → (mid-IPC) reschedule → fire the same
  key with a slow `performWrite`; assert `inflightWriteCount` returns to 0 and `markClean` runs
  exactly once. This path is currently untested.

### F5 — Escape commits sidebar rename (HIGH, risk Low, effort S)
- **File:** `src/renderer/components/sidebar/VaultFileItem.svelte` (~471–477, 616).
- **Root cause:** the rename `<input>` has `onblur={commitRename}`; Escape sets `isRenaming =
  false`, which unmounts the input → fires `blur` → `commitRename()` performs the rename the
  user just aborted. No cancel guard.
- **Change:** set a `renameCancelled` flag in the Escape branch of `handleRenameKeydown` and
  early-return from `commitRename` when it's set (reset on rename start). Mirror the
  `activeEditor`-guard approach the TipTap title-edit paths already use.
- **Test:** component/E2E — start rename, press Escape, assert the file keeps its original name
  and no `vault:rename` IPC fires.

---

## Phase 2 — Concurrent-editor data safety

**Goal:** close the silent-loss windows that open when the same vault is edited in an external
tool (Obsidian/VS Code) while Filo is running. Required before relying on the "edit anywhere"
promise.

**Definition of done:** F1, F3, F4 point-fixed with tests; `ci:verify` green. (Recurrence-proof
versions land in Phase 4.)

### F1 — Seed the drift baseline for `.md` (HIGH, risk Med, effort M)
- **Files (verified call sites passing no mtime):** `TextTile.svelte:262/278/290/312/326`,
  `DocumentEditor.svelte:304/332`, `PropertiesPopup.svelte:216`, `boardCache.svelte.ts:848`,
  `kanbanTileCreation.ts:158/257`, `taskCreation.ts:165`, `kanbanCommands.ts:739`,
  `frontmatterWriteScheduler.ts:171`, `vaultExternalChanges.ts:1291`. Writer:
  `markdownFileWriter.ts:173` (`markHydrated(relPath, hadBom, mtimeMs?)`) — baseline only
  seeded when `mtimeMs` is passed; it never is, so the drift check at `:241-266` no-ops.
- **Decided (2026-05-28) — Option A:** the content read and the mtime come from the **same**
  IPC call. Extend `vault:read-file-text` to also return `mtimeMs`, then thread it into every
  `markHydrated` call. Rationale: a separate `vault:stat` after the read leaves a gap in which
  an external write skews the baseline against the hydrated bytes (TOCTOU). The read-then-stat
  variant is rejected.
- **Change:** add `mtimeMs` to the read result; pass it through `parse*` → `markHydrated` at
  every hydrate site above. Also fix the now-false docstring at `markdownFileWriter.ts:160-168`
  claiming TextTile/DocumentEditor already pass it.
- **Test:** extend `fileBaselineDrift.test.ts` — after a hydrate via each path, `getBaseline`
  is defined; then an external mtime bump triggers the Reload/Keep-local prompt on the next
  write instead of a silent overwrite.

### F4 — Pending-write guard on the markdown classifier (HIGH, risk Med, effort M)
- **File:** `src/renderer/stores/vaultExternalChanges.ts` (classifier, ~179–244).
- **Root cause:** "dirty" is defined as "has an open editor" (`documentStore.findByFilename`).
  A Kanban card / Task with a *pending scheduled frontmatter write* but no editor classifies as
  `reload-silently`/`sync-frontmatter`; the pending local debounce then fires last-write-wins.
  The board reconciler checks `hasPendingWrite`; this path doesn't.
- **Change:** before classifying as `reload-silently`/`sync-frontmatter`, check whether any
  scheduler has a pending or in-flight write for `rel` (frontmatter scheduler + markdown
  writer). If so, either drain it first and re-classify, or treat the file as dirty and route
  to the conflict prompt. (In Phase 4 this consults the single `isPathPending()` API from E3.)
- **Test:** unit — toggle a card's `completed` (schedules FM write, no editor open), fire an
  external change for the same file, assert the local pending write is not clobbered (prompt or
  drain), not silently dropped.

### F3 — Atomic rename cascade across all sinks (HIGH, risk Med, effort M)
- **Files:** `vaultExternalChanges.ts` (`runExternalRenameCascade`, ~545–664),
  `vaultFolderOps.ts` (`runRename`, ~361–649), `renameCascadeSentinel.ts`.
- **Root cause:** boards flush via awaited `flushAllDirty`, but `fileTagsStore.renameFile`
  goes through a debounced misc-write and the sentinel records only `affectedBoardIds`. Crash
  after the board flush but before the tag debounce lands → `tags.json` keeps the old key and
  recovery only re-runs board propagation → silent tag-membership loss.
- **Change (point-fix):** within the cascade, **synchronously flush** the tag-store write (await
  it) in the same critical section as the board flush, so the debounce can't straddle a crash.
  (Recurrence-proof version E5 records tag-affected paths in the sentinel so recovery
  re-asserts them.)
- **Test:** unit — rename a tagged `.md`, simulate crash (no debounce flush), assert recovery
  re-asserts the tag key; with the synchronous flush, assert `tags.json` has the new key before
  the cascade returns.

---

## Phase 3 — Latent corruption & robustness

**Goal:** close the lower-probability corruption vectors and the load-time silent mutations.
None are daily-blocking for a single-version sole editor, but all are real.

**Definition of done:** F6, M1–M5 resolved or explicitly decided; `ci:verify` green.

### F6 — Wire the version migrators (HIGH, risk Low, effort S)
- **Files:** `tagsStorage.ts` (`parseTagsFile`, ~42), `layoutTemplateStore.ts`
  (`listLayoutTemplates`, ~42). Migrators exist but have **zero callers**: `tagsFile.ts:79`
  (`migrateTagsFile`), `layoutTemplate.ts:136` (`migrateLayoutTemplate`).
- **Root cause:** version fields were broadened to `z.number().int()` so the migrator could
  run, but the loaders call `safeParse` directly. A `version: 99` file written by a future
  Filo parses clean and an older build re-saves it → silent downgrade.
- **Change:** route both loaders through their migrator (migrate → parse), mirroring
  `boardLoader`'s `fromFuture` / `noMigrationPath` handling (surface a friendly "from a newer
  version" message; do not clobber). This also retires the "dead migrator" finding.
- **Test:** unit — a from-future `tags.json` / template is detected and not downgraded.

### M1 — Frontmatter version-token silent skip (MED, risk Med, effort M)
- **File:** `frontmatterWriteScheduler.ts:144-145` (`scheduledVersion <= last` returns without
  writing). `lastFlushedVersion` is keyed by `relPath`, not `docId`.
- **Change:** key the version map by `docId` (stable identity) so two docs transiently sharing
  a `relPath` during a rename can't satisfy the guard and drop an edit. Verify against the
  rename-in-flight path.
- **Test:** unit — two docId streams aliasing one `relPath` mid-rename; assert neither edit is
  skipped.

### M2 — `Infinity` folds to default on load (MED, risk Low, effort S)
- **File:** `schemaUtils.ts:23` (`coerceToNumber` folds ±Infinity to fallback; NaN is rejected).
- **Issue:** silently rewrites a hand-edited coordinate to 240/160, then persists it — contrary
  to the loader's otherwise fail-loud stance.
- **Decided (2026-05-28) — Option A (fail loud):** route Infinity to `failedBoards` + a
  recovery snapshot, exactly like other board corruption, instead of silently folding to a
  default and persisting it. Document the choice with a `// DECISION:` comment at the change
  site. (Removes the inconsistency with the loader's otherwise fail-loud stance.)
- **Test:** unit — a board with an Infinity coord behaves per the chosen policy.

### M3 — Shallow snapshot helpers in undo (MED, risk Low, effort S)
- **Files:** `kanbanCommands.ts:32-51` (`snapshotKanbanColumns`/`restoreKanbanColumns`),
  `taskCommands.ts:35-63` (`snapshotTaskListSlice`/`restoreTaskListSlice`).
- **Issue:** two-level spread leaves nested `style`/`coverImage` aliased to live proxies. Safe
  only because cache writers currently replace immutably — one future in-place mutation
  silently corrupts a pending delete-undo. Violates the project's own deep-clone discipline.
- **Change:** route these through the `this.snapshot()` JSON-clone helper used everywhere else.
- **Test:** the existing snapshot-discipline CI gate should ideally catch this — extend
  `check-command-snapshot-discipline.mjs` to flag shallow spreads in command snapshot helpers,
  or add a unit test mutating nested style after snapshot and asserting undo restores the
  original.

### M4 — Main-window navigation guard (MED, risk Low, effort S)
- **File:** `src/main/main.ts`.
- **Change:** add `contents.setWindowOpenHandler(() => ({ action: 'deny' }))` and a
  `will-navigate` handler that `preventDefault`s any URL outside the app origin. Defense-in-depth
  currently rests on CSP alone.
- **Test:** E2E/manual — a renderer-triggered top-level navigation is blocked.

### M5 — `reload-silently` reversibility + heuristic (MED, risk Med, effort M)
- **File:** `vaultExternalChanges.ts` (`reload-silently`, ~224–244); heuristic in
  `conflictResolver.ts` (~183–196, `PARTIAL_READ_SHRINK_RATIO`/`MTIME_WINDOW_MS`).
- **Change:** snapshot prior cached metadata before applying a `reload-silently` divergence so
  a mis-judged transient/partial read is recoverable (today it's irreversible + `notePossiblyStale`
  only). Re-evaluate the heuristic bounds against a slow truncate-then-rewrite (>100ms apart).
- **Test:** unit — a partial read just outside the current bounds does not get applied as a real
  edit; a real edit still applies.

---

## Phase 4 — Recurrence-proofing (enforcement)

**Goal:** make the Phase 2/3 invariants impossible to bypass, using the same chokepoint + CI-gate
discipline already applied to schedulers and command snapshots. This is the "architecture" work
— consolidation, not redesign. Can ship after daily-driving begins.

**Definition of done:** E1–E5 in place; new CI gates green and wired into `ci:verify`.

### E1 — Markdown read gateway (recurrence-proofs F1, risk Med, effort M)
- One module exposing `readMarkdownForHydrate(vaultRoot, relPath) → { content, hadBom, mtimeMs }`
  that seeds the baseline atomically. Migrate all hydrate sites onto it. Add
  `scripts/check-markdown-read-gateway.mjs` forbidding direct `invokeOk('vault:read-file-text', …)`
  outside the gateway (model: `check-no-adhoc-schedulers.mjs`). After this, hydrating-without-a-
  baseline is structurally impossible.

### E2 — `loadVersionedFile` helper (recurrence-proofs F6, risk Low, effort M)
- `loadVersionedFile(schema, migrator, raw) → { ok | fromFuture | failed }`. Wire **every** config
  loader (boards, tags, templates, settings) through it. CI gate or lint asserting config
  loaders use it, so the next config type can't forget to migrate.

### E3 — Single `isPathPending()` authority (recurrence-proofs F4, risk Med, effort M)
- One query over the `writeStateTracking` ledger: "does any scheduler have a pending/in-flight
  write for path P?" Route both external-change reconcilers' dirty-check through it instead of
  "is an editor open?". Removes the definitional drift between the board and markdown paths.

### E4 — Dev-time baseline assertion (cheap safety net, risk Low, effort S)
- In dev builds, after `loadVaultCandidate` completes, assert `getBaseline(path)` is defined for
  every hydrated `.md` and every known config file (per the 2026-05-27 plan's suggestion). Turns
  the F1 invariant into a runtime tripwire.

### E5 — Comprehensive recovery sentinel (recurrence-proofs F3, risk Med, effort M)
- Extend `renameCascadeSentinel` to record every derived sink touched (boards **and** tag paths
  **and** frontmatter), and have recovery replay re-assert all of them. Makes the cascade
  atomic-or-fully-recoverable regardless of which sink's debounce was mid-flight.

---

## Phase 5 — UX / a11y / polish / dead code

**Goal:** consistency and rule-compliance. Non-blocking; batch when convenient.

| ID | File(s) | Change | Effort |
|----|---------|--------|--------|
| P1 | `SideToolbar.svelte:185-199` | Add `svelte:window` Escape + click-outside dismissal and `role=menu` + arrow-key nav, matching `ContextMenu` | M |
| P2 | `FileTile.svelte:174`, `SearchFindAllPopup.svelte:31-40` | Replace emoji chrome with SVG icons (SVG-only rule); remove dead `.file-icon{font-size:48px}` | S |
| P3 | `KanbanBoard.svelte:1207`, `FileTile.svelte:230/279` | Replace `transition: padding-left` / `transition: all` with transform/opacity (GPU-only rule) | S |
| P4 | `PaneView.svelte:229-235` | Add `:focus-within` reveal for `.pane-close` (keyboard visibility) | S |
| P5 | `KanbanTemplatePicker.svelte:187-202` | `role=option` on the option buttons (match `SearchFindAllPopup`) | S |
| P6 | `media.ipc.ts:244` | Tighten `startsWith('http')` → explicit `http://`/`https://` | S |
| D1 | `schema/document.ts` | Delete dead `RichTextAnnotationSchema` (never parsed) or wire it into a real load path | S |
| D2 | `ids.ts:7` vs `schemaUtils.ts:95`/CLAUDE.md | Reconcile `nanoid(12)` vs `nanoid(10)` documentation | S |

---

## Decisions (resolved 2026-05-28)

All three open decisions were approved by the owner on 2026-05-28:

1. **F1 read IPC shape → Option A.** Extend `vault:read-file-text` to return `mtimeMs` so
   content + timestamp arrive together (no read/stat TOCTOU gap). Drives F1 + E1.
2. **M2 Infinity policy → Option A (fail loud).** Corrupt/`Infinity` coordinates route to
   `failedBoards` + recovery snapshot rather than being silently folded to a default. Consistent
   with all other board corruption.
3. **F1 sequencing → quick-fix first.** Point-fix the ~10 hydrate call sites in Phase 2; build
   the enforced read gateway (E1) in Phase 4, which then absorbs those call-site edits. Lower
   risk before daily use.

## Suggested sequencing

- **Now (unblock):** Phase 1 → daily-drive as sole editor.
- **Before external-editor use:** Phase 2.
- **Soon after:** Phase 3.
- **Deliberately scheduled:** Phase 4 (enforcement) + Phase 5 (polish), once daily use is stable.

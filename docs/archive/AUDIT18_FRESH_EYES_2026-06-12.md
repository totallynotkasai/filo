# Audit-18 — Fresh-Eyes Full Audit (2026-06-12)

**Target:** commit `e35c170` (`chore/electron-42`, Audit-16 P6 + Audit-17 just committed)
**Method:** 9-agent adversarial workflow — 6 finders sweeping distinct dimensions (write-paths core, write-paths board, concurrency/vault, concurrency/stores, lifecycle, error-handling + recent-change regressions), then 3 independent verifiers attempting to REFUTE every finding against the actual source. Only findings that survived refutation are listed. Report-only; nothing was fixed.
**Brief:** deprioritize re-confirming known issues; hunt for NEW issues, logical errors, and regressions introduced by the recent Audit-16/17 changes.

**Outcome:** 39 candidates → **3 HIGH / 7 MEDIUM / 26 LOW confirmed** (incl. 3 found by the verifiers themselves), **6 refuted**.

---

## Verdict & ratings (1–10)

**Overall: 7/10 — dogfood-ready on a local, non-cloud-synced vault once the 3 HIGHs are fixed.** No corruption was found in the frontmatter CST engine itself or the core scheduler discipline — 17 audit rounds have made the *engine* genuinely hard to break. What remains lives at the **periphery**: component-level write guards (TextTile, PropertiesPopup), corrupt-file load gates (tags.json), and prompt/cancel plumbing in the external-edit flow. Every HIGH is a "write succeeds and reports success while losing data" shape, which is why they block dogfooding despite narrow triggers.

| Area | Rating | Basis |
|---|---|---|
| Frontmatter / markdown write core (engine, gateway, schedulers) | **8.5** | No engine-level corruption found. Residual: empty `---\n---\n` block misparse (L1), tagRewriter trailing-blank-line value drift on `|+` scalars (L2), hydrate-fallback BOM/EOL flip (L3) — all narrow. |
| Mind Map canvas | **8** | Cleanest area. One LOW (tileDrag global spatial batch in split-pane touch). Drag/undo/spatial lifecycle verified sound. |
| Kanban + Task List | **7** | Field-edit write path solid. But bulk "Add tag" is **dead code in Electron** (`window.prompt` throws — M7), bulk ops toast success after swallowed failures (L4), and the A17-4.5 lastView debounce is structurally defeated (L5). |
| Documents / text editing | **6** | Two of the three HIGHs: TextTile "blank-but-writable on failed read" (H3 — the unfixed twin of the Audit-12 DocumentEditor bug) and PropertiesPopup parked-write cancel-after-flush (H1). |
| External edits / cloud sync | **6** | Largest finding cluster: reload-handler cancel gaps (M3 + M6), in-app-rename vs reconcile eviction race (M2), config ENOENT no-grace (M5), board load/post-write baseline holes (L6, L7), watcher delete-swallow (L8). If the vault is local-only and not edited by other apps mid-session, effective risk is much lower. |
| Undo / redo | **7** | One MEDIUM: rollbackUndo/rollbackRedo blind stack-snapshot restore corrupts history under interleave (M4). Command snapshots/LIFO discipline otherwise verified (one claimed MEDIUM refuted on LIFO grounds). |
| Error handling & recovery honesty | **6.5** | Swap-teardown destroys unacknowledged recovery breadcrumbs (M1-adjacent, listed M-A), corrupt-config suppression reports success all session (L9), Esc on Recovery modal clears the sentinel (L10), export-cancel = failure toast (L11). |
| Security | **8.5** | Nothing new confirmed. Prior hardening (copy-source guard, .filo read guard, approved-sources) held under adversarial review. |
| Performance / resource | **7.5** | A17-5.3 read-back doubles per-write IO on large notes (L12); unbounded mutationVersions maps (documented decision, L13). |

---

## HIGH (3) — fix before dogfooding

### H1 — PropertiesPopup onDestroy cancels a PARKED gateway write after flushing → newest property edits silently dropped, reported as success
`src/renderer/components/tiles/PropertiesPopup.svelte` L439-458; `writeScheduler.ts` parked-fire path L514-560, cancel L596-605
- **Mechanism:** onDestroy runs fire-and-forget `flushIfPending()` then synchronous `cancelMarkdownWrite(flusherId)`. The cancel-is-idempotent comment is true for a pending timer but FALSE for a **parked** fire (debounce fired while a prior write was in IPC — Audit-13 H1 path). flush()'s synchronous prefix doesn't consume the parked entry; it suspends at `consumeInflight`. The same-tick cancel (Audit-16 4.4 extended cancel() to parked fires) marks it cancelled with a balanced `endWrite(true)`. The parked closure later bails — the freshest rows never write. flush resolves `ok:true` → popup-dirty cleared, history records an after-snapshot that never reached disk.
- **Trigger:** slow volume (OneDrive/SMB/AV): edit a property, keep editing while write 1 is in IPC, close the popup before write 1 completes.
- **Blast:** every edit after write 1 lost — no toast, no `markPathFailed`, no `.filo/.dirty`; undo history diverges from disk.
- **Fix sketch:** teardown cancel must not reach parked fires (a `pendingOnly` cancel mode for onDestroy), or await the flush and only cancel after, or skip the cancel when flushIfPending found anything armed.

### H2 — Corrupt/schema-invalid `.filo/tags.json` loads as an EMPTY registry with NO write gate → the vault open itself overwrites the recoverable file within ~300 ms
`src/renderer/lib/vault/tagsStorage.ts` L79-85/L122-127; `vault.svelte.ts` runPostCommitTasks ~L545-561; `fileTags.svelte.ts` scheduleSave gate L182-185
- **Mechanism:** Only `fromFuture`/`noMigrationPath` set tags read-only. JSON-parse failure and schema failure both return `emptyTagsFile()` with both flags false. Post-commit FM tag-seeding then calls `setAll(seed)` → `scheduleSave` → `tags:save` atomically replaces the corrupt-but-salvageable file with zero user action. No recovery snapshot is ever taken for tags.json (boards get one; tags don't). The toast copy "tags reset to empty for this session" is affirmatively misleading — the disk copy is destroyed.
- **Trigger:** tags.json corrupted by sync conflict/truncation/hand-edit; open the vault.
- **Blast:** all tag definitions/colors + every attachment fileTags entry (attachments have NO other home — documented vault-local design). Permanently unsalvageable after the overwrite.
- **Fix sketch:** treat parse/schema failure like from-future (`readOnlyCorrupt` gating scheduleSave until explicit "Discard corrupt tags file" opt-in), and/or `recovery:snapshot` tags.json before the first post-corrupt-load save.

### H3 — TextTile's embedded-content fallback after a non-ENOENT hydrate failure leaves the tile WRITABLE → first keystroke replaces the real on-disk file (body + FM) with a stale board-JSON seed
`src/renderer/components/tiles/TextTile.svelte` L333-367; gateway baseline skip `markdownFileWriter.ts` L609-612
- **Mechanism:** the unfixed TextTile twin of Audit-12 M1 (DocumentEditor). Non-ENOENT read failure (deterministic `FILE_TOO_LARGE` for >25 MB; transient EACCES/EBUSY from AV/sync) falls to the embedded seed: loads stale `tile.content`, seeds the FM cache from the stale parse, `markHydrated` with no mtime → **no drift baseline** → drift gate skipped; the Audit-10 H2 empty-cache rescue is defeated because the cache WAS seeded. `buildWriteArgs` only refuses on `backingFileMissing`/`!hydrated`, so the tile is writable and `vault:write-existing-file-text` succeeds.
- **Trigger:** text tile whose backing .md is >25 MB, or AV/OneDrive briefly holds a read lock at board open. Type one character.
- **Blast:** entire on-disk .md (body + YAML) replaced by the creation-time seed + keystroke. No prompt, no error, sentinel clean. The `ci:no-silent-write-abort` DOC_EDITOR_FILE arm pins only DocumentEditor.
- **Fix sketch:** mirror Audit-12 M1: `hydrateReadFailed` flag in the non-ENOENT catch, `buildWriteArgs` returns null while set (read-only + retry affordance); keep the embedded fallback for ENOENT only; extend the CI gate arm to TextTile.

---

## MEDIUM (7)

### M1 — Vault-swap toast teardown (and toast-cap eviction) fires onDismiss callbacks that DESTROY unacknowledged recovery breadcrumbs
`ui.svelte.ts` pre-swap L479-497, TOAST_CAP L360-376; `vault.svelte.ts` L701-703 / L733-735
The 6.1.R2 pre-swap "fire every onDismiss" change collides with two toasts whose onDismiss means "user acknowledged → destroy breadcrumb" (`clearQuitFailureBreadcrumb`, `markClean`). Pre-swap fires BEFORE the generation bump, so `isStillSameVault` passes and the destructive IPC lands on the outgoing vault — quit-failure.json (pointer to preserved unsaved bytes) deleted unread. Violates the Audit-8 L4 contract written in the toast's own comment. **Fix:** an `onSwapTeardown: 'skip'` flag for acknowledge-and-destroy toasts.

### M2 — refreshTreeAndCleanup's board-eviction stat probe races an IN-APP rename → live board evicted mid-session
`vault.svelte.ts` L1563-1592; `vaultFolderOps.ts` runRename L436 (cache rebind) vs L479/L517 (IPCs)
Cache is rebound to the NEW path before the sentinel-write + rename IPCs land, so for that window `boardStore.paths` names a file that doesn't exist on disk. A concurrently armed reconcile's Audit-16 3.6 `vault:file-exists` probe confirms "missing" and `cleanupMissingBoard` evicts the live board (tabs closed, pending writes cancelled, cascade flush skipped while the rename sentinel clears as success). **Fix:** re-read `paths[boardId]` after the probe + skip when a rename is in flight / path is pending.

### M3 — promptModifiedFile's Reload cancels gateway writers only in the NO-editor branch → dirty Properties popup over an open dirty editor re-applies discarded keys after Reload
`vaultExternalPrompts.ts` Reload handler L465-497 vs the A17-5.6(a) cancel loop L596-606
Classifier returns `editor-dirty` for body+FM external change over a dirty editor → promptModifiedFile, whose Reload has NO `getDirtyInstancesForPath` cancel loop. `applyReloadFromDisk` re-stamps the baseline, the popup's armed delta write passes the drift gate and reverts exactly the keys the user chose to discard. **Fix:** hoist the cancel loop so it runs on every Reload (no-op when nothing dirty).

### M4 — rollbackUndo/rollbackRedo blindly restore the pre-op stack snapshot → history corruption when a user action interleaves a later-rejecting async undo/redo body
`history.svelte.ts` L431/L459 (unconditional) vs rollbackExecute's #18 identity guard L396-398
Stack moves are synchronous; bodies queue (and can park minutes on a drift prompt). An interleaved Ctrl+Z / execute / pushWithoutExecute then a rejection → command on BOTH stacks (inverse applicable twice) or interleaved command erased (applied but un-undoable). Rejecting bodies are real (A17-1.4 rethrow). **Fix:** mirror the #18 array-identity guard symmetrically; on mismatch do a surgical single-command remove/re-insert.

### M5 — Config scheduler's ENOENT re-stat has no grace delay (board side got 150 ms in A17-2.3) → sync-client unlink→recreate blip drops the armed `.filo` config change as clean success
`configWriteScheduler.ts` L300-309/L394-395 vs `boardWriteScheduler.ts` L74/L305
The A17-2.3 parity went one way; the config twin (whose own comment claims it "mirrors writeBoardFile") still re-stats microseconds later. **Fix:** hoist `BOARD_ENOENT_RESTAT_DELAY_MS` and await it before the config re-stat.

### M6 (verifier-found) — promptMarkdownPendingWriteConflict's EDITOR branch also skips the gateway-writer cancel — same class as M3
`vaultExternalPrompts.ts` L586-606. The 5.6(a) cancel loop runs only in the else/no-editor branch of this prompt too. Same fix: hoist above the branch; promptModifiedFile needs the loop added (M3).

### M7 (verifier-found) — Bulk "Add tag" uses `window.prompt`, which Electron does not implement → the feature throws on every use
`kanbanMultiSelect.svelte.ts` L165. Multi-select Add-tag is dead in the packaged app (generic unhandled-rejection toast). The codebase already knows this — LinkInsertPopup's comment says it "Replaces window.prompt()". jsdom stubs prompt, so unit tests can't catch it. **Fix:** route through an in-app popup (LinkInsertPopup pattern) or `uiStore.openConfirm` with input.

---

## LOW (26)

Grouped; each is confirmed or partially-confirmed with a traced mechanism. (pc) = partially confirmed — real but narrower than first claimed.

**External-edit / baseline integrity**
1. Empty FM block `---\n---\n` parses as "no frontmatter" in both `parseMarkdownFile` and `tagRewriter.splitFrontmatter` → tag add prepends a SECOND FM block above the orphaned fences (`markdownSync.ts` L100). Fix: accept zero-interior form in the fence regex + corpus row.
2. `tagRewriter` trailing-blank-line handling: (a) fresh-tags-block insert steals the blank line owned by a trailing `notes: |+` keep-chomped scalar → silent VALUE change, parse-only validation passes (L606-623); (b) **verifier-found superset:** `splitFrontmatter`/`reassemble` collapse the FM's trailing blank line on EVERY successful tag edit incl. the fast path — fix belongs in splitFrontmatter/reassemble (re-emit the separator newlines), not just the insert site.
3. (pc) `frontmatterWriteScheduler` hydrate-failure fallback `markHydrated(relPath, false)` → BOM stripped, possible CRLF→LF FM flip, drift gate blind for that write (L341-350). Fix: fail loudly like the no-docState branch.
4. (pc) Single-tag fast path's unconditional post-write `refreshBaselineAfterWrite` launders an undetected external edit into the baseline → editor's next body save silently reverts it (`fileTags.svelte.ts` L272-332/L456-500). Fix: only refresh when pre-read stat matched the prior baseline.
5. `loadBoard` stamps the drift baseline from a stat taken AFTER the content read → foreign write in the read→stat gap becomes "our" baseline; next save clobbers it promptless (`boardLoader.ts` L386-404). Fix: stat-read-stat.
6. A17-5.3 read-back closes the same-size-foreign-write hole for markdown only — board/config kept the size-only check (`boardWriteScheduler.ts` / `configWriteScheduler.ts`). Fix: mirror 5.3.
7. (pc) Watcher reconcile suppression carry-forward (Audit-10 M3) protects modified paths only — an external DELETE inside a suppression window is permanently swallowed (`fileWatcher.ts` L544-596). Fix: carry forward `previous`-only keys too.
8. Attachment-delete grace window can't suppress a reconcile-synthesised rename; document-backed files get no grace — both prompt cascade-delete for a merely-moved file (`vaultExternalChanges.ts` L640-688). Fix: re-probe at click time.
9. Reload handler's A17-5.6(b) deletion early-return skips the write-cancel tail → armed write fires against a deleted file (`vaultExternalPrompts.ts`). Fix: run the cancel tail before the early return. (pc)
10. Post-commit `pruneOrphanFileTags` prunes against the LOAD-TIME candidate tree → tags added/moved during a long index rebuild dropped and the emptied registry persisted (`vault.svelte.ts` L519-532). Fix: prune against the live tree.
11. `deleteBoard` cancels pending/parked but never drains an IN-FLIGHT board:save → a write suspended on a drift prompt resurrects the deleted .board.json as a ghost board (`boardCache.svelte.ts` L743-767).

**Recovery / error honesty**
12. (pc) Esc / X / backdrop on the Recovery modal clears the `.filo/.dirty` sentinel + pending-paths (A17-3.3 over-reach; `AppShell.svelte`). Fix: only the explicit Dismiss button destroys; bypassed close re-queues.
13. Corrupt-config write suppression resolves as SUCCESS all session — user edits defaults/viewports for hours, all silently unsaved (`configWriteScheduler.ts` L259-264). Fix: once-per-target toast + non-success in the Ctrl+S aggregate.
14. (pc) Legacy recovery snapshots (bare basename) orphaned by the A17-3.8 flattened-name pruner (`recoverySnapshot.ts`). Fix: also match legacy basename.
15. Export save-dialog cancel returns the same `{success:false}` as a real write failure → spurious error toast (`export.ipc.ts` L86-88). Fix: `canceled: true` discriminator.
16. `vault:add-recent` overloads `[]` as both failure and empty list (`vault.ipc.ts` L835-853). Fix: typed envelope.
17. Bulk Kanban/Task-List ops show unconditional success toasts after swallowing command-chain rejections (`kanbanMultiSelect.svelte.ts`, `multiSelectController.svelte.ts`, `tasklist/frontmatterWriter.ts`). Fix: gate toast on the awaited outcome (6.2 pattern).

**Recent-change (Audit-17) regressions**
18. lastView persist $effect cleanup flush fires on EVERY effect re-run, structurally killing the 300 ms debounce — both `TaskListBoard.svelte` (~L1137-1171) and `KanbanBoard.svelte` (~L860-888) (A17-4.5 regression). Fix: flush only on real teardown/board change.
19. (pc) Teardown-time title commit (A17-4.1) renames the .md on disk with NO undo entry, fire-and-forget, racing the board switch (`TileHeader.svelte`). Fix: queue past the switch and push onto the tile's home-board stack.
20. (pc) `withDrainedWrites` sibling-parking (A17-3.4): a failing drain makes each queued sibling re-run a full drain serially (up to 60 s each); a parked sibling acts on moved-on state. Fix: cap failure-path recursion; re-validate inputs after park.
21. Markdown gateway A17-5.3 read-back doubles per-write IO inside the bounded window — multi-MB notes on slow volumes may hit timeout-then-self-heal flapping (`markdownFileWriter.ts`). Fix: size-gate the verify or hash main-side.

**Canvas / stores**
22. (pc) `tileDrag.ts` opens/closes spatial batches via the global facade → split-pane touch retarget can leak an open batch (frozen spatial revision) (L148/L206/L399/L449). Fix: thread BoardScope like Audit-12 M5 did for dragDrop.
23. `documentStore` mutationVersions/bodyMutationVersions grow unboundedly per docId until vault swap — documented decision, listed for completeness.
24. (pc) Properties undo/redo with no obtainable disk base falls back to index `content`/`''` as the file body — doubly-narrow corner (path absent from index + read-fail/write-succeed), but the blind branch's comment wrongly assumes read-failure implies write-failure (`propertiesCommands.ts` L193-246). Fix: refuse on read failure with no docState (B1 contract).
25–26. Two further narrow items folded into the groups above (fence/insert siblings and prompt-cancel siblings) — see the verifier notes in the raw output.

---

## Refuted by the adversarial reviewers (6)

1. **filtersAndViews.dispose() builds the flush slice at teardown time** — contract drift is textually real but no reachable trigger exists; hardening note only.
2. **Rename-cascade sentinel clear swallowed silently** — misattributed branch; the success-path clear DOES `reportError`. The bare catch is on a near-unreachable defensive branch.
3. **closeDrainGate blanket setEditable(true) reopens the 5.7 window** — the gate effect reads `hydrateReadFailed` reactively and immediately re-freezes; one-effect-flush window, no competing writer in TextTile.
4. **applyFrontmatterPatchRebased silent bails on swap** — history stacks are cleared on every vault swap, so no surviving stack can replay; siblings share the same silent-bail swap contract.
5. **Self-write watcher suppression swallows a genuine external edit for the session** — the 30 s hashing reconcile (Audit-10 M3 carry-forward) is a content-aware backstop; worst case ≈30 s staleness, by design. (But see LOW #7 for the DELETE-shaped gap that IS real.)
6. **DeleteTask/AddTask undo misroutes by stale absolute position** — impossible as described: undo is strictly LIFO per board stack, so the snapshot is valid by construction when reached. Residual staleness via external .board.json reload is inherent to all snapshot commands (covered by the M25 stale-history toast).

---

## Recommended pre-dogfooding fix set (smallest set that unblocks)

1. **H3** TextTile `hydrateReadFailed` guard + CI-gate arm extension (mirrors an existing fix — small).
2. **H1** PropertiesPopup teardown: pendingOnly cancel / await-flush-then-cancel (small).
3. **H2** tags.json corrupt-load write gate + recovery snapshot (small-medium).
4. **M3 + M6** hoist the Reload cancel loop (one shared helper, runs unconditionally) (small).
5. **M5** config ENOENT grace delay — hoist the existing constant (trivial).
6. **M7** replace `window.prompt` in bulk Add-tag (small; feature is currently dead).

M1, M2, M4 and the LOW set can follow during dogfooding; none is likely to fire on a local SSD vault that isn't simultaneously edited by other tools. If the vault will live on OneDrive/Dropbox, also prioritize L5/L6 (baseline holes) and M2.

**Raw verifier output** (full JSON, incl. per-dimension coverage notes listing exactly which files were read in full vs skipped): workflow run `wf_d3c62782-01c`, 2026-06-12.

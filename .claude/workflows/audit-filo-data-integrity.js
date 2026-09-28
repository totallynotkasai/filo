export const meta = {
  name: 'audit-filo-data-integrity',
  description: 'Brutal 9-agent adversarial audit of Filo data integrity, write paths, concurrency, lifecycle, error handling. Find issues prior audits missed.',
  whenToUse: 'When auditing the Filo codebase for production-readiness blockers before user dogfooding.',
  phases: [
    { title: 'Find', detail: '6 finders sweep distinct dimensions in parallel' },
    { title: 'Verify', detail: '3 adversarial reviewers refute or confirm each finding' },
  ],
}

const FINDING = {
  type: 'object',
  required: ['title', 'severity', 'confidence', 'category', 'file', 'mechanism', 'trigger', 'blast_radius', 'fix_sketch'],
  properties: {
    title: { type: 'string', description: 'One sentence — what is broken' },
    severity: { enum: ['critical', 'high', 'medium', 'low'] },
    confidence: { enum: ['traced-with-snippet', 'plausible-mechanism', 'speculative'] },
    category: { enum: ['data-loss', 'data-corruption', 'write-race', 'lifecycle-leak', 'silent-error', 'state-incoherence', 'undo-redo-bug', 'recovery-gap', 'other'] },
    file: { type: 'string', description: 'Repo-relative path. e.g., src/renderer/lib/notes/noteWriter.ts' },
    line_hint: { type: 'string', description: 'Line numbers or function name; "L123-L145" or "fn saveBeforeLeaving".' },
    mechanism: { type: 'string', description: '2-5 sentence walk-through. WHY the bug happens; cite the seam.' },
    trigger: { type: 'string', description: 'Concrete user action sequence that hits it. Be specific.' },
    blast_radius: { type: 'string', description: 'What data is lost/corrupted/wrong, recovery, reversibility.' },
    fix_sketch: { type: 'string', description: 'Smallest change that closes the seam. 1-3 sentences.' },
    introduced_by_uncommitted: { type: 'boolean', description: 'True if this was introduced by the change range under audit (the uncommitted working tree, or the recent commits the audit covers); false if it predates that range.' },
    not_already_in_audit2: { type: 'boolean', description: 'True if NOT already covered by a prior audit plan or report (docs/ for active, docs/archive/ for done). Be honest.' },
  },
}

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['dimension', 'findings', 'coverage_notes'],
  properties: {
    dimension: { type: 'string' },
    findings: { type: 'array', items: FINDING },
    coverage_notes: { type: 'string', description: 'What you read; what you skipped and why; gaps you saw but did not chase.' },
  },
}

const VERDICT = {
  type: 'object',
  required: ['title', 'verdict', 'reasoning'],
  properties: {
    title: { type: 'string', description: 'Echo of the finding title.' },
    verdict: { enum: ['confirmed', 'refuted', 'partially-confirmed', 'cannot-verify-without-running'] },
    reasoning: { type: 'string', description: '2-5 sentences. Cite code paths you read. Default to refuted=true if the mechanism does not hold.' },
    severity_after_review: { enum: ['critical', 'high', 'medium', 'low', 'non-issue'] },
    new_information: { type: 'string', description: 'Anything the finder missed: a complicating factor, a related bug, a stronger trigger.' },
  },
}

const VERDICTS_BATCH_SCHEMA = {
  type: 'object',
  required: ['verdicts'],
  properties: {
    verdicts: { type: 'array', items: VERDICT, description: 'One verdict per finding given to you, in the same order.' },
    related_findings_missed: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'severity', 'file', 'mechanism'],
        properties: {
          title: { type: 'string' },
          severity: { enum: ['critical', 'high', 'medium', 'low'] },
          file: { type: 'string' },
          mechanism: { type: 'string' },
        },
      },
      description: 'New bugs you stumbled across while verifying. Optional.',
    },
  },
}

const SHARED_CONTEXT = `
You are auditing Filo, an Electron + Svelte 5 + TS Markdown PKM app. The user is about to start dogfooding their real notes. Your job is to find data-integrity, concurrency, and silent-error bugs that previous audits MISSED.

Many earlier audits have been run and remediated; their plans and reports live in docs/ (active) and docs/archive/ (done). **Do NOT rate this codebase — find the things those audits missed.** Skim the latest report in docs/ so you don't re-file a known item. Be brutally critical. False positives are fine; false negatives are not.

Read CLAUDE.md first: it has the authoritative module tree, the write-path description ("The Vault API Contract", "Persistence Boundary", "Common Gotchas") and the list of CI gates. If this prompt and CLAUDE.md disagree, trust CLAUDE.md and the code.

Key paths:
- Note writer:      src/renderer/lib/notes/noteWriter.ts (THE only .md writer: one queue per path, fresh read per flush), reached via src/renderer/stores/notes.svelte.ts (noteStore: setBody, patchFrontmatter, transform, writeRaw, createUnique/createExclusive, hold, recreate, discardQueued)
- Note model:       src/renderer/lib/notes/noteFile.ts (pure parse/assemble, BOM, EOL, hash), noteDiskChange.ts (decideDiskChange), frontmatterFence.ts, rawViews.ts, renameGrace.ts; conflict prompts in src/renderer/stores/notePrompts.ts (Reload / Keep mine)
- Frontmatter:      src/renderer/lib/vault/frontmatterCstModel.ts (source-preserving CST patch), frontmatterDelta.ts, frontmatterRead.ts, frontmatterInverse (src/renderer/commands/frontmatterInverse.ts), tagRewriter.ts, tagRewriteSweep.ts; src/renderer/lib/editor/markdownSync.ts
- Board / config:   src/renderer/lib/boards/{writeScheduler,boardWriteScheduler,boardWriteDebounce,configWriteScheduler,miscWriteScheduler,configDrift,boardSaver,boardLoader,componentFlush,writeStateTracking}.ts; src/renderer/stores/boardCache.svelte.ts, boardDrift.ts
- Vault lifecycle:  src/renderer/stores/vault.svelte.ts, vaultLeaveGuard.ts, vaultExternalChanges.ts, vaultRenameQueue.ts, unsavedRescue.ts; src/renderer/lib/vault/{vaultOperations,vaultCandidate,externalChangeRegistry,fileBaselineRegistry,externalChangeWindows,keepLocalBackup,dirtyFlagRecovery,handleFlushAndQuit}.ts
- File watcher:     src/main/services/{fileWatcher,fileWatcherClassify,fileWatcherHash,fileWatcherWalk,watcherSuppression,renameCorrelation,recoverySnapshot}.ts
- Undo/redo:        src/renderer/stores/history.svelte.ts, src/renderer/commands/*.ts (commandPaths.ts for rename-following)
- IPC main:         src/main/ipc/*.ts, src/main/vault/{fileOps,boardFileOps,filenameUtils,exclusiveCreate,trashOps}.ts, src/main/utils/pathSecurity.ts

Conventions:
- Renderer never touches fs; everything is IPC through window.filo.
- Every .md write goes through the note writer (gate single-note-writer); each flush applies a change (FrontmatterDelta and/or body) to a fresh read, and the overwrite names the read's stat so main refuses it with STALE if the file changed.
- Body drift is a conflict (Reload / Keep mine, which backs up first); frontmatter-only drift is taken silently.
- Disk-shape ops (rename / trash / restore / create-folder / copy) go through vaultOperations.withDrainedWrites; deletes go to .filo/trash.
- Close, open-another-vault and quit save first (saveBeforeLeaving) and write rescue copies to .filo/recovery/<ts>-unsaved/ for anything left.
- Stores use Svelte 5 runes ($state, $derived, $effect, SvelteSet) in .svelte.ts files.
- 69 static checks in scripts/gates/*.mjs (run: node scripts/gates/run.mjs; list them with --list) ratchet many invariants. A gate proves only the pattern it greps for.

Anti-patterns to hunt:
- $effect that subscribes to something with no return-cleanup → memory leak across vault swaps.
- "await" missing on a write that should block downstream IO.
- Catch blocks that swallow + log only (no toast, no sentinel, no save-state failure) → silent failure.
- Snapshots taken AFTER the mutation begins instead of before → undo restores corrupted state.
- A flush / save-before-leaving path that doesn't await every writer (note writer + board + config + misc + tags + component flushes).
- Cache invalidation that races with a debounced write that's already armed.
- A code path that relies on "the note writer handles this" but reaches disk some other way, or builds a write from a cached whole file instead of a fresh read.

Output: structured per the schema. NO prose outside the schema. Your text is the return value.
`.trim()

phase('Find')

const dimensions = [
  {
    key: 'write-paths-core',
    label: 'find:write-paths-core',
    prompt: `${SHARED_CONTEXT}

Dimension: **Markdown write paths — note writer, note store, frontmatter engine, tag rewriter, atomicity.**

Read deeply:
- src/renderer/lib/notes/noteWriter.ts (the only .md writer — read the whole thing)
- src/renderer/stores/notes.svelte.ts (noteStore: NoteModel per path, base tracking, hold, conflict / drift handling)
- src/renderer/lib/notes/noteFile.ts (pure parse/assemble: frontmatter, body, BOM, EOL, content hash) and noteDiskChange.ts (what a watcher event does to a loaded note)
- src/renderer/lib/vault/frontmatterCstModel.ts (patchFrontmatterSourceCst — source-preserving patch on the yaml CST) and frontmatterDelta.ts
- src/renderer/lib/editor/markdownSync.ts (assembleMarkdownFile) and src/renderer/lib/editor/noteEditorView.ts (editor ↔ noteStore bridge)
- src/renderer/lib/vault/tagRewriter.ts (line-level fast path + CST-patch fallback) and tagRewriteSweep.ts
- src/main/vault/filenameUtils.ts (atomicWriteFile, tmpSiblingPath) and src/main/vault/exclusiveCreate.ts
- src/main/ipc/vault.ipc.ts (the write IPC handlers, incl. vault:write-existing-file-text and its STALE check)
- The CI gates: scripts/gates/writePath.mjs + scripts/gates/markdownFormat.mjs (single-note-writer, note-write-expects-stat, note-write-suppression, frontmatter-parse-preserved, eol-preservation, frontmatter-invariant, …)

Hunt for:
- A code path that writes markdown without going through the note writer, or an escape-hatch comment that hides a real bypass.
- Stale-copy writes: a change built at keystroke time that lands on a file another program changed between the fresh read and the rename (the STALE check window, coarse FAT/SMB timestamps, files over the byte-compare size).
- Base tracking: a body write whose NoteModel.base is wrong (after a reload, a rewrite, a rename, Keep mine) so a real conflict is written over, or a phantom conflict is raised.
- atomicWriteFile failure modes: rename failure mid-fsync, Windows lock backoff, temp left behind — is the renderer told, and is the queued change kept for Retry?
- CRLF / BOM handling: does every path (frontmatter delta, tag rewrite, body write, raw view write) keep the BOM and line endings?
- frontmatterCstModel: !!tag custom types, anchors / aliases, multi-document streams (---\\n...\\n---\\n...), flow maps, comments next to a changed key — which edge cases fall back to a full re-dump and lose bytes?
- Own-write echo detection by content hash: can a genuine external change be mistaken for our echo (or vice versa)?

Report findings per schema.`,
  },
  {
    key: 'write-paths-board',
    label: 'find:write-paths-board',
    prompt: `${SHARED_CONTEXT}

Dimension: **Board / config / misc write paths — schedulers, persist*, drift baselines, snapshot discipline, undo/redo.**

Read deeply:
- src/renderer/lib/boards/writeScheduler.ts (createScheduler: the shared debounce/retry/timeout primitive)
- src/renderer/lib/boards/boardWriteScheduler.ts, boardWriteDebounce.ts
- src/renderer/lib/boards/configWriteScheduler.ts and configDrift.ts (a .filo/ config changed or deleted outside Filo)
- src/renderer/lib/boards/miscWriteScheduler.ts
- src/renderer/lib/boards/boardLoader.ts and boardSaver.ts
- src/renderer/stores/boardCache.svelte.ts (and boardCacheTiles/Kanban/TaskList/ConnectionsFrames/Frontmatter/Delete.ts)
- src/renderer/stores/boardDrift.ts (one drift prompt per board path: Reload / Keep local) and src/renderer/lib/vault/keepLocalBackup.ts
- src/renderer/lib/vault/fileBaselineRegistry.ts (baselineSeq / noteBaseline ifUnchangedSince — baselines only move forward)
- src/renderer/stores/history.svelte.ts (per-board undo/redo, rename sweep)
- src/renderer/commands/*.ts — read at least Command.ts, commandPaths.ts, frontmatterInverse.ts, noteFieldCommand.ts, tileCommands.ts, kanbanCommands.ts, taskCommands.ts, groupAndBoardCommands.ts, styleCommands.ts, replaceAllCommand.ts
- The CI gates: scripts/gates/commands.mjs (direct-board-mutations, command-snapshot-discipline, commands-target-board, command-roundtrip-coverage, commands-follow-renames, no-note-body-in-commands, …) and scripts/gates/writePath.mjs (baseline-stamp-forward-only, keep-local-backup)

Hunt for:
- Commands that mutate state without snapshotting first (or after the mutation — corrupted undo).
- Snapshot scope too narrow: snapshot covers the tile but not the placement, so undo desyncs.
- BatchCommand: what if one inner command throws mid-execute? Is the partial state rolled back?
- targetBoardId discipline: any command that reads the active board to know where to write?
- Undo of a frontmatter change: the inverse FrontmatterDelta via applyDeltaChecked — same-key conflict detection, NoteGoneError, ChangeRefusedError; can undo write over a newer value?
- Drift baselines: a reader's older stat replacing a newer self-write stamp, or a new board's create not counted as Filo's own write, so the next save sees its own write as external.
- Board drift: Reload cancels the queued write and clears undo history — can a queued write or an undo step still land the replaced version?
- configDrift: deleted config recreated with createOnly — can a copy put back meanwhile be overwritten? Reload / Keep local on app.json / defaults.json / appearance.json.
- boardLoader → boardCache hydrate: is there a window where the cache is hydrated but broken-reference tracking or rename rewrites aren't applied yet?

Report findings per schema.`,
  },
  {
    key: 'concurrency-vault',
    label: 'find:concurrency-vault',
    prompt: `${SHARED_CONTEXT}

Dimension: **Vault lifecycle, file watcher, external-edit reconciliation, rename correlation, dirty sentinel, leave-and-rescue.**

Read deeply:
- src/renderer/stores/vault.svelte.ts (the vault open / swap orchestrator) and src/renderer/lib/vault/vaultCandidate.ts (open as a transaction)
- src/renderer/stores/vaultLeaveGuard.ts (saveBeforeLeaving / saveUntilSettled, leftBehind) and src/renderer/lib/editor/closeDrainGate.svelte.ts
- src/renderer/stores/unsavedRescue.ts (rescue copies) and src/renderer/lib/vault/handleFlushAndQuit.ts
- src/renderer/stores/vaultExternalChanges.ts, vaultExternalReconcilers.ts, vaultRenameQueue.ts; src/renderer/lib/vault/externalChangeRegistry.ts
- src/renderer/core/vaultLifecycle.ts (onVaultSwap registry)
- src/renderer/stores/notePrompts.ts (note Reload / Keep mine, deleted-note prompt) and src/renderer/lib/notes/renameGrace.ts (askUnlessMoved)
- src/renderer/lib/vault/dirtyFlagRecovery.ts, externalChangeWindows.ts, fileBaselineRegistry.ts
- src/renderer/lib/vault/renameCascadeSentinel.ts, tagRewriteSentinel.ts
- src/main/services/fileWatcher.ts, fileWatcherTypes.ts, fileWatcherClassify.ts, fileWatcherWalk.ts, watcherSuppression.ts, watcherSupervisor.ts
- src/main/services/renameCorrelation.ts and fileWatcherHash.ts (content hash with a size ceiling)
- src/main/services/recoverySnapshot.ts
- src/renderer/stores/vaultRecovery.ts

Hunt for:
- onVaultSwap hooks: any subscriber that doesn't clean up timers or queues of the OLD vault before the NEW one mounts? Does every async reader re-check isStillSameVault after an await?
- File watcher: are events from the old vault dropped before the new vault attaches? Race: vault A swap to B, an in-flight A event or queued reconcile lands during B's bootstrap.
- Leaving a vault: can saveBeforeLeaving report "nothing unsaved" while a component flush, raw view text or an un-serialised editor keystroke still holds work? Can a rescue copy miss something that then gets dropped?
- Dirty sentinel (.filo/.dirty.<machineId>): set before writes and kept when work is left behind — does any path clear it too early, or skip it?
- Rename correlation: the content-hash pairing — what about EMPTY files (hash matches by coincidence)? Files larger than the hash ceiling? A missing .md held MISSING_NOTE_HOLD_MS with no partner?
- Echo suppression: suppressWrite only hides our own bytes — can another program's save, rename or delete inside the window still be swallowed?
- External frontmatter-only edit while the body is unsaved: is it merged on every path, including a flush from tab close and the quit drain?
- Index rebuild during vault swap: is there a window where the renderer queries the vault index mid-rebuild?
- Recovery snapshots: when is .filo/recovery/ written and pruned? Can a prune remove something the user still needs?

Report findings per schema.`,
  },
  {
    key: 'concurrency-stores',
    label: 'find:concurrency-stores',
    prompt: `${SHARED_CONTEXT}

Dimension: **Svelte 5 rune store lifecycle — $effect cleanup, dispose chains, stale closures, debounce-on-unmount, SvelteSet leaks.**

Read deeply:
- All src/renderer/stores/*.svelte.ts files. Pay extra attention to:
  - vault.svelte.ts, vaultIndex.svelte.ts, notes.svelte.ts, vaultExternalChanges.ts
  - boardCache.svelte.ts, board.svelte.ts, boardConnections.ts, boardFrames.ts, boardTiles.ts
  - history.svelte.ts, tabs.svelte.ts, workspace.svelte.ts
  - fileTags.svelte.ts, tagUndo.svelte.ts, templates.svelte.ts, trash.svelte.ts
  - canvas.svelte.ts, selection.svelte.ts, spatial.svelte.ts, saveState.svelte.ts
- src/renderer/lib/boards/componentFlush.ts (registerComponentFlush) and writeStateTracking.ts (unsavedWork)
- src/renderer/lib/tasklist/filtersAndViews.svelte.ts and src/renderer/lib/kanban/kanbanFiltersAndSort.svelte.ts (debounced view persistence)
- Components that own timers or save on teardown:
  - src/renderer/components/boards/TaskListBoard.svelte, KanbanBoard.svelte
  - src/renderer/components/boards/DocumentEditor.svelte, NoteRawView.svelte
  - src/renderer/components/tiles/TimerTile.svelte (with src/renderer/lib/utils/timerCountdown.ts — a running timer is its wall-clock endsAt)
- The reactive scheduler: how vault swap resets stores; vaultLifecycle hooks.

Hunt for:
- $effect that subscribes to a long-lived store (vault index, note store, fileTags) without a return cleanup → leak per vault swap.
- $effect with a stale closure on a variable that should be reactive but is captured at $effect.root creation.
- A setTimeout/setInterval that's not cleared on store reset / component unmount / vault swap.
- A component that saves on teardown but whose save isn't registered with registerComponentFlush, so a leave cancels it (gate teardown-saves-registered only sees the pattern it greps for).
- An onDestroy that doesn't actually run (e.g. on workspace pane teardown vs Svelte component unmount).
- A SvelteSet/SvelteMap that's repopulated on every vault swap but never cleared, so old entries linger.
- A debounce-on-unmount race: component unmounts mid-debounce; the timer fires after unmount and writes a stale value (or into the next vault).
- A "this store is a singleton" assumption that breaks when a second vault is opened in the same process.
- One note open in several views: any view keeping its own copy of a note instead of reading the NoteModel (gate views-read-note-store)?

Report findings per schema.`,
  },
  {
    key: 'errors-and-recovery',
    label: 'find:errors-and-recovery',
    prompt: `${SHARED_CONTEXT}

Dimension: **Silent errors, swallowed promises, IPC envelope, recovery sentinels, save-state honesty.**

Read deeply:
- src/renderer/lib/utils/errorBus.ts, errorToastAggregator.ts, invokeOk.ts
- src/renderer/stores/saveState.svelte.ts, saveStateFeed.ts, heldDecisions.ts (saved / saving / failed / waiting-for-a-decision indicator)
- src/renderer/lib/boards/writeStateTracking.ts (unsavedWork) and componentWriteRetry.ts
- src/shared/ipcEnvelope.ts (ok/error envelope), src/main/ipc/ipcErrorCode.ts (errorEnvelope / errorResult)
- src/shared/ipcSchemas.ts, ipcContracts.ts, untrusted.ts
- src/main/utils/mainLogger.ts
- src/renderer/lib/vault/dirtyFlagRecovery.ts (sentinel contract) and src/renderer/stores/vaultRecovery.ts (recovery modal)
- Recovery: src/renderer/lib/vault/tagRewriteSentinel.ts, renameCascadeSentinel.ts, src/main/services/recoverySnapshot.ts, emergencyFileRegistry.ts, quitFailureBreadcrumb.ts, src/main/ipc/recovery.ipc.ts, src/renderer/stores/unsavedRescue.ts
- Leave / quit: src/renderer/stores/vaultLeaveGuard.ts, src/renderer/lib/vault/handleFlushAndQuit.ts, src/renderer/lib/vault/unsavedMessages.ts
- Tab close paths: src/renderer/stores/tabs.svelte.ts, src/renderer/components/layout/Tab.svelte
- src/renderer/lib/vault/vaultOperations.ts (withDrainedWrites, scoped drain, the disk-shape IPCs) and src/main/vault/trashOps.ts

Hunt for:
- catch (e) { logger.error(...); } with no toast, no rethrow, no sentinel → user has no idea something failed.
- An IPC handler that returns an ok envelope but actually partially failed, or a write handler failure without a code (gate ipc-errors-carry-code).
- A write path where the failure mode would leave the user thinking it saved (save indicator shows Saved while a write failed, is held for a decision, or is still queued).
- A failed write that isn't kept for Retry, or a Retry that re-fires a stale change.
- "drain all writers before doing X" pattern: any X that needs to drain but doesn't, or a scoped drain whose paths miss a parent/child it touches.
- App quit: is every writer flushed, including component flushes and raw views? Are rescue copies written when something is left, and does the dialog name it?
- atomicWriteFile failure: ENOSPC / locked file preserves the temp — does the renderer know? Does the user get told where the data is?
- A try/catch around a Promise.all that swallows individual rejections.
- A throw inside a $effect — Svelte may not surface it; does the UI report it?
- A debounced batch error: the timer fires, throws inside async, error is lost in the void.
- Trash: a restore or purge that fails halfway, or a manifest that no longer matches the files.

Report findings per schema.`,
  },
  {
    key: 'uncommitted-diff',
    label: 'find:uncommitted-diff',
    prompt: `${SHARED_CONTEXT}

Dimension: **What did the most recent changes introduce or regress?**

Work out the change range yourself — do not assume a list:
1. \`git status --short\` and \`git diff HEAD --stat\` for uncommitted work.
2. \`git log --oneline -20\` for recent commits; commit subjects name the audit phase each one remediates. Take the commits since the last audit report in docs/ (or, if none is obvious, the last ~10 commits) as the range under audit.
3. \`git diff <base>..HEAD --stat\` then \`git diff <base>..HEAD -- <path>\` (plus \`git diff HEAD -- <path>\` for the working tree) for each file that touches a write path, the vault lifecycle, the watcher, undo/redo, IPC, or a gate in scripts/gates/.
4. Read the matching plan in docs/ to learn what each change was meant to fix, then check it actually does.

Hunt for:
- A removed or renamed function / module still referenced from a caller the gates don't see (grep src/ for the old name outside tests).
- Filename / path hardening (src/main/utils/pathSecurity.ts, src/shared/fileNames.ts) that now blocks a name users already have on disk, turning a rename or save into a failure or a data-loss path.
- A new guard or early return that silently drops a write the user expected to land (config, board, note, tags).
- A new dispose / cleanup path that was added but is not called from the only caller, leaving the original leak.
- A reordering in the vault open / leave sequence (vault.svelte.ts, vaultLeaveGuard.ts, vaultCandidate.ts) that lets a reconcile or write run against the wrong vault or before the index is ready.
- A flush that was removed as "duplicate" but some path depended on it.
- A test that was modified because the assertion was loosened to make the new behavior pass (verify it still meaningfully tests the bug it was written for).
- A gate in scripts/gates/*.mjs that was added or changed: does it have an escape hatch the prod code now uses, or a pattern so narrow the real violation slips past?

For each finding, set introduced_by_uncommitted=true if the range under audit introduced it. Be ruthless — these changes are LATE in a remediation cycle and the project is about to be used.

Report findings per schema.`,
  },
]

const allFinds = await parallel(
  dimensions.map(d => () =>
    agent(d.prompt, { label: d.label, phase: 'Find', schema: FINDINGS_SCHEMA }),
  ),
)

const findingsByDim = {}
const flatFindings = []
for (let i = 0; i < dimensions.length; i++) {
  const result = allFinds[i]
  if (!result) {
    log(`Finder ${dimensions[i].key} failed/skipped`)
    continue
  }
  findingsByDim[dimensions[i].key] = result
  for (const f of result.findings || []) {
    flatFindings.push({ ...f, _from: dimensions[i].key })
  }
}

log(`Found ${flatFindings.length} candidate issues across ${Object.keys(findingsByDim).length} dimensions; entering verification.`)

phase('Verify')

const VERIFY_PROMPT_HEAD = `${SHARED_CONTEXT}

You are an adversarial reviewer. The previous finder claims a bug exists. **Default to refuted=true** unless you can trace the mechanism end-to-end in the current code. Read the cited file. Then read the surrounding code that affects the claim (callers, the schedulers / locks / guards that should defend against it).

Refute if:
- The mechanism does not hold in the actual code (e.g. the guard the finder missed exists at L NN).
- The trigger requires conditions that cannot actually occur.
- The blast radius is overstated (e.g. "data loss" but the recovery sentinel covers it).

Confirm only if:
- You can point to the exact lines that produce the bug, AND
- You can describe a concrete repro the user could run today, AND
- The defenses you'd expect to catch this are absent.

Use partially-confirmed when the bug is real but lower severity than claimed, or the trigger is narrower.

Use cannot-verify-without-running ONLY when the answer truly requires an Electron run (almost never — most claims are testable by reading).
`.trim()

// Pair findings into 3 verifier groups: write-paths-A+B (verifier 1), concurrency-A+B (verifier 2), errors+uncommitted (verifier 3).
const verifierGroups = [
  { key: 'verify:write-paths', dims: ['write-paths-core', 'write-paths-board'] },
  { key: 'verify:concurrency', dims: ['concurrency-vault', 'concurrency-stores'] },
  { key: 'verify:errors-and-uncommitted', dims: ['errors-and-recovery', 'uncommitted-diff'] },
]

const verdictsByGroup = {}
const relatedFindingsFromVerifiers = []

await parallel(
  verifierGroups.map(g => () => (async () => {
    const items = flatFindings.filter(f => g.dims.includes(f._from))
    if (items.length === 0) {
      verdictsByGroup[g.key] = []
      return
    }
    const findingsBlock = items.map((f, idx) => `
--- FINDING #${idx + 1} of ${items.length} ---
Title: ${f.title}
Severity claimed: ${f.severity}
Confidence claimed: ${f.confidence}
Category: ${f.category}
File: ${f.file}
Lines: ${f.line_hint || '(unspecified)'}
Mechanism (finder's words): ${f.mechanism}
Trigger: ${f.trigger}
Blast radius: ${f.blast_radius}
Fix sketch: ${f.fix_sketch}
Introduced by the change range under audit? ${f.introduced_by_uncommitted ? 'yes' : 'no'}
Not in a prior audit plan? ${f.not_already_in_audit2 ? 'yes' : 'no'}
`).join('\n')

    const result = await agent(
      `${VERIFY_PROMPT_HEAD}

You are reviewing ${items.length} findings as a BATCH. For each, read the cited file and surrounding code, then return a verdict. Be skeptical — refute by default. If you stumble across an UNRELATED bug while reading, add it to related_findings_missed.

Findings:
${findingsBlock}

Return verdicts in the SAME ORDER as the findings (#1 first, #${items.length} last).`,
      { label: g.key, phase: 'Verify', schema: VERDICTS_BATCH_SCHEMA },
    )
    const verdicts = result?.verdicts || []
    verdictsByGroup[g.key] = verdicts.map((v, idx) => ({ ...(v || {}), original: items[idx] }))
    for (const r of result?.related_findings_missed || []) {
      relatedFindingsFromVerifiers.push({ ...r, _from_verifier: g.key })
    }
  })()),
)

// Final shape: only the survived findings, with the verdict attached.
const allVerdicts = Object.values(verdictsByGroup).flat()
const confirmed = allVerdicts.filter(v => v.verdict === 'confirmed' || v.verdict === 'partially-confirmed')
const refuted = allVerdicts.filter(v => v.verdict === 'refuted')
const unverified = allVerdicts.filter(v => v.verdict === 'cannot-verify-without-running')

log(`Verified: ${confirmed.length} confirmed/partial, ${refuted.length} refuted, ${unverified.length} cannot-verify.`)

return {
  summary: {
    candidates_found: flatFindings.length,
    confirmed: confirmed.length,
    partially_confirmed: allVerdicts.filter(v => v.verdict === 'partially-confirmed').length,
    refuted: refuted.length,
    unverified: unverified.length,
    related_findings_from_verifiers: relatedFindingsFromVerifiers.length,
  },
  coverage_notes: Object.fromEntries(Object.entries(findingsByDim).map(([k, v]) => [k, v.coverage_notes])),
  confirmed_findings: confirmed.sort((a, b) => {
    const order = { critical: 0, high: 1, medium: 2, low: 3, 'non-issue': 4 }
    return (order[a.severity_after_review] ?? 5) - (order[b.severity_after_review] ?? 5)
  }),
  refuted_findings: refuted.map(v => ({
    title: v.title,
    reasoning: v.reasoning,
    severity_claimed: v.original?.severity,
    file: v.original?.file,
  })),
  unverified_findings: unverified,
  related_findings_from_verifiers: relatedFindingsFromVerifiers,
}

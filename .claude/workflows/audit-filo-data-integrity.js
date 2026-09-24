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
    file: { type: 'string', description: 'Repo-relative path. e.g., src/renderer/lib/vault/markdownFileWriter.ts' },
    line_hint: { type: 'string', description: 'Line numbers or function name; "L123-L145" or "fn flushMarkdownWritesForTab".' },
    mechanism: { type: 'string', description: '2-5 sentence walk-through. WHY the bug happens; cite the seam.' },
    trigger: { type: 'string', description: 'Concrete user action sequence that hits it. Be specific.' },
    blast_radius: { type: 'string', description: 'What data is lost/corrupted/wrong, recovery, reversibility.' },
    fix_sketch: { type: 'string', description: 'Smallest change that closes the seam. 1-3 sentences.' },
    introduced_by_uncommitted: { type: 'boolean', description: 'True if this exists ONLY in the working tree (Phase-5 changes), false if also at HEAD.' },
    not_already_in_audit2: { type: 'boolean', description: 'True if NOT covered by the AUDIT2 plan items 1.1-5.10. Be honest.' },
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

A previous "Codex" audit rated the system 8/9 across the board. A more recent self-audit (AUDIT2 plan, untracked at repo root) found 30 items and reports all fixed. **Do NOT rate this codebase — find the things both audits missed.** Be brutally critical. False positives are fine; false negatives are not.

Key paths:
- Write gateway:    src/renderer/lib/vault/markdownFileWriter.ts
- Frontmatter:      src/renderer/lib/vault/frontmatterEngine.ts, lib/editor/markdownSync.ts, lib/vault/tagRewriter.ts
- Board write:      src/renderer/lib/boards/{boardWriteScheduler,configWriteScheduler,miscWriteScheduler,frontmatterWriteScheduler,boardSaver,boardLoader}.ts
- Vault lifecycle:  src/renderer/stores/vault.svelte.ts, vaultExternalChanges.ts; lib/vault/conflictResolver.ts, fileBaselineRegistry.ts, externalChangeWindows.ts, dirtyFlagRecovery.ts
- File watcher:     src/main/services/{fileWatcher,renameCorrelation,recoverySnapshot}.ts
- Undo/redo:        src/renderer/stores/history.svelte.ts, commands/*.ts
- IPC main:         src/main/ipc/*.ts, vault/{fileOps,boardFileOps,filenameUtils}.ts, utils/pathSecurity.ts

Conventions:
- Renderer never touches fs; everything is IPC.
- Markdown writes ALL go through markdownFileWriter (the CI gate enforces this).
- Stores use Svelte 5 runes ($state, $derived, $effect, SvelteSet) in .svelte.ts files.
- ~53 static checks in scripts/gates (npm run ci:gates; list them with: node scripts/gates/run.mjs --list) ratchet many invariants.

Anti-patterns to hunt:
- $effect that subscribes to something with no return-cleanup → memory leak across vault swaps.
- "await" missing on a write that should block downstream IO.
- Catch blocks that swallow + log only (no toast, no sentinel) → silent failure.
- Snapshots taken AFTER the mutation begins instead of before → undo restores corrupted state.
- A flush-on-X path that doesn't await all queues (markdown + board + config + frontmatter + tags).
- Cache invalidation that races with a debounced write that's already armed.
- A code path that says "the gateway handles this" but is being called from a context that bypasses the gateway.

Output: structured per the schema. NO prose outside the schema. Your text is the return value.
`.trim()

phase('Find')

const dimensions = [
  {
    key: 'write-paths-core',
    label: 'find:write-paths-core',
    prompt: `${SHARED_CONTEXT}

Dimension: **Markdown write paths — gateway, frontmatter engine, tag rewriter, atomicity.**

Read deeply:
- src/renderer/lib/vault/markdownFileWriter.ts (the canonical gateway, ~822 LOC — read the whole thing)
- src/renderer/lib/vault/frontmatterEngine.ts (NEW in Audit2 4.8 — source-preserving Document API)
- src/renderer/lib/editor/markdownSync.ts (parseMarkdownFile + assembleMarkdownFile — the seam where rawFrontmatter is captured/replayed)
- src/renderer/lib/vault/tagRewriter.ts (line-level fast path + dump fallback)
- src/main/vault/filenameUtils.ts (atomicWriteFile — open→write→fsync→close→rename→fsync(dir))
- src/main/ipc/vault.ipc.ts (the write IPC handlers)
- The CI gates: scripts/gates/writePath.mjs + markdownFormat.mjs (markdown-gateway, markdown-read-gateway, frontmatter-invariant, no-prod-md-test-flushers, …)

Hunt for:
- A code path that writes markdown without going through scheduleMarkdownWrite/forceWrite*.
- Stale-cache races: a write that captured frontmatter at keystroke time and fires AFTER an external sync-frontmatter event.
- atomicWriteFile failure modes: what happens on rename failure mid-fsync? Are partial writes rolled back? Is the recovery snapshot consistent?
- CRLF / BOM handling: BOM-preserving hydrate — does it survive every code path (frontmatter rewrite, tag rewrite, body rewrite)?
- frontmatterEngine: what happens when the YAML Document has !!tag custom types, anchors, aliases, multi-document streams (---\\n...\\n---\\n...)? Source-preserving patcher edge cases.
- The "live frontmatter at fire time" fix (2.5) — is the rebase ACTUALLY atomic, or is there a TOCTOU between the read and the write?
- markdownSync rawFrontmatter passthrough (1.2): what if the document was opened, frontmatter was edited via tags/properties, then a body-only save fires? Is rawFrontmatter invalidated correctly?

Report findings per schema.`,
  },
  {
    key: 'write-paths-board',
    label: 'find:write-paths-board',
    prompt: `${SHARED_CONTEXT}

Dimension: **Board / config / frontmatter write paths — schedulers, persist*, snapshot discipline, undo/redo.**

Read deeply:
- src/renderer/lib/boards/boardWriteScheduler.ts
- src/renderer/lib/boards/configWriteScheduler.ts (modified in Phase 5.1 — resurrection guard)
- src/renderer/lib/boards/miscWriteScheduler.ts
- src/renderer/lib/boards/frontmatterWriteScheduler.ts
- src/renderer/lib/boards/boardWriteDebounce.ts
- src/renderer/lib/boards/boardLoader.ts and boardSaver.ts
- src/renderer/stores/boardCache.svelte.ts (and boardCacheTiles/Kanban/TaskList/ConnectionsFrames/Frontmatter.ts)
- src/renderer/stores/history.svelte.ts (per-board undo/redo, snapshot fan-out)
- src/renderer/commands/*.ts — read at least Command.ts, tileCommands.ts, kanbanCommands.ts, taskCommands.ts, groupAndBoardCommands.ts, styleCommands.ts
- The CI gates: scripts/gates/commands.mjs (direct-board-mutations, command-snapshot-discipline, commands-target-board, command-roundtrip-coverage, …)

Hunt for:
- Commands that mutate state without snapshotting first (or after the mutation — corrupted undo).
- Snapshot scope too narrow: snapshot covers tile but not the placement, so undo desyncs.
- BatchCommand: what if one inner command throws mid-execute? Is the partial state rolled back?
- targetBoardId discipline: any command that reads boardStore.current to know where to write? (The 2.4 fix.)
- configWriteScheduler resurrection guard (5.1): does the ENOENT skip handle the "delete-then-immediately-recreate" race?
- frontmatter scheduler: who owns frontmatter writes? Tag mutation, properties popup, AND undo of a property command — three writers. Lock?
- boardLoader → boardCache hydrate: is there a window where the cache is hydrated but tile defs not yet reconciled against frontmatter?
- 5.3 reconcile loop in vault.svelte.ts runPostCommitTasks: does it run in correct order with the index rebuild? Does it fire on every vault swap?

Report findings per schema.`,
  },
  {
    key: 'concurrency-vault',
    label: 'find:concurrency-vault',
    prompt: `${SHARED_CONTEXT}

Dimension: **Vault lifecycle, file watcher, external-edit reconciliation, rename correlation, dirty sentinel.**

Read deeply:
- src/renderer/stores/vault.svelte.ts (~1400 LOC — the vault swap orchestrator)
- src/renderer/stores/vaultExternalChanges.ts (~1500 LOC — external-edit classifier and drift prompt)
- src/renderer/core/vaultLifecycle.ts (onVaultSwap registry)
- src/renderer/lib/vault/conflictResolver.ts
- src/renderer/lib/vault/dirtyFlagRecovery.ts
- src/renderer/lib/vault/externalChangeWindows.ts
- src/renderer/lib/vault/fileBaselineRegistry.ts
- src/renderer/lib/vault/renameCascadeSentinel.ts, tagRewriteSentinel.ts
- src/main/services/fileWatcher.ts, fileWatcherTypes.ts
- src/main/services/renameCorrelation.ts (Audit2 2.1 same-basename gate)
- src/main/services/recoverySnapshot.ts
- src/renderer/stores/vaultRecovery.ts

Hunt for:
- onVaultSwap hooks: any subscriber that doesn't clean up timers on the OLD vault before the NEW one mounts?
- File watcher: are events from the old vault drained before the new vault attaches? Race: vault A swap to B, in-flight A event lands during B's bootstrap.
- Dirty sentinel: every write path SHOULD write .filo/.dirty before disk write, clear after. Does any path skip it? (Markdown body write was 2.3, supposedly fixed — verify.)
- Rename correlation: the same-basename content-hash gate (2.1) — what about EMPTY files (hash matches by coincidence)? What about files larger than the hash budget?
- Conflict resolver: classifier categories (sync-frontmatter, conflict, ignore-self, etc.). Are there interleavings where the classifier picks the wrong category?
- External FM-only edit while body is dirty (2.5 fix): does it cover ALL fire paths, including forceWriteForDocument from tab close?
- Index rebuild during vault swap: is there a window where the renderer queries vaultIndexStore mid-rebuild?
- Recovery snapshot: when does .filo/recovery/ get written and reaped? Any orphaned snapshots after crash?

Report findings per schema.`,
  },
  {
    key: 'concurrency-stores',
    label: 'find:concurrency-stores',
    prompt: `${SHARED_CONTEXT}

Dimension: **Svelte 5 rune store lifecycle — $effect cleanup, dispose chains, stale closures, debounce-on-unmount, SvelteSet leaks.**

Read deeply:
- All src/renderer/stores/*.svelte.ts files. Pay extra attention to:
  - vault.svelte.ts, vaultIndex.svelte.ts, vaultExternalChanges.ts
  - boardCache.svelte.ts, board.svelte.ts, boardConnections.ts, boardFrames.ts, boardTiles.ts
  - history.svelte.ts, tabs.svelte.ts, workspace.svelte.ts
  - fileTags.svelte.ts (Phase 5 modified), templates.svelte.ts
  - canvas.svelte.ts, selection.svelte.ts, spatial.svelte.ts
- src/renderer/lib/tasklist/filtersAndViews.svelte.ts (5.6 modified — dispose path)
- Components that own timers:
  - src/renderer/components/boards/TaskListBoard.svelte (5.6 — lastViewPersistTimer)
  - src/renderer/components/tiles/TimerTile.svelte (4.1 — counts down in component state)
- The reactive scheduler: how vault swap resets stores; vaultLifecycle hooks.

Hunt for:
- $effect that subscribes to a long-lived store (vaultIndex, fileTags) without a return cleanup → leak per vault swap.
- $effect with a stale closure on a variable that should be reactive but is captured at $effect.root creation.
- A setTimeout/setInterval that's not cleared on store reset / component unmount / vault swap.
- An onDestroy that doesn't actually run (e.g. on workspace pane teardown vs Svelte component unmount).
- A SvelteSet/SvelteMap that's repopulated on every vault swap but never cleared, so old entries linger.
- A debounce-on-unmount race: component unmounts mid-debounce; the timer fires after unmount and writes a stale value.
- A "this store is a singleton" assumption that breaks when a second vault is opened in the same process.
- 5.6 fix in filtersAndViews — does it actually dispose all timers, or only some? Does TaskListBoard call filters.dispose() in onDestroy?

Report findings per schema.`,
  },
  {
    key: 'errors-and-recovery',
    label: 'find:errors-and-recovery',
    prompt: `${SHARED_CONTEXT}

Dimension: **Silent errors, swallowed promises, IPC envelope, recovery sentinels, save-state honesty.**

Read deeply:
- src/renderer/lib/utils/errorBus.ts, errorToastAggregator.ts
- src/renderer/stores/saveState.svelte.ts (idle/saving/saved/error indicator)
- src/shared/ipcEnvelope.ts (ok/error envelope)
- src/shared/ipcSchemas.ts, ipcContracts.ts
- src/main/utils/mainLogger.ts
- src/renderer/lib/vault/dirtyFlagRecovery.ts (sentinel contract)
- src/renderer/stores/vaultRecovery.ts (.filo/.dirty recovery modal)
- Recovery sentinels: tagRewriteSentinel.ts, renameCascadeSentinel.ts, recoverySnapshot.ts
- Tab close paths: src/renderer/stores/tabs.svelte.ts (modified Phase 5), Tab.svelte
- vaultOperations.ts withDrainedWrites + the four disk-shape IPCs

Hunt for:
- catch (e) { logger.error(...); } with no toast, no rethrow, no sentinel → user has no idea something failed.
- An IPC handler that returns ok envelope but actually partially failed.
- A write path where the failure mode would leave the user thinking it saved.
- Save indicator: are there paths that don't increment/decrement inflight correctly? (4.1 timer fix was about this.)
- "drain all writers before doing X" pattern: any X that needs to drain but doesn't? Vault swap, app quit, vault delete, vault export.
- App quit (before-quit): is every writer flushed? Are sentinels reaped?
- atomicWriteFile failure: ENOSPC preserves the temp — but does the renderer know? Does the user get a "you may have lost data" prompt?
- A try/catch around a Promise.all that swallows individual rejections.
- A throw inside a $effect — Svelte may not surface it; does the UI report it?
- A debounced batch error: the timer fires, throws inside async, error is lost in the void.

Report findings per schema.`,
  },
  {
    key: 'uncommitted-diff',
    label: 'find:uncommitted-diff',
    prompt: `${SHARED_CONTEXT}

Dimension: **What did the uncommitted Phase-5 changes introduce or regress?**

Concretely, the working tree has these uncommitted modifications from a Phase-5 hygiene batch:
- DELETED: src/renderer/lib/boards/markdownWriteRegistry.ts (the shim; supposed to be dead-in-prod)
- MODIFIED: src/main/utils/pathSecurity.ts (5.4 — reject ':' in filenames)
- MODIFIED: src/main/vault/filenameUtils.ts (5.5 — Windows reserved names CON/NUL/COM1, trailing dots)
- MODIFIED: src/renderer/lib/boards/configWriteScheduler.ts (5.1 — ENOENT skip / resurrection guard)
- MODIFIED: src/renderer/lib/tasklist/filtersAndViews.svelte.ts (5.6 — dispose)
- MODIFIED: src/renderer/lib/vault/markdownFileWriter.ts (gateway extensions for the shim removal)
- MODIFIED: src/renderer/lib/vault/vaultOperations.ts (5.10 — removed duplicate flush call)
- MODIFIED: src/renderer/stores/document.svelte.ts, fileTags.svelte.ts, tabs.svelte.ts, vault.svelte.ts, vaultExternalChanges.ts (5.x — shim → gateway migration; 5.3 reconcile loop)
- MODIFIED: src/renderer/components/boards/{KanbanCard,TaskListBoard}.svelte, components/layout/GlobalToolbar.svelte (5.7, 5.8, focus)
- NEW: 6 unit tests + scripts/check-no-prod-markdown-test-flushers.mjs (CI gate)
- MODIFIED: CLAUDE.md, package.json, scripts/check-file-sizes.mjs

To get the exact diff: \`git diff HEAD -- <path>\` for each modified file. \`git log --oneline HEAD~10..HEAD\` shows the 10 prior fixes the audit confirms.

Hunt for:
- The shim deletion broke a caller the CI gate missed. Grep for any remaining "markdownWriteRegistry" string in src/ outside tests.
- The 5.4 / 5.5 filename hardening blocks an existing filename pattern users might have on disk (creates a corruption-on-rename scenario).
- The 5.1 ENOENT skip silently drops a config write the user expected to land.
- The 5.6 dispose path was added but not actually called from the only caller, leaving the original timer leak.
- The 5.3 reconcile loop has wrong ordering with index rebuild → cache reads from a stale index.
- The 5.10 single-owner flush actually breaks an invocation that depended on the duplicate flush firing.
- The vault.svelte.ts / vaultExternalChanges.ts modifications introduce a window where the runPostCommitTasks loop runs before or after the expected lifecycle hook.
- Any test that was "modified" because the assertion was loosened to make the new behavior pass (verify the test still meaningfully tests the bug it was written for).
- check-no-prod-markdown-test-flushers.mjs — does it have a false-positive escape hatch that the prod code uses?

For each finding, set introduced_by_uncommitted=true. Be ruthless — these changes are LATE in a remediation cycle and the project is about to be used.

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
Introduced by uncommitted Phase-5? ${f.introduced_by_uncommitted ? 'yes' : 'no'}
Not in Audit2 plan? ${f.not_already_in_audit2 ? 'yes' : 'no'}
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

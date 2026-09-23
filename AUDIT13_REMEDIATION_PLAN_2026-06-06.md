# Audit-13 Remediation Plan — Fresh Data-Integrity / Performance / Build Audit

**Date:** 2026-06-06
**Source:** Independent adversarial audit (9 subsystem auditors, prior `AUDIT*.md`
plans deliberately ignored so overlooked issues surface; every HIGH finding
re-verified by reading the live code and, for H2, by an empirical `yaml@2.9`
probe). Performed against the **uncommitted working tree** (mid-Audit-12:
board-path casefold + copy-file source guard + new test files on top of commit
`a7528a2`).
**Baseline at audit time:** `npm run check`, `npm run test:unit`, and
`npm run build` all green (exit 0); all 48 CI gates pass. **Green is not safety**
— the findings below all pass the existing suite.

**Overall system rating: ~7/10.** **No silent common-path data-loss blocker.**
**4 HIGH** (one is perf), **13 MEDIUM**, **~20 LOW**. The scary data-integrity
items are either *loud-failing* (error toast + `.filo/.dirty` recovery flag) or
*scoped to slow/synced volumes, YAML-alias frontmatter, or case-divergent
external edits*. The codebase is genuinely hardened; these are residual seams.

> **Verdict for dogfooding:** Safe to start on a **local-disk, single-machine**
> vault without YAML anchors. If the vault will live in **OneDrive / Dropbox / a
> network share** or be used **across devices**, do **H1** and **M1** first.

---

## How to use this plan

- Work **top-down by phase**. Phase 1 is small, isolated, high-value (do it
  first regardless of usage). Phases 2–3 are the data-integrity items that matter
  most for cloud-synced / multi-device use. Phases 4–6 are correctness depth.
  Phase 7 is performance. Phase 8 is build/deps/gate infrastructure. Phase 9 (split
  out of Phase 8) is the large, standalone `noUncheckedIndexedAccess` typing pass.
- Each item is **self-contained**: root cause, exact files, numbered fix steps,
  the test to add, and (where it applies) the CI gate to add/extend so the
  *class* can't silently reopen.
- After each item: run the named test + `npm run ci:verify`. Commit per phase
  (or per HIGH item) for bisectability.
- Tick the `Status` box when done.

### Status legend
- `[ ]` not started · `[~]` in progress · `[x]` done (test + ci:verify green)

### Per-area ratings (audit-time snapshot; re-rate after each phase)

| Area | Rating | Driving items |
|---|:---:|---|
| Frontmatter / markdown serialization | 7 | ~~H2~~ (P1), ~~M2, M8~~ (done — Phase 5) |
| Write pipeline & scheduling | 8 | ~~H1, M3~~ (both done — Phase 2) |
| Vault lifecycle / swap / recovery | 7.5 | H3, L16, L17 |
| External-edit reconciliation / watcher | 7 | ~~M1, M4, L14, L15, L1, L5, L20~~ (done — Phase 4); L19 deferred |
| Board cache & persistence | 8 | ~~M6, L9~~ (done — Phase 6), ~~L2~~ (done — Phase 4) |
| Undo/redo & commands | 8 | ~~M5, M7, L4, L6, L7, L8~~ (done — Phase 6) |
| Main-process IPC / file ops / security | 8 | ~~M11, M12~~ (done — Phase 1), ~~L10~~ (done — Phase 8) |
| Performance & memory | 8 | ~~H4, M9~~ (done — Phase 7); ~~L13~~ (accepted), ~~L18~~ |
| Build / deps / types / CI gates | 7 | ~~M13~~ (done — Phase 8), ~~L12~~ (done — Phase 9); M10 (deferred → own PR) |

---

## Guiding principles

1. **The recurring failure mode is "the fix landed in two of three sibling
   sites."** H1 = `flush()` has the pre-drain, the debounce-timer fire doesn't.
   M1 = every path-keyed store case-folds *except* `VaultIndex`. M8 = TextTile's
   adopt path threads EOL, DocumentEditor's twin doesn't. **Every fix below should
   add/extend a gate or behavioral test that makes the invariant structural**,
   not just pin this one instance.
2. **Prefer gates that scan for the *trigger*, not the guard.** A gate that fails
   when the guard token is deleted is evadable by a refactor (see M13). A gate
   that fires on the intrinsic hazard (e.g. a raw `===` between two path locals,
   a `doc.toJS()` outside a try) catches new offenders by construction.
3. **Mostly no refactor required.** Every item except M10 (Electron upgrade) is a
   localized change. The architecture — single-parser FM engine, per-path
   serialization in the gateway, generation-guarded vault swap, command pattern —
   is sound. The one structural extension is giving the *board/config/misc*
   schedulers the per-key serialization the markdown gateway already has (H1).

### Corrections to the raw auditor output (already folded in below)
- A **`package-lock.json` IS committed** → the "dependency drift from `^` ranges"
  worry is moot with `npm ci`; downgraded (see L-note under Phase 8).
- **H3's impact is in-memory / recoverable**, not note-content loss — reopening
  the vault restores everything. Disk loss is limited to `.filo/` *layout* config
  in the rare `vault:close`-also-threw sub-path. Rated High for **reliability**,
  not data destruction.

---

## Summary table

| ID | Sev | Area | One-liner | Phase |
|---|:---:|---|---|:---:|
| H2 | High | Frontmatter | YAML alias in FM → `doc.toJS()` throws, bypasses keep-raw safety net; file unsavable | 1 |
| M11 | Med* | Security | `approvedSources` copy-source set is process-global, leaks across vault swaps | 1 |
| M12 | Med* | Security | `media:open-external` blocklist misses OS launcher types (`.url`/`.scf`/`.desktop`/`.reg`) | 1 |
| L11 | Low | Security | open-external allowlist drift: `http://` + case-sensitive prefix match | 1 |
| H1 | High | Scheduler | board/config/misc writes can land out of order → silent clobber on slow/synced volumes | 2 |
| M3 | Med | Scheduler | timed-out write's late-success self-heal clears a newer/legit failure mark | 2 |
| H3 | High | Vault swap | failed second-`openVault` after `pre-swap` wipes the current vault's in-memory state | 3 |
| L17 | Low | Vault swap | async "Reload all"/"Reload" handlers not `isStillSameVault`-guarded (evade the gate) | 3 |
| L16 | Low | Reconcile | attachment-delete grace-window swap guard is a path-string compare, not generation-aware | 3 |
| M1 | Med | Reconcile | `VaultIndex` keys metadata case-sensitively — the lone path-keyed store that doesn't fold | 4 |
| M4 | Med | Reconcile | self-write suppression window can swallow a genuine concurrent external edit | 4 |
| L1 | Low | Frontmatter | external reload doesn't refresh `originalFrontmatterCache` → comment loss on external keys | 4 |
| L2 | Low | Board cache | `renameBoardPath` case-only-rename early-return → stored path desyncs from disk | 4 |
| L5 | Low | Reconcile | `reload-silently`/`ignore` body-change branch stamps no baseline → spurious drift prompt | 4 |
| L14 | Low | Reconcile | `reconcileBoardJsonChange` doesn't rebind `paths[boardId]` to new casing; no mid-write guard | 4 |
| L15 | Low | Reconcile | partial-read retry timer re-enters classifier off the rename queue (ordering hazard) | 4 |
| L19 | Low | Reconcile | symmetric (`Math.abs`) clock-skew window delays a genuine drastic truncation | 4 |
| L20 | Low | Watcher | continuous external write stream never fires the 300ms debounce (no max-wait) | 4 |
| M2 | Med | Frontmatter | `gray-matter` (js-yaml v3, YAML 1.1) is a reachable 2nd FM parser; the gate is blind to it | 5 |
| M8 | Med | Frontmatter | DocumentEditor adopt-path hydrate omits the EOL sniff → single-line-CRLF flip | 5 |
| M5 | Med | Undo | `MoveCardsCommand` redo lands the block at a stale absolute index (no forward-leg anchor) | 6 |
| M6 | Med | Board cache | `applyFrontmatterToBackedTilesBatch` flips a captured-stale cache map over a concurrent edit | 6 |
| M7 | Med | Undo | cross-board facade-command undo can mutate the wrong board (async scope-swap timing) | 6 |
| L4 | Low | Undo | `replaceAll` undo can use a build-time (not execute-time) file snapshot | 6 |
| L3 | Low | Board schema | partial-style blocks aren't `.passthrough()` → forward-compat style keys stripped on save | 6 |
| L6 | Low | Undo | `UpdateBoardSettingsCommand` inverse JSON-clone drops `undefined`-valued keys | 6 |
| L7 | Low | Undo | `UpdateOrphanFrontmatterCommand` all-fields-conflict path `markDirty`s with no write | 6 |
| L8 | Low | Undo | `AddSectionCommand` shallow-copies a section, aliasing its nested `style` object | 6 |
| L9 | Low | Board cache | `syncTileMarkdown` uses a bespoke coarse-clock drift guard instead of the gateway | 6 |
| H4 | High | Performance | Minimap + Smart-routed connections recompute O(tiles)/A* every pan/zoom frame | 7 |
| M9 | Med | Performance | every external tree change triggers multiple full-vault walks (sync-storm stutter) | 7 |
| L13 | Low | Performance | `fileState` hydrate registry grows per-file for the whole session | 7 |
| L18 | Low | Performance | `findBoardIdForTask` lacks the verify-on-hit memo its sibling resolvers use | 7 |
| M10 | Med | Build/Sec | Electron 33 is end-of-life — no Chromium/security backports (deferred → own PR) | 8 |
| M13 | Med | CI gates | three gates are token-presence "theater" (evadable by ordinary refactor) | 8 |
| L10 | Low | IPC/atomicity | `copyFileToVault` in-place stream + EXDEV move are non-atomic | 8 |
| L12 | Low | Types | `noUncheckedIndexedAccess` is off in both tsconfigs | 9 |

\* M11/M12/L11 are Medium/Low under a **hostile-vault** threat model (hostile note
content reaching IPC); N/A for a first-party vault you author yourself.

---

# Phase 1 — Quick high-value, low-risk fixes

> Small, isolated, each shippable on its own. Do these first regardless of how
> you store the vault.

## H2 — YAML alias in frontmatter throws `toJS()`, bypassing the keep-raw safety net

- **Status:** `[x]` — done 2026-06-06 (toJS wrapped + frontmatterSourceParses hardened; assembleMarkdownEngine.test.ts H2 block + 3 HOSTILE_CORPUS rows; ci:verify green).
- **Severity:** High · **Confidence:** Confirmed (read + `yaml@2.9` probe: an
  unresolved alias / forward reference / missing `<<` merge / alias-in-sequence
  all report `parseErrors=0` but `doc.toJS()` throws `ReferenceError`).
- **Files:**
  - `src/renderer/lib/vault/frontmatterCstModel.ts:236` (`const current = doc.toJS();` — outside the try at 216–220)
  - `src/renderer/lib/editor/markdownSync.ts:515` (`frontmatterSourceParses` only checks `errors.length`; the keep-raw branch at 515–528 never fires)

### Root cause
`parseDocument(src)` returns `errors.length === 0` for FM containing an
unresolved/forward alias or a missing-anchor merge, so the engine's refusal gate
at line 221 passes — but `doc.toJS()` (line 236) then **throws**, *outside* the
try/catch. The exception propagates out of `patchFrontmatterSourceCst` →
`assembleMarkdownFile` → the write, so the data-loss-avoiding "keep the raw bytes
verbatim" branch built for malformed YAML never runs. Reachable: the read path
catches the same throw and returns `frontmatter = {}`, but `rawFrontmatter` still
holds the poison bytes, which are re-parsed at assemble time.

### Fix
1. Wrap line 236 so the engine fails *closed* to `null` (its documented contract,
   which routes to the keep-raw / dump fallback):
   ```ts
   let current: unknown;
   try {
     current = doc.toJS();
   } catch {
     return null; // unresolved/forward alias or missing merge — let the caller keep raw bytes
   }
   if (current === null || typeof current !== 'object' || Array.isArray(current)) return null;
   ```
2. Harden `frontmatterSourceParses` (markdownSync) to actually attempt
   `parseDocument(src).toJS()` in a try/catch and return `false` on throw, so the
   **keep-raw** branch (not the full-dump branch) engages for alias-poison —
   preserving the user's exact bytes and dropping only the metadata edit (loud via
   `onFrontmatterRefused`).

### Test / Gate
- `assembleMarkdownEngine.test.ts`: add a describe block feeding FM with (a) a
  forward-ref alias, (b) `<<: *missing`, (c) alias-in-seq + a field-delta edit;
  assert the output equals the original bytes (keep-raw) and **does not throw**.
- Extend `check-frontmatter-invariant.mjs`'s corpus with alias/forward-ref/merge
  rows so the property suite exercises the path (behavioral pin, not token).

## M11 — `approvedSources` copy-source registry is process-global; leaks across vault swaps

- **Status:** `[x]` — done 2026-06-06 (clearApprovedSources() called from vault:close + vault:watch swap path; copyFileSourceGuard.test.ts swap-clear case; check-copy-file-source-guard.mjs Target 3 + bite-verified).
- **Severity:** Medium (hostile-vault) · **Confidence:** Confirmed (read).
- **Files:** `src/main/services/approvedSources.ts:57` (module-global `Set`, cleared only by `__resetApprovedSourcesForTests`); consumed at `src/main/ipc/vault.ipc.ts` (the `vault:copy-file` handler).

### Root cause
A path approved (via native dialog / OS drop) while vault A is open stays approved
for **every** later vault — the set is keyed by absolute path only, with no vault
association and no clear on `vault:close`/swap. A compromised renderer in vault B
can re-import any file the user ever picked this session.

### Fix
1. Either key the registry per vault — `Map<vaultKey, Set<sourceKey>>` keyed by
   the same case-folded vault-root form `isWithinVaultLexical` uses — or simplest:
   call `approvedSources.clear()` from the `vault:close` handler **and** at the
   start of the `vault:watch`/init swap path in `vault.ipc.ts` so the set resets
   whenever the active vault changes.
2. Keep the existing in-vault short-circuit (`isWithinVaultLexical`) untouched.

### Test / Gate
- `copyFileSourceGuard.test.ts`: register a source under root A, simulate the
  swap-clear, assert `isApprovedCopySource(rootB, src) === false`.
- Extend `check-copy-file-source-guard.mjs` to assert a clear-on-swap call site
  exists (token pin acceptable here; the behavioral test is the real proof).

## M12 — `media:open-external` blocklist misses OS launcher file types

- **Status:** `[x]` — done 2026-06-06 (.url/.scf/.website/.pif/.reg/.inf/.desktop added to both sets; mediaOpenExternalLauncherExt + sharedUntrusted + untrustedSinks parity tests; bite-verified).
- **Severity:** Medium (hostile-vault) · **Confidence:** High (read).
- **Files:** `src/main/ipc/media.ipc.ts:336` (`UNSAFE_FILE_EXTENSIONS`) + `src/shared/untrusted.ts:194` (`UNSAFE_LOCAL_FILE_EXTENSIONS`).

### Root cause
The local-path branch hands an in-vault file to `shell.openPath`. The blocklist
covers executables/scripts but not shell-acted-on launchers: `.url`, `.scf`,
`.website`, `.pif`, `.reg`, `.inf`, and on Linux `.desktop`. A hostile-vault
`.url` with `URL=\\attacker\share\x` can leak NetNTLM creds on a single
"open externally" click.

### Fix
1. Add `.url`, `.scf`, `.website`, `.pif`, `.reg`, `.inf`, `.desktop` to **both**
   `UNSAFE_FILE_EXTENSIONS` and `UNSAFE_LOCAL_FILE_EXTENSIONS` (the two sets have a
   parity test — keep them in sync).

### Test / Gate
- `mediaOpenExternalLauncherExt.test.ts`: assert each new extension is refused by
  the handler and present in both sets (the existing parity test extends naturally).

## L11 — open-external allowlist drift (`http://` + case-sensitive match)

- **Status:** `[x]` — done 2026-06-06 (handler lowercases target for prefix/SSRF compares, preserves original for openExternal; untrusted.ts http:// asymmetry documented; HTTPS:// / MailTo: case-variant tests + bite-verified).
- **Severity:** Low · **Confidence:** High (read).
- **Files:** `src/main/ipc/media.ipc.ts:253` (`ALLOWED_URL_PREFIXES`, case-sensitive `startsWith` at ~276) vs `src/shared/untrusted.ts:166` (still allows `http://`, case-insensitive).

### Root cause
Two consequences: (a) the renderer sanitiser still green-lights `http://` that the
main handler now refuses (harmless drift, but the duplicated-list invariant has
silently diverged); (b) main's case-sensitive prefix match means a legit
`HTTPS://…`/`Mailto:` link falls to the local-path branch and is refused (fail-
closed, but a UX regression).

### Fix
1. Lower-case `target` before the prefix test in the handler.
2. Reconcile `untrusted.ts`'s prefix list with the main-side one (drop `http://`
   there too, or document the asymmetry in the parity test).

### Test / Gate
- Add a case-variant URL row to `mediaOpenExternalLauncherExt.test.ts` (`HTTPS://`
  opens; `http://` refused).

---

# Phase 2 — Write ordering & scheduling (the H1 cluster)

> The most impactful data-integrity fix **if your vault is on a slow/synced/
> network volume.** On a plain local SSD this cluster is effectively unreachable.

## H1 — board/config/misc writes can land out of order and silently clobber newer data

- **Status:** `[x]` — done 2026-06-07 (timer-fire path drains prior in-flight per key via shared `drainPriorInFlight`, re-reads args after the drain; flushAll H4 routed through the same helper; `boardWriteOrdering.test.ts` no-overlap + freshest-args cases; `ci:awaited-writes-bounded` gains the `drainPriorInFlight(key)` token; all bite-verified; ci:verify green).
- **Severity:** High (slow/synced volumes) · **Confidence:** Confirmed (read; the
  code's own comment at `writeScheduler.ts:633` admits the hazard).
- **Files:**
  - `src/renderer/lib/boards/writeScheduler.ts:543` (the debounce-timer fire: `void fireWrite(key, snapshotted)` with **no** pre-drain)
  - `src/renderer/lib/boards/writeScheduler.ts:627` (the WC-3 pre-drain — present **only** in `flush()`; same in `flushAll()`)
  - contrast `src/renderer/lib/vault/markdownFileWriter.ts` (`writeChainByPath` — the per-path serialization board/config/misc lack)

### Root cause
board/config/misc schedulers have no per-key write serialization. The WC-3/H4
"drain the older in-flight write before firing the newer one so the newest lands
last" fix exists only on the `flush()`/`flushAll()` paths. During normal active
editing the debounced timer just fires; if a prior write for the same key is still
in flight (a stalled OneDrive/SMB handle), the two `board:save` IPCs overlap and
the OS can land the older one last. The post-write `vault:stat` then stamps the
drift baseline to the stale bytes, so the next edit sees "no drift" and won't warn.

### Fix
Make the timer-fire path serialize per key, mirroring `flush()`'s pre-drain.
1. Extract the WC-3 pre-drain (`writeScheduler.ts:641–644`) into a helper
   `drainPriorInFlight(key)` that `await`s every entry currently in
   `inFlight.get(key)`.
2. In `schedule()`'s `setTimeout` callback, make it `async` and:
   `await drainPriorInFlight(key)` → **then** re-read `getArgs()` →
   `opts.snapshotArgs?.(args)` → `void fireWrite(...)`. Re-reading args *after* the
   drain (exactly as `flush()` does at line 646) captures the freshest state.
   Guard the re-read for `null` (source removed mid-drain) the same way the timer
   already does.
3. Alternative (cleaner long-term): add a `writeChainByKey: Map<string, Promise>`
   inside `createScheduler` and chain each `fireWrite` behind the key's prior
   promise — making ALL paths serialize by construction, not just the timer.
   Prefer this if you want the gate to be structural.

### Test / Gate
- New `boardWriteOrdering.test.ts`: stub `performWrite` so W1 resolves on a delayed
  deferred; arm W1, then arm W2 with newer args while W1 is pending; resolve W1
  *after* W2 fires; assert the **last** `performWrite` to start (and the last
  bytes the stub records) is W2's — i.e. no overlap, newest wins.
- Extend `check-awaited-writes-bounded.mjs` (or a new `ci:scheduler-serializes-per-key`)
  to assert the board/config/misc schedulers reference the per-key drain/chain on
  the **fire** path, not only flush. Bite-test by reverting step 2.

## M3 — timed-out write's late-success self-heal can clear a newer / legitimate failure

- **Status:** `[x]` — done 2026-06-07 (per-path write generation `writeGenByPath` bumped at fire time; the `writeTimeoutMs` late-success continuation only `clearFailedPathAfterLateSuccess` when the path's generation is unchanged — a newer failed write bumps it and is preserved; `writeTimeoutLateSuccess.test.ts` supersede case; bite-verified; ci:verify green. H1's per-key serialization makes the "late W1 lands after W2" disk-ordering case unreachable in the first place — the two reinforce each other.).
- **Severity:** Medium · **Confidence:** Medium (read).
- **Files:** `src/renderer/lib/boards/writeScheduler.ts:428` (the `WRITE_TIMEOUT` branch's `void writePromise.then(...) → clearFailedPathAfterLateSuccess`) + `src/renderer/lib/boards/writeStateTracking.ts:426` (`clearFailedPathAfterLateSuccess` deletes unconditionally by path).

### Root cause
After a write exceeds `writeTimeoutMs` (60s) it's marked failed but keeps running;
a late success clears the failed mark *unconditionally by path*. For non-
serialized schedulers a late W1 can (a) land stale bytes and then declare the path
clean, and (b) erase a *newer* legitimate failure recorded for the same path in
the interim.

### Fix
1. Capture a per-path write generation/version at fire time; on the late success,
   only `clearFailedPathAfterLateSuccess` if no newer write/edit for that path has
   occurred since (compare versions).
2. H1's per-key serialization makes the "late W1 lands after W2" case impossible,
   so these two fixes reinforce each other — land H1 first.

### Test / Gate
- `writeTimeoutLateSuccess.test.ts` (already exists): add a case where W2
  supersedes the timed-out W1, then W1 late-succeeds; assert the failed mark is
  **not** cleared.

---

# Phase 3 — Vault lifecycle

## H3 — failed second-`openVault` after `pre-swap` wipes the current vault's state

- **Status:** `[x]` — done 2026-06-07. NOTE: the plan's literal fix ("move the
  candidate load before the reset block") is INFEASIBLE — `loadVaultCandidate`'s
  first IPC `vault:init-config` is the single registry-arming authority and main
  refuses to re-anchor B while A is active, so `vault:close` MUST precede the load
  (pinned by `vaultOpenClosesPriorVault.test.ts`; `board:list`/`board:load` in the
  candidate are also `assertActiveVault`-gated). The candidate load does register
  B — the plan's "reads B by path without registering it" premise is false. Fix
  instead: keep close-before-load (success path UNCHANGED), and on candidate-load
  failure REVERT to the outgoing vault via `revertToOutgoingVault` (release any
  partial-B registry → `loadVaultCandidate(A)` → commit → runPostCommitTasks;
  clean no-vault state + registry release on double-failure). Test
  `vaultSwapRevertsOnFailedOpen.test.ts` (revert / control / double-failure; the
  simulated main registry re-anchoring to A is the discriminator — bite-verified).
- **Severity:** High (reliability; data impact in-memory/recoverable) · **Confidence:** Confirmed (read).
- **Files:** `src/renderer/stores/vault.svelte.ts:1031` (`fireVaultSwap('pre-swap')`) and `:1050` (`vault:close`) both run **before** `:1062` (`loadVaultCandidate`); `:1063–1066` returns on failure without `commitVaultCandidate`.

### Root cause
`pre-swap` unconditionally resets ~20 stores (tabs, board cache, theme, tags,
history…) and `vault:close` releases the main registry — *before* the fallible
candidate load. If `loadVaultCandidate(newVaultPath)` throws (corrupt theme
`base`, unreadable `tags.json`, flaky share, vault deleted between picker and
open), it `reportError` + `return false` and never commits, leaving the renderer
believing vault A is open (`currentProject`/`vaultPath` untouched) but every
dependent store empty. Recoverable by reopening; the only disk-loss path is the
rare sub-case where the line-1050 `vault:close` itself threw (A stays registered)
so a follow-up save can overwrite A's `.filo/` layout config.

### Fix
Make the swap transactional w.r.t. the outgoing vault — load the candidate FIRST,
then reset/close/commit only on success:
1. Move `loadVaultCandidate(newVaultPath)` (and its try/catch) to run **before**
   the `if (currentProject)` reset block. (The candidate load is read-only and
   path-explicit — it reads the *new* vault by absolute path without registering
   it, which is already true today since it runs after `vault:close` with no
   active vault. Verify no IPC it calls is `assertActiveVault`-gated; the tree/
   config/theme/tags reads it uses take an explicit path.)
2. Only after the candidate resolves: `await fireVaultSwap('pre-swap', …)` →
   `await window.filo.invoke('vault:close')` → `commitVaultCandidate` →
   `runPostCommitTasks`.
3. On candidate-load failure, `reportError` + `return false` with the outgoing
   vault fully intact (nothing reset).

### Test / Gate
- `vault.svelte` test: open vault A, stub `loadVaultCandidate` to reject for B,
  call `openVault(B)`; assert `tabStore`/`boardCacheStore`/`themeStore` still hold
  A's state and `vaultStore.path === A`. Negative control: a successful B open
  still resets and commits.
- No structural gate (ordering); the test is the pin. Add a `// DECISION:` comment
  documenting load-before-reset.

## L17 — async "Reload all" / "Reload" external-edit handlers aren't `isStillSameVault`-guarded

- **Status:** `[x]` — done 2026-06-07. Found + guarded FOUR sibling handlers, not
  the two the plan named: `promptBulkExternalChanges` "Reload all",
  `promptModifiedFile` "Reload", PLUS `promptPartialReadExhausted` "Reload from
  disk" and `promptExternalEditOnSync` "Reload" (each captures
  `captureVaultIdentity()` then bails via `isStillSameVault` after the
  `applyChanges` re-read; the sync-prompt resolves `'defer'`). Gate widened with an
  `applyChanges` trigger on `vaultExternalChanges.ts` (scans the containing named
  `prompt*` functions Pass 1 discovers — catches the anonymous arrows + any future
  Reload handler) — bite-verified. Test `externalReloadSwapGuard.test.ts` (swap →
  defer/no-mutation, control → reload/mutation; bite-verified).
- **Severity:** Low · **Confidence:** High guard-absent / Low race-hit.
- **Files:** `src/renderer/stores/vaultExternalChanges.ts:931` (bulk "Reload all") and `:1225` (`promptModifiedFile` "Reload") — anonymous arrow handlers inside `pushToast({actions})`, which `check-reconciler-vault-guard.mjs` Part 1 (named functions/methods only) does not scan.

### Root cause
Both handlers `await vaultIndexStore.applyChanges([rel])` then synchronously apply
the result to in-memory stores, with no identity capture around the await. A vault
swap during the await lets vault A's file content land in vault B's stores (keyed
by same-named relPath). In-memory only; persists only on a follow-up save.

### Fix
1. Capture `const id = captureVaultIdentity()` at the top of each handler; after
   each `await applyChanges(...)`, `if (!isStillSameVault(id)) return;` before
   touching stores.
2. **Widen the gate** so it can see these: extend `check-reconciler-vault-guard.mjs`
   Part 1 to also scan anonymous arrow handlers passed to `pushToast(...actions)`
   in `vaultExternalChanges.ts`, or hoist them to named functions the gate already
   discovers.

### Test / Gate
- `onOpenReconcileSwapGuard.test.ts` (or a sibling): model a swap landing mid-
  `applyChanges` loop; assert no store mutation after the swap.

## L16 — attachment-delete grace-window swap guard is a path-string compare

- **Status:** `[x]` — done 2026-06-07. `handleExternalAttachmentChanges` now
  captures `captureVaultIdentity()` before the grace `setTimeout` and bails via
  `isStillSameVault(id)` instead of `ctx.getVaultPath() !== vaultRoot`; the
  `GUARD_EXEMPT` entry is removed from `check-reconciler-vault-guard.mjs` (so
  reverting the guard now re-flags it — bite-verified). Test: same-path-reopen case
  added to `externalAttachmentDeleteGrace.test.ts` (bite-verified — only the new
  SAME-path case reds on the string compare; the different-path swap test still
  passes).
- **Severity:** Low · **Confidence:** High string-compare / Low harm (toast cleared on swap + main-side gate).
- **Files:** `src/renderer/stores/vaultExternalChanges.ts:549` (`if (ctx.getVaultPath() !== vaultRoot) return;`), currently in `GUARD_EXEMPT`.

### Root cause
A close→reopen of the **same** path is a new generation but passes a string
compare, so a deferred "attachment deleted externally" prompt can surface against
the reopened vault.

### Fix
1. `const id = captureVaultIdentity()` before the grace `setTimeout`; replace line
   549 with `if (!isStillSameVault(id)) return;`. Remove the `GUARD_EXEMPT` entry.

### Test / Gate
- Add a same-path-reopen case to the external-attachment reconciliation tests.

---

# Phase 4 — Case-folding & external-edit reconciliation

> The other cluster that matters for **multi-device / OneDrive** vaults.

## M1 — `VaultIndex` keys metadata case-sensitively (the lone path-keyed store that doesn't fold)

- **Status:** `[x]` — done 2026-06-07. Branded `metadata: Map<VaultPath, FileMetadata>` + a private `keyOf(path): VaultPath` route upsert/get/has/remove/renameKey + the MiniSearch id through one fold; `metadata.path` keeps OS casing (allPaths/query resolve it back). renameKey now refreshes display casing on a case-only rename instead of dropping it. Gate `check-vault-path-keys.mjs` extended with a VaultIndex fold assertion (branded map + keyOf-folds + every `const id|oldId|newId` via `this.keyOf`); bite-verified 3/3. Tests in `vaultIndex.test.ts` (case-divergent get/has/re-upsert-no-dup/remove/rename + display casing).
- **Severity:** Medium · **Confidence:** Confirmed (read: `upsert` keys by raw
  `metadata.path`; `get`/`has`/`remove` use `toPosix` but not case-fold; the
  `renameKey` doc explicitly says "we keep it case-sensitive").
- **Files:** `src/renderer/lib/vault/vaultIndex.ts:448` (the `metadata` Map) + `:463/476/490/514/518` (upsert/remove/renameKey/has/get) + consumers `src/renderer/stores/vaultExternalChanges.ts:120,140`.

### Root cause
Every other path-keyed store case-folds (`fileBaselineRegistry.normaliseKey`,
`documentStore.findByFilename` via `samePath`, the board reconciler via
`samePath`/`normalizeVaultRelative`). `VaultIndex` is the exception: its Map +
MiniSearch id are keyed by case-preserving path. On a case-insensitive FS, an
external edit reported with divergent casing (case-only rename, multi-device
OneDrive, git) misses the index entry → the partial-read guard (gated on
`previousMetadata`) is bypassed so a truncated mid-write read can reload into a
clean editor; the edit is misclassified; and `applyChanges` upserts a duplicate
entry under the new casing.

### Fix
1. Add a private `keyOf(path)` that returns `normalizeVaultRelative(path)` (the
   shared case-folding form), and route `upsert`/`get`/`has`/`remove`/`renameKey`
   Map keys **and** the MiniSearch `id` through it. Keep `metadata.path` as the
   display/OS casing in the value.
2. `upsert` currently keys by raw `metadata.path` (line 464) — fold it too, for
   parity with the readers.

### Test / Gate
- `vaultIndex` test: `upsert({path:'Notes.md'})` then `get('notes.md')` returns it;
  a case-divergent external change classifies as the same file (no duplicate, no
  partial-read bypass).
- Extend `check-vault-path-keys.mjs` to assert `VaultIndex` Map/MiniSearch keys go
  through the fold helper.

## M4 — self-write suppression window can swallow a genuine concurrent external edit

- **Status:** `[x]` — done 2026-06-07. `handleExternalMarkdownChanges` no longer blanket-drops recent self-writes: the new `selfWriteDivergedFromBaseline(root, rel)` helper stats the path and KEEPS it when the fresh (mtime/size) diverges from the `fileBaselineRegistry` baseline Filo last wrote (a second writer touched it); drops it (pre-M4 behaviour) when the stat matches, there's no baseline, or the stat is unavailable (data-safe default). Non-self-write paths never stat. Tests in `audit13Phase4.test.ts` (diverged→kept / matched→dropped / no-baseline→dropped / non-self-write→passthrough); bite-verified.
- **Severity:** Medium · **Confidence:** Medium.
- **Files:** `src/renderer/stores/vaultExternalChanges.ts:101` (`isRecentSelfWrite` drop at handler top) + `src/renderer/lib/boards/writeStateTracking.ts:38` (TTLs) + `src/main/ipc/vault.ipc.ts:729` (`suppress(rel, …)`); `src/renderer/lib/vault/fileBaselineRegistry.ts:188` (comment: the reconcile path deliberately ignores the baseline).

### Root cause
A Filo write suppresses watcher events for ~2–3s. A real external edit inside that
window is dropped at both layers; the only recovery is the 30s periodic reconcile.
If Filo writes the same file again before that, last-writer-wins loses the external
edit silently.

### Fix
1. Have the external-change classifier consult `fileBaselineRegistry` as a tiebreak
   for a "self-write" path: if its fresh stat (mtime **or** size) diverges from the
   baseline Filo actually wrote, treat it as external instead of dropping — bringing
   the watcher path to parity with the write-side drift guard.

### Test / Gate
- `vaultExternalChanges` test: self-write a path, then an external change within the
  window with a divergent size; assert it is classified external (not dropped).

## L1 — external reload doesn't refresh `originalFrontmatterCache`

- **Status:** `[x]` — done 2026-06-07. `handleExternalChange` gained a `rawFrontmatter?` param threaded into `applyReloadFromDisk`; the reload-silently `handleExternalChange` call and the five genuine disk-reload `applyReloadFromDisk` sites (bulk Reload-all, promptModifiedFile, promptPartialReadExhausted, promptMarkdownPendingWriteConflict, promptExternalEditOnSync) now pass `fresh/next.rawFrontmatter` instead of `undefined`, so `originalFrontmatterCache` refreshes in lockstep (an external key keeps its comment on the next body save). The recovery-restore site (priorFm) correctly stays `undefined`. Tests in `audit13Phase4.test.ts`; bite-verified.
- **Severity:** Low · **Confidence:** High.
- **Files:** `src/renderer/stores/document.svelte.ts:732,744` (`noteRawFrontmatter(docId, undefined)` only deletes the raw cache, leaves `originalFrontmatterCache` stale) + the 5 `applyReloadFromDisk(..., /*rawFrontmatter*/ undefined, ...)` call sites in `vaultExternalChanges.ts`.

### Root cause
Watcher reloads pass `undefined` for `rawFrontmatter`, so the byte-preservation
baseline predates an externally-added key. Not data loss (the cache is
authoritative for the key set), but the added key loses its inline comment/quoting
on the next save.

### Fix
1. Thread the reload read's `rawFrontmatter` (already in hand at read time) through
   `handleExternalChange`/`applyReloadFromDisk` so `originalFrontmatterCache` is
   refreshed in lockstep with `frontmatterCache` — mirror the in-app mutation path
   `syncOpenEditorsAfterDiskMutation.ts:84`.

### Test / Gate
- Reuse the external-reload tests; assert a reloaded externally-added key keeps its
  comment after a subsequent body save.

## L2 — `renameBoardPath` case-only rename early-returns, desyncing the stored path

- **Status:** `[x]` — done 2026-06-07. The early return now fires only on a BYTE-identical `normalizePath` (true no-op); a case-only rename (folds equal, raw differs) falls through to the rebind loop and rewrites `boardPaths[boardId]` to the new casing. `boardPathCaseFold.test.ts`'s Audit-12 "case-only is a no-op" case is superseded by two L2 cases (case-only→rebind, byte-identical→no-op); bite-verified.
- **Severity:** Low · **Confidence:** Medium.
- **Files:** `src/renderer/stores/boardCache.svelte.ts:382` (early return when folded paths are equal).

### Root cause
A case-only `.board.json` rename folds equal → the function returns `[]` and never
rewrites `boardPaths[boardId]`, so the stored casing diverges from disk. Harmless
on Windows; breaks on a case-sensitive FS / synced vault ("missing on disk"
eviction or phantom-path write).

### Fix
1. When folded paths are equal **but raw paths differ**, still rewrite
   `boardPaths[boardId]` to the new casing instead of returning `[]`.

### Test / Gate
- `boardPathCaseFold.test.ts`: a case-only rename rebinds the stored path.

## L5 — `ignore`/`reload-silently` body-change branch stamps no baseline → spurious drift prompt

- **Status:** `[x]` — done 2026-06-07. The `case 'ignore'` branch now re-stamps `noteBaseline(rel, next.lastModified, next.rawByteSize)` for `reason === 'no-editor-open'` (a closed-file body-only edit the index already absorbed), so the next in-app field edit's pre-write drift check doesn't false-flag "modified externally". Test in `audit13Phase4.test.ts`; bite-verified.
- **Severity:** Low · **Confidence:** Medium.
- **Files:** `src/renderer/stores/vaultExternalChanges.ts:379` (the `no-editor-open` body-changed branch returns without `noteBaseline`).

### Root cause
An external body-only edit on a closed file updates the index but not
`fileBaselineRegistry`; a later field edit on a card backed by that file hits the
gateway drift check (fresh-stat ≠ stale-baseline) and prompts "modified
externally." Safe direction (no clobber) but friction.

### Fix
1. Re-stamp `noteBaseline(rel, next.lastModified, next.rawByteSize)` in that branch
   so the write-side guard doesn't re-flag an edit the index already absorbed.

### Test / Gate
- Add the closed-file-body-edit-then-field-edit case to the reconciliation tests.

## L14 — `reconcileBoardJsonChange` doesn't rebind `paths[boardId]`; no mid-write guard

- **Status:** `[x]` — done 2026-06-07 (rebind half). After a successful silent `loadBoard`, `reloadBoardFromDisk` now calls `boardCacheStore.renameBoardPath(boardStore.paths[boardId], rel)` to rebind the stored path to the OS-reported casing (relying on the L2 case-only rebind), so a case-divergent external edit/rename keeps `boardPaths` in lockstep with disk (no "missing on disk" eviction). The optional size/mtime sanity-check half was skipped — `loadBoard` already Zod-validates, so partial JSON fails loud. Test in `audit13Phase4.test.ts` (dispatch a case-divergent board change → path rebinds); bite-verified.
- **Severity:** Low · **Confidence:** Medium.
- **Files:** `src/renderer/stores/vaultExternalReconcilers.ts:83` (`reloadBoardFromDisk`/`loadBoard(vaultRoot, rel)` with OS casing).

### Fix
1. After a successful silent `loadBoard`, rebind `boardStore.paths[boardId]` to
   `rel` (or its folded form) so casing stays consistent.
2. Optionally gate the silent board reload on a size/mtime sanity check (parity
   with the markdown partial-read guard) — bounded value since partial JSON usually
   fails Zod.

## L15 — partial-read retry timer re-enters the classifier off the rename queue

- **Status:** `[x]` — done 2026-06-07. `VaultContext` gained an optional `enqueueRenameQueueWork` (wired in `vaultCtx` → `vaultStore.enqueueRenameQueueWork`); the partial-read retry callback now re-enters via `ctx.enqueueRenameQueueWork(() => handler([rel]))` (falls back to a direct call only for test stubs that omit it), so the retry inherits the queue's arrival-order serialization + enqueue-time vault-identity guard. Test in `audit13Phase4.test.ts` (spy ctx → retry routes through it); bite-verified.
- **Severity:** Low · **Confidence:** Medium.
- **Files:** `src/renderer/stores/vaultExternalChanges.ts:368` (`schedulePartialReadRetry(... () => void handler([rel]))`).

### Fix
1. Route the retry through `vaultStore.enqueueRenameQueueWork(() => handler([rel]))`
   so it inherits both the identity guard and arrival-order serialization the
   queue provides (avoids re-indexing a path a concurrent rename is rebinding).

## L19 / L20 — clock-skew window + watcher debounce max-wait (minor)

- **Status:** L20 `[x]` done 2026-06-07 · L19 DEFERRED (DECISION, not fixed).
  - **L20 done:** `fileWatcher.scheduleNotify` now caps the trailing-debounce
    delay at the remaining `maxDebounceWaitMs` (1000ms) by tracking
    `debounceFirstQueuedAt`, so a continuous sub-300ms write stream still flushes
    within ~1s (a lone event still gets the full debounce; the marker resets on
    fire / `stop()`). Tests in `fileWatcherMaxWait.test.ts` (continuous-stream cap
    / single-event full window / paused-then-resumed fresh window); bite-verified.
  - **L19 DEFERRED:** treating a future mtime "beyond a small tolerance" as
    settled directly tensions the A8-H1 fix (pinned by `conflictResolver.test.ts`'s
    `Date.now() + 500` case): a mid-write vs settled truncation is indistinguishable
    from a single stat on a clock-skewed volume, so any tolerance tight enough to
    help L19 re-opens A8-H1's clean-editor clobber. The retry-then-exhaustion
    prompt is the correct disambiguator. Documented as a `DECISION` comment in
    `conflictResolver.ts` so it isn't re-attempted.
- **Severity:** Low · **Confidence:** High logic / Low impact.
- **L19** `src/renderer/lib/vault/conflictResolver.ts:231` — the symmetric
  `Math.abs(now - lastModified)` recency test defers a genuine drastic truncation
  with a future mtime through the retry schedule. *Fix (optional):* treat a future
  mtime beyond a small tolerance as "settled," not "in flight."
- **L20** `src/main/services/fileWatcher.ts:814` — trailing-edge debounce with no
  max-wait; a steady sub-300ms external write stream never fires until it pauses
  (recovered by the 30s reconcile). *Fix (optional):* add a max-wait cap (fire if
  the oldest queued event exceeds ~1s).

---

# Phase 5 — Frontmatter parser consolidation & EOL

## M2 — `gray-matter` (js-yaml v3, YAML 1.1) is a reachable second FM parser

- **Status:** `[x]` — done 2026-06-07. gray-matter DROPPED ENTIRELY from the
  index + template read paths (not just the FM fallback): new shared
  `lib/vault/frontmatterRead.ts` — `splitFrontmatterSource` (fence-strip + BOM,
  the single `// allow-bom-sniff` site) + `parseFrontmatterObject`
  (`parseDocument().toJS()` called EVEN on recoverable errors like
  `TAB_AS_INDENT`, so a tab-indented `date:` recovers as a STRING, never a
  js-yaml Date) — now backs both `vaultIndex` (`parseMarkdown`'s rawFrontmatter,
  the remark `yaml`-node parse, the body split, and the renamed
  `parseWithoutRemark` fallback = ex-`parseWithGrayMatter`) and
  `templateService.parseTemplate`. Body splitting also left gray-matter: it
  bundles js-yaml and parses the FM internally even when only `.content` is
  read, so it could still coerce/throw — now NO second parser is reachable. Gate
  `check-no-jsyaml-in-frontmatter.mjs` also forbids `gray-matter` imports (same
  `// allow-jsyaml:` escape for a genuine body-only use) — bite-verified (temp
  import → exit 1; escape annotation → exit 0). Tests: `vaultIndex.test.ts`
  tab-indented-date-stays-string + malformed-recovers-clean; `templateService.test.ts`
  date/`0b1010`-stay-string + body intact. (gray-matter stays in `package.json`
  as an unused dep — uninstalling churns the lock, out of scope; the gate
  forecloses re-import.)
- **Severity:** Medium · **Confidence:** Confirmed (auditor proved gray-matter
  4.0.3 bundles `js-yaml@3.14.2` `safeLoad`; `date:`→Date, `0b1010`→10; reachable
  via tab-indented FM that the `yaml` package errors on).
- **Files:** `src/renderer/lib/vault/vaultIndex.ts:171,337` (gray-matter fallback) + `src/renderer/lib/templates/templateService.ts:117` (primary parse) + the blind gate `scripts/check-no-jsyaml-in-frontmatter.mjs:50`.

### Root cause
The "single-parser (`yaml` only)" invariant is not airtight: on malformed-but-
recoverable YAML the index falls back to gray-matter (a different parser with
Date/number coercion), reintroducing the cross-parser "looks changed but isn't"
class. Mostly defanged today (writes use delta-on-fresh-disk; common reject =
duplicate keys → both yield `{}`), but latent and the enforcing gate is blind to
gray-matter (bite-tested: a new `import matter from 'gray-matter'` passes).

### Fix
1. Replace the gray-matter FM fallback in `parseFrontmatterBlock`/
   `parseWithGrayMatter` with a lenient `yaml` re-parse:
   `parseDocument(src, { strict: false })` then a guarded `.toJS()` (return `{}` on
   throw). Keep gray-matter only for body splitting if still needed, or drop it.
2. Parse template FM with the `yaml` package in `templateService.ts` for
   consistency.
3. **Extend `check-no-jsyaml-in-frontmatter.mjs`** to also forbid `gray-matter`
   imports on frontmatter read paths (same `// allow-jsyaml:`-style escape for any
   body-only use). Bite-test by adding a temp gray-matter FM parse → exit 1.

### Test / Gate
- `vaultIndex` test: a tab-indented FM with `date: 2024-01-15` indexes the value as
  a **string**, not a Date.

## M8 — DocumentEditor adopt-path hydrate omits the EOL sniff (single-line-CRLF flip)

- **Status:** `[x]` — done 2026-06-07. NOTE: the plan's "both DocumentEditor
  adopt-path `markHydrated` calls" is a miscount — DocumentEditor has ONE adopt
  path (the cached-body branch at ~:335), not TextTile's two. The other
  `markHydrated` call (~:365) is the Audit-12 M1 read-FAILURE path: it reads no
  body (nothing to sniff) AND blocks writes (`buildWriteArgs` returns null while
  `hydrateReadFailed && !lastLoadedBody`) until a retry's `readMarkdownForHydrate`
  stamps the REAL eol — so it is not an M8 site and threading a phantom eol from
  an unread body there would be cargo-cult. The single adopt path now sniffs
  `const adoptEol = docState.body.includes('\r\n') ? '\r\n' : undefined` and
  threads it as the `eol` arg (mirrors TextTile exactly). Gate
  `check-eol-preservation.mjs` gains a DocumentEditor target (the adoptEol
  body-sniff + adoptEol threaded into `markHydrated`) — bite-verified (revert
  the adoptEol lines → exit 1; restore → exit 0). Test
  `documentEditorAdoptEol.test.ts` (gateway contract: a threaded `eol` keeps a
  single-line-FM file CRLF on the first write; WITHOUT it + an LF body it flips
  to LF — proving the threaded eol is load-bearing).
- **Severity:** Medium · **Confidence:** Medium.
- **Files:** `src/renderer/components/boards/DocumentEditor.svelte:335` (`markHydrated(docState.filename, false)` — no `eol`), vs the fixed twin `src/renderer/components/tiles/TextTile.svelte:259,291`.

### Root cause
TextTile's adopt path sniffs CRLF from the body and threads it; DocumentEditor's
equivalent leaves `state.eol === undefined`, so a single-line-FM CRLF file flips
whole-file to LF on the first body save.

### Fix
1. Mirror TextTile: `const adoptEol = docState.body.includes('\r\n') ? '\r\n' : undefined;`
   and pass it as the `eol` arg to both DocumentEditor adopt-path `markHydrated`
   calls.

### Test / Gate
- `documentEditorHydrateFailure.test.ts` (or a sibling): adopt a CRLF single-line-FM
  doc, save a body edit, assert output stays CRLF.
- Extend `check-eol-preservation.mjs` to assert the DocumentEditor adopt path
  threads `eol` (token pin alongside the behavioral test).

---

# Phase 6 — Undo/redo & cache correctness

## M5 — `MoveCardsCommand` redo lands the block at a stale absolute index

- **Status:** `[x]` — done 2026-06-07. `moveKanbanPlacements` gained an optional `beforeTileId` forward-leg anchor (resolved against the live post-removal index, mirroring `moveKanbanPlacement`); `MoveCardsCommand` captures `toBeforeTileId` pre-move (the surviving card at `toPosition` once the moved set is removed) and threads it through `execute()`. Test `moveCardsUndoOrder.test.ts` (multi-card move → undo → prepend to target column → redo lands before the original sibling, not the stale absolute index) — bite-verified (drop the anchor arg → block lands at index 1). kanbanCommands ceiling 1064→1078.
- **Files:** `src/renderer/commands/kanbanCommands.ts:348` (`execute`/redo passes no anchor) vs `:357` (`undo` passes `s.anchorTileId`); `src/renderer/stores/boardCacheKanban.ts:514` (`moveKanbanPlacements` has no anchor param).

### Root cause
The multi-card move captures per-card neighbour anchors for **undo** only; redo
(= `execute`) replays the absolute `toPosition` captured at drag time. Multi-card
move → undo → edit the target column → redo lands the block in the wrong slot.
(The single-card `MoveCardCommand` anchors both legs.)

### Fix
1. Add an optional `beforeTileId` anchor to `moveKanbanPlacements` (mirror
   `moveKanbanPlacement`).
2. Have `MoveCardsCommand.execute()` compute + pass a forward-leg anchor (the next
   surviving card after the insertion point in the target column), captured at
   construction.

### Test / Gate
- `kanbanStructureCommandsRoundTrip` (or sibling): multi-card move → undo → mutate
  column → redo lands correctly. `check-command-roundtrip-coverage.mjs` already
  requires a round-trip; ensure this case is exercised.

## M6 — `applyFrontmatterToBackedTilesBatch` flips a captured-stale cache map

- **Status:** `[x]` — done 2026-06-07. The batch no longer holds the captured cache map across yields: it re-reads `ctx.getCache()` after each yield (reconciles after the yield run on the live map) AND for the terminal `setCache({ ...ctx.getCache() })` flip (no await between the last re-read and the synchronous commit). The L-fix moved the `lastReconciledMtime` stamps into a `pendingStamps` list applied only on a clean (non-aborted) finish, so a swap/abort can't leave a half-applied file marked "already reconciled." Test in `boardCacheReconcileBatch.test.ts` (60-board batch forces a yield; a concurrent same-vault `updateEntry` on an untouched victim board during the suspension survives the terminal flip) — bite-verified (revert both re-reads → the victim's marker is reverted).
- **Files:** `src/renderer/stores/boardCacheFrontmatter.ts:131` (captures `cache` once, yields across microtasks, then `setCache({ ...cache })` at 167).

### Root cause
The terminal `setCache({ ...cache })` of the captured map reverts any concurrent
same-vault `updateEntry`/`touchBoard`/placement mutation that landed during the
yields (the swap guard only covers cross-vault). Triggered at vault open
(fire-and-forget off the index rebuild).

### Fix
1. Don't hold the captured map across yields. Either re-read `ctx.getCache()` after
   each yield and apply against the live map, or accumulate per-board patches and
   merge into the live cache at the end:
   `ctx.setCache({ ...ctx.getCache(), ...patches })`.
2. Move the `lastReconciledMtime.set(...)` into the terminal commit block (L-fix:
   currently stamped per-iteration before the change is committed).

### Test / Gate
- `boardCacheFrontmatter` test: simulate a concurrent `updateEntry` during the
  batch yield; assert it survives the terminal commit.

## M7 — cross-board facade-command undo can mutate the wrong board

- **Status:** `[x]` — done 2026-06-07 (chose option 2 — the localized `undo`/`redo` settle; no gate change). When the head command auto-switches boards (`boardActivator` succeeded), the body is deferred via a new `settleActiveScope(targetBoardId)` that `await tick()`s (bounded to 10) until `activeBoardId` reflects the target — the PaneView `$effect` re-points the scope + calls `setActiveBoard` on a later tick, so a Mind-Map facade body running synchronously would have mutated the previously-active board. The common same-board path keeps its synchronous body (the op is only async when `didAutoSwitch`). Added a read-only `historyStore.activeBoardId` getter for the test. Test `historyAutoSwitch.test.ts` (a probe command records the active board when its body runs; the activator models a MULTI-hop microtask re-point so a single pre-body `await` is insufficient — the loop is required) — bite-verified (replace the loop with one `await` → the body observes the stale board).
- **Files:** `src/renderer/stores/history.svelte.ts:458` (undo)/`:503` (redo) run the command body synchronously after `boardActivator`; the `boardStore` facade only re-points on the next-tick `PaneView` `$effect` (`src/renderer/lib/boards/boardScope.svelte.ts`).

### Root cause
When `targetBoardId !== activeBoardId` and the target board isn't mounted in a
pane, facade-based commands (`DeleteTilesCommand`, `MoveTilesCommand`,
`AddTileCommand`, `AddConnectionCommand`, frame/waypoint) execute against the OLD
scope because the new pane's effect hasn't run. (Cache-targeting Kanban/Task/
Properties commands self-target and are safe.)

### Fix
1. Make the Mind-Map facade commands self-target like the cache commands — thread
   `targetBoardId` into the mutation (resolve the scope by board id, not the global
   facade); **or**
2. Have `undo`/`redo` await a "scope is now on `targetBoardId`" signal before
   running the body when an auto-switch occurred (the body is already async-capable
   via `runChained`).

### Test / Gate
- `history.svelte` test: file a facade command on board X's stack with X not in a
  pane; undo; assert X (not the visible board) was mutated. Extend
  `check-commands-target-board.mjs`/`check-command-targets-self.mjs` to cover the
  facade commands if option 1 is chosen.

## L3 — partial-style schema blocks aren't `.passthrough()` (forward-compat loss)

- **Status:** `[x]` — done 2026-06-07 (CONFIRMED, no code change). Re-confirmed with the user against the envelope's "don't destroy data we don't understand" docstring: the partial-style blocks stay non-passthrough by decision. A forward-compat style key from a newer Filo is meaningless to an older one's cascade resolver, and the only loss is a newer→older→save downgrade round-trip the user controls via their version. The existing DECISION comment in `board.ts` was strengthened with the re-confirmation so the trade-off isn't re-litigated.
- **Files:** `src/renderer/schema/board.ts:30–160` (the `Partial*StyleSchema` blocks).

### Root cause
The board envelope is `.passthrough()` but the per-element `style` sub-objects are
not, so a newer Filo's (or a hand-added) style key is stripped on load and the
loss persists on the next save. The schema's own DECISION comment accepts this;
flagged so the trade-off is re-confirmed against the envelope's "don't destroy data
we don't understand" docstring.

### Fix (if forward-compat on style is wanted)
1. Add `.passthrough()` to the partial-style blocks.

## L4 — `replaceAll` undo can use a build-time (not execute-time) snapshot

- **Status:** `[x]` — done 2026-06-07. `ReplaceAllCommand.execute()` now re-reads each file at write time and writes only when disk STILL equals the planned `originalContent`; a diverged file is skipped + named in an aggregate toast (symmetric with `undo()`'s existing drift-skip). So a stale redo can't clobber an intervening edit, and the undo snapshot is by-construction the bytes actually overwritten. The first execute runs same-tick after `buildPlans`, so nothing drifts there in practice. Tests in `replaceAllCommand.test.ts` (diverged disk → skip + no clobber + toast; matching disk → writes) — bite-verified (unconditional push → the skip test clobbers).
- **Files:** `src/renderer/commands/replaceAllCommand.ts` (`buildPlans` snapshots `originalContent` at plan-build; `execute` writes later without re-checking disk still equals it).

### Fix
1. Re-read each file inside `execute()` and capture `originalContent` there (or
   abort the file if disk ≠ the build-time read), so the undo snapshot is the bytes
   actually overwritten.

## L6 / L7 / L8 / L9 — undo + cache edge cases (batch)

- **Status:** `[x]` — all done 2026-06-07.
  - **L6** — ACCEPTED + documented (DECISION comment in `boardHistory.ts`). The
    inverse-clone JSON round-trip drops nested `undefined`-valued keys, but
    `applyToTarget` restores by replacing the whole top-level settings key and
    every reader treats missing ≡ `undefined` (`?.`/`?? default`), so the drop is
    behaviourally identical — a recursive undefined→delete pass would be zero gain.
  - **L7** — `applyOrphanPatchRebased` no longer `markDirty`s in the all-fields-
    conflict branch (nothing is written or cached → a no-write must not dirty the
    board / risk a phantom drift prompt). Test in `updateOrphanFrontmatterRebase.test.ts`
    (spy asserts `markDirty` is NOT called when every key conflicts on undo) —
    bite-verified.
  - **L8** — `AddSectionCommand` deep-clones the new section via `this.snapshot(...)`
    in the constructor (the `allow-shallow` comment was wrong — TaskListSection
    carries a nested `style`), plus a defense-in-depth deep-clone at persist time.
    Test in `sectionCommandsDelta.test.ts` (a between-construction-and-execute
    mutation of the source style doesn't leak into the persisted section) —
    bite-verified. (A second test pinning the persist-time clone was dropped as
    vacuous — Svelte `$state` isolates the persisted mutation regardless.)
  - **L9** — `syncTileMarkdown`'s recovery-sync drift guard adds a content re-read
    when mtime+size match (the coarse-clock residual a same-length external
    overwrite slips through), routing it to the Reload/Keep-local prompt. Tests in
    `syncTileMarkdownMtimeGuard.test.ts` (identical mtime+size + different bytes →
    prompt + skip; identical bytes → write proceeds) — bite-verified.
- **L6** `src/renderer/stores/boardHistory.ts:183` — inverse `JSON.parse(JSON.stringify(v))` drops `undefined`-valued keys. *Fix:* normalize `undefined` sub-values to explicit deletes, or accept (documented `$state`-safe clone).
- **L7** `src/renderer/commands/kanbanCommands.ts:1032` — `UpdateOrphanFrontmatterCommand` all-fields-conflict path `markDirty`s with no write. *Fix:* don't `markDirty` when zero fields were applied.
- **L8** `src/renderer/commands/sectionCommands.ts:37` — `AddSectionCommand` shallow-copies a section, aliasing its nested `style`. *Fix:* use `this.snapshot(newSection)` (deep clone) like `DeleteSectionCommand`; drop the inaccurate `allow-shallow` comment.
- **L9** `src/renderer/stores/boardCache.svelte.ts:867` — `syncTileMarkdown` rolls a bespoke `mtime||size` drift guard (coarse-clock residual). *Fix:* route the recovery sync through the gateway drift path, or add a content-hash compare for the same-mtime/same-size case.

---

# Phase 7 — Performance

## H4 — Minimap + Smart-routed connections recompute O(tiles)/A* every pan/zoom frame

- **Status:** `[x]` — done 2026-06-07. **Connections:** `ConnectionLayer`'s
  `renderableConnections` now routes each visible path through a per-connection
  memo (`lib/connections/connectionPathMemo.ts`) keyed on endpoint rects +
  bubbles + resolved `pathType` (+ the spatial `revision` for `smart` only). A
  pure pan re-runs the derived (it still reads `viewportRect` to cull) but every
  signature is unchanged → cached `d` reused → ZERO `computePath`/A* on pan. The
  `revision` is read via `untrack` so a tile move doesn't force the derived to
  re-run every drag frame (which would A*-storm all smart paths), but when the
  derived DOES re-run (pan/zoom/endpoint move) it folds in the latest revision so
  a moved obstacle still re-routes — full behavioural parity with the old code,
  minus the pan cost. `computeSmartPath` also swapped `spatialIndex.all().filter`
  for a bounded `spatialIndex.searchRegion(...)` R-tree query (new method).
  **Minimap:** the all-tiles AABB is split into `tilesAABB =
  $derived(computeTilesAABB(tiles))` (keyed on the tile set only — never re-walks
  on pan) + a cheap `bounds = $derived(computeMinimapBounds(tilesAABB,
  viewportRect))` union (`lib/canvas/minimapBounds.ts`); pips now resolve through
  a `headerColor`-only `effectiveTileHeaderColor` (skips the per-pip WCAG-contrast
  cascade). Tests: `connectionPathMemo.test.ts` (sig pan-invariance + endpoint /
  bubble / pathType / smart-revision sensitivity + memo hit/miss call-count +
  prune), `minimapBounds.test.ts` (AABB + union + pre-split differential),
  `spatialIndex.test.ts` (searchRegion); existing `pathCalc`/`smartPathObstacles`
  validate the region-query routing. **Deferred (optional, documented):** the A*
  binary heap (marginal — memo removes the per-frame cost and searchRegion bounds
  the obstacle set; the linear open-list is MAX_ITER-bounded and well-tested, not
  worth the risk to the A* core) and pip viewport-culling / minimap-off-on-large
  (the headerColor-only resolver already removes the per-pip hotspot). Ceilings:
  markdownFileWriter unaffected; no perf gate (call-count tests are the pins).
- **Severity:** High (jank on large boards) · **Confidence:** High.
- **Files:**
  - `src/renderer/components/canvas/Minimap.svelte:68` (`bounds` reads `viewportRect` → re-walks all tiles every frame) + `:300` (pips not viewport-culled; full WCAG-contrast style cascade per pip)
  - `src/renderer/components/connections/ConnectionLayer.svelte:81` (`renderableConnections` reads `viewportRect`) → `src/renderer/lib/connections/pathRouter.ts:118` (`computeSmartPath` calls `spatialIndex.all()` + A* per smart connection, per frame)

### Root cause
A pure pan changes only the CSS transform, not world coordinates — but both
derived recompute on `viewportRect`, so connection paths and minimap geometry are
re-derived every frame. Smart routing additionally runs `spatialIndex.all()` +
A* (linear open-list scans) per connection.

### Fix
1. **Connections:** memoize each connection's path `d` keyed on its endpoints'
   positions/sizes + resolved style; recompute only when an endpoint actually
   moves, not on pan. For smart routing, query rbush by the path-region rect
   instead of `spatialIndex.all()`, and use a binary heap for the A* open set.
2. **Minimap:** cache the all-tiles AABB in a `$derived` keyed on the tile **set**
   (not `viewportRect`); combine cheaply with the viewport rect (min/max of two
   rects). Use a `headerColor`-only pip resolver (skip the contrast-text cascade).
   Optionally viewport-cull pips, or default the minimap off on large boards.

### Test / Gate
- A targeted test asserting the connection-path derived does **not** recompute
  (spy on `computeSmartPath` / `computePath` call count) on a pure transform
  change. Perf has no CI gate; the call-count test is the regression pin.

## M9 — every external tree change triggers multiple full-vault walks

- **Status:** `[x]` — done 2026-06-07 (fix #1, the high-value half). The
  `vault:tree-updated` listener now coalesces bursts through a short trailing
  debounce (`createTrailingDebounce`, new `lib/utils/trailingDebounce.ts`,
  `TREE_UPDATED_DEBOUNCE_MS = 250`) so a sync-storm / multi-file `git mv`
  collapses to ONE `refreshTreeAndCleanup` (tree re-filter/sort + broken-ref
  recompute over every board) instead of one full-vault walk PER event. The
  ordering invariant is preserved by construction: `vault:file-renamed` still
  enqueues immediately, so the debounced reconcile lands AFTER any rename rebind
  (Phase 2.4) — and the debounce only throttles the EXTERNAL watcher path
  (in-app rename/delete/create call `refreshTree()` directly). `cancel()` on
  `listenForChanges` teardown. Test: `trailingDebounce.test.ts` (burst→one fire /
  new-burst→re-fire / cancel-drops-pending). **Fix #2 (per-path broken-ref
  diff) DEFERRED, documented:** the debounce already collapses the storm to a
  single reconcile, and `recompute` is O(total placements) with O(1) Set lookups
  (cheap per call); a per-path reverse index (path → boards) would add a new
  staleness surface in this concurrency-sensitive store for a gain the debounce
  already captures. Revisit only if a single reconcile on a huge vault profiles
  hot. Ceiling: vault.svelte.ts 1706→1709 (documented bump).
- **Severity:** Medium · **Confidence:** High logic / Medium frequency.
- **Files:** `src/renderer/stores/vault.svelte.ts:290` (`treeView` re-filters+re-sorts the whole tree), `:1278` (`refreshTree` → broken-ref recompute over all boards × placements + selection prune).

### Fix
1. Coalesce/debounce `vault:tree-updated` bursts (short trailing debounce) so a
   sync storm collapses to one reconcile.
2. Diff old vs new tree to recompute broken refs only for affected paths rather
   than rescanning all boards.

## L13 / L18 — minor perf

- **Status:** L13 `[x]` ACCEPTED + documented · L18 `[x]` done — both 2026-06-07.
- **L13** `src/renderer/lib/vault/markdownFileWriter.ts` — DECISION: accept the
  per-session `fileState` growth (NOT refcount-evict on unmount). Entries are
  tiny (`{hadBom, eol?}`) keyed by relPath and cleared wholesale on every vault
  swap (`cancelAllMarkdownWrites`); `clearHydrated()` already handles
  rename/delete. Refcount-evict-on-last-unmount was rejected because a wrong
  refcount in THIS gateway (the most data-integrity-sensitive file in the app)
  would drop live hydrate state → a "not hydrated" throw or a BOM/eol regression
  on the next write — for a few-KB upside. Recorded as a `DECISION` comment on
  the `fileState` declaration. Ceiling 1311→1318 (comment-only, documented).
- **L18** `src/renderer/stores/boardCache.svelte.ts` — `findBoardIdForTask` now
  routes through the shared `resolveOwnerCached(taskBoardMemo, …)` reverse-index
  memo (verify-on-hit, so it can never return a stale board), with
  `taskBoardMemo.clear()` added to `resetBoardOwnerMemos` — bringing it to parity
  with its tile / connection / frame / kanban-column siblings (was an
  O(boards×tasks) scan on every keyless persist). Net-zero LOC (held under the
  1000-line limit). Test: `boardCacheTaskMemo.test.ts` (keyless resolve, multi-
  board correctness, unknown-id no-op, verify-on-hit rejects a stale entry).

---

# Phase 8 — Build / deps / types / CI-gate hardening

## M10 — Electron 33 is end-of-life

- **Status:** `[ ]` — **DEFERRED to its own PR** (decision 2026-06-07). Filo is
  pinned to Electron 33 because the rest of the stack (TipTap/ProseMirror, Svelte
  5, Vite 6 / electron-vite 5, electron-builder 25, sharp) was not yet compatible
  with the newer Electron majors at the time of pinning — so this is **not** a
  drop-in bump. Installed is `33.4.11`; latest stable is `42.3.3` (a 9-major jump,
  supported majors ≈ 40/41/42). It requires: a per-dependency compatibility audit
  (TipTap/Vite/electron-vite/electron-builder/sharp against the chosen Electron
  major + its Node/Chromium ABI), a possible native-module rebuild, and a FULL
  E2E + a11y + packaged-app validation pass that can't be run headless in the dev
  sandbox. Track as a standalone, separately-validated PR — never bundle it with
  data-integrity work (it's the only non-localized change in this plan). The rest
  of Phase 8 (M13, L10) is independent of it.
- **Severity:** Medium (security surface) · **Confidence:** High.
- **Files:** `package.json:115` (`"electron": "^33.4.11"`).

### Root cause
Electron supports ~the latest 3 stable majors; 33 is past EOL → no Chromium/
security backports. For an app rendering web content (iframe/media tiles, custom
protocol) and opening arbitrary user files, this is a standing CVE surface that
partly undercuts the recent S1/S2 hostile-vault hardening.

### Fix
1. Upgrade Electron to a supported major. Budget for API churn (BrowserWindow
   options, `webPreferences`, custom-protocol API). Re-run the full E2E + a11y
   suite and the build after upgrade. **Isolate this in its own commit/PR** — it's
   the only non-localized change in this plan.

### Test / Gate
- `npm run build` + `npm run test:e2e` green on the new major; optionally add a
  gate asserting the `electron` major in `package.json` is ≥ a floor.

## M13 — three CI gates are token-presence "theater"

- **Status:** `[x]` — done 2026-06-07. All three gates hardened from token-presence
  to structural, each bite-verified (temp non-conforming → exit 1; restore → exit 0):
  - **`check-no-silent-write-abort.mjs`** — the `!fm) return` `markPathFailed`
    co-presence is now scoped to the ENCLOSING FUNCTION (the match's depth-0→1
    brace block on a string/comment-blanked copy), not the whole file. An unrelated
    sibling-function `markPathFailed('other')` no longer satisfies it. Bite: a
    fixture with `!fm) return` in one function + `markPathFailed` in another → red.
  - **`check-board-path-casefold.mjs`** — name-agnostic + structural. `findBoardIdForPath`
    must resolve via `samePath` ONLY (ANY raw `===`/`!==`/`.startsWith(` in its body
    is forbidden, regardless of operand names). `renameBoardPath`: the rebind `for`
    loop must FOLD each entry (`normalizeVaultRelative(` INSIDE the loop) and every
    compare line in it must reference a folded value (a local assigned from
    `normalizeVaultRelative` or an inline call). The L2 byte-identical true-no-op
    (`normalizePath(old) === normalizePath(new)`) lives OUTSIDE the loop and is
    correctly NOT examined. Bite (both): a renamed raw compare the old name-pinned
    patterns would miss → red; the L2 line stays green.
  - **`check-awaited-writes-bounded.mjs`** — the race must include the timeout
    promise IN the `Promise.race([…])` array (not just call `Promise.race`); the
    timer must `resolve(WRITE_TIMEOUT)` and the outcome compare `=== WRITE_TIMEOUT`;
    each `writeTimeoutMs` must reference a finite SCREAMING_SNAKE constant (the old
    `:\s*\w` also matched `Infinity`) and is explicitly forbidden from
    Infinity/undefined/null/NaN; and the root `WRITE_TIMEOUT_MS` constant must be a
    finite numeric literal. Bite: `writeTimeoutMs: Infinity` → red (the old gate
    passed it).
- **Severity:** Medium (false confidence) · **Confidence:** High (bite-tested by the auditor).
- **Files:**
  - `scripts/check-no-silent-write-abort.mjs:168` — the `!fm) return` ban is suppressed if `markPathFailed(` appears **anywhere in the file**, not the same function (bite-tested: an unrelated `markPathFailed('other')` re-opens the silent-drop).
  - `scripts/check-board-path-casefold.mjs:102` — the `forbidden` patterns pin exact prior local-variable names; renaming locals + a no-op `normalizeVaultRelative()` call evades.
  - `scripts/check-awaited-writes-bounded.mjs:69` — pure `token.test(code)` presence; a `Promise.race` that no longer includes the timeout, or `writeTimeoutMs: Infinity`, passes.

### Fix
1. **no-silent-write-abort:** scope the `markPathFailed` co-presence requirement to
   the **same function body** (the gate already brace-matches bodies elsewhere).
2. **board-path-casefold:** assert the compare *uses* the fold helper — forbid any
   raw `===`/`!==`/`.startsWith(` between two path-typed locals not wrapped in
   `samePath`/a folded form — instead of matching specific names.
3. **awaited-writes-bounded:** assert `writeTimeoutMs` is set to a **finite
   constant** reference (and that the `Promise.race` includes the timeout symbol).
4. Bite-test each (temp non-conforming fixture → exit 1; revert → exit 0).

## L10 — `copyFileToVault` + EXDEV move are non-atomic

- **Status:** `[x]` — done 2026-06-07. Both new-file writers now follow the
  project's uniform temp→fsync→atomic-rename→dir-fsync contract:
  - **`copyFileToVault`** ([src/main/vault/fileOps.ts](src/main/vault/fileOps.ts)) —
    the O_EXCL candidate-loop open is kept but DEMOTED to a NAME reservation (a
    0-byte placeholder — preserves the Phase-1.2 collision-safety vs a concurrent
    same-basename copy); the bytes now stream in 64 KB chunks into a sibling
    `<dest>.<nonce>.tmp` (TOCTOU fstat + `maxBytes` cap unchanged), `fsync`, then an
    atomic `rename` OVER the placeholder (with a transient-Windows-lock retry) +
    dir-fsync. A reader or a crash mid-stream never observes a torn partial at the
    final name. On non-fatal failure BOTH the temp and the placeholder are unlinked;
    on ENOSPC/EIO/ENOMEM (or rename-retry exhaustion) the temp is preserved
    (placeholder dropped) and attached via `preservedTmpPath`.
  - **EXDEV move** (`renameItem`) — the cross-filesystem fallback was a bare
    `copyFile(old → new)` + `unlink`; now it copies into a temp, `fsync`s, atomically
    renames, best-effort dir-fsyncs, THEN unlinks the source. (Streamed copy, not
    `atomicWriteFile`, so a large media file isn't loaded whole into memory.)
  - Tests: `copyFileToVaultAtomic.test.ts` — the existing 7-case O_EXCL contract
    stays green (its `'wx'` mocks intercept the temp write), the ENOSPC case gained
    an atomicity assertion (no torn file at the final name; preserved path is the
    `.tmp`); `renameItem.test.ts` gained an EXDEV staged-copy case. Bite-verified
    (disable the placeholder cleanup → the cleanup + atomicity cases go red).

---

# Phase 9 — Strict optional-index typing (deferred from Phase 8)

> Moved out of Phase 8 by decision (2026-06-07): a large, mechanical,
> self-contained migration the plan always wanted to "land as its own commit." It
> is independent of the Phase-8 gate/atomicity work and is best reviewed on its
> own.

## L12 — enable `noUncheckedIndexedAccess` in both tsconfigs

- **Status:** `[x]` — done 2026-06-07. Flag set in BOTH `tsconfig.json` and
  `tsconfig.main.json`. All ~513 surfaced sites narrowed DELIBERATELY (no
  blanket-`!`): the dominant pattern was the root-cause `.filter(Boolean)` in
  `layout.ts` (replaced with a real `isTile` type-guard predicate — one fix
  cleared ~100 of its 108 sites); the rest are length/regex-guarded index reads
  (capture-local + `if (x === undefined) continue/return/break`), capture-group
  reads (`m[1] ?? ''` — semantically a no-op since the group is provably
  present), `Map.get`/`splice`/sorted-endpoint guards, and a small number of
  provably-in-bounds tight-loop `!` reads each with a one-line reason (the
  codebase already used `!` here, e.g. `pathRouter.ts`). Folded in 4 pre-existing
  `tsconfig.main.json` strict errors the absent main typecheck had masked
  (`untrusted.ts` reaches `CSS.supports` through a typed `globalThis` so the
  shared file compiles under both the DOM and no-DOM libs; `main.ts` guards the
  nullable `mainWindow`). `npm run check` (svelte-check, 815 files) = 0 errors,
  `tsc -p tsconfig.main.json --noEmit` = 0 errors, `npm run build` green; full
  `npm run ci:verify` green (all 438 test files pass — no behavioural
  regression). Five grandfathered file-size ceilings bumped to actual LOC for
  the narrowing guards (KanbanBoard 1419→1429, KanbanSideToolbar 1500→1504,
  TaskListBoard 2201→2202, markdownFileWriter 1318→1323, kanbanCommands
  1078→1081); `fileWatcher.ts` held at 1000 (guard collapsed to `?? ''`). NOTE:
  CI typechecks the renderer/shared via svelte-check but NOT `src/main` — see the
  "CI enforcement gap" note below.
- **Severity:** Low · **Confidence:** High.
- **Files:** `tsconfig.json` + `tsconfig.main.json` (`strict: true` is on, but
  `noUncheckedIndexedAccess` is off).

### Root cause
With the flag off, every `arr[i]` / `map.get(k)` / `record[key]` is typed as `T`
instead of `T | undefined`, so a genuine out-of-bounds / missing-key read passes
the type-checker and only surfaces at runtime. For data-integrity code
(frontmatter key indexing, tile/placement lookups, board-cache maps) that's
exactly where a silent `undefined` does damage.

### Scope (measured 2026-06-07)
Enabling the flag surfaces **~513 real `T | undefined` sites**: **60** under
`tsconfig.main.json` (`tsc -p tsconfig.main.json --noUncheckedIndexedAccess
--noEmit`) and **453** under the renderer/shared `tsconfig.json` (svelte-check;
74 files). All are the expected indexed-access narrowings, not config noise — hence
the "land as its own commit (large diff)" note, and why it's split out here.

### Fix
1. Set `"noUncheckedIndexedAccess": true` in BOTH `tsconfig.json` and
   `tsconfig.main.json`.
2. Narrow each surfaced site DELIBERATELY — a guard (`const v = m.get(k); if (!v)
   …`), a `?? <fallback>`, or a provably-safe `!`/cast WITH a one-line reason. Do
   NOT blanket-`!` the whole list (that re-buries the exact bug the flag exposes).
   Prioritise the frontmatter / tile-indexing / board-cache reads.
3. Land as its OWN commit, isolated from the Phase-8 work, so it stays bisectable
   and reviewable on its own.

### Test / Gate
- `npm run check` + `npm run build` green with the flag on. No new CI gate needed
  for the renderer/shared — the compiler flag IS the structural enforcement
  (svelte-check runs `tsconfig.json`, which includes `src/renderer` + `src/shared`).
- **CI enforcement gap (renderer enforced, main NOT):** the plan's "the compiler
  flag IS the structural enforcement" premise holds only for the renderer/shared.
  `ci:verify` runs `lint → check (svelte-check) → test:unit:strict → build → gates`;
  `electron-vite build` does NOT typecheck and svelte-check's `tsconfig.json` does
  NOT include `src/main`, so **`tsconfig.main.json` is never compiled in CI.** The
  flag is set there and `src/main` is clean as of this pass (verified locally via
  `tsc -p tsconfig.main.json --noEmit`), but a future `src/main`-only regression
  would NOT fail CI — only the IDE / a manual `tsc -p tsconfig.main.json` catches
  it. To make main's flag structurally enforced, add a `check:main` script
  (`tsc -p tsconfig.main.json --noEmit`) and chain it into `ci:verify` right after
  `check`. Deliberately NOT added in this pass (the plan said "no new gate"; the
  data-integrity-critical shared files ARE enforced via svelte-check). Flagged for
  the maintainer to decide.

---

# Definition of done (per phase)

1. The named test(s) added and passing.
2. The named gate added/extended **and bite-verified** (temp-revert the fix →
   gate goes red; restore → green).
3. `npm run ci:verify` green (exit 0).
4. File-size ceilings in `check-file-sizes.mjs` bumped only if unavoidable, and
   only to the new actual LOC (prefer trimming comments to hold the line).
5. Commit per phase (or per HIGH item) for bisectability.

# What's solid — do NOT refactor

The architecture is sound; these are the load-bearing invariants the fixes must
preserve, not replace:
- **Atomic writes** (temp → fsync → rename → dir-fsync) for all vault content.
- **CST frontmatter engine** byte-exact preservation of untouched keys (comments,
  order, exotic scalars, CRLF+BOM) + **delta-on-fresh-disk** field/Properties write
  source. (H2/M2 fix the *parser edges*, not the engine.)
- **Per-path serialization** in the markdown gateway (`writeChainByPath`). H1 is
  about giving the *other* schedulers the same property, not changing this one.
- **Generation-guarded vault swap** (`vaultIdentity` + `isStillSameVault` across
  reconcilers/cascades/recovery). H3/L16/L17 close residual seams in it.
- **The un-spoofable `vault:register-source-path`** design (sandbox + `z.never()`).
- **Per-board undo stacks capped at 500**, viewport-culled tile rendering,
  incremental MiniSearch, quit-drain heartbeat with bounded deadlines.
- **No memory leaks** were found — caches are keyed and reset on swap.

A committed `package-lock.json` is present → `npm ci` gives reproducible installs;
the `^` ranges in `package.json` are not a drift risk. No action needed.

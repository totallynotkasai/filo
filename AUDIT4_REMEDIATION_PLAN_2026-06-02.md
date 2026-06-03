# Filo — Audit-4 Data-Integrity Remediation Plan (2026-06-02)

Fourth audit cluster (lineage: Audit → Audit2 → Phase 6 / Audit-3 → **Audit-4**).
A bounded **9-agent adversarial sweep** (6 finders + 3 verifiers, refute-by-default)
over the post-Phase-6 working tree, scoped to **data integrity only** — can the
user's notes be lost, corrupted, written to the wrong file/vault, partially
written, or left inconsistent across `.md` / `.board.json` / `.filo` files.
**17 issues confirmed** (4 🟠 high, 4 🟡 medium, 9 🟢 low); **3 finder claims
refuted outright** and recorded in Appendix A so they are never re-chased.

> **Headline (read once, then operate by it).** Your note **bodies are safe** —
> no confirmed path loses body text; `atomicWriteFile`, drain-before-swap, undo
> rollback, and the recovery-sentinel system are genuinely solid (Appendix B).
> The damage is concentrated in **one seam**: Filo *reads* frontmatter with
> **js-yaml** (`DEFAULT_SCHEMA`, YAML 1.1 — resolves `2025-01-15` → a JS `Date`
> and `<<: *a` → a merged map) but *re-serialises* the disk baseline with the
> **`yaml` package** (YAML 1.2 core — keeps them a `string` / a literal `<<`).
> The two libraries disagree, so the source-preserving engine thinks unchanged
> keys "changed" and rewrites them. **One chokepoint (read with `CORE_SCHEMA`) +
> one CI corpus closes the whole class** (DI-01, DI-05, and most of DI-02's
> sibling risk). The rest of Phase 1 is the same engine; Phase 2 is two
> narrow-trigger lifecycle holes. Everything else is medium/low backlog.

---

## Strategy & sequencing (read this first)

Mirrors the Phase-6 philosophy: **close the bug *class* with a chokepoint + a CI
gate**, don't just swat instances. The frontmatter corruption (DI-01/05/06 + the
latent `valuesEqual` collision) is *one* root cause with *one* fix; the CI corpus
extension is what stops it reopening.

- **Phase 1 — Frontmatter write-integrity** lands first. It contains 2 of the 4
  high items (DI-01, DI-02) and absorbs 2 mediums (DI-05, DI-06) for free once
  the read schema is aligned. The `ci:frontmatter-invariant` corpus extension
  ships **in the same commit** as the chokepoint — without it the seam reopens.
- **Phase 2 — Vault-swap & quit loss** lands second. The other 2 high items
  (DI-03, DI-04). Both are narrow-trigger but real data loss; both are small.
- **Phase 3 — Reconciliation & undo targeting** (mediums + the related 4 KB-hash
  low). Defer until 1 + 2 are green.
- **Phase 4 — Low-severity hardening & hygiene.** Re-prioritise from real
  dogfood data; several are one-liners.

**Stopping rule** (definition of "I can trust my notes"). **Phase 1 + Phase 2
land + `ci:verify` green + an independent vault backup exists.** At that point
unquoted-date frontmatter, BOM files, and rapid vault-switching are all safe.
Stop broad auditing; start dogfooding. Phases 3–4 trickle in during use.

## Discipline for every item

1. **Re-grep before editing — line numbers below are from the audit and WILL
   drift.** Anchor on the function name / the quoted code, not the line.
2. Write the regression test, **watch it fail** (especially 🔍 items), then fix
   the smallest thing that makes it pass.
3. For Phase 1, the **CI corpus / gate ships in the same commit** as the fix.
4. `npm run ci:verify` green end-to-end (lint → check → test:unit:strict →
   build → 23 guard scripts). Watch the `ci:file-sizes` ceilings — none of these
   fixes should grow a file materially; if one does, that's a smell.
5. One commit per item where practical; reference the ID (e.g. `DI-01`).
6. Node isn't on PATH — prepend `C:\Program Files\nodejs` for any npm/node run.
   Watch for the CRLF edit-flip: `git diff --stat` before every commit.

## Legend

- **Severity:** 🟠 High · 🟡 Medium · 🟢 Low — (no 🔴: the high items are
  corruption/narrow-loss, not guaranteed total loss; body content is never lost)
- **Confidence:** ✅ confirmed (traced + verifier-confirmed; DI-01 also
  library-reproduced) · 🔍 reproduce-with-a-failing-test-first
- 💾 = can lose / corrupt / desync user data
- **Effort:** S ≈ <½ day · M ≈ ½–1.5 days · L ≈ multi-day

## Issue → phase map (cross-references the audit report #N 1:1)

| ID | Report # | Title | Sev | Phase |
|----|----------|-------|-----|-------|
| DI-01 | #1 | Unquoted YAML dates rewritten to ISO timestamps | 🟠💾 | 1 |
| DI-02 | #2 | BOM `.md` gets duplicate frontmatter on tag-add | 🟠💾 | 1 |
| DI-05 | #5 | YAML merge keys (`<<: *a`) inlined/destroyed | 🟡💾 | 1 |
| DI-06 | #6 | Folded scalars (`>`) reflowed on untouched key | 🟡💾 | 1 |
| DI-03 | #3 | Fast vault-swap writes old vault's tags.json into new | 🟠💾 | 2 |
| DI-04 | #4 | 5 s quit timer destroys window over open "Save failed" dialog | 🟠💾 | 2 |
| DI-07 | #7 | 4 KB rename-correlation hash mis-pairs files | 🟡💾 | 3 |
| DI-08 | #8 | Task List `lastView` persists into the wrong board | 🟡💾 | 3 |
| DI-15 | #15 | 4 KB `.board.json` change-hash misses deep edits | 🟢💾 | 3 |
| DI-09 | #9 | Same `.md` TextTile+DocumentEditor body-write race | 🟢💾 | 4 |
| DI-10 | #10 | `atomicWriteFile` dir-fsync best-effort on Windows | 🟢 | 4 |
| DI-11 | #11 | Envelope-level passthrough keys stripped on board load | 🟢💾 | 4 |
| DI-12 | #12 | Corrupt-config "close to overwrite" is a dead promise | 🟢 | 4 |
| DI-13 | #13 | Orphan frontmatter write (deleted `.md`) swallowed silently | 🟢💾 | 4 |
| DI-14 | #14 | M2 baseline-clear opens a narrow silent-overwrite window | 🟢💾 | 4 |
| DI-16 | #16 | Zero-byte rename/tag sentinel read as "clean" | 🟢💾 | 4 |
| DI-17 | #17 | Hygiene grab-bag (cold-cache rename, dead branch, parity, mojibake) | 🟢 | 4 |

---

# Phase 1 — Frontmatter write-integrity (the js-yaml ↔ `yaml`-package seam)

**Root cause shared by DI-01 + DI-05 (+ the latent `valuesEqual` Date collision):**
`parseMarkdownFile` ([src/renderer/lib/editor/markdownSync.ts:97](src/renderer/lib/editor/markdownSync.ts)),
`loadYamlObject` ([src/renderer/lib/vault/tagRewriter.ts:87](src/renderer/lib/vault/tagRewriter.ts)),
and the vaultIndex frontmatter parser load with js-yaml's **`DEFAULT_SCHEMA`**.
`patchFrontmatterSource` ([src/renderer/lib/vault/frontmatterEngine.ts](src/renderer/lib/vault/frontmatterEngine.ts))
diffs against `doc.toJS()` from the **`yaml` package**. Library probe (run against
the installed `js-yaml`@4 + `yaml`@2):

```
DEFAULT  due: Date   "2026-06-01T00:00:00.000Z"   child: {"x":1,"y":2}
CORE     due: String "2026-06-01"                 child: {"<<":{"x":1},"y":2}
JSON     due: String "2026-06-01"                 child: {"<<":{"x":1},"y":2}
```

`CORE`/`JSON` match the `yaml` serializer exactly. `draft: no` stays a string in
**all** schemas (js-yaml@4 only resolves `true|false` as bool), so the switch does
**not** change boolean parsing — its blast radius is just timestamps, merge keys,
and a few rarely-seen 1.1-only tags.

### DI-01 — Read frontmatter with `CORE_SCHEMA` so reads match the serializer 🟠💾✅ · S(fix)+M(audit)
*Closes DI-01 (dates) and DI-05 (merge keys) at the source.*

- **Mechanism:** live `fm` carries `Date` (js-yaml); baseline `toJS()` yields
  `string` (`yaml` pkg); `valuesEqual` (frontmatterEngine.ts:39) sees
  `typeof 'object' !== 'string'` → `doc.set(key, <Date>)` (`:107`) →
  `yaml` emits the Date as `2026-06-01T00:00:00.000Z`. Fires on **any** other
  frontmatter key changing (tag add, property edit) for a file open as a
  TextTile/DocumentEditor, **and** via the `tagRewriter` fallback with no editor
  open. Filo's own quoted `dueDate`/`startDate` are immune; unquoted
  `created`/`date`/`due`/`scheduled` (Obsidian/templater/hand-authored) are not.
- **Fix:**
  1. `import { CORE_SCHEMA }` (or `yaml.CORE_SCHEMA`) and pass
     `{ schema: CORE_SCHEMA }` to **every** js-yaml `load` of frontmatter:
     - `markdownSync.ts:97` (`parseMarkdownFile`)
     - `tagRewriter.ts:87` (`loadYamlObject`)
     - the vaultIndex parser (`src/renderer/lib/vault/vaultIndex.ts` — the
       `yaml.load` in `parseMarkdown`)
     - **grep `yaml.load(` across `src/renderer`** and convert any remaining
       frontmatter loader (e.g. `frontmatterRebase.ts`, any kanban/tasklist
       frontmatter reader). Do **not** change non-frontmatter YAML (theme files
       etc.) without separate thought.
  2. Each loader is already wrapped in try/catch that degrades to `{}` / `null`
     (refuse-the-write) — so a `CORE` parse that throws where `DEFAULT` didn't
     fails *safe*, never corrupting. Leave those guards in place.
- **Consumer audit (the M part):** grep `instanceof Date` and date-math over
  frontmatter values across the renderer. In-memory date fields change type
  `Date → string`. The recurrence/date helpers already operate on quoted string
  fields, so risk is low — but confirm `lib/tasks/*`, `frontmatterRebase.ts`
  (`fmValueEqual`), and `kanbanCommands.ts` orphan-FM compare don't rely on `Date`.
- **Tests:** round-trip a `.md` with `created: 2025-01-15` + `due: 2025-03-20`,
  add a tag → assert both dates byte-identical. Add to the CI corpus (DI-CIGATE).
- **Risk:** `CORE` also drops 1.1-only octal/sexagesimal/`.inf`/binary/`omap`/
  `set`. Cover a representative corpus; these are vanishingly rare in PKM
  frontmatter and the safe-degrade guards catch parse failures.

### DI-01b — Harden `valuesEqual` against `Date` / non-plain objects 🟢💾✅ · S
*Belt-and-suspenders for the latent collision (audit finding F1-2).*

- **Mechanism:** `frontmatterEngine.ts:48-60` object branch compares
  `Object.keys().length` then recurses; `Object.keys(new Date())` is `[]`, so
  `valuesEqual(new Date('2025-01-01'), new Date('2030-01-01'))` returns **true**
  (probe-confirmed). Masked today by DI-01's type-mismatch; becomes a silent
  **drop of a date edit** the moment both sides are Dates (e.g. a naive DI-01
  fix). Also `doc.set(key, <Date>)` must never re-emit ISO.
- **Fix:** before the generic object branch add
  `if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && +a === +b;`
  and, in the `doc.set` loop, coerce any residual `Date` value to its
  `YYYY-MM-DD` (or full ISO date) string form rather than passing the raw `Date`.
- **Test:** unequal Dates → false; equal Dates → true; a forced `doc.set` of a
  date value emits a plain date, never `…T00:00:00.000Z`.

### DI-02 — Strip the BOM in `tagRewriter.splitFrontmatter` 🟠💾✅ · S

- **Mechanism:** `tagRewriter.ts:25` `FRONTMATTER_FENCE` is anchored at `^---`;
  `splitFrontmatter` (`:52-81`) runs it on raw bytes and — unlike
  `parseMarkdownFile` (`markdownSync.ts:73-74`) — never strips a leading
  U+FEFF. A BOM file → `hasFrontmatter:false` → `addTagToMarkdown` (`:414`)
  **prepends a second `tags:` block**, demoting the real frontmatter (title,
  dates, tags) into the body; `rewriteTagInMarkdown`/`removeTagFromMarkdown`
  instead silently return unchanged. (CRLF was handled at `:73`; BOM was the gap.)
- **Fix:** mirror `parseMarkdownFile`: in `splitFrontmatter` capture
  `hadBom = raw.charCodeAt(0) === 0xfeff`, slice it before the fence match, return
  `hadBom` in the result struct, and have `reassemble` (≈`tagRewriter.ts:100`)
  prepend `'﻿'` when `hadBom`. This also un-breaks rename/remove on BOM files.
- **Test:** a BOM-prefixed `.md` with `title:` + `tags:` → add a tag → assert
  **one** frontmatter block, BOM at byte 0, nothing demoted to body; rename/remove
  a tag → assert the field actually changes. Add BOM variants to the CI corpus.

### DI-05 — YAML merge keys (`<<: *a`) 🟡💾✅ · (closed by DI-01)

- **Mechanism:** `doc.toJS()` keeps `<<` literal while js-yaml resolves it →
  `valuesEqual` unequal → `doc.set` writes the resolved, `<<`-less map,
  destroying the merge reference (probe-confirmed:
  `yaml → {"<<":{"x":1},"y":2}` vs `js-yaml → {"x":1,"y":2}`).
- **Fix:** **none separate** — switching reads to `CORE_SCHEMA` (DI-01) makes
  js-yaml keep `<<` literal too, so the two sides agree and the node is left
  untouched. Add a merge-key case to the CI corpus to lock it.

### DI-06 — Folded block scalars (`>`) reflowed on an untouched key 🟡💾✅ · S(doc)/L(fix)

- **Mechanism:** `patchFrontmatterSource` re-serialises the whole doc via
  `doc.toString({ lineWidth: 0 })` (`frontmatterEngine.ts:113`); `lineWidth:0`
  disables folding, so an untouched `summary: >` multi-line scalar loses its
  soft-wrap breaks when some *other* key changes. Value is semantically preserved
  (folded `>` joins with spaces); literal `|` scalars are unaffected.
- **Fix (choose):** (a) **Accept** — add a one-line note to
  [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) (lowest ROI, value is safe), or
  (b) **Preserve** — skip re-serialising nodes whose CST is unchanged (emit their
  original source range verbatim); the `yaml` package retains tokens for nodes
  `doc.set` never touched. Recommend (a) now, (b) only if a user reports it.

### DI-CIGATE — Extend the frontmatter-invariant corpus (ships with Phase 1) ✅ · S

- Extend [scripts/check-frontmatter-invariant.mjs](scripts/check-frontmatter-invariant.mjs)
  (the `ci:frontmatter-invariant` hostile corpus) with inputs that currently slip
  through: **unquoted dates** (date-only + date-time), **leading BOM** (alone and
  BOM+CRLF), **anchors + merge keys**, **folded `>` scalars**, **special-char
  tags on BOM files**. Assert: no key dropped, no value reformatted, no duplicate
  frontmatter block, body byte-identical. This is the structural invariant that
  stops the class reopening — without it, the next refactor re-introduces it.

---

# Phase 2 — Vault-swap & quit data-loss holes

### DI-03 — `runPostCommitTasks` writes the old vault's tags into the new vault 🟠💾✅ · S(fix)+M(test)

- **Mechanism:** `runPostCommitTasks`
  ([src/renderer/stores/vault.svelte.ts:453](src/renderer/stores/vault.svelte.ts))
  is `void`-fired from `openVault` and returns immediately. Its rebuild closure
  (`:474-539`) `await`s `applyFrontmatterToBackedTilesBatch` (`:495`, which yields
  via `queueMicrotask`) then runs `pruneOrphanFileTags(flattenTreePaths(fileTree,
  newVaultPath))` / `setAll(seed)` (`:501-538`) **with no `isStillSameVault()`
  guard after the await** — unlike the sibling `runRecoverySequencer`, which
  re-checks vault identity after every await. On a sub-300 ms A→B swap, `fileTree`
  is already B's but `newVaultPath` is A's, so the prune computes orphans of B's
  tree against A's path prefix (dropping most/all entries) and `scheduleSave`
  (which reads the live `activeVaultRoot` = B at fire time) writes the mangled
  result into **B's** `.filo/tags.json`. `assertActiveVault` does **not** catch
  it — the target root is legitimately B.
- **Fix:** capture `newVaultPath` (already in scope) and add, immediately after
  the `await` at `:495` and before the prune/seed/`setAll`:
  `if (vaultStore.path !== newVaultPath) return;` (reuse the `isStillSameVault`
  helper the recovery sequencer uses). For extra safety, build the seed from the
  candidate's captured tree rather than the module `fileTree`.
- **Test:** drive `openVault(A)` then `openVault(B)` with the rebuild promise
  resolving after the swap (mock `applyFrontmatterToBackedTilesBatch` to await a
  controllable deferred); assert no `tags:save` IPC fires for B with A-derived
  data. 🔍 watch it fail first.

### DI-04 — 5 s quit timer destroys the window over an open "Save failed" dialog 🟠💾✅ · M

- **Mechanism:** on quit, `main.ts:180-183` (close) and `:411-414` (before-quit)
  call `mainWindow.destroy()` / `app.exit(0)` unconditionally after
  `FLUSH_TIMEOUT_MS = 5000`. On a save failure the renderer
  ([src/renderer/lib/vault/handleFlushAndQuit.ts:45-60](src/renderer/lib/vault/handleFlushAndQuit.ts))
  opens an **open-ended, no-timeout** confirm and only sends
  `app:ready-to-quit` / `app:cancel-quit` after the user clicks. A "Save failed"
  dialog is exactly what a human reads for >5 s → the timer fires first, the
  dialog vanishes, the choice is discarded, edits dropped (recoverable only if the
  failure was ENOSPC/EIO, which preserves a `.tmp`; `.dirty` notifies next launch
  but does not restore). Defeats the intent of the 6.2.H4 blocking-confirm.
- **Fix (heartbeat):**
  1. Add an `app:quit-awaiting-user` channel — register in the `IpcChannel`
     union ([src/shared/types.ts](src/shared/types.ts)), the
     [src/shared/ipcSchemas.ts](src/shared/ipcSchemas.ts) map, and the preload
     `SendChannel` allow-list (so `ci:ipc-parity` stays green).
  2. `handleFlushAndQuit` sends it **before** `openConfirm` on the failure path.
  3. `main.ts` clears/extends the flush timer on receipt, so the 5 s ceiling
     bounds only the automated flush, not human decision time; the existing
     ready/cancel replies then drive the real quit.
- **Test:** unit-assert `handleFlushAndQuit` emits `app:quit-awaiting-user` before
  `openConfirm` on a rejected `save()`. (Electron timer behaviour is E2E-only;
  optional.)

---

# Phase 3 — Reconciliation correctness & undo targeting

### DI-07 + DI-15 — Replace the 4 KB content-hash truncation 🟡/🟢💾✅ · M

- **Mechanism:** `fileWatcher.ts:887` `HASH_PROBE_BYTES = 4096`. (a) **DI-07:** the
  cross-basename rename gate
  ([src/main/services/renameCorrelation.ts](src/main/services/renameCorrelation.ts))
  pairs two same-size, same-ext files whose **first 4 KB** match → `propagateRename`
  rewires tile `file`/`src`/`coverImage` refs to the wrong file (no undo for
  external renames). (b) **DI-15:** the reconcile walk hashes `.board.json` over
  the same 4 KB (`fileWatcher.ts:730-741`), so a >4 KB board edited past offset
  4096 with unchanged size + coarse mtime hashes "equal" → external board edit
  dropped, then overwritten by the local cache flush.
- **Fix:** for `.board.json` (small, bounded count) hash the **whole file**. For
  the rename gate, hash the full file up to the existing 10 MB ceiling (or
  head+tail+mid-sample); the "rewrite tile refs" consequence justifies real
  identity, not a 4 KB prefix. Keep both digests comparable (same algorithm/window
  on the walk seed and the gate).
- **Tests:** two files identical in first 4 KB, divergent tail, equal total size →
  assert **not** paired as a rename. A >4 KB `.board.json` edited past 4096 with
  same size → assert detected as changed.

### DI-08 — Task List `lastView` persists into the wrong board 🟡💾✅ · S–M

- **Mechanism:** the persist timer
  ([src/renderer/components/boards/TaskListBoard.svelte:1139-1167](src/renderer/components/boards/TaskListBoard.svelte))
  calls `updateBoardSettingsWithHistory(patch)` with **no boardId**, so
  `UpdateBoardSettingsCommand`
  ([src/renderer/commands/groupAndBoardCommands.ts:591](src/renderer/commands/groupAndBoardCommands.ts))
  captures the **global** `boardStore.current?.id` at fire time. In split view,
  switching the active pane to board B (without re-running A's pane-local effect)
  makes A's surviving timer write A's `lastView` into **B's** `.board.json` +
  pushes onto B's undo stack. The `$effect` also lacks the inline `clearTimeout`
  cleanup Kanban has (`KanbanBoard.svelte:877-879`, the 6.1.R2 follow-up).
- **Fix:** (a) capture `board.id` in the timer closure at arm time and pass it
  through `updateBoardSettingsWithHistory(patch, board.id)` so the command targets
  the armed board, not the global active one; (b) add
  `return () => { if (filters.lastViewPersistTimer) clearTimeout(filters.lastViewPersistTimer); }`
  to the persist `$effect`, mirroring Kanban. Consider matching Kanban's
  **non-undoable** `updateSettings` for `lastView` so view changes don't pollute
  the undo stack at all.
- **Test:** split-pane sim — arm board A's timer, switch active pane to B, fire →
  assert A's `lastView` lands on A and B's settings/undo stack are untouched.
  Impact is view metadata only (no content), hence 🟡.

---

# Phase 4 — Low-severity hardening & hygiene

> All 🟢. Re-grep first; re-prioritise from dogfood data. Several are one-liners.

### DI-09 — Same `.md` TextTile + DocumentEditor body-write race 💾 · S (optional)
- In-flight write guard is keyed by `callerId` (`text-tile:${id}` vs
  `document-editor:${docId}`), so two views of one file don't serialise → IPC
  last-writer-wins on the body. Self-heals via the shared `documentStore` body, so
  transient. **Fix:** key the in-flight serialization (and ideally the debounce)
  by resolved `relPath` in addition to `callerId`, or coalesce callerIds that
  resolve to the same path.

### DI-10 — `atomicWriteFile` dir-fsync best-effort on Windows · S (doc)
- [src/main/vault/filenameUtils.ts:271-304](src/main/vault/filenameUtils.ts) — the
  file-handle fsync (data durability) holds; only the **directory** fsync (rename
  durability) is swallowed on Windows. Failure mode is "lose the last write," never
  corruption. **Fix:** confirm/extend the [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md)
  note; native `FlushFileBuffers` on the dir handle only if a user hits it.

### DI-11 — Envelope passthrough keys stripped on board load 💾 · S
- [src/renderer/lib/boards/boardLoader.ts:569-574](src/renderer/lib/boards/boardLoader.ts)
  rebuilds `normalised = { board, tileDefs, connections, frames }`, discarding
  unknown top-level envelope keys that `V7BoardFileDataSchema.passthrough()`
  ([src/renderer/schema/boardFile.ts:64-70](src/renderer/schema/boardFile.ts))
  promises to preserve. No current keys → latent forward-compat only. **Fix:**
  spread the parsed envelope (`{ ...data, board: …, tileDefs: …, … }`) so unknown
  top-level keys survive load → cache → save; add a round-trip test.

### DI-12 — Corrupt-config "close to overwrite" dead promise · S
- `clearCorruptConfigTarget`
  ([src/renderer/lib/boards/configWriteScheduler.ts:97-99](src/renderer/lib/boards/configWriteScheduler.ts))
  has no production caller, and the toast
  ([src/renderer/lib/vault/vaultCandidate.ts:214](src/renderer/lib/vault/vaultCandidate.ts))
  has no action wired. Safe direction (corrupt file preserved), misleading copy.
  **Fix:** drop the "or close this toast to overwrite with defaults" clause **or**
  wire a "Use defaults" action that calls `clearCorruptConfigTarget(target)` +
  `lastWrittenConfigs.delete(target)` (mirror the 6.4.M12 dedup-clear).

### DI-13 — Orphan frontmatter write (deleted `.md`) swallowed silently 💾 · S
- [src/renderer/lib/boards/frontmatterWriteScheduler.ts:215-220](src/renderer/lib/boards/frontmatterWriteScheduler.ts) —
  the `docId === null` orphan path does `catch { return; }` **before**
  `trackComponentWrite`, so an ENOENT (backing `.md` deleted out-of-band) drops a
  Kanban/Task field edit with no toast/sentinel while the board cache still shows
  it. **Fix:** in that catch, `markPathFailed(vaultRoot, relPath)` (+ optional
  toast) before returning, matching the write-phase ENOENT discipline. Keep the
  refuse-to-resurrect-a-deleted-file behaviour; just make the loss visible.

### DI-14 — M2 baseline-clear-on-stat-failure silent-overwrite window 💾 · S
- `refreshOrClearBaseline`
  ([src/renderer/lib/vault/fileBaselineRegistry.ts:189-205](src/renderer/lib/vault/fileBaselineRegistry.ts),
  called from markdownFileWriter/board/config) **deletes** the drift baseline when
  the post-write stat fails → the next write skips the pre-write drift check. The
  fs.watch pipeline is an independent backstop (it never reads the baseline), so a
  real miss needs a triple coincidence (stat failure + concurrent external edit +
  that edit evading the watcher). **Fix:** on stat failure **keep** the prior
  baseline (safe failure direction — accept the spurious "modified externally"
  prompt M2 was trying to suppress), or optimistically stamp the just-written
  size. Document the decision; the M2 false-positive trade-off is real, so weigh it.

### DI-16 — Zero-byte rename/tag sentinel read as "clean" 💾 · S
- `renameCascadeSentinel` / `tagRewriteSentinel` `readSentinelInternal` return `{}`
  on zero-byte content — asymmetric with the 6.4.M5 `.dirty` fix (which treats
  zero-byte as dirty). A crash that creates but doesn't fill the sentinel strands a
  partial cascade. **Fix:** treat a present-but-empty sentinel as
  `{ unreadable: true }` so the recovery UI surfaces it. (Partial cascades also
  surface via broken-ref detection, hence 🟢.)

### DI-17 — Hygiene grab-bag · S each
- **Cold-cache rename:** when both size and hash probes are null
  (`renameCorrelation.ts:133`), refuse to pair on basename alone (cold cache is
  exactly when identity is unknowable).
- **M1 dead branch:** the H13 stale-cache re-read
  (`markdownFileWriter.ts:525-542`) is unreachable after the M1 docId keying
  (monotonic version ⇒ `lastFlushed > cacheVersion` can't hold). Delete it with a
  comment, or keep + document — a test can't exercise it.
- **Tags-only rename sentinel:** when `hasCascadeWork` is false but tags were
  affected (`vaultExternalChanges.ts:615`), write a minimal sentinel (or force a
  synchronous tags re-flush) before the early return so a failed tags flush can be
  re-asserted on next open.
- **M9 parity:** add `[ \t]*` to the vaultIndex fence regex
  (`vaultIndex.ts:322`) for true parity with `parseMarkdownFile`, or fix the now-
  stale "mirrors parseMarkdownFile" comment (`vaultIndex.ts:312-314`).
- **Mojibake:** re-save [src/renderer/commands/replaceAllCommand.ts](src/renderer/commands/replaceAllCommand.ts)
  as clean UTF-8 — three mangled em-dashes are in **user-facing toast strings**
  (`:255`, `:299`, `:315`), not just comments.

---

## Appendix A — Refuted / non-issue (do NOT re-chase)

The adversarial pass killed these finder claims; recorded so a future audit
doesn't resurrect them:

- **"Vault swap abandons in-flight writes."** *Refuted.* `flushAll()` snapshots
  and `await`s the in-flight write promises **before** `pre-swap`
  (`writeScheduler.ts`), and `assertActiveVault` rejects any stale-root write.
- **"Board reconciler clobbers other boards' edits."** *Refuted.* The finder had
  the order inverted — the cache spread in `reloadBoardFromDisk`
  (`vaultExternalReconcilers.ts`) happens **after** the `await loadBoard`, capturing
  live state, with no interleaving await before `replaceCache`. `guardPending`
  covers the same-board case.
- **"Self-write post-write index/snapshot stamps the wrong vault."** *Refuted.*
  Both `recovery:snapshot` and the post-write `restoreMetadata` are gated by
  `assertActiveVault`; the gated write rejects before the index stamp runs.
- **"Frontmatter-only external edit loses an in-memory field edit."** *Refuted /
  by-design.* `isPathPending` (incl. the markdown gateway's armed-debounce probe)
  converts the sync into a conflict prompt; the only residual is post-flush where
  memory already equals disk. "Frontmatter wins" as designed.
- **"`recovery:snapshot` swallowed `.catch` hides a failure."** *Refuted.*
  Best-effort by design; the unreadable-sentinel toast already fired.
- **"`applyTagsLineRewrite` reference-equality no-op is fragile."** *Non-issue.*
  String `===` is value equality in JS; even a reconstructed-identical string
  compares equal.
- **"`before-quit` skips flush when the renderer is gone."** *By design.* You
  can't IPC a dead renderer; the `.dirty` sentinel (written proactively at write
  schedule, not at quit) is the safety net.

## Appendix B — Verified solid (do NOT touch without cause)

- **`.board.json` atomicity** — true crash-safe write
  (`open → write → fsync(fd) → close → rename → fsync(dir)`, nonce temp, EPERM/
  EBUSY retries, ENOSPC temp-preservation). A crash mid-write cannot corrupt a
  board file. Same path for config/themes.
- **Undo/redo** — snapshot-before-mutate, rollback-on-failure (execute/undo/redo),
  per-board stacks, `targetBoardId` auto-switch, `BatchCommand` LIFO rollback,
  `CascadeDeleteCommand` body-before-placement restore.
- **Recovery sentinels** — `.dirty` written before risky writes; sentinels
  notify / idempotent-resume rather than blind-restore (no "stale snapshot
  overwrites good data" path found).
- **Body round-tripping** — BOM/CRLF preserved on the body path; lossy-markdown
  detection opens files read-only so a write can't strip syntax tiptap can't keep.
- **Scheduler primitive** — per-fire in-flight buckets, `flushAll` awaits
  in-flight, `withDrainedWrites` drains all five pipelines for rename/delete.

## Appendix C — Test & CI strategy

- **Phase 1 ships its gate** (DI-CIGATE) in the same commit — the corpus is the
  load-bearing invariant.
- Add focused unit tests per item (above); 🔍 items must fail before the fix.
- After each phase: `npm run ci:verify` green; `git diff --stat` to catch a CRLF
  flip; verify no `ci:file-sizes` ceiling tripped.
- **Consider** a new `ci:` ratchet asserting every js-yaml frontmatter `load`
  passes `CORE_SCHEMA` (grep-based), so the DI-01 chokepoint can't silently
  reopen — the Phase-6 "chokepoint + gate" pattern applied to this seam.

## Rating context (from the audit)

Overall data integrity **6/10** today (vs Codex's 8–9) — strong infrastructure,
dragged down by the frontmatter seam (**4/10** for frontmatter write-integrity).
**Landing Phase 1 + Phase 2 lifts frontmatter integrity to ~8 and overall to
~8**, at which point the stopping rule is met and dogfooding is safe.

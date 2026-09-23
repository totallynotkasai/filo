# Task List Board — Data-Integrity Audit & Remediation Plan

**Date:** 2026-06-08
**Branch:** `chore/electron-42`
**Scope:** The Task List board **and its full data path** — the board shell, task/section commands, quick-add, recurrence, multi-select/bulk ops, drag/reorder/indent, the date picker, file-drop, keyboard nav, the frontmatter write/reconcile path, and cross-view sync with Document/Kanban views of the same `.md`.
**Method:** Static analysis (single-parser read of every Task List source file) + 8 parallel adversarial sub-audits + targeted Vitest repros for the pure-logic findings. The investigation deliberately did **not** lean on the prior audit plans (Audit-4…15); it re-derived the model from the code.
**Deliverable:** This document = findings report **+** phased fix plan. No product code was changed.

---

## 0. Executive summary

The **write/reconcile core is sound.** The Phase-4 "delta-on-fresh-disk" architecture genuinely closes the silent-frontmatter-loss class for task field edits, per-path writes serialize correctly, `completed: false` round-trips correctly (not dropped as "empty"), cross-view (Task ↔ Document ↔ Kanban) does not invert edits, and quit/close drains the history chain before flushing. Section commands (Add/Delete/Rename/Reorder) round-trip exactly in the core cases. **No silent-corruption-of-existing-data blocker was found in the write path.**

The real defects cluster in the **logic and reactivity layers** that prior data-integrity audits didn't focus on:

| # | Theme | Worst finding |
|---|-------|---------------|
| A | **Quick-add date parsing** | Invalid dates (`2026-02-30`, `2/30`, `in 99…9d`) written verbatim to canonical frontmatter, then *displayed as a different day* |
| B | **Date picker** | Month navigation is completely broken (a self-resetting `$effect`) — you cannot pick a date outside the current month |
| C | **Recurrence** | Bulk "Mark complete" ignores recurrence and permanently completes repeating tasks; undated repeating tasks silently stop recurring |
| D | **Sections + drag** | Cross-section drag of a subtask (and drag-to-indent across sections) silently desyncs placement from render; adding a task to a 2nd+ empty section misroutes it |
| E | **Inline rename** | Every Enter/confirm rename double-fires and pops a misleading "file is no longer on disk" warning |

### Fix-before-dogfooding set (High)

These 8 are the gate to comfortable daily use. All are confirmed (several with a worked example or a passing Vitest repro):

1. **QA-1/2/3** — Quick-add accepts impossible/overflow dates and writes them to frontmatter. *(repro'd)*
2. **DATE-1** — Date picker month navigation is broken by a self-resetting effect. *(confirmed in source)*
3. **BULK-1** — Bulk "Mark complete" destroys recurrence roll-forward. *(confirmed in source, 2 agents)*
4. **DRAG-1** — Cross-section drag of a subtask persists a placement↔render divergence. *(worked example)*
5. **DRAG-2** — Drag-to-indent can set `parent` to a row in another section. *(worked example)*
6. **SEC-1** — Adding a task to the 2nd+ empty tail section misroutes it into the wrong section. *(worked example)*

The single most *visible* bug is **REN-1** (Medium): inline rename double-fires and shows a false "file no longer on disk" warning on essentially every rename — the likeliest candidate for a bug you already noticed.

Everything else is Medium/Low correctness or polish (Sections §3D, Selection §3F, Notes §3G, date-picker polish §3B, quick-add polish §3A) and can follow in Phases 2–3.

---

## 1. How to read this report

Each finding carries: **ID · Severity · Location · Trigger · Consequence · Evidence · Fix.**
Severity: **Critical** (silent loss/corruption of existing data) · **High** (data-correctness loss in a normal flow, or a broken core feature) · **Medium** (logic error, recoverable / rare) · **Low** (polish, churn, latent).
"*(repro'd)*" = proven with an executed Vitest case; "*(worked example)*" = proven by hand-simulating the index math; "*(unconfirmed)*" = mechanism present, trigger not fully reproduced.

---

## 2. Severity-ranked index

**High (8)**
- QA-1 — Quick-add stores impossible ISO date verbatim (`2026-02-30`)
- QA-2 — Quick-add `M/D` rolls impossible day to wrong date **and** next year (`2/30` → `2027-03-02`)
- QA-3 — Quick-add numeric overflow writes `NaN-NaN-NaN` as the due date
- DATE-1 — Date picker month navigation is defeated by a self-resetting `$effect`
- BULK-1 — Bulk "Mark complete" destroys recurrence roll-forward
- DRAG-1 — Cross-section drag of a subtask → placement↔render divergence
- DRAG-2 — Drag-to-indent across sections sets `parent` to a foreign-section row
- SEC-1 — Adding a task to the 2nd+ empty tail section misroutes it

**Medium (9)**
- REN-1 — Inline rename double-fires → false "file no longer on disk" warning
- REC-1 — Undated repeating task in schedule mode silently stops recurring on completion
- REC-2 — Recurring redo replays a stale `dueDate`; rebase can split the coupled `{completed,dueDate}` write
- WRITE-1 — `markAllIncomplete` silently skips docId-less tasks + reports a wrong count
- NOTES-1 — `setNotesBody` for a docId-less task silently discards the typed note
- SEL-1 — Selection not cleared after non-delete bulk ops → next bulk op hits hidden rows
- DROP-1 — File-drop omits `targetSectionId` → section misassignment
- SEC-2 — `position > taskCount` persisted to `.board.json` (invariant violation; feeds SEC-1)
- SEC-3 — Undo of "Add section" on a section-less board leaves a permanent materialised default

**Low / latent (≈18)**
- DRAG-3 · DRAG-4 · DRAG-5 · DRAG-6 · DRAG-7 — reorder/indent polish & latent footguns
- SEL-2 · SEL-3 · SEL-4 · SEL-5 — selection staleness & churn
- QA-4 · QA-5 · QA-6 · QA-7 · QA-8 · QA-9 · QA-10 · QA-11 — quick-add token edges
- REN-2 · REN-3 — rename sanitization & stale-overwrite
- DATE-2 · DATE-3 · DATE-4 — date-picker orphan time / undo granularity / keystroke churn
- NOTES-2 — notes write skips the per-writer dirty ledger
- VIEW-1 · VIEW-2 · VIEW-3 · VIEW-4 · VIEW-5 · VIEW-6 — shell polish & maintenance hazards
- SEC-4 — tied-section array order is load-bearing (latent)
- REC-3 — no feedback on recurring roll-forward
- COERCE-1 — hand-edited quoted `completed: "true"` reads as incomplete
- SHARE-1 — two rows backed by the same `.md` → shared docId cache/inverse collision *(conditional)*

---

## 3. Findings

### 3A. Quick-add date parsing — `src/renderer/lib/tasks/quickAddParser.ts`

> The existing `quickAddParser.test.ts` covers invalid **times** (line 136) but has **no** invalid-**date** tests — which is why QA-1/2/3 survived. The recurrence engine already has the correct validator pattern (`recurrence.ts:68` `parseIsoDate`, which round-trip-checks the constructed date). Quick-add's date handlers don't use it.

**QA-1 — Impossible ISO date stored verbatim.** *High · repro'd*
- **Location:** `quickAddParser.ts:149` — `{ re: /\s\^?(\d{4}-\d{2}-\d{2})(?=\s)/, handler: (m) => m[1] }`.
- **Trigger:** `Pay rent 2026-02-30` (also `2026-13-01`, `2026-00-00`).
- **Consequence:** Handler returns the captured string with **zero validation** → the new task's `.md` gets `dueDate: 2026-02-30`. The `yaml` reader keeps it as a string, so it persists. Every UI surface then computes from `new Date(2026,1,30)` = **Mar 2**: `formatDueDateAbsolute` shows "Mar 2", `isOverdue` evaluates Mar 2. Canonical metadata says Feb 30; the app shows/treats it as Mar 2.
- **Evidence:** Vitest repro: `parseQuickAdd('Pay rent 2026-02-30').dueDate === '2026-02-30'` (passes).
- **Fix:** Validate in the handler like `recurrence.ts parseIsoDate` — build `new Date(y, mo-1, d)`, verify the `getFullYear/Month/Date` round-trip, return `undefined` (token stays in the title) on mismatch/out-of-range.

**QA-2 — `M/D` rolls an impossible day to the wrong date and next year.** *High · repro'd*
- **Location:** `quickAddParser.ts:151-160`.
- **Trigger:** `Pay rent 2/30` (Feb 30), `4/31`, `2/29` in a non-leap year.
- **Consequence:** Validates `month 1-12, day 1-31` but **not** day-vs-month. `new Date(2026,1,30)` rolls to Mar 2; Mar 2 < today → `+1 year` → `2027-03-02`. User typed "Feb 30" (typo) and silently gets **March 2nd of next year** as the deadline.
- **Evidence:** Vitest repro: `parseQuickAdd('Pay rent 2/30').dueDate === '2027-03-02'` (passes).
- **Fix:** After constructing `candidate`, verify `candidate.getMonth() === month-1 && candidate.getDate() === day`; return `undefined` if it rolled over (token stays in title).

**QA-3 — Numeric overflow writes `NaN-NaN-NaN`.** *High · repro'd*
- **Location:** `quickAddParser.ts:183-194` — `parseInt(m[1],10)` with no bound; `fmtDate` of an Invalid Date.
- **Trigger:** `Do thing in 99999999999999999999d` (or `in 9999999999m`).
- **Consequence:** Oversized count → `Date` overflow → `fmtDate` returns the literal `"NaN-NaN-NaN"`, written to frontmatter; downstream treats it as no-date (sorts oddly, never overdue).
- **Evidence:** Vitest repro: `parseQuickAdd('Do thing in 99999999999999999999d').dueDate === 'NaN-NaN-NaN'` (passes).
- **Fix:** Reject `!Number.isFinite(count) || count > ~3650`, or guard `fmtDate` to return `undefined` when `Number.isNaN(d.getTime())`.

**Lower-severity quick-add edges** (Phase 3):
- **QA-4 (Low-Med):** A malformed `@time` (`Meet @99 East St`) is *stripped from the title* even when invalid — text loss (`:135-139` always returns `' '`). Fix: return the original match when `parseClockTime` fails.
- **QA-5 (Low):** `@13pm`…`@23pm` silently accepted as 24h (`parseClockTime` ignores the `pm` when `h>=12`). Fix: when am/pm present, require `1..12`.
- **QA-6 (Low):** `next <weekday>` is inconsistent — same-weekday jumps +7, other weekdays mean "this coming" (`:63 || 7`). Fix: pick one semantic, apply uniformly.
- **QA-7 (Low-Med, UX):** Help panel advertises tokens the parser doesn't implement (`May 20`, `20 May`, `Dec 1`, `noon`, `midnight`, `next week`, `eod`, `p1..p4`) — they silently become title text. Fix: implement them (at least `noon`/`midnight` + month names) or trim the help panel.
- **QA-8 (Low):** A second `@time`/`!priority`/`=status` leaks into the title (non-global replaces). Fix: make them global and drop later matches, or document.
- **QA-9 (Low):** Status/tags written with original case but read lowercased — disk diverges from the canonical view. Fix: lowercase at write.
- **QA-10 (Low):** `!!high` → `high` (not urgent), contradicting the "!! = urgent" help text. Fix: clarify help.
- **QA-11 (Low):** No IME composition guard — `Enter` to commit an IME candidate also submits the task (`TaskQuickAddInput.svelte:60-68`). Fix: early-return on `e.isComposing`.

*Verified sound:* no ReDoS; local-time correctness (no UTC off-by-one); month-end clamp agrees with recurrence; `12am/12pm` correct; empty-title refused; tag adjacency correct; valid dates parse correctly (CONTROL repro passes).

---

### 3B. Date picker — `src/renderer/components/boards/TaskDatePicker.svelte`

**DATE-1 — Month navigation is broken by a self-resetting `$effect`.** *High · confirmed in source*
- **Location:** `TaskDatePicker.svelte:66-74` (re-seed effect) vs `:83-99` (`prevMonth`/`nextMonth`).
- **Trigger:** Open the due-date/start-date picker, click the ‹ / › month arrows.
- **Consequence:** The effect both **reads and writes** `viewMonth`/`viewYear`. `nextMonth()` sets `viewMonth = M+1`; that re-fires the effect, which re-derives `seed` from the unchanged `value`, sees `viewMonth !== seed.getMonth()`, and resets it to `M`. The grid is permanently pinned to the seeded month — you can only reach a handful of adjacent-month days via the 6-week grid padding; **picking a date a month+ out is impossible** (there is no date text field, only the grid + Today/Tomorrow/Next-week chips). The `if` guard prevents an infinite loop but also defeats navigation.
- **Evidence:** Read of lines 63-99: effect dependency set `{value, viewYear, viewMonth}`, body writes `viewYear/viewMonth` whenever they differ from `seed`; navigation only mutates `viewMonth/viewYear`, never `value`, so the reset always wins.
- **Fix:** Re-seed only when `value` (or open-state) changes — track the last-seeded `value` in separate `$state` and reseed only on `value !== lastSeeded`, or seed in an `onOpen`/`$effect.pre` with `untrack(viewMonth/viewYear)`.

**Lower-severity date-picker items** (Phase 3):
- **DATE-2 (Low):** A `dueTime` can be set with no `dueDate` (`:144-147` fires on `oninput` regardless), then it's invisible (the chip only renders inside `{#if dueDate}`, `TaskItem.svelte:856-866`). Fix: ignore time input without a date, or clear `dueTime` when `dueDate` clears, or always render a present time.
- **DATE-3 (Low):** Clearing a due date pushes **two** undo entries (`onClear` → `onSetDueDate('')` + `onSetDueTime('')`, `TaskItem.svelte:946`), and the time clear is a **no-op command** when no time was set. Fix: emit one combined `{dueDate:'',dueTime:''}` patch; skip no-op commands.
- **DATE-4 (Low):** `<input type="time">` arms a full command + debounced write on every `oninput` keystroke (`:144-147`). Fix: debounce or commit on `change`/close.

*Verified sound:* `TaskPropertiesModal.svelte` is **read-only** (renders a frontmatter snapshot as JSON, no write path/Apply/Save) — it cannot lose edits or write the wrong task. Filo's own date read/write is timezone-safe (local-time constructors throughout; the `yaml` reader keeps unquoted dates as strings).

---

### 3C. Recurrence — `src/renderer/lib/tasks/recurrence.ts` + `lib/tasklist/frontmatterWriter.ts`

**BULK-1 — Bulk "Mark complete" destroys recurrence roll-forward.** *High · confirmed in source (2 agents)*
- **Location:** `multiSelectController.svelte.ts:186-198` (`bulkMarkComplete` → `(r) => (r.completed ? null : { completed: true })`). Contrast `frontmatterWriter.ts:170-187` (`toggleCompleted`).
- **Trigger:** Multi-select ≥1 recurring task → "Mark complete" in the bulk bar.
- **Consequence:** Single-row completion of a recurring task does **not** set `completed: true` — it computes `nextDueDate(...)` and writes `{ completed: false, dueDate: next }` (rolls forward). The bulk path stamps `completed: true` with **no recurrence branch**, so each repeating task is marked permanently done and never recurs again. The two "complete" paths diverge silently; there are **no tests** for `multiSelectController`.
- **Evidence:** Read of `bulkMarkComplete` (line 190) — literal `{ completed: true }`, zero `recurrence`/`nextDueDate` reference in the file.
- **Fix:** In the `bulkMarkComplete` per-row patch, replicate the single-row roll-forward (factor `toggleCompleted`'s recurrence logic into a shared helper so they can't drift). Falls back to `{ completed: true }` only when `nextDueDate` is null.

**REC-1 — Undated repeating task in schedule mode silently stops recurring.** *Medium · repro'd*
- **Location:** `frontmatterWriter.ts:170-187`; `recurrence.ts:141` (`if (!currentDue) return null`).
- **Trigger:** A task with `recurrence: weekly`, default `recurrenceMode: 'schedule'`, **no `dueDate`** — check it off.
- **Consequence:** `nextDueDate` returns `null` (schedule mode needs an anchor date), so `toggleCompleted` falls through to `{ completed: true }`. A repeating task gets permanently completed and never schedules its next instance. Since `recurrenceMode` *defaults* to `'schedule'`, this is the default path for an undated repeating task.
- **Evidence:** Vitest repro: `nextDueDate(undefined,'weekly','schedule',NOW) === null` while `nextDueDate(undefined,'weekly','completion',NOW) === '2026-05-22'` (asymmetry, both pass).
- **Fix:** When schedule mode has no `currentDue`, seed the next due from `completedOn` (treat like completion mode for the no-anchor case), or surface a toast and don't silently terminate recurrence.

**REC-2 — Recurring redo replays a stale date; rebase can split the coupled write.** *Medium*
- **Location:** `commands/taskCommands.ts:456-468` (redo → `applyFrontmatterPatchRebased`); `commands/frontmatterRebase.ts:181-195`.
- **Trigger:** (a) Toggle a recurring task complete, undo, redo later. (b) Same, then an external editor changes only `completed` or only `dueDate`.
- **Consequence:** (a) Redo replays the *frozen* `{completed:false,dueDate:D}` — `D` was computed from `new Date()` at first execute and may now be in the past. (b) `applyFrontmatterPatchRebased` resolves conflicts **per key**, so the semantically-atomic pair can be applied partially (e.g. `dueDate` lands, `completed` kept external) — producing a `completed:true` + advanced-`dueDate` state the roll-forward invariant should never create.
- **Fix:** Treat a multi-key recurrence patch as atomic on rebase (any conflict ⇒ prompt/skip the whole patch), and/or recompute the next due at redo time instead of replaying a frozen date.

**REC-3 (Low):** A recurring roll-forward gives no feedback — the checkbox snaps back to unchecked and the date silently changes, reading as "nothing happened." Fix: toast/announce "Rescheduled to <date>".

---

### 3D. Sections — `src/renderer/stores/boardCacheTaskList.ts`, `lib/tasklist/sectionOps.ts`, `commands/sectionCommands.ts`

> Invariant: section `position` is an **absolute index** into the flat `tasks[]`; section *k* owns `[position_k, position_{k+1})`; placements before the first section are the synthetic "Unsectioned" leading bucket. **The core section commands round-trip exactly** (Delete keep/delete-tasks at first/middle/last, Rename, multi-slot Reorder, tileDef snapshot/restore). The defects are at the edges of the empty-section representation.

**SEC-1 — Adding a task to the 2nd+ empty tail section misroutes it.** *High · worked example*
- **Location:** root cause `boardCacheTaskList.ts:302-312` (tail-tie dedup emits `position > taskCount`); manifests in `taskCreation.ts:137-147` (`endOfSectionIndex`), `boardCacheTaskList.ts:121,143-154` (`persistAddTaskPlacement`), `taskListViewModel.svelte.ts:296-303` (`ownerByIndex`).
- **Trigger:** One populated section + add ≥2 empty sections, then add a task to the **second** empty one (footer "Add task", quick-add into it, or context menu).
- **Consequence:** The tail-tie dedup spreads tied empty tail sections to `taskCount, taskCount+1, …` (intended & tested — `boardCacheTaskList.test.ts:386` asserts `[0,3,4]` at taskCount 3). But a section at `position > taskCount` can't own anything: `ownerByIndex` computes `start = max(0, position) ≥ taskCount`, so its range is empty and the new task is owned by an **earlier** section. The explicit "add to section C" intent is lost and the misplacement is persisted.
- **Evidence (worked):** tasks `[t0,t1,t2]`, sections `A@0`; add B, C → stored `A@0,B@3,C@4`. Add t3 to C: `endOfSectionIndex(C)=3`; `persistAddTaskPlacement(_,3,target=C)` → `insertAt=3`, C stays 4, B shifts to 4 → `A@0,B@4,C@4`; `ownerByIndex[3]`: A owns `[0,4)` ⇒ **t3 lands in A**, while B and C stay empty.
- **Fix (root cause):** Stop emitting `position > taskCount`. Pin tied tail sections at `taskCount` and disambiguate by **array order** (exactly how in-range ties already work via `sectionedView`/`sectionIdForPlacementIndex`). Then `persistAddTaskPlacement` should resolve the insert index from the `targetSectionId`'s array neighbours, not the raw clamped numeric position. See SEC-2/SEC-4 — fixing this hardens all three.

**SEC-2 — `position > taskCount` persisted to `.board.json`.** *Medium*
- **Location:** `boardCacheTaskList.ts:307-311`; schema `board.ts:528` (`position: z.number().int().nonnegative()` — no upper bound).
- **Consequence:** The on-disk `position` stops being a valid index into `tasks[]`. Tolerated as "empty" by every range consumer, so invisible until SEC-1 fires or the file is inspected. Survives reload (schema accepts it), seeding further bugs.
- **Fix:** Same as SEC-1 (clamp tail ties to `taskCount`, order-disambiguate). Optionally add a `≤ taskCount` clamp at parse/normalize so the invariant holds on disk.

**SEC-3 — Undo of "Add section" leaves a permanent materialised default.** *Medium*
- **Location:** `sectionOps.ts:80-92` (`ensureDefaultSectionMaterialized`, persisted with **no** command), `:94-111` (`addSection`), `sectionCommands.ts:64-72` (`AddSectionCommand.undo`).
- **Trigger:** On a board with no real sections (virtual `__default__` shown), Add a section then Ctrl+Z. Also `renameSection(__default__,…)` / `toggleSectionCollapsed(__default__)`.
- **Consequence:** Before = `sections: []`; after add+undo = `sections: [{materialised default}]`. Looks identical but the `.board.json` changed across a logical no-op, and there's **no path back to `[]`**. Not data loss, but undo isn't byte-faithful and the transition out of the empty representation is one-way.
- **Fix:** Fold materialisation into `AddSectionCommand` so its undo also strips the auto-created default (when it has no tasks/siblings) and restores `[]`; or normalize a sole zero-task default to `[]` on save.

**SEC-4 (Low, latent):** Tied-section disambiguation relies on **incidental array order** (later section owns the slice, earlier is empty). All current builders emit empty-before-populated, so no live trigger — but a future path (or hand-edited file) that lists populated-before-empty at an equal position would silently transfer the populated section's whole slice to the empty one. Fix: make `persistTaskListStructure` deterministically order zero-length ties first (it already knows `tasks`/`taskCount`).

---

### 3E. Drag / reorder / indent — `src/renderer/lib/tasklist/taskDragController.svelte.ts`, `blockMove.ts`, `indentGesture.ts`

**DRAG-1 — Cross-section drag of a subtask → placement↔render divergence.** *High · worked example*
- **Location:** `taskDragController.svelte.ts:456,462,494,528` (single-row branch); enabled by `TaskItem.svelte:614-629` (drag handle rendered for `depth>0` rows) + `TaskListSection.svelte:312-322` (every flattened row is a dnd item).
- **Trigger:** Drag a subtask `c` (frontmatter `parent: p`, `p` in section A) into section B and drop.
- **Consequence:** `blockIds = [c]` (a leaf has no descendants) ⇒ `isMultiDrag=false`; `isSameSection=false` ⇒ the indent/outdent branch is skipped ⇒ **`parent` is never cleared**. The single-row rebuild moves `c`'s *placement* into section B's index range, but `sectionedView` only buckets **top-level** rows and `nestedView` re-nests `c` under `p` (still visible) — so `c` renders under `p` in **section A** while its persisted placement sits in **section B**. The drag appears to do nothing (snaps back) yet `.board.json` is now internally inconsistent, and reload reproduces the divergence.
- **Evidence (worked):** sections `A@0,B@2`, placements `[p,c,b1]`, `c.parent=p`. Drag `c`→B ⇒ rebuild yields placements `[p,c,b1]`, sections `A@0,B@1`; `sectionIdForPlacementIndex(c=idx1)=B`, but render puts `c` under `p` in A.
- **Fix:** When `!isMultiDrag && !isSameSection` and the dragged row has a `parent`, couple the structural move with a `parent` repair — outdent it (clear `parent`) so it becomes top-level in its new section, or only re-parent if the target section already contains the parent. The structural move and the `parent` frontmatter write must be decided together.

**DRAG-2 — Drag-to-indent across sections sets `parent` to a foreign-section row.** *High · worked example*
- **Location:** `taskDragController.svelte.ts:462-477` (indent branch); `indent.targetTileId` from `indentGesture.ts:71-82` (last `[data-task-id]` under the cursor) with **no same-section check**; `commitIndent` (`TaskListBoard.svelte:929-958`) writes `parent` unconditionally.
- **Trigger:** Give a leaf row `x` (section A) a rightward indent shove while the cursor's last hover was over a row `y` in a different section (easy near a boundary / over the leading bucket); the drop finalizes in A.
- **Consequence:** The only guards are depth and cycle (neither fires for a leaf). `commitIndent(x,y)` sets `x.parent=y` with `y` in another section ⇒ `x` renders nested under `y` in `y`'s section while `x`'s placement stays in A — same divergence class as DRAG-1.
- **Fix:** Reject the indent (toast) when `sectionIdForPlacementIndex(x) !== sectionIdForPlacementIndex(y)`, or constrain `indent.targetTileId` to the row immediately above `x` within the same section.

**Lower-severity drag items** (Phase 2/3):
- **DRAG-3 (Low-Med):** The `sectionedView` comment claims placement order but it iterates **sorted** `topLevelRows`; under a non-`manual` sort a cross-section single drag does not flip to manual, so the rebuilt placement order is sorted-order baked in. Membership is still placement-index-based (so no hard corruption), but it churns placement order and the comment/code mismatch is a maintenance trap. Fix: bucket `sectionedView` in placement order (matching its comment) or flip to manual on cross-section moves too.
- **DRAG-4 (Low):** Dropping a row outside all zones (not Escape) commits an identity `MoveTaskBlockCommand` (+ a "Switched to Manual" toast under non-manual sort) — phantom undo entry. Fix: skip the commit when the rebuilt tile-id order is unchanged.
- **DRAG-5 (Low):** `boardCacheTaskList.reorderTaskPlacement` skips section-position adjustment and has **no production caller** (only tests) — a latent footgun if wired to a sectioned board. Fix: delete it, or guard it to no-op-with-warn when `sections.length > 0`.
- **DRAG-6 (Low):** Keyboard `moveFocusedRow` block-vs-section size guard (`taskListKeyboardNav.svelte.ts:161-171`) counts *all* descendants but compares to the *current* section size, so an out-of-section descendant (reachable via DRAG-1/2) can wrongly block a move. Fix: count only in-section descendants.
- **DRAG-7 (Low):** An empty leading "Unsectioned" bucket isn't a drop target (`taskListViewModel.svelte.ts:319-321` only emits it when non-empty). Fix: render a minimal always-present leading zone, or document.

*Verified sound:* parent-with-subtasks drag moves the whole DFS block contiguously (never splits, `parent` untouched); `moveTaskBlock` section-position math (before/after-target shifts, leading/append/offset-clamp) is correct and tested; ESC cancel / source-vs-destination finalize / microtask teardown avoid double-commit; no listener leaks; in-range empty-section ties preserved.

---

### 3F. Multi-select & bulk ops — `src/renderer/lib/tasklist/multiSelectController.svelte.ts`, `TaskBulkActionBar.svelte`, `taskDeletion.ts`

(BULK-1 is in §3C.) There are **no tests** for the multi-select controller.

- **SEL-1 (Medium):** Non-delete bulk ops (`bulkSetPriority/SetDueDate/MarkComplete/MarkIncomplete/MoveToSection`) never `clearSelection()`; only `bulkDelete` does. With a "hide completed" filter, bulk-complete makes rows vanish but keeps them selected, so the bar shows "N selected" for invisible rows and a follow-up bulk op silently acts on them. Fix: clear or prune the selection to `filteredRows` after ops that can move rows out of the active filter.
- **SEL-2 (Low):** Single-row delete / cascade / "delete & file" don't prune `selectedTaskIds`, leaving a stale count. No wrong-tile mutation (`selectedRows()` re-intersects live rows). Fix: prune deleted ids from the selection.
- **SEL-3 (Low):** Shift-click after the anchor row was filtered away collapses the whole selection to the single clicked row instead of extending (`handleRowSelect`, `:86-115`). Fix: treat an unresolved anchor as a new anchor.
- **SEL-4 (Low):** `bulkMoveToSection` seeds from raw `selectedTaskIds` while field ops use `selectedRows()` — `resolveDragBlockIds` makes it safe but the toast count can diverge. Fix: seed from `selectedRows()`.
- **SEL-5 (Low, perf):** Each batched `UpdateTaskFieldCommand.execute()` calls the **global** `flushAllPendingFrontmatterWrites()`, so a 50-row bulk op does ~50 serial disk write+flush round-trips (magnifies the wedge surface on OneDrive/SMB). Fix: scope the pre-flush to the command's own path, or merge-then-flush-once for bulk.
- **SHARE-1 (Medium, conditional/unconfirmed):** If two task rows on one board resolve to the **same** backing `.md` (reachable if dropping the same file twice mints two tileIds with one `contentId`, or an OS-dropped `.md` with a frontmatter `id:` reuses it as `contentId` — `markdownTileSeed.ts:21-59`), a bulk field op's per-row inverse capture reads the cache the prior child already mutated, so undo won't restore the true original; deltas also fold to one path. Fix: first confirm reachability; if reachable, dedup by resolved `relPath` in `bulkApplyFieldPatch` (one command per file) or capture all inverses before executing, and mint a fresh `contentId` on import when the destination path differs from the source.

*Verified sound:* bulk-delete atomicity + undo (BatchCommand, removes placement **and** tileDef, exact restore); bulk-delete leaves unselected subtasks as orphans (never lost); section-position invariant on `bulkMoveToSection`; partial-batch rollback for distinct files; controller remounts per tab (no stale-board capture / leaked listeners).

---

### 3G. Inline rename & notes

**REN-1 — Inline title rename double-fires → false "file no longer on disk" warning.** *Medium · confirmed end-to-end · most visible bug*
- **Location:** `TaskItem.svelte:302-334` (`commitEdit`/`handleTitleBlur`/`onTitleKeydown`) → `TaskListBoard.svelte:762-808` (`renameTask`).
- **Trigger:** Rename a task inline, press **Enter** (or click the ✓ confirm button).
- **Consequence:** `commitEdit()` sets `isEditing=false`, which unmounts the `<input>` and fires `blur` → `handleTitleBlur` → `commitEdit()` **again**. The `cancellingEdit` guard only covers the *Cancel* path. `renameTask` is async and suspends at `await vaultStore.rename(...)`, so the second `commitEdit` runs while `tile.title` is still the old value (its `trimmed === row.tile.title` guard doesn't short-circuit) and dispatches a **second** `renameTask`. The second hits ENOENT (file already moved) and pops a misleading **"Task file '…' is no longer on disk"** warning on essentially every rename. (No data loss — the file ends up renamed once, and the second call returns before pushing history — but it's a constant, confusing glitch.)
- **Evidence:** `onTitleKeydown` (`:329-330`) calls `commitEdit()` with no `preventDefault`/guard; `handleTitleBlur` (`:324-327`) re-commits unless `cancellingEdit`; `renameTask` guards on `row.tile.title`, which only updates after the awaited rename (`:840`).
- **Fix:** Add a one-shot guard inside `commitEdit` (mirror `cancellingEdit`): set a `committing` flag that suppresses the unmount-blur re-commit, or early-return when `!isEditing`. (Check `KanbanCard` rename for the same shape.)

- **REN-2 (Low):** Renaming to an all-illegal-char title (`???`) silently becomes `Untitled.md` with no warning (`renameTask` only toasts on the dedup-suffix mismatch, comparing against the already-sanitized name). Fix: compare against the raw trimmed title and toast when sanitization changed it; or reject like an empty title.
- **REN-3 (Low, unconfirmed):** `editTitle` isn't re-synced if `tile.title` changes externally mid-edit; committing then overwrites the external rename with the stale draft (no rebase like field edits have). Fix: capture title-at-edit-start and abort/prompt on commit if it changed.

**NOTES-1 (Medium):** `setNotesBody` (`frontmatterWriter.ts:223-298`) gates the entire body-capture block on `if (docId)`. For a docId-less task it skips capture and schedules `scheduleFrontmatterWrite(path, null)`, which re-emits the **old disk body** — the typed note is silently lost, with no orphan fallback (unlike field edits, which route docId-less writes through the loud `UpdateOrphanFrontmatterCommand`). Rare (all app-created/dropped tasks have a `contentId`). Fix: route docId-less notes through an orphan body-write (read FM+body fresh, write via gateway, loud-fail).

**NOTES-2 (Low):** `setNotesBody` calls `documentStore.updateContent(docId, html, body)` with **no `writerId`** (`:251`), so the body write isn't tracked in the per-writer dirty ledger; a sibling DocumentEditor on the same file in a split view could have its `isDirty` cleared out from under it. Fix: pass a stable notes `writerId` and clear it on write.

**WRITE-1 (Medium):** `markAllIncomplete` (`frontmatterWriter.ts:300-328`) builds commands via `buildTaskFieldCommand`, which returns `null` for a docId-less task, and the loop has **no else branch** — so those completed tasks stay `completed: true` and the success toast counts only the docId-backed ones ("N marked incomplete" lies). Fix: route the null case through `UpdateOrphanFrontmatterCommand` (mirroring `updateRowField`) and count it.

---

### 3H. Board shell — `src/renderer/components/boards/TaskListBoard.svelte` (all Low)

- **VIEW-1:** `collapsedGroups` (group-by collapse set) is never cleared on a same-tab board switch (`BoardRouter` keys by `tab.id`, not board id), so board A's collapsed "High" group bleeds into board B. Fix: `collapsedGroups.clear()` in the existing `board?.id`-change effect (`:667`).
- **VIEW-2:** `renameTask`'s collision check (`nextUniqueMdPath`) keys uniqueness on tile *titles*, not real `filePath`, so a real-disk collision yields a generic "Failed to rename" toast (the `TARGET_EXISTS` IPC refusal isn't special-cased, only `ENOENT` is, `:802-808`). No data loss (the IPC refuses to clobber). Fix: add a `TARGET_EXISTS` branch with a clear message.
- **VIEW-3:** `commitIndent`'s docId-less fallback (`:935`) returns before the collapsed-parent auto-expand, so an indented child can be swallowed under a collapsed parent. Fix: hoist the expand to run on both paths.
- **VIEW-4:** `cancelSectionDrag` runs on **every** Escape keypress, reassigning `dndSections` (forces re-render) even when no drag is active (`:1377-1395`). Fix: gate on an active drag.
- **VIEW-5:** `lastView` persists `groupBy`/`sortBy` that `hydrateFromLastView` never reads back (they live canonically in board settings), so each sort/group change writes `.board.json` twice and stores dead data. Fix: drop them from `LastViewSlice`/`buildLastView`.
- **VIEW-6:** `onFinalizeSections` (`:454-487`) reconstructs `nextPlacements`/`nextSections` that `ReorderSectionCommand` ignores (it rebuilds from the section-id order only) — dead code + a maintenance trap. Fix: pass only the ordered ids.

*Verified sound:* split-pane safety (host reads `scope.board`, never global `tabStore.activeTab`; commands self-target by board id; `PaneView` activates the pane before in-pane toolbar clicks); `tickAndPersist` discipline (no missing-tick stale-UI path found); no `$effect` loops/leaks; quit/close drains the history chain before flushing.

---

### 3I. Cross-cutting note

**COERCE-1 (Low):** A hand-edited quoted `completed: "true"` parses as the **string** `"true"`, which `FIELD_READERS.completed` (`=== true`) reads as **incomplete** (a bare `completed: yes`/`true` reads correctly). No data loss — a toggle normalizes it to a real boolean and preserves other keys — but the displayed state contradicts the file until toggled. Worth a `KNOWN_LIMITATIONS.md` note.

---

## 4. Phased implementation plan

Each item lists the fix and the regression test to add (no test currently covers most of these). Run `npm run ci:verify` after each phase (note: Node is not on PATH on this machine — prepend `C:\Program Files\nodejs`).

### Phase 1 — Fix-before-dogfooding (High)

**P1.1 — Quick-add date validation (QA-1/2/3).** `quickAddParser.ts`: add a shared `validIsoOrNull(y,mo,d)` round-trip validator (lift the pattern from `recurrence.ts:68`). ISO handler returns `undefined` on invalid; `M/D` handler verifies the constructed date round-trips before the year-roll; `in N` handler bounds `count` (`Number.isFinite` + a sane max) and `fmtDate` returns `undefined` on `NaN` time. *Test:* extend `quickAddParser.test.ts` — `2026-02-30`, `2026-13-01`, `2/30`, `4/31`, `in 99999999999999999999d` all keep the token in the title with no `dueDate`; CONTROL valid dates still parse.

**P1.2 — Date picker month navigation (DATE-1).** `TaskDatePicker.svelte`: re-seed `viewMonth/viewYear` only when `value` (or open-state) changes — track `lastSeededValue` in `$state` and reseed on change, or seed in an open handler with `untrack`. *Test:* component test — open with a value, call `nextMonth()` ×2, assert `monthLabel` advanced two months and `grid` reflects it.

**P1.3 — Bulk-complete recurrence (BULK-1).** Factor `toggleCompleted`'s recurrence roll-forward into a shared `completionPatchForRow(row)` helper in `frontmatterWriter.ts`; use it in both single-row `toggleCompleted` and `multiSelectController.bulkMarkComplete`. *Test:* new `multiSelectController.test.ts` — bulk-complete a recurring + a non-recurring row asserts the recurring one gets `{completed:false, dueDate:next}` and the plain one `{completed:true}`.

**P1.4 — Cross-section subtask drag & indent (DRAG-1/2).** In `taskDragController` single-row branch, when the dragged row has a `parent` and the drop crosses sections, couple the move with a `parent` repair (outdent, or re-parent only into the parent's section). In the indent branch, reject when `sectionIdForPlacementIndex(dragged) !== sectionIdForPlacementIndex(target)`. *Test:* extend `taskDragController.test.ts` with a multi-section fixture — drag a subtask cross-section asserts placement-section == render-section (no divergence); indent over a foreign-section row is rejected.

**P1.5 — Empty-section misroute + on-disk invariant (SEC-1/SEC-2, and SEC-4 hardening).** In `boardCacheTaskList.persistTaskListStructure`, stop emitting `position > taskCount`: pin tied tail sections at `taskCount` and order zero-length ties deterministically first; have `persistAddTaskPlacement` resolve the insert slot from the `targetSectionId`'s array neighbours rather than the raw numeric position. Update `boardCacheTaskList.test.ts:386`'s expectation accordingly. *Test:* add-to-2nd-empty-section lands in that section; `taskListViewModelSectioned.test.ts` gains a `[populated, empty]`-tie ownership case.

### Phase 2 — Correctness (Medium)

- **P2.1 — Inline rename double-fire (REN-1).** One-shot `committing` guard in `TaskItem.commitEdit`; suppress the unmount-blur re-commit. *Test:* component test asserting one `onRename` per Enter/confirm. (Audit `KanbanCard` for parity.)
- **P2.2 — Recurrence undated/redo (REC-1, REC-2).** Schedule mode with no anchor seeds next due from `completedOn` (or toasts, by decision); treat a recurrence multi-key patch as atomic on rebase / recompute on redo. *Test:* `recurrenceRollForward.test.ts` + a redo-staleness case.
- **P2.3 — Orphan-task write gaps (WRITE-1, NOTES-1).** `markAllIncomplete` and `setNotesBody` route docId-less rows through `UpdateOrphanFrontmatterCommand` / an orphan body-write; correct the `markAllIncomplete` toast count. *Test:* docId-less fixtures for both.
- **P2.4 — Selection staleness (SEL-1).** Clear/prune the selection after non-delete bulk ops. *Test:* in `multiSelectController.test.ts`.
- **P2.5 — File-drop section assignment (DROP-1).** Thread `realTargetId` into `AddTaskCommand` in both `fileDropHandler` paths (`:191`, `:297`), like `createTaskInSection`. *Test:* drop onto a non-tail/adjacent-empty section lands there.
- **P2.6 — Add-section undo (SEC-3).** Fold default materialisation into `AddSectionCommand` (undo strips a zero-task auto-default, restoring `[]`), or normalize a sole zero-task default to `[]` on save. *Test:* `taskStructureCommandsRoundTrip.test.ts` — add-then-undo on a section-less board restores `sections: []`.
- **P2.7 — Shared-`.md` rows (SHARE-1).** Confirm reachability first; if reachable, mint a fresh `contentId` on import when the destination path differs, and dedup by `relPath` in `bulkApplyFieldPatch`. *Test:* two-rows-one-file bulk edit + undo.

### Phase 3 — Polish & hardening (Low)

- Quick-add edges: QA-4 (don't strip invalid `@time`), QA-5 (reject `13pm`), QA-6 (`next` consistency), QA-7 (implement or trim advertised tokens), QA-8/9/10/11.
- Date picker: DATE-2 (orphan time), DATE-3 (single combined clear command), DATE-4 (debounce time input).
- Drag: DRAG-3 (placement-order bucketing / flip-to-manual), DRAG-4 (skip no-op commit), DRAG-5 (remove/guard `reorderTaskPlacement`), DRAG-6 (in-section descendant count), DRAG-7 (leading drop zone).
- Selection: SEL-2/3/4/5.
- Rename/notes: REN-2, REN-3, NOTES-2.
- Shell: VIEW-1…VIEW-6.
- Recurrence: REC-3 (roll-forward toast).
- Docs: COERCE-1 → `KNOWN_LIMITATIONS.md`.

### Phase 4 — Anti-regression net — **DONE 2026-06-09** (full `ci:verify` green, exit 0, now **46** gates)

- **DONE** — New `multiSelectController.test.ts` (the controller had no tests before this audit) covers `completionPatchForRow` (BULK-1/REC-1), `bulkMarkComplete` recurrence wiring, selection clear-after-bulk (SEL-1), `pruneSelection` (SEL-2), shift-click lost-anchor (SEL-3) and same-`.md` dedup (SHARE-1). `TaskBulkActionBar.svelte` is **pure-presentational** (it only renders buttons that call host-wired callbacks; its sole logic, `todayIso`/`dateNDaysFromNow`, is trivial) and this repo has **zero component-mount tests** (vitest can't preprocess a `.svelte <style>`), so the bar's behaviour is covered *through* the controller — no separate bar test is added.
- **DONE** (P1.1) — Quick-add invalid-date matrix in `quickAddParser.test.ts` (`2026-02-30`, `2026-13-01`, `2/30`, `4/31`, `in 99999999999999999999d` all keep the token in the title with no `dueDate`; CONTROL valid dates still parse).
- **DONE** (P1.4 / P3) — Multi-section drag/indent matrix in `taskDragController.test.ts` (cross-section subtask drag has no placement↔render divergence; cross-section indent is rejected).
- **DONE** — CI gate **`ci:tasklist-section-clamp`** ([scripts/check-tasklist-section-position-clamp.mjs](scripts/check-tasklist-section-position-clamp.mjs), wired into `ci:verify`): a static ratchet pinning the `[0, taskCount]` clamp + stable sort in `persistTaskListStructure` (`boardCacheTaskList.ts`). REQUIRES the upper clamp `Math.min(<…>, taskCount)` (the bound must be `taskCount`, so swapping it for `sections.length` is caught), the lower clamp `Math.max(0, <…>)`, and a `.sort(`. Closes SEC-1/SEC-2/SEC-4 structurally so a refactor can't silently re-introduce `position > taskCount`. Bite-verified (drop the clamp / swap the bound → red; faithful copy → green). The behavioural matrix it backs is the `[0, taskCount]` / tail-tie / SEC-1 cases in `boardCacheTaskList.test.ts`.

---

## 5. What was verified sound (confidence bounds)

To bound the audit: the following were specifically checked and found correct — **the write path is not the problem.**

- **Field-edit write source:** `UpdateTaskFieldCommand` uses the Phase-4 delta-on-fresh-disk path; untouched/external keys survive by construction; inverse recaptured from a fresh seed.
- **`completed: false` round-trips** (set, not dropped as empty); `mergeFrontmatter` keeps `false`/`0`/`[]`.
- **Per-path write serialization** (drain-prior-in-flight on all fire paths; delta accumulator; failed-write retry) — no out-of-order persistence.
- **Cross-view** (Task ↔ Document ↔ Kanban) does not invert edits (shared live FM cache + gateway reads cache for body saves).
- **Quit/close** awaits `whenChainSettled()` then drains; tab close drains then stays alive.
- **Section commands** Delete (keep/delete-tasks) / Rename / multi-slot Reorder round-trip exactly, incl. tileDef snapshot/restore and in-range empty-section ties.
- **`TaskPropertiesModal` is read-only** (no write path).
- **Split-pane** correctness (pane-scoped board, board-id-targeted commands).
- **Local-time date handling** (no UTC off-by-one in Filo's own read/write).
- **No `$effect` loops or listener leaks** in the shell/controllers; `reorderTaskPlacement` has no production caller.

---

*Generated by a Task List data-integrity audit (8 parallel sub-audits + targeted Vitest repros), 2026-06-08.*

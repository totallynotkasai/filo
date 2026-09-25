# Audit 20 — pre-dogfood audit after the master plan (2026-09-25)

**Scope.** A fresh look at Filo after the seven-phase master plan (board format v8, path as the only note identity, one note model and one writer, deletes to `.filo/trash`, tag undo, tag row and raw view). The focus was on how you'll use it first: Documents, the Mind Map, Kanban and Task List, and vaults in a synced folder or edited by other apps.

**Method.** I read the new core (note writer, note store, disk-change table, conflict prompts, editor bridge, lossy check, vault operations, external-change pipeline, trash, frontmatter undo commands, board write scheduler) and ran the full CI suite. I then checked each suspected bug with a throw-away characterisation spec: the real `App.svelte`, a real temp vault, the real main-process IPC and a real file watcher. Every finding marked **Confirmed** was reproduced that way. The repro spec was deleted afterwards and no source was changed.

**Baseline.** Everything passes: lint (0 warnings), svelte-check (742 files, 0 errors), `typecheck:main`, all 55 gates, and `test:unit:strict` (535 files, 5,330 tests, 1 skipped). None of the findings below is caught by an existing test.

**Not covered in depth:** the IPC security surface (gates pass; not re-audited), export, templates, canvas geometry, accessibility, performance. Playwright E2E wasn't run (it's manual-only in CI).

---

## Resolution (2026-09-25)

Every finding was fixed or documented on branch `audit20/fixes`, following [AUDIT20_IMPLEMENTATION_PLAN_2026-09-25.md](AUDIT20_IMPLEMENTATION_PLAN_2026-09-25.md), which records what was built and every deviation. Each fix started with a characterisation spec that failed for the reason given below.

| Finding | Phase | Status | Where |
|---|---|---|---|
| H1 undo after a rename | 1 | Fixed: every command follows renames (`Command.renamePath`, `'history'` sweep); undo on a gone note throws `NoteGoneError` instead of queueing a write | commit `097185b`; spec `undoAcrossRenames.test.ts` |
| M2 one failed write blocks the vault | 1 | Fixed: scoped `withDrainedWrites(op, { paths })`; a gone-file toast with **Save as new file** / **Discard change** | commit `097185b` |
| H2 external rename while dirty | 2 | Fixed: re-key before the drain; the watcher hides only a note write's own echo, pairs small notes by hash, holds a lone missing `.md` 1.5 s; the renderer waits 3 s before a delete prompt | `2aa2875`; spec `externalRenames.test.ts`; KNOWN_LIMITATIONS #31 |
| H3 false drift after creating a board | 3 | Fixed: the cause was the create's own watcher echo (see H3 below); baselines also only move forward now | `2aa2875`; spec `newBoards.test.ts` |
| M1 close always asks / M3 wrong quit message | 4 | Fixed: close and open save first and ask only if something is left; no "Don't Save"; leaving or quitting anyway keeps rescue copies; the quit text is worded by cause | `2aa2875`; spec `closeVault.test.ts`; KNOWN_LIMITATIONS #4, #33 |
| M4 alignment not saved | 5 | Fixed by keeping it (your decision): aligned or indented blocks are saved as one HTML line. Line Spacing, also found unsaved, is now frontmatter `lineSpacing:` | `2aa2875`; specs `blockLayout.test.ts`, `lineSpacing.test.ts` |
| M5 restyling of other apps' Markdown | 5 | Documented: KNOWN_LIMITATIONS #17 lists every restyling | `2aa2875` |
| M6 synced-vault trash | 6 | Probed on OneDrive: an online-only file goes to OneDrive's web recycle bin, not Windows'. Network share and FAT32 not probed | KNOWN_LIMITATIONS #25 |
| L1 new notes late in the sidebar | 6 | Fixed: every note create re-reads the tree | `2aa2875`; spec `newNotesInSidebar.test.ts` |
| L2 Keep mine backup gap | 6 | Fixed: `backupThenRead` inside `resolveConflict` | `2aa2875` |
| L3 trash restore gap | 6 | Fixed: hard-link restore (EEXIST = taken), re-checked rename fallback | `2aa2875` |
| L4 legacy and redundancy | 6 | Done: `BoardFileData`, js-yaml test-only, the 41 audit-named test files renamed by subject, `tiptap-markdown` in KNOWN_LIMITATIONS #32 | `9c68ee4` (renames), `2aa2875` |
| L5 your real vault | — | Nothing to fix in code (v7 boards are refused by design, #29) | — |

**Commits** (branch `audit20/fixes`, merged to `main`): Phase 1 `097185b` (docs `dd8cb68`); the Phase 6 test-file renames on their own, `9c68ee4`; Phases 2–6 `2aa2875`; Phase 7 docs in the commit that archived this report.

**Checks at the end of Phase 7:** see the plan, "Phase 7 — done".

**Still open (manual):**
- The real-app scratch-vault check after Phases 2–6 (ground rule 4), in particular Phase 4: close with and without a pending edit, delete an open edited note in Explorer and then close, and quit while a note is locked.
- The OneDrive rename gap (#31), and the trash probe on a network share and a FAT32 stick (#25).
- The Empty-trash confirm says "the Recycle Bin can restore them", which isn't true for online-only OneDrive files. A wording change is your call.

---

## Ratings

| Area | Score | Why |
|---|---|---|
| Note content integrity (the `.md` body) | **8.5** | One writer and one queue per note, fresh read per flush, atomic fsync'd writes, and hash-based echo detection. Body drift becomes a prompt, never a silent overwrite. The weak spots are all about renames (H1, H2). |
| Frontmatter fidelity | **9** | CST patching preserves untouched keys byte for byte, with one parser, and BOM and EOL are re-applied. Undo uses inverse deltas with a same-key conflict check. |
| Rename / move / delete | **6** | In-app rename and trash are solid. External renames of an open, edited note and undo across a rename both fail (H1, H2). |
| Undo / redo | **6.5** | The design is sound. Commands keep the note path they were created with, so a rename breaks them (H1). |
| External edits and synced folders | **7** | The conflict prompt, torn-read retry, sync-conflict handling and "reload shrank" guard are good. Other programs' renames aren't followed (H2). The Recycle Bin probe on OneDrive is still pending (KNOWN_LIMITATIONS #25). |
| Board persistence | **7.5** | Drift detection, write serialisation and rename sentinels are all in place. There's a false drift prompt right after a board is created (H3). |
| Crash and quit safety | **8** | The quit drain has a deadline, quit asks before losing edits, and the dirty sentinel works. The close-vault prompt always fires, and one quit message is wrong (M1, M3). |
| Editor fidelity | **7.5** | The lossy check opens anything it can't round-trip read-only. Alignment is silently not saved, and the first edit re-styles Obsidian-flavoured Markdown (M4, M5). |
| Safety prompts (UX) | **6.5** | The prompts exist and back up before overwriting. A few say the wrong thing or show up when nothing is wrong (M1, M3, H3). |
| Code health / architecture | **8** | Clean layering, no TODO/FIXME, and gates pin the invariants. There's some legacy naming and test-file sprawl (L4). |
| Tests and CI | **8.5** | A large, strict suite with a real-app characterisation layer. It had no spec for the three highest findings. |
| **Overall** | **7.5** | The data core is strong. What's left is edge flows around renames, undo and board creation. None of them destroys note text on its own, but H1 and H2 can leave edits unsaved and block the vault until restart. |

---

## High

### H1. Undoing a note edit after the note was renamed fails, then blocks every rename and delete — **Confirmed**

**Steps:** on a Kanban board, set a card's due date → rename the card's note in the sidebar → Ctrl+Z on the board.

**Result:**
- The undo goes to the **old** path. You get `note.missing: Couldn't save changes to "Card.md": the file no longer exists.`, and the renamed file keeps the due date.
- The failed delta stays queued at the dead path and is retried on every drain. Every later rename, move, delete, new folder or file import then fails with *"Couldn't complete the operation — 1 pending write failed: Card.md"*. In the repro, renaming an unrelated note failed.
- It lasts until restart, and quit then shows the "Save failed" dialog.

**Cause:** `NoteFieldCommand.relPath` (and the title, tag and Properties commands) is fixed when the command is created. Board history isn't registered with `registerPathRenamable`, so rename sweeps never reach it. `applyDeltaChecked` defaults to `whenUnreadable: 'apply'`, which queues the delta on the missing path.

**Fix:**
1. Give commands a `renamePath(old, new)` and register a history sweep, or have commands look up their note through a rename-following handle.
2. For a missing file, drop the undo with a toast instead of queueing it (`whenUnreadable: 'throw'`).
3. A note write that failed because the file is gone shouldn't block disk-shape operations on other paths. Give its error toast a Discard action.

Add a characterisation spec for the steps above.

### H2. Another program renaming an open note with unsaved edits is treated as a delete — **Confirmed**

**Steps:** open a note in a Document tab → type → within about 300 ms, rename the file on disk (Explorer, Obsidian, or a sync client).

**Result:**
- Filo shows *"Draft was deleted by another program, but it has edits that weren't saved"* plus a `note.missing` error. The typed text never reaches the renamed file.
- Further typing keeps failing.
- "Keep mine" recreates the **old** filename, so you end up with two copies. "Discard" loses the text.
- The external-rename cascade (relinking board tiles and tags) is refused, because its drain fails on that same path. Boards stay unlinked until the rename sentinel repairs them the next time the vault opens.
- More generally, any failed or held note write anywhere (including an unanswered conflict prompt) makes every external rename skip its cascade.

**Cause:** `handleExternalRename` runs `withDrainedWrites` *before* `renameAllPathKeys`. The drain flushes the queued body to `oldRel`, which no longer exists, gets ENOENT, and so throws `PendingWritesFailedError`.

**Fix:** the file has already moved, so move the note store's queues and models (`renameAllPathKeys`, or at least the writer's `renamePath`) **before** draining. Then the pending body lands on `newRel`, and a failure on the renamed path no longer blocks the cascade. Add a spec.

**Why it matters to you:** on synced vaults, sync clients rename files (conflict copies, case fixes). Obsidian's "rename to match title" does the same.

### H3. False "board modified externally" prompt right after creating a board — **Confirmed**

**Steps:** create a board (any type) and edit it within about 1–2 seconds, for example add a Kanban column and drop a note on it.

**Result:** *"Board file 'Kanban 1.board.json' was modified externally while you had unsaved changes. Reload from disk (discard your edits), or keep your edits…"*. It reproduced in 5 of 5 fast runs across Kanban, Task List and Mind Map, and in 0 of 2 runs with 2.5 s pauses. Clicking **Reload** throws away the edits you just made.

**Not** caused by the latest commit (`dde5075`): it still happens with that line reverted.

**Confirmed cause (Phase 3):** the create's own watcher echo. `board:create` didn't suppress the watcher, and `persistNewBoard` didn't mark the new path as a recent self-write. About 300 ms after the create, the watcher reported the new file as an external change. When the first edit's save was still pending, the reconciler asked (this prompt). When none was pending, it reloaded the board silently.

**First guess, partly right:** the board loader's stat-read-stat baseline stamp (`boardLoader.ts:450`, `noteBaseline`) for the new board lands **after** a newer self-write has already refreshed the baseline. It rolls the baseline back to the create-time mtime, so the next write sees "drift". A stamp should never replace a baseline written after the read began, for example by checking a write generation or keeping the newer mtime. That rollback can happen, but only on the silent-reload branch above, and it was not what raised the prompt. Both are fixed; see the plan, "Phase 3 — done".

**Workaround until fixed** (no longer needed after Phase 3): if this appears on a board you just created, choose **Keep your edits**.

---

## Medium

### M1. Closing the vault (or opening another) always says "You have unsaved changes" — **Confirmed in code**

`vaultStore.closeVault` (`vault.svelte.ts:1132`) and `openVault` (`:1008`) ask Save / Don't Save / Cancel every time, with no check for pending work. That teaches you to click **Don't Save**, which really does drop queued edits: anything still inside the 300 ms debounce, failed writes, and held conflict bodies.

**Fix:** only ask when something is pending or failed (`saveStateStore`, `noteStore.hasPendingWrites`, the scheduler ledgers). Otherwise flush quietly.

### M2. One unresolved note problem blocks disk operations across the whole vault

Held conflict bodies and failed note writes are marked failed (`failHeldBody`, `markPathFailed`). `withDrainedWrites` refuses **every** rename, move, delete, new folder and import while any of them exists.

For a conflict, the sticky prompt gives you a way out. For a `note.missing` failure there isn't one (see H1). Consider limiting the refusal to operations that touch the failed path.

### M3. The quit "Save failed" dialog is wrong for a note that no longer exists

The dialog says another program such as OneDrive may be holding the file, and that emergency `.tmp` files were kept. For an ENOENT note write (H1, H2) there is no `.tmp`, and **Quit anyway** loses the text.

**Fix:** word the message by cause. Before quitting anyway, write each unsaved note body to `.filo/recovery/`.

### M4. Text alignment is silently not saved — **Confirmed**

Centring a paragraph from the toolbar shows it centred, but the file is written with no alignment, so it's gone after a reload. Block indent has the same problem (noted in `createEditor.ts`, but not in KNOWN_LIMITATIONS). Neither is tested.

**Fix:** either persist them (HTML `<p style="text-align:…">` under `html: true`, with a round-trip test) or remove both buttons.

### M5. The first edit re-styles Markdown written by other apps

To avoid opening Obsidian-style notes read-only, the lossy check treats these as equal: `_x_`/`*x*`, `__b__`/`**b**`, `* * *`/`---`, Setext/ATX headings, `1)`/`1.`, `+`/`*`/`-` bullets, and two-space/backslash hard breaks. The first body edit then rewrites them in Filo's style.

Nothing is lost, but every note you touch gets a formatting diff. Sync tools and git will show changes you didn't make, and Obsidian users will see their style change. Add this to KNOWN_LIMITATIONS #17 so it isn't a surprise.

### M6. Synced vault: two open items from the master plan

- `.filo/trash` lives in the vault and syncs (KNOWN_LIMITATIONS #24).
- The Recycle Bin hand-off hasn't been tried on OneDrive, including online-only placeholders (#25).

Run that probe before you use **Settings → Trash → Empty** on a OneDrive vault.

---

## Low

- **L1. New card and task notes appear in the sidebar late.** They only show once the watcher reports them (more than 1.5 s in the harness). This is the same kind of issue `dde5075` fixed for boards. Call `vaultStore.refreshTree()` after the note is created.
- **L2. "Keep mine" backup gap.** `backupExternalVersion` reads and backs up the disk version, then `resolveConflict` reads it again and overwrites. A third write landing in between is overwritten without a backup. The window is milliseconds.
- **L3. Trash restore gap.** `restoreFromTrash` checks the target is free, then renames. On Windows `rename` replaces an existing file, so a file a sync client creates in that gap would be overwritten. Re-check right before the rename, or use a rename that refuses to replace.
- **L4. Legacy and redundancy.**
  - `V7BoardFileData` is still the name of the **v8** board type (147 `v7`/`V7` references across the renderer).
  - `js-yaml` is still a runtime dependency, for one tag-name validator.
  - 41 of 510 unit test files are named by audit phase (`audit14Phase3.test.ts`…) instead of by subsystem.
  - `tiptap-markdown` is a TipTap 2-era package running on TipTap 3. The tests pin it today, but it's the most fragile dependency on the write path.
- **L5. Your real vault.** Its boards are v7 and will be refused (KNOWN_LIMITATIONS #29, by design), so rebuild them in Filo. The notes are fine. The path in my notes (`My Files\Book Vault`) no longer exists, so it has probably moved.

---

## What held up well

- **One writer.** It is the only `.md` writer, reads fresh inside the path's queue, re-stats before writing, skips writes that change nothing, and remembers its own writes by hash.
- **Disk-change handling.** The table (ignore / retry / replace / take-frontmatter / conflict / missing) is simple and correct. Keystrokes waiting to be serialised are pulled into the model before a disk change is judged.
- **Atomic writes.** Main process: temp file → fsync → rename → directory fsync, with a Windows lock-retry budget and exclusive create. Rename refuses to overwrite an existing target and handles case-only renames on Windows.
- **Trash ordering.** The manifest is written before the move, so a crash never loses the item. Manifest paths from a synced folder are validated, and only the machine that trashed an item purges it.
- **Quit.** The drain is time-bounded and never quits silently over unsaved work.

## Before you start using it

*As written at audit time. H1, H2, H3 and M1 are fixed and the OneDrive probe has been run (see "Resolution"), so the three things to avoid in point 1 no longer apply.*

1. **Safe now:** notes and boards in a local vault, if you avoid three things:
   - Don't press Ctrl+Z on a board after renaming one of its notes (H1).
   - Choose **Keep your edits** if the "modified externally" prompt appears on a board you just created (H3).
   - Always choose **Save** when closing the vault (M1).
2. **Before a synced vault, or editing the same notes in Obsidian:** fix H1 and H2 first, and run the OneDrive trash probe (M6).
3. **Suggested fix order:** H1 → H2 → H3 → M1 → M3 → M4 → L1. Each with a characterisation spec that reproduces it first (the repro steps above are ready to turn into specs).

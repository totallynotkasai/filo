# Audit-21 (Pre-Dogfood): Implementation Plan

Source: the 2026-09-26 pre-dogfood audit.
- A 9-agent adversarial data-integrity workflow: 6 finders, then 3 reviewers who tried to refute each finding.
- Three follow-up passes: recent-commit regressions, UI/UX with legacy code, and error states with half-wired UI.
- Result: 51 findings confirmed (22 only partly), 1 refuted, and 7 more raised during review. After de-duplication this plan tracks **74 items**.

The baseline was green when the audit ran:
- lint, svelte-check (0 errors across 758 files), `typecheck:main` and the build all passed;
- 5,594 tests passed (1 skipped) and 61/61 gates passed.

None of the findings below is caught by an existing test or gate.

The user's context sets the priorities. The vault is mostly local, with Syncthing possibly added later. Other programs edit files occasionally while Filo is open. Documents, the Mind Map, Kanban / Task List and tags / rename are all in daily use.

Each phase leaves a working app, passes `npm run ci:verify`, and is committed on its own. Paths are relative to the repo root; line numbers are from `8000241` and will drift. Choices not yet confirmed are marked `DECISION:` with a default, and can be changed before the phase starts.

## Scorecard at audit time

| Area | Score | Main reasons |
|---|---|---|
| Tests & CI | 9 | Very thorough; the gates pin past data-loss bugs. |
| Documents / note write path | 7 | Sound design. Edge cases remain: Raw view loss, text between leading `---` rules deleted, a tag rewrite that breaks YAML. |
| Mind Map canvas | 7 | Minor only (viewport on quit, timer tile). |
| Recent commits (ui-feedback-1, audit20) | 8 | No high-severity regressions. |
| External edits / Syncthing | 6 | Typing during adopt, no main-side stale check, a 7 s watcher blind spot. |
| Error handling & recovery | 6 | Retry buttons that retry nothing; false alarms. |
| Close / quit lifecycle | 6 | Raw view and teardown-time saves are outside the guard. |
| Kanban / Task List | 5 | Cascade undo loses cards; ungated shortcuts; notes box. |
| Tags / search / rename | 5 | A wrapped `tags:` flow list is corrupted vault-wide. |
| UI/UX | 6 | Rich, but shortcuts ignore the board type; error states are unhelpful; there is no app menu. |
| Code hygiene / legacy | 6 | About 40 dead exports; duplicated fence, path and style-popup logic. |
| Documentation accuracy | 7 | About 150 files missing from the CLAUDE.md tree; the test-location rule is wrong. |
| **Overall** | **6.5** | |

Target after Phase 4: no area below 8.

## Phases

| Phase | Scope | Risk | Dogfood gate |
|---|---|---|---|
| 1 | Silent loss or corruption of user text | Medium; touches the Raw view, the tag rewriter, frontmatter assembly and the Task List notes box | **Must be done before the real vault is used** |
| 2 | External edits and sync safety (Syncthing) | High; touches the note writer, the write IPC and the watcher | Must be done before Syncthing is turned on |
| 3 | Honest save state: retries, false alarms, recovery surfaces | Medium | Strongly advised before daily use |
| 4 | The leave / quit / teardown lifecycle | High; reorders vault swap | |
| 5 | Kanban / Task List correctness, undo, shortcuts | Medium | |
| 6 | UI/UX: error states, wording, link popup, filters | Low | |
| 7 | Hygiene, dead code, duplicates, docs | Low; mostly deletions | |
| 8 | Real-app verification, the missing a11y/CSS pass, re-audit | None (no code) | Sign-off |

Phases 1 and 3.1 (the Kanban toolbar) are the minimum for dogfooding on the real vault with a backup. Phase 2 must land before Syncthing is on.

### Cross-cutting rules for every phase

- **Every data-loss fix gets a failing test first.** Write it as a characterisation spec (`src/tests/characterisation/`, through the harness only) when the flow is user-visible, otherwise as a unit or component test. Confirm it fails on the current code, then fix.
- **Every new invariant gets a gate** in the matching group module, proven to bite: plant the violation, see it fail, revert.
- Comments explain *why*, never history. Audit IDs (`A21-xx`) go in commit messages only.
- Update CLAUDE.md and KNOWN_LIMITATIONS.md in the same commit as any behaviour they describe.

---

## Phase 1: Silent loss or corruption of user text

### A21-01 · Tag rename/remove corrupts a wrapped flow `tags:` list (HIGH)

**What goes wrong.** A note written by another tool (Prettier, for example) has
```yaml
tags: [project, draft,
  review]
```
When the user renames or deletes `draft` in the Tags Browser, `locateTagsField` (`src/renderer/lib/vault/tagRewriter.ts:262`) needs `rest.endsWith(']')`. The line fails that test and falls through to the scalar branch at L280-285. That branch comma-splits `[project, draft,` and rewrites only the header line, leaving `  review]` behind. The frontmatter then no longer parses: the title, tags and fields vanish from every view, later metadata edits are refused, and the undo toast can't repair it. The sweep does this to every matching note in the vault.

**Fix.**
1. In `locateTagsField`, return `null` (defer to the CST fallback) when the value starts with `[` or `{` but isn't a complete single-line flow collection, and also whenever the value contains `{`.
2. **Post-rewrite parse guard.** In `applyTagsLineRewrite` / `reassemble`, parse the candidate frontmatter with the `yaml` package (`lib/vault/frontmatterRead.ts`). Fall back to the CST path when it fails to parse or when its `tags` differ from the intended list. This catches any future tokenizer gap.
3. **Writer-level invariant (belt and braces).** In `noteWriter.writePending`, if the fresh frontmatter parsed and the assembled frontmatter does not, refuse the write, keep the change queued as failed, and report *"Filo stopped a change that would have broken the properties of X"*. No write path can then turn valid YAML into invalid YAML.

**Tests.**
- `tagRewriter` cases: multi-line flow, flow over 3+ lines, a flow mapping, and flow followed by a comment line, for rename, remove and add.
- A characterisation spec: a vault-wide rename over a note with a wrapped list leaves YAML that parses and still holds every other tag.
- A noteWriter unit test: an assembled result that doesn't parse is refused.

**Gate.** `frontmatter-parse-preserved` (`markdownFormat` group): noteWriter must call the parse guard before its write IPC.

### A21-02 · Raw view: unsaved text isn't seen by close, open-another-vault or quit (HIGH)

**What goes wrong.** `NoteRawView.svelte:33-45` keeps the typed text only in component `$state`. It never registers with `registerUnsavedSource` (`writeStateTracking.ts:442`; the only registration is `notes.svelte.ts:964`).
- **Quit** (window X / Alt+F4) never unmounts the view, so its `onDestroy` save never runs.
- **Close / open another vault** unmounts it during pre-swap, after the unsaved check. Its fire-and-forget `writeRaw` then races `writer.reset()` and `vault:close`.

The typed text is lost with no dialog, and the sentinel is cleared.

**Fix.**
1. New module `src/renderer/lib/notes/rawViews.ts`. It holds a registry of mounted raw views: `{ path, isDirty(), text(), flush(): Promise<RawSaveResult> }`.
2. `registerUnsavedSource(() => dirty raw paths)`, so `unsavedWork()`, `saveBeforeLeaving` and the quit drain all see them.
3. `vaultStore.save()` awaits `flushRawViews()` before the note flush. Phase 4 moves this into the general component-flush registry (A21-40); do it here first so Phase 1 stands alone.
4. `unsavedRescue.keepRescueCopies` adds each dirty raw view's text as a rescue item (the whole raw text, frontmatter included).

**Tests.** Characterisation: open a note, Raw, type, then `closeVault` → either the text is on disk or the leave dialog names the note. The quit path through `handleFlushAndQuit` behaves the same.

### A21-03 · Raw view: edits dropped when Raw is toggled off, or the tab closed, after a change elsewhere (HIGH)

**What goes wrong.** `DocumentEditor.toggleRaw` (L244-253) awaits `rawView.save()` and then sets `rawMode = false` no matter what happened.
- On a `'conflict'` result, `save()` sets `conflict = true` and the view unmounts before the banner renders.
- `onDestroy` skips the write when `conflict` is set, and ignores a `'conflict'` result anyway.

There is a second path. Clicking the toggle blurs the textarea, which starts a save (`saving = true`). `toggleRaw`'s own `save()` then returns at once because of the `saving` guard, so the view flips before the result is known. A late `'conflict'` hits `if (destroyed) return` and is dropped.

**Fix.**
1. `save()` returns `RawSaveResult = 'clean' | 'saved' | 'conflict' | 'failed'`. Replace the `saving` boolean with a stored in-flight promise: a second call awaits it, then re-checks `dirty`.
2. `toggleRaw` switches back only on `'clean'` or `'saved'`. Otherwise it stays in Raw with the conflict banner showing.
3. Tab close: `tabs.close()` asks the raw-view registry to flush the tab's path. On `'conflict'` or `'failed'`, it uses the existing close-anyway prompt, reworded per A21-37.
4. `onDestroy` with unsaved text that can't be written (conflict, failure, or a late conflict after destroy) writes a **rescue copy** of the text (`recovery:keep-unsaved`, one item) and raises a sticky toast: *"Your raw edits to X were kept in .filo/recovery/… because the note changed elsewhere"*, with **Reveal**. Nothing typed ever disappears without a trace.

**Tests.** A component test: type in Raw, change the note's frontmatter through `noteStore.patchFrontmatter`, click Raw → still in Raw, conflict banner shown. Then close the tab → a rescue file exists and the toast was shown. Also cover the blur-then-toggle race.

### A21-04 · A metadata edit deletes the text between two leading `---` rules (MEDIUM)

**What goes wrong.** Take a note that opens with a rule, a paragraph with no colon, and another rule. `parseMarkdownFile` (`lib/editor/markdownSync.ts:98-127`) treats that as frontmatter with a scalar root, so `frontmatter = {}` while `hasFrontmatter` stays true. On the first title, tag or field edit, the CST patch refuses (the root isn't a mapping), and the refusal branch (L525-537) triggers only for YAML that doesn't parse. A plain scalar *parses*, so L540 dumps just the delta keys and the paragraph is gone. The comment at L518-519 claims this fallback "preserves the data"; for a scalar or sequence root it doesn't.

**Fix (default).** Treat a parseable block whose root isn't a mapping (scalar, sequence, or null with content) the same as an unparseable one. Keep the raw bytes, refuse the metadata edit, and call `onFrontmatterRefused`, whose toast should read *"X starts with a --- block Filo can't read as properties, so this change wasn't saved"*. Allow the dump fallback only for a flow-mapping root or an anchor/alias refusal. Correct the comment.

`DECISION:` a better long-term behaviour is to treat such a block as **body, not frontmatter**, so the user sees the paragraph and a metadata edit prepends a new frontmatter block. That changes how the note is displayed and needs one shared fence helper (A21-66), so it's deferred to Phase 7. The Phase 1 fix only has to stop the loss.

**Tests.** `assembleMarkdownEngine` cases for scalar, sequence and empty-with-comment roots under a delta: the bytes are unchanged and the refusal callback fired. A characterisation spec: set a title on such a note → the file is unchanged and the toast was shown.

### A21-05 · Task List notes box writes a stale draft over newer edits (MEDIUM)

**What goes wrong.** `TaskItem.svelte:168-221` copies `bodyOnly` into `draftNotes` once, when the panel opens. `saveNotesIfChanged` (blur) and `commitNotes` write whenever `draftNotes !== bodyOnly`. `bodyOnly` is derived from the *live* model, so after the note is edited elsewhere (Document tab, another program) the stale draft differs from it. The next blur writes the old draft back **even if the user typed nothing**. `noteStore.writeBody` (`notes.svelte.ts:469-492`) calls `setBody` unconditionally, and the writer's drift check compares against a base that already includes the other edit.

Separately, `stripFrontmatter` (`lib/tasks/taskBodyText.ts:10`, LF only) runs on a body that already has no frontmatter, so a body that opens with `---`, text, `---` loses that block.

**Fix.**
1. Track `notesTouched`: write only when the user actually typed in the box.
2. When the panel opens, capture `openedRevision = model.bodyRevision`. On commit, if the model's revision has changed and its source isn't this box, don't write. Show the note conflict prompt (`stores/notePrompts.ts`), with **Keep mine** backing up first as it does today.
3. Remove the `stripFrontmatter` call on a model body (`note.body` is already body-only). Delete the helper if nothing else uses it (A21-66).

**Tests.** A component test (TaskItem with a real noteStore): open the notes, change the body through `noteStore.setBody` from another view id, blur with no typing → nothing is written. Type, then blur → the conflict prompt appears. A body that starts with `---` stays intact.

### A21-06 · Task List notes box throws away text for a read-only or unreadable note (MEDIUM)

**What goes wrong.** `noteStore.setBody` (L451-463) returns early when the note is `readOnly` (not UTF-8) or `unreadable`. `writeBody` then drops the pending path in `finally`: no toast, no failed mark. The textarea (`TaskItem.svelte:877-887`) isn't disabled. The same silent drop happens when the vault swaps during the load (`isStillSameVault` false).

**Fix.**
1. `setBody` returns `'queued' | 'read-only' | 'unreadable' | 'loading' | 'vault-changed'`.
2. `writeBody` returns that status. `frontmatterWriter.setNotesBody` and the notes box raise an error toast and **keep the draft** on anything but `'queued'`.
3. The textarea is `readonly` with an inline note ("This note isn't UTF-8, so Filo won't save it. Convert it from its Document tab.") when the model is read-only. For an unreadable note, retry the load when the box gets focus.

**Tests.** Unit tests for `writeBody` statuses. A component test: a read-only note gives a disabled box; an unreadable note plus typing gives a toast and the draft is kept.

### Phase 1 exit criteria
- All of the above pass, and `npm run ci:verify` is green with the new gate.
- Real app (Playwright recipe from the UI-feedback-1 memory):
  - Raw edit, then quit → saved.
  - Raw edit, then an external frontmatter change, then toggle → stays in Raw with the banner.
  - A tag rename on a scratch vault holding a wrapped list → the YAML still parses.

### Status: done (2026-09-26)

A21-01 to A21-06 are implemented, with the deviations below. Every new test was run against the pre-fix code first and failed there.

- **A21-01.** `locateTagsField` declines a `[` value that doesn't close on its line and any value holding `{`. `applyTagsLineRewrite` accepts its line edit only when the result parses to exactly the intended tags with every other key unchanged; otherwise the CST fallback runs. The note writer calls `breaksFrontmatter(fresh, next)` (`lib/notes/noteFile.ts`) before both of its `vault:write-existing-file-text` sends (`writePending` and `transform`) and refuses with `FrontmatterBreakError`, a toast (*"Filo stopped a change that would have broken the properties of X, so it wasn't saved."*) and a failed mark.
  - Tests: `src/tests/unit/tagRewriterWrappedFlow.test.ts` (wrapped over 2 and 3+ lines, a comment line after it, a flow mapping, a folded comma string, a non-string item; rename, remove and add); `src/tests/unit/noteWriterFrontmatterGuard.test.ts`; `src/tests/characterisation/frontmatterSafety.test.ts` (a vault-wide rename over a wrapped list).
  - Gate `frontmatter-parse-preserved` (`markdownFormat`): every note write IPC in `noteWriter.ts` sits in `writePending` / `transform` after a `breaksFrontmatter(` call. Proven by deleting the `writePending` check: the gate and the unit test both failed; restored. Gate count is 62.
- **A21-02.** New `src/renderer/lib/notes/rawViews.ts`: the registry, an unsaved source, `flushRawViews()`, `takeRawRescueItems()` and `keepRawRescueCopy()`. `noteStore.flushAll()` (which `vaultStore.save()` runs) flushes raw views before the note flush and reports the ones that couldn't save in `rawNotSaved`, so `save()` returns false. (It lives there rather than in `vault.svelte.ts`, which is at its file-size ceiling.) `keepRescueCopies` adds each dirty raw view's text; `describeUnsaved` reports a raw view in conflict as `conflict`.
- **A21-03.** `NoteRawView.save()` returns `RawSaveResult` and keeps the in-flight save as a promise that a second call waits for, then looks again. `toggleRaw` leaves Raw only on `clean` / `saved`. `tabs.close()` and `closeOthers()` flush the closing Document tabs' raw views first and ask *"Raw edits not saved … Close anyway keeps a copy"* on a conflict or failure. `onDestroy` saves what's left and, if it can't, writes a rescue copy and raises a sticky toast with **Reveal**.
  - Tests for A21-02 and A21-03: `src/tests/characterisation/rawViewUnsaved.test.ts` (close vault; quit from the window; a quit that can't save → dialog names the note → Quit anyway keeps a copy; toggle after an external frontmatter change stays in Raw with the banner, then tab close keeps a copy; blur-then-toggle race). 5/5 failed on the old code.
- **A21-04.** The assembler also keeps the block and refuses when the block parses but its root isn't a mapping (`frontmatterSourceRootIsMapping`, `lib/vault/frontmatterCstModel.ts`). The refusal callback now carries a reason; for `not-properties` the toast reads *"X starts with a --- block Filo can't read as properties, so this change wasn't saved."* The misleading comment is corrected. Tests: `assembleMarkdownEngine.test.ts` (scalar and sequence roots refused byte-for-byte, a flow mapping still dumps) and the second case in `frontmatterSafety.test.ts`.
- **A21-05 and A21-06.** The notes box logic moved out of `TaskItem.svelte` into `src/renderer/lib/tasklist/notesBox.svelte.ts` (`NotesBox`, `notesBoxDecision`). It writes only when the user typed, and only onto the body it opened on; otherwise it raises `promptNotesBoxConflict` (`stores/notePrompts.ts`), whose **Keep mine** flushes the note, backs the disk version up, then writes. `noteStore.setBody` and `writeBody` return a `SetBodyStatus`, `frontmatterWriter.setNotesBody` passes it on, and anything but `queued` keeps the box open with the draft and an error toast. The box is `readonly` with an inline reason for a non-UTF-8 or lossy note, and focusing it retries an unreadable note's load. `stripFrontmatter` is deleted. Tests: `src/tests/unit/taskNotesBox.test.ts` (the decision, each `writeBody` status, the draft kept on a refusal) and `src/tests/characterisation/taskNotesBox.test.ts` (untouched box after an external change writes nothing; typing after one asks, and Keep mine backs up; a body opening with a rule block survives; a non-UTF-8 note gets a read-only box). 4/4 failed on the old code.
- Docs: CLAUDE.md (gate count, the `markdownFormat` row, the leave rule, `rawViews.ts`, `notesBox.svelte.ts`) and KNOWN_LIMITATIONS #1 and #30.
- **Real app** (Playwright `_electron` against the built app, a fresh vault and user-data dir; script `phase1check.mjs` in session 6d396e's scratchpad), no console errors:
  - Raw edit, then `app.quit()` with the view still mounted → the typed text is on disk.
  - Raw edit, then another program adds `status: open`, then the toggle → still in Raw with the banner; the file holds the other program's version.
  - Tags Browser rename `draft` → `final` over `tags: [project, draft,\n  review]` → the YAML parses to `{title, tags: [project, final, review], status}`. A single-line list in another note stays a single-line list.
- `npm run ci:verify` is green: lint, svelte-check, `typecheck:main`, 5,650 tests passed (1 skipped), the build, and 63/63 gates. The run was on a checkout that also held the Phase 5 session's uncommitted work, which adds the 63rd gate.

### Deviations from the plan

1. **A21-01 step 2 uses the rewriter's own parse, not `frontmatterRead.ts`.** `loadYamlObject` in `tagRewriter.ts` is the same `yaml` package with `uniqueKeys` on, which is what the fallback path already uses. The check also compares every non-tag key, not only `tags`. One exception: when the block didn't parse *before* the edit (a `[#tag]` item that YAML reads as a comment), the line edit is still accepted if the result parses with the intended tags. It can only repair such a block, and an existing test pins that repair.
2. **A21-01 step 3 also guards `transform`, not only `writePending`.** The tag sweep, Replace All and tag add/remove all write through `transform`, so a guard only in `writePending` wouldn't cover the path the bug was in. The raw view passes `{ userAuthored: true }`: its text is the user's own whole file, and refusing a half-typed frontmatter would contradict A21-03's "nothing typed disappears".
3. **A21-04: a comment-only block is not refused.** The CST engine already patches it (the comment stays and the key is added), so no data was ever at risk. Refusing it would block metadata edits on a common template shape. Scalar and sequence roots are refused as planned. Two older tests that pinned the dump on a sequence root now use a flow-mapping root.
4. **A21-03 step 3: the tab-close prompt is its own dialog.** The plan points at a rewording under A21-37, which doesn't cover it (the tab-close wording is A21-26, Phase 3). `confirmCloseRawAnyway` names the notes and says a copy is kept. `closeOthers()` gets the same flush.
5. **A21-03 and A21-05/06 are covered by characterisation specs instead of component tests.** Both flows are user-visible, and the specs drive the real board and the real watcher (cross-cutting rule 1 allows either). The pure parts have unit tests.
6. **A21-05 compares bodies, not `bodyRevision`.** A box opened on a note no model holds reads the vault index, so there's no revision to capture. It records the body it opened on and checks it with `sameBody`. The conflict prompt is a notes-box prompt (Keep mine / Use theirs) rather than the model's disk-conflict prompt, because the other version may be an unsaved edit in another view, not a change on disk. Its **Keep mine** flushes that version to disk first, so the backup holds it.
7. **A21-06: two extra statuses.** `setBody` also returns `not-open` (the view doesn't hold the model) and treats an unchanged body as `queued`. The read-only message also covers a lossy note, which `setBody` refuses too.
8. **A21-05: `getBodyPreview` changed too.** With `stripFrontmatter` gone it skips rule lines (`---`, `***`), so a body that opens with a rule block previews its text. Its tests now pass bodies, as the callers do.
9. **Characterisation harness additions:** `quitFromWindow` (sends `app:flush-and-quit` and reports ready / awaiting-user), `typeInRawView`, `leaveRawFieldAndToggle`, `rawViewShown`, `confirmText`, and the task notes actions (`openTaskNotes`, `typeTaskNotes`, `leaveTaskNotes`, `taskNotesText`, `taskNotesReadOnly`).
10. **A wrapped list comes back as a block list.** The CST fallback re-serialises the changed `tags:` value in block style (`tags:\n  - project …`). The data and every other key are exact; only that value's layout changes, as KNOWN_LIMITATIONS #1 already allows for a changed collection.
11. **The raw flush lives in `noteStore.flushAll()`, not `vaultStore.save()`.** `vault.svelte.ts` is at its file-size ceiling. `flushAll()` now returns `{ failed, rawNotSaved }`, so the tab-close drain doesn't count the raw view twice, and every drain (rename, tag sweep) saves raw text first. Six tests that compared the result with `{ failed: [] }` were updated.
12. **`notesBox.svelte.ts` is on the vault-lifecycle exemption list** (gate `vault-lifecycle-coverage` and its parity test). Its `$state` belongs to one row and goes with it.
13. **Follow-up for Phase 3 (A21-27, save state):** the toolbar save indicator stays green while a raw view holds unsaved text. It only re-reads `unsavedWork()` on write-ledger events, and typing in the raw view makes none. Close and quit are correct; only the indicator is wrong.
14. **Found while testing (Phase 2, not fixed here):** a change another program makes within a few seconds of Filo creating a note isn't delivered to the open views. That is A21-09. The notes-box spec seeds an existing note to stay clear of it.

---

## Phase 2: External edits and sync safety

These matter as soon as another program or Syncthing writes a note Filo has open.

### A21-07 · Typing during an external change reverts that change without a prompt (MEDIUM, highest priority in this phase)

**What goes wrong.** `notes.svelte.ts onDiskChanged` (L591-621) serialises views and then awaits `readNoteFresh`. Keys typed during that await only set `NoteEditorView.unserialised`, so `hasUnsavedBody` is false and `decideDiskChange` returns `'replace'`. `adoptDisk` moves `base` and `body` to the external version. `NoteEditorView.sync` (`lib/editor/noteEditorView.ts:129`) returns early because of `unserialised` or `composing`, without recording that the editor is now stale. The next `serialize()` then calls `setBody` with the editor's text, which was built on the old body. The writer's drift check sees `disk == base` and writes it, erasing the external edit. IME composition (CJK) widens the window a lot.

**Fix.**
1. In `serialize()` (L89-103), before `setBody`: if `m.bodySource !== this.viewId && m.bodyRevision !== this.shownRevision`, the editor holds text built on a superseded body. Call a new `noteStore.setBodyBuiltOn(relPath, markdown, viewId, staleBase)`. It keeps the local body as the model's unsaved body with the **old base**, so the writer's existing body-drift check raises the normal Reload / Keep mine prompt, which backs up first. It never writes blindly.
2. In `onDiskChanged`, after `readNoteFresh` resolves, call `serializeViews(key)` again and re-run `decideDiskChange` if `hasUnsavedBody` flipped during the read.

**Tests.** A unit test on `NoteEditorView` with a fake editor: mark unserialised, adopt a disk body, serialize → the conflict is entered, and no write was queued with the adopted base. A characterisation spec: type, change the file on disk mid-read (harness hook), keep typing → the conflict prompt appears and the external bytes are intact until **Keep mine**.

### A21-08 · No main-side stale-overwrite check on a note write (MEDIUM)

**What goes wrong.** `noteWriter.writePending` (L352-363) re-stats through a separate `vault:stat`, then sends `vault:write-existing-file-text` with nothing identifying the version it read. `atomicWriteFile` retries the rename on a Windows lock for up to about 5 s (`filenameUtils.ts` `retryOnWindowsLock`) and re-checks only that the file exists. A sync client that replaces the file inside that window is overwritten, and the sync then spreads Filo's version everywhere.

**Fix.**
1. Add an optional `expect: { mtimeMs: number; size: number }` argument to `vault:write-existing-file-text`: schema in `shared/ipcSchemas.ts`, type in `ipcContracts.ts`.
2. In `atomicWriteFile`'s `beforeAttempt`, re-stat before **every** rename attempt and throw a typed `StaleWriteError` (envelope code `STALE`) if the stat differs from `expect`.
3. The writer treats `STALE` like its own re-stat mismatch: re-read and re-apply the change to the fresh read (the existing `continue` loop). Cap it at 3 rounds, then hold the body as a conflict.
4. `noteWriter` must pass `expect` from its fresh read. Refuse to write when the fresh read had no coherent stat.

**Gate.** `note-write-expects-stat` (`writePath` group): every `vault:write-existing-file-text` invoke in noteWriter passes `expect`.

**Tests.** Main-side unit test: `atomicWriteFile` with `expect`, and a file changed between attempts → throws `STALE`, tmp cleaned up. Writer unit test: `STALE`, then a re-read, then success.

### A21-09 · The watcher hides every change for about 7 s after a Filo note write (MEDIUM)

**What goes wrong.** `watcherSuppression.ts` `suppressWrite` drops *every* event for the path while the file exists, for `LOCK_AWARE_SUPPRESS_MS`, whatever the content. A sync client or another editor saving the note in that window is never delivered. The view shows a stale body until Filo writes that note again, or indefinitely if the note is closed.

**Fix.** Before dropping an event inside a write-suppression window, compare the file with the own-write record (`noteOwnWrite` / `recordOwnWrite` already store size and SHA-1): a size mismatch means deliver; the same size means hash and compare. Only an exact own-bytes match is suppressed. Keep the existence rule. Update KNOWN_LIMITATIONS #31 if its wording depends on the time-only behaviour.

**Tests.** `fileWatcher` unit test: a Filo write, then an external write with different bytes 1 s later → delivered. The same bytes → suppressed.

### A21-10 · A truncated read can wipe a note on a frontmatter-only write (LOW/MEDIUM)

**What goes wrong.** `looksTorn` (`noteWriter.ts:166-170`) flags only an opening fence with no closing one. If a non-atomic external writer (truncate, then write) is caught at 0 bytes or cut off mid-body, a delta-only batch skips the body-drift check (L339 needs a body) and writes the delta over an empty or partial body.

**Fix.** Treat a read as torn when:
- (a) it is 0 bytes and the model's base or the index entry was non-empty, or
- (b) it is less than half the base size and mtime is within 2 s of now.

Retry torn reads with the existing back-off. After 3 retries, accept (the user may really have emptied the file). A delta-only batch additionally refuses to write when the fresh body is empty but the base body isn't, until the retries are used up.

**Tests.** Writer unit tests for a 0-byte read, a half-size recent read, and a legitimately emptied file after the retries.

### A21-11 · `transform` ignores a failed pre-flush and moves `base` past a queued body (MEDIUM)

**What goes wrong.** `noteWriter.transform` (L508-542) awaits `flush(relPath)`, ignores its `{ ok }`, writes, and calls `onWritten`. `afterWrite` (`notes.svelte.ts:239-267`) always sets `m.base` to the transformed bytes, but updates `m.body` only when nothing is unsaved. A failed or held body built on the pre-transform base is still queued. When it retries, `base` equals disk, so it lands without a conflict and **reverts** the transform. Affected: Replace All, raw-view saves, tag sweeps.

**Fix.**
1. `transform` refuses, returning `'busy'`, when the pre-flush failed or the path has a held or failed body. Callers record it as skipped, with the reason. Replace All and the tag sweep list skipped files in their result toast; the raw view shows its conflict banner.
2. `afterWrite` never advances `base` past a body that is still unsaved or queued. In that case it enters conflict with the written bytes as `conflictDisk`.

**Tests.** Writer unit test: a failed body queued, then a transform → `'busy'`, no write. A notes-store test covering the afterWrite rule. A Replace All characterisation spec with one locked note → the result names it as skipped.

### A21-12 · A merged frontmatter delta is applied twice (LOW)

**What goes wrong.** `queueDelta` (L439) replaces `entry.delta` with a new merged object. The `now.delta === delta` identity check in `writePending` (L366-372) then fails, and keys already written are re-applied on the next flush, overwriting a value another program set in between.

**Fix.** After a successful write, remove from the queued delta each key whose value deep-equals the written one; keep the rest.

**Tests.** Writer unit test: delta A in flight, B merged, an external change to A's key, the flush completes → A's key keeps the external value.

### A21-13 · A metadata-only edit rewrites every line ending when the file has one CRLF (LOW)

**What goes wrong.** `noteFile.readNoteText` sets `eol = CRLF` if the raw text contains any CRLF. `assembleMarkdownFile` (L456) then converts the whole body.

**Fix.** A write with no body change splices the new frontmatter block before the **untouched raw body slice**. Choose the frontmatter's line ending from the existing frontmatter block's own ending, or by majority for a new block. Only a body write re-applies the file line ending to the body.

**Tests.** A mixed-EOL fixture: after a tag toggle, the body bytes are identical.

### A21-14 · The tag rewriter touches bytes outside `tags:` (LOW)

**What goes wrong.** `tagRewriter.ts reassemble` (L147-159) adds a final newline to the body and re-emits the fences as bare `---`. `detectEol` uses the first line break, while `noteFile` uses "any CRLF".

**Fix.** Keep the body byte-exact, reuse the original fence line text, and share one line-ending detector with `noteFile`.

**Tests.** The existing round-trip suite, plus a fixture with no trailing newline and a fixture with `--- ` (trailing space) fences.

### A21-15 · A vault-index read racing Filo's write re-inserts stale metadata (LOW)

**What goes wrong.** `vaultIndex.svelte.ts indexOnePath` (L75-99) always upserts after its read. If `afterWrite`'s `restoreMetadata` ran during the read, the stale result wins, and the suppressed watcher echo never corrects it. Kanban cards jump back and tasks look unchecked until the next reconcile.

**Fix.** Keep a per-path sequence, bumped by `restoreMetadata` and by every upsert. `indexOnePath` takes the sequence before its read and skips the upsert if it changed.

**Tests.** A vault-index unit test with a controlled read promise.

### Phase 2 exit criteria
- Tests green, plus a **real two-process scenario** in the real app: a Node script rewrites a note every 500 ms (atomic, then truncate-and-write variants) while Playwright types into it.
  - Expected: never a silent revert; either the external text is adopted or the conflict prompt appears; nothing is lost in `.filo/recovery/`.
- Before Syncthing is turned on, repeat this with Syncthing between two local folders.

### Status: done (2026-09-26)

A21-07 to A21-15 are implemented, with the deviations below. Every new test was run against the pre-fix code first (the changed source files swapped back to `HEAD`) and failed there, apart from the controls noted.

- **A21-07.** `NoteEditorView.serialize()` spots text typed into a body the model has since replaced: a new `NoteModel.diskRevision` records when the body last changed without a view typing it, and a view whose shown revision is older hands its text to the new `noteStore.setBodyBuiltOn(relPath, markdown, viewId, builtOn)`, which keeps it as the unsaved body in conflict with what the model now holds (the Reload / Keep mine prompt). `onDiskChanged` also pulls in keys typed while its read was out, before deciding.
  - Tests: `src/tests/unit/noteStoreExternalEdits.test.ts` (typed before a reload → conflict and nothing written, Keep mine then writes; typed during the store's read → conflict; two controls with no false conflict) and `src/tests/characterisation/externalEditsWhileTyping.test.ts` (keys typed while the open note reads the other program's version → the prompt, their bytes on disk until Keep mine, which backs them up; a frontmatter-only change during typing keeps both). The characterisation spec timed out waiting for the prompt on the old code.
- **A21-08.** `vault:write-existing-file-text` takes an optional fourth argument, `expect: { mtimeMs, size }` (schema and contract). The handler passes it to `atomicWriteFile` as `expectStat`, which re-stats before every rename attempt, lock retries included, and throws `StaleWriteError` (`ipcErrorCode` → `STALE`), cleaning up its tmp. The note writer sends every overwrite through one function, `writeOver`, with the fresh read's stat; on `STALE` it starts over from a new read (four rounds, shared with the cut-short re-reads), and a body still meeting a newer version after that is held as a conflict. A read with no coherent stat is never written over.
  - Tests: `src/tests/unit/atomicWriteFileExpectStat.test.ts` (unchanged file writes; changed file → `STALE`, tmp gone; a file replaced during a lock backoff → `STALE` after one attempt) and `src/tests/unit/noteWriterSyncSafety.test.ts` (the stat is sent; a change lands on the version that replaced its read; a body becomes a conflict; a file that keeps changing is never written; no coherent stat → no write; `transform` runs again on the new version).
  - Gate `note-write-expects-stat` (`writePath`): every `vault:write-existing-file-text` invoke in `noteWriter.ts` passes four arguments after the channel, the handler passes `expectStat: expect`, `atomicWriteFile` checks it in `beforeAttempt` and throws `StaleWriteError`, and `ipcErrorCode` maps it. Proven by dropping the fourth argument, then renaming `expectStat` in the handler: the gate failed each time; restored.
- **A21-09.** `suppressWrite(path, ms, content)` records the bytes being written (size and SHA-1, the last four per path), and `recordOwnWrite` records them again after the write. While a write window is open, the watcher drops an event only when the file still exists **and** holds one of those byte sets (`FileProbe`: a stat, then a hash only when a size matches). The live pass and both reconcile checks pass the probe. The four note-write handlers (`write-file-text`, `create-file-text`, `write-existing-file-text`, `convert-to-utf8`) pass their content. KNOWN_LIMITATIONS #31 is reworded.
  - Tests: `src/tests/unit/watcherOwnWriteBytes.test.ts` (the windows: ours dropped, other bytes and same-size-other-bytes reported, a burst of saves, a window without bytes keeps the old rule, a plain suppress still wins; the watcher: a save by another program a second after ours is reported, our own bytes stay hidden).
  - Gate `note-write-suppression` now also requires the content argument on each handler's `suppressWrite` and `this.probeFile` in the live pass. Proven by removing each: the gate failed; restored.
- **A21-10.** `looksCutShort(fresh, known)`: an empty read of a note that had text, or a read under half the known size written in the last 2 s. The known size is the model's base, else the vault index (`vaultIndexStore.knownShape`). A frontmatter-only batch also re-reads when the fresh body is empty and the known one wasn't. After the retries the read is taken as the file. `transform` re-reads the same way.
  - Tests in `noteWriterSyncSafety.test.ts`: an empty read followed by the rest of the save, a recent half-size read, a file the user really emptied (control), and `looksCutShort` itself.
- **A21-11.** `transform` throws `NoteBusyError` when its pre-flush didn't save (a failed or held body) or a body was queued before its turn in the queue. Replace All lists busy notes in a warning toast, the tag sweep counts them as failed without a second error toast, and `writeRaw` returns `conflict`, so the raw view shows its banner. `afterWrite` no longer moves the base on under an unsaved body when the write changed the body: the note goes into conflict with the written bytes.
  - Tests: `noteStoreExternalEdits.test.ts` (a transform and a raw save refused while a conflict holds the body; keys serialised while a rewrite is being written are held, not written over it) and a Replace All case in `replaceAllCommand.test.ts` (the held note is left alone and named).
- **A21-12.** New `subtractWrittenDelta(queued, written)` (`lib/vault/frontmatterDelta.ts`): after a write, a merged delta drops each key the write already set to the same value, or already removed. Tests in `noteWriterSyncSafety.test.ts`: a key another program changed after it landed keeps that value; a key set again to a new value still lands (control).
- **A21-13 and A21-14.** New `lib/utils/lineEnding.ts`: `fileLineEnding` (by majority) and `frontmatterLineEnding` (the opening fence's own ending, else the file's). `readNoteText` uses the majority rule. A write without a body keeps the disk body byte-exact and writes the block in its own ending. The tag rewriter uses the same rule, keeps the fence lines (`--- `), the closing fence's line break (or its absence) and the body verbatim. Tests: `src/tests/unit/noteLineEndingsKept.test.ts`.
- **A21-15.** `vaultIndex.svelte.ts` keeps a per-path sequence, bumped by `restoreMetadata` and by every read's upsert or remove. A read that sees the sequence move during it reads again (up to three times), else leaves the newer entry. Test: `src/tests/unit/vaultIndexReadRace.test.ts`.
- Docs: CLAUDE.md (gate count, the `writePath` row, the tree, the write-path gotchas) and KNOWN_LIMITATIONS #31.
- **Real app** (Playwright `_electron` against the built app, a fresh vault and user-data dir; scripts `phase2check.mjs` and `extwriter.mjs` in session b5b7c5d8's scratchpad). A separate Node process appended a paragraph to the open note every 500 ms: 20 times atomically (tmp + rename), then 20 times by truncating, pausing 60 ms and writing. Meanwhile Playwright typed a character every 90 ms into the note's first line and answered each conflict prompt with **Keep mine**. Results for both rounds:
  - every typed character is on disk, and the editor matches the file;
  - each of the 40 lines the other process wrote is in the final file or in a `.filo/recovery` backup (none lost);
  - 9 prompts per round, no console errors.
  - A first run appended lines with single line breaks, which the editor can't reproduce, so the note went read-only part way (the lossy guard) and the keys typed after that weren't taken. Nothing either side had written was lost.
  - The Syncthing repeat of exit criterion 2 is still to do, before Syncthing is turned on.
- `npm run ci:verify` is green: lint, svelte-check, `typecheck:main`, 5,691 tests passed (1 skipped), the build, and 64/64 gates. As in Phase 1, the run was on a checkout that also held the Phase 5 session's uncommitted work.

### Deviations from the plan

1. **A21-07: the store enters the conflict itself.** The plan had `setBodyBuiltOn` keep the old base so the writer's drift check would raise the prompt. It enters the conflict directly instead, with the bytes the model now holds as the other version: the prompt appears at once, and Keep mine still backs those bytes up first. It takes the body the editor was built on rather than a base, and asks nothing when the typed text already equals the new body or the change put back that very body.
2. **A21-07: "stale" means the body changed without a view typing it.** The plan's test (`bodySource !== viewId`) would also fire when another view of the same note typed. `diskRevision` limits it to disk, reload and rewrite changes, so two in-app views keep their current behaviour.
3. **A21-07 test harness.** `whileReading` (in `harness/app.ts`, on a new `mainBridge.holdReads`) holds reads of the file so the spec can type while the open note reads it. It carries one piece of adapter knowledge: a change is read twice, first by the search index and then by the open note, and the spec types during the second. Keys typed during the first reach the note before its read begins, which the old code already handled.
4. **A21-08: the renderer's separate `vault:stat` re-check is gone.** The main-side check covers the same gap and the rename backoff after it, so the extra round trip went.
5. **A21-08: a `STALE` answer is not a failed save.** `writeOver` resolves `STALE` instead of throwing it, so a retry raises no error toast and no failed mark. The plan's cap of three rounds became four (one read plus three retries), shared with the cut-short re-reads. After them, a held body becomes the conflict prompt as planned; a frontmatter-only change stays queued and failed for the next save, as before.
6. **A21-08: `noteWriter.flush` reports saved when nothing is left queued.** A flush during an in-flight write re-arms a fire, which then finds the queue empty (the in-flight write took it) and the scheduler counts that as a miss. `transform` never checked the result before; now it must, so an empty queue counts as saved. A failed or held change stays queued, so the answer is still false for those.
7. **A21-09: the bytes are recorded before the write too, and a few are kept.** The plan compared with the after-write record only. Recording the content in `suppressWrite` covers the echo of a write still in flight, and the last four byte sets cover a burst of saves. A file over 2 MB whose size matches is taken as ours without a synchronous hash. A window whose caller gave no bytes keeps the old rule.
8. **A21-10: the retries use the writer's read back-off** (40, 120 and 300 ms, then the read is accepted). `transform` gets the same check: a tag add on a note caught at 0 bytes would otherwise write a one-key file over the other program's save.
9. **A21-11: a typed error rather than a `'busy'` return value.** Every caller already catches per file, so `NoteBusyError` fits them without a return-type change. The planned Replace All characterisation spec is a unit test (`replaceAllCommand.test.ts`), because the harness has no Replace All driver. `afterWrite` holds the base only when the write changed the body; a frontmatter-only write under an unsaved body still moves it, which the drift check doesn't notice.
10. **A21-13: the line ending is decided by majority everywhere.** A body write in a mostly-LF file with one stray CRLF now writes LF rather than turning every line CRLF.
11. **A21-14: five `tagRewriter.test.ts` cases were updated.** They pinned the old output (a body gaining a final newline). The fence-whitespace test's helper regex now allows `--- `, and that test now also checks that the fence lines are kept.
12. **A21-15: a racing read reads again rather than being dropped.** That way, two overlapping reads of one path still settle on the newer bytes.
13. **`notes.svelte.ts` was at the 1000-line limit.** `askUnlessMoved` and the grace checks moved to `lib/notes/renameGrace.ts`, and the rescue-text builder moved to `lib/notes/unsavedNoteTexts.ts`. The store is now 979 lines.
14. **Tests that relied on the old write path were updated.**
    - `deltaWriteRestatAndFreshBody.test.ts`: the gap hook moved from `vault:stat` to just before the write.
    - `fileTagsCascade.test.ts`: its mocked reads now carry an mtime and size.
    - `commandMarkDirtyOriginatingBoard.test.ts`: its mock's stat never matched its read, so the command's write always failed and the undo passed on a delta that was still queued. The mock now keeps what is written.
    - The in-memory test vault (`helpers/memoryVault.ts`) answers `STALE` for a stale `expect`.
15. **Gate `frontmatter-parse-preserved` follows the send into `writeOver`.** The note-write IPC may only appear in `writeOver`, and every `writeOver(` call must sit in `writePending` or `transform` after a `breaksFrontmatter(` check.16. **Gate `eol-preservation` pinned the old "any CRLF" rule.** It now pins `fileLineEnding(raw)`, the block's own ending on a change without a body, the `withDiskBody` call, the tag rewriter's use of the shared rule (a second `detectEol` is forbidden) and the new mixed-ending test. Proven by restoring the old rule, dropping the `withDiskBody` call and adding a `detectEol`: the gate failed each time; restored.
17. **Found while testing, not fixed here:** the real-app run showed a note going read-only part way through typing, when another program's save contained formatting the editor can't reproduce. Keys typed after that are not taken, and the banner says why. It belongs with the Phase 6 error-state work.

---

## Phase 3: Honest save state, working retries, findable recovery

False alarms teach the user to click through the one prompt that protects real work, so they rank close to data loss.

### A21-16 · The Kanban side toolbar writes into `.filo/` through a channel that refuses it (MEDIUM, do first)

**What goes wrong.** `KanbanSideToolbar.svelte:93-121` reads and writes `.filo/kanbanToolbar.json` through `vault:read-file-text` / `vault:write-file-text`. Main refuses both (`pathSecurity.ts assertNotInFiloDir`). Each drag then:
- shows an error toast;
- adds a permanent `failedVaultPaths` entry (Ctrl+S reports a failure for the rest of the session);
- makes close and quit say "1 change couldn't be saved";
- writes a rescue folder and keeps the sentinel, so the next launch shows the recovery modal.

The position is never saved.

**Fix.**
- `DECISION:` store the position in `.filo/workspace.json` (layout state, per vault, already written by the config scheduler). Add it to the workspace schema as an optional `kanbanToolbar: { x, y } | null` and load it with the workspace. There is nothing on disk to migrate, because the file was never written.
- Remove the generic-channel read and write.

**Gate.** `no-filo-path-on-vault-channels` (`ipcSecurity` group): no renderer `invoke`/`invokeOk` of a `vault:*` channel may take a string literal or constant beginning `.filo/`, except the sentinel helpers, which carry an allow marker.

**Tests.** A component test: drag → workspace save scheduled, no failed path. A characterisation spec: a drag, then close → no dialog.

### A21-17 · Failed board, config and tags writes are never kept for retry (MEDIUM)

**What goes wrong.** These main handlers return errors without the fs `code`:
- `board:save` (`board.ipc.ts:251-254`);
- `config:save` (`classifyError`, L63-67);
- `tags:save` (`classifyTagsError`, `tags.ipc.ts:28-32`);
- the theme and template writers.

So `isRetainableWriteError` (`writeSchedulerFailures.ts:21-37`) never matches. The **Retry**, **Retry save** and quit **Retry now** buttons then re-fire nothing, while the path stays failed.

**Fix.** One shared main helper, `errorEnvelope(err)` in `shared/ipcEnvelope.ts`, that always carries `code: (err as NodeJS.ErrnoException).code ?? 'IO_ERROR'` plus the message. Use it in every write handler. Add `IO_ERROR` to `RETAINABLE` only for write-scheduler kinds whose payload is a full snapshot (board, config, misc).

**Gate.** `ipc-errors-carry-code` (`ipcSecurity`): a `{ ok: false` literal in `src/main/ipc/**` must come from `errorEnvelope`.

**Tests.** A test through the **real** handler envelope: mock fs to throw EBUSY on `board:save` → the scheduler keeps the write; Retry re-fires it and clears the failed path.

### A21-18 · One external edit to a `.filo` config file blocks its saves for the rest of the session (MEDIUM)

**What goes wrong.** `configWriteScheduler.ts` (drift branch, about L383-434) records the failure but never rebases the baseline. The `config` watcher reconciler is a no-op (`externalChangeRegistry.ts:94-99`). Every later save of that file aborts with a "check disk space" message.

**Fix.**
1. On drift, re-read the file.
   - Bytes equal what Filo last wrote → rebase silently (`noteBaseline` with `ifUnchangedSince`).
   - Otherwise:
     - `workspace.json` and `viewports.json` (UI layout): local wins after a `.filo/recovery` backup, with one info toast.
     - `app.json`, `defaults.json`, `appearance.json`, `hotkeys.json` (settings): the board-style **Reload / Keep local** prompt, where Keep local backs up first.
2. Add a `CONFIG_EXTERNAL_EDIT` message to `buildWriteErrorToast` and correct the L303-305 comment.

**Tests.** Scheduler unit tests for the equal-bytes rebase, a layout file changed externally, and a settings file changed externally (both choices).

### A21-19 · A deleted `.filo` config file silently swallows every later change (MEDIUM)

**What goes wrong.** In `configWriteScheduler.ts` (the ENOENT re-stat, about L404-412), a file that is still missing is handled with `lastWrittenConfigs.delete(target); continue;`: no failure, no toast. The baseline is kept, so every later write takes the same skip while the indicator says "Saved".

**Fix.** These files belong to Filo. On a confirmed ENOENT, drop the baseline and **recreate** the file with an exclusive create. Show one info toast per session per file: *"X was deleted outside Filo and has been recreated."*

**Tests.** Scheduler unit test: file deleted, then a change → the file exists with the new content, and one toast.

### A21-20 · The board drift prompt's "Reload" reloads nothing (MEDIUM)

**What goes wrong.** `boardWriteScheduler.writeBoardFile` (L284-300) treats `'reload'` as an abort and assumes the handler refreshed the cache. The handler (`vaultExternalDriftPrompts.ts:72-78` `promptBoardExternalEdit`) doesn't. Also, the watcher's prompt (which does reload) and this one can both be showing at once, with nearly the same wording and opposite effects.

**Fix.**
1. On `'reload'`, call the reconciler's `reloadBoardFromDisk(path, boardId)`: cancel the pending write, replace the cache and re-stamp the baseline.
2. De-duplicate: one drift prompt per board path at a time, sharing one implementation.
3. Give `EXTERNAL_EDIT` its own toast text.

**Tests.** Characterisation: edit a board, change it on disk before the write, choose Reload → the board shows the disk version and no further prompt appears.

### A21-21 · Failures with no retry source keep the indicator red, and phantom failures follow renames (LOW/MEDIUM)

**What goes wrong.**
- (a) A path marked failed by an operation that has its own retry UI (`noteWriter.transform` from the tag sweep) stays in `failedVaultPaths` for good (`writeStateTracking.ts:495-503, 600-606`). `save()` returns false (`vault.svelte.ts:1214`) and the dirty sentinel never clears.
- (b) An in-flight write that fails with ENOENT after an external rename marks the **old** path failed (`noteWriter.renamePath` L615-644). `failedVaultPaths` has no rename sweep. That phantom failure can even make the scoped drain in `handleExternalRename` throw `PendingWritesFailedError`, which skips the whole board/tag cascade for the rename.

**Fix.**
1. `markPathFailed(path, { retry })`: entries without a retry function are reported and kept in a separate `reportedFailures` list, shown in the save popover. They don't block `save()` or the leave check, because their owner has already reported them.
2. `writeStateTracking` registers a path-rename sweep for `failedVaultPaths` and `pendingVaultPaths`.
3. An ENOENT failure on a path that has since been re-keyed clears the mark (`clearFailedPathAfterLateSuccess`).

**Tests.** Unit tests for each. A characterisation spec: a write in flight during an external rename → no failed path, and the tiles follow the rename.

### A21-22 · The error toast aggregator names the wrong file, and its buttons act on a different one (LOW)

**What goes wrong.** `errorToastAggregator.ts:85-97` replaces the text with the newest detail while the actions stay bound to the first report.

**Fix.** Keep the set of distinct paths per entry. Show *"N files couldn't be saved: A, B, C…"*. Show per-file actions only when the entry has one path; otherwise offer **Details**, which opens the save popover.

**Tests.** Aggregator unit tests.

### A21-23 · Rescue copies skip `.filo/` state (LOW)

**What goes wrong.** `unsavedRescue.keepRescueCopies` (L88-96) handles only notes and boards. The in-memory tags registry (the only copy of attachment tags), config and misc payloads are declared "not kept".

**Fix.** Each config and misc scheduler exposes `pendingPayloads(): { key, json }[]`. Rescue writes them as `_filo__<name>.json` inside the rescue folder, and `recovery:keep-unsaved` allows exactly that flattened name.

**Tests.** A unit test that rescue of a failed `tags.json` writes the file.

### A21-24 · Recovery snapshots evict Keep-mine and encoding backups (MEDIUM)

**What goes wrong.** Every vault open re-snapshots each board that fails to load (`vaultCandidate.ts:290-310`), with no de-duplication. The global prune (`recoverySnapshot.ts:253-311`, `MAX_SNAPSHOTS_TOTAL = 100`) exempts only `-unsaved`. So the only surviving copy of another device's note version (a Keep-mine backup) or a non-UTF-8 original can be deleted without notice. The per-basename cap (20) also applies to Keep-mine backups.

**Fix.**
1. Snapshot a failed board only when no existing snapshot of that flattened name has the same size and hash.
2. Write Keep-mine and encoding backups under a `<ts>-keep/` directory, which both prunes skip, like `-unsaved`.
3. Add KNOWN_LIMITATIONS text next to #33: only the user deletes `-keep` folders.

**Tests.** `recoverySnapshot` unit tests: 150 loader snapshots plus one `-keep` → the `-keep` folder survives. Opening twice with an unchanged failed board → one snapshot.

### A21-25 · Recovery surfaces don't lead anywhere (LOW/MEDIUM)

**What goes wrong.**
- `RecoveryFiles.svelte:29-43` says "unflushed changes. Recovered — but…" and lists case-folded keys with no actions.
- The rescue-location toast (`vaultLeaveGuard.ts:60-61`) is cleared at once by the `ui` pre-swap handler (`ui.svelte.ts:518-537`).
- The window-close timeout (`main.ts:225-228 destroyOnTimeout`) skips the quit-failure breadcrumb, the watcher stop, the geometry flush and the `ipcMain.once` listener cleanup.

**Fix.**
1. The sentinel ledger stores the on-disk spelling next to each key.
2. The modal text becomes *"Filo didn't finish saving these files last time. Your last changes may not be in them."* Each row gets **Open**. The modal lists `-unsaved` rescue folders and orphan-tmp moves newer than `dirtyAt`, each with **Show in folder**.
3. `saveBeforeLeaving` returns the rescue message, and `openVault` / `closeVault` post it **after** the swap as a sticky toast with **Show in folder**.
4. `destroyOnTimeout` runs the same bounded cleanup as `onReady`: breadcrumb, `stopActiveWatcher`, state flushes, listener removal.

**Tests.** Component test for the modal. A characterisation spec: Close anyway → the toast is visible on Home.

### A21-26 · The tab-close dialog is inaccurate (LOW)

**What goes wrong.** `tabs.svelte.ts confirmCloseAnyway` (L86-101) says closing will discard edits. That's false: `evictIfIdle` keeps unsaved models. Meanwhile a board failure that wasn't kept for retry never gates the close at all.

**Fix.** Gate on `unsavedWork()` filtered to the tab's paths. New wording: *"X still has unsaved changes. Filo will keep trying, and will ask again when you quit or close the vault."* with **Close tab** / **Cancel**.

### A21-27 · The save indicator spins while a conflict prompt waits (LOW)

**What goes wrong.** A body held for Reload / Keep mine counts as pending (through `registerUnsavedSource`), so the indicator shows "Saving…" forever.

**Fix.** Add a `needs-attention` state to `saveState.svelte.ts` (held conflicts and missing-file holds) with its own colour, label and popover row that re-opens the prompt. Check the colour against the theme contrast tokens (Phase 8 a11y).

### Phase 3 exit criteria
- Tests and new gates green.
- Real app: drag the Kanban toolbar and close → no dialog.
- Real app: with a locked board file (hold it open from a script) → Retry actually re-fires and succeeds once the lock is released.

### Status: done (2026-09-26)

A21-16 to A21-27 are implemented, with the deviations below. Every new test was run against the pre-fix code first (the changed source files swapped back to `HEAD`) and failed there.

- **A21-16.** The Kanban side toolbar keeps its position in the workspace store (`WorkspaceLayout.kanbanToolbar`, validated on hydrate), written with `workspace.json` by the config scheduler. The component no longer reads or writes a file.
  - Gate `no-filo-path-on-vault-channels` (`ipcSecurity`). Proven on the old toolbar (2 violations), then passing.
  - Tests: `characterisation/honestSaveState.test.ts` (a drag: no error toast, the position in `workspace.json`, close asks nothing; the position comes back on reopen). Both failed on the old code.
- **A21-17.** Every write handler answers a failure through `errorEnvelope(err)` / `errorResult(err)` (`src/main/ipc/ipcErrorCode.ts`), which always carries a code: the fs errno as-is (`EBUSY`, `EPERM`…), Filo's typed codes, else `IO_ERROR`. The board, config and misc schedulers also keep `IO_ERROR` for a re-fire (`retainIoError`). `writeConfigs` returns the error behind a partial failure, so a failed config save is retained too.
  - Gate `ipc-errors-carry-code` (`ipcSecurity`). Proven by putting back the old `board:save` literal and dropping the code from `errorResult`.
  - Tests: `unit/writeFailureRetry.test.ts`, through the real handlers with only the file write failing: every handler's failure has a code; a board save failing on `EBUSY` is kept, and Retry writes it and clears the failure; the same for a config save with an unnamed IO error. All four failed on the old code.
- **A21-18 and A21-19.** New `lib/boards/configDrift.ts` decides each config write against the disk:
  - Filo's own bytes with a new stamp: the baseline moves on silently.
  - `workspace.json` changed elsewhere: a copy to `.filo/recovery/<ts>-keep/`, Filo's layout is written, one info toast.
  - `app.json` / `defaults.json` / `appearance.json` changed elsewhere: Reload / Keep local (`stores/configDriftPrompt.ts`). Keep local copies first; Reload takes the file's settings into memory and writes nothing.
  - Deleted: created again with `config:save … { createOnly: true }`, and one toast per file per session: *".filo/app.json was deleted outside Filo and has been recreated."*
  - `buildWriteErrorToast` has its own text for `EXTERNAL_EDIT` (boards and settings).
  - Tests: `unit/configExternalChanges.test.ts` (7 cases, all failed on the old scheduler), two `writeErrorToast` cases, and `configResurrectionGuard.test.ts` updated.
- **A21-20.** New `stores/boardDrift.ts` holds the one board drift prompt, used by both the watcher and the board writer:
  - Reload cancels the queued write, reads the board into the cache and re-stamps the baseline. The writer then drops its write without reporting a failure.
  - Keep local copies the other version and moves the baseline to it, so the next save doesn't ask again.
  - Test: a characterisation case (a column added right after another program changed the board; Reload shows the disk version, writes nothing over it, and asks nothing more). On the old code both columns stayed.
- **A21-21.**
  - `markPathReported`: a rewrite (`transform`: tag sweep, Replace All, raw view) whose write failed with nothing queued is listed as reported, not failed, so it no longer blocks save, close or the dirty sentinel.
  - Every pending, failed and reported mark follows renames (`registerPathRenamable('writeStateTracking')`).
  - A note write that fails because the note moved while the write was out settles the old path without a toast, since its change is already armed at the new path.
  - Tests: `unit/writeStateReportedAndRenamed.test.ts`, and a characterisation case (a rename during the save's read: the text lands in the moved file, the card follows, close asks nothing). On the old code the phantom failure blocked the board cascade.
- **A21-22.** The error toast aggregator tracks the distinct files per toast. Once there are two or more, it shows *"N files couldn't be saved: A, B, C…"*, drops the first file's own buttons, and keeps the shared ones (Retry) plus **Details**, which opens the save popover. Tests: two new aggregator cases.
- **A21-23.** Rescue copies now include Filo's unsaved `.filo/` state, named `_filo__<name>.json`: the bundled configs whose in-memory content isn't what was last written (`unsavedConfigPayloads`), and each misc write still queued or failed (`unsavedMiscPayloads`; misc writes now carry their `json`). Test: `unit/unsavedRescueFiloState.test.ts`.
- **A21-24.** `recovery:snapshot` takes a purpose:
  - `keep` (Keep mine / Keep local, encoding conversions) writes to `<ts>-keep/`, which both prunes skip.
  - `load-failure` (boards that fail to load at open) isn't copied again while an identical copy exists.
  - KNOWN_LIMITATIONS #33 covers `-keep`. Test: `unit/recoverySnapshotKeep.test.ts` (all three failed on the old code).
- **A21-25.**
  1. The dirty sentinel names files as spelled on disk.
  2. The recovery modal:
     - says *"Filo didn't finish saving these files last time. Your last changes may not be in them."*;
     - offers **Open** for notes (**Show in folder** for other files);
     - lists the rescue and moved-aside folders written since the unfinished save, each with **Show in folder**.
  3. The rescue notice outlives the vault switch and has **Show in folder**.
  4. The window-close timeout runs the same bounded teardown as a normal close.
  - Tests: a characterisation case (Close anyway → the notice is still up after the vault closed; reopening shows the new modal with Open and the rescue folder row; failed on the old code) and `unit/recoveryLocations.test.ts`.
- **A21-26.** Closing a tab (or the others) asks only when a note or board file that tab shows still has unsaved changes, whatever the cause. The dialog says *"… still has unsaved changes. Filo will keep trying, and will ask again when you quit or close the vault."* with **Close tab** / **Cancel**, not styled as destructive. `tabCloseSaveFailure.test.ts` updated.
- **A21-27.** A new save state, `attention`: blue, a help-circle icon, and a `--toolbar-save-attention` token in every built-in theme (contrast test extended). A change held for the user's decision is counted as neither saving nor failed:
  - the held changes are a note in conflict, a note deleted with unsaved edits, and a change whose file no longer exists;
  - `stores/heldDecisions.ts` holds them, filled by the note prompts, and `stores/saveStateFeed.ts` feeds the indicator;
  - the popover lists each with **Show**, which re-opens its prompt.
  - Tests: a characterisation case (the indicator is blue while the conflict waits; after the toast is dismissed the popover brings the prompt back; Keep mine makes it green; on the old code it was red) and four `saveState` cases.
- **Real app** (Playwright `_electron` against the built app, a fresh vault and user-data dir; script `phase3check.mjs` in session 65f09859's scratchpad):
  - Kanban toolbar dragged by its background: no error toast, the indicator stays green, `workspace.json` holds the position, and quitting closes the app with no dialog and no rescue folder.
  - The board file made read-only (so the save's rename fails with `EPERM`), then a column added: the indicator turns red and the toast offers Retry. The file is made writable again and Retry is clicked: both columns are on disk and the indicator is green.
  - Noticed: the failed attempt's preserved `.tmp` stays beside the board after the successful retry, and the toast's advice ("free up space or fix permissions") doesn't fit a file another program holds. Both are older behaviour, left for Phase 6.
- `npm run ci:verify` is green: lint, svelte-check, `typecheck:main`, 5,734 tests passed (1 skipped), the build, and 66/66 gates. As in Phases 1 and 2, the run was on a checkout that also held the Phase 5 session's uncommitted work.
- Docs: CLAUDE.md (gate count, the `ipcSecurity` row, the tree, rescue copies, a drift gotcha) and KNOWN_LIMITATIONS #33.

### Deviations from the plan

1. **A21-16: the read never failed.** `vault:read-file-text` is the trusted read channel (`FILO_READ_EXEMPT`) and doesn't refuse `.filo/`; only the write did. So the gate covers the `vault:*` channels whose main handler calls `assertNotInFiloDir`, read from main itself, with a tripwire on the three write channels. It flags a `.filo/` literal, or a constant initialised with one, in such an invoke. The sentinel helpers pass paths from `machineSentinelPath`, so none needed the `// allow-filo-path:` marker (the marker is supported).
2. **A21-16: no component test.** The characterisation spec covers the planned component test and more (the save, no failed path, close with no dialog, the position back on reopen).
3. **A21-17: the helper lives in main, not `shared/ipcEnvelope.ts`.** It needs main's typed errors (`NoActiveVaultError`, `PayloadTooLargeError`…). `errorResult` covers the channels whose envelope says `success`. The code keeps the fs errno as-is instead of `ipcErrorCode`'s folding (which turns `EBUSY` into `IO_ERROR` and `EPERM` into `EACCES`), because the retain rule reads it. `IO_ERROR` is admitted per scheduler (`retainIoError`) rather than added to `RETAINABLE`, so the note writer is unchanged.
4. **A21-17: the gate names its channels.** `ipc-errors-carry-code` checks a list of write handlers (`vault:init-config`, `board:save` / `create`, `config:save` / `save-workspace`, `theme:save` / `delete`, `tags:save`, `templates:layout:*`) instead of every `{ ok: false` in `src/main/ipc/`. Read and validation handlers keep their own typed codes.
5. **A21-17: a config failure is kept only when a re-fire can fix it.** If any target in the bundle failed on something the user must decide (a change outside Filo, a corrupt file), the write isn't retained, so a quit drain can't re-prompt.
6. **A21-18: rules the plan left open.**
   - A file that changed but can't be read right now fails as `EBUSY` (kept for Retry) instead of being written over.
   - A config deleted and put back is content-checked even when its stamp matches the baseline. This keeps the existing guard for a same-size, same-second foreign recreate.
   - Reload re-parses the slice with the parser the vault open uses (`parseSettingsSlices`, now exported); Reload of `appearance.json` also applies the theme.
   - The planned `CONFIG_EXTERNAL_EDIT` message is the `EXTERNAL_EDIT` code with `kind: 'config'`.
7. **A21-18: `recovery:snapshot` may copy a Filo config file.** It accepts `.filo/<config>.json` for purpose `keep` only, since the copy stays inside `.filo/`. That is how Keep local and the layout rule back up a config.
8. **A21-19: a copy that comes back mid-create.** `config:save` reserves the name with `'wx'` before the atomic write, as `vault:create-file-text` does. An `EEXIST` is reported as a change outside Filo, and the old baseline makes the next save compare against the returned copy.
9. **A21-20: Keep local asks once.** The old watcher prompt meant to ask a second time when the writer ran. Now both sides share one prompt, and Keep local moves the baseline to the version it just copied, so the next save writes without asking.
10. **A21-21 (a): `markPathReported` instead of `markPathFailed(path, { retry })`.** The note writer calls it when a `transform` write fails with nothing queued for the path. `WriteStateInfo` carries `reportedPaths`, which the save popover lists.
11. **A21-21 (c): the fix is in the note writer, not in `clearFailedPathAfterLateSuccess`.** A write that fails with a missing file after its pending entry was re-keyed settles the old path. It also skips the "File save failed" toast, which the characterisation spec showed was a false alarm too.
12. **A21-22: nothing per-file to drop yet.** The write-error toasts only offer Retry, which acts on every failed write, so it is passed as a shared action and stays. The per-file mechanism and **Details** are in place for callers that add per-file buttons.
13. **A21-23: names.** `pendingPayloads()` became `unsavedConfigPayloads()` and `unsavedMiscPayloads(isUnsaved)`. Main needed no change, because `_filo__<name>.json` is already a name outside `.filo/`. The tags copy is the pre-merge snapshot.
14. **A21-24: bytes, not a hash.** The load-failure dedupe compares the flattened name, the size, then the bytes. Encoding conversions use `keep` as well.
15. **A21-25: no change to `vault.svelte.ts`, which is at its size ceiling.**
    - The modal reads the unfinished save's time itself (`checkRecovery`).
    - The rescue notice is a `survivesSwap` toast that the `ui` pre-swap keeps, rather than a message `saveBeforeLeaving` returns for `openVault` / `closeVault` to post.
    - `shell:show-item-in-folder` also accepts a rescue folder written this session, whose vault may have closed.
    - `recovery:list` rows now carry a `kind` and include `orphan-tmp/<ts>/` files, so the vault-open "preserved snapshots" toast counts those too.
    - The modal's title is now "Changes that may not have been saved", and **Open** doesn't dismiss it.
16. **A21-25 (4): the teardown is bounded at 2 s.** The ready path and the timeout share `teardownAndDestroy`.
17. **A21-26: a raw view isn't asked about twice.** Its own prompt ("Raw edits not saved") already covers it, so the new gate leaves out those paths.
18. **A21-27: what counts as held.** Only the note prompts are held decisions. A board or settings drift prompt that is dismissed fails its write (`EXTERNAL_EDIT`), which is the red state with its own toast. Quit treats `attention` like `error`, so it asks.
19. **Tests that pinned the old behaviour were updated:**
    - `configResurrectionGuard` (a deleted config is now created again);
    - `keepLocalBackup` (the `keep` purpose);
    - `workspace` (the layout carries `kanbanToolbar`);
    - `driftPromptDedup` (wording);
    - `fileTagsCascade` (a failed sweep write is reported, not failed);
    - `markdownCrashWindowSentinel` (the sentinel's spelling);
    - `tabCloseSaveFailure` (wording);
    - the E2E `recoveryRelaunch` (the modal title).
20. **File sizes.** `KanbanSideToolbar.svelte` shrank to 1473 lines and `vault.svelte.ts` to 1611 (a comment tightened to make room). Their allowlist rows were lowered.
21. **Shared checkout.** Phase 5's work was still uncommitted in the same checkout. This commit stages only Phase 3's hunks, so its CLAUDE.md says 65 gates; the working tree says 66, and Phase 5's commit brings its own gate.
22. **Noticed, not fixed here:** the vault-open toast "preserved … from a previous failed-load window" lists every recovery file (rescue copies and kept versions too) with that wording. It belongs with the Phase 6 wording work.

---

## Phase 4: The leave / quit / teardown lifecycle

A single structural change closes most of this phase's findings: **flush everything components hold before the final unsaved check, and unmount views before that check, not in pre-swap after it.**

### A21-28 · The leave sequence checks for unsaved work before components hand over their last changes (MEDIUM)

**What goes wrong.** `fireVaultSwap` awaits each pre-swap handler in order. The actual order was captured at runtime: `tabs` is 5th, `boardWriteScheduler` 10th, `noteStore` 27th, `boardCache` 28th. Views therefore unmount *after* `saveBeforeLeaving`'s check. Their teardown saves are then queued and cancelled by later handlers, with the sentinel marked clean. The casualties:
- a tile title renamed within 200 ms of Close;
- the raw view (A21-02);
- the Task List / Kanban `lastView`;
- the mind-map viewport;
- keystrokes typed during the save.

Related findings folded in: #31 and #34 (editors stay editable during the save, and `hasUnserialised` isn't counted) and REL writeBody vault-swap.

**Fix.**
1. **Component flush registry** (`src/renderer/lib/boards/componentFlush.ts`): `registerComponentFlush(id, flush: () => Promise<void> | void)`, returning an unregister function. Register:
   - raw views (replacing A21-02's interim hook);
   - title editors (A21-29);
   - timer tiles (A21-30);
   - canvas viewports (A21-31);
   - `filtersAndViews` / `lastView` flushers;
   - `NoteEditorView.serialize`.
2. `vaultStore.save()` runs `flushAllComponents()` first. So does the quit drain, since it calls `save()`.
3. `saveBeforeLeaving` runs inside `runWithCloseDrain`, so editors freeze during the save. It calls `flushAllComponents()`, saves, flushes components again (to catch anything typed during the save), then checks `unsavedWork()`. That check also counts views with `hasUnserialised`.
4. **Defensive last line.** The `noteStore` pre-swap handler (`notes.svelte.ts:970-976`) must not `reset()` silently while `writer.queuedPaths()` or an unsaved body is non-empty. It writes rescue copies for those paths first, keeps the sentinel dirty, and logs. This should never fire after steps 1–3; it's there so a future regression loses nothing.

**Gate.** `teardown-saves-registered` (`components` group): a component whose `onDestroy` or effect cleanup calls a persist/commit/save function must also call `registerComponentFlush`.

**Tests.** Characterisation specs for each casualty: rename then an immediate close; a filter change then close within 300 ms; pan then quit within 1.5 s; typing during a slow save (harness-delayed IPC). Each must end with the change on disk or named in the leave dialog.

### A21-29 · A tile or frame title typed but not committed is dropped on unmount (LOW)

`TileHeader.svelte` teardown (L228-237) and `Frame.svelte` (L281-285) commit only when `blurCommitTimer !== null`. **Fix:** commit whenever the title editor's text differs from the committed title, and register with the flush registry.

### A21-30 · The timer tile's unmount save goes to the wrong board (LOW)

`TimerTile.svelte` `onDestroy` (L268-282) writes through `scope.board`, which has already switched to the new board. **Fix:** `boardCacheStore.persistUpdateTile(tile.id, { remaining }, tile.boardId)`.

### A21-31 · The mind-map viewport debounce isn't flushed on save or quit (LOW)

`canvas.svelte.ts schedulePersistViewport` (L97-110). **Fix:** register each scope's `flushPendingViewport` with the flush registry.

### A21-32 · Deleting a board cancels its pending write (LOW)

`boardCacheDelete.deleteBoard` (L70-95) cancels the write before moving the board to the trash, so the trashed copy misses up to 300 ms of edits. If the trash move fails, the edits also drop out of tracking. **Fix:** `await flushBoardWrite(boardId)` before `trashVaultPath`, and on failure `markDirty(boardId)`.

### A21-33 · `withDrainedWrites` lets a concurrent sibling skip its drain (MEDIUM)

**What goes wrong.** `vaultOperations.ts:214-240`. `drainPromise` stays set for the whole `await op()`, so any call arriving *during* a long outer op (the tag sweep's loop) takes the re-entrancy branch. It judges itself against the outer op's stale drain result and runs with no drain, concurrently with the outer op.

**Fix.**
1. Make nesting explicit: `op` receives a `DrainToken`, and nested helpers pass it on (`withDrainedWrites(op2, { paths, within: token })`).
2. A call **without** the token while a drained op is running is queued, and runs its own drain after the outer op finishes.
3. Audit every nested caller (grep `withDrainedWrites` and the rename / trash / restore wrappers) to pass the token.
4. A dev-mode watchdog logs if a queued call waits more than 30 s: a missing token would otherwise deadlock.

**Tests.** A unit test: an outer long op plus a concurrent sibling → the sibling drains after the outer op finishes. A nested call with the token runs immediately.

### A21-34 · Silent failures in rename and tag-sweep recovery (LOW)

- **#24.** `renamePathKeys.renameAllPathKeys` (L87-101) and `history.svelte.ts` (L788-796) only log sweep throws to the console.
  - **Fix:** send them to `reportError` and return a failure flag, so the rename cascade keeps its sentinel for a retry on the next open.
- **#30.** `renameCascadeRepair.repairRenameCascade` (L44-73) replays old→new rewrites without checking disk, and **Discard** also runs the repair (`vault.svelte.ts:783-811`).
  - **Fix:** replay an entry only if `oldPath` is missing and `newPath` exists (stat both). **Discard** clears the sentinel and changes nothing.
- **#22.** `tagRewriteSweep` (L241-253) treats ENOENT as moot, then clears the sentinel.
  - **Fix:** look up the path in a rename map recorded during the sweep and retry there. If no new path is found, record it as "skipped: missing", keep the sentinel, and name the file in the result toast.

### A21-35 · An exclusive create can leave a 0-byte note, or delete a foreign file (LOW)

`vault.ipc.ts vault:create-file-text` (L646-663). **Fix:** register `suppressWrite` before the `wx` open. On the failure path, unlink only if the file is still 0 bytes and its inode and mtime match the placeholder's.

### Phase 4 exit criteria
- The new characterisation specs pass.
- The real app's quit with the window X during typing, a title edit and a raw edit → everything is on disk.
- A re-run of the concurrency-stores audit dimension on the changed files finds nothing new.

### Status: done (2026-09-26)

A21-28 to A21-35 are implemented, with the deviations below. Every new test was run against the old behaviour first (the fix taken out again) and failed there, except where noted.

- **A21-28.** New `src/renderer/lib/boards/componentFlush.ts`: `registerComponentFlush(id, flush)` and `flushAllComponents()`. A flush hands what a mounted view holds to its writer; one that throws is reported and the rest still run.
  - `vaultStore.save()` runs `flushAllComponents()` first, before the command chain settles, so Ctrl+S, close, open-another-vault and the quit drain all see it.
  - Registered: tile and frame titles (A21-29), the timer tile (A21-30), each pane's canvas viewport (A21-31), the Kanban `lastView` (`flushLastView` in `KanbanBoard.svelte`) and the Task List one (`TaskListFiltersAndViews` registers itself and unregisters in `dispose()`).
  - `saveBeforeLeaving` raises the close-drain gate (`holdCloseDrainUntilSwap`) for the whole leave, so the editors stay read-only from the save until the swap has unmounted them. The gate's pre-swap reset now runs after `tabs`, and staying (Cancel) lowers it again. It saves, flushes the components again, saves once more if that left anything, and only then checks `unsavedWork()`. The raw view's textarea is frozen by the gate too.
  - `unsavedWork()` counts a note whose editor holds keys it hasn't serialised yet (a new `unserialised` view hook).
  - Last line: the `noteStore` pre-swap handler (now ordered after `tabs`) checks for a note change still queued when the vault is let go as saved. Such a change is copied to `.filo/recovery/<ts>-unsaved/`, the sentinel is set again, and it is logged (`lib/notes/leftBehind.ts`), instead of being reset away. A leave with rescue copies already kept adds no second copy.
  - Leaving, and the window-close quit, first take focus off a focused input or textarea (`releaseFocusedField`), so a field that saves only on blur hands its text over before the save. Ctrl+S doesn't, so it never takes the caret away.
  - Gate `teardown-saves-registered` (`components`): a component whose `onDestroy` or effect cleanup calls a persist / commit / save / flush function must call `registerComponentFlush` (or `registerRawView`); a note-store call is exempt, and a line can carry `// allow-teardown-save: <reason>`. Proven by removing the timer tile's registration: the gate failed at its `onDestroy` line; restored. Gate count is 67 in the working tree.
  - Tests: `src/tests/characterisation/leavingKeepsHeldChanges.test.ts` (harness `harness/leaving.ts`), six cases:
    - a tile title typed but not committed, then Close vault;
    - a title typed and clicked away from (the 200 ms blur window open), then Close vault;
    - a Task List smart-list change, then Close vault inside 300 ms;
    - a canvas pan, then quit from the window inside 1.5 s;
    - the editor is read-only while the leave's save is out, and keys that got in anyway are saved with no dialog;
    - a running timer's progress when another board replaces it;
    - notes typed in a Task List task's notes box and not yet left, then quit from the window (added after the review below).
    The first five and the last failed with the fixes taken out (no component flush, the old teardown rule, no second save, no freeze). `src/tests/unit/leaveLastLine.test.ts`: the registry, and the last-line copy (failed without it).
- **A21-29.** `TileHeader` and `Frame` commit on teardown whenever the editor's text differs from the committed title (`uncommittedTitle()`), not only while the blur timer is armed, and register a flush that commits it. Three older source-shape tests were updated to the new teardown text.
- **A21-30.** The timer's unmount save goes through `boardStore.persistUpdateTile(tile.id, { remaining }, tile.boardId)` and is registered as a flush. The progress was also lost for a second reason, see deviation 5.
- **A21-31.** The canvas scope has `flushViewport()`; each `PaneView` registers it.
- **A21-32.** `deleteBoard` writes the board's pending change (`ctx.flushWrite`) before the move, then cancels anything armed since. A move that fails arms a write again (`ctx.markDirty`), so the board's changes stay tracked. `boardCacheDeleteBoardCancelPending.test.ts` now pins "written before the move, never after", plus the failed-move case; both failed on the old code.
- **A21-33.** `withDrainedWrites(op, { paths, within })`: `op` receives a `DrainToken`. A call that passes a live token for the current vault runs at once under the outer drain, judged against its own `paths`. Any other call waits its turn in a per-vault-generation queue, re-checks the vault, and drains for itself. A token counts only while its op (and the nested calls it started) run. A dev-mode watchdog warns when a queued call waits over 30 s. `renameVaultPath`, `trashVaultPath` and `restoreTrashed` take the token as an optional last argument. Callers that now pass it: `vaultFolderOps.runRename`, `vaultDeleteOps.performDelete`, `trashFiles` (through `DeleteTilesCommand` / `DeleteTaskCommand` options) from `selectionActions`, `TileHeader` and `taskDeletion`. Test: `src/tests/unit/withDrainedWritesToken.test.ts` (8 cases; the sibling-drains-after-the-op, wait-for-unawaited-nested and watchdog cases failed on the old code). `vaultOperationsDrain.test.ts` and `vaultIdentityGuard.test.ts` pass the token in their nested cases.
- **A21-34.**
  - #24: `renameAllPathKeys` returns false and reports (`reportError`) a sweep that throws; the history sweep throws once, naming the undo steps that couldn't follow. The in-app rename (`vaultFolderOps`) and the external rename (`runExternalRenameCascade`) keep the rename-cascade sentinel when that happens.
  - #30: `repairRenameCascade` replays an entry only when the old path is missing and the new one exists (`vault:file-exists` on both); **Discard** calls the new `discardRenameCascade`, which clears the sentinel and changes nothing.
  - #22: the tag sweep records renames made while it runs (`registerPathRenamable('tagRewriteSweep', …)`) and retries a missing note at its new path; a note with no new path is listed in `skippedMissing`, named in a warning toast, and keeps the sentinel.
  - Tests (9 failed on the old code): `renamePathKeys`, `commandRenamePath`, `vaultFolderOpsRename`, `renameCascadeTagsFlush`, `renameCascadeRecovery` and `tagRewriteSweep` cases. `tagsSaveReloadAndSwapBookkeeping.test.ts`'s mock now answers `vault:file-exists`.
- **A21-35.** New `src/main/vault/exclusiveCreate.ts` (`createExclusiveFile`), used by `vault:create-file-text` and by `config:save … { createOnly }`, which had the same unlink. It reserves the name with `'wx'`, records the placeholder's `ino` and `mtimeMs` from the handle, writes with `expectStat` on the placeholder, and on a failure unlinks only a file that is still that 0-byte placeholder. The handler registers `suppressWrite` before the open. Test: `src/tests/unit/exclusiveCreatePlaceholder.test.ts` (9 cases, 6 failed on the old code). KNOWN_LIMITATIONS #31 has a line for the empty-file echo.
- Docs: CLAUDE.md (gate count, the `components` row, the tree, the leave rule, the drain token) and KNOWN_LIMITATIONS #31.
- **Real app** (Playwright `_electron` against the built app, a fresh vault and user-data dir; script `phase4check.mjs` in session c77695's scratchpad). Each case closes the window with its close button straight after the edit, so main asks the renderer to save and nothing unmounts:
  - keys typed at the end of a note in a Document tab: on disk;
  - a new mind-map text tile's title typed after F2, not committed: `title: Quit while naming` on disk;
  - text typed in the raw view: on disk.
  - Every quit closed with no dialog (three runs); there is no `.filo/recovery/` folder and no dirty sentinel afterwards, and there were no console errors.
- **Concurrency review** (exit criterion 3: a read-only adversarial pass of the concurrency / stores dimension over every file this phase changed). No HIGH findings, no deadlock on the new drain queue, no way for the editors to stay frozen. Acted on:
  - MEDIUM: fields that save only on blur (the Task List notes box and task title, a Kanban column title) weren't handed over by a window-close quit, Ctrl+S or a keyboard-driven leave. Fixed for leaving and quitting with `releaseFocusedField`, with the spec case above (it failed first).
  - LOW: the last line's `markDirty` relied on module order to come after `writeStateTracking`'s `markClean`. The `noteStore` handler now declares `runAfter: ['tabs', 'writeStateTracking']`.
  - Left as noted (LOW): see deviation 14.
- `npm run ci:verify` is green: lint, svelte-check (0 errors, 772 files), `typecheck:main`, 5,770 tests passed (1 skipped), the build, and 67/67 gates. As in Phases 1 to 3, the run was on a checkout that also held the Phase 5 session's uncommitted work.

### Deviations from the plan

1. **Raw views stay on their own registry.** `noteStore.flushAll()` already saves them first (Phase 1) and reports which couldn't be saved; the component registry only hands changes over and has no result to give. The editors' `NoteEditorView.serialize` is likewise already run by `noteStore.flushAll()` (each view registers it when it acquires the note), so the new piece there is counting unserialised keys in `unsavedWork()`.
2. **The freeze lasts until the unmount, not only through the save.** The plan had `saveBeforeLeaving` run inside `runWithCloseDrain`, which lowers the gate when it returns: the editors would be editable again between the check and the swap's unmount, the very gap the finding is about. `holdCloseDrainUntilSwap` keeps it raised until the swap resets it (after `tabs`), and Cancel lowers it.
3. **The second save runs only when something is left.** After the first save the components are flushed again; `save()` runs a second time only if `unsavedWork()` isn't empty, so a clean close costs one save.
4. **The last line copies, it doesn't write.** It runs only for a leave that ended `saved` (after "Close anyway" the copies already exist). It doesn't try a late write into a vault being closed; a copy plus the sentinel makes the next open offer it, which also shows the regression.
5. **A21-30: the progress was lost for a different reason.** At a board switch the tile comes in as a new object with the same values, and the re-seed `$effect` rewound the live countdown to the last saved value just before the unmount save compared them, so the save never ran. The re-seed now compares mode, duration, remaining and running state by value. With that fixed, the spec also passes with the old write through the pane's board: in the harness the tile unmounts before the pane's board changes. The write through `tile.boardId` is kept, as planned, since it doesn't depend on that order.
6. **"Keys typed during a slow save" was not a loss on the old code.** The note writer's `flushAll` already picked up keys serialised during its own read. What the old code got wrong was the editor still taking keys after the check; the spec asserts the freeze instead (it failed on the old code), and that keys which got in anyway are saved without a dialog.
7. **The gate works by name.** `teardown-saves-registered` looks for calls named `*persist*`, `*commit*`, `*save*` or `*flush*` in `onDestroy` bodies and effect cleanups, exempts `noteStore.*` (the save covers the note store itself), and accepts `registerRawView`. The Task List's board-switch flush carries `// allow-teardown-save:`, because its registration lives in the `TaskListFiltersAndViews` object it belongs to (and `TaskListBoard.svelte` is at its size ceiling).
8. **A21-32: a failed flush doesn't stop the delete.** Its toast has already been shown, and the user asked for the board to go.
9. **A21-33 (drain token):**
   - Queued callers still share a failed drain's result when no op has run since they queued, so a drain parked on a failed write (up to ~60 s) isn't repeated, and toasted, per caller. Once an op has run, the next call drains afresh.
   - The queue is released only after the op and every nested call it started have settled, including ones it didn't await.
   - Queues are per vault generation, so a call for a newly opened vault never waits behind the outgoing vault's op.
   - `taskDeletion` no longer awaits `historyStore.execute` inside the drained op; it starts the command there and awaits it after. An op that awaits the history chain can deadlock: an undo already running on the chain may have its restore queued behind that op. CLAUDE.md now says so.
   - In the tile-delete paths the command's trash move usually starts a few microtasks after the op returned, so it drains for itself rather than under the outer drain. That's one extra drain, never a deadlock.
10. **A21-34:**
    - A Retry that finds an entry the disk doesn't confirm (the old path still there, or the new one missing) doesn't replay it, but still clears it: there is nothing to repair, and keeping it would bring the prompt back on every open. An entry whose check throws is kept.
    - A path-key sweep that fails during the Retry keeps the sentinel too.
    - The missing-note toast comes from the sweep itself, next to its non-UTF-8 toast; `skippedMissing` is also on the result, which no caller reads yet.
    - The rename map is one sweep registered at module load, recording only while a tag sweep runs (sweeps are serialised). It covers the write phase; a note already missing when the sweep starts only means the index was behind, and is still skipped quietly.
    - The history sweep throws once at the end and `renameAllPathKeys` reports it, so the failure isn't reported twice.
11. **A21-35:**
    - The placeholder's empty bytes are registered with `suppressWrite` too, or its own 0-byte event would get through. KNOWN_LIMITATIONS #31 notes the cost.
    - The write carries the placeholder's stat as `expectStat`, so a file another program puts at the name during the write now makes the create fail with `EEXIST` (the note writer then picks another name; the config scheduler keeps the other copy) instead of being overwritten.
    - The helper is shared by `vault:create-file-text` and `config:save … { createOnly }`.
12. **File sizes.** `vault.svelte.ts` is 1596 lines (the Discard block shrank; a comment was tightened for the flush call), and its ceiling is lowered to that. `KanbanBoard.svelte` and `TaskListBoard.svelte` are unchanged in length. The new spec is registered with the `characterisation-suite` gate (7 cases).
13. **Blur-only fields are handed over by focus, not registered.** The review found text fields that save only on blur. Rather than registering each (`TaskItem.svelte` and `KanbanColumn.svelte` are at their size ceilings), leaving and the window quit blur whichever field has focus; only one can hold unsaved typing at a time. Ctrl+S still doesn't hand such a field over.
14. **Review findings left as they are (LOW):**
    - The tag sweep now holds the drain queue for its whole loop, so an external rename during a sweep waits for it. Notes moved by a second rename in that time are reported as missing by the sweep (its sentinel is kept, nothing is lost), and edits to them wait for the rename to be applied.
    - With one Kanban or Task List board open in two panes, each pane flushes its own filter state on a save, and the last one wins. View state only.
    - `deleteBoard`'s flush can raise the board drift prompt, and the delete waits for the answer; edits made during that wait aren't in the trashed copy.
    - The empty-bytes echo window of a new note (deviation 11) also hides an external truncate of that note for about 7 s; the next write's fresh read turns it into the conflict prompt.
15. **Shared checkout, not committed.** Phase 5's work is still uncommitted in the same checkout, and several Phase 4 changes sit inside it: the drain token passes through code Phase 5 moved (`selectionActions.ts` `requestDeleteSelected`, the delete commands' options), and both phases edit `KanbanBoard.svelte`, `TaskListBoard.svelte`, `boardCache.svelte.ts`, `history.svelte.ts`, `vaultDeleteOps.ts`, the `components` and `codebase` gate modules and CLAUDE.md. Phase 4 can't be committed on its own without Phase 5 underneath, so neither is committed yet.
16. **Found while doing this, not fixed here:**
    - `board:create` checks `pathExists` and then writes, so a same-named board created in between is overwritten; `createExclusiveFile` with a ` (n)` retry would fix it.
    - `copyFileToVault` (`src/main/vault/fileOps.ts`) unlinks its `wx` placeholder unconditionally on failure, the same shape as A21-35.
    - In the real app, a key typed the instant after F2 opens a tile title editor can be lost: the editor selects all on a microtask after it mounts, so a key that lands first is replaced (one run saved "uit while naming"). A Phase 6 item.

---

## Phase 5: Kanban / Task List correctness, undo, shortcuts

### A21-36 · Undoing a cascade delete loses a card's column or section placement (MEDIUM)

**What goes wrong.** `boardFrontmatterSync.cascadeDeleteByVaultPath` (L57-67) snapshots bare tiles only. `CascadeDeleteCommand.undo` (`groupAndBoardCommands.ts:325-384`) calls `addTile`, and the Kanban and Task List `addTile` (`core/boardTileOps/kanban.ts:43-58`, `tasklist.ts`) never restore a placement. The file comes back, the card doesn't, and an orphan tile def is written.

**Fix.** At snapshot time, build per-type child commands:
- Kanban: `DeleteCardCommand` (placement only).
- Task List: `DeleteTaskCommand` (placement only).

`CascadeDeleteCommand.undo` calls their `undo()` after restoring the file, as `DeleteTilesCommand.restorePlacements` already does for Kanban. Run `restoreCascadeStyleClears` after the placements exist.

**Tests.** A characterisation spec (sidebar-delete a Kanban card's note, undo → the card is back in its column at its position with its style and cover), the same for a Task List, plus the `command-roundtrip-coverage` gate entry.

### A21-37 · Other undo gaps (LOW)

- **#47.** `DeleteTilesCommand.undo` (`tileCommands.ts:264-308`) seeds a blank note when the trash item is gone, and forgets trash ids after a failed restore.
  - **Fix:** pass `{ skipEmptySeed: true }`, so a missing file shows as a broken reference. Keep the trash ids whose restore failed, in both this command and `CascadeDeleteCommand`.
- **#49.** `DeleteTaskCommand.restorePlacement` (`taskCommands.ts:292-305`) and Kanban's `DeleteCardCommand` drop `locked` and any unknown placement fields.
  - **Fix:** `persistAddTaskPlacement` / `persistAddKanbanPlacement` accept the full snapshot (spread it, then override `position`). Add a locked placement to the round-trip tests.
- **#51.** A sidebar delete while a Document tab is active files the command on the tab's stack and offers no toast Undo (`vaultDeleteOps.ts:138-141`).
  - **Fix:** treat a Document-tab history id as "no board", so the toast Undo is offered and routed through `historyStore`.
- **#50.** Mind Map `removeTile` for inline tiles returns before the connection sweep (`core/boardTileOps/mindmap.ts:88-128`).
  - **Fix:** run the sweep in both branches.

### A21-38 · Global shortcuts ignore the board type (HIGH for Ctrl+N)

**What goes wrong.**
- **Ctrl+N** (`AppShell.svelte:322-337`, `tile:new`) on a Kanban or Task List board adds a tile def and an `.md` file with **no placement**: an invisible card plus a stray file. On a Document board it does nothing.
- **Delete** (`tile:delete`, L351-355) opens the Mind Map "Delete tiles" confirm on Kanban. Then `KanbanBoard.svelte:589-594`, which doesn't check `defaultPrevented`, also deletes, leaving a stale dialog. This was traced in the code; confirm it in the real app.
- **Ctrl+A** (`tile:select-all`, L340-348) always beats `tasklist:select-all` (`TaskListBoard.svelte:1152`), because `core/hotkeys.ts:90` is first-match-wins.
- **Ctrl+G** and **Ctrl+T** are likewise ungated.

**Fix.**
1. Give every Mind-Map-only AppShell command `enabled: () => boardStore.boardType === 'mindmap'`.
2. Kanban's and Task List's own keydown handlers return early on `e.defaultPrevented`.
3. `DECISION:` Ctrl+N on Kanban adds a card to the focused (or first) column, and on Task List adds a task to the current section, through each board's own add action rather than doing nothing. Default: yes, route it.
4. A unit test builds the command registry for each board type and asserts no two **enabled** commands share a binding.

**Gate.** `hotkeys-board-gated` (`components` group): every `registerCommandWithShortcut` in `AppShell.svelte` whose name starts `tile:` has an `enabled`.

### A21-39 · Rename Board on a tab doesn't persist (MEDIUM)

`Tab.svelte:84-93` → `tabStore.rename` (`tabs.svelte.ts:355`) renames only the tab, in memory; `serialize()` keeps the id alone. **Fix:** set `board.name` and `markMetaDirty()`, as `BoardBrowser.svelte:209-218` does, so the sidebar and Board Browser update. For a Document tab, label the menu entry **Rename Note Title**, and hide **Set Board Emoji** there, since it can't be saved.

### A21-40 · The Task List font-size defaults are never applied (LOW/MEDIUM)

"Task Body (px)" and "Task Section Title (px)" are read only by `applyDefaultsToAll.ts:135,146`. **Fix:** read them in `defaultTaskFontSizes()` (`lib/styles/defaultFontSizes.ts`).

### A21-41 · The selection-menu Delete differs from the Delete key (LOW)

`lib/mindmap/selectionActions.ts:57-74`: its confirm has no "Delete associated files", it ignores selected connections, it doesn't drain writes first, and its count comes from the raw `selectedIds`. **Fix:** move `requestDeleteSelected` out of `AppShell.svelte` into `lib/mindmap/selectionActions.ts` and use it from both places.

### A21-42 · The Tags Browser shows `Project` and `project` as two rows (MEDIUM)

`TagsBrowser.svelte:25-27` and `tagBrowserFilter.countTagUsage` compare case-sensitively, while tag identity elsewhere is case-folded. **Fix:** fold with `canonicaliseTagName` when building the union and when counting, and show the registered spelling (else the most-used one).

### Phase 5 exit criteria
- Tests green.
- Real app: Ctrl+N, Delete and Ctrl+A on each board type do the board's own action.
- Real app: sidebar delete then undo restores Kanban and Task List placements.

### Phase 5: status and deviations from the plan (2026-09-26)

All seven items (A21-36 to A21-42) are implemented. The new tests fail on the old code and pass on the new: each fix was removed on its own and its test watched fail. Covered by `characterisation/boardShortcutsAndUndo.test.ts` (7 cases), `unit/listBoardPlacementUndo.test.ts`, `unit/taskFontSizeDefaults.test.ts`, one new case in `unit/deleteTilesCommand.test.ts`, and new `tagBrowserFilter` cases. The real-app exit checks have not been run yet (see the Phase 8 checklist).

Deviations:

- **A21-36.** The placement snapshots (`DeleteCardCommand` / `DeleteTaskCommand`, placement only) are built inside the `CascadeDeleteCommand` constructor, not passed in by `cascadeDeleteByVaultPath`. `cascadeDeleteByVaultPath` now builds the command **before** it applies the style clears. Otherwise a folder delete holding both a card's note and its cover image would snapshot the card with its cover already cleared. Tasks are restored first to last (each at its old index) and cards last to first (each before its old neighbour). No new Command class was added, so `command-roundtrip-coverage` needed no new entry.
- **A21-37 #47.** The "keep the trash ids whose restore failed" fix was also applied to `DeleteTaskCommand`, which had the same gap. A redo adds the newly trashed items to the ones kept, instead of replacing them.
- **A21-37 #51.** "Routed through `historyStore`" is done with a new `historyStore.runOffStack(op, label)`. It runs a body in the same chain as stack commands but on no stack. `cascadeDeleteByVaultPath` takes `offStack: true` when no board stack can hold the delete. That case is now also detected when the active history id has no board in the cache (a Document tab). Without `offStack`, the command went on the Document tab's own stack, where Ctrl+Z would undo it a second time after the toast Undo.
- **A21-38.** The gate is `onMindMap()`, not `boardStore.boardType === 'mindmap'` alone. A Document tab leaves `boardStore` naming the board its pane showed before, so the check also requires `tabStore.activeTab?.boardType === 'mindmap'`. Gated: `tile:new`, `tile:select-all`, `tile:delete`, `tile:group`, `tile:toggle-lock` (Ctrl+L on Kanban only toasted "locked" and pushed an empty undo step, because a Kanban def has no `locked` field), and `template:open` (Ctrl+T; a layout template inserts canvas tiles). Ctrl+N on Kanban opens the same new-card picker as `n`, for the focused column or else the first (new command `kanban:new-card`). On Task List it adds a blank task to the last-targeted section, or else the first (new command `tasklist:new-task`). The "no two enabled commands share a binding" test is a characterisation case (`clashingShortcuts()` in the harness, checked on every board type), not a unit test: the commands are registered by mounted components. To stay under their file-size ceilings, both boards now register their shortcuts from a table. The allowlist rows were lowered to the new sizes (Kanban 1438, Task List 1966).
- **A21-39.** The Board Browser rename (`board.name` + `markMetaDirty()`) that the plan points to does **not** persist either. `markMetaDirty` writes only the `.filo/` configs, and `project.boards` is a parsed copy, not the cached board. A new `stores/boardIdentity.ts` (`renameBoard`, `setBoardEmoji`) now updates the cached board through the new `boardCacheStore.updateBoardIdentity`, which schedules the `.board.json` write, and then the project list and every tab showing the board. The tab menu, the tab emoji picker (which had the same bug) and the Board Browser all use it.
- **A21-40.** The fix goes beyond `defaultTaskFontSizes()`. It now returns the body size too, and a new task gets it. A new `defaultTaskSectionFontSizes()` supplies "Task Section Title", which `sectionOps` bakes into every section it creates.
- **A21-41.** `requestDeleteSelected(deps)` takes its board, selection and vault path as dependencies, like the rest of `selectionActions.ts`. The confirm counts only selected ids that are still tiles, lists the notes it would trash, and wraps the delete in `withDrainedWrites`.
- **A21-42.** The fold is the same `en-US` lower-casing that `canonicaliseTagName` uses, done in `countTagUsage`, which is now keyed by the folded name and keeps a count per spelling. `canonicaliseTagName` itself is not called, because it needs the whole `TagsFile`. A new `tagBrowserRows()` builds one row per folded tag, named by its registered spelling or else the most-used one.

---

## Phase 6: UI/UX, error states and wording

| ID | Where | Change |
|---|---|---|
| A21-43 | `lib/boards/boardLoader.ts:785-789` | A board that fails to load shows `result.message` in plain words, plus *"A copy is in .filo/recovery. Fix the file in a text editor, then reopen the vault."* with **Show in folder**. The older/newer-version message gets the same next step. |
| A21-44 | `DocumentEditor.svelte:225-310` | A `missing` banner for a deleted note: *"This note was deleted or moved."* with **Close tab** and **Restore from Trash** (when a trash entry matches). |
| A21-45 | `TileHeader.svelte:313`, `boardCache.svelte.ts:705-723` | "Recreate backing file" really recreates a text tile's note (exclusive create with `title:`). Hidden for media tiles. It never says "Synced" while the file is still missing. Remove the "single-tile and bulk paths" comment left over from Sync All. |
| A21-46 | `AudioTile.svelte:207` (and Video) | Check the broken-reference state before showing a media error: *"File not found"*, not *"format not supported"*. |
| A21-47 | `TileHeader.svelte:293` | File-tile re-link accepts any extension. |
| A21-48 | `AppShell.svelte:496`, `HomeScreen.svelte:219-342`, the Ctrl+S label | Use "vault" everywhere ("Recent vaults", "Save vault" or just "Save"). Add a one-line explanation on Home: *"A vault is a folder of your Markdown notes and board files."* The empty state reads **Create or open a board**. |
| A21-49 | `lib/editor/linkUrl.ts:31`, `linkClicks.ts:10` | `normaliseLinkUrl` returns null unless `isOpenable(href)`: only https, http, mailto, tel and filo are accepted, so `ftp:` and `sms:` stay refused. |
| A21-50 | `TextFormattingToolbar.svelte handleApplyLink` | Check `can().setLink` apart from URL validity: *"Links can't go in a code block."* |
| A21-51 | `lib/editor/insertLink.ts:25-27` | A caret right *before* a link inserts a new link; only a caret inside or right after a link edits it. |
| A21-52 | `lib/editor/toolbarConfig.ts:213`, `TextFormattingToolbar.svelte:231` | The heading dropdown re-reads `toolbarStore.heading` after a refused `setHeading`, so it never shows a level that wasn't applied. |
| A21-53 | `VaultSidebarToolbar.svelte:167-186`, `sidebarTagFilter.ts` | **New Folder** clears the tag filter first, so the folder is visible and its rename starts. **Expand / Collapse All** act on the filter's folder state while filtering. |
| A21-54 | context menus (Mind Map, Kanban, Task List, sidebar) | One vocabulary: `DECISION:` **Remove from board** (keeps the file) and **Delete from vault…** (moves the file to Trash). Use **Tags…**, **Style…**, **Lock/Unlock**. Same order everywhere: Open, Style, Tags, Lock, Remove, Delete. Headings are real headings ("3 cards selected", with correct plurals). Offer **Open as document** in the Mind Map tile menu too. |
| A21-55 | `main.ts:190` (`setApplicationMenu(null)`) | `DECISION:` add shortcuts rather than a native menu. Ctrl+O opens a vault from anywhere (not just Home), Ctrl+Shift+W closes the vault, Ctrl+, opens Settings, Ctrl+Shift+Z is an alias for redo (matching the design doc). List them in Settings → Keyboard Shortcuts. |
| A21-56 | `SearchPanel.svelte:69-72` | Remove the dead "Match is not placed on any board." branch. |

Tests: one component test per changed state or message. Update the `toolbarFormattingRoundTrip` link cases for A21-49 to 51.

---

## Phase 7: Hygiene, dead code, duplicates, docs

### Dead production code (delete, or move into the test helpers)

| ID | Item |
|---|---|
| A21-57 | `noteStore.restore` / `noteWriter.restore` (`notes.svelte.ts:875`, `noteWriter.ts:574-591`). This is a blind overwrite through the create-capable channel. Extend gate `single-note-writer` to forbid `vault:write-file-text` in `noteWriter.ts`. |
| A21-58 | `noteStore.hasPendingWrites` (test-only). Move it into the test helpers. |
| A21-59 | Never called: `isBoardProvisionallyMissing`, `formatDueDateRelative`, `diffToFrontmatterDelta`, `resetThemeManager`, `relativeLuminance` / `contrastRatio` (keep them if Phase 8's contrast check uses them), `deleteSentinelFile`, `sweepOrphanTempFiles` (check it isn't reached through IPC first), `unsavedListText` / `unsavedHeadline`, `buildTemplateSearchIndex`, `pathMatchingTitle`, `isTightListElement`, `titleHtmlText`. |
| A21-60 | About 25 unused schema exports; the `boardSaver.ts` facade re-exports (about 16 names); the duplicate `promptBoardExternalEdit` export (`vaultExternalChanges.ts` vs `vaultExternalDriftPrompts.ts`); the `lib/utils/ipcEnvelope.ts` barrel (2 importers, which should import `@shared/ipcEnvelope` directly). |

Verify each with `npx knip --production` and a grep before deleting.

### Duplicates (merge into one)

| ID | Item |
|---|---|
| A21-61 | Four frontmatter-fence regexes: `markdownSync.ts:98`, `frontmatterRead.ts:32`, `tagRewriter.ts:29`, `taskBodyText.ts:10`. Export one `splitFrontmatterFence(text)` from `lib/notes/noteFile.ts` and use it everywhere. Gate `single-fence-parser` (`markdownFormat`): no other file matches the fence regex. Then decide the A21-04 follow-up (a non-mapping block counts as body). |
| A21-62 | Style option enums held in three places: `constants/styleOptions.ts`, the Zod enums, and `shared/types.ts:218-228`. Derive the options from `Schema.options` and delete the `shared/types` copies. |
| A21-63 | Near-duplicate style popups: KanbanCardStylePopup vs TaskItemStylePopup, and KanbanColumnStylePopup vs TaskSectionStylePopup. Replace each pair with one shared `ElementStylePopup` with per-type field flags. This also shrinks files. |
| A21-64 | Absolute → vault-relative path helpers exist in 3 versions, and `toPosix` / `stripLeadingSlash` in 2. Move them to `src/shared/`. `VaultFileItem.svelte:107/586/625` should use the case-folded `samePath`, not `pathsEqual`. |

### Correctness leftovers

| ID | Item |
|---|---|
| A21-65 | `pathSecurity.assertSafeFilename` (L198-200): enforce the trailing dot/space rule only under `enforceWinRules`, like the other Windows-only rules. On macOS/Linux, a synced `Draft.` folder is otherwise unreadable. |
| A21-66 | Symlinked or hard-linked `.md` notes are replaced by a regular file on write (`atomicWriteFile`). `DECISION:` don't follow links. Detect a symlink at read time, mark the note read-only with a banner (*"This note is a link; edit the original"*), and add a KNOWN_LIMITATIONS entry for hard links, which can't be detected cheaply. |

### Dependencies

| ID | Item |
|---|---|
| A21-67 | Declare `@tiptap/extension-heading` and `@types/mdast` in `package.json`. Remove `axe-core` if `@axe-core/playwright` covers it (check the a11y spec first). Leave `sharp`, `png-to-ico` and `png2icons` (loaded dynamically by `scripts/generate-icons.mjs`). |

### Docs

| ID | Item |
|---|---|
| A21-68 | CLAUDE.md tree: add the missing folders and key files: `components/search/`, `lib/frames/`, `lib/tasklist/*`, `lib/tasks/*`, the main services (`syncConflictNotifier`, `watcherSupervisor`, `orphanTmpSweep`, `nonUtf8Registry`, `machineIdentity`), `protocol/filoMedia.ts`, `utils/contentSecurityPolicy.ts`, `navigationGuard.ts`, the IPC files (`vaultCopy`, `vaultEncoding`, `machine`), `shared/conflictCopy.ts`, `systemLocale.ts`, and the new modules from this plan. Fix the two entries missing a space before their comment. |
| A21-69 | CLAUDE.md Testing section: the tests live in `src/tests/unit` (flat) and `src/tests/e2e`. Rename `src/tests/unit/characterization` so it isn't confused with `src/tests/characterisation`. Reword the "~300 lines, split it" rule to match practice (139 of 484 files are over 300), or say it applies to new files. |
| A21-70 | Update the stale Properties wording: in `KNOWN_LIMITATIONS.md:60`, the comments in `titleCommit.ts:43`, `KanbanColumn.svelte:424`, `TaskListRow.svelte:21` and `vaultExternalReconcilers.ts:363`, and the test descriptions in `frontmatterDelta.test.ts:102`, `documentStoreSync.test.ts:3` and `assembleMarkdownEngine.test.ts:288`. |
| A21-71 | Move `docs/UI_FEEDBACK_1_PLAN.md` to `docs/archive/`. When this plan is done, write `docs/archive/AUDIT21_PRE_DOGFOOD_2026-09-26.md` (a findings report) and move this plan there too. |
| A21-72 | Design doc drift: the shortcut table (Ctrl+Shift+Arrow "add neighbour" doesn't exist; redo is Ctrl+Y) must match the code after A21-55. |

---

## Phase 8: Verification and sign-off (no production code)

| ID | Item |
|---|---|
| A21-73 | **Finish the UI/UX pass the audit didn't complete:** aria labels on icon-only buttons, `prefers-reduced-motion` coverage, a CSS scan for animated `width` / `height` / `top` / `left`, hard-coded colours that bypass theme variables, z-index literals, and save-state colour contrast (WCAG AA) in every built-in theme. Run the manual axe-core workflow (Actions → CI → Run workflow). Fix anything found in a small follow-up commit. |
| A21-74 | **Re-audit.** Re-run the `audit-filo-data-integrity` workflow. First update its skill brief: it still names deleted files (`markdownFileWriter.ts`, `frontmatterWriteScheduler.ts`, `conflictResolver.ts`) and an "uncommitted Phase-5 diff" that no longer exists, which cost this run a dimension. Point it at `noteWriter.ts` / `notes.svelte.ts` and the changes from this plan. |

**Real-app dogfood checklist** (Playwright against the built app and a scratch copy of the Book Vault):
1. Write in a Document tab, a text tile and the Raw view, and quit mid-typing with the window X → all saved.
2. An external editor script changes the open note while typing → the conflict prompt appears, or the change is adopted; never a silent revert.
3. Tag rename across notes with wrapped, block and scalar `tags:` → all still parse, and only the `tags:` lines changed (`git diff`).
4. Kanban: Ctrl+N, Delete, drag the toolbar, sidebar-delete a card's note and undo → correct, and no false "unsaved" dialog on close.
5. Task List: the notes box on a normal note, a read-only note, and one edited elsewhere → no silent loss.
6. Syncthing between two local folders for 30 minutes of mixed editing → no lost edits and no stuck red indicator.

Sign-off: every area scores at least 8 in a re-rated scorecard, and the checklist passes.

---

## Refuted, and not planned

- *"The prior-crash `.dirty` breadcrumb is overwritten by the new session's first write."* Refuted by review: the Esc-bypass contract holds.

## Appendix: finding → plan item

The audit workflow's result numbering (by severity):

| Finding | Plan | Finding | Plan | Finding | Plan |
|---|---|---|---|---|---|
| 1 Raw view close/quit | A21-02 | 18 Board drift Reload | A21-20 | 35 Rescue toast wiped | A21-25 |
| 2 Raw view toggle | A21-03 | 19 Config drift blocks | A21-18 | 36 Title uncommitted | A21-29 |
| 3 Tag flow list | A21-01 | 20 Failed without retry | A21-21 | 37 Timer tile | A21-30 |
| 4 Error codes dropped | A21-17 | 21 Rescue `.filo` | A21-23 | 38 Viewport | A21-31 |
| 5 Notes box read-only | A21-06 | 22 Tag sweep ENOENT | A21-34 | 39 Transform base | A21-11 |
| 6 withDrainedWrites | A21-33 | 23 Recovery modal | A21-25 | 40 CRLF | A21-13 |
| 7/16 Kanban toolbar | A21-16 | 24 renameAllPathKeys | A21-34 | 41 Delta twice | A21-12 |
| 8/46 Config deleted | A21-19 | 25 Tab-close wording | A21-26 | 42 Rewriter bytes | A21-14 |
| 9 Snapshot prune | A21-24 | 26 destroyOnTimeout | A21-25 | 43 Create placeholder | A21-35 |
| 10/13 Typing vs adopt | A21-07 | 27 Toast aggregator | A21-22 | 44 Dead restore | A21-57 |
| 11 Teardown saves | A21-28 | 28 Trailing dot | A21-65 | 45 Symlinks | A21-66 |
| 12 No main stale check | A21-08 | 29 Torn read | A21-10 | 47 Undo after purge | A21-37 |
| 14 Leading `---` rules | A21-04 | 30 Cascade repair | A21-34 | 48 Board delete | A21-32 |
| 15 Notes box stale draft | A21-05 | 31/34 Leave keystrokes | A21-28 | 49 Placement fields | A21-37 |
| 17 Cascade undo | A21-36 | 32 Phantom failure | A21-21 | 50 Inline connections | A21-37 |
| | | 33 Index stale | A21-15 | 51 Doc-tab undo | A21-37 |

Raised during review: the watcher blind spot → A21-09; transform after a failed flush → A21-11; the external-rename phantom → A21-21; the Raw toggle race → A21-03; writeBody on a vault swap → A21-06 / A21-28; toast actions → A21-22; timeout listeners → A21-25.

The follow-up passes produced A21-38 to 42 (shortcuts, rename board, task font sizes, menu delete, tags case) and A21-43 to 56 (UI states and wording), plus the Phase 7 hygiene items.

# Library updates and new tools: implementation plan

**Status (2026-10-03): Phases 0 and 1 done; Phases 2–8 not started.** Each phase gets an "Outcome" section here when it is done (what changed, deviations, new findings), as in earlier plans.

Source: [TRACK_B_INVESTIGATION_2026-10-02.md](TRACK_B_INVESTIGATION_2026-10-02.md) §6, asked for by the owner on 2026-10-02: "do the library updates you said to do and the worth-addings as well".

**In scope**
- the updates to take now (§6.1);
- the TipTap package tidy-up (§6.2);
- the four "worth having" additions: CodeMirror 6 for the Raw view, micromark as a second Markdown parser in the tests only, Vitest's browser mode, and knip;
- one enabling step: the 18,870-note corpus check moved into the repo. Phase 3 needs it to verify the TipTap update, and today its scripts exist only in two old sessions' temporary folders, which Windows may clear.

**Not in scope**
- The "wait" items (§6.3): Electron 45, TypeScript 7, Vite 8 with electron-vite 6, markdown-it 15, yaml 3, electron-builder 27. Each has a date or a trigger in the investigation.
- The "skip" items (§6.4): js-yaml 5, nanoid 6.
- The optional and conditional tools (commonmark.js, virtua, node-diff3).
- Track B (B1a–B1d) and the Markdown profile: their own plan, later.

## How to read the scores

Every score is out of 10:
- **Useful**: 0/10 = no gain; 5/10 = a clear improvement you'd notice every week or so; 10/10 = essential.
- **Hard**: 0/10 = minutes; 5/10 = a few days, several files, new tests; 10/10 = weeks, rewriting a major part of Filo.
- **Risk**: what a mistake that got past the tests could do to your notes. 0/10 = can't touch a note file; 5/10 = could re-spell some notes on their next save (nothing lost: the round-trip check opens such a note read-only first); 10/10 = could lose text.

## Overview

| Phase | What | Useful | Hard | Risk | Days |
|---|---|---|---|---|---|
| 0 | Baseline, and the corpus check in the repo | 4/10 | 2/10 | 0/10 | 1 |
| 1 | Safe updates: DOMPurify, Electron 44.5.1, Vitest 5.0.3, small dev tools, package floors, one build-config line | 3/10 | 1/10 | 1/10 | ½ |
| 2 | jsdom 30 (tests only) | 3/10 | 2/10 | 1/10 | ½ |
| 3 | TipTap 3.31.4 and the package tidy-up (own branch) | 3/10 | 2/10 | 2/10 | 1 |
| 4 | knip: find dead code, report only | 3/10 | 2/10 | 0/10 | 1 |
| 5 | A second Markdown parser in the tests (micromark), and a "one Markdown parser" gate | 4/10 | 2/10 | 0/10 | 1 |
| 6 | Vitest browser mode: editor tests in real Chromium | 4/10 | 3/10 | 0/10 | 1½ |
| 7 | CodeMirror 6 for the Raw view (own branch) | 4/10 | 4/10 | 2/10 | 3–4 |
| 8 | Verification, docs, archive | 2/10 | 1/10 | 0/10 | ½ |

About ten working days in all. Phase 7 is re-scored from the investigation's Hard 3/10 to 4/10 now that its details are known (§7.1–7.7).

**Order and what depends on what**
- Phase 0 before Phase 3: the TipTap update is verified with the corpus check.
- Phase 1 before Phase 6: `@vitest/browser-playwright` 5.0.3 requires exactly Vitest 5.0.3.
- Phase 6 before Phase 7: the Raw view's keyboard and scrolling are tested in real Chromium.
- Phases 4 and 5 depend on nothing and can move. Phase 6 reuses the toolbar cases Phase 5 moves into a shared file; if Phase 5 is moved later, Phase 6 makes that move instead.

## Conventions

- **Start from a clean tree.** Commit or set aside the uncommitted docs first (`CLAUDE.md`, `docs/BACKLOG.md`, `docs/TRACK_B_INVESTIGATION_2026-10-02.md`, this plan).
- **Each phase:**
  - leaves a working app;
  - passes `npm run ci:verify` on Windows;
  - runs the E2E suite (`npm run build && npm run test:e2e`) when it touches Electron, the build, the editor or the Raw view;
  - is committed on its own, with its phase in the commit message (never in code or comments);
  - gets an Outcome section here.
- **Branches.** Phase 3 (TipTap) runs on its own branch, as KNOWN_LIMITATIONS #32 asks, and so does Phase 7 (a component swap). Each merges once its pass tests are green. The rest commit to `main`.
- **Edits.** After editing, check `git diff --stat` for whole-file line-ending flips; the repo has no `.gitattributes`.
- **Gates.** A new gate goes into its group module in `scripts/gates/` and is proven to bite (introduce the violation, see it fail, revert). CLAUDE.md's gate count (89) is updated in the same commit.

---

## Phase 0: baseline, and the corpus check in the repo (Useful 4/10, Hard 2/10, Risk 0/10)

### 0.1 Record the baseline on `HEAD`

Record these in the Phase 0 outcome so every later phase compares against them:
- `npm run ci:verify`: test count, gate count (89), duration;
- the E2E suite with `FILO_E2E_SCALE=1`;
- `npm audit` (expected: 1 low, DOMPurify);
- `npm outdated`;
- the size of every file in `dist/renderer/assets/` after `npm run build` (Phase 7 adds a chunk);
- `dist/main/main.js` and `dist/preload/preload.js` contain no `require("zod")`: zod is bundled in, which Phase 1's config change must keep.

### 0.2 Move the corpus check into the repo

The recipe is in `docs/archive/AUDIT26_IMPLEMENTATION_PLAN_2026-09-30.md` §3.6. Its three scripts sit in session `34c369c1`'s scratchpad (`buildList.mjs`, `zzCorpus.test.ts`, `compare.mjs`).

- **`scripts/corpus/buildList.mjs`** lists the `.md` files to check, de-duplicated by content hash:
  - the repo (not `node_modules`, `.git`, `dist`, `out`);
  - the vaults folder, given as an argument (`--vaults "C:\Users\andre\My Files\Vaults"`), skipping `.filo/`;
  - `node_modules` READMEs, two levels deep.
  - Other sessions' temporary folders are no longer walked: they are machine-specific and come and go (decision 7). The list is written to the path given.
- **`src/tests/corpus/corpusRun.ts`** loads each listed note into a real editor (`createTiptapEditor`, `loadMarkdownIntoEditor`, `editorMarkdown`), with a fresh editor every 200 notes. It records the read-only verdict, a hash of the saved output, and the output itself for notes under 20 KB, as JSON.
- **`vitest.corpus.config.mts`** runs it with jsdom and `src/tests/setup.ts`, like `vitest.scratch-vault.config.mts`. It is outside the four test projects, so `ci:verify` never runs it (about 29 minutes a run).
- **`scripts/corpus/compare.mjs`** compares two result files and prints the counts:
  - both editable;
  - both read-only;
  - newly read-only;
  - output changed (and how much of that is toward the file's own bytes);
  - unlocked.
  
  It writes the lists to a JSON file.
- **npm scripts:**
  - `corpus:list -- <out> --vaults <dir>`;
  - `corpus:run` (environment `CORPUS_LIST`, `CORPUS_OUT`);
  - `corpus:compare -- <old.json> <new.json> <diff.json>`.
- **Comparing two commits:** run `corpus:run` in the main checkout and in a worktree of the base commit (`git worktree add ../filo-base <sha>`), with the same list.
- **Docs:** CLAUDE.md Quick Reference (the three scripts) and Testing Strategy (one line: when to run it: any change to the editor, TipTap, markdown-it or prosemirror-markdown).

**Pass test:** two runs on `HEAD` give identical results (`compare` reports 0 changed, 0 newly read-only), and the total is close to the Audit-26 run (18,870 notes, 372 read-only), allowing for files added or removed since.

*Changed at the start of Phase 0 (owner, 2026-10-03):* 18,192 of the Audit-26 run's 18,870 notes came from other sessions' temporary folders, almost all of them four generated speed-test vaults of filler text. Decision 7 drops those folders, so the corpus is the repo, the vaults folder and the READMEs: about 700 notes. The second half of the pass test becomes: on the paths both runs hold, the read-only verdicts are compared with the Audit-26 run. A generated set can be added with `--extra` if a later phase needs one (see Phase 8).

---

## Phase 1: safe updates (Useful 3/10, Hard 1/10, Risk 1/10)

### 1.1 `package.json`

| Package | From | To | Why |
|---|---|---|---|
| dompurify | ^3.4.15 | ^3.4.16 | Fixes the one `npm audit` finding (GHSA-p98j-92pf-mc4p, low; Filo's use can't trigger it) |
| electron | ^44.4.5 | ^44.5.1 | Chromium, V8, ANGLE and Dawn security fixes |
| vitest, @vitest/coverage-v8 | ^5.0.1 | ^5.0.3 | Fixes; Phase 6's browser provider needs exactly 5.0.3 |
| typescript-eslint | ^8.60.1 floor, 8.70.1 installed | ^8.71.0 | Fixes |
| globals | 17.12.0 installed | ^17.13.0 | Fixes |
| sharp (build-time icons) | 0.35.4 installed | ^0.35.5 | Fixes |
| eslint | ^10.4.0 (10.11.0 installed) | ^10.11.0 | Floor matches the lockfile |
| @playwright/test | ^1.60.0 (1.63.0 installed) | ^1.63.0 | Floor matches the lockfile |
| svelte-check | ^4.6.0 (4.7.6 installed) | ^4.7.6 | Floor matches the lockfile |
| yaml | ^2.9.0 (2.9.1 installed) | ^2.9.1 | Floor matches the lockfile; 2.9.1 limits recursive merge aliases |

- Run `npm install`. If Electron's postinstall leaves no binary on this machine (it has before), run `node node_modules/electron/install.js`.
- The TipTap patch is not here: it goes in Phase 3, on its own branch.
- *From Phase 0 (2026-10-03):* eslint 10.12.0 is out since this table was written; `npm outdated` lists it as wanted under `^10.11.0`. Taking it with the floor at `^10.12.0` fits this phase.

### 1.2 `electron.vite.config.mts`

- In `main` and `preload`, replace `plugins: [externalizeDepsPlugin({ exclude: ['zod'] })]` with `build.externalizeDeps: { exclude: ['zod'] }`, and drop the import.
- The plug-in is deprecated. electron-vite 5 already reads the build option, and uses it only when the plug-in is absent, so the result is the same. It is also one step of the later Vite 8 move done early.
- Keep the comment that explains why zod is bundled.

**Pass test**
- `npm run ci:verify` on Windows.
- `npm run build`: `dist/main/main.js` and `dist/preload/preload.js` still contain no `require("zod")` (as in 0.1).
- The E2E suite (an Electron change).
- `npm audit`: 0.
  - *From Phase 0 (2026-10-03):* this can't reach 0 yet. Since the plan was written, GHSA-ch52-4w7c-c8xp (`http-cache-semantics`, high) adds 8 findings through electron-builder's download chain. They are build-time only, and no release fixes them; electron-builder 27 does. See BACKLOG BL-11. Read this pass test as "only GHSA-ch52-4w7c-c8xp left, in the electron-builder chain", unless Phase 1 tries BL-11's `overrides` idea and `npm run package:dir` still works.

---

## Phase 2: jsdom 30, tests only (Useful 3/10, Hard 2/10, Risk 1/10)

### 2.1 The update

- jsdom `^29.1.1` → `^30.1.1`. Its only breaking change is the Node range (`^22.22.2 || ^24.15.0 || >=26`); local Node 24.16 and CI's Node 22.23 both meet it.
- What it fixes that Filo's tests rely on: no more spurious `blur` / `focusout` events, and the right `relatedTarget` after the focused element is removed. That is the commit-on-blur behaviour behind `titleEditFocus.ts` and the Raw view's save on blur.

### 2.2 What to watch

- **`CSS.supports` now exists in jsdom.** Two checks take a different branch under test from today:
  - `src/shared/untrusted.ts` (CSS values from files: "`CSS.supports` where available, falling back to a…");
  - `src/renderer/lib/utils/color.ts:98` (colour validation).
  
  Their tests were written for the fallback. Keep **both** branches covered: run each case once with `CSS.supports` present and once with it stubbed out (`vi.stubGlobal`), and check that jsdom's answers match what Chromium gives for the cases tested. A case that changes result is a finding, not something to quietly update.
- **Focus and blur tests:**
  - component `titleCommitsOnClickAway`;
  - unit `titleEditFocus`;
  - the tag row and Raw view characterisation specs.
  
  A test that changes result either relied on the old spurious event (make it do what a user does) or exposes a bug jsdom 29 hid (fix the code). List each one in the outcome.
- **`getComputedStyle` now gives pixel lengths.** Check the tests that read computed styles (`themeManager.ts` reads custom properties, which aren't lengths).

**Pass test:** `npm run test:unit:strict` (all three projects) and then `npm run ci:verify` on Windows. Every test whose result changed is listed in the outcome, with the reason.

---

## Phase 3: TipTap 3.31.4 and the package tidy-up, on its own branch (Useful 3/10, Hard 2/10, Risk 2/10)

Branch `chore/tiptap-3.31.4`, as KNOWN_LIMITATIONS #32 asks for any TipTap move.

### 3.1 The patch

All `@tiptap/*` packages from `^3.31.3` to `^3.31.4`, in one `npm install` that names every package, so none is left behind.

### 3.2 The tidy-up: ten re-export packages out, two real ones in

- **Remove** `@tiptap/extension-color`, `-font-family`, `-bullet-list`, `-ordered-list`, `-task-item`, `-task-list`, `-table-cell`, `-table-header`, `-table-row` and `-placeholder`. Each is now a one-line re-export of about 230 bytes.
- **Add** `@tiptap/extension-list` and `@tiptap/extensions` (`^3.31.4`) as direct dependencies. `@tiptap/extension-text-style` and `@tiptap/extension-table` are already direct.
- **Change the imports** (the only three files that use the old names):
  - `src/renderer/lib/editor/createEditor.ts`:
    - `Color` and `FontFamily` from `@tiptap/extension-text-style`, beside `TextStyle`;
    - `Placeholder` from `@tiptap/extensions`;
    - `TableCell`, `TableHeader` and `TableRow` from `@tiptap/extension-table`;
    - `TaskItem` from `@tiptap/extension-list`.
  - `src/renderer/lib/editor/listMarkers.ts`: `BulletList` and `OrderedList` from `@tiptap/extension-list`.
  - `src/renderer/lib/editor/taskItems.ts`: `TaskList` from `@tiptap/extension-list`.
- **Unchanged:**
  - `electron.vite.config.mts` reads the `@tiptap/*` names from `package.json` for the dev pre-bundle, so it follows the change on its own. Check `npm run dev` opens a Document tab without a "re-optimising" reload.
  - StarterKit still depends on some of the old packages internally. That is fine: this tidies Filo's own list and imports.
  - Keep Filo's own `FontSize` rather than TipTap's new one: their reading and writing details differ, and a swap is a byte risk with no gain here.

### 3.3 Pass test

- `npm run test:unit:strict`: the golden corpus, the property test, the toolbar suite and every round-trip suite unchanged.
- The corpus check (Phase 0) against `main`: **0 changed bytes, 0 changed read-only verdicts**.
- E2E: the whole suite, with `editorFidelity.e2e.ts`, `noBytesByLooking.e2e.ts` and `vaultSwitchAndBom.e2e.ts` read closely.
- A manual check in the built app: font, size, colour, highlight, alignment, indent and line spacing from the toolbar; a table with a column resize; checklists; the placeholder; Insert Link.
- `npm audit`.

### 3.4 Docs, then merge

- The design doc's Editor section lists the separate TipTap packages; update the list.
- Merge to `main` (fast-forward).

---

## Phase 4: knip, report only (Useful 3/10, Hard 2/10, Risk 0/10)

### 4.1 Set-up

- devDependency `knip` `^6.39.0`.
- **`knip.ts`** at the root. It plugs in Svelte's own compiler, as knip's docs give it; without that, unused exports in `.svelte` files go unreported:

  ```ts
  import type { KnipConfig } from 'knip';
  import { compile } from 'svelte/compiler';

  export default {
    entry: [
      'src/main/main.ts',
      'src/main/preload.ts',
      'src/renderer/main.ts',
      'scripts/**/*.mjs',
      'src/tests/**/*.{test,e2e}.ts',
      'src/tests/corpus/corpusRun.ts',
      'src/tests/characterisation/scratchVault/buildScratchVault.ts',
    ],
    project: ['src/**/*.{ts,svelte}', 'scripts/**/*.mjs'],
    compilers: {
      svelte: (source: string) => compile(source, {}).js.code,
    },
  } satisfies KnipConfig;
  ```

  Entries are explicit because electron-vite's three-part config isn't a plain Vite config. knip's Vitest, Playwright and ESLint plug-ins switch on by themselves; check each reads the right config files.
- npm script `knip`, report only. It is **not** in `ci:verify` (decision 2).

### 4.2 Triage the first run

Sort every finding into one of four groups and list them in the outcome:
1. **Unused dependencies:** remove now, after a grep confirms nothing imports them (`package.json` scripts and configs included).
2. **Unused files:** remove now only if no gate, test or config names them, and `ci:verify` stays green.
3. **Unused exports and types:** one backlog item (BL-NN, "knip: N unused exports"), not a mass change in this plan.
4. **False positives:** an `ignore` entry in `knip.ts`, each with its reason.

**Pass test:** `ci:verify` on Windows; the triage list in the outcome; the backlog updated.

---

## Phase 5: a second Markdown parser in the tests, and the "one Markdown parser" gate (Useful 4/10, Hard 2/10, Risk 0/10)

### 5.1 Dependencies (dev only)

- `micromark` `^4.0.3` (passes every CommonMark test);
- `micromark-extension-gfm-table` `^2.1.2`;
- `micromark-extension-gfm-strikethrough` `^2.1.0`;
- `micromark-extension-gfm-task-list-item` `^2.1.0`.

These are deliberately not the all-in-one `micromark-extension-gfm`. It also turns bare URLs into links and moves footnotes to the end, which Filo's parser doesn't do, so the text would move for reasons that have nothing to do with Filo.

### 5.2 The test: content reads the same in another parser

`src/tests/unit/markdownContentElsewhere.test.ts`:
- **Inputs:**
  - every golden corpus fixture's canonical form (`*.expected.md`, else the `.md`);
  - every toolbar case's saved output. Move `CASES` out of `toolbarFormattingRoundTrip.test.ts` into `src/tests/helpers/toolbarCases.ts`, which Phase 6 reuses.
- **For each input:**
  - render it with the note's own markdown-it: the instance `markdownSync.ts` takes from an editor and hands to `rendersSame`;
  - render it with micromark (`allowDangerousHtml: true`, the three GFM extensions and their HTML extensions);
  - read both results with `DOMParser` and compare the visible text (`textContent`, whitespace collapsed).
- Any known difference is listed in the test with its reason. None is expected for Filo's own output.
- **What it pins:** the words of every note Filo writes read the same in a strict CommonMark + GFM parser, which is how "content stays the same in other apps" is checked. js-yaml plays the same oracle role for YAML today.

### 5.3 Gate `one-markdown-parser` (group `markdownFormat`, next to `no-jsyaml`)

- **Fails if** app code (`src/renderer`, `src/main`, `src/shared`) imports `marked`, `micromark*`, `remark*`, `unified`, `mdast-*`, `commonmark` or `@tiptap/markdown`, or if any of them is a runtime dependency. Tests may import them.
- **Hint:** "markdown-it is the one Markdown parser in the app; a second one reads notes differently (the YAML lesson). Tests may use others as oracles."
- Prove it bites, as the conventions say.
- Optional, in the same commit: extend the existing `markdown-body-roundtrip` pinning so the new test must exist, un-skipped, with at least as many inputs as the golden corpus has fixtures.

### 5.4 Docs

CLAUDE.md:
- the Tech Stack "Markdown parsing" row (micromark: tests only);
- the `markdownFormat` gate row;
- the gate count.

**Pass test:** `ci:verify` on Windows, and the gate proven to bite.

---

## Phase 6: Vitest browser mode, editor tests in real Chromium (Useful 4/10, Hard 3/10, Risk 0/10)

jsdom only imitates a browser: it lays nothing out, and its selection, focus and `contenteditable` behaviour differ from Chromium's. The editor tests that depend on those run better in the real engine. This adds a fourth test project; the three jsdom projects and the Electron E2E suite stay.

### 6.1 Dependencies and the browser

- devDependencies:
  - `@vitest/browser-playwright` `^5.0.3` (it requires exactly the installed Vitest, so after Phase 1);
  - `playwright` `^1.63.0` (already installed through `@playwright/test`; declared because browser mode needs it directly).
- **Chromium for the tests:** `npx playwright install chromium`, once per machine. It downloads Playwright's build of Chromium (roughly 150–200 MB) from Playwright's servers. **It needs your go-ahead at the time**; this machine has none yet.
- **GitHub CI** (`.github/workflows/ci.yml`, job `verify`): add `npx playwright install --with-deps chromium` before `npm run ci:verify` (decision 1).

### 6.2 `vitest.config.mts`: a fourth project

```ts
import { playwright } from '@vitest/browser-playwright';
// … inside test.projects:
{
  extends: true,
  resolve: { conditions: ['browser'] },
  test: {
    name: 'browser',
    include: ['src/tests/browser/**/*.test.ts'],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
    },
  },
},
```

- The root `environment: 'jsdom'` doesn't apply in browser mode.
- `src/tests/setup.ts` stays safe there: its PointerEvent polyfill only applies when the browser has none.
- `test:unit:strict` runs `vitest run`, so it runs the new project too, with the same noise checks.

### 6.3 First specs (`src/tests/browser/`)

1. **`toolbarFormattingInChromium.test.ts`:** every case in `src/tests/helpers/toolbarCases.ts` (moved there in Phase 5, or here if Phase 5 hasn't run), in real Chromium: apply, save, reload into a fresh editor, the same document, the same bytes, not read-only. This is the toolbar suite's promise checked in the engine Filo ships.
2. **`colourSpellingInChromium.test.ts`:** pins what Chromium writes for a picked colour today (`#e03e3e` becomes `color: rgb(224, 62, 62);`, investigation W1). When the Markdown profile changes this on purpose, this test changes with it.
3. **`editorCaretInChromium.test.ts`:** caret behaviour jsdom can't lay out, driven with `userEvent` from `vitest/browser`:
   - Enter beside a soft break;
   - Tab and Shift+Tab, and Backspace at an indent (`tabKeys.ts`);
   - arrow keys across a soft break.

**Pass test:** `ci:verify` on Windows and in GitHub CI; the three specs run in Chromium; the added run time is recorded in the outcome.

---

## Phase 7: CodeMirror 6 for the Raw view, on its own branch (Useful 4/10, Hard 4/10, Risk 2/10)

Branch `feat/raw-view-codemirror`.

**Why:** the Raw view (`NoteRawView.svelte`) is a plain `<textarea>`. That means:
- no Markdown colouring;
- no line numbers;
- no find inside the note;
- invisible characters (a stray BOM, a zero-width space) stay invisible;
- "Edit in Raw view" can select the line a save would change, but not mark it as a line.

**What doesn't change:** everything around the text box:
- the save on blur, Ctrl+S, close and switching back;
- the base-hash check and the conflict banner (Show the new version / Keep mine, with its backup);
- the raw-view registry (unsaved work at close, open-another-vault and quit);
- rescue copies;
- the pending-path tracking;
- the follow-while-untouched reload.

**Settled during planning:**
- **CodeMirror runs in the jsdom test projects.** A probe on this repo's jsdom 29 ran every operation the view needs: create, type, select and scroll to a line, focus, blur, read-only, whole-text replace, find from the DOM, destroy. It needed one polyfill (7.6): without it, CodeMirror's measuring pass throws an uncaught `getClientRects is not a function` and fails the run; with it, the run is clean. So the component and characterisation suites keep covering the Raw view.
- **Keyboard shortcuts.** A `<textarea>` blocks every global shortcut but Escape. CodeMirror's text is a `contenteditable`, where shortcuts marked `allowInEditor` still fire: Open Vault (Ctrl+O), Close Vault (Ctrl+Shift+W), Settings (Ctrl+,), Save (Ctrl+S), Insert Link (Ctrl+K) and Search (Ctrl+Shift+F). Insert Link would act on the rich editor hidden under the Raw view, and Ctrl+S would save twice. Step 7.4 keeps today's behaviour.

### 7.1 First, route the specs through the harness (no behaviour change)

Two characterisation specs reach into the `<textarea>` themselves, which the characterisation gate allows only where a plan lists it.

**Expected spec changes (no assertion changes):**
- `rawViewSaveBase.test.ts`: its local `setRawText(ta, …)`, `ta.focus()` and `ta.blur()` become harness calls.
- `tagRowAndRawView.test.ts`:
  - `ta.value = …` plus an `input` event becomes `setRawText(app, …)`;
  - `(await rawTextArea(app)).value` becomes `rawText(app)`;
  - the wait on `.matches('textarea') && ….value.includes(…)` becomes a wait on `rawText(app).includes(…)`.

**`harness/actions.ts`:** replace `rawTextArea` (it hands out the element) with:
- `rawText(app)`: waits until loaded, returns the text;
- `setRawText(app, text)`: focuses, replaces the text, doesn't leave the field;
- `leaveRawField(app)`.

Keep `editRawText`, `typeInRawView`, `leaveRawFieldAndToggle`, `rawViewShown`, `rawConflictShown` and `chooseRawConflict`.

**Pass:** the characterisation project green on the textarea before anything else changes, then committed on its own.

### 7.2 Dependencies

`@codemirror/view` `^6.43.13`, `@codemirror/state` `^6.7.6`, `@codemirror/commands` `^6.11.1`, `@codemirror/language` `^6.12.4`, `@codemirror/lang-markdown` `^6.5.2`, `@codemirror/search` `^6.7.2` and `@lezer/highlight` `^1.2.5`.

Not the `codemirror` package: its `basicSetup` brings autocompletion, linting and more that the Raw view doesn't want.

### 7.3 `src/renderer/lib/editor/rawTextEditor.ts` (new) and the component

**The module** (in `lib/`, so it is testable on its own and the component stays UI only). It exports `createRawTextEditor(host, options)`.

Options:
- `text`, `label`;
- `onChange(text)`;
- `onBlur()`;
- `onSave()`.

The returned editor has:
- `text()`;
- `setText(value)`: replaces the whole text as one step that undo skips, so Ctrl+Z after a follow-reload doesn't bring the old text back. Skipped while an IME composition is open. Keeps the selection, clamped.
- `setEditable(on)`;
- `revealLine(n)`: selects the line, scrolls it to about a third of the way down, focuses;
- `focus()`;
- `destroy()`.

Extensions:
- line numbers (decision 6);
- history;
- special characters shown, so a BOM, a zero-width space or a control character is visible (decision 6);
- Markdown syntax colouring through `classHighlighter`'s `tok-*` classes;
- line wrapping;
- tab size 4;
- keys: Mod-S calls `onSave`; Mod-F opens CodeMirror's find bar (decision 5); the default and history keymaps. **Not** `indentWithTab`, so Tab leaves the field, as today (decision 4).

Text attributes:
- `aria-label`;
- `spellcheck="false"` (as now; so Electron issue #53608, the spell checker not marking CodeMirror text, doesn't apply);
- `data-plain-text-field` (7.4).

The blur save hangs on the DOM `blur` event, not CodeMirror's later focus update, so the save starts when the textarea's did.

**`NoteRawView.svelte`:**
- The `<textarea>` becomes a host `div.raw-text`.
- `onMount` loads `rawTextEditor` with a dynamic `import()`, so CodeMirror is fetched only when the Raw view first opens.
- The three places that set `text` from disk (`load`, and the two refreshes after a save in `writeTyped`) go through one helper that also calls `editor.setText(…)`. There is no `$effect` copying `text` into the editor: that is the kind of loop the strict runner fails on.
- `readonly` / `disabled` become one `$effect` calling `setEditable(!(readOnly || closeDrainGate.draining || loading))`.
- `revealLine` and the registry's `focus` use the editor. `onblur` / `onkeydown` move into its callbacks.
- **Styles:**
  - vanilla CSS in the component's `<style>` (`:global(.cm-…)` under `.note-raw-view`), keeping today's box: at least 480 px high, resizable vertically, scrolling inside, the mono font at 13 px, line height 1.55, the border and the focus outline (decision 3);
  - the `tok-*` colours come from existing theme tokens, so every theme stays readable, and every `var(--x)` must be defined (gate);
  - no `EditorView.theme` objects, which would be CSS-in-JS.

### 7.4 Keyboard: the Raw view stays a plain text field

- `src/renderer/core/hotkeys.ts`, `handleKeyDown`: an element inside `[data-plain-text-field]` counts as a form field, like `INPUT` and `TEXTAREA`, so only Escape passes. Add a case to `src/tests/unit/hotkeys.test.ts`.
- `src/renderer/lib/vault/unsavedStateReport.ts` already treats any focused editable element outside a note editor as a field the shutdown check watches, as it does the textarea today. Add a case to its test that a CodeMirror field with typed text counts.

### 7.5 Build

`electron.vite.config.mts`:
- add the CodeMirror packages to `optimizeDeps.include`, so `npm run dev` doesn't re-optimise and reload when the Raw view first opens;
- add a `codemirror` chunk (`@codemirror`, `@lezer`) to `manualChunks`.

**Check:** after `npm run build`, CodeMirror is its own file in `dist/renderer/assets/`, the main bundle is no bigger than the Phase 0 baseline, and the chunk loads only when the Raw view opens.

### 7.6 Tests

- **`src/tests/setup.ts`:** jsdom lays nothing out, so give `Range.prototype` an empty `getClientRects` and `getBoundingClientRect`, each only where missing.
- **Unit (`rawTextEditor.test.ts`, jsdom):**
  - get and set text;
  - `setText` leaves no undo step;
  - `revealLine` selects the line;
  - `setEditable` toggles editing;
  - Mod-S calls `onSave`;
  - blur calls `onBlur`.
- **Component:** `noteRawViewFollow.test.ts` and `lossyBannerNamesLine.test.ts` read the text and the selection through a small helper (`EditorView.findFromDOM` on the view's `.cm-editor`), and type through the view.
- **Characterisation:** the harness helpers of 7.1 now drive CodeMirror. No spec changes in this step.
- **Browser (`src/tests/browser/rawViewInChromium.test.ts`):**
  - typing;
  - Ctrl+Z;
  - Ctrl+S saves;
  - Tab leaves the field;
  - "Edit in Raw view" scrolls the line into view;
  - the colouring classes are present;
  - Ctrl+K and Ctrl+Shift+F do nothing there.
- **E2E (`src/tests/e2e/rawView.e2e.ts`, new):**
  - open a note that opens read-only, press Edit in Raw view: the line is selected and visible;
  - type, leave the field: the bytes on disk;
  - add the Raw view to the `a11y.e2e.ts` axe scan.

### 7.7 Docs

- CLAUDE.md:
  - Tech Stack ("Raw view: CodeMirror 6");
  - the project structure lines for `rawTextEditor.ts` and `NoteRawView.svelte`;
  - Testing Strategy (the Range polyfill, the browser spec).
- KNOWN_LIMITATIONS #30 needs no change (the raw view still saves the whole file); check its wording.

**Pass test**
- `ci:verify` on Windows and in GitHub CI.
- The E2E suite.
- **By hand, in the built app:**
  - the Raw view on a 5,000-line note: typing stays smooth;
  - each of the five themes: the text and its colours are readable;
  - Edit in Raw view lands on the named line;
  - a conflict still shows its banner, and Keep mine still backs the other version up first;
  - closing the tab with unsaved raw text still saves it, or keeps a rescue copy.

---

## Phase 8: verification, docs, archive (Useful 2/10, Hard 1/10, Risk 0/10)

- A full `npm run ci:verify` on Windows, and the E2E suite with `FILO_E2E_SCALE=1`.
- `npm audit`: 0.
- `npm outdated`: only what the investigation said to wait for or skip is left:
  - Electron 45, once it is out on 2026-10-20;
  - TypeScript 7;
  - Vite 8 and vite-plugin-svelte 7;
  - markdown-it 15;
  - js-yaml 5 and nanoid 6 (skipped).
  
  yaml 3 and electron-builder 27 are pre-releases, which `npm outdated` doesn't show.
- **CLAUDE.md:**
  - Quick Reference: the `corpus:*` and `knip` scripts, and the one-time `npx playwright install chromium`;
  - Testing Strategy: the browser project and the second parser;
  - the gate count.
- **TRACK_B_INVESTIGATION §6:** mark what was done. **BACKLOG:** add any new findings.
- **Optional, if a larger corpus is needed (owner, 2026-10-03):** once every change is in, generate a vault with `node scripts/perf/genVault.mjs <dir>` (deterministic) and add it to the corpus with `corpus:list -- … --extra <dir>`. Its notes are generated, so they add volume rather than variety.
- Move this plan to `docs/archive/` with its outcomes.

---

## Decisions

| # | Question | Default |
|---|---|---|
| 1 | Browser-mode tests run in `ci:verify`, and GitHub CI installs Chromium for them | Yes |
| 2 | knip stays a report you run by hand (not in `ci:verify`) | Yes; revisit after Phase 4's triage |
| 3 | The Raw view keeps today's box: at least 480 px, resizable, scrolling inside | Yes |
| 4 | Tab in the Raw view leaves the field, as today | Yes |
| 5 | Ctrl+F in the Raw view opens CodeMirror's find bar for that note | Yes |
| 6 | Line numbers, and invisible characters shown, in the Raw view | Yes |
| 7 | The corpus list walks the repo, the vaults folder and `node_modules` READMEs, not other sessions' temporary folders | Yes |

**Needs your go-ahead when the time comes:** Phase 6's one-time download of Playwright's Chromium on this machine (roughly 150–200 MB).

## Risks, and how each is contained

| Risk | Where | Contained by |
|---|---|---|
| A TipTap patch re-spells notes on save | Phase 3 | Its own branch; the golden corpus, property and toolbar suites; the full corpus check (0 changed bytes); the editor E2E specs |
| jsdom 30 changes which branch a security check takes under test | Phase 2 | Both branches of `untrusted.ts` and `color.ts` tested explicitly; every changed result listed with its reason |
| The Raw view loses typed text in the swap | Phase 7 | The save, conflict, registry and rescue logic is unchanged; the five characterisation specs and the component tests run before and after; the harness step (7.1) lands first and green |
| A global shortcut acts from inside the Raw view | Phase 7 | `data-plain-text-field` treated as a form field (7.4), with unit and browser tests |
| zod stops being bundled into the main process | Phase 1 | The `require("zod")` check on the built files |
| CodeMirror slows the app's start | Phase 7 | Loaded only when the Raw view opens, in its own chunk; bundle sizes compared with Phase 0 |
| The browser project makes CI slow or flaky | Phase 6 | Headless Chromium, three small specs; the run time recorded; decision 1 can move it to a local-only script |

---

## Outcomes

*(Each phase adds its outcome here when it is done.)*

### Phase 0 outcome (2026-10-03)

**Status:** done, verified on Windows.
- Baseline taken on `78e3980`: the plan and its docs committed on top of `29b96ee`, no code change.
- The corpus pass test is met: two runs identical, and the verdicts match the Audit-26 run on every shared note.
- `npm run ci:verify` green with the Phase 0 files: see the last line of "What changed".

#### 0.1 Baseline (what later phases compare against)

| Check | Result on `78e3980` |
|---|---|
| `npm run ci:verify` | Green in 251 s (4 min 11 s). 795 test files: 7,525 tests passed, 5 skipped (7,530). `test:unit:strict` took 206.8 s. 89/89 gates in 8.2 s. |
| E2E, `FILO_E2E_SCALE=1` | 28 passed in 2.7 min, the three scale budgets included (none skipped). |
| `npm audit` | **9 findings, not the 1 expected:** DOMPurify (low, as planned), plus 8 high from one new advisory in electron-builder's download chain. See "New findings". |
| `dist/main/main.js` | 420,366 bytes. No `require("zod")`; zod is bundled (`ZodError` appears 5 times). It requires only `electron` and Node built-ins (`buffer`, `crypto`, `dns`, `fs`, `os`, `path`, `stream`, `url`, `util`). |
| `dist/preload/preload.js` | 193,825 bytes. No `require("zod")`; zod bundled (`ZodError` 5 times). It requires only `electron`. |
| Corpus check | 684 notes, 347 read-only, 187 saved byte for byte, 0 errors, 27.6 s a run. Details in 0.2. |

**`npm outdated`:**
- **Patch / minor:** TipTap 3.31.3 → 3.31.4 (all 25 `@tiptap/*` packages); vitest and `@vitest/coverage-v8` 5.0.1 → 5.0.3; dompurify 3.4.15 → 3.4.16; electron 44.4.5 → 44.5.1; globals 17.12.0 → 17.13.0; sharp 0.35.4 → 0.35.5; typescript-eslint 8.70.1 → 8.71.0; **eslint 10.11.0 → 10.12.0** (new since the plan).
- **Majors (the "wait" and "skip" lists):** `@sveltejs/vite-plugin-svelte` 7.3.1, jsdom 30.1.1 (Phase 2), js-yaml 5.4.2, markdown-it 15.0.2, nanoid 6.0.1, typescript 7.0.2, vite 8.3.2.

**`dist/renderer/assets/` after `npm run build`** (25 files, 5,665,769 bytes; hash suffixes left out):

| File | Bytes |
|---|---|
| `index.js` | 2,553,342 |
| `tiptap.js` | 1,185,250 |
| `lowlight.js` | 384,955 |
| `TaskListBoard.js` | 308,701 |
| `MindMapBoard.js` | 264,204 |
| `index.css` | 204,665 |
| `KanbanBoard.js` | 188,640 |
| `LinkTile.js` | 187,515 |
| `convertToUtf8.js` | 63,389 |
| `TaskListBoard.css` | 59,913 |
| `KanbanBoard.css` | 50,729 |
| `MindMapBoard.css` | 43,152 |
| `DocumentEditor.js` | 38,737 |
| `ariaAnnouncer.svelte.js` | 29,895 |
| `LinkTile.css` | 28,418 |
| `TagsBrowser.js` | 19,173 |
| `markdownTileSeed.js` | 12,810 |
| `DocumentEditor.css` | 10,634 |
| `replaceAllCommand.js` | 9,813 |
| `TagsPopupMenu.js` | 8,198 |
| `TagsBrowser.css` | 5,323 |
| `BoardBackground.js` | 3,125 |
| `ariaAnnouncer.css` | 2,962 |
| `TagsPopupMenu.css` | 2,105 |
| `BoardBackground.css` | 121 |

#### 0.2 The corpus check in the repo

**The list** (`corpus:list -- <list.txt> --vaults "C:\Users\andre\My Files\Vaults"`): 684 notes. Building it twice gives the same file.

| Source | Notes | Read-only | Saved byte for byte |
|---|---|---|---|
| The repo | 103 | 58 | 40 |
| The vaults folder | 32 | 0 | 30 |
| `node_modules` READMEs | 549 | 289 | 117 |
| **All** | **684** | **347** | **187** |

**Pass test:**
- **Two runs on `HEAD` are identical:**
  - `corpus:compare` reports 684 compared, 0 changed, 0 newly read-only, 0 newly failed, and exits 0;
  - a stricter check found every field of all 684 entries identical across the runs.
- **Against the Audit-26 run** (its `corpus-new.json`, made on Audit-26 Phase 3's code), on the 676 paths both runs hold:
  - the same 340 notes are read-only;
  - 0 unlocked, 0 newly read-only;
  - all 336 editable notes give the same output bytes.

  So the editor changes made since (Audit-26 Phases 4–7, Audit-27) changed nothing on this corpus.
- **The 8 notes Audit-26 didn't have:** seven docs written since (all read-only) and one vault note (editable).
- **Why 347, not the Audit-26 run's 372:** that run's read-only notes were 53 repo docs, 289 READMEs and 30 temp-folder files. The temp folders are no longer walked (decision 7), and the repo has gained docs since.

**`compare` proven to bite**, on doctored copies of a real result:

| Doctored copy | Exit | Reported as |
|---|---|---|
| One output hash changed | 1 | Changed |
| One editable note made read-only | 1 | Newly read-only |
| One note made to fail | 1 | Newly failed |
| One read-only note unlocked | 0 | Unlocked (counted, not a failure) |
| One note's input changed | 0 | Listed under "Not compared" |

#### What changed

- **New files:**
  - `scripts/corpus/buildList.mjs`;
  - `scripts/corpus/compare.mjs`;
  - `src/tests/corpus/corpusRun.ts`;
  - `vitest.corpus.config.mts`.
- **npm scripts:** `corpus:list`, `corpus:run`, `corpus:compare`.
- **`tsconfig.tests.json`:** includes `src/tests/corpus/**`, so the `test-typecheck` gate checks the runner (it holds no errors and needs no baseline entry).
- **CLAUDE.md:**
  - Quick Reference: the three commands;
  - Testing Strategy: when to run the check, and the worktree recipe;
  - project structure: `src/tests/corpus/`, and `scripts/` with `gates/`, `corpus/` and `perf/`.
- **Docs:**
  - BACKLOG: BL-11 (below);
  - this plan: this outcome, a note under 0.2's pass test, notes in Phase 1 (eslint 10.12.0, the audit pass test), and an optional generated-corpus step in Phase 8.
- **`npm run ci:verify` with all of the above:** green in 242 s.
  - 795 test files: 7,525 passed, 5 skipped;
  - 89/89 gates, `test-typecheck` included, which now lists `src/tests/corpus/corpusRun.ts` among its files;
  - the rebuilt `dist/` has the baseline's sizes to the byte (no app code changed).

#### Deviations from the plan

1. **The corpus is 684 real notes, not about 18,870 (owner, at the start).**
   - 18,192 of the Audit-26 run's notes came from other sessions' temporary folders, almost all of them four generated speed-test vaults of filler text (`BigVault`, `finderB/perf`, `S6VaultB`, `PerfVault`).
   - Decision 7 drops those folders, so the pass test's "close to 18,870" couldn't hold. It became a comparison of verdicts with the Audit-26 run on the paths both hold.
   - The owner kept the real notes only, and added that a generated set can be made at the end if needed (Phase 8 now says how). A run takes 28 s instead of about 29 min.
2. **`--extra <dir>` (repeatable) in `buildList.mjs`**, for any other folder, such as one `scripts/perf/genVault.mjs` makes. A folder that doesn't exist is refused, rather than silently walking nothing.
3. **The results record more than the plan listed:**
   - a hash of each note's body as read (`bodyHash`), so `compare` counts a note edited between two runs apart ("Not compared") instead of as an output change;
   - whether the output is the file's own body (`same`), so `compare` needs no frontmatter parsing of its own and doesn't re-read files later;
   - a `meta` header (the list, the count, the time);
   - notes over 400,000 characters as `skipped` (the old runner dropped them silently; none in this corpus).
4. **`compare` exits 1 on a difference, and counts a note that newly fails to load as one.** It also reads the old runner's plain path-map results (`data.notes ?? data`), which is how the Audit-26 comparison was made.
5. **`vitest.corpus.config.mts` sets `disableConsoleIntercept`.** Otherwise vitest holds back the runner's progress lines ("corpus: N of M notes") for a passing test, and a long `--extra` run would print nothing until it ends.
6. **The worktree recipe in CLAUDE.md** replaces the plan's bare `git worktree add ../filo-base <sha>`, which has no `node_modules`. It is the one earlier corpus runs used: a `node_modules` junction to this checkout, unlinked with `cmd /c rmdir` before `git worktree remove`, and the runner copied in when the base commit predates it.
7. **The baseline `ci:verify` ran with the new corpus files moved out of the tree,** so the gates checked `HEAD` exactly. They were moved back once that run finished.

#### New findings

- **`npm audit`: 8 high findings, one advisory (GHSA-ch52-4w7c-c8xp), new since the plan** → BACKLOG BL-11.
  - The chain: `http-cache-semantics` ≤ 4.2.0 (every version) through `got` 11, `@electron/get` 3.1.0, app-builder-lib, electron-builder 26.15.3.
  - Build time only: it runs when packaging, to download Electron. Nothing of it ships in Filo.
  - electron-builder `27.0.0-alpha.9` already moves to `@electron/get` 5, without `got`. 27 is on the "wait" list.
  - **Phase 1's "`npm audit`: 0" can't be met;** Phase 1 now carries a note.
- **eslint 10.12.0** is out; Phase 1 now carries a note.
- **What keeps today's corpus notes read-only** is what Audit-26 found: HTML blocks and comments, reference definitions, and inline code inside bold or a link (KNOWN_LIMITATIONS #17). All 32 vault notes open editable.

### Phase 1 outcome (2026-10-03)

**Status:** done, verified on Windows. Committed on `main`; not pushed (owner, at the start).

#### Decisions at the start (owner, 2026-10-03)

1. **eslint 10.12.0 taken**, with the floor at `^10.12.0` (the plan's table said `^10.11.0`).
2. **BL-11's `overrides` idea not tried.** It waits for electron-builder 27, so the audit pass test reads as the note under 1.2 says.
3. **Not pushed.** `main` stays ahead of `origin` until the owner pushes.

#### What changed

**`package.json`** (installed versions in brackets):

| Package | From | To |
|---|---|---|
| dompurify | ^3.4.15 | ^3.4.16 (3.4.16) |
| yaml | ^2.9.0 | ^2.9.1 (2.9.1, unchanged) |
| electron | ^44.4.5 | ^44.5.1 (44.5.1) |
| vitest, @vitest/coverage-v8 | ^5.0.1 | ^5.0.3 (5.0.3) |
| typescript-eslint | ^8.60.1 | ^8.71.0 (8.71.0) |
| globals | ^17.6.0 | ^17.13.0 (17.13.0) |
| sharp | ^0.35.4 | ^0.35.5 (0.35.5) |
| eslint | ^10.4.0 | ^10.12.0 (10.12.0) |
| @playwright/test | ^1.60.0 | ^1.63.0 (1.63.0, unchanged) |
| svelte-check | ^4.6.0 | ^4.7.6 (4.7.6, unchanged) |

**`npm install`:** 29 packages changed, 2 removed.
- Changed alongside the above: the `@typescript-eslint/*` packages (8.71.0), `@vitest/mocker` and `@vitest/spy` (5.0.3), sharp's `@img/*` builds (0.35.5, libvips 1.3.4), chai 6.3.0, std-env 4.3.0, tinybench 6.2.0, tinyexec 1.3.1, `why-is-node-running` 3.2.1.
- Removed: `siginfo` and `stackback`, which `why-is-node-running` 3 no longer needs.
- Electron's postinstall left no binary, as the plan expected. `node node_modules/electron/install.js` fetched 44.5.1.

**`electron.vite.config.mts`:**
- `main` and `preload` use `build.externalizeDeps: { exclude: ['zod'] }`; the deprecated plug-in and its import are gone.
- The comment explaining why zod is bundled stays on `main`; `preload` gets a one-line pointer to it, since the plug-in line it shared is gone.
- The CSP-strip plug-in's comment lost its "Sprint B / B23" prefix (deviation 2).

**Gate `no-audit-narration`** (group `codebase`) now also catches a fix-sprint id (`Sprint B`, `Sprint 35`). CLAUDE.md's `codebase` row says so. The gate count stays 89.

#### Pass test

| Check | Result | Phase 0 baseline |
|---|---|---|
| `npm run ci:verify` (Windows) | **Green in 242 s**, and again in 238 s on the final tree (after the gate change). 795 files: 7,525 passed, 5 skipped. `test:unit:strict` 199–202 s. 89/89 gates in 8.2 s. eslint 10.12.0 and typescript-eslint 8.71.0: 0 warnings. svelte-check: 860 files, 0 errors, 0 warnings. | 251 s; the same counts |
| zod still bundled | `dist/main/main.js` 420,366 bytes and `dist/preload/preload.js` 193,825 bytes, the baseline sizes to the byte. No `require("zod")` in either. main requires only `electron` and the same Node built-ins; preload only `electron`. | The same |
| Renderer assets | 24 of 25 files the same size to the byte. `LinkTile.js` 187,515 → 182,984 bytes (−4,531): the shared chunk DOMPurify sits in (it now carries 3.4.16). Total 5,661,238 bytes. | 5,665,769 bytes |
| E2E, `FILO_E2E_SCALE=1` | **28 passed in 2.7 min**, on Electron 44.5.1, the three scale budgets included (none skipped). | 28 passed in 2.7 min |
| `npm audit` | **8 high, all GHSA-ch52-4w7c-c8xp** in electron-builder's download chain (BL-11). The DOMPurify finding is gone. | 9 (DOMPurify + those 8) |
| `npm outdated` | Left: the 25 `@tiptap/*` packages (Phase 3), jsdom 30 (Phase 2), and the majors on the "wait" and "skip" lists (vite-plugin-svelte 7, js-yaml 5, markdown-it 15, nanoid 6, typescript 7, vite 8). | |

#### Deviations from the plan

1. **eslint 10.12.0** rather than the table's 10.11.0 floor (owner, decision 1). It added no lint warnings.
2. **An audit id removed from the build config, and the gate extended to catch it.**
   - `electron.vite.config.mts` held "Sprint B / B23" in a comment. CLAUDE.md bans audit ids in build config, but `no-audit-narration` had no pattern for a sprint id, so it had passed.
   - It was the last one in the files that gate reads (`src/main`, `src/renderer`, `src/shared` and the three configs). Test files still hold many; the gate doesn't read tests, as before.
   - Proven to bite: with the old comment put back, the gate fails at `electron.vite.config.mts:65`; restored, it passes.
3. **`npm audit` is not 0**, as the Phase 0 note under 1.2 foresaw (owner, decision 2).

#### New findings

None. BL-11 stays open as written.

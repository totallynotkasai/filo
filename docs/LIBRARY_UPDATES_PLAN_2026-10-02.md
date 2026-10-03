# Library updates and new tools: implementation plan

**Status (2026-10-03): Phases 0–5 done; Phases 6–8 not started.** Each phase gets an "Outcome" section here when it is done (what changed, deviations, new findings), as in earlier plans.

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

  *Changed in Phase 4 (2026-10-03):* this config reported a false unused file, and knip 6.39 finds the five app entries itself. The `knip.ts` written is in the Phase 4 outcome (deviations 1 and 2).
- npm script `knip`, report only. It is **not** in `ci:verify` (decision 2).
  - *Changed in Phase 4 (owner, 2026-10-03):* knip runs in `ci:verify`, after lint.

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
- *Changed in Phase 5 (owner, 2026-10-03):* the test also compares ticked boxes and link and image addresses, and checks that saving a fixture that opens editable changes nothing micromark shows. The cases moved as `TOOLBAR_CASES`, with `applyToolbarCase`, `normalisedDoc` and `selectFirstBlock` beside them. None of the inputs differs; two differences found elsewhere are pinned as "known differences" (Phase 5 outcome).
- **What it pins:** the words of every note Filo writes read the same in a strict CommonMark + GFM parser, which is how "content stays the same in other apps" is checked. js-yaml plays the same oracle role for YAML today.

### 5.3 Gate `one-markdown-parser` (group `markdownFormat`, next to `no-jsyaml`)

- **Fails if** app code (`src/renderer`, `src/main`, `src/shared`) imports `marked`, `micromark*`, `remark*`, `unified`, `mdast-*`, `commonmark` or `@tiptap/markdown`, or if any of them is a runtime dependency. Tests may import them.
- **Hint:** "markdown-it is the one Markdown parser in the app; a second one reads notes differently (the YAML lesson). Tests may use others as oracles."
- Prove it bites, as the conventions say.
- Optional, in the same commit: extend the existing `markdown-body-roundtrip` pinning so the new test must exist, un-skipped, with at least as many inputs as the golden corpus has fixtures.
  - *Done in Phase 5 (owner):* the gate pins the test's parts; the test itself checks it read every fixture and every toolbar case. `toolbar-formatting-saved` now reads the cases from `src/tests/helpers/toolbarCases.ts`.

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
   - *From Phase 5:* the file exports `TOOLBAR_CASES`, `applyToolbarCase(editor, case)` (load, select the first block, run, return the saved Markdown) and `normalisedDoc` (the document comparison the jsdom suite uses). The cases call `expect` from `vitest`.
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
    - *From Phase 4:* the `corpus:*` lines (Phase 0) and the `knip` line are already in;
  - Testing Strategy: the browser project and the second parser;
    - *From Phase 5:* the second-parser line and the gate count (90) are already in.
  - the gate count.
- **TRACK_B_INVESTIGATION §6:** mark what was done. **BACKLOG:** add any new findings.
  - *From Phase 4:* also correct §6's knip row, which says knip needs Svelte's compiler or it reports components' exports as unused (see the Phase 4 outcome's new findings).
- **Optional, if a larger corpus is needed (owner, 2026-10-03):** once every change is in, generate a vault with `node scripts/perf/genVault.mjs <dir>` (deterministic) and add it to the corpus with `corpus:list -- … --extra <dir>`. Its notes are generated, so they add volume rather than variety.
- Move this plan to `docs/archive/` with its outcomes.

---

## Decisions

| # | Question | Default |
|---|---|---|
| 1 | Browser-mode tests run in `ci:verify`, and GitHub CI installs Chromium for them | Yes |
| 2 | knip stays a report you run by hand (not in `ci:verify`) | Yes; revisit after Phase 4's triage. *Revisited in Phase 4 (owner): no, knip runs in `ci:verify`.* |
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

### Phase 2 outcome (2026-10-03)

**Status:** done, verified on Windows. Committed on `main`; not pushed (owner, at the start).
- **No test changed result.** On jsdom 30, before any other change, `test:unit:strict` gave the baseline's counts exactly: 795 files, 7,525 passed, 5 skipped.
- **One app change** (deviation 1): the theme-value check now refuses control characters itself.

#### Decisions at the start (owner, 2026-10-03)

1. **Refuse control characters in `asSafeThemeValue`, and correct its comment** (the recommended option; the other was to correct the comment only).
   - A probe before the update found that jsdom 30's `CSS.supports` and Electron's Chromium disagree on five theme values (see "New findings").
   - `untrusted.ts` said `CSS.supports` "rejects values containing control chars, unterminated tokens". Chromium accepts both in a custom property's value.
   - With the check in Filo's own code, Chromium, jsdom and the main process all give the same answer for these values.
2. **Commit, don't push**, as in Phase 1.

#### What changed

**`package.json`:** jsdom `^29.1.1` → `^30.1.1` (30.1.1 installed).

**`npm install`:** 4 packages added, 3 removed, 10 changed. All of them are jsdom and its own dependencies, so dev only:

| Package | From | To |
|---|---|---|
| jsdom | 29.1.1 | 30.1.1 |
| @asamuzakjp/css-color | 5.1.11 | 7.1.3 |
| @asamuzakjp/dom-selector | 7.1.1 | 9.2.4 |
| @csstools/color-helpers, css-calc, css-color-parser, css-parser-algorithms, css-tokenizer | 6.1.1, 3.4.0, 4.2.3, 4.0.0, 4.0.1 | 6.1.2, 3.4.3, 4.2.6, 4.0.2, 4.0.2 |
| html-encoding-sniffer | 6.0.0 | 7.0.0 |
| w3c-xmlserializer | 5.0.0 | 6.0.0 |
| Added under jsdom's dependencies | | `undici` 8.11.2 and `whatwg-url` 17.1.2 (jsdom's copies), and an `lru-cache` 11.5.3 copy each for css-color and dom-selector |
| Removed | `@asamuzakjp/generational-cache`, `@asamuzakjp/nwsapi`, `symbol-tree` | |

The new Node range (`^22.22.2 || ^24.15.0 || >=26`) is met: Node 24.16 locally, and CI's `node-version: '22'` takes the newest 22.x (22.23 when the plan was written).

**`src/shared/untrusted.ts`:**
- `asSafeThemeValue` refuses a value holding a control character (`\p{Cc}`: C0, newline and tab included, DEL, C1) after the blocklist and before `CSS.supports`. `trim()` still strips a newline or tab at either end first, so only one inside the value is refused.
- The comments say where `CSS.supports` exists now (the renderer and jsdom, not the main process), and what failing it means in Chromium: an unmatched `)` or `{`, not control characters or an unterminated string.

**Tests:**
- **`sharedUntrusted.test.ts`:** the `asSafeThemeValue` block runs twice, with jsdom's `CSS.supports` and with it removed (`vi.stubGlobal('CSS', undefined)`). Each run first checks that `CSS.supports` is present or absent as its mode says, so neither run can quietly take the other's branch. New cases:
  - sizes, shadows, a font list and `calc()` are accepted;
  - a value is trimmed, a newline or tab at either end included;
  - ten control characters inside a value are refused;
  - `a)`, `{x` and `!` are refused only where `CSS.supports` is there, and pass the fallback.
  
  The `;` case's comment no longer names jsdom as an environment without `CSS.supports`.
- **`isCssColour.test.ts` (new):** `isCssColour` had no direct test (deviation 2). It now runs both ways too:
  - 22 colours accepted and 9 non-colours refused in both;
  - `var(--accent-primary)` is a colour only to the browser's parser;
  - `notacolour` and `hsl(nonsense)` pass only the fallback.
- 33 tests added in all (7,525 → 7,558).

**Checked against Chromium.** Every answer the two files pin with `CSS.supports` present was asked of Electron 44.5.1's Chromium (152.0.7977.130), in a hidden window run by a scratch script outside the repo (deviation 3): 48 questions, 48 the same as jsdom 30's.

#### What the plan said to watch

| Watch item | Result |
|---|---|
| `CSS.supports` in `untrusted.ts` | Every existing case gives the same result both ways: the values it refuses are caught by the blocklist before `CSS.supports` is asked. Both branches are now pinned. |
| `CSS.supports` in `color.ts` | jsdom 30 agrees with Chromium on all 30 colour values probed. The branches differ on purpose for three values (`var()`, an unknown word, a bad colour function), now pinned. |
| Focus and blur tests | All pass unchanged, 46 tests in 9 files: component `titleCommitsOnClickAway` (8), `noteRawViewFollow`, `lossyBannerNamesLine`; unit `titleEditFocus` (9), `noteRawView`; characterisation `tagRowAndRawView` (8), `rawViewSaveBase`, `rawViewUnsaved`, `rawViewRescueAndIndicator`. No test worked around a jsdom 29 focus bug (none of their comments names one), so none relied on the spurious events jsdom 30 drops. |
| `getComputedStyle` pixel lengths | No test reads a computed length. The app's reads are custom properties (`themeManager.ts`, `BoardBackground`, the two floating panels), which aren't lengths, plus `NoteRawView`'s line height, which falls back to 20 px when it isn't a number; no test checks the scroll position it sets. |
| Noise in the strict run | Nothing new. The one jsdom message in the log, "Not implemented: HTMLCanvasElement's getContext() method", comes from the colour picker's wheel and reads the same in jsdom 29 (checked in a scratch install). |

#### Pass test

| Check | Result | Before |
|---|---|---|
| `npm run test:unit:strict`, jsdom 30 alone | **Green in 218 s.** 795 files: 7,525 passed, 5 skipped. | Phase 1: 199–202 s; the same counts |
| `npm run ci:verify` (Windows), final tree | **Green in 279 s.** 796 files: 7,558 passed, 5 skipped. `test:unit:strict` 215 s. eslint 0 warnings; svelte-check 860 files, 0 errors, 0 warnings; 89/89 gates in 13.9 s (`test-typecheck` checks the new test file). | Phase 1: 238–242 s; gates 8.2 s |
| E2E, `FILO_E2E_SCALE=1` | **28 passed in 2.7 min**, the three scale budgets included (deviation 4). | 28 passed in 2.7 min |
| Built app | `main.js` 420,366 bytes and `preload.js` 193,825 bytes, the same to the byte; no `require("zod")`. `asSafeThemeValue` isn't bundled into main, so the new check isn't there. Renderer `index.js` 2,553,342 → 2,553,472 bytes (+130, the new check); the other 24 assets are unchanged. | Phase 1 sizes |
| `npm audit` | 8 high, all GHSA-ch52-4w7c-c8xp (BL-11). | The same |
| `npm outdated` | jsdom is gone from the list. Left: the 25 `@tiptap/*` packages (Phase 3) and the "wait" / "skip" majors. | |

The slower `ci:verify` is most likely load on the machine, not jsdom: the gates use no jsdom and took 70% longer too.

#### Deviations from the plan

1. **App code changed in a "tests only" phase** (owner, decision 1). `asSafeThemeValue` refuses control characters, a one-line check with its comments. A theme file holding one inside a value now has that variable dropped (with the usual devtools breadcrumb), as a `url(` would be. No real colour or size holds one.
2. **A new test file for `isCssColour`.** The plan said both checks' tests "were written for the fallback". That held for `asSafeThemeValue`; `isCssColour` had none of its own, only the theme editor's component test reaching it.
3. **The Chromium comparison used the Electron already installed** (44.5.1), in a hidden window, with a scratch script that isn't in the repo. Nothing was downloaded. The results are recorded above.
4. **The E2E suite was run.** The plan doesn't ask for it in this phase, but the theme sanitiser is app code.
5. **The new control-character test was not proven to bite by mutation.** This session's permission mode refused a run of the suite with the sanitiser's check switched off, so the proof was left to the owner. The reasoning stands without it: Chromium's `CSS.supports` accepts these values, and the run without `CSS.supports` has no other check that would refuse them.

#### New findings

- **jsdom 30's `CSS.supports` and Chromium 152 disagree on five theme values** (`CSS.supports('--probe: …')`):

  | Value | jsdom 30 | Chromium |
  |---|---|---|
  | `[x` | accepts | refuses |
  | `a!important`, `red !important` | refuses | accepts |
  | a control character (`\u0001`), a newline inside the value | refuses | accepts |

  - The control characters are now refused by Filo first (decision 1), so all three environments agree on them.
  - The other three were left unpinned at first, since jsdom's answer isn't the app's. Logged as BL-13, then fixed: see the follow-up below.
  - None is an injection risk: `setProperty` takes one value, and `url(`, `;` and the rest are refused before `CSS.supports` is asked.
- **The fallback branches now run only in tests.** The renderer and jsdom both have `CSS.supports`, and nothing in the main process calls `asSafeThemeValue`. The tests keep both covered, as the plan asked.
- **The theme editor takes `currentColor`, `inherit`, `initial` and `unset` as colours**, because Chromium's parser counts them as `color` values. Checked in Electron: `currentColor` paints with the text colour (an App background set to it hides the text), and the keywords leave the token with no value. This is older than this phase and has nothing to do with jsdom. Logged as BL-12, then fixed: see the follow-up below.

#### Follow-up: BL-12 and BL-13 fixed (owner, 2026-10-03)

The two findings above went into the backlog first. The owner then asked for both to be fixed now, since neither is hard. Each was removed from `docs/BACKLOG.md` once fixed, as its rules say for an item a plan takes.

**Decision (owner):** a theme colour may not be `var(…)`, the recommended option. Nothing Filo writes holds one (built-in themes and Duplicate hold plain colours), the editor's swatch can't show it, and a wrong or circular reference leaves the token with no value, as `inherit` does.

**What changed**
- **`src/renderer/lib/themes/themeValues.ts` (new):** `isThemeTokenValue(name, value)`, asked after `asSafeThemeValue`. It refuses:
  - the CSS-wide keywords (`inherit`, `initial`, `unset`, `revert`, `revert-layer`) and `currentColor`, in any case;
  - a value borrowed from elsewhere: `var()`, `env()`, `attr()`, `if()` or `inherit()`, anywhere in the value (so `color-mix(… var(--x) …)` too);
  - on a colour token, anything `isCssColour` doesn't take. The five shadow tokens keep full `box-shadow` values.
- **Used on every way into a theme:**
  - the theme editor (`ThemeEditor.svelte`), in place of `isCssColour`;
  - a theme file read from `.filo/themes/` or imported (`cleanThemeVariables` in `themeFiles.ts`);
  - the paint (`applySafeThemeVar` in `themeManager.ts`). The `theme-css-var` sink gate still finds `asSafeThemeValue` beside each `setProperty`.
  
  A refused value is dropped the way an unsafe one is: the base theme's colour shows, with the devtools breadcrumb.
- **BL-13, `asSafeThemeValue` (`src/shared/untrusted.ts`):** the Phase 2 control-character check now also refuses `!` and the brackets other than `( )`: one check, `/[\p{Cc}!{}[\]]/u`. Those were the values where jsdom 30 and Chromium disagree, and no colour or shadow holds them, so every environment now gives the same answer. Only `a)`-style values are still refused by `CSS.supports` alone, and jsdom and Chromium agree on those.
- **CLAUDE.md:** the `themeValues.ts` line in the project structure, and the theme rule under "Override Cascade".

**Nothing built in is lost.** In Electron 44.5.1, every token of the five built-in themes was read the way `readBuiltinThemeVariables` reads them: 480 values (96 a theme), 0 refused by the new rules. That covers system-only paints and Duplicate, which store those values.

**Tests** (13 added, 7,558 → 7,571):
- `themeValues.test.ts` (new), with and without `CSS.supports`: plain colours held; every keyword and borrowed value refused on a colour token and a shadow token; a size or shadow refused on a colour token; shadows and `none` held on a shadow token.
- `themeFiles.test.ts`: a theme file's `currentColor`, `inherit`, `var()`, `color-mix(… var() …)` and `12px` colours are dropped, and so are its `unset` and `var()` shadows; a theme painted with such values leaves those tokens to the base theme.
- `themeEditorPreview.test.ts`: `currentColor`, `inherit` and `var(--accent-primary)` typed into a colour box are marked invalid and paint nothing.
- `sharedUntrusted.test.ts`: `red !important`, `a!important`, `!`, `[x`, `x]`, `{x` and `x}` refused in both modes. The branch-only case is now just `a)`.

**The new tests catch both problems.** Run against the code before the fix (a worktree of `a722877` with these test files copied in), exactly the 5 new cases those files hold fail and the other 98 pass: both themeFiles cases, the editor case, and the bracket case in each mode.

**Pass test**

| Check | Result |
|---|---|
| `npm run ci:verify` (Windows) | **Green in 241 s.** 797 files: 7,571 passed, 5 skipped. eslint 0 warnings; svelte-check 861 files, 0 errors, 0 warnings; 89/89 gates in 8.2 s. The gates being back at 8.2 s supports the guess that the slow 279 s run above was machine load. |
| E2E, `FILO_E2E_SCALE=1` | **28 passed in 2.6 min**, the scale budgets included. |
| Built app | `main.js` and `preload.js` unchanged to the byte (420,366 and 193,825); no `require("zod")`. Renderer `index.js` 2,553,472 → 2,553,929 bytes (+457); the other 24 assets unchanged. |

### Phase 3 outcome (2026-10-03)

**Status:** done, verified on Windows. Built on branch `chore/tiptap-3.31.4` and fast-forwarded into `main`; not pushed (owner, at the start).
- TipTap 3.31.4 changed what Filo saves in five places. The run stopped there, as decided at the start, and the owner chose for each (the second round of decisions below).
- One change made notes open read-only: tables Filo had saved as HTML. Filo now writes those tables exactly as before.
- The other four are behaviour fixes, kept and pinned by tests.
- The corpus check shows 0 changed bytes and 0 changed read-only verdicts.

#### Decisions at the start (owner, 2026-10-03)

1. **Merge, don't push**, as in Phases 1 and 2.
2. **The manual check in the built app is scripted** (Playwright on the built Electron app, a scratch vault, the saved bytes read from disk), with screenshots sent to the owner.
3. **If 3.31.4 changes any saved bytes or read-only verdicts, stop and report**: leave the branch unmerged, record what changed here, and ask.

#### Decisions after the report (owner, 2026-10-03)

4. **HTML tables: keep writing `colspan="1" rowspan="1"`** (the recommended option). The alternatives were to teach the read-only check that those attributes are defaults (such notes would lose them on their next save), or to accept that such notes open read-only.
5. **Links: accept TipTap's new behaviour** (a space typed or inserted at a link's end stays outside the link). Update the one test, and add typing cases.
6. **Undo after an auto-format, Enter at a ticked item, `role="textbox"`: accept, each pinned by a test.** The owner also chose to backlog the new empty item above a ticked one coming out ticked; the built-app check then showed that it doesn't happen in the app (deviation 5).
7. **Then finish and merge if everything is green**, without stopping again.

#### What 3.31.4 changes in Filo's editor

Found by reading the 3.31.3 → 3.31.4 diff of every `@tiptap/*` package's `dist/`, then probing each change in Filo's real editor on both versions. The 3.31.3 side ran in a worktree of `main` whose `node_modules` held the saved 3.31.3 packages (deviation 2).

1. **Tables Filo saved as HTML opened read-only. Fixed in Filo (decision 4).**
   - TableCell and TableHeader no longer write `colspan="1" rowspan="1"`.
   - Filo writes a table as HTML when a cell holds more than one paragraph, a list or a heading, when cells are merged, or when the first row isn't a header row (`tableMarkdown.ts`). On 3.31.3 every such cell got those attributes.
   - Probed on 3.31.4 with seven tables 3.31.3 saved (several paragraphs in a cell, merged cells, a resized column, aligned cells, text around the table): all seven opened read-only. On 3.31.3 all seven open editable and save byte for byte.
   - Nothing was lost (read-only, not rewritten), and none of the owner's vaults holds such a table (no `colspan="1"` under `C:\Users\andre\My Files\Vaults`), nor does the corpus.
   - **The fix:** `FiloTableCell` and `FiloTableHeader` in `tableMarkdown.ts` write every attribute, as 3.31.3's cells did. All seven tables open editable again and save byte for byte, the same bytes 3.31.3 wrote.
2. **A link no longer takes in whitespace at its end.** Link's autolink plugin now removes the link from trailing whitespace that a change inserts. Kept (decision 5).

   | Action | 3.31.3 saved | 3.31.4 saves |
   |---|---|---|
   | Typing ` now` right after a link at the end of a line | `Go [here now](https://example.com)` | `Go [here](https://example.com) now` |
   | The same in the middle of a line | `Go [here there](https://example.com) x` | `Go [here](https://example.com) there x` |
   | Insert Link with the text `new ` | `[new ](https://new.example)` | `[new](https://new.example) ` |

   - Typing a letter straight after a link still extends it, as before.
   - Links in existing notes are untouched: a load sets `preventAutolink`, which the plugin checks first, and the corpus shows no change.
3. **Ctrl+Z straight after an auto-format gives back what was typed.**
   - An input rule now dispatches the typed character first, then the conversion as its own undo step.
   - Typing `# Title` then Ctrl+Z: 3.31.3 removed everything typed; 3.31.4 leaves the literal `# `, and a second Ctrl+Z removes it. The same holds for `- `, `1. `, `[ ] `, `> `, `**bold**`, `*italic*`, `~~strike~~`, `==highlight==` and a code fence.
   - What typing saves is unchanged.
4. **Enter at the start of a ticked checklist item keeps it ticked.**
   - With a real key press, 3.31.3 moved the tick onto the new empty item above (`- [x] ` above `- [ ] done`), unticking the item the caret was in.
   - 3.31.4 saves `- [ ] ` above `- [x] done`. Correct.
5. **The editor keeps `role="textbox"` after Filo switches it read-only and back.** 3.31.3 dropped the role from every editor `setEditorEditable` touched, so a screen reader stopped announcing it as a text field.

**No effect on Filo:**
- The changes for TipTap's own Markdown package (`@tiptap/markdown`, which Filo doesn't use): inline-code fences, the ordered-list tokenizer, numeric entities, `:::` blocks, table Markdown.
- The new guard on style values: text alignment is written only for an allowed alignment, and a colour, font, size or highlight holding `;`, `{` or `}` is skipped. Filo's parse never produces such a value.
- Probed the same on both versions:
  - Enter over a selection (paragraph and heading);
  - Enter in the middle or at the end of a ticked item, and at the start of a bullet;
  - Backspace after a table;
  - a typed URL autolinking;
  - a space typed inside a link;
  - a Markdown (GFM) table.
- Not probed (no Filo behaviour depends on them): Backspace and Delete no longer join across a table cell's edge; a right-click inside a multi-cell selection keeps the selection; selection changes inside a node view with no content area are no longer ignored; a drag from an editor destroyed meanwhile is ignored.

#### What changed

- **`package.json`:** the ten re-export packages removed; `@tiptap/extension-list` and `@tiptap/extensions` added; every `@tiptap/*` at `^3.31.4`.
  - All 31 installed `@tiptap/*` packages are 3.31.4, none left at 3.31.3 (`npm ls --all`).
  - Eight packages left `node_modules` entirely. `extension-bullet-list` and `extension-ordered-list` stay as StarterKit's own dependencies, as the plan expected.
  - The lockfile changed only in `@tiptap/*` entries.
- **Imports**, as 3.2 lists: `createEditor.ts`, `listMarkers.ts`, `taskItems.ts`. Nothing else in `src/`, `scripts/` or the configs named the old packages.
- **`tableMarkdown.ts`:** `FiloTableCell` and `FiloTableHeader` (finding 1), which `createEditor.ts` registers in place of TipTap's TableCell and TableHeader.
- **Tests** (22 added, 7,571 → 7,593; one changed):
  - **`fixtures/markdown-body-roundtrip/html-tables.md` (new golden fixture):** four tables exactly as 3.31.3 wrote them (several paragraphs in a cell, merged header cells, a resized column, aligned cells).
    - It runs through the golden corpus's 8 checks: the bytes (LF and CRLF), a fixed point, the read-only verdict, its own output never read-only, no update on load, load then undo, and undo not crossing a reload.
    - The two component suites that open every fixture run it too (+2).
    - It passes on 3.31.3 as is. On 3.31.4 without `FiloTableCell` / `FiloTableHeader`, 4 of its 8 checks fail (both byte checks and both read-only checks).
  - **`insertLink.test.ts`:** the one failure. "A new link at a caret right before a link leaves that link alone" now expects `[new](https://new.example) [beta](…)`: the space typed in the link text stays outside the link. The case still checks what its name says.
  - **`editorTyping.test.ts`:**
    - typing a space at a link's end, at the end of a line and inside one (2);
    - undo straight after an auto-format: five block triggers and three marks (8);
    - Enter at the start of a ticked item, with a real keydown, pinned whole: `- [ ] a`, `- [ ] `, `- [x] done` (1).
  - **`editorSetEditableDiscipline.test.ts`:** the editor keeps `role="textbox"`, `data-note-editor` and `spellcheck` through `setEditorEditable` (1).
  - **Each new case pins its change:** run against 3.31.3 (the same test files in the base worktree), all 13 new or changed cases fail, and every other case in those files passes.
- **Docs:**
  - the design doc's Editor section lists the packages Filo now imports, including the four StarterKit nodes Filo extends (paragraph, heading, blockquote, hard break), which the old list left out;
  - CLAUDE.md: the `tableMarkdown.ts` structure line, and the "Filo writes only Markdown it reads back" paragraph;
  - BACKLOG: BL-14 (see "New findings").

#### Pass test

| Check | Result | Before |
|---|---|---|
| `npm run test:unit:strict` | With the update alone: 1 failure of 7,576 (`insertLink`, finding 2); every round-trip suite passed unchanged. Final tree: see `ci:verify`. | Phase 2: 7,571 passed |
| Corpus check against `main` | **0 changed, 0 newly read-only, 0 newly failed, 0 unlocked** on 679 notes (334 editable, 345 read-only on both), with the update alone and again with the table fix. Both runs read a frozen copy of the list (deviation 1). | |
| `npm run ci:verify` (Windows) | **Green in 234 s.** 797 files: 7,593 passed, 5 skipped. `test:unit:strict` 196 s. eslint 0 warnings; svelte-check 851 files (861 before: the ten removed packages' type files), 0 errors; 89/89 gates in 8.1 s. | Phase 2: 241 s, 7,571 passed |
| E2E, `FILO_E2E_SCALE=1` | **28 passed in 2.6 min**, on the final code, the axe scan and the three scale budgets included. `editorFidelity`, `noBytesByLooking` and `vaultSwitchAndBom` all pass. | 28 passed in 2.6 min |
| Built app | Only the `tiptap` chunk changed size: 1,185,250 → 1,194,432 bytes (+9,182: 3.31.4's own code, plus 24 bytes for the cell override). The other 24 assets are the same size; `main.js` (420,366) and `preload.js` (193,825) are identical to the byte, with no `require("zod")`. | Phase 2 sizes |
| `npm run dev` | On a cold Vite cache, the dev window opened a Document tab and a Mind Map, a Kanban and a Task List board with no reload and no "new dependencies optimized" line. `@tiptap/extension-list` and `@tiptap/extensions` are pre-bundled from `package.json` with no config edit; Vite discovered nothing late (deviation 4). | |
| Scripted built-app check | Every step saved what it should (below), every note reopened editable in a second session with `role="textbox"`, no console errors. Screenshots sent to the owner. | |
| `npm audit` | 8 high, all GHSA-ch52-4w7c-c8xp (BL-11). | The same |
| `npm outdated` | The `@tiptap/*` packages are gone from the list. Left: only the "wait" / "skip" majors (vite-plugin-svelte 7, js-yaml 5, markdown-it 15, nanoid 6, TypeScript 7, Vite 8). | |

**The built-app check** (two sessions on a scratch vault, the built app on a fresh profile):

| Step | Saved |
|---|---|
| Font family (Georgia) | `<span style="font-family: Georgia;">Alpha</span>` |
| Font size, + twice | `<span style="font-size: 16px;">beta</span>` |
| Text colour (preset `#3f51b5`) | `<span style="color: rgb(63, 81, 181);">gamma</span>`, Chromium's spelling, as before |
| Highlight (preset `#0288d1`) | `<mark data-color="#0288d1" style="background-color: rgb(2, 136, 209); color: inherit;">delta</mark>` |
| Align centre | `<p style="text-align: center;">Second paragraph here</p>` |
| Increase indent | `<p style="margin-left: 24px;">Third paragraph here</p>` |
| Line spacing 1.5 | `lineSpacing: 1.5` in the frontmatter |
| Insert Link (Ctrl+K), text `site `, address `example.com`, then typing `after` | `Fourth paragraph [site](https://example.com) after` |
| The table 3.31.3 saved as HTML | Opened editable; its first column dragged wider saved `colwidth="453"`, with `colspan="1" rowspan="1"` kept |
| Typing in a Markdown table cell | `\| one more \| 1 \|` |
| Ticking a checklist item; Enter at the start of ticked `two` | `- [x] one`, `- [ ] `, `- [x] two`, `- [ ] three` |
| A new Kanban card's empty note | The editor marks it `data-placeholder="Start typing..."`, but nothing displays it (BL-14) |

#### Deviations from the plan

1. **The corpus runs read a frozen copy of the list.** The list includes the TipTap READMEs and this repo's docs, which this phase changes or removes. Both runs read the same 679 copies in the scratchpad, so every note is compared.
2. **A 3.31.3 worktree for the probes and the "fails before" runs.**
   - `git worktree add` of `main` in the scratchpad, with a `node_modules` of junctions to this checkout's packages, except `@tiptap` (the 3.31.3 copy saved before the update) and `tiptap-markdown` (copied, so it finds the 3.31.3 core).
   - The probes are scratch test files, run once in each tree and never committed. The worktree was removed at the end.
3. **App code and tests beyond the tidy-up:** the table cell override (finding 1), the 22 new tests, and the one changed expectation (decisions 4–6). The plan expected an import change only.
4. **How the `npm run dev` check ran.**
   - `.claude/launch.json` got a temporary configuration, restored afterwards.
   - The first try passed `--rendererOnly`, which doesn't stop electron-vite 5 from starting Electron. That started a dev window on the owner's real profile (`AppData\Roaming\filo`, which opens the last vault on launch).
     - It was closed through its own close button's quit flow within a minute.
     - Checked afterwards: nothing under `C:\Users\andre\My Files\Vaults\Test Vault` changed (no file written in the 15 minutes around it). In the profile, only Chromium's `Preferences` and `DIPS` files and `window-state.json` (window position) were written.
   - The check then ran with `-- --user-data-dir=<scratch profile>` and `--remoteDebuggingPort`, a scratch vault opened from that profile's recent list, and a script driving the window over the debugging port.
   - The dev run rebuilt `dist/main` and `dist/preload` in development mode, so `npm run build` ran again before the E2E suite and the built-app check.
5. **The ticked new item turned out not to be a bug** (decision 6).
   - The first probes pressed Enter through TipTap's `keyboardShortcut` command, which replays a split's steps differently and leaves the new empty item ticked.
   - A real keydown, in jsdom and in the built app, leaves it unticked. So the item went into the backlog and came back out.
   - The test presses a real key and pins the whole result instead of only the ticked item.
   - The other Enter probes used `keyboardShortcut` too; they gave the same result on both versions, which is all they were for.

#### New findings

- **BL-14: an empty text tile or Kanban card never shows its "Start typing..." placeholder.** The editor marks the empty paragraph, but only the Document editor has CSS that displays it, and that editor sets its placeholder to `''`. It is the same before and after this phase: `@tiptap/extensions` is byte-identical between 3.31.3 and 3.31.4.
- **The golden corpus had no table saved as HTML**, so finding 1 passed every round-trip suite and the corpus check. It took a diff of the package and a probe to find. The `html-tables` fixture now covers it.

### Phase 4 outcome (2026-10-03)

**Status:** done, verified on Windows. Committed on `main`; not pushed (owner, at the start).
- knip 6.39.0 takes about 5 s and now reports nothing. It runs in `ci:verify`, after lint (owner: decision 2 changed).
- Every first-run finding is triaged below. The two false positives are fixed where they came from, so `knip.ts` holds no ignore entries.
- 38 exports that nothing used are gone; an export used inside its own file counts as used (owner). The built app is unchanged: with chunk and CSS-class hashes masked, every built file matches a build of `HEAD`.

#### Decisions at the start (owner, 2026-10-03)

Asked after the first knip run, so each question named real findings.
1. **Remove the 38 exports nothing uses, and count an export used inside its own file as used** (knip's `ignoreExportsUsedInFile`). The other options were the plan's one backlog item with no code change, and removing all 171 (dropping `export` from 132 more names in about 90 files).
2. **knip runs in `ci:verify`, all of it** (the recommended option). The others were only unused files and dependencies in `ci:verify`, or by hand only, as decision 2 said.
3. **Commit, don't push**, as in Phases 1–3.

#### The first run, triaged

The first run used the plan's `knip.ts` as written. It found 1 unused file, 3 unused devDependencies, 108 unused exports, 69 unused exported types, 1 duplicate export, and 5 configuration hints.

| Plan group | Finding | Verdict | What was done |
|---|---|---|---|
| 1. Unused dependencies | `sharp`, `png-to-ico`, `png2icons` | False positive. `scripts/generate-icons.mjs` loaded each by a computed name (`import(name)`), which knip can't follow. | Each import is written out (`optionalImport(() => import('sharp'))`). With `HEAD`'s script and the new one, `npm run icons` writes the same `icon.png`, `icon.ico` and `icon.icns`, byte for byte. |
| 2. Unused files | `components/boards/taskListRowProps.ts` | False positive, from the plan's Svelte reader: `compile()` drops `import type`, and three components import only types from this file. | The reader adds type-only imports back (deviation 1). |
| 3. Unused exports and types | With the reader fixed: 108 exports, 62 types and 1 duplicate (170 names, plus the duplicate `default`) in 96 files. 132 are used inside their own file; 38 are used nowhere. | Real. | The 38 removed (list below); the 132 accepted by `ignoreExportsUsedInFile` (decision 1). No backlog item is needed. |
| 4. False positives | The 5 configuration hints: the plan's entries `src/main/main.ts`, `src/main/preload.ts`, `src/renderer/main.ts`, `src/tests/corpus/corpusRun.ts` and `buildScratchVault.ts` are redundant. | knip finds them itself (deviation 2). | Removed from `entry`. |

**The 38 removed** (33 in app code, 5 in tests), plus one knip didn't list:
- `schema/index.ts`, the barrel: 14 value re-exports (`TileStyleSchema`, `LinkTileSchema`, `IframeTileSchema`, the six `…TileDefSchema` for image, video, file, audio, link and iframe, `TaskPlacementSchema`, `PartialTaskStyleSchema`, `TileGroupSchema`, `DecodedFiloLinkSchema`, `isFiloLink`) and 2 type re-exports (`GeneralSettings`, `TagsFile`). Each is still exported by its own module, which uses it or is imported directly.
- `schema/settings.ts`: the type `GeneralSettings` (never used).
- `schema/board.ts`: the type `KanbanSavedView`, marked "test-only", which no test used.
- `shared/types.ts`: the re-exports of `IpcChannelMap`, `EnvelopeChannel` and `SuccessOf`, and their import.
- `shared/untrusted.ts`: the `Untrusted<T>` brand, which nothing ever stamped, with its symbol. The header comment and CLAUDE.md's line for the file now describe only the `Sanitised*` brands the validators return.
- `main/services/fileWatcher.ts`: the re-exports of `correlateRenames` and `WatcherStatePayload` (the file still imports `correlateRenames` for its own use).
- `lib/boards/writeScheduler.ts`: the re-exports of `FlushAllResult`, `PerformWriteContext`, `PerformWriteResult` and `SchedulerSentinelInfo`. Callers import them from `writeSchedulerTypes.ts`.
- `lib/mindmap/mindMapContextMenus.ts`: the re-exports of `Tile` and `Frame`, the `Tile` import left unused, and the `ContextMenuItem` re-export on the same line, which knip didn't list but nothing imports from there (deviation 4).
- `stores/board.svelte.ts` (`Command`), `core/boardRegistry.ts` (`Board`), `lib/styles/effectiveStyle.ts` (`TileStyle`): one type re-export each, and the import it left unused.
- Tests:
  - `electronFake`'s `export default` (the duplicate). The `electron` mock in `characterisation/setup.ts` builds its own `default`.
  - `cancelThemeEditor` (characterisation harness) and `pressRedo` (component helpers).
  - `setAnswers` and `confirmDialogs` (E2E helpers; CLAUDE.md named `confirmDialogs`). With `setAnswers` gone, nothing could fill the native-box stub's answer queue, so the queue went too: the stub answers every box with its cancel button. It already did that whenever no answer was queued, which was every spec.

#### What changed

- **`package.json`:**
  - devDependency `knip` `^6.39.0` (6.39.0 installed);
  - npm script `knip`;
  - `ci:verify` is lint → **knip** → check → typecheck:main → test:unit:strict → build → ci:gates. GitHub's `verify` job runs `ci:verify`, so it runs knip too.
- **`npm install`:** 56 lockfile entries added and none changed or removed (checked by comparing the parsed lockfiles; git's 1,102-line diff only aligns them badly):
  - knip and its parts: `oxc-parser` 0.150.0, `oxc-resolver` 11.24.2 and 10 small helpers;
  - 43 optional per-platform builds of the two oxc packages. This machine installed 15 packages in all.
- **`knip.ts` (new):**
  - `entry`: `scripts/**/*.mjs` (the `perf/` scripts are in no npm script) and the test files;
  - `project`: `src/**/*.{ts,svelte}` and `scripts/**/*.mjs`;
  - `ignoreExportsUsedInFile: true`;
  - the Svelte reader (deviation 1).
  - It type-checks under `--strict` with no cast, and `npm run lint` covers it.
- **App and test code:** the removals above, and the literal imports in `scripts/generate-icons.mjs`.
- **CLAUDE.md:**
  - Quick Reference: the `knip` line;
  - the `ci:verify` chain, and a paragraph on what knip checks and the import-by-name trap;
  - the root file list (`knip.ts`);
  - the `untrusted.ts` line;
  - the E2E helper list (no `confirmDialogs`).
- **This plan:** the status line, notes under 4.1 and in Phase 8, decision 2's row, and this outcome.
- **BACKLOG:** unchanged. Nothing found here is left open (decision 1 settles the 132).

#### Pass test

| Check | Result | Before |
|---|---|---|
| `npm run ci:verify` (Windows) | **Green in 244 s.** eslint 0 warnings (`knip.ts` included); knip no findings; svelte-check 851 files, 0 errors, 0 warnings; 797 files: 7,593 passed, 5 skipped; 89/89 gates in 8.1 s (`test-typecheck` checks the edited helpers). | Phase 3: 234 s, the same counts |
| knip bites | Each probe, added to the tree and then removed, failed `npm run knip` (exit 1) under the right heading: a new file nothing imports (unused file), a new export nothing uses (unused export), `left-pad` added to `dependencies` (unused dependency), and an import of `lodash-es` (unlisted dependency). With all of them removed, exit 0. | |
| The Svelte reader | With the final config: `compile()` alone (the plan's reader) reports 1 unused file and 7 unused types, all false (`taskListRowProps.ts`; `LinkTile`, `IframeTile`, `TimerTile` twice each; `ResolvedTileStyleHolder`). knip's own reader reports 1 unresolved import, `,` in `KanbanBoard.svelte`. The final reader reports nothing. | |
| Built app | `main.js` 420,366 and `preload.js` 193,825 bytes, identical to the byte; no `require("zod")`. Against a build of `HEAD` in a scratch worktree, every renderer chunk is identical once chunk-name and Svelte class hashes are masked; `lowlight.js` and `tiptap.js` are identical outright. Every size equals the Phase 3 figures. | Phase 3 sizes |
| E2E, `FILO_E2E_SCALE=1` | **28 passed in 2.6 min**, the scale budgets included (deviation 5). | 28 passed in 2.6 min |
| `npm audit` | 8 high, all GHSA-ch52-4w7c-c8xp (BL-11). knip adds none. | The same |
| `npm outdated` | Only the "wait" / "skip" majors: vite-plugin-svelte 7, js-yaml 5, markdown-it 15, nanoid 6, TypeScript 7, Vite 8. | The same |

The renderer's CSS sizes differ between the two checkouts (`index.css` 204,665 bytes here and 204,366 in the worktree). Svelte's class hashes depend on the component's path, so CSS sizes compare only within one checkout. Here it is 204,665 bytes, as in Phase 0.

#### Deviations from the plan

1. **The Svelte reader is not the plan's `compile(source, {}).js.code`.**
   - The compiler drops type-only imports. A type, or a whole file, used only by components then reads as unused: the first run's one "unused file" and 8 of its "unused types" were that.
   - knip's built-in reader keeps type imports, but it finds imports with a regex over the script text. It read `'Open a vault first to import files', 'info'` in `KanbanBoard.svelte` as an import of `, `.
   - `knip.ts` therefore takes the compiler's output, which gets markup `{#await import(…)}` and component methods right, and adds back the type-only imports from `svelte/compiler`'s `parse`. No component has a `<script module>`, so the plan's reason for the compiler (exports in `.svelte` files) doesn't arise yet; the reader handles one if it appears.
2. **No app entries in `knip.ts`.**
   - knip 6.39 has an electron-vite plug-in that reads `electron.vite.config.mts` (main, preload, and the renderer through `index.html`).
   - Its Vitest plug-in reads every config an npm script names with `--config`: the corpus and scratch-vault runners.
   - knip flagged the five listed entries as redundant. The plug-ins knip enabled: electron-vite, ESLint, GitHub Actions, Node.js, Playwright, Prettier, Svelte, TypeScript, Vite and Vitest. Each reads the right config file (checked with `--debug`).
3. **The triage outcome differs from the plan's groups 3 and 4** (decision 1):
   - the 38 unused exports are removed now, not listed in a backlog item;
   - the false positives are fixed at their source rather than given `ignore` entries.
4. **Beyond knip's list:** the `ContextMenuItem` re-export (nothing imports it from `mindMapContextMenus.ts`) and the E2E stub's answer queue, both left dead by the removals.
5. **The E2E suite was run.** The plan doesn't ask for it in this phase, but the E2E helpers' dialog stub changed.
6. **knip is in `ci:verify`, and CLAUDE.md is updated now** (decision 2), not in Phase 8.

#### New findings

- **knip's built-in Svelte reader can read a string as an import** (knip 6.39.0, `importsWithinScripts`). It's knip's bug, not Filo's, and the reader above avoids it, so there is no backlog item. It could be reported upstream.
- **TRACK_B_INVESTIGATION §6 says knip "needs Svelte's own compiler plugged in, or it reports components' exports as unused".** For this codebase the reverse held: no component exports anything, and the compiler alone caused false positives. Phase 8 corrects that line when it marks §6.
- **`convertToUtf8.js` is 63,759 bytes at `HEAD`**, not the 63,389 that Phase 0 recorded. The later outcomes said every other asset kept its size, so one of Phases 1–3 changed it without the tables noticing. It is a shared chunk; this phase leaves it as it was.

### Phase 5 outcome (2026-10-03)

**Status:** done, verified on Windows. Committed on `main`; not pushed (owner, at the start).
- Every note in the plan's inputs reads the same in micromark as in Filo's markdown-it: the same words, the same ticked boxes, the same link addresses. Saving a golden fixture that opens editable changes nothing micromark shows. A one-off run on the real corpus found the same for all 333 notes there that open editable.
- Gate `one-markdown-parser` is in (90 gates) and proven to bite, as are the two gates this phase changed.
- Beyond the plan's inputs, 3,000 documents from the property test's generator found four ways a note Filo saves reads differently on GitHub. All four are edge cases that no fixture, toolbar case or real note holds: BL-15 to BL-18, two of them pinned in the new test.

#### Decisions at the start (owner, 2026-10-03)

Asked after a first probe had already found no difference on any planned input or on the real corpus, so the plan's open question (what to do if the parsers disagree on Filo's output) didn't come up.
1. **Commit, don't push**, as in Phases 1–4.
2. **The test compares more than visible text** (the recommended option): ticked boxes and link and image addresses too, and, for each golden fixture that opens editable, that micromark shows the same before and after the save. The other option was the plan's visible text only.
3. **Pin the new test in a gate** (the plan's optional item): yes.
4. **The real-corpus result goes in this outcome only**; `corpus:run` and `corpus:compare` are unchanged. The other option was to add a "reads the same elsewhere" flag to the corpus tooling.

#### What the second parser found

| Input | Notes | Differ |
|---|---|---|
| Golden fixtures, as a save writes them | 27 | 0 |
| Toolbar cases, as saved | 70 | 0 |
| Golden fixtures that open editable: micromark before and after the save | 24 | 0 |
| Real corpus (713 notes: repo 104, vaults 32, `node_modules` READMEs 577), the 333 that open editable: the saved note in both parsers, and micromark before and after the save | 333 | 0 |
| Documents from the round-trip property test's generator (its seed, 20260930) | 3,000 | 97 |

The 97 generated documents:
- **70 differ only through single tildes.** With GitHub's single-tilde strikethrough turned off, micromark agrees with markdown-it. GitHub strikes `a ~one~ b` through, as micromark does: **BL-15**.
- **27 differ otherwise.** Each was sent to GitHub's own renderer (`gh api markdown`, `mode=gfm`; generated text only, no note content) and its text compared:
  - **18: GitHub shows what markdown-it shows.** These are micromark's own quirk: it pairs emphasis and strikethrough in separate passes, so where `*` and `~~` interleave (`*~~*a~~*`) it reads the note differently from both. Not Filo's; the test's header says so.
  - **2: GitHub shows what micromark shows.** One is a run of three tildes, a `~` typed right before struck text (**BL-16**). The other involves a single tilde.
  - **7: GitHub differs from both.** Four are bare web addresses in text where Filo wrote a `\` that GitHub's own linking keeps in the link (**BL-17**). One is a single-tilde pair, one a run of three tildes. One is italic, struck-through and coloured text holding `**`: GitHub closes the italic on the `**` (**BL-18**).
- Each finding was then reduced to a few characters and checked on all three (markdown-it, micromark, GitHub); BACKLOG has those examples.

#### What changed

- **`package.json`:** devDependencies `micromark` `^4.0.3`, `micromark-extension-gfm-strikethrough` `^2.1.0`, `micromark-extension-gfm-table` `^2.1.2` and `micromark-extension-gfm-task-list-item` `^2.1.0` (each the latest). The lockfile gained 26 entries, all dev-only; none changed or was removed.
- **`src/tests/helpers/toolbarCases.ts` (new):** the toolbar cases, moved unchanged as `TOOLBAR_CASES`, with `applyToolbarCase` (load, select the first block, run, return the saved Markdown), `normalisedDoc` and `selectFirstBlock`, so Phase 6 can run them in Chromium the same way.
- **`toolbarFormattingRoundTrip.test.ts`:** reads the cases from the helper. Its 74 tests are the same.
- **`markdownContentElsewhere.test.ts` (new), 124 tests:**
  - one that checks it read every fixture and every toolbar case;
  - 97 inputs: the note's own markdown-it (through `markdownRenderer`) against micromark with the three GFM extensions, raw HTML and every link address kept;
  - 24 "a save changes nothing another app shows" cases (the 27 fixtures less the 3 that open read-only);
  - 2 known differences (BL-15, BL-16), each pinning what Filo saves and what each parser shows. They are also the proof that the comparison can fail.
  - Where blocks meet, and at a `<br>`, the text counts a space: Filo's markdown-it render and micromark's don't put the same white space between blocks, and words apart on screen must compare apart.
- **`src/renderer/lib/editor/markdownSync.ts`:** `markdownRenderer` is exported, so the test reads exactly the markdown-it instance the read-only check uses. No other app code changed.
- **Gates (`scripts/gates/markdownFormat.mjs`):**
  - `one-markdown-parser` (new): in `src/renderer`, `src/main` and `src/shared` (`.ts`, `.svelte`, `.mts`, `.mjs`), no static, dynamic, `require` or bare import of `marked`, `micromark*`, `remark*`, `unified`, `mdast-*`, `commonmark` or `@tiptap/markdown`, a subpath included; none of them in `dependencies` or `optionalDependencies`; the plan's hint.
  - `markdown-body-roundtrip`: also pins the new test (it renders with micromark and with `markdownRenderer`, reads the golden corpus and `TOOLBAR_CASES`, keeps the save check, nothing skipped or focused).
  - `toolbar-formatting-saved`: looks for each toolbar command in the cases file (comments stripped), requires the round-trip test to loop over `TOOLBAR_CASES` from the helper, and refuses a skip in either file.
- **CLAUDE.md:** the gate count (90); the Tech Stack "Markdown parsing" row; the `markdownFormat` row; the `helpers/` line; the toolbar sentence in Common Gotchas; a Testing Strategy line for the second parser (deviation 6).
- **BACKLOG:** BL-15 to BL-18, with a shared note on how they were found.
- **This plan:** the status line, notes under 5.2, 5.3, 6.3 and Phase 8, and this outcome.

#### Pass test

| Check | Result | Before |
|---|---|---|
| `npm run ci:verify` (Windows) | **Green in 270 s.** eslint 0 warnings; knip no findings; svelte-check 851 files, 0 errors, 0 warnings; 798 files: 7,717 passed, 5 skipped (+124, all in the new file: a per-test comparison with a run of `HEAD` shows no other file's tests changed); 90/90 gates in 9.2 s. | Phase 4: 244 s, 797 files, 7,593 passed, 89 gates |
| Gates bite | 16 probes, each a violation written into the real source, the gate run, the file restored: 8 for `one-markdown-parser` (an import of `marked` in a renderer `.ts`, a dynamic `import('micromark')` in a component, `import 'remark-gfm'` in main, `require('unified')` in shared, a `mdast-util-from-markdown/…` subpath, `@tiptap/markdown`, `commonmark`, and `micromark` in `dependencies`), 4 for the new test's pinning (a skipped case, the save check removed, the toolbar cases not read, micromark not called), 4 for `toolbar-formatting-saved` (a toolbar command's case removed, the same case left only in a comment, the test running a slice of the cases, a skipped case). All 16 fail with the right message; the tree is clean afterwards. The first run missed the last probe: the skip check on the cases file had been left out, and was added. | |
| Built app | All 28 files in `dist/` are identical to the byte to the Phase 4 build (`main.js` 420,366, `preload.js` 193,825, renderer `index.js` 2,553,929, `tiptap.js` 1,194,432); no `require("zod")`. micromark is a dev dependency and nothing in the app imports it. | Phase 4 build |
| `npm run lint`, `npm run knip` | 0 warnings; knip reports nothing (the new packages count as used by the test). | |
| `npm audit` | 8 high, all GHSA-ch52-4w7c-c8xp in electron-builder's chain (BL-11). The micromark packages add none. | 8 high, BL-11 |

The E2E suite was not run: nothing in Electron, the build, the editor's behaviour or the Raw view changed (the one app-code change is an `export`), and the built app is unchanged (above).

#### Deviations from the plan

1. **The test compares more than visible text** (decision 2): ticked boxes, link and image addresses, and a save check for editable fixtures.
2. **Inputs beyond the plan were probed, and not committed:** the real corpus (713 notes) and 3,000 generated documents, in throwaway test files deleted afterwards. The 27 generated documents micromark couldn't explain, and the reduced examples, were checked against GitHub's renderer through `gh api markdown`. That sent generated test text to GitHub, nothing from a note.
3. **Known differences are pinned as tests**, not only listed in a comment, so a fix to the writer shows up as a failing case.
4. **The helper holds more than `CASES`:** `applyToolbarCase`, `normalisedDoc` and `selectFirstBlock` moved with it, since both suites (and Phase 6) run a case the same way.
5. **App code:** `markdownRenderer` exported from `markdownSync.ts`; and the `toolbar-formatting-saved` gate changed to follow the moved cases, which the plan didn't mention.
6. **CLAUDE.md's Testing Strategy line is written now**, not in Phase 8, as Phase 4 did for its own lines.
7. **The text comparison counts a space where blocks meet and at a `<br>`.** With `textContent` alone, 23 of the 27 fixtures and 4 toolbar cases "differed": Filo's markdown-it render runs the text of adjacent blocks together where micromark's doesn't.

#### New findings

- **BL-15:** text typed with a single `~` each side (`a ~one~ b`) is saved as typed; GitHub strikes it through. Pinned in the test.
- **BL-16:** a `~` typed right before (or after) struck text is saved as a run of three tildes (`x ~~~a~~ y`); GitHub shows the tildes and strikes nothing. Pinned in the test.
- **BL-17:** a bare web address in text can be saved with a `\` inside it (`…/A\_(b)`), which GitHub's own linking keeps in the link, breaking it. micromark as set up here can't see it.
- **BL-18:** italic, struck-through and coloured text holding `**` is saved as `<span …>*~~2** -~~*</span>`, without the escapes Filo writes everywhere else (`minimalEscapes.ts` finds markdown-it doesn't need them there); GitHub closes the italic on the `**`. micromark agrees with markdown-it here, so the test can't see it.
- **micromark's own quirk** (emphasis and strikethrough paired in separate passes): not Filo's, so no backlog item; the test's header tells the next reader to check such a difference against GitHub first.

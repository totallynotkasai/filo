# Dependency Upgrade Report — 2026-09-23

Branch: `chore/electron-42` (base commit `e35c170`). **All changes below are UNCOMMITTED** and sit in the
working tree alongside the pre-existing, also-uncommitted Audit-18 work (~78 files). Commit the dependency
changes separately if you want a clean, reviewable diff.

This document records (1) what was upgraded and how it was verified, (2) what still needs **external
re-verification** (things automated checks here could not prove), and (3) the remaining deferred upgrades
with their known migration hazards.

---

## 1. Summary

| | Start of session | Now |
|---|---|---|
| `npm outdated` | 50 packages behind | Only deferred majors remain (see §4) |
| `npm audit` (all deps) | 69 advisories — 4 critical, 18 high, 45 moderate, 2 low | **37 moderate, all TipTap 2.x / tiptap-markdown** |
| `npm audit --omit=dev` | 46 (incl. 1 critical: jspdf) | 37 moderate (TipTap only) |
| `npm run ci:verify` | exit 0 | **exit 0** (4711 unit tests + 1 skipped, 349 guard-script tests, 47 gates) |
| Lint | 0 errors / 48 warnings | 0 errors / 48 warnings (unchanged, pre-existing) |
| Electron | 42.3.3 (EOL 2026-10-20) | **44.4.5** (supported to 2027-03-02) |

---

## 2. What was changed

### 2.1 `package.json` — direct dependency changes

| Package | Before | After | Type | Notes |
|---|---|---|---|---|
| electron | ^42.3.3 | **^44.4.5** | dev | Node 24.21 / Chromium 152 at runtime |
| jspdf | ^2.5.0 | **^4.2.1** | prod | Clears CRITICAL advisory (incl. its bundled old dompurify) |
| vitest | ^2.1.0 | **^4.1.11** | dev | Clears CRITICAL advisory; no test changes needed |
| @vitest/coverage-v8 | ^2.1.9 | **^4.1.11** | dev | Must track vitest |
| focus-trap | ^7.6.0 | **^8.2.2** | prod | Return-focus now deferred one frame (see §3) |
| jsdom | ^25.0.0 | **^29** (29.1.1) | dev | 30.x deliberately skipped (Node ≥22.22.2 requirement) |
| fast-check | ^3.23.2 | **^4.10.2** | dev | Tests only |
| sharp | ^0.34.5 | **^0.35.4** | dev | Icon generation only; clears HIGH advisory |
| prettier-plugin-svelte | ^3.5.2 | **^4.1.1** | dev | No new formatting drift (see §3.8) |
| svelte | ^5.0.0 | ^5.57.1 | dev | Floor raised — clears 4 moderate advisories |
| nanoid | ^5.0.9 | ^5.1.16 | prod | Floor raised — clears HIGH advisory |
| js-yaml | ^4.1.0 | ^4.3.2 | prod | Floor raised — clears HIGH advisory; **behaviour change** (see §3.4) |
| dompurify | ^3.2.0 | ^3.4.15 | prod | Floor raised — hardening releases |
| gray-matter | ^4.0.3 | **removed** | prod | Unused since Audit-13 M2 (only referenced in comments); dragged in vulnerable js-yaml 3 |
| @types/dompurify | ^3.0.5 | **removed** | dev | dompurify ships its own types |

Floors were raised on security-relevant packages so a fresh install can never resolve back to a vulnerable
version.

### 2.2 Lockfile-only (in-range) updates via `npm update` + `npm audit fix` (non-force)

@tiptap/* 2.27.2→2.27.3, eslint 10.4→10.11, eslint-plugin-svelte 3.17→3.23, typescript-eslint 8.60→8.70,
svelte-check 4.6→4.7.6, svelte-eslint-parser 1.6→1.8, prettier 3.8.3→3.9.9, @playwright/test 1.60→1.63,
@axe-core/playwright + axe-core 4.11→4.13, electron-builder 26.15.0→26.15.3, yaml 2.9.0→2.9.1,
svelte-dnd-action 0.9.69→0.9.79, globals 17.6→17.12, png-to-ico 3.0.1→3.0.2, plus transitive fixes
(tar, ws, undici, postcss, picomatch, brace-expansion, form-data, fast-uri, @xmldom/xmldom, devalue,
linkify-it, markdown-it, fflate, browserslist, etc.).

### 2.3 Source changes

Exactly **one** line of source changed:

- `src/tests/unit/tagRewriter.test.ts` (~line 612) — added `'1_000'` to `ALLOWED_DIVERGENCES` in the
  quoting-oracle parity test, with a comment. Reason: js-yaml ≥4.3 no longer resolves `1_000` as an integer,
  so the *old oracle* now emits it bare while Filo's writer (the `yaml` package, `version: '1.1'`) still
  emits `'1_000'`. Filo's on-disk output is **unchanged**; only the reference oracle moved.

No application code was changed.

---

## 3. Items requiring external re-verification

Automated coverage here = `ci:verify` (lint, svelte-check, unit tests, build, 47 guard scripts) plus the
Electron E2E `src/tests/e2e/recoveryRelaunch.test.ts` (2/2 pass on Electron 44: real app launch → vault open
→ SIGKILL mid-write → relaunch → Recovery modal). **Nothing below was exercised by hand.**

### 3.1 Electron 44 — manual smoke test (HIGH priority)

`ci:verify` does not launch Electron. Please verify on a real machine (Windows at minimum; macOS/Linux if
shipping there):

- [ ] `npm run dev` starts and the Home screen renders.
- [ ] Open / create a vault via the native folder dialog.
- [ ] Native file-open dialog (attachments) and font-import dialog.
- [ ] OS drag-and-drop of files onto a Mind Map board (exercises `webUtils.getPathForFile` +
      `vault:register-source-path` + `vault:copy-file` source approval).
- [ ] `filo://` media: image, video (seek → HTTP Range), audio, PDF/file tile open.
- [ ] Link tile metadata fetch; iframe tile renders under CSP.
- [ ] Spellcheck in a Text tile / Document.
- [ ] External links open in the OS browser (`https://`, `mailto:`); `http://` refused.
- [ ] Quit with pending edits → drain completes, no data loss; quit-heartbeat behaves.
- [ ] Split panes, tab switching, undo/redo.
- [ ] **Packaging:** `npm run package` produces a working NSIS installer (electron-builder 26 +
      Electron 44 never packaged in this session). Install, launch, open a vault.
- [ ] macOS: note Electron 44 **drops macOS 12** — DMG minimum OS is now macOS 13.

### 3.2 Electron 43+ dialog default-folder change (UX — decision needed)

Since Electron 43, a native dialog with no `defaultPath` opens in **Downloads** instead of the last-used
folder. Affected call sites (no code change made):

- `src/main/ipc/vault.ipc.ts:84` — vault picker
- `src/main/ipc/dialog.ipc.ts:155` — attachment/file open
- `src/main/ipc/fonts.ipc.ts:51` — font import
- `src/main/ipc/export.ipc.ts:80-82` — export save dialog passes a bare filename, likely also Downloads

Suggested fix: pass the active vault root (or `app.getPath('documents')` for the vault picker) as
`defaultPath`. ~30 min, low risk.

### 3.3 jspdf 2 → 4 — PDF export

- [ ] Export a board to **PDF** and open the result. Filo uses only `new jsPDF(...)`, `addImage(PNG)` and
      `output('datauristring')` (`src/renderer/lib/export/exportService.ts`), none of which changed
      meaningfully, and never calls `.html()` (the vulnerable path). Build + tests pass, but no PDF was
      actually rendered and inspected.
- [ ] Also sanity-check PNG / SVG / Markdown export (unchanged libs, but same code path).

### 3.4 js-yaml 4.1 → 4.3 — tag-name validation behaviour change

`src/renderer/lib/vault/tagsStorage.ts` (~line 257–276) uses js-yaml as a guard when minting tag names.
Under 4.3 a tag named `1_000` is now **accepted** (previously rejected as numeric). Assessed as safe —
Filo's frontmatter writer quotes it (`'1_000'`) and the reader (`yaml` pkg) round-trips it as a string —
but confirm this is the desired product behaviour:

- [ ] Create a tag `1_000` on a Text tile; verify frontmatter shows `tags: ['1_000']` and it survives
      reload / external edit.

### 3.5 focus-trap 7 → 8 — return focus deferred one frame

focus-trap 8.2 defaults `delayReturnFocus: true`. Affects the 7 components using
`returnFocusOnDeactivate: true` and the manual focus restore in `SaveTemplateModal`. Unit tests pass.

- [ ] Keyboard-only: open and close each modal (Settings, Board Browser, Template Browser, Save Template,
      Task Properties, Orphan Catcher, Recovery, confirm dialogs, Tag popups) — focus must return to the
      invoking control.
- [ ] Run the E2E focus specs: `focusTrap.test.ts`, `confirmDialogFocus.test.ts`,
      `sidebarDeleteButtonFocus.test.ts`, `kanbanTagPopupEscape.test.ts` (see §3.9 re: E2E baseline).

### 3.6 svelte-dnd-action 0.9.69 → 0.9.79 — drag behaviour

In-range, but 0.9.71–0.9.75 fixed drag teardown / stale nested-handle shadow / cursor on remorph, and
0.9.76–0.9.79 added keyboard-drag sync and flip-animation drop fixes.

- [ ] Manually drag cards between Kanban columns, reorder columns, reorder Task List tasks and sections,
      including keyboard drag.
- [ ] Check whether the workaround in `clearStaleDndStyles.ts` is still needed (the library may now fix
      the underlying issue). Do **not** remove it without a manual repro.

### 3.7 vitest 2 → 4 / jsdom 25 → 29 — test-infra semantics

All tests pass unchanged, but note for future test authors:

- Fake timers now also fake `requestAnimationFrame` and `performance` (except `nextTick` /
  `queueMicrotask`) unless `toFake` is specified.
- `vi.restoreAllMocks()` only restores `vi.spyOn` spies and no longer resets their call history.
- Coverage (`test:unit:coverage`, not part of `ci:verify`) uses v8 AST-aware remapping — numbers will
  shift; the branches-80 threshold may need retuning. **Not run in this session.**
- jsdom 29 requires Node ≥22.13; CI uses `node-version: '22'` (resolves to latest 22.x — fine).
- [ ] Run `npm run test:unit:coverage` once and confirm thresholds.
- [ ] Confirm GitHub Actions CI is green on push (only verified locally on Node 24.16).

### 3.8 Prettier — pre-existing drift (not introduced here)

`npx prettier --list-different src/` reports **615 files** that don't match `.prettierrc`, both before and
after the prettier-plugin-svelte 4 upgrade (identical list — the upgrade added no drift). Prettier is not
enforced by `ci:verify` (lint = eslint only). If you ever run `npm run format`, do it as a standalone
commit.

### 3.9 E2E suite baseline

Only `recoveryRelaunch.test.ts` was run. The recorded pre-existing E2E baseline (Audit-15 Phase 0) was
8 pass / 34 fail / 4 skip, largely because store-importing specs need a Vite dev-server harness and
axe ↔ Electron is blocked by `Target.createTarget`. Re-running the full suite on Electron 44 should be
compared against that baseline, not against "all green".

- [ ] `npm run test:e2e` — confirm no *new* failures vs the 8/34/4 baseline.

### 3.10 Environment / tooling notes

- **Electron postinstall is flaky on this machine**: `npm install` repeatedly left
  `node_modules/electron/` without `dist/electron.exe` / `path.txt`. Fix:
  `node node_modules/electron/install.js`. Any fresh clone / CI cache should confirm the binary exists.
- **electron-vite 5 build targets**: its Node/Chrome target table stops at Electron 39; newer majors fall
  back to `node22.20` / `chrome142` (older than Electron 44's real Node 24.21 / Chrome 152). Output is
  merely more conservatively transpiled — harmless, and already the case on Electron 42. Revisit when
  electron-vite 6 is stable.
- **Leftover worktree**: `.claude/worktrees/agent-a7788b9cc27bbb73d` (locked, detached at `e35c170`) was
  used to trial the in-range updates. Safe to remove:
  `git worktree unlock <path>` then `git worktree remove --force <path>`.
- Lockfile churn is large (`package-lock.json` ~5.4k lines changed) — expected from `npm update` +
  `npm audit fix`.

---

## 4. Remaining deferred upgrades

### 4.1 Zod 3.25.76 → 4.x — **HIGH risk (silent data drift)** — est. 1–2 days

16 files import bare `'zod'` (none use `'zod/v4'`).

- **`.default({})` semantics change — 33 sites.** In v4 a default value short-circuits parsing, so a
  missing object yields `{}` *without* its inner defaults. Examples: `schema/board.ts:413`
  (`MindMapSettingsSchema.default({})`), `schema/settings.ts:161-310` (comment at `:321` relies on v3
  behaviour), `schema/connection.ts:85`, `schema/frame.ts:76`, `schema/tagsFile.ts:37-38`. Every site must
  become `.prefault({})` or settings/boards silently lose defaults.
- `.passthrough()` ×89 / `.strict()` ×4 — deprecated (still work); inferred types gain an index signature.
- `z.ZodTypeAny` → `z.ZodType` (`loadVersionedFile.ts:85`, `schemaUtils.ts:72`, `ipcSchemas.ts:186,204`).
- `z.ZodIssueCode.custom` → `code: 'custom'` (`board.ts:589,607`, `boardFile.ts:86,93,105`).
- `z.preprocess` now returns a `ZodPipe` (`tile.ts:392`, `schemaUtils.ts:73`) — re-check inside
  discriminated unions.
- Error message wording changes; `boardLoader.ts:536` surfaces `issues[].message` to users; message-asserting
  tests will break.
- **Plan:** own branch; first add a test asserting `parse({})` yields the full defaults tree for every
  top-level schema; migrate file-by-file via the `zod/v4` subpath already shipped in 3.25.

### 4.2 TipTap 2.27 → 3.31.3 + tiptap-markdown 0.8.10 → 0.9.0 — MEDIUM-HIGH risk — est. 12–16 h

Only fix for the 37 remaining moderate advisories (GHSA-cp6q-959q-f8rh, `mergeAttributes` `__proto__`
pollution; affects all `<3.30.4`, no 2.x backport). Exposure: inbound HTML inside vault `.md` files
(`html: true`). tiptap-markdown 0.9.0 requires `@tiptap/core ^3.0.1` — the two must move together. Do
**not** switch to the official `@tiptap/markdown` (different serializer; breaks `ParagraphWithBlankLines`).

| v3 change | Hit | Impact |
|---|---|---|
| `setContent(content, options)`; emits update by default | `lib/editor/markdownSync.ts:197` | **Critical** — boolean 2nd arg no longer means "don't emit" → loading a file fires `onUpdate` → phantom write. Must become `{ emitUpdate: emit }`. |
| StarterKit now bundles Link + Underline | `lib/editor/createEditor.ts:181,192,198,289,301` | Duplicate extensions — disable in StarterKit; label editor would silently gain Link. |
| TextStyle named exports; ships own FontSize/Color/FontFamily | `createEditor.ts:20,22,24,44` | Custom `FontSize` may collide; nested-span merge may change inline HTML **bytes on disk**. |
| Table packages consolidated | `createEditor.ts:28-31` | Import changes. |
| TaskList/TaskItem → `@tiptap/extension-list` | `createEditor.ts:32-33` | Import changes. |
| Placeholder → `@tiptap/extensions` | `createEditor.ts:27` | Import change. |
| Storage typing | `markdownSync.ts:190,312` | Low (already cast defensively). |

Round-trip verification required (Filo's core invariant is byte-faithful Markdown): `markdownSync`,
`markdownHtmlMode`, `emptyParagraphs` tests, `ci:frontmatter-invariant`, `isLossyMarkdownRoundTrip`
(must not start flagging existing files read-only), plus an old-vs-new body-diff over a real `.md` corpus.

### 4.3 Vite 6 → 7 + @sveltejs/vite-plugin-svelte 5 → 6 — MODERATE — est. ½–1 day

Now unblocked (vitest 4 no longer bundles an old Vite). Highest compatible set today:
**vite 7 + vite-plugin-svelte 6 + electron-vite 5 + vitest 4/5**.

- Requires Node ≥20.19; default `build.target` becomes `baseline-widely-available` (fine for Electron 44).
- Remove the legacy `svelte({ hot: ... })` option in `vitest.config.mts`.
- Optionally follow with **vitest 5.0.x**: `clearMocks` on by default (tests reading mock calls recorded
  in `beforeAll`/module scope lose them — or set `clearMocks: false`), unawaited `.resolves/.rejects` fail,
  `expect.poll` rejects on timeout (11 files use poll/waitFor), `toThrow('')` matches any error,
  `globalThis` assignments reach jsdom (check `setup.ts` PointerEvent polyfill + 3 `vi.stubGlobal` files).

### 4.4 Wait — do not upgrade yet

| Package | Latest | Why wait |
|---|---|---|
| vite 8 / vite-plugin-svelte 7 | 8.3.0 / 7.3.0 | Only electron-vite **6.0.0-beta** supports Vite 8; also needs `rollupOptions`→`rolldownOptions` (3 places) and function-form `manualChunks` rewritten for Rolldown. |
| typescript 7 | 7.0.2 | svelte-check accepts TS ^5/^6 only; typescript-eslint caps <6.1 (TS7 support "not planned" for now); TS 7.0 has no programmatic API. Stay on 5.9 (6.x acceptable ceiling). |
| jsdom 30 | 30.1.1 | Needs Node ^22.22.2 / ^24.15; no benefit over 29 yet. |
| js-yaml 5 | 5.4.2 | API rewrite (named exports, CORE schema default); only one guard site uses it — no gain. |
| nanoid 6 | 6.0.1 | Drops Node 18/20; no gain. |

### 4.5 Already at latest (no action)

unified 11.0.5, remark-parse 11.0.0, remark-frontmatter 5.0.0, rbush 4.0.1, minisearch 7.2.0,
html-to-image 1.11.13, lowlight 3.3.0, yaml 2.9.1, electron-builder 26.15.3.

---

## 5. Recommended next steps

1. Commit the dependency changes (package.json, package-lock.json, tagRewriter.test.ts) as a standalone
   commit, separate from the Audit-18 work.
2. Complete the §3.1 Electron 44 manual smoke + packaging check **before 2026-10-20** (Electron 42 EOL —
   this is why 44 was adopted now).
3. Decide on §3.2 dialog `defaultPath`.
4. Zod 4 branch (§4.1) — add the defaults-tree test first.
5. TipTap 3 branch (§4.2) — clears the last advisories.
6. Vite 7 branch (§4.3).

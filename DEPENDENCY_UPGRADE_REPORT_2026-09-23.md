# Dependency Upgrade Report — 2026-09-23

Branch: `chore/electron-42`. Sections 1–5 describe the **first pass** (now committed as `0e61d97`).
**Section 0 (below) is the second pass**: a regression it found and fixed, three more upgrades, and the
refined migration plan for the remaining majors. Where §0 disagrees with a later section, §0 is correct.

---

## 00. Third pass (same day) — svelte unpinned, Zod 4, TipTap 3 — ALL DONE

`chore/electron-42` was fast-forwarded into local `main` (not pushed); this pass is on
**`chore/dependency-majors`** (branched from `main`, not pushed). Where this section disagrees with
§0.2 / §0.5–§0.8, this section is correct.

| Commit | Content |
|---|---|
| `90e4092` | **Effect-loop fix + svelte `5.57.0` → `^5.57.1`** (§00.1) |
| `7acebc8` / `7e5ee29` | Zod default-tree snapshot tests (on v3) → **zod 3.25.76 → 4.6.5** (§00.2) |
| `63b20e8` / `efb682d` | Markdown body round-trip corpus + `ci:markdown-body-roundtrip` gate (on v2) → **TipTap 2.27 → 3.31.3, tiptap-markdown 0.8.10 → 0.9.0** (§00.3) |

**Result:** `npm audit` **0 vulnerabilities** (was 37 moderate). `ci:verify` exit 0 — 4862 unit + 1
skipped, 349 guard tests, **48 gates**, lint 0 errors / 24 warnings (baseline). Real-app E2E on the
production build: `documentOpenNoWrite` (new) + `recoveryRelaunch` 4/4 pass. Full E2E suite (`--workers=1`): 10 pass / 34 fail / 4 skip — the
same 34 failures as the Audit-15 baseline (identical test list), +2 passes from the new spec.

### 00.1 Root cause of the §0.2 effect loop (fixed)

TipTap's `editor.setEditable(x, emitUpdate = true)` emits `update` by default. The Audit-17 5.7
close-drain `$effect` in `DocumentEditor.svelte` / `TextTile.svelte` called it on mount, so `onUpdate`
→ `documentStore.updateContent` (a `SvelteMap` read + write) ran *inside* the effect →
`effect_update_depth_exceeded`. svelte 5.57.1's batching re-ran the loop after hydrate, so the emitted
update scheduled a real write (CRLF body → LF). Fix: new `lib/editor/setEditorEditable.ts` calls
`setEditable(x, false)` (no-op when unchanged); all 6 call sites use it (effects also wrap it in
`untrack`). This also closes a latent twin: the hydrate-*retry* path's `setEditable(true)` emitted an
update while the editor was still empty. Guards: `editorSetEditableDiscipline.test.ts` (real editor,
bite-verified; bans raw `.setEditable(` in `src/renderer`) and **new E2E
`src/tests/e2e/documentOpenNoWrite.test.ts`** (CRLF + LF doc open → bytes identical, zero loop errors —
red before the fix, green after, on 5.57.1). The E2E is not part of `ci:verify` (needs a build + real
Electron; run `npx playwright test src/tests/e2e/documentOpenNoWrite.test.ts --workers=1` after
`npm run build` whenever svelte or TipTap moves).

### 00.2 Zod 4 — what changed

25 object `.default({})` → `.prefault({})`; every array/record default → getter form
(`.default(() => [])`) so no two parses share a mutable object. `ZodTypeAny` → `z.ZodType`,
`ZodIssueCode.custom` → `'custom'`, generic `optionalNumber`. `zodDefaultsSnapshot.test.ts` (recorded on
v3, 24 cases incl. fresh-object checks) passes unchanged on v4 — it failed 10 cases on v4 before the
schema fixes. `boardLoader.ts` now prefixes each issue with its field path (v4 wording is more generic).
`exportService.ts` got an explicit `?? 0` for `shadowIntensity` (runtime-identical). **Optional
follow-up:** `.passthrough()` ×89 is deprecated in v4 (use `.loose()`); still works.

### 00.3 TipTap 3 — what changed

`setContent(x, { emitUpdate })`; StarterKit `trailingNode/link/underline: false` (label editor also
`listKeymap: false`); TextStyle `mergeNestedSpanStyles: false`; named-export imports;
`@tiptap/extension-paragraph` + `@tiptap/pm` declared. **tiptap-markdown 0.9.0 works as-is — not
vendored** (`storage.markdown.parser.md`, `getMarkdown`, custom `serialize` hooks and HTML mode all
verified). The new 20-fixture × LF/CRLF corpus (`markdownBodyRoundTrip.test.ts`, gate
`ci:markdown-body-roundtrip`) is byte-identical v2 → v3; each of the three fixes was bite-verified
against it. **One intended difference:** relative links like `[note](Notes/Other.md)` were dropped by
v2 (file opened read-only); v3 keeps them byte-exact (file now editable).

Pre-existing v2 behaviours recorded as baseline (NOT caused by the upgrade; candidates for later work):
files with `filo://` links or `[[wiki]]` links, tight task lists, nested `<span style>`, multi-line
blockquotes, HTML comments / `<div>` blocks are flagged lossy → opened read-only (never written); an
edited-and-saved body drops its final newline and saves a CRLF body as LF.

### 00.4 Still needs a human (manual smoke)

- TipTap 3 UI not covered by jsdom: toolbar link / font size / family / colour / highlight, tables
  (incl. column resize), task-item checkboxes (CSS vs v3 HTML), placeholder, paste/copy.
- **ListKeymap is now ON in the main editor** — Backspace/Delete inside lists behaves differently
  (UX only, no byte effect). Connection labels must NOT auto-link URLs.
- Open a CRLF and an LF note as a **Text tile on a Mind Map** (the E2E covers only the Document tab) —
  file must stay byte-identical.
- Everything in §0.4 (dev server, `npm run package` install test, dialogs, drag-drop, PDF export,
  focus return) is still outstanding.

### 00.5 What remains outdated

Only upstream-blocked or no-benefit majors: vite 8 / vite-plugin-svelte 7 (electron-vite 6 still beta),
TypeScript 7 (typescript-eslint `<6.1.0`, svelte-check `^5||^6`), jsdom 30, js-yaml 5, nanoid 6 (§4.4).

---

## 0. Second pass (same day) — results and plan

### 0.1 Commits on `chore/electron-42` (local, not pushed)

| Commit | Content |
|---|---|
| `0e61d97` | First-pass dependency refresh (§2) — Electron 44, vitest 4, jspdf 4, focus-trap 8, jsdom 29, … |
| `6ea4998` | Audit-18 remediation + Filo logo/icon (unrelated to deps; split out so the dep diff stays reviewable) |
| `6fd57b1` | **`svelte` pinned to exactly `5.57.0`** — fixes a regression the first pass introduced (§0.2) |
| `2479391` | TypeScript 5.9 → **6.0.3** (`~6.0.3`) + `declare module '*.css'` in `src/renderer/shims.d.ts` |
| `58f7613` | Vite 6 → **7.3.6**, @sveltejs/vite-plugin-svelte 5 → **6.2.4**; dropped dead `svelte({ hot })` option in `vitest.config.mts` |
| `54ecf43` | vitest + @vitest/coverage-v8 4 → **5.0.1** (no test/config changes needed) |

### 0.2 REGRESSION FOUND AND FIXED — Svelte 5.57.1 phantom write on document open

Found by a real-app Electron smoke test, which `ci:verify` cannot catch. A CRLF note
(`---\r\ntitle: Notes\r\n…---\r\n# Hello\r\n\r\nSome **bold** text.\r\n`) was **rewritten on disk just by
opening it** in a Document tab, with its body flipped to LF (`# Hello\n\nSome **bold** text.\r\n`). The
renderer also logged 16–20 `effect_update_depth_exceeded` errors.

- Bisected per version in the built app: **5.55.7 … 5.57.0 leave the file byte-identical; 5.57.1 rewrites it.**
  The first pass had raised the floor to `^5.57.1` for advisories that are all fixed in 5.55.7.
- Fix: `"svelte": "5.57.0"` (exact). All four svelte advisories stay cleared.
- **Still open (pre-existing, every version):** 2 × `effect_update_depth_exceeded` on document open —
  an effect cycle in Filo's own code (DocumentEditor / hydrate path). On 5.57.0 it causes no disk
  write, but it is what 5.57.1 amplified into data loss. **Fix the cycle before relaxing the pin** (a
  follow-up task has been queued). Do not let Renovate/`npm update` bump svelte past 5.57.0 until then.
- Lesson: add a permanent E2E spec "CRLF doc opens → bytes unchanged, zero effect_update_depth errors".
  The unit suite can't see this; only the built Electron app can.

### 0.3 Verification done in this pass

- `ci:verify` green after each step (4711 unit + 1 skipped, 349 guard tests, 47 gates). Lint is **24**
  warnings (not 48 — §1 counted from an older commit), unchanged by every upgrade.
- **Electron 44 real-app smoke** (Playwright, built app, stubbed folder dialog): Electron 44.4.5 / Node
  24.21 / Chrome 152; vault opens; `filo://media/…` image renders; HTTP Range → `206` +
  `Content-Range: bytes 0-7/70`; `filo://media/.filo/…` → `403`; context isolation intact (`require`
  undefined, `window.filo` present); Document editor renders the Markdown.
- **E2E suite** (`--workers=1`): **8 passed / 34 failed / 4 skipped — identical to the Audit-15
  baseline.** 28 of the 34 are the known harness gap (`import('/src/renderer/…')` needs a Vite dev server);
  the rest are stale selectors (e.g. "Open Project" text) and axe↔Electron `Target.createTarget`.
  **Run E2E serially:** with default parallel workers the instances fight over the shared
  `%APPDATA%\Electron` userData + single-instance lock and ~30 tests "fail" at launch.
- **Coverage** (`test:unit:coverage`): branches **67.26% < 80% threshold — already failing on vitest 4**
  (§3.7 never ran it). Not caused by any upgrade; retune or add tests (thresholds are documented as
  ratchet-up only, so that's your call).
- Load-sensitive flakes: `recoverySnapshot*`, `fileWatcherStop`, `audit17Phase3` hit the 5 s timeout when
  several `ci:verify` runs share the machine; pass alone. Consider a larger `testTimeout` for them.

### 0.4 Still NOT verified (needs a human, or a later session)

- `npm run dev` (Vite 7 + plugin-svelte 6 dev server + HMR inside the Electron window).
- `npm run package` → NSIS installer install + launch (electron-builder 26 × Electron 44).
- Native dialogs by hand, OS drag-and-drop of a file onto a Mind Map, spellcheck, `mailto:`/`https:`
  links, quit-with-pending-edits drain, PDF export output (jspdf 4), keyboard-only modal focus return
  (focus-trap 8), Kanban/Task drag (svelte-dnd-action 0.9.79). Checklist in §3.1/§3.3/§3.5/§3.6.
- §3.2 dialog `defaultPath` — confirmed real (Electron 44 typings: no `defaultPath` → Downloads). Left as a
  product decision. Suggested: attachment picker → vault root (`vaultRegistry.currentVaultPath`), vault
  picker + export → Documents. Note: `dialog.ipc.ts`/`export.ipc.ts` are unit-tested with an `electron`
  mock that has no `app`, so use `vaultRegistry`/`os` or extend those mocks.

### 0.5 Remaining upgrades — what's left and why

| Package | Now | Latest | Verdict |
|---|---|---|---|
| svelte | 5.57.0 (pinned) | 5.57.1 | **Blocked** on the effect-cycle fix (§0.2) |
| TipTap + tiptap-markdown | 2.27.3 / 0.8.10 | 3.31.3 / 0.9.0 | Planned migration (§0.6) — clears the last 37 advisories |
| zod | 3.25.76 | 4.6.5 | Planned migration (§0.7) |
| vite / vite-plugin-svelte | 7.3.6 / 6.2.4 | 8.3 / 7.3 | Wait: needs electron-vite 6 (beta only) + Rolldown config rewrite |
| typescript | 6.0.3 | 7.0.2 | Wait: typescript-eslint caps `<6.1.0`; svelte-check `^5‖^6` |
| jsdom / js-yaml / nanoid | 29 / 4.3 / 5.1 | 30 / 5 / 6 | Skip — no benefit (§4.4) |

### 0.6 TipTap 2 → 3 migration plan (≈1.5–2 days) — supersedes §4.2 where they differ

**Pre-work on v2 (write these first, they are the safety net):**
1. Golden-corpus body round-trip test: `.md` fixtures covering tables, task lists, nested lists, inline
   HTML spans, `#tags`, blank-line paragraphs, CRLF, and docs **ending in a heading / list / table / code
   block**; assert load → `getMarkdown()` is byte-identical. *No existing gate checks body bytes —
   `ci:frontmatter-invariant` covers frontmatter only.* Add a CI gate that pins this test's existence.
2. "Loading a file does not emit an update" test using the real `createTiptapEditor` (not a mock).
3. Assert `isLossyMarkdownRoundTrip` flags no corpus file.
4. The §0.2 E2E (CRLF doc open → bytes unchanged).

**Breaking changes that apply (verified against code):**
- **`setContent(content, false)` → phantom write (silent data loss).** v3's 2nd arg is an options object
  with `emitUpdate` defaulting to **true**. Fix `markdownSync.ts:197` → `setContent(x, { emitUpdate: emit })`.
  `npm run check` catches the production site, but **`src/tests` is excluded from `tsconfig.json`**, and
  `markdownSync.test.ts:342-364` mocks `setContent(body, emit: boolean)` — it would keep passing after a
  wrong fix. Update the mock to assert `{ emitUpdate: false }`.
- **StarterKit now bundles TrailingNode, Link, Underline, ListKeymap.** TrailingNode appends an empty
  paragraph after a trailing heading/list/table/code block, which `ParagraphWithBlankLines` serialises
  as an extra `\n` → **every such file gains a blank line on next save.** Set `trailingNode: false`,
  `link: false`, `underline: false` in **both** StarterKit configs (`createEditor.ts:181` main editor and
  `:289` label editor — otherwise labels start auto-linking URLs).
- **TextStyle `mergeNestedSpanStyles` defaults to true** — with `html: true`, nested `<span style>` in a
  `.md` gets merged on parse (inline-HTML byte drift). Set `false` on the `FontSize`/TextStyle extension.
- Named exports only (`import { TextStyle } …`); `@tiptap/extension-text-style@3` has no default export.
  Old package names (`extension-placeholder`, `-table-*`, `-task-*`) still publish at 3.31.3 — moving to
  `@tiptap/extension-list` / `@tiptap/extensions` is optional.
- Undeclared deps: `@tiptap/extension-paragraph` (`createEditor.ts:3`) and `@tiptap/pm` are imported but
  not in `package.json` — add both explicitly when bumping.
- Custom `Tag` mark (`tagExtension.ts`) uses `mergeAttributes` — the function patched by
  GHSA-cp6q-959q-f8rh; re-run its tests.

**tiptap-markdown risk:** 0.9.0 (Sep 2025) is the **last release**; its README says it is unmaintained and
points to the official `@tiptap/markdown`. Filo reads its internals (`storage.markdown.parser.md`,
`getMarkdown`, extension-storage `serialize` hooks). Options, in order of preference:
(a) move to 0.9.0 and verify those internals still work (not yet confirmed); (b) **vendor/fork** it
(~1k lines over markdown-it + prosemirror-markdown) to keep the current serializer under our control;
(c) port to `@tiptap/markdown` — different serializer, requires rewriting `ParagraphWithBlankLines`, the
Tag serializer and HTML mode. Not recommended now.

**Sequence:** pre-work tests → bump all `@tiptap/*` + tiptap-markdown together → imports → `setContent`
+ test mock → StarterKit flags + `mergeNestedSpanStyles` → corpus diff + `markdownSync*` /
`markdownHtmlMode` / `emptyParagraphs` / `documentEditor*` tests → `ci:verify` → real-app smoke
(DocumentEditor + TextTile, CRLF + LF files, bytes unchanged on open).

### 0.7 Zod 3 → 4 migration plan (≈1 day) — supersedes §4.1 where they differ

**Inventory (verified):** 16 source files import bare `'zod'`. 274 `.default(` calls, almost all scalar
(unaffected). **25 object `.default({})` sites over schemas with inner defaults**
(`board.ts:413,494,536,558`; `connection.ts:85`; `frame.ts:76`; `layoutTemplate.ts:73`;
`project.ts:51,56`; `settings.ts:161-164,171,172,179,180,187,216,230,306-310`). The 7 `z.record().default({})`
sites and 23 `.default([])` are fine semantically. `.passthrough()` ×89, `.strict()` ×4, `ZodTypeAny` ×5,
`ZodIssueCode.custom` ×5, `preprocess` ×2, `discriminatedUnion` ×3, `superRefine` ×2. None of:
`.format/.flatten/errorMap`, single-arg `z.record`, `.email/.url`, `nativeEnum`, `.merge`, `deepPartial`.

**Breaking changes that apply:**
- `.default({})` no longer applies inner defaults (confirmed: v3 `{s:{a:1,b:true}}` vs v4 `{s:{}}`).
  **Correction to §4.1:** it's not silent — v4 types `.default()` as the full output type, so all 25 sites
  fail `npm run check` (and `ci:type-casts` blocks cast-silencing). Fix: `.prefault({})`.
- **Missed in §4.1 — shared default objects.** In core 4.0 two `parse({})` calls return the *same* array
  for `.default([])` (mutation leaks between boards/settings). Upstream now shallow-clones; confirm on
  4.6.5, and use getter defaults `.default(() => [])` for mutable values regardless (the clone is shallow —
  `project.ts:56` nests arrays).
- Error wording changes, and a bad discriminator loses its "expected one of …" detail;
  `boardLoader.ts:536` shows `issues[].message` to users → recovery toast gets vaguer. Optionally rebuild
  a friendly message there. No test asserts built-in Zod text (custom `superRefine` messages survive).
- Compile-only: `ZodTypeAny` → `z.ZodType`; `ZodIssueCode.custom` → `'custom'`; make `optionalNumber`
  generic (`<T extends z.ZodType>(inner: T)`) or 7 call sites widen to `unknown`.
- Number semantics (±Infinity rejected, `.int()` safe-ints only) — already guarded by 95 `.finite()` calls.
- **Correction to §4.1:** "passthrough gains an index signature" — v3 already has it.

**Incremental `zod/v4` subpath migration is NOT viable:** the subpath in 3.25.76 is core 4.0.0 (no clone
fix), v3 schemas can't be nested in v4 ones, and `schemaUtils → settings → board → boardFile/project/tile`
all import each other, so the renderer `schema/` folder must move in one step. Install `zod@4.6.5`
directly and keep bare `'zod'` imports.

**Sequence:** on v3 first — snapshot `parse({})` for `ProjectSettingsSchema` + every board-type settings
schema; assert every mutable default is a fresh object per parse; snapshot a representative
`V7BoardFileDataSchema` parse → bump → `npm run check` enumerates the 25 sites → `.prefault` + getter
defaults → type fixes → `ci:verify` (esp. `boardRoundTrip.property`, `randomOpsNoOrphans.property`,
`settingsRoundTrip`) → snapshots must be unchanged.

### 0.8 Recommended order from here

1. **Before 2026-10-20 (Electron 42 EOL — only relevant if you ship 42 builds):** do the §0.4 manual
   checks and a `npm run package` install test on Windows.
2. Fix the effect cycle (§0.2), add the CRLF-open E2E, then relax the svelte pin.
3. TipTap 3 (§0.6) — security + unmaintained-dependency pressure; highest value.
4. Zod 4 (§0.7) — lower urgency, no advisories.
5. Revisit Vite 8 / TS 7 when electron-vite 6 and typescript-eslint support land.

---

*(First-pass report follows, unchanged.)*

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

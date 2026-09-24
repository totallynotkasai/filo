# Audit Remediation Plan — 2026-05-29

**Source:** Independent critical audit (data integrity, correctness/state, IPC/security, UI/UX).
**Verdict:** Overall ~8/10. Data-integrity and security marks are largely deserved; correctness/state and UI/UX are ~7.5. No high-severity data-loss path found. Baseline is green: type-check, lint, build, 2,873 unit tests, and all 21 CI gates pass.

**Legend:** `[V]` = location verified against source during the audit. `[A?]` = agent-reported; verify before acting.

---

## Findings recap

| ID | Severity | Area | Summary |
|---|---|---|---|
| H1 | High | UI/UX | Escape on a ConfirmDialog stacked over a Modal closes both layers. |
| M1 | Medium | Security | `send` bypasses the Zod payload validation that `invoke` enforces. |
| M2 | Medium | UI/UX | Bare `n` shortcut registered by both Kanban and Task List; wrong pane wins in split view. |
| M3 | Medium | Security | `vault:watch` can self-register an arbitrary directory when no vault is open. |
| L1 | Low | Data integrity | Dead/misleading code in `frontmatterSync` (comment falsely claims in-place mutation). |
| L2 | Low | Maintainability | `FrontmatterSchema` is exported and tested but never wired into production; its `.transform()` mutates data. |
| L3 | Low | Interop | YAML comments/formatting lost on frontmatter rewrite (js-yaml load→dump). |
| L4 | Low | Security/UI | No header-level CSP; context-menu viewport clamp is approximate; tile-header buttons lack `:focus-visible`. |
| C-1 | Cruft | Repo | 198 KB junk file `C:UsersandreMy` at repo root. |
| C-2 | Cruft | Repo | 8 stale planning/audit docs accumulating at root + `docs/`. |
| C-3 | Tech debt | Maintainability | 8 files exceed the 1000-LOC cap (worst: `TaskListBoard.svelte` 2245). |

---

## Phasing principle

Ordered by risk-adjusted value: zero-risk cleanup first, then the one user-facing bug, then security, then interaction correctness, then decisions/polish, with tech debt as a separate non-blocking track. **Every phase must leave the app runnable and `npm run ci:verify` green** (CLAUDE.md phase-boundary rule). Phases 0–3 are independent and can ship as separate small PRs.

---

## Phase 0 — Zero-risk cleanup (~30 min, no behavior change)

| ID | Change | Files |
|---|---|---|
| C-1 | Delete the junk file | `C:UsersandreMy` (repo root) |
| L1 `[V]` | Remove dead lines 241–242 and fix the false "applyCanonical mutates in place" comment; keep line 244's correct assignment | `src/renderer/lib/vault/frontmatterSync.ts:240-244` |
| L4c `[V]` | Add a `:focus-visible` outline to `.header-btn` (use existing CSS ring tokens) | `src/renderer/components/tiles/TileHeader.svelte:696-722` |

- **Acceptance:** `npm run ci:verify` green; tabbing through a selected tile shows a focus ring.
- **Risk:** none. **Rollback:** trivial.

---

## Phase 1 — Fix the user-facing bug (H1) (~1–2 hr)

**H1 `[V]` — Escape closes a stacked ConfirmDialog and the modal under it.**

- **Primary fix:** add `e.stopPropagation()` to the Escape branch in `src/renderer/components/shared/ConfirmDialog.svelte:88-91` so the keydown never reaches the global `app:cancel`.
- **Defense-in-depth:** make `app:cancel` layering-aware in `src/renderer/components/layout/AppShell.svelte:356-359` — close only the topmost in order `confirmDialog → activeModal → contextMenu`.
- **Sweep the same pattern:** add `stopPropagation` to the Escape handlers in `src/renderer/components/shared/Modal.svelte:101-106` and the `TaskItem` notes textarea (benign today, same root cause).
- **Test:** Vitest/jsdom test dispatching `Escape` with both `confirmDialog` and `activeModal` set, asserting only the confirm closes. Optional Playwright E2E: Project Settings → trigger confirm → Escape → Settings still open.

- **Acceptance:** new test passes; manual repro fixed; a lone modal still closes on Escape.
- **Risk:** low — verify `stopPropagation` doesn't suppress an intended Escape elsewhere.

---

## Phase 2 — Security hardening (M1, M3) (~half day)

**M1 `[V]` — `send` bypasses `validateIpcPayload`.**
1. `grep` all `window.filo.send(` call sites to enumerate the real push channels (likely just `app:ready-to-quit` / `app:flush-and-quit`).
2. Add a narrow `SendChannel` union (subset of `IpcChannel`) in `src/shared/types.ts` and type `send` against it.
3. Run args through `validateIpcPayload` in the `send` wrapper at `src/main/preload.ts:54-56`, symmetric with `invoke`.
4. Confirm `ci:ipc-parity` still passes.

**M3 `[A?]` — `vault:watch` can self-register an arbitrary directory.**
1. **Verify first:** read `src/main/ipc/vault.ipc.ts:456-510` and `vault:add-recent` (`~:872-890`) to confirm the no-vault self-register path.
2. If confirmed: require the watched path to match an entry the app actually opened (recent-vaults / the open flow), or gate self-register behind the existing open-vault handshake rather than accepting any stat-able directory.
3. **Test:** `vault:watch` on an unknown directory with no active vault is rejected.

- **Acceptance:** new tests + all 21 CI gates green.
- **Risk:** medium — trace `openVault` before tightening `vault:watch` so the legitimate first-open sequence still works.

---

## Phase 3 — Interaction correctness (M2) (~2–3 hr)

**M2 `[V]` — duplicate bare-`n` shortcut across board types.**

- Add an active-pane guard so each board's `n` handler early-returns unless its board is the focused pane's board — `src/renderer/components/boards/KanbanBoard.svelte:789` and `src/renderer/components/boards/TaskListBoard.svelte:1300` (use the workspace/active-pane store).
- **While here:** audit other bare-key global bindings in `src/renderer/core/hotkeys.ts` for the same multi-pane collision; consider calling the existing `findBindingConflict` at registration time, not just in the rebind UI.
- **Test:** simulate two mounted boards + `n`, assert it targets the active pane.

- **Acceptance:** test passes; manual split-pane check. **Risk:** low.

---

## Phase 4 — Decisions & polish (L2, L3, L4a/b) (~half day; some are choices)

- **L2 `[V]` — `FrontmatterSchema` (dead).** *Recommend: delete it* + its `sprintCSchemaBounds` cases + the `src/renderer/schema/index.ts` export. Wiring it into the real read path is a larger refactor, and its data-mutating `.transform()` (lowercases `status`, coerces `completed`, reformats dates) is a footgun if adopted carelessly. Keep only if there is a near-term plan to replace `FIELD_READERS`.
- **L3 `[V]` — YAML comments lost on rewrite.** *Recommend: document as a known limitation now* (CLAUDE.md "Common Gotchas"). Invest in comment preservation (the `yaml` package's `Document` API, or diff-and-patch only changed keys) only if Obsidian round-trip fidelity becomes a priority — that is a meaningful rewrite of `src/renderer/lib/editor/markdownSync.ts:261`.
- **L4a — header-level CSP.** Add `session.defaultSession.webRequest.onHeadersReceived` in `src/main/main.ts` to enforce CSP at the header level (belt over the existing `<meta>` tag), covering `filo://` responses and workers. Verify media + iframes still load afterward.
- **L4b — context-menu clamp.** In `ui.svelte.ts` `showContextMenu`, measure the actual rendered `menuEl` height post-mount instead of the `items.length * 32` estimate, then reposition if it overflows the viewport bottom.

- **Acceptance:** CI green; if L4a lands, confirm `filo://` images/video and iframes still load.

---

## Phase 5 — Long-term maintainability (non-blocking track)

Not required to daily-drive; schedule separately.

- **C-3 file-size debt:** the 8 allowlisted files, worst `TaskListBoard.svelte` (2245 LOC), `vaultExternalChanges.ts` (1530), `vault.svelte.ts` (1425). Shard by concern (the `scripts/check-file-sizes.mjs` allowlist comments already sketch the seams, e.g. `sectionDragController`, `taskLifecycle`). Each split must update the `ci:file-sizes` allowlist and keep tests green.
- **C-2 doc consolidation:** archive superseded audit/remediation plans into `docs/archive/` so the root stops accumulating stale plans.

---

## Cross-cutting conventions (apply in every phase)

- Add/extend unit tests in `src/tests/unit/` mirroring `src/` structure — this repo expects test coverage with each change.
- Run `npm run ci:verify` at each phase boundary (lint → check → strict tests → build → 21 gates).
- No `as any` / `as unknown as` without `// allow-cast:`; route any new persisted state through the vault, not `localStorage`.

## Suggested sequencing

`0 → 1 → 2 → 3` are independent and can ship as separate small PRs. Phase 4 items are independent of each other. Phase 5 is background work.

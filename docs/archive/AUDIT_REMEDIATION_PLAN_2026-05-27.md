# Audit Remediation Plan — 2026-05-27

Independent audit (separate from `IMPLEMENTATION_PLAN.md`) covering findings the prior audits and remediations missed. Each item was verified by reading the actual file:line cited.

This plan distinguishes:

- **Architectural refactors** that close a *class* of bug (multiple findings collapse into one fix) and prevent recurrence via either type-level guarantee or new CI gate.
- **Point fixes** that close a specific bug. No structural change.

Recurrence is the key criterion: every P0 in this audit existed because a feature was added without an enforced invariant. The refactor phases lift each missed invariant into the primitive that owns it.

## Goals

1. Close all five P0s (silent data loss / silent dismissal) before the user starts using Filo for real notes.
2. Eliminate the *class* of bug for the three architectural P0s, not just the instances.
3. Leave the app shippable at every phase boundary.

## Non-goals

- New features. Same as the prior plan: no command palette, no plugin system, no new tile/board types.
- Bundle splitting beyond what the prior plan already deferred.
- Replacing the existing IMPLEMENTATION_PLAN.md. This plan complements it; the items in this plan are not in the prior plan.

## Dependency graph

```
Phase A (parallel)          Phase E (parallel)          Phase F (parallel)
├── A.1 drift primitive     ├── E.1 nav gates           ├── F.1 resize keyboard
├── A.2 modal close cycle   ├── E.2 prod CSP            ├── F.2 picker focus
├── A.3 watcher coupling    ├── E.3 tags envelope       ├── F.3 live-region
└── B.1 MoveFrame fix       └── E.4 font blob           └── F.4 recovery cap

         ↓
Phase C (HostPath newtype) ──── independent ──────────► Phase G (hygiene/perf)

         ↓
Phase D (command undo discipline — big, defer if needed)

         ↓
Phase H (CI gates encoding the invariants — runs after the matching phase lands)
```

## Recommended sequence

| Sprint | Phases | Duration | Outcome |
|---|---|---|---|
| 1 | A.1 + A.2 + A.3 + B.1 + E.1 + E.2 | ~1 week | **All P0 data-loss closed. Daily-driver safe.** |
| 2 | E.3 + E.4 + C.1 + F.1 | ~4 days | Security + a11y P1s closed |
| 3 | F.2 + F.3 + F.4 + G.7 + G.8 | ~3 days | Polish + perf hotspots |
| 4 | D.1 + H.3 | ~1.5 weeks | Command discipline refactor + gate |
| 5 | G.1–G.6 + H.1 + H.2 | ~2 days | Hygiene + remaining gates |

Total: **~3–4 weeks** for the full plan; **~1 week** to be daily-driver-safe.

---

## Phase A — Critical refactors (close P0s + their bug-class)

These three refactors collectively close P0-1, P0-2, P0-3, and P0-5 — four of the five P0s found. Each is also the *only* way to prevent the same class of bug from recurring as new features land.

### A.1 — Unified drift-aware write primitive

**Closes:** P0-1 (miscWriteScheduler no drift), P0-2 (config baseline not seeded at load), and prevents future schedulers from missing drift.

**Root cause:** Drift detection was added piecemeal to individual schedulers. `boardWriteScheduler` got the write-side check, `configWriteScheduler` got write-side only, `miscWriteScheduler` got nothing. The `noteBaseline` registry is fed by writers (post-write) but not consistently by loaders. The contract "every disk-write must drift-check against a baseline, and the baseline must be seeded when state is hydrated" isn't enforced.

**Refactor shape:**

1. Lift drift-checking + baseline-stamping into `createScheduler()`. New options:
   ```ts
   interface CreateSchedulerOptions<TArgs> {
     // ... existing fields ...
     /**
      * Returns the baseline-comparison path + payload for drift check, or
      * null to skip drift (e.g. for in-memory-only writes). Schedulers
      * supplying this hook get pre-write stat+baseline comparison + post-write
      * noteBaseline stamping for free.
      */
     driftCheck?: (args: TArgs) => { vaultRoot: string; relPath: string } | null;
   }
   ```
2. Inside the scheduler's `performWrite` wrapper:
   - If `driftCheck(args)` returns non-null, call `getBaseline(relPath)`.
   - If baseline is defined, `invokeOk('vault:stat', vaultRoot, relPath)`, compare `stat.mtimeMs !== baseline`.
   - Mismatch → emit `notifyWriteError({ kind, path, error: EXTERNAL_EDIT })` + add to `failed[]` + abort write.
   - Match → proceed; post-write stamp `noteBaseline(relPath, postStat.mtimeMs)`.
3. Make `miscWriteScheduler`, `configWriteScheduler`, and `frontmatterWriteScheduler` provide `driftCheck`.
4. Add baseline seeding to `vaultCandidate.ts:loadVaultCandidate`:
   - After loading `appearance.json` / `app.json` / `defaults.json` / `workspace.json`, call `invokeOk('vault:stat', ...)` on each and `noteBaseline` the mtime.
   - Same for `.filo/tags.json`, `.filo/viewports.json`, `.filo/hotkeys.json`, `.filo/sidebar-order.json`, and every `.filo/themes/*.json` / `.filo/templates/*.json`.

**Files:**

- [src/renderer/lib/boards/writeScheduler.ts](src/renderer/lib/boards/writeScheduler.ts) — extend `CreateSchedulerOptions` + `performWrite` wrapper.
- [src/renderer/lib/boards/miscWriteScheduler.ts](src/renderer/lib/boards/miscWriteScheduler.ts) — supply `driftCheck`.
- [src/renderer/lib/boards/configWriteScheduler.ts](src/renderer/lib/boards/configWriteScheduler.ts) — move per-target drift check into the new primitive; delete the inline `getBaseline` block at lines 266–285.
- [src/renderer/lib/boards/frontmatterWriteScheduler.ts](src/renderer/lib/boards/frontmatterWriteScheduler.ts) — supply `driftCheck`.
- [src/renderer/lib/boards/boardWriteScheduler.ts](src/renderer/lib/boards/boardWriteScheduler.ts) — switch from inline check to primitive-supplied; delete the inline block.
- [src/renderer/lib/vault/markdownFileWriter.ts](src/renderer/lib/vault/markdownFileWriter.ts) — already correct via `markHydrated` + `noteBaseline`, but verify consolidation.
- [src/renderer/lib/vault/vaultCandidate.ts](src/renderer/lib/vault/vaultCandidate.ts) — add baseline-seeding sweep after each config-load IPC.

**Tests:**

- `src/tests/unit/driftAwareWritePrimitive.test.ts` (NEW)
  - Each scheduler's drift hook is wired and fires the abort+failed path on mtime mismatch.
  - Baseline-seeding test: `loadVaultCandidate` populates the baseline for every config file kind.
  - Misc scheduler: external edit to `.filo/tags.json` between load and save aborts the write and surfaces the failure in `flushAllMisc().failed[]`.
- Existing `fileBaselineDrift.test.ts` extended with one new case per scheduler.

**Parity risks:**

- The `lastWrittenConfigs` payload-dedup cache in `configWriteScheduler` is orthogonal to the drift check — keep both. Payload-dedup catches no-op saves; drift catches external edits.
- `frontmatterWriteScheduler` writes via the markdown-file pipeline, so the drift check for it may be redundant if `markdownFileWriter` already covers the same baseline. Resolve by audit at implementation time — pick exactly one owner per file path.
- The misc bucket includes `viewports.json` which is touched on every pan/zoom. The drift check fires `vault:stat` IPC on every flush — coalesce into the existing 300 ms debounce so it's at most ~3 IPC calls per second.

**Size:** ~150 LOC primitive change + ~80 LOC sweep + ~150 LOC tests. **~2 days.**

**Acceptance:**

- New unit tests pass.
- Manual smoke: edit `.filo/tags.json` externally while Filo is open → save in Filo → abort + toast.
- Manual smoke: edit `appearance.json` externally → change theme → abort + toast.
- `npm run ci:verify` green.

---

### A.2 — Modal close cycle (async openModal)

**Closes:** P0-3 (modal stack overwrite silently dismisses unsaved settings).

**Root cause:** [src/renderer/stores/ui.svelte.ts:217](src/renderer/stores/ui.svelte.ts:217) — `openModal(id) { activeModal = id; }` overwrites without firing the previous modal's `beforeClose`. The Modal component's `$effect` at [Modal.svelte:64-71](src/renderer/components/shared/Modal.svelte:64) reacts by calling `dialogEl.close()` directly, bypassing `tryClose()`. Any modal pair where the user can open #2 while #1 is dirty is a silent dismissal.

**Refactor shape:**

```ts
// ui.svelte.ts
let pendingCloseHandlers = new Map<string, () => Promise<boolean>>();

export const uiStore = {
  // ...
  registerCloseHandler(id: string, fn: () => Promise<boolean>) {
    pendingCloseHandlers.set(id, fn);
  },
  unregisterCloseHandler(id: string) {
    pendingCloseHandlers.delete(id);
  },
  async openModal(id: string) {
    if (activeModal && activeModal !== id) {
      const handler = pendingCloseHandlers.get(activeModal);
      if (handler) {
        const ok = await handler();
        if (!ok) return false;
      }
    }
    activeModal = id;
    return true;
  },
  // ...
};
```

The Modal component registers its `beforeClose` on mount via `registerCloseHandler(id, beforeClose)` and unregisters on unmount. `openModal` becomes async and returns whether the open succeeded; callers that care await the result.

**Files:**

- [src/renderer/stores/ui.svelte.ts](src/renderer/stores/ui.svelte.ts) — async `openModal`, close-handler registry.
- [src/renderer/components/shared/Modal.svelte](src/renderer/components/shared/Modal.svelte) — register/unregister `beforeClose` if supplied.
- Every call site of `uiStore.openModal(...)` — currently sync — review whether the call should `await` the result or fire-and-forget. Most are fire-and-forget UI affordances and the void return is fine. The ones to audit: toast actions that open modals (recovery toast), keyboard-shortcut openers, programmatic opens from save-error paths.

**Tests:**

- `src/tests/unit/modalCloseHandshake.test.ts` (NEW)
  - Open modal A with a `beforeClose` returning `false` → `openModal('B')` resolves `false`, A stays open.
  - Open modal A with no `beforeClose` → `openModal('B')` resolves `true`, B is active.
  - Open modal A with `beforeClose` resolving `true` → switch succeeds.
  - Concurrent `openModal('B')` and `openModal('C')` — the second one queues behind the first's `beforeClose`.

**Parity risks:**

- The IMPLEMENTATION_PLAN.md Phase 1.1 adds a `beforeClose` to ProjectSettings. Land A.2 first; otherwise that fix is a no-op for the modal-stack path.
- `closeModal()` becomes structurally equivalent to `openModal(null)` — keep both as named exports for clarity.
- Test races: any test that does `uiStore.openModal('a'); uiStore.openModal('b');` synchronously will now need `await`. Sweep test files.

**Size:** ~40 LOC ui store change + ~20 LOC Modal change + ~30 LOC test. ~30 callsite audits (most no-op). **~1 day.**

**Acceptance:**

- Manual: open Project Settings → edit a value → click an entry in the sidebar that triggers any other modal → confirm prompt → cancel returns to Settings with edits intact.
- `npm run ci:verify` green.

---

### A.3 — Watcher reconnect ↔ suppression coupling

**Closes:** P0-5 (phantom external-edit toast on user's own writes after watcher reconnect).

**Root cause:** Two state machines operate independently — main-side `WatcherSupervisor` (1s→5s→30s→300s backoff per memory) and renderer-side `recentSelfWrites` (1500/5000ms TTL). If the watcher reconnects after >5s, post-reconnect events for the user's own recent writes are mis-classified as external because the suppression TTL has expired.

**Refactor shape:**

Two options:

**Option A (recommended) — Renderer extends suppression during reconnect.** The renderer listens for `vault:watcher-state = 'reconnecting'` and extends every active `recentSelfWrites` entry's TTL to "now + reconnect-window-budget" (say, 30s) for the duration of the reconnect. On `state = 'active'` events, the TTLs return to normal.

```ts
// writeStateTracking.ts
let watcherReconnectExtension = 0; // ms added to TTL while reconnecting

export function setWatcherReconnectExtension(ms: number): void {
  watcherReconnectExtension = ms;
}

export function isRecentSelfWrite(p: string): boolean {
  const t = recentSelfWrites.get(brand(p));
  if (t === undefined) return false;
  const ttl = SELF_WRITE_TTL_MS + watcherReconnectExtension;
  return Date.now() - t < ttl;
}
```

```ts
// vault.svelte.ts watcher-state listener
window.filo.on('vault:watcher-state', (_event, payload) => {
  if (payload.state === 'reconnecting') {
    setWatcherReconnectExtension(30_000);
  } else if (payload.state === 'active') {
    setWatcherReconnectExtension(0);
  }
});
```

**Option B — Main buffers events through reconnect and replays them with corrected timestamps.** Heavier; the renderer's TTL math stays unchanged but the main process now needs a persistent event buffer through the reconnect. Not recommended unless A is shown to be insufficient.

**Files:**

- [src/renderer/lib/boards/writeStateTracking.ts](src/renderer/lib/boards/writeStateTracking.ts) — add the extension knob; update `isRecentSelfWrite` to consult it.
- [src/renderer/stores/vault.svelte.ts](src/renderer/stores/vault.svelte.ts) — wire the `vault:watcher-state` listener (already present per Phase 3) to call the new extension setter.

**Tests:**

- `src/tests/unit/watcherReconnectSuppression.test.ts` (NEW)
  - With `watcherReconnectExtension = 0`, an event 6s after a self-write is classified external.
  - With `watcherReconnectExtension = 30000`, the same event is suppressed.
  - Transition `reconnecting` → `active` zeroes the extension.

**Parity risks:**

- The 30s extension is a heuristic — too long means external edits during reconnect get suppressed incorrectly; too short means the bug recurs. The backoff cap is 300s (5min) so 30s covers the first three retry windows. If the reconnect takes >30s, the user is in deep watcher trouble already (filesystem unmount, etc.) and the external-edit prompt is a reasonable consequence.
- If the supervisor's state-broadcast IPC is slow, the renderer may receive `reconnecting` AFTER the event for the missed write has already arrived. Verify by integration test — may need to extend the TTL retroactively for in-flight events too, or have main buffer events for the first 100ms post-reconnect.

**Size:** ~30 LOC change + ~50 LOC test. **~half a day.**

**Acceptance:**

- Unit tests pass.
- Manual: kill the renderer process's fs.watch handle (or use a vault on a network drive that flaps) and observe that user typing doesn't surface phantom external-edit toasts.

---

## Phase B — Critical point fix (data loss)

### B.1 — `MoveFrameCommand` undo restoration

**Closes:** P0-4. Point fix; the broader command-undo discipline refactor (Phase D) lands later.

**Files:**

- [src/renderer/commands/frameCommands.ts:151-162](src/renderer/commands/frameCommands.ts:151)

**Change:**

```ts
execute() {
  this.applyTo(this.afterPos, this.beforePos);
  // After execute, store the post-move containment (live-recomputed) so
  // a subsequent undo can restore back to the pre-move snapshot AND
  // a redo can restore to the post-move snapshot.
  if (!this.afterTileIds) {
    framesStore.updateContainment(this.frameId);
    const frame = boardStore.frames.find(f => f.id === this.frameId);
    this.afterTileIds = frame ? [...frame.tileIds] : [];
  } else {
    framesStore.setContainment(this.frameId, this.afterTileIds);
  }
}

undo() {
  this.applyTo(this.beforePos, this.afterPos);
  // Restore the EXACT containment snapshot taken at construction, not
  // a live recompute (which would pick up tiles added or removed since).
  framesStore.setContainment(this.frameId, this.containedTileIds);
}
```

Requires a new `framesStore.setContainment(frameId, tileIds)` method that bypasses the geometry recompute and writes the array directly to the frame's `tileIds`.

**Tests:**

- `src/tests/unit/moveFrameCommandUndo.test.ts` (NEW)
  - Frame contains [A, B, C]. Drag frame, then add tile D (not in frame), then undo → frame contains [A, B, C], not [A, B, C, D].
  - Frame contains [A, B, C]. Drag frame, then delete tile B, then undo → frame contains [A, C] (the snapshot stale-ID handling per existing convention).

**Parity risks:**

- A tile deleted between execute and undo: the snapshot contains an ID that no longer exists. The existing pattern in other Restore-from-Snapshot commands is to filter out stale IDs at restore time. Match that pattern.

**Size:** ~25 LOC change + ~40 LOC test. **~half a day.**

**Acceptance:** test passes; manual smoke matches expected behaviour.

---

## Phase C — Compositional security refactor

### C.1 — `HostPath` provenance newtype

**Closes:** P1-4 (`vault:copy-file` accepts arbitrary host paths). Prevents future IPC handlers from accepting renderer-fabricated absolute paths.

**Root cause:** `vault:copy-file` accepts `sourcePath: string` for any host-absolute path. Combined with `dialog:open-file` (which legitimately returns absolute paths from a user click) or `dragDrop` (which legitimately returns absolute paths from a user drag), the renderer has a chain to read any file the user can be tricked into clicking. The defence isn't "block the dialog" — that's a real feature — it's "require provenance proof that the path came from a user-blessed source."

**Refactor shape:**

New file `src/shared/hostPath.ts`:

```ts
declare const _brand: unique symbol;
export type HostPath = string & { readonly [_brand]: 'HostPath' };

// Internal — only the privileged constructors below can stamp.
function brand(s: string): HostPath { return s as HostPath; }

/**
 * Brand a path that the OS dialog returned from a user click. Called
 * inside the dialog IPC handler before returning to the renderer.
 */
export function hostPathFromDialog(s: string): HostPath { return brand(s); }

/**
 * Brand a path that the renderer extracted from a DragEvent's
 * dataTransfer.files. The renderer calls this at the drag-handler entry
 * point; the brand serialises across IPC because it's just a string.
 */
export function hostPathFromDragEvent(s: string): HostPath { return brand(s); }
```

IPC payload schemas tighten:

```ts
// ipcSchemas.ts
'vault:copy-file': z.tuple([
  z.string().refine(isBrandedHostPath, 'sourcePath must be a HostPath'),
  // ...
]),
```

But Zod can't statically verify branding because the brand is a phantom type. So instead: define a stricter runtime schema that only accepts strings of a specific shape (e.g., absolute paths that match `^[A-Z]:\\|^/`) AND add a separate audit gate via `check-untrusted-sinks` or a new gate that scans the renderer for `'vault:copy-file'` invokes and requires the source argument to come from a known-blessed function.

The cleanest enforcement is at the TypeScript layer: change the IPC type contract (in `shims.d.ts` / preload bridge declaration) to require `HostPath` for the source arg. Renderer code that passes a raw string fails type-check.

**Files:**

- `src/shared/hostPath.ts` (NEW) — ~30 LOC.
- [src/main/ipc/dialog.ipc.ts](src/main/ipc/dialog.ipc.ts) — wrap `result.filePaths` in `hostPathFromDialog` before return. But since IPC strips brands, the value is a plain string on the renderer side. Instead, accept it as plain and brand it at the renderer entry point.
- [src/renderer/lib/utils/](src/renderer/lib/utils/) — new `hostPath.ts` shim that re-exports the brand and is the only blessed place to stamp. The `dialog:open-file` invoker wraps its result with `hostPathFromDialog`.
- [src/renderer/lib/canvas/dragDrop.ts](src/renderer/lib/canvas/dragDrop.ts) — wrap dropped file paths with `hostPathFromDragEvent`.
- Renderer `invokeOk` signature for `vault:copy-file` — change `sourcePath: string` → `sourcePath: HostPath`.

**Tests:**

- `src/tests/unit/hostPathProvenance.test.ts` (NEW)
  - Type-level: `invokeOk('vault:copy-file', 'literal-string', ...)` fails type-check.
  - Brand round-trip: `hostPathFromDialog('/x')` is assignable to `HostPath`.

**Parity risks:**

- The `font:import` handler also accepts a dialog-returned path internally (line 102). Brand it too.
- Drag-drop sources currently flow through `dragDrop.ts` — sweep every entry point to stamp.

**Size:** ~30 LOC newtype + ~80 LOC sweep + ~50 LOC tests. **~1 day.**

**Acceptance:**

- Type-check refuses raw-string source for `vault:copy-file`.
- Existing flows (drag-drop attachments, font import) still work.

---

## Phase D — Command undo discipline refactor

### D.1 — `SnapshotOnlyContext` on `Command.undo()`

**Closes:** P1-1 (DeleteTilesCommand cross-board connection leak), P1-3 (UpdatePropertiesCommand reads live body), and prevents future versions of P0-4 (MoveFrameCommand containment recompute). Large refactor — defer to its own sprint if Phases A–C alone are sufficient for daily use.

**Root cause:** The pattern "execute snapshots; undo restores from snapshot only" is discipline, not type-enforced. Commands routinely read live `boardStore` / `documentStore` / `framesStore` inside their `undo()` body, and several have been caught restoring stale state because a between-execute-and-undo mutation invalidated the snapshot's assumption.

**Refactor shape:**

```ts
// Command.ts
export interface SnapshotOnlyContext {
  /**
   * Restore the live boardCache to match a snapshot. Routes through the
   * boardCacheStore.replaceCache contract so reactive consumers update.
   */
  restoreCache(boardId: string, snapshot: V7BoardFileData): void;
  /**
   * Restore a document's frontmatter + body without reading any other
   * live store state.
   */
  restoreDocument(docId: string, frontmatter: object, body: string): void;
  /** ...other restore primitives... */
}

export abstract class Command {
  abstract execute(): void | Promise<void>;
  abstract undo(ctx: SnapshotOnlyContext): void | Promise<void>;
  // ...
}
```

The `historyStore.undo()` dispatcher constructs the context and passes it. Concrete commands stop reading `boardStore.getTile(id)` etc. inside undo bodies; instead, the constructor captures everything `undo` needs.

The CI gate `check-command-undo-discipline.mjs` (H.3) scans `undo()` bodies and refuses imports of `boardStore` / `documentStore` / `framesStore` / `boardCacheStore` outside of the `ctx` parameter.

**Files:**

- [src/renderer/commands/Command.ts](src/renderer/commands/Command.ts) — new context type, signature change.
- [src/renderer/stores/history.svelte.ts](src/renderer/stores/history.svelte.ts) — construct and pass ctx; thread through `runChained`.
- **Every command class** under `src/renderer/commands/` — ~20 files. Each `undo()` body needs review: any live-store read becomes a constructor capture.
- `scripts/check-command-undo-discipline.mjs` (NEW, see Phase H.3).

**Tests:**

- `src/tests/unit/commandUndoSnapshotOnly.test.ts` (NEW) — AST walk over `src/renderer/commands/` asserting no `boardStore` / `documentStore` / `framesStore` / `boardCacheStore` imports inside `undo()` method bodies.
- Per-command tests already exist; verify they pass with the new signature.

**Parity risks:**

- Some commands legitimately need to *check* whether a target still exists (e.g., MoveCardCommand checks if the source column was deleted between execute and undo). The context must expose query primitives for these checks without exposing full mutation power.
- The "warn" toast pattern (e.g., MoveCardCommand line 226–231) reads cache state to decide whether to no-op. Provide a `ctx.exists(boardId, id)` query that's read-only.
- Async commands (RenameTitleCommand awaits IPC). The context must remain valid across the await boundary; the dispatcher captures it before the body starts.

**Size:** ~50 LOC base class change + ~600 LOC sweep across commands + ~80 LOC gate + ~150 LOC tests. **~1.5 weeks.**

**Acceptance:**

- New gate at error.
- Manual: trigger every undoable action; verify undo correctness.
- All previous undo tests pass.

---

## Phase E — Security point fixes

### E.1 — Navigation gates in main process

**Closes:** P1-6 (no `setWindowOpenHandler` / `will-navigate` / `setPermissionRequestHandler`).

**Files:** [src/main/main.ts:79–217](src/main/main.ts:79).

**Change:** Inside `createWindow` after `mainWindow = new BrowserWindow(...)`:

```ts
mainWindow.webContents.setWindowOpenHandler(({ url }) => {
  // Deny new-window creation entirely. The app has no use case for
  // popups; external links route through media:open-external (which has
  // its own allowlist).
  void asSafeOpenExternal(url) && /* maybe shell.openExternal in main */;
  return { action: 'deny' };
});

mainWindow.webContents.on('will-navigate', (event, url) => {
  // The renderer's index.html is the only navigation target. Block
  // every other navigation attempt at the main-process level. A
  // compromised renderer trying location.href = 'https://attacker' fails
  // here.
  if (url !== mainWindow.webContents.getURL()) {
    event.preventDefault();
  }
});

mainWindow.webContents.on('will-redirect', (event, url) => {
  if (url !== mainWindow.webContents.getURL()) {
    event.preventDefault();
  }
});

session.defaultSession.setPermissionRequestHandler((_wc, _perm, callback) => {
  // No permission requests should succeed. The app has no use case for
  // camera/mic/geolocation/notifications.
  callback(false);
});
```

**Tests:**

- E2E test in `src/tests/e2e/navigationGates.test.ts` (NEW): inject `window.open('https://example.com')` from the renderer dev console and assert no new window appears.

**Parity risks:**

- DevTools dev path uses `mainWindow.loadURL(ELECTRON_RENDERER_URL)` and may produce hot-reload navigations. Confirm `will-navigate` doesn't block dev hot-reload (it shouldn't — HMR uses WebSocket, not full navigation).

**Size:** ~30 LOC + ~30 LOC test. **~half a day.**

**Acceptance:** `window.open` denied; permission requests denied; `npm run ci:verify` green.

---

### E.2 — Production CSP tightening

**Closes:** P1-7 (CSP `ws://localhost:*` in production).

**Files:** [index.html:6](index.html:6). Better: move CSP to a main-process response-header injection so dev vs prod can diverge cleanly.

**Change:** Strip `ws://localhost:*` from production CSP. Either:

**Option A** — Vite plugin that rewrites the meta CSP per-mode. Cleanest.

**Option B** — Main-process `webContents.session.webRequest.onHeadersReceived` that adds `Content-Security-Policy` to responses, omitting `ws:` in `app.isPackaged`.

Recommended **Option B** because it also covers the `filo://` protocol responses for free.

**Tests:**

- Manual: build packaged, inspect Network panel CSP — confirm no `ws:` in `connect-src`.

**Size:** ~40 LOC. **~half a day.**

**Acceptance:** Packaged build's CSP omits `ws://localhost:*`.

---

### E.3 — `tags.ipc.ts` envelope migration

**Closes:** P1-9 (raw error/path propagation).

**Files:** [src/main/ipc/tags.ipc.ts](src/main/ipc/tags.ipc.ts).

**Change:** Wrap both handlers in try/catch returning `{ ok, code, error, data? }`:

```ts
ipcMain.handle('tags:load', async (_event, vaultRoot: string) => {
  try {
    assertActiveVault(vaultRoot);
    // ... existing logic ...
    return { ok: true, data: await fs.readFile(filePath, 'utf-8') };
  } catch (err) {
    logMainError('tags:load', err);
    return { ok: false, code: ipcErrorCode(err), error: String(err) };
  }
});
```

Update renderer callers (likely already use `invokeOk` which unwraps the envelope).

**Tests:**

- Existing tag tests should pass; add one that mocks `tags:load` to throw EACCES and asserts the envelope shape.

**Parity risks:**

- The current `tags:load` returns `string | null` (null for ENOENT). Preserve that semantic via `data: string | null` in the envelope.

**Size:** ~30 LOC + ~30 LOC test. **~half a day.**

**Acceptance:** `check-ipc-envelope-usage` gate accepts tags.ipc handlers as compliant.

---

### E.4 — `font:import` blob-from-disk pattern

**Closes:** P1-5 (raw bytes returned to renderer).

**Files:** [src/main/ipc/fonts.ipc.ts:156](src/main/ipc/fonts.ipc.ts:156), [src/renderer/components/settings/GeneralSettings.svelte:261](src/renderer/components/settings/GeneralSettings.svelte:261).

**Change:** Stop returning `dataBase64`. The renderer already has the saved-to-vault path; load the font in the renderer via a `filo://media/...` URL or by reading the saved file through a new `font:read-bytes` IPC that requires the path to be inside `<vault>/.filo/fonts/` (assertWithinVault on the fonts dir specifically). The base64 readback becomes unnecessary because the font is already on disk where the renderer can fetch it.

```ts
// fonts.ipc.ts (after the atomicWriteFile)
imported.push({ name: fontName, path: finalPath });  // no dataBase64

// GeneralSettings.svelte:261
const fontUrl = `filo://media/${encodeURIComponent(font.relPath)}`;
const fontFace = new FontFace(font.name, `url(${fontUrl})`);
await fontFace.load();
document.fonts.add(fontFace);
```

**Tests:**

- E2E: import a TTF, restart, confirm the font appears in the font picker.

**Parity risks:**

- `filo://` protocol must serve `application/font-sfnt` / `font/ttf` content-type correctly. Verify the protocol handler returns the right MIME for `.ttf` / `.otf` / `.woff` / `.woff2`.

**Size:** ~30 LOC main + ~40 LOC renderer + ~50 LOC test. **~1 day.**

**Acceptance:** Font import works; no base64 in IPC payload.

---

## Phase F — UX / a11y point fixes

### F.1 — Frame & Tile resize keyboard equivalent

**Closes:** P1-8 (WCAG 2.1.1 Keyboard fail).

**Files:** [src/renderer/components/frames/Frame.svelte:552-557](src/renderer/components/frames/Frame.svelte:552), [src/renderer/components/tiles/TileContainer.svelte:369-372](src/renderer/components/tiles/TileContainer.svelte:369).

**Change:**

- Resize handle gets `tabindex={0}` + `role="slider"` + `aria-orientation="diagonal"` (or two separate handles for width and height) + `aria-valuemin`/`max`/`now`.
- Arrow keys (Left/Right/Up/Down) adjust size by 8 px (or 1 px with Shift).
- Enter starts a "size mode" with on-screen affordance (similar to dragging).
- Escape commits or cancels.

**Tests:**

- E2E: focus a tile's resize handle via Tab; arrow keys change size; size change is recorded in history.

**Size:** ~80 LOC frame + ~80 LOC tile + ~60 LOC test. **~1 day.**

**Acceptance:** axe-core passes; manual keyboard-only resize works.

---

### F.2 — `EmojiPicker` focus restoration

**Closes:** P2 (handleClickOutside leaves focus on body).

**Files:** [src/renderer/components/shared/EmojiPicker.svelte:31-49](src/renderer/components/shared/EmojiPicker.svelte:31).

**Change:** `handleClickOutside` calls `closePicker()` (which restores `triggerRef?.focus()`) instead of setting `showPicker = false` directly.

**Size:** ~5 LOC. **~10 minutes.**

---

### F.3 — `TaskBulkActionBar` live-region throttling

**Closes:** P2 (re-announce spam).

**Files:** [src/renderer/components/boards/TaskBulkActionBar.svelte:80](src/renderer/components/boards/TaskBulkActionBar.svelte:80).

**Change:** Move `aria-live="polite"` off the `<span class="count">` onto a dedicated live region that announces only on selection-state transitions (entering / leaving bulk mode, plus debounced count updates). Don't announce every keystroke.

**Size:** ~30 LOC. **~half a day.**

---

### F.4 — `recovery:snapshot` total size cap

**Closes:** P2 (disk-fill DoS via repeated snapshots of large files).

**Files:** [src/main/ipc/board.ipc.ts:414-433](src/main/ipc/board.ipc.ts:414) and `recoverySnapshot.ts`.

**Change:** Track total bytes written to `.filo/recovery/` per vault; refuse new snapshots when total exceeds 200 MB (or some user-configurable limit). Surface a "Recovery snapshot quota exceeded" toast with an action to clear old recovery files.

**Size:** ~40 LOC + ~40 LOC test. **~half a day.**

---

## Phase G — Hygiene / perf

### G.1 — Delete `C:UsersandreMy` junk file

198 KB shell-redirect artefact at repo root. `rm "C:UsersandreMy"`. **5 minutes.**

### G.2 — Remove dead `commandRegistry.label` parameter

[src/renderer/core/commandRegistry.ts:27-57](src/renderer/core/commandRegistry.ts:27). Drop `label` from the interface; 16 call sites lose one duplicated string each. **~30 minutes.**

### G.3 — Delete unused per-tile Zod schema re-exports

[src/renderer/schema/index.ts](src/renderer/schema/index.ts) — `TextTileSchema`, `ImageTileSchema`, etc. only used inside their own modules. Drop the re-exports. **~15 minutes.**

### G.4 — Disambiguate `OrphanCatcher`

Two unrelated files share the basename. Rename `src/renderer/lib/canvas/orphanCatcher.ts` → `orphanedDropCatcher.ts` (the canvas-drop module) so it doesn't collide with `components/modals/OrphanCatcher.svelte` (the recovery modal). **~30 minutes.**

### G.5 — CLAUDE.md refresh

The project-structure listing in CLAUDE.md misses ~50 files added since it was last refreshed (full list in the audit report). Regenerate the directory tree section. **~1 hour.**

### G.6 — `themeContrast.test.ts` covers built-in themes

[src/tests/unit/themeContrast.test.ts](src/tests/unit/themeContrast.test.ts) only loads `static/themes/*.json` but built-in `[data-theme='dark']` / `'light'` blocks in `style.css` are independent. Extract the variable values from those blocks and assert contrast against the same thresholds. **~1 hour.**

### G.7 — `vaultIndex.allTags()` memoization

[src/renderer/stores/vaultIndex.svelte.ts:121-136](src/renderer/stores/vaultIndex.svelte.ts:121). Cache the `SvelteMap` result; invalidate only on tag-mutation events. **~1 hour.**

### G.8 — KanbanBoard derived perf

[src/renderer/components/boards/KanbanBoard.svelte:896-929](src/renderer/components/boards/KanbanBoard.svelte:896). Three nested `$derived.by` blocks scan every column × every placement on every `cacheVersion++`. Coalesce into a single derivation; precompute a `Map<tileId, placement>` lookup. **~2 hours.**

---

## Phase H — New CI gates encoding the invariants

### H.1 — `check-drift-aware-writes.mjs`

After Phase A.1 lands. Scans `src/renderer/lib/boards/*Scheduler.ts` and asserts each `createScheduler({...})` call passes a `driftCheck` hook OR is explicitly allowlisted (with a justifying comment) as a no-disk-write scheduler. ~80 LOC.

### H.2 — `check-electron-security.mjs`

After Phase E.1 lands. Asserts `src/main/main.ts` contains `setWindowOpenHandler`, `will-navigate`, `setPermissionRequestHandler`. ~30 LOC.

### H.3 — `check-command-undo-discipline.mjs`

After Phase D.1 lands. AST-walks `src/renderer/commands/`; asserts no `boardStore` / `documentStore` / `framesStore` / `boardCacheStore` imports are referenced inside `undo()` method bodies. ~100 LOC.

---

## Per-phase acceptance summary

| Phase | Done when |
|---|---|
| A.1 | `miscWriteScheduler` + every config baseline are drift-checked; new test passes; manual external-edit smoke aborts the save |
| A.2 | `openModal` is async; pending `beforeClose` is awaited; test passes; manual cross-modal-while-dirty smoke shows confirm |
| A.3 | `recentSelfWrites` TTL extends during `reconnecting`; test passes |
| B.1 | MoveFrameCommand undo restores `containedTileIds` snapshot; test passes |
| C.1 | `vault:copy-file` source arg is `HostPath`; raw-string fails type-check |
| D.1 | Every `Command.undo()` consumes `ctx: SnapshotOnlyContext`; gate H.3 at error |
| E.1 | `setWindowOpenHandler` etc. registered; E2E test passes |
| E.2 | Production CSP excludes `ws://localhost:*` |
| E.3 | `tags:*` returns envelope shape |
| E.4 | `font:import` no longer returns base64 |
| F.* | Resize keyboard works; live region quiet; recovery cap enforced |
| G.* | Junk file removed; CLAUDE.md current; perf hotspots resolved |
| H.* | New gates land at error level |

## Risk mitigations

- **Refactor regressions:** Each phase ships independently. Run `npm run ci:verify` after every commit.
- **Phase D scope:** If D.1 reveals more command-class drift than expected, ship A–C + E + F + G first to get the app daily-driver-safe, then take D as a multi-week sprint.
- **Phase A.1 baseline seeding:** A bug here silently disables drift detection. Add an assertion that `getBaseline(path)` returns defined for every known config file after `loadVaultCandidate` completes — turn the invariant into a runtime check during dev builds.
- **Memory drift:** Update the memory file when each phase lands. Avoid recording detail that this plan already covers.

---

## Changelog

_Add an entry after each phase lands. Format: `## Phase X landed — YYYY-MM-DD — summary`._

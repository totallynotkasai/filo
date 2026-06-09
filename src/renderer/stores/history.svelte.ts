import { tick } from 'svelte';
import { boardStore } from './board.svelte';
import { uiStore } from './ui.svelte';
import { onVaultSwap } from '../core/vaultLifecycle';
import { Command } from '../commands/Command';
import { reportError } from '../lib/utils/errorBus';

// Phase R3 — `Command` is now defined alongside its abstract base class in
// `commands/Command.ts`. Re-export the type from here so legacy callers
// (`import type { Command } from '../stores/history.svelte'`) keep working
// without churn.
export { Command };

/**
 * History store — per-board undo/redo stacks using the Command pattern.
 * Each board maintains its own independent history.
 */

/**
 * Default per-board undo cap (M23). Settable at runtime via
 * `historyStore.setMaxHistory(n)` — wired into the App-level $effect that
 * watches `settings.general.historyLimit`. Stays a plain `let` (not `$state`)
 * because the cap is read inside `pushBoundedAndNotify` synchronously and
 * has no UI subscribers.
 */
const DEFAULT_MAX_HISTORY = 500;
let maxHistory = DEFAULT_MAX_HISTORY;

interface HistoryStack {
  undoStack: Command[];
  redoStack: Command[];
}

let stacks = $state<Record<string, HistoryStack>>({});
let activeBoardId = $state<string | null>(null);

// Boards that have already shown the "history limit reached" toast this
// session. Cleared on `clear()` (new project load); a board re-entering the
// truncation regime in the same session does not re-toast.
//
// Plain object rather than Set because we never iterate or compare reactively
// — just a "have we toasted yet" key/value check. Avoids the SvelteSet lint
// rule that fires on `new Set()` (which is for reactive use cases).
const truncationNotified: Record<string, true> = {};

/**
 * M25 — a "history may be stale" toast has already been shown this session.
 * The toast offers a Clear-undo action; we only surface it once per cluster
 * of external reconciliations so a folder-wide sync (Dropbox catch-up) doesn't
 * spam the user. Resets on `clear()` (new vault) and on Clear-undo accept.
 */
let staleToastShown = false;

/**
 * Audit 5.3 — optional "bring the originating board into focus" hook. Given a
 * boardId, returns true if that board is open and was activated, false if it
 * isn't open anywhere. Registered by App.svelte, which can reach
 * tabStore / workspaceStore without the import cycle that history → tabs would
 * create (tabs.svelte.ts imports historyStore). undo() / redo() use it to
 * auto-switch to a command's target board instead of wedging the stack behind
 * a switch-back toast.
 */
let boardActivator: ((boardId: string) => boolean) | null = null;

/**
 * M7 (Audit-13) — settle the global board scope onto a command's target board
 * after an undo()/redo() auto-switch, BEFORE running the command body.
 *
 * `boardActivator` retargets the active pane/tab, but the `boardStore` /
 * `canvasStore` / `selectionStore` / `spatialStore` facades only re-point on the
 * NEXT-tick `PaneView` `$effect` (which also calls `setActiveBoard`). The
 * Mind-Map facade commands (`AddTileCommand`, `DeleteTilesCommand`,
 * `MoveTilesCommand`, `AddConnectionCommand`, frame/waypoint) read those facades
 * synchronously — so running their body now would mutate the PREVIOUSLY-active
 * board. (Cache-targeting Kanban/Task/Properties/board-settings commands
 * self-target by id and are immune; they just incur a few harmless ticks.)
 *
 * Yield via `tick()` until `activeBoardId` reflects the target — bounded, so a
 * path that never re-points (no pane ends up showing the board; unit tests with
 * no mounted PaneView) proceeds rather than wedging.
 */
const SCOPE_SETTLE_MAX_TICKS = 10;
async function settleActiveScope(targetBoardId: string): Promise<void> {
  for (let i = 0; i < SCOPE_SETTLE_MAX_TICKS && activeBoardId !== targetBoardId; i++) {
    await tick();
  }
}

/**
 * Pure read of the active board's stack. Returns `null` when there's no
 * active board OR no stack has been allocated yet. Safe to call inside
 * `$derived` reads (canUndo / canRedo) — Svelte 5 forbids
 * `$state` writes during derivation, so the lazy-create path lives in
 * `getOrCreateActiveStack` below.
 */
function getActiveStack(): HistoryStack | null {
  if (!activeBoardId) return null;
  return stacks[activeBoardId] ?? null;
}

/**
 * 2.1 (Audit-14) — pure read of a SPECIFIC board's stack (or `null` when no
 * stack has been allocated for it / the id is empty). `undo()`/`redo()` capture
 * the board active at call time and pass it to their rollback so a body that
 * rejects AFTER the cross-board auto-switch flipped `activeBoardId` rolls back
 * the stack the synchronous move actually touched — NOT whichever board the
 * auto-switch landed on. (`getActiveStack` reads the post-switch board, which is
 * the 2.1 corruption.) Returns `null` if the stack is gone (vault swap
 * mid-flight) so the rollback no-ops, mirroring the prior guard.
 */
function getStackFor(boardId: string | null): HistoryStack | null {
  if (!boardId) return null;
  return stacks[boardId] ?? null;
}

/**
 * Lazy-create the active board's stack on first write. Used from
 * `execute` and `pushWithoutExecute` — paths that are already mutating
 * `$state` so the write here is unambiguous. `undo` and `redo` use
 * `getActiveStack` (pure read) because they correctly early-return when
 * no stack exists.
 */
function getOrCreateActiveStack(): HistoryStack | null {
  if (!activeBoardId) return null;
  let stack = stacks[activeBoardId];
  if (!stack) {
    stack = { undoStack: [], redoStack: [] };
    stacks[activeBoardId] = stack;
  }
  return stack;
}

/**
 * Phase 31 B4.8 — second truncation notification flag, fired when the
 * dropped command carried `fileSnapshots` (CascadeDeleteCommand,
 * DeleteTilesCommand). The standard toast says "earlier actions are no
 * longer reversible" — fine for pure cache mutations, misleading when
 * the dropped action also held the only copy of a deleted file's body.
 * The escalated toast surfaces that file content is irrecoverable so
 * the user can back up before the next destructive op.
 */
const truncationLossNotified: Record<string, true> = {};

/**
 * Phase C / C.1 — serialisation chain for the async side of every
 * command. Stack mutations (push/pop, redo clear, markDirty) always
 * stay synchronous so callers and tests can inspect `canUndo` /
 * `canRedo` immediately after calling `execute` / `undo` / `redo`.
 *
 * For the command body itself we follow a hybrid policy: when no prior
 * async op is in flight, the command's `execute()` / `undo()` body runs
 * synchronously — so sync commands (the common case + every existing
 * unit test) keep their immediate-effect contract. Only when a prior
 * command's promise is still pending do we defer the next body onto
 * the chain, which is exactly the rapid-Apply→Undo scenario the audit
 * called out: `UpdateCardFieldCommand.execute()` is suspended at
 * `await flushAllPendingFrontmatterWrites()` when `undo()` arrives,
 * and the chained body has to wait for the flush+merge+schedule
 * sequence to settle before its own merge runs.
 *
 * The chain swallows per-op errors so one rejected command doesn't
 * block every subsequent op; the caller-facing promise returned by
 * `runChained` still rejects so individual call sites can surface
 * failures if they want to.
 */
let pendingChain: Promise<void> = Promise.resolve();
let chainInflightDepth = 0;

/**
 * 2.5 (Audit-16) — generation token for the depth bookkeeping. The pre-swap
 * reset zeroes `chainInflightDepth` while an outgoing-vault command body may
 * still be in flight (the Don't-Save branch never awaits `whenChainSettled`);
 * that body's settle handler then decremented the FRESH counter to -1, after
 * which `chainInflightDepth === 0` was never true again — every later command
 * body in the new vault, including purely synchronous ones, deferred to a
 * microtask for the rest of the session (each deferred op's own settle
 * re-decrementing to -1). Settle handlers capture the generation at creation
 * and only decrement while it still matches; the reset bumps it, orphaning
 * any handler tethered to the dead chain.
 */
let chainGeneration = 0;

function noteChainOpSettled(generation: number): void {
  if (generation === chainGeneration) chainInflightDepth--;
}

function runChained(op: () => Promise<void> | void): Promise<void> {
  if (chainInflightDepth === 0) {
    let result: Promise<void> | void;
    try {
      result = op();
    } catch (err) {
      return Promise.reject(err);
    }
    if (!result || typeof (result as Promise<void>).then !== 'function') {
      return Promise.resolve();
    }
    chainInflightDepth++;
    const generation = chainGeneration;
    const p = result as Promise<void>;
    const settled = p.then(
      () => { noteChainOpSettled(generation); },
      (err) => { noteChainOpSettled(generation); throw err; },
    );
    pendingChain = settled.then(() => undefined, () => undefined);
    return p;
  }
  // Prior async op still in flight — queue this body so its own internal
  // awaits can't interleave with the prior command's.
  chainInflightDepth++;
  const generation = chainGeneration;
  const next = pendingChain.then(() => op());
  const settled = next.then(
    () => { noteChainOpSettled(generation); },
    (err) => { noteChainOpSettled(generation); throw err; },
  );
  pendingChain = settled.then(() => undefined, () => undefined);
  return next;
}

/**
 * Phase 3 / 3.8 — does the command carry pre-delete file body snapshots?
 * Delegates to the optional `Command.hasFileSnapshots()` method so future
 * commands opt in by implementing the method rather than being silently
 * missed by a name-based duck-type lookup. Returns `false` for commands
 * that don't implement it (the common case).
 */
function hasFileSnapshots(command: Command): boolean {
  return command.hasFileSnapshots?.() ?? false;
}

/**
 * Phase R3 — generalised stack mutator with mandatory file-snapshot scan.
 *
 * Runs `mutate(stack)` and detects commands dropped from EITHER the undo
 * or redo stack. If any dropped command carries file snapshots
 * (`hasFileSnapshots()` returns true), the escalated "deleted files cannot
 * be restored" toast fires — once per board per session.
 *
 * Every code path that may drop a command from a history stack
 * (`pushBoundedAndNotify`, redo-clear inside `commitExecute`,
 * `setMaxHistory`) MUST go through this helper. The audit found three
 * sites that dropped commands without the file-snapshot check; with this
 * helper, file-snapshot escalation becomes mandatory by construction.
 *
 * The non-escalated "earlier actions are no longer reversible" info toast
 * is emitted by the caller (only `pushBoundedAndNotify` /
 * `setMaxHistory` know whether the stack actually shrank from the head
 * vs. just a redo-clear). The redo-clear path is expected and shouldn't
 * toast unless a file-snapshot command was sitting there.
 *
 * Returns `{ droppedCount, lostFile }` so the caller can chain its own
 * info-toast decision off the same scan.
 */
function mutateStack(
  stack: HistoryStack,
  boardId: string | null,
  mutate: (s: HistoryStack) => void,
): { droppedCount: number; lostFile: boolean } {
  const beforeIds = new Set<Command>([...stack.undoStack, ...stack.redoStack]);
  mutate(stack);
  const afterIds = new Set<Command>([...stack.undoStack, ...stack.redoStack]);
  let droppedCount = 0;
  let lostFile = false;
  for (const c of beforeIds) {
    if (afterIds.has(c)) continue;
    droppedCount++;
    if (!lostFile && hasFileSnapshots(c)) lostFile = true;
  }
  if (lostFile && boardId && !truncationLossNotified[boardId]) {
    truncationLossNotified[boardId] = true;
    // Mark the regular flag too so the lighter toast doesn't fire later
    // on the same board for the same session — escalation supersedes.
    truncationNotified[boardId] = true;
    uiStore.toast(
      'Older undo history dropped — deleted files older than this point cannot be restored.',
      'warning',
      6000,
    );
  }
  return { droppedCount, lostFile };
}

/**
 * Pushes `command` onto the stack with the current `maxHistory` cap, emitting
 * a one-shot info toast the first time the cap drops the oldest entry for
 * this board. Re-truncation in the same session is silent. File-snapshot
 * escalation is handled by `mutateStack`.
 */
function pushBoundedAndNotify(stack: HistoryStack, command: Command): void {
  const willTruncate = stack.undoStack.length + 1 > maxHistory;
  const { lostFile } = mutateStack(stack, activeBoardId, (s) => {
    s.undoStack = [...s.undoStack, command].slice(-maxHistory);
  });
  if (willTruncate && activeBoardId && !lostFile && !truncationNotified[activeBoardId]) {
    truncationNotified[activeBoardId] = true;
    uiStore.toast(
      'Undo history limit reached — earlier actions are no longer reversible.',
      'info',
      4000,
    );
  }
}

/**
 * Phase R3 — clears the redo stack via `mutateStack` so any redo entry
 * with file snapshots triggers the escalated toast. Called from
 * `commitExecute` after a new command lands on the undo stack (the new
 * command invalidates pending redos).
 */
function clearRedoStackAndNotify(stack: HistoryStack): void {
  // #18 — always hand out a FRESH array reference, even when the redo stack is
  // already empty. `rollbackExecute` uses reference identity to detect whether
  // a concurrent commit/undo/redo replaced the redo stack in the window before
  // an async command body settled; a no-op early-return that left the prior
  // (possibly shared) reference in place would blind that check and let the
  // rollback resurrect redo entries a newer action had correctly invalidated.
  if (stack.redoStack.length === 0) {
    stack.redoStack = [];
    return;
  }
  mutateStack(stack, activeBoardId, (s) => {
    s.redoStack = [];
  });
}

/**
 * Phase R3 — synchronous commit step run BEFORE the command body. Pushes
 * `command` onto the undo stack (with the file-snapshot scan via
 * `pushBoundedAndNotify`) and clears the redo stack (with file-snapshot
 * scan via `clearRedoStackAndNotify`). Returns the pre-clear redo stack
 * so a body failure can roll the push back via `rollbackExecute`.
 *
 * Pre-R3, push happened synchronously before the body (so callers /
 * tests could inspect `canUndo` immediately after `execute()`). Post-R3
 * preserves that contract — but the audit found a `BatchCommand` whose
 * body throws was still on the undo stack, causing a subsequent Ctrl+Z
 * to double-undo the rolled-back children. The fix is rollback-on-failure
 * (see `rollbackExecute` below) so a failed body removes the command
 * from the stack and restores the prior redo stack.
 */
function commitExecute(command: Command): { preRedoStack: Command[]; redoStackRef: Command[] } {
  const stack = getOrCreateActiveStack();
  if (!stack) return { preRedoStack: [], redoStackRef: [] };
  // Snapshot the redo stack BEFORE clearing so a body failure can restore
  // it. Pure array copy — entries are Command instances, snapshot is by
  // reference (the contents are immutable from this scope).
  const preRedoStack = [...stack.redoStack];
  pushBoundedAndNotify(stack, command);
  clearRedoStackAndNotify(stack);
  // #18 — capture the post-clear redo array reference. `rollbackExecute`
  // restores `preRedoStack` only if `stack.redoStack` is STILL this exact
  // array — i.e. no other command's commitExecute / undo / redo replaced it
  // while this command's (possibly async) body was in flight.
  const redoStackRef = stack.redoStack;
  if (activeBoardId) boardStore.markDirty(activeBoardId);
  return { preRedoStack, redoStackRef };
}

/**
 * Phase R3 — undoes `commitExecute` when the body throws / rejects.
 * Removes `command` from the undo stack (lastIndexOf so a same-instance
 * push-twice scenario only rolls back the last one) and restores the
 * pre-execute redo stack. If the stack is gone (vault swap mid-flight),
 * no-op.
 *
 * 2.1 (Audit-16) — resolve the stack `commitExecute` actually pushed onto
 * (the board active when `execute()` STARTED), not `getActiveStack()`: the
 * user can switch tabs while an async body is in flight, and the Audit-14
 * 2.1 fix covered only `rollbackUndo`/`rollbackRedo`. A wrong-board read
 * here missed the `lastIndexOf`, failed the redo identity check, and left
 * the never-applied command on the origin stack — a later Ctrl+Z replayed
 * its inverse (a stale full-slice snapshot) over state it never changed.
 */
function rollbackExecute(
  command: Command,
  preRedoStack: Command[],
  redoStackRef: Command[],
  originBoardId: string | null,
): void {
  const stack = getStackFor(originBoardId);
  if (!stack) return;
  const idx = stack.undoStack.lastIndexOf(command);
  if (idx >= 0) {
    stack.undoStack = [
      ...stack.undoStack.slice(0, idx),
      ...stack.undoStack.slice(idx + 1),
    ];
  }
  // #18 — restore the pre-execute redo stack ONLY if nothing replaced it since
  // commitExecute. A concurrent command (its own commitExecute clearing redo,
  // or an undo/redo) reassigns `stack.redoStack` to a new array; if that
  // happened, the newer redo state wins — blindly assigning our snapshot would
  // clobber it and could revive a redo entry the newer action invalidated.
  // (Removing the failed command from the undo stack above is always safe.)
  if (stack.redoStack === redoStackRef) {
    stack.redoStack = preRedoStack;
  }
  // 2.1 — dirty the board the command actually mutates, falling back to the
  // origin board (whose stack we just repaired) — not the post-switch active
  // board, which this rollback never touched.
  const dirtyId = command.targetBoardId || originBoardId;
  if (dirtyId) boardStore.markDirty(dirtyId);
}

/**
 * UR-1 — undoes `undo()`'s synchronous stack move when the command body
 * throws / rejects. `undo()` popped `command` off the undo stack and pushed it
 * onto the redo stack; on failure we remove it from the redo stack
 * (`lastIndexOf`, mirroring `rollbackExecute`) and restore the undo stack to
 * its pre-undo contents. Without this, a rejected async `undo()` left the
 * command stranded on the redo stack with its inverse only half-applied, so a
 * follow-up Ctrl+Z skipped it and the next Ctrl+Y replayed a no-op.
 */
function rollbackUndo(command: Command, preUndoStack: Command[], originBoardId: string | null): void {
  // 2.1 (Audit-14) — resolve the stack `undo()`'s synchronous move actually
  // touched (the board active when undo() STARTED), not `getActiveStack()`: a
  // cross-board auto-switch has by now flipped `activeBoardId` to the target,
  // so the old `getActiveStack()` read the WRONG board — removing the command
  // from a board it was never on and clobbering that board's undo stack with
  // this board's pre-undo snapshot.
  const stack = getStackFor(originBoardId);
  if (!stack) return;
  const idx = stack.redoStack.lastIndexOf(command);
  if (idx >= 0) {
    stack.redoStack = [
      ...stack.redoStack.slice(0, idx),
      ...stack.redoStack.slice(idx + 1),
    ];
  }
  stack.undoStack = preUndoStack;
  // Dirty the board the command actually mutates (its target), falling back to
  // the originating board for board-agnostic commands.
  const dirtyId = command.targetBoardId || originBoardId;
  if (dirtyId) boardStore.markDirty(dirtyId);
}

/**
 * UR-1 — symmetric counterpart for `redo()`. `redo()` popped `command` off the
 * redo stack and pushed it onto the undo stack (via `pushBoundedAndNotify`);
 * on failure we remove it from the undo stack and restore the redo stack to
 * its pre-redo contents. As with `rollbackExecute`, a command dropped from the
 * head by `pushBoundedAndNotify`'s cap is not resurrected — the redo body
 * failing is the rare path and this matches the execute-side contract.
 */
function rollbackRedo(command: Command, preRedoStack: Command[], originBoardId: string | null): void {
  // 2.1 (Audit-14) — see `rollbackUndo`: roll back the stack `redo()`'s move
  // touched (the board active when redo() STARTED), not the post-auto-switch
  // active board.
  const stack = getStackFor(originBoardId);
  if (!stack) return;
  const idx = stack.undoStack.lastIndexOf(command);
  if (idx >= 0) {
    stack.undoStack = [
      ...stack.undoStack.slice(0, idx),
      ...stack.undoStack.slice(idx + 1),
    ];
  }
  stack.redoStack = preRedoStack;
  const dirtyId = command.targetBoardId || originBoardId;
  if (dirtyId) boardStore.markDirty(dirtyId);
}

export const historyStore = {
  get canUndo() {
    const stack = getActiveStack();
    return stack ? stack.undoStack.length > 0 : false;
  },
  get canRedo() {
    const stack = getActiveStack();
    return stack ? stack.redoStack.length > 0 : false;
  },

  /**
   * The board history currently tracks for undo/redo (the active pane's board,
   * or `null`). Read-only mirror of `setActiveBoard`; used by the M7 settle
   * logic's regression test to observe which board was active when a deferred
   * command body actually ran.
   */
  get activeBoardId(): string | null {
    return activeBoardId;
  },

  /**
   * L31 (Audit-6) — resolves when the async command chain (`runChained`) is
   * quiescent, so `vaultStore.save()` / the flush-and-quit path can await any
   * in-flight `execute`/`undo`/`redo` body BEFORE the final flush pass. An async
   * command (e.g. `UpdateCardFieldCommand`, which awaits a frontmatter
   * flush+merge+schedule) schedules its disk writes only after that body runs;
   * flushing before the chain settles would miss those writes and report a
   * premature "saved". Never rejects — the chain swallows per-op errors at the
   * tail (callers see failures through their own `runChained` return). Captures
   * the CURRENT tail: a command enqueued after this call isn't awaited (the
   * intended "drain what's queued now" semantics, matching the sentinel flush).
   */
  whenChainSettled(): Promise<void> {
    return pendingChain.then(() => undefined, () => undefined);
  },

  /**
   * Sets the active board for history tracking.
   * Called when switching boards.
   */
  setActiveBoard(boardId: string | null) {
    activeBoardId = boardId;
  },

  /**
   * Audit 5.3 — registers the auto-switch hook (see `boardActivator`). App.svelte
   * wires this so undo()/redo() can focus a command's originating board instead
   * of wedging the stack. Pass null to clear (teardown / tests).
   */
  setBoardActivator(fn: ((boardId: string) => boolean) | null) {
    boardActivator = fn;
  },

  /**
   * Executes a command and pushes it onto the active board's undo stack.
   * Clears the redo stack (new action invalidates redo history). Also
   * marks the project as dirty.
   *
   * Phase C / C.1 — stack mutations stay synchronous so callers and tests
   * can inspect `canUndo` / `canRedo` immediately. The command's own
   * `execute()` (which may be async — e.g. UpdateCardFieldCommand awaits
   * `flushAllPendingFrontmatterWrites`) routes through the per-store
   * `pendingChain` so a follow-up undo can't fire until this command's
   * effects have settled.
   *
   * Phase R3 — the audit found a `BatchCommand` whose body threw still
   * landed on the undo stack (the next Ctrl+Z double-undid the rolled-back
   * children). The fix is rollback-on-failure: we still push synchronously
   * (preserves the `canUndo` contract), but if the body throws / rejects
   * we remove the command from the stack and restore the pre-execute redo
   * stack via `rollbackExecute`. A successful body leaves the synchronous
   * commit alone.
   */
  execute(command: Command): Promise<void> {
    // 2.1 (Audit-16) — capture the board whose stack commitExecute pushes
    // onto BEFORE the (possibly async) body runs; a tab switch during the
    // awaited body flips `activeBoardId`, and the rollback must repair the
    // stack the synchronous commit actually touched. See rollbackExecute.
    const originBoardId = activeBoardId;
    const { preRedoStack, redoStackRef } = commitExecute(command);
    return runChained(() => command.execute()).catch((err) => {
      rollbackExecute(command, preRedoStack, redoStackRef, originBoardId);
      // 6.4.M15 — almost every caller fires execute() fire-and-forget, so the
      // rethrow below surfaces only as a silent unhandled rejection. Report it
      // first so a command body that throws is never invisible (the rollback
      // already restored the stack; the user just sees nothing otherwise).
      reportError('historyStore', err, `"${command.description}" failed and was rolled back.`);
      throw err;
    });
  },

  /**
   * Undoes the most recent command on the active board.
   *
   * Phase 31 A6.3 — when the command exposes a `boardId` and it doesn't
   * match the active board, surfaces a toast asking the user to switch
   * boards rather than silently mutating the wrong target.
   *
   * Phase C / C.1 — async via `runChained` so a rapid Apply → Undo can't
   * overlap the prior `execute()`'s flush with this one's.
   */
  undo(): Promise<void> {
    const stack = getActiveStack();
    if (!stack || stack.undoStack.length === 0) return Promise.resolve();
    const command = stack.undoStack[stack.undoStack.length - 1];
    if (!command) return Promise.resolve(); // length checked above; narrow for the type-checker
    // 2.1 (Audit-14) — the board whose stack we're about to mutate. Capture it
    // NOW: a cross-board auto-switch below flips `activeBoardId` to the target
    // inside the async body, so the rollback can't re-read it (it would resolve
    // the wrong board's stack). This is the board the synchronous move touches.
    const originBoardId = activeBoardId;
    let didAutoSwitch = false;
    if (command.targetBoardId && command.targetBoardId !== activeBoardId) {
      // Audit 5.3 — auto-switch to the originating board when it's open, then
      // undo it. The command carries its own boardId, so the mutation lands on
      // the right board regardless of which stack filed it. When the board
      // isn't open anywhere, keep the switch-back toast AND leave the command
      // on the stack so it stays reachable once the user opens that board
      // (rather than wedging every later undo behind it).
      if (!(boardActivator?.(command.targetBoardId) ?? false)) {
        uiStore.toast(
          `Switch to the originating board to undo this action.`,
          'info',
          3500,
        );
        return Promise.resolve();
      }
      didAutoSwitch = true;
    }
    // UR-1 — snapshot the undo stack BEFORE the move so a body failure can
    // restore it (mirror of `commitExecute`/`rollbackExecute`). The stack
    // mutations stay synchronous; only the rollback is deferred to the catch.
    const preUndoStack = [...stack.undoStack];
    stack.undoStack = stack.undoStack.slice(0, -1);
    stack.redoStack = [...stack.redoStack, command];
    // Mark the board the command actually mutates (its target), not the
    // possibly-just-switched active board.
    const dirtyId = command.targetBoardId || activeBoardId;
    if (dirtyId) boardStore.markDirty(dirtyId);
    // M7 (Audit-13) — only the cross-board auto-switch path needs the async
    // scope-settle; the common same-board case keeps its synchronous body so
    // callers/tests still see immediate effects.
    const op = didAutoSwitch
      ? async () => {
          await settleActiveScope(command.targetBoardId);
          await command.undo();
        }
      : () => command.undo();
    return runChained(op).catch((err) => {
      rollbackUndo(command, preUndoStack, originBoardId);
      // 6.4.M15 — see execute(): report before the (mostly unobserved) rethrow.
      reportError('historyStore', err, `Undo of "${command.description}" failed and was rolled back.`);
      throw err;
    });
  },

  /**
   * Redoes the most recently undone command on the active board.
   *
   * Phase 31 A6.3 — same boardId guard as undo().
   *
   * Phase C / C.1 — async via `runChained`; see `execute` / `undo`.
   */
  redo(): Promise<void> {
    const stack = getActiveStack();
    if (!stack || stack.redoStack.length === 0) return Promise.resolve();
    const command = stack.redoStack[stack.redoStack.length - 1];
    if (!command) return Promise.resolve(); // length checked above; narrow for the type-checker
    // 2.1 (Audit-14) — see undo(): capture the board whose stack we mutate
    // before a cross-board auto-switch flips `activeBoardId`.
    const originBoardId = activeBoardId;
    let didAutoSwitch = false;
    if (command.targetBoardId && command.targetBoardId !== activeBoardId) {
      // Audit 5.3 — symmetric with undo(): auto-switch to the originating
      // board when it's open, otherwise keep the switch-back toast without
      // popping the command.
      if (!(boardActivator?.(command.targetBoardId) ?? false)) {
        uiStore.toast(
          `Switch to the originating board to redo this action.`,
          'info',
          3500,
        );
        return Promise.resolve();
      }
      didAutoSwitch = true;
    }
    // UR-1 — snapshot the redo stack BEFORE the move so a body failure can
    // restore it, symmetric with `undo()` above.
    const preRedoStack = [...stack.redoStack];
    stack.redoStack = stack.redoStack.slice(0, -1);
    pushBoundedAndNotify(stack, command);
    const dirtyId = command.targetBoardId || activeBoardId;
    if (dirtyId) boardStore.markDirty(dirtyId);
    // M7 (Audit-13) — see undo(): settle the scope onto targetBoardId before
    // re-running a facade body on a cross-board redo; same-board keeps sync.
    const op = didAutoSwitch
      ? async () => {
          await settleActiveScope(command.targetBoardId);
          await command.execute();
        }
      : () => command.execute();
    return runChained(op).catch((err) => {
      rollbackRedo(command, preRedoStack, originBoardId);
      // 6.4.M15 — see execute(): report before the (mostly unobserved) rethrow.
      reportError('historyStore', err, `Redo of "${command.description}" failed and was rolled back.`);
      throw err;
    });
  },

  /**
   * Pushes a command onto the undo stack WITHOUT executing it.
   * Used when the mutation has already been applied (e.g., during drag/resize
   * where changes happen in real-time and we only need the command for undo/redo).
   *
   * Phase R3 — redo-clear now routes through `clearRedoStackAndNotify` so a
   * pending DeleteTilesCommand on the redo stack (the user just Ctrl+Z'd
   * it and is now starting a fresh drag) fires the escalated file-snapshot
   * loss toast.
   */
  pushWithoutExecute(command: Command) {
    const stack = getOrCreateActiveStack();
    if (stack) {
      pushBoundedAndNotify(stack, command);
      clearRedoStackAndNotify(stack);
    }
    if (activeBoardId) boardStore.markDirty(activeBoardId);
  },

  /**
   * Clears history for all boards (e.g. when loading a new project).
   */
  clear() {
    stacks = {};
    for (const k of Object.keys(truncationNotified)) delete truncationNotified[k];
    for (const k of Object.keys(truncationLossNotified)) delete truncationLossNotified[k];
    staleToastShown = false;
  },

  /**
   * M25 — an external edit replaced in-memory state for a file, so the
   * inverse on undo stacks may no longer be valid. Offers the user a
   * Clear-undo action via a persistent toast. Idempotent across a cluster
   * of reconciliations: the toast appears at most once per session per
   * `clear()` (which fires on vault open).
   *
   * Accepts a label to identify the touched file in the toast text; falls
   * back to a generic message when omitted (e.g. a folder-wide sync where
   * naming one file would be misleading).
   */
  notePossiblyStale(label?: string) {
    if (staleToastShown) return;
    let anyHistory = false;
    for (const id of Object.keys(stacks)) {
      const s = stacks[id];
      if (!s) continue;
      if (s.undoStack.length > 0 || s.redoStack.length > 0) { anyHistory = true; break; }
    }
    if (!anyHistory) return;
    staleToastShown = true;
    const subject = label ? `"${label}"` : 'a file';
    uiStore.pushToast({
      text: `External edit replaced ${subject}. Earlier undo steps may no longer match disk — clear undo history to be safe?`,
      type: 'warning',
      duration: 0,
      actions: [
        {
          label: 'Clear undo history',
          handler: () => {
            this.clear();
          },
        },
      ],
    });
  },

  /**
   * Clears history for a specific board (e.g. when deleting a board, or when
   * its last open tab closes — every caller fires only once the board is truly
   * gone, never for a board still pinned in another pane).
   *
   * 2.4 (Audit-14) — history is filed by the GLOBAL active board, not the
   * command's `targetBoardId`, so a command mutating board B can sit on board
   * A's stack (B was edited from an inactive split pane). Deleting B's own
   * stack below leaves those B-targeting commands stranded on sibling stacks;
   * on Ctrl+Z `boardActivator(B)` fails (B is gone) → the switch-back toast
   * fires and the command is NOT popped, wedging A's undo behind it forever.
   * So after dropping B's own stack, sweep every surviving stack and drop
   * commands that target the removed board. Routed through `mutateStack` so a
   * swept command carrying file snapshots still fires the escalated
   * "deleted files cannot be restored" toast (the drop-discipline invariant).
   */
  clearBoard(boardId: string) {
    // 2.4 (Audit-16) — drop the closed board's OWN stack through `mutateStack`
    // first. The raw `delete` below bypassed the mandatory file-snapshot scan
    // (the module's drop-discipline invariant), so closing the last tab of a
    // board whose history held a CascadeDelete/DeleteTiles command — the only
    // in-memory copy of a deleted .md body — discarded those snapshots with
    // no escalated toast. The sibling sweep below already routes through it.
    const own = stacks[boardId];
    if (own) {
      mutateStack(own, boardId, (s) => {
        s.undoStack = [];
        s.redoStack = [];
      });
    }
    delete stacks[boardId];
    delete truncationNotified[boardId];
    delete truncationLossNotified[boardId];
    for (const id of Object.keys(stacks)) {
      const stack = stacks[id];
      if (!stack) continue;
      mutateStack(stack, id, (s) => {
        s.undoStack = s.undoStack.filter((c) => c.targetBoardId !== boardId);
        s.redoStack = s.redoStack.filter((c) => c.targetBoardId !== boardId);
      });
    }
  },

  /**
   * Updates the per-board undo cap (M23). Called from the App-level settings
   * $effect when `settings.general.historyLimit` changes. Lowering the cap
   * truncates every existing stack to the new length so the new ceiling
   * applies immediately — the truncationNotified guard resets per board so
   * the first push past the new cap can still emit one info toast.
   *
   * Phase R3 — each per-stack truncation routes through `mutateStack` so a
   * dropped command with file snapshots fires the escalated
   * "deleted-files-cannot-be-restored" toast. The audit found that lowering
   * the History Limit slider used to silently destroy recovery snapshots
   * because the slice() walked past the file-snapshot scan.
   */
  setMaxHistory(next: number) {
    const clamped = Math.max(10, Math.min(5000, Math.floor(next)));
    if (clamped === maxHistory) return;
    maxHistory = clamped;
    let truncated = false;
    for (const id of Object.keys(stacks)) {
      const stack = stacks[id];
      if (!stack) continue;
      const { droppedCount } = mutateStack(stack, id, (st) => {
        if (st.undoStack.length > clamped) {
          st.undoStack = st.undoStack.slice(-clamped);
        }
        if (st.redoStack.length > clamped) {
          st.redoStack = st.redoStack.slice(-clamped);
        }
      });
      if (droppedCount > 0) truncated = true;
    }
    if (truncated) {
      // Reset the per-board info-toast flag so the next push past the
      // new cap can still emit one "limit reached" toast. The
      // `mutateStack` calls above have already surfaced the loss-of-file
      // escalation where applicable; that flag also resets so subsequent
      // drops on the same board can re-toast in the new regime.
      for (const k of Object.keys(truncationNotified)) delete truncationNotified[k];
      for (const k of Object.keys(truncationLossNotified)) delete truncationLossNotified[k];
    }
  },
};

// Phase 4 (Consolidation 2026-05-25) — vault-swap reset registration.
// Drops every per-board undo/redo stack so a Ctrl+Z in the new vault
// can't replay against ids that no longer exist (Phase 16 / H6).
//
// Phase 3 (IMPL_PLAN 2026-05-25) — also reset `pendingChain` and
// `chainInflightDepth`. `historyStore.clear()` empties the stacks, but
// without dropping the promise-chain head the next vault inherited a
// chain still tethered to commands enqueued against the outgoing vault.
// A rapid Apply→Undo in the new vault could observe `chainInflightDepth
// > 0` and queue its body behind the dead chain — never running. Reset
// both back to the module's initial state.
onVaultSwap('pre-swap', 'history', () => {
  historyStore.clear();
  pendingChain = Promise.resolve();
  chainInflightDepth = 0;
  // 2.5 (Audit-16) — orphan any settle handler still tethered to an
  // outgoing-vault command body so its late settle can't decrement the
  // fresh counter to -1 (see `chainGeneration`).
  chainGeneration++;
});

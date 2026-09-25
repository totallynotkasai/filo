import { tick } from 'svelte';
import { boardStore } from './board.svelte';
import { uiStore } from './ui.svelte';
import { onVaultSwap } from '../core/vaultLifecycle';
import { Command } from '../commands/Command';
import { reportError } from '../lib/utils/errorBus';
import { registerPathRenamable } from '../lib/vault/renamePathKeys';
import { NoteGoneError } from '../commands/noteGoneError';

// `Command` lives in `commands/Command.ts`; re-exported here for callers that
// import it from the history store.
export { Command };

/**
 * History store — per-board undo/redo stacks using the Command pattern.
 * Each board maintains its own independent history.
 */

/**
 * Default per-board undo cap. Settable at runtime via
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
 * A "history may be stale" toast has already been shown this session.
 * The toast offers a Clear-undo action; we only surface it once per cluster
 * of external reconciliations so a folder-wide sync (Dropbox catch-up) doesn't
 * spam the user. Resets on `clear()` (new vault) and on Clear-undo accept.
 */
let staleToastShown = false;

/**
 * Optional "bring the originating board into focus" hook. Given a
 * boardId, returns true if that board is open and was activated, false if it
 * isn't open anywhere. Registered by App.svelte, which can reach
 * tabStore / workspaceStore without the import cycle that history → tabs would
 * create (tabs.svelte.ts imports historyStore). undo() / redo() use it to
 * auto-switch to a command's target board instead of wedging the stack behind
 * a switch-back toast.
 */
let boardActivator: ((boardId: string) => boolean) | null = null;

/**
 * Settle the global board scope onto a command's target board after an
 * undo()/redo() auto-switch, BEFORE running the command body.
 *
 * `boardActivator` retargets the active pane/tab, but the store facades only
 * re-point on the next-tick `PaneView` `$effect`. Mind-Map facade commands read
 * those facades synchronously, so running their body now would mutate the
 * previously-active board. (Cache-targeting commands self-target by id.)
 *
 * Yield via `tick()` until `activeBoardId` reflects the target — bounded, so a
 * path that never re-points proceeds rather than wedging.
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
 * Pure read of a SPECIFIC board's stack (or `null` when none is allocated / the
 * id is empty). `undo()`/`redo()` capture the board active at call time and pass
 * it to their rollback, so a body that rejects AFTER the cross-board auto-switch
 * rolls back the stack it actually touched — not the board the switch landed on.
 * Returns `null` if the stack is gone (vault swap mid-flight) so rollback no-ops.
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
 * Serialisation chain for the async side of every command. Stack mutations
 * (push/pop, redo clear, markDirty) always stay synchronous so callers and
 * tests can inspect `canUndo` / `canRedo` immediately after calling
 * `execute` / `undo` / `redo`.
 *
 * For the command body we follow a hybrid policy: when no prior async op is
 * in flight, the body runs synchronously (sync commands keep their
 * immediate-effect contract). Only when a prior command's promise is still
 * pending is the next body deferred onto the chain — e.g. a rapid Apply→Undo
 * where `execute()` is suspended mid-flush and the undo body must wait for it
 * to settle before its own merge runs.
 *
 * The chain swallows per-op errors so one rejected command doesn't
 * block every subsequent op; the caller-facing promise returned by
 * `runChained` still rejects so individual call sites can surface
 * failures if they want to.
 */
let pendingChain: Promise<void> = Promise.resolve();
let chainInflightDepth = 0;

/**
 * Generation token for the depth bookkeeping. The pre-swap reset zeroes
 * `chainInflightDepth` while an outgoing-vault command body may still be in
 * flight; without this its settle handler would decrement the fresh counter to
 * -1, and every later command body would defer to a microtask for the rest of
 * the session. Settle handlers capture the generation and only decrement while
 * it still matches; the reset bumps it.
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
 * Runs `mutate(stack)` and counts the commands it dropped from either the
 * undo or the redo stack. Every path that may drop commands goes through it,
 * so the caller can decide on its "no longer reversible" toast from the count.
 *
 * Dropping a delete never loses a file: deleted files wait in Filo's trash,
 * restorable from Settings → Trash, whatever happens to the undo history.
 */
function mutateStack(
  stack: HistoryStack,
  mutate: (s: HistoryStack) => void,
): { droppedCount: number } {
  const beforeIds = new Set<Command>([...stack.undoStack, ...stack.redoStack]);
  mutate(stack);
  const afterIds = new Set<Command>([...stack.undoStack, ...stack.redoStack]);
  let droppedCount = 0;
  for (const c of beforeIds) {
    if (!afterIds.has(c)) droppedCount++;
  }
  return { droppedCount };
}

/**
 * Pushes `command` onto the stack with the current `maxHistory` cap, emitting
 * a one-shot info toast the first time the cap drops the oldest entry for
 * this board. Re-truncation in the same session is silent.
 */
function pushBoundedAndNotify(
  stack: HistoryStack,
  command: Command,
  boardId: string | null = activeBoardId,
): void {
  // `pushWithoutExecuteOnBoard` passes an explicit `boardId` so a teardown
  // commit attributes the cap toast to the tile's HOME board, not whichever
  // board the switch made active.
  const willTruncate = stack.undoStack.length + 1 > maxHistory;
  mutateStack(stack, (s) => {
    s.undoStack = [...s.undoStack, command].slice(-maxHistory);
  });
  if (willTruncate && boardId && !truncationNotified[boardId]) {
    truncationNotified[boardId] = true;
    uiStore.toast(
      'Undo history limit reached — earlier actions are no longer reversible.',
      'info',
      4000,
    );
  }
}

/**
 * Clears the redo stack. Called from `commitExecute` after a new command
 * lands on the undo stack (the new command invalidates pending redos).
 */
function clearRedoStack(stack: HistoryStack): void {
  // Always hand out a FRESH array reference, even when the redo stack is
  // already empty. `rollbackExecute` uses reference identity to detect whether
  // a concurrent commit/undo/redo replaced the redo stack while an async body
  // was in flight; reusing the prior reference would blind that check and let
  // the rollback resurrect redo entries a newer action had invalidated.
  if (stack.redoStack.length === 0) {
    stack.redoStack = [];
    return;
  }
  mutateStack(stack, (s) => {
    s.redoStack = [];
  });
}

/**
 * Synchronous commit step run BEFORE the command body (so callers / tests can
 * inspect `canUndo` immediately after `execute()`). Pushes `command` onto the
 * undo stack and clears the redo stack, both with the file-snapshot scan.
 * Returns the pre-clear redo stack so a failed body can be rolled back via
 * `rollbackExecute` — otherwise a failed command would stay on the undo stack
 * and a later Ctrl+Z would double-undo it.
 */
function commitExecute(command: Command): { preRedoStack: Command[]; redoStackRef: Command[] } {
  const stack = getOrCreateActiveStack();
  if (!stack) return { preRedoStack: [], redoStackRef: [] };
  // Snapshot the redo stack BEFORE clearing so a body failure can restore
  // it. Pure array copy — entries are Command instances, snapshot is by
  // reference (the contents are immutable from this scope).
  const preRedoStack = [...stack.redoStack];
  pushBoundedAndNotify(stack, command);
  clearRedoStack(stack);
  // Capture the post-clear redo array reference. `rollbackExecute`
  // restores `preRedoStack` only if `stack.redoStack` is STILL this exact
  // array — i.e. no other command's commitExecute / undo / redo replaced it
  // while this command's (possibly async) body was in flight.
  const redoStackRef = stack.redoStack;
  if (activeBoardId) boardStore.markDirty(activeBoardId);
  return { preRedoStack, redoStackRef };
}

/**
 * Undoes `commitExecute` when the body throws / rejects. Removes `command`
 * from the undo stack (lastIndexOf so a same-instance push-twice only rolls
 * back the last one) and restores the pre-execute redo stack. If the stack is
 * gone (vault swap mid-flight), no-op.
 *
 * Resolves the stack `commitExecute` actually pushed onto (the board active
 * when `execute()` STARTED), not `getActiveStack()`: the user can switch tabs
 * while an async body is in flight, and a wrong-board read would leave the
 * never-applied command on the origin stack for a later Ctrl+Z to replay.
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
  // Restore the pre-execute redo stack ONLY if nothing replaced it since
  // commitExecute. A concurrent command (its own commitExecute clearing redo,
  // or an undo/redo) reassigns `stack.redoStack` to a new array; if that
  // happened, the newer redo state wins — blindly assigning our snapshot would
  // clobber it and could revive a redo entry the newer action invalidated.
  // (Removing the failed command from the undo stack above is always safe.)
  if (stack.redoStack === redoStackRef) {
    stack.redoStack = preRedoStack;
  }
  // Dirty the board the command actually mutates, falling back to the
  // origin board (whose stack we just repaired) — not the post-switch active
  // board, which this rollback never touched.
  const dirtyId = command.targetBoardId || originBoardId;
  if (dirtyId) boardStore.markDirty(dirtyId);
}

/**
 * Undoes `undo()`'s synchronous stack move when the command body throws /
 * rejects: removes `command` from the redo stack and restores the undo stack.
 * Without this, a rejected async `undo()` strands the command on the redo stack
 * with its inverse only half-applied.
 */
function rollbackUndo(
  command: Command,
  preUndoStack: Command[],
  undoStackRef: Command[],
  originBoardId: string | null,
): void {
  // Resolve the stack `undo()`'s synchronous move actually touched (the board
  // active when undo() STARTED): a cross-board auto-switch has by now flipped
  // `activeBoardId`, so `getActiveStack()` would clobber the wrong board.
  const stack = getStackFor(originBoardId);
  if (!stack) return;
  // Surgically remove the command from the redo stack `undo()` pushed it onto.
  const idx = stack.redoStack.lastIndexOf(command);
  if (idx >= 0) {
    stack.redoStack = [
      ...stack.redoStack.slice(0, idx),
      ...stack.redoStack.slice(idx + 1),
    ];
  }
  // Restore the pre-undo UNDO stack ONLY if nothing replaced it since undo()'s
  // synchronous move (mirror of `rollbackExecute`'s identity guard): a blind
  // restore would erase a command interleaved while the async body parked. On
  // a mismatch, re-insert the failed command instead — only if it isn't
  // already back — so it never lands on two stacks.
  if (stack.undoStack === undoStackRef) {
    stack.undoStack = preUndoStack;
  } else if (stack.undoStack.lastIndexOf(command) < 0) {
    stack.undoStack = [...stack.undoStack, command];
  }
  // Dirty the board the command actually mutates (its target), falling back to
  // the originating board for board-agnostic commands.
  const dirtyId = command.targetBoardId || originBoardId;
  if (dirtyId) boardStore.markDirty(dirtyId);
}

/**
 * Symmetric counterpart for `redo()`. `redo()` popped `command` off the
 * redo stack and pushed it onto the undo stack (via `pushBoundedAndNotify`);
 * on failure we remove it from the undo stack and restore the redo stack to
 * its pre-redo contents. As with `rollbackExecute`, a command dropped from the
 * head by `pushBoundedAndNotify`'s cap is not resurrected — the redo body
 * failing is the rare path and this matches the execute-side contract.
 */
function rollbackRedo(
  command: Command,
  preRedoStack: Command[],
  redoStackRef: Command[],
  originBoardId: string | null,
): void {
  // See `rollbackUndo`: roll back the stack `redo()`'s move
  // touched (the board active when redo() STARTED), not the post-auto-switch
  // active board.
  const stack = getStackFor(originBoardId);
  if (!stack) return;
  // Surgically remove the command from the undo stack `pushBoundedAndNotify` added it to.
  const idx = stack.undoStack.lastIndexOf(command);
  if (idx >= 0) {
    stack.undoStack = [
      ...stack.undoStack.slice(0, idx),
      ...stack.undoStack.slice(idx + 1),
    ];
  }
  // Identity-guard the redo-stack restore, symmetric with
  // `rollbackUndo`: blindly assigning `preRedoStack` would erase a command an
  // interleaved action pushed onto the redo stack while the async redo body
  // parked. On a mismatch, surgically re-insert `command` (if absent) so it
  // never lands on both stacks.
  if (stack.redoStack === redoStackRef) {
    stack.redoStack = preRedoStack;
  } else if (stack.redoStack.lastIndexOf(command) < 0) {
    stack.redoStack = [...stack.redoStack, command];
  }
  const dirtyId = command.targetBoardId || originBoardId;
  if (dirtyId) boardStore.markDirty(dirtyId);
}

/**
 * An undo or redo found its note gone: the command is back where it was (the
 * rollback), nothing was queued, and the user is told. The step stays so it
 * works again if the file comes back (restored from Filo's trash); "Skip this
 * step" drops it, so the steps before it are reachable. Resolves rather than
 * rejects: the failure is handled and shown.
 */
function toastNoteGone(command: Command, err: NoteGoneError, verb: 'undo' | 'redo'): void {
  uiStore.pushToast({
    text: `Couldn't ${verb}: "${err.relPath}" no longer exists.`,
    type: 'warning',
    duration: 0,
    dedupeKey: `history-note-gone:${err.relPath}`,
    actions: [{ label: 'Skip this step', handler: () => dropCommand(command) }],
  });
}

/** Removes `command` from every stack (the user skipped a step that can't run). */
function dropCommand(command: Command): void {
  for (const stack of Object.values(stacks)) {
    mutateStack(stack, (s) => {
      s.undoStack = s.undoStack.filter((c) => c !== command);
      s.redoStack = s.redoStack.filter((c) => c !== command);
    });
  }
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
   * or `null`). Read-only mirror of `setActiveBoard`; lets tests observe which
   * board was active when a deferred command body actually ran.
   */
  get activeBoardId(): string | null {
    return activeBoardId;
  },

  /**
   * Resolves when the async command chain (`runChained`) is quiescent, so
   * `vaultStore.save()` / flush-and-quit can await any in-flight body BEFORE the
   * final flush pass — an async command schedules its disk writes only after its
   * body runs, so flushing earlier would miss them and report a premature
   * "saved". Never rejects. Captures the CURRENT tail: commands enqueued later
   * aren't awaited.
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
   * Registers the auto-switch hook (see `boardActivator`). App.svelte
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
   * Stack mutations stay synchronous so callers and tests can inspect
   * `canUndo` / `canRedo` immediately. The command's own (possibly async)
   * `execute()` routes through `pendingChain` so a follow-up undo can't fire
   * until this command's effects have settled.
   *
   * If the body throws / rejects, `rollbackExecute` removes the command from
   * the stack and restores the pre-execute redo stack, so a later Ctrl+Z
   * can't double-undo it.
   */
  execute(command: Command): Promise<void> {
    // Capture the board whose stack commitExecute pushes onto BEFORE the
    // (possibly async) body runs; a tab switch mid-body flips `activeBoardId`.
    // See rollbackExecute.
    const originBoardId = activeBoardId;
    const { preRedoStack, redoStackRef } = commitExecute(command);
    return runChained(() => command.execute()).catch((err) => {
      rollbackExecute(command, preRedoStack, redoStackRef, originBoardId);
      // Almost every caller fires execute() fire-and-forget, so the rethrow
      // below surfaces only as a silent unhandled rejection. Report it first
      // so a failing command body is never invisible.
      reportError('historyStore', err, `"${command.description}" failed and was rolled back.`);
      throw err;
    });
  },

  /**
   * Undoes the most recent command on the active board.
   *
   * When the command targets a board other than the active one, auto-switches
   * to it (or toasts if it isn't open) rather than mutating the wrong target.
   *
   * Async via `runChained` so a rapid Apply → Undo can't overlap the prior
   * `execute()`'s flush with this one's.
   */
  undo(): Promise<void> {
    const stack = getActiveStack();
    if (!stack || stack.undoStack.length === 0) return Promise.resolve();
    const command = stack.undoStack[stack.undoStack.length - 1];
    if (!command) return Promise.resolve(); // length checked above; narrow for the type-checker
    // Capture the board whose stack we're about to mutate NOW: a cross-board
    // auto-switch below flips `activeBoardId`, so the rollback can't re-read it.
    const originBoardId = activeBoardId;
    let didAutoSwitch = false;
    if (command.targetBoardId && command.targetBoardId !== activeBoardId) {
      // Auto-switch to the originating board when it's open, then
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
    // Snapshot the undo stack BEFORE the move so a body failure can restore it.
    // The stack mutations stay synchronous; only the rollback is deferred.
    const preUndoStack = [...stack.undoStack];
    stack.undoStack = stack.undoStack.slice(0, -1);
    stack.redoStack = [...stack.redoStack, command];
    // Capture the undo-stack array reference AFTER the move so
    // the rollback can tell whether an interleaved action replaced it (identity
    // guard) before blind-restoring the pre-undo snapshot.
    const undoStackRef = stack.undoStack;
    // Mark the board the command actually mutates (its target), not the
    // possibly-just-switched active board.
    const dirtyId = command.targetBoardId || activeBoardId;
    if (dirtyId) boardStore.markDirty(dirtyId);
    // Only the cross-board auto-switch path needs the async
    // scope-settle; the common same-board case keeps its synchronous body so
    // callers/tests still see immediate effects.
    const op = didAutoSwitch
      ? async () => {
          await settleActiveScope(command.targetBoardId);
          await command.undo();
        }
      : () => command.undo();
    return runChained(op).catch((err) => {
      rollbackUndo(command, preUndoStack, undoStackRef, originBoardId);
      if (err instanceof NoteGoneError) {
        toastNoteGone(command, err, 'undo');
        return;
      }
      // See execute(): report before the (mostly unobserved) rethrow.
      reportError('historyStore', err, `Undo of "${command.description}" failed and was rolled back.`);
      throw err;
    });
  },

  /**
   * Redoes the most recently undone command on the active board.
   *
   * Same target-board guard as undo(); async via `runChained`.
   */
  redo(): Promise<void> {
    const stack = getActiveStack();
    if (!stack || stack.redoStack.length === 0) return Promise.resolve();
    const command = stack.redoStack[stack.redoStack.length - 1];
    if (!command) return Promise.resolve(); // length checked above; narrow for the type-checker
    // See undo(): capture the board whose stack we mutate
    // before a cross-board auto-switch flips `activeBoardId`.
    const originBoardId = activeBoardId;
    let didAutoSwitch = false;
    if (command.targetBoardId && command.targetBoardId !== activeBoardId) {
      // Symmetric with undo(): auto-switch to the originating
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
    // Snapshot the redo stack BEFORE the move so a body failure can
    // restore it, symmetric with `undo()` above.
    const preRedoStack = [...stack.redoStack];
    stack.redoStack = stack.redoStack.slice(0, -1);
    pushBoundedAndNotify(stack, command);
    // Capture the redo-stack array reference AFTER the move (see
    // undo()): the rollback identity-guards it before blind-restoring.
    const redoStackRef = stack.redoStack;
    const dirtyId = command.targetBoardId || activeBoardId;
    if (dirtyId) boardStore.markDirty(dirtyId);
    // See undo(): settle the scope onto targetBoardId before
    // re-running a facade body on a cross-board redo; same-board keeps sync.
    const op = didAutoSwitch
      ? async () => {
          await settleActiveScope(command.targetBoardId);
          await command.execute();
        }
      : () => command.execute();
    return runChained(op).catch((err) => {
      rollbackRedo(command, preRedoStack, redoStackRef, originBoardId);
      if (err instanceof NoteGoneError) {
        toastNoteGone(command, err, 'redo');
        return;
      }
      // See execute(): report before the (mostly unobserved) rethrow.
      reportError('historyStore', err, `Redo of "${command.description}" failed and was rolled back.`);
      throw err;
    });
  },

  /**
   * Pushes a command onto the undo stack WITHOUT executing it.
   * Used when the mutation has already been applied (e.g., during drag/resize
   * where changes happen in real-time and we only need the command for undo/redo).
   */
  pushWithoutExecute(command: Command) {
    const stack = getOrCreateActiveStack();
    if (stack) {
      pushBoundedAndNotify(stack, command);
      clearRedoStack(stack);
    }
    if (activeBoardId) boardStore.markDirty(activeBoardId);
  },

  /**
   * Pushes a command onto a SPECIFIC board's undo stack WITHOUT executing it
   * (the mutation has already been applied). Used by the TileHeader
   * teardown-time title commit: an unmount during a board switch runs after
   * the pane's scope has moved, so the command must land on the tile's HOME
   * board's stack, not the globally active one. Lazy-creates the stack. No-op
   * when `boardId` is empty.
   *
   * The command's own `targetBoardId` should match `boardId` (the caller sets
   * `extras.boardId`), so a later cross-board undo/redo auto-switches correctly.
   */
  pushWithoutExecuteOnBoard(command: Command, boardId: string | null) {
    if (!boardId) return;
    let stack = stacks[boardId];
    if (!stack) {
      stack = { undoStack: [], redoStack: [] };
      stacks[boardId] = stack;
    }
    pushBoundedAndNotify(stack, command, boardId);
    clearRedoStack(stack);
    boardStore.markDirty(boardId);
  },

  /**
   * Clears history for all boards (e.g. when loading a new project).
   */
  clear() {
    stacks = {};
    for (const k of Object.keys(truncationNotified)) delete truncationNotified[k];
    staleToastShown = false;
  },

  /**
   * An external edit replaced in-memory state for a file, so the
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
   * History is filed by the GLOBAL active board, not the command's
   * `targetBoardId`, so a command mutating board B can sit on board A's stack.
   * Left there after B is gone, it would wedge A's undo behind a switch-back
   * toast forever — so every surviving stack is swept of commands targeting
   * the removed board.
   */
  clearBoard(boardId: string) {
    delete stacks[boardId];
    delete truncationNotified[boardId];
    for (const id of Object.keys(stacks)) {
      const stack = stacks[id];
      if (!stack) continue;
      mutateStack(stack, (s) => {
        s.undoStack = s.undoStack.filter((c) => c.targetBoardId !== boardId);
        s.redoStack = s.redoStack.filter((c) => c.targetBoardId !== boardId);
      });
    }
  },

  /**
   * Updates the per-board undo cap. Called from the App-level settings
   * $effect when `settings.general.historyLimit` changes. Lowering the cap
   * truncates every existing stack to the new length so the new ceiling
   * applies immediately — the truncationNotified guard resets per board so
   * the first push past the new cap can still emit one info toast.
   */
  setMaxHistory(next: number) {
    const clamped = Math.max(10, Math.min(5000, Math.floor(next)));
    if (clamped === maxHistory) return;
    maxHistory = clamped;
    let truncated = false;
    for (const id of Object.keys(stacks)) {
      const stack = stacks[id];
      if (!stack) continue;
      const { droppedCount } = mutateStack(stack, (st) => {
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
      // new cap can still emit one "limit reached" toast.
      for (const k of Object.keys(truncationNotified)) delete truncationNotified[k];
    }
  },
};

// A renamed or moved file: every command on every stack (boards and Document
// tabs alike) follows it, so an undo after the rename reaches the file at its
// new path instead of failing on the old one. Both the in-app rename and the
// external-rename cascade fire this sweep.
registerPathRenamable('history', (oldRel, newRel) => {
  for (const stack of Object.values(stacks)) {
    for (const command of [...stack.undoStack, ...stack.redoStack]) {
      try {
        command.renamePath(oldRel, newRel);
      } catch (err) {
        console.error(`[historyStore] "${command.description}" couldn't follow the rename of "${oldRel}":`, err);
      }
    }
  }
});

// Vault-swap reset: drops every per-board undo/redo stack so a Ctrl+Z in the
// new vault can't replay against ids that no longer exist. Also resets
// `pendingChain` / `chainInflightDepth` so the new vault doesn't queue bodies
// behind a chain still tethered to the outgoing vault's commands.
onVaultSwap('pre-swap', 'history', () => {
  historyStore.clear();
  // The outgoing vault's board is no longer shown. Left set, a vault opened
  // with no board on screen would file its commands under that board's id,
  // where no undo can reach them. The next board shown sets it again.
  activeBoardId = null;
  pendingChain = Promise.resolve();
  chainInflightDepth = 0;
  // Orphan any settle handler still tethered to an
  // outgoing-vault command body so its late settle can't decrement the
  // fresh counter to -1 (see `chainGeneration`).
  chainGeneration++;
});

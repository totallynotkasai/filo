import { boardStore } from './board.svelte';
import { uiStore } from './ui.svelte';
import { onVaultSwap } from '../core/vaultLifecycle';
import { Command } from '../commands/Command';

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
 * Lazy-create the active board's stack on first write. Used from
 * `execute` and `pushWithoutExecute` — paths that are already mutating
 * `$state` so the write here is unambiguous. `undo` and `redo` use
 * `getActiveStack` (pure read) because they correctly early-return when
 * no stack exists.
 */
function getOrCreateActiveStack(): HistoryStack | null {
  if (!activeBoardId) return null;
  if (!stacks[activeBoardId]) {
    stacks[activeBoardId] = { undoStack: [], redoStack: [] };
  }
  return stacks[activeBoardId];
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
    const p = result as Promise<void>;
    const settled = p.then(
      () => { chainInflightDepth--; },
      (err) => { chainInflightDepth--; throw err; },
    );
    pendingChain = settled.then(() => undefined, () => undefined);
    return p;
  }
  // Prior async op still in flight — queue this body so its own internal
  // awaits can't interleave with the prior command's.
  chainInflightDepth++;
  const next = pendingChain.then(() => op());
  const settled = next.then(
    () => { chainInflightDepth--; },
    (err) => { chainInflightDepth--; throw err; },
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
  if (stack.redoStack.length === 0) return;
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
function commitExecute(command: Command): { preRedoStack: Command[] } {
  const stack = getOrCreateActiveStack();
  if (!stack) return { preRedoStack: [] };
  // Snapshot the redo stack BEFORE clearing so a body failure can restore
  // it. Pure array copy — entries are Command instances, snapshot is by
  // reference (the contents are immutable from this scope).
  const preRedoStack = [...stack.redoStack];
  pushBoundedAndNotify(stack, command);
  clearRedoStackAndNotify(stack);
  if (activeBoardId) boardStore.markDirty(activeBoardId);
  return { preRedoStack };
}

/**
 * Phase R3 — undoes `commitExecute` when the body throws / rejects.
 * Removes `command` from the undo stack (lastIndexOf so a same-instance
 * push-twice scenario only rolls back the last one) and restores the
 * pre-execute redo stack. Idempotent on the active board: if the stack
 * is gone (vault swap mid-flight), no-op.
 */
function rollbackExecute(command: Command, preRedoStack: Command[]): void {
  const stack = getActiveStack();
  if (!stack) return;
  const idx = stack.undoStack.lastIndexOf(command);
  if (idx >= 0) {
    stack.undoStack = [
      ...stack.undoStack.slice(0, idx),
      ...stack.undoStack.slice(idx + 1),
    ];
  }
  stack.redoStack = preRedoStack;
  if (activeBoardId) boardStore.markDirty(activeBoardId);
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
function rollbackUndo(command: Command, preUndoStack: Command[]): void {
  const stack = getActiveStack();
  if (!stack) return;
  const idx = stack.redoStack.lastIndexOf(command);
  if (idx >= 0) {
    stack.redoStack = [
      ...stack.redoStack.slice(0, idx),
      ...stack.redoStack.slice(idx + 1),
    ];
  }
  stack.undoStack = preUndoStack;
  if (activeBoardId) boardStore.markDirty(activeBoardId);
}

/**
 * UR-1 — symmetric counterpart for `redo()`. `redo()` popped `command` off the
 * redo stack and pushed it onto the undo stack (via `pushBoundedAndNotify`);
 * on failure we remove it from the undo stack and restore the redo stack to
 * its pre-redo contents. As with `rollbackExecute`, a command dropped from the
 * head by `pushBoundedAndNotify`'s cap is not resurrected — the redo body
 * failing is the rare path and this matches the execute-side contract.
 */
function rollbackRedo(command: Command, preRedoStack: Command[]): void {
  const stack = getActiveStack();
  if (!stack) return;
  const idx = stack.undoStack.lastIndexOf(command);
  if (idx >= 0) {
    stack.undoStack = [
      ...stack.undoStack.slice(0, idx),
      ...stack.undoStack.slice(idx + 1),
    ];
  }
  stack.redoStack = preRedoStack;
  if (activeBoardId) boardStore.markDirty(activeBoardId);
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
   * Sets the active board for history tracking.
   * Called when switching boards.
   */
  setActiveBoard(boardId: string | null) {
    activeBoardId = boardId;
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
    const { preRedoStack } = commitExecute(command);
    return runChained(() => command.execute()).catch((err) => {
      rollbackExecute(command, preRedoStack);
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
    if (command.targetBoardId && command.targetBoardId !== activeBoardId) {
      uiStore.toast(
        `Switch to the originating board to undo this action.`,
        'info',
        3500,
      );
      return Promise.resolve();
    }
    // UR-1 — snapshot the undo stack BEFORE the move so a body failure can
    // restore it (mirror of `commitExecute`/`rollbackExecute`). The stack
    // mutations stay synchronous; only the rollback is deferred to the catch.
    const preUndoStack = [...stack.undoStack];
    stack.undoStack = stack.undoStack.slice(0, -1);
    stack.redoStack = [...stack.redoStack, command];
    if (activeBoardId) boardStore.markDirty(activeBoardId);
    return runChained(() => command.undo()).catch((err) => {
      rollbackUndo(command, preUndoStack);
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
    if (command.targetBoardId && command.targetBoardId !== activeBoardId) {
      uiStore.toast(
        `Switch to the originating board to redo this action.`,
        'info',
        3500,
      );
      return Promise.resolve();
    }
    // UR-1 — snapshot the redo stack BEFORE the move so a body failure can
    // restore it, symmetric with `undo()` above.
    const preRedoStack = [...stack.redoStack];
    stack.redoStack = stack.redoStack.slice(0, -1);
    pushBoundedAndNotify(stack, command);
    if (activeBoardId) boardStore.markDirty(activeBoardId);
    return runChained(() => command.execute()).catch((err) => {
      rollbackRedo(command, preRedoStack);
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
   * Clears history for a specific board (e.g. when deleting a board).
   */
  clearBoard(boardId: string) {
    delete stacks[boardId];
    delete truncationNotified[boardId];
    delete truncationLossNotified[boardId];
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
      const { droppedCount } = mutateStack(stacks[id], id, (st) => {
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
});

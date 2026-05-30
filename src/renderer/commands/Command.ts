/**
 * Abstract Command base class (Phase R3) + companion Command interface.
 *
 * The `Command` *interface* is the public contract used by callers
 * (`historyStore.execute / undo / redo / pushWithoutExecute`). It lists
 * the four members every command exposes: `description`, `execute`,
 * `undo`, and the optional `targetBoardId` / `hasFileSnapshots`.
 *
 * The `Command` *abstract class* implements that interface and adds the
 * `this.snapshot(...)` deep-clone helper. Concrete commands extend the
 * class (not just implement the interface) so they get the helper and
 * are caught by the `check-command-snapshot-discipline.mjs` CI gate.
 *
 * Both share the same name through TypeScript declaration merging — the
 * interface adds members to the class's instance type, and class
 * instances are structurally assignable to plain `Command` references
 * elsewhere in the codebase.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface Command {
  /** Human-readable description of what this command does. */
  description: string;
  /** Execute the command (or re-execute on redo). */
  execute(): void | Promise<void>;
  /** Reverse the command. */
  undo(): void | Promise<void>;
  /**
   * Phase 31 A6.3 — board the command targets. The undo/redo dispatcher
   * refuses to fire the command unless the provided board matches the
   * currently-active one. Without this, `UpdateBoardSettingsCommand`
   * (and similar board-scoped mutations) would happily replay against
   * whichever board is open when the user hits Ctrl+Z — destroying
   * settings on board B because a redo intended for board A was still
   * on the per-board stack via shared per-board stack lookup.
   *
   * Phase 2 (IMPLEMENTATION_PLAN_2026-05-27) — promoted from optional to
   * mandatory. Every Command constructor now captures the originating
   * board at construction time so a cross-board undo/redo from another
   * board's stack surfaces a "switch back to originate" toast instead
   * of silently mutating the wrong target. Board-agnostic commands set
   * the field to `''` (empty string), which the dispatcher treats as
   * "no guard required" (same as the prior `undefined` semantics).
   */
  readonly targetBoardId: string;
  /**
   * Phase 3 / 3.8 — opt-in flag declaring that this command carries
   * pre-delete file body snapshots whose loss on history truncation
   * means file content becomes irrecoverable. The history truncation
   * notification escalates from the standard "earlier actions are no
   * longer reversible" toast to the more pointed "deleted files older
   * than this point cannot be restored" toast when a dropped command
   * returns `true` here.
   *
   * Optional so commands without file-snapshot semantics don't have
   * to implement it.
   */
  hasFileSnapshots?(): boolean;
}

/**
 * Phase R3 — abstract base class. Concrete commands extend it to inherit
 * `this.snapshot(...)`, which is the single deep-clone helper for every
 * snapshot field stored on a command instance.
 *
 * Pre-R3, command constructors used inline `JSON.parse(JSON.stringify(value))`
 * for some fields and shallow `{...value}` for others — the discipline was
 * known but not enforced. The audit found three sites where a shallow copy
 * let a post-construction mutation of the caller-side object leak into the
 * snapshot, corrupting undo. The base class + CI gate
 * (`check-command-snapshot-discipline.mjs`) forbid inline JSON.parse +
 * shallow spread on `this.<field>` assignments in command constructors
 * without an explicit `// allow-shallow:` annotation.
 *
 * Concrete commands DO need to:
 *   - declare `description` (typed string) as an instance field set in the
 *     constructor (TypeScript structural typing satisfies the interface),
 *   - implement `execute()` and `undo()`,
 *   - optionally override `hasFileSnapshots()` to return `true` when they
 *     carry file body snapshots,
 *   - declare `readonly targetBoardId: string` and assign it in the
 *     constructor (mandatory since Phase 2). The typical assignment is
 *     `this.targetBoardId = boardId ?? boardStore.current?.id ?? '';` —
 *     callers that know the originating board pass it explicitly; the
 *     fallback covers internal callers that have no choice but to use
 *     the active board.
 */
/**
 * Standalone deep-clone used by `Command.snapshot` and by the module-level
 * snapshot helpers in `kanbanCommands.ts` / `taskCommands.ts` that can't reach
 * the `protected` instance method. Keeping a single exported implementation
 * means there is still exactly ONE deep-clone to audit (M3, 2026-05-28).
 *
 * Uses the JSON round-trip rather than `structuredClone` for the same reason
 * the instance method does: Svelte 5 `$state` Proxies throw `DataCloneError`
 * under `structuredClone`, while the round-trip detaches every nested
 * object/array reference — exactly what a snapshot needs so a later in-place
 * mutation of a nested `style` / `coverImage` can't leak into the retained
 * undo snapshot.
 */
export function cloneForSnapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export abstract class Command {
  // Note: `hasFileSnapshots()` lives on the merged interface as an
  // optional method (so callers reach it via `command.hasFileSnapshots?.()`
  // and absence implies false). Concrete subclasses that DO carry file
  // bodies (DeleteTilesCommand, CascadeDeleteCommand, ReplaceAllCommand)
  // override it on the subclass directly. We deliberately don't declare
  // a default-returning-false implementation on the class because
  // TypeScript's "Overload signatures must all be optional or required"
  // rule forbids a class method overlapping with the interface's optional
  // declaration.

  /**
   * Deep-clone helper. Every snapshot field on a command MUST go through
   * this method. The CI gate `check-command-snapshot-discipline.mjs`
   * enforces that constructors assigning `this.<field> = <param>` either
   * route through `this.snapshot(...)` or annotate the line with
   * `// allow-shallow: <reason>` for the cases where shallow copy is
   * deliberately correct (primitives, brand-new IDs, etc.).
   *
   * Uses JSON round-trip rather than `structuredClone` because Svelte 5
   * `$state` Proxies throw `DataCloneError` under `structuredClone`. The
   * round-trip detaches every nested object/array reference, which is
   * exactly the property the audit needs (a tag/style edit between
   * execute() and undo() cannot leak into the would-be-restored snapshot).
   *
   * Trade-off: JSON.stringify drops `undefined` fields and Map / Set / Date
   * objects. Concrete commands that need to preserve those shapes should
   * either reshape before snapshotting (Map → array of entries) or document
   * the data shape in a comment so reviewers can confirm round-trip
   * fidelity.
   */
  protected snapshot<T>(value: T): T {
    return cloneForSnapshot(value);
  }
}

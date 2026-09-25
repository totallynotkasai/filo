/**
 * Abstract Command base class + companion Command interface.
 *
 * The `Command` *interface* is the public contract used by callers
 * (`historyStore.execute / undo / redo / pushWithoutExecute`). It lists
 * the members every command exposes: `description`, `execute`, `undo` and
 * `targetBoardId`.
 *
 * The `Command` *abstract class* implements that interface and adds the
 * `this.snapshot(...)` deep-clone helper. Concrete commands extend the
 * class (not just implement the interface) so they get the helper and
 * are caught by the `scripts/gates:command-snapshot-discipline` CI gate.
 *
 * Both share the same name through TypeScript declaration merging — the
 * interface adds members to the class's instance type, and class
 * instances are structurally assignable to plain `Command` references
 * elsewhere in the codebase.
 *
 * The class deliberately does NOT add a `markBoardDirty()` helper: importing
 * `boardCacheStore` here closes a cycle (Command → boardCache.svelte →
 * vaultExternalChanges → fileTags → commands/index → tileCommands → extends
 * Command) that breaks class evaluation. Instead each command file calls
 * `boardCacheStore.markDirty(this.targetBoardId)` directly, and the CI gate
 * `scripts/gates:command-targets-self` enforces the `this.targetBoardId` argument.
 */
import { rebaseCommandFields } from './commandPaths';

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface Command {
  /** Human-readable description of what this command does. */
  description: string;
  /** Execute the command (or re-execute on redo). */
  execute(): void | Promise<void>;
  /** Reverse the command. */
  undo(): void | Promise<void>;
  /**
   * Board the command targets, captured at construction. The undo/redo
   * dispatcher refuses to fire the command unless it matches the active
   * board (surfacing a "switch back" toast), so a cross-board undo/redo
   * can't silently mutate the wrong board. Board-agnostic commands set `''`,
   * which the dispatcher treats as "no guard required".
   */
  readonly targetBoardId: string;
}

/**
 * Abstract base class. Concrete commands extend it to inherit
 * `this.snapshot(...)`, the single deep-clone helper for every snapshot field
 * stored on a command instance. A shallow copy lets a post-construction
 * mutation of the caller's object leak into the snapshot and corrupt undo, so
 * the CI gate (`scripts/gates:command-snapshot-discipline`) forbids inline
 * JSON.parse / shallow spread on `this.<field>` assignments in command
 * constructors without an explicit `// allow-shallow:` annotation.
 *
 * Concrete commands DO need to:
 *   - declare `description` (typed string) as an instance field set in the
 *     constructor (TypeScript structural typing satisfies the interface),
 *   - implement `execute()` and `undo()`,
 *   - declare `readonly targetBoardId: string` and assign it in the
 *     constructor. The typical assignment is
 *     `this.targetBoardId = boardId ?? boardStore.current?.id ?? '';` —
 *     callers that know the originating board pass it explicitly; the
 *     fallback covers internal callers that have no choice but to use
 *     the active board.
 */
/**
 * Standalone deep-clone used by `Command.snapshot` and by the module-level
 * snapshot helpers in `kanbanCommands.ts` / `taskCommands.ts` that can't reach
 * the `protected` instance method, so there is exactly ONE deep-clone.
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
  /**
   * Deep-clone helper. Every snapshot field on a command MUST go through
   * this method. The CI gate `scripts/gates:command-snapshot-discipline`
   * enforces that constructors assigning `this.<field> = <param>` either
   * route through `this.snapshot(...)` or annotate the line with
   * `// allow-shallow: <reason>` for the cases where shallow copy is
   * deliberately correct (primitives, brand-new IDs, etc.).
   *
   * Uses JSON round-trip rather than `structuredClone` because Svelte 5
   * `$state` Proxies throw `DataCloneError` under `structuredClone`. The
   * round-trip detaches every nested object/array reference, so a tag/style
   * edit between execute() and undo() cannot leak into the snapshot.
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

  /**
   * `oldRel` (a file, or a folder above it) was renamed to `newRel`: every
   * path the command holds now names the file where it is, so its undo and
   * redo act on the file at its new path. The history store calls it on every
   * command it holds after each rename. `pinned` paths (files a parent
   * command holds in Filo's trash) stay as they are.
   *
   * The default rewrites every path held under a path field name
   * (`commandPaths.ts`: `PATH_FIELDS`), snapshots and child commands
   * included. Override when a path must not follow (see `RenameFileCommand`).
   */
  renamePath(oldRel: string, newRel: string, pinned: readonly string[] = []): void {
    rebaseCommandFields(this, oldRel, newRel, pinned);
  }
}

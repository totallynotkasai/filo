import { Command } from './Command';
import { boardCacheStore } from '../stores/boardCache.svelte';
import { noteStore } from '../stores/notes.svelte';
import { patchToFrontmatterDelta, type FrontmatterDelta } from '../lib/vault/frontmatterDelta';
import { captureVaultIdentity, isStillSameVault } from '../lib/vault/vaultIdentity';
import { applyDeltaChecked, inverseDelta } from './frontmatterInverse';

/**
 * An undoable change to fields in a note's frontmatter (a card's due date, a
 * task's `completed`, a title). The note is named by its path; the change
 * goes to the note writer as a delta, so it lands on a fresh read of the file
 * and keys it doesn't name are kept.
 *
 * - First execute: the user's own action. The inverse delta is taken from the
 *   note as it stands, so undo restores the true prior value even when the
 *   caller built the command from a stale index.
 * - Undo and redo: the inverse (or forward) delta, checked against the note as
 *   it stands then. A field another program changed meanwhile keeps that
 *   value, with an "Apply anyway" toast.
 *
 * An empty value in the patch clears the key (see `patchToFrontmatterDelta`).
 */
export abstract class NoteFieldCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  protected readonly relPath: string;
  private forward: FrontmatterDelta;
  private inverse: FrontmatterDelta;
  private hasExecuted = false;
  /**
   * Treat the change as one unit on a conflict (a recurrence roll-forward
   * writes `completed` and `dueDate` together and must never half-apply).
   */
  private atomic: boolean;

  constructor(
    boardId: string,
    relPath: string,
    patch: Record<string, unknown>,
    inversePatch: Record<string, unknown>,
    description: string,
    atomic = false,
  ) {
    super();
    this.targetBoardId = boardId;
    this.relPath = relPath;
    // Deep-cloned so nested values (`tags: [...]`) can't change through the
    // caller's reference after the command is pushed.
    this.forward = this.snapshot(patchToFrontmatterDelta(patch));
    this.inverse = this.snapshot(patchToFrontmatterDelta(inversePatch));
    this.description = description;
    this.atomic = atomic;
  }

  async execute(): Promise<void> {
    if (this.hasExecuted) {
      await this.apply(this.forward, this.inverse);
      return;
    }
    this.hasExecuted = true;
    const identity = captureVaultIdentity();
    const before = await noteStore.currentFrontmatter(this.relPath);
    // A vault swap landed during the read: the note belongs to the old vault.
    if (!isStillSameVault(identity)) return;
    if (before) this.inverse = this.snapshot(inverseDelta(before, this.forward));
    noteStore.patchFrontmatter(this.relPath, this.forward);
    boardCacheStore.markDirty(this.targetBoardId);
  }

  async undo(): Promise<void> {
    await this.apply(this.inverse, this.forward);
  }

  private apply(delta: FrontmatterDelta, expected: FrontmatterDelta): Promise<void> {
    return applyDeltaChecked({
      relPath: this.relPath,
      targetBoardId: this.targetBoardId,
      delta,
      expected,
      label: this.relPath,
      atomic: this.atomic,
    });
  }
}

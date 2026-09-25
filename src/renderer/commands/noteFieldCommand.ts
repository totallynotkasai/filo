import { Command } from './Command';
import { boardCacheStore } from '../stores/boardCache.svelte';
import { noteStore } from '../stores/notes.svelte';
import { patchToFrontmatterDelta } from '../lib/vault/frontmatterDelta';
import { captureVaultIdentity, isStillSameVault } from '../lib/vault/vaultIdentity';
import { applyFrontmatterPatchRebased, inverseOfPatch } from './frontmatterRebase';

/**
 * An undoable change to fields in a note's frontmatter (a card's due date, a
 * task's `completed`, a title). The note is named by its path; the change
 * goes to the note writer as a delta, so it lands on a fresh read of the file
 * and keys it doesn't name are kept.
 *
 * - First execute: the user's own action. The inverse is recomputed from the
 *   note as it stands, so undo restores the true prior value even when the
 *   caller built the command from a stale index.
 * - Undo and redo: rebased on the note as it stands then. A field another
 *   program changed meanwhile keeps that value, with an "Apply anyway" toast.
 *
 * An empty value in the patch clears the key (see `patchToFrontmatterDelta`).
 */
export abstract class NoteFieldCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  protected readonly relPath: string;
  private patch: Record<string, unknown>;
  private inversePatch: Record<string, unknown>;
  private hasExecuted = false;
  /**
   * Treat the patch as one unit on a conflict (a recurrence roll-forward
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
    this.patch = this.snapshot(patch);
    this.inversePatch = this.snapshot(inversePatch);
    this.description = description;
    this.atomic = atomic;
  }

  async execute(): Promise<void> {
    if (this.hasExecuted) {
      await this.rebase(this.patch, this.inversePatch);
      return;
    }
    this.hasExecuted = true;
    const identity = captureVaultIdentity();
    const before = await noteStore.currentFrontmatter(this.relPath);
    // A vault swap landed during the read: the note belongs to the old vault.
    if (!isStillSameVault(identity)) return;
    if (before) this.inversePatch = this.snapshot(inverseOfPatch(before, this.patch));
    noteStore.patchFrontmatter(this.relPath, patchToFrontmatterDelta(this.patch));
    boardCacheStore.markDirty(this.targetBoardId);
  }

  async undo(): Promise<void> {
    await this.rebase(this.inversePatch, this.patch);
  }

  private rebase(applying: Record<string, unknown>, expectedCurrent: Record<string, unknown>): Promise<void> {
    return applyFrontmatterPatchRebased({
      relPath: this.relPath,
      targetBoardId: this.targetBoardId,
      applying,
      expectedCurrent,
      label: this.relPath,
      atomic: this.atomic,
    });
  }
}

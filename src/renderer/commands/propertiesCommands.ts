/**
 * An undoable edit of a note's frontmatter, as a before and an after
 * snapshot of the keys it touches. The Document tab's tag row pushes one per
 * tag change.
 *
 * Each leg goes to the note writer as a delta (applied to a fresh read of the
 * existing file, so undo can't resurrect a deleted file). Deltas to one note
 * queue in order and merge, so a rapid Apply → Undo can't race.
 */

import { Command } from './Command';
import { boardStore } from '../stores/board.svelte';
import { applyDeltaChecked, fmValueEqual } from './frontmatterInverse';
import { type FrontmatterDelta } from '../lib/vault/frontmatterDelta';

export interface PropertiesSnapshot {
  kind: 'frontmatter';
  relPath: string;
  fm: Record<string, unknown>;
}

export class UpdatePropertiesCommand extends Command {
  description: string;
  /**
   * The originating board: execute/undo always mark THIS board dirty, never
   * whichever board is active at redo time.
   */
  readonly targetBoardId: string;
  private before: PropertiesSnapshot;
  private after: PropertiesSnapshot;

  // allow-board-store-current: constructor fallback for callers that didn't capture an explicit boardId
  constructor(before: PropertiesSnapshot, after: PropertiesSnapshot, boardId?: string) {
    super();
    this.targetBoardId = boardId ?? boardStore.current?.id ?? '';
    this.before = this.cloneSnapshot(before);
    this.after = this.cloneSnapshot(after);
    this.description = `Update properties`;
  }

  private cloneSnapshot(snap: PropertiesSnapshot): PropertiesSnapshot {
    return {
      kind: 'frontmatter',
      relPath: snap.relPath,
      // Detaches every nested key/value in the frontmatter map.
      fm: this.snapshot(snap.fm),
    };
  }

  async execute(): Promise<void> {
    // Pass BOTH legs so the frontmatter apply can rebase: it diffs
    // after-vs-before to learn which keys this command OWNS, then merges only
    // those onto the LIVE frontmatter, preserving any other (e.g. external) key.
    await applySnapshot(this.after, this.before);
  }

  async undo(): Promise<void> {
    await applySnapshot(this.before, this.after);
  }

  /** Only the note's frontmatter changes. */
  changesBoardFile(): boolean {
    return false;
  }
}

/**
 * The delta that puts each of `keys` at its value in `fm`; an empty or
 * absent value removes the key (the user "clearing" a property).
 */
function deltaForKeys(fm: Record<string, unknown>, keys: string[]): FrontmatterDelta {
  const delta: FrontmatterDelta = { set: {}, unset: [] };
  for (const k of keys) {
    const v = fm[k];
    if (k in fm && v !== '' && v !== null && v !== undefined) delta.set[k] = v;
    else delta.unset.push(k);
  }
  return delta;
}

/**
 * Applies one leg of an `UpdatePropertiesCommand`.
 *
 * `target` is the snapshot this leg wants; `other` is the opposite leg. It
 * sends a delta:
 *
 *   - The keys this command OWNS = those that differ between the two legs.
 *     Only those go to the note writer, so every other key (including one
 *     another program added since) stays.
 *   - A key an external edit moved away from what the opposite leg left keeps
 *     the external value, with "Apply anyway" (no silent clobber).
 *   - A note that can't be read rejects, so history drops the command.
 */
async function applySnapshot(
  target: PropertiesSnapshot,
  other: PropertiesSnapshot,
): Promise<void> {
  const targetFm = target.fm;
  const otherFm = other.fm;
  const ownedKeys: string[] = [];
  for (const k of new Set([...Object.keys(targetFm), ...Object.keys(otherFm)])) {
    if (!fmValueEqual(otherFm[k], targetFm[k])) ownedKeys.push(k);
  }
  if (ownedKeys.length === 0) return;
  await applyDeltaChecked({
    relPath: target.relPath,
    delta: deltaForKeys(targetFm, ownedKeys),
    expected: deltaForKeys(otherFm, ownedKeys),
    label: target.relPath,
    whenUnreadable: 'throw',
  });
}

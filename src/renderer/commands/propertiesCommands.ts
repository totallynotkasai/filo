/**
 * Undoable PropertiesPopup edits.
 *
 * One `UpdatePropertiesCommand` is pushed per popup session (when it closes
 * after the user touched a row); per-keystroke commands would blow through
 * MAX_HISTORY and don't match the user's mental model.
 *
 * Snapshots capture the metadata source for the tile's type:
 *  - text tiles → frontmatter (canonical source, lives on disk)
 *  - non-text tiles → `tile.metadata` (lives in board JSON)
 *
 * For text tiles each leg goes to the note writer as a delta (applied to a
 * fresh read of the existing file, so undo can't resurrect a deleted file).
 * Deltas to one note queue in order and merge, so a rapid Apply → Undo can't
 * race.
 */

import { Command } from './Command';
import { boardStore } from '../stores/board.svelte';
import { boardCacheStore } from '../stores/boardCache.svelte';
import { noteStore } from '../stores/notes.svelte';
import type { Tile } from '../schema/index';
import { reportError } from '../lib/utils/errorBus';
import { uiStore } from '../stores/ui.svelte';
import { fmValueEqual } from './frontmatterRebase';
import { type FrontmatterDelta } from '../lib/vault/frontmatterDelta';
import { captureVaultIdentity, isStillSameVault } from '../lib/vault/vaultIdentity';

export type PropertiesSnapshot =
  | { kind: 'frontmatter'; relPath: string; fm: Record<string, unknown> }
  | { kind: 'metadata'; tileId: string; metadata: Record<string, unknown> };

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
    if (snap.kind === 'frontmatter') {
      return {
        kind: 'frontmatter',
        relPath: snap.relPath,
        // Detaches every nested key/value in the frontmatter map.
        fm: this.snapshot(snap.fm),
      };
    }
    return {
      kind: 'metadata',
      tileId: snap.tileId,
      metadata: this.snapshot(snap.metadata),
    };
  }

  async execute(): Promise<void> {
    // Pass BOTH legs so the frontmatter apply can rebase: it diffs
    // after-vs-before to learn which keys this command OWNS, then merges only
    // those onto the LIVE frontmatter, preserving any other (e.g. external) key.
    await applySnapshot(this.after, this.before, this.targetBoardId);
    // Dirty the ORIGINATING board, not whichever board is active at redo time.
    boardCacheStore.markDirty(this.targetBoardId);
  }

  async undo(): Promise<void> {
    await applySnapshot(this.before, this.after, this.targetBoardId);
    boardCacheStore.markDirty(this.targetBoardId);
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
 * `target` is the snapshot this leg wants; `other` is the opposite leg. The
 * metadata kind (non-text tiles, board file) is applied wholesale. The
 * frontmatter kind (a note's YAML) is REBASED:
 *
 *   - The keys this command OWNS = those that differ between the two legs.
 *     Only those go to the note writer, so every other key (including one
 *     another program added since) stays.
 *   - Conflicts: if an external edit moved an owned field away from what the
 *     opposite leg left it at, KEEP the external value and offer "Apply
 *     anyway" (no silent clobber).
 */
async function applySnapshot(
  target: PropertiesSnapshot,
  other: PropertiesSnapshot,
  targetBoardId: string,
): Promise<void> {
  if (target.kind === 'metadata') {
    boardStore.updateTile(target.tileId, { metadata: { ...target.metadata } } as Partial<Tile>);
    return;
  }
  const identity = captureVaultIdentity();
  const { relPath } = target;
  const targetFm = target.fm;
  const otherFm = other.kind === 'frontmatter' ? other.fm : {};

  const ownedKeys: string[] = [];
  for (const k of new Set([...Object.keys(targetFm), ...Object.keys(otherFm)])) {
    if (!fmValueEqual(otherFm[k], targetFm[k])) ownedKeys.push(k);
  }

  const base = await noteStore.currentFrontmatter(relPath);
  if (!isStillSameVault(identity)) return;
  if (base === null) {
    // The note is gone or unreadable: nothing to rebase on, and the change
    // can't land. Reject so history drops the command.
    const err = new Error(`Could not read ${relPath} to apply properties.`);
    reportError('updateProperties', err, `Failed to apply properties to ${relPath}`);
    throw err;
  }

  const conflicts = ownedKeys.filter((k) => !fmValueEqual(base[k], otherFm[k]));
  const safe = ownedKeys.filter((k) => !conflicts.includes(k));
  if (safe.length > 0) noteStore.patchFrontmatter(relPath, deltaForKeys(targetFm, safe));

  if (conflicts.length > 0) {
    uiStore.pushToast({
      text: `External edit changed ${conflicts.join(', ')} in ${relPath}. Kept the external value — that field's undo/redo was skipped.`,
      type: 'warning',
      duration: 0,
      actions: [
        {
          label: 'Apply anyway',
          handler: () => {
            // The toast can be clicked after a vault swap; bail so the outgoing
            // vault's patch never lands on the new vault's same-named file.
            if (!isStillSameVault(identity)) return;
            noteStore.patchFrontmatter(relPath, deltaForKeys(targetFm, conflicts));
            // allow-non-target-markdirty: module helper, callers pass this.targetBoardId per the CI gate
            boardCacheStore.markDirty(targetBoardId);
          },
        },
      ],
    });
  }
}

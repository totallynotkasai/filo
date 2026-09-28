import { Command } from './Command';
import { boardStore } from '../stores/board.svelte';
import { fileTagsStore } from '../stores/fileTags.svelte';

/**
 * Tag-driven tile commands, all dispatched by `fileTagsStore`. Covers
 * fade-by-tag plus the undoable tile-mode and path-mode tag add/remove pairs.
 *
 * `fileTagsStore` is referenced inside execute/undo (not at module load) so
 * the circular import (fileTags.svelte.ts → commands/index.ts → here → back)
 * resolves through ES module live bindings.
 */

/**
 * Toggles faded state for a set of tiles (typically all tiles with a given tag).
 * Stores previous faded states for clean undo.
 */
export class ToggleTagFadeCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private tileIds: string[];
  private targetFaded: boolean;
  private previousStates: Map<string, boolean>;

  constructor(tileIds: string[], targetFaded: boolean, tagName: string, boardId?: string) {
    super();
    this.targetBoardId = boardId ?? boardStore.current?.id ?? '';
    // allow-shallow: tileIds are primitive strings.
    this.tileIds = [...tileIds];
    this.targetFaded = targetFaded;
    this.description = `${targetFaded ? 'Fade' : 'Unfade'} tiles with tag "${tagName}"`;

    // Snapshot current faded states for undo
    this.previousStates = new Map();
    for (const id of tileIds) {
      const tile = boardStore.getTile(id);
      if (tile) this.previousStates.set(id, tile.faded);
    }
  }

  execute() {
    boardStore.batchUpdateTiles(
      this.tileIds
        .filter(id => boardStore.getTile(id))
        .map(id => ({ id, changes: { faded: this.targetFaded } })),
    );
  }

  undo() {
    boardStore.batchUpdateTiles(
      this.tileIds
        .filter(id => boardStore.getTile(id))
        .map(id => ({ id, changes: { faded: this.previousStates.get(id) ?? false } })),
    );
  }
}

// ── Tile Tag Commands ──
//
// The fileTagsStore's public addTagToTile/removeTagFromTile push these
// commands so a Ctrl+Z reverses a single-tile tag change. Global tag rename
// is excluded from history — a single command can't cleanly represent a
// multi-file disk-write batch.

export class AddTileTagCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private tileId: string;
  private tagName: string;

  constructor(tileId: string, tagName: string, boardId?: string) {
    super();
    this.targetBoardId = boardId ?? boardStore.current?.id ?? '';
    this.tileId = tileId;
    this.tagName = tagName;
    this.description = `Add tag "${tagName}"`;
  }

  execute() {
    return fileTagsStore._applyAddTagToTile(this.tileId, this.tagName);
  }

  undo() {
    return fileTagsStore._applyRemoveTagFromTile(this.tileId, this.tagName);
  }
}

export class RemoveTileTagCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private tileId: string;
  private tagName: string;
  // The tag's global colour at construction time. If the global definition is
  // deleted before undo, the inverse re-add (`ensureTag`) would resurrect it
  // with the DEFAULT colour; re-asserting this snapshot first preserves it.
  private snapshotColor: string | undefined;

  constructor(tileId: string, tagName: string, boardId?: string) {
    super();
    this.targetBoardId = boardId ?? boardStore.current?.id ?? '';
    this.tileId = tileId;
    this.tagName = tagName;
    this.snapshotColor = fileTagsStore.getDefinition(tagName)?.color;
    this.description = `Remove tag "${tagName}"`;
  }

  execute() {
    return fileTagsStore._applyRemoveTagFromTile(this.tileId, this.tagName);
  }

  undo() {
    // Re-create the global tag definition with its ORIGINAL colour before
    // the inverse re-add, so a definition deleted in the interim isn't
    // resurrected with the default colour. `ensureTag` is idempotent (no-op when
    // the definition still exists), so this never overrides a colour the user
    // changed since. The tile's tag-array membership is restored by the inverse
    // `_applyAddTagToTile` — deliberately NOT a full prior-array snapshot: this
    // is a single-tag op, and replaying only this tag preserves any OTHER tag a
    // concurrent action added to the tile between execute and undo (a whole-array
    // restore would clobber it).
    if (this.snapshotColor) fileTagsStore.ensureTag(this.tagName, this.snapshotColor);
    return fileTagsStore._applyAddTagToTile(this.tileId, this.tagName);
  }
}

/**
 * Undoable path-mode tag add. Mirrors the tile-mode pair
 * above but targets a vault-relative file path (Document board / sidebar
 * editor). The write fan-out — three sinks: `.filo/tags.json`, every text
 * tile def, and the file's frontmatter — is the same as the tile-mode
 * path; only the entry point differs.
 */
export class AddPathTagCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private path: string;
  private tagName: string;

  constructor(path: string, tagName: string, boardId?: string) {
    super();
    this.targetBoardId = boardId ?? boardStore.current?.id ?? '';
    this.path = path;
    this.tagName = tagName;
    this.description = `Add tag "${tagName}"`;
  }

  execute() {
    return fileTagsStore._applyAddTagToPath(this.path, this.tagName);
  }

  undo() {
    return fileTagsStore._applyRemoveTagFromPath(this.path, this.tagName);
  }
}

export class RemovePathTagCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private path: string;
  private tagName: string;
  // See RemoveTileTagCommand: snapshot the tag's global colour
  // so the inverse re-add on undo doesn't resurrect a deleted definition with
  // the default colour.
  private snapshotColor: string | undefined;

  constructor(path: string, tagName: string, boardId?: string) {
    super();
    this.targetBoardId = boardId ?? boardStore.current?.id ?? '';
    this.path = path;
    this.tagName = tagName;
    this.snapshotColor = fileTagsStore.getDefinition(tagName)?.color;
    this.description = `Remove tag "${tagName}"`;
  }

  execute() {
    return fileTagsStore._applyRemoveTagFromPath(this.path, this.tagName);
  }

  undo() {
    // Preserve the original tag colour across the round-trip (see
    // RemoveTileTagCommand.undo). `ensureTag` is idempotent.
    if (this.snapshotColor) fileTagsStore.ensureTag(this.tagName, this.snapshotColor);
    return fileTagsStore._applyAddTagToPath(this.path, this.tagName);
  }
}

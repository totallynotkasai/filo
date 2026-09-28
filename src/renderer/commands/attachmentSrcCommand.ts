/**
 * Undoable src/url/filePath swaps on attachment tiles.
 *
 * Six tile types share a single shape: the user clears or replaces the
 * field that points at the backing file/URL.
 *
 *   - image / video / audio → `src`
 *   - file                  → `filePath` (plus fileName + fileExtension)
 *   - iframe / link         → `url`
 *
 * Without it, "Remove" would destroy the only reference to the backing media
 * with no Ctrl+Z. The command captures the prior fields and the new ones;
 * execute / undo apply them via `boardStore.updateTile`.
 *
 * The command does NOT touch the file on disk — clearing the field only
 * unlinks the tile from the file. The vault file itself stays put (consistent
 * with the rest of Filo's "vault is canonical, board JSON is a placement
 * record" model).
 */

import { Command } from './Command';
import { boardStore } from '../stores/board.svelte';
import type { Tile } from '../schema/index';

/**
 * Per-field snapshot — varies by tile type. Each kind only stores the
 * fields the corresponding mutator writes, so the command stays minimal.
 */
export type AttachmentSrcSnapshot =
  | { kind: 'src'; src: string }
  | { kind: 'src-with-playback'; src: string; isPlaying?: boolean }
  | { kind: 'file'; filePath: string; fileName: string; fileExtension: string }
  | { kind: 'url'; url: string };

export class UpdateAttachmentSrcCommand extends Command {
  description: string;
  readonly targetBoardId: string;
  private tileId: string;
  private before: AttachmentSrcSnapshot;
  private after: AttachmentSrcSnapshot;

  constructor(
    tileId: string,
    before: AttachmentSrcSnapshot,
    after: AttachmentSrcSnapshot,
    description?: string,
    boardId?: string,
  ) {
    super();
    this.targetBoardId = boardId ?? boardStore.current?.id ?? '';
    this.tileId = tileId;
    // Snapshots are flat strings/booleans so deep-clone isn't strictly
    // needed, but `this.snapshot(...)` is the consistent detach across the
    // codebase — keep the same pattern.
    this.before = this.snapshot(before);
    this.after = this.snapshot(after);
    this.description = description ?? 'Update attachment';
  }

  execute() {
    apply(this.tileId, this.after);
  }

  undo() {
    apply(this.tileId, this.before);
  }
}

function apply(tileId: string, snap: AttachmentSrcSnapshot): void {
  if (snap.kind === 'src') {
    boardStore.updateTile(tileId, { src: snap.src } as Partial<Tile>);
    return;
  }
  if (snap.kind === 'src-with-playback') {
    const patch: Record<string, unknown> = { src: snap.src };
    if (snap.isPlaying !== undefined) patch.isPlaying = snap.isPlaying;
    boardStore.updateTile(tileId, patch as Partial<Tile>);
    return;
  }
  if (snap.kind === 'file') {
    boardStore.updateTile(tileId, {
      filePath: snap.filePath,
      fileName: snap.fileName,
      fileExtension: snap.fileExtension,
    } as Partial<Tile>);
    return;
  }
  if (snap.kind === 'url') {
    boardStore.updateTile(tileId, { url: snap.url } as Partial<Tile>);
  }
}

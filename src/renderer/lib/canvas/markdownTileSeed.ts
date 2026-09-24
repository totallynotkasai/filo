import { createId } from '../utils/ids';
import { samePath, stripLeadingSlash, toPosix } from '../utils/path';
import { defaultTileStyleSnapshot } from '../../constants/defaults';
import type { TextTileDef } from '../../schema/index';

/**
 * Result of `buildTextTileDefForNote`.
 *  - `def` is the board's whole record of the note: its path plus visuals.
 *    Mind Map callers layer position/size/locked/faded/boardId on top; Kanban
 *    and Task List callers use the def as-is for their placement writers.
 *  - `duplicate` is `true` when an existing text tile on the board already
 *    shows this file. The caller decides whether to surface a non-blocking
 *    toast; the drop still proceeds either way.
 */
export interface TextTileBuildResult {
  def: TextTileDef;
  duplicate: boolean;
}

/**
 * Builds the text-tile def for an existing note dropped onto a board. The
 * note keeps its title, tags and body in the file, so nothing is read or
 * copied here: the def names the note by path. An OS drop never writes
 * `title:` into the file; the note shows its filename stem until a title is
 * set.
 */
export function buildTextTileDefForNote(args: {
  /** Vault-relative path of the dropped file (e.g. `Notes/Foo.md`). */
  vaultRelPath: string;
  /** Existing tiles on the board, used for duplicate detection. */
  existingTiles: ReadonlyArray<{ type: string; filePath?: string }>;
  /** Optional tileId override (defaults to a fresh `createId()`). */
  tileId?: string;
  /** Optional timestamp override (defaults to `Date.now()`). */
  now?: number;
}): TextTileBuildResult {
  const filePath = stripLeadingSlash(toPosix(args.vaultRelPath));
  const duplicate = args.existingTiles.some(
    (t) => t.type === 'text' && typeof t.filePath === 'string' && samePath(t.filePath, filePath),
  );
  const now = args.now ?? Date.now();
  const def: TextTileDef = {
    id: args.tileId ?? createId(),
    type: 'text',
    filePath,
    style: defaultTileStyleSnapshot(),
    createdAt: now,
    updatedAt: now,
  };
  return { def, duplicate };
}

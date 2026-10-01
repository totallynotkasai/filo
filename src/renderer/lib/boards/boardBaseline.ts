/**
 * adoptLoadedBoardBaseline — stamps a loaded board's drift baseline, called
 * only by code that has just put the loaded data into the board cache.
 *
 * `loadBoard` hands the stat back instead of stamping it. A load that fails
 * (a newer or older format, a schema error, a refused prune) or whose data is
 * set aside (an edit landed during a silent reload) must leave the old
 * baseline in place: stamped, it would name the outside version, the next
 * save's drift check would find nothing, and Filo's copy would overwrite that
 * version with no prompt and no recovery copy.
 *
 * A load that no stat pinned (its first stat failed, or a write landed around
 * the read) marks the path unverified, with the JSON it read: nothing says
 * which version on disk the cache holds, so the first save reads the file
 * before it writes over it (`writeBoardFile`).
 *
 * The adoption also records the file's format: a board read from an older
 * format has its file kept before its first save (`migratedBoards`), and a
 * board read in the current format clears any such record for its path.
 */

import { markBaselineUnverified, noteBaseline } from '../vault/fileBaselineRegistry';
import type { LoadedBoardBaseline } from './boardLoader';
import { noteLoadedBoardFormat } from './migratedBoards';

export function adoptLoadedBoardBaseline(relPath: string, baseline: LoadedBoardBaseline | undefined): void {
  noteLoadedBoardFormat(relPath, baseline?.olderFormat);
  if (!baseline || 'readJson' in baseline) {
    markBaselineUnverified(relPath, baseline?.readJson);
    return;
  }
  noteBaseline(relPath, baseline.mtimeMs, baseline.size, { ifUnchangedSince: baseline.seq });
}

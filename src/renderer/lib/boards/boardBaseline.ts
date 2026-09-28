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
 */

import { noteBaseline } from '../vault/fileBaselineRegistry';
import type { LoadedBoardBaseline } from './boardLoader';

export function adoptLoadedBoardBaseline(relPath: string, baseline: LoadedBoardBaseline | undefined): void {
  if (!baseline) return;
  noteBaseline(relPath, baseline.mtimeMs, baseline.size, { ifUnchangedSince: baseline.seq });
}

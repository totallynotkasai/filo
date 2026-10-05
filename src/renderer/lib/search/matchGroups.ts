/**
 * The Search panel's list under the box: the matches grouped by the note (or
 * tile) they are in, so the user sees which notes match and where, not only
 * "1 / 23". A note on two boards is a group on each, since each is a place
 * Find can show.
 */
import type { SearchMatch } from './runSearch';

export interface MatchGroup {
  key: string;
  /** The note's (or tile's) title. */
  title: string;
  /** The board it is on, or "On no board". */
  where: string;
  /** Its matches, as indexes into the match list, in list order. */
  indexes: number[];
}

/** How many notes the list shows before it asks for a narrower search. */
export const MAX_GROUPS_SHOWN = 100;
/** How many of a note's matches show before "N more". */
export const MATCHES_SHOWN_PER_GROUP = 3;

/** The matches grouped by note, in the order the list first reaches each. */
export function groupMatches(matches: readonly SearchMatch[]): MatchGroup[] {
  const groups = new Map<string, MatchGroup>();
  matches.forEach((m, i) => {
    const key = `${m.boardId}\u0000${m.tileId || m.filePath || ''}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, title: m.tileTitle || '(untitled)', where: m.boardId ? m.boardName : 'On no board', indexes: [] };
      groups.set(key, group);
    }
    group.indexes.push(i);
  });
  return [...groups.values()];
}

/**
 * A match's context split around the matched text, for the list to mark it.
 * A snippet without the text (a match in a tag, a filter) is all `before`.
 */
export function snippetParts(match: Pick<SearchMatch, 'snippet' | 'matchText'>): { before: string; hit: string; after: string } {
  const { snippet, matchText } = match;
  const at = matchText ? snippet.toLowerCase().indexOf(matchText.toLowerCase()) : -1;
  if (at < 0) return { before: snippet, hit: '', after: '' };
  return { before: snippet.slice(0, at), hit: snippet.slice(at, at + matchText.length), after: snippet.slice(at + matchText.length) };
}

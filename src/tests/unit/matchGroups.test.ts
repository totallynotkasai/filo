import { describe, it, expect } from 'vitest';
import { groupMatches, snippetParts } from '@renderer/lib/search/matchGroups';
import type { SearchMatch } from '@renderer/lib/search/runSearch';

function match(over: Partial<SearchMatch>): SearchMatch {
  return {
    boardId: 'b1', boardName: 'Plot', tileId: 't1', tileTitle: 'Siege', tileType: 'text', filePath: 'Siege.md',
    matchStart: 0, matchEnd: 5, matchText: 'walls', matchKind: 'body', snippet: 'The walls held', tags: [],
    ...over,
  };
}

describe('groupMatches', () => {
  it('groups matches by the note or tile they are in, in list order, a note on two boards twice', () => {
    const groups = groupMatches([
      match({}),
      match({ matchStart: 20 }),
      match({ tileId: 't2', tileTitle: 'Map', filePath: 'Map.md' }),
      match({ boardId: 'b2', boardName: 'Book', tileId: 't9' }),
      match({ boardId: '', boardName: '', tileId: '', tileTitle: 'Loose', filePath: 'Loose.md' }),
      match({ tileId: 'link1', tileTitle: '', filePath: null, matchKind: 'title' }),
    ]);
    expect(groups.map((g) => [g.title, g.where, g.indexes])).toEqual([
      ['Siege', 'Plot', [0, 1]],
      ['Map', 'Plot', [2]],
      ['Siege', 'Book', [3]],
      ['Loose', 'On no board', [4]],
      ['(untitled)', 'Plot', [5]],
    ]);
  });
});

describe('snippetParts', () => {
  it('splits the context around the matched text, in any case', () => {
    expect(snippetParts({ snippet: '…The Walls held…', matchText: 'walls' })).toEqual({ before: '…The ', hit: 'Walls', after: ' held…' });
  });

  it('leaves a snippet without the text whole', () => {
    expect(snippetParts({ snippet: 'Siege', matchText: '' })).toEqual({ before: 'Siege', hit: '', after: '' });
  });
});

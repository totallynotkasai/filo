import { describe, it, expect, beforeEach } from 'vitest';
import { boardCacheStore } from '@renderer/stores/boardCache.svelte';
import { samePath } from '@renderer/lib/utils/path';

/**
 * Board-path compares must be case-INSENSITIVE.
 *
 * The document pipeline case-folds everywhere; the board pipeline used raw `===`
 * / `normalizePath`. On a case-insensitive FS (Windows/macOS), an OS-reported
 * `.board.json` rename whose casing diverges from the stored casing failed to
 * rebind `boardPaths` — the cache stayed keyed at the stale path, so the next
 * write recreated a phantom file and the tree reconcile evicted the board as
 * "missing on disk". `renameBoardPath` now folds before comparing (the suffix
 * still keeps its on-disk casing). The external-edit lookup `findBoardIdForPath`
 * gets the same treatment via `samePath` (pinned by `ci:board-path-casefold`).
 */
describe('renameBoardPath compares case-insensitively', () => {
  beforeEach(() => {
    boardCacheStore.clear();
  });

  it('rebinds a single-file rename whose old path casing diverges from the stored casing', () => {
    boardCacheStore.hydrate({}, { b1: 'Folder/Board.board.json' });
    // OS emits the old path lower-cased (case-insensitive FS); stored casing is mixed.
    const changed = boardCacheStore.renameBoardPath('folder/board.board.json', 'Folder/Renamed.board.json');
    expect(changed).toEqual(['b1']);
    expect(boardCacheStore.paths.b1).toBe('Folder/Renamed.board.json');
  });

  it('rebinds folder-rename descendants, preserving the suffix on-disk casing', () => {
    boardCacheStore.hydrate({}, {
      b1: 'Sub/Deep/MyBoard.board.json',
      b2: 'Other/Keep.board.json',
    });
    // Folder renamed Sub → Renamed; OS event lower-cases the old folder.
    const changed = boardCacheStore.renameBoardPath('sub', 'Renamed');
    expect(changed).toEqual(['b1']);
    // Suffix `Deep/MyBoard.board.json` keeps its original casing, not folded.
    expect(boardCacheStore.paths.b1).toBe('Renamed/Deep/MyBoard.board.json');
    // Unrelated board untouched.
    expect(boardCacheStore.paths.b2).toBe('Other/Keep.board.json');
  });

  // A case-only rename is NOT a no-op: leaving the stored casing stale desyncs
  // `boardPaths` from disk on a case-sensitive / synced FS (phantom-file write +
  // "missing on disk" eviction). A case-only rename must rebind the stored path
  // to the new casing; only a BYTE-identical call is a true no-op.
  it('rebinds a case-ONLY rename to the new casing', () => {
    boardCacheStore.hydrate({}, { b1: 'Notes/A.board.json' });
    const changed = boardCacheStore.renameBoardPath('Notes/A.board.json', 'notes/a.board.json');
    expect(changed).toEqual(['b1']);
    expect(boardCacheStore.paths.b1).toBe('notes/a.board.json');
  });

  it('treats a byte-identical rename as a true no-op', () => {
    boardCacheStore.hydrate({}, { b1: 'Notes/A.board.json' });
    const changed = boardCacheStore.renameBoardPath('Notes/A.board.json', 'Notes/A.board.json');
    expect(changed).toEqual([]);
    expect(boardCacheStore.paths.b1).toBe('Notes/A.board.json');
  });

  it('still rebinds an exact-case rename (no regression)', () => {
    boardCacheStore.hydrate({}, { b1: 'Notes/A.board.json' });
    const changed = boardCacheStore.renameBoardPath('Notes/A.board.json', 'Notes/B.board.json');
    expect(changed).toEqual(['b1']);
    expect(boardCacheStore.paths.b1).toBe('Notes/B.board.json');
  });

  it('a leading-slash oldPath still rebinds descendants correctly (no slice desync)', () => {
    boardCacheStore.hydrate({}, {
      b1: 'Proj/Deep/A.board.json',
      b2: 'Proj/B.board.json',
      b3: 'Other/Keep.board.json',
    });
    // An out-of-contract caller passes a LEADING-SLASH oldPath. Previously the
    // case-PRESERVING `oldPrefix` ("/Proj/") was one char longer than the
    // case-FOLDED `foldedPrefix` ("proj/", which strips the leading slash), so
    // `norm.slice(oldPrefix.length)` dropped the first suffix char → e.g.
    // "Renamed/eep/A.board.json". Stripping leading slashes at entry keeps both
    // prefix lengths equal so the suffix slices correctly.
    const changed = boardCacheStore.renameBoardPath('/Proj', 'Renamed').sort();
    expect(changed).toEqual(['b1', 'b2']);
    expect(boardCacheStore.paths.b1).toBe('Renamed/Deep/A.board.json');
    expect(boardCacheStore.paths.b2).toBe('Renamed/B.board.json');
    expect(boardCacheStore.paths.b3).toBe('Other/Keep.board.json'); // unrelated, untouched
  });

  it('a deep multi-level descendant tree all rebinds under an exact folder rename', () => {
    boardCacheStore.hydrate({}, {
      b1: 'Top/A.board.json',
      b2: 'Top/Mid/B.board.json',
      b3: 'Top/Mid/Deep/C.board.json',
      b4: 'TopSibling/D.board.json', // shares the `Top` prefix but NOT under `Top/`
    });
    const changed = boardCacheStore.renameBoardPath('Top', 'Renamed').sort();
    expect(changed).toEqual(['b1', 'b2', 'b3']);
    expect(boardCacheStore.paths.b1).toBe('Renamed/A.board.json');
    expect(boardCacheStore.paths.b2).toBe('Renamed/Mid/B.board.json');
    expect(boardCacheStore.paths.b3).toBe('Renamed/Mid/Deep/C.board.json');
    // `TopSibling/` is a prefix-overlap, not a descendant — must NOT rebind.
    expect(boardCacheStore.paths.b4).toBe('TopSibling/D.board.json');
  });

  it('findBoardIdForPath lookup contract: samePath folds the divergent casing', () => {
    // findBoardIdForPath is module-private to the reconciler; this locks the
    // helper it now uses — the same `samePath` the gate requires there.
    expect(samePath('Folder/Board.board.json', 'folder/board.board.json')).toBe(true);
    expect(samePath('Folder/Board.board.json', 'Folder/Other.board.json')).toBe(false);
  });
});

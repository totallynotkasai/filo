import type { BoardType } from '../../shared/types';

/**
 * Single-path SVG `d` data for each board type's icon, drawn inside a
 * `viewBox="0 0 24 24"` stroke icon (`fill="none" stroke="currentColor"`).
 *
 * Shared so the +New-board menu ([TabBar.svelte]) and the vault sidebar file
 * tree ([FileIcon.svelte]) render the SAME glyph for a given board type —
 * change a board's icon here and both surfaces update together.
 */
export const BOARD_TYPE_ICON_PATH: Record<BoardType, string> = {
  mindmap: 'M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z',
  kanban: 'M3 3h18v18H3zM9 3v18M15 3v18',
  tasklist: 'M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
  document: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z',
};

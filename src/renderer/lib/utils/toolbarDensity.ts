/**
 * How roomy the formatting toolbar is, roomiest first. Tight narrows the
 * dividers and the font and style boxes; compact also shortens the alignment
 * labels and folds the note-layout controls (line spacing, indents, Clear
 * Formatting) into a "More formatting" popover.
 */
export type ToolbarDensity = 'normal' | 'tight' | 'compact';

const ROOMIEST_FIRST: readonly ToolbarDensity[] = ['normal', 'tight', 'compact'];

/**
 * The roomiest density whose controls fit `available` px, from what they took
 * at each density they were seen at (`needs`). A density not seen yet is
 * tried: the next measurement keeps it or folds further. Below compact's
 * need, compact stays and the toolbar scrolls from its left edge.
 *
 * Measured rather than read off the window's width, since the vault's name
 * and the toolbar scale change the room the controls have.
 */
export function fittingDensity(available: number, needs: Partial<Record<ToolbarDensity, number>>): ToolbarDensity {
  for (const density of ROOMIEST_FIRST) {
    const need = needs[density];
    if (need === undefined || need <= available) return density;
  }
  return 'compact';
}

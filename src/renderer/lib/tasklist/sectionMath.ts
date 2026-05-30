/**
 * Pure math for Task List Board sections.
 *
 * Sections partition the flat `tasks[]` placement array by storing a leading
 * `position` index. Walking sections sorted by position lets us answer "which
 * section does placement index N belong to" without rebuilding a lookup map.
 *
 * No DOM, no Svelte, no store access. Unit-testable in isolation.
 */

import type { TaskListSection } from '../../schema/index';

/**
 * Returns the id of the section that owns the placement at `idx`, or `null`
 * for the synthetic leading bucket (placements before the first persisted
 * section). The result is the *last* section whose `position` is `<= idx` —
 * sections are half-open ranges from their position to the next section's
 * position (or end-of-array).
 */
export function sectionIdForPlacementIndex(
  sections: TaskListSection[],
  idx: number,
): string | null {
  if (sections.length === 0) return null;
  const sorted = [...sections].sort((a, b) => a.position - b.position);
  let current: string | null = null;
  for (const s of sorted) {
    if (s.position <= idx) current = s.id;
    else break;
  }
  return current;
}

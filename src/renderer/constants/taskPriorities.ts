/**
 * Shared display metadata for task / Kanban-card priority values: the one
 * set of words and colours for a priority, so a chip, a menu, a filter, a
 * group heading and the quick-add preview all call it the same thing.
 *
 * The colours resolve to theme tokens (`--priority-*`) so themes can re-skin
 * priority pills without touching the components.
 */

import type { Priority } from '../lib/tasks/frontmatterReaders';

export const PRIORITY_COLOR: Record<Priority, string> = {
  none: 'var(--text-tertiary)',
  low: 'var(--priority-low)',
  medium: 'var(--priority-medium)',
  high: 'var(--priority-high)',
  urgent: 'var(--priority-urgent)',
};

export const PRIORITY_LABEL: Record<Priority, string> = {
  none: 'No priority',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
};

/** Highest first, as every menu and filter lists them. */
export const PRIORITIES: readonly Priority[] = ['urgent', 'high', 'medium', 'low', 'none'];

/** The priority menus' and pickers' options, highest first. */
export const PRIORITY_OPTIONS: ReadonlyArray<{ key: Priority; label: string; color: string }> =
  PRIORITIES.map((key) => ({ key, label: PRIORITY_LABEL[key], color: PRIORITY_COLOR[key] }));

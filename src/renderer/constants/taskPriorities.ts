/**
 * Shared display metadata for task / Kanban-card priority values. Both
 * TaskItem and KanbanCard render priority pills; importing from here keeps the
 * two boards visually consistent.
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
  none: '',
  low: 'Low',
  medium: 'Med',
  high: 'High',
  urgent: '!!!',
};

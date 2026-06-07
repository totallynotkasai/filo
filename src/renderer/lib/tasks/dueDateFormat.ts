/**
 * Due-date formatting helpers shared by TaskItem.svelte and KanbanCard.svelte.
 *
 * Pure — no DOM, no Svelte. The "absolute" form is a compact `MMM D` chip
 * (e.g. `May 16`); the "relative" form is the natural-language form used in
 * tooltips and ARIA labels (`Today` / `Tomorrow` / `Yesterday` / `In 3 days`
 * / `Aug 12`). The time-chip helper formats `HH:MM` 24-hour input to a
 * compact 12-hour string (`9am` / `4:30pm`).
 */

/**
 * Compact absolute date — `Aug 12` or `May 16`. Returns `''` for empty input.
 * Parses YYYY-MM-DD as a local date (avoids the toISOString UTC drift trap).
 */
export function formatDueDateAbsolute(iso: string): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const d = m
    ? new Date(parseInt(m[1] ?? '', 10), parseInt(m[2] ?? '', 10) - 1, parseInt(m[3] ?? '', 10))
    : new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Natural-language relative date — `Today` / `Tomorrow` / `Yesterday`,
 * `In 3 days` / `3 days ago` within ±6 days, or absolute chip otherwise.
 * Accepts an optional `now` for testability; defaults to `new Date()`.
 */
export function formatDueDateRelative(iso: string, now: Date = new Date()): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const due = m
    ? new Date(parseInt(m[1] ?? '', 10), parseInt(m[2] ?? '', 10) - 1, parseInt(m[3] ?? '', 10))
    : new Date(iso);
  if (Number.isNaN(due.getTime())) return iso;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  due.setHours(0, 0, 0, 0);
  const days = Math.round((due.getTime() - today.getTime()) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  if (days > 1 && days <= 6) return `In ${days} days`;
  if (days < -1 && days >= -6) return `${-days} days ago`;
  return formatDueDateAbsolute(iso);
}

/**
 * `HH:MM` 24-hour → compact 12-hour chip. `15:30` → `3:30pm`; `09:00` →
 * `9am`. Returns the input unchanged when it doesn't match.
 */
export function formatTimeChip(time: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!m) return time;
  const h = parseInt(m[1] ?? '', 10);
  const min = m[2];
  if (Number.isNaN(h)) return time;
  const ampm = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return min === '00' ? `${h12}${ampm}` : `${h12}:${min}${ampm}`;
}

/**
 * Pure overdue check — `dueDate` is past `today` AND the task is not
 * already completed. Both TaskItem and KanbanCard need this; centralising
 * here avoids the "is this before/after midnight?" drift between the two
 * implementations.
 */
export function isOverdue(dueDate: string, completed: boolean, now: Date = new Date()): boolean {
  if (!dueDate || completed) return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dueDate);
  const due = m
    ? new Date(parseInt(m[1] ?? '', 10), parseInt(m[2] ?? '', 10) - 1, parseInt(m[3] ?? '', 10))
    : new Date(dueDate);
  if (Number.isNaN(due.getTime())) return false;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  due.setHours(0, 0, 0, 0);
  return due.getTime() < today.getTime();
}

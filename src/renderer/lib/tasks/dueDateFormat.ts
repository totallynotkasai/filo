/**
 * Due-time and overdue helpers shared by TaskItem.svelte and KanbanCard.svelte.
 * A day itself is parsed and shown by `lib/utils/dateFormat.ts`.
 *
 * No DOM, no Svelte. The time-chip helper formats `HH:MM` 24-hour input to a
 * compact 12-hour string (`9am` / `4:30pm`).
 */
import { parseLocalIsoDate } from '../utils/dateFormat';

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
 * implementations. A due date that isn't a `YYYY-MM-DD` day is never overdue,
 * as the smart lists never count it.
 */
export function isOverdue(dueDate: string, completed: boolean, now: Date = new Date()): boolean {
  if (!dueDate || completed) return false;
  const due = parseLocalIsoDate(dueDate);
  if (!due) return false;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return due.getTime() < today.getTime();
}

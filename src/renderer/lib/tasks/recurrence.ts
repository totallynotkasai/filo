/**
 * recurrence — compute the next due date for a recurring task.
 *
 * Pure: no globals, no Date.now(). Caller supplies the completion timestamp.
 *
 * Supported `recurrence` strings (case-insensitive):
 *
 *   daily | weekly | monthly | yearly | annually
 *   weekday | weekdays   (Mon–Fri, skips Sat/Sun)
 *   every N d|days
 *   every N w|weeks
 *   every N m|months
 *   every N y|years
 *
 * Modes:
 *
 *   schedule   — next due = currentDue + interval (independent of when
 *                the user completes; "the weekly meeting is on Tue").
 *   completion — next due = completedOn + interval (relative to when the
 *                user actually checked it off; "water plants 3 days after
 *                last watering").
 *
 * Month-end semantics: adding N months preserves the day-of-month when
 * possible and clamps to the last day of the target month otherwise.
 * Jan 31 + 1m = Feb 28 (or Feb 29 in a leap year).
 */

import { addMonthsClamped } from './dateMath';

export type RecurrenceMode = 'schedule' | 'completion';

type RecurrenceUnit =
  | { kind: 'fixed'; count: number; unit: 'd' | 'w' | 'm' | 'y' }
  | { kind: 'weekday' };

export function parseRecurrence(rec: string): RecurrenceUnit | null {
  if (!rec) return null;
  const r = rec.toLowerCase().trim();
  if (r === 'daily') return { kind: 'fixed', count: 1, unit: 'd' };
  if (r === 'weekly') return { kind: 'fixed', count: 1, unit: 'w' };
  if (r === 'monthly') return { kind: 'fixed', count: 1, unit: 'm' };
  if (r === 'yearly' || r === 'annually') return { kind: 'fixed', count: 1, unit: 'y' };
  if (r === 'weekday' || r === 'weekdays') return { kind: 'weekday' };

  const m = /^every\s+(\d+)\s*(d|days?|w|weeks?|m|months?|y|years?)$/i.exec(r);
  if (m) {
    const count = parseInt(m[1], 10);
    if (count < 1) return null;
    const u = m[2].toLowerCase()[0] as 'd' | 'w' | 'm' | 'y';
    return { kind: 'fixed', count, unit: u };
  }
  return null;
}

function fmtDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function parseIsoDate(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const d = parseInt(m[3], 10);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const out = new Date(y, mo - 1, d);
  out.setHours(0, 0, 0, 0);
  // Reject impossible dates like Feb 30 (Date silently rolls them over).
  if (out.getFullYear() !== y || out.getMonth() !== mo - 1 || out.getDate() !== d) {
    return null;
  }
  return out;
}

function addInterval(from: Date, unit: RecurrenceUnit): Date {
  if (unit.kind === 'weekday') {
    const out = new Date(from);
    out.setDate(out.getDate() + 1);
    while (out.getDay() === 0 || out.getDay() === 6) {
      out.setDate(out.getDate() + 1);
    }
    return out;
  }

  if (unit.unit === 'd') {
    const out = new Date(from);
    out.setDate(out.getDate() + unit.count);
    return out;
  }
  if (unit.unit === 'w') {
    const out = new Date(from);
    out.setDate(out.getDate() + unit.count * 7);
    return out;
  }
  if (unit.unit === 'y') {
    const out = new Date(from);
    // Clamp Feb 29 → Feb 28 when shifting to a non-leap year.
    const targetYear = out.getFullYear() + unit.count;
    const targetMonth = out.getMonth();
    const desiredDay = out.getDate();
    const lastDay = new Date(targetYear, targetMonth + 1, 0).getDate();
    return new Date(targetYear, targetMonth, Math.min(desiredDay, lastDay));
  }
  // Months: preserve day-of-month and clamp (shared with quick-add — Audit-8 L6).
  return addMonthsClamped(from, unit.count);
}

/**
 * Returns the next due date as YYYY-MM-DD, or `null` if `recurrence` cannot
 * be parsed or required inputs are missing (e.g. `schedule` mode without a
 * `currentDue`).
 */
export function nextDueDate(
  currentDue: string | undefined,
  recurrence: string,
  mode: RecurrenceMode,
  completedOn: Date,
): string | null {
  const parsed = parseRecurrence(recurrence);
  if (!parsed) return null;

  if (mode === 'completion') {
    // Completion mode is unaffected by how overdue the task is:
    // next = completion day + one interval.
    return fmtDate(addInterval(startOfDay(completedOn), parsed));
  }

  // Schedule mode (audit 1.4): the next due date is the first occurrence on the
  // fixed schedule that falls strictly AFTER today (the completion day).
  // Advancing by a single interval would leave a long-overdue task still due in
  // the past, so keep stepping the interval until we clear today.
  if (!currentDue) return null;
  const parsedDue = parseIsoDate(currentDue);
  if (!parsedDue) return null;

  const today = startOfDay(completedOn);
  let next = addInterval(parsedDue, parsed);
  while (next.getTime() <= today.getTime()) {
    next = addInterval(next, parsed);
  }
  return fmtDate(next);
}

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
 * Jan 31 + 1m = Feb 28 (or Feb 29 in a leap year). In schedule mode the
 * original day is kept via `recurrenceAnchor`, so the next step returns to
 * Mar 31 rather than repeating the clamp.
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
    const count = parseInt(m[1] ?? '', 10);
    if (count < 1) return null;
    const u = (m[2] ?? '').toLowerCase()[0] as 'd' | 'w' | 'm' | 'y';
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
  const y = parseInt(m[1] ?? '', 10);
  const mo = parseInt(m[2] ?? '', 10);
  const d = parseInt(m[3] ?? '', 10);
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
  // Months: preserve day-of-month and clamp (shared with quick-add).
  return addMonthsClamped(from, unit.count);
}

/** `day` in the month `monthIdx` months after January of `year`, clamped to its last day. */
function clampedMonthDate(year: number, monthIdx: number, day: number): Date {
  // A day-1 constructor absorbs year wraparound without overflowing the month.
  const wrap = new Date(year, monthIdx, 1);
  const lastDay = new Date(wrap.getFullYear(), wrap.getMonth() + 1, 0).getDate();
  return new Date(wrap.getFullYear(), wrap.getMonth(), Math.min(day, lastDay));
}

/**
 * The date whose day-of-month (and month, for yearly) a month-based schedule
 * repeats on. A clamped due date (Feb 28 from a Jan 31 task) cannot say which
 * day it stands for, so the original is stored as `recurrenceAnchor`. The
 * stored anchor only counts while the due date is what the anchor would clamp
 * to in that month; any other due date means the user moved it by hand, and
 * the schedule re-anchors on the new date.
 */
function resolveAnchor(due: Date, unit: 'm' | 'y', anchor: string | undefined): Date {
  const stored = anchor ? parseIsoDate(anchor) : null;
  if (!stored) return due;
  if (unit === 'y' && stored.getMonth() !== due.getMonth()) return due;
  const expected = clampedMonthDate(due.getFullYear(), due.getMonth(), stored.getDate());
  return expected.getDate() === due.getDate() ? stored : due;
}

/**
 * Returns the next due date as YYYY-MM-DD, or `null` if `recurrence` cannot
 * be parsed or required inputs are missing (e.g. `schedule` mode without a
 * `currentDue`).
 *
 * `anchor` is the task's `recurrenceAnchor` (see `resolveAnchor`); it only
 * affects month- and year-based schedule mode.
 */
export function nextDueDate(
  currentDue: string | undefined,
  recurrence: string,
  mode: RecurrenceMode,
  completedOn: Date,
  anchor?: string,
): string | null {
  const parsed = parseRecurrence(recurrence);
  if (!parsed) return null;

  if (mode === 'completion') {
    // Completion mode is unaffected by how overdue the task is:
    // next = completion day + one interval.
    return fmtDate(addInterval(startOfDay(completedOn), parsed));
  }

  // Schedule mode: the next due date is the first occurrence on the
  // fixed schedule that falls strictly AFTER today (the completion day).
  // Advancing by a single interval would leave a long-overdue task still due in
  // the past, so keep stepping the interval until we clear today.
  if (!currentDue) return null;
  const parsedDue = parseIsoDate(currentDue);
  if (!parsedDue) return null;

  const today = startOfDay(completedOn);

  if (parsed.kind === 'fixed' && (parsed.unit === 'm' || parsed.unit === 'y')) {
    // Step whole multiples from the due month and clamp each candidate to the
    // anchor day. Chaining from the previous candidate would inherit its clamp
    // (Jan 31 → Feb 28 → Mar 28 …) and never recover the original day.
    const anchorDay = resolveAnchor(parsedDue, parsed.unit, anchor).getDate();
    const step = parsed.count * (parsed.unit === 'y' ? 12 : 1);
    let k = 1;
    let next = clampedMonthDate(parsedDue.getFullYear(), parsedDue.getMonth() + step, anchorDay);
    while (next.getTime() <= today.getTime()) {
      k += 1;
      next = clampedMonthDate(parsedDue.getFullYear(), parsedDue.getMonth() + k * step, anchorDay);
    }
    return fmtDate(next);
  }

  let next = addInterval(parsedDue, parsed);
  while (next.getTime() <= today.getTime()) {
    next = addInterval(next, parsed);
  }
  return fmtDate(next);
}

/**
 * The `recurrenceAnchor` a task should carry after rolling forward, or
 * `undefined` when it needs none. Only an anchor that can actually clamp is
 * worth storing: a monthly day 29–31, or Feb 29 for yearly. Every other day
 * recurs exactly, so ordinary monthly tasks never gain the key.
 */
export function recurrenceAnchorToRecord(
  currentDue: string | undefined,
  recurrence: string,
  mode: RecurrenceMode,
  anchor?: string,
): string | undefined {
  if (mode !== 'schedule' || !currentDue) return undefined;
  const parsed = parseRecurrence(recurrence);
  if (!parsed || parsed.kind !== 'fixed' || (parsed.unit !== 'm' && parsed.unit !== 'y')) {
    return undefined;
  }
  const due = parseIsoDate(currentDue);
  if (!due) return undefined;
  const resolved = resolveAnchor(due, parsed.unit, anchor);
  const canClamp = parsed.unit === 'm'
    ? resolved.getDate() >= 29
    : resolved.getMonth() === 1 && resolved.getDate() === 29;
  return canClamp ? fmtDate(resolved) : undefined;
}

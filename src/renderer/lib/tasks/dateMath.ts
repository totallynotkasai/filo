/**
 * dateMath — shared calendar arithmetic for task scheduling.
 *
 * Pure: no globals, no Date.now(). Callers supply the base date. Kept separate
 * from `recurrence.ts` / `quickAddParser.ts` so both the recurrence engine and
 * the quick-add parser apply the SAME month-end rule.
 */

/**
 * Adds `count` calendar months to `from`, preserving the day-of-month when the
 * target month has it and clamping to the target month's last day otherwise:
 * Jan 31 + 1m → Feb 28 (or Feb 29 in a leap year). `count` may be negative.
 *
 * Without the clamp, raw `Date.setMonth(getMonth() + count)` OVERFLOWS a short
 * target month — Jan 31 + 1m rolls forward to Mar 3 — which is a surprising
 * "in 1 month" due date and disagrees with how the recurrence engine steps
 * months. Returns a fresh midnight-anchored Date; `from` is not mutated.
 */
export function addMonthsClamped(from: Date, count: number): Date {
  const desiredDay = from.getDate();
  const targetMonthIdx = from.getMonth() + count;
  // A day-1 constructor absorbs the year wraparound without overflowing…
  const wrap = new Date(from.getFullYear(), targetMonthIdx, 1);
  // …then clamp the day to the resolved month's actual length.
  const lastDay = new Date(wrap.getFullYear(), wrap.getMonth() + 1, 0).getDate();
  return new Date(wrap.getFullYear(), wrap.getMonth(), Math.min(desiredDay, lastDay));
}

/**
 * The date picker's calendar arithmetic: the locale's first weekday, the six
 * weeks a month's grid shows, and where a key moves the keyboard's day. Pure;
 * days are `YYYY-MM-DD` strings (`lib/utils/dateFormat.ts`).
 */
import { addMonthsClamped } from '../tasks/dateMath';
import { localIsoDate, parseLocalIsoDate } from '../utils/dateFormat';

interface WeekInfo { firstDay: number }

/**
 * The weekday a week starts on in `locale` (0 = Sunday … 6 = Saturday):
 * Monday in most of Europe, Sunday in the US. Sunday when the runtime can't
 * say, as the picker always used.
 */
export function weekStartDay(locale?: string): number {
  try {
    const loc = new Intl.Locale(locale ?? new Intl.DateTimeFormat().resolvedOptions().locale) as Intl.Locale & {
      getWeekInfo?: () => WeekInfo;
      weekInfo?: WeekInfo;
    };
    const info = loc.getWeekInfo?.() ?? loc.weekInfo;
    if (info && info.firstDay >= 1 && info.firstDay <= 7) return info.firstDay % 7;
  } catch {
    // An unknown tag: the default below.
  }
  return 0;
}

/** The seven weekday headings from `weekStart`: a narrow letter and the full name. */
export function weekdayLabels(weekStart: number, locale?: string): Array<{ narrow: string; long: string }> {
  const narrow = new Intl.DateTimeFormat(locale, { weekday: 'narrow' });
  const long = new Intl.DateTimeFormat(locale, { weekday: 'long' });
  // 2026-10-04 was a Sunday.
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(2026, 9, 4 + ((weekStart + i) % 7));
    return { narrow: narrow.format(d), long: long.format(d) };
  });
}

/**
 * The 42 days (six weeks) the grid shows for `month` (0-11) of `year`, from
 * the week start on or before the 1st.
 */
export function calendarCells(year: number, month: number, weekStart: number): string[] {
  const lead = (new Date(year, month, 1).getDay() - weekStart + 7) % 7;
  return Array.from({ length: 42 }, (_, i) => localIsoDate(new Date(year, month, 1 - lead + i)));
}

export type DayMove = { days: number } | { months: number };

/**
 * Where a key moves the keyboard's day in the grid: the arrows by a day or a
 * week, Home / End to the week's first / last day, Page Up / Page Down by a
 * month. Null for any other key.
 */
export function dateKeyMove(key: string, focusedIso: string, weekStart: number): DayMove | null {
  const day = parseLocalIsoDate(focusedIso)?.getDay() ?? weekStart;
  const intoWeek = (day - weekStart + 7) % 7;
  switch (key) {
    case 'ArrowLeft': return { days: -1 };
    case 'ArrowRight': return { days: 1 };
    case 'ArrowUp': return { days: -7 };
    case 'ArrowDown': return { days: 7 };
    case 'Home': return { days: -intoWeek };
    case 'End': return { days: 6 - intoWeek };
    case 'PageUp': return { months: -1 };
    case 'PageDown': return { months: 1 };
    default: return null;
  }
}

/** `iso` moved by days, or by months clamped to the month's end (Jan 31 + 1 month is Feb 28). */
export function shiftDay(iso: string, by: DayMove): string {
  const from = parseLocalIsoDate(iso);
  if (!from) return iso;
  if ('months' in by) return localIsoDate(addMonthsClamped(from, by.months));
  return localIsoDate(new Date(from.getFullYear(), from.getMonth(), from.getDate() + by.days));
}

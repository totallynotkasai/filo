/**
 * Calendar days (`YYYY-MM-DD`): the one parser, the one writer and the one
 * way a day is shown. A task's due and start dates, a recurrence, quick add,
 * the date pickers and every chip, menu and message go through here, so a
 * day reads the same everywhere and a date one view accepts no other view
 * reads differently.
 */

/**
 * The one `YYYY-MM-DD` formatter. Local calendar date, never UTC:
 * `toISOString()` gives yesterday's or tomorrow's date for part of every day
 * outside UTC, so a due date, a recurrence or a template name would land on
 * the wrong day.
 */
export function localIsoDate(d: Date = new Date()): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** The local date `days` days from `from` (default now), as `YYYY-MM-DD`. */
export function localIsoDateInDays(days: number, from: Date = new Date()): string {
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  return localIsoDate(d);
}

/**
 * Local midnight of the day `year`-`month`-`day` (month 1-12), or null for a
 * day the calendar doesn't have. `new Date(2026, 1, 30)` quietly rolls into
 * March, so a date written as Feb 30 would show, sort and recur as Mar 2.
 */
export function localDate(year: number, month: number, day: number): Date | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const out = new Date(year, month - 1, day);
  if (out.getFullYear() !== year || out.getMonth() !== month - 1 || out.getDate() !== day) return null;
  return out;
}

/**
 * The one `YYYY-MM-DD` parser: local midnight of that day, or null for
 * anything else (another shape, or a day the calendar doesn't have).
 * `new Date('2026-05-20')` would read UTC midnight, which is the day before
 * in every zone west of Greenwich.
 */
export function parseLocalIsoDate(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return null;
  return localDate(parseInt(m[1] ?? '', 10), parseInt(m[2] ?? '', 10), parseInt(m[3] ?? '', 10));
}

/** Whether the runtime supports each locale asked about (asked once per locale). */
const supportedLocale = new Map<string, boolean>();

/**
 * The OS regional-format locale the preload exposes (en-GB writes `12 Oct`
 * where the UI language may be en-US), else the runtime default.
 */
export function displayLocale(): string | undefined {
  const locale = typeof window !== 'undefined' ? window.filo?.systemLocale : undefined;
  if (!locale) return undefined;
  let ok = supportedLocale.get(locale);
  if (ok === undefined) {
    try {
      ok = Intl.DateTimeFormat.supportedLocalesOf([locale]).length > 0;
    } catch {
      ok = false;
    }
    supportedLocale.set(locale, ok);
  }
  return ok ? locale : undefined;
}

type DayStyle = 'short' | 'short-year' | 'long';

/**
 * One formatter per locale and shape: `toLocaleDateString` with options
 * builds a new `Intl.DateTimeFormat` on every call, and a list of 400 tasks
 * formats a chip per row.
 */
const dayFormatters = new Map<string, Intl.DateTimeFormat>();
function dayFormatter(locale: string | undefined, style: DayStyle): Intl.DateTimeFormat {
  const key = `${locale ?? ''}|${style}`;
  let f = dayFormatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, style === 'long'
      ? { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }
      : style === 'short-year'
        ? { month: 'short', day: 'numeric', year: 'numeric' }
        : { month: 'short', day: 'numeric' });
    dayFormatters.set(key, f);
  }
  return f;
}

export interface DayFormatOptions {
  /** A BCP 47 locale; the OS regional format when left out. */
  locale?: string;
  /** Today, for the year rule (a chip shows the year only for another year's day). */
  now?: Date;
}

/**
 * How a day is shown in a chip, a menu or a message: `Oct 12` / `12 Oct` in
 * the OS regional format, with the year when the day isn't in this year
 * (`Oct 12, 2027`). Text that isn't a `YYYY-MM-DD` day is shown as written,
 * so a hand-typed date is never shown as a different one.
 */
export function formatDay(iso: string, opts: DayFormatOptions = {}): string {
  if (!iso) return '';
  const d = parseLocalIsoDate(iso);
  if (!d) return iso;
  const thisYear = d.getFullYear() === (opts.now ?? new Date()).getFullYear();
  return dayFormatter(opts.locale ?? displayLocale(), thisYear ? 'short' : 'short-year').format(d);
}

/**
 * The same day in full, for a screen reader or a tooltip: `Monday, 12 October
 * 2026` (in the OS regional format).
 */
export function formatDayLong(iso: string, opts: Pick<DayFormatOptions, 'locale'> = {}): string {
  const d = parseLocalIsoDate(iso);
  if (!d) return iso;
  return dayFormatter(opts.locale ?? displayLocale(), 'long').format(d);
}

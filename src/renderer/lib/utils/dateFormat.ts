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

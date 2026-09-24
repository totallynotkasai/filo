/**
 * True when `locale` writes numeric dates day-first (en-GB `25/12`, de-DE
 * `25.12.`), false when month-first (en-US `12/25`). Read from the locale's own
 * numeric date format rather than a hard-coded list. An invalid tag falls
 * back to month-first.
 */
export function localeIsDayFirst(locale?: string): boolean {
  try {
    const parts = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'numeric' }).formatToParts(
      new Date(2026, 11, 25),
    );
    const dayIdx = parts.findIndex((p) => p.type === 'day');
    const monthIdx = parts.findIndex((p) => p.type === 'month');
    return dayIdx >= 0 && monthIdx >= 0 && dayIdx < monthIdx;
  } catch {
    return false;
  }
}

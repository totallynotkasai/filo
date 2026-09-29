/**
 * Due-date formatting helpers shared by TaskItem.svelte and KanbanCard.svelte.
 *
 * No DOM, no Svelte. The date chip is a compact month-and-day form in the
 * OS regional format (`May 16`, `16 May`), with the year when it isn't this
 * year. The time-chip helper formats `HH:MM` 24-hour input to a compact
 * 12-hour string (`9am` / `4:30pm`).
 */

/** Whether the runtime supports each locale asked about (asked once per locale). */
const supportedLocale = new Map<string, boolean>();

/** The OS regional-format locale the preload exposes, else the runtime default. */
function chipLocale(): string | undefined {
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

/**
 * One formatter per locale and shape: `toLocaleDateString` with options
 * builds a new `Intl.DateTimeFormat` on every call, and a list of 400 tasks
 * formats a chip per row.
 */
const dateFormatters = new Map<string, Intl.DateTimeFormat>();
function dateFormatter(locale: string | undefined, withYear: boolean): Intl.DateTimeFormat {
  const key = `${locale ?? ''}|${withYear ? 'y' : ''}`;
  let f = dateFormatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, withYear
      ? { month: 'short', day: 'numeric', year: 'numeric' }
      : { month: 'short', day: 'numeric' });
    dateFormatters.set(key, f);
  }
  return f;
}

/**
 * Compact absolute date — `Aug 12`, `12 Aug`, or `Aug 12, 2027` outside
 * the current year. Returns `''` for empty input. Parses YYYY-MM-DD as a
 * local date (avoids the toISOString UTC drift trap).
 */
export function formatDueDateAbsolute(iso: string, opts: { locale?: string; now?: Date } = {}): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const d = m
    ? new Date(parseInt(m[1] ?? '', 10), parseInt(m[2] ?? '', 10) - 1, parseInt(m[3] ?? '', 10))
    : new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const thisYear = d.getFullYear() === (opts.now ?? new Date()).getFullYear();
  return dateFormatter(opts.locale ?? chipLocale(), !thisYear).format(d);
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

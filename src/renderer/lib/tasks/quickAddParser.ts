/**
 * quickAddParser — parses a single-line task input into a title plus
 * structured metadata (date, time, priority, tags, status).
 *
 * Pure: deterministic when given a fixed `now`. No DOM, no I/O, no Date.now().
 *
 * Supported tokens (anywhere in the input, separated by whitespace):
 *
 *   tomorrow, today                        → dueDate
 *   next mon | next tue | next wed | ...   → dueDate (next occurrence)
 *   in 3d | in 2w | in 1m                  → dueDate (relative offset)
 *   2026-05-20                             → dueDate (ISO)
 *   5/12                                   → dueDate (M/D, current or next year)
 *   ^<date>                                → startDate (defer until)
 *   @5pm | @17:30 | @9:00am                → dueTime (24h HH:MM)
 *   !low | !med | !medium | !high | !urgent → priority
 *   !!                                     → priority: urgent (shorthand)
 *   #tag-name (any number)                 → tags
 *   =status-name                           → status
 *
 * Tokens are removed from the title. Whitespace is normalised. The first
 * matching date token wins; later date tokens stay in the title.
 *
 * Start-date semantics: a caret prefix (`^tomorrow`, `^next mon`,
 * `^2026-05-20`) sets `startDate` instead of `dueDate`. Independent of the
 * leftmost-due-date match — a row can carry both a start and a due token in
 * the same input.
 */

import { addMonthsClamped } from './dateMath';

export type QuickAddPriority = 'low' | 'medium' | 'high' | 'urgent';

export interface QuickAddParsed {
  title: string;
  dueDate?: string;
  dueTime?: string;
  startDate?: string;
  priority?: QuickAddPriority;
  tags: string[];
  status?: string;
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function fmtDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Validates a (year, month, day) triple and returns the constructed local
 * midnight Date, or `null` when the triple is out of range or silently rolls
 * over (e.g. Feb 30 → Mar 2). Mirrors `recurrence.ts parseIsoDate` so quick-add
 * and the recurrence engine agree on what counts as a real calendar date —
 * without this round-trip check an impossible date is written verbatim to
 * frontmatter and then displayed/treated as a *different* day.
 */
function validDateOrNull(y: number, mo: number, d: number): Date | null {
  if (!Number.isInteger(y) || !Number.isInteger(mo) || !Number.isInteger(d)) return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const out = new Date(y, mo - 1, d);
  out.setHours(0, 0, 0, 0);
  if (out.getFullYear() !== y || out.getMonth() !== mo - 1 || out.getDate() !== d) {
    return null;
  }
  return out;
}

/** `fmtDate` that yields `undefined` for an Invalid Date so an overflowed
 *  offset can't write the literal string "NaN-NaN-NaN" as a due date. */
function fmtDateOrNull(d: Date): string | undefined {
  return Number.isNaN(d.getTime()) ? undefined : fmtDate(d);
}

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function nextWeekday(today: Date, dayIdx: number): Date {
  const out = new Date(today);
  // DECISION — "next <weekday>" uniformly means the SOONEST occurrence of
  // that weekday STRICTLY AFTER today — one rule, applied to every weekday. So
  // from a Friday, "next mon" is +3 and "next fri" is +7 (today is excluded, so
  // the same weekday lands a week out). The `|| 7` encodes only that exclusion;
  // it is not a special case for the same weekday. Matches common task apps and
  // is pinned by the quickAddParser tests.
  const diff = (dayIdx - today.getDay() + 7) % 7 || 7;
  out.setDate(today.getDate() + diff);
  return out;
}

function parseClockTime(s: string): string | null {
  const m = /^(\d{1,2})(?::(\d{2}))?(am|pm)?$/i.exec(s);
  if (!m) return null;
  let h = parseInt(m[1] ?? '', 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[3]?.toLowerCase();
  // With an am/pm suffix the hour must read 1..12. `@13pm`/`@0am` are nonsense
  // (the suffix would be ignored once h >= 12, so `13pm` would become 13:00).
  // Reject so the token stays in the title.
  if (ampm && (h < 1 || h > 12)) return null;
  if (ampm === 'pm' && h < 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function normalizePriority(word: string): QuickAddPriority {
  const w = word.toLowerCase();
  if (w === 'med' || w === 'medium') return 'medium';
  if (w === 'urgent') return 'urgent';
  if (w === 'high') return 'high';
  if (w === 'low') return 'low';
  return 'medium';
}

export function parseQuickAdd(
  input: string,
  options: { now?: Date } = {},
): QuickAddParsed {
  const now = options.now ?? new Date();
  const today = startOfDay(now);

  let working = ` ${input} `;
  const tags: string[] = [];
  let dueDate: string | undefined;
  let dueTime: string | undefined;
  let startDate: string | undefined;
  let priority: QuickAddPriority | undefined;
  let status: string | undefined;

  // Tags (multiple, global).
  working = working.replace(/\s#([a-zA-Z0-9_-]+)(?=\s)/g, (_full, tag: string) => {
    tags.push(tag);
    return ' ';
  });

  // Priority. Precedence: a `!!word` / bare `!!` (urgent) wins over a plain
  // `!word`. Each pass is GLOBAL so a second priority token is stripped from the
  // title instead of leaking; the inner guard keeps the first value seen
  // in pass order.
  working = working.replace(/\s!!(urgent|high|med(?:ium)?|low)(?=\s)/gi, (_m, w: string) => {
    if (!priority) priority = normalizePriority(w);
    return ' ';
  });
  working = working.replace(/\s!!(?=\s)/g, () => {
    if (!priority) priority = 'urgent';
    return ' ';
  });
  working = working.replace(/\s!(urgent|high|med(?:ium)?|low)(?=\s)/gi, (_m, w: string) => {
    if (!priority) priority = normalizePriority(w);
    return ' ';
  });

  // Status. Global so a second `=status` is stripped from the title; the
  // first wins. Lowercased at write because FIELD_READERS.status reads it
  // lowercased — storing raw case would make the .md disagree with the view.
  working = working.replace(/\s=([a-zA-Z0-9_-]+)(?=\s)/g, (_m, s: string) => {
    if (!status) status = s.toLowerCase();
    return ' ';
  });

  // Time of day. Global so a second @time is stripped from the title; the
  // first valid one wins.
  working = working.replace(/\s@(\d{1,2}(?::\d{2})?(?:am|pm)?)(?=\s)/gi, (full, t: string) => {
    const parsed = parseClockTime(t);
    // A malformed @time (`@99`, `@13pm`) is left untouched in the title
    // instead of being silently swallowed (so "@99 East St" keeps its number).
    if (!parsed) return full;
    if (!dueTime) dueTime = parsed;
    return ' ';
  });

  // Date — leftmost token wins so the user's typing order is respected.
  // Each pattern returns the YYYY-MM-DD it would set, or undefined if the
  // match was malformed (kept in title). The leading-whitespace anchor lets
  // an optional `^` prefix (start-date marker) precede the token.
  const datePatterns: Array<{
    re: RegExp;
    handler: (m: RegExpExecArray) => string | undefined;
  }> = [
    {
      re: /\s\^?(\d{4}-\d{2}-\d{2})(?=\s)/,
      handler: (m) => {
        const iso = m[1] ?? '';
        const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
        if (!parts) return undefined;
        // Reject an impossible ISO date (2026-02-30, 2026-13-01) so it
        // stays in the title instead of persisting verbatim and rendering as a
        // rolled-over day.
        const valid = validDateOrNull(
          parseInt(parts[1] ?? '', 10),
          parseInt(parts[2] ?? '', 10),
          parseInt(parts[3] ?? '', 10),
        );
        return valid ? iso : undefined;
      },
    },
    {
      re: /\s\^?(\d{1,2})\/(\d{1,2})(?=\s)/,
      handler: (m) => {
        const month = parseInt(m[1] ?? '', 10);
        const day = parseInt(m[2] ?? '', 10);
        // Validate day-vs-month BEFORE the year-roll. Without the
        // round-trip check, `2/30` constructs Mar 2 (rolled over), which is
        // then < today so the +1-year branch silently shoves it to Mar 2 of
        // NEXT year. Reject the impossible date so the token stays in the title.
        const candidate = validDateOrNull(today.getFullYear(), month, day);
        if (!candidate) return undefined;
        if (candidate < today) {
          // The same M/D one year out can be invalid (Feb 29 this leap year,
          // not next) — re-validate rather than letting Date roll it to Mar 1.
          const rolled = validDateOrNull(today.getFullYear() + 1, month, day);
          return rolled ? fmtDate(rolled) : undefined;
        }
        return fmtDate(candidate);
      },
    },
    {
      re: /\s\^?today(?=\s)/i,
      handler: () => fmtDate(today),
    },
    {
      re: /\s\^?tomorrow(?=\s)/i,
      handler: () => {
        const t = new Date(today);
        t.setDate(t.getDate() + 1);
        return fmtDate(t);
      },
    },
    {
      re: /\s\^?next\s+(sun|mon|tue|wed|thu|fri|sat)[a-z]*(?=\s)/i,
      handler: (m) => {
        const idx = WEEKDAYS.indexOf((m[1] ?? '').toLowerCase());
        if (idx < 0) return undefined;
        return fmtDate(nextWeekday(today, idx));
      },
    },
    {
      re: /\s\^?in\s+(\d+)\s*(d|days?|w|weeks?|m|months?)(?=\s)/i,
      handler: (m) => {
        const count = parseInt(m[1] ?? '', 10);
        // Bound the offset so a 20-digit count can't overflow Date into
        // an Invalid Date that `fmtDate` then stringifies as "NaN-NaN-NaN" and
        // writes to frontmatter. ~10 years is well past any quick-add horizon.
        if (!Number.isFinite(count) || count > 3650) return undefined;
        const u = (m[2] ?? '').toLowerCase()[0];
        const t = new Date(today);
        if (u === 'd') t.setDate(t.getDate() + count);
        else if (u === 'w') t.setDate(t.getDate() + count * 7);
        // Clamp month-end (Jan 31 + 1m → Feb 28) via the shared
        // helper instead of raw setMonth, which overflows to Mar 3.
        else if (u === 'm') return fmtDateOrNull(addMonthsClamped(today, count));
        return fmtDateOrNull(t);
      },
    },
  ];

  // Walk every match position once, then dispatch matches into either
  // dueDate or startDate by inspecting whether the leading non-whitespace
  // character was a `^`. A given pattern may match multiple times in the
  // input (e.g. `Task tomorrow ^next mon`) so we scan all instances.
  interface DateMatch {
    index: number;
    length: number;
    date: string;
    isStart: boolean;
  }
  const matches: DateMatch[] = [];
  for (const { re, handler } of datePatterns) {
    const globalRe = new RegExp(re.source, re.flags + (re.flags.includes('g') ? '' : 'g'));
    let m: RegExpExecArray | null;
    while ((m = globalRe.exec(working)) !== null) {
      const date = handler(m);
      if (!date) continue;
      // The leading space is part of the match; check the next char for `^`.
      const isStart = working.charAt(m.index + 1) === '^';
      matches.push({ index: m.index, length: m[0].length, date, isStart });
      // Avoid zero-width infinite loops.
      if (m[0].length === 0) globalRe.lastIndex++;
    }
  }
  matches.sort((a, b) => a.index - b.index);

  // First leftmost due token wins; first leftmost start token wins. Strip
  // both spans from the working string so the title doesn't keep `^`.
  const stripped = new Set<number>();
  for (const m of matches) {
    if (m.isStart) {
      if (startDate) continue;
      startDate = m.date;
    } else {
      if (dueDate) continue;
      dueDate = m.date;
    }
    for (let i = m.index; i < m.index + m.length; i++) stripped.add(i);
  }
  if (stripped.size > 0) {
    let cleaned = '';
    for (let i = 0; i < working.length; i++) {
      cleaned += stripped.has(i) ? ' ' : working[i];
    }
    working = cleaned;
  }

  const title = working.replace(/\s+/g, ' ').trim();
  // Dedupe tags while preserving first-occurrence order.
  const dedupedTags = Array.from(new Set(tags));

  return { title, dueDate, dueTime, startDate, priority, tags: dedupedTags, status };
}

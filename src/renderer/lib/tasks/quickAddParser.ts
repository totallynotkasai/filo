/**
 * quickAddParser — parses a single-line task input into a title plus
 * structured metadata (date, time, repeat, priority, tags, status).
 *
 * Pure: deterministic when given a fixed `now`. No DOM, no I/O, no Date.now().
 *
 * Supported tokens (anywhere in the input, separated by whitespace):
 *
 *   tomorrow, today                        → dueDate
 *   next mon | next monday | next tues …   → dueDate (next occurrence); only a
 *                                            weekday's name or its usual
 *                                            abbreviation ("next month" is text)
 *   in 3d | in 2w | in 1m                  → dueDate (relative offset)
 *   2026-05-20                             → dueDate (ISO)
 *   5/12                                   → dueDate (M/D, or D/M with `dayFirst`;
 *                                            current or next year), only as the
 *                                            title's last word: "act 2/3 of the
 *                                            book" keeps its fraction
 *   <date> 5pm | <date> at 17:30           → dueTime, after a due date
 *   every friday | every 2 weeks | every   → recurrence (and, without a date,
 *     other day | every weekday …            the first due date)
 *   ^<date>                                → startDate (defer until)
 *   @5pm | @17:30 | @9:00am                → dueTime (24h HH:MM)
 *   !low | !med | !medium | !high | !urgent → priority
 *   !!                                     → priority: urgent (shorthand)
 *   #tag-name, #area/sub-tag (any number)  → tags; a tag needs a letter, so
 *                                            "Chapter #3" keeps its number
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
import { everyRule } from './recurrence';
import { localDate, localIsoDate, parseLocalIsoDate } from '../utils/dateFormat';

export type QuickAddPriority = 'low' | 'medium' | 'high' | 'urgent';

export interface QuickAddParsed {
  title: string;
  dueDate?: string;
  dueTime?: string;
  startDate?: string;
  /** A rule `recurrence.ts` reads (`weekly`, `every 2 weeks` …). */
  recurrence?: string;
  priority?: QuickAddPriority;
  tags: string[];
  status?: string;
}

/**
 * Each weekday's name and the abbreviations people write for it. Anything
 * else that merely starts like one ("month", "wedding", "friend", "sunrise")
 * is an ordinary word.
 */
const WEEKDAY_WORDS: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};
/** The weekday words as a regex alternation, longest first. */
const WEEKDAY_ALT = Object.keys(WEEKDAY_WORDS).sort((a, b) => b.length - a.length).join('|');

/** `localIsoDate` that yields `undefined` for an Invalid Date so an overflowed
 *  offset can't write the literal string "NaN-NaN-NaN" as a due date. */
function fmtDateOrNull(d: Date): string | undefined {
  return Number.isNaN(d.getTime()) ? undefined : localIsoDate(d);
}

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setDate(d.getDate() + days);
  return out;
}

function nextWeekday(today: Date, dayIdx: number): Date {
  // DECISION — "next <weekday>" uniformly means the SOONEST occurrence of
  // that weekday STRICTLY AFTER today — one rule, applied to every weekday. So
  // from a Friday, "next mon" is +3 and "next fri" is +7 (today is excluded, so
  // the same weekday lands a week out). The `|| 7` encodes only that exclusion;
  // it is not a special case for the same weekday. Matches common task apps and
  // is pinned by the quickAddParser tests.
  return addDays(today, (dayIdx - today.getDay() + 7) % 7 || 7);
}

/** The first day on or after `today` that is weekday `dayIdx` (a repeat's first due day). */
function weekdayOnOrAfter(today: Date, dayIdx: number): Date {
  return addDays(today, (dayIdx - today.getDay() + 7) % 7);
}

function parseClockTime(s: string): string | null {
  const m = /^(\d{1,2})(?::(\d{2}))?\s?(am|pm)?$/i.exec(s);
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

/**
 * A clock time right after a due date ("tomorrow 5pm", "fri at 9:30am",
 * "6/1 17:30"). A bare number isn't one: it needs am/pm or a colon.
 */
const TIME_AFTER_DATE = /^\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s?(?:am|pm)|\d{1,2}:\d{2})(?=\s)/i;

/** A repeat: "every <weekday>", "every [N|other] <unit>", "every weekday". */
const REPEAT = new RegExp(
  `\\severy\\s+(?:(other)\\s+|(\\d{1,3})\\s+)?(weekdays?|days?|weeks?|months?|years?|${WEEKDAY_ALT})(?=\\s)`,
  'i',
);

interface RepeatToken {
  recurrence: string;
  /** The first due day when the input names no date. */
  firstDue: Date;
}

function readRepeat(m: RegExpExecArray, today: Date): RepeatToken | null {
  const other = !!m[1];
  const count = other ? 2 : m[2] ? parseInt(m[2], 10) : 1;
  if (!Number.isInteger(count) || count < 1) return null;
  const word = (m[3] ?? '').toLowerCase();
  const weekdayIdx = WEEKDAY_WORDS[word];
  if (weekdayIdx !== undefined) {
    if (m[2]) return null; // "every 2 fridays" isn't a rule Filo keeps
    return { recurrence: everyRule(count, 'w'), firstDue: weekdayOnOrAfter(today, weekdayIdx) };
  }
  if (word.startsWith('weekday')) {
    if (other || m[2]) return null;
    const day = today.getDay();
    return { recurrence: 'weekday', firstDue: day === 0 ? addDays(today, 1) : day === 6 ? addDays(today, 2) : today };
  }
  const unit = word[0] as 'd' | 'w' | 'm' | 'y';
  return { recurrence: everyRule(count, unit), firstDue: today };
}

export function parseQuickAdd(
  input: string,
  options: { now?: Date; dayFirst?: boolean } = {},
): QuickAddParsed {
  const now = options.now ?? new Date();
  const today = startOfDay(now);

  let working = ` ${input} `;
  const tags: string[] = [];
  let dueDate: string | undefined;
  let dueTime: string | undefined;
  let startDate: string | undefined;
  let recurrence: string | undefined;
  let priority: QuickAddPriority | undefined;
  let status: string | undefined;

  // Tags (multiple, global). Any letters or digits, in any script, plus `_`
  // and `-`; `/` nests (`#work/filo`). A tag needs at least one letter, so
  // "Chapter #3" and "Issue #123" keep their numbers. A spaced tag can't be
  // typed as one word, so it goes through the tag row instead.
  working = working.replace(/\s#((?=[\p{L}\p{M}\p{N}_/-]*\p{L})[\p{L}\p{M}\p{N}_-]+(?:\/[\p{L}\p{M}\p{N}_-]+)*)(?=\s)/gu, (_full, tag: string) => {
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

  // Repeat. The first one wins and leaves the title; a later one stays.
  let repeatFirstDue: Date | undefined;
  const repeatMatch = REPEAT.exec(working);
  if (repeatMatch) {
    const repeat = readRepeat(repeatMatch, today);
    if (repeat?.recurrence) {
      recurrence = repeat.recurrence;
      repeatFirstDue = repeat.firstDue;
      working = working.slice(0, repeatMatch.index) + ' ' + working.slice(repeatMatch.index + repeatMatch[0].length);
    }
  }

  // Date — leftmost token wins so the user's typing order is respected.
  // Each pattern returns the YYYY-MM-DD it would set, or undefined if the
  // match was malformed (kept in title). The leading-whitespace anchor lets
  // an optional `^` prefix (start-date marker) precede the token.
  const datePatterns: Array<{
    re: RegExp;
    handler: (m: RegExpExecArray, end: number) => string | undefined;
  }> = [
    {
      // Reject an impossible ISO date (2026-02-30, 2026-13-01) so it stays in
      // the title instead of persisting verbatim and rendering as a
      // rolled-over day.
      re: /\s\^?(\d{4}-\d{2}-\d{2})(?=\s)/,
      handler: (m) => (parseLocalIsoDate(m[1] ?? '') ? m[1] : undefined),
    },
    {
      re: /\s\^?(\d{1,2})\/(\d{1,2})(?=\s)/,
      handler: (m, end) => {
        // A fraction with a title word after it ("act 2/3 of the book") is
        // part of the title; a date goes last (its time may follow it).
        const rest = working.slice(end);
        const time = TIME_AFTER_DATE.exec(rest);
        if ((time ? rest.slice(time[0].length) : rest).trim() !== '') return undefined;
        const a = parseInt(m[1] ?? '', 10);
        const b = parseInt(m[2] ?? '', 10);
        const [month, day] = options.dayFirst ? [b, a] : [a, b];
        // Validate day-vs-month BEFORE the year-roll. Without the
        // round-trip check, `2/30` constructs Mar 2 (rolled over), which is
        // then < today so the +1-year branch silently shoves it to Mar 2 of
        // NEXT year. Reject the impossible date so the token stays in the title.
        const candidate = localDate(today.getFullYear(), month, day);
        if (!candidate) return undefined;
        if (candidate < today) {
          // The same M/D one year out can be invalid (Feb 29 this leap year,
          // not next) — re-validate rather than letting Date roll it to Mar 1.
          const rolled = localDate(today.getFullYear() + 1, month, day);
          return rolled ? localIsoDate(rolled) : undefined;
        }
        return localIsoDate(candidate);
      },
    },
    {
      re: /\s\^?today(?=\s)/i,
      handler: () => localIsoDate(today),
    },
    {
      re: /\s\^?tomorrow(?=\s)/i,
      handler: () => localIsoDate(addDays(today, 1)),
    },
    {
      re: new RegExp(`\\s\\^?next\\s+(${WEEKDAY_ALT})(?=\\s)`, 'i'),
      handler: (m) => {
        const idx = WEEKDAY_WORDS[(m[1] ?? '').toLowerCase()];
        return idx === undefined ? undefined : localIsoDate(nextWeekday(today, idx));
      },
    },
    {
      re: /\s\^?in\s+(\d+)\s*(d|days?|w|weeks?|m|months?)(?=\s)/i,
      handler: (m) => {
        const count = parseInt(m[1] ?? '', 10);
        // Bound the offset so a 20-digit count can't overflow Date into
        // an Invalid Date that `localIsoDate` then stringifies as "NaN-NaN-NaN" and
        // writes to frontmatter. ~10 years is well past any quick-add horizon.
        if (!Number.isFinite(count) || count > 3650) return undefined;
        const u = (m[2] ?? '').toLowerCase()[0];
        if (u === 'd') return fmtDateOrNull(addDays(today, count));
        if (u === 'w') return fmtDateOrNull(addDays(today, count * 7));
        // Clamp month-end (Jan 31 + 1m → Feb 28) via the shared
        // helper instead of raw setMonth, which overflows to Mar 3.
        return fmtDateOrNull(addMonthsClamped(today, count));
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
      const date = handler(m, m.index + m[0].length);
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
  // both spans from the working string so the title doesn't keep `^`. A
  // clock time right after the due date is its time, unless an @time set one.
  const stripped = new Set<number>();
  for (const m of matches) {
    let length = m.length;
    if (m.isStart) {
      if (startDate) continue;
      startDate = m.date;
    } else {
      if (dueDate) continue;
      dueDate = m.date;
      const time = TIME_AFTER_DATE.exec(working.slice(m.index + m.length));
      const clock = time ? parseClockTime(time[1] ?? '') : null;
      if (time && clock) {
        dueTime ??= clock;
        length += time[0].length;
      }
    }
    for (let i = m.index; i < m.index + length; i++) stripped.add(i);
  }
  if (stripped.size > 0) {
    let cleaned = '';
    for (let i = 0; i < working.length; i++) {
      cleaned += stripped.has(i) ? ' ' : working[i];
    }
    working = cleaned;
  }
  if (recurrence && !dueDate && repeatFirstDue) dueDate = localIsoDate(repeatFirstDue);

  const title = working.replace(/\s+/g, ' ').trim();
  // Dedupe tags while preserving first-occurrence order.
  const dedupedTags = Array.from(new Set(tags));

  const out: QuickAddParsed = { title, dueDate, dueTime, startDate, priority, tags: dedupedTags, status };
  if (recurrence) out.recurrence = recurrence;
  return out;
}

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

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function nextWeekday(today: Date, dayIdx: number): Date {
  const out = new Date(today);
  // "next mon" always means the upcoming Monday strictly after today.
  // If today IS a Monday, we mean Monday next week (+7 days), not today.
  const diff = (dayIdx - today.getDay() + 7) % 7 || 7;
  out.setDate(today.getDate() + diff);
  return out;
}

function parseClockTime(s: string): string | null {
  const m = /^(\d{1,2})(?::(\d{2}))?(am|pm)?$/i.exec(s);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[3]?.toLowerCase();
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

  // Priority — try `!!word`, then bare `!!`, then `!word`.
  working = working.replace(/\s!!(urgent|high|med(?:ium)?|low)(?=\s)/i, (_m, w: string) => {
    priority = normalizePriority(w);
    return ' ';
  });
  if (!priority) {
    working = working.replace(/\s!!(?=\s)/, () => {
      priority = 'urgent';
      return ' ';
    });
  }
  if (!priority) {
    working = working.replace(/\s!(urgent|high|med(?:ium)?|low)(?=\s)/i, (_m, w: string) => {
      priority = normalizePriority(w);
      return ' ';
    });
  }

  // Status.
  working = working.replace(/\s=([a-zA-Z0-9_-]+)(?=\s)/, (_m, s: string) => {
    status = s;
    return ' ';
  });

  // Time of day.
  working = working.replace(/\s@(\d{1,2}(?::\d{2})?(?:am|pm)?)(?=\s)/i, (_m, t: string) => {
    const parsed = parseClockTime(t);
    if (parsed) dueTime = parsed;
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
    { re: /\s\^?(\d{4}-\d{2}-\d{2})(?=\s)/, handler: (m) => m[1] },
    {
      re: /\s\^?(\d{1,2})\/(\d{1,2})(?=\s)/,
      handler: (m) => {
        const month = parseInt(m[1], 10);
        const day = parseInt(m[2], 10);
        if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
        const candidate = new Date(today.getFullYear(), month - 1, day);
        candidate.setHours(0, 0, 0, 0);
        if (candidate < today) candidate.setFullYear(today.getFullYear() + 1);
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
        const idx = WEEKDAYS.indexOf(m[1].toLowerCase());
        if (idx < 0) return undefined;
        return fmtDate(nextWeekday(today, idx));
      },
    },
    {
      re: /\s\^?in\s+(\d+)\s*(d|days?|w|weeks?|m|months?)(?=\s)/i,
      handler: (m) => {
        const count = parseInt(m[1], 10);
        const u = m[2].toLowerCase()[0];
        const t = new Date(today);
        if (u === 'd') t.setDate(t.getDate() + count);
        else if (u === 'w') t.setDate(t.getDate() + count * 7);
        else if (u === 'm') t.setMonth(t.getMonth() + count);
        return fmtDate(t);
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

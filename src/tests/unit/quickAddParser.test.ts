import { describe, it, expect } from 'vitest';
import { parseQuickAdd } from '@renderer/lib/tasks/quickAddParser';
import { parseRecurrence } from '@renderer/lib/tasks/recurrence';

// Anchor every test to a fixed "now" so weekday math stays deterministic.
// 2026-05-15 is a Friday (verified: Date.getDay() returns 5).
const NOW = new Date(2026, 4, 15, 10, 30); // local time, no TZ surprises

describe('parseQuickAdd: plain titles', () => {
  it('returns empty title and no metadata for empty input', () => {
    const r = parseQuickAdd('', { now: NOW });
    expect(r).toEqual({ title: '', tags: [] });
  });

  it('returns input as-is when no tokens are present', () => {
    const r = parseQuickAdd('Buy groceries', { now: NOW });
    expect(r).toEqual({ title: 'Buy groceries', tags: [] });
  });

  it('preserves internal whitespace but trims and normalises edges', () => {
    const r = parseQuickAdd('  Buy   groceries  ', { now: NOW });
    expect(r.title).toBe('Buy groceries');
  });
});

describe('parseQuickAdd: tags', () => {
  it('extracts a single tag', () => {
    const r = parseQuickAdd('Buy milk #shopping', { now: NOW });
    expect(r.title).toBe('Buy milk');
    expect(r.tags).toEqual(['shopping']);
  });

  it('extracts multiple tags in order', () => {
    const r = parseQuickAdd('Buy milk #shopping #food', { now: NOW });
    expect(r.tags).toEqual(['shopping', 'food']);
    expect(r.title).toBe('Buy milk');
  });

  it('takes nested and non-ASCII tags', () => {
    const r = parseQuickAdd('Plan trip #work/filo #café #日本 #Ärger', { now: NOW });
    expect(r.tags).toEqual(['work/filo', 'café', '日本', 'Ärger']);
    expect(r.title).toBe('Plan trip');
  });

  it('dedupes repeated tags', () => {
    const r = parseQuickAdd('Buy #x milk #x', { now: NOW });
    expect(r.tags).toEqual(['x']);
    expect(r.title).toBe('Buy milk');
  });

  it('does not match # mid-word, and a tag needs a letter', () => {
    const r = parseQuickAdd('Issue #123 and abc#tag', { now: NOW });
    expect(r.tags).toEqual([]);
    expect(r.title).toBe('Issue #123 and abc#tag');
  });

  it('keeps a chapter number in the title, and takes a tag that has a letter (E-05)', () => {
    const r = parseQuickAdd('Revise Chapter #3 #2026-goals #v2', { now: NOW });
    expect(r.tags).toEqual(['2026-goals', 'v2']);
    expect(r.title).toBe('Revise Chapter #3');
  });

  it('accepts hyphens and underscores in tag names', () => {
    const r = parseQuickAdd('Work on #my-cool_tag', { now: NOW });
    expect(r.tags).toEqual(['my-cool_tag']);
  });
});

describe('parseQuickAdd: priority', () => {
  it('parses !high', () => {
    const r = parseQuickAdd('Ship it !high', { now: NOW });
    expect(r.priority).toBe('high');
    expect(r.title).toBe('Ship it');
  });

  it('parses !urgent', () => {
    const r = parseQuickAdd('!urgent Ship', { now: NOW });
    expect(r.priority).toBe('urgent');
    expect(r.title).toBe('Ship');
  });

  it('parses !med and !medium as medium', () => {
    expect(parseQuickAdd('x !med', { now: NOW }).priority).toBe('medium');
    expect(parseQuickAdd('x !medium', { now: NOW }).priority).toBe('medium');
  });

  it('parses !low', () => {
    expect(parseQuickAdd('x !low', { now: NOW }).priority).toBe('low');
  });

  it('parses !! shorthand as urgent', () => {
    const r = parseQuickAdd('Ship !!', { now: NOW });
    expect(r.priority).toBe('urgent');
    expect(r.title).toBe('Ship');
  });

  it('parses !!high as high', () => {
    const r = parseQuickAdd('Ship !!high', { now: NOW });
    expect(r.priority).toBe('high');
    expect(r.title).toBe('Ship');
  });

  it('ignores bare ! followed by garbage', () => {
    const r = parseQuickAdd('Wait! Do thing', { now: NOW });
    expect(r.priority).toBeUndefined();
    expect(r.title).toBe('Wait! Do thing');
  });
});

describe('parseQuickAdd: status', () => {
  it('parses =in-progress', () => {
    const r = parseQuickAdd('Build feature =in-progress', { now: NOW });
    expect(r.status).toBe('in-progress');
    expect(r.title).toBe('Build feature');
  });

  it('parses =doing', () => {
    expect(parseQuickAdd('x =doing', { now: NOW }).status).toBe('doing');
  });
});

describe('parseQuickAdd: time-of-day', () => {
  it('parses @5pm as 17:00', () => {
    const r = parseQuickAdd('Meeting @5pm', { now: NOW });
    expect(r.dueTime).toBe('17:00');
    expect(r.title).toBe('Meeting');
  });

  it('parses @9am as 09:00', () => {
    expect(parseQuickAdd('x @9am', { now: NOW }).dueTime).toBe('09:00');
  });

  it('parses @12am as 00:00 (midnight)', () => {
    expect(parseQuickAdd('x @12am', { now: NOW }).dueTime).toBe('00:00');
  });

  it('parses @12pm as 12:00 (noon)', () => {
    expect(parseQuickAdd('x @12pm', { now: NOW }).dueTime).toBe('12:00');
  });

  it('parses @17:30 as 17:30 (24h)', () => {
    expect(parseQuickAdd('x @17:30', { now: NOW }).dueTime).toBe('17:30');
  });

  it('parses @9:00am as 09:00', () => {
    expect(parseQuickAdd('x @9:00am', { now: NOW }).dueTime).toBe('09:00');
  });

  it('rejects invalid times silently (keeps in title)', () => {
    const r = parseQuickAdd('x @25pm', { now: NOW });
    expect(r.dueTime).toBeUndefined();
  });
});

describe('parseQuickAdd: dates', () => {
  it('parses "today"', () => {
    const r = parseQuickAdd('Task today', { now: NOW });
    expect(r.dueDate).toBe('2026-05-15');
    expect(r.title).toBe('Task');
  });

  it('parses "tomorrow"', () => {
    const r = parseQuickAdd('Task tomorrow', { now: NOW });
    expect(r.dueDate).toBe('2026-05-16');
  });

  it('parses "next mon" (next Monday — Fri NOW → following Mon)', () => {
    const r = parseQuickAdd('Task next mon', { now: NOW });
    expect(r.dueDate).toBe('2026-05-18');
  });

  it('parses "next monday" as well', () => {
    expect(parseQuickAdd('Task next monday', { now: NOW }).dueDate).toBe('2026-05-18');
  });

  it('"next fri" from Fri NOW returns Friday next week', () => {
    // NOW is Friday 2026-05-15. "next fri" = strictly future Friday = +7 = 2026-05-22.
    expect(parseQuickAdd('Task next fri', { now: NOW }).dueDate).toBe('2026-05-22');
  });

  it('parses "in 3d" as 3 days from today', () => {
    expect(parseQuickAdd('Task in 3d', { now: NOW }).dueDate).toBe('2026-05-18');
  });

  it('parses "in 2w" as 14 days from today', () => {
    expect(parseQuickAdd('Task in 2w', { now: NOW }).dueDate).toBe('2026-05-29');
  });

  it('parses "in 1m" as 1 calendar month from today', () => {
    expect(parseQuickAdd('Task in 1m', { now: NOW }).dueDate).toBe('2026-06-15');
  });

  // Audit-8 L6 — month-end must clamp, not overflow (Jan 31 + 1m → Feb 28/29,
  // matching the recurrence engine; raw setMonth would roll to Mar 3).
  it('clamps "in 1m" at month-end (Jan 31 → Feb 28, non-leap)', () => {
    const jan31 = new Date(2026, 0, 31, 10, 0);
    expect(parseQuickAdd('Pay rent in 1m', { now: jan31 }).dueDate).toBe('2026-02-28');
  });

  it('clamps "in 1m" into a leap February (Jan 31 → Feb 29)', () => {
    const jan31 = new Date(2028, 0, 31, 10, 0);
    expect(parseQuickAdd('x in 1m', { now: jan31 }).dueDate).toBe('2028-02-29');
  });

  it('parses ISO date YYYY-MM-DD', () => {
    expect(parseQuickAdd('Task 2026-12-31', { now: NOW }).dueDate).toBe('2026-12-31');
  });

  it('parses M/D in the current year when in the future', () => {
    expect(parseQuickAdd('Task 6/1', { now: NOW }).dueDate).toBe('2026-06-01');
  });

  it('parses M/D and rolls to next year when in the past', () => {
    expect(parseQuickAdd('Task 1/1', { now: NOW }).dueDate).toBe('2027-01-01');
  });

  it('does not match "today" inside other words', () => {
    const r = parseQuickAdd("Today's lesson", { now: NOW });
    expect(r.dueDate).toBeUndefined();
    expect(r.title).toBe("Today's lesson");
  });

  it('first date token wins, later ones stay in the title', () => {
    const r = parseQuickAdd('Task tomorrow today', { now: NOW });
    expect(r.dueDate).toBe('2026-05-16');
    expect(r.title).toBe('Task today');
  });
});

describe('parseQuickAdd: invalid dates stay in the title (QA-1/2/3)', () => {
  // The handlers must reject impossible/overflow dates so they are never written
  // verbatim to canonical frontmatter (where the app would then render/treat
  // them as a rolled-over day). A rejected token is left in the title untouched.

  it('QA-1: rejects an impossible ISO day (Feb 30)', () => {
    const r = parseQuickAdd('Pay rent 2026-02-30', { now: NOW });
    expect(r.dueDate).toBeUndefined();
    expect(r.title).toBe('Pay rent 2026-02-30');
  });

  it('QA-1: rejects an out-of-range ISO month (13) and zero month/day', () => {
    expect(parseQuickAdd('x 2026-13-01', { now: NOW }).dueDate).toBeUndefined();
    expect(parseQuickAdd('x 2026-00-00', { now: NOW }).dueDate).toBeUndefined();
    expect(parseQuickAdd('x 2026-02-00', { now: NOW }).dueDate).toBeUndefined();
  });

  it('QA-2: rejects M/D Feb 30 instead of rolling it to next-year Mar 2', () => {
    const r = parseQuickAdd('Pay rent 2/30', { now: NOW });
    expect(r.dueDate).toBeUndefined();
    expect(r.title).toBe('Pay rent 2/30');
  });

  it('QA-2: rejects M/D Apr 31', () => {
    expect(parseQuickAdd('x 4/31', { now: NOW }).dueDate).toBeUndefined();
  });

  it('QA-2: rejects 2/29 in a non-leap year (NOW=2026)', () => {
    expect(parseQuickAdd('x 2/29', { now: NOW }).dueDate).toBeUndefined();
  });

  it('QA-3: rejects a numeric-overflow offset instead of writing NaN-NaN-NaN', () => {
    const r = parseQuickAdd('Do thing in 99999999999999999999d', { now: NOW });
    expect(r.dueDate).toBeUndefined();
    expect(r.title).toBe('Do thing in 99999999999999999999d');
  });

  it('QA-3: rejects an out-of-bounds month/week offset', () => {
    expect(parseQuickAdd('x in 9999999999m', { now: NOW }).dueDate).toBeUndefined();
    expect(parseQuickAdd('x in 4000w', { now: NOW }).dueDate).toBeUndefined();
  });

  it('CONTROL: a leap-day 2/29 still parses in a leap year (NOW=2028)', () => {
    const leapNow = new Date(2028, 0, 10, 10, 0); // 2028-01-10, before Feb 29
    expect(parseQuickAdd('x 2/29', { now: leapNow }).dueDate).toBe('2028-02-29');
  });

  it('CONTROL: valid ISO + M/D + bounded offset still parse', () => {
    expect(parseQuickAdd('x 2026-12-31', { now: NOW }).dueDate).toBe('2026-12-31');
    expect(parseQuickAdd('x 6/1', { now: NOW }).dueDate).toBe('2026-06-01');
    expect(parseQuickAdd('x in 30d', { now: NOW }).dueDate).toBe('2026-06-14');
  });
});

describe('parseQuickAdd: start date (caret prefix)', () => {
  it('parses ^tomorrow as startDate, no dueDate', () => {
    const r = parseQuickAdd('Defer me ^tomorrow', { now: NOW });
    expect(r.startDate).toBe('2026-05-16');
    expect(r.dueDate).toBeUndefined();
    expect(r.title).toBe('Defer me');
  });

  it('parses ^next mon as startDate', () => {
    const r = parseQuickAdd('Hold ^next mon', { now: NOW });
    expect(r.startDate).toBe('2026-05-18');
  });

  it('parses ^2026-06-01 as startDate', () => {
    const r = parseQuickAdd('Wait until ^2026-06-01', { now: NOW });
    expect(r.startDate).toBe('2026-06-01');
  });

  it('parses ^in 3d as startDate', () => {
    const r = parseQuickAdd('Hide ^in 3d', { now: NOW });
    expect(r.startDate).toBe('2026-05-18');
  });

  it('parses both start and due in the same input', () => {
    const r = parseQuickAdd('Plan ^tomorrow tomorrow next week', { now: NOW });
    expect(r.startDate).toBe('2026-05-16');
    expect(r.dueDate).toBe('2026-05-16');
    // "next week" isn't a token; it stays in the title.
    expect(r.title).toBe('Plan next week');
  });

  it('strips the caret from the title', () => {
    const r = parseQuickAdd('Plan ^tomorrow', { now: NOW });
    expect(r.title).toBe('Plan');
  });
});

describe('parseQuickAdd: combined', () => {
  it('parses the canonical Vikunja-style example', () => {
    const r = parseQuickAdd('Submit report tomorrow !!high #work', { now: NOW });
    expect(r).toEqual({
      title: 'Submit report',
      dueDate: '2026-05-16',
      priority: 'high',
      tags: ['work'],
    });
  });

  it('parses a richly-tokened entry in any order', () => {
    const r = parseQuickAdd('!urgent #ops Patch CVE today @9am =doing #security', { now: NOW });
    expect(r.title).toBe('Patch CVE');
    expect(r.dueDate).toBe('2026-05-15');
    expect(r.dueTime).toBe('09:00');
    expect(r.priority).toBe('urgent');
    expect(r.status).toBe('doing');
    expect(r.tags).toEqual(['ops', 'security']);
  });

  it('handles tokens at start of input', () => {
    const r = parseQuickAdd('#urgent tomorrow !high Ship it', { now: NOW });
    expect(r.title).toBe('Ship it');
    expect(r.tags).toEqual(['urgent']);
    expect(r.priority).toBe('high');
    expect(r.dueDate).toBe('2026-05-16');
  });
});

describe('parseQuickAdd: malformed @time stays in the title (QA-4)', () => {
  it('keeps a non-time @token in the title instead of swallowing it', () => {
    const r = parseQuickAdd('Meet @99 East St', { now: NOW });
    expect(r.dueTime).toBeUndefined();
    expect(r.title).toBe('Meet @99 East St');
  });

  it('keeps an invalid am/pm @time in the title', () => {
    const r = parseQuickAdd('x @13pm', { now: NOW });
    expect(r.dueTime).toBeUndefined();
    expect(r.title).toBe('x @13pm');
  });
});

describe('parseQuickAdd: am/pm hour bounds (QA-5)', () => {
  it('rejects @13pm..@23pm (the suffix is meaningless past 12)', () => {
    expect(parseQuickAdd('x @13pm', { now: NOW }).dueTime).toBeUndefined();
    expect(parseQuickAdd('x @23pm', { now: NOW }).dueTime).toBeUndefined();
  });

  it('rejects @0am (use @12am for midnight)', () => {
    expect(parseQuickAdd('x @0am', { now: NOW }).dueTime).toBeUndefined();
  });

  it('still accepts the valid am/pm range', () => {
    expect(parseQuickAdd('x @1pm', { now: NOW }).dueTime).toBe('13:00');
    expect(parseQuickAdd('x @11pm', { now: NOW }).dueTime).toBe('23:00');
    expect(parseQuickAdd('x @12am', { now: NOW }).dueTime).toBe('00:00');
    expect(parseQuickAdd('x @12pm', { now: NOW }).dueTime).toBe('12:00');
  });
});

describe('parseQuickAdd: duplicate tokens stripped, first wins (QA-8)', () => {
  it('strips a second @time from the title', () => {
    const r = parseQuickAdd('x @9am @5pm', { now: NOW });
    expect(r.dueTime).toBe('09:00');
    expect(r.title).toBe('x');
  });

  it('strips a second !priority from the title', () => {
    const r = parseQuickAdd('x !high !low', { now: NOW });
    expect(r.priority).toBe('high');
    expect(r.title).toBe('x');
  });

  it('strips a second =status from the title', () => {
    const r = parseQuickAdd('x =todo =done', { now: NOW });
    expect(r.status).toBe('todo');
    expect(r.title).toBe('x');
  });
});

describe('parseQuickAdd: status case + tag case (QA-9)', () => {
  it('lowercases status at write (FIELD_READERS.status reads it lowercased)', () => {
    const r = parseQuickAdd('Build feature =In-Progress', { now: NOW });
    expect(r.status).toBe('in-progress');
  });

  it('preserves tag case (tags are NOT read lowercased)', () => {
    // DECISION: tags keep their authored case — every other tag-add path does,
    // and FIELD_READERS.tags / normalizeTagsField do not lowercase. Only status
    // is lowercased at write.
    const r = parseQuickAdd('x #Work', { now: NOW });
    expect(r.tags).toEqual(['Work']);
  });
});

describe('parseQuickAdd: next-weekday is one uniform rule (QA-6)', () => {
  // NOW = Friday 2026-05-15. "next <wd>" = soonest occurrence STRICTLY after
  // today, applied identically to every weekday (today excluded ⇒ same weekday
  // lands a week out).
  it('next sat = +1 (this coming Saturday)', () => {
    expect(parseQuickAdd('x next sat', { now: NOW }).dueDate).toBe('2026-05-16');
  });
  it('next sun = +2 (this coming Sunday)', () => {
    expect(parseQuickAdd('x next sun', { now: NOW }).dueDate).toBe('2026-05-17');
  });
  it('next thu = +6 (this coming Thursday)', () => {
    expect(parseQuickAdd('x next thu', { now: NOW }).dueDate).toBe('2026-05-21');
  });
  it('next fri (same weekday) = +7, not today', () => {
    expect(parseQuickAdd('x next fri', { now: NOW }).dueDate).toBe('2026-05-22');
  });
});

describe('parseQuickAdd: day-first d/m for day-first locales (BL-8)', () => {
  const SEPT_23 = new Date(2026, 8, 23, 10, 0);

  it('"Dentist 3/4" is 3 April (past this year → next year)', () => {
    const r = parseQuickAdd('Dentist 3/4', { now: SEPT_23, dayFirst: true });
    expect(r.dueDate).toBe('2027-04-03');
    expect(r.title).toBe('Dentist');
  });

  it('"25/12" is 25 December', () => {
    expect(parseQuickAdd('Party 25/12', { now: SEPT_23, dayFirst: true }).dueDate).toBe('2026-12-25');
  });

  it('"31/2" is rejected and stays in the title', () => {
    const r = parseQuickAdd('Report 31/2', { now: SEPT_23, dayFirst: true });
    expect(r.dueDate).toBeUndefined();
    expect(r.title).toBe('Report 31/2');
  });

  it('^d/m sets the start date in day-first order too', () => {
    expect(parseQuickAdd('Plan ^1/10', { now: SEPT_23, dayFirst: true }).startDate).toBe('2026-10-01');
  });

  it('dayFirst: false keeps month/day ("3/4" is 4 March)', () => {
    expect(parseQuickAdd('Dentist 3/4', { now: SEPT_23, dayFirst: false }).dueDate).toBe('2027-03-04');
    expect(parseQuickAdd('Dentist 3/4', { now: SEPT_23 }).dueDate).toBe('2027-03-04');
  });
});

describe('parseQuickAdd: only weekday names are weekdays (E-05)', () => {
  // Sunday 2026-10-04, local noon (the audit's repro day).
  const SUN = new Date(2026, 9, 4, 12, 0, 0);

  it.each([
    ['Review plot outline next month'],
    ['Draft the next wedding scene'],
    ['Introduce the next friend'],
    ['Write the next sunrise chapter'],
    ['Plan the next satire piece'],
    ['Fix the next thumbnail'],
  ])('"%s" has no date and keeps its words', (input) => {
    const r = parseQuickAdd(input, { now: SUN });
    expect(r.dueDate).toBeUndefined();
    expect(r.title).toBe(input);
  });

  it.each([
    ['next monday', '2026-10-05'],
    ['next tues', '2026-10-06'],
    ['next weds', '2026-10-07'],
    ['next thurs', '2026-10-08'],
    ['next thur', '2026-10-08'],
    ['next friday', '2026-10-09'],
    ['next sat', '2026-10-10'],
    ['next Sunday', '2026-10-11'],
  ])('"%s" is a weekday', (words, date) => {
    const r = parseQuickAdd(`Call mum ${words}`, { now: SUN });
    expect(r.dueDate).toBe(date);
    expect(r.title).toBe('Call mum');
  });
});

describe('parseQuickAdd: a fraction between words is not a date (E-05)', () => {
  const SUN = new Date(2026, 9, 4, 12, 0, 0);

  it('"act 2/3 of the book" keeps its fraction', () => {
    const r = parseQuickAdd('Revise act 2/3 of the book', { now: SUN, dayFirst: true });
    expect(r.dueDate).toBeUndefined();
    expect(r.title).toBe('Revise act 2/3 of the book');
  });

  it('a date as the last word is still a date, with tokens after it', () => {
    const r = parseQuickAdd('Pay rent 5/12 #home !high', { now: SUN, dayFirst: true });
    expect(r.dueDate).toBe('2026-12-05');
    expect(r.title).toBe('Pay rent');
    expect(r.tags).toEqual(['home']);
  });

  it('a date followed by its time is still a date', () => {
    const r = parseQuickAdd('Dentist 5/12 9:30am', { now: SUN, dayFirst: true });
    expect(r.dueDate).toBe('2026-12-05');
    expect(r.dueTime).toBe('09:30');
    expect(r.title).toBe('Dentist');
  });
});

describe('parseQuickAdd: a time after the date (E-05)', () => {
  it('reads "tomorrow 5pm"', () => {
    const r = parseQuickAdd('Call the printer tomorrow 5pm', { now: NOW });
    expect(r.dueDate).toBe('2026-05-16');
    expect(r.dueTime).toBe('17:00');
    expect(r.title).toBe('Call the printer');
  });

  it('reads "at", a space before pm, and a 24-hour time', () => {
    expect(parseQuickAdd('x next mon at 9:15am', { now: NOW })).toMatchObject({ dueDate: '2026-05-18', dueTime: '09:15', title: 'x' });
    expect(parseQuickAdd('x today 5 pm', { now: NOW })).toMatchObject({ dueDate: '2026-05-15', dueTime: '17:00', title: 'x' });
    expect(parseQuickAdd('x 2026-06-01 17:30', { now: NOW })).toMatchObject({ dueDate: '2026-06-01', dueTime: '17:30', title: 'x' });
  });

  it('leaves a bare number after the date in the title', () => {
    const r = parseQuickAdd('Meet tomorrow 10 people', { now: NOW });
    expect(r.dueTime).toBeUndefined();
    expect(r.title).toBe('Meet 10 people');
  });

  it('an @time wins over a time after the date', () => {
    const r = parseQuickAdd('x tomorrow 5pm @9am', { now: NOW });
    expect(r.dueTime).toBe('09:00');
    expect(r.title).toBe('x');
  });

  it('a start date takes no time', () => {
    const r = parseQuickAdd('x ^tomorrow 5pm', { now: NOW });
    expect(r.startDate).toBe('2026-05-16');
    expect(r.dueTime).toBeUndefined();
    expect(r.title).toBe('x 5pm');
  });
});

describe('parseQuickAdd: repeats (D8)', () => {
  // NOW is Friday 2026-05-15.
  it('"every friday" repeats weekly from the next Friday (today counts)', () => {
    const r = parseQuickAdd('Water plants every friday', { now: NOW });
    expect(r.recurrence).toBe('weekly');
    expect(r.dueDate).toBe('2026-05-15');
    expect(r.title).toBe('Water plants');
  });

  it('"every mon" starts on the coming Monday', () => {
    expect(parseQuickAdd('Standup every mon', { now: NOW })).toMatchObject({ recurrence: 'weekly', dueDate: '2026-05-18', title: 'Standup' });
  });

  it('"every 2 weeks", "every 3 days", "every 6 months", "every 2 years"', () => {
    expect(parseQuickAdd('x every 2 weeks', { now: NOW })).toMatchObject({ recurrence: 'every 2 weeks', dueDate: '2026-05-15', title: 'x' });
    expect(parseQuickAdd('x every 3 days', { now: NOW }).recurrence).toBe('every 3 days');
    expect(parseQuickAdd('x every 6 months', { now: NOW }).recurrence).toBe('every 6 months');
    expect(parseQuickAdd('x every 2 years', { now: NOW }).recurrence).toBe('every 2 years');
  });

  it('"every day / week / month / year" and "every 1 week" use the plain names', () => {
    expect(parseQuickAdd('x every day', { now: NOW }).recurrence).toBe('daily');
    expect(parseQuickAdd('x every week', { now: NOW }).recurrence).toBe('weekly');
    expect(parseQuickAdd('x every month', { now: NOW }).recurrence).toBe('monthly');
    expect(parseQuickAdd('x every year', { now: NOW }).recurrence).toBe('yearly');
    expect(parseQuickAdd('x every 1 week', { now: NOW }).recurrence).toBe('weekly');
  });

  it('"every other week" and "every other friday" are every 2 weeks', () => {
    expect(parseQuickAdd('x every other week', { now: NOW }).recurrence).toBe('every 2 weeks');
    expect(parseQuickAdd('x every other tuesday', { now: NOW })).toMatchObject({ recurrence: 'every 2 weeks', dueDate: '2026-05-19' });
  });

  it('"every weekday" starts today on a weekday, else on Monday', () => {
    expect(parseQuickAdd('x every weekday', { now: NOW })).toMatchObject({ recurrence: 'weekday', dueDate: '2026-05-15' });
    const sat = new Date(2026, 4, 16, 9, 0);
    expect(parseQuickAdd('x every weekday', { now: sat })).toMatchObject({ recurrence: 'weekday', dueDate: '2026-05-18' });
  });

  it('a date typed with the repeat is its first due date', () => {
    expect(parseQuickAdd('Pay rent every month 6/1', { now: NOW })).toMatchObject({ recurrence: 'monthly', dueDate: '2026-06-01', title: 'Pay rent' });
    expect(parseQuickAdd('Report every week next wed 5pm', { now: NOW })).toMatchObject({ recurrence: 'weekly', dueDate: '2026-05-20', dueTime: '17:00', title: 'Report' });
  });

  it('every repeat it reads is one the recurrence engine reads', () => {
    for (const text of ['every day', 'every 3 days', 'every week', 'every other week', 'every friday', 'every month', 'every 6 months', 'every year', 'every weekday']) {
      const r = parseQuickAdd(`x ${text}`, { now: NOW });
      expect(parseRecurrence(r.recurrence ?? ''), text).not.toBeNull();
    }
  });

  it('words that only start like a repeat stay in the title', () => {
    for (const input of ['Do it every time', "Review every month's budget", 'Visit every daycare', 'every 0 days', 'every 2 fridays']) {
      const r = parseQuickAdd(input, { now: NOW });
      expect(r.recurrence, input).toBeUndefined();
      expect(r.title, input).toBe(input);
    }
  });
});

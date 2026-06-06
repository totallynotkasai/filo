import { describe, it, expect } from 'vitest';
import { parseQuickAdd } from '@renderer/lib/tasks/quickAddParser';

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

  it('dedupes repeated tags', () => {
    const r = parseQuickAdd('Buy #x milk #x', { now: NOW });
    expect(r.tags).toEqual(['x']);
    expect(r.title).toBe('Buy milk');
  });

  it('does not match # mid-word', () => {
    const r = parseQuickAdd('Issue #123 and abc#tag', { now: NOW });
    expect(r.tags).toEqual(['123']);
    expect(r.title).toBe('Issue and abc#tag');
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

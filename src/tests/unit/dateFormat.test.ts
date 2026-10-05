import { describe, it, expect } from 'vitest';
import {
  formatDay,
  formatDayLong,
  localDate,
  localIsoDate,
  localIsoDateInDays,
  parseLocalIsoDate,
} from '@renderer/lib/utils/dateFormat';

describe('localIsoDate', () => {
  it('formats the local calendar date, at either end of the day', () => {
    expect(localIsoDate(new Date(2026, 0, 1, 0, 1))).toBe('2026-01-01');
    expect(localIsoDate(new Date(2026, 0, 1, 23, 59))).toBe('2026-01-01');
  });

  it('pads the month and day', () => {
    expect(localIsoDate(new Date(2026, 8, 5))).toBe('2026-09-05');
  });

  it('counts days across a month and a year end', () => {
    const from = new Date(2026, 11, 30, 22, 0);
    expect(localIsoDateInDays(0, from)).toBe('2026-12-30');
    expect(localIsoDateInDays(1, from)).toBe('2026-12-31');
    expect(localIsoDateInDays(7, from)).toBe('2027-01-06');
    expect(localIsoDate(from)).toBe('2026-12-30'); // the start date is left alone
  });
});

describe('parseLocalIsoDate: the one day parser', () => {
  it('reads a day as its local midnight', () => {
    const d = parseLocalIsoDate('2026-01-01');
    expect(d && [d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2026, 0, 1, 0]);
  });

  it('refuses a day the calendar does not have, rather than rolling it into the next month', () => {
    expect(parseLocalIsoDate('2026-02-30')).toBeNull();
    expect(parseLocalIsoDate('2026-13-01')).toBeNull();
    expect(parseLocalIsoDate('2027-02-29')).toBeNull();
    expect(parseLocalIsoDate('2028-02-29')).not.toBeNull();
  });

  it('refuses any other shape', () => {
    expect(parseLocalIsoDate('')).toBeNull();
    expect(parseLocalIsoDate('12/10/2026')).toBeNull();
    expect(parseLocalIsoDate('2026-10-12T10:00')).toBeNull();
    expect(parseLocalIsoDate('Oct 12 2026')).toBeNull();
  });

  it('round-trips with localIsoDate', () => {
    for (const iso of ['2026-01-01', '2026-12-31', '2028-02-29']) {
      expect(localIsoDate(parseLocalIsoDate(iso) ?? new Date(NaN))).toBe(iso);
    }
  });
});

describe('localDate', () => {
  it('builds a real day and refuses one that would roll over', () => {
    expect(localDate(2026, 3, 2)?.getDate()).toBe(2);
    expect(localDate(2026, 2, 30)).toBeNull();
    expect(localDate(2026, 0, 1)).toBeNull();
    expect(localDate(2026, 1.5, 1)).toBeNull();
  });
});

describe('formatDay: how a day is shown', () => {
  const US = { locale: 'en-US', now: new Date(2026, 5, 1) };

  it('shows a short month and the day', () => {
    expect(formatDay('2026-05-16', US)).toBe('May 16');
    expect(formatDay('2026-08-01', US)).toBe('Aug 1');
  });

  it('follows the regional format', () => {
    expect(formatDay('2026-05-16', { ...US, locale: 'en-GB' })).toBe('16 May');
  });

  it('shows the year for a day in another year', () => {
    expect(formatDay('2027-05-16', US)).toBe('May 16, 2027');
    expect(formatDay('2025-12-31', { ...US, locale: 'en-GB' })).toBe('31 Dec 2025');
  });

  it('shows text that is not a day as written', () => {
    expect(formatDay('')).toBe('');
    expect(formatDay('not-a-date')).toBe('not-a-date');
    expect(formatDay('2026-02-30', US)).toBe('2026-02-30');
  });

  it('reads 2026-01-01 as local Jan 1 (no UTC drift)', () => {
    expect(formatDay('2026-01-01', US)).toBe('Jan 1');
  });

  it('formatDayLong spells the day out for a screen reader', () => {
    // The punctuation is the ICU version's; the words are the point.
    expect(formatDayLong('2026-10-12', { locale: 'en-GB' })).toMatch(/^Monday,? 12 October 2026$/);
    expect(formatDayLong('2026-10-12', { locale: 'en-US' })).toBe('Monday, October 12, 2026');
    expect(formatDayLong('soon', { locale: 'en-GB' })).toBe('soon');
  });
});

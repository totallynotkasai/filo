import { describe, it, expect } from 'vitest';
import { localIsoDate, localIsoDateInDays } from '@renderer/lib/utils/dateFormat';

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

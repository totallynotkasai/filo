import { describe, it, expect } from 'vitest';
import {
  formatDueDateAbsolute,
  formatDueDateRelative,
  formatTimeChip,
  isOverdue,
} from '@renderer/lib/tasks/dueDateFormat';

describe('formatDueDateAbsolute', () => {
  it('formats YYYY-MM-DD to "MMM D"', () => {
    expect(formatDueDateAbsolute('2026-05-16')).toBe('May 16');
    expect(formatDueDateAbsolute('2026-08-01')).toBe('Aug 1');
  });

  it('returns empty string for empty input', () => {
    expect(formatDueDateAbsolute('')).toBe('');
  });

  it('returns the raw input on malformed parses', () => {
    expect(formatDueDateAbsolute('not-a-date')).toBe('not-a-date');
  });

  it('parses 2026-01-01 as local Jan 1 (no UTC drift)', () => {
    // The "toISOString trap" — `new Date('2026-01-01').toISOString().slice(0,10)`
    // returns `'2025-12-31'` in negative-offset timezones. Our parser must
    // use local construction.
    expect(formatDueDateAbsolute('2026-01-01')).toBe('Jan 1');
  });
});

describe('formatDueDateRelative', () => {
  const TODAY = new Date(2026, 4, 16); // 2026-05-16

  it('formats today as "Today"', () => {
    expect(formatDueDateRelative('2026-05-16', TODAY)).toBe('Today');
  });

  it('formats tomorrow as "Tomorrow"', () => {
    expect(formatDueDateRelative('2026-05-17', TODAY)).toBe('Tomorrow');
  });

  it('formats yesterday as "Yesterday"', () => {
    expect(formatDueDateRelative('2026-05-15', TODAY)).toBe('Yesterday');
  });

  it('formats 2-6 days ahead as "In N days"', () => {
    expect(formatDueDateRelative('2026-05-18', TODAY)).toBe('In 2 days');
    expect(formatDueDateRelative('2026-05-22', TODAY)).toBe('In 6 days');
  });

  it('formats 2-6 days behind as "N days ago"', () => {
    expect(formatDueDateRelative('2026-05-14', TODAY)).toBe('2 days ago');
    expect(formatDueDateRelative('2026-05-10', TODAY)).toBe('6 days ago');
  });

  it('falls back to absolute chip outside ±6 days', () => {
    expect(formatDueDateRelative('2026-06-01', TODAY)).toBe('Jun 1');
    expect(formatDueDateRelative('2026-05-09', TODAY)).toBe('May 9');
  });

  it('returns empty string for empty input', () => {
    expect(formatDueDateRelative('', TODAY)).toBe('');
  });
});

describe('formatTimeChip', () => {
  it('formats 24-hour time to compact 12-hour chip', () => {
    expect(formatTimeChip('15:30')).toBe('3:30pm');
    expect(formatTimeChip('09:00')).toBe('9am');
    expect(formatTimeChip('00:00')).toBe('12am');
    expect(formatTimeChip('12:00')).toBe('12pm');
    expect(formatTimeChip('00:30')).toBe('12:30am');
  });

  it('returns the input unchanged on malformed value', () => {
    expect(formatTimeChip('3pm')).toBe('3pm');
    expect(formatTimeChip('')).toBe('');
  });
});

describe('isOverdue', () => {
  const TODAY = new Date(2026, 4, 16);

  it('returns false when no dueDate', () => {
    expect(isOverdue('', false, TODAY)).toBe(false);
  });

  it('returns false when already completed', () => {
    expect(isOverdue('2026-05-10', true, TODAY)).toBe(false);
  });

  it('returns true when dueDate is strictly before today', () => {
    expect(isOverdue('2026-05-15', false, TODAY)).toBe(true);
  });

  it('returns false when dueDate is today', () => {
    expect(isOverdue('2026-05-16', false, TODAY)).toBe(false);
  });

  it('returns false when dueDate is in the future', () => {
    expect(isOverdue('2026-05-17', false, TODAY)).toBe(false);
  });

  it('returns false on malformed dueDate', () => {
    expect(isOverdue('not-a-date', false, TODAY)).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { formatTimeChip, isOverdue } from '@renderer/lib/tasks/dueDateFormat';

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

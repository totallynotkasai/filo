import { describe, it, expect } from 'vitest';
import { addMonthsClamped } from '@renderer/lib/tasks/dateMath';

// Local-date ISO (no TZ surprises) so the assertions read calendar-clearly.
function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

describe('addMonthsClamped (Audit-8 L6)', () => {
  it('preserves the day-of-month within a long-enough target month', () => {
    expect(iso(addMonthsClamped(new Date(2026, 4, 15), 1))).toBe('2026-06-15');
  });

  it('clamps Jan 31 + 1m to Feb 28 in a non-leap year (no overflow to Mar)', () => {
    expect(iso(addMonthsClamped(new Date(2026, 0, 31), 1))).toBe('2026-02-28');
  });

  it('clamps Jan 31 + 1m to Feb 29 in a leap year', () => {
    expect(iso(addMonthsClamped(new Date(2028, 0, 31), 1))).toBe('2028-02-29');
  });

  it('clamps a 31-day source into a 30-day target (May 31 + 6m → Nov 30)', () => {
    expect(iso(addMonthsClamped(new Date(2026, 4, 31), 6))).toBe('2026-11-30');
  });

  it('wraps the year boundary forward', () => {
    expect(iso(addMonthsClamped(new Date(2026, 11, 15), 1))).toBe('2027-01-15');
  });

  it('handles a negative count (Mar 31 − 1m → Feb 28)', () => {
    expect(iso(addMonthsClamped(new Date(2026, 2, 31), -1))).toBe('2026-02-28');
  });

  it('does not mutate the input date', () => {
    const from = new Date(2026, 0, 31);
    addMonthsClamped(from, 1);
    expect(iso(from)).toBe('2026-01-31');
  });
});

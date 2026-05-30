import { describe, it, expect } from 'vitest';
import { nextDueDate, parseRecurrence, type RecurrenceMode } from '@renderer/lib/tasks/recurrence';

/**
 * Phase 6 — "complete a recurring task" flow coverage.
 *
 * The TaskListBoard.toggleCompleted path is the production caller. It only
 * uses the pure `nextDueDate` helper, so we can reproduce the flow by:
 *   1. Reading the row's current dueDate + recurrence + recurrenceMode.
 *   2. Calling nextDueDate(dueDate, recurrence, mode, new Date()).
 *   3. If non-null, writing back `{ completed: false, dueDate: next }`.
 *   4. Otherwise, flipping `completed`.
 *
 * These tests exercise that decision tree against representative inputs so
 * the behaviour is locked even though the consuming code lives inside a
 * Svelte component.
 */

interface RowSnapshot {
  completed: boolean;
  dueDate: string;
  recurrence: string;
  recurrenceMode: RecurrenceMode;
}

interface CompletionDecision {
  rolledForward: boolean;
  nextDueDate?: string;
  completed: boolean;
}

/**
 * Mirror of TaskListBoard's `toggleCompleted` decision tree. Pure — accepts
 * an explicit `now` so tests can pin time.
 */
function decideCompletion(row: RowSnapshot, now: Date): CompletionDecision {
  if (!row.completed && row.recurrence) {
    const next = nextDueDate(
      row.dueDate || undefined,
      row.recurrence,
      row.recurrenceMode,
      now,
    );
    if (next) {
      return { rolledForward: true, nextDueDate: next, completed: false };
    }
  }
  return { rolledForward: false, completed: !row.completed };
}

describe('decideCompletion — non-recurring rows toggle in place', () => {
  it('flips completed=false → true', () => {
    const out = decideCompletion(
      { completed: false, dueDate: '2026-05-20', recurrence: '', recurrenceMode: 'schedule' },
      new Date(),
    );
    expect(out).toEqual({ rolledForward: false, completed: true });
  });

  it('flips completed=true → false', () => {
    const out = decideCompletion(
      { completed: true, dueDate: '2026-05-20', recurrence: '', recurrenceMode: 'schedule' },
      new Date(),
    );
    expect(out).toEqual({ rolledForward: false, completed: false });
  });
});

describe('decideCompletion — recurring rows roll forward on first complete', () => {
  const NOW = new Date(2026, 4, 15, 14, 0); // Fri 2026-05-15 14:00 local

  it('schedule mode advances dueDate by the parsed interval', () => {
    const out = decideCompletion(
      { completed: false, dueDate: '2026-05-15', recurrence: 'weekly', recurrenceMode: 'schedule' },
      NOW,
    );
    expect(out.rolledForward).toBe(true);
    expect(out.nextDueDate).toBe('2026-05-22');
    expect(out.completed).toBe(false);
  });

  it('completion mode advances from "now" not from dueDate', () => {
    const out = decideCompletion(
      { completed: false, dueDate: '2026-01-01', recurrence: 'weekly', recurrenceMode: 'completion' },
      NOW,
    );
    expect(out.nextDueDate).toBe('2026-05-22'); // NOW + 7d
    expect(out.completed).toBe(false);
  });

  it('weekday recurrence: Friday completion rolls to Monday', () => {
    const out = decideCompletion(
      { completed: false, dueDate: '2026-05-15', recurrence: 'weekday', recurrenceMode: 'schedule' },
      NOW,
    );
    expect(out.nextDueDate).toBe('2026-05-18');
  });

  it('"every 3d" advances by 3 days from dueDate', () => {
    const out = decideCompletion(
      { completed: false, dueDate: '2026-05-15', recurrence: 'every 3d', recurrenceMode: 'schedule' },
      NOW,
    );
    expect(out.nextDueDate).toBe('2026-05-18');
  });

  it('monthly across leap-year edge: 2028-01-31 → 2028-02-29', () => {
    const out = decideCompletion(
      { completed: false, dueDate: '2028-01-31', recurrence: 'monthly', recurrenceMode: 'schedule' },
      new Date(2028, 0, 31),
    );
    expect(out.nextDueDate).toBe('2028-02-29');
  });

  it('monthly clamps Jan 31 to Feb 28 in non-leap year', () => {
    const out = decideCompletion(
      { completed: false, dueDate: '2026-01-31', recurrence: 'monthly', recurrenceMode: 'schedule' },
      new Date(2026, 0, 31),
    );
    expect(out.nextDueDate).toBe('2026-02-28');
  });

  it('yearly across Feb 29: 2028-02-29 → 2029-02-28', () => {
    const out = decideCompletion(
      { completed: false, dueDate: '2028-02-29', recurrence: 'yearly', recurrenceMode: 'schedule' },
      new Date(2028, 1, 29),
    );
    expect(out.nextDueDate).toBe('2029-02-28');
  });
});

describe('decideCompletion — recurring rows that cannot roll forward fall back to plain toggle', () => {
  it('schedule mode without a dueDate falls back (returns null from nextDueDate)', () => {
    const out = decideCompletion(
      { completed: false, dueDate: '', recurrence: 'weekly', recurrenceMode: 'schedule' },
      new Date(),
    );
    expect(out.rolledForward).toBe(false);
    expect(out.completed).toBe(true);
  });

  it('unparseable recurrence falls back to plain toggle', () => {
    const out = decideCompletion(
      { completed: false, dueDate: '2026-05-15', recurrence: 'maybe', recurrenceMode: 'schedule' },
      new Date(),
    );
    expect(out.rolledForward).toBe(false);
    expect(out.completed).toBe(true);
  });

  it('already-completed recurring row: re-checking just flips back to incomplete (no roll)', () => {
    const out = decideCompletion(
      { completed: true, dueDate: '2026-05-22', recurrence: 'weekly', recurrenceMode: 'schedule' },
      new Date(),
    );
    expect(out.rolledForward).toBe(false);
    expect(out.completed).toBe(false);
  });
});

describe('decideCompletion — repeated roll-forward is idempotent over successive completions', () => {
  it('completing a daily task three times in a row advances dueDate three days', () => {
    let row: RowSnapshot = {
      completed: false,
      dueDate: '2026-05-15',
      recurrence: 'daily',
      recurrenceMode: 'schedule',
    };
    const NOW = new Date(2026, 4, 15);
    for (let i = 0; i < 3; i++) {
      const decision = decideCompletion(row, NOW);
      expect(decision.rolledForward).toBe(true);
      row = { ...row, dueDate: decision.nextDueDate! };
    }
    expect(row.dueDate).toBe('2026-05-18');
  });

  it('completion-mode rolls based on each completion timestamp', () => {
    let row: RowSnapshot = {
      completed: false,
      dueDate: '',
      recurrence: 'every 2d',
      recurrenceMode: 'completion',
    };
    const fri = new Date(2026, 4, 15);
    const decisionA = decideCompletion(row, fri);
    expect(decisionA.nextDueDate).toBe('2026-05-17');
    row = { ...row, dueDate: decisionA.nextDueDate! };

    const sun = new Date(2026, 4, 17);
    const decisionB = decideCompletion(row, sun);
    expect(decisionB.nextDueDate).toBe('2026-05-19');
  });
});

describe('parseRecurrence — additional canonicalisation coverage', () => {
  it('trims and lowercases input', () => {
    expect(parseRecurrence('  WEEKLY  ')).toEqual({ kind: 'fixed', count: 1, unit: 'w' });
  });

  it('rejects zero / negative intervals', () => {
    expect(parseRecurrence('every 0 days')).toBeNull();
    expect(parseRecurrence('every -1 weeks')).toBeNull();
  });

  it('rejects unrecognised words', () => {
    expect(parseRecurrence('fortnightly')).toBeNull();
    expect(parseRecurrence('hourly')).toBeNull();
  });
});

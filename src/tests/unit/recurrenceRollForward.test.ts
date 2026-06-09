import { describe, it, expect } from 'vitest';
import { parseRecurrence, type RecurrenceMode } from '@renderer/lib/tasks/recurrence';
import { completionPatchForRow } from '@renderer/lib/tasklist/frontmatterWriter';
import type { TaskRow } from '@renderer/lib/tasks/taskListModel';

/**
 * Phase 6 — "complete a recurring task" flow coverage.
 *
 * `TaskListBoard.toggleCompleted` is the production caller; its per-row patch
 * comes from `completionPatchForRow`. `decideCompletion` below DELEGATES to that
 * production helper (rather than re-implementing the decision tree) so these
 * cases exercise real code — including the Phase-2 REC-1 fallback (an undated
 * schedule-mode repeat now rolls forward from the completion day instead of
 * silently terminating). The un-complete direction stays inline, matching
 * toggleCompleted (`completionPatchForRow` only handles completing).
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

function decideCompletion(row: RowSnapshot, now: Date): CompletionDecision {
  if (row.completed) {
    // toggleCompleted flips an already-complete row straight back to incomplete.
    return { rolledForward: false, completed: false };
  }
  const taskRow = {
    completed: false,
    dueDate: row.dueDate,
    recurrence: row.recurrence,
    recurrenceMode: row.recurrenceMode,
  } as unknown as TaskRow;
  const patch = completionPatchForRow(taskRow, now);
  if (patch.completed === false) {
    return { rolledForward: true, nextDueDate: patch.dueDate as string, completed: false };
  }
  return { rolledForward: false, completed: true };
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

describe('decideCompletion — recurring completion edge cases', () => {
  it('schedule mode without a dueDate rolls forward from the completion day (REC-1)', () => {
    // REC-1 — schedule mode has no anchor, so nextDueDate(schedule) is null; the
    // helper falls back to completion-mode semantics (completion day + interval)
    // so the repeat survives instead of being permanently completed. Schedule is
    // the DEFAULT mode, so this is the default undated-repeat path. Fri 2026-05-15
    // + 1 week = 2026-05-22.
    const out = decideCompletion(
      { completed: false, dueDate: '', recurrence: 'weekly', recurrenceMode: 'schedule' },
      new Date(2026, 4, 15),
    );
    expect(out.rolledForward).toBe(true);
    expect(out.nextDueDate).toBe('2026-05-22');
    expect(out.completed).toBe(false);
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

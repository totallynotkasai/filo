/**
 * A task row's date menus: the right-click menu on its dates, and the Repeat
 * menu (presets, "Every…" for any number of days, weeks, months or years,
 * and what the next date counts from). A rule Filo can't read says so at the
 * top of the Repeat menu, so it is seen before a Complete that can't roll it
 * forward.
 */
import type { ContextMenuItem } from '../../stores/ui.svelte';
import { parseRecurrence, recurrenceLabel, type RecurrenceMode } from '../tasks/recurrence';
import { formatDay } from '../utils/dateFormat';

const PRESETS: ReadonlyArray<{ id: string; label: string; value: string }> = [
  { id: 'none', label: 'None', value: '' },
  { id: 'daily', label: 'Daily', value: 'daily' },
  { id: 'weekday', label: 'Weekdays (Mon–Fri)', value: 'weekday' },
  { id: 'weekly', label: 'Weekly', value: 'weekly' },
  { id: 'fortnightly', label: 'Every 2 weeks', value: 'every 2 weeks' },
  { id: 'monthly', label: 'Monthly', value: 'monthly' },
  { id: 'yearly', label: 'Yearly', value: 'yearly' },
];

/** Whether two rules say the same ("every 1 week" is "weekly"). */
function sameRule(a: string, b: string): boolean {
  if (!a || !b) return a.trim() === b.trim();
  const pa = parseRecurrence(a);
  const pb = parseRecurrence(b);
  return !!pa && !!pb && recurrenceLabel(a) === recurrenceLabel(b);
}

/** True when the task has a repeat rule Filo can't read (it can't roll it forward). */
export function unreadableRule(recurrence: string): boolean {
  return !!recurrence.trim() && parseRecurrence(recurrence) === null;
}

export interface RepeatMenuOpts {
  recurrence: string;
  mode: RecurrenceMode;
  onSet: (rule: string) => void;
  onSetMode: (mode: RecurrenceMode) => void;
  /** Opens "Every…" (any number of days, weeks, months or years). */
  onCustom: () => void;
}

export function buildRepeatMenu(opts: RepeatMenuOpts): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  if (unreadableRule(opts.recurrence)) {
    items.push(
      { id: 'unreadable', label: `Filo can't read "${opts.recurrence.trim()}": completing won't repeat it. Pick a rule:`, heading: true },
    );
  }
  for (const p of PRESETS) {
    items.push({ id: p.id, label: p.label, checked: sameRule(opts.recurrence, p.value), action: () => opts.onSet(p.value) });
  }
  const custom = !!opts.recurrence && !unreadableRule(opts.recurrence) && !PRESETS.some((p) => sameRule(opts.recurrence, p.value));
  items.push({
    id: 'custom',
    label: custom ? `${recurrenceLabel(opts.recurrence)}…` : 'Every…',
    checked: custom,
    action: opts.onCustom,
  });
  if (opts.recurrence && !unreadableRule(opts.recurrence)) {
    items.push(
      { id: 'mode-div', label: '', divider: true },
      { id: 'mode-heading', label: 'The next date counts from', heading: true },
      { id: 'mode-schedule', label: 'The due date', checked: opts.mode !== 'completion', action: () => opts.onSetMode('schedule') },
      { id: 'mode-completion', label: 'The day it is done', checked: opts.mode === 'completion', action: () => opts.onSetMode('completion') },
    );
  }
  return items;
}

export interface DateMenuOpts {
  dueDate: string;
  startDate: string;
  recurrence: string;
  now: Date;
  onPickDue: () => void;
  /** Present when the row can take a start date. */
  onPickStart?: () => void;
  /** Present when the row can take a repeat rule. */
  onRepeat?: () => void;
  onClearDue: () => void;
  onClearStart?: () => void;
}

/** The right-click menu on a task's date chips. */
export function buildDateContextMenu(opts: DateMenuOpts): ContextMenuItem[] {
  const items: ContextMenuItem[] = [{ id: 'pick-due', label: 'Pick due date…', action: opts.onPickDue }];
  if (opts.onPickStart) {
    items.push({
      id: 'pick-start',
      label: opts.startDate ? `Start: ${formatDay(opts.startDate, { now: opts.now })}` : 'Set start date…',
      action: opts.onPickStart,
    });
  }
  if (opts.onRepeat) {
    items.push({
      id: 'repeat',
      label: opts.recurrence ? `Repeat: ${recurrenceLabel(opts.recurrence)}…` : 'Repeat…',
      action: opts.onRepeat,
    });
  }
  if (opts.dueDate || (opts.startDate && opts.onClearStart)) {
    items.push({ id: 'sep', label: '', divider: true });
    if (opts.dueDate) items.push({ id: 'clear-due', label: 'Clear due date', danger: true, action: opts.onClearDue });
    if (opts.startDate && opts.onClearStart) {
      items.push({ id: 'clear-start', label: 'Clear start date', danger: true, action: opts.onClearStart });
    }
  }
  return items;
}

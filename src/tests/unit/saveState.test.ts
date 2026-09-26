import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { saveStateStore, SAVING_SHOW_DELAY_MS } from '@renderer/stores/saveState.svelte';
import { saveIndicatorView } from '@renderer/lib/utils/saveIndicatorView';

describe('saveStateStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    saveStateStore.__reset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts as saved (green): nothing has been left unwritten', () => {
    expect(saveStateStore.state).toBe('saved');
  });

  it('shows saving once work has stayed unsaved for the show delay', () => {
    saveStateStore.setStatus(1, 0);
    expect(saveStateStore.state).toBe('saved');
    vi.advanceTimersByTime(SAVING_SHOW_DELAY_MS);
    expect(saveStateStore.state).toBe('saving');
  });

  it('pending work with nothing in flight shows saving', () => {
    saveStateStore.setStatus(0, 0, 2);
    vi.advanceTimersByTime(SAVING_SHOW_DELAY_MS);
    expect(saveStateStore.state).toBe('saving');
  });

  it('a save that lands inside the show delay never flickers to saving', () => {
    saveStateStore.setStatus(1, 0);
    vi.advanceTimersByTime(SAVING_SHOW_DELAY_MS - 10);
    saveStateStore.setStatus(0, 0);
    vi.advanceTimersByTime(SAVING_SHOW_DELAY_MS * 2);
    expect(saveStateStore.state).toBe('saved');
  });

  it('repeated status pushes while busy do not restart the show delay', () => {
    saveStateStore.setStatus(0, 0, 1);
    vi.advanceTimersByTime(100);
    saveStateStore.setStatus(1, 0, 1);
    vi.advanceTimersByTime(SAVING_SHOW_DELAY_MS - 100);
    expect(saveStateStore.state).toBe('saving');
  });

  it('saved stays saved: it no longer decays to a separate idle state', () => {
    saveStateStore.setStatus(1, 0);
    vi.advanceTimersByTime(SAVING_SHOW_DELAY_MS);
    saveStateStore.setStatus(0, 0);
    vi.advanceTimersByTime(60_000);
    expect(saveStateStore.state).toBe('saved');
  });

  it('error shows at once and cancels a pending switch to saving', () => {
    saveStateStore.setStatus(1, 0);
    saveStateStore.setStatus(1, 1);
    expect(saveStateStore.state).toBe('error');
    vi.advanceTimersByTime(SAVING_SHOW_DELAY_MS);
    expect(saveStateStore.state).toBe('error');
  });

  it('error state is sticky until a clean drain, even while a new write is inflight', () => {
    saveStateStore.setStatus(0, 1);
    expect(saveStateStore.state).toBe('error');
    // A new inflight write while a failure is outstanding reads 'error'
    // (failed outranks saving): the wedged-then-timed-out write case.
    saveStateStore.setStatus(1, 1);
    expect(saveStateStore.state).toBe('error');
    saveStateStore.setStatus(0, 1);
    expect(saveStateStore.state).toBe('error');
    saveStateStore.setStatus(0, 0);
    expect(saveStateStore.state).toBe('saved');
  });

  it('leaving error with work still pending goes straight to saving', () => {
    saveStateStore.setStatus(0, 1);
    saveStateStore.setStatus(0, 0, 1);
    expect(saveStateStore.state).toBe('saving');
  });
});

describe('saveIndicatorView: each state has its own colour and icon', () => {
  it('saved is green with a check-circle, and not clickable', () => {
    const v = saveIndicatorView('saved');
    expect(v.icon).toBe('check-circle');
    expect(v.color).toContain('--toolbar-save-ok');
    expect(v.color).toContain('--accent-success');
    expect(v.label).toBe('All changes saved');
    expect(v.clickable).toBe(false);
  });

  it('saving is yellow with a spinner, and not clickable', () => {
    const v = saveIndicatorView('saving');
    expect(v.icon).toBe('spinner');
    expect(v.color).toContain('--toolbar-save-busy');
    expect(v.color).toContain('--accent-warning');
    expect(v.label).toBe('Saving…');
    expect(v.clickable).toBe(false);
  });

  it('error is red with an alert-circle, and the only clickable state', () => {
    const v = saveIndicatorView('error');
    expect(v.icon).toBe('alert-circle');
    expect(v.color).toContain('--toolbar-save-error');
    expect(v.color).toContain('--accent-danger');
    expect(v.label).toBe('Save failed — click for details');
    expect(v.clickable).toBe(true);
  });

  it('no two states share an icon or a colour', () => {
    const views = (['saved', 'saving', 'error'] as const).map(saveIndicatorView);
    expect(new Set(views.map((v) => v.icon)).size).toBe(3);
    expect(new Set(views.map((v) => v.color)).size).toBe(3);
  });
});

import { describe, it, expect, vi, afterEach } from 'vitest';
import { TaskListFiltersAndViews } from '../../renderer/lib/tasklist/filtersAndViews.svelte';

/**
 * `TaskListFiltersAndViews.dispose()` cancels the lastView
 * debounce so a host unmount mid-window doesn't fire `updateSettings` +
 * push a history entry against a board that's already torn down.
 *
 * The host's `$effect` arms `lastViewPersistTimer = setTimeout(..., 300)`
 * on every filter mutation; without dispose, the callback could land after
 * the component unmounted and write into a stale board context.
 */
describe('TaskListFiltersAndViews.dispose()', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeFilters(): { filters: TaskListFiltersAndViews; updateSettings: ReturnType<typeof vi.fn> } {
    const updateSettings = vi.fn();
    const filters = new TaskListFiltersAndViews({
      getSavedViewsRaw: () => [],
      updateSettings,
      setSavedViews: () => {},
      tickAndPersist: () => {},
      getGroupBy: () => 'none',
      getSortBy: () => 'manual',
      announce: () => {},
    });
    return { filters, updateSettings };
  }

  it('clears a pending lastView debounce timer', () => {
    vi.useFakeTimers();
    const { filters } = makeFilters();
    const cb = vi.fn();
    filters.lastViewPersistTimer = setTimeout<[]>(cb, 300);

    filters.dispose();
    expect(filters.lastViewPersistTimer).toBeNull();

    vi.advanceTimersByTime(500);
    expect(cb).not.toHaveBeenCalled();
  });

  it('is idempotent when no timer is armed', () => {
    const { filters } = makeFilters();
    expect(filters.lastViewPersistTimer).toBeNull();
    expect(() => filters.dispose()).not.toThrow();
    expect(filters.lastViewPersistTimer).toBeNull();
  });

  it('is safe to call repeatedly', () => {
    vi.useFakeTimers();
    const { filters } = makeFilters();
    filters.lastViewPersistTimer = setTimeout(() => {}, 300);
    filters.dispose();
    filters.dispose();
    expect(filters.lastViewPersistTimer).toBeNull();
  });
});

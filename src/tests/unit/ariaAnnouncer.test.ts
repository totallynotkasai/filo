import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createAriaAnnouncer } from '@renderer/lib/utils/ariaAnnouncer.svelte';

/**
 * Audit 5.3 — the screen-reader announcer (extracted from TaskListBoard /
 * KanbanBoard) auto-clears its live-region text after a delay. If the host
 * board unmounts within that window the armed `setTimeout` previously fired
 * against orphaned component state. `dispose()` (called from `onDestroy`)
 * cancels the pending timer.
 */
describe('createAriaAnnouncer (audit 5.3)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('auto-clears the message after the delay when not disposed', () => {
    const announcer = createAriaAnnouncer(4000);
    announcer.announce('Task added');
    expect(announcer.message).toBe('Task added');
    vi.advanceTimersByTime(4000);
    expect(announcer.message).toBe('');
  });

  it('pads a repeated message with a zero-width space so aria-live re-fires', () => {
    const announcer = createAriaAnnouncer(4000);
    announcer.announce('Card removed');
    announcer.announce('Card removed');
    expect(announcer.message).toBe('Card removed​');
    expect(announcer.message).not.toBe('Card removed');
  });

  it('dispose() cancels the pending clear so it never fires after unmount', () => {
    const announcer = createAriaAnnouncer(4000);
    announcer.announce('Column added');
    announcer.dispose();
    // The board has unmounted; advancing past the window must NOT run the
    // clear callback (without dispose, message would flip to '' here — the
    // late write against an orphaned scope this fix prevents).
    vi.advanceTimersByTime(4000);
    expect(announcer.message).toBe('Column added');
  });
});

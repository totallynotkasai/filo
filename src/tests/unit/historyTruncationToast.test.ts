import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { historyStore } from '@renderer/stores/history.svelte';
import { uiStore } from '@renderer/stores/ui.svelte';
import { Command } from '@renderer/commands/Command';

/**
 * Phase 10.3 — history truncation toast. The undo stack caps at a per-board
 * limit (defaults to 500 since Phase 24 / M23; configurable via
 * `historyStore.setMaxHistory`). The first time a board's stack drops its
 * head past that cap, the user sees a one-shot info toast. Subsequent
 * truncations in the same session are silent. `clear()` resets the per-board
 * notified flag so a fresh project gets a fresh toast.
 *
 * Tests run with the cap pinned to 100 so the assertions stay readable —
 * pushing 501 entries per assertion would obscure the behaviour under test.
 */

class NoopCommand extends Command {
  readonly targetBoardId: string = '';
  description = 'noop';
  execute(): void {}
  undo(): void {}
}

function pushN(n: number): void {
  for (let i = 0; i < n; i++) historyStore.execute(new NoopCommand());
}

describe('history truncation toast', () => {
  let toastSpy: MockInstance<typeof uiStore.toast>;

  beforeEach(() => {
    historyStore.clear();
    historyStore.setMaxHistory(100);
    historyStore.setActiveBoard('b1');
    toastSpy = vi.spyOn(uiStore, 'toast');
  });
  afterEach(() => {
    historyStore.clear();
    historyStore.setMaxHistory(500);
    historyStore.setActiveBoard(null);
    toastSpy.mockRestore();
  });

  it('does not toast under the cap', () => {
    pushN(50);
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it('does not toast exactly at the cap', () => {
    pushN(100);
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it('toasts once when the cap is first exceeded', () => {
    pushN(101);
    const calls = toastSpy.mock.calls.filter((args) =>
      typeof args[0] === 'string' && args[0].includes('Undo history limit reached'),
    );
    expect(calls.length).toBe(1);
  });

  it('does not re-toast on subsequent truncations in the same session', () => {
    pushN(150);
    const calls = toastSpy.mock.calls.filter((args) =>
      typeof args[0] === 'string' && args[0].includes('Undo history limit reached'),
    );
    expect(calls.length).toBe(1);
  });

  it('toasts again after clear() (treated as a new session)', () => {
    pushN(101);
    historyStore.clear();
    historyStore.setActiveBoard('b1');
    pushN(101);
    const calls = toastSpy.mock.calls.filter((args) =>
      typeof args[0] === 'string' && args[0].includes('Undo history limit reached'),
    );
    expect(calls.length).toBe(2);
  });

  it('per-board: truncation on board A does not silence board B', () => {
    pushN(101);
    historyStore.setActiveBoard('b2');
    pushN(101);
    const calls = toastSpy.mock.calls.filter((args) =>
      typeof args[0] === 'string' && args[0].includes('Undo history limit reached'),
    );
    expect(calls.length).toBe(2);
  });

  it('clearBoard resets the per-board flag', () => {
    pushN(101);
    historyStore.clearBoard('b1');
    pushN(101);
    const calls = toastSpy.mock.calls.filter((args) =>
      typeof args[0] === 'string' && args[0].includes('Undo history limit reached'),
    );
    expect(calls.length).toBe(2);
  });
});

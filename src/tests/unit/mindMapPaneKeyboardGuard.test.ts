import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createBoardScope } from '@renderer/lib/boards/boardScopeFactory';
import { isActiveScope, setActiveScope, type BoardScope } from '@renderer/lib/boards/boardScope.svelte';

/**
 * MindMapBoard's `<svelte:window onkeydown>` handler was not pane-scoped.
 *
 * The window handler fires for EVERY mounted Mind Map pane, so in a split view
 * a single bare key (n / c / arrows / Backspace) acted in BOTH panes — one `n`
 * creating a tile on two boards, Delete double-dispatching, arrows moving the
 * selection in both. The fix early-returns `if (!isActiveScope(scope)) return;`
 * at the top of `handleKeydown`, mirroring how Kanban / Task List gate their
 * shared bare-key shortcuts (see shortcutActivePaneGuard.test.ts).
 *
 * MindMapBoard uses a RAW window listener (NOT the hotkeys registry), so unlike
 * the Kanban/TaskList guard this can't be exercised through the command path.
 * This test reproduces the raw-listener wiring faithfully: two real
 * `BoardScope`s, each with a window keydown listener whose handler applies the
 * exact same `!isActiveScope(scope)` early-return the component now uses, and
 * asserts only the active pane acts (so a key creates exactly one tile).
 *
 * Bite check: drop the `if (!isActiveScope(scope)) return;` line from
 * `makePaneHandler` and both panes record the keystroke → the assertions fail.
 */

function installEmptyFiloStub(): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async () => null,
    on: () => () => {},
    send: () => {},
  };
}

describe('Mind Map pane-scope keyboard guard', () => {
  let paneA: BoardScope;
  let paneB: BoardScope;
  const acted: string[] = [];
  const listeners: Array<(e: KeyboardEvent) => void> = [];

  // Mirrors MindMapBoard.handleKeydown's top-of-function gate, then a bare-`n`
  // action (the real handler creates a tile on `scope.board`). The action here
  // just records which pane ran so we can assert exactly one pane responds.
  function makePaneHandler(scope: BoardScope, label: string) {
    return (e: KeyboardEvent) => {
      if (!isActiveScope(scope)) return; // <-- the pane-scope guard
      if (e.key === 'n') acted.push(label);
    };
  }

  beforeEach(() => {
    installEmptyFiloStub();
    acted.length = 0;
    paneA = createBoardScope();
    paneB = createBoardScope();
    const hA = makePaneHandler(paneA, 'A');
    const hB = makePaneHandler(paneB, 'B');
    listeners.push(hA, hB);
    window.addEventListener('keydown', hA);
    window.addEventListener('keydown', hB);
  });

  afterEach(() => {
    for (const h of listeners) window.removeEventListener('keydown', h);
    listeners.length = 0;
  });

  function pressN(): void {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true }));
  }

  it('routes a bare `n` to ONLY the active pane (exactly one tile, no double-dispatch)', () => {
    setActiveScope(paneA);
    pressN();
    expect(acted).toEqual(['A']);

    setActiveScope(paneB);
    pressN();
    expect(acted).toEqual(['A', 'B']);
  });

  it('the inactive pane never acts even though its window listener still fires', () => {
    setActiveScope(paneA);
    pressN();
    pressN();
    // Two presses while A is active — B (inactive) stayed silent both times.
    expect(acted).toEqual(['A', 'A']);
    expect(acted).not.toContain('B');
  });

  it('isActiveScope distinguishes exactly one of two live panes', () => {
    setActiveScope(paneA);
    expect(isActiveScope(paneA)).toBe(true);
    expect(isActiveScope(paneB)).toBe(false);

    setActiveScope(paneB);
    expect(isActiveScope(paneA)).toBe(false);
    expect(isActiveScope(paneB)).toBe(true);
  });
});

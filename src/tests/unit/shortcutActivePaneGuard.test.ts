import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initKeyboardShortcuts, _resetForTests } from '@renderer/core/hotkeys';
import { registerCommandWithShortcut } from '@renderer/core/commandRegistry';
import { createBoardScope } from '@renderer/lib/boards/boardScopeFactory';
import { isActiveScope, setActiveScope, type BoardScope } from '@renderer/lib/boards/boardScope.svelte';

/**
 * M2 (audit 2026-05-29) — duplicate bare-`n` shortcut across board types.
 *
 * In a split view a Kanban board and a Task List board are mounted at once
 * and BOTH register a global `n` shortcut. The registry fires the first
 * matching binding and returns, so before the fix the wrong (registration-
 * order) pane won. The fix gates each board's binding on whether its scope is
 * the active pane (`isActiveScope(scope)`); the key handler skips a disabled
 * binding and keeps scanning, so `n` routes to the focused pane.
 *
 * This mirrors the production wiring faithfully: two real `BoardScope`s, the
 * same `enabled` predicate the board components use, driven through the real
 * `registerCommandWithShortcut` → `hotkeys` handler path.
 */

function installEmptyFiloStub(): void {
  (window as unknown as Record<string, unknown>).filo = {
    invoke: async () => null,
    on: () => () => {},
    send: () => {},
  };
}

function dispatchKey(init: KeyboardEventInit) {
  const event = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true });
  document.body.dispatchEvent(event);
  return event;
}

describe('active-pane shortcut guard (M2)', () => {
  let kanbanScope: BoardScope;
  let taskListScope: BoardScope;

  beforeEach(() => {
    installEmptyFiloStub();
    _resetForTests();
    initKeyboardShortcuts();
    kanbanScope = createBoardScope();
    taskListScope = createBoardScope();
  });

  afterEach(() => {
    _resetForTests();
  });

  it('routes a shared bare-`n` to whichever pane is active', () => {
    const fired: string[] = [];
    registerCommandWithShortcut({
      name: 'kanban:add-tile', label: 'Kanban: Add tile', description: 'Kanban: Add tile',
      binding: { key: 'n' },
      enabled: () => isActiveScope(kanbanScope),
      execute: () => fired.push('kanban'),
    });
    registerCommandWithShortcut({
      name: 'tasklist:focus-quick-add', label: 'Task List: Focus quick-add', description: 'Task List: Focus quick-add',
      binding: { key: 'n' },
      enabled: () => isActiveScope(taskListScope),
      execute: () => fired.push('tasklist'),
    });

    setActiveScope(kanbanScope);
    dispatchKey({ key: 'n' });
    expect(fired).toEqual(['kanban']);

    setActiveScope(taskListScope);
    dispatchKey({ key: 'n' });
    expect(fired).toEqual(['kanban', 'tasklist']);
  });

  it('targets the active pane even when it registered its `n` last', () => {
    const fired: string[] = [];
    // Task List active, but Kanban (inactive) registered first.
    setActiveScope(taskListScope);
    registerCommandWithShortcut({
      name: 'kanban:add-tile', label: 'Kanban: Add tile', description: 'Kanban: Add tile',
      binding: { key: 'n' },
      enabled: () => isActiveScope(kanbanScope),
      execute: () => fired.push('kanban'),
    });
    registerCommandWithShortcut({
      name: 'tasklist:focus-quick-add', label: 'Task List: Focus quick-add', description: 'Task List: Focus quick-add',
      binding: { key: 'n' },
      enabled: () => isActiveScope(taskListScope),
      execute: () => fired.push('tasklist'),
    });

    dispatchKey({ key: 'n' });
    expect(fired).toEqual(['tasklist']);
  });

  it('does not fire the inactive pane and lets the key fall through when no pane matches', () => {
    let kanbanFired = 0;
    registerCommandWithShortcut({
      name: 'kanban:add-tile', label: 'Kanban: Add tile', description: 'Kanban: Add tile',
      binding: { key: 'n' },
      enabled: () => isActiveScope(kanbanScope),
      execute: () => { kanbanFired += 1; },
    });

    // A third, unrelated scope is active — neither board's binding matches.
    setActiveScope(createBoardScope());
    const event = dispatchKey({ key: 'n' });
    expect(kanbanFired).toBe(0);
    expect(event.defaultPrevented).toBe(false);
  });
});

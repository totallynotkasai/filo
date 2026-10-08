/**
 * Help → Shortcuts lists each command once. A board shown in two split panes
 * registers its commands once per pane (each acts only for its own pane), and
 * the list, keyed by command id, threw on the second copy.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import KeyboardShortcuts from '@renderer/components/settings/KeyboardShortcuts.svelte';
import { _resetForTests, registerShortcut } from '@renderer/core/hotkeys';

let instance: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  _resetForTests();
  (window as unknown as Record<string, unknown>).filo = { invoke: async () => null, on: () => () => {}, send: () => {} };
});

afterEach(() => {
  if (instance) unmount(instance);
  instance = null;
  _resetForTests();
  document.body.innerHTML = '';
});

describe('Help → Shortcuts', () => {
  it('lists a command registered by two panes once', () => {
    for (let pane = 0; pane < 2; pane++) {
      registerShortcut({ commandId: 'mindmap:new-tile', key: 'n', description: 'Mind Map: New tile beside the selection', action: () => {} });
    }
    registerShortcut({ commandId: 'tile:new', key: 'n', ctrl: true, description: 'New Tile', action: () => {} });
    const target = document.createElement('div');
    document.body.appendChild(target);
    instance = mount(KeyboardShortcuts, { target });
    flushSync();
    const rows = [...target.querySelectorAll('[data-area="Mind Map"] .shortcut-row .shortcut-desc')].map((d) => d.textContent?.trim());
    expect(rows.filter((r) => r === 'New tile beside the selection')).toHaveLength(1);
    const everywhere = [...target.querySelectorAll('[data-area="Everywhere"] .shortcut-desc')].map((d) => d.textContent?.trim());
    expect(everywhere).toEqual(['New Tile']);
  });

  it('lists every board\'s commands with no board open, and the row, card and text keys (E-13)', () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    instance = mount(KeyboardShortcuts, { target });
    flushSync();
    const area = (name: string): string[] =>
      [...target.querySelectorAll(`[data-area="${name}"] .shortcut-row`)].map((r) =>
        `${r.querySelector('.shortcut-desc')?.textContent?.trim()}: ${r.querySelector('.shortcut-key-btn, .shortcut-key')?.textContent?.trim()}`);
    expect(area('Kanban')).toEqual(expect.arrayContaining(['Add column: Shift+N', 'Go to the next card on screen: Arrow keys', 'Find on this board: /', 'The card\'s menu (Move to column…): Menu key or Shift+F10']));
    expect(area('Task List')).toEqual(expect.arrayContaining(['Move task up: Alt+ArrowUp', 'Set the due date: D', 'Complete the task, or mark it not done: Space']));
    expect(area('Text')).toEqual(expect.arrayContaining(['Heading 1 to 6: Ctrl+Alt+1 to 6', 'Bulleted / numbered list / checklist: Ctrl+Shift+8 / 7 / 9']));
    // A board's command can be rebound with no board of its kind open.
    expect(target.querySelector('[data-area="Kanban"] .shortcut-key-btn')).not.toBeNull();
  });
});

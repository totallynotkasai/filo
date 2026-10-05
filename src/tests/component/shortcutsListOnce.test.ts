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
    const rows = [...target.querySelectorAll('.shortcut-row .shortcut-desc')].map((d) => d.textContent?.trim());
    expect(rows.filter((r) => r === 'Mind Map: New tile beside the selection')).toHaveLength(1);
    expect(rows).toContain('New Tile');
  });
});

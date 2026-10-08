import { describe, it, expect } from 'vitest';
import { helpBindingConflict, helpDefaultBinding, helpSections } from '@renderer/lib/settings/shortcutHelp';
import type { Shortcut } from '@renderer/core/hotkeys';

/**
 * Help → Shortcuts lists every key (E-13): each board's commands whether or
 * not a board of that kind is open, and rebinding keeps keys from colliding.
 */

const save: Shortcut = { commandId: 'app:save', key: 's', ctrl: true, description: 'Save', action: () => {} };

describe('helpSections', () => {
  it('lists the commands that work everywhere, then each board\'s, with the key each has now', () => {
    const sections = helpSections([save], { 'kanban:add-column': { key: 'm', shift: true } });
    expect(sections.map((s) => s.title)).toEqual(['Everywhere', 'Mind Map', 'Kanban', 'Task List', 'Text']);
    expect(sections[0]?.commands.map((c) => c.label)).toEqual(['Save']);
    const kanban = sections.find((s) => s.title === 'Kanban');
    expect(kanban?.commands.map((c) => c.label)).toEqual(['Add tile', 'New card', 'Add column']);
    expect(kanban?.commands.find((c) => c.id === 'kanban:add-column')?.binding).toEqual({ key: 'm', ctrl: false, shift: true, alt: false });
  });

  it('shows a board command registered by an open board once, with its live key', () => {
    const live: Shortcut = { commandId: 'mindmap:connect', key: 'k', description: 'Mind Map: Connect the selected tile', action: () => {} };
    const mindMap = helpSections([live, live], {}).find((s) => s.title === 'Mind Map');
    expect(mindMap?.commands.filter((c) => c.id === 'mindmap:connect')).toHaveLength(1);
    expect(mindMap?.commands.find((c) => c.id === 'mindmap:connect')?.binding.key).toBe('k');
  });
});

describe('helpBindingConflict', () => {
  it('lets two boards share a key', () => {
    // Kanban's Add tile is N, as the Mind Map's New tile is.
    expect(helpBindingConflict({ key: 'n' }, 'mindmap:new-tile', [], {})).toBeNull();
  });

  it('refuses a key another command of the same board has, open or not', () => {
    expect(helpBindingConflict({ key: 'n' }, 'kanban:add-column', [], {})).toBe('Kanban: Add tile');
  });

  it('refuses a key a command that works everywhere has, both ways', () => {
    expect(helpBindingConflict({ key: 's', ctrl: true }, 'tasklist:select-all', [save], {})).toBe('Save');
    expect(helpBindingConflict({ key: 'c' }, 'app:save', [save], {})).toBe('Mind Map: Connect the selected tile');
  });
});

describe('helpDefaultBinding', () => {
  it('reads a closed board\'s default key from its list', () => {
    expect(helpDefaultBinding('tasklist:move-up', null)).toEqual({ key: 'ArrowUp', ctrl: false, shift: false, alt: true });
    expect(helpDefaultBinding('app:save', { key: 's', ctrl: true })).toEqual({ key: 's', ctrl: true });
    expect(helpDefaultBinding('nothing:here', null)).toBeNull();
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import { applyToolbarText, chromeTextFor } from '@renderer/lib/themes/chromeText';
import { clearDefaultColours, customisedDefaultColours } from '@renderer/lib/themes/defaultColours';
import { ProjectSettingsSchema } from '@renderer/schema/settings';

describe('chromeTextFor: a user toolbar colour gets readable text', () => {
  it('white on a dark colour, black on a light one', () => {
    expect(chromeTextFor('#1a2b5c')?.fg).toBe('#ffffff');
    expect(chromeTextFor('#ffe066')?.fg).toBe('#000000');
  });

  it('nothing for the theme\'s own colour (blank) or a non-hex value', () => {
    expect(chromeTextFor('')).toBeNull();
    expect(chromeTextFor('rebeccapurple')).toBeNull();
  });

  afterEach(() => document.documentElement.removeAttribute('style'));

  it('writes the bar\'s text colours onto :root, and clears them with the colour', () => {
    const root = document.documentElement;
    applyToolbarText(root, '#101010');
    expect(root.style.getPropertyValue('--toolbar-custom-fg')).toBe('#ffffff');
    applyToolbarText(root, '');
    expect(root.style.getPropertyValue('--toolbar-custom-fg')).toBe('');
    expect(root.style.getPropertyValue('--toolbar-custom-hover')).toBe('');
  });
});

describe('Global Defaults colours on a theme switch', () => {
  it('lists every colour the user set, nested ones included, and nothing else', () => {
    const s = ProjectSettingsSchema.parse({});
    expect(customisedDefaultColours(s)).toEqual([]);
    s.mindmap.tile.headerColor = '#ff0000';
    s.kanban.card.backgroundColor = '#00ff00';
    s.tasklist.accentColor = '#0000ff';
    s.mindmap.tile.borderWidth = 5;
    expect(customisedDefaultColours(s).sort()).toEqual([
      'kanban.card.backgroundColor',
      'mindmap.tile.headerColor',
      'tasklist.accentColor',
    ]);
  });

  it('clears the colours and leaves every other default', () => {
    const s = ProjectSettingsSchema.parse({});
    s.mindmap.tile.headerColor = '#ff0000';
    s.document.document.borderColor = '#123456';
    s.mindmap.tile.borderWidth = 5;
    clearDefaultColours(s);
    expect(customisedDefaultColours(s)).toEqual([]);
    expect(s.mindmap.tile.borderWidth).toBe(5);
  });
});

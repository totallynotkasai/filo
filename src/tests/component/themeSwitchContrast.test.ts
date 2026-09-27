import { describe, it, expect, afterEach } from 'vitest';
import { flushSync } from 'svelte';
import { applyCustomTheme, __resetThemeManagerForTests } from '@renderer/lib/themes/themeManager';
import { effectiveTileStyle } from '@renderer/lib/styles/effectiveStyle';
import type { Tile } from '@renderer/schema/index';
import { watchDerived } from './helpers/watchDerived.svelte';

/**
 * Dynamic Contrast Text picks black or white against the theme's tile colour.
 * A theme switch must re-pick it in every open view, not leave the colour
 * worked out under the old theme (black text on a dark tile).
 */
const tile = {
  id: 't1',
  type: 'text',
  title: 'T',
  style: {},
} as unknown as Tile;

function theme(id: string, tileBg: string): Parameters<typeof applyCustomTheme>[0] {
  return { id, name: id, base: 'light', variables: { '--tile-header-bg': tileBg, '--tile-body-bg': tileBg } };
}

describe('theme switch and contrast text', () => {
  afterEach(() => __resetThemeManagerForTests());

  it('re-picks the text colour when the theme changes', () => {
    applyCustomTheme(theme('pale', '#f5f5f5'));
    const watch = watchDerived(() => effectiveTileStyle(tile, null, null).headerTextColor);
    expect(watch.values.at(-1)).toBe('#000000');

    applyCustomTheme(theme('navy', '#1a1a40'));
    flushSync();
    expect(watch.values.at(-1)).toBe('#ffffff');
    watch.stop();
  });
});

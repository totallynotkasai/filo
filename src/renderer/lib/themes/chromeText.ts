/**
 * Text colour for the toolbar and tab bar when the user picks their own
 * background colour for them (General → Toolbar / Tab Bar colour).
 *
 * The theme's text colours are chosen for the theme's toolbar, so on a
 * user colour they can be unreadable (dark text on a navy bar). The bar gets
 * black or white text instead, whichever reads better, written as
 * `--toolbar-custom-*` / `--tabbar-custom-*` on `:root`. style.css maps those
 * to `--chrome-*` inside each bar for the controls sitting on it; menus and
 * popups opened from a bar reset `--chrome-*`, since they have their own
 * background.
 */
import { getDynamicContrastText, isValidHex } from '../utils/color';

export interface ChromeText {
  fg: string;
  muted: string;
  hover: string;
}

/** Text colours for `background`, or null when it isn't a hex colour. */
export function chromeTextFor(background: string): ChromeText | null {
  if (!background || !isValidHex(background)) return null;
  const fg = getDynamicContrastText(background);
  return fg === '#000000'
    ? { fg, muted: 'rgba(0, 0, 0, 0.7)', hover: 'rgba(0, 0, 0, 0.08)' }
    : { fg, muted: 'rgba(255, 255, 255, 0.78)', hover: 'rgba(255, 255, 255, 0.14)' };
}

/** Writes (or clears) the toolbar's custom text colours. */
export function applyToolbarText(root: HTMLElement, background: string): void {
  const text = chromeTextFor(background);
  if (!text) {
    for (const name of ['--toolbar-custom-fg', '--toolbar-custom-fg-muted', '--toolbar-custom-hover']) {
      root.style.removeProperty(name);
    }
    return;
  }
  root.style.setProperty('--toolbar-custom-fg', text.fg);
  root.style.setProperty('--toolbar-custom-fg-muted', text.muted);
  root.style.setProperty('--toolbar-custom-hover', text.hover);
}

/** Writes (or clears) the tab bar's custom text colours. */
export function applyTabBarText(root: HTMLElement, background: string): void {
  const text = chromeTextFor(background);
  if (!text) {
    for (const name of ['--tabbar-custom-fg', '--tabbar-custom-fg-muted', '--tabbar-custom-hover']) {
      root.style.removeProperty(name);
    }
    return;
  }
  root.style.setProperty('--tabbar-custom-fg', text.fg);
  root.style.setProperty('--tabbar-custom-fg-muted', text.muted);
  root.style.setProperty('--tabbar-custom-hover', text.hover);
}

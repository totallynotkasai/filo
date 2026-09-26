/**
 * Single-path SVG `d` data for shared UI icons, drawn inside a
 * `viewBox="0 0 24 24"` stroke icon (`fill="none" stroke="currentColor"`,
 * 2px stroke, round caps and joins). One path, so a context-menu item's
 * `icon` field can carry it; the palette's dots are zero-length strokes that
 * the round caps draw as dots.
 */

/**
 * Style: a palette with a brush. Every "Style" button and menu entry uses it
 * (buttons through `StyleIcon.svelte`), so the same action always looks the
 * same.
 */
export const STYLE_ICON_PATH =
  'M8.74 22.44a.72.72 0 0 1 0-14.4 7.2 6.48 0 0 1 7.2 6.48 3.6 3.6 0 0 1-3.6 3.6h-1.62a1.26 1.26 0 0 0-1.008 2.016l.216.288a1.26 1.26 0 0 1-1.008 2.016z' +
  'M9.82 11.28h.01M4.78 15.6h.01M6.22 12h.01' +
  'M16.768 5.174l3.712-3.708a1.311 1.311 0 1 1 1.854 1.854l-3.708 3.717' +
  'M15.852 6.572c-.764 0-1.38.621-1.38 1.389 0 .612-1.15.699-.92.929.497.506 1.145.929 1.84.929 1.012 0 1.84-.828 1.84-1.858a1.385 1.385 0 0 0-1.38-1.389z';

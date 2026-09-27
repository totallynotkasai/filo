/**
 * Single-path SVG `d` data for shared UI icons, drawn inside a
 * `viewBox="0 0 24 24"` stroke icon (`fill="none" stroke="currentColor"`,
 * 2px stroke, round caps and joins). One path, so a context-menu item's
 * `icon` field can carry it; the palette's dots are zero-length strokes that
 * the round caps draw as dots.
 */

/**
 * Style: a painter's palette (lucide "palette"). No brush: at the 14px the
 * buttons draw it, a brush beside the palette is too small to read. Every
 * "Style" button and menu entry uses it (buttons through `StyleIcon.svelte`),
 * so the same action always looks the same.
 */
export const STYLE_ICON_PATH =
  'M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z' +
  'M13.5 6.5h.01M17.5 10.5h.01M6.5 12.5h.01M8.5 7.5h.01';

/**
 * Pin (lucide "pin"): the floating board toolbars' pin button, which keeps
 * the toolbar where it is. Drawn through `PinIcon.svelte`.
 */
export const PIN_ICON_PATH =
  'M12 17v5' +
  'M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z';

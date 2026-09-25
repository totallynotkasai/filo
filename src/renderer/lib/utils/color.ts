/**
 * Colour utilities for theming, dynamic contrast, and the colour picker.
 *
 * `relativeLuminance` and `getDynamicContrastText` use the WCAG 2.1
 * relative-luminance formula (sRGB linearisation + 0.2126/0.7152/0.0722
 * coefficients). Required by the Dynamic Contrast Text feature
 * because the design doc explicitly cites WCAG AA.
 */

// ── Hex parsing ──

export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** Parses #rgb or #rrggbb into an RGB triple, or null on failure. */
export function parseHex(hex: string): RGB | null {
  if (typeof hex !== 'string') return null;
  const clean = hex.replace('#', '').trim();
  let r: number, g: number, b: number;
  if (clean.length === 3) {
    const c0 = clean[0] ?? '', c1 = clean[1] ?? '', c2 = clean[2] ?? ''; // length === 3
    r = parseInt(c0 + c0, 16);
    g = parseInt(c1 + c1, 16);
    b = parseInt(c2 + c2, 16);
  } else if (clean.length === 6) {
    r = parseInt(clean.slice(0, 2), 16);
    g = parseInt(clean.slice(2, 4), 16);
    b = parseInt(clean.slice(4, 6), 16);
  } else {
    return null;
  }
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
  return { r, g, b };
}

/** Converts an RGB triple to a 6-digit hex string (lower-case, with '#'). */
export function rgbToHex({ r, g, b }: RGB): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  const h = (n: number) => clamp(n).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** True iff the value matches `#rgb` or `#rrggbb`. */
export function isValidHex(value: string): boolean {
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value.trim());
}

// ── HSL ↔ RGB ──

export interface HSL {
  h: number; // 0–360
  s: number; // 0–1
  l: number; // 0–1
}

export function rgbToHsl({ r, g, b }: RGB): HSL {
  const rN = r / 255;
  const gN = g / 255;
  const bN = b / 255;
  const max = Math.max(rN, gN, bN);
  const min = Math.min(rN, gN, bN);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rN: h = (gN - bN) / d + (gN < bN ? 6 : 0); break;
      case gN: h = (bN - rN) / d + 2; break;
      case bN: h = (rN - gN) / d + 4; break;
    }
    h *= 60;
  }
  return { h, s, l };
}

export function hslToRgb({ h, s, l }: HSL): RGB {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  let r1 = 0, g1 = 0, b1 = 0;
  if (hue < 60) { r1 = c; g1 = x; }
  else if (hue < 120) { r1 = x; g1 = c; }
  else if (hue < 180) { g1 = c; b1 = x; }
  else if (hue < 240) { g1 = x; b1 = c; }
  else if (hue < 300) { r1 = x; b1 = c; }
  else { r1 = c; b1 = x; }
  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255),
  };
}

// ── WCAG 2.1 relative luminance (Dynamic Contrast Text) ──

function linearize(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * WCAG 2.1 relative luminance (range 0–1). Defined in
 * https://www.w3.org/TR/WCAG21/#dfn-relative-luminance.
 */
export function relativeLuminance(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) return 0;
  return 0.2126 * linearize(rgb.r) + 0.7152 * linearize(rgb.g) + 0.0722 * linearize(rgb.b);
}

/**
 * Returns the WCAG contrast ratio between two colours (1–21). 4.5 is the
 * AA threshold for body text.
 */
export function contrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hex1);
  const l2 = relativeLuminance(hex2);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Returns `#000` or `#fff` — whichever yields the higher WCAG contrast
 * ratio against the given background. The 0.179 luminance threshold matches
 * the design doc's specification (≈ the cross-over point at which white
 * text starts to outscore black).
 */
export function getDynamicContrastText(backgroundHex: string): '#000000' | '#ffffff' {
  return relativeLuminance(backgroundHex) > 0.179 ? '#000000' : '#ffffff';
}

/**
 * Returns the resolved background colour string for an element. Falls back
 * to the supplied CSS variable name (e.g. `--tile-header-bg`) when no
 * explicit colour is set, by reading the live CSS custom property from
 * `:root`. Safe in jsdom (returns the fallback hex if `getComputedStyle`
 * yields an empty string).
 */
export function resolveBackgroundColor(
  explicit: string,
  cssVariableName: string,
  fallbackHex = '#888888',
): string {
  if (isValidHex(explicit)) return explicit;
  if (typeof document === 'undefined') return fallbackHex;
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(cssVariableName)
    .trim();
  return isValidHex(value) ? value : fallbackHex;
}

/**
 * `hex` with its lightness moved `amount` (0–1) away from it: darker on a
 * light colour, lighter on a dark one, same hue. A surface drawn over the
 * colour (the minimap over the canvas) then reads as part of it but stays
 * distinct. Returns the fallback unchanged when `hex` isn't a hex colour.
 */
export function contrastShade(hex: string, amount = 0.06, fallbackHex = '#888888'): string {
  const rgb = parseHex(hex) ?? parseHex(fallbackHex);
  if (!rgb) return fallbackHex;
  const hsl = rgbToHsl(rgb);
  const l = relativeLuminance(rgbToHex(rgb)) > 0.179
    ? Math.max(0, hsl.l - amount)
    : Math.min(1, hsl.l + amount);
  return rgbToHex(hslToRgb({ ...hsl, l }));
}

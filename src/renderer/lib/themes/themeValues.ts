/**
 * What a theme token may hold, past the CSS-injection sanitiser
 * (`asSafeThemeValue`, which every caller runs first).
 *
 * A theme is colours, plus a few shadows. A value the sanitiser passes can
 * still be one no theme means: Chromium reads `currentColor`, `inherit` or
 * `var(--x)` as a colour, but painted on `:root` they leave the token with no
 * value (a background turns transparent) or paint it with the text colour.
 * The theme editor, a theme file read or imported, and the paint all check
 * this, so such a value is dropped wherever it comes from.
 */

import type { SanitisedColor } from '../../../shared/untrusted';
import { isCssColour } from '../utils/color';
import { THEME_SHADOW_TOKENS } from './themeTokens';

/** The CSS-wide keywords and `currentColor`: they name no colour or shadow of their own. */
const KEYWORD_VALUE = /^(?:inherit|initial|unset|revert|revert-layer|currentcolor)$/i;

/**
 * Functions whose value comes from somewhere else. Nothing Filo writes holds
 * one (a built-in theme or a Duplicate holds plain colours), the editor's
 * swatch can't show one, and a wrong or circular reference leaves the token
 * with no value.
 */
const BORROWED_VALUE = /(?:^|[^\w-])(?:var|env|attr|if|inherit)\(/i;

const SHADOW_TOKENS: ReadonlySet<string> = new Set(THEME_SHADOW_TOKENS);

/**
 * Whether theme token `name` may hold `value`: never a CSS-wide keyword,
 * `currentColor` or a borrowed value (`var()` …), and a colour unless the token
 * is a shadow.
 */
export function isThemeTokenValue(name: string, value: SanitisedColor): boolean {
  if (KEYWORD_VALUE.test(value) || BORROWED_VALUE.test(value)) return false;
  return SHADOW_TOKENS.has(name) || isCssColour(value);
}

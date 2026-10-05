/**
 * The CSS font stack behind a font the user picks by name.
 *
 * Settings store the whole stack (`globalFont`), and the pickers show only
 * its first family, so both directions live here. Every stack ends in the
 * same fallbacks: Arial covers a machine without the chosen font, which
 * `system-ui` alone would render in a very different face.
 */

/** Filo's default font. `style.css` joins its Regular and Bold files under this name. */
export const DEFAULT_FONT = 'Arial Rounded MT';

const FALLBACKS = ['Arial', 'system-ui', 'sans-serif'] as const;

const GENERIC_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji', 'fangsong',
]);

/** A family name as CSS needs it: generic keywords bare, anything else quoted. */
function cssFamily(name: string): string {
  if (GENERIC_FAMILIES.has(name.toLowerCase())) return name;
  return `'${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function unquote(family: string): string {
  const trimmed = family.trim();
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote) && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return trimmed;
}

/** A word CSS reads as part of an unquoted family name (an identifier). */
const IDENTIFIER = /^-?[A-Za-z_\u0080-￿][\w\-\u0080-￿]*$/;

/** Words an unquoted family name can't use: CSS reads them as keywords. */
const CSS_WIDE_KEYWORDS = new Set(['inherit', 'initial', 'unset', 'default', 'revert', 'revert-layer']);

/**
 * A font picked by name as one `font-family` value: bare where CSS reads it
 * bare (`Georgia`, `Arial Rounded MT`), so notes keep the spelling they
 * already have, and quoted otherwise. An imported font is named after its
 * file, and a name that starts with a digit or holds a comma or brackets
 * ("28 Days Later", "Lora[wght]") was dropped by the style parser unquoted:
 * the text kept its font, and the note reopened read-only.
 */
export function fontFamilyValue(font: string): string {
  const name = font.trim();
  const words = name.split(/\s+/);
  const bare = words.every((w) => IDENTIFIER.test(w) && !CSS_WIDE_KEYWORDS.has(w.toLowerCase()));
  return bare ? name : cssFamily(name);
}

/** The stack for a font picked by name: the font, then the shared fallbacks. */
export function fontStack(font: string): string {
  const name = font.trim();
  const families = name ? [name] : [];
  for (const fallback of FALLBACKS) {
    if (!families.some((f) => f.toLowerCase() === fallback.toLowerCase())) families.push(fallback);
  }
  return families.map(cssFamily).join(', ');
}

/**
 * The font a stack names first, unquoted, as the pickers list it. Stacks
 * written by hand or by older versions (`Inter, system-ui, sans-serif`) read
 * the same way.
 */
export function fontFromStack(stack: string): string {
  const match = /^\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,]*)/.exec(stack);
  return unquote(match?.[1] ?? '');
}

import DOMPurify from 'dompurify';

const INLINE_ALLOWED_TAGS = [
  'b',
  'strong',
  'i',
  'em',
  'u',
  's',
  'strike',
  'del',
  'mark',
  'span',
  'sub',
  'sup',
  'br',
  'code',
  'a',
];

const INLINE_ALLOWED_ATTR = [
  'style',
  'class',
  'href',
  'target',
  'rel',
  'data-color',
  'data-highlight',
];

const ALLOWED_STYLE_PROP = /^(color|background-color|font-family|font-size|font-weight|font-style|text-decoration|text-align|margin-left)$/i;

/** CSS pixels per unit, for a length's size check. */
const PX_PER_UNIT: Readonly<Record<string, number>> = { px: 1, pt: 4 / 3, em: 16, rem: 16, '%': 0.16 };

/**
 * The largest size and indent a shown title or preview takes, in pixels: the
 * toolbar's largest size, and eight indent steps. A title's size and a card
 * preview's sizes and indents were dropped, so they showed while editing and
 * vanished after; anything larger could still cover the app, and is dropped.
 */
const LENGTH_CAP_PX: Readonly<Record<string, number>> = { 'font-size': 72, 'margin-left': 8 * 24 };

/** True when `value` is a plain length within `prop`'s cap (`20px`, a pasted `11pt`). */
function lengthWithinCap(prop: string, value: string): boolean {
  const cap = LENGTH_CAP_PX[prop];
  if (cap === undefined) return true;
  const m = /^(\d+(?:\.\d+)?)(px|pt|em|rem|%)$/i.exec(value);
  const perUnit = m ? PX_PER_UNIT[(m[2] ?? '').toLowerCase()] : undefined;
  return !!m && perUnit !== undefined && Number(m[1]) * perUnit <= cap;
}

/** The only address a previewed image may load: a vault file, through the media protocol. */
const VAULT_MEDIA = /^filo:\/\/media\//i;

let configured = false;
function ensureHook(): void {
  if (configured) return;
  configured = true;
  DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
    // An image loads only a vault file; with no such address it shows nothing.
    if (data.attrName === 'src' && node.nodeName === 'IMG' && !VAULT_MEDIA.test(String(data.attrValue))) {
      data.keepAttr = false;
      return;
    }
    if (data.attrName !== 'style') return;
    const filtered = String(data.attrValue)
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .filter((decl) => {
        const colon = decl.indexOf(':');
        if (colon === -1) return false;
        const prop = decl.slice(0, colon).trim();
        const value = decl.slice(colon + 1).trim();
        if (!ALLOWED_STYLE_PROP.test(prop)) return false;
        if (!lengthWithinCap(prop.toLowerCase(), value)) return false;
        if (/url\s*\(/i.test(value)) return false;
        if (/expression\s*\(/i.test(value)) return false;
        return true;
      })
      .join('; ');
    data.attrValue = filtered;
  });
}

// Explicit URI scheme allowlist. DOMPurify's defaults
// already block `javascript:`, `data:`, `vbscript:`, etc., so this is
// defence-in-depth against future config drift rather than a live XSS
// fix. The list mirrors the URI shapes Filo actually renders inside
// rich-text: web links (https/http), email (mailto:), telephone (tel:),
// and internal `filo://` board references. Anything else is stripped.
const ALLOWED_URI_REGEXP = /^(?:https?|mailto|tel|filo):/i;

export function sanitizeInlineHtml(html: string): string {
  ensureHook();
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: INLINE_ALLOWED_TAGS,
    ALLOWED_ATTR: INLINE_ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    ALLOWED_URI_REGEXP,
    // DOMPurify tests every attribute outside its URI-safe set against
    // ALLOWED_URI_REGEXP, so `_blank`, `noopener`, `#f00` (no scheme) would be
    // stripped. These four carry names and colours, never a URI.
    ADD_URI_SAFE_ATTR: ['target', 'rel', 'data-color', 'data-highlight'],
  });
}

const NOTE_BLOCK_TAGS = [
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'hr',
  'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
];

/**
 * A rendered note body (block Markdown as HTML) for a read-only preview: the
 * inline set plus block structure, with the same style and URI rules, and
 * images that load a vault file (`filo://media/`, which the caller has
 * resolved). No forms, other media or scripts; a preview loads nothing from
 * outside the vault.
 */
export function sanitizeNoteHtml(html: string): string {
  ensureHook();
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [...INLINE_ALLOWED_TAGS, ...NOTE_BLOCK_TAGS, 'img'],
    ALLOWED_ATTR: [...INLINE_ALLOWED_ATTR, 'start', 'colspan', 'rowspan', 'align', 'src', 'alt', 'width', 'height'],
    ALLOW_DATA_ATTR: false,
    ALLOWED_URI_REGEXP,
    ADD_URI_SAFE_ATTR: ['target', 'rel', 'data-color', 'data-highlight', 'start', 'align', 'alt', 'width', 'height'],
  });
}

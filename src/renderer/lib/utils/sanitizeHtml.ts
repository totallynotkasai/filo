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

const ALLOWED_STYLE_PROP = /^(color|background-color|font-family|font-weight|font-style|text-decoration|text-align)$/i;

let configured = false;
function ensureHook(): void {
  if (configured) return;
  configured = true;
  DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
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
        if (/url\s*\(/i.test(value)) return false;
        if (/expression\s*\(/i.test(value)) return false;
        return true;
      })
      .join('; ');
    data.attrValue = filtered;
  });
}

// Phase 37 / 37.3 — explicit URI scheme allowlist. DOMPurify's defaults
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
  });
}

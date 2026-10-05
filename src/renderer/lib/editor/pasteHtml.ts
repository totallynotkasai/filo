import { Extension } from '@tiptap/core';

/**
 * Rich text pasted from Word, Google Docs or a web page, tidied before the
 * editor reads it: the formatting that differs from your own text is kept,
 * and what only restates the source's defaults is dropped.
 *
 * Every Google Docs run carries black, Arial and 11 pt, and every Word run its
 * theme font and size, so a paste saved as black Arial 11 pt text: unreadable
 * in a dark theme, smaller than the note around it. Docs' highlights were
 * lost (a span's background), and Word's bullets arrived as a `·` and padding
 * glued to the line, which also opened the note read-only. Here:
 *
 * - near-black and near-white text loses its colour (it is the source's text
 *   colour, not a choice), and any other colour stays;
 * - the font most of the paste is in loses its name (the source's own font),
 *   and so does a bare generic family; any other font stays;
 * - point sizes go (Word's and Docs' body and heading sizes; a heading keeps
 *   its level), and pixel sizes from a web page stay;
 * - a span's background colour, or Word's highlight, becomes a highlight;
 * - Word's list paragraphs become real lists, nested by their level.
 *
 * HTML copied from a Filo editor (ProseMirror marks it `data-pm-slice`) is
 * the user's own formatting and is pasted as it is.
 */

/** ProseMirror's mark on HTML it put on the clipboard. */
const FROM_AN_EDITOR = 'data-pm-slice';

const GENERIC_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded',
]);

/** Word's highlight colours, by the names its `mso-highlight` uses. */
const WORD_HIGHLIGHTS: Readonly<Record<string, string>> = {
  yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff', magenta: '#ff00ff', blue: '#0000ff',
  red: '#ff0000', darkblue: '#000080', darkcyan: '#008080', darkgreen: '#008000',
  darkmagenta: '#800080', darkred: '#800000', darkyellow: '#808000', darkgray: '#808080',
  lightgray: '#c0c0c0',
};

/** The few named colours a pasted background uses, as hex. */
const NAMED_COLOURS: Readonly<Record<string, string>> = {
  ...WORD_HIGHLIGHTS,
  black: '#000000', white: '#ffffff', lime: '#00ff00', aqua: '#00ffff', fuchsia: '#ff00ff',
  gray: '#808080', grey: '#808080', orange: '#ffa500', pink: '#ffc0cb',
};

interface Rgb { r: number; g: number; b: number; a: number }

/** A CSS colour as red, green, blue and alpha, or null when it isn't one this reads. */
function rgbOf(colour: string): Rgb | null {
  const value = colour.trim().toLowerCase();
  const named = NAMED_COLOURS[value];
  if (named) return rgbOf(named);
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(value)?.[1];
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
    return { r: parseInt(full.slice(0, 2), 16), g: parseInt(full.slice(2, 4), 16), b: parseInt(full.slice(4, 6), 16), a: 1 };
  }
  const fn = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(value);
  if (fn) return { r: Number(fn[1]), g: Number(fn[2]), b: Number(fn[3]), a: fn[4] === undefined ? 1 : Number(fn[4]) };
  return null;
}

function hexOf({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')).join('')}`;
}

/** Text colours that are the source's default text, not a choice: near-black, near-white, Word's `windowtext`. */
function isDefaultTextColour(colour: string): boolean {
  const value = colour.trim().toLowerCase();
  if (value === 'windowtext' || value === 'auto' || value === 'inherit' || value === 'initial') return true;
  const rgb = rgbOf(value);
  if (!rgb) return false;
  return Math.max(rgb.r, rgb.g, rgb.b) <= 0x40 || Math.min(rgb.r, rgb.g, rgb.b) >= 0xe0;
}

/** A background colour that marks text: not transparent, not white (a page's own background). */
function highlightColour(colour: string): string | null {
  const rgb = rgbOf(colour);
  if (!rgb || rgb.a === 0 || Math.min(rgb.r, rgb.g, rgb.b) >= 0xf0) return null;
  return hexOf(rgb);
}

/** The first family a `font-family` value names, unquoted and lower-cased. */
function firstFamily(fontFamily: string): string {
  const first = fontFamily.split(',')[0] ?? '';
  return first.trim().replace(/^["']|["']$/g, '').toLowerCase();
}

/** The font most of the paste's text is set in (by characters), or null when none is set. */
function baseFont(root: HTMLElement): string | null {
  const counts = new Map<string, number>();
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const chars = (n.textContent ?? '').replace(/\s/g, '').length;
    if (chars === 0) continue;
    let family = '';
    for (let el = n.parentElement; el && el !== root && !family; el = el.parentElement) {
      family = firstFamily(el.style.fontFamily);
    }
    if (family) counts.set(family, (counts.get(family) ?? 0) + chars);
  }
  let best: string | null = null;
  let most = 0;
  for (const [family, chars] of counts) {
    if (chars > most) {
      best = family;
      most = chars;
    }
  }
  return best;
}

/** `el`'s style with the source's defaults dropped, and a background made a highlight. */
function tidyStyle(el: HTMLElement, base: string | null): void {
  const raw = el.getAttribute('style') ?? '';
  const style = el.style;
  if (style.color && isDefaultTextColour(style.color)) style.removeProperty('color');
  const family = firstFamily(style.fontFamily);
  if (family && (family === base || GENERIC_FAMILIES.has(family))) style.removeProperty('font-family');
  if (/pt$/i.test(style.fontSize.trim()) || style.fontSize === 'medium') style.removeProperty('font-size');
  if (el.tagName === 'SPAN') {
    const wordHighlight = /mso-highlight\s*:\s*([a-z]+)/i.exec(raw)?.[1]?.toLowerCase();
    const colour = highlightColour(style.backgroundColor) ?? (wordHighlight ? WORD_HIGHLIGHTS[wordHighlight] ?? null : null);
    style.removeProperty('background-color');
    style.removeProperty('background');
    if (colour) {
      const mark = el.ownerDocument.createElement('mark');
      mark.setAttribute('data-color', colour);
      while (el.firstChild) mark.appendChild(el.firstChild);
      el.appendChild(mark);
    }
  }
  if (!el.getAttribute('style')?.trim()) el.removeAttribute('style');
}

// ── Word's lists ─────────────────────────────────────────────────────────────

/** A Word list paragraph's level (1 for the outermost), or 0 for any other element. */
function wordListLevel(el: Element): number {
  const m = /mso-list\s*:\s*l\d+\s+level(\d+)/i.exec(el.getAttribute('style') ?? '');
  return el.tagName === 'P' && m ? Number(m[1]) : 0;
}

/** Word's numbering for an ordered item ("1.", "a)", "iv."); a bullet is anything else ("·", "o", "§"). */
const ORDERED_MARKER = /^(?:\d+|[a-z]|[ivxlcdm]+)[.)]$/i;

/** Takes the bullet or number Word wrote into the paragraph out of it. Returns whether it was a number. */
function takeWordMarker(p: Element): boolean {
  const markers = Array.from(p.querySelectorAll('span')).filter((s) => /mso-list\s*:\s*ignore/i.test(s.getAttribute('style') ?? ''));
  let ordered = false;
  for (const marker of markers) {
    const text = (marker.textContent ?? '').replace(/ /g, ' ').trim();
    if (ORDERED_MARKER.test(text)) ordered = true;
    // The marker's wrapper (Word's Symbol font span) holds nothing else.
    let outer: Element = marker;
    while (outer.parentElement && outer.parentElement !== p && (outer.parentElement.textContent ?? '').trim() === (marker.textContent ?? '').trim()) {
      outer = outer.parentElement;
    }
    outer.remove();
  }
  return ordered;
}

/** Each run of Word's list paragraphs as a nested list. */
function wordListsToLists(root: HTMLElement): void {
  const doc = root.ownerDocument;
  for (const first of Array.from(root.querySelectorAll('p'))) {
    if (!first.isConnected || wordListLevel(first) === 0) continue;
    const run: Element[] = [first];
    for (let next = first.nextElementSibling; next && wordListLevel(next) > 0; next = next.nextElementSibling) run.push(next);
    const lists = doc.createDocumentFragment();
    const stack: { level: number; list: HTMLElement }[] = [];
    for (const p of run) {
      const level = wordListLevel(p);
      const tag = takeWordMarker(p) ? 'OL' : 'UL';
      while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) > level) stack.pop();
      let top = stack[stack.length - 1];
      if (top && top.level === level && top.list.tagName !== tag) {
        // The same level switching between bullets and numbers starts a list beside it.
        stack.pop();
        const list = doc.createElement(tag);
        top.list.after(list);
        top = { level, list };
        stack.push(top);
      } else if (!top || top.level < level) {
        const list = doc.createElement(tag);
        (top?.list.lastElementChild ?? lists).appendChild(list);
        top = { level, list };
        stack.push(top);
      }
      // The item holds the text itself: an item holding a `<p>` reads as a loose list.
      const li = doc.createElement('li');
      while (p.firstChild) li.appendChild(p.firstChild);
      top.list.appendChild(li);
    }
    first.before(lists);
    for (const p of run) p.remove();
  }
}

/** `html` as pasted, tidied as described above. */
export function cleanPastedHtml(html: string): string {
  if (html.includes(FROM_AN_EDITOR)) return html;
  const body = new DOMParser().parseFromString(html, 'text/html').body;
  wordListsToLists(body);
  const base = baseFont(body);
  for (const el of Array.from(body.querySelectorAll<HTMLElement>('[style]'))) tidyStyle(el, base);
  return body.innerHTML;
}

/** Runs every HTML paste through `cleanPastedHtml`. */
export const PasteHtmlCleanup = Extension.create({
  name: 'filoPasteHtmlCleanup',

  transformPastedHTML(html: string): string {
    return cleanPastedHtml(html);
  },
});

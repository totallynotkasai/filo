/**
 * `sanitizeInlineHtml` is the sink for a tile's `titleHtml`, which is read
 * from `.board.json` — a file any program (or a synced copy from another
 * machine) can edit. Whatever it returns is rendered with `{@html}`, so these
 * cases pin what must never get through (scripts, handlers, script-bearing
 * URLs, CSS that can fetch or execute) and what the title formatting toolbar
 * relies on surviving (the inline marks, colour / highlight styles).
 */
import { describe, it, expect } from 'vitest';
import { sanitizeInlineHtml } from '@renderer/lib/utils/sanitizeHtml';

/** Parses sanitised output so assertions don't depend on attribute order or quoting. */
function parse(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = sanitizeInlineHtml(html);
  return host;
}

function styleOf(html: string): string {
  const el = parse(html).querySelector('span');
  return el?.getAttribute('style') ?? '';
}

describe('sanitizeInlineHtml: script execution', () => {
  it('removes <script> elements and their code', () => {
    const out = sanitizeInlineHtml('Hi<script>alert(1)</script> there');
    expect(out).not.toMatch(/script/i);
    expect(out).not.toContain('alert(1)');
    expect(out).toBe('Hi there');
  });

  it('removes event-handler attributes but keeps the allowed element', () => {
    const host = parse('<b onclick="alert(1)" onmouseover="x()">Bold</b>');
    const b = host.querySelector('b');
    expect(b).not.toBeNull();
    expect(b?.textContent).toBe('Bold');
    expect(b?.getAttributeNames()).toEqual([]);
  });

  it('drops an <img onerror> entirely (img is not an inline mark)', () => {
    const out = sanitizeInlineHtml('A<img src="x" onerror="alert(1)">B');
    expect(out).toBe('AB');
  });

  it('drops <svg> / <iframe> / <object> payloads', () => {
    const out = sanitizeInlineHtml(
      '<svg onload="alert(1)"><circle/></svg><iframe src="https://e.com"></iframe><object data="x"></object>ok',
    );
    expect(out).not.toMatch(/svg|iframe|object|onload/i);
    expect(out).toContain('ok');
  });
});

describe('sanitizeInlineHtml: link schemes', () => {
  function hrefOf(href: string): string | null {
    return parse(`<a href="${href}">link</a>`).querySelector('a')?.getAttribute('href') ?? null;
  }

  it.each(['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:msgbox(1)', 'file:///C:/secret.txt'])(
    'strips href %s but keeps the link text',
    (href) => {
      const host = parse(`<a href="${href}">link</a>`);
      expect(host.querySelector('a')?.hasAttribute('href')).toBe(false);
      expect(host.textContent).toBe('link');
    },
  );

  it.each([
    'https://example.com/a?b=c',
    'http://example.com',
    'mailto:me@example.com',
    'tel:+441234567890',
    'filo://board/abc123',
  ])('keeps href %s', (href) => {
    expect(hrefOf(href)).toBe(href);
  });

  it('strips a relative or fragment href (only the listed schemes pass)', () => {
    expect(hrefOf('#top')).toBeNull();
    expect(hrefOf('notes/a.md')).toBeNull();
  });

  // DOMPurify tests every attribute outside its URI-safe set against
  // `ALLOWED_URI_REGEXP`; `_blank` / `noopener` have no scheme, so they
  // survive only because the sanitiser marks these attributes URI-safe.
  it('keeps target and rel on a link', () => {
    const a = parse('<a href="https://e.com" target="_blank" rel="noopener">x</a>').querySelector('a');
    expect(a?.getAttribute('target')).toBe('_blank');
    expect(a?.getAttribute('rel')).toBe('noopener');
  });
});

describe('sanitizeInlineHtml: tags', () => {
  it.each(['b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'mark', 'span', 'sub', 'sup', 'code', 'a'])(
    'keeps the inline mark <%s>',
    (tag) => {
      const host = parse(`<${tag}>text</${tag}>`);
      const el = host.querySelector(tag);
      expect(el).not.toBeNull();
      expect(el?.textContent).toBe('text');
    },
  );

  it('keeps <br>', () => {
    expect(parse('one<br>two').querySelector('br')).not.toBeNull();
  });

  it('keeps nested marks', () => {
    const host = parse('<b><i><u>deep</u></i></b>');
    expect(host.querySelector('b > i > u')?.textContent).toBe('deep');
  });

  it.each(['div', 'p', 'h1', 'table', 'form', 'button', 'style', 'input'])(
    'removes the block / non-inline element <%s>',
    (tag) => {
      const out = sanitizeInlineHtml(`<${tag}>inside</${tag}>`);
      expect(out.toLowerCase()).not.toContain(`<${tag}`);
    },
  );

  it('keeps the text of a removed structural element', () => {
    expect(sanitizeInlineHtml('<div>Hello <b>world</b></div>')).toBe('Hello <b>world</b>');
    expect(sanitizeInlineHtml('<p>para</p>')).toBe('para');
  });

  it('drops the content of a removed <style> element (it is not text)', () => {
    const out = sanitizeInlineHtml('<style>body{display:none}</style>visible');
    expect(out).toBe('visible');
  });

  it('leaves plain text (with entities) unchanged', () => {
    expect(sanitizeInlineHtml('Tom &amp; Jerry')).toBe('Tom &amp; Jerry');
    expect(sanitizeInlineHtml('')).toBe('');
  });
});

describe('sanitizeInlineHtml: attributes', () => {
  it('keeps class', () => {
    expect(parse('<span class="c">x</span>').querySelector('span')?.getAttribute('class')).toBe('c');
  });

  // Same cause as target / rel above: `#f00` / `yellow` have no scheme.
  it('keeps the allowed data-color / data-highlight attributes', () => {
    const mark = parse('<mark data-color="#f00" data-highlight="yellow">x</mark>').querySelector('mark');
    expect(mark?.getAttribute('data-color')).toBe('#f00');
    expect(mark?.getAttribute('data-highlight')).toBe('yellow');
  });

  it('drops any other data-* attribute', () => {
    const span = parse('<span data-evil="1" data-tile-id="t1">x</span>').querySelector('span');
    expect(span?.hasAttribute('data-evil')).toBe(false);
    expect(span?.hasAttribute('data-tile-id')).toBe(false);
  });

  it('drops attributes outside the allowlist (id, title, src)', () => {
    const span = parse('<span id="i" title="t" src="s">x</span>').querySelector('span');
    expect(span?.getAttributeNames()).toEqual([]);
  });
});

describe('sanitizeInlineHtml: style filter', () => {
  it.each([
    ['color', 'red'],
    ['background-color', 'rgb(1, 2, 3)'],
    ['font-family', 'Arial'],
    ['font-weight', 'bold'],
    ['font-style', 'italic'],
    ['text-decoration', 'underline'],
    ['text-align', 'center'],
  ])('keeps the allowed property %s', (prop, value) => {
    expect(styleOf(`<span style="${prop}: ${value}">x</span>`)).toBe(`${prop}: ${value}`);
  });

  it('matches allowed property names case-insensitively', () => {
    expect(styleOf('<span style="COLOR: red">x</span>')).toBe('COLOR: red');
  });

  it('drops properties outside the allowlist and keeps the allowed ones', () => {
    expect(styleOf('<span style="position: fixed; color: red; top: 0; z-index: 9999">x</span>')).toBe('color: red');
  });

  it('drops properties that could cover or restyle the app (display, width, font-size)', () => {
    expect(styleOf('<span style="display: block; width: 100vw; font-size: 400px">x</span>')).toBe('');
  });

  it('drops a value that fetches through url(), in any case and spacing', () => {
    expect(styleOf('<span style="background-color: url(https://e.com/t.png); color: blue">x</span>')).toBe('color: blue');
    expect(styleOf('<span style="color: URL (x)">x</span>')).toBe('');
  });

  it('drops a legacy expression() value', () => {
    expect(styleOf('<span style="color: expression(alert(1)); font-weight: bold">x</span>')).toBe('font-weight: bold');
  });

  it('drops malformed declarations with no colon and tolerates stray semicolons', () => {
    expect(styleOf('<span style=";;color: red;;garbage;font-style: italic;">x</span>')).toBe('color: red; font-style: italic');
  });

  it('does not let a lookalike property name through (color-scheme, -webkit-color)', () => {
    expect(styleOf('<span style="color-scheme: dark; -webkit-text-fill-color: red">x</span>')).toBe('');
  });

  it('filters the same way on every call (the hook is installed once, not stacked)', () => {
    const first = styleOf('<span style="color: red; top: 0">x</span>');
    const second = styleOf('<span style="color: red; top: 0">x</span>');
    expect(first).toBe('color: red');
    expect(second).toBe(first);
  });
});

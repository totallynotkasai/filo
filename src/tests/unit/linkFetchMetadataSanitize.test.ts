import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

/**
 * Audit-15 P3.2 — `link:fetch-metadata` extracts `og:image` / `<link rel=icon>`
 * from attacker-controllable page markup and used to return them verbatim. A
 * hostile page could aim them at an internal address; today only the renderer
 * CSP (`img-src 'self' data: blob: filo:`) stops the load, but that's an
 * adjacent control, not the channel's own validation. The fix resolves each
 * against the (already SSRF-validated) final page URL and drops anything that
 * lands on a private host or a non-displayable scheme.
 *
 * Two layers of coverage:
 *   1. `sanitizeReturnedResourceUrl` exercised in isolation (fast, exhaustive).
 *   2. The full `link:fetch-metadata` handler driven with a mocked page fetch,
 *      proving the sanitiser is actually WIRED into the returned envelope.
 *
 * Bite-verify: revert either `sanitizeReturnedResourceUrl(...)` call site in
 * media.ipc.ts → the pipeline specs go red (the private image/favicon survive).
 */

const mockState = vi.hoisted(() => ({
  handlers: new Map<string, (...a: unknown[]) => unknown | Promise<unknown>>(),
  dnsResult: [] as Array<{ address: string; family: number }>,
  fetchHtml: '' as string,
}));

vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => unknown | Promise<unknown>) => {
      mockState.handlers.set(ch, fn);
    },
    on: () => {},
    once: () => {},
  },
  shell: { openExternal: async () => {}, openPath: async () => {} },
  BrowserWindow: { getAllWindows: () => [] },
}));

// dns.lookup mock — node-callback shape so `promisify(dns.lookup)` resolves.
vi.mock('dns', () => ({
  lookup: (
    _hostname: string,
    options: unknown,
    callback?: (e: Error | null, r?: unknown) => void,
  ) => {
    const cb = (typeof options === 'function' ? options : callback) as (
      e: Error | null,
      r?: unknown,
    ) => void;
    cb(null, mockState.dnsResult);
  },
}));

// The page fetch itself (its connection checks are `publicHttpConnection.test.ts`'s):
// every page is the HTML in `mockState.fetchHtml`, served from the URL asked for.
vi.mock('../../main/services/publicHttp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../main/services/publicHttp')>()),
  getPublic: async (url: string) => ({
    status: 200,
    url,
    contentType: 'text/html; charset=utf-8',
    readBody: async () => Buffer.from(mockState.fetchHtml, 'utf8'),
    discard: () => {},
  }),
}));

vi.mock('../../main/ipc/vault.ipc', () => ({
  getActiveWatcher: () => null,
  getVaultRoot: () => null,
}));

const { registerMediaHandlers, sanitizeReturnedResourceUrl } = await import('../../main/ipc/media.ipc');

// ── 1. sanitizeReturnedResourceUrl in isolation ─────────────────────────────
describe('sanitizeReturnedResourceUrl — Audit-15 P3.2', () => {
  const BASE = 'https://example.com/article';

  it('returns "" for empty input', () => {
    expect(sanitizeReturnedResourceUrl('', BASE)).toBe('');
  });

  it('keeps a public absolute http(s) URL', () => {
    expect(sanitizeReturnedResourceUrl('https://cdn.example.com/og.png', BASE)).toBe(
      'https://cdn.example.com/og.png',
    );
  });

  it('resolves a relative URL against the page URL', () => {
    expect(sanitizeReturnedResourceUrl('/images/hero.png', BASE)).toBe(
      'https://example.com/images/hero.png',
    );
  });

  it('resolves a protocol-relative URL against the page scheme', () => {
    expect(sanitizeReturnedResourceUrl('//cdn.example.com/og.png', BASE)).toBe(
      'https://cdn.example.com/og.png',
    );
  });

  it('drops a loopback / private / link-local host', () => {
    expect(sanitizeReturnedResourceUrl('http://127.0.0.1/x.png', BASE)).toBe('');
    expect(sanitizeReturnedResourceUrl('http://10.0.0.5/x.png', BASE)).toBe('');
    expect(sanitizeReturnedResourceUrl('http://192.168.1.4/x.png', BASE)).toBe('');
    expect(sanitizeReturnedResourceUrl('http://169.254.169.254/latest', BASE)).toBe('');
    expect(sanitizeReturnedResourceUrl('http://localhost:8080/x.png', BASE)).toBe('');
  });

  it('drops a private host even when reached via a relative resolve against a private base', () => {
    // Defensive: if a future caller ever passed a private base, relative
    // resolution must not launder a private host into a kept URL.
    expect(sanitizeReturnedResourceUrl('/x.png', 'http://10.0.0.5/page')).toBe('');
  });

  it('keeps a data: URL (CSP permits it; no network fetch)', () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
    expect(sanitizeReturnedResourceUrl(dataUrl, BASE)).toBe(dataUrl);
  });

  it('drops a javascript: / file: / blob: scheme', () => {
    expect(sanitizeReturnedResourceUrl('javascript:alert(1)', BASE)).toBe('');
    expect(sanitizeReturnedResourceUrl('file:///etc/passwd', BASE)).toBe('');
    expect(sanitizeReturnedResourceUrl('blob:https://example.com/abc', BASE)).toBe('');
  });

  it('drops garbage that will not parse even with a base', () => {
    // A bare scheme with no host, etc. — anything `new URL` rejects → "".
    expect(sanitizeReturnedResourceUrl('http://', BASE)).toBe('');
  });
});

// ── 2. full link:fetch-metadata pipeline ────────────────────────────────────
describe('link:fetch-metadata — image/favicon sanitised end-to-end (Audit-15 P3.2)', () => {
  let fetchHandler: (...a: unknown[]) => Promise<unknown>;

  beforeAll(() => {
    registerMediaHandlers();
    const h = mockState.handlers.get('link:fetch-metadata');
    if (!h) throw new Error('link:fetch-metadata handler not registered');
    fetchHandler = h as typeof fetchHandler;
  });

  beforeEach(() => {
    // Page host resolves to a public IP so the page itself passes the SSRF gate.
    mockState.dnsResult = [{ address: '93.184.216.34', family: 4 }];
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const callFetch = async (url: string) =>
    (await fetchHandler({}, url)) as {
      success: boolean;
      image?: string;
      favicon?: string;
      title?: string;
    };

  it('drops an og:image and a favicon that point at private addresses', async () => {
    mockState.fetchHtml = [
      '<html><head>',
      '<title>Hi</title>',
      '<meta property="og:image" content="http://169.254.169.254/og.png">',
      '<link rel="icon" href="http://10.0.0.1/fav.png">',
      '</head><body></body></html>',
    ].join('');

    const res = await callFetch('https://example.com/article');
    expect(res.success).toBe(true);
    expect(res.title).toBe('Hi');
    expect(res.image).toBe('');
    expect(res.favicon).toBe('');
  });

  it('keeps a public og:image and resolves a relative favicon against the page origin', async () => {
    mockState.fetchHtml = [
      '<html><head>',
      '<meta property="og:image" content="https://cdn.example.com/og.png">',
      '<link rel="icon" href="/static/fav.png">',
      '</head><body></body></html>',
    ].join('');

    const res = await callFetch('https://example.com/article');
    expect(res.success).toBe(true);
    expect(res.image).toBe('https://cdn.example.com/og.png');
    expect(res.favicon).toBe('https://example.com/static/fav.png');
  });

  it('resolves a relative og:image against the final page URL', async () => {
    mockState.fetchHtml = [
      '<html><head>',
      '<meta property="og:image" content="/images/hero.png">',
      '</head><body></body></html>',
    ].join('');

    const res = await callFetch('https://example.com/article');
    expect(res.success).toBe(true);
    expect(res.image).toBe('https://example.com/images/hero.png');
  });

  it('falls back to the (public) default favicon when the page declares none', async () => {
    mockState.fetchHtml = '<html><head><title>No icon</title></head><body></body></html>';
    const res = await callFetch('https://example.com/article');
    expect(res.success).toBe(true);
    expect(res.favicon).toBe('https://example.com/favicon.ico');
  });
});

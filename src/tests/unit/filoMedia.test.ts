/**
 * The `filo://media/<path>` protocol handler end to end: the real handler
 * registered through a stubbed `protocol.handle`, serving real files from a
 * temp vault. The Range parser and the path guard have their own suites; this
 * pins what the handler does with their answers (status, headers, the bytes
 * streamed) and the refusals that must never reach the file system.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

type ProtocolHandler = (request: Request) => Promise<Response>;

const h = vi.hoisted(() => ({
  handler: null as ((request: Request) => Promise<Response>) | null,
  scheme: '',
  vaultRoot: null as string | null,
}));

vi.mock('electron', () => ({
  protocol: {
    handle: (scheme: string, fn: (request: Request) => Promise<Response>) => {
      h.scheme = scheme;
      h.handler = fn;
    },
  },
}));

// The real vault.ipc pulls in every vault handler; the protocol only needs the
// active root.
vi.mock('../../main/ipc/vault.ipc', () => ({
  getVaultRoot: () => h.vaultRoot,
}));

const { registerFiloProtocol } = await import('../../main/protocol/filoMedia');

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const SVG_TEXT = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';

let vaultRoot = '';

function serve(): ProtocolHandler {
  if (!h.handler) throw new Error('filo protocol not registered');
  return h.handler;
}

async function get(url: string, range?: string): Promise<Response> {
  const headers = new Headers();
  if (range !== undefined) headers.set('Range', range);
  return serve()(new Request(url, { headers }));
}

async function bytes(res: Response): Promise<number[]> {
  return [...new Uint8Array(await res.arrayBuffer())];
}

beforeAll(() => {
  vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'filo-media-proto-'));
  fs.mkdirSync(path.join(vaultRoot, 'media'));
  fs.mkdirSync(path.join(vaultRoot, '.filo'));
  fs.writeFileSync(path.join(vaultRoot, 'media', 'pic.png'), PNG_BYTES);
  fs.writeFileSync(path.join(vaultRoot, 'media', 'my pic.png'), PNG_BYTES);
  fs.writeFileSync(path.join(vaultRoot, 'media', 'draw.svg'), SVG_TEXT);
  fs.writeFileSync(path.join(vaultRoot, 'media', 'blob.xyz'), 'abc');
  fs.writeFileSync(path.join(vaultRoot, '.filo', 'tags.json'), '{"secret":true}');
  registerFiloProtocol();
});

afterAll(() => {
  fs.rmSync(vaultRoot, { recursive: true, force: true });
});

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  h.vaultRoot = vaultRoot;
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  errSpy.mockRestore();
});

describe('registerFiloProtocol', () => {
  it('registers a handler for the filo scheme', () => {
    expect(h.scheme).toBe('filo');
    expect(h.handler).toBeTypeOf('function');
  });
});

describe('refusals', () => {
  it('404s any host other than media', async () => {
    const res = await get('filo://board/media/pic.png');
    expect(res.status).toBe(404);
  });

  it('404s when no vault is open', async () => {
    h.vaultRoot = null;
    const res = await get('filo://media/media/pic.png');
    expect(res.status).toBe(404);
  });

  it('400s an empty path', async () => {
    const res = await get('filo://media/');
    expect(res.status).toBe(400);
  });

  it('403s a path into .filo/ (config bytes must never stream)', async () => {
    const res = await get('filo://media/.filo/tags.json');
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('secret');
  });

  it('403s an encoded traversal out of the vault', async () => {
    const res = await get('filo://media/%2E%2E%2Foutside.png');
    expect(res.status).toBe(403);
  });

  it('404s a folder', async () => {
    const res = await get('filo://media/media');
    expect(res.status).toBe(404);
  });

  it('404s a missing file without logging an error (a broken tile, not a server fault)', async () => {
    const res = await get('filo://media/media/gone.png');
    expect(res.status).toBe(404);
    expect(errSpy).not.toHaveBeenCalled();
  });
});

describe('full responses', () => {
  it('streams the whole file with its type, length and range support advertised', async () => {
    const res = await get('filo://media/media/pic.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Content-Length')).toBe(String(PNG_BYTES.length));
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    expect(res.headers.get('Cache-Control')).toBe('no-cache');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Disposition')).toBeNull();
    expect(await bytes(res)).toEqual([...PNG_BYTES]);
  });

  it('decodes a percent-encoded file name', async () => {
    const res = await get('filo://media/media/my%20pic.png');
    expect(res.status).toBe(200);
    expect(await bytes(res)).toEqual([...PNG_BYTES]);
  });

  it('serves an unknown extension as octet-stream, still nosniff', async () => {
    const res = await get('filo://media/media/blob.xyz');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(await res.text()).toBe('abc');
  });

  it('forces an SVG to download under a sandboxing CSP, so its script never runs inline', async () => {
    const res = await get('filo://media/media/draw.svg');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/svg+xml');
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="draw.svg"');
    const csp = res.headers.get('Content-Security-Policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('sandbox');
  });
});

describe('Range requests', () => {
  it('answers a satisfiable range with 206 and exactly those bytes', async () => {
    const res = await get('filo://media/media/pic.png', 'bytes=2-5');
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe(`bytes 2-5/${PNG_BYTES.length}`);
    expect(res.headers.get('Content-Length')).toBe('4');
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(await bytes(res)).toEqual([...PNG_BYTES.subarray(2, 6)]);
  });

  it('serves an open-ended range to the last byte', async () => {
    const res = await get('filo://media/media/pic.png', 'bytes=8-');
    expect(res.status).toBe(206);
    expect(await bytes(res)).toEqual([...PNG_BYTES.subarray(8)]);
  });

  it('serves a suffix range as the last N bytes', async () => {
    const res = await get('filo://media/media/pic.png', 'bytes=-3');
    expect(res.status).toBe(206);
    expect(await bytes(res)).toEqual([...PNG_BYTES.subarray(PNG_BYTES.length - 3)]);
  });

  it('answers an unsatisfiable range with 416 naming the size', async () => {
    const res = await get('filo://media/media/pic.png', 'bytes=100-200');
    expect(res.status).toBe(416);
    expect(res.headers.get('Content-Range')).toBe(`bytes */${PNG_BYTES.length}`);
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
  });

  it('keeps the SVG download headers on a ranged and a refused-range answer', async () => {
    const ranged = await get('filo://media/media/draw.svg', 'bytes=0-3');
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('Content-Disposition')).toBe('attachment; filename="draw.svg"');
    const refused = await get('filo://media/media/draw.svg', 'bytes=9999-');
    expect(refused.status).toBe(416);
    expect(refused.headers.get('Content-Disposition')).toBe('attachment; filename="draw.svg"');
    expect(refused.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });
});

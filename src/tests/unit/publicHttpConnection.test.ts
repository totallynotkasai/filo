import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as http from 'http';
import * as zlib from 'zlib';
import type { AddressInfo } from 'net';

/**
 * The Link tile's page fetch reaches public addresses only, checked in the
 * connection itself on every hop (`services/publicHttp.ts`). The old fetch
 * resolved the name to check it, then let `fetch` resolve it again, so a name
 * answering a public address first and a private one second (DNS rebinding)
 * was fetched from the user's own network.
 *
 * Two real servers stand in for the internet and the home network: 127.0.0.1
 * counts as public here and 127.0.0.2 as private (`isPrivateUrl` is narrowed
 * to that for this file). DNS answers come from `answers`, one list per call.
 */

const mockState = vi.hoisted(() => ({
  answers: new Map<string, Array<Array<{ address: string; family: number }>>>(),
  handlers: new Map<string, (...a: unknown[]) => unknown | Promise<unknown>>(),
}));

vi.mock('dns', () => {
  const lookup = (
    hostname: string,
    options: unknown,
    callback?: (e: Error | null, r?: unknown) => void,
  ): void => {
    const cb = (typeof options === 'function' ? options : callback) as (e: Error | null, r?: unknown) => void;
    const queue = mockState.answers.get(hostname);
    if (!queue || queue.length === 0) {
      cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }));
      return;
    }
    // The last answer repeats; earlier ones are used once each.
    cb(null, queue.length > 1 ? queue.shift() : queue[0]);
  };
  return { default: { lookup }, lookup };
});

vi.mock('../../main/utils/pathSecurity', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../main/utils/pathSecurity')>();
  return {
    ...real,
    isPrivateUrl: (url: string): boolean => {
      const host = new URL(url).hostname;
      if (host === '127.0.0.1') return false;
      if (host === '127.0.0.2') return true;
      return real.isPrivateUrl(url);
    },
  };
});

vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => unknown | Promise<unknown>) => {
      mockState.handlers.set(ch, fn);
    },
    on: () => {},
    once: () => {},
  },
  shell: { openExternal: async () => {}, openPath: async () => '' },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../../main/ipc/vault.ipc', () => ({
  getActiveWatcher: () => null,
  getVaultRoot: () => null,
}));

const { getPublic, PrivateAddressError, RedirectRefusedError } = await import('../../main/services/publicHttp');
const { registerMediaHandlers } = await import('../../main/ipc/media.ipc');

const PAGE = '<html><head><title>The Siege</title></head><body>public page</body></html>';

let publicServer: http.Server;
let privateServer: http.Server;
let publicPort = 0;
let privatePort = 0;
let publicRequests: string[] = [];
let privateRequests: string[] = [];

function listen(server: http.Server, host: string): Promise<number> {
  return new Promise((resolve) => server.listen(0, host, () => resolve((server.address() as AddressInfo).port)));
}

beforeAll(async () => {
  publicServer = http.createServer((req, res) => {
    publicRequests.push(req.url ?? '');
    if (req.url === '/start') {
      res.writeHead(302, { Location: '/page' });
      res.end();
    } else if (req.url === '/page') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Encoding': 'gzip' });
      res.end(zlib.gzipSync(PAGE));
    } else if (req.url === '/to-inner') {
      res.writeHead(302, { Location: `http://inner.test:${privatePort}/admin` });
      res.end();
    } else if (req.url === '/loop') {
      res.writeHead(302, { Location: '/loop' });
      res.end();
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(PAGE);
    }
  });
  privateServer = http.createServer((req, res) => {
    privateRequests.push(req.url ?? '');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><head><title>Router admin</title></head></html>');
  });
  publicPort = await listen(publicServer, '127.0.0.1');
  privatePort = await listen(privateServer, '127.0.0.2');
  registerMediaHandlers();
});

afterAll(async () => {
  await new Promise((r) => publicServer.close(r));
  await new Promise((r) => privateServer.close(r));
});

beforeEach(() => {
  publicRequests = [];
  privateRequests = [];
  mockState.answers.clear();
  mockState.answers.set('pub.test', [[{ address: '127.0.0.1', family: 4 }]]);
  mockState.answers.set('inner.test', [[{ address: '127.0.0.2', family: 4 }]]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const signal = (): AbortSignal => AbortSignal.timeout(5000);

describe('getPublic: the connection itself is checked', () => {
  it('never connects to a name that answers a private address', async () => {
    await expect(getPublic(`http://inner.test:${privatePort}/admin`, { signal: signal(), maxRedirects: 5 }))
      .rejects.toBeInstanceOf(PrivateAddressError);
    expect(privateRequests).toEqual([]);
  });

  it('refuses a name with one private answer among public ones, connecting to neither', async () => {
    mockState.answers.set('mixed.test', [[{ address: '127.0.0.1', family: 4 }, { address: '127.0.0.2', family: 4 }]]);
    await expect(getPublic(`http://mixed.test:${publicPort}/`, { signal: signal(), maxRedirects: 5 }))
      .rejects.toBeInstanceOf(PrivateAddressError);
    expect(publicRequests).toEqual([]);
    expect(privateRequests).toEqual([]);
  });

  it('checks a redirect at its own hop: the public page is asked, the private one never', async () => {
    await expect(getPublic(`http://pub.test:${publicPort}/to-inner`, { signal: signal(), maxRedirects: 5 }))
      .rejects.toBeInstanceOf(PrivateAddressError);
    expect(publicRequests).toEqual(['/to-inner']);
    expect(privateRequests).toEqual([]);
  });

  it('checks the address it connected to, even with no name to look up', async () => {
    await expect(getPublic(`http://127.0.0.2:${privatePort}/admin`, { signal: signal(), maxRedirects: 5 }))
      .rejects.toBeInstanceOf(PrivateAddressError);
    expect(privateRequests).toEqual([]);
  });

  it('fetches a public page through a redirect and decodes its gzip body', async () => {
    const res = await getPublic(`http://pub.test:${publicPort}/start`, { signal: signal(), maxRedirects: 5 });
    expect(res.status).toBe(200);
    expect(res.url).toBe(`http://pub.test:${publicPort}/page`);
    expect(res.contentType).toBe('text/html; charset=utf-8');
    expect((await res.readBody(512 * 1024))?.toString('utf8')).toBe(PAGE);
  });

  it('stops reading a body past its cap', async () => {
    const res = await getPublic(`http://pub.test:${publicPort}/page`, { signal: signal(), maxRedirects: 5 });
    expect(await res.readBody(10)).toBeNull();
  });

  it('stops after too many redirects', async () => {
    await expect(getPublic(`http://pub.test:${publicPort}/loop`, { signal: signal(), maxRedirects: 2 }))
      .rejects.toBeInstanceOf(RedirectRefusedError);
    expect(publicRequests).toEqual(['/loop', '/loop', '/loop']);
  });
});

describe('link:fetch-metadata', () => {
  const fetchMetadata = async (url: string): Promise<{ success: boolean; title?: string; error?: string }> =>
    (await mockState.handlers.get('link:fetch-metadata')!({}, url)) as { success: boolean; title?: string; error?: string };

  it('refuses a name that answers a private address, and never asks it', async () => {
    const result = await fetchMetadata(`http://inner.test:${privatePort}/admin`);
    expect(result.success).toBe(false);
    expect(result.error).toBe('URL not allowed (resolves to private address)');
    expect(privateRequests).toEqual([]);
  });

  it('refuses a public page that redirects to a private one', async () => {
    const result = await fetchMetadata(`http://pub.test:${publicPort}/to-inner`);
    expect(result.success).toBe(false);
    expect(result.error).toBe('URL not allowed (resolves to private address)');
    expect(privateRequests).toEqual([]);
  });

  it("returns a public page's title, connecting where the checked answer points", async () => {
    const result = await fetchMetadata(`http://pub.test:${publicPort}/start`);
    expect(result).toMatchObject({ success: true, title: 'The Siege' });
  });
});

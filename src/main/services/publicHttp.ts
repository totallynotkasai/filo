import * as dns from 'dns';
import * as http from 'http';
import * as https from 'https';
import * as zlib from 'zlib';
import type { Readable } from 'stream';
import { isPrivateUrl } from '../utils/pathSecurity';

/**
 * GET requests that only ever reach public addresses: the Link tile's page
 * preview (`link:fetch-metadata`), the one network call Filo makes.
 *
 * A check that resolves a name and then hands the URL to `fetch` is not
 * enough: `fetch` resolves the name again, and a name with a short TTL can
 * answer a public address to the check and a private one to the connection
 * (DNS rebinding), so a page on the user's own network would be fetched. Here
 * the check sits in the connection itself:
 *  - the socket resolves through `checkedLookup`, which refuses a name if any
 *    of its addresses is private, so the socket connects only to an address
 *    that was checked;
 *  - the address the socket actually connected to is checked again before a
 *    byte is sent (an address literal skips the lookup);
 *  - every redirect is a new request through the same two checks.
 */

/** A request whose target is, or resolves to, a private, loopback or link-local address. */
export class PrivateAddressError extends Error {
  constructor(host: string) {
    super(`${host} is a private, loopback or link-local address`);
    this.name = 'PrivateAddressError';
  }
}

/** Whether an IP address, as DNS or a socket reports it, is private, loopback or link-local. */
export function isPrivateAddress(address: string): boolean {
  return isPrivateUrl(address.includes(':') ? `http://[${address}]/` : `http://${address}/`);
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;

/**
 * The `lookup` a socket resolves its host with: every address the name
 * answers must be public, or the name is refused before anything connects.
 * Answers in both shapes Node asks for (`all` or a single address).
 */
export function checkedLookup(hostname: string, options: dns.LookupOptions, callback: LookupCallback): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) {
      callback(err, '');
      return;
    }
    const list = addresses as dns.LookupAddress[];
    const first = list[0];
    if (!first || list.some((a) => isPrivateAddress(a.address))) {
      callback(new PrivateAddressError(hostname), '');
      return;
    }
    if (options.all) callback(null, list);
    else callback(null, first.address, first.family);
  });
}

/** A redirect that leads to an address Filo won't fetch, or one too many. */
export class RedirectRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedirectRefusedError';
  }
}

export interface PublicResponse {
  status: number;
  /** The address this response came from, after redirects. */
  url: string;
  contentType: string;
  /**
   * The body, decoded from its Content-Encoding, or null once it runs past
   * `maxBytes` (decoded bytes: a small compressed body can't expand without
   * limit). Reading stops there.
   */
  readBody(maxBytes: number): Promise<Buffer | null>;
  /** Closes the connection without reading the body. */
  discard(): void;
}

export interface GetPublicOptions {
  signal: AbortSignal;
  maxRedirects: number;
  headers?: Record<string, string>;
}

/**
 * GETs `url`, following up to `maxRedirects` redirects. Throws
 * `PrivateAddressError` when any hop's address is private (by name, by DNS
 * answer or by the address connected to), and `RedirectRefusedError` for a
 * redirect to a non-web address or past the limit.
 */
export async function getPublic(url: string, opts: GetPublicOptions): Promise<PublicResponse> {
  let current = new URL(url);
  for (let hop = 0; ; hop++) {
    const res = await requestOnce(current, opts);
    const location = res.headers.location;
    if (res.statusCode !== undefined && res.statusCode >= 300 && res.statusCode < 400 && location) {
      res.resume();
      if (hop >= opts.maxRedirects) throw new RedirectRefusedError('Too many redirects');
      const next = new URL(location, current);
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        throw new RedirectRefusedError('URL not allowed (redirect to a non-web address)');
      }
      if (isPrivateUrl(next.href)) throw new PrivateAddressError(next.hostname);
      current = next;
      continue;
    }
    const finalUrl = current.href;
    return {
      status: res.statusCode ?? 0,
      url: finalUrl,
      contentType: String(res.headers['content-type'] ?? ''),
      readBody: (maxBytes) => readCapped(decoded(res), maxBytes).finally(() => res.destroy()),
      discard: () => res.destroy(),
    };
  }
}

function requestOnce(target: URL, opts: GetPublicOptions): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const client = target.protocol === 'https:' ? https : http;
    const req = client.request(
      target,
      {
        method: 'GET',
        headers: { 'Accept-Encoding': 'gzip, deflate, br', ...opts.headers },
        signal: opts.signal,
        lookup: checkedLookup,
        // A connection of its own per hop: a pooled socket would skip the connect check.
        agent: false,
      },
      (res) => {
        const remote = res.socket?.remoteAddress;
        if (!remote || isPrivateAddress(remote)) {
          res.destroy();
          reject(new PrivateAddressError(target.hostname));
          return;
        }
        resolve(res);
      },
    );
    req.on('socket', (socket) => {
      const check = (): void => {
        const remote = socket.remoteAddress;
        if (!remote || isPrivateAddress(remote)) socket.destroy(new PrivateAddressError(target.hostname));
      };
      // Registered before the request's own write waits for `connect`, so a
      // refused socket is closed before the request line is sent.
      if (socket.connecting) socket.once('connect', check);
      else check();
    });
    req.on('error', reject);
    req.end();
  });
}

/** The body stream decoded from its Content-Encoding. */
function decoded(res: http.IncomingMessage): Readable {
  const encoding = String(res.headers['content-encoding'] ?? '').trim().toLowerCase();
  const decoder = encoding === 'gzip' || encoding === 'x-gzip'
    ? zlib.createGunzip()
    : encoding === 'deflate'
      ? zlib.createInflate()
      : encoding === 'br'
        ? zlib.createBrotliDecompress()
        : null;
  if (!decoder) return res;
  res.on('error', (err) => decoder.destroy(err));
  return res.pipe(decoder);
}

async function readCapped(stream: Readable, maxBytes: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += buf.byteLength;
      if (total > maxBytes) return null;
      chunks.push(buf);
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks);
}

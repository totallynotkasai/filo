import { protocol } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { resolveServableMediaPath } from './mediaPathGuard';
import { getMimeType } from '../utils/mime';
import { getVaultRoot } from '../ipc/vault.ipc';
import { parseRangeHeader } from './rangeHeader';
import { logMainError } from '../utils/mainLogger';

/**
 * Registers the `filo://` URL protocol used by the renderer to load
 * vault-local media (images / video / audio) inside `<img>`, `<video>`,
 * `<audio>`. Chromium refuses bare `file://` URLs in renderers with
 * `webSecurity: true`, so we expose a sandboxed custom scheme that resolves
 * `filo://media/<vault-relative-path>` against the active vault root and
 * streams the file's bytes back as a `Response`.
 *
 * Honours HTTP `Range` requests so HTMLVideoElement can seek/buffer — without
 * a 206 partial-content response Chromium silently refuses to play anything
 * past the first few seconds of larger files. The handler advertises
 * `Accept-Ranges: bytes` on every response so the video element knows it can
 * issue ranged requests in the first place.
 *
 * Security:
 *   - Only `media` host is recognised; anything else 404s.
 *   - The decoded path is run through `resolveServableMediaPath`, which applies
 *     the structural `assertSafeRelativePath` + `.filo/` `assertNotInFiloDir`
 *     guards and then `assertWithinVault` (canonicalises symlinks/junctions,
 *     refuses escapes). A rejected path returns 403 — matching the other
 *     renderer-facing read channels.
 *   - There is no active vault → 404 (renderer should not have a media URL
 *     pointing at a closed vault).
 *
 * Must be called inside `app.whenReady().then(...)` AFTER
 * `protocol.registerSchemesAsPrivileged` has run at module scope (see main.ts).
 */
export function registerFiloProtocol(): void {
  protocol.handle('filo', async (request: Request) => {
    try {
      const url = new URL(request.url);

      if (url.host !== 'media') {
        return new Response('Not found', { status: 404 });
      }

      const vaultRoot = getVaultRoot();
      if (!vaultRoot) {
        return new Response('Vault not open', { status: 404 });
      }

      const relPath = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
      if (!relPath) {
        return new Response('Empty path', { status: 400 });
      }

      let absPath: string;
      try {
        // Structural + `.filo/` carve-out + containment guards.
        // A rejection is a deliberate refusal (forbidden path / malformed
        // input), not a server fault, so map it to 403 rather than letting
        // the outer catch report a generic 500.
        absPath = resolveServableMediaPath(vaultRoot, relPath);
      } catch {
        return new Response('Forbidden', { status: 403 });
      }

      // A missing file is a broken tile, not a server fault: answer 404 like
      // the other "not there" cases, without an error log on every load.
      const stat = await fs.promises.stat(absPath).catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
        throw err;
      });
      if (!stat) {
        return new Response('Not found', { status: 404 });
      }
      if (!stat.isFile()) {
        return new Response('Not a file', { status: 404 });
      }

      const mimeType = getMimeType(absPath);
      const totalSize = stat.size;
      const range = parseRangeHeader(request.headers.get('Range'), totalSize);

      // Defence-in-depth headers on every response. SVG
      // documents can carry `<script>`, foreignObject HTML, and external
      // references; when loaded via `<img>` or CSS `background-image`
      // (the only legitimate consumers in this app) scripting is already
      // disabled by the browser, but a renderer-side bug — or a stray
      // top-level navigation to `filo://media/evil.svg` — would otherwise
      // get full script execution. `Content-Disposition: attachment`
      // forces SVG into the download path instead of inline rendering;
      // `X-Content-Type-Options: nosniff` keeps browsers from re-typing
      // unknown bytes as HTML; the strict CSP applies on top.
      const isSvg = mimeType === 'image/svg+xml';
      const securityHeaders: Record<string, string> = {
        'X-Content-Type-Options': 'nosniff',
      };
      if (isSvg) {
        const filename = path.basename(absPath).replace(/"/g, '');
        securityHeaders['Content-Disposition'] = `attachment; filename="${filename}"`;
        securityHeaders['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
      }

      if (range === 'invalid') {
        return new Response('Range Not Satisfiable', {
          status: 416,
          headers: {
            'Content-Range': `bytes */${totalSize}`,
            'Accept-Ranges': 'bytes',
            ...securityHeaders,
          },
        });
      }

      if (range) {
        const { start, end } = range;
        const chunkStream = fs.createReadStream(absPath, { start, end });
        const webStream = Readable.toWeb(chunkStream) as ReadableStream<Uint8Array>;
        return new Response(webStream, {
          status: 206,
          headers: {
            'Content-Type': mimeType,
            'Content-Length': String(end - start + 1),
            'Content-Range': `bytes ${start}-${end}/${totalSize}`,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-cache',
            ...securityHeaders,
          },
        });
      }

      const fullStream = fs.createReadStream(absPath);
      const webStream = Readable.toWeb(fullStream) as ReadableStream<Uint8Array>;
      return new Response(webStream, {
        status: 200,
        headers: {
          'Content-Type': mimeType,
          'Content-Length': String(totalSize),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-cache',
          ...securityHeaders,
        },
      });
    } catch (err) {
      logMainError(`filoMedia.serve ${request.url}`, err);
      return new Response('Server error', { status: 500 });
    }
  });
}


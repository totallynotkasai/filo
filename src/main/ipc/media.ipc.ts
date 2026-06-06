import { app, ipcMain, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as dns from 'dns';
import { promisify } from 'util';
import { assertNotInFiloDir, assertSafeFilename, assertSafeRelativePath, assertWithinVault, isPrivateUrl } from '../utils/pathSecurity';
import { assertActiveVault } from '../utils/activeVaultCheck';
import { getMimeType } from '../utils/mime';
import { logMainError } from '../utils/mainLogger';
import { toPosix, relativePosix } from '../utils/pathHelpers';
import { getVaultRoot, getActiveWatcher } from './vault.ipc';
import { assertPayloadByteSize, PAYLOAD_LIMITS } from '../utils/payloadLimits';
import { atomicWriteFile } from '../vault/filenameUtils';
import { launcherExtension } from '../../shared/untrusted';

/**
 * Phase 31 A5.3 — DNS-based SSRF defence. Resolves a hostname to every A/AAAA
 * record and refuses if any resolution lands in a private range. Catches the
 * DNS-rebinding pattern where the same hostname resolves public at validation
 * time and private at fetch time.
 */
const dnsLookupAll = promisify(dns.lookup) as (
  hostname: string,
  options: { all: true },
) => Promise<Array<{ address: string; family: number }>>;

async function isHostnamePrivate(hostname: string): Promise<boolean> {
  // First strip brackets if present (already done inside isPrivateUrl, but
  // belt-and-braces here since we call dns directly).
  const bare = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  // 3.1 — static check first. Catches IP literals (incl. the IPv4-mapped /
  // NAT64 IPv6 hex forms and numeric-encoded IPv4 that `isPrivateUrl` now
  // decodes) before we even hit DNS, and covers the DNS-failure path below.
  // Re-bracket IPv6 literals so `new URL` inside `isPrivateUrl` parses them
  // — the old `http://${normalised}/` fallback fed a bracketless IPv6 to the
  // URL parser, which threw and only fail-closed by accident.
  const staticUrl = bare.includes(':') ? `http://[${bare}]/` : `http://${bare}/`;
  if (isPrivateUrl(staticUrl)) return true;
  try {
    const addrs = await dnsLookupAll(bare, { all: true });
    if (addrs.length === 0) return false;
    for (const { address, family } of addrs) {
      const scheme = family === 6 ? `http://[${address}]/` : `http://${address}/`;
      if (isPrivateUrl(scheme)) return true;
    }
    return false;
  } catch {
    // DNS failure — the static check above already classified any literal /
    // numeric form; an unresolvable name can't be probed further (the fetch
    // will fail too), so treat it as non-private.
    return false;
  }
}

/**
 * Phase 31 A5.3 — cap link-metadata response size at 512 KB. Anything
 * larger almost certainly isn't HTML metadata; abort the stream so a
 * giant binary response can't OOM the main process.
 */
const LINK_METADATA_MAX_BYTES = 512 * 1024;

/**
 * Phase 37 / 37.8 — extract a charset label from a Content-Type header
 * (e.g. `text/html; charset=shift_jis`). Strips optional surrounding
 * quotes, lowercases, and probes `TextDecoder` to confirm the label is
 * supported by the runtime — unsupported encodings fall back to UTF-8
 * so an obscure charset doesn't crash the link-preview pipeline.
 */
export function detectCharsetFromContentType(contentType: string): string {
  const match = /charset\s*=\s*["']?([^;"']+)/i.exec(contentType);
  if (!match) return 'utf-8';
  const label = match[1].trim().toLowerCase();
  if (!label) return 'utf-8';
  try {
    new TextDecoder(label);
    return label;
  } catch {
    return 'utf-8';
  }
}

/**
 * Registers IPC handlers for media operations:
 * - Saving audio recordings as MP3
 * - Reading media files from vault
 * - Opening files/URLs externally
 */
export function registerMediaHandlers(): void {
  /**
   * Saves audio data (base64) to the vault. `destFolder` is a vault-relative
   * folder path (use `''` or omit for the vault root). Returns the relative
   * vault path of the written file.
   */
  ipcMain.handle('media:save-audio', async (_event, vaultPath: string, audioData: string, fileName: string, destFolder?: string) => {
    try {
      // Phase 25 L5 — gate on the active vault so a buggy renderer can't
      // direct the write into a stale or wrong vault root after a vault
      // swap. Mirrors `vault:write-file-text` / `media:read-file`.
      assertActiveVault(vaultPath);
      // 6.3.P1/P2 — `media:save-audio` writes a NEW recording into the
      // vault; creation rules apply on every platform so the saved
      // filename + destination subfolder stay portable.
      assertSafeFilename(fileName, { forCreation: true });
      // Phase 21 / M5 — cap base64 input by its decoded byte length. The
      // base64 alphabet expands 3 bytes to 4 chars, so a 100 MB cap on the
      // decoded buffer corresponds to ~133 MB of base64 string; checking
      // post-decode is the load-bearing measurement.
      const buffer = Buffer.from(audioData, 'base64');
      assertPayloadByteSize(buffer.length, PAYLOAD_LIMITS.AUDIO, 'media:save-audio');
      const normalisedFolder = toPosix(destFolder ?? '')
        .replace(/^\/+/, '')
        .replace(/\/+$/, '');

      // Phase 37 / 37.5 — segment-level validation. `assertWithinVault`
      // catches absolute escapes and `..`-traversal, but a per-segment
      // Windows-reserved name (e.g. `attachments/CON/audio.wav`) sneaks
      // past it because the resolved path is still inside the vault.
      // Run `assertSafeRelativePath` on the folder so each segment also
      // has to clear `assertSafeFilename`.
      //
      // 6.3.P1/P2 — `forCreation: true` because mkdir-p creates the
      // destination subfolder if it doesn't exist; keep the new folder
      // path portable across platforms.
      if (normalisedFolder) assertSafeRelativePath(normalisedFolder, { forCreation: true });

      // 1.4 — refuse writes into `.filo/` like every other vault-writing channel.
      // `media:save-audio` was the sole vault writer missing this guard; a buggy
      // renderer passing `destFolder: '.filo'` could otherwise drop arbitrary
      // bytes into the config dir. Guard the prospective relative destination
      // (folder + filename) BEFORE mkdir, mirroring `vault:write-file-binary`.
      assertNotInFiloDir(normalisedFolder ? `${normalisedFolder}/${fileName}` : fileName);

      const mediaDir = normalisedFolder
        ? path.join(vaultPath, normalisedFolder)
        : vaultPath;
      await fs.promises.mkdir(mediaDir, { recursive: true });

      const filePath = path.join(mediaDir, fileName);
      assertWithinVault(vaultPath, filePath);
      const relPath = relativePosix(vaultPath, filePath);
      // Phase 19 S3 — bracket the write with watcher suppression so the
      // create event doesn't echo into `vault:tree-updated` and force a
      // full sidebar refresh while the renderer is still wiring up the
      // new audio tile.
      const watcher = getActiveWatcher();
      watcher?.suppress(relPath, 2000);
      // Phase 31 B1.1 — atomicWriteFile gives the audio write the same
      // crash-safety contract as text/board writes: a power loss mid-write
      // leaves the destination either fully old (here: missing) or fully
      // new, never a half-written WAV the user can't play.
      await atomicWriteFile(filePath, buffer);
      watcher?.suppress(relPath, 1000);

      return {
        success: true,
        path: relPath,
      };
    } catch (err) {
      logMainError('media:save-audio', err);
      return { success: false, error: String(err) };
    }
  });

  /**
   * Reads a media file from the vault and returns it as base64.
   *
   * Phase 21 / M2 — the renderer now passes the explicit `vaultRoot` so
   * we can `assertActiveVault` (a buggy renderer can't trick the handler
   * into reading from a stale vault root after a vault swap), and the
   * path is a vault-relative path validated via `assertSafeRelativePath`
   * before being joined onto the vault root — mirroring the contract
   * `vault:write-file-text` already enforces.
   *
   * Fails closed when no vault is open. Without a vault root we have no
   * reference point to enforce containment, so we cannot safely service
   * arbitrary-absolute-path reads issued during the no-vault startup window.
   *
   * SVG note: data returned here is base64-encoded for use as a data URL
   * inside `<img>` or CSS `background-image` — both of which disable
   * scripting inside SVG documents. Do NOT feed the result into
   * `<object>`, `<embed>`, or top-level navigation; for those, the
   * `filo://` protocol's `Content-Disposition: attachment` SVG path is
   * the defended route.
   */
  ipcMain.handle('media:read-file', async (_event, vaultRoot: string, relativePath: string) => {
    try {
      assertActiveVault(vaultRoot);
      assertSafeRelativePath(relativePath);
      const fullPath = path.join(vaultRoot, relativePath);
      assertWithinVault(vaultRoot, fullPath);
      const mimeType = getMimeType(fullPath);
      if (mimeType === 'application/octet-stream') {
        return { success: false, error: 'Unsupported file type' };
      }
      // Stat-check first so a multi-GB file (accidental drag-drop of a raw
      // 4K capture, etc.) is rejected up front rather than buffered into
      // a base64 string ~1.33× the on-disk size and shipped across IPC.
      // Without this gate the OOM happens deep in `readFile`+toString and
      // crashes the main process without a clean diagnostic.
      const stat = await fs.promises.stat(fullPath);
      // Sprint C / C20 — `media:read-file` uses the tighter
      // MEDIA_READ_INLINE cap (25 MB) rather than the legacy 200 MB
      // MEDIA cap, because the base64 payload is buffered in renderer
      // memory rather than streamed.
      if (stat.size > PAYLOAD_LIMITS.MEDIA_READ_INLINE) {
        return {
          success: false,
          code: 'FILE_TOO_LARGE',
          error: `Media file is ${stat.size} bytes; media:read-file cap is ${PAYLOAD_LIMITS.MEDIA_READ_INLINE} bytes`,
        };
      }
      const buffer = await fs.promises.readFile(fullPath);
      return {
        success: true,
        data: buffer.toString('base64'),
        mimeType,
      };
    } catch (err) {
      logMainError('media:read-file', err);
      return { success: false, error: String(err) };
    }
  });

  /**
   * Opens a file or URL with the system's default application.
   * Only https:// URLs and vault-local paths are permitted.
   *
   * Private / loopback addresses (localhost, RFC 1918 ranges, link-local,
   * IPv6 ULA/link-local, `::1`) are rejected to mirror `link:fetch-metadata`:
   * a renderer with a malicious or stale Link Tile cannot use this handler
   * to ask the OS shell to open `http://10.0.0.5/admin` against an
   * internal network device. The dev escape hatch — localhost / 127.* —
   * is allowed when `NODE_ENV !== 'production'` so the dev server links
   * still work.
   */
  ipcMain.handle('media:open-external', async (_event, target: string) => {
    try {
      // Phase 31 A5.6 — explicit scheme allowlist. Anything matching one of
      // these prefixes is treated as a URL; everything else falls through
      // to the vault-relative-path branch. Rejecting file:, javascript:,
      // data:, and UNC (`\\host\share`) here closes the residual gap where
      // a tile's stored URL could trick the OS shell into opening a local
      // file or running a script via the URL handler.
      // Sprint A / A5 — `tel:` joins `mailto:` as a launcher-style URL the
      // OS shell handles (Phone app on macOS, FaceTime, default SIP client
      // on Windows). Same SSRF-skip rationale as mailto: no hostname-bearing
      // URL component.
      const ALLOWED_URL_PREFIXES = ['https://', 'http://', 'mailto:', 'tel:'];
      const DISALLOWED_URL_PATTERNS = [
        /^file:/i,
        /^javascript:/i,
        /^data:/i,
        /^\\\\/, // Windows UNC path
        /^vbscript:/i,
      ];
      for (const pattern of DISALLOWED_URL_PATTERNS) {
        if (pattern.test(target)) {
          return { success: false, error: 'URL scheme not allowed' };
        }
      }
      const isAllowedUrl = ALLOWED_URL_PREFIXES.some((prefix) => target.startsWith(prefix));
      if (isAllowedUrl) {
        // mailto:/tel: don't have a hostname-bearing URL component for the
        // private-IP check; skip the SSRF gate for them. Match the http(s)
        // schemes explicitly rather than a loose `startsWith('http')` so a
        // future allowlisted scheme like `httpx:` can't slip past the gate.
        if (target.startsWith('http://') || target.startsWith('https://')) {
          if (isPrivateUrl(target)) {
            // Phase 37 / 37.7 — gate the dev-localhost allowance on
            // `app.isPackaged`. Electron packaged builds don't set
            // NODE_ENV=production by default, so the previous
            // `NODE_ENV !== 'production'` check leaked the localhost
            // allowance into shipped builds. `app.isPackaged` is the
            // canonical runtime signal and stays correct regardless of
            // how the binary was launched.
            const devOK =
              !app.isPackaged &&
              /^(https?:\/\/)?(localhost|127\.)/i.test(target);
            if (!devOK) {
              return { success: false, error: 'URL not allowed' };
            }
          }
        }
        await shell.openExternal(target);
      } else {
        // Local path — must be inside the vault. Without a vault root we
        // have no containment reference, so we fail closed rather than
        // pass arbitrary paths to the OS shell. Strings carrying a scheme
        // we DIDN'T allowlist also land here; assertWithinVault refuses
        // them because `file:///etc/passwd` is not under the vault.
        const vaultRoot = getVaultRoot();
        if (!vaultRoot) {
          return { success: false, error: 'No vault open' };
        }
        assertWithinVault(vaultRoot, target);
        // Sprint A / A2 — even when the target is inside the vault, refuse
        // to hand executable extensions to `shell.openPath`. A vault file
        // named `notes.exe` (or worse, `report.pdf.exe` masquerading as a
        // PDF) would otherwise run with the user's privileges. Match the
        // file's TRUE final extension case-insensitively against a
        // blocklist of OS launcher / scripting formats.
        //
        // Audit-10 B3 — extension extraction must use `launcherExtension`,
        // NOT `path.extname`: on Win32 a trailing dot / space (`evil.exe.`)
        // is stripped by the path layer before launch, and an NTFS ADS
        // suffix (`evil.exe::$DATA`) names the real `evil.exe`; both make
        // `path.extname` read a non-blocklisted `'.'` / `'.exe::$DATA'`,
        // so `shell.openPath` would run the executable. `assertWithinVault`
        // realpaths past those (they resolve to the in-vault file) and this
        // channel does NOT run `assertSafeFilename`, so the blocklist here
        // is the only line of defence.
        //
        // Phase 5 / P1-10 — extend with HTML-renderable extensions
        // (.html / .htm / .xhtml / .svg / .shtml / .xml). The user's
        // browser opens these directly and runs whatever JS they carry
        // from a trusted-origin frame, exfiltrating other vault contents
        // via same-origin. The filo:// protocol's `Content-Disposition:
        // attachment` chain neutralises SVG inside the app, but
        // `shell.openPath('foo.svg')` hands it to the OS browser without
        // that header chain.
        const UNSAFE_FILE_EXTENSIONS = new Set([
          // OS executables / scripting
          '.exe', '.bat', '.cmd', '.com', '.scr', '.ps1', '.vbs', '.hta',
          '.msi', '.jar', '.lnk', '.appref-ms', '.app', '.bin', '.sh', '.msc',
          // HTML-renderable — Phase 5 / P1-10
          '.html', '.htm', '.xhtml', '.svg', '.shtml', '.xml',
        ]);
        // Audit-10 B3 (defence in depth) — refuse a basename Win32 would
        // normalise into a DIFFERENT file than the one we validated: a
        // trailing dot/space is silently stripped, and an embedded `:`
        // opens an NTFS Alternate Data Stream (`report.pdf:evil`, whose
        // safe-looking `.pdf` extension would otherwise pass). The basename
        // is the segment after the last separator, so a drive-letter colon
        // (`C:/…`) is never in scope here.
        const lastSep = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\'));
        const targetBasename = lastSep >= 0 ? target.slice(lastSep + 1) : target;
        if (/[ .]$/.test(targetBasename) || targetBasename.includes(':')) {
          return {
            success: false,
            error: 'Refusing to open file: unsafe filename (trailing dot/space or alternate data stream)',
          };
        }
        const ext = launcherExtension(target);
        if (UNSAFE_FILE_EXTENSIONS.has(ext)) {
          return {
            success: false,
            error: `Refusing to open file: ${ext} extension not allowed`,
          };
        }
        await shell.openPath(target);
      }
      return { success: true };
    } catch (err) {
      logMainError('media:open-external', err);
      return { success: false, error: String(err) };
    }
  });
  /**
   * Fetches metadata (title, description, image, favicon) from a URL.
   * Runs in main process to avoid CORS restrictions.
   *
   * Phase 21 / M3 — SSRF protection on redirects. `fetch`'s default
   * `redirect: 'follow'` chases 30x responses through Node's HTTP stack
   * without giving us a chance to re-check the destination. A public
   * URL that 302s to `http://169.254.169.254/latest/meta-data/` (AWS
   * instance metadata) would silently land on the internal target. We
   * walk redirects manually with `redirect: 'manual'`, re-running
   * `isPrivateUrl` on every `Location:` header before refetching, and
   * cap the chain at 5 hops.
   */
  ipcMain.handle('link:fetch-metadata', async (_event, url: string) => {
    try {
      // Phase 5 — explicit scheme allowlist at entry. `isPrivateUrl`
      // catches RFC-1918 hostnames but accepts `javascript:` / `data:`
      // because they have no hostname to match. `fetch()` would then
      // throw — we'd hit the generic catch and lose the diagnostic.
      // Front-loading the scheme check returns a clear error and keeps
      // the SSRF + redirect walks scoped to the only schemes that can
      // meaningfully carry HTML metadata.
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return { success: false, error: 'Malformed URL' };
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { success: false, error: 'Only http(s) URLs are allowed for link metadata' };
      }
      if (isPrivateUrl(url)) {
        return { success: false, error: 'URL not allowed' };
      }
      // Phase 31 A5.3 — DNS-resolve the initial hostname and reject if
      // any address falls in a private range. Catches the rebinding
      // pattern (public-then-private resolution) and the URL-encoded
      // numeric forms missed by isPrivateUrl's static string check.
      {
        const initial = new URL(url);
        if (await isHostnamePrivate(initial.hostname)) {
          return { success: false, error: 'URL not allowed (resolves to private address)' };
        }
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      const MAX_REDIRECTS = 5;
      let currentUrl = url;
      let response: Response | null = null;
      try {
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
          const hopResponse = await fetch(currentUrl, {
            signal: controller.signal,
            headers: { 'User-Agent': 'Filo/1.0' },
            redirect: 'manual',
          });
          // 30x with a Location header — re-validate the target before refetching.
          if (hopResponse.status >= 300 && hopResponse.status < 400) {
            const location = hopResponse.headers.get('location');
            if (!location) {
              response = hopResponse;
              break;
            }
            const next = new URL(location, currentUrl).toString();
            if (isPrivateUrl(next)) {
              clearTimeout(timeout);
              return { success: false, error: 'URL not allowed (redirect to private target)' };
            }
            // Phase 31 A5.3 — DNS-resolve every redirect target too,
            // so a public-then-private rebinding attack via redirect
            // chain is still caught.
            const nextUrl = new URL(next);
            if (await isHostnamePrivate(nextUrl.hostname)) {
              clearTimeout(timeout);
              return { success: false, error: 'URL not allowed (redirect resolves to private)' };
            }
            if (hop === MAX_REDIRECTS) {
              clearTimeout(timeout);
              return { success: false, error: 'Too many redirects' };
            }
            currentUrl = next;
            continue;
          }
          response = hopResponse;
          break;
        }
      } finally {
        clearTimeout(timeout);
      }

      if (!response) {
        return { success: false, error: 'No response' };
      }
      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}` };
      }

      // Phase 31 A5.3 — refuse non-HTML responses. Link-metadata extraction
      // is meaningful only for HTML pages; anything else is wasted bytes
      // and may pin a multi-GB binary into memory before we realise.
      const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
      const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml+xml') || contentType === '';
      if (!isHtml) {
        return { success: false, error: `Unsupported content-type: ${contentType}` };
      }

      // Phase 37 / 37.8 — honour the `charset=` parameter on the
      // Content-Type header. The previous unconditional `TextDecoder('utf-8')`
      // mojibake'd non-UTF-8 pages (Shift_JIS Japanese sites, Windows-1252
      // Western European pages, GBK Chinese sites). Falls back to UTF-8
      // when the header is missing, unparseable, or names an encoding
      // TextDecoder doesn't recognise.
      const charset = detectCharsetFromContentType(contentType);

      // Phase 31 A5.3 — stream-read with a 512 KB cap. `response.text()`
      // buffers the whole body unbounded; iterating the reader lets us
      // abort once we hit the cap.
      let html = '';
      if (response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder(charset);
        let total = 0;
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > LINK_METADATA_MAX_BYTES) {
              try { await reader.cancel(); } catch { /* ignore */ }
              return { success: false, error: 'Response exceeded 512 KB cap' };
            }
            html += decoder.decode(value, { stream: true });
          }
          html += decoder.decode();
        } catch (streamErr) {
          try { await reader.cancel(); } catch { /* ignore */ }
          throw streamErr;
        }
      } else {
        html = await response.text();
        if (html.length > LINK_METADATA_MAX_BYTES) {
          return { success: false, error: 'Response exceeded 512 KB cap' };
        }
      }

      // Sprint B / B22 — pre-extract the `<head>` section before running
      // the metadata regexes. The previous unbounded regex on a 512 KB
      // worst-case HTML was vulnerable to ReDoS via crafted meta-tag
      // sequences; bounding to `<head>` (capped at 64 KB defensively in
      // case a page declares a giant inline-script block inside head)
      // cuts the worst-case attack surface to ~10% of the original input
      // and matches where every real-world meta tag actually lives. If
      // there's no closing `</head>`, fall back to the first 64 KB of
      // body so the parser still finds metadata on malformed pages.
      const HEAD_SCAN_MAX_BYTES = 64 * 1024;
      const headEndIdx = html.search(/<\/head\s*>/i);
      const headSection = headEndIdx > 0
        ? html.slice(0, Math.min(headEndIdx, HEAD_SCAN_MAX_BYTES))
        : html.slice(0, HEAD_SCAN_MAX_BYTES);

      // Extract metadata from the bounded head section.
      const getMetaContent = (nameOrProp: string): string => {
        // Try property first (og:), then name
        const propMatch = headSection.match(new RegExp(`<meta[^>]+property=["']${nameOrProp}["'][^>]+content=["']([^"']*)["']`, 'i'))
          || headSection.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${nameOrProp}["']`, 'i'));
        if (propMatch) return propMatch[1];

        const nameMatch = headSection.match(new RegExp(`<meta[^>]+name=["']${nameOrProp}["'][^>]+content=["']([^"']*)["']`, 'i'))
          || headSection.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+name=["']${nameOrProp}["']`, 'i'));
        return nameMatch ? nameMatch[1] : '';
      };

      const titleMatch = headSection.match(/<title[^>]*>([^<]*)<\/title>/i);
      const title = getMetaContent('og:title') || (titleMatch ? titleMatch[1].trim() : '');
      const description = getMetaContent('og:description') || getMetaContent('description');
      const image = getMetaContent('og:image');

      // Build favicon URL against the final (post-redirect) origin so a
      // shortlink → publisher chain resolves to the publisher's favicon
      // instead of the shortlink service's.
      const parsedUrl = new URL(currentUrl);
      let favicon = '';
      const faviconMatch = headSection.match(/<link[^>]+rel=["'](?:shortcut )?icon["'][^>]+href=["']([^"']*)["']/i)
        || headSection.match(/<link[^>]+href=["']([^"']*)["'][^>]+rel=["'](?:shortcut )?icon["']/i);
      if (faviconMatch) {
        favicon = faviconMatch[1].startsWith('http') ? faviconMatch[1] : `${parsedUrl.origin}${faviconMatch[1].startsWith('/') ? '' : '/'}${faviconMatch[1]}`;
      } else {
        favicon = `${parsedUrl.origin}/favicon.ico`;
      }

      return {
        success: true,
        title,
        description,
        image,
        favicon,
        domain: parsedUrl.hostname,
      };
    } catch (err) {
      logMainError('link:fetch-metadata', err);
      return { success: false, error: String(err) };
    }
  });
}


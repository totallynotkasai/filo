import { app, ipcMain, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as dns from 'dns';
import { promisify } from 'util';
import { assertNotInFiloDir, assertSafeFilename, assertSafeRelativePath, assertWithinVault, isPrivateUrl, vaultRelativeWithin } from '../utils/pathSecurity';
import { assertActiveVault } from '../utils/activeVaultCheck';
import { getMimeType } from '../utils/mime';
import { logMainError } from '../utils/mainLogger';
import { toPosix } from '../../shared/pathUtils';
import { getVaultRoot, getActiveWatcher } from './vault.ipc';
import { assertPayloadByteSize, PAYLOAD_LIMITS } from '../utils/payloadLimits';
import { LOCK_AWARE_SUPPRESS_MS } from '../vault/filenameUtils';
import { createExclusiveFile } from '../vault/exclusiveCreate';
import { errorResult } from './ipcErrorCode';
import { isOpenPathAllowed, launcherExtension } from '../../shared/untrusted';
import { getPublic, PrivateAddressError, RedirectRefusedError } from '../services/publicHttp';

/**
 * Resolves a hostname to every A/AAAA record and says whether any lands in a
 * private range. For `media:open-external` only: the OS browser resolves the
 * name again on its own, so this is a best-effort refusal of a name that
 * points at the user's network now; a name that changes its answer between
 * the two lookups isn't caught here. Filo's own fetch checks the address it
 * connects to instead (`services/publicHttp.ts`).
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
  // Static check first. Catches IP literals (incl. IPv4-mapped / NAT64 IPv6
  // hex forms and numeric-encoded IPv4) before DNS, and covers the
  // DNS-failure path below. IPv6 literals are re-bracketed so `new URL`
  // inside `isPrivateUrl` can parse them.
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
 * Cap link-metadata response size at 512 KB. Anything
 * larger almost certainly isn't HTML metadata; abort the stream so a
 * giant binary response can't OOM the main process.
 */
const LINK_METADATA_MAX_BYTES = 512 * 1024;

/**
 * Extract a charset label from a Content-Type header
 * (e.g. `text/html; charset=shift_jis`). Strips optional surrounding
 * quotes, lowercases, and probes `TextDecoder` to confirm the label is
 * supported by the runtime — unsupported encodings fall back to UTF-8
 * so an obscure charset doesn't crash the link-preview pipeline.
 */
export function detectCharsetFromContentType(contentType: string): string {
  const match = /charset\s*=\s*["']?([^;"']+)/i.exec(contentType);
  if (!match) return 'utf-8';
  const label = (match[1] ?? '').trim().toLowerCase();
  if (!label) return 'utf-8';
  try {
    new TextDecoder(label);
    return label;
  } catch {
    return 'utf-8';
  }
}

/**
 * Defence-in-depth sanitiser for the `image` / `favicon` URLs
 * `link:fetch-metadata` hands back to the renderer. Both come from
 * attacker-controllable markup, so a hostile page could aim them at an
 * internal address. The renderer CSP blocks remote http(s) loads today, but
 * if that widens or a main-side fetch is added, an un-validated URL becomes
 * an SSRF vector. Resolve against the (already SSRF-validated) final page
 * URL, then:
 *
 *   - empty / unparseable → ''   (no resource)
 *   - data: URL           → kept (CSP permits it; no network fetch → no SSRF)
 *   - http(s)             → kept only if `isPrivateUrl` says public; a
 *                           private / loopback / link-local host → ''
 *   - any other scheme    → ''   (javascript:, file:, blob:, …)
 *
 * Static `isPrivateUrl` (no DNS) is proportionate because these resources are
 * never fetched main-side; if that ever changes, fetch them through
 * `getPublic` (`services/publicHttp.ts`), which checks the address it
 * connects to.
 */
export function sanitizeReturnedResourceUrl(raw: string, baseUrl: string): string {
  if (!raw) return '';
  let resolved: URL;
  try {
    resolved = new URL(raw, baseUrl);
  } catch {
    return '';
  }
  if (resolved.protocol === 'data:') return resolved.href;
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return '';
  if (isPrivateUrl(resolved.href)) return '';
  return resolved.href;
}

/**
 * Registers IPC handlers for media operations:
 * - Saving audio recordings as MP3
 * - Reading media files from vault
 * - Opening files/URLs externally
 */
/** How many ` (n)` names a recording tries before giving up. */
const MAX_RECORDING_NAME_TRIES = 100;

export function registerMediaHandlers(): void {
  /**
   * Saves audio data (base64) to the vault. `destFolder` is a vault-relative
   * folder path (use `''` or omit for the vault root). Returns the relative
   * vault path of the written file.
   */
  ipcMain.handle('media:save-audio', async (_event, vaultPath: string, audioData: string, fileName: string, destFolder?: string) => {
    try {
      // Gate on the active vault so a stale renderer can't write into the
      // wrong vault root after a swap.
      assertActiveVault(vaultPath);
      // Writes a NEW recording; creation rules apply on every platform so
      // the saved filename + destination subfolder stay portable.
      assertSafeFilename(fileName, { forCreation: true });
      // Cap by the DECODED byte length (base64 expands 3 bytes to 4 chars).
      const buffer = Buffer.from(audioData, 'base64');
      assertPayloadByteSize(buffer.length, PAYLOAD_LIMITS.AUDIO, 'media:save-audio');
      const normalisedFolder = toPosix(destFolder ?? '')
        .replace(/^\/+/, '')
        .replace(/\/+$/, '');

      // Segment-level validation: `assertWithinVault` misses a per-segment
      // Windows-reserved name (e.g. `attachments/CON/audio.wav`) because the
      // resolved path is still inside the vault. `forCreation: true` because
      // mkdir-p may create the subfolder.
      if (normalisedFolder) assertSafeRelativePath(normalisedFolder, { forCreation: true });

      // Refuse writes into `.filo/` like every other vault-writing channel;
      // guard the prospective destination (folder + filename) BEFORE mkdir.
      assertNotInFiloDir(vaultPath, normalisedFolder ? `${normalisedFolder}/${fileName}` : fileName);

      const mediaDir = normalisedFolder
        ? path.join(vaultPath, normalisedFolder)
        : vaultPath;
      await fs.promises.mkdir(mediaDir, { recursive: true });

      // The name is unique only to the second, so two takes saved in the same
      // second (or a file already there) would share it. The recording is
      // created exclusively, never over an existing file, and a taken name
      // moves on to ` (2)`, ` (3)`… The bytes land atomically over the
      // reserved name, so a power loss never leaves a half-written recording.
      const dot = fileName.lastIndexOf('.');
      const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
      const ext = dot > 0 ? fileName.slice(dot) : '';
      const watcher = getActiveWatcher();
      for (let n = 1; n <= MAX_RECORDING_NAME_TRIES; n++) {
        const candidate = n === 1 ? fileName : `${stem} (${n})${ext}`;
        const filePath = path.join(mediaDir, candidate);
        const relPath = vaultRelativeWithin(vaultPath, filePath);
        // Bracket the write with watcher suppression so the create event
        // doesn't force a full sidebar refresh while the renderer is still
        // wiring up the new audio tile.
        watcher?.suppress(relPath, LOCK_AWARE_SUPPRESS_MS);
        try {
          await createExclusiveFile(filePath, buffer);
        } catch (err) {
          if ((err as NodeJS.ErrnoException | null)?.code === 'EEXIST') continue;
          throw err;
        }
        watcher?.suppress(relPath, 1000);
        return { success: true, path: relPath };
      }
      const taken: NodeJS.ErrnoException = new Error(`Every name for "${fileName}" is taken`);
      taken.code = 'EEXIST';
      throw taken;
    } catch (err) {
      logMainError('media:save-audio', err);
      return errorResult(err);
    }
  });

  /**
   * Reads a media file from the vault and returns it as base64.
   *
   * `vaultRoot` is `assertActiveVault`-gated and the vault-relative path is
   * validated before joining. Fails closed when no vault is open.
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
      // Refuse reads into `.filo/`. The MIME allowlist below happens to
      // refuse today's `.filo/` files, but this channel must enforce its OWN
      // containment rather than lean on that.
      assertNotInFiloDir(vaultRoot, relativePath);
      const fullPath = path.join(vaultRoot, relativePath);
      assertWithinVault(vaultRoot, fullPath);
      const mimeType = getMimeType(fullPath);
      if (mimeType === 'application/octet-stream') {
        return { success: false, error: 'Unsupported file type' };
      }
      // Stat-check first so a multi-GB file (accidental drag-drop of a raw
      // 4K capture, etc.) is rejected up front rather than buffered into
      // a base64 string ~1.33× the on-disk size and shipped across IPC.
      const stat = await fs.promises.stat(fullPath);
      // The tighter MEDIA_READ_INLINE cap (25 MB), not MEDIA, because the
      // base64 payload is buffered in renderer memory rather than streamed.
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
      // Explicit scheme allowlist. Anything matching one of these prefixes
      // is treated as a URL; everything else falls through to the
      // vault-relative-path branch. Rejecting file:, javascript:, data:, and
      // UNC (`\\host\share`) stops a stored URL from making the OS shell open
      // a local file or run a script. `http://` is deliberately excluded
      // (cleartext downgrade / SSRF surface); legacy http links are handled
      // explicitly below.
      const ALLOWED_URL_PREFIXES = ['https://', 'mailto:', 'tel:'];
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
      // Legacy `http://` URLs: log and refuse rather than silently opening
      // cleartext (or falling through to a confusing "outside vault" error).
      if (/^http:\/\//i.test(target)) {
        logMainError(
          'media:open-external',
          new Error(`Refusing to open insecure http:// URL: ${target}`),
        );
        return { success: false, error: 'Insecure http:// links are no longer opened — use https://' };
      }
      // Compare the scheme case-insensitively so `HTTPS://…` / `Mailto:`
      // links aren't refused. Only the comparisons use the lowercased copy;
      // the ORIGINAL `target` is what we hand to the OS.
      const lowerTarget = target.toLowerCase();
      const isAllowedUrl = ALLOWED_URL_PREFIXES.some((prefix) => lowerTarget.startsWith(prefix));
      if (isAllowedUrl) {
        // mailto:/tel: don't have a hostname-bearing URL component for the
        // private-IP check; skip the SSRF gate for them. Match the http(s)
        // schemes explicitly rather than a loose `startsWith('http')` so a
        // future allowlisted scheme like `httpx:` can't slip past the gate.
        if (lowerTarget.startsWith('http://') || lowerTarget.startsWith('https://')) {
          if (isPrivateUrl(target)) {
            // Gate the dev-localhost allowance on `app.isPackaged`, not
            // NODE_ENV: packaged builds don't set NODE_ENV=production by
            // default, so a NODE_ENV check would leak it into shipped builds.
            const devOK =
              !app.isPackaged &&
              /^(https?:\/\/)?(localhost|127\.)/i.test(target);
            if (!devOK) {
              return { success: false, error: 'URL not allowed' };
            }
          } else {
            // DNS-resolution SSRF check, as in `link:fetch-metadata`. The
            // static `isPrivateUrl` only catches IP-literal hosts; a
            // public-looking hostname that RESOLVES to a private range would
            // otherwise be handed to the OS browser, which can reach internal
            // network devices.
            let host: string;
            try {
              host = new URL(target).hostname;
            } catch {
              return { success: false, error: 'Malformed URL' };
            }
            if (await isHostnamePrivate(host)) {
              return { success: false, error: 'URL not allowed (resolves to private address)' };
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
        // Defence in depth: refuse a basename Win32 would
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
        // Also run the shared filename guard so a Windows reserved DOS name
        // (CON / NUL / LPT1 / CONIN$ …) can't be opened as a device handle.
        // Its rules are win32-gated by default, so a POSIX `CON.md` stays
        // openable; the manual check above applies on every platform.
        try {
          assertSafeFilename(targetBasename);
        } catch {
          return {
            success: false,
            error: 'Refusing to open file: unsafe filename (Windows reserved name or illegal character)',
          };
        }
        // Only allowlisted document/media types reach the OS shell. Uses
        // `launcherExtension` (via isOpenPathAllowed), not `path.extname`,
        // so the checked extension is the one the shell launches.
        if (!isOpenPathAllowed(target)) {
          const ext = launcherExtension(target) || '(no extension)';
          return {
            success: false,
            code: 'EXTENSION_NOT_ALLOWED',
            error: `Refusing to open file: ${ext} is not an allowed document/media type`,
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
   * Only public addresses are fetched, checked in the connection itself on
   * every hop (`getPublic` in `services/publicHttp.ts`): a name that answers
   * a public address to a check and a private one to the connection can't
   * reach the user's own network. Redirects are followed by hand, at most 5.
   */
  ipcMain.handle('link:fetch-metadata', async (_event, url: string) => {
    try {
      // Explicit scheme allowlist at entry: `isPrivateUrl` accepts
      // hostname-less schemes like `javascript:` / `data:`, and only http(s)
      // can meaningfully carry HTML metadata.
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

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      let currentUrl: string;
      let html: string;
      try {
        const response = await getPublic(url, {
          signal: controller.signal,
          maxRedirects: 5,
          headers: { 'User-Agent': 'Filo/1.0' },
        });
        currentUrl = response.url;
        if (response.status < 200 || response.status >= 300) {
          response.discard();
          return { success: false, error: `HTTP ${response.status}` };
        }
        // Refuse non-HTML responses. Link-metadata extraction is meaningful
        // only for HTML pages; anything else is wasted bytes.
        const contentType = response.contentType.toLowerCase();
        const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml+xml') || contentType === '';
        if (!isHtml) {
          response.discard();
          return { success: false, error: `Unsupported content-type: ${contentType}` };
        }
        // Read with a 512 KB cap, so a giant response can't fill memory.
        const body = await response.readBody(LINK_METADATA_MAX_BYTES);
        if (body === null) {
          return { success: false, error: 'Response exceeded 512 KB cap' };
        }
        // Honour the Content-Type `charset=` so non-UTF-8 pages (Shift_JIS,
        // Windows-1252, GBK) don't mojibake. Falls back to UTF-8.
        html = new TextDecoder(detectCharsetFromContentType(contentType)).decode(body);
      } catch (err) {
        if (err instanceof PrivateAddressError) {
          return { success: false, error: 'URL not allowed (resolves to private address)' };
        }
        if (err instanceof RedirectRefusedError) {
          return { success: false, error: err.message };
        }
        throw err;
      } finally {
        clearTimeout(timeout);
      }

      // Run the metadata regexes only over `<head>` (capped at 64 KB) to
      // bound ReDoS exposure from crafted meta-tag sequences; that's where
      // real meta tags live. With no `</head>`, scan the first 64 KB.
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
        if (propMatch) return propMatch[1] ?? '';

        const nameMatch = headSection.match(new RegExp(`<meta[^>]+name=["']${nameOrProp}["'][^>]+content=["']([^"']*)["']`, 'i'))
          || headSection.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+name=["']${nameOrProp}["']`, 'i'));
        return nameMatch?.[1] ?? '';
      };

      const titleMatch = headSection.match(/<title[^>]*>([^<]*)<\/title>/i);
      const title = getMetaContent('og:title') || (titleMatch?.[1] ?? '').trim();
      const description = getMetaContent('og:description') || getMetaContent('description');
      // Resolve `og:image` against the final page URL (it may
      // be relative / protocol-relative) and drop it if it points at a private
      // address or a non-displayable scheme before returning it to the renderer.
      const image = sanitizeReturnedResourceUrl(getMetaContent('og:image'), currentUrl);

      // Build favicon URL against the final (post-redirect) origin so a
      // shortlink → publisher chain resolves to the publisher's favicon
      // instead of the shortlink service's.
      const parsedUrl = new URL(currentUrl);
      let favicon = '';
      const faviconMatch = headSection.match(/<link[^>]+rel=["'](?:shortcut )?icon["'][^>]+href=["']([^"']*)["']/i)
        || headSection.match(/<link[^>]+href=["']([^"']*)["'][^>]+rel=["'](?:shortcut )?icon["']/i);
      if (faviconMatch) {
        const href = faviconMatch[1] ?? '';
        favicon = href.startsWith('http') ? href : `${parsedUrl.origin}${href.startsWith('/') ? '' : '/'}${href}`;
      } else {
        favicon = `${parsedUrl.origin}/favicon.ico`;
      }
      // Sanitise the resolved favicon (a page can declare an
      // absolute `<link rel=icon href="http://10.0.0.1/…">`) before returning it.
      favicon = sanitizeReturnedResourceUrl(favicon, currentUrl);

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


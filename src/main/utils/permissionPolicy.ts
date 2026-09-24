import type { Session } from 'electron';

/**
 * Deny-by-default permission policy with one narrow allowance.
 *
 * The app CSP intentionally allows arbitrary `https:` iframes (Iframe tiles let
 * the user embed any origin — see main.ts `installContentSecurityPolicy` /
 * KNOWN_LIMITATIONS #10). An embedded site can therefore issue browser
 * permission requests — geolocation, camera / microphone, notifications,
 * clipboard-read, MIDI, etc. Electron's built-in defaults for these are
 * version-dependent and can shift silently across upgrades, so every REQUEST
 * and every CHECK goes through `decidePermission`.
 *
 * The single allowed branch is microphone-only `media` for the app's own
 * document: the Audio tile records through `getUserMedia({ audio: true })`.
 * Iframe tiles live in the SAME webContents and session as the app (a plain
 * sandboxed `<iframe>`, no `<webview>`), so the webContents id alone can't tell
 * them apart. `isMainFrame` and the requesting URL can. Origin strings are
 * useless here: the packaged app is `file://` (serialized origin `"null"`) and
 * a sandboxed iframe without `allow-same-origin` is also `"null"`.
 *
 * Spellcheck does not route through this gate.
 */

export interface PermissionContext {
  /** The main window's webContents id; null before the window exists. */
  appWebContentsId: number | null;
  /**
   * The app document URL prefix: the dev server origin + `/`, or the packaged
   * `file://…/index.html` href. Never an origin — see the module docstring.
   */
  appUrlPrefix: string;
}

export interface PermissionInput {
  permission: string;
  isMainFrame: boolean;
  requestingUrl: string | undefined;
  webContentsId: number;
  /** Request handler: the media kinds asked for. */
  mediaTypes?: readonly string[];
  /** Check handler: the single media kind being checked. */
  mediaType?: string;
}

export function decidePermission(input: PermissionInput, ctx: PermissionContext): boolean {
  if (input.permission !== 'media') return false;
  if (input.isMainFrame !== true) return false;
  if (ctx.appWebContentsId === null || input.webContentsId !== ctx.appWebContentsId) return false;
  if (!ctx.appUrlPrefix || typeof input.requestingUrl !== 'string') return false;
  if (!input.requestingUrl.startsWith(ctx.appUrlPrefix)) return false;
  // A request carries `mediaTypes`; a check carries `mediaType`. Undefined on
  // either path means Chromium didn't say what it wants, so deny.
  if (input.mediaTypes !== undefined) {
    return input.mediaTypes.length > 0 && input.mediaTypes.every((t) => t === 'audio');
  }
  return input.mediaType === 'audio';
}

export function installPermissionHandlers(
  session: Session,
  getCtx: () => PermissionContext,
): void {
  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined;
    callback(
      decidePermission(
        {
          permission,
          isMainFrame: details.isMainFrame,
          requestingUrl: details.requestingUrl,
          webContentsId: webContents?.id ?? -1,
          // A request without media kinds is treated as an empty list (deny).
          mediaTypes: mediaTypes ?? [],
        },
        getCtx(),
      ),
    );
  });
  session.setPermissionCheckHandler((webContents, permission, _origin, details) =>
    decidePermission(
      {
        permission,
        isMainFrame: details.isMainFrame,
        requestingUrl: details.requestingUrl,
        webContentsId: webContents?.id ?? -1,
        mediaType: details.mediaType,
      },
      getCtx(),
    ),
  );
}

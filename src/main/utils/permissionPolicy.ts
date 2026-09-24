import type { Session } from 'electron';

/**
 * Deny-by-default permission policy (defense-in-depth).
 *
 * The app CSP intentionally allows arbitrary `https:` iframes (Iframe tiles let
 * the user embed any origin — see main.ts `installContentSecurityPolicy` /
 * KNOWN_LIMITATIONS #10). An embedded site can therefore issue browser
 * permission requests — geolocation, camera / microphone, notifications,
 * clipboard-read, MIDI, etc. Electron's built-in defaults for these are
 * version-dependent and can shift silently across upgrades.
 *
 * Filo itself needs none of these permissions (spellcheck does NOT route through
 * this gate), so refuse every permission REQUEST and every permission CHECK.
 * Installing the one standard Electron hardening control makes the stance
 * explicit and stable across upgrades, rather than relying on whatever the
 * current Chromium default happens to be plus the sandbox bound.
 *
 * If the app ever genuinely needs a permission, add a narrow allowlist branch
 * here (matched on `permission` + the requesting origin) so the default stays
 * closed.
 */
export function installPermissionHandlers(session: Session): void {
  session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.setPermissionCheckHandler(() => false);
}

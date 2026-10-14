import type { Input, WebContents } from 'electron';
import { loadPreferences, setDevToolsEnabled } from './recentVaults';
import { logMainError } from '../utils/mainLogger';

/**
 * Chromium's developer tools for the app window. The installed app keeps no
 * log, so its console (the full text of an error a toast only summarises) is
 * reachable only through them. They open only once the user turns them on in
 * Settings (General → Developer tools), a preference kept per machine in
 * `recent-vaults.json`, or in a dev run (`npm run dev`), which always may.
 */

let enabled = false;

/** Whether the user has turned the developer tools on (this machine). */
export function devToolsEnabled(): boolean {
  return enabled;
}

/** Reads the preference at startup, before the window takes any keys. */
export async function loadDevToolsPreference(): Promise<void> {
  try {
    enabled = (await loadPreferences()).devToolsEnabled;
  } catch (err) {
    logMainError('devTools.load', err);
    enabled = false;
  }
}

/**
 * Saves the preference. Turning it off also closes developer tools left open,
 * so Off means off at once. Rejects (and keeps the old value) when the file
 * can't be written.
 */
export async function setDevToolsPreference(
  on: boolean,
  contents: Pick<WebContents, 'isDestroyed' | 'isDevToolsOpened' | 'closeDevTools'> | null,
): Promise<void> {
  await setDevToolsEnabled(on);
  enabled = on;
  if (!on && contents && !contents.isDestroyed() && contents.isDevToolsOpened()) contents.closeDevTools();
}

/** Ctrl+Shift+I (Chromium's own) or F12, pressed: the keys that open or close them. */
export function isDevToolsShortcut(input: Pick<Input, 'type' | 'key' | 'control' | 'shift' | 'alt' | 'meta'>): boolean {
  if (input.type !== 'keyDown') return false;
  if (input.key === 'F12') return !input.control && !input.shift && !input.alt && !input.meta;
  return input.key.toLowerCase() === 'i' && input.control && input.shift && !input.alt && !input.meta;
}

/** Opens the developer tools in their own window, or closes them when open. */
export function toggleDevTools(contents: Pick<WebContents, 'isDevToolsOpened' | 'openDevTools' | 'closeDevTools'>): void {
  if (contents.isDevToolsOpened()) contents.closeDevTools();
  else contents.openDevTools({ mode: 'detach' });
}

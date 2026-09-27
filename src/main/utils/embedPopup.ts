/**
 * embedPopup — where a link that asks for a new window goes.
 *
 * Filo never opens a second window, so every `window.open` / `target=_blank`
 * is denied. The app's own links go through `media:open-external`; the ones
 * that end up here come from pages embedded in iframe tiles (a video's title,
 * a "read more" link), which would otherwise do nothing. Those open in the
 * default browser, on the same terms as `media:open-external`: a public
 * `https://` address only, and at most one a second, so an embedded page
 * can't flood the browser with tabs.
 *
 * Pure (the private-address check and the clock are passed in) so it can be
 * unit-tested without booting Electron.
 */

/** Minimum gap between two links opened this way. */
export const EMBED_POPUP_MIN_GAP_MS = 1000;

/**
 * The URL to hand to the default browser for a new-window request, or null
 * to drop it. `lastOpenedAt` is when the previous one was opened (0 for never).
 */
export function embedPopupTarget(
  url: string,
  now: number,
  lastOpenedAt: number,
  isPrivateUrl: (url: string) => boolean,
): string | null {
  if (now - lastOpenedAt < EMBED_POPUP_MIN_GAP_MS) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname) return null;
  if (parsed.username || parsed.password) return null;
  if (isPrivateUrl(parsed.href)) return null;
  return parsed.href;
}

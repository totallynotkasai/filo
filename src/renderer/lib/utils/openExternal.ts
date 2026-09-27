/**
 * Opening a web, mail or phone link in the OS: the one path every link click
 * takes (note links, link tiles, iframe tiles), so each says why when a link
 * can't be opened instead of doing nothing.
 *
 * Filo opens `https://`, `mailto:` and `tel:` only. An `http://` link is
 * refused (main refuses it too: cleartext), with an offer to open the
 * `https://` address instead, which most sites serve.
 */
import { asSafeOpenExternal } from '../../../shared/untrusted';
import { invokeOk } from './invokeOk';
import { uiStore } from '../../stores/ui.svelte';

const INSECURE_RE = /^http:\/\//i;

/** True for an `http://` address, which Filo doesn't open. */
export function isInsecureHttp(url: string): boolean {
  return INSECURE_RE.test(url.trim());
}

/** The same address over `https://`. */
export function httpsVersion(url: string): string {
  return url.trim().replace(INSECURE_RE, 'https://');
}

/** Opens `url` in the OS; a toast says why when it can't. */
export async function openExternalUrl(url: string): Promise<void> {
  if (isInsecureHttp(url)) {
    const secure = httpsVersion(url);
    uiStore.pushToast({
      text: `Filo opens only secure links, and ${url} uses http://.`,
      type: 'warning',
      actions: [{ label: 'Open with https://', handler: () => { void openExternalUrl(secure); } }],
    });
    return;
  }
  const safe = asSafeOpenExternal(url);
  if (!safe) {
    uiStore.toast(`This link can't be opened: ${url}`, 'warning', 4000);
    return;
  }
  try {
    await invokeOk('media:open-external', safe);
  } catch (err) {
    const reason = err instanceof Error && err.message ? ` (${err.message})` : '';
    uiStore.toast(`Couldn't open ${url}${reason}`, 'error', 5000);
  }
}

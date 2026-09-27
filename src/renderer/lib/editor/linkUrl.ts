import { isFiloLink } from '../../schema/link';
import { asSafeOpenExternal } from '../../../shared/untrusted';

/** Schemes a click hands to the OS: browser, mail client, dialler. */
const EXTERNAL_RE = /^(https?:\/\/|mailto:|tel:)/i;

/**
 * True when a click can open this href: a `filo://` link inside the app, or
 * https, http, mailto or tel through the OS. The one scheme list for both the
 * Insert Link popup and the click handler, so a link the popup accepts is
 * always one a click opens.
 */
export function isOpenable(href: string): boolean {
  return isFiloLink(href) || (EXTERNAL_RE.test(href) && asSafeOpenExternal(href) !== null);
}

/**
 * What the user typed into the Insert Link popup's URL field, made into an
 * href that can actually be opened. A bare domain (`example.com`,
 * `www.example.com/page`) gets `https://`, and a bare address (`a@b.com`)
 * gets `mailto:`. Without this a scheme-less href is saved as-is and the link
 * is dead. An `http://` address is saved as `https://`: Filo opens only
 * secure links (see `openExternalUrl`), and most sites serve both.
 *
 * Returns null when nothing openable can be made of it: an empty field, a
 * note file name (`Notes.md` looks like a domain, but it is a file; link a
 * note with a `filo://` link), text that is neither a domain nor has a
 * scheme, or a scheme a click wouldn't open (`ftp:`, `sms:`, `javascript:` …):
 * such a link would be saved but do nothing when clicked.
 */
export function normaliseLinkUrl(input: string): string | null {
  const href = candidateHref(input);
  return href !== null && isOpenable(href) ? href : null;
}

function candidateHref(input: string): string | null {
  const url = input.trim();
  if (!url || /\s/.test(url)) return null;
  if (isFiloLink(url)) return url;
  if (/^http:\/\//i.test(url)) return url.replace(/^http:/i, 'https:');
  if (url.startsWith('//')) return `https:${url}`;
  if (EMAIL_RE.test(url)) return `mailto:${url}`;
  if (DOMAIN_RE.test(url)) {
    const host = url.split(/[/?#:]/, 1)[0] ?? '';
    return NOTE_FILE_RE.test(host) ? null : `https://${url}`;
  }
  // After the domain test: `localhost:3000` would otherwise read as the
  // scheme "localhost".
  if (SCHEME_RE.test(url)) return url;
  return null;
}

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:./i;
const EMAIL_RE = /^[^\s@/:]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/i;
/** `host.tld`, `localhost` or an IPv4 address, then an optional port and path. */
const DOMAIN_RE =
  /^(?:(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}|localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d{1,5})?(?:[/?#].*)?$/i;
const NOTE_FILE_RE = /\.(?:md|markdown)$/i;

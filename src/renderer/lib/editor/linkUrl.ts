import { isFiloLink } from '../../schema/link';

/**
 * What the user typed into the Insert Link popup's URL field, made into an
 * href that can actually be opened. A bare domain (`example.com`,
 * `www.example.com/page`) gets `https://`, and a bare address (`a@b.com`)
 * gets `mailto:`. Without this a scheme-less href is saved as-is, and the click
 * handler only opens `https:`, `mailto:`, `tel:` and `filo:`, so the link is
 * dead.
 *
 * Returns null when nothing openable can be made of it: an empty field, a
 * note file name (`Notes.md` looks like a domain, but it is a file; link a
 * note with a `filo://` link), or text that is neither a domain nor has a
 * scheme. Schemes the editor refuses (`javascript:` …) come back unchanged;
 * the Link extension's validator turns them down.
 */
export function normaliseLinkUrl(input: string): string | null {
  const url = input.trim();
  if (!url || /\s/.test(url)) return null;
  if (isFiloLink(url)) return url;
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

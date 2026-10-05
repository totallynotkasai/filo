/**
 * What `shell:copy-text` puts on the clipboard. The renderer may not write
 * the clipboard itself (the permission policy denies every page, Filo's own
 * included), so main does, from checked text.
 *
 * With a label, the text must be one of Filo's own `filo://` links: it goes
 * on as the address and as a link reading the label (HTML that main builds,
 * so a note it is pasted into shows a named link).
 */

/** The longest text copied (a board's whole list of load problems fits). */
export const MAX_COPY_CHARS = 100_000;
const MAX_LINK_CHARS = 4_000;
const MAX_LABEL_CHARS = 500;

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function clipboardPayload(text: unknown, linkLabel?: unknown): { text: string; html?: string } | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_COPY_CHARS) return null;
  if (linkLabel === undefined) return { text };
  if (typeof linkLabel !== 'string' || linkLabel.length > MAX_LABEL_CHARS) return null;
  if (!text.startsWith('filo://') || text.length > MAX_LINK_CHARS || /\s/.test(text)) return null;
  return { text, html: `<a href="${escapeHtml(text)}">${escapeHtml(linkLabel.trim() || text)}</a>` };
}

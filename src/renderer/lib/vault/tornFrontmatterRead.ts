import { vaultIndexStore } from '../../stores/vaultIndex.svelte';

/**
 * Does a fresh read that parsed as having NO
 * frontmatter look like a TORN read of a file that HAS one? A non-atomic
 * external writer caught mid-write can return bytes that begin with an opening
 * `---` fence but whose CLOSING fence wasn't in the partial read, so
 * `parseMarkdownFile` reports `hasFrontmatter:false` and an assemble against it
 * would erase the real on-disk frontmatter. True when the vault index still
 * records a non-empty raw FM block for the path AND the raw bytes open with a
 * `---` fence. Consumed by the markdown gateway's delta branch and its
 * empty-cache seed re-read — both abort the write via `markPathFailed` + throw
 * so the next debounced write retries clean.
 *
 * Deliberately NO size/heuristic tightening: the fail-safe
 * body-starts-with-`---`-after-FM-removal false positive is accepted (see
 * KNOWN_LIMITATIONS #11); suppressing it would re-open a silent FM drop.
 */
export function freshReadLooksTornMidFrontmatter(relPath: string, rawContent: string): boolean {
  const priorRawFm = vaultIndexStore.getMetadata(relPath)?.rawFrontmatter ?? '';
  if (priorRawFm === '') return false;
  // allow-bom-sniff: `rawContent` is the raw in-chain `vault:read-file-text` payload (BOM intact)
  const stripped = rawContent.charCodeAt(0) === 0xfeff ? rawContent.slice(1) : rawContent;
  return /^---[ \t]*\r?\n/.test(stripped);
}

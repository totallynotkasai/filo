import MiniSearch, { type SearchResult } from 'minisearch';
import type { FileTreeNode } from '../../../shared/types';
import { normalizeTagsField } from '../utils/normalizeTagsField';
import { splitFrontmatterSource, parseFrontmatterObject } from './frontmatterRead';
import { isMarkdownExtension } from './extension';
import { normalizePath, stripLeadingSlash, toPosix } from '../utils/path';
import { vaultPath, type VaultPath } from '../../../shared/vaultPath';

/**
 * Metadata extracted from a single .md file in the vault.
 * Keyed in the index by vault-relative path with forward slashes.
 */
export interface FileMetadata {
  path: string;
  title: string;
  tags: string[];
  frontmatter: Record<string, unknown>;
  content: string;
  lastModified: number;
  /**
   * Verbatim YAML source between the `---` fences, captured at parse time.
   * Empty string when the file has no frontmatter fence.
   */
  rawFrontmatter: string;
  /**
   * UTF-8 byte length of the file's RAW content (frontmatter +
   * body, before parsing), captured at parse time. The partial-read shrink
   * heuristic measures THIS rather than
   * the parsed body length, so a mid-write truncation that lands mostly inside a
   * large frontmatter block is still caught (the surviving body alone can look
   * unchanged). Optional: synthetic `FileMetadata` built in tests or non-parse
   * paths may omit it, and the heuristic falls back to the parsed-body length.
   */
  rawByteSize?: number;
}

export interface VaultIndexSearchResult extends SearchResult {
  path: string;
  title: string;
}

interface IndexableDoc {
  id: string;
  title: string;
  content: string;
  tags: string;
}

/**
 * A path is considered ignored if it sits under a directory we never index.
 * Paths use forward slashes and are vault-relative. A note in any user folder
 * (`attachments/` included) is indexed: it is the user's text.
 */
function isIgnoredPath(relativePath: string): boolean {
  const p = toPosix(relativePath);
  return (
    p.startsWith('.filo/') ||
    p.startsWith('node_modules/') ||
    p.startsWith('.git/') ||
    p.endsWith('.board.json')
  );
}

/**
 * Collects all .md files from a vault file tree, recursing into subfolders.
 * Returns vault-relative paths with forward-slash separators.
 */
export function collectMarkdownPaths(tree: FileTreeNode[], vaultRoot: string): string[] {
  const out: string[] = [];
  const rootNorm = normalizePath(vaultRoot);

  function walk(nodes: FileTreeNode[]): void {
    for (const node of nodes) {
      if (node.isDirectory) {
        if (node.children) walk(node.children);
        continue;
      }
      // Accept both `.md` and `.markdown`, so `.markdown` files get an
      // external-edit baseline and appear in search.
      const lowerName = node.name.toLowerCase();
      const isMd =
        isMarkdownExtension(node.extension) ||
        lowerName.endsWith('.md') ||
        lowerName.endsWith('.markdown');
      if (!isMd) continue;
      const abs = toPosix(node.path);
      const rel = abs.startsWith(rootNorm) ? stripLeadingSlash(abs.slice(rootNorm.length)) : abs;
      if (isIgnoredPath(rel)) continue;
      out.push(rel);
    }
  }
  walk(tree);
  return out;
}

/**
 * Reads what the index keeps of one Markdown file: its frontmatter (the
 * `yaml` package, the one parser the note writer uses too), title, tags and
 * body text. No Markdown parse: nothing reads a note's headings or links, so
 * opening a vault doesn't pay for one per note.
 */
export function parseMarkdown(
  relativePath: string,
  rawContent: string,
  lastModified = Date.now(),
): FileMetadata {
  // `splitFrontmatterSource` strips the BOM and tolerates a trailing space on
  // the fence, exactly as `parseMarkdownFile`. The verbatim YAML source lets
  // the external-change pipeline refresh its frontmatter baseline.
  const { rawFrontmatter, body } = splitFrontmatterSource(rawContent);
  const frontmatter = parseFrontmatterObject(rawFrontmatter);

  // Canonical (deduped + sorted, leading `#` stripped) for search and tag
  // counts. A note's tags are its frontmatter `tags:` only; a `#word` in the
  // body is plain text.
  const tags = normalizeTagsField(frontmatter.tags);

  // A note's title is its frontmatter `title:`; without one, its filename stem.
  const fmTitle = typeof frontmatter.title === 'string' ? (frontmatter.title as string).trim() : '';
  const filename = relativePath.split('/').pop() ?? relativePath;
  const title = fmTitle || filename.replace(/\.(md|markdown)$/i, '');

  return {
    path: toPosix(relativePath),
    title,
    tags,
    frontmatter,
    content: body,
    lastModified,
    rawFrontmatter,
    // Raw UTF-8 byte size of the whole file (FM + body) for the
    // partial-read shrink heuristic. Measured on `rawContent` (the bytes the
    // watcher actually read), not the parsed body.
    rawByteSize: rawUtf8ByteLength(rawContent),
  };
}

/**
 * UTF-8 byte length of `text`, used to populate `FileMetadata.rawByteSize`.
 * `TextEncoder` is the accurate path (multi-byte aware); the `.length`
 * fallback only fires in an environment without it (older jsdom shims).
 */
function rawUtf8ByteLength(text: string): number {
  if (typeof TextEncoder !== 'undefined') {
    try {
      return new TextEncoder().encode(text).length;
    } catch {
      /* fall through */
    }
  }
  return text.length;
}

/**
 * Inline-tile tag counts across a project's board set. Pure — no I/O, no
 * reactivity — so the caller can merge these counts into the frontmatter-
 * only `VaultIndex.allTags()` and so unit tests can drive it directly.
 *
 * Inline tiles (Link / Iframe / Timer) live in `.board.json:inlineTiles`,
 * not in any `.md` file, so the frontmatter-driven index doesn't see them.
 */
export function countTagsInInlineTiles(
  project: { boards: Array<{ inlineTiles?: Record<string, unknown> }> } | null | undefined,
): Map<string, number> {
  const counts = new Map<string, number>();
  if (!project) return counts;
  for (const board of project.boards) {
    const inlineTiles = board.inlineTiles ?? {};
    for (const tile of Object.values(inlineTiles)) {
      const t = tile as { tags?: string[] };
      if (!Array.isArray(t.tags)) continue;
      for (const tag of t.tags) {
        if (!tag) continue;
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
  }
  return counts;
}

/**
 * In-memory metadata index for all .md files in a vault:
 *
 *   1. A `Map<path, FileMetadata>` for direct lookups and structured queries
 *      (tags, frontmatter properties, body text).
 *   2. A MiniSearch full-text index over titles, content and tags, built on
 *      the first `query()` and kept up to date from then on. Nothing builds
 *      it at vault open: the app's Search panel runs its own match over the
 *      metadata (`lib/search/runSearch.ts`).
 *
 * Updates are incremental — a file change only re-parses and re-indexes
 * that single file, not the whole vault.
 */
export class VaultIndex {
  // Keyed by the case-FOLDED vault-relative path (branded `VaultPath`), like
  // every other path-keyed store. On a case-insensitive FS an external edit
  // reported with divergent casing would otherwise miss the entry (bypassing
  // the partial-read guard) and upsert a duplicate. The branded key type makes
  // a raw-string `.set` a compile error; the stored value keeps `path` in OS
  // casing for display. Pinned by `scripts/gates:vault-path-keys`.
  private readonly metadata = new Map<VaultPath, FileMetadata>();
  /** Built on the first `query()`; null until then. */
  private search: MiniSearch<IndexableDoc> | null = null;

  private static doc(id: VaultPath, m: FileMetadata): IndexableDoc {
    return { id, title: m.title, content: m.content, tags: m.tags.join(' ') };
  }

  private searchIndex(): MiniSearch<IndexableDoc> {
    if (!this.search) {
      this.search = new MiniSearch<IndexableDoc>({
        fields: ['title', 'content', 'tags'],
        storeFields: ['title'],
        searchOptions: {
          boost: { title: 3, tags: 2 },
          prefix: true,
          fuzzy: 0.2,
        },
      });
      this.search.addAll([...this.metadata].map(([id, m]) => VaultIndex.doc(id, m)));
    }
    return this.search;
  }

  /**
   * The single case-folding key derivation for the metadata
   * Map AND the MiniSearch document id. Returns the branded `VaultPath` form
   * (`vaultPath()` lower-cases + strips the leading slash) so two casings of
   * the same on-disk file collapse to one entry. The branded return type means
   * a caller can't accidentally key the Map by a raw OS path.
   */
  private keyOf(path: string): VaultPath {
    return vaultPath(path);
  }

  upsert(metadata: FileMetadata): void {
    const id = this.keyOf(metadata.path);
    this.metadata.set(id, metadata);
    if (this.search) {
      if (this.search.has(id)) this.search.discard(id);
      this.search.add(VaultIndex.doc(id, metadata));
    }
  }

  remove(path: string): void {
    const id = this.keyOf(path);
    if (this.search?.has(id)) this.search.discard(id);
    this.metadata.delete(id);
  }

  /**
   * Rebinds an index entry from `oldPath` to `newPath`.
   * Updates the metadata map key, the cached `metadata.path`, and the
   * MiniSearch document id atomically. No-ops if the entry doesn't exist.
   *
   * A case-ONLY rename folds to the SAME key, so we refresh the stored display
   * casing in place (mirrors `boardCache.renameBoardPath`).
   */
  renameKey(oldPath: string, newPath: string): void {
    const oldId = this.keyOf(oldPath);
    const newId = this.keyOf(newPath);
    const existing = this.metadata.get(oldId);
    if (!existing) return;
    const newDisplay = toPosix(newPath);
    if (oldId === newId) {
      // Case-only rename — same index identity. Track the new OS casing in the
      // value so consumers (search results, broken-ref checks) see disk truth.
      if (existing.path !== newDisplay) {
        this.metadata.set(oldId, { ...existing, path: newDisplay });
      }
      return;
    }
    if (this.search?.has(oldId)) this.search.discard(oldId);
    this.metadata.delete(oldId);
    // The new path may be indexed already (a write that landed in the moved
    // file, or its create event came first). That entry is newer; keep it.
    if (this.metadata.has(newId)) return;
    const next: FileMetadata = { ...existing, path: newDisplay };
    this.metadata.set(newId, next);
    this.search?.add(VaultIndex.doc(newId, next));
  }

  clear(): void {
    this.metadata.clear();
    this.search = null;
  }

  has(path: string): boolean {
    return this.metadata.has(this.keyOf(path));
  }

  get(path: string): FileMetadata | null {
    return this.metadata.get(this.keyOf(path)) ?? null;
  }

  allPaths(): string[] {
    // Return the stored OS-casing `path` from each value, not
    // the folded Map keys, so callers keep display casing.
    return Array.from(this.metadata.values()).map((m) => m.path);
  }

  allMetadata(): FileMetadata[] {
    return Array.from(this.metadata.values());
  }

  size(): number {
    return this.metadata.size;
  }

  /** Returns paths of all files tagged with the given tag (case-insensitive). */
  filesByTag(tag: string): string[] {
    const needle = tag.replace(/^#/, '').toLowerCase();
    const out: string[] = [];
    for (const md of this.metadata.values()) {
      if (md.tags.some((t) => t.toLowerCase() === needle)) out.push(md.path);
    }
    return out;
  }

  /** Returns a tag-count map across all indexed files. */
  allTags(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const md of this.metadata.values()) {
      for (const tag of md.tags) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return counts;
  }

  /** Full-text search via MiniSearch. Returns ranked results. */
  query(queryText: string, limit = 50): VaultIndexSearchResult[] {
    if (!queryText.trim()) return [];
    const raw = this.searchIndex().search(queryText, { prefix: true, fuzzy: 0.2 });
    // The MiniSearch id is the folded key; resolve it back to
    // the stored OS-casing `path` so search results carry display casing.
    return raw.slice(0, limit).map((r) => {
      const display = this.metadata.get(this.keyOf(String(r.id)))?.path ?? String(r.id);
      return {
        ...r,
        path: display,
        title: (r.title as string) ?? display,
      };
    });
  }
}

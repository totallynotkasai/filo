import MiniSearch, { type SearchResult } from 'minisearch';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkFrontmatter from 'remark-frontmatter';
import type { Root, RootContent, Heading, Link, Text, Yaml } from 'mdast';
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
  headings: Array<{ text: string; level: number; line: number }>;
  tags: string[];
  frontmatter: Record<string, unknown>;
  links: string[];
  content: string;
  lastModified: number;
  /**
   * Verbatim YAML source between the `---` fences, captured at parse time so
   * the external-change pipeline can refresh `originalFrontmatterCache` after a
   * sync-frontmatter reload. Otherwise the CST engine's baseline stays at the
   * pre-sync bytes and a later save drops the inline comment on an
   * externally-changed key. Empty string when the file has no frontmatter fence.
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
  headings: string;
}

/**
 * A path is considered ignored if it sits under a directory we never index.
 * Paths use forward slashes and are vault-relative.
 */
function isIgnoredPath(relativePath: string): boolean {
  const p = toPosix(relativePath);
  return (
    p.startsWith('.filo/') ||
    p.startsWith('node_modules/') ||
    p.startsWith('.git/') ||
    p.endsWith('.board.json') ||
    p.startsWith('attachments/')
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

// Inline `#tag` runs in the body are decorative only — the canonical tag
// source for a `.md` file is its frontmatter `tags:` list. We scan body
// text only for wiki-link targets.
const WIKI_LINK_REGEX = /\[\[([^\]]+?)\]\]/g;

const markdownProcessor = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ['yaml']);

/**
 * Extracts the flattened text content of any mdast node. Used to recover the
 * heading title as the user wrote it (including inline code text, emphasis,
 * etc. but stripping markdown syntax).
 */
function stringifyNode(node: RootContent | Heading | Link | Text): string {
  if ('value' in node && typeof node.value === 'string') {
    // Leaf text/code/html node.
    return node.value;
  }
  if ('children' in node && Array.isArray(node.children)) {
    return node.children.map((c) => stringifyNode(c as RootContent)).join('');
  }
  return '';
}

/**
 * AST-based parse: builds an mdast tree with `remark-parse + remark-frontmatter`,
 * then walks it to extract headings, links, and the frontmatter object. Tags
 * are sourced exclusively from the frontmatter `tags:` field — inline `#foo`
 * runs in the body are styled by the TipTap mark but are not collected here.
 */
function parseWithRemark(rawContent: string): {
  frontmatter: Record<string, unknown>;
  body: string;
  headings: FileMetadata['headings'];
  links: string[];
} {
  const tree = markdownProcessor.parse(rawContent) as Root;

  let frontmatter: Record<string, unknown> = {};
  const headings: FileMetadata['headings'] = [];
  const links: string[] = [];

  function scanTextForLinks(value: string): void {
    WIKI_LINK_REGEX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WIKI_LINK_REGEX.exec(value)) !== null) {
      const target = ((m[1] ?? '').split('|')[0] ?? '').trim();
      if (target) links.push(target);
    }
  }

  function visit(node: RootContent): void {
    switch (node.type) {
      case 'yaml': {
        frontmatter = parseFrontmatterObject((node as Yaml).value);
        return;
      }
      case 'heading': {
        const h = node as Heading;
        headings.push({
          level: h.depth,
          text: stringifyNode(h).trim(),
          line: h.position?.start.line ?? 0,
        });
        for (const child of h.children) {
          if (child.type === 'text') scanTextForLinks((child as Text).value);
          else if (child.type === 'link') {
            const url = (child as Link).url?.trim();
            if (url && !/^https?:\/\//i.test(url) && !url.startsWith('#')) links.push(url);
            for (const inner of (child as Link).children) {
              if (inner.type === 'text') scanTextForLinks((inner as Text).value);
            }
          }
        }
        return;
      }
      case 'text': {
        scanTextForLinks((node as Text).value);
        return;
      }
      case 'link': {
        const url = (node as Link).url?.trim();
        if (url && !/^https?:\/\//i.test(url) && !url.startsWith('#')) links.push(url);
        for (const child of (node as Link).children) {
          if (child.type === 'text') scanTextForLinks((child as Text).value);
        }
        return;
      }
      case 'code':
      case 'inlineCode':
      case 'html':
        return;
      default: {
        if ('children' in node && Array.isArray((node as { children?: RootContent[] }).children)) {
          for (const child of (node as { children: RootContent[] }).children) visit(child);
        }
      }
    }
  }

  for (const child of tree.children) visit(child);

  // Body split via the shared fence helper. The FM object comes from the
  // remark `yaml` node above; this only strips the fenced block off the front
  // so the search-index `content` is body-only.
  const { body } = splitFrontmatterSource(rawContent);

  return { frontmatter, body, headings, links };
}

/**
 * Fallback parser — used when the remark pipeline throws. Tags come only
 * from frontmatter (the caller adds them after this returns), so this
 * function focuses on headings and link extraction.
 *
 * Frontmatter is parsed with the same `yaml` package as the remark path, so
 * the two can't disagree (e.g. on an unquoted `date:` or `0b1010`).
 */
function parseWithoutRemark(rawContent: string): {
  frontmatter: Record<string, unknown>;
  body: string;
  headings: FileMetadata['headings'];
  links: string[];
} {
  const { rawFrontmatter, body } = splitFrontmatterSource(rawContent);
  const frontmatter = parseFrontmatterObject(rawFrontmatter);

  const headings: FileMetadata['headings'] = [];
  const links: string[] = [];

  const HEADING_REGEX = /^(#{1,6})\s+(.+?)\s*$/;
  const MD_LINK_REGEX = /\[([^\]]*)\]\(([^)]+)\)/g;

  const lines = body.split(/\r?\n/);
  let inCodeFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue; // i < lines.length; narrow for the type-checker
    if (/^\s*```/.test(line)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;

    const h = HEADING_REGEX.exec(line);
    if (h) headings.push({ level: (h[1] ?? '').length, text: (h[2] ?? '').trim(), line: i + 1 });

    WIKI_LINK_REGEX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WIKI_LINK_REGEX.exec(line)) !== null) {
      const target = ((m[1] ?? '').split('|')[0] ?? '').trim();
      if (target) links.push(target);
    }

    MD_LINK_REGEX.lastIndex = 0;
    while ((m = MD_LINK_REGEX.exec(line)) !== null) {
      const href = (m[2] ?? '').trim();
      if (href && !/^https?:\/\//i.test(href) && !href.startsWith('#')) links.push(href);
    }
  }

  return { frontmatter, body, headings, links };
}

/**
 * Parses the content of a single Markdown file, extracting all metadata
 * needed for search, tag browsing, and file-reference tracking.
 *
 * Uses the `unified + remark-parse + remark-frontmatter` pipeline — the AST
 * gives us clean separation of prose from code blocks so inline tag and link
 * extraction can't be fooled by `#not-a-tag` appearing inside a fenced block.
 * A regex-based parser (`parseWithoutRemark`) remains as a fallback on parse
 * errors — both source frontmatter through the same `yaml` package.
 */
export function parseMarkdown(
  relativePath: string,
  rawContent: string,
  lastModified = Date.now(),
): FileMetadata {
  let parsed: ReturnType<typeof parseWithRemark>;
  try {
    parsed = parseWithRemark(rawContent);
  } catch (err) {
    console.warn('[vaultIndex] remark parse failed, falling back to regex parser:', err);
    parsed = parseWithoutRemark(rawContent);
  }

  const { frontmatter, body, headings, links } = parsed;

  // Capture the verbatim YAML source between fences so the index's view matches
  // the note writer's (the external-change pipeline refreshes
  // `originalFrontmatterCache` from it). `splitFrontmatterSource` strips the BOM
  // and tolerates a trailing space on the fence, exactly as `parseMarkdownFile`.
  const { rawFrontmatter } = splitFrontmatterSource(rawContent);

  // Canonical (deduped + sorted, leading `#` stripped) for search and tag
  // counts. Body `#tag` runs are decorative and ignored here — see
  // `lib/editor/tagExtension.ts` for the design note.
  const tags = normalizeTagsField(frontmatter.tags);

  // A note's title is its frontmatter `title:`; without one, its filename stem.
  const fmTitle = typeof frontmatter.title === 'string' ? (frontmatter.title as string).trim() : '';
  const filename = relativePath.split('/').pop() ?? relativePath;
  const title = fmTitle || filename.replace(/\.(md|markdown)$/i, '');

  return {
    path: toPosix(relativePath),
    title,
    headings,
    tags,
    frontmatter,
    links,
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
 * In-memory metadata index + MiniSearch full-text engine for all .md files
 * in a vault. Maintains two synchronized data structures:
 *
 *   1. A `Map<path, FileMetadata>` for direct lookups and structured queries
 *      (tags, frontmatter properties, headings).
 *   2. A MiniSearch instance for fuzzy full-text search across content,
 *      titles, tags, and headings.
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
  private readonly search: MiniSearch<IndexableDoc>;

  constructor() {
    this.search = new MiniSearch<IndexableDoc>({
      fields: ['title', 'content', 'tags', 'headings'],
      storeFields: ['title'],
      searchOptions: {
        boost: { title: 3, headings: 2, tags: 2 },
        prefix: true,
        fuzzy: 0.2,
      },
    });
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
    if (this.search.has(id)) this.search.discard(id);
    this.metadata.set(id, metadata);
    this.search.add({
      id,
      title: metadata.title,
      content: metadata.content,
      tags: metadata.tags.join(' '),
      headings: metadata.headings.map((h) => h.text).join(' '),
    });
  }

  remove(path: string): void {
    const id = this.keyOf(path);
    if (this.search.has(id)) this.search.discard(id);
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
    if (this.search.has(oldId)) this.search.discard(oldId);
    this.metadata.delete(oldId);
    // The new path may be indexed already (a write that landed in the moved
    // file, or its create event came first). That entry is newer; keep it.
    if (this.metadata.has(newId)) return;
    const next: FileMetadata = { ...existing, path: newDisplay };
    this.metadata.set(newId, next);
    this.search.add({
      id: newId,
      title: next.title,
      content: next.content,
      tags: next.tags.join(' '),
      headings: next.headings.map((h) => h.text).join(' '),
    });
  }

  clear(): void {
    this.metadata.clear();
    this.search.removeAll();
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
    const raw = this.search.search(queryText, { prefix: true, fuzzy: 0.2 });
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

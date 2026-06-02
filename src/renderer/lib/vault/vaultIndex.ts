import MiniSearch, { type SearchResult } from 'minisearch';
import matter from 'gray-matter';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkFrontmatter from 'remark-frontmatter';
import yaml from 'js-yaml';
import type { Root, RootContent, Heading, Link, Text, Yaml } from 'mdast';
import type { FileTreeNode } from '../../../shared/types';
import { normalizeTags } from './frontmatterSync';
import { isMarkdownExtension } from './extension';
import { normalizePath, stripLeadingSlash, toPosix } from '../utils/path';

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
   * 6.2.H1 — verbatim YAML source between the `---` fences, captured at parse
   * time so the external-change pipeline can refresh `originalFrontmatterCache`
   * after a sync-frontmatter reload. Without this, the cache baseline that
   * `patchFrontmatterSource` diffs against stays at the pre-sync bytes, and a
   * subsequent body-only save's diff re-emits the externally-changed key and
   * drops any inline comment on that key. Empty string when the file has no
   * frontmatter fence.
   */
  rawFrontmatter: string;
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
      // Phase 1 / 1.3 — accept both `.md` and `.markdown`. Without this the
      // cold rebuild on vault open skips `.markdown` files entirely, so the
      // external-edit classifier never has a baseline to compare against and
      // the index can't surface them in search.
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
 * Parses a YAML frontmatter block into a plain object. Uses js-yaml first
 * (same dependency gray-matter uses internally), then falls back to
 * gray-matter on any parse error. Invalid YAML yields `{}`.
 */
function parseFrontmatterBlock(yamlSource: string): Record<string, unknown> {
  if (!yamlSource.trim()) return {};
  try {
    // Audit-4 DI-01 — CORE_SCHEMA keeps unquoted dates as strings (and `<<` as a
    // literal merge key), matching how the write paths re-serialise frontmatter.
    // Keeping the index parser aligned with parseMarkdownFile / tagRewriter
    // avoids a divergence-detection mismatch between the index metadata and the
    // documentStore frontmatter. The gray-matter fallback below only fires when
    // this throws; its rare output is normalised downstream by
    // `frontmatterSync.normalizeScalar` (Date → string), so it stays safe.
    const loaded = yaml.load(yamlSource, { schema: yaml.CORE_SCHEMA });
    if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) {
      return loaded as Record<string, unknown>;
    }
    return {};
  } catch {
    try {
      const fenced = `---\n${yamlSource}\n---\n`;
      const parsed = matter(fenced);
      return (parsed.data ?? {}) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
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
      const target = m[1].split('|')[0].trim();
      if (target) links.push(target);
    }
  }

  function visit(node: RootContent): void {
    switch (node.type) {
      case 'yaml': {
        frontmatter = parseFrontmatterBlock((node as Yaml).value);
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

  let body: string;
  try {
    body = matter(rawContent).content ?? '';
  } catch {
    body = rawContent;
  }

  return { frontmatter, body, headings, links };
}

/**
 * Fallback parser — used when the remark pipeline throws. Tags come only
 * from frontmatter (the caller adds them after this returns), so this
 * function focuses on headings and link extraction.
 */
function parseWithGrayMatter(rawContent: string): {
  frontmatter: Record<string, unknown>;
  body: string;
  headings: FileMetadata['headings'];
  links: string[];
} {
  const parsed = matter(rawContent);
  const frontmatter = (parsed.data ?? {}) as Record<string, unknown>;
  const body = parsed.content ?? '';

  const headings: FileMetadata['headings'] = [];
  const links: string[] = [];

  const HEADING_REGEX = /^(#{1,6})\s+(.+?)\s*$/;
  const MD_LINK_REGEX = /\[([^\]]*)\]\(([^)]+)\)/g;

  const lines = body.split(/\r?\n/);
  let inCodeFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;

    const h = HEADING_REGEX.exec(line);
    if (h) headings.push({ level: h[1].length, text: h[2].trim(), line: i + 1 });

    WIKI_LINK_REGEX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WIKI_LINK_REGEX.exec(line)) !== null) {
      const target = m[1].split('|')[0].trim();
      if (target) links.push(target);
    }

    MD_LINK_REGEX.lastIndex = 0;
    while ((m = MD_LINK_REGEX.exec(line)) !== null) {
      const href = m[2].trim();
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
 * `gray-matter` remains as a fallback on parse errors.
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
    console.warn('[vaultIndex] remark parse failed, falling back to gray-matter:', err);
    parsed = parseWithGrayMatter(rawContent);
  }

  const { frontmatter, body, headings, links } = parsed;

  // 6.2.H1 — capture the verbatim YAML source between fences. Mirrors the
  // regex `parseMarkdownFile` (lib/editor/markdownSync.ts) uses so the
  // index's view of "what's between the fences" matches the write gateway's.
  // `rawContent` here is the raw bytes from `vault:read-file-text` (via
  // `indexOnePath`) — a Notepad-saved file's BOM IS present, so we strip a
  // leading U+FEFF before matching the fence regex. This is one of the
  // legitimate "raw disk bytes via a different gateway" sites the no-bom-
  // sniff gate's inline escape was designed for.
  //
  // Audit-4 DI-17 (M9 parity) — `[ \t]*` after each `---` fence tolerates
  // trailing horizontal whitespace (`--- `), exactly as `parseMarkdownFile`
  // does (its 6.4.M9 fix). Without it, a fence line an editor/linter left a
  // trailing space on parsed here as "no frontmatter" → empty `rawFrontmatter`
  // → the index's clean-bytes view diverged from the write gateway's for that
  // file, defeating the "mirrors parseMarkdownFile" promise above.
  // allow-bom-sniff: parseMarkdown receives raw disk bytes from indexOnePath's vault:read-file-text response
  const stripped = rawContent.charCodeAt(0) === 0xfeff ? rawContent.slice(1) : rawContent;
  const fenced = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(stripped);
  const rawFrontmatter = fenced ? fenced[1] : '';

  // Routed through `normalizeTags` so the equality contract used by
  // frontmatterSync (deduped + sorted, leading `#` stripped) stays in lockstep
  // with the index. Body `#tag` runs are decorative and ignored here — see
  // `lib/editor/tagExtension.ts` for the design note.
  const tags = normalizeTags(frontmatter.tags);

  const fmTitle = typeof frontmatter.title === 'string' ? (frontmatter.title as string).trim() : '';
  const firstHeading = headings[0]?.text ?? '';
  const filename = relativePath.split('/').pop() ?? relativePath;
  const fallbackTitle = filename.replace(/\.md$/i, '');
  const title = fmTitle || firstHeading || fallbackTitle;

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
  };
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
  private readonly metadata = new Map<string, FileMetadata>();
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

  upsert(metadata: FileMetadata): void {
    const id = metadata.path;
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
    const id = toPosix(path);
    if (this.search.has(id)) this.search.discard(id);
    this.metadata.delete(id);
  }

  /**
   * Sprint B / B9 — rebinds an index entry from `oldPath` to `newPath`.
   * Updates the metadata map key, the cached `metadata.path`, and the
   * MiniSearch document id atomically. No-ops if the entry doesn't exist
   * or the paths are the same (case-insensitive on Windows/macOS would
   * still trigger a rebind on case-only renames; we keep it case-sensitive
   * for the helper, since the watcher already normalises before calling).
   */
  renameKey(oldPath: string, newPath: string): void {
    const oldId = toPosix(oldPath);
    const newId = toPosix(newPath);
    if (oldId === newId) return;
    const existing = this.metadata.get(oldId);
    if (!existing) return;
    if (this.search.has(oldId)) this.search.discard(oldId);
    this.metadata.delete(oldId);
    const next: FileMetadata = { ...existing, path: newId };
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
    return this.metadata.has(toPosix(path));
  }

  get(path: string): FileMetadata | null {
    return this.metadata.get(toPosix(path)) ?? null;
  }

  allPaths(): string[] {
    return Array.from(this.metadata.keys());
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
    return raw.slice(0, limit).map((r) => ({
      ...r,
      path: String(r.id),
      title: (r.title as string) ?? String(r.id),
    }));
  }
}

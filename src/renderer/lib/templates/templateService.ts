import MiniSearch from 'minisearch';
import type { FileTreeNode } from '../../../shared/types';
import { normalizePath, stripLeadingSlash, toPosix } from '../utils/path';
import { splitFrontmatterSource, parseFrontmatterObject } from '../vault/frontmatterRead';

/**
 * Templates live as plain Markdown files in a designated vault folder
 * (default: `Templates/`, configurable via the general settings panel).
 *
 * A template's body is interpolated against a small variable registry —
 * `{{title}}`, `{{date}}`, `{{time}}` ship today; the registry is a plain
 * record so future variables (e.g. `{{vault.name}}`) can plug in without
 * touching call sites.
 *
 * A template can also embed a fenced ```filo-board``` code block carrying
 * a `.board.json` skeleton. When a board template is instantiated, the
 * fenced JSON becomes the new `.board.json` and the surrounding prose is
 * dropped onto the board's first text tile.
 */
export interface TemplateRef {
  /** Vault-relative path with forward slashes. */
  path: string;
  /** Display name (filename without `.md`, optionally overridden by frontmatter `title`). */
  name: string;
  /** True when the template body contains a `filo-board` fenced block. */
  isBoard: boolean;
}

export interface TemplateContent {
  ref: TemplateRef;
  /** Template body with frontmatter stripped. */
  body: string;
  /** Frontmatter object (untyped — passes through to caller). */
  frontmatter: Record<string, unknown>;
  /**
   * Optional `boardType` frontmatter field used to scope the template to a
   * particular board flavour (e.g. `kanban`, `tasklist`). When unset the
   * template is treated as universal — the card-from-template picker shows
   * it regardless of the active board's type.
   */
  boardType: string | null;
  /** Parsed `filo-board` JSON, if any. */
  boardJson: unknown | null;
  /** Body with the `filo-board` block removed (for the starter tile). */
  bodyWithoutBoardBlock: string;
}

export interface TemplateVariables {
  title?: string;
  /** Override the runtime clock for tests. Defaults to `new Date()`. */
  now?: Date;
  /** Free-form extras; keys become available as `{{key}}`. */
  extras?: Record<string, string>;
}

const DEFAULT_TEMPLATES_FOLDER = 'Templates';
const FILO_BOARD_FENCE_RE = /```filo-board\s*\n([\s\S]*?)\n```/i;
const VARIABLE_RE = /\{\{\s*([a-zA-Z_][\w.-]*)\s*\}\}/g;

export function defaultTemplatesFolder(): string {
  return DEFAULT_TEMPLATES_FOLDER;
}

/**
 * Walks a vault file tree and returns every `.md` file inside the templates
 * folder. Ignores subfolders for now — flat layout matches the design doc.
 */
export function collectTemplateRefs(
  tree: FileTreeNode[],
  vaultRoot: string,
  templatesFolder: string = DEFAULT_TEMPLATES_FOLDER,
): TemplateRef[] {
  const folderNorm = normalizePath(stripLeadingSlash(templatesFolder));
  if (!folderNorm) return [];

  const rootNorm = normalizePath(vaultRoot);
  const out: TemplateRef[] = [];

  function walk(nodes: FileTreeNode[]): void {
    for (const node of nodes) {
      const abs = toPosix(node.path);
      const rel = abs.startsWith(rootNorm) ? stripLeadingSlash(abs.slice(rootNorm.length)) : abs;
      if (node.isDirectory) {
        // Recurse only into the templates folder (and anywhere nested under it).
        if (rel === folderNorm || rel.startsWith(folderNorm + '/')) {
          if (node.children) walk(node.children);
        }
        continue;
      }
      if (!rel.toLowerCase().endsWith('.md')) continue;
      if (!rel.startsWith(folderNorm + '/')) continue;
      const filename = rel.split('/').pop() ?? rel;
      out.push({
        path: rel,
        name: filename.replace(/\.md$/i, ''),
        isBoard: false, // populated later by `loadTemplate` if needed.
      });
    }
  }

  walk(tree);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Parses a raw template file's contents into structured form. Pulls out the
 * frontmatter, isolates any `filo-board` JSON block, and exposes the body
 * with that block removed.
 */
export function parseTemplate(
  ref: TemplateRef,
  rawContent: string,
): TemplateContent {
  // Parse frontmatter with the `yaml` package — the same parser as the rest of
  // the app (gray-matter's bundled js-yaml would coerce an unquoted `date:` →
  // Date / `0b1010` → 10). The shared split
  // helper strips the `---` fences + a leading BOM; the body keeps its bytes.
  const { rawFrontmatter, body } = splitFrontmatterSource(rawContent);
  const frontmatter = parseFrontmatterObject(rawFrontmatter);

  const fenceMatch = FILO_BOARD_FENCE_RE.exec(body);
  let boardJson: unknown | null = null;
  let bodyWithoutBoardBlock = body;
  if (fenceMatch) {
    try {
      boardJson = JSON.parse(fenceMatch[1] ?? '');
    } catch {
      boardJson = null;
    }
    bodyWithoutBoardBlock = body.replace(FILO_BOARD_FENCE_RE, '').trim();
  }

  const fmTitle = typeof frontmatter.title === 'string' ? (frontmatter.title as string).trim() : '';
  const name = fmTitle || ref.name;

  const fmBoardType = typeof frontmatter.boardType === 'string'
    ? (frontmatter.boardType as string).trim().toLowerCase()
    : '';
  const boardType = fmBoardType.length > 0 ? fmBoardType : null;

  return {
    ref: { ...ref, name, isBoard: boardJson !== null },
    body,
    frontmatter,
    boardType,
    boardJson,
    bodyWithoutBoardBlock,
  };
}

/**
 * Decides whether a parsed Markdown template should appear in the
 * card-from-template picker for the given board type.
 *
 * Returns true when the template either declares no `boardType` (universal)
 * or declares one matching the active board. Case-insensitive on both sides
 * — `parseTemplate` lower-cases the frontmatter value, but callers may pass
 * a mixed-case board type from the schema.
 */
export function templateMatchesBoardType(
  content: Pick<TemplateContent, 'boardType'>,
  boardType: string,
): boolean {
  if (!content.boardType) return true;
  return content.boardType === boardType.toLowerCase();
}

/**
 * Substitutes `{{var}}` placeholders. Unknown variables are left intact so
 * downstream consumers can layer their own substitutions if needed.
 */
export function interpolate(input: string, vars: TemplateVariables = {}): string {
  const now = vars.now ?? new Date();
  // Use local date components so `{{date}}` matches the user's calendar,
  // not UTC. `toISOString()` would silently shift across midnight for any
  // non-UTC timezone.
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const date = `${year}-${month}-${day}`;
  const time = `${hours}:${minutes}`;
  const builtin: Record<string, string> = {
    title: vars.title ?? '',
    date,
    time,
    datetime: `${date} ${time}`,
    year: String(year),
    month,
    day,
    ...(vars.extras ?? {}),
  };

  return input.replace(VARIABLE_RE, (match, key: string) => {
    if (Object.prototype.hasOwnProperty.call(builtin, key)) return builtin[key] ?? match;
    return match;
  });
}

/**
 * Builds a tiny MiniSearch index over template titles. The picker reuses
 * the same engine the rest of the app uses for vault search, keeping
 * fuzzy/prefix behaviour consistent.
 */
function buildTemplateSearchIndex(refs: TemplateRef[]): MiniSearch<{ id: string; name: string }> {
  const search = new MiniSearch<{ id: string; name: string }>({
    fields: ['name'],
    storeFields: ['name'],
    searchOptions: { prefix: true, fuzzy: 0.2 },
  });
  search.addAll(refs.map((r) => ({ id: r.path, name: r.name })));
  return search;
}

/**
 * Returns templates whose name matches the query (fuzzy + prefix). An empty
 * query returns the full list in alphabetical order.
 */
export function searchTemplates(refs: TemplateRef[], query: string): TemplateRef[] {
  const trimmed = query.trim();
  if (!trimmed) return refs;
  const search = buildTemplateSearchIndex(refs);
  const results = search.search(trimmed);
  const refByPath = new Map(refs.map((r) => [r.path, r]));
  const out: TemplateRef[] = [];
  for (const hit of results) {
    const ref = refByPath.get(String(hit.id));
    if (ref) out.push(ref);
  }
  return out;
}

/**
 * Convenience helper used by the picker: parse + interpolate in one call.
 */
export function instantiateTemplate(
  ref: TemplateRef,
  rawContent: string,
  vars: TemplateVariables = {},
): TemplateContent & { interpolatedBody: string } {
  const parsed = parseTemplate(ref, rawContent);
  return {
    ...parsed,
    interpolatedBody: interpolate(parsed.bodyWithoutBoardBlock, vars),
  };
}

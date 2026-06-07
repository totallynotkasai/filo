import { parseMarkdownFile } from '../editor/markdownSync';
import { normalizeTags } from '../vault/frontmatterSync';
import { planTextTileDrop } from './textTileDropPlan';
import { createId } from '../utils/ids';
import { toPosix } from '../utils/path';
import { defaultTileStyleSnapshot } from '../../constants/defaults';
import type { TileDefinition } from '../../schema/index';

/**
 * Pure helper: derives the tile seed (contentId, body, frontmatter-sourced
 * tag names) from a raw `.md` file string. Used by the canvas drag-drop
 * handler when creating a text tile from a dropped Markdown file.
 *
 * - YAML frontmatter is parsed via `parseMarkdownFile` (the `yaml` package
 *   under the hood, handles CRLF).
 * - If the file uses the legacy `<!-- Filo document metadata -->` JSON
 *   comment header, the `id` field is preserved for back-compat (legacy
 *   files predate `tags:` support, so `tagNames` is `[]` in that branch).
 * - A `null` contentId means "caller should mint a fresh id".
 */
export function deriveTileSeedFromMarkdown(raw: string): {
  contentId: string | null;
  body: string;
  tagNames: string[];
} {
  const parsed = parseMarkdownFile(raw);

  if (parsed.hasFrontmatter) {
    const idValue = parsed.frontmatter.id;
    const contentId = typeof idValue === 'string' && idValue.trim().length > 0
      ? idValue.trim()
      : null;
    return {
      contentId,
      body: parsed.body.trim(),
      tagNames: normalizeTags(parsed.frontmatter.tags),
    };
  }

  const jsonFmMatch = raw.match(/^<!--\s*Filo document metadata\s*-->\s*\n(\{[\s\S]*?\})\s*\n/);
  if (jsonFmMatch) {
    try {
      const meta = JSON.parse(jsonFmMatch[1] ?? '');
      const idValue = (meta as { id?: unknown })?.id;
      const contentId = typeof idValue === 'string' && idValue.trim().length > 0
        ? idValue.trim()
        : null;
      return {
        contentId,
        body: raw.slice(jsonFmMatch[0].length).trim(),
        tagNames: [],
      };
    } catch {
      return { contentId: null, body: raw, tagNames: [] };
    }
  }

  return { contentId: null, body: raw, tagNames: [] };
}

/**
 * Result of `buildTextTileDefFromMarkdownFile`.
 *  - `def` carries the intrinsic fields shared by every text-tile view of the
 *    file (contentId, content, title, tags, optional filePath when the file
 *    is outside the board's convention path). Mind Map callers layer
 *    position/size/locked/faded/boardId on top; Kanban callers use the def
 *    as-is for `boardCacheStore.persistAddKanbanPlacement`.
 *  - `duplicate` is `true` when an existing text tile on the board already
 *    represents this file (matched by filePath, contentId, or convention
 *    path). The caller decides whether to surface a non-blocking toast; the
 *    drop still proceeds either way.
 *  - `tagFileKey` is the vault-relative path under which the dropped file's
 *    frontmatter tags should be registered in `.filo/tags.json`. Mirrors
 *    `resolveTextTileFilePath` so subsequent TagEditor edits hit the same
 *    entry. Only meaningful when `def.tags` is non-empty.
 */
export interface TextTileBuildResult {
  def: TileDefinition;
  duplicate: boolean;
  tagFileKey: string;
}

/**
 * Pure helper that converts a freshly read `.md` file into the intrinsic
 * fields of a text-tile definition. Centralises the logic so Mind Map and
 * Kanban drops produce identical tiles (same contentId reuse, same explicit
 * `filePath` stamping, same frontmatter-tag extraction).
 *
 * No store side effects: the caller is responsible for `boardStore.addTile()`
 * / `boardCacheStore.persistAddKanbanPlacement()` and for registering the
 * file's tags via `fileTagsStore.setFileTags(tagFileKey, def.tags)` when
 * `def.tags` is non-empty.
 */
export function buildTextTileDefFromMarkdownFile(args: {
  /** Raw `.md` file contents (already read from disk by the caller). */
  rawContent: string;
  /** Vault-relative path of the dropped file (e.g. `Notes/Foo.md`). */
  vaultRelPath: string;
  /** Active board type — drives the convention-folder lookup. */
  boardType: string | null;
  /** Active board name — feeds Kanban's `Kanban/<boardName>` convention. */
  boardName: string | undefined;
  /**
   * Phase 2 / 2.3 — frozen Kanban convention-folder name. Pass the live
   * board's `kanbanFolder` field for kanban boards so a renamed board still
   * resolves its drops under the original on-disk folder.
   */
  kanbanFolder?: string;
  /** Existing text tiles on the board, used for duplicate detection. */
  existingTiles: ReadonlyArray<{
    type: string;
    title?: string;
    contentId?: string;
    filePath?: string;
  }>;
  /**
   * Cascade-resolved folder for the active board (output of
   * `getActiveContentFolder(boardStore.current)`). Overrides the convention
   * folder when the board type's own folder is `''` (mindmap, tasklist), so a
   * vault-wide / per-board pin gets respected instead of stamping a
   * filePath that points back to the convention root.
   */
  conventionFolderOverride?: string;
  /** Optional tileId override (defaults to a fresh `createId()`). */
  tileId?: string;
  /** Optional timestamp override (defaults to `Date.now()`). */
  now?: number;
}): TextTileBuildResult {
  const {
    rawContent,
    vaultRelPath,
    boardType,
    boardName,
    kanbanFolder,
    existingTiles,
    conventionFolderOverride,
  } = args;

  const seed = deriveTileSeedFromMarkdown(rawContent);
  const contentId = seed.contentId ?? createId();

  const fileName = toPosix(vaultRelPath).split('/').pop() || 'Untitled';
  const title = fileName.replace(/\.(md|markdown)$/i, '');

  const plan = planTextTileDrop({
    droppedRelPath: vaultRelPath,
    title,
    contentId,
    boardType,
    boardName,
    kanbanFolder,
    existingTiles,
    conventionFolderOverride,
  });

  const now = args.now ?? Date.now();
  const tileId = args.tileId ?? createId();

  const def: TileDefinition = {
    id: tileId,
    type: 'text',
    title,
    style: defaultTileStyleSnapshot(),
    tags: seed.tagNames,
    createdAt: now,
    updatedAt: now,
    contentId,
    content: seed.body,
    ...(plan.filePath ? { filePath: plan.filePath } : {}),
  } as TileDefinition;

  const tagFileKey = plan.filePath ?? `${title}.md`;

  return { def, duplicate: plan.duplicate, tagFileKey };
}

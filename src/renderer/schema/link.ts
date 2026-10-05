import { z } from 'zod';

/**
 * @internal test-only (with `encodeFiloLink`): the app reads links through
 * `DecodedFiloLinkSchema`.
 *
 * Internal link types for navigation and actions within Filo.
 *
 * - board-nav: Navigate to a board (opens in tab)
 * - position-nav: Navigate to a specific position on a board
 * - tile-nav: Navigate to a specific tile/task/card on any board type
 *             (Mind Map tile, Task List task, Kanban card)
 * - note-nav: Open a note (by its vault path) in a Document tab
 * - create-tile: Create a new tile with specific content
 */
export const FiloLinkSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['board-nav', 'position-nav', 'tile-nav', 'note-nav', 'create-tile']),
  targetBoardId: z.string().optional(),
  targetTileId: z.string().optional(),
  targetPath: z.string().optional(),
  targetPosition: z.object({
    // .finite() rejects NaN / ±Infinity that a hand-
    // edited filo:// link could otherwise propagate into pan transforms.
    x: z.number().finite(),
    y: z.number().finite(),
  }).passthrough().optional(),
  text: z.string().optional(),
  label: z.string().default(''),
}).passthrough();

type FiloLink = z.infer<typeof FiloLinkSchema>;

/**
 * Schema for a *decoded* link, produced by
 * `decodeFiloLink`. Unlike `FiloLinkSchema`, this has no `id` field
 * because the renderer only ever decodes for navigation (no persistence)
 * — `id` belongs to the stored-on-disk shape. Using the same schema for
 * decoded payloads would always fail (`id` is required).
 *
 * `targetPosition.x` and `.y` keep the `.finite()` gate so a
 * `filo://position/.../Infinity/Infinity` URI is rejected before it
 * reaches `canvasStore.centerOn` and corrupts the pan transform.
 */
export const DecodedFiloLinkSchema = z.object({
  type: z.enum(['board-nav', 'position-nav', 'tile-nav', 'note-nav', 'create-tile']),
  targetBoardId: z.string().optional(),
  targetTileId: z.string().optional(),
  targetPath: z.string().optional(),
  targetPosition: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
  }).optional(),
  text: z.string().optional(),
});

type DecodedFiloLink = z.infer<typeof DecodedFiloLinkSchema>;

/**
 * @internal test-only: builds the URI the app decodes (`decodeFiloLink`); the app
 * itself never writes one.
 *
 * Encodes a Filo internal link as a URI for use in Tiptap Link extension.
 * Format: filo://<type>/<params>
 */
export function encodeFiloLink(link: FiloLink): string {
  switch (link.type) {
    case 'board-nav':
      return `filo://board/${link.targetBoardId}`;
    case 'position-nav':
      return `filo://position/${link.targetBoardId}/${link.targetPosition?.x ?? 0}/${link.targetPosition?.y ?? 0}`;
    case 'tile-nav':
      return `filo://tile/${link.targetBoardId}/${link.targetTileId}`;
    case 'note-nav':
      return linkToNote(link.targetPath ?? '');
    case 'create-tile':
      return `filo://create-tile/${encodeURIComponent(link.text ?? '')}`;
    default:
      return '';
  }
}

/**
 * Decodes a filo:// URI back into link parameters.
 * Returns null if the URI is not a valid Filo internal link.
 *
 * Validates the decoded payload through
 * `DecodedFiloLinkSchema.safeParse`. Rejects non-finite position
 * coordinates (NaN / ±Infinity) before they reach
 * `canvasStore.centerOn`.
 */
export function decodeFiloLink(uri: string): DecodedFiloLink | null {
  if (!uri.startsWith('filo://')) return null;

  const path = uri.slice('filo://'.length);
  const parts = path.split('/');

  let candidate: unknown;
  switch (parts[0]) {
    case 'board':
      candidate = { type: 'board-nav', targetBoardId: parts[1] };
      break;
    case 'position': {
      // Don't coerce NaN to 0 here — the safeParse below routes a NaN /
      // ±Infinity input to a clean null return so the caller can ignore
      // a hostile link rather than panning to an arbitrary origin.
      const x = parseFloat(parts[2] ?? '');
      const y = parseFloat(parts[3] ?? '');
      candidate = {
        type: 'position-nav',
        targetBoardId: parts[1],
        targetPosition: { x, y },
      };
      break;
    }
    case 'tile':
      candidate = { type: 'tile-nav', targetBoardId: parts[1], targetTileId: parts[2] };
      break;
    case 'note': {
      const notePath = asLinkedNotePath(parts.slice(1).join('/'));
      if (notePath === null) return null;
      candidate = { type: 'note-nav', targetPath: notePath };
      break;
    }
    case 'create-tile':
      candidate = { type: 'create-tile', text: decodeURIComponent(parts.slice(1).join('/')) };
      break;
    default:
      return null;
  }
  const parsed = DecodedFiloLinkSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** The link to a board, as "Copy link to board" puts it on the clipboard. */
export function linkToBoard(boardId: string): string {
  return `filo://board/${encodeURIComponent(boardId)}`;
}

/** The link to a tile, card or task on its board. */
export function linkToTile(boardId: string, tileId: string): string {
  return `filo://tile/${encodeURIComponent(boardId)}/${encodeURIComponent(tileId)}`;
}

/**
 * The link to a note: its vault path, encoded whole (a `/` too). A note is
 * named by its path alone, so a link to it follows it only while the file
 * keeps its name and folder (KNOWN_LIMITATIONS #52).
 */
export function linkToNote(path: string): string {
  return `filo://note/${encodeURIComponent(path)}`;
}

/**
 * A note path read from a link, or null: a link comes from any note's text,
 * so only a plain vault-relative Markdown path is opened (no drive or
 * leading slash, no `..`, nothing in `.filo/`).
 */
function asLinkedNotePath(encoded: string): string | null {
  let path: string;
  try {
    path = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  if (!path || path.includes('\\') || path.startsWith('/') || /^[a-z]:/i.test(path)) return null;
  const segments = path.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null;
  if (segments[0]?.toLowerCase() === '.filo') return null;
  return /\.(md|markdown)$/i.test(path) ? path : null;
}

/**
 * Returns true if the given URL is a Filo internal link.
 */
export function isFiloLink(url: string): boolean {
  return url.startsWith('filo://');
}

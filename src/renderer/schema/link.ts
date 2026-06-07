import { z } from 'zod';

/**
 * Internal link types for navigation and actions within Filo.
 *
 * - board-nav: Navigate to a board (opens in tab)
 * - position-nav: Navigate to a specific position on a board
 * - tile-nav: Navigate to a specific tile/task/card on any board type
 *             (Mind Map tile, Task List task, Kanban card)
 * - create-tile: Create a new tile with specific content
 */
export const FiloLinkSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['board-nav', 'position-nav', 'tile-nav', 'create-tile']),
  targetBoardId: z.string().optional(),
  targetTileId: z.string().optional(),
  targetPosition: z.object({
    // Phase 8 / 8.3 — .finite() rejects NaN / ±Infinity that a hand-
    // edited filo:// link could otherwise propagate into pan transforms.
    x: z.number().finite(),
    y: z.number().finite(),
  }).passthrough().optional(),
  text: z.string().optional(),
  label: z.string().default(''),
}).passthrough();

export type FiloLink = z.infer<typeof FiloLinkSchema>;

/**
 * Sprint C / C5 — schema for a *decoded* link, produced by
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
  type: z.enum(['board-nav', 'position-nav', 'tile-nav', 'create-tile']),
  targetBoardId: z.string().optional(),
  targetTileId: z.string().optional(),
  targetPosition: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
  }).optional(),
  text: z.string().optional(),
});

export type DecodedFiloLink = z.infer<typeof DecodedFiloLinkSchema>;

/**
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
 * Sprint C / C5 — validates the decoded payload through
 * `DecodedFiloLinkSchema.safeParse`. Rejects non-finite position
 * coordinates (NaN / ±Infinity) before they reach
 * `canvasStore.centerOn`. The previous `parseFloat(...) || 0` fallback
 * coerced NaN to 0 but happily passed through ±Infinity.
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
    case 'create-tile':
      candidate = { type: 'create-tile', text: decodeURIComponent(parts.slice(1).join('/')) };
      break;
    default:
      return null;
  }
  const parsed = DecodedFiloLinkSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * Returns true if the given URL is a Filo internal link.
 */
export function isFiloLink(url: string): boolean {
  return url.startsWith('filo://');
}

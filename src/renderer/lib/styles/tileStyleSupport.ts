/**
 * Which Tile Style fields a tile type actually renders. The multi-tile Style
 * popup applies each pick only where it means something, so styling a mixed
 * selection never leaves a hidden override on a tile that can't show it.
 */
import type { Tile } from '../../schema/index';

type TileStyle = Tile['style'];

/** Only a text tile has a Markdown body whose font size can be set. */
export function supportsBodyFontSize(type: Tile['type']): boolean {
  return type === 'text';
}

/** `patch` without the fields `type` doesn't render. */
export function stylePatchForType(type: Tile['type'], patch: Partial<TileStyle>): Partial<TileStyle> {
  if (supportsBodyFontSize(type) || !('fontSizeBody' in patch)) return patch;
  const { fontSizeBody: _dropped, ...rest } = patch;
  return rest;
}

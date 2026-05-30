import type { ResolvedTileStyle } from './effectiveStyle';

/**
 * Context key for the resolved tile style. TileContainer sets it once after
 * walking the cascade; body children (TextTile etc.) read it instead of
 * re-walking. The value is wrapped in a getter so consumers see live updates
 * when the cascade re-computes.
 */
export const RESOLVED_TILE_STYLE_KEY = Symbol('resolved-tile-style');

export interface ResolvedTileStyleHolder {
  readonly value: ResolvedTileStyle;
}

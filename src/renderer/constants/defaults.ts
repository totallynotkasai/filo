/**
 * Default geometry + app-wide constants.
 *
 * Style defaults (header / body / border colours, shadow intensity, etc.)
 * are NOT here — they live in `schema/settings.ts` as the authoritative
 * source of truth. New tiles/frames bake empty strings into per-element
 * style fields, then the runtime cascade (`effectiveStyle.ts`) resolves
 * board → global → theme values at paint time.
 */

/** Initial geometry for a newly-created tile. */
export const TILE_DEFAULTS = {
  width: 300,
  height: 200,
  minWidth: 220,
  minHeight: 100,
};

/** Initial geometry for a newly-created frame. */
export const FRAME_DEFAULTS = {
  width: 400,
  height: 300,
  minWidth: 200,
  minHeight: 150,
};

/**
 * Schema-default per-element style snapshot for a freshly-created tile.
 * Empty colour strings let the runtime cascade resolve board / global
 * defaults at paint time. Callers spread this into the tile's `style`
 * field so the shape stays consistent across creation paths (vault
 * tile, Kanban placement, Task placement, Link tile, etc.).
 *
 * shape / borderStyle / borderWidth / shadowIntensity are deliberately
 * omitted — they're cascade-participating fields, and baking a value at
 * this layer would block the per-element → board → global fall-through
 * that "Restore to Theme Defaults" relies on.
 */
export function defaultTileStyleSnapshot() {
  return {
    headerColor: '',
    bodyColor: '',
    borderColor: '',
  };
}

/** Schema-default per-element style snapshot for a freshly-created frame. */
export function defaultFrameStyleSnapshot() {
  return {
    headerColor: '',
    bodyColor: '',
    backgroundImage: '',
    borderColor: '',
  };
}

/** Hard-fallback Kanban column defaults used when no project/board layer resolves a value. */
export const KANBAN_COLUMN_DEFAULTS = {
  width: 380,
  minWidth: 120,
  maxWidth: 2000,
};

export const CANVAS_DEFAULTS = {
  minZoom: 0.1,
  maxZoom: 3.0,
  /** Below this scale, tiles render as a coloured block + bold title (no body). */
  semanticZoomThreshold: 0.5,
  /** Below this scale, tiles render as a bare coloured rectangle (no title). */
  semanticZoomBlockThreshold: 0.25,
  edgePanMargin: 40, // px from screen edge to trigger edge-panning
  edgePanSpeed: 15, // px per frame
};

/** Visual breathing room (px) between tiles for size-aware auto-layouts (tree, radial, distribute). */
export const LAYOUT_GAP_BUFFER = 80;

/** App-wide accent / brand color. Update here to change everywhere. */
export const ACCENT_COLOR = '#6c63ff';

/**
 * Per-element effective-style helpers.
 *
 * Wraps `resolveStyle` so each renderer (tile, frame, kanban column/card,
 * task row, document element) only needs a single call to get back its
 * final style, including the Dynamic Contrast Text override.
 *
 * Cascade order (Design Doc V5 §564–626):
 *   Per-element style > Current Board Settings > Global Defaults
 *
 * The "current board settings" layer is the active board's
 * `settings.defaults` block. Every field is optional; unset fields defer to
 * the global defaults. A board with `defaults` undefined collapses the cascade
 * to per-element > global.
 *
 * Dynamic Contrast Text:
 *   - Each defaults schema has a `dynamicContrastText: boolean` field
 *     (default `true`) that lives at the global/board layer.
 *   - Per-element styles may carry a `dynamicContrastText: boolean | null`
 *     override (`null` = "inherit from cascade").
 *   - When enabled, `getDynamicContrastText` chooses `#000` or `#fff`
 *     against the resolved background for the WCAG-best contrast.
 */
import type {
  Tile,
  Frame,
  Board,
  Connection,
  ProjectSettings,
  TileStyle,
} from '../../schema/index';
import { resolveStyle } from './resolveStyle';
import {
  getDynamicContrastText,
  resolveBackgroundColor,
} from '../utils/color';

// ── Board-layer extractors ──────────────────────────────────────────────
//
// These helpers pull the relevant `settings.defaults.*` block off a
// board, narrowed by board type. Returning `undefined` when the board
// is the wrong type — or has no `defaults` block yet — means the
// cascade cleanly collapses to per-element > global without special
// casing in the callers.

function boardDefaults(
  board: Board | null | undefined,
): Record<string, unknown> | undefined {
  if (!board) return undefined;
  const settings = (board as { settings?: Record<string, unknown> }).settings;
  if (!settings) return undefined;
  const defaults = (settings as Record<string, unknown>).defaults;
  return typeof defaults === 'object' && defaults !== null
    ? (defaults as Record<string, unknown>)
    : undefined;
}

function boardLayer(
  board: Board | null | undefined,
  key:
    | 'tile'
    | 'connectionPath'
    | 'connectionLabel'
    | 'frame'
    | 'column'
    | 'card'
    | 'task'
    | 'section'
    | 'document',
): Record<string, unknown> | undefined {
  const defaults = boardDefaults(board);
  if (!defaults) return undefined;
  const inner = defaults[key];
  return typeof inner === 'object' && inner !== null
    ? (inner as Record<string, unknown>)
    : undefined;
}

// ── Tile ────────────────────────────────────────────────────────────────

export interface ResolvedTileStyle {
  headerColor: string;
  bodyColor: string;
  borderColor: string;
  shape: 'rectangle' | 'rounded';
  borderStyle: 'solid' | 'dashed' | 'dotted';
  borderWidth: number;
  shadowIntensity: number;
  /** Resolved effective value of the dynamicContrastText flag. */
  dynamicContrastText: boolean;
  /** Pre-computed text colour for the header (only when DCT is on). */
  headerTextColor: string | null;
  /** Pre-computed text colour for the body (only when DCT is on). */
  bodyTextColor: string | null;
  /** Resolved title font-size (px), or null to fall through to CSS fallback. */
  fontSizeTitle: number | null;
  /** Resolved body font-size (px), or null to fall through to CSS fallback. */
  fontSizeBody: number | null;
}

/**
 * Resolves a tile's effective style by walking the cascade and applying
 * Dynamic Contrast Text if enabled. `boardType` selects which sub-block
 * of `ProjectSettings` to use as the global-default layer (mind-map
 * tiles read `settings.mindmap.tile`, etc.).
 */
export function effectiveTileStyle(
  tile: Tile,
  projectSettings: ProjectSettings | null | undefined,
  board: Board | null | undefined = null,
  boardType: 'mindmap' = 'mindmap',
): ResolvedTileStyle {
  const globalDefaults = projectSettings?.[boardType]?.tile as
    | Record<string, unknown>
    | undefined;
  // TileStyle is a `.passthrough()` schema output, so its inferred type
  // already exposes an index signature compatible with the loose record
  // shape the cascade resolver walks.
  const perElement: Record<string, unknown> = tile.style;

  const merged = resolveStyle<Record<string, unknown>>(
    perElement,
    boardLayer(board, 'tile'),
    globalDefaults,
  );

  const headerColor = (merged.headerColor as string) ?? '';
  const bodyColor = (merged.bodyColor as string) ?? '';
  const borderColor = (merged.borderColor as string) ?? '';
  const shape =
    (merged.shape as ResolvedTileStyle['shape']) ?? 'rounded';
  const borderStyle =
    (merged.borderStyle as ResolvedTileStyle['borderStyle']) ?? 'solid';
  const borderWidth = (merged.borderWidth as number) ?? 1;
  const shadowIntensity = (merged.shadowIntensity as number) ?? 0.3;
  const dctRaw = merged.dynamicContrastText;
  const dynamicContrastText = typeof dctRaw === 'boolean' ? dctRaw : true;
  const fontSizeTitle = typeof merged.fontSizeTitle === 'number' ? (merged.fontSizeTitle as number) : null;
  const fontSizeBody = typeof merged.fontSizeBody === 'number' ? (merged.fontSizeBody as number) : null;

  let headerTextColor: string | null = null;
  let bodyTextColor: string | null = null;
  if (dynamicContrastText) {
    const headerBg = resolveBackgroundColor(headerColor, '--tile-header-bg');
    const bodyBg = resolveBackgroundColor(bodyColor, '--tile-body-bg');
    headerTextColor = getDynamicContrastText(headerBg);
    bodyTextColor = getDynamicContrastText(bodyBg);
  }

  return {
    headerColor,
    bodyColor,
    borderColor,
    shape,
    borderStyle,
    borderWidth,
    shadowIntensity,
    dynamicContrastText,
    headerTextColor,
    bodyTextColor,
    fontSizeTitle,
    fontSizeBody,
  };
}

/**
 * Lightweight resolver for the Minimap pips. Walks ONLY the
 * `headerColor` through the cascade (per-element > board > global) and skips the
 * Dynamic-Contrast-Text work `effectiveTileStyle` does (a `resolveBackgroundColor`
 * + `getDynamicContrastText` for both header and body, per tile). A minimap pip
 * paints a flat fill and never renders text, so the contrast picks are pure
 * waste there — and the full cascade would run per pip per pan/zoom frame on
 * large boards. Returns the resolved header colour (empty string ⇒ caller falls back
 * to the CSS variable).
 */
export function effectiveTileHeaderColor(
  tile: Tile,
  projectSettings: ProjectSettings | null | undefined,
  board: Board | null | undefined = null,
  boardType: 'mindmap' = 'mindmap',
): string {
  const globalDefaults = projectSettings?.[boardType]?.tile as
    | Record<string, unknown>
    | undefined;
  const merged = resolveStyle<Record<string, unknown>>(
    tile.style,
    boardLayer(board, 'tile'),
    globalDefaults,
  );
  return (merged.headerColor as string) ?? '';
}

// ── Connection path ─────────────────────────────────────────────────────

export interface ResolvedConnectionPathStyle {
  pathColor: string;
  pathSize: number;
  pathType: 'curved' | 'straight' | 'elbow' | 'smart';
  pathStyle: 'solid' | 'dashed' | 'dotted';
  arrowType: 'none' | 'start' | 'end' | 'both';
  arrowColor: string;
  arrowSize: number;
}

/**
 * Resolves a connection's effective path/arrow style by walking the
 * cascade (per-connection flat fields > board defaults > global
 * defaults). Empty-string colours fall through to the CSS variable at
 * the renderer (e.g. `var(--connection-path-color)`).
 */
export function effectiveConnectionPathStyle(
  connection: Connection,
  projectSettings: ProjectSettings | null | undefined,
  board: Board | null | undefined = null,
): ResolvedConnectionPathStyle {
  const globalDefaults = projectSettings?.mindmap?.connectionPath as
    | Record<string, unknown>
    | undefined;

  // Per-connection layer is the flat path/arrow fields on the
  // Connection object. We treat schema-default empty strings as "unset"
  // (for colours) and undefined as "unset" (for enums / numerics) so
  // the cascade can substitute a board/global override — without this,
  // every connection would short-circuit the cascade.
  const perElement: Record<string, unknown> = {
    ...(connection.pathColor !== '' && { pathColor: connection.pathColor }),
    ...(connection.arrowColor !== '' && { arrowColor: connection.arrowColor }),
    ...(typeof connection.pathSize === 'number' && { pathSize: connection.pathSize }),
    ...(connection.pathType !== undefined && { pathType: connection.pathType }),
    ...(connection.pathStyle !== undefined && { pathStyle: connection.pathStyle }),
    ...(connection.arrowType !== undefined && { arrowType: connection.arrowType }),
    ...(typeof connection.arrowSize === 'number' && { arrowSize: connection.arrowSize }),
  };

  const merged = resolveStyle<Record<string, unknown>>(
    perElement,
    boardLayer(board, 'connectionPath'),
    globalDefaults,
  );

  return {
    pathColor: (merged.pathColor as string) ?? '',
    pathSize: typeof merged.pathSize === 'number' ? (merged.pathSize as number) : 2,
    pathType: (merged.pathType as ResolvedConnectionPathStyle['pathType']) ?? 'curved',
    pathStyle: (merged.pathStyle as ResolvedConnectionPathStyle['pathStyle']) ?? 'solid',
    arrowType: (merged.arrowType as ResolvedConnectionPathStyle['arrowType']) ?? 'none',
    arrowColor: (merged.arrowColor as string) ?? '',
    arrowSize: typeof merged.arrowSize === 'number' ? (merged.arrowSize as number) : 10,
  };
}

// ── Connection label ────────────────────────────────────────────────────

export interface ResolvedConnectionLabelStyle {
  textColor: string;
  backgroundColor: string;
  /** Resolved label font-size (px), or null = CSS fallback. */
  fontSize: number | null;
}

/**
 * Resolves a connection label's effective text colour, background
 * colour, and font size by walking the cascade (per-element > board >
 * global). The label `defaultText` field is only seeded at label-
 * creation time (see ConnectionBubbles), so it isn't part of the
 * runtime style cascade. Empty-string colours fall through to the CSS
 * variables at the renderer.
 */
export function effectiveConnectionLabelStyle(
  perElementOverride: { textColor?: string; backgroundColor?: string; fontSize?: number } | null | undefined,
  projectSettings: ProjectSettings | null | undefined,
  board: Board | null | undefined = null,
): ResolvedConnectionLabelStyle {
  const globalDefaults = projectSettings?.mindmap?.connectionLabel as
    | Record<string, unknown>
    | undefined;

  // Treat schema-default empty strings as "unset" so the cascade can
  // substitute board/global overrides. fontSize is passed through when
  // present, omitted when undefined.
  const o = perElementOverride ?? {};
  const normalised: Record<string, unknown> = {
    ...(o.textColor != null && o.textColor !== '' && { textColor: o.textColor }),
    ...(o.backgroundColor != null && o.backgroundColor !== '' && { backgroundColor: o.backgroundColor }),
    ...(typeof o.fontSize === 'number' && { fontSize: o.fontSize }),
  };

  const merged = resolveStyle<Record<string, unknown>>(
    normalised,
    boardLayer(board, 'connectionLabel'),
    globalDefaults,
  );

  const textColor = (merged.textColor as string) ?? '';
  const backgroundColor = (merged.backgroundColor as string) ?? '';
  const fontSize = typeof merged.fontSize === 'number' ? (merged.fontSize as number) : null;
  return { textColor, backgroundColor, fontSize };
}

// ── Frame ───────────────────────────────────────────────────────────────

export interface ResolvedFrameStyle {
  headerColor: string;
  bodyColor: string;
  backgroundImage: string;
  backgroundOpacity: number;
  borderColor: string;
  borderStyle: 'solid' | 'dashed' | 'dotted';
  borderWidth: number;
  shape: 'rectangle' | 'rounded';
  shadowIntensity: number;
  dynamicContrastText: boolean;
  headerTextColor: string | null;
  bodyTextColor: string | null;
  /** Resolved frame title font-size (px), or null = CSS fallback. */
  fontSizeTitle: number | null;
}

export function effectiveFrameStyle(
  frame: Frame,
  projectSettings: ProjectSettings | null | undefined,
  board: Board | null | undefined = null,
): ResolvedFrameStyle {
  const globalDefaults = projectSettings?.mindmap?.frame as
    | Record<string, unknown>
    | undefined;
  // FrameStyle is also `.passthrough()` — the inferred record shape lets the
  // cascade resolver read fields by string key without a wholesale cast.
  const perElement: Record<string, unknown> | undefined = frame.style;

  const merged = resolveStyle<Record<string, unknown>>(
    perElement ?? null,
    boardLayer(board, 'frame'),
    globalDefaults,
  );

  const headerColor = (merged.headerColor as string) ?? '';
  const bodyColor = (merged.bodyColor as string) ?? '';
  const backgroundImage = (merged.backgroundImage as string) ?? '';
  const backgroundOpacity =
    typeof merged.backgroundOpacity === 'number' ? (merged.backgroundOpacity as number) : 1;
  const borderColor = (merged.borderColor as string) ?? '';
  const borderStyle =
    (merged.borderStyle as ResolvedFrameStyle['borderStyle']) ?? 'solid';
  const borderWidth = (merged.borderWidth as number) ?? 1;
  const shape = (merged.shape as ResolvedFrameStyle['shape']) ?? 'rounded';
  const shadowIntensity = (merged.shadowIntensity as number) ?? 0.3;
  const dctRaw = merged.dynamicContrastText;
  const dynamicContrastText = typeof dctRaw === 'boolean' ? dctRaw : true;
  const fontSizeTitle = typeof merged.fontSizeTitle === 'number' ? (merged.fontSizeTitle as number) : null;

  let headerTextColor: string | null = null;
  let bodyTextColor: string | null = null;
  if (dynamicContrastText) {
    const headerBg = resolveBackgroundColor(headerColor, '--ui-surface-raised');
    const bodyBg = resolveBackgroundColor(bodyColor, '--ui-surface');
    headerTextColor = getDynamicContrastText(headerBg);
    bodyTextColor = getDynamicContrastText(bodyBg);
  }

  return {
    headerColor,
    bodyColor,
    backgroundImage,
    backgroundOpacity,
    borderColor,
    borderStyle,
    borderWidth,
    shape,
    shadowIntensity,
    dynamicContrastText,
    headerTextColor,
    bodyTextColor,
    fontSizeTitle,
  };
}

// ── Kanban column ───────────────────────────────────────────────────────

export interface ResolvedColumnStyle {
  headerColor: string;
  bodyColor: string;
  borderColor: string;
  borderStyle: 'solid' | 'dashed' | 'dotted';
  borderWidth: number;
  shadowIntensity: number;
  dynamicContrastText: boolean;
  headerTextColor: string | null;
  bodyTextColor: string | null;
  width: number;
  /** Resolved column title font-size (px), or null = CSS fallback. */
  fontSizeTitle: number | null;
  /**
   * Resolved per-column accent. Empty string = no override; caller should
   * fall back to `board.settings.accentColor` (board-level) or the theme
   * default. Drives the column-header accent bar and the card-count badge.
   */
  accent: string;
}

export function effectiveColumnStyle(
  perElementOverride: Record<string, unknown> | null,
  projectSettings: ProjectSettings | null | undefined,
  board: Board | null | undefined = null,
): ResolvedColumnStyle {
  const globalDefaults = projectSettings?.kanban?.column as
    | Record<string, unknown>
    | undefined;

  const merged = resolveStyle<Record<string, unknown>>(
    perElementOverride,
    boardLayer(board, 'column'),
    globalDefaults,
  );

  const headerColor = (merged.headerColor as string) ?? '';
  const bodyColor = (merged.bodyColor as string) ?? '';
  const borderColor = (merged.borderColor as string) ?? '';
  const borderStyle =
    (merged.borderStyle as ResolvedColumnStyle['borderStyle']) ?? 'solid';
  const borderWidth = (merged.borderWidth as number) ?? 1;
  const shadowIntensity = (merged.shadowIntensity as number) ?? 0.3;
  const dctRaw = merged.dynamicContrastText;
  const dynamicContrastText = typeof dctRaw === 'boolean' ? dctRaw : true;
  const widthRaw = merged.width;
  const width = typeof widthRaw === 'number' && widthRaw > 0 ? widthRaw : 380;
  const fontSizeTitle = typeof merged.fontSizeTitle === 'number' ? (merged.fontSizeTitle as number) : null;
  const accent = (merged.accent as string) ?? '';

  let headerTextColor: string | null = null;
  let bodyTextColor: string | null = null;
  if (dynamicContrastText) {
    const headerBg = resolveBackgroundColor(headerColor, '--ui-surface-raised');
    const bodyBg = resolveBackgroundColor(bodyColor, '--ui-surface');
    headerTextColor = getDynamicContrastText(headerBg);
    bodyTextColor = getDynamicContrastText(bodyBg);
  }

  return {
    headerColor,
    bodyColor,
    borderColor,
    borderStyle,
    borderWidth,
    shadowIntensity,
    dynamicContrastText,
    headerTextColor,
    bodyTextColor,
    width,
    fontSizeTitle,
    accent,
  };
}

// ── Kanban card ─────────────────────────────────────────────────────────

export interface ResolvedCardStyle {
  /** Outer card shell background (the "Background" zone — footer/tags/buttons). */
  backgroundColor: string;
  /** TileHeader band background inside the card. */
  headerColor: string;
  /** Text/content body background inside the card. */
  bodyColor: string;
  /** Outer card shape — mirrors the tile vocabulary. */
  shape: 'rectangle' | 'rounded';
  borderColor: string;
  borderStyle: 'solid' | 'dashed' | 'dotted';
  borderWidth: number;
  shadowIntensity: number;
  dynamicContrastText: boolean;
  /** DCT pick against the shell `backgroundColor` (Background zone text). */
  textColor: string | null;
  /** DCT pick against `headerColor`. */
  headerTextColor: string | null;
  /** DCT pick against `bodyColor`. */
  bodyTextColor: string | null;
  /** Resolved card title font-size (px), or null = CSS fallback. */
  fontSizeTitle: number | null;
  /** Resolved card body font-size (px), or null = CSS fallback. */
  fontSizeBody: number | null;
}

export function effectiveCardStyle(
  perElementOverride: Record<string, unknown> | null,
  projectSettings: ProjectSettings | null | undefined,
  board: Board | null | undefined = null,
): ResolvedCardStyle {
  const globalDefaults = projectSettings?.kanban?.card as
    | Record<string, unknown>
    | undefined;

  const merged = resolveStyle<Record<string, unknown>>(
    perElementOverride,
    boardLayer(board, 'card'),
    globalDefaults,
  );

  const backgroundColor = (merged.backgroundColor as string) ?? '';
  const headerColor = (merged.headerColor as string) ?? '';
  const bodyColor = (merged.bodyColor as string) ?? '';
  const shape = (merged.shape as ResolvedCardStyle['shape']) ?? 'rounded';
  const borderColor = (merged.borderColor as string) ?? '';
  const borderStyle =
    (merged.borderStyle as ResolvedCardStyle['borderStyle']) ?? 'solid';
  const borderWidth = (merged.borderWidth as number) ?? 1;
  const shadowIntensity = (merged.shadowIntensity as number) ?? 0.2;
  const dctRaw = merged.dynamicContrastText;
  const dynamicContrastText = typeof dctRaw === 'boolean' ? dctRaw : true;
  const fontSizeTitle = typeof merged.fontSizeTitle === 'number' ? (merged.fontSizeTitle as number) : null;
  const fontSizeBody = typeof merged.fontSizeBody === 'number' ? (merged.fontSizeBody as number) : null;

  let textColor: string | null = null;
  let headerTextColor: string | null = null;
  let bodyTextColor: string | null = null;
  if (dynamicContrastText) {
    const bg = resolveBackgroundColor(backgroundColor, '--ui-surface');
    textColor = getDynamicContrastText(bg);
    // Header / body DCT against their own resolved fill, falling through to
    // the same theme variables the renderer paints when the field is empty
    // so the contrast pick matches what the user actually sees.
    const headerBg = resolveBackgroundColor(headerColor, '--tile-header-bg');
    const bodyBg = resolveBackgroundColor(bodyColor, '--tile-body-bg');
    headerTextColor = getDynamicContrastText(headerBg);
    bodyTextColor = getDynamicContrastText(bodyBg);
  }

  return {
    backgroundColor,
    headerColor,
    bodyColor,
    shape,
    borderColor,
    borderStyle,
    borderWidth,
    shadowIntensity,
    dynamicContrastText,
    textColor,
    headerTextColor,
    bodyTextColor,
    fontSizeTitle,
    fontSizeBody,
  };
}

// ── Task row ────────────────────────────────────────────────────────────

export interface ResolvedTaskStyle {
  /** Background of the row's title strip (`.task-item`). */
  headerColor: string;
  /** Background of the expanded notes panel (`.task-notes-panel-inner`). */
  bodyColor: string;
  borderColor: string;
  borderStyle: 'solid' | 'dashed' | 'dotted';
  borderWidth: number;
  shadowIntensity: number;
  dynamicContrastText: boolean;
  /** DCT pick against the row title strip's background. */
  headerTextColor: string | null;
  /** DCT pick against the notes panel's background. */
  bodyTextColor: string | null;
  /** Resolved task title font-size (px), or null = CSS fallback. */
  fontSizeTitle: number | null;
  /** Resolved task body font-size (px), or null = CSS fallback. */
  fontSizeBody: number | null;
}

export function effectiveTaskStyle(
  perElementOverride: Record<string, unknown> | null,
  projectSettings: ProjectSettings | null | undefined,
  board: Board | null | undefined = null,
): ResolvedTaskStyle {
  const globalDefaults = projectSettings?.tasklist?.task as
    | Record<string, unknown>
    | undefined;

  const merged = resolveStyle<Record<string, unknown>>(
    perElementOverride,
    boardLayer(board, 'task'),
    globalDefaults,
  );

  const headerColor = (merged.headerColor as string) ?? '';
  const bodyColor = (merged.bodyColor as string) ?? '';
  const borderColor = (merged.borderColor as string) ?? '';
  const borderStyle =
    (merged.borderStyle as ResolvedTaskStyle['borderStyle']) ?? 'solid';
  const borderWidth = (merged.borderWidth as number) ?? 1;
  const shadowIntensity = (merged.shadowIntensity as number) ?? 0.2;
  const dctRaw = merged.dynamicContrastText;
  const dynamicContrastText = typeof dctRaw === 'boolean' ? dctRaw : true;
  const fontSizeTitle = typeof merged.fontSizeTitle === 'number' ? (merged.fontSizeTitle as number) : null;
  const fontSizeBody = typeof merged.fontSizeBody === 'number' ? (merged.fontSizeBody as number) : null;

  // Two paint zones for a task row: the title strip (`.task-item`) takes
  // `headerColor`, the notes panel takes `bodyColor`. DCT emits a contrast
  // pick for each so text stays legible against whichever surface the user
  // dialled. Fallback variables match the actual painted defaults.
  let headerTextColor: string | null = null;
  let bodyTextColor: string | null = null;
  if (dynamicContrastText) {
    const headerBg = resolveBackgroundColor(headerColor, '--ui-surface-raised');
    headerTextColor = getDynamicContrastText(headerBg);
    const bodyBg = resolveBackgroundColor(bodyColor, '--ui-surface');
    bodyTextColor = getDynamicContrastText(bodyBg);
  }

  return {
    headerColor,
    bodyColor,
    borderColor,
    borderStyle,
    borderWidth,
    shadowIntensity,
    dynamicContrastText,
    headerTextColor,
    bodyTextColor,
    fontSizeTitle,
    fontSizeBody,
  };
}

// ── Document element ───────────────────────────────────────────────────

export interface ResolvedDocumentStyle {
  bodyColor: string;
  borderColor: string;
  borderStyle: 'solid' | 'dashed' | 'dotted';
  borderWidth: number;
  shadowIntensity: number;
  dynamicContrastText: boolean;
  bodyTextColor: string | null;
}

/**
 * Resolves a Document board's effective element style by walking the
 * cascade (per-board override > global defaults) and applying Dynamic
 * Contrast Text if enabled. Document boards have no per-element style
 * (the board IS the element), so the cascade is only two layers.
 */
export function effectiveDocumentStyle(
  projectSettings: ProjectSettings | null | undefined,
  board: Board | null | undefined = null,
): ResolvedDocumentStyle {
  const globalDefaults = projectSettings?.document?.document as
    | Record<string, unknown>
    | undefined;

  const merged = resolveStyle<Record<string, unknown>>(
    null,
    boardLayer(board, 'document'),
    globalDefaults,
  );

  const bodyColor = (merged.bodyColor as string) ?? '';
  const borderColor = (merged.borderColor as string) ?? '';
  const borderStyle =
    (merged.borderStyle as ResolvedDocumentStyle['borderStyle']) ?? 'solid';
  const borderWidth = (merged.borderWidth as number) ?? 1;
  const shadowIntensity = (merged.shadowIntensity as number) ?? 0.2;
  const dctRaw = merged.dynamicContrastText;
  const dynamicContrastText = typeof dctRaw === 'boolean' ? dctRaw : true;

  // DocumentBoard has no header band, so no `headerColor` is resolved — the
  // cascade doesn't pretend to honour a control the renderer can't show.
  let bodyTextColor: string | null = null;
  if (dynamicContrastText) {
    const bodyBg = resolveBackgroundColor(bodyColor, '--ui-surface');
    bodyTextColor = getDynamicContrastText(bodyBg);
  }

  return {
    bodyColor,
    borderColor,
    borderStyle,
    borderWidth,
    shadowIntensity,
    dynamicContrastText,
    bodyTextColor,
  };
}

// ── Task-list section ──────────────────────────────────────────────────

export interface ResolvedTaskSectionStyle {
  headerColor: string;
  bodyColor: string;
  borderColor: string;
  borderStyle: 'solid' | 'dashed' | 'dotted';
  borderWidth: number;
  shadowIntensity: number;
  dynamicContrastText: boolean;
  headerTextColor: string | null;
  bodyTextColor: string | null;
  /** Resolved section title font-size (px), or null = CSS fallback. */
  fontSizeTitle: number | null;
}

export function effectiveTaskSectionStyle(
  perElementOverride: Record<string, unknown> | null,
  projectSettings: ProjectSettings | null | undefined,
  board: Board | null | undefined = null,
): ResolvedTaskSectionStyle {
  const globalDefaults = projectSettings?.tasklist?.section as
    | Record<string, unknown>
    | undefined;

  const merged = resolveStyle<Record<string, unknown>>(
    perElementOverride,
    boardLayer(board, 'section'),
    globalDefaults,
  );

  const headerColor = (merged.headerColor as string) ?? '';
  const bodyColor = (merged.bodyColor as string) ?? '';
  const borderColor = (merged.borderColor as string) ?? '';
  const borderStyle =
    (merged.borderStyle as ResolvedTaskSectionStyle['borderStyle']) ?? 'solid';
  const borderWidth = (merged.borderWidth as number) ?? 1;
  const shadowIntensity = (merged.shadowIntensity as number) ?? 0.2;
  const dctRaw = merged.dynamicContrastText;
  const dynamicContrastText = typeof dctRaw === 'boolean' ? dctRaw : true;
  const fontSizeTitle = typeof merged.fontSizeTitle === 'number' ? (merged.fontSizeTitle as number) : null;

  let headerTextColor: string | null = null;
  let bodyTextColor: string | null = null;
  if (dynamicContrastText) {
    const headerBg = resolveBackgroundColor(headerColor, '--ui-surface-raised');
    const bodyBg = resolveBackgroundColor(bodyColor, '--ui-surface');
    headerTextColor = getDynamicContrastText(headerBg);
    bodyTextColor = getDynamicContrastText(bodyBg);
  }

  return {
    headerColor,
    bodyColor,
    borderColor,
    borderStyle,
    borderWidth,
    shadowIntensity,
    dynamicContrastText,
    headerTextColor,
    bodyTextColor,
    fontSizeTitle,
  };
}

// ── Re-exports so consumers can import everything from one place ──
export type { TileStyle };

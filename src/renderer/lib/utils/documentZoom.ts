/**
 * documentZoom — the Document tab's zoom levels. One level for every note,
 * kept with the vault's layout (`workspaceStore.documentZoom`).
 */

export const DOCUMENT_ZOOM_LEVELS: readonly number[] = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

export const DEFAULT_DOCUMENT_ZOOM = 1;

/** A stored zoom as one of the levels: the nearest, or 100% for anything unreadable. */
export function asDocumentZoom(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return DEFAULT_DOCUMENT_ZOOM;
  let best = DEFAULT_DOCUMENT_ZOOM;
  for (const level of DOCUMENT_ZOOM_LEVELS) {
    if (Math.abs(level - value) < Math.abs(best - value)) best = level;
  }
  return best;
}

/** The next level up, or the highest. */
export function zoomedIn(zoom: number): number {
  return DOCUMENT_ZOOM_LEVELS.find((level) => level > zoom + 0.001) ?? DOCUMENT_ZOOM_LEVELS[DOCUMENT_ZOOM_LEVELS.length - 1]!;
}

/** The next level down, or the lowest. */
export function zoomedOut(zoom: number): number {
  return [...DOCUMENT_ZOOM_LEVELS].reverse().find((level) => level < zoom - 0.001) ?? DOCUMENT_ZOOM_LEVELS[0]!;
}

/** "125%". */
export function zoomLabel(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}

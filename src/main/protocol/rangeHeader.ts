/**
 * Parses a single-range `bytes=start-end` HTTP `Range` header. Returns:
 *   - `null`     — no Range header, send the full body.
 *   - `'invalid'` — header present but malformed or out-of-bounds → 416.
 *   - `{start, end}` (both inclusive, clamped to [0, totalSize-1]) — 206.
 *
 * HTMLVideoElement only ever issues single ranges in practice; multi-range
 * (`bytes=0-100,200-300`) is part of the spec but never seen from Chromium
 * for media, so it's intentionally rejected here.
 *
 * Lives in its own module (separate from `filoMedia.ts`) so the parser can
 * be unit-tested without pulling Electron's `protocol`/`ipcMain` cascade
 * into the jsdom test environment.
 */
export function parseRangeHeader(
  header: string | null,
  totalSize: number,
): { start: number; end: number } | 'invalid' | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return 'invalid';

  const startRaw = match[1];
  const endRaw = match[2];

  // `bytes=-N` → "last N bytes"
  if (startRaw === '' && endRaw !== '') {
    const suffix = Number(endRaw);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid';
    const start = Math.max(0, totalSize - suffix);
    return { start, end: totalSize - 1 };
  }

  if (startRaw === '') return 'invalid';
  const start = Number(startRaw);
  if (!Number.isFinite(start) || start < 0 || start >= totalSize) return 'invalid';

  if (endRaw === '') return { start, end: totalSize - 1 };
  const end = Number(endRaw);
  if (!Number.isFinite(end) || end < start) return 'invalid';
  return { start, end: Math.min(end, totalSize - 1) };
}

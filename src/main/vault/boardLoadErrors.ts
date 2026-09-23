/**
 * Audit-19 ERR-4 — typed failure codes for `board:load`.
 *
 * `board:load` used to return `null` for EVERY error, and the renderer mapped
 * `null` to "not-found": a board whose file OneDrive held locked for a moment,
 * or an online-only placeholder while the PC was offline, looked deleted for
 * the whole session. The handler now returns an envelope whose `code` says
 * what actually happened, so the renderer can offer Retry for the transient
 * cases and keep a real "not found" honest.
 */
import { WIN_LOCK_CODES } from './filenameUtils';

export type BoardLoadErrorCode = 'ENOENT' | 'LOCKED' | 'OFFLINE' | 'TOO_LARGE' | 'PARSE' | 'IO';

/** Error thrown by the handler's pre-read size check. */
export class BoardTooLargeError extends Error {
  constructor(size: number, limit: number) {
    super(`File too large: ${size} > ${limit}`);
    this.name = 'BoardTooLargeError';
  }
}

/**
 * errno codes libuv reports for a cloud placeholder that can't hydrate
 * (offline / provider not running) or a network share that dropped.
 */
const OFFLINE_CODES = new Set(['EIO', 'ETIMEDOUT', 'ENOTCONN', 'EHOSTDOWN', 'EHOSTUNREACH', 'ENETUNREACH']);

export function classifyBoardLoadError(err: unknown): BoardLoadErrorCode {
  if (err instanceof BoardTooLargeError) return 'TOO_LARGE';
  if (err instanceof SyntaxError) return 'PARSE';
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'ENOENT';
  if (typeof code === 'string' && WIN_LOCK_CODES.has(code)) return 'LOCKED';
  if (typeof code === 'string' && OFFLINE_CODES.has(code)) return 'OFFLINE';
  // Windows cloud-files errors (ERROR_CLOUD_FILE_*) can surface as UNKNOWN with
  // a descriptive message rather than a mapped errno.
  const message = err instanceof Error ? err.message : String(err);
  if (/cloud (file|provider|operation)/i.test(message)) return 'OFFLINE';
  return 'IO';
}

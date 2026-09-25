/**
 * Payload-size caps for every write-shaped IPC handler.
 *
 * Filo's IPC surface accepts content from the renderer (Markdown text,
 * board / config / theme JSON, base64 audio, …) and writes it to disk
 * via `atomicWriteFile`. A buggy or compromised renderer that hands
 * over a multi-gigabyte payload would walk through all the safety
 * gates and only hit a wall in the disk-full / OOM path inside Node.
 *
 * These constants set a per-channel ceiling so an over-large payload
 * is rejected with a clean diagnostic before the write pipeline runs.
 * The numbers are calibrated against real-world content limits:
 *
 *   - Markdown documents: even very long notes top out in low MB.
 *   - Board JSON: scales with tile count; 50 MB covers vaults with
 *     tens of thousands of tiles before any compression.
 *   - Configs (.filo/*.json): the largest is `defaults.json`, which
 *     tops out under 1 MB even with every override populated.
 *   - Themes: ~tens of KB; 1 MB is a comfortable safety margin.
 *   - Audio: base64-decoded; matches the vault:copy-file cap so the
 *     two import paths are consistent.
 *
 * `PayloadTooLargeError` is thrown by `assertPayloadByteSize`; IPC
 * handlers catch and translate to `{ success: false, code:
 * 'FILE_TOO_LARGE', error }` for the renderer.
 */

export class PayloadTooLargeError extends Error {
  readonly code = 'FILE_TOO_LARGE';
  readonly byteLength: number;
  readonly maxBytes: number;

  constructor(byteLength: number, maxBytes: number, label: string) {
    super(`${label} payload is ${byteLength} bytes; cap is ${maxBytes} bytes`);
    this.name = 'PayloadTooLargeError';
    this.byteLength = byteLength;
    this.maxBytes = maxBytes;
  }
}

const MB = 1024 * 1024;

export const PAYLOAD_LIMITS = {
  /** `vault:write-file-text` / `vault:write-existing-file-text` / `vault:create-file-text` — Markdown text. */
  MARKDOWN: 25 * MB,
  /** `board:save` / `board:create` — board JSON. */
  BOARD: 50 * MB,
  /** `config:save` / `config:save-workspace` — generic `.filo/*.json`. */
  CONFIG: 10 * MB,
  /** `theme:save` — theme JSON. */
  THEME: 1 * MB,
  /** `tags:save` — `.filo/tags.json`. */
  TAGS: 25 * MB,
  /** `templates:layout:write` — `.filo/templates/*.json`. */
  TEMPLATE: 10 * MB,
  /** `media:save-audio` — base64-decoded audio bytes. */
  AUDIO: 100 * MB,
  /**
   * Single-file binary IPC cap for `export:save` (PNG/SVG/PDF export
   * payloads). 200 MB allows a 4K screen capture or a long high-bitrate
   * recording to survive an export round-trip without false rejection.
   *
   * NOTE: this is NOT the cap used by `media:read-file` — that uses
   * `MEDIA_READ_INLINE` below.
   */
  MEDIA: 200 * MB,
  /**
   * `media:read-file` — disk file size for inline media reads. The inline
   * IPC path keeps the whole base64 string in renderer memory, so it needs
   * a tighter ceiling than MEDIA. 25 MB covers every legitimate inline-use
   * image / audio while blocking accidental multi-GB raw video.
   */
  MEDIA_READ_INLINE: 25 * MB,
} as const;

/**
 * Throws `PayloadTooLargeError` if `byteLength` exceeds `maxBytes`. The
 * `label` is woven into the error message for log diagnosis.
 */
export function assertPayloadByteSize(
  byteLength: number,
  maxBytes: number,
  label: string,
): void {
  if (byteLength > maxBytes) {
    throw new PayloadTooLargeError(byteLength, maxBytes, label);
  }
}

/**
 * Returns the UTF-8 byte length of a JSON-shaped payload. Accepts either a
 * pre-serialized string (the renderer's `boardSaver` layer dedupes against
 * `lastWrittenConfigs` by stringifying upstream) or an object that we
 * `JSON.stringify` ourselves. Returns 0 for nullish input.
 */
export function jsonPayloadByteSize(data: unknown): number {
  if (data == null) return 0;
  const json = typeof data === 'string' ? data : JSON.stringify(data);
  return Buffer.byteLength(json, 'utf-8');
}

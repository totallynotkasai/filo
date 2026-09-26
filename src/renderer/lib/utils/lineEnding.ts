/**
 * lineEnding — the one line-ending detector for note files.
 *
 * The note writer and the tag rewriter both re-emit parts of a file (the
 * frontmatter block, or a new body) and must pick the ending those parts get.
 * They share these rules so the two can never disagree about the same file.
 */

import { openingFenceEol } from '../notes/frontmatterFence';

export type LineEnding = '\n' | '\r\n';

/**
 * The file's line ending by majority: CRLF when at least as many line breaks
 * are CRLF as are a lone LF. One stray CRLF in an LF file doesn't make it
 * CRLF (a body write would otherwise rewrite every other line).
 */
export function fileLineEnding(raw: string): LineEnding {
  let crlf = 0;
  let lf = 0;
  for (let i = raw.indexOf('\n'); i !== -1; i = raw.indexOf('\n', i + 1)) {
    if (i > 0 && raw.charCodeAt(i - 1) === 13) crlf++;
    else lf++;
  }
  return crlf > 0 && crlf >= lf ? '\r\n' : '\n';
}

/**
 * The ending for a frontmatter block written into `raw`: the one its opening
 * fence line already uses, else (no block yet) the file's own.
 */
export function frontmatterLineEnding(raw: string): LineEnding {
  return openingFenceEol(raw) ?? fileLineEnding(raw);
}

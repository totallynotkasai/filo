/**
 * File-name rules shared by the main process (which validates every name it
 * is asked to create) and the renderer (which derives a note's filename from
 * its title and validates a sidebar rename before sending it).
 */

/**
 * Windows reserves these legacy DOS device names regardless of extension.
 * Creating `CON.md` or `LPT1.txt` succeeds on POSIX but on Windows opens a
 * device handle instead of a real file. `CONIN$` / `CONOUT$` / `CLOCK$` carry
 * a literal `$`, so only the exact reserved stem matches (`money$.md` is fine).
 */
export const RESERVED_WINDOWS_NAMES: ReadonlySet<string> = new Set([
  'CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$', 'CLOCK$',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/** Characters no file name may carry on some supported OS (incl. separators). */
const ILLEGAL_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;
const ILLEGAL_NAME_CHAR = /[<>:"/\\|?*\u0000-\u001f\u007f]/;

/** Longest stem a derived name may have, leaving room for ` (n).md` and a folder. */
const MAX_STEM_LENGTH = 200;

function isReservedStem(name: string): boolean {
  const stem = (name.split('.')[0] ?? '').trim().toUpperCase();
  return RESERVED_WINDOWS_NAMES.has(stem);
}

/**
 * `name` made safe to use as a file or folder name on every supported OS.
 * Each illegal character is replaced by `illegalAs`, whitespace collapses,
 * leading dots and spaces go (Filo treats a dot-name as hidden, so the
 * sidebar, the watcher and the index would never see the note), trailing
 * dots and spaces go (Windows strips them,
 * which would collide with a neighbour), the result is cut to 200 characters
 * (whole code points), a reserved device name gets a `_` prefix, and an empty
 * result is `Untitled`. Every name Filo derives goes through this one rule, so
 * the main process and the renderer agree on what a given name becomes.
 */
export function safeFileName(name: string, illegalAs: '-' | ''): string {
  let stem = name
    .replace(ILLEGAL_NAME_CHARS, illegalAs)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. ]+/, '')
    .replace(/[. ]+$/, '');
  if (stem.length > MAX_STEM_LENGTH) {
    stem = Array.from(stem).slice(0, MAX_STEM_LENGTH).join('').trim().replace(/[. ]+$/, '');
  }
  if (!stem) return 'Untitled';
  return isReservedStem(stem) ? `_${stem}` : stem;
}

/**
 * The file stem Filo gives a new note titled `title`. The title itself may
 * hold any character (it lives in frontmatter); only the filename is
 * restricted, and an illegal character becomes `-` so the words stay apart.
 * Example: `What? / Why` → `What- - Why`.
 */
export function fileStemFromTitle(title: string): string {
  return safeFileName(title, '-');
}

/**
 * Why `name` can't be used as a file or folder name, or `null` when it can.
 * The sidebar rename shows this inline instead of guessing a replacement;
 * the main process validates again on its side.
 */
export function fileNameProblem(name: string): string | null {
  if (name.trim().length === 0) return 'A name is required.';
  if (name === '.' || name === '..') return 'That name is reserved.';
  const bad = ILLEGAL_NAME_CHAR.exec(name);
  if (bad) {
    const ch = bad[0];
    const shown = ch.charCodeAt(0) < 0x20 || ch === '\u007f' ? 'control characters' : `"${ch}"`;
    return `Names can't contain ${shown}.`;
  }
  if (/[. ]$/.test(name)) return "Names can't end with a dot or a space.";
  // A dot-name is hidden: Filo would lose sight of the file.
  if (name.startsWith('.')) return "Names can't start with a dot.";
  if (isReservedStem(name)) return `"${(name.split('.')[0] ?? '').trim()}" is reserved by Windows.`;
  if (name.length > 255) return 'That name is too long.';
  return null;
}

import { extname } from 'path';
import type { FileChangeType } from './fileWatcherTypes';

/**
 * Path classification + ignore rules for the vault file watcher: the "what
 * IS this path / should we ignore it" decisions, kept apart from the
 * watcher's event mechanics. Pure functions — no watcher instance state.
 */

/**
 * Per-segment matching rather than `string.includes`, so a note titled
 * `Article on Thumbs.db.md` isn't swallowed. The relative path is split by
 * `/` and one rule applied per segment.
 *
 *  - `exactNames`: a segment whose entire string equals the pattern (e.g.
 *    `Thumbs.db`, `.DS_Store`). `Article on Thumbs.db.md` isn't
 *    swallowed because the *basename* segment isn't exactly `Thumbs.db`.
 *  - `folderNames`: an INTERIOR segment (any but the last) matching the
 *    pattern (e.g. `node_modules`, `.git`). The last segment isn't a
 *    folder by definition, so a file literally named `node_modules` at
 *    the vault root still reaches the classifier — desired.
 *  - `suffixes`: the final segment ends with this string (e.g. `.tmp`,
 *    `.bak`). Editor-temp files plus the atomicWriteFile temp suffix all
 *    end in `.tmp`/`.bak`, so this catches them regardless of basename.
 *  - `prefixedPaths`: full path starts with this prefix (e.g.
 *    `.filo/cache/`). Lets us ignore an internal cache subtree without
 *    spuriously matching a user-created `cache` folder elsewhere.
 */
const IGNORE_RULES = {
  exactNames: new Set<string>(['Thumbs.db', '.DS_Store', 'desktop.ini']),
  folderNames: new Set<string>(['node_modules', '.git']),
  suffixes: ['.tmp', '.bak'] as const,
  prefixedPaths: ['.filo/cache/'] as const,
};

export function shouldIgnorePath(normalized: string): boolean {
  for (const prefix of IGNORE_RULES.prefixedPaths) {
    if (normalized.startsWith(prefix)) return true;
  }
  const segments = normalized.split('/');
  const lastIdx = segments.length - 1;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i] ?? ''; // i < length; '' is a no-op for has()/endsWith()
    if (i === lastIdx) {
      if (IGNORE_RULES.exactNames.has(segment)) return true;
      for (const suffix of IGNORE_RULES.suffixes) {
        if (segment.endsWith(suffix)) return true;
      }
    } else {
      if (IGNORE_RULES.folderNames.has(segment)) return true;
    }
  }
  return false;
}

/**
 * File extensions that should be classified as `'attachment'` regardless of
 * the folder they live in, so an OS-level move of `hero.jpg` from the vault
 * root to `media/` still participates in rename correlation (a `'tree'`
 * event is ignored by the correlator, leaving every tile pointing at the file
 * dangling).
 *
 * Keeps the same coverage as `mime.getMimeType`'s media types — anything the
 * media-tile reader could serve is something a user might place outside
 * `attachments/` and expect rename propagation for.
 */
const MEDIA_EXTENSIONS = new Set<string>([
  // Images (incl. .heic/.heif/.avif — modern Apple + browser capture
  // formats users drag in from Photos.app and screenshots)
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp',
  '.heic', '.heif', '.avif',
  // Video
  '.mp4', '.webm', '.ogv', '.mov',
  // Audio (incl. .opus, .mid, .midi — Opus is the modern
  // WebM Opus container, MIDI for music workflows)
  '.mp3', '.wav', '.ogg', '.aac', '.flac', '.m4a',
  '.opus', '.mid', '.midi',
  // Documents the file-tile / link-tile expects to open
  '.pdf',
]);

/**
 * Classifies a vault-relative path into the `FileChangeType` the renderer's
 * external-change dispatcher routes on. Pure — depends only on the path
 * string, so the live `fs.watch` callback, the reconcile diff loop, and the
 * `FileWatcher.classifyForTests` seam all share one implementation.
 */
export function classifyChange(relativePath: string): FileChangeType {
  if (relativePath.startsWith('.filo/')) {
    // Granular `.filo/` classification. The renderer's exhaustive
    // dispatcher routes each kind to its dedicated reconciler
    // (`tagsJsonReconciler`, `themeJsonReconciler`, etc.). Anything else
    // stays plain `config` so dispatch can no-op cleanly.
    if (relativePath === '.filo/tags.json') return 'config-tags';
    if (relativePath.startsWith('.filo/themes/')) return 'config-theme';
    if (relativePath.startsWith('.filo/templates/')) return 'config-template';
    return 'config';
  }

  // Case-fold the `.board.json` match (mirrors `scanBoardFiles`
  // + the `.md`/`.txt` extname check below, which already lowercase). An
  // externally-renamed board whose extension casing diverged would otherwise be
  // routed to `tree` instead of `board`, skipping the board reconciler.
  if (relativePath.toLowerCase().endsWith('.board.json')) {
    return 'board';
  }

  const lowerExt = extname(relativePath).toLowerCase();

  // `.markdown` matches `.md` (the renderer's `isMarkdownExtension` accepts
  // both); reconciliation and conflict resolution hang off `document`.
  // `.txt` is a `document` too so an external `Notes.txt` → `Notes.md`
  // rename pairs through `correlateRenames` instead of surfacing as a
  // delete + create that breaks every tile pointing at the file.
  if (lowerExt === '.md' || lowerExt === '.markdown' || lowerExt === '.txt') {
    return 'document';
  }

  // Media files participate in rename correlation whether they live
  // under `attachments/` or anywhere else in the vault. The folder
  // prefix is kept as a fallback so a user-defined extension we haven't
  // listed (e.g. `.heic`) still classifies correctly when placed under
  // `attachments/`.
  if (MEDIA_EXTENSIONS.has(lowerExt) || relativePath.startsWith('attachments/')) {
    return 'attachment';
  }

  return 'tree';
}

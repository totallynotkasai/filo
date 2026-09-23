import { extname } from 'path';
import type { FileChangeType } from './fileWatcherTypes';

/**
 * Path classification + ignore rules for the vault file watcher.
 *
 * Audit-14 6.1 — extracted from `fileWatcher.ts` (which was sitting at the
 * 1000-LOC ceiling with no allowlist headroom) so the watcher's event
 * MECHANICS (debounce, suppression, reconcile walk, emit) and its "what IS
 * this path / should we ignore it" DECISION logic live in separate files.
 * None of this logic reads watcher instance state, so it is a set of pure
 * module functions the `FileWatcher` class calls.
 */

/**
 * Phase 31 B2.3 — per-segment matching rather than `string.includes`. The
 * legacy substring check matched `Article on Thumbs.db.md` because the
 * basename contains the literal "Thumbs.db" — which is a real-world title
 * pattern users have hit. We now split the relative path by `/` and apply
 * one rule per segment.
 *
 *  - `exactNames`: a segment whose entire string equals the pattern (e.g.
 *    `Thumbs.db`, `.DS_Store`). `Article on Thumbs.db.md` is no longer
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
 * the folder they live in. Phase 19 S4 — before this set existed, only files
 * under `attachments/` participated in rename correlation. An OS-level move
 * of `hero.jpg` from the vault root to `media/` produced two `'tree'` events
 * which the correlator ignores, so every tile pointing at the file silently
 * dangled.
 *
 * Keeps the same coverage as `mime.getMimeType`'s media types — anything the
 * media-tile reader could serve is something a user might place outside
 * `attachments/` and expect rename propagation for.
 */
const MEDIA_EXTENSIONS = new Set<string>([
  // Images (Phase 31 C3.8 adds .heic/.heif/.avif — modern Apple + browser
  // capture formats users drag in from Photos.app and screenshots)
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp',
  '.heic', '.heif', '.avif',
  // Video
  '.mp4', '.webm', '.ogv', '.mov',
  // Audio (Phase 31 C3.8 adds .opus, .mid, .midi — Opus is the modern
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
    // Phase 3 / 3.2 — granular `.filo/` classification. The renderer's
    // exhaustive dispatcher then routes each kind to its dedicated
    // reconciler (`tagsJsonReconciler`, `themeJsonReconciler`, etc.).
    // Anything that doesn't match a granular subtype keeps the legacy
    // `config` classification so dispatch can no-op cleanly.
    if (relativePath === '.filo/tags.json') return 'config-tags';
    if (relativePath.startsWith('.filo/themes/')) return 'config-theme';
    if (relativePath.startsWith('.filo/templates/')) return 'config-template';
    return 'config';
  }

  // Audit-15 P1.3 — case-fold the `.board.json` match (mirrors `scanBoardFiles`
  // + the `.md`/`.txt` extname check below, which already lowercase). An
  // externally-renamed board whose extension casing diverged would otherwise be
  // routed to `tree` instead of `board`, skipping the board reconciler.
  if (relativePath.toLowerCase().endsWith('.board.json')) {
    return 'board';
  }

  const lowerExt = extname(relativePath).toLowerCase();

  // Phase 31 B2.6 — treat `.markdown` the same as `.md`. The renderer's
  // `isMarkdownExtension` (src/renderer/lib/vault/extension.ts) accepts
  // both spellings for tile creation; classifyChange used to accept only
  // `.md`, which meant the watcher missed external edits to `.markdown`
  // files entirely. Reconciliation, conflict resolution, and the bulk
  // toast aggregator all hang off the `document` classification.
  //
  // Phase 7 (IMPLEMENTATION_PLAN_2026-05-27) — promote `.txt` to
  // `'document'` so external `.txt` ↔ `.md` renames in a text editor
  // pair through `correlateRenames` (already accepts both via
  // `TEXT_LIKE_EXTENSIONS`). Without this promotion `.txt` events were
  // classified as `'tree'` and skipped the same-basename / cross-basename
  // correlation passes, so a `Notes.txt` → `Notes.md` rename surfaced as
  // a delete + create and broke every tile pointing at the file.
  if (lowerExt === '.md' || lowerExt === '.markdown' || lowerExt === '.txt') {
    return 'document';
  }

  // S4: media files participate in rename correlation whether they live
  // under `attachments/` or anywhere else in the vault. The legacy folder
  // prefix is kept as a fallback so a user-defined extension we haven't
  // listed (e.g. `.heic`) still classifies correctly when placed under
  // `attachments/`.
  if (MEDIA_EXTENSIONS.has(lowerExt) || relativePath.startsWith('attachments/')) {
    return 'attachment';
  }

  return 'tree';
}

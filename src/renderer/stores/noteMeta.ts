/**
 * noteMeta — read a note's title, tags and frontmatter by vault path.
 *
 * The `.md` file is the only copy of a note's metadata; boards store just the
 * path. These selectors are what every view reads instead of a board copy:
 *
 * - An open note (or one whose frontmatter an edit has seeded) answers from
 *   the document store's live frontmatter, so an edit shows before its
 *   debounced write lands.
 * - Anything else answers from the vault index, which the write gateway
 *   refreshes after each write and the watcher refreshes after each external
 *   change.
 *
 * Reactive: a `$derived` that calls these re-runs when either source changes.
 */
import { documentStore } from './document.svelte';
import { vaultIndexStore } from './vaultIndex.svelte';
import { orderPreservingTagsField } from '../lib/utils/normalizeTagsField';

const EMPTY: Readonly<Record<string, unknown>> = Object.freeze({});

/** The filename without its folder or Markdown extension. */
export function noteStem(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.(md|markdown)$/i, '');
}

/** The note's frontmatter: the live cache when seeded, else the vault index. */
export function noteFrontmatter(path: string): Readonly<Record<string, unknown>> {
  if (!path) return EMPTY;
  const live = documentStore.getFrontmatter(path);
  if (live) return live;
  return (vaultIndexStore.getMetadata(path)?.frontmatter as Record<string, unknown> | undefined) ?? EMPTY;
}

/** Frontmatter `title` when it is a non-empty string, else `null`. */
export function titleFromFrontmatter(fm: Readonly<Record<string, unknown>>): string | null {
  const t = fm.title;
  return typeof t === 'string' && t.trim().length > 0 ? t.trim() : null;
}

/** The note's title: frontmatter `title:`, or the filename stem without one. */
export function noteTitle(path: string): string {
  if (!path) return '';
  return titleFromFrontmatter(noteFrontmatter(path)) ?? noteStem(path);
}

/** The note's tags from frontmatter `tags:`, in the order the file lists them. */
export function noteTags(path: string): string[] {
  if (!path) return [];
  return orderPreservingTagsField(noteFrontmatter(path).tags);
}

type MediaTagsReader = (path: string) => string[];
let mediaTagsReader: MediaTagsReader = () => [];

/**
 * Installs the reader for media-file tags (`.filo/tags.json:fileTags`). The
 * tags store owns that file and registers itself at module load; routing it
 * through here keeps tile derivation free of an import cycle through it.
 */
export function registerMediaTagsReader(reader: MediaTagsReader): void {
  mediaTagsReader = reader;
}

/** Tags on an image, video, audio or generic file: its only copy is tags.json. */
export function mediaTags(path: string): string[] {
  if (!path) return [];
  return mediaTagsReader(path);
}

/**
 * The title a board def shows: its note's title for a text tile, the def's
 * own caption for everything else.
 */
export function defTitle(def: { type: string; filePath?: string; title?: string }): string {
  if (def.type === 'text') return noteTitle(def.filePath ?? '');
  return def.title ?? '';
}

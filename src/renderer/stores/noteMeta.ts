/**
 * noteMeta — read a note's title, tags and frontmatter by vault path.
 *
 * The `.md` file is the only copy of a note's metadata; boards store just the
 * path. These selectors are what every view reads instead of a board copy:
 *
 * - An open note answers from its note model, so an edit shows before its
 *   debounced write lands.
 * - Anything else answers from the vault index (which the note writer
 *   refreshes after each write and the watcher after each external change),
 *   with any queued frontmatter change laid over it.
 *
 * Reactive: a `$derived` that calls these re-runs when either source changes.
 */
import { noteStore } from './notes.svelte';
import { vaultStore } from './vault.svelte';
import { GENERAL_SETTINGS_DEFAULTS } from '../../shared/generalSettingsDefaults';
import { orderPreservingTagsField } from '../lib/utils/normalizeTagsField';
import { splitFrontmatterSource } from '../lib/vault/frontmatterRead';
import { frontmatterSourceProblem } from '../lib/vault/frontmatterCstModel';
import { vaultIndexStore } from './vaultIndex.svelte';

const EMPTY: Readonly<Record<string, unknown>> = Object.freeze({});

/** The filename without its folder or Markdown extension. */
export function noteStem(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.(md|markdown)$/i, '');
}

/** The note's frontmatter: its model when loaded, else the vault index. */
export function noteFrontmatter(path: string): Readonly<Record<string, unknown>> {
  if (!path) return EMPTY;
  return noteStore.frontmatter(path);
}

/**
 * The note's body (no frontmatter): its model's when loaded, so unsaved typing
 * shows, else the vault index's copy of the file.
 */
export function noteBody(path: string): string {
  if (!path) return '';
  const m = noteStore.get(path);
  if (m && m.status !== 'loading') return m.body;
  return vaultIndexStore.getMetadata(path)?.content ?? '';
}

/**
 * Whether the note's fields are known yet: its model has loaded, or the vault
 * index holds it. False for a note the vault-open read hasn't reached.
 */
export function noteFieldsKnown(path: string): boolean {
  if (!path) return true;
  const m = noteStore.get(path);
  if (m && m.status !== 'loading') return true;
  return vaultIndexStore.getMetadata(path) !== null;
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

/**
 * Why a metadata edit of the note can't land, or null when it can (see
 * `frontmatterSourceProblem`): judged on the bytes its model was built on
 * when open, else the vault index's copy of its frontmatter.
 */
export function noteFrontmatterProblem(path: string): 'unparseable' | 'not-properties' | null {
  if (!path) return null;
  const base = noteStore.get(path)?.base;
  const source = base
    ? splitFrontmatterSource(base.rawText).rawFrontmatter
    : (vaultIndexStore.getMetadata(path)?.rawFrontmatter ?? '');
  return frontmatterSourceProblem(source);
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

/**
 * Line spacings the toolbar and Settings → General offer; a note may hold any
 * value in the sane range. Every choice must sit inside that range.
 */
export const LINE_SPACING_CHOICES: readonly number[] = [1.0, 1.15, 1.5, 1.75, 2.0, 2.5, 3.0];
const MIN_LINE_SPACING = 0.8;
const MAX_LINE_SPACING = 4;

/** A spacing as the pickers show it: `1.0`, `1.15`, `2.0`. */
export function formatLineSpacing(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
}

function inRange(value: number): boolean {
  return Number.isFinite(value) && value >= MIN_LINE_SPACING && value <= MAX_LINE_SPACING;
}

/**
 * The note's line spacing from frontmatter `lineSpacing:` (a number, or a
 * numeric string written by hand), or `null` when it has none or the value is
 * out of range. `null` means the note follows the project default.
 */
export function noteLineSpacing(path: string): number | null {
  if (!path) return null;
  const raw = noteFrontmatter(path).lineSpacing;
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
  return inRange(value) ? value : null;
}

/** Settings → General "Default line spacing", or the schema default without a vault. */
export function projectLineSpacing(): number {
  const value = vaultStore.project?.settings?.general?.defaultLineSpacing;
  return typeof value === 'number' && inRange(value) ? value : GENERAL_SETTINGS_DEFAULTS.defaultLineSpacing;
}

/**
 * The spacing every view of the note uses: its own `lineSpacing:` first, else
 * the project default. One helper, so a Document tab and a text tile of the
 * same note never disagree.
 */
export function resolveLineSpacing(path: string): number {
  return noteLineSpacing(path) ?? projectLineSpacing();
}

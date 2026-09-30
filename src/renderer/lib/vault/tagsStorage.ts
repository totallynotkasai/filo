/**
 * tagsStorage — pure logic for mutating `.filo/tags.json`.
 *
 * No Svelte runes, no IPC: callers are responsible for loading the file
 * (via `tags:load` IPC), passing it in, applying a mutation, and persisting
 * the result back (via `tags:save`).
 *
 * Name = canonical identifier. Tag definitions live keyed by name; file→tag
 * lookups also key by name. Renaming/deleting a tag requires walking
 * `fileTags` to keep references consistent.
 */

import { parse as parseYaml } from 'yaml';
import type { TagsFile, TagDefinition } from '../../schema/tagsFile';
import {
  TagsFileSchema,
  migrateTagsFile,
  CURRENT_TAGS_FILE_VERSION,
} from '../../schema/tagsFile';
import { ACCENT_COLOR } from '../../constants/defaults';
import { reportError } from '../utils/errorBus';
import { vaultPath, type VaultPath } from '@shared/vaultPath';
import { loadVersionedFile } from './loadVersionedFile';

/**
 * Returns an empty, valid `TagsFile`. Used when a vault has no
 * `.filo/tags.json` on disk yet.
 */
export function emptyTagsFile(): TagsFile {
  return { version: 1, tags: {}, fileTags: {} };
}

/**
 * Result of {@link loadTagsFile}. `file` is always usable; the three flags
 * signal that the on-disk bytes are ones this build must NOT re-save:
 *
 *  - `fromFuture`     — the file declares a version newer than
 *                       {@link CURRENT_TAGS_FILE_VERSION}. An older build
 *                       that re-saved it would silently downgrade the format.
 *  - `noMigrationPath`— the version is older than (or a fractional value
 *                       below) anything this build can migrate forward.
 *  - `corrupt`        — the file failed JSON parse or schema validation. The
 *                       in-memory registry falls back to EMPTY (the app must
 *                       run), but the on-disk bytes may be hand-recoverable, so
 *                       the caller must NOT overwrite them this session
 *                       (otherwise post-commit FM tag-seeding would save the
 *                       empty registry over it within ~300 ms of opening).
 *
 * When ANY flag is set the caller (`fileTagsStore`) puts the tag store into
 * read-only mode so the newer / unknown / corrupt file is preserved verbatim.
 * Mirrors `boardLoader`'s `from-future` / `no-migration-path` handling.
 */
export interface LoadTagsFileResult {
  file: TagsFile;
  fromFuture: boolean;
  noMigrationPath: boolean;
  corrupt: boolean;
}

/**
 * Loads a raw `.filo/tags.json` string, routing it through the version
 * migrator (`migrateTagsFile`) BEFORE schema validation so a from-future or
 * un-migratable file is detected rather than silently re-saved at the
 * current version. Returns an empty file on JSON / schema failure so a
 * corrupted tags file never bricks a vault open. A from-future file surfaces
 * a friendly "from a newer version" message and read-only flags, so an older
 * build never silently downgrades it.
 *
 * Keys in `fileTags` are folded through `normalizeVaultRelative` on load so
 * an older tags.json stored with case-preserving keys (`Notes/Foo.md`)
 * becomes the canonical form (`notes/foo.md`). If two
 * mixed-case keys collide after folding (e.g. `Notes/Foo.md` + `notes/foo.md`
 * both existed in a hand-edited file), the tag arrays are unioned so no
 * tag is silently dropped.
 */
export function loadTagsFile(raw: string | null | undefined): LoadTagsFileResult {
  if (!raw) return { file: emptyTagsFile(), fromFuture: false, noMigrationPath: false, corrupt: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // `corrupt: true` gates the save so the unreadable-but-
    // recoverable bytes are preserved verbatim this session (not overwritten by
    // the empty registry). Copy says "preserved, not saved", not "reset to empty"
    // — the disk file is intact, only the in-memory registry is empty.
    reportError(
      'tagsStorage.parse',
      err,
      '.filo/tags.json is not valid JSON — your tags are shown as empty this session, but the file on disk is preserved (not overwritten) so you can repair it.',
    );
    return { file: emptyTagsFile(), fromFuture: false, noMigrationPath: false, corrupt: true };
  }

  // Route through the shared migrate→validate helper so
  // the from-future / no-migration-path short-circuits (and the
  // migrate-before-parse ordering) are identical across every versioned
  // config loader. `parsed` is the original JSON value; for the
  // from-future / no-migration branches the migrator passes it through
  // unchanged, so `bestEffortParse(parsed)` shows the user's existing tags
  // read-only without re-deriving the migrated shape.
  const loaded = loadVersionedFile(TagsFileSchema, migrateTagsFile, parsed);

  if (loaded.status === 'from-future') {
    reportError(
      'tagsStorage.fromFuture',
      null,
      `.filo/tags.json was saved by a newer version of Filo (file version ${loaded.migratedFrom}, ` +
        `this build understands up to ${CURRENT_TAGS_FILE_VERSION}). Tag changes won't be saved this ` +
        'session so the newer file is not downgraded — update Filo to edit tags again.',
    );
    return { file: bestEffortParse(parsed), fromFuture: true, noMigrationPath: false, corrupt: false };
  }

  if (loaded.status === 'no-migration-path') {
    reportError(
      'tagsStorage.noMigrationPath',
      null,
      `.filo/tags.json declares an unrecognized format version (${loaded.migratedFrom}). Tag changes ` +
        "won't be saved this session so the file isn't corrupted — restore an earlier copy from your backup.",
    );
    return { file: bestEffortParse(parsed), fromFuture: false, noMigrationPath: true, corrupt: false };
  }

  if (loaded.status === 'ok') {
    return { file: migrateFileTagKeys(loaded.data), fromFuture: false, noMigrationPath: false, corrupt: false };
  }

  // Schema failure is the second corrupt-but-recoverable branch
  // (valid JSON, wrong shape, e.g. `tags: "oops"`). `corrupt: true` preserves the
  // bytes for the session; copy mirrors the parse-fail branch (preserved, not reset).
  reportError(
    'tagsStorage.schema',
    loaded.error,
    '.filo/tags.json failed schema validation — your tags are shown as empty this session, but the file on disk is preserved (not overwritten) so you can repair it.',
  );
  return { file: emptyTagsFile(), fromFuture: false, noMigrationPath: false, corrupt: true };
}

/**
 * Best-effort parse used for the from-future / no-migration-path branches:
 * keep showing the user's existing tags (read-only) when the shape still
 * validates, fall back to empty when it doesn't. The caller's read-only
 * gate prevents either outcome from being written back to disk.
 */
function bestEffortParse(data: unknown): TagsFile {
  const result = TagsFileSchema.safeParse(data);
  return result.success ? migrateFileTagKeys(result.data) : emptyTagsFile();
}

/**
 * Parses a raw JSON string into a TagsFile. Returns an empty file on parse
 * failure so a corrupted tags file never bricks a vault open.
 *
 * Thin back-compat wrapper over {@link loadTagsFile} for read-only callers
 * (external-change reconcilers, tests) that don't persist the tag store and
 * therefore can't downgrade a from-future file.
 */
export function parseTagsFile(raw: string | null | undefined): TagsFile {
  return loadTagsFile(raw).file;
}

/**
 * Keys in `fileTags` are `VaultPath`s
 * (separator-normalised + lowercased) so a rename that crosses a
 * case-difference (`Notes/Foo.md` → `notes/foo.md`, the typical Windows /
 * macOS shape from OS file events) resolves to the same entry.
 *
 * Implication for the on-disk `.filo/tags.json` format: keys are stored
 * lowercased. A human reading the file sees `notes/foo.md` rather than
 * the file's actual `Notes/Foo.md`. The vault index and any UI surface
 * still shows the case-preserved name from the filesystem itself, so
 * the user-visible representation is unaffected.
 */
function migrateFileTagKeys(file: TagsFile): TagsFile {
  let mutated = false;
  const next: Record<string, string[]> = {};
  for (const [key, tagArr] of Object.entries(file.fileTags)) {
    const canonical = vaultPath(key);
    if (canonical !== key) mutated = true;
    const existing = next[canonical];
    if (existing) {
      // Two pre-migration keys folded to the same canonical form (rare —
      // typically only happens if someone hand-edited the file).
      // Union the tag arrays so neither entry's tags are lost.
      const merged = Array.from(new Set([...existing, ...tagArr]));
      if (merged.length !== existing.length) mutated = true;
      next[canonical] = merged;
    } else {
      next[canonical] = tagArr;
    }
  }
  if (!mutated) return file;
  return { ...file, fileTags: next };
}

/**
 * Returns the list of tag names assigned to the given vault-relative file
 * path. Returns an empty array if the file has no tags.
 */
export function tagsForFile(file: TagsFile, path: string): string[] {
  return file.fileTags[vaultPath(path)] ?? [];
}

/**
 * Returns every vault-relative path that carries the given tag name.
 */
export function filesForTag(file: TagsFile, tagName: string): string[] {
  const out: string[] = [];
  for (const [path, tagArr] of Object.entries(file.fileTags)) {
    if (tagArr.includes(tagName)) out.push(path);
  }
  return out;
}

/**
 * Returns the set of all known tag names (definitions + any tag observed in
 * fileTags). Sorted alphabetically.
 */
export function allTagNames(file: TagsFile): string[] {
  const set = new Set<string>(Object.keys(file.tags));
  for (const tagArr of Object.values(file.fileTags)) {
    for (const t of tagArr) set.add(t);
  }
  return Array.from(set).sort();
}

/**
 * Returns the definition for a tag name, or a synthesized default-colour
 * definition if the tag has no explicit entry yet.
 */
export function getTagDefinition(file: TagsFile, tagName: string): TagDefinition {
  return file.tags[tagName] ?? { color: ACCENT_COLOR };
}

/**
 * A typed tag name as Filo stores it: trimmed, a single leading `#` dropped,
 * and each run of internal whitespace made one space, so `Book  1` and
 * `Book 1` can't become two tags.
 */
export function cleanTagName(name: string): string {
  return name.trim().replace(/^#/, '').replace(/\s+/g, ' ');
}

/**
 * Validates a candidate tag name: not empty after trim/`#` strip, and no
 * line break or tab. Spaces inside a name are fine (`Book 1`): tags are
 * separated by commas only, and a YAML list item keeps its spaces.
 * Hierarchy separators (`/`) and hyphens / underscores are fine too.
 */
export function isValidTagName(name: string): boolean {
  const stripped = name.trim().replace(/^#/, '');
  if (!stripped) return false;
  if (/[\t\n\r\f\v]/.test(stripped)) return false;
  return true;
}

/**
 * Stricter validation for a tag name the USER is creating or renaming TO
 * Beyond {@link isValidTagName} (empty / line break / tab), rejects:
 *  - a comma, which separates tags in the tag row and in a `tags: a, b` string;
 *  - a run of spaces (`cleanTagName` collapses one before this is asked);
 *  - any name YAML reads as a NON-string scalar — numbers (`123`, `2024`),
 *    booleans (`true`/`false`), `null`;
 *  - any name starting with a YAML indicator char (`@ \` * & ! % | > : ?`); and
 *  - any name that fails to parse as a bare scalar (`,` `[` `{` etc.).
 *
 * The frontmatter rewriter quotes emitted scalars, so such names
 * are SAFE on disk — this guard exists only to stop the user MINTING confusing
 * tags at the input boundary. It is deliberately NOT used by `ensureTag` or
 * other programmatic paths, so a tag that already exists in a file (e.g. a
 * legacy numeric tag authored elsewhere) is never re-validated or disturbed.
 */
export function isSafeNewTagName(name: string): boolean {
  if (!isValidTagName(name)) return false;
  const stripped = name.trim().replace(/^#/, '');
  if (stripped.includes(',') || /\s\s/.test(stripped)) return false;
  // A YAML parser throws on most leading indicators, but `:` / `?` load as
  // plain strings — reject the whole set explicitly. (`#` is
  // already stripped above as the tag-syntax convenience.)
  if (/^[@`*&!%|>:?]/.test(stripped)) return false;
  // Other YAML readers (Obsidian's among them) take a binary integer as a
  // number; the core schema below reads it as a string.
  if (/^[-+]?0b[01_]+$/.test(stripped)) return false;
  let loaded: unknown;
  try {
    // This validates a single bare tag-name token, NOT a frontmatter block.
    // The core schema plus timestamps reads `2024`, `true`, `null` and
    // `2024-01-01` as non-strings, so the guard rejects them as confusing new
    // tag names, while `on` / `yes` / `no` (booleans only in YAML 1.1) stay
    // allowed.
    loaded = parseYaml(stripped, { customTags: ['timestamp'] });
  } catch {
    return false;
  }
  return typeof loaded === 'string' && loaded === stripped;
}

/**
 * Tags are case-preserving but case-insensitive for identity. When a name
 * with the same case-folded value already exists in the registry, return
 * that canonical casing so we don't accidentally create `Project` and
 * `project` as two separate tags. Matches the case-insensitive lookup
 * semantics in `frontmatterSync.valuesEqual`.
 *
 * Also normalises the input: trim, strip a single leading `#`. Inner spacing
 * is left as it is, so a tag another program wrote with two spaces can still
 * be found and removed. Returns `''` for invalid input (empty after the
 * strip, or a line break or tab) so callers can rely on a single truthy check
 * before mutating state.
 */
export function canonicaliseTagName(file: TagsFile, name: string): string {
  const stripped = name.trim().replace(/^#/, '');
  if (!isValidTagName(stripped)) return '';
  // Pin to en-US locale for tag-identity case-folding: the HOST locale would
  // split `Important` and `important` on a Turkish system (`I` → `ı`).
  const folded = stripped.toLocaleLowerCase('en-US');
  for (const existing of Object.keys(file.tags)) {
    if (existing.toLocaleLowerCase('en-US') === folded) return existing;
  }
  for (const tagArr of Object.values(file.fileTags)) {
    for (const existing of tagArr) {
      if (existing.toLocaleLowerCase('en-US') === folded) return existing;
    }
  }
  return stripped;
}

/**
 * Adds a tag to a file's tag list. Idempotent; ensures the tag has a
 * definition entry so the colour resolver always finds it. Returns a new
 * TagsFile (does not mutate the input).
 *
 * Identity is case-insensitive: if the registry already knows a tag whose
 * case-folded name matches the input, the existing casing is preserved
 * (first-seen wins). This keeps `Project` and `project` from coexisting as
 * separate tags when the user types them inconsistently across surfaces.
 */
export function addTagToFile(file: TagsFile, path: string, tagName: string): TagsFile {
  const key = vaultPath(path);
  const canonical = canonicaliseTagName(file, tagName);
  if (!canonical) return file;
  const existing = file.fileTags[key] ?? [];
  const nextTags = existing.includes(canonical) ? existing : [...existing, canonical];
  const nextDefs = file.tags[canonical]
    ? file.tags
    : { ...file.tags, [canonical]: { color: ACCENT_COLOR, createdAt: Date.now() } };
  return {
    ...file,
    tags: nextDefs,
    fileTags: { ...file.fileTags, [key]: nextTags },
  };
}

/**
 * Removes a tag from a file's tag list. If the file ends up with no tags,
 * the entry is pruned. Returns a new TagsFile.
 */
export function removeTagFromFile(file: TagsFile, path: string, tagName: string): TagsFile {
  const key = vaultPath(path);
  const existing = file.fileTags[key];
  if (!existing || !existing.includes(tagName)) return file;
  const nextTags = existing.filter((t) => t !== tagName);
  const nextFileTags = { ...file.fileTags };
  if (nextTags.length === 0) delete nextFileTags[key];
  else nextFileTags[key] = nextTags;
  return { ...file, fileTags: nextFileTags };
}

/**
 * Replaces a file's tag list outright. Used by the vault-open migration
 * and by external-edit reconciliation when frontmatter changes.
 *
 * Routes each incoming tag through `canonicaliseTagName` so that external
 * edits which introduce a case variant of an existing tag don't fragment
 * the registry (e.g. `tags: [Project]` in frontmatter on top of an
 * existing `project` tag keeps `project`, not both).
 */
export function setFileTags(file: TagsFile, path: string, tags: string[]): TagsFile {
  const key = vaultPath(path);
  let working = file;
  const canonical: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const c = canonicaliseTagName(working, raw);
    if (!c || seen.has(c.toLowerCase())) continue;
    seen.add(c.toLowerCase());
    canonical.push(c);
    // Each iteration uses the latest `working` so that two newly-introduced
    // case variants in the same call collapse to one entry.
    if (!working.tags[c]) {
      working = { ...working, tags: { ...working.tags, [c]: { color: ACCENT_COLOR, createdAt: Date.now() } } };
    }
  }
  const nextFileTags = { ...working.fileTags };
  if (canonical.length === 0) {
    delete nextFileTags[key];
  } else {
    nextFileTags[key] = canonical;
  }
  return { ...working, fileTags: nextFileTags };
}

/**
 * Renames every occurrence of a tag (definition + fileTags references).
 * If `newName` already exists, the two definitions are merged (target wins
 * on colour) and both name's fileTags entries are unioned.
 *
 * Returns the new TagsFile plus the list of paths whose tag list changed,
 * so the caller can mirror the change back to .md frontmatter.
 */
export function renameTag(
  file: TagsFile,
  oldName: string,
  newName: string,
): { file: TagsFile; touchedPaths: string[] } {
  const next = newName.trim();
  if (!oldName || !next || oldName === next) {
    return { file, touchedPaths: [] };
  }
  const nextDefs = { ...file.tags };
  const oldDef = nextDefs[oldName];
  if (oldDef) {
    delete nextDefs[oldName];
    nextDefs[next] = nextDefs[next] ?? oldDef;
  }
  const nextFileTags: Record<string, string[]> = {};
  const touched: string[] = [];
  for (const [path, tagArr] of Object.entries(file.fileTags)) {
    if (!tagArr.includes(oldName)) {
      nextFileTags[path] = tagArr;
      continue;
    }
    const rewritten = Array.from(new Set(tagArr.map((t) => (t === oldName ? next : t))));
    nextFileTags[path] = rewritten;
    touched.push(path);
  }
  return { file: { ...file, tags: nextDefs, fileTags: nextFileTags }, touchedPaths: touched };
}

/**
 * Deletes a tag definition and removes it from every file's tag list.
 * Returns the new TagsFile plus the list of paths that lost the tag.
 */
export function deleteTag(file: TagsFile, tagName: string): { file: TagsFile; touchedPaths: string[] } {
  if (!tagName || !(tagName in file.tags || hasFileTag(file, tagName))) {
    return { file, touchedPaths: [] };
  }
  const nextDefs = { ...file.tags };
  delete nextDefs[tagName];
  const nextFileTags: Record<string, string[]> = {};
  const touched: string[] = [];
  for (const [path, tagArr] of Object.entries(file.fileTags)) {
    if (!tagArr.includes(tagName)) {
      nextFileTags[path] = tagArr;
      continue;
    }
    const filtered = tagArr.filter((t) => t !== tagName);
    if (filtered.length > 0) nextFileTags[path] = filtered;
    touched.push(path);
  }
  return { file: { ...file, tags: nextDefs, fileTags: nextFileTags }, touchedPaths: touched };
}

/**
 * Sets a tag's colour. Creates the definition if it doesn't exist yet.
 */
export function setTagColor(file: TagsFile, tagName: string, color: string): TagsFile {
  if (!tagName) return file;
  const existing = file.tags[tagName] ?? { color, createdAt: Date.now() };
  return {
    ...file,
    tags: { ...file.tags, [tagName]: { ...existing, color } },
  };
}

/**
 * Removes a file's entire entry — used when the file itself is deleted from
 * the vault. Pure helper for the watcher's cascade-delete path.
 */
export function dropFile(file: TagsFile, path: string): TagsFile {
  const key = vaultPath(path);
  if (!(key in file.fileTags)) return file;
  const nextFileTags = { ...file.fileTags };
  delete nextFileTags[key];
  return { ...file, fileTags: nextFileTags };
}

/**
 * Rewrites a file's key after a rename — used by the rename-propagation path
 * so `fileTags['old.md']` becomes `fileTags['new.md']` with the same tags.
 */
export function renameFile(file: TagsFile, oldPath: string, newPath: string): TagsFile {
  const oldKey = vaultPath(oldPath);
  const newKey = vaultPath(newPath);
  if (oldKey === newKey || !(oldKey in file.fileTags)) return file;
  const tags = file.fileTags[oldKey];
  if (tags === undefined) return file; // oldKey is present (checked above)
  const next = { ...file.fileTags };
  delete next[oldKey];
  next[newKey] = tags;
  return { ...file, fileTags: next };
}

/**
 * Folder rename — rewrites every fileTags key whose path is nested under
 * `oldPrefix` so it sits under `newPrefix` instead. Exact-match keys (e.g.
 * the folder itself if it ever had tags, which folders never do today) are
 * also handled symmetrically with `renameFile`.
 *
 * Pure: returns a new TagsFile when at least one key is rewritten, otherwise
 * the input reference unchanged.
 */
export function renameFolderInTags(file: TagsFile, oldPrefix: string, newPrefix: string): TagsFile {
  const oldKey = vaultPath(oldPrefix);
  const newKey = vaultPath(newPrefix);
  if (!oldKey || !newKey || oldKey === newKey) return file;
  const oldChild = `${oldKey}/`;
  const next: Record<string, string[]> = {};
  let changed = false;
  for (const [key, tags] of Object.entries(file.fileTags)) {
    if (key === oldKey) {
      next[newKey] = tags;
      changed = true;
      continue;
    }
    if (key.startsWith(oldChild)) {
      next[`${newKey}/${key.slice(oldChild.length)}`] = tags;
      changed = true;
      continue;
    }
    next[key] = tags;
  }
  return changed ? { ...file, fileTags: next } : file;
}

/**
 * Folder delete — drops every fileTags entry nested under `prefix` (and the
 * exact-match entry if any). Used by the cascade-delete path when the user
 * removes a folder containing tagged files.
 */
export function dropFolderInTags(file: TagsFile, prefix: string): TagsFile {
  const key = vaultPath(prefix);
  if (!key) return file;
  const child = `${key}/`;
  const next: Record<string, string[]> = {};
  let changed = false;
  for (const [k, tags] of Object.entries(file.fileTags)) {
    if (k === key || k.startsWith(child)) {
      changed = true;
      continue;
    }
    next[k] = tags;
  }
  return changed ? { ...file, fileTags: next } : file;
}

/**
 * Drops every `fileTags` entry whose vault-relative path is
 * NOT in `knownPaths`, and every entry for a Markdown note. Used to prune
 * stale entries left behind by external file deletions / moves that the
 * watcher missed (e.g. the app was closed while an attachment was deleted
 * from the OS file explorer). A note's tags live in its own frontmatter, so
 * a `.md` key here is never a tag's home. The lookup is case-insensitive to
 * match `flattenTreePaths`'s producer convention.
 *
 * `keep` names entries to leave alone although their file is missing (a
 * rename still to be finished moves them later).
 *
 * Returns `{ file, droppedPaths }`. `file === input` when nothing changed
 * so callers can skip a scheduleSave.
 */
export function pruneFileTagsAgainstKnownPaths(
  file: TagsFile,
  knownPaths: ReadonlySet<string>,
  keep: (path: string) => boolean = () => false,
): { file: TagsFile; droppedPaths: string[] } {
  const known = new Set<VaultPath>();
  for (const p of knownPaths) known.add(vaultPath(p));

  const droppedPaths: string[] = [];
  const nextFileTags: Record<string, string[]> = {};
  for (const [key, tagArr] of Object.entries(file.fileTags)) {
    const norm = vaultPath(key);
    if ((known.has(norm) || keep(key)) && !/\.(md|markdown)$/.test(norm)) {
      nextFileTags[key] = tagArr;
      continue;
    }
    droppedPaths.push(key);
  }
  if (droppedPaths.length === 0) return { file, droppedPaths };
  return { file: { ...file, fileTags: nextFileTags }, droppedPaths };
}

function hasFileTag(file: TagsFile, tagName: string): boolean {
  for (const tagArr of Object.values(file.fileTags)) {
    if (tagArr.includes(tagName)) return true;
  }
  return false;
}

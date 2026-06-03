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

// allow-jsyaml: D1 tag-name minting guard (isSafeNewTagName) — intentional YAML-1.1 coercion, NOT a frontmatter read
import yaml from 'js-yaml';
import type { TagsFile, TagDefinition } from '../../schema/tagsFile';
import {
  TagsFileSchema,
  migrateTagsFile,
  CURRENT_TAGS_FILE_VERSION,
} from '../../schema/tagsFile';
import { ACCENT_COLOR } from '../../constants/defaults';
import { reportError } from '../utils/errorBus';
import { normalizeVaultRelative } from '../utils/path';
import { loadVersionedFile } from './loadVersionedFile';

/**
 * Returns an empty, valid `TagsFile`. Used when a vault has no
 * `.filo/tags.json` on disk yet.
 */
export function emptyTagsFile(): TagsFile {
  return { version: 1, tags: {}, fileTags: {} };
}

/**
 * Result of {@link loadTagsFile}. `file` is always usable; the two flags
 * signal that the on-disk version is one this build must NOT re-save:
 *
 *  - `fromFuture`     — the file declares a version newer than
 *                       {@link CURRENT_TAGS_FILE_VERSION}. An older build
 *                       that re-saved it would silently downgrade the format.
 *  - `noMigrationPath`— the version is older than (or a fractional value
 *                       below) anything this build can migrate forward.
 *
 * When either flag is set the caller (`fileTagsStore`) puts the tag store
 * into read-only mode so the newer/unknown file is preserved verbatim.
 * Mirrors `boardLoader`'s `from-future` / `no-migration-path` handling.
 */
export interface LoadTagsFileResult {
  file: TagsFile;
  fromFuture: boolean;
  noMigrationPath: boolean;
}

/**
 * Loads a raw `.filo/tags.json` string, routing it through the version
 * migrator (`migrateTagsFile`) BEFORE schema validation so a from-future or
 * un-migratable file is detected rather than silently re-saved at the
 * current version. Returns an empty file on JSON / schema failure so a
 * corrupted tags file never bricks a vault open.
 *
 * F6 (2026-05-28) — the migrator existed but had no callers; the loader
 * went straight to `safeParse`, so a `version: 99` file written by a future
 * Filo parsed clean and an older build re-saved it → silent downgrade. This
 * loader surfaces a friendly "from a newer version" message and hands the
 * caller the read-only flags so the file isn't clobbered.
 *
 * Phase 1 / 1.5 — keys in `fileTags` are folded through `normalizeVaultRelative`
 * on load so a pre-fix tags.json stored with case-preserving keys
 * (`Notes/Foo.md`) becomes the canonical form (`notes/foo.md`). If two
 * mixed-case keys collide after folding (e.g. `Notes/Foo.md` + `notes/foo.md`
 * both existed in a hand-edited file), the tag arrays are unioned so no
 * tag is silently dropped.
 */
export function loadTagsFile(raw: string | null | undefined): LoadTagsFileResult {
  if (!raw) return { file: emptyTagsFile(), fromFuture: false, noMigrationPath: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    reportError(
      'tagsStorage.parse',
      err,
      '.filo/tags.json is not valid JSON — tags reset to empty for this session',
    );
    return { file: emptyTagsFile(), fromFuture: false, noMigrationPath: false };
  }

  // F6 / Phase 4 E2 — route through the shared migrate→validate helper so
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
    return { file: bestEffortParse(parsed), fromFuture: true, noMigrationPath: false };
  }

  if (loaded.status === 'no-migration-path') {
    reportError(
      'tagsStorage.noMigrationPath',
      null,
      `.filo/tags.json declares an unrecognized format version (${loaded.migratedFrom}). Tag changes ` +
        "won't be saved this session so the file isn't corrupted — restore an earlier copy from your backup.",
    );
    return { file: bestEffortParse(parsed), fromFuture: false, noMigrationPath: true };
  }

  if (loaded.status === 'ok') {
    return { file: migrateFileTagKeys(loaded.data), fromFuture: false, noMigrationPath: false };
  }

  reportError(
    'tagsStorage.schema',
    loaded.error,
    '.filo/tags.json failed schema validation — tags reset to empty for this session',
  );
  return { file: emptyTagsFile(), fromFuture: false, noMigrationPath: false };
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

function migrateFileTagKeys(file: TagsFile): TagsFile {
  let mutated = false;
  const next: Record<string, string[]> = {};
  for (const [key, tagArr] of Object.entries(file.fileTags)) {
    const canonical = normalisePath(key);
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
  return file.fileTags[normalisePath(path)] ?? [];
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
 * Validates a candidate tag name. Reject names that would create surprising
 * state downstream: empty after trim/`#` strip, or internal whitespace
 * (frontmatter YAML splits on whitespace, so a tag with a space round-trips
 * as two separate tags). Hierarchy separators (`/`) and hyphens / underscores
 * are fine.
 */
export function isValidTagName(name: string): boolean {
  const stripped = name.trim().replace(/^#/, '');
  if (!stripped) return false;
  if (/\s/.test(stripped)) return false;
  return true;
}

/**
 * Stricter validation for a tag name the USER is creating or renaming TO
 * (1.5a). Beyond {@link isValidTagName} (empty / internal whitespace), rejects:
 *  - any name YAML reads as a NON-string scalar — numbers (`123`, `2024`),
 *    booleans (`true`/`false`), `null`;
 *  - any name starting with a YAML indicator char (`@ \` * & ! % | > : ?`); and
 *  - any name that fails to parse as a bare scalar (`,` `[` `{` etc.).
 *
 * The frontmatter rewriter quotes emitted scalars (1.5b / 1.6), so such names
 * are SAFE on disk — this guard exists only to stop the user MINTING confusing
 * tags at the input boundary. It is deliberately NOT used by `ensureTag` or
 * other programmatic paths, so a tag that already exists in a file (e.g. a
 * legacy numeric tag authored elsewhere) is never re-validated or disturbed.
 */
export function isSafeNewTagName(name: string): boolean {
  if (!isValidTagName(name)) return false;
  const stripped = name.trim().replace(/^#/, '');
  // js-yaml throws on most leading indicators, but `:` / `?` load as plain
  // strings — reject the whole set explicitly to match the plan. (`#` is
  // already stripped above as the tag-syntax convenience.)
  if (/^[@`*&!%|>:?]/.test(stripped)) return false;
  let loaded: unknown;
  try {
    // This validates a single bare tag-name token, NOT a frontmatter block.
    // DEFAULT_SCHEMA's YAML-1.1 coercion is the intent here: we WANT `2024` /
    // `true` / `null` to read as non-strings so the guard rejects them as
    // confusing new tag names. (Contrast the frontmatter readers, which are on
    // the `yaml` package and resolve no such 1.1 tags — see the import's
    // `// allow-jsyaml:` note and the `ci:no-jsyaml-in-frontmatter` gate.)
    loaded = yaml.load(stripped);
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
 * semantics in `vaultIndex.filesByTag` / `frontmatterSync.valuesEqual`.
 *
 * Also normalises the input: trim, strip a single leading `#`. Returns
 * `''` for invalid input (empty after strip, or containing internal
 * whitespace) so callers can rely on a single truthy check before
 * mutating state.
 */
export function canonicaliseTagName(file: TagsFile, name: string): string {
  const stripped = name.trim().replace(/^#/, '');
  if (!stripped || /\s/.test(stripped)) return '';
  // Phase 31 C3.7 — pin to en-US locale for tag-identity case-folding.
  // `toLocaleLowerCase()` with no args uses HOST locale which would split
  // `Important` and `important` on a Turkish system (`I` → `ı`). The
  // explicit `'en-US'` argument keeps tag identity portable across
  // machines and matches the Unicode default that the rest of the codebase
  // assumes. `toLowerCase()` would also work, but the explicit form
  // signals intent and guards against future drift.
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
  const key = normalisePath(path);
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
  const key = normalisePath(path);
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
  const key = normalisePath(path);
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
  const key = normalisePath(path);
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
  const oldKey = normalisePath(oldPath);
  const newKey = normalisePath(newPath);
  if (oldKey === newKey || !(oldKey in file.fileTags)) return file;
  const tags = file.fileTags[oldKey];
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
  const oldKey = normalisePath(oldPrefix);
  const newKey = normalisePath(newPrefix);
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
  const key = normalisePath(prefix);
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
 * Phase 23 M13 — drops every `fileTags` entry whose vault-relative path is
 * NOT in `knownPaths`. Used to prune stale entries left behind by external
 * file deletions / moves that the watcher missed (e.g. the app was closed
 * while an attachment was deleted from the OS file explorer). The lookup
 * is case-insensitive to match `flattenTreePaths`'s producer convention.
 *
 * Returns `{ file, droppedPaths }`. `file === input` when nothing changed
 * so callers can skip a scheduleSave.
 */
export function pruneFileTagsAgainstKnownPaths(
  file: TagsFile,
  knownPaths: ReadonlySet<string>,
): { file: TagsFile; droppedPaths: string[] } {
  const knownLower = new Set<string>();
  for (const p of knownPaths) knownLower.add(normalisePath(p).toLowerCase());

  const droppedPaths: string[] = [];
  const nextFileTags: Record<string, string[]> = {};
  for (const [key, tagArr] of Object.entries(file.fileTags)) {
    const norm = normalisePath(key).toLowerCase();
    if (knownLower.has(norm)) {
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

/**
 * Phase 1 / 1.5 — keys in `fileTags` are canonicalised through
 * `normalizeVaultRelative` (separator-normalised + lowercased) so a
 * rename that crosses a case-difference (`Notes/Foo.md` → `notes/foo.md`,
 * the typical Windows / macOS shape from OS file events) correctly
 * resolves to the same entry. The stop-gap is here pending the Phase 4
 * VaultPath newtype which makes the contract a compile-time guarantee.
 *
 * Implication for the on-disk `.filo/tags.json` format: keys are stored
 * lowercased. A human reading the file sees `notes/foo.md` rather than
 * the file's actual `Notes/Foo.md`. The vault index and any UI surface
 * still shows the case-preserved name from the filesystem itself, so
 * the user-visible representation is unaffected.
 */
function normalisePath(path: string): string {
  return normalizeVaultRelative(path);
}

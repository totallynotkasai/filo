/**
 * Audit-10 B2 — `ci:writer-path-honors-filepath`.
 *
 * B2's root cause: two of the text-tile WRITE-path resolvers built `${title}.md`
 * at the vault ROOT and never consulted the def's explicit `filePath`. After a
 * restart (boards don't preload docs, so `documentStore` is empty) a subfolder
 * card's field / Properties edit resolved to the wrong root path — ENOENT-lost
 * the edit, or silently corrupted an unrelated same-named root file. The fix
 * routes every field/popup text-tile write-path resolver through the canonical
 * `resolveTextTileVaultPath` (lib/boards/textTilePath.ts), which honors
 * `filePath` → `documentStore.filename` → folder cascade — closing the systemic
 * "policed the FM object, never the path" gap.
 *
 * This is a NARROW ALLOWLIST ratchet: an exact list of the field/popup
 * write-path resolver sites, each of which MUST reference
 * `resolveTextTileVaultPath`. A revert of the B2 fix (dropping the canonical
 * resolver from one of these files) trips the gate.
 *
 * A broad `${...title...}.md`-literal scan is deliberately NOT used: ~15
 * legitimate sites build `${title}.md` WITHOUT the canonical resolver and are
 * correct to — full-text search ranking (lib/search), the convention-path
 * builders (conventionPaths / fileRefIntegrity / frontmatterSync), and read-only
 * DISPLAY resolvers (KanbanCard). A broad scan would be a false-positive
 * minefield, so coverage is pinned to the write-path resolver sites by name.
 *
 * NOT listed (intentionally): TextTile.svelte and KanbanCard.svelte resolve
 * inline and already consult `filePath` directly — they were never broken, so
 * they aren't required to import the canonical helper.
 *
 * Maintenance: add a NEW field/popup write-path resolver to RESOLVER_SITES; if
 * you rename/move a listed file, update the list (a missing file fails loud so
 * coverage can't be silently dropped).
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

// Field/popup text-tile WRITE-path resolver sites. Each must route through the
// canonical resolveTextTileVaultPath so a subfolder card's explicit `filePath`
// wins over the `${title}.md` vault-root fallback (Audit-10 B2).
const RESOLVER_SITES = [
  'src/renderer/lib/kanban/kanbanFrontmatterWriter.ts',
  'src/renderer/components/tiles/PropertiesPopup.svelte',
  'src/renderer/components/boards/TaskListBoard.svelte',
  'src/renderer/components/boards/TaskItem.svelte',
  // Audit-12 H2 — the single-tag add/remove path. Its deleted local helper
  // (`resolveTextTileFilePath`) fell back to `${title}.md` at the vault ROOT, so a
  // cold-loaded subfolder text tile / Task row wrote its tag + `.filo/tags.json`
  // key to a root file. All of its tile→path resolvers now route through the
  // canonical resolver (the `.md` write, the tags.json/sibling writes, and the
  // tag-count dedup), so the tag write can't drift to the root while the file lives
  // in a subfolder.
  'src/renderer/stores/fileTags.svelte.ts',
];

const REQUIRED = 'resolveTextTileVaultPath';
const WORD_RE = new RegExp(`\\b${REQUIRED}\\b`);

const missingFiles = [];
const offenders = [];

for (const rel of RESOLVER_SITES) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) {
    missingFiles.push(rel);
    continue;
  }
  const src = readFileSync(abs, 'utf8');
  if (!WORD_RE.test(src)) offenders.push(rel);
}

if (missingFiles.length > 0 || offenders.length > 0) {
  console.error('[check-writer-path-honors-filepath] FAILED');
  for (const rel of missingFiles) {
    console.error(
      `  MISSING: ${rel} — listed resolver site no longer exists; ` +
        'update RESOLVER_SITES in scripts/check-writer-path-honors-filepath.mjs.',
    );
  }
  for (const rel of offenders) {
    console.error(
      `  ${rel} — does not reference \`${REQUIRED}\`; a text-tile write-path ` +
        'resolver must route through the canonical helper so an explicit ' +
        '`filePath` (subfolder card) wins over the `${title}.md` root fallback.',
    );
  }
  console.error(
    '\nAudit-10 B2 — see AUDIT10_REMEDIATION_PLAN_2026-06-04.md. The two resolvers ' +
      'that ignored `filePath` (kanbanFrontmatterWriter, PropertiesPopup) silently ' +
      'lost or corrupted a subfolder card\'s edit. Delegate to resolveTextTileVaultPath.',
  );
  process.exit(1);
}

console.log(
  `[check-writer-path-honors-filepath] OK — ${RESOLVER_SITES.length} text-tile ` +
    `write-path resolver site(s) route through ${REQUIRED}.`,
);
process.exit(0);

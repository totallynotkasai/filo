/**
 * Phase 6.1.R4 CI gate — relPath-keyed stores must register a rename
 * sweep (or carry an exemption).
 *
 * Class-kill for "X is stranded after rename". Today's rename cascades
 * (`vaultFolderOps.runRename`, `runExternalRenameCascade`, the in-app
 * `renameTextTileBackingFile`) each independently called out to whatever
 * path-keyed sinks they happened to remember. The audit's canonical
 * missed example: `markdownFileWriter.fileState` (the hydrate gate) had
 * no rename method, every cascade forgot it, and every keystroke after
 * a rename threw "refusing to write — not hydrated".
 *
 * Phase 6.1.R4 adds `lib/vault/renamePathKeys.ts` with
 * `registerPathRenamable(name, fn)` + `renameAllPathKeys(oldRel, newRel)`.
 * Each owner of relPath-keyed state subscribes once at module init; each
 * cascade fires `renameAllPathKeys(...)` once. This gate enforces the
 * contract: any new module-level `Map<VaultPath, _>` / `Map<string, _>`
 * declaration in `lib/vault/**` or `lib/boards/**` whose identifier
 * suggests relPath keying must either call `registerPathRenamable(...)`
 * OR live in `EXEMPT_OWNERS` (peer-rename-handled — e.g. boardCache via
 * `renameBoardPath`, vaultIndex via `renameKey`).
 *
 * Scope. `lib/vault/**` + `lib/boards/**` (extended from
 * `check-vault-scoped-state`'s scope). Renderer stores under `stores/**`
 * are covered too — same identifier heuristic applies.
 *
 * Fixing a failure:
 *   - If the new map IS a path-keyed cache: implement a sweep helper
 *     `renameXyzPath(oldRel, newRel)` that moves the exact key AND any
 *     descendants (key starts with `oldRel + '/'`), then call
 *     `registerPathRenamable('module.field', renameXyzPath)` at module
 *     init.
 *   - If rename is genuinely handled by a peer (the existing
 *     `boardCacheStore.renameBoardPath` model): add the file path to
 *     `EXEMPT_OWNERS` below with a one-line reason naming the peer.
 *   - If the map is rename-blind by design (an immutable lookup or a
 *     pre-vault state): annotate the declaration with
 *     `// allow-no-rename-transfer: <reason>`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const SCAN_DIRS = [
  'src/renderer/stores',
  'src/renderer/lib/vault',
  'src/renderer/lib/boards',
];

/**
 * Files that own relPath-keyed state whose rename is handled by a peer
 * module (the pattern that pre-dates the R4 registry). Each entry is a
 * one-line reason naming the peer; on review the entry should be
 * defensible in 10 seconds.
 */
const EXEMPT_OWNERS = new Map([
  // Vault index uses `renameKey` called by every cascade; the renderer's
  // search panel re-derives from the updated metadata immediately.
  ['src/renderer/stores/vaultIndex.svelte.ts', 'rename via vaultIndexStore.renameKey called by every cascade'],
  // Board cache uses `renameBoardPath` for path-keyed placements; called
  // by every cascade. The internal placement Maps are owned by the cache
  // and walked from that single entry point.
  ['src/renderer/stores/boardCache.svelte.ts', 'rename via boardCacheStore.renameBoardPath called by every cascade'],
  // File tags has `renameFile` + `renameFolder`; called by every cascade.
  ['src/renderer/stores/fileTags.svelte.ts', 'rename via fileTagsStore.renameFile / renameFolder called by every cascade'],
  // Document store has `propagateRename` (exact + folder-prefix);
  // called by every cascade.
  ['src/renderer/stores/document.svelte.ts', 'rename via documentStore.propagateRename called by every cascade'],
  // Write-state tracking's `recentSelfWrites` is a TTL-keyed suppression
  // map. Entries expire on a short timer (1.5–5s); a rename mid-window
  // is harmless since the worst case is the next watcher echo from the
  // NEW path arrives unsuppressed and triggers a benign reconcile pass.
  // Coverage cost outweighs the benefit; entries also get cleared on
  // vault swap via the `boardSaver` pre-swap handler.
  ['src/renderer/lib/boards/writeStateTracking.ts', 'TTL-expiring entries; rename mid-window is harmless'],
  // Config write scheduler keys by `ConfigTarget` literal ('defaults' /
  // 'theme' / etc.) — never a path; the path-key heuristic is a false
  // positive here.
  ['src/renderer/lib/boards/configWriteScheduler.ts', 'keyed by ConfigTarget literal, not path'],
  // Frontmatter scheduler keys by docId, not path (the rename-of-docId
  // case doesn't exist — docIds are vault-lifetime stable).
  ['src/renderer/lib/boards/frontmatterWriteScheduler.ts', 'keyed by docId, not path'],
  // Viewports cache keys by boardId (the viewport key), not path.
  // boardId is rename-stable.
  ['src/renderer/lib/boards/viewportCache.ts', 'keyed by boardId, not path'],
  // External-change windows: short retry windows + grace timers that
  // are vault-swap-cleared and short-lived. A rename mid-window leaves
  // stale entries that expire harmlessly.
  ['src/renderer/lib/vault/externalChangeWindows.ts', 'short retry/grace windows; entries expire harmlessly'],
  // boardLoader: immutable TILE_TYPE_SET lookup, not a runtime cache.
  ['src/renderer/lib/boards/boardLoader.ts', 'immutable lookup table, not a runtime cache'],
  // tileDefBuilder: immutable INLINE_TILE_TYPES lookup.
  ['src/renderer/lib/boards/tileDefBuilder.ts', 'immutable lookup table, not a runtime cache'],
]);

function toPosix(p) {
  return p.split(sep).join('/');
}

function walkTs(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) walkTs(full, out);
    else if (s.isFile() && /\.(ts|svelte\.ts)$/.test(entry)) out.push(full);
  }
}

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

// Module-scoped `let` / `const` declarations whose type carries `VaultPath`
// as the key — these are unambiguously path-keyed. The check-vault-path-keys
// gate already enforces that path-keyed maps use the `VaultPath` brand, so
// this detection is reliable for all maps that opted into the brand.
//
// Also catch `Map<string, _>` / `Record<string, _>` whose identifier
// matches a known path-suggesting name; the existing
// `check-vault-path-keys` gate's regex set is shared here.
const VAULTPATH_DECL_RE = /^(?:let|const)\s+\w+(?:\s*:\s*[^=]+)?\s*=\s*new\s+(?:Weak|Svelte)?(?:Map|Set)\s*<\s*VaultPath\b/;
// Direct string Map<string, _> with a path-suggesting identifier. We require
// the identifier to be on the same line for simplicity (declaration form).
const STRING_DECL_RE = /^(?:let|const)\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*new\s+(?:Weak|Svelte)?(?:Map)\s*<\s*string\s*,/;
const PATH_IDENT_PATTERNS = [
  /^fileState$/,
  /^baselines$/,
  /^inFlight\w*$/i,
  /Path(?:s|Map)?$/,
  /ByPath$/,
];

const ALLOW_INLINE_RE = /\/\/\s*allow-no-rename-transfer:\s*\S+/;
const REGISTER_RE = /\bregisterPathRenamable\s*\(/;

const tsFiles = [];
for (const dir of SCAN_DIRS) walkTs(join(ROOT, dir), tsFiles);

const offenders = [];

for (const abs of tsFiles) {
  const rel = toPosix(relative(ROOT, abs));
  const raw = readFileSync(abs, 'utf8');
  const code = stripComments(raw);
  const codeLines = code.split(/\r?\n/);
  const rawLines = raw.split(/\r?\n/);

  // Find candidate path-keyed declarations on this file.
  const hits = [];
  for (let i = 0; i < codeLines.length; i++) {
    const line = codeLines[i];
    if (VAULTPATH_DECL_RE.test(line)) {
      const annotation = `${rawLines[i - 1] ?? ''}\n${rawLines[i] ?? ''}`;
      if (ALLOW_INLINE_RE.test(annotation)) continue;
      hits.push({ line: i + 1, snippet: rawLines[i].trim() });
      continue;
    }
    const stringMatch = STRING_DECL_RE.exec(line);
    if (stringMatch) {
      const ident = stringMatch[1];
      if (!PATH_IDENT_PATTERNS.some((re) => re.test(ident))) continue;
      const annotation = `${rawLines[i - 1] ?? ''}\n${rawLines[i] ?? ''}`;
      if (ALLOW_INLINE_RE.test(annotation)) continue;
      hits.push({ line: i + 1, snippet: rawLines[i].trim() });
    }
  }

  if (hits.length === 0) continue;
  if (EXEMPT_OWNERS.has(rel)) continue;
  if (REGISTER_RE.test(code)) continue;

  for (const h of hits) {
    offenders.push({ rel, line: h.line, snippet: h.snippet });
  }
}

// Note. We deliberately do NOT staleness-check EXEMPT_OWNERS: many
// exempt files (vaultIndex, boardCache, fileTags, document) own path
// state via class-private SvelteMap fields the simple regex above
// doesn't reach. The exemption list serves as documentation more than
// machine-checkable invariant; reviewers prune entries when refactors
// move state. The protected invariant is the offenders-list — net-new
// path-keyed module state must register a sweep.

if (offenders.length > 0) {
  console.error(
    `[check-relpath-keyed-stores-register-rename] FAILED — ${offenders.length} declaration(s):`,
  );
  for (const o of offenders.sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line)) {
    console.error(`  ${o.rel}:${o.line}`);
    console.error(`    ${o.snippet}`);
  }
  console.error(
    '\nFix: implement `renameXyzPath(oldRel, newRel)` that moves the exact key AND\n' +
      '     descendants, then call `registerPathRenamable(\'module.field\', renameXyzPath)`\n' +
      '     at module init. The module-level call wires this into the cascade\n' +
      '     entry point `renameAllPathKeys(oldRel, newRel)` automatically.\n' +
      '     Alternative: add the file to EXEMPT_OWNERS in this script with a\n' +
      '     one-line reason naming the peer that handles its rename, OR annotate\n' +
      '     the specific declaration with `// allow-no-rename-transfer: <reason>`.',
  );
  process.exit(1);
}

console.log(
  `[check-relpath-keyed-stores-register-rename] OK — scanned ${tsFiles.length} file(s); 0 offenders, ${EXEMPT_OWNERS.size} exempt.`,
);
process.exit(0);

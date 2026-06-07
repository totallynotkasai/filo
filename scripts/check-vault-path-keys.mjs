/**
 * Phase 4 CI gate — `VaultPath` key discipline.
 *
 * `Map<string, _>` / `Record<string, _>` / `Set<string>` declarations whose
 * identifier suggests a vault-relative-path key (e.g. `fileTags`, `pathByX`,
 * `*ByPath`, `pathTo*`, `*Paths`, `recentSelfWrites`,
 * `lastKnown(Sizes|Hashes)`, `partialReadRetry*`) must be re-typed to
 * `Map<VaultPath, _>` / `Record<VaultPath, _>` / `Set<VaultPath>` and
 * routed through the `vaultPath()` constructor from `src/shared/vaultPath.ts`.
 *
 * Without this discipline, Windows/macOS case-folding orphans rename
 * targets (see P0 #8 in IMPLEMENTATION_PLAN_2026-05-27.md) — the in-memory
 * map keeps the entry under the OLD casing forever and tag rewrites /
 * cascade-delete / broken-ref tracking silently miss.
 *
 * Phase 4 flipped this gate from WARN-ONLY to error; the sweep across
 * `writeStateTracking`, `vaultExternalChanges`, `fileWatcher`, `fileTags`,
 * and the vault store closed every violation. New code that introduces a
 * `Map<string, _>` with a path-suggesting identifier must either:
 *   - rename the identifier so it no longer matches the pattern (when the
 *     key is genuinely NOT a vault-relative path — e.g. boardId, tileId,
 *     absolute file-tree path), AND
 *   - add `// allow-string-path-key: <reason>` on the declaration line
 *     or the line preceding it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const WARN_ONLY = false;

const SCAN_ROOTS = [join(ROOT, 'src/renderer'), join(ROOT, 'src/main')];
const EXTENSIONS = ['.ts'];
// Exclude tests, the path-helper module itself, and the `shared/`
// declaration module (Phase 4 introduces `VaultPath` there).
const EXEMPT_PATTERNS = [
  /(^|\/)src\/tests\//,
  /(^|\/)src\/renderer\/lib\/utils\/path\.ts$/,
  /(^|\/)src\/shared\/vaultPath\.ts$/,
];

const PATH_KEY_IDENT_PATTERNS = [
  /\bfileTags\b/,
  /\b\w*ByPath\b/,
  /\bpathTo\w*\b/,
  /\b\w+Paths\b/,
  /\brecentSelfWrites\b/,
  /\blastKnown(Sizes|Hashes)\b/,
  /\bpartialReadRetry(Inflight|Count|Timers)\b/,
];

function toPosix(p) {
  return p.split(sep).join('/');
}

function walkExt(dir, exts, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) walkExt(full, exts, out);
    else if (s.isFile() && exts.some((e) => entry.endsWith(e))) out.push(full);
  }
}

const violations = [];
let scannedFiles = 0;

for (const root of SCAN_ROOTS) {
  const files = [];
  walkExt(root, EXTENSIONS, files);
  for (const file of files) {
    const rel = toPosix(relative(ROOT, file));
    if (EXEMPT_PATTERNS.some((re) => re.test(rel))) continue;
    scannedFiles++;
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Escape-hatch — same line or the preceding line.
      const annotationWindow = `${lines[i - 1] ?? ''}\n${line}`;
      if (annotationWindow.includes('allow-string-path-key:')) continue;
      // Skip lines already using VaultPath as the key.
      if (/\bVaultPath\b/.test(line)) continue;
      // Match the actual map/record declarations we care about.
      // We catch:
      //   new Map<string, _>      (untyped on lhs or typed)
      //   new SvelteMap<string, _>
      //   : Map<string, _>        (annotation form)
      //   : Record<string, _>     (annotation form)
      //   new Set<string>()       (path-keyed sets)
      const mapDecl =
        /(new\s+(?:Svelte)?(?:Map|Set)\s*<\s*string\s*(?:,|>)|:\s*(?:Map|Record)\s*<\s*string\s*,)/;
      if (!mapDecl.test(line)) continue;
      // Identifier extraction — `const X = ...`, `let X = ...`,
      // `private X = ...`, `public X = ...`, `X: ...` (annotation form).
      const ident =
        /(?:const|let|private|public|protected|readonly)\s+(\w+)/.exec(line)?.[1] ??
        /^\s*(\w+)\s*(?:[:=])/.exec(line)?.[1] ??
        /this\.(\w+)\s*=/.exec(line)?.[1] ??
        null;
      if (!ident) continue;
      if (!PATH_KEY_IDENT_PATTERNS.some((re) => re.test(ident))) continue;
      violations.push({
        file: rel,
        line: i + 1,
        identifier: ident,
        snippet: line.trim(),
      });
    }
  }
}

// ── M1 (Audit-13): VaultIndex must case-FOLD its Map + MiniSearch keys ────
//
// The generic scan above keys on path-suggesting IDENTIFIERS; `VaultIndex`'s
// map is named `metadata`, which doesn't match, so it slipped through as the
// lone path-keyed store that never folded (M1). This dedicated check asserts
// the fold is structural and can't silently regress:
//   1. the `metadata` map is typed `Map<VaultPath, …>` (so a raw-string `.set`
//      is a compile error — the strongest guard);
//   2. a `keyOf(...)` helper exists and routes through `vaultPath()` /
//      `normalizeVaultRelative()`;
//   3. every `const id|oldId|newId = …` (the Map key + MiniSearch id sources)
//      is derived via `this.keyOf(`.
// Comment/strings are NOT special-cased away wholesale, but we strip comments
// first so a doc-comment that merely NAMES the pattern can't satisfy it. The
// file must exist and match — a missing file fails loud so coverage can't be
// dropped by deleting the target.
const foldViolations = [];
{
  const VAULT_INDEX_REL = 'src/renderer/lib/vault/vaultIndex.ts';
  const vaultIndexPath = join(ROOT, VAULT_INDEX_REL);
  let raw;
  try {
    raw = readFileSync(vaultIndexPath, 'utf8');
  } catch {
    foldViolations.push(`${VAULT_INDEX_REL}: file not found — VaultIndex fold check cannot run`);
    raw = null;
  }
  if (raw !== null) {
    // Strip block + line comments so a comment can't satisfy a positive assert.
    const stripped = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

    if (!/\bmetadata\s*=\s*new\s+Map<\s*VaultPath\s*,/.test(stripped)) {
      foldViolations.push(
        `${VAULT_INDEX_REL}: the \`metadata\` map must be typed \`Map<VaultPath, …>\` (branded fold key)`,
      );
    }

    const keyOfBody = /\bkeyOf\s*\([^)]*\)\s*:\s*VaultPath\s*\{([\s\S]*?)\}/.exec(stripped);
    if (!keyOfBody) {
      foldViolations.push(
        `${VAULT_INDEX_REL}: missing a \`keyOf(path): VaultPath\` helper to fold Map / MiniSearch keys`,
      );
    } else if (!/\b(?:vaultPath|normalizeVaultRelative)\s*\(/.test(keyOfBody[1])) {
      foldViolations.push(
        `${VAULT_INDEX_REL}: \`keyOf\` must fold through \`vaultPath(\` / \`normalizeVaultRelative(\``,
      );
    }

    const idDecl = /\bconst\s+(id|oldId|newId)\s*=\s*([^;\n]+)/g;
    let m;
    let sawIdDecl = false;
    while ((m = idDecl.exec(stripped)) !== null) {
      sawIdDecl = true;
      if (!/\bthis\.keyOf\s*\(/.test(m[2])) {
        foldViolations.push(
          `${VAULT_INDEX_REL}: \`const ${m[1]} = ${m[2].trim()}\` must derive the key via \`this.keyOf(\``,
        );
      }
    }
    if (!sawIdDecl) {
      foldViolations.push(
        `${VAULT_INDEX_REL}: expected at least one \`const id|oldId|newId = this.keyOf(…)\` key derivation`,
      );
    }
  }
}

// ── Report ─────────────────────────────────────────────────────────────

if (violations.length === 0 && foldViolations.length === 0) {
  process.stdout.write(
    `[check-vault-path-keys] OK — scanned ${scannedFiles} file(s), 0 path-keyed string maps detected.\n`,
  );
  process.exit(0);
}

const stream = WARN_ONLY ? process.stdout : process.stderr;
const label = WARN_ONLY ? 'WARN' : 'FAIL';
if (violations.length > 0) {
  stream.write(
    `[check-vault-path-keys] ${label} — ${violations.length} path-keyed string map(s) detected (Phase 4 sweep target):\n`,
  );
  for (const v of violations) {
    stream.write(`  ${v.file}:${v.line} ${v.identifier}\n`);
    stream.write(`    ${v.snippet}\n`);
  }
  stream.write(
    '\nVault-relative paths must be normalised through `normalizeVaultRelative` before\n' +
      'being used as Map / Record / Set keys, otherwise Windows / macOS case-folding\n' +
      'orphans the entry on rename (see P0 #8 in IMPLEMENTATION_PLAN_2026-05-27.md).\n' +
      'Phase 4 introduces a `VaultPath` newtype + `vaultPath(raw)` constructor in\n' +
      '`src/shared/vaultPath.ts`. Each entry here should be migrated to\n' +
      '`Map<VaultPath, _>` / `Record<VaultPath, _>` / `Set<VaultPath>` and every\n' +
      'callsite wrapped in `vaultPath(...)`.\n' +
      'Escape hatch: append `// allow-string-path-key: <reason>` if the key is genuinely\n' +
      'NOT a vault-relative path (e.g. boardId / tileId), and rename the identifier so it\n' +
      'no longer matches the path-key pattern.\n',
  );
}
if (foldViolations.length > 0) {
  stream.write(
    `[check-vault-path-keys] ${label} — VaultIndex (M1, Audit-13) must case-fold its keys:\n`,
  );
  for (const v of foldViolations) stream.write(`  ${v}\n`);
  stream.write(
    '\nVaultIndex was the lone path-keyed store that kept raw OS casing, so a\n' +
      'case-divergent external edit (case-only rename / multi-device OneDrive / git)\n' +
      'missed the entry — bypassing the partial-read guard and upserting a duplicate.\n' +
      'Route the metadata Map + MiniSearch id through `keyOf(path): VaultPath`\n' +
      '(`vaultPath(...)`), keeping `metadata.path` in OS casing for display.\n',
  );
}

if (WARN_ONLY) {
  process.stdout.write(
    `\n[check-vault-path-keys] WARN-ONLY — exit 0 (will flip to error at end of Phase 4).\n`,
  );
  process.exit(0);
}
process.exit(1);

/**
 * Markdown-write gateway gate (Phase 2 / Pre-Daily-Use Plan 2026-05-25).
 *
 * After the markdown-file-writer gateway lands, `vault:write-existing-file-text`
 * is the canonical channel for writing existing `.md` files, but every call
 * site MUST route through the gateway (`writeMarkdownFile` / `scheduleMarkdownWrite`).
 * Direct `invokeOk('vault:write-existing-file-text', ...)` calls outside the
 * gateway bypass the BOM-preserving hydrate gate, the cross-board frontmatter
 * race guard, and the lastFlushedVersion bookkeeping — each one re-introduces
 * one of the P0 silent-data-loss paths the gateway closed.
 *
 * This gate scans the renderer source tree for direct usages and fails on
 * any new offender. The gateway itself is allowlisted (it owns the call).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const RENDERER_DIR = join(ROOT, 'src/renderer');

/**
 * Files allowed to call `vault:write-existing-file-text` directly. Anything
 * outside this set must route through `markdownFileWriter`.
 */
const ALLOWLIST = new Set([
  // The gateway itself.
  'src/renderer/lib/vault/markdownFileWriter.ts',
]);

/** Files / directories to skip entirely (binary, test, etc.). */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build']);

/**
 * Recursively walks `dir`, yielding every file path.
 */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (SKIP_DIRS.has(entry)) continue;
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const violations = [];

for (const file of walk(RENDERER_DIR)) {
  // Only scan TS / Svelte source.
  if (!/\.(ts|svelte)$/.test(file)) continue;
  const rel = relative(ROOT, file).replaceAll(sep, '/');
  if (ALLOWLIST.has(rel)) continue;

  const text = readFileSync(file, 'utf8');
  // Match an actual `invokeOk('vault:write-existing-file-text', ...)` (or
  // `invoke('vault:write-existing-file-text', ...)`) call. The leading
  // identifier filter avoids false positives in comments / docstrings.
  const re = /\binvoke(?:Ok)?\s*\(\s*['"`]vault:write-existing-file-text['"`]/g;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      // Inline allow-comment escape hatch on the same line.
      if (/\/\/ allow-direct-write:/.test(lines[i])) continue;
      violations.push({ file: rel, line: i + 1, content: lines[i].trim() });
    }
    re.lastIndex = 0;
  }
}

if (violations.length > 0) {
  console.error(
    'Direct `vault:write-existing-file-text` calls found outside the markdown gateway:',
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} — ${v.content}`);
  }
  console.error('');
  console.error('Route the write through `markdownFileWriter.writeMarkdownFile`');
  console.error('or `scheduleMarkdownWrite` — see src/renderer/lib/vault/markdownFileWriter.ts.');
  console.error('To allowlist a specific line (e.g. a deliberate file-recreation),');
  console.error('append `// allow-direct-write: <reason>` on the same line.');
  process.exit(1);
}

console.log('check-markdown-write-gateway: OK');

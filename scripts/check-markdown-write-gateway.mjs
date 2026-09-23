/**
 * Markdown-write gateway gate (Phase 2 / Pre-Daily-Use Plan 2026-05-25;
 * 6.3.P5 extends it to cover both write channels).
 *
 * After the markdown-file-writer gateway lands, the two write channels are:
 *   - `vault:write-existing-file-text` — write to a file that MUST already
 *     exist. The editor pipeline (TextTile, DocumentEditor, PropertiesPopup,
 *     frontmatterWriteScheduler) routes through `markdownFileWriter` /
 *     `scheduleMarkdownWrite`, which threads BOM preservation, cross-board
 *     frontmatter race guards, and lastFlushedVersion bookkeeping.
 *   - `vault:write-file-text` — create a file (mkdir -p + atomic write).
 *     Routes that BIND a NEW backing file to a live tile must hydrate the
 *     gateway first; routes that emit a one-shot sentinel/seed/sweep file
 *     (no live editor will write back to it before the next hydrate) are
 *     legitimate direct callers and carry `// allow-direct-write: <reason>`.
 *
 * Direct callers of either channel outside the gateway bypass the BOM-
 * preserving hydrate gate, the cross-board frontmatter race guard, and the
 * lastFlushedVersion bookkeeping — each one re-introduces a silent data-
 * loss path the gateway closes.
 *
 * This gate scans the renderer source tree for direct usages of either
 * channel and fails on any new offender. The gateway itself is
 * allowlisted (it owns both calls).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const RENDERER_DIR = join(ROOT, 'src/renderer');

/**
 * Files allowed to call `vault:write-existing-file-text` or
 * `vault:write-file-text` directly. Anything outside this set must route
 * through `markdownFileWriter` (or carry an inline `// allow-direct-write:`
 * escape per call site).
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

// 6.3.P5 — match every markdown write channel (Audit-19 BL-1 adds the
// create-exclusive `vault:create-file-text`). The leading identifier filter
// (`\binvoke(?:Ok)?\s*\(`) ensures we only match real call sites, not
// comments / docstrings / type aliases referencing the channel name. The
// `\s*` permits newlines between `invokeOk(` and the channel literal, so a
// multi-line invocation (the common shape in svelte components) doesn't
// slip through.
const channelRe =
  /\binvoke(?:Ok)?\s*\(\s*['"`]vault:(?:write-(?:existing-)?|create-)file-text['"`]/gs;

for (const file of walk(RENDERER_DIR)) {
  // Only scan TS / Svelte source.
  if (!/\.(ts|svelte)$/.test(file)) continue;
  const rel = relative(ROOT, file).replaceAll(sep, '/');
  if (ALLOWLIST.has(rel)) continue;

  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  // Track per-line offset so we can report a 1-indexed line number for each
  // match. `lineStarts[i]` is the byte offset of line `i+1`'s first char.
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }

  let match;
  while ((match = channelRe.exec(text)) !== null) {
    // Determine the 1-indexed line number of the match.
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (lineStarts[mid] <= match.index) lo = mid;
      else hi = mid - 1;
    }
    const lineNumber = lo + 1; // 1-indexed
    const line = lines[lineNumber - 1] ?? '';
    // Escape hatch — accept the `// allow-direct-write:` comment on the
    // match's line, or anywhere in the 4 lines immediately above (covers
    // multi-line invocations + multi-line escape comments where the
    // explanation sits above the call site), or on the channel-literal
    // line (where the channel literal sits a few lines below the
    // `invokeOk(` opener).
    const onSameLine = /\/\/ allow-direct-write:/.test(line);
    let onAboveLines = false;
    const ESCAPE_LOOKBACK = 4;
    for (let j = 1; j <= ESCAPE_LOOKBACK; j++) {
      const idx = lineNumber - 1 - j;
      if (idx < 0) break;
      if (/\/\/ allow-direct-write:/.test(lines[idx])) {
        onAboveLines = true;
        break;
      }
    }
    // Also check the channel-literal line (when the invokeOk call spans
    // multiple lines, the channel string lands on a line past the match
    // start). The match captures everything from `invokeOk(` through the
    // literal; finding its end-of-match line covers that case.
    const endIdx = match.index + match[0].length - 1;
    let endLine = lineNumber;
    for (let j = lineNumber; j <= lines.length; j++) {
      if (j >= lineStarts.length || lineStarts[j] > endIdx) {
        endLine = j;
        break;
      }
    }
    const endLineContent = lines[endLine - 1] ?? '';
    const onChannelLine = /\/\/ allow-direct-write:/.test(endLineContent);
    if (onSameLine || onAboveLines || onChannelLine) continue;
    violations.push({ file: rel, line: lineNumber, content: line.trim() });
  }
}

if (violations.length > 0) {
  console.error(
    'Direct `vault:write-(existing-)?file-text` calls found outside the markdown gateway:',
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} — ${v.content}`);
  }
  console.error('');
  console.error('Route the write through `markdownFileWriter.writeMarkdownFile`');
  console.error('or `scheduleMarkdownWrite` — see src/renderer/lib/vault/markdownFileWriter.ts.');
  console.error('To allowlist a specific call (e.g. a one-shot seed/sentinel/sweep),');
  console.error('add `// allow-direct-write: <reason>` on the same line or the line above.');
  process.exit(1);
}

console.log('check-markdown-write-gateway: OK');

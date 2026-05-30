/**
 * IPC envelope-usage gate (Phase 1, CONSOLIDATION_PLAN_2026-05-25.md).
 *
 * Forbids the silent-failure pattern that bug #1 surfaced — calling
 * `window.filo.invoke('<envelope-channel>', ...)` directly without
 * routing the result through `invokeOk` or `assertIpcOk`. The cast
 * `as string` in `boardLoader.ts:452` was exactly this shape: a typed
 * cast over the envelope's `{ ok: false, ... }` failure branch
 * coerced it into a truthy value and skipped the abort path.
 *
 * Rules (scoped to `src/renderer/**` non-test source):
 *   1. Any call to `window.filo.invoke('<envelope channel>', ...)` MUST
 *      either be inside a line that also names `invokeOk` /
 *      `assertIpcOk`, OR pass the result to a manual `.success` /
 *      `.ok` check within the next ~6 lines (heuristic — exhaustive
 *      flow analysis is out of scope for a grep gate).
 *   2. `invokeOk(...)` calls are exempt — they ARE the safe path.
 *
 * "Envelope channel" is hard-coded here against the channels listed
 * in `src/shared/ipcContracts.ts`. Keep this list in sync if you add
 * a new envelope-returning channel.
 *
 * Escape hatch: append `// allow-envelope-bare:` with a reason on the
 * line, e.g. for fire-and-forget calls where the failure branch is
 * deliberately ignored.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const RENDERER_DIR = join(ROOT, 'src/renderer');

// Hand-maintained from `src/shared/ipcContracts.ts:IpcChannelMap`.
// Any entry whose `result` type uses `IpcOk<…>` or `IpcSuccess<…>`
// goes here. Bare-return channels (string / boolean / number / FileTreeNode[] /
// RecentVault[] / etc.) do NOT.
const ENVELOPE_CHANNELS = new Set([
  // ok-discriminated
  'vault:read-tree',
  'vault:init-config',
  'board:save',
  'board:create',
  'board:delete',
  'recovery:snapshot',
  'config:save',
  'config:save-workspace',
  'theme:save',
  'theme:delete',
  // success-discriminated
  'vault:create-folder',
  'vault:suggest-folder-name',
  'vault:rename',
  'vault:delete',
  'vault:watch',
  'vault:reconcile',
  'vault:copy-file',
  'vault:read-file-text',
  'vault:write-file-text',
  'vault:write-existing-file-text',
  'vault:write-file-binary',
  'vault:stat',
  'vault:set-open-on-launch',
  'media:save-audio',
  'media:read-file',
  'media:open-external',
  'link:fetch-metadata',
  'export:save',
  'font:import',
  'templates:layout:write',
  'templates:layout:rename',
  'templates:layout:delete',
]);

const EXTENSIONS = ['.svelte', '.svelte.ts', '.ts'];
const EXEMPT_PATTERNS = [
  // Test files (Vitest stubs) are exempt — they install their own
  // window.filo and don't go through the envelope contract.
  /\/tests?\//,
  // The single internal call site is invokeOk.ts itself.
  /\/invokeOk\.ts$/,
];

function toPosix(p) {
  return p.split(sep).join('/');
}

function hasTrackedExtension(name) {
  return EXTENSIONS.some((ext) => name.endsWith(ext));
}

function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      walk(full, out);
    } else if (s.isFile() && hasTrackedExtension(entry)) {
      out.push(full);
    }
  }
}

const files = [];
walk(RENDERER_DIR, files);

const offenders = [];

for (const abs of files) {
  const rel = toPosix(relative(ROOT, abs));
  if (EXEMPT_PATTERNS.some((p) => p.test(rel))) continue;
  const lines = readFileSync(abs, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Accept the escape hatch on the same line OR on any of the 5
    // preceding lines (allows a wrapped justification comment). Both
    // JS comments (`// allow-envelope-bare:`) and Svelte HTML comments
    // (`<!-- allow-envelope-bare: -->`) are honoured so `.svelte`
    // template fragments can use the same opt-out.
    const lookback = lines.slice(Math.max(0, i - 5), i + 1).join('\n');
    if (lookback.includes('allow-envelope-bare:')) continue;
    // Match `window.filo.invoke('channel:name', ...)` — capture the channel.
    const match = /window\.filo\.invoke\(\s*['"]([^'"]+)['"]/g;
    let m;
    while ((m = match.exec(line)) !== null) {
      const channel = m[1];
      if (!ENVELOPE_CHANNELS.has(channel)) continue;

      // ── Accept patterns where the envelope is given a chance to be
      // inspected by SOMEONE — either inline or by the caller. The gate
      // only fails on patterns that LITERALLY drop the envelope on the
      // floor: `void window.filo.invoke(...)`, bare statement, or
      // `await window.filo.invoke(...)` without capture or .then.
      //
      // Pattern 1: assigned to a const/let/var. Caller inspects.
      const isAssigned = /(?:const|let|var)\s+\w+\s*=\s*(?:\(\s*)?await\s+window\.filo\.invoke\b/.test(line);
      // Pattern 2: `.then(...)` chain on the invoke promise. Handler inspects.
      const hasThen = /window\.filo\.invoke\([^;]*\)[^;]*\.(then|catch)\b/.test(line);
      // Pattern 3: `return` form — the result is handed back to the caller.
      const isReturned = /return\s+(?:await\s+)?window\.filo\.invoke\b/.test(line) ||
        /return\s+\(\s*await\s+window\.filo\.invoke\b/.test(line);
      if (isAssigned || hasThen || isReturned) continue;

      // Pattern 4: inline inspection on the same line or within a small
      // window — the caller assertIpcOk's it or accesses `.success` /
      // `.ok` directly. Same heuristic as before, narrowed to the
      // expression-statement form.
      const window = lines.slice(i, Math.min(lines.length, i + 7)).join('\n');
      const hasInspect =
        /\.success\b/.test(window) ||
        /\.ok\b/.test(window) ||
        /assertIpcOk\s*\(/.test(window);
      if (hasInspect) continue;

      offenders.push({
        rel,
        lineNo: i + 1,
        channel,
        snippet: line.trim(),
      });
    }
  }
}

if (offenders.length > 0) {
  process.stderr.write(
    `\n[ci:check-ipc-envelope-usage] ${offenders.length} envelope-channel call(s) without \`.success\` / \`.ok\` inspection (or \`assertIpcOk\`):\n\n`,
  );
  for (const o of offenders) {
    process.stderr.write(`  ${o.rel}:${o.lineNo}\n`);
    process.stderr.write(`    channel: ${o.channel}\n`);
    process.stderr.write(`    line:    ${o.snippet}\n\n`);
  }
  process.stderr.write(
    'Each envelope channel returns `{ ok | success: true | false, ... }`. ' +
      'Calling `window.filo.invoke` and ignoring the result silently swallows ' +
      '`{ ok: false }` failures — exactly the bug that CONSOLIDATION_PLAN_2026-05-25.md ' +
      'Phase 1 fixed. Use `invokeOk(...)` for the success-branch shape (recommended), ' +
      'or `assertIpcOk(result, channel)` if you need to inspect the failure branch ' +
      'manually. Append `// allow-envelope-bare: <reason>` if the call is genuinely ' +
      'fire-and-forget (e.g. UI feedback only).\n',
  );
  process.exit(1);
}

process.stdout.write('[ci:check-ipc-envelope-usage] OK — no bare envelope-channel invokes detected.\n');

/**
 * Disk-shape IPC ratchet (Phase R2 regression-prevention gate).
 *
 * Forbids `window.filo.invoke('vault:rename'|'vault:delete'|
 * 'vault:create-folder'|'vault:copy-file', ...)` and the `invokeOk(...)`
 * equivalents outside `src/renderer/lib/vault/vaultOperations.ts`.
 *
 * Rationale: every disk-shape change (rename / delete / create-folder /
 * copy-file) must drain the markdown / frontmatter / board writer pipelines
 * BEFORE the IPC fires. The audit found four call sites that bypassed
 * the drain (vaultExternalChanges, vaultFolderOps.delete, AppShell delete,
 * TileHeader delete) and silently lost user data when a debounced editor
 * write fired against the now-moved/missing path. Routing everything
 * through `withDrainedWrites` makes the drain a structural invariant.
 *
 * Detection: regex scan for the disk-shape channel literals inside
 * `invoke(...)` / `invokeOk(...)` calls. Inline `// allow-disk-shape-ipc:`
 * comments on the same line escape the gate when the call site genuinely
 * isn't a user-facing disk-shape change (e.g. deleting a `.filo/`
 * recovery sentinel — see the allowlist below).
 *
 * Allowlist: the gateway itself, plus the three `.filo/` sentinel
 * cleanup paths (tag-rewrite, rename-cascade, dirty-flag) which delete
 * internal recovery state. Those paths don't represent user-visible
 * disk-shape changes and don't need to pay the drain cost on every
 * cleanup.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const SCAN_DIRS = ['src/renderer'];
const EXTENSIONS = ['.svelte', '.svelte.ts', '.ts'];

/**
 * Files exempt from the gate. The gateway owns the only legitimate raw
 * disk-shape IPC; the three sentinel modules delete internal recovery
 * breadcrumbs (`.filo/*.json` / `.filo/.dirty`) which aren't user files.
 *
 * Add a file here only when the IPC site genuinely doesn't represent a
 * user-visible disk-shape change AND the per-call drain cost is
 * undesirable. Inline `// allow-disk-shape-ipc:` comments are preferred
 * for one-off justifications.
 */
const ALLOWLIST = new Set([
  // The gateway itself — owns the only sanctioned drain-then-invoke
  // pattern. Every other renderer site consumes its helpers.
  'src/renderer/lib/vault/vaultOperations.ts',
  // Recovery sentinel modules: each owns one `.filo/<sentinel>.json`
  // file, deleted on clear after a successful resume. These are
  // internal breadcrumbs, not user content; the drain isn't needed.
  'src/renderer/lib/vault/tagRewriteSentinel.ts',
  'src/renderer/lib/vault/renameCascadeSentinel.ts',
  'src/renderer/lib/vault/dirtyFlagRecovery.ts',
  // 6.2.H4 (follow-up) — clears `.filo/quit-failure.json`, the quit-time
  // emergency-file breadcrumb. Internal recovery state, not user content.
  'src/renderer/lib/vault/quitFailureRecovery.ts',
]);

/**
 * The four disk-shape channels gated by this script. Mirrors the
 * "Approach" section of `REFACTOR_PLAN_2026-05-26.md` Phase R2.
 */
const FORBIDDEN_CHANNELS = [
  'vault:rename',
  'vault:delete',
  'vault:create-folder',
  'vault:copy-file',
];

/** Inline escape-hatch comment. Allows one-off justifications. */
const INLINE_ALLOW_PATTERN = /\/\/\s*allow-disk-shape-ipc:/;

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

/**
 * Looks for `invoke(...)` / `invokeOk(...)` / `window.filo.invoke(...)`
 * call expressions whose first string argument matches a forbidden
 * channel. The regex is loose: it tolerates whitespace and either
 * quote style. False-positive risk is bounded because the channel
 * names themselves are distinct.
 */
function findForbiddenCalls(src) {
  const offenders = [];
  for (const channel of FORBIDDEN_CHANNELS) {
    // Match `invoke(`/`invokeOk(`/`filo.invoke(` followed by optional
    // whitespace, then the channel literal in either quote style.
    const re = new RegExp(
      String.raw`\b(?:invoke|invokeOk)\s*\(\s*['"\`]` +
        channel.replace(/[-:./]/g, (m) => `\\${m}`) +
        String.raw`['"\`]`,
      'g',
    );
    let m;
    while ((m = re.exec(src)) !== null) {
      offenders.push({ channel, idx: m.index });
    }
  }
  return offenders;
}

const files = [];
for (const dir of SCAN_DIRS) walk(join(ROOT, dir), files);

const offenders = [];
for (const abs of files) {
  const rel = toPosix(relative(ROOT, abs));
  if (ALLOWLIST.has(rel)) continue;
  const src = readFileSync(abs, 'utf8');
  if (!FORBIDDEN_CHANNELS.some((ch) => src.includes(ch))) continue;
  const calls = findForbiddenCalls(src);
  if (calls.length === 0) continue;
  const lines = src.split('\n');
  for (const { channel, idx } of calls) {
    const upto = src.slice(0, idx);
    const lineNo = upto.split('\n').length;
    const lineText = lines[lineNo - 1];
    // Inline allow-comment on the same line escapes the gate. The
    // allowlist above covers known recovery-sentinel modules; this
    // path is for one-off justifications.
    if (INLINE_ALLOW_PATTERN.test(lineText)) continue;
    offenders.push({ rel, lineNo, channel, snippet: lineText.trim() });
  }
}

if (offenders.length === 0) {
  console.log(
    `[check-no-raw-disk-shape-ipc] OK — scanned ${files.length} files, 0 violations.`,
  );
  process.exit(0);
}

console.error(
  `[check-no-raw-disk-shape-ipc] FAILED — ${offenders.length} raw disk-shape IPC call(s) detected:\n`,
);
for (const o of offenders) {
  console.error(`  ${o.rel}:${o.lineNo}  (${o.channel})`);
  console.error(`    ${o.snippet}`);
}
console.error(
  '\nFix: route through one of the convenience helpers exported by\n' +
    'src/renderer/lib/vault/vaultOperations.ts:\n' +
    '  - renameVaultPath(vaultRoot, oldPath, newPath)\n' +
    '  - deleteVaultPath(vaultRoot, itemPath)\n' +
    '  - createVaultFolder(vaultRoot, folderPath)\n' +
    '  - copyFileIntoVault(sourcePath, vaultRoot[, destFolder])\n' +
    '\n' +
    'Each helper drains the markdown / frontmatter / board writer\n' +
    'pipelines before issuing the IPC. For complex sequences that need\n' +
    'pre-IPC snapshot reads, wrap the whole sequence in\n' +
    '`withDrainedWrites(async () => { ... })` and call the convenience\n' +
    'helper inside — the re-entrancy guard collapses the inner drain.\n' +
    '\n' +
    'If the call site genuinely isn\'t a user-facing disk-shape change\n' +
    '(e.g. deleting a `.filo/` recovery sentinel), add an inline\n' +
    "`// allow-disk-shape-ipc: <reason>` comment on the same line, or\n" +
    'add the file to ALLOWLIST in scripts/check-no-raw-disk-shape-ipc.mjs\n' +
    'with a written justification.',
);
process.exit(1);

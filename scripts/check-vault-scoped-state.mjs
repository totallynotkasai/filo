/**
 * Vault-scoped-state gate (Phase 3, IMPL_PLAN 2026-05-25).
 *
 * Complements `ci:vault-lifecycle-coverage` (which catches modules with
 * `$state(...)` but no `onVaultSwap(...)`). That gate uses Svelte runes as
 * its trip-wire, which means a plain `let foo = new Map<...>()` or
 * `let bar = Promise.resolve()` at module scope — the exact pattern used by
 * the rename queue, the history chain, and the recovery sentinels — slips
 * through.
 *
 * This gate walks `src/renderer/stores/**`, `src/renderer/lib/vault/**`, and
 * `src/renderer/lib/boards/**`, picks modules that declare module-scoped
 * `let <name> = new Map(…)`, `new Set(…)`, `new WeakMap(…)`, `new WeakSet(…)`,
 * or `Promise.resolve(…)`, and asserts each one also calls `onVaultSwap(…)`.
 *
 * Modules that own such state but don't need a vault-swap reset (e.g. the
 * vault store itself, which OWNS the swap event and resets its own state
 * inline inside `openVault`) live in EXEMPT_MODULES below with a short
 * reason.
 *
 * Fixing a failure: either subscribe via
 *   `onVaultSwap('pre-swap', 'storeName', () => { <name> = new Map(); });`
 * at module init, or add the module path to EXEMPT_MODULES below with a
 * one-line reason.
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
 * Modules that hold module-scoped chained state but legitimately do NOT need
 * a vault-swap reset subscription. Keep the list short and well-commented;
 * each entry is an excuse the reviewer should be able to defend in 10 seconds.
 */
const EXEMPT_MODULES = new Map([
  // Sprint C / C25 — vault.svelte.ts used to be exempt as the swap-event
  // owner; it now subscribes for the reconcile-throttle reset, so the
  // exemption is gone. The `renameQueue` reset is still inline inside
  // `openVault` post-`fireVaultSwap('pre-swap', ...)`, which is fine —
  // the gate only checks that *some* subscription exists when state is
  // present.
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

const tsFiles = [];
for (const dir of SCAN_DIRS) walkTs(join(ROOT, dir), tsFiles);

// Module-scoped `let` declarations whose initializer is `new Map(...)`,
// `new Set(...)`, `new WeakMap(...)`, `new WeakSet(...)`, or
// `Promise.resolve(...)`. The `^` anchors to a line start (after comment
// stripping) so we only flag top-level declarations — locals inside a
// function body are fine.
//
// The optional `: <type>` group covers TypeScript annotations like
// `let foo: Promise<unknown> = Promise.resolve();`. Multiline-flag is OFF
// (default); the regex is applied per-line so the anchor behaves as
// "start of declaration line", which is what we want.
const SCOPED_STATE_RE = /^let\s+\w+(?:\s*:\s*[^=]+)?\s*=\s*(?:new\s+(?:Weak)?(?:Map|Set)\b|Promise\.resolve\b)/m;
const SUBSCRIBE_RE = /(?<![A-Za-z0-9_$])onVaultSwap\s*\(/;

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

const offenders = [];
const staleExempt = [];

for (const abs of tsFiles) {
  const rel = toPosix(relative(ROOT, abs));
  const raw = readFileSync(abs, 'utf8');
  const code = stripComments(raw);

  // The state regex must match on a line basis: split on newlines and re-test.
  // (Using `m` flag alone wasn't enough because we want a true module-scope
  // anchor — a line that starts with `let` after stripping comments.)
  let hasScopedState = false;
  for (const line of code.split(/\r?\n/)) {
    if (SCOPED_STATE_RE.test(line)) {
      hasScopedState = true;
      break;
    }
  }
  if (!hasScopedState) continue;

  const subscribes = SUBSCRIBE_RE.test(code);
  const exemptReason = EXEMPT_MODULES.get(rel);
  if (exemptReason) {
    if (subscribes) {
      staleExempt.push({ rel, reason: exemptReason });
    }
    continue;
  }
  if (!subscribes) {
    offenders.push(rel);
  }
}

let ok = true;

if (offenders.length > 0) {
  ok = false;
  console.error('[check-vault-scoped-state] FAILED — modules with module-scoped chained state but no onVaultSwap subscription:');
  for (const rel of offenders.sort()) {
    console.error(`  ${rel}`);
  }
  console.error(
    '\nFix: subscribe via `onVaultSwap(\'pre-swap\', \'<name>\', () => { /* reset */ });`\n' +
      '     at module init, or add the path to EXEMPT_MODULES in\n' +
      '     scripts/check-vault-scoped-state.mjs with a one-line reason.',
  );
}

if (staleExempt.length > 0) {
  ok = false;
  console.error('\n[check-vault-scoped-state] FAILED — EXEMPT_MODULES entries that DO subscribe (redundant):');
  for (const { rel, reason } of staleExempt) {
    console.error(`  ${rel} — exempt reason was: "${reason}"`);
  }
  console.error('\nFix: remove these paths from EXEMPT_MODULES in scripts/check-vault-scoped-state.mjs.');
}

if (!ok) process.exit(1);

const exemptCount = EXEMPT_MODULES.size;
const subscribedCount = tsFiles.filter((abs) => {
  const code = stripComments(readFileSync(abs, 'utf8'));
  if (!code.split(/\r?\n/).some((line) => SCOPED_STATE_RE.test(line))) return false;
  return SUBSCRIBE_RE.test(code);
}).length;
console.log(
  `[check-vault-scoped-state] OK — ${subscribedCount} modules with chained state subscribed, ${exemptCount} exempt.`,
);
process.exit(0);

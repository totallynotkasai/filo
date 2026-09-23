/**
 * Vault-scoped-state gate (Phase 3, IMPL_PLAN 2026-05-25; extended in
 * Phase 6.1.R2 to cover the `const Map/Set` pattern the audit-3 leakers
 * used).
 *
 * Complements `ci:vault-lifecycle-coverage` (which catches modules with
 * `$state(...)` but no `onVaultSwap(...)`). That gate uses Svelte runes as
 * its trip-wire, which means a plain `let foo = new Map<...>()` or
 * `const bar = new Map<...>()` at module scope — the exact pattern used by
 * `inFlightDriftPrompts`, `readOnlyTagToastShown`, `testFlushers`, and the
 * recovery sentinels — slips through.
 *
 * This gate walks `src/renderer/stores/**`, `src/renderer/lib/vault/**`, and
 * `src/renderer/lib/boards/**`, picks modules that declare module-scoped
 * `let <name> = new Map(…)`, `const <name> = new Map(…)`, `new Set(…)`,
 * `new WeakMap(…)`, `new WeakSet(…)`, or `Promise.resolve(…)`, and asserts
 * each one also calls `onVaultSwap(…)` OR `vaultSwapResettable(…)`.
 *
 * Modules that own such state but don't need a vault-swap reset (e.g. the
 * vault store itself, which OWNS the swap event and resets its own state
 * inline inside `openVault`) live in EXEMPT_MODULES below with a short
 * reason. Individual declarations can also carry an inline escape
 * `// allow-module-state: <reason>` for genuinely-shared infrastructure
 * (loggers, registries) — keep the escape rare and the reason concrete.
 *
 * Fixing a failure: either subscribe via
 *   `vaultSwapResettable('storeName.<state>', () => { <name>.clear(); });`
 * (preferred for state-reset-only handlers) or
 *   `onVaultSwap('pre-swap', 'storeName', () => { ... });`
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

// Module-scoped `let` / `const` declarations whose initializer is
// `new Map(...)`, `new Set(...)`, `new WeakMap(...)`, `new WeakSet(...)`,
// `new SvelteMap(...)`, `new SvelteSet(...)`, or `Promise.resolve(...)`.
// The `^` anchors to a line start (after comment stripping) so we only
// flag top-level declarations — locals inside a function body are fine.
//
// Phase 6.1.R2 — extended to catch `const` declarations alongside `let`.
// The audit-3 leakers (`inFlightDriftPrompts`, `readOnlyTagToastShown`,
// `testFlushers`) all used `const`, and the prior `let`-only regex
// silently let them through. `SvelteMap`/`SvelteSet` are included
// because the reactive variants are how stores (`*.svelte.ts`) typically
// declare path/id-keyed caches.
//
// The optional `: <type>` group covers TypeScript annotations like
// `const foo: Map<string, X> = new Map();`. Multiline-flag is OFF
// (default); the regex is applied per-line so the anchor behaves as
// "start of declaration line", which is what we want.
const SCOPED_STATE_RE = /^(?:let|const)\s+\w+(?:\s*:\s*[^=]+)?\s*=\s*(?:new\s+(?:(?:Weak|Svelte)?(?:Map|Set))\b|Promise\.resolve\b)/m;
// Either onVaultSwap('pre-swap', name, fn) or vaultSwapResettable(name, fn)
// satisfies the gate — the latter is the Phase 6.1.R2 entry point for
// state-reset-only registrations.
const SUBSCRIBE_RE = /(?<![A-Za-z0-9_$])(?:onVaultSwap|vaultSwapResettable)\s*\(/;
// Per-line escape so a single declaration can opt out (loggers, registry
// patterns, intentionally-immutable lookup tables). The reason must follow.
const ALLOW_INLINE_RE = /\/\/\s*allow-module-state:\s*\S+/;

/**
 * Strip block + line comments while preserving line counts so a `code`
 * line index aligns with the same index in the `raw` text (Phase 6.1.R2:
 * the inline `// allow-module-state:` escape check reads the original
 * line, and the indices must line up).
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

const offenders = [];
const staleExempt = [];

for (const abs of tsFiles) {
  const rel = toPosix(relative(ROOT, abs));
  const raw = readFileSync(abs, 'utf8');
  const code = stripComments(raw);

  // The state regex must match on a line basis: split on newlines and
  // re-test. (Using `m` flag alone wasn't enough because we want a true
  // module-scope anchor — a line that starts with `let` after stripping
  // comments.) Phase 6.1.R2 — a per-declaration `// allow-module-state:`
  // escape on the same line OR the preceding line opts that specific
  // declaration out, so a single shared registry doesn't force the whole
  // module into an EXEMPT_MODULES entry.
  const codeLines = code.split(/\r?\n/);
  const rawLines = raw.split(/\r?\n/);
  let hasScopedState = false;
  for (let i = 0; i < codeLines.length; i++) {
    if (!SCOPED_STATE_RE.test(codeLines[i])) continue;
    const annotationWindow = `${rawLines[i - 1] ?? ''}\n${rawLines[i] ?? ''}`;
    if (ALLOW_INLINE_RE.test(annotationWindow)) continue;
    hasScopedState = true;
    break;
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
  console.error('[check-vault-scoped-state] FAILED — modules with module-scoped chained state but no onVaultSwap / vaultSwapResettable subscription:');
  for (const rel of offenders.sort()) {
    console.error(`  ${rel}`);
  }
  console.error(
    '\nFix: subscribe via `vaultSwapResettable(\'<name>\', () => { /* reset */ });`\n' +
      '     (preferred for state-reset-only handlers) or\n' +
      '     `onVaultSwap(\'pre-swap\', \'<name>\', () => { /* reset */ });`\n' +
      '     at module init, OR annotate a specific declaration with\n' +
      '     `// allow-module-state: <reason>` on the same or preceding line,\n' +
      '     OR add the path to EXEMPT_MODULES in\n' +
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

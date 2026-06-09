/**
 * Audit-15 P6.4 — `ci:css-vars`.
 *
 * P1.2 shipped `background: var(--ui-accent)` / `color: var(--ui-accent-text, white)`
 * / `var(--ui-surface-deep)` in SearchPanel — three custom properties defined
 * NOWHERE (the real tokens are `--accent-primary` / `--text-inverse` / `--ui-surface`).
 * The no-fallback `var(--ui-accent)` resolved to nothing (no accent fill) and the
 * fallback-masked `var(--ui-accent-text, white)` painted white-on-near-white —
 * the active Replace toggle was invisible in the light/sepia/forest themes. Pure
 * CSS, so no unit test caught it; `svelte-check` doesn't validate CSS var names.
 *
 * This gate collects every custom property DEFINED in the repo and every
 * `var(--x)` USE with NO fallback, then fails on any used-but-never-defined
 * token. A `var(--x, fallback)` is intentionally NOT flagged (the fallback makes
 * it render *something*; P1.2's invisible-white line had a fallback and is
 * therefore out of scope here — the no-fallback `var(--ui-accent)` on the SAME
 * toggle is the load-bearing catch).
 *
 * DEFINED — collected GENEROUSLY (over-collection only risks a false NEGATIVE,
 * never a false positive), repo-wide union (a var defined in a parent component's
 * inline style and consumed by a child via CSS inheritance is legitimately
 * cross-file):
 *   - `--name:`                  CSS property defs (.css + .svelte <style> + inline `style="--x: …"`)
 *   - `style:--name`             Svelte style directive (TaskItem `style:--task-depth`, etc.)
 *   - `setProperty('--name'…)`   runtime injection (App.svelte font/scale vars, AppShell chrome heights)
 *
 * USED (no fallback) — collected PRECISELY, only in style contexts so a `var(--x)`
 * inside a test fixture / JS string / comment can't trip it:
 *   - .css files (block-comments blanked)
 *   - .svelte files with <script> blocks + HTML comments + CSS block comments blanked
 *     (leaves <style> rules + inline `style="…var(--x)…"` attributes)
 *
 * Offsets are preserved through blanking (matched spans → same-length spaces,
 * newlines kept) so reported line numbers point at the real source line.
 *
 * Escape hatch: ALLOWLIST (documented) for a token genuinely defined outside what
 * the collector can see (a 3rd-party stylesheet / a runtime mechanism not matched
 * above). Empty today — the collector sees every Filo definition mechanism.
 *
 * Bite-verify: add `color: var(--does-not-exist)` to any .svelte <style> → red.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep, extname } from 'node:path';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');

function toPosix(p) {
  return p.split(sep).join('/');
}

function walk(dir, exts, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      if (entry === 'node_modules' || entry === '.git') continue;
      walk(full, exts, out);
    } else if (exts.includes(extname(entry))) {
      out.push(full);
    }
  }
}

/** Replace every match of `re` with same-length whitespace (newlines kept) so
 *  offsets — hence line numbers — survive. */
function blankMatches(src, re) {
  return src.replace(re, (m) => m.replace(/[^\n]/g, ' '));
}

const blankBlockComments = (s) => blankMatches(s, /\/\*[\s\S]*?\*\//g); // CSS + JS /* … */
const blankHtmlComments = (s) => blankMatches(s, /<!--[\s\S]*?-->/g);
const blankScriptBlocks = (s) => blankMatches(s, /<script[\s\S]*?<\/script>/gi);

/**
 * Tokens genuinely defined outside the collector's reach (3rd-party CSS, a
 * runtime mechanism not matched above). Each MUST carry a reason. Empty today.
 */
const ALLOWLIST = new Map([
  // ['--some-external-var', 'defined by <library> stylesheet, not in src/'],
]);

// ── DEFINITIONS ──────────────────────────────────────────────────────────────
const defined = new Set();
// A custom-property DEFINITION: `--name:` not itself inside a var() arg list (the
// negative lookbehind rejects `var(--x):`-style false hits, which don't occur).
const DEF_PROP = /(?<![\w-])--([A-Za-z_][\w-]*)\s*:/g;
const DEF_STYLE_DIRECTIVE = /\bstyle:--([A-Za-z_][\w-]*)/g;
const DEF_SETPROP = /setProperty\(\s*['"`]--([A-Za-z_][\w-]*)/g;

const cssFiles = [];
const svelteFiles = [];
const tsFiles = [];
walk(SRC, ['.css'], cssFiles);
walk(SRC, ['.svelte'], svelteFiles);
walk(SRC, ['.ts'], tsFiles);

for (const abs of cssFiles) {
  const raw = readFileSync(abs, 'utf8');
  for (const m of raw.matchAll(DEF_PROP)) defined.add(m[1]);
}
for (const abs of svelteFiles) {
  const raw = readFileSync(abs, 'utf8');
  for (const m of raw.matchAll(DEF_PROP)) defined.add(m[1]);
  for (const m of raw.matchAll(DEF_STYLE_DIRECTIVE)) defined.add(m[1]);
  for (const m of raw.matchAll(DEF_SETPROP)) defined.add(m[1]);
}
for (const abs of tsFiles) {
  const raw = readFileSync(abs, 'utf8');
  for (const m of raw.matchAll(DEF_SETPROP)) defined.add(m[1]);
}

// ── USES (no fallback) ───────────────────────────────────────────────────────
// `var(--name)` with NO comma before the close = no fallback. `var(--name, …)`
// is excluded (the fallback renders something).
const USE_NOFALLBACK = /var\(\s*--([A-Za-z_][\w-]*)\s*\)/g;
const failures = [];

function scanUses(relPath, text) {
  for (const m of text.matchAll(USE_NOFALLBACK)) {
    const name = `--${m[1]}`;
    if (defined.has(m[1]) || ALLOWLIST.has(name)) continue;
    const line = text.slice(0, m.index).split('\n').length;
    failures.push(`${relPath}:${line} — var(${name}) used with no fallback, but ${name} is defined nowhere`);
  }
}

for (const abs of cssFiles) {
  const rel = toPosix(relative(ROOT, abs));
  scanUses(rel, blankBlockComments(readFileSync(abs, 'utf8')));
}
for (const abs of svelteFiles) {
  const rel = toPosix(relative(ROOT, abs));
  let s = readFileSync(abs, 'utf8');
  s = blankScriptBlocks(s); // JS may carry var(--x) in strings / comments
  s = blankHtmlComments(s);
  s = blankBlockComments(s); // CSS /* … */ inside <style>
  scanUses(rel, s);
}

// Tripwire — the collector must keep seeing a substantial token universe; a
// regex that silently stopped matching (refactor to a constant, etc.) would
// collapse `defined` toward empty and turn the gate into a no-op that "passes".
// ~180 custom properties today; floor well below, far above 0.
const MIN_DEFINED = 80;
if (defined.size < MIN_DEFINED) {
  failures.push(
    `collected only ${defined.size} defined custom propert${defined.size === 1 ? 'y' : 'ies'} ` +
      `(expected ≥ ${MIN_DEFINED}); the DEF_* collectors likely went stale — re-point them + ` +
      're-baseline MIN_DEFINED in scripts/check-css-vars.mjs.',
  );
}

if (failures.length > 0) {
  console.error('[check-css-vars] FAILED — undefined CSS custom property used without a fallback:');
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    '\nA `var(--x)` with no fallback whose `--x` is defined in no theme block, component\n' +
      '<style>, inline style, style:--x directive, or setProperty(\'--x\') renders to nothing —\n' +
      'invisible text / missing accent fills (P1.2). Use an existing token (grep src/css/style.css\n' +
      'for the real name), add a sensible `var(--x, <fallback>)`, or — if the token is genuinely\n' +
      'defined outside src/ — add it to ALLOWLIST with a reason in scripts/check-css-vars.mjs.',
  );
  process.exit(1);
}

console.log(
  `[check-css-vars] OK — ${defined.size} custom properties defined; every no-fallback var(--x) resolves.`,
);
process.exit(0);

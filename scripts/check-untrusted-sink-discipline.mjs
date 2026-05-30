/**
 * CI gate — untrusted-to-sink discipline (ERROR after Phase 5 landed).
 *
 * Per IMPLEMENTATION_PLAN_2026-05-27 §Phase 5, three sinks must accept
 * only values produced by an `asSafe*` validator from
 * `src/shared/untrusted.ts`:
 *
 *   1. `<iframe src={...}>` — sanitised via `asSafeIframeSrc`.
 *   2. `setProperty('--<theme-var>', value)` — sanitised via `asSafeThemeValue`.
 *   3. Renderer-side `window.filo.invoke('media:open-external', url)` /
 *      `invokeOk('media:open-external', url)` — sanitised via `asSafeOpenExternal`.
 *
 * Main-side `shell.openExternal(url)` is the IPC backend for #3; it's
 * gated by the renderer-side check above plus a defence-in-depth
 * scheme allowlist + file-extension blocklist inside the handler.
 *
 * Phase 5 flipped this gate from warn-only to error. A new sink callsite
 * that consumes a raw vault-string MUST route through a validator OR
 * carry an explicit `// allow-untrusted-sink: <reason>` annotation
 * (use sparingly — every escape hatch is a potential XSS / info-leak
 * audit point).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const WARN_ONLY = false;

function toPosix(p) {
  return p.split(sep).join('/');
}

const SAFE_VALIDATORS = [
  'asSafeIframeSrc',
  'asSafeThemeValue',
  'asSafeOpenExternal',
  'asSafeUrl',
  'SanitisedUrl',
  'SanitisedColor',
  'SanitisedSrc',
];

/**
 * Each rule defines a sink, the scan root, file extensions of interest,
 * and the patterns that flag a raw-value call. The `expectsSanitiser`
 * regex is searched within a small window around the match — if it
 * fires, the site is considered compliant.
 */
const RULES = [
  {
    name: 'iframe-src',
    scanRoots: [join(ROOT, 'src/renderer/components')],
    exts: ['.svelte'],
    description: '<iframe src={...}> renders an unsanitised vault-string',
    // Match `src={...}` inside `<iframe ...>` tags. We use a narrow
    // text pattern rather than a full HTML parser: any line containing
    // `<iframe ` (with a space) AND `src={` (any brace expression)
    // qualifies as a candidate.
    matchPattern: /<iframe\b[\s\S]*?\bsrc=\{[^}]+\}/g,
    sanitiserNearbyPattern: /(asSafeIframeSrc|SanitisedSrc)\(/,
    nearbyLines: 3,
  },
  {
    name: 'theme-css-var',
    // Scoped to the themes module — that's the only place CSS variables
    // are written from vault-shipped JSON. Other `setProperty` call
    // sites (inline tile sizing etc.) use values the renderer itself
    // produced and are not in scope for this gate.
    scanRoots: [join(ROOT, 'src/renderer/lib/themes')],
    exts: ['.ts'],
    description: 'setProperty(<--var>, value) consumes raw theme JSON value',
    // Match any `.setProperty(<arg>, <arg>)` inside the themes module —
    // the looped form (`setProperty(prop, value)` where `prop` is the
    // iteration key) doesn't have a literal `--` first arg, so a tighter
    // literal-prefix pattern would miss the only real call site today.
    matchPattern: /\.setProperty\(\s*\w+\s*,\s*\w+\s*\)/g,
    sanitiserNearbyPattern: /(asSafeThemeValue|SanitisedColor)\(/,
    nearbyLines: 3,
  },
  {
    name: 'media-open-external (renderer)',
    scanRoots: [join(ROOT, 'src/renderer')],
    exts: ['.ts', '.svelte'],
    description: "renderer invokes 'media:open-external' with a raw URL",
    // Two invocation forms — raw `window.filo.invoke(channel, ...)` and
    // the envelope-aware `invokeOk(channel, ...)` wrapper. Both pass
    // the URL through to the main handler, so both need the validator
    // upstream.
    matchPattern: /(?:window\.filo\.invoke|invokeOk)\(\s*['"]media:open-external['"]/g,
    sanitiserNearbyPattern: /(asSafeOpenExternal|SanitisedUrl)\(/,
    // Slightly larger than `iframe-src`/`theme-css-var` because the URL
    // sanitiser commonly sits a few lines above the `invoke` in a click
    // handler (validator → preventDefault → stopPropagation → comment →
    // invoke), and we want the natural call-handler shape to satisfy
    // the gate without forcing trailing-comment contortions.
    nearbyLines: 8,
  },
];

// ── Scanner ────────────────────────────────────────────────────────────

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

const offenders = [];
const compliantCounts = Object.fromEntries(RULES.map((r) => [r.name, 0]));
const violationCounts = Object.fromEntries(RULES.map((r) => [r.name, 0]));

for (const rule of RULES) {
  const files = [];
  for (const root of rule.scanRoots) walkExt(root, rule.exts, files);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    for (const match of text.matchAll(rule.matchPattern)) {
      const startIdx = match.index ?? 0;
      const linesBefore = text.slice(0, startIdx).split('\n');
      const lineNo = linesBefore.length;
      // Escape hatch — same line or any of the preceding 3 lines.
      const annotationWindow = lines
        .slice(Math.max(0, lineNo - 4), lineNo)
        .join('\n');
      if (annotationWindow.includes('allow-untrusted-sink:')) continue;

      // Bidirectional window — sanitiser may appear before the call site
      // (typical `const safe = asSafe...(); ... sink(safe);` pattern) or
      // after it (rare, but legal in helper-function bodies). Symmetric
      // around the match so the gate matches the comment's "around"
      // wording.
      const windowStart = Math.max(0, lineNo - 1 - rule.nearbyLines);
      const windowEnd = Math.min(lines.length, lineNo + rule.nearbyLines);
      const windowText = lines.slice(windowStart, windowEnd).join('\n');
      const isCompliant = rule.sanitiserNearbyPattern.test(windowText);
      if (isCompliant) {
        compliantCounts[rule.name]++;
      } else {
        violationCounts[rule.name]++;
        offenders.push({
          rule: rule.name,
          description: rule.description,
          file: toPosix(relative(ROOT, file)),
          line: lineNo,
          snippet: (lines[lineNo - 1] ?? '').trim(),
        });
      }
    }
  }
}

// ── Report ─────────────────────────────────────────────────────────────

if (offenders.length === 0) {
  process.stdout.write('[check-untrusted-sink-discipline] OK — every sink uses an asSafe* validator.\n');
  for (const r of RULES) {
    process.stdout.write(`  ${r.name}: ${compliantCounts[r.name]} compliant\n`);
  }
  process.exit(0);
}

const stream = WARN_ONLY ? process.stdout : process.stderr;
const label = WARN_ONLY ? 'WARN' : 'FAIL';
stream.write(
  `[check-untrusted-sink-discipline] ${label} — ${offenders.length} sink callsite(s) consume raw values without an asSafe* validator:\n`,
);
for (const r of RULES) {
  stream.write(
    `  ${r.name}: ${violationCounts[r.name]} violations (${compliantCounts[r.name]} compliant) — ${r.description}\n`,
  );
}
stream.write('\nViolations:\n');
for (const o of offenders) {
  stream.write(`  [${o.rule}] ${o.file}:${o.line}\n`);
  stream.write(`    ${o.snippet}\n`);
}
stream.write(
  `\nPhase 5 will add validator constructors in src/shared/untrusted.ts:\n` +
    `  asSafeIframeSrc(raw: Untrusted<string>): SanitisedSrc | null\n` +
    `  asSafeThemeValue(raw: Untrusted<string>): SanitisedColor | null\n` +
    `  asSafeOpenExternal(raw: Untrusted<string>): SanitisedUrl | null\n` +
    `Recognised validator names: ${SAFE_VALIDATORS.join(', ')}.\n` +
    `Escape hatch: append \`// allow-untrusted-sink: <reason>\` to the call site\n` +
    `(use sparingly — every escape hatch is a potential XSS / info-leak audit point).\n`,
);

if (WARN_ONLY) {
  process.stdout.write(
    `\n[check-untrusted-sink-discipline] WARN-ONLY — exit 0 (will flip to error at end of Phase 5).\n`,
  );
  process.exit(0);
}
process.exit(1);

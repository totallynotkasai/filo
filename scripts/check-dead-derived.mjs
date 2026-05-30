/**
 * Dead-`$derived` ratchet (Phase 7, CONSOLIDATION_PLAN_2026-05-25).
 *
 * `$derived(<literal>)` and `$derived(() => <literal>)` are reactivity dead
 * weight — the wrapped value never changes, so the rune doesn't observe any
 * state, but the declaration still consumes Svelte's reactivity machinery and
 * fools readers into thinking the variable is live. Phase 7 fixed
 * `TaskListBoard.svelte:147` (`sectionsActive = $derived(true)`); this gate
 * keeps the bug class from drifting back in.
 *
 * The gate scans every `.svelte` and `.svelte.ts` file under `src/renderer/`
 * (only those can host runes) and fails on:
 *
 *   $derived(<primitive-literal>)
 *   $derived(() => <primitive-literal>)
 *   $derived.by(() => <primitive-literal>)
 *   $derived<T>(<primitive-literal>)
 *
 * where <primitive-literal> is one of:
 *   true | false | null | undefined
 *   <number-literal>           (123, -1, 0, NaN, Infinity)
 *   '<string>' | "<string>"    (no template literal — those may interpolate)
 *   []                         (empty array)
 *   {}                         (empty object)
 *
 * Template literals are intentionally excluded — `$derived(\`...${x}...\`)`
 * is reactive on `x`. A reviewer can still spot a no-interpolation template
 * literal manually; gating on it would risk false positives.
 *
 * Multi-line `$derived(...)` calls are matched by stripping line-internal
 * whitespace and joining lines bounded by balanced parens. The matcher is
 * conservative: anything that looks like a function call, identifier
 * dereference, or arithmetic expression inside `$derived(...)` is ignored.
 *
 * Escape hatch: `// allow-dead-derived: <reason>` on the same line OR the
 * immediately preceding line skips that callsite. Use only when the
 * derivation is intentionally a constant (e.g. a placeholder during a
 * staged refactor).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const SCAN_DIRS = ['src/renderer'];
const EXTENSIONS = ['.svelte', '.svelte.ts'];

// Match `$derived(...)`, `$derived.by(...)`, and `$derived<T>(...)` where the
// inner expression is one of the literal forms enumerated below. The matcher
// runs against a per-callsite "argument string" extracted by paren balancing
// so multi-line declarations are handled correctly.
//
// Allowed literal forms (matched verbatim against the trimmed arg string):
const DEAD_LITERAL_RE = new RegExp(
  '^(' +
    // primitive keywords
    'true|false|null|undefined' +
    // numeric literals (incl. negative + scientific + hex)
    '|-?(0[xX][0-9a-fA-F]+|\\d+(\\.\\d+)?([eE][+-]?\\d+)?|Infinity|NaN)' +
    // string literals (no template — could interpolate)
    "|'[^'\\\\]*'|\"[^\"\\\\]*\"" +
    // empty array / object
    '|\\[\\s*\\]|\\{\\s*\\}' +
    ')$',
);

const DERIVED_INTRO_RE = /\$derived(?:\.by)?(?:\s*<[^>]+>)?\s*\(/g;

/**
 * Replace line/block-comment contents with spaces of the same length so the
 * matcher doesn't false-positive on a `$derived(true)` reference inside a
 * docblock. Newlines are preserved so line numbers (computed against the
 * original source) stay accurate.
 */
function blankComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    // line comment
    if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      const end = nl === -1 ? src.length : nl;
      out += ' '.repeat(end - i);
      i = end;
      continue;
    }
    // block comment
    if (ch === '/' && src[i + 1] === '*') {
      const closeIdx = src.indexOf('*/', i + 2);
      const end = closeIdx === -1 ? src.length : closeIdx + 2;
      for (let j = i; j < end; j++) {
        out += src[j] === '\n' ? '\n' : ' ';
      }
      i = end;
      continue;
    }
    // strings: copy through unchanged so `extractArg` still sees real
    // string contents and balances correctly. Skip past them to avoid
    // misinterpreting a `//` inside a string as a comment.
    if (ch === '\'' || ch === '"' || ch === '`') {
      const quote = ch;
      out += ch;
      i++;
      while (i < src.length) {
        const c = src[i];
        out += c;
        if (c === '\\' && i + 1 < src.length) {
          out += src[i + 1];
          i += 2;
          continue;
        }
        if (c === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function toPosix(p) {
  return p.split(sep).join('/');
}

function hasTrackedExtension(name) {
  return EXTENSIONS.some((ext) => name.endsWith(ext));
}

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) walk(full, out);
    else if (s.isFile() && hasTrackedExtension(entry)) out.push(full);
  }
}

/**
 * Read the `$derived(...)` arg as a single string by paren-balancing from
 * the opening paren at `startIdx`. Returns `{ arg, endIdx }` where `endIdx`
 * points at the matching close paren, or `null` if the parens are unbalanced.
 *
 * Comments and string contents are skipped while balancing so a closing `)`
 * inside a string doesn't confuse the depth counter.
 */
function extractArg(src, startIdx) {
  let depth = 1;
  let i = startIdx + 1;
  let start = i;
  while (i < src.length) {
    const ch = src[i];
    // skip line comments
    if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl + 1;
      continue;
    }
    // skip block comments
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    // skip strings (single, double, template)
    if (ch === '\'' || ch === '"' || ch === '`') {
      const quote = ch;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        // template literal: skip ${...} via paren-style depth on `{`/`}`
        if (quote === '`' && src[i] === '$' && src[i + 1] === '{') {
          let braceDepth = 1;
          i += 2;
          while (i < src.length && braceDepth > 0) {
            if (src[i] === '{') braceDepth++;
            else if (src[i] === '}') braceDepth--;
            i++;
          }
          continue;
        }
        i++;
      }
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) {
        return { arg: src.slice(start, i), endIdx: i };
      }
    }
    i++;
  }
  return null;
}

/**
 * Detect `() => <literal>` arrow forms. Returns the matched literal string
 * (trimmed) or null. Only matches single-expression arrows — block-body
 * arrows `() => { return ... }` are intentionally not handled here because
 * they're rarely dead and add false-positive risk.
 */
function matchArrowReturningLiteral(arg) {
  const trimmed = arg.trim();
  // strict: `()=>X` or `() => X` (no parameters; one expression)
  const m = trimmed.match(/^\(\s*\)\s*=>\s*([\s\S]+)$/);
  if (!m) return null;
  const body = m[1].trim();
  return DEAD_LITERAL_RE.test(body) ? body : null;
}

function lineNumberOf(src, idx) {
  let count = 1;
  for (let i = 0; i < idx && i < src.length; i++) {
    if (src[i] === '\n') count++;
  }
  return count;
}

function lineContaining(src, idx) {
  const start = src.lastIndexOf('\n', idx - 1) + 1;
  const endNl = src.indexOf('\n', idx);
  const end = endNl === -1 ? src.length : endNl;
  return src.slice(start, end);
}

function previousLine(src, idx) {
  const start = src.lastIndexOf('\n', idx - 1);
  if (start <= 0) return '';
  const prevStart = src.lastIndexOf('\n', start - 1) + 1;
  return src.slice(prevStart, start);
}

const files = [];
for (const dir of SCAN_DIRS) walk(join(ROOT, dir), files);

const offenders = [];
let scannedCount = 0;

for (const abs of files) {
  const rel = toPosix(relative(ROOT, abs));
  scannedCount++;
  const rawSrc = readFileSync(abs, 'utf8');
  // Scan against a comment-blanked copy so a `$derived(true)` reference in a
  // docblock doesn't trip the gate. `extractArg` and the line-number /
  // line-context helpers below operate on the same blanked copy so positions
  // line up; original-source line text is fetched separately for the error
  // snippet.
  const src = blankComments(rawSrc);
  DERIVED_INTRO_RE.lastIndex = 0;
  let m;
  while ((m = DERIVED_INTRO_RE.exec(src)) !== null) {
    const openParen = m.index + m[0].length - 1;
    const extracted = extractArg(src, openParen);
    if (!extracted) continue;
    const trimmed = extracted.arg.trim();

    let deadValue = null;
    if (DEAD_LITERAL_RE.test(trimmed)) {
      deadValue = trimmed;
    } else {
      const arrowLit = matchArrowReturningLiteral(extracted.arg);
      if (arrowLit) deadValue = `() => ${arrowLit}`;
    }

    if (!deadValue) continue;

    const lineNo = lineNumberOf(src, m.index);
    // For escape-hatch detection AND the error snippet, use the ORIGINAL
    // source so the `// allow-dead-derived:` marker is visible.
    const line = lineContaining(rawSrc, m.index);
    const prev = previousLine(rawSrc, m.index);
    if (
      line.includes('// allow-dead-derived:') ||
      prev.includes('// allow-dead-derived:')
    ) {
      continue;
    }
    offenders.push({ rel, lineNo, value: deadValue, snippet: line.trim() });
  }
}

if (offenders.length === 0) {
  console.log(
    `[check-dead-derived] OK — scanned ${scannedCount} files, 0 dead derivations.`,
  );
  process.exit(0);
}

console.error(
  `[check-dead-derived] FAILED — ${offenders.length} dead \`$derived\` callsite(s):\n`,
);
for (const o of offenders) {
  console.error(`  ${o.rel}:${o.lineNo} → \`$derived(${o.value})\``);
  console.error(`    ${o.snippet}`);
}
console.error(
  '\nFix: replace `$derived(<literal>)` with the actual constant or the\n' +
    'real reactive expression it should track. A `$derived` whose body never\n' +
    'changes is reactivity dead weight and usually masks a missing dependency\n' +
    '(see TaskListBoard.svelte bug #5 — `sectionsActive = $derived(true)`).\n' +
    'If the constant is intentional, declare it as `const` instead.\n' +
    'If you genuinely need a derivation that resolves to a constant for now,\n' +
    'add `// allow-dead-derived: <reason>` to the same line.',
);
process.exit(1);

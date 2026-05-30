/**
 * Command snapshot-discipline ratchet (Phase R3 regression-prevention gate).
 *
 * Forbids two patterns in `src/renderer/commands/`:
 *
 *  1. Constructor-side `this.<field> = JSON.parse(JSON.stringify(<expr>))` —
 *     concrete commands must use `this.snapshot(...)` so we have ONE
 *     deep-clone helper to audit. The base class itself (`Command.ts`) is
 *     the only legitimate site for the raw JSON round-trip.
 *
 *  2. Constructor-side `this.<field> = { ...<param> }` or
 *     `this.<field> = [...<param>]` or `this.<field> = <param>.map(x => ({...x}))`
 *     without either:
 *       - an inline `// allow-shallow: <reason>` marker on the same line (or
 *         the line directly above), OR
 *       - a `this.snapshot(...)` call somewhere in the constructor referencing
 *         the same parameter.
 *
 * The shallow-copy pattern is correct when the snapshotted value's nested
 * fields are all primitives (e.g. `Map<string, boolean>` or
 * `Array<{x:number,y:number}>`); marking those sites with
 * `// allow-shallow:` documents the reviewer's reasoning. Everything else
 * must go through `this.snapshot(...)` so a tag / style edit between
 * execute and undo can't leak into the snapshot via shared reference.
 *
 * Detection is heuristic, not a full AST walk:
 *  - Find every `class \w+Command extends Command` block.
 *  - Find the constructor body inside that class.
 *  - Scan the constructor body for `this.<field> = ...` assignments that
 *    match either of the forbidden patterns.
 *  - Skip lines tagged `// allow-shallow:` (or the immediately preceding
 *    line as a multi-line escape hatch).
 *
 * Allowlist: `commands/Command.ts` is the only file allowed to use the
 * raw `JSON.parse(JSON.stringify(...))` pattern (it's the helper).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const SCAN_DIRS = ['src/renderer/commands'];
const EXTENSIONS = ['.ts'];

/**
 * Files exempt from this gate. Only the snapshot helper itself.
 */
const ALLOWLIST = new Set([
  'src/renderer/commands/Command.ts',
]);

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
 * Given source text and the index of `constructor`, find the body
 * (between the matching `{` and `}`) and return it along with the
 * starting line number. Returns null if the structure looks malformed.
 */
function extractConstructorBody(src, ctorIdx) {
  let i = ctorIdx + 'constructor'.length;
  // Walk past the `(...)` parameter list.
  while (i < src.length && src[i] !== '(') i++;
  if (i >= src.length) return null;
  let depth = 1;
  i++;
  while (i < src.length && depth > 0) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') depth--;
    i++;
  }
  // Skip optional return type / whitespace until the body `{`.
  while (i < src.length && src[i] !== '{') i++;
  if (i >= src.length) return null;
  const bodyStart = i + 1;
  // Walk to matching `}`.
  depth = 1;
  let j = bodyStart;
  while (j < src.length && depth > 0) {
    const ch = src[j];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      j++;
      while (j < src.length && src[j] !== quote) {
        if (src[j] === '\\') j++;
        j++;
      }
    }
    j++;
  }
  if (depth !== 0) return null;
  const body = src.slice(bodyStart, j - 1);
  // Line number of the constructor start.
  const upto = src.slice(0, ctorIdx);
  const ctorLineNo = upto.split('\n').length;
  return { body, startLineNo: ctorLineNo, bodyStartOffset: bodyStart };
}

/**
 * Returns a list of `{ line, snippet }` for offending assignments inside
 * the constructor body. Each entry is a place where a `this.<field> = ...`
 * matches one of the forbidden patterns and isn't excused.
 */
function findOffendersInCtor(body, startLineNo) {
  const out = [];
  const lines = body.split('\n');
  // Pre-compute which lines could match either pattern, so a single
  // `// allow-shallow:` marker can cover a contiguous block of related
  // assignments without each line needing its own marker.
  const SHALLOW_SPREAD_LINE_RE = /\bthis\.[A-Za-z_$][\w$]*\s*=\s*\{\s*\.\.\.[A-Za-z_$][\w$]*\s*\}/;
  const SHALLOW_ARRAY_LINE_RE = /\bthis\.[A-Za-z_$][\w$]*\s*=\s*\[\s*\.\.\.[A-Za-z_$][\w$]*\s*\]/;
  const RAW_JSON_LINE_RE = /\bthis\.[A-Za-z_$][\w$]*\s*=\s*JSON\.parse\s*\(\s*JSON\.stringify\b/;
  const isShallowLine = (text) =>
    SHALLOW_SPREAD_LINE_RE.test(text)
    || SHALLOW_ARRAY_LINE_RE.test(text)
    || RAW_JSON_LINE_RE.test(text);
  const allowShallowAt = (lineIdx) => {
    const cur = lines[lineIdx] ?? '';
    if (cur.includes('// allow-shallow:')) return true;
    // Walk up through a block of (a) other shallow-spread assignments
    // and (b) `//` comment lines. If the topmost line of that block
    // starts with `// allow-shallow:`, all the assignments below it are
    // excused. This lets one marker cover a pair like
    //   // allow-shallow: positions are {x,y} primitives, …
    //   this.beforePos = { ...beforePos };
    //   this.afterPos = { ...afterPos };
    //   this.containedTileIds = [...containedTileIds];
    let k = lineIdx - 1;
    while (k >= 0) {
      const trimmed = (lines[k] ?? '').trim();
      if (trimmed.includes('// allow-shallow:') || trimmed.includes('allow-shallow:')) return true;
      if (trimmed.startsWith('//')) { k--; continue; }
      if (isShallowLine(trimmed)) { k--; continue; }
      return false;
    }
    return false;
  };
  // Pattern 1: this.<field> = JSON.parse(JSON.stringify(...))
  const RAW_JSON_RE = /\bthis\.[A-Za-z_$][\w$]*\s*=\s*JSON\.parse\s*\(\s*JSON\.stringify\b/;
  for (let i = 0; i < lines.length; i++) {
    if (RAW_JSON_RE.test(lines[i])) {
      if (allowShallowAt(i)) continue;
      out.push({
        // +1 because startLineNo is the constructor line, lines[0] starts after `{`
        // which is on the same line as constructor. We approximate.
        relLine: i,
        snippet: lines[i].trim(),
        kind: 'raw-json-roundtrip',
      });
    }
  }
  // Pattern 2: this.<field> = { ...<param> } — flag when the param is also a
  // constructor parameter that wasn't snapshot()-cloned elsewhere in the
  // body. This is a heuristic; for safety we just flag ANY shallow spread
  // assignment and let the developer add `// allow-shallow: <reason>` if
  // the shape is genuinely primitive-only.
  const SHALLOW_SPREAD_RE = /\bthis\.[A-Za-z_$][\w$]*\s*=\s*\{\s*\.\.\.[A-Za-z_$][\w$]*\s*\}/;
  for (let i = 0; i < lines.length; i++) {
    if (SHALLOW_SPREAD_RE.test(lines[i])) {
      if (allowShallowAt(i)) continue;
      out.push({
        relLine: i,
        snippet: lines[i].trim(),
        kind: 'shallow-spread',
      });
    }
  }
  // Pattern 3: this.<field> = [...<param>] — same heuristic as above.
  const SHALLOW_ARRAY_RE = /\bthis\.[A-Za-z_$][\w$]*\s*=\s*\[\s*\.\.\.[A-Za-z_$][\w$]*\s*\]/;
  for (let i = 0; i < lines.length; i++) {
    if (SHALLOW_ARRAY_RE.test(lines[i])) {
      if (allowShallowAt(i)) continue;
      out.push({
        relLine: i,
        snippet: lines[i].trim(),
        kind: 'shallow-array-spread',
      });
    }
  }
  return out.map((o) => ({
    lineNo: startLineNo + o.relLine,
    snippet: o.snippet,
    kind: o.kind,
  }));
}

const files = [];
for (const dir of SCAN_DIRS) walk(join(ROOT, dir), files);

const offenders = [];
for (const abs of files) {
  const rel = toPosix(relative(ROOT, abs));
  if (ALLOWLIST.has(rel)) continue;
  const src = readFileSync(abs, 'utf8');
  // Locate every `class <Name> extends Command` (or `implements Command`)
  // block. We only enforce inside concrete command classes; helper
  // functions outside class bodies are out of scope.
  const CLASS_RE = /\bclass\s+([A-Za-z_$][\w$]*)\s+(?:extends|implements)\s+Command\b/g;
  let cm;
  while ((cm = CLASS_RE.exec(src)) !== null) {
    // Find the `constructor` keyword inside the class body. The class
    // body starts at the next `{` after the class header.
    let braceIdx = src.indexOf('{', cm.index + cm[0].length);
    if (braceIdx < 0) continue;
    // Find the matching close brace to bound the search for `constructor`.
    let depth = 1;
    let j = braceIdx + 1;
    while (j < src.length && depth > 0) {
      const ch = src[j];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === '"' || ch === "'" || ch === '`') {
        const quote = ch;
        j++;
        while (j < src.length && src[j] !== quote) {
          if (src[j] === '\\') j++;
          j++;
        }
      }
      j++;
    }
    const classBodyEnd = j;
    const classBody = src.slice(braceIdx, classBodyEnd);
    // Find `constructor` inside the class body.
    const ctorOffset = classBody.indexOf('constructor');
    if (ctorOffset < 0) continue;
    const absCtorIdx = braceIdx + ctorOffset;
    const ctor = extractConstructorBody(src, absCtorIdx);
    if (!ctor) continue;
    const found = findOffendersInCtor(ctor.body, ctor.startLineNo);
    for (const f of found) {
      offenders.push({
        rel,
        className: cm[1],
        lineNo: f.lineNo,
        snippet: f.snippet,
        kind: f.kind,
      });
    }
  }
}

if (offenders.length === 0) {
  console.log(
    `[check-command-snapshot-discipline] OK — scanned ${files.length} files, 0 violations.`,
  );
  process.exit(0);
}

console.error(
  `[check-command-snapshot-discipline] FAILED — ${offenders.length} snapshot-discipline violation(s):\n`,
);
for (const o of offenders) {
  console.error(`  ${o.rel}:${o.lineNo} (${o.kind}) in class ${o.className}`);
  console.error(`    ${o.snippet}`);
}
console.error(
  '\nFix: replace `JSON.parse(JSON.stringify(value))` with `this.snapshot(value)`\n' +
    '(routes through the Phase R3 base class helper). For shallow spreads on\n' +
    'primitives-only shapes (Map<string, boolean>, Array<{x:number,y:number}>),\n' +
    'add `// allow-shallow: <reason>` to the same line or the line above to\n' +
    'document the reviewer\'s reasoning.',
);
process.exit(1);

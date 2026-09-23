/**
 * Task List audit 2026-06-08 Phase 4 — `ci:tasklist-section-clamp`.
 *
 * Closes SEC-1 / SEC-2 / SEC-4 STRUCTURALLY (the behavioural matrix lives in
 * `boardCacheTaskList.test.ts`; this gate pins the *mechanism* in source so a
 * refactor can't silently delete it and re-open the class).
 *
 * Invariant: a Task List section `position` is an ABSOLUTE index into the flat
 * `tasks[]` array — section *k* owns the slice `[position_k, position_{k+1})`.
 * A `position > taskCount` is therefore NOT a valid index: it can't own any
 * task AND it silently misroutes a later add-to-section into an earlier
 * neighbour (SEC-1). The tail-tie dedup used to emit `taskCount+1, taskCount+2,
 * …` for stacked empty tail sections; the SEC-2 fix CLAMPS every normalised
 * position into `[0, taskCount]` (trailing empty ties PIN at taskCount), and the
 * SEC-4 fix relies on a STABLE sort so the caller's array order disambiguates
 * ties deterministically.
 *
 * `persistTaskListStructure` (`src/renderer/stores/boardCacheTaskList.ts`) is the
 * normalisation chokepoint — the one function that writes `sections` back to the
 * cache with re-derived positions. This gate extracts ONLY its body (strings +
 * comments blanked, so a comment / unrelated literal can't satisfy or trip it)
 * and asserts the clamp survives:
 *
 *   - the upper clamp `Math.min(<…>, taskCount)` (SEC-2: never emit > taskCount);
 *   - the lower clamp `Math.max(0, <…>)` / `Math.max(<…>, 0)`  (no negative idx);
 *   - the bound is `taskCount` (the live row count), not some other length;
 *   - a `.sort(` normalisation (SEC-4: deterministic tied-section order).
 *
 * Bite-verify: drop the `Math.min(s.position, taskCount)` clamp (or swap the
 * `taskCount` bound for `sections.length`) → red. Restore → green.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const FILE = 'src/renderer/stores/boardCacheTaskList.ts';
const FN = 'persistTaskListStructure';

/** Blank string/template/comment bodies (offset preserved) so only real code is scanned. */
function blankStringsAndComments(src) {
  let out = '';
  let state = 'code'; // code | line | block | sq | dq | tpl
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === 'code') {
      if (c === '/' && c2 === '/') { state = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && c2 === '*') { state = 'block'; out += '  '; i += 2; continue; }
      if (c === "'") { state = 'sq'; out += ' '; i += 1; continue; }
      if (c === '"') { state = 'dq'; out += ' '; i += 1; continue; }
      if (c === '`') { state = 'tpl'; out += ' '; i += 1; continue; }
      out += c; i += 1; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += '\n'; i += 1; continue; }
      out += ' '; i += 1; continue;
    }
    if (state === 'block') {
      if (c === '*' && c2 === '/') { state = 'code'; out += '  '; i += 2; continue; }
      out += c === '\n' ? '\n' : ' '; i += 1; continue;
    }
    if (state === 'sq' || state === 'dq') {
      const q = state === 'sq' ? "'" : '"';
      if (c === '\\') { out += '  '; i += 2; continue; }
      if (c === q) { state = 'code'; out += ' '; i += 1; continue; }
      out += c === '\n' ? '\n' : ' '; i += 1; continue;
    }
    // template literal
    if (c === '\\') { out += '  '; i += 2; continue; }
    if (c === '`') { state = 'code'; out += ' '; i += 1; continue; }
    out += c === '\n' ? '\n' : ' '; i += 1; continue;
  }
  return out;
}

/** Extracts the body `{...}` of the first definition of `fnName` (function or method). */
function extractBody(code, fnName) {
  const re = new RegExp(`(?:function\\s+)?\\b${fnName}\\s*\\(`, 'g');
  let m;
  while ((m = re.exec(code))) {
    let i = re.lastIndex - 1;
    let depth = 0;
    for (; i < code.length; i++) {
      if (code[i] === '(') depth++;
      else if (code[i] === ')') { depth--; if (depth === 0) { i++; break; } }
    }
    // Skip whitespace + an optional return-type annotation to the body's `{`.
    while (i < code.length && code[i] !== '{' && code[i] !== ';') i++;
    if (code[i] !== '{') continue; // a call / forward-decl, not a definition
    const start = i;
    let bdepth = 0;
    for (; i < code.length; i++) {
      if (code[i] === '{') bdepth++;
      else if (code[i] === '}') { bdepth--; if (bdepth === 0) { i++; break; } }
    }
    return code.slice(start, i);
  }
  return null;
}

const failures = [];

let raw;
try {
  raw = readFileSync(join(ROOT, FILE), 'utf8');
} catch (err) {
  failures.push(`${FILE} — cannot read: ${err.message}`);
}

if (raw !== undefined) {
  const code = blankStringsAndComments(raw);
  const body = extractBody(code, FN);
  if (body === null) {
    failures.push(
      `${FILE} — could not find function \`${FN}\` (the section-position normalisation ` +
        'chokepoint moved/renamed?). The SEC-1/2/4 clamp can no longer be verified.',
    );
  } else {
    // Upper clamp — the SEC-2 fix. `Math.min(<…>, taskCount)`: the bound MUST be
    // `taskCount` (the live row count), so a swap to `sections.length` (which can
    // exceed the row count) is caught too.
    const upperClamp = /Math\.min\s*\([^;]*?\btaskCount\b/;
    if (!upperClamp.test(body)) {
      failures.push(
        `${FILE} → ${FN} — missing the upper clamp \`Math.min(<…>, taskCount)\`. ` +
          'A section position may then exceed taskCount, which is not a valid index into ' +
          'tasks[] — it owns nothing and misroutes a later add-to-section into an earlier ' +
          'neighbour (SEC-1/SEC-2).',
      );
    }

    // Lower clamp — no negative index. Accept either argument order:
    //   Math.max(0, Math.min(...))   or   Math.max(Math.min(...), 0)
    const lowerClampLeading = /Math\.max\s*\(\s*0\b/;
    const lowerClampTrailing = /Math\.max\s*\([^;]*?,\s*0\s*\)/;
    if (!lowerClampLeading.test(body) && !lowerClampTrailing.test(body)) {
      failures.push(
        `${FILE} → ${FN} — missing the lower clamp \`Math.max(0, <…>)\`. ` +
          'A negative section position must be floored to 0.',
      );
    }

    // The bound itself must be derived from the live task count.
    if (!/\btaskCount\b/.test(body)) {
      failures.push(
        `${FILE} → ${FN} — the clamp bound \`taskCount\` is gone. The upper bound must be ` +
          'the live tasks[] length, not a constant or the section count.',
      );
    }

    // SEC-4 — deterministic tied-section order requires a (stable) sort of the
    // sections by position before clamping.
    if (!/\.sort\s*\(/.test(body)) {
      failures.push(
        `${FILE} → ${FN} — missing the \`.sort(\` normalisation. SEC-4: tied empty/populated ` +
          'sections at the same position must be ordered deterministically (a stable sort by ' +
          'position) or a hand-edited / future-built file can silently steal a populated ' +
          "section's slice.",
      );
    }
  }
}

if (failures.length > 0) {
  console.error('[check-tasklist-section-position-clamp] FAILED — section-position clamp regressed:');
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    '\nTask List section `position` is an absolute index into the flat tasks[] array.\n' +
      '`persistTaskListStructure` MUST normalise every section position into [0, taskCount]\n' +
      '(Math.max(0, Math.min(s.position, taskCount))) and sort sections by position. Emitting\n' +
      '`position > taskCount` re-opens SEC-1 (add-to-2nd-empty-section misroute) and SEC-2\n' +
      '(invalid on-disk index). See TASKLIST_AUDIT_2026-06-08.md §3D + Phase 4, and\n' +
      'src/tests/unit/boardCacheTaskList.test.ts (the [0, taskCount] / tail-tie / SEC-1 matrix).',
  );
  process.exit(1);
}

console.log(
  '[check-tasklist-section-position-clamp] OK — persistTaskListStructure clamps section ' +
    'positions into [0, taskCount] and sorts deterministically (SEC-1/SEC-2/SEC-4).',
);
process.exit(0);

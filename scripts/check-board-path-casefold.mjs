/**
 * Audit-12 M4 — `ci:board-path-casefold`.
 *
 * The DOCUMENT pipeline case-folds every vault-path compare (`samePath` /
 * `vaultPath()` / `normalizeVaultRelative`) because Windows/macOS aren't
 * case-sensitive. The BOARD pipeline used raw `===` / `normalizePath` (which
 * does NOT case-fold). On a case-insensitive FS, an externally edited/renamed
 * `.board.json` whose OS-reported casing diverged from the stored casing was
 * silently ignored (`findBoardIdForPath` returned null → no reload) or failed to
 * rebind on rename (`renameBoardPath` walked with `===` → board left keyed at
 * the stale path → phantom-file write + "missing on disk" eviction).
 *
 * The fix routes both functions through the case-folding normaliser. This gate
 * pins each on a string/comment-blanked copy of ONLY the target function's body
 * (so a comment, or an unrelated `===` elsewhere in the file, can't trip or
 * satisfy it).
 *
 * Audit-13 M13 — name-agnostic, structural (was: pinned exact prior local names,
 * evadable by renaming the locals + a no-op `normalizeVaultRelative()` call):
 *  - findBoardIdForPath must resolve via `samePath` ONLY, so ANY raw
 *    `===`/`!==`/`.startsWith(` in its body is the un-folded shape — forbidden
 *    regardless of operand names.
 *  - renameBoardPath: the per-board rebind `for` loop must FOLD each entry
 *    (`normalizeVaultRelative(` INSIDE the loop, not merely somewhere in the file)
 *    and EVERY compare line in it must reference a folded value (a local assigned
 *    from `normalizeVaultRelative` or an inline call). The L2 byte-identical
 *    true-no-op (`normalizePath(old) === normalizePath(new)`) lives OUTSIDE the
 *    loop and is intentionally case-SENSITIVE, so it is never examined.
 *
 * Bite-verify: rename the locals + use a raw `===`/`.startsWith(` on an un-folded
 * value (findBoardIdForPath) or inside the rebind loop (renameBoardPath) → red.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

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

/** Extracts the body `{...}` of the first `for (...)` block in `code`, or null. */
function extractLoopBody(code) {
  const m = /\bfor\b/.exec(code);
  if (!m) return null;
  let i = m.index;
  while (i < code.length && code[i] !== '(') i++;
  let pdepth = 0;
  for (; i < code.length; i++) {
    if (code[i] === '(') pdepth++;
    else if (code[i] === ')') { pdepth--; if (pdepth === 0) { i++; break; } }
  }
  while (i < code.length && code[i] !== '{' && code[i] !== ';') i++;
  if (code[i] !== '{') return null;
  const start = i;
  let bdepth = 0;
  for (; i < code.length; i++) {
    if (code[i] === '{') bdepth++;
    else if (code[i] === '}') { bdepth--; if (bdepth === 0) { i++; break; } }
  }
  return code.slice(start, i);
}

/** Local names assigned DIRECTLY from `normalizeVaultRelative(...)` (the folded forms). */
function collectFoldedLocals(code) {
  const set = new Set();
  const re = /\b(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*normalizeVaultRelative\s*\(/g;
  let m;
  while ((m = re.exec(code))) set.add(m[1]);
  return set;
}

/**
 * Lines inside the rebind loop that compare paths (`===` / `!==` / `.startsWith(`)
 * WITHOUT referencing a folded value — neither a folded local nor an inline
 * `normalizeVaultRelative(` call. These are the un-folded case-sensitive compares
 * the gate forbids; the operand NAMES don't matter, only that a folded value is
 * compared (so renaming `norm`/`normalisedOld` can't evade it).
 */
function loopCompareLinesLackingFold(loopBody, foldedLocals) {
  const bad = [];
  for (const line of loopBody.split('\n')) {
    if (!/===|!==|\.startsWith\s*\(/.test(line)) continue;
    if (/normalizeVaultRelative\s*\(/.test(line)) continue; // inline fold on the compare line
    const usesFolded = [...foldedLocals].some((n) => new RegExp(`\\b${n}\\b`).test(line));
    if (!usesFolded) bad.push(line.trim());
  }
  return bad;
}

const TARGETS = [
  {
    file: 'src/renderer/stores/vaultExternalReconcilers.ts',
    fn: 'findBoardIdForPath',
    required: [{ token: /\bsamePath\s*\(/, why: 'case-folding board-path compare (samePath)' }],
    // Audit-13 M13 — name-agnostic: the board lookup must resolve via `samePath`
    // ONLY, so ANY raw `===`/`!==`/`.startsWith(` in the body is the un-folded
    // case-sensitive shape — forbidden regardless of the operand names. (The old
    // gate pinned `boardPath ===` / `=== rel`, evadable by renaming the locals.)
    forbidden: [
      { token: /===|!==/, why: 'a raw (case-sensitive) equality compare — resolve via samePath()' },
      { token: /\.startsWith\s*\(/, why: 'a raw (case-sensitive) prefix compare — resolve via samePath()' },
    ],
  },
  {
    file: 'src/renderer/stores/boardCache.svelte.ts',
    fn: 'renameBoardPath',
    required: [{ token: /\bnormalizeVaultRelative\s*\(/, why: 'case-folding rename key compare (normalizeVaultRelative)' }],
    // Audit-13 M13 — assert the SAFETY INVARIANT structurally instead of pinning the
    // old local names (`norm === normalisedOld` / `norm.startsWith(oldPrefix)`,
    // evadable by renaming + a no-op `normalizeVaultRelative()` call elsewhere): the
    // per-board rebind loop must FOLD each entry and EVERY compare inside it must
    // reference a folded value. The L2 byte-identical true-no-op
    // (`normalizePath(old) === normalizePath(new)`) lives OUTSIDE the loop and is
    // intentionally case-SENSITIVE, so it is never examined.
    loopFold: true,
  },
];

const failures = [];
for (const target of TARGETS) {
  let raw;
  try {
    raw = readFileSync(join(ROOT, target.file), 'utf8');
  } catch (err) {
    failures.push(`${target.file} — cannot read: ${err.message}`);
    continue;
  }
  const code = blankStringsAndComments(raw);
  const body = extractBody(code, target.fn);
  if (body === null) {
    failures.push(`${target.file} — could not find function \`${target.fn}\` (gate target moved/renamed?)`);
    continue;
  }
  for (const { token, why } of target.required ?? []) {
    if (!token.test(body)) {
      failures.push(`${target.file} → ${target.fn} — missing /${token.source}/ — ${why}`);
    }
  }
  for (const { token, why } of target.forbidden ?? []) {
    if (token.test(body)) {
      failures.push(`${target.file} → ${target.fn} — found forbidden /${token.source}/ — ${why}`);
    }
  }
  // Audit-13 M13 — renameBoardPath: structurally assert the rebind loop folds.
  if (target.loopFold) {
    const loopBody = extractLoopBody(body);
    if (loopBody === null) {
      failures.push(`${target.file} → ${target.fn} — could not find the per-board rebind \`for\` loop (moved/renamed?)`);
    } else {
      if (!/\bnormalizeVaultRelative\s*\(/.test(loopBody)) {
        failures.push(
          `${target.file} → ${target.fn} — the rebind loop never folds an entry ` +
            '(no normalizeVaultRelative() INSIDE the loop); a no-op call elsewhere no longer satisfies the gate',
        );
      }
      const folded = collectFoldedLocals(body);
      for (const line of loopCompareLinesLackingFold(loopBody, folded)) {
        failures.push(
          `${target.file} → ${target.fn} — loop compares an UN-folded path (no folded operand): ` +
            `\`${line}\` — fold both sides via normalizeVaultRelative before comparing`,
        );
      }
    }
  }
}

if (failures.length > 0) {
  console.error('[check-board-path-casefold] FAILED — board-path compare regressed to case-sensitive:');
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    '\nThe board external-edit lookup (findBoardIdForPath) and the rename key walk\n' +
      '(renameBoardPath) must compare vault-relative paths case-INSENSITIVELY\n' +
      '(Windows/macOS are case-preserving but not case-sensitive). Use `samePath` /\n' +
      '`normalizeVaultRelative`, never a raw `===` on `normalizePath`. A raw compare\n' +
      "silently ignores an externally edited/renamed `.board.json` whose OS casing\n" +
      'diverges from the stored casing (no reload; later evicted as "missing"). See\n' +
      'AUDIT12_REMEDIATION_PLAN_2026-06-06.md M4 + src/tests/unit/boardPathCaseFold.test.ts.',
  );
  process.exit(1);
}

console.log('[check-board-path-casefold] OK — findBoardIdForPath + renameBoardPath compare case-insensitively.');
process.exit(0);

/**
 * Reconciler vault-identity guard gate (Audit-6 Phase 5.3 — root-cause B).
 *
 * The external-edit reconcilers in `vaultExternalReconcilers.ts` capture the
 * active vault path, `await` a disk read, then mutate a store. A vault swap
 * interleaving on that await applies the OUTGOING vault's data to the NEW vault
 * (H3 tags → persisted cross-vault on disk; H4 board → injected into the cache;
 * L27 theme → outgoing theme re-applied). The discipline that closes the class:
 * `captureVaultIdentity()` before the await, `isStillSameVault(...)` after it,
 * bail before mutating. This is the same G1 guard the rename/cascade paths use.
 *
 * Five prior audits fixed instances of this class per-site; it kept recurring
 * because nothing ENFORCED the re-check. This gate converts the discipline into
 * an invariant: any function in `vaultExternalReconcilers.ts` that reads the
 * active vault path (`vaultStore.path`) or receives a captured root (a
 * `vaultRoot` parameter) AND contains an `await` MUST also reference
 * `isStillSameVault`. A future reconciler that forgets the guard fails CI.
 *
 * Functions that don't touch the vault path (e.g. the template reconciler — it
 * refreshes a list from the live active vault with no captured root) are not
 * flagged. A function whose only `await`s delegate to a peer that IS guarded
 * (e.g. `reconcileBoardJsonChange` → `reloadBoardFromDisk`) simply doesn't read
 * the vault path itself, so it naturally passes.
 *
 * Token checks run against a string/comment-blanked copy of the source, so a
 * comment that merely MENTIONS `isStillSameVault` can't satisfy the gate — only
 * a real call does.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const TARGET = 'src/renderer/stores/vaultExternalReconcilers.ts';

/**
 * Replaces every comment and string/template-literal body with spaces
 * (preserving newlines so line numbers stay meaningful). Token checks then see
 * only real code — a comment naming `isStillSameVault` no longer counts, and a
 * template literal's `${...}` / literal braces can't corrupt brace-matching.
 */
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
      out += c === '\t' ? '\t' : ' '; i += 1; continue;
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
    // template literal — blank everything (incl. ${...}) until the closing `
    if (c === '\\') { out += '  '; i += 2; continue; }
    if (c === '`') { state = 'code'; out += ' '; i += 1; continue; }
    out += c === '\n' ? '\n' : ' '; i += 1; continue;
  }
  return out;
}

/** Extracts each named (`function NAME(...) { ... }`) function from blanked code. */
function findFunctions(code) {
  const fns = [];
  const headerRe = /\b(?:async\s+)?function\s+(\w+)\s*\(/g;
  let m;
  while ((m = headerRe.exec(code))) {
    const name = m[1];
    // Match params: from the '(' just consumed, balance parens.
    let i = headerRe.lastIndex - 1;
    let depth = 0;
    const paramStart = i + 1;
    let paramEnd = -1;
    for (; i < code.length; i++) {
      if (code[i] === '(') depth++;
      else if (code[i] === ')') {
        depth--;
        if (depth === 0) { paramEnd = i; i++; break; }
      }
    }
    if (paramEnd < 0) continue;
    const params = code.slice(paramStart, paramEnd);
    // Skip the optional return-type annotation to the body's opening brace.
    while (i < code.length && code[i] !== '{') i++;
    if (i >= code.length) continue;
    const bodyStart = i;
    let bdepth = 0;
    let j = i;
    for (; j < code.length; j++) {
      if (code[j] === '{') bdepth++;
      else if (code[j] === '}') {
        bdepth--;
        if (bdepth === 0) { j++; break; }
      }
    }
    fns.push({ name, params, body: code.slice(bodyStart, j) });
  }
  return fns;
}

const file = join(ROOT, TARGET);
let raw;
try {
  raw = readFileSync(file, 'utf8');
} catch {
  console.error(`check-reconciler-vault-guard: cannot read ${TARGET}`);
  process.exit(1);
}

const code = blankStringsAndComments(raw);
const violations = [];

for (const fn of findFunctions(code)) {
  const readsVaultPath = /\bvaultStore\.path\b/.test(fn.body);
  const hasVaultRootParam = /\bvaultRoot\b/.test(fn.params);
  if (!readsVaultPath && !hasVaultRootParam) continue; // not vault-scoped
  if (!/\bawait\b/.test(fn.body)) continue; // nothing suspends → no swap window
  if (/\bisStillSameVault\b/.test(fn.body)) continue; // guarded — good
  violations.push(fn.name);
}

if (violations.length > 0) {
  console.error(
    `Unguarded vault-scoped reconciler(s) in ${TARGET}:`,
  );
  for (const v of violations) console.error(`  ${v}`);
  console.error('');
  console.error('Each reads the active vault path (or receives a vaultRoot) and then awaits,');
  console.error('but never re-checks vault identity. A vault swap during the await would apply');
  console.error('the outgoing vault\'s data to the new vault (H3 tags persist cross-vault on');
  console.error('disk; H4 board injected into the cache; L27 theme re-applied). Capture identity');
  console.error('before the await and bail after it before mutating:');
  console.error('');
  console.error('  const captured = captureVaultIdentity();');
  console.error('  const vaultRoot = vaultStore.path;');
  console.error('  const data = await <read>;');
  console.error('  if (!isStillSameVault(captured)) return;   // ← swap landed during the read');
  console.error('  <mutate store>');
  console.error('');
  console.error('Both helpers live in src/renderer/lib/vault/vaultIdentity.ts. If a function');
  console.error('only delegates to an already-guarded peer, read the vault path INSIDE that peer');
  console.error('so this function isn\'t itself vault-scoped.');
  process.exit(1);
}

console.log('check-reconciler-vault-guard: OK');

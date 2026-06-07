/**
 * Audit-12 S1 — `ci:copy-file-source-guard`.
 *
 * `vault:copy-file` used to copy ANY absolute path the renderer named into the
 * vault — only the DESTINATION was vault-contained. Under a hostile-vault threat
 * model that is an arbitrary host-file READ primitive (copy `~/.ssh/id_rsa` /
 * `/etc/passwd` into the vault, then exfiltrate). The fix:
 *   1. the handler validates the SOURCE via `isApprovedCopySource(...)` before it
 *      touches the path on disk (only in-vault files or ones the user picked via
 *      dialog / dropped are allowed), and
 *   2. `copyFileToVault` re-stats through the open fd (`.isFile()` — TOCTOU) and
 *      caps the BYTES STREAMED (`maxBytes` — defeats a `/dev/zero`-style device
 *      that under-reports `size` then never EOFs).
 *
 * This gate pins both enforcement points so a future edit can't quietly drop the
 * source check (leaving the dest-only check that looked "validated"). Token
 * checks run on a string/comment-blanked copy of ONLY the target function/handler
 * body, so a comment naming the helper can't satisfy the gate and an unrelated
 * token elsewhere in the file can't trip it.
 *
 * Audit-13 M11 — the approved-source registry is process-global, so it must be
 * cleared whenever the active vault changes or an approval picked under vault A
 * leaks into vault B. This gate adds a third target asserting the `vault:close`
 * AND `vault:watch` handlers each call `clearApprovedSources()` (the behavioral
 * proof is the swap-clear case in copyFileSourceGuard.test.ts).
 *
 * Bite-verify: remove the `isApprovedCopySource` call from the handler, the
 * `maxBytes`/`.isFile()` guards from `copyFileToVault`, or either
 * `clearApprovedSources()` swap-clear → this gate fails.
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

/** Brace-match a `{...}` body starting at index `start` of `code`. */
function matchBraces(code, start) {
  let depth = 0;
  for (let i = start; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') { depth--; if (depth === 0) return code.slice(start, i + 1); }
  }
  return null;
}

/** Extracts the body `{...}` of the first definition of named `fnName`. */
function extractNamedFnBody(code, fnName) {
  const re = new RegExp(`(?:function\\s+)?\\b${fnName}\\s*\\(`, 'g');
  let m;
  while ((m = re.exec(code))) {
    let i = re.lastIndex - 1;
    let depth = 0;
    for (; i < code.length; i++) {
      if (code[i] === '(') depth++;
      else if (code[i] === ')') { depth--; if (depth === 0) { i++; break; } }
    }
    while (i < code.length && code[i] !== '{' && code[i] !== ';') i++;
    if (code[i] !== '{') continue; // a call / forward-decl, not a definition
    return matchBraces(code, i);
  }
  return null;
}

/**
 * Extracts the arrow-handler body for `ipcMain.handle('<channel>', … => {…})`.
 * `blankStringsAndComments` preserves offsets, so the channel literal's index in
 * the raw source aligns with the blanked copy — we locate the literal in raw,
 * then brace-match the handler body in the blanked copy.
 */
function extractHandlerBody(raw, blanked, channel) {
  const idx = raw.indexOf(`'${channel}'`);
  if (idx < 0) return null;
  const arrow = blanked.indexOf('=>', idx);
  if (arrow < 0) return null;
  const brace = blanked.indexOf('{', arrow);
  if (brace < 0) return null;
  return matchBraces(blanked, brace);
}

const failures = [];

// ── Target 1: the vault:copy-file handler must validate the SOURCE. ──────────
{
  const file = 'src/main/ipc/vault.ipc.ts';
  let raw;
  try {
    raw = readFileSync(join(ROOT, file), 'utf8');
  } catch (err) {
    failures.push(`${file} — cannot read: ${err.message}`);
    raw = null;
  }
  if (raw !== null) {
    const body = extractHandlerBody(raw, blankStringsAndComments(raw), 'vault:copy-file');
    if (body === null) {
      failures.push(`${file} — could not locate the 'vault:copy-file' handler (moved/renamed?)`);
    } else if (!/\bisApprovedCopySource\s*\(/.test(body)) {
      failures.push(
        `${file} → vault:copy-file handler — missing isApprovedCopySource(...) — the SOURCE path is unvalidated (arbitrary host-file read)`,
      );
    }
  }
}

// ── Target 2: copyFileToVault must keep the TOCTOU re-stat + streamed byte cap.
{
  const file = 'src/main/vault/fileOps.ts';
  let raw;
  try {
    raw = readFileSync(join(ROOT, file), 'utf8');
  } catch (err) {
    failures.push(`${file} — cannot read: ${err.message}`);
    raw = null;
  }
  if (raw !== null) {
    const body = extractNamedFnBody(blankStringsAndComments(raw), 'copyFileToVault');
    if (body === null) {
      failures.push(`${file} — could not find function \`copyFileToVault\` (moved/renamed?)`);
    } else {
      if (!/\bmaxBytes\b/.test(body)) {
        failures.push(`${file} → copyFileToVault — missing \`maxBytes\` streamed-byte cap (TOCTOU /dev/zero defence)`);
      }
      if (!/\.isFile\s*\(/.test(body)) {
        failures.push(`${file} → copyFileToVault — missing fstat \`.isFile()\` re-check on the open fd (TOCTOU device-swap defence)`);
      }
    }
  }
}

// ── Target 3 (Audit-13 M11): the vault:close + vault:watch handlers must clear
//    the approved-source registry so an approval can't leak across a vault swap.
{
  const file = 'src/main/ipc/vault.ipc.ts';
  let raw;
  try {
    raw = readFileSync(join(ROOT, file), 'utf8');
  } catch (err) {
    failures.push(`${file} — cannot read: ${err.message}`);
    raw = null;
  }
  if (raw !== null) {
    const blanked = blankStringsAndComments(raw);
    for (const channel of ['vault:close', 'vault:watch']) {
      const body = extractHandlerBody(raw, blanked, channel);
      if (body === null) {
        failures.push(`${file} — could not locate the '${channel}' handler (moved/renamed?)`);
      } else if (!/\bclearApprovedSources\s*\(/.test(body)) {
        failures.push(
          `${file} → ${channel} handler — missing clearApprovedSources() — an approved copy source can leak across a vault swap (M11)`,
        );
      }
    }
  }
}

if (failures.length > 0) {
  console.error('[check-copy-file-source-guard] FAILED — vault:copy-file source protection regressed:');
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    '\nvault:copy-file must constrain WHICH file the renderer may name as the source\n' +
      '(isApprovedCopySource — only in-vault files or user-picked/dropped paths) AND\n' +
      'copyFileToVault must re-stat through the open fd + cap the bytes streamed. A\n' +
      'dest-only check leaves an arbitrary host-file READ primitive under a\n' +
      'hostile-vault threat model. See AUDIT12_REMEDIATION_PLAN_2026-06-06.md S1 +\n' +
      'src/main/services/approvedSources.ts + src/tests/unit/copyFileSourceGuard.test.ts.',
  );
  process.exit(1);
}

console.log('[check-copy-file-source-guard] OK — vault:copy-file validates the source + caps the copy.');
process.exit(0);

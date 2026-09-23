#!/usr/bin/env node
/**
 * ci:utf8-validated-read — Audit-19 ERR-7.
 *
 * `fs.readFile(p, 'utf-8')` silently replaces invalid byte sequences with
 * U+FFFD. A Windows-1252 note therefore reached the renderer as `R�union`, and
 * the first write of any kind (body save, field edit, vault-wide tag rename)
 * persisted the replacement characters — every accented byte destroyed.
 *
 * The fix reads a Buffer and validates it with `isUtf8`, records an invalid
 * file in main's non-UTF-8 registry, and the generic text write channels refuse
 * to overwrite a recorded path (`NOT_UTF8`). This gate pins it:
 *
 *  (a) `readFileWithCoherentStat` (src/main/vault/fileOps.ts) calls `isUtf8(`.
 *  (b) Neither `readFileWithCoherentStat` nor `readFileContents` decodes during
 *      the read (`readFile(…, 'utf-8' | 'utf8' | { encoding })`).
 *  (c) The `vault:write-file-text` and `vault:write-existing-file-text` handler
 *      segments in src/main/ipc/vault.ipc.ts call `isRegisteredNonUtf8(`.
 *
 * Comment-stripped (offset-preserving, strings kept) so a comment naming a
 * token can't satisfy the check. Function bodies are brace-matched on a copy
 * with strings blanked too; handler segments are split by `ipcMain.handle(`
 * marks (a handler body's regex / template literals can derail a brace match).
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const FILE_OPS = 'src/main/vault/fileOps.ts';
const VAULT_IPC = 'src/main/ipc/vault.ipc.ts';
const DECODING_READ_RE = /readFile\s*\([^)]*?,\s*(?:['"]utf-?8['"]|\{\s*encoding)/i;
const WRITE_CHANNELS = ['vault:write-file-text', 'vault:write-existing-file-text'];

function blank(src, { strings }) {
  const out = src.split('');
  const n = src.length;
  const fill = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? n : end;
      fill(i, stop);
      i = stop;
      continue;
    }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      fill(i, stop);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') j++;
        j++;
      }
      if (strings) fill(i + 1, j);
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join('');
}

function matchBrace(code, open) {
  let depth = 0;
  for (let k = open; k < code.length; k++) {
    if (code[k] === '{') depth++;
    else if (code[k] === '}') {
      depth--;
      if (depth === 0) return k;
    }
  }
  return -1;
}

/** Body of `function <fn>(…)` in the comment-stripped text, or null. */
function functionBody(raw, fn) {
  const code = blank(raw, { strings: true });
  const noComments = blank(raw, { strings: false });
  const decl = new RegExp(`\\bfunction\\s+${fn}\\s*[<(]`).exec(code);
  if (!decl) return null;
  let k = code.indexOf('(', decl.index);
  let depth = 0;
  for (; k < code.length; k++) {
    if (code[k] === '(') depth++;
    else if (code[k] === ')') {
      depth--;
      if (depth === 0) break;
    }
  }
  let bodyOpen = code.indexOf('{', k);
  while (bodyOpen >= 0) {
    const before = code.slice(0, bodyOpen).replace(/\s+$/, '').slice(-1);
    if (!'<:,|&('.includes(before)) break;
    bodyOpen = code.indexOf('{', matchBrace(code, bodyOpen) + 1);
  }
  const close = bodyOpen < 0 ? -1 : matchBrace(code, bodyOpen);
  if (bodyOpen < 0 || close < 0) return null;
  return noComments.slice(bodyOpen, close + 1);
}

const failures = [];

function load(file) {
  const abs = join(ROOT, file);
  if (!existsSync(abs)) {
    failures.push(`${file}: file is missing (update the gate if it moved)`);
    return null;
  }
  return readFileSync(abs, 'utf8');
}

const fileOps = load(FILE_OPS);
if (fileOps) {
  for (const fn of ['readFileWithCoherentStat', 'readFileContents']) {
    const body = functionBody(fileOps, fn);
    if (body === null) {
      failures.push(`${FILE_OPS}: function ${fn}() not found (update the gate if it was renamed)`);
      continue;
    }
    if (DECODING_READ_RE.test(body)) {
      failures.push(`${FILE_OPS}: ${fn}() decodes during the read — read a Buffer so invalid UTF-8 is detected, not silently replaced`);
    }
    if (fn === 'readFileWithCoherentStat' && !body.includes('isUtf8(')) {
      failures.push(`${FILE_OPS}: readFileWithCoherentStat() must validate the bytes with isUtf8(...)`);
    }
  }
}

const vaultIpc = load(VAULT_IPC);
if (vaultIpc) {
  const noComments = blank(vaultIpc, { strings: false });
  const marks = [...noComments.matchAll(/ipcMain\.handle\s*\(/g)].map((m) => m.index);
  for (const channel of WRITE_CHANNELS) {
    const idx = marks.findIndex((start) => {
      const head = noComments.slice(start, start + 200);
      return head.includes(`'${channel}'`) || head.includes(`"${channel}"`);
    });
    if (idx < 0) {
      failures.push(`${VAULT_IPC}: ${channel} handler not found (update the gate if it moved)`);
      continue;
    }
    const segment = noComments.slice(marks[idx], marks[idx + 1] ?? noComments.length);
    if (!segment.includes('isRegisteredNonUtf8(')) {
      failures.push(`${VAULT_IPC}: ${channel} must refuse a recorded non-UTF-8 path (isRegisteredNonUtf8(...))`);
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`\n[ci:utf8-validated-read] ${failures.length} violation(s):\n\n`);
  for (const f of failures) process.stderr.write(`  ${f}\n`);
  process.stderr.write('\nSee Audit-19 ERR-7: reads validate UTF-8; text writes refuse a non-UTF-8 file.\n');
  process.exit(1);
}

process.stdout.write('[ci:utf8-validated-read] OK — reads validate UTF-8 and both text write channels refuse non-UTF-8 files.\n');

#!/usr/bin/env node
/**
 * ci:failed-write-refire — Audit-19 EXT-5 / ERR-9 (plan D6).
 *
 * The write scheduler used to keep only failure IDS: the failed fire's args
 * getter was gone, `flushAll()` re-fired only `pending`, and the quit dialog's
 * "Stay open and retry" re-issued nothing. An edit whose write lost a
 * OneDrive / antivirus lock then existed only in memory (lost at exit).
 *
 * The fix RETAINS a transiently-failed fire's `getArgs` (writeSchedulerFailures
 * `RETAINABLE` codes) and re-fires it from every `flushAll()` (Ctrl+S, quit
 * drain, vault swap) and from Retry. This gate pins both halves:
 *
 *  (a) writeScheduler.ts: the brace-matched `flushAll` body calls
 *      `drainRetained(`, and `fireWrite`'s failure branch calls `ledger.retain(`.
 *  (b) writeSchedulerFailures.ts: `RETAINABLE` is defined and contains the lock
 *      codes, and does NOT contain a drift-defer / user-decision marker
 *      (`EXTERNAL_EDIT`, `DEFER`, `DEFERRED`, `CONFIG_CORRUPT`) — re-firing a
 *      write the user deferred would re-prompt during a quit drain.
 *
 * Comment-stripped; string contents preserved (the codes are string literals).
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SCHEDULER = 'src/renderer/lib/boards/writeScheduler.ts';
const FAILURES = 'src/renderer/lib/boards/writeSchedulerFailures.ts';
const REQUIRED_CODES = ['EPERM', 'EBUSY', 'EACCES'];
const FORBIDDEN_CODES = ['EXTERNAL_EDIT', 'DEFER', 'DEFERRED', 'CONFIG_CORRUPT'];

function stripComments(src) {
  let out = '';
  let state = 'code';
  let quote = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; i++; continue; }
      if (c === '/' && n === '*') { state = 'block'; i++; continue; }
      if (c === '"' || c === "'" || c === '`') { state = 'str'; quote = c; }
      out += c;
      continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c; }
      continue;
    }
    if (state === 'block') {
      if (c === '*' && n === '/') { state = 'code'; i++; }
      else if (c === '\n') out += c;
      continue;
    }
    out += c;
    if (c === '\\') { out += n ?? ''; i++; continue; }
    if (c === quote) state = 'code';
  }
  return out;
}

function functionBody(code, name) {
  const decl = new RegExp(`function\\s+${name}\\s*[<(]`).exec(code);
  if (!decl) return null;
  const open = code.indexOf('{', code.indexOf(')', decl.index));
  if (open < 0) return null;
  let depth = 0;
  for (let k = open; k < code.length; k++) {
    if (code[k] === '{') depth++;
    else if (code[k] === '}' && --depth === 0) return code.slice(open, k + 1);
  }
  return null;
}

const failures = [];
function read(rel) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) {
    failures.push(`${rel}: file is missing (update the gate if it moved)`);
    return null;
  }
  return stripComments(readFileSync(abs, 'utf8'));
}

const sched = read(SCHEDULER);
if (sched !== null) {
  const flushAll = functionBody(sched, 'flushAll');
  if (!flushAll) failures.push(`${SCHEDULER}: function flushAll() not found`);
  else if (!/\bdrainRetained\s*\(/.test(flushAll)) {
    failures.push(`${SCHEDULER}: flushAll() must call drainRetained( — retained failed writes are never re-fired`);
  }
  const fire = functionBody(sched, 'fireWrite');
  if (!fire) failures.push(`${SCHEDULER}: function fireWrite() not found`);
  else if (!/\bledger\.retain\s*\(/.test(fire)) {
    failures.push(`${SCHEDULER}: fireWrite() must retain a transient failure's getArgs (ledger.retain(...))`);
  }
}

const fails = read(FAILURES);
if (fails !== null) {
  const m = /export\s+const\s+RETAINABLE\b[^=]*=\s*new\s+Set\s*\(\s*\[([\s\S]*?)\]\s*\)/.exec(fails);
  if (!m) {
    failures.push(`${FAILURES}: \`export const RETAINABLE = new Set([...])\` not found`);
  } else {
    const codes = [...m[1].matchAll(/['"`]([A-Z_]+)['"`]/g)].map((x) => x[1]);
    for (const c of REQUIRED_CODES) {
      if (!codes.includes(c)) failures.push(`${FAILURES}: RETAINABLE is missing the lock code '${c}'`);
    }
    for (const c of FORBIDDEN_CODES) {
      if (codes.includes(c)) {
        failures.push(`${FAILURES}: RETAINABLE must not contain '${c}' — a user-deferred write would re-prompt during a quit drain`);
      }
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`\n[ci:failed-write-refire] ${failures.length} violation(s):\n\n`);
  for (const f of failures) process.stderr.write(`  ${f}\n`);
  process.stderr.write('\nSee Audit-19 EXT-5: transiently failed writes must be retained and re-fired by flushAll / Retry.\n');
  process.exit(1);
}
process.stdout.write('[ci:failed-write-refire] OK — flushAll re-fires retained writes; RETAINABLE excludes user-deferred failures.\n');

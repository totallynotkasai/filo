#!/usr/bin/env node
/**
 * ci:keep-local-backup — Audit-19 UX-6 (plan D7).
 *
 * Every "Keep local" overwrite replaces a file another device / editor changed.
 * Before UX-6 no path copied those external bytes anywhere, so resolving a
 * synced-vault conflict in Filo's favour destroyed the other machine's edit.
 * The fix snapshots the external version to `.filo/recovery/` via
 * `backupExternalVersion(...)` (lib/vault/keepLocalBackup.ts) before the write.
 *
 * This gate pins it structurally:
 *
 *  (a) Every toast action object in src/renderer whose `label` is
 *      'Keep local' / 'Keep all' / 'Keep your edits' must call
 *      `backupExternalVersion(` inside the (brace-matched) action object — or
 *      carry `// allow-keep-local-no-backup: <reason>` inside it (e.g. a
 *      promise-backed prompt that only RESOLVES 'keep-local' to a writer that
 *      backs up itself).
 *  (b) The three keep-local WRITE chokepoints — the markdown pre-write drift
 *      gate, the board writer and boardCache's tile-sync — must each call
 *      `backupExternalVersion(` inside the named function.
 *
 * Comment-stripped (offset-preserving) for the token checks; the escape is read
 * from the raw text of the action object. A `MIN_SITES` tripwire fails loud if
 * the label collector goes stale.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SCAN_DIR = join(ROOT, 'src', 'renderer');
const LABEL_RE = /label\s*:\s*(['"`])(Keep local|Keep all|Keep your edits)\1/g;
const TOKEN = 'backupExternalVersion(';
const ESCAPE = 'allow-keep-local-no-backup:';
const MIN_SITES = 9;

const CHOKEPOINTS = [
  { file: 'src/renderer/lib/vault/preWriteDriftGate.ts', fn: 'runPreWriteDriftGate' },
  { file: 'src/renderer/lib/boards/boardWriteScheduler.ts', fn: 'writeBoardFile' },
  { file: 'src/renderer/stores/boardCache.svelte.ts', fn: 'syncTileMarkdown' },
];

/**
 * Offset-preserving blanker. `strings: false` keeps string contents (so labels
 * stay visible); `strings: true` blanks them too (for brace matching).
 */
function blank(src, { strings }) {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  const fill = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
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

/** Index of the `}` matching the `{` at `open` (in a fully blanked copy). */
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

/** Index of the nearest unmatched `{` before `pos`. */
function enclosingOpen(code, pos) {
  let depth = 0;
  for (let k = pos - 1; k >= 0; k--) {
    if (code[k] === '}') depth++;
    else if (code[k] === '{') {
      if (depth === 0) return k;
      depth--;
    }
  }
  return -1;
}

function walk(dir, acc) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, acc);
    else if (/\.(ts|svelte)$/.test(name)) acc.push(abs);
  }
  return acc;
}

const failures = [];
let sites = 0;

for (const abs of walk(SCAN_DIR, [])) {
  const raw = readFileSync(abs, 'utf8');
  if (!/Keep (local|all|your edits)/.test(raw)) continue;
  const noComments = blank(raw, { strings: false });
  const code = blank(raw, { strings: true });
  const rel = relative(ROOT, abs).replace(/\\/g, '/');
  for (const m of noComments.matchAll(LABEL_RE)) {
    sites++;
    const open = enclosingOpen(code, m.index);
    const close = open < 0 ? -1 : matchBrace(code, open);
    if (open < 0 || close < 0) {
      failures.push(`${rel}: could not brace-match the '${m[2]}' action object`);
      continue;
    }
    const line = raw.slice(0, m.index).split('\n').length;
    if (noComments.slice(open, close).includes(TOKEN)) continue;
    if (raw.slice(open, close).includes(ESCAPE)) continue;
    failures.push(`${rel}:${line}: '${m[2]}' action overwrites without calling backupExternalVersion(...)`);
  }
}

for (const { file, fn } of CHOKEPOINTS) {
  const abs = join(ROOT, file);
  if (!existsSync(abs)) {
    failures.push(`${file}: listed chokepoint file is missing (update the gate if it moved)`);
    continue;
  }
  const raw = readFileSync(abs, 'utf8');
  const code = blank(raw, { strings: true });
  const noComments = blank(raw, { strings: false });
  const decl = new RegExp(`\\bfunction\\s+${fn}\\s*\\(`).exec(code);
  if (!decl) {
    failures.push(`${file}: function ${fn}() not found (update the gate if it was renamed)`);
    continue;
  }
  // Skip the parameter list (it may contain `{}` types) — find the body brace
  // after the matching `)`.
  let depth = 0;
  let k = decl.index + decl[0].length - 1;
  for (; k < code.length; k++) {
    if (code[k] === '(') depth++;
    else if (code[k] === ')') { depth--; if (depth === 0) break; }
  }
  // A return-type annotation can itself contain braces (`Promise<{ ... }>`):
  // the body brace is the first `{` NOT opening a type literal (a type
  // literal's `{` follows `<`, `:`, `,`, `|`, `&` or `(`).
  let bodyOpen = code.indexOf('{', k);
  while (bodyOpen >= 0) {
    const before = code.slice(0, bodyOpen).replace(/\s+$/, '').slice(-1);
    if (!'<:,|&('.includes(before)) break;
    bodyOpen = code.indexOf('{', matchBrace(code, bodyOpen) + 1);
  }
  const close = bodyOpen < 0 ? -1 : matchBrace(code, bodyOpen);
  if (bodyOpen < 0 || close < 0 || !noComments.slice(bodyOpen, close).includes(TOKEN)) {
    failures.push(`${file}: ${fn}() keep-local branch must call backupExternalVersion(...) before overwriting`);
  }
}

if (sites < MIN_SITES) {
  failures.push(`tripwire: found only ${sites} Keep-local action site(s), expected >= ${MIN_SITES} — the label collector is stale`);
}

if (failures.length > 0) {
  process.stderr.write(`\n[ci:keep-local-backup] ${failures.length} violation(s):\n\n`);
  for (const f of failures) process.stderr.write(`  ${f}\n`);
  process.stderr.write('\nSee Audit-19 UX-6: every Keep-local overwrite must back up the external version to .filo/recovery/ first.\n');
  process.exit(1);
}

process.stdout.write(`[ci:keep-local-backup] OK — ${sites} Keep-local action(s) + ${CHOKEPOINTS.length} write chokepoints back up first.\n`);

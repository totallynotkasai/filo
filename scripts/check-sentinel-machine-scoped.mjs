#!/usr/bin/env node
/**
 * ci:sentinel-machine-scoped — Audit-19 EXT-6 / ERR-8 (plan D5).
 *
 * The crash-recovery sentinels live in the vault's `.filo/`, which syncs to
 * every machine. With one shared name per kind, machine B's clean shutdown
 * deleted machine A's crash breadcrumb, B prompted for A's unflushed files and
 * could "resume" A's half-finished tag rename. Each machine now owns
 * `<name>.<machineId>`, built ONLY by `machineSentinelPath(...)` in
 * `src/shared/sentinelPaths.ts`, which is also the single home of the legacy
 * bare names (read + consumed once for migration, never written).
 *
 * This gate forbids the four legacy literals anywhere in src/main or
 * src/renderer (comment-stripped, strings kept — the literal IS the violation),
 * so the per-machine builder is the only way to name a sentinel. A
 * `MIN_SCANNED` tripwire fails loud if the walker goes stale.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SCAN_DIRS = ['src/main', 'src/renderer'];
const FORBIDDEN = [
  '.filo/.dirty',
  '.filo/rename-cascade-pending.json',
  '.filo/tag-rewrite-pending.json',
  '.filo/quit-failure.json',
];
const MIN_SCANNED = 150;

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

function walk(dir, acc) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, acc);
    else if (/\.(ts|svelte|mjs)$/.test(name)) acc.push(abs);
  }
  return acc;
}

const files = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d), []));
const failures = [];
for (const abs of files) {
  const code = stripComments(readFileSync(abs, 'utf8'));
  const lines = code.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const lit of FORBIDDEN) {
      // Real string literals only (a backtick-quoted mention inside prose is fine).
      for (const q of ["'", '"']) {
        if (lines[i].includes(`${q}${lit}${q}`)) {
          failures.push(`${relative(ROOT, abs).replace(/\\/g, '/')}:${i + 1}: legacy shared sentinel literal ${q}${lit}${q}`);
        }
      }
    }
  }
}
if (files.length < MIN_SCANNED) {
  failures.push(`tripwire: scanned only ${files.length} files (expected >= ${MIN_SCANNED}) — the walker is stale`);
}

if (failures.length > 0) {
  process.stderr.write(`\n[ci:sentinel-machine-scoped] ${failures.length} violation(s):\n\n`);
  for (const f of failures) process.stderr.write(`  ${f}\n`);
  process.stderr.write(
    '\nCrash-recovery sentinels are per machine (Audit-19 EXT-6): name them with\n' +
      'machineSentinelPath(kind, machineId) / ownSentinelPath(kind); the legacy shared names\n' +
      'live only in LEGACY_SENTINEL_PATHS (src/shared/sentinelPaths.ts).\n',
  );
  process.exit(1);
}
process.stdout.write(`[ci:sentinel-machine-scoped] OK — ${files.length} files scanned; no legacy shared sentinel literal.\n`);

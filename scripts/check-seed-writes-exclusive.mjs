#!/usr/bin/env node
/**
 * ci:seed-writes-exclusive — Audit-19 BL-1.
 *
 * New Kanban cards, new tasks, Task-List OS drops and Mind Map text tiles used
 * to seed their backing `.md` with `vault:write-file-text` (create-OR-OVERWRITE),
 * guarded only by a pre-pick that knew nothing about files on disk. A new card
 * titled "Notes" silently overwrote an existing off-board `Notes.md`.
 *
 * The fix routes every seed through `lib/vault/createMdExclusive.ts`, which
 * calls the O_EXCL `vault:create-file-text` channel and bumps to ` (n)` on
 * EEXIST. This gate pins both halves:
 *
 *  (a) Each CREATION module contains NO `invoke(Ok)?('vault:write-file-text'`
 *      call and references the helper (`createUniqueMdFile` or the single-attempt
 *      `createMdFileExclusive`).
 *  (b) The helper calls `'vault:create-file-text'` and NEVER `trackComponentWrite(`
 *      — a losing EEXIST attempt targets the user's EXISTING file, and
 *      `trackComponentWrite` would erase that path's pending/failed marks and
 *      hide its next external change.
 *
 * Comment-stripped (strings preserved — the channel literal must be visible).
 * A listed file that goes missing fails loudly.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

const CREATION_MODULES = [
  'src/renderer/lib/kanban/kanbanTileCreation.ts',
  'src/renderer/lib/tasklist/taskCreation.ts',
  'src/renderer/lib/tasklist/fileDropHandler.ts',
  'src/renderer/lib/boards/seedTextFileForNewTile.ts',
];
const HELPER = 'src/renderer/lib/vault/createMdExclusive.ts';

// Same matcher shape as check-markdown-write-gateway.mjs (real call sites only).
const OVERWRITE_WRITE_RE = /\binvoke(?:Ok)?\s*\(\s*['"`]vault:write-file-text['"`]/;
const HELPER_REF_RE = /\b(?:createUniqueMdFile|createMdFileExclusive)\s*\(/;

/** Strip // and /* *\/ comments; keep string contents. */
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
    // str
    out += c;
    if (c === '\\') { out += n ?? ''; i++; continue; }
    if (c === quote) state = 'code';
  }
  return out;
}

const failures = [];

function read(rel) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) {
    failures.push(`${rel}: listed file is missing (update the gate if it moved)`);
    return null;
  }
  return stripComments(readFileSync(abs, 'utf8'));
}

for (const rel of CREATION_MODULES) {
  const src = read(rel);
  if (src === null) continue;
  if (OVERWRITE_WRITE_RE.test(src)) {
    failures.push(`${rel}: seeds via the overwrite-capable 'vault:write-file-text' — use createUniqueMdFile / createMdFileExclusive`);
  }
  if (!HELPER_REF_RE.test(src)) {
    failures.push(`${rel}: does not call createUniqueMdFile(...) / createMdFileExclusive(...)`);
  }
}

const helper = read(HELPER);
if (helper !== null) {
  if (!/['"`]vault:create-file-text['"`]/.test(helper)) {
    failures.push(`${HELPER}: must invoke the create-exclusive 'vault:create-file-text' channel`);
  }
  if (/\btrackComponentWrite\s*\(/.test(helper)) {
    failures.push(`${HELPER}: must not use trackComponentWrite( — a losing EEXIST attempt would clear the existing file's pending/failed marks`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`\n[ci:seed-writes-exclusive] ${failures.length} violation(s):\n\n`);
  for (const f of failures) process.stderr.write(`  ${f}\n`);
  process.stderr.write('\nSee Audit-19 BL-1: new-file seeds must be create-exclusive (never overwrite an existing vault file).\n');
  process.exit(1);
}

process.stdout.write(`[ci:seed-writes-exclusive] OK — ${CREATION_MODULES.length} creation modules seed create-exclusively.\n`);

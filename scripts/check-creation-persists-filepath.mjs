/**
 * Audit-12 H1 — `ci:creation-persists-filepath`.
 *
 * H1's root cause: `AddTaskCommand`'s ctor DEEP-CLONES the def
 * (`this.def = this.snapshot(def)`) and `execute()` persists that clone. Task
 * creation stamped `def.filePath = relPath` in `seedMdFile` — AFTER the clone had
 * already entered the cache — so the cached def + the persisted `.board.json` row
 * carried NO `filePath`. On a cold load (boards don't preload docs → documentStore
 * empty) a subfolder task's field/tag write then fell through the per-board folder
 * cascade / vault root and hit the WRONG file. Kanban + Mind Map already bake
 * `filePath` into the def BEFORE constructing the command — Task List was the lone
 * broken sibling.
 *
 * This gate makes "the creation path stamps `filePath` onto the def before the
 * command/persist clones it" STRUCTURAL across the three text-tile creation paths,
 * so the next sibling can't silently regress:
 *
 *   - `taskCreation.ts` → `buildTaskDef`: must assign `filePath` inside the
 *     builder (which returns the def the callers hand to `new AddTaskCommand(`).
 *   - `kanbanTileCreation.ts` → `createTile`: must assign `filePath` BEFORE the
 *     `new AddCardCommand(` construction.
 *   - `seedTextFileForNewTile.ts` → `stampTextTileSeedPath`: must assign
 *     `filePath` (the per-type tile op reads `tile.filePath` off the tile after
 *     this stamps it, before persisting the def).
 *
 * Function-scoped (not file-scoped): the assignment must live inside the named
 * builder, so moving it back out (e.g. into `seedMdFile`, which is DEFINED EARLIER
 * in the file than `buildTaskDef` — a file-position check would miss that) trips
 * the gate. Token checks run against a string/comment-blanked copy so a doc-comment
 * mentioning `filePath =` can't satisfy the gate.
 *
 * Bite-verify: move a stamp out of its builder (or after the command) → exit 1.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

/**
 * Replaces every comment and string/template-literal body with spaces (preserving
 * newlines + offsets). Token checks then see only real code — a comment naming
 * `filePath =` no longer counts, and a template literal's braces can't corrupt
 * brace-matching. Copied from check-reconciler-vault-guard.mjs.
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

/**
 * Extracts a top-level `function NAME(...) { ... }` body (with braces) from
 * blanked code, or `null` if not found. Handles a bare object return-type
 * annotation (`): { def: ... } {`) by brace-matching the return type before
 * locating the body brace — none of the targeted builders use a `Promise<{...}>`
 * generic return type, where "advance to the first brace" would mis-fire.
 */
function extractFnBody(code, name) {
  const headerRe = new RegExp(`\\bfunction\\s+${name}\\s*\\(`, 'g');
  const m = headerRe.exec(code);
  if (!m) return null;

  // Balance the params from the '(' the header just consumed.
  let i = headerRe.lastIndex - 1;
  let depth = 0;
  let paramEnd = -1;
  for (; i < code.length; i++) {
    if (code[i] === '(') depth++;
    else if (code[i] === ')') { depth--; if (depth === 0) { paramEnd = i; i++; break; } }
  }
  if (paramEnd < 0) return null;

  // Skip whitespace, then an optional return-type annotation.
  let k = i;
  while (k < code.length && /\s/.test(code[k])) k++;
  if (code[k] === ':') {
    k++;
    while (k < code.length && /\s/.test(code[k])) k++;
    if (code[k] === '{') {
      // Bare object return type — brace-match and skip it.
      let d = 0;
      for (; k < code.length; k++) {
        if (code[k] === '{') d++;
        else if (code[k] === '}') { d--; if (d === 0) { k++; break; } }
      }
    } else {
      // Primitive / union / non-object-generic return type — advance to the body.
      while (k < code.length && code[k] !== '{') k++;
    }
    while (k < code.length && /\s/.test(code[k])) k++;
  }
  if (code[k] !== '{') return null;

  // Brace-match the body.
  const bodyStart = k;
  let d = 0;
  for (; k < code.length; k++) {
    if (code[k] === '{') d++;
    else if (code[k] === '}') { d--; if (d === 0) { k++; break; } }
  }
  return code.slice(bodyStart, k);
}

// `.filePath = ` / `filePath = ` (assignment), but not `==` / `===` (compare).
const ASSIGN_RE = /\bfilePath\s*=(?!=)/;

const SITES = [
  {
    file: 'src/renderer/lib/tasklist/taskCreation.ts',
    fn: 'buildTaskDef',
    before: null,
    note: 'AddTaskCommand deep-clones the def in its ctor, so filePath must be on the def BEFORE buildTaskDef returns it (it used to be stamped in seedMdFile, after the clone).',
  },
  {
    file: 'src/renderer/lib/kanban/kanbanTileCreation.ts',
    fn: 'createTile',
    before: 'new AddCardCommand(',
    note: 'AddCardCommand deep-clones the def, so filePath must be baked in before the command is constructed.',
  },
  {
    file: 'src/renderer/lib/boards/seedTextFileForNewTile.ts',
    fn: 'stampTextTileSeedPath',
    before: null,
    note: 'the per-type tile op reads tile.filePath off the tile after this stamps it, before persisting the def.',
  },
];

const failures = [];
for (const site of SITES) {
  let raw;
  try {
    raw = readFileSync(join(ROOT, site.file), 'utf8');
  } catch (err) {
    failures.push(`${site.file} — could not read: ${err.message}`);
    continue;
  }
  const body = extractFnBody(blankStringsAndComments(raw), site.fn);
  if (body === null) {
    failures.push(`${site.file} — could not find function \`${site.fn}\` (gate target moved/renamed? update SITES).`);
    continue;
  }
  const assign = ASSIGN_RE.exec(body);
  if (!assign) {
    failures.push(`${site.file} → ${site.fn} — no \`filePath =\` assignment. ${site.note}`);
    continue;
  }
  if (site.before) {
    const beforeIdx = body.indexOf(site.before);
    if (beforeIdx < 0) {
      failures.push(`${site.file} → ${site.fn} — expected marker \`${site.before}\` not found (gate target moved? update SITES).`);
      continue;
    }
    if (assign.index > beforeIdx) {
      failures.push(
        `${site.file} → ${site.fn} — filePath assigned AFTER \`${site.before}\`. ${site.note}`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error('[check-creation-persists-filepath] FAILED — Audit-12 H1 invariant regressed:');
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    '\nEach text-tile CREATION path must stamp `filePath` onto the def BEFORE the\n' +
      'Add*Command / persist clones it — otherwise the persisted .board.json row\n' +
      'carries no filePath and a cold-load subfolder field/tag edit resolves to the\n' +
      'wrong file. See AUDIT12_REMEDIATION_PLAN_2026-06-06.md H1.',
  );
  process.exit(1);
}

console.log(
  `[check-creation-persists-filepath] OK — ${SITES.length} text-tile creation path(s) ` +
    'bake filePath into the def before command construction.',
);
process.exit(0);

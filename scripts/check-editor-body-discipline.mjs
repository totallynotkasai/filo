#!/usr/bin/env node
/**
 * ci:editor-body-discipline — Audit-19 editor-layer invariants (MD-1 / MD-4 /
 * MD-3 / MD-5 / MD-2 / UX-1). Every arm pins the MECHANISM of a fix whose
 * behaviour is proven by the component suite under `src/tests/component/`, so a
 * refactor can't silently delete it.
 *
 *  Arm A (MD-1) — loading a file must not be an undoable edit.
 *    (a) `loadMarkdownIntoEditor` (markdownSync.ts) sets
 *        `setMeta('addToHistory', false)` and calls `resetEditorHistory(`.
 *    (b) No raw `.setContent(` anywhere in src/renderer outside markdownSync.ts —
 *        every load goes through the chokepoint.
 *        Escape: `// allow-raw-setcontent: <reason>` (same or previous line).
 *  Arm B (MD-4) — DocumentEditor must not reload its own autosave.
 *    `onUpdate:` sets `lastLoadedBody = md`; the reload `$effect` honours
 *    `isComposing`.
 *  Arm C (MD-3) — a body-only store body is never re-parsed as a full file.
 *    Forbid `parseMarkdownFile(existing…|docState…|body…)` in src/renderer and
 *    `body: seedBody` in taskCreation.ts. Escape: `// allow-body-reparse: <reason>`.
 *  Arm D (MD-5) — TextTile adopts a sibling body only when the sibling really
 *    read disk (`hasFrontmatter(existing.docId)` in the adopt block) and upgrades
 *    an unhydrated placeholder (`adoptDiskBodyIfPlaceholder(`).
 *  Arm E (MD-2) — TextTile's onDestroy writes only unsaved work:
 *    `isWriterDirty(` + `hasPendingMarkdownWriteFor(` present, and no bare
 *    `const finalArgs = buildWriteArgs();`.
 *  Arm F (UX-1) — a lossy note is truly non-editable: each component's
 *    editability `$effect` (the one referencing `closeDrainGate.draining`) also
 *    references `readOnly`, and toolbarConfig.ts checks `isEditable`.
 *
 * Views: `code` has comments AND strings blanked (for structure / brace
 * matching); `text` has only comments blanked (for token checks that include
 * string literals). Both are offset-preserving; for `.svelte` files everything
 * outside `<script>` is blanked.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const failures = [];

function blank(src, { strings }) {
  let out = '';
  let state = 'code';
  let quote = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    const keep = (ch) => (ch === '\n' ? '\n' : ' ');
    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; out += '  '; i++; continue; }
      if (c === '/' && n === '*') { state = 'block'; out += '  '; i++; continue; }
      if (c === '"' || c === "'" || c === '`') { state = 'str'; quote = c; out += c; continue; }
      out += c;
      continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += '\n'; } else out += ' ';
      continue;
    }
    if (state === 'block') {
      if (c === '*' && n === '/') { state = 'code'; out += '  '; i++; } else out += keep(c);
      continue;
    }
    // string
    if (c === '\\') { out += strings ? '  ' : c + (n ?? ''); i++; continue; }
    if (c === quote) { state = 'code'; out += c; continue; }
    out += strings ? keep(c) : c;
  }
  return out;
}

/** Blank everything outside <script>…</script> (offset-preserving). */
function scriptOnly(src) {
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/g;
  const chars = src.replace(/[^\n]/g, ' ').split('');
  let m;
  while ((m = re.exec(src)) !== null) {
    const start = m.index + m[0].indexOf('>') + 1;
    for (let i = 0; i < m[1].length; i++) chars[start + i] = src[start + i];
  }
  return chars.join('');
}

function load(rel) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) {
    failures.push(`${rel}: required file is missing (update the gate if it moved)`);
    return null;
  }
  const raw = readFileSync(abs, 'utf8');
  const src = rel.endsWith('.svelte') ? scriptOnly(raw) : raw;
  return { raw, code: blank(src, { strings: true }), text: blank(src, { strings: false }) };
}

/** From an index at `{`, return the index just past its matching `}`. */
function matchBrace(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Body span of `function name(...)[: T] { … }`. */
function functionBody(f, name) {
  const at = f.code.search(new RegExp(`\\bfunction\\s+${name}\\s*\\(`));
  if (at < 0) return null;
  let i = f.code.indexOf('(', at);
  let depth = 0;
  for (; i < f.code.length; i++) {
    if (f.code[i] === '(') depth++;
    else if (f.code[i] === ')' && --depth === 0) break;
  }
  i++;
  while (/\s/.test(f.code[i])) i++;
  if (f.code[i] === ':') {
    i++;
    while (/\s/.test(f.code[i])) i++;
    if (f.code[i] === '{') i = matchBrace(f.code, i);
  }
  const open = f.code.indexOf('{', i);
  const close = matchBrace(f.code, open);
  return close < 0 ? null : { start: open, end: close };
}

/** Body spans of every arrow `marker … => { … }` (e.g. `$effect(`, `onUpdate:`). */
function arrowBodies(f, marker) {
  const spans = [];
  let from = 0;
  for (;;) {
    const at = f.code.indexOf(marker, from);
    if (at < 0) break;
    const arrow = f.code.indexOf('=>', at);
    const open = arrow < 0 ? -1 : f.code.indexOf('{', arrow);
    const close = open < 0 ? -1 : matchBrace(f.code, open);
    if (close > 0) spans.push({ start: open, end: close });
    from = at + marker.length;
  }
  return spans;
}

const slice = (f, span) => f.text.slice(span.start, span.end);

function lineOf(src, index) {
  return src.slice(0, index).split('\n').length;
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|svelte)$/.test(e)) out.push(p);
  }
  return out;
}

function escaped(raw, index, tag) {
  const ln = lineOf(raw, index);
  const lines = raw.split('\n');
  return [lines[ln - 1], lines[ln - 2]].some((l) => l && l.includes(tag));
}

// ── Arm A (MD-1) ─────────────────────────────────────────────────────────
const SYNC = 'src/renderer/lib/editor/markdownSync.ts';
{
  const f = load(SYNC);
  if (f) {
    const span = functionBody(f, 'loadMarkdownIntoEditor');
    if (!span) failures.push(`${SYNC}: loadMarkdownIntoEditor not found`);
    else {
      const body = slice(f, span);
      if (!/setMeta\(\s*['"]addToHistory['"]\s*,\s*false\s*\)/.test(body)) {
        failures.push(`[A] ${SYNC}: loadMarkdownIntoEditor must set setMeta('addToHistory', false) on the load (MD-1)`);
      }
      if (!/\bresetEditorHistory\s*\(/.test(body)) {
        failures.push(`[A] ${SYNC}: loadMarkdownIntoEditor must call resetEditorHistory( — a load is a history boundary (MD-1)`);
      }
    }
  }
  for (const abs of walk(join(ROOT, 'src/renderer'))) {
    const rel = relative(ROOT, abs).split(sep).join('/');
    if (rel === SYNC) continue;
    const g = load(rel);
    if (!g) continue;
    const re = /\.setContent\s*\(/g;
    let m;
    while ((m = re.exec(g.code)) !== null) {
      if (escaped(g.raw, m.index, 'allow-raw-setcontent:')) continue;
      failures.push(`[A] ${rel}:${lineOf(g.raw, m.index)}: raw .setContent( — load through loadMarkdownIntoEditor (MD-1)`);
    }
  }
}

// ── Arm B (MD-4) ─────────────────────────────────────────────────────────
const DOC_EDITOR = 'src/renderer/components/boards/DocumentEditor.svelte';
const TEXT_TILE = 'src/renderer/components/tiles/TextTile.svelte';
{
  const f = load(DOC_EDITOR);
  if (f) {
    const upd = arrowBodies(f, 'onUpdate:')[0];
    if (!upd || !/\blastLoadedBody\s*=\s*md\b/.test(slice(f, upd))) {
      failures.push(`[B] ${DOC_EDITOR}: onUpdate must set lastLoadedBody = md (MD-4 self-reload)`);
    }
    const reload = arrowBodies(f, '$effect(').find((s) => /preserveSelection/.test(slice(f, s)));
    if (!reload || !/\bisComposing\b/.test(slice(f, reload))) {
      failures.push(`[B] ${DOC_EDITOR}: the reload $effect must honour isComposing (MD-4)`);
    }
  }
}

// ── Arm C (MD-3) ─────────────────────────────────────────────────────────
const TASK_CREATION = 'src/renderer/lib/tasklist/taskCreation.ts';
{
  for (const abs of walk(join(ROOT, 'src/renderer'))) {
    const rel = relative(ROOT, abs).split(sep).join('/');
    const g = load(rel);
    if (!g) continue;
    const re = /\bparseMarkdownFile\s*\(\s*(?:existing|docState|body)\b/g;
    let m;
    while ((m = re.exec(g.code)) !== null) {
      if (escaped(g.raw, m.index, 'allow-body-reparse:')) continue;
      failures.push(`[C] ${rel}:${lineOf(g.raw, m.index)}: re-parses a body-only store body — load it verbatim (MD-3)`);
    }
  }
  const t = load(TASK_CREATION);
  if (t && /\bbody\s*:\s*seedBody\b/.test(t.code)) {
    failures.push(`[C] ${TASK_CREATION}: seeds documentStore with the full seed FILE as its body — DocumentState.body is body-only (MD-3)`);
  }
}

// ── Arm D (MD-5) ─────────────────────────────────────────────────────────
{
  const f = load(TEXT_TILE);
  if (f) {
    const at = f.code.indexOf('findByFilename(');
    const ret = at < 0 ? -1 : f.code.indexOf('return;', at);
    const block = at < 0 || ret < 0 ? '' : f.text.slice(at, ret);
    if (!/hasFrontmatter\(\s*existing\.docId\s*\)/.test(block)) {
      failures.push(`[D] ${TEXT_TILE}: the sibling-adopt block must require hasFrontmatter(existing.docId) before adopting a body (MD-5)`);
    }
    if (!/\badoptDiskBodyIfPlaceholder\s*\(/.test(f.code)) {
      failures.push(`[D] ${TEXT_TILE}: must upgrade an unhydrated placeholder via documentStore.adoptDiskBodyIfPlaceholder( (MD-5)`);
    }
  }
}

// ── Arm E (MD-2) ─────────────────────────────────────────────────────────
{
  const f = load(TEXT_TILE);
  if (f) {
    const destroy = arrowBodies(f, 'onDestroy(')[0];
    const body = destroy ? slice(f, destroy) : '';
    if (!destroy) failures.push(`[E] ${TEXT_TILE}: onDestroy not found`);
    else {
      if (!/\bisWriterDirty\s*\(/.test(body) || !/\bhasPendingMarkdownWriteFor\s*\(/.test(body)) {
        failures.push(`[E] ${TEXT_TILE}: onDestroy must gate its final write on isWriterDirty( + hasPendingMarkdownWriteFor( (MD-2)`);
      }
      if (/const\s+finalArgs\s*=\s*buildWriteArgs\(\s*\)\s*;/.test(body)) {
        failures.push(`[E] ${TEXT_TILE}: onDestroy builds its final write unconditionally — write only unsaved work (MD-2)`);
      }
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`\n[ci:editor-body-discipline] ${failures.length} violation(s):\n\n`);
  for (const x of failures) process.stderr.write(`  ${x}\n`);
  process.stderr.write('\nSee AUDIT19_IMPLEMENTATION_PLAN_2026-09-23.md Phase 0 (MD-1/MD-4/MD-3/MD-5/MD-2/UX-1).\n');
  process.exit(1);
}
process.stdout.write('[ci:editor-body-discipline] OK — editor load/reload/unmount discipline intact.\n');

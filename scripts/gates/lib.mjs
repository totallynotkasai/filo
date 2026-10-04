// Shared helpers for the CI gates in scripts/gates/*.mjs.
//
// Every gate is a static scan of the repo source. The helpers here cover what
// the gates have in common: a cached file walker/reader, several comment
// strippers (they differ on purpose — see each one), brace-matched body
// extraction, line mapping and escape-marker lookups.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const toPosix = (p) => p.split(sep).join('/');

/** Violation record. `line` is 1-based or omitted. */
export function fail(file, line, message) {
  return { file, line, message };
}

// ── File access (cached across checks) ────────────────────────────────────

export function createContext(root = process.cwd()) {
  const texts = new Map();
  const walks = new Map();

  function read(rel) {
    if (!texts.has(rel)) {
      const abs = join(root, rel);
      texts.set(rel, existsSync(abs) && statSync(abs).isFile() ? readFileSync(abs, 'utf8') : null);
    }
    return texts.get(rel);
  }

  /** Every file under `dir` (recursive), repo-relative posix paths, sorted. */
  function walk(dir) {
    if (!walks.has(dir)) {
      const out = [];
      const abs = join(root, dir);
      if (!existsSync(abs)) throw new Error(`scan root missing: ${dir}`);
      const rec = (d) => {
        for (const entry of readdirSync(d)) {
          if (entry === 'node_modules' || entry === '.git') continue;
          const full = join(d, entry);
          const s = statSync(full);
          if (s.isDirectory()) rec(full);
          else if (s.isFile()) out.push(toPosix(relative(root, full)));
        }
      };
      rec(abs);
      out.sort();
      walks.set(dir, out);
    }
    return walks.get(dir);
  }

  /**
   * Files under `dirs` whose name ends with one of `ext`, optionally filtered by
   * a basename regex. `recursive: false` lists only the directory itself.
   */
  function files(dirs, { ext, name, recursive = true } = {}) {
    const out = [];
    for (const dir of [].concat(dirs)) {
      for (const rel of walk(dir)) {
        const rest = rel.slice(dir.length + 1);
        if (!recursive && rest.includes('/')) continue;
        const base = rest.slice(rest.lastIndexOf('/') + 1);
        if (ext && !ext.some((e) => base.endsWith(e))) continue;
        if (name && !name.test(base)) continue;
        out.push(rel);
      }
    }
    return out;
  }

  return { root, read, files, exists: (rel) => existsSync(join(root, rel)) };
}

// ── Comment / string stripping ────────────────────────────────────────────

/** Regex strip of block + line comments (not string-aware; drops text). */
export function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

/** Like stripComments, but block comments keep their newlines (line numbers stay valid). */
export function stripCommentsKeepLines(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

/** Like stripComments, but comments become spaces (offsets stay valid). */
export function stripCommentsKeepOffsets(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, (all, lead) => lead + ' '.repeat(all.length - lead.length));
}

/** String-aware comment removal: string contents survive, comments are dropped. */
export function stripCommentsStateful(src) {
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

/**
 * Offset-preserving blank: comments become spaces (newlines kept). With
 * `strings: true` (default) string/template bodies are blanked too, including
 * their quotes, so brace matching and token checks see only real code. With
 * `strings: false` string literals are copied verbatim. Regex literals are not
 * recognised.
 */
export function blank(src, { strings = true } = {}) {
  let out = '';
  let state = 'code';
  let quote = '';
  const keep = (ch) => (ch === '\n' ? '\n' : ' ');
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === 'code') {
      if (c === '/' && c2 === '/') { state = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && c2 === '*') { state = 'block'; out += '  '; i += 2; continue; }
      if (c === "'" || c === '"' || c === '`') {
        state = 'str';
        quote = c;
        out += strings ? ' ' : c;
        i += 1;
        continue;
      }
      out += c; i += 1; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += '\n'; i += 1; continue; }
      out += c === '\t' ? '\t' : ' '; i += 1; continue;
    }
    if (state === 'block') {
      if (c === '*' && c2 === '/') { state = 'code'; out += '  '; i += 2; continue; }
      out += keep(c); i += 1; continue;
    }
    if (c === '\\') { out += strings ? '  ' : c + (c2 ?? ''); i += 2; continue; }
    if (c === quote) { state = 'code'; out += strings ? ' ' : c; i += 1; continue; }
    out += strings ? keep(c) : c; i += 1;
  }
  return out;
}

/** Replace every match of `re` with same-length whitespace (newlines kept). */
export function blankMatches(src, re) {
  return src.replace(re, (m) => m.replace(/[^\n]/g, ' '));
}

export const blankHtmlComments = (src) => blankMatches(src, /<!--[\s\S]*?-->/g);

/** Svelte: blank everything outside `<script>` bodies (offset-preserving). */
export function scriptOnly(src) {
  const chars = src.replace(/[^\n]/g, ' ').split('');
  for (const b of scriptBlocks(src)) {
    for (let i = 0; i < b.content.length; i++) chars[b.start + i] = src[b.start + i];
  }
  return chars.join('');
}

/** Svelte: each `<script …>…</script>` body with its offset in the file. */
export function scriptBlocks(src) {
  const blocks = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(src)) !== null) {
    blocks.push({ content: m[1], start: m.index + m[0].indexOf('>') + 1 });
  }
  return blocks;
}

// ── Structure ─────────────────────────────────────────────────────────────

/** Index of the delimiter closing the one at `open` (same char type), or -1. */
export function matchBrace(code, open, openCh = code[open], closeCh = openCh === '(' ? ')' : '}') {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === openCh) depth++;
    else if (code[i] === closeCh && --depth === 0) return i;
  }
  return -1;
}

/**
 * Brace-matched body of the first DEFINITION of `name` — a `function name(…)`
 * or a method `name(…) {`. Calls are skipped. A return-type annotation is
 * stepped over, including type-literal braces (`Promise<{ … }>`); a signature
 * ending in `;` is not a definition. Pass already-blanked code. Returns
 * `{ start, end, text }` (`end` exclusive) or null.
 */
export function functionBody(code, name, { fnKeyword = false } = {}) {
  const head = fnKeyword ? `\\bfunction\\s+${name}` : `\\b${name}`;
  const re = new RegExp(`${head}\\s*(?:<[^>()]*>)?\\s*\\(`, 'g');
  let m;
  while ((m = re.exec(code)) !== null) {
    const closeParen = matchBrace(code, re.lastIndex - 1, '(', ')');
    if (closeParen < 0) continue;
    let k = closeParen + 1;
    while (k < code.length && /\s/.test(code[k])) k++;
    if (code[k] === ':') {
      k = returnTypeEnd(code, k + 1);
      if (k < 0) continue;
    }
    if (code[k] !== '{') continue;
    const close = matchBrace(code, k, '{', '}');
    if (close < 0) continue;
    return { start: k, end: close + 1, text: code.slice(k, close + 1) };
  }
  return null;
}

/** From just after a return-type `:`, the index of the body `{`, or -1. */
function returnTypeEnd(code, from) {
  let angle = 0;
  for (let i = from; i < code.length; i++) {
    const c = code[i];
    if (c === '<' || c === '(' || c === '[') angle++;
    else if ((c === '>' && code[i - 1] !== '=') || c === ')' || c === ']') angle--;
    else if (c === ';' && angle <= 0) return -1;
    else if (c === '{') {
      const before = code.slice(0, i).replace(/\s+$/, '').slice(-1);
      if (angle > 0 || '<:,|&('.includes(before)) {
        const close = matchBrace(code, i, '{', '}');
        if (close < 0) return -1;
        i = close;
        continue;
      }
      return i;
    }
  }
  return -1;
}

/** 1-based line number of `offset` in `src`. */
export function lineAt(src, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i++) if (src.charCodeAt(i) === 10) line++;
  return line;
}

/**
 * True when `marker` (string or RegExp) appears on line index `idx` or on any
 * of the `above` lines before it.
 */
export function markerNear(lines, idx, marker, above = 1) {
  for (let k = idx; k >= Math.max(0, idx - above); k--) {
    const l = lines[k] ?? '';
    if (typeof marker === 'string' ? l.includes(marker) : marker.test(l)) return true;
  }
  return false;
}

// ── Imports ───────────────────────────────────────────────────────────────

/** The module named by an import, a dynamic import, a require, or a bare `import '…'` (group 2). */
export const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s*)(['"])([^'"\n]+)\1/g;

/** The package a bare specifier names (`@scope/pkg/sub` → `@scope/pkg`, `pkg/sub` → `pkg`). */
export function packageName(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** Token-presence helper: one violation per required token missing / forbidden token present. */
export function tokenChecks(file, code, { required = [], forbidden = [] }, label = '') {
  const out = [];
  const suffix = label ? ` (${label})` : '';
  for (const { token, why } of required) {
    if (!token.test(code)) out.push(fail(file, undefined, `missing /${token.source}/ — ${why}${suffix}`));
  }
  for (const { token, why } of forbidden) {
    if (token.test(code)) out.push(fail(file, undefined, `forbidden /${token.source}/ — ${why}${suffix}`));
  }
  return out;
}

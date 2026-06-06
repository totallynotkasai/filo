/**
 * Audit-7 M1 / Phase 7 — `ci:no-dead-flush`.
 *
 * M1's root cause was DEAD CODE: `TextTile.svelte` defined a
 * `flushPendingMarkdownWrite()` that `markClean`'d its writer — but nothing ever
 * called it. The tile registered a dirty-writer on every keystroke and never
 * cleared it, so `DocumentState.isDirty` pinned true forever -> spurious
 * "modified externally" prompts + a frozen sibling-view reload `$effect`. A
 * defined-but-never-invoked flusher in a component LOOKS like the save path is
 * wired when it isn't.
 *
 * This gate walks `src/renderer/components/**.svelte` and flags every
 * COMPONENT-SCOPE (brace-depth 0 inside `<script>`) FUNCTION DECLARATION whose
 * name starts with `flush` (`function flushFoo()` / `async function flushFoo()`
 * — the idiom every flusher in this repo uses, M1's `flushPendingMarkdownWrite`
 * included) that is never referenced anywhere in the same file — neither
 * called/passed elsewhere in a `<script>` block, nor bound from the template
 * markup (`onclick={flushFoo}` etc.). Such a function is dead: either wire it up
 * or delete it (the M1 fix deleted TextTile's).
 *
 * Reference counting is deliberately conservative (biased AGAINST false
 * positives, which would break CI on a live function):
 *  - Inside `<script>`: strings + comments are blanked first (so a self-
 *    referential doc-comment can't mask the deadness), then the identifier is
 *    counted as a whole word. >= 2 occurrences (the definition + >= 1 use) = live.
 *  - In the markup: a whole-word occurrence anywhere outside the scripts counts
 *    as live (template handler / mustache). Raw, not blanked — an HTML comment
 *    mention only ever makes a function look MORE used (a safe miss).
 *
 * OUT OF SCOPE (deliberately):
 *  - Function-LOCAL flushers (brace-depth > 0): a nested helper called within
 *    its own scope has >= 2 occurrences anyway; an unused one is a lint concern
 *    for eslint, not this swap/lifecycle ratchet.
 *  - Arrow/expression flushers (`const flushFoo = () => …`): not the convention
 *    here, and a truly unused top-level `const` is eslint `no-unused-vars`
 *    territory. Matching `const|let flush\w*` would also snag plain variables
 *    like `flusherId`, so this gate keys on the `function` declaration form.
 *  - `flush*` in `.svelte.ts` stores / `lib/` modules: exported API surface with
 *    cross-module callers a single-file scan can't see — not a component dead-end.
 *
 * Escape hatch: `// allow-dead-flush: <reason>` on the declaration line or the
 * line directly above (a genuinely intentional uncalled flusher — keep it rare
 * and the reason concrete).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const SCAN_DIR = 'src/renderer/components';

function toPosix(p) {
  return p.split(sep).join('/');
}

function walkSvelte(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) walkSvelte(full, out);
    else if (s.isFile() && entry.endsWith('.svelte')) out.push(full);
  }
}

/**
 * Replace the contents of string literals and comments with spaces (newlines
 * preserved) so brace-depth counting and identifier matching ignore braces /
 * names that appear inside strings or comments. Template literals are blanked
 * wholesale (including `${…}`). Same blanker as check-component-timer-cleanup.
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
      out += ' '; i += 1; continue;
    }
    if (state === 'block') {
      if (c === '*' && c2 === '/') { state = 'code'; out += '  '; i += 2; continue; }
      out += c === '\n' ? '\n' : ' '; i += 1; continue;
    }
    // sq | dq | tpl
    const quote = state === 'sq' ? "'" : state === 'dq' ? '"' : '`';
    if (c === '\\') { out += '  '; i += 2; continue; }
    if (c === quote) { state = 'code'; out += ' '; i += 1; continue; }
    out += c === '\n' ? '\n' : ' '; i += 1; continue;
  }
  return out;
}

/** Each `<script …>…</script>` block with its start offset in the file. */
function extractScriptBlocks(src) {
  const blocks = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(src)) !== null) {
    const content = m[1];
    blocks.push({ content, start: m.index + m[0].indexOf(content), end: re.lastIndex });
  }
  return blocks;
}

/** The file with every `<script>…</script>` blanked to spaces — markup only. */
function markupOnly(src) {
  return src.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (m) => ' '.repeat(m.length));
}

function lineAt(src, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i++) if (src[i] === '\n') line++;
  return line;
}

function countWord(haystack, name) {
  const re = new RegExp(`\\b${name}\\b`, 'g');
  let n = 0;
  while (re.exec(haystack) !== null) n++;
  return n;
}

// `function flushX(` and `async function flushX(` — the flusher idiom here.
const DEF_FN_RE = /\b(?:async\s+)?function\s+(flush\w*)\s*\(/g;
const ALLOW_RE = /\/\/\s*allow-dead-flush:\s*\S+/;

const files = [];
walkSvelte(join(ROOT, SCAN_DIR), files);

const offenders = [];
let checked = 0;

for (const abs of files) {
  const rel = toPosix(relative(ROOT, abs));
  const raw = readFileSync(abs, 'utf8');
  const rawLines = raw.split(/\r?\n/);

  const blocks = extractScriptBlocks(raw);
  // Blanked, concatenated script across all blocks — for reference counting.
  const scriptBlanked = blocks.map((b) => blankStringsAndComments(b.content)).join('\n');
  const markup = markupOnly(raw);

  for (const block of blocks) {
    const code = blankStringsAndComments(block.content);

    // Brace depth before each char (only `{` `}` denote block/function scope).
    const depth = new Array(code.length);
    let d = 0;
    for (let i = 0; i < code.length; i++) {
      depth[i] = d;
      if (code[i] === '{') d++;
      else if (code[i] === '}') d = Math.max(0, d - 1);
    }

    DEF_FN_RE.lastIndex = 0;
    let m;
    while ((m = DEF_FN_RE.exec(code)) !== null) {
      if (depth[m.index] !== 0) continue; // function-local flusher — out of scope
      const name = m[1];
      checked++;

      // Escape: `// allow-dead-flush:` on the decl line or the one above.
      const declLine = lineAt(raw, block.start + m.index); // 1-based
      const windowText = `${rawLines[declLine - 2] ?? ''}\n${rawLines[declLine - 1] ?? ''}`;
      if (ALLOW_RE.test(windowText)) continue;

      // Live iff referenced in script (def + >= 1 use) OR bound from markup.
      const live = countWord(scriptBlanked, name) >= 2 || new RegExp(`\\b${name}\\b`).test(markup);
      if (!live) offenders.push({ rel, line: declLine, name });
    }
  }
}

if (offenders.length > 0) {
  console.error(
    '[check-no-dead-flush] FAILED — component-scope `flush*` function(s) defined ' +
      'but never called (M1\'s dead-code class):',
  );
  for (const { rel, line, name } of offenders.sort((a, b) => a.rel.localeCompare(b.rel))) {
    console.error(`  ${rel}:${line} — \`${name}\` is never referenced (dead flush path)`);
  }
  console.error(
    '\nA defined-but-uncalled flusher in a component looks like the save / cleanup\n' +
      'path is wired when it is not — Audit-7 M1 was exactly this (TextTile\'s\n' +
      '`flushPendingMarkdownWrite` never ran, so the dirty-writer entry was never\n' +
      'cleared). Either wire the flusher into onDestroy / the write path, or delete\n' +
      'it. If it is intentionally uncalled, annotate the declaration with\n' +
      '`// allow-dead-flush: <reason>`.',
  );
  process.exit(1);
}

console.log(`[check-no-dead-flush] OK — ${checked} component-scope flush function(s) referenced.`);
process.exit(0);

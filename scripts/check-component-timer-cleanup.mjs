/**
 * Component-timer-cleanup gate (Phase 6.1.R2 follow-up).
 *
 * The R2 class-kill — "module-level mutable state must reset on vault swap" —
 * is enforced by `check-vault-scoped-state.mjs`, but that gate scans only
 * `.svelte.ts` store/lib modules and the `new Map/Set` pattern. It is blind to
 * the OTHER half of the same leak class: a Svelte COMPONENT that holds a
 * `setTimeout` / `setInterval` handle in a component-scope binding and never
 * clears it on teardown. When such a component unmounts mid-flight (the common
 * trigger is a vault swap, which tears down every board + the sidebar), the
 * armed timer fires after unmount and runs its callback —
 * `boardStore.updateSettings(...)`, `vaultStore.toggleFolder(...)`, … —
 * against the swapped-in vault / board. (Audit-3 6.1.R2 named exactly three:
 * VaultFileItem.autoExpandTimer, KanbanSideToolbar.propDebounce,
 * KanbanBoard.lastViewPersistTimer.)
 *
 * This gate walks `src/renderer/components/**.svelte`, finds every
 * COMPONENT-SCOPE (brace-depth 0 inside `<script>`) timer handle declared as
 *   `let <name>: ReturnType<typeof setTimeout>`   (or setInterval)
 * — the idiom every timer-holding component in this repo uses — and asserts
 * each one is cleared in a teardown region: inside an `onDestroy(...)` callback
 * OR inside an `$effect` / `onMount` `return () => { ... }` cleanup.
 *
 * OUT OF SCOPE (deliberately):
 *  - Function-LOCAL timer handles (brace-depth > 0, e.g. a fetch-timeout race):
 *    they live and die with the call, not the component — not a swap leak.
 *  - Module-level / class-field / collection timers in `.svelte.ts` stores and
 *    `lib/`: their correct reset is `dispose()` or `vaultSwapResettable`, a
 *    separate concern from component teardown.
 *
 * Escape hatch: `// allow-uncleared-timer: <reason>` on the declaration line or
 * the line directly above (a genuinely fire-once timer that must outlive the
 * component by design — keep it rare and the reason concrete).
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
 * preserved) so brace-depth counting and call detection ignore braces / the
 * word "onDestroy" that appear inside strings or comments. Template literals
 * are blanked wholesale (including `${…}`); regex literals are not special-
 * cased — acceptable for a ratchet, matching the sibling gates' pragmatism.
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
    blocks.push({ content, start: m.index + m[0].indexOf(content) });
  }
  return blocks;
}

/** Return the substring from an opening delimiter to its match (inclusive). */
function matchPair(str, openIdx, open, close) {
  let depth = 0;
  for (let i = openIdx; i < str.length; i++) {
    if (str[i] === open) depth++;
    else if (str[i] === close) {
      depth--;
      if (depth === 0) return str.slice(openIdx, i + 1);
    }
  }
  return str.slice(openIdx);
}

/**
 * Concatenated text of every teardown region in a (blanked) script: the body
 * of each `onDestroy(...)` call and each `return () => { … }` / `return () =>
 * expr` cleanup arrow.
 */
function teardownText(code) {
  let acc = '';
  for (const m of code.matchAll(/\bonDestroy\s*\(/g)) {
    const paren = code.indexOf('(', m.index);
    if (paren !== -1) acc += '\n' + matchPair(code, paren, '(', ')');
  }
  for (const m of code.matchAll(/\breturn\s*\(\s*\)\s*=>/g)) {
    let j = m.index + m[0].length;
    while (j < code.length && /\s/.test(code[j])) j++;
    if (code[j] === '{') acc += '\n' + matchPair(code, j, '{', '}');
    else {
      const semi = code.indexOf(';', j);
      acc += '\n' + code.slice(j, semi === -1 ? Math.min(code.length, j + 200) : semi);
    }
  }
  return acc;
}

const DECL_RE = /\b(?:let|const|var)\s+(\w+)\s*:\s*ReturnType<typeof\s+(?:setTimeout|setInterval)>/g;
const ALLOW_RE = /\/\/\s*allow-uncleared-timer:\s*\S+/;

function lineAt(src, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i++) if (src[i] === '\n') line++;
  return line;
}

const files = [];
walkSvelte(join(ROOT, SCAN_DIR), files);

const offenders = [];
let checked = 0;

for (const abs of files) {
  const rel = toPosix(relative(ROOT, abs));
  const raw = readFileSync(abs, 'utf8');
  const rawLines = raw.split(/\r?\n/);

  for (const block of extractScriptBlocks(raw)) {
    const code = blankStringsAndComments(block.content);

    // Brace depth before each char (only `{` `}` denote block/function scope).
    const depth = new Array(code.length);
    let d = 0;
    for (let i = 0; i < code.length; i++) {
      depth[i] = d;
      if (code[i] === '{') d++;
      else if (code[i] === '}') d = Math.max(0, d - 1);
    }

    const teardown = teardownText(code);

    for (const m of code.matchAll(DECL_RE)) {
      if (depth[m.index] !== 0) continue; // function-local handle — out of scope
      const name = m[1];
      checked++;

      // Escape: `// allow-uncleared-timer:` on the decl line or the one above.
      const declLine = lineAt(raw, block.start + m.index); // 1-based
      const windowText = `${rawLines[declLine - 2] ?? ''}\n${rawLines[declLine - 1] ?? ''}`;
      if (ALLOW_RE.test(windowText)) continue;

      const clearRe = new RegExp(`clear(?:Timeout|Interval)\\s*\\(\\s*${name}\\b`);
      if (!clearRe.test(teardown)) {
        offenders.push({ rel, line: declLine, name });
      }
    }
  }
}

if (offenders.length > 0) {
  console.error(
    '[check-component-timer-cleanup] FAILED — component-scope timer handles ' +
      'not cleared on teardown (they fire after unmount / vault swap):',
  );
  for (const { rel, line, name } of offenders.sort((a, b) => a.rel.localeCompare(b.rel))) {
    console.error(`  ${rel}:${line} — \`${name}\` is never clearTimeout/clearInterval'd in an onDestroy or $effect cleanup`);
  }
  console.error(
    '\nFix: clear the handle in `onDestroy(() => { … })` (for handles armed in\n' +
      '     event handlers) or in an `$effect(() => { …; return () => { … }; })`\n' +
      '     cleanup (for handles armed inside that effect). If the timer must\n' +
      '     outlive the component by design, annotate the declaration with\n' +
      '     `// allow-uncleared-timer: <reason>`.',
  );
  process.exit(1);
}

console.log(
  `[check-component-timer-cleanup] OK — ${checked} component-scope timer handle(s) cleared on teardown.`,
);
process.exit(0);

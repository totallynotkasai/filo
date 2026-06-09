/**
 * Audit-15 P6.3 — `ci:filo-read-guard`.
 *
 * The `.filo/` carve-out: a renderer-facing channel that reads file CONTENT from
 * a renderer-supplied relative path must refuse `.filo/` (config / theme / tags /
 * templates / sentinels) via `assertNotInFiloDir`, so a hostile or buggy renderer
 * can't use a media/read channel to stream config bytes back out (or serve them
 * as media under a MIME the allowlist hasn't caught). P3.1 found `media:read-file`
 * was the one such channel that omitted the guard its siblings enforce; this gate
 * pins the invariant so a FUTURE content-read channel can't forget it silently.
 *
 * Scope — "media-serving / arbitrary file-content reads of a RENDERER-NAMED
 * relative path", detected structurally: an `ipcMain.handle` whose body both
 *   (a) reads bytes — `readFile*` / `createReadStream`, AND
 *   (b) validates a renderer relative path — `assertSafeRelativePath(`.
 * Each such handler must call `assertNotInFiloDir(`, OR be listed in
 * FILO_READ_EXEMPT with a reason. The exemption list is deliberate: it forces a
 * future engineer adding a content-read channel to either guard `.filo/` or make
 * the "this channel intentionally reads `.filo/`" decision explicit + reviewable.
 *
 * Today the only exemption is `vault:read-file-text` — the trusted UTF-8 text
 * channel the app's OWN crash-recovery (`.filo/.dirty`, tag-rewrite + rename-
 * cascade sentinels) and the vault index read THROUGH; `.filo/` reads there are
 * intended, unlike a media-serving read. Channels that build a `.filo/` path
 * INTERNALLY (config:load / theme:load / tags:load / templates:*) don't take a
 * renderer relpath (no `assertSafeRelativePath` on a renderer arg), so the sweep
 * never sees them; structured-data reads that delegate the byte read to a helper
 * (board:load → loadBoardFile) have no read primitive in the handler body, so
 * they're out of scope too (they return parsed JSON, not raw file bytes).
 *
 * Plus two NAMED anchors the sweep can't reach by itself:
 *   - `media:read-file` (the P3.1 fix) — pinned by name so a refactor that moves
 *     its byte read into a helper (making the sweep stop seeing it) still requires
 *     the guard.
 *   - `resolveServableMediaPath` (src/main/protocol/mediaPathGuard.ts) — the
 *     `filo://` protocol media resolver. It is a `protocol.handle` stream path,
 *     NOT an `ipcMain.handle`, so the sweep above doesn't enumerate it.
 *
 * Token checks run on a string/comment-blanked copy of ONLY the target handler /
 * function body, so a comment naming the guard can't satisfy the gate and an
 * unrelated token elsewhere in the file can't trip it.
 *
 * Bite-verify: drop `assertNotInFiloDir` from `media:read-file`, from
 * `resolveServableMediaPath`, or from a non-exempt swept read handler → red.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();

/** Blank string/template/comment bodies (offset preserved) so only real code is scanned. */
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
    if (state === 'sq' || state === 'dq') {
      const q = state === 'sq' ? "'" : '"';
      if (c === '\\') { out += '  '; i += 2; continue; }
      if (c === q) { state = 'code'; out += ' '; i += 1; continue; }
      out += c === '\n' ? '\n' : ' '; i += 1; continue;
    }
    // template literal
    if (c === '\\') { out += '  '; i += 2; continue; }
    if (c === '`') { state = 'code'; out += ' '; i += 1; continue; }
    out += c === '\n' ? '\n' : ' '; i += 1; continue;
  }
  return out;
}

/** Brace-match a `{...}` body starting at index `start` of `code`. */
function matchBraces(code, start) {
  let depth = 0;
  for (let i = start; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') { depth--; if (depth === 0) return code.slice(start, i + 1); }
  }
  return null;
}

/**
 * Segments a file's `ipcMain.handle` registrations: `{ channel, body }` for each,
 * where `body` is the comment/string-blanked source from this handler's
 * registration to the NEXT handler's (or EOF). Segment-based rather than
 * brace-matched: a handler body can contain regex literals (`/\/+$/`) and `${…}`
 * template interpolations that a naive brace matcher miscounts (`blankStrings-
 * AndComments` doesn't recognise regex literals), which would mis-attribute one
 * handler's body to its sibling. Token-PRESENCE checks (readFile /
 * assertSafeRelativePath / assertNotInFiloDir are code identifiers, never inside
 * a string) don't need exact boundaries — only the correct handler.
 */
function extractHandlerSegments(raw) {
  const blanked = blankStringsAndComments(raw);
  const marks = [];
  const re = /ipcMain\.handle\(\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(raw))) marks.push({ channel: m[1], start: m.index });
  return marks.map((mark, i) => ({
    channel: mark.channel,
    body: blanked.slice(mark.start, i + 1 < marks.length ? marks[i + 1].start : raw.length),
  }));
}

/** Extracts the body `{...}` of the first definition of named `fnName`. */
function extractNamedFnBody(code, fnName) {
  const re = new RegExp(`(?:function\\s+)?\\b${fnName}\\s*\\(`, 'g');
  let m;
  while ((m = re.exec(code))) {
    let i = re.lastIndex - 1;
    let depth = 0;
    for (; i < code.length; i++) {
      if (code[i] === '(') depth++;
      else if (code[i] === ')') { depth--; if (depth === 0) { i++; break; } }
    }
    while (i < code.length && code[i] !== '{' && code[i] !== ';') i++;
    if (code[i] !== '{') continue; // a call / forward-decl, not a definition
    return matchBraces(code, i);
  }
  return null;
}

function toPosix(p) {
  return p.split(sep).join('/');
}

function walkTs(dir, out) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) walkTs(full, out);
    else if (s.isFile() && entry.endsWith('.ts')) out.push(full);
  }
}

/**
 * Channels that legitimately read `.filo/` content (so they MUST NOT carry the
 * guard). Each entry is a documented reason — adding to this list is a conscious,
 * reviewable decision, which is exactly the anti-regression property we want.
 */
const FILO_READ_EXEMPT = new Map([
  [
    'vault:read-file-text',
    "trusted UTF-8 text channel the app's own crash-recovery (.filo/.dirty + tag-rewrite + rename-cascade sentinels) and the vault index read THROUGH — .filo/ reads are intended here, unlike a media-serving read",
  ],
]);

const READ_PRIMITIVE = /\b(?:readFile|createReadStream)/;
const TAKES_RELPATH = /\bassertSafeRelativePath\s*\(/;
const FILO_GUARD = /\bassertNotInFiloDir\s*\(/;

const failures = [];
let sweptReadChannels = 0;

// ── Sweep: every renderer-relpath content-read ipcMain.handle must guard .filo/.
{
  const files = [];
  walkTs(join(ROOT, 'src/main/ipc'), files);
  for (const abs of files) {
    const raw = readFileSync(abs, 'utf8');
    const rel = toPosix(relative(ROOT, abs));
    for (const { channel, body } of extractHandlerSegments(raw)) {
      if (!READ_PRIMITIVE.test(body) || !TAKES_RELPATH.test(body)) continue;
      // A content read of a renderer-supplied relative path.
      sweptReadChannels++;
      if (FILO_READ_EXEMPT.has(channel)) continue;
      if (!FILO_GUARD.test(body)) {
        failures.push(
          `${rel} → ${channel} handler — reads file content from a renderer-supplied relative ` +
            'path but never calls assertNotInFiloDir(...) — a renderer can read `.filo/` ' +
            'config/theme/tags bytes through it. Add assertNotInFiloDir after assertSafeRelativePath, ' +
            'or (if `.filo/` reads are genuinely intended) add the channel to FILO_READ_EXEMPT ' +
            'with a reason in scripts/check-filo-read-guard.mjs.',
        );
      }
    }
  }
}

// Tripwire — the sweep must keep finding content-read channels, else a refactor
// renaming the read primitive or the relpath validator would silently collapse
// the heuristic to zero and void the gate while "passing". 2 today
// (media:read-file + the exempt vault:read-file-text); floor below that, above 0.
const MIN_SWEPT = 2;
if (sweptReadChannels < MIN_SWEPT) {
  failures.push(
    `sweep found only ${sweptReadChannels} renderer-relpath content-read handler(s) ` +
      `(expected ≥ ${MIN_SWEPT}); the READ_PRIMITIVE / TAKES_RELPATH heuristic likely went ` +
      'stale (a read wrapper or path validator was renamed). Re-point the patterns + re-baseline ' +
      'in scripts/check-filo-read-guard.mjs.',
  );
}

// ── Named anchor 1: media:read-file (the P3.1 fix), pinned by name so a refactor
//    moving its byte read into a helper (sweep stops seeing it) still requires the guard.
{
  const file = 'src/main/ipc/media.ipc.ts';
  let raw;
  try {
    raw = readFileSync(join(ROOT, file), 'utf8');
  } catch (err) {
    failures.push(`${file} — cannot read: ${err.message}`);
    raw = null;
  }
  if (raw !== null) {
    const seg = extractHandlerSegments(raw).find((s) => s.channel === 'media:read-file');
    if (!seg) {
      failures.push(`${file} — could not locate the 'media:read-file' handler (moved/renamed?)`);
    } else if (!FILO_GUARD.test(seg.body)) {
      failures.push(
        `${file} → media:read-file handler — missing assertNotInFiloDir(...) — a renderer can read .filo/ bytes as media (P3.1)`,
      );
    }
  }
}

// ── Named anchor 2: the filo:// protocol media resolver (a protocol.handle stream
//    path, not an ipcMain.handle — the sweep never enumerates it).
{
  const file = 'src/main/protocol/mediaPathGuard.ts';
  let raw;
  try {
    raw = readFileSync(join(ROOT, file), 'utf8');
  } catch (err) {
    failures.push(`${file} — cannot read: ${err.message}`);
    raw = null;
  }
  if (raw !== null) {
    const body = extractNamedFnBody(blankStringsAndComments(raw), 'resolveServableMediaPath');
    if (body === null) {
      failures.push(`${file} — could not find function \`resolveServableMediaPath\` (moved/renamed?)`);
    } else if (!FILO_GUARD.test(body)) {
      failures.push(
        `${file} → resolveServableMediaPath — missing assertNotInFiloDir(...) — the filo:// protocol would stream .filo/ config bytes`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error('[check-filo-read-guard] FAILED — a content-read path can reach into `.filo/`:');
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    '\nEvery renderer-facing channel that reads file CONTENT from a renderer-supplied\n' +
      'relative path (media:read-file, the filo:// protocol resolver, any future\n' +
      'media/read channel) must refuse `.filo/` via assertNotInFiloDir — the app\'s\n' +
      'config/theme/tags/templates live there and have dedicated channels. The ONLY\n' +
      'exemption is vault:read-file-text (recovery + index read .filo/ sentinels). See\n' +
      'AUDIT15_REMEDIATION_PLAN_2026-06-08.md P3.1/P6.3 + src/tests/unit/mediaReadFileFiloGuard.test.ts.',
  );
  process.exit(1);
}

console.log(
  `[check-filo-read-guard] OK — ${sweptReadChannels} renderer-relpath content-read handler(s) guard \`.filo/\` ` +
    '(or are documented-exempt); media:read-file + resolveServableMediaPath pinned.',
);
process.exit(0);

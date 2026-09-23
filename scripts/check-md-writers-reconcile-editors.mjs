/**
 * Markdown-writer editor-reconcile gate (Audit5 R2; call-site-scoped in
 * Audit-6 5.4; coupled-helper-enforced in Phase 6.6).
 *
 * #4 root cause: a direct `.md` write that lands underneath an OPEN editor
 * leaves that editor's in-memory frontmatter cache stale. The editor's next
 * debounced body save then assembles the file from its stale snapshot and
 * silently inverts the direct write (the single-tag fast path dropped the tag).
 *
 * The structural fix is `writeMarkdownAndReconcile(...)` in
 * src/renderer/lib/vault/syncOpenEditorsAfterDiskMutation.ts — the COUPLED
 * helper that performs the direct `.md` write AND the matching open-editor
 * reconcile (full reload OR frontmatter-only) for the SAME `path` argument.
 * Because both halves read one `path`, the written path and the reconciled
 * path cannot diverge by construction.
 *
 * ── Phase 6.6 — path-equality is now DONE (was "Phase 6 territory") ──────────
 *
 * The earlier (Audit-6 5.4) form of this gate only proved a reconcile call sat
 * in the SAME top-level block as the write — never that it named the same path.
 * That data-flow part ("ideally same relPath arg") was explicitly deferred:
 * following `item.path` to the `items` array passed to the reconcile across
 * function boundaries needs real data-flow analysis a brace/regex ratchet can't
 * do without false-positiving on correct code. Phase 6.6 dissolves the problem
 * instead of analysing it: every non-gateway `.md` writer now routes through the
 * coupled helper, so there is one `path` argument feeding both halves and
 * nothing to trace.
 *
 * This gate therefore now enforces the stronger, simpler invariant: a direct
 * `vault:write-(existing-)?file-text` call (i.e. OUTSIDE the markdownFileWriter
 * gateway) may appear ONLY in:
 *   - the coupled helper itself (COUPLED_HELPER below — it owns the raw write
 *     paired in-function with its own same-path reconcile), or
 *   - a file in RECONCILE_EXEMPT that never targets a possibly-open editor
 *     (brand-new file seed, `.filo/` sentinel, per-machine config geometry).
 * Any other direct write must be migrated onto `writeMarkdownAndReconcile`.
 *
 * The same-top-level-block scan (and the helper-name match it relied on) is
 * gone: a reconcile call sitting near a hand-rolled write no longer satisfies
 * the gate, because that arrangement is exactly what the coupled helper
 * replaces. The escape hatch survives for a genuine future case where a write
 * legitimately cannot use the helper and its reconcile is handled elsewhere:
 * mark the write site `// reconcile-elsewhere: <reason>`. No current writer
 * needs it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const RENDERER_DIR = join(ROOT, 'src/renderer');
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build']);

/**
 * THE coupled write+reconcile helper. It legitimately contains the raw
 * `vault:write-…` invokes — each paired in-function with a same-path reconcile
 * — so it is the one non-exempt file allowed to call the channel directly. Its
 * raw writes carry `// allow-direct-write:` for the markdown-gateway gate.
 */
const COUPLED_HELPER = 'src/renderer/lib/vault/syncOpenEditorsAfterDiskMutation.ts';

/**
 * Direct `.md` writers that legitimately do NOT reconcile open editors,
 * each with the reason it's safe. A NEW direct writer must route through
 * `writeMarkdownAndReconcile` (preferred) or be added here with a justification.
 */
const RECONCILE_EXEMPT = new Map([
  // The gateway itself owns the editor body write AND the frontmatter cache, so
  // its writes are intrinsically reconciled — it IS the editor's writer.
  ['src/renderer/lib/vault/markdownFileWriter.ts', 'the gateway — owns the editor write + frontmatter cache'],
  // Brand-new backing-file seeds — the tile/editor mounts AFTER the file exists,
  // so there is never a concurrent open editor to reconcile.
  ['src/renderer/lib/boards/seedTextFileForNewTile.ts', 'seeds a brand-new tile backing .md (no prior editor)'],
  ['src/renderer/lib/kanban/kanbanTileCreation.ts', 'creates a new Kanban card backing .md'],
  ['src/renderer/lib/tasklist/taskCreation.ts', 'creates a new task backing .md'],
  ['src/renderer/lib/tasklist/fileDropHandler.ts', 'writes a freshly OS-dropped file into the vault'],
  // Audit-19 BL-1 — the create-exclusive seed helper every creation module routes through.
  ['src/renderer/lib/vault/createMdExclusive.ts', 'creates a brand-new .md (EEXIST otherwise — never targets an open editor)'],
  // Audit-14 7.3 — `tileCommands.ts` + `taskCommands.ts` were REMOVED from this
  // list. Their file-level exemption ("editor mounts afterward") was false for
  // the delete-UNDO snapshot-restore writes (DeleteTilesCommand.undo /
  // DeleteTaskCommand.undo): the restored `.md` can be open as a Document on a
  // SECOND pane, whose stale frontmatter cache would silently invert the restore
  // (#4). 2.3 routed DeleteTilesCommand.undo and 7.3 routed DeleteTaskCommand.undo
  // through `writeMarkdownAndReconcile`, so neither file does a raw `.md` write
  // anymore (the scan skips them automatically). Their brand-new-file ADD seeds
  // live in the still-exempt dedicated creation modules (seedTextFileForNewTile /
  // kanbanTileCreation / taskCreation), which never target a possibly-open editor.
  // `.filo/` crash-recovery sentinels + per-machine config — not editor-backed.
  ['src/renderer/lib/vault/renameCascadeSentinel.ts', '.filo/ rename-cascade sentinel (not editor-backed)'],
  ['src/renderer/lib/vault/tagRewriteSentinel.ts', '.filo/ tag-rewrite sentinel (not editor-backed)'],
  ['src/renderer/lib/vault/dirtyFlagRecovery.ts', '.filo/.dirty sentinel (not editor-backed)'],
  ['src/renderer/components/boards/KanbanSideToolbar.svelte', '.filo/ overlay geometry config (not editor-backed)'],
]);

// Same channel matcher as check-markdown-write-gateway.mjs (real call sites
// only, not comments / docstrings referencing the channel name).
const channelRe = /\binvoke(?:Ok)?\s*\(\s*['"`]vault:(?:write-(?:existing-)?|create-)file-text['"`]/gs;

/** Per-write-site escape when the reconcile genuinely lives elsewhere. */
const ESCAPE_RE = /\/\/ reconcile-elsewhere:/;

/**
 * Replaces every comment + string/template body with spaces (preserving offsets
 * and newlines), so a write-channel literal MENTIONED in a comment/docstring
 * (or commented-out call) can't be mistaken for a real call site.
 * (Shared shape with check-reconciler-vault-guard.mjs.)
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

function lineNumberAt(text, offset) {
  let n = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const violations = [];

for (const file of walk(RENDERER_DIR)) {
  if (!/\.(ts|svelte)$/.test(file)) continue;
  const rel = relative(ROOT, file).replaceAll(sep, '/');

  if (rel === COUPLED_HELPER) continue; // the coupled helper owns the raw write
  if (RECONCILE_EXEMPT.has(rel)) continue; // documented exemption

  const text = readFileSync(file, 'utf8');
  channelRe.lastIndex = 0;
  if (!channelRe.test(text)) continue; // not a direct .md writer

  const blanked = blankStringsAndComments(text);
  const lines = text.split('\n');

  // Write call sites — matched on RAW source (channelRe needs the channel
  // string literal that blanking would erase), then filtered to real code by
  // checking the `invoke` keyword survived blanking (a commented-out call would
  // be blanked to spaces).
  channelRe.lastIndex = 0;
  let wm;
  while ((wm = channelRe.exec(text)) !== null) {
    const off = wm.index;
    if (blanked.slice(off, off + 6) !== 'invoke') continue; // inside a comment/string

    const lineNo = lineNumberAt(text, off);

    // An explicit per-site escape for a genuine write that cannot use the
    // coupled helper (its reconcile is handled elsewhere). Accept it on the
    // write line or any of the 4 lines immediately above (covers multi-line
    // invocations + an escape comment that sits above the call).
    const escaped =
      ESCAPE_RE.test(lines[lineNo - 1] ?? '') ||
      [1, 2, 3, 4].some((j) => ESCAPE_RE.test(lines[lineNo - 1 - j] ?? ''));
    if (escaped) continue;

    violations.push({ rel, lineNo });
  }
}

if (violations.length > 0) {
  console.error('Direct `.md` write call site(s) outside the coupled write+reconcile helper:');
  for (const v of violations) console.error(`  ${v.rel}:${v.lineNo}`);
  console.error('');
  console.error('Phase 6.6: every non-gateway `.md` write must route through');
  console.error('  writeMarkdownAndReconcile({ vaultRoot, path, content, mode, create?, track? })');
  console.error('in src/renderer/lib/vault/syncOpenEditorsAfterDiskMutation.ts. It performs the write');
  console.error('AND the matching open-editor reconcile for the SAME path, so a direct write can never');
  console.error('land under an open editor whose next body save would silently invert it (#4).');
  console.error('  - mode: "full"        — body + frontmatter reload (caller flushed/superseded the editor)');
  console.error('  - mode: "frontmatter" — frontmatter-only, body-preserving (the single-tag fast path)');
  console.error('  - create: true        — vault:write-file-text (mkdir -p, restores/recreations)');
  console.error('If the writer never targets a possibly-open editor (new-file seed, .filo/ sentinel,');
  console.error('config geometry), add the FILE to RECONCILE_EXEMPT in this script with a reason.');
  console.error('If the write genuinely cannot use the helper and its reconcile lives elsewhere,');
  console.error('mark the write site `// reconcile-elsewhere: <reason>`.');
  process.exit(1);
}

console.log('check-md-writers-reconcile-editors: OK');

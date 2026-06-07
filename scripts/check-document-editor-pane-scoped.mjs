/**
 * Audit-11 R1 / Audit-12 M5 — `ci:document-editor-pane-scoped`.
 *
 * A pane-scope gate: forbids GLOBAL board/canvas/tab facade reads inside
 * components/actions that a split pane renders twice. Audit-12 M5 widened it
 * from DocumentEditor.svelte alone to also cover `lib/canvas/dragDrop.ts` (the
 * OS file-drop action), which must create tiles against the threaded pane scope.
 *
 * R1: `DocumentEditor.svelte` resolved its doc from the GLOBALLY-active tab
 * (`tabStore.activeTab`) instead of its own pane. In a split pane both Document
 * editors then bound to the globally-active tab's doc — mirroring it, swapping
 * content underneath via the `mode:'full'` reload effect, and staling the
 * captured `callerId` / force-writer identity, opening dirty+tab-switch
 * edit-loss / wrong-file corners. Single-pane sessions are unaffected (the
 * global active tab IS the only pane's tab), which is why every prior audit
 * missed it.
 *
 * The fix makes the component PANE-SCOPED: it takes a `tabId` prop (BoardRouter
 * passes each pane's own tab) and derives `tab = tabStore.tabs.find((t) => t.id
 * === tabId)` — never reading the global active tab.
 *
 * This gate forbids any `tabStore.activeTab` / `tabStore.activeTabId` read inside
 * `DocumentEditor.svelte` so the pane-scope fix can't silently regress. It blanks
 * JS strings + JS comments (inside `<script>`) and HTML comments first — so the
 * explanatory comment that NAMES the forbidden read can't trip the gate; only
 * real code (a `<script>` expression or a markup mustache) does. The transform is
 * offset-preserving so reported line numbers are accurate. Modeled on
 * check-no-dead-flush.mjs.
 *
 * Escape hatch: `// allow-global-tab: <reason>` on the offending line or the one
 * directly above. There is no legitimate use today — keep it that way.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

/**
 * Pane-scope targets. Each forbids a GLOBAL facade read that would break in a
 * split pane:
 *   - DocumentEditor.svelte (Audit-11 R1) — `tabStore.activeTab(Id)` makes both
 *     panes mirror the globally-active tab's doc.
 *   - dragDrop.ts (Audit-12 M5) — a global `boardStore`/`canvasStore` read makes
 *     an OS file-drop land on the ACTIVE pane's board with its viewport, not the
 *     pane the file was dropped on (a `drop` has no pointerdown to activate the
 *     target pane). The action now takes the pane's BoardScope as a parameter.
 *
 * `kind: 'svelte'` blanks <script> internals + HTML comments but leaves markup
 * raw (a mustache read is still caught). `kind: 'ts'` blanks strings/comments on
 * the whole file. Both transforms are offset-preserving for accurate line nums.
 */
const TARGETS = [
  {
    file: 'src/renderer/components/boards/DocumentEditor.svelte',
    kind: 'svelte',
    forbidden: /\btabStore\s*\.\s*activeTab(?:Id)?\b/g,
    allow: /\/\/\s*allow-global-tab:\s*\S+/,
    label: 'reads the GLOBAL active tab (Audit-11 R1 regression)',
    hint:
      'DocumentEditor must be PANE-SCOPED: derive its doc from the `tabId` prop\n' +
      '(`tab = tabStore.tabs.find((t) => t.id === tabId)`), never from\n' +
      '`tabStore.activeTab` / `tabStore.activeTabId`. If a read is genuinely\n' +
      'intentional, annotate it with `// allow-global-tab: <reason>`.',
  },
  {
    file: 'src/renderer/lib/canvas/dragDrop.ts',
    kind: 'ts',
    forbidden: /\b(?:boardStore|canvasStore)\b/g,
    allow: /\/\/\s*allow-global-(?:board|canvas)-facade:\s*\S+/,
    label: 'reads a GLOBAL board/canvas facade (Audit-12 M5 regression)',
    hint:
      'dragDropAction must create tiles against the PANE-SCOPED `scope.board` /\n' +
      '`scope.canvas` it is handed (mirroring viewportAction/edgePanAction), never\n' +
      'the global `boardStore` / `canvasStore` — a drop has no pointerdown to\n' +
      'activate the target pane, so a global read lands the tile on the wrong pane.\n' +
      'See AUDIT12_REMEDIATION_PLAN_2026-06-06.md M5. If genuinely intentional,\n' +
      'annotate with `// allow-global-board-facade: <reason>`.',
  },
];

/**
 * Replace string-literal + JS-comment bodies with spaces (offset preserved), so
 * a `tabStore.activeTab` named inside a `<script>` comment/string can't trip the
 * gate. Same blanker as check-no-dead-flush.mjs.
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

/** Blank HTML comment bodies in place (offset/line preserved). */
function blankHtmlComments(src) {
  return src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
}

/** Blank JS strings/comments INSIDE each `<script>` block only (offset preserved). */
function blankScriptInternals(src) {
  return src.replace(
    /(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi,
    (_full, open, body, close) => open + blankStringsAndComments(body) + close,
  );
}

function lineAt(src, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i++) if (src[i] === '\n') line++;
  return line;
}

let failed = false;

for (const target of TARGETS) {
  let raw;
  try {
    raw = readFileSync(join(ROOT, target.file), 'utf8');
  } catch (err) {
    console.error(`[check-document-editor-pane-scoped] FAILED — cannot read ${target.file}: ${err.message}`);
    console.error('A pane-scope gate target moved or was deleted — re-point TARGETS or restore the file.');
    process.exit(1);
  }

  const rawLines = raw.split(/\r?\n/);
  // Markup outside <script> is left RAW so a mustache read is still caught; for
  // a .ts file we blank strings/comments across the whole source.
  const scanned =
    target.kind === 'svelte'
      ? blankScriptInternals(blankHtmlComments(raw))
      : blankStringsAndComments(raw);

  const offenders = [];
  const re = target.forbidden;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(scanned)) !== null) {
    const line = lineAt(raw, m.index); // 1-based
    const windowText = `${rawLines[line - 2] ?? ''}\n${rawLines[line - 1] ?? ''}`;
    if (target.allow.test(windowText)) continue;
    offenders.push({ line, text: (rawLines[line - 1] ?? '').trim() });
  }

  if (offenders.length > 0) {
    failed = true;
    console.error(`[check-document-editor-pane-scoped] FAILED — ${target.file} ${target.label}:`);
    for (const { line, text } of offenders) {
      console.error(`  ${target.file}:${line} — \`${text}\``);
    }
    console.error(`\n${target.hint}\n`);
  }
}

if (failed) process.exit(1);

console.log('[check-document-editor-pane-scoped] OK — DocumentEditor + dragDrop stay pane-scoped (no global facade reads).');
process.exit(0);

/**
 * Audit-11 R1 — `ci:document-editor-pane-scoped`.
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
const TARGET = 'src/renderer/components/boards/DocumentEditor.svelte';
const FORBIDDEN = /\btabStore\s*\.\s*activeTab(?:Id)?\b/g;
const ALLOW_RE = /\/\/\s*allow-global-tab:\s*\S+/;

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

let raw;
try {
  raw = readFileSync(join(ROOT, TARGET), 'utf8');
} catch (err) {
  console.error(`[check-document-editor-pane-scoped] FAILED — cannot read ${TARGET}: ${err.message}`);
  console.error('The R1 gate target moved or was deleted — re-point TARGET or restore the file.');
  process.exit(1);
}

const rawLines = raw.split(/\r?\n/);
// Markup outside <script> is left RAW so a mustache `{tabStore.activeTab}` is
// still caught; only <script> internals + HTML comments are blanked.
const scanned = blankScriptInternals(blankHtmlComments(raw));

const offenders = [];
let m;
FORBIDDEN.lastIndex = 0;
while ((m = FORBIDDEN.exec(scanned)) !== null) {
  const line = lineAt(raw, m.index); // 1-based
  const windowText = `${rawLines[line - 2] ?? ''}\n${rawLines[line - 1] ?? ''}`;
  if (ALLOW_RE.test(windowText)) continue;
  offenders.push({ line, text: (rawLines[line - 1] ?? '').trim() });
}

if (offenders.length > 0) {
  console.error(
    '[check-document-editor-pane-scoped] FAILED — DocumentEditor.svelte reads the ' +
      'GLOBAL active tab (R1 regression):',
  );
  for (const { line, text } of offenders) {
    console.error(`  ${TARGET}:${line} — \`${text}\``);
  }
  console.error(
    '\nDocumentEditor must be PANE-SCOPED: derive its doc from the `tabId` prop\n' +
      '(`tab = tabStore.tabs.find((t) => t.id === tabId)`), never from\n' +
      '`tabStore.activeTab` / `tabStore.activeTabId`. Reading the global active tab\n' +
      'makes every split pane mirror the same doc and stales the captured\n' +
      'callerId / force-writer (Audit-11 R1). If a read is genuinely intentional,\n' +
      'annotate it with `// allow-global-tab: <reason>`.',
  );
  process.exit(1);
}

console.log('[check-document-editor-pane-scoped] OK — DocumentEditor stays pane-scoped (no global-tab read).');
process.exit(0);

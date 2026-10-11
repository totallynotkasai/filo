// Byte-fidelity ratchets: BOM, encoding, line endings, the single YAML parser,
// and the editor load/save discipline that keeps an unedited note byte-identical.
import {
  fail, blank, functionBody, lineAt, matchBrace, scriptOnly, stripComments, stripCommentsKeepLines, tokenChecks, IMPORT_SPECIFIER,
} from './lib.mjs';

const BOM_ALLOWED = new Set([
  'src/renderer/lib/editor/markdownSync.ts', // re-emits the BOM a raw file carried
  'src/renderer/lib/notes/frontmatterFence.ts', // the fence parser sees raw bytes
]);

// The one module that decides where a note's frontmatter block ends. A second
// fence regex drifts (trailing spaces on a fence, an empty block, the first vs
// a later `---`), and then one reader shows as body what another writes as keys.
const FENCE_PARSER = 'src/renderer/lib/notes/frontmatterFence.ts';
const FENCE_PATTERNS = [
  // A regex (literal or RegExp string) anchored on an opening `---`, BOM-tolerant or not.
  ['fence-regex', /\^\(?(?:\\uFEFF\??|\\u\{feff\}\??|﻿\??)?\(?(?:-{3}|-\{3\}|\\-\\-\\-)/i],
  ['fence-startsWith', /\.startsWith\(\s*['"`](?:\\uFEFF|﻿)?---/i],
];
const BOM_PATTERNS = [
  ['hex-feff', /charCodeAt\s*\(\s*0\s*\)\s*===\s*0x[fF][eE][fF][fF]/],
  ['dec-feff', /charCodeAt\s*\(\s*0\s*\)\s*===\s*65279\b/],
  ['escape-feff', /\\u\{?[fF][eE][fF][fF]\}?/],
  ['literal-feff', /﻿/],
];

const EOL_CHECKS = [
  {
    file: 'src/renderer/lib/editor/markdownSync.ts',
    required: [
      { token: /function\s+detectFrontmatterEol\b/, why: 'the file-eol derivation helper exists' },
      { token: /const\s+eol\s*=\s*detectFrontmatterEol\s*\(/, why: 'the dirty-frontmatter branch derives the file eol' },
      { token: /\.replace\(\s*\/\\n\/g\s*,\s*eol\s*\)/, why: 'the FM block + fences re-apply the file eol (no hard-coded \\n)' },
      {
        token: /options\.eol\s*===\s*'\\r\\n'[\s\S]{0,120}\.replace\(\s*\/\\r\?\\n\/g/,
        why: 'an explicit CRLF eol normalises the LF editor body too (else a CRLF note goes mixed-EOL)',
      },
    ],
  },
  {
    file: 'src/tests/unit/assembleMarkdownEngine.test.ts',
    required: [
      { token: /single-line frontmatter eol'/, why: 'the single-line-frontmatter CRLF behavioural matrix exists' },
      { token: /eol:\s*'\\r\\n'/, why: 'a row drives the gateway-threaded CRLF eol' },
      { token: /— CRLF body'/, why: 'the CRLF-body behavioural matrix exists' },
    ],
  },
  {
    file: 'src/renderer/lib/notes/noteFile.ts',
    required: [
      { token: /eol:\s*fileLineEnding\(\s*raw\s*\)/, why: "a note's line ending is read from the whole raw file (by majority)" },
      { token: /\bfresh\.eol\b/, why: "a body write re-applies the fresh read's line ending" },
      { token: /frontmatterLineEnding\(\s*fresh\.raw\s*\)/, why: 'a change without a body writes the block in the ending its fence already has' },
      { token: /change\.body\s*===\s*undefined\)\s*text\s*=\s*withDiskBody\(\s*text\s*,\s*fresh\s*\)/, why: 'a change without a body keeps the disk body byte-exact (a mixed-ending body included)' },
    ],
  },
  {
    // The tag rewriter and the note writer pick line endings with one rule.
    file: 'src/renderer/lib/vault/tagRewriter.ts',
    required: [{ token: /frontmatterLineEnding\(\s*(?:text|raw)\s*\)/, why: 'the rewriter uses the shared line-ending rule' }],
    forbidden: [{ token: /function\s+detectEol\b/, why: 'a second line-ending detector can disagree with the note writer about the same file' }],
  },
  {
    file: 'src/tests/unit/noteLineEndingsKept.test.ts',
    required: [{ token: /a frontmatter change leaves every body byte as it was/, why: 'the mixed-line-ending case exists' }],
  },
  {
    file: 'src/tests/unit/noteFile.test.ts',
    required: [
      { token: /writes a CRLF note back as CRLF throughout/, why: 'the CRLF-body write case exists' },
      { token: /one-line frontmatter keeps CRLF on a metadata edit/, why: 'the single-line-frontmatter CRLF case exists' },
    ],
  },
];


const ROUNDTRIP_TEST = 'src/tests/unit/markdownBodyRoundTrip.test.ts';
const ROUNDTRIP_FIXTURES = 'src/tests/unit/fixtures/markdown-body-roundtrip';
const ROUNDTRIP_MIN_FIXTURES = 15;
const ROUNDTRIP_REQUIRED_FIXTURES = [
  'ends-heading.md', 'ends-list.md', 'ends-table.md', 'ends-code-block.md', 'tables.md', 'task-lists.md',
  'nested-lists.md', 'inline-html-spans.md', 'tags.md', 'blank-line-paragraphs.md', 'code-blocks.md',
  'links-underline.md', 'hr-leading-body.md', 'bare-names-and-domains.md', 'filo-links.md', 'aligned-blocks.md',
];
const ROUNDTRIP_TOKENS = [
  { token: /\bcreateTiptapEditor\s*\(/, why: 'drives the real editor factory' },
  { token: /\bloadMarkdownIntoEditor\s*\(/, why: 'uses the production load path' },
  { token: /\beditorMarkdown\s*\(/, why: 'uses the production serialise path' },
  { token: /\bisLossyMarkdownRoundTrip\s*\(/, why: 'checks the lossy (read-only) verdict' },
  { token: /emits no update/, why: 'asserts loading a file fires no phantom write' },
  { token: /load → undo is a no-op/, why: 'asserts Ctrl+Z right after a load changes nothing' },
  { token: /\\r\\n/, why: 'exercises CRLF bodies' },
];
const EDITOR_SUITE = [
  {
    file: 'src/tests/component/editorIntegration/textTileLifecycle.test.ts',
    required: [
      { token: /\bmount\s*\(/, why: 'mounts the real component' },
      { token: /\bTextTile\b/, why: 'drives the real TextTile.svelte' },
      { token: /\bunmount\s*\(/, why: 'exercises unmount (phantom write)' },
      { token: /ctrlKey:\s*true/, why: 'drives undo through the real keymap' },
      { token: /markdown-body-roundtrip/, why: 'is parameterised over the corpus' },
    ],
  },
  {
    file: 'src/tests/component/editorIntegration/documentEditorOpen.test.ts',
    required: [
      { token: /\bDocumentEditor\b/, why: 'drives the real DocumentEditor.svelte' },
      { token: /effect_update_depth_exceeded/, why: 'asserts no Svelte effect loop on open' },
    ],
  },
  {
    // Without it an editor ↔ effect loop (the svelte ^5.57.1 open-path write)
    // hangs the run instead of failing it.
    file: 'src/tests/component/helpers/mountEditor.ts',
    required: [
      { token: /\binstallEditorLoopBreaker\s*\(/, why: 'turns a runaway editor update loop into a failure' },
    ],
  },
  {
    file: 'src/tests/unit/boardFileEncodingRoundTrip.test.ts',
    required: [
      { token: /\bsaveBoardFile\s*\(/, why: 'uses the real main-side saveBoardFile' },
      { token: /\bfs\.stat\s*\(|\bstat\s*\(/, why: 'measures the real on-disk size' },
    ],
  },
];
const SKIPPED_TEST_RE = /\b(?:it|describe)\.skip\b|\bit\.todo\b/;

// Every formatting command the toolbar runs must have a save → reload case, so
// no button can produce formatting the file can't hold.
const TOOLBAR_CONFIG = 'src/renderer/lib/editor/toolbarConfig.ts';
const TOOLBAR_ROUNDTRIP_TEST = 'src/tests/unit/toolbarFormattingRoundTrip.test.ts';
const TOOLBAR_CASES = 'src/tests/helpers/toolbarCases.ts';
const PROPERTY_TEST = 'src/tests/unit/editorRoundTripProperty.test.ts';

// Markdown parsers other than markdown-it, by package name (a subpath included).
const OTHER_MARKDOWN_PARSER =
  /^(?:marked|micromark(?:-[\w.-]+)?|remark(?:-[\w.-]+)?|unified|mdast-[\w.-]+|commonmark|@tiptap\/markdown)(?:\/.*)?$/;
const ELSEWHERE_TEST = 'src/tests/unit/markdownContentElsewhere.test.ts';
const ELSEWHERE_TOKENS = [
  { token: /\bmicromark\s*\(/, why: 'renders with the second parser' },
  { token: /\bmarkdownRenderer\s*\(/, why: "renders with the note's own markdown-it" },
  { token: /fixtures\/markdown-body-roundtrip/, why: 'reads the golden corpus' },
  { token: /\bTOOLBAR_CASES\b/, why: "reads every toolbar case's saved note" },
  { token: /saving a note that opens editable changes nothing another app shows/, why: 'checks a save changes nothing micromark shows' },
];

const INVARIANT_TEST = 'src/tests/unit/frontmatterInvariant.test.ts';
const NOTE_WRITER = 'src/renderer/lib/notes/noteWriter.ts';

/** Editor-body views: `code` (comments + strings blanked) and `text` (comments blanked); svelte = scripts only. */
function editorViews(ctx, cache, rel) {
  if (!cache.has(rel)) {
    const raw = ctx.read(rel);
    if (raw === null) cache.set(rel, null);
    else {
      const src = rel.endsWith('.svelte') ? scriptOnly(raw) : raw;
      cache.set(rel, { raw, code: blank(src), text: blank(src, { strings: false }) });
    }
  }
  return cache.get(rel);
}

/** Body spans of every `marker … => { … }` arrow (e.g. `$effect(`, `onUpdate:`). */
function arrowBodies(f, marker) {
  const spans = [];
  for (let at = f.code.indexOf(marker); at >= 0; at = f.code.indexOf(marker, at + marker.length)) {
    const arrow = f.code.indexOf('=>', at);
    const open = arrow < 0 ? -1 : f.code.indexOf('{', arrow);
    const close = open < 0 ? -1 : matchBrace(f.code, open, '{', '}');
    if (close > 0) spans.push({ start: open, end: close + 1 });
  }
  return spans;
}

/** Escape marker on the match line or the one above. */
function escapedAt(raw, index, tag) {
  const lines = raw.split('\n');
  const ln = lineAt(raw, index);
  return [lines[ln - 1], lines[ln - 2]].some((l) => l && l.includes(tag));
}

export const checks = [
  {
    id: 'no-bom-sniff',
    title: 'the BOM is only sniffed where raw disk bytes are seen',
    hint:
      'In-memory content is already BOM-stripped, so a sniff there is always false and the next save drops the BOM. ' +
      'Read notes through the note store (readNoteFresh). Escape: `// allow-bom-sniff: <reason>` (same or preceding line).',
    run(ctx) {
      const out = [];
      for (const rel of ctx.files(['src/renderer', 'src/main'], { ext: ['.ts', '.svelte', '.mjs'] })) {
        if (BOM_ALLOWED.has(rel)) continue;
        const raw = ctx.read(rel);
        const rawLines = raw.split(/\r?\n/);
        stripCommentsKeepLines(raw).split(/\r?\n/).forEach((line, i) => {
          if (/\/\/\s*allow-bom-sniff:\s*\S+/.test(`${rawLines[i - 1] ?? ''}\n${rawLines[i] ?? ''}`)) return;
          for (const [name, re] of BOM_PATTERNS) if (re.test(line)) out.push(fail(rel, i + 1, `[${name}] ${(rawLines[i] ?? '').trim()}`));
        });
      }
      return out;
    },
  },
  {
    id: 'single-fence-parser',
    title: 'only the fence parser finds where a frontmatter block starts and ends',
    hint:
      'Call splitFrontmatterFence / openingFenceEol (lib/notes/frontmatterFence.ts) instead of matching `---` yourself, ' +
      'so every reader and writer agrees on which bytes are frontmatter.',
    run(ctx) {
      const out = [];
      if (ctx.read(FENCE_PARSER) === null) out.push(fail(FENCE_PARSER, undefined, 'missing'));
      for (const rel of ctx.files(['src/renderer', 'src/main', 'src/shared'], { ext: ['.ts', '.svelte', '.mjs'] })) {
        if (rel === FENCE_PARSER) continue;
        const raw = ctx.read(rel);
        const rawLines = raw.split(/\r?\n/);
        stripCommentsKeepLines(raw).split(/\r?\n/).forEach((line, i) => {
          for (const [name, re] of FENCE_PATTERNS) if (re.test(line)) out.push(fail(rel, i + 1, `[${name}] ${(rawLines[i] ?? '').trim()}`));
        });
      }
      return out;
    },
  },
  {
    id: 'utf8-validated-read',
    title: 'reads validate UTF-8 and text writes refuse a recorded non-UTF-8 file',
    hint: "Decoding during fs.readFile replaces bad bytes with U+FFFD and the first save persists the damage.",
    run(ctx) {
      const out = [];
      const OPS = 'src/main/vault/fileOps.ts';
      const ops = ctx.read(OPS);
      if (ops === null) out.push(fail(OPS, undefined, 'file missing'));
      else {
        const code = blank(ops);
        const text = blank(ops, { strings: false });
        for (const fn of ['readFileWithCoherentStat']) {
          const b = functionBody(code, fn, { fnKeyword: true });
          if (!b) { out.push(fail(OPS, undefined, `${fn}() not found`)); continue; }
          const body = text.slice(b.start, b.end);
          if (/readFile\s*\([^)]*?,\s*(?:['"]utf-?8['"]|\{\s*encoding)/i.test(body)) out.push(fail(OPS, undefined, `${fn}() decodes during the read — read a Buffer`));
          if (fn === 'readFileWithCoherentStat' && !body.includes('isUtf8(')) out.push(fail(OPS, undefined, 'readFileWithCoherentStat() must validate with isUtf8(...)'));
        }
      }
      const IPC = 'src/main/ipc/vault.ipc.ts';
      const ipc = ctx.read(IPC);
      if (ipc === null) return [...out, fail(IPC, undefined, 'file missing')];
      const text = blank(ipc, { strings: false });
      const marks = [...text.matchAll(/ipcMain\.handle\s*\(/g)].map((m) => m.index);
      for (const channel of ['vault:write-file-text', 'vault:write-existing-file-text']) {
        const idx = marks.findIndex((s) => {
          const head = text.slice(s, s + 200);
          return head.includes(`'${channel}'`) || head.includes(`"${channel}"`);
        });
        if (idx < 0) { out.push(fail(IPC, undefined, `${channel} handler not found`)); continue; }
        if (!text.slice(marks[idx], marks[idx + 1] ?? text.length).includes('isRegisteredNonUtf8(')) {
          out.push(fail(IPC, undefined, `${channel} must refuse a recorded non-UTF-8 path (isRegisteredNonUtf8)`));
        }
      }
      return out;
    },
  },
  {
    id: 'eol-preservation',
    title: 'frontmatter rewrites and note writes keep the file’s line endings',
    hint: 'The CST engine emits LF; without re-applying the file eol a CRLF note flips (partly or wholly) to LF on edit.',
    run(ctx) {
      const out = [];
      for (const c of EOL_CHECKS) {
        const raw = ctx.read(c.file);
        if (raw === null) out.push(fail(c.file, undefined, 'file missing'));
        else out.push(...tokenChecks(c.file, stripComments(raw), c));
      }
      return out;
    },
  },
  {
    id: 'no-jsyaml',
    title: 'the `yaml` package is the only YAML parser in the app (no js-yaml / gray-matter anywhere)',
    hint:
      'js-yaml (also bundled in gray-matter) disagrees with `yaml` on dates, `<<`, `1_000`, `0b1010`… — that ' +
      'disagreement was the recurring corruption class. Use the `yaml` package; tests may keep js-yaml as an independent oracle.',
    run(ctx) {
      const out = [];
      const files = ctx.files(['src/renderer', 'src/main', 'src/shared'], { ext: ['.ts', '.svelte', '.mts', '.mjs'] });
      for (const rel of files) {
        ctx.read(rel).split(/\r?\n/).forEach((line, i) => {
          const lib = /(?:from|require\(|import\()\s*['"]js-yaml['"]/.test(line) ? 'js-yaml' : /(?:from|require\(|import\()\s*['"]gray-matter['"]/.test(line) ? 'gray-matter' : null;
          if (lib) out.push(fail(rel, i + 1, `imports ${lib}`));
        });
      }
      const pkg = JSON.parse(ctx.read('package.json') ?? '{}');
      for (const lib of ['js-yaml', 'gray-matter']) {
        if (pkg.dependencies?.[lib]) out.push(fail('package.json', undefined, `${lib} is a runtime dependency`));
      }
      if (files.length < 150) out.push(fail('src', undefined, `tripwire: only ${files.length} files scanned (expected >= 150)`));
      return out;
    },
  },
  {
    id: 'one-markdown-parser',
    title: 'markdown-it is the only Markdown parser in the app (no marked / micromark / remark / unified / mdast / commonmark / @tiptap/markdown)',
    hint:
      'markdown-it is the one Markdown parser in the app; a second one reads notes differently (the YAML lesson). ' +
      'Tests may use others as oracles.',
    run(ctx) {
      const out = [];
      const files = ctx.files(['src/renderer', 'src/main', 'src/shared'], { ext: ['.ts', '.svelte', '.mts', '.mjs'] });
      for (const rel of files) {
        const raw = ctx.read(rel);
        const rawLines = raw.split(/\r?\n/);
        stripCommentsKeepLines(raw).split(/\r?\n/).forEach((line, i) => {
          for (const m of line.matchAll(IMPORT_SPECIFIER)) {
            if (OTHER_MARKDOWN_PARSER.test(m[2])) out.push(fail(rel, i + 1, `imports ${m[2]}: ${(rawLines[i] ?? '').trim()}`));
          }
        });
      }
      const pkg = JSON.parse(ctx.read('package.json') ?? '{}');
      for (const field of ['dependencies', 'optionalDependencies']) {
        for (const name of Object.keys(pkg[field] ?? {})) {
          if (OTHER_MARKDOWN_PARSER.test(name)) out.push(fail('package.json', undefined, `${name} is a runtime dependency (${field})`));
        }
      }
      if (files.length < 150) out.push(fail('src', undefined, `tripwire: only ${files.length} files scanned (expected >= 150)`));
      return out;
    },
  },
  {
    id: 'editor-body-discipline',
    title: 'editor load / reload / unmount never turns an unedited note into a write or an undo step',
    hint: 'Each rule pins the mechanism behind a behaviour proven in src/tests/component/.',
    run(ctx) {
      const out = [];
      const cache = new Map();
      const view = (rel) => {
        const f = editorViews(ctx, cache, rel);
        if (!f) out.push(fail(rel, undefined, 'required file missing'));
        return f;
      };
      const slice = (f, s) => f.text.slice(s.start, s.end);
      const SYNC = 'src/renderer/lib/editor/markdownSync.ts';
      const VIEW = 'src/renderer/lib/editor/noteEditorView.ts';
      const STORE = 'src/renderer/stores/notes.svelte.ts';
      const DOC_EDITOR = 'src/renderer/components/boards/DocumentEditor.svelte';
      const TEXT_TILE = 'src/renderer/components/tiles/TextTile.svelte';
      const TASK_CREATION = 'src/renderer/lib/tasklist/taskCreation.ts';
      const TOOLBAR = 'src/renderer/lib/editor/toolbarConfig.ts';

      // A: a load is a history boundary, and every load goes through loadMarkdownIntoEditor.
      const sync = view(SYNC);
      if (sync) {
        const b = functionBody(sync.code, 'loadMarkdownIntoEditor', { fnKeyword: true });
        if (!b) out.push(fail(SYNC, undefined, 'loadMarkdownIntoEditor not found'));
        else {
          const body = slice(sync, b);
          if (!/setMeta\(\s*['"]addToHistory['"]\s*,\s*false\s*\)/.test(body)) out.push(fail(SYNC, undefined, "loadMarkdownIntoEditor must setMeta('addToHistory', false)"));
          if (!/\bresetEditorHistory\s*\(/.test(body)) out.push(fail(SYNC, undefined, 'loadMarkdownIntoEditor must call resetEditorHistory('));
        }
      }
      const rendererFiles = ctx.files('src/renderer', { ext: ['.ts', '.svelte'] });
      for (const rel of rendererFiles) {
        const g = editorViews(ctx, cache, rel);
        if (rel !== SYNC) {
          for (const m of g.code.matchAll(/\.setContent\s*\(/g)) {
            if (!escapedAt(g.raw, m.index, 'allow-raw-setcontent:')) out.push(fail(rel, lineAt(g.raw, m.index), 'raw .setContent( — load through loadMarkdownIntoEditor'));
          }
        }
        // C: a body-only model body is never re-parsed as a whole file.
        for (const m of g.code.matchAll(/\bparseMarkdownFile\s*\(\s*(?:existing|docState|body|m\.body|model\.body|note\.body)\b/g)) {
          if (!escapedAt(g.raw, m.index, 'allow-body-reparse:')) out.push(fail(rel, lineAt(g.raw, m.index), 're-parses a body-only model body (would strip a leading --- rule pair)'));
        }
      }
      const tc = view(TASK_CREATION);
      if (tc && /\bbody\s*:\s*seedBody\b/.test(tc.code)) out.push(fail(TASK_CREATION, undefined, 'seeds a note model with the full seed file as its body'));

      // B: a load into the editor is not an edit; a view never reloads its own
      // keystrokes; it never loads mid-composition or over unserialised typing.
      const v = view(VIEW);
      if (v) {
        const need = (fn, re, why) => {
          const b = functionBody(v.code, fn);
          if (!b) out.push(fail(VIEW, undefined, `${fn}() not found`));
          else if (!re.test(slice(v, b))) out.push(fail(VIEW, undefined, `${fn}(): ${why}`));
        };
        need('edited', /if\s*\(\s*this\.loading\s*\)\s*return\s+false/, 'an update caused by loading the model is not a user edit');
        need('serialize', /if\s*\(\s*!\s*this\.unserialised\b/, 'serialises only keystrokes typed since the last serialise (an unedited note is never set)');
        need('sync', /bodySource\s*===\s*this\.viewId/, "the view never reloads its own body (caret and undo history stay put)");
        need('sync', /this\.unserialised\s*\|\|\s*opts\.composing/, 'never loads over unserialised keystrokes or mid-IME composition');
        need('sync', /loadMarkdownIntoEditor\s*\([^)]*preserveSelection/, 'a reload keeps the caret where it was');
        need('close', /this\.serialize\s*\(\s*\)/, 'unmount keeps unsaved keystrokes (and writes nothing else)');
      }
      const st = view(STORE);
      if (st) {
        const b = functionBody(st.code, 'setBody');
        if (!b) out.push(fail(STORE, undefined, 'setBody() not found'));
        else if (!/m\.body\s*===\s*markdown\s*&&\s*!\s*m\.hasUnsavedBody\)\s*return/.test(slice(st, b))) {
          out.push(fail(STORE, undefined, 'setBody() must not queue a body identical to the one shown'));
        }
      }
      for (const [rel, f] of [[TEXT_TILE, view(TEXT_TILE)], [DOC_EDITOR, view(DOC_EDITOR)]]) {
        if (!f) continue;
        const upd = arrowBodies(f, 'onUpdate:')[0];
        if (!upd || !/\bview\.edited\s*\(/.test(slice(f, upd)) || /\bnoteStore\b/.test(slice(f, upd))) {
          out.push(fail(rel, undefined, 'onUpdate must only report the edit to the view (view.edited()), never write'));
        }
        const follow = arrowBodies(f, '$effect(').find((s) => /view\.sync\s*\(/.test(slice(f, s)));
        if (!follow || !/\bisComposing\b/.test(slice(f, follow))) out.push(fail(rel, undefined, 'the follow $effect (view.sync) must pass isComposing'));
        const destroy = arrowBodies(f, 'onDestroy(')[0];
        if (!destroy || !/\bview\.close\s*\(/.test(slice(f, destroy))) out.push(fail(rel, undefined, 'onDestroy must close the view (view.close())'));
        // F: a lossy (read-only) note is truly non-editable.
        const eff = arrowBodies(f, '$effect(').find((s) => /closeDrainGate\.draining/.test(slice(f, s)));
        if (!eff) out.push(fail(rel, undefined, 'the editability $effect (closeDrainGate.draining) not found'));
        else if (!/\breadOnly\b/.test(slice(f, eff))) out.push(fail(rel, undefined, 'the editability $effect must also freeze on readOnly'));
      }
      const tb = view(TOOLBAR);
      if (tb && !/\bisEditable\b/.test(tb.code)) out.push(fail(TOOLBAR, undefined, 'toolbar commands must refuse a non-editable editor (isEditable)'));
      return out;
    },
  },
  {
    id: 'markdown-body-roundtrip',
    title: 'the golden-corpus body round-trip test, the second-parser check and the editor integration suite stay in place',
    hint:
      'These tests pin the bytes an unedited note is written back with, and that those bytes read the same in another ' +
      'parser. Restore them; re-baseline an .expected.md only with a byte-level justification.',
    run(ctx) {
      const out = [];
      const test = ctx.read(ROUNDTRIP_TEST);
      if (test === null) out.push(fail(ROUNDTRIP_TEST, undefined, 'missing'));
      else {
        out.push(...tokenChecks(ROUNDTRIP_TEST, test, { required: ROUNDTRIP_TOKENS }));
        if (SKIPPED_TEST_RE.test(test)) out.push(fail(ROUNDTRIP_TEST, undefined, 'contains a skipped/todo test'));
      }
      if (!ctx.exists(ROUNDTRIP_FIXTURES)) out.push(fail(ROUNDTRIP_FIXTURES, undefined, 'missing'));
      else {
        const sources = ctx
          .files(ROUNDTRIP_FIXTURES, { ext: ['.md'], recursive: false })
          .map((rel) => rel.slice(ROUNDTRIP_FIXTURES.length + 1))
          .filter((f) => !f.includes('.expected'));
        if (sources.length < ROUNDTRIP_MIN_FIXTURES) out.push(fail(ROUNDTRIP_FIXTURES, undefined, `only ${sources.length} source fixtures (< ${ROUNDTRIP_MIN_FIXTURES})`));
        for (const f of ROUNDTRIP_REQUIRED_FIXTURES) if (!sources.includes(f)) out.push(fail(`${ROUNDTRIP_FIXTURES}/${f}`, undefined, 'missing'));
      }
      const elsewhere = ctx.read(ELSEWHERE_TEST);
      if (elsewhere === null) out.push(fail(ELSEWHERE_TEST, undefined, 'missing (a saved note reads the same in another parser)'));
      else {
        const src = stripComments(elsewhere);
        out.push(...tokenChecks(ELSEWHERE_TEST, src, { required: ELSEWHERE_TOKENS }));
        if (SKIPPED_TEST_RE.test(src) || /\bit\.only\b|\bdescribe\.only\b/.test(src)) {
          out.push(fail(ELSEWHERE_TEST, undefined, 'contains a skipped / focused / todo test'));
        }
      }
      for (const s of EDITOR_SUITE) {
        const raw = ctx.read(s.file);
        if (raw === null) { out.push(fail(s.file, undefined, 'missing (editor integration suite)')); continue; }
        const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
        out.push(...tokenChecks(s.file, src, s));
        if (SKIPPED_TEST_RE.test(src)) out.push(fail(s.file, undefined, 'contains a skipped/todo test'));
      }
      return out;
    },
  },
  {
    id: 'toolbar-formatting-saved',
    title: "every formatting toolbar command has a save → reload case (no button makes formatting the file can't hold)",
    hint:
      'Add a case to src/tests/helpers/toolbarCases.ts that runs the command; toolbarFormattingRoundTrip.test.ts saves, ' +
      'reloads and compares every case. If the reload differs or is flagged lossy, give the formatting a Markdown or HTML ' +
      'form first (see blockLayout.ts).',
    run(ctx) {
      const out = [];
      const toolbar = ctx.read(TOOLBAR_CONFIG);
      const toolbarTest = ctx.read(TOOLBAR_ROUNDTRIP_TEST);
      const rawCases = ctx.read(TOOLBAR_CASES);
      if (toolbar === null) out.push(fail(TOOLBAR_CONFIG, undefined, 'missing'));
      if (toolbarTest === null) out.push(fail(TOOLBAR_ROUNDTRIP_TEST, undefined, 'missing (toolbar save → reload suite)'));
      if (rawCases === null) out.push(fail(TOOLBAR_CASES, undefined, 'missing (the toolbar cases)'));
      if (toolbar !== null && toolbarTest !== null && rawCases !== null) {
        const cases = stripComments(rawCases);
        out.push(...tokenChecks(TOOLBAR_ROUNDTRIP_TEST, toolbarTest, {
          required: [
            { token: /\bcreateTiptapEditor\s*\(/, why: 'drives the real editor factory' },
            { token: /\bloadMarkdownIntoEditor\s*\(/, why: 'reloads through the production load path' },
            { token: /expect\(lossy\)\.toBe\(false\)/, why: 'a reloaded note must not open read-only' },
            { token: /for\s*\(\s*const\s+\w+\s+of\s+TOOLBAR_CASES\s*\)/, why: 'runs every toolbar case' },
            { token: /from\s+['"]\.\.\/helpers\/toolbarCases['"]/, why: 'reads the cases from helpers/toolbarCases.ts' },
          ],
        }));
        if (SKIPPED_TEST_RE.test(toolbarTest)) out.push(fail(TOOLBAR_ROUNDTRIP_TEST, undefined, 'contains a skipped/todo test'));
        if (SKIPPED_TEST_RE.test(cases)) out.push(fail(TOOLBAR_CASES, undefined, 'contains a skipped/todo test'));
        const commands = new Set();
        for (const m of toolbar.matchAll(/chainIfEditable\(\)\?\.focus\(\)((?:\.\w+\([^)]*\))+)\.run\(\)/g)) {
          for (const c of m[1].matchAll(/\.(\w+)\(/g)) commands.add(c[1]);
        }
        if (commands.size === 0) out.push(fail(TOOLBAR_CONFIG, undefined, 'found no toolbar commands to check (did the chain shape change?)'));
        for (const name of commands) {
          if (!new RegExp(`\\.${name}\\(`).test(cases)) {
            out.push(fail(TOOLBAR_CASES, undefined, `no save → reload case runs the toolbar command ${name}()`));
          }
        }
      }
      return out;
    },
  },
  {
    id: 'editor-round-trip-property',
    title: 'the editor round-trip property test exists, runs every case, compares documents, and generates at least 500 documents',
    hint:
      'editorRoundTripProperty.test.ts generates documents from the editor schema and checks each is written in a form ' +
      'that reads back (not lossy, same bytes on the next save, the same document as shownDocument sees it: a note that ' +
      'reopens editable but different is the silent case). Keep NUM_RUNS >= 500 and nothing skipped; fix the ' +
      'serialiser a counter-example points at and keep it as a named case in markdownBodyRoundTrip.test.ts.',
    run(ctx) {
      const raw = ctx.read(PROPERTY_TEST);
      if (raw === null) return [fail(PROPERTY_TEST, undefined, 'missing (editor round-trip property test)')];
      const src = stripComments(raw);
      const out = tokenChecks(PROPERTY_TEST, src, {
        required: [
          { token: /\bfc\.assert\s*\(/, why: 'runs a fast-check property' },
          { token: /\bcreateTiptapEditor\s*\(/, why: 'drives the real editor factory' },
          { token: /\bloadMarkdownIntoEditor\s*\(/, why: 'reads back through the production load path' },
          { token: /\bnumRuns:\s*NUM_RUNS\b/, why: 'the run count is NUM_RUNS' },
          { token: /\bshownDocument\s*\(\s*rt\.doc\s*\)/, why: 'compares the read-back document, not only the Markdown' },
        ],
      });
      if (SKIPPED_TEST_RE.test(src) || /\bit\.only\b|\bdescribe\.only\b/.test(src)) {
        out.push(fail(PROPERTY_TEST, undefined, 'contains a skipped / focused / todo test'));
      }
      const runs = /\bconst\s+NUM_RUNS\s*=\s*([\d_]+)\s*;/.exec(src);
      const n = runs ? Number(runs[1].replace(/_/g, '')) : 0;
      if (n < 500) out.push(fail(PROPERTY_TEST, undefined, `NUM_RUNS is ${runs ? n : 'not a number literal'} (expected >= 500)`));
      return out;
    },
  },
  {
    id: 'frontmatter-parse-preserved',
    title: 'the note writer checks a write keeps a parsing frontmatter block parsing before it sends the bytes',
    hint:
      'A tokenizer gap (a wrapped `tags:` flow list, say) can turn valid YAML invalid vault-wide: every view loses the ' +
      "note's properties. Call breaksFrontmatter(fresh, next) and refuse before each note write IPC.",
    run(ctx) {
      const raw = ctx.read(NOTE_WRITER);
      if (raw === null) return [fail(NOTE_WRITER, undefined, 'missing')];
      const code = blank(raw);
      const withStrings = blank(raw, { strings: false });
      const out = [];
      // The IPC is sent only from writeOver(); each writeOver( call is then a note write.
      const sender = functionBody(code, 'writeOver', { fnKeyword: true });
      if (!sender) out.push(fail(NOTE_WRITER, undefined, 'no writeOver() definition found'));
      const ipcAt = [...withStrings.matchAll(/['"]vault:write-existing-file-text['"]/g)].map((m) => m.index);
      if (ipcAt.length === 0) out.push(fail(NOTE_WRITER, undefined, 'tripwire: no vault:write-existing-file-text invoke found'));
      for (const at of ipcAt) {
        if (sender && !(sender.start <= at && at < sender.end)) {
          out.push(fail(NOTE_WRITER, lineAt(raw, at), 'a note write IPC outside writeOver(): send it through writeOver'));
        }
      }
      const writes = [...code.matchAll(/\bwriteOver\s*\(/g)]
        .map((m) => m.index)
        .filter((at) => !/function\s+$/.test(code.slice(Math.max(0, at - 20), at)));
      if (writes.length === 0) out.push(fail(NOTE_WRITER, undefined, 'tripwire: no writeOver( call found'));
      const guarded = [];
      for (const name of ['writePending', 'transform']) {
        const fn = functionBody(code, name);
        if (!fn) out.push(fail(NOTE_WRITER, undefined, `no ${name}() definition found`));
        else guarded.push(fn);
      }
      for (const at of writes) {
        const fn = guarded.find((f) => f.start <= at && at < f.end);
        if (!fn) {
          out.push(fail(NOTE_WRITER, lineAt(raw, at), 'a writeOver( call outside writePending / transform: guard it and add it to this check'));
        } else if (!/\bbreaksFrontmatter\s*\(/.test(withStrings.slice(fn.start, at))) {
          out.push(fail(NOTE_WRITER, lineAt(raw, at), 'this note write is not preceded by a breaksFrontmatter(…) check'));
        }
      }
      return out;
    },
  },
  {
    // The suite itself runs in test:unit:strict; this pins that it can't be removed or hollowed out.
    id: 'frontmatter-invariant',
    title: 'the frontmatter data-loss corpus + fuzz suite stays in place and un-skipped',
    hint: 'This suite is the "no write path drops, corrupts or re-bodies frontmatter" net. Restore it rather than skipping it.',
    run(ctx) {
      const src = ctx.read(INVARIANT_TEST);
      if (src === null) return [fail(INVARIANT_TEST, undefined, 'missing')];
      const out = tokenChecks(INVARIANT_TEST, src, {
        required: [
          { token: /from\s+['"]fast-check['"]/, why: 'imports the fast-check fuzzer' },
          { token: /\bfc\.assert\s*\(/, why: 'runs fuzz properties' },
          { token: /frontmatter data-loss invariant — hostile corpus/, why: 'the hostile-corpus suite' },
          { token: /frontmatter data-loss invariant — fuzz/, why: 'the fuzz suite' },
        ],
      });
      if (/\b(?:it|describe|test)\.(?:skip|only|todo)\b/.test(src)) out.push(fail(INVARIANT_TEST, undefined, 'contains a skipped / focused / todo test'));
      const cases = (src.match(/\bit\s*\(/g) ?? []).length;
      if (cases < 30) out.push(fail(INVARIANT_TEST, undefined, `only ${cases} test cases (expected >= 30) — the suite was hollowed out`));
      return out;
    },
  },
];

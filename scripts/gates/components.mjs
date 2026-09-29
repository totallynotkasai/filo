// Svelte component / UI ratchets.
import {
  fail, blank, blankMatches, blankHtmlComments, scriptBlocks, scriptOnly, matchBrace, lineAt, markerNear,
  stripCommentsKeepOffsets,
} from './lib.mjs';

const COMPONENTS = 'src/renderer/components';

/**
 * The top-level arguments of the call whose `(` is at `open`, each with its
 * offset: commas inside nested brackets and string literals don't split.
 */
function callArgs(code, open) {
  const args = [];
  let depth = 0;
  let quote = '';
  let start = open + 1;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (--depth === 0) {
        args.push({ start, text: code.slice(start, i) });
        return args;
      }
    } else if (c === ',' && depth === 1) {
      args.push({ start, text: code.slice(start, i) });
      start = i + 1;
    }
  }
  return args;
}

/** Brace depth before each char of already-blanked code. */
function depthMap(code) {
  const depth = new Array(code.length);
  let d = 0;
  for (let i = 0; i < code.length; i++) {
    depth[i] = d;
    if (code[i] === '{') d++;
    else if (code[i] === '}') d = Math.max(0, d - 1);
  }
  return depth;
}

/** Every teardown region, with its offset: `onDestroy(…)` bodies and `return () => …` cleanups. */
function teardownRegions(code) {
  const regions = [];
  for (const m of code.matchAll(/\bonDestroy\s*\(/g)) {
    const paren = code.indexOf('(', m.index);
    const close = matchBrace(code, paren, '(', ')');
    regions.push({ start: paren, text: code.slice(paren, close < 0 ? code.length : close + 1) });
  }
  for (const m of code.matchAll(/\breturn\s*\(\s*\)\s*=>/g)) {
    let j = m.index + m[0].length;
    while (j < code.length && /\s/.test(code[j])) j++;
    if (code[j] === '{') {
      const close = matchBrace(code, j, '{', '}');
      regions.push({ start: j, text: code.slice(j, close < 0 ? code.length : close + 1) });
    } else {
      const semi = code.indexOf(';', j);
      regions.push({ start: j, text: code.slice(j, semi === -1 ? Math.min(code.length, j + 200) : semi) });
    }
  }
  return regions;
}

/** Text of every teardown region. */
function teardownText(code) {
  return teardownRegions(code).map((r) => '\n' + r.text).join('');
}

// `$derived(<literal>)` / `$derived(() => <literal>)` forms that can never change.
const DEAD_LITERAL_RE = new RegExp(
  '^(true|false|null|undefined' +
    '|-?(0[xX][0-9a-fA-F]+|\\d+(\\.\\d+)?([eE][+-]?\\d+)?|Infinity|NaN)' +
    "|'[^'\\\\]*'|\"[^\"\\\\]*\"" +
    '|\\[\\s*\\]|\\{\\s*\\})$',
);

/** The `$derived(...)` argument text, balancing parens and skipping strings / comments. */
function derivedArg(src, open) {
  let depth = 1;
  let i = open + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); i = nl === -1 ? src.length : nl + 1; continue; }
    if (ch === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e === -1 ? src.length : e + 2; continue; }
    if (ch === "'" || ch === '"' || ch === '`') {
      const q = ch;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === q) { i++; break; }
        if (q === '`' && src[i] === '$' && src[i + 1] === '{') {
          let bd = 1;
          i += 2;
          while (i < src.length && bd > 0) {
            if (src[i] === '{') bd++;
            else if (src[i] === '}') bd--;
            i++;
          }
          continue;
        }
        i++;
      }
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return src.slice(open + 1, i);
    i++;
  }
  return null;
}

// Pane-scope targets: a split pane renders these twice, so a GLOBAL facade read
// binds both panes to whichever one is active.
const PANE_SCOPE_TARGETS = [
  {
    file: 'src/renderer/components/boards/DocumentEditor.svelte',
    svelte: true,
    forbidden: /\btabStore\s*\.\s*activeTab(?:Id)?\b/g,
    allow: /\/\/\s*allow-global-tab:\s*\S+/,
    message: 'reads the GLOBAL active tab — derive the doc from the `tabId` prop',
  },
  {
    file: 'src/renderer/lib/canvas/dragDrop.ts',
    svelte: false,
    forbidden: /\b(?:boardStore|canvasStore)\b/g,
    allow: /\/\/\s*allow-global-(?:board|canvas)-facade:\s*\S+/,
    message: 'reads a GLOBAL board/canvas facade — use the pane `scope.board` / `scope.canvas`',
  },
];

// CSS custom properties: definitions are collected generously, no-fallback uses precisely.
const CSS_DEF_PROP = /(?<![\w-])--([A-Za-z_][\w-]*)\s*:/g;
const CSS_DEF_STYLE_DIRECTIVE = /\bstyle:--([A-Za-z_][\w-]*)/g;
const CSS_DEF_SETPROP = /setProperty\(\s*['"`]--([A-Za-z_][\w-]*)/g;
const CSS_USE_NOFALLBACK = /var\(\s*--([A-Za-z_][\w-]*)\s*\)/g;
const CSS_VAR_ALLOWLIST = new Map(); // token → reason, for tokens defined outside src/
const CSS_MIN_DEFINED = 80;

// Pointer capture that drives an open spatial batch must also handle cancel.
const stripMarkupComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

export const checks = [
  {
    id: 'component-timer-cleanup',
    title: 'component-scope timer handles are cleared on teardown',
    hint:
      'An uncleared timer fires after unmount (e.g. on vault swap) against the new vault/board. ' +
      'Clear it in onDestroy or an $effect cleanup, or annotate `// allow-uncleared-timer: <reason>`.',
    run(ctx) {
      const out = [];
      const decl = /\b(?:let|const|var)\s+(\w+)\s*:\s*ReturnType<typeof\s+(?:setTimeout|setInterval)>/g;
      for (const rel of ctx.files(COMPONENTS, { ext: ['.svelte'] })) {
        const raw = ctx.read(rel);
        const rawLines = raw.split(/\r?\n/);
        for (const block of scriptBlocks(raw)) {
          const code = blank(block.content);
          const depth = depthMap(code);
          const teardown = teardownText(code);
          for (const m of code.matchAll(decl)) {
            if (depth[m.index] !== 0) continue;
            const line = lineAt(raw, block.start + m.index);
            if (markerNear(rawLines, line - 1, /\/\/\s*allow-uncleared-timer:\s*\S+/)) continue;
            if (!new RegExp(`clear(?:Timeout|Interval)\\s*\\(\\s*${m[1]}\\b`).test(teardown)) {
              out.push(fail(rel, line, `\`${m[1]}\` is never cleared in onDestroy / an $effect cleanup`));
            }
          }
        }
      }
      return out;
    },
  },
  {
    id: 'no-dead-flush',
    title: 'component-scope `flush*` functions are actually called',
    hint:
      'A defined-but-uncalled flusher makes the save path look wired when it is not. ' +
      'Wire it up or delete it; if intentional annotate `// allow-dead-flush: <reason>`.',
    run(ctx) {
      const out = [];
      const def = /\b(?:async\s+)?function\s+(flush\w*)\s*\(/g;
      for (const rel of ctx.files(COMPONENTS, { ext: ['.svelte'] })) {
        const raw = ctx.read(rel);
        const rawLines = raw.split(/\r?\n/);
        const blocks = scriptBlocks(raw);
        const allScript = blocks.map((b) => blank(b.content)).join('\n');
        const markup = raw.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (m) => ' '.repeat(m.length));
        for (const block of blocks) {
          const code = blank(block.content);
          const depth = depthMap(code);
          for (const m of code.matchAll(def)) {
            if (depth[m.index] !== 0) continue;
            const line = lineAt(raw, block.start + m.index);
            if (markerNear(rawLines, line - 1, /\/\/\s*allow-dead-flush:\s*\S+/)) continue;
            const word = new RegExp(`\\b${m[1]}\\b`, 'g');
            const uses = (allScript.match(word) ?? []).length;
            if (uses < 2 && !new RegExp(`\\b${m[1]}\\b`).test(markup)) {
              out.push(fail(rel, line, `\`${m[1]}\` is never referenced (dead flush path)`));
            }
          }
        }
      }
      return out;
    },
  },
  {
    id: 'dead-derived',
    title: 'no `$derived(<constant literal>)`',
    hint: 'A constant $derived tracks nothing — use a const or the real reactive expression, or `// allow-dead-derived: <reason>`.',
    run(ctx) {
      const out = [];
      const intro = /\$derived(?:\.by)?(?:\s*<[^>]+>)?\s*\(/g;
      for (const rel of ctx.files('src/renderer', { ext: ['.svelte', '.svelte.ts'] })) {
        const raw = ctx.read(rel);
        const src = blank(raw, { strings: false });
        const rawLines = raw.split('\n');
        for (const m of src.matchAll(intro)) {
          const arg = derivedArg(src, m.index + m[0].length - 1);
          if (arg === null) continue;
          const t = arg.trim();
          const arrow = t.match(/^\(\s*\)\s*=>\s*([\s\S]+)$/);
          const dead = DEAD_LITERAL_RE.test(t) ? t : arrow && DEAD_LITERAL_RE.test(arrow[1].trim()) ? `() => ${arrow[1].trim()}` : null;
          if (!dead) continue;
          const line = lineAt(src, m.index);
          if (markerNear(rawLines, line - 1, '// allow-dead-derived:')) continue;
          out.push(fail(rel, line, `\`$derived(${dead})\` never changes`));
        }
      }
      return out;
    },
  },
  {
    id: 'document-editor-pane-scoped',
    title: 'DocumentEditor / OS file drop never read the global active tab or board',
    hint: 'Components rendered once per split pane must use their own pane scope, not the globally active one.',
    run(ctx) {
      const out = [];
      for (const t of PANE_SCOPE_TARGETS) {
        const raw = ctx.read(t.file);
        if (raw === null) { out.push(fail(t.file, undefined, 'target file missing — re-point the check')); continue; }
        const rawLines = raw.split(/\r?\n/);
        const scanned = t.svelte
          ? blankHtmlComments(raw).replace(
              /(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi,
              (_all, open, body, close) => open + blank(body) + close,
            )
          : blank(raw);
        for (const m of scanned.matchAll(t.forbidden)) {
          const line = lineAt(raw, m.index);
          if (markerNear(rawLines, line - 1, t.allow)) continue;
          out.push(fail(t.file, line, `${t.message}: ${(rawLines[line - 1] ?? '').trim()}`));
        }
      }
      return out;
    },
  },
  {
    id: 'pointer-capture-cleanup',
    title: 'pointer capture that opens a spatial batch also handles pointercancel',
    hint:
      'Without a cancel handler a native pointercancel leaves the spatial batch open (rendering freezes) ' +
      'and the drag flag stuck. Escape: `// allow-pointer-capture-leak: <reason>`.',
    run(ctx) {
      const out = [];
      let captureFiles = 0;
      let comboFiles = 0;
      for (const rel of ctx.files('src/renderer', { ext: ['.ts', '.svelte'] })) {
        const raw = ctx.read(rel);
        const code = stripMarkupComments(raw);
        if (!/setPointerCapture\s*\(/.test(code)) continue;
        captureFiles++;
        if (!/\bbeginBatch\s*\(/.test(code)) continue;
        comboFiles++;
        if (/\/\/\s*allow-pointer-capture-leak:\s*\S+/.test(raw)) continue;
        if (!/pointercancel|lostpointercapture/i.test(code)) {
          out.push(fail(rel, undefined, 'captures the pointer and opens beginBatch() but binds no pointercancel / lostpointercapture'));
        }
      }
      if (captureFiles < 10) out.push(fail('src/renderer', undefined, `tripwire: only ${captureFiles} setPointerCapture files (expected >= 10) — pattern went stale`));
      if (comboFiles < 2) out.push(fail('src/renderer', undefined, `tripwire: only ${comboFiles} capture+beginBatch files (expected >= 2) — pattern went stale`));

      const FRAME = 'src/renderer/components/frames/Frame.svelte';
      const frameRaw = ctx.read(FRAME);
      if (frameRaw === null) return [...out, fail(FRAME, undefined, 'required file missing')];
      const frame = stripMarkupComments(frameRaw);
      if (!/onpointercancel\s*=\s*\{/.test(frame)) out.push(fail(FRAME, undefined, 'missing an `onpointercancel={…}` binding'));
      if (!/onlostpointercapture\s*=\s*\{/.test(frame)) out.push(fail(FRAME, undefined, 'missing an `onlostpointercapture={…}` binding'));
      const endBatches = (frame.match(/spatialStore\.endBatch\s*\(/g) ?? []).length;
      if (endBatches < 2) {
        out.push(fail(FRAME, undefined, `only ${endBatches} spatialStore.endBatch( site(s); need the drag-end handler AND the unmount teardown`));
      }
      return out;
    },
  },
  {
    id: 'zindex-literals',
    title: 'global-layer z-index values (>= 1000) come from var(--z-*) tokens',
    hint: 'Use a `var(--z-*)` token from src/css/style.css, or annotate the line with `allow-zindex: <reason>`.',
    run(ctx) {
      const out = [];
      for (const rel of ctx.files('src/renderer', { ext: ['.svelte'] })) {
        ctx.read(rel).split('\n').forEach((line, i) => {
          if (line.includes('allow-zindex:')) return;
          for (const m of line.matchAll(/z-index:\s*(\d+)/g)) {
            if (parseInt(m[1], 10) >= 1000) out.push(fail(rel, i + 1, `z-index: ${m[1]} literal`));
          }
        });
      }
      return out;
    },
  },
  {
    id: 'css-vars',
    title: 'every no-fallback var(--x) refers to a defined custom property',
    hint: 'An undefined var() with no fallback renders to nothing. Use a real token or add a fallback.',
    run(ctx) {
      const out = [];
      const css = ctx.files('src', { ext: ['.css'] });
      const svelte = ctx.files('src', { ext: ['.svelte'] });
      const ts = ctx.files('src', { ext: ['.ts'] });
      const defined = new Set();
      const collect = (text, re) => { for (const m of text.matchAll(re)) defined.add(m[1]); };
      for (const rel of css) collect(ctx.read(rel), CSS_DEF_PROP);
      for (const rel of svelte) {
        const raw = ctx.read(rel);
        collect(raw, CSS_DEF_PROP);
        collect(raw, CSS_DEF_STYLE_DIRECTIVE);
        collect(raw, CSS_DEF_SETPROP);
      }
      for (const rel of ts) collect(ctx.read(rel), CSS_DEF_SETPROP);

      const blockComments = (s) => blankMatches(s, /\/\*[\s\S]*?\*\//g);
      const scan = (rel, text) => {
        for (const m of text.matchAll(CSS_USE_NOFALLBACK)) {
          if (defined.has(m[1]) || CSS_VAR_ALLOWLIST.has(`--${m[1]}`)) continue;
          out.push(fail(rel, lineAt(text, m.index), `var(--${m[1]}) has no fallback and --${m[1]} is defined nowhere`));
        }
      };
      for (const rel of css) scan(rel, blockComments(ctx.read(rel)));
      for (const rel of svelte) {
        const noScripts = blankMatches(ctx.read(rel), /<script[\s\S]*?<\/script>/gi);
        scan(rel, blockComments(blankHtmlComments(noScripts)));
      }
      if (defined.size < CSS_MIN_DEFINED) {
        out.push(fail('src', undefined, `tripwire: only ${defined.size} custom properties defined (expected >= ${CSS_MIN_DEFINED}) — collectors went stale`));
      }
      return out;
    },
  },
  {
    id: 'focus-trap-release',
    title: 'every focus trap has a fallbackFocus and is released in a teardown, whatever the host state',
    hint:
      'All traps share focus-trap\'s global stack. A trap that is never deactivated (or whose container has ' +
      'no tabbable node and no fallbackFocus) throws on the next Tab or click anywhere in the app. Pass ' +
      '`fallbackFocus: <container>`, call `safeDeactivateTrap(trap)` from an effect cleanup, and never pass `host:`.',
    run(ctx) {
      const out = [];
      let traps = 0;
      for (const rel of ctx.files('src/renderer', { ext: ['.ts', '.svelte'] })) {
        const raw = ctx.read(rel);
        const code = blank(rel.endsWith('.svelte') ? scriptOnly(raw) : raw);
        for (const m of code.matchAll(/\bcreateFocusTrap\s*\(/g)) {
          traps++;
          const open = m.index + m[0].length - 1;
          const close = matchBrace(code, open, '(', ')');
          const args = code.slice(open, close < 0 ? code.length : close + 1);
          if (!/\bfallbackFocus\s*:/.test(args)) {
            out.push(fail(rel, lineAt(raw, m.index), 'createFocusTrap( without `fallbackFocus` — Tab throws once nothing inside is tabbable'));
          }
        }
        for (const m of code.matchAll(/\bsafeDeactivateTrap\s*\(/g)) {
          const open = m.index + m[0].length - 1;
          const close = matchBrace(code, open, '(', ')');
          const args = code.slice(open, close < 0 ? code.length : close + 1);
          if (/\bhost\s*:/.test(args)) {
            out.push(fail(rel, lineAt(raw, m.index), 'safeDeactivateTrap( with `host:` — a detached host must still be deactivated'));
          }
        }
        if (/\bcreateFocusTrap\s*\(/.test(code) && !/\bsafeDeactivateTrap\s*\(/.test(teardownText(code))) {
          out.push(fail(rel, undefined, 'creates a focus trap but no teardown (`return () => …` / onDestroy) calls safeDeactivateTrap'));
        }
      }
      if (traps < 10) out.push(fail('src/renderer', undefined, `tripwire: only ${traps} createFocusTrap( calls (expected >= 10) — pattern went stale`));
      return out;
    },
  },
  {
    id: 'views-read-note-store',
    title: 'views read notes from the note store; nothing keeps its own copy of a note',
    hint:
      'Every view of a note shares its one NoteModel (noteStore.acquire / get / frontmatter). A second copy — ' +
      'a document store, a component parsing the file itself, a component talking to the writer — is how two ' +
      'views came to disagree and the wrong one won.',
    run(ctx) {
      const out = [];
      const GONE = 'src/renderer/stores/document.svelte.ts';
      if (ctx.exists(GONE)) out.push(fail(GONE, undefined, 'the document store is back — views read noteStore'));
      for (const rel of ctx.files('src/renderer', { ext: ['.ts', '.svelte'] })) {
        const raw = ctx.read(rel);
        const code = blank(rel.endsWith('.svelte') ? scriptBlocks(raw).map((b) => b.content).join('\n') : raw, { strings: false });
        if (/from\s+['"][^'"]*\/document\.svelte['"]/.test(code)) out.push(fail(rel, undefined, 'imports the removed document store'));
        if (/\bdocumentStore\b/.test(blank(code))) out.push(fail(rel, undefined, 'refers to documentStore — read noteStore'));
        if (!rel.startsWith(`${COMPONENTS}/`)) continue;
        if (/from\s+['"][^'"]*lib\/notes\/noteWriter['"]/.test(code)) out.push(fail(rel, undefined, 'a component imports the note writer — go through noteStore'));
        const rawLines = raw.split('\n');
        const escaped = (i) => [0, 1, 2, 3].some((j) => /\/\/ allow-raw-read:/.test(rawLines[i - j] ?? ''));
        for (const [re, what] of [
          [/\bparseMarkdownFile\s*\(/, 'parseMarkdownFile('],
          [/\breadNoteText\s*\(/, 'readNoteText('],
          [/\bassembleMarkdownFile\s*\(/, 'assembleMarkdownFile('],
          [/['"]vault:read-file-text['"]/, "'vault:read-file-text'"],
        ]) {
          if (!re.test(code)) continue;
          // Report by the file's own lines (script offsets differ from the file's).
          rawLines.forEach((line, i) => {
            if (re.test(line) && !escaped(i)) {
              out.push(fail(rel, i + 1, `a component parses or reads a note itself (${what}) — read noteStore, or mark a non-note read \`// allow-raw-read: <reason>\``));
            }
          });
        }
      }
      return out;
    },
  },
  {
    id: 'teardown-saves-registered',
    title: 'a component that saves on teardown also registers that change with the component-flush registry',
    hint:
      'Leaving the vault checks for unsaved work before the views unmount, and the swap cancels what their teardown ' +
      'queues. Register the same save with `registerComponentFlush` (lib/boards/componentFlush.ts) so the save runs ' +
      'it first. A note store call is covered by the save itself; annotate anything else `// allow-teardown-save: <reason>`.',
    run(ctx) {
      const out = [];
      const saveCall = /(?<![\w.])((?:\w+\.)*)(\w*(?:[Pp]ersist|[Cc]ommit|[Ss]ave|[Ff]lush)\w*)\s*\(/g;
      let seen = 0;
      for (const rel of ctx.files(COMPONENTS, { ext: ['.svelte'] })) {
        const raw = ctx.read(rel);
        const rawLines = raw.split(/\r?\n/);
        const code = blank(scriptOnly(raw));
        const registers = /\bregister(?:ComponentFlush|RawView)\s*\(/.test(code);
        for (const region of teardownRegions(code)) {
          for (const m of region.text.matchAll(saveCall)) {
            const receiver = m[1];
            if (receiver.startsWith('noteStore.')) continue;
            seen++;
            if (registers) continue;
            const line = lineAt(code, region.start + m.index);
            if (markerNear(rawLines, line - 1, /\/\/\s*allow-teardown-save:\s*\S+/)) continue;
            out.push(fail(rel, line, `teardown calls ${receiver}${m[2]}() but the component never calls registerComponentFlush`));
          }
        }
      }
      if (seen < 5) out.push(fail(COMPONENTS, undefined, `tripwire: only ${seen} teardown saves found (expected >= 5)`));
      return out;
    },
  },
  {
    id: 'hotkeys-board-gated',
    title: "every global `tile:` shortcut in AppShell says which board it is for (`enabled`)",
    hint:
      'The global key handler runs the first matching shortcut, and AppShell registers before any board. An ungated ' +
      'Mind Map shortcut (Ctrl+N, Ctrl+A, Delete…) fires on Kanban / Task List / Document tabs too and hides the ' +
      "board's own command. Add `enabled: onMindMap` (or the right board check) to the registration.",
    run(ctx) {
      const rel = `${COMPONENTS}/layout/AppShell.svelte`;
      const raw = ctx.read(rel);
      if (raw === null) return [fail(rel, undefined, 'missing')];
      const code = blank(scriptOnly(raw), { strings: false });
      const out = [];
      let seen = 0;
      for (const m of code.matchAll(/\bregisterCommandWithShortcut\s*\(/g)) {
        const open = code.indexOf('(', m.index);
        const close = matchBrace(code, open, '(', ')');
        const call = code.slice(open, close < 0 ? code.length : close + 1);
        const name = /\bname\s*:\s*['"]([^'"]+)['"]/.exec(call)?.[1] ?? '';
        if (!name.startsWith('tile:')) continue;
        seen++;
        if (!/\benabled\s*:/.test(call)) out.push(fail(rel, lineAt(code, m.index), `${name} has no \`enabled\` board check`));
      }
      if (seen < 4) out.push(fail(rel, undefined, `tripwire: only ${seen} tile: shortcuts found (expected >= 4)`));
      return out;
    },
  },
  {
    id: 'no-global-index-version',
    title: "views and lib read a note's index entry (getMetadata), not the index's vault-wide version",
    hint:
      "`vaultIndexStore.version` bumps on every save of every note, so a derived that reads it re-runs on each " +
      "autosave anywhere in the vault (every Task List row did, on every keystroke's save). Read `getMetadata(path)` " +
      "or the note selectors (per note), or `listVersion` / `allTags()` / `listMetadata()` (notes and tags). If a " +
      'view really needs every change, mark the line `// allow-global-index-version: <reason>`.',
    run(ctx) {
      const out = [];
      for (const rel of ctx.files([COMPONENTS, 'src/renderer/lib'], { ext: ['.ts', '.svelte'] })) {
        const raw = ctx.read(rel);
        if (!raw.includes('vaultIndexStore')) continue;
        const rawLines = raw.split(/\r?\n/);
        const code = blank(rel.endsWith('.svelte') ? scriptOnly(raw) : raw);
        for (const m of code.matchAll(/\bvaultIndexStore\s*\.\s*version\b/g)) {
          const line = lineAt(code, m.index);
          if (markerNear(rawLines, line - 1, /\/\/\s*allow-global-index-version:\s*\S+/)) continue;
          out.push(fail(rel, line, 'reads vaultIndexStore.version: read the notes it shows (getMetadata / note selectors) or listVersion'));
        }
      }
      return out;
    },
  },
  {
    id: 'kanban-cards-mount-lazily',
    title: 'a Kanban card builds its text editor through LazyTextTileBody, never TextTile directly',
    hint:
      'A TipTap editor per card, all in one flush, froze a 300-card board for 20 s on every open and tab switch. ' +
      'KanbanCard renders `LazyTextTileBody`, which shows a static preview and queues the editor on the idle-time ' +
      'mount queue (`lib/editor/editorMountQueue.ts`), or mounts it at once on a press.',
    run(ctx) {
      const out = [];
      const card = `${COMPONENTS}/boards/KanbanCard.svelte`;
      const lazy = `${COMPONENTS}/tiles/LazyTextTileBody.svelte`;
      const cardCode = ctx.read(card);
      const lazyCode = ctx.read(lazy);
      if (cardCode === null) return [fail(card, undefined, 'missing')];
      if (lazyCode === null) return [fail(lazy, undefined, 'missing')];
      const script = blank(scriptOnly(cardCode), { strings: false });
      const direct = /from\s+['"][^'"]*\/TextTile\.svelte['"]/.exec(script);
      if (direct) out.push(fail(card, lineAt(script, direct.index), 'imports TextTile.svelte: render LazyTextTileBody instead'));
      if (!/<LazyTextTileBody\b/.test(cardCode)) out.push(fail(card, undefined, 'does not render <LazyTextTileBody>'));
      if (!/\bqueueEditorMount\s*\(/.test(blank(scriptOnly(lazyCode)))) {
        out.push(fail(lazy, undefined, 'no longer queues its editor on the mount queue (queueEditorMount)'));
      }
      return out;
    },
  },
  {
    // A notice reaches every user, so it speaks their language: what happened
    // to their file, and what they can do. These words name Filo's internals.
    id: 'toast-plain-language',
    title: "toasts, notices and confirms say what happened in the user's words, not Filo's internals",
    hint:
      'sentinel, cascade, drain, baseline, IPC and envelope name how Filo works, not what the user sees. Say what ' +
      'happened to which file, and what the user can do. reportError\'s third argument is shown too. ' +
      'Escape (rare): `// allow-jargon: <reason>` on the line.',
    run(ctx) {
      const out = [];
      const JARGON = /\b(sentinels?|cascad(?:e|es|ed|ing)|drain(?:s|ed|ing)?|baselines?|IPC|envelopes?)\b/i;
      // reportError(source, err, message): only the message is shown.
      const CALL = /\b(?:uiStore\s*\.\s*(?:toast|pushToast|openConfirm|confirmAsync)|pushToast|(reportError))\s*\(/g;
      const LITERAL = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
      for (const rel of ctx.files('src/renderer', { ext: ['.ts', '.svelte'] })) {
        const raw = ctx.read(rel);
        if (!/toast|openConfirm|confirmAsync|reportError/i.test(raw)) continue;
        const rawLines = raw.split(/\r?\n/);
        const code = stripCommentsKeepOffsets(rel.endsWith('.svelte') ? blankHtmlComments(raw) : raw);
        for (const m of code.matchAll(CALL)) {
          const open = code.indexOf('(', m.index);
          const shown = callArgs(code, open).slice(m[1] ? 2 : 0);
          for (const arg of shown) for (const lit of arg.text.matchAll(LITERAL)) {
            // Only words the user reads: a literal with a space in it (keys
            // and ids such as 'tag-sweep' have none); ${…} parts are code.
            const text = lit[0].slice(1, -1).replace(/\$\{[^}]*\}/g, '');
            if (!text.includes(' ')) continue;
            const word = JARGON.exec(text);
            if (!word) continue;
            const line = lineAt(code, arg.start + lit.index);
            if (markerNear(rawLines, line - 1, /\/\/\s*allow-jargon:\s*\S+/)) continue;
            out.push(fail(rel, line, `user-facing text says "${word[0]}"`));
          }
        }
      }
      return out;
    },
  },
  {
    // Chromium delivers the keypress of an Enter to whatever has the focus
    // once the keydown is handled. A handler that opens an in-app confirm or
    // notice moves the focus to its button, which that keypress then presses:
    // the dialog closes before it is seen (a tag merge couldn't be confirmed).
    id: 'enter-keeps-the-key',
    title: 'an Enter handler in a component calls preventDefault, so its keypress never presses a dialog it opens',
    hint:
      'Call e.preventDefault() in the Enter branch. Where the default must run (an Enter that ' +
      'only moves focus to a real button), mark the line `// allow-enter-default: <reason>`.',
    run(ctx) {
      const out = [];
      for (const rel of ctx.files(COMPONENTS, { ext: ['.svelte'] })) {
        const raw = ctx.read(rel);
        if (!raw.includes("'Enter'")) continue;
        const lines = raw.split(/\r?\n/);
        lines.forEach((line, i) => {
          if (!/\bkey\s*===\s*'Enter'/.test(line)) return;
          if (/allow-enter-default:\s*\S+/.test(line) || /allow-enter-default:\s*\S+/.test(lines[i - 1] ?? '')) return;
          // The branch: up to the next else / other key test, at most 16 lines.
          let end = i + 1;
          while (end < lines.length && end < i + 16 && !/\}\s*else\b|\bkey\s*===/.test(lines[end] ?? '')) end++;
          if (/preventDefault\s*\(/.test(lines.slice(i, end).join('\n'))) return;
          out.push(fail(rel, i + 1, 'an Enter branch without preventDefault()'));
        });
      }
      return out;
    },
  },
];

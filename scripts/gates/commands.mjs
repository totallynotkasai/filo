// Undo/redo (command pattern) ratchets.
import { fail, blank, functionBody, lineAt, stripCommentsKeepLines, tokenChecks } from './lib.mjs';

const COMMANDS = 'src/renderer/commands';

/** Index just past the `}` closing the `{` at `open`, skipping string literals. */
function skipBlock(src, open) {
  let depth = 1;
  let j = open + 1;
  while (j < src.length && depth > 0) {
    const ch = src[j];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch;
      j++;
      while (j < src.length && src[j] !== q) {
        if (src[j] === '\\') j++;
        j++;
      }
    }
    j++;
  }
  return depth === 0 ? j : -1;
}

/** Discover `export class X extends Command` in commands/ (non-recursive, excluding the base + index). */
function commandClasses(ctx) {
  const out = [];
  for (const rel of ctx.files(COMMANDS, { ext: ['.ts'], recursive: false })) {
    if (rel.endsWith('/Command.ts') || rel.endsWith('/index.ts')) continue;
    for (const m of ctx.read(rel).matchAll(/export\s+class\s+(\w+)\s+extends\s+Command\b/g)) out.push({ name: m[1], rel });
  }
  return out;
}

const MUTATORS = [
  'boardStore.updateSettings',
  'boardStore.deleteSettingsKeys',
  'boardCacheStore.setKanbanColumnCollapsed',
  'boardCacheStore.setKanbanColumnWipLimit',
  'boardCacheStore.setKanbanColumnWidth',
  'boardCacheStore.setKanbanSavedViews',
  'boardCacheStore.setTaskListSavedViews',
];
const MUTATOR_DEFINERS = new Set([
  'src/renderer/stores/board.svelte.ts',
  'src/renderer/stores/boardCache.svelte.ts',
  'src/renderer/stores/boardCacheKanban.ts',
  'src/renderer/stores/boardCacheTaskList.ts',
]);

// Commands that cannot silently no-op via a degenerate delta (full before/after
// snapshot, deterministic add/remove or inverse-op pairs), or whose round-trip
// is driven through historyStore.
const ROUNDTRIP_EXEMPT = new Map([
  ['AddTileCommand', 'deterministic add/remove by id'],
  ['AddTilesCommand', 'deterministic multi add/remove'],
  ['ResizeTileCommand', 'full before/after size snapshot'],
  ['UpdateTileStyleCommand', 'full before/after style snapshot'],
  ['UpdateImageAltCommand', 'full before/after alt-text snapshot'],
  ['UpdateTimerConfigCommand', 'full before/after timer-config snapshot'],
  ['AlignTilesCommand', 'full before/after position-map snapshot'],
  ['LayoutTilesCommand', 'full before/after position-map snapshot'],
  ['ToggleTagFadeCommand', 'full previous-state snapshot'],
  ['AddPathTagCommand', 'inverse-op pair on a path'],
  ['RemovePathTagCommand', 'inverse-op pair on a path'],
  ['ReplaceAllCommand', 'round-trip driven via historyStore.undo() in replaceAllCommand.test.ts'],
]);
const ROUNDTRIP_WINDOW = 1500; // chars after `new X(` in which execute + undo must appear

const SHALLOW_SPREAD = /\bthis\.[A-Za-z_$][\w$]*\s*=\s*\{\s*\.\.\.[A-Za-z_$][\w$]*\s*\}/;
const SHALLOW_ARRAY = /\bthis\.[A-Za-z_$][\w$]*\s*=\s*\[\s*\.\.\.[A-Za-z_$][\w$]*\s*\]/;
const RAW_JSON = /\bthis\.[A-Za-z_$][\w$]*\s*=\s*JSON\.parse\s*\(\s*JSON\.stringify\b/;

/** Offending constructor lines (1-based) for the snapshot-discipline check. */
function snapshotOffenders(body, ctorLine) {
  const lines = body.split('\n');
  const isShallow = (t) => SHALLOW_SPREAD.test(t) || SHALLOW_ARRAY.test(t) || RAW_JSON.test(t);
  // One `// allow-shallow:` marker covers the contiguous block of shallow lines / comments below it.
  const allowed = (idx) => {
    if ((lines[idx] ?? '').includes('// allow-shallow:')) return true;
    for (let k = idx - 1; k >= 0; k--) {
      const t = (lines[k] ?? '').trim();
      if (t.includes('allow-shallow:')) return true;
      if (t.startsWith('//') || isShallow(t)) continue;
      return false;
    }
    return false;
  };
  const out = [];
  for (const [kind, re] of [['raw-json-roundtrip', RAW_JSON], ['shallow-spread', SHALLOW_SPREAD], ['shallow-array-spread', SHALLOW_ARRAY]]) {
    lines.forEach((l, i) => {
      if (re.test(l) && !allowed(i)) out.push({ line: ctorLine + i, kind, snippet: l.trim() });
    });
  }
  return out;
}

export const checks = [
  {
    id: 'direct-board-mutations',
    title: 'must-be-undoable board mutators are only called from commands',
    hint:
      'Dispatch via historyStore.execute(new <Update*>Command(...)) to keep Ctrl+Z coverage. For a genuinely ' +
      'non-undoable call add `// allow-direct-mutation: <reason>` on the line or the one above.',
    run(ctx) {
      const out = [];
      const patterns = MUTATORS.map((n) => [n, new RegExp(`\\b${n.replace('.', '\\.')}\\s*\\(`)]);
      for (const rel of ctx.files('src/renderer', { ext: ['.svelte', '.svelte.ts', '.ts'] })) {
        if (MUTATOR_DEFINERS.has(rel) || rel.startsWith(`${COMMANDS}/`)) continue;
        const lines = ctx.read(rel).split('\n');
        lines.forEach((line, i) => {
          if (line.includes('// allow-direct-mutation:') || (lines[i - 1] ?? '').includes('// allow-direct-mutation:')) return;
          for (const [name, re] of patterns) if (re.test(line)) out.push(fail(rel, i + 1, `direct ${name}(): ${line.trim()}`));
        });
      }
      return out;
    },
  },
  {
    id: 'command-snapshot-discipline',
    title: 'command constructors snapshot via this.snapshot(), not raw JSON or shallow spreads',
    hint:
      'Use `this.snapshot(value)`. A shallow spread of a primitives-only shape may be kept with ' +
      '`// allow-shallow: <reason>` on the line or directly above.',
    run(ctx) {
      const out = [];
      for (const rel of ctx.files(COMMANDS, { ext: ['.ts'] })) {
        if (rel === `${COMMANDS}/Command.ts`) continue;
        const src = ctx.read(rel);
        for (const cm of src.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)\s+(?:extends|implements)\s+Command\b/g)) {
          const brace = src.indexOf('{', cm.index + cm[0].length);
          if (brace < 0) continue;
          const classEnd = skipBlock(src, brace);
          const classBody = src.slice(brace, classEnd < 0 ? src.length : classEnd);
          const ctorOffset = classBody.indexOf('constructor');
          if (ctorOffset < 0) continue;
          const ctorIdx = brace + ctorOffset;
          let i = src.indexOf('(', ctorIdx);
          if (i < 0) continue;
          for (let depth = 0; i < src.length; i++) {
            if (src[i] === '(') depth++;
            else if (src[i] === ')' && --depth === 0) break;
          }
          const open = src.indexOf('{', i);
          if (open < 0) continue;
          const end = skipBlock(src, open);
          if (end < 0) continue;
          for (const o of snapshotOffenders(src.slice(open + 1, end - 1), lineAt(src, ctorIdx))) {
            out.push(fail(rel, o.line, `${o.kind} in ${cm[1]}: ${o.snippet}`));
          }
        }
      }
      return out;
    },
  },
  {
    id: 'command-roundtrip-coverage',
    title: 'every Command subclass has an execute/undo round-trip test (or a documented exemption)',
    hint:
      'Degenerate-delta commands silently no-op unless a test drives construct → execute → undo. Add such a test, ' +
      'or exempt a full-snapshot / inverse-op command in ROUNDTRIP_EXEMPT with a reason.',
    run(ctx) {
      const out = [];
      const classes = commandClasses(ctx);
      if (classes.length < 30) return [fail(COMMANDS, undefined, `tripwire: only ${classes.length} command classes found (expected >= 30)`)];
      const tests = ctx.files('src/tests', { ext: ['.ts'] }).map((rel) => ctx.read(rel));
      const covered = (name) => {
        const re = new RegExp(`\\bnew\\s+${name}\\s*\\(`, 'g');
        return tests.some((text) => {
          for (const m of text.matchAll(re)) {
            const w = text.slice(m.index, m.index + ROUNDTRIP_WINDOW);
            if (/\.execute\s*\(/.test(w) && /\.undo\s*\(/.test(w)) return true;
          }
          return false;
        });
      };
      const known = new Set(classes.map((c) => c.name));
      for (const n of ROUNDTRIP_EXEMPT.keys()) if (!known.has(n)) out.push(fail(COMMANDS, undefined, `ROUNDTRIP_EXEMPT names unknown command ${n}`));
      for (const { name, rel } of classes) {
        if (!ROUNDTRIP_EXEMPT.has(name) && !covered(name)) out.push(fail(rel, undefined, `${name} has no execute/undo round-trip test`));
      }
      return out;
    },
  },
  {
    id: 'commands-target-board',
    title: 'every Command declares and assigns `readonly targetBoardId: string`',
    hint:
      'history undo/redo uses targetBoardId to refuse running a command against another board. ' +
      'Escape (rare): `// allow-no-target-board: <reason>` on the class line or the one above.',
    run(ctx) {
      const out = [];
      for (const rel of ctx.files(COMMANDS, { ext: ['.ts'] })) {
        if (rel.endsWith('/Command.ts') || rel.endsWith('/index.ts')) continue;
        const text = ctx.read(rel);
        const lines = text.split('\n');
        for (const m of text.matchAll(/export\s+class\s+(\w+)\s+extends\s+Command\b/g)) {
          const line = lineAt(text, m.index);
          if (`${lines[line - 1] ?? ''}\n${lines[line - 2] ?? ''}`.includes('allow-no-target-board:')) continue;
          const open = text.indexOf('{', m.index);
          if (open < 0) continue;
          let depth = 0;
          let close = text.length;
          for (let i = open; i < text.length; i++) {
            if (text[i] === '{') depth++;
            else if (text[i] === '}' && --depth === 0) { close = i + 1; break; }
          }
          const body = text.slice(open, close);
          const missing = [];
          if (!/readonly\s+targetBoardId\s*:\s*string/.test(body)) missing.push('declaration');
          if (!/this\.targetBoardId\s*=/.test(body)) missing.push('constructor assignment');
          if (missing.length) out.push(fail(rel, line, `${m[1]} missing targetBoardId ${missing.join(' + ')}`));
        }
      }
      return out;
    },
  },
  {
    id: 'command-targets-self',
    title: "commands dirty their own targetBoardId, never the globally active board",
    hint:
      'Use `this.targetBoardId`. The ctor fallback `this.targetBoardId = … ?? boardStore.current?.id` is allowed; ' +
      'other bypasses need `// allow-board-store-current: <reason>` / `// allow-non-target-markdirty: <reason>` ' +
      '(same or preceding line).',
    run(ctx) {
      const out = [];
      for (const rel of ctx.files(COMMANDS, { ext: ['.ts'] })) {
        const raw = ctx.read(rel);
        const codeLines = stripCommentsKeepLines(raw).split(/\r?\n/);
        const rawLines = raw.split(/\r?\n/);
        codeLines.forEach((code, i) => {
          const window = `${rawLines[i - 1] ?? ''}\n${rawLines[i] ?? ''}`;
          if (
            /\bboardStore\.current\b/.test(code) &&
            !/this\.targetBoardId\s*=.*boardStore\.current\?\.id/.test(code) &&
            !/\/\/\s*allow-board-store-current:\s*\S+/.test(window)
          ) {
            out.push(fail(rel, i + 1, `boardStore.current: ${(rawLines[i] ?? '').trim()}`));
          }
          for (const m of code.matchAll(/boardCacheStore\.markDirty\s*\(\s*([^)]*?)\s*\)/g)) {
            const arg = m[1].trim();
            if (arg === 'this.targetBoardId' || arg === "''" || arg === '""') continue;
            if (/\/\/\s*allow-non-target-markdirty:\s*\S+/.test(window)) continue;
            out.push(fail(rel, i + 1, `markDirty(${arg}): ${(rawLines[i] ?? '').trim()}`));
          }
        });
      }
      // PropertiesPopup's deferred command must target the popup's pane (captured at mount).
      const POPUP = 'src/renderer/components/tiles/PropertiesPopup.svelte';
      const popup = ctx.read(POPUP);
      if (popup === null) return [...out, fail(POPUP, undefined, 'required file missing')];
      out.push(
        ...tokenChecks(POPUP, stripCommentsKeepLines(popup), {
          required: [
            { token: /mountBoardId\s*=\s*boardStore\.current\?\.id/, why: 'captures the board id at popup mount' },
            { token: /new UpdatePropertiesCommand\([^;]*\bmountBoardId\b/, why: 'passes the mount-time board id to UpdatePropertiesCommand' },
          ],
        }),
      );
      return out;
    },
  },
  {
    id: 'tasklist-section-clamp',
    title: 'persistTaskListStructure clamps section positions into [0, taskCount] and sorts',
    hint:
      'A section position > taskCount owns nothing and misroutes a later add-to-section; ties must sort ' +
      'deterministically. Keep `Math.max(0, Math.min(p, taskCount))` + `.sort(`.',
    run(ctx) {
      const FILE = 'src/renderer/stores/boardCacheTaskList.ts';
      const raw = ctx.read(FILE);
      if (raw === null) return [fail(FILE, undefined, 'file missing')];
      const fn = functionBody(blank(raw), 'persistTaskListStructure');
      if (!fn) return [fail(FILE, undefined, 'persistTaskListStructure() not found')];
      const body = fn.text;
      const out = [];
      if (!/Math\.min\s*\([^;]*?\btaskCount\b/.test(body)) out.push(fail(FILE, undefined, 'missing the upper clamp Math.min(<…>, taskCount)'));
      if (!/Math\.max\s*\(\s*0\b/.test(body) && !/Math\.max\s*\([^;]*?,\s*0\s*\)/.test(body)) {
        out.push(fail(FILE, undefined, 'missing the lower clamp Math.max(0, <…>)'));
      }
      if (!/\btaskCount\b/.test(body)) out.push(fail(FILE, undefined, 'the clamp bound `taskCount` is gone'));
      if (!/\.sort\s*\(/.test(body)) out.push(fail(FILE, undefined, 'missing the `.sort(` normalisation'));
      return out;
    },
  },
];

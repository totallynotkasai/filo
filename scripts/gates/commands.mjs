// Undo/redo (command pattern) ratchets.
import { fail, blank, functionBody, lineAt, stripCommentsKeepLines } from './lib.mjs';

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
  {
    id: 'no-note-body-in-commands',
    title: 'no command keeps a copy of a note body or writes one back',
    hint:
      "Undo of a delete moves the file back from Filo's trash (commands/trashedFiles.ts); undo of a note field " +
      'sends an inverse FrontmatterDelta (commands/frontmatterInverse.ts); Replace All keeps only the replaced text. ' +
      'A command never reads a note to keep its text, and never restores a body from memory.',
    run(ctx) {
      const out = [];
      const BODY_WRITES = /\bnoteStore\.(?:restore|restoreBody|writeBody|setBody|recreate|createExclusive)\s*\(/g;
      const OLD_SHAPES = /\b(?:fileSnapshots?|mediaSnapshots|originalContent|nextContent|DeletedFileSnapshot)\b/g;
      const READS = /\binvoke(?:Ok)?\s*\(\s*['"`](?:vault:read-file-text|media:read-file)['"`]|\breadNoteFresh\s*\(/g;
      for (const rel of ctx.files(COMMANDS, { ext: ['.ts'], recursive: false })) {
        const raw = ctx.read(rel);
        const code = blank(raw);
        const withStrings = blank(raw, { strings: false });
        for (const m of code.matchAll(BODY_WRITES)) out.push(fail(rel, lineAt(raw, m.index), `a command writes a note body back (${m[0].trim()}…)`));
        for (const m of code.matchAll(OLD_SHAPES)) out.push(fail(rel, lineAt(raw, m.index), `'${m[0]}' — a command keeps note content`));
        // A file read inside a command class body is a snapshot in the making.
        for (const cls of withStrings.matchAll(/class\s+\w+\s+extends\s+\w*Command\b[^{]*\{/g)) {
          const open = cls.index + cls[0].length - 1;
          const end = skipBlock(withStrings, open);
          const body = withStrings.slice(open, end < 0 ? withStrings.length : end);
          for (const m of body.matchAll(READS)) out.push(fail(rel, lineAt(raw, open + m.index), 'a command reads a note\'s text; keep the change, not the note'));
        }
      }
      return out;
    },
  },
  {
    // An undo after a rename acted on the old path: the write failed, stayed
    // queued, and blocked every later rename and delete in the vault.
    id: 'commands-follow-renames',
    title: 'every path a command holds follows renames',
    hint:
      'Commands follow renames through Command.renamePath, which rewrites fields named in PATH_FIELDS ' +
      '(commands/commandPaths.ts) and the history sweep calls on every stack. Name a path field with a listed ' +
      'name, add its name to PATH_FIELDS, or override renamePath() in the class.',
    run(ctx) {
      const out = [];
      const pathsFile = `${COMMANDS}/commandPaths.ts`;
      const listedSrc = /PATH_FIELDS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(ctx.read(pathsFile) ?? '');
      if (!listedSrc) return [fail(pathsFile, undefined, 'PATH_FIELDS (new Set([...])) not found')];
      const listed = new Set([...listedSrc[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));

      const baseFile = `${COMMANDS}/Command.ts`;
      const base = blank(ctx.read(baseFile) ?? '', { strings: false });
      if (!/\brenamePath\s*\([^)]*\)\s*:\s*void\s*\{\s*rebaseCommandFields\s*\(\s*this\b/.test(base)) {
        out.push(fail(baseFile, undefined, 'Command.renamePath must default to rebaseCommandFields(this, …)'));
      }
      const historyFile = 'src/renderer/stores/history.svelte.ts';
      const history = blank(ctx.read(historyFile) ?? '', { strings: false });
      if (!/registerPathRenamable\s*\(\s*'history'[\s\S]*?\.renamePath\s*\(/.test(history)) {
        out.push(fail(historyFile, undefined, "the history store must register a 'history' rename sweep that calls renamePath on every command"));
      }

      // A path-like property name: a field of a command or of a snapshot type it keeps.
      const PATH_LIKE = /^(?:path|paths|rel|src)$|(?:Path|Paths|Rel|Rels|Src|Cover|Image)$/;
      const EXEMPT = new Map([
        ['rel', "a trashed item's original path; pinned on purpose (commandPaths.ts: trashedPaths)"],
        ['restoredPath', 'where a restore landed; used once, never kept on a command'],
      ]);
      for (const rel of ctx.files(COMMANDS, { ext: ['.ts'], recursive: false })) {
        if (rel === pathsFile) continue;
        const raw = ctx.read(rel);
        const code = blank(raw, { strings: false });
        // Classes that override renamePath own their paths.
        const overriding = [];
        for (const cls of code.matchAll(/class\s+\w+\s+extends\s+\w*Command\b[^{]*\{/g)) {
          const open = cls.index + cls[0].length - 1;
          const end = skipBlock(code, open);
          const body = code.slice(open, end < 0 ? code.length : end);
          if (/^\s+renamePath\s*\(/m.test(body)) overriding.push([open, end < 0 ? code.length : end]);
        }
        for (const m of code.matchAll(/^[ \t]+(?:(?:private|protected|public|readonly)\s+)*(\w+)\??\s*:[^;\n]*;[ \t]*$/gm)) {
          const name = m[1];
          if (!PATH_LIKE.test(name) || listed.has(name) || EXEMPT.has(name)) continue;
          if (overriding.some(([a, b]) => m.index > a && m.index < b)) continue;
          out.push(fail(rel, lineAt(raw, m.index), `'${name}' looks like a path but is not in PATH_FIELDS, so it won't follow a rename`));
        }
      }
      return out;
    },
  },
  {
    // A board reload dropped only the steps that targeted it, so a cascade
    // filed on another board replayed the reloaded board's old placements.
    id: 'cascade-touched-boards',
    title: 'a command holding snapshots beyond its own board names them in touchedBoardIds()',
    hint:
      'A board read again from disk drops every step whose touchedBoardIds() has it. A command that spans boards ' +
      "(targetBoardId '', child commands, per-board tile maps, connections) must override touchedBoardIds() with " +
      'every board its undo or redo writes. If it truly writes only its own board, add ' +
      '`// allow-own-board-only: <reason>` on the class line or the one above.',
    run(ctx) {
      const out = [];
      // A child command (`Command[]`, `DeleteCardCommand[]`, `inner: MoveTaskBlockCommand`), a per-board tile map, connections.
      const SPANNING_FIELD = /Command\b|\bRecord<string,\s*Tile\[\]>|\bConnection\[\]/;
      for (const rel of ctx.files(COMMANDS, { ext: ['.ts'], recursive: false })) {
        if (rel.endsWith('/Command.ts') || rel.endsWith('/index.ts')) continue;
        const raw = ctx.read(rel);
        const code = blank(raw, { strings: false });
        const lines = raw.split('\n');
        for (const cls of code.matchAll(/export\s+class\s+(\w+)\s+extends\s+\w*Command\b[^{]*\{/g)) {
          const line = lineAt(raw, cls.index);
          if (`${lines[line - 1] ?? ''}\n${lines[line - 2] ?? ''}`.includes('allow-own-board-only:')) continue;
          const open = cls.index + cls[0].length - 1;
          const end = skipBlock(code, open);
          const body = code.slice(open, end < 0 ? code.length : end);
          const reasons = [];
          if (/this\.targetBoardId\s*=\s*''/.test(body)) reasons.push("targetBoardId ''");
          for (const f of body.matchAll(/^[ \t]+(?:(?:private|protected|public|readonly)\s+)*(\w+)\??\s*:\s*([^;=\n]+)[;=]/gm)) {
            if (SPANNING_FIELD.test(f[2])) reasons.push(`field '${f[1]}: ${f[2].trim()}'`);
          }
          if (reasons.length === 0) continue;
          if (/^[ \t]+touchedBoardIds\s*\(\s*\)/m.test(body)) continue;
          out.push(fail(rel, line, `${cls[1]} spans boards (${reasons.join(', ')}) but doesn't override touchedBoardIds()`));
        }
      }
      return out;
    },
  },
];

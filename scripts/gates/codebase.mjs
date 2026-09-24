// Codebase-wide hygiene ratchets.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fail, stripComments } from './lib.mjs';

// Per-file type-error counts for the test sources (tsconfig.tests.json) when
// the ratchet was introduced. A file may only improve; a file not listed must
// be clean.
const TEST_TYPECHECK_BASELINE = 'scripts/gates/testTypecheckBaseline.json';

const SRC_EXT = ['.svelte', '.svelte.ts', '.ts'];
const LOC_LIMIT = 1000;

// Files over LOC_LIMIT, each pinned at its current LOC. They may shrink, not
// grow; the remedy for an over-limit file is to split it, not to raise its row.
const FILE_SIZE_ALLOWLIST = {
  'src/renderer/components/boards/TaskListBoard.svelte': 2077,
  'src/renderer/components/boards/KanbanSideToolbar.svelte': 1503,
  'src/renderer/components/boards/TaskItem.svelte': 1533,
  'src/renderer/components/boards/KanbanBoard.svelte': 1456,
  'src/renderer/components/boards/KanbanColumn.svelte': 1198,
  'src/renderer/stores/vault.svelte.ts': 1668,
  'src/renderer/lib/vault/markdownFileWriter.ts': 1132,
};

// The refactor characterisation suite: user-visible behaviour the file-model
// refactor must keep. Each spec file with its minimum case count.
const CHARACTERISATION_DIR = 'src/tests/characterisation';
const CHARACTERISATION_SPECS = {
  'editingAndViews.test.ts': 5,
  'metadataEdits.test.ts': 5,
  'renamesAndDiskChanges.test.ts': 8,
  'bytesOnDisk.test.ts': 4,
  'noteModel.test.ts': 11,
};

// Board format v8: a def names its file and stores only visuals. These are
// the keys that would be a second copy of something the file owns.
const TILE_SCHEMA = 'src/renderer/schema/tile.ts';
const NOTE_COPY_KEYS = {
  TextTileDefSchema: ['title', 'tags', 'content', 'contentId', 'file'],
  ImageTileDefSchema: ['tags', 'content', 'contentId', 'file', 'fileName', 'fileExtension'],
  VideoTileDefSchema: ['tags', 'content', 'contentId', 'file', 'fileName', 'fileExtension'],
  AudioTileDefSchema: ['tags', 'content', 'contentId', 'file', 'fileName', 'fileExtension'],
  FileTileDefSchema: ['tags', 'content', 'contentId', 'file', 'fileName', 'fileExtension'],
};
// Board-only tiles own their title and tags; they must keep declaring them.
const INLINE_DEF_KEYS = {
  LinkTileDefSchema: ['title', 'tags'],
  IframeTileDefSchema: ['title', 'tags'],
  TimerTileDefSchema: ['title', 'tags'],
};

/**
 * Every `const Name = Base.extend({ … })` / `const Name = z.object({ … })`
 * schema in `code`, with its base and the top-level keys it declares and
 * whether the declaration ends in `.passthrough()`.
 */
function schemaDecls(code) {
  const decls = new Map();
  const re = /\bconst\s+(\w+)\s*=\s*(?:(\w+)\.extend|z\.object)\(\{/g;
  for (const m of code.matchAll(re)) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let i = open;
    for (; i < code.length; i++) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}' && --depth === 0) break;
    }
    const body = code.slice(open + 1, i);
    const keys = new Set();
    let d = 0;
    for (const line of body.split('\n')) {
      if (d === 0) {
        const k = /^\s*(\w+)\s*:/.exec(line);
        if (k) keys.add(k[1]);
      }
      for (const ch of line) {
        if (ch === '{' || ch === '(' || ch === '[') d++;
        else if (ch === '}' || ch === ')' || ch === ']') d--;
      }
    }
    const tail = code.slice(i, i + 40);
    decls.set(m[1], { base: m[2] ?? null, keys, passthrough: /^\}\)\s*\.passthrough\(\)/.test(tail) });
  }
  return decls;
}

/** All keys a schema declares, including those inherited through `.extend`. */
function allKeys(decls, name, seen = new Set()) {
  const d = decls.get(name);
  if (!d || seen.has(name)) return new Set();
  seen.add(name);
  const keys = new Set(d.keys);
  if (d.base) for (const k of allKeys(decls, d.base, seen)) keys.add(k);
  return keys;
}

function countLines(text) {
  if (text.length === 0) return 0;
  let count = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) count++;
  if (text.charCodeAt(text.length - 1) === 10) count--;
  return count;
}

export const checks = [
  {
    id: 'file-sizes',
    title: 'source files stay under 1000 LOC (allowlisted files may not grow)',
    hint: 'Split the file. Only lower an allowlist ceiling; raising one needs a reviewed reason.',
    run(ctx) {
      const out = [];
      const remaining = new Map(Object.entries(FILE_SIZE_ALLOWLIST));
      for (const rel of ctx.files(['src/main', 'src/renderer'], { ext: SRC_EXT })) {
        const loc = countLines(ctx.read(rel));
        if (remaining.has(rel)) {
          const ceiling = remaining.get(rel);
          if (loc > ceiling) out.push(fail(rel, undefined, `${loc} LOC grew past its allowlist ceiling ${ceiling}`));
          remaining.delete(rel);
        } else if (loc > LOC_LIMIT) {
          out.push(fail(rel, undefined, `${loc} LOC exceeds the ${LOC_LIMIT} LOC limit`));
        }
      }
      for (const rel of remaining.keys()) out.push(fail(rel, undefined, 'allowlist entry no longer exists — remove it'));
      return out;
    },
  },
  {
    id: 'type-casts',
    title: 'no `as any` / `as unknown as` in app source',
    hint: 'Narrow the type properly; if truly unavoidable add `// allow-cast: <reason>` on the line.',
    run(ctx) {
      const out = [];
      const patterns = [
        ['as any', /\bas\s+any\b/],
        ['as unknown as', /\bas\s+unknown\s+as\b/],
      ];
      for (const rel of ctx.files(['src/main', 'src/renderer'], { ext: SRC_EXT })) {
        ctx.read(rel).split('\n').forEach((line, i) => {
          if (line.includes('// allow-cast:')) return;
          for (const [name, re] of patterns) if (re.test(line)) out.push(fail(rel, i + 1, `\`${name}\`: ${line.trim()}`));
        });
      }
      return out;
    },
  },
  {
    id: 'test-typecheck',
    title: 'test sources type-check (per-file error ratchet)',
    hint:
      `Fix the type errors. A file missing from ${TEST_TYPECHECK_BASELINE} must be clean; a listed file may ` +
      'only go down — lower (or delete) its entry when it improves. Run: npx tsc -p tsconfig.tests.json --noEmit',
    run(ctx) {
      const tsc = join(ctx.root, 'node_modules', 'typescript', 'bin', 'tsc');
      const res = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.tests.json', '--noEmit', '--pretty', 'false'], {
        cwd: ctx.root,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      if (res.error) return [fail('tsconfig.tests.json', undefined, `could not run tsc: ${res.error.message}`)];
      const output = `${res.stdout}\n${res.stderr}`;
      const counts = new Map();
      for (const line of output.split(/\r?\n/)) {
        const m = /^([^\s(][^(]*)\(\d+,\d+\): error TS\d+/.exec(line);
        if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
      }
      if (res.status !== 0 && counts.size === 0) {
        return [fail('tsconfig.tests.json', undefined, `tsc failed without per-file errors:\n${output.trim().slice(-2000)}`)];
      }
      const baseline = JSON.parse(ctx.read(TEST_TYPECHECK_BASELINE) ?? '{}');
      const out = [];
      for (const [file, n] of [...counts].sort()) {
        const allowed = baseline[file] ?? 0;
        if (n > allowed) out.push(fail(file, undefined, `${n} type error(s), baseline ${allowed}`));
      }
      for (const [file, allowed] of Object.entries(baseline)) {
        const n = counts.get(file) ?? 0;
        if (n < allowed) console.log(`      ratchet down: ${file} ${allowed} -> ${n} in ${TEST_TYPECHECK_BASELINE}`);
      }
      return out;
    },
  },
  {
    id: 'board-schema-no-note-copies',
    title: "board tile defs don't store a copy of their file's title, tags or body",
    hint:
      "A note's title, tags and body live in the .md, a media file's tags in tags.json. A second copy on the " +
      'board is what let two copies disagree. Board-only (link / iframe / timer) defs keep their own title and tags.',
    run(ctx) {
      const raw = ctx.read(TILE_SCHEMA);
      if (raw === null) return [fail(TILE_SCHEMA, undefined, 'file missing — re-point the check')];
      const decls = schemaDecls(stripComments(raw));
      const out = [];
      for (const [name, banned] of Object.entries(NOTE_COPY_KEYS)) {
        if (!decls.has(name)) { out.push(fail(TILE_SCHEMA, undefined, `${name} not found — re-point the check`)); continue; }
        const keys = allKeys(decls, name);
        for (const k of banned) if (keys.has(k)) out.push(fail(TILE_SCHEMA, undefined, `${name} declares \`${k}\``));
        if (!keys.has('filePath') && !keys.has('src')) out.push(fail(TILE_SCHEMA, undefined, `${name} names no file (filePath / src)`));
        if (decls.get(name).passthrough) out.push(fail(TILE_SCHEMA, undefined, `${name} ends in .passthrough(), so a dropped key survives a load and save`));
      }
      for (const [name, required] of Object.entries(INLINE_DEF_KEYS)) {
        if (!decls.has(name)) { out.push(fail(TILE_SCHEMA, undefined, `${name} not found — re-point the check`)); continue; }
        const keys = allKeys(decls, name);
        for (const k of required) if (!keys.has(k)) out.push(fail(TILE_SCHEMA, undefined, `${name} lost \`${k}\` (a board-only tile owns it)`));
      }
      return out;
    },
  },
  {
    id: 'no-legacy-board-migration',
    title: 'the board loader accepts only the current format: no migration steps, no double-decode',
    hint:
      "Filo hasn't shipped, so an older board format is refused (failedBoards, never written), not migrated. " +
      'A future format change adds its step deliberately together with this check.',
    run(ctx) {
      const out = [];
      const MIG = 'src/renderer/schema/migrations.ts';
      const mig = ctx.read(MIG);
      if (mig === null) out.push(fail(MIG, undefined, 'file missing — re-point the check'));
      else if (!/\bconst\s+MIGRATION_STEPS\b[^;]*?=\s*\{\s*\}\s*;/.test(stripComments(mig))) {
        out.push(fail(MIG, undefined, 'MIGRATION_STEPS has a board migration step'));
      }
      const MAIN = 'src/main/vault/boardFileOps.ts';
      const main = ctx.read(MAIN);
      if (main === null) out.push(fail(MAIN, undefined, 'file missing — re-point the check'));
      else if (/typeof\s+\w+\s*===\s*['"]string['"]\s*\?\s*JSON\.parse/.test(stripComments(main))) {
        out.push(fail(MAIN, undefined, 'loadBoardFile unwraps a double-encoded board'));
      }
      const LOADER = 'src/renderer/lib/boards/boardLoader.ts';
      const loader = ctx.read(LOADER);
      if (loader === null) out.push(fail(LOADER, undefined, 'file missing — re-point the check'));
      else if (/\bJSON\.parse\s*\(/.test(stripComments(loader))) {
        out.push(fail(LOADER, undefined, 're-parses a board payload (a string board is an older format, refused by the version gate)'));
      }
      return out;
    },
  },
  {
    // The suite runs in test:unit:strict; this pins that it stays there, whole,
    // and black-box (a spec that reaches into stores would break with the
    // refactor it is meant to check).
    id: 'characterisation-suite',
    title: 'the refactor characterisation suite stays in place, un-skipped and black-box',
    hint:
      'Specs change only where the master plan lists an expected change. Drive the app through ' +
      `${CHARACTERISATION_DIR}/harness/ (update the harness when internals move), never through @renderer imports.`,
    run(ctx) {
      const out = [];
      for (const [name, min] of Object.entries(CHARACTERISATION_SPECS)) {
        const rel = `${CHARACTERISATION_DIR}/${name}`;
        const src = ctx.read(rel);
        if (src === null) {
          out.push(fail(rel, undefined, 'missing'));
          continue;
        }
        const code = stripComments(src);
        if (/\b(?:it|describe|test)\.(?:skip|only|todo)\b|\bit\.skipIf\b/.test(code)) {
          out.push(fail(rel, undefined, 'contains a skipped / focused / todo test'));
        }
        const cases = (code.match(/\bit\s*\(/g) ?? []).length;
        if (cases < min) out.push(fail(rel, undefined, `only ${cases} cases (expected >= ${min})`));
        for (const m of code.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/g)) {
          const spec = m[1] ?? m[2];
          const allowed = spec === 'vitest' || spec === 'yaml' || spec.startsWith('node:') || spec.startsWith('./harness/');
          if (!allowed) out.push(fail(rel, undefined, `imports '${spec}' (specs import only vitest, yaml, node: and ./harness/)`));
        }
      }
      const setup = ctx.read(`${CHARACTERISATION_DIR}/setup.ts`);
      if (setup === null || !/\binstallEditorLoopBreaker\s*\(/.test(stripComments(setup))) {
        out.push(fail(`${CHARACTERISATION_DIR}/setup.ts`, undefined, 'must install the editor loop breaker (a runaway loop hangs instead of failing)'));
      }
      const config = ctx.read('vitest.config.mts');
      if (config === null || !config.includes(`'${CHARACTERISATION_DIR}/**/*.test.ts'`)) {
        out.push(fail('vitest.config.mts', undefined, 'no vitest project runs the characterisation suite'));
      }
      return out;
    },
  },
];

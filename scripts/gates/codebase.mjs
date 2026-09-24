// Codebase-wide hygiene ratchets.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fail } from './lib.mjs';

// Per-file type-error counts for the test sources (tsconfig.tests.json) when
// the ratchet was introduced. A file may only improve; a file not listed must
// be clean.
const TEST_TYPECHECK_BASELINE = 'scripts/gates/testTypecheckBaseline.json';

const SRC_EXT = ['.svelte', '.svelte.ts', '.ts'];
const LOC_LIMIT = 1000;

// Files over LOC_LIMIT, each pinned at its current LOC. They may shrink, not
// grow; the remedy for an over-limit file is to split it, not to raise its row.
const FILE_SIZE_ALLOWLIST = {
  'src/renderer/components/boards/TaskListBoard.svelte': 2192,
  'src/renderer/components/boards/KanbanSideToolbar.svelte': 1503,
  'src/renderer/components/boards/TaskItem.svelte': 1543,
  'src/renderer/components/boards/KanbanBoard.svelte': 1459,
  'src/renderer/components/boards/KanbanColumn.svelte': 1198,
  'src/renderer/components/sidebar/VaultFileItem.svelte': 1008,
  'src/renderer/stores/vault.svelte.ts': 1683,
  'src/renderer/stores/fileTags.svelte.ts': 1183,
  'src/renderer/lib/vault/markdownFileWriter.ts': 1132,
};

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
];

// Codebase-wide hygiene ratchets.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {
  fail, stripComments, stripCommentsKeepLines, blank, scriptOnly, functionBody, matchBrace, lineAt, IMPORT_SPECIFIER, packageName,
} from './lib.mjs';
import { countCodeLines } from './codeLines.mjs';

// Per-file type-error counts for the test sources (tsconfig.tests.json) when
// the ratchet was introduced. A file may only improve; a file not listed must
// be clean.
const TEST_TYPECHECK_BASELINE = 'scripts/gates/testTypecheckBaseline.json';

const SRC_EXT = ['.svelte', '.svelte.ts', '.ts'];
// Lines of code (codeLines.mjs: blank and comment-only lines don't count), so
// a comment explaining a hazard never pushes a file toward a split.
const LOC_LIMIT = 1000;

// Files over LOC_LIMIT, each pinned at its current lines of code. They may
// shrink, not grow; the remedy for an over-limit file is to split it, not to
// raise its row. A file back within the limit leaves the list.
const FILE_SIZE_ALLOWLIST = {
  'src/renderer/components/boards/TaskListBoard.svelte': 1169,
  'src/renderer/components/boards/KanbanSideToolbar.svelte': 1248,
  'src/renderer/components/boards/TaskItem.svelte': 1161,
};

// The refactor characterisation suite: user-visible behaviour the file-model
// refactor must keep. Each spec file with its minimum case count.
const CHARACTERISATION_DIR = 'src/tests/characterisation';
const CHARACTERISATION_SPECS = {
  'editingAndViews.test.ts': 5,
  'metadataEdits.test.ts': 5,
  'renamesAndDiskChanges.test.ts': 8,
  'bytesOnDisk.test.ts': 5,
  'noteModel.test.ts': 14,
  'oneModel.test.ts': 4,
  'trash.test.ts': 10,
  'tagUndo.test.ts': 7,
  'tagRowAndRawView.test.ts': 8,
  'undoAcrossRenames.test.ts': 6,
  'externalRenames.test.ts': 6,
  'newBoards.test.ts': 4,
  'closeVault.test.ts': 5,
  'blockLayout.test.ts': 2,
  'lineSpacing.test.ts': 5,
  'newNotesInSidebar.test.ts': 3,
  'tagFilters.test.ts': 10,
  'boardShortcutsAndUndo.test.ts': 7,
  'frontmatterSafety.test.ts': 2,
  'rawViewUnsaved.test.ts': 5,
  'taskNotesBox.test.ts': 4,
  'leavingKeepsHeldChanges.test.ts': 7,
  'honestSaveState.test.ts': 6,
  'vaultShortcuts.test.ts': 9,
  'errorStates.test.ts': 7,
  'folderPinsAndVaultName.test.ts': 4,
  'boardFolders.test.ts': 8,
  'syncedVault.test.ts': 2,
  'editorFidelity.test.ts': 3,
  'kanbanClick.test.ts': 1,
  'taskFieldsAtOpen.test.ts': 1,
  'explorerDrops.test.ts': 3,
  'taskSubtasks.test.ts': 3,
  'slowRenames.test.ts': 6,
  'sessionEnd.test.ts': 4,
  'boardFormatUpdate.test.ts': 2,
  'newCardsAndTiles.test.ts': 6,
  'typedTextReachesDisk.test.ts': 5,
  'spellCheckSetting.test.ts': 2,
  'makingAndFindingNotes.test.ts': 16,
  'listsAndBoards.test.ts': 9,
  'interfaceAroundViews.test.ts': 12,
  'syncAndRecovery.test.ts': 10,
  'notesAndBoards.test.ts': 6,
  'agentReorganises.test.ts': 7,
  'boardKeys.test.ts': 11,
  'viewsAndPanels.test.ts': 12,
  'templatesAndBoards.test.ts': 11,
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

// Board format migrations: the step list, the current version it must reach,
// and each step's fixtures (an old file and what it loads as today).
const BOARD_MIGRATIONS = 'src/renderer/schema/migrations.ts';
const BOARD_FILE_SCHEMA = 'src/renderer/schema/boardFile.ts';
const BOARD_MIGRATION_FIXTURES = 'src/tests/unit/fixtures/board-migrations';
const BOARD_MIGRATION_FIXTURE_TEST = 'src/tests/unit/boardMigrationSteps.test.ts';

/** The comma-separated items of an array or object literal body, at depth 0 (strings skipped). */
function topLevelItems(body) {
  const items = [];
  let depth = 0;
  let start = 0;
  let quote = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      items.push({ text: body.slice(start, i), offset: start });
      start = i + 1;
    }
  }
  items.push({ text: body.slice(start), offset: start });
  return items.filter((item) => item.text.trim() !== '');
}

/**
 * MIGRATION_STEPS runs one version at a time up to the current one, and
 * every step has its fixtures and the test that loads them. A step the gate
 * can't read (a computed version) fails: the order must be checkable here.
 */
function checkBoardMigrationSteps(ctx) {
  const out = [];
  const mig = ctx.read(BOARD_MIGRATIONS);
  const schema = ctx.read(BOARD_FILE_SCHEMA);
  if (mig === null) out.push(fail(BOARD_MIGRATIONS, undefined, 'file missing — re-point the check'));
  if (schema === null) out.push(fail(BOARD_FILE_SCHEMA, undefined, 'file missing — re-point the check'));
  if (mig === null || schema === null) return out;
  const currentMatch = /\bCURRENT_BOARD_FILE_VERSION\s*=\s*(\d+)\s*;/.exec(stripComments(schema));
  if (!currentMatch) return [fail(BOARD_FILE_SCHEMA, undefined, 'CURRENT_BOARD_FILE_VERSION is not a number literal — re-point the check')];
  const current = Number(currentMatch[1]);
  const code = stripCommentsKeepLines(mig);
  const decl = /\bconst\s+MIGRATION_STEPS\b[^=]*=\s*\[/.exec(code);
  if (!decl) return [fail(BOARD_MIGRATIONS, undefined, 'MIGRATION_STEPS is not an array literal — re-point the check')];
  const open = decl.index + decl[0].length - 1;
  const close = matchBrace(code, open, '[', ']');
  if (close < 0) return [fail(BOARD_MIGRATIONS, lineAt(code, open), 'MIGRATION_STEPS has no closing `]`')];

  const steps = [];
  for (const item of topLevelItems(code.slice(open + 1, close))) {
    const at = lineAt(code, open + 1 + item.offset + (item.text.length - item.text.trimStart().length));
    const m = /^\s*\{\s*from\s*:\s*(\d+)\s*,\s*to\s*:\s*(\d+)\s*,\s*migrate\b/.exec(item.text);
    if (!m) {
      out.push(fail(BOARD_MIGRATIONS, at, 'a step must read `{ from: <number>, to: <number>, migrate… }`'));
      continue;
    }
    steps.push({ from: Number(m[1]), to: Number(m[2]), line: at });
  }
  steps.forEach((step, i) => {
    if (step.to !== step.from + 1) out.push(fail(BOARD_MIGRATIONS, step.line, `step from ${step.from} goes to ${step.to}, not ${step.from + 1}`));
    const next = steps[i + 1];
    if (next && next.from !== step.to) out.push(fail(BOARD_MIGRATIONS, next.line, `step from ${next.from} doesn't follow the step to ${step.to}`));
    for (const name of [`v${step.from}.board.json`, `v${step.from}.expected.json`]) {
      if (!ctx.exists(`${BOARD_MIGRATION_FIXTURES}/${name}`)) {
        out.push(fail(BOARD_MIGRATIONS, step.line, `step from ${step.from} has no fixture ${BOARD_MIGRATION_FIXTURES}/${name}`));
      }
    }
  });
  const last = steps[steps.length - 1];
  if (last && last.to !== current) {
    out.push(fail(BOARD_MIGRATIONS, last.line, `the last step ends at ${last.to}, not at CURRENT_BOARD_FILE_VERSION (${current})`));
  }

  const test = ctx.read(BOARD_MIGRATION_FIXTURE_TEST);
  if (test === null) {
    out.push(fail(BOARD_MIGRATION_FIXTURE_TEST, undefined, 'file missing: the test that loads each step\'s fixtures'));
  } else {
    const testCode = stripComments(test);
    if (!/\bMIGRATION_STEPS\b/.test(testCode) || !testCode.includes('board-migrations')) {
      out.push(fail(BOARD_MIGRATION_FIXTURE_TEST, undefined, 'no longer loads the fixtures of every MIGRATION_STEPS entry'));
    }
    const skip = /\b(?:it|test|describe)\s*\.\s*(?:skip|todo|only|skipIf|runIf)\b|\bx(?:it|describe)\s*\(/.exec(testCode);
    if (skip) out.push(fail(BOARD_MIGRATION_FIXTURE_TEST, undefined, `\`${skip[0]}\`: the fixture checks must all run`));
  }
  return out;
}

export const checks = [
  {
    id: 'file-sizes',
    title: 'source files stay under 1000 lines of code, blank and comment-only lines aside (allowlisted files may not grow)',
    hint: 'Split the file. Only lower an allowlist ceiling, and remove the entry once the file is within the limit; raising one needs a reviewed reason.',
    run(ctx) {
      const out = [];
      const remaining = new Map(Object.entries(FILE_SIZE_ALLOWLIST));
      for (const rel of ctx.files(['src/main', 'src/renderer'], { ext: SRC_EXT })) {
        const loc = countCodeLines(ctx.read(rel), { svelte: rel.endsWith('.svelte') });
        if (remaining.has(rel)) {
          const ceiling = remaining.get(rel);
          if (loc > ceiling) out.push(fail(rel, undefined, `${loc} lines of code grew past its allowlist ceiling ${ceiling}`));
          else if (loc <= LOC_LIMIT) out.push(fail(rel, undefined, `${loc} lines of code is within the ${LOC_LIMIT} limit — remove its allowlist entry`));
          remaining.delete(rel);
        } else if (loc > LOC_LIMIT) {
          out.push(fail(rel, undefined, `${loc} lines of code exceeds the ${LOC_LIMIT} limit`));
        }
      }
      for (const rel of remaining.keys()) out.push(fail(rel, undefined, 'allowlist entry no longer exists — remove it'));
      return out;
    },
  },
  {
    id: 'no-audit-narration',
    title: 'app source carries no audit ids (Audit-N, Sprint B, Phase N / N.N, P0-N, A25-01, E.11)',
    hint: 'Say the invariant or the hazard the code guards against; audit ids and phases go in the commit message.',
    run(ctx) {
      const out = [];
      // An audit's own name, a fix sprint ("Sprint B", "Sprint 35"), a numbered
      // fix phase ("Phase 40 / 40.6"), or a finding id ("P0-12", "A25-01",
      // "F1 regression"). A plain "Phase 1" naming the steps of an algorithm is
      // not narration and stays allowed.
      const patterns = [
        /\bAudit[- ]?\d+/i,
        /\bSprint (?:[A-Z]|\d+)\b/,
        /\bPhase \d+\s*\/\s*\d+\.\d+/,
        /\bP\d-\d+\b/,
        /\bA\d{2}-\d{2}\b/,
        /\bF\d+ regression\b/,
      ];
      // In comments only (code may hold such a token for its own reasons): a
      // lettered item id ("E.11", "C5.2").
      const commentPatterns = [/\b[A-Z]\d?\.\d+\b/];
      const commentOf = (line) => {
        const t = line.trim();
        if (/^(\*|\/\*|<!--)/.test(t)) return t;
        const at = line.search(/(^|[^:])\/\//);
        return at < 0 ? '' : line.slice(at);
      };
      const dirs = ['src/main', 'src/renderer', 'src/shared'];
      const extra = ['vitest.config.mts', 'electron.vite.config.mts', 'playwright.config.ts'];
      for (const rel of [...ctx.files(dirs, { ext: [...SRC_EXT, '.css'] }), ...extra]) {
        const text = ctx.read(rel);
        if (text === null) continue;
        text.split('\n').forEach((line, i) => {
          const comment = commentOf(line);
          if (patterns.some((re) => re.test(line)) || (comment && commentPatterns.some((re) => re.test(comment)))) {
            out.push(fail(rel, i + 1, line.trim()));
          }
        });
      }
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
    id: 'board-migration-steps',
    title: 'board-format migration steps run unbroken to the current version, each with its fixtures; no double-decode',
    hint:
      'An older board is carried forward only by tested steps. Write each MIGRATION_STEPS entry as ' +
      '`{ from: N, to: N+1, migrate }` with number literals, the last ending at CURRENT_BOARD_FILE_VERSION, and add ' +
      `${BOARD_MIGRATION_FIXTURES}/vN.board.json (a file in format N) and vN.expected.json (what it loads as today); ` +
      `${BOARD_MIGRATION_FIXTURE_TEST} loads each one. A string board is an older format the version gate refuses.`,
    run(ctx) {
      const out = [];
      out.push(...checkBoardMigrationSteps(ctx));
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
    // An opaque note id beside the path is the second copy of a note's identity
    // that the path-keyed stores replaced; bringing one back re-opens the
    // "two ids, one file" divergence those stores close.
    id: 'no-content-id',
    title: 'a note is named only by its vault path: no contentId / docId anywhere in src/',
    hint:
      'Key per-note state by the case-folded vault path (vaultPath()) and follow renames with ' +
      'registerPathRenamable. Name the value notePath / filePath, never contentId or docId.',
    run(ctx) {
      const out = [];
      // Any casing, as a whole name or a camelCase part (openDocId, docIds),
      // but not a longer word that merely starts with it (docIdentity).
      const BANNED = /(?:content|doc)Ids?(?![a-z])/gi;
      for (const rel of ctx.files(['src'], { ext: ['.ts', '.mts', '.js', '.mjs', '.svelte', '.json'] })) {
        const lines = ctx.read(rel).split('\n');
        lines.forEach((line, i) => {
          for (const m of line.matchAll(BANNED)) out.push(fail(rel, i + 1, `\`${m[0]}\``));
        });
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
        // The one allowed skip: `it.skipIf(onLinux)` from harness/platform.ts, for
        // cases that time out only on the Linux CI runner (Filo targets Windows).
        if (/\b(?:it|describe|test)\.(?:skip|only|todo)\b|\bit\.skipIf\s*\((?!\s*onLinux\s*\))/.test(code)) {
          out.push(fail(rel, undefined, 'contains a skipped / focused / todo test'));
        }
        const cases = (code.match(/\bit(?:\.skipIf\s*\(\s*onLinux\s*\))?\s*\(/g) ?? []).length;
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
  {
    // A note may write `tags: project` or `tags: a, b` as text. A reader that
    // spreads `frontmatter.tags` as a list throws on it, and a writer that
    // rebuilds the list from such a read replaces the note's tags.
    id: 'tags-read-through-normaliser',
    title: "a note's `tags:` is read only through the tags normaliser (noteTags / *TagsField)",
    hint:
      'Read tags with noteTags(path) (stores/noteMeta.ts) or pass the raw value straight to a ' +
      'normalizeTagsField / orderPreservingTagsField / parseTagsField call; add or remove one with ' +
      'the tag writer (AddPathTagCommand / writeTagChangeToMarkdownPath), never a whole `tags` patch.',
    run(ctx) {
      const out = [];
      // The normaliser itself, the selectors built on it, the rewriter that
      // keeps the field's own form, the index that parses it once, and the
      // frontmatter assembler (which only drops an empty list it is writing).
      const EXEMPT = new Set([
        'src/renderer/lib/utils/normalizeTagsField.ts',
        'src/renderer/stores/noteMeta.ts',
        'src/renderer/lib/vault/tagRewriter.ts',
        'src/renderer/lib/vault/vaultIndex.ts',
        'src/renderer/lib/editor/markdownSync.ts',
      ]);
      const READ = /\b(?:frontmatter|fm)\)?\??\.tags\b|\b(?:frontmatter|fm)\)?\??\.?\[\s*['"]tags['"]\s*\]/;
      for (const rel of ctx.files(['src/renderer'], { ext: SRC_EXT })) {
        if (EXEMPT.has(rel)) continue;
        stripCommentsKeepLines(ctx.read(rel)).split('\n').forEach((line, i) => {
          if (!READ.test(line)) return;
          // Handed straight to a normaliser, or an assignment building a new note.
          if (/\b\w*TagsField\s*\(\s*(?:\w+\.)*(?:frontmatter|fm)\b/.test(line)) return;
          if (/\b(?:frontmatter|fm)\.tags\s*=(?!=)/.test(line)) return;
          out.push(fail(rel, i + 1, line.trim()));
        });
      }
      return out;
    },
  },
  {
    // An E2E spec that imports renderer modules in the page (`import('/src/…')`)
    // resolves only against a Vite dev server, never against the built app the
    // suite launches, so it fails before it tests anything; and a spec that
    // reaches into stores tests a path the user never takes.
    id: 'e2e-drives-built-app',
    title: 'E2E specs drive the built app (no `import(\'/src/…\')` in the page), named *.e2e.ts',
    hint:
      'Drive the UI through src/tests/e2e/helpers/app.ts (launchBuilt, openNoteByName, quitLikeUser …) and check ' +
      'the result on disk or on screen. Name the spec <behaviour>.e2e.ts (playwright.config.ts matches only that).',
    run(ctx) {
      const out = [];
      for (const rel of ctx.files('src/tests/e2e', { ext: ['.ts'] })) {
        const src = ctx.read(rel);
        src.split('\n').forEach((line, i) => {
          if (/import\(\s*['"`]\/src\//.test(line)) out.push(fail(rel, i + 1, line.trim()));
        });
        if (!rel.startsWith('src/tests/e2e/helpers/') && !rel.endsWith('.e2e.ts')) {
          out.push(fail(rel, undefined, 'a spec outside helpers/ must be named *.e2e.ts, or Playwright never runs it'));
        }
      }
      return out;
    },
  },
  {
    // A file dragged from Explorer that is already in the vault must be
    // linked by its path. Copying (or importing) it made a second note,
    // `Plan (1).md`, that edits then went to while the original sat unused.
    id: 'os-drops-classify-first',
    title: 'a board drop handler copies or imports a dropped file only after classifyDroppedFile',
    hint:
      'Call classifyDroppedFile(file, vaultRoot) (lib/vault/droppedFiles.ts) and link an `in-vault` file by ' +
      'its relPath; copy / import only an `OutsideDrop` (take one as the parameter of a helper that copies).',
    run(ctx) {
      const out = [];
      const HANDLERS = [
        'src/renderer/lib/canvas/dragDrop.ts',
        'src/renderer/lib/kanban/kanbanFileDropHandler.ts',
        'src/renderer/lib/tasklist/fileDropHandler.ts',
        'src/renderer/components/boards/KanbanBoard.svelte',
      ];
      for (const rel of HANDLERS) {
        const src = ctx.read(rel);
        if (src === null) { out.push(fail(rel, undefined, 'file missing — re-point the check')); continue; }
        const code = blank(rel.endsWith('.svelte') ? scriptOnly(src) : src);
        // Every function in the file: `function name(…) {…}` and `(…) => {…}`,
        // each with its signature, so a helper whose parameter is an
        // `OutsideDrop` counts as classified.
        const fns = [];
        for (const m of code.matchAll(/\bfunction\s+(\w+)/g)) {
          const body = functionBody(code.slice(m.index), m[1], { fnKeyword: true });
          if (body) fns.push({ start: m.index, end: m.index + body.end, sigEnd: m.index + body.start });
        }
        for (const m of code.matchAll(/=>\s*\{/g)) {
          const open = m.index + m[0].length - 1;
          const close = matchBrace(code, open, '{', '}');
          const lineStart = code.lastIndexOf('\n', m.index) + 1;
          if (close > 0) fns.push({ start: lineStart, end: close + 1, sigEnd: open });
        }
        for (const m of code.matchAll(/\b(?:copyFileIntoVault|createUnique)\s*\(/g)) {
          const inner = fns
            .filter((f) => f.sigEnd < m.index && m.index < f.end)
            .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
          const text = inner ? code.slice(inner.start, inner.end) : '';
          if (/\bclassifyDroppedFile\s*\(|\bOutsideDrop\b/.test(text)) continue;
          out.push(fail(rel, lineAt(src, m.index), `\`${m[0].replace(/\s*\($/, '')}\` in a function that never classifies the dropped file`));
        }
      }
      return out;
    },
  },
  {
    // Vite bundles every runtime dependency into dist/, so the package leaves
    // node_modules out (30 MB nothing loaded). For main and preload,
    // electron-vite's `externalizeDeps` keeps each `dependencies` package out
    // of the bundle as a run-time `require`, except those on its `exclude`
    // list (zod). One of those imported by main or preload would make the
    // installed app fail at start, while every test, which runs beside the
    // repo's node_modules, still passed.
    id: 'packaged-app-needs-no-node-modules',
    title: 'the package leaves node_modules out, and main / preload import no runtime dependency that would stay a require',
    hint:
      'Keep "!node_modules/**/*" in package.json build.files. For a runtime dependency main or preload needs, add it to ' +
      'externalizeDeps.exclude in electron.vite.config.mts, for main and for preload, so it is bundled in as zod is.',
    run(ctx) {
      const out = [];
      const pkg = JSON.parse(ctx.read('package.json') ?? '{}');
      if (!(pkg.build?.files ?? []).includes('!node_modules/**/*')) {
        out.push(fail('package.json', undefined, 'build.files no longer leaves node_modules out ("!node_modules/**/*")'));
      }
      const CONFIG = 'electron.vite.config.mts';
      const lists = [...stripComments(ctx.read(CONFIG) ?? '').matchAll(/externalizeDeps\s*:\s*\{\s*exclude\s*:\s*\[([^\]]*)\]/g)]
        .map((m) => new Set([...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((s) => s[1])));
      if (lists.length !== 2) {
        out.push(fail(CONFIG, undefined, `expected an externalizeDeps exclude list for main and for preload, found ${lists.length}`));
      }
      // Bundled only if both bundles take it in: a file under src/shared may reach either.
      const external = new Set(Object.keys(pkg.dependencies ?? {}).filter((name) => !lists.every((l) => l.has(name))));
      const files = ctx.files(['src/main', 'src/shared'], { ext: ['.ts', '.mts', '.mjs'] });
      for (const rel of files) {
        stripCommentsKeepLines(ctx.read(rel)).split(/\r?\n/).forEach((line, i) => {
          if (/^\s*(?:import|export)\s+type\b/.test(line)) return; // erased: no require at run time
          for (const m of line.matchAll(IMPORT_SPECIFIER)) {
            if (external.has(packageName(m[2]))) {
              out.push(fail(rel, i + 1, `imports ${m[2]}, which the build leaves a require of a node_modules package the app no longer ships`));
            }
          }
        });
      }
      if (files.length < 50) out.push(fail('src/main', undefined, `tripwire: only ${files.length} files scanned (expected >= 50)`));
      return out;
    },
  },
];

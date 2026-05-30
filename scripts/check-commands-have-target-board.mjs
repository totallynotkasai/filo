/**
 * Phase 2 CI gate — Command.targetBoardId coverage (ERROR mode).
 *
 * Every class extending `Command` (defined under `src/renderer/commands/`)
 * MUST declare `readonly targetBoardId: string` and assign it in the
 * constructor. Per IMPLEMENTATION_PLAN_2026-05-27 §Phase 2, this contract
 * is mandatory; the field guards `historyStore.undo/redo` against a
 * cross-board undo silently mutating the wrong target.
 *
 * Phase 0 of the plan shipped this gate in warn-only mode so Phase 2 could
 * land the conversion incrementally. With Phase 2 complete (every Command
 * subclass now declares + assigns the field), the gate has flipped to
 * error mode — any new Command that omits the field fails CI.
 *
 * Escape hatch: append `// allow-no-target-board:` with a reason on the
 * class declaration line — for legitimately board-agnostic ops. Existing
 * board-agnostic commands (CascadeDeleteCommand, ReplaceAllCommand)
 * assign `''` in their constructors instead so the dispatcher's truthy
 * guard skips them; the annotation is reserved for future cases where
 * even the field would be misleading.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const COMMANDS_DIR = join(ROOT, 'src/renderer/commands');
const WARN_ONLY = false;

// ── Scanner ────────────────────────────────────────────────────────────

function toPosix(p) {
  return p.split(sep).join('/');
}

function listTsFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      // Subdirectories of commands/ are uncommon today, but recurse to
      // survive a future split.
      out.push(...listTsFiles(full));
    } else if (s.isFile() && entry.endsWith('.ts') && entry !== 'Command.ts' && entry !== 'index.ts') {
      out.push(full);
    }
  }
  return out;
}

/**
 * Find the class body bounded by balanced braces starting from `startIdx`
 * (which should point at the `export class X extends Command` line).
 */
function extractClassBody(text, startIdx) {
  const braceStart = text.indexOf('{', startIdx);
  if (braceStart < 0) return '';
  let depth = 0;
  for (let i = braceStart; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(braceStart, i + 1);
    }
  }
  return text.slice(braceStart);
}

const violations = [];
const scanned = [];

for (const file of listTsFiles(COMMANDS_DIR)) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  // Regex captures the line containing the class declaration. `\b` anchors
  // help `MyCommand` not match `MyNestedCommandTracker` etc.
  const classRe = /export\s+class\s+(\w+)\s+extends\s+Command\b/g;
  for (const match of text.matchAll(classRe)) {
    const className = match[1];
    const classStart = match.index ?? 0;
    // Locate the 1-based line number for the declaration.
    const linesBefore = text.slice(0, classStart).split('\n');
    const declLine = linesBefore.length;
    // Escape-hatch annotation — same line OR the previous line.
    const annotationWindow = [lines[declLine - 1] ?? '', lines[declLine - 2] ?? ''].join('\n');
    if (annotationWindow.includes('allow-no-target-board:')) continue;

    const body = extractClassBody(text, classStart);
    const declaresField = /readonly\s+targetBoardId\s*:\s*string/.test(body);
    const assignsField = /this\.targetBoardId\s*=/.test(body);
    scanned.push({ className, file: toPosix(relative(ROOT, file)), declLine, declaresField, assignsField });
    if (!declaresField || !assignsField) {
      violations.push({
        className,
        file: toPosix(relative(ROOT, file)),
        line: declLine,
        declaresField,
        assignsField,
      });
    }
  }
}

// ── Report ─────────────────────────────────────────────────────────────

if (violations.length === 0) {
  process.stdout.write(
    `[check-commands-have-target-board] OK — scanned ${scanned.length} command class(es), 0 missing targetBoardId.\n`,
  );
  process.exit(0);
}

const stream = WARN_ONLY ? process.stdout : process.stderr;
const label = WARN_ONLY ? 'WARN' : 'FAIL';
stream.write(
  `[check-commands-have-target-board] ${label} — ${violations.length}/${scanned.length} command class(es) missing targetBoardId:\n`,
);
for (const v of violations) {
  const missing = [];
  if (!v.declaresField) missing.push('declaration');
  if (!v.assignsField) missing.push('constructor assignment');
  stream.write(`  ${v.file}:${v.line} ${v.className} (missing: ${missing.join(' + ')})\n`);
}
stream.write(
  '\nA Command class should declare `readonly targetBoardId: string` and assign it in\n' +
    'the constructor (typically `this.targetBoardId = boardId ?? boardStore.current?.id ?? \'\';`).\n' +
    'The historyStore undo/redo dispatcher uses the field to refuse running a command\n' +
    'against a different board than the one it was constructed on (see\n' +
    'src/renderer/stores/history.svelte.ts:353-360). Without it, switching boards\n' +
    'mid-undo silently mutates the wrong target.\n' +
    'Escape hatch: append `// allow-no-target-board: <reason>` to the class declaration line\n' +
    '(use sparingly — board-agnostic Command instances are rare).\n',
);

if (WARN_ONLY) {
  process.stdout.write(
    `\n[check-commands-have-target-board] WARN-ONLY — exit 0.\n`,
  );
  process.exit(0);
}
process.exit(1);

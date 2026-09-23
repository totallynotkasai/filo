/**
 * Command execute/undo ROUND-TRIP coverage gate (Audit-6 Phase 5.5).
 *
 * H1 (`ReorderSectionCommand`) silently no-op'd: a multi-slot section drag
 * changed 3+ positions, but the adjacent-swap delta encoding only filled
 * `idA/idB` for EXACTLY two — so execute()/undo() both early-returned and the
 * move neither applied nor undid. It shipped because no test drove a degenerate
 * delta through execute → undo.
 *
 * The class-closing guard: every concrete `Command` subclass must be exercised
 * by an execute/undo ROUND-TRIP test (construct it, run execute, run undo) — or
 * be an explicitly documented exemption. A delta command that can degenerate
 * then cannot ship without a test that would catch the no-op.
 *
 * "Round-trip covered" = some test under `src/tests/` constructs `new <Class>(`
 * AND, within a bounded forward window of that construction, contains BOTH
 * `.execute(` AND `.undo(` (direct calls or via `historyStore.execute(...)` /
 * `historyStore.undo()`, both of which contain those substrings).
 *
 * Audit-8 L5 — the window (`ROUNDTRIP_WINDOW` chars after `new <Class>(`)
 * replaces the prior FILE-level scan, which marked a command "covered" if the
 * file contained the three substrings ANYWHERE — so a command merely
 * CONSTRUCTED as a fixture in a file that round-trips OTHER commands passed for
 * free. The window keeps the zero-config, no-AST simplicity while requiring the
 * execute+undo to actually sit next to the construction: a real round-trip
 * (construct → execute → assert → undo) spans a few hundred chars, while a
 * far-flung fixture construction no longer counts. Forward-only because you
 * can't execute before you construct. Precise call-site/data-flow scoping is
 * the same hard problem L26 documents for `ci:md-writers-reconcile-editors`;
 * the window is the pragmatic middle ground.
 *
 * EXEMPT commands are either FULL before/after SNAPSHOT commands (store
 * before+after, apply `after` on execute and `before` on undo) and INVERSE-OP
 * pairs (execute does X, undo does the inverse) — both structurally immune to
 * the delta-degeneracy no-op — or are round-trip-driven through a non-`.execute(`
 * path. Each carries the reason. A NEW command must get a round-trip test or a
 * justified exemption here; that is the invariant this gate enforces.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const COMMANDS_DIR = join(ROOT, 'src/renderer/commands');
const TESTS_DIR = join(ROOT, 'src/tests');

/**
 * Commands that do NOT need a dedicated round-trip test, each with the reason
 * it cannot exhibit the H1 silent-no-op (delta-degeneracy) class. Keep honest:
 * a delta/move command that re-derives state against the live cache does NOT
 * belong here — give it a round-trip test instead.
 */
const ROUNDTRIP_EXEMPT = new Map([
  // Deterministic add/remove via the boardStore facade — execute adds the tile,
  // undo removes it by id. No computed delta to degenerate. (The inverse,
  // DeleteTilesCommand, is round-trip tested.)
  ['AddTileCommand', 'deterministic add/remove (execute adds, undo removes by id) — no delta'],
  ['AddTilesCommand', 'deterministic multi add/remove — same shape as AddTileCommand'],
  // Full before/after value snapshots applied via updateTile — execute writes
  // `after`, undo writes `before`. Cannot silently no-op.
  ['ResizeTileCommand', 'full before/after {width,height} snapshot via updateTile'],
  ['UpdateTileStyleCommand', 'full before/after style snapshot via updateTile'],
  ['UpdateImageAltCommand', 'full before/after alt-text snapshot via updateTile'],
  ['UpdateTimerConfigCommand', 'full before/after timer-config snapshot via updateTile'],
  // Full before/after position-map snapshots (Map<id,{before,after}>) applied
  // via batchUpdateTiles — every tile's prior + next position is captured.
  ['AlignTilesCommand', 'full before/after position-map snapshot via batchUpdateTiles'],
  ['LayoutTilesCommand', 'full before/after position-map snapshot via batchUpdateTiles'],
  // Inverse-op / full-snapshot tag commands dispatched by fileTagsStore.
  ['ToggleTagFadeCommand', 'full previousStates snapshot (Map<id,boolean>) via batchUpdateTiles'],
  ['AddPathTagCommand', 'inverse-op pair on a path (execute add, undo remove) — no delta'],
  ['RemovePathTagCommand', 'inverse-op pair on a path (execute remove, undo add) — no delta'],
  // Async vault-wide write; its round-trip is driven through historyStore (no
  // literal `cmd.execute()`), so the file-level matcher can't see it.
  ['ReplaceAllCommand', 'round-trip driven via historyStore.undo() in replaceAllCommand.test.ts'],
]);

/** Discover every concrete `export class X extends Command` under commands/. */
function discoverCommandClasses() {
  const out = [];
  for (const entry of readdirSync(COMMANDS_DIR)) {
    if (!entry.endsWith('.ts')) continue;
    if (entry === 'Command.ts' || entry === 'index.ts') continue;
    const text = readFileSync(join(COMMANDS_DIR, entry), 'utf8');
    const re = /export\s+class\s+(\w+)\s+extends\s+Command\b/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      out.push({ name: m[1], file: `src/renderer/commands/${entry}` });
    }
  }
  return out;
}

/** Read every `.ts` test file's text once. */
function readTestTexts() {
  const texts = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      const full = join(dir, e);
      const s = statSync(full);
      if (s.isDirectory()) walk(full);
      else if (e.endsWith('.ts')) texts.push(readFileSync(full, 'utf8'));
    }
  };
  walk(TESTS_DIR);
  return texts;
}

const classes = discoverCommandClasses();
const testTexts = readTestTexts();

// Sanity: the discovery must actually find the command surface (guards against
// a refactor that moves command classes out from under the glob).
if (classes.length < 30) {
  console.error(
    `check-command-roundtrip-coverage: only discovered ${classes.length} command classes ` +
      `(expected >= 30). The discovery glob is probably stale — update it.`,
  );
  process.exit(1);
}

/**
 * Audit-8 L5 — chars after a `new <Class>(` within which the round-trip's
 * `.execute(` + `.undo(` must appear. A real construct → execute → assert →
 * undo spans a few hundred chars; 1500 leaves generous headroom (e.g. the
 * MoveCardsCommand neighbour-anchor test interleaves an intervening mutation
 * between execute and undo) without spanning into an unrelated later test.
 */
const ROUNDTRIP_WINDOW = 1500;
const EXEC_RE = /\.execute\s*\(/;
const UNDO_RE = /\.undo\s*\(/;

function isRoundTripped(name) {
  const ctorRe = new RegExp(`\\bnew\\s+${name}\\s*\\(`, 'g');
  for (const text of testTexts) {
    ctorRe.lastIndex = 0;
    let m;
    while ((m = ctorRe.exec(text)) !== null) {
      // Forward window from the construction — execute/undo always follow it.
      const windowText = text.slice(m.index, m.index + ROUNDTRIP_WINDOW);
      if (EXEC_RE.test(windowText) && UNDO_RE.test(windowText)) return true;
      // A zero-width match can't happen here (the pattern ends in `(`), but
      // guard lastIndex against the construct sitting at EOF anyway.
      if (m.index === ctorRe.lastIndex) ctorRe.lastIndex++;
    }
  }
  return false;
}

const uncovered = [];
const staleExemptions = [];
for (const { name, file } of classes) {
  const covered = isRoundTripped(name);
  const exempt = ROUNDTRIP_EXEMPT.has(name);
  if (!covered && !exempt) uncovered.push({ name, file });
  if (covered && exempt) staleExemptions.push(name);
}

// Typo guard: every exemption must name a real, discovered command class.
const knownNames = new Set(classes.map((c) => c.name));
const unknownExemptions = [...ROUNDTRIP_EXEMPT.keys()].filter((n) => !knownNames.has(n));
if (unknownExemptions.length > 0) {
  console.error('check-command-roundtrip-coverage: ROUNDTRIP_EXEMPT names an unknown command:');
  for (const n of unknownExemptions) console.error(`  ${n}`);
  console.error('Remove the stale entry or fix the typo.');
  process.exit(1);
}

if (uncovered.length > 0) {
  console.error('Command(s) with NO execute/undo round-trip test and no documented exemption:');
  for (const { name, file } of uncovered) console.error(`  ${name}  (${relative(ROOT, join(ROOT, file)).replaceAll(sep, '/')})`);
  console.error('');
  console.error('H1 shipped a silent no-op (a degenerate delta) because no test drove the');
  console.error('command through execute → undo. Add a round-trip test that constructs the');
  console.error('command, runs execute(), asserts the state changed, runs undo(), and asserts');
  console.error('it reverted (see kanbanStructureCommandsRoundTrip / sectionCommandsDelta).');
  console.error('');
  console.error('If the command is a FULL before/after snapshot or an inverse-op pair (it cannot');
  console.error('silently no-op via a degenerate delta), add it to ROUNDTRIP_EXEMPT with a reason.');
  process.exit(1);
}

// Non-fatal hygiene note: an exemption that is now actually round-tripped can be
// dropped. Surfaced but not failed so adding a test never breaks CI.
if (staleExemptions.length > 0) {
  console.log(
    `check-command-roundtrip-coverage: note — ${staleExemptions.length} exempt command(s) now ` +
      `have a round-trip test and can be removed from ROUNDTRIP_EXEMPT: ${staleExemptions.join(', ')}`,
  );
}

console.log(
  `check-command-roundtrip-coverage: OK — ${classes.length} commands, ` +
    `${classes.length - ROUNDTRIP_EXEMPT.size} round-tripped, ${ROUNDTRIP_EXEMPT.size} exempt.`,
);

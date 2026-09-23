/**
 * IPC channel parity (Phase 7 regression-prevention gate).
 *
 * The renderer relies on the `IpcChannel` union in `src/shared/types.ts`
 * for autocomplete + compile-time channel-name validation. If a channel is
 * registered in main but missing from the union (or vice-versa), the
 * renderer either loses autocomplete or calls a dead channel. This script
 * asserts symmetric parity.
 *
 * Channel-registration patterns scanned in `src/main/**`:
 *   - `ipcMain.handle('name', ...)`  — request/response (renderer → main with reply)
 *   - `ipcMain.on('name', ...)`      — fire-and-forget (renderer → main)
 *   - `ipcMain.once('name', ...)`    — fire-and-forget once (renderer → main)
 *
 * Union entries that are NEVER registered are assumed to be main→renderer
 * events (sent via `webContents.send`). Those are allowlisted via
 * MAIN_TO_RENDERER_EVENTS — kept explicit so accidental missing
 * registrations still fire the gate.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const MAIN_DIR = join(ROOT, 'src/main');
const TYPES_FILE = join(ROOT, 'src/shared/types.ts');

/**
 * Union literals that are intentionally main → renderer events.
 * They are sent via `webContents.send(channel, ...)` from the main process
 * and the renderer subscribes through the preload bridge — there is no
 * `ipcMain.handle/on/once` on the main side.
 */
const MAIN_TO_RENDERER_EVENTS = new Set([
  'vault:files-changed',
  'vault:tree-updated',
  'vault:file-renamed',
  'vault:watcher-failed',
  // Phase 3 / 3.1 — watcher supervisor publishes its current state so the
  // renderer can show a "reconnecting" banner during transient errors.
  'vault:watcher-state',
  'vault:tree-too-large',
  // Audit-19 ERR-3 / EXT-2 — sync-client conflict copy notices.
  'vault:sync-conflict',
  'app:flush-and-quit',
]);

function toPosix(p) {
  return p.split(sep).join('/');
}

function walkTs(dir, out) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) walkTs(full, out);
    else if (s.isFile() && entry.endsWith('.ts')) out.push(full);
  }
}

const REG_RE = /ipcMain\.(?:handle|on|once)\(\s*['"]([^'"]+)['"]/g;

const tsFiles = [];
walkTs(MAIN_DIR, tsFiles);

const registered = new Map();
for (const abs of tsFiles) {
  const rel = toPosix(relative(ROOT, abs));
  const text = readFileSync(abs, 'utf8');
  for (const m of text.matchAll(REG_RE)) {
    const name = m[1];
    if (!registered.has(name)) registered.set(name, []);
    registered.get(name).push(rel);
  }
}

const unionText = readFileSync(TYPES_FILE, 'utf8');
const unionMatch = unionText.match(/export\s+type\s+IpcChannel\s*=([\s\S]*?);/);
if (!unionMatch) {
  console.error(`[check-ipc-parity] FAILED — could not locate IpcChannel union in ${toPosix(relative(ROOT, TYPES_FILE))}.`);
  process.exit(1);
}
const unionLiterals = new Set();
for (const m of unionMatch[1].matchAll(/['"]([^'"]+)['"]/g)) {
  unionLiterals.add(m[1]);
}

const handlerSet = new Set(registered.keys());

// Audit-14 7.8 — latent-fragility guard. REG_RE matches only string-LITERAL
// channel names (`ipcMain.handle('vault:read', …)`). That is sound today (all
// registrations are literals), but a future refactor to a constant or computed
// channel (`ipcMain.handle(CHANNELS.vaultRead, …)`) would make every channel
// invisible to this scan, silently collapsing `handlerSet` toward empty and
// turning the whole parity gate into a no-op that "passes". Pin the literal-
// registration count non-trivially above zero so that collapse fails loud
// instead of silently voiding the gate. 49 today; floor well below that, far
// above 0 — a legitimate channel removal won't trip it, a scan-blinding
// refactor will.
const MIN_LITERAL_REGISTRATIONS = 30;

const handlersMissingFromUnion = [...handlerSet].filter((c) => !unionLiterals.has(c)).sort();
const unionUnregisteredAndNotAllowlisted = [...unionLiterals]
  .filter((c) => !handlerSet.has(c) && !MAIN_TO_RENDERER_EVENTS.has(c))
  .sort();
const staleAllowlist = [...MAIN_TO_RENDERER_EVENTS].filter((c) => !unionLiterals.has(c)).sort();

let ok = true;

if (handlersMissingFromUnion.length > 0) {
  ok = false;
  console.error('[check-ipc-parity] FAILED — channels registered in main but missing from IpcChannel union:');
  for (const c of handlersMissingFromUnion) {
    const locs = registered.get(c).join(', ');
    console.error(`  '${c}' — registered in: ${locs}`);
  }
  console.error('\nFix: add the channel literal to the IpcChannel union in src/shared/types.ts.');
}

if (unionUnregisteredAndNotAllowlisted.length > 0) {
  ok = false;
  console.error(
    '\n[check-ipc-parity] FAILED — IpcChannel union entries with no `ipcMain.handle/on/once` registration\nand not in MAIN_TO_RENDERER_EVENTS:',
  );
  for (const c of unionUnregisteredAndNotAllowlisted) console.error(`  '${c}'`);
  console.error(
    '\nFix: either register the channel in src/main/ipc/ (or src/main/), remove the literal from\n' +
      'the union, or — if this really is a main→renderer event sent via webContents.send — add it\n' +
      'to MAIN_TO_RENDERER_EVENTS in scripts/check-ipc-parity.mjs.',
  );
}

if (staleAllowlist.length > 0) {
  ok = false;
  console.error(
    '\n[check-ipc-parity] FAILED — MAIN_TO_RENDERER_EVENTS contains channels not declared in the IpcChannel union:',
  );
  for (const c of staleAllowlist) console.error(`  '${c}'`);
  console.error('\nFix: remove these from MAIN_TO_RENDERER_EVENTS in scripts/check-ipc-parity.mjs.');
}

if (handlerSet.size < MIN_LITERAL_REGISTRATIONS) {
  ok = false;
  console.error(
    `\n[check-ipc-parity] FAILED — found only ${handlerSet.size} string-literal ipcMain registration(s) ` +
      `(expected ≥ ${MIN_LITERAL_REGISTRATIONS}).`,
  );
  console.error(
    'This scan matches only literal channel names; a refactor to a constant/computed channel\n' +
      '(e.g. `ipcMain.handle(CHANNELS.x, …)`) would make channels invisible and silently void this\n' +
      'gate. Either keep ipcMain registrations as string literals, or extend REG_RE to resolve the\n' +
      'constant form AND re-baseline MIN_LITERAL_REGISTRATIONS in scripts/check-ipc-parity.mjs.',
  );
}

if (!ok) process.exit(1);

const r2mCount = handlerSet.size;
const m2rCount = MAIN_TO_RENDERER_EVENTS.size;
console.log(
  `[check-ipc-parity] OK — ${r2mCount} renderer→main handlers, ${m2rCount} main→renderer events, ${unionLiterals.size} union entries; all match.`,
);
process.exit(0);
